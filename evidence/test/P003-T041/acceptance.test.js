// 全局根隔离（P003-T050 A2）：本文件触发写接口 → 产生审计事件（P003-T062），必须先隔离数据根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegoRuleMaintainer, createServer } from '../../../server.js';
import { RuleSessionStore, RuleStore, ruleRevision } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';
import { WikiStore } from '../../../src/contexts/knowledge/infrastructure/wiki-store.js';

// P003-T041 验收替身（A1/A2/A4/A5/A6/A8）：起真 createServer、注入临时库，
// 按「维护者改一条规则 → 外置库变更 → 历史有副本 → 回滚生效」整条链验一遍，另验种子只初始化一次。
// 全部落临时目录：不写真实全局根，也不碰仓内 `rules/` 与 `wiki/`（本文件自己就钉这一点）。
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RULE_TOKEN = 'test-rule-token';

function rego(id, expression, name = `规则 ${id}`) {
  return `package hids.rules.${id}\n\n# name: ${name}\n\ndefault match := false\n\nmatch if {\n  ${expression}\n}\n`;
}

async function root(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t041-accept-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

async function withDataRoot(t, value) {
  const previous = process.env.HIDS_DATA_DIR;
  process.env.HIDS_DATA_DIR = value;
  t.after(() => {
    if (previous === undefined) delete process.env.HIDS_DATA_DIR;
    else process.env.HIDS_DATA_DIR = previous;
  });
}

// 外置规则库：数据根下的 rules/ + rules-history/ + rule-sessions/（与缺省布局同形，但由本测试注入）
async function rulesFixture(t) {
  const base = await root(t);
  const data = path.join(base, 'data');
  const rules = path.join(data, 'rules');
  const history = path.join(data, 'rules-history');
  const sessions = path.join(data, 'rule-sessions');
  await mkdir(rules, { recursive: true });
  await writeFile(path.join(rules, 'honeypot_probe.rego'), rego('honeypot_probe', 'input.type == "honeypot"', '蜜罐诱捕'));
  return { base, data, rules, history, sessions,
    ruleStore: new RuleStore(rules, { historyDirectory: history, seedFrom: null }),
    ruleSessions: new RuleSessionStore(sessions) };
}

async function wikiFixture(t) {
  const base = await root(t);
  const directory = path.join(base, 'wiki');
  await mkdir(path.join(directory, 'honeypot'), { recursive: true });
  await writeFile(path.join(directory, 'log.md'), '# 日志\n');
  await writeFile(path.join(directory, 'honeypot', 'HP-01.md'),
    '---\nid: HP-01\ntitle: 蜜罐背景扫描\nstatus: active\nsource: ENISA\n---\n\n外网背景扫描需要核对请求。\n');
  return { base, directory, wiki: new WikiStore(directory) };
}

async function serve(t, { ruleStore, ruleSessions, wiki, token = RULE_TOKEN, promptToken = 'prompt-token' } = {}) {
  // token: null 用来验「没配规则管理员令牌」——undefined 会掉进形参缺省值，测不出 503。
  const server = createServer(null, null, null, null, undefined, null, null, {}, null, promptToken,
    wiki, undefined, undefined, token, ruleStore, undefined, undefined, ruleSessions);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const ruleHeaders = token => ({ 'x-rule-admin-token': token, 'content-type': 'application/json' });

// ── A5：维护接口正式化 ──────────────────────────────────────────────────────
test('A5 规则维护接口：列表 / 读 / 改 / 历史 / 回滚，写操作要规则管理员令牌', async t => {
  const { ruleStore, ruleSessions } = await rulesFixture(t);
  const base = await serve(t, { ruleStore, ruleSessions, wiki: (await wikiFixture(t)).wiki });

  const listed = await (await fetch(`${base}/api/rules`)).json();
  assert.deepEqual(listed.rules.map(item => item.id), ['honeypot_probe']);
  const read = await (await fetch(`${base}/api/rules/honeypot_probe`)).json();
  assert.equal(read.revision, ruleRevision(read.rego), '读接口没给出当前版本指纹，人工改就没法做乐观并发');

  const next = rego('honeypot_probe', 'input.type == "honeypot"\n  not input.source_ip == "64.177.57.21"', '蜜罐诱捕');
  const noToken = await fetch(`${base}/api/rules/honeypot_probe`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rego: next, expected_revision: read.revision }) });
  assert.equal(noToken.status, 403, '没有规则管理员令牌也能改规则');

  const saved = await (await fetch(`${base}/api/rules/honeypot_probe`, { method: 'PUT', headers: ruleHeaders(RULE_TOKEN),
    body: JSON.stringify({ rego: next, expected_revision: read.revision, note: '排除运维探针来源' }) })).json();
  assert.equal(saved.action, 'update');
  assert.equal(saved.previous_rev, read.revision, '改完没把旧版版本号回给调用方');
  assert.equal(await readFile(path.join(ruleStore.directory, 'honeypot_probe.rego'), 'utf8'), next);

  const stale = await fetch(`${base}/api/rules/honeypot_probe`, { method: 'PUT', headers: ruleHeaders(RULE_TOKEN),
    body: JSON.stringify({ rego: next, expected_revision: read.revision }) });
  assert.equal(stale.status, 409, '版本过期的写没被拦下（会悄悄盖掉别人刚写的那份）');
  const missing = await fetch(`${base}/api/rules/honeypot_probe`, { method: 'PUT', headers: ruleHeaders(RULE_TOKEN),
    body: JSON.stringify({ rego: next }) });
  assert.equal(missing.status, 400);

  const history = await (await fetch(`${base}/api/rules/honeypot_probe/history`)).json();
  assert.deepEqual(history.history.map(row => row.rev), [read.revision]);
  assert.equal(history.history[0].note, '人工维护：排除运维探针来源',
    'PUT 的 note 没写进历史备注（openapi 承诺的行为不存在）');

  const broken = await fetch(`${base}/api/rules/honeypot_probe`, { method: 'PUT', headers: ruleHeaders(RULE_TOKEN),
    body: JSON.stringify({ rego: rego('honeypot_probe', 'input.host =~ "10.*"'), expected_revision: saved.rev }) });
  assert.equal(broken.status, 400, '规则子集外的语法没被当成调用方错误（会回 500）');
  assert.match((await broken.json()).error, /honeypot_probe\.rego:\d+/);

  const rolled = await (await fetch(`${base}/api/rules/honeypot_probe/rollback`, { method: 'POST',
    headers: ruleHeaders(RULE_TOKEN), body: JSON.stringify({ rev: read.revision, who: '值班主任' }) })).json();
  assert.equal(rolled.action, 'rollback');
  assert.equal((await (await fetch(`${base}/api/rules/honeypot_probe`)).json()).rego, read.rego, '回滚没有恢复原正文');
  const after = await (await fetch(`${base}/api/rules/honeypot_probe/history`)).json();
  assert.equal(after.history.length, 2, '回滚本身那一版没进历史，回滚就不可逆了');
  assert.equal(after.history.find(row => row.rev === saved.rev)?.note, '人工回滚（值班主任）',
    '回滚接口的 who 没写进被归档那一版的历史备注');

  const badRev = await fetch(`${base}/api/rules/honeypot_probe/rollback`, { method: 'POST',
    headers: ruleHeaders(RULE_TOKEN), body: JSON.stringify({ rev: '0'.repeat(16) }) });
  assert.equal(badRev.status, 404);
});

