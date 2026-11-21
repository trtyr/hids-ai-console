import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eventSeconds, parseSyslog } from './syslog-input.js';
import { matchSyslogEvent } from './syslog-case.js';
import { TriageMonitor } from './triage-monitor.js';
import { InvestigationStore } from './investigation-store.js';

const prefix = '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot ';
const fields = 'host_ip="10.0.0.5" event_create_time="2026-11-03 08:00:00" source_ip="192.0.2.2" target_port="80"';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('牧云的三种 syslog 载荷保留同一组字段及未转义的内层引号', () => {
  const structured = parseSyslog(prefix + `[host-info host_ip="10.0.0.5"][honeypot event_create_time="2026-11-03 08:00:00" source_ip="192.0.2.2" target_port="80" process_tree="[{"pid": 1}]" env="["PWD=/tmp"]"]`);
  const keyvalue = parseSyslog(prefix + fields);
  const json = parseSyslog(prefix + JSON.stringify({ host_info: { host_ip: '10.0.0.5' }, honeypot: {
    event_create_time: '2026-11-03 08:00:00', source_ip: '192.0.2.2', target_port: '80' } }));
  for (const parsed of [structured, keyvalue, json]) {
    assert.equal(parsed.payload.host_ip, '10.0.0.5');
    assert.equal(parsed.payload.source_ip, '192.0.2.2');
    assert.equal(parsed.payload.target_port, '80');
  }
  assert.equal(structured.payload.process_tree, '[{"pid": 1}]');
  assert.equal(structured.payload.env, '["PWD=/tmp"]');
});

test('真实牧云键值对载荷保留未加引号的事件身份，并按显式时区解析事件时间', async () => {
  const parsed = parseSyslog('<14>1 2026-11-11T08:55:40Z host cloudwalker 1 cloudwalker-suspicious-command - '
    + 'host_ip="172.16.221.41" host_id=1 event_id=7 business_group_id=1 '
    + 'event_create_time="2026-11-11 16:55:39" process_command_line="bash -c export TICKET=abc"');
  assert.equal(parsed.payload.event_id, '7');
  assert.equal(parsed.payload.host_id, '1');
  assert.equal(parsed.payload.TICKET, undefined);
  assert.equal(eventSeconds(parsed, 480), Math.floor(Date.parse('2026-11-11T08:55:39Z') / 1000));
  const match = await matchSyslogEvent({ callTool: async (name, args) => {
    assert.equal(name, 'get_suspicious_operation_event');
    assert.deepEqual(args, { id: 7 });
    return { id: 7, host_id: 1, host_view: { host_ip: '172.16.221.41' } };
  } }, parsed);
  assert.equal(match.matched, true);
  assert.equal(match.coverage.exact_event_id, true);
});

