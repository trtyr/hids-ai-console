import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P003-T041 测试席黑盒验收（A1–A8）：只走 HTTP（createServer() 零参真实装配）+ 数据根文件探针。
// 不 import 被测实现符号、不读实现文件；判据全部抄自 openapi.yaml 与 docs/。
const dirname = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(dirname, '../../..');
const bootScript = path.join(dirname, 'tester-boot-server.mjs');
const RULE_TOKEN = 'test-rule-token';
const PROMPT_TOKEN = 'test-prompt-token';

const sha = text => createHash('sha256').update(text).digest('hex');
const ruleRevision = text => sha(text).slice(0, 16);
const hex16 = /^[0-9a-f]{16}$/;

function rego(id, body, name = `规则 ${id}`, description = '测试用规则') {
  return `package hids.rules.${id}\n\n# name: ${name}\n# description: ${description}\n\ndefault match := false\n\nmatch if {\n${body}\n}\n`;
}

async function dataRoot(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t041-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// 仓内副本指纹：文件名 + 内容 sha256。只比名字抓不到原地改写，所以连内容一起钉。
async function digest(directory) {
  const rows = [];
  let names = [];
  try { names = (await readdir(directory, { recursive: true })).sort(); } catch { return rows; }
  for (const name of names) {
    const full = path.join(directory, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    rows.push(`${name}:${sha(await readFile(full))}`);
  }
  return rows;
}

// 起一个真进程：独立数据根、独立模块级装配。返回基地址。
async function boot(t, { dataRoot: root, ruleToken = RULE_TOKEN } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, HIDS_DATA_DIR: root,
    HIDS_PROMPT_ADMIN_TOKEN: PROMPT_TOKEN };
  if (ruleToken !== null) env.HIDS_RULE_ADMIN_TOKEN = ruleToken;
  const child = spawn(process.execPath, [bootScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`服务 15s 内没起来：${stderr}`)), 15000);
    child.stdout.on('data', chunk => {
      out += chunk;
      const line = out.split('\n').find(row => row.includes('"port"'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line).port);
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`服务提前退出（${code}）：${stderr}`)); });
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  });
  return `http://127.0.0.1:${port}`;
}

async function call(base, pathname, init) {
  const response = await fetch(base + pathname, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 纯文本响应（401 那种） */ }
  return { status: response.status, contentType: response.headers.get('content-type'), text, body: json };
}

const headers = (token, extra = {}) => {
  const value = { 'content-type': 'application/json', ...extra };
  if (token) value['x-rule-admin-token'] = token;
  return value;
};
const putRule = (base, id, payload, token = RULE_TOKEN) =>
  call(base, `/api/rules/${id}`, { method: 'PUT', headers: headers(token), body: JSON.stringify(payload) });
const rollback = (base, id, payload, token = RULE_TOKEN) =>
  call(base, `/api/rules/${id}/rollback`, { method: 'POST', headers: headers(token), body: JSON.stringify(payload) });
const history = (base, id) => call(base, `/api/rules/${id}/history`);

function assertError(res, expectedStatus, expectedCode = 'caller_error') {
  assert.equal(res.status, expectedStatus,
    `期望 ${expectedStatus}，实测 ${res.status}：${res.text.slice(0, 300)}`);
  assert.equal(typeof res.body, 'object', `错误正文不是 JSON 对象：${res.text.slice(0, 200)}`);
  assert.equal(res.body.code, expectedCode, `code 期望 ${expectedCode}，实测 ${res.body.code}`);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0, '错误正文的 error 是空串');
}

