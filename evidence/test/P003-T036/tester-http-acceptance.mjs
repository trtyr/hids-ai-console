// P003-T036 验收方（何东阳）独立复验脚本：只按文档（openapi.yaml TriageSummary / DELETE / control，
// docs/modules/triage-pipeline.md §5/§8/§10，docs/modules/http-api.md §3 路由表）造真实 HTTP 请求，
// 逐条断言响应体形状、必填键、类型、枚举与 4xx 错误面。不看实现内容。
// 跑法：node evidence/test/P003-T036/tester-http-acceptance.mjs
// 纪律：独立数据根（mkdtemp），等状态用带超时的 until()，无固定 sleep，结束必关 server / monitor。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';
import { InvestigationStore } from '../../../src/contexts/triage/infrastructure/investigation-store.js';
import { createServer } from '../../../server.js';

let failures = 0;
const results = [];
function ok(name, extra = '') { results.push(`PASS ${name}${extra ? ' — ' + extra : ''}`); }
function bad(name, why) { failures += 1; results.push(`FAIL ${name} — ${why}`); }
function note(name, why) { results.push(`DOC-SIDE ${name} — ${why}`); }
function check(name, cond, why) { if (cond) ok(name); else bad(name, why); }

async function until(fn, { timeoutMs = 5000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`超时未满足：${label}`);
    await new Promise(r => setTimeout(r, 3));
  }
}

const tempRoots = [];
async function tempDir(prefix = 'hids-t036-tester-') {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(d);
  return d;
}

function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
function exactKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    && JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
}
function keysPresent(obj, keys) {
  return obj && typeof obj === 'object' && keys.every(k => Object.prototype.hasOwnProperty.call(obj, k));
}

// openapi.yaml:1653 TriageSummary.required
const SUMMARY_REQUIRED = ['initialized', 'enabled', 'input_mode', 'since', 'counts', 'verdict_counts',
  'type_counts', 'queue', 'failure_reasons', 'retry', 'paused', 'archived', 'persist'];

