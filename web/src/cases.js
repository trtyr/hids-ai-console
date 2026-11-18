// 研判记录域 adapter —— 告警主列表与详情页读研判记录的唯一发 HTTP 的地方（页面里不许出现 fetch）。
//
// 数据来源：形态 B · 对接已就绪后端（D020：主列表是推送进来的研判记录，不是牧云现查）。
//
//   GET  /api/agent/triage/cases?count&offset&verdict&type&host&from&to&sort
//                                         openapi.yaml 的 /api/agent/triage/cases，实现 server.js:570-579
//                                         → triage-monitor.js:114-151 → { total, cases: TriageCaseListItem[] }
//   GET  /api/agent/triage/{alertId}      openapi.yaml 的 /api/agent/triage/{alertId}，实现 server.js:645
//                                         → monitor.status() 或 { alert_id, status: 'not_queued', evidence: [] }
//   POST /api/agent/triage/{alertId}      实现 server.js:646 → 202 TriageCase（重新入队 / 重试）
//   GET  /api/agent/triage/status         实现 server.js:537-543 → TriageSummary（队列条）
//   PUT  /api/agent/triage/control        实现 server.js:580-586 → TriageSummary（正文 { enabled }）
//   POST /api/agent/triage/{alertId}/false-positive
//                                         openapi.yaml 的 reportFalsePositive，实现 server.js:588-643
//                                         正文 { reason, who? } → 202 FalsePositiveRecord
//
// 两条硬事实（页面据此显示，不要再往上「补」）：
//   - cases 接口只列**有原始 syslog 报文**的记录（triage-monitor.js:115 `filter(record => record.input)`）；
//     列表项没有 steps，单条查询才有（openapi.yaml 的 TriageCase 说明）。
//   - 未入队 / 非法 ID 的区别靠状态码：400 = 告警 ID 无效，200 + status:'not_queued' = 没有这条研判。
//     主列表与详情**都不需要牧云**：牧云没配时这两条路径照常工作（A4）。
//
// 鉴权：HTTP Basic，每个请求都带 Authorization（凭据在内存，见 credentials.js:44）。

import { authorizationHeader } from './credentials.js';

/**
 * 归一后的错误。
 * kind：
 *   unauthorized —— 401，凭据失效（页面提示重新登录）
 *   unavailable  —— 503，后端没配好（自动研判未配置），不是用户的错
 *   invalid_id   —— 400，告警 ID 或筛选值无效
 *   not_found    —— 404，找不到这条研判案件（误报登记时）
 *   conflict     —— 409，研判还没结束，不能登记误报
 *   http         —— 其它非 2xx
 *   network      —— fetch 抛了（连不上、超时、断网）
 *   invalid      —— 2xx 但回包不是约定的形状
 */
export class CasesError extends Error {
  /**
   * @param {'unauthorized'|'unavailable'|'invalid_id'|'not_found'|'conflict'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'CasesError';
    this.kind = kind;
    this.status = detail.status ?? null;
  }
}

/** 服务端错误体是 `{ error: "<中文说明>" }`（server.js:57）；有就取出来给人看。 */
async function serverMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' && body.error ? body.error : null;
  } catch {
    return null;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 统一发一次请求并把失败归一成 CasesError。成功时返回解析后的 JSON。
 * @param {string} path `/api/...`（可带查询串）
 * @param {{ method?: string, body?: unknown, fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 */
async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = authorizationHeader();
  if (!header) throw new CasesError('unauthorized', '缺少凭据，请重新登录');

  const init = {
    method: options.method ?? 'GET',
    headers: { Authorization: header, Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
  };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, init);
  } catch {
    throw new CasesError('network', '连接不上研判服务');
  }

  if (response.status === 401) throw new CasesError('unauthorized', '账号或密码已失效，请重新登录', { status: 401 });
  if (!response.ok) {
    const message = await serverMessage(response);
    const kind = response.status === 400 ? 'invalid_id'
      : response.status === 404 ? 'not_found'
        : response.status === 409 ? 'conflict'
          : response.status === 503 ? 'unavailable'
            : 'http';
    throw new CasesError(kind, message ?? `服务返回 ${response.status}`, { status: response.status });
  }

  try {
    return await response.json();
  } catch {
    throw new CasesError('invalid', '服务返回的不是 JSON', { status: response.status });
  }
}

/** 案件 ID / 告警 ID 进路径要编码：`syslog:webshell:…` 里的冒号（server.js:645 decodeURIComponent） */
function casePath(alertId) {
  return encodeURIComponent(String(alertId));
}

/**
 * 读一页研判记录。
 *
 * 参数逐字照接口（server.js:364-382 caseQuery）：
 *   verdict  threat/uncertain/false_positive/review（可多选，页面只传一个）
 *   type     事件类型键（msgid 映射后的类型）
 *   host     主机 IP，精确匹配
 *   from/to  RFC3339 或秒/毫秒时间戳；按 syslog 事件时间比（含端点）
 *   sort     time（默认，最新在前）/ verdict（threat → uncertain → false_positive → 无结论）
 * 空串 / undefined 的参数不发出（不把 `type=` 发给服务端当非法值）。
 *
 * @param {{ count?: number, offset?: number, verdict?: string, type?: string, host?: string,
 *   from?: string, to?: string, sort?: string }} [page]
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ cases: object[], total: number }>}
 */
export async function listCases(page = {}, options = {}) {
  const params = new URLSearchParams();
  params.set('count', String(page.count ?? 20));
  params.set('offset', String(page.offset ?? 0));
  const filters = { verdict: page.verdict, type: page.type, host: page.host, from: page.from, to: page.to, sort: page.sort };
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }
  const body = await request(`/api/agent/triage/cases?${params.toString()}`, options);
  if (!body || !Array.isArray(body.cases) || !Number.isSafeInteger(body.total)) {
    throw new CasesError('invalid', '案件列表返回的形状不对');
  }
  return { cases: body.cases, total: body.total };
}

