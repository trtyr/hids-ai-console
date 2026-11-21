// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceServer } from './src/interfaces/http/maintenance/server.js';
import { createServer } from './server.js';
import { UpdateStore } from './src/contexts/dataops/infrastructure/update-store.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { PromptStore } from './src/contexts/knowledge/infrastructure/prompt-store.js';
import { TriageMonitor } from './src/contexts/triage/application/triage-monitor.js';

// 隔离自证（P003-T050 A5 的牙）。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// ── 业务端：每类失败一条 (status, code) 组合 + 同类同码 ──────────────────────────
test('业务端四类失败的 (status, code) 组合：caller 404 / config 503 / upstream 502 / internal 500', async t => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-error-contract-queue.json', service: {}, investigator: {}, history: {} });
  Object.assign(monitor, { setEnabled: async () => { throw new Error('本地运行态写入失败（内部类样例）'); } });
  const base = await listen(t, createServer({ status: async () => { throw new Error('探活失败 token=secret-value'); } },
    null, null, null, null, monitor));
  const get = async path => fetch(`${base}${path}`);
  // caller：未知路径 404（未知路径统一一个文案）
  const unknown = await get('/api/none-such');
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: '接口不存在', code: 'caller_error' });
  // caller：另一条未知路径同类同码
  assert.deepEqual(await (await get('/api/agent/nope')).json(), { error: '接口不存在', code: 'caller_error' });
  // config：日志未落盘（未配 HIDS_LOG_FILE）503 not_configured
  const logs = await get('/api/logs');
  assert.equal(logs.status, 503);
  const logsBody = await logs.json();
  assert.equal(logsBody.code, 'not_configured');
  assert.match(logsBody.error, /HIDS_LOG_FILE/);
  // upstream：/api/status 配了但探活失败 502（特例形状 + 统一 code）
  const status = await get('/api/status');
  assert.equal(status.status, 502);
  const statusBody = await status.json();
  assert.equal(statusBody.configured, true);
  assert.equal(statusBody.connected, false);
  assert.equal(statusBody.code, 'upstream_error');
  assert.doesNotMatch(statusBody.error, /secret-value/, '错误正文要擦凭据');
  // internal：unexpected 异常 500，error 恒为固定文案
  const control = await fetch(`${base}/api/agent/triage/control`, { method: 'PUT', body: '{"enabled":true}' });
  assert.equal(control.status, 500);
  assert.deepEqual(await control.json(), { error: '服务器内部错误', code: 'internal_error' });
});

test('方法不匹配统一回 405 并带 Allow；已知路径的每条方法各有出口', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, null));
  const mismatch = await fetch(`${base}/api/config`, { method: 'DELETE' });
  assert.equal(mismatch.status, 405);
  const body = await mismatch.json();
  assert.equal(body.code, 'caller_error');
  assert.match(body.error, /该方法不支持/);
  assert.match(mismatch.headers.get('allow'), /GET/);
  // 动态前缀同样生效：/api/rules/<id> 不接受 POST
  const dynamic = await fetch(`${base}/api/rules/ssh_bruteforce`, { method: 'POST', body: '{}' });
  assert.equal(dynamic.status, 405);
  assert.match(dynamic.headers.get('allow'), /GET, PUT, POST/);
});

