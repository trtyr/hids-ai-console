import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { InvestigationStore } from './investigation-store.js';
import { PromptStore } from './prompt-store.js';
import { TriageMonitor } from './triage-monitor.js';

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
