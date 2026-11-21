// P003-T050：测试全局根隔离的两只钉子（行为级，不是 grep 源码）。
//
//   A3 首启种全局根：不设 `HIDS_DATA_DIR`、HOME 指向临时家目录 → 首启把仓内 `wiki/` 与 `rules/`
//      种子到 `<HOME>/.local/share/hids-ai-console/`；二次启动不重种（改过的页面不被仓内副本盖回）。
//      「不靠真实 HOME 观察」= 断言全写在临时家目录里，跟开发机上的运行态无关。
//   A2/A4 隔离守卫：起子进程把**全量测试**（整个 `evidence/**` 套件 + 根目录 `npm test` 那套）在临时 HOME 下
//      跑一遍，跑完那个「影子全局根」必须零文件。哪个文件没注入临时根（或者将来新加一个没注入的），就写/种在那儿，
//      这条立刻红。两套都罩：`npm test` 是主门，只罩 evidence/test 就等于放过了主门与 verify 件。
//      真全局根零痕迹（A4）是同一件事的另一面：套件连它的门都摸不到（`dataRoot()` 跟 HOME 走）。
//
// 两个子进程都用 `{ PATH, HOME }` 的干净环境：**故意不给 `HIDS_DATA_DIR`**，注入只能来自被测文件自己——
// 这正是 A2 要的判据。给了就等于替它们作弊。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidenceHome = path.join(repository, 'evidence');
const selfName = path.basename(fileURLToPath(import.meta.url));
const globalRootOf = home => path.join(home, '.local', 'share', 'hids-ai-console');
const urlOf = name => `file://${path.join(repository, name)}`;

// 首启/二次启动只做「按缺省装配读两本库」：`new WikiStore()` / `new RuleStore()` 的缺省目录就是数据根，
// 首次读会从仓内 `wiki/`、`rules/` 整目录种子一次（`wiki-store.js` 的 ensureWikiLibrary / `rule-store.js` 的 ready）。
const SEED_SCRIPT = `
const { dataRoot } = await import(${JSON.stringify(urlOf('config-store.js'))});
const { WikiStore } = await import(${JSON.stringify(urlOf('wiki-store.js'))});
const { RuleStore } = await import(${JSON.stringify(urlOf('rule-store.js'))});
const pages = await new WikiStore().list();
const rules = await new RuleStore().list();
console.log(JSON.stringify({ root: dataRoot(), pages: pages.length, rules: rules.count }));
`;

function runNode(source, { home } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: repository,
      env: { PATH: process.env.PATH, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', cause => resolve({ code: -1, stdout, stderr: String(cause) }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function newTemporaryHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'hids-t050-home-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

// 目录树快照：相对路径 → `sha256:mtimeMs`（目录记 `dir:mtimeMs`）。二次启动只许读、不许写，写一个字就对不上。
async function snapshotTree(directory) {
  const snapshot = {};
  const walk = async (current, prefix) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await stat(full);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = `dir:${info.mtimeMs}`;
        await walk(full, relative);
      } else {
        snapshot[relative] = `${createHash('sha256').update(await readFile(full)).digest('hex')}:${info.mtimeMs}`;
      }
    }
  };
  await walk(directory, '');
  return snapshot;
}

