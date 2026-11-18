// src/rules.js —— 规则域 adapter：三个 operation、错误归一、回包形状
// 接口事实：openapi.yaml:372-431、server.js:181-204、triage-rules.js:223-256。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RULE_ADMIN_TOKEN_HEADER, RulesError, getRules, saveRules, validateRules } from '../src/rules.js';
import { clearCredentials, setCredentials } from '../src/credentials.js';

let calls = [];

beforeEach(() => {
  calls = [];
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

function respond(body, status = 200, { jsonThrows = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (jsonThrows) throw new SyntaxError('Unexpected token');
      return body;
    },
  };
}

const fetchOnce = reply => async (url, init) => {
  calls.push({ url: String(url), init });
  return reply;
};

async function rejects(promise, kind, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof RulesError, `应抛 RulesError，实际 ${error?.name}`);
    assert.equal(error.kind, kind);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

// ---------- 请求外壳 ----------

test('三个请求都带 Basic / Accept / credentials:omit / cache:no-store', async () => {
  await getRules({ fetchImpl: fetchOnce(respond({ config: {}, revision: null, writable: false })) });
  await validateRules({}, { fetchImpl: fetchOnce(respond({ valid: true, count: 0 })) });
  await saveRules({ config: {}, expectedRevision: null, token: 'tk', fetchImpl: fetchOnce(respond({ config: {}, revision: 'a'.repeat(16) })) });

  assert.equal(calls.length, 3);
  for (const { init } of calls) {
    assert.match(init.headers.Authorization, /^Basic /);
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
  }
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'POST', 'PUT']);
  assert.deepEqual(calls.map(call => call.url), ['/api/triage/rules', '/api/triage/rules/validate', '/api/triage/rules']);
});

test('没有凭据：不发请求，直接 unauthorized', async () => {
  clearCredentials();
  await rejects(getRules({ fetchImpl: fetchOnce(respond({})) }), 'unauthorized');
  assert.equal(calls.length, 0);
});

// ---------- GET ----------

test('GET：只取 config / revision / writable，多给的 origin / error 原样带回', async () => {
  const rules = await getRules({
    fetchImpl: fetchOnce(respond({
      config: { schema_version: 1, enabled: true, rules: [] },
      revision: 'f'.repeat(16),
      writable: true,
      origin: 'file',
      error: '配置坏过一次',
    })),
  });
  assert.deepEqual(rules, {
    config: { schema_version: 1, enabled: true, rules: [] },
    revision: 'f'.repeat(16),
    writable: true,
    origin: 'file',
    error: '配置坏过一次',
  });
});

test('GET：配置取自示例文件时 revision 为 null，写不进去（接口事实）', async () => {
  const rules = await getRules({ fetchImpl: fetchOnce(respond({ config: {}, revision: null, writable: false })) });
  assert.equal(rules.revision, null);
  assert.equal(rules.writable, false);
});

test('GET：缺 config / 缺 writable / 回包不是 JSON → invalid', async () => {
  await rejects(getRules({ fetchImpl: fetchOnce(respond({ revision: null, writable: true })) }), 'invalid');
  await rejects(getRules({ fetchImpl: fetchOnce(respond({ config: {}, revision: null })) }), 'invalid');
  await rejects(getRules({ fetchImpl: fetchOnce(respond({ config: [], revision: null, writable: true })) }), 'invalid');
  await rejects(getRules({ fetchImpl: fetchOnce(respond(null, 200, { jsonThrows: true })) }), 'invalid', 200);
});

// ---------- 错误归一 ----------

test('401：按状态码处理，不解析正文（401 正文是纯文本）', async () => {
  let parsed = false;
  const response = {
    status: 401,
    ok: false,
    json: async () => { parsed = true; throw new SyntaxError('需要登录后访问'); },
  };
  await rejects(getRules({ fetchImpl: fetchOnce(response) }), 'unauthorized', 401);
  assert.equal(parsed, false);
});

