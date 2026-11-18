// 总览页的数据 adapter —— 本页唯一发 HTTP 的地方（页面文件里不许出现 fetch）。
//
// 数据来源：形态 B（对接已就绪后端）。字段逐字照 openapi.yaml，出处对账见
// evidence/recon/P002-T002.md §三。本页不进后端文档的字段一个都不用：
//
//     GET  /api/agent/triage/status[?since=] → enabled / input_mode / last_poll_at /
//                                       last_received_at / last_error / counts /
//                                       verdict_counts / type_counts / syslog
//                                       （T010 起的聚合；P003-T015 用它取代下面那路牧云现查）
//     —— 原 `GET /api/alerts?count=1`（total / totals / errors / partial）在 P003-T015 移除：
//        D020 明写「数字来自研判记录，不来自牧云现查」，总览不再为了有数去拉牧云（A1）。
//     GET  /api/status                → configured / connected / reason     openapi.yaml:42-70
//                                       （502 也回这个体：连接失败但配置在）
//     GET  /api/agent/status          → configured / prompt_version         openapi.yaml:97-104
//     GET  /api/agent/tools           → count（未配置时 503）               openapi.yaml:97-104 / :886-897
//     GET  /api/triage/rules          → revision（16-hex 或 null）          openapi.yaml:851-857
//     GET  /api/updates               → revision                           server.js:135
//     PUT  /api/agent/triage/control  → 正文 { enabled }，回 TriageSummary  openapi.yaml:211-234
//
// 取数策略（写进 web/README.md §9）：
//   - 六路并行，互不拖累；某一路失败只让**它对应的那几行**显示「—」，不让整页空白。
//   - 六路全失败（后端连不上 / 全 5xx）→ 抛 OverviewError，页面显示整页错误态。
//   - 任何一路 401 → 抛 OverviewError('unauthorized')：凭据失效是会话问题，不是「部分数据缺失」。

import { authorizationHeader } from './credentials.js';

