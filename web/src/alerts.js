// 告警域 adapter —— 告警页唯一发 HTTP 的地方（页面与视图里不许出现 fetch）。
//
// 数据来源：形态 B · 对接已就绪后端。四个 operation 都是本仓已有的：
//   GET  /api/alerts?count&offset        openapi.yaml:134-157，实现 server.js:335-345 → { alerts, total, totals, errors, partial }
//   GET  /api/agent/triage/status        openapi.yaml:178-189，实现 server.js:178-180 → TriageSummary
//   PUT  /api/agent/triage/control       openapi.yaml:211-234，实现 server.js:213-219 → TriageSummary（正文 { enabled: boolean }）
//   POST /api/agent/triage/{alertId}     openapi.yaml:235-260，实现 server.js:220-231 → 202 TriageCase
// 告警行字段来自 normalizeAlert（cloudwalker.js:31-56），研判子对象来自 monitor.status（triage-monitor.js:91-96）。
// 接口不给的一律不造（筛选/排序参数、条目级证据、账号身份都不在这里补）。
//
// 鉴权：HTTP Basic，每个请求都带 Authorization（凭据在内存，见 credentials.js:44）。

import { authorizationHeader } from './credentials.js';

/**
 * 归一后的错误。
 * kind：
 *   unauthorized —— 401，凭据失效（页面提示重新登录）
 *   unavailable  —— 503，后端没配好（牧云 / 自动研判），不是用户的错
 *   http         —— 其它非 2xx
 *   network      —— fetch 抛了（连不上、超时、断网）
 *   invalid      —— 2xx 但回包不是约定的形状
 */
export class AlertsError extends Error {
  /**
   * @param {'unauthorized'|'unavailable'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'AlertsError';
    this.kind = kind;
    this.status = detail.status ?? null;
  }
}

/**
 * 统一发一次请求并把失败归一成 AlertsError。成功时返回解析后的 JSON。
 * @param {string} path `/api/...`（可带查询串）
 * @param {{ method?: string, body?: unknown, fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 */
async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = authorizationHeader();
  if (!header) throw new AlertsError('unauthorized', '缺少凭据，请重新登录');

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
  } catch (cause) {
    throw new AlertsError('network', '连接不上研判服务');
  }

  if (response.status === 401) throw new AlertsError('unauthorized', '账号或密码已失效，请重新登录', { status: 401 });
  if (response.status === 503) throw new AlertsError('unavailable', '服务尚未配置好', { status: 503 });
  if (!response.ok) throw new AlertsError('http', `服务返回 ${response.status}`, { status: response.status });

  try {
    return await response.json();
  } catch {
    throw new AlertsError('invalid', '服务返回的不是 JSON', { status: response.status });
  }
}

/**
 * 读一页告警。
 * @param {{ count?: number, offset?: number }} [page] 接口只认这两个参数（server.js:337-339：count 1..50，offset ≥ 0）
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ alerts: object[], total: number, totals: object, errors: object, partial: boolean }>}
 */
export async function listAlerts(page = {}, options = {}) {
  const count = page.count ?? 20;
  const offset = page.offset ?? 0;
  const body = await request(`/api/alerts?count=${count}&offset=${offset}`, options);
  if (!body || !Array.isArray(body.alerts) || !Number.isSafeInteger(body.total)) {
    throw new AlertsError('invalid', '告警接口返回的形状不对');
  }
  return {
    alerts: body.alerts,
    total: body.total,
    totals: body.totals ?? {},
    errors: body.errors ?? {},
    partial: body.partial === true,
  };
}

/**
 * 自动研判队列汇总。
 * @returns {Promise<{ initialized: boolean, enabled: boolean, input_mode: string,
 *   counts: { queued?: number, running?: number, done?: number, failed?: number },
 *   last_poll_at: string|null, last_error: string|null }>}
 */
export async function fetchTriageSummary(options = {}) {
  const body = await request('/api/agent/triage/status', options);
  if (!body || typeof body.enabled !== 'boolean' || typeof body.counts !== 'object' || body.counts === null) {
    throw new AlertsError('invalid', '队列状态返回的形状不对');
  }
  return body;
}

/**
 * 暂停 / 恢复自动研判（正文 additionalProperties: false，只发 { enabled }）。
 * @param {boolean} enabled
 * @returns {Promise<object>} 更新后的 TriageSummary
 */
export async function setTriageEnabled(enabled, options = {}) {
  const body = await request('/api/agent/triage/control', { ...options, method: 'PUT', body: { enabled } });
  if (!body || typeof body.enabled !== 'boolean') {
    throw new AlertsError('invalid', '队列状态返回的形状不对');
  }
  return body;
}

/**
 * 手动入队 / 重试一条告警（正在跑的任务后端不会重复启动）。
 * @param {string} alertId 牧云事件 ID（形如 revshell:1）或 syslog 案件 ID
 * @returns {Promise<object>} TriageCase（alert_id / status / stage / detail / steps…）
 */
export async function enqueueTriage(alertId, options = {}) {
  const body = await request(`/api/agent/triage/${encodeURIComponent(alertId)}`, { ...options, method: 'POST' });
  if (!body || typeof body.status !== 'string') {
    throw new AlertsError('invalid', '入队结果返回的形状不对');
  }
  return body;
}