// ── A1 / A2：库落数据根，仓库只做种子 ──────────────────────────────────────
test('A1 库落数据根：rules/ 与 wiki/ 缺省在 HIDS_DATA_DIR 下；仓内副本运行期一个字节不被写', async t => {
  const repoRulesBefore = await digest(path.join(repository, 'rules'));
  const repoWikiBefore = await digest(path.join(repository, 'wiki'));
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });

  const listed = await call(base, '/api/rules');
  assert.equal(listed.status, 200);
  const ids = listed.body.rules.map(row => row.id);
  assert.deepEqual(ids, ['honeypot_probe', 'ssh_bruteforce', 'webshell_drop'], '列表不是按 id 排序的三条种子规则');
  assert.equal(listed.body.count, ids.length);
  for (const row of listed.body.rules) {
    assert.match(row.id, /^[a-z][a-z0-9_]*$/);
    assert.equal(typeof row.name, 'string');
    assert.ok(row.name.length > 0, `${row.id} 的 name 为空（openapi 要求 name 必填）`);
    assert.ok(row.description === null || typeof row.description === 'string');
    assert.ok(row.file.endsWith('.rego'));
    assert.equal('revision' in row, false, '列表接口按契约只给元数据，不该带 revision');
  }

  // 种子落点：数据根 rules/ 里的三份与仓内逐字节一致
  const seeded = (await readdir(path.join(root, 'rules'))).sort();
  assert.deepEqual(seeded, ['honeypot_probe.rego', 'ssh_bruteforce.rego', 'webshell_drop.rego']);
  for (const name of seeded) {
    assert.equal(await readFile(path.join(root, 'rules', name), 'utf8'),
      await readFile(path.join(repository, 'rules', name), 'utf8'), `${name} 的种子副本与仓内不一致`);
  }

  // 判据库同理：页面来自数据根，仓内 wiki/ 一字不动
  const pages = await call(base, '/api/wiki/pages');
  assert.equal(pages.status, 200);
  assert.ok(pages.body.pages.length > 0, '数据根判据库没种子');
  assert.equal(pages.body.total, pages.body.pages.length, '不带 count 时 total 应等于返回条数');
  const firstPage = pages.body.pages[0];
  for (const key of ['path', 'id', 'title', 'status', 'updated', 'revision', 'characters']) {
    assert.ok(key in firstPage, `页面摘要缺 ${key}（WikiPageSummary required）`);
  }
  assert.match(firstPage.revision, hex16);
  assert.ok((await readdir(path.join(root, 'wiki'))).length > 0, '判据库没落进数据根');

  assert.deepEqual(await digest(path.join(repository, 'rules')), repoRulesBefore, '仓内 rules/ 被运行期写了');
  assert.deepEqual(await digest(path.join(repository, 'wiki')), repoWikiBefore, '仓内 wiki/ 被运行期写了');
});

test('A2 种子只初始化一次：二次启动读数据根的改动，不按仓库副本盖回', async t => {
  const repoRulesBefore = await digest(path.join(repository, 'rules'));
  const root = await dataRoot(t);
  const first = await boot(t, { dataRoot: root });
  const before = await call(first, '/api/rules/honeypot_probe');
  assert.equal(before.status, 200);
  const tightened = rego('honeypot_probe', '  input.type == "honeypot"\n  input.peer != ""\n  input.user == "root"\n  not contains(input.command, "healthcheck")', '蜜罐探测（排除健康检查）');
  const saved = await putRule(first, 'honeypot_probe', { rego: tightened, expected_revision: before.body.revision, note: '排除健康检查' });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));

  const second = await boot(t, { dataRoot: root });
  const reopened = await call(second, '/api/rules/honeypot_probe');
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.rego, tightened, '二次启动把仓库副本盖回数据根了（种子不该重种）');
  assert.equal(reopened.body.revision, ruleRevision(tightened));
  assert.equal((await call(second, '/api/rules')).body.count, 3);
  const older = await history(second, 'honeypot_probe');
  assert.equal(older.status, 200);
  assert.equal(older.body.history.length, 1, '二次启动后历史副本丢了');
  assert.deepEqual(await digest(path.join(repository, 'rules')), repoRulesBefore);
});

test('A2 目录在但不种：数据根 rules/ 存在（空）时就是空库，不按「没初始化」重种', async t => {
  const root = await dataRoot(t);
  await mkdir(path.join(root, 'rules'), { recursive: true });
  const base = await boot(t, { dataRoot: root });
  const listed = await call(base, '/api/rules');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { count: 0, rules: [] }, '目录已在（哪怕空）时仍被重种了');
  assert.deepEqual(await readdir(path.join(root, 'rules')), []);
});

