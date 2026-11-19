// 面向 Agent 的证据视图。原始 MCP 返回值完整留在 EvidenceSession；这里只选择
// 能支持单告警研判的字段。每个事实保留指向原始结果的 JSON Pointer，便于机器复核。
const fields = [
  ['event_id', ['event_id', 'id']], ['event_name', ['event_name.zh_cn', 'event_name.name', 'event_name', 'display_name', 'name']],
  ['event_type', ['event_type', 'type']], ['risk_level', ['level', 'host_risk_level']],
  ['platform_risky', ['risky']], ['handling_state', ['state']],
  ['observed_at', ['created_at', 'timestamp', 'start_time', 'shell_started_at', 'last_seen_at']],
  ['last_seen_at', ['last_seen_at', 'updated_at', 'end_time', 'shell_finished_at']],
  ['host_id', ['host_view.host_id', 'host_view.id', 'host_id']],
  ['host_name', ['host_view.host_name', 'host_name']],
  ['host_ip', ['host_view.host_ip', 'host_ip', 'ip']],
  ['host_kernel_version', ['host_view.host_kernel_version', 'host_kernel_version']],
  ['business_group', ['host_view.group_name', 'group_name']],
  ['source_ip', ['source_ip', 'ssh_client_ip', 'src_ip', 'login_ip', 'source.host_ip', 'source.cidr', 'local_addr']],
  ['destination_address', ['remote_addr', 'dest_addr', 'destination_ip', 'dst_ip', 'dest.host_ip', 'dest.cidr', 'target', 'address']],
  ['destination_port', ['remote_port', 'dest_port', 'port']],
  ['user_name', ['uname', 'username', 'login_username', 'user']],
  ['session_id', ['session_id']], ['command_line', ['cmdline', 'command', 'shell_cmdline', 'process_cmdline']],
  ['process_name', ['exename', 'pname', 'process_name', 'process']],
  ['process_path', ['exepath', 'process_path', 'exec_file', 'path']],
  ['working_directory', ['cwd', 'work_dir']],
  ['process_id', ['pid']], ['parent_process_id', ['ppid']],
  ['origin_user', ['origin_user']], ['origin_uid', ['origin_uid']],
  ['origin_effective_user', ['origin_effect_user']], ['origin_effective_uid', ['origin_effect_uid']],
  ['target_user', ['target_user']], ['target_uid', ['target_uid']],
  ['target_effective_user', ['target_effect_user']], ['target_effective_uid', ['target_effect_uid']],
  ['privilege_escalation_type', ['privilege_escalation_type']],
  ['process_safety', ['safety']], ['effective_user', ['effective_user']],
  ['signature_trusted', ['signatures.trusted']], ['process_privilege', ['privilege']],
  ['file_path', ['file_path']], ['file_hash', ['sha256', 'md5', 'file_hash']],
  ['connection_count', ['event_count', 'attack_num', 'access_count']],
  ['connection_type_code', ['conn_type']], ['connection_direction', ['link']],
  ['network_protocol', ['protocol']], ['network_service', ['service']],
  ['visible_externally', ['visibility']],
  ['first_access_at', ['first_access_time']], ['last_access_at', ['last_access_time']],
  ['matched_rule', ['rule_name']],
  ['suspicious_event_count', ['suspicious_event_count']],
  ['request_bytes', ['request_length']], ['response_bytes', ['response_length']],
  ['comment', ['comment']]
];

const nestedFields = {
  timeline: ['timestamp', 'src_addr', 'dest_addr', 'request_length', 'response_length'],
  process_tree: ['pid', 'ppid', 'pname', 'exename', 'uname', 'uid', 'euname', 'euid', 'cmdline', 'start_time'],
  state_history: ['state', 'action', 'created_at', 'user_name'],
  commands: ['seq', 'cwd', 'cmdline', 'started_at', 'finished_at', 'exit_code', 'label']
};

// 主机资产视图里裸 id 就是主机 ID；事件视图里裸 id 是事件 ID（见 host_id 字段表与 A4）。
const hostAssetTools = new Set(['list_host_assets', 'get_host_info_detail']);

