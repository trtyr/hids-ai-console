import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudwalkerGateway, defaultTtls } from './src/contexts/ingestion/infrastructure/gateway.js';
import { rpcMethods } from './src/shared/vocabulary.js';;

// 一个按方法计数的 RPC 替身：返回什么由 handler 决定，调用次数由 calls 记录。
function stubRpc(handler) {
  const calls = [];
  const rpc = { calls, call: async (method, args) => { calls.push([method, args]); return handler(method, args); } };
  return rpc;
}
// 与 cloudwalker.js 同一张表：蜜罐列表是 List，其余是 GetEventList。
const listMethod = type => `${rpcMethods[type]}.${type === 'honeypot' ? 'List' : 'GetEventList'}`;

const listCalls = (rpc, type) => rpc.calls.filter(([method]) => method === listMethod(type));

test('A8 status 探活在 45 秒窗口内只发一次 RPC，失败不缓存', async () => {
  let clock = 1_000, failing = false;
  const rpc = stubRpc(() => { if (failing) throw new Error('rpc down'); return { total: 0, events: [] }; });
  const gateway = new CloudwalkerGateway(rpc, { now: () => clock });
  const first = await gateway.status();
  const second = await gateway.status();
  assert.deepEqual(first, second);
  assert.equal(rpc.calls.length, 1);
  assert.equal(gateway.statusTtlMs, defaultTtls.status);
  assert.ok(gateway.statusTtlMs >= 30_000 && gateway.statusTtlMs <= 60_000, '缓存窗口必须落在 30~60 秒');
  clock += gateway.statusTtlMs - 1;
  await gateway.status();
  assert.equal(rpc.calls.length, 1, '窗口内不重发');
  clock += 1;
  await gateway.status();
  assert.equal(rpc.calls.length, 2, '窗口过期后重新探活');

  // 失败结果不进缓存：窗口过期后的一次失败，下一次请求必须重新探，牧云恢复后立刻能看到 connected。
  clock += gateway.statusTtlMs;
  failing = true;
  await assert.rejects(() => gateway.status(), /rpc down/);
  failing = false;
  assert.equal((await gateway.status()).connected, true);
  assert.equal(rpc.calls.length, 4);
});

test('A9 详情失败路径的探活按类型短 TTL 复用', async () => {
  let clock = 5_000, listOk = true;
  const rpc = stubRpc(method => {
    if (method.endsWith('.GetEvent')) throw new Error('event not visible');
    if (!listOk) throw new Error('cloudwalker down');
    return { total: 1, events: [] };
  });
  const gateway = new CloudwalkerGateway(rpc, { now: () => clock });
  // 探得通：说明只是这条事件读不到 → 404。
  await assert.rejects(() => gateway.alert('honeypot', 7), error => error.status === 404);
  await assert.rejects(() => gateway.alert('honeypot', 8), error => error.status === 404);
  assert.equal(listCalls(rpc, 'honeypot').length, 1, '同一类型连续失败只探一次');
  assert.equal(gateway.probeTtlMs, defaultTtls.probe);

  // 短 TTL 过期后重新探活。
  clock += gateway.probeTtlMs;
  await assert.rejects(() => gateway.alert('honeypot', 9), error => error.status === 404);
  assert.equal(listCalls(rpc, 'honeypot').length, 2);

  // 探不通：牧云不可达，原错上抛（外层按 502 处理），不是 404。
  listOk = false;
  clock += gateway.probeTtlMs;
  await assert.rejects(() => gateway.alert('webshell', 3), error => error.message === 'event not visible' && error.status === undefined);
  await assert.rejects(() => gateway.alert('webshell', 4), error => error.message === 'event not visible');
  assert.equal(listCalls(rpc, 'webshell').length, 1, '不可达结论同样在 TTL 内复用，不会一条一探');
});

test('A10 列表首批按类型做 TTL 快照，轮询与研判筛选共用一份', async () => {
  let clock = 10_000;
  const rows = { webshell: [3, 2, 1].map(id => ({ id, created_at: 1793600000 + id, level: 3 })),
    honeypot: [{ id: 9, created_at: 1793600009, level: 2 }] };
  const rpc = stubRpc((method, args) => {
    const type = method.startsWith('Webshell') ? 'webshell' : method.startsWith('Honeypot') ? 'honeypot' : null;
    if (!type) return { total: 0, events: [] };
    return { total: rows[type].length, events: rows[type].slice(args.offset, args.offset + args.count) };
  });
  const gateway = new CloudwalkerGateway(rpc, { now: () => clock, snapshotTtlMs: 1_000 });
  const poll = await gateway.alerts({ count: 50, offset: 0, type: 'webshell', from: '2026-11-01T00:00:00.000Z' });
  const filtered = await gateway.alerts({ count: 50, offset: 0, type: 'webshell', level: [3] });
  assert.deepEqual(poll.alerts.map(alert => alert.id), ['webshell:3', 'webshell:2', 'webshell:1']);
  assert.deepEqual(filtered.alerts.map(alert => alert.id), ['webshell:3', 'webshell:2', 'webshell:1']);
  assert.equal(listCalls(rpc, 'webshell').length, 1, '同类型首批只发一次 RPC');

  // 调用方改返回数组不能污染快照：下一次仍是同样三行。
  poll.alerts.length = 0;
  const again = await gateway.alerts({ count: 50, offset: 0, type: 'webshell' });
  assert.deepEqual(again.alerts.map(alert => alert.id), ['webshell:3', 'webshell:2', 'webshell:1']);

  clock += 1_000;
  await gateway.alerts({ count: 50, offset: 0, type: 'webshell' });
  assert.equal(listCalls(rpc, 'webshell').length, 2, 'TTL 过期后重新取数');

  // 不同批大小是新的一档快照，不会拿 20 条的窗口冒充 50 条。
  await gateway.alerts({ count: 5, offset: 0, type: 'webshell' });
  assert.equal(listCalls(rpc, 'webshell').length, 3);
});

test('A1 列表固定排序键 created_at desc, id asc', async () => {
  const rpc = stubRpc((method, args) => {
    if (!method.startsWith('Webshell')) return { total: 0, events: [] };
    const all = [{ id: 2, created_at: 1793600000 }, { id: 1, created_at: 1793600000 }, { id: 3, created_at: 1793600010 }];
    return { total: all.length, events: all.slice(args.offset, args.offset + args.count) };
  });
  const gateway = new CloudwalkerGateway(rpc);
  const page = await gateway.alerts({ count: 10, offset: 0, type: 'webshell' });
  assert.deepEqual(page.alerts.map(alert => alert.id), ['webshell:3', 'webshell:1', 'webshell:2']);
});
