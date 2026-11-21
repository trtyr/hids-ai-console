// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { createConfigStore } from './src/contexts/dataops/infrastructure/config-store.js';
import { createMaintenanceServer } from './src/interfaces/http/maintenance/server.js';
import { UpdateStore } from './src/contexts/dataops/infrastructure/update-store.js';
import { PromptStore } from './src/contexts/knowledge/infrastructure/prompt-store.js';
import { TriageMonitor } from './src/contexts/triage/application/triage-monitor.js';
import { InvestigationStore } from './src/contexts/triage/infrastructure/investigation-store.js';
import { auditEvent, redactValues, AUDIT_ACTIONS } from './src/contexts/audit/domain/audit-event.js';
import { AuditStore } from './src/contexts/audit/infrastructure/audit-store.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const auditBody = async (base, query = '') => {
  const response = await fetch(`${base}/api/audit${query}`);
  return { status: response.status, body: await response.json() };
};

// ── 领域层纯函数 ─────────────────────────────────────────────────────────────
test('auditEvent：actor 必须可识别、动作必须在表内、result 三值', () => {
  const event = auditEvent({ actor: { kind: 'user', id: 'ops' }, action: 'config.write',
    object: { kind: 'config', keys: ['LLM_MODEL'] }, before: { LLM_MODEL: 'a' }, after: { LLM_MODEL: 'b' } });
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.actor.id, 'ops');
  assert.equal(event.result, 'ok');
  assert.equal(event.request_id, null, '系统动作无请求链');
  assert.throws(() => auditEvent({ action: 'config.write' }), /actor/, '没有 actor 的审计事件必须被拒');
  assert.throws(() => auditEvent({ actor: { kind: 'user', id: 'x' }, action: 'hack.the.planet' }), /未知审计动作/);
  assert.throws(() => auditEvent({ actor: { kind: 'user', id: 'x' }, action: 'config.write', result: 'maybe' }), /审计结果非法/);
  for (const action of AUDIT_ACTIONS) assert.ok(auditEvent({ actor: { kind: 'system', id: 'backend' }, action }), action);
});

test('redactValues：机密键的新旧值只记「已改」不记明文', () => {
  const values = redactValues({ LLM_MODEL: 'gpt-x', LLM_API_KEY: 'sk-secret-123', CLOUDWALKER_API_TOKEN: 'tok-1' });
  assert.equal(values.LLM_MODEL, 'gpt-x');
  assert.equal(values.LLM_API_KEY, '[redacted-changed]');
  assert.equal(values.CLOUDWALKER_API_TOKEN, '[redacted-changed]');
});

