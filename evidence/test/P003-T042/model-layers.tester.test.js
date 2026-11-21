// P003-T042 测试席（何东阳）黑盒验收：模型分层。
// 依据只有契约文本，不从实现里读答案：
//   openapi.yaml getConfig / writeConfig / ModelRoleResolved
//   docs/modules/http-api.md §3.5（model.roles 表 + 来源三态 + 机密口径）、§3.6（十一可写键 + 坏值点组内键名）
//   .env.example 的 LLM_REVIEW_* / LLM_LIGHT_* 注释（逐键回退、六个新键）
// 做法：真 HTTP（进程内 createServer + 假上游只当 socket 对端，不是被测逻辑）+ 真研判一轮；每条请求 5s 超时。
// 断言的是「契约说的行为」，不是「当前实现长什么样」：200 正文一律过 openapi 的 schema 校验（含 $ref 展开）。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';
import { createConfigStore } from '../../../config-store.js';
import { createModelRolesFromEnv, MODEL_ROLES } from '../../../src/contexts/triage/infrastructure/model-client.js';
import { createServer } from '../../../server.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ---------- 契约本体：openapi 只有一份，schema 校验与可写表都从它读 ----------
const OPENAPI = JSON.parse(execFileSync('python3', ['-c', `
import json, yaml
doc = yaml.safe_load(open(${JSON.stringify(path.join(ROOT, 'openapi.yaml'))}))
print(json.dumps(doc, ensure_ascii=False, default=str))
`], { encoding: 'utf8' }));
const CONFIG_SCHEMA = OPENAPI.paths['/api/config'].get.responses['200'].content['application/json'].schema;
const WRITE_SCHEMA = OPENAPI.paths['/api/config'].post.requestBody.content['application/json'].schema;
const WRITABLE = Object.keys(WRITE_SCHEMA.properties);
const ROLES = Object.keys(CONFIG_SCHEMA.properties.model.properties.roles.properties);

// openapi 只用了 type/enum/const/required/properties/items/$ref 这几种关键字；只实现这个子集。
function deref(schema) {
  let current = schema;
  const guard = new Set();
  while (current && current.$ref) {
    if (guard.has(current.$ref)) throw new Error(`schema $ref 自环：${current.$ref}`);
    guard.add(current.$ref);
    current = OPENAPI.components.schemas[current.$ref.split('/').pop()];
  }
  return current ?? {};
}
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
function schemaErrors(value, rawSchema, at = '$') {
  const schema = deref(rawSchema);
  const errors = [];
  if (schema.type) {
    const want = [].concat(schema.type);
    const got = typeOf(value);
    if (!want.some(t => t === got || (t === 'number' && got === 'integer')))
      errors.push(`${at}: 类型应为 ${want.join('|')}，实测 ${got}（${JSON.stringify(value)}）`);
  }
  if (schema.enum && !schema.enum.some(v => v === value))
    errors.push(`${at}: 取值必须落在 enum ${JSON.stringify(schema.enum)} 里，实测 ${JSON.stringify(value)}`);
  if ('const' in schema && value !== schema.const)
    errors.push(`${at}: 必须是 ${JSON.stringify(schema.const)}，实测 ${JSON.stringify(value)}`);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: 缺必填键 ${key}`);
    for (const [key, sub] of Object.entries(schema.properties ?? {}))
      if (key in value) errors.push(...schemaErrors(value[key], sub, `${at}.${key}`));
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items, `${at}[${i}]`)));
  return errors;
}
function assertConfigShape(body, label) {
  const errors = schemaErrors(body, CONFIG_SCHEMA);
  assert.deepEqual(errors, [], `${label}：正文不符合 openapi getConfig schema\n${errors.join('\n')}`);
  assert.deepEqual(Object.keys(body.model.roles).sort(), [...ROLES].sort(), `${label}：model.roles 五个角色恒在`);
  for (const role of ROLES)
    assert.deepEqual(Object.keys(body.model.roles[role]).sort(), ['model', 'source'], `${label}：roles.${role} 只报 {model, source}`);
}

// ---------- 假上游：只收 HTTP 请求，不当被测逻辑 ----------
const DEFAULT_REPLY = { verdict: '存疑', confidence: '低', summary: 'ok', claims: [], missing_data: [],
  assessment: 'supported', concerns: [], missing_evidence: [] };
async function upstream(t, label, reply = DEFAULT_REPLY) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = { raw }; }
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { label, seen, base: `http://127.0.0.1:${server.address().port}/v1`, reset: () => { seen.length = 0; } };
}

