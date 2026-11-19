// P003-T037 tester probe: A1 增量轮询/退避、A3 结论复用、A4 优先级、A5 并发/队列上限
// 黑盒：只用 docs/modules/triage-pipeline.md 写明的公开构造参数与方法
import { rm } from 'node:fs/promises';
import { TriageMonitor, typeRisk, comparePriority } from '../../../triage-monitor.js';

const ROOT = '/tmp/t37-tester-queue';
await rm(ROOT, { recursive: true, force: true });

let pass = 0; const fails = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log('  ✔', label); }
  else { fails.push(label + (detail ? ' | ' + detail : '')); console.log('  ✖', label, detail); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
const info = (label, v) => console.log('   ·', label, JSON.stringify(v));
const until = async (pred, ms = 3000, step = 10) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await new Promise(r => setTimeout(r, step)); }
  return false;
};

const history = () => ({
  async save(r) { return { alert_id: 'saved', saved_at: new Date(0).toISOString(), verdict: r.verdict }; },
  async latest() { return null; },
});
const mk = (opts) => new TriageMonitor({
  service: {}, investigator: {}, history: history(),
  file: `${ROOT}/${Math.random().toString(36).slice(2)}/state.json`,
  inputMode: 'poll', ...opts,
});

console.log('== A5 配置面：concurrency / queueLimit 非法值回落 ==');
for (const [given, want] of [[3, 3], [0, 2], [-5, 2], [1.5, 2], ['abc', 2], [null, 2], ['', 2], ['4', 4]]) {
  const m = mk({ concurrency: given });
  eq(m.summary().concurrency, want, `concurrency=${JSON.stringify(given)} -> ${want}`);
}
for (const [given, want] of [[5, 5], [0, 1000], [-1, 1000], [1.5, 1000], ['x', 1000], [null, 1000]]) {
  const m = mk({ queueLimit: given });
  eq(m.summary().queue_limit, want, `queueLimit=${JSON.stringify(given)} -> ${want}`);
}
process.env.HIDS_TRIAGE_CONCURRENCY = '3';
eq(mk({}).summary().concurrency, 3, 'env HIDS_TRIAGE_CONCURRENCY=3 -> 3');
process.env.HIDS_TRIAGE_CONCURRENCY = '0';
eq(mk({}).summary().concurrency, 2, 'env HIDS_TRIAGE_CONCURRENCY=0 -> 2');
process.env.HIDS_TRIAGE_CONCURRENCY = 'abc';
eq(mk({}).summary().concurrency, 2, 'env HIDS_TRIAGE_CONCURRENCY=abc -> 2');
delete process.env.HIDS_TRIAGE_CONCURRENCY;
process.env.HIDS_TRIAGE_QUEUE_MAX = '2';
eq(mk({}).summary().queue_limit, 2, 'env HIDS_TRIAGE_QUEUE_MAX=2 -> 2');
process.env.HIDS_TRIAGE_QUEUE_MAX = '0';
eq(mk({}).summary().queue_limit, 1000, 'env HIDS_TRIAGE_QUEUE_MAX=0 -> 1000');
delete process.env.HIDS_TRIAGE_QUEUE_MAX;
eq(mk({ concurrency: 4, queueLimit: 7 }).summary().concurrency, 4, '显式 concurrency=4 优先');
process.env.HIDS_TRIAGE_CONCURRENCY = '3';
eq(mk({}).summary().concurrency, 3, 'env 生效');
eq(mk({ concurrency: 5 }).summary().concurrency, 5, '显式参数优先于 env');
delete process.env.HIDS_TRIAGE_CONCURRENCY;

console.log('== A5 行为面：concurrency=0 不得把队列卡死 ==');
{
  let calls = 0;
  const m = mk({ concurrency: 0, file: `${ROOT}/c0/state.json`, investigator: { async run(id) { calls += 1; return { alert_id: id, verdict: { verdict: 'uncertain' } }; } } });
  await m.enqueue('honeypot:1');
  const done = await until(async () => m.status('honeypot:1')?.status === 'done');
  ok(done, 'concurrency=0：入队后跑成 done（未卡死）', `status=${m.status('honeypot:1')?.status}`);
  eq(m.summary().concurrency, 2, 'concurrency=0 回落 2 后 summary 可读');
  eq(calls, 1, 'concurrency=0：研判执行 1 次');
}

