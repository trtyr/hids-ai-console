// P003-T032 探针公用件：替身起停、真进程起停、运行态快照/还原、断言计数。
//
// 三条探针都是「替身服务 + 真 server.js 进程」，所以起停与清理只写一份。
// 运行态清理只删「本次探针期间新出现的」文件：起进程会往仓内 .data/ 写东西（server.js:997-1010），
// 探针退场要能收干净，又不能碰别人预置的数据。
import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function checker() {
  const failures = [];
  const ok = (label, extra = '') => process.stdout.write(`PASS ${label}${extra ? ` | ${extra}` : ''}\n`);
  const bad = (label, extra = '') => { failures.push(label);
    process.stdout.write(`FAIL ${label}${extra ? ` | ${extra}` : ''}\n`); };
  const check = (condition, label, extra = '') => (condition ? ok(label, extra) : bad(label, extra));
  return { ok, bad, check, failures, done() { return failures.length === 0; } };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 收集 .data 下的全部文件（含目录），用于快照比对。
async function walk(dir, base = dir, out = new Set()) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.add(`${path.relative(base, full)}/`); await walk(full, base, out); }
    else out.add(path.relative(base, full));
  }
  return out;
}

export async function snapshotData() {
  const dataDir = path.join(repoRoot, '.data');
  const existed = await stat(dataDir).then(() => true, () => false);
  return { dataDir, existed, entries: await walk(dataDir) };
}

// 把本次探针新造的文件删掉；目录留下（空目录也删，让树回到探针来之前的样子）。
export async function restoreData(snapshot) {
  if (!snapshot.existed) return rm(snapshot.dataDir, { recursive: true, force: true });
  const now = await walk(snapshot.dataDir);
  const added = [...now].filter(entry => !snapshot.entries.has(entry) && !entry.endsWith('/'));
  for (const entry of added) await rm(path.join(snapshot.dataDir, entry), { force: true });
  // 新造的空目录（每次退出都重算，父目录删完后子目录列表会变小）
  for (let pass = 0; pass < 5; pass++) {
    const dirs = [...await walk(snapshot.dataDir)].filter(entry => entry.endsWith('/')).sort((a, b) => b.length - a.length);
    let removed = false;
    for (const dir of dirs) {
      const full = path.join(snapshot.dataDir, dir);
      const left = await readdir(full).catch(() => null);
      if (left && left.length === 0) { await rm(full, { recursive: true, force: true }); removed = true; }
    }
    if (!removed) break;
  }
}

// 起替身：读第一行 PORT=<n>，返回 { url, ctl, log, stop }。
export async function startStub() {
  const child = spawn(process.execPath, [path.join(repoRoot, 'evidence/test/P003-T032/stub-muyun.mjs')],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('替身没在 10s 内起来')), 10000);
    child.stdout.on('data', chunk => {
      const match = /PORT=(\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`替身提前退出，code=${code}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url, port,
    ctl: body => fetch(`${url}/__ctl`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).then(response => response.json()),
    log: () => fetch(`${url}/__log`, { signal: AbortSignal.timeout(5000) }).then(response => response.json()),
    async stop() { child.kill('SIGTERM'); }
  };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ createServer }) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    }).catch(reject);
  });
}

// 起真进程：env -i 等价（只给下面这份环境），stdout/stderr 收进内存供断言日志。
export async function startApp({ stubUrl, port, env = {}, logLimit = 400 }) {
  const baseEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_TRIAGE_INPUT_MODE: 'poll',
    CLOUDWALKER_URL: stubUrl, CLOUDWALKER_API_TOKEN: 'stub-token-123456',
    LLM_BASE_URL: `${stubUrl}/v1`, LLM_API_KEY: 'stub-key-abcdef', LLM_MODEL: 'stub-model',
    ...env
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: repoRoot, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const collect = chunk => {
    for (const line of String(chunk).split('\n')) if (line.trim()) {
      lines.push(line);
      if (lines.length > logLimit) lines.shift();
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) { up = true; break; }
    } catch { /* 还没监听 */ }
    await wait(100);
  }
  if (!up) { child.kill('SIGTERM'); throw new Error(`真进程没在 15s 内监听 ${base}\n${lines.join('\n')}`); }
  return {
    base, lines,
    logText: () => lines.join('\n'),
    events: event => lines.filter(line => line.includes(`"event":"${event}"`)).map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    }),
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
  };
}

export const sleep = wait;
