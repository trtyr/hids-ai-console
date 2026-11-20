// P003-T023 后端全程日志：单一落点 + 五类事件 + 时间/事件名/告警 ID + 不泄凭据。
// 只跑这个文件：node --test evidence/test/P003-T023/logging.test.js
// 全部用内存 journal（注入 write / now），不碰真实 stdout、不碰真实时钟、不起外部服务。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js 求值前把 HIDS_DATA_DIR
// 指到本进程的临时根，否则 createServer 的缺省 fpSessions 会往真全局根写维护会话。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal, log, useJournal } from '../../../log.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { createServer } from '../../../server.js';
import { InvestigationStore } from '../../../investigation-store.js';

const AT = '2026-11-19T00:00:00.000Z';

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

// 每条日志一行 JSON：lines 里是解析后的对象，raw 里是原文（查「凭据有没有漏」按原文查）。
function collect(time = AT) {
  const lines = [];
  const raw = [];
  const journal = createJournal({ now: () => time, write: line => { raw.push(line); lines.push(JSON.parse(line)); } });
  return { lines, raw, journal };
}

// 装上内存 journal，测完还原成默认（丢弃输出，免得污染别的用例）。
function capture(t, time = AT) {
  const sink = collect(time);
  useJournal(sink.journal);
  t.after(() => useJournal(createJournal({ write: () => {} })));
  return sink;
}

const listen = async (t, server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

/* ---------------- A1 / A3：落点与行形状 ---------------- */

test('A1 每条日志一行 JSON，带 time / level / event，字段原样跟着走', t => {
  const { lines, raw } = capture(t);
  log('server.started', { host: '127.0.0.1', port: 8080 });
  log('triage.failed', { alert_id: 'honeypot:7', error: '模型没有返回' }, 'error');

  assert.equal(lines.length, 2);
  assert.equal(raw.length, 2);
  for (const line of raw) assert.equal(line.split('\n').length, 2, '一条日志必须正好一行（末尾一个换行）');
  assert.deepEqual(lines[0], { time: AT, level: 'info', event: 'server.started', host: '127.0.0.1', port: 8080 });
  assert.deepEqual(lines[1], { time: AT, level: 'error', event: 'triage.failed', alert_id: 'honeypot:7', error: '模型没有返回' });
});

test('A3 时间来自注入的时钟，事件名不许被字段覆盖', t => {
  const { lines } = capture(t, '2026-11-19T03:04:05.000Z');
  log('http.request', { event: '假的', time: '假的', level: '假的', method: 'GET', status: 200 });
  assert.deepEqual(lines[0], { time: '2026-11-19T03:04:05.000Z', level: 'info', event: 'http.request', method: 'GET', status: 200 });
});

test('A1 没有字段时也成一条合法日志；非对象字段不炸', t => {
  const { lines } = capture(t);
  log('syslog.listening');
  log('x.y', '字符串字段');
  assert.deepEqual(lines[0], { time: AT, level: 'info', event: 'syslog.listening' });
  assert.deepEqual(lines[1], { time: AT, level: 'info', event: 'x.y' });
});

test('A1 fields 里的取值抛错时落 log.serialize_failed，不把异常抛给业务', t => {
  const { lines } = capture(t);
  const hostile = { get boom() { throw new Error('getter 炸了'); } };
  assert.doesNotThrow(() => log('http.request', hostile));
  assert.equal(lines[0].event, 'log.serialize_failed');
  assert.equal(lines[0].level, 'error');
});

test('A1 写入器抛错（管道断了）不把异常抛给业务', t => {
  useJournal(createJournal({ write: () => { throw new Error('EPIPE'); } }));
  t.after(() => useJournal(createJournal({ write: () => {} })));
  assert.doesNotThrow(() => log('http.request', { path: '/api/status' }));
});

/* ---------------- A4：凭据不进日志 ---------------- */

test('A4 敏感键一律 [redacted]，递归进对象与数组，普通键保留', t => {
  const { lines, raw } = capture(t);
  log('http.request', {
    method: 'GET', path: '/api/status',
    authorization: 'Basic dXNlcjpwYXNzd29yZA==',
    Cookie: 'session=abc123',
    'x-prompt-admin-token': 'tok-live-001',
    nested: { api_token: 'cw-secret', password: 'p@ss', keep: 'ok' },
    list: [{ secret: 's1' }, 'plain']
  });
  const line = lines[0];
  assert.equal(line.authorization, '[redacted]');
  assert.equal(line.Cookie, '[redacted]');
  assert.equal(line['x-prompt-admin-token'], '[redacted]');
  assert.deepEqual(line.nested, { api_token: '[redacted]', password: '[redacted]', keep: 'ok' });
  assert.deepEqual(line.list, [{ secret: '[redacted]' }, 'plain']);
  for (const value of ['dXNlcjpwYXNzd29yZA==', 'abc123', 'tok-live-001', 'cw-secret', 'p@ss'])
    assert.ok(!raw[0].includes(value), `日志原文里漏了 ${value}：${raw[0]}`);
});

test('A4 字符串里的 Basic / Bearer 凭据与 token=… 也会被擦掉', t => {
  const { lines, raw } = capture(t);
  log('cloudwalker.call_failed', { op: 'status', alert_id: null,
    error: '请求头 Authorization: Basic dXNlcjpwYXNz 被拒绝；Bearer eyJhbGciOiJIUzI1NiJ9 过期',
    url: '/api/alerts?token=cw-abc-123&count=20' });
  assert.match(lines[0].error, /Basic \[redacted\]/);
  assert.match(lines[0].error, /Bearer \[redacted\]/);
  assert.match(lines[0].url, /token=\[redacted\]/);
  for (const secret of ['dXNlcjpwYXNz', 'eyJhbGciOiJIUzI1NiJ9', 'cw-abc-123'])
    assert.ok(!raw[0].includes(secret), `日志原文里漏了 ${secret}：${raw[0]}`);
});

test('A4 Error 对象只落消息；超长字符串截断，单行不爆', t => {
  const { lines } = capture(t);
  log('triage.failed', { alert_id: 'honeypot:9', error: new Error('connect ECONNREFUSED 10.0.0.1:443') });
  assert.equal(lines[0].error, 'connect ECONNREFUSED 10.0.0.1:443');

  log('triage.failed', { alert_id: 'honeypot:9', error: 'x'.repeat(5000) });
  assert.ok(lines[1].error.length <= 1001, `超长错误没截断：${lines[1].error.length}`);
  assert.ok(!lines[1].error.includes('\n'));
});

/* ---------------- A2：五类事件都能在日志里找到 ---------------- */

// 假牧云 / 假模型：本卡只验日志，不验业务；HTTP 走进程内真实监听。
const failingService = { status: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); },
  alerts: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); },
  alert: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); } };

