// P003-T043 单测：砍掉 baseline/intel，研判背景统一走判据库（wiki/common/GEN-13.md）与规则层。
// 契约出处：docs/modules/triage-pipeline.md §6.2（04-上下文.md 只剩 window/history）、
//   docs/architecture.md §8.2（运行态只剩七条具名路径）、wiki/common/GEN-13.md（环境基线示例 + 白名单分层口径）。
// 全部在进程内跑：不碰网络、不碰真实时钟、不写仓库（临时目录走 mkdtemp）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimePaths } from '../../../server.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { writeSyslogCase } from '../../../src/contexts/triage/application/correlate.js';
import { WikiStore } from '../../../wiki-store.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const wikiDirectory = path.join(repository, 'wiki');
const doc = relative => readFile(path.join(repository, relative), 'utf8');
const tmp = () => mkdtemp(path.join(tmpdir(), 't043-'));

// ── A1：运行态路径与装配摘除 ────────────────────────────────────────────────
test('A1 runtimePaths 的具名路径是八条（本卡七条 + T047 的 fpSessions），baseline/intel 两键不在其中', () => {
  const paths = runtimePaths('/tmp/t043-root');
  // P003-T050：T047 把误报维护会话加进了 runtimePaths（`server.js:1420`），本卡的七条变八条——
  // 本用例钉的是「baseline/intel 没回来」，键集合按当时的现状钉全。
  assert.deepEqual(Object.keys(paths).sort(),
    ['cases', 'data', 'fpSessions', 'investigations', 'traceBoards', 'triageMonitor', 'triageRules', 'wikiSessions'],
    'runtimePaths 的具名路径清单不是砍掉 baseline/intel 之后的八条');
  assert.equal('baseline' in paths, false, 'baseline 键又回来了');
  assert.equal('intel' in paths, false, 'intel 键又回来了');
});

// 静态守卫，不是行为断言：这三条只是对源码字样做 grep，实现注释里出现这两个词就会误红。
// A1 的行为证据在 :25-29（runtimePaths 七键）/ :41-63（坏 JSON 不致命 + contextFor 六键）两条用例。
test('A1 server.js 里不再出现 baselineFile/intelFile 与 runtime.baseline/runtime.intel', async () => {
  const source = await doc('server.js');
  assert.equal(/baselineFile|intelFile/.test(source), false, 'server.js 还把 baselineFile/intelFile 传给 TriageMonitor');
  assert.equal(/runtime\.baseline|runtime\.intel/.test(source), false, 'server.js 还在读 runtime.baseline / runtime.intel');
  assert.equal(/baseline\.json|intel\.json/.test(source), false, 'runtimePaths 还在拼 baseline.json / intel.json');
});

test('A1 contextFor 不读基线/情报文件，返回值里没有 baseline/intel 两段', async t => {
  const directory = await tmp();
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // 两个坏 JSON：旧实现会 JSON.parse 抛错（ENOENT 才兜底），新实现根本不打开它们。
  // 这条断言的可失败性就在这里——把读文件加回去，本用例立刻红。
  const baselineFile = path.join(directory, 'baseline.json');
  const intelFile = path.join(directory, 'intel.json');
  await writeFile(baselineFile, '{"test_tool_paths": [ 坏 JSON', 'utf8');
  await writeFile(intelFile, '{"by_ip": { 坏 JSON', 'utf8');

  const monitor = new TriageMonitor({ service: {}, investigator: {}, history: {}, file: path.join(directory, 'queue.json'),
    baselineFile, intelFile });
  assert.equal('baselineFile' in monitor || 'intelFile' in monitor, false, '构造参数还能落到实例上');

  const context = await monitor.contextFor({ session_key: 's1', occurrence_count: 3, repeat_count: 2,
    input: { parsed: { payload: { source_ip: '192.0.2.9' } } } });
  assert.deepEqual(Object.keys(context).sort(),
    ['delivery_count', 'history', 'occurrence_count', 'session_key', 'window', 'window_seconds'],
    'contextFor 的返回字段变了');
  assert.equal(context.delivery_count, 2);
  assert.equal(context.occurrence_count, 3);
  assert.equal(context.session_key, 's1');
});