/**
 * 单条研判记录（未入队时 status 为 `not_queued`，200 不是 404）。
 * @param {string} alertId syslog 案件 ID 或牧云事件 ID
 * @returns {Promise<object>} TriageCase（alert_id / status / stage / verdict / verdict_label /
 *   summary / report / rule_id / repeat_count / evidence[] / evidence_refs[] / steps[] / maintenance…）
 */
export async function getCase(alertId, options = {}) {
  const body = await request(`/api/agent/triage/${casePath(alertId)}`, options);
  if (!isPlainObject(body) || typeof body.status !== 'string') {
    throw new CasesError('invalid', '研判记录返回的形状不对');
  }
  return body;
}

/**
 * 重新入队 / 重试这条研判（正在跑的任务后端不会重复启动，server.js:646）。
 * @param {string} alertId
 * @returns {Promise<object>} 202 之后的 TriageCase
 */
export async function enqueueCase(alertId, options = {}) {
  const body = await request(`/api/agent/triage/${casePath(alertId)}`, { ...options, method: 'POST' });
  if (!isPlainObject(body) || typeof body.status !== 'string') {
    throw new CasesError('invalid', '入队结果返回的形状不对');
  }
  return body;
}

/**
 * 登记误报（带理由）。后端先写结论再回 202，两个维护者在后台跑（server.js:611-643）。
 * 理由 10–4000 字、登记人至少 2 字是服务端口径，页面先自己拦一遍再发。
 * @param {string} alertId
 * @param {{ reason: string, who?: string }} input
 * @returns {Promise<{ alert_id: string, verdict: object, feedback: object, maintenance: object }>} FalsePositiveRecord
 */
export async function reportFalsePositive(alertId, input, options = {}) {
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 10 || reason.length > 4000) throw new CasesError('invalid_id', '误报理由必须为 10 到 4000 字');
  const body = { reason };
  const who = typeof input?.who === 'string' ? input.who.trim() : '';
  if (who) body.who = who;

  const result = await request(`/api/agent/triage/${casePath(alertId)}/false-positive`, { ...options, method: 'POST', body });
  if (!isPlainObject(result) || !isPlainObject(result.verdict) || !isPlainObject(result.maintenance)) {
    throw new CasesError('invalid', '误报登记返回的形状不对');
  }
  return result;
}

/**
 * 自动研判队列汇总（告警页队列条用）。
 * @returns {Promise<{ enabled: boolean, inputMode: string|null, counts: object,
 *   lastError: string|null, lastReceivedAt: string|null }>}
 */
export async function fetchQueueStatus(options = {}) {
  const body = await request('/api/agent/triage/status', options);
  if (!isPlainObject(body) || typeof body.enabled !== 'boolean' || !isPlainObject(body.counts)) {
    throw new CasesError('invalid', '队列状态返回的形状不对');
  }
  return {
    enabled: body.enabled,
    inputMode: typeof body.input_mode === 'string' ? body.input_mode : null,
    counts: body.counts,
    lastError: typeof body.last_error === 'string' && body.last_error ? body.last_error : null,
    lastReceivedAt: typeof body.last_received_at === 'string' ? body.last_received_at : null,
  };
}

/**
 * 暂停 / 恢复自动研判（正文 additionalProperties: false，只发 { enabled }）。
 * @param {boolean} enabled
 * @returns {Promise<object>} 归一后的队列状态（同 fetchQueueStatus）
 */
export async function setQueueEnabled(enabled, options = {}) {
  const body = await request('/api/agent/triage/control', { ...options, method: 'PUT', body: { enabled } });
  if (!isPlainObject(body) || typeof body.enabled !== 'boolean' || !isPlainObject(body.counts)) {
    throw new CasesError('invalid', '队列状态返回的形状不对');
  }
  return {
    enabled: body.enabled,
    inputMode: typeof body.input_mode === 'string' ? body.input_mode : null,
    counts: body.counts,
    lastError: typeof body.last_error === 'string' && body.last_error ? body.last_error : null,
    lastReceivedAt: typeof body.last_received_at === 'string' ? body.last_received_at : null,
  };
}
