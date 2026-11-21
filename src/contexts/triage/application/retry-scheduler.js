// triage 上下文 · 应用层「重试调度」栏（P003-T077 批 3）：失败重排、死信、启动恢复。
// 归属：状态机里「failed → queued」这一段与它的 timer；不做投影、不写盘（调用方用自己的 markDirty/persist）。
import { log } from '../../../shared/logging/log.js';

export const retryColumn = {
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
  },

  clearRetry(alertId) {
    const timer = this.retryTimers.get(alertId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(alertId);
  },

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
};