// ── A2：04-上下文.md 去掉两段，保留会话窗口 / 投递次数 / 历史结论 ──────────────
test('A2 04-上下文.md 的 JSON 只留 window/history，会话与投递次数照旧', async t => {
  const directory = await tmp();
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const info = await writeSyslogCase({ directory, raw: 'RAW-LINE',
    parsed: { msgid: 'cloudwalker-webshell', ts: '2026-11-17T10:00:00Z', payload_format: 'keyvalue',
      payload: { host_ip: '10.0.0.5', process_command_line: 'id' } },
    context: { occurrence_count: 2, delivery_count: 3, window: [{ at: 1 }],
      baseline: { test_tool_paths: [] }, intel: { by_ip: {} }, history: [{ at: 'x', conclusion: {} }] },
    match: { matched: false, reason: '未查询' }, wiki: null });

  const body = await readFile(path.join(info.case_dir, '04-上下文.md'), 'utf8');
  assert.equal(/baseline|intel/i.test(body), false, '04-上下文.md 里还有 baseline/intel');
  assert.match(body, /本条投递次数：3/, '投递次数丢了');
  assert.match(body, /本条出现次数：2/, '出现次数丢了');
  assert.match(body, /同会话时间窗：前后各 5 分钟，当前已收到 1 条/, '会话时间窗丢了');
  const json = JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(Object.keys(json).sort(), ['history', 'window'], '上下文 JSON 的键不是 window/history');
  assert.equal(json.window.length, 1);
  assert.equal(json.history.length, 1, '历史结论没写进去');
});

// ── A3：种子页在判据库里，模型按编号可达 ────────────────────────────────────
test('A3 GEN-13 在种子页里，agentIndex / agentPage / agentSearch 都能读到', async () => {
  const store = new WikiStore(wikiDirectory); // 直接读仓内种子（数据根播种在探针里验）
  for (const eventType of ['webshell', 'honeypot', 'abnormal_login', 'command_whitelist']) {
    const index = await store.agentIndex(eventType);
    assert.ok(index.pages.some(page => page.id === 'GEN-13'), `${eventType} 的判据索引里没有 GEN-13`);
  }
  const page = await store.agentPage('webshell', 'GEN-13');
  assert.equal(page.path, 'common/GEN-13.md');
  assert.match(page.title, /环境基线/);
  const hits = await store.agentSearch('webshell', '白名单');
  assert.ok(hits.some(hit => hit.id === 'GEN-13'), 'wiki_search 搜不到 GEN-13');

  const source = await readFile(path.join(wikiDirectory, 'common', 'GEN-13.md'), 'utf8');
  assert.match(source, /^status: active$/m, 'GEN-13 不是 active，模型看不见');
  assert.match(source, /^id: GEN-13$/m);
});

test('A3 GEN-13 覆盖原 baseline.json 的四类信息', async () => {
  const source = await readFile(path.join(wikiDirectory, 'common', 'GEN-13.md'), 'utf8');
  for (const keyword of ['测试工具路径', '授权运维', '白名单命令', '来源国家', 'IP 清单'])
    assert.ok(source.includes(keyword), `GEN-13 缺了「${keyword}」这一类`);
});

// ── A4：白名单命令的分层口径写进判据页 ──────────────────────────────────────
// 分层必须自洽：规则层只收「程序可复算」的载体（rego 规则库 + 误报规则集）；
// `command_whitelist` 的场景提示是纯提示词（`prompts/scenarios.json`，没有判定消费者；装配侧仍会被读入），不能算硬判定。
const tableRow = (source, label) => {
  const row = source.split('\n').find(line => line.startsWith('|') && line.includes(label));
  assert.ok(row, `GEN-13 的分层表缺了「${label}」这一行`);
  return row;
};

