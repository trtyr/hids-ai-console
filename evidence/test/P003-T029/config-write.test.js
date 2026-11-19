// P003-T029：配置可写——牧云与模型运行中可改，持久化且不回显。
// 口径见 docs/modules/http-api.md §3.5/§3.6 与 openapi.yaml 的 `writeConfig`：
//   A1 不重启进程写六项，GET /api/config 立刻反映；活着的客户端对象原地换值（applyLiveConfig）
//   A2 任何响应（写成功的、写失败的）里都不出现 Token 与密码原文
//   A3 写操作过 Basic 认证闸门；没启用手势（没配 HIDS_BASIC_AUTH_PASSWORD）时放行——文档写明
//   A4 改过的值落盘、重启仍生效；没改过的键继续读环境变量；覆盖层文件坏了不影响启动
//   A5 每次写落一条 config.updated，只带键名不带值
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfigStore, WRITABLE_CONFIG_KEYS } from '../../../config-store.js';
import { createServer, applyLiveConfig, configSummary } from '../../../server.js';

// 每一项都是假值：形状合法（URL 前缀、Token ≥6 位）以便装配处的构造器放行，但一点都不像真凭据。
const FAKE_ENV = Object.freeze({
  HIDS_HOST: '127.0.0.1',
  CLOUDWALKER_URL: 'http://127.0.0.1:1',
  CLOUDWALKER_API_TOKEN: 'fake-token-123456',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_API_KEY: 'fake-key-abcdef',
  LLM_MODEL: 'fake-model'
});
const NEW_TOKEN = 'new-token-abcdef';
const NEW_KEY = 'new-key-abcdef';
const PASS = 'gate-pass-abcdef';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// createServer 是一串位置参数，config 在最后一位：补到那一位再传，中间一律 undefined（走各自缺省）。
const CONFIG_SLOT = 16;
function serverWith({ access, store }) {
  const positional = new Array(CONFIG_SLOT + 1).fill(undefined);
  positional[7] = access; // access
  positional[CONFIG_SLOT] = store; // config（P003-T029 新增）
  return createServer(...positional);
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function basic(user = 'ops', password = PASS) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function post(base, patch, headers = {}) {
  return fetch(`${base}/api/config`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(patch) });
}

test('A1 写六项后 GET /api/config 立刻反映，updated 逐键回键名（不重启进程）', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const env = { ...FAKE_ENV };
  const store = createConfigStore({ file, env });
  const base = await listen(t, serverWith({ access: {}, store })); // 没配口令：闸门放行（A3 的另一态）

  const response = await post(base, {
    CLOUDWALKER_URL: 'http://10.9.9.9:9000', CLOUDWALKER_API_TOKEN: NEW_TOKEN,
    LLM_BASE_URL: 'http://10.9.9.9:9001/v1', LLM_API_KEY: NEW_KEY, LLM_MODEL: 'new-model'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.updated, ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);

  const summary = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(summary.model, { configured: true, name: 'new-model' });
  assert.equal(summary.cloudwalker.configured, true);
  assert.deepEqual(summary.missing_required, []);
  // 写之后的响应与随后的 GET 报的是同一份生效值：GET 走的就是被覆盖层盖过的 env。
  assert.deepEqual(body.config, summary);
  // 只改一项时也只回那一项：部分更新，不是整份覆盖。
  const partial = await (await post(base, { LLM_MODEL: 'another-model' })).json();
  assert.deepEqual(partial.updated, ['LLM_MODEL']);
  assert.equal(partial.config.model.name, 'another-model');
  assert.equal(partial.config.secrets.CLOUDWALKER_API_TOKEN, true, '只改模型名不该把牧云配置清掉');
});

