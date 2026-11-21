// P003-T046 验收（tester 侧）：不重复写者自测的断言，只管「文档承诺 → 实测」的接口面。
// 口径只认文档：docs/modules/http-api.md §3.10（回放：参数 / 响应 / 失败口径 / 分支顺序）、§3.3（ID 校验与两种 400 文案）、
// §3.8.2（`/api/logs` 只按事件名/级别/时间过滤，读盘）、docs/architecture.md §3.6（`ai.model_call` 两行字段）、
// docs/modules/investigation-agent.md §3.11（turns 字段 / 挂掉也留快照 / 正文不进快照）、openapi.yaml（InvestigationReplay / InvestigationTurn）。
// 做法：真 HTTP（进程内 listen）+ 真文件 sink + 真研判（替身牧云 / 替身模型），不碰真网络、不碰真时钟。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useLogFile, useJournal, flushLogs } from '../../../src/shared/logging/log.js';
import { createServer } from '../../../server.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';
import { InvestigationStore } from '../../../src/contexts/triage/infrastructure/investigation-store.js';
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { PromptStore } from '../../../prompt-store.js';
import { RegoRuleMaintainer } from '../../../server.js';
import { RuleSessionStore, RuleStore, seedLibrary } from '../../../rule-store.js';
import { WikiWorkbench } from '../../../wiki-workbench.js';
import { WikiStore } from '../../../wiki-store.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ── 契约校验器：openapi.yaml 是唯一的 schema 出处，不手抄字段表 ─────────────────
// YAML 用 python3 转 JSON（仓库无 YAML 依赖）；校验器自己只认识 $ref / type / enum / required /
// properties / additionalProperties:false / items —— 够覆盖本卡六个 schema 用到的全部关键字。
const openapi = JSON.parse(execFileSync('python3', ['-c',
  'import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout, default=str)', path.join(ROOT, 'openapi.yaml')],
{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

const deref = schema => {
  let node = schema;
  for (let hops = 0; node && node.$ref; hops += 1) {
    assert.ok(hops < 10, `$ref 解析成环：${JSON.stringify(node)}`);
    node = node.$ref.replace(/^#\//, '').split('/').reduce((current, key) => current[key], openapi);
  }
  return node;
};

const typeOk = (value, type) => {
  switch (type) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: throw new Error(`校验器不认识的 type=${type}（schema 变了要扩校验器，不许静默放过）`);
  }
};

const validate = (value, schema, at = '$', errors = []) => {
  const rule = deref(schema);
  if (!rule || typeof rule !== 'object') return errors;
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.some(type => typeOk(value, type))) {
      errors.push(`${at}: 类型不符（期望 ${types.join('|')}，实际 ${JSON.stringify(value)?.slice(0, 60)}）`);
      return errors;
    }
  }
  if (rule.enum && !rule.enum.includes(value)) errors.push(`${at}: 不在枚举 ${rule.enum.join('|')}（实际 ${JSON.stringify(value)}）`);
  if (rule.items && Array.isArray(value)) value.forEach((item, index) => validate(item, rule.items, `${at}[${index}]`, errors));
  if (rule.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: 缺必填字段`);
    for (const [key, child] of Object.entries(rule.properties)) if (Object.hasOwn(value, key)) validate(value[key], child, `${at}.${key}`, errors);
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(rule.properties, key)) errors.push(`${at}.${key}: schema 未声明（additionalProperties:false）`);
    }
  }
  return errors;
};

const schemaOf = pointer => ({ $ref: `#/components/schemas/${pointer}` });
const parameterOf = pointer => ({ $ref: `#/components/parameters/${pointer}` });

// ── 装配 ────────────────────────────────────────────────────────────────────
const workspace = async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t046-tester-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
};

const listen = async (t, server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

// 真研判：一轮工具调用 + 一轮带引用结论 + 一轮独立复核。模型调用次数由 counter 记。
const runInvestigation = async (alertId = 'revshell:7') => {
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
  const result = await new InvestigationAgent(toolbox, model, new PromptStore()).run(alertId);
  return { result, counter };
};

// 注入点按文档 §2（createServer 是依赖注入点）：4=history、19=logFile，其余置空（本卡只碰这两件）。
const serve = async (t, { history = null, logFile = null } = {}) => {
  const server = createServer(null, null, null, history, null, null, null,
    { user: null, password: null }, null, null, null, null, null, null, null, null, null, null, logFile);
  return listen(t, server);
};

const get = async (base, route) => {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() };
};

// ── A3：回放响应逐键过 OpenAPI（含 additionalProperties:false） ──────────────
// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A3 回放 200 体逐键过 InvestigationReplay schema（必填/类型/枚举/无多出字段），校验器自检能红', async t => {
  const directory = await workspace(t);
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const { result } = await runInvestigation();
  await history.save(result);
  const base = await serve(t, { history });
  const { status, body } = await get(base, '/api/agent/investigations/revshell:7/replay');

  assert.equal(status, 200);
  assert.deepEqual(validate(body, schemaOf('InvestigationReplay')), [], '回放体与 openapi 的 InvestigationReplay 不一致');
  // turns[] 按 InvestigationTurn 逐条过：11 个必填字段一个不少
  const turnSchema = schemaOf('InvestigationTurn');
  assert.ok(body.turns.length >= 3);
  for (const [index, turn] of body.turns.entries()) {
    assert.deepEqual(validate(turn, turnSchema), [], `turns[${index}] 与 InvestigationTurn 不一致`);
    for (const key of deref(turnSchema).required) assert.ok(Object.hasOwn(turn, key), `turns[${index}] 缺 ${key}`);
  }
  // counts.turns 的口径（schema：「落过事件的模型调用数」）与 turns 条数一致
  assert.equal(body.counts.turns, body.turns.length);
  // verdicts 只列有结论的轮（schema：「只列 turns[].conclusion 非空的轮」）
  assert.equal(body.verdicts.length, body.turns.filter(turn => turn.conclusion !== null).length);
  // 校验器不是永真：四种常见违约都必须被它抓到
  const corruptions = [
    ['多出未声明字段', good => { good.extra_key = 1; }],
    ['缺必填字段', good => { delete good.counts; }],
    ['枚举越界', good => { good.mode = 'deepx'; }],
    ['嵌套枚举越界', good => { good.turns[0].phase = 'nope'; }],
    ['turns 项类型错', good => { good.turns[0].messages = '2'; }]
  ];
  for (const [name, corrupt] of corruptions) {
    const copy = structuredClone(body);
    corrupt(copy);
    assert.ok(validate(copy, schemaOf('InvestigationReplay')).length > 0, `校验器漏了「${name}」`);
  }
});

