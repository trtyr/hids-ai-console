// P003-T036 单测：队列可靠性与恢复（A1–A9）。
// 跑法：node --test --test-timeout=60000 evidence/test/P003-T036/queue-reliability.test.js
// 纪律：无真实网络、无真实时钟依赖、无固定 sleep——等状态用带超时上界的 until()。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createServer } from '../../../server.js';

async function tempDir(t, prefix = 'hids-t036-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  return directory;
}

// 等条件成立，带超时上界；不写固定 sleep。
async function until(check, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时未满足：${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

// 一条合法的牧云 syslog 报文；改 source_ip 就是一个新事件（指纹不同）。
function syslogLine({ sourceIp = '192.0.2.2', second = '2026-11-03 08:00:00' } = {}) {
  return '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot '
    + `host_ip="10.0.0.5" event_create_time="${second}" source_ip="${sourceIp}" target_port="80"`;
}

function syslogMonitor({ directory, investigator = {}, ...options }) {
  return new TriageMonitor({ inputMode: 'syslog', concurrency: 1, service: {},
    history: new InvestigationStore(path.join(directory, 'investigations')),
    file: path.join(directory, 'queue.json'), casesDirectory: path.join(directory, 'cases'),
    eventToolbox: null, investigator,
    ...options });
}

const okInvestigator = (calls = []) => ({
  runUnmatchedSyslog: async input => {
    calls.push(input.parsed.payload.source_ip || input.parsed.msgid);
    return { mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '待复核', claims: [] },
      validation: { ok: true }, evidence: [] };
  },
  run: async alertId => { calls.push(alertId);
    return { alert_id: alertId, mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '待复核', claims: [] },
      validation: { ok: true }, evidence: [] }; }
});

// ── A1 失败退避与死信 ─────────────────────────────────────────────────────────
test('A1 退避曲线：每次失败翻倍、封顶 retryMaxMs，到上限判死信且不再有下次时刻', () => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-t036-backoff.json', service: {}, investigator: {}, history: {},
    retryBaseMs: 100, retryMaxMs: 1000, retryMaxAttempts: 10 });
  const record = { alert_id: 'honeypot:1', status: 'failed', failure: { reason: '模型不可达' } };
  const delayOf = attempts => {
    record.attempts = attempts;
    monitor.scheduleRetry(record);
    return record.next_attempt_at == null ? null : Date.parse(record.next_attempt_at) - Date.now();
  };
  const delays = [1, 2, 3, 4, 5].map(delayOf);
  // 100 → 200 → 400 → 800 → 封顶 1000：允许十几毫秒的调度抖动，但不允许不翻倍/不封顶
  for (const [index, expected] of [100, 200, 400, 800, 1000].entries())
    assert.ok(delays[index] >= expected - 15 && delays[index] <= expected + 60,
      `第 ${index + 1} 次退避 ${delays[index]}ms，应为 ${expected}ms`);
  // 上限判定：attempts 到 10 就死信，没有下次时刻
  record.attempts = 10;
  monitor.scheduleRetry(record);
  assert.equal(record.dead_letter, true);
  assert.equal(record.next_attempt_at, null);
});

