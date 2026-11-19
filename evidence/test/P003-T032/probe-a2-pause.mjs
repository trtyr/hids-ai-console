// A2 · 暂停研判（真进程 poll 模式 + 替身牧云）
//
// 验什么（各一条断言，文档 docs/modules/triage-pipeline.md §5 / 表格 R-TRIAGE-05/06）：
//   暂停后：新到告警**不入队**（轮询整体不跑：last_poll_at 不前进、队列计数不动、日志无 triage.enqueued）
//   恢复后：暂停期到达的那条**补判**（P003-T036 起「游标与队列原样不动 + 回灌后立刻 poll」，不丢告警），
//           跑到 done 且结论走真实结论链路；恢复后新到的那条**入队并跑到 done**
// 环境标注（A6）：真进程 + 替身牧云 + 替身模型（不是真牧云/真模型）。
// 说明：TriageMonitor 轮询周期缺省 30s（triage-monitor.js:36，server.js:51-56 未注入更小值），
//       等待是产品节奏，不是探针慢。
// 替身模型的脚本是**按请求顺序消费**的：一场研判吃掉前三条（wiki_search → submit_conclusion → 独立复核），
//       所以脚本只服务得到一场；本探针把「真实结论链路」断言挂在被补判的 malware:21 上，
//       malware:22 只验队列活性（入队 / 跑到 done / 有结论），不赌第二个脚本位。
// 跑法：node evidence/test/P003-T032/probe-a2-pause.mjs   （退出码 0 = 全过）
import { checker, startStub, startApp, freePort, snapshotData, restoreData, sleep } from './harness.mjs';

const INTERVAL = 30000;
const { ok, bad, check, failures, done } = checker();
const snapshot = await snapshotData();
let stub, app;