test('A3 旧案卷（无 turns）回放体同样过 schema：turns/verdicts 空、counts.turns=0，不 500 不伪造', async t => {
  const directory = await workspace(t);
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  await history.save({ alert_id: 'revshell:8', mode: 'deep', model: 'old-model',
    verdict: { verdict: 'threat', verdict_label: '真实威胁', confidence: '中', summary: '旧的结论' },
    validation: { ok: true, errors: [] },
    trace: [{ kind: 'tool', name: 'get_revshell_event', evidence_id: 'cw:1' },
      { kind: 'tool_error', name: 'list_host_events', error: '上游超时' }],
    evidence: [{ evidence_id: 'cw:1', tool: 'get_revshell_event', fetched_at: '2026-11-01T00:00:00.000Z', sha256: 'a'.repeat(64) }] });
  const base = await serve(t, { history });
  const { status, body } = await get(base, '/api/agent/investigations/revshell:8/replay');

  assert.equal(status, 200);
  assert.deepEqual(validate(body, schemaOf('InvestigationReplay')), [], '旧案卷回放体与 schema 不一致');
  assert.deepEqual(body.turns, []);
  assert.deepEqual(body.verdicts, []);
  assert.equal(body.counts.turns, 0);
  assert.deepEqual(body.tool_calls.map(item => item.kind), ['tool', 'tool_error']);
});