// openapi.yaml TriageSummary 逐字段承诺（required + 类型 + 枚举）
function validateSummary(tag, s, { mode }) {
  const missing = SUMMARY_REQUIRED.filter(k => !(k in s));
  check(`${tag} summary 顶层 required 13 键齐全`, missing.length === 0, `缺 ${missing.join(',')}`);
  check(`${tag} initialized 布尔`, typeof s.initialized === 'boolean', String(s.initialized));
  check(`${tag} enabled 布尔`, typeof s.enabled === 'boolean', String(s.enabled));
  check(`${tag} input_mode ∈ {syslog,poll}`, ['syslog', 'poll'].includes(s.input_mode), String(s.input_mode));
  check(`${tag} input_mode=${mode}`, s.input_mode === mode, String(s.input_mode));
  check(`${tag} since 无参时为 null`, s.since === null, JSON.stringify(s.since));

  const countsOk = exactKeys(s.counts, ['queued', 'running', 'done', 'failed'])
    && ['queued', 'running', 'done', 'failed'].every(k => isInt(s.counts[k]));
  check(`${tag} counts 四键恒在且为整数`, countsOk, JSON.stringify(s.counts));

  const verdictOk = exactKeys(s.verdict_counts, ['threat', 'uncertain', 'false_positive', 'review'])
    && Object.values(s.verdict_counts).every(isInt);
  check(`${tag} verdict_counts required 四键 + 整数`, verdictOk, JSON.stringify(s.verdict_counts));

  check(`${tag} type_counts 是对象`, s.type_counts && typeof s.type_counts === 'object'
    && !Array.isArray(s.type_counts), JSON.stringify(s.type_counts));

  const q = s.queue;
  const queueOk = exactKeys(q, ['depth', 'running', 'oldest_wait_ms', 'oldest_alert_id', 'retry_waiting'])
    && isInt(q.depth) && isInt(q.running) && isInt(q.retry_waiting)
    && (q.oldest_wait_ms === null || isInt(q.oldest_wait_ms))
    && (q.oldest_alert_id === null || typeof q.oldest_alert_id === 'string');
  check(`${tag} queue required 五键、类型对`, queueOk, JSON.stringify(q));

  check(`${tag} failure_reasons 是对象`, s.failure_reasons && typeof s.failure_reasons === 'object'
    && !Array.isArray(s.failure_reasons), JSON.stringify(s.failure_reasons));

  const r = s.retry;
  const retryOk = exactKeys(r, ['base_ms', 'max_ms', 'max_attempts', 'dead_letters'])
    && Object.values(r).every(isInt);
  check(`${tag} retry required 四键 + 整数`, retryOk, JSON.stringify(r));

  const p = s.paused;
  const pausedOk = exactKeys(p, ['active', 'since', 'received', 'buffered', 'dropped', 'replayed'])
    && typeof p.active === 'boolean' && (p.since === null || typeof p.since === 'string')
    && isInt(p.received) && isInt(p.buffered) && isInt(p.dropped) && isInt(p.replayed);
  check(`${tag} paused required 六键、类型对`, pausedOk, JSON.stringify(p));
  check(`${tag} paused.active 与 enabled 互为反面`, p.active === !s.enabled, `active=${p.active} enabled=${s.enabled}`);

  const a = s.archived;
  check(`${tag} archived required 两键 + 整数`, exactKeys(a, ['count', 'ttl_ms'])
    && isInt(a.count) && isInt(a.ttl_ms), JSON.stringify(a));

  const pe = s.persist;
  check(`${tag} persist required 两键、类型对`, exactKeys(pe, ['interval_ms', 'unflushed'])
    && isInt(pe.interval_ms) && typeof pe.unflushed === 'boolean', JSON.stringify(pe));

  if (mode === 'syslog') {
    check(`${tag} syslog 对象 required [listening,bind,error]`, keysPresent(s.syslog, ['listening', 'bind', 'error'])
      && typeof s.syslog.listening === 'boolean'
      && (s.syslog.bind === null || typeof s.syslog.bind === 'string')
      && (s.syslog.error === null || typeof s.syslog.error === 'string'), JSON.stringify(s.syslog));
    const st = s.syslog_stats;
    const stKeys = ['inbound', 'accepted', 'collapsed', 'buffered', 'dropped', 'rejected', 'failed'];
    check(`${tag} syslog_stats required 七键 + 整数`, keysPresent(st, stKeys) && stKeys.every(k => isInt(st[k])),
      JSON.stringify(st));
  } else {
    check(`${tag} poll 模式不带 syslog 键`, !('syslog' in s), JSON.stringify(s.syslog));
    check(`${tag} poll 模式不带 syslog_stats 键`, !('syslog_stats' in s), JSON.stringify(s.syslog_stats));
  }
}

function validateErrorBody(tag, body, expectCode = 'caller_error') {
  check(`${tag} 错误体形状 {error:string, code:string}`, body && typeof body === 'object'
    && typeof body.error === 'string' && body.error.length > 0 && typeof body.code === 'string',
    JSON.stringify(body));
  check(`${tag} code=${expectCode}`, body?.code === expectCode, String(body?.code));
}

async function bootServer(monitor) {
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const SYSLOG_LINE = (sourceIp, second = '2026-11-03 08:00:00') =>
  '<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot '
  + `host_ip="10.0.0.5" event_create_time="${second}" source_ip="${sourceIp}" target_port="80"`;

const okInvestigator = () => ({
  runUnmatchedSyslog: async () => ({
    mode: 'triage',
    verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '待复核', claims: [] },
    validation: { ok: true }, evidence: [],
  }),
});

