// 会话 adapter —— 全前端唯一发 HTTP 的地方（组件里不许出现 fetch）。
//
// 数据来源：形态 B · openapi.yaml（GET /api/session，getSession）+ server.js:134 的实现。
//   200 → { authenticated: true }                （openapi.yaml:32-40，只此一个字段）
//   401 → 非 JSON 正文「需要登录后访问」+ WWW-Authenticate: Basic（server.js:70-74）
//   鉴权 → HTTP Basic，每个请求都校验（server.js:58-68 / :130）
// 会话接口没有账号名、没有角色字段 → 返回体里也没有，界面上就不显示（A3）。

import { authorizationHeader, base64 } from './credentials.js';

/** 归一后的错误：kind ∈ unauthorized | http | network | invalid */
export class SessionError extends Error {
  /**
   * @param {'unauthorized'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'SessionError';
    this.kind = kind;
    this.status = detail.status ?? null;
  }
}

/**
 * 用一对账号密码校验业务访问身份。
 * 解析成功（200 且 authenticated === true）返回 { authenticated: true }，其余一律抛 SessionError。
 *
 * @param {{ user: string, password: string }} credentials
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ authenticated: true }>}
 */
export async function probeSession(credentials, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = credentials
    ? `Basic ${base64(`${credentials.user}:${credentials.password}`)}`
    : authorizationHeader();
  if (!header) throw new SessionError('unauthorized', '缺少凭据');

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/session`, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new SessionError('network', '连接不上服务', { cause });
  }

  if (response.status === 401) {
    throw new SessionError('unauthorized', '账号或密码不正确', { status: 401 });
  }
  if (!response.ok) {
    throw new SessionError('http', `服务返回 ${response.status}`, { status: response.status });
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new SessionError('invalid', '会话接口返回的不是 JSON', { status: response.status });
  }
  if (!body || body.authenticated !== true) {
    throw new SessionError('invalid', '会话接口未确认身份', { status: response.status });
  }
  return { authenticated: true };
}
