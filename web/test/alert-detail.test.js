// src/alert-detail.js —— 告警详情域 adapter：五条真实路径、请求形状、失败归一、404 当「没有」
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AlertDetailError,
  enqueueTriage,
  getAlert,
  getInvestigation,
  getRule,
  getTraceBoard,
  getTriageRecord,
} from '../src/alert-detail.js';
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

const ALERT_BODY = {
  alert: {
    id: 'revshell:1', eventType: 'revshell', eventId: 1, hostId: 12,
    createdAt: '2026-11-17T01:02:03.000Z', title: '反弹 Shell 外联',
    level: '高危', levelKey: 'high', asset: 'web-prod-01', assetIp: '172.16.221.30', scenario: '反弹 Shell',
  },
  detail: { cmdline: 'bash -i', host: { host_name: 'web-prod-01' } },
};

beforeEach(() => {
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

test('getAlert：GET /api/alerts/{编码后的 ID}，带 Basic 头，回 alert + detail', async () => {
  const fetchImpl = fakeFetch(respond(ALERT_BODY));
  const result = await getAlert('revshell:1', { fetchImpl, baseUrl: 'http://h' });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://h/api/alerts/revshell%3A1');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.match(fetchImpl.calls[0].init.headers.Authorization, /^Basic /);
  assert.equal(fetchImpl.calls[0].init.credentials, 'omit');
  assert.equal(result.alert.id, 'revshell:1');
  assert.equal(result.detail.cmdline, 'bash -i');
});

test('getAlert：detail 不是对象（文档只写「自由 object」）时给空对象，不把 null 传下去', async () => {
  for (const detail of [null, undefined, 'raw', [1, 2]]) {
    const fetchImpl = fakeFetch(respond({ alert: ALERT_BODY.alert, detail }));
    const result = await getAlert('revshell:1', { fetchImpl });
    assert.deepEqual(result.detail, {});
  }
});

test('getAlert：回包没有 alert.id → invalid（不把半截数据画出去）', async () => {
  for (const body of [{ detail: {} }, { alert: {} }, { alert: { id: 7 } }, null]) {
    const fetchImpl = fakeFetch(respond(body));
    await assert.rejects(() => getAlert('revshell:1', { fetchImpl }), error => {
      assert.equal(error.name, 'AlertDetailError');
      assert.equal(error.kind, 'invalid');
      return true;
    });
  }
});

test('getAlert：400（事件类型/ID 无效）→ invalid_id，页面据此显示「没有这条告警」', async () => {
  const fetchImpl = fakeFetch(respond({ error: '不支持的事件类型' }, 400));
  await assert.rejects(() => getAlert('nosuch:1', { fetchImpl }), error => {
    assert.equal(error.kind, 'invalid_id');
    assert.equal(error.status, 400);
    return true;
  });
});

test('失败归一：401→unauthorized、503→unavailable、502→http（带状态码）、fetch 抛→network、非 JSON→invalid', async () => {
  const cases = [
    [respond({ error: 'x' }, 401), 'unauthorized', 401],
    [respond({ error: 'x' }, 503), 'unavailable', 503],
    [respond({ error: '牧云请求失败' }, 502), 'http', 502],
    [new TypeError('fetch failed'), 'network', null],
  ];
  for (const [reply, kind, status] of cases) {
    const fetchImpl = fakeFetch(reply);
    await assert.rejects(() => getAlert('revshell:1', { fetchImpl }), error => {
      assert.ok(error instanceof AlertDetailError);
      assert.equal(error.kind, kind);
      assert.equal(error.status, status);
      return true;
    });
  }

  const brokenJson = { status: 200, ok: true, json: async () => { throw new SyntaxError('bad json'); } };
  await assert.rejects(() => getAlert('revshell:1', { fetchImpl: fakeFetch(brokenJson) }), error => {
    assert.equal(error.kind, 'invalid');
    return true;
  });
});

test('没有凭据时不发请求，直接 unauthorized（同 session adapter 口径）', async () => {
  clearCredentials();
  const fetchImpl = fakeFetch(respond(ALERT_BODY));
  await assert.rejects(() => getAlert('revshell:1', { fetchImpl }), error => {
    assert.equal(error.kind, 'unauthorized');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('getTriageRecord：GET /api/agent/triage/{ID}，status 是字符串才算数', async () => {
  const fetchImpl = fakeFetch(respond({ alert_id: 'revshell:1', status: 'not_queued' }));
  const record = await getTriageRecord('revshell:1', { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, '/api/agent/triage/revshell%3A1');
  assert.equal(record.status, 'not_queued');

  const bad = fakeFetch(respond({ alert_id: 'revshell:1' }));
  await assert.rejects(() => getTriageRecord('revshell:1', { fetchImpl: bad }), error => {
    assert.equal(error.kind, 'invalid');
    return true;
  });
});

test('enqueueTriage：POST 同一路径，202 回 TriageCase', async () => {
  const fetchImpl = fakeFetch(respond({ alert_id: 'revshell:1', status: 'queued' }, 202));
  const record = await enqueueTriage('revshell:1', { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, '/api/agent/triage/revshell%3A1');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(record.status, 'queued');
});

test('getInvestigation：默认查 mode=triage，404 当「没有」（返回 null 不抛），真回包原样带出', async () => {
  const saved = { alert_id: 'revshell:1', mode: 'triage', verdict: { verdict_label: '真实威胁' } };
  const fetchImpl = fakeFetch(respond(saved));
  const result = await getInvestigation('revshell:1', {}, { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, '/api/agent/investigations/revshell%3A1?mode=triage');
  assert.equal(result.verdict.verdict_label, '真实威胁');

  const missing = fakeFetch(respond({ error: '该告警暂无已保存的研判记录' }, 404));
  assert.equal(await getInvestigation('revshell:1', { mode: 'deep' }, { fetchImpl: missing }), null);
  assert.equal(missing.calls[0].url, '/api/agent/investigations/revshell%3A1?mode=deep');
});

test('getInvestigation：回包 mode 或 verdict 缺失 → invalid；502 仍然抛错', async () => {
  const bad = fakeFetch(respond({ alert_id: 'revshell:1', verdict: {} }));
  await assert.rejects(() => getInvestigation('revshell:1', {}, { fetchImpl: bad }), error => {
    assert.equal(error.kind, 'invalid');
    return true;
  });

  const failed = fakeFetch(respond({ error: 'x' }, 502));
  await assert.rejects(() => getInvestigation('revshell:1', {}, { fetchImpl: failed }), error => {
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 502);
    return true;
  });
});

test('getRule：GET /api/rules/{id}，回 id/name/file/rego；404 → null（规则可能已被维护者删掉）', async () => {
  const rego = 'package hids.rules.ssh_bruteforce\n\ndefault allow := false';
  const fetchImpl = fakeFetch(respond({ id: 'ssh_bruteforce', name: 'SSH 暴力破解', description: 'd', file: 'ssh_bruteforce.rego', rego }));
  const rule = await getRule('ssh_bruteforce', { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, '/api/rules/ssh_bruteforce');
  assert.deepEqual(rule, { id: 'ssh_bruteforce', name: 'SSH 暴力破解', description: 'd', file: 'ssh_bruteforce.rego', rego });

  assert.equal(await getRule('gone', { fetchImpl: fakeFetch(respond({ error: '规则不存在' }, 404)) }), null);
  await assert.rejects(() => getRule('x', { fetchImpl: fakeFetch(respond({ id: 'x' })) }), error => error.kind === 'invalid');
});

test('getTraceBoard：GET /api/trace/boards/{ID}，404 → null，nodes 不是数组 → invalid', async () => {
  const board = { id: 'revshell:1', nodes: [{ id: 'asset:172.16.221.41', kind: 'asset', label: '172.16.221.41' }] };
  const fetchImpl = fakeFetch(respond(board));
  const result = await getTraceBoard('revshell:1', { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, '/api/trace/boards/revshell%3A1');
  assert.equal(result.nodes.length, 1);

  assert.equal(await getTraceBoard('revshell:1', { fetchImpl: fakeFetch(respond({ error: 'x' }, 404)) }), null);

  await assert.rejects(() => getTraceBoard('revshell:1', { fetchImpl: fakeFetch(respond({ id: 'x' })) }), error => {
    assert.equal(error.kind, 'invalid');
    return true;
  });
});
