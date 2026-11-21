// P003-T051 记录侧原文脱敏（写者自测，交付给 tester 当契约样例）。
// 口径只认文档：docs/modules/investigation-agent.md §3.2 / §3.3 / §3.11（记录侧字段与 `turns[].note` 的文案口径）
// 与 T046 的同族修法（日志侧换固定文案、错误对象三标记照旧上抛）。
// 做法：替身模型 / 替身牧云，不碰真网络与真时钟；可检索标记 `SECRET_BODY_MARKER` 放进**错误原文**，
// 断言它一个字都不落进研判记录（review.concerns / missing_evidence / trace / analysis / turns.note）。
// P003-T050 隔离：必须抢在 server.js / investigation-agent.js 之前——它们模块加载时就把数据根算死。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
import { traceModelCall } from '../../../src/shared/logging/log.js';

const MARKER = 'SECRET_BODY_MARKER';
const CLEAN = /SECRET_BODY_MARKER|SECRET_BOD|Unexpected token|is not valid JSON/;

// V8 的 JSON.parse 报错原文：它会把回包开头的字原样抄进 message——这就是要挡的那一类。
const v8Message = text => {
  try { JSON.parse(text); } catch (error) { return error.message; }
  throw new Error('这条用例要求 JSON.parse 真的失败');
};

const fakeToolbox = ({ failOn = null } = {}) => new AgentToolbox({
  listTools: async () => [
    { name: 'get_suspicious_operation_event', description: '事件详情',
      inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
    { name: 'list_host_events', description: '同主机事件',
      inputSchema: { type: 'object', properties: { host_id: {}, count: {} } } },
    { name: 'list_global_events', description: '全局事件',
      inputSchema: { type: 'object', properties: { count: {} } } }
  ],
  callTool: async (name) => {
    if (name === failOn) throw new Error(`${MARKER} 工具上游炸了`);
    return name === 'get_suspicious_operation_event'
      ? { event_id: 7, host_id: 41, cmdline: 'getent hosts dnslog.cn' }
      : { total: 0, events: [] };
  }
});

const conclusion = () => JSON.stringify({ verdict: '存疑', confidence: '低', summary: '证据不足，需人工核查',
  claims: [{ text: '执行命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'getent hosts dnslog.cn' }] }],
  missing_data: [] });

test('A1 复核轮回包解不出 JSON：review.concerns / trace / turns.note 只留固定文案与字符量', async () => {
  const prose = `${MARKER} 是一段不该落盘的回包正文`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => (++calls === 1 ? { content: conclusion() } : { content: prose }) };
  const result = await new InvestigationAgent(fakeToolbox(), model).run('suspicious_operation:7', { mode: 'triage' });

  const failure = `模型回包不是合法 JSON（SyntaxError），原文 ${v8Message(prose).length} 字未落盘`;
  assert.equal(result.review.assessment, 'unavailable');
  assert.equal(result.review.concerns[0], `独立复核未完成：${failure}`);
  const unavailable = result.trace.find(item => item.kind === 'review_unavailable');
  assert.equal(unavailable.error, failure);
  // 逐轮快照（turns[].note）走同一道闸：附注同样不写原文。
  assert.equal(result.turns.find(item => item.phase === 'review').note, `独立复核未完成：${failure}`);
  // 整份记录一个字都不许有原文：回包正文与 V8 报错片段都搜不到。
  assert.doesNotMatch(JSON.stringify(result), CLEAN);
  // 复核不可用的降级口径不变（P003-T035）：存疑结论照旧出门，缺口清单不受脱敏影响。
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.review.concerns.length, 1);
});

test('A1 修订请求失败：missing_evidence 与 trace 只留固定文案与字符量', async () => {
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: JSON.stringify({ verdict: '真实威胁', confidence: '高', summary: '判为真实威胁',
      claims: [{ text: '执行命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'getent hosts dnslog.cn' }] }] }) };
    if (calls === 2) return { content: JSON.stringify({ assessment: 'needs_revision', concerns: ['缺反证'], missing_evidence: [] }) };
    throw new Error(`${MARKER} 修订轮上游炸了`);
  } };
  const result = await new InvestigationAgent(fakeToolbox(), model).run('suspicious_operation:7', { mode: 'triage' });

  const raw = `${MARKER} 修订轮上游炸了`;
  const failure = `上游调用失败，原文 ${raw.length} 字未落盘`;
  const gap = result.verdict.missing_evidence.find(item => item.startsWith('独立复核要求修订，修订请求失败：'));
  assert.equal(gap, `独立复核要求修订，修订请求失败：${failure}；真实威胁结论待重新核对`);
  assert.equal(result.trace.find(item => item.kind === 'revision_failed').error, failure);
  assert.doesNotMatch(JSON.stringify(result), CLEAN);
  // 降级口径不变：仍是存疑 + summary 前缀。
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.match(result.verdict.summary, /独立复核要求修订，修订请求失败，暂按存疑处理/);
});

test('A1 引用校验退回失败：trace[validation_error] 只留固定文案与字符量', async () => {
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: JSON.stringify({ verdict: '存疑', confidence: '低', summary: '需核查',
      claims: [{ text: '工单已批', citations: [{ evidence_id: 'cw:1', pointer: '/ticket', value: 'approved' }] }] }) };
    if (calls === 2) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    throw new Error(`${MARKER} 校验轮上游炸了`);
  } };
  const result = await new InvestigationAgent(fakeToolbox(), model).run('suspicious_operation:7', { mode: 'triage' });

  const row = result.trace.find(item => item.kind === 'validation_error');
  assert.equal(row.note, `上游调用失败，原文 ${`${MARKER} 校验轮上游炸了`.length} 字未落盘`);
  assert.doesNotMatch(JSON.stringify(result), CLEAN);
  assert.equal(result.validation.ok, false);
});

