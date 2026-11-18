// src/router.js —— 侧栏入口与 hash 解析（页面模块住在 web/pages/）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ROUTE, NAV_PAGES, PAGES, hashFor, routeFromHash } from '../src/router.js';

test('侧栏六个入口，顺序与文案照设计稿 + P003-T015 的演示入口（牧云现查标成演示）', () => {
  assert.deepEqual(NAV_PAGES.map(page => page.navLabel), ['总览', '告警', '牧云现查（演示）', '深度溯源', '规则', '知识库']);
  assert.deepEqual(NAV_PAGES.map(page => page.id), ['overview', 'alerts', 'alerts-demo', 'trace', 'rules', 'knowledge']);
});

test('七张页面各有一个模块文件，告警详情不在侧栏但可路由', () => {
  assert.deepEqual(PAGES.map(page => page.id), ['overview', 'alerts', 'alerts-demo', 'alert-detail', 'trace', 'rules', 'knowledge']);
  const detail = PAGES.find(page => page.id === 'alert-detail');
  assert.equal(detail.navLabel, null);
  assert.equal(NAV_PAGES.includes(detail), false);
  for (const page of PAGES) assert.equal(typeof page.render, 'function', `${page.id} 缺 render`);
});

test('hashFor 与 routeFromHash 往返一致（每个入口都点得回去）', () => {
  for (const page of NAV_PAGES) {
    assert.equal(routeFromHash(hashFor(page.id)).page.id, page.id);
  }
});

test('告警详情带参数：第二段起原样交给页面', () => {
  const { page, params } = routeFromHash('#/alert-detail/intrusion:12');
  assert.equal(page.id, 'alert-detail');
  assert.deepEqual(params, ['intrusion:12']);
});

test('空 hash / 只有 #/ → 总览', () => {
  assert.equal(routeFromHash('').page.id, DEFAULT_ROUTE);
  assert.equal(routeFromHash('#').page.id, DEFAULT_ROUTE);
  assert.equal(routeFromHash('#/').page.id, DEFAULT_ROUTE);
});

test('未知 hash → 回落到总览，不抛错、不空白', () => {
  const fallback = routeFromHash('#/nope');
  assert.equal(fallback.page.id, DEFAULT_ROUTE);
  assert.deepEqual(fallback.params, []);
});
