// P003-T052：记录侧泄漏收口（T051 §4 表 O1–O8）。
// 口径：落盘只写「固定文案 + 原文字符量」；错误对象本身、模型可见的回灌内容、日志行都照旧。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal, useJournal } from '../../../log.js';
import { recordFailure, reasonForRecord } from '../../../record-redaction.js';
import { parseSyslog } from '../../../syslog-input.js';
import { matchSyslogEvent, writeSyslogCase } from '../../../syslog-case.js';
import { runWikiReplay } from '../../../wiki-replay.js';
import { KnowledgeStore } from '../../../knowledge-store.js';
import { KnowledgeWorkbench } from '../../../knowledge-workbench.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { TraceBoardService } from '../../../trace-board.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { collectRequiredEvidence, requiredEvidenceGaps, requiredEvidencePlan } from '../../../required-evidence.js';

// 一条会被 V8 原样带进报错的回包（JSON.parse 的 message 里就有它）。
const SECRET_BODY = 'SECRET_BODY_7f3a9 这是一段不许落盘的上游正文';
const upstreamError = () => new Error(`Unexpected token 'S', "${SECRET_BODY}" is not valid JSON`);

test('G1 闸本体：固定文案 + 字符量 + 类名白名单，且不改错误对象', () => {
  const error = Object.assign(new SyntaxError(`Unexpected token 'S', "${SECRET_BODY}"`), { model_decode: true });
  const text = recordFailure(error);
  assert.equal(text, `模型回包不是合法 JSON（SyntaxError），原文 ${error.message.length} 字未落盘`);
  assert.doesNotMatch(text, /SECRET_BODY/);
  // A4：错误对象一个字不动（三标记上抛靠它）。
  assert.ok(error.model_decode);
  assert.match(error.message, /SECRET_BODY/);
  // 超时识别：文案换成「调用超时」，原文同样不落盘。
  assert.match(recordFailure(new Error('rpc timeout after 30s SECRET_BODY_7f3a9')), /^调用超时，原文 \d+ 字未落盘$/);
  // 非白名单类名不写类名；兜底文案可被调用方改写。
  assert.equal(recordFailure(new Error('boom'), { kind: '本地写入失败' }), '本地写入失败，原文 4 字未落盘');
  assert.equal(recordFailure(new RangeError('x')), '上游调用失败（RangeError），原文 1 字未落盘');
  // 白名单：本地写死的可操作提示照原样留（不是上游原文）。
  const config = new Error('模型尚未配置');
  assert.equal(recordFailure(config, { keep: ['模型尚未配置'] }), '模型尚未配置');
});

// 第四轮拍板（设计变更）：废掉徽标白名单——任何前缀的文本一律归一，不再枚举上游把哪段当「徽标」。
// 代价：本地短文案也一起变泛；收益：漏一个变体就是漏一条原文落盘的路，这条路没了。
test('G1 文本闸：任何前缀的文本一律归一，不保留徽标', () => {
  const raw = upstreamError().message;
  const variants = [`牧云事件查询失败：${raw}`, `牧云事件 ID 详情读取失败：${raw}`,
    `牧云事件详情读取失败：${raw}`, `规则集读取失败：${raw}`, `规则集校验失败：${raw}`, raw];
  for (const variant of variants) {
    const text = reasonForRecord(variant);
    assert.equal(text, `上游调用失败，原文 ${variant.length} 字未落盘`, variant.slice(0, 12));
    assert.doesNotMatch(text, /SECRET_BODY/);
    assert.doesNotMatch(text, /失败：/, '徽标不再保留');
  }
  // 本地短文案也变泛：不泄漏，但丢「哪里失败」的语义（拍板接受的代价）。
  const local = '牧云事件 ID 对应的主机与 syslog 不一致';
  assert.equal(reasonForRecord(local), `上游调用失败，原文 ${local.length} 字未落盘`);
});

