import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const SYSLOG_ALERT = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';

test('A1 已有溯源直接返回那条，不再查一遍告警详情', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'honeypot:7.json'), JSON.stringify({ id: 'honeypot:7',
    alert_id: 'honeypot:7', title: '上次那板', status: 'done', nodes: [], edges: [], gaps: [],
    alert: { id: 'honeypot:7', type: 'honeypot', title: '蜜罐', host: '172.20.208.23',
      occurred_at: '2026-11-18T03:00:00.000Z' },
    created_at: '2026-11-18T03:00:00.000Z', updated_at: '2026-11-18T04:00:00.000Z' }));
  const service = new TraceBoardService({ directory, toolbox: { investigation: () => { throw new Error('不该查牧云'); } },
    model: { model: 'fake' } });
  const resumed = await service.startOrResume('honeypot:7');
  assert.equal(resumed.created, false);
  assert.equal(resumed.board.title, '上次那板');
  assert.equal((await service.start('honeypot:7')).id, 'honeypot:7');
});

test('A1 没有溯源时从告警新建，created 为真并标出告警起点', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-create-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const toolbox = { listTools: async () => [], investigation: () => ({ started: 0, maxCalls: 10,
    records: new Map(), async callTool(name) {
      return { evidenceId: 'cw:1', tool: name, result: { event: { id: 7, event_name: '蜜罐攻击',
        source_ip: '64.177.57.21', host_view: { host_ip: '172.20.208.23', host_name: 'demo' } } },
      view: { facts: { host_ip: { value: '172.20.208.23', pointer: '/event/host_view/host_ip' } } } };
    }, verifyClaims: () => ({ ok: true }) }) };
  const actions = [{ action: 'look' },
    { action: 'investigate', node: 'asset:172.20.208.23', why: '先核查告警资产' },
    { action: 'conclude', summary: '只标了起点', gaps: [] }];
  const service = new TraceBoardService({ directory, toolbox,
    model: { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) },
    promptStore: { load: async () => ({ prompts: { trace: '追查' } }) } });
  const started = await service.startOrResume('honeypot:7');
  assert.equal(started.created, true);
  assert.equal(started.board.alert.type, 'honeypot');
  assert.equal(started.board.alert.host, '172.20.208.23');
  await service.running.get('honeypot:7');
  const board = await service.get('honeypot:7');
  assert.equal(board.status, 'done');
  assert.equal(board.hops[0].kind, 'alert');
});

