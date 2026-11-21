// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js 求值前把 HIDS_DATA_DIR
// 指到本进程的临时根，否则 createServer 的缺省 fpSessions 会往真全局根写维护会话。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createAnalysisProvider, RegoRuleMaintainer } from './server.js';
import { RuleStore } from './src/contexts/knowledge/infrastructure/rule-store.js';
import { TraceBoardService } from './src/contexts/trace/application/trace-service.js';
import { BoardStore } from './src/contexts/trace/infrastructure/board-store.js';
import { InvestigationStore } from './src/contexts/triage/infrastructure/investigation-store.js';
import { PromptStore } from './src/contexts/knowledge/infrastructure/prompt-store.js';
import { TriageMonitor } from './src/contexts/triage/application/triage-monitor.js';

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('remote access password protects API reads and writes', async t => {
  const server = createServer(null, null, null, null, null, null, null, { user: 'operator', password: 'test-only-password' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const denied = await fetch(`${base}/api/session`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /Basic/);
  assert.equal((await fetch(`${base}/api/agent/prompts/upload`, { method: 'POST', body: 'secret' })).status, 401);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Authorization: `Basic ${Buffer.from('operator:test-only-password').toString('base64')}` } })).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 401);
});

test('investigation API accepts one typed alert and returns the Agent result', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-investigations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(directory);
  const promptStore = new PromptStore(path.join(directory, 'prompt-overrides.json'));
  const calls = [];
  const investigator = {
    model: { model: 'fake-model' },
    prompts: async () => ({ triage: 'triage', deep: 'deep', knowledge: 'knowledge', scenarios: { cards: [] } }),
    run: async (alertId, options) => { calls.push({ alertId, options }); return { alert_id: alertId, mode: options.mode,
      verdict: { verdict: 'needs_review', summary: '需要核对', claims: [] }, trace: [{ kind: 'tool', evidence_id: 'cw:1' }] }; }
  };
  const server = createServer(null, null, investigator, history, promptStore, null, null, undefined, null, 'test-prompt-token');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api/agent/status`)).json();
  assert.equal(status.configured, true);
  const metadataResponse = await fetch(`${base}/api/agent/prompts`);
  const metadataText = await metadataResponse.text();
  const prompts = JSON.parse(metadataText);
  assert.equal(prompts.prompts, undefined);
  assert.equal(prompts.scenarios, undefined);
  assert.equal(prompts.sections.filter(section => section.kind === 'scenario').length, 13);
  assert.equal(prompts.sections.filter(section => section.kind === 'sop').length, 14);
  assert.equal(prompts.sections.find(section => section.id === 'scenario:honeypot').name, '蜜罐诱捕');
  assert.doesNotMatch(metadataText, /证据驱动|研判目标/);
  assert.equal((await fetch(`${base}/backend/prompts/triage.md`)).status, 404);
  assert.equal((await fetch(`${base}/api/agent/prompts`, { method: 'PUT', body: '{}' })).status, 405);
  const uploadHeaders = { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Prompt-Section': 'scenario:honeypot',
    'If-Match': prompts.revision, 'X-Prompt-Admin-Token': 'test-prompt-token' };
  assert.equal((await fetch(`${base}/api/agent/prompts/upload`, { method: 'POST', headers: uploadHeaders,
    body: '业务端不再接受提示词上传' })).status, 410);
  const reloaded = await new PromptStore(path.join(directory, 'prompt-overrides.json')).load();
  assert.equal(reloaded.revision, prompts.revision);
  const response = await fetch(`${base}/api/agent/investigations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alert_id: 'revshell:7', mode: 'deep' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.verdict.verdict, 'needs_review');
  assert.ok(result.saved_at);
  const saved = await (await fetch(`${base}/api/agent/investigations/revshell%3A7?mode=deep`)).json();
  assert.deepEqual(saved, result);
  assert.deepEqual(await new InvestigationStore(directory).latest('revshell:7', 'deep'), result);
  assert.equal((await fetch(`${base}/api/agent/investigations/revshell%3A8`)).status, 404);
  assert.equal((await fetch(`${base}/api/agent/investigations/not-an-id`)).status, 400);
  assert.deepEqual(calls, [{ alertId: 'revshell:7', options: { mode: 'deep' } }]);
  assert.equal((await fetch(`${base}/api/agent/investigations`, { method: 'POST', body: '{' })).status, 400);
});

test('streaming investigation reports progress and persists its result', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const investigator = { model: { model: 'fake-model' }, run: async (alertId, { mode, onProgress }) => {
    onProgress('查询证据', '正在查询 list_host_events');
    onProgress('独立复核', '正在核对结论');
    return { alert_id: alertId, mode, verdict: { verdict: 'undetermined' } };
  } };
  const server = createServer(null, null, investigator, new InvestigationStore(directory), new PromptStore(path.join(directory, 'prompts.json')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/agent/investigations?stream=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alert_id: 'revshell:7', mode: 'deep' })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: '))
    .map(frame => JSON.parse(frame.slice(6)));
  assert.deepEqual(events.map(event => event.type), ['progress', 'progress', 'result']);
  assert.deepEqual(events.slice(0, 2).map(event => event.stage), ['查询证据', '独立复核']);
  assert.equal(events[2].result.verdict.verdict, 'undetermined');
  assert.deepEqual(await new InvestigationStore(directory).latest('revshell:7', 'deep'), events[2].result);
});

