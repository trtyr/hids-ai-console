// 分页与会话身份（P003-T006）：GET /api/trace/boards、GET /api/wiki/pages、GET /api/session。
// 全部走 createServer 的注入点，不碰真实牧云 / 文件系统之外的外部服务；白板那组用临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TraceBoardService } from './trace-board.js';
import { createServer } from './server.js';

const basic = credentials => `Basic ${Buffer.from(credentials).toString('base64')}`;

async function serve(t, options = {}) {
  const server = createServer(null, null, null, null, null, null, null, options.access,
    options.boardService ?? null, null, options.wiki ?? null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// ---------- TraceBoardService.page ----------

test('白板 page 回本页摘要与切页前总数，按更新时间倒序', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-page-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [id, updated] of [['revshell:1', '2026-11-18T01:00:00.000Z'], ['revshell:2', '2026-11-18T03:00:00.000Z'],
    ['ip:10.0.0.1', '2026-11-18T02:00:00.000Z']])
    await writeFile(path.join(directory, `${id}.json`),
      JSON.stringify({ id, title: id, status: 'done', created_at: updated, updated_at: updated }));
  const service = new TraceBoardService({ toolbox: {}, model: {}, directory });

  const second = await service.page({ count: 1, offset: 1 });
  assert.equal(second.total, 3);
  assert.deepEqual(second.boards.map(board => board.id), ['ip:10.0.0.1']);
  const tail = await service.page({ count: 50, offset: 2 });
  assert.deepEqual(tail.boards.map(board => board.id), ['revshell:1']);
  assert.equal(tail.total, 3);
  const past = await service.page({ count: 20, offset: 9 });
  assert.deepEqual(past.boards, []);
  assert.equal(past.total, 3);
  // list 保持数组形状：trace-board.test.js 与其它直接调用方在用的旧契约。
  assert.deepEqual((await service.list()).map(board => board.id), ['revshell:2', 'ip:10.0.0.1', 'revshell:1']);
});

