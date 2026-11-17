// src/views/login.js —— 登录视图状态矩阵（六格：默认/校验/加载/错误/超长/禁用；partial 不适用，见 README）
// 查询一律按 role + 可访问名，不按 id/class。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SessionError } from '../src/session.js';
import { mountLogin, bannerFor } from '../src/views/login.js';
import { byRole, flush, setupDom, text } from './dom.js';

let mounted = null;
let calls = [];

function mount(onAuthenticate = async () => ({ authenticated: true })) {
  calls = [];
  const recorded = credentials => { calls.push(credentials); return onAuthenticate(credentials); };
  mounted = mountLogin({ onAuthenticate: recorded, onSuccess: () => { mounted.succeeded = true; } });
  mounted.succeeded = false;
  document.body.append(mounted.element);
  return mounted;
}

const input = name => byRole(document, 'textbox', name);
const submit = () => byRole(document, 'button', '登录');
const banner = () => byRole(document, 'alert');

beforeEach(() => setupDom());

test('默认态：账号框自动获得焦点，按钮可用、文案「登录」，无错误横幅', async () => {
  mount();
  await flush();
  assert.equal(document.activeElement, input('账号'));
  assert.equal(submit().disabled, false);
  assert.equal(text(submit()), '登录');
  assert.equal(banner().hidden, true);
  assert.equal(input('账号').getAttribute('aria-invalid'), null);
});

test('校验：账号失焦且为空 → 红字提示 + aria-invalid；填上就清掉', () => {
  mount();
  input('账号').dispatchEvent(new window.Event('blur'));
  assert.equal(byRole(document, 'textbox', '账号').getAttribute('aria-invalid'), 'true');
  assert.equal(text(document.getElementById('username-error')), '请输入账号。');
  assert.equal(document.getElementById('username-error').hidden, false);

  input('账号').value = 'hids';
  input('账号').dispatchEvent(new window.Event('input'));
  assert.equal(input('账号').getAttribute('aria-invalid'), null);
  assert.equal(document.getElementById('username-error').hidden, true);
});

test('空表单提交：不发请求，焦点落在第一个缺的字段', () => {
  mount();
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.deepEqual(calls, []);
  assert.equal(document.activeElement, input('账号'));
});

test('加载态：按钮禁用、转圈可见、文案「正在登录…」，成功后回调 onSuccess', async () => {
  let release;
  mount(() => new Promise(resolve => { release = resolve; }));
  input('账号').value = 'hids';
  input('密码').value = 'secret';
  const button = submit();
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();

  assert.equal(button.disabled, true);
  assert.equal(text(button), '正在登录…');
  assert.equal(mounted.element.querySelector('[data-role="spinner"]').hidden, false);
  assert.equal(mounted.form.getAttribute('aria-busy'), 'true');
  assert.deepEqual(calls, [{ user: 'hids', password: 'secret' }]);

  release({ authenticated: true });
  await flush();
  assert.equal(mounted.succeeded, true);
});

test('禁用：登录中再点提交不会发第二次请求', async () => {
  let release;
  mount(() => new Promise(resolve => { release = resolve; }));
  input('账号').value = 'hids';
  input('密码').value = 'secret';
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();
  assert.equal(calls.length, 1);
  release({ authenticated: true });
  await flush();
});

test('401：横幅报「登录失败 / 账号或密码不正确」，清空密码、焦点回密码框、按钮恢复', async () => {
  mount(async () => { throw new SessionError('unauthorized', '账号或密码不正确', { status: 401 }); });
  input('账号').value = 'hids';
  input('密码').value = 'wrong';
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();

  assert.equal(banner().hidden, false);
  assert.match(text(banner()), /登录失败/);
  assert.match(text(banner()), /账号或密码不正确/);
  assert.equal(input('密码').value, '');
  assert.equal(document.activeElement, input('密码'));
  assert.equal(submit().disabled, false);
  assert.equal(mounted.succeeded, false);
});

test('连不上服务 → 警示色横幅「无法连接」，不是「账号或密码不正确」', async () => {
  mount(async () => { throw new SessionError('network', '连接不上服务'); });
  input('账号').value = 'hids';
  input('密码').value = 'secret';
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();

  assert.equal(banner().dataset.tone, 'warn');
  assert.match(text(banner()), /无法连接/);
  assert.doesNotMatch(text(banner()), /账号或密码不正确/);
});

test('服务异常（500）→ 横幅带状态码，用户知道不是自己输错了', async () => {
  mount(async () => { throw new SessionError('http', '服务返回 500', { status: 500 }); });
  input('账号').value = 'hids';
  input('密码').value = 'secret';
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();
  assert.match(text(banner()), /服务返回异常（500）/);
});

test('超长输入：200 字账号原样提交，不被截断也不崩', async () => {
  const longUser = 'a'.repeat(200);
  mount();
  input('账号').value = longUser;
  input('密码').value = 'secret';
  mounted.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user, longUser);
  assert.equal(input('账号').value, longUser);
});

test('密码显示/隐藏：按钮带 aria-pressed 与可访问名，切换输入框类型', () => {
  mount();
  const reveal = byRole(document, 'button', '显示');
  assert.equal(reveal.getAttribute('aria-pressed'), 'false');
  assert.equal(input('密码').type, 'password');

  reveal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(reveal.getAttribute('aria-pressed'), 'true');
  assert.equal(input('密码').type, 'text');
  assert.equal(text(reveal), '隐藏');
});

test('bannerFor：四种错误各有可区分的文案（不把技术细节甩给用户）', () => {
  assert.equal(bannerFor(new SessionError('unauthorized', 'x')).title, '登录失败');
  assert.equal(bannerFor(new SessionError('network', 'x')).tone, 'warn');
  assert.match(bannerFor(new SessionError('http', 'x', { status: 502 })).text, /502/);
  assert.doesNotMatch(bannerFor(new SessionError('invalid', 'x')).text, /JSON|fetch|status/);
});
