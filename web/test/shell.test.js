// src/views/shell.js + placeholder.js —— 壳的导航、标题、无身份渲染（A3）、空页占位
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { NAV_PAGES, PAGES, hashFor, routeFromHash } from '../src/router.js';
import { mountShell } from '../src/views/shell.js';
import { allByRole, byRole, setupDom, text } from './dom.js';

let shell = null;
let signOuts = 0;

function mount(identity = null) {
  signOuts = 0;
  shell = mountShell({ onSignOut: () => { signOuts += 1; }, identity });
  document.body.append(shell.element);
  return shell;
}

const navLinks = () => allByRole(document, 'link');

beforeEach(() => setupDom());

test('侧栏五个入口：可访问名与 href 一一对应（总览/告警/深度溯源/规则/知识库）', () => {
  mount();
  const links = navLinks().filter(link => link.getAttribute('href')?.startsWith('#/'));
  assert.deepEqual(links.map(link => text(link)), NAV_PAGES.map(page => page.navLabel));
  assert.deepEqual(links.map(link => link.getAttribute('href')), NAV_PAGES.map(page => hashFor(page.id)));
});

test('setRoute：只有当前项带 aria-current="page"，顶栏标题跟着换', () => {
  mount();
  shell.setRoute(routeFromHash('#/alerts').page);
  const links = navLinks();
  const active = links.filter(link => link.getAttribute('aria-current') === 'page');
  assert.equal(active.length, 1);
  assert.equal(text(active[0]), '告警');
  assert.equal(text(byRole(document, 'heading', '告警')), '告警');

  shell.setRoute(routeFromHash('#/knowledge').page);
  const next = navLinks().filter(link => link.getAttribute('aria-current') === 'page');
  assert.equal(next.length, 1);
  assert.equal(text(next[0]), '知识库');
});

test('A5：会话报回账号名与角色时，侧栏底部显示账号区（头像 + 名字 + 角色）', () => {
  mount({ user: 'ops', role: 'operator' });
  const rail = byRole(document, 'navigation').closest('aside');
  const copy = text(rail);
  assert.match(copy, /ops/);
  assert.match(copy, /值守账号/);
  const who = rail.querySelector('[data-role="who"]');
  assert.equal(who.hidden, false);
  assert.equal(text(who.querySelector('[data-role="who-avatar"]')), 'O');
});

test('A5：没有身份（服务端未配密码 → user=null）时账号区不渲染，不编名字', () => {
  mount();
  const rail = byRole(document, 'navigation').closest('aside');
  const copy = text(rail);
  assert.doesNotMatch(copy, /值守|admin/);
  assert.equal(rail.querySelector('[data-role="who"]').hidden, true);
  // 底栏只剩退出登录这一个动作
  assert.ok(byRole(document, 'button', '退出登录'));
});

test('A5：role 是机器值，未知值原样显示（不编中文）；role 缺失时不画角色行', () => {
  mount({ user: 'audit', role: 'auditor' });
  const rail = byRole(document, 'navigation').closest('aside');
  assert.equal(text(rail.querySelector('[data-role="who-name"]')), 'audit');
  assert.equal(text(rail.querySelector('[data-role="who-role"]')), 'auditor');

  setupDom();
  mount({ user: 'ops', role: null });
  const again = byRole(document, 'navigation').closest('aside');
  assert.equal(again.querySelector('[data-role="who-role"]').hidden, true);
});

test('退出登录：点一下回调一次', () => {
  mount();
  byRole(document, 'button', '退出登录').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(signOuts, 1);
});

test('每页渲染：六个页面都能渲染出一个根节点，不抛错', () => {
  mount();
  for (const page of PAGES) {
    assert.doesNotThrow(() => page.render(shell.content, { params: [] }), `${page.id} 渲染抛错了`);
    assert.equal(shell.content.children.length, 1, `${page.id} 渲染后内容区应只有一个根节点`);
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
