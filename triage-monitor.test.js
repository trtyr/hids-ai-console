import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from './triage-monitor.js';
import { eventSeconds } from './syslog-input.js';
import { InvestigationStore } from './investigation-store.js';

test('new alerts enter triage once and the cursor survives restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let rows = [{ id: 'honeypot:1', createdAt: '2026-11-03T08:00:00.000Z' }];
  const service = { alerts: async ({ count, offset }) => ({ alerts: rows.slice(offset, offset + count), partial: false }) };
  const history = new InvestigationStore(path.join(directory, 'results'));
  const calls = [];
  const investigator = { run: async (alertId, { mode, onProgress }) => {
    calls.push({ alertId, mode });
    onProgress('查询证据', '读取原始告警');
    return { alert_id: alertId, mode, verdict: { verdict: 'undetermined', verdict_label: '无法判定', summary: '需要人工复核',
      claims: [{ text: '来源地址已核验', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.1' }] }] },
      validation: { ok: true, errors: [] } };
  } };
  const options = { service, investigator, history, file: path.join(directory, 'queue.json'), concurrency: 1 };
  const monitor = new TriageMonitor(options);
  await monitor.load();
  await monitor.poll();
  assert.equal(monitor.summary().initialized, true);
  assert.deepEqual(calls, []);
  rows = [{ id: 'honeypot:2', createdAt: '2026-11-03T08:00:00.000Z' }, ...rows];
  await monitor.poll();
  for (let n = 0; n < 50 && monitor.status('honeypot:2')?.status !== 'done'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  await monitor.writeChain;
  assert.deepEqual(calls, [{ alertId: 'honeypot:2', mode: 'triage' }]);
  assert.equal(monitor.status('honeypot:2').verdict_label, '无法判定');
  assert.equal(monitor.status('honeypot:2').verified_facts, 1);
  assert.equal(monitor.status('honeypot:2').evidence_sources, 1);
  assert.equal((await history.latest('honeypot:2', 'triage')).verdict.summary, '需要人工复核');
  const resumed = new TriageMonitor(options);
  await resumed.load();
  await resumed.poll();
  assert.equal(resumed.status('honeypot:2').status, 'done');
  assert.equal(calls.length, 1);
});

test('resume after restart skips paused backlog and only investigates later alerts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let rows = [{ id: 'honeypot:1', createdAt: '2026-11-03T08:00:00.000Z' }];
  const calls = [];
  const options = { file: path.join(directory, 'queue.json'), concurrency: 1,
    service: { alerts: async ({ count, offset }) => ({ alerts: rows.slice(offset, offset + count), partial: false }) },
    history: new InvestigationStore(path.join(directory, 'results')),
    investigator: { run: async (id, { mode }) => { calls.push(id); return { alert_id: id, mode,
      verdict: { verdict: 'undetermined', summary: '待复核', claims: [] }, validation: { ok: true } }; } } };
  const monitor = new TriageMonitor(options);
  await monitor.load(); await monitor.poll();
  assert.equal((await monitor.setEnabled(false)).enabled, false);
  rows = [{ id: 'honeypot:2', createdAt: new Date(Date.now() - 1000).toISOString() }, ...rows];
  await monitor.poll();
  assert.equal(monitor.status('honeypot:2'), null);
  await monitor.enqueue('honeypot:manual');
  assert.equal(monitor.status('honeypot:manual').status, 'queued');
  const resumed = new TriageMonitor(options);
  await resumed.load();
  assert.equal(resumed.summary().enabled, false);
  await resumed.setEnabled(true);
  assert.equal(resumed.status('honeypot:2'), null);
  assert.equal(resumed.status('honeypot:manual'), null);
  assert.deepEqual(calls, []);
  rows = [{ id: 'honeypot:3', createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() }, ...rows];
  await resumed.poll();
  for (let n = 0; n < 50 && resumed.status('honeypot:3')?.status !== 'done'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(resumed.status('honeypot:3').status, 'done');
  assert.deepEqual(calls, ['honeypot:3']);
  await assert.rejects(() => resumed.setEnabled('false'), /布尔值/);
});

test('研判完成后 TriageCase 带 evidence 条目，只外露四个字段', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetchedAt = '2026-11-03T08:00:01.000Z';
  const digest = 'a'.repeat(64);
  const options = { file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => ({ alert_id: id, mode,
      verdict: { verdict: 'threat', verdict_label: '真实威胁', summary: '已核验', claims: [] },
      validation: { ok: true },
      evidence: [{ evidence_id: 'cw:1', tool: 'get_honeypot_event', args: { id: 1 }, fetched_at: fetchedAt, sha256: digest }] }) } };
  const monitor = new TriageMonitor(options);
  await monitor.load();
  await monitor.enqueue('honeypot:7');
  for (let n = 0; n < 50 && monitor.status('honeypot:7')?.status !== 'done'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  await monitor.writeChain;
  // 四个字段原样，args 不外露
  assert.deepEqual(monitor.status('honeypot:7').evidence,
    [{ evidence_id: 'cw:1', tool: 'get_honeypot_event', fetched_at: fetchedAt, sha256: digest }]);
  // cases() 只列 syslog 入口的记录（record.input）；补上入口字段，走同一条输出白名单。
  monitor.records.get('honeypot:7').input = { parsed: { msgid: 'cloudwalker-webshell', payload: {}, ts: '2026-11-03T08:00:00Z' } };
  assert.deepEqual(monitor.cases().cases[0].evidence, monitor.status('honeypot:7').evidence);
  const resumed = new TriageMonitor(options);
  await resumed.load();
  assert.deepEqual(resumed.status('honeypot:7').evidence,
    [{ evidence_id: 'cw:1', tool: 'get_honeypot_event', fetched_at: fetchedAt, sha256: digest }]);
});

test('旧队列记录缺 evidence 时从研判记录就地补齐', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-evidence-backfill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(path.join(directory, 'results'));
  await history.save({ alert_id: 'honeypot:9', mode: 'triage', verdict: { verdict: 'uncertain', claims: [] },
    validation: { ok: true },
    evidence: [{ evidence_id: 'syslog:1', tool: 'received_syslog', args: {}, fetched_at: '2026-11-03T08:00:00.000Z',
      sha256: 'b'.repeat(64) }] });
  await writeFile(path.join(directory, 'queue.json'), JSON.stringify({ initialized: true, records: [{
    alert_id: 'honeypot:9', status: 'done', created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z' }] }));
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), history,
    service: { alerts: async () => ({ alerts: [], partial: false }) }, investigator: { run: async () => ({}) } });
  await monitor.load();
  assert.deepEqual(monitor.status('honeypot:9').evidence,
    [{ evidence_id: 'syslog:1', tool: 'received_syslog', fetched_at: '2026-11-03T08:00:00.000Z', sha256: 'b'.repeat(64) }]);
});

test('排队中与研判失败的 TriageCase 也带空的 evidence[]', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-evidence-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { concurrency: 1, history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async () => { throw new Error('模型不可达'); } } };
  const failed = new TriageMonitor({ ...options, file: path.join(directory, 'failed.json') });
  await failed.load();
  await failed.enqueue('honeypot:8');
  for (let n = 0; n < 50 && failed.status('honeypot:8').status !== 'failed'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(failed.status('honeypot:8').status, 'failed');
  assert.deepEqual(failed.status('honeypot:8').evidence, []);
  const paused = new TriageMonitor({ ...options, file: path.join(directory, 'paused.json') });
  await paused.load();
  await paused.setEnabled(false);
  const queued = await paused.enqueue('honeypot:9');
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.evidence, []);
});

// cases() 的筛选 / 排序只看记录上的 input 与结论字段，用最小记录搭矩阵，不跑研判。
function caseRecord(alertId, { msgid, hostIp, eventTime, verdict, repeatCount }) {
  return { alert_id: alertId, status: 'done', verdict, repeat_count: repeatCount,
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z',
    input: { raw: '', parsed: { msgid, ts: '2026-11-03T08:00:00Z', payload: { host_ip: hostIp, event_create_time: eventTime } } } };
}
const caseId = (type, index) => `syslog:${type}:${String(index).padStart(16, '0')}:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e${String(index).padStart(2, '0')}`;
function casesMatrix() {
  const monitor = new TriageMonitor({ file: '/tmp/hids-cases-matrix.json', service: {}, investigator: {}, history: {} });
  const rows = [
    caseRecord(caseId('revshell', 1), { msgid: 'cloudwalker-revshell', hostIp: '10.0.0.5', eventTime: '2026-11-03 10:00:00', verdict: 'threat', repeatCount: 1 }),
    caseRecord(caseId('webshell', 2), { msgid: 'cloudwalker-webshell', hostIp: '10.0.0.6', eventTime: '2026-11-03 11:00:00', verdict: 'uncertain', repeatCount: 3 }),
    caseRecord(caseId('revshell', 3), { msgid: 'cloudwalker-revshell', hostIp: '10.0.0.5', eventTime: '2026-11-03 12:00:00', verdict: 'false_positive', repeatCount: 1 }),
    caseRecord(caseId('revshell', 4), { msgid: 'cloudwalker-revshell', hostIp: '10.0.0.5', eventTime: '2026-11-03 13:00:00', repeatCount: 1 }),
    caseRecord(caseId('honeypot', 5), { msgid: 'cloudwalker-honeypot', hostIp: '10.0.0.7', eventTime: '2026-11-03 14:00:00', verdict: 'threat', repeatCount: 2 })
  ];
  for (const row of rows) monitor.records.set(row.alert_id, row);
  return { monitor, rows };
}

test('cases() 按结论 / 类型 / 主机 / 时间筛，total 是过滤后条数', t => {
  const { monitor, rows } = casesMatrix();
  const [threatOld, , falsePositive, noVerdict, threatNew] = rows;
  // 结论：threat 两条；没有结论的记录按 review 算（与 GET /api/alerts?verdict= 同一口径）
  assert.deepEqual(monitor.cases({ verdicts: ['threat'] }).cases.map(item => item.alert_id), [threatNew.alert_id, threatOld.alert_id]);
  assert.equal(monitor.cases({ verdicts: ['threat'] }).total, 2);
  assert.deepEqual(monitor.cases({ verdicts: ['review'] }).cases.map(item => item.alert_id), [noVerdict.alert_id]);
  assert.equal(monitor.cases({ verdicts: ['threat', 'uncertain'] }).total, 3);
  // 类型：syslog MsgId 映射出的类型（cloudwalker-revshell → revshell）
  assert.equal(monitor.cases({ type: 'revshell' }).total, 3);
  assert.deepEqual(monitor.cases({ type: 'honeypot' }).cases.map(item => item.alert_id), [threatNew.alert_id]);
  assert.equal(monitor.cases({ type: 'memory_security' }).total, 0);
  // 主机：精确匹配 host_ip
  assert.equal(monitor.cases({ host: '10.0.0.5' }).total, 3);
  assert.equal(monitor.cases({ host: '10.0.0.6' }).total, 1);
  assert.equal(monitor.cases({ host: '10.0.0.9' }).total, 0);
  // 时间：含端点，按 eventSeconds（部署端偏移口径）比
  const secondsOf = index => eventSeconds(rows[index].input.parsed, 0);
  assert.deepEqual(monitor.cases({ from: secondsOf(1), to: secondsOf(3) }).cases.map(item => item.alert_id),
    [noVerdict.alert_id, falsePositive.alert_id, rows[1].alert_id]);
  assert.deepEqual(monitor.cases({ from: secondsOf(2), to: secondsOf(2) }).cases.map(item => item.alert_id), [falsePositive.alert_id]);
  assert.equal(monitor.cases({ to: secondsOf(0) }).total, 1);
  // 组合筛
  assert.deepEqual(monitor.cases({ verdicts: ['threat'], type: 'revshell', host: '10.0.0.5' }).cases.map(item => item.alert_id),
    [threatOld.alert_id]);
  // 分页在过滤之后切：total 不随 count/offset 变
  const page = monitor.cases({ count: 2, offset: 1 });
  assert.equal(page.total, 5);
  assert.deepEqual(page.cases.map(item => item.alert_id), [noVerdict.alert_id, falsePositive.alert_id]);
  assert.equal(monitor.cases({ count: 2, offset: 4 }).cases.length, 1);
  assert.equal(monitor.cases({ count: 20, offset: 5 }).cases.length, 0);
  // 默认（不带筛）仍是全部 5 条，时间倒序
  assert.deepEqual(monitor.cases().cases.map(item => item.alert_id), rows.map(row => row.alert_id).reverse());
});

test('cases({ sort: "verdict" }) 把 threat 排前面，同档保持时间倒序，无结论排最后', t => {
  const { monitor, rows } = casesMatrix();
  const [threatOld, uncertain, falsePositive, noVerdict, threatNew] = rows;
  assert.deepEqual(monitor.cases({ sort: 'verdict' }).cases.map(item => item.alert_id),
    [threatNew.alert_id, threatOld.alert_id, uncertain.alert_id, falsePositive.alert_id, noVerdict.alert_id]);
  // 排序与筛选叠加：筛出来的子集内部同样按结论档排
  assert.deepEqual(monitor.cases({ sort: 'verdict', verdicts: ['uncertain', 'threat'] }).cases.map(item => item.alert_id),
    [threatNew.alert_id, threatOld.alert_id, uncertain.alert_id]);
  // 默认排序没被改：还是时间倒序
  assert.deepEqual(monitor.cases({ sort: 'time' }).cases.map(item => item.alert_id), rows.map(row => row.alert_id).reverse());
});

test('列表的重复次数沿用例记录上的 repeat_count，不另造计数', t => {
  const { monitor, rows } = casesMatrix();
  const byId = new Map(monitor.cases().cases.map(item => [item.alert_id, item]));
  assert.equal(byId.get(rows[1].alert_id).repeat_count, 3);
  assert.equal(byId.get(rows[4].alert_id).repeat_count, 2);
  // 只有 repeat_count 一条口径：没有 occurrence_count / delivery_count 之类的第二份计数
  for (const item of byId.values()) {
    assert.equal('occurrence_count' in item, false);
    assert.equal('delivery_count' in item, false);
  }
  // 记录上没有 repeat_count 时落到 1，不是 0
  monitor.records.get(rows[0].alert_id).repeat_count = undefined;
  assert.equal(monitor.cases().cases.find(item => item.alert_id === rows[0].alert_id).repeat_count, 1);
});

// summary() 的三个聚合只看记录本身（状态 / 结论 / MsgId 类型 / 入队时刻），搭最小记录矩阵，不跑研判。
function summaryRecord(alertId, { status = 'done', verdict, createdAt = '2026-11-03T08:00:00.000Z', msgid } = {}) {
  return { alert_id: alertId, status, verdict, created_at: createdAt, updated_at: createdAt,
    ...(msgid ? { input: { raw: '', parsed: { msgid, ts: '2026-11-03T08:00:00Z', payload: {} } } } : {}) };
}

test('summary() 出结论分布、类型分布，since 只算该时刻起进入队列的记录', t => {
  const early = '2026-11-03T08:00:00.000Z';
  const late = '2026-11-04T09:00:00.000Z';
  const monitor = new TriageMonitor({ file: '/tmp/hids-summary-matrix.json', service: {}, investigator: {}, history: {} });
  // 空队列：四个结论键恒在（零值），类型分布为空对象，不给 undefined
  assert.deepEqual(monitor.summary().counts, { queued: 0, running: 0, done: 0, failed: 0 });
  assert.deepEqual(monitor.summary().verdict_counts, { threat: 0, uncertain: 0, false_positive: 0, review: 0 });
  assert.deepEqual(monitor.summary().type_counts, {});
  assert.equal(monitor.summary().since, null);

  const rows = [
    summaryRecord('syslog:revshell:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e41',
      { verdict: 'threat', createdAt: early, msgid: 'cloudwalker-revshell' }),
    summaryRecord('syslog:revshell:bbbbbbbbbbbbbbbb:1763396400:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e42',
      { verdict: 'threat', createdAt: late, msgid: 'cloudwalker-revshell' }),
    summaryRecord('syslog:webshell:cccccccccccccccc:1763400000:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43',
      { status: 'queued', createdAt: late, msgid: 'cloudwalker-webshell' }),
    summaryRecord('syslog:honeypot:dddddddddddddddd:1763403600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e44',
      { status: 'failed', createdAt: late, msgid: 'cloudwalker-honeypot' }),
    // 轮询入口入队的记录没有 input，也就没有事件类型：落 unknown，仍然计进结论分布
    summaryRecord('honeypot:5', { verdict: 'false_positive', createdAt: late }),
    summaryRecord('syslog:honeypot:eeeeeeeeeeeeeeee:1763398000:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e45',
      { verdict: 'uncertain', createdAt: early, msgid: 'cloudwalker-honeypot' })
  ];
  for (const row of rows) monitor.records.set(row.alert_id, row);

  const all = monitor.summary();
  assert.deepEqual(all.counts, { queued: 1, running: 0, done: 4, failed: 1 });
  assert.deepEqual(all.verdict_counts, { threat: 2, uncertain: 1, false_positive: 1, review: 2 });
  assert.deepEqual(all.type_counts, { revshell: 2, webshell: 1, honeypot: 2, unknown: 1 });
  assert.equal(all.since, null);

  // since 只算 created_at 不早于该时刻的记录，三个聚合共用同一份记录集
  const later = monitor.summary({ since: '2026-11-04T00:00:00.000Z' });
  assert.equal(later.since, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(later.counts, { queued: 1, running: 0, done: 2, failed: 1 });
  assert.deepEqual(later.verdict_counts, { threat: 1, uncertain: 0, false_positive: 1, review: 2 });
  assert.deepEqual(later.type_counts, { revshell: 1, webshell: 1, honeypot: 1, unknown: 1 });

  // 含端点：正好落在 since 上的记录也计入（4 条 late，其中 done 2 条）
  const atLate = monitor.summary({ since: late });
  assert.deepEqual(atLate.counts, { queued: 1, running: 0, done: 2, failed: 1 });
  assert.equal(atLate.verdict_counts.threat, 1);

  // 一个时刻都没到：全零，不因为「没有记录」把键省掉
  const future = monitor.summary({ since: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(future.counts, { queued: 0, running: 0, done: 0, failed: 0 });
  assert.deepEqual(future.verdict_counts, { threat: 0, uncertain: 0, false_positive: 0, review: 0 });
  assert.deepEqual(future.type_counts, {});

  // 解析不出来的 since 不静默当成「全量」以外的窗口：退回不带筛，并把 since 回成 null
  const bogus = monitor.summary({ since: 'not-a-time' });
  assert.equal(bogus.since, null);
  assert.deepEqual(bogus.counts, all.counts);

  // 没有 created_at 的旧记录：不带 since 照常计，带 since 时算不进去（没有时刻可比）
  monitor.records.set('honeypot:6', summaryRecord('honeypot:6', { verdict: 'threat' }));
  monitor.records.get('honeypot:6').created_at = undefined;
  assert.equal(monitor.summary().verdict_counts.threat, 3);
  assert.equal(monitor.summary({ since: early }).verdict_counts.threat, 2);
});

test('syslog 模式的 summary 给出最后一条到达时刻，重启后不丢，失败投递不算', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-received-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T08:00:00.000Z') });
  const options = { service: {}, inputMode: 'syslog', concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')), file: path.join(directory, 'queue.json'),
    casesDirectory: path.join(directory, 'cases'),
    investigator: { run: async (id, { mode }) => ({ alert_id: id, mode,
      verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '还需核查来源', claims: [] }, validation: { ok: true } }) } };
  const monitor = new TriageMonitor(options);
  await monitor.start();

  // 一条都没收到：last_received_at 为 null；syslog 模式没有轮询，last_poll_at 仍是 null——两个键互不替代
  assert.equal(monitor.summary().last_received_at, null);
  assert.equal(monitor.summary().last_poll_at, null);
  assert.deepEqual(await monitor.attachSyslog({ start: async () => ({ address: '127.0.0.1', port: 15514 }) }),
    { listening: true, bind: 'udp://127.0.0.1:15514', error: null });
  // 绑定成功不等于收到过消息
  assert.equal(monitor.summary().last_received_at, null);

  const line = '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot '
    + 'host_ip="10.0.0.5" event_create_time="2026-11-03 08:00:00" source_ip="192.0.2.2" target_port="80"';
  const first = await monitor.acceptSyslog(line);
  assert.equal(monitor.summary().last_received_at, '2026-11-03T08:00:00.000Z');

  // 同秒重复投递也是一条到达：时间跟上，和记录上的 updated_at 同一个时刻
  t.mock.timers.tick(7000);
  const duplicate = await monitor.acceptSyslog(line);
  assert.equal(duplicate.collapsed, true);
  assert.equal(monitor.summary().last_received_at, '2026-11-03T08:00:07.000Z');
  assert.equal(monitor.records.get(first.alert_id).updated_at, '2026-11-03T08:00:07.000Z');

  // 解析失败 / 未知 MsgId 都不算「收到」：时钟先往前走，报错或跳过后最后到达时刻仍是原值
  t.mock.timers.tick(5000);
  const broken = await monitor.acceptSyslog('这不是一条 syslog 行');
  assert.match(broken.error, /syslog 解析失败/);
  assert.equal(monitor.summary().last_received_at, '2026-11-03T08:00:07.000Z');
  t.mock.timers.tick(5000);
  assert.deepEqual(await monitor.acceptSyslog('<134>1 2026-11-03T08:00:20Z host app 1 cloudwalker-unknown-msgid host_ip="10.0.0.5"'),
    { skipped: 'no_agent_for_msgid', msgid: 'cloudwalker-unknown-msgid' });
  assert.equal(monitor.summary().last_received_at, '2026-11-03T08:00:07.000Z');
  await monitor.setEnabled(false);
  t.mock.timers.tick(5000);
  assert.deepEqual(await monitor.acceptSyslog(line), { skipped: 'paused' });
  assert.equal(monitor.summary().last_received_at, '2026-11-03T08:00:07.000Z');

  // 持久化：重启后仍是同一个最后到达时刻，而不是退回 null
  await monitor.writeChain;
  const resumed = new TriageMonitor(options);
  await resumed.load();
  assert.equal(resumed.summary().last_received_at, '2026-11-03T08:00:07.000Z');

  // poll 模式没有这个键（轮询用 last_poll_at），两个入口不混着给
  const polling = new TriageMonitor({ service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async () => ({}) }, history: new InvestigationStore(path.join(directory, 'poll-results')),
    file: path.join(directory, 'poll.json') });
  await polling.load();
  assert.equal('last_received_at' in polling.summary(), false);
  assert.equal('interval_ms' in polling.summary(), true);
});

test('type_counts 不因 MsgId 撞上对象原型键名而冒出垃圾键', t => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-summary-proto.json', service: {}, investigator: {}, history: {} });
  // eventTypeFor 用普通对象查表：这三个 MsgId 会取到原型上的函数 / 对象，真值但不能当类型用。
  const msgids = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'cloudwalker-honeypot'];
  for (const msgid of msgids) {
    const alertId = `syslog:x:${String(msgid).padStart(16, '0')}:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e46`;
    monitor.records.set(alertId, { alert_id: alertId, status: 'done', verdict: 'threat',
      created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z',
      input: { raw: '', parsed: { msgid, ts: '2026-11-03T08:00:00Z', payload: {} } } });
  }
  // 只有映射表里的类型出键；原型键名的记录全落 unknown，计数不丢
  assert.deepEqual(monitor.summary().type_counts, { honeypot: 1, unknown: 4 });
  assert.equal(monitor.summary().verdict_counts.threat, 5);
  // 键名只能是映射表里的类型或 unknown：没有 function/object 字样漏进键里
  for (const key of Object.keys(monitor.summary().type_counts)) assert.match(key, /^[a-z_]+$/);
});

