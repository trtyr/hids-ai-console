import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageRuleEngine, validateRuleSet } from './src/contexts/knowledge/infrastructure/triage-rules.js';
import { TriageMonitor } from './src/contexts/triage/application/triage-monitor.js';
import { InvestigationStore } from './src/contexts/triage/infrastructure/investigation-store.js';
import { createServer } from './server.js';

const networkRule = () => ({ id: 'approved-egress-001', enabled: true, action: 'classify_false_positive',
  event_type: 'network_audit', host_id: 171, reason: '客户批准的固定外连任务', approved_by: '安全负责人',
  valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', conditions: [
    { field: 'source_ip', operator: 'equals', value: '10.2.28.217' },
    { field: 'destination_ip', operator: 'equals', value: '192.0.2.20' },
    { field: 'network_type', operator: 'equals', value: 'ip' },
    { field: 'process_path', operator: 'equals', value: '/usr/bin/curl' },
    { field: 'command_line', operator: 'equals', value: 'curl --head https://192.0.2.20/health' },
    { field: 'detection_reference', operator: 'equals', value: 'custom-rule-1' }
  ] });
const networkEvent = () => ({ id: 42, host_id: 171, host_view: { host_ip: '10.2.28.217', host_id: 171 },
  level: 2, state: 1, type: 'ip', local_addr: '10.2.28.217', target: '192.0.2.20',
  process_path: '/usr/bin/curl', cmdline: 'curl --head https://192.0.2.20/health', reference: 'custom-rule-1' });
const config = rules => ({ schema_version: 1, enabled: true, rules });
const syslog = (overrides = {}) => '<134>1 2026-11-10T08:00:00Z host app 1 cloudwalker-abnormal-network ' + JSON.stringify({
  event_id: 42, host_id: 171, host_ip: '10.2.28.217', local_addr: '10.2.28.217',
  abnormal_reference: 'custom-rule-1', process_path: '/usr/bin/curl',
  process_command_line: 'curl --head https://192.0.2.20/health',
  event_create_time: '2026-11-10T08:00:00Z', ...overrides });
const waitDone = async (monitor, id) => {
  for (let n = 0; n < 100 && monitor.status(id)?.status !== 'done'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.status(id)?.status, 'done');
};

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('精确命中经审批网络规则后仍读取 Wiki 并交由 AI 复核', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-hit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rulesFile = path.join(directory, 'rules.json');
  await writeFile(rulesFile, JSON.stringify(config([networkRule()])));
  const history = new InvestigationStore(path.join(directory, 'history'));
  let aiCalls = 0, wikiCalls = 0, candidate = null;
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1,
    file: path.join(directory, 'queue.json'), casesDirectory: path.join(directory, 'cases'), history,
    ruleEngine: new TriageRuleEngine(rulesFile),
    eventToolbox: { callTool: async () => networkEvent(), listEvents: async () => { throw new Error('不应按列表模糊关联'); } },
    wiki: { agentIndex: async () => { wikiCalls++; return { pages: [] }; } },
    investigator: { run: async (alertId, options) => { aiCalls++; candidate = options.ruleEvaluation;
      return { alert_id: alertId, mode: 'triage', model: 'review-model',
        verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '需要核查本次授权与会话', claims: [] },
        validation: { ok: true }, trace: [] }; } } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(syslog());
  await waitDone(monitor, accepted.alert_id);
  const record = monitor.status(accepted.alert_id);
  const result = await history.latest('network_audit:42', 'triage');
  assert.equal(aiCalls, 1);
  assert.equal(wikiCalls, 1);
  assert.equal(record.decision_source, 'ai');
  assert.equal(record.rule_id, 'approved-egress-001');
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.model, 'review-model');
  assert.equal(candidate.status, 'candidate');
  assert.equal(result.rule_evaluation.facts.find(fact => fact.field === 'destination_ip').pointer, '/target');
  assert.match(await readFile(path.join(record.case_dir, '05-研判结果.md'), 'utf8'), /需要核查本次授权与会话/);
});