test('alert API exposes automatic triage state separately from deep investigation', async t => {
  const status = { alert_id: 'honeypot:7', status: 'running', stage: '查询证据', steps: [] };
  let enabled = true;
  const monitor = { summary: () => ({ initialized: true, counts: { running: 1 } }),
    status: id => id === status.alert_id ? status : null,
    enqueue: async id => ({ alert_id: id, status: 'queued', steps: [] }),
    setEnabled: async next => { if (typeof next !== 'boolean') { const error = new Error('enabled 必须为布尔值'); error.status = 400; throw error; } enabled = next; return { enabled }; } };
  const service = { alerts: async () => ({ alerts: [{ id: 'honeypot:7' }], total: 1, totals: {}, errors: {}, partial: false }),
    alert: async () => ({ alert: { id: 'honeypot:7' }, detail: { id: 7 } }) };
  const server = createServer(service, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/alerts`)).json()).alerts[0].triage.status, 'running');
  assert.equal((await (await fetch(`${base}/api/alerts/honeypot%3A7`)).json()).alert.triage.stage, '查询证据');
  assert.equal((await (await fetch(`${base}/api/agent/triage/honeypot%3A7`)).json()).status, 'running');
  assert.equal((await fetch(`${base}/api/agent/triage/honeypot%3A7`, { method: 'POST' })).status, 202);
  const paused = await fetch(`${base}/api/agent/triage/control`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).enabled, false);
  assert.equal((await fetch(`${base}/api/agent/triage/control`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'false' }) })).status, 400);
  assert.equal(enabled, false);
  assert.equal((await fetch(`${base}/api/agent/triage/bad-id`)).status, 400);
});

test('研判记录列表可按结论 / 类型 / 主机 / 时间筛，total 是过滤后条数，非法值回 400', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-cases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), service: {}, investigator: {}, history: {} });
  const addCase = (alertId, msgid, hostIp, eventTime, verdict) => monitor.records.set(alertId, { alert_id: alertId,
    status: 'done', verdict, repeat_count: 1, created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:00.000Z',
    input: { raw: '', parsed: { msgid, ts: '2026-11-03T08:00:00Z', payload: { host_ip: hostIp, event_create_time: eventTime } } } });
  const threat = 'syslog:revshell:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e41';
  const uncertain = 'syslog:webshell:bbbbbbbbbbbbbbbb:1763396400:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e42';
  const quiet = 'syslog:revshell:cccccccccccccccc:1763400000:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
  addCase(threat, 'cloudwalker-revshell', '10.0.0.5', '2026-11-03 10:00:00', 'threat');
  addCase(uncertain, 'cloudwalker-webshell', '10.0.0.6', '2026-11-03 11:00:00', 'uncertain');
  addCase(quiet, 'cloudwalker-revshell', '10.0.0.5', '2026-11-03 12:00:00', undefined);
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = async query => (await fetch(`${base}/api/agent/triage/cases${query}`)).json();
  const statusOf = async query => (await fetch(`${base}/api/agent/triage/cases${query}`)).status;
  assert.equal((await list('')).total, 3);
  // 结论：没有结论的案件按 review 参与筛选（与 GET /api/alerts?verdict= 同口径）
  assert.deepEqual((await list('?verdict=threat')).cases.map(item => item.alert_id), [threat]);
  assert.deepEqual((await list('?verdict=review')).cases.map(item => item.alert_id), [quiet]);
  assert.equal((await list('?type=webshell')).total, 1);
  assert.equal((await list('?host=10.0.0.5')).total, 2);
  assert.equal((await list('?type=revshell&host=10.0.0.5&verdict=threat')).total, 1);
  // 时间筛：RFC3339 与秒级时间戳都收，含端点
  assert.deepEqual((await list('?from=2026-11-03T10:59:00Z&to=2026-11-03T11:01:00Z')).cases.map(item => item.alert_id), [uncertain]);
  const atEleven = Math.floor(Date.parse('2026-11-03T11:00:00Z') / 1000);
  assert.deepEqual((await list(`?from=${atEleven}&to=${atEleven}`)).cases.map(item => item.alert_id), [uncertain]);
  // 结论排序：threat 在最前，无结论在最后
  assert.deepEqual((await list('?sort=verdict')).cases.map(item => item.alert_id), [threat, uncertain, quiet]);
  // 分页在过滤之后切，total 不随 count/offset 变
  const paged = await list('?verdict=threat,uncertain&count=1&offset=1');
  assert.equal(paged.total, 2);
  assert.deepEqual(paged.cases.map(item => item.alert_id), [threat]);
  assert.deepEqual((await list('?verdict=threat,uncertain&count=1&offset=0')).cases.map(item => item.alert_id), [uncertain]);
  for (const [query, message] of [['?verdict=bogus', '筛选结论无效：bogus'], ['?type=nonsense', '筛选事件类型无效：nonsense'],
    ['?sort=level', '排序方式无效：level'], ['?from=not-a-time', '筛选起始时间无效：not-a-time'],
    ['?from=2026-11-04T00:00:00Z&to=2026-11-03T00:00:00Z', '筛选起始时间晚于结束时间'], ['?count=0', '分页参数无效']]) {
    assert.equal(await statusOf(query), 400, query);
    assert.equal((await list(query)).error, message, query);
  }
});

test('syslog 形态的 alert_id 直接打开研判记录，不要求先有牧云事件号', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-open-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), service: {}, investigator: {}, history: {} });
  const alertId = 'syslog:revshell:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e41';
  monitor.records.set(alertId, { alert_id: alertId, matched_alert_id: null, status: 'done', stage: '研判完成',
    detail: '已核验', verdict: 'threat', verdict_label: '真实威胁', repeat_count: 2, steps: [],
    created_at: '2026-11-03T08:00:00.000Z', updated_at: '2026-11-03T08:00:10.000Z',
    input: { raw: '<134>1 2026-11-03T08:00:00Z host app - cloudwalker-revshell host_ip="10.0.0.5"', parsed: {
      msgid: 'cloudwalker-revshell', ts: '2026-11-03T08:00:00Z', payload: { host_ip: '10.0.0.5', event_create_time: '2026-11-03 10:00:00' } } } });
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = async id => (await fetch(`${base}/api/agent/triage/${encodeURIComponent(id)}`)).json();
  // 没有匹配到牧云事件（matched_alert_id 为 null）也能按 syslog ID 打开
  const opened = await open(alertId);
  assert.equal(opened.alert_id, alertId);
  assert.equal(opened.status, 'done');
  assert.equal(opened.verdict, 'threat');
  assert.equal(opened.repeat_count, 2);
  assert.equal(opened.matched_alert_id, null);
  assert.equal('input' in opened, false);
  // 列表项里的 alert_id 原样能打开，闭环
  const listed = monitor.cases().cases[0].alert_id;
  assert.equal(listed, alertId);
  assert.equal((await open(listed)).alert_id, alertId);
  // 形状合法但没入队的 syslog ID 回 not_queued 占位，不是 404，也不需要牧云事件号
  const unknown = 'syslog:webshell:dddddddddddddddd:1763403600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e44';
  const placeholder = await open(unknown);
  assert.equal(placeholder.status, 'not_queued');
  assert.deepEqual(placeholder.evidence, []);
  // 形状不对才 400
  assert.equal((await fetch(`${base}/api/agent/triage/syslog%3Arevshell%3Axyz`)).status, 400);
});

test('trace board API starts and restores an alert board', async t => {
  const board = { alert_id: 'honeypot:7', status: 'running', nodes: [], edges: [] };
  const calls = [];
  const boardService = { start: async (id, focus) => { calls.push({ id, focus }); return board; },
    get: async id => id === 'honeypot:7' ? board : null,
    page: async () => ({ boards: [{ id: 'honeypot:7', title: '蜜罐调查', status: 'running' }], total: 1 }) };
  const server = createServer(null, null, null, null, null, null, null, {}, boardService);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alert_id: 'honeypot:7', focus: '追查来源' }) });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), board);
  assert.deepEqual(calls, [{ id: 'honeypot:7', focus: '追查来源' }]);
  assert.deepEqual(await (await fetch(`${base}/api/trace/boards`)).json(),
    { boards: [{ id: 'honeypot:7', title: '蜜罐调查', status: 'running' }], total: 1 });
  assert.deepEqual(await (await fetch(`${base}/api/trace/boards/honeypot%3A7`)).json(), board);
  assert.equal((await fetch(`${base}/api/trace/boards/honeypot%3A8`)).status, 404);
  assert.equal((await fetch(`${base}/api/trace/boards/bad-id`)).status, 400);
});

test('总览接口出结论分布 / 类型分布，带 since 只算该时刻后入队的记录，非法时间回 400', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-summary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), service: {}, investigator: {}, history: {} });
  const add = (alertId, { status = 'done', verdict, createdAt, msgid }) => monitor.records.set(alertId, {
    alert_id: alertId, status, verdict, created_at: createdAt, updated_at: createdAt,
    ...(msgid ? { input: { raw: '', parsed: { msgid, ts: '2026-11-03T08:00:00Z', payload: {} } } } : {}) });
  add('syslog:revshell:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e41',
    { verdict: 'threat', createdAt: '2026-11-03T08:00:00.000Z', msgid: 'cloudwalker-revshell' });
  add('syslog:webshell:bbbbbbbbbbbbbbbb:1763396400:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e42',
    { verdict: 'uncertain', createdAt: '2026-11-04T09:00:00.000Z', msgid: 'cloudwalker-webshell' });
  add('syslog:honeypot:cccccccccccccccc:1763400000:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43',
    { status: 'queued', createdAt: '2026-11-04T10:00:00.000Z', msgid: 'cloudwalker-honeypot' });
  add('honeypot:5', { status: 'failed', verdict: 'false_positive', createdAt: '2026-11-04T11:00:00.000Z' });
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const summary = async query => (await fetch(`${base}/api/agent/triage/status${query}`)).json();

  const all = await summary('');
  assert.deepEqual(all.counts, { queued: 1, running: 0, done: 2, failed: 1 });
  assert.deepEqual(all.verdict_counts, { threat: 1, uncertain: 1, false_positive: 1, review: 1 });
  assert.deepEqual(all.type_counts, { revshell: 1, webshell: 1, honeypot: 1, unknown: 1 });
  assert.equal(all.since, null);

  // RFC3339 与秒级时间戳都收；含端点，三个聚合共用同一份记录集
  const later = await summary('?since=2026-11-04T00:00:00Z');
  assert.equal(later.since, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(later.counts, { queued: 1, running: 0, done: 1, failed: 1 });
  assert.deepEqual(later.verdict_counts, { threat: 0, uncertain: 1, false_positive: 1, review: 1 });
  assert.deepEqual(later.type_counts, { webshell: 1, honeypot: 1, unknown: 1 });
  const tenOClock = Math.floor(Date.parse('2026-11-04T10:00:00Z') / 1000);
  const atTen = await summary(`?since=${tenOClock}`);
  assert.deepEqual(atTen.counts, { queued: 1, running: 0, done: 0, failed: 1 });
  assert.equal(atTen.verdict_counts.review, 1);

  // 非法时间 400（与 /api/alerts、/api/agent/triage/cases 同一套文案）；空值等于不带筛
  const invalid = await fetch(`${base}/api/agent/triage/status?since=not-a-time`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, '筛选起始时间无效：not-a-time');
  const blank = await summary('?since=');
  assert.equal(blank.since, null);
  assert.deepEqual(blank.counts, all.counts);
});

test('总览接口在 syslog 模式透出最后一条到达时刻，poll 模式不给这个键', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-triage-received-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // 只验路由透传与键的有无：到达时刻的写入 / 持久化在 triage-monitor.test.js 里钉住，
  // 这里不 acceptSyslog，避免后台 persist 与目录清理打架。
  const syslog = new TriageMonitor({ service: {}, investigator: {}, history: {},
    inputMode: 'syslog', file: path.join(directory, 'syslog.json') });
  syslog.lastReceivedAt = '2026-11-03T08:00:00.000Z';
  const server = createServer(null, null, null, null, null, syslog);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = await (await fetch(`${base}/api/agent/triage/status`)).json();
  assert.equal(body.last_received_at, '2026-11-03T08:00:00.000Z');
  assert.equal(body.last_poll_at, null);
  assert.deepEqual(body.verdict_counts, { threat: 0, uncertain: 0, false_positive: 0, review: 0 });
  assert.deepEqual(body.type_counts, {});
  assert.equal(body.since, null);

  const polling = new TriageMonitor({ service: {}, investigator: {}, history: {},
    file: path.join(directory, 'poll.json') });
  const pollServer = createServer(null, null, null, null, null, polling);
  await new Promise(resolve => pollServer.listen(0, '127.0.0.1', resolve));
  t.after(() => pollServer.close());
  const pollBase = `http://127.0.0.1:${pollServer.address().port}`;
  const pollBody = await (await fetch(`${pollBase}/api/agent/triage/status`)).json();
  assert.equal('last_received_at' in pollBody, false);
  assert.equal('interval_ms' in pollBody, true);
});

// ---------- P003-T014：溯源列表筛选与 200/202 语义 ----------

test('白板列表把状态/类型/主机/时间筛选交给服务层，非法值回 400 且不调服务层', async t => {
  const seen = [];
  const boardService = { page: async options => { seen.push(options); return { boards: [], total: 0 }; } };
  const server = createServer(null, null, null, null, null, null, null, {}, boardService);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/trace/boards?count=5&offset=2&status=done&type=honeypot` +
    '&host=10.0.0.1&from=2026-11-18T00:00:00Z&to=1795046400');
  assert.equal(response.status, 200);
  assert.deepEqual(seen[0], { count: 5, offset: 2, statuses: ['done'], type: 'honeypot', host: '10.0.0.1',
    from: Date.parse('2026-11-18T00:00:00Z'), to: 1795046400000 });

  const before = seen.length;
  for (const [query, message] of [['status=bogus', /筛选状态无效/], ['type=bogus', /筛选事件类型无效/],
    ['from=not-a-time', /筛选起始时间无效/], ['to=bad', /筛选结束时间无效/],
    ['from=2026-11-19T00:00:00Z&to=2026-11-18T00:00:00Z', /晚于结束时间/]]) {
    const failed = await fetch(`${base}/api/trace/boards?${query}`);
    assert.equal(failed.status, 400, `${query} 应回 400`);
    assert.match((await failed.json()).error, message);
  }
  assert.equal(seen.length, before);
  await fetch(`${base}/api/trace/boards`);
  assert.deepEqual(seen.at(-1), { count: 20, offset: 0 });
});

test('POST 白板：已有返回 200，新建返回 202，syslog 形态告警 ID 也收', async t => {
  const calls = [];
  const boardService = { get: async () => null,
    startOrResume: async (id, focus) => { calls.push({ id, focus });
      return { created: id !== 'honeypot:7', board: { alert_id: id, status: 'running' } }; } };
  const server = createServer(null, null, null, null, null, null, null, {}, boardService);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const syslog = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
  const post = async target => {
    const response = await fetch(`${base}/api/trace/boards`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, focus: '看链' }) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await post('honeypot:7'), { status: 200, body: { alert_id: 'honeypot:7', status: 'running' } });
  assert.deepEqual(await post(syslog), { status: 202, body: { alert_id: syslog, status: 'running' } });
  assert.deepEqual(calls, [{ id: 'honeypot:7', focus: '看链' }, { id: syslog, focus: '看链' }]);
});

// ---------- P003-T014 复审：分析证据从研判记录的案卷取，不读 status().input ----------

const SYSLOG_ALERT = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
const RAW_SYSLOG = '<134>1 2026-11-18T03:00:00Z host app 1 cloudwalker-honeypot [meta ' +
  'host_ip="172.20.208.23" source_ip="64.177.57.21" event_create_time="2026-11-18 11:00:00" ' +
  'event_name="蜜罐诱捕"]';

async function caseDirectory(t, raw = RAW_SYSLOG) {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-analysis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caseDir = path.join(directory, 'case');
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '01-原始告警.txt'), raw);
  return caseDir;
}

test('A4 分析证据从研判记录的案卷读原始报文，status() 的 input 一律不碰', async t => {
  const caseDir = await caseDirectory(t);
  const record = { alert_id: 'honeypot:7', mode: 'triage', case_dir: caseDir,
    evidence: [{ evidence_id: 'cw:1', tool: 'get_honeypot_event' },
      { evidence_id: 'syslog:1', tool: 'received_syslog' }] };
  const history = { latest: async (id, mode) => id === 'honeypot:7' && mode === 'triage' ? record : null };
  // 瘦身记录里没有 input（triage-monitor.js 的 status() 行为）；读了就抛。
  const monitor = { status: id => id === 'honeypot:7' ? { alert_id: id, result_alert_id: 'honeypot:7',
    get input() { throw new Error('不许读 status().input'); } } : null };
  const alert = await createAnalysisProvider({ monitor, history })('honeypot:7');
  assert.equal(alert.evidence_id, 'syslog:1');
  assert.equal(alert.type, 'honeypot');
  assert.equal(alert.facts.host_ip, '172.20.208.23');
  assert.equal(alert.facts.source_ip, '64.177.57.21');
  assert.equal(alert.facts.title, '蜜罐诱捕');
  assert.equal(alert.facts.occurred_at, '2026-11-18T03:00:00.000Z');
});

test('A4 研判记录还没落盘时用 status() 公开的 case_dir 定位案卷；都没有就回 null', async t => {
  const caseDir = await caseDirectory(t);
  const monitor = { status: id => id === 'honeypot:7' ? { alert_id: id, case_dir: caseDir,
    get input() { throw new Error('不许读 status().input'); } } : null };
  const alert = await createAnalysisProvider({ monitor, history: null })('honeypot:7');
  assert.equal(alert.facts.host_ip, '172.20.208.23');
  assert.equal(await createAnalysisProvider({ monitor, history: null })('webshell:1'), null);

  const noCase = { status: () => ({ alert_id: 'honeypot:9' }) };
  assert.equal(await createAnalysisProvider({ monitor: noCase, history: null })('honeypot:9'), null);
});

test('A4 真接线：POST syslog 告警起板走注入的 monitor/history，不查牧云事件详情', async t => {
  const caseDir = await caseDirectory(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-wired-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = { alert_id: 'honeypot:7', mode: 'triage', case_dir: caseDir,
    evidence: [{ evidence_id: 'syslog:1', tool: 'received_syslog' }] };
  const history = { latest: async (id, mode) => id === 'honeypot:7' && mode === 'triage' ? record : null };
  // 真 status(syslogId) 用 records.get(syslogId) 找回记录，记录上的 result_alert_id 指向研判记录。
  const monitor = { status: id => id === SYSLOG_ALERT ? { alert_id: id, result_alert_id: 'honeypot:7' } : null };
  const calls = [];
  const toolbox = { listTools: async () => [], investigation: () => ({ started: 0, maxCalls: 10,
    records: new Map(), async callTool(name) { calls.push(name); throw new Error('不该查'); },
    verifyClaims: () => ({ ok: true }) }) };
  const actions = [{ action: 'look' },
    { action: 'investigate', node: 'asset:172.20.208.23', why: '沿触发链往回' },
    { action: 'conclude', summary: '断在来源', gaps: [] }];
  const boardService = new TraceBoardService({ toolbox, directory,
    model: { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) },
    promptStore: { load: async () => ({ prompts: { trace: '追查' } }) }, store: new BoardStore(directory) });
  const server = createServer(null, null, null, history, null, monitor, null, {}, boardService);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: SYSLOG_ALERT }) });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.alert.host, '172.20.208.23');
  assert.equal(started.origin_evidence.evidence_id, 'syslog:1');
  assert.equal(started.origin_evidence.reused, true);
  await boardService.running.get(SYSLOG_ALERT);
  const board = await boardService.get(SYSLOG_ALERT);
  assert.equal(board.status, 'done');
  assert.deepEqual(calls, []);
});

test('POST 白板：服务层未分类异常回 502', async t => {
  const boardService = { startOrResume: async () => { throw new Error('牧云 MCP 调用失败'); } };
  const server = createServer(null, null, null, null, null, null, null, {}, boardService);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'honeypot:7' }) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: '牧云 MCP 调用失败', code: 'upstream_error' });
});

test('A4 真 status() 剥掉 input 后仍能从研判记录复用原始报文', async t => {
  const caseDir = await caseDirectory(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(directory);
  await history.save({ alert_id: 'honeypot:7', mode: 'triage', case_dir: caseDir,
    evidence: [{ evidence_id: 'syslog:1', tool: 'received_syslog' }] });
  const monitor = new TriageMonitor({ file: path.join(directory, 'queue.json'), service: {}, investigator: {}, history: {} });
  monitor.records.set(SYSLOG_ALERT, { alert_id: SYSLOG_ALERT, status: 'done', result_alert_id: 'honeypot:7',
    input: { raw: RAW_SYSLOG, parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-18T03:00:00Z',
      payload: { host_ip: '172.20.208.23', source_ip: '64.177.57.21' } } } });
  // 先钉死复现条件：真 status() 回的是瘦身记录，没有 input。
  assert.equal('input' in monitor.status(SYSLOG_ALERT), false);
  const alert = await createAnalysisProvider({ monitor, history })(SYSLOG_ALERT);
  assert.equal(alert.evidence_id, 'syslog:1');
  assert.equal(alert.facts.host_ip, '172.20.208.23');
  assert.equal(alert.facts.source_ip, '64.177.57.21');
});

// ── P003-T013 误报入口与两个维护者 ──────────────────────────────────────

function falsePositiveMonitor(records) {
  return {
    records: new Map(records.map(record => [record.alert_id, record])),
    persisted: 0,
    status(alertId) {
      const record = this.records.get(alertId);
      if (!record) return null;
      const { input, ...visible } = record;
      return { ...visible, steps: [...(record.steps || [])], evidence: record.evidence || [] };
    },
    async persist() { this.persisted += 1; }
  };
}

function falsePositiveCase(caseDir, overrides = {}) {
  return { alert_id: SYSLOG_ALERT, status: 'done', stage: '研判完成', verdict: 'threat', verdict_label: '真实威胁',
    decision_source: 'ai', case_dir: caseDir, steps: [], evidence: [], updated_at: '2026-11-18T03:00:00.000Z',
    input: { raw: RAW_SYSLOG, parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-18T03:00:00Z',
      payload: { host_ip: '172.20.208.23', source_ip: '64.177.57.21' } } }, ...overrides };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitFor(check, label, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const falsePositivePath = id => `/api/agent/triage/${encodeURIComponent(id)}/false-positive`;

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const reportFalsePositive = (base, body = { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' }) =>
  fetch(`${base}${falsePositivePath(SYSLOG_ALERT)}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('A1 误报入口先把结论落成误报再回 202，维护者没跑完也已经是误报', async t => {
  const caseDir = await caseDirectory(t);
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify({ trace: [{ kind: 'wiki', id: 'HP-10' }] }));
  const monitor = falsePositiveMonitor([falsePositiveCase(caseDir)]);
  const ruleGate = deferred();
  const wikiGate = deferred();
  let ruleCalls = 0;
  const ruleMaintainer = { maintain: async () => { ruleCalls += 1; await ruleGate.promise;
    return { id: 'honeypot_probe', file: 'honeypot_probe.rego', name: '蜜罐诱捕', action: 'update' }; } };
  const wikiAgent = {
    create: async () => ({ id: '11111111-1111-4111-8111-111111111111', status: 'collecting' }),
    reply: async () => { await wikiGate.promise;
      return { status: 'ready_for_review', proposal: { changes: [{ path: 'honeypot/HP-10.md', content: 'x', page_revision: 'r' }],
        evidence_preview: null } }; } };
  const wiki = { agentIndex: async () => ({ category: 'honeypot', pages: [{ id: 'HP-10', title: '蜜罐', path: 'honeypot/HP-10.md' }] }),
    publishBundle: async () => [{ path: 'honeypot/HP-10.md', revision: 'abc' }] };
  const server = createServer(null, null, null, null, null, monitor, null, undefined, null, null, wiki, wikiAgent, null, null, null, ruleMaintainer);
  const base = await listen(t, server);

  const response = await reportFalsePositive(base);
  assert.equal(response.status, 202);
  const body = await response.json();
  // 结论先落地：维护者两个都还卡在 gate 上，这一条已经是误报
  assert.equal(body.verdict.verdict, 'false_positive');
  assert.equal(body.verdict.verdict_label, '误报');
  assert.equal(body.verdict.source, 'human');
  assert.equal(body.feedback.reason, '运维的蜜罐探针，不是攻击');
  assert.equal(body.feedback.who, '值班分析员');
  assert.equal(body.maintenance.status, 'updating');
  assert.ok(monitor.persisted >= 1, '回 202 之前必须已经落盘');
  // GET 同一条案件读到同一个结论与进度
  const visible = await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(SYSLOG_ALERT)}`)).json();
  assert.equal(visible.verdict, 'false_positive');
  assert.equal(visible.verdict_label, '误报');
  assert.equal(visible.feedback.reason, '运维的蜜罐探针，不是攻击');
  assert.equal(visible.maintenance.status, 'updating');
  // 维护是后台起的：先钉住第一轮确实已开跑，再验重复登记不重起一轮（否则 ruleCalls 读到 0 只是调度时序）
  await waitFor(() => ruleCalls === 1, '第一轮维护已起');
  assert.equal((await reportFalsePositive(base)).status, 202);
  assert.equal(ruleCalls, 1);

  ruleGate.resolve();
  wikiGate.resolve();
  await waitFor(async () => (await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(SYSLOG_ALERT)}`)).json())
    .maintenance?.status === 'updated', '两个维护者收尾');
  const done = await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(SYSLOG_ALERT)}`)).json();
  assert.equal(done.verdict, 'false_positive');
  assert.equal(done.maintenance.rule.status, 'updated');
  assert.equal(done.maintenance.wiki.status, 'updated');
  assert.equal(done.maintenance.wiki.page, 'honeypot/HP-10.md');
  assert.equal(ruleCalls, 1);
});

test('A1 误报入口的入参校验：理由必填，案件要存在且已完成', async t => {
  const caseDir = await caseDirectory(t);
  const monitor = falsePositiveMonitor([
    falsePositiveCase(caseDir),
    falsePositiveCase(caseDir, { alert_id: 'honeypot:9', status: 'running', stage: '研判中' })
  ]);
  const server = createServer(null, null, null, null, null, monitor);
  const base = await listen(t, server);
  const send = async (alertId, body) => fetch(`${base}/api/agent/triage/${encodeURIComponent(alertId)}/false-positive`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await send(SYSLOG_ALERT, { who: '值班分析员' })).status, 400);
  assert.equal((await (await send(SYSLOG_ALERT, { reason: '太短了', who: '值班分析员' })).json()).error, '误报理由必须为 10 到 4000 字');
  assert.equal((await send(SYSLOG_ALERT, { reason: '运维的蜜罐探针，不是攻击', who: 'x' })).status, 400);
  assert.equal((await send(SYSLOG_ALERT.slice(0, -1) + '0', { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' })).status, 404);
  assert.equal((await send('bad-id', { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' })).status, 400);
  assert.equal((await (await send('honeypot:9', { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' })).json()).error,
    '研判还没结束，不能登记误报');
  assert.equal(monitor.records.get(SYSLOG_ALERT).verdict, 'threat');
  assert.equal(monitor.records.get(SYSLOG_ALERT).feedback, undefined);
});

const plainRego = (id, name, line) => `package hids.rules.${id}\n# name: ${name}\ndefault match := false\nmatch if {\n  ${line}\n}\n`;
const sshRego = plainRego('ssh_bruteforce', 'SSH 暴力破解', 'input.type == "brute_force"');
const honeypotRego = plainRego('honeypot_probe', '蜜罐诱捕', 'input.type == "honeypot"');
const tightenedRego = plainRego('honeypot_probe', '蜜罐诱捕', 'input.type == "honeypot"\n  not input.source_ip == "64.177.57.21"');
const addedRego = plainRego('ops_probe_allow', '运维探针', 'input.type == "honeypot"\n  input.source_ip == "64.177.57.21"');
const badRego = plainRego('honeypot_probe', '坏规则', 'input.host =~ "10\\..*"');