// O5（A1 点名）：必查项查询失败时，原文既不许进 trace[evidence_check].reason，
// 也不许经 requiredEvidenceGaps() 进 missing_evidence[0]。
test('O5 必查项查询失败：trace[evidence_check].reason 与 missing_evidence[0] 都过闸', async () => {
  const catalog = [{ name: 'list_host_events', inputSchema: { properties: { host_id: {}, count: {} } } }];
  const original = { view: { facts: { host_id: { value: 41 }, host_ip: { value: '172.16.221.41' } } } };
  const trace = [];
  const checks = await collectRequiredEvidence(requiredEvidencePlan('suspicious_operation', original, catalog),
    { callTool: async () => { throw upstreamError(); } }, () => {}, trace);
  assert.equal(checks[0].status, 'query_failed');
  const entry = trace.find(item => item.kind === 'evidence_check');
  assert.match(entry.reason, /^上游调用失败，原文 \d+ 字未落盘$/);
  assert.doesNotMatch(JSON.stringify(trace), /SECRET_BODY/);
  const gap = requiredEvidenceGaps(checks)[0];
  assert.match(gap, /^同主机关联事件：查询失败；上游调用失败，原文 \d+ 字未落盘(；|$)/);
  assert.doesNotMatch(gap, /SECRET_BODY/);
  // 接口回包不是可确认列表这类自造文案仍照原样（闸不吞本地判定）。
  const fixed = await collectRequiredEvidence(requiredEvidencePlan('suspicious_operation', original, catalog),
    { callTool: async () => ({ evidenceId: 'cw:9', view: { kind: 'other' } }) });
  assert.equal(fixed[0].reason, '接口未返回可确认数量的列表');
});

// ── O6：syslog 未匹配 reason（生产者侧）────────────────────────────────────────
// 两条路必须分开：日志行留原文（P003-T027 契约），返回体/案件文件过闸（记录侧）。
const prefix = '<14>1 2026-11-11T08:00:00Z host cloudwalker 1 ';
const parsed = parseSyslog(prefix + 'cloudwalker-honeypot host_ip="10.0.0.5" host_id=1 '
  + 'event_create_time="2026-11-11 08:00:00" source_ip="192.0.2.2"');

test('O6 未匹配 reason：返回体与案件文件过闸、日志行仍留原文', async t => {
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(JSON.parse(line)) }));
  try {
    const match = await matchSyslogEvent({ listEvents: async () => { throw upstreamError(); } }, parsed);
    assert.equal(match.matched, false);
    assert.match(match.reason, /^上游调用失败，原文 \d+ 字未落盘$/);
    assert.doesNotMatch(match.reason, /SECRET_BODY/);
    const logLine = lines.find(line => line.event === 'syslog.match_failed');
    assert.match(logLine.reason, /牧云事件查询失败：Unexpected token 'S'/);
    const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-case-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const info = await writeSyslogCase({ directory, raw: 'raw line', parsed, context: {}, match });
    const fact = await readFile(path.join(info.case_dir, '03-研判事实.md'), 'utf8');
    assert.match(fact, /匹配情况：上游调用失败，原文 \d+ 字未落盘/);
    assert.doesNotMatch(fact, /SECRET_BODY/);
  } finally { useJournal(); }
});

// ── O8：wiki 回放报告（`proposal.replay.error` 落工作台会话）──────────────────
test('O8 回放报告：模型报错原文不落盘，自造判定语照留', async t => {
  const wiki = {
    get: async file => ({ path: file, id: 'HP-01', revision: 3,
      content: '---\nid: HP-01\nstatus: active\n---\n判据原文：需核对授权。' }),
    agentIndex: async () => ({ pages: [{ id: 'HP-01', path: 'honeypot/HP-01.md', title: '蜜罐', content: '' }] })
  };
  const record = { id: 's1', proposal: { changes: [{ path: 'honeypot/HP-01.md', page_revision: 3, content: 'new' }] },
    feedback: { case_id: 'syslog:case-1', event_type: 'honeypot', expected_verdict: 'false_positive',
      case_snapshot: { '01-原始告警.txt': 'raw alert text', '03-研判事实.md': '仅一次探测' } } };
  const prompts = { load: async () => ({ revision: 1, prompts: {} }) };
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-no-cases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failed = await runWikiReplay({ record, directory, prompts,
    model: { model: 'fake', complete: async () => { throw upstreamError(); } }, wiki });
  assert.equal(failed.cases[0].before.error, failed.cases[0].after.error);
  assert.match(failed.cases[0].before.error, /^回放失败，原文 \d+ 字未落盘$/);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_BODY/);
  assert.equal(failed.cases[0].status, 'invalid');
  assert.equal(failed.status, 'needs_review');
  // 摘录对不上的自造判定语照原样留（调用方要据此改判据，不是上游原文）。
  const judged = await runWikiReplay({ record, directory, prompts, wiki,
    model: { model: 'fake', complete: async () => ({ content: JSON.stringify({ verdict: 'threat',
      basis_quote: '不在材料里的句子', criterion_quote: '判据原文：需核对授权。', reason: 'x' }) }) } });
  assert.equal(judged.cases[0].after.error, '模型结论缺少可在冻结材料和判据中逐字核对的摘录');
});

