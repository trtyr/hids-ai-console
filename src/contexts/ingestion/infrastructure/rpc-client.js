// 直接按 cloudwalker-master 的 /rpc JSON-RPC 契约访问牧云。
export class RpcClient {
  constructor(baseUrl, token, fetcher = fetch) {
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('CLOUDWALKER_URL 必须是 HTTP(S) 地址');
    if (!token || token.length < 6) throw new Error('CLOUDWALKER_API_TOKEN 无效');
    this.baseUrl = new URL(baseUrl);
    this.token = token;
    this.fetcher = fetcher;
    this.sequence = 0;
  }

  async call(method, params = {}) {
    // 不接受任意 RPC 名称，避免通过本控制台调用处置或加白接口。
    if (!/^[A-Za-z]+(?:Event)?Service\.(GetEventList|GetEvent|List)$/.test(method)) throw new Error('RPC 方法未列入只读白名单');
    const url = new URL('/rpc', this.baseUrl);
    url.searchParams.set('method', method);
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN', Cookie: `API-Token=${this.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++this.sequence }),
      signal: AbortSignal.timeout(15000)
    });
    let body;
    try { body = await response.json(); } catch { throw new Error(`牧云 /rpc 返回 HTTP ${response.status}，响应不是 JSON`); }
    if (body.error) throw new Error(`牧云 /rpc ${body.error.code}: ${body.error.message}`);
    if (!response.ok) throw new Error(`牧云 /rpc HTTP ${response.status}`);
    if (!Object.hasOwn(body, 'result')) throw new Error('牧云 /rpc 响应缺少 result');
    return body.result;
  }
}
