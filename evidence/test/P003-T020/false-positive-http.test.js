// P003-T020 HTTP 层集成（黑盒）：POST /api/agent/triage/{alertId}/false-positive → 规则维护者
// 改已有规则被「不许放宽」拦住 → maintenance.rule.status === 'failed'，规则目录一字不动，
// 误报结论不回滚；同一入口下「收紧」的候选必须照常更新（防这条用例变成「反正都失败」的空转断言）。
//
// 断言只按 docs/modules/http-api.md §3.4 与 openapi.yaml 的 reportFalsePositive /
// FalsePositiveRecord / CaseMaintenance / MaintenanceSide 写；注入点只用文档写明的
// createServer 依赖注入（http-api.md §2）。真 server、真 TriageMonitor、真 RuleStore/WikiStore、
// 真两个维护者类，只把外部模型换成本地假模型。
//
// 跑法（仓根，只跑这一个文件）：
//   timeout 180 node --test evidence/test/P003-T020/false-positive-http.test.js
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js 求值前把 HIDS_DATA_DIR
// 指到本进程的临时根，否则 createServer 的缺省 fpSessions 会往真全局根写维护会话。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, RegoRuleMaintainer } from '../../../server.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { RuleStore } from '../../../rule-store.js';
import { WikiStore } from '../../../wiki-store.js';
import { WikiWorkbench } from '../../../wiki-workbench.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());
const FP_PATH = id => `/api/agent/triage/${encodeURIComponent(id)}/false-positive`;
const GET_PATH = id => `/api/agent/triage/${encodeURIComponent(id)}`;
const REASON = '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单';
const WHO = '值班分析员';

const A_ID = 'syslog:honeypot:0123456789abcdef:1763373600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
const B_ID = 'syslog:honeypot:fedcba9876543210:1763373700:7a2c7b5f-5e4b-4c9f-bb5f-3a7f2c6d8e91';

// 现场测试那份放宽版（docs/_meta/live-test-2026-11-19.md 的候选正文）：前缀 /tmp/ 收成 /tmp，
// 另加一条现场测试排除。改已有规则走这条必须被拒。
const WIDENED_WEBSHELL = `package hids.rules.webshell_drop

# name: WebShell 落地脚本
# description: webshell 告警落在 /tmp 下、路径以 .jsp 结尾、主机非空，且排除现场测试注入的样例文件

default match := false

match if {
  input.type == "webshell"
  startswith(input.path, "/tmp")
  endswith(input.path, ".jsp")
  input.host != ""
  not contains(input.path, "hids-live-test")
}
`;

// 收紧版：原有四条一条不少，再叠一条排除——必须放行并落盘。
const TIGHTER_WEBSHELL = `package hids.rules.webshell_drop

# name: WebShell 落地脚本
# description: webshell 告警落在 /tmp 下、路径以 .jsp 结尾、主机非空，另排除运维授权样例

default match := false

match if {
  input.type == "webshell"
  input.host != ""
  startswith(input.path, "/tmp/")
  endswith(input.path, ".jsp")
  not contains(input.path, "hids-live-test")
}
`;

const RULE_PROMPT_MARK = '【P003-T020 集成】规则维护提示';
const WIKI_PROMPT_MARK = '【P003-T020 集成】知识维护提示';

/* ---------------- 夹具与装置 ---------------- */

async function makeCase(base, id) {
  const caseDir = path.join(base, 'cases', id.replace(/[:]/g, '_'));
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '01-原始告警.txt'),
    '<134>1 2026-11-18T10:00:00Z host app - cloudwalker-honeypot event_id=7 host_ip=10.0.0.5 source_ip=203.0.113.9 event_create_time="2026-11-18 10:00:00"\n');
  await writeFile(path.join(caseDir, '03-研判事实.md'),
    '# 研判事实\n\n主机 IP：10.0.0.5\n事件时间：2026-11-18 10:00:00\n来源：203.0.113.9\n');
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify({
    alert_id: id,
    mode: 'triage',
    trace: [{ kind: 'wiki', action: 'page', id: 'HP-10' }],
    verdict: {
      verdict: 'threat', verdict_label: '真实威胁',
      rego: { status: 'matched', rule_ids: ['webshell_drop'] },
      wiki: { consulted: ['HP-10'], adopted: [], reason: '' }
    }
  }));
  return caseDir;
}