const pointer = parts => '/' + parts.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
function select(root, dotted, prefix) {
  const keys = dotted.split('.');
  let value = root;
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = value[key];
  }
  if (value == null || value === '' || typeof value === 'object') return null;
  // 长命令或备注也可能含与判断无关的大段文本；原文仍留在本次取证会话中。
  if (String(value).length > (['cmdline', 'command', 'shell_cmdline', 'process_cmdline'].includes(keys.at(-1)) ? 3000 : 500)) return null;
  if (typeof value === 'number' && value < -60000000000) return null; // 牧云零时间哨兵
  return { value, pointer: pointer([...prefix, ...keys]) };
}
function itemFacts(item, prefix, bareHostId = false) {
  const out = {};
  for (const [friendly, options] of fields) {
    const match = options.map(name => select(item, name, prefix)).find(Boolean);
    if (match) out[friendly] = match;
  }
  // 事件行的裸 id 是事件 ID，不是主机 ID：拿它当 host_id 会让必查项查到另一台机器，
  // 再把空页报成「已查当前页但未返回记录」。只有主机资产视图才允许裸 id 当 host_id。
  if (bareHostId && !out.host_id) {
    const bare = select(item, 'id', prefix);
    if (bare) out.host_id = bare;
  }
  return out;
}
function assetFacts(item, prefix, kind, bareHostId = kind === 'host') {
  const facts = itemFacts(item, prefix, bareHostId);
  if (kind === 'process') {
    if (facts.event_id) { facts.asset_id = facts.event_id; delete facts.event_id; }
    delete facts.event_name;
    const name = select(item, 'name', prefix);
    if (name) facts.process_name = name;
  }
  if (kind === 'connection') {
    if (facts.event_id) { facts.connection_record_id = facts.event_id; delete facts.event_id; }
  }
  if (kind === 'port') {
    if (facts.event_id) { facts.port_asset_id = facts.event_id; delete facts.event_id; }
    if (facts.destination_port) { facts.listening_port = facts.destination_port; delete facts.destination_port; }
    const command = select(item, 'cmd', prefix);
    if (command) facts.process_name = command;
  }
  return facts;
}
function riskRowFacts(item, prefix) {
  return { category: select(item, 'service', prefix) || select(item, 'level', prefix),
    risky_count: select(item, 'risky', prefix) };
}
function countBy(items, names) {
  const result = {};
  for (const item of items) {
    const field = names.map(name => select(item, name, [])).find(Boolean);
    if (!field) continue;
    const key = String(field.value);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}
function nested(item, prefix) {
  const out = {};
  for (const [name, keys] of Object.entries(nestedFields)) {
    const rows = item[name];
    if (!Array.isArray(rows)) continue;
    const indexes = name === 'commands' && rows.length > 8
      ? [...Array.from({ length: 4 }, (_, i) => i), ...Array.from({ length: 4 }, (_, i) => rows.length - 4 + i)]
      : name === 'timeline' && rows.length > 20
        ? [...rows.map((row, index) => {
          let requestLine = '';
          try { requestLine = Buffer.from(row.response_digest || '', 'base64').toString('utf8').split(/\r?\n/, 1)[0]; }
          catch { /* 非文本载荷 */ }
          const http = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT|PRI)\s+\S{1,200}\s+(?:HTTP|RTSP)\/\d/.test(requestLine);
          return { index, priority: Number(row.response_length) > 0 ? 0 : http ? 1 : Number(row.request_length) > 0 ? 2 : 3 };
        }).sort((a, b) => a.priority - b.priority || a.index - b.index).slice(0, 18).map(row => row.index), 0, rows.length - 1]
          .filter((index, position, all) => all.indexOf(index) === position).sort((a, b) => a - b)
        : Array.from({ length: Math.min(rows.length, name === 'timeline' ? 20 : name === 'commands' ? 8 : 5) }, (_, i) => i);
    out[name] = { total_in_record: rows.length, shown_count: indexes.length, shown: indexes.map(index => {
      const row = rows[index];
      const values = {};
      for (const key of keys) {
        const fact = select(row, key, [...prefix, name, index]);
        if (fact) values[key] = fact;
      }
      if (name === 'timeline' && typeof row.response_digest === 'string' && row.response_digest.length <= 4096) {
        try {
          const payload = Buffer.from(row.response_digest, 'base64');
          const decoded = payload.toString('utf8');
          const line = decoded.split(/\r?\n/, 1)[0];
          if (/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT|PRI)\s+\S{1,200}\s+(?:HTTP|RTSP)\/\d(?:\.\d)?$/.test(line)) {
            values.http_request_line = { value: row.response_digest,
              pointer: pointer([...prefix, name, index, 'response_digest']), decoded: line };
          } else if (payload[0] === 0x16 && payload[1] === 0x03) {
            values.request_payload_type = { value: row.response_digest,
              pointer: pointer([...prefix, name, index, 'response_digest']), decoded: 'TLS 握手格式载荷；不证明握手成功' };
          }
        } catch { /* 非 HTTP 请求摘要不展示为请求行 */ }
      }
      return { index, facts: values };
    }) };
    if (name === 'timeline') {
      out[name].nonempty_request_count = rows.filter(row => Number(row?.request_length) > 0).length;
      out[name].nonzero_response_count = rows.filter(row => Number(row?.response_length) > 0).length;
      out[name].http_request_lines = out[name].shown.map(row => row.facts.http_request_line?.decoded).filter(Boolean);
      out[name].response_payload_available = rows.some(row => Number(row.response_length) > 0);
      out[name].timestamp_valid_count = rows.filter(row => Number(row.timestamp) > 0).length;
    }
  }
  return out;
}

