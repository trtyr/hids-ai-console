// trace 上下文 · 领域层（P003-T075 迁移批 1，试点）。
// 白板是聚合根：hop / link / gap / node / edge / citation 的形状、不变量与纯投影都在这里；
// 存取（fs）在 infrastructure/board-store.js，编排（AI 探查循环）在 application/trace-service.js。
// 依赖纪律：本文件只 import shared（vocabulary / alert-shape）与 node:crypto——不碰 fs、不碰别的上下文。
import { createHash, randomUUID } from 'node:crypto';
import { eventTypes } from '../../../shared/vocabulary.js';

export const MAX_INVESTIGATIONS = 12;
export const MAX_ROUNDS = 32;
export const WINDOW_HOURS = 72;
export const PAGE_SIZE = 50;
// A4/A5：白板 findings 按页落完整投影（一次工具调用一页，最多 PAGE_SIZE 行），不再只留 12 行。
// 两层上界：每个工具调用 16000 字、每个节点 120000 字。超界只按「行」收缩并记 rows_omitted，
// 证据编号与计数一律保留——少的是行，不是「这次查过什么」。
export const findingsRowLimit = PAGE_SIZE;
export const findingsRowsMaxChars = 16000;
export const findingsNodeMaxChars = 120000;
export const MAX_GLOBAL_PAGES = 30;
export const MAX_TYPE_PAGES = 10;
export const MAX_NODES = 64;
export const MAX_ASSET_NEIGHBORS = 12;
export const TRACE_STATUSES = Object.freeze(['running', 'done', 'failed', 'interrupted']);
// syslog 形态的告警 ID：与 triage-monitor 生成的记录 ID 同一套形状。
export const SYSLOG_BOARD = /^syslog:([a-z_]+):[a-f0-9]{16}:(?:[0-9]+|unknown):[a-f0-9-]{36}$/;

export const short = (value, length = 240) => String(value ?? '').slice(0, length);
// 断点：断在哪一跳的左边，为什么断（D016）。hop_id 为空表示整条链层面的缺口。
export const addGap = (board, hopId, reason) => {
  if (!Array.isArray(board.gaps)) board.gaps = [];
  board.gaps.push({ hop_id: hopId || null, reason: short(reason, 400) });
};
// 发现顺序：实时出现就是往 discovery 后面加一跳或一条线（D016 重放口径）。
export const discover = (board, kind, id) => {
  if (!Array.isArray(board.discovery)) board.discovery = [];
  board.discovery.push({ step: board.discovery.length + 1, kind, id });
};
export const fact = (item, name) => item?.facts?.[name]?.value;
export const validIp = value => typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
  value.split('.').every(part => Number(part) <= 255);
