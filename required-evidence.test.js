import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvidenceReport, collectRequiredEvidence, requiredEvidenceGaps,
  requiredEvidencePlan } from './required-evidence.js';

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
  const report = appendEvidenceReport('建议判定为存疑。需核对后续行为。', checks);
  assert.match(report, /已查同主机关联事件的限定范围当前页，未返回记录/);
  assert.match(report, /同主机命令会话、操作授权与测试工单没有可用数据源/);
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
});

test('命令会话使用牧云提供的带主机过滤工具，WebShell 标记尚未接入的调用日志', () => {
  const catalog = [{ name: 'list_full_commands', ...schema({ host_id: {}, count: {} }) }];
  const original = { view: { facts: { host_id: { value: 41 } } } };
  const command = requiredEvidencePlan('suspicious_operation', original, catalog);
  assert.equal(command.find(item => item.id === 'command_history').tool, 'list_full_commands');
  assert.deepEqual(command.find(item => item.id === 'command_history').args, { host_id: 41, count: 20 });
  assert.equal(command.find(item => item.id === 'authorization').source, false);
  const webshell = requiredEvidencePlan('webshell', original, catalog);
  assert.equal(webshell.find(item => item.id === 'file_invocation').source, false);
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
