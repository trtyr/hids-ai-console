// P003-T051 验收（tester 侧）：文档承诺 → 实测。不重复写者自测的断言。
// 口径只认文档：docs/modules/investigation-agent.md §3.2（记录侧不写错误原文 / 三个固定文案 / 四个去处表）、
// §3.3（复核不可用与修订失败）、§3.11（turns.note 口径）、§5.6（断言与可复跑命令）、
// docs/modules/http-api.md §3.10（`GET /api/agent/investigations/{alertId}` 与 `/replay` 的读面）。
// 做法：真 HTTP（进程内 listen）+ 真 InvestigationStore 落盘（读回原始文件字节）+ 替身模型/替身牧云。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { AgentToolbox } from '../../../agent-tools.js';
import { traceModelCall } from '../../../log.js';

// 检索标记：模型回包正文 / V8 报错片段 / 上游报文里的同一串。记录侧一个字都不许有。
const MARKER = 'SECRET_BODY_MARKER';
const CLEAN = /SECRET_BODY_MARKER|SECRET_BOD|Unexpected token|is not valid JSON/;

const v8Message = text => {
  try { JSON.parse(text); } catch (error) { return error.message; }
  throw new Error('这条用例要求 JSON.parse 真的失败');
};

const toolbox = () => new AgentToolbox({
  listTools: async () => [
    { name: 'get_revshell_event', description: '事件详情',
      inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
    { name: 'list_host_events', description: '同主机事件',
      inputSchema: { type: 'object', properties: { host_id: {}, count: {} } } },
    { name: 'list_global_events', description: '全局事件',
      inputSchema: { type: 'object', properties: { count: {} } } }
  ],
  callTool: async (name) => (name === 'get_revshell_event'
    ? { event_id: 7, host_id: 41, cmdline: 'bash -i' }
    : { total: 0, events: [] })
});

const conclusion = () => JSON.stringify({ verdict: '存疑', confidence: '低', summary: '证据不足，需人工核查',
  claims: [{ text: '执行命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'bash -i' }] }],
  missing_data: [] });

const workspace = async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t051-tester-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

// 落盘面：把 investigations 目录下每份原始文件按字节读出来（不是看内存里的 result）。
const diskText = async directory => {
  const names = await readdir(directory).catch(() => []);
  const parts = await Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8')));
  return { names, raw: parts.join('\n') };
};

const serve = async (t, history) => {
  const server = createServer(null, null, null, history, null, null, null,
    { user: null, password: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const get = async (base, route) => {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() };
};

// A1 四处之一是「复核结论」：复核轮回一段散文 → 记录里只有固定文案 + 字符量。
test('A1 复核轮解不出 JSON：落盘文件、HTTP 案卷、回放三面都搜不到原文，四处落点同一句', async t => {
  const directory = await workspace(t);
  const prose = `${MARKER} 是一段不该落盘的回包正文`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => (++calls === 1 ? { content: conclusion() } : { content: prose }) };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  const failure = `模型回包不是合法 JSON（SyntaxError），原文 ${v8Message(prose).length} 字未落盘`;
  assert.equal(result.review.assessment, 'unavailable');
  assert.equal(result.review.concerns[0], `独立复核未完成：${failure}`);
  assert.equal(result.trace.find(item => item.kind === 'review_unavailable').error, failure);
  assert.equal(result.turns.find(item => item.phase === 'review').note, `独立复核未完成：${failure}`);

  const store = new InvestigationStore(path.join(directory, 'investigations'));
  await store.save(result);
  const { names, raw } = await diskText(path.join(directory, 'investigations'));
  assert.equal(names.length, 1, '落盘文件数不对');
  assert.doesNotMatch(raw, CLEAN, '落盘文件里有原文');

  // HTTP 读面（§3.10）：案卷与回放都不许把原文带出来。
  const base = await serve(t, store);
  for (const route of ['/api/agent/investigations/revshell:7', '/api/agent/investigations/revshell:7/replay']) {
    const { status, body } = await get(base, route);
    assert.equal(status, 200, `${route} 没回 200`);
    assert.doesNotMatch(JSON.stringify(body), CLEAN, `${route} 的响应体里有原文`);
  }
  const record = await get(base, '/api/agent/investigations/revshell:7');
  assert.equal(record.body.review.concerns[0], `独立复核未完成：${failure}`);
});

// A1 四处之一是「证据缺口」：修订轮失败 → missing_evidence 与 summary、trace 同一句。
test('A1 修订请求失败：summary / missing_evidence / trace 三处同一句固定文案，原文不落盘', async t => {
  const directory = await workspace(t);
  const raw = `${MARKER} 修订轮上游炸了`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: JSON.stringify({ verdict: '真实威胁', confidence: '高', summary: '判为真实威胁',
      claims: [{ text: '执行命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'bash -i' }] }] }) };
    if (calls === 2) return { content: JSON.stringify({ assessment: 'needs_revision', concerns: ['缺反证'], missing_evidence: [] }) };
    throw new Error(raw);
  } };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  const failure = `上游调用失败，原文 ${raw.length} 字未落盘`;
  const gap = result.verdict.missing_evidence.find(item => item.startsWith('独立复核要求修订，修订请求失败：'));
  assert.equal(gap, `独立复核要求修订，修订请求失败：${failure}；真实威胁结论待重新核对`);
  assert.equal(result.trace.find(item => item.kind === 'revision_failed').error, failure);
  assert.match(result.verdict.summary, /独立复核要求修订，修订请求失败/);

  const store = new InvestigationStore(path.join(directory, 'investigations'));
  await store.save(result);
  assert.doesNotMatch((await diskText(path.join(directory, 'investigations'))).raw, CLEAN);
});

// A1 四处之一是「引用校验退回」：trace[validation_error] 只留固定文案。
test('A1 引用校验退回失败：trace[validation_error] 只留固定文案与字符量', async t => {
  const directory = await workspace(t);
  const raw = `${MARKER} 校验轮上游炸了`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: JSON.stringify({ verdict: '存疑', confidence: '低', summary: '需核查',
      claims: [{ text: '工单已批', citations: [{ evidence_id: 'cw:1', pointer: '/ticket', value: 'approved' }] }] }) };
    if (calls === 2) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    throw new Error(raw);
  } };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  const row = result.trace.find(item => item.kind === 'validation_error');
  assert.equal(row.note, `上游调用失败，原文 ${raw.length} 字未落盘`);
  assert.equal(result.validation.ok, false);
  const store = new InvestigationStore(path.join(directory, 'investigations'));
  await store.save(result);
  assert.doesNotMatch((await diskText(path.join(directory, 'investigations'))).raw, CLEAN);
});

// A1 四处之四是「结论正文」：六轮解析失败 → analysis 与 missing_evidence[0] 是同一句，
// 退回原因换成固定文案；P003-T022 的「末次回包 K 字」摘要照旧保留（不越界删契约）。
test('A1 调查轮六轮解析失败：analysis / missing_evidence / 6 条 trace[parse_error] 同一句，摘要契约不动', async t => {
  const directory = await workspace(t);
  const prose = '我先梳理一下这条告警：主机 10.0.0.5 上执行了 id，需要核对授权与前后会话。';
  const model = { model: 'fake', complete: async () => ({ content: prose }) };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  const v8 = v8Message(prose);
  assert.match(v8, /Unexpected token/); // 自证：V8 报错里真的带正文片段
  const failure = `输出解析失败：模型回包不是合法 JSON（SyntaxError），原文 ${v8.length} 字未落盘`;
  const failures = result.trace.filter(item => item.kind === 'parse_error');
  assert.equal(failures.length, 6);
  for (const entry of failures) assert.equal(entry.error, failure);
  // analysis 按 240 字预算拼（§3.2 表「退回次数与原因」），末段会被 `…` 截断——文档实测样例同形（`原文 60 …`）。
  assert.ok(result.verdict.missing_evidence[0].includes(`退回 6 次：输出解析失败：模型回包不是合法 JSON（SyntaxError），原文 ${v8.length}`),
    `退回原因没换成固定文案：${result.verdict.missing_evidence[0]}`);
  assert.ok(result.verdict.missing_evidence[0].length <= 250, '§5.6：analysis 超 250 字预算');
  assert.equal(result.verdict.analysis, result.verdict.missing_evidence[0]);
  // §3.2「末次回包」是模型回包摘要契约，不是错误原文：过了闸也不许连它一起删。
  assert.match(result.verdict.missing_evidence[0], /末次回包 \d+ 字：「我先梳理一下这条告警/);

  const store = new InvestigationStore(path.join(directory, 'investigations'));
  await store.save(result);
  const { raw } = await diskText(path.join(directory, 'investigations'));
  assert.doesNotMatch(raw, /Unexpected token|is not valid JSON/);
  assert.equal(raw.includes(v8.slice(0, 24)), false, 'V8 报错开头的正文片段落盘了');
});

// A2：原文不是被吞掉——run() 拒绝时 message 与 cause 链照旧，三标记不动（T046 口径）。
test('A2 致命路径：抛错原文与 cause 链可达调用方，三标记照旧；记录侧一个字没落', async t => {
  const directory = await workspace(t);
  const raw = `${MARKER} 接口 500`;
  const model = { model: 'fake', complete: async () => {
    throw Object.assign(new Error(raw), { reply_excerpt: '回包 message 正文 0 字' });
  } };
  await assert.rejects(() => new InvestigationAgent(toolbox(), model).run('revshell:7'),
    error => {
      assert.match(error.message, new RegExp(raw));
      assert.equal(error.cause.message, raw);
      return true;
    });
  // 抛错路径不落盘（docs §3.2「抛错路径……不碰研判记录库」）：目录里没有文件。
  const { names } = await diskText(path.join(directory, 'investigations'));
  assert.deepEqual(names, []);

  const failure = await traceModelCall({ domain: 'triage', role: 'triage', turn: 1, phase: 'investigate' },
    async () => ({ content: `${MARKER} 不是 JSON` }), { decode: reply => JSON.parse(reply.content) })
    .catch(error => error);
  assert.equal(failure.model_decode, true);
  assert.equal(failure.model_reply.content, `${MARKER} 不是 JSON`);
  assert.equal(failure.model_call.outcome, 'invalid_json');
  assert.match(failure.message, /SECRET_BOD/);
});

// 边界：类名白名单。上游自造的 name 不许被抄进记录（docs §3.2「类名只在白名单里出现」）。
test('A1 边界：白名单外的错误类名不进记录，固定文案与字符量照旧', async t => {
  const directory = await workspace(t);
  const raw = `${MARKER} 自造类名`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: conclusion() };
    throw Object.assign(new Error(raw), { name: 'EveInjectedError' });
  } };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  assert.equal(result.review.concerns[0], `独立复核未完成：上游调用失败，原文 ${raw.length} 字未落盘`);
  assert.equal(JSON.stringify(result).includes('EveInjectedError'), false, '白名单外的类名被抄进记录');
  const store = new InvestigationStore(path.join(directory, 'investigations'));
  await store.save(result);
  assert.doesNotMatch((await diskText(path.join(directory, 'investigations'))).raw, CLEAN);
});

