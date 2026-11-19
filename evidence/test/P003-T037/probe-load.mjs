// P003-T037 负载探针：独立运行根 / 无固定 sleep / 每步超时上界 / 负载下全绿。
//
// 跑法：bash evidence/test/P003-T037/probe-load.sh
// 手动跑要显式注入三个根（脚本会拒收仓内路径）：
//   HIDS_DATA_DIR=/tmp/x/data HIDS_WIKI_DIR=/tmp/x/wiki HIDS_CASES_DIR=/tmp/x/cases node evidence/test/P003-T037/probe-load.mjs
//
// 五段负载：
//   1) 队列：300 条 syslog 灌进 concurrency=4 / queueLimit=64 的监控器 → 64 条进队列、236 条丢弃计数，全部跑完
//   2) /api/status：并发 50 次探活共用一次 RPC（A8）
//   3) 列表快照：并发 50 次 alerts(from) 共用各类型首批（A10）
//   4) 规则库：40 条规则 × 100 次并发求值，命中 mtime 缓存（A6）
//   5) Wiki 目录索引：并发 50 次 agentIndex 结果稳定（A7）
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TriageMonitor } from '../../../triage-monitor.js';
import { CloudwalkerGateway, eventTypes, rpcMethods } from '../../../cloudwalker.js';
import { RuleStore } from '../../../rule-store.js';
import { WikiStore } from '../../../wiki-store.js';
import { InvestigationStore } from '../../../investigation-store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUN = process.env.HIDS_DATA_DIR;
const WIKI = process.env.HIDS_WIKI_DIR;
const CASES = process.env.HIDS_CASES_DIR;
assert.ok(RUN && WIKI && CASES, '探针必须显式注入 HIDS_DATA_DIR / HIDS_WIKI_DIR / HIDS_CASES_DIR');
for (const [name, dir] of [['HIDS_DATA_DIR', RUN], ['HIDS_WIKI_DIR', WIKI], ['HIDS_CASES_DIR', CASES]])
  assert.ok(!path.resolve(dir).startsWith(repoRoot), `${name} 不能指到工作树里：${dir}`);
await mkdir(RUN, { recursive: true });
await mkdir(WIKI, { recursive: true });
await mkdir(CASES, { recursive: true });

// 超时上界：每段负载都有上限，超了直接红，不靠 sleep 等。
function withTimeout(label, promise, timeoutMs = 30_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms 上界`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

// 无固定 sleep：只在谓词成立时前进，到点就报错（轮询间隔 5ms 是为了让出事件循环，不是等某事发生）。
async function waitUntil(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label} 在 ${timeoutMs}ms 内没有达到预期`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const results = [];
const stage = async (name, job) => {
  const startedAt = Date.now();
  const detail = await withTimeout(name, job());
  results.push({ stage: name, ms: Date.now() - startedAt, detail });
  console.log(`✔ ${name}（${Date.now() - startedAt}ms）${detail ? `：${detail}` : ''}`);
};

// ---- 1) 队列：上限 + 丢弃计数 + 全部跑完 ----
const concurrency = Number(process.env.HIDS_TRIAGE_CONCURRENCY || 4);
const queueLimit = Number(process.env.HIDS_TRIAGE_QUEUE_MAX || 64);
await stage('队列负载（300 条 / 并发 4 / 上限 64）', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = new TriageMonitor({ service: {}, inputMode: 'syslog', concurrency, queueLimit,
    file: path.join(RUN, 'triage-monitor.json'), casesDirectory: CASES,
    history: new InvestigationStore(path.join(RUN, 'results')),
    eventToolbox: { listEvents: async () => ({ total: 0, events: [] }) },
    investigator: { runUnmatchedSyslog: async () => { await gate; return { mode: 'triage',
      verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '负载探针', claims: [] },
      validation: { ok: true }, trace: [] }; } } });
  await monitor.start();
  const accepted = [];
  for (let n = 0; n < 300; n += 1) {
    const line = `<134>1 2026-11-03T08:00:00Z host app 1 cloudwalker-honeypot host_ip="10.0.0.${n % 250}"`
      + ` event_create_time="2026-11-03 08:00:00" source_ip="198.51.100.${n % 200}" target_port="${1000 + n}"`;
    accepted.push(await monitor.acceptSyslog(line));
  }
  const atDrop = monitor.summary();
  assert.equal(atDrop.concurrency, concurrency);
  assert.equal(atDrop.queue_limit, queueLimit);
  assert.equal(atDrop.dropped, 300 - queueLimit, '上限之后的每一条都记入丢弃计数');
  assert.equal(accepted.filter(item => item.dropped).length, 300 - queueLimit);
  release();
  await waitUntil('队列跑空', () => monitor.active === 0 &&
    ![...monitor.records.values()].some(record => record.status === 'queued' || record.status === 'running'));
  const done = monitor.summary();
  assert.equal(done.counts.done, queueLimit);
  assert.equal(done.counts.failed, 0);
  assert.equal(monitor.dropped, 300 - queueLimit, '跑完后丢弃计数不丢');
  return `done=${done.counts.done} dropped=${done.dropped}`;
});