test('A5 并发 PUT 同一条规则：同一个 expected_revision 只成一个，另一个 409，不许后写盖前写', async t => {
  const { ruleStore, ruleSessions } = await rulesFixture(t);
  const base = await serve(t, { ruleStore, ruleSessions, wiki: (await wikiFixture(t)).wiki });
  const current = await (await fetch(`${base}/api/rules/honeypot_probe`)).json();
  const put = source => fetch(`${base}/api/rules/honeypot_probe`, { method: 'PUT', headers: ruleHeaders(RULE_TOKEN),
    body: JSON.stringify({ rego: source, expected_revision: current.revision }) });
  const [left, right] = await Promise.all([
    put(rego('honeypot_probe', 'input.type == "left"', '蜜罐诱捕')),
    put(rego('honeypot_probe', 'input.type == "right"', '蜜罐诱捕'))
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409],
    '并发两个 PUT 都成功了：一个是拿旧版本盖掉了另一个刚写的正文');
  const winner = left.status === 200 ? await left.json() : await right.json();
  assert.equal((await (await fetch(`${base}/api/rules/honeypot_probe`)).json()).revision, winner.rev,
    '落盘的正文不是「赢的那个」');
  const history = await (await fetch(`${base}/api/rules/honeypot_probe/history`)).json();
  assert.equal(history.history.length, 1, '并发写把历史刷了多份');
});

