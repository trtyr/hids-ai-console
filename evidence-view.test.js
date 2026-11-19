import test from 'node:test';
import assert from 'node:assert/strict';
import { boundEvidenceView, projectEvidence } from './evidence-view.js';
import { EvidenceSession } from './agent-tools.js';

test('detail view uses readable facts and keeps raw JSON pointers', () => {
  const raw = { event_id: 7, source_ip: '192.0.2.7', host_view: { host_name: 'db-7', host_ip: '10.0.0.7' },
    timeline: [{ timestamp: 1793600000, src_addr: '192.0.2.7', request_length: 94 }],
    irrelevant_blob: 'x'.repeat(10000) };
  const view = projectEvidence('get_honeypot_event', raw);
  assert.deepEqual(view.facts.source_ip, { value: '192.0.2.7', pointer: '/source_ip' });
  assert.deepEqual(view.facts.host_name, { value: 'db-7', pointer: '/host_view/host_name' });
  assert.equal(view.related_sequences.timeline.total_in_record, 1);
  assert.equal(view.related_sequences.timeline.shown[0].facts.request_length.pointer, '/timeline/0/request_length');
  assert.equal(JSON.stringify(view).includes('x'.repeat(100)), false);
});

test('honeypot HTTP request is readable while its citation still verifies the raw digest', async () => {
  const digest = Buffer.from('OPTIONS /svn HTTP/1.1\r\nHost: example.test\r\n\r\n').toString('base64');
  const raw = { event_id: 7, timeline: [{ request_length: 41, response_length: 0, response_digest: digest }] };
  const session = new EvidenceSession({ callTool: async () => raw });
  const record = await session.callTool('get_honeypot_event', { id: 7 });
  const request = record.view.related_sequences.timeline.shown[0].facts.http_request_line;
  assert.equal(request.decoded, 'OPTIONS /svn HTTP/1.1');
  assert.equal(request.pointer, '/timeline/0/response_digest');
  assert.equal(session.verifyClaims([{ citations: [{ evidence_id: record.evidenceId,
    pointer: request.pointer, value: request.value }] }]).ok, true);
});

test('honeypot view keeps every request in a multi-step probe and marks TLS-format payload', () => {
  const get = Buffer.from('GET / HTTP/1.0\r\n\r\n').toString('base64');
  const tls = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]).toString('base64');
  const raw = { event_id: 36795, timeline: Array.from({ length: 10 }, (_, index) => ({
    request_length: index % 2 ? 0 : 20, response_length: 0,
    response_digest: index === 8 ? tls : index % 2 ? '' : get
  })) };
  const view = projectEvidence('get_honeypot_event', raw);
  assert.equal(view.related_sequences.timeline.total_in_record, 10);
  assert.equal(view.related_sequences.timeline.shown_count, 10);
  assert.equal(view.related_sequences.timeline.nonempty_request_count, 5);
  assert.equal(view.related_sequences.timeline.shown[8].facts.request_payload_type.pointer, '/timeline/8/response_digest');
  assert.equal(view.related_sequences.timeline.shown[8].facts.request_payload_type.value, tls);
});

test('long honeypot timeline exposes late HTTP requests and response coverage', () => {
  const get = Buffer.from('GET /admin HTTP/1.1\r\nHost: example.test\r\n\r\n').toString('base64');
  const raw = { event_id: 36870, timeline: Array.from({ length: 61 }, (_, index) => ({
    timestamp: -62135596800, request_length: index === 46 ? 45 : index % 2 ? 8 : 0,
    response_length: 0, response_digest: index === 46 ? get : ''
  })) };
  const view = projectEvidence('get_honeypot_event', raw).related_sequences.timeline;
  assert.equal(view.total_in_record, 61);
  assert.equal(view.shown_count, 20);
  assert.equal(view.shown.find(row => row.index === 46).facts.http_request_line.decoded, 'GET /admin HTTP/1.1');
  assert.equal(view.response_payload_available, false);
  assert.equal(view.timestamp_valid_count, 0);
});

