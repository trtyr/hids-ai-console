// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（wiki/rules 读→种子，fp-sessions 写）。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiEvidenceToolbox } from './api-tools.js';
import { InvestigationAgent } from './investigation-agent.js';

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('routine triage reads typed Cloudwalker API evidence and applies scenario SOP', async () => {
  const calls = [];
  const rpc = { call: async (method, params) => {
    calls.push({ method, params });
    if (method.endsWith('.GetEvent')) return { event: { id: 7, host_view: { host_id: 42, host_ip: '172.20.0.3' },
      source_ip: '192.0.2.7', address: '172.20.0.3:80', created_at: 1793700000 } };
    return { total: 1, events: [{ id: 7, created_at: 1793700000, source_ip: '192.0.2.7',
      host_view: { host_id: 42, host_ip: '172.20.0.3' } }] };
  } };
  const toolbox = new ApiEvidenceToolbox(rpc);
  let modelCalls = 0;
  const model = { model: 'fake', complete: async messages => {
    modelCalls++;
    if (modelCalls === 1) {
      assert.match(messages[0].content, /常规告警 SOP/);
      assert.match(messages[0].content, /HP-10/);
      assert.match(messages[0].content, /真实威胁 \/ 存疑 \/ 误报/);
      return { content: JSON.stringify({ verdict: '存疑', confidence: '中', summary: '已观察到蜜罐探测，成功状态待核查',
        claims: [{ text: '来源地址', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }],
        missing_data: ['扫描器登记'] }) };
    }
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model).run('honeypot:7', { mode: 'triage' });
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.verdict.verdict_label, '存疑');
  assert.equal(result.validation.ok, true);
  assert.equal(calls[0].method, 'HoneypotService.GetEvent');
  assert.ok(calls.some(call => call.method === 'HoneypotService.List' &&
    call.params.source_ip?.[0] === '192.0.2.7'));
  assert.ok(calls.some(call => call.method === 'ElevationProcessEventService.GetEventList' &&
    call.params.host_id?.[0] === 42));
  assert.ok(result.trace.some(item => item.name === 'list_host_events'));
});

test('API evidence adapter rejects other event identities and unsupported filters', async () => {
  const toolbox = new ApiEvidenceToolbox({ call: async () => ({ event: { id: 8 } }) });
  await assert.rejects(() => toolbox.callTool('get_honeypot_event', { id: 7 }), /ID 与请求不符/);
  await assert.rejects(() => toolbox.callTool('list_honeypot_events', { created_at: '2026-11-05' }), /不支持该筛选字段/);
  await assert.rejects(() => toolbox.callTool('whitelist_add', {}), /不提供取证工具/);
});
