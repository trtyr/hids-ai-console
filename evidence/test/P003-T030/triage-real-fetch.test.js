// P003-T030 集成测试（tester 面）：真取数链路——现查事件 ID → 研判队列 → 真 InvestigationAgent
// → 真工具箱（RpcClient / ApiEvidenceToolbox / CloudwalkerMcpClient / AgentToolbox / TriageEvidenceToolbox）
// → 本机替身牧云（/rpc + /api/mcp，HTTP 真走一遍）。
//
// 本卡写者把「真 MCP 链路（目录校验 / 真取数）」用替身绕开了，这一面归 tester（判词与派活正文都这么分）。
// 这里唯一的替身是**上游网络端点**：`/rpc` 与 `/api/mcp` 起在 127.0.0.1 的假牧云（形状照
// docs/modules/event-gateway.md §16 命令 6/7 与 docs/modules/evidence-tools.md §9.1 的公开面），
// 以及一个按 investigation-agent.md §5.5 写法回 JSON 的假模型。没有真牧云、没有真模型、没有固定 sleep。
//
// 口径来源：
//   - docs/modules/investigation-agent.md §2.1 三道前置校验、§2.2 读原始事件（get_<类型>_event）
//   - docs/modules/triage-pipeline.md §5.3 失败面（研判抛错 → failed + failure）、§5.6 A2 详情一次一拉（粒度一次 run）
//   - docs/modules/event-gateway.md §4 详情方法表、§5 只读白名单、§12 失败面（/rpc 报文与文案）
//   - docs/modules/evidence-tools.md §4.1/§4.2 取数七步、§9.1/§9.2 错误文案、R-EVID-07 详情身份校验
//   - docs/modules/http-api.md §3.9 现查告警送研判（记录没有 syslog / case_dir、不进 cases）
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createServer } from '../../../server.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
import { RpcClient } from '../../../rpc-client.js';
import { ApiEvidenceToolbox } from '../../../api-tools.js';
import { CloudwalkerMcpClient } from '../../../mcp-client.js';
import { AgentToolbox, TriageEvidenceToolbox } from '../../../agent-tools.js';

const TID = 'webshell:9001';
const triagePath = id => `/api/agent/triage/${encodeURIComponent(id)}`;
const RPC_TYPE_OF = {
  WebshellEventService: 'webshell', MalwareEventService: 'malware', RevshellEventService: 'revshell',
  MemoryWebshellEventService: 'memory_webshell', BruteForceService: 'brute_force',
  AbnormalLoginEventService: 'abnormal_login', ElevationProcessEventService: 'elevation_process',
  NetworkAuditEventService: 'network_audit', SuspiciousOperationService: 'suspicious_operation',
  HoneypotService: 'honeypot', MemorySecurityEventService: 'memory_security'
};

async function tempDir(t, prefix = 'hids-t030-real-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  return directory;
}

async function until(check, { timeoutMs = 5000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时未满足：${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

const readJson = req => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', chunk => parts.push(chunk));
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8');
    if (!text) return resolve(null);
    try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
  });
  req.on('error', reject);
});

