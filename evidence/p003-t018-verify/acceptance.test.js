// P003-T018 黑盒验收（tester 何东阳）：只按 docs/api（openapi.yaml）+ docs/modules/http-api.md 断言，
// 全程走真 HTTP + 真 TriageMonitor，不碰实现文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../server.js';
import { TriageMonitor } from '../../triage-monitor.js';
import { InvestigationStore } from '../../investigation-store.js';

const TRIAGE_ID = 'honeypot:11';

const verdictOf = (verdict, verdictLabel, summary, evidenceId) => ({
  verdict: { verdict, verdict_label: verdictLabel, summary, report: `${summary}的报告`,
    missing_evidence: [`缺${summary}`], next_actions: [`办${summary}`] },
  evidence: [{ evidence_id: evidenceId, tool: 'get_honeypot_event', args: {}, fetched_at: '2026-11-19T01:00:01.000Z',
    sha256: 'c'.repeat(64) }],
  validation: { ok: true }
});

async function boot(t, { verdicts, monitor: provided } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 't18-blackbox-'));
  const runs = [];
  const monitor = provided || new TriageMonitor({
    file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => {
      runs.push(id);
      const next = verdicts[Math.min(runs.length - 1, verdicts.length - 1)];
      return { alert_id: id, mode, ...next };
    } }
  });
  if (!provided) await monitor.load();
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // 收尾顺序：先等在途落盘 → 再关服务 → 最后删临时目录（反了会 rm 撞上写，留下 ENOTEMPTY）
  t.after(async () => {
    await monitor.writeChain?.catch(() => {});
    // 未读完的响应体会让 keep-alive 连接挂住 server.close()，先把连接全掐掉再关
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }).catch(() => {});
  });
  return { base: `http://127.0.0.1:${server.address().port}`, monitor, runs, directory };
}

