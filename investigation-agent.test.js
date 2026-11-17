import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolbox } from './agent-tools.js';
import { InvestigationAgent, boundedToolArgs } from './investigation-agent.js';
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench, knowledgeFields } from './knowledge-workbench.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('常规研判将必查空页与不可用来源写入结果，深度模式保持原有取证路径', async () => {
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_suspicious_operation_event', inputSchema: { properties: { id: {} }, required: ['id'] } },
      { name: 'list_host_events', inputSchema: { properties: { host_id: {}, types: {}, count: {} } } }
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return name === 'get_suspicious_operation_event'
        ? { event_id: 7, host_id: 41, cmdline: 'getent hosts dnslog.cn' }
        : { total: 0, events: [] };
    }
  });
  const model = { model: 'fake', complete: async (_messages, tools) => ({ content: JSON.stringify(tools.length
    ? { verdict: '存疑', confidence: '低', summary: '需核查命令后续行为',
      claims: [{ text: '已执行解析命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'getent hosts dnslog.cn' }] }],
      missing_data: [] }
    : { assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
  const agent = new InvestigationAgent(toolbox, model);
  const triage = await agent.run('suspicious_operation:7', { mode: 'triage' });
  assert.deepEqual(calls.map(item => item.name), ['get_suspicious_operation_event', 'list_host_events']);
  assert.equal(triage.required_evidence[0].status, 'empty_page');
  assert.equal(triage.required_evidence[1].status, 'source_unavailable');
  assert.match(triage.verdict.missing_evidence.join('；'), /当前页.*未返回记录.*没有可用数据源/);
  assert.match(triage.verdict.report, /当前页，未返回记录.*没有可用数据源/);
  assert.equal(triage.validation.ok, true);
  calls.length = 0;
  const deep = await agent.run('suspicious_operation:7', { mode: 'deep' });
  assert.deepEqual(calls.map(item => item.name), ['get_suspicious_operation_event']);
  assert.deepEqual(deep.required_evidence, []);
});

test('published customer experience avoids a full repeat investigation when current behavior is verified', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(directory);
  const created = await store.create();
  await store.update(created.id, current => {
    current.status = 'ready_for_review';
    current.fields = Object.fromEntries(knowledgeFields.map(([key]) => [key, { value: `${key} 核对完毕`, source_quote: `${key} 核对完毕` }]));
    current.fields.reason.value = '已核对本次巡检授权';
    return current;
  });
  const published = await new KnowledgeWorkbench(store, null, null).publish(created.id, {
    scenario_id: 'suspicious_operation', note: '已人工核对原始告警和运维授权',
    valid_until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  });
  assert.equal(published.status, 'published');
  const toolCalls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_suspicious_operation_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async (name, args) => { toolCalls.push({ name, args }); return {
      event_id: 7, host_view: { host_name: 'app-7' }, cmdline: 'systemctl status nginx'
    }; }
  });
  let modelCalls = 0;
  const model = { model: 'fake', complete: async messages => {
    modelCalls++;
    assert.match(messages[0].content, /已审核客户经验的适用性核对/);
    assert.equal(JSON.parse(messages[1].content).current_evidence.view.facts.command_line.value, 'systemctl status nginx');
    return { content: JSON.stringify({ case_id: created.id, matched: true, summary: '同一主机的已授权巡检',
      claims: [
        { text: '主机为 app-7', citations: [{ evidence_id: 'cw:1', pointer: '/host_view/host_name', value: 'app-7' }] },
        { text: '执行巡检命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'systemctl status nginx' }] }
      ], unverified_conditions: [], conflicts: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model, undefined, store).run('suspicious_operation:7', { mode: 'triage' });
  assert.equal(modelCalls, 1);
  assert.equal(toolCalls.length, 1);
  assert.equal(result.verdict.verdict, 'false_positive');
  assert.equal(result.knowledge_reuse.case_id, created.id);
  assert.equal(result.validation.ok, true);
  assert.equal(result.required_evidence.find(item => item.id === 'authorization').status, 'source_unavailable');
  assert.match(result.verdict.report, /操作授权与测试工单没有可用数据源/);
});

test('knowledge claims without a current behavior citation continue to full investigation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-reuse-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(directory);
  const created = await store.create();
  await store.update(created.id, current => { current.status = 'published'; current.scenario_id = 'honeypot';
    current.review = { reviewed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString() };
    current.fields = Object.fromEntries(knowledgeFields.map(([key]) => [key, { value: `${key} 已核对` }]));
    current.fields.reason.value = '已知扫描'; return current; });
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7', cmdline: 'probe' })
  });
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls++;
    if (calls === 1) return { content: JSON.stringify({ case_id: created.id, matched: true, summary: '相同来源',
      claims: [
        { text: '来源地址', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] },
        { text: '告警 ID', citations: [{ evidence_id: 'cw:1', pointer: '/event_id', value: 7 }] }
      ], unverified_conditions: [], conflicts: [] }) };
    if (calls === 2) return { content: JSON.stringify({ verdict: '无法判定', confidence: '低', summary: '仍需取证',
      claims: [{ text: '来源地址', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }], missing_data: ['授权记录'] }) };
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model, undefined, store).run('honeypot:7', { mode: 'triage' });
  assert.equal(calls, 3);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.knowledge_reuse, undefined);
  assert.equal(result.trace.find(item => item.kind === 'knowledge').matched, false);
});

test('legacy unsuccessful attack experience is preserved but presented as uncertain', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-honeypot-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(directory);
  const created = await store.create();
  await store.update(created.id, current => {
    current.status = 'ready_for_review';
    current.fields = Object.fromEntries(knowledgeFields.map(([key]) =>
      [key, { value: `${key} 已核对`, source_quote: `${key} 已核对` }]));
    current.fields.reason.value = '仅见短时探测，未见完成交互证据';
    return current;
  });
  await store.update(created.id, current => {
    current.status = 'published'; current.scenario_id = 'honeypot';
    current.review = { verdict: 'unsuccessful_attack', reviewed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString() };
    return current;
  });
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 36689, source_ip: '64.177.57.21', address: '172.20.208.23:80',
      timeline: [{ request_length: 148, response_length: 0,
        response_digest: Buffer.from('OPTIONS / HTTP/1.1\r\n\r\n').toString('base64') }] })
  });
  let calls = 0;
  const model = { model: 'fake', complete: async messages => {
    calls++;
    assert.equal(JSON.parse(messages[1].content).current_evidence.view.timeline.nonempty_request_count, 1);
    return { content: JSON.stringify({ case_id: created.id, matched: true, summary: '当前蜜罐交互符合已审核经验',
      claims: [
        { text: '当前来源', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '64.177.57.21' }] },
        { text: '当前目标', citations: [{ evidence_id: 'cw:1', pointer: '/address', value: '172.20.208.23:80' }] },
        { text: '当前请求', citations: [{ evidence_id: 'cw:1', pointer: '/timeline/0/response_digest',
          value: Buffer.from('OPTIONS / HTTP/1.1\r\n\r\n').toString('base64') }] }
      ], unverified_conditions: [], conflicts: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model, undefined, store).run('honeypot:36689', { mode: 'triage' });
  assert.equal(calls, 1);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.verdict.verdict_label, '存疑');
  assert.match(result.verdict.summary, /攻击尝试未成功/);
  assert.equal(result.knowledge_reuse.case_id, created.id);
  assert.equal(result.validation.ok, true);
});

