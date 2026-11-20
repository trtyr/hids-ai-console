// P003-T030 集成测试（tester 面）：`/api/agent/triage/*` 这组操作的 HTTP 契约。
//
// 口径来源（只读文档，不读实现）：
//   - docs/modules/http-api.md §3.1 路由表、§3.3 路径 ID 校验、§3.4 误报登记、§3.9 现查告警送研判
//   - docs/modules/triage-pipeline.md §5.3 失败面、§5.4 人工入口（取消 / 队列满）、§8.1 案件列表参数
//   - openapi.yaml：TriageCase / TriageSummary / FalsePositiveRecord / Error 四个 schema 与各 operation 的 responses
//
// 这是契约测试，不是实现测试：每条断言都指得出文档出处；笔记在注释里。全部在本机回环口跑，
// 不碰真牧云、不碰真模型（替身 investigator / 替身 service），没有固定 sleep（等状态用 until()）。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js 求值前把 HIDS_DATA_DIR
// 指到本进程的临时根，否则 createServer 的缺省 fpSessions 会往真全局根写维护会话。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createServer } from '../../../server.js';

const TID = 'webshell:9001';
const SYSLOG_ID = 'syslog:webshell:0123456789abcdef:1767225600:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const triagePath = id => `/api/agent/triage/${encodeURIComponent(id)}`;
const ERROR_CODES = new Set(['caller_error', 'not_configured', 'upstream_error', 'internal_error']);
const CASE_STATUSES = new Set(['not_queued', 'queued', 'running', 'done', 'failed']);

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function tempDir(t, prefix = 'hids-t030-it-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  return directory;
}

