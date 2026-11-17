// 壳视图：196px 侧栏 + 52px 顶栏 + 内容槽。结构与断点来自设计稿 overview.html。
//
// 账号区：稿里侧栏底部有「头像 + 账号名 + 角色」一块。会话接口（openapi.yaml:32-40 的
// GET /api/session）只返回 { authenticated: true }，没有账号名也没有角色，所以这一块**不渲染**——
// 不编名字、不拿输入框里的账号名充当身份（A3）。侧栏底部只留「退出登录」。

import { ROUTES, hashFor } from '../router.js';

const BRAND_MARK = `
  <svg class="rail-mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
    <path d="M14 2.6 24 8.3v11.4L14 25.4 4 19.7V8.3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    <path d="M9.4 11.4h9.2M9.4 14.6h9.2M11 17.8h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".85" />
  </svg>`;

const ICONS = {
  overview: `<rect x="2.8" y="2.8" width="6" height="6" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4" />
    <rect x="11.2" y="2.8" width="6" height="6" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4" />
    <rect x="2.8" y="11.2" width="6" height="6" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4" />
    <rect x="11.2" y="11.2" width="6" height="6" rx=".8" fill="none" stroke="currentColor" stroke-width="1.4" />`,
  alerts: `<path d="M10 2.9 18 16.6H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
    <path d="M10 7.6v3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <circle cx="10" cy="13.9" r=".9" fill="currentColor" />`,
  trace: `<circle cx="5" cy="5.4" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4" />
    <circle cx="15" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4" />
    <circle cx="8" cy="15" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4" />
    <path d="M6.9 6.7 13 7.3M6 7.4l1.4 5.3M13.6 9.6l-3.7 3.6" stroke="currentColor" stroke-width="1.3" />`,
  rules: `<path d="M3 6h14M3 13.2h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <circle cx="7.4" cy="6" r="1.9" fill="none" stroke="currentColor" stroke-width="1.4" />
    <circle cx="13" cy="13.2" r="1.9" fill="none" stroke="currentColor" stroke-width="1.4" />`,
  wiki: `<path d="M3.4 4.4c2.6-1 4.8-.7 6.6.7 1.8-1.4 4-1.7 6.6-.7v10.3c-2.6-1-4.8-.7-6.6.7-1.8-1.4-4-1.7-6.6-.7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
    <path d="M10 5.4v9.6" stroke="currentColor" stroke-width="1.3" />`,
  signout: `<path d="M8 3.4H4.6v13.2H8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M11.4 10h5.2M14 7.4 16.6 10 14 12.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />`,
};

const NAV = ROUTES.map(route => `
  <a class="nav-item" href="${hashFor(route.id)}" data-route="${route.id}">
    <svg class="od-icon" viewBox="0 0 20 20" aria-hidden="true">${ICONS[route.id]}</svg>
    <span class="label">${route.label}</span>
  </a>`).join('');

const TEMPLATE = `
<div class="app">
  <aside class="rail">
    <div class="rail-brand">
      ${BRAND_MARK}
      <span class="od-field">
        <span class="rail-name">HIDS</span>
        <span class="rail-sub">AI 研判平台</span>
      </span>
    </div>

    <nav class="nav" aria-label="主导航">${NAV}</nav>

    <div class="rail-foot">
      <button type="button" class="nav-item" data-role="signout">
        <svg class="od-icon" viewBox="0 0 20 20" aria-hidden="true">${ICONS.signout}</svg>
        <span class="label">退出登录</span>
      </button>
    </div>
  </aside>

  <div class="main">
    <header class="bar">
      <h1 data-role="page-title">总览</h1>
      <div class="bar-right" data-role="bar-right"></div>
    </header>
    <div class="content" data-role="content"></div>
  </div>
</div>`;

/**
 * 挂载壳。
 * @param {{ onSignOut: () => void, themeToggle?: Element | null }} options
 */
export function mountShell({ onSignOut, themeToggle }) {
  const host = document.createElement('div');
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);

  const title = $('page-title');
  const content = $('content');
  const navItems = [...host.querySelectorAll('.nav-item[data-route]')];

  if (themeToggle) {
    themeToggle.classList.remove('theme-toggle--float');
    $('bar-right').append(themeToggle);
  }

  $('signout').addEventListener('click', onSignOut);

  /** @param {{ id: string, title: string }} route */
  function setRoute(route) {
    title.textContent = route.title;
    for (const item of navItems) {
      const active = item.dataset.route === route.id;
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
      item.classList.toggle('is-active', active);
    }
  }

  return { element: host, setRoute, content };
}
