import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RpcClient } from './rpc-client.js';
import { CloudwalkerGateway, eventTypes, parseInstant } from './cloudwalker.js';
import { createAgentToolboxFromEnv, TriageEvidenceToolbox } from './agent-tools.js';
import { ApiEvidenceToolbox } from './api-tools.js';
import { createModelFromEnv } from './model-client.js';
import { InvestigationAgent } from './investigation-agent.js';
import { InvestigationStore } from './investigation-store.js';
import { PromptStore } from './prompt-store.js';
import { TriageMonitor } from './triage-monitor.js';
import { log } from './log.js';
import { SyslogReceiver, parseSyslog } from './syslog-input.js';
import { eventTypeFor } from './syslog-input.js';
import { WikiStore } from './wiki-store.js';
import { WikiWorkbench } from './wiki-workbench.js';
import { TraceBoardService } from './trace-board.js';
import { UpdateStore } from './update-store.js';
import { TriageRuleEngine, validateRuleSet } from './triage-rules.js';
import { RuleStore, isRuleId } from './rule-store.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtime = runtimePaths(moduleDirectory); // 运行态一律落在仓库内 .data/（`.gitignore:10` 已忽略）；规则与旧目录说明见文件末尾 runtimePaths()
const host = process.env.HIDS_HOST || '127.0.0.1';
const port = Number(process.env.HIDS_PORT || 8080);
const baseUrl = process.env.CLOUDWALKER_URL;
const token = process.env.CLOUDWALKER_API_TOKEN;
const gateway = baseUrl && token ? new CloudwalkerGateway(new RpcClient(baseUrl, token)) : null;
const apiToolbox = gateway ? new ApiEvidenceToolbox(gateway.rpc) : null;
const agentToolbox = createAgentToolboxFromEnv();
const triageToolbox = apiToolbox && agentToolbox ? new TriageEvidenceToolbox(apiToolbox, agentToolbox) : apiToolbox;
const model = createModelFromEnv();
const promptStore = new PromptStore();
const wikiStore = new WikiStore();
const agent = triageToolbox && model ? new InvestigationAgent(triageToolbox, model, promptStore, wikiStore) : null;
const deepInvestigator = agentToolbox && model ? new InvestigationAgent(agentToolbox, model, promptStore, wikiStore) : null;
const investigationStore = new InvestigationStore(runtime.investigations);
const triageRuleEngine = new TriageRuleEngine(runtime.triageRules);
// Rego 规则库跟着代码走（不是 .data/ 运行态）：默认读仓根的 rules/ 目录。
const regoRuleStore = new RuleStore(path.join(moduleDirectory, 'rules'));
const triageInputMode = process.env.HIDS_TRIAGE_INPUT_MODE || 'syslog';
const triageMonitor = gateway && agent ? new TriageMonitor({ service: gateway, investigator: agent,
  history: investigationStore, file: runtime.triageMonitor,
  inputMode: triageInputMode, concurrency: triageInputMode === 'syslog' ? 1 : 2,
  eventToolbox: apiToolbox, wiki: wikiStore,
  ruleEngine: triageRuleEngine,
  casesDirectory: process.env.HIDS_CASES_DIR || runtime.cases,
  baselineFile: runtime.baseline,
  intelFile: runtime.intel }) : null;
const wikiWorkbench = new WikiWorkbench(wikiStore, model, promptStore, runtime.wikiSessions);

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

