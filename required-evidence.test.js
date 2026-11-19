import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvidenceReport, collectRequiredEvidence, requiredEvidenceGaps,
  requiredEvidencePlan } from './required-evidence.js';
import { projectEvidence } from './evidence-view.js';

const schema = properties => ({ inputSchema: { properties } });

test('可疑命令按主机先查关联事件和命令会话，并分别记录空页与缺少数据源', async () => {
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, types: {}, count: {} }) }];
  const original = { view: { facts: { host_id: { value: 41 }, host_ip: { value: '172.16.221.41' } } } };
  const plan = requiredEvidencePlan('suspicious_operation', original, catalog);
  const calls = [];
  const checks = await collectRequiredEvidence(plan, { callTool: async (name, args) => {
    calls.push({ name, args });
    return { evidenceId: 'cw:2', view: { kind: 'list', returned_count: 0,
      total_reported_by_platform: { value: 12 }, platform_total_consistent: true } };
  } });
  assert.deepEqual(calls.map(item => item.name), ['list_host_events']);
  assert.equal(calls[0].args.host_id, 41);
  assert.equal(checks[0].status, 'empty_page');
  assert.equal(checks[0].total_reported, 12);
  assert.equal(checks[1].status, 'source_unavailable');
  assert.match(requiredEvidenceGaps(checks)[0], /当前页.*未返回记录/);
  assert.match(requiredEvidenceGaps(checks)[1], /没有可用数据源/);
  // A5：目录里没有的授权工具不进缺口（否则每张告警都会多一条假缺口）。
  assert.equal(requiredEvidenceGaps(checks).length, 2);
  assert.doesNotMatch(requiredEvidenceGaps(checks).join('；'), /操作授权与测试工单/);
  const report = appendEvidenceReport('建议判定为存疑。需核对后续行为。', checks);
  assert.match(report, /已查同主机关联事件的限定范围当前页，未返回记录/);
  assert.match(report, /同主机命令会话没有可用数据源/);
  // A5：牧云目录里没有 authorization_record，就不当缺口写进客户报告。
  assert.doesNotMatch(report, /操作授权与测试工单/);
  assert.ok(Array.from(report).length <= 300);
});

test('网络告警只按已知来源查询连接，成功与接口失败分别保留', async () => {
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: {}, types: {}, count: {} }) },
    { name: 'list_firewall_connection_records', ...schema({ filters: {
      properties: { source_cidr: {} } }, count: {} }) }
  ];
  const original = { view: { facts: { host_id: { value: 41 }, host_ip: { value: '172.16.221.41' } } } };
  const calls = [];
  const checks = await collectRequiredEvidence(requiredEvidencePlan('network_audit', original, catalog), {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_host_events') return { evidenceId: 'cw:2', view: { kind: 'list', returned_count: 3 } };
      throw new Error('network API unavailable');
    }
  });
  assert.deepEqual(calls[1].args.filters.source_cidr, ['172.16.221.41']);
  assert.equal(checks[0].status, 'records_returned');
  assert.equal(checks[1].status, 'query_failed');
  assert.deepEqual(requiredEvidenceGaps(checks).length, 1);
  assert.match(requiredEvidenceGaps(checks)[0], /查询失败/);
});

test('没有主机身份时不会对全库发起无筛选查询', async () => {
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, types: {}, count: {} }) },
    { name: 'list_full_commands_by_host', ...schema({ host_id: {}, count: {} }) }];
  const original = { view: { facts: {} } };
  const checks = await collectRequiredEvidence(requiredEvidencePlan('suspicious_operation', original, catalog), {
    callTool: async () => { throw new Error('不应调用'); }
  });
  assert.ok(checks.filter(item => item.id !== 'authorization').every(item => item.status === 'missing_identifier'));
  assert.equal(checks.find(item => item.id === 'authorization').status, 'source_unavailable');
  assert.equal(checks.find(item => item.id === 'authorization').catalog_absent, true);
});

test('命令会话使用牧云提供的带主机过滤工具，缺授权工具时标牧云暂无此数据源', () => {
  const catalog = [{ name: 'list_full_commands', ...schema({ host_id: {}, count: {} }) }];
  const original = { view: { facts: { host_id: { value: 41 } } } };
  const command = requiredEvidencePlan('suspicious_operation', original, catalog);
  assert.equal(command.find(item => item.id === 'command_history').tool, 'list_full_commands');
  assert.deepEqual(command.find(item => item.id === 'command_history').args, { host_id: 41, count: 20 });
  const authorization = command.find(item => item.id === 'authorization');
  assert.equal(authorization.source, false);
  assert.equal(authorization.catalog_absent, true);
  assert.match(authorization.reason, /牧云暂无此数据源/);
  const webshell = requiredEvidencePlan('webshell', original, catalog);
  assert.equal(webshell.find(item => item.id === 'file_invocation').catalog_absent, true);
});

