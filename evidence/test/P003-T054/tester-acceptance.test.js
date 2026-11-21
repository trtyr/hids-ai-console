// P003-T054 · 测试侧补充用例（tester 自建，何东阳）。
//
// 只钉文档承诺、不读实现：每条断言的出处写在上方
//   A1 → docs/modules/http-api.md:55（`result.rule_evaluation` 的 reason 过记录侧闸，回灌模型那份原文）
//   A2 → docs/modules/investigation-agent.md:920（`reasonForRecord()` 无白名单，未匹配 syslog 两条只留固定文案 + 字符量）
//   A3 → docs/modules/triage-rules.md:388（`readConfig().error` 是闸后文案）
//   A7 → docs/modules/triage-pipeline.md:1033（drain 兜底 catch 的 lastError 口径）
// 口径：只看公开面（HTTP 响应 / 注入的 history.save / 规则引擎返回体 / 状态摘要 / 队列状态文件 / 日志行）。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { TriageRuleEngine } from '../../../triage-rules.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createJournal, useJournal } from '../../../src/shared/logging/log.js';

const MARKER = 'RAW_ONLY_f7a3 上游细节';
// 记录侧合同（investigation-agent §3.2 / triage-pipeline §6.4）：固定文案 + 原文字符量，不含原文。
const GATED = /^(规则评估失败：)?(上游调用失败|调用超时|模型回包不是合法 JSON（SyntaxError）)，原文 \d+ 字未落盘$/;

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根', () => assertIsolatedRoot());

// ── A1：HTTP 深度研判路径的规则预筛（http-api.md:55）────────────────────────────
async function bootHttp(t, { monitor, investigator, history }) {
  const server = createServer(undefined, undefined, investigator, history, undefined, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const fakeInvestigator = seen => ({
  run: async (alertId, options) => {
    seen.push(options);
    return { alert_id: alertId, mode: 'triage',
      verdict: { verdict: 'undetermined', verdict_label: '存疑', confidence: '低', summary: '待复核', claims: [] },
      validation: { ok: true } };
  }
});

async function ruleEvaluationCase(t, evaluate) {
  const seenModel = [];
  const saved = [];
  const base = await bootHttp(t, {
    monitor: { ruleEngine: { evaluate } },
    investigator: fakeInvestigator(seenModel),
    history: { save: async result => { saved.push(result); return result; } }
  });
  const response = await fetch(`${base}/api/agent/investigations`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alert_id: 'honeypot:7', mode: 'triage' }) });
  assert.equal(response.status, 200, `研判入口应回 200，实测 ${response.status}`);
  const body = await response.json();
  const out = body.result ?? body;
  assert.ok(out && out.rule_evaluation, `响应里应有 rule_evaluation：${JSON.stringify(body).slice(0, 300)}`);
  assert.equal(out.rule_evaluation.status, 'error');
  // ① 落盘副本（响应 = history.save 的返回，与 result.json / 研判记录同源）过闸，不带原文
  assert.match(out.rule_evaluation.reason, GATED, `落盘副本 reason 不是闸后文案：${out.rule_evaluation.reason}`);
  assert.equal(JSON.stringify(body).includes(MARKER), false, '响应正文里漏了原文');
  assert.equal(saved.length, 1, 'history.save 应被调用一次');
  assert.equal(saved[0].rule_evaluation.reason, out.rule_evaluation.reason);
  assert.equal(JSON.stringify(saved[0]).includes(MARKER), false, '落盘对象里漏了原文');
  // ② 回灌模型那一份保留原文
  assert.equal(seenModel.length, 1, 'investigator.run 应被调用一次');
  assert.ok(String(seenModel[0].ruleEvaluation?.reason ?? '').includes(MARKER),
    `回灌模型的 ruleEvaluation.reason 丢了原文：${seenModel[0].ruleEvaluation?.reason}`);
}

test('A1-a 规则评估抛错：落盘副本过闸、回灌模型那份仍是原文（http-api.md:55）', async t => {
  await ruleEvaluationCase(t, async () => { throw new Error(`规则集校验失败：${MARKER}`); });
});

test('A1-b 规则评估回 status=error：decision.reason 同样过闸（http-api.md:55）', async t => {
  await ruleEvaluationCase(t, async () => ({ status: 'error', reason: `规则集校验失败：${MARKER}` }));
});

// ── A1-c：落到磁盘的研判记录同样干净（真 InvestigationStore，不是抓对象）──────────
test('A1-c 研判记录落盘：磁盘文件里搜不到规则错误原文（http-api.md:55）', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t054-a1c-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const history = new InvestigationStore(directory);
  const seenModel = [];
  const base = await bootHttp(t, {
    monitor: { ruleEngine: { evaluate: async () => { throw new Error(`规则集校验失败：${MARKER}`); } } },
    investigator: fakeInvestigator(seenModel),
    history
  });
  const response = await fetch(`${base}/api/agent/investigations`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alert_id: 'honeypot:7', mode: 'triage' }) });
  assert.equal(response.status, 200);
  const saved = await history.latest('honeypot:7', 'triage');
  assert.ok(saved, '研判记录应已落盘');
  assert.match(saved.rule_evaluation.reason, GATED);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(directory);
  assert.ok(files.length >= 1, '研判记录目录应有文件');
  for (const file of files) {
    const text = await readFile(path.join(directory, file), 'utf8');
    assert.equal(text.includes(MARKER), false, `${file} 里漏了原文`);
  }
  assert.equal(seenModel[0].ruleEvaluation.reason.includes(MARKER), true, '回灌模型那份仍是原文');
});