test('A1 调查轮解析失败：analysis / missing_evidence / trace[parse_error] 不带 V8 报错原文', async () => {
  const prose = '我先梳理一下这条告警：主机 10.0.0.5 上执行了 id，需要核对授权与前后会话。';
  const model = { model: 'fake', complete: async () => ({ content: prose }) };
  const result = await new InvestigationAgent(fakeToolbox(), model).run('suspicious_operation:7', { mode: 'triage' });

  const v8 = v8Message(prose);
  // 先自证这条用例有意义：V8 的报错里真的有回包片段。
  assert.match(v8, /Unexpected token/);
  const failures = result.trace.filter(item => item.kind === 'parse_error');
  assert.equal(failures.length, 6);
  for (const entry of failures) {
    assert.equal(entry.error, `输出解析失败：模型回包不是合法 JSON（SyntaxError），原文 ${v8.length} 字未落盘`);
  }
  // 降级结论的 analysis 与 missing_evidence[0] 是同一段文案：退回原因换成固定文案。
  assert.match(result.verdict.missing_evidence[0], /退回 6 次：输出解析失败：模型回包不是合法 JSON/);
  assert.equal(result.verdict.analysis, result.verdict.missing_evidence[0]);
  // 回包开头 50 字是 P003-T022 的既定契约（模型没交卷时要看见它回了什么），但 V8 报错形状一个字不留。
  assert.match(result.verdict.missing_evidence[0], /末次回包 \d+ 字：「我先梳理一下这条告警/);
  assert.doesNotMatch(JSON.stringify(result), /Unexpected token|is not valid JSON/);
  assert.equal(JSON.stringify(result).includes(`${v8.slice(0, 24)}`), false);
});

test('A1 工具调用报错：trace[tool_error] 不写原文，模型会话里仍给原文', async () => {
  let calls = 0;
  const model = { model: 'fake', complete: async (_messages, tools) => {
    calls += 1;
    return calls === 1 && tools.length
      ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_global_events', arguments: '{"count":5}' } }] }
      : { content: conclusion() };
  } };
  const result = await new InvestigationAgent(fakeToolbox({ failOn: 'list_global_events' }), model)
    .run('suspicious_operation:7', { mode: 'triage' });

  const row = result.trace.find(item => item.kind === 'tool_error');
  assert.equal(row.name, 'list_global_events');
  assert.equal(row.error, `上游调用失败，原文 ${`${MARKER} 工具上游炸了`.length} 字未落盘`);
  assert.doesNotMatch(JSON.stringify(result), CLEAN);
});

