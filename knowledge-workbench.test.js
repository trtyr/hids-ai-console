import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench } from './knowledge-workbench.js';
import { createServer } from './server.js';

test('conversation keeps incomplete experience and resumes until ready for review', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(directory);
  let calls = 0;
  const model = { complete: async () => {
    calls++;
    if (calls === 1) return { content: JSON.stringify({ fields: {
      record_ref: { value: '蜜罐 7', source_quote: '蜜罐 7' },
      reason: { value: '属于运维扫描', source_quote: '运维扫描' },
      supporting_evidence: { value: '已有工单', source_quote: '不存在的工单' }
    }, summary: '已记录一条误报判断。', next_question: '请补充' }) };
    const quotes = {
      customer_scope: '甲客户生产环境', subject_scope: '10.0.0.7 的运维账号',
      behavior: '执行 systemctl status nginx', supporting_evidence: '核对了工单 OPS-42 和堡垒机会话记录',
      applicability: '仅限同一账号同一主机的巡检', counterexample: '出现下载或外联就不能复用',
      validity: '工单结束后失效'
    };
    return { content: JSON.stringify({ fields: Object.fromEntries(Object.entries(quotes)
      .map(([key, quote]) => [key, { value: quote, source_quote: quote }])), summary: '已补充边界。' }) };
  } };
  const prompts = { load: async () => ({ prompts: { knowledge: '整理候选知识' } }) };
  const workbench = new KnowledgeWorkbench(store, model, prompts);
  const created = await workbench.create();
  const first = await workbench.reply(created.id, '蜜罐 7 是运维扫描，所以我认为是误报。');
  assert.equal(first.status, 'needs_info');
  assert.equal(first.fields.reason.value, '属于运维扫描');
  assert.equal(first.fields.supporting_evidence, undefined);
  assert.match(first.messages.at(-1).content, /还需要补充/);
  const reopened = await new KnowledgeStore(directory).get(created.id);
  assert.equal(reopened.messages.length, 3);
  const second = await workbench.reply(created.id,
    '甲客户生产环境，10.0.0.7 的运维账号执行 systemctl status nginx。核对了工单 OPS-42 和堡垒机会话记录。仅限同一账号同一主机的巡检；出现下载或外联就不能复用；工单结束后失效。');
  assert.equal(second.status, 'ready_for_review');
  assert.deepEqual(second.missing, []);
  assert.match(second.messages.at(-1).content, /待人工审核/);
  assert.equal((await store.list())[0].title, '执行 systemctl status nginx');
});

test('failed model turn still preserves customer input for later supplement', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-knowledge-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workbench = new KnowledgeWorkbench(new KnowledgeStore(directory),
    { complete: async () => { throw new Error('模型超时'); } },
    { load: async () => ({ prompts: { knowledge: '整理' } }) });
  const created = await workbench.create();
  const record = await workbench.reply(created.id, '这条告警需要以后补充。');
  assert.equal(record.status, 'draft');
  assert.equal(record.messages[1].content, '这条告警需要以后补充。');
  assert.match(record.messages.at(-1).content, /已保存/);
});

test('customer can defer a missing item, answer another, and later fill the deferred item', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-knowledge-deferred-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(directory);
  let calls = 0;
  const model = { complete: async () => ({ content: JSON.stringify(calls++ === 0
    ? { fields: { reason: { value: '该命令来自例行巡检', source_quote: '例行巡检' },
        record_ref: { value: '不知道', source_quote: '不知道' } }, summary: '已记录原因。' }
    : { fields: { record_ref: { value: '告警 8842', source_quote: '告警 8842' } }, summary: '已补充记录。' }) }) };
  const workbench = new KnowledgeWorkbench(store, model,
    { load: async () => ({ prompts: { knowledge: '整理' } }) });
  const created = await workbench.create();
  const first = await workbench.reply(created.id, '不知道 ID，这条是例行巡检。');
  assert.equal(first.fields.record_ref, undefined);
  assert.equal(first.next_field, 'record_ref');
  const deferred = await workbench.defer(created.id, 'record_ref');
  assert.deepEqual(deferred.deferred_fields, ['record_ref']);
  assert.equal(deferred.next_field, 'customer_scope');
  assert.equal((await store.get(created.id)).messages.at(-1).role, 'assistant');
  const resumed = await workbench.reply(created.id, '补充一下：告警 8842。');
  assert.equal(resumed.fields.record_ref.value, '告警 8842');
  assert.deepEqual(resumed.deferred_fields, []);
  assert.equal(resumed.status, 'needs_info');
});

test('retired knowledge API cannot create another source of truth', async t => {
  const server = createServer(null, null, null, null, null, null, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/knowledge/cases`, { method: 'POST' })).status, 404);
});
