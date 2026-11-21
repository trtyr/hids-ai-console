// P003-T013 后端验收（黑盒 / e2e）：只按 docs/modules/http-api.md §3.4 与 §8、
// openapi.yaml 的 reportFalsePositive / FalsePositiveRecord / CaseMaintenance / FalsePositiveFeedback、
// docs/modules/knowledge-base.md §4.2/§4.3、docs/modules/triage-pipeline.md §6/§7 写断言。
// 未读 server.js / triage-monitor.js / rule-store.js / wiki-*.js 的实现内容；
// 注入点只用文档写明的 createServer 依赖注入（http-api.md §2）与公开类/方法。
//
// 「分析时引用过的判据页」在夹具里写两处同值：result.json 的 trace（运行时形状，
// investigation-agent.js:536）与 verdict.wiki.consulted（结论字段，investigation-agent.md 3.8）。
// A3 专设一条用例让引用页（HP-11）不等于本场景第一页（HP-10），选页分支一断就红。
//
// 跑法（仓根，只跑这一个文件）：
//   timeout 180 node --test --test-reporter=tap evidence/test/P003-T013/acceptance.test.js
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js 求值前把 HIDS_DATA_DIR
// 指到本进程的临时根，否则模块级缺省库（fp-sessions/wiki/rules）会落进 ~/.local/share/hids-ai-console。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, RegoRuleMaintainer } from '../../../server.js';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';
import { RuleStore } from '../../../rule-store.js';
import { WikiStore } from '../../../wiki-store.js';
import { WikiWorkbench } from '../../../wiki-workbench.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const FP_PATH = id => `/api/agent/triage/${encodeURIComponent(id)}/false-positive`;
const GET_PATH = id => `/api/agent/triage/${encodeURIComponent(id)}`;
const REASON = '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单';
const WHO = '值班分析员';

// 合法 syslog 形态 triage id（docs http-api.md §3.3：syslog:<类型>:<16 位十六进制>:<数字或 unknown>:<36 位 UUID>）
const syslogId = (fp, sec, uuid) => `syslog:honeypot:${fp}:${sec}:${uuid}`;
const A_ID = syslogId('0123456789abcdef', '1763373600', '6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43');
const B_ID = syslogId('fedcba9876543210', '1763373700', '7a2c7b5f-5e4b-4c9f-bb5f-3a7f2c6d8e91');
const C_ID = syslogId('aaaabbbbccccdddd', '1763373800', '22222222-2222-4222-8222-222222222222');
const D_ID = syslogId('9999888877776666', '1763373900', '33333333-3333-4333-8333-333333333333');

const HONEYPOT_UPDATED = `package hids.rules.honeypot_probe

# name: 蜜罐探测（root 用户）
# description: 蜜罐类型告警，对端与来源 IP 都非空、用户为 root 的探测

default match := false

match if {
  input.type == "honeypot"
  input.peer != ""
  input.source_ip != ""
  input.user == "root"
  input.source_ip != "203.0.113.9"
}
`;
const NEW_RULE = `package hids.rules.ops_probe_allow

# name: 运维探针放行
# description: 已知授权扫描来源的蜜罐触碰

default match := false

match if {
  input.type == "honeypot"
  input.source_ip == "203.0.113.9"
}
`;
const BAD_SUBSET_REGO = `package hids.rules.honeypot_probe

# name: 坏规则

default match := false

match if {
  input.host =~ "10\\..*"
}
`;

const RULE_PROMPT_MARK = '【本卡验收标记】规则维护提示';
const WIKI_PROMPT_MARK = '【本卡验收标记】知识维护提示';

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

/* ---------------- 装置 ---------------- */

async function makeCase(base, id, { cited = 'HP-10', verdict = {} } = {}) {
  const caseDir = path.join(base, 'cases', id.replace(/[:]/g, '_'));
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '01-原始告警.txt'),
    `<134>1 2026-11-18T10:00:00Z host app - cloudwalker-honeypot event_id=7 host_ip=10.0.0.5 source_ip=203.0.113.9 event_create_time="2026-11-18 10:00:00"\n`);
  await writeFile(path.join(caseDir, '03-研判事实.md'),
    '# 研判事实\n\n主机 IP：10.0.0.5\n事件时间：2026-11-18 10:00:00\n来源：203.0.113.9\n');
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify({
    alert_id: id,
    mode: 'triage',
    trace: [{ kind: 'wiki', action: 'page', id: cited }],
    verdict: {
      verdict: 'threat', verdict_label: '真实威胁',
      rego: { status: 'matched', rule_ids: ['honeypot_probe'] },
      wiki: { consulted: [cited], adopted: [], reason: '' },
      ...verdict
    }
  }));
  return caseDir;
}