const pathOf = id => `/api/agent/triage/${encodeURIComponent(id)}`;
// 只关心状态码的地方也把正文读掉：不然 keep-alive 连接留着，收尾会挂
const retry = async base => {
  const response = await fetch(`${base}${pathOf(TRIAGE_ID)}`, { method: 'POST' });
  await response.clone().text();
  return response;
};
const falsePositive = async (base, body = { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' }) => {
  const response = await fetch(`${base}${pathOf(TRIAGE_ID)}/false-positive`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await response.clone().text();
  return response;
};

async function getCase(base, id = TRIAGE_ID) {
  const response = await fetch(`${base}${pathOf(id)}`);
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, label, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const waitStatus = (base, wanted, id = TRIAGE_ID) =>
  waitFor(async () => (await getCase(base, id)).body.status === wanted, `status=${wanted}`);

// ── A1：人工误报经真入口登记后重跑，结论区不被覆盖 ─────────────────────
test('A1 走真 HTTP：误报登记后重试，verdict/verdict_label/summary/decision_source/feedback 原样，报告与证据刷新', async t => {
  const { base, runs } = await boot(t, { verdicts: [
    verdictOf('uncertain', '存疑', '首判存疑', 'cw:1'),
    verdictOf('threat', '真实威胁', '重跑认为是真实威胁', 'cw:2')
  ] });

  // 1) 入队（openapi retryTriage 202 → TriageCase）
  const enqueued = await retry(base);
  assert.equal(enqueued.status, 202);
  const queuedBody = await enqueued.json();
  assert.equal(queuedBody.alert_id, TRIAGE_ID);
  assert.ok(['queued', 'running'].includes(queuedBody.status), `202 正文 status=${queuedBody.status}`);

  await waitStatus(base, 'done');
  const first = (await getCase(base)).body;
  assert.equal(first.verdict, 'uncertain');
  assert.equal(first.decision_source, 'ai');
  assert.equal(first.summary, '首判存疑');

  // 2) 误报入口（docs http-api.md §3.4：202 {alert_id, verdict, feedback, maintenance}）
  const reported = await falsePositive(base);
  assert.equal(reported.status, 202);
  const reportBody = await reported.json();
  assert.equal(reportBody.alert_id, TRIAGE_ID);
  assert.equal(reportBody.verdict.verdict, 'false_positive');
  assert.equal(reportBody.verdict.verdict_label, '误报');
  assert.equal(reportBody.verdict.source, 'human');
  assert.deepEqual(Object.keys(reportBody.feedback).sort(), ['reason', 'recorded_at', 'who']);

  // 3) 重试
  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  await waitFor(async () => (await getCase(base)).body.attempts === 2, 'attempts=2');
  assert.equal(runs.length, 2);

  const after = (await getCase(base)).body;
  // TriageCase 描述：人工登记误报后 verdict 就是 false_positive，此后重试也不会被那次研判改回去
  assert.equal(after.verdict, 'false_positive');
  assert.equal(after.verdict_label, '误报');
  assert.equal(after.decision_source, 'human');
  // openapi retryTriage：summary 也原样保留（这里保留的是误报登记当时记录上那份 AI 摘要）
  assert.equal(after.summary, '首判存疑');
  assert.deepEqual(after.feedback, { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员',
    recorded_at: after.feedback.recorded_at });
  assert.match(after.feedback.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  // docs triage-pipeline §7.4：detail 跟着保留的那份 summary 走
  assert.equal(after.detail, '首判存疑');
  // 不是整块跳过：报告 / 缺证 / 下一步 / 证据 / 存盘时刻按这次研判刷新
  assert.equal(after.report, '重跑认为是真实威胁的报告');
  assert.deepEqual(after.missing_evidence, ['缺重跑认为是真实威胁']);
  assert.deepEqual(after.next_actions, ['办重跑认为是真实威胁']);
  assert.equal(after.evidence.length, 1);
  assert.equal(after.evidence[0].evidence_id, 'cw:2');
  assert.notEqual(after.saved_at, first.saved_at);
});

// ── A2：没标误报的记录，重跑照旧覆盖 ─────────────────────────────────
test('A2 走真 HTTP：没标误报的记录重试后结论区换成这次研判的', async t => {
  const { base, runs } = await boot(t, { verdicts: [
    verdictOf('uncertain', '存疑', '首判存疑', 'cw:6'),
    verdictOf('threat', '真实威胁', '重跑认定为威胁', 'cw:7')
  ] });
  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  assert.equal((await getCase(base)).body.verdict, 'uncertain');

  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  await waitFor(async () => (await getCase(base)).body.attempts === 2, 'attempts=2');
  const after = (await getCase(base)).body;
  assert.equal(runs.length, 2);
  assert.equal(after.verdict, 'threat');
  assert.equal(after.verdict_label, '真实威胁');
  assert.equal(after.summary, '重跑认定为威胁');
  assert.equal(after.decision_source, 'ai');
  assert.equal(after.detail, '重跑认定为威胁');
  assert.equal(after.feedback, undefined);
});

// ── A1 口径钉子：AI 自己判出的 false_positive 照旧被覆盖 ──────────────
test('钉子：AI 自判 false_positive（decision_source=ai）重试后仍被这次研判覆盖', async t => {
  const { base, runs } = await boot(t, { verdicts: [
    verdictOf('false_positive', '误报', 'AI 首判误报', 'cw:4'),
    verdictOf('threat', '真实威胁', 'AI 重跑改判威胁', 'cw:5')
  ] });
  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  const first = (await getCase(base)).body;
  assert.equal(first.verdict, 'false_positive');
  assert.equal(first.decision_source, 'ai');
  assert.equal(first.feedback, undefined);

  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  await waitFor(async () => (await getCase(base)).body.attempts === 2, 'attempts=2');
  const after = (await getCase(base)).body;
  assert.equal(runs.length, 2);
  assert.equal(after.verdict, 'threat');
  assert.equal(after.verdict_label, '真实威胁');
  assert.equal(after.summary, 'AI 重跑改判威胁');
  assert.equal(after.decision_source, 'ai');
});

// ── 持久化：保住的人工结论重载后仍在（enqueue 的五项要随 persist 落盘） ──
test('误报登记 + 重跑后重启进程，结论与 feedback 重载后仍在', async t => {
  const { base, monitor, directory, runs } = await boot(t, { verdicts: [
    verdictOf('uncertain', '存疑', '首判存疑', 'cw:1'),
    verdictOf('threat', '真实威胁', '重跑认为是真实威胁', 'cw:2')
  ] });
  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  assert.equal((await falsePositive(base)).status, 202);
  assert.equal((await retry(base)).status, 202);
  await waitStatus(base, 'done');
  await waitFor(async () => (await getCase(base)).body.attempts === 2, 'attempts=2');
  assert.equal(runs.length, 2);

  const reloaded = new TriageMonitor({
    file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async () => { throw new Error('重载后不该再跑研判'); } }
  });
  await reloaded.load();
  const record = reloaded.status(TRIAGE_ID);
  assert.equal(record.verdict, 'false_positive');
  assert.equal(record.verdict_label, '误报');
  assert.equal(record.decision_source, 'human');
  assert.equal(record.feedback.reason, '运维的蜜罐探针，不是攻击');
  assert.equal(record.summary, '首判存疑');
  assert.equal(record.report, '重跑认为是真实威胁的报告');
  assert.equal(monitor.status(TRIAGE_ID).verdict, 'false_positive');
});

// ── 错误码与响应体形状（openapi retryTriage / reportFalsePositive + §3.4 表） ──
test('错误码：重试与误报登记的 400/404/409 都给出 Error 形状的正文', async t => {
  const { base } = await boot(t, { verdicts: [verdictOf('uncertain', '存疑', '首判存疑', 'cw:1')] });
  const errorOf = async response => {
    assert.ok(response.headers.get('content-type')?.includes('application/json'), `content-type=${response.headers.get('content-type')}`);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['error'], `正文形状=${JSON.stringify(body)}`);
    assert.equal(typeof body.error, 'string');
    return body.error;
  };

  // 重试：ID 格式无效 400（http-api §3.3）
  const badId = await fetch(`${base}/api/agent/triage/bad-id`, { method: 'POST' });
  assert.equal(badId.status, 400);
  assert.equal(await errorOf(badId), '告警 ID 无效');

  // 重试：ID 编码无效 400
  const badEncode = await fetch(`${base}/api/agent/triage/%E0%A4%A`, { method: 'POST' });
  assert.equal(badEncode.status, 400);
  assert.equal(await errorOf(badEncode), '告警 ID 编码无效');

  // openapi retryTriage summary 是「手动入队或重试」：没有记录的 ID 也入队，回 202
  const fresh = await fetch(`${base}/api/agent/triage/honeypot%3A999999`, { method: 'POST' });
  assert.equal(fresh.status, 202);
  const freshBody = await fresh.json();
  assert.equal(freshBody.alert_id, 'honeypot:999999');
  assert.ok(['queued', 'running'].includes(freshBody.status));
  await waitStatus(base, 'done', 'honeypot:999999');

  // 重试：syslog 前缀但没有原始报文。
  // 文档自相矛盾（finding T18-F1，既有行为，与本卡无关）：triage-pipeline §5.4 说 enqueue 抛 404、
  // openapi retryTriage 列了 404，但 http-api.md:353 说「含『请求正文』→400，其余→502」，实测走的是 502。
  const noRaw = await fetch(`${base}/api/agent/triage/syslog%3Ahoneypot%3Aaaaaaaaaaaaaaaaa%3A1763392800%3A6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43`,
    { method: 'POST' });
  assert.equal(noRaw.status, 502, 'triage-pipeline §5.4 / openapi 承诺 404，实测 502（T18-F1）');
  assert.equal(await errorOf(noRaw), '该 syslog 告警的原始报文不存在，无法重试');

  // 误报登记：理由必填 / 10 字下限 / 4000 字上限 / 登记人 2 字下限 / 正文不是对象 → 400
  const reasonMissing = await falsePositive(base, { who: '值班分析员' });
  assert.equal(reasonMissing.status, 400);
  await errorOf(reasonMissing);
  const tooShort = await falsePositive(base, { reason: '太短了', who: '值班分析员' });
  assert.equal(tooShort.status, 400);
  assert.equal(await errorOf(tooShort), '误报理由必须为 10 到 4000 字');
  const tooLong = await falsePositive(base, { reason: 'x'.repeat(4001), who: '值班分析员' });
  assert.equal(tooLong.status, 400);
  assert.equal(await errorOf(tooLong), '误报理由必须为 10 到 4000 字');
  const whoShort = await falsePositive(base, { reason: '运维的蜜罐探针，不是攻击', who: 'x' });
  assert.equal(whoShort.status, 400);
  await errorOf(whoShort);
  const notObject = await fetch(`${base}${pathOf(TRIAGE_ID)}/false-positive`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '"just-a-string"' });
  assert.equal(notObject.status, 400);
  await errorOf(notObject);

  // 误报登记：记录不存在 404
  const noCase = await fetch(`${base}/api/agent/triage/honeypot%3A999998/false-positive`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '运维的蜜罐探针，不是攻击' }) });
  assert.equal(noCase.status, 404);
  assert.equal(await errorOf(noCase), '找不到这条研判案件');

  // 误报登记：记录还没跑完 → 409
  await retry(base);
  const running = await falsePositive(base);
  assert.equal(running.status, 409);
  assert.equal(await errorOf(running), '研判还没结束，不能登记误报');
  await waitStatus(base, 'done');
  // 409 拒了之后记录上不该留 feedback（docs §3.4：先校验，再写结论）
  const clean = (await getCase(base)).body;
  assert.equal(clean.feedback, undefined);
  assert.equal(clean.decision_source, 'ai');
});