export function projectEvidence(tool, result) {
  const bareHostId = hostAssetTools.has(tool);
  if (tool === 'get_internal_ip_define' && Array.isArray(result?.net_address)) {
    return { kind: 'internal_network_definition', tool, ranges: result.net_address.map((value, index) => ({
      value, pointer: pointer(['net_address', index]) })) };
  }
  if (tool === 'get_host_risk_overview' && result && typeof result === 'object') {
    const sections = {};
    for (const [source, friendly] of [['weak_passwd', 'weak_password'], ['security_check_stat', 'security_baseline'],
      ['vuln_stat', 'vulnerabilities'], ['patch_stat', 'patch_risk'], ['emergency_vuln', 'emergency_vulnerabilities']]) {
      const part = result[source];
      if (!part || typeof part !== 'object') continue;
      const rowsKey = Array.isArray(part.Data) ? 'Data' : 'data';
      const rows = Array.isArray(part[rowsKey]) ? part[rowsKey] : [];
      const riskyTotal = rows.reduce((sum, row) => sum + (Number(row.risky) || 0), 0);
      sections[friendly] = { last_scan_time: select(part, 'last_scan_time', [source]),
        risky_count_summed_from_returned_groups: riskyTotal,
        group_count: rows.length,
        nonzero_groups: rows.map((row, index) => ({ row, index })).filter(({ row }) => Number(row.risky) > 0)
          .slice(0, 3).map(({ row, index }) => riskRowFacts(row, [source, rowsKey, index])) };
    }
    return { kind: 'host_risk_overview', tool, sections };
  }
  if (tool === 'get_process_asset' && result && typeof result === 'object') {
    const executableFile = assetFacts(result.file_info || {}, ['file_info'], 'file');
    delete executableFile.process_safety;
    const process = assetFacts(result.process_info || {}, ['process_info'], 'process');
    delete process.asset_id;
    return { kind: 'process_asset_detail', tool,
      asset_id: select(result, 'ID', []),
      host: assetFacts(result.host_info || {}, ['host_info'], 'host'),
      process,
      executable_file: { ...executableFile,
        file_safety: select(result.file_info || {}, 'safety', ['file_info']) },
      collected_at: select(result, 'collect_time', []) };
  }
  const listKey = ['events', 'data', 'result', 'list'].find(key => Array.isArray(result?.[key]));
  if (listKey) {
    const rows = result[listKey];
    const kind = tool === 'list_process_assets' ? 'process' : tool === 'list_firewall_connection_records' ? 'connection'
      : tool === 'list_port_assets' ? 'port' : 'event';
    const counts = {
      by_risk_level: countBy(rows, ['level', 'host_risk_level']),
      by_source_ip: countBy(rows, ['source_ip', 'ssh_client_ip', 'src_ip', 'source.host_ip', 'source.cidr']),
      by_destination_ip: countBy(rows, ['dest.host_ip', 'dest.cidr', 'destination_ip', 'dst_ip']),
      by_host: countBy(rows, ['host_view.host_name', 'host_name']),
      by_process_name: kind === 'process' ? countBy(rows, ['name']) : kind === 'connection' ? countBy(rows, ['process'])
        : kind === 'port' ? countBy(rows, ['cmd']) : {},
      by_listening_port: kind === 'port' ? countBy(rows, ['port']) : {},
      by_process_safety: countBy(rows, ['safety']),
      by_connection_type_code: countBy(rows, ['conn_type'])
    };
    const view = {
      kind: 'list', tool, total_reported_by_platform: result.total == null ? null : { value: result.total, pointer: '/total' },
      returned_count: rows.length, platform_total_consistent: result.total == null ? null : Number(result.total) >= rows.length,
      query_coverage: result.queried_types ? { queried_types: result.queried_types, totals_by_type: result.totals_by_type,
        partial: Boolean(result.partial), errors: result.errors || {}, note: result.query_scope || '' }
        : result.queried_type ? { queried_type: result.queried_type, offset: result.queried_offset,
          count: result.queried_count, note: result.query_scope || '' } : undefined,
      aggregation_scope: '仅当前返回页；不是平台全量统计；平台 total 小于返回条数时以实际返回行取证',
      counts_on_returned_page: Object.fromEntries(Object.entries(counts).filter(([, value]) => Object.keys(value).length)),
      items: rows.slice(0, 5).map((row, index) => {
        const related = nested(row, [listKey, index]);
        return { facts: assetFacts(row, [listKey, index], kind, bareHostId),
          ...(Object.keys(related).length ? { related_sequences: related } : {}) };
      })
    };
    return view;
  }
  if (result && typeof result === 'object') {
    const detailKey = result.event && typeof result.event === 'object' && !Array.isArray(result.event) ? 'event'
      : result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? 'data' : null;
    const detail = detailKey ? result[detailKey] : result;
    const prefix = detailKey ? [detailKey] : [];
    return { kind: 'detail', tool, facts: itemFacts(detail, prefix, bareHostId), related_sequences: nested(detail, prefix) };
  }
  return { kind: 'scalar', tool, value: result };
}

