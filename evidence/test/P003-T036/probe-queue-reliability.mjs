// P003-T036 探针（A10）：真进程内跑真 TriageMonitor + 真 UDP 收包 + 真 HTTP 路由，独立数据根（mkdtemp）。
// 两段：负载段（200 条报文 / 暂停回灌 / 取消 / 死信 / TTL 归档 / 写盘峰值）与空闲段（不再有写盘与后台任务空转）。
// 纪律：不用固定 sleep 等状态——等状态一律走 until()（带超时上界），只有「观测窗口」本身按毫秒计时。
// 跑法：bash evidence/test/P003-T036/probe-queue-reliability.sh（退出码 0 = 全过）
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { TriageMonitor } from '../../../triage-monitor.js';
import { SyslogReceiver } from '../../../syslog-input.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createServer } from '../../../server.js';

const DEADLINE_MS = 30_000;   // 每个阶段的超时上界
let failures = 0;
const ok = message => console.log(`PASS ${message}`);
const bad = message => { failures += 1; console.log(`FAIL ${message}`); };
const check = (condition, message) => (condition ? ok(message) : bad(message));

async function until(check, { timeoutMs = DEADLINE_MS, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// 记账版：数一数真的写了几次队列快照（A4 的写盘峰值）。
class CountingMonitor extends TriageMonitor {
  constructor(options) {
    super(options);
    this.snapshots = 0;
  }
  async writeSnapshot() {
    this.snapshots += 1;
    return super.writeSnapshot();
  }
}

const dataRoot = await mkdtemp(path.join(tmpdir(), 'hids-t036-probe-'));
console.log(`DATA_ROOT=${dataRoot}`);

// 10 个不同来源的事件；其中两个来源的研判必定失败（A1 退避 + 死信要真跑一遍）。
const failing = new Set(['198.51.100.7', '198.51.100.8']);
const lineFor = sourceIp => '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot '
  + `host_ip="10.0.0.5" event_create_time="2026-11-03 08:00:00" source_ip="${sourceIp}" target_port="80"`;
const sourceIps = Array.from({ length: 10 }, (_, index) => `198.51.100.${index + 1}`);

const monitor = new CountingMonitor({
  inputMode: 'syslog', concurrency: 1, service: {},
  history: new InvestigationStore(path.join(dataRoot, 'investigations')),
  file: path.join(dataRoot, 'triage-monitor.json'),
  casesDirectory: path.join(dataRoot, 'cases'),
  eventToolbox: null,
  // 探针把时间尺度压到毫秒级：退避 50ms 起、写盘窗口 1000ms（缺省值，正是要验的那个量级）
  retryBaseMs: 50, retryMaxMs: 200, retryMaxAttempts: 3,
  doneTtlMs: 300, archiveSweepMs: 100, pausedBufferLimit: 3,
  investigator: {
    runUnmatchedSyslog: async input => {
      const sourceIp = input.parsed.payload.source_ip;
      if (failing.has(sourceIp)) throw Object.assign(new Error('模型不可达'), { code: 'ETIMEDOUT' });
      return { mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '探针结论', claims: [] },
        validation: { ok: true }, evidence: [] };
    }
  }
});
await monitor.start();
const receiver = new SyslogReceiver({ host: '127.0.0.1', port: 0, onLine: line => monitor.acceptSyslog(line) });
const bound = await monitor.attachSyslog(receiver);
check(bound.listening === true, `syslog 接收器绑定成功（${bound.bind}）`);
const { port } = receiver.socket.address();
const socket = dgram.createSocket('udp4');
const send = line => new Promise(resolve => socket.send(Buffer.from(line), port, '127.0.0.1', resolve));

// ── 负载段 ──────────────────────────────────────────────────────────────────
const httpServer = createServer(null, null, null, null, null, monitor);
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${httpServer.address().port}`;
monitor.snapshots = 0;
const loadStartedAt = Date.now();

let sent = 0;
for (let round = 0; round < 20; round++) {
  for (const sourceIp of sourceIps) {
    await send(lineFor(sourceIp));
    sent += 1;
  }
  // 等这一批真的进了处理器（收包计数追平），不吃 UDP 缓冲满的亏
  const ingested = await until(() => monitor.summary().syslog_stats.inbound >= sent, { label: `第 ${round + 1} 批收包` });
  if (!ingested) { bad(`UDP 投递没有全部进处理器：发 ${sent}，收到 ${monitor.summary().syslog_stats.inbound}`); break; }
}
const stats = monitor.summary().syslog_stats;
check(stats.inbound === 200, `200 条报文全部进处理器（inbound=${stats.inbound}）`);
check(stats.accepted === 10, `10 个事件各入队一条（accepted=${stats.accepted}）`);
check(stats.collapsed === 190, `190 条重复投递被合并（collapsed=${stats.collapsed}）`);
check(stats.dropped === 0, `负载段没有丢弃（dropped=${stats.dropped}）`);

const normalDone = await until(() => sourceIps.filter(ip => !failing.has(ip))
  .every(ip => [...monitor.records.values()].some(record =>
    record.input?.parsed?.payload?.source_ip === ip && record.status === 'done')), { label: '正常事件研判完成' });
check(normalDone, '8 个正常事件都研判完成');

const deadLettered = await until(() => monitor.summary().retry.dead_letters === 2, { label: '两个失败事件进死信' });
check(deadLettered, '2 个持续失败的进死信（attempts 到上限）');
const summaryLoad = monitor.summary();
check(summaryLoad.retry.max_attempts === 3 && summaryLoad.retry.base_ms === 50,
  `退避上限可查（base=${summaryLoad.retry.base_ms}ms max=${summaryLoad.retry.max_ms}ms attempts=${summaryLoad.retry.max_attempts}）`);
check(summaryLoad.failure_reasons['模型不可达'] === 2, `失败原因分布报得上（${JSON.stringify(summaryLoad.failure_reasons)}）`);
const deadRecord = [...monitor.records.values()].find(record => record.dead_letter);
check(Boolean(deadRecord?.failure?.reason === '模型不可达' && deadRecord.attempts === 3), '死信保留原因与 attempts');

// A4 写盘峰值：负载段跑了多久，快照次数不该超过「每秒 1 次 + 收尾余量」
const loadSeconds = Math.max(1, Math.ceil((Date.now() - loadStartedAt) / 1000));
check(monitor.snapshots <= loadSeconds + 3,
  `负载段 ${loadSeconds}s 内只写了 ${monitor.snapshots} 次快照（≤1 次/秒量级）`);

// A2 + A8：暂停缓冲（上限 3，发 5 条 → 2 条丢弃要计数），恢复先回灌
const pauseReply = await fetch(`${base}/api/agent/triage/control`, { method: 'PUT',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
check(pauseReply.status === 200, `PUT /api/agent/triage/control 暂停 → ${pauseReply.status}`);
for (const sourceIp of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4', '203.0.113.5'])
  await send(lineFor(sourceIp));
const pausedReported = await until(() => monitor.summary().paused.received === 5, { label: '暂停期间收到 5 条' });
const paused = monitor.summary().paused;
check(pausedReported, `暂停期间收到 ${paused.received} 条（缓冲 ${paused.buffered}，丢弃 ${paused.dropped}）`);
check(paused.buffered === 3 && paused.dropped === 2, '缓冲上限 3：3 条进缓冲、2 条丢弃并计数');
check(monitor.summary().syslog_stats.dropped === 2, '丢包计数进 summary（syslog_stats.dropped=2）');

const resumeReply = await fetch(`${base}/api/agent/triage/control`, { method: 'PUT',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
check(resumeReply.status === 200, `PUT 恢复 → ${resumeReply.status}`);
const replayed = await until(() => ['203.0.113.1', '203.0.113.2', '203.0.113.3']
  .every(ip => [...monitor.records.values()].some(record =>
    record.input?.parsed?.payload?.source_ip === ip && record.status === 'done')), { label: '暂停缓冲三条回灌后跑完' });
check(replayed, '暂停期间的 3 条缓冲报文恢复后全部补跑（一条不丢）');
check(monitor.summary().paused.replayed === 3, `summary 报回灌条数（replayed=${monitor.summary().paused.replayed}）`);

// A6：队列可观测面
const observable = monitor.summary();
check(observable.queue.depth >= 0 && 'oldest_wait_ms' in observable.queue, `队列深度 ${observable.queue.depth}、最老等待 ${observable.queue.oldest_wait_ms}`);
check(observable.queue.running === monitor.active, `在跑数 ${observable.queue.running} 与 active 一致`);

// A9：取消失败的（死信）记录
const cancelUrl = `${base}/api/agent/triage/${encodeURIComponent(deadRecord.alert_id)}`;
const cancelled = await fetch(cancelUrl, { method: 'DELETE' });
const cancelledBody = await cancelled.json();
check(cancelled.status === 200 && cancelledBody.cancelled === true, `DELETE 取消排队记录 → ${cancelled.status} ${JSON.stringify(cancelledBody)}`);
check((await (await fetch(cancelUrl)).json()).status === 'not_queued', '取消后读状态是 not_queued');
check((await fetch(cancelUrl, { method: 'DELETE' })).status === 404, '再取消一次 → 404');

// A5：TTL 归档（doneTtlMs 300ms，扫描 100ms）
const archived = await until(() => monitor.summary().archived.count >= 8, { label: 'done 记录按 TTL 归档' });
const archivedSummary = monitor.summary();
check(archived, `done 记录归档出内存 Map（archived=${archivedSummary.archived.count}, ttl=${archivedSummary.archived.ttl_ms}ms）`);
const archivedLines = (await readFile(path.join(dataRoot, 'triage-monitor.json.archive.jsonl'), 'utf8')).trim().split('\n');
check(archivedLines.length >= 8 && archivedLines.every(line => JSON.parse(line).alert_id), `归档文件可读（${archivedLines.length} 行）`);

// ── 空闲段 ──────────────────────────────────────────────────────────────────
// 先等后台把事情收干净（暂停回灌的三条 done 记录也要按 TTL 归档掉），再开观测窗口：
// 归档扫描找不到过期记录时本来就不写盘，所以窗口内应当是零写入。
const quiesced = await until(() => monitor.summary().archived.count >= 11, { label: '回灌的三条也归档完' });
check(quiesced, `归档扫描把 done 记录收干净（archived=${monitor.summary().archived.count}）`);
await monitor.writeChain;
// 观测窗口（不是等某个状态变化）：1.2s 内不该有任何新写盘，也不该有后台任务空转。
const idleStart = monitor.snapshots;
const idleDepth = monitor.summary().queue.depth;
await new Promise(resolve => setTimeout(resolve, 1200));
const idleSummary = monitor.summary();
check(monitor.snapshots === idleStart, `空闲 1.2s 没有新的写盘（${idleStart} → ${monitor.snapshots}）`);
check(idleSummary.queue.depth === idleDepth, `空闲期间队列深度不变（${idleDepth}）`);
check(idleSummary.queue.running === 0 && monitor.active === 0 && monitor.retryTimers.size === 0,
  `空闲期间没有在跑的研判与重试（running=${idleSummary.queue.running}, retry_timers=${monitor.retryTimers.size}）`);

// 收尾
monitor.stop();
receiver.stop();
socket.close();
await new Promise(resolve => httpServer.close(resolve));
await monitor.writeChain;
await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
console.log(failures === 0 ? 'PROBE_OK 负载段与空闲段全绿' : `PROBE_FAIL ${failures} 条未过`);
process.exitCode = failures === 0 ? 0 : 1;
