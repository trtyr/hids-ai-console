// P003-T034 tester 集成验收（黑盒：只按 docs/architecture.md §8.1/§8.2/§8.5、docs/modules/http-api.md §2/§3.6/§8、
// docs/modules/knowledge-base.md §5.1/§6/§7 断言；不读实现内容，只打文档写明的接口与真进程）。
//
// 覆盖验收三样（本卡是「落点迁移」类，schema/边界落在数据根解析与落盘契约上）：
//   A1 不设 HIDS_DATA_DIR → <HOME>/.local/share/hids-ai-console/，九条具名路径结构不变；
//   A2 设了就用它（含空白、相对路径边界）；HIDS_WIKI_DIR 注入时判据历史跟判据库走，内置 wiki/ 落数据根；
//   A4 旧位有数据也不迁移；错误码：数据根不可写 → POST /api/config 500 两键，HIDS_DATA_DIR 不在可写五键 → 400。
// 每条外部命令都有上界：fetch 带 AbortSignal.timeout、子进程带 timeout、server 关闭带 5s 强杀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const globalRootOf = home => path.join(home, '.local', 'share', 'hids-ai-console');

// 五项必填全给（形状合法但不是真凭据），指向不可达地址：只验证启动闸门与落点，不探上游。
const REQUIRED_ENV = Object.freeze({
  CLOUDWALKER_URL: 'http://127.0.0.1:1',
  CLOUDWALKER_API_TOKEN: 'fake-token-123456',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_API_KEY: 'fake-key-abcdef',
  LLM_MODEL: 'tester-model'
});

async function tempDir(t, prefix = 'hids-t034-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function listFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(cause => cause.code === 'ENOENT' ? [] : Promise.reject(cause))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(full));
    else found.push(full);
  }
  return found;
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

// 起真进程：env 从零拼（不继承 ambient 的 HIDS_* / HOME），cwd 可换（相对路径边界要用）。
//
// 端口是「先探空闲端口 → 关掉 → 再让子进程 bind」，两步之间端口可能被别的进程抢走：并发套件叠跑时实测撞过
// （子进程一 bind 就死，`listen EADDRINUSE`，用例 300ms 就红）。这不是被测系统的错——撞它就换新端口重起，
// 最多三次；输出里没有 `EADDRINUSE` 的其他死法照旧立刻抛，别把真错盖成重试。
const BOOT_ATTEMPTS = 3;

async function startServer(t, { cwd = repository, env = {}, home, script = 'server.js' } = {}) {
  let failed = '';
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    const childEnv = {
      PATH: process.env.PATH,
      HOME: home,
      HIDS_HOST: '127.0.0.1',
      HIDS_PORT: String(port),
      HIDS_TRIAGE_INPUT_MODE: 'poll',
      ...REQUIRED_ENV,
      ...env
    };
    const proc = spawn(process.execPath, [script], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => proc.once('exit', code => resolve(code)));
    t.after(async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return { base, proc, output: () => output, exited };
      } catch { /* 还没起来 */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    failed = output;
    if (!/EADDRINUSE/.test(output)) break;
    await exited; // 让死掉那一只先收尾
  }
  throw new Error(`server 没起来（cwd=${cwd}）：\n${failed}`);
}

function writeConfig(base, patch) {
  return fetch(`${base}/api/config`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
}

async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// 把后端树复制一份（模块旁有 wiki/＝内置判据库；旧 .data/ 可模拟）：这一份树当「部署目录」用。
async function copyBackend(t, prefix = 'hids-t034-tree-') {
  const dest = await tempDir(t, prefix);
  for (const entry of await readdir(repository, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json' || (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')))) {
      await cp(path.join(repository, entry.name), path.join(dest, entry.name));
    }
  }
  for (const name of ['wiki', 'prompts', 'rules']) {
    await cp(path.join(repository, name), path.join(dest, name), { recursive: true });
  }
  return dest;
}

