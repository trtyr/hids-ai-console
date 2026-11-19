// P003-T047 验收：误报统一维护 Agent（多轮会话操控双库，单腿可补跑）
// 黑盒：起真进程（node server.js），上游（牧云 / 模型）用本文件内的替身 HTTP 服务；
// 全部断言只依据 docs/modules/http-api.md §3.4、docs/modules/triage-pipeline.md §7.4、
// docs/architecture.md §3.6、openapi.yaml（误报入口 :817-877、会话两条路径 :1184-1232）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { checkModelCallEvents } from './model-call-events-check.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const TMP = '/tmp/p003-t047-acceptance';
const DATA = `${TMP}/data`;
const PORT = 18147;
const LLM_PORT_FREE = 0;
const RULE_ID = 'honeypot_probe';
const WIKI_PAGE = 'honeypot/HP-10.md';
const ADMIN_TOKEN = 't047-admin-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GOOD_RULE_A = `package hids.rules.honeypot_probe

# name: 蜜罐探测（root 用户）
# description: 排除已登记的授权扫描来源

default match := false

match if {
  input.type == "honeypot"
  input.peer != ""
  input.source_ip != ""
  input.user == "root"
  not input.source_ip == "203.0.113.9"
}
`;
// 放宽：删掉 peer / source_ip 两条原条件 + 加一条无关限制，必被落盘前校验拒绝
const WIDE_RULE = `package hids.rules.honeypot_probe

# name: 蜜罐探测（root 用户）
# description: 放宽版

default match := false

match if {
  input.type == "honeypot"
  input.user == "root"
}
`;

const wikiSource = readFileSync(`${ROOT}/wiki/${WIKI_PAGE}`, 'utf8');

function makeLlmStub() {
  const counters = { decision: 0, rule: 0, wiki: 0 };
  const attemptsByMarker = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 留空 */ }
      const system = body.messages?.[0]?.content || '';
      const user = typeof body.messages?.[1]?.content === 'string' ? body.messages[1].content : JSON.stringify(body.messages?.[1] || '');
      let content = '{}';
      if (system.includes('决策轮')) {
        counters.decision += 1;
        const libs = user.includes('PATH-BOTH') ? ['rule', 'wiki']
          : user.includes('PATH-WIKI') ? ['wiki']
          : user.includes('PATH-FAIL') ? ['rule']
          : user.includes('PATH-NONE') ? []
          : ['rule'];
        content = JSON.stringify({ libraries: libs, why: `决策理由（${libs.join('+')}）` });
      } else if (system.includes('Rego 规则维护助手')) {
        counters.rule += 1;
        const marker = ['PATH-BOTH', 'PATH-WIKI', 'PATH-FAIL'].find((m) => user.includes(m)) || 'PATH-RULE';
        const attempt = (attemptsByMarker.get(marker) || 0) + 1;
        attemptsByMarker.set(marker, attempt);
        const widen = marker === 'PATH-FAIL' && attempt === 1;
        const diskRule = readFileSync(`${DATA}/rules/${RULE_ID}.rego`, 'utf8');
        const tighten = (text, line) => (text.includes(line) ? text : text.replace(/\n\}\s*$/, `\n  ${line}\n}\n`));
        const rego = widen ? WIDE_RULE
          : marker === 'PATH-BOTH' ? tighten(diskRule, 'not input.user == "scanner"')
          : marker === 'PATH-FAIL' ? tighten(diskRule, 'not input.peer == "10.9.9.9"')
          : GOOD_RULE_A;
        content = JSON.stringify({
          ready: true, id: RULE_ID, name: '蜜罐探测（root 用户）', description: '排除已登记来源',
          reason: widen ? '放宽以消化本次误报' : '收紧条件，排除已登记的授权来源', rego,
        });
      } else if (system.includes('判据 Wiki 维护助手')) {
        counters.wiki += 1;
        const extra = user.includes('PATH-BOTH')
          ? '\n\n**补充（2026-11-20）**：同来源反复触碰且已登记为授权扫描的，按误报处置并回填扫描器登记编号。\n'
          : '\n\n**补充（2026-11-20）**：已登记扫描器来源的触碰，核对登记记录后按误报处置。\n';
        content = JSON.stringify({
          reply: '判据补了适用边界。', diagnosis: 'criterion_gap', ready: true,
          proposed_content: wikiSource + extra, rationale: '判据缺适用边界（登记扫描器来源）',
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return { server, counters };
}

const mkAlert = (tag) => `syslog:honeypot:${tag.repeat(16).slice(0, 16)}:${1763373600 + tag.charCodeAt(0)}:${randomUUID()}`;

async function seed() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(`${DATA}/cases`, { recursive: true });
  const alerts = {
    rule: mkAlert('a'),
    wiki: mkAlert('b'),
    both: mkAlert('c'),
    fail: mkAlert('d'),
    running: mkAlert('e'),
    unknown: mkAlert('f'),
    edge: mkAlert('a'),
  };
  for (const key of ['rule', 'wiki', 'both', 'fail', 'edge']) {
    const dir = `${DATA}/cases/${key}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/01-原始告警.txt`, `<134>1 2026-11-17T10:00:00Z host app - cloudwalker-honeypot event_id=7 host_ip=10.0.0.5\n`);
    await writeFile(`${dir}/03-研判事实.md`, `# 研判事实\n主机 10.0.0.5 触碰蜜罐诱饵（${key}）\n`);
    await writeFile(`${dir}/result.json`, JSON.stringify({
      verdict: { verdict: 'threat', verdict_label: '威胁', summary: '疑似蜜罐探测' },
      rego_rule_ids: [RULE_ID],
      cited_wiki_ids: [WIKI_PAGE],
    }, null, 2));
  }
  const now = new Date().toISOString();
  const rec = (alert_id, status, caseKey) => ({
    alert_id, status, verdict: 'threat', verdict_label: '威胁', summary: '疑似蜜罐探测',
    case_dir: caseKey ? `${DATA}/cases/${caseKey}` : null,
    repeat_count: 1, attempts: 0, created_at: now, updated_at: now,
    input: { raw: 'RAW', parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-17T10:00:00Z', payload: { host_ip: '10.0.0.5' } } },
    evidence: [], steps: [],
  });
  await writeFile(`${DATA}/triage-monitor.json`, JSON.stringify({
    initialized: true, enabled: false, watermark: null, watermark_ids: [],
    last_received_at: null, archived_count: 0,
    paused: { since: null, received: 0, dropped: 0, replayed: 0, buffer: [] },
    records: [
      rec(alerts.rule, 'done', 'rule'),
      rec(alerts.wiki, 'done', 'wiki'),
      rec(alerts.both, 'done', 'both'),
      rec(alerts.fail, 'done', 'fail'),
      rec(alerts.running, 'running', null),
      rec(alerts.edge, 'done', 'edge'),
    ],
    dedupe: [], windows: [],
  }, null, 2));
  return alerts;
}

