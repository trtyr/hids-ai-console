// P003-T042：模型分层——研判 / 独立复核 / 两个维护者 / 溯源白板 各用各的配置。
// 口径见 .env.example 的 LLM_REVIEW_* / LLM_LIGHT_* 注释、openapi.yaml 的 getConfig `model.roles`、
// docs/modules/http-api.md §3.5/§3.6：
//   A1 两组新键（复核组 LLM_REVIEW_*、轻量组 LLM_LIGHT_*），缺省逐键回退主判三项；主判不全则五个实例都不建
//   A2 五个角色各一个实例（研判 / 独立复核 / 规则维护者 / wiki 维护者 / 溯源白板）；独立复核那一轮真的走复核实例
//   A3 GET /api/config 的 model.roles 报各角色 resolved 到的模型名与来源三态，机密仍只回布尔
//   A4 .env.example 列全六键且注释写明回退；不设新键时结论与分层前一致
//   A5 POST /api/config 可写六键（既有覆盖层），坏值报错点组内键名
// 全部替身：假 fetcher / 假 env / 临时目录，不碰真实网络与真实 process.env。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { BoardStore } from '../../../src/contexts/trace/infrastructure/board-store.js';
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';
import { createServer, applyLiveConfig, configSummary } from '../../../server.js';
import { RegoRuleMaintainer } from '../../../server.js';
import { createConfigStore, WRITABLE_CONFIG_KEYS } from '../../../src/contexts/dataops/infrastructure/config-store.js';
import { WikiWorkbench } from '../../../src/contexts/maintenance/application/wiki-workbench.js';
import { TraceBoardService } from '../../../src/contexts/trace/application/trace-service.js';;
import { createModelRolesFromEnv, modelRoleSummary, MODEL_ROLES,
  MODEL_ROLE_GROUPS } from '../../../src/contexts/triage/infrastructure/model-client.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 三组值刻意不同名同址：任何角色串组（拿了别人那组）都会在断言里露出来。
const PRIMARY = Object.freeze({ LLM_BASE_URL: 'http://main.test/v1', LLM_API_KEY: 'main-key-abcdef', LLM_MODEL: 'main-model' });
const REVIEW = Object.freeze({ LLM_REVIEW_BASE_URL: 'http://review.test/v1', LLM_REVIEW_API_KEY: 'review-key-abcdef',
  LLM_REVIEW_MODEL: 'review-model' });
const LIGHT = Object.freeze({ LLM_LIGHT_BASE_URL: 'http://light.test/v1', LLM_LIGHT_API_KEY: 'light-key-abcdef',
  LLM_LIGHT_MODEL: 'light-model' });
const NEW_KEYS = [...Object.keys(REVIEW), ...Object.keys(LIGHT)];

const endpoint = base => `${base.replace(/\/$/, '')}/chat/completions`;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-model-layers-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// createServer 是一串位置参数，config 在第 16 位：补到那一位再传，中间一律 undefined（走各自缺省）。
function serverWith(store) {
  const positional = new Array(17).fill(undefined);
  positional[7] = {}; // access：没配口令 → 放行
  positional[16] = store;
  return createServer(...positional);
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function post(base, patch) {
  return fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch) });
}

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A1 只设主判三项：五个角色逐键回退主判，地址与模型名与分层前一致', () => {
  const env = { ...PRIMARY };
  const summary = modelRoleSummary(env);
  assert.deepEqual(Object.keys(summary), [...MODEL_ROLES]);
  for (const role of MODEL_ROLES)
    assert.deepEqual(summary[role], { model: 'main-model', source: 'primary' }, `${role} 应完全回退主判`);

  const models = createModelRolesFromEnv(env);
  for (const role of MODEL_ROLES) {
    assert.equal(models[role].url.href, endpoint(PRIMARY.LLM_BASE_URL), `${role} 的地址应回退主判`);
    assert.equal(models[role].apiKey, PRIMARY.LLM_API_KEY, `${role} 的密钥应回退主判`);
    assert.equal(models[role].model, 'main-model', `${role} 的模型名应回退主判`);
  }
  assert.equal(new Set(MODEL_ROLES.map(role => models[role])).size, MODEL_ROLES.length,
    '五个角色各一个实例（共用一个对象就不算「各拿自己的」）');
  assert.deepEqual(MODEL_ROLE_GROUPS, { triage: 'primary', review: 'review',
    rule_maintainer: 'light', wiki_maintainer: 'light', trace_board: 'light' }, '角色→配置组的映射是契约');
});