function ruleModel(proposal) {
  return { complete: async () => ({ content: JSON.stringify(proposal) }) };
}

test('A2 规则维护者只加一条或改一条 Rego，校验不过就不落盘', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rego-maintain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rules = path.join(directory, 'rules');
  await mkdir(rules, { recursive: true });
  await writeFile(path.join(rules, 'ssh_bruteforce.rego'), sshRego);
  await writeFile(path.join(rules, 'honeypot_probe.rego'), honeypotRego);
  const store = new RuleStore(rules);
  const prompts = { load: async () => ({ prompts: { rule: '维护 Rego 规则' } }) };
  const material = { caseId: 'c1', eventType: 'honeypot', reason: '运维的蜜罐探针，不是攻击', who: '值班分析员',
    alert: { msgid: 'cloudwalker-honeypot', payload: { source_ip: '64.177.57.21' } }, ruleIds: ['honeypot_probe'] };

  // 改一条：只重写它自己那份，别人的一字不动
  const update = await new RegoRuleMaintainer(ruleModel({ ready: true, id: 'honeypot_probe', name: '蜜罐诱捕',
    reason: '把运维探针的固定来源排除', rego: tightenedRego }), store, prompts).maintain(material);
  assert.deepEqual(update, { id: 'honeypot_probe', file: 'honeypot_probe.rego', name: '蜜罐诱捕',
    action: 'update', rationale: '把运维探针的固定来源排除' });
  assert.equal(await readFile(path.join(rules, 'honeypot_probe.rego'), 'utf8'), tightenedRego);
  assert.equal(await readFile(path.join(rules, 'ssh_bruteforce.rego'), 'utf8'), sshRego);
  assert.equal((await new RuleStore(rules).list()).count, 2);

  // 新增一条：目录里只多一个文件
  const add = await new RegoRuleMaintainer(ruleModel({ ready: true, id: 'ops_probe_allow', name: '运维探针',
    reason: '新增一条专门盖住运维探针', rego: addedRego }), store, prompts).maintain(material);
  assert.equal(add.action, 'add');
  assert.equal(add.file, 'ops_probe_allow.rego');
  assert.deepEqual((await readdir(rules)).sort(), ['honeypot_probe.rego', 'ops_probe_allow.rego', 'ssh_bruteforce.rego']);
  assert.equal((await new RuleStore(rules).read('ops_probe_allow')).rego, addedRego);

  // 子集外的语法：装载期就报错，原文件不动，也不留临时文件
  await assert.rejects(() => new RegoRuleMaintainer(ruleModel({ ready: true, id: 'honeypot_probe', name: '蜜罐诱捕',
    reason: '收紧', rego: badRego }), store, prompts).maintain(material), /honeypot_probe\.rego:\d+/);
  assert.equal(await readFile(path.join(rules, 'honeypot_probe.rego'), 'utf8'), tightenedRego);
  assert.deepEqual((await readdir(rules)).filter(name => name.startsWith('.')), []);
  // id 不合法 / 模型说证据不够：都不落盘
  await assert.rejects(() => new RegoRuleMaintainer(ruleModel({ ready: true, id: 'Bad-Id', name: 'x',
    reason: 'x', rego: addedRego }), store, prompts).maintain(material), /规则 id 不合法/);
  await assert.rejects(() => new RegoRuleMaintainer(ruleModel({ ready: false, reason: '缺授权记录，找当班主管确认' }),
    store, prompts).maintain(material), /缺授权记录/);
  assert.deepEqual((await readdir(rules)).sort(), ['honeypot_probe.rego', 'ops_probe_allow.rego', 'ssh_bruteforce.rego']);
});