// ── A3 边界与错误码：§3.10 失败口径表 + §3.3 两种文案 ─────────────────────────
test('A3 边界：ID 形状 / mode 枚举 / 解码失败的状态码与完整正文（error + code）都对表', async t => {
  const directory = await workspace(t);
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  await history.save({ alert_id: 'revshell:7', mode: 'deep', model: 'm',
    verdict: { verdict: 'threat', verdict_label: '真实威胁', confidence: '中', summary: 's' }, trace: [], evidence: [], turns: [] });
  const base = await serve(t, { history });

  const NOT_FOUND = { error: '该告警暂无已保存的研判记录', code: 'caller_error' };
  const BAD_ID = { error: '告警 ID 或研判模式无效', code: 'caller_error' };
  const BAD_DECODE = { error: '告警 ID 编码无效', code: 'caller_error' };
  const cases = [
    // [场景, 路径, 期望状态, 期望正文]
    ['合法 deep 记录', '/api/agent/investigations/revshell:7/replay', 200, null],
    ['mode 大小写不在白名单（枚举精确匹配）', '/api/agent/investigations/revshell:7/replay?mode=DEEP', 400, BAD_ID],
    ['mode 表外值', '/api/agent/investigations/revshell:7/replay?mode=demo', 400, BAD_ID],
    ['mode 取错：deep 记录按 triage 查', '/api/agent/investigations/revshell:7/replay?mode=triage', 404, NOT_FOUND],
    ['没有记录', '/api/agent/investigations/revshell:9/replay', 404, NOT_FOUND],
    ['序号 0（必须正整数）', '/api/agent/investigations/revshell:0/replay', 400, BAD_ID],
    ['序号为负', '/api/agent/investigations/revshell:-1/replay', 400, BAD_ID],
    ['类型段大写（表里是小写类型）', '/api/agent/investigations/RevShell:7/replay', 400, BAD_ID],
    ['不是告警 ID', '/api/agent/investigations/not-an-id/replay', 400, BAD_ID],
    ['百分号编码坏了（解码失败）', '/api/agent/investigations/%E0%A4%A/replay', 400, BAD_DECODE],
    ['syslog 形态在 mode=deep 下不认', `/api/agent/investigations/${encodeURIComponent('syslog:honeypot:' + 'a'.repeat(16) + ':7:' + 'b'.repeat(8) + '-' + 'b'.repeat(4) + '-' + 'b'.repeat(4) + '-' + 'b'.repeat(4) + '-' + 'b'.repeat(12))}/replay`, 400, BAD_ID]
  ];
  for (const [name, route, expectedStatus, expectedBody] of cases) {
    const { status, body } = await get(base, route);
    assert.equal(status, expectedStatus, `${name}：状态码`);
    if (expectedBody) assert.deepEqual(body, expectedBody, `${name}：正文形状`);
    else assert.equal(body.alert_id, 'revshell:7', `${name}：正文`);
  }
  // 非 GET 不落回放分支，也不许 5xx：P003-T073 起方法不匹配统一 405 + Allow（原 404）。
  const posted = await fetch(`${base}/api/agent/investigations/revshell:7/replay`, { method: 'POST' });
  assert.equal(posted.status, 405);
  assert.equal((await posted.json()).code, 'caller_error');
  assert.match(posted.headers.get('allow'), /GET/);
});

test('A3 分支顺序：/replay 不被当成告警 ID 后缀，单条阅读分支照旧回整份案卷', async t => {
  const directory = await workspace(t);
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const { result } = await runInvestigation();
  await history.save(result);
  const base = await serve(t, { history });

  const replay = await get(base, '/api/agent/investigations/revshell:7/replay');
  const record = await get(base, '/api/agent/investigations/revshell:7');
  assert.equal(replay.status, 200, '/replay 被吞成了别的分支');
  assert.equal(record.status, 200);
  // 两份是不同视图：回放是 counts/turns/tool_calls，案卷是 verdict/trace/evidence
  assert.deepEqual(Object.keys(replay.body).sort(), ['alert_id', 'counts', 'degraded', 'evidence', 'final', 'mode', 'model', 'prompt_version', 'review', 'saved_at', 'tool_calls', 'turns', 'validation', 'verdicts'].sort());
  assert.ok(Object.hasOwn(record.body, 'verdict') && Object.hasOwn(record.body, 'trace'));
  assert.equal(record.body.alert_id, 'revshell:7');
  // 案卷里的 turns 与 schema 的 Investigation.turns 一致（A1/A5 的记录侧落地）
  assert.deepEqual(validate(record.body.turns, deref({ $ref: '#/components/schemas/Investigation' }).properties.turns), []);
});