async function until(check, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时未满足：${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

// 牧云网关替身：现查入队这条链不该碰它（轮询才用），被调到就是纪律破了（§3.9 替身纪律）。
function forbiddingService(calls = []) {
  const boom = name => async (...args) => {
    calls.push([name, args]);
    throw new Error(`现查入队不该调用牧云网关：${name}`);
  };
  return { calls, alerts: boom('alerts'), alert: boom('alert'), detail: boom('detail') };
}

// 假研判器：形状照 investigation-agent.md §5.5 的可复用写法（run(alertId, {mode}) → 研判记录）。
function fakeInvestigator({ calls = [], gate = null, verdict = 'threat' } = {}) {
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

function makeMonitor({ directory, investigator, concurrency = 1, service = forbiddingService(), ...options }) {
  return new TriageMonitor({ service, investigator, concurrency, inputMode: 'poll',
    history: new InvestigationStore(path.join(directory, 'investigations')),
    file: path.join(directory, 'queue.json'), eventToolbox: null, ...options });
}

// access 显式给成「没有密码」，免得 CI 上的 HIDS_BASIC_AUTH_* 把用例打成 401（§4 闸门）。
async function serve(t, monitor) {
  const server = createServer(null, null, null, null, null, monitor, null, { user: 'test', password: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  if (monitor) t.after(() => monitor.stop?.());
  return `http://127.0.0.1:${server.address().port}`;
}

const call = async (base, pathname, init) => {
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 401 之类是纯文本，按原样留着 */ }
  return { status: response.status, body };
};
const get = (base, pathname) => call(base, pathname);
const post = (base, pathname, payload) => call(base, pathname, payload === undefined
  ? { method: 'POST' }
  : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const put = (base, pathname, payload) => call(base, pathname, payload === undefined
  ? { method: 'PUT' }
  : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const del = (base, pathname) => call(base, pathname, { method: 'DELETE' });

// ── schema 断言（字段表照 openapi.yaml 抄，不照实现抄）────────────────────────
function assertErrorBody(body, label) {
  assert.equal(typeof body, 'object', `${label}: 错误体应该是 JSON 对象，实测 ${JSON.stringify(body)}`);
  assert.equal(typeof body.error, 'string', `${label}: error 必须是字符串`);
  assert.ok(body.error.length > 0, `${label}: error 不能是空串`);
  assert.ok(ERROR_CODES.has(body.code), `${label}: code=${body.code} 不在四类里（openapi Error.code enum）`);
}

// TriageCase（openapi.yaml:2401-2456）：required [alert_id, status]
function assertTriageCase(body, label) {
  assert.equal(typeof body, 'object', `${label}: 响应应该是对象`);
  assert.equal(typeof body.alert_id, 'string', `${label}: alert_id 必须是字符串`);
  assert.ok(CASE_STATUSES.has(body.status), `${label}: status=${body.status} 不在 queued/running/done/failed/not_queued`);
  if (body.attempts !== undefined) assert.ok(Number.isInteger(body.attempts), `${label}: attempts 必须是整数`);
  if (body.dead_letter !== undefined) assert.equal(typeof body.dead_letter, 'boolean', `${label}: dead_letter 必须是布尔`);
  if (body.verdict !== undefined) {
    assert.ok([null, 'threat', 'uncertain', 'false_positive'].includes(body.verdict), `${label}: verdict=${body.verdict}`);
  }
  if (body.verdict_label !== undefined) {
    assert.ok([null, '真实威胁', '存疑', '误报'].includes(body.verdict_label), `${label}: verdict_label=${body.verdict_label}`);
  }
  assert.ok(Array.isArray(body.evidence), `${label}: evidence 必须是数组`);
  if (body.steps !== undefined) assert.ok(Array.isArray(body.steps), `${label}: steps 必须是数组`);
  if (body.feedback !== undefined) {
    assert.equal(typeof body.feedback.reason, 'string', `${label}: feedback.reason`);
    assert.equal(typeof body.feedback.who, 'string', `${label}: feedback.who`);
    assert.ok(!Number.isNaN(Date.parse(body.feedback.recorded_at)), `${label}: feedback.recorded_at 应该是时间`);
  }
}

// TriageSummary（openapi.yaml:2255 起）：13 个 required 键 + 每个子对象的 required 键
function assertTriageSummary(body, label) {
  for (const key of ['initialized', 'enabled', 'input_mode', 'since', 'counts', 'verdict_counts',
    'type_counts', 'queue', 'failure_reasons', 'retry', 'paused', 'archived', 'persist']) {
    assert.ok(key in body, `${label}: TriageSummary 缺 required 键 ${key}`);
  }
  assert.ok(['syslog', 'poll'].includes(body.input_mode), `${label}: input_mode=${body.input_mode}`);
  for (const state of ['queued', 'running', 'done', 'failed']) {
    assert.ok(Number.isInteger(body.counts[state]), `${label}: counts.${state} 必须是整数`);
  }
  for (const verdict of ['threat', 'uncertain', 'false_positive', 'review']) {
    assert.ok(Number.isInteger(body.verdict_counts[verdict]), `${label}: verdict_counts.${verdict} 必须是整数`);
  }
  for (const key of ['depth', 'running', 'oldest_wait_ms', 'oldest_alert_id', 'retry_waiting']) {
    assert.ok(key in body.queue, `${label}: queue 缺 required 键 ${key}`);
  }
  for (const key of ['base_ms', 'max_ms', 'max_attempts', 'dead_letters']) {
    assert.ok(Number.isInteger(body.retry[key]), `${label}: retry.${key} 必须是整数`);
  }
  for (const key of ['active', 'since', 'received', 'buffered', 'dropped', 'replayed']) {
    assert.ok(key in body.paused, `${label}: paused 缺 required 键 ${key}`);
  }
  for (const key of ['count', 'ttl_ms']) assert.ok(Number.isInteger(body.archived[key]), `${label}: archived.${key}`);
  for (const key of ['interval_ms', 'unflushed']) assert.ok(key in body.persist, `${label}: persist 缺 ${key}`);
}

// ── C1 合法请求与主 schema 符合性 ────────────────────────────────────────────
test('C1 每条 operation 一条合法请求：入队 202 / 单条 200 / 汇总 200 / 列表 200 / 开关 200', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 1 });
  const base = await serve(t, monitor);

  // POST：202 + TriageCase（§3.1：「202 TriageCase」）
  const accepted = await post(base, triagePath(TID));
  assert.equal(accepted.status, 202);
  assertTriageCase(accepted.body, 'POST 回包');
  assert.equal(accepted.body.alert_id, TID);

  const done = await until(async () => {
    const { body } = await get(base, triagePath(TID));
    return body.status === 'done' ? body : null;
  }, { label: '研判跑完' });
  assertTriageCase(done, 'GET 单条');
  assert.equal(done.result_alert_id, TID);

  // GET status：200 + TriageSummary（openapi 该路径 200 → TriageSummary）
  const status = await get(base, '/api/agent/triage/status');
  assert.equal(status.status, 200);
  assertTriageSummary(status.body, 'GET status');
  assert.equal(status.body.counts.done, 1);
  // 现查记录（poll 入口、没有 syslog 报文）计入 unknown（openapi: type_counts 说明）
  assert.equal(status.body.type_counts.unknown, 1);

  // GET cases：200 + {total, cases}（§8.1）
  const cases = await get(base, '/api/agent/triage/cases');
  assert.equal(cases.status, 200);
  assert.ok(Number.isInteger(cases.body.total), 'cases.total 必须是整数');
  assert.ok(Array.isArray(cases.body.cases), 'cases.cases 必须是数组');

  // PUT control：200 + TriageSummary（openapi 该路径 200 → TriageSummary）
  const control = await put(base, '/api/agent/triage/control', { enabled: false });
  assert.equal(control.status, 200);
  assertTriageSummary(control.body, 'PUT control');
  assert.equal(control.body.enabled, false);
  const resumed = await put(base, '/api/agent/triage/control', { enabled: true });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.enabled, true);
});

// ── C2 路径 ID 的边界：解码失败与格式失败文案不同（§3.3）─────────────────────
test('C2 告警 ID 边界：编码失败/格式失败/未知类型/0 号/小数/合法 syslog 形态', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 0 });
  const base = await serve(t, monitor);

  // 解码失败 → 「告警 ID 编码无效」；校验失败 → 「告警 ID 无效」（§3.3 末段：两种文案不一样）
  const badEncoding = await get(base, '/api/agent/triage/%E0%A4%A');
  assert.equal(badEncoding.status, 400);
  assertErrorBody(badEncoding.body, '解码失败');
  assert.equal(badEncoding.body.error, '告警 ID 编码无效');

  // 序号必须是安全整数（§3.3 validAlertId）：超出 Number.MAX_SAFE_INTEGER 的一串数字也不是合法 ID
  for (const id of ['webshell-1', 'pirate:1', 'webshell:0', 'webshell:1.5', 'webshell:', 'webshell:9007199254740993']) {
    const bad = await get(base, triagePath(id));
    assert.equal(bad.status, 400, `ID ${id} 应该 400`);
    assertErrorBody(bad.body, `ID ${id}`);
    assert.equal(bad.body.error, '告警 ID 无效', `ID ${id} 的文案`);
  }

  // POST 走同一套校验（§3.1 路由表：两条都列 400）
  const badPost = await post(base, triagePath('pirate:1'));
  assert.equal(badPost.status, 400);
  assertErrorBody(badPost.body, 'POST 非法 ID');

  // 合法 syslog 形态（§3.3 validTriageId）没入队时应该是 200 not_queued，不是 400
  const syslogGet = await get(base, triagePath(SYSLOG_ID));
  assert.equal(syslogGet.status, 200);
  assertTriageCase(syslogGet.body, 'syslog 形态 GET');
  assert.equal(syslogGet.body.status, 'not_queued');
  assert.equal(syslogGet.body.alert_id, SYSLOG_ID);

  // 普通事件 ID 没入队时同样 200 not_queued（openapi：未入队时 status 为 not_queued）
  const unknown = await get(base, triagePath('webshell:4242'));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.status, 'not_queued');
});

