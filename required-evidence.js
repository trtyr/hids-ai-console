import { recordFailure } from './record-redaction.js';

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

function check(id, label, tool, args, scope, source, reason = '', catalogAbsent = false) {
  return { id, label, tool, args, scope, source, reason, ...(catalogAbsent ? { catalog_absent: true } : {}) };
}

// A5：这两项的工具有没有，按本次 MCP 目录动态判定。目录里没有不是告警的缺口，是平台暂不提供数据源；
// 标 catalog_absent 而不新增状态——source_unavailable 仍是「没有可用数据源」这一档。
const dynamicChecks = {
  authorization: { id: 'authorization', label: '操作授权与测试工单', tool: 'authorization_record',
    scope: '需核对执行人、目标主机、批准范围和时间窗' },
  file_invocation: { id: 'file_invocation', label: '文件调用或对应 Web 请求', tool: 'web_request_or_file_access_log',
    scope: '仅检测到可疑文件不能证明文件已被请求或执行' }
};
// 能当动态查询参数的告警事实：只拿当前告警自己有的值，不猜、不发全库查询。
const dynamicFactKeys = ['host_id', 'host_ip', 'user_name', 'process_name', 'command_line', 'file_path', 'observed_at'];

function dynamicArgs(tool, facts) {
  const properties = tool?.inputSchema?.properties || {};
  const args = {};
  for (const key of dynamicFactKeys) {
    const value = facts[key]?.value;
    if (value === undefined || value === null || value === '') continue;
    if (!Object.hasOwn(properties, key)) continue;
    args[key] = scopedValue(tool, key, value);
  }
  if (Object.hasOwn(properties, 'count')) args.count = 20;
  return (tool?.inputSchema?.required || []).every(key => args[key] !== undefined) ? args : null;
}

function dynamicCheck(spec, tools, facts) {
  const tool = tools.get(spec.tool);
  if (!tool) return check(spec.id, spec.label, spec.tool, null, spec.scope, false,
    `牧云暂无此数据源：本次 MCP 目录未提供 ${spec.tool}`, true);
  const args = dynamicArgs(tool, facts);
  return check(spec.id, spec.label, spec.tool, args, spec.scope, true, args ? ''
    : `牧云提供 ${spec.tool}，但本条告警缺少该工具必需字段，无法发起限定范围查询`);
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
    plan.push(dynamicCheck(dynamicChecks.authorization, tools, facts));
  }
  if (type === 'webshell') {
    plan.push(dynamicCheck(dynamicChecks.file_invocation, tools, facts));
  }
  return plan;
}

export async function collectRequiredEvidence(plan, session, onProgress = () => {}, trace = []) {
  // A7：必查项互相独立，一次并发跑完（Promise.allSettled）。
  // 逐项 status 语义不变；trace 在 settle 后按 plan 序推，与完成先后无关。
  const settled = await Promise.allSettled(plan.map(async item => {
    const entry = { id: item.id, label: item.label, tool: item.tool, scope: item.scope };
    if (!item.source) {
      entry.status = 'source_unavailable';
      if (item.catalog_absent) entry.catalog_absent = true;
      entry.reason = item.reason || `牧云 MCP 未提供可按本条告警限定范围的 ${item.tool} 查询`;
    } else if (!item.args) {
      entry.status = 'missing_identifier';
      entry.reason = item.reason || '原始事件缺少此项查询所需的主机或来源标识';
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
        }
      } catch (error) {
        entry.status = 'query_failed';
        // 记录侧不写上游原文（P003-T052）：这条 reason 同时进 trace[evidence_check] 与 missing_evidence。
        entry.reason = recordFailure(error);
      }
    }
    return entry;
  }));
  const checks = settled.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value
    : { id: plan[index].id, label: plan[index].label, tool: plan[index].tool, scope: plan[index].scope,
      status: 'query_failed', reason: `必查项执行异常：${recordFailure(outcome.reason)}` });
  for (const entry of checks) {
    if (entry.evidence_id) trace.push({ kind: 'tool', name: entry.tool, evidence_id: entry.evidence_id,
      args: entry.args, note: `必查项：${entry.label}；${entry.scope}` });
    trace.push({ kind: 'evidence_check', ...entry });
  }
  return checks;
}

export function requiredEvidenceGaps(checks) {
  // catalog_absent 项是「平台暂不提供这个数据源」，不是本条告警的证据缺口。
  return checks.filter(item => !item.catalog_absent && (item.status !== 'records_returned' || item.reason)).map(item => {
    if (item.status === 'records_returned') return `${item.label}：${item.reason}；${item.scope}`;
    if (item.status === 'empty_page') return `${item.label}：已查当前页但未返回记录；${item.scope}`;
    if (item.status === 'source_unavailable') return `${item.label}：当前没有可用数据源；${item.reason}`;
    if (item.status === 'missing_identifier') return `${item.label}：无法发起限定范围查询；${item.reason}`;
    return `${item.label}：查询失败；${item.reason}`;
  });
}

export function requiredEvidenceReport(checks) {
  const visible = checks.filter(item => !item.catalog_absent);
  const groups = [
    ['empty_page', labels => `已查${labels}的限定范围当前页，未返回记录`],
    ['source_unavailable', labels => `${labels}没有可用数据源`],
    ['missing_identifier', labels => `${labels}缺少查询标识`],
    ['query_failed', labels => `${labels}查询失败`]
  ];
  return groups.map(([status, describe]) => {
    const labels = visible.filter(item => item.status === status).map(item => item.label);
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