// 替身牧云：/rpc（JSON-RPC 只读方法，形状照 event-gateway.md §5/§16 命令 7）+ /api/mcp（MCP 三步，
// 形状照 evidence-tools.md §9.1 与 T032 同名替身的公开面）。所有请求都记账，断言据此判「打没打上游、打了几次」。
async function startStubMuyun(t) {
  const state = {
    details: new Map(),      // 'webshell:9001' -> 事件详情行（GetEvent 的 result.event）
    tools: [],               // tools/list 原样回
    toolResults: new Map(),  // tools/call 按 name 取
    rpcCalls: [],            // { method, params, cookie }
    mcpCalls: [],            // { method, tool, args }
    rpcFault: null,          // { status, raw } 让 /rpc 回非 2xx / 非 JSON
    mcpMode: 'normal'        // normal | jsonrpc-error | id-mismatch | not-json | not-cloudwalker
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const body = await readJson(req).catch(() => null);
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    try {
      if (url.pathname === '/rpc') {
        const method = String(url.searchParams.get('method') ?? '');
        state.rpcCalls.push({ method, params: body?.params ?? null, cookie: req.headers.cookie ?? null });
        if (state.rpcFault) {
          res.writeHead(state.rpcFault.status, { 'content-type': state.rpcFault.contentType ?? 'application/json' });
          return res.end(state.rpcFault.raw ?? '{}');
        }
        const [service, verb] = method.split('.');
        if (verb === 'GetEvent') {
          const type = RPC_TYPE_OF[service];
          const row = state.details.get(`${type}:${body?.params?.id}`);
          if (!row) return send(200, { jsonrpc: '2.0', id: body?.id ?? null,
            error: { code: 404, message: `事件 ${type}:${body?.params?.id} 不存在` } });
          return send(200, { jsonrpc: '2.0', id: body?.id ?? null, result: { event: row } });
        }
        return send(200, { jsonrpc: '2.0', id: body?.id ?? null, result: { events: [], total: 0 } });
      }
      if (url.pathname === '/api/mcp') {
        state.mcpCalls.push({ method: body?.method ?? null, tool: body?.params?.name ?? null,
          args: body?.params?.arguments ?? null });
        if (state.mcpMode === 'not-json') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end('not json');
        }
        if (state.mcpMode === 'id-mismatch') return send(200, { jsonrpc: '2.0', id: 99999, result: {} });
        if (state.mcpMode === 'jsonrpc-error') {
          return send(200, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: '没有这个工具' } });
        }
        const wrap = result => ({ jsonrpc: '2.0', id: body?.id ?? null, result });
        if (body?.method === 'initialize') {
          return send(200, wrap({ protocolVersion: '2025-03-26',
            serverInfo: { name: state.mcpMode === 'not-cloudwalker' ? 'other-service' : 'cloudwalker', version: 'stub' },
            capabilities: { tools: {} } }));
        }
        if (body?.method === 'tools/list') return send(200, wrap({ tools: state.tools }));
        if (body?.method === 'tools/call') {
          const result = state.toolResults.get(body?.params?.name);
          if (result === undefined) {
            return send(200, wrap({ isError: true, content: [{ type: 'text', text: `替身没有配置工具 ${body?.params?.name}` }] }));
          }
          return send(200, wrap({ content: [{ type: 'text', text: JSON.stringify(result) }] }));
        }
        return send(200, { jsonrpc: '2.0', id: body?.id ?? null,
          error: { code: -32601, message: `未知 MCP 方法 ${body?.method}` } });
      }
      return send(404, { error: '替身没有这个路径' });
    } catch (error) {
      return send(500, { error: String(error?.message || error) });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, state };
}

// 假模型：形状照 investigation-agent.md §5.5（complete(messages, tools) → {content}）。
// 每轮都回一条合法的三态 JSON；不主动要工具，所以研判链上的取数只来自平台侧（必查项 + 读原始事件）。
function fakeModel(summary = '按事件 ID 的现查研判结论') {
  return { model: 'fake', complete: async () => ({
    content: JSON.stringify({ verdict: '存疑', summary, claims: [], missing_data: [],
      report: '现查事件详情的研判结论。', recommended_actions: [] })
  }) };
}

function forbiddingService(calls = []) {
  const boom = name => async (...args) => { calls.push([name, args]); throw new Error(`现查入队不该调用牧云网关：${name}`); };
  return { calls, alerts: boom('alerts'), alert: boom('alert'), detail: boom('detail') };
}

