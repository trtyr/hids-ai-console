// P003-T047 单测：误报统一维护 Agent（多轮会话操控双库、单腿可补跑）。
// 断言按任务卡 A1–A7 写；库是真的（RuleStore / WikiStore / WikiWorkbench / RegoRuleMaintainer），只换模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { useJournal } from '../../../src/shared/logging/log.js';
import { FP_AUTO_VERDICT, FP_DOMAIN, FP_LIBRARIES, maintenanceSide, maintenanceSides } from '../../../fp-maintainer.js';
import { CASE_ID, REASON, TARGET_PAGE, WHO, readSession, stack } from './helpers.js';

const decideWith = libraries => () => JSON.stringify({ libraries, why: `这一轮动 ${libraries.join('、') || '无'}：案卷与两库对不上` });

test('A1 多轮会话：读案卷 / 读两库 / 提修订 / 自校验四轮，会话落盘可查且置终态', async () => {
  const s = await stack({ decide: decideWith(['rule', 'wiki']) });
  const record = await s.maintainer.maintain(s.args);

  assert.deepEqual(record.turns.map(turn => turn.phase), ['case', 'libraries', 'propose', 'verify'],
    `会话轮次不符：${JSON.stringify(record.turns.map(turn => turn.phase))}`);
  assert.deepEqual(record.turns.map(turn => turn.n), [1, 2, 3, 4]);
  assert.equal(record.terminal, true);
  assert.equal(record.status, 'done');
  assert.equal(record.case_id, CASE_ID);
  assert.equal(record.who, WHO);

  // 落盘可查：目录里就是这份会话，摘要接口能按案件找到它
  const onDisk = await readSession(s.sessions, record.id);
  assert.deepEqual(onDisk.turns.map(turn => turn.phase), ['case', 'libraries', 'propose', 'verify']);
  const listed = await s.sessions.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
  assert.equal(listed[0].case_id, CASE_ID);
  assert.equal(listed[0].terminal, true);
  assert.deepEqual(listed[0].sides, ['rule', 'wiki']);

  // 第一轮真的读了案卷：原始告警与研判事实进了上下文
  const caseTurn = record.messages.find(message => message.kind === 'case');
  assert.ok(caseTurn, '会话里没有读案卷那一轮');
  assert.match(caseTurn.content, /source_ip=203\.0\.113\.9/, '案卷的原始告警没进上下文');
  assert.match(caseTurn.content, /主机 IP：10\.0\.0\.5/, '研判事实没进上下文');
  // 第二轮真的读了两库：命中规则原文 + 目标判据页
  const libraryTurn = record.messages.find(message => message.kind === 'libraries');
  assert.ok(libraryTurn, '会话里没有读两库那一轮');
  assert.match(libraryTurn.content, /honeypot_probe/, '命中规则没进上下文');
  assert.match(libraryTurn.content, /honeypot\/HP-10\.md/, '维护目标页没进上下文');
});

test('A2 只动规则：知识库一字不动，动了哪边与理由都记在会话与维护侧', async () => {
  const s = await stack({ decide: decideWith(['rule']) });
  const pageBefore = await s.wiki.get(TARGET_PAGE);
  const record = await s.maintainer.maintain(s.args);

  assert.equal(record.outcomes.rule.state, 'updated');
  assert.equal(record.outcomes.wiki.state, 'no_change');
  assert.equal(record.outcomes.wiki.why, '这一轮动 rule：案卷与两库对不上');
  assert.deepEqual(maintenanceSides(record), ['rule']);
  assert.equal(record.decision.source, 'model');
  assert.deepEqual(record.decision.libraries, ['rule']);
  // 规则真的换了，知识库一个字没动
  assert.match((await s.ruleStore.read('honeypot_probe')).rego, /input\.source_ip != "203\.0\.113\.9"/);
  assert.equal((await s.wiki.get(TARGET_PAGE)).revision, pageBefore.revision, '只动规则时知识库被写了');
  assert.equal(s.decisionCalls, 1);
});

