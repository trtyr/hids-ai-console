// 常规研判的最低取证清单。只按当前事件的主机或来源查询，绝不做无条件全库扫描。
const relatedTypes = {
  honeypot: ['honeypot', 'elevation_process', 'suspicious_operation', 'revshell', 'webshell', 'abnormal_login'],
  elevation_process: ['elevation_process', 'suspicious_operation', 'revshell', 'malware', 'network_audit'],
  abnormal_login: ['abnormal_login', 'brute_force', 'suspicious_operation', 'elevation_process'],
  brute_force: ['brute_force', 'abnormal_login', 'suspicious_operation'],
  suspicious_operation: ['suspicious_operation', 'elevation_process', 'revshell', 'network_audit'],
  webshell: ['webshell', 'suspicious_operation', 'revshell', 'memory_webshell'],
  memory_webshell: ['memory_webshell', 'webshell', 'network_audit'],
  memory_security: ['memory_security', 'webshell', 'memory_webshell'],
  revshell: ['revshell', 'suspicious_operation', 'network_audit'],
  malware: ['malware', 'suspicious_operation', 'network_audit'],
  network_audit: ['network_audit', 'suspicious_operation', 'revshell']
};

const commandTypes = new Set(['suspicious_operation', 'elevation_process', 'revshell', 'webshell',
  'memory_webshell', 'memory_security', 'malware', 'abnormal_login']);
const connectionTypes = new Set(['network_audit', 'revshell', 'honeypot']);
const sourceHistoryTypes = new Set(['honeypot', 'brute_force']);

function supports(tool, keys) {
  const properties = tool?.inputSchema?.properties || {};
  return Boolean(tool) && keys.every(key => Object.hasOwn(properties, key)) &&
    (tool.inputSchema.required || []).every(key => keys.includes(key));
}

function scopedValue(tool, key, value) {
  const type = tool?.inputSchema?.properties?.[key]?.type;
  return (Array.isArray(type) ? type.includes('array') : type === 'array') ? [value] : value;
}

function check(id, label, tool, args, scope, source, reason = '') {
  return { id, label, tool, args, scope, source, reason };
}

export function requiredEvidencePlan(type, original, catalog) {
  const tools = new Map(catalog.map(item => [item.name, item]));
  const facts = original.view?.facts || {};
  const hostId = Number(facts.host_id?.value);
  const hostIp = String(facts.host_ip?.value || '').replace(/\/32$/, '');
  const sourceIp = String(facts.source_ip?.value || '');
  const validHost = Number.isSafeInteger(hostId) && hostId > 0;
  const hostTool = tools.get('list_host_events');
  const acceptsTypes = Object.hasOwn(hostTool?.inputSchema?.properties || {}, 'types');
  const hostArgs = validHost ? { host_id: scopedValue(hostTool, 'host_id', hostId), count: 20 } : null;
  if (hostArgs && acceptsTypes) hostArgs.types = relatedTypes[type] || [type];
  const plan = [check('related_events', '同主机关联事件', 'list_host_events', hostArgs,
    acceptsTypes ? '同主机指定类型的当前返回页；不能代表全部历史' : '同主机全部事件类型的当前返回页；不能代表全部历史',
    supports(hostTool, ['host_id', 'count', ...(acceptsTypes ? ['types'] : [])]))];

  if (commandTypes.has(type)) {
    const name = ['list_full_commands_by_host', 'list_full_commands']
      .find(candidate => supports(tools.get(candidate), ['host_id', 'count'])) || 'list_full_commands_by_host';
    plan.push(check('command_history', '同主机命令会话', name,
      validHost ? { host_id: scopedValue(tools.get(name), 'host_id', hostId), count: 20 } : null,
      '同主机命令记录的当前返回页；不能证明命令获得授权或执行成功',
      supports(tools.get(name), ['host_id', 'count'])));
  }

  if (connectionTypes.has(type)) {
    const tool = tools.get('list_firewall_connection_records');
    const filters = tool?.inputSchema?.properties?.filters;
    const filterSupported = filters && (Object.hasOwn(filters.properties || {}, 'source_cidr') ||
      filters.additionalProperties === true);
    plan.push(check('network_connections', '相关来源的网络连接', 'list_firewall_connection_records',
      (type === 'honeypot' ? sourceIp : hostIp)
        ? { filters: { source_cidr: [type === 'honeypot' ? sourceIp : hostIp] }, count: 20 } : null,
      '指定来源地址的防火墙连接当前返回页；不覆盖 DNS 查询或全部网络流量',
      supports(tool, ['filters', 'count']) && Boolean(filterSupported)));
  }

  if (sourceHistoryTypes.has(type)) {
    const name = `list_${type}_events`;
    plan.push(check('source_history', '同来源同类告警', name,
      sourceIp ? { source_ip: scopedValue(tools.get(name), 'source_ip', sourceIp), count: 20 } : null,
      '同来源同类事件的当前返回页；不能代表全部历史',
      supports(tools.get(name), ['source_ip', 'count'])));
  }
  if (type === 'suspicious_operation' || type === 'elevation_process') {
    plan.push(check('authorization', '操作授权与测试工单', 'authorization_record', null,
      '需核对执行人、目标主机、批准范围和时间窗', false,
      '当前只读取证工具未接入工单或授权记录'));
  }
  if (type === 'webshell') {
    plan.push(check('file_invocation', '文件调用或对应 Web 请求', 'web_request_or_file_access_log', null,
      '仅检测到可疑文件不能证明文件已被请求或执行', false,
      '当前只读取证工具未接入对应 Web 请求或文件访问日志'));
  }
  return plan;
}

