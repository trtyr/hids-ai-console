// P003-T047 复审判词的回归：三条 major 里两条（单腿补跑洗掉幂等判据、单侧 error 未擦凭据）
// 只有在**路由 + 真 Agent + 真库**整链上才复现——单测台子直接调 maintain() 会绕过 server.js 的重置逻辑。
//
// 这里用真 createServer：monitor 是假的（只提供 records / persist），wiki / 规则库 / 两个维护者 / 维护会话库都是真的，
// 决策模型不配（走 fallback，按请求的库逐个尝试——与判词探针同一套行为）。
// 全局根隔离（P003-T050 A2）：本文件触发写接口 → 产生审计事件（P003-T062），必须先隔离数据根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../../server.js';
import { FP_DECISION_SOURCES } from '../../../fp-maintainer.js';
import { CASE_ID, REASON, TARGET_PAGE, WHO, stack } from './helpers.js';

const FP_PATH = `/api/agent/triage/${encodeURIComponent(CASE_ID)}/false-positive`;

function fakeMonitor(caseDir) {
  const record = { alert_id: CASE_ID, status: 'done', verdict: 'threat', verdict_label: '真实威胁', decision_source: 'ai',
    case_dir: caseDir, steps: [], evidence: [], updated_at: '2026-11-18T03:00:00.000Z',
    input: { raw: 'raw-line', parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-18T03:00:00Z',
      payload: { host_ip: '172.20.208.23', source_ip: '203.0.113.9' } } } };
  return {
    records: new Map([[CASE_ID, record]]), persisted: 0,
    status(id) { const found = this.records.get(id); return found ? { ...found } : null; },
    async persist() { this.persisted += 1; }
  };
}

const waitFor = async (check, label) => {
  for (let n = 0; n < 400; n += 1) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`等待超时：${label}`);
};

async function rig(t, options = {}) {
  const s = await stack(options);
  const monitor = fakeMonitor(s.caseDir);
  const server = createServer(null, null, null, null, null, monitor, null, undefined, null, null,
    s.wiki, s.wikiAgent, null, null, s.ruleStore, s.ruleMaintainer, undefined, undefined, undefined,
    s.sessions, null, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = async libraries => {
    const res = await fetch(`${base}${FP_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: REASON, who: WHO, ...(libraries ? { libraries } : {}) }) });
    assert.equal(res.status, 202, await res.text());
    // 维护跑在后台：等这一轮收尾（status 离开 updating）
    await waitFor(() => monitor.records.get(CASE_ID).maintenance?.status !== 'updating', '维护收尾');
    return monitor.records.get(CASE_ID).maintenance;
  };
  return { s, monitor, base, report };
}

test('major③ 成功 → 单腿补跑 → 全量再登记：已成功的一侧不被重跑（ruleCalls 保持 1）', async t => {
  const { s, report } = await rig(t, { decide: () => JSON.stringify({ libraries: ['rule', 'wiki'], why: '两侧都要改' }) });

  const first = await report();
  assert.equal(first.rule.state, 'updated', JSON.stringify(first.rule));
  assert.equal(first.wiki.state, 'updated', JSON.stringify(first.wiki));
  assert.deepEqual(first.sides, ['rule', 'wiki']);
  assert.ok(FP_DECISION_SOURCES.includes(first.decision.source), `决策来源越界：${first.decision.source}`);
  const ruleRevision = first.rule.revision;
  const pageRevision = first.wiki.revision;
  assert.match(ruleRevision, /^[0-9a-f]{16}$/);
  assert.equal(s.ruleCalls, 1);
  assert.equal(s.wikiCalls, 1);

  // 单腿补跑：只请求知识库。规则侧没请求 → skipped，但**判定字段必须还在**
  const second = await report(['wiki']);
  assert.equal(second.rule.state, 'skipped', JSON.stringify(second.rule));
  assert.equal(second.rule.revision, ruleRevision, '单腿补跑把规则侧的 revision 洗掉了');
  assert.equal(second.rule.idempotency_key, first.rule.idempotency_key, '单腿补跑把幂等键洗掉了');
  assert.equal(second.wiki.revision, pageRevision);
  assert.equal(s.ruleCalls, 1, '单腿补跑叫了规则维护者');
  assert.equal(s.wikiCalls, 1, '知识库已在同一版本上，补跑不该再调模型');

  // 全量再登记：两侧都在同一版本 → 全跳，规则不再跑第二遍（判词探针正是 1→2 那条序列）
  const third = await report();
  assert.equal(third.rule.state, 'skipped', JSON.stringify(third.rule));
  assert.equal(third.rule.revision, ruleRevision);
  assert.equal(third.wiki.state, 'skipped', JSON.stringify(third.wiki));
  assert.equal(third.decision.source, 'idempotent', `决策来源应为 idempotent：${third.decision.source}`);
  assert.deepEqual(third.sides, []);
  assert.equal(s.ruleCalls, 1, '全量再登记把已成功的一侧重跑了');
  assert.equal(s.wikiCalls, 1);
});

test('major② 单侧失败的 error 落进 record.maintenance 之前先擦凭据，且失败侧仍可单腿补跑', async t => {
  const { s, report } = await rig(t, { decide: () => JSON.stringify({ libraries: ['rule', 'wiki'], why: '两侧都要改' }),
    ruleMode: 'authError' });

  const failed = await report();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.rule.state, 'failed');
  assert.equal(failed.wiki.state, 'updated');
  assert.match(failed.rule.error, /401/, `失败原因没留下：${failed.rule.error}`);
  assert.match(failed.rule.error, /\[redacted\]/, `凭据没被擦：${failed.rule.error}`);
  assert.equal(failed.rule.error.includes('sk-live-SECRET-TOKEN-123456'), false, 'Bearer 凭据落进了记录');
  assert.equal(failed.rule.error.includes('abcdef123456'), false, 'token= 落进了记录');
  const pageRevision = failed.wiki.revision;
  assert.equal(s.ruleCalls, 1);
  assert.equal(s.wikiCalls, 1);

  // 修好模型后单腿补跑规则：只有规则重跑，知识库侧保住 revision 不重发
  s.setRuleMode('ok');
  const retried = await report(['rule']);
  assert.equal(retried.rule.state, 'updated', JSON.stringify(retried.rule));
  assert.notEqual(retried.rule.revision, failed.rule.revision, '规则侧补跑后版本没变');
  assert.equal(retried.wiki.state, 'skipped');
  assert.equal(retried.wiki.revision, pageRevision, '补跑规则时把知识库侧的 revision 洗掉了');
  assert.equal(s.ruleCalls, 2);
  assert.equal(s.wikiCalls, 1, '补跑规则又去调了知识库维护模型');

  // 再全量登记：两侧都已在同一版本 → 全跳
  const third = await report();
  assert.equal(third.rule.state, 'skipped', JSON.stringify(third.rule));
  assert.equal(third.wiki.state, 'skipped', JSON.stringify(third.wiki));
  assert.equal(third.decision.source, 'idempotent');
  assert.equal(s.ruleCalls, 2, '全量再登记把规则侧又跑了一遍');
  assert.equal(s.wikiCalls, 1);
  // 知识库页仍是第一轮写进去的那一版
  assert.equal((await s.wiki.get(TARGET_PAGE)).revision, pageRevision);
});