test('A5 没配规则管理员令牌时写接口 503；`sessions` 路由不被 /api/rules/{id} 抢走', async t => {
  const { ruleStore, ruleSessions } = await rulesFixture(t);
  const wiki = (await wikiFixture(t)).wiki;
  await ruleStore.save('sessions', rego('sessions', 'input.type == "x"')); // 规则 id 叫 sessions 也合法
  const base = await serve(t, { ruleStore, ruleSessions, wiki });
  const listed = await (await fetch(`${base}/api/rules/sessions`)).json();
  assert.ok(Array.isArray(listed.sessions), '`/api/rules/sessions` 被当成规则读走了');

  const open = await serve(t, { ruleStore, ruleSessions, wiki, token: null });
  const refused = await fetch(`${open}/api/rules/honeypot_probe`, { method: 'PUT', headers: ruleHeaders('anything'),
    body: JSON.stringify({ rego: rego('honeypot_probe', 'input.type == "honeypot"'), expected_revision: null }) });
  assert.equal(refused.status, 503, '没配令牌时写接口应回 503（配置缺失），而不是放行或 403');
});

// ── A4：维护会话留痕 ────────────────────────────────────────────────────────
test('A4 维护者改一条规则：草案 / 校验结果 / 终态都落进 rule-sessions，写盘走的是同一个 RuleStore', async t => {
  const { rules, ruleStore, ruleSessions } = await rulesFixture(t);
  const next = rego('honeypot_probe', 'input.type == "honeypot"\n  not input.source_ip == "64.177.57.21"', '蜜罐诱捕');
  const maintainer = new RegoRuleMaintainer({ complete: async () => ({ content: JSON.stringify({ ready: true,
    id: 'honeypot_probe', name: '蜜罐诱捕', reason: '运维探针来源已核对授权清单', rego: next }) }) },
    ruleStore, { load: async () => ({ prompts: { rule: '维护 Rego 规则' } }) }, ruleSessions);

  const result = await maintainer.maintain({ caseId: 'honeypot:7', caseDir: '/data/cases/honeypot/7',
    eventType: 'honeypot', reason: '蜜罐背景扫描被误判', who: '值守',
    alert: { msgid: 'cloudwalker-honeypot', payload: { source_ip: '64.177.57.21' } }, ruleIds: ['honeypot_probe'] });
  assert.deepEqual(result, { id: 'honeypot_probe', file: 'honeypot_probe.rego', name: '蜜罐诱捕',
    action: 'update', rationale: '运维探针来源已核对授权清单' });
  assert.equal(await readFile(path.join(rules, 'honeypot_probe.rego'), 'utf8'), next, '维护者没写进外置库');

  const sessions = await ruleSessions.list();
  assert.equal(sessions.length, 1);
  const [summary] = sessions;
  assert.equal(summary.case_id, 'honeypot:7');
  assert.equal(summary.status, 'updated');
  assert.equal(summary.rule_id, 'honeypot_probe');
  assert.equal(summary.validated, true);
  const record = await ruleSessions.get(summary.id);
  assert.equal(record.case_dir, '/data/cases/honeypot/7', '会话里没记案卷引用');
  assert.equal(record.proposal.rego, next, '会话里没记模型草案');
  assert.equal(record.validation.ok, true);
  assert.equal(record.result.action, 'update');
  assert.equal(record.result.rev, ruleRevision(next));
  const history = await ruleStore.history('honeypot_probe');
  assert.deepEqual(history.map(row => row.rev), [record.result.previous_rev], '改规则后旧版没进历史');
  assert.equal(await readFile(path.join(ruleStore.historyDirectory, history[0].file), 'utf8'),
    rego('honeypot_probe', 'input.type == "honeypot"', '蜜罐诱捕'));
});

