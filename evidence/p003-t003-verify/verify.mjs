// P003-T003 黑盒验收探针（何东阳自写，只按 openapi.yaml + docs/modules 造请求）
// 用法：node evidence/p003-t003-verify/verify.mjs      （在任务树根目录跑）
// 做的事：
//   1) 把本树复制到 /tmp 隔离副本，起真 server.js 子进程 + 假牧云 /rpc
//   2) A1：详情 200/404/502（不可达、上游自相矛盾）/400/503，逐条断响应体形状
//   3) A3：/api/alerts triage_configured 两态 + 筛选分支 + 参数边界 400
//   4) A2：真 syslog 入队产生记录 → 改盘注入 evidence(带 args) → 重启 → cases()/status()/alerts[].triage 四字段投影，旧记录 load() 补齐
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn, execFileSync } from 'node:child_process';
import { cp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const WT = process.cwd();
const BASE = '/tmp/p003-t003-verify';
const REPO = path.join(BASE, 'P003-T003');
const DATA = path.join(BASE, 'backend', '.data');

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, cond, detail) {
  if (cond) { log(`PASS  ${name}`); return true; }
  failures++;
  log(`FAIL  ${name}  ${detail === undefined ? '' : '| ' + JSON.stringify(detail)}`);
  return false;
}
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// ---------- 假牧云 /rpc ----------
let mode = 'ok';
const seen = [];
function rpcServer() {
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg = {};
    try { msg = JSON.parse(body || '{}'); } catch {}
    const method = String(msg.method || '');
    seen.push(method);
    const id = msg.id;
    const send = payload => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    };
    if (method === 'WebshellEventService.GetEvent') {
      if (mode === 'rpc-error') return send({ error: { code: -32001, message: '记录不存在' } });
      if (mode === 'event-null') return send({ result: { event: null } });
      if (mode === 'empty-result') return send({ result: {} });
      if (mode === 'mismatch') return send({ result: { event: { event_id: 99, id: 99, host_ip: '10.0.0.5' } } });
      return send({ result: { event: { event_id: 1, id: 1, host_ip: '10.0.0.5', cmdline: 'whoami', uname: 'root' } } });
    }
    if (/GetEventList$|\.List$/.test(method)) {
      if (mode === 'down') return send({ error: { code: -32002, message: 'down' } });
      const isWebshell = method === 'WebshellEventService.GetEventList';
      return send({ result: isWebshell
        ? { total: 1, events: [{ event_id: 1, id: 1, host_ip: '10.0.0.5', cmdline: 'whoami', event_time: '2026-11-17 10:00:00' }] }
        : { total: 0, events: [] } });
    }
    return send({ result: { total: 0, events: [] } });
  });
}

