import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from './triage-monitor.js';
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