// 误报入口（server.js:618-624，本卡不改它）写的就是这五项。单测照它的写法登记，再走重跑。
const markFalsePositive = (record, reason = '运维的蜜罐探针，不是攻击', who = '值班分析员') => Object.assign(record,
  { verdict: 'false_positive', verdict_label: '误报', decision_source: 'human',
    detail: `人工登记误报（${who}）：${reason}`,
    feedback: { reason, who, recorded_at: '2026-11-19T01:00:00.000Z' } });

const triageVerdict = (verdict, verdictLabel, summary, evidenceId) => ({
  verdict: { verdict, verdict_label: verdictLabel, summary, report: `${summary}的报告`,
    missing_evidence: [`缺${summary}`], next_actions: [`办${summary}`] },
  evidence: [{ evidence_id: evidenceId, tool: 'get_honeypot_event', args: {}, fetched_at: '2026-11-19T01:00:01.000Z',
    sha256: 'c'.repeat(64) }],
  validation: { ok: true } });

const waitDone = async (monitor, alertId) => {
  for (let n = 0; n < 100 && monitor.status(alertId)?.status !== 'done'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  await monitor.writeChain;
  return monitor.status(alertId);
};

test('A1 已标误报的记录重跑不覆盖结论三件，报告与证据照常刷新', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-false-positive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(path.join(directory, 'results'));
  // 第一次判存疑，重跑判真实威胁：结论区必须留着，其余字段必须换掉
  const results = [triageVerdict('uncertain', '存疑', '首判存疑', 'cw:1'),
    triageVerdict('threat', '真实威胁', '重跑认为是真实威胁', 'cw:2')];
  const runs = [];
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), concurrency: 1, history,
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => { runs.push(id); return { alert_id: id, mode, ...results[runs.length - 1] }; } } });
  await monitor.load();
  await monitor.enqueue('honeypot:11');
  const first = await waitDone(monitor, 'honeypot:11');
  assert.equal(first.verdict, 'uncertain');
  // 走误报入口：结论改误报，summary 不动（入口只写 verdict / verdict_label / decision_source / detail / feedback）
  markFalsePositive(monitor.records.get('honeypot:11'));
  assert.equal(monitor.status('honeypot:11').summary, '首判存疑');

  await monitor.enqueue('honeypot:11', { retry: true });
  const requeued = monitor.records.get('honeypot:11');
  // 重排没把误报标记抹掉（抹掉的话 run() 收尾根本认不出这条已标误报）
  assert.equal(requeued.verdict, 'false_positive');
  assert.equal(requeued.feedback.reason, '运维的蜜罐探针，不是攻击');

  const after = await waitDone(monitor, 'honeypot:11');
  assert.equal(after.attempts, 2);
  // 结论区原样：三件 + 来源 + 登记理由
  assert.equal(after.verdict, 'false_positive');
  assert.equal(after.verdict_label, '误报');
  assert.equal(after.summary, '首判存疑');
  assert.equal(after.decision_source, 'human');
  assert.deepEqual(after.feedback, { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员',
    recorded_at: '2026-11-19T01:00:00.000Z' });
  assert.equal(after.detail, '首判存疑');
  // 不是整块跳过：这次研判的报告、缺证、下一步、证据、存盘时刻都换成了新的
  assert.equal(after.report, '重跑认为是真实威胁的报告');
  assert.deepEqual(after.missing_evidence, ['缺重跑认为是真实威胁']);
  assert.deepEqual(after.next_actions, ['办重跑认为是真实威胁']);
  assert.equal(after.evidence.length, 1);
  assert.equal(after.evidence[0].evidence_id, 'cw:2');
  assert.equal(after.saved_at, (await history.latest('honeypot:11', 'triage')).saved_at);
  assert.equal(runs.length, 2);
});