test('A1 瞬时故障自动重排后跑通，不再需要人工重跑', async t => {
  const directory = await tempDir(t);
  let calls = 0;
  const monitor = syslogMonitor({ directory, retryBaseMs: 5, retryMaxMs: 20, retryMaxAttempts: 3,
    investigator: { runUnmatchedSyslog: async () => {
      if (++calls < 3) throw Object.assign(new Error('模型不可达'), { code: 'ETIMEDOUT' });
      return { mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '重试成功', claims: [] },
        validation: { ok: true }, evidence: [] };
    } } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(syslogLine());
  const done = await until(() => monitor.status(accepted.alert_id)?.status === 'done' && monitor.status(accepted.alert_id), { label: '自动重排后跑完' });
  assert.equal(calls, 3);
  assert.equal(done.attempts, 3);
  assert.equal(done.dead_letter, false);
  assert.equal(done.next_attempt_at, null);
  assert.equal(monitor.summary().retry.dead_letters, 0);
});

test('A1 连续失败到上限进死信：保留原因、不再自动跑、summary 报得上', async t => {
  const directory = await tempDir(t);
  let calls = 0;
  const monitor = syslogMonitor({ directory, retryBaseMs: 5, retryMaxMs: 20, retryMaxAttempts: 3,
    investigator: { runUnmatchedSyslog: async () => {
      calls += 1;
      throw Object.assign(new Error('模型不可达'), { code: 'ETIMEDOUT' });
    } } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(syslogLine());
  const dead = await until(() => monitor.status(accepted.alert_id)?.dead_letter && monitor.status(accepted.alert_id), { label: '进死信' });
  assert.equal(calls, 3);
  assert.equal(dead.status, 'failed');
  assert.equal(dead.attempts, 3);
  // P003-T052：`failure.reason` 只写闸后文案；具体错误码仍在 `failure.code`。
  assert.equal(dead.failure.reason, `上游调用失败，原文 ${'模型不可达'.length} 字未落盘`);
  assert.equal(dead.failure.code, 'ETIMEDOUT');
  assert.match(dead.failure.at, /^\d{4}-\d\d-\d\dT/);
  // 死信不再自动跑：等过两个退避窗口，调用次数不动
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 3);
  const summary = monitor.summary();
  assert.equal(summary.retry.max_attempts, 3);
  assert.equal(summary.retry.dead_letters, 1);
  assert.equal(summary.queue.retry_waiting, 0);
  assert.equal(summary.failure_reasons[`上游调用失败，原文 ${'模型不可达'.length} 字未落盘`], 1);
});

test('A1 失败记录跨重启仍会重排：load + start 后逾期的那条自动回队', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'queue.json');
  await writeFile(file, JSON.stringify({ initialized: true, records: [{
    alert_id: 'syslog:honeypot:aaaaaaaaaaaaaaaa:1793692800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e01',
    status: 'failed', attempts: 1, stage: '研判失败', detail: '模型不可达',
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z',
    failure: { reason: '模型不可达', code: 'ETIMEDOUT', at: '2026-11-03T08:00:00.000Z' } }] }));
  const calls = [];
  const monitor = new TriageMonitor({ inputMode: 'syslog', concurrency: 1, service: {},
    file, history: new InvestigationStore(path.join(directory, 'investigations')),
    investigator: okInvestigator(calls), retryBaseMs: 5, retryMaxAttempts: 3 });
  await monitor.start();
  const alertId = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1793692800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e01';
  await until(() => calls.length === 1, { label: '逾期失败记录回队重跑' });
  assert.equal(monitor.status(alertId).attempts, 2);
});

// ── A2 暂停不丢、恢复回灌、游标不动 ───────────────────────────────────────────
test('A2 暂停期间报文进缓冲，重启仍在，恢复先回灌（一条不丢）', async t => {
  const directory = await tempDir(t);
  const calls = [];
  const options = { directory, investigator: okInvestigator(calls) };
  const monitor = syslogMonitor(options);
  await monitor.start();
  const cursor = '2026-11-03T08:00:00.000Z';
  monitor.watermark = cursor;
  monitor.watermarkIds = new Set(['honeypot:1']);
  await monitor.setEnabled(false);
  for (const sourceIp of ['192.0.2.11', '192.0.2.12', '192.0.2.13'])
    assert.equal((await monitor.acceptSyslog(syslogLine({ sourceIp }))).buffered, true);
  const paused = monitor.summary().paused;
  assert.equal(paused.active, true);
  assert.equal(paused.received, 3);
  assert.equal(paused.buffered, 3);
  assert.equal(paused.dropped, 0);

  // 重启：缓冲随队列落盘（热路径是合并写，落盘用 writeChain 同步一下），游标也原样保留
  await monitor.writeChain;
  const resumed = syslogMonitor(options);
  await resumed.load();
  assert.equal(resumed.summary().paused.buffered, 3);
  assert.equal(resumed.watermark, cursor);
  assert.deepEqual([...resumed.watermarkIds], ['honeypot:1']);

  await resumed.setEnabled(true);
  await until(() => calls.length === 3, { label: '回灌后三条都进研判' });
  assert.deepEqual(calls.sort(), ['192.0.2.11', '192.0.2.12', '192.0.2.13']);
  const after = resumed.summary().paused;
  assert.equal(after.buffered, 0);
  assert.equal(after.replayed, 3);
  assert.equal(resumed.watermark, cursor);
});