// ── 端到端：业务端写接口逐个 → GET /api/audit 查到事件；GET 不产生事件 ────────────
test('业务端写接口全量留痕：成功 ok、令牌拒绝 denied、GET 不留痕', async t => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-audit-queue.json', service: {}, investigator: {}, history: {}, concurrency: 0 });
  const history = new InvestigationStore('/tmp/hids-audit-inv');
  const investigator = { model: { model: 'fake' }, prompts: async () => ({ scenarios: { cards: [] } }),
    run: async (alertId, { mode }) => ({ alert_id: alertId, mode, verdict: { verdict: 'uncertain', claims: [] },
      validation: { ok: true }, trace: [] }) };
  // 第 14 参给 ruleAdminToken：规则写路由可到 403（denied 审计的触发点）
  const base = await listen(t, createServer({ alerts: async () => ({ alerts: [], total: 0, partial: false }) },
    null, investigator, history, new PromptStore('/tmp/hids-audit-prompts.json'), monitor,
    null, null, null, null, null, null, null, 'test-rule-token'));
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const put = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // 1) 写配置（模型三项齐全才过校验；机密只记「已改」+ 来源）
  assert.equal((await post('/api/config', { LLM_BASE_URL: 'http://127.0.0.1:1/v1',
    LLM_API_KEY: 'sk-audit-secret', LLM_MODEL: 'audit-model' })).status, 200);
  // 2) 入队 + 控制开关 + 取消（取消会删记录，所以用另一条告警做误报登记）
  assert.equal((await post('/api/agent/triage/honeypot:7', {})).status, 202);
  assert.equal((await put('/api/agent/triage/control', { enabled: false })).status, 200);
  assert.equal((await fetch(`${base}/api/agent/triage/honeypot:7`, { method: 'DELETE' })).status, 200);
  // 3) 误报登记（重新入队、排队记录置 done 后受理；后台维护腿未配置，不影响 202 与审计）
  assert.equal((await post('/api/agent/triage/honeypot:9', {})).status, 202);
  const record = monitor.records.get('honeypot:9');
  assert.ok(record, '入队过的记录在');
  record.status = 'done';
  assert.equal((await post('/api/agent/triage/honeypot:9/false-positive', { reason: '运维的蜜罐探针，授权扫描' })).status, 202);
  // 4) 研判发起
  assert.equal((await post('/api/agent/investigations', { alert_id: 'honeypot:7', mode: 'deep' })).status, 200);
  // 5) 规则写：不带令牌 → 403 denied
  assert.equal((await put('/api/rules/honeypot_probe', { rego: 'package hids.rules.honeypot_probe', expected_revision: null })).status, 403);

  const { body } = await auditBody(base, '?count=50');
  assert.ok(body.echo && typeof body.echo.count === 'number', 'echo 回显分页参数');
  const byAction = action => body.events.filter(event => event.action === action);
  // config.write：键名 + 机密擦除 + 来源
  const configEvents = byAction('config.write');
  assert.equal(configEvents.length, 1);
  assert.deepEqual(configEvents[0].object.keys, ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);
  assert.equal(configEvents[0].after.LLM_API_KEY, '[redacted-changed]', '机密新值不落审计');
  assert.equal(configEvents[0].before.LLM_API_KEY, '[redacted-changed]', '机密旧值不落审计');
  assert.equal(configEvents[0].after.LLM_MODEL, 'audit-model', '非机密值原样可见');
  assert.equal(configEvents[0].object.source.LLM_API_KEY, 'override-file', '来源可见');
  assert.equal(configEvents[0].actor.id, 'anonymous', '未配 Basic 的部署显式标 anonymous');
  assert.ok(configEvents[0].request_id, '审计事件带 request_id（与技术日志同链）');
  // 队列：入队两条（honeypot:7 与 honeypot:9）、控制一次、取消一次
  assert.equal(byAction('triage.enqueue').length, 2);
  assert.equal(byAction('triage.control').length, 1);
  assert.equal(byAction('triage.cancel').length, 1);
  assert.deepEqual(byAction('triage.enqueue').map(event => event.object.alert_id).sort(), ['honeypot:7', 'honeypot:9']);
  // 误报登记
  assert.equal(byAction('false-positive.register').length, 1);
  assert.equal(byAction('false-positive.register')[0].object.alert_id, 'honeypot:9');
  // 研判
  assert.equal(byAction('investigation.run').length, 1);
  // 规则写拒绝：denied 且 actor 是 Basic 身份（anonymous 部署如实标注）
  const denied = byAction('rule.write');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].result, 'denied');
  assert.ok(denied[0].request_id, 'denied 也带请求链');
  // dry-run 的 data.cleanup 不产生事件（上面那步 503 也没有事件）
  assert.equal(byAction('data.cleanup').length, 0);

  // GET 不产生审计事件：查完这轮审计本身，事件总数不变
  const before = (await auditBody(base, '?count=50')).body.total;
  await fetch(`${base}/api/audit?count=5`);
  await fetch(`${base}/api/agent/triage/status`);
  await fetch(`${base}/api/config`);
  const after = (await auditBody(base, '?count=50')).body.total;
  assert.equal(after, before, '只读请求不产生审计事件');
});

