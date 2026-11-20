// P003-T024 测试席（何东阳）黑盒验收：错误四类 + 稳定 code。
// 依据只有两份契约文本：openapi.yaml（Error / InternalError / /api/status 502）与
// docs/modules/http-api.md（§1 响应形状 / §3.1 前置条件 / §5 三档令牌 / §6 SSE / §7 分页 / §8.1 正文 / §8.3 四类表 / §9.2）。
// 断言口径全部照文档原文抄，不从实现里读答案；跑的是真 HTTP（createServer 注入替身，不碰外部网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as netCreateServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// 文档 §8.3 与 openapi.yaml 共同钉死的四个值；多一个少一个都算违约。
const CODES = ['caller_error', 'not_configured', 'upstream_error', 'internal_error'];
const CALLER_STATUSES = [400, 403, 404, 405, 409, 410, 422];
const INTERNAL_TEXT = '服务器内部错误';

function serve(t, options = {}) {
  const server = createServer(options.service ?? null, options.toolbox ?? null, options.investigator ?? null,
    options.history ?? null, options.prompts ?? null, options.monitor ?? null, null, options.access ?? {},
    options.boardService ?? null, options.promptAdminToken ?? null, options.wiki ?? null,
    options.wikiAgent ?? null, null, options.ruleAdminToken ?? null, options.ruleStore ?? null);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

const call = (base, route, init = {}) => fetch(`${base}${route}`, { ...init, signal: AbortSignal.timeout(5000) });
const postJSON = (base, route, body, headers = {}) => call(base, route, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) });

// 文档 §8.3「形状固定 { "error": "...", "code": "..." }」：多字段、缺字段、类型不对都算违约。
async function expectError(response, { status, code, error }, label = '') {
  assert.equal(response.status, status, `${label} 状态码`);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', `${label} content-type`);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error'], `${label} 正文只能有 error/code，实测 ${JSON.stringify(body)}`);
  assert.equal(typeof body.error, 'string', `${label} error 必须是字符串`);
  assert.ok(body.error.length > 0 && body.error.length <= 4000, `${label} error 是给人看的原话，不能空`);
  assert.ok(CODES.includes(body.code), `${label} code 必须落在四值里，实测 ${body.code}`);
  assert.equal(body.code, code, `${label} code`);
  if (status >= 400 && status < 500) assert.ok(CALLER_STATUSES.includes(status), `${label} 调用方档位`);
  if (error instanceof RegExp) assert.match(body.error, error, `${label} 文案`);
  else if (error !== undefined) assert.equal(body.error, error, `${label} 文案`);
  return body;
}

// ---------------- A1 + schema 符合性 ----------------
// openapi.yaml 是错误契约的唯一来源：四值 enum、required [error, code]、InternalError、/api/status 502 带 code。
test('A1 schema：openapi.yaml 的 Error 只声明四个 code、required 齐全，InternalError 与 /api/status 502 与运行时一致', () => {
  const parsed = JSON.parse(execFileSync('python3', ['-c', `
import json, yaml
doc = yaml.safe_load(open('openapi.yaml'))
out = {
  'error': doc['components']['schemas']['Error'],
  'internal': doc['components']['responses'].get('InternalError'),
  'status502': doc['paths']['/api/status']['get']['responses']['502'],
}
print(json.dumps(out, ensure_ascii=False))
`], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }));

  const error = parsed.error;
  assert.deepEqual(error.required.sort(), ['code', 'error'], 'Error.required');
  assert.equal(error.properties.code.type, 'string');
  assert.deepEqual(error.properties.code.enum.slice().sort(), CODES.slice().sort(), 'Error.code 四值 enum');
  assert.equal(error.properties.error.type, 'string');

  assert.ok(parsed.internal, 'components/responses/InternalError 必须存在（500 是四类之一）');
  assert.equal(parsed.internal.content['application/json'].schema['$ref'], '#/components/schemas/Error');
  assert.match(parsed.internal.description, /服务器内部错误/);

  const status502 = parsed.status502.content['application/json'].schema;
  // 业务体可以 inline 也可以 $ref；两种形状都只认「required 含 code/reason」这一条契约。
  let statusSchema = status502;
  const ref = JSON.stringify(status502).match(/#\/components\/schemas\/([A-Za-z0-9_]+)/);
  if (ref) {
    statusSchema = JSON.parse(execFileSync('python3', ['-c', `
import json, yaml
doc = yaml.safe_load(open('openapi.yaml'))
print(json.dumps(doc['components']['schemas']['${ref[1]}'], ensure_ascii=False))
`], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }));
  }
  assert.ok(statusSchema.required.includes('code'), '/api/status 502 业务体 required 必须含 code');
  assert.ok(statusSchema.required.includes('reason'), '/api/status 502 业务体 required 必须含 reason');
  assert.equal(statusSchema.properties.code.const ?? statusSchema.properties.code.enum?.[0], 'upstream_error',
    '/api/status 502 的 code 固定 upstream_error');
});

