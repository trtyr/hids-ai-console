// P003-T024：错误分四类、响应带稳定 code。全部经 createServer 的注入点跑真 HTTP，不碰外部服务。
// 口径见 docs/modules/http-api.md §8.3：
//   caller_error → 4xx（400 参数 / 403 权限 / 404 不存在 / 405 方法 / 409 冲突 / 410 已下线 / 422 无法溯源）
//   not_configured → 503 / upstream_error → 502 / internal_error → 500（固定文案「服务器内部错误」）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../../server.js';

async function serve(t, options = {}) {
  const server = createServer(options.service ?? null, options.toolbox ?? null, options.investigator ?? null,
    options.history ?? null, options.prompts ?? null, options.monitor ?? null, null, options.access ?? {},
    options.boardService ?? null, options.promptAdminToken ?? null, options.wiki ?? null,
    options.wikiAgent ?? null, null, options.ruleAdminToken ?? null, options.ruleStore ?? null,
    options.ruleMaintainer ?? null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const json = (base, path, init) => fetch(`${base}${path}`, init);
const failureOf = async response => {
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  return response.json();
};

// 四类的状态码与 code 是固定对照表，测试里照抄一遍：实现改了表，下面几条会一起红。
const CLASS_TABLE = { caller_error: 400, not_configured: 503, upstream_error: 502, internal_error: 500 };

test('A1 四类各一条：调用方传错 400 / 没配置 503 / 上游失败 502 / 本程序失败 500，各自带稳定 code', async t => {
  const callerBase = await serve(t, { service: { alerts: async () => ({ alerts: [], partial: false }) } });
  const caller = await json(callerBase, '/api/alerts?count=0');
  assert.equal(caller.status, 400);
  assert.deepEqual(await failureOf(caller), { error: '分页参数无效', code: 'caller_error' });

  const configBase = await serve(t, {});
  const config = await json(configBase, '/api/alerts');
  assert.equal(config.status, 503);
  assert.deepEqual(await failureOf(config),
    { error: '未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN', code: 'not_configured' });

  const upstreamBase = await serve(t, { service: { alerts: async () => { throw new Error('牧云 /rpc 5001: 内部错误'); } } });
  const upstream = await json(upstreamBase, '/api/alerts');
  assert.equal(upstream.status, 502);
  const upstreamBody = await failureOf(upstream);
  assert.equal(upstreamBody.code, 'upstream_error');

  const internalBase = await serve(t, { wiki: { get: async () => { throw new Error('EACCES: permission denied'); } } });
  const internal = await json(internalBase, '/api/wiki/pages/honeypot%2FHP-01.md');
  assert.equal(internal.status, 500);
  assert.deepEqual(await failureOf(internal), { error: '服务器内部错误', code: 'internal_error' });
});

test('A1 code 与状态码固定对照：每一类在别的路由上也是同一对（不是这边 400 那边 502）', async t => {
  // 调用方传错：alerts 分页 / wiki 分页 —— 两条不同路由同一类
  const base = await serve(t, { service: { alerts: async () => ({ alerts: [], partial: false }) },
    wiki: { browse: async () => [] } });
  const first = await json(base, '/api/alerts?count=0');
  const second = await json(base, '/api/wiki/pages?count=0');
  for (const response of [first, second]) {
    assert.equal(response.status, CLASS_TABLE.caller_error);
    assert.equal((await response.json()).code, 'caller_error');
  }

  // 上游失败：/api/alerts（牧云列表）与 /api/status（牧云连通性）
  const upstreamBase = await serve(t, { service: {
    alerts: async () => { throw new Error('fetch failed'); },
    status: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); } } });
  const list = await json(upstreamBase, '/api/alerts');
  const status = await json(upstreamBase, '/api/status');
  assert.equal(list.status, CLASS_TABLE.upstream_error);
  assert.equal(status.status, CLASS_TABLE.upstream_error);
  assert.equal((await list.json()).code, 'upstream_error');
  assert.equal((await status.json()).code, 'upstream_error');

  // 本程序失败：wiki 页读（原来是 400）与规则配置写（原来是 400）、研判开关（原来是 502）都归 500
  const internalBase = await serve(t, {
    wiki: { get: async () => { throw new Error('EIO: i/o error'); } },
    monitor: { ruleEngine: { saveConfig: async () => { throw new Error('磁盘满了'); } },
      setEnabled: async () => { throw new Error('写盘失败'); } },
    ruleAdminToken: 'rule-token' });
  const page = await json(internalBase, '/api/wiki/pages/honeypot%2FHP-01.md');
  const rules = await json(internalBase, '/api/triage/rules', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Rule-Admin-Token': 'rule-token' },
    body: JSON.stringify({ expected_revision: null, config: { rules: [] } }) });
  const control = await json(internalBase, '/api/agent/triage/control', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  for (const [name, response] of [['wiki 页读', page], ['规则配置写', rules], ['研判开关', control]]) {
    assert.equal(response.status, CLASS_TABLE.internal_error, `${name} 应回 500`);
    assert.equal((await response.json()).code, 'internal_error', `${name} 的 code`);
  }
});

