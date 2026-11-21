import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { repositoryRoot } from '../../../shared/data-root.js';
import { fileURLToPath } from 'node:url';
import { reasonForRecord } from '../../../shared/redaction.js';

const exampleFile = path.join(repositoryRoot(), 'triage-rules.example.json');

const fields = {
  network_audit: new Set(['source_ip', 'destination_ip', 'network_type', 'process_path', 'command_line', 'detection_reference', 'user_name']),
  abnormal_login: new Set(['source_ip', 'destination_ip', 'user_name', 'auth_type', 'rule_subject', 'abnormal_type']),
  brute_force: new Set(['source_ip', 'destination_ip', 'user_name', 'auth_service', 'success_count', 'failure_count']),
  webshell: new Set(['file_path', 'sha256', 'detection_reference']),
  malware: new Set(['file_path', 'sha256', 'detection_reference']),
  revshell: new Set(['source_ip', 'destination_ip', 'shell_command', 'process_path']),
  memory_webshell: new Set(['server_name', 'class_name', 'sha256', 'detection_reference']),
  elevation_process: new Set(['process_path', 'command_line', 'origin_uid', 'target_uid', 'privilege_escalation_type']),
  suspicious_operation: new Set(['source_ip', 'destination_ip', 'connection_type', 'rule_name', 'process_path', 'command_line', 'user_name', 'session_id']),
  honeypot: new Set(['source_ip', 'honeypot_address', 'honeypot_type']),
  memory_security: new Set(['plugin_id', 'strategy_id', 'origin_method', 'detection_reference'])
};
const required = {
  network_audit: ['source_ip', 'destination_ip', 'network_type', 'process_path', 'command_line', 'detection_reference'],
  abnormal_login: ['source_ip', 'destination_ip', 'user_name', 'auth_type', 'rule_subject', 'abnormal_type'],
  brute_force: ['source_ip', 'destination_ip', 'user_name', 'auth_service', 'success_count', 'failure_count'],
  webshell: ['file_path', 'sha256', 'detection_reference'],
  malware: ['file_path', 'sha256', 'detection_reference'],
  revshell: ['source_ip', 'destination_ip', 'shell_command', 'process_path'],
  memory_webshell: ['server_name', 'class_name', 'sha256', 'detection_reference'],
  elevation_process: ['process_path', 'command_line', 'origin_uid', 'target_uid', 'privilege_escalation_type'],
  suspicious_operation: ['source_ip', 'destination_ip', 'connection_type', 'rule_name', 'process_path', 'command_line', 'user_name'],
  honeypot: ['source_ip', 'honeypot_address', 'honeypot_type'],
  memory_security: ['plugin_id', 'strategy_id', 'origin_method', 'detection_reference']
};
const legacyActions = new Set(['observe', 'review_false_positive', 'classify_false_positive']);
const numericFields = new Set(['success_count', 'failure_count', 'abnormal_type', 'origin_uid', 'target_uid']);
const directFields = {
  webshell: { file_path: 'path', sha256: 'sha256', detection_reference: 'detect_reason' },
  malware: { file_path: 'path', sha256: 'sha256', detection_reference: 'detect_reason' },
  revshell: { source_ip: 'local_addr', destination_ip: 'remote_addr', shell_command: 'shell_cmdline', process_path: 'process_path' },
  memory_webshell: { server_name: 'server_name', class_name: 'class_name', sha256: 'sha256', detection_reference: 'detect_reason' },
  elevation_process: { process_path: 'exepath', command_line: 'cmdline', origin_uid: 'origin_uid', target_uid: 'target_uid', privilege_escalation_type: 'privilege_escalation_type' },
  suspicious_operation: { source_ip: 'ssh_client_ip', connection_type: 'type', rule_name: 'rule_name', process_path: 'path', command_line: 'cmdline', user_name: 'uname', session_id: 'session_id' },
  honeypot: { source_ip: 'source_ip', honeypot_address: 'address', honeypot_type: 'type' },
  memory_security: { plugin_id: 'plugin_id', strategy_id: 'strategy_id', origin_method: 'origin_method', detection_reference: 'detect_reason' }
};
const exactIp = value => typeof value === 'string' && isIP(value) > 0 && !['0.0.0.0', '::'].includes(value);
const ipValue = value => {
  if (typeof value !== 'string') return null;
  const plain = value.trim().replace(/\/32$/, '');
  if (exactIp(plain)) return plain;
  const ipv4Port = plain.match(/^((?:\d{1,3}\.){3}\d{1,3}):\d+$/);
  if (ipv4Port && exactIp(ipv4Port[1])) return ipv4Port[1];
  const ipv6Port = plain.match(/^\[([^\]]+)\]:\d+$/);
  return ipv6Port && exactIp(ipv6Port[1]) ? ipv6Port[1] : null;
};
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value :
  typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const text = value => typeof value === 'string' ? value.trim() : '';
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function cidrMatch(ip, prefix) {
  const [network, bits] = prefix.split('/');
  if (isIP(ip) !== 4 || isIP(network) !== 4) return false;
  const asInt = address => address.split('.').reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return (asInt(ip) & mask) === (asInt(network) & mask);
}

