// P003-T046 三域模型调用事件（写者自测，交付给 tester 当契约样例）。
// 口径只认文档：docs/architecture.md §3.6 的 `ai.model_call` 两行（字段表与四类结局）、
// docs/modules/http-api.md §3.10（回放接口）、docs/modules/investigation-agent.md §3.11（结果体 turns）。
// 做法：`useJournal(createJournal({ write }))` 收行（不碰真 stdout）、替身模型/替身牧云（不碰真网络与真时钟）。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal, traceModelCall, useJournal } from '../../../src/shared/logging/log.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { RegoRuleMaintainer } from '../../../server.js';
import { RuleSessionStore, RuleStore, seedLibrary } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';
import { WikiWorkbench } from '../../../src/contexts/maintenance/application/wiki-workbench.js';
import { WikiStore } from '../../../src/contexts/knowledge/infrastructure/wiki-store.js';
import { PromptStore } from '../../../src/contexts/knowledge/infrastructure/prompt-store.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 收行装置：每行 JSON 解析好再交断言，顺手留原始行验「正文没进日志」。
const rig = t => {
  const lines = [];
  const raw = [];
  useJournal(createJournal({ write: line => { raw.push(line); lines.push(JSON.parse(line)); } }));
  t.after(() => useJournal());
  const events = () => lines.filter(entry => entry.event === 'ai.model_call');
  return { lines, raw, events };
};

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A1 一次调用落 request / response 两条事件：域、角色、轮次、方向、输入输出字符量、耗时、结局齐全', async t => {
  const sink = rig(t);
  const messages = [{ role: 'system', content: '判据正文不入日志' }, { role: 'user', content: 'USER_MESSAGE_BODY' }];
  const tools = [{ type: 'function', function: { name: 'get_honeypot_event' } }];
  const result = await traceModelCall({ domain: 'triage', role: 'triage', turn: 2, phase: 'investigate',
    alertId: 'honeypot:7', model: 'fake-model', messages, tools },
  async () => ({ content: '{"verdict":"存疑"}', tool_calls: [] }),
  { decode: reply => JSON.parse(reply.content) });

  assert.deepEqual(result.decoded, { verdict: '存疑' });
  const events = sink.events();
  assert.equal(events.length, 2);
  const [request, response] = events;
  assert.equal(request.direction, 'request');
  assert.equal(response.direction, 'response');
  for (const entry of events) {
    assert.equal(entry.domain, 'triage');
    assert.equal(entry.role, 'triage');
    assert.equal(entry.turn, 2);
    assert.equal(entry.attempt, 1);
    assert.equal(entry.phase, 'investigate');
    assert.equal(entry.alert_id, 'honeypot:7');
    assert.equal(entry.model, 'fake-model');
    // 输入字符量 = 真发出去的那两份序列化后的长度（不是条数）
    assert.equal(entry.input_chars, JSON.stringify({ messages, tools }).length);
  }
  assert.equal(request.output_chars, undefined);
  assert.equal(request.messages, 2);
  assert.equal(request.tools, 1);
  assert.equal(response.output_chars, '{"verdict":"存疑"}'.length);
  assert.equal(response.outcome, 'ok');
  assert.equal(response.tool_calls, 0);
  assert.equal(typeof response.duration_ms, 'number');
  // 正文与密钥一个字都不进事件
  assert.doesNotMatch(sink.raw.join('\n'), /判据正文不入日志|USER_MESSAGE_BODY/);
});

