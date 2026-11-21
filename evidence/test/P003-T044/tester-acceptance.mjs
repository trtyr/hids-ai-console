// 何东阳的独立验收探针（P003-T044 复验，2026-11-20）。黑盒：只按 docs/modules/http-api.md §3.7 / §4 / §8
// 与 openapi.yaml 的 DataInventory / DataCleanupRequest / DataCleanupResult 造请求，只看响应与盘上变化。
// 不读实现内容；不碰仓内 .data（全部 mkdtemp）；跑完自清临时目录。
//
// 跑法：node evidence/test/P003-T044/tester-acceptance.mjs
// 输出：OK / MISS 逐条；INFO 是文档没写死、记录现象的观察（不判红）。MISS 计数为 0 时 exit 0。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';
import { InvestigationStore } from '../../../src/contexts/triage/infrastructure/investigation-store.js';
import { createConfigStore } from '../../../src/contexts/dataops/infrastructure/config-store.js';

const OLD = Date.parse('2020-01-01T00:00:00.000Z');
const NEW = Date.parse('2026-11-19T00:00:00.000Z');
const CUT = Date.parse('2024-01-01T00:00:00.000Z');
const KINDS = ['cases', 'investigations', 'boards', 'wiki_sessions', 'queue', 'logs', 'config_overrides'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const roots = [];
let miss = 0;
let count = 0;
const ok = (name, cond, detail) => { count += 1; if (!cond) miss += 1; console.log(`${cond ? 'OK  ' : 'MISS'} ${name} :: ${detail}`); };
const info = (name, detail) => console.log(`INFO ${name} :: ${detail}`);

async function writeAt(file, content, at) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content);
  await utimes(file, at / 1000, at / 1000);
  return Buffer.byteLength(content);
}

