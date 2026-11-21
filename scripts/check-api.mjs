#!/usr/bin/env node
// R-API 对账（P003-T075 / D035 §2）：openapi.yaml ↔ 实现路由 ↔ 用例清单，三方各对一遍。零依赖。
//
//   ① openapi.yaml 路径+方法（直接解析 YAML 的路径节）↔ 实现路由注册表：
//      契约有、实现没有 = 空头支票；实现有、契约没有 = 前端照契约写会漏（现状已知：PUT /api/wiki/pages/{pagePath}）。
//   ② 注册表防漂移：每条注册路由带 probe（实现源码里真实存在的字面量），probe 找不到了 = 注册表过期，判失败。
//   ③ 用例清单（evidence/recon/P003-T075/archaeology-use-cases.md 的 45 对外 + 23 内部）：
//      每个对外用例必须能落到至少一条已实现路由；「该开出口」的内部用例列成欠账（基线管理）。
//
// 基线机制同 check-layers：--write-baseline 存快照，之后基线之外的差值判失败；每批清零就从基线删条目。
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writeBaseline = process.argv.includes('--write-baseline');
const baselineFile = path.join(repo, 'scripts', 'check-api-baseline.json');

// ── ① openapi.yaml：只解析顶层 paths 的路径键与 4 空格缩进的 method 键（本仓契约是规则子集）──
function parseOpenapi(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const contract = new Map(); // "METHOD /path" -> true
  let currentPath = null;
  for (const line of lines) {
    const pathMatch = line.match(/^  (\/[^:\s]+):\s*$/);
    if (pathMatch) { currentPath = pathMatch[1]; continue; }
    if (/^  \S/.test(line) && !line.startsWith('    ')) currentPath = null; // 离开 paths 区
    if (!currentPath) continue;
    const methodMatch = line.match(/^    (get|post|put|delete|patch|head|options):\s*$/);
    if (methodMatch) contract.set(`${methodMatch[1].toUpperCase()} ${currentPath}`, currentPath);
  }
  return contract;
}

