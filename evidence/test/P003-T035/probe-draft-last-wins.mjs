// 文档 docs/modules/investigation-agent.md:215-216 说：同批多个 submit_conclusion 都被接受时取最后一个。
// 黑盒判定：第一个交「真实威胁」，第二个交「存疑」，都通过校验（deep 模式不查知识库），看最终落哪个。
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent } from '../../../investigation-agent.js';

const run = async (batch) => {
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_suspicious_operation_event', inputSchema: { properties: { id: {} }, required: ['id'] } },
      { name: 'submit_conclusion', inputSchema: { properties: { verdict: {}, summary: {} } } }
    ],
    callTool: async (n) => (calls.push(n), n === 'get_suspicious_operation_event'
      ? { event_id: 7, host_id: 41, cmdline: 'id' } : { total: 0, events: [] })
  });
  let n = 0;
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    if (n++ === 0) return { tool_calls: batch };
    return { content: JSON.stringify({ verdict: '存疑', summary: '第二轮' }) };
  } };
  const r = await new InvestigationAgent(toolbox, model).run('suspicious_operation:7', { mode: 'deep' });
  return { verdict: r.verdict, trace: r.trace.filter(t => t.kind === 'conclusion') };
};

const mk = (id, verdict, summary) => ({ id, type: 'function',
  function: { name: 'submit_conclusion', arguments: JSON.stringify({ verdict, summary }) } });

const out = await run([mk('c-a', '真实威胁', '甲'), mk('c-b', '存疑', '乙乙乙')]);
console.log('最终 verdict:', out.verdict.verdict, '|', out.verdict.verdict_label);
console.log('conclusion trace:', JSON.stringify(out.trace));
console.log(out.verdict.verdict === 'uncertain'
  ? '→ 取最后一个（与文档一致）'
  : `→ 取的是第一个（与文档 :215-216 不一致）；draft 结论=${out.verdict.verdict}`);
