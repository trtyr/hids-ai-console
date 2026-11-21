// 审计上下文 · 领域层（P003-T062 / D034 §2）。
//
// AuditEvent 是 append-only 聚合：谁（actor）在何时（at）对什么对象（object）做了什么（action），
// 结果（result）与前后值（before/after）一并留痕，request_id 把审计事件与技术日志串起来（T072）。
// 不变量：actor 必须可识别（登录身份或显式标注 token 级，不允许留空）；机密值只记「已改」不记明文。
export const AUDIT_ACTIONS = Object.freeze([
  // 配置与身份
  'config.write',
  // 研判队列与案件
  'triage.enqueue', 'triage.control', 'triage.cancel', 'triage.dispose',
  // 误报与维护
  'false-positive.register', 'fp.session.write', 'rule.maintain', 'wiki.maintain', 'wiki.publish',
  // 规则库与判据库
  'rule.write', 'rule.rollback', 'triage-rules.write',
  'wiki.page.write',
  // 研判与溯源
  'investigation.run', 'trace.start',
  // 数据运维
  'data.cleanup', 'logs.cleanup',
  // 维护端
  'maintenance.login', 'maintenance.logout', 'maintenance.package.stage', 'maintenance.package.apply',
  // 处置闭环（T063）
  'case.dispose', 'case.assign'
]);

/**
 * 构造一条审计事件（纯函数，不含 I/O）。
 * @param {object} spec
 *   actor：`{ kind: 'user'|'token'|'system', id: string }`——kind=token 时不带明文，id 是「哪条令牌」的描述。
 *   action：AUDIT_ACTIONS 之一。
 *   object：被操作对象（如 `{ kind: 'config', keys: [...] }` / `{ kind: 'rule', id }` / `{ kind: 'case', alert_id }`）。
 *   before / after：机密字段只写 '[redacted-changed]'；调用方用 `redactValues()` 处理。
 *   result：'ok' | 'denied' | 'error'（错误详情不进审计，进技术日志）。
 *   requestId：T072 的请求链 id；系统动作可为 null。
 */
export function auditEvent(spec) {
  const { actor, action, object = null, before = null, after = null, result = 'ok', requestId = null } = spec || {};
  if (!actor || !actor.kind || !actor.id) throw new Error('审计事件缺少可识别的 actor（user/token/system 三选一）');
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`未知审计动作：${action}`);
  if (!['ok', 'denied', 'error'].includes(result)) throw new Error(`审计结果非法：${result}`);
  const event = {
    at: new Date().toISOString(),
    actor: { kind: String(actor.kind), id: String(actor.id).slice(0, 200) },
    action,
    object: object && typeof object === 'object' ? object : null,
    before: before ?? null,
    after: after ?? null,
    result,
    request_id: requestId ?? null
  };
  return event;
}

// 机密键：值一律不落审计（新旧都只记「已改」）。
const SECRET_KEYS = /token|password|secret|api[-_]?key|authorization|cookie/i;

/**
 * 写入前 / 写入后的值做机密擦除：机密键的值换成 '[redacted-changed]'（说明「改过」但不留原文），
 * 其余值原样保留（配置的非机密键值就是审计要看的「新旧值」）。
 */
export function redactValues(values) {
  if (!values || typeof values !== 'object') return values;
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted-changed]' : (typeof value === 'string' ? value.slice(0, 500) : value);
  }
  return out;
}