export const privateIp = value => /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value);
export const pointer = parts => '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
export const timeOf = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  const timestamp = Number.isFinite(number) && number > 0
    ? (number < 1e12 ? number * 1000 : number) : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
};
export const withinWindow = (row, board) => {
  const timestamp = timeOf(row.created_at ?? row.detected_at ?? row.event_time ?? row.last_seen_at ?? row.timestamp);
  return timestamp == null || (timestamp >= Date.parse(board.window.since) && timestamp <= Date.parse(board.window.until));
};
export const rowTime = row => timeOf(row.created_at ?? row.detected_at ?? row.event_time ?? row.last_seen_at ?? row.timestamp);
// 溯源目标三种形态：告警（牧云类型:id）、syslog 告警 ID、IPv4。
export function traceTarget(target) {
  const value = String(target ?? '');
  const address = value.replace(/^ip:/, '');
  if (validIp(address)) return { kind: 'ip', boardId: `ip:${address}`, address };
  const alert = value.match(/^([a-z_]+):([1-9]\d*)$/);
  if (alert && Object.hasOwn(eventTypes, alert[1]))
    return { kind: 'alert', boardId: value, type: alert[1], eventId: Number(alert[2]) };
  const syslog = value.match(SYSLOG_BOARD);
  if (syslog && Object.hasOwn(eventTypes, syslog[1])) return { kind: 'syslog', boardId: value, type: syslog[1] };
  return null;
}
// 告警分析已经取到的证据被复用时，用这批事实起板，不再查同一份事件详情。
export function alertFromFacts(spec, facts = {}) {
  const hostIp = [facts.host_ip].find(validIp) || null;
  return { id: spec.boardId, eventType: spec.type, eventId: spec.eventId ?? (Number(facts.event_id) || null),
    createdAt: facts.occurred_at || null, title: facts.title || eventTypes[spec.type] || spec.type,
    asset: facts.host_name || hostIp || '未知主机', assetIp: hostIp,
    source: validIp(facts.source_ip) ? facts.source_ip : '待核查',
    target: facts.destination_ip || hostIp || '待核查' };
}
export function reuseRecord(reused, facts) {
  const view = {};
  for (const [name, key] of [['host_ip', 'host_ip'], ['source_ip', 'source_ip'], ['destination_address', 'destination_ip']])
    if (facts[key]) view[name] = { value: facts[key], pointer: `/payload/${key}` };
  return { evidenceId: reused.evidence_id, tool: reused.tool, view: { facts: view }, result: {} };
}
// 列表口径：一条溯源一行，链长＝hops 个数（含告警那一跳），断点＝gaps 非空。
export function summarizeBoard(board) {
  const type = board.alert?.type || (typeof board.alert_id === 'string' ? board.alert_id.split(':')[0] : null);
  const gaps = Array.isArray(board.gaps) ? board.gaps : [];
  return { id: board.id || board.alert_id, alert_id: board.alert_id ?? null,
    title: board.title || board.id || board.alert_id,
    type: type && Object.hasOwn(eventTypes, type) ? type : null,
    host: board.alert?.host || board.nodes?.[0]?.address || null,
    occurred_at: board.alert?.occurred_at || null, status: board.status,
    chain_length: Array.isArray(board.nodes) ? board.nodes.length : 0, has_gaps: gaps.length > 0,
    created_at: board.created_at, updated_at: board.updated_at };
}
// 详情口径（D016）：hops / links / gaps / discovery。links 由更晚的一端指向更早的原因。
export function presentBoard(board) {
  const nodes = Array.isArray(board.nodes) ? board.nodes : [];
  const edges = Array.isArray(board.edges) ? board.edges : [];
  const hops = nodes.map((node, index) => ({ id: node.id,
    kind: node.id === board.seed && board.alert_id ? 'alert' : 'host',
    label: node.label || node.address || node.id, host: node.address || null,
    occurred_at: node.occurred_at || null, evidence_id: node.discovered_from?.[0]?.evidence_id || null,
    discovered: index + 1 }));
  const byId = new Map(hops.map(hop => [hop.id, hop]));
  const depth = new Map();
  if (board.seed) depth.set(board.seed, 0);
  for (let changed = depth.size > 0; changed;) {
    changed = false;
    for (const edge of edges) {
      if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
      if (depth.has(edge.from) && !depth.has(edge.to)) { depth.set(edge.to, depth.get(edge.from) + 1); changed = true; }
      if (depth.has(edge.to) && !depth.has(edge.from)) { depth.set(edge.from, depth.get(edge.to) + 1); changed = true; }
    }
  }
  const links = edges.map((edge, index) => {
    let from = edge.from, to = edge.to;
    const fromTime = timeOf(byId.get(from)?.occurred_at), toTime = timeOf(byId.get(to)?.occurred_at);
    if (fromTime != null && toTime != null && fromTime !== toTime) {
      if (fromTime < toTime) [from, to] = [to, from];
    } else {
      const fromDepth = depth.get(from), toDepth = depth.get(to);
      // 时间相同（或未知）时，离告警更近的一端算更晚。
      if (fromDepth != null && toDepth != null && fromDepth > toDepth) [from, to] = [to, from];
    }
    return { id: `link:${index}`, from, to, rel: edge.rel || '',
      evidence_id: edge.citations?.[0]?.evidence_id || null };
  });
  const gaps = (Array.isArray(board.gaps) ? board.gaps : []).map(gap => typeof gap === 'string'
    ? { hop_id: null, reason: gap } : { hop_id: gap?.hop_id ?? null, reason: String(gap?.reason ?? '') });
  const discovery = Array.isArray(board.discovery) && board.discovery.length ? board.discovery
    : [...hops.map((hop, index) => ({ step: index + 1, kind: 'hop', id: hop.id })),
      ...links.map((link, index) => ({ step: hops.length + index + 1, kind: 'link', id: link.id }))];
  return { ...board, hops, links, gaps, discovery, chain_length: hops.length, has_gaps: gaps.length > 0,
    alert: board.alert || null };
}
export const olderThanWindow = (row, board) => {
  const timestamp = timeOf(row.created_at ?? row.detected_at ?? row.event_time ?? row.last_seen_at ?? row.timestamp);
  return timestamp != null && timestamp < Date.parse(board.window.since);
};
export function resultRows(record) {
  const key = ['events', 'data', 'result', 'list', 'hosts'].find(name => Array.isArray(record.result?.[name]));
  return key ? { key, rows: record.result[key] } : { key: null, rows: [] };
}
export function rowFacts(row, prefix) {
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
  const observedAt = timeOf(alert.createdAt) || Date.now();
  const occurredAt = new Date(observedAt).toISOString();
  const nodes = [{ id, label: hostIp ? (alert.asset && alert.asset !== '未知主机' ? alert.asset : hostIp) : alert.source || alert.id,
    address: hostIp || alert.source || '', kind: hostIp ? 'asset' : 'external_ip', status: 'pending',
    why: '告警涉及的起始资产，先核查它的档案和相关事件', profile: profileFrom(original), findings: [], finding_count: 0,
    occurred_at: occurredAt,
    discovered_from: [{ evidence_id: original.evidenceId, pointer: fact(original.view, 'host_ip') ? original.view.facts.host_ip.pointer : null }] }];
  for (const [fieldName, address] of [['source_ip', alert.source], ['destination_address', alert.target]]) {
    if (!validIp(address) || address === hostIp || nodes.some(node => node.address === address)) continue;
    nodes.push({ id: `${privateIp(address) ? 'asset' : 'ip'}:${address}`, label: address, address,
      kind: privateIp(address) ? 'asset' : 'external_ip', status: 'pending', why: '',
      profile: privateIp(address) ? {} : { name: '外部 IP（未登记资产）', ip: address }, findings: [], finding_count: 0,
      occurred_at: occurredAt,
      discovered_from: [{ evidence_id: original.evidenceId, pointer: original.view?.facts?.[fieldName]?.pointer || null }] });
  }
  const until = observedAt + 48 * 3600000;
  return { id: alert.id, alert_id: alert.id, run_id: randomUUID(), title: alert.title, seed: id, status: 'running',
    alert: { id: alert.id, type: alert.eventType || String(alert.id).split(':')[0], title: alert.title,
      host: hostIp || alert.source || null, occurred_at: occurredAt },
    window: { since: new Date(observedAt - 24 * 3600000).toISOString(), until: new Date(until).toISOString(), hours: WINDOW_HOURS },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    nodes, edges: [], discovery: nodes.map((node, index) => ({ step: index + 1, kind: 'hop', id: node.id })),
    activity: [{ at: new Date().toISOString(), kind: 'seed', title: '以告警为起点',
      detail: `${alert.id} · ${alert.title}。已标出告警字段中的资产与地址，尚未确认任何路径。` }],
    summary: '', gaps: [], investigations: 0, model: null, origin_evidence: summarizeRecord(original) };
}