test('A1 活着的客户端原地换值：牧云 rpc、MCP 客户端、模型三项都走新值', () => {
  const gateway = { rpc: { baseUrl: new URL('http://old.test'), token: 'old-token-11' } };
  const agentToolbox = { client: { url: new URL('http://old.test/api/mcp'), token: 'old-token-11', initialized: true } };
  const model = { url: new URL('http://old.test/chat/completions'), apiKey: 'old-key-11', model: 'old-model' };
  applyLiveConfig({ gateway, model, agentToolbox },
    { CLOUDWALKER_URL: 'http://new.test:8443', CLOUDWALKER_API_TOKEN: NEW_TOKEN, LLM_BASE_URL: 'http://new.test/v1/', LLM_API_KEY: NEW_KEY, LLM_MODEL: 'new-model' });
  assert.equal(gateway.rpc.baseUrl.href, 'http://new.test:8443/');
  assert.equal(gateway.rpc.token, NEW_TOKEN);
  assert.equal(agentToolbox.client.url.href, 'http://new.test:8443/api/mcp');
  assert.equal(agentToolbox.client.token, NEW_TOKEN);
  assert.equal(agentToolbox.client.initialized, false, '换了服务端要重新 initialize MCP 会话');
  assert.equal(model.url.href, 'http://new.test/v1/chat/completions');
  assert.equal(model.apiKey, NEW_KEY);
  assert.equal(model.model, 'new-model');

  // 值的形状不合法在这里不可能发生（store 已用同一套构造器判过）；缺项则一项都不动。
  const untouched = { gateway: { rpc: { baseUrl: 'keep', token: 'keep' } }, model: null };
  applyLiveConfig(untouched, { CLOUDWALKER_URL: null, CLOUDWALKER_API_TOKEN: null });
  assert.equal(untouched.gateway.rpc.token, 'keep');
  assert.equal(applyLiveConfig(null, {}), null);
});

test('A2 写成功与写失败的响应里都不出现 Token / 密钥原文', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const store = createConfigStore({ file, env: { ...FAKE_ENV } });
  const base = await listen(t, serverWith({ access: {}, store }));

  const ok = await post(base, { CLOUDWALKER_API_TOKEN: NEW_TOKEN, LLM_API_KEY: NEW_KEY });
  const okText = await ok.text();
  assert.equal(ok.status, 200);
  assert.ok(!okText.includes(NEW_TOKEN), `写成功的正文里出现了 Token：${okText}`);
  assert.ok(!okText.includes(NEW_KEY), `写成功的正文里出现了密钥：${okText}`);
  assert.ok(!okText.includes(FAKE_ENV.CLOUDWALKER_API_TOKEN), '写成功的正文里出现了旧 Token');
  assert.equal(JSON.parse(okText).config.secrets.CLOUDWALKER_API_TOKEN, true);

  const getText = await (await fetch(`${base}/api/config`)).text();
  for (const secret of [NEW_TOKEN, NEW_KEY, FAKE_ENV.CLOUDWALKER_API_TOKEN, FAKE_ENV.LLM_API_KEY])
    assert.ok(!getText.includes(secret), `GET 正文里出现了机密原文：${secret}`);

  // 值不合法时的错误原话只点键名，不回显坏值（坏值里塞一段像凭据的东西也不许漏出去）。
  const bad = await post(base, { LLM_BASE_URL: 'ftp://secret-in-url.test/v1' });
  const badText = await bad.text();
  assert.equal(bad.status, 400);
  assert.ok(!badText.includes('secret-in-url.test'), `错误正文回显了坏值：${badText}`);
  assert.match(JSON.parse(badText).error, /LLM_BASE_URL/);
  assert.equal(JSON.parse(badText).code, 'caller_error');
});

test('A3 写操作过 Basic 认证闸门；没启用鉴权时放行（文档写明的两态）', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const store = createConfigStore({ file, env: { ...FAKE_ENV } });
  // 启用口令：没凭据 401、凭据对了才 200。
  const gated = await listen(t, serverWith({ access: { user: 'ops', password: PASS }, store }));
  const denied = await post(gated, { LLM_MODEL: 'gated-model' });
  assert.equal(denied.status, 401);
  assert.match(await denied.text(), /需要登录后访问/);
  assert.equal(store.values().LLM_MODEL, 'fake-model', '没凭据的写必须一个字都没落盘');
  const allowed = await post(gated, { LLM_MODEL: 'gated-model' }, { Authorization: basic() });
  assert.equal(allowed.status, 200);

  // 没配口令：hasAccess 放行，写也放行——这是合法部署，行为在 docs/modules/http-api.md §3.6 写明。
  const open = await listen(t, serverWith({ access: {}, store: createConfigStore({ file: path.join(path.dirname(file), 'open.json'), env: { ...FAKE_ENV } }) }));
  assert.equal((await post(open, { LLM_MODEL: 'open-model' })).status, 200);
});