test('A4 GEN-13 写清白名单命令哪层是硬判定、哪层只是研判参考', async () => {
  const source = await readFile(path.join(wikiDirectory, 'common', 'GEN-13.md'), 'utf8');
  const hard = tableRow(source, '规则层（硬判定）');
  for (const carrier of ['rules/*.rego', 'triage-rules.json'])
    assert.ok(hard.includes(carrier), `规则层没点名载体 ${carrier}`);
  assert.equal(hard.includes('command_whitelist'), false,
    '规则层（硬判定）行把纯提示词 command_whitelist 算成了程序可复算的判定');

  const promptLayer = tableRow(source, '场景提示（不是判定层）');
  assert.ok(promptLayer.includes('command_whitelist'), '场景提示行没点名 command_whitelist');
  assert.ok(promptLayer.includes('没有判定消费者'), '场景提示行没说清它没有判定消费者（提示词会被装配读入，只是不产出判定）');
  assert.equal(promptLayer.includes('没有程序消费者'), false,
    '「没有程序消费者」字面不成立——prompts/scenarios.json 会被 prompt-store.js / investigation-agent.js 读入装配');

  assert.ok(tableRow(source, '研判参考').includes('GEN-13.md'), '研判参考行没指向本页');
  assert.match(source, /不能代替规则层/, '没有「本页不能代替规则层结论」的禁令');
  assert.match(source, /不自动关闭、不加白、不处置/, '没有「不自动加白」的口径');
  assert.match(source, /场景提示与\*\*本页清单都不是判定来源\*\*/, '硬结论没把场景提示排除在判定来源之外');
});

test('A4 判据页只引用当前 active 页，不引 deprecated 页', async () => {
  const source = await readFile(path.join(wikiDirectory, 'common', 'GEN-13.md'), 'utf8');
  // 跨目录（../common/GEN-12.md）与同目录（GEN-12.md）两种写法都要核，别只扫跨目录。
  const links = [...source.matchAll(/\]\(((?:\.\.\/[a-z-]+\/)?[A-Z]{2,3}-\d+\.md)\)/g)].map(match => match[1]);
  assert.ok(links.length > 0, 'GEN-13 一条页间引用都没有，这条守卫等于没生效');
  for (const link of links) {
    const target = await readFile(path.join(wikiDirectory, 'common', link), 'utf8');
    assert.match(target, /^status: active$/m, `GEN-13 引了非 active 页：${link}`);
  }
});