// ── A3：版本化 + 备注落盘 ─────────────────────────────────────────────────
test('A3 备注落盘：sidecar <id>-<rev>.json、history() 逐条回 note、PUT 结果同形', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const current = await call(base, '/api/rules/honeypot_probe');
  assert.equal(current.status, 200);
  assert.match(current.body.revision, hex16);
  assert.equal(current.body.revision, ruleRevision(current.body.rego), 'revision 不是正文 sha256 前 16 位');
  const original = current.body.rego;

  const next = rego('honeypot_probe', '  input.type == "honeypot"\n  input.peer != ""\n  input.source_ip != ""\n  input.user == "root"\n  not input.source_ip == "64.177.57.21"', '蜜罐探测（root 用户）', current.body.description);
  const saved = await putRule(base, 'honeypot_probe', { rego: next, expected_revision: current.body.revision, note: '排除运维探针来源' });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));
  assert.deepEqual(Object.keys(saved.body).sort(),
    ['action', 'file', 'id', 'name', 'previous_rev', 'rev'], 'PUT 结果形状与 RegoSaveResult 不符');
  assert.equal(saved.body.action, 'update');
  assert.equal(saved.body.id, 'honeypot_probe');
  assert.equal(saved.body.file, 'honeypot_probe.rego', '写回没沿用原文件名');
  assert.equal(saved.body.previous_rev, current.body.revision, 'previous_rev 不是被覆盖那一版');
  assert.equal(saved.body.rev, ruleRevision(next));
  assert.equal(await readFile(path.join(root, 'rules', 'honeypot_probe.rego'), 'utf8'), next, '写盘没落数据根库');

  // 正文副本 + 并排的备注 sidecar（openapi /api/rules/{id}/history 描述与 RegoHistoryEntry）
  const historyDirectory = path.join(root, 'rules-history');
  const copyName = `honeypot_probe-${current.body.revision}.rego`;
  assert.equal(await readFile(path.join(historyDirectory, copyName), 'utf8'), original, '旧版正文没进 rules-history/<id>-<rev>.rego');
  const sidecar = JSON.parse(await readFile(path.join(historyDirectory, `honeypot_probe-${current.body.revision}.json`), 'utf8'));
  assert.equal(sidecar.id, 'honeypot_probe');
  assert.equal(sidecar.rev, current.body.revision);
  assert.equal(sidecar.note, '人工维护：排除运维探针来源', 'sidecar 的 note 没按「人工维护：<note>」落盘');
  assert.ok(!Number.isNaN(Date.parse(sidecar.saved_at)), `sidecar 的 saved_at 不是时间：${sidecar.saved_at}`);
  assert.ok('replaced_by' in sidecar, 'sidecar 缺 replaced_by（openapi 写明 {id, rev, note, saved_at, replaced_by}）');
  assert.ok(sidecar.replaced_by === null || hex16.test(sidecar.replaced_by), `replaced_by 形状不对：${sidecar.replaced_by}`);

  // 历史接口：note 逐条回读
  const listed = await history(base, 'honeypot_probe');
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.body).sort(), ['history', 'id']);
  assert.equal(listed.body.id, 'honeypot_probe');
  assert.equal(listed.body.history.length, 1);
  const [entry] = listed.body.history;
  assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'file', 'id', 'note', 'rev', 'saved_at'],
    '历史条目形状与 RegoHistoryEntry 不符');
  assert.equal(entry.id, 'honeypot_probe');
  assert.equal(entry.rev, current.body.revision);
  assert.equal(entry.file, copyName);
  assert.equal(entry.bytes, Buffer.byteLength(original));
  assert.equal(entry.note, '人工维护：排除运维探针来源', '历史接口没回读 sidecar 里的 note（A3 的主要锚点）');
  assert.ok(!Number.isNaN(Date.parse(entry.saved_at)));

  // 不传 note → 「人工维护」；正文未改 → unchanged 且不刷历史
  const second = rego('honeypot_probe', '  input.type == "honeypot"\n  input.user == "root"', '蜜罐探测（root 用户）');
  const saved2 = await putRule(base, 'honeypot_probe', { rego: second, expected_revision: saved.body.rev });
  assert.equal(saved2.status, 200);
  assert.equal(saved2.body.action, 'update');
  const afterTwo = await history(base, 'honeypot_probe');
  assert.equal(afterTwo.body.history.length, 2);
  assert.equal(afterTwo.body.history[1].note, '人工维护', '没传 note 时应落成「人工维护」');
  const unchanged = await putRule(base, 'honeypot_probe', { rego: second, expected_revision: saved2.body.rev, note: '不该落盘' });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.action, 'unchanged');
  assert.equal(unchanged.body.previous_rev, null, 'unchanged 时 previous_rev 应为 null');
  assert.equal((await history(base, 'honeypot_probe')).body.history.length, 2, '一字未改的提交刷了历史');
});

test('A3 缺失 / 坏 JSON 的 sidecar 一律当 null，不拖垮历史接口', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const current = await call(base, '/api/rules/honeypot_probe');
  const next = rego('honeypot_probe', '  input.type == "honeypot"\n  input.user == "root"\n  input.peer != ""', '蜜罐探测（root 用户）');
  const saved = await putRule(base, 'honeypot_probe', { rego: next, expected_revision: current.body.revision, note: '第一次' });
  assert.equal(saved.status, 200);
  const historyDirectory = path.join(root, 'rules-history');
  const sidecar = path.join(historyDirectory, `honeypot_probe-${current.body.revision}.json`);

  assert.equal((await history(base, 'honeypot_probe')).body.history[0].note, '人工维护：第一次');

  await rm(sidecar);
  const missing = await history(base, 'honeypot_probe');
  assert.equal(missing.status, 200, '备注文件缺失不该让历史接口失败');
  assert.equal(missing.body.history[0].note, null, '备注文件缺失时应读作 null');

  await writeFile(sidecar, '{ this is not json');
  const broken = await history(base, 'honeypot_probe');
  assert.equal(broken.status, 200, '坏 JSON 的备注不该让历史接口 500/502');
  assert.equal(broken.body.history[0].note, null, '坏 JSON 的备注应读作 null');

  await writeFile(sidecar, JSON.stringify({ id: 'honeypot_probe', rev: current.body.revision, note: { not: 'a string' } }));
  const odd = await history(base, 'honeypot_probe');
  assert.equal(odd.status, 200);
  assert.ok(odd.body.history[0].note === null || typeof odd.body.history[0].note === 'string',
    `note 必须是 string|null（RegoHistoryEntry 声明），实测 ${JSON.stringify(odd.body.history[0].note)}`);
});