console.log('== A5 队列上限：手动 enqueue 429 + dropped 计数 ==');
{
  const m = mk({ concurrency: 1, queueLimit: 1, file: `${ROOT}/full/state.json`,
    investigator: { run() { return new Promise(() => {}); } } });
  await m.enqueue('honeypot:1');
  const started = await until(async () => m.status('honeypot:1')?.status === 'running');
  ok(started, '第一条进入 running');
  let err = null;
  try { await m.enqueue('honeypot:2'); } catch (e) { err = e; }
  ok(!!err, '队列满时 enqueue 抛错');
  eq(err?.status, 429, '错误状态 429');
  eq(err?.message, '研判队列已满（上限 1），稍后再试', '429 文案与文档一致');
  eq(m.summary().dropped, 1, 'summary().dropped 记 1');
  let err2 = null;
  try { await m.enqueue('honeypot:3'); } catch (e) { err2 = e; }
  eq(m.summary().dropped, 2, 'dropped 只增');
  ok(!!err2 && err2.status === 429, '第二次越限同样 429');
}

console.log('== A5 行为面：并发上限真的限住同时 running 数 ==');
{
  const m = mk({ concurrency: 2, queueLimit: 10, file: `${ROOT}/conc/state.json`,
    investigator: { run() { return new Promise(() => {}); } } });
  for (const id of ['honeypot:1', 'honeypot:2', 'honeypot:3', 'honeypot:4']) await m.enqueue(id);
  await until(async () => m.summary().counts.running === 2, 1000);
  eq(m.summary().counts.running, 2, 'concurrency=2：同时 running 恰 2 条');
  eq(m.summary().counts.queued, 2, '其余 2 条排队');
}

console.log('== A5 轮询批量入队：只丢弃不抛，计入 dropped ==');
{
  let turn = 1; const ids = ['honeypot:11', 'honeypot:12', 'honeypot:13', 'honeypot:14', 'honeypot:15'];
  const m = mk({ concurrency: 1, queueLimit: 1, file: `${ROOT}/polldrop/state.json`,
    intervalMs: 1000,
    service: { async alerts() {
      if (turn++ === 1) return { alerts: [{ id: 'honeypot:1', createdAt: '2026-11-17T10:00:00Z' }] };
      return { alerts: ids.map((id, i) => ({ id, createdAt: `2026-11-17T10:00:0${i + 1}Z` })) };
    } },
    investigator: { run() { return new Promise(() => {}); } },
  });
  await m.load();
  await m.poll();
  let threw = null;
  try { await m.poll(); } catch (e) { threw = e; }
  ok(threw === null, '轮询批量入队越限不抛错');
  eq(m.summary().dropped, 4, '5 条新告警、上限 1 -> 丢 4');
  eq(m.records.size, 1, '队列里只留 1 条记录');
}

console.log('== TriageSummary 形状（openapi TriageSummary required + P003-T037 新键）==');
{
  const m = mk({ concurrency: 2, queueLimit: 9, intervalMs: 30000, file: `${ROOT}/sum/state.json` });
  const s = m.summary();
  for (const k of ['initialized', 'enabled', 'input_mode', 'last_poll_at', 'last_error', 'backoff_ms', 'empty_polls', 'concurrency', 'queue_limit', 'dropped', 'counts', 'verdict_counts', 'type_counts', 'interval_ms']) {
    ok(k in s, `summary 有键 ${k}`);
  }
  eq(typeof s.initialized, 'boolean', 'initialized 布尔');
  eq(typeof s.enabled, 'boolean', 'enabled 布尔');
  eq(s.input_mode, 'poll', 'input_mode=poll');
  eq(s.queue_limit, 9, 'queue_limit 读显式值');
  eq(s.concurrency, 2, 'concurrency 读显式值');
  ok(Number.isInteger(s.backoff_ms) && s.backoff_ms > 0, 'backoff_ms 是正整数', String(s.backoff_ms));
  ok(Number.isInteger(s.empty_polls) && s.empty_polls === 0, 'empty_polls 初始 0');
  eq(s.dropped, 0, 'dropped 初始 0');
  eq(s.interval_ms, 30000, 'poll 模式带 interval_ms');
  ok(!('syslog' in s), 'poll 模式没有 syslog 键');
  eq(Object.keys(s.counts).sort(), ['done', 'failed', 'queued', 'running'], 'counts 四键恒在');
  eq(Object.keys(s.verdict_counts).sort(), ['false_positive', 'review', 'threat', 'uncertain'], 'verdict_counts 四键恒在');
  ok(s.type_counts && typeof s.type_counts === 'object', 'type_counts 是对象');
}

