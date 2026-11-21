// trace 上下文 · 应用层：溯源白板的编排（P003-T075 批 1，试点）。
// 依赖全部注入：toolbox / model / promptStore / analysis 是端口，落盘走 infrastructure/board-store.js；
// 白板形状、不变量与投影在 domain/board.js。本文件不做 fs、不 import 别的上下文的 domain。
import { assertLink, addCandidate, addGap, alertFromFacts, boundNodeFindings, discover,
  MAX_ASSET_NEIGHBORS, MAX_GLOBAL_PAGES, MAX_INVESTIGATIONS, MAX_NODES, MAX_ROUNDS, MAX_TYPE_PAGES,
  olderThanWindow, PAGE_SIZE, presentBoard, privateIp, profileFrom, resultRows, reuseRecord, rowFacts,
  rowTime, short, summarizeBoard, summarizeRecord, traceBoardSeed, traceIpSeed, traceTarget, validIp,
  withinWindow } from '../domain/board.js';
import { recordFailure } from '../../../shared/redaction.js';
import { normalizeAlert } from '../../../shared/alert-shape.js';
import { eventTypes } from '../../../shared/vocabulary.js';

// ── 模型回包 → 白板动作（application 职责：解析外部输入）────────────────────────
function parseAction(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const action = JSON.parse(text);
  if (!action || typeof action !== 'object' || !['look', 'investigate', 'link', 'conclude'].includes(action.action))
    throw new Error('模型未返回有效的白板操作');
  return action;
}

const now = () => new Date().toISOString();

export class TraceBoardService {
  // store（infrastructure/board-store.js）由装配注入（R-STRUCT+：application 不自己 new 适配器）。
  constructor({ toolbox, model, promptStore, store, analysis = null }) {
    if (!store) throw new Error('TraceBoardService 需要注入 board-store（store 端口）');
    this.toolbox = toolbox;
    this.model = model;
    this.promptStore = promptStore;
    this.directory = store.directory;
    // analysis(alertId) 回告警分析已经落盘的起点证据（syslog 原始报文等）；没有就回 null。
    // 端口由装配注入（server.js 的 createAnalysisProvider）——trace 不 import triage 的实现。
    this.analysis = analysis;
    this.store = store;
    this.running = new Map();
  }

  file(boardId) { return this.store.file(boardId); }
  async read(boardId) { return this.store.read(boardId); }
  async save(board) { return this.store.save(board); }