test('A2 HTTP：每条请求一条 http.request，带方法/路径/状态/耗时；401 单独一条', async t => {
  const { lines } = capture(t);
  const base = await listen(t, createServer(null, null, null, null, null, null, null,
    { user: 'operator', password: 'test-only-password' }));
  const ok = await fetch(`${base}/api/session`, { headers: { Authorization: 'Basic ' + Buffer.from('operator:test-only-password').toString('base64') } });
  assert.equal(ok.status, 200);

  const requestLine = lines.find(line => line.event === 'http.request');
  assert.deepEqual({ ...requestLine, duration_ms: 0 }, { time: AT, level: 'info', event: 'http.request',
    method: 'GET', path: '/api/session', status: 200, duration_ms: 0 });
  assert.equal(typeof requestLine.duration_ms, 'number');

  // 路径里的 query 不记（可能带令牌）；请求头一个字节都不记。
  const denied = await fetch(`${base}/api/status?token=server-side-secret`);
  assert.equal(denied.status, 401);
  const unauthorized = lines.find(line => line.event === 'http.unauthorized');
  assert.equal(unauthorized.path, '/api/status');
  assert.ok(!JSON.stringify(lines).includes('server-side-secret'), 'query 泄漏了');
  assert.ok(!JSON.stringify(lines).includes('test-only-password'), 'Basic 凭据泄漏了');
  assert.ok(!JSON.stringify(lines).includes('dGVzdC1vbmx5LXBhc3N3b3Jk'), 'Basic 凭据泄漏了');
});