test('A2 只动知识库：规则库一字不动，判据页走发布闸写进去', async () => {
  const s = await stack({ decide: decideWith(['wiki']) });
  const regoBefore = (await s.ruleStore.read('honeypot_probe')).rego;
  const record = await s.maintainer.maintain(s.args);

  assert.equal(record.outcomes.wiki.state, 'updated');
  assert.equal(record.outcomes.rule.state, 'no_change');
  assert.deepEqual(maintenanceSides(record), ['wiki']);
  assert.equal(s.ruleCalls, 0, '只动知识库时规则维护者被叫了');
  assert.equal((await s.ruleStore.read('honeypot_probe')).rego, regoBefore, '只动知识库时规则被改了');
  const page = await s.wiki.get(TARGET_PAGE);
  assert.notEqual(page.revision, s.pagesBefore.get(TARGET_PAGE).revision, '判据页没写进去');
  assert.match(page.content, /维护记录（P003-T047 单测）/);
});

test('A2/A6 双动：两侧都写，会话与维护侧列出两边', async () => {
  const s = await stack({ decide: decideWith(['rule', 'wiki']) });
  const record = await s.maintainer.maintain(s.args);

  assert.equal(record.outcomes.rule.state, 'updated');
  assert.equal(record.outcomes.wiki.state, 'updated');
  assert.deepEqual(maintenanceSides(record), ['rule', 'wiki']);
  assert.equal(s.ruleCalls, 1);
  assert.equal(s.decisionCalls, 1, '双动只该有一次决策调用');
});

test('A3 写入走维护接口与版本化：旧规则进 rules-history，知识库过发布闸后会话置终态', async () => {
  const s = await stack({ decide: decideWith(['rule', 'wiki']) });
  const before = (await s.ruleStore.read('honeypot_probe')).revision;
  const record = await s.maintainer.maintain(s.args);

  // 规则侧版本化：旧版原件 + 备注都进历史（T041 的写入口）
  const history = await s.ruleStore.history('honeypot_probe');
  assert.ok(history.some(entry => entry.rev === before), `旧版没进历史：${JSON.stringify(history)}`);
  assert.match((await s.ruleStore.readRevision('honeypot_probe', before)).rego, /input\.user == "root"/);
  assert.equal(record.outcomes.rule.action, 'update');

  // 知识库侧：会话走 create → reply → publishBundle → recordPublished，发布后是终态
  const sessions = await s.wikiAgent.list();
  assert.equal(sessions.length, 1, `知识库维护会话数不符：${sessions.length}`);
  const wikiSession = await s.wikiAgent.get(sessions[0].id);
  assert.equal(wikiSession.status, 'published');
  assert.equal(wikiSession.audit.via, 'fp_maintainer');
  assert.equal(wikiSession.audit.case_id, CASE_ID);
  assert.equal(wikiSession.page_revision, record.outcomes.wiki.revision);

  // 无重复发布口子：同一份会话再发布一次直接 409
  await assert.rejects(() => s.wikiAgent.recordPublished(sessions[0].id, { pages: [{ path: TARGET_PAGE, revision: 'x' }] }),
    cause => cause.status === 409 && /已发布/.test(cause.message));
});

test('A4 单库失败可补跑：已成功一侧不重复执行，幂等键是 case_id:库:版本', async () => {
  const s = await stack({ decide: decideWith(['rule', 'wiki']), wikiMode: 'fail' });
  const failed = await s.maintainer.maintain(s.args);
  assert.equal(failed.outcomes.rule.state, 'updated', JSON.stringify(failed.outcomes.rule));
  assert.equal(failed.outcomes.wiki.state, 'failed');
  assert.match(failed.outcomes.wiki.error, /知识维护模型不可用/);
  assert.equal(failed.status, 'partial');
  assert.equal(failed.terminal, true);
  assert.equal(failed.outcomes.rule.idempotency_key, `${CASE_ID}:rule:${failed.outcomes.rule.revision}`);
  assert.match(failed.outcomes.rule.revision, /^[0-9a-f]{16}$/, '规则库版本不是摘要');
  const regoAfterFirst = (await s.ruleStore.read('honeypot_probe')).rego;

  // 补跑：上一轮的维护侧按 server.js 的映射传回去（生产里它就是 record.maintenance）
  const previous = { rule: maintenanceSide(failed.outcomes.rule), wiki: maintenanceSide(failed.outcomes.wiki) };
  assert.equal(previous.rule.status, 'updated');
  assert.equal(previous.rule.state, 'updated');
  assert.equal(previous.rule.revision, failed.outcomes.rule.revision);
  s.setWikiMode('ok');
  const again = await s.maintainer.maintain({ ...s.args, previous });

  assert.equal(again.outcomes.rule.state, 'skipped', JSON.stringify(again.outcomes.rule));
  assert.equal(again.outcomes.rule.why, '幂等：同一案卷、同一库、同一版本已经维护过');
  assert.equal(again.outcomes.wiki.state, 'updated', JSON.stringify(again.outcomes.wiki));
  assert.equal(again.status, 'done');
  assert.equal(s.ruleCalls, 1, '已成功的一侧被重复执行了');
  assert.equal(s.decisionCalls, 2, '补跑这一轮只该再调一次决策');
  assert.equal((await s.ruleStore.read('honeypot_probe')).rego, regoAfterFirst, '补跑改动了已成功的规则');
  // 失败那一侧真的补上了
  assert.notEqual((await s.wiki.get(TARGET_PAGE)).revision, s.pagesBefore.get(TARGET_PAGE).revision);
  // 会话也能查到：第二份会话里记着 skip 的幂等键
  const listed = await s.sessions.list();
  assert.equal(listed.length, 2);
  const retried = await readSession(s.sessions, again.id);
  assert.equal(retried.outcomes.rule.state, 'skipped');
  assert.equal(retried.outcomes.rule.idempotency_key, failed.outcomes.rule.idempotency_key);
});

