// Rego 规则域 adapter —— 规则列表页与规则原文页**唯一**发 HTTP 的地方（页面里不许出现 fetch）。
//
// 数据来源：形态 B · 对接已就绪后端（P003-T011 已合入）。两个 operation 都是只读：
//   GET /api/rules        openapi.yaml:623-639（operationId listRegoRules），实现 server.js:559-562 → rule-store.js:207-210
//   GET /api/rules/{id}   openapi.yaml:664-684（operationId getRegoRule），实现   server.js:570-578 → rule-store.js:213-218
//
// 回包形状（逐字照文档 + 实现）：
//   list → { count, rules: [{ id, name, description, file }] }   按 id 升序；空规则库回 {count: 0, rules: []}，不是 404
//   read → { id, name, description, file, rego }                 rego 是整份 .rego 原文（含注释与空行，逐字返回）
//   description 可为 null（`# description:` 是可选的，rule-store.js:104-110）
//
// **列表没有 effect / enabled / source / updated_at**（openapi.yaml:1839-1847）。规则页上那三列是展示默认值，
// 由页面给（见 web/README.md §13），adapter 不编、不补、不从 rego 正文里猜。
//
// 错误码照实现（openapi 只写了 400 / 404 / 502）：
//   401 正文是纯文本「需要登录后访问」，不是 JSON（server.js:70-74）→ 按状态码处理，不解析正文
//   400 规则 id 不合格式（server.js:574；页面不会发这种 id，还是归一）
//   404 id 不存在（server.js:576）→ **不抛错，返回 null**：详情页要能在页面上说「规则库里已没有这条」
//   502 规则库装载失败（server.js:561/577），正文 `规则库读取失败：rules/<文件>:<行>: <原因>`
//       —— 这句原话要原样显示，它是唯一能定位到哪个 .rego 写错的信息
//
// 鉴权：每个请求 HTTP Basic（credentials.js 的内存凭据，server.js:130 的统一外壳）。

import { authorizationHeader } from './credentials.js';

/**
 * 归一后的错误。
 * kind：
 *   unauthorized —— 401，登录凭据失效（页面提示重新登录）
 *   http         —— 其它非 2xx（400 id 不合法 / 502 规则库装载失败 …），message 尽量是服务端原话
 *   network      —— fetch 抛了（连不上、断网）
 *   invalid      —— 2xx 但回包不是约定的形状
 */
export class RegoRulesError extends Error {
  /**
   * @param {'unauthorized'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'RegoRulesError';
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

/**
 * 发一次 GET 并返回解析后的 JSON；404 在 `allowNotFound` 时返回 null。
 * @param {string} path `/api/...`
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, allowNotFound?: boolean }} [options]
 */
async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = authorizationHeader();
  if (!header) throw new RegoRulesError('unauthorized', '缺少凭据，请重新登录');

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new RegoRulesError('network', '连接不上研判服务', { cause });
  }

  if (response.status === 401) throw new RegoRulesError('unauthorized', '登录已失效，请重新登录', { status: 401 });
  if (response.status === 404 && options.allowNotFound) return null;
  if (!response.ok) {
    const message = await serverMessage(response);
    throw new RegoRulesError('http', message ?? `服务返回 ${response.status}`, { status: response.status });
  }

  try {
    return await response.json();
  } catch {
    throw new RegoRulesError('invalid', '服务返回的不是 JSON', { status: response.status });
  }
}

/** description 是可选的：字符串原样，null / 缺键 / 别的类型都归一成 null（页面写「未写说明」）。 */
function descriptionOf(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * 列规则（元数据，不含 Rego 原文）。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ count: number, rules: { id: string, name: string, description: string|null, file: string }[] }>}
 */
export async function listRegoRules(options = {}) {
  const body = await request('/api/rules', options);
  if (!Number.isSafeInteger(body?.count) || !Array.isArray(body?.rules)) {
    throw new RegoRulesError('invalid', '规则列表接口没有返回 count / rules');
  }
  return {
    count: body.count,
    rules: body.rules.map(item => {
      if (typeof item?.id !== 'string' || !item.id || typeof item?.name !== 'string') {
        throw new RegoRulesError('invalid', '规则列表里有条目缺 id / name');
      }
      return {
        id: item.id,
        name: item.name,
        description: descriptionOf(item.description),
        file: typeof item.file === 'string' ? item.file : '',
      };
    }),
  };
}

/**
 * 按 id 读规则原文。id 不存在（404）返回 null，不抛错——详情页据此写「规则库里已没有这条」。
 * @param {string} id `package hids.rules.<id>` 的最后一段
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ id: string, name: string, description: string|null, file: string, rego: string }|null>}
 */
export async function getRegoRule(id, options = {}) {
  const value = String(id ?? '');
  if (!value) return null;
  const body = await request(`/api/rules/${encodeURIComponent(value)}`, { ...options, allowNotFound: true });
  if (body === null) return null;
  if (typeof body?.id !== 'string' || typeof body?.rego !== 'string') {
    throw new RegoRulesError('invalid', '规则接口没有返回 id / rego');
  }
  return {
    id: body.id,
    name: typeof body.name === 'string' && body.name ? body.name : body.id,
    description: descriptionOf(body.description),
    file: typeof body.file === 'string' ? body.file : '',
    rego: body.rego,
  };
}

/**
 * 错误 → 给人看的一句话（列表与原文两屏共用，口径只有这一处）。
 * `http` 直接用服务端原话：规则库装载失败时那句带 `rules/<文件>:<行>`，是唯一能定位哪份 .rego 写错的信息（server.js:561）。
 * @param {unknown} error
 * @returns {string}
 */
export function describeRegoRulesError(error) {
  if (error instanceof RegoRulesError) {
    if (error.kind === 'unauthorized') return '登录已失效，请重新登录。';
    if (error.kind === 'network') return '连接不上研判服务。';
    if (error.kind === 'invalid') return '规则接口返回的形状不对。';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}