test('A1 复核组自成一组：独立复核用自己的地址与模型名，其余角色仍走主判', () => {
  const env = { ...PRIMARY, ...REVIEW };
  const summary = modelRoleSummary(env);
  assert.deepEqual(summary.review, { model: 'review-model', source: 'own' });
  for (const role of ['triage', 'rule_maintainer', 'wiki_maintainer', 'trace_board'])
    assert.equal(summary[role].model, 'main-model', `${role} 不该被复核组带走`);

  const models = createModelRolesFromEnv(env);
  assert.equal(models.review.url.href, endpoint(REVIEW.LLM_REVIEW_BASE_URL));
  assert.equal(models.review.apiKey, REVIEW.LLM_REVIEW_API_KEY);
  assert.equal(models.review.model, 'review-model');
  assert.equal(models.triage.url.href, endpoint(PRIMARY.LLM_BASE_URL), '研判不该用复核组地址');
});

test('A1 复核组只设一部分：逐键回退——空的那几项用主判，设了的那项用自己的', () => {
  const env = { ...PRIMARY, LLM_REVIEW_MODEL: 'review-only-model' };
  assert.deepEqual(modelRoleSummary(env).review, { model: 'review-only-model', source: 'mixed' });
  const models = createModelRolesFromEnv(env);
  assert.equal(models.review.model, 'review-only-model', '设了的那项用复核组');
  assert.equal(models.review.url.href, endpoint(PRIMARY.LLM_BASE_URL), '没设的地址回退主判');
  assert.equal(models.review.apiKey, PRIMARY.LLM_API_KEY, '没设的密钥回退主判');

  // 纯空白算「没设」（与 config-store 的非空字符串同一口径）。
  const blank = { ...PRIMARY, LLM_REVIEW_MODEL: '  ', LLM_LIGHT_BASE_URL: '' };
  assert.deepEqual(modelRoleSummary(blank).review, { model: 'main-model', source: 'primary' });
  assert.deepEqual(modelRoleSummary(blank).trace_board, { model: 'main-model', source: 'primary' });
});

test('A2 轻量组：规则维护者 / wiki 维护者 / 溯源白板各拿自己的实例，独立复核不受影响', () => {
  const env = { ...PRIMARY, ...LIGHT };
  const summary = modelRoleSummary(env);
  for (const role of ['rule_maintainer', 'wiki_maintainer', 'trace_board'])
    assert.deepEqual(summary[role], { model: 'light-model', source: 'own' }, `${role} 应吃轻量组`);
  assert.deepEqual(summary.review, { model: 'main-model', source: 'primary' }, '没设复核组时复核回退主判');

  const models = createModelRolesFromEnv(env);
  const lightRoles = ['rule_maintainer', 'wiki_maintainer', 'trace_board'];
  for (const role of lightRoles) {
    assert.equal(models[role].url.href, endpoint(LIGHT.LLM_LIGHT_BASE_URL), `${role} 应吃轻量组地址`);
    assert.equal(models[role].model, 'light-model');
  }
  assert.equal(new Set(lightRoles.map(role => models[role])).size, lightRoles.length,
    '两个维护者与白板不能共用同一个对象');
  assert.equal(models.review.model, 'main-model', '复核角色不该吃轻量组');

  // 三个消费者真的收下各自的实例（不是只拿到模型名，也不是拿错角色）。
  const prompts = { load: async () => ({ prompts: {} }) };
  assert.equal(new RegoRuleMaintainer(models.rule_maintainer, null, prompts).model, models.rule_maintainer);
  assert.equal(new WikiWorkbench(null, models.wiki_maintainer, prompts, 'x').model, models.wiki_maintainer);
  assert.equal(new TraceBoardService({ store: new BoardStore('x'), toolbox: null, model: models.trace_board, directory: 'x' }).model,
    models.trace_board);
});