export function traceIpSeed(address) {
  const id = `${privateIp(address) ? 'asset' : 'ip'}:${address}`;
  const until = Date.now();
  return { id: `ip:${address}`, alert_id: null, run_id: randomUUID(), title: `IP 溯源 · ${address}`,
    alert: { id: `ip:${address}`, type: null, title: `IP 溯源 · ${address}`, host: address, occurred_at: null },
    seed: id, status: 'running', window: { since: new Date(until - WINDOW_HOURS * 3600000).toISOString(),
      until: new Date(until).toISOString(), hours: WINDOW_HOURS }, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: [{ id, label: address, address, kind: privateIp(address) ? 'asset' : 'external_ip',
      status: 'pending', why: '操作员指定的溯源起点', occurred_at: null,
      profile: privateIp(address) ? {} : { name: '外部 IP（未登记资产）', ip: address }, findings: [], finding_count: 0,
      discovered_from: [] }], edges: [], discovery: [{ step: 1, kind: 'hop', id }],
    activity: [{ at: new Date().toISOString(), kind: 'seed', title: '以 IP 为起点',
      detail: `${address}。AI 将从这个地址自主追查关联资产和事件。` }],
    summary: '', gaps: [], investigations: 0, model: null, origin_evidence: null };
}

export function addCandidate(board, address, kind, source) {
  if (!validIp(address)) return;
  const id = `${kind === 'external_ip' ? 'ip' : 'asset'}:${address}`;
  if (board.nodes.some(node => node.id === id)) return;
  if (board.nodes.length >= MAX_NODES) return;
  board.nodes.push({ id, label: address, address, kind, status: 'pending', why: '',
    profile: kind === 'external_ip' ? { name: '外部 IP（未登记资产）', ip: address } : {}, findings: [],
    finding_count: 0, occurred_at: source?.occurred_at || null, discovered_from: [source] });
  discover(board, 'hop', id);
}

