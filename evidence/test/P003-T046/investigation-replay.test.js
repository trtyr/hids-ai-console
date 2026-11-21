// P003-T046 A3：研判会话回放接口（写者自测）。
// 口径只认文档：docs/modules/http-api.md §3.10（路由、参数、响应、失败）、openapi.yaml 的
// `/api/agent/investigations/{alertId}/replay` 与 `InvestigationReplay`、docs/modules/investigation-agent.md（结果体 turns）。
// 做法：进程内 server + 真研判（替身牧云 / 替身模型）+ tmp 数据根；不碰真网络、不碰真时钟。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent, replayInvestigation } from '../../../investigation-agent.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { PromptStore } from '../../../prompt-store.js';
import { createServer } from '../../../server.js';

const listen = async (t, server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

// 真跑一次研判：一轮工具调用 + 一轮结论 + 独立复核。返回结果与「模型被调了几次」。
const investigate = async () => {
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_revshell_event', description: 'Get original event', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      { name: 'list_host_events', description: 'Get same-host events', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
    ],
    callTool: async (name, args) => (name === 'get_revshell_event'
      ? { event: { id: args.id, host_id: 12, cmdline: 'bash -i' } } : { total: 0, events: [] })
  });
  const replies = [
    { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_host_events', arguments: '{"id":12}' } }] },
    { content: JSON.stringify({ verdict: 'needs_data', summary: '需要更多证据', confidence: 0.5,
      claims: [{ text: '执行 bash -i', citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'bash -i' }] }],
      missing_evidence: ['会话授权'] }) },
    { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }
  ];
  const counter = { calls: 0 };
  const model = { model: 'fake-model', complete: async () => { counter.calls += 1; return replies.shift(); } };
  const result = await new InvestigationAgent(toolbox, model).run('revshell:7');
  return { result, counter };
};

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A3 回放接口按告警 ID 给出逐轮消息摘要、工具调用序列、各轮结论变化——读完案卷不再调模型', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t046-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const { result, counter } = await investigate();
  await history.save(result);
  const callsAfterInvestigation = counter.calls;

  const server = createServer(null, null, null, history, new PromptStore(path.join(directory, 'prompts.json')));
  const base = await listen(t, server);
  const response = await fetch(`${base}/api/agent/investigations/revshell:7/replay`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.alert_id, 'revshell:7');
  assert.equal(body.mode, 'deep');
  assert.equal(body.model, 'fake-model');
  assert.equal(body.degraded, false);
  // 逐轮消息摘要：两轮调查 + 一轮独立复核，每轮只有计量，没有正文
  assert.ok(body.turns.length >= 3, `turns 至少三轮，实际 ${body.turns.length}`);
  const investigateTurns = body.turns.filter(item => item.phase === 'investigate');
  assert.equal(investigateTurns.length, 2);
  // 逐轮摘要里的 tools 是「这一轮模型点了哪些工具」，不是请求里给了哪些可选工具
  assert.deepEqual(investigateTurns[0].tools, ['list_host_events']);
  assert.deepEqual(investigateTurns[1].tools, []);
  assert.equal(investigateTurns[0].outcome, 'ok');
  assert.equal(investigateTurns[0].conclusion, null);
  assert.equal(investigateTurns[1].conclusion.verdict, 'uncertain');
  assert.ok(body.turns.some(item => item.phase === 'review' && item.role === 'review'));
  for (const turn of body.turns) {
    assert.equal(Object.hasOwn(turn, 'content'), false, '快照里不许带正文');
    assert.equal(typeof turn.input_chars, 'number');
    assert.equal(typeof turn.reply_chars, 'number');
  }
  // 工具调用序列：原始事件详情 + 一轮里真正点的那次工具，按发生顺序
  assert.deepEqual(body.tool_calls.map(item => item.name), ['get_revshell_event', 'list_host_events']);
  assert.deepEqual(body.tool_calls.map(item => item.step), [1, 2]);
  assert.equal(body.tool_calls[0].evidence_id, 'cw:1');
  // 各轮结论变化 + 终局
  assert.deepEqual(body.verdicts.map(item => item.verdict), ['uncertain']);
  assert.equal(body.final.verdict, 'uncertain');
  assert.equal(body.final.verdict_label, '存疑');
  assert.equal(body.counts.tool_calls, 2);
  assert.equal(body.evidence.length, 2);
  // 不重放模型：回放前后模型调用次数一个不涨
  assert.equal(counter.calls, callsAfterInvestigation);

  // 老路由不受影响：不带 /replay 仍是原来那份研判记录
  const saved = await (await fetch(`${base}/api/agent/investigations/revshell:7`)).json();
  assert.equal(saved.alert_id, 'revshell:7');
  assert.ok(Array.isArray(saved.turns));
});

test('A3 旧案卷（没有逐轮快照）照样回放：turns 为空，工具序列仍按 trace 给出', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t046-replay-old-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  await history.save({ alert_id: 'revshell:8', mode: 'deep', model: 'old-model',
    verdict: { verdict: 'threat', verdict_label: '真实威胁', confidence: '中', summary: '旧的结论' },
    validation: { ok: true, errors: [] },
    trace: [{ kind: 'tool', name: 'get_revshell_event', evidence_id: 'cw:1' },
      { kind: 'tool_error', name: 'list_host_events', error: '上游超时' }],
    evidence: [{ evidence_id: 'cw:1', tool: 'get_revshell_event', fetched_at: '2026-11-01T00:00:00.000Z', sha256: 'a'.repeat(64) }] });
  const server = createServer(null, null, null, history, new PromptStore(path.join(directory, 'prompts.json')));
  const base = await listen(t, server);
  const body = await (await fetch(`${base}/api/agent/investigations/revshell:8/replay`)).json();
  assert.deepEqual(body.turns, []);
  assert.deepEqual(body.verdicts, []);
  assert.equal(body.counts.turns, 0);
  assert.deepEqual(body.tool_calls.map(item => item.kind), ['tool', 'tool_error']);
  assert.equal(body.tool_calls[1].error, '上游超时');
  assert.equal(body.final.verdict, 'threat');
  // 纯函数同一套口径
  assert.equal(replayInvestigation(null), null);
});

test('A3 失败口径：没记录 404、ID 或模式不合法 400', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t046-replay-bad-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const server = createServer(null, null, null, history, new PromptStore(path.join(directory, 'prompts.json')));
  const base = await listen(t, server);

  const missing = await fetch(`${base}/api/agent/investigations/revshell:9/replay`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: '该告警暂无已保存的研判记录', code: 'caller_error' });

  const badId = await fetch(`${base}/api/agent/investigations/not-an-id/replay`);
  assert.equal(badId.status, 400);
  assert.equal((await badId.json()).error, '告警 ID 或研判模式无效');

  const badMode = await fetch(`${base}/api/agent/investigations/revshell:9/replay?mode=demo`);
  assert.equal(badMode.status, 400);
  assert.equal((await badMode.json()).error, '告警 ID 或研判模式无效');

  // mode=triage 的 syslog 形态 ID 与既有两条路由同一套校验
  const syslogId = `syslog:honeypot:${'a'.repeat(16)}:7:${'b'.repeat(8)}-${'b'.repeat(4)}-${'b'.repeat(4)}-${'b'.repeat(4)}-${'b'.repeat(12)}`;
  const triage = await fetch(`${base}/api/agent/investigations/${encodeURIComponent(syslogId)}/replay?mode=triage`);
  assert.equal(triage.status, 404);
});
