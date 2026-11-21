// P003-T045 日志落盘：文件 sink / 轮转 / 查询与清理（写者自测，交付物之一是「tester 能照着写的契约」）。
// 口径只认文档：docs/modules/http-api.md §3.8（两条路由的字段与参数表）、§7（分页）、
// docs/architecture.md §3.6（落盘与轮转口径、事件表）、.env.example（三个键）。
// 做法：tmp 目录 + 注入时钟/写入器 + 进程内 server；只有 A1 那条真进程小样碰真 spawn（验「同份落文件」）。
// 全局根隔离（P003-T050 A2）：本文件触发写接口 → 产生审计事件（P003-T062），必须先隔离数据根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFileSink, createJournal, flushLogs, log, logFileOptions, logFiles, pruneLogFiles, readLogEntries, useJournal, useLogFile
} from '../../../src/shared/logging/log.js';
import { createServer } from '../../../server.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AT = '2026-11-20T00:00:00.000Z';

const workspace = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-log-'));
  // maxRetries 只是兜底：真进程用例自己按 kill→rm 的注册顺序收尾（见 A1 真进程那条的注释）。
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { dir, file: path.join(dir, 'hids.log') };
};

// 写入器 + 时钟都注入：不碰真 stdout、不碰真时钟；行内容可控（不必每条都不同）。
const sinkRig = (file, { maxBytes = 10 * 1024 * 1024, keep = 5, start = Date.parse(AT), step = 1000 } = {}) => {
  let clock = start;
  const sink = createFileSink({ file, maxBytes, keep, now: () => clock });
  const journal = createJournal({ write: sink, now: () => new Date(clock).toISOString() });
  return { sink, journal, tick: (ms = step) => { clock += ms; }, at: () => new Date(clock).toISOString() };
};

const linesOf = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const namesIn = async dir => (await readdir(dir)).sort();
const rotated = async dir => (await namesIn(dir)).filter(name => name !== 'hids.log');

// 进程内 server：只把 logFile 注入进去，其余能力置空（本卡两条路由只碰本地文件）。
async function serve(t, logFile) {
  const server = createServer(null, null, null, null, null, null, null, { user: null, password: null }, null, null,
    null, null, null, null, null, null, null, null, logFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const getLogs = async (base, query = '') => {
  const response = await fetch(`${base}/api/logs${query}`);
  return { status: response.status, body: await response.json() };
};

const cleanLogs = async (base, body) => {
  const response = await fetch(`${base}/api/logs/cleanup`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

// 捕获 journal：断言留痕字段，同时断言「不记文件名」。
const captureJournal = t => {
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(line), now: () => AT }));
  t.after(() => useJournal());
  return { lines, events: name => lines.map(line => JSON.parse(line)).filter(entry => entry.event === name) };
};

// ── A1：配了就同份落文件，不配＝stdout-only ────────────────────────────────
test('A1 logFileOptions：空/空白算没配（测试进程默认关）；四个键缺省 10MiB/5/200MiB，非法值回落缺省（P003-T072）', () => {
  assert.equal(logFileOptions({}), null, '测试进程（NODE_TEST_CONTEXT）默认不落盘——不污染真实数据根');
  assert.equal(logFileOptions({ HIDS_LOG_FILE: '' }), null);
  assert.equal(logFileOptions({ HIDS_LOG_FILE: '   ' }), null, '纯空白算没配（与 HIDS_DATA_DIR 同一口径）');
  assert.equal(logFileOptions({ HIDS_LOG_FILE: 'none' }), null, '显式关闭走 none（P003-T072）');
  assert.equal(logFileOptions({ HIDS_LOG_FILE: 'off' }), null, 'off 同义');
  assert.deepEqual(logFileOptions({ HIDS_LOG_FILE: '/var/log/hids.log' }),
    { file: '/var/log/hids.log', maxBytes: 10 * 1024 * 1024, keep: 5, totalMaxBytes: 200 * 1024 * 1024 });
  assert.equal(logFileOptions({ HIDS_LOG_FILE: 'rel/hids.log' }).file, path.resolve('rel/hids.log'), '相对路径按 cwd 绝对化');
  // 0 / 负数 / 小数 / 非数 都落回缺省：坏配置不让轮转静默关掉
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const options = logFileOptions({ HIDS_LOG_FILE: 'x.log', HIDS_LOG_MAX_BYTES: bad, HIDS_LOG_KEEP: bad, HIDS_LOG_TOTAL_MAX_BYTES: bad });
    assert.equal(options.maxBytes, 10 * 1024 * 1024, `HIDS_LOG_MAX_BYTES=${bad} 应回落缺省`);
    assert.equal(options.keep, 5, `HIDS_LOG_KEEP=${bad} 应回落缺省`);
    assert.equal(options.totalMaxBytes, 200 * 1024 * 1024, `HIDS_LOG_TOTAL_MAX_BYTES=${bad} 应回落缺省`);
  }
  // P003-T072 默认落盘：生产进程（test:false）不配路径 → <数据根>/logs/hids.log；测试进程 → null
  const production = logFileOptions({ HIDS_DATA_DIR: '/tmp/hids-data-probe', NODE_TEST_CONTEXT: '' }, { test: false });
  assert.equal(production.file, path.join('/tmp/hids-data-probe', 'logs', 'hids.log'));
  assert.deepEqual(logFileOptions({ NODE_TEST_CONTEXT: 'child-v8' }, { test: true }), null);
});

