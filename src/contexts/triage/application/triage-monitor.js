// triage 上下文 · 应用层门面与生命周期（P003-T077 批 3 五栏拆分）。
//
// 队列栏      → application/queue.js（enqueue / poll / acceptSyslog / drain / 优先级）
// 重试调度栏  → application/retry-scheduler.js（scheduleRetry / clearRetry / resumeRetries）
// 投影栏      → application/projection.js（status / cases / summary / cleanCandidates）
// 持久化栏    → infrastructure/queue-persistence.js（load / persist / flush / archiveDone）
// 状态机      → 本文件（start/stop/dropRecord/cancel/setEnabled/run）+ domain/triage-case.js 的状态词表
//
// 五栏以 mixin 挂到同一个 TriageMonitor 原型上：**方法体逐字未改**（迁移只搬代码，不改行为），
// 所以 public API、调用顺序与响应形状与拆栏前完全一致。拆栏的目的是让「队列/状态机/持久化/投影/生命周期」
// 各自可单独阅读与测试，不再是一份 1100 行的类。
import { matchSyslogEvent, writeSyslogCase, writeSyslogResult } from './correlate.js';
import { log } from '../../../shared/logging/log.js';
import { recordFailure, reasonForRecord } from '../../../shared/redaction.js';
import { evidenceItems, evidenceSummary, humanFalsePositive } from '../domain/triage-case.js';
import { queueColumn } from './queue.js';
import { retryColumn } from './retry-scheduler.js';
import { projectionColumn } from './projection.js';
import { persistenceColumn } from '../infrastructure/queue-persistence.js';

// 旧调用点的 import 路径不变（拆栏前这些符号从 triage-monitor.js 导出）。
export { comparePriority, typeRisk } from './queue.js';
export { queueArgsMaxChars, queueArgValueMaxChars, queueEvidenceItem } from '../domain/triage-case.js';

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

// syslog 逐条触发常规研判；兼容轮询入口。状态落盘，重启后续跑未完成任务。
export class TriageMonitor {
  constructor({ service, investigator, history, file, intervalMs = 30000, concurrency = envConcurrency(),
    queueLimit = envQueueLimit(), maxBackoffMs = null,
    inputMode = 'poll', eventToolbox = null, wiki = null, casesDirectory = null,
    // 研判背景不在这里注入（P003-T043 A1）：原 baseline.json / intel.json 两处外部文件已砍，环境基线只在判据库里
    // （`wiki/common/GEN-13.md`，模型按 `wiki_page` 按需读），白名单命令的硬判定归规则层。别再往这里挂文件路径。
    ruleEngine = null,
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
    this._schedule();
  }

  // A1：退避靠 setTimeout 链而不是 setInterval——每轮跑完才排下一轮，延迟用这一轮算出的 backoffMs。
  _schedule() {
    if (!this.timerActive) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this._schedule());
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

  // A3：删记录同时失效指向它的 dedupe 条目与重试 timer，不留悬空引用。
  dropRecord(alertId) {
    this.records.delete(alertId);
    this.clearRetry(alertId);
    for (const [fp, entry] of this.dedupe) if (entry.record_id === alertId) this.dedupe.delete(fp);
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
        catch (error) { ruleDecision = { status: 'error', reason: `规则评估失败：${error?.message ?? error}` }; }
        if (['candidate', 'observed', 'error', 'identity_unverified'].includes(ruleDecision.status)) {
          // 记录侧不写错误原文（P003-T052）：`ruleEngine` 自己回的理由也可能带原文
          // （`triage-rules.js:263/267/284`，形状不穷举）——一律走 `reasonForRecord()` 归一（第四轮拍板：无白名单）。
          // 两条**成功路径**的模板是我们自己拼的（含 rule.id、不含上游文本），不过闸。
          // `ruleDecision` 对象本身不动——随后还要以 `ruleEvaluation` 回灌模型（模型靠原文认错、改配置）。
          const detail = ruleDecision.status === 'candidate' ?
            `命中 ${ruleDecision.rule.id}，作为误报候选交由 AI 复核` : ruleDecision.status === 'observed' ?
              `观察规则 ${ruleDecision.rule.id} 命中，继续 AI 研判` : reasonForRecord(ruleDecision.reason);
          record.steps.push({ stage: '规则评估', detail, at: new Date().toISOString() });
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
      // 记录侧不写错误原文（P003-T052）：`rule_evaluation` 会随 result 进案件目录 `result.json` 与研判记录
      // （`investigation-store.js:14-23`），所以落盘那份的 `reason` 同样过闸；模型那份不改（上面 `ruleEvaluation` 传的仍是原文）。
      result.rule_evaluation = ruleDecision.reason == null ? ruleDecision
        : { ...ruleDecision, reason: reasonForRecord(ruleDecision.reason) };
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
      // 记录侧不写错误原文（P003-T052）：这条文案随队列状态文件落盘（`persist()`），而
      // `modelCallError` 拼的 reply_excerpt 与上游报错原文都会经这里——只留固定文案 + 字符量。
      const detail = recordFailure(error);
      record.status = 'failed'; record.stage = '研判失败'; record.detail = detail;
      // A1：失败记录带原因进重排队列；attempts 到上限进死信（status 仍是 failed + dead_letter:true）。
      record.failure = { reason: detail, code: String(error?.code || error?.name || 'error'),
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

// 五栏挂到同一个原型上：descriptors 保留 writeChain 这类 getter（Object.assign 会把 getter 求值后拷值）。
for (const column of [queueColumn, retryColumn, projectionColumn, persistenceColumn])
  Object.defineProperties(TriageMonitor.prototype, Object.getOwnPropertyDescriptors(column));
