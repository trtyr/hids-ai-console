// P003-T068 A17：白板可重跑并保留历史版本。
// 版本存哪：同目录多文件 `<boards>/versions/<boardId>/<revision>.json`（当前板 `<boardId>.json` 格式不变）。
// 版本号怎么出：内容寻址 sha256 前 16 位，只看投影后的链结构（status/seed/alert/hops/links/gaps/discovery），
//   不看 updated_at/created_at/activity/每轮窗口起止/调查时间/证据编号——同链结构重跑不重复归档。
// diff 按什么比：hops（节点 id + 字段级 changes）/ links（归一化 from→to）/ edges（原始边）/ gaps，逐项 added/removed。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { TraceBoardService } from '../../../src/contexts/trace/application/trace-service.js';
import { BoardStore } from '../../../src/contexts/trace/infrastructure/board-store.js';
import { boardRevision, diffBoards } from '../../../src/contexts/trace/domain/board.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const CONCLUDE = JSON.stringify({ action: 'conclude', summary: '未发现其他资产', gaps: [] });

// 每轮先调查起点（conclude 要求至少查过一个节点），之后直接收尾。
function fakeService(directory, { target, model } = {}) {
  model ??= { model: 'fake', complete: async messages => ({ content: messages.length === 2
    ? JSON.stringify({ action: 'investigate', node: `ip:${target}`, why: '核查来源地址' })
    : CONCLUDE }) };
  return new TraceBoardService({ store: new BoardStore(directory), model,
    toolbox: { listTools: async () => [], investigation: () => ({ started: 0, maxCalls: 1, records: new Map(),
      async callTool() { return null; } }) },
    promptStore: { load: async () => ({ prompts: { trace: '按证据调查' } }) } });
}

async function serve(t, boardService) {
  const server = createServer(null, null, null, null, null, null, null, null, boardService);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitDone(base, target) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const board = await (await fetch(`${base}/api/trace/boards/${encodeURIComponent(target)}`)).json();
    if (board.status !== 'running') return board;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('白板调查没有在超时内结束');
}

test('A17 版本号内容寻址：易变字段不影响，链结构变化必变', () => {
  const board = { id: 'ip:10.0.0.1', status: 'done', seed: 'ip:10.0.0.1', alert: null, window: null, model: 'm',
    nodes: [{ id: 'ip:10.0.0.1', address: '10.0.0.1' }], edges: [], gaps: [], discovery: [],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    activity: [{ at: '2026-01-01T00:00:00.000Z', kind: 'seed' }] };
  const sameContent = { ...board, created_at: '2026-02-02T00:00:00.000Z', updated_at: '2026-02-02T00:00:00.000Z',
    activity: [{ at: '2026-02-02T00:00:00.000Z', kind: 'seed' }] };
  assert.equal(boardRevision(board), boardRevision(sameContent), '时间/活动变化不该产生新版本');
  const grown = { ...sameContent, nodes: [...sameContent.nodes, { id: 'asset:10.0.0.2', address: '10.0.0.2' }],
    edges: [{ from: 'ip:10.0.0.1', to: 'asset:10.0.0.2', rel: 'attacked' }] };
  assert.notEqual(boardRevision(board), boardRevision(grown), '链结构变化必须换版本号');
  const diff = diffBoards(board, grown);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.hops.added.map(hop => hop.id), ['asset:10.0.0.2']);
  assert.deepEqual(diff.edges.added, [{ from: 'ip:10.0.0.1', to: 'asset:10.0.0.2', rel: 'attacked' }]);
  assert.equal(diff.links.added.length, 1);
  assert.equal(diffBoards(board, sameContent).identical, true, '同样内容 diff 必须 identical');
});

