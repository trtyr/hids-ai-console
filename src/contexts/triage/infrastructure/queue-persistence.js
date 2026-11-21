// triage 上下文 · 基础设施「持久化」栏（P003-T077 批 3）：队列文件的读、合并写、快照与归档。
// 应用层只通过 TriageMonitor 的同名方法用（load/persist/flush/archiveDone），文件格式与合并写窗口语义不变。
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../../shared/logging/log.js';
import { updateSyslogDeliveryCount } from '../application/correlate.js';
import { evidenceItems, evidenceSummary } from '../domain/triage-case.js';

export const persistenceColumn = {
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
  },

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
  },

  // A4：热路径（每条报文、每个研判步骤）只标脏——写盘由合并写窗口决定，峰值 ≤ 1 次 / persistIntervalMs。
  // 已经有合并写在飞或已排定就把这次改动合并进那一次，不另开一轮。
  markDirty() {
    this.dirtyGen += 1;
    if (this.flushing || this.flushTimer) return;
    const wait = Math.max(0, this.persistIntervalMs - (Date.now() - this.lastWriteAt));
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, wait);
    this.flushTimer.unref?.();
  },

  // 关键点用（入队 / 轮询推进 / 研判收尾）：等到自己这一代状态真的落盘再返回。
  persist() {
    this.dirtyGen += 1;
    return this.flushedTo(this.dirtyGen);
  },

  // 旧 writeChain 的语义（测试与调用方拿它当「等落盘」的同步点）：等价于 flush()。
  get writeChain() { return this.persist(); },

  async flushedTo(gen) {
    while (this.writtenGen < gen) {
      await this.flush().catch(() => {});
      if (this.writtenGen >= gen) return;
      // 写盘失败路径也把 writtenGen 推到 target，这里让出一次事件循环防止空转。
      await new Promise(resolve => setImmediate(resolve));
    }
  },

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
  },

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
  },

  // A4：重复投递的计数不再每条重存一遍研判记录，攒到合并写里一次落盘（最多 1 次 / 窗口）。
  async flushPendingCounts() {
    if (!this.pendingCounts.size) return;
    const pending = new Map(this.pendingCounts);
    this.pendingCounts.clear();
    for (const [alertId, count] of pending) await this.saveDeliveryCount(alertId, count);
  },

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
  },

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
};
