// 组装层：登录视图 ↔ 壳视图的切换、hash 路由、凭据记忆。
// 这是唯一知道「登录成功后去哪儿」的地方；视图本身不导航、不取数。

import { clearCredentials, setCredentials } from './credentials.js';
import { probeSession } from './session.js';
import { DEFAULT_ROUTE, hashFor, routeFromHash } from './router.js';
import { mountLogin } from './views/login.js';
import { mountShell } from './views/shell.js';
import { mountPlaceholder } from './views/placeholder.js';

const root = document.getElementById('root');
const themeToggle = document.querySelector('[data-theme-toggle]');

let shell = null;
let untrackHash = null;

function showLogin() {
  if (untrackHash) { untrackHash(); untrackHash = null; }
  shell = null;
  if (themeToggle) {
    themeToggle.classList.add('theme-toggle--float');
    document.body.append(themeToggle);
  }
  const login = mountLogin({
    onAuthenticate: async credentials => {
      const session = await probeSession(credentials);
      setCredentials(credentials);
      return session;
    },
    onSuccess: () => {
      window.location.hash = hashFor(DEFAULT_ROUTE);
      showShell();
    },
  });
  root.replaceChildren(login.element);
}

function showShell() {
  shell = mountShell({ onSignOut: signOut, themeToggle });

  const route = routeFromHash(window.location.hash);
  shell.setRoute(route);
  shell.content.replaceChildren(mountPlaceholder(route));

  function syncRoute() {
    const next = routeFromHash(window.location.hash);
    shell.setRoute(next);
    shell.content.replaceChildren(mountPlaceholder(next));
  }
  window.addEventListener('hashchange', syncRoute);
  untrackHash = () => window.removeEventListener('hashchange', syncRoute);

  root.replaceChildren(shell.element);
}

function signOut() {
  clearCredentials();
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  showLogin();
}

showLogin();
