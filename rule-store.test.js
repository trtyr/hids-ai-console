import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuleStore } from './rule-store.js';
import { createServer } from './server.js';

// 一条规则的 Rego 文本：package + 显示名 + 一个 match 体。
function rule(id, expressions, { name = `规则 ${id}`, description = null } = {}) {
  const meta = description ? `# description: ${description}\n` : '';
  return `package hids.rules.${id}\n\n# name: ${name}\n${meta}\ndefault match := false\n\nmatch if {\n${expressions.map(line => `  ${line}`).join('\n')}\n}\n`;
}

async function storeWith(t, files) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(directory, file), content);
  return new RuleStore(directory);
}

// 业务 API 只用来验三条只读路由；语料注入临时目录，不依赖仓内 rules/ 的内容。
async function serve(t, rules) {
  const server = createServer(null, null, null, null, null, null, null, {}, null, null, null, null, null, null, rules);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// ---- A1：一条规则一份 Rego，有名字，能列、能按 id 读到原文 ----

test('A1 一条规则一份 Rego：能列出名字，能按 id 逐字读回原文', async t => {
  const source = rule('brute_force', ['input.type == "brute_force"'], { name: '暴力破解', description: '登录失败聚集' });
  const rules = await storeWith(t, { 'brute-force.rego': source });

  const listed = await rules.list();
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.rules, [{ id: 'brute_force', name: '暴力破解', description: '登录失败聚集', file: 'brute-force.rego' }]);

  const read = await rules.read('brute_force');
  assert.equal(read.name, '暴力破解');
  assert.equal(read.rego, source);
});

test('A1 列表按 id 排序；没有规则文件时明确返回空列表', async t => {
  const rules = await storeWith(t, {
    'b.rego': rule('zeta', ['input.type == "webshell"']),
    'a.rego': rule('alpha', ['input.type == "honeypot"']),
  });
  assert.deepEqual((await rules.list()).rules.map(item => item.id), ['alpha', 'zeta']);

  const empty = await storeWith(t, {});
  assert.deepEqual(await empty.list(), { count: 0, rules: [] });
  assert.equal(await empty.read('alpha'), null);
});

test('A1 按 id 读不到：不存在或格式不对都回 null，不读目录外的文件', async t => {
  const rules = await storeWith(t, { 'a.rego': rule('alpha', ['input.type == "x"']) });
  assert.equal(await rules.read('no_such_rule'), null);
  for (const id of ['../server', 'Alpha', 'a b', '', null, 1]) assert.equal(await rules.read(id), null, `${id}`);
});

test('A1 规则 id 由 package 决定：重复 id 装载即报错并点名两份文件', async t => {
  const rules = await storeWith(t, {
    'a.rego': rule('same', ['input.type == "x"']),
    'b.rego': rule('same', ['input.type == "y"']),
  });
  await assert.rejects(rules.list(), /规则 id 重复：same（a\.rego 与 b\.rego）/);
});

test('A1 规则目录不存在时报错，不静默当成空规则库', async t => {
  const missing = path.join(tmpdir(), `hids-rules-missing-${process.pid}-${Date.now()}`);
  await assert.rejects(new RuleStore(missing).list(), /规则目录不存在/);
});

// ---- A2：告警事实的七个字段都能取值；没写的字段就是不限制 ----

test('A2 规则没写的字段不限制：只写 type 的规则对任意用户、命令、对端都成立', async t => {
  const rules = await storeWith(t, { 'typed.rego': rule('typed', ['input.type == "honeypot"']) });
  assert.equal((await rules.evaluate({ type: 'honeypot', user: 'root', command: 'curl', peer: '10.0.0.2' })).count, 1);
  assert.equal((await rules.evaluate({ type: 'honeypot' })).count, 1);
  assert.equal((await rules.evaluate({ type: 'webshell' })).count, 0);
});

