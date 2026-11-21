// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal, createFileSink, flushLogs, log, logFileOptions, logFiles, readLogEntries, useJournal,
  runWithRequestContext, currentRequestContext } from './src/shared/logging/log.js';
import { dataRoot } from './src/shared/data-root.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const AT = '2026-11-21T00:00:00.000Z';
const memoryJournal = (t, lines = []) => {
  useJournal(createJournal({ write: line => lines.push(line), now: () => AT }));
  t.after(() => useJournal());
  return lines;
};

test('request_id 贯穿：同一请求上下文里的所有日志共享 request_id 与 user，上下文外不带', t => {
  const lines = memoryJournal(t);
  runWithRequestContext({ request_id: 'req-abc-1', user: 'ops' }, () => {
    log('demo.in_context', { n: 1 });
    log('demo.in_context', { n: 2 });
  });
  log('demo.outside', { n: 3 });
  const rows = lines.map(line => JSON.parse(line));
  assert.deepEqual(rows[0], { time: AT, level: 'info', event: 'demo.in_context', request_id: 'req-abc-1', user: 'ops', n: 1 });
  assert.equal(rows[1].request_id, 'req-abc-1', '同请求两行共用同一个 request_id');
  assert.equal('request_id' in rows[2], false, '上下文外不虚构 request_id');
  assert.equal('user' in rows[2], false);
});

test('request_id 反查整条请求链：readLogEntries({request_id, user}) 只回这条请求的行', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-log72-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 'hids.log');
  const sink = createFileSink({ file, now: () => Date.parse(AT) });
  useJournal(createJournal({ write: sink, now: () => AT }));
  t.after(() => useJournal());
  runWithRequestContext({ request_id: 'req-1', user: 'ops' }, () => {
    log('http.request', { method: 'POST', path: '/api/config', status: 200 });
    log('config.updated', { keys: ['LLM_MODEL'] });
  });
  runWithRequestContext({ request_id: 'req-2', user: null }, () => {
    log('http.request', { method: 'GET', path: '/api/logs', status: 200 });
  });
  await flushLogs();
  const chain = readLogEntries({ file, requestId: 'req-1' });
  assert.deepEqual(chain.logs.map(entry => entry.event), ['config.updated', 'http.request']);
  assert.equal(chain.logs[0].user, 'ops');
  const byUser = readLogEntries({ file, user: 'ops' });
  assert.equal(byUser.total, 2);
  // 从一条 error 反查整条链的实操路径：q 搜事件 + request_id 过滤组合
  const combined = readLogEntries({ file, q: 'config.updated', requestId: 'req-1' });
  assert.deepEqual(combined.logs.map(entry => entry.event), ['config.updated']);
});

test('q 全文搜索：对原始行做不区分大小写子串匹配；窗口外标 truncated', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-log72-q-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 'hids.log');
  const sink = createFileSink({ file, now: () => Date.parse(AT) });
  useJournal(createJournal({ write: sink, now: () => AT }));
  t.after(() => useJournal());
  log('upstream.failed', { op: 'alerts', detail: 'TokenExpired 标记词在这里' });
  log('upstream.failed', { op: 'status', detail: 'nothing special' });
  log('triage.done', { alert_id: 'honeypot:1' });
  await flushLogs();
  const hit = readLogEntries({ file, q: 'tokenexpired' });
  assert.equal(hit.total, 1, '不区分大小写');
  assert.equal(hit.logs[0].op, 'alerts');
  assert.equal(readLogEntries({ file, q: 'honeypot:1' }).total, 1);
  assert.equal(readLogEntries({ file, q: '不存在的词' }).total, 0);
  // limit 小于命中数 → truncated（命中口径）；窗口口径由 WINDOW 上限保证（本例行数远小于窗口）
  const capped = readLogEntries({ file, q: 'upstream', limit: 1 });
  assert.equal(capped.truncated, true);
});

test('总量上限：历史文件总字节超 totalMaxBytes 从最老的删起；当前文件与最新历史保留', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-log72-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 'hids.log');
  let clock = Date.parse(AT);
  const sink = createFileSink({ file, maxBytes: 200, keep: 50, totalMaxBytes: 640, now: () => clock });
  useJournal(createJournal({ write: sink, now: () => new Date(clock).toISOString() }));
  t.after(() => useJournal());
  for (let n = 0; n < 12; n += 1) { log('step', { n, pad: 'y'.repeat(120) }); clock += 1000; }
  await flushLogs();
  const names = (await readdir(dir)).sort();
  assert.ok(names.length >= 2, '先得真的轮转过');
  const history = logFiles({ file }).filter(item => item.file !== file);
  const totalBytes = history.reduce((sum, item) => sum + item.bytes, 0);
  assert.ok(totalBytes <= 640 + 400, `历史总量应压到上限附近（实测 ${totalBytes}B，文件 ${names.join(',')}）`);
  assert.equal(history.length <= 4, true, `历史份数应受总量上限约束（实测 ${history.length} 份）`);
  assert.ok((await readFile(file, 'utf8')).length > 0, '当前活动文件永远不在候选里');
});

test('写失败降级：目录建不出来退化成 stdout-only，业务不崩', t => {
  const lines = memoryJournal(t);
  const sink = createFileSink({ file: '/proc/hids-cannot-create/hids.log' });
  useJournal(createJournal({ write: line => { sink(line); }, now: () => AT }));
  t.after(() => useJournal());
  log('demo.discard', { n: 1 });
  // 不抛即过；内存 journal 的直接写照常（本条走的是包了一层的 journal）
  assert.ok(lines.length === 0 || JSON.parse(lines.at(-1)).event === 'demo.discard');
});

test('logFileOptions 默认路径跟随数据根；HIDS_DATA_DIR 换了跟着换（T072 默认落盘）', () => {
  const env = { HIDS_DATA_DIR: '/tmp/data-a', NODE_TEST_CONTEXT: '' };
  const a = logFileOptions(env, { test: false });
  assert.equal(a.file, path.join(dataRoot({ env: { HIDS_DATA_DIR: '/tmp/data-a' } }), 'logs', 'hids.log'));
  const b = logFileOptions({ ...env, HIDS_DATA_DIR: '/tmp/data-b' }, { test: false });
  assert.equal(b.file, '/tmp/data-b/logs/hids.log');
});

test('currentRequestContext：上下文内可见可回填，上下文外 null', () => {
  runWithRequestContext({ request_id: 'r', user: null }, () => {
    assert.equal(currentRequestContext().request_id, 'r');
    currentRequestContext().user = 'ops';
    assert.equal(currentRequestContext().user, 'ops');
  });
  assert.equal(currentRequestContext(), null);
});