// 认服务：/api/status 的正文必须带 configured / connected 两个 boolean（openapi /api/status，502 也是这个形状）。
// 只看「端口有人应答」会把占用端口的别的进程当成 SUT——那样后面全跑在别人的服务上。
async function isOurServer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
  let body = null;
  try { body = await res.json(); } catch { return false; }
  return !!body && typeof body.configured === 'boolean' && typeof body.connected === 'boolean';
}

async function startServer({ env = {}, port = PORT } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HIDS_DATA_DIR: DATA,
      HIDS_PORT: String(port),
      HIDS_HOST: '127.0.0.1',
      HIDS_TRIAGE_INPUT_MODE: 'syslog',
      HIDS_SYSLOG_PORT: String(28500 + (port % 100)),
      HIDS_STATUS_TTL_MS: '0',
      HIDS_LOG_FILE: `${TMP}/server.log`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let exit = null;
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stdout += d));
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up && !exit; i++) {
    try {
      up = await isOurServer(`${base}/api/status`);
    } catch { /* 还没起来 */ }
    if (!up) await sleep(100);
  }
  if (!up) {
    // SUT 起不来就当场报错并回收子进程，绝不让读请求挂死（挂死会变成 exit=124）
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    assert.fail(`服务没起来（exit=${JSON.stringify(exit)}）：${stdout.slice(-800)}`);
  }
  return { child, base, log: () => stdout };
}

async function call(base, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(20000) };
  if (body !== undefined || raw !== undefined) {
    init.body = raw !== undefined ? raw : JSON.stringify(body);
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* 保留 text */ }
  return { status: res.status, json, text, headers: res.headers };
}

const fpPath = (id) => `/api/agent/triage/${encodeURIComponent(id)}/false-positive`;

async function waitTerminal(base, alertId, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const r = await call(base, 'GET', `/api/agent/triage/${encodeURIComponent(alertId)}`);
    last = r;
    if (r.status === 200 && r.json?.maintenance && r.json.maintenance.status !== 'updating') return r.json;
    await sleep(80);
  }
  assert.fail(`维护没在 ${timeoutMs}ms 内收尾：${last?.text?.slice(0, 400)}`);
}