function validateRule(rule) {
  if (!plainObject(rule) || !/^[A-Za-z0-9_-]{3,64}$/.test(rule.id || '') ||
    !Object.hasOwn(fields, rule.event_type) || !legacyActions.has(rule.action) ||
    typeof rule.enabled !== 'boolean' || !Number.isSafeInteger(rule.host_id) || rule.host_id < 1 ||
    !text(rule.reason) || !text(rule.approved_by) ||
    (rule.action === 'review_false_positive' && !rule.source_alert_id) ||
    (rule.source_alert_id != null && rule.source_alert_id !== '' &&
      !new RegExp(`^${rule.event_type}:[1-9][0-9]*$`).test(rule.source_alert_id)) ||
    !validDate(rule.valid_from) || !validDate(rule.expires_at) ||
    Date.parse(rule.valid_from) >= Date.parse(rule.expires_at) || !Array.isArray(rule.conditions) ||
    Object.keys(rule).some(key => !['id', 'enabled', 'action', 'event_type', 'host_id', 'source_alert_id', 'reason',
      'approved_by', 'valid_from', 'expires_at', 'conditions'].includes(key)))
    throw new Error(`规则 ${rule?.id || '未知'} 元数据无效`);
  if (rule.conditions.length < required[rule.event_type].length || rule.conditions.length > fields[rule.event_type].size)
    throw new Error(`规则 ${rule.id} 条件数量无效`);
  const seen = new Set();
  for (const condition of rule.conditions) {
    if (!plainObject(condition) || !fields[rule.event_type].has(condition.field) || seen.has(condition.field))
      throw new Error(`规则 ${rule.id} 包含重复或不适用的字段`);
    if (Object.keys(condition).some(key => !['field', 'operator', 'value'].includes(key)))
      throw new Error(`规则 ${rule.id} 的条件包含未知字段`);
    seen.add(condition.field);
    if (condition.operator === 'equals') {
      if (['source_ip', 'destination_ip'].includes(condition.field) ? !exactIp(condition.value) :
        numericFields.has(condition.field) ?
          integer(condition.value) === null || integer(condition.value) < 0 ||
            condition.field === 'abnormal_type' && ![1, 2, 3].includes(integer(condition.value)) :
          typeof condition.value !== 'string' || !text(condition.value) || condition.value.length > 512)
        throw new Error(`规则 ${rule.id} 的 ${condition.field} 值无效`);
    } else if (condition.operator === 'cidr' && condition.field === 'source_ip') {
      const parts = String(condition.value || '').split('/');
      if (parts.length !== 2 || isIP(parts[0]) !== 4 || !/^\d+$/.test(parts[1]) || Number(parts[1]) < 24 || Number(parts[1]) > 32)
        throw new Error(`规则 ${rule.id} 的来源网段须为 IPv4 /24 至 /32`);
    } else if (condition.operator === 'lte' && condition.field === 'failure_count') {
      if (integer(condition.value) === null || integer(condition.value) < 1 || integer(condition.value) > 200)
        throw new Error(`规则 ${rule.id} 的失败次数上限无效`);
    } else throw new Error(`规则 ${rule.id} 的操作符不适用于 ${condition.field}`);
    if (condition.field === 'sha256' && !/^[a-fA-F0-9]{64}$/.test(condition.value))
      throw new Error(`规则 ${rule.id} 的 sha256 必须是 64 位十六进制哈希`);
  }
  if (required[rule.event_type].some(field => !seen.has(field))) throw new Error(`规则 ${rule.id} 缺少场景必需字段`);
  const byField = Object.fromEntries(rule.conditions.map(condition => [condition.field, condition]));
  if (rule.event_type === 'network_audit' &&
    (byField.network_type.operator !== 'equals' || byField.network_type.value !== 'ip'))
    throw new Error(`规则 ${rule.id} 仅支持牧云网络异常的 IP 类型`);
  if (rule.event_type === 'brute_force' &&
    (byField.success_count.operator !== 'equals' || integer(byField.success_count.value) !== 0 ||
      byField.failure_count.operator !== 'lte'))
    throw new Error(`规则 ${rule.id} 需要零次成功认证和失败次数上限`);
  if (rule.event_type === 'suspicious_operation' &&
    (byField.connection_type.operator !== 'equals' || byField.connection_type.value !== 'ssh'))
    throw new Error(`规则 ${rule.id} 仅支持来源可核验的 SSH 命令场景`);
}

