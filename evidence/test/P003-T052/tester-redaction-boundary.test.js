// P003-T052 · 测试侧补充用例（tester 自建，何东阳）。
//
// 只测写者用例没盖住的那几口 + 边界，断言一律按文档：
//   docs/modules/triage-pipeline.md §6.3 / §失败处理（队列侧四个落点过闸、日志行留原文）
//   docs/modules/investigation-agent.md §3.2（记录侧一律固定文案 + 原文字符量）
//   docs/modules/knowledge-base.md §5（回放 error 是闸后文案）
//   docs/modules/triage-pipeline.md §5.3 失败表（牧云详情读取失败 / 列表查询失败两条）
// 口径：只看公开落盘面（队列状态文件 / 返回体 / 状态摘要 / 日志行），不碰内部实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal, useJournal } from '../../../src/shared/logging/log.js';
import { parseSyslog } from '../../../src/contexts/ingestion/application/parsing.js';
import { matchSyslogEvent } from '../../../src/contexts/triage/application/correlate.js';
import { runWikiReplay } from '../../../wiki-replay.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { KnowledgeStore } from '../../../knowledge-store.js';
import { KnowledgeWorkbench } from '../../../knowledge-workbench.js';

const SECRET = 'SECRET_RAW_51c0 上游报文正文';
const secretError = () => new Error('connect ECONNREFUSED ' + SECRET);

const options = (directory, extra) => ({ file: path.join(directory, 'queue.json'), concurrency: 1,
  service: { alerts: async () => ({ alerts: [], partial: false }) },
  history: new InvestigationStore(path.join(directory, 'results')), ...extra });

async function waitFor(monitor, id) {
  for (let n = 0; n < 200; n++) {
    const record = monitor.status(id);
    if (record && !['queued', 'running'].includes(record.status)) return record;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`记录 ${id} 没有等到终态`);
}

// ── A2 复核补漏点：轮询失败 lastError（T051 §4 没点到、写者用例也没盖）──────────
test('A2 轮询失败 lastError：状态摘要里不写牧云报错原文，日志行照旧留原文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-poll-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(JSON.parse(line)) }));
  try {
    const monitor = new TriageMonitor(options(directory, { inputMode: 'poll',
      service: { alerts: async () => { throw secretError(); } } }));
    await monitor.load();
    const polled = await monitor.poll();
    assert.equal(polled.failed, true);
    // 文档（triage-pipeline §5 summary()）：last_error 是状态接口那格，记录侧口径 = 固定文案 + 原文字符量。
    assert.match(monitor.summary().last_error, /^上游调用失败，原文 \d+ 字未落盘$/);
    assert.doesNotMatch(JSON.stringify(monitor.summary()), /SECRET_RAW/);
    // 日志侧归 P003-T046：诊断要原文，这一份不许跟着被抹。
    assert.ok(lines.some(line => line.event === 'triage.poll_failed' && String(line.error).includes('SECRET_RAW')),
      'triage.poll_failed 的日志行仍应带原文');
  } finally { useJournal(); }
});

// ── O6 第二支：牧云事件 ID 详情读取失败（写者用例只盖了列表查询那一支）──────────
test('O6 详情读取失败：返回体过闸、日志行留原文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-detail-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(JSON.parse(line)) }));
  try {
    const parsed = parseSyslog('<14>1 2026-11-11T08:00:00Z host cloudwalker 1 '
      + 'cloudwalker-honeypot host_ip="10.0.0.5" host_id=1 event_create_time="2026-11-11 08:00:00" '
      + 'source_ip="192.0.2.2" event_id=7');
    const match = await matchSyslogEvent({ callTool: async () => { throw secretError(); } }, parsed);
    assert.equal(match.matched, false);
    assert.match(match.reason, /^上游调用失败，原文 \d+ 字未落盘$/);
    assert.doesNotMatch(match.reason, /SECRET_RAW/);
    assert.ok(lines.some(line => line.event === 'syslog.match_failed' && String(line.reason).includes('SECRET_RAW')),
      'syslog.match_failed 的日志行仍应带原文（P003-T027 契约）');
  } finally { useJournal(); }
});

