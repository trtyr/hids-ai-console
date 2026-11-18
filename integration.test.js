import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from './rpc-client.js';
import { CloudwalkerGateway, rpcMethods } from './cloudwalker.js';
import { normalizeAlert } from './cloudwalker.js';
import { createServer } from './server.js';

test('RPC forwards API token in cookie and uses source method contract', async () => {
  let seen;
  const client = new RpcClient('https://example.test/', 'abcdef123', async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { total: 0, events: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await client.call('HoneypotService.List', { count: 5 });
  assert.equal(new URL(seen.url).searchParams.get('method'), 'HoneypotService.List');
  assert.equal(seen.init.headers.Cookie, 'API-Token=abcdef123');
  assert.deepEqual(JSON.parse(seen.init.body).params, { count: 5 });
  await assert.rejects(client.call('HoneypotService.CreateWhitelist', {}), /只读白名单/);
});

test('event list preserves partial failures and typed IDs', async () => {
  const gateway = new CloudwalkerGateway({ call: async method => {
    if (method === 'RevshellEventService.GetEventList') return { total: 1, events: [{ id: 62169, level: 3, host_view: { id: 8, host_name: 'node-8', host_ip: '10.2.0.8' }, remote_addr: '10.1.0.2', created_at: 1793600000 }] };
    throw new Error('permission denied');
  } });
  const result = await gateway.alerts({ count: 1 });
  assert.equal(result.alerts[0].id, 'revshell:62169');
  assert.equal(result.alerts[0].hostId, 8);
  assert.equal(result.partial, true);
  assert.equal(result.totals.revshell, 1);
  assert.match(result.errors.honeypot, /permission denied/);
});

test('merged pages contain distinct events in global time order', async () => {
  const perType = {
    webshell: [90, 70, 50, 30].map((n, i) => ({ id: i + 1, created_at: 1793600000 + n })),
    malware: [80, 60, 40, 20].map((n, i) => ({ id: i + 1, created_at: 1793600000 + n }))
  };
  const calls = [];
  const gateway = new CloudwalkerGateway({ call: async (method, args) => {
    const type = method.startsWith('Webshell') ? 'webshell' : method.startsWith('Malware') ? 'malware' : null;
    calls.push([type, args.offset, args.count]);
    const rows = perType[type] || [];
    return { total: rows.length, events: rows.slice(args.offset, args.offset + args.count) };
  } });
  const first = await gateway.alerts({ count: 3, offset: 0 });
  const second = await gateway.alerts({ count: 3, offset: 3 });
  assert.deepEqual(first.alerts.map(a => a.id), ['webshell:1', 'malware:1', 'webshell:2']);
  assert.deepEqual(second.alerts.map(a => a.id), ['malware:2', 'webshell:3', 'malware:3']);
  assert.equal(first.total, 8);
  assert.equal(second.total, 8);
  assert.ok(calls.every(([, offset]) => offset === 0));
});

test('merged pagination refills an event type after its first batch', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, created_at: 1793601000 - i }));
  const offsets = [];
  const gateway = new CloudwalkerGateway({ call: async (method, args) => {
    if (method !== 'WebshellEventService.GetEventList') return { total: 0, events: [] };
    offsets.push(args.offset);
    return { total: rows.length, events: rows.slice(args.offset, args.offset + args.count) };
  } });
  const page = await gateway.alerts({ count: 10, offset: 25 });
  assert.deepEqual(page.alerts.map(a => a.id), Array.from({ length: 10 }, (_, i) => `webshell:${i + 26}`));
  assert.deepEqual(offsets, [0, 20]);
});

test('network audit uses its source API data field', async () => {
  const gateway = new CloudwalkerGateway({ call: async method => method === 'NetworkAuditEventService.GetEventList'
    ? { total: 1, data: [{ id: 78, created_at: 1793600000, target: '203.0.113.5' }] }
    : { total: 0, events: [] } });
  const result = await gateway.alerts({ count: 10, offset: 0 });
  assert.equal(result.partial, false);
  assert.equal(result.alerts[0].id, 'network_audit:78');
});

