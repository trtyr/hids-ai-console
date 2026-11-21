// P003-T029 tester 集成验收（黑盒：只按 docs/modules/http-api.md §3.5/§3.6 与 openapi.yaml `writeConfig` 断言）
//
// 补齐写者单测没覆盖的验收三样：
//   1) schema 符合性——200 正文逐键逐类型对 openapi（updated 数组 + config 八键、机密只布尔、头三条）；
//   2) 边界——空正文/非对象正文/正文超长/表外键逐个/非字符串值/空串与空白串/各键值形状下界；
//   3) 错误码——400（六类原话）/ 401（纯文本四条头）/ 500（落盘失败，正文不含异常原文）；
// 另加：被拒的写「什么都不变」（GET 仍是旧值、覆盖层不落盘）。每条请求都带 AbortSignal.timeout(5000)：请求卡住要在 5s 内变红，不许把门禁无限挂起。
// 全局根隔离（P003-T050 A2）：本文件触发写接口 → 产生审计事件（P003-T062），必须先隔离数据根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../../../src/contexts/dataops/infrastructure/config-store.js';
import { createServer } from '../../../server.js';

// 每一项形状合法（URL 前缀、Token ≥6 位）但都不是真凭据，方便断言「原文不出现」。
const FAKE_ENV = Object.freeze({
  HIDS_HOST: '127.0.0.1',
  CLOUDWALKER_URL: 'http://127.0.0.1:1',
  CLOUDWALKER_API_TOKEN: 'fake-token-123456',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_API_KEY: 'fake-key-abcdef',
  LLM_MODEL: 'fake-model'
});
const PASS = 'gate-pass-abcdef';
const CONFIG_SLOT = 16; // createServer 串行参数，config 在最后一位（同上卡单测的注入方式）

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-config-tester-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function serverWith({ access = {}, store }) {
  const positional = new Array(CONFIG_SLOT + 1).fill(undefined);
  positional[7] = access;
  positional[CONFIG_SLOT] = store;
  return createServer(...positional);
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function basic(password = PASS) {
  return `Basic ${Buffer.from(`ops:${password}`).toString('base64')}`;
}

function postRaw(base, raw, headers = {}) {
  return fetch(`${base}/api/config`, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
}

const post = (base, patch, headers) => postRaw(base, JSON.stringify(patch), headers);

function assertJsonError(response, status, pattern) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  return response.json().then(body => {
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error'], '错误正文形状恒为 {error, code}');
    assert.equal(body.code, status === 500 ? 'internal_error' : 'caller_error');
    assert.match(body.error, pattern);
    return body;
  });
}

test('schema：200 正文逐键逐类型对 openapi writeConfig（updated + config 八键、机密只布尔）', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config-overrides.json');
  const events = [];
  const store = createConfigStore({ file, env: { ...FAKE_ENV },
    journal: (event, fields) => events.push({ event, fields }) });
  const base = await listen(t, serverWith({ store }));

  const response = await post(base, {
    CLOUDWALKER_URL: 'http://10.1.2.3:9100', CLOUDWALKER_API_TOKEN: 'token-abcdef',
    LLM_BASE_URL: 'http://10.1.2.3:9101/v1', LLM_API_KEY: 'key-abcdef', LLM_MODEL: 'schema-model'
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store'); // §3.6「200，Cache-Control: no-store」
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  const text = await response.text();
  for (const secret of ['token-abcdef', 'key-abcdef', FAKE_ENV.CLOUDWALKER_API_TOKEN, FAKE_ENV.LLM_API_KEY])
    assert.ok(!text.includes(secret), `200 正文里出现了机密原文：${secret}`);
  const body = JSON.parse(text);

  assert.deepEqual(Object.keys(body).sort(), ['config', 'updated']);
  assert.deepEqual(body.updated, ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
    'updated 是这次改了的键名，顺序同正文');

  const config = body.config;
  assert.deepEqual(Object.keys(config).sort(),
    ['auth', 'cloudwalker', 'host', 'missing_required', 'model', 'port', 'secrets', 'triage_input_mode'],
    'config 与 GET /api/config 同形状：八键恒在');
  assert.equal(typeof config.host, 'string');
  assert.ok(Number.isInteger(config.port));
  assert.ok(['syslog', 'poll'].includes(config.triage_input_mode));
  assert.deepEqual(Object.keys(config.cloudwalker), ['configured']);
  assert.equal(typeof config.cloudwalker.configured, 'boolean');
  // P003-T042：model 段多出 roles（五个角色各自 resolved 到谁）；configured / name 原样。
  assert.deepEqual(Object.keys(config.model).sort(), ['configured', 'name', 'roles']);
  assert.equal(typeof config.model.configured, 'boolean');
  assert.equal(config.model.name, 'schema-model');
  assert.deepEqual(Object.keys(config.auth), ['basic_auth_enabled']);
  assert.equal(typeof config.auth.basic_auth_enabled, 'boolean');
  assert.deepEqual(Object.keys(config.secrets).sort(),
    ['CLOUDWALKER_API_TOKEN', 'HIDS_BASIC_AUTH_PASSWORD', 'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN', 'LLM_API_KEY'],
    'secrets 五键恒在');
  for (const [key, value] of Object.entries(config.secrets))
    assert.equal(typeof value, 'boolean', `secrets.${key} 必须是布尔，实测 ${typeof value}`);
  assert.ok(Array.isArray(config.missing_required));
  for (const item of config.missing_required) assert.equal(typeof item, 'string');

  const get = await (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(5000) })).json();
  assert.deepEqual(get, config, '写后响应里的 config 与随即的 GET 是同一份生效值');

  // A5：一次成功写只落一条 config.updated，字段只有键名。
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'config.updated');
  assert.deepEqual(events[0].fields, { keys: body.updated });
});