test('A1 不配路径：useLogFile 原样返回现有 journal，盘上不多出文件', async t => {
  const { dir } = await workspace(t);
  const memory = createJournal({ write: () => {}, now: () => AT });
  useJournal(memory);
  t.after(() => useJournal());
  assert.equal(useLogFile({}), memory);
  assert.equal(useLogFile({ file: '' }), memory);
  assert.deepEqual(await namesIn(dir), []);
});

test('A1 配了路径：同一行既给 stdout 又落文件（同份），先写文件再写 stdout', async t => {
  const { file } = await workspace(t);
  const stdout = [];
  const fileAtStdout = [];
  // stdout 写回调里回看盘面：文档 §3.8.1 承诺「先写文件再写 stdout」（stdout 断了文件那份也不丢）
  useLogFile({ file, write: line => { fileAtStdout.push(readFileSync(file, 'utf8')); stdout.push(line); } });
  t.after(() => useJournal());
  log('demo.event', { n: 1 });
  await flushLogs(); // P003-T072：落盘改异步 sink，断言前先排空队列（I/O 不在调用栈上同步发生）
  const written = await linesOf(file);
  assert.equal(written.length, 1);
  assert.deepEqual(stdout, [`${JSON.stringify(written[0])}\n`], 'stdout 那份与文件那份逐字相同');
  assert.deepEqual(fileAtStdout, stdout, '写 stdout 的时候文件里已经有这行了（先文件后 stdout）');
  assert.equal(written[0].event, 'demo.event');
});

test('A1 真进程：配了 HIDS_LOG_FILE，server.started 同时出现在文件与 stdout', async t => {
  // 这条要真 spawn，所以不用 workspace(t)：它一进来就注册 rm 钩子，而 node:test 的 t.after 按注册顺序跑
  // （先注册先跑，我用 5 行小例实测过）。顺序反了就是 rm 在子进程还活着时删目录 → ENOTEMPTY，
  // 更糟的是钩子抛错会吞掉后面的 kill（同样实测），子进程就不由套件回收了。故：kill 先注册、rm 后注册。
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-log-'));
  const file = path.join(dir, 'hids.log');
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HIDS_HOST: '127.0.0.1', HIDS_PORT: '0', HIDS_DATA_DIR: path.join(dir, 'data'),
      HIDS_LOG_FILE: file, CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: 'fake-token-123456',
      LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'fake-key-abcdef', LLM_MODEL: 'fake-model',
      HIDS_TRIAGE_INPUT_MODE: 'poll' } });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  // 先注册：杀掉子进程并等它真退出
  t.after(() => new Promise(done => {
    if (child.exitCode !== null) { done(); return; }
    child.once('exit', () => done());
    child.kill('SIGKILL');
  }));
  // 后注册：子进程退出之后才删目录（maxRetries 只兜 ENOTEMPTY 的极端残影）
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const deadline = Date.now() + 8000;
  let fileLine = null;
  while (!fileLine) {
    if (Date.now() > deadline) throw new Error(`8s 内文件里没有 server.started：stdout=${stdout}`);
    try { fileLine = (await linesOf(file)).find(entry => entry.event === 'server.started') ?? null; } catch { /* 文件还没建出来 */ }
    if (!fileLine) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fileLine, 'server.started 应落进配置文件');
  // 文件命中不等于 stdout 已 flush 到父进程管道：轮询等 stdout 也出现 server.started 再断言（只认整行，避开半行）
  const stdoutDeadline = Date.now() + 5000;
  let stdoutLine = null;
  while (!stdoutLine) {
    if (Date.now() > stdoutDeadline) break;
    stdoutLine = stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.event === 'server.started') ?? null;
    if (!stdoutLine) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(stdoutLine, `stdout 也应有一条 server.started：${stdout}`);
  assert.equal(stdoutLine.port, fileLine.port, '文件与 stdout 是同一条（同份）');
});

