// 慢落盘探针：给快照写盘注入 40ms 延迟，等价主门并发时的 I/O 排队窗口。
//
// 用法（在目标树里跑）：
//   SUT=/abs/path/to/tree node --import file:///abs/path/to/probe-slow-snapshot.mjs \
//     --test --test-timeout=60000 --test-force-exit syslog-pipeline.test.js
//
// 只碰公开符号：TriageMonitor.prototype.writeSnapshot（docs/modules/triage-pipeline.md:364 快照内容、:280 写快照）。

const sut = process.env.SUT ?? process.cwd();
const { TriageMonitor } = await import(new URL('triage-monitor.js', `file://${sut}/`).href);

const original = TriageMonitor.prototype.writeSnapshot;
if (typeof original !== 'function') throw new Error('TriageMonitor.prototype.writeSnapshot 不存在——探针失效，不要当作通过');

TriageMonitor.prototype.writeSnapshot = async function patched(...args) {
  await new Promise(resolve => setTimeout(resolve, 40));
  return original.apply(this, args);
};
