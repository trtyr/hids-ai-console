// P003-T035 复验探针：黑盒跑 required-evidence.js 的五态 + 两条目录分支，
// 把每项结果按 JSON 打到 stdout，交给 schema 校验（对 openapi RequiredEvidence）。
import { appendEvidenceReport, collectRequiredEvidence, requiredEvidenceGaps,
  requiredEvidencePlan } from '../../../required-evidence.js';

const schema = properties => ({ inputSchema: { properties } });
const facts = f => ({ view: { facts: f } });
const ok = n => () => ({ evidenceId: `cw:${n}`, view: { kind: 'list', returned_count: n,
  total_reported_by_platform: { value: n }, platform_total_consistent: true } });
const failing = () => { throw new Error('boom'); };

const results = [];
const push = (name, items, extra = {}) => results.push({ name, items, ...extra });

// 1 目录缺授权工具 → source_unavailable + catalog_absent
{
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, types: {}, count: {} }) }];
  const plan = requiredEvidencePlan('suspicious_operation', facts({ host_id: { value: 41 } }), catalog);
  push('catalog_absent_branch', await collectRequiredEvidence(plan, { callTool: ok(2) }));
}
// 2 目录有授权工具 + 告警事实齐 → 真查
{
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: {}, count: {} }) },
    { name: 'authorization_record', inputSchema: { properties: { host_id: { type: 'integer' },
      user_name: { type: 'string' }, count: { type: 'integer' } }, required: ['host_id'] } }
  ];
  const plan = requiredEvidencePlan('suspicious_operation', facts({ host_id: { value: 41 }, user_name: { value: 'u' } }), catalog);
  push('catalog_present_branch', await collectRequiredEvidence(plan, { callTool: ok(1) }));
}
// 3 空页
{
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, count: {} }) }];
  const plan = requiredEvidencePlan('suspicious_operation', facts({ host_id: { value: 41 } }), catalog);
  push('empty_page', await collectRequiredEvidence(plan, { callTool: async () => ({ evidenceId: 'cw:1',
    view: { kind: 'list', returned_count: 0 } }) }));
}
// 4 缺标识
{
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, count: {} }) }];
  const plan = requiredEvidencePlan('suspicious_operation', facts({}), catalog);
  push('missing_identifier', await collectRequiredEvidence(plan, { callTool: ok(1) }));
}
// 5 查询抛错
{
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, count: {} }) }];
  const plan = requiredEvidencePlan('suspicious_operation', facts({ host_id: { value: 41 } }), catalog);
  push('query_failed', await collectRequiredEvidence(plan, { callTool: failing }));
}
// 6 webshell 的文件调用工具在目录里 → file_invocation 真查
{
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: {}, count: {} }) },
    { name: 'list_honeypot_events', ...schema({ source_ip: {}, count: {} }) },
    { name: 'web_request_or_file_access_log', inputSchema: { properties: {
      host_id: { type: 'integer' }, file_path: { type: 'string' }, count: { type: 'integer' } }, required: ['host_id'] } }
  ];
  const plan = requiredEvidencePlan('webshell', facts({ host_id: { value: 41 }, file_path: { value: '/x' } }), catalog);
  push('file_invocation_present', await collectRequiredEvidence(plan, { callTool: ok(3) }));
}
// 7 平台没报总数 → total_reported / platform_total_consistent 为 null
{
  const catalog = [{ name: 'list_host_events', ...schema({ host_id: {}, count: {} }) }];
  const plan = requiredEvidencePlan('suspicious_operation', facts({ host_id: { value: 41 } }), catalog);
  push('no_platform_total', await collectRequiredEvidence(plan, { callTool: async () => ({ evidenceId: 'cw:9',
    view: { kind: 'list', returned_count: 2 } }) }));
}
// 8 蜜罐来源历史 + 网络连接（id 枚举覆盖）
{
  const catalog = [
    { name: 'list_honeypot_events', ...schema({ source_ip: {}, count: {} }) },
    { name: 'list_firewall_connection_records', ...schema({ filters: { properties: { source_cidr: {} } }, count: {} }) }
  ];
  const plan = requiredEvidencePlan('honeypot', facts({ source_ip: { value: '192.0.2.7' } }), catalog);
  push('source_history', await collectRequiredEvidence(plan, { callTool: ok(1) }));
}
// 9 缺口 / 报告对所有结果的可读输出（黑盒）
{
  const catalog = [
    { name: 'list_host_events', ...schema({ host_id: {}, count: {} }) },
    { name: 'list_firewall_connection_records', ...schema({ filters: { properties: { source_cidr: {} } }, count: {} }) }
  ];
  const plan = requiredEvidencePlan('network_audit', facts({ host_id: { value: 41 }, host_ip: { value: '203.0.113.9' } }), catalog);
  const items = await collectRequiredEvidence(plan, { callTool: failing }, () => {}, []);
  push('gaps_report', items, { gaps: requiredEvidenceGaps(items),
    report: appendEvidenceReport('存疑。', items) });
}

process.stdout.write(JSON.stringify(results, null, 1));