// ── A2：单文件上限 + 保留份数，超限轮转不丢当前写入 ──────────────────────────
test('A2 超限轮转：跨文件一行不少，当前这条写进轮转后的新文件', async t => {
  const { dir, file } = await workspace(t);
  const rig = sinkRig(file, { maxBytes: 200, keep: 50 });
  for (let n = 0; n < 6; n += 1) { rig.journal('step', { n }); rig.tick(); }
  await flushLogs();
  assert.ok((await rotated(dir)).length >= 1, '超过上限就该有轮转出来的历史文件');
  const all = [];
  for (const name of await namesIn(dir)) all.push(...await linesOf(path.join(dir, name)));
  assert.deepEqual(all.map(entry => entry.n).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], '6 行一行都不许丢');
  const current = await linesOf(file);
  assert.deepEqual(current.at(-1).n, 5, '最后写的那行落在当前活动文件里（不是被轮转掉的那个）');
});

test('A2 保留份数：keep=2 时历史文件只留最新两份', async t => {
  const { dir, file } = await workspace(t);
  const rig = sinkRig(file, { maxBytes: 200, keep: 2 });
  for (let n = 0; n < 12; n += 1) { rig.journal('step', { n }); rig.tick(); }
  await flushLogs();
  assert.equal((await rotated(dir)).length, 2, `keep=2 应只留两份历史：${(await namesIn(dir)).join(',')}`);
  assert.ok((await linesOf(file)).length >= 1);
});

test('A2 单行就超上限时不轮转（空文件不换），内容照旧写进去；重启后按盘上大小接着算', async t => {
  const { dir, file } = await workspace(t);
  const rig = sinkRig(file, { maxBytes: 80, keep: 5 });
  rig.journal('big', { pad: 'x'.repeat(200) });
  await flushLogs();
  assert.deepEqual(await rotated(dir), [], '空文件没有可轮转的内容');
  assert.equal((await linesOf(file)).length, 1, '超上限的那一行仍要写进去');
  // 重启：新 sink 第一次写之前要先 stat 现有文件，已超限就先轮转，老内容进历史文件
  const restarted = sinkRig(file, { maxBytes: 80, keep: 5 });
  restarted.journal('after_restart');
  await flushLogs();
  assert.equal((await rotated(dir)).length, 1, '重启后第一次写应把超限的老文件轮转出去');
  assert.equal((await linesOf(file)).at(-1).event, 'after_restart');
  const history = await linesOf(path.join(dir, (await rotated(dir))[0]));
  assert.equal(history.at(-1).event, 'big');
});

// ── A3：查询按 event / level / 时间过滤，分页，读的是盘上文件 ────────────────
test('A3 readLogEntries：event / level / 时间范围过滤 + 分页 + total 是切页前条数', async t => {
  const { file } = await workspace(t);
  const rig = sinkRig(file);
  rig.journal('a.one', { i: 1 }, 'info');
  rig.tick();
  rig.journal('b.two', { i: 2 }, 'warn');
  rig.tick();
  rig.journal('a.one', { i: 3 }, 'error');
  rig.tick();
  rig.journal('a.one', { i: 4 }, 'info');
  await flushLogs();

  const all = readLogEntries({ file });
  assert.deepEqual(all.logs.map(entry => entry.i), [4, 3, 2, 1], '默认按 time 倒序');
  assert.equal(all.total, 4);
  assert.equal(all.files, 1);
  assert.equal(all.truncated, false);

  assert.deepEqual(readLogEntries({ file, events: ['a.one'] }).logs.map(entry => entry.i), [4, 3, 1]);
  assert.deepEqual(readLogEntries({ file, levels: ['warn', 'error'] }).logs.map(entry => entry.i), [3, 2]);
  assert.deepEqual(readLogEntries({ file, from: '2026-11-20T00:00:01.000Z' }).logs.map(entry => entry.i), [4, 3, 2]);
  assert.deepEqual(readLogEntries({ file, to: '2026-11-20T00:00:01.000Z' }).logs.map(entry => entry.i), [2, 1]);
  const page = readLogEntries({ file, count: 2, offset: 1 });
  assert.deepEqual(page.logs.map(entry => entry.i), [3, 2]);
  assert.equal(page.total, 4, 'total 是筛选后、切页前的条数');
  // 上线防护：命中超过 limit 只收前 limit 条并标 truncated
  const capped = readLogEntries({ file, limit: 2 });
  assert.equal(capped.logs.length, 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.total, 2);
});