test('A2 七个字段（主机/对端/命令/用户/路径/类型/来源 IP）都能被规则取值', async t => {
  const rules = await storeWith(t, {
    'all-fields.rego': rule('all_fields', [
      'input.host == "web-01"',
      'input.peer == "10.0.0.9"',
      'input.command == "curl http://a/b.jsp"',
      'input.user == "root"',
      'input.path == "/tmp/a.jsp"',
      'input.type == "webshell"',
      'input.source_ip == "10.0.0.9"',
    ]),
  });
  const fact = { host: 'web-01', peer: '10.0.0.9', command: 'curl http://a/b.jsp', user: 'root',
    path: '/tmp/a.jsp', type: 'webshell', source_ip: '10.0.0.9' };
  assert.equal((await rules.evaluate(fact)).count, 1);
  for (const field of Object.keys(fact)) {
    const partial = { ...fact };
    delete partial[field];
    assert.equal((await rules.evaluate(partial)).count, 0, `事实缺 ${field} 时不应命中`);
  }
});

test('A2 比较是严格相等；contains / startswith / endswith 只对字符串成立', async t => {
  const rules = await storeWith(t, {
    'operators.rego': rule('operators', [
      'input.user == "root"',
      'input.count == 2',
      'input.total != 5',
      'contains(input.command, "ssh")',
      'startswith(input.path, "/tmp/")',
      'endswith(input.path, ".jsp")',
    ]),
  });
  const fact = { user: 'root', count: 2, total: 4, command: 'sudo ssh x', path: '/tmp/a.jsp' };
  assert.equal((await rules.evaluate(fact)).count, 1);
  assert.equal((await rules.evaluate({ ...fact, user: 'ROOT' })).count, 0, '字符串大小写敏感');
  assert.equal((await rules.evaluate({ ...fact, count: '2' })).count, 0, '== 是严格相等，数字与数字字符串不相等');
  assert.equal((await rules.evaluate({ ...fact, total: 5 })).count, 0, '!= 应拒绝相等值');
  assert.equal((await rules.evaluate({ ...fact, total: '5' })).count, 1, '!= 也严格：字符串 "5" 不等于数字 5');
  assert.equal((await rules.evaluate({ ...fact, command: 'sudo sshd' })).count, 1);
  assert.equal((await rules.evaluate({ ...fact, path: '/var/a.jsp' })).count, 0);
  assert.equal((await rules.evaluate({ ...fact, path: '/tmp/a.jspx' })).count, 0);
  assert.equal((await rules.evaluate({ ...fact, command: ['ssh'] })).count, 0, '非字符串不参与 contains');
});

test('A2 字面量支持字符串、数字、true / false / null', async t => {
  const rules = await storeWith(t, {
    'literals.rego': rule('literals', ['input.level == 3', 'input.active == true', 'input.closed == null']),
  });
  assert.equal((await rules.evaluate({ level: 3, active: true, closed: null })).count, 1);
  assert.equal((await rules.evaluate({ level: '3', active: true, closed: null })).count, 0);
  assert.equal((await rules.evaluate({ level: 3, active: false, closed: null })).count, 0);
});

test('A2 事实缺字段按 Rego 的 undefined 处理：引用它的条件不成立，not 才成立', async t => {
  const rules = await storeWith(t, {
    'positive.rego': rule('positive', ['input.user == "root"']),
    'negative.rego': rule('negative', ['not input.user == "root"']),
  });
  const missing = await rules.evaluate({ type: 'webshell' });
  assert.deepEqual(missing.matched.map(item => item.id), ['negative']);
  const notEqual = await rules.evaluate({ user: 'nobody' });
  assert.deepEqual(notEqual.matched.map(item => item.id), ['negative']);
  const root = await rules.evaluate({ user: 'root' });
  assert.deepEqual(root.matched.map(item => item.id), ['positive']);
});

// ---- A3：给定事实返回命中的规则名字与 Rego 正文；没命中明确返回空 ----