// ── A3 / A5：错误码与边界，每类至少触发一次并断言响应体形状 ────────────────
test('A3/A5 错误码：400 / 403 / 404 / 409 / 502 / 503 都触发一次，正文是 {error, code}', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const current = await call(base, '/api/rules/honeypot_probe');
  const revision = current.body.revision;

  // 400：id 不合格式（读 / 历史两处）
  assertError(await call(base, '/api/rules/BadId'), 400);
  assertError(await call(base, '/api/rules/9lives'), 400);
  assertError(await history(base, 'BadId'), 400);
  // 404：规则不存在 / 历史里没有这一版
  assertError(await call(base, '/api/rules/no_such_rule'), 404);
  assertError(await rollback(base, 'honeypot_probe', { rev: '0'.repeat(16) }), 404);
  assertError(await rollback(base, 'no_such_rule', { rev: '0'.repeat(16) }), 404);
  // 403：令牌不对 / 没带
  assertError(await putRule(base, 'honeypot_probe', { rego: current.body.rego, expected_revision: revision }, 'wrong-token'), 403);
  assertError(await putRule(base, 'honeypot_probe', { rego: current.body.rego, expected_revision: revision }, null), 403);
  assertError(await rollback(base, 'honeypot_probe', { rev: revision }, null), 403);
  // 400：正文形状 / 必填字段 / 空正文
  assertError(await putRule(base, 'honeypot_probe', []), 400);
  assertError(await putRule(base, 'honeypot_probe', 'just a string'), 400);
  assertError(await putRule(base, 'honeypot_probe', { rego: current.body.rego }), 400);
  assertError(await putRule(base, 'honeypot_probe', { expected_revision: revision }), 400);
  assertError(await putRule(base, 'honeypot_probe', { rego: '', expected_revision: revision }), 400);
  assertError(await rollback(base, 'honeypot_probe', { rev: 'zz' }), 400);
  assertError(await rollback(base, 'honeypot_probe', {}), 400);
  // 400：包名与 id 不一致（openapi 路径参数：「必须与正文里 package 一致，否则回 400」）
  const wrongPackage = await putRule(base, 'honeypot_probe', {
    rego: rego('other_rule', '  input.type == "x"'), expected_revision: revision });
  assertError(wrongPackage, 400);
  assert.match(wrongPackage.body.error, /package|包名/, `包名错的 400 没说明原因：${wrongPackage.body.error}`);
  // 400：子集外语法，openapi 承诺报错带 <id>.rego:<行>
  const outsideSubset = await putRule(base, 'honeypot_probe', {
    rego: rego('honeypot_probe', '  input.host =~ "10.*"'), expected_revision: revision });
  assertError(outsideSubset, 400);
  assert.match(outsideSubset.body.error, /honeypot_probe\.rego:\d+/, `子集外语法没带 <文件>:<行>：${outsideSubset.body.error}`);
  // 409：expected_revision 过期（当前指纹是 revision，这里送一个 16 位但不匹配的）
  const stale = await putRule(base, 'honeypot_probe', {
    rego: rego('honeypot_probe', '  input.type == "honeypot"'), expected_revision: 'f'.repeat(16) });
  assertError(stale, 409);
  assert.match(stale.body.error, /已更新|刷新/, `409 正文应提示刷新：${stale.body.error}`);
  // 新增规则：expected_revision=null 才合法
  const created = await putRule(base, 'manual_rule', {
    rego: rego('manual_rule', '  input.type == "manual"'), expected_revision: null, note: '人工新增' });
  assert.equal(created.status, 200, created.text.slice(0, 300));
  assert.equal(created.body.action, 'add');
  assert.equal(created.body.previous_rev, null);
  assert.equal(created.body.file, 'manual_rule.rego');
  assert.equal((await call(base, '/api/rules/manual_rule')).status, 200);
  assertError(await putRule(base, 'manual_rule', {
    rego: rego('manual_rule', '  input.type == "again"'), expected_revision: null }), 409);
  // 规则从没改过 / 不存在：历史回空数组，不是 404
  const untouched = await history(base, 'webshell_drop');
  assert.equal(untouched.status, 200);
  assert.deepEqual(untouched.body, { id: 'webshell_drop', history: [] });
  const nobody = await history(base, 'no_such_rule');
  assert.equal(nobody.status, 200);
  assert.deepEqual(nobody.body, { id: 'no_such_rule', history: [] });

  // 502：规则库读不出来（缺 # name:）→ 列表 / 读 / 求值都按上游失败处理
  const ruleFile = path.join(root, 'rules', 'honeypot_probe.rego');
  const pristine = await readFile(ruleFile, 'utf8');
  await writeFile(ruleFile, pristine.replace(/^# name: .*$/m, '# no name here'));
  const brokenList = await call(base, '/api/rules');
  assertError(brokenList, 502, 'upstream_error');
  assert.match(brokenList.body.error, /rules\/honeypot_probe\.rego:\d+/, `502 没带定位：${brokenList.body.error}`);
  assertError(await call(base, '/api/rules/honeypot_probe'), 502, 'upstream_error');
  assertError(await call(base, '/api/rules/evaluate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'honeypot' }) }), 502, 'upstream_error');
  await writeFile(ruleFile, pristine);
  assert.equal((await call(base, '/api/rules')).status, 200, '还原后仍读不出来');

  // 503：没配规则管理员令牌时写接口按「没配置」处理（另起一个没令牌的进程）
  const openRoot = await dataRoot(t);
  const open = await boot(t, { dataRoot: openRoot, ruleToken: null });
  const seeded = await call(open, '/api/rules/honeypot_probe');
  assertError(await putRule(open, 'honeypot_probe', { rego: seeded.body.rego, expected_revision: seeded.body.revision }), 503, 'not_configured');
  assertError(await rollback(open, 'honeypot_probe', { rev: '0'.repeat(16) }), 503, 'not_configured');
});

test('A3 边界（待定口径）：note 超 maxLength=200 与 expected_revision 不合 pattern 的处置', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const current = await call(base, '/api/rules/honeypot_probe');
  const revision = current.body.revision;
  const longNote = '备'.repeat(201);
  const long = await putRule(base, 'honeypot_probe', {
    rego: rego('honeypot_probe', '  input.type == "honeypot"\n  input.user == "root"'), expected_revision: revision, note: longNote });
  assert.ok(long.status < 500, `超长 note 不许 5xx，实测 ${long.status}`);
  const oddRevision = await putRule(base, 'honeypot_probe', {
    rego: rego('honeypot_probe', '  input.type == "honeypot"\n  input.user == "root"'), expected_revision: 'zzz' });
  assert.ok(oddRevision.status < 500, `不合 pattern 的 expected_revision 不许 5xx，实测 ${oddRevision.status}`);
  t.diagnostic(`note>200 实测 ${long.status}；expected_revision=zzz 实测 ${oddRevision.status}（openapi 声明 maxLength/pattern，服务端是否拒绝属待定口径）`);
});

// ── A5：并发写 ───────────────────────────────────────────────────────────
test('A5 并发：同一 expected_revision 的 PUT 只成一个，另一个 409，历史只多一份', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const current = await call(base, '/api/rules/honeypot_probe');
  const left = rego('honeypot_probe', '  input.type == "left"\n  input.user == "root"', '左');
  const right = rego('honeypot_probe', '  input.type == "right"\n  input.user == "root"', '右');
  const results = await Promise.all([
    putRule(base, 'honeypot_probe', { rego: left, expected_revision: current.body.revision, note: '并发左' }),
    putRule(base, 'honeypot_probe', { rego: right, expected_revision: current.body.revision, note: '并发右' })
  ]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409],
    `并发两个 PUT 的响应应是 200/409，实测 ${JSON.stringify(results.map(row => row.status))}`);
  const winner = results.find(row => row.status === 200);
  const after = await call(base, '/api/rules/honeypot_probe');
  assert.equal(after.body.revision, winner.body.rev, '落盘的不是赢的那份');
  assert.equal(after.body.rego, results.indexOf(winner) === 0 ? left : right);
  const older = await history(base, 'honeypot_probe');
  assert.equal(older.body.history.length, 1, '并发写把历史刷了多份（或没记）');

  // 五个并发：只成一个
  const revision = after.body.revision;
  const five = await Promise.all([1, 2, 3, 4, 5].map(index => putRule(base, 'honeypot_probe', {
    rego: rego('honeypot_probe', `  input.type == "burst-${index}"\n  input.user == "root"`, `并发 ${index}`),
    expected_revision: revision })));
  const statuses = five.map(row => row.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409], `五个并发 PUT 应是 1 成 4 冲突，实测 ${JSON.stringify(statuses)}`);
  assert.equal((await call(base, '/api/rules/honeypot_probe')).body.revision, five.find(row => row.status === 200).body.rev);
  assert.equal((await history(base, 'honeypot_probe')).body.history.length, 2, '五次并发写应只多一份历史');
});