test('字段不符、等级高、观察模式或配置损坏时的规则状态可追溯', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  const engine = new TriageRuleEngine(filename);
  const input = { alertId: 'network_audit:42', toolbox: { callTool: async () => networkEvent() } };
  await writeFile(filename, JSON.stringify(config([networkRule()])));
  assert.equal((await engine.evaluate({ ...input, toolbox: { callTool: async () =>
    ({ ...networkEvent(), target: '198.51.100.5' }) } })).status, 'no_match');
  assert.equal((await engine.evaluate({ ...input, toolbox: { callTool: async () =>
    ({ ...networkEvent(), level: 3 }) } })).status, 'candidate');
  assert.equal((await engine.evaluate({ ...input, parsed: { payload: { event_id: 42, host_id: 171,
    host_ip: '10.2.28.217', local_addr: '10.2.28.217', process_path: '/usr/bin/curl',
    process_command_line: 'curl --head https://192.0.2.20/health',
    abnormal_reference: 'different' } },
    match: { matched: true, event_id: 42 } })).status, 'identity_unverified');
  const observe = networkRule(); observe.action = 'observe';
  await writeFile(filename, JSON.stringify(config([observe])));
  assert.equal((await engine.evaluate(input)).status, 'observed');
  await writeFile(filename, '{');
  assert.equal((await engine.evaluate(input)).status, 'error');
});

test('规则未命中时自动队列继续读取 Wiki 并调用 AI', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-ai-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  await writeFile(filename, JSON.stringify(config([networkRule()])));
  let aiCalls = 0, wikiCalls = 0;
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1,
    file: path.join(directory, 'queue.json'), casesDirectory: path.join(directory, 'cases'),
    history: new InvestigationStore(path.join(directory, 'history')),
    ruleEngine: new TriageRuleEngine(filename),
    eventToolbox: { callTool: async () => ({ ...networkEvent(), target: '198.51.100.8' }) },
    wiki: { agentIndex: async () => { wikiCalls++; return { pages: [] }; } },
    investigator: { run: async (alertId, { mode }) => {
      aiCalls++;
      return { alert_id: alertId, mode, verdict: { verdict: 'uncertain', verdict_label: '存疑',
        summary: '需要进一步调查', claims: [] }, validation: { ok: true }, trace: [] };
    } } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(syslog());
  await waitDone(monitor, accepted.alert_id);
  assert.equal(aiCalls, 1);
  assert.equal(wikiCalls, 1);
  assert.equal(monitor.status(accepted.alert_id).decision_source, 'ai');
});

test('直接调用 triage API 也先运行规则，deep 模式继续独立流程', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  await writeFile(filename, JSON.stringify(config([networkRule()])));
  let aiCalls = 0;
  const history = new InvestigationStore(path.join(directory, 'history'));
  const investigator = { run: async (alertId, { mode }) => {
    aiCalls++;
    return { alert_id: alertId, mode, verdict: { verdict: 'uncertain', summary: '需要复核' } };
  } };
  const server = createServer(null, { callTool: async () => networkEvent() }, investigator,
    history, null, { ruleEngine: new TriageRuleEngine(filename) }, null, {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async mode => {
    const response = await fetch(`${base}/api/agent/investigations`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alert_id: 'network_audit:42', mode }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await post('triage')).rule_evaluation.status, 'candidate');
  assert.equal(aiCalls, 1);
  assert.equal((await post('deep')).mode, 'deep');
  assert.equal(aiCalls, 2);
});