test('syslog 逐条研判保留材料、三态结果，并区分重复投递与跨秒行为', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-syslog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const contexts = [];
  const investigator = { run: async (id, { mode, streamContext }) => {
    contexts.push(streamContext.context);
    return { alert_id: id, mode, verdict: { verdict: 'uncertain', verdict_label: '存疑',
      summary: '还需核查来源', report: '这条蜜罐告警目前判为存疑，需核查来源和交互内容。', claims: [],
      missing_evidence: ['缺少来源授权记录'], next_actions: ['核对来源'] }, validation: { ok: true }, trace: [] };
  } };
  const options = { service: {}, investigator, history, inputMode: 'syslog', concurrency: 1,
    eventToolbox: { listEvents: async () => ({ total: 1, events: [
      { id: 7, started_at: Math.floor(new Date('2026-11-03T08:00:00Z').getTime() / 1000) }
    ] }) }, wiki: { agentIndex: async () => ({ pages: [{ id: 'HP-10', title: '蜜罐判定' }] }) },
    casesDirectory: path.join(directory, 'cases'), file: path.join(directory, 'state.json') };
  const monitor = new TriageMonitor(options);
  await monitor.start();
  const firstRaw = prefix + fields;
  const first = await monitor.acceptSyslog(firstRaw);
  const duplicate = await monitor.acceptSyslog(firstRaw);
  assert.equal(duplicate.collapsed, true);
  assert.equal(duplicate.repeat_count, 2);
  for (let n = 0; n < 100 && monitor.status(first.alert_id)?.status !== 'done'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.status(first.alert_id).status, 'done', monitor.status(first.alert_id).detail);
  assert.equal((await readFile(path.join(monitor.status(first.alert_id).case_dir, '01-原始告警.txt'), 'utf8')), firstRaw);
  assert.match(await readFile(path.join(monitor.status(first.alert_id).case_dir, '05-研判结果.md'), 'utf8'), /重复投递：2 次/);
  assert.equal((await history.latest('honeypot:7', 'triage')).repeat_count, 2);

  // 跨秒但同指纹、同主机：上一条已完结 → 复用结论只累加 repeat_count（A3），不新排研判。
  const secondRaw = firstRaw.replace('08:00:00" source_ip', '08:00:01" source_ip');
  const second = await monitor.acceptSyslog(secondRaw);
  assert.equal(second.reused, true);
  assert.equal(second.alert_id, first.alert_id);
  assert.equal(second.repeat_count, 3);
  assert.equal(contexts.length, 1, '同一指纹的跨秒告警不再各跑一次完整研判');
  assert.equal((await readdir(path.join(directory, 'cases', 'cloudwalker-honeypot'))).length, 1);

  // 指纹变了（目标端口不同）才是新的一条：同会话时间窗能看见上一条，occurrence 从 1 起。
  const thirdRaw = secondRaw.replace('target_port="80"', 'target_port="443"');
  const third = await monitor.acceptSyslog(thirdRaw);
  assert.notEqual(third.alert_id, first.alert_id);
  for (let n = 0; n < 100 && monitor.status(third.alert_id)?.status !== 'done'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.status(third.alert_id).status, 'done');
  assert.equal(contexts[1].window.length, 1);
  assert.equal(contexts[1].occurrence_count, 1);
  assert.equal((await readdir(path.join(directory, 'cases', 'cloudwalker-honeypot'))).length, 2);
  // 下面读的是磁盘快照，不是内存态：`done` 在 run() 里先改内存（triage-monitor.js:1045），
  // 快照由收尾的合并写异步落盘（triage-monitor.js:1075-1079）。不等这一代落盘就 load()，
  // 并发跑主门时会读到「第三条记录入队之前」的旧快照（total 假红成 1）。writeChain 是文档写明的等落盘同步点
  // （docs/modules/triage-pipeline.md:360，等价 persist()：triage-monitor.js:246）。
  await monitor.writeChain;
  const resumed = new TriageMonitor(options);
  await resumed.load();
  assert.equal(resumed.cases().total, 2);
  assert.equal(resumed.cases({ count: 1, offset: 1 }).cases.length, 1);
  assert.equal('input' in resumed.cases().cases[0], false);
  assert.equal('input' in resumed.status(first.alert_id), false);
});

test('没有可关联事件 ID 时仍逐条归档存疑结论', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-syslog-unmatched-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1,
    history, file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    eventToolbox: { listEvents: async () => ({ total: 0, events: [] }) },
    wiki: { agentIndex: async () => ({ pages: [{ id: 'HP-10', title: '蜜罐判定' }] }) },
    investigator: { runUnmatchedSyslog: async () => ({ mode: 'triage', verdict: {
      verdict: 'uncertain', verdict_label: '存疑', report: '牧云未匹配到该事件，需核查。',
      summary: '缺少事件详情', claims: [], missing_evidence: ['未匹配事件'] },
      validation: { ok: true }, trace: [] }) } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(prefix + fields);
  for (let n = 0; n < 100 && monitor.status(accepted.alert_id)?.status !== 'done'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const status = monitor.status(accepted.alert_id);
  assert.equal(status.status, 'done');
  assert.equal(status.verdict_label, '存疑');
  assert.equal(status.matched_alert_id, undefined);
  assert.equal((await history.latest(accepted.alert_id, 'triage')).verdict.verdict, 'uncertain');
  assert.match(await readFile(path.join(status.case_dir, '05-研判结果.md'), 'utf8'), /牧云事件未匹配/);
});

test('失败的 syslog 案件能保留原始报文并按同一任务重试', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-syslog-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'investigations')),
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    eventToolbox: { listEvents: async () => ({ total: 0, events: [] }) },
    wiki: { agentIndex: async () => ({ pages: [] }) },
    investigator: { runUnmatchedSyslog: async () => {
      if (++attempts === 1) throw new Error('model timeout');
      return { mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑',
        summary: '重试完成', claims: [] }, validation: { ok: true }, trace: [] };
    } } });
  await monitor.start();
  const accepted = await monitor.acceptSyslog(prefix + fields);
  for (let n = 0; n < 100 && monitor.status(accepted.alert_id)?.status !== 'failed'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.status(accepted.alert_id).status, 'failed');
  await monitor.enqueue(accepted.alert_id, { retry: true });
  for (let n = 0; n < 100 && monitor.status(accepted.alert_id)?.status !== 'done'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.status(accepted.alert_id).status, 'done');
  assert.equal(monitor.status(accepted.alert_id).attempts, 2);
  assert.equal(attempts, 2);
  for (let n = 0; n < 100 && monitor.active > 0; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.active, 0);
  await monitor.writeChain;
});
