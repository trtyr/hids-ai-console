// P003-T032 · 测试侧黑盒契约探针（tester 自建，不属于写者取证件）
//
// 目的：按 docs/modules/http-api.md + openapi.yaml 的公开契约，对**真进程**的请求面做三类检查：
//   1) schema 符合性：合法请求 → 文档声明的必填字段与类型逐个断言
//   2) 边界：分页越界 / 枚举非法 / 必填缺失 / 类型错 / 空体 / 超长体 / 非法 ID
//   3) 错误码：400/401/403/404/405/409/410/422/502/503/500 各触发一次，并断言错误体形状（error+code）
// 环境标注：真进程（本树 server.js）+ 替身牧云/替身模型（stub-muyun.mjs），不连真牧云、不连 192.168.24.21。
// 跑法：node evidence/test/P003-T032/tester-probe-contract.mjs   （退出码 0 = 全过）
import { readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { checker, startStub, startApp, freePort, snapshotData, restoreData, repoRoot, sleep } from './harness.mjs';

const USER = 'ops';
const PASS = 'gate-pass-abcdef';
const RULE_TOKEN = 'rule-token-123456';
const PROMPT_TOKEN = 'prompt-token-123456';
const PEER = '203.0.113.77';
const HOST = '192.168.24.21';
const { ok, check, failures, done } = checker();
const snapshot = await snapshotData();
const CODES = ['caller_error', 'not_configured', 'upstream_error', 'internal_error'];
let stub, app, app2;

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

function client(base, extra = {}) {
  return async (method, pathname, options = {}) => {
    const headers = { authorization: AUTH, ...(options.headers || {}) };
    let body;
    if (options.raw !== undefined) body = options.raw;
    else if (options.body !== undefined) { body = JSON.stringify(options.body); headers['Content-Type'] = 'application/json'; }
    const response = await fetch(`${base}${pathname}`, { method, headers, body, signal: AbortSignal.timeout(15000) })
      .catch(error => ({ status: 0, headers: new Headers(), text: async () => String(error) }));
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（如 401 纯文本） */ }
    return { status: response.status, headers: response.headers, text, json, ...extra };
  };
}
let api = client('http://127.0.0.1:1');

// 错误体形状：openapi.yaml:2091 Error{error:string, code: enum 四值}；caller_error 对应 4xx。
const isErrorBody = body => body && typeof body.error === 'string' && CODES.includes(body.code);
function expectError(label, result, status, code = 'caller_error') {
  check(result.status === status, `${label}：状态 ${status}`, `实测 ${result.status} ${result.text.slice(0, 120)}`);
  check(isErrorBody(result.json), `${label}：错误体是 {error,code}`, result.text.slice(0, 160));
  check(result.json?.code === code, `${label}：code=${code}`, String(result.json?.code));
  return result;
}

const tool = (name, properties) => ({ name, description: `替身 ${name}`,
  inputSchema: { type: 'object', additionalProperties: true, properties } });
const eventRow = seconds => ({ id: 1, event_id: 1, host_id: 4, level: 3, event_type: 'malware',
  event_name: '恶意文件', created_at: seconds, file_type: 'jsp_webshell',
  file_path: '/dev/shm/detector_tmp/jspxwebshell/KTQSPgrwTq/bat4iskw10qotpos4lf06sqyq4wv96aw.jsp',
  process_name: 'cava', detect_source: 'jspxwebshell', source_ip: PEER,
  host_view: { host_id: 4, host_name: 'ubuntu', host_ip: HOST, host_os_name: 'Ubuntu 22.04.5 LTS',
    exposed_ip: HOST, host_state: 'online' } });
const shellRow = seconds => ({ id: 1, event_id: 1, host_id: 4, level: 3, event_type: 'webshell',
  event_name: 'WebShell', created_at: seconds,
  host_view: { host_id: 4, host_name: 'ubuntu', host_ip: HOST } });

