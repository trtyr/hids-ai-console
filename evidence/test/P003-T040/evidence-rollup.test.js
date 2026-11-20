// P003-T040 证据落盘复算单测。全部替身（假牧云工具箱 + 假模型），不碰真实网络 / 外部服务 / 真实时钟。
// 一条 triage 研判走完：案卷里要有必查项结果（前 5 行 + returned_count + total）与 view 原文；
// 复算（重跑）只读盘——替身牧云的调用计数在复算前后必须不变。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent, persistedEvidenceViewMax } from '../../../investigation-agent.js';
import { boundSyslogView, compactEvidenceView, projectEvidence, syslogOmittedFieldsLimit } from '../../../evidence-view.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { requiredEvidenceFile, requiredEvidenceMaxChars, readRequiredEvidence, writeRequiredEvidence } from '../../../syslog-case.js';
import { TraceBoardService, findingsRowLimit, findingsRowsMaxChars } from '../../../trace-board.js';
import { queueArgValueMaxChars, queueEvidenceItem } from '../../../triage-monitor.js';
import { KnowledgeStore } from '../../../knowledge-store.js';
import { knowledgeFields } from '../../../knowledge-workbench.js';

const syslogContext = (caseInfo) => ({ parsed: { msgid: 'cloudwalker-suspicious-command', ts: '2026-11-03T08:00:00Z',
  payload_format: 'keyvalue', payload: { event_id: '7', host_ip: '10.0.0.5', source_ip: '192.0.2.2',
    target_ip: '10.0.0.5', user_name: 'root', process_command_line: 'id' } },
  context: {}, match: { matched: false }, caseInfo });

// 8 条事件：够出「前 5 行」与 total 12，且不到一页（50）。
const rows = Array.from({ length: 8 }, (_, index) => ({ id: 100 + index, host_view: { host_ip: '10.0.0.5' },
  cmdline: `cmd-${index}`, created_at: 1762000000 + index }));

function triageHarness({ caseDir = null, evidenceRows = rows } = {}) {
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => [
      { name: 'get_suspicious_operation_event', inputSchema: { type: 'object',
        properties: { id: { type: 'number' } }, required: ['id'] } },
      { name: 'list_host_events', inputSchema: { type: 'object',
        properties: { host_id: { type: 'number' }, types: { type: 'array' }, count: { type: 'number' } },
        required: ['host_id'] } }
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return name === 'get_suspicious_operation_event'
        ? { id: 7, host_view: { host_id: 41, host_ip: '10.0.0.5' }, cmdline: 'id', description: '执行 id 命令',
          cmdlines: ['id', 'whoami'] }
        : { total: 12, events: evidenceRows };
    }
  });
  const model = { model: 'fake', complete: async (_messages, tools) => ({ content: JSON.stringify(tools.length
    ? { verdict: '存疑', confidence: '低', summary: '需核查命令后续行为',
      claims: [{ text: '执行命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'id' }] }],
      missing_data: [] }
    : { assessment: 'supported', concerns: [], missing_evidence: [] }) }) };
  return { calls, agent: new InvestigationAgent(toolbox, model) };
}

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A1+A2+A8 一条 triage 研判走完：案卷有必查项前 5 行与计数，证据带 view 原文；复算只读盘不再发 RPC', async t => {
  const caseDir = await mkdtemp(path.join(tmpdir(), 'hids-t040-case-'));
  t.after(() => rm(caseDir, { recursive: true, force: true }));
  const caseInfo = { case_dir: caseDir, files: [] };
  const { calls, agent } = triageHarness();
  const result = await agent.run('suspicious_operation:7', { mode: 'triage', streamContext: syslogContext(caseInfo) });

  // A2：每条证据 hash + 投影 view 原文，sha256 覆盖面不变。
  const original = result.evidence.find(item => item.evidence_id === 'cw:1');
  assert.match(original.sha256, /^[0-9a-f]{64}$/);
  assert.equal(original.view.facts.command_line.value, 'id');
  // 引用能事后复算：citation 的 pointer/value 在落盘 view 里点得到。
  const citation = result.verdict.claims[0].citations[0];
  assert.equal(original.view.facts.command_line.pointer, citation.pointer);
  assert.equal(original.view.facts.command_line.value, citation.value);
  const related = result.evidence.find(item => item.evidence_id === 'cw:2');
  assert.equal(related.view.returned_count, 8);
  assert.equal(related.view.items.length, 5);

  // A1：案卷里有 06-必查项.json，每项带前 5 行 + returned_count + total。
  assert.ok(caseInfo.files.includes(requiredEvidenceFile));
  const checks = await readRequiredEvidence(caseInfo);
  const related_check = checks.checks.find(item => item.id === 'related_events');
  assert.equal(related_check.evidence_id, 'cw:2');
  assert.equal(related_check.status, 'records_returned');
  assert.equal(related_check.returned_count, 8);
  assert.equal(related_check.total_reported, 12);
  assert.equal(related_check.first_rows.length, 5);
  assert.equal(related_check.first_rows[0].facts.event_id.value, 100);
  // 没有证据编号的项（缺数据源 / 缺标识）不出 first_rows，口径不变。
  assert.equal(checks.checks.find(item => item.id === 'authorization').first_rows, undefined);
  assert.equal((await readFile(path.join(caseDir, requiredEvidenceFile), 'utf8')).length <= requiredEvidenceMaxChars, true);

  // A8：复算（重读案卷 + 研判记录）不发起任何新 RPC。
  const before = calls.length;
  await readRequiredEvidence(caseInfo);
  await new InvestigationStore(path.join(caseDir, 'results')).save(result);
  assert.equal(calls.length, before, '复算路径不允许再发牧云 RPC');
});

