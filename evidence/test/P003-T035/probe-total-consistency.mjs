// 复验 openapi.yaml:1432 与 docs/modules/investigation-agent.md:537 对
// platform_total_consistent / total_reported 的描述：平台没报总数时到底是什么形态（null 还是键缺失）。
import { collectRequiredEvidence, requiredEvidencePlan } from '../../../required-evidence.js';

const catalog = [{ name: 'list_host_events', inputSchema: { properties: { host_id: {}, count: {} } } }];
const plan = requiredEvidencePlan('suspicious_operation',
  { view: { facts: { host_id: { value: 41 } } } }, catalog);

const shapes = {
  '平台报总数且自洽': { kind: 'list', returned_count: 2, total_reported_by_platform: { value: 2 }, platform_total_consistent: true },
  '平台报总数但不自洽': { kind: 'list', returned_count: 2, total_reported_by_platform: { value: 9 }, platform_total_consistent: false },
  '平台没报总数': { kind: 'list', returned_count: 2 },
  '平台总数单独给、没给一致性': { kind: 'list', returned_count: 2, total_reported_by_platform: { value: 2 } },
  '平台总数是 null': { kind: 'list', returned_count: 2, total_reported_by_platform: { value: null } }
};
for (const [name, view] of Object.entries(shapes)) {
  const [item] = await collectRequiredEvidence(plan, { callTool: async () => ({ evidenceId: 'cw:1', view }) });
  console.log(name, '→', JSON.stringify({ status: item.status, returned_count: item.returned_count,
    total_reported: item.total_reported ?? '<键缺失>',
    platform_total_consistent: 'platform_total_consistent' in item ? item.platform_total_consistent : '<键缺失>' }));
}
