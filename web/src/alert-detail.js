// 告警详情域 adapter —— 本页唯一发 HTTP 的地方（页面文件里不许出现 fetch）。
//
// 数据来源：形态 B · 对接已就绪后端。六个 operation 都是本仓已有的：
//   GET  /api/agent/triage/{alertId}               openapi.yaml 的 /api/agent/triage/{alertId}，实现 server.js:645
//                                                  → TriageCase（**P003-T015 起是本页的首要数据源**：研判记录）
//   GET  /api/rules/{id}                           openapi.yaml:660-680「规则元数据与整份 .rego 原文」，
//                                                  实现 server.js:570-578 → rule-store.js read（A3：命中的 Rego）
//   GET  /api/alerts/{alertId}                     openapi.yaml:158-176，实现 server.js:347-355 → cloudwalker.js:148-163
//                                                  （牧云事件；syslog 案件可能对不上，对不上时本页照常打开）
//   POST /api/agent/triage/{alertId}               openapi.yaml:249-260，实现 server.js:231（202 TriageCase）
//   GET  /api/agent/investigations/{alertId}?mode  openapi.yaml:295-312，实现 server.js:326-333 → investigation-store.js:33-40
//   GET  /api/trace/boards/{target}                openapi.yaml:353-371，实现 server.js:169-176 → trace-board.js:74-85
//
// 字段逐字照实现（实现比文档细的地方以实现为准）：
//   TriageCase.steps[] 元素是 { stage, detail, at }（triage-monitor.js:343、:356）
//   Investigation.verdict.rego = { status, rule_ids[] }；verdict.wiki = { consulted[], adopted[], reason }
//     （investigation-agent.js:689-694；A3 的「命中的 Rego 或没有套上」「用过的 wiki」读这两个键）
//   Investigation.verdict.claims[] 元素是 { text, citations[{evidence_id,pointer,value}] }（investigation-agent.js:55）
//   Investigation.required_evidence[] 元素的 status 是五值枚举（required-evidence.js:120-140）
// 接口不给的一律不造（人工复核人/时间、步骤工具名与耗时、证据分类与事实文本都不在这里补）。
//
// 鉴权：HTTP Basic，每个请求都带 Authorization（凭据在内存，见 credentials.js:44）。

import { authorizationHeader } from './credentials.js';

/**
 * 归一后的错误。
 * kind：
 *   unauthorized —— 401，凭据失效（页面提示重新登录）
 *   unavailable  —— 503，后端没配好（牧云 / 自动研判），不是用户的错
 *   invalid_id   —— 400，告警 ID 格式或事件类型无效（页面按「没有这条告警」处理）
 *   not_found    —— 404
 *   http         —— 其它非 2xx（含 502 牧云读不到）
 *   network      —— fetch 抛了（连不上、超时、断网）
 *   invalid      —— 2xx 但回包不是约定的形状
 */
export class AlertDetailError extends Error {
  /**
   * @param {'unauthorized'|'unavailable'|'invalid_id'|'not_found'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'AlertDetailError';
    this.kind = kind;
    this.status = detail.status ?? null;
  }
}

/** 告警 ID 进路径要编码：`revshell:1` → `revshell%3A1`（服务端 decodeURIComponent 后再匹配，server.js:346、:328、:223） */
function alertPath(alertId) {
  return encodeURIComponent(String(alertId));
}

/**
 * 统一发一次请求并把失败归一成 AlertDetailError。成功时返回解析后的 JSON。
 * @param {string} path `/api/...`（可带查询串）
 * @param {{ method?: string, fetchImpl?: typeof fetch, baseUrl?: string, allowNotFound?: boolean }} [options]
 *   allowNotFound=true 时 404 不抛，返回 null（「没有这条记录」是一种事实，不是错误）
 */
async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = authorizationHeader();
  if (!header) throw new AlertDetailError('unauthorized', '缺少凭据，请重新登录');

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new AlertDetailError('network', '连接不上研判服务');
  }

  if (response.status === 401) throw new AlertDetailError('unauthorized', '账号或密码已失效，请重新登录', { status: 401 });
  if (response.status === 503) throw new AlertDetailError('unavailable', '服务尚未配置好', { status: 503 });
  if (response.status === 400) throw new AlertDetailError('invalid_id', '告警 ID 无效', { status: 400 });
  if (response.status === 404) {
    if (options.allowNotFound) return null;
    throw new AlertDetailError('not_found', '记录不存在', { status: 404 });
  }
  if (!response.ok) throw new AlertDetailError('http', `服务返回 ${response.status}`, { status: response.status });

  try {
    return await response.json();
  } catch {
    throw new AlertDetailError('invalid', '服务返回的不是 JSON', { status: response.status });
  }
}