// 子进程跑一段脚本（ESM）：env 从零拼（不继承 ambient），有 30s 上界；模块路径用 file URL 绝对定位。
async function runNode(t, source, { env = {}, cwd = repository } = {}) {
  const scriptDir = await tempDir(t, 'hids-t034-script-');
  const script = path.join(scriptDir, 'run.mjs');
  await writeFile(script, source);
  const child = spawn(process.execPath, [script], {
    cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise(resolve => child.once('exit', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, `子进程失败：\n${stderr}`);
  return stdout.trim();
}

// 子进程跑「修订一页判据」：update(filename, content, expectedRevision) 是 knowledge-base.md §3 写明的公开方法，
// 历史备份是它的文档行为。模块路径由调用方给。
async function reviseWikiPage(t, { modulePath, env, page = 'common/GEN-01.md', directory = null }) {
  const constructor = directory === null ? 'new WikiStore()' : `new WikiStore(${JSON.stringify(directory)})`;
  const stdout = await runNode(t, [
    `import { WikiStore } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
    `const store = ${constructor};`,
    `const page = await store.get(${JSON.stringify(page)});`,
    `await store.update(${JSON.stringify(page)}, page.content + '\\n', page.revision);`,
    `console.log(JSON.stringify({ directory: store.directory, history: store.historyDirectory }));`
  ].join('\n'), { env });
  return JSON.parse(stdout);
}

async function readIfExists(file) {
  return readFile(file, 'utf8').catch(cause => cause.code === 'ENOENT' ? null : Promise.reject(cause));
}

// ── A1：不设 HIDS_DATA_DIR → 机器全局位置，九条具名路径结构不变 ─────────────
test('A1 真进程不设 HIDS_DATA_DIR：覆盖层落 <HOME>/.local/share/hids-ai-console/，仓库内零写入', async t => {
  const home = await tempDir(t, 'hids-t034-home-');
  const { base } = await startServer(t, { home, env: { LLM_MODEL: 'a1-env-model' } });

  const written = await writeConfig(base, { LLM_MODEL: 'a1-written-model' });
  assert.equal(written.status, 200);
  assert.deepEqual((await written.json()).updated, ['LLM_MODEL']);

  const override = path.join(globalRootOf(home), 'config-overrides.json');
  assert.equal(existsSync(override), true, `覆盖层没落在全局数据根：${override}`);
  assert.deepEqual(JSON.parse(await readFile(override, 'utf8')), { LLM_MODEL: 'a1-written-model' });
  assert.equal((await stat(override)).mode & 0o777, 0o600, '覆盖层权限不是 0600');

  // 写后 GET 立刻反映（http-api.md §3.6「写完之后的三件事」第 1 条）
  assert.equal((await getJson(base, '/api/config')).body.model.name, 'a1-written-model');
  // A3：仓库工作树里零运行时写入
  assert.equal(existsSync(path.join(repository, '.data')), false, '跑测试时仓库里出现了 .data/');
});

test('A1 八条具名路径的结构与文档表一致，且默认根不在仓库内', async () => {
  const { runtimePaths } = await import(pathToFileURL(path.join(repository, 'server.js')).href);
  const { dataRoot } = await import(pathToFileURL(path.join(repository, 'config-store.js')).href);

  const root = '/tmp/hids-doc-root';
  const expected = {
    data: root,
    investigations: path.join(root, 'investigations'),
    triageRules: path.join(root, 'triage-rules.json'),
    triageMonitor: path.join(root, 'triage-monitor.json'),
    cases: path.join(root, 'cases'),
    wikiSessions: path.join(root, 'wiki-sessions'),
    // P003-T047 加了误报维护会话（`<数据根>/fp-sessions/`），T043 之后的七条变八条。
    fpSessions: path.join(root, 'fp-sessions'),
    traceBoards: path.join(root, 'trace-boards')
  };
  // P003-T043 A1：原九条里的 `baseline`/`intel` 两键已砍（研判背景走判据库与规则层）；
  // P003-T047 加 `fpSessions`，现在是八条。
  assert.deepEqual(runtimePaths(root), expected, 'runtimePaths 的八条具名路径结构与文档表不符');

  // architecture.md §8.1 的解析代码块：不设 → <home>/.local/share/hids-ai-console；不读 XDG_DATA_HOME
  assert.equal(dataRoot({ env: {}, home: '/home/someone' }), '/home/someone/.local/share/hids-ai-console');
  assert.equal(dataRoot({ env: { XDG_DATA_HOME: '/tmp/xdg' }, home: '/home/someone' }),
    '/home/someone/.local/share/hids-ai-console', 'XDG_DATA_HOME 不该影响数据根');
  for (const value of Object.values(runtimePaths())) {
    assert.equal(path.relative(repository, value).startsWith('..'), true, `${value} 落在仓库内`);
  }
});

// ── A2：注入临时数据根，一个字节都不写全局根；重启仍生效 ───────────────────
test('A2 HIDS_DATA_DIR 注入：落点全在注入根、HOME 全局根不被创建、重启后改过的值仍生效', async t => {
  const data = await tempDir(t, 'hids-t034-data-');
  const home = path.join(await tempDir(t, 'hids-t034-home-'), 'never-created');
  const env = { HIDS_DATA_DIR: data, LLM_MODEL: 'a2-env-model' };

  const first = await startServer(t, { home, env });
  assert.equal((await writeConfig(first.base, { LLM_MODEL: 'a2-written-model' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(data, 'config-overrides.json'), 'utf8')), { LLM_MODEL: 'a2-written-model' });
  assert.equal(existsSync(home), false, '注入数据根时仍写了真实全局根');
  assert.equal(existsSync(path.join(repository, '.data')), false);

  const second = await startServer(t, { home, env });
  assert.equal((await getJson(second.base, '/api/config')).body.model.name, 'a2-written-model', '重启后没从数据根读回覆盖层');
});

test('A2 只认 HIDS_DATA_DIR：HIDS_WIKI_DIR / HIDS_PROMPT_STORE_FILE 不改数据根', async t => {
  const home = await tempDir(t, 'hids-t034-home-');
  const deploy = await tempDir(t, 'hids-t034-deploy-');
  const externalWiki = path.join(deploy, 'wiki');
  await cp(path.join(repository, 'wiki'), externalWiki, { recursive: true });
  const promptFile = path.join(deploy, 'prompt-overrides.json');

  const { base } = await startServer(t, {
    home,
    env: { HIDS_WIKI_DIR: externalWiki, HIDS_PROMPT_STORE_FILE: promptFile }
  });
  assert.equal((await writeConfig(base, { LLM_MODEL: 'a2-other-keys' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(globalRootOf(home), 'config-overrides.json'), 'utf8')),
    { LLM_MODEL: 'a2-other-keys' });
  assert.equal(existsSync(promptFile), false, '覆盖层被写到 HIDS_PROMPT_STORE_FILE 指的目录了');
});

test('A2 空串与纯空白算「没设」（与 HIDS_CASES_DIR 同口径）', async t => {
  for (const value of ['', '   ', '\t\n']) {
    const home = await tempDir(t, 'hids-t034-home-');
    const { base } = await startServer(t, { home, env: { HIDS_DATA_DIR: value } });
    assert.equal((await writeConfig(base, { LLM_MODEL: 'a2-blank' })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(path.join(globalRootOf(home), 'config-overrides.json'), 'utf8')),
      { LLM_MODEL: 'a2-blank' }, `取值 ${JSON.stringify(value)} 没按「没设」处理`);
  }
});

test('A2 相对路径按进程工作目录绝对化', async t => {
  const cwd = await tempDir(t, 'hids-t034-cwd-');
  const home = await tempDir(t, 'hids-t034-home-');
  const { base } = await startServer(t, {
    cwd,
    home,
    script: path.join(repository, 'server.js'),
    env: { HIDS_DATA_DIR: 'rel/data' }
  });
  assert.equal((await writeConfig(base, { LLM_MODEL: 'a2-relative' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'rel', 'data', 'config-overrides.json'), 'utf8')),
    { LLM_MODEL: 'a2-relative' });
  assert.equal(existsSync(globalRootOf(home)), false, '相对路径没绝对化：又写了全局根');
});

// ── A2/A5：判据历史两条路（本轮复审核心：HIDS_WIKI_DIR 注入 vs 内置 wiki/）────
test('A2/A5 HIDS_WIKI_DIR 注入：判据历史落判据库同级 .data/wiki-history，不落数据根', async t => {
  const deploy = await tempDir(t, 'hids-t034-deploy-');
  const externalWiki = path.join(deploy, 'wiki');
  await cp(path.join(repository, 'wiki'), externalWiki, { recursive: true });
  const home = await tempDir(t, 'hids-t034-home-');
  const data = path.join(await tempDir(t, 'hids-t034-data-'), 'root');
  const original = await readFile(path.join(repository, 'wiki', 'common', 'GEN-01.md'), 'utf8');

  await reviseWikiPage(t, {
    modulePath: path.join(repository, 'wiki-store.js'),
    env: { HOME: home, HIDS_DATA_DIR: data, HIDS_WIKI_DIR: externalWiki }
  });

  const historyDir = path.join(deploy, '.data', 'wiki-history');
  const history = await listFiles(historyDir);
  assert.equal(history.length, 1, `判据历史没落在判据库同级 .data/wiki-history（${historyDir}）`);
  assert.match(path.basename(history[0]), /^GEN-01-[0-9a-f]{16}\.md$/);
  assert.equal(existsSync(path.join(data, 'wiki-history')), false, 'HIDS_WIKI_DIR 注入时历史仍落数据根（上一轮那个 bug）');
  assert.equal(existsSync(path.join(home, '.local', 'share')), false, '注入了 HIDS_DATA_DIR，却还写了全局根');
  // 修订只动副本：仓库里的判据页与仓库 .data 都没变
  assert.equal(await readFile(path.join(repository, 'wiki', 'common', 'GEN-01.md'), 'utf8'), original);
  assert.equal(existsSync(path.join(repository, '.data')), false);
});

test('A2/A5 构造参数注入判据库目录：历史同样跟判据库走（同级 .data/wiki-history）', async t => {
  const deploy = await tempDir(t, 'hids-t034-deploy-');
  const externalWiki = path.join(deploy, 'wiki');
  await cp(path.join(repository, 'wiki'), externalWiki, { recursive: true });
  const home = await tempDir(t, 'hids-t034-home-');
  const data = path.join(await tempDir(t, 'hids-t034-data-'), 'root');

  await reviseWikiPage(t, {
    modulePath: path.join(repository, 'wiki-store.js'),
    directory: externalWiki,
    env: { HOME: home, HIDS_DATA_DIR: data }
  });
  assert.equal((await listFiles(path.join(deploy, '.data', 'wiki-history'))).length, 1);
  assert.equal(existsSync(path.join(data, 'wiki-history')), false);
});

test('A1/A5 内置 wiki/：判据历史落数据根 wiki-history/，部署目录里不出现 .data', async t => {
  const tree = await copyBackend(t);
  const home = await tempDir(t, 'hids-t034-home-');
  await reviseWikiPage(t, {
    modulePath: path.join(tree, 'wiki-store.js'),
    env: { HOME: home } // 不设 HIDS_DATA_DIR、不设 HIDS_WIKI_DIR → 内置 wiki/ + 默认数据根
  });
  const historyDir = path.join(globalRootOf(home), 'wiki-history');
  const history = await listFiles(historyDir);
  assert.equal(history.length, 1, `内置 wiki/ 的历史没落数据根 wiki-history/（${historyDir}）`);
  assert.match(path.basename(history[0]), /^GEN-01-[0-9a-f]{16}\.md$/);
  assert.equal(existsSync(path.join(tree, '.data')), false, '内置 wiki/ 时历史写回了部署目录');
});

test('A2/A5 提示词覆盖文件默认落数据根；HIDS_PROMPT_STORE_FILE 仍优先', async t => {
  const home = await tempDir(t, 'hids-t034-home-');
  const data = path.join(await tempDir(t, 'hids-t034-data-'), 'root');
  const script = [
    `import { PromptStore } from ${JSON.stringify(pathToFileURL(path.join(repository, 'prompt-store.js')).href)};`,
    'const store = new PromptStore();',
    'const loaded = await store.load();',
    "await store.update('triage', loaded.prompts.triage, loaded.revision);",
    'console.log(JSON.stringify({ filename: store.filename }));'
  ].join('\n');
  const printed = JSON.parse(await runNode(t, script, { env: { HOME: home, HIDS_DATA_DIR: data } }));
  assert.equal(printed.filename, path.join(data, 'prompt-overrides.json'));
  const override = JSON.parse(await readFile(path.join(data, 'prompt-overrides.json'), 'utf8'));
  assert.deepEqual(Object.keys(override), ['triage'], '覆盖文件不该只写 triage 这一个键之外的默认值');
  assert.equal(existsSync(path.join(repository, '.data')), false);

  // 文档 §1.3：HIDS_PROMPT_STORE_FILE 配了就用它（优先于数据根）
  const custom = path.join(await tempDir(t, 'hids-t034-prompt-'), 'custom', 'prompt-overrides.json');
  const data2 = path.join(await tempDir(t, 'hids-t034-data-'), 'root');
  const printed2 = JSON.parse(await runNode(t, script, {
    env: { HOME: home, HIDS_DATA_DIR: data2, HIDS_PROMPT_STORE_FILE: custom }
  }));
  assert.equal(printed2.filename, custom);
  assert.equal(existsSync(custom), true, 'HIDS_PROMPT_STORE_FILE 指的文件没被写');
  assert.equal(existsSync(path.join(data2, 'prompt-overrides.json')), false, '环境变量指了覆盖文件，却还写了数据根');
});

// ── A4：旧位不迁移 ────────────────────────────────────────────────────────
test('A4 旧位（仓内 .data/ 与 backend/.data/）里躺着数据时，数据根不被自动填充', async t => {
  const tree = await copyBackend(t);
  const oldInRepo = path.join(tree, '.data');
  await mkdir(path.join(oldInRepo, 'investigations'), { recursive: true });
  await writeFile(path.join(oldInRepo, 'investigations', 'old.json'), '{"from":"repo-data"}');
  await writeFile(path.join(oldInRepo, 'triage-rules.json'), '{"from":"old-rules"}');
  const oldBackend = path.join(tree, 'backend', '.data', 'cases', 'old');
  await mkdir(oldBackend, { recursive: true });
  await writeFile(path.join(oldBackend, '01-原始告警.txt'), 'old case');
  const sentinels = {
    investigations: sha256(await readFile(path.join(oldInRepo, 'investigations', 'old.json'), 'utf8')),
    rules: sha256(await readFile(path.join(oldInRepo, 'triage-rules.json'), 'utf8')),
    case: sha256(await readFile(path.join(oldBackend, '01-原始告警.txt'), 'utf8'))
  };

  const data = path.join(await tempDir(t, 'hids-t034-data-'), 'root');
  const home = await tempDir(t, 'hids-t034-home-');
  const { base } = await startServer(t, { cwd: tree, home, env: { HIDS_DATA_DIR: data } });
  assert.equal((await writeConfig(base, { LLM_MODEL: 'a4-written' })).status, 200);

  // 数据根里只能有进程自己写的运行态：本次写配置的 config-overrides.json，以及研判监控的队列快照
  // （P003-T036/T037：poll 模式冷启动就会落自己的 triage-monitor.json，与旧位毫无关系）。
  // 旧位的东西一样都不许出现：没有 investigations/、cases/、triage-rules.json 被预建或搬过来，
  // 也没有任何一份文件与旧位内容逐字相同。
  const written = await listFiles(data);
  assert.deepEqual(written.map(file => path.relative(data, file)).filter(rel => !['config-overrides.json', 'triage-monitor.json'].includes(rel)),
    [], '数据根被旧位数据填充了（预建目录或迁移）');
  for (const file of written) {
    const digest = sha256(await readFile(file, 'utf8'));
    assert.equal(Object.values(sentinels).includes(digest), false,
      `数据根里的 ${path.relative(data, file)} 与旧位某份数据逐字相同（迁移了）`);
  }
  const snapshot = JSON.parse(await readFile(path.join(data, 'triage-monitor.json'), 'utf8'));
  assert.deepEqual(snapshot.records, [], '冷启动快照里带着记录：旧位数据被搬进来了');
  assert.equal(existsSync(path.join(data, 'investigations', 'old.json')), false);
  assert.equal(existsSync(path.join(data, 'cases')), false);
  assert.equal(existsSync(path.join(data, 'triage-rules.json')), false, '旧位的 triage-rules.json 被搬进了数据根');
  // 旧位原样未动
  assert.deepEqual((await readdir(oldInRepo)).sort(), ['investigations', 'triage-rules.json']);
  assert.equal(sha256(await readFile(path.join(oldInRepo, 'investigations', 'old.json'), 'utf8')), sentinels.investigations);
  assert.equal(sha256(await readFile(path.join(oldInRepo, 'triage-rules.json'), 'utf8')), sentinels.rules);
  assert.equal(sha256(await readFile(path.join(oldBackend, '01-原始告警.txt'), 'utf8')), sentinels.case);
});

// ── 边界与错误码：数据根不可用时的契约（http-api.md §3.6 / §8）──────────────
test('错误码 500：数据根不可写 → POST /api/config 回 internal_error 两键，进程不死', async t => {
  // 这个目录要先恢复权限再删：单独一条 cleanup 钩子，免得 tempDir 的删除跑在 chmod 之前。
  const locked = await mkdtemp(path.join(tmpdir(), 'hids-t034-ro-'));
  t.after(async () => {
    await chmod(locked, 0o700).catch(() => {});
    await rm(locked, { recursive: true, force: true });
  });
  await chmod(locked, 0o500);
  const data = path.join(locked, 'data');
  const home = await tempDir(t, 'hids-t034-home-');

  const { base } = await startServer(t, { home, env: { HIDS_DATA_DIR: data } });
  const response = await writeConfig(base, { LLM_MODEL: 'locked-model' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: '服务器内部错误', code: 'internal_error' }, '500 正文形状或文案不符');
  assert.equal(JSON.stringify(body).includes(locked), false, '500 正文漏出了文件路径');
  assert.equal(JSON.stringify(body).includes('EACCES'), false, '500 正文漏出了异常原文');
  // 失败时什么都不变 + 进程照常
  assert.equal((await getJson(base, '/api/config')).body.model.name, 'tester-model');
  assert.equal(existsSync(data), false, '落盘失败后数据根留下了半套东西');
});

test('错误码 400：HIDS_DATA_DIR 不在可写五键里（写明要重启）', async t => {
  const data = await tempDir(t, 'hids-t034-data-');
  const home = await tempDir(t, 'hids-t034-home-');
  const { base } = await startServer(t, { home, env: { HIDS_DATA_DIR: data } });
  const response = await writeConfig(base, { HIDS_DATA_DIR: '/tmp/hijack' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'caller_error');
  assert.match(body.error, /HIDS_DATA_DIR/, '400 原话没点键名');
  assert.equal(existsSync(path.join(data, 'config-overrides.json')), false, '被拒的写留下了覆盖层');
});

test('边界：HIDS_DATA_DIR 指向一个普通文件 → 进程仍可服务，写回落盘失败（文档未写，记为残余风险）', async t => {
  const baseDir = await tempDir(t, 'hids-t034-file-');
  const file = path.join(baseDir, 'not-a-directory');
  await writeFile(file, 'x');
  const home = await tempDir(t, 'hids-t034-home-');
  const { base } = await startServer(t, { home, env: { HIDS_DATA_DIR: file } });
  assert.equal((await getJson(base, '/api/config')).status, 200, '数据根指到文件时进程不该整个死掉');
  const response = await writeConfig(base, { LLM_MODEL: 'file-root-model' });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '服务器内部错误', code: 'internal_error' });
});