test('privilege escalation view exposes the event UID change and parent process identity', () => {
  const view = projectEvidence('get_elevation_process_event', {
    event_id: 62558, origin_uid: 997, origin_effect_uid: 997, target_uid: 997, target_effect_uid: 0,
    privilege_escalation_type: 'SUID提权', host_view: { host_kernel_version: '5.4.0' },
    process_tree: [{ pid: 1060832, uname: 'collie', uid: 997, euname: 'collie', euid: 997 }]
  });
  assert.deepEqual(view.facts.origin_effective_uid, { value: 997, pointer: '/origin_effect_uid' });
  assert.deepEqual(view.facts.target_effective_uid, { value: 0, pointer: '/target_effect_uid' });
  assert.deepEqual(view.facts.host_kernel_version, { value: '5.4.0', pointer: '/host_view/host_kernel_version' });
  assert.equal(view.related_sequences.process_tree.shown[0].facts.euid.value, 997);
});

test('list view aggregates returned page only and citations still verify against raw', async () => {
  const raw = { total: 100, events: [
    { id: 1, level: 3, source_ip: '192.0.2.1', host_view: { host_name: 'db-1' } },
    { id: 2, level: 3, source_ip: '192.0.2.1', host_view: { host_name: 'db-2' } }
  ] };
  const session = new EvidenceSession({ callTool: async () => raw });
  const record = await session.callTool('list_honeypot_events', { count: 2 });
  assert.equal(record.view.total_reported_by_platform.value, 100);
  assert.equal(record.view.returned_count, 2);
  assert.deepEqual(record.view.counts_on_returned_page.by_source_ip, { '192.0.2.1': 2 });
  assert.match(record.view.aggregation_scope, /当前返回页/);
  const fact = record.view.items[0].facts.source_ip;
  assert.equal(session.verifyClaims([{ citations: [{ evidence_id: record.evidenceId, pointer: fact.pointer, value: fact.value }] }]).ok, true);
});

test('list view flags a platform total smaller than its returned page', () => {
  const view = projectEvidence('list_host_events', { total: 0, events: [{ id: 62558 }] });
  assert.equal(view.platform_total_consistent, false);
  assert.equal(view.returned_count, 1);
  assert.equal(view.total_reported_by_platform.value, 0);
});

test('internal network definitions remain visible with source pointers', () => {
  const view = projectEvidence('get_internal_ip_define', { net_address: ['10.0.0.0/8', '172.16.0.0/12'] });
  assert.deepEqual(view.ranges[0], { value: '10.0.0.0/8', pointer: '/net_address/0' });
});

test('wrapped detail preserves its original result path', () => {
  const view = projectEvidence('get_revshell_event', { event: { id: 7, cmdline: 'bash -i' } });
  assert.deepEqual(view.facts.command_line, { value: 'bash -i', pointer: '/event/cmdline' });
});

test('process asset view keeps decision fields and omits unrelated host attributes', () => {
  const raw = { total: 2, result: [{ id: 71, host_view: { host_id: 8, host_ip: '10.0.0.8',
    custom_attr: [{ attr_name: 'password', attr_value: ['secret-value'] }] },
  pid: 18, name: 'sshd', safety: 'unknown', user: 'root', cmdline: '/usr/sbin/sshd -D' }] };
  const view = projectEvidence('list_process_assets', raw);
  assert.deepEqual(view.items[0].facts.asset_id, { value: 71, pointer: '/result/0/id' });
  assert.deepEqual(view.items[0].facts.process_safety, { value: 'unknown', pointer: '/result/0/safety' });
  assert.equal(view.counts_on_returned_page.by_process_safety.unknown, 1);
  assert.equal(JSON.stringify(view).includes('secret-value'), false);
});

test('firewall view includes both endpoints and returned-page connection counts', () => {
  const raw = { total: 8, data: [{ id: 'r1', source: { cidr: '192.0.2.1' }, dest: { host_ip: '10.0.0.8' },
    port: 22, process: 'sshd', conn_type: 2, access_count: 4 }] };
  const view = projectEvidence('list_firewall_connection_records', raw);
  assert.deepEqual(view.items[0].facts.source_ip, { value: '192.0.2.1', pointer: '/data/0/source/cidr' });
  assert.deepEqual(view.items[0].facts.destination_address, { value: '10.0.0.8', pointer: '/data/0/dest/host_ip' });
  assert.deepEqual(view.items[0].facts.connection_count, { value: 4, pointer: '/data/0/access_count' });
  assert.equal(view.counts_on_returned_page.by_connection_type_code['2'], 1);
  assert.match(view.aggregation_scope, /仅当前返回页；不是平台全量统计/);
});