test('A5 并发：新增规则的两路写只成一个；PUT 与回滚同队列串行、不交叉', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const one = rego('manual_rule', '  input.type == "one"');
  const two = rego('manual_rule', '  input.type == "two"');
  const added = await Promise.all([
    putRule(base, 'manual_rule', { rego: one, expected_revision: null }),
    putRule(base, 'manual_rule', { rego: two, expected_revision: null })
  ]);
  assert.deepEqual(added.map(row => row.status).sort(), [200, 409],
    `并发新增同一 id 的响应应是 200/409，实测 ${JSON.stringify(added.map(row => row.status))}`);
  const winner = added.find(row => row.status === 200);
  const settled = await call(base, '/api/rules/manual_rule');
  assert.equal(settled.body.revision, winner.body.rev);
  const files = (await readdir(path.join(root, 'rules'))).filter(name => name.startsWith('manual_rule'));
  assert.deepEqual(files, ['manual_rule.rego'], `同 id 起了第二个文件：${files.join(',')}`);

  // PUT 与回滚并发：两者都过同一段写队列。允许 409（版本对不上），但不许 5xx、不许历史与成功次数对不上
  const base0 = await call(base, '/api/rules/manual_rule');
  const mixed = await Promise.all([
    putRule(base, 'manual_rule', { rego: rego('manual_rule', '  input.type == "three"'), expected_revision: base0.body.revision, note: '并发写' }),
    rollback(base, 'manual_rule', { rev: base0.body.revision, who: '值班主任' })
  ]);
  for (const row of mixed) assert.ok(row.status < 500, `并发写与回滚出现 5xx：${row.status} ${row.text.slice(0, 200)}`);
  assert.ok(mixed.every(row => row.status === 200 || row.status === 409), `并发写与回滚出现了意外的状态：${JSON.stringify(mixed.map(row => row.status))}`);
  const successCount = mixed.filter(row => row.status === 200).length;
  const afterMixed = await history(base, 'manual_rule');
  assert.equal(afterMixed.body.history.length, successCount,
    `成功 ${successCount} 次写，历史却有 ${afterMixed.body.history.length} 条（写队列没串起来）`);
  const revs = afterMixed.body.history.map(row => row.rev);
  assert.equal(new Set(revs).size, revs.length, `历史里同一版出现两次：${revs.join(',')}`);
});