test('白板 page 在没有目录、坏文件时不抛，只数有效白板', async t => {
  const missing = new TraceBoardService({ toolbox: {}, model: {}, directory: path.join(tmpdir(), `trace-page-missing-${process.pid}`) });
  assert.deepEqual(await missing.page(), { boards: [], total: 0 });

  const directory = await mkdtemp(path.join(tmpdir(), 'trace-page-bad-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'broken.json'), '{ 不是 JSON');
  await writeFile(path.join(directory, 'nameless.json'), JSON.stringify({ title: '没有 id' }));
  await writeFile(path.join(directory, 'revshell:7.json'), JSON.stringify({ id: 'revshell:7', updated_at: '2026-11-18T00:00:00.000Z' }));
  const service = new TraceBoardService({ toolbox: {}, model: {}, directory });
  const page = await service.page({ count: 20, offset: 0 });
  assert.equal(page.total, 1);
  assert.deepEqual(page.boards.map(board => board.id), ['revshell:7']);
});

// ---------- GET /api/trace/boards ----------

test('HTTP 白板列表把 count / offset 交给服务层并回 total', async t => {
  const seen = [];
  const boardService = { page: async options => { seen.push(options); return { boards: [{ id: 'revshell:1' }], total: 7 }; } };
  const base = await serve(t, { access: {}, boardService });

  const paged = await (await fetch(`${base}/api/trace/boards?count=5&offset=10`)).json();
  assert.deepEqual(paged, { boards: [{ id: 'revshell:1' }], total: 7 });
  assert.deepEqual(seen[0], { count: 5, offset: 10 });
  await fetch(`${base}/api/trace/boards`);
  assert.deepEqual(seen[1], { count: 20, offset: 0 });
});

test('HTTP 白板列表分页参数不合法回 400，且不调服务层', async t => {
  let calls = 0;
  const boardService = { page: async () => { calls++; return { boards: [], total: 0 }; } };
  const base = await serve(t, { access: {}, boardService });
  for (const query of ['count=0', 'count=51', 'count=abc', 'count=20.5', 'offset=-1', 'offset=1.5']) {
    const response = await fetch(`${base}/api/trace/boards?${query}`);
    assert.equal(response.status, 400, `${query} 应回 400`);
    assert.deepEqual(await response.json(), { error: '分页参数无效' });
  }
  assert.equal(calls, 0);
});

test('HTTP 白板列表没配白板服务时 503 先于分页校验', async t => {
  const base = await serve(t, { access: {} });
  const response = await fetch(`${base}/api/trace/boards?count=0`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未配置/);
});

// ---------- GET /api/wiki/pages ----------

const wikiPages = count => Array.from({ length: count }, (_, index) => ({
  id: `GEN-${index + 1}`, title: `判据 ${index + 1}`, path: `common/GEN-${index + 1}.md`, status: 'active' }));

test('HTTP 知识库列表不带 count 时照旧回全部，并给出 total', async t => {
  const base = await serve(t, { access: {}, wiki: { browse: async () => wikiPages(4) } });
  const body = await (await fetch(`${base}/api/wiki/pages`)).json();
  assert.equal(body.pages.length, 4);
  assert.equal(body.total, 4);
  assert.deepEqual(body.pages.map(page => page.id), ['GEN-1', 'GEN-2', 'GEN-3', 'GEN-4']);
});

test('HTTP 知识库列表按 count / offset 切页，total 是切页前条数', async t => {
  const base = await serve(t, { access: {}, wiki: { browse: async () => wikiPages(4) } });
  const paged = await (await fetch(`${base}/api/wiki/pages?count=2&offset=1`)).json();
  assert.deepEqual(paged.pages.map(page => page.id), ['GEN-2', 'GEN-3']);
  assert.equal(paged.total, 4);
  const tail = await (await fetch(`${base}/api/wiki/pages?offset=3`)).json();
  assert.deepEqual(tail.pages.map(page => page.id), ['GEN-4']);
  assert.equal(tail.total, 4);
  const past = await (await fetch(`${base}/api/wiki/pages?count=10&offset=9`)).json();
  assert.deepEqual(past.pages, []);
  assert.equal(past.total, 4);
});

test('HTTP 知识库列表 q 先过滤（保留 50 条上限）再切页，total 是过滤后条数', async t => {
  const base = await serve(t, { access: {}, wiki: { browse: async () => wikiPages(60) } });
  const paged = await (await fetch(`${base}/api/wiki/pages?q=gen&count=10&offset=5`)).json();
  assert.equal(paged.total, 50);
  assert.equal(paged.pages.length, 10);
  assert.deepEqual(paged.pages.map(page => page.id), ['GEN-6', 'GEN-7', 'GEN-8', 'GEN-9', 'GEN-10',
    'GEN-11', 'GEN-12', 'GEN-13', 'GEN-14', 'GEN-15']);
  const none = await (await fetch(`${base}/api/wiki/pages?q=不存在的页`)).json();
  assert.deepEqual(none, { pages: [], total: 0 });
});

test('HTTP 知识库列表分页参数不合法回 400', async t => {
  const base = await serve(t, { access: {}, wiki: { browse: async () => wikiPages(4) } });
  for (const query of ['count=0', 'count=51', 'count=abc', 'count=2.5', 'offset=-1', 'offset=abc']) {
    const response = await fetch(`${base}/api/wiki/pages?${query}`);
    assert.equal(response.status, 400, `${query} 应回 400`);
    assert.deepEqual(await response.json(), { error: '分页参数无效' });
  }
});

// ---------- GET /api/session ----------

test('配置了 Basic 账号时 /api/session 回 user 与 operator 角色', async t => {
  const base = await serve(t, { access: { user: 'ops', password: 'pw' } });
  const authorized = await fetch(`${base}/api/session`, { headers: { Authorization: basic('ops:pw') } });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { authenticated: true, user: 'ops', role: 'operator' });
  const wrong = await fetch(`${base}/api/session`, { headers: { Authorization: basic('ops:nope') } });
  assert.equal(wrong.status, 401);
});

test('配了密码没配账号名时 /api/session 与鉴权口径一致，落回 admin', async t => {
  const base = await serve(t, { access: { password: 'pw' } });
  const response = await fetch(`${base}/api/session`, { headers: { Authorization: basic('admin:pw') } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, user: 'admin', role: 'operator' });
});

test('未配置 Basic 密码时 /api/session 回 authenticated 但 user / role 为 null', async t => {
  const base = await serve(t, { access: {} });
  const response = await fetch(`${base}/api/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, user: null, role: null });
});