test('A1 记录上已是 false_positive 时直接跑 run() 也不覆盖结论', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-false-positive-direct-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => ({ alert_id: id, mode, ...triageVerdict('threat', '真实威胁', 'AI 说是威胁', 'cw:3') }) } });
  await monitor.load();
  const record = { alert_id: 'honeypot:12', status: 'done', stage: '研判完成', created_at: '2026-11-19T00:00:00.000Z',
    updated_at: '2026-11-19T00:00:00.000Z', steps: [], attempts: 1, summary: '人工确认过是探针' };
  markFalsePositive(record);
  monitor.records.set(record.alert_id, record);
  await monitor.run(record);
  const after = monitor.status('honeypot:12');
  assert.equal(after.verdict, 'false_positive');
  assert.equal(after.verdict_label, '误报');
  assert.equal(after.summary, '人工确认过是探针');
  assert.equal(after.decision_source, 'human');
  assert.equal(after.report, 'AI 说是威胁的报告');
});

test('A1 钉子：AI 自己判出的误报不算人工登记，重跑仍按这次研判覆盖', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-false-positive-ai-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const results = [triageVerdict('false_positive', '误报', 'AI 首判误报', 'cw:4'),
    triageVerdict('threat', '真实威胁', 'AI 重跑改判威胁', 'cw:5')];
  const runs = [];
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => { runs.push(id); return { alert_id: id, mode, ...results[runs.length - 1] }; } } });
  await monitor.load();
  await monitor.enqueue('honeypot:13');
  const first = await waitDone(monitor, 'honeypot:13');
  assert.equal(first.verdict, 'false_positive');
  assert.equal(first.decision_source, 'ai');

  await monitor.enqueue('honeypot:13', { retry: true });
  const after = await waitDone(monitor, 'honeypot:13');
  assert.equal(runs.length, 2);
  assert.equal(after.verdict, 'threat');
  assert.equal(after.verdict_label, '真实威胁');
  assert.equal(after.summary, 'AI 重跑改判威胁');
  assert.equal(after.decision_source, 'ai');
});