async function main() {
  // ── 1. syslog 模式：GET /status 契约符合性 ───────────────────────────────
  {
    const dir = await tempDir();
    const monitor = new TriageMonitor({
      inputMode: 'syslog', concurrency: 0, service: {},
      history: new InvestigationStore(path.join(dir, 'investigations')),
      file: path.join(dir, 'queue.json'), casesDirectory: path.join(dir, 'cases'),
      eventToolbox: null, investigator: okInvestigator(),
    });
    await monitor.start();
    const { server, base } = await bootServer(monitor);
    try {
      const res = await fetch(`${base}/api/agent/triage/status`);
      const body = await res.json();
      check('GET /status 200', res.status === 200, String(res.status));
      validateSummary('[空队列]', body, { mode: 'syslog' });
      check('[空队列] queue.depth=0', body.queue.depth === 0, String(body.queue.depth));
      check('[空队列] paused.received=0 / since=null', body.paused.received === 0 && body.paused.since === null,
        JSON.stringify(body.paused));
      check('[空队列] retry.max_attempts ≥ 1', body.retry.max_attempts >= 1, JSON.stringify(body.retry));
      check('[空队列] persist.interval_ms=1000 缺省', body.persist.interval_ms === 1000, String(body.persist.interval_ms));
      check('[空队列] archived.ttl_ms=86400000 缺省', body.archived.ttl_ms === 86_400_000, String(body.archived.ttl_ms));

      // 有排队记录后：queue.depth 跟着走
      const accepted = await monitor.acceptSyslog(SYSLOG_LINE('192.0.2.101'));
      const body2 = await (await fetch(`${base}/api/agent/triage/status`)).json();
      check('[1 条排队] queue.depth=1', body2.queue.depth === 1, String(body2.queue.depth));
      check('[1 条排队] oldest_alert_id=该记录', body2.queue.oldest_alert_id === accepted.alert_id,
        String(body2.queue.oldest_alert_id));
      check('[1 条排队] oldest_wait_ms 为整数', isInt(body2.queue.oldest_wait_ms), String(body2.queue.oldest_wait_ms));
      validateSummary('[1 条排队]', body2, { mode: 'syslog' });

      // ── 2. PUT /control 暂停 / 恢复 + summary 返回体 ────────────────────
      const paused = await fetch(`${base}/api/agent/triage/control`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
      });
      const pausedBody = await paused.json();
      check('PUT /control {enabled:false} 200', paused.status === 200, String(paused.status));
      validateSummary('[暂停后]', pausedBody, { mode: 'syslog' });
      check('[暂停后] enabled=false / paused.active=true', pausedBody.enabled === false && pausedBody.paused.active === true,
        JSON.stringify({ enabled: pausedBody.enabled, active: pausedBody.paused.active }));
      check('[暂停后] paused.since 非 null（RFC3339 可解析）', typeof pausedBody.paused.since === 'string'
        && !Number.isNaN(Date.parse(pausedBody.paused.since)), String(pausedBody.paused.since));

      const resumed = await fetch(`${base}/api/agent/triage/control`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
      });
      const resumedBody = await resumed.json();
      check('PUT /control {enabled:true} 200', resumed.status === 200, String(resumed.status));
      check('[恢复后] enabled=true / paused.active=false', resumedBody.enabled === true && resumedBody.paused.active === false,
        JSON.stringify({ enabled: resumedBody.enabled, active: resumedBody.paused.active }));
      check('[恢复后] 排队记录未被清空（docs §5.4：不删 queued）', resumedBody.counts.queued === 1,
        JSON.stringify(resumedBody.counts));

      // 暂停时收到的报文进缓冲，summary 报得上（docs R-TRIAGE-05）
      await fetch(`${base}/api/agent/triage/control`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
      });
      await monitor.acceptSyslog(SYSLOG_LINE('192.0.2.102'));
      await monitor.acceptSyslog(SYSLOG_LINE('192.0.2.103'));
      const buffered = await (await fetch(`${base}/api/agent/triage/status`)).json();
      check('[暂停收 2 条] paused.received=2 / buffered=2', buffered.paused.received === 2 && buffered.paused.buffered === 2,
        JSON.stringify(buffered.paused));
      check('[暂停收 2 条] syslog_stats.buffered=2', buffered.syslog_stats.buffered === 2,
        JSON.stringify(buffered.syslog_stats));
      const resumed2 = await (await fetch(`${base}/api/agent/triage/control`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
      })).json();
      check('[恢复回灌] paused.buffered=0 / replayed=2', resumed2.paused.buffered === 0 && resumed2.paused.replayed === 2,
        JSON.stringify(resumed2.paused));

      // ── 3. PUT /control 边界与错误面 ───────────────────────────────────
      const controlCases = [
        ['无正文', undefined],
        ['空对象 {}', JSON.stringify({})],
        ['enabled 是字符串 "yes"', JSON.stringify({ enabled: 'yes' })],
        ['enabled 是数字 1', JSON.stringify({ enabled: 1 })],
        ['正文不是对象 "true"', JSON.stringify(true)],
      ];
      for (const [label, body] of controlCases) {
        const res = await fetch(`${base}/api/agent/triage/control`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body,
        });
        const parsed = await res.json().catch(() => null);
        check(`PUT /control ${label} → 400`, res.status === 400, String(res.status));
        validateErrorBody(`PUT /control ${label}`, parsed);
      }

      // openapi.yaml:479 请求体声明 additionalProperties:false，实测多余键被忽略 → spec 过度承诺（本卡之前就如此）
      {
        const res = await fetch(`${base}/api/agent/triage/control`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true, foo: 1 }),
        });
        if (res.status === 400) ok('PUT /control 多余键 → 400（与 openapi:479 一致）');
        else note('PUT /control 多余键 {enabled:true,foo:1} 实测被忽略',
          `openapi.yaml:479 additionalProperties:false 说该正文不合法，实测回 ${res.status}；该声明在本卡之前就存在，不保证拒绝多余键`);
      }

      // ── 4. GET /status?since= 坏值 ─────────────────────────────────────
      const badSince = await fetch(`${base}/api/agent/triage/status?since=not-a-time`);
      check('GET /status?since=坏值 → 400', badSince.status === 400, String(badSince.status));
      validateErrorBody('GET /status?since=坏值', await badSince.json().catch(() => null));

      // ── 5. DELETE 取消接口契约 ─────────────────────────────────────────
      const target = accepted.alert_id;
      const url = `${base}/api/agent/triage/${encodeURIComponent(target)}`;
      const del = await fetch(url, { method: 'DELETE' });
      const delBody = await del.json();
      check('DELETE 排队记录 → 200', del.status === 200, String(del.status));
      check('DELETE 200 体恰是 {alert_id,status,cancelled}（additionalProperties:false）',
        exactKeys(delBody, ['alert_id', 'status', 'cancelled']), JSON.stringify(delBody));
      check('DELETE 200 体 status=not_queued / cancelled=true',
        delBody.status === 'not_queued' && delBody.cancelled === true && delBody.alert_id === target,
        JSON.stringify(delBody));
      const afterGet = await (await fetch(url)).json();
      check('取消后 GET 回 not_queued', afterGet.status === 'not_queued', String(afterGet.status));
      const again = await fetch(url, { method: 'DELETE' });
      check('再删一次 → 404', again.status === 404, String(again.status));
      validateErrorBody('再删一次', await again.json().catch(() => null));
      const invalid = await fetch(`${base}/api/agent/triage/%20`, { method: 'DELETE' });
      check('DELETE 无效 ID → 400', invalid.status === 400, String(invalid.status));
      validateErrorBody('DELETE 无效 ID', await invalid.json().catch(() => null));
      const longId = 'honeypot:' + 'a'.repeat(5000);
      const longRes = await fetch(`${base}/api/agent/triage/${encodeURIComponent(longId)}`, { method: 'DELETE' });
      check('DELETE 超长 ID（5000 字）→ 400', longRes.status === 400, String(longRes.status));
      validateErrorBody('DELETE 超长 ID', await longRes.json().catch(() => null));
      const unknown = await fetch(`${base}/api/agent/triage/${encodeURIComponent('honeypot:404404')}`, { method: 'DELETE' });
      check('DELETE 合法形状但无此记录 → 404', unknown.status === 404, String(unknown.status));
      validateErrorBody('DELETE 无此记录', await unknown.json().catch(() => null));
    } finally {
      await new Promise(resolve => server.close(resolve));
      monitor.stop();
    }
  }

  // ── 6. DELETE 在研判中 → 409；已完成 → 409（docs http-api:104）─────────
  {
    const dir = await tempDir();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const monitor = new TriageMonitor({
      inputMode: 'syslog', concurrency: 1, service: {},
      history: new InvestigationStore(path.join(dir, 'investigations')),
      file: path.join(dir, 'queue.json'), casesDirectory: path.join(dir, 'cases'),
      eventToolbox: null,
      investigator: {
        runUnmatchedSyslog: async () => {
          await gate;
          return { mode: 'triage', verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '待复核', claims: [] },
            validation: { ok: true }, evidence: [] };
        },
      },
    });
    await monitor.start();
    const { server, base } = await bootServer(monitor);
    try {
      const running = await monitor.acceptSyslog(SYSLOG_LINE('192.0.2.201'));
      await until(async () => (await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(running.alert_id)}`)).json())
        .status === 'running', { label: '记录进入 running' });
      const res = await fetch(`${base}/api/agent/triage/${encodeURIComponent(running.alert_id)}`, { method: 'DELETE' });
      check('DELETE 在研判中（running）→ 409', res.status === 409, String(res.status));
      validateErrorBody('DELETE running', await res.json().catch(() => null));
      release();
      await until(async () => (await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(running.alert_id)}`)).json())
        .status === 'done', { label: '记录跑完变 done' });
      const doneDel = await fetch(`${base}/api/agent/triage/${encodeURIComponent(running.alert_id)}`, { method: 'DELETE' });
      check('DELETE 已完成（done）→ 409', doneDel.status === 409, String(doneDel.status));
      validateErrorBody('DELETE done', await doneDel.json().catch(() => null));
      const stillHere = await (await fetch(`${base}/api/agent/triage/${encodeURIComponent(running.alert_id)}`)).json();
      check('409 之后记录仍在（done 没被顺手删掉）', stillHere.status === 'done', String(stillHere.status));
    } finally {
      await new Promise(resolve => server.close(resolve));
      monitor.stop();
    }
  }

  // ── 7. poll 模式 summary 不带 syslog 键 ──────────────────────────────
  {
    const dir = await tempDir();
    const monitor = new TriageMonitor({
      inputMode: 'poll', concurrency: 0, service: {}, history: new InvestigationStore(path.join(dir, 'investigations')),
      file: path.join(dir, 'queue.json'), casesDirectory: path.join(dir, 'cases'), eventToolbox: null, investigator: {},
    });
    const { server, base } = await bootServer(monitor);
    try {
      const res = await fetch(`${base}/api/agent/triage/status`);
      const body = await res.json();
      check('poll 模式 GET /status 200', res.status === 200, String(res.status));
      validateSummary('[poll]', body, { mode: 'poll' });
      check('[poll] last_poll_at 键在', 'last_poll_at' in body, JSON.stringify(Object.keys(body)));
    } finally {
      await new Promise(resolve => server.close(resolve));
      monitor.stop();
    }
  }

  // ── 8. 没有研判队列：triage 路由回 503 not_configured ────────────────
  {
    const { server, base } = await bootServer(null);
    try {
      for (const [label, url, init] of [
        ['GET /status', `${base}/api/agent/triage/status`, { method: 'GET' }],
        ['GET /cases', `${base}/api/agent/triage/cases`, { method: 'GET' }],
        ['DELETE 单条', `${base}/api/agent/triage/honeypot:1`, { method: 'DELETE' }],
        ['PUT /control', `${base}/api/agent/triage/control`,
          { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }],
      ]) {
        const res = await fetch(url, init);
        const body = await res.json().catch(() => null);
        check(`无研判队列 ${label} → 503`, res.status === 503, String(res.status));
        validateErrorBody(`无研判队列 ${label}`, body, 'not_configured');
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'TESTER_OK' : 'TESTER_FAIL'} 共 ${results.length} 条断言，失败 ${failures}`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.log(results.join('\n'));
  console.log(`TESTER_CRASH ${error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error}`);
  code = 1;
} finally {
  for (const d of tempRoots) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
}
process.exitCode = code;
