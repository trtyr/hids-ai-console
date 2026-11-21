// src/router.js —— 侧栏入口与 hash 解析（页面模块住在 web/pages/）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ROUTE, NAV_PAGES, PAGES, hashFor, routeFromHash } from '../src/router.js';

test('侧栏五个入口（P003-T026 起不再有「牧云现查（演示）」）', () => {
  assert.deepEqual(NAV_PAGES.map(page => page.navLabel), ['总览', '告警', '深度溯源', '规则', '知识库']);
  assert.deepEqual(NAV_PAGES.map(page => page.id), ['overview', 'alerts', 'trace', 'rules', 'knowledge']);
});

test('八张页面各有一个模块文件，告警详情 / 溯源白板 / 程序门禁不在侧栏但可路由', () => {
  assert.deepEqual(PAGES.map(page => page.id),
    ['overview', 'alerts', 'alert-detail', 'trace', 'trace-board', 'rules', 'rules-gate', 'knowledge']);
  for (const id of ['alert-detail', 'trace-board', 'rules-gate']) {
    const hidden = PAGES.find(page => page.id === id);
    assert.equal(hidden.navLabel, null, `${id} 不该进侧栏`);
    assert.equal(NAV_PAGES.includes(hidden), false);
  }
  for (const page of PAGES) assert.equal(typeof page.render, 'function', `${page.id} 缺 render`);
});

test('A1：规则进去先是列表——`#/rules` 落在规则页、params 为空，`#/rules/<id>` 把 id 原样交给它', () => {
  assert.equal(routeFromHash('#/rules').page.id, 'rules');
  assert.deepEqual(routeFromHash('#/rules').params, []);
  const detail = routeFromHash('#/rules/ssh_bruteforce');
  assert.equal(detail.page.id, 'rules');
  assert.deepEqual(detail.params, ['ssh_bruteforce']);
  assert.equal(PAGES.find(page => page.id === 'rules').navLabel, '规则');
  // 旧程序门禁编辑页搬到隐藏路由，不进侧栏
  assert.equal(routeFromHash('#/rules-gate').page.id, 'rules-gate');
});

test('A1：溯源进去先是列表——`#/trace` 落在列表页，`#/trace-board/<ID>` 才是这一条的白板', () => {
  assert.equal(routeFromHash('#/trace').page.id, 'trace');
  const board = routeFromHash('#/trace-board/revshell:1');
  assert.equal(board.page.id, 'trace-board');
  assert.deepEqual(board.params, ['revshell:1']);
  assert.equal(PAGES.find(page => page.id === 'trace').navLabel, '深度溯源');
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

test('P003-T026：旧入口 #/alerts-demo 不再是产品入口，但老书签回落到告警页', () => {
  const legacy = routeFromHash('#/alerts-demo');
  assert.equal(legacy.page.id, 'alerts');
  assert.deepEqual(legacy.params, []);
  assert.equal(PAGES.some(page => page.id === 'alerts-demo'), false);
  assert.equal(NAV_PAGES.some(page => page.id === 'alerts-demo'), false);
});

test('未知 hash → 回落到总览，不抛错、不空白', () => {
  const fallback = routeFromHash('#/nope');
  assert.equal(fallback.page.id, DEFAULT_ROUTE);
  assert.deepEqual(fallback.params, []);
});
