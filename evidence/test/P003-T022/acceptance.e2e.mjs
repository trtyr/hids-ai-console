// P003-T022 端到端验收（测试席自写，独立于写者脚本）
// 只走公开入口：InvestigationAgent / TriageMonitor / InvestigationStore / ChatModelClient。
// 全部用假 model / 假 fetcher，不碰网络、不碰真实时钟。
//
// 跑法（cwd 任意）：
//   node evidence/test/P003-T022/acceptance.e2e.mjs
// 退出码 0 = 全绿。

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../../..');

const { AgentToolbox } = await import(path.join(base, 'agent-tools.js'));
const { InvestigationAgent } = await import(path.join(base, 'investigation-agent.js'));
const { InvestigationStore } = await import(path.join(base, 'investigation-store.js'));
const { TriageMonitor } = await import(path.join(base, 'triage-monitor.js'));
const { ChatModelClient } = await import(path.join(base, 'model-client.js'));
const { WikiStore } = await import(path.join(base, 'src/contexts/knowledge/infrastructure/wiki-store.js'));

let failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`✔ ${name}`); }
  catch (error) { failed++; console.log(`✖ ${name}\n    ${String(error.message).split('\n').join('\n    ')}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, ms = 6000) => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < ms) await sleep(10);
  return Boolean(predicate());
};

const honeypotToolbox = () => new AgentToolbox({
  listTools: async () => [{ name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
  callTool: async () => ({ id: 7, source_ip: '192.0.2.2', host_ip: '10.0.0.5' }),
});

// 假知识库：只实现文档点名的四个读判据方法（knowledge-base.md:277）。
const emptyKnowledge = () => ({
  agentIndex: async () => ({ category: 'honeypot', pages: [], hint: '（测试用空目录）' }),
  agentPage: async () => { throw new Error('测试知识库没有页'); },
  agentContextPages: async () => [],
  agentSearch: async () => [],
});

const makeMonitor = async (model, { knowledgeStore } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ho-t022-'));
  const history = new InvestigationStore(path.join(directory, 'results'));
  const investigator = new InvestigationAgent(honeypotToolbox(), model, undefined, knowledgeStore, undefined);
  const monitor = new TriageMonitor({
    file: path.join(directory, 'queue.json'),
    concurrency: 1,
    investigator,
    history,
    service: { alerts: async () => ({ alerts: [], partial: false }) },
    casesDirectory: path.join(directory, 'cases'),
  });
  await monitor.load();
  return { monitor, history, directory };
};

// 一条失败记录跑到底；返回 status()（公开面）。
const failOnce = async (model, options = {}) => {
  const { monitor, history, directory } = await makeMonitor(model, options);
  await monitor.enqueue('honeypot:1');
  const reached = await waitFor(() => {
    const status = monitor.status('honeypot:1')?.status;
    return status === 'failed' || status === 'done';
  });
  return { record: monitor.status('honeypot:1'), monitor, history, directory, reached };
};

const budget = (text) => [...text].length;

// ── A1 形态一：六轮都只回散文，没给 JSON ─────────────────────────────
const proseModel = (text) => ({ model: 'fake', complete: async () => ({ content: text }) });
{
  const { record, reached } = await failOnce(proseModel('我先梳理一下这条蜜罐告警，需要核对来源与请求载荷。'));
  ok('A1-形态1 记录落到 failed / 阶段「研判失败」', () => {
    assert.equal(reached, true, '队列在 6s 内没有跑到终态');
    assert.equal(record.status, 'failed');
    assert.equal(record.stage, '研判失败');
  });
  ok('A1-形态1 detail 四段齐全：轮数与取证量 / 末次回包 / 退回次数 / 原文摘要', () => {
    assert.match(record.detail, /调查 6 轮、已查询 0 项证据后仍没有可用结论/);
    assert.match(record.detail, /末次回包 25 字：「我先梳理一下这条蜜罐告警，需要核对来源与请求载荷。/);
    assert.match(record.detail, /退回 6 次：输出解析失败：/);
  });
  ok('A1-形态1 detail 不超过 250 字（队列截断上限）', () => {
    assert.ok(budget(record.detail) <= 250, `detail ${budget(record.detail)} 字`);
  });
}

// ── A1 形态二：模型接口回了不可用消息（走真 ChatModelClient）────────
{
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
      usage: { total_tokens: 1 },
    }),
  });
  const client = new ChatModelClient({ baseUrl: 'http://fake.local/v1', apiKey: 'sk-should-not-leak', model: 'fake', fetcher });
  // 先确认 model-client 的公开行为：抛错并把摘要挂在 error 上。
  let clientError = null;
  try { await client.complete([{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'f' } }]); }
  catch (error) { clientError = error; }
  ok('model-client 不可用回包：抛「模型没有返回可用消息」且 error.reply_excerpt 描述回包形状', () => {
    assert.ok(clientError, '没有抛错');
    assert.equal(clientError.message, '模型没有返回可用消息');
    assert.match(clientError.reply_excerpt, /回包 message 正文 0 字、工具调用 0 次（finish_reason=length）/);
    assert.ok(!String(clientError.reply_excerpt).includes('sk-should-not-leak'), '摘要里带出了 apiKey');
  });

  // 文档 §3.2.1 第二张表：有 choices[0] 但没有 message 时的摘要
  const shapeA = new ChatModelClient({
    baseUrl: 'http://fake.local/v1', apiKey: 'sk-should-not-leak', model: 'fake',
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop' }] }) }),
  });
  let shapeAError = null;
  try { await shapeA.complete([{ role: 'user', content: 'hi' }]); } catch (error) { shapeAError = error; }
  ok('model-client 有 choices[0] 没 message：摘要写「回包没有 choices[0].message（finish_reason=stop，keys=choices）」', () => {
    assert.ok(shapeAError);
    assert.equal(shapeAError.reply_excerpt, '回包没有 choices[0].message（finish_reason=stop，keys=choices）');
  });
  // 文档 §3.2.1：正文非空（哪怕只是空格）就是可用消息，model-client 不抛错
  const spaceClient = new ChatModelClient({
    baseUrl: 'http://fake.local/v1', apiKey: 'sk-should-not-leak', model: 'fake',
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ' ' } }] }) }),
  });
  let spaceMessage = null;
  try { spaceMessage = await spaceClient.complete([{ role: 'user', content: 'hi' }]); }
  catch (error) { spaceMessage = { threw: String(error.message) }; }
  ok('边界 只有空格的正文字段算可用消息：model-client 原样返回、不抛错', () => {
    assert.equal(spaceMessage.content, ' ');
  });

  const { record, reached } = await failOnce(client);
  ok('A1-形态2 队列 detail 带「模型调用失败（第 1 轮…）：回包摘要」', () => {
    assert.equal(reached, true, '队列在 6s 内没有跑到终态');
    assert.equal(record.status, 'failed');
    assert.match(record.detail, /模型调用失败（第 1 轮、已查询 0 项证据）：/);
    assert.match(record.detail, /回包 message 正文 0 字、工具调用 0 次（finish_reason=length）/);
    assert.match(record.detail, /（调用报错：模型没有返回可用消息）/);
  });
  ok('A1-形态2 detail 不带 apiKey / Authorization', () => {
    assert.ok(!record.detail.includes('sk-should-not-leak'));
    assert.ok(!/Bearer/i.test(record.detail));
    assert.ok(budget(record.detail) <= 250, `detail ${budget(record.detail)} 字`);
  });
}

// ── A1 形态三：结论连续被退回（有知识库但没查）──────────────────────
{
  let calls = 0;
  const rejectModel = {
    model: 'fake',
    complete: async () => {
      calls += 1;
      if (calls <= 5) {
        return {
          content: '',
          tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: 'submit_conclusion', arguments: JSON.stringify({ verdict: '存疑', summary: '结论：存疑。' }) } }],
        };
      }
      return { content: '结论：存疑。' };
    },
  };
  const { record, reached } = await failOnce(rejectModel, { knowledgeStore: emptyKnowledge() });
  ok('A1-形态3 detail 带「退回 N 次：结论被退回：…没有调用知识库工具…→ 输出解析失败」', () => {
    assert.equal(reached, true, '队列在 6s 内没有跑到终态');
    assert.equal(record.status, 'failed');
    assert.match(record.detail, /退回 6 次：结论被退回：/);
    assert.match(record.detail, /没有调用知识库工具/);
    assert.match(record.detail, /→ 输出解析失败：/);
    assert.match(record.detail, /末次回包 6 字：「结论：存疑。」/);
    assert.ok(budget(record.detail) <= 250, `detail ${budget(record.detail)} 字`);
  });
}

// ── A2 失败后可重跑，不卡队列 ─────────────────────────────────────
{
  let mode = 'prose';
  const model = {
    model: 'fake',
    complete: async (_messages, tools) => {
      if (mode === 'prose') return { content: '我先梳理一下这条蜜罐告警，需要核对来源与请求载荷。' };
      if (!tools.length) return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
      return {
        content: JSON.stringify({
          verdict: '存疑', confidence: '低', summary: '重跑得到的结论',
          claims: [{ text: '来源 IP 为 192.0.2.2', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.2' }] }],
          missing_data: [],
        }),
      };
    },
  };
  const { monitor, history } = await makeMonitor(model);
  await monitor.enqueue('honeypot:1');
  const failed = await waitFor(() => monitor.status('honeypot:1')?.status === 'failed');
  await sleep(60); // 等 finally 放完并发位
  ok('A2 失败后并发位释放、failed 计数为 1', () => {
    assert.equal(failed, true);
    assert.equal(monitor.active, 0);
    const counts = monitor.summary().counts;
    assert.equal(counts.failed, 1);
    assert.equal(counts.queued, 0);
    assert.equal(counts.running, 0);
  });
  {
    const before = await history.latest('honeypot:1', 'triage');
    ok('A3 失败后研判记录库没有新记录（latest 为 null）', () => {
      assert.equal(before, null);
    });
  }
  mode = 'verdict';
  await monitor.enqueue('honeypot:1', { retry: true });
  const done = await waitFor(() => monitor.status('honeypot:1')?.status === 'done');
  const after = monitor.status('honeypot:1');
  ok('A2 重排后跑成 done、attempts 从 1 变 2、结论写回', () => {
    assert.equal(done, true, '重跑没有跑到 done');
    assert.equal(after.status, 'done');
    assert.equal(after.attempts, 2);
    assert.equal(after.verdict, 'uncertain');
    assert.equal(after.summary, '重跑得到的结论');
  });
  {
    const stored = await history.latest('honeypot:1', 'triage');
    ok('A2/A3 重跑成功后才落盘，且盘上就是这次结论', () => {
      assert.ok(stored, 'latest() 为空');
      assert.equal(stored.verdict.summary, '重跑得到的结论');
    });
  }
}

// ── A3 失败不覆盖已写成的结论（盘上单文件 + deepEqual）──────────────
{
  const { monitor, history, directory } = await makeMonitor(proseModel('我先梳理一下这条蜜罐告警，需要核对来源与请求载荷。'));
  const seeded = await history.save({
    alert_id: 'honeypot:1', mode: 'triage',
    verdict: { verdict: 'threat', verdict_label: '真实威胁', summary: '既有结论不许被盖' },
  });
  const filesBefore = await readdir(path.join(directory, 'results'));
  await monitor.enqueue('honeypot:1');
  const failed = await waitFor(() => monitor.status('honeypot:1')?.status === 'failed');
  const latest = await history.latest('honeypot:1', 'triage');
  const filesAfter = await readdir(path.join(directory, 'results'));
  ok('A3 失败后目录仍只有一个记录文件、latest() 与预存对象 deepEqual', () => {
    assert.equal(failed, true);
    assert.equal(filesBefore.length, 1);
    assert.deepEqual(filesAfter, filesBefore);
    assert.deepStrictEqual(latest, seeded);
  });
}

// ── 边界：正文为空但点了工具 → 「末次回包没有正文；末次工具调用：<名字>」──
{
  let calls = 0;
  const toolOnly = {
    model: 'fake',
    complete: async () => {
      calls += 1;
      return {
        content: '',
        tool_calls: [{ id: `t${calls}`, type: 'function', function: { name: 'get_honeypot_event', arguments: JSON.stringify({ id: 7 }) } }],
      };
    },
  };
  let message = null;
  try { await new InvestigationAgent(honeypotToolbox(), toolOnly).run('honeypot:7', { mode: 'triage' }); }
  catch (error) { message = error.message; }
  ok('边界 正文为空又点了工具：消息写「末次回包没有正文；末次工具调用：get_honeypot_event」', () => {
    assert.ok(message, '没有抛错');
    assert.match(message, /末次回包没有正文/);
    assert.match(message, /末次工具调用：get_honeypot_event/);
    assert.ok(budget(message) <= 240, `消息 ${budget(message)} 字`);
  });
}

// ── 边界：超长散文（5000 字）→ 消息仍在 240 字预算内 ────────────────
{
  const longProse = '警'.repeat(5000);
  let message = null;
  try { await new InvestigationAgent(honeypotToolbox(), proseModel(longProse)).run('honeypot:7', { mode: 'triage' }); }
  catch (error) { message = error.message; }
  ok('边界 5000 字散文：消息 ≤240 字且带「末次回包 5000 字」与退回次数', () => {
    assert.ok(message, '没有抛错');
    assert.match(message, /末次回包 5000 字：「警{50}/);
    assert.match(message, /退回 6 次：/);
    assert.ok(budget(message) <= 240, `消息 ${budget(message)} 字`);
    assert.match(message, /…」；退回 6 次：/, '正文摘要被截断后没有截断标记');
  });
}

// ── 边界：非 BMP 字符（emoji）回包 → 队列 detail 是否仍保住退回原因 ──
{
  const emojiProse = '😀'.repeat(300);
  const { record, reached } = await failOnce(proseModel(emojiProse));
  ok('边界 emoji 回包：四段仍齐全、detail ≤250（240↔250 耦合在非 BMP 下不破）', () => {
    assert.equal(reached, true);
    assert.match(record.detail, /末次回包 \d+ 字：「/);
    assert.match(record.detail, /退回 6 次：/, `detail 尾部被截：${record.detail}`);
    assert.ok(budget(record.detail) <= 250, `detail ${budget(record.detail)} 字`);
    console.log(`  （观察值：detail 单元数=${record.detail.length}，码点数=${budget(record.detail)}，回包字数写作 600）`);
  });
}

// ── 边界：detail 截断只发生在 250 字上限，正常消息原样进 detail ─────
{
  const text = '我先梳理一下这条蜜罐告警，需要核对来源与请求载荷。';
  let direct = null;
  try { await new InvestigationAgent(honeypotToolbox(), proseModel(text)).run('honeypot:7', { mode: 'triage' }); }
  catch (error) { direct = error.message; }
  const { record } = await failOnce(proseModel(text));
  ok('边界 正常长度消息：detail 与 agent 抛出的 error.message 完全一致（无额外截断）', () => {
    assert.ok(direct);
    assert.equal(record.detail, direct);
  });
}

console.log(failed === 0 ? '\n所有断言通过' : `\n${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