test('A3：401 是纯文本四条头；配了口令后写与读都过闸门，凭据对了才 200', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const store = createConfigStore({ file, env: { ...FAKE_ENV } });
  const base = await listen(t, serverWith({ access: { user: 'ops', password: PASS }, store }));

  const denied = await post(base, { LLM_MODEL: 'gated-model' });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="HIDS AI Console", charset="UTF-8"');
  assert.match(denied.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await denied.json(), { error: '需要登录后访问', code: 'unauthorized' });
  assert.deepEqual(store.overrides(), {}, '没凭据的写一个字都不许落盘');

  const wrong = await post(base, { LLM_MODEL: 'gated-model' }, { Authorization: basic('wrong-password') });
  assert.equal(wrong.status, 401);

  const getDenied = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(5000) });
  assert.equal(getDenied.status, 401, 'GET /api/config 同样过 Basic 闸门');

  const allowed = await post(base, { LLM_MODEL: 'gated-model' }, { Authorization: basic() });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).config.model.name, 'gated-model');
});

test('边界与 400 矩阵：每条断言状态 + code + 原话，且被拒的写什么都不改', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config-overrides.json');
  const env = { ...FAKE_ENV };
  const store = createConfigStore({ file, env });
  const base = await listen(t, serverWith({ store }));

  // 文档 §3.6 错误表逐条。raw 直接给正文，好覆盖「不是 JSON / 不是对象 / 过大」。
  const cases = [
    ['not json at all', /请求正文不是 JSON/],
    ['null', /请求正文必须是 JSON 对象/],
    ['[]', /请求正文必须是 JSON 对象/],
    ['"a string"', /请求正文必须是 JSON 对象/],
    ['42', /请求正文必须是 JSON 对象/],
    ['{}', /请求正文没有可写的配置项/],
    ['{"HIDS_PORT":"9090"}', /配置项不可写：HIDS_PORT/],
    ['{"HIDS_TRIAGE_INPUT_MODE":"poll"}', /配置项不可写：HIDS_TRIAGE_INPUT_MODE/],
    ['{"HIDS_PROMPT_ADMIN_TOKEN":"x"}', /配置项不可写：HIDS_PROMPT_ADMIN_TOKEN/],
    ['{"HIDS_RULE_ADMIN_TOKEN":"x"}', /配置项不可写：HIDS_RULE_ADMIN_TOKEN/],
    ['{"LLM_MODEL":""}', /配置项取值必须是非空字符串：LLM_MODEL/],
    ['{"LLM_MODEL":"   "}', /配置项取值必须是非空字符串：LLM_MODEL/],
    ['{"LLM_MODEL":7}', /配置项取值必须是非空字符串：LLM_MODEL/],
    ['{"LLM_MODEL":null}', /配置项取值必须是非空字符串：LLM_MODEL/],
    ['{"LLM_MODEL":["x"]}', /配置项取值必须是非空字符串：LLM_MODEL/],
    ['{"LLM_MODEL":{"a":1}}', /配置项取值必须是非空字符串：LLM_MODEL/],
    ['{"LLM_BASE_URL":"ftp://secret-token-abcdef/v1"}', /LLM_BASE_URL/],
    ['{"CLOUDWALKER_URL":"10.0.0.1:9100"}', /CLOUDWALKER_URL/],
    ['{"CLOUDWALKER_API_TOKEN":"short"}', /CLOUDWALKER_API_TOKEN/],
    // readJSON 上限 8192（§9）：拼接后字符串长度超限 → 400「请求正文过大」。
    [`{"LLM_MODEL":"${'a'.repeat(9000)}"}`, /请求正文过大/]
  ];
  for (const [raw, pattern] of cases) {
    const body = await assertJsonError(await postRaw(base, raw), 400, pattern);
    assert.ok(!body.error.includes('secret-token-abcdef'), `错误正文回显了坏值：${body.error}`);
  }

  // 一次多键不可写：原话用「、」隔开，逐个点名。
  const multi = await assertJsonError(
    await postRaw(base, '{"HIDS_HOST":"0.0.0.0","HIDS_BASIC_AUTH_PASSWORD":"hunter2"}'), 400,
    /配置项不可写：HIDS_HOST、HIDS_BASIC_AUTH_PASSWORD|配置项不可写：HIDS_BASIC_AUTH_PASSWORD、HIDS_HOST/);
  assert.ok(!multi.error.includes('hunter2'), '错误正文回显了口令原文');

  // 被拒的写「什么都不变」：GET 仍是环境变量的生效值，覆盖层没落盘。
  const summary = await (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(summary.model.name, FAKE_ENV.LLM_MODEL);
  assert.deepEqual(summary.missing_required, []);
  assert.deepEqual(store.overrides(), {});
  assert.deepEqual((await readdir(dir)).filter(name => name !== '.'), [], '被拒的写不许在盘上留文件');
});