test('A3 GET /api/logs：读盘（外部写入的行也看得见）、echo 回显分页、非法参数 400、未配 503', async t => {
  const { file } = await workspace(t);
  const rig = sinkRig(file);
  rig.journal('http.request', { path: '/api/x', status: 200 });
  rig.tick();
  rig.journal('log.cleaned', { by: 'size' });
  await flushLogs();
  const base = await serve(t, file);

  // 「读的是落盘文件」：绕过 log.js 直接往盘上追加一行，查询必须看得见
  const external = JSON.stringify({ time: '2026-11-20T00:00:09.000Z', level: 'warn', event: 'external.row' });
  await writeFile(file, `${external}\n`, { flag: 'a' });

  const ok = await getLogs(base, '?count=2&offset=0');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.echo, { count: 2, offset: 0 });
  assert.equal(ok.body.total, 3);
  assert.deepEqual(ok.body.logs.map(entry => entry.event), ['external.row', 'log.cleaned']);
  assert.equal(ok.body.truncated, false);
  assert.equal(typeof ok.body.files, 'number');
  assert.equal((await getLogs(base, '?event=http.request')).body.logs.length, 1);
  assert.equal((await getLogs(base, '?level=warn')).body.logs[0].event, 'external.row');
  assert.equal((await getLogs(base, '?event=log.cleaned,http.request')).body.total, 2, 'event 支持逗号多选');
  assert.equal((await getLogs(base, '?count=50')).status, 200);
  assert.equal((await getLogs(base, '?count=20')).body.echo.count, 20);

  for (const query of ['?count=0', '?count=51', '?count=abc', '?count=20.5', '?offset=-1']) {
    const bad = await getLogs(base, query);
    assert.equal(bad.status, 400, `${query} 应回 400`);
    assert.deepEqual(bad.body, { error: '分页参数无效', code: 'caller_error' });
  }
  for (const query of ['?level=trace', '?from=yesterday', '?to=nope', '?from=2026-11-21T00:00:00.000Z&to=2026-11-20T00:00:00.000Z']) {
    const bad = await getLogs(base, query);
    assert.equal(bad.status, 400, `${query} 应回 400`);
    assert.equal(bad.body.code, 'caller_error');
  }

  const unconfigured = await serve(t, null);
  const missing = await getLogs(unconfigured);
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.body, { error: '日志未落盘：未配置 HIDS_LOG_FILE', code: 'not_configured' });
});

// ── A4：清理按时间 / 大小，留痕；当前活动文件永不删 ──────────────────────────
test('A4 清理：默认 dry-run 不动盘；execute 只删历史文件、当前文件还在；remaining 现扫', async t => {
  const { dir, file } = await workspace(t);
  const rig = sinkRig(file, { maxBytes: 120, keep: 20 });
  for (let n = 0; n < 8; n += 1) { rig.journal('step', { n }); rig.tick(); }
  await flushLogs();
  const before = await namesIn(dir);
  assert.ok((await rotated(dir)).length >= 3, '先得有历史文件可清');
  const base = await serve(t, file);

  const dry = await cleanLogs(base, { max_bytes: 0 });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.applied.count, 0);
  assert.ok(dry.body.candidates.count >= 3);
  assert.deepEqual(await namesIn(dir), before, 'dry-run 盘上一个字节都不许动');
  assert.deepEqual(dry.body.threshold, { older_than: null, max_bytes: 0 });

  const applied = await cleanLogs(base, { max_bytes: 0, execute: true });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.dry_run, false);
  assert.equal(applied.body.applied.count, dry.body.candidates.count);
  assert.equal(applied.body.remaining.count, 0);
  assert.deepEqual(await rotated(dir), [], '历史文件全清');
  assert.ok((await stat(file)).size > 0, '当前活动文件不能在候选里');
  assert.ok((await linesOf(file)).length >= 1, '当前文件的行还在');
});