// ── O4：知识整理工作台的 `last_error`（存进工作台会话）───────────────────────
// ── O7 第三支：模型回包解不出动作（`parseAction` 抛 SyntaxError）───────────────
// 文档（trace-board.md §5.3）说这一支只留固定文案 + 响应长度、不带错误原文；原用例只盖了另一支。
test('O7 回包解不出动作：SyntaxError 支只留固定文案 + 响应长度，原文不落白板', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-board-syntax-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const replies = [`{"action": "investigate", "node": ${SECRET_BODY}`,
    '{"action":"investigate","node":"asset:172.20.208.23","why":"核查资产"}',
    '{"action":"conclude","summary":"未证实横向","gaps":[]}'];
  const service = traceService(directory, { tools: ['list_host_assets'],
    complete: async () => ({ content: replies.shift() || '{}' }) });
  await service.start('honeypot:7');
  await service.running.get('honeypot:7');
  const board = await new TraceBoardService({ directory }).get('honeypot:7');
  const parseError = board.activity.find(item => item.kind === 'model_error');
  assert.match(parseError.detail, /^模型返回的白板操作 JSON 不完整或格式错误；响应长度 \d+$/);
  assert.doesNotMatch(parseError.detail, /SECRET_BODY/);
  assert.doesNotMatch(await persistedBoards(directory), /SECRET_BODY/);
});

async function knowledgeTurn(t, model, content = '补充一句') {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(directory);
  const workbench = new KnowledgeWorkbench(store, model, { load: async () => ({ prompts: { knowledge: '整理' } }) });
  const created = await workbench.create();
  const record = await workbench.reply(created.id, content);
  return { record, reopened: await new KnowledgeStore(directory).get(created.id) };
}

test('O4 last_error 过闸：模型报错原文不落盘，三条自造文案照留', async t => {
  const failed = await knowledgeTurn(t, { complete: async () => { throw upstreamError(); } }, '这条告警需要以后补充。');
  assert.match(failed.record.last_error, /^知识整理失败，原文 \d+ 字未落盘$/);
  assert.doesNotMatch(JSON.stringify(failed.reopened), /SECRET_BODY/);
  // 模型没配：给人看的操作提示不许被抹掉。
  assert.equal((await knowledgeTurn(t, null)).record.last_error, '知识整理模型尚未配置');
  // 回包不是 JSON：V8 原文不落盘，只留固定文案 + 字符量。
  const badJson = await knowledgeTurn(t, { complete: async () => ({ content: `{"fields": ${SECRET_BODY} }` }) });
  assert.match(badJson.record.last_error, /^模型回包不是合法 JSON（SyntaxError），原文 \d+ 字未落盘$/);
  assert.doesNotMatch(badJson.record.last_error, /SECRET_BODY/);
});

// ── O1/O2/O3：triage 队列记录与状态字段 ──────────────────────────────────────
const queueOptions = (directory, extra) => ({ file: path.join(directory, 'queue.json'), concurrency: 1,
  service: { alerts: async () => ({ alerts: [], partial: false }) },
  history: new InvestigationStore(path.join(directory, 'results')), ...extra });

async function waitFor(monitor, id, done = record => record && !['queued', 'running'].includes(record.status)) {
  for (let n = 0; n < 200; n++) {
    const record = monitor.status(id);
    if (done(record)) return record;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`记录 ${id} 没有等到终态`);
}

test('O1 run() 抛错：detail / failure.reason 过闸，原文不进队列状态文件', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-triage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let thrown;
  const monitor = new TriageMonitor(queueOptions(directory, {
    investigator: { run: async () => { thrown = upstreamError(); throw thrown; } }, retryMaxAttempts: 1 }));
  await monitor.load();
  await monitor.enqueue('honeypot:1');
  const record = await waitFor(monitor, 'honeypot:1');
  assert.equal(record.status, 'failed');
  assert.match(record.detail, /^上游调用失败，原文 \d+ 字未落盘$/);
  assert.equal(record.failure.reason, record.detail);
  // A4：错误对象本身没被动过（上抛侧照旧拿原文），落盘的 code 仍取错误名。
  assert.match(thrown.message, /SECRET_BODY/);
  assert.equal(record.failure.code, 'Error');
  await monitor.writeChain;
  assert.doesNotMatch(await readFile(path.join(directory, 'queue.json'), 'utf8'), /SECRET_BODY/);
});