test('A4 维护失败也留痕：校验没过 → 会话终态 failed，带原因，库里一个字没变', async t => {
  const { ruleStore, ruleSessions, rules } = await rulesFixture(t);
  const before = await readFile(path.join(rules, 'honeypot_probe.rego'), 'utf8');
  const maintainer = new RegoRuleMaintainer({ complete: async () => ({ content: JSON.stringify({ ready: true,
    id: 'honeypot_probe', name: '蜜罐诱捕', reason: '放宽', rego: rego('honeypot_probe', 'input.type == "x"') }) }) },
    ruleStore, { load: async () => ({ prompts: { rule: '维护 Rego 规则' } }) }, ruleSessions);

  await assert.rejects(() => maintainer.maintain({ caseId: 'honeypot:8', caseDir: '/data/cases/honeypot/8',
    eventType: 'honeypot', reason: '放宽条件', who: '值守', alert: null, ruleIds: ['honeypot_probe'] }),
  /放宽了原有限制条件/);
  const [summary] = await ruleSessions.list();
  assert.equal(summary.status, 'failed');
  assert.equal(summary.validated, false);
  const record = await ruleSessions.get(summary.id);
  assert.match(record.error, /放宽了原有限制条件/);
  assert.equal(record.proposal.id, 'honeypot_probe', '失败会话里也要看得见模型当时提了什么');
  assert.equal(await readFile(path.join(rules, 'honeypot_probe.rego'), 'utf8'), before);
});

// ── A1/A2/A8：外置库 + 种子只初始化一次 ──────────────────────────────────────
test('A8 替身全链：维护者改一条 → 外置库变更 → 历史有副本 → 回滚生效；仓内 rules/ 一个字节没动', async t => {
  const base = await root(t);
  const dataRootDir = path.join(base, 'data-root');
  await withDataRoot(t, dataRootDir);
  // 仓内副本的「指纹」：文件名 + 内容摘要。只比文件名抓不到原地改写，所以连内容一起钉。
  const digestOf = async directory => {
    const rows = [];
    for (const name of (await readdir(directory, { recursive: true })).sort()) {
      const full = path.join(directory, name);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) continue;
      rows.push(`${name}:${createHash('sha256').update(await readFile(full)).digest('hex')}`);
    }
    return rows;
  };
  const repoRulesBefore = await digestOf(path.join(repository, 'rules'));
  const repoWikiBefore = await digestOf(path.join(repository, 'wiki'));

  // 缺省 RuleStore：数据根里没有库 → 从仓内 rules/ 种一次
  const store = new RuleStore();
  const seeded = await store.list();
  assert.ok(seeded.count >= 3);
  assert.equal(store.directory, path.join(dataRootDir, 'rules'));

  // 收紧：原条件一条不少，只多一条 `not`（放宽校验会拦住真放宽，这里不能踩它）
  const tightened = rego('honeypot_probe', 'input.type == "honeypot"\n  input.peer != ""\n  input.source_ip != ""' +
    '\n  input.user == "root"\n  not contains(input.command, "healthcheck")', '蜜罐探测（排除健康检查）');
  const maintainer = new RegoRuleMaintainer({ complete: async () => ({ content: JSON.stringify({ ready: true,
    id: 'honeypot_probe', name: '蜜罐探测（排除健康检查）', reason: '健康检查误触发', rego: tightened }) }) },
    store, { load: async () => ({ prompts: { rule: '维护 Rego 规则' } }) }, new RuleSessionStore());

  await maintainer.maintain({ caseId: 'honeypot:9', caseDir: '/data/cases/honeypot/9',
    eventType: 'honeypot', reason: '健康检查误触发', who: '值守', alert: null, ruleIds: ['honeypot_probe'] });
  assert.match(await readFile(path.join(dataRootDir, 'rules', 'honeypot_probe.rego'), 'utf8'), /not contains/,
    '维护者没写进数据根规则库');
  const older = await store.history('honeypot_probe');
  assert.equal(older.length, 1, '旧版没进 <数据根>/rules-history/');
  assert.equal(older[0].file, `honeypot_probe-${older[0].rev}.rego`);
  assert.match(await readFile(path.join(dataRootDir, 'rules-history', older[0].file), 'utf8'), /input.user == "root"/);

  const rolled = await store.rollback('honeypot_probe', older[0].rev, { note: '替身回滚' });
  assert.equal(rolled.action, 'rollback');
  assert.doesNotMatch(await readFile(path.join(dataRootDir, 'rules', 'honeypot_probe.rego'), 'utf8'), /not contains/,
    '回滚没生效');

  // 二次启动（新实例）不重复初始化：数据根库已存在，仓库副本不再参与
  const again = await new RuleStore().list();
  assert.equal(again.count, seeded.count);
  assert.deepEqual(await digestOf(path.join(repository, 'rules')), repoRulesBefore, '仓内 rules/ 被运行期写动了');
  assert.deepEqual(await digestOf(path.join(repository, 'wiki')), repoWikiBefore, '仓内 wiki/ 被运行期写动了');
});

