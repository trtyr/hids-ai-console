// P003-T077 批 3：TriageMonitor 五栏拆分——36+ 个方法逐个落栏、没有归属不明的；
// 门面 public API 与拆前一致（方法名、writeChain getter、队列行为）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';
import { queueColumn } from '../../../src/contexts/triage/application/queue.js';
import { retryColumn } from '../../../src/contexts/triage/application/retry-scheduler.js';
import { projectionColumn } from '../../../src/contexts/triage/application/projection.js';
import { persistenceColumn } from '../../../src/contexts/triage/infrastructure/queue-persistence.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

// 拆栏前的方法清单（P003-T077 报告里的归属表同源；少一个/多一个都对不上）。
const columnOf = [
  ['queue', queueColumn, ['enqueue', 'poll', 'acceptSyslog', '_acceptSyslog', 'contextFor', 'rememberWindow',
    'drain', 'cloudwalkerCall', 'observedToolbox', '_queueFull', '_countDropped']],
  ['retry', retryColumn, ['scheduleRetry', 'clearRetry', 'resumeRetries']],
  ['projection', projectionColumn, ['status', 'cases', 'summary', 'cleanCandidates', 'clean', 'blockedCaseDirs']],
  ['persistence', persistenceColumn, ['load', 'latestInvestigation', 'markDirty', 'persist', 'writeChain',
    'flushedTo', 'flush', 'writeSnapshot', 'flushPendingCounts', 'saveDeliveryCount', 'archiveDone']]
];
// 留在门面（生命周期 + 状态机）的方法；constructor 单独算。
const facade = ['start', '_schedule', 'stop', 'dropRecord', 'cancel', 'attachSyslog', 'setEnabled', 'run'];

test('A3 每个方法恰好落一栏，列内不重名，门面保留生命周期与状态机', () => {
  const seen = new Map();
  for (const [column, object, names] of columnOf) {
    const own = Object.keys(object).sort();
    assert.deepEqual(own, [...names].sort(), `${column} 栏的方法清单与报告归属表不一致`);
    for (const name of names) {
      assert.equal(seen.has(name), false, `${name} 同时落在 ${seen.get(name)} 与 ${column}`);
      seen.set(name, column);
      const descriptor = Object.getOwnPropertyDescriptor(TriageMonitor.prototype, name);
      assert.ok(descriptor && (typeof descriptor.value === 'function' || typeof descriptor.get === 'function'),
        `${name} 没挂到 TriageMonitor 原型上`);
    }
  }
  for (const name of facade) {
    assert.equal(seen.has(name), false, `${name} 该留在门面，却在 ${seen.get(name)} 栏`);
    assert.equal(typeof TriageMonitor.prototype[name], 'function');
  }
  // 全部方法 = 四栏 + 门面；没有归属不明的
  const all = Object.getOwnPropertyNames(TriageMonitor.prototype)
    .filter(name => {
      if (name === 'constructor') return false;
      const descriptor = Object.getOwnPropertyDescriptor(TriageMonitor.prototype, name);
      return typeof descriptor.value === 'function' || typeof descriptor.get === 'function';
    });
  assert.deepEqual(all.sort(), [...seen.keys(), ...facade].sort());
  // writeChain 在拆栏后仍是 getter（Object.assign 会把 getter 求值，必须用 descriptors）
  const descriptor = Object.getOwnPropertyDescriptor(TriageMonitor.prototype, 'writeChain');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.value, undefined);
});

test('A3 拆栏后队列行为不变：入队→投影→取消→落盘，writeChain 等得到', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t077-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(directory, 'triage-monitor.json');
  // concurrency: 0 = 只排队不跑 worker（拆栏前的既有口径），断言只碰队列/投影/持久化三栏。
  const monitor = new TriageMonitor({ service: null, investigator: null, history: null, file,
    concurrency: 0, intervalMs: 60000 });
  await monitor.load();
  assert.deepEqual(await monitor.status('honeypot:1'), null);

  const queued = await monitor.enqueue('honeypot:1');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.stage, '等待研判');
  assert.deepEqual(monitor.cases().cases.map(row => row.alert_id), ['honeypot:1']);
  assert.equal(monitor.summary().counts.queued, 1);
  assert.equal(monitor.summary().queue.depth, 1);

  // 落盘快照里能看到这条记录（持久化栏）
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(snapshot.records[0].alert_id, 'honeypot:1');
  assert.equal(monitor.writeChain instanceof Promise, true, 'writeChain 仍可当同步点用');
  await monitor.writeChain;

  // 取消走状态机 + 状态栏：删记录、dedupe 悬空引用一起失效
  const cancelled = await monitor.cancel('honeypot:1');
  assert.deepEqual(cancelled, { alert_id: 'honeypot:1', status: 'not_queued', cancelled: true });
  assert.equal(await monitor.status('honeypot:1'), null);
  await assert.rejects(() => monitor.cancel('honeypot:1'), /没有这条研判记录/);
});
