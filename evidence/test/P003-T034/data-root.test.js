import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot, defaultConfigFile } from '../../../src/contexts/dataops/infrastructure/config-store.js';
import { runtimePaths } from '../../../server.js';
import { PromptStore } from '../../../src/contexts/knowledge/infrastructure/prompt-store.js';
import { WikiStore } from '../../../src/contexts/knowledge/infrastructure/wiki-store.js';
import { UpdateStore } from '../../../src/contexts/dataops/infrastructure/update-store.js';

// P003-T034：数据根迁出仓库——`HIDS_DATA_DIR` 指向机器全局位置。
//   A1 不设 HIDS_DATA_DIR → `~/.local/share/hids-ai-console/`，九条具名路径结构不变
//   A2 设了就用它；测试与探针全部注入临时目录，没有一个写真实全局根
//   A3 仓库内零运行时写入（服务端的九个落点 + 提示词覆盖 + 升级包 + 判据历史都不在仓库里）
//   A4 仓内旧 `.data/` 与旧 `backend/.data/` 不由代码自动迁移
// 本文件只测「根算在哪」与「各模块默认落点跟不跟着根」；九条路径的结构映射见
// `evidence/test/P003-T019/data-dir.test.js`。「跑完全套后工作树里没有 .data/」是环境鞍点，用报告里的命令核。
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const globalRoot = path.join('/home/someone', '.local', 'share', 'hids-ai-console');

// ── A1/A2：数据根的解析规则 ────────────────────────────────────────────────
test('A1 不设 HIDS_DATA_DIR：数据根是 <HOME>/.local/share/hids-ai-console', () => {
  assert.equal(dataRoot({ env: {}, home: '/home/someone' }), globalRoot);
  // 只认 HIDS_DATA_DIR 一个键：别的 HIDS_* 变量不许把根带偏。
  assert.equal(dataRoot({ env: { HIDS_CASES_DIR: '/tmp/cases', HIDS_WIKI_DIR: '/tmp/wiki' }, home: '/home/someone' }),
    globalRoot);
});

test('A2 设了 HIDS_DATA_DIR 就用它（相对路径按工作目录绝对化）', () => {
  assert.equal(dataRoot({ env: { HIDS_DATA_DIR: '/var/lib/hids' }, home: '/home/someone' }), '/var/lib/hids');
  assert.equal(dataRoot({ env: { HIDS_DATA_DIR: '  /var/lib/hids  ' }, home: '/home/someone' }), '/var/lib/hids');
  assert.equal(dataRoot({ env: { HIDS_DATA_DIR: 'relative/data' }, home: '/home/someone' }),
    path.resolve('relative/data'), '相对路径要绝对化，进程换了工作目录不该换落点');
});

test('A2 空串与纯空白算「没设」（与 HIDS_CASES_DIR 同一个口径），不落成本目录', () => {
  for (const value of ['', '   ', '\t\n']) {
    assert.equal(dataRoot({ env: { HIDS_DATA_DIR: value }, home: '/home/someone' }), globalRoot, `取值 ${JSON.stringify(value)}`);
  }
});

test('A2 默认根不是仓库内路径：九条路径一条都不在仓库里', () => {
  const root = dataRoot();
  assert.ok(path.relative(repository, root).startsWith('..'), `数据根跑进了仓库：${root}`);
  for (const [name, value] of Object.entries(runtimePaths())) {
    assert.ok(path.relative(repository, value).startsWith('..'), `${name} 落在仓库内：${value}`);
    assert.ok(!value.split(path.sep).includes('.data'), `${name} 还带着仓内 .data 段：${value}`);
    assert.ok(!value.split(path.sep).includes('backend'), `${name} 还带着 backend 段：${value}`);
  }
});

// ── A2/A3：其它运行态落点也跟着数据根走（本卡一并搬的三处） ─────────────────
test('A3 覆盖层文件默认落数据根下（不注入 file 时）', () => {
  assert.equal(defaultConfigFile(), path.join(dataRoot(), 'config-overrides.json'));
  assert.equal(defaultConfigFile('/tmp/root'), '/tmp/root/config-overrides.json');
});

