// A1 · 401 全链（真进程 + 替身牧云）
//
// 验什么：配了 Basic 口令的真 server.js 进程，三种凭据的回法各不相同，且**被拒的请求不碰上游**。
//   1) 无凭据            → 401，四条头 + 纯文本正文（不是 JSON），上游零请求
//   2) 错口令 / 错用户名 → 401，同上，上游零请求
//   3) 正确凭据          → 200，正文是告警列表，上游真被调用
// 环境标注（A6）：真进程 + 替身牧云（不是真牧云）。
// 跑法：node evidence/test/P003-T032/probe-a1-401.mjs   （退出码 0 = 全过）
import assert from 'node:assert/strict';
import { checker, startStub, startApp, freePort, snapshotData, restoreData } from './harness.mjs';

const USER = 'ops';
const PASS = 'gate-pass-abcdef';
const { ok, bad, check, failures, done } = checker();
const snapshot = await snapshotData();
let stub, app;

const authHeader = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const rpcCount = async () => (await stub.log()).filter(entry => entry.kind === 'rpc').length;

// 401 的形状：docs/modules/http-api.md §4（四条头 + 纯文本正文）。
async function expectUnauthorized(label, headers) {
  const before = await rpcCount();
  const response = await fetch(`${app.base}/api/alerts`, { headers, signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  const after = await rpcCount();
  check(response.status === 401, `${label}：状态 401`, `实测 ${response.status}`);
  check(response.headers.get('www-authenticate') === 'Basic realm="HIDS AI Console", charset="UTF-8"',
    `${label}：WWW-Authenticate 原样`, JSON.stringify(response.headers.get('www-authenticate')));
  check(response.headers.get('content-type') === 'text/plain; charset=utf-8',
    `${label}：Content-Type 是纯文本`, String(response.headers.get('content-type')));
  check(response.headers.get('cache-control') === 'no-store', `${label}：Cache-Control: no-store`,
    String(response.headers.get('cache-control')));
  check(response.headers.get('x-content-type-options') === 'nosniff', `${label}：X-Content-Type-Options: nosniff`,
    String(response.headers.get('x-content-type-options')));
  check(body === '需要登录后访问', `${label}：正文是固定纯文本`, JSON.stringify(body));
  check(after === before, `${label}：上游零请求`, `rpc 调用 ${before} → ${after}`);
}

try {
  stub = await startStub();
  // 上游给一条真实形状的 malware 告警：正确凭据那次要能读到它，证明链路真的通到上游。
  await stub.ctl({ lists: { malware: [{ id: 1, event_id: 1, host_id: 4, level: 3, event_type: 'malware',
    event_name: '恶意文件', created_at: Math.floor(Date.now() / 1000),
    host_view: { host_id: 4, host_name: 'ubuntu', host_ip: '192.168.24.21' } }] } });

  app = await startApp({ stubUrl: stub.url, port: await freePort(),
    env: { HIDS_BASIC_AUTH_USER: USER, HIDS_BASIC_AUTH_PASSWORD: PASS } });
  ok('真进程起来了（配了 Basic 口令）', app.base);

  await expectUnauthorized('无凭据', {});
  await expectUnauthorized('错口令', { authorization: authHeader(USER, 'wrong-pass-000') });
  await expectUnauthorized('错用户名（口令对）', { authorization: authHeader('admin', PASS) });
  await expectUnauthorized('非 Basic 前缀', { authorization: `Bearer ${PASS}` });

  // 正确凭据：200 + 告警列表 + 上游真被调用。
  const before = await rpcCount();
  const response = await fetch(`${app.base}/api/alerts`, { headers: { authorization: authHeader(USER, PASS) },
    signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  const after = await rpcCount();
  check(response.status === 200, '正确凭据：状态 200', `实测 ${response.status}`);
  check(Array.isArray(body.alerts) && body.alerts.length === 1, '正确凭据：读到替身上游的那条告警',
    `alerts=${body.alerts?.length}`);
  check(body.alerts?.[0]?.id === 'malware:1', '正确凭据：告警 ID 是 malware:1', String(body.alerts?.[0]?.id));
  check(after > before, '正确凭据：上游真被调用', `rpc 调用 ${before} → ${after}`);
  // 同一进程里 /api/config 也过同一道闸：无凭据 401、有凭据 200，证明闸门在第一行而不是逐路由各写一套。
  const configAnon = await fetch(`${app.base}/api/config`, { signal: AbortSignal.timeout(5000) });
  const configAuth = await fetch(`${app.base}/api/config`, { headers: { authorization: authHeader(USER, PASS) },
    signal: AbortSignal.timeout(5000) });
  check(configAnon.status === 401 && configAuth.status === 200, '/api/config 同闸：无凭据 401 / 有凭据 200',
    `${configAnon.status}/${configAuth.status}`);
} catch (error) {
  bad('探针执行异常', String(error?.stack || error));
} finally {
  if (app) {
    for (const key of ['http.failed', 'server.start_failed']) {
      const events = app.events(key);
      if (events.length) bad(`进程日志出现 ${key}`, JSON.stringify(events).slice(0, 400));
    }
    await app.stop();
  }
  if (stub) await stub.stop();
  await restoreData(snapshot);
}

assert.ok(true);
process.stdout.write(`\nA1 结果：${done() ? 'ALL GREEN' : `FAILED ${failures.length} 项`}\n`);
process.exit(done() ? 0 : 1);
