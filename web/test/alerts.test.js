// src/alerts.js —— 告警域 adapter：四条真实路径、请求形状、失败归一
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { AlertsError, enqueueTriage, fetchTriageSummary, listAlerts, setTriageEnabled } from '../src/alerts.js';
import { setCredentials, clearCredentials } from '../src/credentials.js';

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** 记录调用并按顺序给出回包 */
function fakeFetch(...replies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = replies.shift() ?? respond({}, 500);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => {
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

test('listAlerts：请求 GET /api/alerts?count&offset，带 Basic 头，回包按约定取五个字段', async () => {
  const fetchImpl = fakeFetch(respond({
    alerts: [{ id: 'revshell:1' }], total: 347, totals: { revshell: 9 }, errors: {}, partial: false,
    query: { count: 50, offset: 100 }, note: '接口附带的说明',
  }));
  const result = await listAlerts({ count: 50, offset: 100 }, { fetchImpl, baseUrl: 'http://h' });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://h/api/alerts?count=50&offset=100');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.match(fetchImpl.calls[0].init.headers.Authorization, /^Basic /);
  assert.deepEqual(Object.keys(result).sort(), ['alerts', 'errors', 'partial', 'total', 'totals', 'truncated']);
  assert.equal(result.total, 347);
  assert.equal(result.partial, false);
  assert.equal(result.truncated, false, '回包没有 truncated 时当 false，不能当 true 吓人');
});

test('listAlerts：筛选与排序参数逐字进查询串（server.js:129-152 的名字）', async () => {
  const fetchImpl = fakeFetch(respond({ alerts: [], total: 0 }));
  await listAlerts({
    count: 20, offset: 40, type: 'webshell', level: 'critical', verdict: 'threat',
    triageStatus: 'done', q: 'deploy', from: '2026-11-16T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z', sort: 'level',
  }, { fetchImpl });
  const url = fetchImpl.calls[0].url;
  assert.match(url, /count=20/);
  assert.match(url, /offset=40/);
  assert.match(url, /type=webshell/);
  assert.match(url, /level=critical/);
  assert.match(url, /verdict=threat/);
  assert.match(url, /triage_status=done/);
  assert.match(url, /q=deploy/);
  assert.match(url, /from=2026-11-16T00%3A00%3A00.000Z/);
  assert.match(url, /to=2026-11-17T00%3A00%3A00.000Z/);
  assert.match(url, /sort=level/);
});

test('listAlerts：空串 / 未传的筛选不发（不把 type= 当滤条件发给服务端）', async () => {
  const fetchImpl = fakeFetch(respond({ alerts: [], total: 0 }));
  await listAlerts({ type: '', q: '  ', sort: 'time' }, { fetchImpl });
  const url = fetchImpl.calls[0].url;
  assert.equal(url, '/api/alerts?count=20&offset=0&sort=time');
});

test('listAlerts：truncated 透传（扫描窗口 500 条上限，页面靠它提示总数只含窗口）', async () => {
  const fetchImpl = fakeFetch(respond({ alerts: [], total: 500, truncated: true }));
  const result = await listAlerts({}, { fetchImpl });
  assert.equal(result.truncated, true);
});

test('listAlerts：不给分页参数时用接口默认 count=20 offset=0', async () => {
  const fetchImpl = fakeFetch(respond({ alerts: [], total: 0 }));
  await listAlerts({}, { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, '/api/alerts?count=20&offset=0');
});

test('listAlerts：partial 为真时把 errors 原样带出（页面的「部分类型失败」提示就靠它）', async () => {
  const fetchImpl = fakeFetch(respond({
    alerts: [], total: 12, totals: { revshell: 12 }, errors: { honeypot: '牧云 /rpc 超时' }, partial: true,
  }));
  const result = await listAlerts({}, { fetchImpl });
  assert.equal(result.partial, true);
  assert.deepEqual(result.errors, { honeypot: '牧云 /rpc 超时' });
});

test('listAlerts：回包缺 alerts 数组或 total 不是整数 → invalid（不把半截数据画出去）', async () => {
  for (const body of [{ total: 1 }, { alerts: [] }, { alerts: [], total: '12' }]) {
    const fetchImpl = fakeFetch(respond(body));
    await assert.rejects(() => listAlerts({}, { fetchImpl }), error => {
      assert.equal(error.name, 'AlertsError');
      assert.equal(error.kind, 'invalid');
      return true;
    });
  }
});

test('失败归一：401→unauthorized、503→unavailable、其它非 2xx→http（带状态码）', async () => {
  const cases = [
    [401, 'unauthorized', 401],
    [503, 'unavailable', 503],
    [502, 'http', 502],
  ];
  for (const [status, kind, expectedStatus] of cases) {
    const fetchImpl = fakeFetch(respond({ error: 'x' }, status));
    await assert.rejects(() => listAlerts({}, { fetchImpl }), error => {
      assert.ok(error instanceof AlertsError);
      assert.equal(error.kind, kind);
      assert.equal(error.status, expectedStatus);
      return true;
    });
  }
});

test('失败归一：fetch 抛 → network；没有凭据 → 一条请求都不发', async () => {
  await assert.rejects(() => listAlerts({}, { fetchImpl: fakeFetch(new Error('ECONNREFUSED')) }), error => {
    assert.equal(error.kind, 'network');
    return true;
  });

  clearCredentials();
  const fetchImpl = fakeFetch(respond({ alerts: [], total: 0 }));
  await assert.rejects(() => listAlerts({}, { fetchImpl }), error => error.kind === 'unauthorized');
  assert.equal(fetchImpl.calls.length, 0);
});

test('失败归一：2xx 但正文不是 JSON → invalid', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await assert.rejects(() => listAlerts({}, { fetchImpl }), error => error.kind === 'invalid');
});

test('fetchTriageSummary：GET /api/agent/triage/status，回 TriageSummary；缺 enabled/counts → invalid', async () => {
  const summary = { initialized: true, enabled: false, input_mode: 'syslog',
    last_poll_at: null, last_error: null, counts: { queued: 2, running: 1, done: 9, failed: 1 } };
  const fetchImpl = fakeFetch(respond(summary));
  assert.deepEqual(await fetchTriageSummary({ fetchImpl }), summary);
  assert.equal(fetchImpl.calls[0].url, '/api/agent/triage/status');

  await assert.rejects(() => fetchTriageSummary({ fetchImpl: fakeFetch(respond({ enabled: true })) }),
    error => error.kind === 'invalid');
});

test('setTriageEnabled：PUT /api/agent/triage/control，正文只有 { enabled }（文档 additionalProperties: false）', async () => {
  const fetchImpl = fakeFetch(respond({ enabled: true, counts: {} }));
  const result = await setTriageEnabled(true, { fetchImpl });

  assert.equal(fetchImpl.calls[0].init.method, 'PUT');
  assert.equal(fetchImpl.calls[0].url, '/api/agent/triage/control');
  assert.equal(fetchImpl.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { enabled: true });
  assert.equal(result.enabled, true);
});

test('enqueueTriage：POST /api/agent/triage/{id}，ID 里的冒号要编码；202 也算成功', async () => {
  const fetchImpl = fakeFetch(respond({ alert_id: 'revshell:1', status: 'queued', stage: '等待研判' }, 202));
  const result = await enqueueTriage('revshell:1', { fetchImpl });

  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].url, '/api/agent/triage/revshell%3A1');
  assert.equal(result.status, 'queued');
});

test('enqueueTriage：回包没有 status → invalid；404 → http（syslog 案件原文不存在那一条）', async () => {
  await assert.rejects(() => enqueueTriage('revshell:1', { fetchImpl: fakeFetch(respond({}, 202)) }),
    error => error.kind === 'invalid');

  await assert.rejects(() => enqueueTriage('syslog:7', { fetchImpl: fakeFetch(respond({ error: '不存在' }, 404)) }),
    error => error.kind === 'http' && error.status === 404);
});
