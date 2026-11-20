// P003-T051 tester 探针（不是测试用例，run-all 不收集）：证明 docs §3.2「记录侧不写错误原文」
// 在「必查项查询失败」这条路上不成立——raw 错误原文进 trace[evidence_check].reason 与 verdict.missing_evidence[0]。
// 该口子在 recon §4 记为 O5（required-evidence.js:151，out-of-scope，另派收口卡）；这里只做文档承诺的边界取证。
// 跑法：node evidence/test/P003-T051/probe-o5-required-evidence.mjs
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent } from '../../../investigation-agent.js';

const MARKER = 'SECRET_BODY_MARKER';
const toolbox = new AgentToolbox({
  listTools: async () => [
    { name: 'get_revshell_event', description: 'd', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
    { name: 'list_host_events', description: 'd', inputSchema: { type: 'object', properties: { host_id: {}, count: {} } } }
  ],
  callTool: async name => {
    if (name === 'list_host_events') throw new Error(`${MARKER} 必查项上游炸了`);
    return { event_id: 7, host_id: 41, cmdline: 'bash -i' };
  }
});
const conclusion = JSON.stringify({ verdict: '存疑', confidence: '低', summary: '证据不足需核查',
  claims: [{ text: '执行命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'bash -i' }] }], missing_data: [] });
let calls = 0;
const model = { model: 'fake', complete: async () => (++calls % 2 === 1 ? { content: conclusion }
  : { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
const record = await new InvestigationAgent(toolbox, model).run('revshell:7');
const check = record.trace.find(item => item.kind === 'evidence_check' && item.id === 'related_events');
console.log(JSON.stringify({
  trace_reason: check.reason,
  missing_evidence_first: record.verdict.missing_evidence[0],
  record_clean: !/SECRET_BODY_MARKER|SECRET_BOD/.test(JSON.stringify(record))
}, null, 2));
