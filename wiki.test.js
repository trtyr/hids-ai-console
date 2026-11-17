import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WikiStore } from './wiki-store.js';
import { WikiWorkbench } from './wiki-workbench.js';
import { createServer } from './server.js';
import { AgentToolbox } from './agent-tools.js';
import { InvestigationAgent } from './investigation-agent.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-wiki-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'wiki');
  await Promise.all(['common', 'honeypot', 'customer-experience', '_evidence', 'concepts'].map(name =>
    mkdir(path.join(directory, name), { recursive: true })));
  await writeFile(path.join(directory, 'index.md'), '# Wiki 入口\n');
  await writeFile(path.join(directory, '_evidence', 'customer-case.md'), '# 客户案例来源\n');
  await writeFile(path.join(directory, 'concepts', '硬证据.md'), '# 硬证据\n');
  await writeFile(path.join(directory, '_schema.md'), '# 先有证据再写判据\n');
  await writeFile(path.join(directory, 'log.md'), '# 日志\n');
  await writeFile(path.join(directory, 'common', 'GEN-01.md'),
    '---\nid: GEN-01\ntitle: 通用事实原则\nstatus: active\nsource: 现场记录\n---\n\n事实要有出处。\n');
  await writeFile(path.join(directory, 'honeypot', 'HP-01.md'),
    '---\nid: HP-01\ntitle: 蜜罐背景扫描\nstatus: active\nsource: ENISA\nevidence: [_evidence/customer-case.md]\n---\n\n外网背景扫描需要核对请求。\n');
  return { root, directory, wiki: new WikiStore(directory) };
}

test('wiki search stays in the current alert class and page revisions protect edits', async t => {
  const { wiki } = await fixture(t);
  const index = await wiki.agentIndex('honeypot');
  assert.deepEqual(index.pages.map(page => page.id), ['GEN-01', 'HP-01']);
  assert.ok((await wiki.browse()).some(page => page.path === '_evidence/customer-case.md'));
  assert.ok((await wiki.browse()).some(page => page.path === 'concepts/硬证据.md'));
  await assert.rejects(() => wiki.get('../server.js'), /路径无效/);
  assert.equal((await wiki.agentSearch('honeypot', '背景扫描'))[0].id, 'HP-01');
  await assert.rejects(() => wiki.agentPage('webshell', 'HP-01'));
  const original = await wiki.get('honeypot/HP-01.md');
  const next = await wiki.update(original.path, original.content.replace('需要核对', '必须核对'), original.revision);
  assert.notEqual(next.revision, original.revision);
  await assert.rejects(() => wiki.update(original.path, original.content, original.revision), /已更新/);
});

test('customer experience remains outside triage until conversation and human publication', async t => {
  const { root, wiki } = await fixture(t);
  const words = ['原始告警 H-7', '甲客户生产环境', '堡垒机账号 A', '执行巡检命令', '人工判定误报',
    '工单 OPS-7', '同一账号与命令', '出现外联就失效', '30 天后复核'];
  const fields = Object.fromEntries(['record_ref', 'customer_scope', 'subject_scope', 'behavior', 'reason',
    'supporting_evidence', 'applicability', 'counterexample', 'validity'].map((key, i) =>
    [key, { value: words[i], source_quote: words[i] }]));
  const model = { complete: async messages => {
    const input = JSON.parse(messages[1].content);
    const id = input.current_page.match(/^id: (EX-\d+)/m)[1];
    const body = `---\nid: ${id}\ntitle: 运维巡检误报经验\nstatus: draft\nsource: 客户口述并经人工核验\n---\n\n# 运维巡检误报经验\n\n\`\`\`json\n${JSON.stringify({ id, title: '运维巡检误报经验', scenario_id: 'suspicious_operation', fields })}\n\`\`\``;
    return { content: JSON.stringify({ reply: '已整理，待审核。', ready: true, proposed_content: body, rationale: '工单与命令可核对' }) };
  } };
  const prompts = { load: async () => ({ prompts: { knowledge: '整理 Wiki' } }) };
  const workbench = new WikiWorkbench(wiki, model, prompts, path.join(root, 'sessions'));
  const draft = await workbench.create('new-experience');
  assert.equal((await wiki.publishedFor('suspicious_operation')).length, 0);
  const ready = await workbench.reply(draft.id, words.join('；'));
  assert.equal(ready.status, 'ready_for_review');
  assert.equal((await wiki.publishedFor('suspicious_operation')).length, 0);
  const result = await workbench.publish(draft.id, { verdict: 'false_positive',
    valid_until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    note: '已核查原始工单和堡垒机会话记录' });
  assert.equal(result.page.status, 'active');
  assert.equal((await wiki.publishedFor('suspicious_operation')).length, 1);
  assert.match(await readFile(path.join(wiki.directory, 'log.md'), 'utf8'), /ingest/);
});

