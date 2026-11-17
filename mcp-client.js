// 牧云原生 MCP 使用 Streamable HTTP，地址为 /api/mcp。
// Token 仅留在后端进程内，不传给浏览器或模型上下文。
export class CloudwalkerMcpClient {
  constructor(baseUrl, token, fetcher = fetch) {
    if (!/^https?:\/\//.test(baseUrl || '')) throw new Error('CLOUDWALKER_URL 必须是 HTTP(S) 地址');
    if (!token || token.length < 6) throw new Error('CLOUDWALKER_API_TOKEN 无效');
    this.url = new URL('/api/mcp', baseUrl);
    this.token = token;
    this.fetcher = fetcher;
    this.sequence = 0;
    this.initialized = false;
  }

  async request(method, params = {}) {
    const id = ++this.sequence;
    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`牧云 MCP HTTP ${response.status}`);
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
      throw new Error('牧云 MCP 未返回 JSON 响应');
    }
    const body = await response.json();
    if (body.jsonrpc !== '2.0' || body.id !== id) throw new Error('牧云 MCP 响应身份不匹配');
    if (body.error) throw new Error(`牧云 MCP ${body.error.code}: ${String(body.error.message).slice(0, 200)}`);
    if (!Object.hasOwn(body, 'result')) throw new Error('牧云 MCP 响应缺少 result');
    return body.result;
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'hids-ai-console-agent-tools', version: '0.1.0' }
    });
    if (result.serverInfo?.name !== 'cloudwalker') throw new Error('MCP 服务不是牧云');
    if (!result.capabilities?.tools) throw new Error('牧云 MCP 未提供工具能力');
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const tools = [];
    let cursor;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new Error('牧云 MCP 工具清单格式无效');
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (tools.length > 500) throw new Error('牧云 MCP 工具清单超出限制');
    } while (cursor);
    return tools;
  }

  async callTool(name, args = {}) {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) {
      const message = result.content?.filter(item => item.type === 'text').map(item => item.text).join(' ') || '工具执行失败';
      throw new Error(`牧云工具 ${name}: ${message.slice(0, 250)}`);
    }
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (!text) throw new Error(`牧云工具 ${name} 未返回文本结果`);
    if (text.length > 2_000_000) throw new Error(`牧云工具 ${name} 返回内容过大`);
    try { return JSON.parse(text); }
    catch { throw new Error(`牧云工具 ${name} 返回内容不是 JSON`); }
  }
}