// 边界：超长原文。记录只留字符量——不许「原文截 200 字」那种半截抄写。
test('A1 边界：20k 字错误原文只留字符量，记录体积有界', async t => {
  const directory = await workspace(t);
  const raw = `${MARKER} ${'A'.repeat(20000)}`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: conclusion() };
    throw new Error(raw);
  } };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  assert.equal(result.review.concerns[0], `独立复核未完成：上游调用失败，原文 ${raw.length} 字未落盘`);
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 4000, `记录体积失控：${serialized.length} 字`);
  assert.doesNotMatch(serialized, CLEAN);
  // 被抄进去任意一段长正文都算违约：连 100 个 A 都不许出现。
  assert.equal(serialized.includes('A'.repeat(100)), false);
});

// 边界：错误文案里自带「脱敏后长相」——闸必须自己复算字符量，不许把攻击者写的数字抄进去。
test('A1 边界：错误原文伪装成脱敏文案，记录用复算的长度、不抄对方数字', async t => {
  const directory = await workspace(t);
  const raw = `上游调用失败，原文 999 字未落盘 ${MARKER}`;
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: conclusion() };
    throw new Error(raw);
  } };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  assert.equal(result.review.concerns[0], `独立复核未完成：上游调用失败，原文 ${raw.length} 字未落盘`);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('999 字'), false, '把原文里的假长度抄进了记录');
  assert.doesNotMatch(serialized, CLEAN);
});