const ALLOWED_ERROR_CODES = new Set(['caller_error', 'not_configured', 'upstream_error', 'internal_error']);
function assertErrorBody(res, status, code) {
  assert.equal(res.status, status, `期望 ${status}，实测 ${res.status}：${res.text.slice(0, 300)}`);
  assert.equal(typeof res.json?.error, 'string', `错误体缺 error：${res.text.slice(0, 200)}`);
  assert.ok(ALLOWED_ERROR_CODES.has(res.json?.code), `错误体 code 不在四类里：${res.json?.code}`);
  if (code) assert.equal(res.json.code, code, `错误体 code 期望 ${code}：${res.json?.code}`);
}

function onlyKnownKeys(obj, allowed, where) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  assert.deepEqual(extra, [], `${where} 出现契约外字段：${extra.join(',')}`);
}

test('P003-T047 误报统一维护 Agent：HTTP 黑盒验收（A1–A7 + 边界 + 错误码）', async (t) => {
  // 替身计数器是「真实发生过多少次模型调用」的唯一真值（调用打不到替身上就不算）；
  // 每一轮维护都按文档口径登记「这一轮该调几次」，逐轮累加成 ledger，再与替身计数对账。
  const llm = makeLlmStub();
  const ledger = { decision: 0, rule: 0, wiki: 0 };
  let sessionsExpected = 0;
  let child = null;
  const alerts = await seed();
  const snapshot = () => ({ ...llm.counters });
  // 一次 202 = 一份维护会话落盘（http-api.md §3.4：每一轮推进都落盘）
  const roundStarted = () => { sessionsExpected += 1; return snapshot(); };
  function expectCalls(before, expected, where) {
    const actual = {
      decision: llm.counters.decision - before.decision,
      rule: llm.counters.rule - before.rule,
      wiki: llm.counters.wiki - before.wiki,
    };
    assert.deepEqual(actual, expected, `${where}：模型调用绝对次数不符文档口径（实测 ${JSON.stringify(actual)} / 文档 ${JSON.stringify(expected)}）`);
    for (const k of Object.keys(expected)) ledger[k] += expected[k];
  }
  try {
    await new Promise((resolve, reject) => {
      llm.server.once('error', reject);
      llm.server.listen(LLM_PORT_FREE, '127.0.0.1', resolve);
    });
    const llmPort = llm.server.address().port;
    const started = await startServer({
      env: {
        CLOUDWALKER_URL: 'http://127.0.0.1:1',
        CLOUDWALKER_API_TOKEN: 'stub-token-123',
        LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
        LLM_API_KEY: 'sk-stub',
        LLM_MODEL: 'stub-model',
        HIDS_PROMPT_ADMIN_TOKEN: ADMIN_TOKEN,
      },
    });
    child = started.child;
    const base = started.base;

    await t.test('契约形状：会话列表与空态（openapi /api/false-positive/sessions）', async () => {
      const r = await call(base, 'GET', '/api/false-positive/sessions');
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json), ['sessions']);
      assert.ok(Array.isArray(r.json.sessions));
      assert.equal(r.json.sessions.length, 0);
    });

    await t.test('错误码：会话 ID 非 UUID 回 400、合法 UUID 不存在回 404', async () => {
      const bad = await call(base, 'GET', '/api/false-positive/sessions/not-a-uuid');
      assertErrorBody(bad, 400, 'caller_error');
      const missing = await call(base, 'GET', `/api/false-positive/sessions/${randomUUID()}`);
      assertErrorBody(missing, 404, 'caller_error');
    });

    await t.test('边界：正文/理由/登记人/libraries 逐条 400，且不落半份会话', async () => {
      const cases = [
        { name: '正文不是 JSON', raw: '{oops', status: 400 },
        { name: '正文是数组', body: [], status: 400 },
        { name: '缺 reason', body: { who: '何东阳' }, status: 400 },
        { name: 'reason 9 字', body: { reason: '短'.repeat(9), who: '何东阳' }, status: 400 },
        { name: 'reason 4001 字', body: { reason: '长'.repeat(4001), who: '何东阳' }, status: 400 },
        { name: 'who 1 字', body: { reason: '这是一条合法的误报理由', who: '何' }, status: 400 },
        { name: 'libraries 不是数组', body: { reason: '这是一条合法的误报理由', libraries: 'rule' }, status: 400 },
        { name: 'libraries 空数组', body: { reason: '这是一条合法的误报理由', libraries: [] }, status: 400 },
        { name: 'libraries 含未知值', body: { reason: '这是一条合法的误报理由', libraries: ['rule', 'bogus'] }, status: 400 },
      ];
      for (const c of cases) {
        const r = await call(base, 'POST', fpPath(alerts.rule), { body: c.body, raw: c.raw });
        assertErrorBody(r, c.status, 'caller_error');
      }
      const sessions = await call(base, 'GET', '/api/false-positive/sessions');
      assert.equal(sessions.json.sessions.filter((x) => x.case_id === alerts.rule).length, 0, '非法请求不该落下维护会话');
      assert.equal(sessions.json.sessions.length, sessionsExpected, '被拒的请求不该多出会话');
      assert.deepEqual(llm.counters, { decision: 0, rule: 0, wiki: 0 }, '被拒的请求不该起维护轮');
    });

    await t.test('边界（契约）：who 超长按现行口径截到 100 字后照常受理', async () => {
      const before = roundStarted();
      const who = await call(base, 'POST', fpPath(alerts.edge), { body: { reason: '这条不动机器库，只验长度（PATH-NONE）', who: '何'.repeat(101) } });
      assert.equal(who.status, 202, `who 101 字实测 ${who.status}：${who.text.slice(0, 200)}`);
      assert.equal(who.json.feedback.who, '何'.repeat(100), 'who 超长应截到 100 字（现行口径：截断而不是拒收）');
      const rec = await call(base, 'GET', `/api/agent/triage/${encodeURIComponent(alerts.edge)}`);
      assert.equal(rec.json.feedback.who, '何'.repeat(100), '落盘 who 应截到 100 字');
      await waitTerminal(base, alerts.edge);
      // 决策轮（替身）回 libraries:[] → 两侧都不动，只该有那一次决策调用
      expectCalls(before, { decision: 1, rule: 0, wiki: 0 }, 'who 超长那一轮（决策给空库，两侧不动）');
    });

    await t.test('错误码：案件不存在 404、研判未完成 409、reason 4000 字合法（用到长度上限）', async () => {
      assertErrorBody(await call(base, 'POST', fpPath(alerts.unknown), { body: { reason: '这是一条合法的误报理由' } }), 404, 'caller_error');
      const running = await call(base, 'POST', fpPath(alerts.running), { body: { reason: '这是一条合法的误报理由' } });
      assertErrorBody(running, 409, 'caller_error');
      assert.match(running.json.error, /研判还没结束/);
      const max = await call(base, 'POST', fpPath(alerts.running), { body: { reason: '长'.repeat(4000) } });
      assert.equal(max.status, 409, `4000 字应在长度上限内（该被 409 拦在状态上，而不是 400）：${max.text.slice(0, 200)}`);
    });

    let ruleKey;
    let ruleRev;
    let ruleSessionId;

    await t.test('A1/A2/A6/A7 只动规则：202 形状 → 四轮会话落盘 → 维护侧口径', async () => {
      const reason = '这条是运维授权扫描（PATH-RULE），不是攻击';
      const before = roundStarted();
      const post = await call(base, 'POST', fpPath(alerts.rule), { body: { reason, who: '何东阳' } });
      assert.equal(post.status, 202, post.text.slice(0, 400));
      onlyKnownKeys(post.json, ['alert_id', 'verdict', 'feedback', 'maintenance'], '202 响应');
      assert.equal(post.json.alert_id, alerts.rule);
      assert.deepEqual(post.json.verdict, { verdict: 'false_positive', verdict_label: '误报', source: 'human' });
      onlyKnownKeys(post.json.feedback, ['reason', 'who', 'recorded_at'], 'feedback');
      assert.equal(post.json.feedback.reason, reason);
      assert.equal(post.json.feedback.who, '何东阳');
      assert.ok(!Number.isNaN(Date.parse(post.json.feedback.recorded_at)));
      assert.equal(post.json.maintenance.status, 'updating');
      assert.equal(post.json.maintenance.rule.status, 'updating');
      assert.equal(post.json.maintenance.wiki.status, 'updating');

      // 先结论后维护：202 之后立刻读记录已经是误报
      const immediate = await call(base, 'GET', `/api/agent/triage/${encodeURIComponent(alerts.rule)}`);
      assert.equal(immediate.json.verdict, 'false_positive');
      assert.equal(immediate.json.verdict_label, '误报');
      assert.equal(immediate.json.decision_source, 'human');

      const rec = await waitTerminal(base, alerts.rule);
      // A6：只动规则那条路径 = 决策 1 次 + 规则维护 1 次 + 知识维护 0 次（绝对次数）
      expectCalls(before, { decision: 1, rule: 1, wiki: 0 }, '只动规则这一轮');
      const m = rec.maintenance;
      assert.equal(m.status, 'updated');
      assert.deepEqual(m.sides, ['rule']);
      assert.deepEqual(m.libraries, ['rule', 'wiki']);
      assert.equal(m.decision.source, 'model');
      assert.deepEqual(m.decision.libraries, ['rule']);
      assert.equal(typeof m.decision.why, 'string');
      // A7：生效口径是 Rego，且已启用（不再是「待启用」）
      assert.equal(m.auto_verdict.enabled, true);
      assert.equal(m.auto_verdict.criterion, 'rego');
      assert.equal(m.auto_verdict.trust, 'single');
      assert.match(m.auto_verdict.note, /JSON 规则集/);
      // 单边
      assert.equal(m.rule.status, 'updated');
      assert.equal(m.rule.state, 'updated');
      assert.equal(m.rule.id, RULE_ID);
      assert.equal(m.rule.action, 'update');
      assert.match(m.rule.idempotency_key, new RegExp(`^${alerts.rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:rule:[0-9a-f]{16}$`));
      assert.equal(m.wiki.status, 'updated');
      assert.equal(m.wiki.state, 'no_change');
      assert.equal(typeof m.wiki.why, 'string');
      assert.match(m.session_id, /^[0-9a-f-]{36}$/);
      ruleKey = m.rule.idempotency_key;
      ruleRev = m.rule.revision;
      ruleSessionId = m.session_id;

      // 会话全文（openapi FpMaintenanceSession）
      const detail = await call(base, 'GET', `/api/false-positive/sessions/${ruleSessionId}`);
      assert.equal(detail.status, 200, detail.text.slice(0, 300));
      const s = detail.json;
      for (const k of ['id', 'case_id', 'status', 'turns', 'messages', 'outcomes']) assert.ok(k in s, `会话缺 ${k}`);
      assert.equal(s.id, ruleSessionId);
      assert.equal(s.case_id, alerts.rule);
      assert.equal(s.status, 'done');
      assert.equal(s.terminal, true);
      assert.deepEqual(s.turns.map((x) => x.phase), ['case', 'libraries', 'propose', 'verify']);
      for (const turn of s.turns) onlyKnownKeys(turn, ['n', 'phase', 'at', 'summary'], 'turns[]');
      assert.ok(s.messages.some((x) => x.kind === 'case'));
      assert.ok(s.messages.some((x) => x.kind === 'libraries'));
      assert.ok(s.messages.some((x) => x.kind === 'decision'));
      assert.ok(s.messages.some((x) => x.kind === 'verify'));
      for (const msg of s.messages) assert.ok(msg.role === 'user' || msg.role === 'assistant');
      assert.equal(s.decision.source, 'model');
      assert.ok(s.outcomes.rule && s.outcomes.wiki);
      assert.equal(s.validation.ok, true);
      assert.ok(Array.isArray(s.validation.checks) && s.validation.checks.length > 0);
      assert.equal(s.auto_verdict.criterion, 'rego');

      // 摘要（openapi FpMaintenanceSessionSummary，additionalProperties:false）
      const list = await call(base, 'GET', '/api/false-positive/sessions');
      const item = list.json.sessions.find((x) => x.id === ruleSessionId);
      assert.ok(item, '摘要列表里找不到这份会话');
      onlyKnownKeys(item, ['id', 'case_id', 'event_type', 'who', 'status', 'terminal', 'libraries', 'sides', 'decision_source', 'updated_at'], '会话摘要');
      assert.equal(item.id, ruleSessionId);
      assert.equal(item.status, 'done');
      assert.equal(item.terminal, true);
      assert.deepEqual(item.sides, ['rule']);
    });

    await t.test('A3 写入走版本化：规则文件已收紧、旧版进 rules-history、目录无临时文件', async () => {
      const one = await call(base, 'GET', `/api/rules/${RULE_ID}`);
      assert.equal(one.status, 200);
      assert.match(one.json.rego || one.json.content || '', /not input\.source_ip == "203\.0\.113\.9"/);
      const disk = await readFile(`${DATA}/rules/${RULE_ID}.rego`, 'utf8');
      assert.match(disk, /not input\.source_ip == "203\.0\.113\.9"/);
      const hist = await call(base, 'GET', `/api/rules/${RULE_ID}/history`);
      assert.equal(hist.status, 200);
      assert.ok(hist.json.history.length >= 1);
      const note = hist.json.history.at(-1).note || '';
      assert.match(note, /误报维护（何东阳）/);
      const files = await readdir(`${DATA}/rules`);
      assert.deepEqual(files.filter((f) => !f.endsWith('.rego')), [], `规则目录有残留：${files.join(',')}`);
    });

    await t.test('A4/A6 单腿补跑不洗掉已成功一侧的判据（成功 → 单腿 → 全量 仍只跑一次）', async () => {
      const rulesBefore = llm.counters.rule;
      const b1 = roundStarted();
      const leg = await call(base, 'POST', fpPath(alerts.rule), { body: { reason: '补跑规则侧（PATH-RULE）', libraries: ['rule'] } });
      assert.equal(leg.status, 202);
      const rec1 = await waitTerminal(base, alerts.rule);
      // A6：请求的库都已在同一版本上 → 幂等，不调决策模型、不写盘（http-api.md §3.4「补跑与幂等」）
      expectCalls(b1, { decision: 0, rule: 0, wiki: 0 }, '单腿补跑（幂等命中）');
      assert.equal(rec1.maintenance.decision.source, 'idempotent');
      assert.equal(rec1.maintenance.rule.state, 'skipped');
      assert.equal(rec1.maintenance.rule.idempotency_key, ruleKey, '单腿补跑把幂等键洗掉了');
      assert.equal(rec1.maintenance.rule.revision, ruleRev, '单腿补跑把 revision 洗掉了');
      assert.equal(llm.counters.rule, rulesBefore, '已成功的一侧被重跑了');
      assert.equal(rec1.maintenance.status, 'updated');

      const b2 = roundStarted();
      const full = await call(base, 'POST', fpPath(alerts.rule), { body: { reason: '再登记一次全量（PATH-RULE）' } });
      assert.equal(full.status, 202);
      const rec2 = await waitTerminal(base, alerts.rule);
      expectCalls(b2, { decision: 0, rule: 0, wiki: 0 }, '全量再登记（两侧都已在同一版本，幂等）');
      assert.equal(rec2.maintenance.rule.state, 'skipped', '全量再登记时已成功的一侧被重跑');
      assert.equal(rec2.maintenance.rule.idempotency_key, ruleKey);
      assert.equal(llm.counters.rule, rulesBefore, '全量再登记重跑了已成功的一侧');
      assert.deepEqual(rec2.maintenance.sides, []);

      const decisionBefore = llm.counters.decision;
      const b3 = roundStarted();
      const again = await call(base, 'POST', fpPath(alerts.rule), { body: { reason: '只请求规则侧（PATH-RULE）', libraries: ['rule'] } });
      assert.equal(again.status, 202);
      const rec3 = await waitTerminal(base, alerts.rule);
      expectCalls(b3, { decision: 0, rule: 0, wiki: 0 }, '幂等再登记（只请求规则侧）');
      assert.equal(rec3.maintenance.decision.source, 'idempotent');
      assert.deepEqual(rec3.maintenance.sides, []);
      assert.equal(llm.counters.decision, decisionBefore, '幂等轮不该再调决策模型');
      assert.equal(llm.counters.rule, rulesBefore);
      // 记录上的 maintenance 原样供 GET 读
      const viaRecord = await call(base, 'GET', `/api/agent/triage/${encodeURIComponent(alerts.rule)}`);
      assert.equal(viaRecord.json.maintenance.decision.source, 'idempotent');
    });

    let wikiSessionId;

    await t.test('A2/A3/A6 只动知识库：规则库一字不动、判据页过发布闸、发布后会话终态、无重复发布口子', async () => {
      const ruleBefore = await readFile(`${DATA}/rules/${RULE_ID}.rego`, 'utf8');
      const before = roundStarted();
      const post = await call(base, 'POST', fpPath(alerts.wiki), { body: { reason: '规则没错，判据页缺边界（PATH-WIKI）', who: '何东阳' } });
      assert.equal(post.status, 202);
      const rec = await waitTerminal(base, alerts.wiki);
      // A6：只动知识库那条路径 = 决策 1 次 + 规则维护 0 次 + 知识维护 1 次（绝对次数）
      expectCalls(before, { decision: 1, rule: 0, wiki: 1 }, '只动知识库这一轮');
      const m = rec.maintenance;
      assert.equal(m.status, 'updated');
      assert.deepEqual(m.sides, ['wiki']);
      assert.equal(m.rule.state, 'no_change');
      assert.equal(m.wiki.state, 'updated');
      assert.equal(m.wiki.page, WIKI_PAGE);
      assert.equal(typeof m.wiki.revision, 'string');
      assert.equal(m.wiki.wiki_session_status, 'published');
      assert.equal(await readFile(`${DATA}/rules/${RULE_ID}.rego`, 'utf8'), ruleBefore, '只动知识库时规则文件被改写');
      const page = await readFile(`${DATA}/wiki/${WIKI_PAGE}`, 'utf8');
      assert.match(page, /补充（2026-11-20）/);
      wikiSessionId = m.wiki.session_id;

      // 无重复发布口子：同一份 wiki 维护会话再发布一次 409
      const republish = await call(base, 'POST', `/api/wiki/sessions/${wikiSessionId}/publish`, {
        headers: { 'x-prompt-admin-token': ADMIN_TOKEN }, body: {},
      });
      assertErrorBody(republish, 409, 'caller_error');

      // 同一库同一版本上再登记 → 幂等跳过，不再发布一次
      const b2 = roundStarted();
      const again = await call(base, 'POST', fpPath(alerts.wiki), { body: { reason: '再登记一次（PATH-WIKI）', libraries: ['wiki'] } });
      assert.equal(again.status, 202);
      const rec2 = await waitTerminal(base, alerts.wiki);
      expectCalls(b2, { decision: 0, rule: 0, wiki: 0 }, '知识库幂等再登记');
      assert.equal(rec2.maintenance.wiki.state, 'skipped');
      assert.deepEqual(rec2.maintenance.sides, []);
    });

    await t.test('A2/A6 两边都动：两侧都写、sides 与决策可见', async () => {
      const before = roundStarted();
      const post = await call(base, 'POST', fpPath(alerts.both), { body: { reason: '规则与判据各有缺口（PATH-BOTH）', who: '何东阳' } });
      assert.equal(post.status, 202);
      const rec = await waitTerminal(base, alerts.both);
      // A6：两边都动 = 决策 1 次 + 规则 1 次 + 知识 1 次（绝对次数）
      expectCalls(before, { decision: 1, rule: 1, wiki: 1 }, '两边都动这一轮');
      const m = rec.maintenance;
      assert.equal(m.status, 'updated');
      assert.deepEqual(m.sides, ['rule', 'wiki']);
      assert.deepEqual(m.decision.libraries, ['rule', 'wiki']);
      assert.equal(m.rule.state, 'updated');
      assert.equal(m.wiki.state, 'updated');
      const disk = await readFile(`${DATA}/rules/${RULE_ID}.rego`, 'utf8');
      assert.match(disk, /not input\.user == "scanner"/);
    });

    await t.test('A4/A6 单库失败可补跑：失败侧重跑、未请求侧不重发，维护失败不改结论', async () => {
      const before = roundStarted();
      const widen = await call(base, 'POST', fpPath(alerts.fail), { body: { reason: '规则改宽试试（PATH-FAIL）', who: '何东阳' } });
      assert.equal(widen.status, 202);
      const bad = await waitTerminal(base, alerts.fail);
      // 决策说只动规则 → 规则维护 1 次（这一轮失败）、知识维护 0 次
      expectCalls(before, { decision: 1, rule: 1, wiki: 0 }, '失败那一轮（决策只给规则侧）');
      assert.equal(bad.maintenance.status, 'failed');
      assert.equal(bad.maintenance.rule.state, 'failed');
      assert.match(bad.maintenance.rule.error, /放宽/);
      assert.equal(bad.verdict, 'false_positive', '维护失败不该改结论');
      assert.equal(bad.decision_source, 'human');
      const disk = await readFile(`${DATA}/rules/${RULE_ID}.rego`, 'utf8');
      assert.doesNotMatch(disk, /放宽版/, '失败候选不该落盘');
      const files = await readdir(`${DATA}/rules`);
      assert.deepEqual(files.filter((f) => !f.endsWith('.rego')), [], `规则目录有残留：${files.join(',')}`);

      const b2 = roundStarted();
      const retry = await call(base, 'POST', fpPath(alerts.fail), { body: { reason: '补跑规则侧（PATH-FAIL）', libraries: ['rule'] } });
      assert.equal(retry.status, 202);
      const ok = await waitTerminal(base, alerts.fail);
      // A6 补跑不重发：只请求规则侧 → 规则维护 1 次，知识维护 0 次（未请求侧不许发调用）
      expectCalls(b2, { decision: 1, rule: 1, wiki: 0 }, '失败侧单腿补跑');
      assert.equal(ok.maintenance.status, 'updated');
      assert.equal(ok.maintenance.rule.state, 'updated');
      assert.equal(ok.maintenance.wiki.state, 'skipped');
      assert.match(ok.maintenance.wiki.why || '', /本次只补跑/);
    });

    await t.test('A5 每轮 AI 调用都进 T046 事件（域＝误报维护）：绝对条数 + 逐轮唯一 + 顺序', async () => {
      assert.deepEqual(llm.counters, ledger, `替身计数 ${JSON.stringify(llm.counters)} 与逐轮累加 ${JSON.stringify(ledger)} 不一致`);
      const expect = { ...llm.counters };
      const expectedEvents = 2 * (expect.decision + expect.rule + expect.wiki);
      let events = [];
      for (let i = 0; i < 60; i++) {
        const lines = (await readFile(`${TMP}/server.log`, 'utf8')).split('\n').filter(Boolean);
        events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          .filter((e) => e.event === 'ai.model_call' && e.domain === 'false_positive');
        if (events.length >= expectedEvents) break;
        await sleep(50);
      }
      // 会话 → 它那一轮的知识维护会话 id（顺序断言用；wiki 维护轮的 session_id 是它自己那份）
      const wikiSessionOf = {};
      const all = await call(base, 'GET', '/api/false-positive/sessions');
      for (const s of all.json.sessions) {
        const d = await call(base, 'GET', `/api/false-positive/sessions/${s.id}`);
        const w = d.json?.outcomes?.wiki?.session_id;
        if (w) wikiSessionOf[s.id] = w;
      }
      const stats = checkModelCallEvents(events, { expect, wikiSessionOf });
      t.diagnostic(`A5 实测 ${JSON.stringify(stats)}；替身计数 ${JSON.stringify(expect)}；逐轮累加 ${JSON.stringify(ledger)}`);
      assert.equal(stats.total, expectedEvents);
    });

    await t.test('错误码 502：会话目录不可读时列表回 502（不是空列表）', async () => {
      const dir = `${DATA}/fp-sessions`;
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o000);
      try {
        const r = await call(base, 'GET', '/api/false-positive/sessions');
        assertErrorBody(r, 502, 'upstream_error');
      } finally {
        await chmod(dir, 0o700);
      }
      const back = await call(base, 'GET', '/api/false-positive/sessions');
      assert.equal(back.status, 200);
      // 一份 202 = 一份会话（幂等轮也算一轮，也落盘）；被拒的请求一份都不该多
      assert.equal(back.json.sessions.length, sessionsExpected, `会话数 ${back.json.sessions.length} 与 202 次数 ${sessionsExpected} 不符`);
      const at = back.json.sessions.map((s) => Date.parse(s.updated_at));
      for (let i = 1; i < at.length; i++) assert.ok(at[i - 1] >= at[i], '会话摘要应按 updated_at 倒序');
    });

    await t.test('契约（openapi:862）：libraries uniqueItems —— 重复项应被拒 400', async () => {
      // openapi.yaml 的误报请求正文写了 `libraries: {minItems: 1, uniqueItems: true, items: enum:[rule, wiki]}`
      const before = snapshot();
      const dup = await call(base, 'POST', fpPath(alerts.edge), { body: { reason: '这条不动机器库，只验唯一性（PATH-NONE）', libraries: ['rule', 'rule'] } });
      assertErrorBody(dup, 400, 'caller_error');
      assert.deepEqual(snapshot(), before, '被拒的请求不该起维护轮');
    });
  } finally {
    if (child) child.kill('SIGKILL');
    await new Promise((r) => llm.server.close(() => r()));
  }
});