test('A3 命中时返回规则名字与 Rego 正文；没有命中时 matched 是空数组', async t => {
  const first = rule('alpha', ['input.type == "webshell"'], { name: '甲规则' });
  const second = rule('beta', ['input.type == "honeypot"'], { name: '乙规则' });
  const rules = await storeWith(t, { 'a.rego': first, 'b.rego': second });

  const hit = await rules.evaluate({ type: 'webshell' });
  assert.equal(hit.count, 1);
  assert.deepEqual(hit.matched, [{ id: 'alpha', name: '甲规则', rego: first }]);

  const both = await rules.evaluate({ type: 'webshell', user: 'root' });
  assert.equal(both.count, 1, '规则没写的字段不影响');

  const none = await rules.evaluate({ type: 'malware' });
  assert.deepEqual(none, { count: 0, matched: [] });
});

test('A3 空规则库求值：明确返回空结果而不是 null 或报错', async t => {
  const rules = await storeWith(t, {});
  assert.deepEqual(await rules.evaluate({ type: 'webshell' }), { count: 0, matched: [] });
});

test('A3 事实必须是 JSON 对象：null / 数组 / 标量都拒绝', async t => {
  const rules = await storeWith(t, {});
  for (const fact of [null, [], 'x', 42, true]) {
    await assert.rejects(rules.evaluate(fact), /告警事实必须是 JSON 对象/, String(fact));
  }
});

// ---- 装载期拦住子集外的写法 ----