test('wiki maintenance reads the criterion and its cited evidence before proposing a change', async t => {
  const { root, wiki } = await fixture(t);
  const model = { complete: async messages => {
    const input = JSON.parse(messages[1].content);
    assert.match(input.current_page, /HP-01/);
    assert.equal(input.related_evidence[0].path, '_evidence/customer-case.md');
    return { content: JSON.stringify({ ready: false, reply: '请补充这次告警的原始记录。', proposed_content: '', rationale: '缺少原始记录' }) };
  } };
  const workbench = new WikiWorkbench(wiki, model, { load: async () => ({ prompts: { knowledge: '维护' } }) },
    path.join(root, 'sessions'));
  const session = await workbench.create('honeypot/HP-01.md');
  const reply = await workbench.reply(session.id, '我认为这次是误报');
  assert.equal(reply.status, 'collecting');
  assert.match(reply.messages.at(-1).content, /原始记录/);
});

test('case feedback stays pending until reviewed and publishes evidence with the revised criteria', async t => {
  const { root, wiki } = await fixture(t);
  const caseDir = path.join(root, 'case');
  await mkdir(caseDir);
  await writeFile(path.join(caseDir, '01-原始告警.txt'), 'cloudwalker-honeypot source_ip=192.0.2.8');
  await writeFile(path.join(caseDir, '03-研判事实.md'), '# 事实\n仅有一次根路径请求');
  await writeFile(path.join(caseDir, '05-研判结果.md'), '结论：真实威胁');
  await writeFile(path.join(caseDir, 'result.json'), '{"verdict":{"verdict_label":"真实威胁"}}');
  const model = { complete: async messages => {
    const input = JSON.parse(messages[1].content);
    assert.equal(input.feedback.case_id, 'syslog:case-7');
    assert.match(input.feedback.case_snapshot['01-原始告警.txt'], /192.0.2.8/);
    return { content: JSON.stringify({ diagnosis: 'criterion_gap', ready: true, reply: '已形成待审核草案', rationale: '仅有探测，需核对授权',
      proposed_content: `---\nid: HP-01\ntitle: 蜜罐背景扫描\napplies_to: [honeypot]\nstatus: active\nupdated: 2026-11-10\nsource: 现场记录\n---\n\n单次根路径请求不能直接证明入侵；需要核对授权和后续行为。` }) };
  } };
  const workbench = new WikiWorkbench(wiki, model,
    { load: async () => ({ prompts: { knowledge: '整理 Wiki' } }) }, path.join(root, 'sessions'));
  const session = await workbench.create('honeypot/HP-01.md', {
    case_id: 'syslog:case-7', case_dir: caseDir, event_type: 'honeypot',
    reason: '人工核对后发现只是一次授权扫描，未见后续交互', expected_verdict: 'false_positive', who: '值班分析员' });
  const draft = await workbench.reply(session.id, '工单 OPS-7 说明这次扫描已获授权');
  assert.equal(draft.status, 'ready_for_review');
  assert.equal((await wiki.get('honeypot/HP-01.md')).revision, session.page_revision);
  assert.match(draft.proposal.content, /_evidence\/feedback-/);
  const replay = await workbench.replay(session.id);
  assert.equal(replay.proposal.replay.status, 'needs_review');
  await assert.rejects(() => workbench.publish(session.id, { reviewer: 'A', note: '太短' }), /审核人/);
  const result = await workbench.publish(session.id,
    { reviewer: '值班主管', note: '已核对案件和工单，保留授权与后续行为的适用边界',
      replay_override_reason: '测试模型只提供草案，回放无法形成有效三态结论；本次人工逐项核对了冻结案件、工单和判据适用边界。' });
  assert.equal(result.session.status, 'published');
  assert.equal(result.session.audit.reviewer, '值班主管');
  assert.match((await wiki.get('honeypot/HP-01.md')).content, /feedback-/);
  assert.match((await wiki.get(result.session.audit.evidence_path)).content, /syslog:case-7/);
  assert.match(await readFile(path.join(wiki.directory, 'log.md'), 'utf8'), /值班主管/);
});