test('A4 改过的值落盘后重启仍生效；没改过的键继续读环境变量', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config-overrides.json');
  const before = { ...FAKE_ENV };
  await createConfigStore({ file, env: before }).update({ CLOUDWALKER_API_TOKEN: NEW_TOKEN, LLM_MODEL: 'persisted-model' });

  // 「重启」＝新进程同一份环境变量再建一次 store：覆盖层先盖进 env，再读生效值。
  const after = { ...FAKE_ENV };
  const restarted = createConfigStore({ file, env: after });
  assert.equal(after.CLOUDWALKER_API_TOKEN, NEW_TOKEN);
  assert.equal(after.LLM_MODEL, 'persisted-model');
  assert.equal(after.LLM_BASE_URL, FAKE_ENV.LLM_BASE_URL, '没改过的键必须继续读环境变量');
  assert.equal(restarted.values().LLM_BASE_URL, FAKE_ENV.LLM_BASE_URL);
  assert.deepEqual(Object.keys(restarted.overrides()).sort(), ['CLOUDWALKER_API_TOKEN', 'LLM_MODEL'],
    '覆盖层只存改过的键');
  assert.equal(configSummary(after).model.name, 'persisted-model');

  // 盘上的文件是原子替换后的最终内容，权限收到 0600（里面有 Token 原文）。
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(onDisk, { CLOUDWALKER_API_TOKEN: NEW_TOKEN, LLM_MODEL: 'persisted-model' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('A4 覆盖层文件坏了不影响启动：当空处理并落 config.load_failed', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config-overrides.json');
  await writeFile(file, '{ 这不是 JSON', 'utf8');
  const events = [];
  const env = { ...FAKE_ENV };
  const store = createConfigStore({ file, env, journal: (event, fields, level) => events.push({ event, fields, level }) });
  assert.deepEqual(store.overrides(), {});
  assert.equal(env.LLM_MODEL, FAKE_ENV.LLM_MODEL);
  assert.deepEqual(events.map(item => item.event), ['config.load_failed']);
  assert.equal(events[0].level, 'error');
});

test('A5 每次写留一条 config.updated，只带键名不带值', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const events = [];
  const store = createConfigStore({ file, env: { ...FAKE_ENV },
    journal: (event, fields) => events.push({ event, fields }) });
  await store.update({ CLOUDWALKER_API_TOKEN: NEW_TOKEN, LLM_MODEL: 'logged-model' });
  assert.deepEqual(events, [{ event: 'config.updated', fields: { keys: ['CLOUDWALKER_API_TOKEN', 'LLM_MODEL'] } }]);
  const serialized = JSON.stringify(events);
  for (const secret of [NEW_TOKEN, NEW_KEY, 'logged-model']) assert.ok(!serialized.includes(secret),
    `日志里出现了值：${secret}`);

  // 写失败不落 config.updated（留痕记的是「改了」，不是「想改」）。
  await assert.rejects(store.update({ LLM_BASE_URL: 'ftp://bad.test' }));
  assert.equal(events.length, 1);
});

test('写接口的拒绝面：表外的键、空值、非对象正文、空正文都 400 且什么都不改', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const env = { ...FAKE_ENV };
  const store = createConfigStore({ file, env });
  const base = await listen(t, serverWith({ access: {}, store }));
  const cases = [
    [{ HIDS_PORT: '9090' }, /配置项不可写：HIDS_PORT/],
    [{ HIDS_BASIC_AUTH_PASSWORD: 'hunter2' }, /配置项不可写：HIDS_BASIC_AUTH_PASSWORD/],
    [{ LLM_MODEL: '' }, /LLM_MODEL/],
    [{ LLM_MODEL: '   ' }, /LLM_MODEL/],
    [{ LLM_MODEL: 7 }, /LLM_MODEL/],
    [[], /JSON 对象/],
    [{}, /没有可写的配置项/]
  ];
  for (const [patch, pattern] of cases) {
    const response = await post(base, patch);
    assert.equal(response.status, 400, `正文 ${JSON.stringify(patch)} 应回 400`);
    assert.match((await response.json()).error, pattern);
  }
  assert.deepEqual(store.overrides(), {}, '被拒的写不许留下覆盖层');
  assert.equal(env.LLM_MODEL, FAKE_ENV.LLM_MODEL);
  // 认不出的方法不是写：POST 之外没有第二个写入口。
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT' })).status, 404);
});

test('可写键表钉死六项：多一项少一项都算契约被改', () => {
  assert.deepEqual([...WRITABLE_CONFIG_KEYS], ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN',
    'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);
});
