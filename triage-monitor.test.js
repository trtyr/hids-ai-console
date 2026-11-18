import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
