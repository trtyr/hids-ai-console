import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuleSessionStore, RuleStore, ruleHistoryDirectory, ruleLibraryDirectory, ruleRevision,
  ruleSessionsDirectory, seedLibrary } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';

// P003-T041：规则库外置（A1/A2）、版本化（A3）、维护会话（A4）的单元钉子。
// 全部在临时目录里跑：种子的「数据根」也注入 tmp，不写真实全局根。

const rule = (id, expression = 'input.type == "x"', name = `规则 ${id}`) =>
  `package hids.rules.${id}\n\n# name: ${name}\n\ndefault match := false\n\nmatch if {\n  ${expression}\n}\n`;

// 临时「数据根」：造一个与仓内 rules/ 同形的种子源，再用 withDataRoot 把 dataRoot() 引到它上面。
async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-rule-lib-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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

// ── 复审轮（openapi 承诺的备注 + 并发写）────────────────────────────────────
test('A3 备注落进历史条目：note 存在 <id>-<rev>.json，history() 逐条回读；同版再归档保留首次备注', async t => {
  const { store, historyDirectory } = await injected(t);
  const v1 = rule('alpha', 'input.type == "a"');
  const v2 = rule('alpha', 'input.type == "b"');
  const v3 = rule('alpha', 'input.type == "c"');
  await store.save('alpha', v1);
  await store.save('alpha', v2, { note: '人工维护：排除运维探针来源' });

  const rows = await store.history('alpha');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, '人工维护：排除运维探针来源', 'note 没落进历史条目（openapi 承诺的备注不存在）');
  const sidecar = JSON.parse(await readFile(path.join(historyDirectory, `alpha-${rows[0].rev}.json`), 'utf8'));
  assert.equal(sidecar.id, 'alpha');
  assert.equal(sidecar.rev, ruleRevision(v1));
  assert.equal(sidecar.note, '人工维护：排除运维探针来源');
  assert.equal(sidecar.replaced_by, ruleRevision(v2), '备注没记「被哪一版替换」');
  assert.match(sidecar.saved_at, /^\d{4}-\d{2}-\d{2}T/);
  // 历史正文仍是逐字原文：备注单独一个文件，不许混进 .rego。
  assert.equal(await readFile(path.join(historyDirectory, rows[0].file), 'utf8'), v1);

  // 回滚本身也是一次写：它把当前版（二版）归档，备注是调用方给的那句。
  await store.rollback('alpha', ruleRevision(v1), { note: '人工回滚（值班主任）' });
  const after = await store.history('alpha');
  const archived = after.find(row => row.rev === ruleRevision(v2));
  assert.equal(archived?.note, '人工回滚（值班主任）', '回滚的 who 没写进被归档那一版的历史备注');

  // 同一版被归档第二次（回滚回去又改回三版）：副本与备注都保留第一次的。
  await store.save('alpha', v3, { note: '人工维护：第三次' });
  await store.rollback('alpha', ruleRevision(v1), { note: '人工回滚（第二人）' });
  const again = await store.history('alpha');
  assert.equal(again.filter(row => row.rev === ruleRevision(v1))[0].note, '人工维护：排除运维探针来源',
    '同一版被归档第二次时备注被覆盖，先前那条说明就丢了');
});

test('A3 没有备注的归档与旧历史副本都回 note:null，不让一条坏备注拖垮整页历史', async t => {
  const { store, historyDirectory } = await injected(t);
  await store.save('beta', rule('beta', 'input.type == "a"'));
  await store.save('beta', rule('beta', 'input.type == "b"'));
  const [bare] = await store.history('beta');
  assert.equal(bare.note, null);

  // 本卡之前留下的旧历史副本：只有 .rego，没有 sidecar。
  const legacy = 'a'.repeat(16);
  await writeFile(path.join(historyDirectory, `beta-${legacy}.rego`), rule('beta'));
  // 手改坏掉的 sidecar：当没有备注，不是 502。
  await writeFile(path.join(historyDirectory, `beta-${legacy}.json`), '{ 半截');
  const rows = await store.history('beta');
  assert.equal(rows.find(row => row.rev === legacy)?.note, null, '坏备注把整个历史接口拖红了');
  assert.equal(rows.length, 2);
});

test('A5 并发改同一条规则：同版本的两个写入只成一个，另一个 409，先写的不会被后写的盖掉', async t => {
  const { store } = await injected(t);
  const v1 = rule('alpha', 'input.type == "a"');
  const rev1 = ruleRevision(v1);
  await store.save('alpha', v1);
  const results = await Promise.allSettled([
    store.save('alpha', rule('alpha', 'input.type == "left"'), { note: '甲', expectedRevision: rev1 }),
    store.save('alpha', rule('alpha', 'input.type == "right"'), { note: '乙', expectedRevision: rev1 })
  ]);
  const won = results.filter(result => result.status === 'fulfilled');
  const lost = results.filter(result => result.status === 'rejected');
  assert.equal(won.length, 1, '并发两个同版本写入都落盘了（后写的会悄悄盖前一份）');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.status, 409);
  assert.equal((await store.read('alpha')).revision, won[0].value.rev, '落盘的正文不是「赢的那个」');
  assert.equal((await store.history('alpha')).length, 1, '并发写把历史灌了多份');
  assert.equal((await store.history('alpha'))[0].note, won[0].value.rev === ruleRevision(rule('alpha', 'input.type == "left"'))
    ? '甲' : '乙');

  // 并发的两次「新增同一条」：expected_revision 都是 null，只许一个 add。
  const adds = await Promise.allSettled([
    store.save('delta', rule('delta', 'input.type == "x"'), { expectedRevision: null }),
    store.save('delta', rule('delta', 'input.type == "y"'), { expectedRevision: null })
  ]);
  assert.deepEqual(adds.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(adds.find(result => result.status === 'rejected').reason.status, 409);
});

test('A1 注入目录的历史跟目录走：同级 `.data/rules-history`，不往真实数据根写', async t => {
  const root = await tempRoot(t);
  const directory = path.join(root, 'deploy', 'rules');
  await mkdir(directory, { recursive: true });
  const store = new RuleStore(directory); // 不传 historyDirectory：缺省值要跟目录走
  assert.equal(store.historyDirectory, path.join(root, 'deploy', '.data', 'rules-history'),
    '注入目录的历史仍写全局数据根（与 wiki 的同级 .data 先例相反）');
  const v1 = rule('alpha', 'input.type == "a"');
  await store.save('alpha', v1);
  await store.save('alpha', rule('alpha', 'input.type == "b"'));
  assert.deepEqual((await readdir(store.historyDirectory)).sort(),
    [`alpha-${ruleRevision(v1)}.json`, `alpha-${ruleRevision(v1)}.rego`]);
});
