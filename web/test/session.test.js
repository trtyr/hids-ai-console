// src/session.js —— 会话 adapter 的单测（唯一发 HTTP 的地方，所以这里把 HTTP 全 mock 掉）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeSession, SessionError } from '../src/session.js';
import { base64 } from '../src/credentials.js';

const CREDENTIALS = { user: 'hids', password: 'hids-2026' };

function fetchReturning(status, body, { json = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (!json) throw new SyntaxError('Unexpected token');
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

test('200 且 authenticated=true → 解析为已认证', async () => {
  const { fetchImpl, calls } = fetchReturning(200, { authenticated: true });
  const session = await probeSession(CREDENTIALS, { fetchImpl });
  assert.deepEqual(session, { authenticated: true });
  // 请求形状：打本仓会话接口，凭据走 Basic，别处不许出现其它路径
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/session');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${base64('hids:hids-2026')}`);
});

test('401 → unauthorized（账号或密码不对），不当成网络错误', async () => {
  const { fetchImpl } = fetchReturning(401, '需要登录后访问', { json: false });
  await assert.rejects(probeSession(CREDENTIALS, { fetchImpl }), error => {
    assert.ok(error instanceof SessionError);
    assert.equal(error.kind, 'unauthorized');
    assert.equal(error.status, 401);
    return true;
  });
});

test('500 → http，且带上状态码（界面要显示「服务返回异常」）', async () => {
  const { fetchImpl } = fetchReturning(503, {});
  await assert.rejects(probeSession(CREDENTIALS, { fetchImpl }), error => {
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 503);
    return true;
  });
});

test('连不上（fetch 抛）→ network', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(probeSession(CREDENTIALS, { fetchImpl }), error => {
    assert.equal(error.kind, 'network');
    return true;
  });
});

test('200 但不是 JSON → invalid（不把 HTML 当成已认证）', async () => {
  const { fetchImpl } = fetchReturning(200, null, { json: false });
  await assert.rejects(probeSession(CREDENTIALS, { fetchImpl }), error => {
    assert.equal(error.kind, 'invalid');
    return true;
  });
});

test('200 但 authenticated 不是 true → invalid（不靠 200 就放行）', async () => {
  const { fetchImpl } = fetchReturning(200, { authenticated: false });
  await assert.rejects(probeSession(CREDENTIALS, { fetchImpl }), error => {
    assert.equal(error.kind, 'invalid');
    return true;
  });
});

test('返回体只取 authenticated，不臆造账号名/角色字段', async () => {
  const { fetchImpl } = fetchReturning(200, { authenticated: true });
  const session = await probeSession(CREDENTIALS, { fetchImpl });
  assert.deepEqual(Object.keys(session), ['authenticated']);
});