console.log('== A1 增量轮询：from 游标 / 固定排序键 / 不翻页找边界 ==');
{
  const queries = [];
  let rows = [{ id: 'honeypot:1', createdAt: '2026-11-17T10:00:00Z' }];
  const m = mk({ concurrency: 1, intervalMs: 1000, maxBackoffMs: 8000, file: `${ROOT}/poll1/state.json`,
    service: { async alerts(q) { queries.push(q); return { alerts: rows, partial: false }; } },
    investigator: { async run(id) { return { alert_id: id, verdict: {} }; } } });
  await m.load();
  const cold = await m.poll();
  eq(queries[0], { count: 50, offset: 0, sort: 'time' }, '冷启动查询：无 from、count 50、sort=time');
  eq(m.watermark, '2026-11-17T10:00:00Z', '冷启动把游标钉在最新时间');
  eq(m.records.size, 0, '首轮不入队');
  info('cold', cold);
  rows = [...rows, { id: 'honeypot:2', createdAt: '2026-11-17T10:00:10Z' }];
  const inc = await m.poll();
  eq(queries[1], { count: 50, offset: 0, sort: 'time', from: '2026-11-17T10:00:00Z' }, '第二轮带 from=watermark');
  eq(inc.found, 1, '第二轮找到 1 条新告警');
  eq(m.watermark, '2026-11-17T10:00:10Z', '游标推进到新时间');
  eq(queries.length, 2, '没有为找边界而翻页（2 轮共 2 次查询）');
}

console.log('== A1 平台忽略 from：同秒行按 watermark_ids 去重 ==');
{
  const same = [{ id: 'honeypot:1', createdAt: '2026-11-17T10:00:00Z' }, { id: 'honeypot:2', createdAt: '2026-11-17T10:00:00Z' }];
  const m = mk({ concurrency: 1, intervalMs: 1000, file: `${ROOT}/poll2/state.json`,
    service: { async alerts() { return { alerts: same, partial: false }; } },
    investigator: { async run(id) { return { alert_id: id, verdict: {} }; } } });
  await m.load();
  await m.poll();
  eq(m.records.size, 0, '首轮钉游标、不入队');
  const second = await m.poll();
  eq(second.found, 0, '同秒重复在第二轮不再算新增');
  eq(m.records.size, 0, '同秒重复不再入队');
  eq([...m.watermarkIds].sort(), ['honeypot:1', 'honeypot:2'], 'watermark_ids 记下同一秒的 ID');
}

console.log('== A1 partial 失败：游标不推进 ==');
{
  const m = mk({ concurrency: 1, intervalMs: 1000, file: `${ROOT}/poll3/state.json`,
    service: { async alerts() { return { partial: true, alerts: [] }; } } });
  await m.load();
  await m.poll();
  eq(m.lastError, '部分牧云事件类型读取失败，暂缓推进自动研判游标', 'partial 错误文案');
  eq(m.watermark, null, 'partial 时游标不动');
}