test('A2 暂停缓冲有上限：超出的丢弃要计数，不静默涨内存', async t => {
  const directory = await tempDir(t);
  const monitor = syslogMonitor({ directory, pausedBufferLimit: 2, investigator: okInvestigator() });
  await monitor.start();
  await monitor.setEnabled(false);
  const results = [];
  for (const sourceIp of ['192.0.2.21', '192.0.2.22', '192.0.2.23'])
    results.push(await monitor.acceptSyslog(syslogLine({ sourceIp })));
  assert.deepEqual(results.map(result => result.buffered), [true, true, false]);
  assert.equal(results[2].dropped, true);
  const summary = monitor.summary();
  assert.equal(summary.paused.received, 3);
  assert.equal(summary.paused.buffered, 2);
  assert.equal(summary.paused.dropped, 1);
  assert.equal(summary.syslog_stats.dropped, 1);
});

test('A2 暂停期间新增的告警恢复后不漏：轮询游标留在原处', async t => {
  const directory = await tempDir(t);
  let rows = [{ id: 'honeypot:1', createdAt: '2026-11-03T08:00:00.000Z' }];
  const monitor = new TriageMonitor({ concurrency: 1, file: path.join(directory, 'queue.json'),
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async ({ count, offset }) => ({ alerts: rows.slice(offset, offset + count), partial: false }) },
    investigator: okInvestigator() });
  await monitor.start();
  const cursor = monitor.watermark;
  await monitor.setEnabled(false);
  rows = [{ id: 'honeypot:2', createdAt: new Date(Date.now() - 1000).toISOString() }, ...rows];
  await monitor.poll();
  assert.equal(monitor.status('honeypot:2'), null);
  await monitor.setEnabled(true);
  await until(() => monitor.status('honeypot:2')?.status === 'done', { label: '恢复后补上暂停期间的新增告警' });
  // 游标只有在真正消费到新告警之后才前进，不是恢复按钮一按就跳过去
  assert.ok(monitor.watermark >= cursor);
  monitor.stop();
});

// ── A3 删记录同步失效 dedupe ─────────────────────────────────────────────────
test('A3 取消排队记录时同步失效 dedupe：同一报文再来不会落在已删记录上', async t => {
  const directory = await tempDir(t);
  // concurrency 0：入队但不跑，稳定停在 queued（这样才可取消）
  const monitor = syslogMonitor({ directory, concurrency: 0, investigator: okInvestigator() });
  await monitor.start();
  const line = syslogLine({ sourceIp: '192.0.2.31' });
  const accepted = await monitor.acceptSyslog(line);
  assert.equal(monitor.status(accepted.alert_id).status, 'queued');
  assert.ok([...monitor.dedupe.values()].some(entry => entry.record_id === accepted.alert_id));

  const cancelled = await monitor.cancel(accepted.alert_id);
  assert.deepEqual(cancelled, { alert_id: accepted.alert_id, status: 'not_queued', cancelled: true });
  assert.equal(monitor.status(accepted.alert_id), null);
  assert.equal([...monitor.dedupe.values()].some(entry => entry.record_id === accepted.alert_id), false);

  // 悬空引用不再发生：同一报文再来，是一条新记录（不是合并到已删记录）
  const again = await monitor.acceptSyslog(line);
  assert.notEqual(again.alert_id, accepted.alert_id);
  assert.equal(monitor.status(again.alert_id).status, 'queued');
  assert.equal([...monitor.dedupe.values()].some(entry => entry.record_id === again.alert_id), true);
});

test('A3/A9 取消的边界：没有记录 404、已在研判 409、其余状态不被顺手删掉', async t => {
  const directory = await tempDir(t);
  const monitor = syslogMonitor({ directory, concurrency: 0, investigator: okInvestigator() });
  await monitor.start();
  await assert.rejects(() => monitor.cancel('honeypot:404'), error => error.status === 404);
  const accepted = await monitor.acceptSyslog(syslogLine({ sourceIp: '192.0.2.41' }));
  monitor.records.get(accepted.alert_id).status = 'running';
  await assert.rejects(() => monitor.cancel(accepted.alert_id), error => error.status === 409 && /running/.test(error.message));
  assert.notEqual(monitor.status(accepted.alert_id), null);
});