test('A1 四类各一条：文档 §8.3 表里的（状态码，code，正文）逐条对上', async t => {
  // 调用方传错：400（分页参数无效）
  const callerBase = await serve(t, { service: { alerts: async () => ({ alerts: [], total: 0, totals: {}, errors: {}, partial: false }) } });
  await expectError(await call(callerBase, '/api/alerts?count=0'),
    { status: 400, code: 'caller_error', error: '分页参数无效' }, '调用方 400');

  // 没配置：503（点名缺哪个变量）
  const configBase = await serve(t);
  await expectError(await call(configBase, '/api/alerts'),
    { status: 503, code: 'not_configured', error: '未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN' }, '没配置 503');

  // 上游失败：502（error 就是上游原话）
  const upstreamBase = await serve(t, { service: { alerts: async () => { throw new Error('牧云 /rpc 5001: 查询超时'); } } });
  await expectError(await call(upstreamBase, '/api/alerts'),
    { status: 502, code: 'upstream_error', error: '牧云 /rpc 5001: 查询超时' }, '上游 502');

  // 本程序失败：500（固定文案，原文不进正文）
  const internalBase = await serve(t, { wiki: { get: async () => { throw new Error('EACCES: permission denied'); } } });
  const internal = await expectError(await call(internalBase, '/api/wiki/pages/honeypot%2FHP-01.md'),
    { status: 500, code: 'internal_error', error: INTERNAL_TEXT }, '本程序 500');
  assert.doesNotMatch(JSON.stringify(internal), /EACCES|permission denied/);
});

// ---------------- A2 同类同码 ----------------
test('A2 调用方一类：文档 §9.2 七个 4xx 档位各触发一次，code 一律 caller_error', async t => {
  const base = await serve(t, {
    service: { alerts: async () => ({ alerts: [], total: 0, totals: {}, errors: {}, partial: false }) },
    monitor: { status: id => null, setEnabled: async () => ({ enabled: true }),
      cases: async () => ({ cases: [], total: 0 }), summary: () => ({ counts: {} }), persist: async () => {} },
    wiki: { browse: async () => [], get: async () => { throw Object.assign(new Error('知识库页面不存在：common/GEN-99.md'), { status: 404 }); },
      update: async () => { throw Object.assign(new Error('页面版本已过期'), { status: 409 }); } },
    boardService: { page: async () => ({ boards: [], total: 0 }),
      startOrResume: async () => { throw Object.assign(new Error('该告警没有可溯源的资产'), { status: 422 }); } },
    ruleAdminToken: 'rule-token',
  });

  const cases = [
    ['400 参数', '/api/alerts?count=0', 400, '分页参数无效'],
    ['400 正文', '/api/triage/rules/validate', 400, '请求正文缺少 config', { method: 'POST', body: '{}' }],
    ['403 权限', '/api/triage/rules', 403, '规则管理员令牌无效', { method: 'PUT', token: 'wrong' }],
    ['404 不存在', '/api/unknown', 404, '接口不存在'],
    ['405 方法', '/api/agent/prompts', 405, '请使用提示词文件上传入口', { method: 'POST' }],
    ['409 冲突', '/api/wiki/pages/common%2FGEN-01.md', 409, '页面版本已过期',
      { method: 'PUT', body: '{"expected_revision":"aaaaaaaaaaaaaaaa","content":"# x\\n"}' }],
    ['410 已下线', '/api/agent/prompts/upload', 410, '提示词更新已迁移到独立维护端，业务端不允许上传'],
    ['422 无法溯源', '/api/trace/boards', 422, '该告警没有可溯源的资产',
      { method: 'POST', body: '{"target":"honeypot:7"}' }],
  ];
  for (const [label, route, status, error, init = {}] of cases) {
    let response;
    if (init.token) {
      response = await call(base, route, { method: init.method, headers: { 'Content-Type': 'application/json',
        'X-Rule-Admin-Token': init.token }, body: '{"expected_revision":null,"config":{"rules":[]}}' });
    } else {
      response = await call(base, route, init);
    }
    await expectError(response, { status, code: 'caller_error', error }, label);
  }
});

