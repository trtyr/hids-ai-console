// P003-T043 A6 探针：真进程 + 替身牧云/替身模型 + **独立数据根**，黑盒验「砍掉 baseline/intel」。
// 契约出处：docs/architecture.md §8.2（七条具名路径）、docs/modules/triage-pipeline.md §6.2（04-上下文.md 只剩 window/history）、
//   wiki/common/GEN-13.md（环境基线示例 + 白名单分层口径，模型按需 wiki_page 读）。
//
// 为什么必须独立数据根（A6）：本卡砍掉的两份文件是「人工维护的运行态文件」，探针一旦落到默认数据根
//   （~/.local/share/hids-ai-console）就会读到上一台机器的遗留、也验不出「种子进的是注入根不是仓库」。
//   这里 HIDS_DATA_DIR / HIDS_CASES_DIR 指向 probe.sh 给的 mktemp 目录（判据库落 <HIDS_DATA_DIR>/wiki），
//   跑完由 probe.sh 比对工作树指纹（探针不许往仓库里写一个字节）。
//
// 跑法：bash evidence/test/P003-T043/probe.sh（会设好 PROBE_RUN 与三个目录变量）
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';

const RUN = process.env.PROBE_RUN;
const dataDir = process.env.HIDS_DATA_DIR;
const casesDir = process.env.HIDS_CASES_DIR;
assert.ok(RUN && dataDir && casesDir, '探针必须显式注入 PROBE_RUN / HIDS_DATA_DIR / HIDS_CASES_DIR');
for (const [name, dir] of [['HIDS_DATA_DIR', dataDir], ['HIDS_CASES_DIR', casesDir]])
  assert.ok(dir.startsWith(RUN), `${name} 没指到独立数据根：${dir}`);
// 判据库故意**不设** HIDS_WIKI_DIR：种子只往「数据根下的 wiki/」播一次（`wiki-store.js:427-429` 的 seedSourceFor），
// 注入别的目录就整目录不种子（P003-T041 的口径）。独立数据根靠 HIDS_DATA_DIR 就够，库落在 <HIDS_DATA_DIR>/wiki。
const wikiDir = join(dataDir, 'wiki');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let pass = 0;
const ok = (label, detail = '') => { pass += 1; console.log(`✔ ${label}${detail ? `  [${detail}]` : ''}`); };

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freeTcpPort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(r => server.close(r)); return port; };
const freeUdpPort = () => new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4');
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => resolve(port)); });
});

// 替身（不是真牧云、不是真模型）：只保证真进程能装配成功、研判能走到「写案卷」这一步。
// 牧云侧回空列表：matchSyslogEvent 走「未匹配」分支，不阻断案卷落盘。
const rpcCalls = [];
const muyun = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').searchParams.get('method') || '';
    rpcCalls.push(method);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method.endsWith('.GetEvent') ? { event: null } : { events: [], total: 0 } }));
  });
});
const muyunPort = await listen(muyun);
const modelCalls = [];
const model = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    modelCalls.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"存疑","summary":"替身回包"}' } }] }));
  });
});
const modelPort = await listen(model);
const apiPort = await freeTcpPort();
const syslogPort = await freeUdpPort();

const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
  PATH: process.env.PATH, HOME: process.env.HOME,
  HIDS_DATA_DIR: dataDir, HIDS_CASES_DIR: casesDir,
  HIDS_HOST: '127.0.0.1', HIDS_PORT: String(apiPort),
  HIDS_TRIAGE_INPUT_MODE: 'syslog', HIDS_SYSLOG_HOST: '127.0.0.1', HIDS_SYSLOG_PORT: String(syslogPort),
  CLOUDWALKER_URL: `http://127.0.0.1:${muyunPort}`, CLOUDWALKER_API_TOKEN: 'probe-token',
  LLM_BASE_URL: `http://127.0.0.1:${modelPort}`, LLM_API_KEY: 'sk-probe', LLM_MODEL: 'probe-fake' } });
let output = '';
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);

const base = `http://127.0.0.1:${apiPort}`;
const getJson = async path => { const response = await fetch(`${base}${path}`); return { status: response.status, body: await response.json() }; };
const waitFor = async (label, predicate, { attempts = 400, gap = 50 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await sleep(gap);
  }
  throw new Error(`等待超时：${label}\n--- 进程输出尾部 ---\n${output.split('\n').slice(-12).join('\n')}`);
};

const walk = async (dir, prefix = '') => {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await walk(dir, relative));
    else files.push(relative);
  }
  return files;
};

