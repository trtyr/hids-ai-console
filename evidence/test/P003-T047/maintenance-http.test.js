// P003-T047 单测（HTTP 面）：误报入口的补跑入参、维护侧映射、维护会话查询两条路由。
// 台子与 agent-api.test.js 同口径：真 createServer + 假 monitor，维护 Agent 换替身（只验接线与契约）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../../../server.js';
import { FP_AUTO_VERDICT, FpSessionStore } from '../../../fp-maintainer.js';

const ALERT_ID = 'syslog:honeypot:0123456789abcdef:1763373600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
const FP_PATH = `/api/agent/triage/${encodeURIComponent(ALERT_ID)}/false-positive`;

function fakeMonitor() {
  const record = { alert_id: ALERT_ID, status: 'done', verdict: 'threat', verdict_label: '真实威胁', decision_source: 'ai',
    case_dir: null, steps: [], evidence: [], input: { raw: 'x', parsed: { msgid: 'cloudwalker-honeypot', payload: {} } } };
  return {
    records: new Map([[ALERT_ID, record]]), persisted: 0,
    status(id) { const found = this.records.get(id); return found ? { ...found } : null; },
    async persist() { this.persisted += 1; }
  };
}

// 替身维护 Agent：照会话形制回一份 outcome（被调用时把入参记下来，供断言「补跑只跑请求的库」）。
function fakeMaintainer(outcomes) {
  const calls = [];
  return { calls, async maintain(args) {
    calls.push(args);
    return { id: randomUUID(), case_id: args.caseId, status: 'done', terminal: true,
      auto_verdict: { ...FP_AUTO_VERDICT }, decision: { source: 'model', libraries: args.libraries, why: '替身决策' },
      outcomes: outcomes(args), turns: [], messages: [], created_at: '2026-11-19T00:00:00.000Z',
      updated_at: '2026-11-19T00:00:00.000Z' };
  } };
}