/**
 * 告警本体 + 牧云原始事件。
 * @param {string} alertId 形如 `revshell:1`
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ alert: object, detail: object }>}
 *   alert 是 normalizeAlert 的返回（cloudwalker.js:31-56）；detail 是牧云原始事件对象（自由 object）
 */
export async function getAlert(alertId, options = {}) {
  const body = await request(`/api/alerts/${alertPath(alertId)}`, options);
  const alert = body?.alert;
  if (!alert || typeof alert !== 'object' || typeof alert.id !== 'string') {
    throw new AlertDetailError('invalid', '告警详情返回的形状不对');
  }
  // detail 文档写的是自由 object（openapi.yaml:175）；实现回的是牧云原始事件。不是对象就当空，页面只画「没有原始字段」
  const detail = body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail) ? body.detail : {};
  return { alert, detail };
}

/**
 * 单条研判记录（未入队时 status 为 not_queued）。
 * @param {string} alertId 牧云事件 ID 或 syslog 案件 ID
 * @returns {Promise<object>} TriageCase（alert_id / status / stage / verdict_label / steps[]…）
 */
export async function getTriageRecord(alertId, options = {}) {
  const body = await request(`/api/agent/triage/${alertPath(alertId)}`, options);
  if (!body || typeof body.status !== 'string') {
    throw new AlertDetailError('invalid', '研判记录返回的形状不对');
  }
  return body;
}

/**
 * 手动入队 / 重试这条告警（正在跑的任务后端不会重复启动）。
 * @param {string} alertId
 * @returns {Promise<object>} 202 之后的 TriageCase
 */
export async function enqueueTriage(alertId, options = {}) {
  const body = await request(`/api/agent/triage/${alertPath(alertId)}`, { ...options, method: 'POST' });
  if (!body || typeof body.status !== 'string') {
    throw new AlertDetailError('invalid', '入队结果返回的形状不对');
  }
  return body;
}

/**
 * 已保存的研判结果。404 = 这条告警还没跑过该模式，返回 null（不是错误）。
 * @param {string} alertId
 * @param {{ mode?: 'triage'|'deep' }} [query] 默认 triage（常规研判）
 * @returns {Promise<object|null>} Investigation（verdict / review / validation / trace / required_evidence / evidence）
 */
export async function getInvestigation(alertId, query = {}, options = {}) {
  const mode = query.mode === 'deep' ? 'deep' : 'triage';
  const body = await request(`/api/agent/investigations/${alertPath(alertId)}?mode=${mode}`, { ...options, allowNotFound: true });
  if (body === null) return null;
  if (!body || typeof body.mode !== 'string' || !body.verdict || typeof body.verdict !== 'object') {
    throw new AlertDetailError('invalid', '研判结果返回的形状不对');
  }
  return body;
}

/**
 * 一条 Rego 规则的元数据与整份原文（A3：详情里要给出命中的 Rego 正文）。
 * 404 = 规则已不在库里（历史记录里留的 rule_id 可能已被维护者删掉），返回 null 不是错误。
 * @param {string} id 规则 id（形如 `ssh_bruteforce`；`GET /api/rules/{id}` 的路径段）
 * @returns {Promise<{id: string, name: string, description: string, file: string, rego: string}|null>}
 */
export async function getRule(id, options = {}) {
  const body = await request(`/api/rules/${encodeURIComponent(String(id))}`, { ...options, allowNotFound: true });
  if (body === null) return null;
  if (!body || typeof body.id !== 'string' || typeof body.rego !== 'string') {
    throw new AlertDetailError('invalid', '规则返回的形状不对');
  }
  return {
    id: body.id,
    name: typeof body.name === 'string' ? body.name : body.id,
    description: typeof body.description === 'string' ? body.description : '',
    file: typeof body.file === 'string' ? body.file : '',
    rego: body.rego,
  };
}

/**
 * 溯源白板（关联实体从这里取）。404 = 这条告警还没跑过深度溯源，返回 null。
 * @param {string} target 告警 ID 或 IPv4
 * @returns {Promise<object|null>} TraceBoard（nodes[] 元素含 id / label / address / kind / status）
 */
export async function getTraceBoard(target, options = {}) {
  const body = await request(`/api/trace/boards/${alertPath(target)}`, { ...options, allowNotFound: true });
  if (body === null) return null;
  if (!body || !Array.isArray(body.nodes)) {
    throw new AlertDetailError('invalid', '溯源白板返回的形状不对');
  }
  return body;
}