// ── C3 现查记录进案件列表（P003-T060 起：poll/现查记录不再被 input 过滤掉，缺 input 的派生字段回 null）
test('C3 现查记录进 GET /cases（P003-T060 起），但单条可见、无 syslog/case_dir', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 1 });
  const base = await serve(t, monitor);

  assert.equal((await post(base, triagePath(TID))).status, 202);
  const done = await until(async () => {
    const { body } = await get(base, triagePath(TID));
    return body.status === 'done' ? body : null;
  }, { label: '研判跑完' });
  // §3.9：现查记录没有 input，所以没有 syslog / case_dir 键
  assert.equal(done.syslog, undefined);
  assert.equal(done.case_dir, undefined);

  const cases = await get(base, '/api/agent/triage/cases');
  assert.equal(cases.status, 200);
  assert.equal(cases.body.total, 1, '现查记录按 P003-T060 出现在案件列表里');
  assert.equal(cases.body.cases.length, 1);
  assert.equal(cases.body.cases[0].alert_id, TID);
  assert.equal(cases.body.cases[0].msgid, null, '缺 input 的派生字段如实回 null');
  assert.equal(cases.body.cases[0].case_dir, null);
});

// ── C4 取消：200 形状 / done 409 / 不存在 404（§3.1 + §5.4）──────────────────
test('C4 取消排队中的记录：200 恰三键；done 后 409；没有记录 404', async t => {
  const directory = await tempDir(t);
  const queuedMonitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 0 });
  const queuedBase = await serve(t, queuedMonitor);
  assert.equal((await post(queuedBase, triagePath(TID))).status, 202);
  const cancelled = await del(queuedBase, triagePath(TID));
  assert.equal(cancelled.status, 200);
  // openapi 该 operation：required [alert_id, status, cancelled] + additionalProperties: false
  assert.deepEqual(Object.keys(cancelled.body).sort(), ['alert_id', 'cancelled', 'status']);
  assert.equal(cancelled.body.alert_id, TID);
  assert.equal(cancelled.body.status, 'not_queued');
  assert.equal(cancelled.body.cancelled, true);
  // 取消后 GET 回 not_queued（openapi delete 描述）
  assert.equal((await get(queuedBase, triagePath(TID))).body.status, 'not_queued');

  // 不存在的记录 → 404（§3.1 DELETE 行）
  const missing = await del(queuedBase, triagePath('webshell:7777'));
  assert.equal(missing.status, 404);
  assertErrorBody(missing.body, 'DELETE 不存在');

  // 已 done → 409（§5.4：running / done → 409）
  const doneDir = await tempDir(t);
  const doneMonitor = makeMonitor({ directory: doneDir, investigator: fakeInvestigator(), concurrency: 1 });
  const doneBase = await serve(t, doneMonitor);
  assert.equal((await post(doneBase, triagePath(TID))).status, 202);
  await until(async () => (await get(doneBase, triagePath(TID))).body.status === 'done', { label: '跑完' });
  const conflict = await del(doneBase, triagePath(TID));
  assert.equal(conflict.status, 409);
  assertErrorBody(conflict.body, 'DELETE done');
});

