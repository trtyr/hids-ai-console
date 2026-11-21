// P003-T071：A19 权限矩阵（GET /api/session 的 permissions）与 A18 业务端可见升级包（GET /api/updates/packages）。
// A19 的判据是「矩阵说的和真守卫是同一件事」：每条矩阵项都发一次真请求，逐条对状态码。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { PromptStore } from '../../../src/contexts/knowledge/infrastructure/prompt-store.js';
import { UpdateStore, sealPackage } from '../../../src/contexts/dataops/infrastructure/update-store.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const PROMPT_TOKEN = 'matrix-prompt-token';
const RULE_TOKEN = 'matrix-rule-token';
const tokenHeaders = { 'X-Prompt-Admin-Token': PROMPT_TOKEN, 'X-Rule-Admin-Token': RULE_TOKEN };

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t071-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const prompts = new PromptStore(path.join(directory, 'prompt-overrides.json'));
  // wiki 维护会话用桩：只为证明守卫放行后能进 handler，不跑真 Agent。
  const wikiAgent = { list: async () => [], create: async page => ({ id: 'session-1', page: page ?? null }) };
  const server = createServer(null, null, null, null, prompts, null, null, {}, null,
    PROMPT_TOKEN, null, wikiAgent, null, RULE_TOKEN);
  return { directory, prompts, base: await listen(t, server) };
}

// 把矩阵里的模板路径换成真路径（参数只要形状合法，够走到守卫之后）。
const concretePath = path => path
  .replace('{alertId}', 'honeypot:1').replace('{action}', 'retry')
  .replace('{id}', 'honeypot_probe').replace('{section}', 'deep')
  .replace('{pagePath}', 'index.md');
const call = (base, action, headers = {}) => fetch(`${base}${concretePath(action.path)}`, {
  method: action.method, headers: { 'content-type': 'application/json', ...headers },
  body: action.method === 'GET' || action.method === 'DELETE' ? undefined : '{}'
});

test('A19 矩阵逐项与真守卫一致：每条动作都发一次真调用', async t => {
  const { base } = await setup(t);
  const anonymous = await (await fetch(`${base}/api/session`)).json();
  const { permissions } = anonymous;
  assert.ok(permissions.actions.length >= 14, '权限矩阵至少覆盖 14 个写动作');
  assert.equal(permissions.business_auth.enabled, false);
  assert.equal(permissions.business_auth.passed, true);
  assert.deepEqual(permissions.tokens['X-Prompt-Admin-Token'],
    { configured: true, supplied: false, valid: false });
  assert.equal(new Set(permissions.actions.map(item => item.action)).size, permissions.actions.length,
    '动作名不许重复');

  for (const action of permissions.actions) {
    assert.ok(action.requires.includes('business_auth'), `${action.action} 漏了 business_auth`);
    assert.equal(action.allowed, action.blocked_by === null, `${action.action} allowed 与 blocked_by 不自洽`);
    // 不带令牌：token 动作必须 403，矩阵也要说不能做；无 token 动作必须不是 403/401。
    const tokenAction = action.requires.some(item => item.endsWith('Token'));
    const tokenless = await call(base, action);
    assert.notEqual(tokenless.status, 401, `${action.action} 未带令牌却被要求登录`);
    if (tokenAction) {
      assert.equal(action.allowed, false, `${action.action} 未带令牌却标 allowed`);
      assert.equal(action.blocked_by, 'token_missing_or_invalid');
      assert.equal(tokenless.status, 403, `${action.action} 未带令牌没有 403`);
    } else {
      assert.equal(action.allowed, true, `${action.action} 不该被权限挡住`);
      assert.notEqual(tokenless.status, 403, `${action.action} 没带令牌却被 403`);
    }
  }

  // 带上两把令牌再问：全部动作 allowed，且每条真调用都不再 403
  const authorized = await (await fetch(`${base}/api/session`, { headers: tokenHeaders })).json();
  assert.deepEqual(authorized.permissions.tokens['X-Prompt-Admin-Token'],
    { configured: true, supplied: true, valid: true });
  assert.deepEqual(authorized.permissions.tokens['X-Rule-Admin-Token'],
    { configured: true, supplied: true, valid: true });
  for (const action of authorized.permissions.actions) {
    assert.equal(action.allowed, true, `${action.action} 带齐令牌后仍被挡：${action.blocked_by}`);
    const response = await call(base, action, tokenHeaders);
    assert.notEqual(response.status, 401, `${action.action} 带齐令牌仍要登录`);
    assert.notEqual(response.status, 403, `${action.action} 带齐令牌仍 403`);
  }
});

