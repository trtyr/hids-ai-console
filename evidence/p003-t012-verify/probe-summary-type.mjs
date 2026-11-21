// P003-T012 边界探针：submit_conclusion 收到类型错误的 summary 时是否被挡。
// 文档口径：docs/modules/investigation-agent.md §3.8.C「正文取 summary，按字符计……
// 空正文或超限都退回，不落库」；openapi.yaml:1508 `Investigation.verdict.summary: { type: string }`。
// 期望：非字符串 summary 要么退回，要么在结果里归成字符串；实测：deep 模式原样把 number/object
// 写进 verdict.summary，产出违反 openapi 的研判记录。本探针按 spec 断言，FAIL 即该缺口。
// 跑法：node evidence/p003-t012-verify/probe-summary-type.mjs  （退出码非 0 = 发现成立）
import { InvestigationAgent } from '../../src/contexts/triage/application/investigation-agent.js';
import { AgentToolbox } from '../../src/contexts/triage/infrastructure/evidence-toolbox.js';

const toolbox = new AgentToolbox({
  listTools: async () => [{ name: 'get_suspicious_operation_event',
    inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
  callTool: async () => ({ id: 7, host_view: { host_id: 41 }, cmdline: 'id' })
});
const claim = [{ text: '执行 id', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'id' }] }];

async function runWith(summary) {
  let step = 0;
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    if (step++ === 0) return { tool_calls: [{ id: 'c1', type: 'function',
      function: { name: 'submit_conclusion', arguments: JSON.stringify({ verdict: '存疑', summary, claims: claim }) } }] };
    return { content: JSON.stringify({ verdict: '存疑', summary: 'ok', claims: claim }) };
  } };
  return new InvestigationAgent(toolbox, model).run('suspicious_operation:7', { mode: 'deep' });
}

let bad = 0;
for (const value of [123, { note: 'obj' }, ['a', 'b']]) {
  const result = await runWith(value);
  const stored = result.verdict.summary;
  const ok = typeof stored === 'string';
  if (!ok) bad++;
  console.log(`${JSON.stringify(value)} -> verdict.summary typeof=${typeof stored} value=${JSON.stringify(stored)} | spec(type:string) ${ok ? 'OK' : 'VIOLATED'}`);
}
process.exit(bad === 0 ? 0 : 1);