export function validateRuleSet(config) {
  if (!plainObject(config) || config.schema_version !== 1 || typeof config.enabled !== 'boolean' ||
    !Array.isArray(config.rules) || config.rules.length > 200 ||
    Object.keys(config).some(key => !['schema_version', 'enabled', 'rules'].includes(key)))
    throw new Error('规则集格式无效');
  const ids = new Set();
  for (const rule of config.rules) {
    validateRule(rule);
    if (ids.has(rule.id)) throw new Error(`规则 ID 重复：${rule.id}`);
    ids.add(rule.id);
  }
  return config;
}

function fact(eventType, detail, field) {
  const hostIp = ipValue(detail.host_view?.host_ip || detail.host_ip);
  if (field === 'destination_ip' && ['abnormal_login', 'brute_force'].includes(eventType))
    return { value: hostIp, evidence_value: detail.host_view?.host_ip || detail.host_ip,
      pointer: detail.host_view?.host_ip ? '/host_view/host_ip' : '/host_ip' };
  if (eventType === 'suspicious_operation' && field === 'destination_ip')
    return { value: hostIp, evidence_value: detail.host_view?.host_ip || detail.host_ip,
      pointer: detail.host_view?.host_ip ? '/host_view/host_ip' : '/host_ip' };
  if (directFields[eventType]) {
    const key = directFields[eventType][field];
    return { value: numericFields.has(field) ? integer(detail[key]) :
      ['source_ip', 'destination_ip'].includes(field) ? ipValue(detail[key]) : text(detail[key]),
    evidence_value: detail[key], pointer: `/${key}` };
  }
  if (eventType === 'network_audit') {
    const map = { source_ip: ['local_addr', ipValue], destination_ip: ['target', ipValue],
      network_type: ['type', text], process_path: ['process_path', text], command_line: ['cmdline', text],
      detection_reference: ['reference', text], user_name: ['uname', text] };
    const [key, transform] = map[field];
    return { value: transform(detail[key]), evidence_value: detail[key], pointer: `/${key}` };
  }
  if (eventType === 'abnormal_login') {
    const map = { source_ip: ['login_ip', ipValue], user_name: ['login_username', text],
      auth_type: ['auth_type', text], rule_subject: ['rule_subject', text],
      abnormal_type: ['login_abnormal_type', integer] };
    const [key, transform] = map[field];
    return { value: transform(detail[key]), evidence_value: detail[key], pointer: `/${key}` };
  }
  if (field === 'source_ip') {
    const rows = detail.time_aix || detail.time_axis;
    if (!Array.isArray(rows) || !rows.length) return { value: null, pointer: '/time_aix' };
    const sources = [...new Set(rows.map(row => ipValue(row.source_ip)).filter(Boolean))];
    return { value: sources.length === 1 && rows.every(row => ipValue(row.source_ip)) ? sources[0] : null,
      evidence_value: rows[0].source_ip, pointer: detail.time_aix ? '/time_aix/0/source_ip' : '/time_axis/0/source_ip' };
  }
  if (field === 'user_name') {
    const rows = detail.time_aix || detail.time_axis;
    if (!Array.isArray(rows) || !rows.length) return { value: null, pointer: '/time_aix' };
    const users = [...new Set(rows.map(row => text(row.user_name)).filter(Boolean))];
    return { value: users.length === 1 && rows.every(row => text(row.user_name)) ? users[0] : null,
      evidence_value: rows[0].user_name, pointer: detail.time_aix ? '/time_aix/0/user_name' : '/time_axis/0/user_name' };
  }
  const map = { auth_service: ['auth_service', text], success_count: ['success_count', integer],
    failure_count: ['failure_count', integer] };
  const [key, transform] = map[field];
  return { value: transform(detail[key]), evidence_value: detail[key], pointer: `/${key}` };
}