test('final model timeout retries with the same collected evidence', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_elevation_process_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
      { name: 'list_process_assets', inputSchema: { type: 'object', properties: { count: {} } } }
    ],
    callTool: async name => name === 'get_elevation_process_event'
      ? { event_id: 62557, cmdline: 'engine daemon', host_view: { host_name: 'veinmind-demo' } }
      : { total: 1, events: [{ id: 1, name: 'engine', cmdline: 'engine daemon' }] }
  });
  let calls = 0;
  let firstRequest;
  const progress = [];
  const model = { model: 'fake', complete: async messages => {
    calls++;
    if (calls === 1) return { tool_calls: Array.from({ length: 8 }, (_, index) => ({
      id: `call-${index}`, function: { name: 'list_process_assets', arguments: '{"count":1}' }
    })) };
    if (calls === 2) {
      firstRequest = messages[1].content;
      const evidence = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{'))).evidence;
      assert.equal(evidence.length, 2);
      assert.equal(typeof evidence[0].view, 'object');
      throw new Error('The operation was aborted due to timeout');
    }
    if (calls === 3) {
      assert.equal(messages[1].content, firstRequest);
      const evidence = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{'))).evidence;
      assert.equal(evidence.length, 2);
      assert.equal(evidence[0].tool, 'get_elevation_process_event');
      return { content: JSON.stringify({ verdict: '无法判定', confidence: '低', summary: '需核对进程授权',
        claims: [{ text: '当前命令为 engine daemon', citations: [
          { evidence_id: 'cw:1', pointer: '/cmdline', value: 'engine daemon' }] }], missing_data: ['授权记录'] }) };
    }
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model).run('elevation_process:62557', {
    mode: 'triage', onProgress: stage => progress.push(stage)
  });
  assert.equal(calls, 4);
  assert.ok(progress.includes('模型超时重试'));
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.validation.ok, true);
  assert.equal(result.trace.filter(item => item.kind === 'tool_reuse').length, 7);
});