test('A2 列表给出类型/主机/告警时间/状态/链长/断点/更新时间，能筛能分页', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-list-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rows = [
    ['webshell:1', 'done', 'webshell', '10.0.0.1', '2026-11-18T01:00:00.000Z', 2, [], '2026-11-18T04:00:00.000Z'],
    ['honeypot:2', 'running', 'honeypot', '10.0.0.2', '2026-11-18T02:00:00.000Z', 3,
      [{ hop_id: null, reason: '还没追完' }], '2026-11-18T05:00:00.000Z'],
    ['webshell:3', 'failed', 'webshell', '10.0.0.3', '2026-11-18T03:00:00.000Z', 1, [], '2026-11-18T06:00:00.000Z']
  ];
  for (const [id, status, type, host, occurredAt, hops, gaps, updated] of rows)
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, alert_id: id, title: id, status,
      nodes: Array.from({ length: hops }, (_item, index) => ({ id: `hop:${index}` })), edges: [], gaps,
      alert: { id, type, title: id, host, occurred_at: occurredAt },
      created_at: occurredAt, updated_at: updated }));
  const service = new TraceBoardService({ directory });

  const all = await service.page();
  assert.equal(all.total, 3);
  assert.deepEqual(all.boards.map(board => board.id), ['webshell:3', 'honeypot:2', 'webshell:1']);
  assert.deepEqual(all.boards[0], { id: 'webshell:3', alert_id: 'webshell:3', title: 'webshell:3',
    type: 'webshell', host: '10.0.0.3', occurred_at: '2026-11-18T03:00:00.000Z', status: 'failed',
    chain_length: 1, has_gaps: false, created_at: '2026-11-18T03:00:00.000Z',
    updated_at: '2026-11-18T06:00:00.000Z' });

  const running = await service.page({ statuses: ['running'] });
  assert.deepEqual(running.boards.map(board => board.id), ['honeypot:2']);
  assert.equal(running.boards[0].chain_length, 3);
  assert.equal(running.boards[0].has_gaps, true);
  assert.deepEqual((await service.page({ type: 'webshell' })).boards.map(board => board.id), ['webshell:3', 'webshell:1']);
  assert.deepEqual((await service.page({ host: '10.0.0.2' })).boards.map(board => board.id), ['honeypot:2']);
  assert.deepEqual((await service.page({ from: Date.parse('2026-11-18T02:30:00Z') })).boards.map(board => board.id), ['webshell:3']);
  assert.deepEqual((await service.page({ from: Date.parse('2026-11-18T01:00:00Z'),
    to: Date.parse('2026-11-18T02:00:00Z') })).boards.map(board => board.id), ['honeypot:2', 'webshell:1']);
  assert.deepEqual(await service.page({ statuses: ['done'], from: Date.parse('2026-11-19T00:00:00Z') }),
    { boards: [], total: 0 });
  const second = await service.page({ count: 1, offset: 1 });
  assert.equal(second.total, 3);
  assert.deepEqual(second.boards.map(board => board.id), ['honeypot:2']);
});

test('A3 详情是 hops/links/gaps/discovery，线从更晚指向更早', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-detail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'honeypot:7.json'), JSON.stringify({ id: 'honeypot:7',
    alert_id: 'honeypot:7', seed: 'asset:172.20.208.23', status: 'done', title: '蜜罐诱捕',
    alert: { id: 'honeypot:7', type: 'honeypot', title: '蜜罐诱捕', host: '172.20.208.23',
      occurred_at: '2026-11-18T03:00:00.000Z' },
    nodes: [
      { id: 'asset:172.20.208.23', label: 'demo', address: '172.20.208.23', kind: 'asset',
        occurred_at: '2026-11-18T03:00:00.000Z',
        discovered_from: [{ evidence_id: 'cw:1', pointer: '/event/host_view/host_ip' }] },
      { id: 'ip:64.177.57.21', label: '64.177.57.21', address: '64.177.57.21', kind: 'external_ip',
        occurred_at: '2026-11-18T02:00:00.000Z',
        discovered_from: [{ evidence_id: 'cw:2', pointer: '/events/0/source_ip' }] }
    ],
    edges: [{ from: 'ip:64.177.57.21', to: 'asset:172.20.208.23', rel: '触达线索', by: 'program',
      citations: [{ evidence_id: 'cw:2', pointer: '/events/0/source_ip', value: '64.177.57.21' }] }],
    gaps: [{ hop_id: 'ip:64.177.57.21', reason: 'HIDS 上没有更早的记录' }],
    activity: [], created_at: '2026-11-18T03:00:00.000Z', updated_at: '2026-11-18T04:00:00.000Z' }));
  const detail = await new TraceBoardService({ directory }).get('honeypot:7');

  assert.equal(detail.chain_length, 2);
  assert.equal(detail.has_gaps, true);
  assert.equal(detail.hops.length, 2);
  assert.deepEqual(detail.hops[0], { id: 'asset:172.20.208.23', kind: 'alert', label: 'demo',
    host: '172.20.208.23', occurred_at: '2026-11-18T03:00:00.000Z', evidence_id: 'cw:1', discovered: 1 });
  assert.equal(detail.hops[1].kind, 'host');
  assert.equal(detail.hops[1].evidence_id, 'cw:2');
  // 告警那边更晚（03:00），线从它指向更早的来源（02:00）。
  assert.deepEqual(detail.links, [{ id: 'link:0', from: 'asset:172.20.208.23', to: 'ip:64.177.57.21',
    rel: '触达线索', evidence_id: 'cw:2' }]);
  assert.deepEqual(detail.gaps, [{ hop_id: 'ip:64.177.57.21', reason: 'HIDS 上没有更早的记录' }]);
  assert.deepEqual(detail.discovery.map(item => item.kind), ['hop', 'hop', 'link']);
  assert.equal(detail.alert.host, '172.20.208.23');
});

