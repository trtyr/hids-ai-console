// P003-T037 tester probe: 真进程 HTTP e2e —— TriageSummary schema / 400 / 404 / 429 / 503 / A8 探活缓存
// 起真 `node server.js`（假牧云 RPC + 假模型都只在本机），断言按 docs/modules/*.md 与 openapi.yaml
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

let pass = 0; const fails = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log('  ✔', label); }
  else { fails.push(label + (detail ? ' | ' + detail : '')); console.log('  ✖', label, detail); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
const info = (label, v) => console.log('   ·', label, JSON.stringify(v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const repo = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 't37-e2e-'));
const children = [];

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const freePort = async () => { const s = http.createServer(); const p = await listen(s); s.close(); return p; };

// --- 假牧云 RPC：只回答本卡需要的三类请求，并计数 ---
const rpcCalls = [];
// holdRpc=true 时把响应挂住（不答），用来稳定占住「在跑」名额测 429；
// 秒回时上游身份校验会判「MCP 服务不是牧云」，记录 10ms 内就 failed 退出配额，POST#2 就落进空窗 → 断言变竞态。
let holdRpc = false; const held = [];
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').searchParams.get('method') || '';
    rpcCalls.push(method);
    const send = () => {
      let result;
      if (method.endsWith('.GetEvent')) {
        const id = JSON.parse(body || '{}').params?.id ?? 1;
        result = { event: { id, event_id: id, host_id: 1, host_view: { host_id: 1, host_ip: '10.0.0.5' }, cmdline: 'id', uname: 'root' } };
      } else {
        result = { events: [], total: 0 };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    };
    if (holdRpc) { held.push(send); return; }
    send();
  });
});
const rpcPort = await listen(rpc);

// --- 假模型：故意慢，用来占住并发位测 429 ---
let llmDelayMs = 3000; const llmCalls = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    llmCalls.push(body.length);
    await sleep(llmDelayMs);
    const hasTools = /"tools"\s*:/.test(body);
    const content = hasTools
      ? JSON.stringify({ verdict: '存疑', summary: '需核查来源', claims: [], missing_data: [] })
      : JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
const llmPort = await listen(llm);

// --- 复制一棵可写运行树（运行态目录落在 moduleDirectory 下）---
await cp(repo, temp, { recursive: true, filter: (src) => !/[\\/](\.git|\.data|web|evidence|coding-reports|docs)$/.test(src.replace(repo, '')) });

