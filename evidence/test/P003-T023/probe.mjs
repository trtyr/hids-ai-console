// P003-T023 后端测试席探针（黑盒）：只按文档承诺的面造请求、只看被测进程的公开输出。
// 依据：docs/architecture.md §3.6「日志」事件名表 + §11.2/§11.3、docs/modules/http-api.md 路由表/错误码、
//       docs/modules/triage-pipeline.md（poll 模式与落盘习惯）、§8.1 运行态路径表。
// 不读实现文件内容；不碰外网（牧云/模型一律指向 127.0.0.1:1 或本机回环）。
//
// 跑法：node evidence/test/P003-T023/probe.mjs   （EXIT=0 全过；每条 FAIL 打印断言名）
// 段：S1 HTTP/错误码 · S2 牧云失败 · S3 syslog 全链 · S4 端口被占 · S5 log 契约 · S6 poll · S7 临时副本抛错 · S8 第二次落盘失败
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const BASIC_PASS = 'probe-pass-9f3k';
const BASIC_USER = 'operator';
const BASIC_B64 = Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64');
const CW_TOKEN = 'cw-live-token-PROBE-SECRET';
const LLM_KEY = 'llm-key-PROBE-SECRET';
const AUTH_HEADER = { Authorization: 'Basic ' + BASIC_B64 };
const CRED_HEADERS = { ...AUTH_HEADER, Cookie: 'sid=cookie-PROBE-SECRET', 'x-prompt-admin-token': 'admin-token-PROBE-SECRET' };

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (error) { failures.push({ name, error }); console.log('FAIL', name, '::', error.message); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (error) { failures.push({ name, error }); console.log('FAIL', name, '::', error.message); }
}
function ok(cond, message) { if (!cond) throw new Error(message); }
function eq(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'not equal'}: actual=${a} expected=${e}`);
}
function match(actual, re, message) {
  if (!re.test(String(actual))) throw new Error(`${message || 'no match'}: actual=${JSON.stringify(actual)} re=${re}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freeTcpPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

const children = new Set();
function startServer(env, cwd = ROOT) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  const state = { child, lines: [], badLines: [], raw: '', stderr: '', exit: null };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    state.raw += chunk;
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      try { state.lines.push(JSON.parse(line)); } catch { state.badLines.push(line); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { state.stderr += chunk; });
  child.on('exit', (code, signal) => { state.exit = { code, signal }; children.delete(child); });
  return state;
}
async function stopServer(state) {
  if (!state.child) return;
  state.child.kill('SIGKILL');
  for (let i = 0; i < 100 && state.exit === null; i++) await sleep(20);
}
function waitFor(state, predicate, ms, label) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = state.lines.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error(`等不到日志「${label}」（${ms}ms），已见事件=` +
        JSON.stringify(state.lines.map(line => line.event)) + ' stderr=' + JSON.stringify(state.stderr.slice(0, 300))));
      setTimeout(tick, 20);
    };
    tick();
  });
}
function eventsOf(state, name) { return state.lines.filter(line => line.event === name); }
// 哨兵等待：替代「固定 sleep 就当同步」，等条件成立（或超时报错），不是等固定毫秒。
async function waitUntil(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`等不到「${label}」（${ms}ms）`);
}

