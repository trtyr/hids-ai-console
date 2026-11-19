import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eventSeconds, eventTypeFor, fingerprint, parseSyslog, sessionKey } from './syslog-input.js';
import { eventTypes } from './cloudwalker.js';
import { matchSyslogEvent, updateSyslogDeliveryCount, writeSyslogCase, writeSyslogResult } from './syslog-case.js';
import { log } from './log.js';

// 结论排序的档位：threat 在前，其余同档保持时间倒序；没有结论的记录排最后。
const verdictRanks = Object.freeze({ threat: 0, uncertain: 1, false_positive: 2 });

// 轮询的一轮一页：一页 50 条（与 cloudwalker 的页上限一致），最多 20 页。
const POLL_PAGE_SIZE = 50;
const MAX_POLL_PAGES = 20;

// A4：告警类型风险档位。数值越大越先研判；表外/未知类型按 0 排最后。
// 档位按「处置时限」排：内存马/WebShell/反弹 Shell/恶意文件是可直接利用的入口，接着是内存安全与蜜罐，
// 再往下是提权、暴力破解、异常登录、可疑操作、网络审计。改档位就是改优先级，文档里逐类列了值。
export const typeRisk = Object.freeze({
  memory_webshell: 11, webshell: 10, revshell: 10, malware: 10, memory_security: 9,
  honeypot: 8, elevation_process: 8, brute_force: 7, abnormal_login: 6,
  suspicious_operation: 5, network_audit: 4
});

// 正整数的配置值：非法（0、负数、小数、空串、非数）回落到默认，不把队列卡死。
const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};
const envConcurrency = () => positiveInteger(process.env.HIDS_TRIAGE_CONCURRENCY, 2);
const envQueueLimit = () => positiveInteger(process.env.HIDS_TRIAGE_QUEUE_MAX, 1000);
// 并发度的两种口径（P003-T037 × P003-T036 合并时的约定）：
// - 构造参数显式传数字 0：不起 worker，只排队——测试与停机维护需要「入队但不跑」；
// - 其余非法值（负数 / 小数 / 非数 / 空串 / 字符串 '0'）与 env 里的 0 一律回落 env → 缺省 2，不把队列卡死。
const concurrencyLimit = value => (value === 0 ? 0 : positiveInteger(value, envConcurrency()));

// 记录的告警类型：syslog 记录从 MsgId 推，轮询记录从 `type:id` 取。
function recordType(record) {
  if (record.input?.parsed?.msgid) return eventTypeFor(record.input.parsed.msgid) || '';
  const text = String(record.alert_id || '');
  const at = text.indexOf(':');
  return at > 0 ? text.slice(0, at) : '';
}

// A4 优先级：（类型风险 desc，occurrence_count desc，created_at asc）。
export function comparePriority(left, right) {
  const risk = (typeRisk[recordType(right)] ?? 0) - (typeRisk[recordType(left)] ?? 0);
  if (risk) return risk;
  const occurrences = (right.occurrence_count || 1) - (left.occurrence_count || 1);
  if (occurrences) return occurrences;
  return String(left.created_at || '').localeCompare(String(right.created_at || ''));
}

// A2：详情取数的缓存键——只缓存 `get_<type>_event` 且带正整数 id 的调用，其它调用直通。
function detailKey(name, args) {
  const id = Number(args?.id);
  return /^get_[a-z_]+_event$/.test(String(name)) && Number.isSafeInteger(id) && id > 0
    ? `${name}:${id}` : null;
}

// 人工登记的误报（误报入口写的就是 verdict=false_positive + decision_source=human）：重跑不覆盖结论区。
// AI 自己判出的 false_positive 不算——那种重跑仍旧按这次研判覆盖。
const humanFalsePositive = record => record.verdict === 'false_positive' && record.decision_source === 'human';

// 研判记录里的证据条目只外露这四个字段：args 可能带原始事件内容，不外露。
const evidenceItems = entries => (Array.isArray(entries) ? entries : [])
  .map(({ evidence_id, tool, fetched_at, sha256 }) => ({ evidence_id, tool, fetched_at, sha256 }));

function evidenceSummary(result) {
  const claims = result?.validation?.ok || result?.validation?.removed_unverified_facts
    ? (result.verdict?.claims || []).filter(claim => Array.isArray(claim.citations) && claim.citations.length) : [];
  return { verified_facts: claims.length,
    evidence_sources: new Set(claims.flatMap(claim => claim.citations.map(citation => citation.evidence_id).filter(Boolean))).size };
}

