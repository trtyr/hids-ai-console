import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { InvestigationStore } from './investigation-store.js';
import { PromptStore } from './prompt-store.js';

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

test('trace board API starts and restores an alert board', async t => {
  const board = { alert_id: 'honeypot:7', status: 'running', nodes: [], edges: [] };
  const calls = [];
  const boardService = { start: async (id, focus) => { calls.push({ id, focus }); return board; },
    get: async id => id === 'honeypot:7' ? board : null,
    list: async () => [{ id: 'honeypot:7', title: '蜜罐调查', status: 'running' }] };
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
    { boards: [{ id: 'honeypot:7', title: '蜜罐调查', status: 'running' }] });
  assert.deepEqual(await (await fetch(`${base}/api/trace/boards/honeypot%3A7`)).json(), board);
  assert.equal((await fetch(`${base}/api/trace/boards/honeypot%3A8`)).status, 404);
  assert.equal((await fetch(`${base}/api/trace/boards/bad-id`)).status, 400);
});