// ── A2：未匹配 syslog 的两条记录去处（investigation-agent.md:920）──────────────
test('A2 未匹配 syslog：上游 reason 的徽标不再保留，只留固定文案 + 字符量', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t054-a2-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(directory, '03-研判事实.md'), '# 研判事实\n来源 192.0.2.2\n');
  const modelFailure = `${MARKER} 说明调用炸了`;
  const agent = new InvestigationAgent(
    { listTools: async () => [] },
    { model: 'fake', complete: async () => { throw new Error(modelFailure); } },
    { load: async () => ({ prompts: { triage: 'T' }, sop: {}, version: 'v1', revision: 'r1' }) },
    { agentIndex: async () => ({ category: 'honeypot', pages: [] }), agentContextPages: async () => [] },
    { evaluate: async () => ({ matched: [] }) });
  const upstream = `${MARKER} 上游 503`;
  const result = await agent.runUnmatchedSyslog(
    { raw: 'raw', context: {}, parsed: { msgid: 'cloudwalker-honeypot', payload: { host_ip: '10.0.0.5' } } },
    { type: 'honeypot', matched: false, reason: `牧云事件查询失败：${upstream}` },
    { case_dir: directory, files: ['03-研判事实.md'] });
  // 文档：这两条不再保留 `牧云事件…失败：` 徽标，一律固定文案 + 原文字符量。
  assert.match(result.verdict.missing_evidence[0], /^上游调用失败，原文 \d+ 字未落盘$/,
    `missing_evidence 是带徽标的原文：${result.verdict.missing_evidence[0]}`);
  assert.match(result.verdict.analysis, /上游调用失败，原文 \d+ 字未落盘/,
    `analysis 不是闸后文案：${result.verdict.analysis}`);
  assert.equal(JSON.stringify(result).includes(MARKER), false, '研判记录里漏了原文');
  assert.equal(JSON.stringify(result).includes('牧云事件查询失败：'), false, '徽标前缀不该保留');
});

// ── A3：readConfig().error 的闸（triage-rules.md:388）─────────────────────────
test('A3 triage-rules：规则文件非法时 readConfig().error 是闸后文案，原文不进返回体', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t054-a3-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(directory, 'triage-rules.json');
  // 非法 JSON 且正文含标记：V8 的报错会把开头几个字抄进 error.message，正是这道闸要挡的形态。
  await writeFile(file, `{"config": ${MARKER}}`);
  const config = await new TriageRuleEngine(file).readConfig();
  assert.equal(config.origin, 'invalid');
  assert.match(config.error, GATED, `readConfig().error 不是闸后文案：${config.error}`);
  assert.equal(JSON.stringify(config).includes(MARKER), false, 'readConfig 返回体里漏了原文');
  assert.match(String(config.revision), /^[0-9a-f]{16}$/, '文件存在但非法时 revision 仍是原文件指纹');
});

// ── A7：drain 收尾 catch 的 lastError（triage-pipeline.md:1033）───────────────
test('A7 研判收尾抛错：summary().last_error 过闸，队列文件不带原文，日志行仍留原文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t054-a7-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(JSON.parse(line)) }));
  t.after(() => useJournal());
  const raw = `${MARKER} 写盘炸了`;
  const monitor = new TriageMonitor({ service: {}, inputMode: 'poll', concurrency: 1,
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    history: { save: async result => result }, investigator: { run: async () => ({}) } });
  // 只换注「研判本身抛错」一件：run() 的各失败分支都在内部收口，这个 catch 是最后一道兜底。
  monitor.run = async () => { throw new Error(raw); };
  await monitor.load();
  await monitor.enqueue('honeypot:7');
  for (let n = 0; n < 200 && !monitor.lastError; n++) await new Promise(resolve => setImmediate(resolve));
  // 文档原话：drain 兜底 catch → `研判状态保存失败：本地写入失败，原文 N 字未落盘`。
  assert.match(String(monitor.lastError), /^研判状态保存失败：本地写入失败，原文 \d+ 字未落盘$/,
    `lastError 不是文档文案：${monitor.lastError}`);
  assert.equal(monitor.summary().last_error, monitor.lastError, '状态摘要与 lastError 同口径');
  await monitor.writeChain;
  const rawFile = await readFile(path.join(directory, 'state.json'), 'utf8').catch(() => '');
  assert.equal(rawFile.includes(MARKER), false, '队列状态文件里漏了原文');
  // 日志侧不归这道闸（triage-pipeline.md:527）：诊断要原文。
  const logged = lines.filter(line => line.event === 'triage.persist_failed');
  assert.ok(logged.length >= 1, `应有一条 triage.persist_failed：${JSON.stringify(lines.map(l => l.event))}`);
  assert.equal(String(logged[0].error).includes(MARKER), true, 'triage.persist_failed 日志行丢了原文');
});
