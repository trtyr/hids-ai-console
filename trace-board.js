import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eventTypes, normalizeAlert } from './cloudwalker.js';
import { PromptStore } from './prompt-store.js';

const MAX_INVESTIGATIONS = 12;
const MAX_ROUNDS = 32;
const WINDOW_HOURS = 72;
const PAGE_SIZE = 50;
const MAX_GLOBAL_PAGES = 30;
const MAX_TYPE_PAGES = 10;
const MAX_NODES = 64;
const MAX_ASSET_NEIGHBORS = 12;
const short = (value, length = 240) => String(value ?? '').slice(0, length);
const fact = (item, name) => item?.facts?.[name]?.value;
const validIp = value => typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
  value.split('.').every(part => Number(part) <= 255);
const privateIp = value => /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value);
const now = () => new Date().toISOString();
const pointer = parts => '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
const timeOf = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  const timestamp = Number.isFinite(number) && number > 0
    ? (number < 1e12 ? number * 1000 : number) : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
};
const withinWindow = (row, board) => {
  const timestamp = timeOf(row.created_at ?? row.detected_at ?? row.event_time ?? row.last_seen_at ?? row.timestamp);
  return timestamp == null || (timestamp >= Date.parse(board.window.since) && timestamp <= Date.parse(board.window.until));
};
const olderThanWindow = (row, board) => {
  const timestamp = timeOf(row.created_at ?? row.detected_at ?? row.event_time ?? row.last_seen_at ?? row.timestamp);
  return timestamp != null && timestamp < Date.parse(board.window.since);
};
function resultRows(record) {
  const key = ['events', 'data', 'result', 'list', 'hosts'].find(name => Array.isArray(record.result?.[name]));
  return key ? { key, rows: record.result[key] } : { key: null, rows: [] };
}
function rowFacts(row, prefix) {
  const fields = {
    event_id: ['id', 'event_id'], event_name: ['event_name.zh_cn', 'event_name.name', 'event_name', 'rule_name'],
    event_type: ['event_type'], observed_at: ['created_at', 'detected_at', 'event_time', 'last_seen_at'],
    host_ip: ['host_view.host_ip', 'host_ip'], host_name: ['host_view.host_name', 'host_name'],
    source_ip: ['source_ip', 'login_ip', 'ssh_client_ip', 'src_ip'],
    destination_address: ['remote_addr', 'dest_addr', 'destination_ip', 'dst_ip'],
    destination_port: ['remote_port', 'dest_port', 'port'], user_name: ['uname', 'username', 'login_username', 'user'],
    command_line: ['cmdline', 'command', 'shell_cmdline', 'process_cmdline'],
    process_name: ['exename', 'pname', 'process_name']
  };
  const facts = {};
  for (const [name, paths] of Object.entries(fields)) for (const dotted of paths) {
    const keys = dotted.split('.');
    const value = keys.reduce((part, key) => part && typeof part === 'object' ? part[key] : undefined, row);
    if (value == null || value === '' || typeof value === 'object') continue;
    if (String(value).length > (name === 'command_line' ? 3000 : 500)) continue;
    facts[name] = { value, pointer: pointer([...prefix, ...keys]) };
    break;
  }
  return facts;
}