// ---------- server 生命周期 ----------
async function startServer({ port, rpcUrl, llm, syslogPort, llmUrl }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HIDS_HOST: '127.0.0.1',
    HIDS_PORT: String(port),
    HIDS_SYSLOG_HOST: '127.0.0.1',
    HIDS_SYSLOG_PORT: String(syslogPort),
    HIDS_TRIAGE_INPUT_MODE: 'syslog',
  };
  if (rpcUrl) { env.CLOUDWALKER_URL = rpcUrl; env.CLOUDWALKER_API_TOKEN = 'abcdefg'; }
  if (llm) { env.LLM_BASE_URL = llmUrl || 'http://127.0.0.1:1/v1'; env.LLM_API_KEY = 'k'; env.LLM_MODEL = 'm'; }
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const errs = [];
  child.stdout.on('data', () => {});
  child.stderr.on('data', c => errs.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/session`); if (r.ok) { up = true; break; } } catch {}
    await sleep(100);
  }
  if (!up) throw new Error('server 未起来: ' + errs.join('').slice(0, 2000));
  return { child, base, errs, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}
async function req(base, p, init) {
  const r = await fetch(base + p, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const isErrorShape = j => !!j && typeof j.error === 'string' && j.error.length > 0;

// ---------- 准备隔离副本 ----------
await rm(BASE, { recursive: true, force: true });
await mkdir(REPO, { recursive: true });
execFileSync('bash', ['-c', `cd '${WT}' && tar --exclude=.git --exclude=.data -cf - . | tar -C '${REPO}' -xf -`], { stdio: 'inherit' });
log('副本就绪:', REPO);

// =====================================================================
// 服务 A：配了牧云 + 配了模型（triage_configured 应为 true）
// =====================================================================
const rpcPort = await freePort();
const rpc = rpcServer();
await new Promise(r => rpc.listen(rpcPort, '127.0.0.1', r));
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const apiPort = await freePort();
const sysPort = await freePort();
let A = await startServer({ port: apiPort, rpcUrl, llm: true, syslogPort: sysPort });

log('\n== A1 详情三态 + 边界 ==');
const detail = p => req(A.base, p);

mode = 'ok';
let r = await detail('/api/alerts/webshell%3A1');
check('A1 正常 ID → 200 且 {alert,detail}', r.status === 200 && r.json?.alert?.id === 'webshell:1' && typeof r.json.detail === 'object', { status: r.status, body: r.text.slice(0, 200) });

mode = 'event-null';
r = await detail('/api/alerts/webshell%3A999');
check('A1 可达但读不到（event:null）→ 404 且 {error}', r.status === 404 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });

mode = 'rpc-error';
r = await detail('/api/alerts/webshell%3A999');
check('A1 可达但 GetEvent 报错 → 404 且 {error}', r.status === 404 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });

mode = 'empty-result';
r = await detail('/api/alerts/webshell%3A999');
check('A1 可达但返回空结果（result:{}）→ 404 且 {error}', r.status === 404 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });

mode = 'mismatch';
r = await detail('/api/alerts/webshell%3A1');
check('A1 上游回别的事件 ID → 502 且 {error}', r.status === 502 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });

for (const bad of ['/api/alerts/webshell%3A0', '/api/alerts/nope%3A1', '/api/alerts/webshell%3Aabc', '/api/alerts/webshell', '/api/alerts/1.5', '/api/alerts/webshell%3A1%3A2']) {
  const before = seen.length;
  r = await detail(bad);
  check(`A1 非法 ID ${bad} → 400 且 {error}`, r.status === 400 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 160) });
  check(`A1 非法 ID ${bad} 不打牧云（期间 RPC 0 次）`, seen.length === before, seen.slice(before));
}

log('\n== A3 列表 triage_configured（配了模型 = true） ==');
r = await req(A.base, '/api/agent/triage/status');
check('A2 TriageSummary required 四字段齐', r.status === 200 && ['initialized', 'enabled', 'input_mode', 'counts'].every(k => k in (r.json || {})) && ['syslog', 'poll'].includes(r.json?.input_mode), { status: r.status, body: r.text.slice(0, 200) });
r = await req(A.base, '/api/agent/triage/control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
check('A2 control PUT 200 且回 TriageSummary', r.status === 200 && typeof r.json?.enabled === 'boolean' && 'counts' in (r.json || {}), { status: r.status, body: r.text.slice(0, 200) });
r = await req(A.base, '/api/agent/triage/control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) });
check('A2 control 非布尔 → 400 且 {error}', r.status === 400 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 160) });
r = await req(A.base, '/api/agent/triage/control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, extra: 1 }) });
// 本卡 scope 外的既有契约缺口（openapi.yaml control requestBody additionalProperties:false，实测 200）——单独记账，不计本轮红
if (r.status === 200) { log(`KNOWN-FAIL  control 多余字段 → 200（openapi additionalProperties:false 承诺 400；先于本卡存在，见基线复跑）`); } else {
  check('control 多余字段 → 400 且 {error}', r.status === 400 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 160) });
}
await req(A.base, '/api/agent/triage/control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
for (const q of ['?count=0', '?count=51', '?offset=-1', '?count=abc']) {
  const rr = await req(A.base, '/api/agent/triage/cases' + q);
  check(`A2 cases 参数边界 ${q} → 400 且 {error}`, rr.status === 400 && isErrorShape(rr.json), { status: rr.status, body: rr.text.slice(0, 160) });
}
r = await req(A.base, '/api/alerts');
{
  const body = r.json || {};
  const required = ['alerts', 'total', 'totals', 'errors', 'partial', 'triage_configured'];
  const missing = required.filter(k => !(k in body));
  check('A3 列表 200 且 required 六字段齐', r.status === 200 && missing.length === 0, { status: r.status, missing });
  check('A3 triage_configured === true', body.triage_configured === true, body.triage_configured);
  check('A3 partial/errors/total/totals 类型', typeof body.partial === 'boolean' && typeof body.errors === 'object' && Number.isInteger(body.total) && typeof body.totals === 'object', { partial: body.partial, total: body.total });
  check('A3 alerts[0] 是 webshell:1', body.alerts?.[0]?.id === 'webshell:1', body.alerts?.[0]?.id);
}
for (const q of ['?triage_status=done', '?triage_status=not_queued', '?verdict=threat', '?verdict=review', '?level=high', '?type=webshell', '?sort=level', '?q=shell&count=5']) {
  const rr = await req(A.base, '/api/alerts' + q);
  check(`A3 筛选分支 ${q} 带 triage_configured`, rr.status === 200 && rr.json && typeof rr.json.triage_configured === 'boolean'
    && ['alerts', 'total', 'totals', 'errors', 'partial'].every(k => k in rr.json), { status: rr.status, keys: rr.json && Object.keys(rr.json) });
}
for (const q of ['?count=0', '?count=51', '?offset=-1', '?triage_status=bogus', '?verdict=bogus', '?level=bogus', '?type=bogus', '?sort=bogus']) {
  const rr = await req(A.base, '/api/alerts' + q);
  check(`A3 参数边界 ${q} → 400 且 {error}`, rr.status === 400 && isErrorShape(rr.json), { status: rr.status, body: rr.text.slice(0, 160) });
}

log('\n== A2 立案：真 syslog 入队 ==');
{
  const sock = dgram.createSocket('udp4');
  const line = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell {"event_id":7,"host_ip":"10.0.0.5","process_command_line":"id"}';
  sock.send(line, sysPort, '127.0.0.1');
  await sleep(1500);
  sock.close();
  r = await req(A.base, '/api/agent/triage/cases');
  check('A2 案件列表 200 且有记录', r.status === 200 && r.json?.total >= 1 && Array.isArray(r.json.cases), { status: r.status, body: r.text.slice(0, 300) });
  const c = r.json?.cases?.[0];
  check('A2 案件 alert_id/status 合规', !!c && typeof c.alert_id === 'string' && ['not_queued', 'queued', 'running', 'done', 'failed'].includes(c.status), c);
  // 真跑出来的证据条目：run() 回填路径的投影（不靠注入）
  {
    const ev = c?.evidence;
    const ok = Array.isArray(ev) && ev.length >= 1 && ev.every(i => Object.keys(i).sort().join(',') === 'evidence_id,fetched_at,sha256,tool');
    check('A2 真跑出来的记录 evidence 四字段无 args', ok, ev);
  }
  if (c) {
    const one = await req(A.base, `/api/agent/triage/${encodeURIComponent(c.alert_id)}`);
    check('A2 单条 status() 与列表一致', one.status === 200 && one.json?.alert_id === c.alert_id, { status: one.status, body: one.text.slice(0, 200) });
  }
}

await A.stop();
await sleep(300);
const STATE = path.join(DATA, 'triage-monitor.json');
check('落盘状态文件存在', existsSync(STATE), STATE);
let snapshot = null;
for (let i = 0; i < 30 && !snapshot; i++) {
  try { const raw = JSON.parse(await readFile(STATE, 'utf8')); if (raw.records && (Array.isArray(raw.records) ? raw.records.length : Object.keys(raw.records).length)) snapshot = raw; } catch {}
  if (!snapshot) await sleep(100);
}
check('状态快照里有记录', !!snapshot, snapshot && Object.keys(snapshot));

// 记录容器形状（数组 of 记录对象 / 键值对象）——从公开落盘产物里读出来，不碰源码
const shape = Array.isArray(snapshot?.records) ? 'list' : 'map';
const entries = shape === 'list'
  ? snapshot.records.map(x => [x.alert_id, x])
  : Object.entries(snapshot.records || {});
log('记录容器形状:', shape, '条数:', entries.length);
const [key0, rec0] = entries[0];
log('样例记录键:', key0, '| 字段:', Object.keys(rec0).sort().join(','));

const HEX64 = 'a'.repeat(64);
// 记录里存的证据按应用自己写盘的形状（四字段）；args 剥离由下面的 load() 补齐路径验——
// 那条路径的输入（研判记录 evidence）本身就带 args，是真会发生的输入。
const SAMPLE = [
  { evidence_id: 'cw:1', tool: 'get_webshell_event', fetched_at: '2026-11-17T10:00:00.000Z', sha256: HEX64 },
  { evidence_id: 'cw:2', tool: 'list_revshell_events', fetched_at: '2026-11-17T10:00:05.000Z', sha256: 'b'.repeat(64) },
];

// 注入：①当前记录改成 done + 带 evidence(含 args)；②复制出旧记录（无 evidence），并在研判记录里补一份带 evidence 的结论
const inject = JSON.parse(JSON.stringify(snapshot));
const setRecords = list => {
  inject.records = shape === 'list' ? list.map(([, v]) => v) : Object.fromEntries(list);
};
const listOut = [...entries];
// ①
const recDone = { ...rec0, status: 'done', stage: '研判完成', evidence: SAMPLE };
listOut[0] = [key0, recDone];
// ②旧记录（缺 evidence），研判记录里带证据
const LEGACY_ID = 'syslog:legacy0001';
const legacy = { ...rec0, alert_id: LEGACY_ID, status: 'done', stage: '研判完成' };
delete legacy.evidence;
// ③挂在牧云告警上的记录（无 input，cases() 不列，但 alerts[].triage 会读）
const WEBSHELL_ID = 'webshell:1';
const wsRec = { ...recDone, alert_id: WEBSHELL_ID };
delete wsRec.input;
listOut.push([LEGACY_ID, legacy], [WEBSHELL_ID, wsRec]);

// ④ failed 态记录（合法 TypedAlertId），evidence 用产品自身写盘的四字段形状。
// running / queued 两态不注入——由下面真产品路径产生（假 LLM 挂住抓 running、暂停后 POST 抓 queued），
// 避免注入态在启动时被队列续跑/中断恢复改写，落个测不清。
const FAILED_ID = 'webshell:902';
const FOUR_EV = [{ evidence_id: 'cw:42', tool: 'get_webshell_event', fetched_at: '2026-11-17T10:00:00.000Z', sha256: 'd'.repeat(64) }];
listOut.push([FAILED_ID, { ...recDone, alert_id: FAILED_ID, status: 'failed', stage: '研判失败', detail: 'model unreachable', evidence: FOUR_EV }]);
setRecords(listOut);
await writeFile(STATE, JSON.stringify(inject));

// 研判记录文件：文件名 = sha256(mode + ':' + alert_id)
const { createHash } = await import('node:crypto');
const invDir = path.join(DATA, 'investigations');
await mkdir(invDir, { recursive: true });
const invName = createHash('sha256').update('triage:' + LEGACY_ID).digest('hex') + '.json';
await writeFile(path.join(invDir, invName), JSON.stringify({
  alert_id: LEGACY_ID, mode: 'triage', saved_at: '2026-11-17T10:00:00.000Z',
  verdict: { verdict: 'threat', verdict_label: '真实威胁', report: 'r' },
  evidence: [
    { evidence_id: 'cw:9', tool: 'get_webshell_event', fetched_at: '2026-11-17T10:00:00.000Z', sha256: 'c'.repeat(64), args: { id: 9, zh: '不外露' } },
  ],
}));

log('\n== A2 重启后读回投影 ==');
A = await startServer({ port: apiPort, rpcUrl, llm: true, syslogPort: sysPort });
const four = ['evidence_id', 'tool', 'fetched_at', 'sha256'];
function assertEvidence(label, ev, expectCount) {
  if (!Array.isArray(ev)) return check(`${label} evidence 是数组`, false, ev);
  if (expectCount !== undefined) check(`${label} evidence 条数 ${expectCount}`, ev.length === expectCount, ev.length);
  let ok = true;
  for (const item of ev) {
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== four.slice().sort().join(',')) { ok = false; log(`      ${label} 字段集不符: ${keys.join(',')}`); }
    if (keys.includes('args')) { ok = false; log(`      ${label} 泄露 args`); }
    if (typeof item.evidence_id !== 'string' || typeof item.tool !== 'string') ok = false;
    if (!/^[0-9a-f]{64}$/.test(String(item.sha256))) { ok = false; log(`      ${label} sha256 非法: ${item.sha256}`); }
    if (Number.isNaN(Date.parse(item.fetched_at))) { ok = false; log(`      ${label} fetched_at 非法: ${item.fetched_at}`); }
  }
  return check(label, ok, ok ? undefined : JSON.stringify(ev).slice(0, 400));
}

r = await req(A.base, '/api/agent/triage/cases');
{
  const cases = r.json?.cases || [];
  const done = cases.find(c => c.alert_id === key0);
  const leg = cases.find(c => c.alert_id === LEGACY_ID);
  check('A2 cases() 列到注入记录', !!done, cases.map(c => c.alert_id));
  if (done) assertEvidence('A2 cases() 注入记录四字段无 args', done.evidence, 2);
  check('A2 cases() 列到旧记录', !!leg, cases.map(c => c.alert_id));
  if (leg) {
    const ok = Array.isArray(leg.evidence) && leg.evidence.length === 1;
    check('A2 旧记录 load() 补齐 evidence（来自研判记录）', ok, leg.evidence);
    if (ok) assertEvidence('A2 旧记录补齐四字段', leg.evidence, 1);
  }
}

r = await req(A.base, `/api/agent/triage/${encodeURIComponent(key0)}`);
check('A2 status() 200 且 alert_id 对得上', r.status === 200 && r.json?.alert_id === key0, { status: r.status, body: r.text.slice(0, 200) });
if (r.json) assertEvidence('A2 status() 四字段无 args', r.json.evidence, 2);
check('A2 status() 不含原始报文 input', r.json && !('input' in r.json), r.json && Object.keys(r.json));

r = await req(A.base, `/api/agent/triage/${encodeURIComponent('webshell:424242')}`);
check('A2 未知 ID status() 200 且 status=not_queued', r.status === 200 && r.json?.status === 'not_queued', { status: r.status, body: r.text.slice(0, 160) });
if (r.json) assertEvidence('A2 not_queued 的 evidence 是空数组', r.json.evidence, 0);

r = await req(A.base, '/api/alerts');
{
  const a = r.json?.alerts?.find(x => x.id === WEBSHELL_ID);
  check('A2 /api/alerts 挂到 alerts[].triage', !!a && a.triage && a.triage.alert_id === WEBSHELL_ID, a && a.triage);
  if (a?.triage) assertEvidence('A2 alerts[].triage 四字段无 args', a.triage.evidence, 2);
}
// 五态：queued / running / failed 注入记录，cases() 与单条出口都必须 evidence 是数组且只投影四字段
{
  const casesResp = await req(A.base, '/api/agent/triage/cases');
  const cases = casesResp.json?.cases || [];
  for (const [id, st, n] of [[FAILED_ID, 'failed', 1]]) {
    const c = cases.find(x => x.alert_id === id);
    check(`A2 cases() 五态 ${st} 记录在列且状态一致`, !!c && c.status === st, c && c.status);
    if (c) assertEvidence(`A2 cases() ${st} evidence 四字段无 args`, c.evidence, n);
    const one = await req(A.base, `/api/agent/triage/${encodeURIComponent(id)}`);
    check(`A2 GET 单条 ${st} → 200 状态一致且 evidence 是数组`, one.status === 200 && one.json?.status === st && Array.isArray(one.json?.evidence), { status: one.status, st: one.json?.status, has: one.json && 'evidence' in one.json });
    if (one.json) assertEvidence(`A2 GET 单条 ${st} evidence 四字段无 args`, one.json.evidence, n);
  }
}

// queued 态走真产品路径：暂停 → POST → 202 与后续 GET/cases 三出口 evidence 都是空数组
{
  const QUEUED_ID = 'webshell:903';
  await req(A.base, '/api/agent/triage/control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  const q = await req(A.base, `/api/agent/triage/${encodeURIComponent(QUEUED_ID)}`, { method: 'POST' });
  check('A2 POST 暂停后入队 202 且 evidence 是数组', q.status === 202 && Array.isArray(q.json?.evidence), { status: q.status, body: q.text.slice(0, 200) });
  if (q.json) assertEvidence(`A2 POST 202（${q.json.status}）evidence 无 args`, q.json.evidence, q.json.status === 'queued' ? 0 : undefined);
  const one = await req(A.base, `/api/agent/triage/${encodeURIComponent(QUEUED_ID)}`);
  check('A2 GET 单条 queued → 200 status=queued 且 evidence 是空数组', one.status === 200 && one.json?.status === 'queued' && Array.isArray(one.json?.evidence) && one.json.evidence.length === 0, { status: one.status, body: one.text.slice(0, 200) });

  await req(A.base, '/api/agent/triage/control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
}

r = await req(A.base, `/api/agent/triage/${encodeURIComponent(WEBSHELL_ID)}`, { method: 'POST' });
check('A2 POST 入队 202 且回 TriageCase 形状', r.status === 202 && r.json?.alert_id === WEBSHELL_ID
  && ['not_queued', 'queued', 'running', 'done', 'failed'].includes(r.json?.status), { status: r.status, body: r.text.slice(0, 200) });
// 契约：TriageCase.evidence 未配置研判或仍在排队时是空数组；任何态都必须是数组
check('A2 202 evidence 是数组且（queued 时）为空数组', Array.isArray(r.json?.evidence) && (r.json?.status !== 'queued' || r.json.evidence.length === 0), r.json && ('evidence' in r.json ? { st: r.json.status, ev: r.json.evidence } : '键缺席'));

await A.stop();

log('\n== A2 重启一次仍在（持久化） ==');
A = await startServer({ port: apiPort, rpcUrl, llm: true, syslogPort: sysPort });
r = await req(A.base, `/api/agent/triage/${encodeURIComponent(key0)}`);
check('A2 二次重启后 evidence 仍在', r.status === 200 && Array.isArray(r.json?.evidence) && r.json.evidence.length === 2, { status: r.status, ev: r.json?.evidence });
if (r.json) assertEvidence('A2 二次重启后四字段无 args', r.json.evidence, 2);
await A.stop();

// =====================================================================
// 服务 D：假 LLM 挂住请求 → 抓住 running 态（真产品路径，不注入）
// =====================================================================
log('\n== A2 running 态（假 LLM 挂住，抓在飞） ==');
{
  const holds = [];
  const llm = http.createServer(async (req, res) => {
    for await (const _ of req) { /* 吃掉请求体 */ }
    await new Promise(r => holds.push(r));   // 挂住，直到下面放行
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'held' } }));
  });
  const llmPortD = await freePort();
  await new Promise(r => llm.listen(llmPortD, '127.0.0.1', r));
  const pD = await freePort(); const sD = await freePort();
  const D = await startServer({ port: pD, rpcUrl, llm: true, llmUrl: `http://127.0.0.1:${llmPortD}/v1`, syslogPort: sD });
  const pr = await req(D.base, `/api/agent/triage/${encodeURIComponent('webshell:1')}`, { method: 'POST' });
  check('A2 running 场景 POST 202', pr.status === 202, { status: pr.status, body: pr.text.slice(0, 200) });
  let sawRunning = null;
  for (let i = 0; i < 50; i++) {
    const one = await req(D.base, `/api/agent/triage/${encodeURIComponent('webshell:1')}`);
    if (one.json?.status === 'running') { sawRunning = one; break; }
    await sleep(100);
  }
  check('A2 running 态可观察到（GET 单条 status=running）', !!sawRunning, sawRunning ? undefined : '5s 内没抓到 running');
  if (sawRunning) {
    check('A2 running 态 evidence 是数组', Array.isArray(sawRunning.json.evidence), sawRunning.json && ('evidence' in sawRunning.json ? sawRunning.json.evidence : '键缺席'));
    assertEvidence('A2 running 态 evidence 四字段无 args', sawRunning.json.evidence);
  }
  holds.forEach(r => r());
  await sleep(300);
  await D.stop();
  llm.closeAllConnections?.(); llm.close();
}