test('A1 结局四值：超时记 timeout、回包解不出 JSON 记 invalid_json、调用报错记 error（并原样抛出）', async t => {
  const sink = rig(t);
  const meta = { domain: 'rule', role: 'rule_maintainer', turn: 1, phase: 'maintain' };
  await assert.rejects(() => traceModelCall(meta,
    async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }), /timeout/i);
  // 回包里放一段可检索的正文片段：invalid_json 的原始日志行里不许出现它（V8 的 JSON.parse 报错会带出前 ~10 字）
  await assert.rejects(() => traceModelCall(meta,
    async () => ({ content: 'SECRET_BODY_MARKER 是一段不该进日志的回包正文' }),
    { decode: reply => JSON.parse(reply.content) }), /JSON/);
  await assert.rejects(() => traceModelCall({ ...meta, domain: 'wiki', role: 'wiki_maintainer' },
    async () => { throw new Error('模型接口 HTTP 500: 上游炸了'); }), /HTTP 500/);

  const responses = sink.events().filter(entry => entry.direction === 'response');
  assert.deepEqual(responses.map(entry => entry.outcome), ['timeout', 'invalid_json', 'error']);
  // A1 复审实锤：invalid_json 的 error 字段只写固定文案，原始日志行里搜不到回包正文片段
  const invalid = responses.find(entry => entry.outcome === 'invalid_json');
  assert.equal(invalid.error, '模型回包无法解析为 JSON（SyntaxError）');
  assert.doesNotMatch(sink.raw.join('\n'), /SECRET_BODY_MARKER|SECRET_BOD/);
  // 解码失败的错误上带三个标记，调用方的退回逻辑靠它区分「调用失败」与「回包不是 JSON」
  const failure = await traceModelCall(meta, async () => ({ content: 'nope' }),
    { decode: reply => JSON.parse(reply.content) }).catch(error => error);
  assert.equal(failure.model_decode, true);
  assert.equal(failure.model_reply.content, 'nope');
  assert.equal(failure.model_call.outcome, 'invalid_json');
});

// 替身牧云：研判取一次事件详情，另一类工具返回空页（本测试只管事件齐全性，不管研判质量）。
const fakeToolbox = () => new AgentToolbox({
  listTools: async () => [
    { name: 'get_honeypot_event', description: '原始事件', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    { name: 'list_host_events', description: '同主机事件', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
  ],
  callTool: async name => (name === 'get_honeypot_event'
    ? { event: { id: 7, host_id: 41, source_ip: '10.0.0.9', cmdline: 'curl /etc/passwd' } }
    : { total: 0, events: [] })
});

test('A5 研判域：调查轮 + 独立复核 + 复核要求后的修订都落事件，role / phase / turn 对得上', async t => {
  const sink = rig(t);
  const verdict = JSON.stringify({ verdict: '存疑', confidence: '低', summary: '证据不足',
    claims: [{ text: '执行可疑命令', citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'curl /etc/passwd' }] }],
    missing_data: [] });
  let calls = 0;
  const model = { model: 'fake', complete: async (_messages, tools) => {
    calls += 1;
    if (tools.length) return { content: verdict };
    return { content: calls === 2
      ? JSON.stringify({ assessment: 'needs_revision', concerns: ['缺反证'], missing_evidence: [] })
      : verdict };
  } };
  const agent = new InvestigationAgent(fakeToolbox(), model, new PromptStore());
  const result = await agent.run('honeypot:7', { mode: 'triage' });

  const events = sink.events();
  const requests = events.filter(entry => entry.direction === 'request');
  assert.equal(requests.length, 3, '调查 / 复核 / 修订三轮请求');
  assert.deepEqual(requests.map(entry => entry.phase), ['investigate', 'review', 'revision']);
  assert.deepEqual(requests.map(entry => entry.role), ['triage', 'review', 'triage']);
  assert.deepEqual(requests.map(entry => entry.turn), [1, 2, 3]);
  for (const entry of requests) {
    assert.equal(entry.domain, 'triage');
    assert.equal(entry.model, 'fake');
    assert.equal(entry.alert_id, 'honeypot:7');
    assert.equal(typeof entry.input_chars, 'number');
  }
  // 每次调用都是成对的 request / response，且全部 ok
  assert.equal(events.filter(entry => entry.direction === 'response').length, requests.length);
  assert.deepEqual([...new Set(events.map(entry => entry.outcome).filter(Boolean))], ['ok']);
  // 结果里的逐轮快照与事件同一批计量，且不带任何正文
  assert.equal(result.turns.length, 3);
  assert.deepEqual(result.turns.map(item => item.phase), ['investigate', 'review', 'revision']);
  assert.doesNotMatch(JSON.stringify(result.turns), /缺反证|证据不足|curl/);
});

