// P003-T037 实现席真进程断言（第三轮整改，2026-11-19）：HIDS_TRIAGE_CONCURRENCY 在真进程里生效且回显规范化后的值。
// 契约出处：docs/architecture.md:449（配置项速查）、docs/modules/triage-pipeline.md §5.5 A5、
// openapi.yaml TriageSummary.concurrency、docs/modules/http-api.md（GET /api/agent/triage/status）。
//
// 为什么是真进程：并发度在 server.js 的模块级装配里决定（构造参数优先于 env），
// 进程内 import 拿不到装配后的 monitor，只有起 server.js 再读 /api/agent/triage/status 才算对账。
//
// 断言矩阵（每行 = 一次真进程启动）：
//   poll   HIDS_TRIAGE_CONCURRENCY=1   -> summary().concurrency=1
//   poll   HIDS_TRIAGE_CONCURRENCY=3   -> 3
//   poll   HIDS_TRIAGE_CONCURRENCY=5   -> 5
//   poll   HIDS_TRIAGE_CONCURRENCY=0   -> 2（非法值回落缺省，报规范化后的值）
//   poll   HIDS_TRIAGE_CONCURRENCY=abc -> 2（同上）
//   syslog HIDS_TRIAGE_CONCURRENCY=3   -> 3（两种输入模式同一口径）
// 每行同时断言 queue_limit=7（env 回显链路本身没坏，concurrency 要跟它一致）。
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const repo = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 't37-conc-'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => { const server = http.createServer(); const port = await listen(server); server.close(); return port; };
const freeUdpPort = async () => new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4');
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => resolve(port)); });
});

// 假牧云 RPC：状态接口只探活，不查事件；真被调用也回空列表，不让进程崩。
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').searchParams.get('method') || '';
    const id = JSON.parse(body || '{}').params?.id ?? 1;
    res.end(JSON.stringify({ result: method.endsWith('.GetEvent') ? { event: { id, event_id: id, host_id: 1 } } : { events: [], total: 0 } }));
  });
});
const rpcPort = await listen(rpc);
// 假模型：本探针只看状态接口，模型不会被叫；给一个可达地址，让装配判定「研判链配齐」。
const llm = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))); });
const llmPort = await listen(llm);
const syslogPort = await freeUdpPort();

await cp(repo, temp, { recursive: true,
  filter: source => !/[\\/](\.git|\.data|web|evidence|coding-reports|docs|node_modules)$/.test(source.replace(repo, '')) });

const matrix = [
  { mode: 'poll', env: '1', expected: 1 },
  { mode: 'poll', env: '3', expected: 3 },
  { mode: 'poll', env: '5', expected: 5 },
  { mode: 'poll', env: '0', expected: 2 },
  { mode: 'poll', env: 'abc', expected: 2 },
  { mode: 'syslog', env: '3', expected: 3 }
];

let fails = 0;
const lines = [];
for (const { mode, env, expected } of matrix) {
  const apiPort = await freePort();
  const server = spawn(process.execPath, ['server.js'], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: process.env.HOME, HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort),
    HIDS_TRIAGE_INPUT_MODE: mode, HIDS_TRIAGE_CONCURRENCY: env, HIDS_TRIAGE_QUEUE_MAX: '7',
    HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
    CLOUDWALKER_URL: `http://127.0.0.1:${rpcPort}`, CLOUDWALKER_API_TOKEN: 'test-token',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, LLM_API_KEY: 'sk-test', LLM_MODEL: 'fake' } });
  let output = '';
  server.stdout.on('data', chunk => output += chunk);
  server.stderr.on('data', chunk => output += chunk);
  const base = `http://127.0.0.1:${apiPort}`;
  let summary = null;
  for (let attempt = 0; attempt < 200 && !summary; attempt += 1) {
    try { const response = await fetch(`${base}/api/agent/triage/status`); if (response.ok) summary = await response.json(); } catch {}
    if (!summary) await sleep(50);
  }
  const actual = summary?.concurrency;
  const queueLimit = summary?.queue_limit;
  const ok = actual === expected && queueLimit === 7;
  if (!ok) fails += 1;
  lines.push(`${ok ? '✔' : '✖'} ${mode.padEnd(6)} HIDS_TRIAGE_CONCURRENCY=${env.padEnd(3)} -> summary().concurrency=${actual}`
    + ` queue_limit=${queueLimit}（期望 concurrency=${expected}、queue_limit=7）`
    + (ok ? '' : `\n  --- 进程输出尾部 ---\n${output.split('\n').slice(-6).join('\n')}`));
  server.kill('SIGKILL');
  await sleep(100);
}

rpc.close(); llm.close();
await rm(temp, { recursive: true, force: true });
lines.forEach(line => console.log(line));
console.log(fails ? `✖ 汇总：${fails}/${matrix.length} 条不成立` : `✔ 汇总：${matrix.length}/${matrix.length} 条成立`);
if (fails) process.exitCode = 1;