test('A1 主判三项不齐：五个实例都不建（与分层前 model=null 同一判据）', () => {
  assert.equal(createModelRolesFromEnv({}), null);
  assert.equal(createModelRolesFromEnv({ ...PRIMARY, LLM_MODEL: '' }), null);
  assert.equal(createModelRolesFromEnv({ ...PRIMARY, LLM_API_KEY: '  ' }), null);
  // 只有新组齐、主判缺：也建不出来（回退链断在主判）。
  assert.equal(createModelRolesFromEnv({ ...REVIEW, ...LIGHT }), null);
  // 主判齐了，新组怎么填都建得出来（逐键回退兜底）。
  assert.equal(Object.keys(createModelRolesFromEnv({ ...PRIMARY, ...REVIEW, ...LIGHT })).length, MODEL_ROLES.length);
});

test('A1 超时五个角色共用 LLM_TIMEOUT_MS，不新开超时键', () => {
  const models = createModelRolesFromEnv({ ...PRIMARY, ...REVIEW, ...LIGHT, LLM_TIMEOUT_MS: '12345' });
  for (const role of MODEL_ROLES) assert.equal(models[role].timeoutMs, 12345, `${role} 应共用 LLM_TIMEOUT_MS`);
  const fallback = createModelRolesFromEnv({ ...PRIMARY, LLM_TIMEOUT_MS: 'oops' });
  assert.equal(fallback.triage.timeoutMs, 90000, '非法值仍回落 90000（与分层前一致）');
});

// 独立复核那一轮：给研判与复核两个替身，只有复核替身会看到「独立质疑者」提示词。
test('A2 独立复核那一轮真的走复核实例（不是研判实例）', async () => {
  const reviewCalls = [];
  const triageCalls = [];
  const conclusion = { verdict: '存疑', confidence: '低', summary: '需核查命令后续行为',
    claims: [], missing_data: [] };
  const triageModel = { model: 'main-model', complete: async messages => {
    triageCalls.push(messages);
    return { content: JSON.stringify(conclusion) };
  } };
  const reviewModel = { model: 'review-model', complete: async messages => {
    reviewCalls.push(messages);
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, source_ip: '192.0.2.7', cmdline: 'probe' })
  });
  const result = await new InvestigationAgent(toolbox, triageModel, undefined, null, null, reviewModel)
    .run('honeypot:7', { mode: 'triage' });

  assert.equal(reviewCalls.length, 1, `复核轮应只问复核实例一次，实测 ${reviewCalls.length} 次`);
  assert.match(reviewCalls[0][0].content, /独立质疑者/, '复核请求应落到复核实例');
  assert.equal(triageCalls.some(messages => messages.some(item => /独立质疑者/.test(item.content))), false,
    '研判实例不该收到复核提示词（换回 this.model 这里就红）');
  assert.equal(result.review.assessment, 'supported', '结论里的 review 应来自复核实例');
});

test('A2/A5 applyLiveConfig：主判改了回退角色跟着动，自有组只认自己那组', () => {
  const before = { ...PRIMARY, ...REVIEW };
  const models = createModelRolesFromEnv(before);
  const after = { ...PRIMARY, LLM_BASE_URL: 'http://main2.test/v1', LLM_API_KEY: 'main2-key-abcdef', LLM_MODEL: 'main2-model',
    ...REVIEW, LLM_REVIEW_BASE_URL: 'http://review2.test/v1', LLM_REVIEW_API_KEY: 'review2-key-abcdef', LLM_REVIEW_MODEL: 'review2-model' };
  applyLiveConfig({ models }, after);

  assert.equal(models.triage.url.href, endpoint('http://main2.test/v1'));
  assert.equal(models.triage.model, 'main2-model');
  for (const role of ['rule_maintainer', 'wiki_maintainer', 'trace_board']) {
    assert.equal(models[role].url.href, endpoint('http://main2.test/v1'), `${role} 回退主判，应与主判一起动`);
    assert.equal(models[role].model, 'main2-model');
  }
  assert.equal(models.review.url.href, endpoint('http://review2.test/v1'), '自有组不该被主判覆盖');
  assert.equal(models.review.model, 'review2-model');

  // 把复核组清掉：重新解析后复核回退主判——证明是「重新解析」而不是「只改主判三项」。
  applyLiveConfig({ models }, { ...after, LLM_REVIEW_BASE_URL: null, LLM_REVIEW_API_KEY: null, LLM_REVIEW_MODEL: null });
  assert.equal(models.review.url.href, endpoint('http://main2.test/v1'));
  assert.equal(models.review.model, 'main2-model');
  assert.equal(Object.keys(applyLiveConfig({ models }, {})).length, 1, 'targets 原样返回');
});