const PRIMARY = Object.freeze({ LLM_BASE_URL: 'http://main.example/v1', LLM_API_KEY: 'main-key-abcdef', LLM_MODEL: 'main-model' });
const REVIEW = Object.freeze({ LLM_REVIEW_BASE_URL: 'http://review.example/v1', LLM_REVIEW_API_KEY: 'review-key-abcdef', LLM_REVIEW_MODEL: 'review-model' });
const LIGHT = Object.freeze({ LLM_LIGHT_BASE_URL: 'http://light.example/v1', LLM_LIGHT_API_KEY: 'light-key-abcdef', LLM_LIGHT_MODEL: 'light-model' });
const GROUP_KIND = { triage: 'primary', review: 'review', rule_maintainer: 'light', wiki_maintainer: 'light', trace_board: 'light' };
const NEW_KEYS = [...Object.keys(REVIEW), ...Object.keys(LIGHT)];

// ---------- 进程内 createServer（config 在第 17 位；access 空对象＝不启用认证） ----------
const CONFIG_SLOT = 16;
function serverWith(store, access = {}) {
  const positional = new Array(CONFIG_SLOT + 1).fill(undefined);
  positional[7] = access;
  positional[CONFIG_SLOT] = store;
  return createServer(...positional);
}
async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-model-layers-tester-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
async function listenWith(t, store, access = {}) {
  const server = serverWith(store, access);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function serve(t, env, access) {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const store = createConfigStore({ file, env: { ...env }, journal: () => {} });
  const base = await listenWith(t, store, access);
  return { base, store, file };
}
const getJson = async (url, init = {}) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  return { response, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const post = (base, raw) => fetch(`${base}/api/config`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: typeof raw === 'string' ? raw : JSON.stringify(raw),
  signal: AbortSignal.timeout(5000) });

function assert400(response, text, pattern, label) {
  assert.equal(response.status, 400, `${label}：状态码`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/, `${label}：400 必须是 JSON 正文`);
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error'], `${label}：错误正文形状恒为 {error, code}`);
  assert.equal(body.code, 'caller_error', `${label}：code 应为 caller_error`);
  assert.match(body.error, pattern, `${label}：错误原话`);
  return body;
}

// ================================================================================================
// A1 逐键回退矩阵（真 HTTP 客户端层）：三组配置各自逐键回退，角色之间不串组
// ================================================================================================
// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A1 逐键回退矩阵：复核组 / 轻量组各三键的 8 种「设了哪几项」组合，地址·密钥·模型名逐字段回退', async t => {
  const main = await upstream(t, 'primary');
  const own = { review: await upstream(t, 'review'), light: await upstream(t, 'light') };

  // set 里的 BASE_URL 用 'own' 占位：这一组自己的地址；缺项按契约回退主判。
  const matrix = [
    { set: {}, want: { base: 'primary', key: PRIMARY.LLM_API_KEY, model: PRIMARY.LLM_MODEL } },
    { set: { BASE_URL: 'own' }, want: { base: 'own', key: PRIMARY.LLM_API_KEY, model: PRIMARY.LLM_MODEL } },
    { set: { API_KEY: 'own-key-abcdef' }, want: { base: 'primary', key: 'own-key-abcdef', model: PRIMARY.LLM_MODEL } },
    { set: { MODEL: 'own-model' }, want: { base: 'primary', key: PRIMARY.LLM_API_KEY, model: 'own-model' } },
    { set: { BASE_URL: 'own', API_KEY: 'own-key-abcdef' }, want: { base: 'own', key: 'own-key-abcdef', model: PRIMARY.LLM_MODEL } },
    { set: { API_KEY: 'own-key-abcdef', MODEL: 'own-model' }, want: { base: 'primary', key: 'own-key-abcdef', model: 'own-model' } },
    { set: { BASE_URL: 'own', MODEL: 'own-model' }, want: { base: 'own', key: PRIMARY.LLM_API_KEY, model: 'own-model' } },
    { set: { BASE_URL: 'own', API_KEY: 'own-key-abcdef', MODEL: 'own-model' }, want: { base: 'own', key: 'own-key-abcdef', model: 'own-model' } }
  ];

  // 两组各走一遍：复核组的「自己那组」是 review 上游，轻量组的是 light 上游。
  for (const [prefix, kind, roles] of [
    ['LLM_REVIEW_', 'review', ['review']],
    ['LLM_LIGHT_', 'light', ['rule_maintainer', 'wiki_maintainer', 'trace_board']]
  ]) {
    for (const row of matrix) {
      const extra = {};
      for (const [suffix, value] of Object.entries(row.set))
        extra[`${prefix}${suffix}`] = value === 'own' ? own[kind].base : value;
      const env = { ...PRIMARY, LLM_BASE_URL: main.base, ...extra };
      const models = createModelRolesFromEnv(env);
      const label = `${prefix}${JSON.stringify(row.set)}`;
      for (const flow of [main, own.review, own.light]) flow.reset();

      for (const role of roles) await models[role].complete([{ role: 'user', content: `probe-${label}-${role}` }]);

      const expected = row.want.base === 'primary' ? main : own[kind];
      const wrong = [main, own.review, own.light].filter(flow => flow !== expected && flow.seen.length > 0).map(flow => flow.label);
      assert.deepEqual(wrong, [], `${label}：请求打到了不该去的上游`);
      assert.equal(expected.seen.length, roles.length, `${label}：应只有目标上游收到 ${roles.length} 次请求`);
      for (const call of expected.seen) {
        assert.equal(call.url, '/v1/chat/completions', `${label}：模型调用走 <base>/chat/completions`);
        assert.equal(call.auth, `Bearer ${row.want.key}`, `${label}：密钥应逐键回退到 ${row.want.key}`);
        assert.equal(call.body.model, row.want.model, `${label}：模型名应逐键回退到 ${row.want.model}`);
      }
    }
  }
});