/** 归一后的错误：kind ∈ unauthorized | http | network | invalid */
export class OverviewError extends Error {
  /**
   * @param {'unauthorized'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number|null, cause?: unknown }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'OverviewError';
    this.kind = kind;
    this.status = detail.status ?? null;
    this.cause = detail.cause;
  }
}

/**
 * 六个只读源，顺序即页面上的报错顺序。
 * P003-T015 起没有 `alerts` 这一路：总览的数字全部来自研判聚合（A1），不拉牧云现查。
 */
export const SOURCE_KEYS = ['triage', 'cloud', 'agent', 'tools', 'rules', 'updates'];

const SOURCES = {
  // 带 since 时三个聚合都只算该时刻后进入队列的记录（server.js:537-543）
  triage: { path: '/api/agent/triage/status', sincePath: since => `/api/agent/triage/status?since=${encodeURIComponent(since)}`, normalize: normalizeTriage },
  // 502 是「配置在、连不上」，正文照样是 {configured, connected, reason}（openapi.yaml:56-70）
  cloud: { path: '/api/status', acceptStatus: [200, 502], normalize: normalizeCloud },
  agent: { path: '/api/agent/status', normalize: normalizeAgent },
  tools: { path: '/api/agent/tools', normalize: normalizeTools },
  rules: { path: '/api/triage/rules', normalize: normalizeRules },
  updates: { path: '/api/updates', normalize: normalizeUpdates },
};

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const countOf = value => (isCount(value) ? value : 0);
const stringOrNull = value => (typeof value === 'string' && value !== '' ? value : null);

/** 结论分布的四个键恒在（openapi.yaml 的 TriageSummary.verdict_counts required） */
export const VERDICT_KEYS = ['threat', 'uncertain', 'false_positive', 'review'];

function normalizeTriage(body) {
  if (!isPlainObject(body)) throw new OverviewError('invalid', '队列状态不是对象');
  if (!isPlainObject(body.counts)) throw new OverviewError('invalid', '队列状态缺少 counts');
  if (!isPlainObject(body.verdict_counts)) throw new OverviewError('invalid', '队列状态缺少 verdict_counts');
  if (!isPlainObject(body.type_counts)) throw new OverviewError('invalid', '队列状态缺少 type_counts');
  const { counts, verdict_counts: verdictCounts, type_counts: typeCounts } = body;

  // 结论四键是接口的 required（openapi.yaml 的 TriageSummary.verdict_counts）：缺一个就整源 invalid，
  // 不拿 0 假装「没有真实威胁」——那会把漏读画成好消息。
  for (const key of VERDICT_KEYS) {
    if (!isCount(verdictCounts[key])) throw new OverviewError('invalid', `队列状态的 verdict_counts.${key} 不是非负整数`);
  }

  const types = {};
  for (const [type, value] of Object.entries(typeCounts)) if (isCount(value)) types[type] = value;

  // syslog 仅 input_mode=syslog 时出现，三态：未绑定 / 在听 / 绑定失败（openapi.yaml 的 TriageSummary.syslog）
  let syslog = null;
  if (isPlainObject(body.syslog)) {
    syslog = {
      listening: body.syslog.listening === true,
      bind: stringOrNull(body.syslog.bind),
      error: stringOrNull(body.syslog.error),
    };
  }

  return {
    enabled: body.enabled === true,
    inputMode: stringOrNull(body.input_mode),
    lastPollAt: stringOrNull(body.last_poll_at),
    lastReceivedAt: stringOrNull(body.last_received_at),
    lastError: stringOrNull(body.last_error),
    since: stringOrNull(body.since),
    counts: {
      queued: countOf(counts.queued),
      running: countOf(counts.running),
      done: countOf(counts.done),
      failed: countOf(counts.failed),
    },
    verdictCounts: {
      threat: countOf(verdictCounts.threat),
      uncertain: countOf(verdictCounts.uncertain),
      false_positive: countOf(verdictCounts.false_positive),
      review: countOf(verdictCounts.review),
    },
    typeCounts: types,
    syslog,
  };
}

function normalizeCloud(body) {
  if (!isPlainObject(body)) throw new OverviewError('invalid', '牧云状态不是对象');
  if (typeof body.configured !== 'boolean' || typeof body.connected !== 'boolean') {
    throw new OverviewError('invalid', '牧云状态缺少 configured / connected');
  }
  return { configured: body.configured, connected: body.connected, reason: stringOrNull(body.reason) };
}

function normalizeAgent(body) {
  if (!isPlainObject(body)) throw new OverviewError('invalid', '研判服务状态不是对象');
  if (typeof body.configured !== 'boolean') throw new OverviewError('invalid', '研判服务状态缺少 configured');
  return { configured: body.configured, promptVersion: stringOrNull(body.prompt_version) };
}

function normalizeTools(body) {
  if (!isPlainObject(body) || !isCount(body.count)) throw new OverviewError('invalid', '取证工具目录缺少 count');
  return { count: body.count };
}

function normalizeRules(body) {
  if (!isPlainObject(body)) throw new OverviewError('invalid', '规则配置不是对象');
  return { revision: stringOrNull(body.revision) };
}

function normalizeUpdates(body) {
  if (!isPlainObject(body)) throw new OverviewError('invalid', '版本信息不是对象');
  return { revision: stringOrNull(body.revision) };
}

/**
 * 一个只读 GET。非 2xx（除 acceptStatus 指定的）一律抛 OverviewError。
 * @param {string} path
 * @param {{ fetchImpl: typeof fetch, baseUrl: string, header: string, acceptStatus: number[] }} context
 */
async function getJSON(path, { fetchImpl, baseUrl, header, acceptStatus }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new OverviewError('network', '连接不上服务', { cause });
  }
  if (response.status === 401) throw new OverviewError('unauthorized', '登录已失效', { status: 401 });
  if (!acceptStatus.includes(response.status)) {
    throw new OverviewError('http', `服务返回 ${response.status}`, { status: response.status });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new OverviewError('invalid', '接口返回的不是 JSON', { status: response.status, cause });
  }
}

