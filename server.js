import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RpcClient } from './src/contexts/ingestion/infrastructure/rpc-client.js';
import { CloudwalkerGateway } from './src/contexts/ingestion/infrastructure/gateway.js';
import { eventTypes, parseInstant } from './src/shared/vocabulary.js';
import { createAgentToolboxFromEnv, TriageEvidenceToolbox } from './src/contexts/triage/infrastructure/evidence-toolbox.js';
import { ApiEvidenceToolbox } from './src/contexts/triage/infrastructure/api-toolbox.js';
import { applyModelValues, createModelRolesFromEnv, modelRoleSummary, modelRoleValues, MODEL_ROLES } from './src/contexts/triage/infrastructure/model-client.js';
import { InvestigationAgent, replayInvestigation } from './src/contexts/triage/application/investigation-agent.js';
import { InvestigationStore } from './src/contexts/triage/infrastructure/investigation-store.js';
import { PromptStore } from './src/contexts/knowledge/infrastructure/prompt-store.js';
import { TriageMonitor } from './src/contexts/triage/application/triage-monitor.js';
import { log, logFileOptions, pruneLogFiles, readLogEntries, queryLevels, traceModelCall, useLogFile } from './src/shared/logging/log.js';
import { parseSyslog } from './src/contexts/ingestion/application/parsing.js';
import { SyslogReceiver } from './src/interfaces/udp/syslog/receiver.js';
import { eventTypeFor } from './src/contexts/ingestion/application/parsing.js';
import { WikiStore } from './src/contexts/knowledge/infrastructure/wiki-store.js';
import { WikiWorkbench } from './src/contexts/maintenance/application/wiki-workbench.js';
import { TraceBoardService } from './src/contexts/trace/application/trace-service.js';
import { BoardStore } from './src/contexts/trace/infrastructure/board-store.js';
import { UpdateStore } from './src/contexts/dataops/infrastructure/update-store.js';
import { TriageRuleEngine, validateRuleSet } from './src/contexts/knowledge/infrastructure/triage-rules.js';
import { reasonForRecord, scrubCredentials } from './src/shared/redaction.js';
import { RuleSessionStore, RuleStore, isRuleId } from './src/contexts/knowledge/infrastructure/rule-store.js';
import { FalsePositiveMaintainer, FP_LIBRARIES, FpSessionStore, fpSessionDirectory,
  maintenanceSide, maintenanceSides, wikiFeedbackTarget } from './src/contexts/maintenance/application/fp-maintainer.js';
import { createConfigStore, dataRoot } from './src/contexts/dataops/infrastructure/config-store.js';
import { writeJson as json, callerError, configError, upstreamError, causeError, failureClasses,
  failureKindOf, failureStatusOf, sendUnauthorized, sendCloudwalkerStatusFailure, sseErrorFrame } from './src/shared/errors.js';
import { runWithRequestContext, currentRequestContext } from './src/shared/logging/log.js';
import { AuditStore } from './src/contexts/audit/infrastructure/audit-store.js';
import { createAuditor, actorOf, configAuditValues } from './src/contexts/audit/application/audit-service.js';
import { VERDICT_KEYS, TRIAGE_STATUSES, VERDICT_LABELS } from './src/contexts/triage/domain/triage-case.js';
import { CASE_FILE_WHITELIST, CASE_FILE_CONTENT_TYPES } from './src/contexts/triage/application/correlate.js';
import { levelNames } from './src/shared/vocabulary.js';

const runtime = runtimePaths(); // 根＝数据根（HIDS_DATA_DIR 或 ~/.local/share/hids-ai-console），清单与旧目录说明见文件末尾 runtimePaths()
// 日志落盘（P003-T045）：配了 HIDS_LOG_FILE 才在 stdout 之外再同份写文件，不配维持 stdout-only。
// **必须在 createConfigStore 之前装**：覆盖层读不出来时它会落 config.load_failed。
const logOptions = logFileOptions();
if (logOptions) useLogFile(logOptions);
// 可写配置的覆盖层（P003-T029）：**必须在下面这批模块级装配之前建**——它把改过的键盖进 process.env，
// 装配才看得到；「重启进程后改过的值仍生效」全靠这一行。没改过的键继续读环境变量。
const configStore = createConfigStore({ file: path.join(runtime.data, 'config-overrides.json') });
const host = process.env.HIDS_HOST || '127.0.0.1';
const port = Number(process.env.HIDS_PORT || 8080);
const baseUrl = process.env.CLOUDWALKER_URL;
const token = process.env.CLOUDWALKER_API_TOKEN;
const gateway = baseUrl && token ? new CloudwalkerGateway(new RpcClient(baseUrl, token)) : null;
const apiToolbox = gateway ? new ApiEvidenceToolbox(gateway.rpc) : null;
const agentToolbox = createAgentToolboxFromEnv();
const triageToolbox = apiToolbox && agentToolbox ? new TriageEvidenceToolbox(apiToolbox, agentToolbox) : apiToolbox;
// 模型分层（P003-T042）：五个角色各一个实例（研判 / 独立复核 / 规则维护者 / wiki 维护者 / 溯源白板）。
// 不设新键时逐键回退主判三项，四个角色 resolved 到的就是 `LLM_*`——行为与分层前一致。
const models = createModelRolesFromEnv();
const model = models?.triage ?? null; // 研判实例；既有引用（agent / status 路由）照旧读它
const promptStore = new PromptStore();
// 判据库（P003-T041）：缺省库＝数据根下的 `wiki/`，仓内 `wiki/` 只当种子源，首次读时初始化一次。
const wikiStore = new WikiStore();
// Rego 规则库（P003-T041 A1）：同样住数据根下的 `rules/`，仓内 `rules/` 只当种子源。
// 研判 Agent 与维护者**共用这一个实例**：维护者改了规则，下一次研判读到的就是改过的那份。
const regoRuleStore = new RuleStore();
const defaultRuleSessions = new RuleSessionStore();
// 误报统一维护 Agent（P003-T047）：一份多轮会话操控两本库，会话落数据根下的 `fp-sessions/`。
// 决策模型复用规则维护者那一格（不新增配置键）；没配就退化为「按请求的库逐个尝试」，决策来源记在会话里。
const defaultFpSessions = new FpSessionStore(runtime.fpSessions);
const fpDecisionModel = models?.rule_maintainer ?? null;
const agent = triageToolbox && models
  ? new InvestigationAgent(triageToolbox, models.triage, promptStore, wikiStore, regoRuleStore, models.review) : null;
const deepInvestigator = agentToolbox && models
  ? new InvestigationAgent(agentToolbox, models.triage, promptStore, wikiStore, regoRuleStore, models.review) : null;
const investigationStore = new InvestigationStore(runtime.investigations);
const triageRuleEngine = new TriageRuleEngine(runtime.triageRules);
const triageInputMode = triageInputModeOf();
const triageMonitor = gateway && agent ? new TriageMonitor({ service: gateway, investigator: agent,
  history: investigationStore, file: runtime.triageMonitor,
  inputMode: triageInputMode,
  eventToolbox: apiToolbox, wiki: wikiStore,
  // 研判背景不走注入（P003-T043 A1）：环境基线在判据库（`wiki/common/GEN-13.md`），白名单硬判定归规则层。
  ruleEngine: triageRuleEngine,
  casesDirectory: process.env.HIDS_CASES_DIR || runtime.cases }) : null;
const wikiWorkbench = new WikiWorkbench(wikiStore, models?.wiki_maintainer ?? null, promptStore, runtime.wikiSessions);

// 写配置之后的生效（P003-T029 A1）：活着的客户端对象**原地换值**，后续调用立刻走新地址与新凭据。
// 不重建对象：createServer 的 service / toolbox / investigator / monitor 都是值捕获，重建等于换了一批引用，
// 路由手里的还是旧对象。持有这些引用的下游（apiToolbox、triageToolbox、两个 InvestigationAgent、
// wikiWorkbench、triageMonitor.service）是同一批对象，跟着一起变。targets 可注入：单测传假对象验映射。
// P003-T042：传 models（五个角色）时按新值**重新解析**逐角色原地换值——回退主判的角色（source=primary/mixed）
// 会跟着主判三项一起动，否则「写配置只改了研判，两个维护者与白板还拿旧地址」。旧 `model` 单目标分支保留。
export function applyLiveConfig(targets, values) {
  const { gateway, model: chatModel, agentToolbox, models } = targets || {};
  if (gateway?.rpc && values.CLOUDWALKER_URL && values.CLOUDWALKER_API_TOKEN) {
    gateway.rpc.baseUrl = new URL(values.CLOUDWALKER_URL);
    gateway.rpc.token = values.CLOUDWALKER_API_TOKEN;
  }
  const mcp = agentToolbox?.client;
  if (mcp && values.CLOUDWALKER_URL && values.CLOUDWALKER_API_TOKEN) {
    mcp.url = new URL('/api/mcp', values.CLOUDWALKER_URL);
    mcp.token = values.CLOUDWALKER_API_TOKEN;
    mcp.initialized = false; // 换了服务端：MCP 会话要重新 initialize，旧会话 id 不能接着用
  }
  if (models) {
    const resolved = modelRoleValues(values);
    for (const role of MODEL_ROLES) applyModelValues(models[role], resolved[role]);
  } else {
    applyModelValues(chatModel, { baseUrl: values.LLM_BASE_URL, apiKey: values.LLM_API_KEY, model: values.LLM_MODEL });
  }
  return targets;
}

// A4：告警分析已经取到的原始报文写在案卷（cases/<...>/01-原始告警.txt）里，研判记录（InvestigationStore）带 case_dir。
// TriageMonitor.status() 对外是瘦身记录（triage-monitor.js 剥掉 input），这里不读它的 input，只按研判记录顺案卷取原始报文。
async function caseParsed(caseInfo) {
  if (!caseInfo?.case_dir) return null;
  try { return parseSyslog(await readFile(path.join(caseInfo.case_dir, '01-原始告警.txt'), 'utf8')); }
  catch { return null; }
}

// 溯源复用告警分析证据的取数器。monitor / history 都从 createServer 的注入点传进来，测试能用真接线。
export function createAnalysisProvider({ monitor = null, history = null } = {}) {
  const latest = async alertId => {
    if (!alertId) return null;
    for (const mode of ['triage', 'deep']) {
      try { const saved = await history?.latest(alertId, mode); if (saved) return saved; }
      catch { /* 读不到就当没有，下面回退到案卷 */ }
    }
    return null;
  };
  return async alertId => {
    const visible = monitor?.status(alertId);
    // syslog 匹配到牧云事件时，研判记录挂在事件 ID（result_alert_id）上；先按告警 ID 找，再按它找。
    const saved = await latest(alertId) || await latest(visible?.result_alert_id);
    // 案卷优先从研判记录取；分析还在跑（尚未落研判记录）时，用 status() 里公开的 case_dir 定位，同样不碰 input。
    const parsed = await caseParsed(saved) || await caseParsed(visible);
    const type = parsed ? eventTypeFor(parsed.msgid) : null;
    if (!type) return null;
    const payload = parsed.payload || {};
    const hostIp = String(payload.host_ip || '').replace(/\/32$/, '');
    if (!hostIp) return null;
    const evidenceId = (saved?.evidence || []).find(item => item.tool === 'received_syslog')?.evidence_id || 'syslog:1';
    return { evidence_id: evidenceId, tool: 'received_syslog', type, facts: {
      host_ip: hostIp, host_name: payload.host_name || null,
      source_ip: payload.source_ip || payload.login_ip || null,
      destination_ip: payload.target_ip || payload.destination_ip || null,
      occurred_at: parseInstant(payload.event_create_time ?? parsed.ts),
      title: payload.event_name || eventTypes[type], event_id: payload.event_id ?? null } };
  };
}

const traceBoard = agentToolbox && models ? new TraceBoardService({ toolbox: agentToolbox, model: models.trace_board, promptStore,
  store: new BoardStore(runtime.traceBoards),
  analysis: createAnalysisProvider({ monitor: triageMonitor, history: investigationStore }) }) : null;

// ── 误报维护（P003-T013）──────────────────────────────────────────────────
// 值守分析员登记误报时，结论先落盘（前面那个路由里就写 record.verdict），两个维护者在后台各自跑：
// 规则维护者改 Rego（只动一条规则），wiki 维护者改方法论页（走 publishBundle 的发布前检查）。
// 维护失败只写进 maintenance，不碰 verdict——结论不会因为维护失败被改回去。
// 两个维护者都不是跑研判的那个 InvestigationAgent：一个用 rule-maintenance 提示词，一个用 WikiWorkbench。

// 维护状态词表：更新中 / 已更新 / 失败（总态与单边态同一套）。
function maintenanceState(parts) {
  if (parts.some(part => part.status === 'updating')) return 'updating';
  return parts.some(part => part.status === 'failed') ? 'failed' : 'updated';
}

