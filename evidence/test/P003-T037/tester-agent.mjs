// P003-T037 tester probe: A2 事件详情一次一拉（规则引擎复用 / agent 入口复用 + 两道闸）、A11 trace-board 复用路径
// 黑盒：完全照 docs/modules/triage-rules.md §5 与 docs/modules/investigation-agent.md §5.5 的公开用法
import { TriageRuleEngine } from '../../../triage-rules.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
import { AgentToolbox } from '../../../agent-tools.js';

let pass = 0; const fails = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log('  ✔', label); }
  else { fails.push(label + (detail ? ' | ' + detail : '')); console.log('  ✖', label, detail); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);

const detail = { id: 123, event_id: 123, host_id: 7, host_view: { host_id: 7, host_ip: '10.0.0.5' }, level: 2, state: 1,
  source_ip: '10.0.0.5', address: '10.0.0.9', type: 'ssh' };

console.log('== A2 规则引擎：match.event 身份一致即复用 ==');
{
  const { writeFile, rm } = await import('node:fs/promises');
  const file = '/tmp/t37-tester-rules.json';
  await rm(file, { force: true });
  const iso = t => new Date(t).toISOString().slice(0, 19) + 'Z';
  const rule = { id: 'demo-001', enabled: true, action: 'observe', event_type: 'honeypot', host_id: 7,
    reason: 'demo', approved_by: 'demo', valid_from: iso(Date.now() - 3600000), expires_at: iso(Date.now() + 3600000),
    conditions: [ { field: 'source_ip', operator: 'equals', value: '10.0.0.5' },
      { field: 'honeypot_address', operator: 'equals', value: '10.0.0.9' },
      { field: 'honeypot_type', operator: 'equals', value: 'ssh' } ] };
  await writeFile(file, JSON.stringify({ schema_version: 1, enabled: true, rules: [rule] }));
  const engine = new TriageRuleEngine(file);
  let calls = 0;
  const toolbox = { callTool: async () => { calls += 1; return detail; } };
  const parsed = { payload: { event_id: 123, host_id: 7, host_ip: '10.0.0.5' } };
  const reuse = await engine.evaluate({ alertId: 'honeypot:123', parsed,
    match: { matched: true, event_id: 123, event: detail }, toolbox });
  eq(calls, 0, '身份一致 + 带 match.event：不再 callTool');
  eq(reuse.status, 'observed', '复用后评估 status=observed');
  const native = await engine.evaluate({ alertId: 'honeypot:123', parsed,
    match: { matched: true, event_id: 123 }, toolbox });
  eq(calls, 1, '不带 match.event：照旧 callTool 取详情');
  eq(native.status, 'observed', '回落路径 status 一致');
  const mismatch = await engine.evaluate({ alertId: 'honeypot:123', parsed,
    match: { matched: true, event_id: 999, event: detail }, toolbox });
  eq(calls, 1, '身份不一致（event_id 999）：不取详情（先判身份）');
  eq(mismatch.status, 'identity_unverified', '身份不一致的状态取值');
}

const fakeModel = () => ({
  model: 'fake',
  complete: async (messages, tools) => {
    if (!tools || !tools.length) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    return { content: JSON.stringify({ verdict: '存疑', summary: '需核查来源', claims: [], missing_data: [] }) };
  },
});
const toolsCatalog = [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }];
const syslogCtx = (match) => ({
  parsed: { msgid: 'cloudwalker-honeypot', payload: { host_ip: '10.0.0.5', source_ip: '192.0.2.2', target_ip: '10.0.0.5', user_name: 'root' } },
  context: {}, match, caseInfo: { files: [] },
});

console.log('== A2 agent 入口：match.event 身份一致即复用，不重复取数 ==');
{
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => toolsCatalog,
    callTool: async (name, args) => { calls.push({ name, args }); return detail; },
  });
  const agent = new InvestigationAgent(toolbox, fakeModel());
  const r = await agent.run('honeypot:7', { mode: 'triage', streamContext: syslogCtx({ matched: true, event_id: 7, event: detail }) });
  eq(calls.filter(c => c.name === 'get_honeypot_event').length, 0, '匹配到位：入口不再调 get_honeypot_event');
  ok(JSON.stringify(r.evidence).includes('cw:'), '复用分支仍产出 cw:N 证据记录');
  const traceText = JSON.stringify(r.trace || []);
  ok(traceText.includes('match.event') || traceText.includes('复用') || traceText.includes('cw:'), 'trace 留痕', traceText.slice(0, 120));
}
console.log('== A2 agent 入口：未匹配时照旧取一次详情 ==');
{
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => toolsCatalog,
    callTool: async (name, args) => { calls.push({ name, args }); return detail; },
  });
  const agent = new InvestigationAgent(toolbox, fakeModel());
  await agent.run('honeypot:7', { mode: 'triage', streamContext: syslogCtx({ matched: false }) });
  eq(calls.filter(c => c.name === 'get_honeypot_event').length, 1, '未匹配：入口调 get_honeypot_event 一次');
}

console.log('== A2/A11 复用分支不豁免记账：次数上限（默认 20）==');
{
  const calls = [];
  const real = new AgentToolbox({ listTools: async () => toolsCatalog, callTool: async () => { calls.push(1); return detail; } });
  const zeroBudget = {
    listTools: (...a) => real.listTools(...a),
    callTool: (...a) => real.callTool(...a),
    investigation: () => real.investigation(0),   // maxCalls=0 合法（证据工具 §5.1：非负）
  };
  const agent = new InvestigationAgent(zeroBudget, fakeModel());
  let err = null;
  try {
    await agent.run('honeypot:7', { mode: 'triage', streamContext: syslogCtx({ matched: true, event_id: 7, event: detail }) });
  } catch (e) { err = e; }
  ok(!!err, '复用分支在次数上限下抛错');
  eq(err?.message, '本次调查的取证调用已达到 0 次上限', '报错文案与 agent-tools.js:58 同一条');
}

console.log('== A2/A11 复用分支不豁免记账：2MB 单次结果上限 ==');
{
  const calls = [];
  const real = new AgentToolbox({ listTools: async () => toolsCatalog, callTool: async () => { calls.push(1); return detail; } });
  const agent = new InvestigationAgent(real, fakeModel());
  const huge = { id: 7, event_id: 7, description: 'x'.repeat(2_000_001) };
  let err = null;
  try {
    await agent.run('honeypot:7', { mode: 'triage', streamContext: syslogCtx({ matched: true, event_id: 7, event: huge }) });
  } catch (e) { err = e; }
  ok(!!err, '复用分支在 2MB 单次结果上限下抛错');
  eq(err?.message, '工具结果超出本次调查的单次取证上限', '报错文案与 agent-tools.js:62 同一条');
  eq(calls.length, 0, '超限路径没有发工具调用');
}

console.log('== A2 对照：原生工具路径同样的两道闸（文案必须一致）==');
{
  const big = { id: 7, event_id: 7, description: 'x'.repeat(2_000_001) };
  const real = new AgentToolbox({ listTools: async () => toolsCatalog, callTool: async () => big });
  const agent = new InvestigationAgent(real, fakeModel());
  let err = null;
  try {
    await agent.run('honeypot:7', { mode: 'triage', streamContext: syslogCtx({ matched: false }) });
  } catch (e) { err = e; }
  eq(err?.message, '工具结果超出本次调查的单次取证上限', '原生路径 2MB 文案一致');
}

console.log(`\n== 汇总：pass ${pass} / fail ${fails.length} ==`);
if (fails.length) { for (const f of fails) console.log('FAIL:', f); process.exitCode = 1; }