test('目录里有的授权工具按告警事实组参数真查，不再标成不可用', async () => {
  // 替身牧云：授权记录工具存在，必需字段只有 host_id；告警带 user_name 时一并带上。
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: {}, count: {} }) },
    { name: 'authorization_record', inputSchema: { properties: { host_id: { type: 'integer' },
      user_name: { type: 'string' }, count: { type: 'integer' } }, required: ['host_id'] } }
  ];
  const original = { view: { facts: { host_id: { value: 41 }, user_name: { value: 'deploy' } } } };
  const plan = requiredEvidencePlan('suspicious_operation', original, catalog);
  const authorization = plan.find(item => item.id === 'authorization');
  assert.equal(authorization.catalog_absent, undefined);
  assert.equal(authorization.source, true);
  assert.deepEqual(authorization.args, { host_id: 41, user_name: 'deploy', count: 20 });
  const calls = [];
  const checks = await collectRequiredEvidence(plan, { callTool: async (name, args) => {
    calls.push({ name, args });
    return { evidenceId: `cw:${calls.length}`, view: { kind: 'list', returned_count: 1, total_reported_by_platform: { value: 1 } } };
  } });
  assert.deepEqual(calls.map(item => item.name).sort(), ['authorization_record', 'list_host_events']);
  assert.equal(checks.find(item => item.id === 'authorization').status, 'records_returned');
  // 授权项查到了记录就不在缺口里（命令会话在本次目录里没有工具，那一项仍是缺口）。
  assert.doesNotMatch(requiredEvidenceGaps(checks).join('；'), /操作授权与测试工单/);
});

test('授权工具在目录里但必需字段组不出来时记缺标识，不当成「查了没有」', async () => {
  const catalog = [{ name: 'authorization_record', inputSchema: { properties: { ticket_id: {}, host_id: {} },
    required: ['ticket_id'] } }];
  const checks = await collectRequiredEvidence(
    requiredEvidencePlan('suspicious_operation', { view: { facts: { host_id: { value: 41 } } } }, catalog),
    { callTool: async () => { throw new Error('不应调用'); } });
  const authorization = checks.find(item => item.id === 'authorization');
  assert.equal(authorization.status, 'missing_identifier');
  assert.match(authorization.reason, /缺少该工具必需字段/);
});

test('必查项并发执行：互相不串行，status 与 plan 顺序一一对应', async () => {
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: {}, count: {} }) },
    { name: 'list_firewall_connection_records', ...schema({ filters: { properties: { source_cidr: {} } }, count: {} }) }
  ];
  const original = { view: { facts: { host_id: { value: 41 }, host_ip: { value: '172.16.221.41' } } } };
  const plan = requiredEvidencePlan('network_audit', original, catalog);
  let inflight = 0;
  let peak = 0;
  const trace = [];
  const checks = await collectRequiredEvidence(plan, {
    callTool: async name => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inflight--;
      if (name === 'list_firewall_connection_records') throw new Error('network API unavailable');
      return { evidenceId: 'cw:1', view: { kind: 'list', returned_count: 2 } };
    }
  }, () => {}, trace);
  assert.equal(peak, 2);
  assert.deepEqual(checks.map(item => [item.id, item.status]),
    [['related_events', 'records_returned'], ['network_connections', 'query_failed']]);
  // trace 按 plan 序推，不按完成先后。
  assert.deepEqual(trace.filter(item => item.kind === 'evidence_check').map(item => item.id),
    ['related_events', 'network_connections']);
});

test('事件视图只有裸 id 时不拿事件 ID 当主机 ID：必查项退成缺标识，不报「已查未返回」', async () => {
  // 替身牧云返回的事件行只有 id（事件 ID）与主机名，没有 host_id / host_view.host_id。
  const view = projectEvidence('list_suspicious_operation_events', { total: 1,
    events: [{ id: 7, level: 1, host_view: { host_name: 'app-7' }, cmdline: 'id' }] });
  assert.equal(view.items[0].facts.host_id, undefined);
  assert.equal(view.items[0].facts.event_id.value, 7);
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, count: {} }) }];
  const checks = await collectRequiredEvidence(requiredEvidencePlan('suspicious_operation', view, catalog),
    { callTool: async () => { throw new Error('不应调用'); } });
  assert.equal(checks[0].status, 'missing_identifier');
  assert.match(requiredEvidenceGaps(checks)[0], /无法发起限定范围查询/);
  assert.doesNotMatch(requiredEvidenceGaps(checks)[0], /已查当前页/);
  // 主机资产视图里裸 id 就是主机 ID，仍然保留。
  const assets = projectEvidence('list_host_assets', { total: 1, events: [{ id: 42, host_name: 'app-42' }] });
  assert.equal(assets.items[0].facts.host_id.value, 42);
});

test('适配牧云 MCP 数组筛选字段和不支持 types 的主机事件接口', () => {
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: { type: 'integer' }, count: {} }) },
    { name: 'list_full_commands_by_host', ...schema({ host_id: { type: ['null', 'array'] }, count: {} }) },
    { name: 'list_honeypot_events', ...schema({ source_ip: { type: ['null', 'array'] }, count: {} }) }
  ];
  const original = { view: { facts: { host_id: { value: 41 }, source_ip: { value: '192.0.2.7' } } } };
  const command = requiredEvidencePlan('suspicious_operation', original, catalog);
  assert.deepEqual(command[0].args, { host_id: 41, count: 20 });
  assert.equal(command[0].scope, '同主机全部事件类型的当前返回页；不能代表全部历史');
  assert.deepEqual(command[1].args, { host_id: [41], count: 20 });
  const honeypot = requiredEvidencePlan('honeypot', original, catalog);
  assert.deepEqual(honeypot.find(item => item.id === 'source_history').args,
    { source_ip: ['192.0.2.7'], count: 20 });
});