test('A3 两个维护者都不是跑研判的那个 Agent，各自改自己的东西', async t => {
  const caseDir = await caseDirectory(t);
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify({ trace: [{ kind: 'wiki', id: 'HP-10' }],
    verdict: { rego: { rule_ids: ['honeypot_probe'] } } }));
  const monitor = falsePositiveMonitor([falsePositiveCase(caseDir)]);
  const investigator = { model: { model: 'fake-model' }, run: async () => { throw new Error('误报维护不该重新跑研判'); } };
  const ruleArgs = [];
  const ruleMaintainer = { maintain: async args => { ruleArgs.push(args);
    return { id: 'honeypot_probe', file: 'honeypot_probe.rego', name: '蜜罐诱捕', action: 'update' }; } };
  const feedbacks = [];
  const wikiAgent = {
    create: async (page, feedback) => { feedbacks.push({ page, feedback }); return { id: '22222222-2222-4222-8222-222222222222' }; },
    reply: async () => ({ status: 'ready_for_review', proposal: { changes: [{ path: 'honeypot/HP-10.md', content: 'x', page_revision: 'r' }],
      evidence_preview: null } }) };
  const published = [];
  const wiki = { agentIndex: async () => ({ category: 'honeypot', pages: [{ id: 'HP-10', title: '蜜罐', path: 'honeypot/HP-10.md' }] }),
    publishBundle: async (changes, evidence, audit) => { published.push({ changes, evidence, audit });
      return [{ path: 'honeypot/HP-10.md', revision: 'rev-2' }]; } };
  const server = createServer(null, null, investigator, null, null, monitor, null, undefined, null, null,
    wiki, wikiAgent, null, null, null, ruleMaintainer);
  const base = await listen(t, server);
  assert.equal((await reportFalsePositive(base)).status, 202);
  await waitFor(() => monitor.records.get(SYSLOG_ALERT).maintenance.status !== 'updating', '维护收尾');

  assert.equal(ruleMaintainer === investigator, false);
  assert.equal(wikiAgent === investigator, false);
  // 规则维护者拿到的是案件材料与命中的 Rego id，不是分析 Agent 的输出
  assert.equal(ruleArgs.length, 1);
  assert.equal(ruleArgs[0].alert.msgid, 'cloudwalker-honeypot');
  assert.deepEqual(ruleArgs[0].ruleIds, ['honeypot_probe']);
  assert.equal(ruleArgs[0].reason, '运维的蜜罐探针，不是攻击');
  // wiki 维护者拿的是同一条案件的真实反馈，预期结论误报，目标是分析时引用过的判据页
  assert.equal(feedbacks.length, 1);
  assert.equal(feedbacks[0].page, 'honeypot/HP-10.md');
  assert.equal(feedbacks[0].feedback.case_id, SYSLOG_ALERT);
  assert.equal(feedbacks[0].feedback.expected_verdict, 'false_positive');
  assert.equal(feedbacks[0].feedback.reason, '运维的蜜罐探针，不是攻击');
  // 方法论文档真的写进去了：走 publishBundle，审核人记登记人、说明记理由
  assert.equal(published.length, 1);
  assert.equal(published[0].audit.reviewer, '值班分析员');
  assert.equal(published[0].audit.note, '运维的蜜罐探针，不是攻击');
  assert.equal(monitor.records.get(SYSLOG_ALERT).maintenance.wiki.revision, 'rev-2');
});

