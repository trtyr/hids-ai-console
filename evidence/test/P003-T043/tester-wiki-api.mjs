// P003-T043 测试者（gc-backend-tester）自写黑盒 e2e：真进程 + 独立数据根，按
// docs/modules/http-api.md §3.1 / §7、docs/modules/knowledge-base.md §7.1-7.2 断言
// 「GEN-13 作为种子页经 HTTP 可达」这条对外可见面（A3 的接口侧），顺带把知识库列表的
// schema / 边界 / 4xx 各触发一遍。
//
// 跑法：timeout 120 node evidence/test/P003-T043/tester-wiki-api.mjs
// 退出码 0 = 全绿；非 0 = 有断言红。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const run = await mkdtemp(path.join(tmpdir(), 't043-tester-'));
const dataDir = path.join(run, 'data');
const casesDir = path.join(run, 'cases');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const server = http.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const port = await freePort();
// 五项必填（http-api.md §2）给占位值：闸门只判「在不在、形状对不对」，不探上游。
const child = spawn(process.execPath, ['server.js'], {
  cwd: repository, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    HIDS_DATA_DIR: dataDir, HIDS_CASES_DIR: casesDir,
    HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
    HIDS_TRIAGE_INPUT_MODE: 'poll',
    CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: 'tester-token',
    LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: 'sk-tester', LLM_MODEL: 'tester-fake'
  }
});
let output = '';
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);

const base = `http://127.0.0.1:${port}`;
const request = async urlPath => {
  const response = await fetch(`${base}${urlPath}`);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
};

let pass = 0;
const ok = (label, detail = '') => { pass += 1; console.log(`✔ ${label}${detail ? `  [${detail}]` : ''}`); };
const walk = async (dir, prefix = '') => {
  if (!existsSync(dir)) return [];
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await walk(dir, relative));
    else files.push(relative);
  }
  return files;
};

let failed = null;
try {
  let listed = null;
  for (let attempt = 0; attempt < 300 && !listed; attempt += 1) {
    try {
      const candidate = await request('/api/wiki/pages');
      if (candidate.status === 200) listed = candidate;
    } catch {}
    if (!listed) await sleep(50);
  }
  assert.ok(listed, `真进程没起来\n${output.split('\n').slice(-10).join('\n')}`);
  ok('真进程起来（独立数据根 HIDS_DATA_DIR）', `HIDS_PORT=${port}`);

  // ── schema：{pages,total}，页面元数据字段齐、列表不带 content ──────────────
  assert.ok(Array.isArray(listed.body.pages), 'pages 不是数组');
  assert.equal(typeof listed.body.total, 'number', 'total 不是数字');
  assert.equal(listed.body.total, listed.body.pages.length, 'count 缺省时不切页，total 应等于页内条数');
  for (const page of listed.body.pages) {
    for (const field of ['path', 'id', 'title', 'status', 'updated', 'revision', 'characters'])
      assert.equal(field in page, true, `页面元数据缺字段 ${field}：${page.path}`);
    assert.equal('content' in page, false, `列表项不该带 content：${page.path}`);
    assert.ok(['active', 'draft', 'deprecated', 'reference'].includes(page.status), `status 越界：${page.status}`);
    assert.match(page.revision, /^[0-9a-f]{16}$/, `revision 不是 16 位十六进制：${page.revision}`);
  }
  ok('GET /api/wiki/pages schema 符合 §7.1', `${listed.body.total} 页，元数据 7 字段齐、无 content`);

  const gen13 = listed.body.pages.find(page => page.id === 'GEN-13');
  assert.ok(gen13, '页面清单里没有 GEN-13');
  assert.equal(gen13.path, 'common/GEN-13.md');
  assert.equal(gen13.status, 'active', 'GEN-13 不是 active，智能体读不到');
  assert.match(gen13.title, /环境基线/);
  ok('GEN-13 在列表里且 active', `${gen13.path} · characters=${gen13.characters}`);

  // ── 单页读取：正文带 A4 分层口径 ────────────────────────────────────────
  const page = await request('/api/wiki/pages/common/GEN-13.md');
  assert.equal(page.status, 200, `单页读取 ${page.status}`);
  assert.equal(page.body.path, 'common/GEN-13.md');
  assert.equal(page.body.id, 'GEN-13');
  assert.equal(page.body.revision, gen13.revision, '列表与单页 revision 不一致');
  for (const marker of ['规则层（硬判定）', '场景提示（不是判定层）', '研判参考', '不自动关闭、不加白、不处置'])
    assert.ok(String(page.body.content).includes(marker), `正文缺口径：${marker}`);
  ok('GET /api/wiki/pages/common/GEN-13.md 正文含分层口径', `${page.body.characters} 字符`);

  // ── 错误码：不存在的页 404；分页参数 4xx ─────────────────────────────────
  const missing = await request('/api/wiki/pages/common/GEN-99.md');
  assert.equal(missing.status, 404, `不存在的页应 404，实测 ${missing.status}`);
  ok('不存在的页 404', JSON.stringify(missing.body).slice(0, 60));

  for (const bad of ['count=abc', 'count=0', 'count=51', 'count=20.5', 'offset=-1', 'offset=1.5']) {
    const result = await request(`/api/wiki/pages?${bad}`);
    assert.equal(result.status, 400, `${bad} 应 400，实测 ${result.status}`);
    assert.equal(result.body.error, '分页参数无效', `${bad} 的 400 正文形状不符：${JSON.stringify(result.body)}`);
  }
  ok('分页边界 6 条全 400 + {"error":"分页参数无效"}', 'count=abc/0/51/20.5，offset=-1/1.5');

  const one = await request('/api/wiki/pages?count=1');
  assert.equal(one.status, 200);
  assert.equal(one.body.pages.length, 1, 'count=1 没切页');
  assert.equal(one.body.total, listed.body.total, 'total 应是切页前条数');
  const beyond = await request('/api/wiki/pages?offset=10000');
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.pages, [], 'offset 越界应回空页');
  assert.equal(beyond.body.total, listed.body.total, 'offset 越界 total 应不变');
  ok('count=1 切页 / offset 越界空页', `total=${one.body.total}`);

  // ── 种子与运行态残留：库在注入根，数据根没有 baseline/intel ───────────────
  assert.ok(existsSync(path.join(dataDir, 'wiki', 'common', 'GEN-13.md')), '种子没落进注入根');
  assert.ok(existsSync(path.join(repository, 'wiki', 'common', 'GEN-13.md')), '仓内种子页缺失');
  const seeded = await readFile(path.join(dataDir, 'wiki', 'common', 'GEN-13.md'), 'utf8');
  assert.match(seeded, /^status: active$/m);
  const dataFiles = (await walk(dataDir)).map(file => file.split(path.sep).join('/'));
  assert.equal(dataFiles.some(file => /(^|\/)(baseline|intel)\.json$/.test(file)), false,
    `数据根出现 baseline/intel：${dataFiles.filter(file => /baseline|intel/.test(file))}`);
  ok('种子落注入根、数据根无 baseline.json/intel.json', `${dataFiles.length} 个运行态文件`);
} catch (error) {
  failed = error;
} finally {
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  await rm(run, { recursive: true, force: true });
}

if (failed) {
  console.error(`✖ tester-wiki-api 失败：${failed.message}`);
  process.exitCode = 1;
} else {
  console.log(`✔ P003-T043 测试者 e2e 全绿：${pass} 组断言`);
}
