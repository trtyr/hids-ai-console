import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TraceBoardService } from './trace-board.js';

test('concurrent board reads always see a complete saved snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new TraceBoardService({ directory });
  const board = { id: 'honeypot:7', status: 'done', activity: [], summary: 'A'.repeat(200000) };
  await service.save(board);
  let writes = 0;
  let reads = 0;
  const writer = (async () => {
    for (let index = 0; index < 20; index++) {
      board.summary = (index % 2 ? 'A' : 'B').repeat(200000);
      await service.save(board);
      writes++;
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  const reader = (async () => {
    while (writes < 20) {
      const snapshot = await service.get('honeypot:7');
      assert.equal(snapshot.summary.length, 200000);
      assert.match(snapshot.summary, /^(A+|B+)$/);
      reads++;
    }
  })();
  await Promise.all([writer, reader]);
  assert.ok(reads > 1);
});

test('incomplete model action is recorded and retried without ending the investigation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-model-json-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const responses = ['{"action":"look"',
    '{"action":"investigate","node":"ip:64.177.57.21","why":"核查来源地址"}',
    '{"action":"conclude","summary":"未发现其他资产","gaps":[]}'];
  const service = new TraceBoardService({ directory, toolbox: { listTools: async () => [],
    investigation: () => ({ started: 0, maxCalls: 10, records: new Map() }) },
    model: { model: 'fake', complete: async () => ({ content: responses.shift() }) },
    promptStore: { load: async () => ({ prompts: { trace: '按证据调查' } }) } });
  await service.start('64.177.57.21');
  await service.running.get('ip:64.177.57.21');
  const board = await service.get('64.177.57.21');
  assert.equal(board.status, 'done');
  assert.equal(board.investigations, 1);
  assert.ok(board.activity.some(item => item.kind === 'model_error' && item.detail.includes('JSON 不完整')));
});

test('AI investigation grows a persisted board and rejects unsupported links', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-board-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = new Map();
  const raw = {
    get_honeypot_event: { event: { id: 7, event_name: '蜜罐攻击', source_ip: '64.177.57.21',
      host_view: { host_ip: '172.20.208.23', host_name: 'veinmind-demo', host_id: 874 } } },
    list_host_assets: { total: 1, result: [{ id: 874, host_ip: '172.20.208.23',
      host_name: 'veinmind-demo', os_release_name: 'Ubuntu 20.04' }] },
    list_host_events: { total: 0, events: [] },
    list_global_events: { total: 1, events: [{ id: 7, host_view: { host_ip: '172.20.208.23' },
      event_name: '蜜罐攻击' }] }
  };
  const views = {
    get_honeypot_event: { facts: { host_ip: { value: '172.20.208.23', pointer: '/event/host_view/host_ip' },
      source_ip: { value: '64.177.57.21', pointer: '/event/source_ip' } } },
    list_host_assets: { kind: 'list', returned_count: 1, items: [{ facts: { host_ip: {
      value: '172.20.208.23', pointer: '/result/0/host_ip' } } }] },
    list_host_events: { kind: 'list', returned_count: 0, items: [] },
    list_global_events: { kind: 'list', returned_count: 1, items: [{ facts: { host_ip: {
      value: '172.20.208.23', pointer: '/events/0/host_view/host_ip' } } }] }
  };
  const toolbox = { listTools: async () => Object.keys(raw).map(name => ({ name })), investigation: () => ({
    started: 0, async callTool(name) {
      const evidenceId = `cw:${++this.started}`;
      const record = { evidenceId, tool: name, result: raw[name], view: views[name] };
      records.set(evidenceId, record); return record;
    },
    verifyClaims(claims) { const ok = claims.every(claim => claim.citations.every(citation => {
      const record = records.get(citation.evidence_id);
      if (!record) return false;
      const value = citation.pointer.split('/').slice(1).reduce((item, key) => item?.[key], record.result);
      return value === citation.value;
    })); return { ok }; }
  }) };
  const actions = [
    { action: 'look' },
    { action: 'investigate', node: 'asset:172.20.208.23', why: '先核查告警资产与同机事件' },
    { action: 'link', from: 'ip:64.177.57.21', to: 'asset:172.20.208.23', rel: '探测', why: '无效引用应拒绝',
      citations: [{ evidence_id: 'cw:99', pointer: '/source_ip', value: '64.177.57.21' }] },
    { action: 'link', from: 'ip:64.177.57.21', to: 'asset:172.20.208.23', rel: '探测', why: '原始事件记录了来源地址',
      citations: [{ evidence_id: 'cw:1', pointer: '/event/source_ip', value: '64.177.57.21' },
        { evidence_id: 'cw:1', pointer: '/event/host_view/host_ip', value: '172.20.208.23' }] },
    { action: 'conclude', summary: '有探测记录，未证实内网横向', gaps: ['缺少连接与进程证据'] }
  ];
  const model = { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) };
  const promptStore = { load: async () => ({ prompts: { trace: '按白板行动' } }) };
  const service = new TraceBoardService({ toolbox, model, promptStore, directory });
  const initial = await service.start('honeypot:7');
  assert.equal(initial.edges.length, 0);
  await service.running.get('honeypot:7');
  const board = await new TraceBoardService({ toolbox, model, promptStore, directory }).get('honeypot:7');
  assert.equal(board.status, 'done');
  assert.equal(board.investigations, 1);
  assert.equal(board.nodes.find(node => node.id === board.seed).profile.os, 'Ubuntu 20.04');
  assert.equal(board.edges.length, 1);
  assert.equal(board.edges[0].citations[0].evidence_id, 'cw:1');
  assert.match(board.summary, /未证实内网横向/);
});