test('A4 清理：older_than 按文件 mtime 挑；两条阈值取并集；400 三条', async t => {
  const { dir, file } = await workspace(t);
  const rig = sinkRig(file, { maxBytes: 120, keep: 20 });
  for (let n = 0; n < 6; n += 1) { rig.journal('step', { n }); rig.tick(); }
  await flushLogs();
  const base = await serve(t, file);
  // 历史文件的 mtime 是真实时钟：把「未来」当阈值 → 全部历史文件都算「早于它」
  const future = new Date(Date.now() + 3600_000).toISOString();
  const byAge = await cleanLogs(base, { older_than: future });
  assert.equal(byAge.status, 200);
  assert.deepEqual(byAge.body.threshold, { older_than: future, max_bytes: null });
  assert.equal(byAge.body.candidates.count, (await rotated(dir)).length);
  // 阈值之「差一毫秒」的另一侧：过去的时间点一个都不该选中
  const past = await cleanLogs(base, { older_than: '2000-01-01T00:00:00.000Z' });
  assert.equal(past.body.candidates.count, 0);

  for (const [body, message] of [
    [{}, '至少要给一个阈值：older_than（早于某时间）或 max_bytes（历史文件总字节上限）'],
    [{ older_than: 'yesterday' }, 'older_than 必须是可解析的时间（ISO 8601）'],
    [{ max_bytes: -1 }, 'max_bytes 必须是不小于 0 的整数'],
    [{ max_bytes: 1.5 }, 'max_bytes 必须是不小于 0 的整数'],
    [{ max_bytes: 0, execute: 'yes' }, 'execute 必须是布尔值'],
    [{ max_bytes: 0, keep: 3 }, '不认识的参数：keep'],
    ['[]', '请求正文必须是 JSON 对象']
  ]) {
    const bad = await cleanLogs(base, body);
    assert.equal(bad.status, 400, `${JSON.stringify(body)} 应回 400`);
    assert.deepEqual(bad.body, { error: message, code: 'caller_error' });
  }

  const unconfigured = await serve(t, null);
  const missing = await cleanLogs(unconfigured, { max_bytes: 0 });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, 'not_configured');
});

test('A4 留痕：真执行落一条 log.cleaned（口径/条数/字节），不记文件名；dry-run 不留痕', async t => {
  const { file } = await workspace(t);
  const rig = sinkRig(file, { maxBytes: 120, keep: 20 });
  for (let n = 0; n < 6; n += 1) { rig.journal('step', { n }); rig.tick(); }
  const journal = captureJournal(t);
  const base = await serve(t, file);

  await cleanLogs(base, { max_bytes: 0 });
  assert.deepEqual(journal.events('log.cleaned'), [], 'dry-run 不留痕');

  const applied = await cleanLogs(base, { max_bytes: 0, execute: true });
  const [trace] = journal.events('log.cleaned');
  assert.equal(trace.by, 'size');
  assert.equal(trace.count, applied.body.applied.count);
  assert.equal(trace.bytes, applied.body.applied.bytes);
  // P003-T072：留痕行活在请求上下文里 → 自动带 request_id（可反查这次清理是哪个请求发起的）。
  assert.ok(trace.request_id, '留痕行带 request_id');
  assert.deepEqual(Object.keys(trace).sort(), ['by', 'bytes', 'count', 'event', 'level', 'request_id', 'time'], '不记文件名、不记内容');
});

// ── A5：密钥三道闸沿用，文件与查询结果里都没有原文 ──────────────────────────
test('A5 落盘与查询结果都不出现 Authorization / Cookie / Token 原文', async t => {
  const { file } = await workspace(t);
  const rig = sinkRig(file);
  rig.journal('cloudwalker.call_failed', {
    op: 'alert',
    authorization: 'Bearer SECRET-BEARER-123456',
    cookie: 'session=SECRET-COOKIE-abcdef',
    error: 'GET /api/v1/host/list?api_token=SECRET-URL-123456 failed, Authorization: Bearer SECRET-INLINE-abcdef'
  });
  await flushLogs();
  const raw = await readFile(file, 'utf8');
  for (const secret of ['SECRET-BEARER-123456', 'SECRET-COOKIE-abcdef', 'SECRET-URL-123456', 'SECRET-INLINE-abcdef'])
    assert.ok(!raw.includes(secret), `文件里漏了 ${secret}`);
  assert.ok(raw.includes('[redacted]'));

  // 读路径第二道闸：盘上被手写进一条带凭据的行，查询结果仍要擦掉
  await writeFile(file, `${JSON.stringify({ time: '2026-11-20T00:00:05.000Z', level: 'info', event: 'hand.written',
    token: 'SECRET-HANDWRITTEN-123456', note: 'api_token=SECRET-NOTE-abcdef' })}\n`, { flag: 'a' });
  const base = await serve(t, file);
  const response = await getLogs(base, '?event=hand.written');
  const body = JSON.stringify(response.body);
  for (const secret of ['SECRET-HANDWRITTEN-123456', 'SECRET-NOTE-abcdef']) assert.ok(!body.includes(secret), `查询结果漏了 ${secret}`);
  assert.equal(response.body.logs[0].token, '[redacted]');
});

