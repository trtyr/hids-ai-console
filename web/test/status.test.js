// src/status.js —— 总览的数据 adapter：请求形状、失败归一、字段照文档、时间格式化
//
// P003-T015 起总览只读研判聚合（A1）：这里也要盯住「一条 /api/alerts 请求都不发」。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearCredentials, setCredentials } from '../src/credentials.js';
import {
  OverviewError,
  SOURCE_KEYS,
  formatClock,
  formatDateTime,
  loadOverview,
  setTriageEnabled,
} from '../src/status.js';

const TRIAGE = {
  initialized: true,
  enabled: true,
  input_mode: 'syslog',
  last_poll_at: null,
  last_received_at: '2026-11-17T01:02:03.000Z',
  last_error: null,
  since: null,
  counts: { queued: 12, running: 3, done: 331, failed: 1 },
  verdict_counts: { threat: 9, uncertain: 21, false_positive: 14, review: 302 },
  type_counts: { brute_force: 128, webshell: 42, honeypot: 12, unknown: 3 },
  syslog: { listening: true, bind: 'udp://0.0.0.0:15514', error: null },
};

/** 一份「后端一切正常」的回包表：路径 → { status, body } */
function healthyRoutes() {
  return {
    '/api/agent/triage/status': { body: TRIAGE },
    '/api/status': { body: { configured: true, connected: true } },
    '/api/agent/status': { body: { configured: true, model: 'gpt', missing: [], prompt_version: 'p-2026.11+4f2a' } },
    '/api/agent/tools': { body: { provider: 'cloudwalker-api', readOnly: true, count: 28, tools: [] } },
    '/api/triage/rules': { body: { config: {}, origin: 'file', revision: '4f2a9c1d0b7e3311', writable: false } },
    '/api/updates': { body: { revision: '9b1d4f2a7c3e5566' } },
  };
}