test('错误码 503：无研判队列的进程里登记误报回 503 not_configured（createServer() 缺件路径，文档 §2）', async () => {
  const port = 18149;
  const dir = `${TMP}/nodeps-data`;
  await mkdir(dir, { recursive: true });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import('${ROOT}/server.js').then((m) => { m.createServer().listen(${port}, '127.0.0.1'); });`], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HIDS_PORT: String(port), HIDS_HOST: '127.0.0.1', HIDS_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exit = null;
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up && !exit; i++) {
      try {
        up = await isOurServer(`http://127.0.0.1:${port}/api/status`);
      } catch { /* 还没起来 */ }
      if (!up) await sleep(100);
    }
    assert.ok(up, `缺件进程没起来（exit=${JSON.stringify(exit)}）：${out.slice(-500)}`);
    const id = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763373600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
    const r = await call(`http://127.0.0.1:${port}`, 'POST', `/api/agent/triage/${encodeURIComponent(id)}/false-positive`, { body: { reason: '无队列进程下的误报登记' } });
    assertErrorBody(r, 503, 'not_configured');
    assert.match(r.json.error, /自动研判尚未配置/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('契约静态口径（A7）：openapi 与两页文档同一口径，「待启用/待拍板」清零', async () => {
  const files = ['openapi.yaml', 'docs/modules/http-api.md', 'docs/modules/triage-pipeline.md'];
  for (const f of files) {
    const text = await readFile(`${ROOT}/${f}`, 'utf8');
    assert.doesNotMatch(text, /待启用|待拍板/, `${f} 里还留着旧口径`);
  }
  const spec = await readFile(`${ROOT}/openapi.yaml`, 'utf8');
  assert.match(spec, /以 Rego 规则库为准/);
  const block = spec.slice(spec.indexOf('    FpAutoVerdict:'));
  const head = block.slice(0, block.indexOf('    FpMaintenanceSessionSummary:'));
  assert.match(head, /required: \[enabled, criterion\]/);
  assert.match(head, /criterion:.*enum: \[rego\]/);
  assert.match(head, /trust:.*enum: \[single\]/);
});