test('A3 deep 模式：原始事件的投影 view 随 evidence[] 进研判记录（InvestigationStore 落盘）', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t040-deep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { calls, agent } = triageHarness();
  const result = await agent.run('suspicious_operation:7', { mode: 'deep' });
  assert.equal(result.mode, 'deep');
  const original = result.evidence.find(item => item.evidence_id === 'cw:1');
  assert.equal(original.tool, 'get_suspicious_operation_event');
  assert.match(original.sha256, /^[0-9a-f]{64}$/);
  assert.equal(original.view.facts.host_id.value, 41);
  assert.equal(original.view.related_sequences.cmdlines.total_in_record, 2);

  const store = new InvestigationStore(directory);
  await store.save(result);
  const saved = await store.latest('suspicious_operation:7', 'deep');
  assert.equal(saved.evidence.find(item => item.evidence_id === 'cw:1').view.facts.command_line.value, 'id');
  const before = calls.length;
  await store.latest('suspicious_operation:7', 'deep');
  assert.equal(calls.length, before);
});

test('A5 必查项落盘有字节上界：超界先降级成只留计数，再放不下才记 omitted_items', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t040-bound-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caseInfo = { case_dir: directory, files: [] };
  const fat = index => ({ id: `check-${index}`, label: `第 ${index} 项`, tool: 'list_host_events', scope: '同主机',
    status: 'records_returned', evidence_id: `cw:${index}`, returned_count: 8, total_reported: 12,
    first_rows: Array.from({ length: 5 }, (_, row) => ({ facts: {
      cmdline: { value: `${'长'.repeat(200)}-${index}-${row}`, pointer: `/events/${row}/cmdline` } } })) });
  const body = await writeRequiredEvidence(caseInfo, { alertId: 'suspicious_operation:7', mode: 'triage',
    checks: Array.from({ length: 120 }, (_, index) => fat(index)) });
  const text = await readFile(path.join(directory, requiredEvidenceFile), 'utf8');
  assert.ok(text.length <= requiredEvidenceMaxChars, `落盘 ${text.length} 超出 ${requiredEvidenceMaxChars}`);
  assert.ok(body.slimmed_items > 0, '超界项应降级成只留计数');
  const slim = body.checks.find(item => item.first_rows === undefined && item.returned_count === 8);
  assert.ok(slim, '降级项要留 returned_count / total，不能整项消失');
  // 每项都还在：要么全量、要么降级、要么计入 omitted_items——不静默丢。
  assert.equal(body.checks.length + (body.omitted_items || 0), 120);
});