test('A2 牧云调用失败：/api/status、/api/alerts、/api/alerts/{id}、工具列表都落 cloudwalker.call_failed', async t => {
  const { lines } = capture(t);
  const base = await listen(t, createServer(failingService, { listTools: async () => { throw new Error('牧云 API 不可达'); } },
    null, null, null, null));
  assert.equal((await fetch(`${base}/api/status`)).status, 502);
  assert.equal((await fetch(`${base}/api/alerts`)).status, 502);
  assert.equal((await fetch(`${base}/api/alerts/honeypot:7`)).status, 502);
  assert.equal((await fetch(`${base}/api/agent/tools`)).status, 502);

  const failures = lines.filter(line => line.event === 'cloudwalker.call_failed');
  assert.deepEqual(failures.map(line => line.op).sort(), ['alert', 'alerts', 'status', 'tools']);
  assert.equal(failures.find(line => line.op === 'alert').alert_id, 'honeypot:7');
  for (const line of failures) assert.match(line.error, /ECONNREFUSED|不可达/);

  // 外层兜底的失败另留一条 http.failed：状态码与原因都在，不只一行 status=502 的 http.request。
  const failed = lines.filter(line => line.event === 'http.failed');
  assert.equal(failed.length, 3);
  for (const line of failed) { assert.equal(line.status, 502); assert.match(line.error, /ECONNREFUSED|不可达/); }
  assert.deepEqual(failed.map(line => line.path).sort(), ['/api/agent/tools', '/api/alerts', '/api/alerts/honeypot:7']);
});

test('A2 syslog 收下 / 解析失败 / 跳过都在日志里，告警 ID 跟着走', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-log-syslog-'));
  const monitor = new TriageMonitor({ service: {}, investigator: {}, history: {},
    file: path.join(directory, 'queue.json'), inputMode: 'syslog' });
  // 先等队列收尾再删目录：run() 的 persist 还没写完就 rm 会撞 ENOTEMPTY。
  t.after(async () => { await monitor.writeChain; await monitor.acceptChain; await rm(directory, { recursive: true, force: true }); });
  const { lines } = capture(t);

  const line = '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot ' +
    'event_id=7 host_ip=10.0.0.5 source_ip=192.0.2.2 event_create_time="2026-11-03 08:00:00"';
  const accepted = await monitor.acceptSyslog(line);
  const received = lines.find(item => item.event === 'syslog.received');
  assert.equal(received.alert_id, accepted.alert_id);
  assert.equal(received.msgid, 'cloudwalker-honeypot');

  await monitor.acceptSyslog('这不是一行 syslog');
  const failed = lines.find(item => item.event === 'syslog.parse_failed');
  assert.match(failed.error, /RFC5424/);

  await monitor.acceptSyslog('<134>1 2026-11-03T08:00:20Z host app 1 cloudwalker-unknown-msgid host_ip="10.0.0.5"');
  const skipped = lines.find(item => item.event === 'syslog.skipped');
  assert.equal(skipped.reason, 'no_agent_for_msgid');
  await monitor.writeChain;
  await monitor.acceptChain;
});

