// 溯源域 adapter —— 深度溯源两页（列表 + 白板）唯一发 HTTP 的地方（页面与视图里不许出现 fetch）。
//
// 数据来源：形态 B · 对接已就绪后端。三个 operation 都是本仓已有的：
//   GET  /api/trace/boards            openapi.yaml:456-500，实现 server.js:493-502 → { boards, total }
//   POST /api/trace/boards            openapi.yaml:503-543，实现 server.js:503-514 → 200 已有 / 202 新建 TraceBoard
//   GET  /api/trace/boards/{target}   openapi.yaml:544-560，实现 server.js:515-524 → TraceBoard
//
// 白板主数据是 hops / links / gaps / discovery（D016；openapi.yaml:1778-1800）。旧字段 nodes / edges / activity
// 后端仍留在返回里（向后兼容，`trace-board.js:126` 的 `...board`），本 adapter 不把它们当主数据，也不校验。
// 接口不给的一律不造（跳的坐标、证据正文、工具调用都不在这里补）。
//
// 鉴权：HTTP Basic，每个请求都带 Authorization（凭据在内存，见 credentials.js:44）。

import { authorizationHeader } from './credentials.js';

/**
 * 归一后的错误。
 * kind：
 *   unauthorized —— 401，凭据失效（页面提示重新登录）
 *   unavailable  —— 503，后端没配好（模型或牧云 MCP 未配置），不是用户的错
 *   notfound     —— 404，这个目标还没有白板（正常空态，不是故障）
 *   http         —— 其它非 2xx（400 目标无效 / 422 没有可用资产 / 502 启动失败 …）
 *   network      —— fetch 抛了（连不上、断网）
 *   invalid      —— 2xx 但回包不是约定的形状
 */
export class TraceError extends Error {
  /**
   * @param {'unauthorized'|'unavailable'|'notfound'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'TraceError';
    this.kind = kind;
    this.status = detail.status ?? null;
  }
}

/** 服务端的错误体是 `{ error: "<中文说明>" }`（server.js:57）；有就取出来给人看。 */
async function serverMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' && body.error ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * 统一发一次请求并把失败归一成 TraceError。成功时返回解析后的 JSON。
 * @param {string} path `/api/...`
 * @param {{ method?: string, body?: unknown, fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 */
async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = authorizationHeader();
  if (!header) throw new TraceError('unauthorized', '缺少凭据，请重新登录');

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
    throw new TraceError('network', '连接不上研判服务');
  }

  if (response.status === 401) throw new TraceError('unauthorized', '账号或密码已失效，请重新登录', { status: 401 });
  if (response.status === 503) {
    throw new TraceError('unavailable', await serverMessage(response) ?? '深度溯源尚未配置', { status: 503 });
  }
  if (response.status === 404) throw new TraceError('notfound', '该目标还没有溯源白板', { status: 404 });
  if (!response.ok) {
    const detail = await serverMessage(response);
    throw new TraceError('http', detail ?? `服务返回 ${response.status}`, { status: response.status });
  }

  try {
    return await response.json();
  } catch {
    throw new TraceError('invalid', '服务返回的不是 JSON', { status: response.status });
  }
}

/** 白板的约定形状：id + hops / links / discovery 三个数组（gaps 可为空但必须是数组或缺失）。 */
function asBoard(body) {
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' ||
    !Array.isArray(body.hops) || !Array.isArray(body.links) || !Array.isArray(body.discovery)) {
    throw new TraceError('invalid', '白板返回的形状不对');
  }
  return { ...body, gaps: Array.isArray(body.gaps) ? body.gaps : [] };
}

/**
 * 列出已保存的白板（列表页的一行 = 一条溯源，D015）。
 * 筛选与分页全部下推给接口，前端不自筛（参数口径见 openapi.yaml:456-500）：
 *   count(1-50) / offset / status（多选，逗号分隔）/ type（事件类型名）/ host（精确）/ from / to（RFC3339 或时间戳）
 * @param {{ count?: number, offset?: number, statuses?: string[], type?: string, host?: string, from?: string, to?: string }} [query]
 * @returns {Promise<{ boards: object[], total: number }>} 每项是 TraceBoardSummary
 */
export async function listTraceBoards(query = {}, options = {}) {
  const params = new URLSearchParams();
  if (query.count !== undefined) params.set('count', String(query.count));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const statuses = (query.statuses ?? []).filter(Boolean);
  if (statuses.length) params.set('status', statuses.join(','));
  for (const key of ['type', 'host', 'from', 'to']) {
    if (query[key]) params.set(key, String(query[key]));
  }
  const search = params.toString();
  const body = await request(`/api/trace/boards${search ? `?${search}` : ''}`, options);
  if (!body || !Array.isArray(body.boards)) throw new TraceError('invalid', '白板列表返回的形状不对');
  const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : body.boards.length;
  return { boards: body.boards, total };
}

/**
 * 读一个白板（进度与结果）。
 * @param {string} target 告警 ID（形如 revshell:1）或 IPv4；冒号要编码（openapi.yaml:361）
 * @returns {Promise<object>} TraceBoard
 */
export async function getTraceBoard(target, options = {}) {
  const body = await request(`/api/trace/boards/${encodeURIComponent(String(target))}`, options);
  return asBoard(body);
}

/**
 * 从告警 ID 或 IPv4 启动一次溯源（已有白板回 200、新建回 202，两种情况都是整块 TraceBoard）。
 * @param {string} target 告警 ID / IPv4 / `ip:<IPv4>`
 * @returns {Promise<object>} TraceBoard（status 通常已是 running）
 */
export async function startTraceBoard(target, options = {}) {
  const body = await request('/api/trace/boards', { ...options, method: 'POST', body: { target: String(target) } });
  return asBoard(body);
}