test('异常登录与暴力破解按各自的牧云字段匹配', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  const base = { enabled: true, action: 'classify_false_positive', host_id: 171,
    reason: '客户批准的核验活动', approved_by: '安全负责人',
    valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' };
  const login = { ...base, id: 'login-001', event_type: 'abnormal_login', conditions: [
    { field: 'source_ip', operator: 'equals', value: '192.0.2.10' },
    { field: 'destination_ip', operator: 'equals', value: '10.2.28.217' },
    { field: 'user_name', operator: 'equals', value: 'ops' },
    { field: 'auth_type', operator: 'equals', value: 'ssh' },
    { field: 'rule_subject', operator: 'equals', value: '非工作时间登录' },
    { field: 'abnormal_type', operator: 'equals', value: 1 }
  ] };
  const brute = { ...base, id: 'scanner-001', event_type: 'brute_force', conditions: [
    { field: 'source_ip', operator: 'equals', value: '192.0.2.10' },
    { field: 'destination_ip', operator: 'equals', value: '10.2.28.217' },
    { field: 'user_name', operator: 'equals', value: 'test' },
    { field: 'auth_service', operator: 'equals', value: 'ssh' },
    { field: 'success_count', operator: 'equals', value: 0 },
    { field: 'failure_count', operator: 'lte', value: 100 }
  ] };
  await writeFile(filename, JSON.stringify(config([login, brute])));
  const engine = new TriageRuleEngine(filename);
  const host = { host_id: 171, host_view: { host_id: 171, host_ip: '10.2.28.217' }, level: 2, state: 1 };
  const loginEvent = { ...host, event_id: 7, login_ip: '192.0.2.10', login_username: 'ops',
    auth_type: 'ssh', rule_subject: '非工作时间登录', login_abnormal_type: 1 };
  const bruteEvent = { ...host, id: 8, time_aix: [{ user_name: 'test', source_ip: '192.0.2.10' }],
    auth_service: 'ssh', success_count: 0, failure_count: 30 };
  assert.equal((await engine.evaluate({ alertId: 'abnormal_login:7', toolbox: { callTool: async () => loginEvent } })).status, 'candidate');
  assert.equal((await engine.evaluate({ alertId: 'brute_force:8', toolbox: { callTool: async () => bruteEvent } })).status, 'candidate');
  assert.equal((await engine.evaluate({ alertId: 'brute_force:8', toolbox: { callTool: async () =>
    ({ ...bruteEvent, success_count: 1 }) } })).status, 'no_match');
  assert.equal((await engine.evaluate({ alertId: 'brute_force:8', toolbox: { callTool: async () =>
    ({ ...bruteEvent, time_aix: [...bruteEvent.time_aix, { user_name: 'root', source_ip: '192.0.2.10' }] }) } })).status, 'no_match');
  assert.equal((await engine.evaluate({ alertId: 'abnormal_login:7', toolbox: { callTool: async () =>
    ({ ...loginEvent, login_abnormal_type: 2 }) } })).status, 'no_match');
  const unsafeBrute = structuredClone(brute);
  unsafeBrute.conditions.find(item => item.field === 'failure_count').value = 201;
  assert.throws(() => validateRuleSet(config([unsafeBrute])), /失败次数上限/);
});

test('规则字段按牧云场景校验，缺失或空值不能触发自动误报', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-types-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  const rule = networkRule();
  const source = rule.conditions.find(item => item.field === 'source_ip');
  source.operator = 'cidr'; source.value = '10.2.28.0/24';
  validateRuleSet(config([rule]));
  await writeFile(filename, JSON.stringify(config([rule])));
  const engine = new TriageRuleEngine(filename);
  assert.equal((await engine.evaluate({ alertId: 'network_audit:42', toolbox: { callTool: async () => networkEvent() } })).status, 'candidate');
  const withPort = await engine.evaluate({ alertId: 'network_audit:42', toolbox: { callTool: async () =>
    ({ ...networkEvent(), local_addr: '10.2.28.217:55000' }) } });
  assert.equal(withPort.status, 'candidate');
  assert.deepEqual(withPort.facts.find(item => item.field === 'source_ip'),
    { field: 'source_ip', value: '10.2.28.217:55000', pointer: '/local_addr' });
  assert.equal((await engine.evaluate({ alertId: 'network_audit:42', toolbox: { callTool: async () =>
    ({ ...networkEvent(), local_addr: '' }) } })).status, 'no_match');
  const invalid = networkRule(); invalid.conditions.find(item => item.field === 'destination_ip').operator = 'cidr';
  assert.throws(() => validateRuleSet(config([invalid])), /操作符/);
  const brute = { ...networkRule(), event_type: 'brute_force' };
  assert.throws(() => validateRuleSet(config([brute])), /不适用|缺少/);
});

