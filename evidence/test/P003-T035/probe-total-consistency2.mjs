import { collectRequiredEvidence, requiredEvidencePlan } from '../../../required-evidence.js';
const catalog = [{ name: 'list_host_events', inputSchema: { properties: { host_id: {}, count: {} } } }];
const plan = requiredEvidencePlan('suspicious_operation', { view: { facts: { host_id: { value: 41 } } } }, catalog);
const shapes = {
  '无 returned_count 无总数': { kind: 'list' },
  'view 里 consistency 显式 null': { kind: 'list', returned_count: 2, total_reported_by_platform: { value: null }, platform_total_consistent: null },
  'platform_total_consistent 直接给 null': { kind: 'list', returned_count: 2, platform_total_consistent: null },
  '总数有、returned_count 缺': { kind: 'list', total_reported_by_platform: { value: 4 } }
};
for (const [name, view] of Object.entries(shapes)) {
  const [item] = await collectRequiredEvidence(plan, { callTool: async () => ({ evidenceId: 'cw:1', view }) });
  console.log(name, '→', JSON.stringify(item));
}