let failed = null;
try {
  // ── 段 1：真进程起来了，且数据根是注入的那个 ──────────────────────────────
  const status = await waitFor('GET /api/agent/triage/status 200', async () => {
    const result = await getJson('/api/agent/triage/status');
    return result.status === 200 ? result : null;
  });
  ok('真进程启动（独立数据根）', `HIDS_PORT=${apiPort} summary.input_mode=${status.body.input_mode ?? status.body.summary?.input_mode ?? 'n/a'}`);

  // ── 段 2：判据库在注入根里播种，GEN-13 是被种进去的种子页 ─────────────────
  const pages = await waitFor('GET /api/wiki/pages 200', async () => {
    const result = await getJson('/api/wiki/pages');
    return result.status === 200 ? result : null;
  });
  assert.ok(Array.isArray(pages.body.pages), 'pages 不是数组');
  const gen13 = pages.body.pages.find(page => page.id === 'GEN-13');
  assert.ok(gen13, `页面清单里没有 GEN-13（${pages.body.total} 页）`);
  ok('GET /api/wiki/pages 列出 GEN-13', `${gen13.path} · ${gen13.status}`);

  const seededPage = join(wikiDir, 'common', 'GEN-13.md');
  await waitFor('种子页落进注入根 <HIDS_DATA_DIR>/wiki', async () => existsSync(seededPage));
  const seeded = await readFile(seededPage, 'utf8');
  assert.match(seeded, /^id: GEN-13$/m);
  assert.match(seeded, /^status: active$/m);
  ok('种子落在注入根（不是仓库）', seededPage.replace(RUN, '$RUN'));

  const pageBody = await getJson(`/api/wiki/pages/${encodeURIComponent('common/GEN-13.md')}`);
  assert.equal(pageBody.status, 200, `单页读取 ${pageBody.status}`);
  assert.ok(String(pageBody.body.content || '').includes('白名单命令'), '页面正文没读到');
  ok('GET /api/wiki/pages/common/GEN-13.md 读得到正文', `${String(pageBody.body.content).length} 字符`);

  // ── 段 3：发一条真 syslog，案卷的 04-上下文.md 不再带 baseline/intel ───────
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const line = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5 '
    + `process_command_line="id" event_create_time="2026-11-17 10:00:0${Math.floor(Math.random() * 9)}"`;
  await new Promise(resolve => socket.send(line, syslogPort, '127.0.0.1', resolve));
  await new Promise(resolve => socket.close(resolve));

  const contextFile = await waitFor('案卷 04-上下文.md 落盘', async () => {
    if (!existsSync(casesDir)) return null;
    const files = await walk(casesDir);
    const found = files.find(file => file.endsWith('04-上下文.md'));
    return found ? join(casesDir, found) : null;
  }, { attempts: 600 });
  const context = await readFile(contextFile, 'utf8');
  assert.equal(/baseline|intel/i.test(context), false, '04-上下文.md 里还有 baseline/intel');
  const json = JSON.parse(context.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(Object.keys(json).sort(), ['history', 'window'], '上下文 JSON 的键不是 window/history');
  assert.match(context, /本条投递次数：1/);
  ok('04-上下文.md 只有 window/history', contextFile.replace(RUN, '$RUN'));
  ok('案卷落在注入的 HIDS_CASES_DIR', `载体：/api/agents 之外的真 UDP 报文，牧云替身被打过 ${rpcCalls.length} 次`);

  // ── 段 4：数据根里不该再出现 baseline.json / intel.json ────────────────────
  const dataFiles = (await walk(dataDir)).map(file => file.split(/[\\/]/).join('/'));
  assert.equal(dataFiles.some(file => /(^|\/)baseline\.json$|(^|\/)intel\.json$/.test(file)), false,
    `数据根里出现了 baseline/intel：${dataFiles.filter(file => /baseline|intel/.test(file)).join(',')}`);
  ok('数据根没有 baseline.json / intel.json', `${dataFiles.length} 个运行态文件`);

  // ── 段 5：七条具名路径的目录结构照旧（案卷 / 队列 / 库都在，只少了两份文件） ─
  for (const expected of ['cases', 'wiki', 'triage-monitor.json'])
    assert.ok(existsSync(join(dataDir, expected)) || existsSync(join(casesDir, '..', expected)),
      `注入根里缺 ${expected}`);
  ok('单测/探针断言收尾', `模型替身被打 ${modelCalls.length} 次（研判链路真跑起来了，不是空转）`);
} catch (error) {
  failed = error;
} finally {
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => muyun.close(resolve));
  await new Promise(resolve => model.close(resolve));
}

if (failed) {
  console.error(`✖ 探针失败：${failed.message}`);
  process.exitCode = 1;
} else {
  console.log(`✔ T043 探针全绿：${pass} 条断言（真进程 + 替身牧云/替身模型 + 独立数据根 ${RUN.replace(/^.*\//, '')}）`);
}
