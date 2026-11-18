import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PromptStore } from './prompt-store.js';
import { WikiStore } from './wiki-store.js';
import { createServer } from './server.js';

test('current scene prompts and agent indexes use reviewed criteria', async () => {
  const prompts = await new PromptStore(path.join(tmpdir(), `hids-no-overrides-${randomUUID()}.json`)).load();
  const wiki = new WikiStore();
  const expected = {
    webshell: 'WS-13', memory_webshell: 'MW-08', memory_security: 'RP-09', revshell: 'RS-09',
    suspicious_operation: 'SC-15', command_session: 'CA-08', malware: 'MA-09', brute_force: 'BF-10',
    honeypot: 'HP-10', elevation_process: 'LP-10', abnormal_login: 'AL-11', network_audit: 'NA-09'
  };
  for (const [eventType, criterion] of Object.entries(expected)) {
    assert.match(prompts.sop[eventType], new RegExp(`^id: ${criterion}$`, 'm'), eventType);
    const index = await wiki.agentIndex(eventType);
    assert.deepEqual(index.pages.map(page => page.id).sort(), ['GEN-12', criterion].sort(), eventType);
    const context = await wiki.agentContextPages(eventType);
    assert.deepEqual(context.map(page => page.id).sort(), ['GEN-12', criterion].sort(), eventType);
    assert.ok(context.every(page => page.content.length > 100), eventType);
    assert.match((await wiki.agentPage(eventType, criterion)).content, /结论/);
  }
  assert.match(prompts.sop.common, /行为、执行结果和授权范围/);
});

// ---- 知识库写接口（P003-T002）：控制台 Basic 账号 + expected_revision ----

const account = { user: 'operator', password: 'test-only-password' };
const basic = `${Buffer.from(`${account.user}:${account.password}`).toString('base64')}`;
const authorized = { authorization: `Basic ${basic}`, 'content-type': 'application/json' };
const pagePath = '/api/wiki/pages/honeypot%2FHP-01.md';
const criterion = body => `---\nid: HP-01\ntitle: 蜜罐背景扫描\nstatus: active\nsource: ENISA\n---\n\n${body}\n`;

async function wikiFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-wiki-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'wiki');
  await mkdir(path.join(directory, 'honeypot'), { recursive: true });
  await writeFile(path.join(directory, 'log.md'), '# 日志\n');
  await writeFile(path.join(directory, 'honeypot', 'HP-01.md'), criterion('外网背景扫描需要核对请求。'));
  return { root, directory, wiki: new WikiStore(directory) };
}

