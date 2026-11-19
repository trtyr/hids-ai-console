import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RpcClient } from './rpc-client.js';
import { CloudwalkerGateway, eventTypes, parseInstant } from './cloudwalker.js';
import { createAgentToolboxFromEnv, TriageEvidenceToolbox } from './agent-tools.js';
import { ApiEvidenceToolbox } from './api-tools.js';
import { applyModelValues, createModelRolesFromEnv, modelRoleSummary, modelRoleValues, MODEL_ROLES } from './model-client.js';
import { InvestigationAgent } from './investigation-agent.js';
import { InvestigationStore } from './investigation-store.js';
import { PromptStore } from './prompt-store.js';
import { TriageMonitor } from './triage-monitor.js';
import { log, logFileOptions, pruneLogFiles, readLogEntries, queryLevels, useLogFile } from './log.js';
import { SyslogReceiver, parseSyslog } from './syslog-input.js';
import { eventTypeFor } from './syslog-input.js';
import { WikiStore } from './wiki-store.js';
import { WikiWorkbench } from './wiki-workbench.js';
import { TraceBoardService } from './trace-board.js';
import { UpdateStore } from './update-store.js';
import { TriageRuleEngine, validateRuleSet } from './triage-rules.js';
import { RuleSessionStore, RuleStore, isRuleId } from './rule-store.js';
import { createConfigStore, dataRoot } from './config-store.js';

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
  ruleEngine: triageRuleEngine,
  casesDirectory: process.env.HIDS_CASES_DIR || runtime.cases,
  baselineFile: runtime.baseline,
  intelFile: runtime.intel }) : null;
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
  directory: runtime.traceBoards,
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

  async maintain({ caseId, caseDir = null, eventType, reason, who, alert, ruleIds = [] }) {
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
      const message = await this.model.complete([
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify({ case_id: caseId, event_type: eventType, false_positive_reason: reason,
          reported_by: who, alert, matched_rules: matched, existing_rules: inventory.rules }) }
      ], [], 'none');
      const output = ruleProposal(message.content);
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

// 案件里命中的 Rego 规则 id：结果落盘的 result.json 里就有，没有就当没命中（旧案件可能没有这条轨迹）。
async function caseRegoRuleIds(record) {
  if (!record?.case_dir) return [];
  try {
    const saved = JSON.parse(await readFile(path.join(record.case_dir, 'result.json'), 'utf8'));
    const ids = saved?.verdict?.rego?.rule_ids;
    return Array.isArray(ids) ? ids.filter(id => isRuleId(id)) : [];
  } catch { return []; }
}

// 误报案件的 wiki 维护目标：优先分析时引用过的判据页，其次本场景第一页。
// POST /api/wiki/sessions 与误报入口共用这一处口径，两条入口选出来的页一致。
async function wikiFeedbackTarget(wiki, record, page = null) {
  const eventType = eventTypeFor(record.input.parsed.msgid);
  const index = await wiki.agentIndex(eventType);
  const eligible = index.pages.filter(item => item.path.startsWith(`${index.category}/`));
  let cited = [];
  try {
    const saved = JSON.parse(await readFile(path.join(record.case_dir, 'result.json'), 'utf8'));
    cited = (saved.trace || []).filter(item => item.kind === 'wiki' && item.id).map(item => item.id);
  } catch { /* 旧案件可能没有完整的引用轨迹 */ }
  const target = page ? eligible.find(item => item.path === page)
    : eligible.find(item => cited.includes(item.id)) || eligible[0];
  return target ? { page: target, eventType } : null;
}

