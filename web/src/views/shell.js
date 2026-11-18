// 壳视图：196px 侧栏 + 52px 顶栏 + 内容槽。结构与断点来自设计稿 overview.html。
//
// 账号区（稿 `alerts.html:920-932` 的 `.who`）：头像 + 账号名 + 角色。
// 身份只从 `/api/session` 的 `user` / `role` 来（P003-T006 起有这两个字段，server.js:208-214）：
//   user 为 null（服务端没配密码）→ 整块不渲染，不编名字；
//   role 是机器值，`operator` 显示成稿上的「值守账号」，未知值原样显示。

import { NAV_PAGES, hashFor } from '../router.js';

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
  // 牧云现查（演示）沿用告警的图标：侧栏文案已经写明「演示」，不另造一枚看不懂的图标
  'alerts-demo': `<path d="M10 2.9 18 16.6H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
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

const ROLE_LABEL = { operator: '值守账号' };

const NAV = NAV_PAGES.map(page => `
  <a class="nav-item" href="${hashFor(page.id)}" data-route="${page.id}">
    <svg class="od-icon" viewBox="0 0 20 20" aria-hidden="true">${ICONS[page.id] ?? ''}</svg>
    <span class="label">${page.navLabel}</span>
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
      <div class="who" data-role="who" hidden>
        <span class="avatar" data-role="who-avatar" aria-hidden="true"></span>
        <span class="who-meta">
          <span class="who-name mono" data-role="who-name"></span>
          <span class="who-role" data-role="who-role"></span>
        </span>
      </div>
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
 * @param {{ onSignOut: () => void, themeToggle?: Element | null,
 *   identity?: { user: string|null, role: string|null } | null }} options
 *   identity 来自 `GET /api/session`；user 为空时账号区整块不渲染。
 */
export function mountShell({ onSignOut, themeToggle, identity = null }) {
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

  // 账号区：只在接口真的报了 user 时出现（不拿输入框里的账号名冒充身份）
  const user = typeof identity?.user === 'string' && identity.user.trim() ? identity.user.trim() : null;
  if (user) {
    const role = typeof identity.role === 'string' && identity.role.trim() ? identity.role.trim() : null;
    $('who').hidden = false;
    $('who-avatar').textContent = [...user][0].toUpperCase();
    $('who-name').textContent = user;
    $('who-role').textContent = role ? (ROLE_LABEL[role] ?? role) : '';
    $('who-role').hidden = role === null;
  }

  /** @param {{ id: string, title: string }} page */
  function setRoute(page) {
    title.textContent = page.title;
    for (const item of navItems) {
      const active = item.dataset.route === page.id;
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
      item.classList.toggle('is-active', active);
    }
  }

  return { element: host, setRoute, content };
}