test('A2 没配置一类：文档 §3.1/§5 列出的每条依赖缺失都是 503 not_configured', async t => {
  const base = await serve(t);
  const routes = [
    ['GET', '/api/alerts'],
    ['GET', '/api/alerts/honeypot%3A7'],
    ['GET', '/api/agent/tools'],
    ['GET', '/api/trace/tools'],
    ['GET', '/api/trace/boards'],
    ['GET', '/api/agent/triage/status'],
    ['GET', '/api/agent/triage/cases'],
    ['GET', '/api/agent/triage/honeypot%3A7'],
    ['POST', '/api/agent/triage/honeypot%3A7'],
    ['POST', '/api/agent/triage/honeypot%3A7/false-positive'],
    ['PUT', '/api/agent/triage/control'],
    ['POST', '/api/agent/investigations', '{"alert_id":"honeypot:7","mode":"deep"}'],
    ['PUT', '/api/triage/rules'],
    ['GET', '/api/wiki/health'],
    ['GET', '/api/wiki/unknown-path'],
  ];
  for (const [method, route, body] of routes) {
    const response = await call(base, route, body === undefined ? { method }
      : { method, headers: { 'Content-Type': 'application/json' }, body });
    await expectError(response, { status: 503, code: 'not_configured' }, `${method} ${route}`);
  }
});

test('A2 上游一类：alerts / alerts 单条 / status / Rego 规则库三条读路由都是 502 upstream_error', async t => {
  const base = await serve(t, {
    service: {
      alerts: async () => { throw new Error('牧云 /rpc 5001: 查询超时'); },
      alert: async () => { throw new Error('牧云 /rpc 5002: 事件不存在'); },
      status: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); },
    },
    ruleStore: {
      list: async () => { throw new Error('规则库读取失败：rules/webshell_drop.rego:3 语法错误'); },
      read: async () => { throw new Error('规则库读取失败：rules/webshell_drop.rego:3 语法错误'); },
      evaluate: async () => { throw new Error('规则求值失败：package 缺失'); },
    },
  });
  await expectError(await call(base, '/api/alerts'), { status: 502, code: 'upstream_error', error: '牧云 /rpc 5001: 查询超时' }, 'alerts');
  await expectError(await call(base, '/api/alerts/honeypot%3A7'), { status: 502, code: 'upstream_error', error: '牧云 /rpc 5002: 事件不存在' }, 'alerts 单条');
  await expectError(await call(base, '/api/rules'), { status: 502, code: 'upstream_error', error: /规则库读取失败/ }, 'GET /api/rules');
  await expectError(await call(base, '/api/rules/brute_force'), { status: 502, code: 'upstream_error', error: /规则库读取失败/ }, 'GET /api/rules/{id}');
  await expectError(await postJSON(base, '/api/rules/evaluate', JSON.stringify({ type: 'honeypot' })),
    { status: 502, code: 'upstream_error', error: /规则求值失败/ }, 'POST /api/rules/evaluate');

  // /api/status 的 502 是业务体（文档 §9.2）：configured/connected/reason 一个不删，末位多 code。
  const status = await call(base, '/api/status');
  assert.equal(status.status, 502);
  // P003-T073：502 特例并入统一模型——形状保留，error/code 由错误模型出。
  assert.deepEqual(await status.json(), { configured: true, connected: false,
    reason: 'connect ECONNREFUSED 10.0.0.1:443', error: 'connect ECONNREFUSED 10.0.0.1:443', code: 'upstream_error' });
});