const listen = async (server, t) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};
const post = (base, body) => fetch(`${base}${FP_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) });
const waitFor = async (check, label) => {
  for (let n = 0; n < 200; n += 1) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`等待超时：${label}`);
};

const stack = async (t, outcomes) => {
  const monitor = fakeMonitor();
  const sessions = new FpSessionStore(path.join(await mkdtemp(path.join(tmpdir(), 'p003-t047-http-')), 'fp-sessions'));
  const maintainer = fakeMaintainer(outcomes);
  const server = createServer(null, null, null, null, null, monitor, null, undefined, null, null,
    undefined, undefined, null, null, null, null, undefined, undefined, undefined, sessions, null, maintainer);
  const base = await listen(server, t);
  return { base, monitor, sessions, maintainer };
};

const updated = () => ({ library: 'rule', state: 'updated', status: 'updated', why: '替身',
  id: 'honeypot_probe', file: 'honeypot_probe.rego', action: 'update', revision: 'abcdef0123456789' });

test('A2/A7 202 之后的维护侧：动了哪边、为什么、会话 id 与待启用的自动判定都在 record.maintenance 上', async t => {
  const { base, monitor, maintainer } = await stack(t, args => ({
    rule: updated(),
    wiki: { library: 'wiki', state: 'failed', status: 'failed', error: '上游 502', revision: null }
  }));
  const res = await post(base, { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' });
  assert.equal(res.status, 202, await res.text());
  await waitFor(() => monitor.records.get(ALERT_ID).maintenance.status !== 'updating', '维护收尾');

  const maintenance = monitor.records.get(ALERT_ID).maintenance;
  assert.deepEqual(maintenance.sides, ['rule'], '动了哪边没记对');
  assert.equal(maintenance.decision.why, '替身决策');
  assert.equal(maintenance.rule.file, 'honeypot_probe.rego');
  assert.equal(maintenance.rule.action, 'update');
  assert.equal(maintenance.rule.state, 'updated');
  assert.equal(maintenance.wiki.state, 'failed');
  assert.equal(maintenance.wiki.error, '上游 502');
  assert.equal(maintenance.status, 'failed', '单边失败总态应算失败');
  assert.deepEqual(maintenance.auto_verdict, { ...FP_AUTO_VERDICT });
  assert.equal(typeof maintenance.session_id, 'string');
  assert.deepEqual(maintainer.calls[0].libraries, ['rule', 'wiki']);
  // 结论不被维护结果改写（T013 契约照旧）
  assert.equal(monitor.records.get(ALERT_ID).verdict, 'false_positive');
});

test('A4 单腿补跑：正文 libraries 只跑请求的那一侧，另一侧标 skipped 不谎报成改完了', async t => {
  const { base, monitor, maintainer } = await stack(t, args => ({
    wiki: { library: 'wiki', state: 'updated', status: 'updated', why: '替身', page: 'honeypot/HP-10.md',
      pages: ['honeypot/HP-10.md'], revision: '0123abcd4567ef89' }
  }));
  const res = await post(base, { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员', libraries: ['wiki'] });
  assert.equal(res.status, 202, await res.text());
  await waitFor(() => monitor.records.get(ALERT_ID).maintenance.status !== 'updating', '补跑收尾');

  assert.deepEqual(maintainer.calls[0].libraries, ['wiki']);
  const maintenance = monitor.records.get(ALERT_ID).maintenance;
  assert.equal(maintenance.wiki.state, 'updated');
  assert.equal(maintenance.rule.state, 'skipped');
  assert.match(maintenance.rule.why, /未执行/);
  assert.equal(maintenance.status, 'updated');
  assert.deepEqual(maintenance.libraries, ['wiki']);
});

test('A4 维护库入参：非数组、空数组、未知库名一律 400，且不落半份维护状态', async t => {
  const { base, monitor } = await stack(t, () => ({ rule: updated() }));
  for (const libraries of [['dns'], [], 'rule', ['rule', 'wiki', 'x'], [1]]) {
    const res = await post(base, { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员', libraries });
    const body = await res.json();
    assert.equal(res.status, 400, `libraries=${JSON.stringify(libraries)} 没有 400：${JSON.stringify(body)}`);
    assert.equal(body.error, '维护库必须是 rule 或 wiki 组成的一到两项');
  }
  assert.equal(monitor.records.get(ALERT_ID).maintenance, undefined, '入参不合法却已经写了维护状态');

  // 契约是 openapi 的 `uniqueItems: true`（F1 审计）：重复项 400，且不静默去重放行
  const dup = await post(base, { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员', libraries: ['rule', 'rule'] });
  const dupBody = await dup.json();
  assert.equal(dup.status, 400, `重复库没有 400：${JSON.stringify(dupBody)}`);
  assert.equal(dupBody.error, '维护库不能重复（libraries 每一项只能出现一次）');
  assert.equal(dupBody.code, 'caller_error');
  assert.equal(monitor.records.get(ALERT_ID).maintenance, undefined, '重复库被拒之前已经起了维护轮');
});

test('A1 维护会话查询：列表按 updated_at 倒序、单条可读全文、坏 ID 400、不存在 404', async t => {
  const { base, sessions } = await stack(t, () => ({ rule: updated() }));
  const write = async (id, at, extra = {}) => sessions.save({ id, case_id: ALERT_ID, event_type: 'honeypot', who: '值班分析员',
    status: 'done', terminal: true, libraries_requested: ['rule'], turns: [], messages: [],
    outcomes: { rule: updated() }, decision: { source: 'model', libraries: ['rule'], why: 'x' },
    auto_verdict: { ...FP_AUTO_VERDICT }, created_at: at, updated_at: at, ...extra });
  const older = randomUUID();
  const newer = randomUUID();
  await write(older, '2026-11-18T00:00:00.000Z');
  await write(newer, '2026-11-19T00:00:00.000Z');

  const list = await (await fetch(`${base}/api/false-positive/sessions`)).json();
  assert.deepEqual(list.sessions.map(item => item.id), [newer, older]);
  assert.equal(list.sessions[0].terminal, true);
  assert.deepEqual(list.sessions[0].sides, ['rule']);

  const one = await fetch(`${base}/api/false-positive/sessions/${newer}`);
  assert.equal(one.status, 200);
  const body = await one.json();
  assert.equal(body.id, newer);
  assert.deepEqual(body.outcomes.rule.file, 'honeypot_probe.rego');

  assert.equal((await fetch(`${base}/api/false-positive/sessions/not-a-uuid`)).status, 400);
  assert.equal((await fetch(`${base}/api/false-positive/sessions/${randomUUID()}`)).status, 404);
});
