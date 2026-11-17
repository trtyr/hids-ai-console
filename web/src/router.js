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
import { page as trace } from '../pages/trace.js';

/** 全部页面。顺序即侧栏顺序（navLabel 为空的不进侧栏）。 */
export const PAGES = [overview, alerts, alertDetail, trace, rules, knowledge];

/** 侧栏上的入口：总览 / 告警 / 深度溯源 / 规则 / 知识库 */
export const NAV_PAGES = PAGES.filter(page => page.navLabel);

export const DEFAULT_ROUTE = 'overview';

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
  const [id, ...params] = segments;
  const page = PAGES.find(candidate => candidate.id === id) ?? PAGES.find(candidate => candidate.id === DEFAULT_ROUTE);
  return { page, params: page.id === id ? params : [] };
}
