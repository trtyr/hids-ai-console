// src/rego-rules.js —— Rego 规则域 adapter：两个只读 operation、错误归一、回包形状
// 接口事实：openapi.yaml:623-684、server.js:559-578、rule-store.js:207-218。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RegoRulesError, getRegoRule, listRegoRules } from '../src/rego-rules.js';
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
    assert.ok(error instanceof RegoRulesError, `应抛 RegoRulesError，实际 ${error?.name}`);
    assert.equal(error.kind, kind);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

/** 列表项：RegoRuleSummary 的真形状（只有四个键，openapi.yaml:1839-1847） */
const summary = (overrides = {}) => ({
  id: 'ssh_bruteforce', name: 'SSH 暴力破解来源',
  description: '登录类告警里来源 IP 非空、命令含 ssh 的', file: 'ssh_bruteforce.rego', ...overrides,
});

const detail = (overrides = {}) => ({ ...summary(), rego: 'package hids.rules.ssh_bruteforce\n', ...overrides });

// ---------- 请求外壳 ----------

test('两个请求都是 GET，路径逐字，带 Basic / Accept / credentials:omit / cache:no-store', async () => {
  await listRegoRules({ fetchImpl: fetchOnce(respond({ count: 0, rules: [] })) });
  await getRegoRule('ssh_bruteforce', { fetchImpl: fetchOnce(respond(detail())) });

  assert.deepEqual(calls.map(call => call.url), ['/api/rules', '/api/rules/ssh_bruteforce']);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.match(init.headers.Authorization, /^Basic /);
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
  }
});

test('没有凭据：不发请求，直接 unauthorized', async () => {
  clearCredentials();
  const fetchImpl = async () => {
    throw new Error('不该发请求');
  };
  await rejects(listRegoRules({ fetchImpl }), 'unauthorized');
  await rejects(getRegoRule('ssh_bruteforce', { fetchImpl }), 'unauthorized');
});

test('baseUrl 前缀照传', async () => {
  await listRegoRules({ fetchImpl: fetchOnce(respond({ count: 0, rules: [] })), baseUrl: 'http://hids.local:3000' });
  assert.equal(calls[0].url, 'http://hids.local:3000/api/rules');
});

// ---------- listRegoRules ----------

test('列表：count / rules 四字段原样归一，description 可为 null', async () => {
  const { count, rules } = await listRegoRules({
    fetchImpl: fetchOnce(respond({
      count: 2,
      rules: [summary(), summary({ id: 'webshell_drop', name: 'WebShell 落地脚本', description: null, file: 'webshell_drop.rego' })],
    })),
  });
  assert.equal(count, 2);
  assert.deepEqual(rules[0], summary());
  assert.equal(rules[1].description, null);
});

test('空规则库是 200 + {count: 0, rules: []}，不是 404（openapi.yaml:630）', async () => {
  const { count, rules } = await listRegoRules({ fetchImpl: fetchOnce(respond({ count: 0, rules: [] })) });
  assert.equal(count, 0);
  assert.deepEqual(rules, []);
});

test('列表项**不许**带 effect / enabled / source：接口没有这三列，adapter 不补默认值', async () => {
  const { rules } = await listRegoRules({ fetchImpl: fetchOnce(respond({ count: 1, rules: [summary()] })) });
  assert.deepEqual(Object.keys(rules[0]).sort(), ['description', 'file', 'id', 'name']);
});

test('服务端多给键也不转发（additionalProperties: false，页面只认四样）', async () => {
  const { rules } = await listRegoRules({
    fetchImpl: fetchOnce(respond({ count: 1, rules: [{ ...summary(), updated_at: '2026-11-18', enabled: false }] })),
  });
  assert.equal('updated_at' in rules[0], false);
  assert.equal('enabled' in rules[0], false);
});

test('列表回包缺 count / rules：invalid', async () => {
  await rejects(listRegoRules({ fetchImpl: fetchOnce(respond({ rules: [] })) }), 'invalid');
  await rejects(listRegoRules({ fetchImpl: fetchOnce(respond({ count: 0 })) }), 'invalid');
});

test('列表条目缺 id / name：invalid（不把半截数据画上表）', async () => {
  await rejects(listRegoRules({ fetchImpl: fetchOnce(respond({ count: 1, rules: [{ name: '缺 id' }] })) }), 'invalid');
  await rejects(listRegoRules({ fetchImpl: fetchOnce(respond({ count: 1, rules: [{ id: 'x' }] })) }), 'invalid');
});

// ---------- getRegoRule ----------

test('原文：逐字返回 rego（含注释与空行），不裁剪、不 strip', async () => {
  const source = 'package hids.rules.honeypot\n\n# name: 蜜罐探测（root 用户）\n\ndefault match := false\n\nmatch if {\n  input.user == "root"\n}\n';
  const rule = await getRegoRule('honeypot', { fetchImpl: fetchOnce(respond(detail({ id: 'honeypot', rego: source }))) });
  assert.equal(rule.rego, source);
  assert.equal(rule.id, 'honeypot');
});

test('404：返回 null，不抛（详情页要能写「规则库里已没有这条」）', async () => {
  const rule = await getRegoRule('gone_rule', { fetchImpl: fetchOnce(respond({ error: '规则不存在' }, 404)) });
  assert.equal(rule, null);
});

test('502 规则库装载失败：抛 http，message 是服务端原话（带 rules/<文件>:<行>）', async () => {
  const message = '规则库读取失败：rules/ssh_bruteforce.rego:3: 缺少 # name: 显示名';
  await assert.rejects(getRegoRule('ssh_bruteforce', { fetchImpl: fetchOnce(respond({ error: message }, 502)) }), error => {
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 502);
    assert.equal(error.message, message, '定位信息不能丢');
    return true;
  });
});

test('回包缺 id / rego：invalid', async () => {
  await rejects(getRegoRule('ssh_bruteforce', { fetchImpl: fetchOnce(respond({ name: '没有 id' })) }), 'invalid');
  await rejects(getRegoRule('ssh_bruteforce', { fetchImpl: fetchOnce(respond({ id: 'ssh_bruteforce' })) }), 'invalid');
});

test('空 id 不发请求，直接 null', async () => {
  const fetchImpl = async () => {
    throw new Error('不该发请求');
  };
  assert.equal(await getRegoRule('', { fetchImpl }), null);
});

test('id 里的特殊字符会被编码（页面把它们原样拼进路径）', async () => {
  await getRegoRule('a b/c', { fetchImpl: fetchOnce(respond(detail({ id: 'a b/c' }))) });
  assert.equal(calls[0].url, '/api/rules/a%20b%2Fc');
});

// ---------- 错误归一 ----------

test('401：unauthorized，按状态码判，不解析纯文本正文', async () => {
  const reply = { status: 401, ok: false, json: async () => { throw new SyntaxError('Unexpected token 需'); } };
  await rejects(listRegoRules({ fetchImpl: fetchOnce(reply) }), 'unauthorized', 401);
});

test('2xx 但不是 JSON：invalid', async () => {
  await rejects(listRegoRules({ fetchImpl: fetchOnce(respond(null, 200, { jsonThrows: true })) }), 'invalid');
});

test('连不上：network', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await rejects(listRegoRules({ fetchImpl }), 'network');
});