// ── ② 实现路由注册表：route = "METHOD /模板"，probe 是实现源码里真实存在的字面量 ──────────
// probe 的用途是防漂移：重构把某条路由挪走/改名而没更新注册表时，probe 落空立刻红。
// 来源：server.js / maintenance-server.js 路由分支（行号见 archaeology-use-cases.md §一）。
const ROUTES = [
  // 运行配置与身份
  { route: 'GET /api/session', probe: "'/api/session'" },
  { route: 'GET /api/updates', probe: "'/api/updates'" },
  { route: 'GET /api/updates/packages', probe: "'/api/updates/packages'" },
  { route: 'GET /api/config', probe: "'/api/config'" },
  { route: 'POST /api/config', probe: "'/api/config'" },
  // 状态与工具目录
  { route: 'GET /api/status', probe: "'/api/status'" },
  { route: 'GET /api/events', probe: "'/api/events'" },
  { route: 'GET /api/agent/status', probe: "'/api/agent/status'" },
  { route: 'GET /api/agent/prompts', probe: "'/api/agent/prompts'" },
  { route: 'PUT /api/agent/prompts/{section}', probe: 'agent\\/prompts\\/(.+)$' },
  { route: 'GET /api/agent/tools', probe: "'/api/agent/tools'" },
  { route: 'GET /api/trace/tools', probe: "'/api/trace/tools'" },
  { route: 'POST /api/agent/prompts/upload', probe: "'/api/agent/prompts/upload'", note: '410 下线哨兵，非用例' },
  // 本地存储与日志
  { route: 'GET /api/data/inventory', probe: "'/api/data/inventory'" },
  { route: 'POST /api/data/cleanup', probe: "'/api/data/cleanup'" },
  { route: 'GET /api/logs', probe: "'/api/logs'" },
  { route: 'GET /api/audit', probe: "'/api/audit'" },
  { route: 'GET /api/dict', probe: "'/api/dict'" },
  { route: 'POST /api/logs/cleanup', probe: "'/api/logs/cleanup'" },
  // 告警
  { route: 'GET /api/alerts', probe: "'/api/alerts'" },
  { route: 'GET /api/alerts/{alertId}', probe: '^\\/api\\/alerts\\/([^/]+)$' },
  // 研判队列与记录
  { route: 'GET /api/agent/triage/status', probe: "'/api/agent/triage/status'" },
  { route: 'GET /api/agent/triage/cases', probe: "'/api/agent/triage/cases'" },
  { route: 'PUT /api/agent/triage/control', probe: "'/api/agent/triage/control'" },
  { route: 'GET /api/agent/triage/{alertId}', probe: "'/api/agent/triage/'" },
  { route: 'POST /api/agent/triage/{alertId}', probe: "'/api/agent/triage/'" },
  { route: 'DELETE /api/agent/triage/{alertId}', probe: "'/api/agent/triage/'" },
  { route: 'POST /api/agent/triage/{alertId}/false-positive', probe: '\\/false-positive$' },
  { route: 'POST /api/batch/{action}', probe: '\\/api\\/batch\\/' },
  { route: 'GET /api/agent/triage/{alertId}/raw', probe: '/raw$' },
  { route: 'GET /api/cases/related', probe: "'/api/cases/related'" },
  // 深度研判
  { route: 'POST /api/agent/investigations', probe: "'/api/agent/investigations'" },
  { route: 'GET /api/agent/investigations', probe: "'/api/agent/investigations'" },
  { route: 'GET /api/agent/triage/{alertId}/case-files', probe: '/case-files$' },
  { route: 'GET /api/agent/triage/{alertId}/case-files/{name}', probe: 'case-files\\/(.+)' },
  { route: 'GET /api/agent/investigations/{alertId}/replay', probe: '\\/replay$' },
  { route: 'GET /api/agent/investigations/{alertId}', probe: "'/api/agent/investigations/'" },
  // 溯源白板
  { route: 'GET /api/trace/boards', probe: "'/api/trace/boards'" },
  { route: 'POST /api/trace/boards', probe: "'/api/trace/boards'" },
  { route: 'GET /api/trace/boards/{target}', probe: "'/api/trace/boards/'" },
  { route: 'GET /api/trace/boards/{target}/versions', probe: '\\/versions$' },
  { route: 'GET /api/trace/boards/{target}/versions/{revision}', probe: '\\/versions\\/([0-9a-f]{16})$' },
  { route: 'GET /api/trace/boards/{target}/diff', probe: '\\/diff$' },
  // 前置规则集（JSON）
  { route: 'GET /api/triage/rules/history', probe: "'/api/triage/rules/history'" },
  { route: 'GET /api/triage/rules/history/{rev}', probe: 'triage\\/rules\\/history\\/' },
  { route: 'POST /api/triage/rules/rollback', probe: "'/api/triage/rules/rollback'" },
  { route: 'GET /api/rules/hits', probe: "'/api/rules/hits'" },
  { route: 'GET /api/triage/rules', probe: "'/api/triage/rules'" },
  { route: 'POST /api/triage/rules/validate', probe: "'/api/triage/rules/validate'" },
  { route: 'PUT /api/triage/rules', probe: "'/api/triage/rules'" },
  // Rego 规则库
  { route: 'GET /api/rules', probe: "pathname === '/api/rules'" },
  { route: 'GET /api/rules/sessions', probe: "'/api/rules/sessions'" },
  { route: 'POST /api/rules/evaluate', probe: "'/api/rules/evaluate'" },
  { route: 'GET /api/rules/{id}/history', probe: '/(history|rollback)$' },
  { route: 'POST /api/rules/{id}/rollback', probe: '/(history|rollback)$' },
  { route: 'PUT /api/rules/{id}', probe: "'/api/rules/'" },
  { route: 'GET /api/rules/{id}', probe: "'/api/rules/'" },
  // 误报维护会话
  { route: 'GET /api/false-positive/sessions', probe: "'/api/false-positive/sessions'" },
  { route: 'GET /api/false-positive/sessions/{id}', probe: "'/api/false-positive/sessions/'" },
  // 判据库与知识维护会话
  { route: 'GET /api/wiki/pages-history', probe: "'/api/wiki/pages-history'" },
  { route: 'GET /api/wiki/revisions', probe: "'/api/wiki/revisions'" },
  { route: 'POST /api/wiki/rollback', probe: "'/api/wiki/rollback'" },
  { route: 'GET /api/wiki/reference-graph', probe: "'/api/wiki/reference-graph'" },
  { route: 'GET /api/wiki/usage', probe: "'/api/wiki/usage'" },
  { route: 'GET /api/wiki/pages', probe: "'/api/wiki/pages'" },
  { route: 'GET /api/wiki/pages/{pagePath}', probe: "'/api/wiki/pages/'" },
  { route: 'PUT /api/wiki/pages/{pagePath}', probe: "'/api/wiki/pages/'", note: '实现有、契约没有（R-API 已知欠账 #1）' },
  { route: 'GET /api/wiki/health', probe: "'/api/wiki/health'" },
  { route: 'GET /api/wiki/sessions', probe: "'/api/wiki/sessions'" },
  { route: 'POST /api/wiki/sessions', probe: "'/api/wiki/sessions'" },
  { route: 'GET /api/wiki/sessions/{sessionId}', probe: '/(messages|replay|publish)' },
  { route: 'POST /api/wiki/sessions/{sessionId}/messages', probe: '/(messages|replay|publish)' },
  { route: 'POST /api/wiki/sessions/{sessionId}/replay', probe: '/(messages|replay|publish)' },
  { route: 'POST /api/wiki/sessions/{sessionId}/publish', probe: '/(messages|replay|publish)' },
  // 维护端（18081）
  { route: 'GET /api/maintenance/session', probe: "'/api/maintenance/session'" },
  { route: 'POST /api/maintenance/login', probe: "'/api/maintenance/login'" },
  { route: 'POST /api/maintenance/logout', probe: "'/api/maintenance/logout'" },
  { route: 'GET /api/maintenance/overview', probe: "'/api/maintenance/overview'" },
  { route: 'POST /api/maintenance/packages', probe: "'/api/maintenance/packages'" },
  { route: 'GET /api/maintenance/packages/{id}', probe: '\\/packages\\/' },
  { route: 'POST /api/maintenance/packages/{id}/apply', probe: '\\/packages\\/' }
];

