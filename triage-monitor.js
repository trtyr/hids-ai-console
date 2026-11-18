import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eventSeconds, eventTypeFor, fingerprint, parseSyslog, sessionKey } from './syslog-input.js';
import { matchSyslogEvent, updateSyslogDeliveryCount, writeSyslogCase, writeSyslogResult } from './syslog-case.js';

// 结论排序的档位：threat 在前，其余同档保持时间倒序；没有结论的记录排最后。
const verdictRanks = Object.freeze({ threat: 0, uncertain: 1, false_positive: 2 });

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
  constructor({ service, investigator, history, file, intervalMs = 30000, concurrency = 2,
    inputMode = 'poll', eventToolbox = null, wiki = null, casesDirectory = null,
    baselineFile = null, intelFile = null, ruleEngine = null }) {
    this.service = service;
    this.investigator = investigator;
    this.history = history;
    this.file = file;
    this.intervalMs = intervalMs;
    this.concurrency = concurrency;
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
    this.writeChain = Promise.resolve();
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
      this.records = new Map((data.records || []).map(record => [record.alert_id,
        record.status === 'running' ? { ...record, status: 'queued', stage: '等待重试' } : record]));
      this.dedupe = new Map(data.dedupe || []);
      this.windows = new Map(data.windows || []);
      for (const record of this.records.values()) {
        if (record.status !== 'done') continue;
        const needsCounts = !Number.isInteger(record.verified_facts);
        const needsEvidence = !Array.isArray(record.evidence);
        if (!needsCounts && !needsEvidence) continue;
        const result = await this.history.latest(record.alert_id, 'triage');
        if (!result) continue;
        if (needsCounts) Object.assign(record, evidenceSummary(result));
        // 旧队列里没有 evidence[]：从研判记录就地补，不写单独迁移脚本。
        if (needsEvidence) record.evidence = evidenceItems(result.evidence);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  persist() {
    const snapshot = JSON.stringify({ initialized: this.initialized, enabled: this.enabled, watermark: this.watermark,
      watermark_ids: [...this.watermarkIds], last_received_at: this.lastReceivedAt,
      records: [...this.records.values()], dedupe: [...this.dedupe], windows: [...this.windows] });
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }

  async start() {
    await this.load();
    if (this.inputMode === 'syslog') { this.initialized = true; if (this.enabled) this.drain(); return; }
    if (this.enabled) { await this.poll(); this.drain(); }
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

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
    } catch (cause) {
      // 绑定失败不能让队列静默收不到消息：记进 summary()，队列照常服务（HTTP 还要活）。
      this.syslog = { listening: false, bind: null, error: String(cause?.message || cause).slice(0, 300) };
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
      const type = eventTypeFor(record.input?.parsed?.msgid) || 'unknown';
      type_counts[type] = (type_counts[type] || 0) + 1;
    }
    return { initialized: this.initialized, enabled: this.enabled, input_mode: this.inputMode,
      since: sinceMs == null ? null : new Date(sinceMs).toISOString(),
      last_poll_at: this.lastPollAt, last_error: this.lastError, counts, verdict_counts, type_counts,
      ...(this.inputMode === 'poll' ? { interval_ms: this.intervalMs }
        : { syslog: { ...this.syslog }, last_received_at: this.lastReceivedAt }) };
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') { const error = new Error('enabled 必须为布尔值'); error.status = 400; throw error; }
    if (enabled !== this.enabled) this.pollEpoch++;
    if (enabled && !this.enabled) {
      // 恢复以按钮点击时刻为新游标；暂停期间积压的任务不自动补跑。
      // 牧云事件时间精确到秒；保留点击所在秒，避免漏掉同秒稍后产生的告警。
      this.watermark = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
      this.watermarkIds.clear();
      this.initialized = true;
      for (const [alertId, record] of this.records) if (record.status === 'queued') this.records.delete(alertId);
    }
    this.enabled = enabled;
    await this.persist();
    if (enabled) { if (this.inputMode === 'poll') await this.poll(); this.drain(); }
    return this.summary();
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
    const now = new Date().toISOString();
    this.records.set(alertId, { alert_id: alertId,
      ...(existing?.input ? { input: existing.input, occurrence_count: existing.occurrence_count,
        session_key: existing.session_key, repeat_count: existing.repeat_count } : {}),
      status: 'queued', stage: '等待研判', detail: '已进入自动研判队列',
      created_at: existing?.created_at || now, updated_at: now, steps: existing?.steps || [], attempts: existing?.attempts || 0 });
    await this.persist();
    this.drain();
    return this.status(alertId);
  }

  async poll() {
    if (this.inputMode === 'syslog') return;
    if (this.polling || !this.enabled) return;
    this.polling = true;
    const pollEpoch = this.pollEpoch;
    try {
      let offset = 0;
      let newest = this.watermark;
      const newestIds = new Set(this.watermarkIds);
      let boundaryReached = false;
      const found = [];
      for (let page = 0; page < 20; page++) {
        const response = await this.service.alerts({ count: 50, offset });
        if (response.partial) throw new Error('部分牧云事件类型读取失败，暂缓推进自动研判游标');
        const rows = response.alerts || [];
        if (!this.initialized) {
          newest = rows[0]?.createdAt || new Date().toISOString();
          for (const row of rows) if (row.createdAt === newest) newestIds.add(row.id);
          boundaryReached = true;
          break;
        }
        for (const row of rows) {
          if (!row.createdAt || row.createdAt < this.watermark) { boundaryReached = true; continue; }
          if (row.createdAt === this.watermark) {
            boundaryReached = true;
            if (this.watermarkIds.has(row.id)) continue;
          }
          if (!newest || row.createdAt > newest) { newest = row.createdAt; newestIds.clear(); }
          if (row.createdAt === newest) newestIds.add(row.id);
          if (!this.records.has(row.id)) found.push(row.id);
        }
        if (boundaryReached || rows.length < 50) { boundaryReached = true; break; }
        offset += 50;
      }
      if (!boundaryReached) throw new Error('新增告警超过本轮扫描上限，请检查自动研判积压');
      if (!this.enabled || pollEpoch !== this.pollEpoch) return;
      this.initialized = true;
      this.watermark = newest;
      this.watermarkIds = newestIds;
      this.lastPollAt = new Date().toISOString();
      this.lastError = null;
      for (const alertId of found.reverse()) {
        this.records.set(alertId, { alert_id: alertId, status: 'queued', stage: '等待研判',
          detail: '牧云新增告警已进入队列', created_at: this.lastPollAt, updated_at: this.lastPollAt,
          steps: [], attempts: 0 });
      }
      await this.persist();
      this.drain();
    } catch (error) { if (pollEpoch === this.pollEpoch) this.lastError = error.message; }
    finally { this.polling = false; }
  }

  acceptSyslog(line) {
    const job = this.acceptChain.catch(() => {}).then(() => this._acceptSyslog(line));
    this.acceptChain = job.catch(() => {});
    return job;
  }

  async _acceptSyslog(line) {
    if (this.inputMode !== 'syslog') throw new Error('自动研判未使用 syslog 输入');
    if (!this.enabled) return { skipped: 'paused' };
    let parsed;
    try { parsed = parseSyslog(line); }
    catch (error) { this.lastError = `syslog 解析失败：${error.message}`; return { error: this.lastError }; }
    const type = eventTypeFor(parsed.msgid);
    if (!type) return { skipped: 'no_agent_for_msgid', msgid: parsed.msgid };
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
        if (record.status === 'done' && record.result_alert_id) {
          const saved = await this.history.latest(record.result_alert_id, 'triage');
          if (saved) await this.history.save({ ...saved, repeat_count: record.repeat_count,
            syslog: saved.syslog ? { ...saved.syslog, repeat_count: record.repeat_count } : undefined });
        }
        if (record.status === 'done') await updateSyslogDeliveryCount(record.case_dir, record.repeat_count);
      }
      await this.persist();
      return { collapsed: true, repeat_count: previous.event_delivery_count, alert_id: previous.record_id };
    }
    const occurrence = previous && seconds != null && Math.abs(seconds - previous.last_seen) <= 300
      ? previous.occurrence_count + 1 : 1;
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
    await this.persist();
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
      const next = [...this.records.values()].find(record => record.status === 'queued');
      if (!next) break;
      this.active++;
      next.status = 'running';
      next.stage = '准备研判';
      next.updated_at = new Date().toISOString();
      next.attempts = (next.attempts || 0) + 1;
      void this.run(next).catch(error => { this.lastError = `研判状态保存失败：${error.message}`; })
        .finally(() => { this.active--; this.drain(); });
    }
  }

  async run(record) {
    try {
      await this.persist();
      let targetId = record.alert_id;
      let caseInfo = null;
      let match = null;
      let ruleDecision = { status: 'disabled' };
      if (record.input) {
        record.input.context = await this.contextFor(record);
        record.stage = '关联事件'; record.detail = '优先按事件 ID 精确读取牧云详情，并核对主机身份';
        match = await matchSyslogEvent(this.eventToolbox, record.input.parsed);
        if (match.matched) { targetId = match.alert_id; record.matched_alert_id = targetId; }
      }
      if (this.ruleEngine) {
        try { ruleDecision = await this.ruleEngine.evaluate({ alertId: targetId,
          parsed: record.input?.parsed || null, toolbox: this.eventToolbox, match }); }
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
        await this.persist();
      }
      const onProgress = (stage, detail) => {
        record.stage = stage; record.detail = detail; record.updated_at = new Date().toISOString();
        record.steps.push({ stage, detail, at: record.updated_at });
        if (record.steps.length > 80) record.steps.shift();
        void this.persist().catch(error => { this.lastError = `研判进度保存失败：${error.message}`; });
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
      record.detail = saved.verdict?.summary || '研判记录已保存';
      record.decision_source = saved.decision_source || 'ai';
      record.rule_id = saved.rule_evaluation?.rule?.id || null;
      record.verdict = saved.verdict?.verdict; record.verdict_label = saved.verdict?.verdict_label;
      record.summary = saved.verdict?.summary; record.saved_at = saved.saved_at;
      record.report = saved.verdict?.report || null;
      record.missing_evidence = saved.verdict?.missing_evidence || [];
      record.next_actions = saved.verdict?.next_actions || [];
      record.evidence_refs = (saved.verdict?.claims || []).flatMap(claim => claim.citations || [])
        .slice(0, 10).map(citation => ({ evidence_id: citation.evidence_id, pointer: citation.pointer }));
      record.evidence = evidenceItems(saved.evidence);
      Object.assign(record, evidenceSummary(saved));
    } catch (error) {
      record.status = 'failed'; record.stage = '研判失败'; record.detail = String(error.message || error).slice(0, 250);
    } finally { record.updated_at = new Date().toISOString(); await this.persist(); }
  }
}