// syslog 逐条触发常规研判；兼容轮询入口。状态落盘，重启后续跑未完成任务。
export class TriageMonitor {
  constructor({ service, investigator, history, file, intervalMs = 30000, concurrency = envConcurrency(),
    queueLimit = envQueueLimit(), maxBackoffMs = null,
    inputMode = 'poll', eventToolbox = null, wiki = null, casesDirectory = null,
    baselineFile = null, intelFile = null, ruleEngine = null,
    // A1 失败重排：第 n 次失败后等 min(retryBaseMs * 2^(n-1), retryMaxMs)，attempts 到 retryMaxAttempts 进死信。
    retryBaseMs = 1000, retryMaxMs = 60000, retryMaxAttempts = 3,
    // A4 合并写窗口：热路径标脏，写盘最多 1 次 / persistIntervalMs。
    persistIntervalMs = 1000,
    // A5 done 记录 TTL：过期归档出内存 Map，扫描周期 archiveSweepMs。
    doneTtlMs = 24 * 60 * 60 * 1000, archiveSweepMs = 10 * 60 * 1000,
    // A2 暂停缓冲上限：超出的报文丢弃并计数（不静默涨内存）。
    pausedBufferLimit = 2000 }) {
    this.service = service;
    this.investigator = investigator;
    this.history = history;
    this.file = file;
    this.intervalMs = intervalMs;
    this.concurrency = concurrencyLimit(concurrency);
    // A5：队列上限管的是「排队 + 在跑」的记录数；满了就拒收并计数（summary().dropped）。
    this.queueLimit = positiveInteger(queueLimit, envQueueLimit());
    this.maxBackoffMs = positiveInteger(maxBackoffMs, intervalMs * 16);
    this.dropped = 0;
    this.emptyPolls = 0;
    // 下一轮轮询的延迟：有新增就是 intervalMs，连续空轮翻倍到 maxBackoffMs（A1）。
    this.backoffMs = intervalMs;
    this.inputMode = inputMode;
    this.eventToolbox = eventToolbox;
    this.wiki = wiki;
    this.casesDirectory = casesDirectory;
    this.baselineFile = baselineFile;
    this.intelFile = intelFile;
    this.ruleEngine = ruleEngine;
    this.dedupe = new Map();
    this.windows = new Map();
    this.acceptChain = Promise.resolve();
    this.records = new Map();
    this.watermark = null;
    this.watermarkIds = new Set();
    this.initialized = false;
    this.enabled = true;
    this.lastPollAt = null;
    // syslog 模式下没有轮询，lastPollAt 恒为 null：最后一条报文什么时候到的单独记在这里（到达时刻，不是事件时间）。
    this.lastReceivedAt = null;
    this.lastError = null;
    this.active = 0;
    this.polling = false;
    this.pollEpoch = 0;
    this.timer = null;
    // A1（T037）：轮询改成 setTimeout 链后，靠这个开关停链；T036 的写盘改走合并写窗口，不再有 writeChain 字段
    // （对外的 writeChain 由下面的 get writeChain() 访问器兜着）。
    this.timerActive = false;
    this.archiveTimer = null;
    this.started = false;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.retryMaxAttempts = retryMaxAttempts;
    this.persistIntervalMs = persistIntervalMs;
    this.doneTtlMs = doneTtlMs;
    this.archiveSweepMs = archiveSweepMs;
    this.pausedBufferLimit = pausedBufferLimit;
    // A4 合并写状态：dirtyGen 是「标脏到第几代」，writtenGen 是「第几代已落盘」。
    this.dirtyGen = 0;
    this.writtenGen = 0;
    this.flushing = false;
    this.flushDone = null;
    this.flushTimer = null;
    this.lastWriteAt = 0;
    // A1 每条待重排记录的 timer；A4 重复投递攒下来的计数（合并写落盘时一次写完）。
    this.retryTimers = new Map();
    this.pendingCounts = new Map();
    // A2 暂停缓冲：暂停期间到达的原始报文排队，恢复先回灌；received 是暂停期收到条数（含溢出丢弃的）。
    this.pausedBuffer = [];
    this.pausedReceived = 0;
    this.pausedDropped = 0;
    this.pausedReplayed = 0;
    this.pausedSince = null;
    // A8 收包计数：处理器能看见的四类结果 + 处理链抛错；内核 socket 缓冲满的丢弃进程内看不见（见文档未决）。
    this.syslogStats = { inbound: 0, accepted: 0, collapsed: 0, buffered: 0, dropped: 0, rejected: 0, failed: 0 };
    this.archivedCount = 0;
    // syslog 输入由 server 注入接收器：绑定成败都记在这里，summary() 才看得出「收不到消息」。
    this.syslog = { listening: false, bind: null, error: null };
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.watermark = data.watermark || null;
      this.watermarkIds = new Set(data.watermark_ids || []);
      this.initialized = !!data.initialized;
      this.enabled = data.enabled !== false;
      this.lastReceivedAt = data.last_received_at || null;
      this.archivedCount = Number.isInteger(data.archived_count) ? data.archived_count : 0;
      const paused = data.paused || {};
      this.pausedBuffer = Array.isArray(paused.buffer) ? paused.buffer.map(String) : [];
      this.pausedReceived = Number.isInteger(paused.received) ? paused.received : 0;
      this.pausedDropped = Number.isInteger(paused.dropped) ? paused.dropped : 0;
      this.pausedReplayed = Number.isInteger(paused.replayed) ? paused.replayed : 0;
      this.pausedSince = paused.since || null;
      this.records = new Map((data.records || []).map(record => [record.alert_id,
        record.status === 'running' ? { ...record, status: 'queued', stage: '等待重试' } : record]));
      this.dedupe = new Map(data.dedupe || []);
      this.windows = new Map(data.windows || []);
      // A1 旧队列里的失败记录也归队：attempts 到上限的判死信，其余留给 start() 的 resumeRetries() 重排。
      for (const record of this.records.values()) {
        if (record.status !== 'failed') continue;
        if ((record.attempts || 0) >= this.retryMaxAttempts) record.dead_letter = true;
      }
      for (const record of this.records.values()) {
        if (record.status !== 'done') continue;
        const needsCounts = !Number.isInteger(record.verified_facts);
        const needsEvidence = !Array.isArray(record.evidence);
        if (!needsCounts && !needsEvidence) continue;
        const result = await this.latestInvestigation(record);
        if (!result) continue;
        if (needsCounts) Object.assign(record, evidenceSummary(result));
        // 旧队列里没有 evidence[]：从研判记录就地补，不写单独迁移脚本。
        if (needsEvidence) record.evidence = evidenceItems(result.evidence);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  // A7：队列键（syslog 记录是 syslog:<类型>:<指纹>:<秒>:<uuid>）与研判文件键（牧云事件 ID / 研判结果 ID）
  // 不是一回事。回补依次试 result_alert_id → matched_alert_id → 队列键，第一个读到的就是回补源。
  async latestInvestigation(record) {
    const keys = [...new Set([record.result_alert_id, record.matched_alert_id, record.alert_id].filter(Boolean))];
    for (const key of keys) {
      let saved = null;
      try { saved = await this.history.latest(key, 'triage'); }
      catch (error) {
        log('triage.backfill_failed', { alert_id: record.alert_id, key, error: String(error?.message || error) }, 'warn');
        continue;
      }
      if (saved) return saved;
    }
    return null;
  }

  // A4：热路径（每条报文、每个研判步骤）只标脏——写盘由合并写窗口决定，峰值 ≤ 1 次 / persistIntervalMs。
  // 已经有合并写在飞或已排定就把这次改动合并进那一次，不另开一轮。
  markDirty() {
    this.dirtyGen += 1;
    if (this.flushing || this.flushTimer) return;
    const wait = Math.max(0, this.persistIntervalMs - (Date.now() - this.lastWriteAt));
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, wait);
    this.flushTimer.unref?.();
  }

  // 关键点用（入队 / 轮询推进 / 研判收尾）：等到自己这一代状态真的落盘再返回。
  persist() {
    this.dirtyGen += 1;
    return this.flushedTo(this.dirtyGen);
  }

  // 旧 writeChain 的语义（测试与调用方拿它当「等落盘」的同步点）：等价于 flush()。
  get writeChain() { return this.persist(); }

  async flushedTo(gen) {
    while (this.writtenGen < gen) {
      await this.flush().catch(() => {});
      if (this.writtenGen >= gen) return;
      // 写盘失败路径也把 writtenGen 推到 target，这里让出一次事件循环防止空转。
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  // 单飞：已有一次写在飞就复用它，不并发写同一个文件。
  // 没有新脏东西时不写空快照；在飞期间标的脏由 finally 补排下一次写，不然没人落盘。
  flush() {
    if (!this.flushing && this.writtenGen >= this.dirtyGen) return Promise.resolve();
    if (!this.flushing) {
      this.flushing = true;
      const target = this.dirtyGen;
      this.flushDone = this.writeSnapshot()
        .then(async () => {
          this.writtenGen = Math.max(this.writtenGen, target);
          this.lastWriteAt = Date.now();
          await this.flushPendingCounts();
        })
        .catch(error => {
          // 写盘失败只记日志、不打断服务（与改前一致）；等的人不能永远挂着。
          log('triage.persist_failed', { file: this.file, error: String(error?.message || error) }, 'error');
          this.writtenGen = Math.max(this.writtenGen, target);
        })
        .finally(() => { this.flushing = false; this.flushDone = null; if (this.writtenGen < this.dirtyGen) this.markDirty(); });
    }
    return this.flushDone;
  }

  async writeSnapshot() {
    const snapshot = JSON.stringify({ initialized: this.initialized, enabled: this.enabled, watermark: this.watermark,
      watermark_ids: [...this.watermarkIds], last_received_at: this.lastReceivedAt,
      archived_count: this.archivedCount,
      paused: { since: this.pausedSince, received: this.pausedReceived, dropped: this.pausedDropped,
        replayed: this.pausedReplayed, buffer: this.pausedBuffer },
      records: [...this.records.values()], dedupe: [...this.dedupe], windows: [...this.windows] });
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.file);
  }

  // A4：重复投递的计数不再每条重存一遍研判记录，攒到合并写里一次落盘（最多 1 次 / 窗口）。
  async flushPendingCounts() {
    if (!this.pendingCounts.size) return;
    const pending = new Map(this.pendingCounts);
    this.pendingCounts.clear();
    for (const [alertId, count] of pending) await this.saveDeliveryCount(alertId, count);
  }

  // 把重复投递次数写回研判记录与案卷（研判记录是整份 JSON，所以只按窗口写，不按条写）。
  async saveDeliveryCount(alertId, count) {
    const record = this.records.get(alertId);
    if (!record) return;
    try {
      if (record.result_alert_id) {
        const saved = await this.history.latest(record.result_alert_id, 'triage');
        if (saved) await this.history.save({ ...saved, repeat_count: count,
          syslog: saved.syslog ? { ...saved.syslog, repeat_count: count } : undefined });
      }
      if (record.status === 'done') await updateSyslogDeliveryCount(record.case_dir, count);
    } catch (error) {
      log('triage.delivery_count_failed', { alert_id: alertId, error: String(error?.message || error) }, 'error');
    }
  }

  async start() {
    await this.load();
    this.started = true;
    this.resumeRetries();
    this.archiveTimer = setInterval(() => void this.archiveDone()
      .catch(error => log('triage.archive_failed', { error: String(error?.message || error) }, 'error')), this.archiveSweepMs);
    this.archiveTimer.unref?.();
    if (this.inputMode === 'syslog') { this.initialized = true; if (this.enabled) this.drain(); return; }
    if (this.enabled) { await this.poll(); this.drain(); }
    this.timerActive = true;
    this.#schedule();
  }

  // A1：退避靠 setTimeout 链而不是 setInterval——每轮跑完才排下一轮，延迟用这一轮算出的 backoffMs。
  #schedule() {
    if (!this.timerActive) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this.#schedule());
    }, this.backoffMs);
    this.timer.unref?.();
  }

  // 停服务：T037 的轮询链开关（timerActive）与 T036 的重试/合并写/归档 timer 一并收掉，一个不留。
  stop() {
    this.timerActive = false;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    this.archiveTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  // A1：失败记录排重试。第 n 次失败后等 min(retryBaseMs * 2^(n-1), retryMaxMs)；
  // attempts 到 retryMaxAttempts 判死信（status 仍是 failed，另带 dead_letter:true），不再自动跑。
  scheduleRetry(record, delayMs = null) {
    this.clearRetry(record.alert_id);
    const attempts = record.attempts || 1;
    if (attempts >= this.retryMaxAttempts) {
      record.dead_letter = true;
      record.next_attempt_at = null;
      log('triage.dead_letter', { alert_id: record.alert_id, attempts,
        reason: record.failure?.reason || record.detail || null }, 'error');
      return;
    }
    const delay = delayMs ?? Math.min(this.retryBaseMs * 2 ** (attempts - 1), this.retryMaxMs);
    record.dead_letter = false;
    record.next_attempt_at = new Date(Date.now() + delay).toISOString();
    // load() 之后由 start() 的 resumeRetries() 统一排：进程内外各排一份会双跑。
    if (!this.started) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(record.alert_id);
      if (this.records.get(record.alert_id) !== record || record.dead_letter) return;
      // 暂停中不自动重跑：记录保持 failed，恢复时 resumeRetries() 补上逾期的那次。
      if (!this.enabled || record.status !== 'failed') return;
      record.status = 'queued'; record.stage = '等待重试'; record.next_attempt_at = null;
      record.updated_at = new Date().toISOString();
      this.markDirty();
      this.drain();
    }, delay);
    timer.unref?.();
    this.retryTimers.set(record.alert_id, timer);
  }

  clearRetry(alertId) {
    const timer = this.retryTimers.get(alertId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(alertId);
  }

  // 启动 / 恢复时把该重排的失败记录排上：逾期的立刻回队，没到点的按原定时刻。
  resumeRetries() {
    if (!this.enabled) return;
    for (const record of this.records.values()) {
      if (record.status !== 'failed') continue;
      if ((record.attempts || 0) >= this.retryMaxAttempts) { record.dead_letter = true; continue; }
      if (record.dead_letter) continue;
      const due = Date.parse(record.next_attempt_at || '');
      if (!Number.isFinite(due) || due <= Date.now()) {
        this.clearRetry(record.alert_id);
        record.status = 'queued'; record.stage = '等待重试'; record.next_attempt_at = null;
        record.updated_at = new Date().toISOString();
      } else this.scheduleRetry(record, due - Date.now());
    }
    this.markDirty();
  }

  // A3：删记录同时失效指向它的 dedupe 条目与重试 timer，不留悬空引用。
  dropRecord(alertId) {
    this.records.delete(alertId);
    this.clearRetry(alertId);
    for (const [fp, entry] of this.dedupe) if (entry.record_id === alertId) this.dedupe.delete(fp);
  }

  // A5：done 记录过 TTL 就归档出内存 Map（追加到 <队列文件>.archive.jsonl），全表扫不再随告警量线性变慢。
  // 归档后的记录 status() 返回 null（与「没有记录」同一口径），要翻旧案直接读归档文件。
  async archiveDone({ now = Date.now() } = {}) {
    const stamp = record => Date.parse(record.updated_at || record.saved_at || '');
    const expired = [...this.records.values()].filter(record => record.status === 'done' &&
      Number.isFinite(stamp(record)) && stamp(record) < now - this.doneTtlMs);
    if (!expired.length) return { archived: 0, remaining: this.records.size };
    const file = `${this.file}.archive.jsonl`;
    const lines = expired.map(record => `${JSON.stringify({ ...record, archived_at: new Date(now).toISOString() })}\n`).join('');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, lines, { encoding: 'utf8', mode: 0o600 });
    for (const record of expired) this.dropRecord(record.alert_id);
    this.archivedCount += expired.length;
    await this.persist();
    log('triage.archived', { count: expired.length, total: this.archivedCount, file });
    return { archived: expired.length, remaining: this.records.size };
  }

  // A9：取消排队中的案件。只允许取消还没在研判的记录（queued / failed）；取消即删记录并失效 dedupe（A3）。
  async cancel(alertId) {
    const record = this.records.get(alertId);
    if (!record) { const error = new Error('没有这条研判记录，无法取消'); error.status = 404; throw error; }
    if (!['queued', 'failed'].includes(record.status)) {
      const error = new Error(`记录状态为 ${record.status}，不能取消`);
      error.status = 409; throw error;
    }
    this.dropRecord(alertId);
    this.pendingCounts.delete(alertId);
    await this.persist();
    log('triage.cancelled', { alert_id: alertId });
    return { alert_id: alertId, status: 'not_queued', cancelled: true };
  }

  status(alertId) {
    const record = this.records.get(alertId) || [...this.records.values()].reverse().find(item => item.matched_alert_id === alertId);
    if (!record) return null;
    const { input, ...visible } = record;
    // TriageCase.evidence[] 恒为数组：排队/失败/未入队的记录也不能缺键。
    return { ...visible, evidence: visible.evidence || [], steps: [...(record.steps || [])] };
  }

  // 列表口径：先按结论 / 事件类型 / 主机 / 事件时间筛，再倒序切页；total 是过滤后的条数。
  // from / to 是 Unix 秒（含端点），与 eventSeconds 同一个时间源，部署端偏移一并生效。
  cases({ count = 20, offset = 0, verdicts = [], type = null, host = null, from = null, to = null, sort = 'time' } = {}) {
    let records = [...this.records.values()].filter(record => record.input);
    if (verdicts.length) records = records.filter(record => verdicts.includes(record.verdict || 'review'));
    if (type) records = records.filter(record => eventTypeFor(record.input.parsed.msgid) === type);
    if (host) records = records.filter(record => record.input.parsed.payload.host_ip === host);
    if (from != null || to != null) records = records.filter(record => {
      const seconds = eventSeconds(record.input.parsed);
      return seconds != null && (from == null || seconds >= from) && (to == null || seconds <= to);
    });
    records.reverse();
    // Array#sort 是稳定排序：同档结论之间保留上面那个时间倒序。
    if (sort === 'verdict') records.sort((left, right) => (verdictRanks[left.verdict] ?? 3) - (verdictRanks[right.verdict] ?? 3));
    return { total: records.length, cases: records.slice(offset, offset + count).map(record => ({
        alert_id: record.alert_id, matched_alert_id: record.matched_alert_id || null,
        result_alert_id: record.result_alert_id || null, status: record.status,
        stage: record.stage, detail: record.detail, created_at: record.created_at,
        updated_at: record.updated_at, saved_at: record.saved_at || null,
        case_dir: record.case_dir || null, repeat_count: record.repeat_count || 1,
        verdict: record.verdict || null, verdict_label: record.verdict_label || null,
        summary: record.summary || null, report: record.report || null,
        missing_evidence: record.missing_evidence || [], next_actions: record.next_actions || [],
        evidence_refs: record.evidence_refs || [], evidence: record.evidence || [],
        verified_facts: record.verified_facts || 0,
        evidence_sources: record.evidence_sources || 0, msgid: record.input.parsed.msgid,
        decision_source: record.decision_source || 'ai', rule_id: record.rule_id || null,
        event_time: record.input.parsed.payload.event_create_time || record.input.parsed.ts,
        host_ip: record.input.parsed.payload.host_ip || null,
        source_ip: record.input.parsed.payload.source_ip || record.input.parsed.payload.login_ip || null,
        command: record.input.parsed.payload.process_command_line || null
      })) };
  }

  async attachSyslog(receiver) {
    try {
      const address = await receiver.start();
      this.syslog = { listening: true, bind: `udp://${address.address}:${address.port}`, error: null };
      log('syslog.listening', { bind: this.syslog.bind });
    } catch (cause) {
      // 绑定失败不能让队列静默收不到消息：记进 summary()，队列照常服务（HTTP 还要活）。
      this.syslog = { listening: false, bind: null, error: String(cause?.message || cause).slice(0, 300) };
      log('syslog.bind_failed', { error: this.syslog.error }, 'error');
    }
    return this.syslog;
  }

  // 总览聚合：三个分布共用一份记录集，带 since 时只算 created_at（进入队列的时刻）不早于它的记录。
  // 结论四键恒在（没有结论算 review，与 cases({verdicts}) 同一口径）；类型只列出现过的键，映射不出的算 unknown。
  summary({ since = null } = {}) {
    const sinceAt = since ? new Date(since) : null;
    const sinceMs = sinceAt && !Number.isNaN(sinceAt.getTime()) ? sinceAt.getTime() : null;
    const counts = { queued: 0, running: 0, done: 0, failed: 0 };
    const verdict_counts = { threat: 0, uncertain: 0, false_positive: 0, review: 0 };
    const type_counts = {};
    for (const record of this.records.values()) {
      if (sinceMs != null && !(Date.parse(record.created_at) >= sinceMs)) continue;
      counts[record.status] = (counts[record.status] || 0) + 1;
      verdict_counts[Object.hasOwn(verdict_counts, record.verdict) ? record.verdict : 'review'] += 1;
      // eventTypeFor 用普通对象查表：MsgId 是 toString / constructor / __proto__ 时会取到原型上的函数或对象。
      // 只认 eventTypes 里真有的类型名，别的一律算 unknown——否则 type_counts 的键会变成函数源码。
      const type = eventTypeFor(record.input?.parsed?.msgid);
      const typeKey = typeof type === 'string' && Object.hasOwn(eventTypes, type) ? type : 'unknown';
      type_counts[typeKey] = (type_counts[typeKey] || 0) + 1;
    }
    // A6：队列深度、最老等待时长、失败原因分布。这三项不跟 since 走（它们是「此刻队列怎么样」，不是时间窗聚合）。
    const queue = { depth: 0, running: counts.running, oldest_wait_ms: null, oldest_alert_id: null, retry_waiting: 0 };
    const failureReasons = {};
    let deadLetters = 0;
    const nowMs = Date.now();
    for (const record of this.records.values()) {
      if (record.status === 'queued') {
        queue.depth += 1;
        const since = Date.parse(record.updated_at || record.created_at || '');
        if (Number.isFinite(since)) {
          const wait = Math.max(0, nowMs - since);
          if (queue.oldest_wait_ms == null || wait > queue.oldest_wait_ms) {
            queue.oldest_wait_ms = wait; queue.oldest_alert_id = record.alert_id;
          }
        }
      }
      if (record.status !== 'failed') continue;
      if (record.dead_letter) deadLetters += 1; else queue.retry_waiting += 1;
      const reason = String(record.failure?.reason || record.detail || '未知').slice(0, 120);
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    }
    return { initialized: this.initialized, enabled: this.enabled, input_mode: this.inputMode,
      since: sinceMs == null ? null : new Date(sinceMs).toISOString(),
      last_poll_at: this.lastPollAt, last_error: this.lastError, counts, verdict_counts, type_counts,
      backoff_ms: this.backoffMs, empty_polls: this.emptyPolls,
      concurrency: this.concurrency, queue_limit: this.queueLimit, dropped: this.dropped,
      queue, failure_reasons: failureReasons,
      // A1 重试上限可查：运维不必猜「还能自动跑几次」。
      retry: { base_ms: this.retryBaseMs, max_ms: this.retryMaxMs, max_attempts: this.retryMaxAttempts,
        dead_letters: deadLetters },
      // A2 暂停期间收到多少、多少进了缓冲、多少丢在溢出上、恢复后回灌了多少。
      paused: { active: !this.enabled, since: this.pausedSince, received: this.pausedReceived,
        buffered: this.pausedBuffer.length, dropped: this.pausedDropped, replayed: this.pausedReplayed },
      archived: { count: this.archivedCount, ttl_ms: this.doneTtlMs },
      persist: { interval_ms: this.persistIntervalMs, unflushed: this.dirtyGen > this.writtenGen },
      // A8 收包计数单独一块：syslog 是「能不能收到」（绑定状态，契约不能改形状），syslog_stats 是「收了多少 / 丢了多少」。
      ...(this.inputMode === 'poll' ? { interval_ms: this.intervalMs }
        : { syslog: { ...this.syslog }, syslog_stats: { ...this.syslogStats }, last_received_at: this.lastReceivedAt }) };
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') { const error = new Error('enabled 必须为布尔值'); error.status = 400; throw error; }
    if (enabled !== this.enabled) this.pollEpoch++;
    if (!enabled) {
      this.enabled = false;
      // 新一轮暂停窗口：计数从零开始，summary().paused 报的就是这一轮。
      this.pausedSince = new Date().toISOString();
      this.pausedReceived = 0;
      this.pausedDropped = 0;
      this.pausedReplayed = 0;
      await this.persist();
      return this.summary();
    }
    if (this.enabled) { if (this.inputMode === 'poll') await this.poll(); this.drain(); await this.persist(); return this.summary(); }
    // A2：恢复不丢不漏——游标（watermark / watermarkIds）与队列都不动。改前把游标推到点击时刻并删全部 queued，
    // 暂停期间进来的告警就永远漏掉了。顺序：先回灌暂停缓冲，再补上逾期重试，最后 drain。
    this.enabled = true;
    this.initialized = true;
    await this.persist();
    const buffered = this.pausedBuffer;
    this.pausedBuffer = [];
    for (const line of buffered) await this._acceptSyslog(line);
    this.pausedReplayed = buffered.length;
    this.markDirty();
    this.resumeRetries();
    if (this.inputMode === 'poll') await this.poll();
    this.drain();
    return this.summary();
  }

  // A5：队列深度只看「排队 + 在跑」，已完结的记录不占配额。
  #queueFull() {
    let depth = 0;
    for (const record of this.records.values())
      if (record.status === 'queued' || record.status === 'running') depth += 1;
    return depth >= this.queueLimit;
  }

  #countDropped(count, reason) {
    this.dropped += count;
    log('triage.dropped', { reason, count, dropped: this.dropped, queue_limit: this.queueLimit }, 'warn');
  }

  async enqueue(alertId, { retry = false } = {}) {
    const existing = this.records.get(alertId);
    if (String(alertId).startsWith('syslog:') && !existing?.input) {
      const error = new Error('该 syslog 告警的原始报文不存在，无法重试');
      error.status = 404;
      throw error;
    }
    if (existing && !retry) return this.status(alertId);
    if (existing?.status === 'running') return this.status(alertId);
    if (this.#queueFull()) {
      this.#countDropped(1, 'manual');
      const error = new Error(`研判队列已满（上限 ${this.queueLimit}），稍后再试`);
      error.status = 429;
      throw error;
    }
    const now = new Date().toISOString();
    // 人工登记的误报结论（verdict / verdict_label / summary）跟着记录走进新一轮：run() 收尾靠它认出这条不该被覆盖。
    // 不带上来的话，重排这一下就把误报标记抹掉了，后面根本认不出「已标误报」。
    const keepVerdict = !!existing && humanFalsePositive(existing);
    // 人工重跑优先于自动重排：旧的重试 timer 与死信标记都清掉，这一轮从头跑（attempts 留着做记录）。
    this.clearRetry(alertId);
    this.records.set(alertId, { alert_id: alertId,
      ...(existing?.input ? { input: existing.input, occurrence_count: existing.occurrence_count,
        session_key: existing.session_key, repeat_count: existing.repeat_count } : {}),
      ...(keepVerdict ? { verdict: existing.verdict, verdict_label: existing.verdict_label,
        summary: existing.summary, decision_source: existing.decision_source, feedback: existing.feedback } : {}),
      status: 'queued', stage: '等待研判', detail: '已进入自动研判队列', dead_letter: false, next_attempt_at: null,
      created_at: existing?.created_at || now, updated_at: now, steps: existing?.steps || [], attempts: existing?.attempts || 0 });
    // 入队是研判链的起点：谁把这条排进来的（人工手动 / 人工重试）跟着告警 ID 一起记。
    log('triage.enqueued', { alert_id: alertId, source: existing ? 'retry' : 'manual' });
    await this.persist();
    this.drain();
    return this.status(alertId);
  }

  // A1：增量轮询。游标只由 `from`（上一轮最大 createdAt，含端点）决定，不再翻页找边界；
  // 同秒的`watermarkIds`只用来去重，不参与边界判定。返回本轮结果给 #schedule 算退避。
  async poll() {
    if (this.inputMode === 'syslog') return null;
    if (this.polling || !this.enabled) return null;
    this.polling = true;
    const pollEpoch = this.pollEpoch;
    let found = [];
    let failed = false;
    try {
      const query = this.initialized && this.watermark ? { from: this.watermark } : {};
      let offset = 0;
      let newest = this.watermark;
      const newestIds = new Set(this.watermarkIds);
      const collected = [];
      for (let page = 0; page < MAX_POLL_PAGES; page++) {
        const response = await this.service.alerts({ count: POLL_PAGE_SIZE, offset, sort: 'time', ...query })
          .catch(error => {
            log('cloudwalker.call_failed', { op: 'alerts', alert_id: null, error: String(error?.message || error) }, 'error');
            throw error;
          });
        if (response.partial) throw new Error('部分牧云事件类型读取失败，暂缓推进自动研判游标');
        const rows = response.alerts || [];
        if (!this.initialized) {
          // 冷启动只定游标，不排任何告警（与改前一致）。
          newest = rows[0]?.createdAt || new Date().toISOString();
          for (const row of rows) if (row.createdAt === newest) newestIds.add(row.id);
          break;
        }
        for (const row of rows) {
          // from 是服务端过滤，这里是兜底：平台忽略 from 时也不会把旧告警当新增（不靠它找边界）。
          if (!row.createdAt || (this.watermark && row.createdAt < this.watermark)) continue;
          if (row.createdAt === this.watermark && this.watermarkIds.has(row.id)) continue;
          if (!newest || row.createdAt > newest) { newest = row.createdAt; newestIds.clear(); }
          if (row.createdAt === newest) newestIds.add(row.id);
          if (!this.records.has(row.id)) collected.push(row.id);
        }
        // 一页取满了才继续翻页：这是「把本轮新增取完」，不是「翻页找边界」。
        if (rows.length < POLL_PAGE_SIZE) break;
        offset += POLL_PAGE_SIZE;
        if (page === MAX_POLL_PAGES - 1) throw new Error('新增告警超过本轮扫描上限，请检查自动研判积压');
      }
      if (!this.enabled || pollEpoch !== this.pollEpoch) return null;
      this.initialized = true;
      this.watermark = newest;
      this.watermarkIds = newestIds;
      this.lastPollAt = new Date().toISOString();
      this.lastError = null;
      found = collected.reverse();
      let skipped = 0;
      for (const alertId of found) {
        if (this.#queueFull()) { skipped += 1; continue; }
        this.records.set(alertId, { alert_id: alertId, status: 'queued', stage: '等待研判',
          detail: '牧云新增告警已进入队列', created_at: this.lastPollAt, updated_at: this.lastPollAt,
          steps: [], attempts: 0 });
        log('triage.enqueued', { alert_id: alertId, source: 'poll' });
      }
      if (skipped) this.#countDropped(skipped, 'poll');
      await this.persist();
      this.drain();
    } catch (error) {
      failed = true;
      if (pollEpoch === this.pollEpoch) {
        this.lastError = error.message;
        log('triage.poll_failed', { error: error.message }, 'warn');
      }
    }
    finally { this.polling = false; }
    // 空轮（含失败轮）指数退避；见到新告警立刻回常态（A1）。
    if (found.length) this.emptyPolls = 0; else this.emptyPolls += 1;
    this.backoffMs = this.emptyPolls === 0 ? this.intervalMs
      : Math.min(this.intervalMs * 2 ** this.emptyPolls, this.maxBackoffMs);
    return { found: found.length, empty: found.length === 0, failed };
  }

  acceptSyslog(line) {
    this.syslogStats.inbound += 1;
    const job = this.acceptChain.catch(() => {}).then(() => this._acceptSyslog(line));
    // 收包链上的抛错不能静默：下一条报文之前没人会知道这条丢了。
    this.acceptChain = job.catch(error => {
      this.syslogStats.failed += 1;
      log('syslog.accept_failed', { error: String(error?.message || error) }, 'error');
    });
    return job;
  }

  async _acceptSyslog(line) {
    if (this.inputMode !== 'syslog') throw new Error('自动研判未使用 syslog 输入');
    if (!this.enabled) {
      // A2：暂停不丢——报文进缓冲排队，恢复时先回灌。缓冲有上限：超出的才丢，但要计数（不静默涨内存）。
      this.pausedSince = this.pausedSince || new Date().toISOString();
      this.pausedReceived += 1;
      if (this.pausedBuffer.length >= this.pausedBufferLimit) {
        this.pausedDropped += 1;
        this.syslogStats.dropped += 1;
        log('syslog.skipped', { reason: 'paused_buffer_full', limit: this.pausedBufferLimit }, 'warn');
        this.markDirty();
        return { buffered: false, dropped: true };
      }
      this.pausedBuffer.push(String(line));
      this.syslogStats.buffered += 1;
      log('syslog.buffered', { reason: 'paused', buffered: this.pausedBuffer.length });
      this.markDirty();
      return { buffered: true, buffered_count: this.pausedBuffer.length };
    }
    let parsed;
    try { parsed = parseSyslog(line); }
    catch (error) {
      this.lastError = `syslog 解析失败：${error.message}`;
      this.syslogStats.rejected += 1;
      log('syslog.parse_failed', { error: error.message, bytes: String(line || '').length }, 'warn');
      return { error: this.lastError };
    }
    const type = eventTypeFor(parsed.msgid);
    if (!type) {
      this.syslogStats.rejected += 1;
      log('syslog.skipped', { reason: 'no_agent_for_msgid', msgid: parsed.msgid }, 'warn');
      return { skipped: 'no_agent_for_msgid', msgid: parsed.msgid };
    }
    const seconds = eventSeconds(parsed);
    const fp = fingerprint(parsed);
    const previous = this.dedupe.get(fp);
    const sameSecond = seconds != null && previous?.last_delivery_second === seconds;
    if (sameSecond) {
      previous.delivery_count++;
      previous.event_delivery_count++;
      // 重复投递也是一条到达：最后到达时间跟上，和记录上的 updated_at 走同一个时刻。
      this.lastReceivedAt = new Date().toISOString();
      const record = this.records.get(previous.record_id);
      if (record) {
        record.repeat_count = previous.event_delivery_count;
        record.updated_at = this.lastReceivedAt;
        // A4：不再每条重复投递都全量重存一遍研判记录。同一条记录每个合并写窗口内最多写回一次：
        // 窗口外的第一条立刻写（研判记录/案卷马上能看到次数），窗口内的攒到合并写里一次落盘。
        const lastSave = record.count_saved_at || 0;
        if (record.status === 'done' && record.result_alert_id && Date.now() - lastSave >= this.persistIntervalMs) {
          record.count_saved_at = Date.now();
          await this.saveDeliveryCount(record.alert_id, record.repeat_count);
        } else this.pendingCounts.set(record.alert_id, record.repeat_count);
      }
      this.syslogStats.collapsed += 1;
      this.markDirty();
      log('syslog.collapsed', { alert_id: previous.record_id, repeat_count: previous.event_delivery_count });
      return { collapsed: true, repeat_count: previous.event_delivery_count, alert_id: previous.record_id };
    }
    const occurrence = previous && seconds != null && Math.abs(seconds - previous.last_seen) <= 300
      ? previous.occurrence_count + 1 : 1;
    // A3：同指纹（指纹里已含 host_ip）且上一条已完结——复用结论，只累加 repeat_count，
    // 不再排一次完整研判。人工要重新研判走 enqueue(alertId, { retry: true })。
    const concluded = previous ? this.records.get(previous.record_id) : null;
    if (concluded?.status === 'done' && concluded.verdict) {
      const at = new Date().toISOString();
      previous.delivery_count += 1;
      previous.event_delivery_count += 1;
      previous.last_delivery_second = seconds;
      previous.last_seen = seconds ?? previous.last_seen;
      previous.occurrence_count = occurrence;
      concluded.repeat_count = previous.event_delivery_count;
      concluded.occurrence_count = occurrence;
      concluded.updated_at = at;
      this.lastReceivedAt = at;
      if (concluded.result_alert_id) {
        const saved = await this.history.latest(concluded.result_alert_id, 'triage');
        if (saved) await this.history.save({ ...saved, repeat_count: concluded.repeat_count,
          syslog: saved.syslog ? { ...saved.syslog, repeat_count: concluded.repeat_count } : undefined });
      }
      await updateSyslogDeliveryCount(concluded.case_dir, concluded.repeat_count);
      await this.persist();
      log('syslog.reused_conclusion', { alert_id: concluded.alert_id, repeat_count: concluded.repeat_count, occurrence });
      return { reused: true, repeat_count: concluded.repeat_count, alert_id: concluded.alert_id };
    }
    if (this.#queueFull()) {
      this.#countDropped(1, 'syslog');
      return { dropped: true, queue_limit: this.queueLimit };
    }
    const session = sessionKey(parsed);
    const now = new Date().toISOString();
    const alertId = `syslog:${type}:${fp}:${seconds ?? 'unknown'}:${randomUUID()}`;
    this.lastReceivedAt = now;
    this.records.set(alertId, { alert_id: alertId, input: { raw: String(line), parsed },
      occurrence_count: occurrence,
      session_key: session, status: 'queued', stage: '等待研判', detail: '已接收牧云 syslog',
      created_at: now, updated_at: now, steps: [], attempts: 0, repeat_count: 1 });
    this.dedupe.set(fp, { last_seen: seconds, last_delivery_second: seconds,
      occurrence_count: occurrence, delivery_count: (previous?.delivery_count || 0) + 1,
      event_delivery_count: 1, record_id: alertId });
    this.syslogStats.accepted += 1;
    log('syslog.received', { alert_id: alertId, msgid: parsed.msgid, event_type: type, occurrence });
    // 热路径只标脏：合并写窗口内落盘（A4），下一秒内崩溃最多丢这一窗的队列状态。
    this.markDirty();
    this.drain();
    return { alert_id: alertId, status: 'queued' };
  }

  async readContextFile(filename, fallback) {
    if (!filename) return fallback;
    try { const data = JSON.parse(await readFile(filename, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
    } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async contextFor(record) {
    const parsed = record.input.parsed;
    const seconds = eventSeconds(parsed);
    const session = record.session_key;
    const sourceIp = parsed.payload.source_ip || parsed.payload.login_ip;
    const window = (this.windows.get(session) || []).filter(item => seconds == null ||
      item.at == null || Math.abs(seconds - item.at) <= 300).slice(-200);
    const baseline = await this.readContextFile(this.baselineFile,
      { test_tool_paths: [], authorized_operators: [], whitelist_commands: [], known_source_countries: ['CN'], asset: {} });
    const cachedIntel = await this.readContextFile(this.intelFile, { by_ip: {} });
    const history = [...this.records.values()].filter(item => item.status === 'done' && item.input &&
      (item.session_key === session || sourceIp && (item.input.parsed.payload.source_ip || item.input.parsed.payload.login_ip) === sourceIp ||
        parsed.payload.user_name && item.input.parsed.payload.user_name === parsed.payload.user_name ||
        parsed.payload.process_command_line && item.input.parsed.payload.process_command_line === parsed.payload.process_command_line))
      .slice(-50).map(item => ({ at: item.updated_at, conclusion: item.verdict,
        alert_id: item.matched_alert_id || item.alert_id }));
    return { session_key: session, window, window_seconds: 600,
      occurrence_count: record.occurrence_count || 1, delivery_count: record.repeat_count || 1,
      baseline, intel: { by_ip: sourceIp && cachedIntel.by_ip?.[sourceIp] ? { [sourceIp]: cachedIntel.by_ip[sourceIp] } : {} }, history };
  }

  rememberWindow(record) {
    const parsed = record.input.parsed;
    const seconds = eventSeconds(parsed);
    const session = record.session_key;
    const payload = parsed.payload;
    const window = this.windows.get(session) || [];
    window.push({ at: seconds, msgid: parsed.msgid, event_name: payload.event_name,
      command: payload.process_command_line, file_path: payload.file_path, source_ip: payload.source_ip || payload.login_ip,
      target_ip: payload.target_ip, target_port: payload.target_port, host_ip: payload.host_ip,
      user_name: payload.user_name, session_key: session, repeat_count: record.occurrence_count || 1 });
    this.windows.set(session, window.slice(-200));
    if (seconds != null) for (const [key, events] of this.windows)
      if (events.every(item => item.at != null && Math.abs(seconds - item.at) > 1200)) this.windows.delete(key);
  }

  drain() {
    while (this.enabled && this.active < this.concurrency) {
      // A4：按（类型风险 desc，occurrence_count desc，created_at asc）取最高优先级。
      const next = [...this.records.values()].filter(record => record.status === 'queued')
        .sort(comparePriority)[0];
      if (!next) break;
      this.clearRetry(next.alert_id);
      this.active++;
      next.status = 'running';
      next.stage = '准备研判';
      next.updated_at = new Date().toISOString();
      next.attempts = (next.attempts || 0) + 1;
      void this.run(next).catch(error => {
        this.lastError = `研判状态保存失败：${error.message}`;
        log('triage.persist_failed', { alert_id: next.alert_id, error: error.message }, 'error');
      })
        .finally(() => { this.active--; this.drain(); });
    }
  }

  // 牧云取数调用包一层：syslog 事件匹配内部会把失败降级成 reason（syslog-case.js 不在本卡 scope），
  // 只有套在调用点上，cloudwalker.call_failed 才留得下来。日志记完原样抛出，降级策略不变。
  async cloudwalkerCall(op, job) {
    try { return await job(); }
    catch (error) {
      log('cloudwalker.call_failed', { op, alert_id: null, error: String(error?.message || error) }, 'error');
      throw error;
    }
  }

  // matchSyslogEvent 只用 callTool / listEvents 两个方法：给它一个带日志的薄替身，别碰真 toolbox。
  // 只包真有的方法——替身上凭空多个方法会让原实现的分支判断变掉。
  // A2：detailCache 是一次研判内的详情缓存（get_<type>_event 按 id 只真拉一次），
  // syslog 匹配与规则评估拿同一个实例；agent 用 match.event 复用（investigation-agent.js）。
  observedToolbox(detailCache = new Map()) {
    const toolbox = this.eventToolbox;
    if (!toolbox) return toolbox;
    const wrapped = {};
    for (const [name, op] of [['callTool', 'call_tool'], ['listEvents', 'list_events']])
      if (typeof toolbox[name] === 'function')
        wrapped[name] = (...args) => this.cloudwalkerCall(op, () => toolbox[name](...args));
    if (wrapped.callTool) {
      const callTool = wrapped.callTool;
      wrapped.callTool = async (name, args) => {
        const key = detailKey(name, args);
        if (key && detailCache.has(key)) return detailCache.get(key);
        const value = await callTool(name, args);
        if (key) detailCache.set(key, value);
        return value;
      };
    }
    return wrapped;
  }

  async run(record) {
    const startedAt = Date.now();
    try {
      // 研判过程中的状态只标脏（A4）：崩溃最多丢这一窗的进度，重启时 running 记录会退回 queued 重跑，
      // 所以这里不需要每次变更都同步落盘——那条路正是「落盘暴涨」的来源。
      this.markDirty();
      let targetId = record.alert_id;
      let caseInfo = null;
      let match = null;
      let ruleDecision = { status: 'disabled' };
      // 一次研判一份详情缓存：同一条事件详情不会拉第二次，跨告警不共享。
      const detailCache = new Map();
      const toolbox = this.observedToolbox(detailCache);
      if (record.input) {
        record.input.context = await this.contextFor(record);
        record.stage = '关联事件'; record.detail = '优先按事件 ID 精确读取牧云详情，并核对主机身份';
        match = await matchSyslogEvent(toolbox, record.input.parsed);
        if (match.matched) { targetId = match.alert_id; record.matched_alert_id = targetId; }
      }
      if (this.ruleEngine) {
        try { ruleDecision = await this.ruleEngine.evaluate({ alertId: targetId,
          parsed: record.input?.parsed || null, toolbox, match }); }
        catch (error) { ruleDecision = { status: 'error', reason: `规则评估失败：${String(error.message).slice(0, 180)}` }; }
        if (['candidate', 'observed', 'error', 'identity_unverified'].includes(ruleDecision.status)) {
          record.steps.push({ stage: '规则评估', detail: ruleDecision.status === 'candidate' ?
            `命中 ${ruleDecision.rule.id}，作为误报候选交由 AI 复核` : ruleDecision.status === 'observed' ?
              `观察规则 ${ruleDecision.rule.id} 命中，继续 AI 研判` : ruleDecision.reason,
          at: new Date().toISOString() });
        }
      }
      if (record.input) {
        caseInfo = await writeSyslogCase({ directory: this.casesDirectory, ...record.input, match, wiki: this.wiki });
        record.case_dir = caseInfo.case_dir;
        this.markDirty();
      }
      const onProgress = (stage, detail) => {
        record.stage = stage; record.detail = detail; record.updated_at = new Date().toISOString();
        record.steps.push({ stage, detail, at: record.updated_at });
        if (record.steps.length > 80) record.steps.shift();
        // 进度落盘走合并写（A4）：一个研判里几十个步骤不再一步一次全量重写。
        this.markDirty();
      };
      const result = match?.matched === false
        ? await this.investigator.runUnmatchedSyslog(record.input, match, caseInfo, onProgress)
        : await this.investigator.run(targetId, { mode: 'triage', onProgress, streamContext: record.input ?
          { parsed: record.input.parsed, context: record.input.context, caseInfo, match } : null,
          ruleEvaluation: ruleDecision });
      result.rule_evaluation = ruleDecision;
      if (match?.matched === false) result.alert_id = record.alert_id;
      if (record.input) {
        result.syslog = { msgid: record.input.parsed.msgid, event_time: record.input.parsed.payload.event_create_time || record.input.parsed.ts,
          event_id_match: match?.matched || false, match_gap_seconds: match?.gap_seconds ?? null,
          repeat_count: record.repeat_count };
        result.case_dir = caseInfo.case_dir;
        result.repeat_count = record.repeat_count;
        await writeSyslogResult(caseInfo, result);
      }
      const saved = await this.history.save(result);
      record.result_alert_id = saved.alert_id;
      if (record.input) this.rememberWindow(record);
      record.status = 'done'; record.stage = '研判完成';
      // A1：人工登记过误报的记录，重跑不覆盖结论区（verdict / verdict_label / summary / decision_source），
      // 报告、证据、缺证、下一步照常按这次研判刷新。
      if (!humanFalsePositive(record)) {
        record.decision_source = saved.decision_source || 'ai';
        record.verdict = saved.verdict?.verdict; record.verdict_label = saved.verdict?.verdict_label;
        record.summary = saved.verdict?.summary;
      }
      // detail 跟 summary 走：没保结论时与新研判的 summary 同源（与改前一致），保了结论时跟着保留的那份。
      record.detail = record.summary || '研判记录已保存';
      record.rule_id = saved.rule_evaluation?.rule?.id || null;
      record.saved_at = saved.saved_at;
      record.report = saved.verdict?.report || null;
      record.missing_evidence = saved.verdict?.missing_evidence || [];
      record.next_actions = saved.verdict?.next_actions || [];
      record.evidence_refs = (saved.verdict?.claims || []).flatMap(claim => claim.citations || [])
        .slice(0, 10).map(citation => ({ evidence_id: citation.evidence_id, pointer: citation.pointer }));
      record.evidence = evidenceItems(saved.evidence);
      Object.assign(record, evidenceSummary(saved));
      log('triage.done', { alert_id: record.alert_id, verdict: record.verdict ?? null,
        attempts: record.attempts || 0, duration_ms: Date.now() - startedAt });
    } catch (error) {
      record.status = 'failed'; record.stage = '研判失败'; record.detail = String(error.message || error).slice(0, 250);
      // A1：失败记录带原因进重排队列；attempts 到上限进死信（status 仍是 failed + dead_letter:true）。
      record.failure = { reason: record.detail, code: String(error?.code || error?.name || 'error'),
        at: new Date().toISOString() };
      this.scheduleRetry(record);
      log('triage.failed', { alert_id: record.alert_id, attempts: record.attempts || 0, error: record.detail }, 'error');
    } finally {
      record.updated_at = new Date().toISOString();
      this.markDirty();
      // 队列里还有活（排队中的、等重试的）就让合并写窗口带走（峰值 ≤1 次/秒）；
      // 真的闲下来了才立刻落盘，免得收尾状态悬在一次延迟写里（进程随即退出、测试随即清目录都属于这种时刻）。
      const busy = this.retryTimers.size > 0 || [...this.records.values()].some(item => item.status === 'queued');
      if (!busy) await this.flush();
    }
  }
}