test('detail rejects mismatched event IDs', async () => {
  const gateway = new CloudwalkerGateway({ call: async () => ({ event_id: 42 }) });
  await assert.rejects(gateway.alert('revshell', 41), /ID 与请求不符/);
});

test('outbound reverse shell directions follow source API fields', () => {
  const event = normalizeAlert('revshell', { id: 7, remote_addr: '203.0.113.7', host_view: { id: 4, host_ip: '10.0.0.4' } });
  assert.equal(event.source, '10.0.0.4');
  assert.equal(event.target, '203.0.113.7');
});

test('HTTP API exposes typed alert and does not serve backend source', async t => {
  const service = {
    alerts: async () => ({ alerts: [{ id: 'revshell:1' }], totals: {}, errors: {}, partial: false }),
    alert: async () => ({ alert: { id: 'revshell:1' }, detail: { event_id: 1 } }),
    status: async () => ({ connected: true })
  };
  const server = createServer(service);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/alerts/revshell:1`)).json()).alert.id, 'revshell:1');
  assert.equal((await (await fetch(`${base}/api/alerts/revshell%3A1`)).json()).alert.id, 'revshell:1');
  assert.equal((await fetch(`${base}/backend/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/alerts?count=999`)).status, 400);
});

// ---- 告警筛选与排序（P003-T001）----

const epoch = 1793600000;
const at = offsetSeconds => new Date((epoch + offsetSeconds) * 1000).toISOString();

// fake RPC：按 rpcMethods 认类型，按 total/offset/count 切页，行原样返回给 normalizeAlert。
function stubGateway(rowsByType) {
  const calls = [];
  const gateway = new CloudwalkerGateway({ call: async (method, args) => {
    const type = Object.keys(rowsByType).find(key => method.startsWith(`${rpcMethods[key]}.`));
    calls.push({ type, count: args.count, offset: args.offset });
    const rows = (type && rowsByType[type]) || [];
    return { total: rows.length, events: rows.slice(args.offset, args.offset + args.count) };
  } });
  return { gateway, calls };
}

const filterRows = () => ({
  webshell: [
    { id: 1, created_at: epoch + 40, level: 4, host_view: { host_name: 'db-1' }, cmdline: 'curl http://x/shell.php' },
    { id: 2, created_at: epoch + 30, level: 1, host_view: { host_name: 'db-2' }, cmdline: 'ls -l' },
    { id: 3, created_at: epoch + 20, level: 3, host_view: { host_name: 'web-3' }, cmdline: 'id' },
    { id: 4, created_at: epoch + 10, level: 2, host_view: { host_name: 'web-4' }, cmdline: 'whoami' }
  ],
  malware: [
    { id: 5, created_at: epoch + 35, level: 3, host_view: { host_name: 'db-5' }, cmdline: 'curl http://x/shell.php' },
    { id: 6, created_at: epoch + 5, level: 1, host_view: { host_name: 'app-6' }, cmdline: 'cat /etc/passwd' }
  ]
});

test('type 下推只查该类，total 等于该类总数', async () => {
  const { gateway, calls } = stubGateway(filterRows());
  const all = await gateway.alerts({ count: 10 });
  assert.equal(all.total, 6);
  assert.equal(all.truncated, false);
  calls.length = 0;
  const page = await gateway.alerts({ count: 10, type: 'webshell' });
  assert.deepEqual(page.alerts.map(alert => alert.id), ['webshell:1', 'webshell:2', 'webshell:3', 'webshell:4']);
  assert.equal(page.total, 4);
  assert.deepEqual(page.totals, { webshell: 4 });
  assert.ok(calls.every(call => call.type === 'webshell'), `只该查 webshell：${JSON.stringify(calls.map(call => call.type))}`);
  await assert.rejects(gateway.alerts({ type: 'nope' }), /不支持的事件类型/);
});

test('level / q / from / to 合并后过滤再切页，total 为过滤后条数', async () => {
  const { gateway } = stubGateway(filterRows());
  const byLevel = await gateway.alerts({ count: 10, level: [3, 4] });
  assert.deepEqual(byLevel.alerts.map(alert => alert.id), ['webshell:1', 'malware:5', 'webshell:3']);
  assert.equal(byLevel.total, 3);
  const firstPage = await gateway.alerts({ count: 1, offset: 0, level: [3, 4] });
  const secondPage = await gateway.alerts({ count: 1, offset: 1, level: [3, 4] });
  assert.deepEqual(firstPage.alerts.map(alert => alert.id), ['webshell:1']);
  assert.deepEqual(secondPage.alerts.map(alert => alert.id), ['malware:5']);
  assert.equal(secondPage.total, 3);
  const byQuery = await gateway.alerts({ count: 10, q: 'CURL' });
  assert.deepEqual(byQuery.alerts.map(alert => alert.id), ['webshell:1', 'malware:5']);
  assert.equal(byQuery.total, 2);
  const byRange = await gateway.alerts({ count: 10, from: at(20), to: at(35) });
  assert.deepEqual(byRange.alerts.map(alert => alert.id), ['malware:5', 'webshell:2', 'webshell:3']);
  assert.equal(byRange.total, 3);
  const combined = await gateway.alerts({ count: 10, level: [3], q: 'id' });
  assert.deepEqual(combined.alerts.map(alert => alert.id), ['webshell:3']);
  assert.equal(combined.total, 1);
});

test('扫描窗口上限之外置 truncated，total 只含窗口内匹配', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, created_at: epoch + 600 - i, level: 3 }));
  const { gateway } = stubGateway({ webshell: rows });
  const page = await gateway.alerts({ count: 5, level: [3] });
  assert.equal(page.total, 500);
  assert.equal(page.truncated, true);
  assert.equal(page.alerts.length, 5);
});

test('sort=level 按等级降序、同级按时间降序；默认按时间', async () => {
  const { gateway } = stubGateway(filterRows());
  const byTime = await gateway.alerts({ count: 10 });
  assert.deepEqual(byTime.alerts.map(alert => alert.id),
    ['webshell:1', 'malware:5', 'webshell:2', 'webshell:3', 'webshell:4', 'malware:6']);
  const byLevel = await gateway.alerts({ count: 10, sort: 'level' });
  assert.deepEqual(byLevel.alerts.map(alert => alert.id),
    ['webshell:1', 'malware:5', 'webshell:3', 'webshell:4', 'webshell:2', 'malware:6']);
  assert.equal(byLevel.total, 6);
  const secondPage = await gateway.alerts({ count: 2, offset: 2, sort: 'level' });
  assert.deepEqual(secondPage.alerts.map(alert => alert.id), ['webshell:3', 'webshell:4']);
  await assert.rejects(gateway.alerts({ sort: 'name' }), /不支持的排序方式/);
});

async function serve(service, monitor = null) {
  const server = createServer(service, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP /api/alerts 把筛选参数下推给网关', async t => {
  const seen = [];
  const service = { alerts: async options => { seen.push(options); return { alerts: [], total: 0, totals: {}, errors: {}, partial: false }; } };
  const { server, base } = await serve(service);
  t.after(() => server.close());
  await fetch(`${base}/api/alerts?type=webshell&level=critical,3&q=shell&from=2026-11-01T00:00:00Z&to=${epoch}&sort=level&count=5&offset=10`);
  assert.deepEqual(seen[0], { type: 'webshell', level: [4, 3], q: 'shell', from: '2026-11-01T00:00:00.000Z',
    to: at(0), sort: 'level', count: 5, offset: 10 });
  await fetch(`${base}/api/alerts`);
  assert.equal(seen[1].count, 20);
  assert.equal(seen[1].offset, 0);
  assert.equal(seen[1].sort, 'time');
  assert.equal(seen[1].type, undefined);
  assert.equal(seen[1].level, undefined);
});

test('HTTP /api/alerts 拒绝非法筛选参数', async t => {
  const service = { alerts: async () => ({ alerts: [], total: 0, totals: {}, errors: {}, partial: false }) };
  const { server, base } = await serve(service);
  t.after(() => server.close());
  const queries = ['type=nope', 'level=9', 'sort=name', 'from=abc', `from=${at(30)}&to=${at(10)}`,
    'triage_status=nope', 'verdict=nope'];
  for (const query of queries) {
    const response = await fetch(`${base}/api/alerts?${query}`);
    assert.equal(response.status, 400, `${query} 应回 400`);
    assert.ok((await response.json()).error, `${query} 应有 error 文案`);
  }
});

test('triage_status / verdict 挂完 triage 后过滤并跨页统计', async t => {
  const alerts = [{ id: 'webshell:1', verdictKey: 'review' }, { id: 'webshell:2', verdictKey: 'review' },
    { id: 'webshell:3', verdictKey: 'review' }, { id: 'webshell:4', verdictKey: 'review' }];
  // 每页只回 2 条，逼出跨页扫描
  const service = { alerts: async ({ count, offset }) => ({ alerts: alerts.slice(offset, offset + Math.min(count, 2)),
    total: alerts.length, totals: { webshell: 4 }, errors: {}, partial: false }) };
  const records = { 'webshell:1': { alert_id: 'webshell:1', status: 'done', verdict: 'threat' },
    'webshell:3': { alert_id: 'webshell:3', status: 'running' } };
  const monitor = { status: id => records[id] || null };
  const { server, base } = await serve(service, monitor);
  t.after(() => server.close());
  const list = async query => (await fetch(`${base}/api/alerts?${query}`)).json();
  const done = await list('triage_status=done');
  assert.deepEqual(done.alerts.map(alert => alert.id), ['webshell:1']);
  assert.equal(done.total, 1);
  assert.equal(done.alerts[0].triage.status, 'done');
  const threat = await list('verdict=threat');
  assert.deepEqual(threat.alerts.map(alert => alert.id), ['webshell:1']);
  const notQueued = await list('triage_status=not_queued');
  assert.deepEqual(notQueued.alerts.map(alert => alert.id), ['webshell:2', 'webshell:4']);
  assert.equal(notQueued.total, 2);
  const runningOrDone = await list('triage_status=done,running&count=1&offset=1');
  assert.deepEqual(runningOrDone.alerts.map(alert => alert.id), ['webshell:3']);
  assert.equal(runningOrDone.total, 2);
  // 研判记录没有 verdict（running）时回落到告警自身的 verdictKey: review
  const review = await list('verdict=review');
  assert.deepEqual(review.alerts.map(alert => alert.id), ['webshell:2', 'webshell:3', 'webshell:4']);
});

test('不带筛选参数时仍只挂 triage，不改 total 与分页', async t => {
  const page = { alerts: [{ id: 'webshell:1' }, { id: 'webshell:2' }], total: 9, totals: { webshell: 9 },
    errors: {}, partial: false, truncated: false, query: { count: 2, offset: 0 } };
  const service = { alerts: async () => page };
  const { server, base } = await serve(service, { status: id => ({ alert_id: id, status: 'queued' }) });
  t.after(() => server.close());
  const body = await (await fetch(`${base}/api/alerts?count=2`)).json();
  assert.equal(body.total, 9);
  assert.deepEqual(body.query, { count: 2, offset: 0 });
  assert.equal(body.alerts.length, 2);
  assert.equal(body.alerts[0].triage.status, 'queued');
});