// ── ③ 用例清单（45 对外 UC-01..45 + 23 内部 I-01..I-23），出自 archaeology-use-cases.md ──────
// external: UC → 实现路由（同注册表里的 route 键）。internal.status：
//   exit_needed = 用户需要看/做但没有出口（R-API 欠账）；internal = 合理内部（定时/队列/闸门/sink）；
//   dead = 有实现、无调用方、无路由。
const USE_CASES = {
  external: {
    UC01: ['GET /api/session', 'GET /api/config'], UC02: ['POST /api/config'], UC03: ['GET /api/session'],
    UC04: ['GET /api/updates'], UC05: ['GET /api/status'], UC06: ['GET /api/agent/status'],
    UC07: ['GET /api/agent/prompts'], UC08: ['GET /api/agent/tools', 'GET /api/trace/tools'],
    UC09: ['GET /api/data/inventory'], UC10: ['POST /api/data/cleanup'], UC11: ['GET /api/logs'],
    UC12: ['POST /api/logs/cleanup'], UC13: ['GET /api/alerts', 'GET /api/alerts/{alertId}'],
    UC14: ['GET /api/agent/triage/status', 'GET /api/agent/triage/cases', 'GET /api/agent/triage/{alertId}'],
    UC15: ['PUT /api/agent/triage/control'], UC16: ['POST /api/agent/triage/{alertId}'],
    UC17: ['DELETE /api/agent/triage/{alertId}'], UC18: ['POST /api/agent/triage/{alertId}/false-positive'],
    UC19: ['POST /api/agent/investigations'],
    UC20: ['GET /api/agent/investigations/{alertId}', 'GET /api/agent/investigations/{alertId}/replay'],
    UC21: ['POST /api/trace/boards'], UC22: ['GET /api/trace/boards', 'GET /api/trace/boards/{target}'],
    UC23: ['GET /api/triage/rules'], UC24: ['POST /api/triage/rules/validate'], UC25: ['PUT /api/triage/rules'],
    UC26: ['GET /api/rules', 'GET /api/rules/{id}', 'GET /api/rules/{id}/history'],
    UC27: ['PUT /api/rules/{id}', 'POST /api/rules/{id}/rollback'], UC28: ['POST /api/rules/evaluate'],
    UC29: ['GET /api/rules/sessions'],
    UC30: ['GET /api/false-positive/sessions', 'GET /api/false-positive/sessions/{id}'],
    UC31: ['GET /api/wiki/pages', 'GET /api/wiki/pages/{pagePath}'], UC32: ['PUT /api/wiki/pages/{pagePath}'],
    UC33: ['GET /api/wiki/health'],
    UC34: ['GET /api/wiki/sessions', 'GET /api/wiki/sessions/{sessionId}'], UC35: ['POST /api/wiki/sessions'],
    UC36: ['POST /api/wiki/sessions/{sessionId}/messages'], UC37: ['POST /api/wiki/sessions/{sessionId}/replay'],
    UC38: ['POST /api/wiki/sessions/{sessionId}/publish'],
    UC39: ['GET /api/maintenance/session'], UC40: ['POST /api/maintenance/login'], UC41: ['POST /api/maintenance/logout'],
    UC42: ['GET /api/maintenance/overview'], UC43: ['POST /api/maintenance/packages'],
    UC44: ['GET /api/maintenance/packages/{id}'], UC45: ['POST /api/maintenance/packages/{id}/apply']
  },
  internal: {
    I01: { status: 'internal', note: 'UDP syslog 接收入队（系统）' },
    I02: { status: 'internal', note: '定时轮询入队（系统）' },
    I03: { status: 'internal', note: '队列 worker：出队跑研判（D034 §8.2 更正：合理内部，已移出待出口清单）' },
    I04: { status: 'internal', note: '失败重试排期与死信（系统）' },
    I05: { status: 'internal', note: 'done 记录 TTL 归档（系统）' },
    I06: { status: 'internal', note: '重复投递计数回写（系统）' },
    I07: { status: 'internal', note: '匹配牧云事件、建立案卷（系统）' },
    I08: { status: 'exit_needed', gap: 'A02', note: 'Agent 读案卷材料 → T059 出 HTTP 出口' },
    I09: { status: 'internal', note: '必查项落盘与复算（Agent 内部）' },
    I10: { status: 'internal', note: '研判前规则预筛（系统内部判定）' },
    I11: { status: 'internal', note: '证据声明机器校验（Agent 内部）' },
    I12: { status: 'exit_needed', gap: 'A16', note: '证据投影与脱敏 → T068 出证据原文出口' },
    I13: { status: 'exit_needed', gap: 'A03/I-13', note: '误报维护四轮推进可观测 → T088/T089 出进度推送' },
    I14: { status: 'exit_needed', gap: 'A11', note: '规则维护者提修订的会话详情 → T070/T086 出详情路由' },
    I15: { status: 'exit_needed', gap: 'A13/I-15', note: '判据草案生成进度可观测 → T087/T089 出进度' },
    I16: { status: 'internal', note: '判据发布前 bundle 检查（系统闸）' },
    I17: { status: 'internal', note: '升级包验签与落盘（系统）' },
    I18: { status: 'internal', note: '写配置后的活跃客户端原地换值（系统）' },
    I19: { status: 'internal', note: '启动闸门校验（进程入口）' },
    I20: { status: 'internal', note: '覆盖层加载进 env（启动时）' },
    I21: { status: 'internal', note: '日志文件 sink 与轮转（系统）' },
    I22: { status: 'internal', note: '判据库/规则库种子初始化（首次读）' },
    I23: { status: 'internal', note: '未匹配 syslog 兜底研判（系统）' }
  },
  dead: [
    { what: 'knowledge-store.js 的 publish/withdraw/reply/defer', why: '有实现、无调用方、无路由（D034 §8.2）', action: 'T079 裁决：接入或删除' },
    { what: 'POST /api/agent/prompts/upload（恒 410）', why: '下线哨兵，非用例', action: '保留为哨兵' }
  ]
};