// ── A4 标脏 + 合并写 ─────────────────────────────────────────────────────────
class CountingMonitor extends TriageMonitor {
  constructor(options) {
    super(options);
    this.snapshots = 0;
  }
  async writeSnapshot() {
    this.snapshots += 1;
    return super.writeSnapshot();
  }
}

test('A4 重复投递不再每次全量重存：20 条重复 → 快照与研判记录重存都在合并写窗口里合并', async t => {
  const directory = await tempDir(t);
  let saves = 0;
  const history = {
    latest: async (key, mode) => ({ alert_id: key, mode, repeat_count: 1, saved_at: '2026-11-03T08:00:00.000Z' }),
    save: async () => { saves += 1; return {}; }
  };
  const monitor = new CountingMonitor({ inputMode: 'syslog', concurrency: 0, service: {}, history,
    file: path.join(directory, 'queue.json'), casesDirectory: path.join(directory, 'cases'),
    investigator: okInvestigator(), persistIntervalMs: 60 });
  await monitor.start();
  const line = syslogLine({ sourceIp: '192.0.2.51' });
  const accepted = await monitor.acceptSyslog(line);
  // 研判已完成的状态：重复投递才走「重存研判记录里的 repeat_count」这条支路
  const record = monitor.records.get(accepted.alert_id);
  record.status = 'done';
  record.result_alert_id = 'honeypot:51';
  const baseline = monitor.snapshots;
  for (let index = 0; index < 20; index++) assert.equal((await monitor.acceptSyslog(line)).collapsed, true);
  assert.equal(record.repeat_count, 21);
  // 20 条重复投递没有各自打一次盘
  assert.ok(monitor.snapshots - baseline <= 2, `20 条重复投递写了 ${monitor.snapshots - baseline} 次快照`);
  assert.ok(saves <= 2, `20 条重复投递重存了 ${saves} 次研判记录`);
  await monitor.persist();
  // 落盘后计数只涨一次：合并在合并写里，且落下的是最终值
  assert.ok(saves >= 1 && saves <= 3, `合并写落盘后共重存 ${saves} 次`);
});

test('A4 写盘窗口可查：缺省 1 次/秒（峰值 ≤1 次/秒量级）', () => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-t036-persist.json', service: {}, investigator: {}, history: {} });
  assert.equal(monitor.summary().persist.interval_ms, 1000);
  assert.equal(monitor.summary().persist.unflushed, false);
});

// 复审补的 liveness 用例：写在飞期间标脏，markDirty 会早退（不排 timer），写完后必须有人补排，
// 否则这份脏状态永远不落盘——「崩溃最多丢一个合并写窗口」就不成立了。
test('A4 在飞写期间标脏不丢：写完补排下一次合并写，脏状态最终落盘', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'queue.json');
  const monitor = new TriageMonitor({ inputMode: 'syslog', concurrency: 0, service: {},
    history: { async latest() { return null; }, async save() { return {}; } },
    file, casesDirectory: path.join(directory, 'cases'), investigator: {}, persistIntervalMs: 40 });
  // 第一次写挂在在飞状态，测试放行后才真的写——真实 fs 的延迟用 gate 确定性地模拟
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const write = monitor.writeSnapshot.bind(monitor);
  let inFlight = 0;
  monitor.writeSnapshot = async () => { inFlight += 1; await gate; return write(); };
  monitor.markDirty();
  await until(() => inFlight === 1, { label: '第一次合并写进入在飞' });
  monitor.records.set('inflight-proof', { alert_id: 'inflight-proof', status: 'queued' });
  monitor.markDirty();   // 在飞期间：这一次没有任何人排 timer
  release();
  // 不调 persist()：补排的那次合并写必须自己把这份脏状态带到盘上
  await until(async () => {
    try {
      const snapshot = JSON.parse(await readFile(file, 'utf8'));
      return snapshot.records.some(record => record.alert_id === 'inflight-proof');
    } catch { return false; }
  }, { label: '在飞期间标的脏最终落盘' });
  await until(() => monitor.summary().persist.unflushed === false, { label: '脏代数归零' });
  monitor.stop();
});