// ── A5：维护会话摘要接口 ──────────────────────────────────────────────────
test('A5 sessions 路由不被 /api/rules/{id} 抢走；摘要只回元数据、按 updated_at 倒序', async t => {
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  // `sessions` 本身是合法规则 id：先把它做成一条真规则，再看路由谁赢
  const created = await putRule(base, 'sessions', { rego: rego('sessions', '  input.type == "x"'), expected_revision: null });
  assert.equal(created.status, 200, created.text.slice(0, 200));
  const listed = await call(base, '/api/rules/sessions');
  assert.equal(listed.status, 200, `GET /api/rules/sessions 被 /api/rules/{id} 抢走了：${listed.text.slice(0, 200)}`);
  assert.deepEqual(Object.keys(listed.body).sort(), ['sessions']);
  assert.ok(Array.isArray(listed.body.sessions));

  // 会话记录：按 openapi RegoSessionSummary 的字段造两份（数据文件是数据根输入，不是代码）
  const sessionsDirectory = path.join(root, 'rule-sessions');
  await mkdir(sessionsDirectory, { recursive: true });
  const record = (id, updated_at, extra) => JSON.stringify({
    id, case_id: 'honeypot:7', case_dir: '/data/cases/honeypot/7', event_type: 'honeypot',
    who: '值守', status: 'updated', rule_id: 'honeypot_probe', validated: true, updated_at,
    proposal: { rego: 'SECRET_REGO_MARKER', rationale: '草案理由' }, reason: 'REASON_MARKER', ...extra
  });
  await writeFile(path.join(sessionsDirectory, '11111111-1111-4111-8111-111111111111.json'),
    record('11111111-1111-4111-8111-111111111111', '2026-01-01T00:00:00.000Z'));
  await writeFile(path.join(sessionsDirectory, '22222222-2222-4222-8222-222222222222.json'),
    record('22222222-2222-4222-8222-222222222222', '2026-02-01T00:00:00.000Z'));
  const summaries = await call(base, '/api/rules/sessions');
  assert.equal(summaries.status, 200);
  assert.equal(summaries.body.sessions.length, 2, '数据根 rule-sessions 里的两份会话没被列出来（openapi 说全文在 <数据根>/rule-sessions/<uuid>.json）');
  assert.deepEqual(summaries.body.sessions.map(row => row.id),
    ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'], '会话摘要没按 updated_at 倒序');
  for (const row of summaries.body.sessions) {
    for (const key of ['id', 'case_id', 'event_type', 'who', 'status', 'rule_id', 'validated', 'updated_at']) {
      assert.ok(key in row, `摘要缺 ${key}（RegoSessionSummary required）`);
    }
    assert.ok(['collecting', 'validating', 'updated', 'no_change', 'failed'].includes(row.status));
    assert.equal(typeof row.validated, 'boolean');
  }
  assert.doesNotMatch(summaries.text, /SECRET_REGO_MARKER|REASON_MARKER/, '摘要里带了规则正文或误报理由原文');
});

// ── A6：知识库读写跟着数据根走 ────────────────────────────────────────────
test('A6 知识库：读数据根种子库；PUT 落数据根库并留历史；仓内 wiki/ 不动；sessions 仍要令牌', async t => {
  const repoWikiBefore = await digest(path.join(repository, 'wiki'));
  const root = await dataRoot(t);
  const base = await boot(t, { dataRoot: root });
  const before = await call(base, '/api/wiki/pages/honeypot%2FHP-01.md');
  assert.equal(before.status, 200, before.text.slice(0, 300));
  assert.match(before.body.revision, hex16);
  const next = before.body.content.replace('蜜罐', '蜜罐（外置库改过）');
  assert.notEqual(next, before.body.content, '测试前提：页面正文里得有「蜜罐」两个字');

  // 写（带知识库管理员令牌）：落数据根库、旧版进数据根 wiki-history、log.md 记账
  const saved = await call(base, '/api/wiki/pages/honeypot%2FHP-01.md', {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-prompt-admin-token': PROMPT_TOKEN },
    body: JSON.stringify({ content: next, expected_revision: before.body.revision }) });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));
  assert.notEqual(saved.body.revision, before.body.revision);
  assert.equal(await readFile(path.join(root, 'wiki', 'honeypot', 'HP-01.md'), 'utf8'), next, '写路径没落数据根判据库');
  const wikiHistory = await readdir(path.join(root, 'wiki-history'));
  assert.ok(wikiHistory.includes(`HP-01-${before.body.revision}.md`), `旧版没进数据根 wiki-history：${wikiHistory.slice(0, 5)}`);
  assert.match(await readFile(path.join(root, 'wiki', 'log.md'), 'utf8'), /HP-01/, '数据根库的 log.md 没记账');
  assert.deepEqual(await digest(path.join(repository, 'wiki')), repoWikiBefore, '仓内 wiki/ 被运行期写了');

  // 令牌口径探针：docs/modules/http-api.md:398 说「/api/wiki/ 底下别的路径会先撞令牌判定」，
  // 这里如实记 PUT pages 不带令牌的实测状态（<500 即可，不据此判本卡对错；结论进测试报告）。
  const currentPage = await call(base, '/api/wiki/pages/honeypot%2FHP-01.md');
  const noToken = await call(base, '/api/wiki/pages/honeypot%2FHP-01.md', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: currentPage.body.content.replace('外置库改过', '无令牌写入'), expected_revision: currentPage.body.revision }) });
  assert.ok(noToken.status < 500, `不带令牌写页面出现 5xx：${noToken.status}`);
  t.diagnostic(`PUT /api/wiki/pages/{path} 不带知识库令牌实测 ${noToken.status}（docs 说会先撞令牌判定回 403）`);
  const finalContent = (await call(base, '/api/wiki/pages/honeypot%2FHP-01.md')).body.content;

  // 二次启动读到的是数据根里最后那一份（种子不重种）
  const second = await boot(t, { dataRoot: root });
  assert.equal((await call(second, '/api/wiki/pages/honeypot%2FHP-01.md')).body.content, finalContent);

  // sessions 接口沿用：没令牌 403，带令牌 200
  assert.equal((await call(base, '/api/wiki/sessions')).status, 403);
  const sessions = await call(base, '/api/wiki/sessions', { headers: { 'x-prompt-admin-token': PROMPT_TOKEN } });
  assert.equal(sessions.status, 200, sessions.text.slice(0, 200));
  assert.ok(Array.isArray(sessions.body.sessions));
});

