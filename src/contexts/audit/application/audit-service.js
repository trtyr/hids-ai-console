// 审计应用服务（P003-T062）：HTTP 层的唯一记账入口。
// 谁来记：每个**写接口**在用例成功/失败处调 `auditor(...)`；只读接口不调（acceptance：GET 不产生事件）。
// request_id 从 T072 的 ALS 请求上下文自动取——审计事件与技术日志由此串成一条链。
import { auditEvent, redactValues } from '../domain/audit-event.js';

export function createAuditor(store, { currentRequestContext = () => null } = {}) {
  /**
   * 记一条审计事件。任何失败都不上抛（审计失败不能搞崩业务，降级只进技术日志）。
   * @param {object} spec
   *   actor：{ kind, id }（kind ∈ user|token|system）；HTTP 语境下由 actorOf() 生成。
   *   action：见 domain/audit-event.js 的 AUDIT_ACTIONS。
   *   object / before / after：机密值必须先过 redactValues()。
   *   result：'ok'（缺省）| 'denied' | 'error'。
   */
  const audit = spec => {
    try {
      const ctx = currentRequestContext();
      const event = auditEvent({ requestId: ctx?.request_id ?? null, ...spec });
      return store.record(event);
    } catch { return Promise.resolve(null); }
  };
  audit.redactValues = redactValues;
  return audit;
}

/** 身份三态：Basic 登录用户 / 静态 admin 令牌（不含明文）/ 系统内部。无鉴权部署显式标 anonymous。 */
export function actorOf({ access = null, tokenKind = null, system = false } = {}) {
  if (system) return { kind: 'system', id: 'backend' };
  if (tokenKind) return { kind: 'token', id: tokenKind }; // 'rule-admin' | 'prompt-admin'
  if (access?.password) return { kind: 'user', id: access.user || 'admin' };
  return { kind: 'user', id: 'anonymous' }; // 未配 Basic 的部署：如实标注，不留空
}

/** 配置写入的 before/after：只记改过的键，机密值换成「已改」标记。 */
export function configAuditValues(beforeValues, patch) {
  const keys = Object.keys(patch || {});
  const before = {}, after = {};
  for (const key of keys) {
    before[key] = beforeValues?.[key] ?? null;
    after[key] = patch[key];
  }
  return { before: redactValues(before), after: redactValues(after) };
}