test('A4 维护失败只改 maintenance，误报结论不变；一边成一败总态算失败', async t => {
  const caseDir = await caseDirectory(t);
  const monitor = falsePositiveMonitor([falsePositiveCase(caseDir)]);
  const ruleMaintainer = { maintain: async () => { throw new Error('模型接口 HTTP 500: 上游不可用'); } };
  const wikiAgent = {
    create: async () => ({ id: '33333333-3333-4333-8333-333333333333' }),
    reply: async () => ({ status: 'ready_for_review', proposal: { changes: [{ path: 'honeypot/HP-10.md', content: 'x', page_revision: 'r' }],
      evidence_preview: null } }) };
  const wiki = { agentIndex: async () => ({ category: 'honeypot', pages: [{ id: 'HP-10', title: '蜜罐', path: 'honeypot/HP-10.md' }] }),
    publishBundle: async () => [{ path: 'honeypot/HP-10.md', revision: 'rev-3' }] };
  const server = createServer(null, null, null, null, null, monitor, null, undefined, null, null,
    wiki, wikiAgent, null, null, null, ruleMaintainer);
  const base = await listen(t, server);

  assert.equal((await reportFalsePositive(base)).status, 202);
  await waitFor(() => monitor.records.get(SYSLOG_ALERT).maintenance.status !== 'updating', '维护收尾');
  const record = monitor.records.get(SYSLOG_ALERT);
  // 规则那边失败：误报结论一个字节都没动
  assert.equal(record.verdict, 'false_positive');
  assert.equal(record.verdict_label, '误报');
  assert.equal(record.feedback.reason, '运维的蜜罐探针，不是攻击');
  assert.equal(record.maintenance.status, 'failed');
  assert.equal(record.maintenance.rule.status, 'failed');
  assert.match(record.maintenance.rule.error, /上游不可用/);
  assert.equal(record.maintenance.wiki.status, 'updated');
  const visible = await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(SYSLOG_ALERT)}`)).json();
  assert.equal(visible.verdict, 'false_positive');
  assert.equal(visible.maintenance.status, 'failed');
  assert.equal(visible.maintenance.wiki.revision, 'rev-3');
});

test('A4 记录停在 updating 但本进程没有在跑的维护时，重新登记会重起一轮', async t => {
  const caseDir = await caseDirectory(t);
  const stale = falsePositiveCase(caseDir, { verdict: 'false_positive', verdict_label: '误报', decision_source: 'human',
    feedback: { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员', recorded_at: '2026-11-18T04:00:00.000Z' },
    maintenance: { status: 'updating', updated_at: '2026-11-18T04:00:00.000Z',
      rule: { status: 'updating' }, wiki: { status: 'updating' } } });
  const monitor = falsePositiveMonitor([stale]);
  let ruleCalls = 0;
  const ruleMaintainer = { maintain: async () => { ruleCalls += 1;
    return { id: 'honeypot_probe', file: 'honeypot_probe.rego', name: '蜜罐诱捕', action: 'update' }; } };
  const wikiAgent = { create: async () => { throw new Error('知识维护端不可用'); } };
  const server = createServer(null, null, null, null, null, monitor, null, undefined, null, null,
    null, wikiAgent, null, null, null, ruleMaintainer);
  const base = await listen(t, server);

  assert.equal((await reportFalsePositive(base)).status, 202);
  await waitFor(() => monitor.records.get(SYSLOG_ALERT).maintenance.status !== 'updating', '重起的维护收尾');
  assert.equal(ruleCalls, 1);
  assert.equal(monitor.records.get(SYSLOG_ALERT).maintenance.rule.status, 'updated');
  assert.equal(monitor.records.get(SYSLOG_ALERT).maintenance.wiki.status, 'failed');
  assert.equal(monitor.records.get(SYSLOG_ALERT).verdict, 'false_positive');
});