test('A2 本程序一类：wiki 页读 / 规则配置写 / 研判开关 / 提示词元数据 都是 500 固定文案', async t => {
  const poison = '写盘失败：ENOSPC at /srv/backend/.data/wiki (node:internal/fs/promises:123:45)';
  const base = await serve(t, {
    wiki: { get: async () => { throw new Error(poison); } },
    monitor: { ruleEngine: { saveConfig: async () => { throw new Error(poison); } },
      setEnabled: async () => { throw new Error(poison); }, status: () => null },
    prompts: { metadata: async () => { throw new Error(poison); } },
    ruleAdminToken: 'rule-token',
  });
  const requests = [
    ['wiki 页读', await call(base, '/api/wiki/pages/honeypot%2FHP-01.md')],
    ['规则配置写', await call(base, '/api/triage/rules', { method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Rule-Admin-Token': 'rule-token' },
      body: '{"expected_revision":null,"config":{"rules":[]}}' })],
    ['研判开关', await call(base, '/api/agent/triage/control', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })],
    ['提示词元数据', await call(base, '/api/agent/prompts')],
  ];
  for (const [label, response] of requests) {
    const body = await expectError(response, { status: 500, code: 'internal_error', error: INTERNAL_TEXT }, label);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /ENOSPC|at \/srv|node:internal|at Object|\.js:\d+:\d+/, `${label} 不能回显原文或堆栈`);
  }
});

// ---------------- 边界：必填缺失 / 类型错 / 越界 / 超长 / 空数组 / 非法枚举 ----------------
test('边界：正文与参数的每条 400 都对得上文档（缺失/类型/越界/超长/空数组）', async t => {
  const base = await serve(t, {
    service: { alerts: async () => ({ alerts: [], total: 0, totals: {}, errors: {}, partial: false }) },
    monitor: { status: () => null, setEnabled: async () => ({ enabled: true }), cases: async () => ({ cases: [], total: 0 }),
      summary: () => ({ counts: {} }), persist: async () => {} },
    wiki: { browse: async () => [], get: async () => null },
    investigator: { run: async () => ({ alert_id: 'honeypot:7', mode: 'deep' }) },
    ruleAdminToken: 'rule-token',
  });

  // §7 分页：count 1..50 安全整数、offset >= 0；越界与原值不合法都是 400「分页参数无效」
  for (const query of ['count=0', 'count=51', 'count=abc', 'count=20.5', 'offset=-1']) {
    await expectError(await call(base, `/api/alerts?${query}`), { status: 400, code: 'caller_error', error: '分页参数无效' }, `alerts ${query}`);
  }
  for (const query of ['count=0', 'count=51']) {
    await expectError(await call(base, `/api/wiki/pages?${query}`), { status: 400, code: 'caller_error', error: '分页参数无效' }, `wiki ${query}`);
  }

  // §8.1 正文：不是 JSON / 超过上限（control 上限 8192 按字符数）
  await expectError(await postJSON(base, '/api/agent/investigations', '{'),
    { status: 400, code: 'caller_error', error: '请求正文不是 JSON' }, '正文不是 JSON');
  await expectError(await call(base, '/api/agent/triage/control', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: `{"enabled":true,"pad":"${'x'.repeat(9000)}"}` }),
    { status: 400, code: 'caller_error', error: '请求正文过大' }, '正文超长');

  // §8.2 形状：正文不是对象（数组）回「请求正文无效」
  await expectError(await postJSON(base, '/api/agent/investigations', '[]'),
    { status: 400, code: 'caller_error', error: '请求正文无效' }, '正文是数组');

  // §3.1 规则校验：缺 config 键 / config 类型不对
  for (const body of ['{}', '[]', 'null', '5', '"文本"']) {
    await expectError(await postJSON(base, '/api/triage/rules/validate', body),
      { status: 400, code: 'caller_error', error: '请求正文缺少 config' }, `validate ${body}`);
  }
  await expectError(await postJSON(base, '/api/triage/rules/validate', '{"config":{"rules":"不是数组"}}'),
    { status: 400, code: 'caller_error', error: '规则集格式无效' }, 'config 不是合法规则集');

  // §8.2 规则写必须带版本
  await expectError(await call(base, '/api/triage/rules', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Rule-Admin-Token': 'rule-token' },
    body: '{"config":{"rules":[]}}' }),
    { status: 400, code: 'caller_error', error: '缺少有效的规则配置版本' }, '缺 expected_revision');

  // §3.3 路径 ID：格式不对回 400，code 仍是 caller_error
  await expectError(await call(base, '/api/agent/triage/not-an-id'),
    { status: 400, code: 'caller_error', error: /告警 ID/ }, 'triage 非法 ID');
  await expectError(await call(base, '/api/agent/investigations/not-an-id?mode=deep'),
    { status: 400, code: 'caller_error', error: /告警 ID/ }, 'investigations 非法 ID');

  // 研判 POST 的 ID/模式校验在分流前（§8.3）：非法入参不因 stream=0 走错分支
  await expectError(await postJSON(base, '/api/agent/investigations', '{"alert_id":"not-an-id","mode":"deep"}'),
    { status: 400, code: 'caller_error', error: /告警 ID/ }, 'POST investigations 非法 ID');

  // §3.4 误报登记：理由必填 10 到 4000 字
  await expectError(await postJSON(base, '/api/agent/triage/honeypot%3A7/false-positive', '{"reason":"太短"}'),
    { status: 400, code: 'caller_error', error: /理由/ }, '误报理由过短');
});