test('子集外的 Rego 在装载时报错，消息带 rules/<文件>:<行>', async t => {
  const cases = [
    ['no_name.rego', 'package hids.rules.no_name\n\nmatch if {\n  input.type == "x"\n}\n', /rules\/no_name\.rego:1: 缺少 # name/],
    ['no_package.rego', '# name: 无包\n\nmatch if {\n  input.type == "x"\n}\n', /rules\/no_package\.rego:1: 缺少 package/],
    ['bad_package.rego', 'package other.rules.x\n\n# name: 包错了\nmatch if {\n  input.type == "x"\n}\n', /rules\/bad_package\.rego:1: package 必须是/],
    ['sets.rego', 'package hids.rules.sets\n\n# name: 集合\nmatch if {\n  input.type in {"a", "b"}\n}\n', /rules\/sets\.rego:5: 不支持的表达式/],
    ['literal.rego', 'package hids.rules.literal\n\n# name: 字面量\nmatch if {\n  input.user == root\n}\n', /rules\/literal\.rego:5: 字面量只能是/],
    ['unclosed.rego', 'package hids.rules.unclosed\n\n# name: 没闭合\nmatch if {\n  input.type == "x"\n', /rules\/unclosed\.rego:\d+: match 体没有闭合/],
    ['two_bodies.rego', 'package hids.rules.two_bodies\n\n# name: 两个体\nmatch if {\n  input.type == "x"\n}\nmatch if {\n  input.type == "y"\n}\n', /rules\/two_bodies\.rego:7: 一条规则只能有一个 match 体/],
    ['empty_body.rego', 'package hids.rules.empty_body\n\n# name: 空体\nmatch if {\n}\n', /rules\/empty_body\.rego:1: match 体至少写一条表达式/],
  ];
  for (const [file, source, expected] of cases) {
    const rules = await storeWith(t, { [file]: source });
    await assert.rejects(rules.list(), expected, file);
  }
});

// ---- HTTP 只读路由 ----

test('HTTP 列规则 / 按 id 读原文 / 求值：命中给正文，没命中给空', async t => {
  const source = rule('ssh_bruteforce', ['input.type == "abnormal_login"', 'contains(input.command, "ssh")'], { name: 'SSH 暴力破解' });
  const base = await serve(t, await storeWith(t, { 'ssh_bruteforce.rego': source }));

  const listed = await (await fetch(`${base}/api/rules`)).json();
  assert.deepEqual(listed.rules.map(item => item.id), ['ssh_bruteforce']);

  const detail = await fetch(`${base}/api/rules/ssh_bruteforce`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).rego, source);
  assert.equal((await fetch(`${base}/api/rules/no_such_rule`)).status, 404);
  assert.equal((await fetch(`${base}/api/rules/Bad-Id`)).status, 400);

  const evaluate = fact => fetch(`${base}/api/rules/evaluate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fact) });
  const hit = await evaluate({ type: 'abnormal_login', command: 'ssh root@10.0.0.1' });
  assert.equal(hit.status, 200);
  assert.deepEqual(await hit.json(), { count: 1, matched: [{ id: 'ssh_bruteforce', name: 'SSH 暴力破解', rego: source }] });
  assert.deepEqual(await (await evaluate({ type: 'webshell' })).json(), { count: 0, matched: [] });
  assert.equal((await evaluate([])).status, 400);
  assert.equal((await evaluate('x')).status, 400);
});

// ---- A6：按 mtime 缓存已解析规则 ----

// 固定 mtime 写盘：同一毫秒内改写内容也能造出「内容变了、mtime 没变」的前置态。
// （直接 utimes 回原值不行：文件系统 mtime 有亚毫秒精度，Date 只有毫秒。）
const FIXED_MTIME = new Date(1_793_600_000_000);
async function writeWithMtime(filename, content, at = FIXED_MTIME) {
  await writeFile(filename, content);
  await utimes(filename, at, at);
  assert.equal((await stat(filename)).mtimeMs, at.getTime(), '测试前置：mtime 必须是固定整毫秒');
}

test('A6 求值命中 mtime 缓存：同 mtime 改写内容不重读重解析，mtime 一变立刻生效', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rules-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'alpha.rego');
  await writeWithMtime(filename, rule('alpha', ['input.type == "webshell"']));
  const rules = new RuleStore(directory);
  assert.equal((await rules.evaluate({ type: 'webshell' })).count, 1);
  assert.equal((await rules.evaluate({ type: 'honeypot' })).count, 0);

  // 同 mtime 改成 honeypot 规则：命中缓存时行为不应变化（还是旧规则）。
  await writeWithMtime(filename, rule('alpha', ['input.type == "honeypot"']));
  assert.equal((await rules.evaluate({ type: 'webshell' })).count, 1, '同 mtime 走缓存：旧规则仍生效');
  assert.equal((await rules.evaluate({ type: 'honeypot' })).count, 0);

  // 只碰 mtime（内容不变）：必须重新读，但没有行为差异——用下面这一步改内容 + 新 mtime 验生效。
  await writeWithMtime(filename, rule('alpha', ['input.type == "honeypot"']), new Date(FIXED_MTIME.getTime() + 1000));
  assert.equal((await rules.evaluate({ type: 'honeypot' })).count, 1, 'mtime 变化后重读重解析，新规则生效');
  assert.equal((await rules.evaluate({ type: 'webshell' })).count, 0);
});

test('A6 语法错在同 mtime 下不重解析；mtime 变化后才报错；删掉的规则立即消失', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-rules-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'alpha.rego');
  await writeWithMtime(filename, rule('alpha', ['input.type == "webshell"']));
  const rules = new RuleStore(directory);
  assert.equal((await rules.list()).count, 1);

  // 同 mtime、同字节数的坏内容：缓存键（mtimeMs, size）都没变，不许重解析，也不许报错。
  const broken = rule('alpha', ['input.type == "webshell"']).replace('default match := false', 'default match := falsy');
  assert.equal(Buffer.byteLength(broken), Buffer.byteLength(rule('alpha', ['input.type == "webshell"'])), '测试前置：坏内容与好内容等长');
  await writeWithMtime(filename, broken);
  assert.equal((await rules.list()).count, 1, '同 mtime 同大小不重解析：坏内容被缓存挡下');
  await writeWithMtime(filename, broken, new Date(FIXED_MTIME.getTime() + 1000));
  await assert.rejects(() => rules.list(), /rules\/alpha\.rego:\d+: 不支持的语法/);

  await writeWithMtime(path.join(directory, 'beta.rego'), rule('beta', ['input.type == "honeypot"']));
  await rm(filename);
  const listed = await rules.list();
  assert.deepEqual(listed.rules.map(item => item.id), ['beta'], '删掉的文件连同缓存一起消失');
});