test('A4 入口页与日志登记了 GEN-13', async () => {
  assert.match(await doc('wiki/index.md'), /GEN-13/, 'wiki/index.md 没有 GEN-13 入口');
  const log = await doc('wiki/log.md');
  assert.match(log, /## \[2026-11-20\][\s\S]*GEN-13/, 'wiki/log.md 顶部没有 GEN-13 的登记');
});

// 日志与判据页必须是同一口径：维护者按 `grep "^## \[" log.md | head -5` 读到的就是这条，
// 上轮只改了 GEN-13、这句副本留在 log 里，等于同一份库两种说法。
test('A4 wiki/log.md 的本次登记与 GEN-13 的分层口径一致', async () => {
  const log = await doc('wiki/log.md');
  const start = log.indexOf('## [2026-11-20]');
  const entry = log.slice(start, log.indexOf('\n## [', start + 1) === -1 ? undefined : log.indexOf('\n## [', start + 1));
  const ruleLine = entry.split('\n').find(line => line.includes('规则层（硬判定）'));
  assert.ok(ruleLine, 'log 的本次登记里没有「规则层（硬判定）」这句');
  assert.ok(ruleLine.includes('rules/*.rego') && ruleLine.includes('triage-rules.json'), 'log 的规则层没点名两个程序载体');
  assert.equal(ruleLine.includes('command_whitelist'), false,
    'log 把 command_whitelist 场景提示算进「规则层（硬判定）」了');
  const promptLine = entry.split('\n').find(line => line.includes('场景提示（不是判定层）'));
  assert.ok(promptLine, 'log 没有把 command_whitelist 场景提示单列成「不是判定层」');
  assert.ok(promptLine.includes('command_whitelist'), 'log 的场景提示行没点名 command_whitelist');
  assert.ok(promptLine.includes('没有判定消费者'), 'log 没说清场景提示没有判定消费者');
});

// ── A5：既有文档与证据件跟上新语义 ──────────────────────────────────────────
test('A5 对外文档里不再有九条路径与 04-上下文.md 带基线/情报的旧口径', async () => {
  const pipeline = await doc('docs/modules/triage-pipeline.md');
  assert.equal(pipeline.includes('`window`/`baseline`/`intel`/`history`'), false, 'triage-pipeline 还写着四段 JSON');
  assert.equal(pipeline.includes('baseline: {}, intel: {}'), false, 'triage-pipeline 示例还带 baseline/intel');
  assert.match(pipeline, /`window`\/`history` 的 JSON/, 'triage-pipeline 没写新的两段 JSON');
  // §1「不做什么」的可复跑验证块必须对**当前**代码成立：脚本体与终端输出都要跟实测一致。
  assert.ok(pipeline.includes("grep -niE 'http|router|auth|token' triage-monitor.js syslog-input.js syslog-case.js"),
    'triage-pipeline 的验证命令被改了');
  assert.ok(pipeline.includes('triage-monitor.js:566:'), '验证块的输出里没有实测那条命中');
  assert.equal(pipeline.includes('triage-monitor.js:914:'), false,
    '验证块还贴着已被删除的 :914 命中（那段基线读取随 P003-T043 一起删了）');
  assert.equal(pipeline.includes('两处命中'), false, '验证块还写着「两处命中」，与当前代码不符');

  const architecture = await doc('docs/architecture.md');
  assert.equal(architecture.includes('| `<数据根>/baseline.json` |'), false, 'architecture §8.2 还留着 baseline.json 行');
  assert.equal(architecture.includes('| `<数据根>/intel.json` |'), false, 'architecture §8.2 还留着 intel.json 行');
  assert.equal(/九条具名路径/.test(architecture), false, 'architecture 还写着九条具名路径');

  const httpApi = await doc('docs/modules/http-api.md');
  assert.equal(httpApi.includes('（9 条路径）'), false, 'http-api 还写着 9 条路径');
  assert.equal(/`cases` \/ `baseline` \/ `intel` \/ `wikiSessions`/.test(httpApi), false,
    'http-api 的 runtimePaths 枚举还列着 baseline/intel');
});

test('A5 两个证据件的数据目录断言已经跟上七条路径', async () => {
  const dataDir = await doc('evidence/test/P003-T019/data-dir.test.js');
  assert.equal(dataDir.includes("baseline: 'baseline.json'"), false, 'T019 的 layout 还带 baseline');
  assert.equal(dataDir.includes("intel: 'intel.json'"), false, 'T019 的 layout 还带 intel');
  assert.match(dataDir, /traceBoards: 'trace-boards'/, 'T019 的 layout 被改坏了');

  const acceptance = await doc('evidence/test/P003-T034/acceptance.tester.test.js');
  assert.equal(acceptance.includes("baseline: path.join(root, 'baseline.json')"), false,
    'T034 的期望对象还带 baseline');
  assert.equal(acceptance.includes("intel: path.join(root, 'intel.json')"), false, 'T034 的期望对象还带 intel');
});

// ── 负范围钉子：案卷目录里不再出现这两份文件（写盘面零残留） ─────────────────
test('A1 新增代码不再产出 baseline/intel 相关文件，案卷目录只有既定材料', async t => {
  const directory = await tmp();
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const info = await writeSyslogCase({ directory, raw: 'RAW-LINE',
    parsed: { msgid: 'cloudwalker-webshell', ts: '2026-11-17T10:00:00Z', payload_format: 'keyvalue', payload: { host_ip: '10.0.0.5' } },
    context: { occurrence_count: 1, delivery_count: 1, window: [], history: [] },
    match: { matched: false, reason: '未查询' }, wiki: null });
  const files = await readdir(info.case_dir);
  assert.equal(files.some(name => /baseline|intel/i.test(name)), false, '案卷里出现了 baseline/intel 文件');
  assert.deepEqual(files.sort(), ['00-这是什么.md', '01-原始告警.txt', '02-告警字段.md', '03-研判事实.md', '04-上下文.md']);
});