export function summarizeRecord(record, board) {
  const { key, rows } = resultRows(record);
  if (!key) {
    const view = record.view || {};
    return { evidence_id: record.evidenceId, tool: record.tool, total: 1, returned: 1,
      rows: [{ facts: view.facts || {} }], truncated: Boolean(view.truncated_for_context) };
  }
  const matching = rows.map((row, index) => ({ row, index })).filter(({ row }) => !board || withinWindow(row, board));
  const bounded = boundedFindingsRows(matching, key);
  return { evidence_id: record.evidenceId, tool: record.tool, total: record.result?.total ?? null,
    returned: matching.length, page_returned: rows.length,
    rows: bounded.rows, rows_omitted: bounded.omitted,
    truncated: bounded.omitted > 0 || rows.length >= PAGE_SIZE };
}

function boundedFindingsRows(matching, key) {
  const kept = [], limit = findingsRowLimit;
  let size = 0;
  for (const { row, index } of matching) {
    if (kept.length >= limit) break;
    const facts = rowFacts(row, [key, index]);
    const cost = JSON.stringify(facts).length;
    if (size + cost > findingsRowsMaxChars) break;
    kept.push({ facts });
    size += cost;
  }
  return { rows: kept, omitted: matching.length - kept.length };
}

// 节点级上界：从行数最多的那一项开始逐行收缩（每次都缩短，一定收敛）。
export function boundNodeFindings(findings) {
  const total = () => JSON.stringify(findings).length;
  while (total() > findingsNodeMaxChars) {
    const target = [...findings].filter(item => item.rows.length > 1)
      .sort((left, right) => right.rows.length - left.rows.length)[0];
    if (!target) break;
    target.rows.pop();
    target.rows_omitted = (target.rows_omitted || 0) + 1;
    target.truncated = true;
  }
  return findings;
}

