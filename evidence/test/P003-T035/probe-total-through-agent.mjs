// 从公开入口（InvestigationAgent.run）看 required_evidence 里的 total_reported / platform_total_consistent
// 到底以什么形态出现：真走 projectEvidence → collectRequiredEvidence 全链路，替身牧云只回 {total, events}。
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';

const make = (listPayload) => {
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_suspicious_operation_event', inputSchema: { properties: { id: {} }, required: ['id'] } },
      { name: 'list_host_events', inputSchema: { properties: { host_id: {}, types: {}, count: {} } } }
    ],
    callTool: async (name) => name === 'get_suspicious_operation_event'
      ? { event_id: 7, host_id: 41, cmdline: 'id' }
      : listPayload
  });
  const model = { model: 'fake', complete: async (messages, tools) => ({ content: JSON.stringify(tools.length
    ? { verdict: '存疑', summary: '待核' }
    : { assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
  return new InvestigationAgent(toolbox, model).run('suspicious_operation:7', { mode: 'triage' });
};

for (const [name, payload] of Object.entries({
  '平台只回 total:0（没给 total_reported_by_platform）': { total: 0, events: [] },
  '平台回 total:9 但有 0 条 events（不自洽）': { total: 9, events: [] }
})) {
  const r = await make(payload);
  console.log(name, '→', JSON.stringify(r.required_evidence[0]));
}
