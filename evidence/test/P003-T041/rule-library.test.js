import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuleSessionStore, RuleStore, ruleHistoryDirectory, ruleLibraryDirectory, ruleRevision,
  ruleSessionsDirectory, seedLibrary } from '../../../rule-store.js';

// P003-T041：规则库外置（A1/A2）、版本化（A3）、维护会话（A4）的单元钉子。
// 全部在临时目录里跑：种子的「数据根」也注入 tmp，不写真实全局根。

const rule = (id, expression = 'input.type == "x"', name = `规则 ${id}`) =>
  `package hids.rules.${id}\n\n# name: ${name}\n\ndefault match := false\n\nmatch if {\n  ${expression}\n}\n`;

// 临时「数据根」：造一个与仓内 rules/ 同形的种子源，再用 withDataRoot 把 dataRoot() 引到它上面。
async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-rule-lib-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function withDataRoot(t, root) {
  const previous = process.env.HIDS_DATA_DIR;
  process.env.HIDS_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.HIDS_DATA_DIR;
    else process.env.HIDS_DATA_DIR = previous;
  });
}

async function injected(t) {
  const root = await tempRoot(t);
  const directory = path.join(root, 'rules');
  const historyDirectory = path.join(root, 'rules-history');
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, historyDirectory,
    store: new RuleStore(directory, { historyDirectory, seedFrom: null }) };
}

test('A1 缺省库落数据根：rules/、rules-history/、rule-sessions/ 三条路径跟着 HIDS_DATA_DIR 走', async t => {
  const root = await tempRoot(t);
  await withDataRoot(t, root);
  assert.equal(ruleLibraryDirectory(), path.join(root, 'rules'));
  assert.equal(ruleHistoryDirectory(), path.join(root, 'rules-history'));
  assert.equal(ruleSessionsDirectory(), path.join(root, 'rule-sessions'));
  assert.equal(new RuleStore().directory, path.join(root, 'rules'));
  assert.equal(new RuleStore().historyDirectory, path.join(root, 'rules-history'));
  assert.equal(new RuleSessionStore().directory, path.join(root, 'rule-sessions'));
});

test('A1 注入的目录不读仓库：显式传目录时种子源为空，目录不存在就照旧报「规则目录不存在」', async t => {
  const root = await tempRoot(t);
  const missing = path.join(root, 'no-such-rules');
  const store = new RuleStore(missing);
  assert.equal(store.seedSource, null);
  await assert.rejects(store.list(), /规则目录不存在/, '注入的目录被当成缺省库，偷偷种了仓库副本？');
  assert.equal(await readdir(root).then(names => names.length), 0, '注入目录不该被就地建出来');
});

test('A2 数据根无库时从仓库 rules/ 初始化一次；有库之后二次启动不重复初始化', async t => {
  const root = await tempRoot(t);
  await withDataRoot(t, root);
  const first = await new RuleStore().list();
  assert.ok(first.count >= 3, `种子没拷过来：${JSON.stringify(first.rules.map(item => item.id))}`);
  assert.ok(first.rules.some(item => item.id === 'ssh_bruteforce'));
  const seeded = await readdir(path.join(root, 'rules'));
  assert.ok(seeded.every(name => name.endsWith('.rego')));

  // 维护者改一条 + 新增一条：再起一个 store（＝下一次进程启动）不该把仓库副本盖回来。
  const store = new RuleStore();
  await store.save('ssh_bruteforce', rule('ssh_bruteforce', 'input.type == "abnormal_login"', '改过的名字'));
  await store.save('locally_added', rule('locally_added'));
  const second = await new RuleStore().list();
  assert.equal(second.count, first.count + 1, '第二次启动把数据根库盖回去了');
  assert.equal((await new RuleStore().read('ssh_bruteforce')).name, '改过的名字');
  assert.ok(second.rules.some(item => item.id === 'locally_added'));
});

test('A2 种子只在目录不存在时发生：目录已存在（哪怕空）就一个字不写', async t => {
  const root = await tempRoot(t);
  await withDataRoot(t, root);
  await mkdir(path.join(root, 'rules'), { recursive: true });
  const listed = await new RuleStore().list();
  assert.deepEqual(listed, { count: 0, rules: [] }, '数据根库已存在时又种了一遍');
  assert.deepEqual(await readdir(path.join(root, 'rules')), []);
});

test('A2 seedLibrary 并发认领：同一目标被同时初始化两次，只有一个返回 true', async t => {
  const root = await tempRoot(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'nested', 'target');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'a.rego'), rule('a'));
  const results = await Promise.all([seedLibrary(target, source), seedLibrary(target, source)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.deepEqual(await readdir(target), ['a.rego']);
});

