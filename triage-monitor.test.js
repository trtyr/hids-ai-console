import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