// ── O8 第二支：回包不是合法 JSON（knowledge-base §5 承诺的文案）───────────────
test('O8 回包解析失败：before/after.error 是闸后文案，原文不落报告', async t => {
  const caseDir = await mkdtemp(path.join(tmpdir(), 'hids-t052-no-cases-'));
  t.after(() => rm(caseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const wiki = { get: async file => ({ path: file, id: 'HP-01', revision: 3,
      content: '---\nid: HP-01\nstatus: active\n---\n判据原文：需核对授权。' }),
    agentIndex: async () => ({ pages: [{ id: 'HP-01', path: 'honeypot/HP-01.md', title: '蜜罐', content: '' }] }) };
  const record = { id: 's1', proposal: { changes: [{ path: 'honeypot/HP-01.md', page_revision: 3, content: 'new' }] },
    feedback: { case_id: 'syslog:case-1', event_type: 'honeypot', expected_verdict: 'false_positive',
      case_snapshot: { '01-原始告警.txt': 'raw alert text', '03-研判事实.md': '仅一次探测' } } };
  const prompts = { load: async () => ({ revision: 1, prompts: {} }) };
  const report = await runWikiReplay({ record, directory: caseDir,
    prompts, wiki, model: { model: 'fake', complete: async () => ({ content: '{"verdict": ' + SECRET + '}' }) } });
  const { before, after } = report.cases[0];
  assert.equal(before.error, after.error);
  assert.match(before.error, /^模型回包不是合法 JSON（SyntaxError），原文 \d+ 字未落盘$/);
  assert.equal(report.cases[0].status, 'invalid');
  assert.doesNotMatch(JSON.stringify(report), /SECRET_RAW/);
});

// ── 边界：非 Error 的 throw（第三方库抛字符串）不许把正文带进队列状态文件 ────────
test('O1 边界：抛字符串时记录侧一样只留固定文案 + 字符量，队列文件不含正文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-throw-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const monitor = new TriageMonitor(options(directory, { retryMaxAttempts: 1,
    investigator: { run: async () => { throw 'SECRET_RAW_51c0 上游字符串 ' + 'X'.repeat(20000); } } }));
  await monitor.load();
  await monitor.enqueue('honeypot:12');
  const record = await waitFor(monitor, 'honeypot:12');
  await monitor.writeChain;
  assert.equal(record.status, 'failed');
  assert.match(record.detail, /^上游调用失败，原文 \d+ 字未落盘$/);
  const raw = await readFile(path.join(directory, 'queue.json'), 'utf8');
  assert.doesNotMatch(raw, /SECRET_RAW/);
  // 20k 原文不许把状态文件撑大：只剩一条固定文案。
  assert.ok(raw.length < 20000, `队列状态文件被原文撑大了：${raw.length} 字节`);
});

// ── 边界：O4 超长原文不再 240 截断，但也不落原文 ─────────────────────────────
test('O4 边界：300 字原文只留全量字符量、不截断也不落原文，成功轮清空', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-kb-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const long = SECRET + 'y'.repeat(300);
  const prompts = { load: async () => ({ prompts: { knowledge: '整理' } }) };
  const store = new KnowledgeStore(directory);
  const workbench = new KnowledgeWorkbench(store, { complete: async () => { throw new Error(long); } }, prompts);
  const created = await workbench.create();
  const failed = await workbench.reply(created.id, '补充一句');
  assert.equal(failed.last_error, `知识整理失败，原文 ${long.length} 字未落盘`);
  assert.doesNotMatch(JSON.stringify(await new KnowledgeStore(directory).get(created.id)), /SECRET_RAW/);
  // 成功轮把 last_error 置空（experience-draft §8 R-EXPD-10）。
  const retry = new KnowledgeWorkbench(new KnowledgeStore(directory),
    { complete: async () => ({ content: JSON.stringify({ fields: {}, summary: '已补充', done: false }) }) }, prompts);
  const ok = await retry.reply(created.id, '再补一句');
  assert.equal(ok.last_error, null);
});

// ── O2b 超时变体（第六轮补）：文档承诺「超时类 → 调用超时」，写者六变体全是
//    Unexpected token 形状（只能出兜底「上游调用失败」）。triage-pipeline §失败处理 /
//    triage-rules §9 都写了 steps[].detail 与 result.rule_evaluation 的超时态，这里钉住。
test('O2b 超时变体：steps / result.rule_evaluation 归一到「调用超时」，回灌模型仍是原文', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t052-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const variant = '牧云事件查询失败：rpc timeout after 30s';
  const expected = `调用超时，原文 ${variant.length} 字未落盘`;
  let seen = null;
  const monitor = new TriageMonitor(options(directory, {
    ruleEngine: { evaluate: async () => ({ status: 'error', reason: variant }) },
    investigator: { run: async (alertId, { ruleEvaluation }) => { seen = ruleEvaluation;
      return { alert_id: alertId, mode: 'triage',
        verdict: { verdict: 'undetermined', summary: '待复核', claims: [] }, validation: { ok: true } }; } } }));
  await monitor.load();
  await monitor.enqueue('honeypot:31');
  const record = await waitFor(monitor, 'honeypot:31');
  assert.equal(record.status, 'done');
  assert.equal(record.steps.find(item => item.stage === '规则评估').detail, expected);
  await monitor.writeChain;
  const raw = await readFile(path.join(directory, 'queue.json'), 'utf8');
  assert.doesNotMatch(raw, /rpc timeout/);
  assert.doesNotMatch(raw, /牧云事件查询失败/);
  // A1 第二落点：result.rule_evaluation 随 result 进 result.json 与研判记录，同样过闸。
  const saved = await monitor.history.latest('honeypot:31', 'triage');
  assert.equal(saved.rule_evaluation.reason, expected);
  // A4：回灌给模型的那份仍是原文。
  assert.equal(seen.reason, variant);
});
