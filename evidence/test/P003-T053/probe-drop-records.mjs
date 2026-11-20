// M1 等价注入（黑盒）：快照落盘后把 records 截成 1 条 —— 只碰文档写明的快照字段 `records`
// （docs/modules/triage-pipeline.md:364）与构造选项 `file`（同文档 §示例 :310）。
// 用途：验证 syslog-pipeline.test.js 的 `resumed.cases().total === 2` 这条断言真能失败（不是永真）。
//
// 用法：
//   SUT=/abs/path/to/tree node --import file:///abs/path/to/probe-drop-records.mjs \
//     --test --test-timeout=60000 --test-force-exit syslog-pipeline.test.js
//
// 期望：红在 `assert.equal(resumed.cases().total, 2)`，actual 1 / expected 2。
// 若把该断言删掉，下一条 `resumed.cases({count:1,offset:1}).cases.length === 1` 应接住（actual 0 / expected 1）。

import { readFile, writeFile } from 'node:fs/promises';

const sut = process.env.SUT ?? process.cwd();
const { TriageMonitor } = await import(new URL('triage-monitor.js', `file://${sut}/`).href);

const original = TriageMonitor.prototype.writeSnapshot;
if (typeof original !== 'function') throw new Error('TriageMonitor.prototype.writeSnapshot 不存在——注入失效，不要当作通过');

TriageMonitor.prototype.writeSnapshot = async function patched(...args) {
  const result = await original.apply(this, args);
  const raw = JSON.parse(await readFile(this.file, 'utf8'));
  if (Array.isArray(raw.records)) raw.records = raw.records.slice(0, 1);
  else if (raw.records && typeof raw.records === 'object')
    raw.records = Object.fromEntries(Object.entries(raw.records).slice(0, 1));
  await writeFile(this.file, JSON.stringify(raw));
  return result;
};