test('A17 重跑：旧板归档、历史可列可取值、diff 逐项、重复内容去重', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t068-boards-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = '203.0.113.7';
  const service = fakeService(directory, { target });
  const base = await serve(t, service);
  const encoded = encodeURIComponent(target);

  // 首跑：202 新建，等它跑完
  const first = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
  assert.equal(first.status, 202);
  assert.equal((await waitDone(base, target)).status, 'done');
  assert.deepEqual((await (await fetch(`${base}/api/trace/boards/${encoded}/versions`)).json()).versions, [],
    '首跑还没有历史版本');

  // 重跑：旧板归档，当前板从头起
  const second = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, rerun: true }) });
  assert.equal(second.status, 202);
  assert.equal((await waitDone(base, target)).status, 'done');

  const listed = await (await fetch(`${base}/api/trace/boards/${encoded}/versions`)).json();
  assert.equal(listed.target, target);
  assert.equal(listed.versions.length, 1, '首跑应归档成一版');
  const [version] = listed.versions;
  assert.match(version.revision, /^[0-9a-f]{16}$/);
  assert.ok(version.saved_at);
  assert.equal(version.status, 'done');
  assert.equal(version.chain_length, 1);

  // 按版本号取任一版
  const saved = await (await fetch(`${base}/api/trace/boards/${encoded}/versions/${version.revision}`)).json();
  assert.equal(saved.revision, version.revision);
  assert.equal(saved.board.id, `ip:${target}`);
  assert.equal(saved.board.hops.length, 1);

  // 再重跑一次：第二轮内容与第一轮相同 → 同版本号去重，历史不涨
  const third = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, rerun: true }) });
  assert.equal(third.status, 202);
  await waitDone(base, target);
  const deduped = await (await fetch(`${base}/api/trace/boards/${encoded}/versions`)).json();
  assert.equal(deduped.versions.length, 1, '内容相同的重跑不该重复归档');
  assert.equal(deduped.versions[0].revision, version.revision);

  // diff：归档版对当前板，内容一致 → identical
  const identical = await (await fetch(`${base}/api/trace/boards/${encoded}/diff?from=${version.revision}`)).json();
  assert.equal(identical.identical, true);
  assert.equal(identical.to_current, true);
  assert.equal(identical.from, version.revision);

  // 手工归档一块改了节点标签的板，diff 必须报 hops.changed 与 identical=false
  const current = await service.read(`ip:${target}`);
  const variant = structuredClone(current);
  variant.nodes[0].label = '改动后的标签';
  const { revision: variantRevision } = await new BoardStore(directory).archive(variant);
  assert.notEqual(variantRevision, version.revision);
  const changed = await (await fetch(
    `${base}/api/trace/boards/${encoded}/diff?from=${variantRevision}&to=current`)).json();
  assert.equal(changed.identical, false);
  assert.equal(changed.hops.changed.length, 1);
  assert.deepEqual(changed.hops.changed[0].changes.label, { from: '改动后的标签', to: target });

  // 参数与不存在：缺 from 400、坏 to 400、未知版本 404、坏 rerun 400
  assert.equal((await fetch(`${base}/api/trace/boards/${encoded}/diff`)).status, 400);
  assert.equal((await fetch(`${base}/api/trace/boards/${encoded}/diff?from=${version.revision}&to=nope`)).status, 400);
  assert.equal((await fetch(`${base}/api/trace/boards/${encoded}/versions/${'0'.repeat(16)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, rerun: 'yes' }) })).status, 400);
});

test('A17 调查进行中拒绝重跑（409），不带 rerun 仍按幂等返回已有板', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t068-running-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // 模型永不返回：白板会一直停在 running。
  const target = '203.0.113.8';
  const service = fakeService(directory, { target,
    model: { model: 'fake', complete: () => new Promise(() => {}) } });
  const base = await serve(t, service);

  const started = await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
  assert.equal(started.status, 202);
  // 不带 rerun：幂等返回 200，不重跑
  assert.equal((await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) })).status, 200);
  // 带 rerun：进行中 → 409
  assert.equal((await fetch(`${base}/api/trace/boards`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, rerun: true }) })).status, 409);
});