test('A2 没配置那一类在四条路由上都是 503 not_configured', async t => {
  const base = await serve(t, {});
  for (const path of ['/api/alerts', '/api/agent/tools', '/api/trace/tools', '/api/agent/triage/status']) {
    const response = await json(base, path);
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).code, 'not_configured', path);
  }
});

test('A2 调用方那一类保留 4xx 里的既有档位，code 一律 caller_error', async t => {
  const base = await serve(t, { service: { alerts: async () => ({ alerts: [], partial: false }) },
    wiki: { get: async () => { throw Object.assign(new Error('知识库页面不存在：common/GEN-99.md'), { status: 404 }); } } });
  const cases = [
    ['/api/alerts?count=0', 400],
    ['/api/unknown', 404],
    ['/api/wiki/pages/common%2FGEN-99.md', 404],
    ['/api/agent/prompts/upload', 410]
  ];
  for (const [path, status] of cases) {
    const response = await json(base, path);
    assert.equal(response.status, status, path);
    assert.equal((await response.json()).code, 'caller_error', path);
  }
  const wrongMethod = await json(base, '/api/agent/prompts', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).code, 'caller_error');
});

test('A3 上游失败把上游那句摘要原话带出来（牧云码 / 直连失败原因）', async t => {
  const base = await serve(t, { service: { alerts: async () => { throw new Error('牧云 /rpc 5001: 查询超时'); } } });
  const body = await failureOf(await json(base, '/api/alerts'));
  assert.equal(body.code, 'upstream_error');
  assert.match(body.error, /牧云 \/rpc 5001: 查询超时/);

  // /api/status 的业务体形状不动：configured/connected 还在，reason 是上游摘要，末位多一个 code。
  const statusBase = await serve(t, { service: { status: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); } } });
  const statusResponse = await json(statusBase, '/api/status');
  assert.equal(statusResponse.status, 502);
  assert.deepEqual(await statusResponse.json(), { configured: true, connected: false,
    reason: 'connect ECONNREFUSED 10.0.0.1:443', code: 'upstream_error' });
});

test('A3 本程序意外只回固定文案：异常原文与堆栈都不进正文', async t => {
  const secret = '写盘失败：ENOSPC at /srv/backend/.data/wiki (node:internal/fs/promises:123:45)';
  const base = await serve(t, { wiki: { get: async () => { throw new Error(secret); } } });
  const response = await json(base, '/api/wiki/pages/honeypot%2FHP-01.md');
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: '服务器内部错误', code: 'internal_error' });
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /ENOSPC|at \/srv|node:internal/, '本程序失败不能回显异常原文或堆栈');
});

test('A4 上游回显的凭据不进正文：Basic / Bearer / token= / api_key= 全部擦掉', async t => {
  const base = await serve(t, { service: { alerts: async () => { throw new Error(
    '牧云 /rpc 401: 拒绝 Basic dG9rZW46c2VjcmV0，Bearer sk-live-1234567890，token=abc123&request=api_key=key-9 无效'); } } });
  const response = await json(base, '/api/alerts');
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, 'upstream_error');
  const text = JSON.stringify(body);
  for (const secret of ['dG9rZW46c2VjcmV0', 'sk-live-1234567890', 'abc123', 'key-9']) {
    assert.ok(!text.includes(secret), `正文里出现了凭据：${secret}`);
  }
  // 上游摘要本身还在（只是凭据被换掉），A3 与 A4 同时成立。
  assert.match(body.error, /牧云 \/rpc 401: 拒绝/);
});

test('A2 未被路由接住的异常也按四类走：读正文错了是 400，本地存储意外是 500（不再一律 502）', async t => {
  // 读正文失败：readJSON 的异常自带 status 400 —— 旧实现靠 /请求正文/ 匹配文案才认得出，现在靠标记。
  const badBodyBase = await serve(t, {});
  const badBody = await json(badBodyBase, '/api/agent/investigations', { method: 'POST', body: '{' });
  assert.equal(badBody.status, 400);
  assert.deepEqual(await badBody.json(), { error: '请求正文不是 JSON', code: 'caller_error' });

  // 路由里没有 try 的本地存储（提示词元数据）抛了意外：外层 catch 认「本程序失败」→ 500 固定文案。
  const internalBase = await serve(t, { prompts: { metadata: async () => { throw new Error('prompt-overrides.json 读不了'); } } });
  const internal = await json(internalBase, '/api/agent/prompts');
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: '服务器内部错误', code: 'internal_error' });
});