// 两个维护者并行跑，各自收尾就把自己的状态写进 maintenance；总态等两边都有结果才定。
// 单边失败只改它自己那一格：verdict 与 feedback 一律不动（A4）。
async function maintainFalsePositive({ monitor, record, wiki, wikiAgent, ruleMaintainer }) {
  const state = record.maintenance;
  const settle = async (key, job) => {
    try { state[key] = { status: 'updated', at: new Date().toISOString(), ...await job() }; }
    catch (cause) {
      // 维护失败原因会随记录回给调用方（falsePositiveView），同样过一道凭据擦除（A4）。
      state[key] = { status: 'failed', at: new Date().toISOString(), error: scrubCredentials(cause?.message || cause).slice(0, 300) };
    }
    state.status = maintenanceState([state.rule, state.wiki]);
    state.updated_at = new Date().toISOString();
    await monitor.persist?.();
  };
  const ruleJob = async () => {
    if (!ruleMaintainer) throw new Error('规则维护者未配置');
    const parsed = record.input?.parsed;
    return ruleMaintainer.maintain({ caseId: record.alert_id, caseDir: record.case_dir || null,
      eventType: eventTypeFor(parsed?.msgid), reason: record.feedback.reason, who: record.feedback.who,
      alert: parsed ? { msgid: parsed.msgid, payload: parsed.payload } : null,
      ruleIds: await caseRegoRuleIds(record) });
  };
  const wikiJob = async () => {
    if (!wiki || !wikiAgent) throw new Error('知识维护端未配置');
    const target = await wikiFeedbackTarget(wiki, record);
    if (!target) throw new Error('当前场景缺少可维护的判据页');
    const session = await wikiAgent.create(target.page.path, { case_id: record.alert_id, case_dir: record.case_dir,
      event_type: target.eventType, reason: record.feedback.reason, expected_verdict: 'false_positive',
      who: record.feedback.who });
    const advanced = await wikiAgent.reply(session.id,
      `人工登记误报：${record.feedback.reason}。请按 _schema.md 核对判据是否需要修订，需要就给出完整修订草案。`);
    const proposal = advanced?.proposal;
    if (!proposal) throw new Error(`维护者没有产出方法论修订（会话 ${session.id} 状态 ${advanced?.status || '未知'}）`);
    const changes = Array.isArray(proposal.changes) && proposal.changes.length ? proposal.changes
      : [{ path: target.page.path, content: proposal.content, page_revision: proposal.page_revision }];
    if (!changes.some(change => change.path === target.page.path)) throw new Error('方法论修订草案没有覆盖当前判据页');
    // 发布前的结构、断链、证据引用检查在 publishBundle 里；reviewer 记登记人，note 记他给的理由。
    const pages = await wiki.publishBundle(changes, proposal.evidence_preview || null,
      { reviewer: record.feedback.who, note: record.feedback.reason.slice(0, 500), case_id: record.alert_id });
    const written = pages.find(item => item.path === target.page.path) || pages[0];
    return { session_id: session.id, page: written.path, revision: written.revision,
      pages: pages.map(item => item.path) };
  };
  await Promise.all([settle('rule', ruleJob), settle('wiki', wikiJob)]);
}