test('A3 提示词覆盖文件默认落数据根下；HIDS_PROMPT_STORE_FILE 仍然优先', () => {
  const bare = new PromptStore();
  assert.equal(bare.filename, process.env.HIDS_PROMPT_STORE_FILE || path.join(dataRoot(), 'prompt-overrides.json'));
  assert.ok(path.relative(repository, bare.filename).startsWith('..'), `提示词覆盖文件写进了仓库：${bare.filename}`);
});

test('A3 升级包目录跟着提示词覆盖文件所在目录走 → 数据根下 update-packages/', () => {
  assert.equal(new UpdateStore(new PromptStore()).directory, path.join(dataRoot(), 'update-packages'));
  // 外部指定 HIDS_UPDATE_STORE_DIR / 构造参数时照旧覆盖（不由本卡改口径）。
  assert.equal(new UpdateStore(new PromptStore(), { directory: '/tmp/pkgs' }).directory, '/tmp/pkgs');
});

test('A3 判据历史：内置 wiki/ 的备份落数据根下 wiki-history/；构造参数注入的判据库目录仍跟它同级', () => {
  assert.equal(new WikiStore().historyDirectory, path.join(dataRoot(), 'wiki-history'));
  // 注入目录（单测的 tmp 目录、构造参数）保持 P003-T019 之前的口径：备份在判据库目录同级 .data/wiki-history/。
  // 这一条同时是 A2 的钉子：单测传 tmp 判据库时不会往真实全局根写备份。
  assert.equal(new WikiStore(path.join('/tmp/some', 'wiki')).historyDirectory,
    path.join('/tmp/some', '.data', 'wiki-history'));
  assert.equal(new WikiStore('/tmp/some/wiki', { historyDirectory: '/tmp/hist' }).historyDirectory, '/tmp/hist');
});

test('A3 判据历史：HIDS_WIKI_DIR 换掉判据库目录时，备份跟着判据库走（同级 .data/wiki-history/），不落数据根', async t => {
  // 这条钉的是上一轮漏网的 bug：拿 `directory === defaultDirectory` 判「内置」，HIDS_WIKI_DIR 一设就把
  // 外部目录当内置，历史落到数据根。module 在加载时读 env，所以设完 env 用带 query 的 import 拿一份新实例。
  const wikiDirectory = path.join('/tmp/hids-deploy', 'wiki');
  const previous = process.env.HIDS_WIKI_DIR;
  process.env.HIDS_WIKI_DIR = wikiDirectory;
  t.after(() => {
    if (previous === undefined) delete process.env.HIDS_WIKI_DIR;
    else process.env.HIDS_WIKI_DIR = previous;
  });
  const fresh = await import(`../../../src/contexts/knowledge/infrastructure/wiki-store.js?hids-wiki-dir=${Date.now()}`);
  const store = new fresh.WikiStore();
  assert.equal(store.directory, wikiDirectory, 'HIDS_WIKI_DIR 没被当成缺省判据库目录');
  assert.equal(store.historyDirectory, path.join('/tmp/hids-deploy', '.data', 'wiki-history'),
    'HIDS_WIKI_DIR 注入时历史没跟判据库目录走（落数据根＝上一轮的 bug）');
  assert.notEqual(store.historyDirectory, path.join(dataRoot(), 'wiki-history'));
  // 回归钉子：判「内置」不许再拿 env 可改的 defaultDirectory 比。
  const source = await readFile(path.join(repository, 'src/contexts/knowledge/infrastructure/wiki-store.js'), 'utf8');
  assert.ok(!/directory === defaultDirectory/.test(source),
    'wiki-store.js 又拿 defaultDirectory 判「内置」——HIDS_WIKI_DIR 一设历史就会落到数据根');
});