try {
  const seconds = Math.floor(Date.now() / 1000);
  const row = eventRow(seconds);
  stub = await startStub();
  // 探针分两段灌数据：先空上游（避免 poll 监视器启动首轮把告警入队、抢走替身模型脚本），
  // 起进程后立刻暂停研判，再灌告警做列表断言，做完白板才恢复。
  await stub.ctl({
    lists: {},
    details: { 'webshell:1': shellRow(seconds) },
    modelScript: [
      { content: JSON.stringify({ action: 'investigate', node: `asset:${HOST}`, why: '先看这台资产当前页的关联事件' }) },
      { content: JSON.stringify({ action: 'conclude',
        summary: `替身场景：${HOST} 的恶意文件事件同页带出对端 ${PEER}，已按 program 线索建边。`,
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

  app = await startApp({ stubUrl: stub.url, port: await freePort(),
    env: { HIDS_BASIC_AUTH_USER: USER, HIDS_BASIC_AUTH_PASSWORD: PASS,
      HIDS_RULE_ADMIN_TOKEN: RULE_TOKEN, HIDS_PROMPT_ADMIN_TOKEN: PROMPT_TOKEN } });
  api = client(app.base);
  ok('真进程起来（Basic + 双管理员令牌已配）', app.base);
  const pauseFirst = await api('PUT', '/api/agent/triage/control', { body: { enabled: false } });
  check(pauseFirst.status === 200 && pauseFirst.json?.enabled === false,
    '起进程后立刻暂停研判（隔离 poll 监视器，免得它抢走替身模型脚本）', `${pauseFirst.status} ${String(pauseFirst.json?.enabled)}`);

  // ---------- 1) 401 身份闸（docs/modules/http-api.md:355 四条头 + 纯文本正文）----------
  for (const route of ['/api/alerts', '/api/triage/rules', '/api/agent/triage/status']) {
    const response = await fetch(`${app.base}${route}`, { signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    check(response.status === 401, `401 ${route}：状态 401`, String(response.status));
    check(response.headers.get('www-authenticate') === 'Basic realm="HIDS AI Console", charset="UTF-8"',
      `401 ${route}：WWW-Authenticate 原样`, String(response.headers.get('www-authenticate')));
    check(response.headers.get('content-type') === 'text/plain; charset=utf-8',
      `401 ${route}：Content-Type 是纯文本`, String(response.headers.get('content-type')));
    check(response.headers.get('cache-control') === 'no-store', `401 ${route}：Cache-Control: no-store`,
      String(response.headers.get('cache-control')));
    check(response.headers.get('x-content-type-options') === 'nosniff', `401 ${route}：nosniff`,
      String(response.headers.get('x-content-type-options')));
    check(text === '需要登录后访问', `401 ${route}：正文固定纯文本`, JSON.stringify(text));
  }

  // ---------- 2) 未知路由与固定档位（http-api.md:566 / :573）----------
  const unknown = await api('GET', '/api/definitely-not-a-route');
  expectError('未知 API', unknown, 404);
  check(unknown.json?.error === '接口不存在', '未知 API：文案「接口不存在」', String(unknown.json?.error));

  expectError('POST /api/agent/prompts（只收 GET）', await api('POST', '/api/agent/prompts', { body: {} }), 405);
  expectError('POST /api/agent/prompts/upload（已下线）', await api('POST', '/api/agent/prompts/upload', { body: {} }), 410);

  // ---------- 3) GET /api/config 形状（http-api.md §2 八键恒在、机密只布尔）----------
  const config = await api('GET', '/api/config');
  check(config.status === 200, 'GET /api/config：200', String(config.status));
  for (const key of ['host', 'port', 'triage_input_mode', 'cloudwalker', 'model', 'auth', 'secrets', 'missing_required']) {
    check(Object.hasOwn(config.json || {}, key), `GET /api/config：${key} 键在`, JSON.stringify(Object.keys(config.json || {})));
  }
  check(typeof config.json?.cloudwalker?.configured === 'boolean', 'config：cloudwalker.configured 是布尔',
    JSON.stringify(config.json?.cloudwalker));
  check(typeof config.json?.secrets?.LLM_API_KEY === 'boolean', 'config：secrets 只给布尔（不回显密钥）',
    JSON.stringify(config.json?.secrets));
  check(!config.text.includes('stub-key-abcdef') && !config.text.includes('stub-token-123456'),
    'config：正文不回显令牌/密钥原文', config.text.slice(0, 120));

  // ---------- 4) 分页边界（http-api.md §7 表：count 1..50、offset>=0，非法 → 400「分页参数无效」）----------
  for (const [label, query] of [['count=0', '?count=0'], ['count=51', '?count=51'], ['count=abc', '?count=abc'],
    ['count=20.5', '?count=20.5'], ['offset=-1', '?offset=-1'], ['count 空串', '?count=']]) {
    const result = await api('GET', `/api/alerts${query}`);
    if (query === '?count=') {
      check(result.status === 200, `分页 ${label}：落回缺省（200）`, String(result.status));
      continue;
    }
    expectError(`分页 ${label}`, result, 400);
    check(result.json?.error === '分页参数无效', `分页 ${label}：文案「分页参数无效」`, String(result.json?.error));
  }
  for (const [label, query] of [['count=0', '?count=0'], ['sort=bogus', '?sort=bogus']]) {
    expectError(`triage/cases ${label}`, await api('GET', `/api/agent/triage/cases${query}`), 400);
  }
  for (const [label, query] of [['count=0', '?count=0'], ['status=bogus', '?status=bogus'],
    ['from>to', '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z']]) {
    expectError(`trace/boards ${label}`, await api('GET', `/api/trace/boards${query}`), 400);
  }
  for (const [label, query] of [['count=0', '?count=0'], ['count=51', '?count=51']]) {
    expectError(`wiki/pages ${label}`, await api('GET', `/api/wiki/pages${query}`), 400);
  }

  // ---------- 5) 查询参数枚举非法 → 400（openapi 参数 description：其他值回 400）----------
  for (const [label, query] of [
    ['type（不在 11 类枚举）', '?type=bogus_type'],
    ['sort（只收 time|level）', '?sort=alphabetical'],
    ['level（不收 5）', '?level=5'],
    ['from（解析不出）', '?from=not-a-date'],
    ['from>to', '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
    ['triage_status（不收）', '?triage_status=paused'],
    ['verdict（不收）', '?verdict=maybe']]) {
    expectError(`alerts${query} 非法枚举 ${label}`, await api('GET', `/api/alerts${query}`), 400);
  }

  // ---------- 6) 合法请求 + schema 符合性 ----------
  await stub.ctl({ lists: { webshell: [shellRow(seconds)] } });
  const alerts = await api('GET', '/api/alerts?count=1&offset=0');
  check(alerts.status === 200, 'GET /api/alerts?count=1：200', String(alerts.status));
  for (const key of ['alerts', 'total', 'totals', 'errors', 'partial', 'triage_configured']) {
    check(Object.hasOwn(alerts.json || {}, key), `alerts 200：${key} 必填键在`, JSON.stringify(Object.keys(alerts.json || {})));
  }
  check(Array.isArray(alerts.json?.alerts) && Number.isInteger(alerts.json?.total),
    'alerts 200：alerts 是数组、total 是整数', `alerts=${Array.isArray(alerts.json?.alerts)} total=${alerts.json?.total}`);
  check(alerts.json?.alerts?.[0]?.id === 'webshell:1', 'alerts 200：读到替身上游那条 webshell:1',
    JSON.stringify((alerts.json?.alerts || []).map(item => item.id)));
  check(alerts.json?.partial === false && Object.keys(alerts.json?.errors || {}).length === 0,
    'alerts 200：partial=false 且 errors 空', `partial=${alerts.json?.partial}`);
  check(alerts.json?.triage_configured === true, 'alerts 200：triage_configured=true（本进程配了研判队列）',
    String(alerts.json?.triage_configured));
  const levels = await api('GET', '/api/alerts?level=high,critical&sort=level&q=web');
  check(levels.status === 200, 'alerts 带 level+sort=level+q：200', String(levels.status));
  check(levels.json?.truncated === false, 'alerts 带筛选：truncated=false（未触 500 条扫描上限）',
    String(levels.json?.truncated));

  const detail = await api('GET', '/api/alerts/webshell:1');
  check(detail.status === 200, 'GET /api/alerts/webshell:1：200', `${detail.status} ${detail.text.slice(0, 100)}`);
  check(detail.json?.alert?.id === 'webshell:1' && detail.json?.detail && typeof detail.json.detail === 'object',
    '告警详情 200：{alert, detail} 两件都在', JSON.stringify(Object.keys(detail.json || {})));
  expectError('GET /api/alerts/bogus（ID 无冒号）', await api('GET', '/api/alerts/bogus'), 400);
  expectError('GET /api/alerts/nope:1（类型不在枚举）', await api('GET', '/api/alerts/nope:1'), 400);
  expectError('GET /api/alerts/webshell:999（牧云可达但没有这条）', await api('GET', '/api/alerts/webshell:999'), 404);

  // ---------- 7) 研判队列：状态 / 暂停恢复 / 单条记录 ----------
  const status = await api('GET', '/api/agent/triage/status');
  check(status.status === 200, 'GET /api/agent/triage/status：200', String(status.status));
  for (const key of ['initialized', 'enabled', 'input_mode', 'since', 'counts', 'verdict_counts', 'type_counts']) {
    check(Object.hasOwn(status.json || {}, key), `triage/status 200：${key} 必填键在`,
      JSON.stringify(Object.keys(status.json || {})));
  }
  check(['syslog', 'poll'].includes(status.json?.input_mode), 'triage/status 200：input_mode 在枚举内',
    String(status.json?.input_mode));
  check(typeof status.json?.counts?.queued === 'number', 'triage/status 200：counts.queued 是数字',
    JSON.stringify(status.json?.counts));
  expectError('triage/status?since=abc', await api('GET', '/api/agent/triage/status?since=abc'), 400);
  const sinceOk = await api('GET', '/api/agent/triage/status?since=2026-01-01T00:00:00Z');
  check(sinceOk.status === 200 && typeof sinceOk.json?.since === 'string', 'triage/status?since=<RFC3339>：200 且 since 归一成字符串',
    `${sinceOk.status} ${String(sinceOk.json?.since)}`);

  const cases = await api('GET', '/api/agent/triage/cases?count=5&sort=verdict');
  check(cases.status === 200 && Array.isArray(cases.json?.cases) && Number.isInteger(cases.json?.total),
    'triage/cases?count=5&sort=verdict：200 且 {total,cases}', `${cases.status} ${JSON.stringify(Object.keys(cases.json || {}))}`);

  const off = await api('PUT', '/api/agent/triage/control', { body: { enabled: false } });
  check(off.status === 200 && off.json?.enabled === false, 'PUT control enabled:false：200 且 enabled=false',
    `${off.status} ${String(off.json?.enabled)}`);
  expectError('PUT control 缺 enabled', await api('PUT', '/api/agent/triage/control', { body: {} }), 400);
  expectError('PUT control enabled 用字符串（类型错）',
    await api('PUT', '/api/agent/triage/control', { body: { enabled: 'false' } }), 400);
  expectError('PUT control 正文不是 JSON',
    await api('PUT', '/api/agent/triage/control', { raw: 'enabled=false', headers: { 'Content-Type': 'application/json' } }), 400);
  expectError('PUT control 正文是数组（不是对象）',
    await api('PUT', '/api/agent/triage/control', { body: [true] }), 400);
  const big = await api('PUT', '/api/agent/triage/control', { raw: JSON.stringify({ enabled: true, pad: 'x'.repeat(9000) }),
    headers: { 'Content-Type': 'application/json' } });
  expectError('PUT control 正文超 8192', big, 400);
  check(big.json?.error === '请求正文过大', 'PUT control 超长：文案「请求正文过大」', String(big.json?.error));
  // openapi.yaml:473-477 声明 additionalProperties:false（表外键应拒）
  const junk = await api('PUT', '/api/agent/triage/control', { body: { enabled: true, junk: 1 } });
  check(junk.status === 400, 'PUT control 表外键：openapi additionalProperties:false 应回 400',
    `实测 ${junk.status} ${junk.text.slice(0, 120)}`);

  const record = await api('GET', '/api/agent/triage/malware:1');
  check(record.status === 200, 'GET /api/agent/triage/malware:1：200', String(record.status));
  check(['queued', 'running', 'done', 'failed', 'not_queued'].includes(record.json?.status),
    '单条研判记录：status 在枚举内', String(record.json?.status));
  expectError('POST 重试一条没有原始报文的 syslog 告警',
    await api('POST', '/api/agent/triage/syslog:malware:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43',
      { body: {} }), 404);

  // ---------- 8) 溯源白板：建板 202 → done → links/edge 形状 ----------
  const created = await api('POST', '/api/trace/boards', { body: { target: 'malware:1' } });
  check(created.status === 202, 'POST /api/trace/boards：202', `${created.status} ${created.text.slice(0, 120)}`);
  for (const key of ['id', 'seed', 'status', 'created_at']) {
    check(Object.hasOwn(created.json || {}, key), `建板 202：${key} 键在`, JSON.stringify(Object.keys(created.json || {})));
  }
  check(['running', 'done', 'failed', 'interrupted'].includes(created.json?.status), '建板 202：status 在枚举内',
    String(created.json?.status));
  let board = created.json;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !['done', 'failed', 'interrupted'].includes(board?.status)) {
    await sleep(300);
    board = (await api('GET', '/api/trace/boards/malware:1')).json;
  }
  check(board?.status === 'done', 'GET /api/trace/boards/malware:1：调查跑到 done', String(board?.status));
  if (board?.status !== 'done') {
    process.stdout.write(`--- 白板没跑到 done，失败原因：${JSON.stringify(board?.summary || null)} / ${JSON.stringify(board?.gaps || null)}\n`);
    process.stdout.write(`模型调用记录：${JSON.stringify((await stub.log()).filter(entry => entry.kind === 'model').map(entry => entry.messageCount))}\n`);
    process.stdout.write(`${app.logText().split('\n').filter(line => /triage|trace|board|model|fail/i.test(line)).slice(-14).join('\n')}\n`);
  }
  const links = Array.isArray(board?.links) ? board.links : [];
  const link = links.find(item => item.from === `asset:${HOST}` && item.to === `ip:${PEER}`);
  check(Boolean(link), '白板 links：asset→ip 那条线在', JSON.stringify(links.map(item => `${item.from}->${item.to}`)));
  check(typeof link?.id === 'string' && typeof link?.rel === 'string' && Object.hasOwn(link || {}, 'evidence_id'),
    'link 形状：openapi TraceBoardLink 必填 id/from/to/rel/evidence_id 齐',
    JSON.stringify(link));
  check(link?.rel === '触达线索', 'link.rel=触达线索（程序边口径）', String(link?.rel));
  const stored = JSON.parse(await readFile(path.join(repoRoot, '.data/trace-boards/malware:1.json'), 'utf8'));
  const edge = (stored.edges || []).find(item => item.from === `ip:${PEER}` && item.to === `asset:${HOST}`);
  check(edge?.strength === 0.3, '落盘 edge.strength=0.3（trace-board.md:252 + openapi TraceBoardEdge）', String(edge?.strength));
  check(edge?.by === 'program', '落盘 edge.by=program', String(edge?.by));
  check(Array.isArray(edge?.citations) && edge.citations.length >= 1 && typeof edge?.why === 'string'
    && typeof edge?.at === 'string', '落盘 edge：why/citations/at 齐（openapi 必填）',
    JSON.stringify({ why: Boolean(edge?.why), citations: edge?.citations?.length, at: edge?.at }));

  const reused = await api('POST', '/api/trace/boards', { body: { target: 'malware:1' } });
  check(reused.status === 200 && reused.json?.id === created.json?.id, 'POST 同一 target：200 且回已有那块板',
    `${reused.status} ${String(reused.json?.id)}`);
  expectError('POST 建板 空正文', await api('POST', '/api/trace/boards', { body: {} }), 400);
  expectError('POST 建板 target 不是 ID 也不是 IPv4',
    await api('POST', '/api/trace/boards', { body: { target: '999.1.1.1' } }), 400);
  expectError('POST 建板 syslog 形态但没有分析记录（openapi 422）',
    await api('POST', '/api/trace/boards',
      { body: { target: 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43' } }), 422);
  const byIp = await api('POST', '/api/trace/boards', { body: { ip: '203.0.113.9' } });
  check([200, 202].includes(byIp.status), 'POST 建板 ip:203.0.113.9（ip 字段写法）：200/202',
    `${byIp.status} ${byIp.text.slice(0, 100)}`);
  const list = await api('GET', '/api/trace/boards?count=10');
  check(list.status === 200 && Array.isArray(list.json?.boards) && Number.isInteger(list.json?.total),
    'GET /api/trace/boards：200 且 {boards,total}', `${list.status} ${JSON.stringify(Object.keys(list.json || {}))}`);
  const summary = (list.json?.boards || []).find(item => item.id === 'malware:1');
  check(Boolean(summary), '白板列表：含 malware:1', JSON.stringify((list.json?.boards || []).map(item => item.id)));
  check(['id', 'status', 'chain_length', 'has_gaps'].every(key => Object.hasOwn(summary || {}, key)),
    'TraceBoardSummary 必填 id/status/chain_length/has_gaps 齐', JSON.stringify(Object.keys(summary || {})));
  expectError('GET /api/trace/boards/unknown:9（类型不在枚举 → 400）', await api('GET', '/api/trace/boards/unknown:9'), 400);
  expectError('GET /api/trace/boards/malware:424242（合法 ID 但没有白板 → 404）',
    await api('GET', '/api/trace/boards/malware:424242'), 404);
  // 白板跑完再恢复研判：恢复会重置游标，暂停期那条 webshell 告警不会被补跑（R-TRIAGE-06）。
  const on = await api('PUT', '/api/agent/triage/control', { body: { enabled: true } });
  check(on.status === 200 && on.json?.enabled === true, 'PUT control enabled:true：200 且 enabled=true',
    `${on.status} ${String(on.json?.enabled)}`);
  for (const key of ['initialized', 'enabled', 'input_mode', 'since', 'counts']) {
    check(Object.hasOwn(on.json || {}, key), 'PUT control 200：回的是 TriageSummary',
      JSON.stringify(Object.keys(on.json || {})));
  }

  // ---------- 9) 规则集（triages rules）：403 / 400 / 409 / 200 往返 ----------
  const ruleset = await api('GET', '/api/triage/rules');
  check(ruleset.status === 200, 'GET /api/triage/rules：200', String(ruleset.status));
  check(typeof ruleset.json?.writable === 'boolean' && Object.hasOwn(ruleset.json || {}, 'config')
    && Object.hasOwn(ruleset.json || {}, 'revision'), 'GET triage/rules 200：{config,revision,writable}',
    JSON.stringify(Object.keys(ruleset.json || {})));
  expectError('PUT triage/rules 不带 X-Rule-Admin-Token',
    await api('PUT', '/api/triage/rules', { body: { config: ruleset.json?.config, expected_revision: ruleset.json?.revision } }), 403);
  expectError('PUT triage/rules 缺 expected_revision',
    await api('PUT', '/api/triage/rules', { headers: { 'X-Rule-Admin-Token': RULE_TOKEN }, body: { config: ruleset.json?.config } }), 400);
  expectError('PUT triage/rules 版本号对不上（triage-rules.md:395 → 409）',
    await api('PUT', '/api/triage/rules', { headers: { 'X-Rule-Admin-Token': RULE_TOKEN },
      body: { config: ruleset.json?.config, expected_revision: '0000000000000000' } }), 409);
  const saved = await api('PUT', '/api/triage/rules', { headers: { 'X-Rule-Admin-Token': RULE_TOKEN },
    body: { config: ruleset.json?.config, expected_revision: ruleset.json?.revision } });
  check(saved.status === 200, 'PUT triage/rules 版本号对得上：200（合法写）', `${saved.status} ${saved.text.slice(0, 120)}`);
  const validated = await api('POST', '/api/triage/rules/validate', { body: { config: ruleset.json?.config } });
  check(validated.status === 200 && validated.json?.valid === true && Number.isInteger(validated.json?.count),
    'POST triage/rules/validate：200 且 {valid:true,count:int}', `${validated.status} ${JSON.stringify(validated.json)}`);
  expectError('POST triage/rules/validate 缺 config', await api('POST', '/api/triage/rules/validate', { body: {} }), 400);
  expectError('POST triage/rules/validate 正文不是 JSON',
    await api('POST', '/api/triage/rules/validate', { raw: 'nope', headers: { 'Content-Type': 'application/json' } }), 400);

  // ---------- 10) Rego 规则库 ----------
  const rego = await api('GET', '/api/rules');
  check(rego.status === 200 && Number.isInteger(rego.json?.count) && Array.isArray(rego.json?.rules),
    'GET /api/rules：200 且 {count,rules}', `${rego.status} ${JSON.stringify(Object.keys(rego.json || {}))}`);
  check((rego.json?.rules || []).every(item => ['id', 'name', 'description', 'file'].every(key => Object.hasOwn(item, key))),
    'RegoRuleSummary 必填 id/name/description/file 齐', JSON.stringify(rego.json?.rules?.[0]));
  const firstId = rego.json?.rules?.[0]?.id;
  if (firstId) {
    const rule = await api('GET', `/api/rules/${firstId}`);
    check(rule.status === 200 && rule.json?.id === firstId, `GET /api/rules/${firstId}：200 且 id 对得上`,
      `${rule.status} ${String(rule.json?.id)}`);
  }
  expectError('GET /api/rules/Bad-Id（不合格式）', await api('GET', '/api/rules/Bad-Id'), 400);
  expectError('GET /api/rules/nosuchrule（不存在）', await api('GET', '/api/rules/nosuchrule'), 404);
  const evaluated = await api('POST', '/api/rules/evaluate', { body: { host: '10.0.0.5', command: 'wget x' } });
  check(evaluated.status === 200 && Array.isArray(evaluated.json?.matched) && Number.isInteger(evaluated.json?.count),
    'POST /api/rules/evaluate：200 且 {count,matched}', `${evaluated.status} ${evaluated.text.slice(0, 120)}`);
  expectError('POST /api/rules/evaluate 正文不是对象', await api('POST', '/api/rules/evaluate', { body: [1, 2] }), 400);

  // ---------- 11) 知识库：读接口过 Basic 即开、写/健康检查要令牌 ----------
  const pages = await api('GET', '/api/wiki/pages');
  check(pages.status === 200 && Array.isArray(pages.json?.pages) && Number.isInteger(pages.json?.total),
    'GET /api/wiki/pages：200 且 {pages,total}', `${pages.status} ${JSON.stringify(Object.keys(pages.json || {}))}`);
  const firstPath = pages.json?.pages?.[0]?.path;
  if (firstPath) {
    const page = await api('GET', `/api/wiki/pages/${encodeURIComponent(firstPath)}`);
    check(page.status === 200, `GET /api/wiki/pages/${firstPath}：200`, String(page.status));
  }
  // 两段式路径：目录须在 wiki/ 的约定目录内（knowledge-base.md:227）。取一个真实存在的子目录。
  const wikiDir = String(firstPath || '').includes('/') ? String(firstPath).split('/')[0] : 'common';
  expectError('GET /api/wiki/pages/nope-xyz.md（路径不合规）', await api('GET', '/api/wiki/pages/nope-xyz.md'), 400);
  expectError(`GET /api/wiki/pages/${wikiDir}/NOPE-99.md（合规路径但页面不存在）`,
    await api('GET', `/api/wiki/pages/${encodeURIComponent(`${wikiDir}/NOPE-99.md`)}`), 404);
  expectError('GET /api/wiki/health 不带令牌', await api('GET', '/api/wiki/health'), 403);
  const health = await api('GET', '/api/wiki/health', { headers: { 'X-Prompt-Admin-Token': PROMPT_TOKEN } });
  check(health.status === 200, 'GET /api/wiki/health 带令牌：200', `${health.status} ${health.text.slice(0, 100)}`);
  expectError('GET /api/wiki/sessions 不带令牌', await api('GET', '/api/wiki/sessions'), 403);
  const sessions = await api('GET', '/api/wiki/sessions', { headers: { 'X-Prompt-Admin-Token': PROMPT_TOKEN } });
  check(sessions.status === 200 && Array.isArray(sessions.json?.sessions), 'GET /api/wiki/sessions 带令牌：200 且 {sessions}',
    `${sessions.status} ${sessions.text.slice(0, 100)}`);
  expectError('GET /api/wiki/unknown-path 不带令牌（令牌判定先于路由）', await api('GET', '/api/wiki/unknown-path'), 403);

  // ---------- 12) 503 not_configured：令牌没配（http-api.md §5 三档）----------
  app2 = await startApp({ stubUrl: stub.url, port: await freePort(),
    env: { HIDS_BASIC_AUTH_USER: USER, HIDS_BASIC_AUTH_PASSWORD: PASS } });
  const api2 = client(app2.base);
  const noToken = await api2('PUT', '/api/triage/rules', { body: { config: ruleset.json?.config, expected_revision: null } });
  expectError('PUT triage/rules 未配规则令牌（503 档）', noToken, 503, 'not_configured');
  check(noToken.json?.error === '尚未配置规则管理员令牌', '503：文案「尚未配置规则管理员令牌」', String(noToken.json?.error));
  const noWiki = await api2('GET', '/api/wiki/health');
  expectError('GET /api/wiki/health 未配知识库令牌（503 档）', noWiki, 503, 'not_configured');
  check(noWiki.json?.error === '尚未配置知识库管理员凭据', '503：文案「尚未配置知识库管理员凭据」', String(noWiki.json?.error));
  await app2.stop(); app2 = null;

  // ---------- 13) 500 internal_error：本地写盘失败（http-api.md §8.3「本地写盘失败 → 500 固定文案」）----------
  const dataDir = path.join(repoRoot, '.data');
  let locked = false;
  try {
    await chmod(dataDir, 0o500); locked = true;
    const failed = await api('POST', '/api/config', { body: { LLM_MODEL: 'stub-model' } });
    expectError('POST /api/config 本地写盘失败', failed, 500, 'internal_error');
    check(failed.json?.error === '服务器内部错误', 'internal_error：正文恒为「服务器内部错误」', String(failed.json?.error));
    check(!/at\s+\w+.*:\d+:\d+/.test(failed.text), 'internal_error：响应里没有 stack trace 行', failed.text.slice(0, 120));
  } catch (error) {
    check(false, '500 internal_error 触发', String(error?.message || error));
  } finally {
    if (locked) await chmod(dataDir, 0o700).catch(() => {});
  }

  // ---------- 14) 502 upstream_error：牧云不可达 ----------
  await stub.stop(); stub = null;
  await sleep(300);
  const down = await api('GET', '/api/alerts');
  expectError('GET /api/alerts 牧云不可达', down, 502, 'upstream_error');
  check(/ECONNREFUSED|fetch failed|connect/i.test(String(down.json?.error)), '502：正文是上游那句摘要（连接失败原话）',
    String(down.json?.error).slice(0, 160));
  const statusNow = await api('GET', '/api/status');
  check(statusNow.status === 502, 'GET /api/status 牧云连不上：502（业务体，不是四类错误体）', String(statusNow.status));
  check(statusNow.json?.configured === true && statusNow.json?.connected === false
    && statusNow.json?.code === 'upstream_error', 'status 502 业务体形状：{configured:true,connected:false,code:upstream_error}',
    statusNow.text.slice(0, 160));
} catch (error) {
  check(false, '探针自身未抛异常', String(error?.stack || error));
} finally {
  if (app2) await app2.stop().catch(() => {});
  if (app) await app.stop().catch(() => {});
  if (stub) await stub.stop().catch(() => {});
  await chmod(path.join(repoRoot, '.data'), 0o700).catch(() => {});
  await restoreData(snapshot);
}

process.stdout.write(`\n契约探针：${failures.length === 0 ? 'ALL GREEN' : `${failures.length} 条 FAIL`}\n`);
process.exit(done() ? 0 : 1);
