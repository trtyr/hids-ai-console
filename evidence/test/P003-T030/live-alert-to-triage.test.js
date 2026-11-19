// P003-T030 单测：现查告警（牧云事件 ID）→ 研判队列的后端路径。
//
// 跑法：node --test evidence/test/P003-T030/live-alert-to-triage.test.js
// 纪律（A3）：全部走替身——`service`（牧云网关）任何方法被调就抛，eventToolbox 只有显式注入的假货；
// 唯一真网络是 127.0.0.1 上本次测试自己起的 server。没有固定 sleep，等状态用带超时上界的 until()。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createServer } from '../../../server.js';

const EVIDENCE_ID = 'webshell:9001';
const triagePath = id => `/api/agent/triage/${encodeURIComponent(id)}`;

async function tempDir(t, prefix = 'hids-t030-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  return directory;
}

// 等条件成立，带超时上界；不写固定 sleep。
async function until(check, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时未满足：${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

// 牧云网关替身：现查入队这条链不该碰它（轮询才用），被调到就是纪律破了。
function forbiddingService(calls = []) {
  const boom = name => async (...args) => {
    calls.push([name, args]);
    throw new Error(`现查入队不该调用牧云网关：${name}`);
  };
  return { calls, alerts: boom('alerts'), alert: boom('alert'), detail: boom('detail') };
}

// 假研判器：记录「按哪个事件 ID、什么模式」拉详情，回一份形状齐全的 triage 结果。
// gate 传进来时先卡住，用来把记录稳定停在 running。
function fakeInvestigator({ calls, gate = null, verdict = 'threat' } = {}) {
  return {
    runUnmatchedSyslog: async () => { throw new Error('现查入队不该走 syslog 未匹配分支'); },
    run: async (alertId, options = {}) => {
      calls.push({ alert_id: alertId, mode: options.mode ?? null });
      if (gate) await gate.promise;
      return { alert_id: alertId, mode: 'triage',
        verdict: { verdict, verdict_label: verdict === 'threat' ? '真实威胁' : '存疑',
          summary: `按事件 ID ${alertId} 的现查研判结论`, claims: [] },
        validation: { ok: true },
        evidence: [{ evidence_id: 'cw:1', tool: 'get_webshell_event',
          fetched_at: '2026-11-03T08:00:01.000Z', sha256: 'a'.repeat(64) }] };
    }
  };
}

function triageMonitor({ directory, investigator, service = forbiddingService(), history, ...options }) {
  return new TriageMonitor({ service, investigator, concurrency: 1, inputMode: 'poll',
    history: history ?? new InvestigationStore(path.join(directory, 'investigations')),
    file: path.join(directory, 'queue.json'), eventToolbox: null, ...options });
}

// access 显式给成「没有密码」，免得 CI 上 HIDS_BASIC_AUTH_* 把用例打成 401。
async function serve(t, monitor) {
  const server = createServer(null, null, null, null, null, monitor, null, { user: 'test', password: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const getJSON = async (base, pathname) => (await fetch(`${base}${pathname}`)).json();
const post = (base, pathname) => fetch(`${base}${pathname}`, { method: 'POST' });

// ── A1 / A2：现查事件 ID → 入队 → 按 ID 研判 → 落记录 ─────────────────────────
test('A1 现查事件 ID 入队：202 queued → 按事件 ID 研判 → done 且研判记录落盘', async t => {
  const directory = await tempDir(t);
  const calls = [];
  const service = forbiddingService();
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const monitor = triageMonitor({ directory, investigator: fakeInvestigator({ calls }), service, history });
  const base = await serve(t, monitor);

  const accepted = await post(base, triagePath(EVIDENCE_ID));
  assert.equal(accepted.status, 202);
  const queued = await accepted.json();
  // 入队回包就是 TriageCase：同一 alert_id、已进队列（drain 开了跑，回包可能已经是 running）、evidence 恒为数组
  assert.equal(queued.alert_id, EVIDENCE_ID);
  assert.ok(['queued', 'running'].includes(queued.status), `入队回包状态是 ${queued.status}`);
  assert.deepEqual(queued.evidence, []);

  const done = await until(async () => {
    const body = await getJSON(base, triagePath(EVIDENCE_ID));
    return body.status === 'done' ? body : null;
  }, { label: '研判跑完' });

  // 研判确实是「按事件 ID」跑的常规研判，不是深度模式、也没有 syslog 报文可复用
  assert.deepEqual(calls, [{ alert_id: EVIDENCE_ID, mode: 'triage' }]);
  // 记录形状：结论、结果 ID、证据都在，且没有 syslog 侧键（现查记录没有原始报文）
  assert.equal(done.verdict, 'threat');
  assert.equal(done.verdict_label, '真实威胁');
  assert.equal(done.result_alert_id, EVIDENCE_ID);
  assert.equal(done.attempts, 1);
  assert.equal(done.evidence.length, 1);
  assert.equal(done.syslog, undefined);
  assert.equal(done.case_dir, undefined);

  // 「记录」＝研判记录按 alert_id + mode 落在 InvestigationStore 里
  const stored = await history.latest(EVIDENCE_ID, 'triage');
  assert.ok(stored, '研判记录没落盘');
  assert.equal(stored.alert_id, EVIDENCE_ID);
  assert.equal(stored.mode, 'triage');
  assert.equal(stored.verdict.verdict, 'threat');

  // A3：整条链一次牧云网关都没碰
  assert.deepEqual(service.calls, []);
});

// ── A2 重复入队（排队中） ────────────────────────────────────────────────────
test('A2 重复入队（排队中）：同一事件 ID 只有一条排队记录，不会排第二份工', async t => {
  const directory = await tempDir(t);
  // concurrency 0：记录停 queued，专门看重复 POST 会不会多出一条
  const monitor = triageMonitor({ directory, investigator: fakeInvestigator({ calls: [] }), concurrency: 0 });
  const base = await serve(t, monitor);

  const first = await post(base, triagePath(EVIDENCE_ID));
  const second = await post(base, triagePath(EVIDENCE_ID));
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal((await first.json()).status, 'queued');
  assert.equal((await second.json()).status, 'queued');

  // 队列深度仍是 1：重复入队没有第二条记录（判定看公开聚合，不看内部 Map）
  const summary = await getJSON(base, '/api/agent/triage/status');
  assert.equal(summary.queue.depth, 1);
  assert.equal(summary.queue.oldest_alert_id, EVIDENCE_ID);
});

// ── A2 重复入队（在跑中） ────────────────────────────────────────────────────
test('A2 重复入队（在跑中）：第二次 POST 回 running 且不重启研判', async t => {
  const directory = await tempDir(t);
  const calls = [];
  let release;
  const gate = { promise: new Promise(resolve => { release = resolve; }) };
  const monitor = triageMonitor({ directory, investigator: fakeInvestigator({ calls, gate }) });
  const base = await serve(t, monitor);

  assert.equal((await post(base, triagePath(EVIDENCE_ID))).status, 202);
  await until(async () => (await getJSON(base, triagePath(EVIDENCE_ID))).status === 'running',
    { label: '进入 running' });

  const again = await post(base, triagePath(EVIDENCE_ID));
  assert.equal(again.status, 202);
  assert.equal((await again.json()).status, 'running');

  release();
  const done = await until(async () => {
    const body = await getJSON(base, triagePath(EVIDENCE_ID));
    return body.status === 'done' ? body : null;
  }, { label: '研判跑完' });
  // 只跑了一轮：重复 POST 没有把在跑的任务再排一次
  assert.equal(calls.length, 1);
  assert.equal(done.attempts, 1);
});

// ── A2 重复入队（已完结）：人工重试语义 ──────────────────────────────────────
test('A2 重复入队（已完结）：done 之后再 POST 是人工重试——attempts 加 1、created_at 沿用、仍一条', async t => {
  const directory = await tempDir(t);
  const calls = [];
  const monitor = triageMonitor({ directory, investigator: fakeInvestigator({ calls }) });
  const base = await serve(t, monitor);

  await post(base, triagePath(EVIDENCE_ID));
  const first = await until(async () => {
    const body = await getJSON(base, triagePath(EVIDENCE_ID));
    return body.status === 'done' ? body : null;
  }, { label: '第一轮跑完' });
  assert.equal(first.attempts, 1);
  const createdAt = first.created_at;

  assert.equal((await post(base, triagePath(EVIDENCE_ID))).status, 202);
  const second = await until(async () => {
    const body = await getJSON(base, triagePath(EVIDENCE_ID));
    return body.status === 'done' && body.attempts === 2 ? body : null;
  }, { label: '人工重试跑完' });

  assert.equal(second.created_at, createdAt);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.alert_id), [EVIDENCE_ID, EVIDENCE_ID]);
  // 仍是一条记录、一份研判记录（同一个 alert_id + mode 的文件被覆盖，不是多存一份）
  const summary = await getJSON(base, '/api/agent/triage/status');
  assert.equal(summary.queue.depth, 0);
  assert.equal((await getJSON(base, triagePath(EVIDENCE_ID))).attempts, 2);
});

// ── A3 替身纪律：eventToolbox 非空时也只打替身，且同一事件详情只取一次 ────────
test('A3 假数据走替身：现查路径只用注入的假货，网关替身零调用', async t => {
  const directory = await tempDir(t);
  const toolboxCalls = [];
  const eventToolbox = {
    callTool: async (name, args) => {
      toolboxCalls.push([name, args]);
      return { id: args.id, host: { host_ip: '10.0.0.5' } };
    },
    listEvents: async () => ({ events: [] })
  };
  const service = forbiddingService();
  const monitor = triageMonitor({ directory, investigator: fakeInvestigator({ calls: [] }), service, eventToolbox });
  const base = await serve(t, monitor);

  await post(base, triagePath(EVIDENCE_ID));
  const done = await until(async () => {
    const body = await getJSON(base, triagePath(EVIDENCE_ID));
    return body.status === 'done' ? body : null;
  }, { label: '研判跑完' });
  // 现查入队的研判器是替身：取数一次都不经过它，详情来源全在假 investigator 里
  assert.deepEqual(toolboxCalls, []);
  assert.deepEqual(service.calls, []);
  assert.equal(done.verdict, 'threat');
});

// ── A4 契约同步：openapi 与 http-api.md 都写了重复入队语义 ───────────────────
test('A4 契约同步：openapi.yaml 与 http-api.md 的 POST 条目都写明重复入队语义', async () => {
  const openapi = await readFile(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
  const httpApi = await readFile(new URL('../../../docs/modules/http-api.md', import.meta.url), 'utf8');
  // 认「POST /api/agent/triage/{alertId}」这一块（到下一个 path 条目为止），别拿全文件命中糊过去
  const start = openapi.indexOf('  /api/agent/triage/{alertId}:');
  assert.ok(start > 0, 'openapi.yaml 里找不到 /api/agent/triage/{alertId}');
  const block = openapi.slice(start, openapi.indexOf('\n  /', start + 10));
  assert.match(block, /重复入队/, 'openapi 的 POST 条目没写重复入队语义');
  assert.match(block, /同一 alert ID 只有一条记录/, 'openapi 的 POST 条目没写「同一 alert ID 只有一条记录」');
  assert.match(block, /人工重试/, 'openapi 的 POST 条目没写 done\/failed 再 POST 走人工重试');
  // http-api.md：同一句口径 + 本卡新增的那一节
  assert.match(httpApi, /同一 alert ID 只有一条记录/, 'http-api.md 没写重复入队口径');
  assert.match(httpApi, /### 3\.9 现查告警送研判/, 'http-api.md 没有现查告警送研判那一节');
});