function ruleProposal(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let output;
  try { output = JSON.parse(raw); } catch { throw new Error('规则维护模型没有返回 JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('规则维护模型没有返回 JSON 对象');
  return output;
}

// 一份规则正文里的条件行（`match if { }` 体内，按出现顺序）。
// **这里不校验语法**：候选正文先过 `validateRego`、原规则由装载器读进来，两边都是规则子集内的合法正文，
// 抽取只为比对。认不出的行留着 `raw` 原文，比对时按「无法证明没放宽」处理（见 `atLeastAsStrict`）。
function ruleExpressions(rego) {
  const expressions = [];
  let inside = false;
  for (const line of String(rego).split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (!inside) {
      if (/^match\s*(?:if\s*)?\{\s*$/.test(text)) inside = true;
      continue;
    }
    if (text === '}') { inside = false; continue; }
    let rest = text;
    const negated = /^not\s+/.test(rest);
    if (negated) rest = rest.replace(/^not\s+/, '');
    const call = rest.match(/^(contains|startswith|endswith)\s*\(\s*input\.([a-z][a-z0-9_]*)\s*,\s*(.+?)\s*\)$/);
    const compare = call ? null : rest.match(/^input\.([a-z][a-z0-9_]*)\s*(==|!=)\s*(.+)$/);
    if (call) expressions.push({ text, negated, kind: 'call', op: call[1], field: call[2], raw: call[3], value: stringLiteral(call[3]) });
    else if (compare) expressions.push({ text, negated, kind: 'compare', op: compare[2], field: compare[1], raw: compare[3], value: stringLiteral(compare[3]) });
    else expressions.push({ text, negated, kind: 'opaque', op: null, field: null, raw: null, value: null });
  }
  return expressions;
}

// 字面量里只有字符串能做「包含/前缀/后缀」比较；其它类型（数字、true / false / null）只认同值。
function stringLiteral(raw) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// 「被限定的那组事实，新的是旧的子集」——相同 kind / op 下逐个比：
// startswith 新值以旧值打头（`/tmp/` → `/tmp/webshell` 更严）、endswith 新值以旧值结尾（`.jsp` → `shell.jsp` 更严）、
// contains 新值含旧值（`tmp` → `tmp/shell` 更严）、`==` / `!=` 必须同值。跨 op / 跨类型一律判「不算更严」。
function innerAtLeastAsStrict(previous, next) {
  if (previous.kind === 'opaque' || next.kind === 'opaque') return previous.text === next.text;
  if (previous.kind !== next.kind || previous.op !== next.op) return false;
  if (previous.value === null || next.value === null) return previous.raw === next.raw;
  if (previous.kind === 'compare') return previous.value === next.value;
  if (previous.op === 'startswith') return next.value.startsWith(previous.value);
  if (previous.op === 'endswith') return next.value.endsWith(previous.value);
  return next.value.includes(previous.value);
}

// 新条件是否至少和旧条件一样严。取反要翻方向：`not A` 比 `not B` 更严 ⇔ A 比 B 更宽。
function atLeastAsStrict(previous, next) {
  if (!next || previous.field !== next.field || previous.negated !== next.negated) return false;
  return previous.negated ? innerAtLeastAsStrict(next, previous) : innerAtLeastAsStrict(previous, next);
}

// A1（P003-T020）：改已有规则时，原有限制条件必须还在、且不许更宽——把 `/tmp/` 收成 `/tmp` 这种前缀放宽
// 会让这一类攻击静默漏报。逐条给旧条件配一条「至少同样严」的新条件（一对一），配不上的就是被放宽/删掉了。
// 新增规则没有原条件可放宽，不走这条。
function widenedConditions(previousRego, nextRego) {
  const remaining = ruleExpressions(nextRego);
  const widened = [];
  for (const previous of ruleExpressions(previousRego)) {
    const index = remaining.findIndex(candidate => atLeastAsStrict(previous, candidate));
    if (index < 0) widened.push(previous.text);
    else remaining.splice(index, 1);
  }
  return widened;
}

/**
 * 规则维护者（P003-T041 A4/A5）：拿一条已完成的误报案件，让模型改一条 Rego 或新增一条。
 *
 * - **写盘只有一条路**：`RuleStore.save()`——与人工维护接口 `PUT /api/rules/{id}` 是同一个方法，
 *   校验、旧版进历史、原子替换都在那里；这里不再有第二套直写文件的函数。
 * - **每次维护落一份会话**（`<数据根>/rule-sessions/<uuid>.json`，形制对齐 wiki-sessions）：
 *   输入案卷引用、模型草案、校验结果、终态。会话先落一份再干活，模型或校验半路挂掉也留得下「卡在哪」。
 * 返回 `{ id, file, name, action, rationale, rev, previous_rev, session_id }`；任何一步不成立都抛错，调用方记 failed。
 */
export class RegoRuleMaintainer {
  constructor(model, ruleStore, prompts, sessions = null) {
    this.model = model; this.ruleStore = ruleStore; this.prompts = prompts; this.sessions = sessions;
  }

  async maintain({ caseId, caseDir = null, eventType, reason, who, alert, ruleIds = [], domain = null, sessionId = null }) {
    const now = new Date().toISOString();
    const session = this.sessions ? await this.sessions.save({ id: randomUUID(),
      case_id: caseId, case_dir: caseDir, event_type: eventType, reason, who, status: 'collecting',
      proposal: null, validation: null, result: null, error: null, created_at: now, updated_at: now }) : null;
    // 会话的每次状态推进都落盘：维护跑在后台，进程挂掉后数据根里还能看出这次维护到哪一步。
    // 累积在 `record` 上（不是在原始 `session` 上）——后一次推进不能把前一次记下的草案/校验结果冲掉。
    let record = session;
    const settle = async patch => {
      if (!record) return;
      record = { ...record, ...patch, updated_at: new Date().toISOString() };
      await this.sessions.save(record);
    };
    try {
      const inventory = await this.ruleStore.list();
      const matched = [];
      for (const id of ruleIds) {
        const rule = await this.ruleStore.read(id);
        if (rule) matched.push({ id: rule.id, name: rule.name, rego: rule.rego });
      }
      const prompt = (await this.prompts.load())?.prompts?.rule;
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('规则维护提示词未配置');
      const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify({ case_id: caseId, event_type: eventType, false_positive_reason: reason,
          reported_by: who, alert, matched_rules: matched, existing_rules: inventory.rules }) }
      ];
      // P003-T046 A4：规则维护是单发调用，同样落 ai.model_call；session_id 与 T041 的维护会话互引
      //（事件说「这次调用属于哪次维护」，会话文件说「这次维护提了什么、验过没过、落在哪」）。
      // 域缺省是「规则维护」；误报统一维护 Agent（P003-T047 A5）跑这一轮时传 `false_positive`，
      // 这样同一个案件的三次调用（决策 / 规则维护 / 知识维护）在 T046 事件里是同一域。
      const maintainMeta = { domain: domain === 'false_positive' ? 'false_positive' : 'rule', role: 'rule_maintainer', turn: 1, phase: 'maintain',
        sessionId: sessionId ?? record?.id ?? null, model: this.model?.model || null, messages, tools: [] };
      const replied = await traceModelCall(maintainMeta, () => this.model.complete(messages, [], 'none'),
        { decode: value => ruleProposal(value.content) });
      const output = replied.decoded;
      if (output.ready === false)
        throw new Error(`规则维护者没有给出可落盘的修订：${String(output.reason || '').slice(0, 200) || '未说明原因'}`);
      const id = String(output.id || '').trim();
      if (!isRuleId(id)) throw new Error(`规则 id 不合法：${id || '(空)'}`);
      const rego = String(output.rego || '');
      if (!rego.trim()) throw new Error('规则正文为空');
      const rationale = String(output.reason || '').slice(0, 500);
      // 草案先记进会话：即便下面校验不过，数据根里也留得下模型当时提了什么。
      await settle({ status: 'validating', proposal: { id, rego, rationale } });
      // 第一道校验：语法必须在规则子集内（与装载器同一份 `parseRule`，报错带 file:line）。
      this.ruleStore.validate(id, rego);
      const existing = await this.ruleStore.read(id);
      // 第二道校验：改已有规则时原条件不许更宽。放在写盘之前——校验不过就一个字都不落，维护判 failed。
      if (existing) {
        const widened = widenedConditions(existing.rego, rego);
        if (widened.length)
          throw new Error(`规则修订放宽了原有限制条件，拒绝落盘：${widened.join('；').slice(0, 200)}`);
      }
      const saved = await this.ruleStore.save(id, rego, { note: `误报维护（${who}）：${rationale.slice(0, 120)}` });
      await settle({ status: saved.action === 'unchanged' ? 'no_change' : 'updated',
        validation: { ok: true, name: saved.name, file: saved.file, rev: saved.rev },
        result: { action: saved.action, file: saved.file, rev: saved.rev, previous_rev: saved.previous_rev } });
      // 返回形状与 P003-T013 一致（调用方 `maintainFalsePositive` 与既有测试都按这四个字段读）；
      // `rev` / `previous_rev` / 会话 id 落在会话文件里（`GET /api/rules/sessions` 可按 case_id 找到）。
      return { id, file: saved.file, name: saved.name, action: saved.action, rationale };
    } catch (cause) {
      // 会话落盘本身再挂，也不能顶掉原始错误：调用方要看到的是「为什么维护没成」。
      await settle({ status: 'failed', error: scrubCredentials(cause?.message || cause).slice(0, 300) }).catch(() => {});
      throw cause;
    }
  }
}

const regoMaintainer = models ? new RegoRuleMaintainer(models.rule_maintainer, regoRuleStore, promptStore, defaultRuleSessions) : null;

// `caseRegoRuleIds()` 与 `wikiFeedbackTarget()` 搬到 `fp-maintainer.js` 了（P003-T047）：
// 误报统一维护 Agent 与 `POST /api/wiki/sessions` 共用同一份选页口径，`server.js` 不再留第二份。


// 误报统一维护 Agent（P003-T047）：一个案件跑一份多轮会话（读案卷 → 读两库 → 提修订 → 自校验），
// 由它决定这一次只动规则、只动知识库、还是两边都动；`libraries` 是补跑单腿的入口（A4）。
// 映射回 `record.maintenance` 时**状态词表不变**（`updating|updated|failed`，T013 与 openapi 按它写）：
// 新增的 `no_change` / `skipped` 落在单边的 `state` 上，老客户端不会读错。
async function maintainFalsePositive({ monitor, record, maintainer, libraries = FP_LIBRARIES, previous = null }) {
  const state = record.maintenance;
  const parsed = record.input?.parsed;
  const startedAt = new Date().toISOString();
  // 没请求的一侧（单腿补跑）如实标 skipped：既不谎报成「改完了」，也不把总态永久钉在 updating。
  // 上一轮的 revision / 幂等键照样留着（A4 的判据载体，见路由里同名的 untouchedSide）。
  const untouched = library => {
    const side = previous?.[library] || {};
    const { status, state, why, error, at: previousAt, ...kept } = side;
    return { ...kept, status: 'updated', state: 'skipped', at: startedAt,
      why: `本次只补跑 ${libraries.join('、')}：${library} 侧未执行` };
  };
  try {
    if (!maintainer) throw new Error('误报维护 Agent 未配置');
    const session = await maintainer.maintain({ caseId: record.alert_id, caseDir: record.case_dir || null,
      eventType: eventTypeFor(parsed?.msgid), reason: record.feedback.reason, who: record.feedback.who,
      alert: parsed ? { msgid: parsed.msgid, payload: parsed.payload } : null, libraries, previous });
    state.rule = maintenanceSide(session.outcomes?.rule, untouched('rule'));
    state.wiki = maintenanceSide(session.outcomes?.wiki, untouched('wiki'));
    state.session_id = session.id;
    state.sides = maintenanceSides(session);
    state.decision = session.decision ? { source: session.decision.source, libraries: session.decision.libraries || [],
      why: session.decision.why || null } : null;
    state.auto_verdict = session.auto_verdict;
    state.status = maintenanceState([state.rule, state.wiki]);
  } catch (cause) {
    // 维护失败原因会随记录回给调用方（falsePositiveView），同样过一道凭据擦除（A4）。
    const error = scrubCredentials(cause?.message || cause).slice(0, 300);
    for (const library of FP_LIBRARIES) {
      if (libraries.includes(library)) state[library] = { status: 'failed', state: 'failed', at: startedAt, error };
      else state[library] = state[library] || untouched(library);
    }
    state.status = 'failed';
    state.error = error;
  }
  state.updated_at = new Date().toISOString();
  await monitor.persist?.();
}

// 误报入口的响应：结论 + 理由 + 维护进度（GET 同一条案件也能读到同样的三个字段）。
function falsePositiveView(record) {
  return { alert_id: record.alert_id,
    verdict: { verdict: record.verdict, verdict_label: record.verdict_label, source: record.decision_source },
    feedback: record.feedback, maintenance: record.maintenance };
}

// ── 错误响应：四类失败，一类一个稳定 code（P003-T024 → T073 单一真源）────────────────
// json / fail 家族全部来自 `src/shared/errors.js`（业务端四类 + 401/502/SSE 特例的唯一出口）；
// 这里只留 import 别名与身份判定。R-ERROR：任何路由不许自己构造错误响应（check-layers 强制）。
function hasAccess(req, access) {
  if (!access?.password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`${access.user || 'admin'}:${access.password}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function hasPromptAdminAccess(req, token) {
  if (!token) return false;
  const supplied = req.headers['x-prompt-admin-token'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function hasRuleAdminAccess(req, token) {
  if (!token) return false;
  const supplied = req.headers['x-rule-admin-token'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readJSON(req, maxLength = 8192) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    // 两条都是调用方传错：带上 status 让外层分类不用去读文案（旧版靠 /请求正文/ 匹配）。
    if (body.length > maxLength) throw Object.assign(new Error('请求正文过大'), { status: 400 });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('请求正文不是 JSON'), { status: 400 }); }
}
function configured(res) {
  if (gateway) return true;
  configError(res, '未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN');
  return false;
}
// 牧云调用一律经这里：失败时留一条 cloudwalker.call_failed（op 说明哪次调用，告警相关的带 alert_id），
// 打上 failure: 'upstream' 再抛出——外层据此回 502，不用拿文案猜「这是上游还是本程序」。
async function viaCloudwalker(op, alertId, job) {
  try { return await job(); }
  catch (cause) {
    log('cloudwalker.call_failed', { op, alert_id: alertId ?? null, error: String(cause?.message || cause) }, 'error');
    throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { failure: 'upstream' });
  }
}
function validAlertId(value) {
  const match = String(value || '').match(/^([a-z_]+):([1-9][0-9]*)$/);
  return Boolean(match && Object.hasOwn(eventTypes, match[1]) && Number.isSafeInteger(Number(match[2])));
}
function validTriageId(value) {
  return validAlertId(value) || /^syslog:[a-z_]+:[a-f0-9]{16}:(?:[0-9]+|unknown):[a-f0-9-]{36}$/.test(String(value));
}
// /api/wiki/pages/{pagePath} 的路径解析：不是页面路径返回 null，编码无效返回 { invalidEncoding: true }。
function wikiPagePath(pathname) {
  const prefix = '/api/wiki/pages/';
  if (!pathname.startsWith(prefix)) return null;
  try { return { filename: decodeURIComponent(pathname.slice(prefix.length)) }; }
  catch { return { invalidEncoding: true }; }
}
function validTraceTarget(value) {
  if (validTriageId(value)) return true;
  const address = String(value || '').replace(/^ip:/, '');
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(part => Number(part) <= 255);
}
// /api/alerts 的筛选词表：等级既收 levelKey 也收 1-4 序号，统一落成秩再下推。
const levelFilters = Object.freeze({ '1': 1, low: 1, '2': 2, medium: 2, '3': 3, high: 3, '4': 4, critical: 4 });
const triageStatusFilters = new Set(TRIAGE_STATUSES);
const verdictFilters = new Set(['review', ...VERDICT_KEYS]);
// 研判状态 / 结论要挂完 triage 才能判，只能翻页扫；单次请求最多扫这么多条。
const TRIAGE_SCAN_LIMIT = 500;
const paramList = (params, name) => params.getAll(name).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);

// 解析 /api/alerts 的查询参数：非法值给 400 文案，合法值落成下推给网关的形态。
function alertQuery(params) {
  const type = params.get('type')?.trim() || undefined;
  if (type && !Object.hasOwn(eventTypes, type)) return { error: `筛选事件类型无效：${type}` };
  const level = [];
  for (const value of paramList(params, 'level')) {
    const rank = levelFilters[value.toLowerCase()];
    if (!rank) return { error: `筛选等级无效：${value}` };
    if (!level.includes(rank)) level.push(rank);
  }
  const from = params.get('from')?.trim();
  const to = params.get('to')?.trim();
  const fromTime = from ? parseInstant(from) : null;
  const toTime = to ? parseInstant(to) : null;
  if (from && !fromTime) return { error: `筛选起始时间无效：${from}` };
  if (to && !toTime) return { error: `筛选结束时间无效：${to}` };
  if (fromTime && toTime && fromTime > toTime) return { error: '筛选起始时间晚于结束时间' };
  const sort = params.get('sort')?.trim() || 'time';
  if (sort !== 'time' && sort !== 'level') return { error: `排序方式无效：${sort}` };
  const statuses = paramList(params, 'triage_status');
  for (const value of statuses) if (!triageStatusFilters.has(value)) return { error: `筛选研判状态无效：${value}` };
  const verdicts = paramList(params, 'verdict');
  for (const value of verdicts) if (!verdictFilters.has(value)) return { error: `筛选结论无效：${value}` };
  return { query: { type, level: level.length ? level : undefined, q: params.get('q')?.trim() || undefined,
    from: fromTime || undefined, to: toTime || undefined, sort }, statuses, verdicts };
}

// 解析 /api/agent/triage/cases 的查询参数：筛选用法与 /api/alerts 同一套（逗号分隔多选），非法值回 400。
// 结论口径一致：记录上没有结论算 review；事件类型按 syslog MsgId 映射出的类型比。
function caseQuery(params) {
  const verdicts = paramList(params, 'verdict');
  for (const value of verdicts) if (!verdictFilters.has(value)) return { error: `筛选结论无效：${value}` };
  const type = params.get('type')?.trim() || null;
  if (type && !Object.hasOwn(eventTypes, type)) return { error: `筛选事件类型无效：${type}` };
  const from = params.get('from')?.trim();
  const to = params.get('to')?.trim();
  const fromTime = from ? parseInstant(from) : null;
  const toTime = to ? parseInstant(to) : null;
  if (from && !fromTime) return { error: `筛选起始时间无效：${from}` };
  if (to && !toTime) return { error: `筛选结束时间无效：${to}` };
  if (fromTime && toTime && fromTime > toTime) return { error: '筛选起始时间晚于结束时间' };
  const sort = params.get('sort')?.trim() || 'time';
  if (sort !== 'time' && sort !== 'verdict') return { error: `排序方式无效：${sort}` };
  // 案件记录上的事件时间是秒级 Unix 时间（eventSeconds 口径），这里把入参也落成秒再比。
  return { filters: { verdicts, type, host: params.get('host')?.trim() || null,
    from: fromTime ? Math.floor(Date.parse(fromTime) / 1000) : null,
    to: toTime ? Math.floor(Date.parse(toTime) / 1000) : null, sort } };
}

// 解析 /api/trace/boards 的查询参数：分页由路由先校验；这里只做筛选词表与时间校验。
const traceStatuses = new Set(['running', 'done', 'failed', 'interrupted']);
function traceQuery(params) {
  const statuses = paramList(params, 'status');
  for (const value of statuses) if (!traceStatuses.has(value)) return { error: `筛选状态无效：${value}` };
  const type = params.get('type')?.trim() || null;
  if (type && !Object.hasOwn(eventTypes, type)) return { error: `筛选事件类型无效：${type}` };
  const from = params.get('from')?.trim();
  const to = params.get('to')?.trim();
  const fromTime = from ? parseInstant(from) : null;
  const toTime = to ? parseInstant(to) : null;
  if (from && !fromTime) return { error: `筛选起始时间无效：${from}` };
  if (to && !toTime) return { error: `筛选结束时间无效：${to}` };
  if (fromTime && toTime && fromTime > toTime) return { error: '筛选起始时间晚于结束时间' };
  const host = params.get('host')?.trim() || null;
  return { filters: { ...(statuses.length ? { statuses } : {}), ...(type ? { type } : {}),
    ...(host ? { host } : {}), ...(fromTime ? { from: Date.parse(fromTime) } : {}),
    ...(toTime ? { to: Date.parse(toTime) } : {}) } };
}

// 解析 /api/logs 的查询参数（P003-T045）：event / level 都支持逗号多选（与 /api/alerts 同一套 paramList 口径），
// from/to 用同一个 parseInstant；非法值一律 400，不在读盘时静默当成「不过滤」。
function logQuery(params) {
  const events = paramList(params, 'event');
  const levels = paramList(params, 'level').map(value => value.toLowerCase());
  for (const value of levels) if (!queryLevels.includes(value)) return { error: `筛选等级无效：${value}` };
  const from = params.get('from')?.trim();
  const to = params.get('to')?.trim();
  const fromTime = from ? parseInstant(from) : null;
  const toTime = to ? parseInstant(to) : null;
  if (from && !fromTime) return { error: `筛选起始时间无效：${from}` };
  if (to && !toTime) return { error: `筛选结束时间无效：${to}` };
  if (fromTime && toTime && fromTime > toTime) return { error: '筛选起始时间晚于结束时间' };
  return { filters: { events, levels, from: fromTime, to: toTime,
    q: params.get('q')?.trim() || null,
    requestId: params.get('request_id')?.trim() || null,
    user: params.get('user')?.trim() || null } };
}

// 研判侧筛选：逐页拉取、挂 triage 后过滤，翻到流末或扫描上限后再切页。
// 没有研判记录的告警按 not_queued / review 参与筛选（与 TriageCase.status 口径一致）。
async function triageFilteredAlerts(service, monitor, query, { statuses, verdicts, count, offset }) {
  const collected = [];
  let envelope = null;
  let pageOffset = 0;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const page = await viaCloudwalker('alerts', null, () => service.alerts({ ...query, count: 50, offset: pageOffset }));
    envelope ??= page;
    const rows = page.alerts || [];
    if (!rows.length) break;
    for (const alert of rows) {
      scanned += 1;
      const triage = monitor ? monitor.status(alert.id) : null;
      const status = triage?.status || 'not_queued';
      const verdict = triage?.verdict || alert.verdictKey || 'review';
      if (statuses.length && !statuses.includes(status)) continue;
      if (verdicts.length && !verdicts.includes(verdict)) continue;
      collected.push({ ...alert, triage });
    }
    pageOffset += rows.length;
    if (pageOffset >= Number(page.total) || scanned >= TRIAGE_SCAN_LIMIT) {
      truncated = scanned >= TRIAGE_SCAN_LIMIT && pageOffset < Number(page.total);
      break;
    }
  }
  return { ...envelope, alerts: collected.slice(offset, offset + count), total: collected.length, truncated };
}

// ── 数据管理（P003-T044 + T061 扩 16 类）：盘点 / 归档 / 清理 ────────────────
// 运行态的真源路径一律取自 createServer 的注入件（history / boardService / wikiAgent / monitor / config），
// 不另立一套路径表：测试换掉注入件里的替身目录，盘点的就是那份替身目录。
// dataRoot 取配置覆盖层文件所在目录（缺省就是数据根，仓库外）：队列的 .archive.jsonl 与清理归档目录都落在这下面。
// T061（C06）：七类扩成十六类——漏的九类里 fp-sessions/ 实测 27MB/3187 文件无声增长，运维此前看不见也清不掉。
// **审计（audit/）有意不入清单**（P003-T062）：审计流 append-only 不随清理消失，与可清理的运行态性质相反。
export const DATA_KINDS = Object.freeze(['cases', 'investigations', 'boards', 'wiki_sessions', 'fp_sessions',
  'rule_sessions', 'queue', 'logs', 'config_overrides', 'rules', 'rules_history', 'wiki', 'wiki_history',
  'prompt_overrides', 'triage_rules', 'update_packages']);
const DATA_KIND_LABELS = Object.freeze({ cases: '案卷', investigations: '研判记录', boards: '溯源白板',
  wiki_sessions: '知识库会话', fp_sessions: '误报维护会话', rule_sessions: '规则维护会话', queue: '研判队列',
  logs: '日志', config_overrides: '配置覆盖层', rules: 'Rego 规则库', rules_history: '规则历史',
  wiki: '判据库', wiki_history: '判据历史', prompt_overrides: '提示词覆盖层', triage_rules: '前置规则集',
  update_packages: '升级包暂存' });
const DATA_CLEAN_ACTIONS = Object.freeze(['archive', 'delete']);
const DATA_CANDIDATE_LIMIT = 100; // dry-run 清单最多列这么多条，多出来的只给数字（truncated: true）

function dataAdminRoot(deps) {
  return deps.config?.file ? path.dirname(deps.config.file) : runtime.data;
}

// 布局四种：dirs（一级子目录各算一条）/ files（匹配扩展名的文件）/ single（单文件）/ queue（队列文件，条数＝记录）。
// logs 也走 files 布局，匹配 *.log，目录就是 dataRoot：后端自身不落日志文件（docs/architecture.md:156）。
// T061 新增九类的落点与 rule-store/wiki-store/prompt-store/update-store 的缺省一致（runtimePaths/dataRoot 口径）。
function dataStores(deps = {}) {
  const root = dataAdminRoot(deps);
  const store = (kind, layout, location, extension = null) => ({ kind, label: DATA_KIND_LABELS[kind], layout, path: location, extension, root });
  return new Map([
    ['cases', store('cases', 'dirs', deps.monitor?.casesDirectory || process.env.HIDS_CASES_DIR || path.join(root, 'cases'))],
    ['investigations', store('investigations', 'files', deps.history?.directory || path.join(root, 'investigations'), 'json')],
    ['boards', store('boards', 'files', deps.boardService?.directory || path.join(root, 'trace-boards'), 'json')],
    ['wiki_sessions', store('wiki_sessions', 'files', deps.wikiAgent?.directory || path.join(root, 'wiki-sessions'), 'json')],
    ['fp_sessions', store('fp_sessions', 'files', deps.fpSessions?.directory || path.join(root, 'fp-sessions'), 'json')],
    ['rule_sessions', store('rule_sessions', 'files', deps.ruleSessions?.directory || path.join(root, 'rule-sessions'), 'json')],
    ['queue', store('queue', 'queue', deps.monitor?.file || path.join(root, 'triage-monitor.json'))],
    ['logs', store('logs', 'files', root, 'log')],
    ['config_overrides', store('config_overrides', 'single', deps.config?.file || path.join(root, 'config-overrides.json'))],
    ['rules', store('rules', 'files', deps.ruleStore?.directory || path.join(root, 'rules'), 'rego')],
    ['rules_history', store('rules_history', 'files', deps.ruleStore?.historyDirectory || path.join(root, 'rules-history'), null)],
    ['wiki', store('wiki', 'files', deps.wiki?.directory || path.join(root, 'wiki'), 'md')],
    ['wiki_history', store('wiki_history', 'files', deps.wiki?.historyDirectory || path.join(root, 'wiki-history'), 'md')],
    ['prompt_overrides', store('prompt_overrides', 'single', deps.prompts?.filename || path.join(root, 'prompt-overrides.json'))],
    ['triage_rules', store('triage_rules', 'single', deps.monitor?.ruleEngine?.filename || path.join(root, 'triage-rules.json'))],
    ['update_packages', store('update_packages', 'files', deps.updateStore?.directory || path.join(root, 'update-packages'), 'json')]
  ]);
}

async function statOrNull(location) {
  try { return await stat(location); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function listOrNull(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// 一个文件/目录占多少字节、最后一次写是什么时候。
// 目录递归累加字节；at 取目录里**文件**的最新 mtime（空目录退回目录自身的 mtime）——
// 目录 mtime 只在建/删条目时变，拿它当「这个案卷最后动过是什么时候」会偏到刚建目录那一刻。
// 读不到的条目按 0 字节算：盘点不能因为一个断掉的符号链接整个 500。
async function measure(location) {
  let info;
  try { info = await stat(location); }
  catch { return { bytes: 0, at: null, exists: false }; }
  if (!info.isDirectory()) return { bytes: info.size, at: info.mtimeMs, exists: true };
  let bytes = 0, at = null;
  let entries = [];
  try { entries = await readdir(location, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    // 只把文件的时间算进来：子目录自己的 mtime 同样是「建/删条目」时刻，不是内容时刻。
    const child = await measure(path.join(location, entry.name));
    bytes += child.bytes;
    if (child.at != null && (at == null || child.at > at)) at = child.at;
  }
  return { bytes, at: at ?? info.mtimeMs, exists: true };
}

const isoOrNull = at => (at == null ? null : new Date(at).toISOString());

// 一类存储里的「条」：文件布局是一个文件，dirs 布局是一个下级目录，single 是那一个文件。
async function storeEntries(store) {
  if (store.layout === 'single') {
    const measured = await measure(store.path);
    return measured.exists ? [{ name: path.basename(store.path), path: store.path, bytes: measured.bytes, at: measured.at }] : [];
  }
  const entries = await listOrNull(store.path);
  if (!entries) return [];
  const picked = entries.filter(entry => entry.isDirectory()
    ? store.layout === 'dirs'
    : store.layout === 'files' && (!store.extension || entry.name.endsWith(`.${store.extension}`)));
  const rows = [];
  for (const entry of picked) {
    const location = path.join(store.path, entry.name);
    const measured = await measure(location);
    rows.push({ name: entry.name, path: location, bytes: measured.bytes, at: measured.at });
  }
  return rows;
}

// 队列条数：有研判队列时按进程内记录数（内存才是活口径），没有队列时退回读队列文件里的 records。
// 字节数＝队列文件 + 同名 .archive.jsonl（归档也是队列这块存储的占用）。
async function queueMeasure(store, deps) {
  const queueFile = await statOrNull(store.path);
  const archiveFile = await statOrNull(`${store.path}.archive.jsonl`);
  let records = [];
  if (deps.monitor?.records instanceof Map) records = [...deps.monitor.records.values()];
  else if (queueFile) {
    try {
      const data = JSON.parse(await readFile(store.path, 'utf8'));
      records = Array.isArray(data.records) ? data.records : [];
    } catch { records = []; }
  }
  const stamps = records.map(record => Date.parse(record.updated_at || record.saved_at || record.created_at || ''))
    .filter(Number.isFinite).sort((a, b) => a - b);
  return { exists: Boolean(queueFile), count: records.length,
    bytes: (queueFile?.size || 0) + (archiveFile?.size || 0),
    oldestAt: stamps[0] ?? null, newestAt: stamps[stamps.length - 1] ?? null };
}

async function inventoryRow(store, deps) {
  if (store.layout === 'queue') {
    const queue = await queueMeasure(store, deps);
    return { kind: store.kind, label: store.label, path: store.path, exists: queue.exists,
      count: queue.count, bytes: queue.bytes, oldest_at: isoOrNull(queue.oldestAt), newest_at: isoOrNull(queue.newestAt) };
  }
  const entries = await storeEntries(store);
  const exists = store.layout === 'single' ? entries.length > 0 : (await listOrNull(store.path)) !== null;
  const ats = entries.map(entry => entry.at).filter(at => at != null);
  return { kind: store.kind, label: store.label, path: store.path, exists,
    count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    oldest_at: isoOrNull(ats.length ? Math.min(...ats) : null), newest_at: isoOrNull(ats.length ? Math.max(...ats) : null) };
}

// 盘点：七类各报条数与字节，再给一个总数。每次都现扫盘（清理前后的数字立刻对得上，A5）。
export async function dataInventory(deps = {}) {
  const stores = dataStores(deps);
  const rows = [];
  for (const kind of DATA_KINDS) rows.push(await inventoryRow(stores.get(kind), deps));
  const total = rows.reduce((sum, row) => ({ count: sum.count + row.count, bytes: sum.bytes + row.bytes }), { count: 0, bytes: 0 });
  return { data_dir: dataAdminRoot(deps), stores: rows, total };
}

const dataCallerError = message => Object.assign(new Error(message), { status: 400 });

// 案卷清理的 409：目录上挂着非 done 记录（还在排 / 在跑 / 等重排）的，整个请求拒绝，盘上一动不动。
function assertCasesSettled(store, chosen, deps) {
  if (store.kind !== 'cases' || typeof deps.monitor?.blockedCaseDirs !== 'function') return;
  const blocked = deps.monitor.blockedCaseDirs();
  const hit = chosen.filter(entry => blocked.has(path.resolve(entry.path)));
  if (!hit.length) return;
  const error = new Error(`${hit.length} 个案卷对应的案件还在排或在跑，已完结的案件才可清理`);
  error.status = 409;
  throw error;
}

// 归档文件名前加执行时刻：同一路径清理两次不会覆盖上一份（rename 对已存在的目标是静默替换）。
function archiveTarget(directory, name, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return path.join(directory, `${stamp}-${name}`);
}

async function fileCleanup(deps, store, { action, execute, olderThan, keep, now }) {
  const entries = await storeEntries(store);
  const ranked = entries.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const selected = new Map();
  if (Number.isInteger(keep)) for (const entry of ranked.slice(keep)) selected.set(entry.path, entry);
  if (Number.isFinite(olderThan))
    for (const entry of entries) if (entry.at != null && entry.at < olderThan) selected.set(entry.path, entry);
  const chosen = [...selected.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  assertCasesSettled(store, chosen, deps);
  const bytes = chosen.reduce((sum, entry) => sum + entry.bytes, 0);
  const listed = { count: chosen.length, bytes,
    items: chosen.slice(0, DATA_CANDIDATE_LIMIT).map(entry => ({ name: entry.name, bytes: entry.bytes, at: isoOrNull(entry.at) })),
    truncated: chosen.length > DATA_CANDIDATE_LIMIT };
  if (!execute || !chosen.length) return { count: chosen.length, bytes, listed };
  const archiveDir = path.join(store.root, 'archive', store.kind);
  if (action === 'archive') await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  for (const entry of chosen) {
    if (action === 'archive') await rename(entry.path, archiveTarget(archiveDir, entry.name, now));
    else await rm(entry.path, { recursive: true, force: true });
  }
  return { count: chosen.length, bytes, listed };
}

async function queueCleanup(deps, store, { action, execute, olderThan, keep }) {
  const monitor = deps.monitor;
  if (typeof monitor?.clean !== 'function') {
    // 没有研判队列就没有「案件状态」可判：不拿队列文件硬删（那是另一条进程的活）。
    throw Object.assign(new Error('自动研判尚未配置（没有研判队列），无法清理队列'), { failure: 'config' });
  }
  const result = await monitor.clean({ action, execute, olderThan, keep });
  return { count: result.count, bytes: result.bytes,
    listed: { count: result.count, bytes: result.bytes,
      items: result.items.slice(0, DATA_CANDIDATE_LIMIT), truncated: result.items.length > DATA_CANDIDATE_LIMIT } };
}

// 清理：按类型 + 阈值（早于某时间 / 超过某数量）归档或删除；默认 dry-run 只报清单，execute: true 才动盘。
// 真执行才落 data.cleaned 一条（只带类型、动作、条数、字节，不带文件名与内容——与 config.updated 同一口径）。
export async function dataCleanup(deps = {}, body = null, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw dataCallerError('请求正文必须是 JSON 对象');
  const unknown = Object.keys(body).filter(key => !['kind', 'action', 'execute', 'older_than', 'keep'].includes(key));
  if (unknown.length) throw dataCallerError(`不认识的参数：${unknown.join('、')}`);
  if (!DATA_KINDS.includes(body.kind)) throw dataCallerError(`要清理的类型只能是 ${DATA_KINDS.join('、')}`);
  const action = body.action ?? 'archive';
  if (!DATA_CLEAN_ACTIONS.includes(action)) throw dataCallerError(`action 只能是 ${DATA_CLEAN_ACTIONS.join(' 或 ')}`);
  const execute = body.execute ?? false;
  if (typeof execute !== 'boolean') throw dataCallerError('execute 必须是布尔值');
  const olderThan = body.older_than == null ? null : Date.parse(body.older_than);
  if (body.older_than != null && !Number.isFinite(olderThan)) throw dataCallerError('older_than 必须是可解析的时间（ISO 8601）');
  const keep = body.keep ?? null;
  if (keep != null && (!Number.isSafeInteger(keep) || keep < 0)) throw dataCallerError('keep 必须是不小于 0 的整数');
  if (olderThan == null && keep == null) throw dataCallerError('至少要给一个阈值：older_than（早于某时间）或 keep（保留最新 N 条）');
  const store = dataStores(deps).get(body.kind);
  const outcome = body.kind === 'queue'
    ? await queueCleanup(deps, store, { action, execute, olderThan, keep })
    : await fileCleanup(deps, store, { action, execute, olderThan, keep, now });
  if (execute) log('data.cleaned', { kind: body.kind, action, count: outcome.count, bytes: outcome.bytes });
  return { dry_run: !execute, kind: body.kind, action,
    threshold: { older_than: body.older_than ?? null, keep },
    candidates: outcome.listed,
    applied: { count: execute ? outcome.count : 0, bytes: execute ? outcome.bytes : 0 },
    inventory: await dataInventory(deps) };
}

// 日志清理（P003-T045）：按时间 / 总大小清轮转出来的历史文件，当前活动文件永不在候选里。
// 与 /api/data/cleanup 同口径：默认 dry-run，只收已知参数，阈值一个都不给回 400（不许无阈值一把抹）。
// 真执行才落一条 log.cleaned（只带口径、条数、字节，不带文件名——与 data.cleaned 同一口径）。
function logCleanup(file, body = null) {
  const bad = message => Object.assign(new Error(message), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('请求正文必须是 JSON 对象');
  const unknown = Object.keys(body).filter(key => !['older_than', 'max_bytes', 'execute'].includes(key));
  if (unknown.length) throw bad(`不认识的参数：${unknown.join('、')}`);
  if (body.execute != null && typeof body.execute !== 'boolean') throw bad('execute 必须是布尔值');
  const olderThan = body.older_than == null ? null : Date.parse(body.older_than);
  if (body.older_than != null && !Number.isFinite(olderThan)) throw bad('older_than 必须是可解析的时间（ISO 8601）');
  const maxBytes = body.max_bytes ?? null;
  if (maxBytes != null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw bad('max_bytes 必须是不小于 0 的整数');
  if (olderThan == null && maxBytes == null)
    throw bad('至少要给一个阈值：older_than（早于某时间）或 max_bytes（历史文件总字节上限）');
  const execute = body.execute === true;
  const outcome = pruneLogFiles({ file, olderThan, maxBytes, execute });
  if (execute) log('log.cleaned', { by: olderThan != null && maxBytes != null ? 'age+size' : olderThan != null ? 'age' : 'size',
    count: outcome.applied.count, bytes: outcome.applied.bytes });
  return outcome;
}

// 方法不匹配统一回 405（P003-T073）：已知路径的合法方法集一张表；批 7 路由表化时它就是路由表的 method 列。
// `POST /api/agent/prompts` 与 `/api/agent/prompts/upload` 在上面有自己的分支（405 / 410 哨兵），不进这张表。
const routeMethods = Object.freeze({
  '/api/session': ['GET'], '/api/updates': ['GET'], '/api/config': ['GET', 'POST'],
  '/api/data/inventory': ['GET'], '/api/data/cleanup': ['POST'],
  '/api/logs': ['GET'], '/api/logs/cleanup': ['POST'], '/api/status': ['GET'],
  '/api/agent/tools': ['GET'], '/api/trace/tools': ['GET'], '/api/agent/status': ['GET'],
  '/api/agent/prompts': ['GET'],
  '/api/trace/boards': ['GET', 'POST'], '/api/agent/triage/status': ['GET'],
  '/api/agent/triage/cases': ['GET'], '/api/agent/triage/control': ['PUT'],
  '/api/triage/rules': ['GET', 'PUT'], '/api/triage/rules/validate': ['POST'],
  '/api/rules': ['GET'], '/api/rules/sessions': ['GET'], '/api/rules/evaluate': ['POST'],
  '/api/false-positive/sessions': ['GET'], '/api/wiki/pages': ['GET'],
  '/api/wiki/health': ['GET'], '/api/wiki/sessions': ['GET', 'POST'],
  '/api/agent/investigations': ['GET', 'POST'], '/api/alerts': ['GET']
});
// 动态前缀：末尾带 / 的键按前缀匹配（`/api/rules/{id}` 系）。
const routeMethodPrefixes = Object.freeze([
  ['/api/rules/', ['GET', 'PUT', 'POST']], ['/api/agent/triage/', ['GET', 'POST', 'DELETE']],
  ['/api/wiki/', ['GET', 'PUT', 'POST']], ['/api/agent/investigations/', ['GET']],
  ['/api/alerts/', ['GET']], ['/api/trace/boards/', ['GET']], ['/api/false-positive/sessions/', ['GET']]
]);
function allowedMethods(pathname) {
  if (routeMethods[pathname]) return routeMethods[pathname];
  const prefix = routeMethodPrefixes.find(([head]) => pathname.startsWith(head));
  return prefix ? prefix[1] : null;
}

export function createServer(service = gateway, toolbox = apiToolbox, investigator = agent, history = investigationStore, prompts = promptStore, monitor = service === gateway ? triageMonitor : null, knowledge = null,
  access = { user: process.env.HIDS_BASIC_AUTH_USER, password: process.env.HIDS_BASIC_AUTH_PASSWORD }, boardService = service === gateway ? traceBoard : null,
  promptAdminToken = process.env.HIDS_PROMPT_ADMIN_TOKEN, wiki = wikiStore, wikiAgent = wikiWorkbench,
  maintenanceEntry = process.env.HIDS_MAINTENANCE_ENTRY_URL,
  ruleAdminToken = process.env.HIDS_RULE_ADMIN_TOKEN, ruleStore = regoRuleStore,
  ruleMaintainer = regoMaintainer, config = configStore, ruleSessions = defaultRuleSessions,
  logFile = logOptions ? logOptions.file : null, fpSessions = defaultFpSessions, fpDecision = fpDecisionModel,
  fpMaintainer = null, triageRules = triageRuleEngine) {
  // 注入的 TraceBoardService 没有取数器时，用本次的 monitor / history 现接一条：
  // 测试与部署走同一套接线，不再靠测试里手塞假 analysis。
  if (boardService instanceof TraceBoardService && !boardService.analysis)
    boardService.analysis = createAnalysisProvider({ monitor, history });
  const investigate = async (executor, alertId, mode, onProgress = null) => {
    if (mode === 'triage' && monitor?.ruleEngine) {
      let decision;
      try { decision = await monitor.ruleEngine.evaluate({ alertId, toolbox }); }
      catch (cause) { decision = { status: 'error', reason: `规则评估失败：${String(cause.message).slice(0, 180)}` }; }
      if (decision.status === 'candidate') onProgress?.('规则评估', `命中 ${decision.rule.id}，交由 AI 复核`);
      const options = onProgress ? { mode, onProgress, ruleEvaluation: decision } : { mode, ruleEvaluation: decision };
      const result = await executor.run(alertId, options);
      // 记录侧不写错误原文（P003-T054，与 `triage-monitor.js` 的 `result.rule_evaluation` 同口径）：
      // 这份副本会随 `result` 进案件 `result.json` 与研判记录，所以 `reason` 过闸；
      // 回灌模型的那份（上面 `options.ruleEvaluation`）仍是原文——模型靠它认出配置 / 网络错在哪。
      result.rule_evaluation = decision.reason == null ? decision
        : { ...decision, reason: reasonForRecord(decision.reason) };
      return result;
    }
    return executor.run(alertId, onProgress ? { mode, onProgress } : { mode });
  };
  // 本进程里正在跑维护的告警：重复登记靠它挡，不靠记录上的 maintenance.status——进程重启后记录会停在 updating，
  // 拿那个当日志会把这个案件永久锁死在 updating。
  const runningMaintenance = new Set();
  // 误报统一维护 Agent（P003-T047）：注入了就用注入的（单测/探针换替身），否则用本次注入的两条腿装一个。
  // 两条腿都没有（规则维护者与 wiki 维护端都未配置）时保持 null：那一轮维护两侧都记 failed + 原因，不去猜。
  const fpAgent = fpMaintainer || (ruleMaintainer || wikiAgent
    ? new FalsePositiveMaintainer({ model: fpDecision, ruleMaintainer, ruleStore, wiki, wikiAgent, sessions: fpSessions })
    : null);
  // 数据管理（P003-T044）的路径来源：全部是本次注入的构件，换替身就是换盘点对象。
  const updateStore = prompts?.filename ? new UpdateStore(prompts) : null;
  const dataDeps = { history, monitor, boardService, wikiAgent, config, fpSessions, ruleSessions, ruleStore,
    wiki, prompts, updateStore };
  // 审计流（P003-T062）：append-only，落 `<数据根>/audit/`，独立于技术日志的轮转与清理。
  // 落点跟随注入的 config.file 所在目录（生产＝数据根，与 config-overrides.json 同根；测试注入 tmp
  // 覆盖层文件时审计跟着进 tmp——全局根零痕迹的守卫罩因此不被审计写穿）。记账点在各写路由。
  const auditRoot = config?.file ? path.dirname(config.file) : dataRoot();
  const auditStore = new AuditStore(path.join(auditRoot, 'audit'));
  const auditor = createAuditor(auditStore, { currentRequestContext });
  // T072：每个请求进 ALS 上下文——request_id 生成一次，处理期间所有 log() 自动带上它；
  // http.request 行再显式带 user（无登录态写 null，不省键）。
  return http.createServer((req, res) => runWithRequestContext({ request_id: randomUUID(), user: null },
    () => handle(req, res)));
  async function handle(req, res) {
    const startedAt = Date.now();
    // 只记方法与路径（query 一律不记：可能带令牌），请求头一个字段都不碰——Authorization / Cookie 不进日志（A4）。
    const route = String(req.url || '').split('?')[0];
    res.on('finish', () => log('http.request', { method: req.method, path: route, status: res.statusCode,
      duration_ms: Date.now() - startedAt, user: currentRequestContext()?.user ?? null }));
    if (!hasAccess(req, access)) {
      log('http.unauthorized', { method: req.method, path: route, status: 401 }, 'warn');
      return sendUnauthorized(res);
    }
    // T072：身份进了上下文——这条请求后续所有日志行自动带 user（无登录态保持 null）。
    if (access?.password) currentRequestContext().user = access.user || 'admin';
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/session' && req.method === 'GET') {
        // B17：业务 Basic 账号是值守操作员（role 固定 operator）；管理员是维护端令牌那条线，不在这套身份里。
        // 未配置 HIDS_BASIC_AUTH_PASSWORD 时任何人可进，没有账号可报，user / role 都回 null。
        return json(res, 200, access?.password
          ? { authenticated: true, user: access.user || 'admin', role: 'operator' }
          : { authenticated: true, user: null, role: null });
      }
      if (url.pathname === '/api/updates' && req.method === 'GET') return json(res, 200, await updateStore.overview());
      // 生效值一览（P003-T025）：地址、端口、研判输入模式、牧云与模型配了没有、模型名。
      // 机密只给有/没有——本路由的响应体里不出现任何 Token 与密码原文（A3）。
      // 读的是注入的 store 的 env（缺省就是 process.env）：写配置盖进的覆盖层立刻反映在这里（P003-T029 A1）。
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configSummary(config.env));
      // 写配置（P003-T029）：运行中改牧云与模型五项，落盘后重启仍生效（store 建时读回覆盖层）。
      // 顺序＝先校验、再落盘、再改 env（config.update 内部），最后原地换活着的客户端值。
      // 响应只回「改了哪几个键 + 生效摘要」：机密永远只以布尔出现（A2）。
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const patch = await readJSON(req);
        const beforeValues = config.values();
        const updated = await config.update(patch);
        applyLiveConfig({ gateway, models, agentToolbox }, config.values());
        // 审计（P003-T062）：记改了哪些键 + 新旧值（机密值只记「已改」）+ 来源（覆盖文件 or 环境变量兜底）。
        const overridden = Object.keys(configStore.overrides());
        void auditor({ actor: actorOf({ access }), action: 'config.write',
          object: { kind: 'config', keys: updated,
            source: Object.fromEntries(updated.map(key => [key, overridden.includes(key) ? 'override-file' : 'env'])) },
          ...configAuditValues(beforeValues, patch) });
        return json(res, 200, { updated, config: configSummary(config.env) });
      }
      // 数据管理（P003-T044）：盘点七类运行态的条数与字节；清理按类型与阈值归档或删除（默认 dry-run）。
      // 两个路径不碰上游、不碰模型，只读本地运行态目录；清理的 409（还有案件在排/在跑）由 causeError 原样回。
      if (url.pathname === '/api/data/inventory' && req.method === 'GET')
        return json(res, 200, await dataInventory(dataDeps));
      if (url.pathname === '/api/data/cleanup' && req.method === 'POST') {
        try {
          const outcome = await dataCleanup(dataDeps, await readJSON(req));
          // 审计（P003-T062）：只有真执行（非 dry-run）算写；dry-run 是盘点语义，不记账。
          if (!outcome.dry_run) void auditor({ actor: actorOf({ access }), action: 'data.cleanup',
            object: { kind: outcome.kind, action: outcome.action, count: outcome.applied.count, bytes: outcome.applied.bytes } });
          return json(res, 200, outcome);
        }
        catch (cause) { return causeError(res, cause, 'internal'); }
      }
      // 日志（P003-T045）：查询读的是盘上的文件（当前活动文件 + 轮转出的历史文件），不是进程内存；
      // 没配 HIDS_LOG_FILE 就没文件可读可清——503 点明缺哪个键，不拿「空列表」冒充。
      // 两个路由和 /api/config 一样只碰本地文件：不探上游、不碰模型；Basic 认证闸门照旧过。
      if (url.pathname === '/api/logs' && req.method === 'GET') {
        if (!logFile) return configError(res, '日志未落盘：未配置 HIDS_LOG_FILE');
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
          return callerError(res, '分页参数无效');
        const filters = logQuery(url.searchParams);
        if (filters.error) return callerError(res, filters.error);
        return json(res, 200, { ...readLogEntries({ file: logFile, count, offset, ...filters.filters }),
          echo: { count, offset } });
      }
      if (url.pathname === '/api/logs/cleanup' && req.method === 'POST') {
        if (!logFile) return configError(res, '日志未落盘：未配置 HIDS_LOG_FILE');
        try {
          const body = await readJSON(req);
          const outcome = logCleanup(logFile, body);
          if (outcome.dry_run === false) void auditor({ actor: actorOf({ access }), action: 'logs.cleanup',
            object: { count: outcome.applied.count, bytes: outcome.applied.bytes } });
          return json(res, 200, outcome);
        }
        catch (cause) { return causeError(res, cause, 'internal'); }
      }
      // 审计查询（P003-T062）：读 append-only 审计流；筛选与分页口径与 /api/logs 一致。
      if (url.pathname === '/api/audit' && req.method === 'GET') {
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
          return callerError(res, '分页参数无效');
        const from = url.searchParams.get('from')?.trim();
        const to = url.searchParams.get('to')?.trim();
        const fromTime = from ? parseInstant(from) : null;
        const toTime = to ? parseInstant(to) : null;
        if (from && !fromTime) return callerError(res, `筛选起始时间无效：${from}`);
        if (to && !toTime) return callerError(res, `筛选结束时间无效：${to}`);
        const result = url.searchParams.get('result')?.trim();
        if (result && !['ok', 'denied', 'error'].includes(result)) return callerError(res, '筛选结果无效：result 只能是 ok、denied、error');
        return json(res, 200, { ...await auditStore.query({ from: fromTime, to: toTime,
          actor: url.searchParams.get('actor')?.trim() || null,
          action: url.searchParams.get('action')?.trim() || null,
          object: url.searchParams.get('object')?.trim() || null,
          result: result || null, count, offset }),
          echo: { count, offset } });
      }
      // 字典（P003-T059 A09）：事件类型 / 等级 / 结论 / 案件状态四张表，全部取自代码唯一真源
      // （shared/vocabulary + triage 领域词表）——这里不做第二份对照表，前端不再硬编码。
      if (url.pathname === '/api/dict' && req.method === 'GET') {
        return json(res, 200, {
          event_types: Object.entries(eventTypes).map(([key, label]) => ({ key, label })),
          levels: Object.entries(levelNames).map(([rank, [label, key]]) => ({ key, rank: Number(rank), label })),
          verdicts: VERDICT_KEYS.map(key => ({ key, label: VERDICT_LABELS[key] })),
          triage_statuses: TRIAGE_STATUSES
        });
      }

  const recordTypeLocal = record => {
  if (record.input?.parsed?.msgid) return eventTypeFor(record.input.parsed.msgid) || '';
  const text = String(record.alert_id || '');
  const at = text.indexOf(':');
  return at > 0 ? text.slice(0, at) : '';
};

  // ── 批量操作（P003-T069 A07）：部分失败如实汇总，不整体回滚 ──────────────────
  const batchMatch = url.pathname.match(/^\/api\/batch\/(enqueue|false-positive|dispose)$/);
  if (batchMatch && req.method === 'POST') {
    const action = batchMatch[1];
    const body = await readJSON(req, 200000);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return callerError(res, '请求正文无效');
    const ids = body.alert_ids;
    if (!Array.isArray(ids) || !ids.length) return callerError(res, 'alert_ids 必须是非空数组');
    if (ids.length > 100) return callerError(res, '单次批量上限 100 条');
    if (ids.some(id => typeof id !== 'string' || !validTriageId(id))) return callerError(res, 'alert_ids 含无效告警 ID');
    if (action === 'false-positive') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 10 || reason.length > 4000) return callerError(res, '误报理由必须为 10 到 4000 字');
    }
    if (action === 'dispose' && !['confirmed_threat', 'dismissed', 'escalated', 'parked'].includes(String(body.disposition || 'dismissed')))
      return callerError(res, '处置位无效');
    if (!monitor) return configError(res, '自动研判尚未配置');
    const accepted = [], rejected = [];
    for (const alertId of [...new Set(ids)]) {
      try {
        if (action === 'enqueue') {
          await monitor.enqueue(alertId, { retry: true });
          accepted.push(alertId);
        } else if (action === 'false-positive') {
          const record = monitor.records.get(alertId);
          if (!record) throw Object.assign(new Error('找不到这条研判案件'), { status: 404 });
          if (record.status !== 'done') throw Object.assign(new Error('研判还没结束，不能登记误报'), { status: 409 });
          if (runningMaintenance.has(alertId)) { accepted.push(alertId); continue; }
          const at = new Date().toISOString();
          const reason = String(body.reason).trim();
          const who = String(body.who ?? access?.user ?? 'operator').trim().replace(/\s+/g, ' ').slice(0, 100);
          record.verdict = 'false_positive'; record.verdict_label = '误报'; record.decision_source = 'human';
          record.feedback = { reason, who, recorded_at: at };
          record.detail = `人工登记误报（${who}）：${reason}`.slice(0, 250);
          record.maintenance = { status: 'updating', updated_at: at,
            rule: { status: 'updating', at }, wiki: { status: 'updating', at }, libraries: FP_LIBRARIES };
          record.updated_at = at;
          await monitor.persist?.();
          runningMaintenance.add(alertId);
          void maintainFalsePositive({ monitor, record, maintainer: fpAgent, libraries: FP_LIBRARIES,
            previous: null }).finally(() => runningMaintenance.delete(alertId));
          void auditor({ actor: actorOf({ access }), action: 'false-positive.register',
            object: { kind: 'case', alert_id: alertId, batch: true } });
          accepted.push(alertId);
        } else {
          const record = monitor.records.get(alertId);
          if (!record) throw Object.assign(new Error('没有这条研判记录'), { status: 404 });
          const disposition = String(body.disposition || 'dismissed');
          if (record.disposition && record.disposition !== 'not_disposed')
            throw Object.assign(new Error('该案件已有处置位，不能重复处置'), { status: 409 });
          record.disposition = disposition;
          record.disposition_at = new Date().toISOString();
          record.updated_at = record.disposition_at;
          await monitor.persist?.();
          void auditor({ actor: actorOf({ access }), action: 'case.dispose',
            object: { kind: 'case', alert_id: alertId, disposition, batch: true } });
          accepted.push(alertId);
        }
      } catch (cause) {
        rejected.push({ id: alertId, reason: scrubCredentials(cause?.message || cause).slice(0, 200) });
      }
    }
    return json(res, 200, { action, accepted, rejected });
  }

  // ── 原始载荷与关联告警（P003-T068 A14/A15）──────────────────────────────────
  const rawPayload = url.pathname.match(/^\/api\/agent\/triage\/([^/]+)\/raw$/);
  if (rawPayload && req.method === 'GET') {
    if (!monitor) return configError(res, '自动研判尚未配置');
    let alertId;
    try { alertId = decodeURIComponent(rawPayload[1]); }
    catch { return callerError(res, '告警 ID 编码无效'); }
    const record = monitor.records.get(alertId);
    if (!record?.input) return callerError(res, '该告警没有原始报文', 404);
    const count = Number(url.searchParams.get('count') || 50);
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(count) || count < 1 || count > 200 || !Number.isSafeInteger(offset) || offset < 0)
      return callerError(res, '分页参数无效');
    const entries = Object.entries(record.input.parsed?.payload || {});
    const page = entries.slice(offset, offset + count).map(([key, value]) => ({
      key, value: /token|password|secret|api[-_]?key|cookie|authorization/i.test(key) ? '[redacted]'
        : (typeof value === 'string' ? value.slice(0, 4000) : value) }));
    return json(res, 200, { alert_id: alertId, raw: String(record.input.raw || '').slice(0, 60000),
      msgid: record.input.parsed?.msgid ?? null, payload_total: entries.length, payload: page,
      echo: { count, offset }, truncated: offset + count < entries.length });
  }
  if (url.pathname === '/api/cases/related' && req.method === 'GET') {
    if (!monitor) return configError(res, '自动研判尚未配置');
    const host = url.searchParams.get('host')?.trim() || null;
    const sourceIp = url.searchParams.get('source_ip')?.trim() || null;
    if (!host && !sourceIp) return callerError(res, '至少给一个筛选条件：host 或 source_ip');
    const count = Number(url.searchParams.get('count') || 20);
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
      return callerError(res, '分页参数无效');
    const matched = [];
    for (const record of monitor.records.values()) {
      const payload = record.input?.parsed?.payload || {};
      if (host && payload.host_ip !== host) continue;
      if (sourceIp && payload.source_ip !== sourceIp && payload.login_ip !== sourceIp) continue;
      matched.push({ alert_id: record.alert_id, status: record.status, verdict: record.verdict ?? null,
        created_at: record.created_at, host_ip: payload.host_ip ?? null,
        source_ip: payload.source_ip ?? payload.login_ip ?? null });
    }
    matched.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return json(res, 200, { filters: { host, source_ip: sourceIp }, total: matched.length,
      items: matched.slice(offset, offset + count) });
  }

// ── 聚合统计（P003-T064 A05）：存储侧全量计算，绕过 /api/alerts 的 500 条扫描上限 ──
  // 误报率分母 = 有结论的 done 案件（review 不算——还没研判完）；分子 = false_positive。
  // MTTR = done 案件 created_at→saved_at 的中位数（不入库的时间戳对，秒级精度，无结论案件不计）。
  if (url.pathname === '/api/stats/trend' && req.method === 'GET') {
    if (!monitor) return configError(res, '自动研判尚未配置');
    const bucket = url.searchParams.get('bucket') || 'day';
    if (!['hour', 'day'].includes(bucket)) return callerError(res, 'bucket 只能是 hour 或 day');
    const days = Number(url.searchParams.get('days') || 7);
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) return callerError(res, 'days 必须是 1 到 90');
    const since = Date.now() - days * 86400000;
    const buckets = {};
    for (const record of monitor.records.values()) {
      const at = Date.parse(record.created_at || '');
      if (!Number.isFinite(at) || at < since) continue;
      const d = new Date(at);
      const key = bucket === 'hour'
        ? `${d.toISOString().slice(0, 13)}:00:00Z` : d.toISOString().slice(0, 10);
      buckets[key] = (buckets[key] || 0) + 1;
    }
    return json(res, 200, { bucket, days, buckets: Object.fromEntries(Object.entries(buckets).sort()) });
  }
  if (url.pathname === '/api/stats/top' && req.method === 'GET') {
    if (!monitor) return configError(res, '自动研判尚未配置');
    const dimension = url.searchParams.get('dimension') || 'host_ip';
    const limit = Number(url.searchParams.get('limit') || 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return callerError(res, 'limit 必须是 1 到 100');
    const counts = {};
    for (const record of monitor.records.values()) {
      let value = null;
      if (dimension === 'host_ip') value = record.input?.parsed?.payload?.host_ip || null;
      else if (dimension === 'source_ip') value = record.input?.parsed?.payload?.source_ip || record.input?.parsed?.payload?.login_ip || null;
      else if (dimension === 'event_type') value = recordTypeLocal(record) || null;
      else if (dimension === 'user') value = record.input?.parsed?.payload?.user_name || record.input?.parsed?.payload?.login_username || null;
      else return callerError(res, 'dimension 只能是 host_ip、source_ip、event_type、user');
      if (!value) continue;
      counts[value] = (counts[value] || 0) + 1;
    }
    const top = Object.entries(counts).map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count).slice(0, limit);
    return json(res, 200, { dimension, limit, top });
  }
  if (url.pathname === '/api/stats/summary' && req.method === 'GET') {
    if (!monitor) return configError(res, '自动研判尚未配置');
    let concluded = 0, falsePositives = 0;
    const durations = [];
    for (const record of monitor.records.values()) {
      if (record.status !== 'done' || !record.verdict) continue;
      concluded += 1;
      if (record.verdict === 'false_positive') falsePositives += 1;
      const from = Date.parse(record.created_at || '');
      const to = Date.parse(record.saved_at || '');
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) durations.push(to - from);
    }
    durations.sort((a, b) => a - b);
    const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    return json(res, 200, {
      concluded_total: concluded,
      false_positive_total: falsePositives,
      false_positive_rate: concluded ? falsePositives / concluded : null,
      mttr_ms_median: median,
      mttr_samples: durations.length
    });
  }

  // ── 导出（P003-T065 A06）：CSV/JSON 附件下载，只读不写 ──────────────────────
  const exportMatch = url.pathname.match(/^\/api\/export\/([a-z_]+)$/);
  if (exportMatch && req.method === 'GET') {
    const dataset = exportMatch[1];
    const format = url.searchParams.get('format') || 'csv';
    if (!['alerts', 'cases', 'logs', 'boards'].includes(dataset)) return callerError(res, 'dataset 只能是 alerts、cases、logs、boards');
    if (!['csv', 'json'].includes(format)) return callerError(res, 'format 只能是 csv 或 json');
    let rows;
    if (dataset === 'alerts') {
      if (!service) return configError(res, '未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN');
      rows = (await viaCloudwalker('alerts', null, () => service.alerts({ count: 50, offset: 0 }))).alerts;
    } else if (dataset === 'cases') {
      if (!monitor) return configError(res, '自动研判尚未配置');
      rows = monitor.cases({ count: 50 }).cases;
    } else if (dataset === 'logs') {
      if (!logFile) return configError(res, '日志未落盘：未配置 HIDS_LOG_FILE');
      rows = readLogEntries({ file: logFile, count: 1000 }).logs;
    } else {
      if (!boardService) return configError(res, '深度溯源模型或牧云 MCP 尚未配置');
      rows = await boardService.list(50);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="hids-${dataset}-${stamp}.json"`, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(rows, null, 2));
      return;
    }
    // CSV：统一取并集表头（行间字段可能不同），BOM 让 Excel 识别 UTF-8
    const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = String.fromCharCode(0xFEFF) + headers.join(',') + '\n' +
      rows.map(row => headers.map(header => cell(row[header])).join(',')).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hids-${dataset}-${stamp}.csv"`, 'Cache-Control': 'no-store' });
    res.end(csv);
    return;
  }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!service) return json(res, 200, { configured: false, connected: false, reason: '请设置牧云地址和 API Token' });
        try { return json(res, 200, { configured: true, ...(await viaCloudwalker('status', null, () => service.status())) }); }
        // 配了但连不上：形状是契约（前端按 connected 判），构造只能走统一出口（error/code 并入统一模型）。
        catch (e) { return sendCloudwalkerStatusFailure(res, e.message); }
      }
      if (url.pathname === '/api/agent/tools' && req.method === 'GET') {
        if (!toolbox) return configError(res, '牧云 API 未配置');
        const tools = await viaCloudwalker('tools', null, () => toolbox.listTools());
        return json(res, 200, { provider: 'cloudwalker-api', readOnly: true, count: tools.length, tools });
      }
      if (url.pathname === '/api/trace/tools' && req.method === 'GET') {
        if (!agentToolbox) return configError(res, '牧云 MCP 未配置');
        const tools = await viaCloudwalker('mcp_tools', null, () => agentToolbox.listTools());
        return json(res, 200, { provider: 'cloudwalker-mcp', readOnly: true, count: tools.length, tools });
      }
      if (url.pathname === '/api/agent/status' && req.method === 'GET') {
        const activePrompts = await prompts.load();
        return json(res, 200, { configured: Boolean(investigator), model: investigator?.model?.model || null,
          missing: investigator ? [] : ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter(name => !process.env[name]),
          prompt_version: `${activePrompts.version}+${activePrompts.revision}` });
      }
      if (url.pathname === '/api/trace/boards' && req.method === 'GET') {
        if (!boardService) return configError(res, '深度溯源模型或牧云 MCP 尚未配置');
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
          return callerError(res, '分页参数无效');
        const parsed = traceQuery(url.searchParams);
        if (parsed.error) return callerError(res, parsed.error);
        return json(res, 200, await boardService.page({ count, offset, ...parsed.filters }));
      }
      if (url.pathname === '/api/trace/boards' && req.method === 'POST') {
        if (!boardService) return configError(res, '深度溯源模型或牧云 MCP 尚未配置');
        const body = await readJSON(req);
        const target = body?.target || body?.alert_id || body?.ip;
        if (!validTraceTarget(target)) return callerError(res, '请输入有效告警 ID 或 IPv4 地址');
        try {
          // 已有白板回 200（直接打开那条），新建才回 202（任务已启动）。
          const started = boardService.startOrResume ? await boardService.startOrResume(target, body.focus)
            : { created: true, board: await boardService.start(target, body.focus) };
          if (started.created) void auditor({ actor: actorOf({ access }), action: 'trace.start',
            object: { kind: 'board', target } });
          return json(res, started.created ? 202 : 200, started.board);
        } catch (cause) { return causeError(res, cause, 'upstream'); }
      }
      if (url.pathname.startsWith('/api/trace/boards/') && req.method === 'GET') {
        if (!boardService) return configError(res, '深度溯源模型或牧云 MCP 尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/trace/boards/'.length)); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        if (!validTraceTarget(alertId)) return callerError(res, '告警 ID 或 IP 无效');
        const board = await boardService.get(alertId);
        return board ? json(res, 200, board) : callerError(res, '该告警尚无溯源白板', 404);
      }
      if (url.pathname === '/api/agent/triage/status' && req.method === 'GET') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        // 总览聚合的时间起点：与 /api/alerts、/api/agent/triage/cases 同一套时间解析，非法值回 400。
        const rawSince = url.searchParams.get('since')?.trim();
        const since = rawSince ? parseInstant(rawSince) : null;
        if (rawSince && !since) return callerError(res, `筛选起始时间无效：${rawSince}`);
        return json(res, 200, monitor.summary({ since }));
      }
      if (url.pathname === '/api/triage/rules' && req.method === 'GET') {
        try { return json(res, 200, { ...await (monitor?.ruleEngine || triageRules).readConfig(),
          writable: Boolean(ruleAdminToken) }); }
        catch (cause) { return upstreamError(res, `规则配置读取失败：${cause.message}`); }
      }
      if (url.pathname === '/api/triage/rules/validate' && req.method === 'POST') {
        try {
          const body = await readJSON(req, 100000);
          // 先判正文形状再读 config.rules：正文可能是 null / 数组 / 缺 config，直接读会抛 TypeError
          // 并把英文内部文案回给调用方。
          if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'config'))
            return callerError(res, '请求正文缺少 config');
          return json(res, 200, { valid: true, count: validateRuleSet(body.config).rules.length });
        } catch (cause) { return callerError(res, cause.message); }
      }
      if (url.pathname === '/api/triage/rules' && req.method === 'PUT') {
        if (!ruleAdminToken) return configError(res, '尚未配置规则管理员令牌');
        if (!hasRuleAdminAccess(req, ruleAdminToken)) {
          void auditor({ actor: actorOf({ access }), action: 'triage-rules.write',
            object: { kind: 'triage_rules' }, result: 'denied' });
          return callerError(res, '规则管理员令牌无效', 403);
        }
        try {
          const body = await readJSON(req, 100000);
          if (!body || !Object.hasOwn(body, 'expected_revision') ||
            !(body.expected_revision === null || /^[0-9a-f]{16}$/.test(body.expected_revision)))
            return callerError(res, '缺少有效的规则配置版本');
          const saved = await (monitor?.ruleEngine || triageRules)
            .saveConfig(body.config, body.expected_revision);
          void auditor({ actor: actorOf({ access, tokenKind: 'rule-admin' }), action: 'triage-rules.write',
            object: { kind: 'triage_rules' } });
          return json(res, 200, saved);
        } catch (cause) { return causeError(res, cause, 'internal'); }
      }
      // ── JSON 前置规则集历史与回滚（P003-T086 A3）────────────────────────────
      if (url.pathname === '/api/triage/rules/history' && req.method === 'GET') {
        try { return json(res, 200, { history: await triageRules.history() }); }
        catch (cause) { return upstreamError(res, `规则集历史读取失败：${cause.message}`); }
      }
      const triageRuleRevision = url.pathname.match(/^\/api\/triage\/rules\/history\/([0-9a-f]{16})$/);
      if (triageRuleRevision && req.method === 'GET') {
        try {
          const revision = await triageRules.readRevision(triageRuleRevision[1]);
          return revision ? json(res, 200, revision) : callerError(res, '规则集历史版本不存在', 404);
        } catch (cause) { return upstreamError(res, `规则集历史读取失败：${cause.message}`); }
      }
      if (url.pathname === '/api/triage/rules/rollback' && req.method === 'POST') {
        if (!ruleAdminToken) return configError(res, '尚未配置规则管理员令牌');
        if (!hasRuleAdminAccess(req, ruleAdminToken)) return callerError(res, '规则管理员令牌无效', 403);
        const body = await readJSON(req);
        const rev = typeof body?.rev === 'string' ? body.rev.trim() : '';
        if (!/^[0-9a-f]{16}$/.test(rev)) return callerError(res, '缺少有效的目标版本 rev');
        const who = String(body.who ?? access?.user ?? 'operator').trim().replace(/\s+/g, ' ').slice(0, 100);
        try {
          const rolled = await triageRules.rollback(rev, { note: `人工回滚（${who}）` });
          void auditor({ actor: actorOf({ access, tokenKind: 'rule-admin' }), action: 'triage-rules.write',
            object: { kind: 'triage_rules', action: 'rollback', rev } });
          return json(res, 200, rolled);
        } catch (cause) { return causeError(res, cause, 'internal'); }
      }
      // ── 规则命中统计（P003-T086 A4）：按规则 id 汇总命中过的告警与次数 ─────────
      if (url.pathname === '/api/rules/hits' && req.method === 'GET') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        const byRule = {};
        for (const record of monitor.records.values()) {
          const ruleId = record.rule_id;
          if (!ruleId) continue;
          const entry = byRule[ruleId] || { rule_id: ruleId, hits: 0, alerts: [], first_at: null, last_at: null };
          entry.hits += 1;
          if (entry.alerts.length < 20) entry.alerts.push(record.alert_id);
          const at = record.created_at || null;
          if (at && (!entry.first_at || at < entry.first_at)) entry.first_at = at;
          if (at && (!entry.last_at || at > entry.last_at)) entry.last_at = at;
          byRule[ruleId] = entry;
        }
        const rules = Object.values(byRule).sort((a, b) => b.hits - a.hits);
        return json(res, 200, { total_rules: rules.length, rules });
      }
      if (url.pathname === '/api/rules' && req.method === 'GET') {
        try { return json(res, 200, await ruleStore.list()); }
        catch (cause) { return upstreamError(res, `规则库读取失败：${cause.message}`); }
      }
      // 规则维护接口（P003-T041 A5）。读开放、写要规则管理员令牌，与 `PUT /api/triage/rules` 同一道闸。
      // `sessions` 必须排在 `/api/rules/{id}` 之前：`sessions` 本身是合法规则 id 形状，排后面会被当成规则读。
      if (url.pathname === '/api/rules/sessions' && req.method === 'GET') {
        try { return json(res, 200, { sessions: await ruleSessions.list() }); }
        catch (cause) { return upstreamError(res, `规则维护会话读取失败：${cause.message}`); }
      }
      // T070 A11：规则维护会话详情——rationale/validation/result/error 全文（列表只有摘要）。
      const ruleSession = url.pathname.match(/^\/api\/rules\/sessions\/([0-9a-f-]{36})$/i);
      if (ruleSession && req.method === 'GET') {
        try {
          const session = await ruleSessions.get(ruleSession[1]);
          return session ? json(res, 200, session) : callerError(res, '规则维护会话不存在', 404);
        } catch (cause) { return upstreamError(res, `规则维护会话读取失败：${cause.message}`); }
      }
      // 误报维护会话（P003-T047 A1）：一个案件一份多轮会话，落数据根下的 `fp-sessions/`。
      // 读开放（与 `/api/rules/sessions` 同口径）；写只有误报入口一条路，这里只提供查询。
      if (url.pathname === '/api/false-positive/sessions' && req.method === 'GET') {
        try { return json(res, 200, { sessions: await fpSessions.list() }); }
        catch (cause) { return upstreamError(res, `误报维护会话读取失败：${cause.message}`); }
      }
      if (url.pathname.startsWith('/api/false-positive/sessions/') && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(url.pathname.slice('/api/false-positive/sessions/'.length)); }
        catch { return callerError(res, '维护会话 ID 编码无效'); }
        if (!/^[0-9a-f-]{36}$/i.test(id)) return callerError(res, '维护会话 ID 无效');
        let record;
        try { record = await fpSessions.get(id); }
        catch (cause) { return upstreamError(res, `误报维护会话读取失败：${cause.message}`); }
        if (!record) return callerError(res, '维护会话不存在', 404);
        return json(res, 200, record);
      }
      if (url.pathname === '/api/rules/evaluate' && req.method === 'POST') {
        let fact;
        try { fact = await readJSON(req); } catch (cause) { return callerError(res, cause.message); }
        if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) return callerError(res, '告警事实必须是 JSON 对象');
        try { return json(res, 200, await ruleStore.evaluate(fact)); }
        catch (cause) { return upstreamError(res, `规则求值失败：${cause.message}`); }
      }
      const ruleMaintenance = url.pathname.match(/^\/api\/rules\/([^/]+)\/(history|rollback)$/);
      if (ruleMaintenance) {
        let id;
        try { id = decodeURIComponent(ruleMaintenance[1]); }
        catch { return callerError(res, '规则 id 编码无效'); }
        if (!isRuleId(id)) return callerError(res, '规则 id 无效');
        if (ruleMaintenance[2] === 'history' && req.method === 'GET') {
          try { return json(res, 200, { id, history: await ruleStore.history(id) }); }
          catch (cause) { return upstreamError(res, `规则历史读取失败：${cause.message}`); }
        }
        if (ruleMaintenance[2] === 'history' && req.method === 'GET') {
          // T070 A12：历史某版正文——历史已经落盘（rules-history/<id>-<rev>.rego），补读的路由。
          const rev = url.searchParams.get('rev');
          if (!rev || !/^[0-9a-f]{16}$/.test(rev)) return callerError(res, '缺少有效的目标版本 rev');
          try {
            const revision = await ruleStore.readRevision(id, rev);
            return revision ? json(res, 200, revision) : callerError(res, `规则历史版本不存在：${id}-${rev}`, 404);
          } catch (cause) { return upstreamError(res, `规则历史读取失败：${cause.message}`); }
        }
        if (ruleMaintenance[2] === 'rollback' && req.method === 'POST') {
          if (!ruleAdminToken) return configError(res, '尚未配置规则管理员令牌');
          if (!hasRuleAdminAccess(req, ruleAdminToken)) {
            void auditor({ actor: actorOf({ access }), action: 'rule.rollback',
              object: { kind: 'rule', id }, result: 'denied' });
            return callerError(res, '规则管理员令牌无效', 403);
          }
          const body = await readJSON(req, 20000);
          const rev = typeof body?.rev === 'string' ? body.rev.trim() : '';
          if (!/^[0-9a-f]{16}$/.test(rev)) return callerError(res, '缺少有效的目标版本 rev');
          const who = String(body.who ?? access?.user ?? 'operator').trim().replace(/\s+/g, ' ').slice(0, 100);
          try {
            const rolled = await ruleStore.rollback(id, rev, { note: `人工回滚（${who}）` });
            void auditor({ actor: actorOf({ access, tokenKind: 'rule-admin' }), action: 'rule.rollback',
              object: { kind: 'rule', id, rev } });
            return json(res, 200, rolled);
          } catch (cause) { return causeError(res, cause, 'internal'); }
        }
      }
      if (url.pathname.startsWith('/api/rules/') && req.method === 'PUT') {
        if (!ruleAdminToken) return configError(res, '尚未配置规则管理员令牌');
        if (!hasRuleAdminAccess(req, ruleAdminToken)) {
          void auditor({ actor: actorOf({ access }), action: 'rule.write',
            object: { kind: 'rule' }, result: 'denied' });
          return callerError(res, '规则管理员令牌无效', 403);
        }
        let id;
        try { id = decodeURIComponent(url.pathname.slice('/api/rules/'.length)); }
        catch { return callerError(res, '规则 id 编码无效'); }
        if (!isRuleId(id)) return callerError(res, '规则 id 无效');
        const body = await readJSON(req, 200000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return callerError(res, '请求正文无效');
        if (typeof body.rego !== 'string' || !body.rego.trim()) return callerError(res, '请求正文缺少规则正文 rego');
        // 乐观并发（与 wiki 页面、triage 规则集同一口径）：改了别处就 409，别让后写的悄悄盖掉前一份。
        const expected = body.expected_revision;
        if (!Object.hasOwn(body, 'expected_revision') ||
          !(expected === null || (typeof expected === 'string' && /^[0-9a-f]{16}$/.test(expected))))
          return callerError(res, '缺少有效的规则版本 expected_revision');
        try {
          // 备注进被替换那一版的历史条目（`<id>-<rev>.json`）：传什么就记什么，不静默丢掉。
          const note = typeof body.note === 'string' && body.note.trim()
            ? `人工维护：${body.note.trim().replace(/\s+/g, ' ').slice(0, 200)}` : '人工维护';
          // 版本比对在 `RuleStore` 的写队列里做（与 `WikiStore.update()` 同一口径）：读—比对—写不可分割，
          // 并发两个 PUT 只有一个能落盘，后到的拿 409，不会悄悄盖掉前一份。
          const saved = await ruleStore.save(id, body.rego, { note, expectedRevision: expected });
          void auditor({ actor: actorOf({ access, tokenKind: 'rule-admin' }), action: 'rule.write',
            object: { kind: 'rule', id, rev: saved.rev, action: saved.action } });
          return json(res, 200, saved);
        } catch (cause) { return causeError(res, cause, 'internal'); }
      }
      if (url.pathname.startsWith('/api/rules/') && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(url.pathname.slice('/api/rules/'.length)); }
        catch { return callerError(res, '规则 id 编码无效'); }
        if (!isRuleId(id)) return callerError(res, '规则 id 无效');
        try {
          const rule = await ruleStore.read(id);
          return rule ? json(res, 200, rule) : callerError(res, '规则不存在', 404);
        } catch (cause) { return upstreamError(res, `规则库读取失败：${cause.message}`); }
      }
      if (url.pathname === '/api/agent/triage/cases' && req.method === 'GET') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
          return callerError(res, '分页参数无效');
        const parsed = caseQuery(url.searchParams);
        if (parsed.error) return callerError(res, parsed.error);
        return json(res, 200, monitor.cases({ count, offset, ...parsed.filters }));
      }
      if (url.pathname === '/api/agent/triage/control' && req.method === 'PUT') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return callerError(res, '请求正文无效');
        try {
          const summary = await monitor.setEnabled(body.enabled);
          void auditor({ actor: actorOf({ access }), action: 'triage.control',
            object: { kind: 'triage_queue', enabled: body.enabled === true } });
          return json(res, 200, summary);
        } catch (cause) { return causeError(res, cause, 'internal'); }
      }
      const falsePositive = url.pathname.match(/^\/api\/agent\/triage\/(.+)\/false-positive$/);
      if (falsePositive && req.method === 'POST') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(falsePositive[1]); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        if (!validTriageId(alertId)) return callerError(res, '告警 ID 无效');
        const body = await readJSON(req, 12000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return callerError(res, '请求正文无效');
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 10 || reason.length > 4000) return callerError(res, '误报理由必须为 10 到 4000 字');
        const who = String(body.who ?? access?.user ?? 'operator').trim().replace(/\s+/g, ' ').slice(0, 100);
        if (who.length < 2) return callerError(res, '误报登记人至少 2 个字');
        // A4：可选 `libraries`——单腿补跑（只重跑失败的那一侧）。不传就是两侧都试。
        // 契约（openapi 误报请求正文）是 `minItems:1 + uniqueItems:true`：重复项一律 400，不许静默去重——
        // 幂等键是 `case_id:库:版本`，重复库是调用方把一次维护说成了两次，悄悄吞掉会让它看不出自己写错了。
        let libraries = FP_LIBRARIES;
        if (body.libraries !== undefined) {
          if (!Array.isArray(body.libraries) || !body.libraries.length ||
              body.libraries.some(value => !FP_LIBRARIES.includes(value)))
            return callerError(res, '维护库必须是 rule 或 wiki 组成的一到两项');
          if (new Set(body.libraries).size !== body.libraries.length)
            return callerError(res, '维护库不能重复（libraries 每一项只能出现一次）');
          libraries = FP_LIBRARIES.filter(value => body.libraries.includes(value));
        }
        const record = monitor.records.get(alertId);
        if (!record) return callerError(res, '找不到这条研判案件', 404);
        if (record.status !== 'done') return callerError(res, '研判还没结束，不能登记误报', 409);
        // 同一轮维护还在本进程里跑：不再起第二轮，直接把当前进度回给调用方（重复点击不该让维护者跑两遍）。
        // 记录上的 maintenance.status 可能是重启前的残留，所以这重只看在跑的集合。
        if (runningMaintenance.has(alertId)) return json(res, 202, falsePositiveView(record));
        // A4 的补跑判据读的是**上一轮**的 maintenance：重置之前先留一份，
        // 这样「已成功的一侧」是这一条案件自己的历史（落盘在 triage-monitor.json 里，进程重启后还在）。
        const previousMaintenance = record.maintenance || null;
        // A1：先把结论与理由写死并落盘，再回 202——两个维护者还在排队时，这一条已经是误报。
        const at = new Date().toISOString();
        record.verdict = 'false_positive'; record.verdict_label = '误报'; record.decision_source = 'human';
        record.feedback = { reason, who, recorded_at: at };
        record.detail = `人工登记误报（${who}）：${reason}`.slice(0, 250);
        // 单腿补跑：没请求的那一侧不许把上一轮的 revision / 幂等键洗掉——它是下一次全量登记时
        // 「已成功的一侧不重复执行」唯一的判据载体（A4）。只换掉状态与理由，`kept` 原样保留。
        const untouchedSide = library => {
          const side = previousMaintenance?.[library] || {};
          const { status, state, why, error, at: previousAt, ...kept } = side;
          return { ...kept, status: 'updated', state: 'skipped', at,
            why: `本次只补跑 ${libraries.join('、')}：${library} 侧未执行` };
        };
        record.maintenance = { status: 'updating', updated_at: at,
          rule: libraries.includes('rule') ? { status: 'updating', at } : untouchedSide('rule'),
          wiki: libraries.includes('wiki') ? { status: 'updating', at } : untouchedSide('wiki'),
          libraries };
        record.updated_at = at;
        await monitor.persist?.();
        // 审计（P003-T062）：误报登记是人工结论写入，actor 与登记人一致；理由不进审计（进案件记录）。
        void auditor({ actor: actorOf({ access }), action: 'false-positive.register',
          object: { kind: 'case', alert_id: alertId, libraries } });
        // 后台跑两个维护者：失败只写 maintenance，不回滚 verdict；响应不等它们。
        runningMaintenance.add(alertId);
        void maintainFalsePositive({ monitor, record, maintainer: fpAgent, libraries,
          previous: previousMaintenance }).catch(cause => {
          record.maintenance.status = 'failed';
          record.maintenance.error = scrubCredentials(cause?.message || cause).slice(0, 300);
        }).finally(() => { runningMaintenance.delete(alertId);
          // 误报维护的结局只从这里出来：两侧各自的状态与原因都带上，别让人去翻数据根下的 triage-monitor.json。
          log('maintenance.result', { alert_id: alertId, status: record.maintenance.status,
            session_id: record.maintenance.session_id ?? null,
            sides: record.maintenance.sides ?? [],
            rule: record.maintenance.rule?.status ?? null, wiki: record.maintenance.wiki?.status ?? null,
            rule_state: record.maintenance.rule?.state ?? null, wiki_state: record.maintenance.wiki?.state ?? null,
            rule_error: record.maintenance.rule?.error ?? null, wiki_error: record.maintenance.wiki?.error ?? null });
        });
        return json(res, 202, falsePositiveView(record));
      }
      // 案卷材料清单（P003-T059 A02）：白名单文件 + 字节数 + mtime；目录里非白名单文件不列。
      // 必须排在下面 startsWith('/api/agent/triage/') 之前——那条会把它当告警 ID 吞掉（路由顺序语义，考古 §六.8）。
      const caseFiles = url.pathname.match(/^\/api\/agent\/triage\/([^/]+)\/case-files$/);
      if (caseFiles && req.method === 'GET') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(caseFiles[1]); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        if (!validTriageId(alertId)) return callerError(res, '告警 ID 无效');
        const info = monitor.status(alertId);
        if (!info?.case_dir) return callerError(res, '该告警没有案卷目录', 404);
        const files = [];
        for (const name of CASE_FILE_WHITELIST) {
          try {
            const statInfo = await stat(path.join(info.case_dir, name));
            files.push({ name, bytes: statInfo.size, mtime: statInfo.mtime.toISOString() });
          } catch { /* 白名单里但案卷还没写到的那份：不列 */ }
        }
        return json(res, 200, { alert_id: alertId, case_dir: info.case_dir, files });
      }
      const caseFile = url.pathname.match(/^\/api\/agent\/triage\/([^/]+)\/case-files\/(.+)$/);
      if (caseFile && req.method === 'GET') {
        if (!monitor) return configError(res, '自动研判尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(caseFile[1]); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        let name;
        try { name = decodeURIComponent(caseFile[2]); }
        catch { return callerError(res, '案卷文件名编码无效'); }
        if (!validTriageId(alertId)) return callerError(res, '告警 ID 无效');
        // 白名单精确匹配：../、绝对路径与 URL 编码变体（%2e%2e）解码后都不可能等于白名单名 → 400。
        if (!CASE_FILE_WHITELIST.includes(name)) return callerError(res, '案卷文件名不在白名单内');
        const info = monitor.status(alertId);
        if (!info?.case_dir) return callerError(res, '该告警没有案卷目录', 404);
        const location = path.join(info.case_dir, name);
        // 双保险：解析后必须仍在案卷目录内（防未来白名单误配）。
        if (!path.resolve(location).startsWith(path.resolve(info.case_dir) + path.sep))
          return callerError(res, '案卷路径越界');
        let content;
        try { content = await readFile(location, 'utf8'); }
        catch (cause) {
          if (cause.code === 'ENOENT') return callerError(res, '该案卷还没有这份材料', 404);
          throw cause;
        }
        const contentType = CASE_FILE_CONTENT_TYPES[path.extname(name)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(content);
        return;
      }
      if (url.pathname.startsWith('/api/agent/triage/')) {
        if (!monitor) return configError(res, '自动研判尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/agent/triage/'.length)); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        if (!validTriageId(alertId)) return callerError(res, '告警 ID 无效');
        if (req.method === 'GET') return json(res, 200, monitor.status(alertId) || { alert_id: alertId, status: 'not_queued', evidence: [] });
        if (req.method === 'POST') {
          const record = await monitor.enqueue(alertId, { retry: true });
          void auditor({ actor: actorOf({ access }), action: 'triage.enqueue',
            object: { kind: 'case', alert_id: alertId } });
          return json(res, 202, record);
        }
        // A9（P003-T036）：取消排队中的案件。404 没有记录、409 已在研判中，都走 causeError 的 caller 类。
        if (req.method === 'DELETE') {
          try {
            const cancelled = await monitor.cancel(alertId);
            void auditor({ actor: actorOf({ access }), action: 'triage.cancel',
              object: { kind: 'case', alert_id: alertId } });
            return json(res, 200, cancelled);
          } catch (cause) { return causeError(res, cause); }
        }
      }
      if (url.pathname === '/api/agent/prompts' && req.method === 'GET') {
        return json(res, 200, await prompts.metadata());
      }
      if (url.pathname === '/api/agent/prompts' && req.method !== 'GET') return callerError(res, '请使用提示词文件上传入口', 405);
      if (url.pathname === '/api/agent/prompts/upload') return callerError(res, '提示词更新已迁移到独立维护端，业务端不允许上传', 410);
      if (url.pathname.startsWith('/api/wiki/')) {
        if (url.pathname === '/api/wiki/pages' && req.method === 'GET') {
          // 分页只加不改（D002）：不带 count 时照旧返回全部，只有显式传 count 才切页；total 恒给出。
          const rawCount = url.searchParams.get('count');
          const count = rawCount ? Number(rawCount) : null;
          const offset = Number(url.searchParams.get('offset') || 0);
          if ((count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 50)) ||
            !Number.isSafeInteger(offset) || offset < 0) return callerError(res, '分页参数无效');
          const query = url.searchParams.get('q');
          const pages = query ? (await wiki.browse()).filter(page =>
            `${page.id} ${page.title} ${page.path}`.toLowerCase().includes(String(query).toLowerCase())).slice(0, 50)
            : await wiki.browse();
          return json(res, 200, { pages: count === null ? pages.slice(offset) : pages.slice(offset, offset + count), total: pages.length });
        }
        // 页面读写走控制台 Basic 账号（D003），因此排在下面的管理员令牌闸之前。
        const pagePath = wikiPagePath(url.pathname);
        if (pagePath?.invalidEncoding) return callerError(res, '知识库页面路径编码无效');
        if (pagePath && url.pathname === '/api/wiki/pages/' && req.method === 'PUT')
          return callerError(res, '请在路径里写明要修改的页面');
        if (pagePath && req.method === 'GET') {
          try { return json(res, 200, await wiki.get(pagePath.filename)); }
          catch (cause) { return causeError(res, cause, 'internal'); }
        }
        if (pagePath && req.method === 'PUT') {
          const body = await readJSON(req, 120000);
          if (!body || !Object.hasOwn(body, 'expected_revision') || !/^[0-9a-f]{16}$/.test(String(body.expected_revision)))
            return callerError(res, '缺少有效的页面版本，请刷新后重试');
          try {
            const page = await wiki.update(pagePath.filename, body.content, body.expected_revision,
              `通过控制台直接编辑（操作人 ${access?.user || 'admin'}）`);
            void auditor({ actor: actorOf({ access }), action: 'wiki.page.write',
              object: { kind: 'wiki_page', path: pagePath.filename } });
            return json(res, 200, page);
          } catch (cause) { return causeError(res, cause, 'internal'); }
        }
        if (!promptAdminToken) return configError(res, '尚未配置知识库管理员凭据');
        if (!hasPromptAdminAccess(req, promptAdminToken)) {
          void auditor({ actor: actorOf({ access }), action: 'wiki.maintain',
            object: { kind: 'wiki_session' }, result: 'denied' });
          return callerError(res, '知识库管理员凭据无效', 403);
        }
        if (url.pathname === '/api/wiki/health' && req.method === 'GET') return json(res, 200, await wiki.health());
        if (url.pathname === '/api/wiki/sessions' && req.method === 'GET') return json(res, 200, { sessions: await wikiAgent.list() });
        if (url.pathname === '/api/wiki/sessions' && req.method === 'POST') {
          const body = await readJSON(req);
          try {
            if (body.case_id) {
              const record = monitor?.records.get(body.case_id);
              if (!record?.input || record.status !== 'done' || !record.case_dir)
                return callerError(res, '找不到已完成的 Syslog 案件', 404);
              const target = await wikiFeedbackTarget(wiki, { eventType: eventTypeFor(record.input.parsed.msgid),
                caseDir: record.case_dir, page: body.page || null });
              if (!target) return callerError(res, '当前场景缺少可维护的判据页', 409);
              const session = await wikiAgent.create(target.page.path, {
                case_id: body.case_id, case_dir: record.case_dir, event_type: target.eventType,
                reason: body.reason, expected_verdict: body.expected_verdict, who: body.who });
              void auditor({ actor: actorOf({ access, tokenKind: 'prompt-admin' }), action: 'wiki.maintain',
                object: { kind: 'wiki_session', id: session.id, page: target.page.path, case_id: body.case_id } });
              return json(res, 201, session);
            }
            const session = await wikiAgent.create(body.page);
            void auditor({ actor: actorOf({ access, tokenKind: 'prompt-admin' }), action: 'wiki.maintain',
              object: { kind: 'wiki_session', id: session.id, page: body.page } });
            return json(res, 201, session);
          }
          catch (cause) { return causeError(res, cause, 'internal'); }
        }
        const sessionMatch = url.pathname.match(/^\/api\/wiki\/sessions\/([0-9a-f-]{36})(?:\/(messages|replay|publish))?$/i);
        if (sessionMatch) {
          if (req.method === 'GET' && !sessionMatch[2]) {
            const session = await wikiAgent.get(sessionMatch[1]);
            return session ? json(res, 200, session) : callerError(res, '知识维护会话不存在', 404);
          }
          if (req.method === 'POST' && sessionMatch[2] === 'messages') {
            const body = await readJSON(req, 12000);
            try {
              const advanced = await wikiAgent.reply(sessionMatch[1], body.content);
              void auditor({ actor: actorOf({ access, tokenKind: 'prompt-admin' }), action: 'wiki.maintain',
                object: { kind: 'wiki_session', id: sessionMatch[1], step: 'messages' } });
              return json(res, 200, advanced);
            } catch (cause) { return causeError(res, cause, 'upstream'); }
          }
          if (req.method === 'POST' && sessionMatch[2] === 'replay') {
            try {
              const replayed = await wikiAgent.replay(sessionMatch[1]);
              void auditor({ actor: actorOf({ access, tokenKind: 'prompt-admin' }), action: 'wiki.maintain',
                object: { kind: 'wiki_session', id: sessionMatch[1], step: 'replay' } });
              return json(res, 200, replayed);
            } catch (cause) { return causeError(res, cause, 'upstream'); }
          }
          if (req.method === 'POST' && sessionMatch[2] === 'publish') {
            const body = await readJSON(req, 8192);
            try {
              const published = await wikiAgent.publish(sessionMatch[1], body);
              void auditor({ actor: actorOf({ access, tokenKind: 'prompt-admin' }), action: 'wiki.publish',
                object: { kind: 'wiki_session', id: sessionMatch[1], page: published.page?.path || null } });
              return json(res, 200, published);
            } catch (cause) { return causeError(res, cause, 'upstream'); }
          }
        }
        return callerError(res, '知识库接口不存在', 404);
      }
      if (url.pathname === '/api/agent/investigations' && req.method === 'POST') {
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return callerError(res, '请求正文无效');
        const executor = body.mode === 'deep' && investigator === agent ? deepInvestigator : investigator;
        if (!executor) return configError(res, '该研判模式的模型或牧云取证接口尚未配置');
        // 入参先在这里判完（与 InvestigationAgent.run 的判定一致：ID 形状 + 事件类型，模式白名单），
        // 不再靠 /告警 ID 无效|研判模式无效/ 匹配异常文案——剩下的异常只可能是上游（模型 / 牧云工具）失败。
        if (!validAlertId(body.alert_id)) return callerError(res, '告警 ID 无效');
        const mode = body.mode || 'deep';
        if (!['deep', 'triage'].includes(mode)) return callerError(res, '研判模式无效');
        if (url.searchParams.get('stream') === '1') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
            Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
          const send = payload => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
          const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
          res.on('close', () => clearInterval(heartbeat));
          try {
            const result = await investigate(executor, body.alert_id, mode,
              (stage, detail) => send({ type: 'progress', stage, detail }));
            const saved = await history.save(result);
            void auditor({ actor: actorOf({ access }), action: 'investigation.run',
              object: { kind: 'investigation', alert_id: body.alert_id, mode } });
            send({ type: 'result', result: saved });
          } catch (cause) {
            void auditor({ actor: actorOf({ access }), action: 'investigation.run',
              object: { kind: 'investigation', alert_id: body.alert_id, mode }, result: 'error' });
            send(sseErrorFrame(cause));
          }
          finally { clearInterval(heartbeat); if (!res.destroyed) res.end(); }
          return;
        }
        try {
          const result = await investigate(executor, body.alert_id, mode);
          const saved = await history.save(result);
          void auditor({ actor: actorOf({ access }), action: 'investigation.run',
            object: { kind: 'investigation', alert_id: body.alert_id, mode } });
          return json(res, 200, saved);
        }
        catch (e) { return causeError(res, e, 'upstream'); }
      }
      // 研判记录列表（P003-T059 A01）：文件名是 sha256 不可枚举，「浏览昨天研判了哪些」在这里补上。
      // 必须排在下面 startsWith('/api/agent/investigations/') 之前。
      if (url.pathname === '/api/agent/investigations' && req.method === 'GET') {
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
          return callerError(res, '分页参数无效');
        const verdicts = paramList(url.searchParams, 'verdict');
        for (const value of verdicts) if (!verdictFilters.has(value)) return callerError(res, `筛选结论无效：${value}`);
        const from = url.searchParams.get('from')?.trim();
        const to = url.searchParams.get('to')?.trim();
        const fromTime = from ? parseInstant(from) : null;
        const toTime = to ? parseInstant(to) : null;
        if (from && !fromTime) return callerError(res, `筛选起始时间无效：${from}`);
        if (to && !toTime) return callerError(res, `筛选结束时间无效：${to}`);
        if (fromTime && toTime && fromTime > toTime) return callerError(res, '筛选起始时间晚于结束时间');
        const rows = await history.list({ verdicts, from: fromTime, to: toTime });
        // 与案件列表的口径差一并给出：cases 只列有原始报文的入队记录，这里列全部落盘研判。
        return json(res, 200, { total: rows.length, items: rows.slice(offset, offset + count),
          cases_total: monitor ? monitor.cases({ count: 1 }).total : null });
      }
      // 研判会话回放（P003-T046 A3）：读已落盘的研判记录与证据，**不重放模型**。
      // 必须排在下面那条 startsWith 之前：否则 `/replay` 会被当成告警 ID 的后半段，回 400。
      const replay = url.pathname.match(/^\/api\/agent\/investigations\/(.+)\/replay$/);
      if (replay && req.method === 'GET') {
        let alertId;
        try { alertId = decodeURIComponent(replay[1]); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        const mode = url.searchParams.get('mode') || 'deep';
        if (!['deep', 'triage'].includes(mode) || !(mode === 'triage' ? validTriageId(alertId) : validAlertId(alertId)))
          return callerError(res, '告警 ID 或研判模式无效');
        const saved = await history.latest(alertId, mode);
        if (!saved) return callerError(res, '该告警暂无已保存的研判记录', 404);
        return json(res, 200, replayInvestigation(saved));
      }
      if (url.pathname.startsWith('/api/agent/investigations/') && req.method === 'GET') {
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/agent/investigations/'.length)); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        const mode = url.searchParams.get('mode') || 'deep';
        if (!(mode === 'triage' ? validTriageId(alertId) : validAlertId(alertId)) || !['deep', 'triage'].includes(mode)) return callerError(res, '告警 ID 或研判模式无效');
        const saved = await history.latest(alertId, mode);
        return saved ? json(res, 200, saved) : callerError(res, '该告警暂无已保存的研判记录', 404);
      }
      if (url.pathname === '/api/alerts' && req.method === 'GET') {
        if (!service) return configured(res);
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0) return callerError(res, '分页参数无效');
        const filters = alertQuery(url.searchParams);
        if (filters.error) return callerError(res, filters.error);
        const triageFiltered = filters.statuses.length > 0 || filters.verdicts.length > 0;
        const result = triageFiltered
          ? await triageFilteredAlerts(service, monitor, filters.query, { statuses: filters.statuses, verdicts: filters.verdicts, count, offset })
          : await viaCloudwalker('alerts', null, () => service.alerts({ count, offset, ...filters.query }));
        // 没配研判时 triage 键仍在、值为 null：前端靠这个布尔分辨「没记录」与「没配」两种空。
        if (!triageFiltered) result.alerts = result.alerts.map(alert => ({ ...alert, triage: monitor ? monitor.status(alert.id) : null }));
        result.triage_configured = Boolean(monitor);
        return json(res, 200, result);
      }
      let decodedPath;
      try { decodedPath = decodeURIComponent(url.pathname); }
      catch { return callerError(res, '事件路径编码无效'); }
      // 详情：路径形状对但 ID / 事件类型不合法一律 400，不把牧云调用浪费掉。
      const detailPath = decodedPath.match(/^\/api\/alerts\/([^/]+)$/);
      if (detailPath && req.method === 'GET') {
        if (!Object.hasOwn(eventTypes, detailPath[1].split(':')[0])) return callerError(res, '不支持的事件类型');
        if (!validAlertId(detailPath[1])) return callerError(res, '告警 ID 无效');
        if (!service) return configured(res);
        const [type, id] = detailPath[1].split(':');
        let result;
        try { result = await viaCloudwalker('alert', detailPath[1], () => service.alert(type, Number(id))); }
        catch (cause) {
          // 404 = 牧云可达但这条事件读不到（cloudwalker.js 标 status）；其余（不可达、上游自相矛盾）落到外层 502。
          if (cause?.status === 404) return callerError(res, cause.message, 404);
          throw cause;
        }
        if (monitor) result.alert.triage = monitor.status(result.alert.id);
        return json(res, 200, result);
      }
      // 未知路径统一一个文案（P003-T073）；已知路径但方法不对统一 405 并带 Allow（原来退 404 且两套文案）。
      const allowed = allowedMethods(url.pathname);
      if (allowed) {
        res.setHeader('Allow', allowed.join(', '));
        return callerError(res, '该方法不支持此接口', 405);
      }
      return callerError(res, '接口不存在', 404);
    } catch (e) {
      // 走到这里的是没被各路由自己接住的失败：分类交给四类判定——牧云调用经 viaCloudwalker 打了上游标（502），
      // 读正文/各模块判过的 4xx 是调用方传错（400 等），剩下的本程序意外一概 500 + 固定文案，异常原文只进日志。
      log('http.failed', { method: req.method, path: route, status: failureStatusOf(failureKindOf(e), e),
        error: e.message || '未预期的失败' }, 'error');
      causeError(res, e);
    }
  }
}