async function http(base, routePath, options = {}) {
  const response = await fetch(base + routePath, { ...options, signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: response.headers, body, text };
}

const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function assertLineShape(line) {
  ok(line && typeof line === 'object' && !Array.isArray(line), '日志行不是对象');
  eq(Object.keys(line).slice(0, 3), ['time', 'level', 'event'], `键顺序/保留键不对: ${JSON.stringify(line)}`);
  match(line.time, isoUtc, 'time 不是 ISO-8601 UTC');
  ok(['info', 'warn', 'error'].includes(line.level), `level 越界: ${line.level}`);
  ok(typeof line.event === 'string' && line.event.length > 0, 'event 为空');
}
function assertNoPlainText(state) {
  eq(state.badLines, [], 'stdout 里有非 JSON 行（不是一行一条 JSON）');
}

/* ================= S1：无牧云 + 开 Basic 认证（HTTP 面 / 错误码 / A4 / A1） ================= */
async function sectionS1() {
  console.log('\n== S1 无牧云、开 Basic 认证 ==');
  const port = await freeTcpPort();
  const state = startServer({
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_BASIC_AUTH_USER: BASIC_USER, HIDS_BASIC_AUTH_PASSWORD: BASIC_PASS,
    HIDS_PROMPT_ADMIN_TOKEN: 'admin-token-PROBE-SECRET'
  });
  const base = `http://127.0.0.1:${port}`;
  let started;
  try {
    started = await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
  } catch (error) {
    check('S1 server.started 出现', () => { throw error; });
    await stopServer(state); return;
  }
  check('S1 server.started 行形状（host/port/time/level）', () => {
    assertLineShape(started);
    eq(started.host, '127.0.0.1', 'host');
    eq(started.port, port, 'port');
    eq(started.level, 'info', 'level');
  });

  const root = await http(base, '/');
  check('S1 非 API 路径无认证 → 401 纯文本正文「需要登录后访问」', () => {
    eq(root.status, 401, 'status');
    match(root.headers.get('content-type'), /^text\/plain/, 'content-type');
    eq(root.body, '需要登录后访问', 'body');
  });
  const badAuth = await http(base, '/api/session', { headers: { Authorization: 'Basic ' + Buffer.from('operator:wrong').toString('base64') } });
  check('S1 Basic 密码错 → 401', () => eq(badAuth.status, 401, 'status'));
  const session = await http(base, '/api/session', { headers: CRED_HEADERS });
  check('S1 Basic 正确 → 200 JSON 对象', () => {
    eq(session.status, 200, 'status');
    ok(session.body && typeof session.body === 'object' && !Array.isArray(session.body), 'body 不是对象');
  });
  const queried = await http(base, '/api/session?token=query-PROBE-SECRET&x=1', { headers: CRED_HEADERS });
  check('S1 带 query 的请求仍 200', () => eq(queried.status, 200, 'status'));

  const alerts = await http(base, '/api/alerts', { headers: AUTH_HEADER });
  check('S1 未配牧云：GET /api/alerts → 503 {error}（docs/architecture.md §11.2）', () => {
    eq(alerts.status, 503, 'status');
    eq(typeof alerts.body.error, 'string', 'body.error');
    eq(alerts.body.error, '未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN', 'body.error 原文');
  });
  const triageStatus = await http(base, '/api/agent/triage/status', { headers: AUTH_HEADER });
  check('S1 无研判队列：GET /api/agent/triage/status → 503 {error:"自动研判尚未配置"}', () => {
    eq(triageStatus.status, 503, 'status');
    eq(triageStatus.body.error, '自动研判尚未配置', 'body.error');
  });
  const unknownApi = await http(base, '/api/nope', { headers: AUTH_HEADER });
  check('S1 未知 /api/ 路径 → 404 {error:"接口不存在"}', () => {
    eq(unknownApi.status, 404, 'status');
    eq(unknownApi.body.error, '接口不存在', 'body.error');
  });
  const wrongMethod = await http(base, '/api/session', { method: 'POST', headers: AUTH_HEADER });
  check('S1 方法对不上（POST /api/session）→ 404「接口不存在」', () => {
    eq(wrongMethod.status, 404, 'status');
    eq(wrongMethod.body.error, '接口不存在', 'body.error');
  });
  const prompts405 = await http(base, '/api/agent/prompts', { method: 'POST', headers: AUTH_HEADER });
  check('S1 POST /api/agent/prompts → 405 固定正文', () => {
    eq(prompts405.status, 405, 'status');
    eq(prompts405.body.error, '请使用提示词文件上传入口', 'body.error');
  });
  const upload410 = await http(base, '/api/agent/prompts/upload', { headers: AUTH_HEADER });
  check('S1 /api/agent/prompts/upload → 410 固定正文', () => {
    eq(upload410.status, 410, 'status');
    eq(upload410.body.error, '提示词更新已迁移到独立维护端，业务端不允许上传', 'body.error');
  });
  const fpNoMonitor = await http(base, '/api/agent/triage/honeypot:7/false-positive', {
    method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单', who: '值班分析员' })
  });
  check('S1 无研判队列：误报登记 → 503 {error}', () => {
    eq(fpNoMonitor.status, 503, 'status');
    ok(typeof fpNoMonitor.body.error === 'string', 'body.error');
  });
  // 超长路径（边界）：一行日志不炸、截断后行仍是合法 JSON
  const longPath = '/api/alerts/' + 'a'.repeat(1400);
  const longResponse = await http(base, longPath, { headers: AUTH_HEADER });
  check('S1 超长路径（1400 字）仍回 JSON 错误、日志一行合法', () => {
    ok([400, 404, 502, 503].includes(longResponse.status), `status 越界: ${longResponse.status}`);
    ok(longResponse.body && typeof longResponse.body.error === 'string', 'body.error 缺失');
  });

  await acheck('S1 各请求的 http.request 都到齐（哨兵等待 12 条，不靠固定 sleep）', async () => {
    await waitUntil(() => eventsOf(state, 'http.request').length >= 12, 5000, 'http.request × 12');
    eq(eventsOf(state, 'http.request').length, 12, 'http.request 条数');
  });
  const requests = eventsOf(state, 'http.request');
  check('S1 http.request 字段齐（method/path/status/duration_ms，类型对）', () => {
    for (const line of requests) {
      assertLineShape(line);
      match(line.method, /^(GET|POST)$/, 'method');
      ok(typeof line.path === 'string' && line.path.startsWith('/'), 'path');
      ok(Number.isInteger(line.status) && line.status >= 100 && line.status <= 599, 'status');
      ok(typeof line.duration_ms === 'number' && line.duration_ms >= 0, 'duration_ms');
    }
  });
  check('S1 query 不进日志：path 去 query，token 值零命中', () => {
    const hits = requests.filter(line => line.path.includes('?'));
    eq(hits, [], '有 path 带 query');
    ok(!state.raw.includes('query-PROBE-SECRET'), 'query 令牌泄漏到日志');
  });
  check('S1 401 有单独 http.unauthorized（method/path/status）', () => {
    const unauthorized = eventsOf(state, 'http.unauthorized');
    ok(unauthorized.length >= 2, `条数=${unauthorized.length}`);
    for (const line of unauthorized) {
      assertLineShape(line);
      eq(line.status, 401, 'status');
      ok(typeof line.path === 'string', 'path');
    }
  });
  check('S1 超长路径在日志里被截断（≤1001 字）', () => {
    const line = requests.find(item => item.path.length > 100);
    ok(line, '没找到长路径那条');
    ok(line.path.length <= 1001, `未截断：${line.path.length}`);
  });
  check('S1 stdout 只有 JSON 行，无自由文本（A1 单一落点）', () => assertNoPlainText(state));
  check('S1 旧启动文案「HIDS API:」不再输出（docs/modules/http-api.md:54 已过期，见报告 F1）', () => {
    ok(!state.raw.includes('HIDS API:'), '仍在打印旧文案');
  });
  check('A4 凭据零命中（Basic 口令 / Cookie / 管理令牌 / query 令牌）', () => {
    for (const secret of [BASIC_PASS, BASIC_B64, 'cookie-PROBE-SECRET', 'admin-token-PROBE-SECRET', 'query-PROBE-SECRET'])
      ok(!state.raw.includes(secret), `日志原文含 ${secret}`);
  });
  await stopServer(state);
}

/* ================= S2：牧云配了但连不上（502 / cloudwalker.call_failed / http.failed） ================= */
async function sectionS2() {
  console.log('\n== S2 牧云不可达（127.0.0.1:1） ==');
  const port = await freeTcpPort();
  const syslogPort = await freeUdpPort();
  const state = startServer({
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_BASIC_AUTH_USER: BASIC_USER, HIDS_BASIC_AUTH_PASSWORD: BASIC_PASS,
    HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
    CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: CW_TOKEN,
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: LLM_KEY, LLM_MODEL: 'probe-model'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
    await waitFor(state, line => line.event === 'syslog.listening', 10000, 'syslog.listening');
  } catch (error) {
    check('S2 server.started + syslog.listening', () => { throw error; });
    await stopServer(state); return;
  }

  const status = await http(base, '/api/status', { headers: AUTH_HEADER });
  check('S2 牧云配了但连不上：GET /api/status → 502 且正文仍是 {configured,connected,reason}（docs/modules/http-api.md:75）', () => {
    eq(status.status, 502, 'status');
    eq(status.body.configured, true, 'configured');
    eq(status.body.connected, false, 'connected');
    ok(typeof status.body.reason === 'string' && status.body.reason.length > 0, 'reason');
  });
  const alerts = await http(base, '/api/alerts', { headers: AUTH_HEADER });
  check('S2 GET /api/alerts 牧云失败 → 502 {error}', () => {
    eq(alerts.status, 502, 'status');
    ok(typeof alerts.body.error === 'string', 'body.error');
  });
  const alertOne = await http(base, '/api/alerts/honeypot:7', { headers: AUTH_HEADER });
  check('S2 GET /api/alerts/honeypot:7 牧云失败 → 502 {error}', () => {
    eq(alertOne.status, 502, 'status');
    ok(typeof alertOne.body.error === 'string', 'body.error');
  });
  const tools = await http(base, '/api/agent/tools', { headers: AUTH_HEADER });
  // docs/modules/http-api.md:76 只承诺「200 工具清单 / 无 API 工具箱回 503」；实测这条不打牧云网络。
  check('S2 工具列表路由状态在文档面内（200/502/503）', () => ok([200, 502, 503].includes(tools.status), `status=${tools.status}`));

  await acheck('S2 三条牧云失败与 http.failed 都到齐（哨兵等待，不靠固定 sleep）', async () => {
    await waitUntil(() => {
      const ops = eventsOf(state, 'cloudwalker.call_failed').map(line => line.op);
      return ['status', 'alerts', 'alert'].every(op => ops.includes(op)) && eventsOf(state, 'http.failed').length >= 2;
    }, 5000, 'cloudwalker.call_failed × 3 与 http.failed × 2');
  });
  check('S2 每条 502 都有 cloudwalker.call_failed（op/alert_id/error）', () => {
    const failures = eventsOf(state, 'cloudwalker.call_failed');
    const ops = failures.map(line => line.op);
    for (const op of ['status', 'alerts', 'alert']) ok(ops.includes(op), `缺 op=${op}，实有=${JSON.stringify(ops)}`);
    ok(!ops.includes('tools'), 'op=tools 出现（本轮预期这条路由不打牧云网络）');
    for (const line of failures) {
      assertLineShape(line);
      eq(line.level, 'error', 'level');
      eq(typeof line.error, 'string', 'error');
      ok(Object.hasOwn(line, 'alert_id'), '缺 alert_id 键');
    }
    const alertFailure = failures.find(line => line.op === 'alert');
    eq(alertFailure.alert_id, 'honeypot:7', 'op=alert 的 alert_id');
  });
  // /api/status 的 502 是文档写明的自身分支（正文 {configured,connected,reason}），不是外层兜底；其余失败落 http.failed。
  check('S2 路由没接住的失败另有 http.failed（method/path/status/error）', () => {
    const failures = eventsOf(state, 'http.failed');
    ok(failures.length >= 2, `条数=${failures.length}`);
    for (const line of failures) {
      assertLineShape(line);
      eq(line.status, 502, 'status');
      eq(line.method, 'GET', 'method');
      ok(typeof line.path === 'string' && typeof line.error === 'string', 'path/error');
    }
    for (const expected of ['/api/alerts', '/api/alerts/honeypot:7'])
      ok(failures.some(line => line.path === expected), `没有 ${expected} 那条`);
    ok(!failures.some(line => line.path === '/api/status'), '/api/status 的 502 不该走外层兜底');
  });
  check('S2 凭据不进日志（环境里的 CLOUDWALKER_API_TOKEN / LLM_API_KEY）', () => {
    for (const secret of [CW_TOKEN, LLM_KEY, BASIC_PASS]) ok(!state.raw.includes(secret), `日志原文含 ${secret}`);
  });
  check('S2 stdout 只有 JSON 行', () => assertNoPlainText(state));
  await stopServer(state);
}

/* ================= S3：syslog 真 UDP → 研判 → 误报维护（A2 全链） ================= */
function sendUdp(port, text) {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(text), port, '127.0.0.1', error => {
      socket.close();
      if (error) reject(error); else resolve();
    });
  });
}

