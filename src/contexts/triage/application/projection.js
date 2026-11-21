// triage 上下文 · 应用层「投影」栏（P003-T077 批 3）：status / cases / summary 与数据管理的候选挑选。
// 只读记录集，不改状态；真正的删除走 dropRecord（状态机），写盘走持久化栏。
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { eventSeconds, eventTypeFor } from '../../ingestion/application/parsing.js';
import { eventTypes } from '../../../shared/vocabulary.js';

// 结论排序的档位：threat 在前，其余同档保持时间倒序；没有结论的记录排最后。
const verdictRanks = Object.freeze({ threat: 0, uncertain: 1, false_positive: 2 });

// B03（P003-T060）：命令行字段四键回退，真序与 `cloudwalker.js:60` 一致（cmdline → command →
// shell_cmdline → process_cmdline）；syslog 载荷沿用至今的旧键 process_command_line 作兼容位插在末位。
// 三条真实记录实测旧键 undefined、真键 process_cmdline 有值——全仓只有 cases() 这一处没做兼容。
function commandOf(payload) {
  for (const key of ['cmdline', 'command', 'shell_cmdline', 'process_cmdline', 'process_command_line']) {
    const value = payload?.[key];
    if (typeof value === 'string' ? value.trim() : value != null) return value;
  }
  return null;
}

export const projectionColumn = {
  // ── 数据管理（P003-T044）：队列侧的候选挑选与清理 ──────────────────────────
  // 时间戳取 updated_at → saved_at → created_at 第一个能解析的；排序用它们，按「最新在前」排。
  // 候选集是两条阈值的并集：早于 olderThan 的，与按时间倒序排在第 keep 条之后的（keep = 保留最新多少条）。
  // 非 done 的记录（queued / running / failed）不在这里挡，交给 clean() 判 409——候选可以列出来，但不许动。
  cleanCandidates({ olderThan = null, keep = null } = {}) {
    const stamp = record => {
      for (const key of ['updated_at', 'saved_at', 'created_at']) {
        const parsed = Date.parse(record[key] || '');
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };
    const all = [...this.records.values()];
    const ranked = all.slice().sort((a, b) => (stamp(b) ?? 0) - (stamp(a) ?? 0));
    const selected = new Map();
    if (Number.isInteger(keep) && keep >= 0) for (const record of ranked.slice(keep)) selected.set(record.alert_id, record);
    if (Number.isFinite(olderThan)) for (const record of all) {
      const at = stamp(record);
      if (at != null && at < olderThan) selected.set(record.alert_id, record);
    }
    const records = [...selected.values()].sort((a, b) => (stamp(b) ?? 0) - (stamp(a) ?? 0));
    // 原始报文（input）是队列内部状态：候选清单只给 ID / 状态 / 时刻 / 估算字节，不往外带报文。
    const items = records.map(record => ({ name: record.alert_id, status: record.status,
      at: record.updated_at || record.saved_at || record.created_at || null,
      bytes: Buffer.byteLength(JSON.stringify(record)) }));
    return { records, items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
  },

  // 真清：候选里只要有一条不是 done（还在排/在跑/可重排）就整体拒绝 409，盘上一动不动。
  // archive 追加到 <队列文件>.archive.jsonl（与 archiveDone 同格式、带 archived_at）再移出内存；delete 直接移出。
  // 两条路都走 dropRecord()：records 之外的 dedupe 悬空引用必须一起失效（R-TRIAGE-13）。
  async clean({ action = 'archive', execute = false, olderThan = null, keep = null, now = Date.now() } = {}) {
    const { records, items, bytes } = this.cleanCandidates({ olderThan, keep });
    const blocked = records.filter(record => record.status !== 'done');
    if (blocked.length) {
      const statuses = [...new Set(blocked.map(record => record.status))].join('、');
      const error = new Error(`${blocked.length} 条记录状态不是 done（${statuses}），已完结的案件才可清理`);
      error.status = 409;
      throw error;
    }
    if (!execute || !records.length) return { count: records.length, bytes, items };
    if (action === 'archive') {
      const file = `${this.file}.archive.jsonl`;
      const lines = records.map(record => `${JSON.stringify({ ...record, archived_at: new Date(now).toISOString() })}\n`).join('');
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, lines, { encoding: 'utf8', mode: 0o600 });
      this.archivedCount += records.length;
    }
    for (const record of records) {
      this.dropRecord(record.alert_id);
      this.pendingCounts.delete(record.alert_id);
    }
    await this.persist();
    return { count: records.length, bytes, items };
  },

  // 案卷清理的 409 判据：目录上挂着非 done 记录（还在排 / 在跑 / 等重排）的，一个都不许清。
  blockedCaseDirs() {
    const blocked = new Set();
    for (const record of this.records.values())
      if (record.case_dir && record.status !== 'done') blocked.add(path.resolve(record.case_dir));
    return blocked;
  },


  status(alertId) {
    const record = this.records.get(alertId) || [...this.records.values()].reverse().find(item => item.matched_alert_id === alertId);
    if (!record) return null;
    const { input, ...visible } = record;
    // TriageCase.evidence[] 恒为数组：排队/失败/未入队的记录也不能缺键。
    return { ...visible, evidence: visible.evidence || [], steps: [...(record.steps || [])] };
  },

  // 列表口径：先按结论 / 事件类型 / 主机 / 事件时间筛，再倒序切页；total 是过滤后的条数。
  // from / to 是 Unix 秒（含端点），与 eventSeconds 同一个时间源，部署端偏移一并生效。
  // 待判定①（P003-T060，用户判 bug）：poll 模式入队的记录没有 input，旧版整条从列表消失。
  // 现在全部列出——缺 input 的派生字段（msgid / 事件时间 / 主机 / 来源 / 命令）如实回 null，不报错、不丢条。
  cases({ count = 20, offset = 0, verdicts = [], type = null, host = null, from = null, to = null, sort = 'time' } = {}) {
    let records = [...this.records.values()];
    if (verdicts.length) records = records.filter(record => verdicts.includes(record.verdict || 'review'));
    if (type) records = records.filter(record => record.input && eventTypeFor(record.input.parsed.msgid) === type);
    if (host) records = records.filter(record => record.input && record.input.parsed.payload.host_ip === host);
    if (from != null || to != null) records = records.filter(record => {
      if (!record.input) return false;
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
        evidence_sources: record.evidence_sources || 0,
        msgid: record.input?.parsed?.msgid ?? null,
        decision_source: record.decision_source || 'ai', rule_id: record.rule_id || null,
        event_time: record.input ? (record.input.parsed.payload.event_create_time || record.input.parsed.ts) : null,
        host_ip: record.input?.parsed.payload.host_ip ?? null,
        source_ip: record.input ? (record.input.parsed.payload.source_ip || record.input.parsed.payload.login_ip) ?? null : null,
        command: record.input ? commandOf(record.input.parsed.payload) : null
      })) };
  },

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
};