test('A5 每轮 AI 调用进 T046 事件：域是误报维护（决策 / 规则维护 / 知识维护三条都算）', async () => {
  const events = [];
  useJournal((event, fields) => { events.push({ event, ...fields }); });
  let record;
  try {
    const s = await stack({ decide: decideWith(['rule', 'wiki']) });
    record = await s.maintainer.maintain(s.args);
  } finally {
    useJournal(null);
  }
  const calls = events.filter(entry => entry.event === 'ai.model_call' && entry.direction === 'request');
  assert.equal(calls.length, 3, `模型调用事件数不符：${JSON.stringify(calls.map(call => [call.domain, call.role]))}`);
  for (const call of calls) {
    assert.equal(call.domain, FP_DOMAIN, `域不对：${call.domain}（${call.role}）`);
    assert.ok(['fp_maintainer', 'rule_maintainer', 'wiki_maintainer'].includes(call.role), `角色不对：${call.role}`);
    // 事件侧也能把一次维护的调用串起来：决策轮与规则维护轮指向误报维护会话，
    // 知识维护轮指向它自己那份 wiki 维护会话（那份会话 id 就记在误报会话的 wiki outcome 上）。
    const expected = call.role === 'wiki_maintainer' ? record.outcomes.wiki.session_id : record.id;
    assert.equal(call.session_id, expected, `session_id 没串上：${call.role}`);
  }
  assert.deepEqual(calls.map(call => call.role).sort(), ['fp_maintainer', 'rule_maintainer', 'wiki_maintainer']);
});

test('A6 替身模型三路径 + 补跑不重发：三条路径都验过，补跑只对失败那侧发一次调用', async () => {
  const paths = [['rule'], ['wiki'], ['rule', 'wiki']];
  for (const libraries of paths) {
    const s = await stack({ decide: decideWith(libraries) });
    const record = await s.maintainer.maintain(s.args);
    assert.deepEqual(record.decision.libraries, libraries, `决策没照替身模型的输出走：${libraries}`);
    for (const library of libraries) assert.equal(record.outcomes[library].state, 'updated', `${libraries} 路径的 ${library} 侧没写`);
    assert.equal(s.decisionCalls, 1);
    assert.equal(s.ruleCalls, libraries.includes('rule') ? 1 : 0);
    assert.equal(s.wikiCalls, libraries.includes('wiki') ? 1 : 0);
  }

  // 补跑不重发：规则侧已成功，第二轮只给知识库发调用
  const s = await stack({ decide: decideWith(['rule', 'wiki']), wikiMode: 'fail' });
  const first = await s.maintainer.maintain(s.args);
  const previous = { rule: maintenanceSide(first.outcomes.rule), wiki: maintenanceSide(first.outcomes.wiki) };
  s.setWikiMode('ok');
  const second = await s.maintainer.maintain({ ...s.args, previous });
  assert.equal(second.outcomes.rule.state, 'skipped');
  assert.equal(s.ruleCalls, 1, '补跑重发了规则侧');
  assert.equal(s.decisionCalls, 2, `补跑只该再调一次决策（实际 ${s.decisionCalls}）`);
  assert.equal(s.wikiCalls, 2, `知识库侧的调用次数不符：${s.wikiCalls}（第一次失败 + 补跑成功）`);
});

