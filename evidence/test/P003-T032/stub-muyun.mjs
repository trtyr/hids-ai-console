// P003-T032 替身服务：牧云（/rpc + /api/mcp）+ 模型（/v1/chat/completions）。
//
// 这不是真牧云、不是真模型：本机没有牧云凭据，192.168.24.21 也不可达（见 test-report §A5）。
// 替身只提供探针需要的最小面，数据全部由探针经 /__ctl 灌入；每条请求都记到 /__log，
// 探针据此断言「被拒的请求有没有打到上游」。
//
// 起法（端口写 0 由内核分配，启动后第一行打印 PORT=<n>）：
//   node evidence/test/P003-T032/stub-muyun.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);

// ---- 状态：探针经 POST /__ctl 改，替身自己不造数据 ----
const state = {
  // 牧云事件列表：{ malware: [row...] }；GetEventList / List 按类型取
  lists: {},
  // 牧云事件详情：{ 'malware:1': row }；GetEvent 按 'type:id' 取
  details: {},
  // MCP 工具目录（tools/list 原样回）与工具结果（tools/call 按 name 取）
  tools: [],
  toolResults: {},
  // 模型脚本：每条 chat/completions 请求按顺序取一条；取空回兜底（有效但无内容的 JSON）
  modelScript: [],
  modelFallback: { content: '{"action":"conclude","summary":"替身模型兜底","gaps":[]}' }
};
const log = [];

const rpcTypeOf = {
  WebshellEventService: 'webshell', MalwareEventService: 'malware', RevshellEventService: 'revshell',
  MemoryWebshellEventService: 'memory_webshell', BruteForceService: 'brute_force',
  AbnormalLoginEventService: 'abnormal_login', ElevationProcessEventService: 'elevation_process',
  NetworkAuditEventService: 'network_audit', SuspiciousOperationService: 'suspicious_operation',
  HoneypotService: 'honeypot', MemorySecurityEventService: 'memory_security'
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', chunk => parts.push(chunk));
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8');
    if (!text) return resolve(null);
    try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
  });
  req.on('error', reject);
});

// ---- 牧云 /rpc：形状照 rpc-client.js 的调用面（method + params，回 {result}）----
function rpc(method, params) {
  const match = /^([A-Za-z]+)\.(GetEventList|GetEvent|List)$/.exec(String(method || ''));
  if (!match) return { error: { code: -32601, message: `未知方法 ${method}` } };
  const [, service, verb] = match;
  const type = rpcTypeOf[service];
  if (!type) return { error: { code: -32601, message: `未知服务 ${service}` } };
  if (verb === 'GetEvent') {
    const key = `${type}:${params?.id}`;
    const row = state.details[key];
    if (!row) return { error: { code: 404, message: `事件 ${key} 不存在` } };
    return { result: row };
  }
  const rows = state.lists[type] || [];
  return { result: { events: rows, data: rows, list: rows, total: rows.length } };
}

// ---- MCP /api/mcp：initialize / tools/list / tools/call（形状照 mcp-client.js）----
function mcp(body) {
  const { id, method, params } = body || {};
  const wrap = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return wrap({ protocolVersion: '2025-03-26',
    serverInfo: { name: 'cloudwalker', version: 'stub' }, capabilities: { tools: {} } });
  if (method === 'tools/list') return wrap({ tools: state.tools });
  if (method === 'tools/call') {
    const name = params?.name;
    const result = state.toolResults[name];
    if (result === undefined) return wrap({ isError: true, content: [{ type: 'text', text: `替身没有配置工具 ${name}` }] });
    return wrap({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知 MCP 方法 ${method}` } };
}

// 模型脚本条目 → OpenAI chat.completion 的 message。
//   { content: '...' }                    → 纯文本回包（白板/复核用）
//   { tool_calls: [{ name, arguments }] } → 工具调用回包（研判用）
function modelMessage(entry) {
  if (entry?.tool_calls) return { role: 'assistant', content: null,
    tool_calls: entry.tool_calls.map((call, index) => ({ id: `call_${index + 1}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) };
  return { role: 'assistant', content: entry?.content ?? '' };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const raw = await readBody(req).catch(() => null);
  try {
    if (url.pathname === '/__ctl' && req.method === 'POST') {
      for (const key of ['lists', 'details', 'tools', 'toolResults']) if (raw?.[key]) state[key] = raw[key];
      if (raw?.modelScript) state.modelScript = raw.modelScript.slice();
      if (raw?.modelFallback) state.modelFallback = raw.modelFallback;
      if (raw?.appendList) for (const [type, rows] of Object.entries(raw.appendList))
        state.lists[type] = [...(state.lists[type] || []), ...rows];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__log') return send(res, 200, log);
    if (url.pathname === '/__reset') {
      state.lists = {}; state.details = {}; state.tools = []; state.toolResults = {};
      state.modelScript = []; log.length = 0;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/rpc') {
      const method = url.searchParams.get('method');
      const hasAuth = Boolean(req.headers.cookie || req.headers.authorization);
      log.push({ kind: 'rpc', method, hasAuth, params: raw?.params ?? null });
      const answer = rpc(method, raw?.params ?? {});
      if (answer.error) return send(res, 200, { jsonrpc: '2.0', id: raw?.id ?? null, error: answer.error });
      return send(res, 200, { jsonrpc: '2.0', id: raw?.id ?? null, result: answer.result });
    }
    if (url.pathname === '/api/mcp') {
      log.push({ kind: 'mcp', method: raw?.method ?? null, tool: raw?.params?.name ?? null,
        args: raw?.params?.arguments ?? null, hasAuth: Boolean(req.headers.authorization) });
      return send(res, 200, mcp(raw));
    }
    if (url.pathname === '/v1/chat/completions') {
      const entry = state.modelScript.length ? state.modelScript.shift() : state.modelFallback;
      log.push({ kind: 'model', entry, tools: Array.isArray(raw?.tools) ? raw.tools.map(tool => tool.function?.name) : [],
        messageCount: Array.isArray(raw?.messages) ? raw.messages.length : 0 });
      return send(res, 200, { id: 'chatcmpl-stub', object: 'chat.completion', model: raw?.model ?? 'stub',
        choices: [{ index: 0, message: modelMessage(entry), finish_reason: entry?.tool_calls ? 'tool_calls' : 'stop' }] });
    }
    return send(res, 404, { error: '替身没有这个路径' });
  } catch (error) {
    return send(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