test('A3 GET /api/config 的 model.roles 反映分层，机密仍只回布尔', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const env = { ...PRIMARY, ...REVIEW, ...LIGHT, HIDS_BASIC_AUTH_PASSWORD: 'gate-pass-abcdef' };
  const base = await listen(t, serverWith(createConfigStore({ file, env, journal: () => {} })));

  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);

  assert.deepEqual(Object.keys(body.model).sort(), ['configured', 'name', 'roles'],
    'model 段只多一个 roles，configured/name 语义不变');
  assert.equal(body.model.configured, true);
  assert.equal(body.model.name, 'main-model', 'model.name 仍是主判模型名（老读者照旧）');
  assert.deepEqual(body.model.roles.review, { model: 'review-model', source: 'own' });
  assert.deepEqual(body.model.roles.trace_board, { model: 'light-model', source: 'own' });
  assert.deepEqual(body.model.roles.triage, { model: 'main-model', source: 'primary' });
  assert.deepEqual(Object.keys(body.model.roles), [...MODEL_ROLES]);

  // 机密口径不变：secrets 仍是那五个键（新组密钥不进），正文里不出现任何密钥原文。
  assert.deepEqual(Object.keys(body.secrets).sort(),
    ['CLOUDWALKER_API_TOKEN', 'HIDS_BASIC_AUTH_PASSWORD', 'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN', 'LLM_API_KEY']);
  for (const secret of [PRIMARY.LLM_API_KEY, REVIEW.LLM_REVIEW_API_KEY, LIGHT.LLM_LIGHT_API_KEY, 'gate-pass-abcdef'])
    assert.equal(text.includes(secret), false, `正文里出现了密钥原文 ${secret}`);

  // 主判三项不齐：五个实例都不装配、model.configured=false，但 roles 仍按 env 逐键解析照报（§3.5 契约句）。
  const missing = configSummary({}).model;
  assert.equal(missing.configured, false);
  assert.equal(missing.name, null);
  for (const role of MODEL_ROLES)
    assert.deepEqual(missing.roles[role], { model: null, source: 'primary' }, `${role} 未配应为 null`);
  assert.equal(createModelRolesFromEnv({}), null, '主判三项不齐时五个实例都不装配');

  // 主判不齐 + 角色自带模型名：报自己的名字，不许抹成 null；source 按实情（三键全有 own、只设模型名 mixed）。
  const reviewOwn = configSummary({ ...REVIEW }).model;
  assert.equal(reviewOwn.configured, false, 'configured 仍是主判三项的口径');
  assert.equal(reviewOwn.name, null);
  assert.deepEqual(reviewOwn.roles.review, { model: 'review-model', source: 'own' });
  assert.equal(createModelRolesFromEnv({ ...REVIEW }), null, '没有地址/密钥回退时仍不装配实例');
  const reviewMixed = configSummary({ LLM_REVIEW_MODEL: 'x' }).model;
  assert.deepEqual(reviewMixed.roles.review, { model: 'x', source: 'mixed' },
    '主判不齐但复核组自带模型名：报自己的名字');
  assert.deepEqual(reviewMixed.roles.triage, { model: null, source: 'primary' }, '研判没有可报的名字');
});