export function traceBoardSeed(alert, original) {
  const hostIp = [alert.assetIp, fact(original.view, 'host_ip')].find(validIp) ||
    (validIp(alert.target) && privateIp(alert.target) ? alert.target : null);
  const id = hostIp ? `asset:${hostIp}` : validIp(alert.source) ? `ip:${alert.source}` : null;
  const nodes = [{ id, label: hostIp ? (alert.asset && alert.asset !== '未知主机' ? alert.asset : hostIp) : alert.source || alert.id,
    address: hostIp || alert.source || '', kind: hostIp ? 'asset' : 'external_ip', status: 'pending',
    why: '告警涉及的起始资产，先核查它的档案和相关事件', profile: profileFrom(original), findings: [], finding_count: 0,
    discovered_from: [{ evidence_id: original.evidenceId, pointer: fact(original.view, 'host_ip') ? original.view.facts.host_ip.pointer : null }] }];
  for (const [fieldName, address] of [['source_ip', alert.source], ['destination_address', alert.target]]) {
    if (!validIp(address) || address === hostIp || nodes.some(node => node.address === address)) continue;
    nodes.push({ id: `${privateIp(address) ? 'asset' : 'ip'}:${address}`, label: address, address,
      kind: privateIp(address) ? 'asset' : 'external_ip', status: 'pending', why: '',
      profile: privateIp(address) ? {} : { name: '外部 IP（未登记资产）', ip: address }, findings: [], finding_count: 0,
      discovered_from: [{ evidence_id: original.evidenceId, pointer: original.view?.facts?.[fieldName]?.pointer || null }] });
  }
  const observedAt = timeOf(alert.createdAt) || Date.now();
  const until = observedAt + 48 * 3600000;
  return { id: alert.id, alert_id: alert.id, run_id: randomUUID(), title: alert.title, seed: id, status: 'running',
    window: { since: new Date(observedAt - 24 * 3600000).toISOString(), until: new Date(until).toISOString(), hours: WINDOW_HOURS },
    created_at: now(), updated_at: now(), nodes, edges: [], activity: [{ at: now(), kind: 'seed', title: '以告警为起点',
      detail: `${alert.id} · ${alert.title}。已标出告警字段中的资产与地址，尚未确认任何路径。` }],
    summary: '', gaps: [], investigations: 0, model: null, origin_evidence: summarizeRecord(original) };
}

export function traceIpSeed(address) {
  const id = `${privateIp(address) ? 'asset' : 'ip'}:${address}`;
  const until = Date.now();
  return { id: `ip:${address}`, alert_id: null, run_id: randomUUID(), title: `IP 溯源 · ${address}`,
    seed: id, status: 'running', window: { since: new Date(until - WINDOW_HOURS * 3600000).toISOString(),
      until: new Date(until).toISOString(), hours: WINDOW_HOURS }, created_at: now(), updated_at: now(),
    nodes: [{ id, label: address, address, kind: privateIp(address) ? 'asset' : 'external_ip',
      status: 'pending', why: '操作员指定的溯源起点',
      profile: privateIp(address) ? {} : { name: '外部 IP（未登记资产）', ip: address }, findings: [], finding_count: 0,
      discovered_from: [] }], edges: [], activity: [{ at: now(), kind: 'seed', title: '以 IP 为起点',
      detail: `${address}。AI 将从这个地址自主追查关联资产和事件。` }],
    summary: '', gaps: [], investigations: 0, model: null, origin_evidence: null };
}

function addCandidate(board, address, kind, source) {
  if (!validIp(address)) return;
  const id = `${kind === 'external_ip' ? 'ip' : 'asset'}:${address}`;
  if (board.nodes.some(node => node.id === id)) return;
  if (board.nodes.length >= MAX_NODES) return;
  board.nodes.push({ id, label: address, address, kind, status: 'pending', why: '',
    profile: kind === 'external_ip' ? { name: '外部 IP（未登记资产）', ip: address } : {}, findings: [],
    finding_count: 0, discovered_from: [source] });
}

function summarizeRecord(record, board) {
  const { key, rows } = resultRows(record);
  if (!key) {
    const view = record.view || {};
    return { evidence_id: record.evidenceId, tool: record.tool, total: 1, returned: 1,
      rows: [{ facts: view.facts || {} }], truncated: Boolean(view.truncated_for_context) };
  }
  const matching = rows.map((row, index) => ({ row, index })).filter(({ row }) => !board || withinWindow(row, board));
  return { evidence_id: record.evidenceId, tool: record.tool, total: record.result?.total ?? null,
    returned: matching.length, page_returned: rows.length,
    rows: matching.slice(0, 12).map(({ row, index }) => ({ facts: rowFacts(row, [key, index]) })),
    truncated: matching.length > 12 || rows.length >= PAGE_SIZE };
}