function sameSyslogFacts(type, parsed, detail) {
  if (!parsed) return true;
  const payload = parsed.payload || {};
  if (!['network_audit', 'abnormal_login', 'brute_force'].includes(type)) return integer(payload.event_id) === integer(detail.id ?? detail.event_id) &&
    integer(payload.host_id) === integer(detail.host_id ?? detail.host_view?.host_id) &&
    ipValue(payload.host_ip) === ipValue(detail.host_view?.host_ip || detail.host_ip) &&
    (type !== 'suspicious_operation' ||
      (payload.process_command_line == null || text(payload.process_command_line) === text(detail.cmdline)) &&
      (payload.user_name == null || text(payload.user_name) === text(detail.uname)));
  const sourceField = type === 'network_audit' ? 'local_addr' : type === 'abnormal_login' ? 'login_ip' : 'source_ip';
  const source = ipValue(payload[sourceField]);
  const apiSource = fact(type, detail, 'source_ip').value;
  return integer(payload.event_id) === integer(detail.id ?? detail.event_id) &&
    integer(payload.host_id) === integer(detail.host_id ?? detail.host_view?.host_id) &&
    ipValue(payload.host_ip) === ipValue(detail.host_view?.host_ip || detail.host_ip) &&
    source !== null && source === apiSource &&
    (type !== 'network_audit' || text(payload.abnormal_reference) === text(detail.reference) &&
      text(payload.process_path) === text(detail.process_path) &&
      text(payload.process_command_line) === text(detail.cmdline)) &&
    (type !== 'abnormal_login' || text(payload.user_name) === text(detail.login_username) &&
      text(payload.auth_type) === text(detail.auth_type)) &&
    (type !== 'brute_force' || integer(payload.success_count) === integer(detail.success_count) &&
      integer(payload.failure_count) === integer(detail.failure_count));
}

function conditionMatches(condition, value) {
  if (value === null || value === undefined || value === '') return false;
  if (condition.operator === 'cidr') return cidrMatch(value, condition.value);
  if (condition.operator === 'lte') return Number(value) <= Number(condition.value);
  return typeof value === 'number' ? value === Number(condition.value) : value === condition.value;
}

export class TriageRuleEngine {
  constructor(filename) { this.filename = filename; this.pending = Promise.resolve(); }

  async readConfig() {
    let source, origin = 'file';
    try { source = await readFile(this.filename, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      source = await readFile(exampleFile, 'utf8');
      origin = 'example';
    }
    const revision = origin === 'file' ? createHash('sha256').update(source).digest('hex').slice(0, 16) : null;
    try { return { config: validateRuleSet(JSON.parse(source)), origin, revision }; }
    catch (error) {
      if (origin === 'example') throw error;
      // 接口侧不写错误原文（P003-T054）：`error` 随 `GET /api/triage/rules` 出接口，而 JSON.parse 的 message
      // 会把配置文件前 ~10 字原样抄出来——只留固定文案 + 字符量。
      return { config: validateRuleSet(JSON.parse(await readFile(exampleFile, 'utf8'))),
        origin: 'invalid', revision, error: reasonForRecord(error.message) };
    }
  }

  saveConfig(config, expectedRevision) {
    const job = this.pending.catch(() => {}).then(async () => {
      validateRuleSet(config);
      const current = await this.readConfig();
      if (current.revision !== expectedRevision) {
        const error = new Error('规则配置已变化，请刷新后重试'); error.status = 409; throw error;
      }
      const source = `${JSON.stringify(config, null, 2)}\n`;
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filename);
      return { config, origin: 'file', revision: createHash('sha256').update(source).digest('hex').slice(0, 16) };
    });
    this.pending = job.catch(() => {});
    return job;
  }