// 限制单次工具视图的上下文占用。删减的是展示行，原始结果仍可用于本次引用校验。
export function boundEvidenceView(view, maxChars = 12000) {
  if (JSON.stringify(view).length <= maxChars) return view;
  const bounded = structuredClone(view);
  const tooLong = () => JSON.stringify(bounded).length > maxChars;
  bounded.truncated_for_context = true;
  if (Array.isArray(bounded.items)) {
    while (bounded.items.length > 1 && tooLong()) bounded.items.pop();
    bounded.shown_count = bounded.items.length;
  }
  if (Array.isArray(bounded.ranges)) {
    bounded.total_ranges = bounded.ranges.length;
    while (bounded.ranges.length > 1 && tooLong()) bounded.ranges.pop();
  }
  const sequences = [bounded.related_sequences, ...(bounded.items || []).map(item => item.related_sequences)].filter(Boolean);
  for (const sequenceSet of sequences) {
    for (const sequence of Object.values(sequenceSet)) {
      while (sequence.shown?.length > 1 && tooLong()) sequence.shown.pop();
      if (sequence.shown) sequence.shown_count = sequence.shown.length;
    }
  }
  if (tooLong()) return { kind: bounded.kind, tool: bounded.tool, truncated_for_context: true,
    error: '精简后仍超出上下文限制；请缩小查询条件或降低 count 后重查，不能引用本次省略的字段。' };
  return bounded;
}

// P003-T039 A6：给模型看的视图再收一层——嵌套序列 timeline 8 行、commands 4 行，计数一律保留。
// 只裁展示行，不动 projectEvidence 的投影口径：EvidenceSession 里的 record.view 保持原样，
// 知识经验复用的「时间线是否完整」判定（investigation-agent.js 的 completeTimeline）不受影响。
export const agentDisplayLimits = Object.freeze({ timeline: 8, commands: 4 });

// 时间线里值得留的行：有响应 > 带 HTTP 请求行/载荷类型 > 有请求字节 > 其余。排序只为挑行，展示仍按原顺序。
function timelineRowPriority(row) {
  const facts = row?.facts || {};
  if (Number(facts.response_length?.value) > 0) return 0;
  if (facts.http_request_line || facts.request_payload_type) return 1;
  if (Number(facts.request_length?.value) > 0) return 2;
  return 3;
}

