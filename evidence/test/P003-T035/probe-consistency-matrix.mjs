// platform_total_consistent 到底跟什么比：替身牧云回 {total, events}，扫「总数 vs 当前页条数」矩阵。
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent } from '../../../investigation-agent.js';

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
for (const [total, n] of [[9, 0], [9, 2], [9, 9], [2, 2], [0, 0], [5, 3]]) {
  const item = await run({ total, events: ev(n) });
  console.log(`平台 total=${total}, events=${n} → returned_count=${item.returned_count} total_reported=${item.total_reported} consistent=${item.platform_total_consistent} status=${item.status}`);
}
for (const [label, payload] of Object.entries({
  '不带 total': { events: ev(2) },
  'total 是 null': { total: null, events: ev(2) },
  'partial:true + errors': { total: 9, events: ev(2), partial: true, errors: { elevation_process: 'timeout' } }
})) {
  const item = await run(payload);
  console.log(`${label} → returned_count=${item.returned_count} total_reported=${item.total_reported} consistent=${item.platform_total_consistent} status=${item.status}`);
}
