import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from './rpc-client.js';
import { CloudwalkerGateway } from './cloudwalker.js';
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