function doneRecord(id, caseDir) {
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
    }
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

async function call(base, method, p, body) {
  const init = { method, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
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

const finishMaintenance = (s, id) => waitFor(async () => {
  const rec = s.monitor.records.get(id);
  return rec && rec.maintenance && rec.maintenance.status !== 'updating' ? rec : null;
}, '两个维护者收尾');

const assertErrorShape = (res, status) => {
  assert.equal(res.status, status, res.text);
  assert.ok(res.json && typeof res.json === 'object', `错误响应不是 JSON 对象：${res.text}`);
  assert.equal(typeof res.json.error, 'string', `错误响应缺 {error:string}：${res.text}`);
};

// openapi.yaml FalsePositiveRecord（additionalProperties:false）+ CaseMaintenance + MaintenanceSide
function assertFalsePositiveRecord(body) {
  assert.deepEqual(Object.keys(body).sort(), ['alert_id', 'feedback', 'maintenance', 'verdict'],
    `FalsePositiveRecord 顶层键不符：${JSON.stringify(body)}`);
  assert.equal(typeof body.alert_id, 'string');
  assert.deepEqual(Object.keys(body.verdict).sort(), ['source', 'verdict', 'verdict_label']);
  assert.equal(body.verdict.verdict, 'false_positive');
  assert.equal(body.verdict.verdict_label, '误报');
  assert.equal(body.verdict.source, 'human');
  assert.deepEqual(Object.keys(body.feedback).sort(), ['reason', 'recorded_at', 'who']);
  for (const key of ['reason', 'who', 'recorded_at']) assert.equal(typeof body.feedback[key], 'string');
  assert.ok(!Number.isNaN(Date.parse(body.feedback.recorded_at)), 'feedback.recorded_at 不是日期时间');
  assert.deepEqual(Object.keys(body.maintenance).sort().filter(k => k === 'rule' || k === 'wiki'), ['rule', 'wiki']);
  for (const side of ['rule', 'wiki']) {
    assert.ok(['updating', 'updated', 'failed'].includes(body.maintenance[side].status),
      `maintenance.${side}.status 越界：${body.maintenance[side].status}`);
  }
  assert.ok(['updating', 'updated', 'failed'].includes(body.maintenance.status),
    `维护总态越界：${body.maintenance.status}`);
}

/**
 * 一套「真 HTTP + 真研判队列 + 真规则库/判据库 + 真两个维护者」的台子，只把外部模型换成假模型。
 * ruleRego 为空表示规则维护者回 ready:false（不碰规则）。
 */
async function stack({ ruleRego = '', queued = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'p003t020-http-'));
  await cp(path.join(repoRoot, 'wiki'), path.join(base, 'wiki'), { recursive: true });
  await cp(path.join(repoRoot, 'rules'), path.join(base, 'rules'), { recursive: true });
  const rulesDir = path.join(base, 'rules');
  const wikiDir = path.join(base, 'wiki');
  const sessionsDir = path.join(base, 'wiki-sessions');

  const caseA = await makeCase(base, A_ID);
  const caseB = await makeCase(base, B_ID);

  const monitorFile = path.join(base, 'triage-monitor.json');
  const monitor = new TriageMonitor({
    service: {}, investigator: {}, history: {},
    file: monitorFile, inputMode: 'syslog', casesDirectory: path.join(base, 'cases')
  });
  monitor.records.set(A_ID, doneRecord(A_ID, caseA));
  monitor.records.set(B_ID, { ...doneRecord(B_ID, caseB), status: 'queued' });
  await monitor.persist();

  const wiki = new WikiStore(wikiDir);
  const ruleStore = new RuleStore(rulesDir);

  const ruleCalls = [];
  const ruleModel = {
    complete: async messages => {
      ruleCalls.push(messages);
      if (!ruleRego) {
        return { content: JSON.stringify({ ready: false, reason: '本用例不碰规则（夹具）' }) };
      }
      return { content: JSON.stringify({
        ready: true, id: 'webshell_drop', name: 'WebShell 落地脚本',
        description: '维护者提交的候选正文', reason: '按误报理由收紧条件', rego: ruleRego
      }) };
    }
  };
  const wikiModel = {
    complete: async messages => {
      const user = JSON.parse(messages.at(-1).content);
      const updated = user.current_page.replace(/^updated: .*$/m, 'updated: 2026-11-19') +
        '\n\n## 维护记录（P003-T020 集成）\n\n运维蜜罐探针，来源已核对授权扫描清单；本条不改变判据主结论。\n';
      return { content: JSON.stringify({ reply: '已给出草案', diagnosis: 'criterion_gap', ready: true,
        proposed_content: updated, rationale: '运维探针误报，补充授权扫描说明' }) };
    }
  };

  const rulePrompts = { load: async () => ({ prompts: { rule: RULE_PROMPT_MARK } }) };
  const wikiPrompts = {
    load: async () => ({ revision: 'rev-p003t020', prompts: { knowledge: WIKI_PROMPT_MARK, triage: '常规研判提示' },
      sop: { common: '通用 SOP' }, scenarios: { cards: [{ id: 'honeypot', prompt: '蜜罐场景提示' }] } })
  };

  const ruleMaintainer = new RegoRuleMaintainer(ruleModel, ruleStore, rulePrompts);
  const wikiAgent = new WikiWorkbench(wiki, wikiModel, wikiPrompts, sessionsDir);
  const investigator = { model: { model: 'fake-not-used' }, run: async () => { throw new Error('误报维护不该重跑研判（夹具）'); } };

  // createServer 的依赖注入顺序照 docs/modules/http-api.md §2 / evidence/test/P003-T013 的既有台子。
  const server = createServer(undefined, undefined, investigator, undefined, undefined, monitor,
    undefined, undefined, undefined, undefined, wiki, wikiAgent, undefined, undefined, ruleStore, ruleMaintainer);
  const baseUrl = await listen(server);

  return {
    base, rulesDir, monitorFile, monitor, wiki,
    rulesBefore: await fileMap(rulesDir),
    baseUrl, ruleCalls, queued,
    async close() {
      await new Promise(r => server.close(r));
      await rm(base, { recursive: true, force: true });
    }
  };
}

/* ---------------- #4：HTTP 层走通「放宽 → 维护失败」这一跳 ---------------- */

test('POST false-positive + 放宽的规则候选：maintenance.rule.status=failed，规则目录一字不动，误报结论不回滚', async t => {
  const s = await stack({ ruleRego: WIDENED_WEBSHELL });
  t.after(() => s.close());

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);
  assertFalsePositiveRecord(res.json);
  assert.equal(res.json.alert_id, A_ID);
  assert.equal(res.json.feedback.reason, REASON);
  assert.equal(res.json.feedback.who, WHO);
  assert.equal(res.json.verdict.verdict, 'false_positive');

  const rec = await finishMaintenance(s, A_ID);
  assert.ok(s.ruleCalls.length >= 1, '规则维护者没被叫起来跑');

  // 这一边失败，失败原因走 maintenance.rule.error（docs §3.4：截 300 字）
  assert.equal(rec.maintenance.rule.status, 'failed', JSON.stringify(rec.maintenance.rule));
  assert.match(rec.maintenance.rule.error, /放宽了原有限制条件/,
    `失败原因不是「放宽」：${JSON.stringify(rec.maintenance.rule.error)}`);
  assert.match(rec.maintenance.rule.error, /startswith\(input\.path, "\/tmp\/"\)/,
    `失败原因没点名被放宽的那一行：${JSON.stringify(rec.maintenance.rule.error)}`);
  assert.ok(rec.maintenance.rule.error.length <= 300,
    `maintenance.rule.error 超过 docs §3.4 的 300 字上限：${rec.maintenance.rule.error.length}`);
  // wiki 那一边照常改完，总态按「任一边 failed」判 failed
  assert.equal(rec.maintenance.wiki.status, 'updated', JSON.stringify(rec.maintenance.wiki));
  assert.equal(rec.maintenance.status, 'failed', JSON.stringify(rec.maintenance));

  // 结论一个字节不动（失败只体现在 maintenance）
  assert.equal(rec.verdict, 'false_positive');
  assert.equal(rec.verdict_label, '误报');
  assert.equal(rec.decision_source, 'human');
  assert.equal(rec.feedback.reason, REASON);
  assert.equal(rec.feedback.who, WHO);

  // 不落盘：文件集合 + 每份全文逐字节相等，也没有临时文件残留
  assert.deepEqual(await fileMap(s.rulesDir), s.rulesBefore, '被拒绝的候选改动了 rules 目录');
  assert.deepEqual((await readdir(s.rulesDir)).filter(n => n.startsWith('.')), [], '留下了临时文件');

  // GET 同读：维护失败对读侧可见
  const visible = await call(s.baseUrl, 'GET', GET_PATH(A_ID));
  assert.equal(visible.status, 200, visible.text);
  assert.equal(visible.json.verdict, 'false_positive');
  assert.equal(visible.json.maintenance.status, 'failed');
  assert.equal(visible.json.maintenance.rule.status, 'failed');
  assert.match(visible.json.maintenance.rule.error, /放宽了原有限制条件/);
  assert.equal(visible.json.maintenance.wiki.status, 'updated');

  // 规则库列表没多出/少掉东西（拒绝之后原库照旧可读）
  const listed = await call(s.baseUrl, 'GET', '/api/rules');
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.rules.map(r => r.id).sort(), ['honeypot_probe', 'ssh_bruteforce', 'webshell_drop']);
});