test('其余八类牧云入侵告警按详情字段命中并形成 AI 复核候选', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-observe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  const hash = 'a'.repeat(64);
  const cases = [
    ['webshell', { path: '/srv/site/shell.jsp', sha256: hash, detect_reason: 'webshell signature' },
      [['file_path', '/srv/site/shell.jsp'], ['sha256', hash], ['detection_reference', 'webshell signature']]],
    ['malware', { path: '/tmp/sample', sha256: hash, detect_reason: 'AV signature' },
      [['file_path', '/tmp/sample'], ['sha256', hash], ['detection_reference', 'AV signature']]],
    ['revshell', { local_addr: '10.2.28.217', remote_addr: '192.0.2.20', shell_cmdline: '/bin/sh', process_path: '/usr/bin/bash' },
      [['source_ip', '10.2.28.217'], ['destination_ip', '192.0.2.20'], ['shell_command', '/bin/sh'], ['process_path', '/usr/bin/bash']]],
    ['memory_webshell', { server_name: 'tomcat', class_name: 'org.example.Filter', sha256: hash, detect_reason: 'class signature' },
      [['server_name', 'tomcat'], ['class_name', 'org.example.Filter'], ['sha256', hash], ['detection_reference', 'class signature']]],
    ['elevation_process', { exepath: '/usr/bin/sudo', cmdline: 'sudo id', origin_uid: 1000, target_uid: 0, privilege_escalation_type: 'SUID' },
      [['process_path', '/usr/bin/sudo'], ['command_line', 'sudo id'], ['origin_uid', 1000], ['target_uid', 0], ['privilege_escalation_type', 'SUID']]],
    ['suspicious_operation', { ssh_client_ip: '192.0.2.10', type: 'ssh', rule_name: 'suspicious command', path: '/usr/bin/curl', cmdline: 'curl example.com', uname: 'ops' },
      [['source_ip', '192.0.2.10'], ['destination_ip', '10.2.28.217'], ['connection_type', 'ssh'], ['rule_name', 'suspicious command'], ['process_path', '/usr/bin/curl'], ['command_line', 'curl example.com'], ['user_name', 'ops']]],
    ['honeypot', { source_ip: '192.0.2.10', address: '10.2.28.217:50001', type: 'message' },
      [['source_ip', '192.0.2.10'], ['honeypot_address', '10.2.28.217:50001'], ['honeypot_type', 'message']]],
    ['memory_security', { plugin_id: 'rasp', strategy_id: 'exec', origin_method: 'Runtime.exec', detect_reason: 'risky call' },
      [['plugin_id', 'rasp'], ['strategy_id', 'exec'], ['origin_method', 'Runtime.exec'], ['detection_reference', 'risky call']]]
  ];
  const rules = cases.map(([type, , conditions]) => ({ id: `observe-${type}`, enabled: true,
    action: 'observe', event_type: type, host_id: 171, reason: '观察已登记的行为', approved_by: '安全负责人',
    valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z',
    conditions: conditions.map(([field, value]) => ({ field, operator: 'equals', value })) }));
  validateRuleSet(config(rules));
  await writeFile(filename, JSON.stringify(config(rules)));
  const engine = new TriageRuleEngine(filename);
  for (const [type, detail] of cases) {
    const event = { event_id: 42, host_view: { host_id: 171, host_ip: '10.2.28.217' }, level: 3, state: 1, ...detail };
    assert.equal((await engine.evaluate({ alertId: `${type}:42`, toolbox: { callTool: async () => event } })).status, 'observed', type);
    const first = Object.keys(detail)[0];
    assert.equal((await engine.evaluate({ alertId: `${type}:42`, toolbox: { callTool: async () =>
      ({ ...event, [first]: null }) } })).status, 'no_match', `${type} 缺少详情字段`);
    const reviewed = structuredClone(rules.find(rule => rule.event_type === type));
    reviewed.action = 'review_false_positive';
    assert.throws(() => validateRuleSet(config([reviewed])), /元数据无效/,
      `${type} 的历史误报候选必须关联原告警`);
    reviewed.source_alert_id = `${type}:7`;
    validateRuleSet(config([reviewed]));
    await writeFile(filename, JSON.stringify(config([reviewed])));
    assert.equal((await engine.evaluate({ alertId: `${type}:42`, toolbox: { callTool: async () => event } })).status,
      'candidate', `${type} 规则只能提供候选结论`);
    await writeFile(filename, JSON.stringify(config(rules)));
  }
});

test('A2 规则评估复用 match.event：身份一致不再拉一次详情，轮询入口照旧取数', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rule-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'rules.json');
  await writeFile(filename, JSON.stringify(config([networkRule()])));
  const engine = new TriageRuleEngine(filename);
  const parsed = { payload: { event_id: 42, host_id: 171, host_ip: '10.2.28.217', local_addr: '10.2.28.217',
    process_path: '/usr/bin/curl', process_command_line: 'curl --head https://192.0.2.20/health',
    abnormal_reference: 'custom-rule-1' } };
  let fetched = 0;
  const reused = await engine.evaluate({ alertId: 'network_audit:42', parsed, match: { matched: true, event_id: 42, event: networkEvent() },
    toolbox: { callTool: async () => { fetched += 1; throw new Error('不应重新取数'); } } });
  assert.equal(reused.status, 'candidate');
  assert.equal(reused.rule.id, 'approved-egress-001');
  assert.equal(fetched, 0, 'match.event 身份一致时不再取详情');

  // 没有 match.event（轮询入口）：照旧走牧云取数。
  const poll = await engine.evaluate({ alertId: 'network_audit:42',
    toolbox: { callTool: async () => { fetched += 1; return networkEvent(); } } });
  assert.equal(poll.status, 'candidate');
  assert.equal(fetched, 1);
});
