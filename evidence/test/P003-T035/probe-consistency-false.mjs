// 找 platform_total_consistent 什么时候是 false：换各种「总数与当前返回对不上」的坏数据。
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';

const run = async (payload) => {
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_suspicious_operation_event', inputSchema: { properties: { id: {} }, required: ['id'] } },
      { name: 'list_host_events', inputSchema: { properties: { host_id: {}, types: {}, count: {} } } }
    ],
    callTool: async (name) => name === 'get_suspicious_operation_event'
      ? { event_id: 7, host_id: 41, cmdline: 'id' } : payload
  });
  const model = { model: 'fake', complete: async (m, tools) => ({ content: JSON.stringify(tools.length
    ? { verdict: '存疑', summary: '待核' } : { assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
  const r = await new InvestigationAgent(toolbox, model).run('suspicious_operation:7', { mode: 'triage' });
  return r.required_evidence[0];
};
const ev = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, host_id: 41, cmdline: 'id' }));
const types = ['suspicious_operation', 'elevation_process', 'revshell', 'network_audit'];
const cases = {
  'total=1 但 events=5': { total: 1, events: ev(5) },
  'total=9, totals_by_type 加起来 8': { total: 9, events: ev(2), queried_types: types,
    totals_by_type: { suspicious_operation: 8, elevation_process: 0, revshell: 0, network_audit: 0 }, partial: false },
  'total=9, totals_by_type 加起来 9': { total: 9, events: ev(2), queried_types: types,
    totals_by_type: { suspicious_operation: 9, elevation_process: 0, revshell: 0, network_audit: 0 }, partial: false },
  'total=8, totals_by_type 加起来 9': { total: 8, events: ev(2), queried_types: types,
    totals_by_type: { suspicious_operation: 9, elevation_process: 0, revshell: 0, network_audit: 0 }, partial: false },
  'total=9 且 partial=true 且有 errors': { total: 9, events: ev(2), partial: true, errors: { revshell: 'timeout' },
    queried_types: types, totals_by_type: { suspicious_operation: 9, elevation_process: 0, revshell: 0, network_audit: 0 } },
  'total=0 但 events=3': { total: 0, events: ev(3) }
};
for (const [name, payload] of Object.entries(cases)) {
  const item = await run(payload);
  console.log(`${name} → returned_count=${item.returned_count} total_reported=${item.total_reported} consistent=${item.platform_total_consistent} status=${item.status} reason=${item.reason ?? '-'}`);
}