/** 桩 fetch：按「URL 结尾」匹配路由；没桩到直接抛，免得测试悄悄连网 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find(path => String(url).endsWith(path));
    if (key === undefined) throw new Error(`未桩的请求：${url}`);
    const route = typeof routes[key] === 'function' ? routes[key](init) : routes[key];
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (route.jsonError) throw new Error('不是 JSON');
        return route.body;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const options = (routes, extra = {}) => ({ fetchImpl: fakeFetch(routes), baseUrl: 'http://console.test', ...extra });

beforeEach(() => {
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

test('六个只读源：路径与 Authorization 头逐个对上，一条牧云现查都不发（A1）', async () => {
  const fetchImpl = fakeFetch(healthyRoutes());
  await loadOverview({ fetchImpl, baseUrl: 'http://console.test', now: () => new Date(2026, 10, 17, 9, 8, 7) });

  assert.deepEqual(
    fetchImpl.calls.map(call => call.url.replace('http://console.test', '')),
    ['/api/agent/triage/status', '/api/status', '/api/agent/status', '/api/agent/tools', '/api/triage/rules', '/api/updates'],
  );
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, 'Basic aGlkczpoaWRzLTIwMjY=');
    assert.equal(call.init.credentials, 'omit');
  }
  assert.equal(fetchImpl.calls.some(call => call.url.includes('/api/alerts')), false);
  assert.equal(fetchImpl.calls.length, 6);
  assert.equal(SOURCE_KEYS.includes('alerts'), false);
});

test('成功：六源归一成 ok:true，结论分布 / 类型分布 / 最后推送 / syslog 三态都带出来', async () => {
  const model = await loadOverview(options(healthyRoutes(), { now: () => new Date(2026, 10, 17, 9, 8, 7) }));

  assert.deepEqual(model.failed, []);
  assert.equal(model.triage.ok, true);
  assert.deepEqual(model.triage.verdictCounts, { threat: 9, uncertain: 21, false_positive: 14, review: 302 });
  assert.deepEqual(model.triage.typeCounts, { brute_force: 128, webshell: 42, honeypot: 12, unknown: 3 });
  assert.equal(model.triage.lastReceivedAt, '2026-11-17T01:02:03.000Z');
  assert.deepEqual(model.triage.syslog, { listening: true, bind: 'udp://0.0.0.0:15514', error: null });
  assert.deepEqual(model.triage.counts, { queued: 12, running: 3, done: 331, failed: 1 });
  assert.equal(model.system.cloud.connected, true);
  assert.equal(model.system.tools.count, 28);
  assert.equal(formatClock(model.fetchedAt), '09:08:07');
  assert.equal(model.since, null);
});

test('since：带上统计范围时只给聚合接口加 ?since=（编码后），其它源不变', async () => {
  const fetchImpl = fakeFetch(healthyRoutes());
  const model = await loadOverview({
    fetchImpl, baseUrl: 'http://console.test', since: '2026-11-17T00:00:00.000Z',
  });
  const urls = fetchImpl.calls.map(call => call.url.replace('http://console.test', ''));
  assert.equal(urls[0], '/api/agent/triage/status?since=2026-11-17T00%3A00%3A00.000Z');
  assert.equal(urls.length, 6);
  assert.equal(fetchImpl.calls.some(call => call.url.includes('/api/alerts')), false);
  assert.equal(model.since, '2026-11-17T00:00:00.000Z');

  // 空串 / 空白不当 since 发出去
  const again = fakeFetch(healthyRoutes());
  await loadOverview({ fetchImpl: again, baseUrl: 'http://console.test', since: '   ' });
  assert.equal(again.calls[0].url, 'http://console.test/api/agent/triage/status');
});

test('字段照文档：type_counts 里的非整数丢掉、结论四键缺了就 invalid、null 字段归 null', async () => {
  const routes = healthyRoutes();
  routes['/api/agent/triage/status'] = {
    body: {
      ...TRIAGE,
      last_poll_at: '2026-11-17T01:02:03.000Z',
      last_error: '牧云 401',
      type_counts: { honeypot: 3, webshell: null, malware: '很多' },
      syslog: { listening: false, bind: null, error: 'bind EADDRINUSE 127.0.0.1:15514' },
    },
  };
  routes['/api/triage/rules'] = { body: { config: {}, origin: 'example', revision: null } };

  const model = await loadOverview(options(routes));
  assert.deepEqual(model.triage.typeCounts, { honeypot: 3 });
  assert.equal(model.triage.lastPollAt, '2026-11-17T01:02:03.000Z');
  assert.equal(model.triage.lastError, '牧云 401');
  assert.deepEqual(model.triage.syslog, { listening: false, bind: null, error: 'bind EADDRINUSE 127.0.0.1:15514' });
  assert.equal(model.system.rules.revision, null);

  // 结论四键是接口的 required：缺一个就整源 invalid，不拿 0 假装
  routes['/api/agent/triage/status'] = { body: { ...TRIAGE, verdict_counts: { threat: 1, uncertain: 2, false_positive: 3 } } };
  const broken = await loadOverview(options(routes));
  assert.equal(broken.triage.ok, false);
  assert.equal(broken.triage.error.kind, 'invalid');
});

test('/api/status 的 502 是「配置在、连不上」：照样当成功源读，reason 留着', async () => {
  const routes = healthyRoutes();
  routes['/api/status'] = { status: 502, body: { configured: true, connected: false, reason: 'connect ECONNREFUSED' } };

  const model = await loadOverview(options(routes));
  assert.equal(model.system.cloud.ok, true);
  assert.equal(model.system.cloud.connected, false);
  assert.equal(model.system.cloud.reason, 'connect ECONNREFUSED');
  assert.deepEqual(model.failed, []);
});

test('单源失败不拖累别源：该源 ok:false，其余照常，failed 列出名字', async () => {
  const routes = healthyRoutes();
  routes['/api/agent/tools'] = { status: 503, body: { error: '牧云 API 未配置' } };

  const model = await loadOverview(options(routes));
  assert.deepEqual(model.failed, ['tools']);
  assert.equal(model.system.tools.ok, false);
  assert.equal(model.system.tools.error.kind, 'http');
  assert.equal(model.system.tools.error.status, 503);
  assert.equal(model.triage.ok, true);
});

test('研判聚合挂掉不影响运行状态那几行（反之亦然）', async () => {
  const routes = healthyRoutes();
  routes['/api/agent/triage/status'] = { status: 503, body: { error: '自动研判尚未配置' } };
  const model = await loadOverview(options(routes));
  assert.equal(model.triage.ok, false);
  assert.deepEqual(model.failed, ['triage']);
  assert.equal(model.system.cloud.ok, true);
});

test('任一路 401 → 整体 unauthorized（凭据失效不是「部分数据缺失」）', async () => {
  const routes = healthyRoutes();
  routes['/api/triage/rules'] = { status: 401, body: { error: '需要登录' } };

  await assert.rejects(loadOverview(options(routes)), (error) => {
    assert.equal(error instanceof OverviewError, true);
    assert.equal(error.kind, 'unauthorized');
    assert.equal(error.status, 401);
    return true;
  });
});

test('六路全挂 → 抛第一个错误（页面据此走整页错误态）', async () => {
  const dead = () => { throw new TypeError('fetch failed'); };

  await assert.rejects(loadOverview({ fetchImpl: dead, baseUrl: 'http://console.test' }), error => {
    assert.equal(error.kind, 'network');
    return true;
  });
});

test('没有凭据就不发请求：直接 unauthorized', async () => {
  clearCredentials();
  const fetchImpl = fakeFetch(healthyRoutes());
  await assert.rejects(loadOverview({ fetchImpl }), error => error.kind === 'unauthorized');
  assert.equal(fetchImpl.calls.length, 0);
});

test('单源回包缺必填字段 → 该源 ok:false / invalid，不把 undefined 画到屏幕上', async () => {
  const routes = healthyRoutes();
  routes['/api/agent/triage/status'] = { body: { enabled: true } };
  routes['/api/agent/status'] = { body: { prompt_version: 'x' } };

  const model = await loadOverview(options(routes));
  assert.equal(model.triage.ok, false);
  assert.equal(model.triage.error.kind, 'invalid');
  assert.equal(model.system.agent.ok, false);
  assert.equal(model.system.agent.error.kind, 'invalid');
});

test('回包不是 JSON → invalid（不冒 SyntaxError 到页面）', async () => {
  const routes = healthyRoutes();
  routes['/api/updates'] = { body: null, jsonError: true };
  const model = await loadOverview(options(routes));
  assert.equal(model.system.updates.ok, false);
  assert.equal(model.system.updates.error.kind, 'invalid');
});

test('暂停 / 恢复：PUT /api/agent/triage/control，正文只有 enabled，回包归一成 TriageSummary', async () => {
  const fetchImpl = fakeFetch({
    '/api/agent/triage/control': { body: { ...TRIAGE, enabled: false, counts: { queued: 0, running: 0, done: 0, failed: 0 } } },
  });
  const summary = await setTriageEnabled(false, { fetchImpl, baseUrl: 'http://console.test' });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.method, 'PUT');
  assert.equal(fetchImpl.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Basic aGlkczpoaWRzLTIwMjY=');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { enabled: false });
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.counts, { queued: 0, running: 0, done: 0, failed: 0 });
});

test('暂停失败：503 → http 错误带状态码；401 → unauthorized；enabled 非布尔值直接拒', async () => {
  await assert.rejects(setTriageEnabled(true, options({ '/api/agent/triage/control': { status: 503, body: {} } })),
    error => error.kind === 'http' && error.status === 503);
  await assert.rejects(setTriageEnabled(true, options({ '/api/agent/triage/control': { status: 401, body: {} } })),
    error => error.kind === 'unauthorized');
  await assert.rejects(setTriageEnabled('true', options(healthyRoutes())), error => error.kind === 'invalid');
});

test('formatClock：本机时刻 HH:MM:SS；拿不到时间给「—」', () => {
  assert.equal(formatClock(new Date(2026, 0, 2, 3, 4, 5)), '03:04:05');
  assert.equal(formatClock(new Date(2026, 0, 2, 13, 40, 59)), '13:40:59');
  assert.equal(formatClock(new Date('nope')), '—');
  assert.equal(formatClock('2026-01-02'), '—');
});

test('formatDateTime：ISO → 本机 YYYY-MM-DD HH:mm:ss；空「—」；解析不了原样返回', () => {
  const local = new Date(2026, 10, 17, 9, 8, 7);
  assert.equal(formatDateTime(local.toISOString()), '2026-11-17 09:08:07');
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime('昨天'), '昨天');
});
