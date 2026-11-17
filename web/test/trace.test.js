// src/trace.js —— 溯源域 adapter：三个 operation、错误归一、目标编码、回包形状
// 接口事实：openapi.yaml:313-370、server.js:157-177、trace-board.js:158-222。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TraceError, getTraceBoard, listTraceBoards, startTraceBoard } from '../src/trace.js';
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

const board = {
  id: 'revshell:1', alert_id: 'revshell:1', status: 'done',
  nodes: [{ id: 'asset:172.16.221.41', label: 'web-prod-03' }],
  edges: [{ from: 'ip:45.32.118.7', to: 'asset:172.16.221.41', rel: '触达线索' }],
  activity: [{ at: '2026-11-17T01:00:00.000Z', kind: 'seed', title: '以告警为起点' }],
  summary: '', gaps: [],
};

const fetchOnce = (reply, { onCall } = {}) => async (url, init) => {
  calls.push({ url: String(url), init });
  if (onCall) onCall(String(url), init);
  return reply;
};

async function rejects(promise, kind, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TraceError, `应抛 TraceError，实际 ${error?.name}`);
    assert.equal(error.kind, kind);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

// ---------- 请求外壳：一条路径、一次请求、带 Basic ----------

test('请求都带 Authorization / Accept，且不带 cookie（credentials: omit）', async () => {
  await listTraceBoards({ fetchImpl: fetchOnce(respond({ boards: [] })) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.method, 'GET');
});

test('没有内存凭据：不发请求，直接抛 unauthorized', async () => {
  clearCredentials();
  await rejects(listTraceBoards({ fetchImpl: fetchOnce(respond({ boards: [] })) }), 'unauthorized');
  assert.equal(calls.length, 0);
});

test('baseUrl 前缀拼在 /api 之前', async () => {
  await listTraceBoards({ fetchImpl: fetchOnce(respond({ boards: [] })), baseUrl: 'http://127.0.0.1:19880' });
  assert.equal(calls[0].url, 'http://127.0.0.1:19880/api/trace/boards');
});

// ---------- listTraceBoards ----------

test('listTraceBoards：GET /api/trace/boards → boards 数组（列表项只有五个键也照收）', async () => {
  const boards = [{ id: 'revshell:1', title: '反弹 Shell', status: 'done', created_at: 'a', updated_at: 'b' }];
  const result = await listTraceBoards({ fetchImpl: fetchOnce(respond({ boards })) });
  assert.equal(calls[0].url, '/api/trace/boards');
  assert.deepEqual(result, boards);
});

test('listTraceBoards：200 但没有 boards 数组 → invalid', async () => {
  await rejects(listTraceBoards({ fetchImpl: fetchOnce(respond({ items: [] })) }), 'invalid');
});

test('listTraceBoards：200 不是 JSON → invalid', async () => {
  await rejects(listTraceBoards({ fetchImpl: fetchOnce(respond(null, 200, { jsonThrows: true })) }), 'invalid');
});

// ---------- getTraceBoard ----------

test('getTraceBoard：冒号编码进路径（openapi.yaml:361），并返回整块白板', async () => {
  const result = await getTraceBoard('revshell:1', { fetchImpl: fetchOnce(respond(board)) });
  assert.equal(calls[0].url, '/api/trace/boards/revshell%3A1');
  assert.equal(result.id, 'revshell:1');
  assert.equal(result.nodes.length, 1);
});

test('getTraceBoard：IPv4 原样进路径，ip: 前缀编码', async () => {
  await getTraceBoard('172.16.221.41', { fetchImpl: fetchOnce(respond(board)) });
  await getTraceBoard('ip:172.16.221.41', { fetchImpl: fetchOnce(respond(board)) });
  assert.equal(calls[0].url, '/api/trace/boards/172.16.221.41');
  assert.equal(calls[1].url, '/api/trace/boards/ip%3A172.16.221.41');
});

test('getTraceBoard：缺 nodes / edges / activity 任一个 → invalid（不拿默认值糊过去）', async () => {
  const broken = { id: 'revshell:1', nodes: [], edges: [] };
  await rejects(getTraceBoard('revshell:1', { fetchImpl: fetchOnce(respond(broken)) }), 'invalid');
});

test('getTraceBoard：404 → notfound（正常的「还没有白板」，不是故障）', async () => {
  await rejects(getTraceBoard('revshell:9', { fetchImpl: fetchOnce(respond({ error: '该告警尚无溯源白板' }, 404)) }), 'notfound', 404);
});

// ---------- startTraceBoard ----------

test('startTraceBoard：POST /api/trace/boards，正文 { target }，202 回白板', async () => {
  const result = await startTraceBoard('webshell:42', { fetchImpl: fetchOnce(respond(board, 202)) });
  assert.equal(calls[0].url, '/api/trace/boards');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { target: 'webshell:42' });
  assert.equal(result.id, 'revshell:1');
});

test('startTraceBoard：400 把服务端原话带出来（server.js:165 / :57）', async () => {
  await assert.rejects(
    startTraceBoard('nope', { fetchImpl: fetchOnce(respond({ error: '请输入有效告警 ID 或 IPv4 地址' }, 400)) }),
    error => {
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 400);
      assert.equal(error.message, '请输入有效告警 ID 或 IPv4 地址');
      return true;
    });
});

test('startTraceBoard：422 该告警没有可用资产也走 http，带状态码与原文', async () => {
  await assert.rejects(
    startTraceBoard('revshell:1', { fetchImpl: fetchOnce(respond({ error: '该告警没有可用的资产或来源 IP；可手动输入 IP 开始溯源' }, 422)) }),
    error => error.kind === 'http' && error.status === 422 && error.message.includes('可手动输入 IP'));
});

// ---------- 错误归一 ----------

test('401 → unauthorized；503 → unavailable（带服务端说明）；5xx → http；连接抛 → network', async () => {
  await rejects(listTraceBoards({ fetchImpl: fetchOnce(respond({}, 401)) }), 'unauthorized', 401);
  await assert.rejects(
    listTraceBoards({ fetchImpl: fetchOnce(respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503)) }),
    error => error.kind === 'unavailable' && error.message.includes('尚未配置'));
  await rejects(listTraceBoards({ fetchImpl: fetchOnce(respond({}, 502)) }), 'http', 502);
  await rejects(listTraceBoards({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), 'network');
});

test('503 没有错误体时用兜底文案（不是空字符串）', async () => {
  await assert.rejects(
    listTraceBoards({ fetchImpl: fetchOnce(respond(null, 503, { jsonThrows: true })) }),
    error => error.kind === 'unavailable' && error.message.length > 0);
});

test('5xx 且正文不是 JSON：仍归 http，消息带状态码', async () => {
  await assert.rejects(
    getTraceBoard('revshell:1', { fetchImpl: fetchOnce(respond(null, 500, { jsonThrows: true })) }),
    error => error.kind === 'http' && error.status === 500 && error.message === '服务返回 500');
});