const apiPort = await freePort();
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort),
  HIDS_TRIAGE_INPUT_MODE: 'poll',
  HIDS_TRIAGE_CONCURRENCY: '3', HIDS_TRIAGE_QUEUE_MAX: '1',
  HIDS_STATUS_TTL_MS: '400',
  CLOUDWALKER_URL: `http://127.0.0.1:${rpcPort}`, CLOUDWALKER_API_TOKEN: 'test-token',
  LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, LLM_API_KEY: 'sk-test', LLM_MODEL: 'fake-model',
};
const base = `http://127.0.0.1:${apiPort}`;
const srv = spawn(process.execPath, ['server.js'], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(srv);
let serverOut = '';
srv.stdout.on('data', d => { serverOut += d; });
srv.stderr.on('data', d => { serverOut += d; });
const waitUp = async () => {
  for (let i = 0; i < 200; i += 1) {
    try { const r = await fetch(base + '/api/config'); if (r.ok) return true; } catch {}
    await sleep(50);
  }
  return false;
};
const req = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

try {
  ok(await waitUp(), '真进程起得来（/api/config 200）', serverOut.slice(-400));

  console.log('== /api/config 口径 ==');
  {
    const r = await req('GET', '/api/config');
    eq(r.status, 200, '/api/config 200');
    eq(r.json.triage_input_mode, 'poll', 'triage_input_mode 反映 HIDS_TRIAGE_INPUT_MODE');
  }

  console.log('== TriageSummary schema（openapi required + P003-T037 新键）==');
  {
    const r = await req('GET', '/api/agent/triage/status');
    eq(r.status, 200, 'GET /api/agent/triage/status 200');
    const b = r.json || {};
    for (const k of ['initialized', 'enabled', 'input_mode', 'since', 'counts', 'verdict_counts', 'type_counts']) {
      ok(k in b, `required 键 ${k} 在`);
    }
    for (const k of ['backoff_ms', 'empty_polls', 'concurrency', 'queue_limit', 'dropped', 'last_poll_at', 'last_error', 'interval_ms']) {
      ok(k in b, `P003-T037 键 ${k} 在`);
    }
    eq(b.input_mode, 'poll', 'input_mode=poll');
    eq(b.concurrency, 3, 'concurrency 读 HIDS_TRIAGE_CONCURRENCY=3（文档：architecture.md:449 / triage-pipeline.md:542）');
    eq(b.queue_limit, 1, 'queue_limit 读 HIDS_TRIAGE_QUEUE_MAX=1');
    eq(b.dropped, 0, 'dropped 初始 0');
    ok(Number.isInteger(b.empty_polls) && b.empty_polls >= 0, 'empty_polls 是非负整数', String(b.empty_polls));
    const wantBackoff = Math.min(30000 * 2 ** b.empty_polls, 30000 * 16);
    ok(Number.isInteger(b.backoff_ms) && b.backoff_ms === wantBackoff, 'backoff_ms = min(interval×2^empty_polls, interval×16)', `actual=${b.backoff_ms} expected=${wantBackoff}`);
    eq(b.interval_ms, 30000, 'poll 模式带 interval_ms=30000');
    ok(b.last_poll_at === null || typeof b.last_poll_at === 'string', 'last_poll_at 是时刻或 null', String(b.last_poll_at));
    eq(b.since, null, '不带 since：since null');
    eq(Object.keys(b.counts).sort(), ['done', 'failed', 'queued', 'running'], 'counts 四键恒在');
    for (const [k, v] of Object.entries(b.counts)) ok(Number.isInteger(v) && v >= 0, `counts.${k} 非负整数`);
    eq(Object.keys(b.verdict_counts).sort(), ['false_positive', 'review', 'threat', 'uncertain'], 'verdict_counts 四键恒在');
    ok(b.type_counts && typeof b.type_counts === 'object', 'type_counts 是对象');
    ok(!('syslog' in b), 'poll 模式没有 syslog 键');
  }

  console.log('== §5.2 冷启动空轮口径（真进程重启后首轮间隔 2×interval）==');
  {
    let s = null;
    for (let i = 0; i < 100; i += 1) {
      s = (await req('GET', '/api/agent/triage/status')).json;
      if (s?.last_poll_at && s.empty_polls >= 1) break;
      await sleep(30);
    }
    eq(s?.empty_polls, 1, '冷启动轮计入空轮 empty_polls=1（docs/modules/triage-pipeline.md:384）');
    eq(s?.backoff_ms, 2 * s?.interval_ms, '重启后首轮真实轮询间隔 = 2×intervalMs（同上）');
    eq(s?.backoff_ms, 60000, 'interval_ms=30000 -> backoff_ms=60000');
  }

  console.log('== since 参数：合法归一、空值不筛、解析不了 400 ==');
  {
    const okSince = await req('GET', '/api/agent/triage/status?since=' + encodeURIComponent('2026-11-04T00:00:00Z'));
    eq(okSince.status, 200, 'since=RFC3339 -> 200');
    ok(okSince.json?.since?.startsWith('2026-11-04T00:00:00'), 'since 归一成 RFC3339', String(okSince.json?.since));
    const empty = await req('GET', '/api/agent/triage/status?since=');
    eq(empty.status, 200, 'since 空值 -> 200');
    eq(empty.json?.since, null, 'since 空值等于不带筛');
    const bad = await req('GET', '/api/agent/triage/status?since=abc');
    eq(bad.status, 400, 'since=abc -> 400');
    eq(bad.json, { error: '筛选起始时间无效：abc', code: 'caller_error' }, '400 正文 error+code 形状');
  }

  console.log('== 错误码边界：非法告警 ID / 不存在的 syslog 报文 / 分页参数 ==');
  {
    const bad = await req('POST', '/api/agent/triage/bogus');
    eq(bad.status, 400, 'POST 非法 ID -> 400');
    ok(bad.json?.error && bad.json?.code === 'caller_error', '400 正文 {error, code=caller_error}', JSON.stringify(bad.json));
    const ghost = await req('POST', '/api/agent/triage/syslog:webshell:0123456789abcdef:1700000000:00000000-0000-0000-0000-000000000000');
    eq(ghost.status, 404, 'syslog 前缀但没有原始报文 -> 404');
    ok(ghost.json?.error && ghost.json?.code === 'caller_error', '404 正文 {error, code=caller_error}', JSON.stringify(ghost.json));
    const page = await req('GET', '/api/agent/triage/cases?count=0');
    eq(page.status, 400, 'cases?count=0 -> 400');
    ok(/分页参数无效/.test(page.json?.error || ''), '分页参数无效文案', JSON.stringify(page.json));
  }

  console.log('== control 入参校验 ==');
  {
    const miss = await req('PUT', '/api/agent/triage/control', {});
    eq(miss.status, 400, 'control 缺 enabled -> 400');
    const notBool = await req('PUT', '/api/agent/triage/control', { enabled: 'yes' });
    eq(notBool.status, 400, 'control enabled 非布尔 -> 400');
    const off = await req('PUT', '/api/agent/triage/control', { enabled: false });
    eq(off.status, 200, 'control enabled=false -> 200');
    eq(off.json?.enabled, false, '返回更新后的状态');
    const on = await req('PUT', '/api/agent/triage/control', { enabled: true });
    eq(on.json?.enabled, true, 'control enabled=true 恢复');
  }

  console.log('== 队列上限 429（现网可观测的最大边界）==');
  {
    // 挂住上游响应：第一条研判一直占着在跑名额，POST#2 的判据才是确定的（不依赖毫秒级窗口）。
    holdRpc = true;
    const first = await req('POST', '/api/agent/triage/honeypot:1');
    eq(first.status, 202, '第一条 202');
    ok(first.json?.alert_id === 'honeypot:1' && ['queued', 'running'].includes(first.json?.status), '202 正文是 TriageCase', JSON.stringify(first.json));
    let running = false;
    for (let i = 0; i < 100; i += 1) {
      const s = await req('GET', '/api/agent/triage/honeypot:1');
      if (s.json?.status === 'running') { running = true; break; }
      await sleep(30);
    }
    ok(running, '第一条进入 running（模型慢）');
    const before = await req('GET', '/api/agent/triage/status');
    eq(before.json?.counts?.running, 1, 'POST#2 前「在跑」= 1（配额 1 已满）');
    const second = await req('POST', '/api/agent/triage/honeypot:2');
    eq(second.status, 429, '队列满时 POST 第二条 -> 429');
    ok(second.json?.error && typeof second.json?.code === 'string', '429 正文带 {error, code}', JSON.stringify(second.json));
    eq(second.json?.code, 'caller_error', '429 code=caller_error（openapi Error enum）');
    eq(second.json?.error, '研判队列已满（上限 1），稍后再试', '429 文案（triage-pipeline.md:472 / openapi.yaml:2198 口径）');
    info('429 body', second.json);
    const status = await req('GET', '/api/agent/triage/status');
    eq(status.json?.dropped, 1, 'summary().dropped 记 1');
    holdRpc = false; held.splice(0).forEach(fn => fn());
  }

  console.log('== A8 /api/status 探活缓存（HIDS_STATUS_TTL_MS=400）==');
  {
    const countStatus = () => rpcCalls.filter(m => m === 'RevshellEventService.GetEventList').length;
    const before = countStatus();
    const a = await req('GET', '/api/status');
    eq(a.status, 200, '/api/status 200');
    eq(a.json?.configured, true, 'configured=true');
    eq(a.json?.connected, true, 'connected=true');
    const afterFirst = countStatus();
    eq(afterFirst - before, 1, '首次探活发 1 次 RPC');
    await req('GET', '/api/status');
    eq(countStatus() - afterFirst, 0, 'TTL 窗口内第二次不再发 RPC');
    await sleep(500);
    await req('GET', '/api/status');
    eq(countStatus() - afterFirst, 1, 'TTL 过期后重新探活');
  }

  console.log('== A10 /api/alerts：同键请求 15 秒窗口内不再拉牧云 ==');
  {
    const countList = () => rpcCalls.filter(m => m.endsWith('GetEventList') || m.endsWith('.List')).length;
    const before = countList();
    const a1 = await req('GET', '/api/alerts?count=50');
    eq(a1.status, 200, '/api/alerts?count=50 -> 200');
    ok(Array.isArray(a1.json?.alerts), '返回 alerts 数组');
    ok(Number.isInteger(a1.json?.total), '返回整数 total', String(a1.json?.total));
    const after1 = countList();
    ok([0, 11].includes(after1 - before), '首次列表请求：要么命中启动轮询的快照（0 次）要么新拉 11 类', `delta=${after1 - before}`);
    info('首次列表请求的 RPC 增量', after1 - before);
    const a2 = await req('GET', '/api/alerts?count=50');
    eq(a2.status, 200, '第二次同键请求 200');
    eq(countList() - after1, 0, '15 秒窗口内同键请求不再发 RPC（快照）');
    eq(a2.json?.total, a1.json?.total, '两次 total 一致');
  }
  console.log('== syslog 模式的 TriageSummary 形状（openapi syslog 块 / 无 interval_ms）==');
  {
    srv.kill('SIGKILL');
    await sleep(100);
    const dgram = await import('node:dgram');
    const udpPort = await new Promise((resolve) => { const u = dgram.createSocket('udp4'); u.bind(0, '127.0.0.1', () => { const p = u.address().port; u.close(() => resolve(p)); }); });
    const syslogPort = await freePort();
    const s2 = spawn(process.execPath, ['server.js'], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...env, HIDS_PORT: String(syslogPort), HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_PORT: String(udpPort) } });
    children.push(s2);
    const base2 = `http://127.0.0.1:${syslogPort}`;
    let up = false;
    for (let i = 0; i < 200; i += 1) { try { if ((await fetch(base2 + '/api/config')).ok) { up = true; break; } } catch {} await sleep(50); }
    ok(up, 'syslog 模式真进程起得来');
    const r = await fetch(base2 + '/api/agent/triage/status');
    const b = await r.json();
    eq(r.status, 200, 'syslog 模式 status 200');
    eq(b.input_mode, 'syslog', 'input_mode=syslog');
    eq(b.last_poll_at, null, 'syslog 模式 last_poll_at 恒为 null');
    ok(!('interval_ms' in b), 'syslog 模式没有 interval_ms');
    eq(Object.keys(b.syslog || {}).sort(), ['bind', 'error', 'listening'], 'syslog 块三键');
    eq(b.syslog?.listening, true, 'syslog 接收器绑上');
    ok(typeof b.syslog?.bind === 'string' && b.syslog.bind.startsWith('udp://'), 'syslog.bind 是 udp:// 地址', String(b.syslog?.bind));
    eq(b.syslog?.error, null, '绑定成功时 error 为 null');
  }

} finally {
  for (const c of children) c.kill('SIGKILL');
  await sleep(100);
}

