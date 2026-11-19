// P003-T037 tester probe（专项·复验版）：HIDS_TRIAGE_CONCURRENCY 在真进程里「生效」的两个面——
//   ① 回显：GET /api/agent/triage/status 的 concurrency = env 规范化后的值（文档：architecture.md:449、triage-pipeline.md:542、openapi TriageSummary.concurrency）
//   ② 行为：同时在跑的记录条数受它限制（env=1 时连发 3 条 → running 1 / queued 2；env=3 → running 3 / queued 0）
// 黑盒：真 `node server.js` + 假牧云（请求一律挂住不答，研判卡在等上游，不会被判失败结案）。
// 上一版探针的假牧云秒回，被上游身份校验判「MCP 服务不是牧云」，记录 10ms 内 failed 退出配额，
// 断言因此依赖毫秒窗口（时红时绿）；本版挂住上游，窗口消失。
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = process.cwd();
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const freePort = async () => { const s = http.createServer(); const p = await listen(s); s.close(); return p; };
const copyTree = async () => {
  const dir = await mkdtemp(join(tmpdir(), 't37-conc-'));
  await cp(repo, dir, { recursive: true,
    filter: (src) => !/[\\/](\.git|\.data|web|evidence|coding-reports|docs|node_modules)$/.test(src.replace(repo, '')) });
  return dir;
};

// 假牧云：一律挂住不答（研判永久「在跑」）。
let rpc; let rpcPort; let hang = [];
const startRpc = async () => {
  hang = [];
  rpc = http.createServer((req, res) => { req.resume(); req.on('end', () => hang.push(res)); });
  rpcPort = await listen(rpc);
};
// 假模型：本探针不会走到模型，只要地址可达让装配判定研判链配齐。
const llm = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))); });
const llmPort = await listen(llm);
await startRpc();

const rows = [
  { label: 'poll env=1', mode: 'poll', env: '1', posts: 3, expect: { running: 1, queued: 2 } },
  { label: 'poll env=3', mode: 'poll', env: '3', posts: 3, expect: { running: 3, queued: 0 } },
  { label: 'poll env=5', mode: 'poll', env: '5', posts: 3, expect: { running: 3, queued: 0 } }
];

let fails = 0;
for (const row of rows) {
  const temp = await copyTree();
  const apiPort = await freePort();
  const srv = spawn(process.execPath, ['server.js'], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: process.env.HOME, HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort),
    HIDS_TRIAGE_INPUT_MODE: row.mode, HIDS_TRIAGE_CONCURRENCY: row.env, HIDS_TRIAGE_QUEUE_MAX: '10',
    CLOUDWALKER_URL: `http://127.0.0.1:${rpcPort}`, CLOUDWALKER_API_TOKEN: 'test-token',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, LLM_API_KEY: 'sk-test', LLM_MODEL: 'fake' } });
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${apiPort}`;
  let summary = null;
  for (let i = 0; i < 200 && !summary; i += 1) {
    try { const r = await fetch(`${base}/api/agent/triage/status`); if (r.ok) summary = await r.json(); } catch {}
    if (!summary) await sleep(50);
  }
  const echoOk = summary?.concurrency === Number(row.env) && summary?.queue_limit === 10;
  for (let i = 1; i <= row.posts; i += 1) await fetch(`${base}/api/agent/triage/honeypot:${i}`, { method: 'POST' });
  let after = null;
  for (let i = 0; i < 100; i += 1) {
    after = await (async () => { try { return await (await fetch(`${base}/api/agent/triage/status`)).json(); } catch { return null; } })();
    if ((after?.counts?.running ?? 0) >= row.expect.running) break;
    await sleep(20);
  }
  const counts = after?.counts || {};
  const behaviorOk = counts.running === row.expect.running && counts.queued === row.expect.queued;
  const good = echoOk && behaviorOk;
  if (!good) fails += 1;
  console.log(`${good ? '✔' : '✖'} ${row.label} -> summary().concurrency=${summary?.concurrency} queue_limit=${summary?.queue_limit}`
    + `；连发 ${row.posts} 条后 counts=${JSON.stringify({ running: counts.running, queued: counts.queued })}`
    + `（期望 running=${row.expect.running} queued=${row.expect.queued}）`
    + (good ? '' : `\n  --- 进程输出尾部 ---\n${out.split('\n').slice(-5).join('\n')}`));
  srv.kill('SIGKILL');
  hang.forEach((r) => r.destroy()); rpc.close();
  await rm(temp, { recursive: true, force: true });
  await sleep(100);
  await startRpc();
}

llm.close();
console.log(fails ? `✖ 汇总：${fails}/${rows.length} 条不成立` : `✔ 汇总：${rows.length}/${rows.length} 条成立`);
// 假 rpc/llm 的连接可能仍半开，显式退出（否则会挂到外层 timeout）。
process.exit(fails ? 1 : 0);