async function boot({ auth = {}, monitor = 'auto' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 't044-tester-'));
  roots.push(root);
  const L = {
    cases: path.join(root, 'cases'), investigations: path.join(root, 'investigations'),
    boards: path.join(root, 'trace-boards'), wiki: path.join(root, 'wiki-sessions'),
    queue: path.join(root, 'triage-monitor.json'), overrides: path.join(root, 'config-overrides.json')
  };
  const m = monitor === 'auto' ? new TriageMonitor({ file: L.queue, casesDirectory: L.cases, inputMode: 'syslog' }) : monitor;
  const server = createServer(null, null, null, new InvestigationStore(L.investigations), null, m, null, auth,
    { directory: L.boards }, undefined, null, { directory: L.wiki }, null, null, null, null,
    createConfigStore({ file: L.overrides, env: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { root, L, m, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

async function cleanup(base, body, contentType = 'application/json') {
  const response = await fetch(`${base}/api/data/cleanup`, {
    method: 'POST', headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, headers: response.headers, body: parsed };
}

// ── 一、盘点 schema（openapi DataInventory / DataStoreUsage，§3.7.1「响应」）────────────────
{
  const { root, L, m, base, close } = await boot();
  const caseBytes = await writeAt(path.join(L.cases, '20260101-000000-aaaaaaaa', '01-原始告警.txt'), 'hello', OLD);
  const invBytes = await writeAt(path.join(L.investigations, 'a.json'), '{}', OLD);
  const boardBytes = await writeAt(path.join(L.boards, 'honeypot:7.json'), '{"board":1}', NEW);
  const wikiBytes = await writeAt(path.join(L.wiki, 'session.json'), '{"m":[]}', NEW);
  const overrideBytes = await writeAt(L.overrides, '{"LLM_MODEL":"x"}', OLD);
  const logBytes = await writeAt(path.join(root, 'hids.log'), 'log-line\n', NEW);
  await writeAt(path.join(root, 'nested', 'inner.log'), 'nested', NEW);      // 只认顶层 *.log
  await writeAt(path.join(root, 'not-a-log.txt'), 'ignored', NEW);
  m.records.set('syslog:webshell:aa:1:u1', { alert_id: 'syslog:webshell:aa:1:u1', status: 'done', created_at: '2020-01-01T00:00:00.000Z' });
  m.records.set('syslog:webshell:bb:2:u2', { alert_id: 'syslog:webshell:bb:2:u2', status: 'queued', updated_at: '2026-11-19T00:00:00.000Z' });
  await m.persist();

  const response = await fetch(`${base}/api/data/inventory`);
  const body = await response.json();
  ok('盘点 200 + application/json', response.status === 200 && /application\/json/.test(response.headers.get('content-type') ?? ''), `${response.status} ${response.headers.get('content-type')}`);
  ok('盘点 Cache-Control: no-store', response.headers.get('cache-control') === 'no-store', String(response.headers.get('cache-control')));
  ok('data_dir 是绝对路径且等于注入根', body.data_dir === root, body.data_dir);
  ok('stores 七类顺序固定', JSON.stringify(body.stores.map(s => s.kind)) === JSON.stringify(KINDS), body.stores.map(s => s.kind).join(','));
  ok('每类 label 非空中文、path 绝对', body.stores.every(s => typeof s.label === 'string' && s.label.length > 0 && path.isAbsolute(s.path)), body.stores.map(s => `${s.kind}:${s.label}`).join(' '));
  ok('exists/count/bytes 类型与下界', body.stores.every(s => typeof s.exists === 'boolean' && Number.isInteger(s.count) && s.count >= 0 && Number.isInteger(s.bytes) && s.bytes >= 0), 'ok');
  ok('oldest_at/newest_at 是 ISO 串或 null', body.stores.every(s => [s.oldest_at, s.newest_at].every(v => v === null || ISO.test(v))), 'ok');
  const row = kind => body.stores.find(s => s.kind === kind);
  ok('七类 count/bytes 逐类对得上',
    row('cases').count === 1 && row('cases').bytes === caseBytes &&
    row('investigations').count === 1 && row('investigations').bytes === invBytes &&
    row('boards').count === 1 && row('boards').bytes === boardBytes &&
    row('wiki_sessions').count === 1 && row('wiki_sessions').bytes === wikiBytes &&
    row('queue').count === 2 &&
    row('logs').count === 1 && row('logs').bytes === logBytes &&
    row('config_overrides').count === 1 && row('config_overrides').bytes === overrideBytes,
    body.stores.map(s => `${s.kind}=${s.count}/${s.bytes}`).join(' '));
  ok('queue.bytes = 队列文件 + .archive.jsonl', row('queue').bytes === (await stat(L.queue)).size, `${row('queue').bytes} vs ${(await stat(L.queue)).size}`);
  ok('total 是七类之和', body.total.count === body.stores.reduce((n, s) => n + s.count, 0) && body.total.bytes === body.stores.reduce((n, s) => n + s.bytes, 0), JSON.stringify(body.total));
  ok('时刻口径：investigations 单条 oldest==newest==mtime', row('investigations').oldest_at === new Date(OLD).toISOString() && row('investigations').newest_at === new Date(OLD).toISOString(), `${row('investigations').oldest_at}/${row('investigations').newest_at}`);
  ok('时刻口径：queue 取 updated_at→saved_at→created_at', row('queue').oldest_at === '2020-01-01T00:00:00.000Z' && row('queue').newest_at === '2026-11-19T00:00:00.000Z', `${row('queue').oldest_at}/${row('queue').newest_at}`);
  ok('logs 只认顶层 *.log', row('logs').count === 1, String(row('logs').count));
  await close();
}

// ── 二、盘点边界：空运行态 / 断链 / 空案卷 / 无队列时读队列文件 ─────────────────────────
{
  const { root, L, base, close } = await boot({ monitor: null });
  const empty = await (await fetch(`${base}/api/data/inventory`)).json();
  ok('空运行态：七类 count/bytes 全 0、exists 缺目录为 false', empty.total.count === 0 && empty.total.bytes === 0 && empty.stores.every(s => s.count === 0 && s.bytes === 0) && empty.stores.some(s => s.exists === false), `total=${JSON.stringify(empty.total)} exists=${empty.stores.map(s => s.exists).join(',')}`);
  ok('空运行态：oldest_at/newest_at 全 null（不是空串 / 缺键）', empty.stores.every(s => 'oldest_at' in s && 'newest_at' in s && s.oldest_at === null && s.newest_at === null), 'ok');
  await close();

  const broken = await boot();
  await mkdir(broken.L.investigations, { recursive: true, mode: 0o700 });
  await symlink('/nonexistent/nowhere.json', path.join(broken.L.investigations, 'dangling.json'));
  const brokenInv = await fetch(`${broken.base}/api/data/inventory`);
  const brokenBody = await brokenInv.json();
  const brokenRow = brokenBody.stores.find(s => s.kind === 'investigations');
  ok('断链不 500、bytes 按 0 算', brokenInv.status === 200 && brokenRow.bytes === 0, `${brokenInv.status} count=${brokenRow.count} bytes=${brokenRow.bytes}`);
  await broken.close();

  const quiet = await boot();
  await mkdir(quiet.L.cases, { recursive: true, mode: 0o700 });
  const quietCase = path.join(quiet.L.cases, 'empty-case');
  await mkdir(quietCase, { mode: 0o700 });
  await utimes(quietCase, OLD / 1000, OLD / 1000);
  const quietBody = await (await fetch(`${quiet.base}/api/data/inventory`)).json();
  const quietRow = quietBody.stores.find(s => s.kind === 'cases');
  ok('空案卷 count=1 bytes=0 时刻退回目录 mtime', quietRow.count === 1 && quietRow.bytes === 0 && quietRow.oldest_at === new Date(OLD).toISOString(), JSON.stringify(quietRow));
  await quiet.close();

  const noQueue = await boot({ monitor: null });
  await writeAt(noQueue.L.queue, JSON.stringify({ records: [
    { alert_id: 'a', status: 'done', created_at: '2020-01-01T00:00:00.000Z' },
    { alert_id: 'b', status: 'done', updated_at: '2026-11-19T00:00:00.000Z' }] }), OLD);
  const noQueueBody = await (await fetch(`${noQueue.base}/api/data/inventory`)).json();
  const noQueueRow = noQueueBody.stores.find(s => s.kind === 'queue');
  ok('无队列时 queue 读队列文件 records（openapi §3.7.1）', noQueueRow.count === 2 && noQueueRow.oldest_at === '2020-01-01T00:00:00.000Z' && noQueueRow.newest_at === '2026-11-19T00:00:00.000Z', `${noQueueRow.count} ${noQueueRow.oldest_at}/${noQueueRow.newest_at} exists=${noQueueRow.exists}`);
  await noQueue.close();
}

// ── 三、清理 schema 与回显（§3.7.2「响应」表）────────────────────────────────────────────
{
  const { L, base, close } = await boot();
  const oldBytes = await writeAt(path.join(L.investigations, 'old.json'), '{"a":1}', OLD);
  const midBytes = await writeAt(path.join(L.investigations, 'mid.json'), '{"b":2}', CUT + 1000);
  await writeAt(path.join(L.investigations, 'new.json'), '{"c":3}', NEW);
  const response = await fetch(`${base}/api/data/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'investigations', keep: 1 }) });
  const body = await response.json();
  ok('清理 200 + Cache-Control: no-store', response.status === 200 && response.headers.get('cache-control') === 'no-store', `${response.status} ${response.headers.get('cache-control')}`);
  ok('顶层七键齐全', JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['action', 'applied', 'candidates', 'dry_run', 'inventory', 'kind', 'threshold']), Object.keys(body).join(','));
  ok('kind/action 回显', body.kind === 'investigations' && body.action === 'archive', `${body.kind}/${body.action}`);
  ok('threshold 回显 keep=1, older_than=null', JSON.stringify(body.threshold) === JSON.stringify({ older_than: null, keep: 1 }), JSON.stringify(body.threshold));
  ok('items 每条 {name,bytes,at} 全对象、按时刻老到新', JSON.stringify(body.candidates.items) === JSON.stringify([
    { name: 'old.json', bytes: oldBytes, at: new Date(OLD).toISOString() },
    { name: 'mid.json', bytes: midBytes, at: new Date(CUT + 1000).toISOString() }]), JSON.stringify(body.candidates.items));
  ok('candidates.count/bytes 是全量、truncated=false', body.candidates.count === 2 && body.candidates.bytes === oldBytes + midBytes && body.candidates.truncated === false, JSON.stringify({ ...body.candidates, items: body.candidates.items.length }));
  ok('dry-run: dry_run=true、applied=0、盘上不动', body.dry_run === true && body.applied.count === 0 && body.applied.bytes === 0 && JSON.stringify((await readdir(L.investigations)).sort()) === '["mid.json","new.json","old.json"]', JSON.stringify(body.applied));
  ok('dry-run 的 inventory 是当下数字', body.inventory.stores.find(s => s.kind === 'investigations').count === 3, String(body.inventory.stores.find(s => s.kind === 'investigations').count));

  // older_than 原样回显（带时区串不被规范化）
  const echoed = '2024-01-01T08:00:00+08:00';
  const byTime = await cleanup(base, { kind: 'investigations', older_than: echoed, action: 'delete' });
  ok('older_than 原样回显、keep=null、action 原样', byTime.status === 200 && byTime.body.threshold.older_than === echoed && byTime.body.threshold.keep === null && byTime.body.action === 'delete', JSON.stringify(byTime.body.threshold));

  // 真删：applied 计数、盘上只剩新的、inventory 与紧接着 GET 完全一致（A5）
  const applied = await cleanup(base, { kind: 'investigations', action: 'delete', older_than: new Date(CUT).toISOString(), execute: true });
  ok('execute:true → dry_run=false、applied 精确', applied.status === 200 && applied.body.dry_run === false && JSON.stringify(applied.body.applied) === JSON.stringify({ count: 1, bytes: oldBytes }), `${applied.status} ${JSON.stringify(applied.body.applied)}`);
  ok('真删后原来的东西不在旧位', JSON.stringify((await readdir(L.investigations)).sort()) === '["mid.json","new.json"]', JSON.stringify((await readdir(L.investigations)).sort()));
  const after = await (await fetch(`${base}/api/data/inventory`)).json();
  ok('A5 响应 inventory 与紧接着 GET 完全一致', JSON.stringify(after) === JSON.stringify(applied.body.inventory), 'deepEqual');
  await close();
}

// ── 四、边界：阈值、枚举、类型、超长正文、截断 ───────────────────────────────────────────
{
  const { L, base, close } = await boot();
  await writeAt(path.join(L.investigations, 'a.json'), '{}', OLD);
  const cases = [
    ['缺 kind（{}）', {}, /要清理的类型只能是/],
    ['kind 不在七类', { kind: 'nope', keep: 0 }, /要清理的类型只能是/],
    ['kind 大小写不符', { kind: 'Cases', keep: 0 }, /要清理的类型只能是/],
    ['kind 非字符串', { kind: 7, keep: 0 }, /要清理的类型只能是/],
    ['两个阈值都没给', { kind: 'investigations' }, /至少要给一个阈值/],
    ['older_than=null 且无 keep', { kind: 'investigations', older_than: null }, /至少要给一个阈值/],
    ['older_than 不可解析', { kind: 'investigations', older_than: 'not-a-date' }, /older_than 必须是可解析的时间/],
    ['older_than 空串', { kind: 'investigations', older_than: '' }, /older_than 必须是可解析的时间/],
    ['older_than 布尔', { kind: 'investigations', older_than: true }, /older_than 必须是可解析的时间/],
    ['older_than 数组', { kind: 'investigations', older_than: [] }, /older_than 必须是可解析的时间/],
    ['older_than Unix 秒（数字）', { kind: 'investigations', older_than: 1700000000 }, /older_than 必须是可解析的时间/],
    ['keep=-1', { kind: 'investigations', keep: -1 }, /keep 必须是不小于 0 的整数/],
    ['keep=1.5', { kind: 'investigations', keep: 1.5 }, /keep 必须是不小于 0 的整数/],
    ['keep="0"（字符串）', { kind: 'investigations', keep: '0' }, /keep 必须是不小于 0 的整数/],
    ['keep=true', { kind: 'investigations', keep: true }, /keep 必须是不小于 0 的整数/],
    ['execute=0', { kind: 'investigations', keep: 0, execute: 0 }, /execute 必须是布尔值/],
    ['execute="true"', { kind: 'investigations', keep: 0, execute: 'true' }, /execute 必须是布尔值/],
    ['action 空串', { kind: 'investigations', keep: 0, action: '' }, /action 只能是 archive 或 delete/],
    ['action=move', { kind: 'investigations', keep: 0, action: 'move' }, /action 只能是 archive 或 delete/],
    ['未知参数 surprise', { kind: 'investigations', keep: 0, surprise: true }, /不认识的参数：surprise/]
  ];
  for (const [label, body, why] of cases) {
    const result = await cleanup(base, body);
    ok(`400 ${label}`, result.status === 400 && result.body?.code === 'caller_error' && why.test(result.body?.error ?? ''), `${result.status} code=${result.body?.code} ${JSON.stringify(result.body?.error)}`);
  }
  for (const [label, raw, why] of [['正文不是 JSON', 'nope', /请求正文不是 JSON/], ['正文是数组', '[]', /请求正文必须是 JSON 对象/], ['正文是字符串', '"x"', /请求正文必须是 JSON 对象/], ['正文 null', 'null', /请求正文必须是 JSON 对象/]]) {
    const result = await cleanup(base, raw);
    ok(`400 ${label}`, result.status === 400 && result.body?.code === 'caller_error' && why.test(result.body?.error ?? ''), `${result.status} ${JSON.stringify(result.body?.error)}`);
  }
  ok('校验失败后盘上不动', JSON.stringify(await readdir(L.investigations)) === '["a.json"]', JSON.stringify(await readdir(L.investigations)));

  // 正文上限（§3.7.2「过大 → 400 请求正文过大」）：实测边界 8192 内、8193 外
  const bodyOfLen = n => {
    const head = '{"kind":"investigations","keep":0,"pad":"';
    const tail = '"}';
    const raw = head + 'x'.repeat(n - head.length - tail.length) + tail;
    assert.equal(raw.length, n);
    return raw;
  };
  const atLimit = await cleanup(base, bodyOfLen(8192));
  const overLimit = await cleanup(base, bodyOfLen(8193));
  ok('正文上限边界 8192 内/8193 外', atLimit.status === 400 && /不认识的参数/.test(atLimit.body?.error ?? '') && overLimit.status === 400 && /请求正文过大/.test(overLimit.body?.error ?? ''), `8192→${atLimit.status} ${atLimit.body?.error}；8193→${overLimit.status} ${overLimit.body?.error}`);
  info('正文上限出处', 'docs/modules/http-api.md §8.1 的「各路由上限」表没有登记 /api/data/cleanup（实测 8192＝readJSON 缺省），要从 §3.7.2 的「过大」自己反推');

  // 阈值边界：「早于」不含等于；恰等于时刻不进候选
  const equal = await cleanup(base, { kind: 'investigations', older_than: new Date(OLD).toISOString() });
  const justBefore = await cleanup(base, { kind: 'investigations', older_than: new Date(OLD + 1).toISOString() });
  ok('older_than 边界：等于不进、早 1ms 才进', equal.body.candidates.count === 0 && justBefore.body.candidates.count === 1, `等于=${equal.body.candidates.count} 早1ms=${justBefore.body.candidates.count}`);
  const keepZero = await cleanup(base, { kind: 'investigations', keep: 0 });
  ok('keep=0 全量进候选', keepZero.status === 200 && keepZero.body.candidates.count === 1, `${keepZero.status} ${keepZero.body.candidates.count}`);
  await close();

  // 截断边界：100 条恰好不截、101 条截；items 老到新
  const many = await boot();
  for (let i = 0; i < 100; i += 1) await writeAt(path.join(many.L.boards, `b-${String(i).padStart(3, '0')}.json`), '{}', OLD + i);
  const hundred = await cleanup(many.base, { kind: 'boards', keep: 0 });
  ok('恰好 100 条：items 100 条、truncated=false', hundred.body.candidates.count === 100 && hundred.body.candidates.items.length === 100 && hundred.body.candidates.truncated === false, `${hundred.body.candidates.count}/${hundred.body.candidates.items.length}/${hundred.body.candidates.truncated}`);
  ok('items 从老到新', hundred.body.candidates.items[0].name === 'b-000.json' && hundred.body.candidates.items.at(-1).name === 'b-099.json', `${hundred.body.candidates.items[0].name}…${hundred.body.candidates.items.at(-1).name}`);
  await writeAt(path.join(many.L.boards, 'b-100.json'), '{}', OLD + 100);
  const hundredOne = await cleanup(many.base, { kind: 'boards', keep: 0 });
  ok('101 条：count=101、items=100、truncated=true', hundredOne.body.candidates.count === 101 && hundredOne.body.candidates.items.length === 100 && hundredOne.body.candidates.truncated === true, `${hundredOne.body.candidates.count}/${hundredOne.body.candidates.items.length}/${hundredOne.body.candidates.truncated}`);
  await many.close();
}

// ── 五、错误码：401 / 409 / 503 / 404，且拒绝时不动物 ─────────────────────────────────
{
  // 401：无凭据 / 错口令 / 错用户名，正文与四条头（§4 + §3.7.2「鉴权」）
  const { L, base, close } = await boot({ auth: { user: 'ops', password: 'pw' } });
  await writeAt(path.join(L.investigations, 'keepme.json'), '{}', OLD);
  const basic = v => `Basic ${Buffer.from(v).toString('base64')}`;
  const expect401 = async (response, label) => {
    const text = await response.text();
    ok(`401 ${label}：正文+四条头`,
      response.status === 401 && text === '需要登录后访问' &&
      response.headers.get('www-authenticate') === 'Basic realm="HIDS AI Console", charset="UTF-8"' &&
      response.headers.get('content-type') === 'text/plain; charset=utf-8' &&
      response.headers.get('cache-control') === 'no-store' &&
      response.headers.get('x-content-type-options') === 'nosniff',
      `${response.status} ct=${response.headers.get('content-type')} 正文=${JSON.stringify(text)}`);
  };
  await expect401(await fetch(`${base}/api/data/inventory`), '盘点 无凭据');
  await expect401(await fetch(`${base}/api/data/inventory`, { headers: { authorization: basic('ops:bad') } }), '盘点 错口令');
  await expect401(await fetch(`${base}/api/data/inventory`, { headers: { authorization: basic('admin:pw') } }), '盘点 错用户名');
  const post401 = headers => fetch(`${base}/api/data/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ kind: 'investigations', keep: 0, action: 'delete', execute: true }) });
  await expect401(await post401({}), '清理 无凭据');
  await expect401(await post401({ authorization: basic('ops:bad') }), '清理 错口令');
  ok('401 的 execute:true 清理一个字节没动盘', JSON.stringify(await readdir(L.investigations)) === '["keepme.json"]', JSON.stringify(await readdir(L.investigations)));
  const allowed = { authorization: basic('ops:pw') };
  ok('正确凭据 两条路由都 200', (await fetch(`${base}/api/data/inventory`, { headers: allowed })).status === 200 && (await post401(allowed)).status === 200, 'ok');
  await close();

  // 409：队列候选里有非 done（queued/running/failed），原话带条数与状态枚举
  const queueCase = await boot();
  ['queued', 'running', 'failed'].forEach((status, index) => queueCase.m.records.set(`q${index}`, { alert_id: `q${index}`, status, created_at: '2020-01-01T00:00:00.000Z' }));
  const blocked = await cleanup(queueCase.base, { kind: 'queue', older_than: new Date(CUT).toISOString(), execute: true });
  ok('409 队列：三条非 done 原话与计数', blocked.status === 409 && blocked.body.code === 'caller_error' && /3 条记录状态不是 done/.test(blocked.body.error), `${blocked.status} ${JSON.stringify(blocked.body)}`);
  ok('409 队列：内存与队列文件都不动', queueCase.m.records.size === 3 && (await readdir(queueCase.root)).includes('triage-monitor.json') === false, `${queueCase.m.records.size} ${JSON.stringify(await readdir(queueCase.root))}`);
  await queueCase.close();

  // 409：案卷候选目录挂着在跑的案件
  const caseRun = await boot();
  const runningDir = path.join(caseRun.L.cases, '20200101-000000-aaaaaaaa');
  await writeAt(path.join(runningDir, '01-原始告警.txt'), 'x', OLD);
  await utimes(runningDir, OLD / 1000, OLD / 1000);
  caseRun.m.records.set('syslog:webshell:aa:1:u1', { alert_id: 'syslog:webshell:aa:1:u1', status: 'running', created_at: '2020-01-01T00:00:00.000Z', case_dir: runningDir });
  const caseBlocked = await cleanup(caseRun.base, { kind: 'cases', older_than: new Date(CUT).toISOString(), execute: true });
  ok('409 案卷：原话 + 一个案卷都不动', caseBlocked.status === 409 && /案卷对应的案件还在排或在跑/.test(caseBlocked.body.error) && (await readdir(caseRun.L.cases)).length === 1, `${caseBlocked.status} ${JSON.stringify(caseBlocked.body)}`);
  await caseRun.close();

  // 503：没装配队列时清 queue，不拿队列文件硬删
  const noQueue = await boot({ monitor: null });
  await writeAt(noQueue.L.queue, JSON.stringify({ records: [] }), OLD);
  const configured = await cleanup(noQueue.base, { kind: 'queue', keep: 0, execute: true });
  ok('503 队列：正文原话 + 队列文件还在', configured.status === 503 && configured.body.code === 'not_configured' &&
    configured.body.error === '自动研判尚未配置（没有研判队列），无法清理队列' &&
    (await readFile(noQueue.L.queue, 'utf8')).length > 0, `${configured.status} ${JSON.stringify(configured.body)}`);
  await noQueue.close();

  // 方法不对：盘点只认 GET
  const method = await boot();
  const wrongMethod = await fetch(`${method.base}/api/data/inventory`, { method: 'POST', body: '{}' });
  ok('盘点用 POST → 404（方法不对不在本路径兜）', wrongMethod.status === 404, String(wrongMethod.status));
  await method.close();
}

// ── 六、文档没写死的边界：记录现象，不判红（已写进 test-report 的残留风险）──────────────
{
  const { L, base, close } = await boot();
  await writeAt(path.join(L.investigations, 'a.json'), '{}', OLD);
  for (const sample of [{ kind: 'investigations', keep: 0, action: null }, { kind: 'investigations', keep: 0, execute: null }, { kind: 'investigations', older_than: 0 }, { kind: 'investigations', older_than: '0' }]) {
    const result = await cleanup(base, sample);
    info(`文档未写死的输入 ${JSON.stringify(sample)}`, `${result.status} dry_run=${result.body?.dry_run} action=${result.body?.action} threshold=${JSON.stringify(result.body?.threshold)} error=${JSON.stringify(result.body?.error)}`);
  }
  await close();
}

// ── 收尾：清临时根 ────────────────────────────────────────────────────────────────────
for (const root of roots) await rm(root, { recursive: true, force: true });
console.log(`\nT044 TESTER ${miss === 0 ? 'OK' : 'FAIL'} 共 ${count} 条断言，MISS ${miss}`);
process.exit(miss === 0 ? 0 : 1);
