// 路由：hash → 页面模块。页面模块住在 web/pages/，一个文件一页（P002-T002…T007 各写各的）。
//
// 约定（改这里之前先读 web/README.md §4）：
//   page = { id, title, navLabel, render(content, { params }) }
//   - id      路由 id，也是 hash 的第一段（#/overview）
//   - title   顶栏标题
//   - navLabel 侧栏文案；null = 不在侧栏出现（如告警详情）
//   - params  hash 第一段之后的其余段（#/alert-detail/intrusion:12 → ['intrusion:12']）

import { page as alertDetail } from '../pages/alert-detail.js';
import { page as alerts } from '../pages/alerts.js';
import { page as knowledge } from '../pages/knowledge.js';
import { page as overview } from '../pages/overview.js';
import { page as rules } from '../pages/rules.js';
import { page as rulesGate } from '../pages/rules-gate.js';
import { page as trace } from '../pages/trace.js';
import { page as traceBoard } from '../pages/trace-board.js';

/**
 * 全部页面。顺序即侧栏顺序（navLabel 为空的不进侧栏）。
 * 牧云现查不再是单独入口（P003-T026 / D025）：拉取动作在 `alerts` 页上；旧 hash `#/alerts-demo` 走别名回落到 `alerts`。
 * `trace` 是溯源**列表**（D015：进去先是列表），`trace-board` 是这一条的白板（D016，`#/trace-board/<告警 ID>`）。
 * `rules` 是 Rego 规则**列表**（D017：进去先是表），`#/rules/<id>` 是这条规则的原文（`render` 按 params 分发）；
 * `rules-gate` 是旧程序门禁编辑页（P003-T017 搬到不进侧栏的隐藏路由，不进侧栏）。
 */
export const PAGES = [overview, alerts, alertDetail, trace, traceBoard, rules, rulesGate, knowledge];

/** 侧栏上的入口：总览 / 告警 / 深度溯源 / 规则 / 知识库 */
export const NAV_PAGES = PAGES.filter(page => page.navLabel);

export const DEFAULT_ROUTE = 'overview';

// 旧入口兼容（P003-T026）：`#/alerts-demo` 不再是产品入口，但老书签不 404，直接落到告警页。
export const ROUTE_ALIASES = Object.freeze({ 'alerts-demo': 'alerts' });

/**
 * @param {string} id 页面 id
 * @param {string[]} [params] 附加段
 */
export function hashFor(id, params = []) {
  return `#/${[id, ...params].join('/')}`;
}

/**
 * hash → 页面。空 hash、未知 id 一律回落到总览，不抛错、不空白。
 * @param {string} hash 形如 `#/overview` 或 `#/alert-detail/intrusion:12`
 * @returns {{ page: typeof PAGES[number], params: string[] }}
 */
export function routeFromHash(hash) {
  const segments = String(hash || '')
    .replace(/^#\/?/, '')
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean);
  const [rawId, ...rawParams] = segments;
  const alias = ROUTE_ALIASES[rawId];
  const id = alias ?? rawId;
  const page = PAGES.find(candidate => candidate.id === id) ?? PAGES.find(candidate => candidate.id === DEFAULT_ROUTE);
  // 别名只落到页面本身，不带旧入口的参数；未知 id 回缺省页，参数同样丢弃。
  return { page, params: !alias && page.id === id ? rawParams : [] };
}
