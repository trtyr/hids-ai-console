// P003-T044 单测：数据管理接口（盘点 / 归档 / 清理）。
// 全部在 tmp 目录里跑：替身目录 + 内存队列 + 进程内 HTTP 请求；不碰真实网络、不碰仓内 .data、mtime 用 utimes 钉死。
// 跑法：node --test evidence/test/P003-T044/data-admin.test.js
// 全局根隔离（P003-T050 A2）：本文件触发写接口 → 产生审计事件（P003-T062），必须先隔离数据根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { InvestigationStore } from '../../../investigation-store.js';
import { createConfigStore } from '../../../config-store.js';
import { useJournal, createJournal } from '../../../src/shared/logging/log.js';

const OLD = Date.parse('2020-01-01T00:00:00.000Z');   // 老数据
const NEW = Date.parse('2026-11-19T00:00:00.000Z');   // 新数据
const CUT = Date.parse('2024-01-01T00:00:00.000Z');   // older_than 的刀口：切在两者之间

async function writeAt(file, content, at) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content);
  await utimes(file, at / 1000, at / 1000);
  return Buffer.byteLength(content);
}

async function mtimeAt(directory, at) {
  await utimes(directory, at / 1000, at / 1000);
}

const record = (alertId, status, at, extra = {}) =>
  ({ alert_id: alertId, status, created_at: at, updated_at: at, ...extra });

// 一份 tmp 运行态：七个存储各就各位，路径与生产同一套名字（cases / investigations / trace-boards / …）。
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-data-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const locations = {
    cases: path.join(root, 'cases'),
    investigations: path.join(root, 'investigations'),
    boards: path.join(root, 'trace-boards'),
    wikiSessions: path.join(root, 'wiki-sessions'),
    queue: path.join(root, 'triage-monitor.json'),
    overrides: path.join(root, 'config-overrides.json')
  };
  const monitor = new TriageMonitor({ file: locations.queue, casesDirectory: locations.cases, inputMode: 'syslog' });
  const history = new InvestigationStore(locations.investigations);
  const boardService = { directory: locations.boards };
  const wikiAgent = { directory: locations.wikiSessions };
  const config = createConfigStore({ file: locations.overrides, env: {} });
  const deps = { history, monitor, boardService, wikiAgent, config };
  return { root, locations, monitor, history, boardService, wikiAgent, config, deps };
}

function newMonitor(locations) {
  return new TriageMonitor({ file: locations.queue, casesDirectory: locations.cases, inputMode: 'syslog' });
}