// ---- 2) /api/status 并发只发一次探活 ----
await stage('/api/status（并发 50 次）', async () => {
  let calls = 0;
  const gateway = new CloudwalkerGateway({ call: async () => { calls += 1; return { total: 0, events: [] }; } });
  const statuses = await Promise.all(Array.from({ length: 50 }, () => gateway.status()));
  assert.equal(calls, 1, '50 次并发探活只发一次 RPC');
  assert.ok(statuses.every(status => status.connected === true));
  assert.equal(gateway.statusTtlMs, 45_000);
  // 二次请求仍在窗口内：还是那一次。
  await gateway.status();
  assert.equal(calls, 1);
  return `rpc=${calls}`;
});

// ---- 3) 列表快照：并发筛选/轮询共用各类型首批 ----
await stage('列表快照（并发 50 次 alerts）', async () => {
  const types = Object.keys(eventTypes);
  let calls = 0;
  const gateway = new CloudwalkerGateway({ call: async (method, args) => {
    calls += 1;
    const type = Object.keys(rpcMethods).find(name => method.startsWith(rpcMethods[name]));
    if (!type) return { total: 0, events: [] };
    const all = Array.from({ length: 120 }, (_, index) => ({ id: index + 1, created_at: 1_793_600_000 + index, level: 3 }));
    return { total: all.length, events: all.slice(args.offset, args.offset + args.count) };
  } });
  const pages = await Promise.all(Array.from({ length: 50 }, () => gateway.alerts({ count: 50, offset: 0,
    from: '2026-11-01T00:00:00.000Z' })));
  assert.equal(pages[0].alerts.length, 50);
  assert.ok(pages.every(page => page.alerts.length === 50 && page.partial === false));
  // 每个类型扫 120 条（50+50+20）最多 3 页；50 次并发请求共用同一份快照，不该是 50 × 33。
  assert.ok(calls <= types.length * 4, `并发 50 次只取一份快照：rpc=${calls}`);
  return `types=${types.length} rpc=${calls}`;
});

// ---- 4) 规则库：并发求值命中 mtime 缓存 ----
await stage('规则库（40 条 × 100 次并发求值）', async () => {
  const directory = path.join(RUN, 'rules');
  await mkdir(directory, { recursive: true });
  const rule = (index, expression) => `package hids.rules.rule_${index}\n\n# name: 规则 ${index}\n\ndefault match := false\n\nmatch if {\n  ${expression}\n}\n`;
  const fixed = new Date(1_793_600_000_000);
  for (let index = 0; index < 40; index += 1) {
    const filename = path.join(directory, `rule_${index}.rego`);
    await writeFile(filename, rule(index, index % 2 ? 'input.type == "webshell"' : 'input.type == "honeypot"'));
    await utimes(filename, fixed, fixed);
  }
  const store = new RuleStore(directory);
  const evaluations = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    store.evaluate({ type: index % 2 ? 'webshell' : 'honeypot' })));
  assert.ok(evaluations.every(evaluation => evaluation.count === 20), '每条规则只命中自己那一类');
  // 同 mtime 同字节数改写内容：命中缓存，求值结果不变（不重读重解析）。
  const target = path.join(directory, 'rule_0.rego');
  const before = await stat(target);
  await writeFile(target, rule(0, 'input.type == "webshell"'));
  await utimes(target, before.atime, before.mtime);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs, '测试前置：mtime 不变');
  assert.equal((await store.evaluate({ type: 'honeypot' })).count, 20, '同 mtime 走缓存：旧规则仍生效');
  return `rules=40 evaluations=100`;
});

// ---- 5) Wiki 目录索引：并发 agentIndex 结果稳定 ----
await stage('Wiki 目录索引（60 页 × 50 次并发）', async () => {
  const page = (id, title, status = 'active') => `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\nsource: 负载探针\n---\n\n正文。\n`;
  await mkdir(path.join(WIKI, 'common'), { recursive: true });
  await mkdir(path.join(WIKI, 'webshell'), { recursive: true });
  for (let index = 0; index < 20; index += 1)
    await writeFile(path.join(WIKI, 'common', `GEN-${index + 1}.md`), page(`GEN-${index + 1}`, `通用 ${index}`));
  for (let index = 0; index < 40; index += 1)
    await writeFile(path.join(WIKI, 'webshell', `WS-${index + 1}.md`), page(`WS-${index + 1}`, `判据 ${index}`));
  const wiki = new WikiStore(WIKI);
  const indexes = await Promise.all(Array.from({ length: 50 }, () => wiki.agentIndex('webshell')));
  assert.ok(indexes.every(index => index.pages.length === 60), 'common + webshell 共 60 页');
  assert.equal(new Set(indexes.map(index => index.pages.map(item => item.id).join(','))).size, 1, '并发结果一致');
  // 目录里的页面文件数就是 60，没有任何写到仓库 wiki/ 的痕迹。
  assert.equal((await readdir(WIKI)).length, 2);
  return `pages=60 calls=50`;
});

// 运行根自查：所有落盘都在注入的根里。
const triageFile = path.join(RUN, 'triage-monitor.json');
assert.ok(JSON.parse(await readFile(triageFile, 'utf8')), '队列状态落在 HIDS_DATA_DIR 里');
assert.ok((await readdir(CASES)).length > 0, '案卷落在 HIDS_CASES_DIR 里');

console.log('');
console.log(`ALL GREEN：${results.length} 段负载全绿`);
console.log(JSON.stringify({ run_root: RUN, wiki_root: WIKI, cases_root: CASES, concurrency, queue_limit: queueLimit,
  stages: results }, null, 2));