// ── 对账 ─────────────────────────────────────────────────────────────────────
const sources = ['server.js', 'src/interfaces/http/maintenance/server.js'].map(f => readFileSync(path.join(repo, f), 'utf8'));
const joined = sources.join('\n');
const findings = {};

// ② 注册表防漂移
const stale = ROUTES.filter(entry => {
  const probe = entry.probe.replaceAll('\\\\', '\\');
  return !joined.includes(probe);
});
findings['registry-stale'] = stale.map(entry => entry.route);

// ① 实现路由 ↔ openapi（参数名归一化成 {} 再比：注册表写 {id}、契约写 {packageId} 算同一条路由）
const normalize = route => route.replaceAll(/\{[^}]+\}/g, '{}');
const contract = parseOpenapi(path.join(repo, 'openapi.yaml'));
if (contract.size === 0) findings['openapi-unreadable'] = ['openapi.yaml 没解析出任何路径——解析器或契约格式变了'];
const contractKeys = new Set([...contract.keys()].map(normalize));
const routeKeys = new Set(ROUTES.map(entry => entry.route));
const routeKeysNorm = new Set(ROUTES.map(entry => normalize(entry.route)));
findings['impl-missing-in-contract'] = [...routeKeys].filter(route => !contractKeys.has(normalize(route))).sort();
findings['contract-missing-in-impl'] = [...contractKeys].filter(key => !routeKeysNorm.has(key)).sort();