// ── A8：替身全链（HTTP 侧）+ 回滚备注 ─────────────────────────────────────
test('A8 全链：改一条 → 数据根变更 → 历史有副本与备注 → 回滚生效且进历史 → 重启仍在', async t => {
  const repoRulesBefore = await digest(path.join(repository, 'rules'));
  const root = await dataRoot(t);
  const first = await boot(t, { dataRoot: root });
  const before = await call(first, '/api/rules/ssh_bruteforce');
  assert.equal(before.status, 200);
  const tightened = rego('ssh_bruteforce', '  input.type == "abnormal_login"\n  input.source_ip != ""\n  contains(input.command, "ssh")\n  not contains(input.command, "healthcheck")', 'SSH 暴力破解来源（排除健康检查）', before.body.description);
  const saved = await putRule(first, 'ssh_bruteforce', { rego: tightened, expected_revision: before.body.revision, note: '排除健康检查' });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));
  assert.equal(await readFile(path.join(root, 'rules', 'ssh_bruteforce.rego'), 'utf8'), tightened);
  const afterSave = await history(first, 'ssh_bruteforce');
  assert.equal(afterSave.body.history.length, 1);
  assert.equal(afterSave.body.history[0].note, '人工维护：排除健康检查');

  // 回滚：当前版进历史、备注写 who、可再回滚
  const rolled = await rollback(first, 'ssh_bruteforce', { rev: before.body.revision, who: '值班主任' });
  assert.equal(rolled.status, 200, rolled.text.slice(0, 300));
  assert.equal(rolled.body.action, 'rollback');
  assert.equal(rolled.body.rolled_back_to, before.body.revision, '回滚结果没带 rolled_back_to');
  assert.equal((await call(first, '/api/rules/ssh_bruteforce')).body.rego, before.body.rego, '回滚没恢复原正文');
  const afterRollback = await history(first, 'ssh_bruteforce');
  assert.equal(afterRollback.body.history.length, 2, '回滚本身那一版没进历史（回滚就不可逆了）');
  const replaced = afterRollback.body.history.find(row => row.rev === saved.body.rev);
  assert.ok(replaced, '被回滚掉的那一版没进历史');
  assert.equal(replaced.note, '人工回滚（值班主任）', '回滚的 who 没写进历史备注');
  const firstCopy = afterRollback.body.history.find(row => row.rev === before.body.revision);
  assert.equal(firstCopy.note, '人工维护：排除健康检查', '同一版被归档第二次时备注应保留第一次的');

  // 再回滚回去：历史不重复记同一版
  const back = await rollback(first, 'ssh_bruteforce', { rev: saved.body.rev, who: '值班主任' });
  assert.equal(back.status, 200, back.text.slice(0, 300));
  const finalHistory = await history(first, 'ssh_bruteforce');
  assert.equal(finalHistory.body.history.length, 2, '回滚回去把同一版又记了一份');
  assert.deepEqual(finalHistory.body.history.map(row => row.rev), [before.body.revision, saved.body.rev], '历史不是按写入时间升序');

  // 重启：数据根里的正文与历史都还在，仓库副本没被碰
  const second = await boot(t, { dataRoot: root });
  const reopened = await call(second, '/api/rules/ssh_bruteforce');
  assert.equal(reopened.body.rego, tightened);
  assert.equal((await history(second, 'ssh_bruteforce')).body.history.length, 2);
  assert.deepEqual(await digest(path.join(repository, 'rules')), repoRulesBefore, '仓内 rules/ 被运行期写了');
});

