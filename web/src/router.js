// 哈希路由：五页导航（设计稿 overview.html 的侧栏顺序与文案）。
// 未知 hash 回落到总览——不抛错、不空白。

/** @typedef {{ id: string, label: string, title: string }} Route */

/** @type {Route[]} */
export const ROUTES = [
  { id: 'overview', label: '总览', title: '总览' },
  { id: 'alerts', label: '告警', title: '告警' },
  { id: 'trace', label: '深度溯源', title: '深度溯源' },
  { id: 'rules', label: '规则', title: '规则' },
  { id: 'wiki', label: '知识库', title: '知识库' },
];

export const DEFAULT_ROUTE = 'overview';

/** @param {string} id */
export function hashFor(id) {
  return `#/${id}`;
}

/**
 * hash → 路由。空 hash、未知 hash、只有 `#/` 都回落到总览。
 * @param {string} hash 形如 `#/alerts`
 * @returns {Route}
 */
export function routeFromHash(hash) {
  const id = String(hash || '').replace(/^#\/?/, '').trim();
  return ROUTES.find(route => route.id === id) ?? ROUTES.find(route => route.id === DEFAULT_ROUTE);
}
