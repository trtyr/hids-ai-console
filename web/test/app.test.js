// src/app.js —— 组装层的可见后果：登录成功进壳时内容区**只渲染一次**。
// 回归来源：复审/测试席实测报告「进壳 syncRoute 仍渲染两次」——
// 原来 onSuccess 赋 `location.hash` 会再排一个 hashchange，进壳后又渲染一遍。
// 对 T002+ 的真实页面来说就是「一进页面就发两轮请求」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { page as overview } from '../pages/overview.js';
import { flush, setupDom } from './dom.js';

test('登录成功进壳：总览只渲染一次，hash 落在 #/overview', async () => {
  setupDom(`<!doctype html><html><body>
    <div id="root"></div>
    <button class="theme-toggle" data-theme-toggle>浅色</button>
  </body></html>`);

  const renders = [];
  const original = overview.render;
  overview.render = function counting(content, context) {
    renders.push(window.location.hash);
    return original.call(this, content, context);
  };

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ authenticated: true }) });

  try {
    await import('../src/app.js');
    await flush();

    const username = document.querySelector('#username');
    const password = document.querySelector('#password');
    assert.ok(username && password, '启动后应停在登录页');
    username.value = 'hids';
    password.value = 'hids-2026';
    document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await flush();
    await flush();

    assert.equal(window.location.hash, '#/overview');
    assert.ok(document.querySelector('.app'), '壳应已挂载');
    assert.equal(renders.length, 1, `进壳时内容区渲染了 ${renders.length} 次，应恰好 1 次`);
  } finally {
    overview.render = original;
    delete globalThis.fetch;
  }
});
