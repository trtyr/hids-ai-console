// P003-T054 A7：`triage-monitor.js:948-953`（`drain()` 的收尾 catch）的行为用例。
// 现状只有共享闸单测（`evidence/test/P003-T052/record-redaction.test.js` 测 `recordFailure()` 本身），
// 没有「这个 catch 真把原文挡住、且经 `summary().last_error` 出状态接口、日志行仍留原文」的用例。
// 口径：docs/modules/triage-pipeline.md:497-505（记录侧不写错误原文；日志侧不归这道闸）。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../triage-monitor.js';
import { createJournal, useJournal } from '../../../src/shared/logging/log.js';

const MARKER = 'SECRET_BODY_MARKER';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A7 研判收尾抛错：lastError 过闸、状态接口不带原文，日志行仍留原文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t054-drain-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(JSON.parse(line)) }));
  t.after(() => useJournal());

  const monitor = new TriageMonitor({ service: {}, inputMode: 'poll', concurrency: 1,
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    history: { save: async result => result }, investigator: { run: async () => ({}) } });
  // 只换注「研判本身抛错」这一件：`run()` 的 finally 里 `flush()` 正常不 reject，
  // 所以这里让 `run` 直接抛——被测的是 `drain()` 的 catch，不是 run 的失败分支。
  const raw = `${MARKER} 写盘炸了`;
  monitor.run = async () => { throw new Error(raw); };

  await monitor.enqueue('honeypot:7');
  for (let n = 0; n < 100 && !monitor.lastError; n++) await new Promise(resolve => setImmediate(resolve));

  const expected = `研判状态保存失败：本地写入失败，原文 ${raw.length} 字未落盘`;
  assert.equal(monitor.lastError, expected, '收尾 catch 只留固定文案 + 字符量');
  assert.equal(monitor.summary().last_error, expected, '状态接口那份同口径（docs §7.2 summary().last_error）');
  assert.equal(monitor.summary().last_error.includes(MARKER), false);

  // 日志侧不归这道闸：`triage.persist_failed` 仍写原文（P003-T046 的日志口径，P003-T052 明确不动）。
  const logged = lines.filter(line => line.event === 'triage.persist_failed');
  assert.equal(logged.length, 1, `应有一条 triage.persist_failed：${JSON.stringify(lines.map(l => l.event))}`);
  assert.equal(logged[0].error, raw);
  assert.equal(logged[0].level, 'error');

  // 记录本身也归了队（attempts + 重排队列），没有把失败伪装成成功。
  assert.equal(monitor.status('honeypot:7').status, 'running', 'catch 只改 lastError，不改记录状态机');
});