test('A3 两端时间相同时按离告警的远近定方向：从告警一侧指向原因一侧', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-tie-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'honeypot:8.json'), JSON.stringify({ id: 'honeypot:8',
    alert_id: 'honeypot:8', seed: 'asset:172.20.208.23', status: 'done',
    nodes: [
      { id: 'asset:172.20.208.23', address: '172.20.208.23', kind: 'asset', occurred_at: '2026-11-18T03:00:00.000Z' },
      { id: 'ip:64.177.57.21', address: '64.177.57.21', kind: 'external_ip', occurred_at: '2026-11-18T03:00:00.000Z' }
    ],
    edges: [{ from: 'ip:64.177.57.21', to: 'asset:172.20.208.23', rel: '触达' }],
    gaps: [], activity: [], created_at: '2026-11-18T03:00:00.000Z', updated_at: '2026-11-18T04:00:00.000Z' }));
  const detail = await new TraceBoardService({ directory }).get('honeypot:8');
  assert.equal(detail.links[0].from, 'asset:172.20.208.23');
  assert.equal(detail.links[0].to, 'ip:64.177.57.21');
});

test('A4 告警分析已取到的证据直接引用，不为同一份再查一遍', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const toolbox = { listTools: async () => [], investigation: () => ({ started: 0, maxCalls: 10,
    records: new Map(), async callTool(name) { calls.push(name); throw new Error('不该重查'); },
    verifyClaims: () => ({ ok: true }) }) };
  const actions = [{ action: 'look' },
    { action: 'investigate', node: 'asset:172.20.208.23', why: '沿触发链往回' },
    { action: 'conclude', summary: '断在来源一侧',
      gaps: [{ hop_id: 'ip:64.177.57.21', reason: 'HIDS 上没有更早的记录' }] }];
  const service = new TraceBoardService({ directory, toolbox,
    model: { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) },
    promptStore: { load: async () => ({ prompts: { trace: '追查' } }) },
    analysis: async alertId => alertId === SYSLOG_ALERT ? { evidence_id: 'syslog:1', tool: 'received_syslog',
      type: 'honeypot', facts: { host_ip: '172.20.208.23', host_name: 'demo', source_ip: '64.177.57.21',
        occurred_at: '2026-11-18T03:00:00.000Z', title: '蜜罐诱捕' } } : null });
  const started = await service.startOrResume(SYSLOG_ALERT);
  assert.equal(started.created, true);
  assert.deepEqual(calls, []);
  await service.running.get(SYSLOG_ALERT);
  const board = await service.get(SYSLOG_ALERT);
  assert.equal(board.status, 'done');
  assert.equal(board.origin_evidence.evidence_id, 'syslog:1');
  assert.equal(board.origin_evidence.reused, true);
  assert.equal(board.alert.type, 'honeypot');
  assert.equal(board.alert.host, '172.20.208.23');
  assert.equal(board.hops[0].evidence_id, 'syslog:1');
  assert.deepEqual(board.gaps, [{ hop_id: 'ip:64.177.57.21', reason: 'HIDS 上没有更早的记录' }]);
});

test('A4 syslog 告警没有分析证据时明确拒绝，不猜', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-noreuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new TraceBoardService({ directory, model: { model: 'fake' },
    toolbox: { investigation: () => ({ started: 0, maxCalls: 10, records: new Map() }) } });
  await assert.rejects(service.start(SYSLOG_ALERT),
    error => error.status === 422 && /分析记录/.test(error.message));
});