// 边界：超时口径（docs §3.2 的第二个固定文案）。
test('A1 边界：超时错误落「调用超时」固定文案与字符量', async t => {
  const directory = await workspace(t);
  const raw = 'timeout SECRET_BODY_MARKER';
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls += 1;
    if (calls === 1) return { content: conclusion() };
    throw new Error(raw);
  } };
  const result = await new InvestigationAgent(toolbox(), model).run('revshell:7');

  assert.equal(result.review.concerns[0], `独立复核未完成：调用超时，原文 ${raw.length} 字未落盘`);
  const store = new InvestigationStore(path.join(directory, 'investigations'));
  await store.save(result);
  assert.doesNotMatch((await diskText(path.join(directory, 'investigations'))).raw, CLEAN);
});

// 同族落点：未匹配 syslog 的旁路（docs §3.2「结论正文」的 narrative 面 + 上游 reason 的徽标保留）。
test('A1 未匹配 syslog：模型说明失败与上游查询失败只留徽标 + 字符量，落盘面干净', async t => {
  const directory = await workspace(t);
  const investigations = path.join(directory, 'investigations');
  await mkdir(investigations, { recursive: true });
  const caseDir = path.join(directory, 'case');
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '03-研判事实.md'), '# 研判事实\n来源 192.0.2.2\n');
  const modelError = `${MARKER} 说明调用炸了`;
  const model = { model: 'fake', complete: async () => { throw new Error(modelError); } };
  const upstream = `${MARKER} 上游 503`;
  const agent = new InvestigationAgent(toolbox(), model,
    { load: async () => ({ prompts: { triage: 'T' }, sop: {}, version: 'v1', revision: 'r1' }) },
    { agentIndex: async () => ({ category: 'honeypot', pages: [] }), agentContextPages: async () => [] },
    { evaluate: async () => ({ matched: [] }) });
  const result = await agent.runUnmatchedSyslog({ raw: 'raw', context: {}, parsed: {
    msgid: 'cloudwalker-honeypot', payload: { host_ip: '10.0.0.5' } } },
  { type: 'honeypot', matched: false, reason: `牧云事件查询失败：${upstream}` },
  { case_dir: caseDir, files: ['03-研判事实.md'] });

  const modelFailure = `上游调用失败，原文 ${modelError.length} 字未落盘`;
  const upstreamFailure = `牧云事件查询失败：上游调用失败，原文 ${upstream.length} 字未落盘`;
  assert.equal(result.verdict.analysis, `牧云事件回查与模型说明未完成：${modelFailure}`);
  assert.equal(result.turns[0].note, `说明调用未完成：${modelFailure}`);
  assert.equal(result.verdict.missing_evidence[0], upstreamFailure);
  assert.equal(result.review.missing_evidence[0], upstreamFailure);
  assert.equal(result.trace.find(item => item.kind === 'tool_error').error, upstreamFailure);

  const store = new InvestigationStore(investigations);
  await store.save(result);
  const { names, raw } = await diskText(investigations);
  assert.equal(names.length, 1);
  assert.doesNotMatch(raw, CLEAN);
  assert.equal(raw.includes(upstream.slice(0, 20)), false);
});
