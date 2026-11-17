import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudwalkerMcpClient } from './mcp-client.js';
import { AgentToolbox, TriageEvidenceToolbox } from './agent-tools.js';
import { ApiEvidenceToolbox } from './api-tools.js';
import { createServer } from './server.js';

function mockMcp() {
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    let result;
    if (body.method === 'initialize') result = { serverInfo: { name: 'cloudwalker' }, capabilities: { tools: {} } };
    else if (body.method === 'tools/list') result = { tools: [
      { name: 'get_revshell_event', description: 'Read event', inputSchema: { properties: { id: {} }, required: ['id'] } },
      { name: 'list_full_commands', description: 'Read commands', inputSchema: { properties: { count: {}, offset: {} } } },
      { name: 'whitelist_revshell_event', description: 'Write whitelist', inputSchema: { properties: { id: {} } } }
    ] };
    else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ event: { id: body.params.arguments.id, cmdline: 'bash -c whoami' } }) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, toolbox: new AgentToolbox(new CloudwalkerMcpClient('https://example.test', 'abcdefghi', fetcher)) };
}

test('agent sees read-only MCP tools and cannot invoke whitelist operations', async () => {
  const { calls, toolbox } = mockMcp();
  const tools = await toolbox.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['get_revshell_event', 'list_full_commands']);
  await assert.rejects(toolbox.callTool('whitelist_revshell_event', { id: 1 }), /未授权/);
  await assert.rejects(toolbox.callTool('get_revshell_event', { id: 0 }), /正整数/);
  await assert.rejects(toolbox.callTool('list_full_commands', { count: 100 }), /1 到 50/);
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 0);
});

test('常规研判保留事件 API 身份校验，并接入只读 MCP 命令和连接证据', async () => {
  const rpcCalls = [];
  const api = new ApiEvidenceToolbox({ call: async (method, args) => {
    rpcCalls.push({ method, args });
    return { event: { id: 7, host_id: 41 } };
  } });
  const mcpCalls = [];
  const mcp = { listTools: async () => [
    { name: 'get_suspicious_operation_event', inputSchema: { properties: { id: {} } } },
    { name: 'list_full_commands_by_host', inputSchema: { properties: { host_id: {}, count: {} } } },
    { name: 'list_firewall_connection_records', inputSchema: { properties: { filters: {}, count: {} } } },
    { name: 'whitelist_add', inputSchema: { properties: {} } }
  ], callTool: async (name, args) => { mcpCalls.push({ name, args }); return { total: 0, events: [] }; } };
  const toolbox = new TriageEvidenceToolbox(api, mcp);
  const catalog = await toolbox.listTools();
  assert.equal(catalog.filter(tool => tool.name === 'get_suspicious_operation_event').length, 1);
  assert.ok(catalog.some(tool => tool.name === 'list_full_commands_by_host'));
  assert.equal(catalog.some(tool => tool.name === 'whitelist_add'), false);
  assert.deepEqual(await toolbox.callTool('get_suspicious_operation_event', { id: 7 }), { id: 7, host_id: 41 });
  await toolbox.callTool('list_full_commands_by_host', { host_id: [41], count: 20 });
  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(mcpCalls.map(call => call.name), ['list_full_commands_by_host']);
  await assert.rejects(toolbox.callTool('whitelist_add', {}), /不提供/);
});

test('tool result becomes cited evidence and output values are checked', async () => {
  const { calls, toolbox } = mockMcp();
  const session = toolbox.investigation();
  const record = await session.callTool('get_revshell_event', { id: 41 });
  assert.equal(record.evidenceId, 'cw:1');
  assert.equal(record.result.event.id, 41);
  assert.equal(record.sha256.length, 64);
  assert.equal(session.verifyClaims([{ citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'bash -c whoami' }] }]).ok, true);
  assert.equal(session.verifyClaims([{ citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'curl evil' }] }]).ok, false);
  assert.equal(session.verifyClaims([{ citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline' }] }]).ok, false);
  assert.equal(session.verifyClaims([{ citations: [{ evidence_id: 'cw:2', pointer: '/event/id' }] }]).ok, false);
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 1);
});

test('parallel evidence calls get distinct identifiers', async () => {
  const { toolbox } = mockMcp();
  const session = toolbox.investigation();
  const records = await Promise.all([41, 42].map(id => session.callTool('get_revshell_event', { id })));
  assert.deepEqual(records.map(record => record.evidenceId), ['cw:1', 'cw:2']);
  assert.equal(session.records.size, 2);
});

test('backend exposes the imported tool catalog without exposing credentials', async t => {
  const { toolbox } = mockMcp();
  const server = createServer(null, toolbox);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/tools`);
  const body = await response.json();
  assert.equal(body.count, 2);
  assert.equal(body.readOnly, true);
  assert.equal(JSON.stringify(body).includes('abcdefghi'), false);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/backend/agent-tools.js`)).status, 404);
});