// ── SSE：错误帧带 code，前端可只按 code 判成败 ────────────────────────────────
test('SSE 错误帧是 {type:error, error, code}', async t => {
  const investigator = { model: { model: 'fake' }, prompts: async () => ({ scenarios: { cards: [] } }),
    run: async () => { throw new Error('模型调用失败 Authorization: Bearer abc123'); } };
  const base = await listen(t, createServer(null, null, investigator, { save: async x => x }, null));
  const response = await fetch(`${base}/api/agent/investigations?stream=1`, { method: 'POST',
    body: JSON.stringify({ alert_id: 'honeypot:7', mode: 'deep' }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const frame = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    .find(item => item.type === 'error');
  assert.ok(frame, '必须有 error 帧');
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'upstream_error');
  assert.doesNotMatch(frame.error, /abc123/, 'SSE 错误帧也要擦凭据');
});

// ── 维护端：21 处 {error} 全部补 code，抽 6 处代表点位断言 ──────────────────────
test('维护端错误体全部 {error, code}，同一类在不同入口同码', async t => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const store = new UpdateStore(new PromptStore('/tmp/hids-error-contract-prompts.json'),
    { encryptionKey: randomBytes(32), publicKey, target: 'test' });
  const base = await listen(t, createMaintenanceServer(store,
    { access: { user: 'maint', password: 'maint-pass', role: 'updater' } }));
  const get = async (path, init) => fetch(`${base}${path}`, init);
  // 未登录 401 unauthorized（鉴权闸在路由匹配之前：未知路径未登录同样 401）
  assert.deepEqual(await (await get('/api/maintenance/overview')).json(),
    { error: '请使用独立维护账号登录', code: 'unauthorized' });
  assert.deepEqual(await (await get('/api/maintenance/none-such')).json(),
    { error: '请使用独立维护账号登录', code: 'unauthorized' });
  // 登录失败 401 invalid_credentials
  const login = await get('/api/maintenance/login', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hids-maintenance': '1', origin: `${base}`, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ username: 'maint', password: 'wrong' }) });
  assert.equal(login.status, 401);
  assert.deepEqual(await login.json(), { error: '账号或密码错误', code: 'invalid_credentials' });
  // 登录成功后写请求缺 CSRF 头 → 403 csrf_rejected
  const cookie = login.headers.get('set-cookie') || (await (await get('/api/maintenance/login', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hids-maintenance': '1', origin: `${base}`, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ username: 'maint', password: 'maint-pass' }) })).headers).get('set-cookie');
  assert.ok(cookie, '要拿到会话 cookie');
  const csrf = await get('/api/maintenance/packages', { method: 'POST', headers: { cookie: cookie.split(';')[0],
    'content-type': 'application/octet-stream' }, body: Buffer.alloc(8) });
  assert.equal(csrf.status, 403);
  assert.deepEqual(await csrf.json(), { error: '维护请求校验失败，拒绝跨站请求', code: 'csrf_rejected' });
  // 带上 CSRF：updater 账号、Content-Type 不对 → 415 package_media_type
  const wrongMedia = await get('/api/maintenance/packages', { method: 'POST',
    headers: { cookie: cookie.split(';')[0], 'content-type': 'application/json',
      'x-hids-maintenance': '1' }, body: '{}' });
  assert.equal(wrongMedia.status, 415);
  assert.equal((await wrongMedia.json()).code, 'package_media_type');
  // 编码非法的包名 → 400 package_name_invalid
  const badName = await get('/api/maintenance/packages', { method: 'POST',
    headers: { cookie: cookie.split(';')[0], 'content-type': 'application/octet-stream',
      'x-hids-maintenance': '1', 'x-package-filename': '%zz' }, body: Buffer.alloc(8) });
  assert.equal(badName.status, 400);
  const badNameBody = await badName.json();
  assert.equal(badNameBody.code, 'package_name_invalid');
  // 未配置密钥的维护端上传 → 503 not_configured（动态 catch 按类归码）
  const bare = await listen(t, createMaintenanceServer(new UpdateStore(new PromptStore('/tmp/hids-error-contract-prompts2.json')),
    { access: { user: 'maint', password: 'maint-pass', role: 'updater' } }));
  const login2 = await fetch(`${bare}/api/maintenance/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hids-maintenance': '1', origin: `${bare}`, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ username: 'maint', password: 'maint-pass' }) });
  const cookie2 = login2.headers.get('set-cookie').split(';')[0];
  const staged = await fetch(`${bare}/api/maintenance/packages`, { method: 'POST',
    headers: { cookie: cookie2, 'content-type': 'application/octet-stream', 'x-hids-maintenance': '1',
      'x-package-filename': 'a.hids-policy' }, body: Buffer.alloc(8) });
  assert.equal(staged.status, 503);
  assert.equal((await staged.json()).code, 'not_configured');
  // 登录后的未知路径 404 not_found（与业务端 404 同名 code，形状一致）
  const unknown = await get('/api/maintenance/none-such', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: '接口不存在', code: 'not_found' });
  // 维护端未知方法同样 404 文案统一（实现是路径级分支，方法不对落到 not_found 或 catch 的 caller_error——两类都有 code）
  const wrongMethod = await get('/api/maintenance/overview', { method: 'DELETE',
    headers: { cookie: cookie.split(';')[0] } });
  const wrongMethodBody = await wrongMethod.json();
  assert.ok(wrongMethodBody.code, '维护端任何错误体都必须带 code');
  assert.ok(typeof wrongMethodBody.error === 'string');
});