test('O2 规则评估抛错：record.steps[].detail 过闸', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-rule-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor(queueOptions(directory, {
    ruleEngine: { evaluate: async () => { throw upstreamError(); } },
    investigator: { run: async alertId => ({ alert_id: alertId, mode: 'triage',
      verdict: { verdict: 'undetermined', summary: '待复核', claims: [] }, validation: { ok: true } }) } }));
  await monitor.load();
  await monitor.enqueue('honeypot:2');
  const record = await waitFor(monitor, 'honeypot:2');
  assert.equal(record.status, 'done');
  const step = record.steps.find(item => item.stage === '规则评估');
  // 抛错那一路：catch 只带原文，不在 catch 里预套闸（避免二次归一报错字符量），统一在写入处归一。
  assert.equal(step.detail, `上游调用失败，原文 ${`规则评估失败：${upstreamError().message}`.length} 字未落盘`);
  assert.doesNotMatch(step.detail, /SECRET_BODY/);
});

// O2b（第四轮：设计变更后的守卫）：`ruleEngine` 回 `status:'error'` 时的理由形状不穷举
// （`triage-rules.js:263/267/284` 今天三条，明天可能第四条），所以断言不做前缀白名单，
// 而是枚举真实变体 + 裸原文，钉住「任何变体都不落原文」。
const ruleErrorVariants = () => {
  const raw = upstreamError().message;
  return [`牧云事件查询失败：${raw}`,         // syslog-case 列表查询支
    `牧云事件 ID 详情读取失败：${raw}`,       // syslog-case 详情支
    `牧云事件详情读取失败：${raw}`,           // triage-rules.js:284（无「ID」——第三轮漏的就是这条）
    `规则集读取失败：${raw}`,                 // triage-rules.js:263
    `规则集校验失败：${raw}`,                 // triage-rules.js:267
    raw];                                    // 裸原文：第五个变体长什么样都逃不掉
};

test('O2b 规则引擎任何 reason 变体都不落原文（steps / 队列文件 / 研判记录三面）', async t => {
  for (const variant of ruleErrorVariants()) {
    const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-rule-error-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let seen = null;
    const monitor = new TriageMonitor(queueOptions(directory, {
      ruleEngine: { evaluate: async () => ({ status: 'error', reason: variant }) },
      investigator: { run: async (alertId, { ruleEvaluation }) => { seen = ruleEvaluation;
        return { alert_id: alertId, mode: 'triage',
          verdict: { verdict: 'undetermined', summary: '待复核', claims: [] }, validation: { ok: true } }; } } }));
    await monitor.load();
    await monitor.enqueue('honeypot:3');
    const record = await waitFor(monitor, 'honeypot:3');
    assert.equal(record.status, 'done');
    const expected = `上游调用失败，原文 ${variant.length} 字未落盘`;
    const step = record.steps.find(item => item.stage === '规则评估');
    assert.equal(step.detail, expected, variant.slice(0, 12));
    // A4：回灌给模型的那份仍是原文（模型靠它认出配置/网络错在哪）。
    assert.equal(seen.reason, variant);
    await monitor.writeChain;
    assert.doesNotMatch(await readFile(path.join(directory, 'queue.json'), 'utf8'), /SECRET_BODY/);
    // 第二处：研判记录（`result.rule_evaluation`，与案件 `result.json` 同一个对象）。
    const saved = await monitor.history.latest('honeypot:3', 'triage');
    assert.equal(saved.rule_evaluation.reason, expected);
    assert.doesNotMatch(JSON.stringify(saved), /SECRET_BODY/);
  }
});

// 例外（第四轮定的边界）：`candidate` / `observed` 两条模板是我们自己拼的（含 rule.id、不含上游文本），
// 不过闸——否则队列里会把「命中规则」写成「上游调用失败」，误导运维。
test('O2c 规则命中的模板不过闸（不含上游文本）', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-rule-hit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor(queueOptions(directory, {
    ruleEngine: { evaluate: async () => ({ status: 'candidate', rule: { id: 'R-7' }, revision: 'r1' }) },
    investigator: { run: async alertId => ({ alert_id: alertId, mode: 'triage',
      verdict: { verdict: 'undetermined', summary: '待复核', claims: [] }, validation: { ok: true } }) } }));
  await monitor.load();
  await monitor.enqueue('honeypot:4');
  const record = await waitFor(monitor, 'honeypot:4');
  assert.equal(record.steps.find(item => item.stage === '规则评估').detail, '命中 R-7，作为误报候选交由 AI 复核');
});