export async function collectRequiredEvidence(plan, session, onProgress = () => {}, trace = []) {
  const checks = [];
  for (const item of plan) {
    const entry = { id: item.id, label: item.label, tool: item.tool, scope: item.scope };
    if (!item.source) {
      entry.status = 'source_unavailable';
      entry.reason = item.reason || `牧云 MCP 未提供可按本条告警限定范围的 ${item.tool} 查询`;
    } else if (!item.args) {
      entry.status = 'missing_identifier';
      entry.reason = '原始事件缺少此项查询所需的主机或来源标识';
    } else {
      entry.args = item.args;
      onProgress('收集研判事实', `正在查询${item.label}`);
      try {
        const record = await session.callTool(item.tool, item.args);
        entry.evidence_id = record.evidenceId;
        if (record.view?.kind !== 'list' || !Number.isSafeInteger(record.view.returned_count)) {
          entry.status = 'query_failed';
          entry.reason = '接口未返回可确认数量的列表';
        } else {
          entry.status = record.view.returned_count ? 'records_returned' : 'empty_page';
          entry.returned_count = record.view.returned_count;
          entry.total_reported = record.view.total_reported_by_platform?.value ?? null;
          entry.platform_total_consistent = record.view.platform_total_consistent;
          if (record.view.query_coverage?.partial) entry.reason = '接口报告部分类型查询失败';
          trace.push({ kind: 'tool', name: item.tool, evidence_id: record.evidenceId,
            args: item.args, note: `必查项：${item.label}；${item.scope}` });
        }
      } catch (error) {
        entry.status = 'query_failed';
        entry.reason = String(error.message || error).slice(0, 180);
      }
    }
    checks.push(entry);
    trace.push({ kind: 'evidence_check', ...entry });
  }
  return checks;
}

export function requiredEvidenceGaps(checks) {
  return checks.filter(item => item.status !== 'records_returned' || item.reason).map(item => {
    if (item.status === 'records_returned') return `${item.label}：${item.reason}；${item.scope}`;
    if (item.status === 'empty_page') return `${item.label}：已查当前页但未返回记录；${item.scope}`;
    if (item.status === 'source_unavailable') return `${item.label}：当前没有可用数据源；${item.reason}`;
    if (item.status === 'missing_identifier') return `${item.label}：无法发起限定范围查询；${item.reason}`;
    return `${item.label}：查询失败；${item.reason}`;
  });
}

export function requiredEvidenceReport(checks) {
  const groups = [
    ['empty_page', labels => `已查${labels}的限定范围当前页，未返回记录`],
    ['source_unavailable', labels => `${labels}没有可用数据源`],
    ['missing_identifier', labels => `${labels}缺少查询标识`],
    ['query_failed', labels => `${labels}查询失败`]
  ];
  return groups.map(([status, describe]) => {
    const labels = checks.filter(item => item.status === status).map(item => item.label);
    return labels.length ? describe(labels.join('、')) : '';
  }).filter(Boolean).join('；');
}

export function appendEvidenceReport(report, checks, maxLength = 300) {
  const status = requiredEvidenceReport(checks);
  if (!status) return report;
  const suffix = `必查项：${status}。`;
  const allowed = maxLength - Array.from(suffix).length;
  if (allowed <= 0) return Array.from(suffix).slice(0, maxLength).join('');
  const original = Array.from(report || '');
  if (original.length + Array.from(suffix).length <= maxLength) return `${report}${suffix}`;
  const clipped = original.slice(0, allowed).join('');
  const boundary = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('；'));
  return `${boundary >= 12 ? clipped.slice(0, boundary + 1) : clipped.replace(/[，、；：。\s]+$/, '') + '。'}${suffix}`;
}