  async evaluate({ alertId, parsed = null, toolbox, match = null }) {
    let source;
    try { source = await readFile(this.filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { status: 'disabled', reason: '未配置规则集' };
      return { status: 'error', reason: `规则集读取失败：${error.message}` };
    }
    let config;
    try { config = validateRuleSet(JSON.parse(source)); }
    catch (error) { return { status: 'error', reason: `规则集校验失败：${error.message}` }; }
    const revision = createHash('sha256').update(source).digest('hex').slice(0, 16);
    if (!config.enabled) return { status: 'disabled', revision, reason: '规则集未启用' };
    const [type, idText] = String(alertId).split(':');
    const rules = config.rules.filter(rule => rule.enabled && rule.event_type === type &&
      Date.parse(rule.valid_from) <= Date.now() && Date.now() < Date.parse(rule.expires_at));
    if (!rules.length) return { status: 'no_candidate', revision };
    const id = integer(idText);
    if (!id || id < 1 || parsed && (integer(parsed.payload?.event_id) !== id || match?.matched !== true || match?.event_id !== id))
      return { status: 'identity_unverified', revision, reason: 'syslog 与牧云事件 ID 未精确关联' };
    // A2（P003-T037）：syslog 匹配已经拿到这条事件的详情（`match.event`，身份在上面校验过），
    // 规则评估直接复用，不再为同一份详情重拉一次。没有 match.event（轮询入口 / 未匹配）才走牧云。
    const reused = match?.matched === true && match?.event_id === id && match.event ? match.event : null;
    if (!reused && !toolbox?.callTool) return { status: 'error', revision, reason: '牧云详情接口不可用' };
    let detail = reused;
    if (!detail) {
      try { detail = await toolbox.callTool(`get_${type}_event`, { id }); }
      catch (error) { return { status: 'error', revision, reason: `牧云事件详情读取失败：${error.message}` }; }
    }
    const hostId = integer(detail.host_id ?? detail.host_view?.host_id);
    const hostIp = ipValue(detail.host_view?.host_ip || detail.host_ip);
    const level = integer(detail.level);
    const state = integer(detail.state);
    if (integer(detail.id ?? detail.event_id) !== id || !hostId || !hostIp || ![1, 2, 3, 4].includes(level) || state !== 1 ||
      !sameSyslogFacts(type, parsed, detail))
      return { status: 'identity_unverified', revision, reason: '事件身份、字段或风险状态不满足自动判定边界' };
    let observed = null;
    for (const rule of rules) {
      if (rule.host_id !== hostId) continue;
      const matched = rule.conditions.map(condition => ({ condition, ...fact(type, detail, condition.field) }));
      if (!matched.every(item => conditionMatches(item.condition, item.value))) continue;
      const decision = { status: rule.action === 'observe' ? 'observed' : 'candidate', revision,
        rule: { id: rule.id, event_type: type, action: rule.action, reason: rule.reason,
          source_alert_id: rule.source_alert_id || null,
          approved_by: rule.approved_by, expires_at: rule.expires_at },
        facts: [{ field: 'host_id', value: detail.host_id ?? detail.host_view?.host_id,
          pointer: detail.host_id != null ? '/host_id' : '/host_view/host_id' },
          ...matched.map(item => ({ field: item.condition.field,
            value: item.evidence_value ?? item.value, pointer: item.pointer }))],
        evidence_sha256: createHash('sha256').update(JSON.stringify(detail)).digest('hex') };
      if (rule.action !== 'observe') return decision;
      observed ||= decision;
    }
    return observed || { status: 'no_match', revision };
  }
}