// 误报入口的响应：结论 + 理由 + 两个维护者的进度（GET 同一条案件也能读到同样的三个字段）。
function falsePositiveView(record) {
  return { alert_id: record.alert_id,
    verdict: { verdict: record.verdict, verdict_label: record.verdict_label, source: record.decision_source },
    feedback: record.feedback, maintenance: record.maintenance };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
// ── 错误响应：四类失败，一类一个稳定 code（P003-T024）──────────────────────────
// 类 → 状态码固定，调用点只说「这是哪一类」，不再自己挑 400/502；同一类在哪条路由上都是同一个码。
// 判据只认错误自己带的标记（failure / status），不看文案——文案会改，改文案不该改分类。
const failureClasses = Object.freeze({
  caller: { status: 400, code: 'caller_error' }, // 调用方传错：参数/正文/ID/权限/不存在/状态冲突
  config: { status: 503, code: 'not_configured' }, // 没配置：牧云、模型、管理员令牌、研判队列
  upstream: { status: 502, code: 'upstream_error' }, // 上游失败：牧云、模型、MCP、随部署的只读规则数据
  internal: { status: 500, code: 'internal_error' } // 本程序失败：没预料到的异常、本地运行态读写
});
// 本程序失败对外只说这一句：异常原文与堆栈只进 http.failed 日志（A3），不回给调用方。
const INTERNAL_ERROR_MESSAGE = '服务器内部错误';

// 错误原文里可能带上游回显的凭据（Authorization 头、查询串里的 token/api_key）：正文出口统一擦一遍（A4）。
function scrubCredentials(text) {
  return String(text ?? '')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(token|api[_-]?key|password|secret)=[^\s&"'，。；]+/gi, '$1=[redacted]');
}

function failureBody(kind, message) {
  const { code } = failureClasses[kind];
  return { error: kind === 'internal' ? INTERNAL_ERROR_MESSAGE : scrubCredentials(message) || code, code };
}
// status 只在「调用方传错」这一类里覆盖（400 参数 / 403 权限 / 404 不存在 / 405 方法 / 409 冲突 / 410 已下线 / 422 无法溯源），
// 5xx 一律由类决定，免得同一类又冒出两种服务端状态码。
function fail(res, kind, message, status = failureClasses[kind].status) {
  return json(res, status, failureBody(kind, message));
}
const callerError = (res, message, status = 400) => fail(res, 'caller', message, status);
const configError = (res, message) => fail(res, 'config', message);
const upstreamError = (res, message) => fail(res, 'upstream', message);

// 一个异常属于哪一类：显式标记（viaCloudwalker 打的上游标）优先，其次 4xx status（各模块自己判过的调用方错误），
// 都没有就落到调用点给的缺省类——调用点知道自己调的是上游还是本地代码。
function failureKindOf(cause, fallback = 'internal') {
  if (cause?.failure && Object.hasOwn(failureClasses, cause.failure)) return cause.failure;
  const status = Number(cause?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 ? 'caller' : fallback;
}
function failureStatusOf(kind, cause) {
  const status = Number(cause?.status);
  return kind === 'caller' && Number.isInteger(status) ? status : failureClasses[kind].status;
}
function causeError(res, cause, fallback = 'internal') {
  const kind = failureKindOf(cause, fallback);
  const message = cause?.message || (kind === 'upstream' ? '上游请求失败' : '请求无效');
  return fail(res, kind, message, failureStatusOf(kind, cause));
}
function hasAccess(req, access) {
  if (!access?.password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`${access.user || 'admin'}:${access.password}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function requireAccess(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="HIDS AI Console", charset="UTF-8"',
    // 正文是纯文本：openapi.yaml 的 BusinessUnauthorized 只声明 text/plain，不声明 Content-Type 会让调用方当二进制猜。
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end('需要登录后访问');
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
const triageStatusFilters = new Set(['not_queued', 'queued', 'running', 'done', 'failed']);
const verdictFilters = new Set(['review', 'threat', 'uncertain', 'false_positive']);
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
  return { filters: { events, levels, from: fromTime, to: toTime } };
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

// ── 数据管理（P003-T044）：盘点 / 归档 / 清理 ───────────────────────────────
// 七类运行态的真源路径一律取自 createServer 的注入件（history / boardService / wikiAgent / monitor / config），
// 不另立一套路径表：测试换掉注入件里的替身目录，盘点的就是那份替身目录。
// dataRoot 取配置覆盖层文件所在目录（缺省就是仓内 .data）：队列的 .archive.jsonl 与清理归档目录都落在这下面。
export const DATA_KINDS = Object.freeze(['cases', 'investigations', 'boards', 'wiki_sessions', 'queue', 'logs', 'config_overrides']);
const DATA_KIND_LABELS = Object.freeze({ cases: '案卷', investigations: '研判记录', boards: '溯源白板',
  wiki_sessions: '知识库会话', queue: '研判队列', logs: '日志', config_overrides: '配置覆盖层' });
const DATA_CLEAN_ACTIONS = Object.freeze(['archive', 'delete']);
const DATA_CANDIDATE_LIMIT = 100; // dry-run 清单最多列这么多条，多出来的只给数字（truncated: true）

function dataAdminRoot(deps) {
  return deps.config?.file ? path.dirname(deps.config.file) : runtime.data;
}

// 布局四种：dirs（一级子目录各算一条）/ files（匹配扩展名的文件）/ single（单文件）/ queue（队列文件，条数＝记录）。
// logs 也走 files 布局，匹配 *.log，目录就是 dataRoot：后端自身不落日志文件（docs/architecture.md:156）。
function dataStores(deps = {}) {
  const root = dataAdminRoot(deps);
  const store = (kind, layout, location, extension = null) => ({ kind, label: DATA_KIND_LABELS[kind], layout, path: location, extension, root });
  return new Map([
    ['cases', store('cases', 'dirs', deps.monitor?.casesDirectory || process.env.HIDS_CASES_DIR || path.join(root, 'cases'))],
    ['investigations', store('investigations', 'files', deps.history?.directory || path.join(root, 'investigations'), 'json')],
    ['boards', store('boards', 'files', deps.boardService?.directory || path.join(root, 'trace-boards'), 'json')],
    ['wiki_sessions', store('wiki_sessions', 'files', deps.wikiAgent?.directory || path.join(root, 'wiki-sessions'), 'json')],
    ['queue', store('queue', 'queue', deps.monitor?.file || path.join(root, 'triage-monitor.json'))],
    ['logs', store('logs', 'files', root, 'log')],
    ['config_overrides', store('config_overrides', 'single', deps.config?.file || path.join(root, 'config-overrides.json'))]
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
    : store.layout === 'files' && entry.name.endsWith(`.${store.extension}`));
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

export function createServer(service = gateway, toolbox = apiToolbox, investigator = agent, history = investigationStore, prompts = promptStore, monitor = service === gateway ? triageMonitor : null, knowledge = null,
  access = { user: process.env.HIDS_BASIC_AUTH_USER, password: process.env.HIDS_BASIC_AUTH_PASSWORD }, boardService = service === gateway ? traceBoard : null,
  promptAdminToken = process.env.HIDS_PROMPT_ADMIN_TOKEN, wiki = wikiStore, wikiAgent = wikiWorkbench,
  maintenanceEntry = process.env.HIDS_MAINTENANCE_ENTRY_URL,
  ruleAdminToken = process.env.HIDS_RULE_ADMIN_TOKEN, ruleStore = regoRuleStore,
  ruleMaintainer = regoMaintainer, config = configStore, ruleSessions = defaultRuleSessions,
  logFile = logOptions ? logOptions.file : null) {
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
      result.rule_evaluation = decision;
      return result;
    }
    return executor.run(alertId, onProgress ? { mode, onProgress } : { mode });
  };
  // 本进程里正在跑维护的告警：重复登记靠它挡，不靠记录上的 maintenance.status——进程重启后记录会停在 updating，
  // 拿那个当日志会把这个案件永久锁死在 updating。
  const runningMaintenance = new Set();
  // 数据管理（P003-T044）的路径来源：全部是本次注入的构件，换替身就是换盘点对象。
  const dataDeps = { history, monitor, boardService, wikiAgent, config };
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    // 只记方法与路径（query 一律不记：可能带令牌），请求头一个字段都不碰——Authorization / Cookie 不进日志（A4）。
    const route = String(req.url || '').split('?')[0];
    res.on('finish', () => log('http.request', { method: req.method, path: route, status: res.statusCode,
      duration_ms: Date.now() - startedAt }));
    if (!hasAccess(req, access)) {
      log('http.unauthorized', { method: req.method, path: route, status: 401 }, 'warn');
      return requireAccess(res);
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/session' && req.method === 'GET') {
        // B17：业务 Basic 账号是值守操作员（role 固定 operator）；管理员是维护端令牌那条线，不在这套身份里。
        // 未配置 HIDS_BASIC_AUTH_PASSWORD 时任何人可进，没有账号可报，user / role 都回 null。
        return json(res, 200, access?.password
          ? { authenticated: true, user: access.user || 'admin', role: 'operator' }
          : { authenticated: true, user: null, role: null });
      }
      if (url.pathname === '/api/updates' && req.method === 'GET') return json(res, 200, await new UpdateStore(prompts).overview());
      // 生效值一览（P003-T025）：地址、端口、研判输入模式、牧云与模型配了没有、模型名。
      // 机密只给有/没有——本路由的响应体里不出现任何 Token 与密码原文（A3）。
      // 读的是注入的 store 的 env（缺省就是 process.env）：写配置盖进的覆盖层立刻反映在这里（P003-T029 A1）。
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configSummary(config.env));
      // 写配置（P003-T029）：运行中改牧云与模型五项，落盘后重启仍生效（store 建时读回覆盖层）。
      // 顺序＝先校验、再落盘、再改 env（config.update 内部），最后原地换活着的客户端值。
      // 响应只回「改了哪几个键 + 生效摘要」：机密永远只以布尔出现（A2）。
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const updated = await config.update(await readJSON(req));
        applyLiveConfig({ gateway, models, agentToolbox }, config.values());
        return json(res, 200, { updated, config: configSummary(config.env) });
      }
      // 数据管理（P003-T044）：盘点七类运行态的条数与字节；清理按类型与阈值归档或删除（默认 dry-run）。
      // 两个路径不碰上游、不碰模型，只读本地运行态目录；清理的 409（还有案件在排/在跑）由 causeError 原样回。
      if (url.pathname === '/api/data/inventory' && req.method === 'GET')
        return json(res, 200, await dataInventory(dataDeps));
      if (url.pathname === '/api/data/cleanup' && req.method === 'POST') {
        try { return json(res, 200, await dataCleanup(dataDeps, await readJSON(req))); }
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
        try { return json(res, 200, logCleanup(logFile, await readJSON(req))); }
        catch (cause) { return causeError(res, cause, 'internal'); }
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!service) return json(res, 200, { configured: false, connected: false, reason: '请设置牧云地址和 API Token' });
        try { return json(res, 200, { configured: true, ...(await viaCloudwalker('status', null, () => service.status())) }); }
        // 配了但连不上：业务体形状是契约（前端按 connected 判），只补一个稳定 code；reason 是上游那句摘要。
        catch (e) { return json(res, 502, { configured: true, connected: false,
          reason: scrubCredentials(e.message) || '上游请求失败', code: failureClasses.upstream.code }); }
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
        try { return json(res, 200, { ...await (monitor?.ruleEngine || triageRuleEngine).readConfig(),
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
        if (!hasRuleAdminAccess(req, ruleAdminToken)) return callerError(res, '规则管理员令牌无效', 403);
        try {
          const body = await readJSON(req, 100000);
          if (!body || !Object.hasOwn(body, 'expected_revision') ||
            !(body.expected_revision === null || /^[0-9a-f]{16}$/.test(body.expected_revision)))
            return callerError(res, '缺少有效的规则配置版本');
          return json(res, 200, await (monitor?.ruleEngine || triageRuleEngine)
            .saveConfig(body.config, body.expected_revision));
        } catch (cause) { return causeError(res, cause, 'internal'); }
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
        if (ruleMaintenance[2] === 'rollback' && req.method === 'POST') {
          if (!ruleAdminToken) return configError(res, '尚未配置规则管理员令牌');
          if (!hasRuleAdminAccess(req, ruleAdminToken)) return callerError(res, '规则管理员令牌无效', 403);
          const body = await readJSON(req, 20000);
          const rev = typeof body?.rev === 'string' ? body.rev.trim() : '';
          if (!/^[0-9a-f]{16}$/.test(rev)) return callerError(res, '缺少有效的目标版本 rev');
          const who = String(body.who ?? access?.user ?? 'operator').trim().replace(/\s+/g, ' ').slice(0, 100);
          try { return json(res, 200, await ruleStore.rollback(id, rev, { note: `人工回滚（${who}）` })); }
          catch (cause) { return causeError(res, cause, 'internal'); }
        }
      }
      if (url.pathname.startsWith('/api/rules/') && req.method === 'PUT') {
        if (!ruleAdminToken) return configError(res, '尚未配置规则管理员令牌');
        if (!hasRuleAdminAccess(req, ruleAdminToken)) return callerError(res, '规则管理员令牌无效', 403);
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
          return json(res, 200, await ruleStore.save(id, body.rego, { note, expectedRevision: expected }));
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
        try { return json(res, 200, await monitor.setEnabled(body.enabled)); }
        catch (cause) { return causeError(res, cause, 'internal'); }
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
        const record = monitor.records.get(alertId);
        if (!record) return callerError(res, '找不到这条研判案件', 404);
        if (record.status !== 'done') return callerError(res, '研判还没结束，不能登记误报', 409);
        // 同一轮维护还在本进程里跑：不再起第二轮，直接把当前进度回给调用方（重复点击不该让维护者跑两遍）。
        // 记录上的 maintenance.status 可能是重启前的残留，所以这重只看在跑的集合。
        if (runningMaintenance.has(alertId)) return json(res, 202, falsePositiveView(record));
        // A1：先把结论与理由写死并落盘，再回 202——两个维护者还在排队时，这一条已经是误报。
        const at = new Date().toISOString();
        record.verdict = 'false_positive'; record.verdict_label = '误报'; record.decision_source = 'human';
        record.feedback = { reason, who, recorded_at: at };
        record.detail = `人工登记误报（${who}）：${reason}`.slice(0, 250);
        record.maintenance = { status: 'updating', updated_at: at,
          rule: { status: 'updating', at }, wiki: { status: 'updating', at } };
        record.updated_at = at;
        await monitor.persist?.();
        // 后台跑两个维护者：失败只写 maintenance，不回滚 verdict；响应不等它们。
        runningMaintenance.add(alertId);
        void maintainFalsePositive({ monitor, record, wiki, wikiAgent, ruleMaintainer }).catch(cause => {
          record.maintenance.status = 'failed';
          record.maintenance.error = scrubCredentials(cause?.message || cause).slice(0, 300);
        }).finally(() => { runningMaintenance.delete(alertId);
          // 误报维护的结局只从这里出来：两侧各自的状态与原因都带上，别让人去翻 .data/triage-monitor.json。
          log('maintenance.result', { alert_id: alertId, status: record.maintenance.status,
            rule: record.maintenance.rule?.status ?? null, wiki: record.maintenance.wiki?.status ?? null,
            rule_error: record.maintenance.rule?.error ?? null, wiki_error: record.maintenance.wiki?.error ?? null });
        });
        return json(res, 202, falsePositiveView(record));
      }
      if (url.pathname.startsWith('/api/agent/triage/')) {
        if (!monitor) return configError(res, '自动研判尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/agent/triage/'.length)); }
        catch { return callerError(res, '告警 ID 编码无效'); }
        if (!validTriageId(alertId)) return callerError(res, '告警 ID 无效');
        if (req.method === 'GET') return json(res, 200, monitor.status(alertId) || { alert_id: alertId, status: 'not_queued', evidence: [] });
        if (req.method === 'POST') return json(res, 202, await monitor.enqueue(alertId, { retry: true }));
        // A9（P003-T036）：取消排队中的案件。404 没有记录、409 已在研判中，都走 causeError 的 caller 类。
        if (req.method === 'DELETE') {
          try { return json(res, 200, await monitor.cancel(alertId)); }
          catch (cause) { return causeError(res, cause); }
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
            return json(res, 200, await wiki.update(pagePath.filename, body.content, body.expected_revision,
              `通过控制台直接编辑（操作人 ${access?.user || 'admin'}）`));
          } catch (cause) { return causeError(res, cause, 'internal'); }
        }
        if (!promptAdminToken) return configError(res, '尚未配置知识库管理员凭据');
        if (!hasPromptAdminAccess(req, promptAdminToken)) return callerError(res, '知识库管理员凭据无效', 403);
        if (url.pathname === '/api/wiki/health' && req.method === 'GET') return json(res, 200, await wiki.health());
        if (url.pathname === '/api/wiki/sessions' && req.method === 'GET') return json(res, 200, { sessions: await wikiAgent.list() });
        if (url.pathname === '/api/wiki/sessions' && req.method === 'POST') {
          const body = await readJSON(req);
          try {
            if (body.case_id) {
              const record = monitor?.records.get(body.case_id);
              if (!record?.input || record.status !== 'done' || !record.case_dir)
                return callerError(res, '找不到已完成的 Syslog 案件', 404);
              const target = await wikiFeedbackTarget(wiki, record, body.page || null);
              if (!target) return callerError(res, '当前场景缺少可维护的判据页', 409);
              return json(res, 201, await wikiAgent.create(target.page.path, {
                case_id: body.case_id, case_dir: record.case_dir, event_type: target.eventType,
                reason: body.reason, expected_verdict: body.expected_verdict, who: body.who }));
            }
            return json(res, 201, await wikiAgent.create(body.page));
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
            try { return json(res, 200, await wikiAgent.reply(sessionMatch[1], body.content)); }
            catch (cause) { return causeError(res, cause, 'upstream'); }
          }
          if (req.method === 'POST' && sessionMatch[2] === 'replay') {
            try { return json(res, 200, await wikiAgent.replay(sessionMatch[1])); }
            catch (cause) { return causeError(res, cause, 'upstream'); }
          }
          if (req.method === 'POST' && sessionMatch[2] === 'publish') {
            const body = await readJSON(req, 8192);
            try { return json(res, 200, await wikiAgent.publish(sessionMatch[1], body)); }
            catch (cause) { return causeError(res, cause, 'upstream'); }
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
            send({ type: 'result', result: await history.save(result) });
          } catch (cause) { send({ type: 'error', error: scrubCredentials(cause.message) || '研判失败' }); }
          finally { clearInterval(heartbeat); if (!res.destroyed) res.end(); }
          return;
        }
        try {
          const result = await investigate(executor, body.alert_id, mode);
          return json(res, 200, await history.save(result));
        }
        catch (e) { return causeError(res, e, 'upstream'); }
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
      if (url.pathname.startsWith('/api/')) return callerError(res, '接口不存在', 404);
      return callerError(res, '接口不存在', 404);
    } catch (e) {
      // 走到这里的是没被各路由自己接住的失败：分类交给四类判定——牧云调用经 viaCloudwalker 打了上游标（502），
      // 读正文/各模块判过的 4xx 是调用方传错（400 等），剩下的本程序意外一概 500 + 固定文案，异常原文只进日志。
      log('http.failed', { method: req.method, path: route, status: failureStatusOf(failureKindOf(e), e),
        error: e.message || '未预期的失败' }, 'error');
      causeError(res, e);
    }
  });
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
    baseline: path.join(data, 'baseline.json'),
    intel: path.join(data, 'intel.json'),
    wikiSessions: path.join(data, 'wiki-sessions'),
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
export function configSummary(env = process.env) {
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
    missing_required: REQUIRED_CONFIG_KEYS.filter(name => !env[name])
  };
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