test('403 / 409 / 503 / 400：kind 分开，正文 { error } 原话进 message', async () => {
  await assert.rejects(
    saveRules({ config: {}, expectedRevision: null, token: 'bad', fetchImpl: fetchOnce(respond({ error: '规则管理员令牌无效' }, 403)) }),
    error => error.kind === 'forbidden' && error.message === '规则管理员令牌无效' && error.status === 403,
  );
  await assert.rejects(
    saveRules({ config: {}, expectedRevision: 'a'.repeat(16), token: 'tk', fetchImpl: fetchOnce(respond({ error: '规则配置已变化，请刷新后重试' }, 409)) }),
    error => error.kind === 'conflict' && error.message === '规则配置已变化，请刷新后重试' && error.status === 409,
  );
  await assert.rejects(
    saveRules({ config: {}, expectedRevision: null, token: 'tk', fetchImpl: fetchOnce(respond({ error: '尚未配置规则管理员令牌' }, 503)) }),
    error => error.kind === 'unavailable' && error.message === '尚未配置规则管理员令牌',
  );
  await assert.rejects(
    validateRules({}, { fetchImpl: fetchOnce(respond({ error: '规则集格式无效' }, 400)) }),
    error => error.kind === 'http' && error.message === '规则集格式无效' && error.status === 400,
  );
});

test('错误体不是 JSON 时退回状态码文案，不把 HTML 甩到界面上', async () => {
  await assert.rejects(
    getRules({ fetchImpl: fetchOnce(respond(null, 502, { jsonThrows: true })) }),
    error => error.kind === 'http' && error.status === 502 && error.message === '服务返回 502',
  );
});

test('fetch 抛异常 → network', async () => {
  await rejects(getRules({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }), 'network');
});

// ---------- validate ----------

test('validate：POST body 只有 { config }，count 原样回', async () => {
  const result = await validateRules({ schema_version: 1, enabled: true, rules: [{}] }, {
    fetchImpl: fetchOnce(respond({ valid: true, count: 1 })),
  });
  assert.deepEqual(result, { valid: true, count: 1 });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { config: { schema_version: 1, enabled: true, rules: [{}] } });
});

test('validate：回包缺 count 或 valid !== true → invalid', async () => {
  await rejects(validateRules({}, { fetchImpl: fetchOnce(respond({ valid: true })) }), 'invalid');
  await rejects(validateRules({}, { fetchImpl: fetchOnce(respond({ valid: false, count: 0 })) }), 'invalid');
});

// ---------- save ----------

test('save：body 是 { config, expected_revision }，令牌走 X-Rule-Admin-Token', async () => {
  await saveRules({
    config: { schema_version: 1, enabled: false, rules: [] },
    expectedRevision: null,
    token: 'tk-1',
    fetchImpl: fetchOnce(respond({ config: { schema_version: 1, enabled: false, rules: [] }, revision: 'b'.repeat(16), origin: 'file' })),
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    config: { schema_version: 1, enabled: false, rules: [] },
    expected_revision: null,
  });
  assert.equal(calls[0].init.headers[RULE_ADMIN_TOKEN_HEADER], 'tk-1');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('save：成功后用返回的 config / revision，不自己造版本号', async () => {
  const saved = await saveRules({
    config: { schema_version: 1, enabled: true, rules: [] },
    expectedRevision: 'a'.repeat(16),
    token: 'tk',
    fetchImpl: fetchOnce(respond({ config: { schema_version: 1, enabled: true, rules: [] }, revision: 'c'.repeat(16), origin: 'file' })),
  });
  assert.deepEqual(saved, { config: { schema_version: 1, enabled: true, rules: [] }, revision: 'c'.repeat(16), origin: 'file' });
});

test('save：回包没有 revision → invalid（不拿旧 revision 顶替）', async () => {
  await rejects(
    saveRules({ config: {}, expectedRevision: null, token: 'tk', fetchImpl: fetchOnce(respond({ config: {} })) }),
    'invalid',
  );
});

test('无令牌时不伪造头：服务端会回 403/503，前端照实抛', async () => {
  await rejects(
    saveRules({ config: {}, expectedRevision: null, token: '', fetchImpl: fetchOnce(respond({ error: '规则管理员令牌无效' }, 403)) }),
    'forbidden',
  );
  assert.equal(calls[0].init.headers[RULE_ADMIN_TOKEN_HEADER], undefined);
});
