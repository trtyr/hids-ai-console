// src/cases.js —— 研判记录域 adapter：路径/参数逐字、空串不发、误报正文、错误归一
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CasesError, enqueueCase, fetchQueueStatus, getCase, listCases, reportFalsePositive, setQueueEnabled,
} from '../src/cases.js';
import { setCredentials, clearCredentials } from '../src/credentials.js';

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

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

const CASE_ID = 'syslog:revshell:0123456789abcdef:1732000000:11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

test('listCases：GET /api/agent/triage/cases，分页与筛选逐字进查询串', async () => {
  const fetchImpl = fakeFetch(respond({ total: 3, cases: [{ alert_id: CASE_ID }] }));
  const result = await listCases({
    count: 50, offset: 100, verdict: 'threat', type: 'revshell', host: '10.0.0.5',
    from: '2026-11-01T00:00:00.000Z', sort: 'verdict',
  }, { fetchImpl, baseUrl: 'http://h' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  const query = new URL(url).searchParams;
  assert.equal(new URL(url).pathname, '/api/agent/triage/cases');
  assert.equal(query.get('count'), '50');
  assert.equal(query.get('offset'), '100');
  assert.equal(query.get('verdict'), 'threat');
  assert.equal(query.get('type'), 'revshell');
  assert.equal(query.get('host'), '10.0.0.5');
  assert.equal(query.get('from'), '2026-11-01T00:00:00.000Z');
  assert.equal(query.get('sort'), 'verdict');
  assert.equal(init.method, 'GET');
  assert.match(init.headers.Authorization, /^Basic /);
  assert.deepEqual(result, { total: 3, cases: [{ alert_id: CASE_ID }] });
});

test('listCases：空串 / 未传的筛选不发（不把 type= 当滤条件发给服务端）；默认 count=20 offset=0', async () => {
  const fetchImpl = fakeFetch(respond({ total: 0, cases: [] }));
  await listCases({ verdict: '', type: '  ', host: undefined }, { fetchImpl, baseUrl: '' });
  const url = fetchImpl.calls[0].url;
  assert.equal(url, '/api/agent/triage/cases?count=20&offset=0');
});

test('listCases：回包缺 cases 数组或 total 不是整数 → invalid（不把半截数据画出去）', async () => {
  for (const body of [{ total: 1 }, { cases: [] }, { total: '1', cases: [] }]) {
    const fetchImpl = fakeFetch(respond(body));
    await assert.rejects(() => listCases({}, { fetchImpl }), error => error instanceof CasesError && error.kind === 'invalid');
  }
});

test('getCase：GET /api/agent/triage/{编码后的 ID}；未入队也是 200（status=not_queued）', async () => {
  const fetchImpl = fakeFetch(respond({ alert_id: CASE_ID, status: 'not_queued', evidence: [] }));
  const record = await getCase(CASE_ID, { fetchImpl, baseUrl: '' });
  assert.equal(fetchImpl.calls[0].url, `/api/agent/triage/${encodeURIComponent(CASE_ID)}`);
  assert.match(fetchImpl.calls[0].url, /syslog%3Arevshell/);
  assert.equal(record.status, 'not_queued');

  const bad = fakeFetch(respond({ alert_id: CASE_ID }));
  await assert.rejects(() => getCase(CASE_ID, { fetchImpl: bad }), error => error.kind === 'invalid');
});

test('enqueueCase：POST 同一路径，202 也算成功', async () => {
  const fetchImpl = fakeFetch(respond({ alert_id: CASE_ID, status: 'queued' }, 202));
  const record = await enqueueCase(CASE_ID, { fetchImpl });
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(record.status, 'queued');
});

test('reportFalsePositive：正文只有理由（who 省略由服务端取账号），202 回 FalsePositiveRecord', async () => {
  const fetchImpl = fakeFetch(respond({
    alert_id: CASE_ID,
    verdict: { verdict: 'false_positive', verdict_label: '误报', source: 'human' },
    feedback: { reason: '固定扫描脚本，已核实非攻击行为', who: 'hids', recorded_at: '2026-11-18T11:00:00.000Z' },
    maintenance: { status: 'updating', rule: { status: 'updating' }, wiki: { status: 'updating' } },
  }, 202));
  const result = await reportFalsePositive(CASE_ID, { reason: '  固定扫描脚本，已核实非攻击行为  ' }, { fetchImpl });

  assert.equal(fetchImpl.calls[0].url, `/api/agent/triage/${encodeURIComponent(CASE_ID)}/false-positive`);
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { reason: '固定扫描脚本，已核实非攻击行为' });
  assert.equal(result.verdict.verdict, 'false_positive');
});

test('reportFalsePositive：理由长度自己先拦（10–4000 字），一条请求都不发', async () => {
  const fetchImpl = fakeFetch();
  await assert.rejects(() => reportFalsePositive(CASE_ID, { reason: '太短' }, { fetchImpl }),
    error => error instanceof CasesError && error.kind === 'invalid_id');
  assert.equal(fetchImpl.calls.length, 0);
});

test('reportFalsePositive：who 给了才发（服务端也能省略）', async () => {
  const fetchImpl = fakeFetch(respond({
    alert_id: CASE_ID, verdict: {}, feedback: {}, maintenance: {},
  }, 202));
  await reportFalsePositive(CASE_ID, { reason: '十个字以上的误报理由', who: ' 张工 ' }, { fetchImpl });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { reason: '十个字以上的误报理由', who: '张工' });
});