const api = async (path, options = {}) => {
  const response = await fetch(`${app.base}${path}`, { ...options, signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
};
const summary = async () => (await api('/api/agent/triage/status')).body;
const record = async id => (await api(`/api/agent/triage/${encodeURIComponent(id)}`)).body;
const control = enabled => api('/api/agent/triage/control', { method: 'PUT', body: JSON.stringify({ enabled }) });
const waitFor = async (label, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(500);
  }
  bad(`等待超时：${label}`, `${timeoutMs}ms`);
  return null;
};

// 一条真实形状的牧云恶意文件告警（字段名照现场 syslog/牧云事件：host_view.host_ip、event_id、level、created_at）。
const malwareRow = (id, seconds) => ({ id, event_id: id, host_id: 4, host_name: 'ubuntu', level: 3,
  event_type: 'malware', event_name: '恶意文件', created_at: seconds,
  file_type: 'jsp_webshell', file_path: '/dev/shm/detector_tmp/jspxwebshell/x.jsp',
  host_view: { host_id: 4, host_name: 'ubuntu', host_ip: '192.168.24.21' } });

// 替身 MCP 工具面：研判要求的最小集合（get_malware_event 走 /rpc，其余走 MCP）。
const tools = ['list_host_events', 'list_global_events', 'list_full_commands_by_host', 'list_malware_events',
  'list_firewall_connection_records'].map(name => ({ name, description: `替身 ${name}`,
  inputSchema: { type: 'object', additionalProperties: true, properties: {
    count: { type: 'integer' }, offset: { type: 'integer' }, id: { type: 'integer' }, host_id: { type: 'integer' },
    host_ip: { type: 'array' }, source_ip: { type: 'array' }, types: { type: 'array' }, filters: { type: 'object' } } } }));

try {
  stub = await startStub();
  await stub.ctl({
    lists: {}, details: {}, tools,
    toolResults: Object.fromEntries(tools.map(tool => [tool.name, { events: [], total: 0, hosts: [] }])),
    modelScript: [
      { tool_calls: [{ name: 'wiki_search', arguments: { keyword: '恶意文件' } }] },
      // 结论带一条可核验的引用（cw:1 = get_malware_event 的原始事件），否则 verifyClaims 会把事实全剔掉、
      // 走「引用校验未通过」的降级分支——那条路不经 submit_conclusion，验不到真实结论链路。
      { tool_calls: [{ name: 'submit_conclusion', arguments: { verdict: '存疑',
        summary: '替身场景：主机 192.168.24.21 出现 jsp 恶意文件事件；缺文件内容与工单，按存疑记录。',
        wiki_reason: '替身场景，未采纳任何判据页',
        claims: [{ text: '事件记录的主机是 192.168.24.21',
          citations: [{ evidence_id: 'cw:1', pointer: '/host_view/host_ip', value: '192.168.24.21' }] }] } }] },
      { content: '{"assessment":"supported","concerns":[],"missing_evidence":[]}' }
    ]
  });

  app = await startApp({ stubUrl: stub.url, port: await freePort() });

  // 起步：本轮第一次轮询只钉游标、不入队（文档 §5.2「首次轮询只把游标钉在当前页最新时间，不入队」）。
  const initial = await waitFor('首次轮询钉游标', async () => {
    const value = await summary();
    return value.initialized && value.last_poll_at ? value : null;
  }, 20000);
  check(Boolean(initial), '起步：首次轮询完成、游标已钉', JSON.stringify(initial?.counts));
  check(initial?.enabled === true, '起步：研判处于启用态', String(initial?.enabled));

  // ---- 暂停 ----
  const paused = await control(false);
  check(paused.status === 200 && paused.body.enabled === false, '暂停：PUT control 回 200 且 enabled=false',
    `${paused.status}/${paused.body?.enabled}`);
  const polledAtBefore = (await summary()).last_poll_at;

  // 暂停期间上游多一条告警。事件时间精确到秒（牧云口径），游标带毫秒，所以先让读者隔过去一个秒边界，
  // 否则这条告警会被「早于游标」直接跳过——那时「没入队」是游标挡的，不是暂停挡的，断言就没验到暂停。
  await sleep(1200);
  const pausedSeconds = Math.floor(Date.now() / 1000);
  const pausedId = 'malware:21';
  await stub.ctl({ appendList: { malware: [malwareRow(21, pausedSeconds)] },
    details: { [pausedId]: malwareRow(21, pausedSeconds) } });
  ok('暂停期间：上游新增一条告警 malware:21', `created_at=${new Date(pausedSeconds * 1000).toISOString()}（晚于游标 ${polledAtBefore}）`);

  await sleep(INTERVAL + 1500); // 让至少一个轮询周期过去
  const duringPause = await summary();
  // polledAtBefore 为空（首轮轮询没成）时这条不能空转：null === null 也 PASS 等于没验。
  check(Boolean(polledAtBefore) && duringPause.last_poll_at === polledAtBefore,
    '暂停期间：轮询没跑（last_poll_at 未前进）',
    `${polledAtBefore} → ${duringPause.last_poll_at}`);
  check(duringPause.counts.queued === 0 && duringPause.counts.running === 0 && duringPause.counts.done === 0,
    '暂停期间：队列计数全零（新告警没入队）', JSON.stringify(duringPause.counts));
  const pausedRecord = await record(pausedId);
  check(pausedRecord.status === 'not_queued', '暂停期间：malware:21 没有队列记录', pausedRecord.status);
  check(app.events('triage.enqueued').length === 0, '暂停期间：日志里没有 triage.enqueued',
    `${app.events('triage.enqueued').length} 条`);

  // ---- 恢复 ----
  const resumed = await control(true);
  check(resumed.status === 200 && resumed.body.enabled === true, '恢复：PUT control 回 200 且 enabled=true',
    `${resumed.status}/${resumed.body?.enabled}`);
  // P003-T036 起恢复不丢不漏：游标（watermark / watermarkIds）与队列原样不动，回灌暂停缓冲、补逾期重试，
  // 然后立刻 poll()（triage-monitor.js:576-590；文档 R-TRIAGE-06）。所以暂停期到达的 malware:21 会被这一轮捞进来。
  const afterResume = await summary();
  const replayedQueued = (afterResume.counts?.queued || 0) + (afterResume.counts?.running || 0) +
    (afterResume.counts?.done || 0);
  check(replayedQueued >= 1, '恢复：暂停期积压补判——队列里有 malware:21（游标没跳到点击时刻）',
    `${JSON.stringify(afterResume.counts)} last_poll_at=${afterResume.last_poll_at}`);
  const replayedRecord = await record(pausedId);
  check(replayedRecord.status !== 'not_queued', '恢复：malware:21 已经入队（不是 not_queued）', String(replayedRecord.status));
  check(app.events('triage.enqueued').some(event => event.alert_id === pausedId && event.source === 'poll'),
    '恢复：日志 triage.enqueued 记的是 malware:21 / source=poll',
    JSON.stringify(app.events('triage.enqueued').map(event => `${event.alert_id}:${event.source}`)));
  // 补判那条一路跑到 done，结论走真实结论链路（替身模型脚本前三条服务的正是它）。
  const replayedDone = await waitFor('malware:21 补判跑完', async () => {
    const value = await record(pausedId);
    return value?.status === 'done' || value?.status === 'failed' ? value : null;
  }, 60000);
  check(replayedDone?.status === 'done', '恢复：malware:21 补判跑到 done（不是失败）',
    `${replayedDone?.status}${replayedDone?.detail ? ` · ${String(replayedDone.detail).slice(0, 160)}` : ''}`);
  check(replayedDone?.verdict === 'uncertain', '恢复：补判结论落到记录上（verdict=uncertain）',
    String(replayedDone?.verdict));
  check(String(replayedDone?.summary || '').includes('jsp 恶意文件事件'),
    '恢复：补判结论来自 submit_conclusion（不是替身模型的兜底回包）',
    String(replayedDone?.summary || '').slice(0, 120));
  check(app.events('triage.done').some(event => event.alert_id === pausedId), '恢复：日志 triage.done 记 malware:21',
    JSON.stringify(app.events('triage.done').map(event => event.alert_id)));

  // 恢复后新到的告警：等下一个轮询周期把它捞进来，并跑到 done。
  // 隔过秒边界：恢复不动游标，新告警的事件时间必须晚于当前游标（秒级事件 vs 毫秒游标），
  // 否则会被「早于游标」跳过——那时没入队是游标挡的，验不到轮询还在正常工作。
  await sleep(1200);
  const freshId = 'malware:22';
  const freshRow = malwareRow(22, Math.floor(Date.now() / 1000));
  await stub.ctl({ appendList: { malware: [freshRow] }, details: { [freshId]: freshRow } });
  ok('恢复后：上游新增一条告警 malware:22', '事件时间晚于恢复后的游标');

  const enqueued = await waitFor('malware:22 入队', async () => {
    const value = await record(freshId);
    return value?.status && value.status !== 'not_queued' ? value : null;
  }, INTERVAL + 20000);
  check(Boolean(enqueued), '恢复后：malware:22 入队', String(enqueued?.status));
  check(app.events('triage.enqueued').some(event => event.alert_id === freshId && event.source === 'poll'),
    '恢复后：日志 triage.enqueued 记的是 malware:22 / source=poll',
    JSON.stringify(app.events('triage.enqueued').map(event => `${event.alert_id}:${event.source}`)));

  const finished = await waitFor('malware:22 跑完', async () => {
    const value = await record(freshId);
    return value?.status === 'done' || value?.status === 'failed' ? value : null;
  }, 60000);
  check(finished?.status === 'done', '恢复后：malware:22 跑到 done（不是失败）',
    `${finished?.status}${finished?.detail ? ` · ${String(finished.detail).slice(0, 160)}` : ''}`);
  check(finished?.verdict === 'uncertain', '恢复后：结论落到记录上（verdict=uncertain）', String(finished?.verdict));
  // 这条只验队列活性：替身模型脚本已被 malware:21 那一场吃掉，第二条走兜底回包也算跑通，
  // 结论正文是否来自 submit_conclusion 由上面 malware:21 那三条断言负责。
  check(String(finished?.summary || '').length > 0, '恢复后：malware:22 有结论正文（研判真的跑到了收尾）',
    String(finished?.summary || '').slice(0, 120));
  check(app.events('triage.done').some(event => event.alert_id === freshId), '恢复后：日志有 triage.done');
  const modelCalls = (await stub.log()).filter(entry => entry.kind === 'model').length;
  check(modelCalls >= 4, '恢复后：替身模型确实被调用（两场研判各至少两轮）', `${modelCalls} 次`);
} catch (error) {
  bad('探针执行异常', String(error?.stack || error));
} finally {
  // T032_DEBUG=1：把两侧日志打出来，便于复核失败原因（默认不打）。
  if (process.env.T032_DEBUG) {
    if (stub) process.stdout.write(`\n--- 替身请求日志 ---\n${JSON.stringify(await stub.log(), null, 1)}\n`);
    if (app) process.stdout.write(`\n--- 进程日志 ---\n${app.logText()}\n`);
  }
  if (app) {
    for (const key of ['triage.failed', 'triage.poll_failed', 'server.start_failed']) {
      const events = app.events(key);
      if (events.length) bad(`进程日志出现 ${key}`, JSON.stringify(events).slice(0, 500));
    }
    await app.stop();
  }
  if (stub) await stub.stop();
  await restoreData(snapshot);
}

process.stdout.write(`\nA2 结果：${done() ? 'ALL GREEN' : `FAILED ${failures.length} 项`}\n`);
process.exit(done() ? 0 : 1);
