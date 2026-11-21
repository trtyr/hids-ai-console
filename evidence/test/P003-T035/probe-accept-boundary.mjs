// 文档 docs/modules/investigation-agent.md:211-217「采纳即停的边界」两条次生语义，黑盒验：
// ① 同一批里 submit_conclusion 被接受后，同批剩余调用仍真实执行（停的是下一轮）；
// ② 同一批两个 submit_conclusion 都通过校验时，draft 取最后一个。
// 事件详情故意不带 host_id，让必查项只记缺标识、不发查询，排除必查项调用的干扰。
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';

const toolbox = calls => new AgentToolbox({
  listTools: async () => [
    { name: 'get_suspicious_operation_event', inputSchema: { properties: { id: {} }, required: ['id'] } },
    { name: 'list_port_assets', inputSchema: { properties: { host_id: {}, count: {} } } },
    { name: 'submit_conclusion', inputSchema: { properties: { verdict: {}, summary: {} } } }
  ],
  callTool: async (name, args) => {
    calls.push({ name, args });
    return name === 'get_suspicious_operation_event' ? { event_id: 7, cmdline: 'id' } : { total: 0, events: [] };
  }
});
const mk = (id, args) => ({ id, type: 'function', function: { name: 'submit_conclusion', arguments: JSON.stringify(args) } });
const run = async (batch) => {
  const calls = [];
  let turn = 0;
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    if (turn++ === 0) return { tool_calls: batch };
    return { content: JSON.stringify({ verdict: '存疑', summary: '第二轮' }) };
  } };
  const r = await new InvestigationAgent(toolbox(calls), model).run('suspicious_operation:7', { mode: 'deep' });
  return { r, calls };
};

const first = await run([
  mk('c-a', { verdict: '存疑', summary: '批内先交的结论' }),
  { id: 'c-b', type: 'function', function: { name: 'list_port_assets', arguments: JSON.stringify({ host_id: 41 }) } }
]);
const queried = first.calls.filter(item => item.name === 'list_port_assets').length;
console.log('① 同批（结论在批首）list_port_assets 调用次数:', queried, '| 序列:', first.calls.map(c => c.name).join(','));
if (queried !== 1) { console.log('!! 文档 :212-213 说采纳后同批剩余调用仍会真实执行，实测没有'); process.exitCode = 1; }

const second = await run([
  mk('c-a', { verdict: '真实威胁', summary: '甲' }),
  mk('c-b', { verdict: '存疑', summary: '乙乙乙' })
]);
console.log('② 同批两个结论 → 最终 verdict:', second.r.verdict.verdict, '| conclusion trace:', JSON.stringify(second.r.trace.filter(t => t.kind === 'conclusion')));
if (second.r.verdict.verdict !== 'uncertain') { console.log('!! 文档 :215-216 说取最后一个，实测取了别的'); process.exitCode = 1; }