test('port asset view identifies listening port and process without host custom attributes', () => {
  const view = projectEvidence('list_port_assets', { total: 1, result: [{ id: 41, port: 10010,
    protocol: 'tcp', pid: 20, cmd: 'honeypot', visibility: false,
    host_view: { host_id: 8, custom_attr: [{ attr_name: 'password', attr_value: ['secret-value'] }] } }] });
  assert.deepEqual(view.items[0].facts.listening_port, { value: 10010, pointer: '/result/0/port' });
  assert.deepEqual(view.items[0].facts.process_name, { value: 'honeypot', pointer: '/result/0/cmd' });
  assert.deepEqual(view.items[0].facts.visible_externally, { value: false, pointer: '/result/0/visibility' });
  assert.equal(view.counts_on_returned_page.by_listening_port['10010'], 1);
  assert.equal(JSON.stringify(view).includes('secret-value'), false);
});

test('process detail separates process and executable file safety', () => {
  const view = projectEvidence('get_process_asset', { ID: 71, process_info: { pid: 18, name: 'sshd',
    cmdline: '/usr/sbin/sshd -D' }, file_info: { safety: 'trusted', sha256: 'abc' } });
  assert.deepEqual(view.asset_id, { value: 71, pointer: '/ID' });
  assert.deepEqual(view.process.process_name, { value: 'sshd', pointer: '/process_info/name' });
  assert.deepEqual(view.executable_file.file_safety, { value: 'trusted', pointer: '/file_info/safety' });
  assert.equal(view.executable_file.process_safety, undefined);
});

test('oversized list view keeps citable rows within the model budget', () => {
  const raw = { total: 50, result: Array.from({ length: 5 }, (_, i) => ({ id: i + 1,
    name: `process-${i}`, cmdline: 'x'.repeat(1100), path: 'p'.repeat(450), user: 'root' })) };
  const view = boundEvidenceView(projectEvidence('list_process_assets', raw), 3500);
  assert.equal(view.truncated_for_context, true);
  assert.ok(JSON.stringify(view).length <= 3500);
  assert.ok(view.items.length >= 1 && view.items.length < 5);
  assert.equal(view.returned_count, 5);
  assert.equal(view.items[0].facts.asset_id.pointer, '/result/0/id');
});

test('A4 事件视图的裸 id 不当主机 ID，主机资产视图才认它', () => {
  // 替身牧云的事件行：只有事件 ID 与主机名（api-tools 的列表返回 {total, events}）。
  const events = projectEvidence('list_suspicious_operation_events', { total: 1,
    events: [{ id: 7, host_view: { host_name: 'app-7' }, cmdline: 'id' }] });
  assert.equal(events.items[0].facts.host_id, undefined);
  assert.deepEqual(events.items[0].facts.event_id, { value: 7, pointer: '/events/0/id' });
  // 事件详情同理：裸 id 只进 event_id。
  const detail = projectEvidence('get_suspicious_operation_event', { id: 9, cmdline: 'id' });
  assert.equal(detail.facts.host_id, undefined);
  assert.equal(detail.facts.event_id.value, 9);
  // 主机资产视图里裸 id 就是主机 ID。
  const assets = projectEvidence('list_host_assets', { total: 1, events: [{ id: 42, host_name: 'app-42' }] });
  assert.deepEqual(assets.items[0].facts.host_id, { value: 42, pointer: '/events/0/id' });
  // host_view.id 仍然算主机身份（牧云在 host_view 下放的是主机自己的 ID）。
  const view = projectEvidence('list_honeypot_events', { total: 1, events: [{ id: 7, host_view: { id: 41 } }] });
  assert.deepEqual(view.items[0].facts.host_id, { value: 41, pointer: '/events/0/host_view/id' });
});