test('A7 闭环自动判定以 Rego 为准（A/B 已拍板）：产出照写，口径落在会话上', async () => {
  const s = await stack({ decide: decideWith(['rule']) });
  const record = await s.maintainer.maintain(s.args);

  assert.deepEqual(record.auto_verdict, { ...FP_AUTO_VERDICT });
  assert.equal(record.auto_verdict.enabled, true);
  assert.equal(record.auto_verdict.criterion, 'rego', '生效判据不是 Rego');
  assert.equal(record.auto_verdict.trust, 'single');
  assert.match(record.auto_verdict.note, /JSON 规则集修订照写留痕/);
  // 产出照写：Rego 规则真的落了盘（它就是研判管线读的那一份），会话里有 outcome
  assert.equal(record.outcomes.rule.state, 'updated');
  assert.match((await s.ruleStore.read('honeypot_probe')).rego, /input\.source_ip != "203\.0\.113\.9"/);
  // 维护只写库，不在会话里自己判结论：结论链仍在研判管线那一侧
  assert.equal('verdict' in record, false);
});

test('A4 单边失败的 error 写进会话之前先擦凭据（上游 401 带 Authorization / token=）', async () => {
  const s = await stack({ decide: decideWith(['rule', 'wiki']), ruleMode: 'authError' });
  const record = await s.maintainer.maintain(s.args);

  assert.equal(record.outcomes.rule.state, 'failed');
  const error = record.outcomes.rule.error;
  assert.match(error, /401/, `失败原因没留下：${error}`);
  assert.match(error, /\[redacted\]/, `凭据没被擦：${error}`);
  assert.equal(error.includes('sk-live-SECRET-TOKEN-123456'), false, `Bearer 凭据原样落盘：${error}`);
  assert.equal(error.includes('abcdef123456'), false, `token= 凭据原样落盘：${error}`);
  assert.ok(error.length <= 300, 'error 超过 300 字');
});

test('A2 没配决策模型时退化为「按请求的库逐个尝试」，决策来源如实记 fallback', async () => {
  const s = await stack({});
  const record = await s.maintainer.maintain(s.args);
  assert.equal(record.decision.source, 'fallback');
  assert.deepEqual(record.decision.libraries, FP_LIBRARIES);
  assert.match(record.decision.why, /模型未配置/);
  assert.equal(record.outcomes.rule.state, 'updated');
  assert.equal(record.outcomes.wiki.state, 'updated');
});

test('A4 非法库名直接 400，不落半份会话', async () => {
  const s = await stack({ decide: decideWith(['rule']) });
  await assert.rejects(() => s.maintainer.maintain({ ...s.args, libraries: ['dns'] }),
    cause => cause.status === 400 && /维护库无效/.test(cause.message));
  await assert.rejects(() => s.maintainer.maintain({ ...s.args, libraries: [] }),
    cause => cause.status === 400);
  assert.equal((await s.sessions.list()).length, 0);
});

test('维护侧映射：status 仍用 updating|updated|failed，新状态落 state', () => {
  assert.deepEqual(maintenanceSide({ library: 'rule', state: 'updated', file: 'a.rego', action: 'update' }),
    { status: 'updated', state: 'updated', file: 'a.rego', action: 'update' });
  assert.equal(maintenanceSide({ library: 'wiki', state: 'failed', error: '上游 500' }).status, 'failed');
  assert.equal(maintenanceSide({ library: 'wiki', state: 'skipped' }, {}).state, 'skipped');
  // 没请求的一侧沿用兜底：既不谎报「改完了」，也不把总态钉在 updating
  assert.deepEqual(maintenanceSide(undefined, { status: 'updated', state: 'skipped', why: '未执行' }),
    { status: 'updated', state: 'skipped', why: '未执行' });
  assert.equal(path.basename('/x/y'), 'y');
});

test('会话文件权限与目录：0o600 单文件、0o700 目录（与 rule-sessions / wiki-sessions 同口径）', async () => {
  const s = await stack({ decide: decideWith(['rule']) });
  const record = await s.maintainer.maintain(s.args);
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(s.sessions.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(s.sessions.directory, `${record.id}.json`))).mode & 0o777, 0o600);
  const raw = await readFile(path.join(s.sessions.directory, `${record.id}.json`), 'utf8');
  assert.match(raw, new RegExp(REASON.slice(0, 8)));
});