test('边界：误报登记的 404（无此案件）与 409（研判未完成）都是 caller_error', async t => {
  const missing = await serve(t, { monitor: { records: new Map(), status: () => null, persist: async () => {} } });
  await expectError(await postJSON(missing, '/api/agent/triage/honeypot%3A7/false-positive', '{"reason":"误报理由写够十个字吧"}'),
    { status: 404, code: 'caller_error', error: '找不到这条研判案件' }, '无此案件');

  const queued = { alert_id: 'honeypot:7', status: 'queued' };
  const running = await serve(t, { monitor: { records: new Map([['honeypot:7', queued]]),
    status: () => queued, persist: async () => {}, enqueue: async () => ({}) } });
  await expectError(await postJSON(running, '/api/agent/triage/honeypot%3A7/false-positive', '{"reason":"误报理由写够十个字吧"}'),
    { status: 409, code: 'caller_error', error: '研判还没结束，不能登记误报' }, '研判未完成');
});

// ---------------- A3 与 A4 ----------------
test('A3/A4 上游摘要原话保留，同时 Basic / Bearer / token= / api_key= 一个都不回显', async t => {
  // 凭据按四种形态拼进上游原话（Basic <base64>、Bearer <token>、token=、api_key=）
  const secrets = ['dG9rZW46c2VjcmV0', 'sk-live-1234567890', 'abc123', 'key-9'];
  const base = await serve(t, { service: { alerts: async () => { throw new Error(
    '牧云 /rpc 401: 拒绝 Basic dG9rZW46c2VjcmV0，Bearer sk-live-1234567890，token=abc123&request=api_key=key-9 无效'); } } });
  const body = await expectError(await call(base, '/api/alerts'),
    { status: 502, code: 'upstream_error', error: /牧云 \/rpc 401: 拒绝/ }, '上游凭据');
  for (const secret of secrets) assert.ok(!JSON.stringify(body).includes(secret), `正文里出现了凭据：${secret}`);

  // /api/status 的 reason 走同一道闸
  const statusBase = await serve(t, { service: { status: async () => { throw new Error(
    'connect ECONNREFUSED 10.0.0.1:443 (Basic c2VjcmV0OnNlY3JldA==, token=hunter2)'); } } });
  const status = await call(statusBase, '/api/status');
  assert.equal(status.status, 502);
  const statusBody = await status.json();
  assert.equal(statusBody.code, 'upstream_error');
  assert.match(statusBody.reason, /connect ECONNREFUSED 10\.0\.0\.1:443/, 'reason 摘要还在');
  for (const secret of ['c2VjcmV0OnNlY3JldA==', 'hunter2']) {
    assert.ok(!JSON.stringify(statusBody).includes(secret), `status 502 正文里出现了凭据：${secret}`);
  }

  // SSE 错误帧（§6）：状态 200、帧里的原文同样过擦除；P003-T073 起帧带 code（前端可只按 code 判成败）
  const investigator = { run: async () => { throw new Error('模型接口 401: Bearer sk-live-stream-token 无效'); } };
  const streamBase = await serve(t, { investigator, history: { save: async value => value } });
  const stream = await postJSON(streamBase, '/api/agent/investigations?stream=1',
    '{"alert_id":"honeypot:7","mode":"deep"}');
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const raw = await stream.text();
  assert.ok(!raw.includes('sk-live-stream-token'), `SSE 帧里出现了凭据：${raw}`);
  assert.match(raw, /模型接口 401/);
  const frames = raw.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
  const errorFrame = frames.find(frame => frame.type === 'error');
  assert.ok(errorFrame, 'SSE 必须有一帧 type=error');
  assert.equal(errorFrame.code, 'upstream_error', 'P003-T073：SSE 帧带统一 code');
});

