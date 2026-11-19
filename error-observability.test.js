import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from './triage-monitor.js';
import { WikiStore } from './wiki-store.js';
import { createServer } from './server.js';

// 进程内起服务：假上游全部是本地替身，不碰真实网络 / 真实时钟。
const listen = async (t, server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const postJSON = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) });

// A1（B24）：页面不存在时 404 正文不得带服务器绝对路径。
test('知识库 404 正文只给相对路径，不带服务器目录', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-wiki-404-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'wiki');
  await mkdir(path.join(directory, 'common'), { recursive: true });
  await writeFile(path.join(directory, 'common', 'GEN-01.md'), '# 已有的判据\n');
  const wiki = new WikiStore(directory);
  const base = await listen(t, createServer(null, null, null, null, null, null, null, null, null, null, wiki));

  const missing = await fetch(`${base}/api/wiki/pages/common%2FGEN-99.md`);
  assert.equal(missing.status, 404);
  const body = await missing.text();
  assert.ok(!body.includes(root), `404 正文泄漏了服务器目录：${body}`);
  assert.ok(!body.includes(tmpdir()), `404 正文泄漏了临时目录：${body}`);
  assert.deepEqual(JSON.parse(body), { error: '知识库页面不存在：common/GEN-99.md', code: 'caller_error' });

  // 写接口走同一条 get()：改不存在的页面也是 404，同样不回绝对路径。
  const signed = await fetch(`${base}/api/wiki/pages/common%2FGEN-99.md`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: 'a'.repeat(16), content: '# 新判据\n' }) });
  assert.equal(signed.status, 404);
  const signedBody = await signed.text();
  assert.ok(!signedBody.includes(root), `PUT 404 正文泄漏了服务器目录：${signedBody}`);
  assert.match(JSON.parse(signedBody).error, /^知识库页面不存在：common\/GEN-99\.md$/);

  // 相对路径仍能读到：换的不是成功路径。
  assert.equal((await fetch(`${base}/api/wiki/pages/common%2FGEN-01.md`)).status, 200);
});

// A2（B27）：syslog 绑定失败要在 /api/agent/triage/status 看得出「收不到消息」。
test('syslog 绑定失败时队列状态带出接收器状态', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-syslog-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ service: {}, investigator: {}, history: {},
    file: path.join(directory, 'triage.json'), inputMode: 'syslog' });

  // 还没尝试绑定：既没监听也没报错，和「绑定失败」分得开。
  assert.deepEqual(monitor.summary().syslog, { listening: false, bind: null, error: null });

  const bound = await monitor.attachSyslog({ start: async () => ({ address: '127.0.0.1', port: 15514 }) });
  assert.deepEqual(bound, { listening: true, bind: 'udp://127.0.0.1:15514', error: null });

  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const failed = await monitor.attachSyslog({ start: async () => {
    throw Object.assign(new Error('bind EADDRINUSE 127.0.0.1:15514'), { code: 'EADDRINUSE' }); } });
  assert.equal(failed.listening, false);
  assert.equal(failed.bind, null);
  assert.match(failed.error, /EADDRINUSE/);
  // 绑定失败不抛、不拖垮队列：其它字段照旧可读。
  const status = await (await fetch(`${base}/api/agent/triage/status`)).json();
  assert.equal(status.input_mode, 'syslog');
  assert.equal(status.syslog.listening, false);
  assert.match(status.syslog.error, /EADDRINUSE/);
  assert.deepEqual(status.counts, { queued: 0, running: 0, done: 0, failed: 0 });
  assert.equal(status.interval_ms, undefined);
});

test('轮询模式的队列状态形状不变，不多出 syslog 键', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-poll-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ service: {}, investigator: {}, history: {},
    file: path.join(directory, 'triage.json'), inputMode: 'poll', intervalMs: 30000 });
  const summary = monitor.summary();
  assert.equal(summary.syslog, undefined);
  assert.equal(summary.interval_ms, 30000);
});

// A3（B21）：连不上牧云仍是 502，正文 {configured, connected, reason}——契约 pin，本卡不改代码。
test('/api/status 连不上牧云是 502，正文带 configured/connected/reason', async t => {
  const service = { status: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); } };
  const base = await listen(t, createServer(service, null, null, null, null, null));
  const response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(),
    { configured: true, connected: false, reason: 'connect ECONNREFUSED 10.0.0.1:443', code: 'upstream_error' });

  // 没配牧云仍走 200：502 只表示「配了但连不上」。
  const unconfigured = await listen(t, createServer(null, null, null, null, null, null));
  assert.equal((await fetch(`${unconfigured}/api/status`)).status, 200);
});

// A4（B26）：401 正文是纯文本，Content-Type 要跟 openapi.yaml:1013-1020 的 text/plain 一致。
test('业务认证失败的 401 是纯文本正文且声明 text/plain', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, null, null,
    { user: 'operator', password: 'test-only-password' }));
  const denied = await fetch(`${base}/api/session`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await denied.text(), '需要登录后访问');
  assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="HIDS AI Console", charset="UTF-8"');

  // 同一闸门下的业务路由也是同一份 401。
  const api = await fetch(`${base}/api/status`);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('content-type'), 'text/plain; charset=utf-8');
});

// A5（B28）：读 config.rules 之前先判正文形状，内部 TypeError 不外泄。
test('规则校验接口先判正文形状，再读 config.rules', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, null, null, null));
  const url = `${base}/api/triage/rules/validate`;
  for (const body of ['null', '[]', '"文本"', '5', '{}']) {
    const response = await postJSON(url, body);
    assert.equal(response.status, 400, `正文 ${body} 应回 400`);
    const { error } = await response.json();
    assert.equal(error, '请求正文缺少 config', `正文 ${body} 的文案`);
    assert.doesNotMatch(error, /Cannot read|reading '/);
  }
  // config 键在、值不是对象：交给规则集校验，仍是中文 400，不泄漏内部异常。
  for (const body of ['{"config":null}', '{"config":[]}']) {
    const response = await postJSON(url, body);
    assert.equal(response.status, 400, `正文 ${body} 应回 400`);
    const { error } = await response.json();
    assert.equal(error, '规则集格式无效', `正文 ${body} 的文案`);
    assert.doesNotMatch(error, /Cannot read|reading '/);
  }
  const invalidJSON = await postJSON(url, '不是 JSON');
  assert.equal(invalidJSON.status, 400);
  assert.equal((await invalidJSON.json()).error, '请求正文不是 JSON');

  // rules 不是数组：形状对、内容不合法 → 仍是校验失败文案，不泄漏内部异常。
  const wrongRules = await postJSON(url, { config: { schema_version: 1, enabled: true, rules: 'x' } });
  assert.equal(wrongRules.status, 400);
  assert.equal((await wrongRules.json()).error, '规则集格式无效');

  const empty = await postJSON(url, { config: { schema_version: 1, enabled: true, rules: [] } });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { valid: true, count: 0 });
});