// A5 第三道闸：请求头与 query 里的凭据不进日志——/api/logs 自己的请求也落在同一份日志里。
test('A5 请求头与 query 里的凭据不进文件，也不出现在查询结果里', async t => {
  const { file } = await workspace(t);
  const sink = createFileSink({ file, now: () => Date.parse(AT) });
  useJournal(createJournal({ write: sink, now: () => AT }));
  t.after(() => useJournal());
  const base = await serve(t, file);
  await fetch(`${base}/api/logs?token=SECRET-QUERY-123456&event=http.request`, {
    headers: { Authorization: 'Bearer SECRET-HEADER-abcdef', Cookie: 'session=SECRET-COOKIE-abcdef' } });
  await flushLogs();
  const raw = await readFile(file, 'utf8');
  for (const secret of ['SECRET-QUERY-123456', 'SECRET-HEADER-abcdef', 'SECRET-COOKIE-abcdef'])
    assert.ok(!raw.includes(secret), `日志文件里漏了 ${secret}`);
  assert.ok(raw.includes('"path":"/api/logs"'), '只记去掉 query 的路径');
  const body = JSON.stringify((await getLogs(base, '?event=http.request')).body);
  assert.ok(!body.includes('SECRET-'), '查询结果里也不许有');
});

// ── A6：.env.example 与代码读的键双向一致（T025 A4 口径），含本卡三个新键 ────
test('A6 .env.example 列出三个新键，头部「N 个键」与实际键数一致', async () => {
  const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const listed = new Set(example.split('\n').filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]));
  for (const key of ['HIDS_LOG_FILE', 'HIDS_LOG_MAX_BYTES', 'HIDS_LOG_KEEP'])
    assert.ok(listed.has(key), `.env.example 少了本卡新增的 ${key}`);
  const source = await readFile(path.join(ROOT, 'src/shared/logging/log.js'), 'utf8');
  for (const key of ['HIDS_LOG_FILE', 'HIDS_LOG_MAX_BYTES', 'HIDS_LOG_KEEP', 'HIDS_LOG_TOTAL_MAX_BYTES'])
    assert.ok(source.includes(key), `log.js 应真读 ${key}`);
  const claimed = example.match(/（P003-T025 立[^）]*?(\d+) 个键/);
  assert.ok(claimed, '头部注释应写着键数（T025 A4 口径）');
  assert.equal(Number(claimed[1]), listed.size, `头部注释写着 ${claimed?.[1]} 个键，实际 ${listed.size} 个`);
});

// ── 行为不变量：logFiles 只认自己的历史文件，同目录别人的 .log 不算 ──────────
test('logFiles：同目录里别人的 .log 与本文件无关，不列表也不清理', async t => {
  const { dir, file } = await workspace(t);
  await writeFile(file, '');
  await writeFile(path.join(dir, 'other.log'), 'x\n');
  await writeFile(path.join(dir, 'hids.log.1'), 'x\n');
  const rig = sinkRig(file, { maxBytes: 120, keep: 20 });
  rig.journal('step', { n: 1 });
  rig.tick();
  rig.journal('step', { n: 2 });
  rig.tick();
  rig.journal('step', { n: 3 });
  await flushLogs();
  const files = logFiles({ file });
  assert.ok(files.length >= 2);
  for (const item of files) assert.ok(!item.file.endsWith('other.log') && !item.file.endsWith('hids.log.1'), item.file);
  const pruned = pruneLogFiles({ file, maxBytes: 0, execute: true });
  assert.ok(pruned.applied.count >= 1);
  assert.ok((await namesIn(dir)).includes('other.log'), '别人的日志文件不许删');
  assert.ok(readLogEntries({ file }).logs.length >= 1, '当前文件照样能读');
});
