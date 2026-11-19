import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../../../server.js';
import { dataRoot } from '../../../config-store.js';

// P003-T019 立、P003-T034 改口径：运行态（案卷 / 研判记录 / 基线 / 规则集 / 白板）不再落仓库内 `.data/`，
// 一律落在**数据根**下（`HIDS_DATA_DIR` 或 `~/.local/share/hids-ai-console`）。
// 本文件只管两件事：① 七条具名路径的结构没变（子目录 / 文件名逐字一致）；② 换根时整批跟着走。
// P003-T043：原九条里的 `baseline` / `intel` 两键已砍（研判背景改走判据库 `common/GEN-13.md` 与规则层），余七条不变。
// 数据根怎么算、别的模块落点在哪，见 `evidence/test/P003-T034/data-root.test.js`。
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// 每一条路径在数据根下的固定位置（改这里等于改数据目录布局，得连着文档一起改）。
// 七条 = P003-T019 的九条减去 `baseline`/`intel`（P003-T043 A1）。
const layout = {
  data: '',
  investigations: 'investigations',
  triageRules: 'triage-rules.json',
  triageMonitor: 'triage-monitor.json',
  cases: 'cases',
  wikiSessions: 'wiki-sessions',
  traceBoards: 'trace-boards'
};

test('A1 七条运行态路径都在数据根下，子结构与 P003-T019 时的仓内 .data/ 逐字一致', () => {
  const root = dataRoot();
  const paths = runtimePaths();
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(layout).sort(), '运行态路径清单变了');
  for (const [name, suffix] of Object.entries(layout)) {
    assert.equal(paths[name], suffix ? path.join(root, suffix) : root, `${name} 应落在数据根下 ${suffix || '(根)'}`);
    assert.ok(!path.relative(root, paths[name]).startsWith('..'), `${name} 跑出了数据根：${paths[name]}`);
  }
});

test('A1 换一个根时同构：路径全跟着传入的根走，说明没有把某台机器的路径写死在函数里', () => {
  const other = path.join(repository, '.tmp-another-root');
  const paths = runtimePaths(other);
  for (const [name, suffix] of Object.entries(layout)) {
    assert.equal(paths[name], suffix ? path.join(other, suffix) : other, `${name} 没跟着根走`);
    assert.ok(path.resolve(paths[name]).startsWith(path.resolve(other) + path.sep) || paths[name] === other,
      `${name} 逃出了传入的根`);
  }
});

test('A3 回归钉子：server.js 里不再有「仓库目录 + .data/」或「上一级 + backend/.data」的路径定义', async () => {
  const source = await readFile(path.join(repository, 'server.js'), 'utf8');
  assert.ok(!source.includes("'backend'"), "server.js 里又出现了 'backend' 路径段");
  assert.ok(!/path\.join\(directory,\s*'\.data'\)/.test(source), "server.js 里又把数据根拼成 `<directory>/.data`");
  assert.ok(!/path\.resolve\(moduleDirectory,\s*'\.\.'\)/.test(source), 'server.js 里又把根目录解析成上一级了');
  assert.match(source, /const runtime = runtimePaths\(\);/, '模块级运行态路径不再取自 runtimePaths()——接线可能绕过它自己拼路径');
});