async function serve(t, wiki) {
  const server = createServer(null, null, null, null, null, null, null, account, null, 'test-admin-token', wiki);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('console Basic account saves a wiki page and gets the new revision back', async t => {
  const { directory, wiki } = await wikiFixture(t);
  const base = await serve(t, wiki);
  const before = await (await fetch(`${base}${pagePath}`, { headers: authorized })).json();
  assert.match(before.content, /需要核对/);

  const response = await fetch(`${base}${pagePath}`, { method: 'PUT', headers: authorized,
    body: JSON.stringify({ content: criterion('外网背景扫描必须核对请求。'), expected_revision: before.revision }) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.id, 'HP-01');
  assert.equal(saved.path, 'honeypot/HP-01.md');
  assert.notEqual(saved.revision, before.revision);
  assert.match(saved.content, /必须核对/);
  assert.match(await readFile(path.join(directory, 'honeypot', 'HP-01.md'), 'utf8'), /必须核对/);
  // 谁改的留在 log.md 里：身份就是控制台那个 Basic 账号，没有第二个身份来源（D003）
  assert.match(await readFile(path.join(directory, 'log.md'), 'utf8'), /操作人 operator/);

  const reread = await (await fetch(`${base}${pagePath}`, { headers: authorized })).json();
  assert.equal(reread.revision, saved.revision);
  // 维护端令牌留给会话族：Basic 账号读会话仍然 403，两套身份没有并成一套
  assert.equal((await fetch(`${base}/api/wiki/sessions`, { headers: authorized })).status, 403);
});

test('wiki write answers 401 without the console account, 409 on a stale revision, 400 on paths outside the wiki', async t => {
  const { directory, wiki } = await wikiFixture(t);
  const base = await serve(t, wiki);
  const before = await (await fetch(`${base}${pagePath}`, { headers: authorized })).json();
  const body = JSON.stringify({ content: criterion('外网背景扫描必须核对请求。'), expected_revision: before.revision });

  const anonymous = await fetch(`${base}${pagePath}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  assert.equal(anonymous.status, 401);
  // 只带管理员令牌也不行：写知识库认的是控制台账号，不是维护端令牌
  const tokenOnly = await fetch(`${base}${pagePath}`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-prompt-admin-token': 'test-admin-token' }, body });
  assert.equal(tokenOnly.status, 401);

  const stale = await fetch(`${base}${pagePath}`, { method: 'PUT', headers: authorized,
    body: JSON.stringify({ content: criterion('外网背景扫描必须核对请求。'), expected_revision: '0'.repeat(16) }) });
  assert.equal(stale.status, 409);
  assert.match(await readFile(path.join(directory, 'honeypot', 'HP-01.md'), 'utf8'), /需要核对/);

  const noRevision = await fetch(`${base}${pagePath}`, { method: 'PUT', headers: authorized,
    body: JSON.stringify({ content: criterion('外网背景扫描必须核对请求。') }) });
  assert.equal(noRevision.status, 400);

  for (const escape of ['..%2Fserver.js', 'honeypot%2F..%2F..%2Fserver.js', '%2Fetc%2Fpasswd'])
    assert.equal((await fetch(`${base}/api/wiki/pages/${escape}`, { method: 'PUT', headers: authorized, body })).status, 400, escape);

  const missing = await fetch(`${base}/api/wiki/pages/honeypot%2FHP-09.md`, { method: 'PUT', headers: authorized, body });
  assert.equal(missing.status, 404);
  assert.equal((await fetch(`${base}/api/wiki/pages/`, { method: 'PUT', headers: authorized, body })).status, 400);
  // 被拒绝的请求一条都没有改动页面
  const after = await (await fetch(`${base}${pagePath}`, { headers: authorized })).json();
  assert.equal(after.revision, before.revision);
});

test('a wiki write that fails halfway leaves no partial page and no temporary files', async t => {
  if (process.getuid?.() === 0) return t.skip('root 下无法用只读目录模拟写失败');
  const readOnly = [];
  // 先登记恢复权限的钩子，它要排在临时目录清理之前跑
  t.after(() => Promise.all(readOnly.map(folder => chmod(folder, 0o700).catch(() => {}))));
  const { directory, wiki } = await wikiFixture(t);
  const before = await wiki.get('honeypot/HP-01.md');
  const folder = path.join(directory, 'honeypot');
  readOnly.push(folder);
  await chmod(folder, 0o500);

  await assert.rejects(() => wiki.update(before.path, criterion('外网背景扫描必须核对请求。'), before.revision), { code: 'EACCES' });
  await chmod(folder, 0o700);
  assert.deepEqual(await readdir(folder), ['HP-01.md']);
  assert.equal((await wiki.get(before.path)).content, before.content);

  // 失败没有卡死串行写队列；成功的写入同样只留一份正式文件
  const next = await wiki.update(before.path, criterion('外网背景扫描必须核对请求。'), before.revision);
  assert.notEqual(next.revision, before.revision);
  assert.deepEqual(await readdir(folder), ['HP-01.md']);

  // 同一个版本被两次提交：串行写让它一次成功一次 409，不会互相覆盖
  const settled = await Promise.allSettled([
    wiki.update(next.path, criterion('外网背景扫描必须核对请求。A'), next.revision),
    wiki.update(next.path, criterion('外网背景扫描必须核对请求。B'), next.revision)]);
  assert.deepEqual(settled.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(settled.find(item => item.status === 'rejected').reason.status, 409);
});