test('A5 POST /api/config 可写新六键：落盘、GET 立刻反映、坏值点组内键名', async t => {
  const file = path.join(await tempDir(t), 'config-overrides.json');
  const env = { ...PRIMARY };
  const store = createConfigStore({ file, env, journal: () => {} });
  const base = await listen(t, serverWith(store));

  const written = await post(base, { ...REVIEW, ...LIGHT, LLM_REVIEW_API_KEY: 'review-secret-abcdef' });
  assert.equal(written.status, 200);
  const writtenText = await written.text();
  assert.equal(writtenText.includes('review-secret-abcdef'), false, '写成功的正文不回显密钥原文');
  const body = JSON.parse(writtenText);
  assert.deepEqual(body.updated, [...NEW_KEYS], '一次写六个键，顺序＝正文顺序');
  assert.deepEqual(body.config.model.roles.review, { model: 'review-model', source: 'own' });
  assert.deepEqual(body.config.model.roles.rule_maintainer, { model: 'light-model', source: 'own' });

  // 覆盖层只存改过的键，六键都在里面，重启读回（新建 store 同一个文件）。
  assert.deepEqual(Object.keys(store.overrides()).sort(), [...NEW_KEYS].sort());
  const reopened = createConfigStore({ file, env: { ...PRIMARY }, journal: () => {} });
  assert.equal(reopened.values().LLM_REVIEW_MODEL, 'review-model');
  assert.deepEqual(reopened.values().LLM_LIGHT_API_KEY, 'light-key-abcdef');

  // 部分写：只改复核模型名 → 200，另外两项仍回退主判。
  const partial = await (await post(base, { LLM_REVIEW_MODEL: 'review-model-2' })).json();
  assert.deepEqual(partial.updated, ['LLM_REVIEW_MODEL']);
  assert.deepEqual(partial.config.model.roles.review, { model: 'review-model-2', source: 'own' },
    '复核组三个键先前都已落盘：只改模型名，来源仍是自己那组');

  // 坏值：构造器判，但报错要点名这一组真正的键（不是 LLM_BASE_URL）。
  const bad = await post(base, { LLM_LIGHT_BASE_URL: 'ftp://light.test/v1' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /LLM_LIGHT_BASE_URL/, '报错应点轻量组的键名');

  // 表外键照旧 400（新键进表不等于表被拆了）。
  const outside = await post(base, { HIDS_PORT: '9090' });
  assert.equal(outside.status, 400);
  assert.match((await outside.json()).error, /配置项不可写：HIDS_PORT/);
  // P003-T084：能力参数与预算六键进表 → 十七项（只增不改）。
  assert.deepEqual([...WRITABLE_CONFIG_KEYS], ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN',
    'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', ...NEW_KEYS,
    'LLM_TEMPERATURE', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS',
    'HIDS_AGENT_MAX_TURNS', 'HIDS_AGENT_MAX_TOOL_CALLS', 'HIDS_AGENT_CONCLUSION_RETRIES'],
  '可写表就是这十七项');
});

test('A4 .env.example 列全新六键、注释写明逐键回退，老键一个不丢', async () => {
  const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const listed = new Set(example.split('\n').filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]));
  for (const key of NEW_KEYS) assert.ok(listed.has(key), `.env.example 少了 ${key}`);
  for (const key of Object.keys(PRIMARY)) assert.ok(listed.has(key), `.env.example 丢了老键名 ${key}`);
  // P003-T045 加日志落盘三键、P003-T072 加总量上限一键后全集 48；再加键时这里跟 .env.example 头注一起改。
  assert.equal(listed.size, 54, `.env.example 的键数应与代码读的键数一致，实测 ${listed.size}`);
  assert.match(example, /54 个键/, '头部键数说明要跟上');

  const comments = example.split('\n').filter(line => line.startsWith('#')).join('\n');
  for (const prefix of ['LLM_REVIEW_', 'LLM_LIGHT_']) assert.ok(comments.includes(prefix), `注释里该点名 ${prefix}* 这一组`);
  assert.match(comments, /回退/, '注释要写清缺省回退主判模型');
});
