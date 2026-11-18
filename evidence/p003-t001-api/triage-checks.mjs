// P003-T001 A3 探针：研判侧筛选（triage_status / verdict）
// 为什么单独一份：A3 需要研判队列（monitor）存在，而队列只在 LLM_* 配置齐时才装配；
// 研判过程会往运行态目录写记录，为了不动共享的 <仓库上一级>/backend/.data，
// 这里在同一 commit 的隔离副本里跑（副本与运行态目录都在本卡证据目录内，退出时删除）。
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync } from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUNTIME = path.join(HERE, 'runtime');
const REPO_COPY = path.join(RUNTIME, 'repo');
const results = [];
async function checkAsync(id, name, fn) {
  try { const d = await fn(); results.push({ id, ok: true }); console.log(`ok   ${id} ${name} | ${d ?? ''}`); }
  catch (e) { results.push({ id, ok: false, detail: e.message }); console.log(`FAIL ${id} ${name} | ${e.message}`); }
}
const eq = (a, b, what) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what}: 期望 ${y} 实测 ${x}`); };

/* 假牧云上游（与 checks.mjs 同口径） */
const METHOD = {
  webshell: 'WebshellEventService.GetEventList', malware: 'MalwareEventService.GetEventList',
  revshell: 'RevshellEventService.GetEventList', memory_webshell: 'MemoryWebshellEventService.GetEventList',
  brute_force: 'BruteForceService.GetEventList', abnormal_login: 'AbnormalLoginEventService.GetEventList',
  elevation_process: 'ElevationProcessEventService.GetEventList', network_audit: 'NetworkAuditEventService.GetEventList',
  suspicious_operation: 'SuspiciousOperationService.GetEventList', honeypot: 'HoneypotService.List',
  memory_security: 'MemorySecurityEventService.GetEventList',
};
const TYPE_OF = Object.fromEntries(Object.entries(METHOD).map(([k, v]) => [v, k]));
const ROWS = {
  webshell: [
    { id: 1, detected_at: '2026-11-01T08:00:00Z', created_at: '2026-11-01T08:00:00Z', level: 4, event_name: 'WebShell 落地', host: { host_name: 'db-1', host_ip: '10.0.0.1' }, username: 'root', cmdline: 'curl evil', source_ip: '203.0.113.9', destination_ip: '10.0.0.1' },
    { id: 2, detected_at: '2026-11-01T09:00:00Z', created_at: '2026-11-01T09:00:00Z', level: 2, event_name: '可疑上传', host: { host_name: 'web-2', host_ip: '10.0.0.2' }, username: 'www', cmdline: 'up', source_ip: '198.51.100.7', destination_ip: '10.0.0.2' },
  ],
  malware: [
    { id: 5, detected_at: '2026-11-01T10:00:00Z', created_at: '2026-11-01T10:00:00Z', level: 3, event_name: '恶意文件落地', host: { host_name: 'app-3', host_ip: '10.0.0.3' }, username: 'svc', cmdline: '/tmp/x.sh', source_ip: '192.0.2.5', destination_ip: '10.0.0.3' },
  ],
};
for (const k of Object.keys(METHOD)) ROWS[k] ??= [];

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let child = null, up = null;
function cleanup() {
  if (child) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  if (up) { try { up.close(); } catch { /* 已关 */ } }
  rmSync(RUNTIME, { recursive: true, force: true });
}

async function main() {
  // 1) 隔离副本：同 commit 的 git archive
  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(REPO_COPY, { recursive: true });
  execFileSync('bash', ['-c', `git archive HEAD | tar -x -C ${JSON.stringify(REPO_COPY)}`], { cwd: process.cwd() });

  // 2) 假牧云
  up = http.createServer((req, res) => {
    const method = new URL(req.url, 'http://x').searchParams.get('method');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const type = TYPE_OF[method];
      const rows = ROWS[type] || [];
      let params = {};
      try { params = JSON.parse(body).params || {}; } catch { /* 空 */ }
      const count = Number(params.count) || 20, offset = Number(params.offset) || 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { events: rows.slice(offset, offset + count), total: rows.length } }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  // 3) 真 server.js（副本树），LLM_* 给假值只为了让研判队列装配出来
  const apiPort = await freePort(), syslogPort = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort),
    HIDS_BASIC_AUTH_USER: 'hids', HIDS_BASIC_AUTH_PASSWORD: 's3cret',
    CLOUDWALKER_URL: `http://127.0.0.1:${up.address().port}`, CLOUDWALKER_API_TOKEN: 'token-abcdef',
    LLM_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'k', LLM_MODEL: 'm',
    HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
  };
  child = spawn(process.execPath, ['server.js'], { cwd: REPO_COPY, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const BASE = `http://127.0.0.1:${apiPort}`;
  const auth = { authorization: 'Basic ' + Buffer.from('hids:s3cret').toString('base64') };
  const call = async (p, init = {}) => {
    const r = await fetch(BASE + p, { ...init, signal: AbortSignal.timeout(20000), headers: { ...auth, ...(init.headers || {}) } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text };
  };
  for (let i = 0; i < 150; i++) {
    try { const r = await call('/api/session'); if (r.status === 200) break; } catch { /* 未就绪 */ }
    await sleep(100);
  }

  const okEnvelope = (r, what) => {
    if (r.status !== 200) throw new Error(`${what}: 期望 200 实测 ${r.status} ${r.text.slice(0, 160)}`);
    for (const k of ['alerts', 'total', 'totals', 'errors', 'partial']) if (!(k in r.json)) throw new Error(`${what}: 缺字段 ${k}`);
    return r.json;
  };
  const onlyIds = (b) => b.alerts.map((a) => a.id);

  // 4) 研判侧筛选：无记录时的口径（结果显示队列确实装配起来了）
  let triageCase = null;
  await checkAsync('A3-0', '研判队列已装配：GET /api/agent/triage/webshell:1 → 200 且 status=not_queued', async () => {
    const r = await call('/api/agent/triage/webshell:1');
    if (r.status !== 200) throw new Error(`期望 200 实测 ${r.status} ${r.text.slice(0, 160)}`);
    if (r.json.status !== 'not_queued') throw new Error(`期望 not_queued 实测 ${r.json.status}`);
    return 'status=not_queued';
  });
  await checkAsync('A3-1', '无研判记录时 triage_status=not_queued 命中全部（openapi: 没有记录算 not_queued）', async () => {
    const b = okEnvelope(await call('/api/alerts?triage_status=not_queued'), 'A3-1');
    eq(onlyIds(b), ['malware:5', 'webshell:2', 'webshell:1'], 'A3-1 ids');
    eq(b.total, 3, 'A3-1 total');
    return `total=3 ids=${onlyIds(b)}`;
  });
  await checkAsync('A3-2', '无研判记录时 triage_status=done 一条不中（total=0）', async () => {
    const b = okEnvelope(await call('/api/alerts?triage_status=done'), 'A3-2');
    eq(b.total, 0, 'A3-2 total'); eq(b.alerts, [], 'A3-2 alerts');
    return 'total=0';
  });
  await checkAsync('A3-3', '无结论时 verdict=review 命中全部（openapi: 没有结论算 review）', async () => {
    const b = okEnvelope(await call('/api/alerts?verdict=review'), 'A3-3');
    eq(b.total, 3, 'A3-3 total');
    return `total=3`;
  });
  await checkAsync('A3-4', 'verdict=threat 在无记录时 total=0', async () => {
    const b = okEnvelope(await call('/api/alerts?verdict=threat'), 'A3-4');
    eq(b.total, 0, 'A3-4 total');
    return 'total=0';
  });

  // 5) 入队一条，等状态离开 not_queued，再核筛选
  await checkAsync('A3-5', 'POST /api/agent/triage/webshell:1 → 202 且返回 TriageCase', async () => {
    const r = await call('/api/agent/triage/webshell:1', { method: 'POST' });
    if (r.status !== 202) throw new Error(`期望 202 实测 ${r.status} ${r.text.slice(0, 160)}`);
    if (!r.json || typeof r.json.status !== 'string') throw new Error(`正文不是 TriageCase：${r.text.slice(0, 160)}`);
    return `status=${r.json.status}`;
  });
  await checkAsync('A3-6', '入队后状态落到终态 done|failed（轮询 GET /api/agent/triage/webshell:1）', async () => {
    const deadline = Date.now() + 40000;
    let seen = [];
    while (Date.now() < deadline) {
      const r = await call('/api/agent/triage/webshell:1');
      triageCase = r.json;
      const s = r.json && r.json.status;
      if (s && !seen.includes(s)) seen.push(s);
      if (s === 'done' || s === 'failed') return `终态=${s}（观测到的状态序列：${seen.join('→')}；模型不可达）`;
      await sleep(200);
    }
    throw new Error(`40s 内没落到终态，观测序列：${seen.join('→')}`);
  });
  await checkAsync('A3-7', '挂完 triage 后 triage_status=<该状态> 能筛到 webshell:1，not_queued 筛不到它', async () => {
    if (!triageCase) throw new Error('前置 A3-6 没拿到状态');
    const s = triageCase.status;
    const hit = okEnvelope(await call(`/api/alerts?triage_status=${s}`), 'A3-7-hit');
    if (!onlyIds(hit).includes('webshell:1')) throw new Error(`triage_status=${s} 没命中 webshell:1，实测 ids=${onlyIds(hit)}`);
    const miss = okEnvelope(await call('/api/alerts?triage_status=not_queued'), 'A3-7-miss');
    if (onlyIds(miss).includes('webshell:1')) throw new Error(`not_queued 仍命中 webshell:1：${onlyIds(miss)}`);
    eq(miss.total, 2, 'A3-7 not_queued total');
    return `status=${s} hit=${onlyIds(hit)} not_queued=${onlyIds(miss)}`;
  });
  await checkAsync('A3-7b', '多选并集：queued,running,done,failed 只命中已入队的 1 条；加上 not_queued 才是全部 3 条', async () => {
    const hit = okEnvelope(await call('/api/alerts?triage_status=queued,running,done,failed'), 'A3-7b-hit');
    eq(hit.total, 1, 'A3-7b 只含已入队');
    eq(onlyIds(hit), ['webshell:1'], 'A3-7b ids');
    const all = okEnvelope(await call('/api/alerts?triage_status=queued,running,done,failed,not_queued'), 'A3-7b-all');
    eq(all.total, 3, 'A3-7b 加 not_queued 后全部');
    return `已入队=${onlyIds(hit)} 全量 total=${all.total}`;
  });
  await checkAsync('A3-8', '研判侧筛选后切页：triage_status=not_queued&count=1&offset=1 → 第二页 1 条、total 2', async () => {
    const b = okEnvelope(await call('/api/alerts?triage_status=not_queued&count=1&offset=1'), 'A3-8');
    eq(b.alerts.length, 1, 'A3-8 页长'); eq(b.total, 2, 'A3-8 total');
    return `ids=${onlyIds(b)} total=2`;
  });
  await checkAsync('A3-9', '研判侧筛选跨页扫描：triage_status=not_queued&level=high → 只留等级高的匹配（webshell:2 是 medium 被排除）', async () => {
    const b = okEnvelope(await call('/api/alerts?triage_status=not_queued&level=high'), 'A3-9');
    eq(onlyIds(b), ['malware:5'], 'A3-9 ids'); eq(b.total, 1, 'A3-9 total');
    return `ids=${onlyIds(b)}`;
  });
  await checkAsync('A3-10', '带研判记录时 alerts[].triage 的形状符合 openapi TriageCase（有 alert_id/status）', async () => {
    const b = okEnvelope(await call('/api/alerts?type=webshell'), 'A3-10');
    const a = b.alerts.find((x) => x.id === 'webshell:1');
    if (!a) throw new Error('webshell:1 不在返回里');
    if (!('triage' in a)) throw new Error(`webshell:1 没有 triage 字段：${JSON.stringify(Object.keys(a))}`);
    if (!a.triage || typeof a.triage.alert_id !== 'string' || typeof a.triage.status !== 'string') throw new Error(`triage 形状不符：${JSON.stringify(a.triage)}`);
    return `triage.status=${a.triage.status} verdictKey=${a.verdictKey}`;
  });
  await checkAsync('A3-11', '无研判记录的条目 triage 字段为 null（openapi example 口径）', async () => {
    const b = okEnvelope(await call('/api/alerts?type=malware'), 'A3-11');
    const a = b.alerts[0];
    if (!('triage' in a)) throw new Error(`malware:5 缺 triage 字段（keys=${JSON.stringify(Object.keys(a))}）`);
    if (a.triage !== null) throw new Error(`期望 null 实测 ${JSON.stringify(a.triage)}`);
    return 'triage=null';
  });
  console.log(`\n# 用例 ${results.length} / 失败 ${results.filter((r) => !r.ok).length}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
main().catch((e) => { console.error('HARNESS ERROR', e); cleanup(); process.exit(2); }).finally(() => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  if (up) { try { up.close(); } catch { /* 已关 */ } }
  rmSync(RUNTIME, { recursive: true, force: true });
});