// ③ 用例落点：对外用例的路由必须都在注册表里
findings['usecase-route-not-implemented'] = Object.entries(USE_CASES.external)
  .flatMap(([uc, routes]) => routes.filter(route => !routeKeysNorm.has(normalize(route))).map(route => `${uc} → ${route}`))
  .sort();
findings['usecase-exit-needed'] = Object.entries(USE_CASES.internal)
  .filter(([, def]) => def.status === 'exit_needed')
  .map(([id, def]) => `${id}（${def.gap}）`);
findings['dead-code'] = USE_CASES.dead.map(entry => `${entry.what} — ${entry.action}`);

// ── 基线对比与输出 ────────────────────────────────────────────────────────────
const flat = {};
for (const [kind, list] of Object.entries(findings))
  for (const item of list) flat[`${kind}|${item}`] = { kind, item };

let baseline = {};
if (existsSync(baselineFile)) baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
const baselineKeys = new Set(Object.keys(baseline));
const currentKeys = new Set(Object.keys(flat));
const unexpected = [...currentKeys].filter(key => !baselineKeys.has(key));

if (writeBaseline) {
  writeFileSync(baselineFile, `${JSON.stringify(flat, null, 2)}\n`);
  console.log(`check-api: baseline written — ${Object.keys(flat).length} findings → scripts/check-api-baseline.json`);
  console.log(`  契约 ${contract.size} 个路径操作 ↔ 注册表 ${ROUTES.length} 条路由；对外用例 ${Object.keys(USE_CASES.external).length}，内部 ${Object.keys(USE_CASES.internal).length}`);
} else {
  const byKind = {};
  for (const key of currentKeys) { const kind = flat[key].kind; byKind[kind] = (byKind[kind] ?? 0) + 1; }
  console.log(`check-api 现状：契约 ${contract.size} 操作 ↔ 注册表 ${ROUTES.length} 路由；对外用例 ${Object.keys(USE_CASES.external).length}，内部 ${Object.keys(USE_CASES.internal).length}（该开出口 ${findings['usecase-exit-needed'].length}）`);
  for (const [kind, count] of Object.entries(byKind).sort()) console.log(`  ${kind}: ${count}`);
  if (unexpected.length) {
    console.log(`\n基线之外的差值 ${unexpected.length} 条：`);
    for (const key of unexpected) console.log(`  ✗ [${flat[key].kind}] ${key.slice(key.indexOf('|') + 1)}`);
    process.exitCode = 1;
  } else console.log('\n基线之外 0 差值 ✓');
}