test('A2 没标误报的记录重跑仍按现在的方式写回', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-retry-plain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const results = [triageVerdict('uncertain', '存疑', '首判存疑', 'cw:6'),
    triageVerdict('threat', '真实威胁', '重跑认定为威胁', 'cw:7')];
  const runs = [];
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => { runs.push(id); return { alert_id: id, mode, ...results[runs.length - 1] }; } } });
  await monitor.load();
  await monitor.enqueue('honeypot:14');
  assert.equal((await waitDone(monitor, 'honeypot:14')).verdict, 'uncertain');

  await monitor.enqueue('honeypot:14', { retry: true });
  // 没标误报的照旧在重排时把上一次的结论清掉
  assert.equal(monitor.records.get('honeypot:14').verdict, undefined);
  const after = await waitDone(monitor, 'honeypot:14');
  assert.equal(after.attempts, 2);
  assert.equal(after.verdict, 'threat');
  assert.equal(after.verdict_label, '真实威胁');
  assert.equal(after.summary, '重跑认定为威胁');
  assert.equal(after.decision_source, 'ai');
  assert.equal(after.detail, '重跑认定为威胁');
  assert.equal(after.report, '重跑认定为威胁的报告');
  assert.equal(after.evidence[0].evidence_id, 'cw:7');
});