test('fetchQueueStatus / setQueueEnabled：队列状态归一，PUT 正文只有 { enabled }', async () => {
  const summary = {
    enabled: true, input_mode: 'syslog', counts: { queued: 1, running: 0, done: 3, failed: 0 },
    last_error: null, last_received_at: '2026-11-18T10:00:00.000Z',
  };
  const fetchImpl = fakeFetch(respond(summary), respond({ ...summary, enabled: false }));
  const status = await fetchQueueStatus({ fetchImpl, baseUrl: '' });
  assert.deepEqual(status, {
    enabled: true, inputMode: 'syslog', counts: summary.counts, lastError: null,
    lastReceivedAt: '2026-11-18T10:00:00.000Z',
  });

  const next = await setQueueEnabled(false, { fetchImpl });
  assert.equal(fetchImpl.calls[1].url, '/api/agent/triage/control');
  assert.equal(fetchImpl.calls[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), { enabled: false });
  assert.equal(next.enabled, false);
});

test('失败归一：401→unauthorized、503→unavailable、400→invalid_id、404→not_found、409→conflict，正文原话进 message', async () => {
  const cases = [
    [respond({}, 401), 'unauthorized'],
    [respond({ error: '自动研判尚未配置' }, 503), 'unavailable'],
    [respond({ error: '筛选结论无效：x' }, 400), 'invalid_id'],
    [respond({ error: '找不到这条研判案件' }, 404), 'not_found'],
    [respond({ error: '研判还没结束，不能登记误报' }, 409), 'conflict'],
    [respond({}, 500), 'http'],
  ];
  for (const [reply, kind] of cases) {
    const fetchImpl = fakeFetch(reply);
    await assert.rejects(() => listCases({}, { fetchImpl }), error => {
      assert.ok(error instanceof CasesError);
      assert.equal(error.kind, kind);
      return true;
    });
  }
  const fetchImpl = fakeFetch(respond({ error: '研判还没结束，不能登记误报' }, 409));
  await assert.rejects(() => reportFalsePositive(CASE_ID, { reason: '十个字以上的误报理由' }, { fetchImpl }),
    error => error.message === '研判还没结束，不能登记误报');
});

test('失败归一：fetch 抛 → network；没有凭据 → 一条请求都不发；2xx 非 JSON → invalid', async () => {
  const throwing = fakeFetch(new Error('ECONNREFUSED'));
  await assert.rejects(() => getCase(CASE_ID, { fetchImpl: throwing }), error => error.kind === 'network');

  clearCredentials();
  const idle = fakeFetch();
  await assert.rejects(() => listCases({}, { fetchImpl: idle }), error => error.kind === 'unauthorized');
  assert.equal(idle.calls.length, 0);

  setCredentials({ user: 'hids', password: 'hids-2026' }); // 上面刚清过，这一半要带凭据才能走到解析
  const notJson = { status: 200, ok: true, json: async () => { throw new Error('bad json'); } };
  const broken = fakeFetch(notJson);
  await assert.rejects(() => listCases({}, { fetchImpl: broken }), error => error.kind === 'invalid');
});