// ---------------- 401：P003-T073 起 {error, code} JSON，同码跨路由 ----------------
test('401 是 {error, code} JSON（code=unauthorized），同一闸门下所有路由同码', async t => {
  const base = await serve(t, { access: { user: 'ops', password: 'test-only-password' } });
  const denied = await call(base, '/api/status');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await denied.json(), { error: '需要登录后访问', code: 'unauthorized' });

  // 同一 401 下别的路由同码（身份闸在路由之前）
  const other = await call(base, '/api/alerts');
  assert.equal(other.status, 401);
  assert.deepEqual(await other.json(), { error: '需要登录后访问', code: 'unauthorized' });
});

// ---------------- e2e：真进程起 server.js ----------------
// P003-T025 起五项必填（CLOUDWALKER_URL/CLOUDWALKER_API_TOKEN/LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）是启动硬门槛：
// 一个必填都没配的真进程根本起不来，「未配牧云 → 503」的场景在真进程里已不存在（那是 createServer 注入替身的场景，
// 上面几条进程内用例覆盖）。这条 e2e 因此换成「配了假地址但连不上」：JSON 形状与四类 code 的断言强度不变。
// 假值只求形状合法（URL 前缀、Token ≥6 位），一个都不是真凭据。
test('e2e 真进程：node server.js 配了牧云但与上游不通时，502/404/405 的 code 与 JSON 形状都成立', async t => {
  const port = await new Promise((resolve, reject) => {
    const probe = netCreateServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t024-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    // HIDS_DATA_DIR 指到这条用例自己的 tmp 目录：真进程一个字节都不许写进仓库或真实全局根（P003-T034 A2）。
    env: { PATH: process.env.PATH, HIDS_DATA_DIR: directory, HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port),
      CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: 'fake-token-123456',
      LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'fake-key-abcdef', LLM_MODEL: 'fake-model',
      // 五项齐后研判队列会起 syslog 接收器：端口设 0 让它自己挑，别抢 15514。
      HIDS_SYSLOG_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once('exit', () => done());
    child.kill('SIGKILL');
  }));

  // 真进程起没起来看它自己的运行日志（P003-T023 起是结构化 JSON：event=server.started）。
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`server.js 没有在 8s 内起来：stdout=${stdout} stderr=${stderr}`)), 8000);
    const poll = setInterval(() => {
      if (stdout.includes('"event":"server.started"')) { finish(); return; }
      if (child.exitCode !== null) finish(new Error(`server.js 提前退出（code=${child.exitCode}）：${stderr}`));
    }, 25);
  });

  const base = `http://127.0.0.1:${port}`;
  // 牧云算「配了」（两个键都在），于是真去连假地址 → 上游失败 502；不是 not_configured 的 503。
  const alerts = await call(base, '/api/alerts');
  assert.equal(alerts.status, 502);
  const alertsBody = await alerts.json();
  assert.equal(alertsBody.code, 'upstream_error');
  await expectError(await call(base, '/api/nope'), { status: 404, code: 'caller_error', error: '接口不存在' }, '真进程 未知 API');
  await expectError(await call(base, '/api/agent/prompts', { method: 'POST' }),
    { status: 405, code: 'caller_error', error: '请使用提示词文件上传入口' }, '真进程 405');

  // /api/status 配了却连不上：502，正文仍是业务体 {configured, connected, reason} + 末位 code（文档 §9.2 的例外那条）
  const status = await call(base, '/api/status');
  assert.equal(status.status, 502);
  const statusBody = await status.json();
  assert.equal(statusBody.configured, true);
  assert.equal(statusBody.connected, false);
  assert.equal(typeof statusBody.reason, 'string');
  assert.ok(statusBody.reason.length > 0);
  assert.equal(statusBody.code, 'upstream_error');
});