// ---- P003-T037：增量轮询 / 去重复用 / 优先级 / 队列上限 / 详情一次一拉 ----

const syslogLine = ({ msgid = 'cloudwalker-honeypot', seconds = '2026-11-03T08:00:00Z', eventTime = '2026-11-03 08:00:00',
  eventId = null, hostId = null, sourceIp = '192.0.2.5' } = {}) => `<134>1 ${seconds} host app 1 ${msgid} host_ip="10.0.0.5"`
  + ` event_create_time="${eventTime}" source_ip="${sourceIp}" target_ip="10.0.0.5" target_port="80"`
  + `${eventId == null ? '' : ` event_id="${eventId}"`}${hostId == null ? '' : ` host_id="${hostId}"`}`;

const awaitRecord = async (monitor, predicate, limit = 200) => {
  for (let n = 0; n < limit && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  await monitor.writeChain;
};

test('A1 轮询按 from 增量取数：游标由 from 决定，排序键固定，一页取完不翻页', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-incremental-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queries = [];
  let rows = [{ id: 'honeypot:1', createdAt: '2026-11-03T08:00:00.000Z' },
    { id: 'honeypot:2', createdAt: '2026-11-03T08:00:05.000Z' }];
  // 替身按接口契约排序（created_at desc, id asc），别把输入顺序当约定。
  const service = { alerts: async query => { queries.push({ ...query });
    const page = rows.filter(row => !query.from || row.createdAt >= query.from)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { alerts: page, partial: false }; } };
  const monitor = new TriageMonitor({ service, file: path.join(directory, 'queue.json'), concurrency: 1, intervalMs: 1000,
    history: new InvestigationStore(path.join(directory, 'results')),
    investigator: { run: async (id, { mode }) => ({ alert_id: id, mode,
      verdict: { verdict: 'uncertain', summary: '待复核', claims: [] }, validation: { ok: true } }) } });
  await monitor.load();

  // 冷启动只定游标，不排告警；查询不带 from。
  await monitor.poll();
  assert.deepEqual(queries, [{ count: 50, offset: 0, sort: 'time' }]);
  assert.equal(monitor.watermark, '2026-11-03T08:00:05.000Z');
  assert.equal(monitor.summary().counts.queued, 0);

  // 增量轮：from 就是上一轮游标，第二次是新增，单页取完不再翻页。
  rows = [...rows, { id: 'honeypot:3', createdAt: '2026-11-03T08:00:10.000Z' }];
  const incremental = await monitor.poll();
  assert.deepEqual(queries[1], { count: 50, offset: 0, sort: 'time', from: '2026-11-03T08:00:05.000Z' });
  assert.equal(queries.length, 2, '一页就取完了，没有翻页找边界');
  assert.equal(incremental.found, 1);
  assert.equal(monitor.watermark, '2026-11-03T08:00:10.000Z');
  await awaitRecord(monitor, () => monitor.status('honeypot:3')?.status === 'done');
  assert.equal(monitor.status('honeypot:3').status, 'done');

  // 下一轮从新游标取：同秒内已处理过的 id 不会再排一遍。
  await monitor.poll();
  assert.equal(queries[2].from, '2026-11-03T08:00:10.000Z');
  assert.equal(monitor.summary().counts.done, 1);
});