console.log('== 现网缺件：createServer() 直起（不进闸门）==');
{
  const helper = join(temp, 'e2e-unconfigured.mjs');
  await writeFile(helper, `
import http from 'node:http';
import { createServer } from './server.js';
const srv = createServer();
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const get = async (p) => { const r = await fetch('http://127.0.0.1:' + port + p); return { status: r.status, body: await r.json() }; };
  console.log(JSON.stringify({ triage: await get('/api/agent/triage/status'), status: await get('/api/status') }));
  srv.close();
});
`);
  const child = spawn(process.execPath, [helper], { cwd: temp, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const out = await new Promise((resolve) => {
    let s = ''; child.stdout.on('data', d => { s += d; }); child.stderr.on('data', d => { s += d; });
    child.on('exit', () => resolve(s));
    setTimeout(() => resolve(s + '\n<TIMEOUT>'), 15000);
  });
  let parsed = null; try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch {}
  eq(parsed?.triage?.status, 503, '无研判队列：/api/agent/triage/status -> 503', out.slice(0, 300));
  eq(parsed?.triage?.body?.code, 'not_configured', '503 正文 code=not_configured', JSON.stringify(parsed?.triage?.body));
  eq(parsed?.status?.status, 200, '未配牧云：/api/status 仍 200');
  eq(parsed?.status?.body?.configured, false, '未配牧云：configured=false');
  eq(parsed?.status?.body?.connected, false, '未配牧云：connected=false');
  child.kill('SIGKILL');
}

await rm(temp, { recursive: true, force: true });
rpc.close(); llm.close();
console.log(`\n== 汇总：pass ${pass} / fail ${fails.length} ==`);
if (fails.length) { for (const f of fails) console.log('FAIL:', f); process.exitCode = 1; }
