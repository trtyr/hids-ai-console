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

// ── 模型分层（P003-T042）──────────────────────────────────────────────────────
// 五个角色各用各的配置实例，解析只在这里做一次，别在 server.js / config-store.js 里再写一套：
//   研判=triage 吃主判组（LLM_*）；独立复核=review 吃复核组（LLM_REVIEW_*）；
//   规则维护者 / wiki 维护者 / 溯源白板 吃轻量组（LLM_LIGHT_*）。
// **回退是逐键的**：组里某个键空就用主判的同名字段。三个键全空 → source=primary（与分层前一字不差），
// 全有 → own，部分有 → mixed。主判三项不齐时五个实例都不建（与上面 createModelFromEnv 同一判据）。
// 超时五个角色共用 LLM_TIMEOUT_MS：分层只分地址 / 密钥 / 模型名，不分裂超时口径。
export const MODEL_ROLES = Object.freeze(['triage', 'review', 'rule_maintainer', 'wiki_maintainer', 'trace_board']);
export const MODEL_ROLE_GROUPS = Object.freeze({ triage: 'primary', review: 'review',
  rule_maintainer: 'light', wiki_maintainer: 'light', trace_board: 'light' });
// 每组三个键名只有这一份：解析、写配置校验（config-store 的报错键名也按它换）、文档都以它为准。
export const MODEL_GROUP_KEYS = Object.freeze({
  primary: Object.freeze({ baseUrl: 'LLM_BASE_URL', apiKey: 'LLM_API_KEY', model: 'LLM_MODEL' }),
  review: Object.freeze({ baseUrl: 'LLM_REVIEW_BASE_URL', apiKey: 'LLM_REVIEW_API_KEY', model: 'LLM_REVIEW_MODEL' }),
  light: Object.freeze({ baseUrl: 'LLM_LIGHT_BASE_URL', apiKey: 'LLM_LIGHT_API_KEY', model: 'LLM_LIGHT_MODEL' })
});
const roleFields = ['baseUrl', 'apiKey', 'model'];

// 一组自己的三个值：空 / 空串 / 纯空白算「没设」（与 config-store 的非空字符串同一个口径），值本身不裁剪。
export function modelGroupValues(group, env = process.env) {
  const names = MODEL_GROUP_KEYS[group];
  const values = {};
  for (const field of roleFields) {
    const raw = env?.[names[field]];
    values[field] = typeof raw === 'string' && raw.trim() ? raw : null;
  }
  return values;
}

// 五个角色最终各用哪三项（逐键回退到主判）。
export function modelRoleValues(env = process.env) {
  const primary = modelGroupValues('primary', env);
  const resolved = {};
  for (const role of MODEL_ROLES) {
    const group = MODEL_ROLE_GROUPS[role];
    const own = group === 'primary' ? primary : modelGroupValues(group, env);
    resolved[role] = Object.fromEntries(roleFields.map(field => [field, own[field] ?? primary[field]]));
  }
  return resolved;
}

// `GET /api/config` 的 model.roles：每个角色 resolved 到的模型名 + 这一组的来源三态。
// 只报模型名与来源，不报地址与密钥——机密（含两个新组的 API Key）不在这里出现。
export function modelRoleSummary(env = process.env) {
  const primary = modelGroupValues('primary', env);
  const summary = {};
  for (const role of MODEL_ROLES) {
    const group = MODEL_ROLE_GROUPS[role];
    const own = group === 'primary' ? primary : modelGroupValues(group, env);
    const present = roleFields.filter(field => own[field] !== null).length;
    const source = group === 'primary' || present === 0 ? 'primary'
      : present === roleFields.length ? 'own' : 'mixed';
    summary[role] = { model: own.model ?? primary.model ?? null, source };
  }
  return summary;
}

// 五个角色各建一个实例（对象互不相同：写配置之后逐个原地换值，谁也别替谁改）。
export function createModelRolesFromEnv(env = process.env, fetcher = fetch) {
  const values = modelRoleValues(env);
  const { baseUrl, apiKey, model } = values.triage;
  if (!baseUrl || !apiKey || !model) return null;
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) > 0 ? Number(env.LLM_TIMEOUT_MS) : 90000;
  return Object.fromEntries(MODEL_ROLES.map(role =>
    [role, new ChatModelClient({ ...values[role], timeoutMs, fetcher })]));
}

// 活着的客户端原地换值（`POST /api/config` 用）：只换地址、密钥、模型名；超时在构建时定死。
// 三项缺任何一项就一项都不动——写配置那边已判过形状，这里只是「不把半套值灌进活对象」。
export function applyModelValues(client, { baseUrl, apiKey, model } = {}) {
  if (!client || !baseUrl || !apiKey || !model) return client;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  client.url = new URL('chat/completions', base);
  client.apiKey = apiKey;
  client.model = model;
  return client;
}
