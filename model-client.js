// 回包不可用时的摘要：有没有 choices[0].message、正文多少字、工具调用几次、结束原因。给研判失败记录用（P003-T022 A1）。
// 正文非空就是可用消息（不在这里抛），所以摘要里不需要带正文——正文归 investigation-agent.js 的回包摘要。
function unavailableReply(body) {
  const choice = body?.choices?.[0];
  const message = choice?.message;
  const finish = String(choice?.finish_reason ?? '');
  if (!message) return `回包没有 choices[0].message（finish_reason=${finish || '无'}，keys=${Object.keys(body || {}).join('/')}）`;
  const content = typeof message.content === 'string' ? message.content : '';
  const tools = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  return `回包 message 正文 ${content.length} 字、工具调用 ${tools} 次（finish_reason=${finish || '无'}）`;
}

export class ChatModelClient {
  constructor({ baseUrl, apiKey, model, timeoutMs = 90000, fetcher = fetch }) {
    if (!/^https?:\/\//.test(baseUrl || '')) throw new Error('LLM_BASE_URL 必须是 HTTP(S) 地址');
    if (!apiKey) throw new Error('缺少 LLM_API_KEY');
    if (!model) throw new Error('缺少 LLM_MODEL');
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.url = new URL('chat/completions', base);
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher;
  }

  async complete(messages, tools = [], toolChoice = 'auto') {
    const payload = { model: this.model, messages, temperature: 0, stream: false };
    if (tools.length) { payload.tools = tools; payload.tool_choice = toolChoice; }
    else payload.response_format = { type: 'json_object' };
    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    let body;
    try { body = await response.json(); } catch { throw new Error(`模型接口 HTTP ${response.status} 未返回 JSON`); }
    if (!response.ok || body.error) throw new Error(`模型接口 HTTP ${response.status}: ${String(body.error?.message || '请求失败').slice(0, 250)}`);
    const message = body.choices?.[0]?.message;
    if (!message || (!message.content && !message.tool_calls?.length)) {
      // P003-T022：失败记录要能看见模型回了什么。摘要只描述回包形状，不带请求头、密钥与整段正文。
      throw Object.assign(new Error('模型没有返回可用消息'), { reply_excerpt: unavailableReply(body) });
    }
    return message;
  }
}

export function createModelFromEnv(env = process.env, fetcher = fetch) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) return null;
  return new ChatModelClient({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL,
    timeoutMs: Number(env.LLM_TIMEOUT_MS) > 0 ? Number(env.LLM_TIMEOUT_MS) : 90000, fetcher });
}