test('A1 连续空轮指数退避，见到新告警立刻回常态', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-backoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let rows = [{ id: 'honeypot:1', createdAt: new Date(Date.now() - 60_000).toISOString() }];
  const service = { alerts: async () => ({ alerts: rows, partial: false }) };
  const monitor = new TriageMonitor({ service, file: path.join(directory, 'queue.json'), concurrency: 1,
    intervalMs: 1_000, maxBackoffMs: 8_000,
    history: new InvestigationStore(path.join(directory, 'results')),
    investigator: { run: async (id, { mode }) => ({ alert_id: id, mode,
      verdict: { verdict: 'uncertain', summary: '待复核', claims: [] }, validation: { ok: true } }) } });
  await monitor.load();
  await monitor.poll(); // 冷启动：空轮
  assert.deepEqual([monitor.backoffMs, monitor.summary().empty_polls, monitor.summary().backoff_ms], [2_000, 1, 2_000]);
  await monitor.poll();
  assert.equal(monitor.backoffMs, 4_000);
  await monitor.poll();
  assert.equal(monitor.backoffMs, 8_000);
  await monitor.poll();
  assert.equal(monitor.backoffMs, 8_000, '退避到上界就不再涨');

  // 新告警：立刻回常态（= 配置的 intervalMs），空轮计数清零。
  rows = [{ id: 'honeypot:2', createdAt: new Date(Date.now() + 60_000).toISOString() }, ...rows];
  const fresh = await monitor.poll();
  assert.equal(fresh.found, 1);
  assert.equal(monitor.backoffMs, 1_000);
  assert.equal(monitor.summary().empty_polls, 0);
  await awaitRecord(monitor, () => monitor.status('honeypot:2')?.status === 'done');
});