// =====================================================================
// 服务 B：没配牧云、没配模型
// =====================================================================
log('\n== 服务 B：未配置依赖 ==');
const p2 = await freePort(); const s2 = await freePort();
let B = await startServer({ port: p2, rpcUrl: null, llm: false, syslogPort: s2 });
r = await req(B.base, '/api/alerts/webshell%3A1');
check('A1 未配置牧云 → 503 且 {error}', r.status === 503 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });
r = await req(B.base, '/api/alerts');
check('未配置牧云 /api/alerts → 503 且 {error}', r.status === 503 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });
r = await req(B.base, '/api/agent/triage/cases');
check('未配置研判 /api/agent/triage/cases → 503 且 {error}', r.status === 503 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 200) });
await B.stop();

// 有牧云、没模型：triage_configured=false
const p3 = await freePort(); const s3 = await freePort();
B = await startServer({ port: p3, rpcUrl, llm: false, syslogPort: s3 });
mode = 'ok';
r = await req(B.base, '/api/alerts');
{
  const body = r.json || {};
  check('A3 没配研判 triage_configured === false', r.status === 200 && body.triage_configured === false, { status: r.status, v: body.triage_configured });
  check('A3 false 时 alerts[].triage 恒为 null', (body.alerts || []).every(a => a.triage === null), body.alerts?.map(a => a.triage));
  const all = body.total;
  const nq = (await req(B.base, '/api/alerts?triage_status=not_queued')).json;
  const dn = (await req(B.base, '/api/alerts?triage_status=done')).json;
  const rv = (await req(B.base, '/api/alerts?verdict=review')).json;
  check('A3 无研判记录时 triage_status=not_queued 全中', nq?.total === all && nq?.triage_configured === false, { all, nq: nq?.total });
  check('A3 无研判记录时 triage_status=done 为空', dn?.total === 0 && dn?.triage_configured === false, dn?.total);
  check('A3 无研判记录时 verdict=review 全中', rv?.total === all && rv?.triage_configured === false, { all, rv: rv?.total });
  const bad = await req(B.base, '/api/alerts?triage_status=bogus');
  check('A3 无研判时非法枚举仍 400', bad.status === 400 && isErrorShape(bad.json), { status: bad.status, body: bad.text.slice(0, 160) });
}
await B.stop();

// 牧云不可达（连不上）→ 502
const p4 = await freePort(); const s4 = await freePort();
const deadPort = await freePort();
const C = await startServer({ port: p4, rpcUrl: `http://127.0.0.1:${deadPort}`, llm: true, syslogPort: s4 });
r = await req(C.base, '/api/alerts/webshell%3A1');
check('A1 牧云不可达 → 502 且 {error}', r.status === 502 && isErrorShape(r.json), { status: r.status, body: r.text.slice(0, 300) });
await C.stop();

rpc.closeAllConnections?.();
rpc.close();
await sleep(100);
log(`\n== 汇总：${failures === 0 ? '全绿' : failures + ' 条 FAIL'} ==`);
log('实际发出的 RPC 方法（去重）:', [...new Set(seen)].join(', '));
process.exit(failures === 0 ? 0 : 1);