async function sectionS3() {
  console.log('\n== S3 syslog UDP → 研判 → 误报维护 ==');
  const port = await freeTcpPort();
  const syslogPort = await freeUdpPort();
  const state = startServer({
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_BASIC_AUTH_USER: BASIC_USER, HIDS_BASIC_AUTH_PASSWORD: BASIC_PASS,
    HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
    CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: CW_TOKEN,
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: LLM_KEY, LLM_MODEL: 'probe-model'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
    await waitFor(state, line => line.event === 'syslog.listening', 10000, 'syslog.listening');
  } catch (error) {
    check('S3 启动两行', () => { throw error; });
    await stopServer(state); return;
  }
  const listening = eventsOf(state, 'syslog.listening').at(-1);
  check('S3 syslog.listening 带 bind=udp://host:port', () => {
    assertLineShape(listening);
    eq(listening.bind, `udp://127.0.0.1:${syslogPort}`, 'bind');
  });

  // 1) 垃圾报文 → syslog.parse_failed（error + bytes）
  await sendUdp(syslogPort, 'not a syslog line');
  let parseFailed;
  try { parseFailed = await waitFor(state, line => line.event === 'syslog.parse_failed', 5000, 'syslog.parse_failed'); }
  catch (error) { check('S3 解析失败留痕', () => { throw error; }); }
  check('S3 syslog.parse_failed 字段齐（error/bytes）', () => {
    assertLineShape(parseFailed);
    match(parseFailed.error, /RFC5424/, 'error 文案');
    ok(Number.isInteger(parseFailed.bytes) && parseFailed.bytes > 0, 'bytes');
  });

  // 2) 合法报文 → syslog.received（alert_id 形态）+ triage.enqueued → triage.done|failed
  // 去重表是跨进程持久的（.data/triage-monitor.json），报文用一次性随机指纹，避免撞上历史记录。
  const rnd = len => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const eventId = String(Date.now()).slice(-8) + rnd(4);
  const hostIp = `10.${parseInt(rnd(2), 16)}.${parseInt(rnd(2), 16)}.${parseInt(rnd(2), 16)}`;
  const sourceIp = `192.0.2.${1 + Math.floor(Math.random() * 250)}`;
  const eventTime = `2026-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')} ${String(Math.floor(Math.random() * 24)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`;
  const line = '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot ' +
    `event_id=${eventId} host_ip=${hostIp} source_ip=${sourceIp} event_create_time="${eventTime}"`;
  await sendUdp(syslogPort, line);
  const received = await waitFor(state, item => item.event === 'syslog.received', 5000, 'syslog.received');
  const alertId = received.alert_id;
  check('S3 syslog.received 带 alert_id 形态 syslog:<type>:<16hex>:<sec>:<uuid> 与 msgid/event_type/occurrence', () => {
    assertLineShape(received);
    match(alertId, /^syslog:[a-z_]+:[0-9a-f]{16}:\d+:[0-9a-f-]{36}$/, 'alert_id 形态');
    eq(received.msgid, 'cloudwalker-honeypot', 'msgid');
    eq(typeof received.event_type, 'string', 'event_type');
    ok(Number.isInteger(received.occurrence), 'occurrence');
  });
  const matchFailure = await waitFor(state, item => item.event === 'cloudwalker.call_failed' && /^(call_tool|list_events)$/.test(item.op), 15000, 'cloudwalker.call_failed(call_tool)');
  check('A2 syslog 匹配时的牧云取数失败落 cloudwalker.call_failed（op=call_tool/list_events）', () => {
    assertLineShape(matchFailure);
    eq(matchFailure.level, 'error', 'level');
    match(matchFailure.op, /^(call_tool|list_events)$/, 'op');
    eq(typeof matchFailure.error, 'string', 'error');
    ok(Object.hasOwn(matchFailure, 'alert_id'), '缺 alert_id 键');
  });
  const settled = await waitFor(state, item => (item.event === 'triage.done' || item.event === 'triage.failed') && item.alert_id === alertId, 25000, 'triage.done|failed');
  check('S3 研判收尾留痕（triage.done 带 verdict/attempts/duration_ms，或 triage.failed 带 attempts/error）', () => {
    assertLineShape(settled);
    eq(settled.alert_id, alertId, 'alert_id');
    ok(Number.isInteger(settled.attempts), 'attempts');
    if (settled.event === 'triage.done') {
      ok(typeof settled.verdict === 'string', 'verdict');
      ok(typeof settled.duration_ms === 'number', 'duration_ms');
    } else ok(typeof settled.error === 'string', 'error');
  });

  // 3) 重复投递同一报文 → syslog.collapsed（alert_id + repeat_count）
  await sendUdp(syslogPort, line);
  let collapsed;
  try { collapsed = await waitFor(state, item => item.event === 'syslog.collapsed', 8000, 'syslog.collapsed'); }
  catch (error) { check('S3 重复投递合并留痕', () => { throw error; }); }
  check('S3 syslog.collapsed 带 alert_id 与 repeat_count', () => {
    assertLineShape(collapsed);
    eq(collapsed.alert_id, alertId, 'alert_id');
    ok(Number.isInteger(collapsed.repeat_count) && collapsed.repeat_count >= 1, 'repeat_count');
  });

  // 4) 无对应事件类型 → syslog.skipped(reason=no_agent_for_msgid)
  await sendUdp(syslogPort, '<134>1 2026-11-03T08:00:20Z host app 1 cloudwalker-unknown-msgid host_ip="10.0.0.5"');
  const skipped = await waitFor(state, item => item.event === 'syslog.skipped', 5000, 'syslog.skipped');
  check('S3 syslog.skipped 带 reason=no_agent_for_msgid', () => {
    assertLineShape(skipped);
    eq(skipped.reason, 'no_agent_for_msgid', 'reason');
  });

  // 4.5) 研判入队事件：syslog 直达执行不发 triage.enqueued（见报告 F3）；手动重排发 triage.enqueued
  check('S3 记录：syslog 收包直达执行时不见 triage.enqueued（事件表「何时写」与实测的差，报告 F3）', () => {
    ok(!eventsOf(state, 'triage.enqueued').some(item => item.alert_id === alertId), '这条 syslog 告警意外有 triage.enqueued');
  });
  const retry = await http(base, `/api/agent/triage/${encodeURIComponent(alertId)}`, {
    method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: true })
  });
  check('S3 手动重排 → 202', () => eq(retry.status, 202, 'status'));
  let enqueued;
  try { enqueued = await waitFor(state, item => item.event === 'triage.enqueued' && item.alert_id === alertId, 10000, 'triage.enqueued'); }
  catch (error) { check('S3 triage.enqueued 留痕（手动重排）', () => { throw error; }); }
  check('S3 triage.enqueued 带 alert_id 与 source（manual/retry/poll）', () => {
    assertLineShape(enqueued);
    eq(enqueued.alert_id, alertId, 'alert_id');
    match(enqueued.source, /^(manual|retry|poll)$/, 'source');
  });
  await waitFor(state, item => (item.event === 'triage.done' || item.event === 'triage.failed') && item.alert_id === alertId && item !== settled, 25000, '重排后收尾');

  // 5) 误报维护：400（理由太短）/ 404（无此案件）/ 202 + maintenance.result
  const postFp = (id, payload) => http(base, `/api/agent/triage/${encodeURIComponent(id)}/false-positive`, {
    method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const tooShort = await postFp(alertId, { reason: '太短', who: '值班分析员' });
  check('S3 误报理由短于 10 字 → 400 {error}', () => {
    eq(tooShort.status, 400, 'status');
    ok(typeof tooShort.body.error === 'string', 'body.error');
  });
  const noRecord = await postFp('honeypot:999999', { reason: '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单', who: '值班分析员' });
  check('S3 没有这条研判记录 → 404 {error}', () => {
    eq(noRecord.status, 404, 'status');
    ok(typeof noRecord.body.error === 'string', 'body.error');
  });
  const accepted = await postFp(alertId, { reason: '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单', who: '值班分析员' });
  check('S3 误报登记 → 202 {alert_id, verdict, feedback, maintenance}', () => {
    eq(accepted.status, 202, 'status');
    eq(accepted.body.alert_id, alertId, 'alert_id');
    const verdictValue = accepted.body.verdict;
    eq(typeof verdictValue === 'string' ? verdictValue : verdictValue && verdictValue.verdict, 'false_positive', 'verdict');
    ok(accepted.body.feedback && typeof accepted.body.feedback === 'object', 'feedback');
    ok(accepted.body.maintenance && typeof accepted.body.maintenance === 'object', 'maintenance');
  });
  let maintenance;
  try { maintenance = await waitFor(state, item => item.event === 'maintenance.result' && item.alert_id === alertId, 30000, 'maintenance.result'); }
  catch (error) { check('S3 维护收尾留痕 maintenance.result', () => { throw error; }); }
  check('S3 maintenance.result 带 alert_id/status/rule/wiki，两侧原因都在（词表 updating|updated|failed）', () => {
    assertLineShape(maintenance);
    eq(maintenance.alert_id, alertId, 'alert_id');
    match(maintenance.status, /^(updating|updated|failed)$/, 'status');
    match(maintenance.rule, /^(updating|updated|failed)$/, 'rule');
    match(maintenance.wiki, /^(updating|updated|failed)$/, 'wiki');
    ok('rule_error' in maintenance || 'wiki_error' in maintenance, '两侧原因键都缺');
    for (const key of ['rule_error', 'wiki_error'])
      if (maintenance[key] !== null && maintenance[key] !== undefined) ok(typeof maintenance[key] === 'string', `${key} 类型`);
  });
  const record = await http(base, `/api/agent/triage/${encodeURIComponent(alertId)}`, { headers: AUTH_HEADER });
  check('S3 GET 研判记录 → 200，verdict=false_positive、decision_source=human', () => {
    eq(record.status, 200, 'status');
    eq(record.body.verdict, 'false_positive', 'verdict');
    eq(record.body.decision_source, 'human', 'decision_source');
  });
  // 6) 手动入队一条真实牧云告警（牧云不可达）→ triage.enqueued(source=manual) → triage.failed
  const manualId = `honeypot:${100000 + Math.floor(Math.random() * 8000000)}`; // 一次性 ID：.data 里的旧记录会让 source 变 retry
  const manual = await http(base, `/api/agent/triage/${encodeURIComponent(manualId)}`, {
    method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  check('S3 手动入队新告警 → 202', () => eq(manual.status, 202, 'status'));
  let manualEnqueued;
  try { manualEnqueued = await waitFor(state, item => item.event === 'triage.enqueued' && item.alert_id === manualId, 10000, 'triage.enqueued(manual)'); }
  catch (error) { check('S3 triage.enqueued(source=manual) 留痕', () => { throw error; }); }
  check('S3 triage.enqueued source=manual', () => {
    assertLineShape(manualEnqueued);
    eq(manualEnqueued.source, 'manual', 'source');
  });
  let manualFailed;
  try { manualFailed = await waitFor(state, item => item.event === 'triage.failed' && item.alert_id === manualId, 30000, 'triage.failed'); }
  catch (error) { check('S3 triage.failed 留痕（牧云不可达）', () => { throw error; }); }
  check('S3 triage.failed 带 alert_id/attempts/error', () => {
    assertLineShape(manualFailed);
    eq(manualFailed.level, 'error', 'level');
    eq(manualFailed.alert_id, manualId, 'alert_id');
    ok(Number.isInteger(manualFailed.attempts) && manualFailed.attempts >= 1, 'attempts');
    eq(typeof manualFailed.error, 'string', 'error');
  });
  check('S3 凭据不进日志（A4）', () => {
    for (const secret of [CW_TOKEN, LLM_KEY, BASIC_PASS, BASIC_B64]) ok(!state.raw.includes(secret), `日志原文含 ${secret}`);
  });
  check('S3 stdout 只有 JSON 行', () => assertNoPlainText(state));
  await stopServer(state);
}

/* ================= S4：syslog 端口被占 → server.start_failed / syslog.bind_failed ================= */
async function sectionS4() {
  console.log('\n== S4 syslog 端口被占 ==');
  const blocker = dgram.createSocket('udp4');
  await new Promise(resolve => blocker.bind(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  const port = await freeTcpPort();
  const state = startServer({
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(occupied),
    CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: CW_TOKEN,
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: LLM_KEY, LLM_MODEL: 'probe-model'
  });
  try {
    await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
    const failed = await waitFor(state, line => line.event === 'syslog.bind_failed', 10000, 'syslog.bind_failed');
    const receiverError = await waitFor(state, line => line.event === 'syslog.receiver_error', 10000, 'syslog.receiver_error');
    check('S4 端口被占 → syslog.bind_failed（error 含 EADDRINUSE），行形状合规', () => {
      assertLineShape(failed);
      eq(failed.level, 'error', 'level');
      match(failed.error, /EADDRINUSE/, 'error');
    });
    check('S4 同一 socket 错误另落 syslog.receiver_error（level=error，error 含 EADDRINUSE，docs/architecture.md:115）', () => {
      assertLineShape(receiverError);
      eq(receiverError.level, 'error', 'level');
      match(receiverError.error, /EADDRINUSE/, 'error');
      ok(eventsOf(state, 'server.start_failed').length === 0, '端口被占不该再落 server.start_failed');
    });
    const alive = await http(`http://127.0.0.1:${port}`, '/api/session', { headers: AUTH_HEADER });
    check('S4 syslog 绑定失败不影响 HTTP 面（仍 200）', () => eq(alive.status, 200, 'status'));
  } catch (error) {
    check('S4 绑定失败留痕', () => { throw error; });
  } finally {
    await stopServer(state);
    await new Promise(resolve => blocker.close(resolve));
  }
}

/* ================= S5：log.js 公开 API 边界（文档 §3.6 的对外契约） ================= */
async function sectionS5() {
  console.log('\n== S5 log.js 公开契约边界 ==');
  const journalModule = await import(path.join(ROOT, 'log.js'));
  const { createJournal } = journalModule;
  const write = (...args) => journalModule.log(...args); // 可变导出走命名空间活绑定
  const use = next => journalModule.useJournal(next);
  const raw = [];
  const lines = [];
  let sink = null;
  const install = (now = () => '2026-11-19T00:00:00.000Z') => {
    sink = { lines: [] };
    raw.length = 0;
    lines.length = 0;
    use(createJournal({ now, write: line => { raw.push(line); lines.push(JSON.parse(line)); sink.lines.push(JSON.parse(line)); } }));
  };
  install();
  write('boundary.one');
  write('boundary.two', null);
  write('boundary.three', 'just-a-string');
  write('boundary.four', ['a', 'b']);
  write('boundary.five', {}, 'warn');
  const circular = { name: 'a' }; circular.self = circular;
  let circularThrew = false;
  try { write('boundary.circular', circular); } catch { circularThrew = true; }
  const circularLine = lines.find(item => item.event === 'boundary.circular');
  const circularSerialized = lines.filter(item => item.event === 'log.serialize_failed').length;
  const getter = { get boom() { throw new Error('getter 炸了'); } };
  let getterThrew = false;
  try { write('boundary.getter', getter); } catch { getterThrew = true; }
  const hostileWriter = createJournal({ write: () => { throw new Error('EPIPE'); } });
  use(hostileWriter);
  let writerThrew = false;
  try { write('boundary.writer', { a: 1 }); } catch { writerThrew = true; }

  check('S5 每条日志一行 JSON（无字段 / null / 字符串 / 数组 / 空对象 都不炸）', () => {
    const simple = lines.filter(item => /^boundary\.(one|two|three|four|five)$/.test(item.event));
    eq(simple.length, 5, '五条基础事件行数');
    for (const item of simple) { assertLineShape(item); eq(raw[lines.indexOf(item)].split('\n').length, 2, '一条日志恰好一行（末尾一个换行）'); }
    const base = { time: '2026-11-19T00:00:00.000Z', level: 'info' };
    eq(simple[0], { ...base, event: 'boundary.one' }, '无字段行');
    eq(simple[1], { ...base, event: 'boundary.two' }, 'null 字段行');
    eq(simple[2], { ...base, event: 'boundary.three' }, '字符串字段行');
    eq(simple[3], { ...base, event: 'boundary.four' }, '数组字段行');
  });
  check('S5 循环引用 / getter 抛错不抛给业务（getter 落 log.serialize_failed）', () => {
    eq(circularThrew, false, '循环引用把异常抛了');
    eq(getterThrew, false, 'getter 把异常抛了');
    const serializeFailures = lines.filter(line => line.event === 'log.serialize_failed');
    ok(serializeFailures.length >= 1, '没有 log.serialize_failed');
    for (const line of serializeFailures) eq(line.level, 'error', 'serialize_failed 的 level');
  });
  check('S5 循环引用实测：正常落一条（深度截断 [depth]），不落 log.serialize_failed（docs/architecture.md:96 的说法 → 报告 F2）', () => {
    ok(circularLine, '循环引用那条根本没落');
    eq(circularSerialized, 0, `循环引用落了 ${circularSerialized} 条 serialize_failed`);
    ok(/\[depth\]/.test(JSON.stringify(circularLine)) || typeof circularLine.self === 'string', '深度没截断');
  });
  check('S5 写入器抛错（管道断）不抛给业务', () => eq(writerThrew, false, '写入器异常被上抛'));

  // A4 脱敏矩阵
  install();
  write('a4.matrix', {
    authorization: 'Basic dXNlcjpwYXNz', Authorization: 'Bearer abc',
    Cookie: 'session=abc123', 'x-prompt-admin-token': 'tok-live-001',
    api_token: 'cw-secret', api_key: 'k-1', password: 'p@ss', secret: 's-1',
    nested: { deeper: { api_key: 'k-2' } }, list: [{ secret: 's-2' }],
    plain: 'ok', error: '请求头 Authorization: Basic dXNlcjpwYXNz 被拒绝；Bearer eyJhbGciOiJIUzI1NiJ9 过期',
    url: '/api/alerts?token=cw-abc-123&count=20'
  });
  const line = lines.at(-1);
  check('A4 敏感键一律 [redacted]（含大写 Authorization / Cookie / 嵌套 / 数组）', () => {
    for (const key of ['authorization', 'Authorization', 'Cookie', 'x-prompt-admin-token', 'api_token', 'api_key', 'password', 'secret'])
      eq(line[key], '[redacted]', key);
    eq(line.nested.deeper.api_key, '[redacted]', 'nested.deeper.api_key');
    eq(line.list[0].secret, '[redacted]', 'list[0].secret');
    eq(line.plain, 'ok', 'plain');
  });
  check('A4 敏感值在原文里零命中（键名路径）', () => {
    for (const secret of ['dXNlcjpwYXNz', 'abc123', 'tok-live-001', 'cw-secret', 'k-1', 'k-2', 'p@ss', 's-1', 's-2'])
      ok(!raw.at(-1).includes(secret), `原文含 ${secret}`);
  });
  check('A4 字符串里的 Basic / Bearer / token= 被擦（docs/architecture.md §3.6）', () => {
    match(line.error, /Basic \[redacted\]/, 'Basic');
    match(line.error, /Bearer \[redacted\]/, 'Bearer');
    match(line.url, /token=\[redacted\]/, 'token=');
    for (const secret of ['dXNlcjpwYXNz', 'eyJhbGciOiJIUzI1NiJ9', 'cw-abc-123']) ok(!raw.at(-1).includes(secret), `原文含 ${secret}`);
  });

  // 保留键不可覆盖 + 时钟注入 + 超长截断 + 换行不破行
  install(() => '2026-11-19T03:04:05.000Z');
  write('reserved.test', { event: '假事件', time: '假时间', level: 'debug', method: 'GET' });
  write('long.test', { text: 'x'.repeat(5000) });
  write('newline.test', { text: '第一行\n第二行\r第三行' });
  write('enum.test', {}, 'debug');
  check('A3 保留键（event/time/level）不可被字段覆盖，时间来自注入时钟', () => {
    eq(lines.at(-4), { time: '2026-11-19T03:04:05.000Z', level: 'info', event: 'reserved.test', method: 'GET' }, 'reserved');
  });
  check('S5 超长字符串截断且单行（spec 未写截断长度 → 报告 F2）', () => {
    ok(lines.at(-3).text.length <= 1001, `长度=${lines.at(-3).text.length}`);
    const rawLine = raw.at(-3);
    eq(rawLine.split('\n').length, 2, '一条日志恰好一行');
  });
  check('A3 字符串里的换行被转义，日志不破行', () => {
    eq(raw.at(-2).split('\n').length, 2, '换行破了行');
    ok(!/\r/.test(raw.at(-2)), '回车没转义');
  });
  check('S5 level 越界（debug）时的行为记录（spec 只承诺 info|warn|error）', () => {
    ok(['debug', 'info'].includes(lines.at(-1).level), `level=${lines.at(-1).level}`);
  });
  use(createJournal({ write: () => {} }));
}

/* ================= S6：poll 模式（不等 30s 定时器：启动即跑第一轮） ================= */
async function sectionS6() {
  console.log('\n== S6 poll 输入模式（牧云不可达） ==');
  const port = await freeTcpPort();
  const state = startServer({
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_TRIAGE_INPUT_MODE: 'poll',
    CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: CW_TOKEN,
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: LLM_KEY, LLM_MODEL: 'probe-model'
  });
  try {
    await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
    const pollFailed = await waitFor(state, line => line.event === 'triage.poll_failed', 15000, 'triage.poll_failed');
    check('S6 轮询失败留痕 triage.poll_failed（error 非空，行形状合规）', () => {
      assertLineShape(pollFailed);
      eq(typeof pollFailed.error, 'string', 'error');
      ok(pollFailed.error.length > 0, 'error 为空');
    });
    check('S6 同一轮失败另有 cloudwalker.call_failed(op=alerts)', () => {
      const ops = eventsOf(state, 'cloudwalker.call_failed').map(line => line.op);
      ok(ops.includes('alerts'), `op=${JSON.stringify(ops)}`);
    });
  } catch (error) {
    check('S6 poll 模式启动并留下轮询失败', () => { throw error; });
  } finally {
    await stopServer(state);
  }
}

/* ================= S7：临时副本里造「会抛错」的两条路径 =================
   状态目录不可写（accept_failed / handler_failed / 入队 5xx）与状态文件损坏（start_failed）。
   把源码拷进 tmpdir 在副本里跑真进程：仓内 .data 的权限与内容一个字都不动。 */
async function sectionS7() {
  console.log('\n== S7 临时副本：状态目录不可写 / 状态文件损坏 ==');
  const repo = await mkdtemp(path.join(tmpdir(), 'p023-probe-'));
  const root = path.join(repo, 'repo');
  const keep = src => {
    const rel = path.relative(ROOT, src);
    return rel === '' || !['.git', '.data', 'evidence'].includes(rel.split(path.sep)[0]);
  };
  cpSync(ROOT, root, { recursive: true, filter: keep });
  const dataDir = path.join(root, '.data');
  await mkdir(dataDir, { recursive: true });
  const port = await freeTcpPort();
  const syslogPort = await freeUdpPort();
  const env = {
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
    CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: CW_TOKEN,
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: LLM_KEY, LLM_MODEL: 'probe-model'
  };
  await chmod(dataDir, 0o555);
  const state = startServer(env, root);
  try {
    await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
    await waitFor(state, line => line.event === 'syslog.listening', 10000, 'syslog.listening');
    await sendUdp(syslogPort, '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot ' +
      'event_id=probe-unwritable-1 host_ip=10.9.8.7 source_ip=192.0.2.66 event_create_time="2026-11-03 09:00:00"');
    const acceptFailed = await waitFor(state, line => line.event === 'syslog.accept_failed', 10000, 'syslog.accept_failed');
    check('S7 状态目录不可写 → syslog.accept_failed（error 非空，行形状合规）', () => {
      assertLineShape(acceptFailed);
      eq(acceptFailed.level, 'error', 'level');
      ok(typeof acceptFailed.error === 'string' && acceptFailed.error.length > 0, 'error');
    });
    const handlerFailed = await waitFor(state, line => line.event === 'syslog.handler_failed', 10000, 'syslog.handler_failed');
    check('S7 同一抛错在收包回调兜底再落一条 syslog.handler_failed（error 非空）', () => {
      assertLineShape(handlerFailed);
      eq(handlerFailed.level, 'error', 'level');
      ok(typeof handlerFailed.error === 'string' && handlerFailed.error.length > 0, 'error');
    });
    const randomId = `honeypot:${100000 + Math.floor(Math.random() * 8000000)}`;
    const manual = await http(`http://127.0.0.1:${port}`, `/api/agent/triage/${encodeURIComponent(randomId)}`, {
      method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    check('S7 状态目录不可写时手动入队不得回 2xx（实测 502 {error}；文档只写 202/503，见报告 F5）', () => {
      ok(manual.status >= 500 && manual.status <= 599, `status=${manual.status}`);
      ok(manual.body && typeof manual.body.error === 'string' && manual.body.error.length > 0, 'body.error');
    });
    check('S7 该失败另有 http.failed（method/path/status/error）', () => {
      const failed = eventsOf(state, 'http.failed').find(line => line.path.includes(encodeURIComponent(randomId)));
      ok(failed, `没有该路径的 http.failed：${JSON.stringify(eventsOf(state, 'http.failed').map(l => l.path))}`);
      assertLineShape(failed);
      eq(failed.method, 'POST', 'method');
      ok(failed.status >= 500 && failed.status <= 599, `status=${failed.status}`);
      ok(typeof failed.error === 'string', 'error');
    });
    await stopServer(state);
  } catch (error) {
    check('S7 状态目录不可写路径留痕', () => { throw error; });
    await stopServer(state);
  }
  // 状态文件损坏 → server.start_failed（what / error）
  const port2 = await freeTcpPort();
  try {
    await chmod(dataDir, 0o700);
    await writeFile(path.join(dataDir, 'triage-monitor.json'), 'not-json{');
    const state2 = startServer({ ...env, HIDS_PORT: String(port2), HIDS_SYSLOG_PORT: '0' }, root);
    try {
      const startFailed = await waitFor(state2, line => line.event === 'server.start_failed', 15000, 'server.start_failed');
      check('S7 状态文件损坏 → server.start_failed（level=error，带 what / error）', () => {
        assertLineShape(startFailed);
        eq(startFailed.level, 'error', 'level');
        ok(typeof startFailed.what === 'string' && startFailed.what.length > 0, 'what');
        ok(typeof startFailed.error === 'string' && startFailed.error.length > 0, 'error');
      });
    } finally {
      await stopServer(state2);
    }
  } catch (error) {
    check('S7 状态文件损坏路径留痕', () => { throw error; });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/* ================= S8：第二次状态落盘失败 → triage.persist_failed =================
   做法：临时副本 + 牧云替身。替身把第一条 /rpc 扣住不回（研判停在匹配调用上），
   这之前 syslog 收包已经把记录落过一次盘（第一次落盘成功）；此时把 .data 置 0555，
   再放行替身回 500 → 研判收尾的第二次落盘失败，落 triage.persist_failed。
   仓内 .data 一个字不动（副本在 tmpdir，跑完删）。 */
async function sectionS8() {
  console.log('\n== S8 临时副本：第二次状态落盘失败（triage.persist_failed） ==');
  const repo = await mkdtemp(path.join(tmpdir(), 'p023-persist-'));
  const root = path.join(repo, 'repo');
  const keep = src => {
    const rel = path.relative(ROOT, src);
    return rel === '' || !['.git', '.data', 'evidence'].includes(rel.split(path.sep)[0]);
  };
  cpSync(ROOT, root, { recursive: true, filter: keep });
  const dataDir = path.join(root, '.data');
  await mkdir(dataDir, { recursive: true });
  await chmod(dataDir, 0o700);

  // 牧云替身：第一条 /rpc 扣住（研判停住），放行后回 500；后续请求直接 500。
  let heldResponse = null;
  let releaseRpc;
  const rpcHit = new Promise(resolve => { releaseRpc = resolve; });
  const stub = createHttpServer((request, response) => {
    if (request.url.startsWith('/rpc') && heldResponse === null) {
      heldResponse = response;
      releaseRpc(request.url);
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":"probe stub"}');
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;

  const port = await freeTcpPort();
  const syslogPort = await freeUdpPort();
  const state = startServer({
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
    CLOUDWALKER_URL: `http://127.0.0.1:${stubPort}`, CLOUDWALKER_API_TOKEN: CW_TOKEN,
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: LLM_KEY, LLM_MODEL: 'probe-model'
  }, root);
  try {
    await waitFor(state, line => line.event === 'server.started', 15000, 'server.started');
    await waitFor(state, line => line.event === 'syslog.listening', 10000, 'syslog.listening');
    const rnd = len => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const eventId = String(Date.now()).slice(-8) + rnd(4);
    await sendUdp(syslogPort, '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot ' +
      `event_id=${eventId} host_ip=10.7.7.7 source_ip=192.0.2.44 event_create_time="2026-11-03 09:00:00"`);
    const received = await waitFor(state, line => line.event === 'syslog.received', 5000, 'syslog.received');
    const hitUrl = await Promise.race([
      rpcHit,
      sleep(10000).then(() => { throw new Error('牧云替身没收到 /rpc；已见事件=' + JSON.stringify(state.lines.map(line => line.event))); })
    ]);
    check('S8 前置：收包后第一次落盘已成功、研判停在匹配调用上（替身扣住 /rpc）', () => {
      match(hitUrl, /method=/, 'rpc url');
      eq(eventsOf(state, 'triage.persist_failed'), [], '第一次落盘就失败了');
      eq(eventsOf(state, 'syslog.accept_failed'), [], '收包链已抛错（不是「第二次」落盘）');
    });

    await chmod(dataDir, 0o555);            // 第二次落盘前把状态目录置只读
    heldResponse.writeHead(500, { 'content-type': 'application/json' });
    heldResponse.end('{"error":"probe stub"}');
    heldResponse = 'released';

    const persistFailed = await waitFor(state, line => line.event === 'triage.persist_failed' && line.alert_id === received.alert_id, 20000, 'triage.persist_failed');
    check('S8 第二次状态落盘失败 → triage.persist_failed（level=error，alert_id 对得上，error 含 EACCES，docs/architecture.md:118）', () => {
      assertLineShape(persistFailed);
      eq(persistFailed.level, 'error', 'level');
      eq(persistFailed.alert_id, received.alert_id, 'alert_id');
      match(persistFailed.error, /EACCES/, 'error');
    });
    check('S8 所有 persist_failed 行形状一致（level=error、error 非空；带 file 的必须指向 triage-monitor.json）', () => {
      const all = eventsOf(state, 'triage.persist_failed');
      ok(all.length >= 1, '一条都没有');
      for (const line of all) {
        assertLineShape(line);
        eq(line.level, 'error', 'level');
        ok(typeof line.error === 'string' && line.error.length > 0, 'error');
        if ('file' in line) match(line.file, /triage-monitor\.json$/, 'file');
      }
    });
  } catch (error) {
    check('S8 第二次状态落盘失败留痕', () => { throw error; });
  } finally {
    await stopServer(state);
    await new Promise(resolve => stub.close(resolve));
    try { await chmod(dataDir, 0o700); } catch {}
    await rm(repo, { recursive: true, force: true });
  }
}

/* ================= main ================= */
const overall = Date.now();
try {
  await sectionS1();
  await sectionS2();
  await sectionS3();
  await sectionS4();
  await sectionS5();
  await sectionS6();
  await sectionS7();
  await sectionS8();
} catch (error) {
  failures.push({ name: '探针异常终止', error });
  console.log('FAIL 探针异常终止 ::', error && error.stack || error);
} finally {
  for (const child of children) child.kill('SIGKILL');
  await sleep(100);
}
console.log(`\n== 汇总：PASS ${pass} / FAIL ${failures.length} / ${Date.now() - overall}ms ==`);
for (const failure of failures) console.log('  FAIL:', failure.name, '::', failure.error.message);
process.exit(failures.length ? 1 : 0);