// ── A1 + A2 + A5：真文件 sink 下三域事件可经 /api/logs 按事件名拉出，行里没有正文 ──
test('A1/A2/A5 e2e：三域调用落进真日志文件，GET /api/logs?event=ai.model_call 能拉全且无正文；回放不新增事件', async t => {
  const directory = await workspace(t);
  const logFile = path.join(directory, 'hids.log');
  useLogFile({ file: logFile, write: () => {} });
  t.after(() => useJournal());

  // 研判域：正文标记进提示词与回包，断言它们一个字都不到盘上
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_revshell_event', description: 'Get original event', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
    ],
    callTool: async () => ({ event: { id: 7, host_id: 1, cmdline: 'TOOL_BODY_MARKER' } })
  });
  const verdict = JSON.stringify({ verdict: '存疑', confidence: '低', summary: 'SUMMARY_BODY_MARKER',
    claims: [{ text: 'CLAIM_BODY_MARKER', citations: [{ evidence_id: 'cw:1', pointer: '/event/cmdline', value: 'TOOL_BODY_MARKER' }] }], missing_data: [] });
  const model = { model: 'fake', complete: async (_messages, tools) => ({ content: tools.length ? verdict
    : JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
  const investigation = await new InvestigationAgent(toolbox, model, new PromptStore()).run('revshell:7');
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  await history.save(investigation);

  // 规则维护域
  await seedLibrary(path.join(directory, 'rules'), path.join(ROOT, 'rules'));
  const ruleModel = { model: 'fake-light', complete: async () => ({ content: JSON.stringify({ ready: true, id: 't046_accept_rule', reason: '补一条可判定的条件',
    rego: 'package hids.rules.t046_accept_rule\n\n# name: 验收规则\n\ndefault match := false\n\nmatch if {\n  input.type == "abnormal_login"\n}\n' }) }) };
  await new RegoRuleMaintainer(ruleModel, new RuleStore(path.join(directory, 'rules')),
    { load: async () => ({ prompts: { rule: '改规则' } }) }, new RuleSessionStore(path.join(directory, 'rule-sessions')))
    .maintain({ caseId: 'abnormal_login:5', eventType: 'abnormal_login', reason: '误报', who: '值班员', alert: { id: 5 }, ruleIds: [] });

  // wiki 维护域
  await seedLibrary(path.join(directory, 'wiki'), path.join(ROOT, 'wiki'));
  const wikiModel = { model: 'fake-light', complete: async () => ({ content: JSON.stringify({ ready: false, reply: '请补充原始记录。' }) }) };
  const workbench = new WikiWorkbench(new WikiStore(path.join(directory, 'wiki')), wikiModel,
    new PromptStore(path.join(directory, 'prompts.json')), path.join(directory, 'sessions'));
  const wikiSession = await workbench.create('common/GEN-01.md');
  await workbench.reply(wikiSession.id, '这条判据漏了样本外的情况');

  const base = await serve(t, { history, logFile });
  const first = await get(base, '/api/logs?event=ai.model_call&count=50');
  assert.equal(first.status, 200);
  assert.ok(first.body.files >= 1, '查询读的是盘（files 计数）');
  const logs = first.body.logs;
  assert.ok(logs.length >= 8, `三域事件条数至少 8（实际 ${logs.length}）`);
  // 三域齐全 + 角色对表（architecture.md §3.6）
  assert.deepEqual([...new Set(logs.map(entry => entry.domain))].sort(), ['rule', 'triage', 'wiki']);
  const roleByDomain = { triage: ['triage', 'review'], rule: ['rule_maintainer'], wiki: ['wiki_maintainer'] };
  for (const entry of logs) {
    assert.ok(roleByDomain[entry.domain].includes(entry.role), `domain=${entry.domain} 的 role=${entry.role} 不在表里`);
    assert.ok(['request', 'response'].includes(entry.direction), `direction=${entry.direction}`);
    assert.ok(Number.isInteger(entry.turn) && entry.turn >= 1, `turn=${entry.turn}`);
    assert.ok(Number.isInteger(entry.attempt) && entry.attempt >= 1, `attempt=${entry.attempt}`);
    if (entry.direction === 'request') assert.equal(entry.outcome, undefined, 'request 行不该有结局');
    else {
      assert.ok(['ok', 'timeout', 'invalid_json', 'error'].includes(entry.outcome), `outcome=${entry.outcome}`);
      assert.ok(Number.isInteger(entry.duration_ms) && Number.isInteger(entry.output_chars));
    }
  }
  // 成对：每条 request 都有同 (domain, role, turn, attempt, phase) 的 response
  const key = entry => `${entry.domain}|${entry.role}|${entry.turn}|${entry.attempt}|${entry.phase}`;
  const responses = new Set(logs.filter(entry => entry.direction === 'response').map(key));
  for (const entry of logs.filter(entry => entry.direction === 'request')) assert.ok(responses.has(key(entry)), `request 没有配对的 response：${key(entry)}`);
  // 正文与工具返回一个字都不在盘上（事件里只有字符量）
  await flushLogs(); // P003-T072：落盘异步 sink，读盘前排空
  const raw = await readFile(logFile, 'utf8');
  assert.doesNotMatch(raw, /SUMMARY_BODY_MARKER|CLAIM_BODY_MARKER|TOOL_BODY_MARKER|样本外的情况/);

  // A3 的「不重放模型」落在事件侧：回放前后 ai.model_call 条数一个不涨
  const before = first.body.total;
  const replay = await get(base, '/api/agent/investigations/revshell:7/replay');
  assert.equal(replay.status, 200);
  const second = await get(base, '/api/logs?event=ai.model_call&count=50');
  assert.equal(second.body.total, before, '回放接口产生了新的模型调用事件');
});

// ── A5：解析失败那次的快照只写固定文案，快照里搜不到回包正文 ─────────────────
test('A5 解析失败：turns.note 是固定文案、快照里搜不到回包正文（§3.11 正文不进快照口径）', async t => {
  const directory = await workspace(t);
  const logFile = path.join(directory, 'hids.log');
  useLogFile({ file: logFile, write: () => {} });
  t.after(() => useJournal());
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_revshell_event', description: 'd', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
    ],
    callTool: async () => ({ event: { id: 7, host_id: 1, cmdline: 'x' } })
  });
  const model = { model: 'fake', complete: async () => ({ content: 'SECRET_BODY_MARKER 不是 JSON' }) };
  const result = await new InvestigationAgent(toolbox, model, new PromptStore()).run('revshell:7');

  const investigate = result.turns.filter(turn => turn.phase === 'investigate');
  assert.ok(investigate.length >= 1);
  for (const turn of investigate) {
    assert.equal(turn.outcome, 'invalid_json');
    assert.equal(turn.note, 'parse_error', 'note 只写固定文案（§3.11 的 note 取值表）');
  }
  const snapshot = JSON.stringify(result.turns);
  assert.doesNotMatch(snapshot, /SECRET_BODY_MARKER|SECRET_BOD|Unexpected token/, '快照里出现了回包正文或 V8 解析原文');
  await flushLogs(); // P003-T072：落盘异步 sink，读盘前排空
  const raw = await readFile(logFile, 'utf8');
  assert.doesNotMatch(raw, /SECRET_BODY_MARKER|SECRET_BOD|Unexpected token/, '日志行里出现了回包正文或 V8 解析原文');
  // 事件侧 error 是固定文案（log.js decode 分支口径）
  const responses = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.event === 'ai.model_call' && entry.direction === 'response');
  for (const entry of responses) assert.equal(entry.error, '模型回包无法解析为 JSON（SyntaxError）');
  // 文档 §3.10 的参数表：replay 只认 mode，没有文档化的 count/offset，schema 也不该把它们当契约
  const replayParams = openapi.paths['/api/agent/investigations/{alertId}/replay'].get.parameters;
  assert.deepEqual(replayParams.map(parameter => deref(parameter)).map(parameter => parameter.name), ['alertId', 'mode']);
  assert.equal(deref(parameterOf('TriageId')).in, 'path');
});
