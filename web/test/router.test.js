// src/router.js —— 侧栏五个入口与 hash 解析
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ROUTE, ROUTES, hashFor, routeFromHash } from '../src/router.js';

test('五个导航入口，顺序与文案照设计稿（总览/告警/深度溯源/规则/知识库）', () => {
  assert.deepEqual(ROUTES.map(route => route.label), ['总览', '告警', '深度溯源', '规则', '知识库']);
  assert.deepEqual(ROUTES.map(route => route.id), ['overview', 'alerts', 'trace', 'rules', 'wiki']);
  assert.deepEqual(ROUTES.map(route => route.title), ['总览', '告警', '深度溯源', '规则', '知识库']);
});

test('hashFor 与 routeFromHash 往返一致（每个入口都点得回去）', () => {
  for (const route of ROUTES) {
    assert.equal(routeFromHash(hashFor(route.id)).id, route.id);
  }
});

test('空 hash / 只有 #/ → 总览', () => {
  assert.equal(routeFromHash('').id, DEFAULT_ROUTE);
  assert.equal(routeFromHash('#').id, DEFAULT_ROUTE);
  assert.equal(routeFromHash('#/').id, DEFAULT_ROUTE);
});

test('未知 hash → 回落到总览，不抛错、不空白', () => {
  assert.equal(routeFromHash('#/nope').id, DEFAULT_ROUTE);
  assert.equal(routeFromHash('#/alerts/detail').id, DEFAULT_ROUTE);
});