test('A5 降级回包的 omitted_fields 封顶：4KB 载荷不再吐出比上限还长的记账', () => {
  const payload = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field_${index}`, `v${index}`]));
  const view = { msgid: 'honeypot', payload };
  assert.ok(JSON.stringify(view).length > 3000);
  const bounded = boundSyslogView(view, 3000);
  assert.ok(JSON.stringify(bounded).length <= 3000, '回包必须落在上限内');
  assert.equal(bounded.omitted_fields.length, syslogOmittedFieldsLimit);
  assert.ok(bounded.omitted_fields_total > syslogOmittedFieldsLimit, '超出部分只报总数');

  // 兜底分支（字段多到整条都不给）同样封顶。
  const many = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, index]));
  const fallback = boundSyslogView({ msgid: 'honeypot', payload: many }, 3000);
  assert.ok(JSON.stringify(fallback).length <= 3000);
  assert.ok((fallback.omitted_fields?.length ?? 0) <= syslogOmittedFieldsLimit);
});

test('A4 白板 findings 按页落完整投影（不再只留 12 行），超界只缩行并记 rows_omitted', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t040-findings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const events = Array.from({ length: 30 }, (_, index) => ({ id: 200 + index, event_type: 'honeypot',
    host_view: { host_ip: '172.20.208.23' }, source_ip: '64.177.57.21',
    title: '蜜罐事件', created_at: nowSeconds - index * 60 }));
  const toolbox = { listTools: async () => ['list_global_events', 'list_honeypot_events'].map(name => ({ name })),
    investigation: () => ({ started: 0, maxCalls: 200, records: new Map(),
      async callTool(name) {
        const record = { evidenceId: `cw:${++this.started}`, tool: name, result: { total: 30, events } };
        this.records.set(record.evidenceId, record);
        return record;
      }, verifyClaims: () => ({ ok: true }) }) };
  const actions = [{ action: 'investigate', node: 'ip:64.177.57.21', why: '查这个来源碰过哪些主机' },
    { action: 'conclude', summary: '只有触达线索', gaps: [] }];
  const service = new TraceBoardService({ directory, toolbox,
    model: { model: 'fake', complete: async () => ({ content: JSON.stringify(actions.shift()) }) },
    promptStore: { load: async () => ({ prompts: { trace: '追查目标' } }) } });
  await service.start('64.177.57.21');
  await service.running.get('ip:64.177.57.21');
  const board = await service.get('64.177.57.21');
  const finding = board.nodes.find(node => node.id === board.seed)
    .findings.find(item => item.tool === 'list_honeypot_events');
  assert.ok(finding, '落盘的 findings 里必须能找到这次工具调用');
  assert.equal(finding.returned, 30);
  assert.equal(finding.rows.length, 30, '整页 30 行都要落盘，不再截到 12 行');
  assert.ok(finding.rows.length <= findingsRowLimit);
  assert.equal(finding.rows_omitted, 0);
  assert.equal(finding.truncated, false);
  // 每行投影带 pointer，复算时能指回原始结果。
  assert.equal(finding.rows[0].facts.event_id.pointer, '/events/0/id');

  // 上界本身是可验证的常量：一页最多 50 行、每工具调用 16000 字。
  assert.equal(findingsRowLimit, 50);
  assert.equal(findingsRowsMaxChars, 16000);
});

test('A6 队列 evidence[]：RPC 形态 args 保留，含原文的才剥并标 args_omitted', () => {
  const kept = queueEvidenceItem({ evidence_id: 'cw:1', tool: 'get_honeypot_event', args: { id: 7 },
    fetched_at: '2026-11-03T08:00:01.000Z', sha256: 'a'.repeat(64) });
  assert.deepEqual(kept.args, { id: 7 });
  assert.equal(kept.args_omitted, undefined);

  const paged = queueEvidenceItem({ evidence_id: 'cw:2', tool: 'list_host_events', args: { count: 20, offset: 0 },
    fetched_at: '2026-11-03T08:00:01.000Z', sha256: 'b'.repeat(64) });
  assert.deepEqual(paged.args, { count: 20, offset: 0 });

  const raw = queueEvidenceItem({ evidence_id: 'cw:3', tool: 'list_full_commands', args: { command: 'x'.repeat(queueArgValueMaxChars + 1) },
    fetched_at: '2026-11-03T08:00:01.000Z', sha256: 'c'.repeat(64) });
  assert.equal(raw.args, undefined, '含原文的 args 不落队列');
  assert.equal(raw.args_omitted, true);
  assert.equal(raw.sha256, 'c'.repeat(64), '剥 args 不动摘要');

  // syslog:1 的空入参也保留：它本身就是「查了什么」的一部分。
  const syslog = queueEvidenceItem({ evidence_id: 'syslog:1', tool: 'received_syslog', args: {},
    fetched_at: '2026-11-03T08:00:00.000Z', sha256: 'd'.repeat(64) });
  assert.deepEqual(syslog.args, {});
});

test('A7 评估结论：description 与 cmdlines 纳入 agent 证据视图（含字符串命令行）', () => {
  const result = { event: { id: 7, cmdline: 'id', description: '执行 id 命令',
    cmdlines: ['id', { seq: 2, cmdline: 'whoami' }] } };
  const view = projectEvidence('get_suspicious_operation_event', result);
  assert.equal(view.facts.description.value, '执行 id 命令');
  assert.equal(view.facts.description.pointer, '/event/description');
  const cmdlines = view.related_sequences.cmdlines;
  assert.equal(cmdlines.total_in_record, 2);
  assert.equal(cmdlines.shown_count, 2);
  assert.deepEqual(cmdlines.shown[0].facts.cmdline,
    { value: 'id', pointer: '/event/cmdlines/0' });
  assert.equal(cmdlines.shown[1].facts.cmdline.value, 'whoami');

  // 模型侧展示上限：12 条会话命令只给头 2 + 尾 2，计数保留（A5 上界）。
  const many = projectEvidence('get_suspicious_operation_event', { event: { cmdlines:
    Array.from({ length: 12 }, (_, index) => `c${index}`) } });
  const compact = compactEvidenceView(many);
  assert.equal(compact.related_sequences.cmdlines.total_in_record, 12);
  assert.equal(compact.related_sequences.cmdlines.shown_count, 4);
  assert.deepEqual(compact.related_sequences.cmdlines.shown.map(row => row.facts.cmdline.value),
    ['c0', 'c1', 'c10', 'c11']);

  // 落盘的单条 view 上界（A5）：persistedEvidenceViewMax 是契约常量。
  assert.equal(persistedEvidenceViewMax, 6000);
  const digest = createHash('sha256').update('probe').digest('hex');
  assert.equal(digest.length, 64);
});

test('A1 复审 major：捷径路径写案卷失败当场抛，不被「经验核对失败」吞掉也不白跑一整轮', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t040-shortcut-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(path.join(directory, 'knowledge'));
  const created = await store.create();
  await store.update(created.id, current => {
    current.status = 'published'; current.scenario_id = 'suspicious_operation';
    current.review = { reviewed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString() };
    current.fields = Object.fromEntries(knowledgeFields.map(([key]) => [key, { value: `${key} 已核对` }]));
    current.fields.reason.value = '已核对本次巡检授权';
    return current;
  });
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_suspicious_operation_event',
      inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => ({ event_id: 7, host_view: { host_name: 'app-7' }, cmdline: 'systemctl status nginx' })
  });
  let modelCalls = 0;
  const model = { model: 'fake', complete: async () => { modelCalls++; return { content: JSON.stringify({
    case_id: created.id, matched: true, summary: '同一主机的已授权巡检',
    claims: [
      { text: '主机为 app-7', citations: [{ evidence_id: 'cw:1', pointer: '/host_view/host_name', value: 'app-7' }] },
      { text: '执行巡检命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'systemctl status nginx' }] }
    ], unverified_conditions: [], conflicts: [] }) }; } };
  // 案卷目录不存在：写 06-必查项.json 必失败。捷径路径的落盘在知识库 try 块之外，失败要原样抛出。
  const caseInfo = { case_dir: path.join(directory, 'no-such-case'), files: [] };
  const agent = new InvestigationAgent(toolbox, model, undefined, store);
  await assert.rejects(() => agent.run('suspicious_operation:7',
    { mode: 'triage', streamContext: syslogContext(caseInfo) }), error => {
    assert.match(String(error.code || error.message), /ENOENT|no such file/i);
    // 错误是案卷写不出来，不是「经验核对失败，继续完整研判」——归因不许写错。
    assert.doesNotMatch(String(error.message), /经验核对失败/);
    return true;
  });
  // 捷径命中就落盘、失败就抛：不再进调查循环「白跑一整轮」。
  assert.equal(modelCalls, 1);
  assert.deepEqual(caseInfo.files, [], '失败的落盘不能留下半个白名单项');
});