test('A3 每次改规则旧版落 <id>-<rev>.rego：能列历史、按 rev 读原文、回滚生效', async t => {
  const { store, historyDirectory } = await injected(t);
  const v1 = rule('brute_force', 'input.type == "abnormal_login"', '一版');
  const v2 = rule('brute_force', 'input.type == "brute_force"', '二版');
  const added = await store.save('brute_force', v1);
  assert.equal(added.action, 'add');
  assert.equal(added.previous_rev, null);
  assert.equal(added.rev, ruleRevision(v1));
  assert.deepEqual(await store.history('brute_force'), [], '新增规则不该凭空造历史');

  const updated = await store.save('brute_force', v2);
  assert.equal(updated.action, 'update');
  assert.equal(updated.previous_rev, ruleRevision(v1));
  assert.equal((await store.read('brute_force')).rego, v2);

  const history = await store.history('brute_force');
  assert.equal(history.length, 1, '旧版没有进历史');
  assert.equal(history[0].rev, ruleRevision(v1));
  assert.equal(history[0].file, `brute_force-${ruleRevision(v1)}.rego`);
  assert.equal(await readFile(path.join(historyDirectory, history[0].file), 'utf8'), v1);
  assert.deepEqual(await store.readRevision('brute_force', ruleRevision(v1)), { id: 'brute_force',
    rev: ruleRevision(v1), rego: v1 });

  const rolled = await store.rollback('brute_force', ruleRevision(v1));
  assert.equal(rolled.action, 'rollback');
  assert.equal(rolled.rolled_back_to, ruleRevision(v1));
  assert.equal((await store.read('brute_force')).rego, v1);
  const after = await store.history('brute_force');
  assert.deepEqual(after.map(row => row.rev).sort(), [ruleRevision(v1), ruleRevision(v2)].sort(),
    '回滚前那一版（二版）没进历史，回滚就不可逆了');
});

test('A3 正文一字未改不刷历史、不写盘；历史里没有的 rev 回滚直接报错', async t => {
  const { store } = await injected(t);
  const source = rule('alpha');
  await store.save('alpha', source);
  const same = await store.save('alpha', source);
  assert.equal(same.action, 'unchanged');
  assert.deepEqual(await store.history('alpha'), []);
  await assert.rejects(store.rollback('alpha', '0'.repeat(16)), /规则历史版本不存在/);
  assert.equal(await store.readRevision('alpha', '../../etc/passwd'), null);
  assert.deepEqual(await store.history('../../etc/passwd'), []);
});

test('A3 校验不过一个字都不落：语法错、package 与 id 不一致都拒写，也不留历史', async t => {
  const { store, directory, historyDirectory } = await injected(t);
  await store.save('alpha', rule('alpha', 'input.type == "a"'));
  const broken = `package hids.rules.alpha\n\n# name: 坏规则\n\ndefault match := false\n\nmatch if {\n  input.type =~ "x"\n}\n`;
  await assert.rejects(store.save('alpha', broken), /不支持的表达式/);
  await assert.rejects(store.save('alpha', ''), /规则正文为空/);
  await assert.rejects(store.save('Alpha', rule('alpha')), /规则 id 不合法/);
  await assert.rejects(store.save('beta', rule('alpha')), /package 与规则 id 不一致/);
  assert.equal((await store.read('alpha')).rego, rule('alpha', 'input.type == "a"'));
  assert.deepEqual(await store.history('alpha'), []);
  assert.deepEqual((await readdir(directory)).sort(), ['alpha.rego']);
  assert.equal(await readdir(historyDirectory).then(names => names.length).catch(cause => {
    if (cause.code === 'ENOENT') return 0;
    throw cause;
  }), 0);
});

test('A4 维护会话留痕：一份一份落盘、按 updated_at 倒序列摘要、列表不带规则正文', async t => {
  const root = await tempRoot(t);
  const sessions = new RuleSessionStore(path.join(root, 'rule-sessions'));
  const base = { case_id: 'honeypot:7', case_dir: '/data/cases/honeypot/7', event_type: 'honeypot',
    reason: '蜜罐背景扫描被误判', who: '值守' };
  const first = await sessions.save({ id: '11111111-1111-1111-1111-111111111111', ...base, status: 'collecting',
    created_at: '2026-11-19T00:00:00.000Z', updated_at: '2026-11-19T00:00:00.000Z', proposal: null, validation: null });
  const second = await sessions.save({ id: '22222222-2222-2222-2222-222222222222', ...base, case_id: 'webshell:8',
    status: 'updated', created_at: '2026-11-19T01:00:00.000Z', updated_at: '2026-11-19T01:00:00.000Z',
    proposal: { id: 'webshell_drop', rego: rule('webshell_drop'), rationale: '放宽来源判断' },
    validation: { ok: true, rev: ruleRevision(rule('webshell_drop')) } });

  assert.deepEqual(await sessions.get(first.id), first);
  assert.deepEqual(await sessions.get('33333333-3333-3333-3333-333333333333'), null);
  const listed = await sessions.list();
  assert.deepEqual(listed.map(row => row.id), [second.id, first.id]);
  assert.deepEqual(listed[0], { id: second.id, case_id: 'webshell:8', event_type: 'honeypot', who: '值守',
    status: 'updated', rule_id: 'webshell_drop', validated: true, updated_at: '2026-11-19T01:00:00.000Z' });
  assert.equal(JSON.stringify(listed).includes('package hids.rules'), false, '摘要里把规则正文也带出来了');
  await assert.rejects(sessions.save({ id: '../../escape' }), /会话 ID 无效/);
  await assert.rejects(sessions.get('not-a-uuid'), /会话 ID 无效/);
});

test('A4 会话目录不存在时列表回空数组，不抛错（第一次维护之前）', async t => {
  const root = await tempRoot(t);
  assert.deepEqual(await new RuleSessionStore(path.join(root, 'none')).list(), []);
});