async function serve(t, monitor) {
  const server = createServer(null, null, null, null, null, monitor, null, { user: 'test', password: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  if (monitor) t.after(() => monitor.stop?.());
  return `http://127.0.0.1:${server.address().port}`;
}
const getJson = async (base, pathname) => (await fetch(`${base}${pathname}`)).json();
const post = (base, pathname) => fetch(`${base}${pathname}`, { method: 'POST' });

// 生产同款工具箱：API 侧（RpcClient → ApiEvidenceToolbox）+ MCP 侧（CloudwalkerMcpClient → AgentToolbox），
// 再用 TriageEvidenceToolbox 合并（architecture.md §5.1 的工具池表：常规研判就是这个组合）。
function triageToolbox(base, token = 'abcdef') {
  const rpc = new RpcClient(base, token);
  const api = new ApiEvidenceToolbox({ call: (method, params) => rpc.call(method, params) });
  const mcpClient = new CloudwalkerMcpClient(base, token);
  const mcp = new AgentToolbox(mcpClient);
  return { rpc, api, mcpClient, mcp, toolbox: new TriageEvidenceToolbox(api, mcp) };
}

function monitorWith({ directory, investigator, eventToolbox = null, concurrency = 1, ...options }) {
  return new TriageMonitor({ service: forbiddingService(), investigator, concurrency, inputMode: 'poll',
    history: new InvestigationStore(path.join(directory, 'investigations')),
    file: path.join(directory, 'queue.json'), eventToolbox, ...options });
}

// ── R1 真链路：POST 事件 ID → 真 agent → 真工具箱 → 替身牧云 /rpc 取详情 → done 落记录 ──
test('R1 真取数：POST 事件 ID 一次 GetEvent 取详情，记录 done 且带证据（现查记录无 syslog/case_dir）', async t => {
  const stub = await startStubMuyun(t);
  stub.state.details.set(TID, { id: 9001, event_id: 9001, host_id: 5, host_ip: '10.0.0.5',
    path: '/var/www/x.php', sha256: 'b'.repeat(64), detect_reason: '可疑 PHP 落地' });

  const directory = await tempDir(t);
  const { toolbox } = triageToolbox(stub.base);
  const agent = new InvestigationAgent(toolbox, fakeModel());
  const monitor = monitorWith({ directory, investigator: agent });
  const base = await serve(t, monitor);

  const accepted = await post(base, triagePath(TID));
  assert.equal(accepted.status, 202);

  const done = await until(async () => {
    const body = await getJson(base, triagePath(TID));
    return body.status === 'done' ? body : null;
  }, { label: '真链路研判跑完' });

  // 记录形状：有结论、有结果 ID，且没有 syslog 侧键（§3.9「现查记录没有 input」）
  assert.equal(done.alert_id, TID);
  assert.equal(done.result_alert_id, TID);
  assert.equal(done.verdict, 'uncertain');
  assert.equal(done.verdict_label, '存疑');
  assert.equal(done.syslog, undefined);
  assert.equal(done.case_dir, undefined);

  // 真取数：/rpc 上恰好一次 `WebshellEventService.GetEvent`，参数是事件号 9001，带 API Token Cookie
  const eventCalls = stub.state.rpcCalls.filter(call => call.method === 'WebshellEventService.GetEvent');
  assert.equal(eventCalls.length, 1, `GetEvent 应该只发一次，实测 ${eventCalls.length} 次（${eventCalls.map(c => JSON.stringify(c.params))}）`);
  assert.deepEqual(eventCalls[0].params, { id: 9001 });
  assert.equal(eventCalls[0].cookie, 'API-Token=abcdef');

  // 证据：get_<类型>_event 的取证记录进了记录（tool + sha256 摘要，R-EVID-05）
  const detail = done.evidence.find(item => item.tool === 'get_webshell_event');
  assert.ok(detail, `记录里应该有 get_webshell_event 的证据，实测 ${JSON.stringify(done.evidence.map(e => e.tool))}`);
  assert.match(detail.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(detail.fetched_at)));

  // 现查记录不进案件列表（§3.9）
  const cases = await getJson(base, '/api/agent/triage/cases');
  assert.equal(cases.total, 0);
});

// ── R2 人工重试 = 再跑一轮：每轮各取一次详情（缓存粒度是一次 run，§5.6 A2）──────────
test('R2 done 后人工重试：attempts 1→2，第二轮再取一次详情（缓存不跨 run 共享）', async t => {
  const stub = await startStubMuyun(t);
  stub.state.details.set(TID, { id: 9001, event_id: 9001, host_id: 5, host_ip: '10.0.0.5',
    path: '/var/www/x.php', sha256: 'b'.repeat(64) });

  const directory = await tempDir(t);
  const agent = new InvestigationAgent(triageToolbox(stub.base).toolbox, fakeModel());
  const monitor = monitorWith({ directory, investigator: agent });
  const base = await serve(t, monitor);

  assert.equal((await post(base, triagePath(TID))).status, 202);
  const first = await until(async () => {
    const body = await getJson(base, triagePath(TID));
    return body.status === 'done' ? body : null;
  }, { label: '第一轮跑完' });
  assert.equal(first.attempts, 1);

  assert.equal((await post(base, triagePath(TID))).status, 202);
  const second = await until(async () => {
    const body = await getJson(base, triagePath(TID));
    return body.status === 'done' && body.attempts === 2 ? body : null;
  }, { label: '人工重试跑完' });
  assert.equal(second.created_at, first.created_at, 'created_at 沿用');
  const eventCalls = stub.state.rpcCalls.filter(call => call.method === 'WebshellEventService.GetEvent');
  assert.equal(eventCalls.length, 2, `两轮各取一次详情，实测 ${eventCalls.length} 次`);
});

// ── R3 目录校验：MCP 目录里没有 get_<类型>_event → agent 拒绝跑，队列记录 failed ─────
test('R3 目录校验：MCP 目录缺 get_webshell_event → 抛文档原话，队列记录 failed + failure 形状', async t => {
  const stub = await startStubMuyun(t);
  // 目录里只有别的类型（honeypot），webshell 的详情工具不在里面
  stub.state.tools = [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }];
  stub.state.toolResults.set('get_honeypot_event', { id: 1 });

  const deepToolbox = new AgentToolbox(new CloudwalkerMcpClient(stub.base, 'abcdef'));
  const agent = new InvestigationAgent(deepToolbox, fakeModel());

  // 前置校验直接抛（investigation-agent.md §2.1 第 3 条：抛「牧云 MCP 缺少 `get_<类型>_event`」）
  const direct = await agent.run(TID, { mode: 'triage' }).then(() => null, error => error);
  assert.ok(direct, '目录里没有详情工具时应该抛错，不该静默跑');
  assert.match(direct.message, /牧云 MCP 缺少 get_webshell_event/);

  // 经队列：记录转 failed，原因进 failure（triage-pipeline.md §5.3 / §11：研判抛错那一行）
  const directory = await tempDir(t);
  const queueAgent = new InvestigationAgent(new AgentToolbox(new CloudwalkerMcpClient(stub.base, 'abcdef')), fakeModel());
  const monitor = monitorWith({ directory, investigator: queueAgent });
  const base = await serve(t, monitor);
  assert.equal((await post(base, triagePath('webshell:9002'))).status, 202);

  const failed = await until(async () => {
    const body = await getJson(base, triagePath('webshell:9002'));
    return body.status === 'failed' ? body : null;
  }, { label: '研判失败落记录' });
  assert.equal(failed.attempts, 1);
  assert.ok(failed.failure && typeof failed.failure.reason === 'string', '失败原因要落在 failure.reason');
  // P003-T052：队列记录里的这个字段只写闸后文案（固定文案 + 原文字符量），「牧云 MCP 缺少 …」这句
  // 原文只在上抛给调用方的那份（上面 `direct.message` 已断言），不落盘。字符量也锁精确值（同 T023/T036 口径）。
  assert.equal(failed.failure.reason, `上游调用失败，原文 ${direct.message.length} 字未落盘`);
  assert.ok(!Number.isNaN(Date.parse(failed.failure.at)), 'failure.at 应该是时间');
  // 目录校验在取数之前就失败了：/rpc 上一条详情请求都没发
  assert.equal(stub.state.rpcCalls.filter(call => call.method.endsWith('.GetEvent')).length, 0);
});