// ── A2：测试与探针注入临时目录（静态钉子，防止将来加一个不注入的） ─────────────
const testRoot = path.join(repository, 'evidence', 'test');

async function filesUnder(directory, suffix) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full, suffix));
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

test('A2 所有起真进程 server.js 的测试都注入了 HIDS_DATA_DIR', async () => {
  const offenders = [];
  const candidates = [...await filesUnder(testRoot, '.js'),
    ...(await readdir(repository, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
      .map(entry => path.join(repository, entry.name))];
  for (const file of candidates) {
    const source = await readFile(file, 'utf8');
    if (!/spawn\(process\.execPath,\s*\['server\.js'\]/.test(source)) continue;
    if (!source.includes('HIDS_DATA_DIR')) offenders.push(path.relative(repository, file));
  }
  assert.deepEqual(offenders, [], '这些测试起真进程却没用 HIDS_DATA_DIR 注入临时数据根');
});

test('A2 两个真进程探针都注入 mktemp 出来的数据根，且不再写仓内 .data/', async () => {
  for (const name of ['probe-config-write.sh', 'probe-corrupt-and-auth.sh']) {
    const source = await readFile(path.join(testRoot, 'P003-T029', name), 'utf8');
    assert.match(source, /DATA=\$\(mktemp -d\)/, `${name} 没有建临时数据根`);
    assert.match(source, /HIDS_DATA_DIR="?\$DATA"?/, `${name} 起进程时没注入 HIDS_DATA_DIR`);
    assert.ok(!source.includes('$ROOT/.data'), `${name} 里还在写仓内 .data/`);
    assert.ok(!/OVERRIDE="\$ROOT\//.test(source), `${name} 的覆盖层文件还落在仓库里`);
  }
});

// ── A4：旧位不自动迁移 ───────────────────────────────────────────────────
test('A4 四个落点定义文件里没有把落点算回仓库的代码（更不会有搬旧数据的代码）', async () => {
  for (const name of ['src/contexts/dataops/infrastructure/config-store.js', 'src/contexts/knowledge/infrastructure/prompt-store.js', 'src/contexts/knowledge/infrastructure/wiki-store.js', 'server.js']) {
    const source = await readFile(path.join(repository, name), 'utf8');
    assert.ok(!/path\.join\(defaults,\s*'\.data'/.test(source), `${name} 里还把落点拼成 <模块目录>/.data`);
    assert.ok(!/path\.resolve\(\w+,\s*'\.\.'\)/.test(source), `${name} 里还把落点算成上一级目录`);
    assert.ok(!source.includes("'backend'"), `${name} 里还有旧位 'backend' 路径段`);
  }
  // wiki-store 给外部注入的判据库目录保留了同级 `.data/wiki-history/`（见上一条用例），那是判据库自己的备份位置，
  // 不是仓库落点；内置 `wiki/` 的备份已改到数据根。
  assert.ok(!(await readFile(path.join(repository, 'src/contexts/knowledge/infrastructure/wiki-store.js'), 'utf8'))
    .includes("path.join(dataRoot(), '.data')"), 'wiki-store 又把数据根拼成 <数据根>/.data 了');
});

test('A4 旧位目录里躺着数据时，数据根不被自动填充（不建目录、不拷贝）', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'hids-migrate-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const oldRepo = path.join(base, 'old-repo');
  await mkdir(path.join(oldRepo, '.data', 'investigations'), { recursive: true });
  await writeFile(path.join(oldRepo, '.data', 'investigations', 'old.json'), '{"from":"old"}');
  await mkdir(path.join(base, 'backend', '.data', 'cases'), { recursive: true });
  const root = path.join(base, 'data-root');
  for (const value of Object.values(runtimePaths(root))) assert.ok(!value.startsWith(oldRepo), `旧位被当成落点：${value}`);
  assert.deepEqual(await readdir(root).catch(cause => cause.code === 'ENOENT' ? [] : Promise.reject(cause)), [],
    '算路径这一步就在数据根里建了东西——像是有迁移/预建');
});