test('case feedback with missing data stays out of the Wiki publication path', async t => {
  const { root, wiki } = await fixture(t);
  const caseDir = path.join(root, 'case');
  await mkdir(caseDir);
  await writeFile(path.join(caseDir, '01-原始告警.txt'), 'cloudwalker-honeypot source_ip=192.0.2.8');
  await writeFile(path.join(caseDir, '03-研判事实.md'), '# 事实\n缺少详情');
  const page = await wiki.get('honeypot/HP-01.md');
  const model = { complete: async () => ({ content: JSON.stringify({ diagnosis: 'data_gap', ready: true,
    reply: '缺少完整请求记录，应先补齐案件数据。', rationale: '判据本身未发现错误',
    proposed_content: page.content.replace('需要核对', '不需要核对') }) }) };
  const workbench = new WikiWorkbench(wiki, model, { load: async () => ({ prompts: { knowledge: '维护' } }) }, path.join(root, 'sessions'));
  const session = await workbench.create(page.path, { case_id: 'syslog:case-8', case_dir: caseDir,
    event_type: 'honeypot', reason: '告警只有来源地址，原始请求记录未能查询到',
    expected_verdict: 'uncertain', who: '值班分析员' });
  const result = await workbench.reply(session.id, '先补齐原始请求记录，再复核这条案件');
  assert.equal(result.status, 'needs_non_wiki_fix');
  assert.equal(result.diagnosis, 'data_gap');
  assert.match(result.follow_up.target, /Syslog/);
  assert.equal(result.proposal, null);
  await assert.rejects(() => workbench.publish(session.id, { reviewer: '值班主管', note: '已复核数据' }), /没有可审核/);
  assert.equal((await wiki.get(page.path)).revision, page.revision);
});

test('new external source is published only after original text review', async t => {
  const { root, wiki } = await fixture(t);
  const original = await wiki.get('honeypot/HP-01.md');
  const quote = '外部资料原文片段需要逐项核查';
  const model = { complete: async () => ({ content: JSON.stringify({ ready: true, reply: '待审核原文',
    rationale: '来源补充了对请求行为的解释',
    proposed_content: original.content.replace('需要核对请求', '需要核对请求内容和后续行为')
      .replace('status: active', 'status: active\napplies_to: [honeypot]\nupdated: 2026-11-10'),
    new_evidence: { url: 'https://example.org/honeypot-request', title: '蜜罐请求调查原文', quote,
      claim: '单次请求不足以证明入侵成功', limits: '只用于解释请求特征，不证明客户授权', checked_at: '2026-11-10' } }) }) };
  const workbench = new WikiWorkbench(wiki, model, { load: async () => ({ prompts: { knowledge: '维护' } }) }, path.join(root, 'sessions'));
  const session = await workbench.create(original.path);
  const draft = await workbench.reply(session.id, `请依据 https://example.org/honeypot-request 修订；原文：${quote}`);
  assert.equal(draft.status, 'ready_for_review');
  assert.equal(draft.proposal.evidence_preview.kind, 'external');
  const replay = await workbench.replay(session.id);
  assert.equal(replay.proposal.replay.status, 'no_cases');
  await assert.rejects(() => workbench.publish(session.id, { reviewer: '值班主管', note: '已核查原文支持的命题和适用范围', replay_no_cases_ack: true }), /核查新证据原文/);
  const result = await workbench.publish(session.id, { reviewer: '值班主管',
    note: '已核查原文支持的命题和适用范围', source_verified: true, replay_no_cases_ack: true });
  assert.match((await wiki.get(result.session.audit.evidence_path)).content, /example.org\/honeypot-request/);
  assert.match((await wiki.get(original.path)).content, /maint-/);
});

