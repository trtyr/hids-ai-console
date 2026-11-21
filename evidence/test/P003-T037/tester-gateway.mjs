// P003-T037 tester probe: A8 / A9 / A10 三类取数缓存（event-gateway §8.4）
// 黑盒：`new CloudwalkerGateway({ call })` 是 docs/modules/event-gateway.md §16 的公开用法
import { CloudwalkerGateway } from '../../../src/contexts/ingestion/infrastructure/gateway.js';

let pass = 0; const fails = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log('  ✔', label); }
  else { fails.push(label + (detail ? ' | ' + detail : '')); console.log('  ✖', label, detail); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clearTtlEnv = () => { for (const k of ['HIDS_STATUS_TTL_MS', 'HIDS_PROBE_TTL_MS', 'HIDS_LIST_SNAPSHOT_TTL_MS']) delete process.env[k]; };

const listOk = () => ({ events: [], total: 0 });

console.log('== A8 status 缓存：窗口内只探一次、并发共用 ==');
{
  clearTtlEnv();
  const calls = [];
  const gw = new CloudwalkerGateway({ call: async (m) => { calls.push(m); return listOk(); } });
  const s1 = await gw.status();
  const s2 = await gw.status();
  eq(calls.length, 1, '45s 窗口内两次 status 只发 1 次 RPC');
  eq(s1, s2, '两次返回同一结果');
  eq(s1.connected, true, 'status 返回 connected=true');
  eq(s1.eventTypes.length, 11, 'status 带 11 个事件类型');
  const calls2 = [];
  const gw2 = new CloudwalkerGateway({ call: async (m) => { calls2.push(m); await sleep(10); return listOk(); } });
  await Promise.all([gw2.status(), gw2.status(), gw2.status()]);
  eq(calls2.length, 1, '并发 status 共用同一次探活（存 promise）');
}
console.log('== A8 失败不缓存：牧云恢复后下一次立刻重探 ==');
{
  clearTtlEnv();
  let n = 0;
  const gw = new CloudwalkerGateway({ call: async () => { n += 1; throw new Error('boom'); } });
  let e1 = null, e2 = null;
  try { await gw.status(); } catch (e) { e1 = e; }
  try { await gw.status(); } catch (e) { e2 = e; }
  ok(!!e1 && !!e2, '两次 failure 都抛出');
  eq(n, 2, '失败不写缓存：第二次照样发 RPC');
}
console.log('== A8 TTL 边界：HIDS_STATUS_TTL_MS 覆盖与 0 关闭 ==');
{
  clearTtlEnv(); process.env.HIDS_STATUS_TTL_MS = '60';
  const calls = [];
  const gw = new CloudwalkerGateway({ call: async (m) => { calls.push(m); return listOk(); } });
  await gw.status();
  await gw.status();
  eq(calls.length, 1, 'TTL=60ms 窗口内仍只 1 次');
  await sleep(120);
  await gw.status();
  eq(calls.length, 2, 'TTL 过期后重新探活');
  clearTtlEnv(); process.env.HIDS_STATUS_TTL_MS = '0';
  const calls0 = [];
  const gw0 = new CloudwalkerGateway({ call: async (m) => { calls0.push(m); return listOk(); } });
  await gw0.status();
  await gw0.status();
  eq(calls0.length, 2, 'TTL=0 关闭缓存（每次都探）');
  delete process.env.HIDS_STATUS_TTL_MS;
}
console.log('== A8 非法 TTL 回落默认 ==');
{
  clearTtlEnv(); process.env.HIDS_STATUS_TTL_MS = '-1';
  const calls = [];
  const gw = new CloudwalkerGateway({ call: async (m) => { calls.push(m); return listOk(); } });
  await gw.status();
  await gw.status();
  eq(calls.length, 1, 'TTL=-1 回落 45s（窗口内不重探）');
  delete process.env.HIDS_STATUS_TTL_MS;
}

console.log('== A9 详情失败路径的探活短 TTL ==');
{
  clearTtlEnv();
  const calls = [];
  const gw = new CloudwalkerGateway({ call: async (m) => {
    calls.push(m);
    if (m.endsWith('.GetEvent')) throw new Error('GetEvent down');
    return listOk();
  } });
  let e1 = null;
  try { await gw.alert('honeypot', 5); } catch (e) { e1 = e; }
  ok(!!e1, '详情读不到时抛错');
  const listCalls = calls.filter(m => m.endsWith('.List') || m.endsWith('.GetEventList')).length;
  eq(listCalls, 1, '第一次失败：补一次同类列表探活');
  const before = calls.length;
  try { await gw.alert('honeypot', 6); } catch (e) { /* 404 */ }
  eq(calls.filter(m => m.endsWith('.List')).length, 1, '5s 窗口内第二次失败：不再探同类列表');
  ok(calls.length > before, '第二次仍尝试读详情（详情不缓存）');
  clearTtlEnv(); process.env.HIDS_PROBE_TTL_MS = '0';
  const calls0 = [];
  const gw0 = new CloudwalkerGateway({ call: async (m) => {
    calls0.push(m);
    if (m.endsWith('.GetEvent')) throw new Error('down');
    return listOk();
  } });
  try { await gw0.alert('honeypot', 5); } catch (e) {}
  try { await gw0.alert('honeypot', 6); } catch (e) {}
  eq(calls0.filter(m => m.endsWith('.List')).length, 2, 'HIDS_PROBE_TTL_MS=0：每次失败都重新探活');
  delete process.env.HIDS_PROBE_TTL_MS;
}

console.log('== A10 列表首批快照：同源共用、分档、浅拷贝 ==');
{
  clearTtlEnv();
  const calls = [];
  const gw = new CloudwalkerGateway({ call: async (m, p) => {
    calls.push({ m, p });
    return { events: [{ id: 1, created_at: '2026-11-17T10:00:00Z' }], total: 1 };
  } });
  const first = await gw.alerts({ count: 5 });
  const n1 = calls.length;
  const second = await gw.alerts({ count: 5 });
  eq(calls.length, n1, '15s 窗口内第二次 alerts 不再发 RPC');
  eq(second.alerts.length, first.alerts.length, '两次返回同样条数');
  const snapshot = JSON.parse(JSON.stringify(second.alerts));
  first.alerts.reverse();
  first.alerts.push({ id: 'mutated' });
  const third = await gw.alerts({ count: 5 });
  eq(third.alerts, snapshot, '调用方改数组改不到缓存（浅拷贝）');
  await gw.alerts({ count: 30 });
  ok(calls.length > n1, '不同批大小是新键（会重新取数）');
  eq(calls.length - n1, 11, '换批大小后重新拉 11 类');
  const page = await gw.alerts({ count: 5, offset: 10 });
  ok(Array.isArray(page.alerts) && page.alerts.length <= 5, 'offset>0 的请求返回不超过 count 条');
  clearTtlEnv(); process.env.HIDS_LIST_SNAPSHOT_TTL_MS = '0';
  const calls0 = [];
  const gw0 = new CloudwalkerGateway({ call: async (m, p) => { calls0.push(`${m}:${JSON.stringify(p)}`); return { events: [], total: 0 }; } });
  await gw0.alerts({ count: 5 });
  await gw0.alerts({ count: 5 });
  eq(calls0.length, 22, 'HIDS_LIST_SNAPSHOT_TTL_MS=0：两次都取满 11 类');
  delete process.env.HIDS_LIST_SNAPSHOT_TTL_MS;
}
console.log(`\n== 汇总：pass ${pass} / fail ${fails.length} ==`);
if (fails.length) { for (const f of fails) console.log('FAIL:', f); process.exitCode = 1; }