async function serve(t, deps, { auth = {}, monitor } = {}) {
  const server = createServer(null, null, null, deps.history ?? null, null,
    monitor === undefined ? deps.monitor ?? null : monitor, null, auth,
    deps.boardService ?? null, undefined, null, deps.wikiAgent ?? null, null, null, null, null, deps.config ?? null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function getInventory(base) {
  const response = await fetch(`${base}/api/data/inventory`);
  assert.equal(response.status, 200);
  return response.json();
}

async function cleanup(base, body) {
  const response = await fetch(`${base}/api/data/cleanup`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const row = (inventory, kind) => inventory.stores.find(store => store.kind === kind);
const names = items => items.map(item => item.name);

// 捕获 journal：断言 A3 的留痕字段，同时断言「不记内容」。
function captureJournal(t) {
  const lines = [];
  useJournal(createJournal({ write: line => lines.push(line), now: () => '2026-11-19T12:00:00.000Z' }));
  t.after(() => useJournal());
  return {
    lines,
    events: event => lines.map(line => JSON.parse(line)).filter(entry => entry.event === event)
  };
}

test('A1 盘点七类存储：条数与字节逐类对得上，缺目录按 0 报', async t => {
  const { root, locations, deps } = await workspace(t);
  const caseA = await writeAt(path.join(locations.cases, '20260101-000000-aaaaaaaa', '01-原始告警.txt'), 'hello', OLD);
  const caseB = await writeAt(path.join(locations.cases, '20260102-000000-bbbbbbbb', '01-原始告警.txt'), 'world!!', NEW);
  const invA = await writeAt(path.join(locations.investigations, 'a.json'), '{}', OLD);
  const invB = await writeAt(path.join(locations.investigations, 'b.json'), '{"x":1}', NEW);
  const board = await writeAt(path.join(locations.boards, 'honeypot:7.json'), '{"board":1}', OLD);
  const session = await writeAt(path.join(locations.wikiSessions, 'session.json'), '{"m":[]}', NEW);
  const overrides = await writeAt(locations.overrides, '{"LLM_MODEL":"not-a-real-model"}', OLD);
  const logBytes = await writeAt(path.join(root, 'hids.log'), 'log-line\n', NEW);
  await writeAt(path.join(root, 'not-a-log.txt'), 'ignored', NEW);
  await writeAt(path.join(root, 'nested', 'inner.log'), 'nested', NEW); // 只认 dataRoot 顶层的 *.log
  deps.monitor.records.set('syslog:webshell:aa:1:u1', record('syslog:webshell:aa:1:u1', 'done', '2020-01-01T00:00:00.000Z'));
  deps.monitor.records.set('syslog:webshell:bb:2:u2', record('syslog:webshell:bb:2:u2', 'queued', '2026-11-19T00:00:00.000Z'));
  await deps.monitor.persist();

  const base = await serve(t, deps);
  const inventory = await getInventory(base);
  assert.equal(inventory.data_dir, root);

  assert.equal(inventory.stores.length, 7);
  // 七类的 kind 顺序稳定，页面/测试按它渲染
  assert.deepEqual(inventory.stores.map(store => store.kind),
    ['cases', 'investigations', 'boards', 'wiki_sessions', 'queue', 'logs', 'config_overrides']);

  assert.equal(row(inventory, 'cases').count, 2);
  assert.equal(row(inventory, 'cases').bytes, caseA + caseB);
  assert.equal(row(inventory, 'cases').oldest_at, new Date(OLD).toISOString());
  assert.equal(row(inventory, 'cases').newest_at, new Date(NEW).toISOString());
  assert.equal(row(inventory, 'investigations').count, 2);
  assert.equal(row(inventory, 'investigations').bytes, invA + invB);
  assert.equal(row(inventory, 'investigations').oldest_at, new Date(OLD).toISOString());
  assert.equal(row(inventory, 'investigations').newest_at, new Date(NEW).toISOString());
  assert.equal(row(inventory, 'boards').count, 1);
  assert.equal(row(inventory, 'boards').bytes, board);
  // 只有一条时最早=最晚＝那一条的时刻（目录 mtime 不是条目时刻）
  assert.equal(row(inventory, 'boards').oldest_at, new Date(OLD).toISOString());
  assert.equal(row(inventory, 'boards').newest_at, new Date(OLD).toISOString());
  assert.equal(row(inventory, 'wiki_sessions').count, 1);
  assert.equal(row(inventory, 'wiki_sessions').bytes, session);
  assert.equal(row(inventory, 'wiki_sessions').oldest_at, new Date(NEW).toISOString());
  assert.equal(row(inventory, 'wiki_sessions').newest_at, new Date(NEW).toISOString());
  // 队列：条数＝进程内记录数；字节＝队列文件 + 归档文件；时刻取记录上的 updated_at
  assert.equal(row(inventory, 'queue').count, 2);
  assert.equal(row(inventory, 'queue').bytes, (await stat(locations.queue)).size);
  assert.equal(row(inventory, 'queue').oldest_at, '2020-01-01T00:00:00.000Z');
  assert.equal(row(inventory, 'queue').newest_at, '2026-11-19T00:00:00.000Z');
  // 日志：只认 dataRoot 顶层的 *.log（后端自身不落文件）
  assert.equal(row(inventory, 'logs').count, 1);
  assert.equal(row(inventory, 'logs').bytes, logBytes);
  assert.equal(row(inventory, 'logs').oldest_at, new Date(NEW).toISOString());
  assert.equal(row(inventory, 'logs').newest_at, new Date(NEW).toISOString());
  assert.equal(row(inventory, 'config_overrides').count, 1);
  assert.equal(row(inventory, 'config_overrides').bytes, overrides);
  assert.equal(row(inventory, 'config_overrides').oldest_at, new Date(OLD).toISOString());
  assert.equal(row(inventory, 'config_overrides').newest_at, new Date(OLD).toISOString());

  const total = inventory.stores.reduce((sum, store) => ({ count: sum.count + store.count, bytes: sum.bytes + store.bytes }),
    { count: 0, bytes: 0 });
  assert.deepEqual(inventory.total, total);
});

test('A1 空运行态：七类全 0，不报错', async t => {
  const { root, deps } = await workspace(t);
  const base = await serve(t, deps);
  const inventory = await getInventory(base);
  assert.equal(inventory.data_dir, root);
  assert.deepEqual(inventory.total, { count: 0, bytes: 0 });
  assert.ok(inventory.stores.every(store => store.count === 0 && store.bytes === 0));
  assert.equal(row(inventory, 'investigations').exists, false);
  assert.equal(row(inventory, 'config_overrides').exists, false);
  // 没有条目时时刻是 null（不是 ''、不是缺字段、也不是目录 mtime）
  assert.deepEqual(inventory.stores.map(store => [store.kind, store.oldest_at, store.newest_at]),
    inventory.stores.map(store => [store.kind, null, null]));
});

test('A2 默认 dry-run：只报将删清单，盘上一动没动', async t => {
  const { locations, deps } = await workspace(t);
  const oldBytes = await writeAt(path.join(locations.investigations, 'old.json'), '{"a":1}', OLD);
  await writeAt(path.join(locations.investigations, 'new.json'), '{"b":2}', NEW);
  const base = await serve(t, deps);

  const result = await cleanup(base, { kind: 'investigations', older_than: new Date(CUT).toISOString() });
  assert.equal(result.status, 200);
  assert.equal(result.body.dry_run, true);
  assert.equal(result.body.action, 'archive');
  assert.equal(result.body.candidates.count, 1);
  assert.equal(result.body.candidates.bytes, oldBytes);
  assert.deepEqual(names(result.body.candidates.items), ['old.json']);
  assert.deepEqual(result.body.applied, { count: 0, bytes: 0 });
  // 盘上两份都还在
  assert.deepEqual((await readdir(locations.investigations)).sort(), ['new.json', 'old.json']);
  // 响应里的盘点就是当下的：dry-run 之后没变
  assert.equal(row(result.body.inventory, 'investigations').count, 2);
});

test('A2 清理响应回显：kind/action/threshold 逐键，candidates.items 每条都带条目时刻（老到新）', async t => {
  const { locations, deps } = await workspace(t);
  const oldBytes = await writeAt(path.join(locations.investigations, 'old.json'), '{"a":1}', OLD);
  const midBytes = await writeAt(path.join(locations.investigations, 'mid.json'), '{"b":2}', CUT + 1000);
  await writeAt(path.join(locations.investigations, 'new.json'), '{"c":3}', NEW);
  const base = await serve(t, deps);

  // keep 阈值：回显 keep＝请求值、older_than＝null；清单每条 {name,bytes,at} 全对象，按时刻从老到新
  const byKeep = await cleanup(base, { kind: 'investigations', keep: 1 });
  assert.equal(byKeep.status, 200);
  assert.equal(byKeep.body.kind, 'investigations');
  assert.equal(byKeep.body.action, 'archive');
  assert.deepEqual(byKeep.body.threshold, { older_than: null, keep: 1 });
  assert.deepEqual(byKeep.body.candidates.items, [
    { name: 'old.json', bytes: oldBytes, at: new Date(OLD).toISOString() },
    { name: 'mid.json', bytes: midBytes, at: new Date(CUT + 1000).toISOString() }
  ]);

  // 只有 older_than：**原样**回显请求里的那串（不被改写成 UTC 标准形），keep＝null；动作原样回显
  const echoed = '2024-01-01T08:00:00+08:00';
  const byTime = await cleanup(base, { kind: 'investigations', older_than: echoed, action: 'delete' });
  assert.equal(byTime.status, 200);
  assert.equal(byTime.body.kind, 'investigations');
  assert.equal(byTime.body.action, 'delete');
  assert.deepEqual(byTime.body.threshold, { older_than: echoed, keep: null });
  assert.deepEqual(byTime.body.candidates.items,
    [{ name: 'old.json', bytes: oldBytes, at: new Date(OLD).toISOString() }]);
  // dry-run 不动盘：三份都还在
  assert.deepEqual((await readdir(locations.investigations)).sort(), ['mid.json', 'new.json', 'old.json']);
});

test('A2+A5 execute 真删：只删早于阈值的，清理后盘点数字立刻反映', async t => {
  const { locations, deps } = await workspace(t);
  const oldBytes = await writeAt(path.join(locations.investigations, 'old.json'), '{"a":1}', OLD);
  const newBytes = await writeAt(path.join(locations.investigations, 'new.json'), '{"b":2}', NEW);
  const base = await serve(t, deps);

  const result = await cleanup(base, { kind: 'investigations', action: 'delete',
    older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.dry_run, false);
  assert.deepEqual(result.body.applied, { count: 1, bytes: oldBytes });
  assert.deepEqual(await readdir(locations.investigations), ['new.json']);
  // A5：响应里带的盘点就是执行后的，和下一次 GET 完全一致
  assert.equal(row(result.body.inventory, 'investigations').count, 1);
  assert.equal(row(result.body.inventory, 'investigations').bytes, newBytes);
  assert.deepEqual(await getInventory(base), result.body.inventory);
});

test('A2 按数量阈值：keep=N 保留最新 N 条，更老的进候选', async t => {
  const { locations, deps } = await workspace(t);
  const bytes = await writeAt(path.join(locations.boards, 'a.json'), '{}', OLD);
  await writeAt(path.join(locations.boards, 'b.json'), '{}', OLD + 1000);
  await writeAt(path.join(locations.boards, 'c.json'), '{}', NEW);
  const base = await serve(t, deps);

  const result = await cleanup(base, { kind: 'boards', keep: 2 });
  assert.equal(result.status, 200);
  assert.deepEqual(names(result.body.candidates.items), ['a.json']);

  const applied = await cleanup(base, { kind: 'boards', keep: 2, action: 'delete', execute: true });
  assert.deepEqual(applied.body.applied, { count: 1, bytes });
  assert.deepEqual((await readdir(locations.boards)).sort(), ['b.json', 'c.json']);
});

test('A2 两个阈值取并集：早于时间的与超出数量的都算候选，不会重复计', async t => {
  const { locations, deps } = await workspace(t);
  await writeAt(path.join(locations.wikiSessions, 'a.json'), '{}', OLD);        // 早于刀口
  await writeAt(path.join(locations.wikiSessions, 'b.json'), '{}', CUT + 1000); // 超出 keep=1
  await writeAt(path.join(locations.wikiSessions, 'c.json'), '{}', NEW);        // 最新，留着
  const base = await serve(t, deps);
  const result = await cleanup(base, { kind: 'wiki_sessions', keep: 1, older_than: new Date(CUT).toISOString() });
  assert.deepEqual(names(result.body.candidates.items), ['a.json', 'b.json']);
});

test('A2 归档：文件移进 .data/archive/<类型>/，存储里不再有它', async t => {
  const { root, locations, deps } = await workspace(t);
  await writeAt(path.join(locations.investigations, 'old.json'), '{"a":1}', OLD);
  await writeAt(path.join(locations.investigations, 'new.json'), '{"b":2}', NEW);
  const base = await serve(t, deps);

  const result = await cleanup(base, { kind: 'investigations', action: 'archive',
    older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'archive');
  assert.deepEqual(await readdir(locations.investigations), ['new.json']);
  const archived = await readdir(path.join(root, 'archive', 'investigations'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^[\dTZ-]+-old\.json$/);
  assert.equal(row(result.body.inventory, 'investigations').count, 1);
});

test('A2 案卷按目录清：整目录删掉，字节按目录内文件累加', async t => {
  const { locations, deps } = await workspace(t);
  const caseDir = path.join(locations.cases, '20200101-000000-aaaaaaaa');
  const first = await writeAt(path.join(caseDir, '01-原始告警.txt'), 'hello', OLD);
  const second = await writeAt(path.join(caseDir, '03-研判事实.md'), '# 事实', OLD + 1000);
  await mtimeAt(caseDir, OLD + 1000);
  const base = await serve(t, deps);

  const dry = await cleanup(base, { kind: 'cases', older_than: new Date(CUT).toISOString() });
  assert.equal(dry.body.candidates.count, 1);
  assert.equal(dry.body.candidates.bytes, first + second);

  const result = await cleanup(base, { kind: 'cases', action: 'delete',
    older_than: new Date(CUT).toISOString(), execute: true });
  assert.deepEqual(result.body.applied, { count: 1, bytes: first + second });
  assert.deepEqual(await readdir(locations.cases), []);
  assert.equal(row(result.body.inventory, 'cases').count, 0);
});

test('A3 真删留痕：data.cleaned 只记类型/动作/条数/字节，不带文件名；dry-run 不留痕', async t => {
  const { locations, deps } = await workspace(t);
  const journal = captureJournal(t);
  const bytes = await writeAt(path.join(locations.investigations, 'secret-case-name.json'), '{"a":1}', OLD);
  const base = await serve(t, deps);

  await cleanup(base, { kind: 'investigations', action: 'delete', keep: 0, execute: true });
  const cleaned = journal.events('data.cleaned');
  assert.equal(cleaned.length, 1);
  // P003-T072：留痕行在请求上下文里，自动带 request_id（反查是哪个请求发起的清理）。
  assert.deepEqual(Object.keys(cleaned[0]).sort(),
    ['action', 'bytes', 'count', 'event', 'kind', 'level', 'request_id', 'time']);
  assert.equal(cleaned[0].kind, 'investigations');
  assert.equal(cleaned[0].action, 'delete');
  assert.equal(cleaned[0].count, 1);
  assert.equal(cleaned[0].bytes, bytes);
  // 不记内容：整条日志里不出现文件名
  assert.doesNotMatch(journal.lines.join('\n'), /secret-case-name/);

  // dry-run 不留「删了」的痕
  await cleanup(base, { kind: 'cases', keep: 0 });
  assert.equal(journal.events('data.cleaned').length, 1);
});

test('A4 队列：候选里有 queued/running/failed 一律 409，内存与盘上都不动', async t => {
  const { root, locations, deps } = await workspace(t);
  for (const status of ['queued', 'running', 'failed']) {
    const monitor = newMonitor(locations);
    monitor.records.set('syslog:webshell:aa:1:u1', record('syslog:webshell:aa:1:u1', 'done', '2020-01-01T00:00:00.000Z'));
    monitor.records.set('syslog:webshell:bb:2:u2', record('syslog:webshell:bb:2:u2', status, '2020-01-02T00:00:00.000Z'));
    const base = await serve(t, deps, { monitor });
    const result = await cleanup(base, { kind: 'queue', older_than: new Date(CUT).toISOString(), execute: true });
    assert.equal(result.status, 409, `${status} 应被拒`);
    assert.equal(result.body.code, 'caller_error');
    assert.match(result.body.error, /已完结的案件才可清理/);
    assert.equal(monitor.records.size, 2);
    // 409 时没有落过盘
    assert.equal((await readdir(root)).includes('triage-monitor.json'), false);
  }
});

test('A4 案卷：目录对应案件还在跑 → 409，一个案卷都不动；只清已完结的才放行', async t => {
  const { locations, deps } = await workspace(t);
  const runningDir = path.join(locations.cases, '20200101-000000-aaaaaaaa');
  const doneDir = path.join(locations.cases, '20200102-000000-bbbbbbbb');
  await writeAt(path.join(runningDir, '01-原始告警.txt'), 'running', OLD);
  const doneBytes = await writeAt(path.join(doneDir, '01-原始告警.txt'), 'done', OLD);
  await mtimeAt(runningDir, OLD);
  await mtimeAt(doneDir, OLD);
  deps.monitor.records.set('syslog:webshell:aa:1:u1', record('syslog:webshell:aa:1:u1', 'running', '2020-01-01T00:00:00.000Z', { case_dir: runningDir }));
  deps.monitor.records.set('syslog:webshell:bb:2:u2', record('syslog:webshell:bb:2:u2', 'done', '2020-01-01T00:00:00.000Z', { case_dir: doneDir }));
  const base = await serve(t, deps);

  const blocked = await cleanup(base, { kind: 'cases', older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(blocked.status, 409);
  assert.equal((await readdir(locations.cases)).length, 2);

  // 把在跑那个目录的新鲜度顶上去，让它不在「早于阈值」里：剩下的就是已完结那个
  await utimes(path.join(runningDir, '01-原始告警.txt'), NEW / 1000, NEW / 1000);
  const allowed = await cleanup(base, { kind: 'cases', older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.applied, { count: 1, bytes: doneBytes });
  assert.deepEqual(await readdir(locations.cases), ['20200101-000000-aaaaaaaa']);
});

test('A4 队列只清 done：delete 移出内存，落盘后文件里也没了（A5 数字跟着变）', async t => {
  const { locations, deps } = await workspace(t);
  deps.monitor.records.set('syslog:webshell:aa:1:u1', record('syslog:webshell:aa:1:u1', 'done', '2020-01-01T00:00:00.000Z'));
  deps.monitor.records.set('syslog:webshell:bb:2:u2', record('syslog:webshell:bb:2:u2', 'done', '2026-11-19T00:00:00.000Z'));
  await deps.monitor.persist();
  const base = await serve(t, deps);

  const dry = await cleanup(base, { kind: 'queue', older_than: new Date(CUT).toISOString() });
  assert.equal(dry.body.candidates.count, 1);
  // 队列条目多一个 status，at 是记录上的时刻（原样，不规范化），bytes 是记录 JSON 序列化字节
  assert.deepEqual(dry.body.candidates.items, [{
    name: 'syslog:webshell:aa:1:u1', status: 'done', at: '2020-01-01T00:00:00.000Z',
    bytes: Buffer.byteLength(JSON.stringify(record('syslog:webshell:aa:1:u1', 'done', '2020-01-01T00:00:00.000Z')))
  }]);

  const result = await cleanup(base, { kind: 'queue', action: 'delete',
    older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.applied.count, 1);
  assert.equal(deps.monitor.records.size, 1);
  const persisted = JSON.parse(await readFile(locations.queue, 'utf8'));
  // 整对象比对：没被清的那条逐字段原样留下，没有多字段、没有改字段
  assert.deepEqual(persisted.records, [record('syslog:webshell:bb:2:u2', 'done', '2026-11-19T00:00:00.000Z')]);
  assert.deepEqual([...deps.monitor.records.values()], [record('syslog:webshell:bb:2:u2', 'done', '2026-11-19T00:00:00.000Z')]);
  assert.equal(row(result.body.inventory, 'queue').count, 1);
});

test('A4 队列 archive：追加到 <队列文件>.archive.jsonl，带 archived_at', async t => {
  const { locations, deps } = await workspace(t);
  deps.monitor.records.set('syslog:webshell:aa:1:u1', record('syslog:webshell:aa:1:u1', 'done', '2020-01-01T00:00:00.000Z'));
  const base = await serve(t, deps);

  const result = await cleanup(base, { kind: 'queue', action: 'archive', keep: 0, execute: true });
  assert.equal(result.status, 200);
  const archived = (await readFile(`${locations.queue}.archive.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].alert_id, 'syslog:webshell:aa:1:u1');
  assert.match(archived[0].archived_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(deps.monitor.records.size, 0);
  // 归档文件算进队列的字节占用
  assert.equal(row(result.body.inventory, 'queue').bytes,
    (await stat(locations.queue)).size + (await stat(`${locations.queue}.archive.jsonl`)).size);
});

test('队列没装配时清队列回 503，不拿队列文件硬删', async t => {
  const { deps, locations } = await workspace(t);
  await writeAt(locations.queue, JSON.stringify({ records: [record('x', 'done', '2020-01-01T00:00:00.000Z')] }), OLD);
  const base = await serve(t, deps, { monitor: null });
  const result = await cleanup(base, { kind: 'queue', keep: 0, execute: true });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'not_configured');
  assert.ok((await readdir(path.dirname(locations.queue))).includes('triage-monitor.json'));
});

test('入参校验：类型/阈值/动作/execute/未知参数都回 400，且盘上不动', async t => {
  const { locations, deps } = await workspace(t);
  await writeAt(path.join(locations.investigations, 'a.json'), '{}', OLD);
  const base = await serve(t, deps);
  const cases = [
    { kind: 'nope', keep: 0 },
    { kind: 'investigations' },
    { kind: 'investigations', older_than: 'not-a-date' },
    { kind: 'investigations', keep: -1 },
    { kind: 'investigations', keep: 1.5 },
    { kind: 'investigations', keep: 0, execute: 'yes' },
    { kind: 'investigations', keep: 0, action: 'move' },
    { kind: 'investigations', keep: 0, surprise: true }
  ];
  for (const body of cases) {
    const result = await cleanup(base, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.code, 'caller_error');
    assert.equal(typeof result.body.error, 'string');
  }
  const notJson = await fetch(`${base}/api/data/cleanup`, { method: 'POST', body: 'nope' });
  assert.equal(notJson.status, 400);
  assert.deepEqual(await readdir(locations.investigations), ['a.json']);
});

test('待删清单有上限：多于 100 条只列前 100，truncated 为 true', async t => {
  const { locations, deps } = await workspace(t);
  for (let index = 0; index < 101; index += 1)
    await writeAt(path.join(locations.wikiSessions, `s-${String(index).padStart(3, '0')}.json`), '{}', OLD + index);
  const base = await serve(t, deps);
  const result = await cleanup(base, { kind: 'wiki_sessions', keep: 0 });
  assert.equal(result.body.candidates.count, 101);
  assert.equal(result.body.candidates.items.length, 100);
  assert.equal(result.body.candidates.truncated, true);
});

test('配置覆盖层与日志也能按各自阈值清理', async t => {
  const { root, locations, deps } = await workspace(t);
  const overridesBytes = await writeAt(locations.overrides, '{"LLM_MODEL":"x"}', OLD);
  await writeAt(path.join(root, 'hids.log'), 'old-log', OLD);
  const base = await serve(t, deps);

  const overrides = await cleanup(base, { kind: 'config_overrides', action: 'delete',
    older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(overrides.status, 200);
  assert.deepEqual(overrides.body.applied, { count: 1, bytes: overridesBytes });
  assert.equal(row(overrides.body.inventory, 'config_overrides').count, 0);

  const logs = await cleanup(base, { kind: 'logs', action: 'archive',
    older_than: new Date(CUT).toISOString(), execute: true });
  assert.equal(logs.status, 200);
  assert.equal(logs.body.applied.count, 1);
  assert.equal(row(logs.body.inventory, 'logs').count, 0);
  assert.equal((await readdir(path.join(root, 'archive', 'logs'))).length, 1);
});

test('鉴权：两条新路由都在 Basic 闸门后（无凭据/错口令/错用户名 401，正文与四条头），正确凭据才 200', async t => {
  const { locations, deps } = await workspace(t);
  await writeAt(path.join(locations.investigations, 'a.json'), '{}', OLD);
  const base = await serve(t, deps, { auth: { user: 'ops', password: 'ops-pw' } });
  const basic = value => `Basic ${Buffer.from(value).toString('base64')}`;
  const expect401 = async (response, label) => {
    assert.equal(response.status, 401, label);
    assert.equal(response.headers.get('www-authenticate'), 'Basic realm="HIDS AI Console", charset="UTF-8"', label);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', label);
    assert.equal(response.headers.get('cache-control'), 'no-store', label);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', label);
    assert.deepEqual(await response.json(), { error: '需要登录后访问', code: 'unauthorized' }, label);
  };
  const post = headers => fetch(`${base}/api/data/cleanup`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ kind: 'investigations', keep: 0, execute: true }) });

  await expect401(await fetch(`${base}/api/data/inventory`), '盘点 无凭据');
  await expect401(await fetch(`${base}/api/data/inventory`, { headers: { authorization: basic('ops:wrong') } }), '盘点 错口令');
  await expect401(await fetch(`${base}/api/data/inventory`, { headers: { authorization: basic('admin:ops-pw') } }), '盘点 错用户名');
  await expect401(await post({}), '清理 无凭据');
  await expect401(await post({ authorization: basic('ops:wrong') }), '清理 错口令');
  // 被拒的清理（execute:true）一个字节没动盘
  assert.deepEqual(await readdir(locations.investigations), ['a.json']);

  // 正确凭据：两条路由都过闸门
  const allowed = { authorization: basic('ops:ops-pw') };
  assert.equal((await fetch(`${base}/api/data/inventory`, { headers: allowed })).status, 200);
  const cleaned = await post(allowed);
  assert.equal(cleaned.status, 200);
  assert.deepEqual((await cleaned.json()).applied, { count: 1, bytes: 2 });
  assert.deepEqual(await readdir(locations.investigations), []);
});

test('GET 只认 GET：盘点用 POST 回 405（P003-T073 起方法不匹配统一 405 + Allow，不在本路径兜）', async t => {
  const { deps } = await workspace(t);
  const base = await serve(t, deps);
  const response = await fetch(`${base}/api/data/inventory`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 405);
  assert.match(response.headers.get('allow'), /GET/);
});