// ── A7：契约文本与实测对得上（openapi 是文档真源） ─────────────────────────
test('A7 openapi 里有本卡四条维护路由与备注 schema；docs 旧口径已换', async t => {
  const openapi = await readFile(path.join(repository, 'openapi.yaml'), 'utf8');
  const docs = await readFile(path.join(repository, 'docs', 'modules', 'http-api.md'), 'utf8');
  const architecture = await readFile(path.join(repository, 'docs', 'architecture.md'), 'utf8');

  for (const pathname of ['/api/rules/sessions', '/api/rules/{id}/history', '/api/rules/{id}/rollback']) {
    assert.ok(openapi.includes(`${pathname}:`), `openapi 缺路径 ${pathname}`);
  }
  const putBlock = openapi.slice(openapi.indexOf('  /api/rules/{id}:\n'));
  assert.ok(putBlock.includes('    put:'), 'openapi 的 /api/rules/{id} 缺 PUT');
  for (const claim of ['<id>-<rev>.json', '人工维护：<note>', '人工回滚（<who>）', '误报维护（<who>）：<理由>', 'expected_revision']) {
    assert.ok(openapi.includes(claim), `openapi 里找不到本卡承诺的「${claim}」`);
  }
  const entry = openapi.slice(openapi.indexOf('    RegoHistoryEntry:'), openapi.indexOf('    RegoRuleHistory:'));
  assert.match(entry, /required: \[id, rev, file, bytes, saved_at, note\]/, 'RegoHistoryEntry 的必填字段不含 note（A3 的契约面）');
  assert.match(entry, /note:\s*\n\s*type: \[string, 'null'\]/, 'RegoHistoryEntry.note 声明不是 string|null');
  assert.ok(docs.includes('/api/rules/{id}/history'), 'http-api 路由表没同步历史路由');
  assert.ok(docs.includes('/api/rules/{id}/rollback'), 'http-api 路由表没同步回滚路由');
  assert.ok(architecture.includes('<数据根>/rules/'), 'architecture 没写规则库落数据根');
  assert.ok(!/规则库跟着代码走|规则库在仓内|规则住在仓内/.test(architecture + docs), '文档里还留着「规则库跟着代码走」的旧口径');
  assert.ok(/rule-sessions/.test(architecture), 'architecture 没写维护会话目录');
});