// ── A3：首启种全局根（临时 HOME，不设 HIDS_DATA_DIR） ─────────────────────
test('A3 首启把仓内 wiki/ 与 rules/ 种子进 <HOME>/.local/share/hids-ai-console，二次启动不重种', async t => {
  const home = await newTemporaryHome(t);
  const root = globalRootOf(home);

  const first = await runNode(SEED_SCRIPT, { home });
  assert.equal(first.code, 0, `首启失败：${first.stderr}`);
  const booted = JSON.parse(first.stdout.trim().split('\n').pop());
  assert.equal(booted.root, root, '不设 HIDS_DATA_DIR 时数据根不是 <HOME>/.local/share/hids-ai-console');
  assert.ok(booted.pages > 0, '首启后判据库是空的');
  assert.ok(booted.rules > 0, '首启后规则库是空的');

  // 种子文件逐个点名：不是「有个目录就算种了」
  assert.equal(existsSync(path.join(root, 'wiki', 'index.md')), true, '首启没把仓内 wiki/ 种子进全局根');
  assert.equal(existsSync(path.join(root, 'wiki', 'honeypot', 'HP-10.md')), true, '首启种子里缺 honeypot/HP-10.md');
  assert.equal(existsSync(path.join(root, 'rules', 'honeypot_probe.rego')), true, '首启没把仓内 rules/ 种子进全局根');
  // 库里除了种子还有别的？只认「全局根下就是这两本库」，别处多出来的落点也算毛病
  const topLevel = Object.keys(await snapshotTree(root))
    .filter(name => !name.replace(/\/$/, '').includes('/'));
  assert.deepEqual(topLevel, ['rules/', 'wiki/'], `全局根下多了别的落点：${topLevel.join(', ')}`);

  const before = await snapshotTree(root);

  // 二次启动前手动改一页：种子只初始化一次，「已存在就一个字都不动」——改过的内容不许被仓内副本盖回
  const page = path.join(root, 'wiki', 'index.md');
  await writeFile(page, `${await readFile(page, 'utf8')}\n<!-- P003-T050 二次启动标记 -->\n`);

  const second = await runNode(SEED_SCRIPT, { home });
  assert.equal(second.code, 0, `二次启动失败：${second.stderr}`);
  assert.match(await readFile(page, 'utf8'), /P003-T050 二次启动标记/, '二次启动把改过的页面用仓内副本盖回去了');

  const after = await snapshotTree(root);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '二次启动多出/少了文件：种子不是一次性的');
  for (const name of Object.keys(before)) {
    if (name === 'wiki/index.md') continue; // 这一页被用例自己改过
    assert.equal(after[name], before[name], `二次启动重写了 ${name}（重种了）`);
  }
});

// ── A2/A4：全量测试的隔离守卫 ────────────────────────────────────────────
// 两套一起罩：整个 `evidence/**`（逐卡验证件 `evidence/test/**` **以及** `evidence/p003-*-verify/**`）
// + 根目录 `*.test.js`（`npm test` 那一套）。本文件自己排除（不然守卫跑守卫，无限递归）。
// 首版只 walk `evidence/test`，把三份 `p003-*-verify/acceptance.test.js` 整片漏在罩外——
// 复审判词实测 `p003-t018-verify` 单跑 8/8 绿却往真全局根写了 3 份 `fp-sessions`。所以从 `evidence/` 根走。
async function suiteFiles() {
  const found = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.test.js') && entry.name !== selfName) found.push(full);
    }
  };
  await walk(evidenceHome);
  for (const entry of await readdir(repository, { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.test.js') && entry.name !== selfName)
      found.push(path.join(repository, entry.name));
  // 罩面自证：verify 件曾经整片漏在罩外，这里逐个点名，别再让它悄悄缩回去。
  for (const directory of ['p003-t012-verify', 'p003-t018-verify', 'p003-t047-verify'])
    assert.ok(found.some(file => file.endsWith(path.join(directory, 'acceptance.test.js'))),
      `${directory}/acceptance.test.js 不在守卫罩面里`);
  return found.sort();
}

test('A2/A4 全量测试（evidence 套件 + npm test）在临时 HOME 下跑完：影子全局根零文件（＝真全局根零痕迹）', async t => {
  const home = await newTemporaryHome(t);
  const files = await suiteFiles();
  assert.ok(files.length >= 55, `只找到 ${files.length} 个测试文件，守卫覆盖面不对`);

  // `--test-concurrency=2`：子套件与外层套件叠着跑，再用满并发会让 T034 那份 tester 验收里
  // 「先探空闲端口再让子进程去 bind」的写法撞上端口争用（实测偶发一次 POST /api/config 400）。
  // 降到 2 只慢几百毫秒，换来可复跑的稳定判定——守卫要的是「零文件」，不是吞吐。
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=60000',
    '--test-force-exit', ...files], {
    cwd: repository,
    env: { PATH: process.env.PATH, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));

  // 防空转：子套件确实跑起来了（不然「零文件」是句空话）
  const ran = Number((output.match(/^ℹ tests (\d+)/m) || [])[1]);
  assert.ok(ran >= 600, `子套件没跑起来（tests=${ran}，exit=${code}）：${output.slice(-2000)}`);

  // 判据：临时家目录下的全局根一个条目都不许有（文件、目录都算）
  const shadow = globalRootOf(home);
  const written = existsSync(shadow) ? Object.keys(await snapshotTree(shadow)) : [];
  assert.deepEqual(written, [],
    `这些用例往全局根写了东西（真跑就是往 ~/.local/share/hids-ai-console 写）：${written.slice(0, 20).join(', ')}` +
    `；子套件 tests=${ran} exit=${code}`);
});