const traceBoard = agentToolbox && model ? new TraceBoardService({ toolbox: agentToolbox, model, promptStore,
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

// 校验：候选规则在临时目录里用真的 RuleStore 解析——只有规则子集内的语法能过，过不了就不落盘。
async function validateRego(id, rego) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rego-'));
  try {
    await writeFile(path.join(directory, `${id}.rego`), rego, { encoding: 'utf8', mode: 0o600 });
    const rule = await new RuleStore(directory).read(id);
    if (!rule) throw new Error(`规则正文的 package 与规则 id 不一致：${id}`);
    return rule;
  } finally { await rm(directory, { recursive: true, force: true }); }
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

// 写一份规则：临时文件 + rename，写完再整库装载一次——宁可这次维护失败，也不留半截规则或重复 id。
async function writeRuleFile(directory, file, rego) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${file}.${randomUUID()}.tmp`);
  await writeFile(temporary, rego, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path.join(directory, file)); }
  catch (cause) { await rm(temporary, { force: true }); throw cause; }
  await new RuleStore(directory).list();
}

/**
 * 规则维护者：拿一条已完成的误报案件，让模型改一条 Rego 或新增一条，校验通过才写进 `rules/<id>.rego`。
 * 返回 `{ id, file, name, action, rationale }`；任何一步不成立都抛错，调用方记 failed。
 * 不重写整本：只写这一份文件，同目录其它 `.rego` 一个字节都不动。
 */
export class RegoRuleMaintainer {
  constructor(model, ruleStore, prompts) { this.model = model; this.ruleStore = ruleStore; this.prompts = prompts; }

  async maintain({ caseId, eventType, reason, who, alert, ruleIds = [] }) {
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
    const read = await validateRego(id, rego);
    const existing = await this.ruleStore.read(id);
    // 第三道校验：改已有规则时原条件不许更宽。放在写盘之前——校验不过就一个字都不落，维护判 failed。
    if (existing) {
      const widened = widenedConditions(existing.rego, rego);
      if (widened.length)
        throw new Error(`规则修订放宽了原有限制条件，拒绝落盘：${widened.join('；').slice(0, 200)}`);
    }
    // 已有规则的 id 可能住在别的文件名里：改它就要写回它自己那份，不能另起一个同 id 的文件。
    const file = existing?.file || `${id}.rego`;
    await writeRuleFile(this.ruleStore.directory, file, rego);
    return { id, file, name: read.name, action: existing ? 'update' : 'add',
      rationale: String(output.reason || '').slice(0, 500) };
  }
}

const regoMaintainer = model ? new RegoRuleMaintainer(model, regoRuleStore, promptStore) : null;

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
    return ruleMaintainer.maintain({ caseId: record.alert_id, eventType: eventTypeFor(parsed?.msgid),
      reason: record.feedback.reason, who: record.feedback.who,
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
export function createServer(service = gateway, toolbox = apiToolbox, investigator = agent, history = investigationStore, prompts = promptStore, monitor = service === gateway ? triageMonitor : null, knowledge = null,
  access = { user: process.env.HIDS_BASIC_AUTH_USER, password: process.env.HIDS_BASIC_AUTH_PASSWORD }, boardService = service === gateway ? traceBoard : null,
  promptAdminToken = process.env.HIDS_PROMPT_ADMIN_TOKEN, wiki = wikiStore, wikiAgent = wikiWorkbench,
  maintenanceEntry = process.env.HIDS_MAINTENANCE_ENTRY_URL,
  ruleAdminToken = process.env.HIDS_RULE_ADMIN_TOKEN, ruleStore = regoRuleStore,
  ruleMaintainer = regoMaintainer) {
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
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configSummary());
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
      if (url.pathname === '/api/rules/evaluate' && req.method === 'POST') {
        let fact;
        try { fact = await readJSON(req); } catch (cause) { return callerError(res, cause.message); }
        if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) return callerError(res, '告警事实必须是 JSON 对象');
        try { return json(res, 200, await ruleStore.evaluate(fact)); }
        catch (cause) { return upstreamError(res, `规则求值失败：${cause.message}`); }
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

// 运行态路径的唯一真源（P003-T019）：全部落在仓库内 .data/，不经过仓库的上一级。
// 别改成「本文件所在目录的上一级」：部署时上一级是别人的目录，写出去的案卷/基线没人知道该去哪找。
// 旧版指的是 `<上一级>/backend/.data/`，那些目录里的既有数据不自动搬，要接着用就人工搬进仓内 .data/。
// 定义在这个位置（模块末尾）而不在顶部，是为了不挪动上面所有 `path:line` 引用的行号。
export function runtimePaths(directory = moduleDirectory) {
  const data = path.join(directory, '.data');
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
// 两件事共用一份判定，别在别处另写一套：进程入口拿它当启动闸门（缺必填就拒绝启动），
// `GET /api/config` 拿它对外报生效值。判定只认「有或没有」——值的形状仍由装配处抛（rpc-client.js:4-5、model-client.js:22-24）。
// 机密只出现在 secrets 里，值是布尔：响应体与日志里都不出现 Token / 密码原文（A3）。
const REQUIRED_CONFIG_KEYS = Object.freeze(['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);
const SECRET_CONFIG_KEYS = Object.freeze(['CLOUDWALKER_API_TOKEN', 'LLM_API_KEY', 'HIDS_BASIC_AUTH_PASSWORD',
  'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN']);

// env 可注入：单测直接传一个字面量对象，不碰真实 process.env。
// 缺省值与装配处逐条对齐——HIDS_HOST/HIDS_PORT 见 server.js:29-30、研判输入模式见 server.js:46。
export function configSummary(env = process.env) {
  return {
    host: env.HIDS_HOST || '127.0.0.1',
    port: Number(env.HIDS_PORT || 8080),
    triage_input_mode: env.HIDS_TRIAGE_INPUT_MODE || 'syslog',
    cloudwalker: { configured: Boolean(env.CLOUDWALKER_URL && env.CLOUDWALKER_API_TOKEN) },
    model: { configured: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL), name: env.LLM_MODEL || null },
    // 不配 Basic 口令 = 不启用鉴权（hasAccess 见 server.js:408），这是合法部署，不是缺配置。
    auth: { basic_auth_enabled: Boolean(env.HIDS_BASIC_AUTH_PASSWORD) },
    secrets: Object.fromEntries(SECRET_CONFIG_KEYS.map(name => [name, Boolean(env[name])])),
    missing_required: REQUIRED_CONFIG_KEYS.filter(name => !env[name])
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 启动闸门（P003-T025）：五项必填缺任一就不监听——把缺的键名逐个列到 stderr，退出码非 0。
  // 只拦这一条入口：createServer 仍可被测试与探针注入替身在进程内起来（缺能力就置空，路由 503）。
  const config = configSummary();
  if (config.missing_required.length) {
    const message = `缺少必填配置：${config.missing_required.join('、')}`;
    log('server.start_failed', { what: 'config', missing: config.missing_required, error: message }, 'error');
    process.stderr.write(`${message}\n`);
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
