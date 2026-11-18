// P003-T001 文档冲突探针（何东阳 / gc-backend-tester）
// 只做「文档说 vs 实测」对照，不判归属。工作树根目录跑：node evidence/p003-t001-api/probe-doc-conflicts.mjs
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const METHOD = {
  webshell: 'WebshellEventService.GetEventList', malware: 'MalwareEventService.GetEventList',
  revshell: 'RevshellEventService.GetEventList', memory_webshell: 'MemoryWebshellEventService.GetEventList',
  brute_force: 'BruteForceService.GetEventList', abnormal_login: 'AbnormalLoginEventService.GetEventList',
  elevation_process: 'ElevationProcessEventService.GetEventList', network_audit: 'NetworkAuditEventService.GetEventList',
  suspicious_operation: 'SuspiciousOperationService.GetEventList', honeypot: 'HoneypotService.List',
  memory_security: 'MemorySecurityEventService.GetEventList',
};
const TYPE_OF = Object.fromEntries(Object.entries(METHOD).map(([k, v]) => [v, k]));
const mk = (id, level) => ({
  id, detected_at: new Date(Date.UTC(2026, 2, 1) + id * 60000).toISOString(), level,
  event_name: `E${id}`, host: { host_name: 'h', host_ip: '10.0.0.1' }, username: 'u', cmdline: 'c',
  source_ip: '1.1.1.1', destination_ip: '10.0.0.1',
});
const ROWS = { webshell: Array.from({ length: 600 }, (_, i) => mk(i + 1, [1, 2, 3, 4][i % 4])) };
for (const k of Object.keys(METHOD)) ROWS[k] ??= [];

const up = http.createServer((req, res) => {
  const method = new URL(req.url, 'http://x').searchParams.get('method');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let params = {};
    try { params = JSON.parse(body).params || {}; } catch { /* 空 */ }
    const rows = ROWS[TYPE_OF[method]] || [];
    const count = Number(params.count) || 20, offset = Number(params.offset) || 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { events: rows.slice(offset, offset + count), total: rows.length } }));
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const apiPort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH, HOME: process.env.HOME, HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort), CLOUDWALKER_URL: `http://127.0.0.1:${up.address().port}`, CLOUDWALKER_API_TOKEN: 'token-abcdef' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const BASE = `http://127.0.0.1:${apiPort}`;
try {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + '/api/session', { signal: AbortSignal.timeout(500) }); if (r.status === 200) break; } catch { /* 未就绪 */ }
    await sleep(100);
  }
  const get = async (p) => {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) });
    return { status: r.status, json: await r.json() };
  };

  const sl = await get('/api/alerts?sort=level');
  console.log('[1] 文档：openapi.yaml:172 total「不带 level/q/from/to/triage_status/verdict 时为各类事件 total 之和」；openapi.yaml:146「带 level / q / from / to 或 sort=level 时单次请求最多扫描 500 条」');
  console.log(`    实测 ?sort=level（库内 600 条）：status=${sl.status} total=${sl.json.total} truncated=${sl.json.truncated} alerts=${sl.json.alerts.length}`);

  const echo = await get('/api/alerts?triage_status=not_queued&count=5&offset=0');
  console.log('[2] 文档：openapi.yaml 200 响应 schema 只声明 alerts/total/totals/errors/partial/truncated（无 query / note）');
  console.log(`    实测 ?triage_status=not_queued&count=5&offset=0：query=${JSON.stringify(echo.json.query)} note=${JSON.stringify(echo.json.note)} 页长=${echo.json.alerts.length}`);

  const t = await get('/api/alerts?type=webshell&count=1');
  console.log('[3] 文档：openapi.yaml Alert.example 里有 triage:null；Alert.required 只有 [id]');
  console.log(`    实测（未配 LLM_*，研判队列未装配）：alerts[0] 的键 = ${JSON.stringify(Object.keys(t.json.alerts[0]))}`);
  console.log(`    triage 字段在不在：${'triage' in t.json.alerts[0]}`);
} finally {
  child.kill('SIGKILL');
  up.close();
}
