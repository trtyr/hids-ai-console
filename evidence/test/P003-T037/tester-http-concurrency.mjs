// P003-T037 tester probe（专项）：真进程里 HIDS_TRIAGE_CONCURRENCY 是否生效
// 文档出处：docs/architecture.md:449、docs/modules/triage-pipeline.md:542 / §5.5、openapi.yaml TriageSummary.concurrency
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const repo = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 't37-conc-'));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const freePort = async () => { const s = http.createServer(); const p = await listen(s); s.close(); return p; };

const rpc = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    const m = new URL(req.url, 'http://x').searchParams.get('method') || '';
    const id = JSON.parse(b || '{}').params?.id ?? 1;
    res.end(JSON.stringify({ result: m.endsWith('.GetEvent') ? { event: { id, event_id: id, host_id: 1 } } : { events: [], total: 0 } }));
  });
});
const rpcPort = await listen(rpc);
const llm = http.createServer((req, res) => { req.resume(); req.on('end', async () => { await sleep(3000); res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); }); });
const llmPort = await listen(llm);
await cp(repo, temp, { recursive: true, filter: s => !/[\\/](\.git|\.data|web|evidence|coding-reports|docs)$/.test(s.replace(repo, '')) });

let fails = 0;
for (const envValue of ['1', '5']) {
  const apiPort = await freePort();
  const srv = spawn(process.execPath, ['server.js'], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: process.env.HOME, HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort),
    HIDS_TRIAGE_INPUT_MODE: 'poll', HIDS_TRIAGE_CONCURRENCY: envValue, HIDS_TRIAGE_QUEUE_MAX: '10',
    CLOUDWALKER_URL: `http://127.0.0.1:${rpcPort}`, CLOUDWALKER_API_TOKEN: 'test-token',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, LLM_API_KEY: 'sk-test', LLM_MODEL: 'fake' } });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  const base = `http://127.0.0.1:${apiPort}`;
  let summary = null;
  for (let i = 0; i < 200; i += 1) {
    try { const r = await fetch(base + '/api/agent/triage/status'); if (r.ok) { summary = await r.json(); break; } } catch {}
    await sleep(50);
  }
  const actual = summary?.concurrency;
  const good = String(actual) === envValue;
  if (!good) fails += 1;
  console.log(`${good ? '✔' : '✖'} HIDS_TRIAGE_CONCURRENCY=${envValue} -> summary().concurrency=${actual}（queue_limit=${summary?.queue_limit}）`, good ? '' : `| 期望 ${envValue}`);
  srv.kill('SIGKILL');
  await sleep(100);
}
rpc.close(); llm.close(); await rm(temp, { recursive: true, force: true });
console.log(fails ? `✖ 汇总：${fails} 条不成立` : '✔ 汇总：全部成立');
if (fails) process.exitCode = 1;