test('边界：值形状的下界放行（Token 恰 6 位、URL 最短 http://a）', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const store = createConfigStore({ file, env: { ...FAKE_ENV } });
  const base = await listen(t, serverWith({ store }));

  const response = await post(base, { CLOUDWALKER_API_TOKEN: 'abc123', CLOUDWALKER_URL: 'http://a' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.updated, ['CLOUDWALKER_API_TOKEN', 'CLOUDWALKER_URL']);
  assert.equal(body.config.cloudwalker.configured, true);
});

test('边界：校验对象是合并后的生效值——环境里缺一项时只改别的键也 400', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const env = { ...FAKE_ENV };
  delete env.LLM_API_KEY; // 进程里被启动闸门保证齐全；这里造缺件验证「合并后」这条口径
  const store = createConfigStore({ file, env });
  const base = await listen(t, serverWith({ store }));

  const body = await assertJsonError(await post(base, { LLM_MODEL: 'merged-model' }), 400, /LLM/);
  assert.ok(!body.error.includes('merged-model'), '错误正文回显了提交的值');
  const summary = await (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(summary.model.name, FAKE_ENV.LLM_MODEL, '被拒的写不许让 GET 报半套值');
  assert.equal(summary.model.configured, false);
});

test('500：落盘失败回 internal_error，正文不含异常原文，状态与覆盖层都不变', async t => {
  const dir = await tempDir(t);
  await chmod(dir, 0o500); // 目录不可写：tmp 文件写不进去
  t.after(() => chmod(dir, 0o700).catch(() => {}));
  const file = path.join(dir, 'config-overrides.json');
  const store = createConfigStore({ file, env: { ...FAKE_ENV } });
  const base = await listen(t, serverWith({ store }));

  const response = await post(base, { LLM_MODEL: 'never-written', LLM_API_KEY: 'never-written-key' });
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(text).code, 'internal_error');
  assert.equal(JSON.parse(text).error, '服务器内部错误');
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['code', 'error']);
  assert.ok(!/EACCES|EPERM|config-overrides|never-written/.test(text), `500 正文漏了异常原文或值：${text}`);

  await chmod(dir, 0o700);
  const summary = await (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(summary.model.name, FAKE_ENV.LLM_MODEL, '落盘失败时内存与 env 都不许变');
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp')), [], '失败路径不留临时文件');
});