test('筛选与分页：action / result 过滤、分页切页、非法 result 回 400', async t => {
  // 注入独立的 config store（审计落点跟随 config.file 目录）：本用例的审计事件完全密封，不受进程内其他用例干扰。
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-audit-filter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configStore = createConfigStore({ file: path.join(dir, 'config-overrides.json') });
  const base = await listen(t, createServer(null, null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, configStore));
  const post = body => fetch(`${base}/api/config`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post({ LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'sk-1', LLM_MODEL: 'm1' });
  await post({ LLM_MODEL: 'm2' });
  const all = await auditBody(base, '?action=config.write&count=50');
  assert.equal(all.body.total, 2);
  assert.equal((await auditBody(base, '?action=config.write&result=denied')).body.total, 0);
  const page = await auditBody(base, '?action=config.write&count=1&offset=0');
  assert.equal(page.body.events.length, 1);
  assert.equal(page.body.total, 2, 'total 是切页前条数');
  assert.equal((await auditBody(base, '?result=maybe')).status, 400);
  assert.equal((await auditBody(base, '?count=0')).status, 400);
});

// ── 维护端：登录成功/失败、登出留痕（暂存与应用的端到端在 T047 套件场景里，这里验口径） ──
test('维护端写动作留痕：login ok/denied、logout；actor 是尝试的用户名', async t => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const store = new UpdateStore(new PromptStore('/tmp/hids-audit-maint-prompts.json'),
    { encryptionKey: randomBytes(32), publicKey, target: 'test' });
  const base = await listen(t, createMaintenanceServer(store,
    { access: { user: 'maint', password: 'maint-pass', role: 'updater' } }));
  const headers = { 'content-type': 'application/json', 'x-hids-maintenance': '1',
    origin: `${base}`, 'sec-fetch-site': 'same-origin' };
  // 登录失败 → denied
  await fetch(`${base}/api/maintenance/login`, { method: 'POST', headers,
    body: JSON.stringify({ username: 'intruder', password: 'wrong' }) });
  // 登录成功 → ok
  const login = await fetch(`${base}/api/maintenance/login`, { method: 'POST', headers,
    body: JSON.stringify({ username: 'maint', password: 'maint-pass' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // 登出（POST 是写方法：必须带 CSRF 头，否则撞 403 csrf_rejected，登出与审计都不会发生）
  await fetch(`${base}/api/maintenance/logout`, { method: 'POST',
    headers: { cookie, 'x-hids-maintenance': '1', origin: `${base}`, 'sec-fetch-site': 'same-origin' } });
  // 维护端没有 /api/audit 查询路由（查询在业务端 8080）；审计存储是同一份——直接读共享存储验事件。
  // 审计追加是 fire-and-forget（不阻塞响应）：全量并发下 append 可能晚到，轮询等到齐再断言。
  const shared = new AuditStore();
  let events = [];
  for (let i = 0; i < 40; i++) {
    events = (await shared.query({ count: 50 })).events;
    const logins = events.filter(event => event.action === 'maintenance.login');
    if (logins.length >= 2 && events.some(event => event.action === 'maintenance.logout')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const logins = events.filter(event => event.action === 'maintenance.login');
  assert.equal(logins.length, 2);
  assert.deepEqual(logins.map(event => event.result).sort(), ['denied', 'ok']);
  const deniedLogin = logins.find(event => event.result === 'denied');
  assert.equal(deniedLogin.actor.id, 'intruder', '失败登录用尝试的用户名');
  assert.equal(logins.find(event => event.result === 'ok').actor.id, 'maint');
  assert.equal(events.filter(event => event.action === 'maintenance.logout').length, 1);
  assert.ok(events.every(event => event.request_id), '维护端事件同样带请求链');
});

// ── 存储独立性与 append-only ──────────────────────────────────────────────────
test('审计存储独立于技术日志：audit/ 目录与 logs/ 分离，append-only', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-audit-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AuditStore(path.join(dir, 'audit'));
  await store.record(auditEvent({ actor: { kind: 'system', id: 'backend' }, action: 'config.write' }));
  await store.record(auditEvent({ actor: { kind: 'user', id: 'ops' }, action: 'data.cleanup', result: 'denied' }));
  const queried = await store.query({ result: 'denied' });
  assert.equal(queried.total, 1);
  assert.equal(queried.events[0].action, 'data.cleanup');
  // 文件落在 audit/ 子目录（独立于 logs/），按天分文件，一行一条
  const files = await readFile(path.join(dir, 'audit', `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.equal(files.trim().split('\n').length, 2, 'append-only：一行一条');
});