test('A8 判据库同一条口径：数据根无库时种子一次，二次启动不重种，仓内 wiki/ 不被写', async t => {
  const base = await root(t);
  const dataRootDir = path.join(base, 'data-root');
  const previous = process.env.HIDS_DATA_DIR;
  process.env.HIDS_DATA_DIR = dataRootDir;
  t.after(() => {
    if (previous === undefined) delete process.env.HIDS_DATA_DIR;
    else process.env.HIDS_DATA_DIR = previous;
  });
  // 缺省目录在模块加载时定：带 query 拿一份新实例，才认得出新的数据根（与 P003-T034 测试同一手法）
  const first = await import(`../../../src/contexts/knowledge/infrastructure/wiki-store.js?seed=${Date.now()}`);
  const store = new first.WikiStore();
  assert.equal(store.directory, path.join(dataRootDir, 'wiki'));
  const listed = await store.list();
  assert.ok(listed.length > 0, '数据根判据库没种子');
  assert.ok(listed.some(page => page.id === 'HP-10'));

  // 在数据根库上改一页：下一份实例（＝下一次启动）读到的必须是改过的，不能被仓库副本盖回
  const page = await store.get('honeypot/HP-10.md');
  await store.update('honeypot/HP-10.md', page.content.replace('蜜罐', '蜜罐（外置库改过）'), page.revision);
  const second = await import(`../../../src/contexts/knowledge/infrastructure/wiki-store.js?seed2=${Date.now()}`);
  const reopened = new second.WikiStore();
  assert.match((await reopened.get('honeypot/HP-10.md')).content, /外置库改过/, '二次启动把仓库副本盖回去了');
  assert.equal((await reopened.list()).length, listed.length);

  // SOP 也读这本库（A6）：提示词装载看得到外置库的改动。
  // `prompt-store.js` 的库目录同样是模块加载时定的，所以带 query 取一份新实例。
  const freshPrompts = await import(`../../../src/contexts/knowledge/infrastructure/prompt-store.js?sop=${Date.now()}`);
  const prompts = await new freshPrompts.PromptStore(path.join(base, 'no-overrides.json')).load();
  assert.match(prompts.sop.honeypot, /外置库改过/, 'SOP 还在读仓内 wiki/ 副本');
});

// ── A6：知识库接口沿用 sessions/publish，写路径落外置库 ──────────────────────
test('A6 知识库页面写入落外置库并留历史，接口形状不变（沿用 pages 读写）', async t => {
  const { directory, wiki } = await wikiFixture(t);
  const base = await serve(t, { ruleStore: new RuleStore(path.join(directory, '..', 'rules'), { seedFrom: null }),
    ruleSessions: new RuleSessionStore(path.join(directory, '..', 'rule-sessions')), wiki });
  const pagePath = `${base}/api/wiki/pages/honeypot%2FHP-01.md`;
  const before = await (await fetch(pagePath)).json();
  const next = before.content.replace('需要核对', '必须核对');
  const saved = await (await fetch(pagePath, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: next, expected_revision: before.revision }) })).json();
  assert.notEqual(saved.revision, before.revision);
  assert.equal(await readFile(path.join(directory, 'honeypot', 'HP-01.md'), 'utf8'), next, '写路径没落外置库');
  const history = await readdir(wiki.historyDirectory);
  assert.ok(history.includes(`HP-01-${before.revision}.md`), '旧版没进外置库的历史目录');
  assert.match(await readFile(path.join(directory, 'log.md'), 'utf8'), /update \| HP-01/, '外置库的 log.md 没记账');
});
