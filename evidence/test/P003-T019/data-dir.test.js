import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimePaths } from '../../../server.js';

// P003-T019：运行态（案卷 / 研判记录 / 基线 / 规则集 / 白板）一律落在仓库内 `.data/`，
// 不许落到仓库的上一级。旧实现是 `path.resolve(moduleDirectory, '..')` + `backend/.data/`。
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const dataRoot = path.join(repository, '.data');

// 每一条路径在 `.data/` 下的固定位置（改这里等于改仓内目录布局，得连着文档一起改）。
const layout = {
  data: '.data',
  investigations: '.data/investigations',
  triageRules: '.data/triage-rules.json',
  triageMonitor: '.data/triage-monitor.json',
  cases: '.data/cases',
  baseline: '.data/baseline.json',
  intel: '.data/intel.json',
  wikiSessions: '.data/wiki-sessions',
  traceBoards: '.data/trace-boards'
};

test('A1 九条运行态路径都在仓库内 .data/ 下，且没有一处经过 backend/ 或上一级目录', () => {
  const paths = runtimePaths();
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(layout).sort(), '运行态路径清单变了');
  for (const [name, suffix] of Object.entries(layout)) {
    const actual = paths[name];
    assert.equal(actual, path.join(repository, suffix), `${name} 应落在仓库内 ${suffix}，实际 ${actual}`);
    assert.ok(!path.relative(repository, actual).startsWith('..'), `${name} 跑出了仓库：${actual}`);
    assert.ok(!actual.split(path.sep).includes('backend'), `${name} 还带着 backend/ 段：${actual}`);
  }
});

test('A1 换一个目录时同构：路径全跟着传入目录走，说明没有把仓库路径写死在函数里', () => {
  const other = path.join(dataRoot, '..', 'another-deploy');
  const paths = runtimePaths(other);
  for (const [name, suffix] of Object.entries(layout)) {
    assert.equal(paths[name], path.join(other, suffix), `${name} 没跟着目录走`);
    assert.ok(path.resolve(paths[name]).startsWith(path.resolve(other) + path.sep), `${name} 逃出了传入目录`);
  }
});

test('A1 回归钉子：server.js 里不再有「上一级 + backend/.data」的路径定义', async () => {
  const source = await readFile(new URL('../../../server.js', import.meta.url), 'utf8');
  assert.ok(!source.includes("'backend'"), "server.js 里又出现了 'backend' 路径段");
  assert.ok(!/path\.resolve\(moduleDirectory,\s*'\.\.'\)/.test(source), 'server.js 里又把根目录解析成上一级了');
  assert.match(source, /const runtime = runtimePaths\(moduleDirectory\);/, '模块级运行态路径不再来自 runtimePaths()——接线可能绕过它自己拼路径');
});