// ── C5 误报登记：400 / 404 / 409 / 202 四条路（§3.4）─────────────────────────
test('C5 误报登记错误面与 202 形状：理由越界 400、无案件 404、未完成 409、done 后 202', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 1 });
  const base = await serve(t, monitor);
  const fpPath = id => `${triagePath(id)}/false-positive`;
  const LONG_REASON = '误'.repeat(4001);

  // 理由短于 10 / 长于 4000 → 400（§3.4 表）
  for (const [label, payload] of [['短理由', { reason: '太短' }], ['超长理由', { reason: LONG_REASON }]]) {
    const bad = await post(base, fpPath('webshell:7001'), payload);
    assert.equal(bad.status, 400, `${label} 应该 400`);
    assertErrorBody(bad.body, label);
  }
  // 登记人短于 2 字 → 400
  const badWho = await post(base, fpPath('webshell:7001'), { reason: '这是一段足够长的误报理由', who: 'x' });
  assert.equal(badWho.status, 400);
  assertErrorBody(badWho.body, '短登记人');
  // 正文不是对象 → 400
  const notObject = await post(base, fpPath('webshell:7001'), 'not-an-object');
  assert.equal(notObject.status, 400);
  assertErrorBody(notObject.body, '非对象正文');
  // 没有这条案件 → 404
  const noCase = await post(base, fpPath('webshell:7002'), { reason: '这是一段足够长的误报理由' });
  assert.equal(noCase.status, 404);
  assertErrorBody(noCase.body, '无此案件');

  // 还没跑完（queued）→ 409
  const queuedDir = await tempDir(t);
  const queuedMonitor = makeMonitor({ directory: queuedDir, investigator: fakeInvestigator(), concurrency: 0 });
  const queuedBase = await serve(t, queuedMonitor);
  assert.equal((await post(queuedBase, triagePath('webshell:7003'))).status, 202);
  const early = await post(queuedBase, fpPath('webshell:7003'), { reason: '这是一段足够长的误报理由' });
  assert.equal(early.status, 409);
  assertErrorBody(early.body, '未完成登记误报');

  // done 之后 202：FalsePositiveRecord 形状（openapi FalsePositiveRecord）
  assert.equal((await post(base, triagePath('webshell:7001'))).status, 202);
  await until(async () => (await get(base, triagePath('webshell:7001'))).body.status === 'done', { label: '跑完' });
  const accepted = await post(base, fpPath('webshell:7001'), { reason: '这条是运维例行操作，不是威胁', who: '何东阳' });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.alert_id, 'webshell:7001');
  assert.equal(accepted.body.verdict.verdict, 'false_positive');
  assert.equal(accepted.body.verdict.verdict_label, '误报');
  assert.equal(accepted.body.verdict.source, 'human');
  assert.equal(accepted.body.feedback.reason, '这条是运维例行操作，不是威胁');
  assert.equal(accepted.body.feedback.who, '何东阳');
  assert.ok(!Number.isNaN(Date.parse(accepted.body.feedback.recorded_at)), 'feedback.recorded_at 应该是时间');
  assert.ok(['updating', 'updated', 'failed'].includes(accepted.body.maintenance.status), 'maintenance.status 三态之一');
  assert.ok(['updating', 'updated', 'failed'].includes(accepted.body.maintenance.rule.status), 'maintenance.rule.status');
  assert.ok(['updating', 'updated', 'failed'].includes(accepted.body.maintenance.wiki.status), 'maintenance.wiki.status');

  // 结论已落盘：单条查询立刻是误报（§3.4「先结论，后维护」）
  const after = await get(base, triagePath('webshell:7001'));
  assert.equal(after.body.verdict, 'false_positive');
  assert.equal(after.body.decision_source, 'human');
});