console.log('== A1 20 页上限 ==');
{
  const m = mk({ concurrency: 1, intervalMs: 1000, file: `${ROOT}/poll4/state.json`,
    service: { async alerts({ offset }) { return { alerts: Array.from({ length: 50 }, (_, i) => ({ id: `honeypot:${offset + i + 1}`, createdAt: '2026-11-17T10:00:00Z' })) }; } } });
  await m.load(); m.initialized = true; m.watermark = '2026-11-17T09:00:00Z';
  await m.poll();
  eq(m.lastError, '新增告警超过本轮扫描上限，请检查自动研判积压', '20 页取满报错文案');
}

console.log('== A1 指数退避与回常态 ==');
{
  let turn = 0; let fresh = false;
  const m = mk({ concurrency: 1, intervalMs: 1000, maxBackoffMs: 3000, file: `${ROOT}/backoff/state.json`,
    service: { async alerts() {
      turn += 1;
      if (fresh) { fresh = false; return { alerts: [{ id: 'honeypot:9', createdAt: '2026-11-17T10:05:00Z' }] }; }
      if (turn === 1) return { alerts: [{ id: 'honeypot:1', createdAt: '2026-11-17T10:00:00Z' }] };
      if (turn === 2) return { alerts: [{ id: 'honeypot:1', createdAt: '2026-11-17T10:00:00Z' }, { id: 'honeypot:2', createdAt: '2026-11-17T10:00:05Z' }] };
      return { alerts: [], partial: false };
    } },
    investigator: { async run(id) { return { alert_id: id, verdict: {} }; } } });
  await m.load();
  await m.poll();
  eq([m.backoffMs, m.emptyPolls], [2000, 1], '冷启动轮计入空轮：backoff=2×interval、empty_polls=1（docs/modules/triage-pipeline.md:384）');
  await m.poll();
  eq([m.backoffMs, m.emptyPolls], [1000, 0], '见到新告警：backoff=interval、empty=0');
  await m.poll();
  eq([m.backoffMs, m.emptyPolls], [2000, 1], '空轮 1 -> 2000');
  await m.poll();
  eq([m.backoffMs, m.emptyPolls], [3000, 2], '空轮 2 -> min(4000,3000)=3000');
  await m.poll();
  eq([m.backoffMs, m.emptyPolls], [3000, 3], '空轮 3 -> 保持上限 3000');
  eq(m.summary().backoff_ms, 3000, 'summary().backoff_ms 同步');
  eq(m.summary().empty_polls, 3, 'summary().empty_polls 同步');
  fresh = true;
  await m.poll();
  eq([m.backoffMs, m.emptyPolls], [1000, 0], '见到新告警立刻回常态');
  eq(m.summary().backoff_ms, 1000, 'summary().backoff_ms 回到 interval');
}

console.log('== A1 stop() 之后不得复活 ==');
{
  let polls = 0;
  const m = mk({ concurrency: 1, intervalMs: 20, file: `${ROOT}/stop/state.json`,
    service: { async alerts() { polls += 1; return { alerts: [], partial: false }; } } });
  await m.start();
  ok(await until(async () => polls >= 2, 1000), 'start() 后至少轮询 2 轮', `polls=${polls}`);
  m.stop();
  const atStop = polls;
  await new Promise(r => setTimeout(r, 150));
  eq(polls, atStop, 'stop() 后 150ms 内不再轮询');
}

console.log('== A3 结论复用：同指纹不同秒 + 上一条已完结 ==');
{
  let runs = 0;
  const investigator = { async runUnmatchedSyslog() { runs += 1; return { verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: 'u' } }; } };
  const m = mk({ concurrency: 1, inputMode: 'syslog', file: `${ROOT}/reuse/state.json`, casesDirectory: `${ROOT}/reuse/cases`,
    investigator, history: history() });
  await m.start();
  const line = (sec) => `<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5 process_command_line="id" event_create_time="2026-11-17 ${sec}"`;
  const a = await m.acceptSyslog(line('10:00:00'));
  ok(await until(async () => m.status(a.alert_id)?.status === 'done'), '第一条跑成 done');
  const b = await m.acceptSyslog(line('10:02:00'));
  eq(b.reused, true, '第二条命中结论复用');
  eq(b.alert_id, a.alert_id, '复用不新建记录');
  eq(b.repeat_count, 2, 'repeat_count 累加到 2');
  eq(runs, 1, '复用不再跑研判');
  eq(m.records.size, 1, 'records 里仍只有 1 条');
  const st = m.status(a.alert_id);
  eq(st.repeat_count, 2, '记录上的 repeat_count 同步');
  eq(st.verdict, 'uncertain', '结论原样保留');
}

