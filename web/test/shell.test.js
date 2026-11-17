// src/views/shell.js + placeholder.js —— 壳的导航、标题、无身份渲染（A3）、空页占位
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTES, hashFor, routeFromHash } from '../src/router.js';
import { mountPlaceholder } from '../src/views/placeholder.js';
import { mountShell } from '../src/views/shell.js';
import { allByRole, byRole, setupDom, text } from './dom.js';

let shell = null;
let signOuts = 0;

function mount() {
  signOuts = 0;
  shell = mountShell({ onSignOut: () => { signOuts += 1; } });
  document.body.append(shell.element);
  return shell;
}

const navLinks = () => allByRole(document, 'link');

beforeEach(() => setupDom());

test('侧栏五个入口：可访问名与 href 一一对应（总览/告警/深度溯源/规则/知识库）', () => {
  mount();
  const links = navLinks().filter(link => link.getAttribute('href')?.startsWith('#/'));
  assert.deepEqual(links.map(link => text(link)), ROUTES.map(route => route.label));
  assert.deepEqual(links.map(link => link.getAttribute('href')), ROUTES.map(route => hashFor(route.id)));
});

test('setRoute：只有当前项带 aria-current="page"，顶栏标题跟着换', () => {
  mount();
  shell.setRoute(routeFromHash('#/alerts'));
  const links = navLinks();
  const active = links.filter(link => link.getAttribute('aria-current') === 'page');
  assert.equal(active.length, 1);
  assert.equal(text(active[0]), '告警');
  assert.equal(text(byRole(document, 'heading', '告警')), '告警');

  shell.setRoute(routeFromHash('#/wiki'));
  const next = navLinks().filter(link => link.getAttribute('aria-current') === 'page');
  assert.equal(next.length, 1);
  assert.equal(text(next[0]), '知识库');
});

test('A3：会话接口没有账号名/角色 → 壳里不出现任何账号名或角色', () => {
  mount();
  const rail = byRole(document, 'navigation').closest('aside');
  const copy = text(rail);
  assert.doesNotMatch(copy, /账号|角色|值守|admin/);
  assert.equal(rail.querySelector('.avatar, .who'), null);
  // 底栏只剩退出登录这一个动作
  assert.ok(byRole(document, 'button', '退出登录'));
});

test('退出登录：点一下回调一次', () => {
  mount();
  byRole(document, 'button', '退出登录').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(signOuts, 1);
});

test('空页占位：每页都说清「尚未接入」，不画假数据、不放假按钮', () => {
  mount();
  for (const route of ROUTES) {
    const placeholder = mountPlaceholder(route);
    assert.match(text(placeholder), new RegExp(`${route.label}尚未接入`));
    assert.equal(placeholder.querySelectorAll('button, table, input').length, 0);
    shell.content.replaceChildren(placeholder);
    assert.equal(shell.content.children.length, 1);
  }
});

test('主题切换按钮被移进顶栏（同一个节点，不额外造一个）', () => {
  const toggle = document.createElement('button');
  toggle.setAttribute('data-theme-toggle', '');
  toggle.className = 'theme-toggle theme-toggle--float';
  toggle.textContent = '浅色';
  document.body.append(toggle);

  shell = mountShell({ onSignOut: () => {}, themeToggle: toggle });
  document.body.append(shell.element);
  const bar = shell.element.querySelector('.bar');
  assert.equal(bar.contains(toggle), true);
  assert.equal(toggle.classList.contains('theme-toggle--float'), false);
  assert.equal(document.querySelectorAll('[data-theme-toggle]').length, 1);
});