// ── R4 MCP 链路的失败面（evidence-tools.md §9.1 文案逐条）────────────────────
test('R4 真 MCP 链路错误面：JSON-RPC 错误 / 串号 / 非 JSON / 非牧云，文案照文档', async t => {
  const stub = await startStubMuyun(t);
  stub.state.tools = [{ name: 'get_webshell_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }];
  stub.state.toolResults.set('get_webshell_event', { id: 1 });
  const client = new CloudwalkerMcpClient(stub.base, 'abcdef');

  // JSON-RPC error → `牧云 MCP <code>: <message>`
  stub.state.mcpMode = 'jsonrpc-error';
  const rpcError = await client.callTool('get_webshell_event', { id: 1 }).then(() => null, error => error);
  assert.ok(rpcError);
  assert.match(rpcError.message, /牧云 MCP -32601: 没有这个工具/);

  // 响应 id 与请求不符 → 牧云 MCP 响应身份不匹配
  stub.state.mcpMode = 'id-mismatch';
  const mismatch = await client.callTool('get_webshell_event', { id: 1 }).then(() => null, error => error);
  assert.ok(mismatch);
  assert.match(mismatch.message, /牧云 MCP 响应身份不匹配/);

  // content-type 不是 JSON → 牧云 MCP 未返回 JSON 响应
  stub.state.mcpMode = 'not-json';
  const notJson = await client.callTool('get_webshell_event', { id: 1 }).then(() => null, error => error);
  assert.ok(notJson);
  assert.match(notJson.message, /牧云 MCP 未返回 JSON 响应/);

  // 服务端不自称牧云 → MCP 服务不是牧云（握手校验，R-EVID-12）
  stub.state.mcpMode = 'not-cloudwalker';
  const fresh = new CloudwalkerMcpClient(stub.base, 'abcdef');
  const notCloudwalker = await fresh.listTools().then(() => null, error => error);
  assert.ok(notCloudwalker);
  assert.match(notCloudwalker.message, /MCP 服务不是牧云/);
});

// ── R5 /rpc 链路的失败面（event-gateway.md §12、api-tools.md §4.2 与 R-EVID-07）──
test('R5 真 /rpc 链路错误面：非白名单方法拦在本地、详情身份校验、非法 ID、不认识的工具名', async t => {
  const stub = await startStubMuyun(t);
  stub.state.details.set('webshell:7', { id: 7, event_id: 7, host_ip: '10.0.0.5' });
  const { rpc, api, toolbox } = triageToolbox(stub.base);

  // 白名单正则之外的方法名：抛错且请求不发（event-gateway.md §5）
  const blocked = await rpc.call('WhitelistService.Add', {}).then(() => null, error => error);
  assert.ok(blocked);
  assert.match(blocked.message, /RPC 方法未列入只读白名单/);
  assert.equal(stub.state.rpcCalls.length, 0, '被白名单拦下的调用不该发到上游');

  // 详情返回的事件 ID 与请求不符 → 牧云 API 详情事件 ID 与请求不符（R-EVID-07）
  const mismatch = await api.callTool('get_webshell_event', { id: 8 }).then(() => null, error => error);
  assert.ok(mismatch);
  assert.match(mismatch.message, /牧云 API 详情事件 ID 与请求不符|不存在/);

  // 非法 ID → 事件详情需要有效 ID（evidence-tools.md §5.1 入参表）
  const badId = await api.callTool('get_webshell_event', { id: 0 }).then(() => null, error => error);
  assert.ok(badId);
  assert.match(badId.message, /事件详情需要有效 ID/);

  // 不认识的工具名 → 牧云 API 不提供取证工具（§4.2 第 3 步）
  const unknownTool = await toolbox.callTool('whitelist_add_ip', {}).then(() => null, error => error);
  assert.ok(unknownTool);
  assert.match(unknownTool.message, /常规研判不提供 whitelist_add_ip/);

  // /rpc 非 2xx → 牧云 /rpc HTTP <status>（§12）；响应体带 JSON-RPC error → 牧云 /rpc <code>: <message>
  stub.state.rpcFault = { status: 500, raw: '{}' };
  const http500 = await rpc.call('WebshellEventService.GetEvent', { id: 7 }).then(() => null, error => error);
  assert.ok(http500);
  assert.match(http500.message, /牧云 \/rpc HTTP 500/);

  stub.state.rpcFault = { status: 500, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } }) };
  const rpcError = await rpc.call('WebshellEventService.GetEvent', { id: 7 }).then(() => null, error => error);
  assert.ok(rpcError);
  assert.match(rpcError.message, /牧云 \/rpc -32603: boom/);

  // 非 JSON 响应体 → 牧云 /rpc 返回 HTTP <status>，响应不是 JSON（§12）
  stub.state.rpcFault = { status: 502, raw: 'boom', contentType: 'text/plain' };
  const notJson = await rpc.call('WebshellEventService.GetEvent', { id: 7 }).then(() => null, error => error);
  assert.ok(notJson);
  assert.match(notJson.message, /牧云 \/rpc 返回 HTTP 502，响应不是 JSON/);
});