test('A3 同指纹同主机且上一条已完结：复用结论只累加 repeat_count，不再跑完整研判', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = [];
  const history = new InvestigationStore(path.join(directory, 'results'));
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1, history,
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    eventToolbox: { listEvents: async () => ({ total: 0, events: [] }) },
    investigator: { runUnmatchedSyslog: async () => { runs.push('run'); return { mode: 'triage', verdict: {
      verdict: 'uncertain', verdict_label: '存疑', summary: '缺少事件详情', report: '未匹配到事件，需核查。', claims: [] },
      validation: { ok: true } }; } } });
  await monitor.start();

  const first = await monitor.acceptSyslog(syslogLine({ eventTime: '2026-11-03 08:00:00' }));
  await awaitRecord(monitor, () => monitor.status(first.alert_id)?.status === 'done');
  assert.equal(runs.length, 1);
  const caseDir = monitor.status(first.alert_id).case_dir;

  // 同指纹（同主机、同来源、同端口）、不同秒：上一条已完结 → 只累加 repeat_count。
  const second = await monitor.acceptSyslog(syslogLine({ seconds: '2026-11-03T08:00:10Z', eventTime: '2026-11-03 08:00:10' }));
  assert.equal(second.reused, true);
  assert.equal(second.alert_id, first.alert_id);
  assert.equal(second.repeat_count, 2);
  assert.equal(runs.length, 1, '没有第二次完整研判');
  assert.equal((await history.latest(first.alert_id, 'triage')).repeat_count, 2, '研判记录同步 repeat_count');
  assert.match(await readFile(path.join(caseDir, '05-研判结果.md'), 'utf8'), /重复投递：2 次/);
  assert.equal(JSON.parse(await readFile(path.join(caseDir, 'result.json'), 'utf8')).repeat_count, 2);

  // 再来一条：计数继续涨，研判次数不变。
  const third = await monitor.acceptSyslog(syslogLine({ seconds: '2026-11-03T08:00:20Z', eventTime: '2026-11-03 08:00:20' }));
  assert.equal(third.repeat_count, 3);
  assert.equal(runs.length, 1);

  // 指纹不同（换来源 IP）：照常新排一条完整研判。
  const other = await monitor.acceptSyslog(`<134>1 2026-11-03T08:00:30Z host app 1 cloudwalker-honeypot host_ip="10.0.0.5"`
    + ' event_create_time="2026-11-03 08:00:30" source_ip="198.51.100.9" target_ip="10.0.0.5" target_port="443"');
  assert.equal(other.reused, undefined);
  await awaitRecord(monitor, () => monitor.status(other.alert_id)?.status === 'done');
  assert.equal(runs.length, 2);
});

test('A3 上一条未完结（排队/失败）不复用结论', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-reuse-pending-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    eventToolbox: { listEvents: async () => ({ total: 0, events: [] }) },
    investigator: { runUnmatchedSyslog: async () => {
      if (++attempts === 1) throw new Error('model timeout');
      return { mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '重试完成', claims: [] },
        validation: { ok: true } };
    } } });
  await monitor.start();
  const first = await monitor.acceptSyslog(syslogLine({ eventTime: '2026-11-03 08:00:00' }));
  await awaitRecord(monitor, () => monitor.status(first.alert_id)?.status === 'failed');
  // 上一条失败：不沿用结论，新排一条（investigator 第二次成功）。
  const second = await monitor.acceptSyslog(syslogLine({ seconds: '2026-11-03T08:00:10Z', eventTime: '2026-11-03 08:00:10' }));
  assert.equal(second.reused, undefined);
  assert.notEqual(second.alert_id, first.alert_id);
  await awaitRecord(monitor, () => monitor.status(second.alert_id)?.status === 'done');
  assert.equal(attempts, 2);
});

