// 复审判词里那个 liveness 洞的复现脚本（判词原文 /tmp/repro-flush-gap2.mjs，这里换成仓内相对 import 留档）。
// 期望：修复后 `gap-proof on disk? true`、`unflushed:false`；修复前 false / true（写一次就再也不排）。
// 跑法：node evidence/test/P003-T036/repro-flush-liveness.mjs
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';

const dir = await mkdtemp(path.join(tmpdir(), 'repro-gap2-'));
const file = path.join(dir, 'queue.json');
const monitor = new TriageMonitor({ inputMode: 'syslog', service: {}, investigator: {},
  history: { latest: async () => null, save: async () => {} }, file,
  casesDirectory: path.join(dir, 'cases'), persistIntervalMs: 200 });

// 忠实复刻：writeSnapshot 先同步 stringify（与真实一致），再睡 120ms 模拟 fs 写在飞
const orig = monitor.writeSnapshot.bind(monitor);
let writes = 0;
monitor.writeSnapshot = async () => { const p = orig(); await new Promise(r => setTimeout(r, 120)); writes += 1; await p; };

monitor.markDirty();                                  // 排定立即写
await new Promise(r => setTimeout(r, 5));             // stringify 已跑、进入 fs 模拟睡眠
monitor.records.set('gap-proof', { alert_id: 'gap-proof', status: 'queued' });
monitor.markDirty();                                  // 在飞 → 早退，不排 timer（由 flush 的 finally 补排）
await new Promise(r => setTimeout(r, 200));           // 写完 + 远超一个合并写窗口
await new Promise(r => setTimeout(r, 600));           // 再等：看有没有人补写
const onDisk = JSON.parse(await readFile(file, 'utf8'));
console.log('writes=%d dirtyGen=%d writtenGen=%d timer=%s flushing=%s',
  writes, monitor.dirtyGen, monitor.writtenGen, monitor.flushTimer !== null, monitor.flushing);
console.log('gap-proof on disk?', onDisk.records.some(r => r.alert_id === 'gap-proof'));
console.log('summary.persist =', JSON.stringify(monitor.summary().persist));
monitor.stop();
await rm(dir, { recursive: true, force: true });