test('tool selection timeout retries with the same evidence and tool options', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_suspicious_operation_event',
      inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, host_view: { host_ip: '172.16.221.41' },
      cmdline: 'find / -user root -perm -4000 -print' })
  });
  let calls = 0;
  const progress = [];
  let firstRequest;
  const model = { model: 'fake', complete: async (messages, tools) => {
    calls++;
    if (calls === 1) {
      assert.ok(tools.length);
      firstRequest = JSON.stringify({ messages, tools });
      throw new Error('The operation was aborted due to timeout');
    }
    if (calls === 2) {
      assert.equal(JSON.stringify({ messages, tools }), firstRequest);
      return { content: JSON.stringify({ verdict: '存疑', confidence: '低', summary: '需核实 find 命令授权',
        claims: [{ text: '当前命令为 find', citations: [
          { evidence_id: 'cw:1', pointer: '/event_id', value: 7 }] }], missing_data: ['授权记录'] }) };
    }
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model).run('suspicious_operation:7', {
    mode: 'triage', onProgress: stage => progress.push(stage)
  });
  assert.equal(calls, 3);
  assert.ok(progress.includes('模型超时重试'));
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.validation.ok, true);
});

test('document scene prompt is routed to its alert type with three-state verdict', async () => {
  let systemPrompt = '';
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7' })
  });
  const replies = [
    { content: JSON.stringify({ verdict: '存疑', confidence: '中', risk_level: '低', summary: '外部探测蜜罐',
      evidence_facts: [{ fact: '来源为 192.0.2.7', supports: '威胁', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }],
      claims: [{ text: '来源为 192.0.2.7', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }],
      missing_data: ['后续活动'] }) },
    { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }
  ];
  const model = { model: 'fake', complete: async messages => {
    if (!systemPrompt) systemPrompt = messages[0].content;
    return replies.shift();
  } };
  const result = await new InvestigationAgent(toolbox, model).run('honeypot:7');
  assert.match(systemPrompt, /蜜罐\/诱饵/);
  assert.match(systemPrompt, /同一蜜罐受到其他来源攻击，也不能证明当前来源已入侵/);
  assert.match(systemPrompt, /跨场景关联规则/);
  assert.doesNotMatch(systemPrompt, /场景：Webshell/);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.verdict.confidence, '中');
  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.scenario_ids, ['honeypot']);
  assert.match(result.prompt_version, /\+[0-9a-f]{12}$/);
});

test('high-risk confirmation is reduced when independent review times out', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} } } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7' })
  });
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    if (calls++ === 0) return { content: JSON.stringify({ verdict: '确认威胁', confidence: '高',
      summary: '公网来源探测蜜罐', claims: [{ text: '来源地址', citations: [
        { evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }] }) };
    throw new Error('review timeout');
  } };
  const result = await new InvestigationAgent(toolbox, model).run('honeypot:7');
  assert.equal(calls, 2);
  assert.equal(result.review.assessment, 'unavailable');
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.validation.ok, true);
  assert.match(result.verdict.missing_evidence.join('；'), /独立复核未完成/);
});

test('loopback honeypot probe without responses cannot confirm host compromise', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: {
      type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }],
    callTool: async () => ({ event_id: 36870, source_ip: '127.0.0.1', address: '127.0.0.1:80',
      timeline: [{ src_addr: '127.0.0.1:47008', dest_addr: '127.0.0.1:80', request_length: 38,
        response_length: 0, response_digest: Buffer.from('GET / HTTP/1.1\r\n\r\n').toString('base64') }] })
  });
  let calls = 0;
  const model = { model: 'fake', complete: async () => ({ content: JSON.stringify(calls++ === 0
    ? { verdict: '确认威胁', confidence: '中', summary: '本机已失陷', attack_chain: '提权后横向',
      claims: [{ text: '回环来源', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '127.0.0.1' }] }] }
    : { assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
  const result = await new InvestigationAgent(toolbox, model).run('honeypot:36870');
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.match(result.verdict.summary, /回环地址/);
  assert.match(result.verdict.attack_chain, /尚未建立/);
  assert.equal(result.validation.ok, true);
});

test('unresolved independent review keeps a revised high-risk verdict below confirmation', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: {
      type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7' })
  });
  const draft = { verdict: '确认威胁', confidence: '高', summary: '需要进一步核对', claims: [{
    text: '来源 IP', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }]
  }] };
  const replies = [draft, { assessment: 'needs_revision', concerns: ['缺少成功攻击证据'], missing_evidence: [] }, draft];
  const model = { model: 'fake', complete: async () => ({ content: JSON.stringify(replies.shift()) }) };
  const result = await new InvestigationAgent(toolbox, model).run('honeypot:7');
  assert.equal(result.review.assessment, 'needs_revision');
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.match(result.verdict.missing_evidence.join('；'), /独立复核未支持/);
});