test('A5 超时重试在快照里留痕：turns 里 timeout 与 error 分得开，不再恒记 error', async t => {
  const sink = rig(t);
  const verdict = JSON.stringify({ verdict: '存疑', confidence: '低', summary: '证据不足',
    claims: [{ text: '执行可疑命令', citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'curl /etc/passwd' }] }],
    missing_data: [] });
  let calls = 0;
  const model = { model: 'fake', complete: async (_messages, tools) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return { content: tools.length ? verdict : JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const result = await new InvestigationAgent(fakeToolbox(), model, new PromptStore()).run('honeypot:7', { mode: 'triage' });

  const investigate = result.turns.filter(item => item.phase === 'investigate');
  assert.equal(investigate.length, 2);
  assert.deepEqual(investigate.map(item => [item.attempt, item.outcome]), [[1, 'timeout'], [2, 'ok']]);
  assert.match(investigate[0].note, /超时重试/);
  // 事件侧同一批计量：第一次 timeout、第二次 ok
  const responses = sink.events().filter(entry => entry.direction === 'response' && entry.phase === 'investigate');
  assert.deepEqual(responses.map(entry => [entry.attempt, entry.outcome]), [[1, 'timeout'], [2, 'ok']]);
});

test('A4 规则维护单发调用落事件，带 T041 规则维护会话 id（互引）', async t => {
  const sink = rig(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t046-rule-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await seedLibrary(path.join(directory, 'rules'), path.join(ROOT, 'rules'));
  const store = new RuleStore(path.join(directory, 'rules'));
  const sessions = new RuleSessionStore(path.join(directory, 'rule-sessions'));
  const prompts = { load: async () => ({ prompts: { rule: '改规则' } }) };
  const model = { model: 'fake-light', complete: async () => ({ content: JSON.stringify({ ready: true,
    id: 't046_test_rule', reason: '补一条可判定的条件',
    rego: 'package hids.rules.t046_test_rule\n\n# name: 本卡测试规则\n\ndefault match := false\n\nmatch if {\n  input.type == "abnormal_login"\n}\n' }) }) };
  const maintainer = new RegoRuleMaintainer(model, store, prompts, sessions);
  const outcome = await maintainer.maintain({ caseId: 'abnormal_login:5', eventType: 'abnormal_login',
    reason: '误报', who: '值班员', alert: { id: 5 }, ruleIds: [] });
  assert.equal(outcome.id, 't046_test_rule');

  const events = sink.events();
  assert.equal(events.length, 2);
  for (const entry of events) {
    assert.equal(entry.domain, 'rule');
    assert.equal(entry.role, 'rule_maintainer');
    assert.equal(entry.phase, 'maintain');
    assert.equal(entry.turn, 1);
    assert.equal(entry.attempt, 1);
    assert.match(entry.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
  // 互引：事件里的 session_id 就是 T041 落的维护会话文件，能从会话里读出这次维护的来路
  const session = await sessions.get(events[0].session_id);
  assert.equal(session.case_id, 'abnormal_login:5');
  assert.equal(session.status, 'updated');
});

test('A5 wiki 维护单发调用落事件，turn 是会话里的第几条用户消息、session_id 是维护会话 id', async t => {
  const sink = rig(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t046-wiki-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await seedLibrary(path.join(directory, 'wiki'), path.join(ROOT, 'wiki'));
  const wiki = new WikiStore(path.join(directory, 'wiki'));
  const model = { model: 'fake-light', complete: async () => ({ content: JSON.stringify({ ready: false, reply: '请补充原始记录。' }) }) };
  const workbench = new WikiWorkbench(wiki, model, new PromptStore(path.join(directory, 'prompts.json')),
    path.join(directory, 'sessions'));
  const session = await workbench.create('common/GEN-01.md');
  await workbench.reply(session.id, '这条判据漏了样本外的情况');

  const events = sink.events();
  assert.equal(events.length, 2);
  for (const entry of events) {
    assert.equal(entry.domain, 'wiki');
    assert.equal(entry.role, 'wiki_maintainer');
    assert.equal(entry.phase, 'maintain');
    assert.equal(entry.turn, 1);
    assert.equal(entry.session_id, session.id);
  }
  assert.deepEqual(events.map(entry => entry.outcome).filter(Boolean), ['ok']);
  // 第二轮：同一个会话的第二次用户输入，turn 跟着涨
  await workbench.reply(session.id, '这次是样本外的命令序列');
  const second = sink.events().filter(entry => entry.direction === 'request')[1];
  assert.equal(second.turn, 2);
  assert.equal(second.session_id, session.id);
});