// ── 边界上限：恰好 10 字 / 恰好 4000 字 / 登记人 100 字都收 ─────────────
test('边界：理由恰好 10 字与 4000 字、登记人恰好 100 字都能登记（202）', async t => {
  const { base, monitor } = await boot(t, { verdicts: [verdictOf('uncertain', '存疑', '首判存疑', 'cw:1')] });
  await retry(base);
  await waitStatus(base, 'done');
  const tenChars = '蜜罐探针误报啊啊啊啊';
  assert.equal([...tenChars].length, 10);
  const accepted = await falsePositive(base, { reason: tenChars, who: '值'.repeat(100) });
  assert.equal(accepted.status, 202);
  const body = await accepted.json();
  assert.equal(body.feedback.reason, tenChars);
  assert.equal(body.feedback.who, '值'.repeat(100));

  // 同一记录上再来一次 4000 字（已在维护/或已误报，§3.4：重复登记只回当前进度）
  const long = '误'.repeat(4000);
  const second = await falsePositive(base, { reason: long, who: '值班分析员' });
  assert.equal(second.status, 202);
  await monitor.writeChain;
});

// ── 没有研判队列：503（http-api §3.4 表「研判队列未配置」） ──────────────
test('没有研判队列时误报登记回 503，正文是 Error 形状', async t => {
  const server = createServer(null, null, null, null, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}${pathOf(TRIAGE_ID)}/false-positive`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '运维的蜜罐探针，不是攻击' }) });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, { error: '自动研判尚未配置' });
  // 重试入口的同一前置条件（http-api.md §3.1 路由表：POST /api/agent/triage/{alertId} 无研判队列回 503）
  const retryNoMonitor = await fetch(`${base}${pathOf(TRIAGE_ID)}`, { method: 'POST' });
  assert.equal(retryNoMonitor.status, 503);
  assert.deepEqual(await retryNoMonitor.json(), { error: '自动研判尚未配置' });
});

// ── 重试语义：正在运行的任务不会重复启动（openapi retryTriage 202 描述） ──────
test('重试：研判正在跑时再 POST 只回 202，不重复启动研判', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runs = [];
  const directory = await mkdtemp(path.join(tmpdir(), 't18-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }).catch(() => {}));
  const monitor = new TriageMonitor({
    file: path.join(directory, 'queue.json'), concurrency: 1,
    history: new InvestigationStore(path.join(directory, 'results')),
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    investigator: { run: async (id, { mode }) => {
      runs.push(id); await gate;
      return { alert_id: id, mode, ...verdictOf('uncertain', '存疑', '首判存疑', 'cw:9') };
    } }
  });
  await monitor.load();
  const { base } = await boot(t, { monitor });
  assert.equal((await retry(base)).status, 202);
  // 等「研判真的被调起来」再打第二次：只等 status=running 会有窗口（状态先变、investigator 还没进）
  await waitFor(() => runs.length === 1, '研判已启动');
  assert.notEqual((await getCase(base)).body.status, 'done');
  const again = await retry(base);
  assert.equal(again.status, 202);
  assert.ok(['queued', 'running'].includes((await again.json()).status));
  assert.equal(runs.length, 1);
  release();
  await waitStatus(base, 'done');
  assert.equal(runs.length, 1);
  assert.equal((await getCase(base)).body.verdict, 'uncertain');
});
