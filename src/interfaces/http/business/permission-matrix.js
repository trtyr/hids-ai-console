// 业务端权限矩阵（P003-T071 A19）：每个写动作「谁能做、要哪个令牌、这次请求能不能做」。
// 判定与路由守卫共用 shared/token-auth.js 的同一份实现——矩阵说 allowed=true 的路由一定不会回 403。
// 前端据此渲染按钮，不再硬编码哪条路由要哪个头。
import { basicAccess, promptAdminAccess, ruleAdminAccess } from '../../../shared/token-auth.js';

// 业务端全部写动作（GET/查询不列）。token 为 null 表示只要业务 Basic 账号。
export const writeActions = Object.freeze([
  { action: 'config.write', method: 'POST', path: '/api/config', token: null },
  { action: 'data.cleanup', method: 'POST', path: '/api/data/cleanup', token: null },
  { action: 'logs.cleanup', method: 'POST', path: '/api/logs/cleanup', token: null },
  { action: 'triage.control', method: 'PUT', path: '/api/agent/triage/control', token: null },
  { action: 'triage.verdict', method: 'POST', path: '/api/agent/triage/{alertId}', token: null },
  { action: 'triage.cancel', method: 'DELETE', path: '/api/agent/triage/{alertId}', token: null },
  { action: 'false-positive.record', method: 'POST', path: '/api/agent/triage/{alertId}/false-positive', token: null },
  { action: 'batch.write', method: 'POST', path: '/api/batch/{action}', token: null },
  { action: 'investigation.start', method: 'POST', path: '/api/agent/investigations', token: null },
  { action: 'trace.start', method: 'POST', path: '/api/trace/boards', token: null },
  { action: 'wiki.page.write', method: 'PUT', path: '/api/wiki/pages/{pagePath}', token: null },
  { action: 'rules.write', method: 'PUT', path: '/api/rules/{id}', token: 'X-Rule-Admin-Token' },
  { action: 'rules.rollback', method: 'POST', path: '/api/rules/{id}/rollback', token: 'X-Rule-Admin-Token' },
  { action: 'triage-rules.write', method: 'PUT', path: '/api/triage/rules', token: 'X-Rule-Admin-Token' },
  { action: 'triage-rules.rollback', method: 'POST', path: '/api/triage/rules/rollback', token: 'X-Rule-Admin-Token' },
  { action: 'prompt.write', method: 'PUT', path: '/api/agent/prompts/{section}', token: 'X-Prompt-Admin-Token' },
  { action: 'wiki.maintain', method: 'POST', path: '/api/wiki/sessions', token: 'X-Prompt-Admin-Token' }
]);

export function permissionMatrix({ access = null, headers = {}, promptAdminToken = null,
  ruleAdminToken = null, maintenanceEntry = null } = {}) {
  const business = basicAccess(headers, access);
  const tokens = {
    'X-Prompt-Admin-Token': { configured: Boolean(promptAdminToken),
      supplied: typeof headers['x-prompt-admin-token'] === 'string',
      valid: promptAdminAccess(headers, promptAdminToken) },
    'X-Rule-Admin-Token': { configured: Boolean(ruleAdminToken),
      supplied: typeof headers['x-rule-admin-token'] === 'string',
      valid: ruleAdminAccess(headers, ruleAdminToken) }
  };
  const actions = writeActions.map(({ action, method, path, token }) => {
    const requires = ['business_auth', ...(token ? [token] : [])];
    // blocked_by 与守卫的三种回法一一对应：Basic 没过 / 令牌没配（503）/ 令牌没带或不对（403）。
    const blockedBy = !business ? 'business_auth'
      : token && !tokens[token].valid ? (tokens[token].configured ? 'token_missing_or_invalid' : 'token_not_configured')
        : null;
    return { action, method, path, requires, allowed: blockedBy === null, blocked_by: blockedBy };
  });
  return {
    business_auth: { enabled: Boolean(access?.password), passed: business },
    tokens,
    actions,
    maintenance: {
      entry_url: maintenanceEntry || null,
      note: '升级包应用只在维护端 18081（独立维护账号 + CSRF + 回环限制）；业务端不代理，只读包元数据（GET /api/updates/packages）。'
    }
  };
}