test('A1 未匹配 syslog：模型说明失败与上游查询失败都只留固定文案 + 字符量（P003-T054 起不再保留徽标）', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-redact-syslog-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(directory, '03-研判事实.md'), '# 研判事实\n来源 192.0.2.2\n');
  const modelError = `${MARKER} 说明调用炸了`;
  const model = { model: 'fake', complete: async () => { throw new Error(modelError); } };
  const upstream = `${MARKER} 上游 503`;
  const agent = new InvestigationAgent(fakeToolbox(), model,
    { load: async () => ({ prompts: { triage: 'T' }, sop: {}, version: 'v1', revision: 'r1' }) },
    { agentIndex: async () => ({ category: 'honeypot', pages: [] }), agentContextPages: async () => [] },
    { evaluate: async () => ({ matched: [] }) });
  const result = await agent.runUnmatchedSyslog({ raw: 'raw', context: {}, parsed: {
    msgid: 'cloudwalker-honeypot', payload: { host_ip: '10.0.0.5' } } },
  { type: 'honeypot', matched: false, reason: `牧云事件查询失败：${upstream}` },
  { case_dir: directory, files: ['03-研判事实.md'] });

  const modelFailure = `上游调用失败，原文 ${modelError.length} 字未落盘`;
  // P003-T054：`reasonForRecord()` 删了徽标白名单（与 record-redaction.js 同口径），
  // 上游 reason 整串进闸——字符量算的是含「牧云事件查询失败：」前缀的全长。
  const upstreamFailure = `上游调用失败，原文 ${`牧云事件查询失败：${upstream}`.length} 字未落盘`;
  assert.equal(result.verdict.analysis, `牧云事件回查与模型说明未完成：${modelFailure}`);
  assert.equal(result.turns[0].note, `说明调用未完成：${modelFailure}`);
  assert.equal(result.verdict.missing_evidence[0], upstreamFailure);
  assert.equal(result.review.missing_evidence[0], upstreamFailure);
  assert.equal(result.trace.find(item => item.kind === 'tool_error').error, upstreamFailure);
  assert.doesNotMatch(JSON.stringify(result), CLEAN);
});

test('A2 上游原文仍可达调用方：抛错原文与 cause 链不动，三标记照旧', async () => {
  const raw = `${MARKER} 接口 500`;
  const model = { model: 'fake', complete: async () => {
    throw Object.assign(new Error(raw), { reply_excerpt: '回包 message 正文 0 字' });
  } };
  await assert.rejects(() => new InvestigationAgent(fakeToolbox(), model).run('suspicious_operation:7', { mode: 'triage' }),
    error => {
      // 原文照旧进调用方（队列侧/接口侧拿得到），只是不落盘。
      assert.match(error.message, new RegExp(raw));
      assert.equal(error.cause.message, raw);
      return true;
    });
  // 被 gate 的是落盘文案，不是错误对象本身：T046 的三标记与回包正文都还在。
  const failure = await traceModelCall({ domain: 'triage', role: 'triage', turn: 1, phase: 'investigate' },
    async () => ({ content: `${MARKER} 不是 JSON` }), { decode: reply => JSON.parse(reply.content) })
    .catch(error => error);
  assert.equal(failure.model_decode, true);
  assert.equal(failure.model_reply.content, `${MARKER} 不是 JSON`);
  assert.equal(failure.model_call.outcome, 'invalid_json');
  // V8 只抄开头 ~10 字（`Unexpected token 'S', "SECRET_BOD"...`）：片段在错误对象上照旧。
  assert.match(failure.message, /SECRET_BOD/);
});

test('P003-T050 A2：本文件的数据根按注入走（不写真实全局根）', () => {
  assertIsolatedRoot();
});