// ── A5 done 记录 TTL 归档 ────────────────────────────────────────────────────
test('A5 过期 done 记录归档出内存 Map：写进 .archive.jsonl、失效 dedupe、全表不再背着它', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'queue.json');
  const monitor = new TriageMonitor({ file, service: {}, investigator: {}, history: {}, doneTtlMs: 60_000 });
  const now = Date.now();
  const done = (alertId, ageMs) => ({ alert_id: alertId, status: 'done', created_at: new Date(now - ageMs).toISOString(),
    updated_at: new Date(now - ageMs).toISOString(), verdict: 'threat' });
  monitor.records.set('syslog:honeypot:old', done('syslog:honeypot:old', 600_000));
  monitor.records.set('syslog:honeypot:fresh', done('syslog:honeypot:fresh', 1_000));
  monitor.records.set('syslog:honeypot:queued', { alert_id: 'syslog:honeypot:queued', status: 'queued',
    created_at: new Date(now - 600_000).toISOString(), updated_at: new Date(now - 600_000).toISOString() });
  monitor.dedupe.set('fp-old', { record_id: 'syslog:honeypot:old', last_seen: 1 });
  monitor.dedupe.set('fp-fresh', { record_id: 'syslog:honeypot:fresh', last_seen: 1 });

  const result = await monitor.archiveDone({ now });
  assert.deepEqual(result, { archived: 1, remaining: 2 });
  assert.equal(monitor.status('syslog:honeypot:old'), null);
  // P003-T060 起 cases() 不再按 input 过滤：这里断言的是「归档那条不在列表里」，其余照常在列。
  assert.equal(monitor.cases().total, 2);
  assert.equal(monitor.cases().cases.some(item => item.alert_id === 'syslog:honeypot:old'), false);
  assert.equal(monitor.status('syslog:honeypot:fresh').status, 'done');
  assert.equal(monitor.status('syslog:honeypot:queued').status, 'queued');
  assert.equal(monitor.dedupe.has('fp-old'), false);
  assert.equal(monitor.dedupe.has('fp-fresh'), true);
  const archived = (await readFile(`${file}.archive.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].alert_id, 'syslog:honeypot:old');
  assert.match(archived[0].archived_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(monitor.summary().archived.count, 1);
  assert.equal(monitor.summary().archived.ttl_ms, 60_000);
});

// ── A6 summary 可观测面 ─────────────────────────────────────────────────────
test('A6 summary 报队列深度、最老等待时长、失败原因分布', () => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-t036-summary.json', service: {}, investigator: {}, history: {},
    retryBaseMs: 100, retryMaxMs: 1000, retryMaxAttempts: 3 });
  const now = Date.now();
  monitor.records.set('honeypot:1', { alert_id: 'honeypot:1', status: 'queued',
    created_at: new Date(now - 5000).toISOString(), updated_at: new Date(now - 5000).toISOString() });
  monitor.records.set('honeypot:2', { alert_id: 'honeypot:2', status: 'queued',
    created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString() });
  monitor.records.set('honeypot:3', { alert_id: 'honeypot:3', status: 'failed', attempts: 2,
    failure: { reason: '模型不可达' } });
  monitor.records.set('honeypot:4', { alert_id: 'honeypot:4', status: 'failed', attempts: 3, dead_letter: true,
    failure: { reason: '模型不可达' } });
  monitor.records.set('honeypot:5', { alert_id: 'honeypot:5', status: 'failed', attempts: 1,
    failure: { reason: '牧云超时' } });
  const summary = monitor.summary();
  assert.equal(summary.queue.depth, 2);
  assert.equal(summary.queue.oldest_alert_id, 'honeypot:1');
  assert.ok(summary.queue.oldest_wait_ms >= 4900 && summary.queue.oldest_wait_ms < 6000, `最老等待 ${summary.queue.oldest_wait_ms}ms`);
  assert.equal(summary.queue.retry_waiting, 2);
  assert.deepEqual(summary.retry, { base_ms: 100, max_ms: 1000, max_attempts: 3, dead_letters: 1 });
  assert.deepEqual(summary.failure_reasons, { 模型不可达: 2, 牧云超时: 1 });
  // 空队列也是完整的键，不是 undefined
  const empty = new TriageMonitor({ file: '/tmp/hids-t036-summary-empty.json', service: {}, investigator: {}, history: {} }).summary();
  assert.deepEqual(empty.queue, { depth: 0, running: 0, oldest_wait_ms: null, oldest_alert_id: null, retry_waiting: 0 });
  assert.deepEqual(empty.failure_reasons, {});
});

// ── A7 回补键不一致 ─────────────────────────────────────────────────────────
test('A7 启动回补用结果键/匹配键取研判记录，不再拿 syslog 队列键去撞文件键', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'queue.json');
  const alertId = 'syslog:revshell:bbbbbbbbbbbbbbbb:1793692800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e02';
  await writeFile(file, JSON.stringify({ initialized: true, records: [
    // 队列键是 syslog:<类型>:<指纹>:<秒>:<uuid>，研判文件键是牧云事件 ID（matched_alert_id）
    { alert_id: alertId, matched_alert_id: 'revshell:77', status: 'done',
      created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z' },
    // 有新键就用新键：result_alert_id 优先于 matched_alert_id
    { alert_id: 'syslog:honeypot:cccccccccccccccc:1793692800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e03',
      matched_alert_id: 'honeypot:88', result_alert_id: 'honeypot:99', status: 'done',
      created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z' }
  ] }));
  const asked = [];
  const history = { latest: async (key, mode) => { asked.push(key);
    return { alert_id: key, mode, verdict: { claims: [{ text: 'x', citations: [{ evidence_id: `cw:${key}` }] }] },
      validation: { ok: true }, evidence: [{ evidence_id: `cw:${key}`, tool: 'get_event', fetched_at: '2026-11-03T08:00:01.000Z', sha256: 'a'.repeat(64) }] }; } };
  const monitor = new TriageMonitor({ file, service: {}, investigator: {}, history });
  await monitor.load();
  assert.deepEqual(asked, ['revshell:77', 'honeypot:99']);
  assert.equal(monitor.status(alertId).evidence[0].evidence_id, 'cw:revshell:77');
  assert.equal(monitor.status(alertId).verified_facts, 1);
  assert.equal(monitor.status('syslog:honeypot:cccccccccccccccc:1793692800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e03').evidence[0].evidence_id, 'cw:honeypot:99');
});

test('A7 三个键都取不到时退回队列键，读不到也不炸', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'queue.json');
  await writeFile(file, JSON.stringify({ initialized: true, records: [{ alert_id: 'honeypot:5', status: 'done',
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z' }] }));
  const asked = [];
  const history = { latest: async key => { asked.push(key); return null; } };
  const monitor = new TriageMonitor({ file, service: {}, investigator: {}, history });
  await monitor.load();
  assert.deepEqual(asked, ['honeypot:5']);
  assert.deepEqual(monitor.status('honeypot:5').evidence, []);
});

// ── A8 收包计数 ─────────────────────────────────────────────────────────────
test('A8 收包计数进 summary：收入 / 新记录 / 合并 / 拒绝 各归各的', async t => {
  const directory = await tempDir(t);
  const monitor = syslogMonitor({ directory, concurrency: 0, investigator: okInvestigator() });
  await monitor.start();
  const line = syslogLine({ sourceIp: '192.0.2.61' });
  await monitor.acceptSyslog(line);
  await monitor.acceptSyslog(line);
  await monitor.acceptSyslog('这不是一条 syslog 行');
  await monitor.acceptSyslog('<134>1 2026-11-03T08:00:20Z host app 1 cloudwalker-unknown-msgid host_ip="10.0.0.5"');
  const stats = monitor.summary().syslog_stats;
  assert.deepEqual(stats, { inbound: 4, accepted: 1, collapsed: 1, buffered: 0, dropped: 0, rejected: 2, failed: 0 });
});

// ── A9 HTTP 取消接口 ────────────────────────────────────────────────────────
test('A9 DELETE /api/agent/triage/{alertId}：取消排队案件，之后读状态是 not_queued', async t => {
  const directory = await tempDir(t);
  const monitor = syslogMonitor({ directory, concurrency: 0, investigator: okInvestigator() });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(syslogLine({ sourceIp: '192.0.2.71' }));
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/agent/triage/${encodeURIComponent(accepted.alert_id)}`;

  const cancelled = await fetch(url, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { alert_id: accepted.alert_id, status: 'not_queued', cancelled: true });
  const after = await (await fetch(url)).json();
  assert.equal(after.status, 'not_queued');
  // 再取消一次：没有记录 → 404 caller_error；无效 ID → 400
  const again = await fetch(url, { method: 'DELETE' });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).code, 'caller_error');
  assert.equal((await fetch(`${base}/api/agent/triage/%20`, { method: 'DELETE' })).status, 400);
});