function requireHeader() {
  const header = authorizationHeader();
  if (!header) throw new OverviewError('unauthorized', '缺少凭据');
  return header;
}

/**
 * 读总览页需要的六路数据。
 *
 * 成功返回：
 *   { triage, system: { cloud, agent, tools, rules, updates },
 *     failed: string[], fetchedAt: Date, since: string|null }
 * 每个源成功时是 `{ ok: true, ...归一后的字段 }`，失败时是 `{ ok: false, error: OverviewError }`。
 * 六路全失败 / 任一路 401 时整体抛 OverviewError。
 *
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, now?: () => Date, since?: string|null }} [options]
 *   since：聚合起点（RFC3339 或秒/毫秒时间戳，接口自己归一）；null/省略＝全部
 */
export async function loadOverview(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const now = options.now ?? (() => new Date());
  const since = typeof options.since === 'string' && options.since.trim() ? options.since.trim() : null;
  const header = requireHeader();

  const settled = await Promise.allSettled(
    SOURCE_KEYS.map(key => {
      const source = SOURCES[key];
      const path = since && source.sincePath ? source.sincePath(since) : source.path;
      return getJSON(path, { fetchImpl, baseUrl, header, acceptStatus: source.acceptStatus ?? [200] })
        .then(body => source.normalize(body));
    }),
  );

  const sources = {};
  settled.forEach((item, index) => {
    const key = SOURCE_KEYS[index];
    sources[key] = item.status === 'fulfilled'
      ? { ok: true, ...item.value }
      : { ok: false, error: item.reason instanceof OverviewError ? item.reason : new OverviewError('invalid', String(item.reason?.message || item.reason)) };
  });

  const failed = SOURCE_KEYS.filter(key => !sources[key].ok);
  const expired = failed.find(key => sources[key].error.kind === 'unauthorized');
  if (expired) throw new OverviewError('unauthorized', '登录已失效，请重新登录', { status: 401 });
  if (failed.length === SOURCE_KEYS.length) throw sources[SOURCE_KEYS[0]].error;

  return {
    triage: sources.triage,
    system: { cloud: sources.cloud, agent: sources.agent, tools: sources.tools, rules: sources.rules, updates: sources.updates },
    failed,
    fetchedAt: now(),
    since,
  };
}

/**
 * 暂停 / 恢复自动研判（本页唯一的写操作）。
 * 成功返回归一后的 TriageSummary（形状同 GET /api/agent/triage/status）。
 *
 * @param {boolean} enabled
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 */
export async function setTriageEnabled(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new OverviewError('invalid', 'enabled 必须是布尔值');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = requireHeader();

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/agent/triage/control`, {
      method: 'PUT',
      headers: { Authorization: header, Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({ enabled }),
    });
  } catch (cause) {
    throw new OverviewError('network', '连接不上服务', { cause });
  }
  if (response.status === 401) throw new OverviewError('unauthorized', '登录已失效', { status: 401 });
  if (!response.ok) throw new OverviewError('http', `服务返回 ${response.status}`, { status: response.status });
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new OverviewError('invalid', '接口返回的不是 JSON', { status: response.status, cause });
  }
  return normalizeTriage(body);
}

const pad = value => (value < 10 ? `0${value}` : String(value));

/**
 * 本机时刻 `HH:MM:SS`——稿的「更新时间」就是本机时钟（overview.html 里的 stamp()），接口没有这个字段。
 * @param {Date} date
 */
export function formatClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * ISO 时间戳 → 本机 `YYYY-MM-DD HH:mm:ss`；空值给「—」，解析不了一律原样返回（不吞数据）。
 * @param {string|null} value
 */
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