test('O3 lastError 过闸：syslog 解析报错原文不落盘，自造判定语照留', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-lasterror-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor(queueOptions(directory, { inputMode: 'syslog', concurrency: 0 }));
  await monitor.load();
  const badJson = '<14>1 2026-11-11T08:00:00Z host cloudwalker 1 cloudwalker-honeypot {"event_id": SECRET_BODY_7f3a9}';
  const rejected = await monitor.acceptSyslog(badJson);
  assert.match(rejected.error, /^syslog 解析失败：上游调用失败（SyntaxError），原文 \d+ 字未落盘$/);
  assert.doesNotMatch(monitor.summary().last_error, /SECRET_BODY/);
  const notSyslog = await monitor.acceptSyslog('garbage');
  assert.equal(notSyslog.error, 'syslog 解析失败：不是合法的 RFC5424 syslog 行');
});

// ── O7：溯源白板（`board.gaps` / `board.activity` 落白板 JSON）────────────────
const seedEvent = { event: { id: 7, event_name: '蜜罐攻击', source_ip: '64.177.57.21',
  host_view: { host_ip: '172.20.208.23', host_name: 'demo', host_id: 874 } } };
const seedView = { facts: { host_ip: { value: '172.20.208.23', pointer: '/event/host_view/host_ip' },
  source_ip: { value: '64.177.57.21', pointer: '/event/source_ip' } } };
const traceService = (directory, { complete, callTool, tools = [] }) => new TraceBoardService({ directory,
  toolbox: { listTools: async () => tools.map(name => ({ name })), investigation: () => ({
    started: 0, maxCalls: 20, records: new Map(), verifyClaims: () => ({ ok: false }),
    callTool: callTool || (async name => ({ evidenceId: 'cw:1', tool: name, result: seedEvent, view: seedView })) }) },
  model: { model: 'fake', complete }, promptStore: { load: async () => ({ prompts: { trace: '按白板行动' } }) } });
const persistedBoards = async directory => (await Promise.all((await readdir(directory))
  .filter(name => name.endsWith('.json')).map(name => readFile(path.join(directory, name), 'utf8')))).join('\n');

test('O7 调查中断：白板 gaps 与 error 活动过闸，原文不落盘', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-board-fatal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = traceService(directory, { complete: async () => { throw upstreamError(); } });
  await service.start('honeypot:7');
  await service.running.get('honeypot:7');
  const board = await new TraceBoardService({ directory }).get('honeypot:7');
  assert.equal(board.status, 'failed');
  assert.match(board.gaps.at(-1).reason, /^上游调用失败，原文 \d+ 字未落盘$/);
  const interrupted = board.activity.find(item => item.kind === 'error' && item.title === '调查中断');
  assert.match(interrupted.detail, /^上游调用失败，原文 \d+ 字未落盘$/);
  assert.doesNotMatch(await persistedBoards(directory), /SECRET_BODY/);
});

test('O7 工具报错与动作驳回：活动详情过闸，回灌模型的错误仍是原文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-board-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actions = ['{"action":"investigate","node":"asset:172.20.208.23","why":"核查资产"}',
    '{"action":"fly"}',
    '{"action":"link","from":"ip:64.177.57.21","to":"asset:172.20.208.23","rel":"探测","why":"无引用",'
      + '"citations":[{"evidence_id":"cw:99","pointer":"/source_ip","value":"64.177.57.21"}]}',
    '{"action":"conclude","summary":"未证实横向","gaps":[]}'];
  const seen = [];
  const service = traceService(directory, {
    tools: ['list_host_assets'],
    callTool: async name => {
      if (name === 'get_honeypot_event') return { evidenceId: 'cw:1', tool: name, result: seedEvent, view: seedView };
      throw upstreamError();
    },
    complete: async messages => { seen.push(JSON.stringify(messages)); return { content: actions.shift() }; } });
  await service.start('honeypot:7');
  await service.running.get('honeypot:7');
  const board = await new TraceBoardService({ directory }).get('honeypot:7');
  const toolError = board.activity.find(item => item.title === 'list_host_assets 查询失败');
  assert.match(toolError.detail, /^上游调用失败，原文 \d+ 字未落盘$/);
  const rejected = board.activity.find(item => item.title === '操作未通过校验');
  assert.match(rejected.detail, /^操作未通过校验，原文 \d+ 字未落盘$/);
  assert.doesNotMatch(rejected.detail, /关系边缺少有效原始证据引用/);
  const badAction = board.activity.find(item => item.kind === 'model_error');
  assert.match(badAction.detail, /^白板操作失败，原文 \d+ 字未落盘；响应长度 \d+$/);
  assert.doesNotMatch(badAction.detail, /模型未返回有效的白板操作/);
  // A4：驳回原因照旧回灌模型（模型靠它改参数），只是不落白板。
  assert.ok(seen.some(text => text.includes('关系边缺少有效原始证据引用')));
  assert.doesNotMatch(await persistedBoards(directory), /SECRET_BODY/);
});