test('A19 没配令牌时矩阵标 token_not_configured，真调用回 503', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t071-notokens-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const server = createServer(null, null, null, null, new PromptStore(path.join(directory, 'p.json')),
    null, null, {}, null, null, null, null, null, null);
  const base = await listen(t, server);
  const { permissions } = await (await fetch(`${base}/api/session`)).json();
  const promptWrite = permissions.actions.find(item => item.action === 'prompt.write');
  assert.equal(promptWrite.allowed, false);
  assert.equal(promptWrite.blocked_by, 'token_not_configured');
  assert.equal((await call(base, promptWrite)).status, 503);
  assert.equal((await call(base, promptWrite, tokenHeaders)).status, 503, '服务端没配令牌，带什么头都不放行');
});

test('A18 业务端只读可安装包元数据：不含二进制、不需要密钥，应用后状态翻真', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t071-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const prompts = new PromptStore(path.join(directory, 'prompt-overrides.json'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const encryptionKey = randomBytes(32);
  // 不传 directory：默认就是 <prompt 文件目录>/update-packages，业务端 UpdateStore 也读同一处。
  const maintenance = new UpdateStore(prompts, { encryptionKey, publicKey, target: 'test-customer' });
  const snapshot = await prompts.snapshot();
  const payload = { type: 'hids-prompts', api_version: 1, target: 'test-customer',
    version: '26.11.007', sequence: 1, date: '2026-11-06', title: '策略更新',
    summary: '更新研判策略的公开说明', changes: { features: ['加入维护版本管理'], improvements: [], fixes: [] },
    ...snapshot, sections: { ...snapshot.sections, triage: '不可回显的提示词-CANARY' } };
  const staged = await maintenance.stage(sealPackage(payload, { privateKey, encryptionKey }), 'update.hids-policy');

  // 业务端进程没有密钥：UpdateStore 不配置也能列包（只读明文侧车）
  const businessStore = new UpdateStore(prompts);
  assert.equal(businessStore.configured, false);
  const server = createServer(null, null, null, null, prompts, null, null, {}, null);
  const base = await listen(t, server);
  const first = await fetch(`${base}/api/updates/packages`);
  assert.equal(first.status, 200);
  const text = await first.text();
  const listed = JSON.parse(text);
  assert.equal(listed.update_available, true);
  assert.equal(listed.packages.length, 1);
  assert.equal(listed.packages[0].id, staged.id);
  assert.equal(listed.packages[0].version, '26.11.007');
  assert.deepEqual(listed.packages[0].changes.features, ['加入维护版本管理']);
  assert.equal(listed.packages[0].applied, false);
  assert.equal(listed.packages[0].current, false);
  // 二进制与提示词正文一个字都不许出
  assert.doesNotMatch(text, /CANARY|ciphertext|envelope|signature|sections/);

  // 维护端应用后：applied/current 翻真，update_available 回落
  await maintenance.apply(staged.id, (await prompts.load()).revision, 'maintainer');
  const after = await (await fetch(`${base}/api/updates/packages`)).json();
  assert.equal(after.update_available, false);
  assert.equal(after.packages[0].applied, true);
  assert.equal(after.packages[0].current, true);
});