function doneRecord(id, caseDir, extra = {}) {
  return {
    alert_id: id,
    status: 'done',
    verdict: 'threat',
    verdict_label: '真实威胁',
    decision_source: 'ai',
    case_dir: caseDir,
    input: {
      raw: 'raw-line',
      parsed: {
        msgid: 'cloudwalker-honeypot',
        ts: '2026-11-18T10:00:00Z',
        payload: { event_id: 7, host_ip: '10.0.0.5', source_ip: '203.0.113.9', event_create_time: '2026-11-18 10:00:00' }
      }
    },
    ...extra
  };
}

async function fileMap(dir) {
  const out = new Map();
  for (const name of (await readdir(dir)).sort()) {
    if (name.startsWith('.')) continue;
    out.set(name, await readFile(path.join(dir, name), 'utf8'));
  }
  return out;
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(base, method, p, body, rawBody) {
  const init = { method, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (rawBody !== undefined) init.body = rawBody;
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留 text */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitFor(fn, what, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
}

const assertErrorShape = (res, status) => {
  assert.equal(res.status, status, res.text);
  assert.ok(res.json && typeof res.json === 'object', `错误响应不是 JSON 对象：${res.text}`);
  assert.equal(typeof res.json.error, 'string', `错误响应缺 {error:string}：${res.text}`);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
};

// openapi.yaml FalsePositiveRecord（additionalProperties:false）+ FalsePositiveFeedback + CaseMaintenance
function assertFalsePositiveRecord(body) {
  assert.deepEqual(Object.keys(body).sort(), ['alert_id', 'feedback', 'maintenance', 'verdict'],
    `FalsePositiveRecord 顶层键不符：${JSON.stringify(body)}`);
  assert.equal(typeof body.alert_id, 'string');
  assert.equal(body.verdict.verdict, 'false_positive');
  assert.equal(body.verdict.verdict_label, '误报');
  assert.equal(body.verdict.source, 'human');
  for (const key of ['reason', 'who', 'recorded_at']) assert.ok(key in body.feedback, `feedback 缺 ${key}`);
  assert.equal(typeof body.feedback.reason, 'string');
  assert.equal(typeof body.feedback.who, 'string');
  assert.ok(!Number.isNaN(Date.parse(body.feedback.recorded_at)), 'feedback.recorded_at 不是日期时间');
  assert.ok(['updating', 'updated', 'failed'].includes(body.maintenance.status), `维护总态越界：${body.maintenance.status}`);
  for (const side of ['rule', 'wiki']) {
    assert.ok(['updating', 'updated', 'failed'].includes(body.maintenance[side].status),
      `maintenance.${side}.status 越界：${body.maintenance[side].status}`);
  }
}

/**
 * 一套「真 HTTP + 真 TriageMonitor + 真 RuleStore/WikiStore + 真两个维护者类」的台子。
 * 只把**外部模型**换成本地假模型；两个维护者的校验、写盘、状态机全部走生产实现。
 */
async function stack({ ruleMode = 'update', wikiMode = 'ok', seed = [], gated = false,
  cited = 'HP-10', extraWikiPage = null } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'p003-t013-'));
  await cp(path.join(repoRoot, 'wiki'), path.join(base, 'wiki'), { recursive: true });
  await cp(path.join(repoRoot, 'rules'), path.join(base, 'rules'), { recursive: true });
  const wikiDir = path.join(base, 'wiki');
  const rulesDir = path.join(base, 'rules');
  const sessionsDir = path.join(base, 'wiki-sessions');

  // 造一页额外的 active 判据，让「分析时引用过的页」与「本场景第一页」不是同一页
  if (extraWikiPage) {
    const template = await readFile(path.join(wikiDir, 'honeypot', 'HP-10.md'), 'utf8');
    const content = template
      .replace(/^id: .*$/m, `id: ${extraWikiPage.id}`)
      .replace(/^title: .*$/m, `title: ${extraWikiPage.title}`);
    await writeFile(path.join(wikiDir, 'honeypot', `${extraWikiPage.id}.md`), content);
  }

  const cases = new Map();
  for (const item of seed) {
    if (item.case !== false) cases.set(item.id, await makeCase(base, item.id, { cited: item.cited || cited }));
  }

  const monitorFile = path.join(base, 'triage-monitor.json');
  const monitor = new TriageMonitor({
    service: {}, investigator: {}, history: {},
    file: monitorFile, inputMode: 'syslog', casesDirectory: path.join(base, 'cases')
  });
  for (const item of seed) {
    monitor.records.set(item.id, { ...doneRecord(item.id, cases.get(item.id) || path.join(base, 'cases', 'none')), ...(item.record || {}) });
  }
  await monitor.persist();

  const wiki = new WikiStore(wikiDir);
  const ruleStore = new RuleStore(rulesDir);
  const pagesBefore = new Map((await wiki.list()).map(p => [p.path, p]));

  let releaseGate;
  const gate = gated ? new Promise(resolve => { releaseGate = resolve; }) : Promise.resolve();
  const ruleCalls = [];
  const wikiCalls = [];

  const ruleModel = {
    complete: async messages => {
      ruleCalls.push(messages);
      await gate;
      if (ruleMode === 'invalid') {
        return { content: JSON.stringify({ ready: true, id: 'honeypot_probe', name: '蜜罐诱捕', reason: '收紧条件', rego: BAD_SUBSET_REGO }) };
      }
      if (ruleMode === 'unready') {
        return { content: JSON.stringify({ ready: false, reason: '缺授权记录，找当班主管确认（验收用）' }) };
      }
      if (ruleMode === 'add') {
        return { content: JSON.stringify({ ready: true, id: 'ops_probe_allow', name: '运维探针放行', description: '已知授权扫描来源', reason: '新增一条专门盖住运维探针', rego: NEW_RULE }) };
      }
      return { content: JSON.stringify({ ready: true, id: 'honeypot_probe', name: '蜜罐探测（root 用户）', reason: '把已知授权扫描来源排除', rego: HONEYPOT_UPDATED }) };
    }
  };
  const wikiModel = {
    complete: async messages => {
      wikiCalls.push(messages);
      await gate;
      if (wikiMode === 'fail') throw new Error('模型接口 HTTP 500: 上游不可用（验收用）');
      const user = JSON.parse(messages.at(-1).content);
      const page = user.current_page;
      const updated = page.replace(/^updated: .*$/m, 'updated: 2026-11-19') +
        '\n\n## 维护记录（P003-T013 验收）\n\n运维蜜罐探针，来源已核对授权扫描清单；本条不改变判据主结论。\n';
      return { content: JSON.stringify({ reply: '已给出草案', diagnosis: 'criterion_gap', ready: true,
        proposed_content: updated, rationale: '运维探针误报，补充授权扫描说明' }) };
    }
  };

  const rulePrompts = { load: async () => ({ prompts: { rule: RULE_PROMPT_MARK } }) };
  const wikiPrompts = {
    load: async () => ({ revision: 'rev-p003t013', prompts: { knowledge: WIKI_PROMPT_MARK, triage: '常规研判提示' },
      sop: { common: '通用 SOP' }, scenarios: { cards: [{ id: 'honeypot', prompt: '蜜罐场景提示' }] } })
  };

  const ruleMaintainer = new RegoRuleMaintainer(ruleModel, ruleStore, rulePrompts);
  const wikiAgent = new WikiWorkbench(wiki, wikiModel, wikiPrompts, sessionsDir);
  let investigatorCalls = 0;
  const investigator = {
    model: { model: 'fake-not-used' },
    run: async () => { investigatorCalls += 1; throw new Error('误报维护不该重新跑研判（验收用）'); }
  };

  const server = createServer(undefined, undefined, investigator, undefined, undefined, monitor,
    undefined, undefined, undefined, undefined, wiki, wikiAgent, undefined, undefined, ruleStore, ruleMaintainer);
  const baseUrl = await listen(server);

  return {
    base, wikiDir, rulesDir, sessionsDir, monitorFile, monitor, wiki, ruleStore, wikiAgent,
    rulesBefore: await fileMap(rulesDir),
    server, baseUrl, ruleCalls, wikiCalls, pagesBefore,
    get investigatorCalls() { return investigatorCalls; },
    release: () => releaseGate && releaseGate(),
    async close() {
      await new Promise(r => server.close(r));
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

async function finishMaintenance(s, id) {
  return waitFor(async () => {
    const rec = s.monitor.records.get(id);
    return rec && rec.maintenance && rec.maintenance.status !== 'updating' ? rec : null;
  }, '两个维护者收尾');
}

/* ---------------- A1：先落盘后 202，维护不等响应 ---------------- */

test('A1 POST 回 202 时结论已落盘、维护仍在 updating；GET 同读；维护收尾后三态可读', async t => {
  const s = await stack({ seed: [{ id: A_ID }], gated: true });
  t.after(() => s.close());
  const rulesBefore = await fileMap(s.rulesDir);
  const listedBefore = await call(s.baseUrl, 'GET', '/api/rules');
  assert.equal(listedBefore.status, 200, listedBefore.text);
  const idsBefore = listedBefore.json.rules.map(r => r.id).sort();

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  assertFalsePositiveRecord(res.json);
  assert.equal(res.json.alert_id, A_ID);
  assert.equal(res.json.feedback.reason, REASON);
  assert.equal(res.json.feedback.who, WHO);
  // 维护者还卡在 gate 上：此刻状态只能是 updating
  assert.equal(res.json.maintenance.status, 'updating');

  // 「先落盘」：202 到手时磁盘快照里已经是误报，而且维护未收尾
  const disk = JSON.parse(await readFile(s.monitorFile, 'utf8'));
  const diskRec = (disk.records || []).find(r => r.alert_id === A_ID);
  assert.ok(diskRec, '202 时监控状态文件里没有这条记录');
  assert.equal(diskRec.verdict, 'false_positive', '202 时磁盘上还不是误报');
  assert.equal(diskRec.verdict_label, '误报');
  assert.equal(diskRec.decision_source, 'human');
  assert.equal(diskRec.feedback.reason, REASON);
  assert.equal(diskRec.feedback.who, WHO);
  assert.equal(diskRec.maintenance.status, 'updating', '维护未收尾时磁盘总态就该是 updating');

  // GET 走真的 monitor.status()，同一时刻读到的也是误报 + updating
  const visible = await call(s.baseUrl, 'GET', GET_PATH(A_ID));
  assert.equal(visible.status, 200, visible.text);
  assert.equal(visible.json.verdict, 'false_positive');
  assert.equal(visible.json.verdict_label, '误报');
  assert.equal(visible.json.decision_source, 'human');
  assert.equal(visible.json.feedback.reason, REASON);
  assert.equal(visible.json.maintenance.status, 'updating');

  // 放行两个维护者，等收尾
  s.release();
  const finished = await finishMaintenance(s, A_ID);
  assert.equal(finished.maintenance.status, 'updated', JSON.stringify(finished.maintenance));
  assert.equal(finished.maintenance.rule.status, 'updated');
  assert.equal(finished.maintenance.rule.file, 'honeypot_probe.rego');
  assert.equal(finished.maintenance.rule.action, 'update');
  assert.equal(finished.maintenance.wiki.status, 'updated', JSON.stringify(finished.maintenance.wiki));
  assert.equal(finished.maintenance.wiki.page, 'honeypot/HP-10.md');
  assert.equal(typeof finished.maintenance.wiki.revision, 'string');

  // 结论没被维护结果改写
  assert.equal(finished.verdict, 'false_positive');
  assert.equal(finished.verdict_label, '误报');
  assert.equal(finished.feedback.reason, REASON);

  // A2：只动被改的那一份 Rego——目录文件集合不能变，规则库条数不能变
  const after = await fileMap(s.rulesDir);
  const regoKeys = m => [...m.keys()].filter(n => n.endsWith('.rego')).sort();
  assert.deepEqual(regoKeys(after), regoKeys(rulesBefore),
    `改一条规则后 rules 目录的文件集合变了：${regoKeys(after)} vs ${regoKeys(rulesBefore)}`);
  assert.equal(regoKeys(after).length, 3, `改一条规则后 .rego 份数不是 3：${regoKeys(after)}`);
  assert.equal(after.get('honeypot_probe.rego'), HONEYPOT_UPDATED);
  for (const [name, content] of rulesBefore) {
    if (name === 'honeypot_probe.rego') continue;
    assert.equal(after.get(name), content, `${name} 被顺带改了`);
  }
  const listed = await call(s.baseUrl, 'GET', '/api/rules');
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.rules.length, 3, `改一条规则后 /api/rules 条数变了：${listed.json.rules.length}`);
  assert.deepEqual(listed.json.rules.map(r => r.id).sort(), idsBefore, '改一条规则后 /api/rules 条目变了');
  assert.ok(listed.json.rules.some(r => r.id === 'honeypot_probe'), '改后的规则没进规则库列表');

  // A3：wiki 是走维护会话 + publishBundle 真的写页，不是只出草案
  const page = await s.wiki.get('honeypot/HP-10.md');
  assert.notEqual(page.revision, s.pagesBefore.get('honeypot/HP-10.md').revision, 'wiki 页 revision 没变，等于没写进去');
  assert.match(page.content, /维护记录（P003-T013 验收）/);
  const log = await readFile(path.join(s.wikiDir, 'log.md'), 'utf8');
  assert.match(log, /值班分析员/, 'log.md 没记审核人');
  assert.match(log, /运维的蜜罐探针/, 'log.md 没记登记人给的理由');

  // A3：两个维护者不是跑研判的那个 Agent——研判器一次都没被调用，且各自用的是维护提示词
  assert.equal(s.investigatorCalls, 0, '维护过程中调用了研判 Agent');
  assert.ok(s.ruleCalls.length >= 1, '规则维护者没调模型');
  const ruleSystem = s.ruleCalls[0].find(m => m.role === 'system')?.content || '';
  assert.match(ruleSystem, /【本卡验收标记】规则维护提示/, '规则维护者没用 prompts.rule');
  assert.ok(s.wikiCalls.length >= 1, 'wiki 维护者没调模型');
  const wikiSystem = s.wikiCalls[0].find(m => m.role === 'system')?.content || '';
  assert.match(wikiSystem, /【本卡验收标记】知识维护提示/, 'wiki 维护者没用 prompts.knowledge');
  assert.match(wikiSystem, /Wiki 操作手册/, 'wiki 维护轮没带 _schema.md');
  assert.match(JSON.parse(s.wikiCalls[0].at(-1).content).current_page, /id: HP-10/, 'wiki 维护目标不是分析时引用过的 HP-10');

  // 会话里留痕：登记人、理由、预期结论
  const sessionFiles = (await readdir(s.sessionsDir)).filter(n => n.endsWith('.json'));
  assert.equal(sessionFiles.length, 1, `wiki 维护会话数不符：${sessionFiles}`);
  const session = JSON.parse(await readFile(path.join(s.sessionsDir, sessionFiles[0]), 'utf8'));
  assert.equal(session.page, 'honeypot/HP-10.md');
  assert.equal(session.feedback.expected_verdict, 'false_positive');
  assert.equal(session.feedback.reason, REASON);
  assert.equal(session.feedback.who, WHO);
});

/* ---------------- A2：新增一条也只多一个文件 ---------------- */

test('A2 新增一条规则：目录里只多一个文件，既有三份逐字节不变', async t => {
  const s = await stack({ seed: [{ id: A_ID }], ruleMode: 'add' });
  t.after(() => s.close());
  const before = await fileMap(s.rulesDir);
  const listedBefore = await call(s.baseUrl, 'GET', '/api/rules');
  assert.equal(listedBefore.status, 200, listedBefore.text);
  const idsBefore = listedBefore.json.rules.map(r => r.id).sort();

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  const rec = await finishMaintenance(s, A_ID);
  assert.equal(rec.maintenance.rule.status, 'updated', JSON.stringify(rec.maintenance.rule));
  assert.equal(rec.maintenance.rule.file, 'ops_probe_allow.rego');
  assert.equal(rec.maintenance.rule.action, 'add');

  const after = await fileMap(s.rulesDir);
  const regoKeys = m => [...m.keys()].filter(n => n.endsWith('.rego')).sort();
  assert.deepEqual(regoKeys(after), [...regoKeys(before), 'ops_probe_allow.rego'].sort(),
    `新增一条规则后文件集合不是「原来三份 + 新增一份」：${regoKeys(after)}`);
  assert.equal(regoKeys(after).length, regoKeys(before).length + 1, `新增一条规则后 .rego 份数不对：${regoKeys(after)}`);
  assert.equal(after.get('ops_probe_allow.rego'), NEW_RULE);
  for (const [name, content] of before) assert.equal(after.get(name), content, `${name} 被顺带改了`);
  const listed = await call(s.baseUrl, 'GET', '/api/rules');
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.rules.length, idsBefore.length + 1,
    `新增一条规则后 /api/rules 条数不是 +1：${listed.json.rules.length}（改前 ${idsBefore.length}）`);
  assert.deepEqual(listed.json.rules.map(r => r.id).sort(), [...idsBefore, 'ops_probe_allow'].sort(),
    '新增一条规则后 /api/rules 条目不是「原来那些 + 新那条」');
  assert.ok(listed.json.rules.some(r => r.id === 'ops_probe_allow'));
});

/* ---------------- A3：wiki 维护目标 = 分析时引用过的那一页，不是本场景第一页 ---------------- */

test('A3 wiki 维护目标取分析时引用过的页（HP-11），不是本场景第一页（HP-10）', async t => {
  // 夹具：wiki 里造一页 active 的 HP-11；案件材料的 trace 与 verdict.wiki.consulted 都指向 HP-11。
  // 本场景第一页仍是 HP-10（路径排序在前），所以「引用页」与「回退首项」不同——选页分支一断，本用例必红。
  const s = await stack({ seed: [{ id: A_ID, cited: 'HP-11' }], extraWikiPage: { id: 'HP-11', title: '蜜罐诱捕 · 授权扫描核对' } });
  t.after(() => s.close());

  const candidates = (await s.wiki.list()).filter(p => p.path.startsWith('honeypot/HP-')).map(p => p.path).sort();
  assert.deepEqual(candidates.slice(0, 2), ['honeypot/HP-10.md', 'honeypot/HP-11.md'],
    `夹具不成立：本场景候选页前两页不是 HP-10/HP-11：${candidates}`);
  const hp10Before = await s.wiki.get('honeypot/HP-10.md');
  const hp11Before = await s.wiki.get('honeypot/HP-11.md');

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  const rec = await finishMaintenance(s, A_ID);

  assert.equal(rec.maintenance.wiki.status, 'updated', JSON.stringify(rec.maintenance.wiki));
  assert.equal(rec.maintenance.wiki.page, 'honeypot/HP-11.md', 'wiki 维护者改的不是分析时引用过的页');
  assert.deepEqual(rec.maintenance.wiki.pages, ['honeypot/HP-11.md'], `发布页集合不符：${JSON.stringify(rec.maintenance.wiki.pages)}`);

  // 模型看到的目标页就是 HP-11，且它是被引用过的那页
  const userMsg = JSON.parse(s.wikiCalls.at(-1).at(-1).content);
  assert.match(userMsg.current_page, /^id: HP-11$/m, 'wiki 维护轮拿到的当前页不是 HP-11');
  assert.doesNotMatch(userMsg.current_page, /^id: HP-10$/m, 'wiki 维护轮拿到的当前页是本场景第一页 HP-10');

  // 会话落的就是 HP-11
  const sessionFiles = (await readdir(s.sessionsDir)).filter(n => n.endsWith('.json'));
  assert.equal(sessionFiles.length, 1, `wiki 维护会话数不符：${sessionFiles}`);
  const session = JSON.parse(await readFile(path.join(s.sessionsDir, sessionFiles[0]), 'utf8'));
  assert.equal(session.page, 'honeypot/HP-11.md');

  // 引用页真被写了，回退首项（HP-10）一个字节没动
  const page11 = await s.wiki.get('honeypot/HP-11.md');
  const page10 = await s.wiki.get('honeypot/HP-10.md');
  assert.notEqual(page11.revision, hp11Before.revision, 'HP-11 没被写进去');
  assert.match(page11.content, /维护记录（P003-T013 验收）/);
  assert.equal(page10.revision, hp10Before.revision, '本场景第一页 HP-10 被改动了');
  assert.equal(page10.content, hp10Before.content, 'HP-10 正文被改动了');

  // 结论仍是误报（A3 不碰结论）
  assert.equal(rec.verdict, 'false_positive');
});

/* ---------------- A2 + A4：子集外语法不落盘，失败只写 maintenance ---------------- */

test('A4 规则维护失败（子集外语法）：原文件一字不动、不留临时文件、误报结论不回滚', async t => {
  const s = await stack({ seed: [{ id: A_ID }], ruleMode: 'invalid' });
  t.after(() => s.close());
  const before = await fileMap(s.rulesDir);

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  const rec = await finishMaintenance(s, A_ID);

  assert.equal(rec.maintenance.status, 'failed', JSON.stringify(rec.maintenance));
  assert.equal(rec.maintenance.rule.status, 'failed');
  assert.match(rec.maintenance.rule.error, /honeypot_probe\.rego:\d+/, JSON.stringify(rec.maintenance.rule));
  assert.equal(rec.maintenance.wiki.status, 'updated');
  // 结论一个字节不动
  assert.equal(rec.verdict, 'false_positive');
  assert.equal(rec.verdict_label, '误报');
  assert.equal(rec.decision_source, 'human');
  assert.equal(rec.feedback.reason, REASON);
  assert.equal(rec.feedback.who, WHO);
  // 目录没被写坏
  assert.deepEqual(await fileMap(s.rulesDir), before);
  assert.deepEqual((await readdir(s.rulesDir)).filter(n => n.startsWith('.')), [], '留下了临时文件');

  // GET 同读：三态可读
  const visible = await call(s.baseUrl, 'GET', GET_PATH(A_ID));
  assert.equal(visible.status, 200, visible.text);
  assert.equal(visible.json.verdict, 'false_positive');
  assert.equal(visible.json.maintenance.status, 'failed');
  assert.equal(visible.json.maintenance.rule.status, 'failed');
  assert.equal(visible.json.maintenance.wiki.status, 'updated');
});

/* ---------------- A4：单边失败另一边照常写 ---------------- */

test('A4 规则维护者抛错、wiki 正常：总态 failed，wiki 的页与 revision 照常可见', async t => {
  const s = await stack({ seed: [{ id: A_ID }], ruleMode: 'unready' });
  t.after(() => s.close());

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  const rec = await finishMaintenance(s, A_ID);
  assert.equal(rec.maintenance.status, 'failed');
  assert.equal(rec.maintenance.rule.status, 'failed');
  assert.match(rec.maintenance.rule.error, /缺授权记录/);
  assert.equal(rec.maintenance.wiki.status, 'updated');
  assert.equal(rec.maintenance.wiki.page, 'honeypot/HP-10.md', `wiki 维护目标页不符：${rec.maintenance.wiki.page}`);
  assert.equal(typeof rec.maintenance.wiki.revision, 'string');
  assert.equal(rec.verdict, 'false_positive');
});

/* ---------------- A4：记录上残留的 updating 不锁死 ---------------- */

test('A4 记录停在 updating 但本进程没在跑：重新登记会重起一轮并收尾', async t => {
  const staleRecord = {
    verdict: 'false_positive', verdict_label: '误报', decision_source: 'human',
    feedback: { reason: '上一次登记的旧理由文字', who: '上一班', recorded_at: '2026-11-18T04:00:00.000Z' },
    maintenance: { status: 'updating', updated_at: '2026-11-18T04:00:00.000Z',
      rule: { status: 'updating' }, wiki: { status: 'updating' } }
  };
  const s = await stack({ seed: [{ id: A_ID, record: staleRecord }] });
  t.after(() => s.close());

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  assert.equal(res.json.maintenance.status, 'updating');

  const rec = await finishMaintenance(s, A_ID);
  assert.equal(rec.maintenance.status, 'updated', JSON.stringify(rec.maintenance));
  assert.equal(rec.maintenance.rule.status, 'updated');
  assert.equal(rec.maintenance.wiki.status, 'updated');
  assert.equal(rec.verdict, 'false_positive');
  assert.equal(rec.feedback.reason, REASON, '重新登记没更新 feedback');
  assert.equal(rec.feedback.who, WHO);
  assert.equal(s.ruleCalls.length, 1, `重起轮数不符：rule 模型调用 ${s.ruleCalls.length} 次`);
});

/* ---------------- A1 入参 / 错误码 / 响应体形状 ---------------- */

test('A1 入参边界：400/404/409 每条都断言 {error} 形状且不改原记录', async t => {
  const s = await stack({
    seed: [
      { id: A_ID },
      { id: C_ID },
      { id: D_ID },
      { id: B_ID, record: { status: 'queued', verdict: undefined, verdict_label: undefined, decision_source: undefined } }
    ],
    gated: true
  });
  t.after(async () => { s.release(); await s.close(); });

  const cases = [
    ['缺 reason', { who: WHO }, 400],
    ['reason 9 字', { reason: '九'.repeat(9), who: WHO }, 400],
    ['reason 4001 字', { reason: '长'.repeat(4001), who: WHO }, 400],
    ['who 1 字', { reason: REASON, who: 'x' }, 400],
    ['正文是数组', [], 400],
    ['正文是 null', null, 400],
    ['正文是字符串', 'mistake', 400]
  ];
  for (const [name, body, status] of cases) {
    const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), body);
    assertErrorShape(res, status);
  }

  // 非法 JSON 与超长：docs http-api.md §8.1（本路由上限 12000）
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH(A_ID), undefined, '{'), 400);
  assert.match((await call(s.baseUrl, 'POST', FP_PATH(A_ID), undefined, '{')).json.error, /请求正文不是 JSON/);
  const huge = { reason: REASON, who: WHO, pad: 'x'.repeat(12000) };
  const over = await call(s.baseUrl, 'POST', FP_PATH(A_ID), undefined, JSON.stringify(huge));
  assertErrorShape(over, 400);
  assert.match(over.json.error, /请求正文过大/);

  // 正文长度边界：§8.1 说本路由上限 12000——恰好 12000 合法、12001 超限，差一个字就分得出来
  const bodyOfLength = n => {
    const base = JSON.stringify({ reason: REASON, who: WHO, pad: '' });
    return JSON.stringify({ reason: REASON, who: WHO, pad: 'x'.repeat(n - base.length) });
  };
  const exact12000 = bodyOfLength(12000);
  assert.equal(exact12000.length, 12000);
  const atLimit = await call(s.baseUrl, 'POST', FP_PATH(D_ID), undefined, exact12000);
  assert.equal(atLimit.status, 202, `正文恰好 12000 字被拒：${atLimit.status} ${atLimit.text}`);
  assertFalsePositiveRecord(atLimit.json);
  const exact12001 = bodyOfLength(12001);
  assert.equal(exact12001.length, 12001);
  const overByOne = await call(s.baseUrl, 'POST', FP_PATH(D_ID), undefined, exact12001);
  assertErrorShape(overByOne, 400);
  assert.match(overByOne.json.error, /请求正文过大/);

  // id 编码/格式无效 → 400；格式合法但没这条 → 404
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH('bad-id'), { reason: REASON }), 400);
  const unknown = syslogId('0123456789abcdef', '1763379999', '11111111-1111-4111-8111-111111111111');
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH(unknown), { reason: REASON }), 404);

  // 未完成（queued）→ 409，原记录不动
  const queuedBefore = { ...s.monitor.records.get(B_ID) };
  const conflict = await call(s.baseUrl, 'POST', FP_PATH(B_ID), { reason: REASON, who: WHO });
  assertErrorShape(conflict, 409);
  assert.match(conflict.json.error, /研判还没结束/);
  assert.deepEqual(s.monitor.records.get(B_ID), queuedBefore, '409 之后记录被改了');
  const queuedVisible = await call(s.baseUrl, 'GET', GET_PATH(B_ID));
  assert.equal(queuedVisible.status, 200);
  assert.equal(queuedVisible.json.status, 'queued');
  assert.ok(queuedVisible.json.verdict == null, `queued 记录不该有 verdict：${queuedVisible.json.verdict}`);
  assert.equal(queuedVisible.json.feedback, undefined);

  // 正好 10 字理由 + 省略 who（未启用 Basic 认证 → operator）→ 202
  const ok = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: '十'.repeat(10) });
  assert.equal(ok.status, 202, ok.text);
  assertFalsePositiveRecord(ok.json);
  assert.equal(ok.json.feedback.reason, '十'.repeat(10));
  assert.equal(ok.json.feedback.who, 'operator');
  // 4000 字理由与 100 字登记人也在合法域内（换一条未在维护中的记录，避免「同一轮只回当前进度」）
  const max = await call(s.baseUrl, 'POST', FP_PATH(C_ID), { reason: '满'.repeat(4000), who: 'w'.repeat(100) });
  assert.equal(max.status, 202, max.text);
  assert.equal(max.json.feedback.reason.length, 4000);
  assert.equal(max.json.feedback.who.length, 100);

  s.release();
  await finishMaintenance(s, A_ID);
  await finishMaintenance(s, C_ID);
  await finishMaintenance(s, D_ID);
});