function trimSequence(sequence, name, limit) {
  if (!Array.isArray(sequence?.shown) || sequence.shown.length <= limit) return;
  const rows = sequence.shown;
  let kept;
  if (name === 'timeline') {
    kept = rows.map((row, index) => ({ row, index, priority: timelineRowPriority(row) }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
      .slice(0, limit).map(entry => entry.index).sort((a, b) => a - b).map(index => rows[index]);
  } else {
    const head = Math.ceil(limit / 2);
    kept = [...rows.slice(0, head), ...rows.slice(rows.length - (limit - head))];
  }
  sequence.shown = kept;
  sequence.shown_count = kept.length;
  if (name === 'timeline') {
    sequence.http_request_lines = kept.map(row => row.facts?.http_request_line?.decoded).filter(Boolean);
  }
}

export function compactEvidenceView(view, limits = agentDisplayLimits) {
  if (!view || typeof view !== 'object') return view;
  const compacted = structuredClone(view);
  const sequenceSets = [compacted.related_sequences, ...(compacted.items || []).map(item => item.related_sequences)]
    .filter(Boolean);
  for (const sequenceSet of sequenceSets) {
    for (const [name, sequence] of Object.entries(sequenceSet)) {
      if (name === 'timeline') trimSequence(sequence, name, limits.timeline);
      else if (name === 'commands') trimSequence(sequence, name, limits.commands);
    }
  }
  return compacted;
}

// P003-T039 A6：syslog:1 的视图是原始键值载荷，没有数组可裁。超长时先整条省略最长的字段
// （省略的字段写进 omitted_fields，模型据此写缺口），仍超限再把长值截断（写进 truncated_fields）。
// 短值一律原样保留：模型要拿它填 claims.citations 的 value，截断一个能给的值等于让它引用失败。
// 复审 BUG1：三段收缩，每段都严格缩短内容（删一个字段 / 把字段换得更短 / 再删一个字段），
// 所以循环一定收敛。旧实现第二段反复截同一个字段，长度稳定在 ~163 字不再下降，总量仍超限时死循环。
export function boundSyslogView(view, maxChars = 3000) {
  if (!view || typeof view !== 'object') return view;
  if (JSON.stringify(view).length <= maxChars) return view;
  const bounded = structuredClone(view);
  const payload = bounded.payload && typeof bounded.payload === 'object' && !Array.isArray(bounded.payload)
    ? bounded.payload : null;
  if (!payload) {
    return { msgid: bounded.msgid, truncated_for_context: true, omitted_fields: [],
      note: 'syslog 载荷不是键值对象，已不在模型上下文展示' };
  }
  const omittedFields = [];
  const truncatedFields = [];
  const bookkeeping = () => ({ truncated_for_context: true,
    ...(truncatedFields.length ? { truncated_fields: truncatedFields } : {}),
    ...(omittedFields.length ? { omitted_fields: omittedFields } : {}) });
  // 量的是最终要发出去的那个对象（含 omitted_fields / truncated_fields 记账字段），不是半成品 payload。
  const oversize = () => JSON.stringify({ ...bounded, ...bookkeeping() }).length > maxChars;
  const longestString = () => Object.entries(payload).filter(([, value]) => typeof value === 'string')
    .sort((a, b) => b[1].length - a[1].length)[0];
  // 1) 整条省略长字段：碎片没有引用价值。
  while (oversize()) {
    const longest = longestString();
    if (!longest || longest[1].length <= 600) break;
    delete payload[longest[0]];
    omittedFields.push(longest[0]);
  }
  // 2) 逐个截断中等长度的字段，每个字段只截一次；只截「截断后确实更短」的字段，否则越截越长。
  const truncated = value => `${value.slice(0, 150)}…（截断，原 ${value.length} 字）`;
  while (oversize()) {
    const candidate = Object.entries(payload)
      .filter(([name, value]) => typeof value === 'string' && !truncatedFields.includes(name)
        && truncated(value).length < value.length)
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!candidate) break;
    payload[candidate[0]] = truncated(candidate[1]);
    truncatedFields.push(candidate[0]);
  }
  // 3) 仍超限就整条省略（最长优先，含已截断的碎片）：短值留到最后才丢，字段名进 omitted_fields。
  while (oversize()) {
    const longest = longestString();
    if (!longest) break;
    delete payload[longest[0]];
    omittedFields.push(longest[0]);
    const at = truncatedFields.indexOf(longest[0]);
    if (at >= 0) truncatedFields.splice(at, 1);
  }
  if (oversize()) {
    return { msgid: bounded.msgid, truncated_for_context: true,
      omitted_fields: [...omittedFields, ...Object.keys(payload)],
      note: 'syslog 载荷字段过多，已整条不在模型上下文展示' };
  }
  return { ...bounded, ...bookkeeping() };
}
