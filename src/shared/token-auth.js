// 令牌与 Basic 认证的**唯一**判定实现（P003-T071 A19）。
// 原来三份 timingSafeEqual 判定住在 server.js：权限矩阵要与真实守卫「同一口径」，
// 判定就得摘成共享叶子——矩阵拿到的 allowed 和路由真正放不放行必须是同一个函数算出来的。
// 只依赖 node:crypto，不碰 fs/上下文。
import { timingSafeEqual } from 'node:crypto';

function matches(supplied, expected) {
  if (typeof expected !== 'string' || !expected) return false;
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** 业务 Basic 认证：没配密码 = 不启用认证（任何人可进）；配了就比 `user:password`。 */
export function basicAccess(headers = {}, access = null) {
  if (!access?.password) return true;
  const header = headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  return matches(Buffer.from(header.slice(6), 'base64').toString('utf8'), `${access.user || 'admin'}:${access.password}`);
}

/** 知识库管理员令牌（X-Prompt-Admin-Token）：没配令牌 = 只读模式，一律不放行。 */
export const promptAdminAccess = (headers = {}, token = null) => matches(headers['x-prompt-admin-token'], token);

/** 规则管理员令牌（X-Rule-Admin-Token）：没配令牌 = 只读模式，一律不放行。 */
export const ruleAdminAccess = (headers = {}, token = null) => matches(headers['x-rule-admin-token'], token);
