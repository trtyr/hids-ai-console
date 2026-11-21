// triage 上下文 · 应用层「队列」栏（P003-T077 批 3 五栏拆分）。
// 入队 / 轮询 / syslog 收包 / 排空 / 优先级排序：只认记录的状态与游标，不碰 fs（持久化在 queue-persistence.js）。
import { randomUUID } from 'node:crypto';
import { eventSeconds, eventTypeFor, fingerprint, parseSyslog, sessionKey } from '../../ingestion/application/parsing.js';
import { updateSyslogDeliveryCount } from './correlate.js';
import { log } from '../../../shared/logging/log.js';
import { recordFailure } from '../../../shared/redaction.js';
import { humanFalsePositive } from '../domain/triage-case.js';

// parseSyslog 自己写死的三条判定语（syslog-input.js:46/52/56）：不是上游原文，照原样留。
const syslogParseFailures = ['不是合法的 RFC5424 syslog 行', 'syslog JSON 正文不是对象', 'syslog 正文解析后为空'];

// 轮询的一轮一页：一页 50 条（与 cloudwalker 的页上限一致），最多 20 页。
const POLL_PAGE_SIZE = 50;
const MAX_POLL_PAGES = 20;

// A4：告警类型风险档位。数值越大越先研判；表外/未知类型按 0 排最后。
// 档位按「处置时限」排：内存马 / WebShell / 反弹 Shell / 恶意文件是可直接利用的入口，接着是内存安全与蜜罐，
// 再往下是提权、暴力破解、异常登录、可疑操作、网络审计。改档位就是改优先级，文档里逐类列了值。
export const typeRisk = Object.freeze({
  memory_webshell: 11, webshell: 10, revshell: 10, malware: 10, memory_security: 9,
  honeypot: 8, elevation_process: 8, brute_force: 7, abnormal_login: 6,
  suspicious_operation: 5, network_audit: 4
});

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

export const queueColumn = {
  // A5：队列深度只看「排队 + 在跑」，已完结的记录不占配额。
  _queueFull() {
    let depth = 0;
    for (const record of this.records.values())
      if (record.status === 'queued' || record.status === 'running') depth += 1;
    return depth >= this.queueLimit;
  },

  _countDropped(count, reason) {
    this.dropped += count;
    log('triage.dropped', { reason, count, dropped: this.dropped, queue_limit: this.queueLimit }, 'warn');
  },

  async enqueue(alertId, { retry = false } = {}) {
    const existing = this.records.get(alertId);
    if (String(alertId).startsWith('syslog:') && !existing?.input) {
      const error = new Error('该 syslog 告警的原始报文不存在，无法重试');
      error.status = 404;
      throw error;
    }
    if (existing && !retry) return this.status(alertId);
    if (existing?.status === 'running') return this.status(alertId);
    if (this._queueFull()) {
      this._countDropped(1, 'manual');
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
  },

  // A1：增量轮询。游标只由 `from`（上一轮最大 createdAt，含端点）决定，不再翻页找边界；
  // 同秒的`watermarkIds`只用来去重，不参与边界判定。返回本轮结果给 _schedule 算退避。
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
        if (this._queueFull()) { skipped += 1; continue; }
        this.records.set(alertId, { alert_id: alertId, status: 'queued', stage: '等待研判',
          detail: '牧云新增告警已进入队列', created_at: this.lastPollAt, updated_at: this.lastPollAt,
          steps: [], attempts: 0 });
        log('triage.enqueued', { alert_id: alertId, source: 'poll' });
      }
      if (skipped) this._countDropped(skipped, 'poll');
      await this.persist();
      this.drain();
    } catch (error) {
      failed = true;
      if (pollEpoch === this.pollEpoch) {
        // 记录侧不写错误原文（P003-T052）：`lastError` 上状态接口，只留固定文案 + 字符量。
        this.lastError = recordFailure(error);
        log('triage.poll_failed', { error: error.message }, 'warn');
      }
    }
    finally { this.polling = false; }
    // 空轮（含失败轮）指数退避；见到新告警立刻回常态（A1）。
    if (found.length) this.emptyPolls = 0; else this.emptyPolls += 1;
    this.backoffMs = this.emptyPolls === 0 ? this.intervalMs
      : Math.min(this.intervalMs * 2 ** this.emptyPolls, this.maxBackoffMs);
    return { found: found.length, empty: found.length === 0, failed };
  },

  acceptSyslog(line) {
    this.syslogStats.inbound += 1;
    const job = this.acceptChain.catch(() => {}).then(() => this._acceptSyslog(line));
    // 收包链上的抛错不能静默：下一条报文之前没人会知道这条丢了。
    this.acceptChain = job.catch(error => {
      this.syslogStats.failed += 1;
      log('syslog.accept_failed', { error: String(error?.message || error) }, 'error');
    });
    return job;
  },

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
      // 记录侧不写错误原文（P003-T052）：`lastError` 经 `summary().last_error` 出状态接口；
      // 日志行仍留原文（日志侧归 P003-T046 的闸，本卡不动）。
      this.lastError = `syslog 解析失败：${recordFailure(error, { keep: syslogParseFailures })}`;
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
    if (this._queueFull()) {
      this._countDropped(1, 'syslog');
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
  },

  async contextFor(record) {
    const parsed = record.input.parsed;
    const seconds = eventSeconds(parsed);
    const session = record.session_key;
    const sourceIp = parsed.payload.source_ip || parsed.payload.login_ip;
    const window = (this.windows.get(session) || []).filter(item => seconds == null ||
      item.at == null || Math.abs(seconds - item.at) <= 300).slice(-200);
    const history = [...this.records.values()].filter(item => item.status === 'done' && item.input &&
      (item.session_key === session || sourceIp && (item.input.parsed.payload.source_ip || item.input.parsed.payload.login_ip) === sourceIp ||
        parsed.payload.user_name && item.input.parsed.payload.user_name === parsed.payload.user_name ||
        parsed.payload.process_command_line && item.input.parsed.payload.process_command_line === parsed.payload.process_command_line))
      .slice(-50).map(item => ({ at: item.updated_at, conclusion: item.verdict,
        alert_id: item.matched_alert_id || item.alert_id }));
    return { session_key: session, window, window_seconds: 600,
      occurrence_count: record.occurrence_count || 1, delivery_count: record.repeat_count || 1, history };
  },

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
  },

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
        // 记录侧不写错误原文（P003-T052）：同 `lastError`，只留固定文案 + 字符量。
        this.lastError = `研判状态保存失败：${recordFailure(error, { kind: '本地写入失败' })}`;
        log('triage.persist_failed', { alert_id: next.alert_id, error: error.message }, 'error');
      })
        .finally(() => { this.active--; this.drain(); });
    }
  },


  // 牧云取数调用包一层：syslog 事件匹配内部会把失败降级成 reason（syslog-case.js 不在本卡 scope），
  // 只有套在调用点上，cloudwalker.call_failed 才留得下来。日志记完原样抛出，降级策略不变。
  async cloudwalkerCall(op, job) {
    try { return await job(); }
    catch (error) {
      log('cloudwalker.call_failed', { op, alert_id: null, error: String(error?.message || error) }, 'error');
      throw error;
    }
  },

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
};