export function profileFrom(record) {
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

// ── 不变量（批 1 的完成标志：link/hop 非法组合被拒）────────────────────────────
// link 两端的 hop 必须真实存在且不是同一个节点。AI 的 link 动作与程序自动建的边都必须过这道闸——
// 违例在领域层拒绝，而不是等投影时静默跳过或落盘坏板。
export function assertLink(board, fromId, toId) {
  const exists = id => board.nodes.some(node => node.id === id);
  if (!exists(fromId)) throw new Error(`关系边的起点不是白板中的节点：${fromId}`);
  if (!exists(toId)) throw new Error(`关系边的终点不是白板中的节点：${toId}`);
  if (fromId === toId) throw new Error('关系两端必须是白板中不同的节点');
}

// has_gaps 与 gaps 非空一致（投影层恒等式；写盘前的快查，不一致是程序错误）。
export function assertGapsConsistent(board) {
  const gaps = Array.isArray(board.gaps) ? board.gaps : [];
  const hasGaps = board.has_gaps === undefined ? undefined : board.has_gaps;
  if (hasGaps !== undefined && hasGaps !== (gaps.length > 0))
    throw new Error(`白板 has_gaps=${hasGaps} 与 gaps ${gaps.length} 条不一致`);
}

// ── 版本与 diff（P003-T068 A17）────────────────────────────────────────────
// 版本号 = 内容寻址：sha256 只看**投影后的链结构**（status/seed/alert + hops/links/gaps/discovery），
// 也就是 diff 实际逐项比的那几层。**排除** updated_at / created_at / activity / 每轮的 window 起止时间 /
// 节点调查时间与证据编号（这些每次重跑都会变，但链没有变）——同样链结构重跑两次是同一个版本号，
// 落盘时按版本号去重，不会攒出一堆「内容相同、时间不同」的版本。
// 版本文件存 `<boards>/versions/<boardId>/<revision>.json`（同目录多文件，当前板格式不变）。
// 稳定序列化：对象键排序、undefined 跳过；数组顺序保留（发现顺序本身就是内容）。
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export function boardRevision(board) {
  const projected = presentBoard(board || {});
  const content = { status: board?.status ?? null, seed: board?.seed ?? null, alert: board?.alert ?? null,
    hops: projected.hops, links: projected.links, gaps: projected.gaps, discovery: projected.discovery };
  return createHash('sha256').update(canonical(content)).digest('hex').slice(0, 16);
}

// diff 逐项比三层（验收要求的 hops/links/edges 三栏都给出）：
//   hops  = 节点（按 id）；共有节点给字段级 changes（label/host/occurred_at/evidence_id/kind）
//   links = presentBoard 归一化后的「更晚→更早」关系（按 from→to）
//   edges = 落盘的原始边（按 from→to，带 rel）
//   gaps  = 断点（按 hop_id + reason）
// 没变就 identical=true；调用方拿它判「重跑有没有查出新东西」。
export function diffBoards(before, after) {
  const left = presentBoard(before), right = presentBoard(after);
  const addedRemoved = (oldList, newList, keyOf) => {
    const oldKeys = new Map(oldList.map(item => [keyOf(item), item]));
    const newKeys = new Map(newList.map(item => [keyOf(item), item]));
    return {
      added: newList.filter(item => !oldKeys.has(keyOf(item))),
      removed: oldList.filter(item => !newKeys.has(keyOf(item)))
    };
  };
  const hopFields = ['kind', 'label', 'host', 'occurred_at', 'evidence_id'];
  const oldHops = new Map(left.hops.map(hop => [hop.id, hop]));
  const newHops = new Map(right.hops.map(hop => [hop.id, hop]));
  const hops = {
    added: right.hops.filter(hop => !oldHops.has(hop.id)),
    removed: left.hops.filter(hop => !newHops.has(hop.id)),
    changed: [...oldHops.keys()].filter(id => newHops.has(id)).map(id => {
      const changes = {};
      for (const field of hopFields)
        if (canonical(oldHops.get(id)[field]) !== canonical(newHops.get(id)[field]))
          changes[field] = { from: oldHops.get(id)[field] ?? null, to: newHops.get(id)[field] ?? null };
      return Object.keys(changes).length ? { id, changes } : null;
    }).filter(Boolean)
  };
  const edgeKey = edge => `${edge.from}->${edge.to}`;
  const linkKey = link => `${link.from}->${link.to}`;
  const gapOf = gap => ({ hop_id: gap?.hop_id ?? null, reason: String(gap?.reason ?? '') });
  const gapKey = gap => `${gap.hop_id ?? ''}|${gap.reason}`;
  const edges = addedRemoved(
    (Array.isArray(before.edges) ? before.edges : []).map(edge => ({ from: edge.from, to: edge.to, rel: edge.rel || '' })),
    (Array.isArray(after.edges) ? after.edges : []).map(edge => ({ from: edge.from, to: edge.to, rel: edge.rel || '' })),
    edgeKey);
  const links = addedRemoved(left.links, right.links, linkKey);
  const gaps = addedRemoved(left.gaps.map(gapOf), right.gaps.map(gapOf), gapKey);
  const identical = !hops.added.length && !hops.removed.length && !hops.changed.length &&
    !edges.added.length && !edges.removed.length && !links.added.length && !links.removed.length &&
    !gaps.added.length && !gaps.removed.length;
  return { from: boardRevision(before), to: boardRevision(after), identical, hops, edges, links, gaps };
}