test('wiki pages are readable but maintenance requires the administrator token and backend files stay private', async t => {
  const { root, wiki } = await fixture(t);
  const workbench = new WikiWorkbench(wiki, null, { load: async () => ({ prompts: {} }) }, path.join(root, 'sessions'));
  const server = createServer(null, null, null, null, null, null, null, undefined, null, 'test-admin-token', wiki, workbench);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/wiki/pages`)).status, 200);
  const page = await (await fetch(`${base}/api/wiki/pages/honeypot%2FHP-01.md`)).json();
  assert.match(page.content, /外网背景扫描需要核对请求/);
  assert.equal((await fetch(`${base}/api/wiki/sessions`)).status, 403);
  assert.equal((await fetch(`${base}/api/wiki/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"page":"honeypot/HP-01.md"}' })).status, 403);
  assert.equal((await fetch(`${base}/backend/wiki/honeypot/HP-01.md`)).status, 404);
  const response = await fetch(`${base}/api/wiki/pages`, { headers: { 'X-Prompt-Admin-Token': 'test-admin-token' } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).pages.length >= 2);
});

test('triage reads a Wiki criterion while current alert facts come from the API toolbox', async t => {
  const { wiki } = await fixture(t);
  const calls = [];
  const toolbox = new AgentToolbox({
    listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} } } }],
    callTool: async (name, args) => { calls.push({ name, args }); return { event_id: 7, source_ip: '192.0.2.7' }; }
  });
  let turn = 0;
  const model = { model: 'test', complete: async messages => {
    turn++;
    if (turn === 1) {
      assert.match(messages[1].content, /HP-01/);
      assert.match(messages[1].content, /外网背景扫描需要核对请求/);
      assert.match(messages[1].content, /事实要有出处/);
      assert.match(messages[1].content, /客户已核验的历史浅层探测/);
      return { content: '', tool_calls: [{ id: 'wiki-call', function: { name: 'wiki_page', arguments: '{"id":"HP-01"}' } }] };
    }
    if (turn === 2) {
      assert.match(messages.at(-1).content, /外网背景扫描需要核对请求/);
      return { content: JSON.stringify({ verdict: '存疑', confidence: '低', summary: '请求内容尚待核查',
        claims: [{ text: '来源地址已记录', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }],
        missing_data: ['完整请求记录'] }) };
    }
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  } };
  const result = await new InvestigationAgent(toolbox, model, undefined, wiki).run('honeypot:7', {
    mode: 'triage', ruleEvaluation: { status: 'candidate', revision: 'rule-v1',
      rule: { id: 'known-probe', reason: '客户已核验的历史浅层探测', approved_by: '安全负责人',
        expires_at: '2099-01-01T00:00:00Z' }, facts: [{ field: 'source_ip', value: '192.0.2.7', pointer: '/source_ip' }],
      evidence_sha256: 'a'.repeat(64) } });
  assert.deepEqual(calls.map(call => call.name), ['get_honeypot_event']);
  assert.equal(result.verdict.verdict, 'uncertain');
  assert.ok(result.trace.some(item => item.kind === 'rule' && item.action === 'candidate'));
  assert.ok(result.trace.some(item => item.kind === 'wiki' && item.id === 'HP-01'));
});
