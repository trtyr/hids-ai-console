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

function makeMonitor() {
  const monitor = new TriageMonitor({ file: '/tmp/hids-stats.json', service: {}, investigator: {}, history: {} });
  const mk = (id, { verdict, createdAt, savedAt, hostIp, sourceIp }) => {
    const record = { alert_id: id, status: 'done', verdict, created_at: createdAt, updated_at: createdAt,
      saved_at: savedAt ?? createdAt };
    if (hostIp || sourceIp) record.input = { parsed: { msgid: 'cloudwalker-honeypot', ts: 'x', payload: { host_ip: hostIp, source_ip: sourceIp } } };
    monitor.records.set(id, record);
  };
  mk('honeypot:1', { verdict: 'false_positive', createdAt: '2026-11-21T01:00:00Z', hostIp: '10.0.0.1', sourceIp: '192.0.2.1' });
  mk('honeypot:2', { verdict: 'threat', createdAt: '2026-11-21T02:00:00Z', hostIp: '10.0.0.1', sourceIp: '192.0.2.2' });
  mk('honeypot:3', { verdict: 'uncertain', createdAt: '2026-11-21T03:00:00Z', hostIp: '10.0.0.2' });
  mk('honeypot:4', { verdict: null, createdAt: '2026-11-20T09:00:00Z' });
  return monitor;
}

test('T064 trend：按 day 分桶计数，bucket/days 校验', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, makeMonitor()));
  const body = await (await fetch(`${base}/api/stats/trend?bucket=day&days=7`)).json();
  assert.equal(body.bucket, 'day');
  assert.ok(Object.values(body.buckets).reduce((a, b) => a + b, 0) >= 3, '至少 3 条落在 7 天窗内');
  assert.equal((await fetch(`${base}/api/stats/trend?bucket=week`)).status, 400);
  assert.equal((await fetch(`${base}/api/stats/trend?days=0`)).status, 400);
});

test('T064 top：host_ip 维度降序，limit 截断；非法 dimension 400', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, makeMonitor()));
  const body = await (await fetch(`${base}/api/stats/top?dimension=host_ip&limit=5`)).json();
  assert.equal(body.top[0].value, '10.0.0.1');
  assert.equal(body.top[0].count, 2);
  assert.equal((await fetch(`${base}/api/stats/top?dimension=nope`)).status, 400);
});

test('T064 summary：误报率分母=有结论的 done，MTTR 中位数', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, makeMonitor()));
  const body = await (await fetch(`${base}/api/stats/summary`)).json();
  assert.equal(body.concluded_total, 3, '无结论的 honeypot:4 不入分母');
  assert.equal(body.false_positive_total, 1);
  assert.ok(Math.abs(body.false_positive_rate - 1 / 3) < 0.001);
  assert.equal(body.mttr_samples, 3);
});

test('T065 export：CSV 带 BOM+表头、JSON 数组、非法 dataset/format 400', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, makeMonitor()));
  const csv = await fetch(`${base}/api/export/cases?format=csv`);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const buf = Buffer.from(await csv.arrayBuffer());
  assert.ok(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, 'CSV 带 UTF-8 BOM（res.text() 会剥掉 BOM，用原始字节验）');
  const lines = buf.toString('utf8').slice(1).trim().split('\n');
  assert.equal(lines.length, 5, '表头 + 4 行案件');
  const json = await (await fetch(`${base}/api/export/cases?format=json`)).json();
  assert.ok(Array.isArray(json));
  assert.equal((await fetch(`${base}/api/export/nope`)).status, 400);
  assert.equal((await fetch(`${base}/api/export/cases?format=xml`)).status, 400);
});