  // 全量摘要，按更新时间倒序。list / page 共用；目录不存在等同于没有白板。
  async summaries() {
    const boards = await this.store.rawAll();
    return boards.map(board => summarizeBoard(board))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  // HTTP 列表用：先按状态 / 类型 / 主机 / 告警时间筛，再切页；total 是筛后的总数。参数合法性由调用方校验。
  async page({ count = 20, offset = 0, statuses = [], type = null, host = null, from = null, to = null } = {}) {
    let boards = await this.summaries();
    if (Array.isArray(statuses) && statuses.length) boards = boards.filter(board => statuses.includes(board.status));
    if (type) boards = boards.filter(board => board.type === type);
    if (host) boards = boards.filter(board => board.host === host);
    if (from != null || to != null) boards = boards.filter(board => {
      const occurredAt = Date.parse(board.occurred_at || '');
      if (Number.isNaN(occurredAt)) return false;
      return (from == null || occurredAt >= from) && (to == null || occurredAt <= to);
    });
    return { boards: boards.slice(offset, offset + count), total: boards.length };
  }

  async list(limit = 20) {
    return (await this.page({ count: Math.max(1, Math.min(50, limit)) })).boards;
  }

  async get(boardId) {
    const board = await this.read(boardId);
    if (!board) return null;
    if (board.status === 'running' && !this.running.has(board.id || boardId)) {
      board.status = 'interrupted';
      addGap(board, null, '后端进程重启；可以重新开始调查。');
      if (!Array.isArray(board.activity)) board.activity = [];
      board.activity.push({ at: now(), kind: 'error', title: '调查已中断', detail: '后端进程重启；可以重新开始调查。' });
      await this.save(board);
    }
    return presentBoard(board);
  }

  // A1：从一条告警（或 IP）创建溯源。已有白板直接返回那条，不重查事件、不覆盖。
  // 已知旧账：同一新目标的并发 POST 仍是 check-then-act（读盘与建板之间没有锁），两个请求可能各建一次、后写覆盖前写；
  // 单进程里 running 只挡住已经进 explore 的那一个。本轮不改（P003-T014 复审 minor）。
  async startOrResume(target, focus = '') {
    const spec = traceTarget(target);
    if (!spec) throw Object.assign(new Error('请输入有效告警 ID 或 IPv4 地址'), { status: 400 });
    if (this.running.has(spec.boardId)) return { created: false, board: await this.get(spec.boardId) };
    const existing = await this.read(spec.boardId);
    if (existing) return { created: false, board: await this.get(spec.boardId) };
    const session = this.toolbox.investigation(2000);
    let board;
    if (spec.kind === 'ip') board = traceIpSeed(spec.address);
    else {
      let reused = null;
      if (this.analysis) {
        try { reused = await this.analysis(spec.boardId); }
        catch { reused = null; }
      }
      if (reused) {
        // A4：分析已经取到的证据直接引用，不再为同一份事件详情查一遍。
        const alert = alertFromFacts(spec, reused.facts || {});
        if (!alert.assetIp) throw Object.assign(new Error('该告警没有可用的主机；可手动输入 IP 开始溯源'), { status: 422 });
        board = traceBoardSeed(alert, reuseRecord(reused, reused.facts || {}));
        board.origin_evidence = { ...board.origin_evidence, evidence_id: reused.evidence_id, tool: reused.tool,
          reused: true, reused_from: 'alert-analysis' };
      } else if (spec.kind === 'syslog') {
        throw Object.assign(new Error('该告警还没有分析记录或原始报文，无法溯源'), { status: 422 });
      } else {
        const original = await session.callTool(`get_${spec.type}_event`, { id: spec.eventId });
        const detail = original.result?.event || original.result?.data || original.result;
        const alert = normalizeAlert(spec.type, { ...detail, id: spec.eventId });
        board = traceBoardSeed(alert, original);
        if (!board.seed) throw Object.assign(new Error('该告警没有可用的资产或来源 IP；可手动输入 IP 开始溯源'), { status: 422 });
      }
    }
    board.model = this.model.model;
    board.focus = short(focus, 300);
    await this.save(board);
    const work = this.explore(board, session).catch(async error => {
      board.status = 'failed'; addGap(board, null, recordFailure(error));
      board.activity.push({ at: now(), kind: 'error', title: '调查中断', detail: recordFailure(error) });
      await this.save(board);
    }).finally(() => this.running.delete(spec.boardId));
    this.running.set(spec.boardId, work);
    return { created: true, board: presentBoard(board) };
  }

  async start(target, focus = '') { return (await this.startOrResume(target, focus)).board; }

  async investigate(board, session, node, reason, catalog) {
    const entry = board.nodes.find(item => item.id === node);
    if (!entry) throw new Error(`白板中没有节点 ${node}`);
    if (entry.status === 'done') throw new Error(`${node} 已查过，请选择其他节点`);
    const records = [], available = new Set(catalog.map(tool => tool.name));
    if (entry.id === board.seed && session.records?.get('cw:1')) records.push(session.records.get('cw:1'));
    const call = async (name, args) => {
      if (!available.has(name) || session.started >= session.maxCalls) return null;
      try {
        const record = await session.callTool(name, args);
        records.push(record);
        const { rows } = resultRows(record);
        board.activity.push({ at: now(), kind: 'tool', title: `牧云查询 ${name}`,
          detail: `${record.evidenceId} · 返回 ${rows.length} 条 · ${JSON.stringify(args)}` });
        await this.save(board);
        return record;
      } catch (error) {
        board.activity.push({ at: now(), kind: 'tool_error', title: `${name} 查询失败`, detail: recordFailure(error) });
        await this.save(board);
        return null;
      }
    };
    const scope = entry.kind === 'asset' ? { host_ip: [entry.address] } : { source_ip: [entry.address] };
    if (entry.kind === 'asset') {
      await call('list_host_assets', { count: 5, filters: { host_ip: [entry.address] } });
      const host = records.find(record => record.tool === 'list_host_assets');
      const raw = host?.result?.hosts?.[0] || host?.result?.result?.[0] || host?.result?.data?.[0] || host?.result?.list?.[0];
      const hostId = Number(raw?.host_id || raw?.id || raw?.host_view?.id);
      if (Number.isSafeInteger(hostId) && hostId > 0) {
        await call('list_host_events', { id: hostId, count: PAGE_SIZE });
      }
    }
    const types = new Set();
    for (let page = 0; page < MAX_GLOBAL_PAGES; page++) {
      const record = await call('list_global_events', { count: PAGE_SIZE, offset: page * PAGE_SIZE, ...scope });
      if (!record) break;
      const { rows } = resultRows(record);
      for (const row of rows) if (Object.hasOwn(eventTypes, row.event_type) && withinWindow(row, board)) types.add(row.event_type);
      if (rows.length < PAGE_SIZE || rows.some(row => olderThanWindow(row, board))) break;
      if (page === MAX_GLOBAL_PAGES - 1 && Number(record.result?.total) > (page + 1) * PAGE_SIZE)
        addGap(board, entry.id, `${entry.address} 的跨类事件超过当前 ${MAX_GLOBAL_PAGES * PAGE_SIZE} 条查询范围，后续类型可能未发现`);
    }
    for (const type of types) {
      for (let page = 0; page < MAX_TYPE_PAGES; page++) {
        const record = await call(`list_${type}_events`, { count: PAGE_SIZE, offset: page * PAGE_SIZE, ...scope });
        if (!record) break;
        const { rows } = resultRows(record);
        if (rows.length < PAGE_SIZE || rows.some(row => olderThanWindow(row, board))) break;
        if (page === MAX_TYPE_PAGES - 1 && Number(record.result?.total) > (page + 1) * PAGE_SIZE)
          addGap(board, entry.id, `${entry.address} 的 ${type} 事件超过当前 ${MAX_TYPE_PAGES * PAGE_SIZE} 条查询范围`);
      }
    }
    if (entry.kind === 'external_ip')
      await call('list_firewall_connection_records', { count: PAGE_SIZE, filters: { source_cidr: [entry.address] } });
    const touched = new Set();
    const candidates = new Map();
    const roughRelations = new Map();
    for (const record of records) {
      if (['get_host_info_detail', 'list_host_assets'].includes(record.tool)) Object.assign(entry.profile, profileFrom(record));
      const result = resultRows(record);
      const items = result.key ? result.rows.map((row, index) => ({ row, prefix: [result.key, index] }))
        : [{ row: record.result?.event || record.result?.data || record.result, prefix: record.result?.event ? ['event'] : record.result?.data ? ['data'] : [] }];
      for (const { row, prefix } of items) {
        if (!row || !withinWindow(row, board)) continue;
        if (entry.kind === 'asset' && !entry.profile.ip) Object.assign(entry.profile, profileFrom({ result: row }));
        const facts = rowFacts(row, prefix);
        for (const key of ['host_ip', 'source_ip', 'destination_address']) {
          const field = facts[key];
          if (!validIp(field?.value) || field.value === entry.address) continue;
          const kind = key === 'host_ip' || privateIp(field.value) ? 'asset' : 'external_ip';
          const id = `${kind === 'asset' ? 'asset' : 'ip'}:${field.value}`;
          const observedAt = rowTime(row);
          const candidate = candidates.get(id) || { address: field.value, kind, count: 0,
            source: { evidence_id: record.evidenceId, pointer: field.pointer,
              occurred_at: observedAt == null ? null : new Date(observedAt).toISOString() } };
          candidate.count++;
          candidates.set(id, candidate);
        }
        const source = facts.source_ip, host = facts.host_ip;
        if (entry.kind === 'external_ip' && validIp(host?.value)) touched.add(host.value);
        if (validIp(source?.value) && !privateIp(source.value) && validIp(host?.value) && source.value !== host.value) {
          const from = `ip:${source.value}`, to = `asset:${host.value}`;
          const key = `${from}->${to}`;
          if (!roughRelations.has(key)) roughRelations.set(key, {
            from, to, rel: '触达线索', why: '同一条牧云事件记录包含来源 IP 与目标主机；待 AI 判断关系性质',
              strength: 0.3, by: 'program', at: now(), citations: [source, host].map(field =>
                ({ evidence_id: record.evidenceId, pointer: field.pointer, value: field.value })) });
        }
      }
    }
    const ranked = [...candidates.values()].filter(candidate => !board.nodes.some(node =>
      node.id === `${candidate.kind === 'external_ip' ? 'ip' : 'asset'}:${candidate.address}`))
      .sort((a, b) => b.count - a.count);
    const limit = Math.min(MAX_NODES - board.nodes.length, entry.kind === 'asset' ? MAX_ASSET_NEIGHBORS : MAX_NODES);
    if (ranked.length > limit)
      addGap(board, entry.id, `${entry.address} 发现 ${ranked.length} 个邻接地址，本轮图中仅加入相关记录最多的 ${limit} 个`);
    for (const candidate of ranked.slice(0, limit))
      addCandidate(board, candidate.address, candidate.kind, candidate.source);
    // 程序自动建的边与 AI 建的边过同一道不变量：link 两端 hop 必须真实存在（批 1 完成标志）。
    for (const edge of roughRelations.values()) {
      assertLink(board, edge.from, edge.to);
      if (!board.edges.some(existing => existing.from === edge.from &&
        existing.to === edge.to && existing.by === 'program')) {
        board.edges.push(edge);
        discover(board, 'link', `link:${board.edges.length - 1}`);
      }
    }
    entry.touched_hosts = [...touched];
    entry.status = 'done'; entry.why = short(reason || 'AI 选择继续追查这个节点'); entry.investigated_at = now();
    entry.findings = boundNodeFindings(records.map(record => summarizeRecord(record, board)));
    entry.finding_count = entry.findings.filter(item => /^list_(?!global|host_assets|host_events)/.test(item.tool))
      .reduce((sum, item) => sum + item.returned, 0) +
      (records.some(record => record.tool.startsWith('get_') && record.tool.endsWith('_event')) ? 1 : 0);
    board.investigations++;
    board.activity.push({ at: now(), kind: 'investigate', title: `调查 ${entry.label}`, detail: entry.why,
      node: entry.id, result: `${records.length} 个工具返回；当前页共 ${entry.finding_count} 条记录；发现 ${board.nodes.filter(item => item.status === 'pending').length} 个待查节点。` });
    await this.save(board);
    const groups = new Map();
    for (const item of entry.findings.filter(item => item.returned)) {
      const group = groups.get(item.tool) || { tool: item.tool, total: item.total, returned: 0, rows: [] };
      group.returned += item.returned;
      for (const row of item.rows.slice(0, 3 - group.rows.length))
        group.rows.push({ evidence_id: item.evidence_id, ...row });
      groups.set(item.tool, group);
    }
    const modelFindings = [...groups.values()];
    while (JSON.stringify(modelFindings).length > 30000) {
      const extra = [...modelFindings].reverse().find(item => item.rows.length > 1);
      if (extra) extra.rows.pop();
      else if (modelFindings.length > 1) modelFindings.pop();
      else break;
    }
    return { node: entry.id, profile: entry.profile, findings: modelFindings,
      touched_hosts: entry.touched_hosts,
      candidates: board.nodes.filter(item => item.status === 'pending').map(item => ({ id: item.id, label: item.label })) };
  }

  async explore(board, session) {
    if (!this.promptStore) throw new Error('溯源白板未配置提示词仓');
    const prompts = await this.promptStore.load();
    const catalog = await this.toolbox.listTools();
    const messages = [{ role: 'system', content: prompts.prompts.trace },
      { role: 'user', content: JSON.stringify({ task: '从这条告警出发进行溯源。先看白板，再选择节点调查、验证关系、总结缺口。',
        alert_id: board.alert_id, target: board.id, seed: board.seed, nodes: board.nodes,
        origin_evidence: board.origin_evidence, time_window: board.window,
        focus_from_operator: board.focus,
        max_investigations: MAX_INVESTIGATIONS }) }];
    let failures = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round > 0) {
        board.activity.push({ at: now(), kind: 'thinking', title: 'AI 分析下一步',
          detail: `已调查 ${board.investigations} 个节点，正在决定继续查询、连线或结束。` });
        await this.save(board);
      }
      const reply = await this.model.complete(messages, [], 'none');
      let action;
      try { action = parseAction(reply.content); } catch (error) {
        const detail = error instanceof SyntaxError ? '模型返回的白板操作 JSON 不完整或格式错误'
          : recordFailure(error, { kind: '白板操作失败' });
        board.activity.push({ at: now(), kind: 'model_error', title: 'AI 操作格式错误，正在重试',
          detail: `${detail}；响应长度 ${String(reply.content || '').length}` });
        await this.save(board);
        if (++failures >= 3) throw new Error(`${detail}，连续重试 3 次仍失败`);
        messages.push({ role: 'user', content: JSON.stringify({ error: detail,
          instruction: '请只返回一个完整的 JSON 对象，包含 action 字段；闭合所有引号和括号，不要附加说明。' }) });
        continue;
      }
      messages.push({ role: 'assistant', content: reply.content });
      let result;
      try {
        if (action.action === 'look') {
          result = { nodes: board.nodes.map(node => ({ id: node.id, status: node.status,
            finding_count: node.finding_count })), edges: board.edges, investigations: board.investigations };
          board.activity.push({ at: now(), kind: 'look', title: '查看白板', detail: `目前有 ${board.nodes.length} 个节点、${board.edges.length} 条已确认关系。` });
          await this.save(board);
        }
        if (action.action === 'investigate') {
          if (board.investigations >= MAX_INVESTIGATIONS) throw new Error('已达到本次调查的节点上限，请总结现有证据与缺口');
          result = await this.investigate(board, session, action.node, action.why, catalog);
        }
        if (action.action === 'link') {
          const from = board.nodes.find(node => node.id === action.from);
          const to = board.nodes.find(node => node.id === action.to);
          if (!from || !to || from.id === to.id) throw new Error('关系两端必须是白板中不同的节点');
          if (from.status !== 'done' && to.status !== 'done') throw new Error('至少一端必须已调查');
          if (!short(action.rel).trim() || !short(action.why).trim()) throw new Error('关系性质和理由不能为空');
          const citations = Array.isArray(action.citations) ? action.citations : [];
          if (!citations.length || !session.verifyClaims([{ citations }]).ok) throw new Error('关系边缺少有效原始证据引用');
          const cited = citations.map(citation => JSON.stringify(citation.value));
          if (![from.address, to.address].every(address => address && cited.some(value => value.includes(address))))
            throw new Error('关系边的引用必须覆盖两端地址');
          if (board.edges.some(edge => edge.from === from.id && edge.to === to.id && edge.rel === action.rel))
            throw new Error('这条关系已存在');
          // 领域不变量：link 两端 hop 必须真实存在（批 1 完成标志；端点校验在领域层再拦一次）。
          assertLink(board, from.id, to.id);
          const edge = { from: from.id, to: to.id, rel: short(action.rel, 40), why: short(action.why, 400),
            strength: Math.max(0, Math.min(1, Number(action.strength) || 0.5)), citations, by: 'ai', at: now() };
          board.edges.push(edge);
          discover(board, 'link', `link:${board.edges.length - 1}`);
          board.activity.push({ at: now(), kind: 'link', title: `AI 建立关系：${from.label} → ${to.label}`,
            detail: `${edge.rel} · ${edge.why}`, edge: board.edges.length - 1 });
          await this.save(board);
          result = { ok: true, edge };
        }
        if (action.action === 'conclude') {
          if (!board.investigations) throw new Error('尚未调查任何节点，不能结束');
          board.status = 'done'; board.summary = short(action.summary, 2500);
          board.gaps = Array.isArray(action.gaps)
            ? action.gaps.slice(0, 8).map(value => typeof value === 'string'
              ? { hop_id: null, reason: short(value, 240) }
              : { hop_id: value?.hop_id ?? null, reason: short(value?.reason ?? '', 240) }) : [];
          board.activity.push({ at: now(), kind: 'conclude', title: 'AI 完成溯源', detail: board.summary });
          await this.save(board); return;
        }
        failures = 0;
      } catch (error) {
        result = { error: short(error.message) };
        // 回灌给模型的那份留原文（模型靠它改参数，P003-T051 S2 同口径）；落白板的只留固定文案。
        board.activity.push({ at: now(), kind: 'tool_error', title: '操作未通过校验',
          detail: recordFailure(error, { kind: '操作未通过校验' }) });
        await this.save(board);
        if (++failures >= 5) throw error;
      }
      messages.push({ role: 'user', content: JSON.stringify({ tool_result: result,
        board: { nodes: board.nodes.map(node => ({ id: node.id, status: node.status, finding_count: node.finding_count })),
          edges: board.edges.map(edge => ({ from: edge.from, to: edge.to, rel: edge.rel })) },
        remaining_investigations: MAX_INVESTIGATIONS - board.investigations }) });
      if (JSON.stringify(messages).length > 70000) messages.splice(2, Math.max(0, messages.length - 8));
    }
    board.status = 'done'; board.summary = '已达到本次调查轮次上限；请查看已核验关系与未查节点。';
    addGap(board, null, '调查达到轮次上限，未完成的路径需继续人工核查');
    await this.save(board);
  }
}
