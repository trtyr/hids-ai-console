// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, configSummary } from '../../../server.js';
import { createConfigStore, WRITABLE_CONFIG_KEYS, NUMERIC_CONFIG_KEYS } from '../../../src/contexts/dataops/infrastructure/config-store.js';
import { ChatModelClient } from '../../../src/contexts/triage/infrastructure/model-client.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const BASE = { LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'sk-1', LLM_MODEL: 'm1' };

test('T084 模型能力参数：temperature / max_tokens 可配，缺省与现状一致', () => {
  const plain = new ChatModelClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' });
  assert.equal(plain.temperature, 0, '缺省温度仍是 0（分层前行为）');
  assert.equal(plain.maxTokens, null, '缺省不传 max_tokens');
  const tuned = new ChatModelClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
    temperature: 0.3, maxTokens: 4096, timeoutMs: 5000 });
  assert.equal(tuned.temperature, 0.3);
  assert.equal(tuned.maxTokens, 4096);
  assert.equal(tuned.timeoutMs, 5000);
  // 非法值回落缺省，不崩
  const bad = new ChatModelClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
    temperature: 'x', maxTokens: -5 });
  assert.equal(bad.temperature, 0);
  assert.equal(bad.maxTokens, null);
});

test('T084 可写配置表扩到 17 键，数值键有取值域且越界 400', async t => {
  assert.equal(WRITABLE_CONFIG_KEYS.length, 17);
  for (const key of ['LLM_TEMPERATURE', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS',
    'HIDS_AGENT_MAX_TURNS', 'HIDS_AGENT_MAX_TOOL_CALLS', 'HIDS_AGENT_CONCLUSION_RETRIES'])
    assert.ok(WRITABLE_CONFIG_KEYS.includes(key), `可写表缺 ${key}`);
  assert.equal(Object.keys(NUMERIC_CONFIG_KEYS).length, 6);

  const dir = await mkdtemp(path.join(tmpdir(), 'hids-t084-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configStore = createConfigStore({ file: path.join(dir, 'config-overrides.json'), env: { ...BASE } });
  const base = await (await import('node:http')).default; // keep import shape simple
  const server = createServer(null, null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, configStore);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/config`;
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  // 合法值
  assert.equal((await post({ LLM_TEMPERATURE: '0.7', HIDS_AGENT_MAX_TURNS: '10' })).status, 200);
  assert.equal(configStore.env.LLM_TEMPERATURE, '0.7');
  assert.equal(configStore.env.HIDS_AGENT_MAX_TURNS, '10');
  // 越界 / 非整数 / 非数
  for (const [key, value] of [['LLM_TEMPERATURE', '3'], ['LLM_MAX_TOKENS', '0'],
    ['HIDS_AGENT_MAX_TURNS', '1.5'], ['LLM_TIMEOUT_MS', 'abc'], ['HIDS_AGENT_MAX_TURNS', '999']]) {
    const response = await post({ [key]: value });
    assert.equal(response.status, 400, `${key}=${value} 应回 400`);
    assert.match((await response.json()).error, /取值必须在/);
  }
});

test('T084 B05 配置来源可见：override / env / default 三态', () => {
  const scoped = configSummary({ ...BASE, CLOUDWALKER_URL: 'http://cw', CLOUDWALKER_API_TOKEN: 't' }, { LLM_MODEL: 'x' });
  assert.equal(scoped.sources.LLM_MODEL, 'override', '覆盖层里的键标 override');
  assert.equal(scoped.sources.LLM_BASE_URL, 'env', '环境变量里的键标 env');
  assert.equal(scoped.sources.HIDS_BASIC_AUTH_PASSWORD, 'default', '没配的键标 default');
  assert.equal(configSummary({}, {}).sources.LLM_API_KEY, 'default');
});