test('A1 model.roles 三态与逐字段实况一致（HTTP GET /api/config）', async t => {
  const cases = [
    { env: {}, label: '全空', configured: false,
      want: { triage: { model: null, source: 'primary' }, review: { model: null, source: 'primary' } } },
    { env: { LLM_MODEL: 'only-model' }, label: '主判只有模型名（不足以装配）', configured: false,
      want: { triage: { model: 'only-model', source: 'primary' }, review: { model: 'only-model', source: 'primary' } } },
    { env: { ...PRIMARY }, label: '只设主判三项', configured: true,
      want: Object.fromEntries(MODEL_ROLES.map(role => [role, { model: 'main-model', source: 'primary' }])) },
    { env: { ...PRIMARY, LLM_REVIEW_MODEL: 'r-model' }, label: '复核组只设模型名', configured: true,
      want: { triage: { model: 'main-model', source: 'primary' }, review: { model: 'r-model', source: 'mixed' },
        rule_maintainer: { model: 'main-model', source: 'primary' } } },
    { env: { ...PRIMARY, LLM_REVIEW_BASE_URL: 'http://review.example/v1' }, label: '复核组只设地址', configured: true,
      want: { review: { model: 'main-model', source: 'mixed' } } },
    { env: { ...PRIMARY, LLM_REVIEW_API_KEY: 'review-key-abcdef' }, label: '复核组只设密钥', configured: true,
      want: { review: { model: 'main-model', source: 'mixed' } } },
    { env: { ...PRIMARY, ...REVIEW }, label: '复核组三键全有', configured: true,
      want: { triage: { model: 'main-model', source: 'primary' }, review: { model: 'review-model', source: 'own' },
        rule_maintainer: { model: 'main-model', source: 'primary' } } },
    { env: { ...PRIMARY, ...LIGHT }, label: '轻量组三键全有', configured: true,
      want: Object.fromEntries(MODEL_ROLES.map(role => [role, GROUP_KIND[role] === 'light'
        ? { model: 'light-model', source: 'own' } : { model: 'main-model', source: 'primary' }])) },
    { env: { ...REVIEW, ...LIGHT }, label: '主判全空、两组自带值（不装配但照报）', configured: false,
      want: { triage: { model: null, source: 'primary' }, review: { model: 'review-model', source: 'own' },
        rule_maintainer: { model: 'light-model', source: 'own' } } },
    { env: { LLM_REVIEW_MODEL: 'x' }, label: '主判全空、只设复核模型名', configured: false,
      want: { triage: { model: null, source: 'primary' }, review: { model: 'x', source: 'mixed' },
        rule_maintainer: { model: null, source: 'primary' } } }
  ];
  for (const row of cases) {
    const { base } = await serve(t, row.env);
    const { response, json, text } = await getJson(`${base}/api/config`);
    assert.equal(response.status, 200, `${row.label}：GET /api/config 恒 200`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${row.label}：Cache-Control`);
    assert.ok(json && text.length > 0, `${row.label}：正文应是 JSON`);
    assertConfigShape(json, row.label);
    assert.equal(json.model.configured, row.configured, `${row.label}：model.configured`);
    for (const [role, want] of Object.entries(row.want))
      assert.deepEqual(json.model.roles[role], want, `${row.label}：roles.${role}`);
  }
});

// ================================================================================================
// A2 五实例互不相同 + 独立复核真走复核实例（真 HTTP 上游 + 真研判一轮）
// ================================================================================================
test('A2 五角色五个实例、各打各的上游；独立复核那一轮真走复核实例（不是研判实例）', async t => {
  const main = await upstream(t, 'primary');
  const review = await upstream(t, 'review');
  const light = await upstream(t, 'light');
  const env = { ...PRIMARY, ...REVIEW, ...LIGHT, LLM_BASE_URL: main.base, LLM_REVIEW_BASE_URL: review.base, LLM_LIGHT_BASE_URL: light.base };
  const models = createModelRolesFromEnv(env);
  assert.deepEqual(Object.keys(models).sort(), [...MODEL_ROLES].sort(), '五个角色各一个实例');
  assert.equal(new Set(MODEL_ROLES.map(role => models[role])).size, MODEL_ROLES.length, '五个实例互不相同（共用对象就不算各拿自己的）');

  // 每个角色真发一次：请求只落到它自己那组的上游，且带自己那组的模型名。
  for (const role of MODEL_ROLES) {
    for (const flow of [main, review, light]) flow.reset();
    await models[role].complete([{ role: 'user', content: `who-am-i-${role}` }]);
    const hits = [main, review, light].filter(flow => flow.seen.length > 0).map(flow => flow.label);
    assert.deepEqual(hits, [GROUP_KIND[role]], `${role} 应只打 ${GROUP_KIND[role]} 上游`);
    const ownName = GROUP_KIND[role] === 'primary' ? PRIMARY.LLM_MODEL : GROUP_KIND[role] === 'review' ? REVIEW.LLM_REVIEW_MODEL : LIGHT.LLM_LIGHT_MODEL;
    assert.equal([main, review, light].find(flow => flow.seen.length > 0).seen.at(-1).body.model, ownName, `${role} 应带自己的模型名`);
  }

  // 真研判一轮：假的只有 MCP 工具面；两个模型客户端都是真 HTTP 客户端。
  const conclusion = { verdict: '存疑', confidence: '低', summary: '需核查命令后续行为', claims: [], missing_data: [] };
  const triageUpstream = await upstream(t, 'triage-run', conclusion);
  const reviewUpstream = await upstream(t, 'review-run', { assessment: 'supported', concerns: [], missing_evidence: [] });
  const models2 = createModelRolesFromEnv({ ...PRIMARY, ...REVIEW, LLM_BASE_URL: triageUpstream.base,
    LLM_REVIEW_BASE_URL: reviewUpstream.base });
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7', cmdline: 'probe' })
  });
  const result = await new InvestigationAgent(toolbox, models2.triage, undefined, null, null, models2.review)
    .run('honeypot:7', { mode: 'triage' });

  assert.equal(reviewUpstream.seen.length, 1, `独立复核应恰好问复核上游一次，实测 ${reviewUpstream.seen.length}`);
  assert.equal(reviewUpstream.seen[0].body.model, 'review-model', '复核请求必须带复核组的模型名');
  assert.match(reviewUpstream.seen[0].raw, /独立质疑者/, '复核请求应是「独立质疑者」那一轮');
  assert.equal(triageUpstream.seen.some(call => /独立质疑者/.test(call.raw)), false, '研判上游不该收到复核提示词（复核那一轮换回研判实例这里就红）');
  assert.equal(result.review.assessment, 'supported', '结论里的 review 来自复核实例');
});

// ================================================================================================
// A3 机密只回布尔（两态）+ 正文不出现原文；POST 回显面同样干净
// ================================================================================================
const SECRET_VALUES = {
  CLOUDWALKER_API_TOKEN: 'fake-cw-token-abcdef',
  LLM_API_KEY: PRIMARY.LLM_API_KEY,
  HIDS_BASIC_AUTH_PASSWORD: 'fake-pass-abcdef',
  HIDS_PROMPT_ADMIN_TOKEN: 'fake-prompt-token-abcdef',
  HIDS_RULE_ADMIN_TOKEN: 'fake-rule-token-abcdef',
  LLM_REVIEW_API_KEY: REVIEW.LLM_REVIEW_API_KEY,
  LLM_LIGHT_API_KEY: LIGHT.LLM_LIGHT_API_KEY
};
const SECRETS_IN_BODY = ['CLOUDWALKER_API_TOKEN', 'LLM_API_KEY', 'HIDS_BASIC_AUTH_PASSWORD', 'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN'];

test('A3 机密只回布尔：配了的状态与没配的状态各测一遍，正文不出现任何密钥原文', async t => {
  // 配了：五个旧机密 + 新两组各一个密钥全部有值。
  const configured = await serve(t, { ...PRIMARY, ...REVIEW, ...LIGHT,
    CLOUDWALKER_URL: 'http://cw.example', CLOUDWALKER_API_TOKEN: SECRET_VALUES.CLOUDWALKER_API_TOKEN,
    HIDS_BASIC_AUTH_PASSWORD: SECRET_VALUES.HIDS_BASIC_AUTH_PASSWORD,
    HIDS_PROMPT_ADMIN_TOKEN: SECRET_VALUES.HIDS_PROMPT_ADMIN_TOKEN,
    HIDS_RULE_ADMIN_TOKEN: SECRET_VALUES.HIDS_RULE_ADMIN_TOKEN });
  let got = await getJson(`${configured.base}/api/config`);
  assert.equal(got.response.status, 200);
  assertConfigShape(got.json, '机密全配态');
  assert.deepEqual(Object.keys(got.json.secrets).sort(), [...SECRETS_IN_BODY].sort(), 'secrets 仍是那五个键：新两组的密钥不进 secrets');
  for (const [key, value] of Object.entries(got.json.secrets))
    assert.equal(typeof value, 'boolean', `secrets.${key} 必须是布尔，实测 ${typeof value}`);
  assert.deepEqual(Object.values(got.json.secrets), [true, true, true, true, true], '五个机密都配了 → 全 true（只报有没有）');
  for (const [key, value] of Object.entries(SECRET_VALUES))
    assert.equal(got.text.includes(value), false, `GET 正文里出现了 ${key} 的原文`);

  // 没配：全 false，model.roles 全 null/primary。
  const empty = await serve(t, {});
  got = await getJson(`${empty.base}/api/config`);
  assertConfigShape(got.json, '机密全空态');
  assert.deepEqual(Object.values(got.json.secrets), [false, false, false, false, false], '五个机密都没配 → 全 false');
  for (const role of MODEL_ROLES) assert.deepEqual(got.json.model.roles[role], { model: null, source: 'primary' });
  assert.equal(got.json.model.name, null);

  // 空白值算没配（与写配置「非空字符串」同一口径）：报 false。
  const blank = await serve(t, { ...PRIMARY, LLM_API_KEY: '' });
  got = await getJson(`${blank.base}/api/config`);
  assertConfigShape(got.json, '机密空串态');
  assert.equal(got.json.secrets.LLM_API_KEY, false, '空串算没配（§3.6「值必须是非空字符串」同一口径）');
});

test('A3 写配置的回显面：写进新两组密钥后，成功正文与错误正文都不出现原文', async t => {
  const { base, store } = await serve(t, { ...PRIMARY });
  const response = await post(base, { ...REVIEW, ...LIGHT });
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const value of [REVIEW.LLM_REVIEW_API_KEY, LIGHT.LLM_LIGHT_API_KEY])
    assert.equal(text.includes(value), false, `写成功正文里出现了密钥原文 ${value}`);
  const body = JSON.parse(text);
  assertConfigShape(body.config, '写成功的 config 快照');
  assert.deepEqual(body.config.secrets, {
    CLOUDWALKER_API_TOKEN: false, LLM_API_KEY: true, HIDS_BASIC_AUTH_PASSWORD: false,
    HIDS_PROMPT_ADMIN_TOKEN: false, HIDS_RULE_ADMIN_TOKEN: false
  }, 'secrets 只报有或没有，新两组密钥不改变 secrets 键集');
  assert.deepEqual(body.config.model.roles.review, { model: 'review-model', source: 'own' });
  assert.deepEqual(body.config.model.roles.trace_board, { model: 'light-model', source: 'own' });
  assert.deepEqual(Object.keys(store.overrides()).sort(), [...NEW_KEYS].sort(), '六个新键落进覆盖层');

  // 错误正文也不许回显坏值/其他键的原文。
  const bad = await post(base, { LLM_LIGHT_MODEL: 'still-secret-model', LLM_LIGHT_BASE_URL: 'ftp://still-secret-host' });
  const badText = await bad.text();
  assert400(bad, badText, /LLM_LIGHT_BASE_URL 必须是 HTTP\(S\) 地址/, '坏值错误');
  assert.equal(badText.includes('still-secret-model'), false, '错误正文回显了模型名原值');
  assert.equal(badText.includes('still-secret-host'), false, '错误正文回显了地址原值');
});

// ================================================================================================
// A4 .env.example 六键双向扫描 + openapi 契约解析
// ================================================================================================
test('A4 .env.example 六键双向扫描：新六键在、老五键在、键名不重复、头注键数与实际一致', async () => {
  const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const entries = example.split('\n').map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map(match => ({ key: match[1], value: match[2] }));
  const names = entries.map(entry => entry.key);
  assert.equal(new Set(names).size, names.length, `.env.example 有重复键名：${names.filter((k, i) => names.indexOf(k) !== i)}`);

  // 正向：新六键逐个在列，且是空值占位（凭据不进仓库）。
  for (const key of NEW_KEYS) {
    const found = entries.filter(entry => entry.key === key);
    assert.equal(found.length, 1, `.env.example 应恰好列一次 ${key}，实测 ${found.length}`);
    assert.equal(found[0].value, '', `${key} 在 .env.example 里不该带真值`);
  }
  // 老五键一个不丢。
  for (const key of Object.keys(PRIMARY)) assert.ok(names.includes(key), `.env.example 丢了老键名 ${key}`);
  // 头注写的键数必须与实际条目一致（数字漂了就是文档在骗人）。
  const claimed = example.match(/(\d+)\s*个键/);
  assert.ok(claimed, '头注要写明键的总数');
  assert.equal(Number(claimed[1]), names.length, `头注写 ${claimed[1]} 个键，实际 ${names.length} 条`);
  // 注释必须写清逐键回退与两个组的用途。
  const comments = example.split('\n').filter(line => line.startsWith('#')).join('\n');
  for (const prefix of ['LLM_REVIEW_', 'LLM_LIGHT_']) assert.ok(comments.includes(prefix), `注释里该点名 ${prefix}* 这一组`);
  assert.match(comments, /逐键/, '注释要写清「回退是逐键的」');
  assert.match(comments, /研判只用上面主判三项/, '注释要写清研判只用主判三项');
});

test('A4 openapi 契约：writeConfig 可写表十一项、getConfig roles 五键、ModelRoleResolved 约束与 API 对表', async t => {
  const writable = ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', ...NEW_KEYS];
  assert.deepEqual(WRITABLE, writable, 'openapi writeConfig 的可写表就是这十一项（顺序也照表）');
  assert.equal(WRITE_SCHEMA.minProperties, 1, '空正文在 openapi 里就是非法的（minProperties: 1）');
  assert.equal(WRITE_SCHEMA.additionalProperties, false, '表外键在 openapi 里就是非法的');
  const resolved = deref(OPENAPI.components.schemas.ModelRoleResolved);
  assert.deepEqual(resolved.required, ['model', 'source'], 'ModelRoleResolved 必填 model + source');
  assert.deepEqual(resolved.properties.source.enum, ['primary', 'own', 'mixed'], 'source 三态');

  // 双向：.env.example 里的每个 LLM_* 键，要么可写（200），要么在契约里明确不可写（400 点它名）。
  const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const llmKeys = example.split('\n').map(line => line.match(/^([A-Z0-9_]+)=/)).filter(Boolean)
    .map(match => match[1]).filter(key => key.startsWith('LLM_'));
  const { base } = await serve(t, { ...PRIMARY });
  const probe = { LLM_BASE_URL: 'http://probe.example/v1', LLM_REVIEW_BASE_URL: 'http://probe.example/v1',
    LLM_LIGHT_BASE_URL: 'http://probe.example/v1', LLM_API_KEY: 'probe-key-abcdef', LLM_REVIEW_API_KEY: 'probe-key-abcdef',
    LLM_LIGHT_API_KEY: 'probe-key-abcdef', LLM_MODEL: 'probe-model', LLM_REVIEW_MODEL: 'probe-model',
    LLM_LIGHT_MODEL: 'probe-model', LLM_TIMEOUT_MS: '1234' };
  for (const key of llmKeys) {
    assert.ok(key in probe, `本用例没有 ${key} 的探针值，先补探针再扫`);
    const response = await post(base, { [key]: probe[key] });
    const text = await response.text();
    if (WRITABLE.includes(key)) {
      assert.equal(response.status, 200, `${key} 在可写表里，探针写入应 200：${text.slice(0, 200)}`);
      assert.deepEqual(JSON.parse(text).updated, [key], `${key}：updated 只报这一项`);
    } else {
      assert400(response, text, new RegExp(`配置项不可写：${key}`), `.env.example 里的 ${key}`);
    }
  }
  // 反向：可写表的每一项都必须在 .env.example 里列出来（文档与接口同一个键集）。
  const listed = new Set(example.split('\n').map(line => line.match(/^([A-Z0-9_]+)=/)).filter(Boolean).map(match => match[1]));
  for (const key of WRITABLE) assert.ok(listed.has(key), `可写键 ${key} 没在 .env.example 里列出`);
});

// ================================================================================================
// A5 十一可写键 + 坏值点组内键名（HTTP）
// ================================================================================================
test('A5 十一可写键逐个写成功：200 + updated 顺序＝正文顺序 + 落盘 + 重启读回 + GET 立刻反映', async t => {
  const { base, store, file } = await serve(t, { ...PRIMARY, CLOUDWALKER_URL: 'http://cw.example:9100',
    CLOUDWALKER_API_TOKEN: 'cw-token-abcdef' });
  const values = {
    CLOUDWALKER_URL: 'http://cw.example:9100', CLOUDWALKER_API_TOKEN: 'cw-token-abcdef',
    LLM_BASE_URL: 'http://main.example/v1', LLM_API_KEY: 'main-key-abcdef', LLM_MODEL: 'main-model',
    ...REVIEW, ...LIGHT
  };
  // 逐个写：每个键单独一次 200，updated 只报它。
  for (const key of WRITABLE) {
    const response = await post(base, { [key]: values[key] });
    const text = await response.text();
    assert.equal(response.status, 200, `${key} 写成功应 200：${text.slice(0, 200)}`);
    assert.deepEqual(JSON.parse(text).updated, [key], `${key}：updated 只报它`);
  }
  // 一次写全 11 个：updated 顺序＝正文顺序（openapi writeConfig 200 契约）。
  const reverse = Object.fromEntries([...WRITABLE].reverse().map(key => [key, values[key]]));
  const all = await post(base, reverse);
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.deepEqual(allBody.updated, [...WRITABLE].reverse(), 'updated 顺序＝正文顺序');
  assertConfigShape(allBody.config, '一次写十一键的 config 快照');

  // 覆盖层落盘 11 键；重启（新 store 读同一个文件）仍生效。
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), [...WRITABLE].sort(), `覆盖层应存这十一项，实测 ${Object.keys(onDisk)}`);
  assert.deepEqual(Object.keys(store.overrides()).sort(), [...WRITABLE].sort(), 'store.overrides() 与盘上一致');
  const reopened = createConfigStore({ file, env: { ...PRIMARY }, journal: () => {} });
  const restarted = await listenWith(t, reopened);
  const after = await getJson(`${restarted}/api/config`);
  assertConfigShape(after.json, '重启后 GET');
  assert.deepEqual(after.json.model.roles.review, { model: 'review-model', source: 'own' }, '重启后复核组仍生效');
  assert.deepEqual(after.json.model.roles.trace_board, { model: 'light-model', source: 'own' }, '重启后轻量组仍生效');
  assert.equal(after.json.model.name, 'main-model');
  // GET 与写成功响应同形状同口径（openapi writeConfig 200 的描述）。
  assert.deepEqual(after.json, allBody.config, 'GET /api/config 与写成功响应里的 config 是同一份生效值');
});

test('A5 坏值点组内键名：十一个键各按形状下界判，错误原话必须点名真正要改的那个键', async t => {
  const { base } = await serve(t, { ...PRIMARY, CLOUDWALKER_URL: 'http://cw.example:9100',
    CLOUDWALKER_API_TOKEN: 'cw-token-abcdef' });
  const cases = [
    // URL 类：四个 *_BASE_URL 各点各的组名。
    [{ LLM_LIGHT_BASE_URL: 'ftp://x.example/v1' }, /^LLM_LIGHT_BASE_URL 必须是 HTTP\(S\) 地址$/],
    [{ LLM_REVIEW_BASE_URL: 'nginx://x.example/v1' }, /^LLM_REVIEW_BASE_URL 必须是 HTTP\(S\) 地址$/],
    [{ LLM_BASE_URL: 'main.example/v1' }, /^LLM_BASE_URL 必须是 HTTP\(S\) 地址$/],
    [{ CLOUDWALKER_URL: 'cw.example:9100' }, /^CLOUDWALKER_URL 必须是 HTTP\(S\) 地址$/],
    // Token 类：牧云 Token 至少 6 位。
    [{ CLOUDWALKER_API_TOKEN: 'short' }, /^CLOUDWALKER_API_TOKEN /],
    // 密钥 / 模型名：空串、空白串、非字符串都拒，点的是本组的键。
    [{ LLM_REVIEW_API_KEY: '' }, /^配置项取值必须是非空字符串：LLM_REVIEW_API_KEY$/],
    [{ LLM_LIGHT_API_KEY: '   ' }, /^配置项取值必须是非空字符串：LLM_LIGHT_API_KEY$/],
    [{ LLM_API_KEY: 7 }, /^配置项取值必须是非空字符串：LLM_API_KEY$/],
    [{ LLM_LIGHT_MODEL: '' }, /^配置项取值必须是非空字符串：LLM_LIGHT_MODEL$/],
    [{ LLM_REVIEW_MODEL: { a: 1 } }, /^配置项取值必须是非空字符串：LLM_REVIEW_MODEL$/],
    [{ LLM_MODEL: null }, /^配置项取值必须是非空字符串：LLM_MODEL$/],
    // 表外键照旧 400（新键进表不等于表被拆了）。
    [{ HIDS_PORT: '9090' }, /^配置项不可写：HIDS_PORT$/]
  ];
  for (const [patch, pattern] of cases) {
    const response = await post(base, patch);
    const text = await response.text();
    const label = JSON.stringify(patch);
    const body = assert400(response, text, pattern, label);
    // 「点组内键名」的反面：新两组的坏值不许笼统地报主判键名。
    const key = Object.keys(patch)[0];
    if (key.startsWith('LLM_REVIEW_') || key.startsWith('LLM_LIGHT_'))
      assert.equal(body.error.includes('LLM_BASE_URL') || /：LLM_API_KEY$|：LLM_MODEL$/.test(body.error), false,
        `${label}：错误原话串到了主判键名：${body.error}`);
  }

  // 「回退来的字段出问题才点主判键名」：环境里主判地址本来就是坏的，只写复核模型名 → 该点 LLM_BASE_URL。
  const broken = await serve(t, { ...PRIMARY, LLM_BASE_URL: 'ftp://broken.example/v1',
    CLOUDWALKER_URL: 'http://cw.example:9100', CLOUDWALKER_API_TOKEN: 'cw-token-abcdef' });
  const response = await post(broken.base, { LLM_REVIEW_MODEL: 'x' });
  const text = await response.text();
  assert400(response, text, /^LLM_BASE_URL 必须是 HTTP\(S\) 地址$/, '回退字段坏了');
});

test('A5 写配置的错误码面：400 四类正文 + 401 JSON 四条头 + 500 不外泄异常（P003-T073 起 401 为 {error, code}）', async t => {
  const { base } = await serve(t, { ...PRIMARY });
  const raws = [
    ['not json at all', /请求正文不是 JSON/],
    ['null', /请求正文必须是 JSON 对象/],
    ['[]', /请求正文必须是 JSON 对象/],
    ['{}', /请求正文没有可写的配置项/]
  ];
  for (const [raw, pattern] of raws) {
    const response = await post(base, raw);
    assert400(response, await response.text(), pattern, `正文 ${raw}`);
  }

  // 401：配了口令后，GET 与 POST 都过 Basic 闸门，401 是 JSON 四条头（P003-T073）。
  const gated = await serve(t, { ...PRIMARY }, { user: 'ops', password: 'gate-pass-abcdef' });
  for (const [label, call] of [
    ['GET', () => getJson(`${gated.base}/api/config`)],
    ['POST', () => post(gated.base, { LLM_MODEL: 'gated-model' }).then(async response => ({ response, text: await response.text() }))]
  ]) {
    const { response, text } = await call();
    assert.equal(response.status, 401, `${label} 未带凭据应 401`);
    assert.equal(response.headers.get('www-authenticate'), 'Basic realm="HIDS AI Console", charset="UTF-8"');
    assert.match(response.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(JSON.parse(text).error, '需要登录后访问');
  }

  // 500：落盘失败（数据根不可写）→ internal_error，正文不带异常原文，值与覆盖层都不变。
  const dir = await tempDir(t);
  await chmod(dir, 0o500);
  t.after(() => chmod(dir, 0o700).catch(() => {}));
  const store = createConfigStore({ file: path.join(dir, 'config-overrides.json'), env: { ...PRIMARY }, journal: () => {} });
  const failingBase = await listenWith(t, store);
  const response = await post(failingBase, { LLM_MODEL: 'never-written', LLM_LIGHT_MODEL: 'never-written-light' });
  const text = await response.text();
  assert.equal(response.status, 500, `落盘失败应 500，实测 ${response.status}：${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
  assert.equal(body.code, 'internal_error');
  assert.equal(body.error, '服务器内部错误');
  assert.equal(/EACCES|EPERM|never-written|config-overrides/.test(text), false, `500 正文漏了异常原文或值：${text}`);
  const after = await getJson(`${failingBase}/api/config`);
  assert.equal(after.json.model.name, PRIMARY.LLM_MODEL, '落盘失败时生效值不许变');
});