test('A2 研判入队 → 完成 / 失败都留痕，带告警 ID 与结论', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-log-triage-'));
  // 回收要和后台的落盘抢时间：`rm` 撞上「队列刚又写了一个文件」就 ENOTEMPTY（并发跑套件时实测偶发）。
  // 所以先等两条 chain 落完，再允许重试——这不是把红改绿，是把测试自己的收尾做对。
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { lines } = capture(t);
  const verdict = { verdict: 'threat', verdict_label: '真实威胁', summary: '来源直接命中', claims: [] };
  const history = new InvestigationStore(path.join(directory, 'results'));
  const monitor = new TriageMonitor({ service: {}, history, file: path.join(directory, 'queue.json'), concurrency: 1,
    investigator: { run: async (alertId, { mode }) => ({ alert_id: alertId, mode, verdict, validation: { ok: true } }) } });
  await monitor.enqueue('honeypot:7');
  await monitor.writeChain;
  assert.equal(lines.find(item => item.event === 'triage.enqueued').alert_id, 'honeypot:7');
  for (let n = 0; n < 100 && monitor.status('honeypot:7')?.status !== 'done'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const done = lines.find(item => item.event === 'triage.done');
  assert.equal(done.alert_id, 'honeypot:7');
  assert.equal(done.verdict, 'threat');
  assert.equal(typeof done.duration_ms, 'number');

  const failing = new TriageMonitor({ service: {}, history, file: path.join(directory, 'queue2.json'), concurrency: 1,
    investigator: { run: async () => { throw new Error('模型调用失败（第 2 轮）'); } } });
  await failing.enqueue('honeypot:8');
  for (let n = 0; n < 100 && failing.status('honeypot:8')?.status !== 'failed'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const failed = lines.find(item => item.event === 'triage.failed');
  assert.equal(failed.alert_id, 'honeypot:8');
  // P003-T052：两条路分开锁，别拿一条断言杆两侧：
  // ① 记录侧——队列状态文件里只剩闸后文案（固定文案 + 原文字符量），错误原文不落盘。
  await failing.writeChain;
  const queueFile = await readFile(path.join(directory, 'queue2.json'), 'utf8');
  assert.doesNotMatch(queueFile, /模型调用失败（第 2 轮）/);
  assert.ok(queueFile.includes(`上游调用失败，原文 ${'模型调用失败（第 2 轮）'.length} 字未落盘`));
  // ② 日志侧——`triage.failed` 的 error 取的就是 `record.detail`（`triage-monitor.js:1083`），所以跟着是闸后文案；
  //    “日志行留原文”的是其它事件（`triage.poll_failed` / `syslog.match_failed` 等，归 P003-T046 的日志侧闸），
  //    守卫见 `evidence/test/P003-T052/tester-redaction-boundary.test.js`。
  assert.equal(failed.error, `上游调用失败，原文 ${'模型调用失败（第 2 轮）'.length} 字未落盘`);
  await monitor.writeChain;
});

test('A2 误报维护结果（两侧状态与原因）留在 maintenance.result 里', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-log-maintenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { lines } = capture(t);
  const monitor = { records: new Map(), persist: async () => {} };
  const alertId = 'syslog:honeypot:0123456789abcdef:1763373600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
  monitor.records.set(alertId, { alert_id: alertId, status: 'done', verdict: 'threat',
    verdict_label: '真实威胁', summary: '已研判', case_dir: null, occurrence_count: 1,
    input: { parsed: { msgid: 'cloudwalker-honeypot', payload: {} } } });
  const base = await listen(t, createServer(null, null, null, null, null, monitor, null, null, null, null,
    null, null, null, null, null,
    { maintain: async () => ({ id: 'rule-1', file: 'rule-1.rego', name: '规则', action: 'add', rationale: '新增' }) }));
  // 知识维护端没配（wiki = null）：wiki 侧记 failed，规则侧照常 updated，总态 failed。
  const response = await fetch(`${base}/api/agent/triage/${encodeURIComponent(alertId)}/false-positive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单', who: '值班分析员' }) });
  assert.equal(response.status, 202);

  for (let n = 0; n < 200 && !lines.some(item => item.event === 'maintenance.result'); n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const result = lines.find(item => item.event === 'maintenance.result');
  assert.equal(result.alert_id, alertId);
  assert.equal(result.status, 'failed');
  assert.equal(result.rule, 'updated');
  assert.equal(result.wiki, 'failed');
  assert.match(result.wiki_error, /知识维护端未配置/);
});

test('A2 syslog 研判时的牧云取数失败也落 cloudwalker.call_failed（不被降级吞掉）', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-log-match-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { lines } = capture(t);
  const monitor = new TriageMonitor({ service: {}, history: { save: async result => ({ ...result, saved_at: AT }) },
    file: path.join(directory, 'queue.json'), inputMode: 'syslog', concurrency: 1,
    eventToolbox: { callTool: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); } },
    investigator: { runUnmatchedSyslog: async () => ({ alert_id: 'syslog:honeypot:x', mode: 'triage',
      verdict: { verdict: 'uncertain', claims: [] }, validation: { ok: true } }) } });
  const line = '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot ' +
    'event_id=7 host_id=12 host_ip=10.0.0.5 source_ip=192.0.2.2 event_create_time="2026-11-03 08:00:00"';
  await monitor.acceptSyslog(line);
  for (let n = 0; n < 100 && !lines.some(item => item.event === 'triage.done' || item.event === 'triage.failed'); n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const failure = lines.find(item => item.event === 'cloudwalker.call_failed');
  assert.equal(failure.op, 'call_tool');
  assert.match(failure.error, /ECONNREFUSED/);
});

test('A2 syslog 绑定失败与接收器错误也在日志里', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-log-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { lines } = capture(t);
  const monitor = new TriageMonitor({ service: {}, investigator: {}, history: {},
    file: path.join(directory, 'queue.json'), inputMode: 'syslog' });
  const failed = await monitor.attachSyslog({ start: async () => {
    throw Object.assign(new Error('bind EADDRINUSE 127.0.0.1:15514'), { code: 'EADDRINUSE' }); } });
  assert.equal(failed.listening, false);
  const bindFailed = lines.find(item => item.event === 'syslog.bind_failed');
  assert.match(bindFailed.error, /EADDRINUSE/);
});