test('A4 drain 按（类型风险，occurrence_count，created_at）取最高优先级', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-priority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = [];
  const monitor = new TriageMonitor({ service: { alerts: async () => ({ alerts: [], partial: false }) },
    file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    investigator: { run: async id => { runs.push(id); return { alert_id: id,
      verdict: { verdict: 'uncertain', summary: '待复核', claims: [] }, validation: { ok: true } }; } } });
  await monitor.load();
  const queue = (alertId, occurrenceCount, createdAt) => monitor.records.set(alertId,
    { alert_id: alertId, occurrence_count: occurrenceCount, created_at: createdAt, updated_at: createdAt,
      status: 'queued', stage: '等待研判', steps: [], attempts: 0 });
  queue('network_audit:1', 5, '2026-11-03T08:00:00.000Z');
  queue('webshell:1', 1, '2026-11-03T08:00:05.000Z');
  queue('honeypot:1', 9, '2026-11-03T08:00:01.000Z');
  queue('webshell:2', 3, '2026-11-03T08:00:09.000Z');
  queue('webshell:3', 3, '2026-11-03T08:00:02.000Z');
  monitor.drain();
  await awaitRecord(monitor, () => runs.length === 5);
  // webshell（风险 10）先于蜜罐（8）先于网络审计（4）；同风险同次数按 created_at 早的先行。
  assert.deepEqual(runs, ['webshell:3', 'webshell:2', 'webshell:1', 'honeypot:1', 'network_audit:1']);
});

test('A5 并发与队列上限可由配置查，队列到上限拒收并计丢弃数', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-queue-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = { concurrency: process.env.HIDS_TRIAGE_CONCURRENCY, queue: process.env.HIDS_TRIAGE_QUEUE_MAX };
  t.after(() => {
    if (saved.concurrency === undefined) delete process.env.HIDS_TRIAGE_CONCURRENCY;
    else process.env.HIDS_TRIAGE_CONCURRENCY = saved.concurrency;
    if (saved.queue === undefined) delete process.env.HIDS_TRIAGE_QUEUE_MAX;
    else process.env.HIDS_TRIAGE_QUEUE_MAX = saved.queue;
  });
  process.env.HIDS_TRIAGE_CONCURRENCY = '3';
  process.env.HIDS_TRIAGE_QUEUE_MAX = '5';
  const byEnv = new TriageMonitor({ file: path.join(directory, 'env.json'), service: {}, investigator: {}, history: {} });
  assert.equal(byEnv.concurrency, 3);
  assert.equal(byEnv.queueLimit, 5);
  assert.deepEqual([byEnv.summary().concurrency, byEnv.summary().queue_limit, byEnv.summary().dropped], [3, 5, 0]);

  // 非法值回落默认，不把队列卡死（0 / 负数 / 非数）。
  for (const bad of ['0', '-1', '半', '']) {
    process.env.HIDS_TRIAGE_CONCURRENCY = bad;
    process.env.HIDS_TRIAGE_QUEUE_MAX = bad;
    const fallback = new TriageMonitor({ file: path.join(directory, 'bad.json'), service: {}, investigator: {}, history: {} });
    assert.deepEqual([fallback.concurrency, fallback.queueLimit], [2, 1000], `非法配置 ${JSON.stringify(bad)}`);
  }

  // 上限命中：concurrency=1 且研判不结束 → 队列深度 1 = 上限，再入队 429 并计数。
  const never = new Promise(() => {});
  const monitor = new TriageMonitor({ service: {}, file: path.join(directory, 'queue.json'), concurrency: 1, queueLimit: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    investigator: { run: () => never } });
  await monitor.load();
  await monitor.enqueue('honeypot:1');
  await assert.rejects(() => monitor.enqueue('honeypot:2'), error => error.status === 429);
  assert.equal(monitor.summary().dropped, 1);
  assert.equal(monitor.status('honeypot:2'), null, '被丢掉的告警不进队列');
});

test('A2 一次研判内同一条事件详情只拉一次：syslog 匹配与规则评估共用缓存，agent 拿 match.event', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-detail-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const detail = { id: 7, host_id: 12, host_view: { host_ip: '10.0.0.5' }, level: 3, state: 1 };
  const calls = [];
  const eventToolbox = { callTool: async (name, args) => { calls.push([name, args.id]); return detail; },
    listEvents: async () => ({ total: 0, events: [] }) };
  let ruleSawDetail = null;
  const ruleEngine = { evaluate: async ({ toolbox, match }) => {
    ruleSawDetail = await toolbox.callTool('get_honeypot_event', { id: match.event_id });
    return { status: 'observed', revision: 'r', rule: { id: 'rule-1' }, facts: [] };
  } };
  let streamContext = null;
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1, eventToolbox,
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    history: new InvestigationStore(path.join(directory, 'results')), ruleEngine,
    wiki: { agentIndex: async () => ({ pages: [] }) },
    investigator: { run: async (id, { mode, streamContext: context }) => { streamContext = context;
      return { alert_id: id, mode, verdict: { verdict: 'uncertain', summary: '待复核', claims: [] }, validation: { ok: true } }; } } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(syslogLine({ eventId: 7, hostId: 12, eventTime: '2026-11-03 08:00:00' }));
  await awaitRecord(monitor, () => monitor.status(accepted.alert_id)?.status === 'done');

  // syslog 匹配拉一次，规则评估走同一份缓存，agent 用 match.event——全链只一次。
  assert.deepEqual(calls, [['get_honeypot_event', 7]]);
  assert.equal(ruleSawDetail, detail, '规则评估读的是缓存里的同一份详情');
  assert.equal(streamContext.match.event, detail, 'agent 拿到 match.event 复用');
  assert.equal(monitor.status(accepted.alert_id).status, 'done');

  // 缓存不跨告警：第二条告警照常自己拉一次。
  const second = await monitor.acceptSyslog(syslogLine({ eventId: 8, hostId: 12, seconds: '2026-11-03T08:00:30Z',
    eventTime: '2026-11-03 08:00:30', sourceIp: '198.51.100.7' }));
  await awaitRecord(monitor, () => monitor.status(second.alert_id)?.status === 'done' || monitor.status(second.alert_id)?.status === 'failed');
  assert.deepEqual(calls.map(call => call[1]), [7, 8]);
});