// 运行态路径的唯一真源（P003-T019 立、P003-T034 搬到数据根）：全部落在数据根下，**仓库里一个字都不写**。
// `server.js` 模块级装配那一行（`server.js:29`）就是 `runtimePaths()` 的缺省调用：根由 `dataRoot()` 定，
// 设了 `HIDS_DATA_DIR` 就用它，没设就是 `~/.local/share/hids-ai-console/`。
// 数据根本身由 `dataRoot()`（`config-store.js`）定义：`HIDS_DATA_DIR` 指向哪就落哪，没设就是
// `~/.local/share/hids-ai-console/`——两个文件共用一份规则，别在这里另拼一套。
// 别改回「本文件所在目录」或「本文件所在目录的上一级」：部署时仓库目录是只读的，写出去的案卷/基线没人知道该去哪找。
// 旧位不自动搬（P003-T034 A4）：仓内 `.data/` 与更早的 `<上一级>/backend/.data/` 里的既有数据进程不读也不写，
// 要接着用就人工搬进数据根（迁移是运维的手工活，代码里没有任何 rename / copy）。
// 定义在这个位置（模块末尾）而不在顶部，是为了不挪动上面所有 `path:line` 引用的行号。
export function runtimePaths(root = dataRoot()) {
  const data = root;
  return {
    data,
    investigations: path.join(data, 'investigations'),
    triageRules: path.join(data, 'triage-rules.json'),
    triageMonitor: path.join(data, 'triage-monitor.json'),
    cases: path.join(data, 'cases'),
    wikiSessions: path.join(data, 'wiki-sessions'),
    fpSessions: fpSessionDirectory(data),
    traceBoards: path.join(data, 'trace-boards')
  };
}

