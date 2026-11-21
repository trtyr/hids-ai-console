// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';
import { PromptStore } from '../../../src/contexts/knowledge/infrastructure/prompt-store.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

function rig({ conclusion }) {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, host_view: { host_name: 'h' }, source_ip: '192.0.2.1' })
  });
  const model = { model: 'fake-model', complete: async () => ({ content: JSON.stringify(conclusion) }) };
  return new InvestigationAgent(toolbox, model, new PromptStore());
}

test('T085 A3 一致性：伪造 citation 的 evidence_id 必须被抓，validation 不通过并列出缺失项', async () => {
  const agent = rig({ conclusion: { verdict: '存疑', confidence: '低', summary: '证据不足',
    claims: [{ text: '伪造引用', citations: [{ evidence_id: 'cw:999', pointer: '/source_ip', value: '192.0.2.1' }] }] } });
  const result = await agent.run('honeypot:7', { mode: 'deep' });
  assert.equal(result.validation.ok, false, '伪造引用必须判不通过');
  assert.ok(result.validation.dangling_citations?.some(line => /cw:999/.test(line)),
    `缺失清单要点名 cw:999：${JSON.stringify(result.validation.dangling_citations)}`);
  assert.ok(result.verdict.missing_evidence.some(item => /本次未取到/.test(item)), '缺口清单要写明');
});

test('T085 A3 一致性：引用真实证据时通过，dangling_citations 为空', async () => {
  const agent = rig({ conclusion: { verdict: '存疑', confidence: '中', summary: '已核对来源',
    claims: [{ text: '来源地址为 192.0.2.1', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.1' }] }] } });
  const result = await agent.run('honeypot:7', { mode: 'deep' });
  assert.equal(result.validation.dangling_citations, undefined, '一致时不该出现 dangling_citations');
  assert.equal(result.validation.ok, true);
});

test('T085 成本统计：每次研判落 turns/model_calls/tool_calls/input_chars/output_chars/duration_ms', async () => {
  const agent = rig({ conclusion: { verdict: '存疑', confidence: '低', summary: '无结论' } });
  const result = await agent.run('honeypot:7', { mode: 'deep' });
  const cost = result.cost;
  assert.ok(cost, '结果必须带 cost');
  assert.equal(typeof cost.turns, 'number');
  assert.equal(typeof cost.model_calls, 'number');
  assert.ok(cost.model_calls >= 1, '至少一次模型调用');
  assert.ok(Number.isInteger(cost.input_chars) && cost.input_chars > 0);
  assert.ok(Number.isInteger(cost.output_chars));
  assert.ok(Number.isInteger(cost.duration_ms) && cost.duration_ms >= 0);
  assert.ok(Number.isInteger(cost.tool_calls));
});

test('T085 预算可配：HIDS_AGENT_MAX_TURNS 生效（环境读到新值）', async () => {
  // 预算在模块加载时定型——这里只验证「配置键被真读」：改 env 后重新加载模块得到新值。
  const before = process.env.HIDS_AGENT_MAX_TURNS;
  process.env.HIDS_AGENT_MAX_TURNS = '3';
  const fresh = await import(`../../../src/contexts/triage/application/investigation-agent.js?budget=${Date.now()}`);
  let calls = 0;
  const model = { model: 'm', complete: async () => { calls++; return { content: '不是 JSON' }; } };
  const agent = new fresh.InvestigationAgent(
    { listTools: async () => [{ name: 'get_honeypot_event' }],
      investigation: () => ({ started: 0, maxCalls: 8, records: new Map(),
        async callTool() { this.started += 1; return { evidenceId: `cw:${this.started}`, tool: 'get_honeypot_event',
          args: {}, fetchedAt: new Date().toISOString(), sha256: 'a'.repeat(64), result: { event_id: 7 }, view: { facts: {} } }; },
        verifyClaims: () => ({ ok: false, errors: ['无结论'] }) }) },
    model, new PromptStore());
  const result = await agent.run('honeypot:7', { mode: 'deep' });
  assert.equal(result.validation.degraded, true, '应走降级结论');
  assert.equal(calls, 3, `预算 3 轮，实测 ${calls} 次调用`);
  if (before === undefined) delete process.env.HIDS_AGENT_MAX_TURNS;
  else process.env.HIDS_AGENT_MAX_TURNS = before;
});