// ── C5b 误报理由与登记人的闭区间边界（§3.4：10 到 4000 字 / 登记人至少 2 字）──────
test('C5b 误报理由恰 10 字、恰 4000 字、登记人恰 2 字：都该被收下（202）', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 1 });
  const base = await serve(t, monitor);
  const fpPath = id => `${triagePath(id)}/false-positive`;

  const cases = [
    ['webshell:7101', '误'.repeat(10), undefined],
    ['webshell:7102', '误'.repeat(4000), undefined],
    ['webshell:7103', '这是一段足够长的误报理由', '甲二'],
  ];
  for (const [id, reason, who] of cases) {
    assert.equal((await post(base, triagePath(id))).status, 202);
    await until(async () => (await get(base, triagePath(id))).body.status === 'done', { label: `${id} 跑完` });
    const response = await post(base, fpPath(id), who === undefined ? { reason } : { reason, who });
    assert.equal(response.status, 202, `${id} 的边界值应该收下，实测 ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.feedback.reason, reason);
    if (who !== undefined) assert.equal(response.body.feedback.who, who);
  }
});

// ── C6 队列满 429（§3.1 POST 行 + §5.4）─────────────────────────────────────
test('C6 队列（排队 + 在跑）满上限：POST 回 429 与文档文案，并计入 summary().dropped', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 0, queueLimit: 1 });
  const base = await serve(t, monitor);

  assert.equal((await post(base, triagePath('honeypot:1'))).status, 202);
  const full = await post(base, triagePath('honeypot:2'));
  assert.equal(full.status, 429);
  assertErrorBody(full.body, '队列满');
  // 文案口径：§3.1「研判队列已满（上限 N），稍后再试」；openapi TooManyRequests 同句
  assert.match(full.body.error, /研判队列已满（上限 1），稍后再试/);

  const status = await get(base, '/api/agent/triage/status');
  assert.equal(status.body.dropped, 1, '被拒的入队要计入 dropped');
  assert.equal(status.body.queue.depth, 1, '被拒的那条不建记录');
  assert.equal((await get(base, triagePath('honeypot:2'))).body.status, 'not_queued');
});

// ── C7 未装配研判队列：七条路由全 503（§3.1）─────────────────────────────────
test('C7 没配研判队列：triage 七条路由全 503 not_configured + Error 形状', async t => {
  const base = await serve(t, null);
  const routes = [
    ['GET', '/api/agent/triage/status'],
    ['GET', '/api/agent/triage/cases'],
    ['GET', triagePath('webshell:1')],
    ['POST', triagePath('webshell:1')],
    ['DELETE', triagePath('webshell:1')],
    ['POST', `${triagePath('webshell:1')}/false-positive`],
    ['PUT', '/api/agent/triage/control'],
  ];
  for (const [method, pathname] of routes) {
    const response = await call(base, pathname, { method });
    assert.equal(response.status, 503, `${method} ${pathname} 应该 503`);
    assertErrorBody(response.body, `${method} ${pathname}`);
    assert.equal(response.body.code, 'not_configured', `${method} ${pathname} 的 code`);
  }
});

// ── C8 案件列表的筛选与分页边界（§8.1）───────────────────────────────────────
test('C8 GET /cases 筛选与分页边界：非法值一律 400，合法组合 200', async t => {
  const directory = await tempDir(t);
  const monitor = makeMonitor({ directory, investigator: fakeInvestigator(), concurrency: 0 });
  const base = await serve(t, monitor);

  const bad = [
    ['verdict=bogus', /筛选结论无效/],
    ['type=pirate', /筛选事件类型无效/],
    ['count=51', /分页参数无效/],
    ['offset=-1', /分页参数无效/],
    ['from=2026-11-17T10:00:00Z&to=2026-11-16T10:00:00Z', /筛选起始时间晚于结束时间/],
  ];
  for (const [query, pattern] of bad) {
    const response = await get(base, `/api/agent/triage/cases?${query}`);
    assert.equal(response.status, 400, `${query} 应该 400`);
    assertErrorBody(response.body, query);
    assert.match(response.body.error, pattern, `${query} 的文案`);
  }

  const ok = await get(base, '/api/agent/triage/cases?verdict=threat,uncertain&sort=verdict&count=1&offset=0');
  assert.equal(ok.status, 200);
  assert.ok(Number.isInteger(ok.body.total));
  assert.ok(Array.isArray(ok.body.cases));
});