// ── 启动配置核对（P003-T025）─────────────────────────────────────────────────
// 三件事共用一份判定，别在别处另写一套：进程入口拿它当启动闸门（缺必填、取到表外的值都拒绝启动），
// `GET /api/config` 拿它对外报生效值，模块级装配拿它决定研判输入模式。
// 「有没有」只判在不在——值的形状（URL 前缀、Token 长度）仍由装配处抛（rpc-client.js:4-5、model-client.js:22-24）；
// 唯一进闸门的取值校验是 HIDS_TRIAGE_INPUT_MODE：它有两个合法值，坏值不许静默退 poll（那会把 syslog 接收器关掉）。
// 机密只出现在 secrets 里，值是布尔：响应体与日志里都不出现 Token / 密码原文（A3）。
const REQUIRED_CONFIG_KEYS = Object.freeze(['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);
const SECRET_CONFIG_KEYS = Object.freeze(['CLOUDWALKER_API_TOKEN', 'LLM_API_KEY', 'HIDS_BASIC_AUTH_PASSWORD',
  'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN']);
// 研判输入模式的取值表。写成函数（不是模块级 const）是因为装配处 server.js:46 在模块加载时就要用它：
// 函数声明会提升，`const` 不会——末尾的 const 拿到那时还在 TDZ 里。
export function triageInputModes() {
  return ['syslog', 'poll'];
}

// 生效的研判输入模式：合法值原样返回，空值走缺省 syslog，**坏值不在这里兜**——真进程由启动闸门拒掉；
// 这条回落只对进程内 createServer（测试、探针）生效，且落在文档写的缺省值上，不会静默跑去 poll 分支。
export function triageInputModeOf(env = process.env) {
  const raw = env.HIDS_TRIAGE_INPUT_MODE;
  return triageInputModes().includes(raw) ? raw : 'syslog';
}

// 取值非法的键：空值算「没配」（走缺省），非空且不在取值表里才算坏值。启动闸门拿它与「缺必填」同一个出口。
export function invalidConfigValues(env = process.env) {
  const raw = env.HIDS_TRIAGE_INPUT_MODE;
  if (raw == null || raw === '') return [];
  const allowed = triageInputModes();
  return allowed.includes(raw) ? [] : [{ key: 'HIDS_TRIAGE_INPUT_MODE', value: String(raw), allowed }];
}

// env 可注入：单测直接传一个字面量对象，不碰真实 process.env。
// 缺省值与装配处逐条对齐——HIDS_HOST/HIDS_PORT 见 server.js:29-30、研判输入模式见 triageInputModeOf()。
export function configSummary(env = process.env, overrides = null) {
  return {
    host: env.HIDS_HOST || '127.0.0.1',
    port: Number(env.HIDS_PORT || 8080),
    triage_input_mode: triageInputModeOf(env),
    cloudwalker: { configured: Boolean(env.CLOUDWALKER_URL && env.CLOUDWALKER_API_TOKEN) },
    // 模型分层（P003-T042）：`configured` / `name` 仍是主判三项的口径（老客户端与文档照旧读它们）；
    // `roles` 报五个角色各 resolved 到哪个模型、以及这一组的来源三态（primary / own / mixed），
    // 只报模型名与来源，不报地址与密钥。
    model: { configured: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL), name: env.LLM_MODEL || null,
      roles: modelRoleSummary(env) },
    // 不配 Basic 口令 = 不启用鉴权（hasAccess 见 server.js:413），这是合法部署，不是缺配置。
    auth: { basic_auth_enabled: Boolean(env.HIDS_BASIC_AUTH_PASSWORD) },
    secrets: Object.fromEntries(SECRET_CONFIG_KEYS.map(name => [name, Boolean(env[name])])),
    // P003-T084 B05：每项来源可见——override（覆盖文件）/ env（环境变量）/ default（未配）。
    sources: Object.fromEntries(REQUIRED_CONFIG_KEYS.concat(['HIDS_BASIC_AUTH_PASSWORD',
      'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN']).map(name => [name,
      (overrides ?? configStore.overrides())[name] !== undefined ? 'override'
        : env[name] ? 'env' : 'default'])),
    missing_required: REQUIRED_CONFIG_KEYS.filter(name => !env[name])
  };
}


// ── 启动自检（P003-T074）：运行态落点必须全在数据根下 ─────────────────────────
// 逐项核对 runtimePaths 与日志/覆盖层落点；越界的落一条 data.root_outside 警告（不静默、不阻止启动）。
export function startupDataRootAudit({ env = process.env, home, roots = null } = {}) {
  const root = path.resolve(roots ?? runtime.data);
  const entries = [
    ['investigations', path.resolve(roots ?? runtime.investigations)],
    ['cases', path.resolve(roots ?? runtime.cases)],
    ['trace-boards', path.resolve(roots ?? runtime.traceBoards)],
    ['wiki-sessions', path.resolve(roots ?? runtime.wikiSessions)],
    ['fp-sessions', path.resolve(roots ?? runtime.fpSessions)],
    ['triage-rules.json', path.resolve(roots ?? runtime.triageRules)],
    ['triage-monitor.json', path.resolve(roots ?? runtime.triageMonitor)]
  ];
  const logFile = typeof env.HIDS_LOG_FILE === 'string' && env.HIDS_LOG_FILE.trim()
    && env.HIDS_LOG_FILE.trim() !== 'none' ? path.resolve(env.HIDS_LOG_FILE.trim()) : null;
  if (logFile) entries.push(['HIDS_LOG_FILE', logFile]);
  const outside = entries.filter(([, target]) => !target.startsWith(root + path.sep) && target !== root)
    .map(([name, target]) => ({ name, target }));
  if (outside.length)
    log('data.root_outside', { root, outside: outside.map(item => item.name), error: outside.map(item => item.target).join('、') }, 'warn');
  return { root, outside };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 启动闸门（P003-T025）：两类配置问题都不监听——缺必填、取值非法。缺的键名与坏值逐个列到 stderr，退出码非 0。
  // 只拦这一条入口：createServer 仍可被测试与探针注入替身在进程内起来（缺能力就置空，路由 503）。
  const config = configSummary();
  const invalid = invalidConfigValues();
  if (config.missing_required.length || invalid.length) {
    const lines = [];
    if (config.missing_required.length) lines.push(`缺少必填配置：${config.missing_required.join('、')}`);
    for (const item of invalid) lines.push(`配置值无效：${item.key}=${item.value}（只能是 ${item.allowed.join(' 或 ')}）`);
    const message = lines.join('；');
    log('server.start_failed', { what: 'config', missing: config.missing_required, invalid, error: message }, 'error');
    process.stderr.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    startupDataRootAudit();
    createServer().listen(port, host, () => log('server.started', { host, port }));
    if (triageMonitor) void triageMonitor.start().then(async () => {
      if (triageInputMode === 'syslog') {
        const receiver = new SyslogReceiver({ host: process.env.HIDS_SYSLOG_HOST || '127.0.0.1',
          port: Number(process.env.HIDS_SYSLOG_PORT || 15514), onLine: line => triageMonitor.acceptSyslog(line) });
        // 绑定失败（端口被占 / 权限不足）只打日志会让队列静默收不到消息：状态记进 summary()，日志由 monitor 记。
        await triageMonitor.attachSyslog(receiver);
      }
    }).catch(error => log('server.start_failed', { what: 'triage', error: error.message }, 'error'));
  }
}