function profileFrom(record) {
  const data = record.result?.host || record.result?.event || record.result?.data || record.result?.result || record.result?.host_info || record.result;
  const item = Array.isArray(data) ? data[0] : Array.isArray(data?.hosts) ? data.hosts[0]
    : Array.isArray(data?.events) ? data.events[0] : Array.isArray(data?.data) ? data.data[0] : data;
  if (!item || typeof item !== 'object') return {};
  const view = item.host_view || item;
  const selected = {
    name: view.host_name || view.name, ip: view.host_ip || view.ip,
    os: view.host_os_name || view.os_release_name || view.host_os_type || view.os || view.os_release_version,
    kernel: view.host_kernel_version || view.kernel_version,
    group: view.group_name, state: view.host_state || view.state,
    exposed_ip: view.exposed_ip, tags: view.tags, last_seen: view.host_last_seen_at || view.last_seen_at,
    comment: view.host_comment || view.comment
  };
  return Object.fromEntries(Object.entries(selected).filter(([, value]) => value != null && value !== ''));
}

function parseAction(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const action = JSON.parse(text);
  if (!action || typeof action !== 'object' || !['look', 'investigate', 'link', 'conclude'].includes(action.action))
    throw new Error('模型未返回有效的白板操作');
  return action;
}

export class TraceBoardService {
  constructor({ toolbox, model, promptStore = new PromptStore(), directory }) {
    this.toolbox = toolbox; this.model = model; this.promptStore = promptStore; this.directory = directory;
    this.running = new Map();
  }