console.log('== A3 上一条未完结：不复用 ==');
{
  let runs = 0;
  const m = mk({ concurrency: 1, inputMode: 'syslog', file: `${ROOT}/noreuse/state.json`, casesDirectory: `${ROOT}/noreuse/cases`,
    investigator: { runUnmatchedSyslog() { runs += 1; return new Promise(() => {}); } }, history: history() });
  await m.start();
  const line = (sec) => `<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5 process_command_line="id" event_create_time="2026-11-17 ${sec}"`;
  const a = await m.acceptSyslog(line('10:00:00'));
  const b = await m.acceptSyslog(line('10:02:00'));
  ok(!b.reused, '上一条未完结不复用');
  ok(b.alert_id !== a.alert_id, '未完结时新建记录');
  eq(m.records.size, 2, 'records 两条');
}

console.log('== A4 类型风险表与比较器 ==');
{
  const want = { memory_webshell: 11, webshell: 10, revshell: 10, malware: 10, memory_security: 9, honeypot: 8, elevation_process: 8, brute_force: 7, abnormal_login: 6, suspicious_operation: 5, network_audit: 4 };
  for (const [k, v] of Object.entries(want)) eq(typeRisk[k], v, `typeRisk[${k}]=${v}`);
  const mkRec = (id, occ, at) => ({ alert_id: id, occurrence_count: occ, created_at: at });
  const hi = mkRec('memory_webshell:1', 1, '2026-11-17T10:00:00Z');
  const lo = mkRec('network_audit:1', 99, '2026-11-17T09:00:00Z');
  ok(comparePriority(hi, lo) < 0, '风险高的排前面（压过 occurrence）');
  const o2 = mkRec('revshell:2', 2, '2026-11-17T10:00:00Z');
  const o1 = mkRec('revshell:1', 1, '2026-11-17T09:00:00Z');
  ok(comparePriority(o2, o1) < 0, '同风险按 occurrence_count desc');
  const early = mkRec('revshell:3', 1, '2026-11-17T09:00:00Z');
  const late = mkRec('revshell:4', 1, '2026-11-17T10:00:00Z');
  ok(comparePriority(early, late) < 0, '同风险同次数按 created_at asc');
  const unknown = mkRec('nope:1', 99, '2026-11-17T08:00:00Z');
  const lowest = mkRec('network_audit:9', 1, '2026-11-17T10:00:00Z');
  ok(comparePriority(lowest, unknown) < 0, '表外类型按风险 0 排在最低档之后');
}

console.log('== A4 执行顺序：排队中被高优先级插队 ==');
{
  const order = [];
  let release; const gate = new Promise(r => { release = r; });
  let first = true;
  const investigator = { async run(id) { order.push(id); if (first) { first = false; await gate; } return { alert_id: id, verdict: {} }; } };
  const m = mk({ concurrency: 1, file: `${ROOT}/prio/state.json`, investigator, history: history() });
  await m.enqueue('network_audit:1');            // 先跑（占住并发位）
  await until(async () => m.status('network_audit:1')?.status === 'running');
  await m.enqueue('honeypot:2');                 // 风险 8，先入队
  await m.enqueue('memory_webshell:3');          // 风险 11，后入队
  release();
  await until(async () => m.status('memory_webshell:3')?.status === 'done' && m.status('honeypot:2')?.status === 'done');
  eq(order, ['network_audit:1', 'memory_webshell:3', 'honeypot:2'], 'drain 按风险取队首（后入队的高风险先跑）');
}

console.log(`\n== 汇总：pass ${pass} / fail ${fails.length} ==`);
if (fails.length) { for (const f of fails) console.log('FAIL:', f); process.exitCode = 1; }