/* ---------------- 契约定不了的一条：who 超长（todo，不阻塞） ---------------- */

// openapi.yaml:389 给 who 的 maxLength 是 100；http-api.md §3.4 只写「登记人至少 2 字」、没写上限与超限状态码。
// 实测：who 101 字回 202，并把 who 截到 100。契约没定该 400 还是接受截断，这不是本卡能单方判的——
// 标 todo 让它在输出里一直可见（# todo 1），不拿实现行为冒充断言。见 test-report.md §7。
test('边界（待定口径）who 101 字：按 openapi maxLength=100 应为 400', { todo: 'openapi maxLength 100 vs http-api 未写上限；实测 202 截断，待群主定口径' }, async t => {
  const s = await stack({ seed: [{ id: A_ID }], gated: true });
  t.after(async () => { s.release(); await s.close(); });
  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: 'w'.repeat(101) });
  assert.equal(res.status, 400, `openapi.yaml:389 maxLength=100，实测 ${res.status}：${res.text}`);
});

/* ---------------- 503：研判队列未配置 ---------------- */

test('503 研判队列未配置：错误体是 {error:string}（monitor 显式 null，不吃环境）', async t => {
  // 显式传 monitor=null、access={}：不依赖本机环境变量（CLOUDWALKER_URL/LLM_*/HIDS_BASIC_AUTH_PASSWORD）
  const server = createServer(undefined, undefined, undefined, undefined, undefined, null, null, {});
  const baseUrl = await listen(server);
  t.after(() => new Promise(r => server.close(r)));
  const res = await call(baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assertErrorShape(res, 503);
  assert.match(res.json.error, /自动研判尚未配置/);
});