  file(boardId) { return path.join(this.directory, `${validIp(boardId) ? `ip:${boardId}` : boardId}.json`); }
  async list(limit = 20) {
    let names;
    try { names = (await readdir(this.directory)).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = await Promise.all(names.map(async name => {
      try {
        const board = JSON.parse(await readFile(path.join(this.directory, name), 'utf8'));
        if (!board.id && !board.alert_id) return null;
        return { id: board.id || board.alert_id, title: board.title || board.id || board.alert_id,
          status: board.status, created_at: board.created_at, updated_at: board.updated_at };
      } catch { return null; }
    }));
    return entries.filter(Boolean).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, Math.max(1, Math.min(50, limit)));
  }
  async get(boardId) {
    try {
      const board = JSON.parse(await readFile(this.file(boardId), 'utf8'));
      if (board.status === 'running' && !this.running.has(board.id || boardId)) {
        board.status = 'interrupted'; board.updated_at = now();
        board.activity.push({ at: now(), kind: 'error', title: '调查已中断', detail: '后端进程重启；可以重新开始调查。' });
        await this.save(board);
      }
      return board;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(board) {
    board.updated_at = now();
    await mkdir(this.directory, { recursive: true });
    const destination = this.file(board.id || board.alert_id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(board), { mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return board;
  }
  async start(target, focus = '') {
    const match = String(target || '').match(/^([a-z_]+):([1-9]\d*)$/);
    const address = String(target || '').replace(/^ip:/, '');
    if ((!match || !Object.hasOwn(eventTypes, match[1])) && !validIp(address))
      throw Object.assign(new Error('请输入有效告警 ID 或 IPv4 地址'), { status: 400 });
    const boardId = match ? target : `ip:${address}`;
    if (this.running.has(boardId)) return this.get(boardId);
    const session = this.toolbox.investigation(2000);
    let board;
    if (match) {
      const original = await session.callTool(`get_${match[1]}_event`, { id: Number(match[2]) });
      const detail = original.result?.event || original.result?.data || original.result;
      const alert = normalizeAlert(match[1], { ...detail, id: Number(match[2]) });
      board = traceBoardSeed(alert, original);
      if (!board.seed) throw Object.assign(new Error('该告警没有可用的资产或来源 IP；可手动输入 IP 开始溯源'), { status: 422 });
    } else board = traceIpSeed(address);
    board.model = this.model.model;
    board.focus = short(focus, 300);
    await this.save(board);
    const work = this.explore(board, session).catch(async error => {
      board.status = 'failed'; board.gaps.push(short(error.message));
      board.activity.push({ at: now(), kind: 'error', title: '调查中断', detail: short(error.message) });
      await this.save(board);
    }).finally(() => this.running.delete(boardId));
    this.running.set(boardId, work);
    return board;
  }

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
        board.activity.push({ at: now(), kind: 'tool_error', title: `${name} 查询失败`, detail: short(error.message) });
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
        board.gaps.push(`${entry.address} 的跨类事件超过当前 ${MAX_GLOBAL_PAGES * PAGE_SIZE} 条查询范围，后续类型可能未发现`);
    }
    for (const type of types) {
      for (let page = 0; page < MAX_TYPE_PAGES; page++) {
        const record = await call(`list_${type}_events`, { count: PAGE_SIZE, offset: page * PAGE_SIZE, ...scope });
        if (!record) break;
        const { rows } = resultRows(record);
        if (rows.length < PAGE_SIZE || rows.some(row => olderThanWindow(row, board))) break;
        if (page === MAX_TYPE_PAGES - 1 && Number(record.result?.total) > (page + 1) * PAGE_SIZE)
          board.gaps.push(`${entry.address} 的 ${type} 事件超过当前 ${MAX_TYPE_PAGES * PAGE_SIZE} 条查询范围`);
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
          const candidate = candidates.get(id) || { address: field.value, kind, count: 0,
            source: { evidence_id: record.evidenceId, pointer: field.pointer } };
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
      board.gaps.push(`${entry.address} 发现 ${ranked.length} 个邻接地址，本轮图中仅加入相关记录最多的 ${limit} 个`);
    for (const candidate of ranked.slice(0, limit))
      addCandidate(board, candidate.address, candidate.kind, candidate.source);
    for (const edge of roughRelations.values()) if (board.nodes.some(node => node.id === edge.from) &&
      board.nodes.some(node => node.id === edge.to) && !board.edges.some(existing => existing.from === edge.from &&
        existing.to === edge.to && existing.by === 'program')) board.edges.push(edge);
    entry.touched_hosts = [...touched];
    entry.status = 'done'; entry.why = short(reason || 'AI 选择继续追查这个节点'); entry.investigated_at = now();
    entry.findings = records.map(record => summarizeRecord(record, board));
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
        const detail = error instanceof SyntaxError ? '模型返回的白板操作 JSON 不完整或格式错误' : short(error.message);
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
          const edge = { from: from.id, to: to.id, rel: short(action.rel, 40), why: short(action.why, 400),
            strength: Math.max(0, Math.min(1, Number(action.strength) || 0.5)), citations, by: 'ai', at: now() };
          board.edges.push(edge);
          board.activity.push({ at: now(), kind: 'link', title: `AI 建立关系：${from.label} → ${to.label}`,
            detail: `${edge.rel} · ${edge.why}`, edge: board.edges.length - 1 });
          await this.save(board);
          result = { ok: true, edge };
        }
        if (action.action === 'conclude') {
          if (!board.investigations) throw new Error('尚未调查任何节点，不能结束');
          board.status = 'done'; board.summary = short(action.summary, 2500);
          board.gaps = Array.isArray(action.gaps) ? action.gaps.slice(0, 8).map(value => short(value, 240)) : [];
          board.activity.push({ at: now(), kind: 'conclude', title: 'AI 完成溯源', detail: board.summary });
          await this.save(board); return;
        }
        failures = 0;
      } catch (error) {
        result = { error: short(error.message) };
        board.activity.push({ at: now(), kind: 'tool_error', title: '操作未通过校验', detail: result.error });
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
    board.gaps.push('调查达到轮次上限，未完成的路径需继续人工核查');
    await this.save(board);
  }
}
