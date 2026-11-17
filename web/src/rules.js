// 规则域 adapter —— 前置规则页唯一发 HTTP 的地方（页面与视图里不许出现 fetch）。
//
// 数据来源：形态 B · 对接已就绪后端。三个 operation 都是本仓已有的：
//   GET  /api/triage/rules            openapi.yaml:372-382，实现 server.js:181-184
//   POST /api/triage/rules/validate   openapi.yaml:406-431，实现 server.js:186-192
//   PUT  /api/triage/rules            openapi.yaml:383-405，实现 server.js:193-204
//
// 回包形状照文档 + 实现（文档模糊处以实现为准，逐条写在 web/README.md 本页一节）：
//   GET      → { config, revision, writable }          openapi.yaml:851-857（additionalProperties: true）
//              实现另外给 origin（file|example|invalid）与 error（配置坏时的原因），triage-rules.js:223-238。
//              页面只用前三个；多给的两个原样带回，不渲染（稿上没有对应区块）。
//   validate → { valid: true, count }                  count 是 config.rules.length（server.js:190）
//   PUT      → { config, origin, revision }            保存成功后用返回的 revision（server.js:201-202）
//
// 错误码照实现（openapi 没写全）：
//   401 正文是纯文本「需要登录后访问」，不是 JSON（server.js:70-74）→ 按状态码处理，不解析正文
//   403 规则管理员令牌无效（server.js:195）
//   409 规则配置已变化，请刷新后重试（triage-rules.js:245；文档没写这一档）
//   503 未配置规则管理员令牌（server.js:194）；GET 读取失败是 502（server.js:183；文档同样没写）
//   400 正文/校验不合法，正文 { error }（server.js:57）
//
// 鉴权：每个请求 HTTP Basic（server.js:130）；PUT 另需 X-Rule-Admin-Token（:79-86）。
//   规则管理员令牌是页面本地状态，不进 credentials.js —— 那里放的是登录凭据。

import { authorizationHeader } from './credentials.js';

/** PUT 的管理令牌头（openapi.yaml:729 `ruleAdminToken`） */
export const RULE_ADMIN_TOKEN_HEADER = 'X-Rule-Admin-Token';

/**
 * 归一后的错误。
 * kind：
 *   unauthorized —— 401，登录凭据失效（页面提示重新登录）
 *   forbidden    —— 403，管理令牌不对（可改令牌重试，不丢编辑）
 *   conflict     —— 409，revision 过期（要刷新，不丢编辑）
 *   unavailable  —— 503，服务端没配规则管理员令牌
 *   http         —— 其它非 2xx（400 校验失败 / 502 读取失败 …）
 *   network      —— fetch 抛了（连不上、断网）
 *   invalid      —— 2xx 但回包不是约定的形状
 */
export class RulesError extends Error {
  /**
   * @param {'unauthorized'|'forbidden'|'conflict'|'unavailable'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'RulesError';
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

/** 非 2xx → 归一成 RulesError（不返回） */
async function fail(response) {
  const status = response.status;
  if (status === 401) throw new RulesError('unauthorized', '登录已失效，请重新登录', { status });
  const message = await serverMessage(response);
  const kind = status === 403 ? 'forbidden'
    : status === 409 ? 'conflict'
      : status === 503 ? 'unavailable'
        : 'http';
  throw new RulesError(kind, message ?? `服务返回 ${status}`, { status });
}

/**
 * 发一次请求并返回解析后的 JSON。
 * @param {string} path `/api/...`
 * @param {{ method?: string, body?: unknown, token?: string, fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 */
async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = authorizationHeader();
  if (!header) throw new RulesError('unauthorized', '缺少凭据，请重新登录');

  const headers = { Authorization: header, Accept: 'application/json' };
  const init = { method: options.method ?? 'GET', headers, credentials: 'omit', cache: 'no-store' };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.token) headers[RULE_ADMIN_TOKEN_HEADER] = options.token;

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new RulesError('network', '连接不上研判服务', { cause });
  }
  if (!response.ok) await fail(response);

  try {
    return await response.json();
  } catch {
    throw new RulesError('invalid', '服务返回的不是 JSON', { status: response.status });
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 读前置规则集。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ config: object, revision: string|null, writable: boolean, origin: string|null, error: string|null }>}
 */
export async function getRules(options = {}) {
  const body = await request('/api/triage/rules', options);
  if (!isPlainObject(body?.config)) throw new RulesError('invalid', '规则接口没有返回 config 对象');
  if (typeof body.writable !== 'boolean') throw new RulesError('invalid', '规则接口没有返回 writable');
  const revision = body.revision ?? null;
  if (revision !== null && typeof revision !== 'string') throw new RulesError('invalid', '规则接口的 revision 不是字符串');
  return {
    config: body.config,
    revision,
    writable: body.writable,
    origin: typeof body.origin === 'string' ? body.origin : null,
    error: typeof body.error === 'string' ? body.error : null,
  };
}

/**
 * 校验规则草稿。失败（400 / 403 / 409 / 503 / 网络）一律抛 RulesError，正文原话在 message 里。
 * @param {object} config
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ valid: true, count: number }>}
 */
export async function validateRules(config, options = {}) {
  const body = await request('/api/triage/rules/validate', { ...options, method: 'POST', body: { config } });
  if (body?.valid !== true || !Number.isSafeInteger(body?.count)) {
    throw new RulesError('invalid', '校验接口没有返回 valid / count');
  }
  return { valid: true, count: body.count };
}

/**
 * 以预期版本保存规则集。`expectedRevision` 必须是上一次 GET/PUT 返回的 revision（或 null）。
 * @param {{ config: object, expectedRevision: string|null, token: string, fetchImpl?: typeof fetch, baseUrl?: string }} input
 * @returns {Promise<{ config: object, revision: string, origin: string|null }>}
 */
export async function saveRules(input) {
  const { config, expectedRevision = null, token } = input;
  const body = await request('/api/triage/rules', {
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
    method: 'PUT',
    body: { config, expected_revision: expectedRevision },
    token,
  });
  const revision = typeof body?.revision === 'string' && body.revision ? body.revision : null;
  if (!revision || !isPlainObject(body?.config)) {
    throw new RulesError('invalid', '保存接口没有返回新的 config / revision');
  }
  return { config: body.config, revision, origin: typeof body.origin === 'string' ? body.origin : null };
}