test('IP start discovers touched hosts as program leads without claiming an AI path', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-ip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const event = { id: 9, event_type: 'honeypot', event_name: '蜜罐发现访问',
    source_ip: '64.177.57.21', host_view: { host_ip: '172.20.208.23', host_name: 'veinmind-demo' },
    last_seen_at: Math.floor(Date.now() / 1000) };
  const toolbox = { listTools: async () => ['list_global_events', 'list_honeypot_events'].map(name => ({ name })),
    investigation: () => ({ started: 0, maxCalls: 350, records: new Map(),
      async callTool(name) {
        const record = { evidenceId: `cw:${++this.started}`, tool: name,
          result: { total: 1, events: [event] } };
        this.records.set(record.evidenceId, record);
        return record;
      }, verifyClaims: () => ({ ok: true }) }) };
  const actions = [{ action: 'look' },
    { action: 'investigate', node: 'ip:64.177.57.21', why: '查这个来源碰过哪些主机' },
    { action: 'conclude', summary: '目前只有触达线索，尚无横向移动证据', gaps: [] }];
  const model = { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) };
  const service = new TraceBoardService({ toolbox, model,
    promptStore: { load: async () => ({ prompts: { trace: '追查目标' } }) }, directory });
  await service.start('64.177.57.21');
  await service.running.get('ip:64.177.57.21');
  const board = await service.get('64.177.57.21');
  assert.equal(board.status, 'done');
  assert.equal(board.alert_id, null);
  assert.ok(board.nodes.some(node => node.id === 'asset:172.20.208.23'));
  assert.deepEqual(board.nodes.find(node => node.id === board.seed).touched_hosts, ['172.20.208.23']);
  assert.equal(board.edges.length, 1);
  assert.equal(board.edges[0].by, 'program');
  assert.equal(board.edges[0].citations.length, 2);
  assert.deepEqual((await service.list()).map(item => item.id), ['ip:64.177.57.21']);
});

test('asset investigation gives newly discovered external IPs the same ids as evidence edges', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-asset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const event = { id: 12, event_type: 'honeypot', source_ip: '64.177.57.21',
    host_view: { host_ip: '172.20.208.23' }, created_at: Math.floor(Date.now() / 1000) };
  const original = { event: { id: 7, source_ip: '127.0.0.1', created_at: event.created_at,
    host_view: { host_ip: '172.20.208.23' } } };
  const toolbox = { listTools: async () => ['get_honeypot_event', 'list_global_events', 'list_honeypot_events'].map(name => ({ name })),
    investigation: () => ({ started: 0, maxCalls: 350, records: new Map(),
      async callTool(name) {
        const record = { evidenceId: `cw:${++this.started}`, tool: name,
          result: name === 'get_honeypot_event' ? original : { total: 1, events: [event] },
          view: name === 'get_honeypot_event' ? { facts: { host_ip: { value: '172.20.208.23',
            pointer: '/event/host_view/host_ip' } } } : null };
        this.records.set(record.evidenceId, record); return record;
      }, verifyClaims: () => ({ ok: true }) }) };
  const actions = [{ action: 'look' },
    { action: 'investigate', node: 'asset:172.20.208.23', why: '从资产追查来访地址' },
    { action: 'conclude', summary: '只发现触达线索', gaps: [] }];
  const model = { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) };
  const service = new TraceBoardService({ toolbox, model,
    promptStore: { load: async () => ({ prompts: { trace: '追查目标' } }) }, directory });
  await service.start('honeypot:7');
  await service.running.get('honeypot:7');
  const board = await service.get('honeypot:7');
  assert.ok(board.nodes.some(node => node.id === 'ip:64.177.57.21'));
  assert.ok(board.edges.some(edge => edge.by === 'program' && edge.from === 'ip:64.177.57.21' &&
    edge.to === 'asset:172.20.208.23'));
});