test('Agent list requests are bounded and scalar MCP filters become arrays', () => {
  const catalog = [{ name: 'list_process_assets', inputSchema: { properties: { count: {} } } },
    { name: 'list_firewall_connection_records', inputSchema: { properties: { count: {} } } },
    { name: 'list_port_assets', inputSchema: { properties: { count: {} } } }];
  assert.deepEqual(boundedToolArgs('list_process_assets', { count: 30, filters: { host_id: 874, name: 'sshd' } }, catalog),
    { count: 30, filters: { host_id: [874], name: ['sshd'] } });
  assert.deepEqual(boundedToolArgs('list_firewall_connection_records', { filters: { source_cidr: '192.0.2.1', port: 22 } }, catalog),
    { count: 5, filters: { source_cidr: ['192.0.2.1'], port: [22] } });
  assert.throws(() => boundedToolArgs('list_process_assets', { filters: { port_num: [22] } }, catalog),
    /不是监听端口号/);
  assert.deepEqual(boundedToolArgs('list_port_assets', { filters: { host_id: 874, port: 10010 } }, catalog),
    { count: 5, filters: { host_id: [874], port: ['10010~10010'] } });
});

test('Agent chooses a read-only tool, then cites and verifies its result', async () => {
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_revshell_event', description: 'Get original event', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      { name: 'list_host_events', description: 'Get same-host events', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      { name: 'whitelist_revshell_event', description: 'Write whitelist', inputSchema: { type: 'object', properties: { id: { type: 'integer' } } } }
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return name === 'get_revshell_event' ? { event: { id: 7, host_id: 12, cmdline: 'bash -i',
        secret_blob: 'must-stay-in-backend' } } : { total: 0, events: [] };
    }
  });
  const replies = [
    { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_host_events', arguments: '{"id":12}' } }] },
    { content: JSON.stringify({ verdict: 'needs_data', summary: '需要更多证据', confidence: 0.5, claims: [{ text: '执行 bash -i', citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'bash -i' }] }], missing_evidence: ['会话授权'] }) },
    { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }
  ];
  const model = { model: 'fake-model', complete: async (_messages, tools) => {
    if (tools.length) assert.equal(tools.some(tool => tool.function.name.startsWith('whitelist_')), false);
    return replies.shift();
  } };
  const result = await new InvestigationAgent(toolbox, model).run('revshell:7');
  assert.deepEqual(calls.map(call => call.name), ['get_revshell_event', 'list_host_events']);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.validation.ok, true);
  assert.equal(result.evidence.length, 2);
  assert.equal(JSON.stringify(result).includes('must-stay-in-backend'), false);
});

test('fabricated citations force human review', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_revshell_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event: { id: 7, cmdline: 'bash -i' } })
  });
  const replies = [
    { content: JSON.stringify({ verdict: 'suggested_benign', summary: '正常运维', confidence: 0.9,
      claims: [{ text: '工单已批准', citations: [{ evidence_id: 'cw:1', pointer: '/event/ticket', value: 'approved' }] }], missing_evidence: [] }) },
    { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }
  ];
  const result = await new InvestigationAgent(toolbox, { model: 'fake', complete: async () => replies.shift() }).run('revshell:7');
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.validation.ok, false);
  assert.deepEqual(result.verdict.claims, []);
  assert.equal(result.validation.removed_unverified_facts, true);
});

test('high-risk false positive requires independent positive benign evidence', async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7' })
  });
  const citation = { evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' };
  const replies = [
    { content: JSON.stringify({ verdict: '误报', confidence: '高', summary: '声称是合法扫描',
      claims: [{ text: '来源 IP', citations: [citation] }],
      evidence_facts: [{ fact: '来源 IP', supports: '良性', citations: [citation] }] }) },
    { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }
  ];
  const result = await new InvestigationAgent(toolbox, { model: 'fake', complete: async () => replies.shift() }).run('honeypot:7');
  assert.equal(result.validation.ok, true);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.match(result.verdict.missing_evidence.join('；'), /2 条可引用/);
});
