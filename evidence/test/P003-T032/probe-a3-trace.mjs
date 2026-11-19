// A3 · 溯源白板建边（真进程 + 替身牧云回真实形状记录）
//
// 验什么：替身牧云把一条「同一条事件记录里既有主机地址、又有对端公网地址」的记录交出来
//   （形状照现场那份 malware 事件的字段：host_view.host_ip / file_path / process_name ...），
//   白板从告警起板、调查该资产时能把这条记录读进来，并建出一条 program 边（trace-board.js:453-474）。
// 不真连牧云（A6）：替身数据，不是真牧云验证。
// 对端地址用 TEST-NET-3 文档段 203.0.113.77：形状与真实公网 IPv4 一致，但它不是现场观测值，
//   本卡也没有现场观测到的对端地址（现场那份 malware 事件没有 source_ip 字段）。
// 跑法：node evidence/test/P003-T032/probe-a3-trace.mjs   （退出码 0 = 全过）
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checker, startStub, startApp, freePort, snapshotData, restoreData, repoRoot, sleep } from './harness.mjs';

const PEER = '203.0.113.77';
const HOST = '192.168.24.21';
const { ok, bad, check, failures, done } = checker();
const snapshot = await snapshotData();
let stub, app;

const api = async (pathname, options = {}) => {
  const response = await fetch(`${app.base}${pathname}`, { ...options, signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
};

const tool = (name, properties) => ({ name, description: `替身 ${name}`,
  inputSchema: { type: 'object', additionalProperties: true, properties } });

// 现场那份恶意文件事件的字段子集（01-原始告警.txt / 03-研判事实.md 里的真字段名），另加一条对端地址。
// 对端地址是替身构造的：现场那份事件没有 source_ip。
const eventRow = seconds => ({ id: 1, event_id: 1, host_id: 4, level: 3, event_type: 'malware',
  event_name: '恶意文件', created_at: seconds, file_type: 'jsp_webshell',
  file_path: '/dev/shm/detector_tmp/jspxwebshell/KTQSPgrwTq/bat4iskw10qotpos4lf06sqyq4wv96aw.jsp',
  process_name: 'cava', process_path: '/usr/lib/jvm/java-8-openjdk-amd64/jre/bin/cava',
  detect_source: 'jspxwebshell', source_ip: PEER,
  host_view: { host_id: 4, host_name: 'ubuntu', host_ip: HOST, host_os_name: 'Ubuntu 22.04.5 LTS',
    exposed_ip: HOST, host_state: 'online' } });

try {
  const seconds = Math.floor(Date.now() / 1000);
  const row = eventRow(seconds);
  stub = await startStub();
  await stub.ctl({
    lists: {}, modelScript: [
      { content: JSON.stringify({ action: 'investigate', node: `asset:${HOST}`,
        why: '先看这台资产当前页的关联事件，确认有没有对端地址' }) },
      { content: JSON.stringify({ action: 'conclude',
        summary: `替身场景：${HOST} 的恶意文件事件同页带出对端 ${PEER}，已按 program 线索建边；关系性质待人工核实。`,
        gaps: ['未核实对端地址归属与连接方向'] }) }
    ],
    tools: [
      tool('get_malware_event', { id: { type: 'integer' }, count: { type: 'integer' } }),
      tool('list_host_assets', { count: { type: 'integer' }, filters: { type: 'object' } }),
      tool('list_host_events', { id: { type: 'integer' }, count: { type: 'integer' } }),
      tool('list_global_events', { count: { type: 'integer' }, offset: { type: 'integer' }, host_ip: { type: 'array' } }),
      tool('list_malware_events', { count: { type: 'integer' }, offset: { type: 'integer' }, host_ip: { type: 'array' } }),
      tool('list_firewall_connection_records', { count: { type: 'integer' }, filters: { type: 'object' } })
    ],
    toolResults: {
      get_malware_event: row,
      list_host_assets: { hosts: [{ host_id: 4, host_view: row.host_view }] },
      list_host_events: { events: [row], total: 1 },
      list_global_events: { events: [], total: 0 },
      list_malware_events: { events: [], total: 0 },
      list_firewall_connection_records: { events: [], total: 0 }
    }
  });

  app = await startApp({ stubUrl: stub.url, port: await freePort() });

  const created = await api('/api/trace/boards', { method: 'POST', body: JSON.stringify({ target: 'malware:1' }) });
  check(created.status === 202, '建板：POST /api/trace/boards 回 202', `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  const seedIds = (created.body?.nodes || []).map(node => node.id);
  check(seedIds.includes(`asset:${HOST}`), '起板：种子节点是 asset:192.168.24.21（来自替身事件 host_view.host_ip）',
    JSON.stringify(seedIds));

  // 后台调查跑完（模型两个动作 + 三次工具调用）
  const deadline = Date.now() + 30000;
  let board = null;
  while (Date.now() < deadline) {
    const current = await api('/api/trace/boards/malware:1');
    if (['done', 'failed', 'interrupted'].includes(current.body?.status)) { board = current.body; break; }
    await sleep(300);
  }
  check(board?.status === 'done', '调查：白板跑到 done', `${board?.status}${board?.gaps?.length ? ` · gaps=${JSON.stringify(board.gaps)}` : ''}`);
  const nodeIds = (board?.nodes || []).map(node => node.id);
  check(nodeIds.includes(`ip:${PEER}`), '调查：对端地址进了图（ip:203.0.113.77）', JSON.stringify(nodeIds));

  const links = Array.isArray(board?.links) ? board.links : [];
  const edge = links.find(link => link.from === `asset:${HOST}` && link.to === `ip:${PEER}`);
  check(Boolean(edge), '建边：links 里有 asset:192.168.24.21 → ip:203.0.113.77 这条边',
    JSON.stringify(links.map(link => `${link.from}->${link.to}`)));
  check(edge?.rel === '触达线索', '建边：关系性质是「触达线索」', String(edge?.rel));
  check(Boolean(edge?.evidence_id), '建边：边带原始证据引用', String(edge?.evidence_id));

  // 持久化那份能看出是谁建的边（presentBoard 不对外暴露 by）：program = 代码按同一条记录的来源/主机字段推出来的。
  const stored = JSON.parse(await readFile(path.join(repoRoot, '.data/trace-boards/malware:1.json'), 'utf8'));
  const rawEdge = (stored.edges || []).find(item => item.from === `ip:${PEER}` && item.to === `asset:${HOST}`);
  check(rawEdge?.by === 'program', '建边：落盘 edge.by=program（记录里的对端 + 主机字段推出来的）', String(rawEdge?.by));
  check(rawEdge?.citations?.length >= 2 && rawEdge.citations.every(citation => citation.evidence_id),
    '建边：edge 的两端各有一条证据引用', JSON.stringify(rawEdge?.citations?.map(citation => citation.evidence_id)));
  check(stored.status === 'done' && stored.summary.includes(PEER), '建边：白板结论里有对端地址', String(stored.summary).slice(0, 120));
} catch (error) {
  bad('探针执行异常', String(error?.stack || error));
} finally {
  if (process.env.T032_DEBUG) {
    if (stub) process.stdout.write(`\n--- 替身请求日志 ---\n${JSON.stringify(await stub.log(), null, 1)}\n`);
    if (app) process.stdout.write(`\n--- 进程日志 ---\n${app.logText()}\n`);
  }
  if (app) {
    for (const key of ['http.failed', 'server.start_failed']) {
      const events = app.events(key);
      if (events.length) bad(`进程日志出现 ${key}`, JSON.stringify(events).slice(0, 400));
    }
    await app.stop();
  }
  if (stub) await stub.stop();
  await restoreData(snapshot);
}

process.stdout.write(`\nA3 结果：${done() ? 'ALL GREEN' : `FAILED ${failures.length} 项`}\n`);
process.exit(done() ? 0 : 1);
