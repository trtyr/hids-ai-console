// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../../server.js';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const SYSLOG_ID = v => `syslog:honeypot:${'a'.repeat(16)}:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e${String(v).padStart(2, '0')}`;

function makeMonitor() {
  const monitor = new TriageMonitor({ file: '/tmp/hids-t068.json', service: {}, investigator: {}, history: {}, concurrency: 0 });
  const mk = (v, { status = 'done', hostIp = '10.0.0.1', sourceIp = '192.0.2.1' } = {}) => {
    const id = SYSLOG_ID(v);
    monitor.records.set(id, { alert_id: id, status, verdict: status === 'done' ? 'threat' : null,
      created_at: '2026-11-21T01:00:00Z', updated_at: '2026-11-21T01:00:00Z',
      input: { raw: '<134>1 2026-11-21T01:00:00Z host cloudwalker-honeypot - - - event_id=1', parsed: {
        msgid: 'cloudwalker-honeypot', ts: '2026-11-21T01:00:00Z',
        payload: { host_ip: hostIp, source_ip: sourceIp, api_token: 'SECRET-TOKEN', process_cmdline: 'curl x' } } } });
    return id;
  };
  return { monitor, mk };
}

test('T069 批量入队：全成功 / 部分失败 / 重复去重 / 超上限 400', async t => {
  const { monitor, mk } = makeMonitor();
  const ids = [mk(1, { status: 'queued' }), mk(2, { status: 'queued' })];
  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const post = body => fetch(`${base}/api/batch/enqueue`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // 全成功 + 重复去重
  const ok = await (await post({ alert_ids: [...ids, ids[0]] })).json();
  assert.deepEqual(ok.accepted.sort(), [...ids].sort());
  assert.equal(ok.rejected.length, 0);
  // 部分失败：混一个格式合法的陌生 ID（syslog 记录缺原始报文 → 404 拒绝）
  const stranger = 'syslog:honeypot:' + 'b'.repeat(16) + ':1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e99';
  const partial = await (await post({ alert_ids: [ids[0], stranger] })).json();
  assert.equal(partial.accepted.length, 1);
  assert.equal(partial.rejected.length, 1);
  assert.equal(partial.rejected[0].id, stranger);
  assert.match(partial.rejected[0].reason, /原始报文/);
  // 超上限 / 空数组 / 非法 ID
  assert.equal((await post({ alert_ids: Array.from({ length: 101 }, (_, i) => SYSLOG_ID(i % 10)) })).status, 400);
  assert.equal((await post({ alert_ids: [] })).status, 400);
  assert.equal((await post({ alert_ids: ['not-an-id'] })).status, 400);
});

test('T069 批量处置：成功 / 重复处置 409 / 非法处置位 400', async t => {
  const { monitor, mk } = makeMonitor();
  const ids = [mk(1), mk(2)];
  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const post = body => fetch(`${base}/api/batch/dispose`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const first = await (await post({ alert_ids: ids, disposition: 'dismissed' })).json();
  assert.equal(first.accepted.length, 2);
  // 重复处置 → 每条 rejected 409 语义
  const again = await (await post({ alert_ids: ids, disposition: 'escalated' })).json();
  assert.equal(again.accepted.length, 0);
  assert.equal(again.rejected.length, 2);
  assert.match(again.rejected[0].reason, /已有处置位/);
  assert.equal(monitor.records.get(ids[0]).disposition, 'dismissed', '首次处置位不被覆盖');
  assert.equal((await post({ alert_ids: ids, disposition: 'bogus' })).status, 400);
});

test('T068 原始载荷：分页 + 凭据字段擦除 + 无报文 404', async t => {
  const { monitor, mk } = makeMonitor();
  const id = mk(1);
  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const body = await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(id)}/raw`)).json();
  assert.equal(body.alert_id, id);
  assert.equal(body.msgid, 'cloudwalker-honeypot');
  assert.match(body.raw, /event_id=1/);
  assert.equal(body.payload_total, 4);
  const token = body.payload.find(row => row.key === 'api_token');
  assert.equal(token.value, '[redacted]', '凭据类字段必须过擦除闸');
  assert.equal(body.payload.find(row => row.key === 'host_ip').value, '10.0.0.1');
  const page = await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(id)}/raw?count=2&offset=2`)).json();
  assert.equal(page.payload.length, 2);
  assert.equal(page.truncated, false);
  const stranger = 'syslog:honeypot:' + 'c'.repeat(16) + ':1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e88';
  assert.equal((await fetch(`${base}/api/agent/triage/${encodeURIComponent(stranger)}/raw`)).status, 404);
});

test('T068 关联告警：按 host / source_ip 筛，缺条件 400', async t => {
  const { monitor, mk } = makeMonitor();
  mk(1, { hostIp: '10.0.0.9', sourceIp: '192.0.2.7' });
  mk(2, { hostIp: '10.0.0.9', sourceIp: '192.0.2.8' });
  mk(3, { hostIp: '10.0.0.8', sourceIp: '192.0.2.7' });
  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const byHost = await (await fetch(`${base}/api/cases/related?host=10.0.0.9`)).json();
  assert.equal(byHost.total, 2);
  const bySource = await (await fetch(`${base}/api/cases/related?source_ip=192.0.2.7`)).json();
  assert.equal(bySource.total, 2);
  const both = await (await fetch(`${base}/api/cases/related?host=10.0.0.9&source_ip=192.0.2.7`)).json();
  assert.equal(both.total, 1);
  assert.equal((await fetch(`${base}/api/cases/related`)).status, 400);
});