test('POST false-positive + 收紧的规则候选：maintenance.rule.status=updated 并真的写盘（方向不是「一律拒绝」）', async t => {
  const s = await stack({ ruleRego: TIGHTER_WEBSHELL });
  t.after(() => s.close());

  const res = await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: REASON, who: WHO });
  assert.equal(res.status, 202, res.text);

  const rec = await finishMaintenance(s, A_ID);
  assert.equal(rec.maintenance.rule.status, 'updated', JSON.stringify(rec.maintenance.rule));
  assert.equal(rec.maintenance.rule.action, 'update');
  assert.equal(rec.maintenance.rule.file, 'webshell_drop.rego');
  assert.equal(rec.maintenance.status, 'updated', JSON.stringify(rec.maintenance));

  // 只动那一份：文件集合不变，内容变成候选正文，其它两份逐字节不变
  const after = await fileMap(s.rulesDir);
  assert.deepEqual([...after.keys()].sort(), [...s.rulesBefore.keys()].sort(),
    `改一条规则后文件集合变了：${[...after.keys()].sort()}`);
  assert.equal(after.get('webshell_drop.rego'), TIGHTER_WEBSHELL);
  for (const [name, content] of s.rulesBefore) {
    if (name === 'webshell_drop.rego') continue;
    assert.equal(after.get(name), content, `${name} 被顺带改了`);
  }
  // 结论仍是误报
  assert.equal(rec.verdict, 'false_positive');
});

/* ---------------- 同一入口的 4xx：错误体形状 + 不改原记录 ---------------- */

test('入参边界：400 / 404 / 409 各自断言 {error:string} 形状，记录不动', async t => {
  const s = await stack();
  t.after(() => s.close());
  const before = JSON.stringify(s.monitor.records.get(A_ID));

  // reason 短于 10 字 → 400
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH(A_ID), { reason: '太短了' }), 400);
  // 正文不是对象 → 400
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH(A_ID), 'not-an-object'), 400);
  // 格式合法但没这条记录 → 404
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH(
    'syslog:honeypot:aaaabbbbccccdddd:1763373800:22222222-2222-4222-8222-222222222222'), { reason: REASON }), 404);
  // 还没研判完（queued）→ 409
  assertErrorShape(await call(s.baseUrl, 'POST', FP_PATH(B_ID), { reason: REASON }), 409);

  assert.equal(JSON.stringify(s.monitor.records.get(A_ID)), before, '被拒绝的请求改动了原记录');
  assert.equal(s.ruleCalls.length, 0, '被拒绝的请求不该起维护者');
  assert.deepEqual(await fileMap(s.rulesDir), s.rulesBefore, '被拒绝的请求改动了 rules 目录');
});
