// 单测用的 DOM 环境与查询小工具。
// 查询按「用户怎么找到它」来写：role + 可访问名，不按 class / id（改类名不该让测试红）。

import { JSDOM } from 'jsdom';

/** 起一个干净的 jsdom，并把 document/window 挂成全局（视图模块直接用 document）。 */
export function setupDom(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.TextEncoder = dom.window.TextEncoder ?? TextEncoder;
  return dom;
}

/** 文本规整：折叠空白，去掉首尾空格 */
export function text(node) {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 可访问名：aria-labelledby > aria-label > <label for> > 自身文本 */
export function accessibleName(element) {
  if (!element) return '';
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy.split(/\s+/).map(id => text(element.ownerDocument.getElementById(id))).join(' ').trim();
  }
  const aria = element.getAttribute('aria-label');
  if (aria) return aria.trim();
  const doc = element.ownerDocument;
  if (element.id) {
    const label = doc.querySelector(`label[for="${element.id}"]`);
    if (label) return text(label);
  }
  const wrapping = element.closest('label');
  if (wrapping) return text(wrapping);
  return text(element);
}

/**
 * 按 role + 可访问名找节点（找不到返回 null）。
 * @param {Element} host
 * @param {'button'|'link'|'textbox'|'alert'|'navigation'|'region'|'heading'} role
 * @param {string|RegExp} [name]
 */
export function byRole(host, role, name) {
  const matches = allByRole(host, role, name);
  if (matches.length > 1) throw new Error(`role=${role} name=${name} 命中 ${matches.length} 个，查询不唯一`);
  return matches[0] ?? null;
}

export function allByRole(host, role, name) {
  const candidates = roleCandidates(host, role);
  return candidates.filter(element => {
    if (name === undefined) return true;
    const value = accessibleName(element);
    return name instanceof RegExp ? name.test(value) : value === name;
  });
}

function roleCandidates(host, role) {
  const doc = host.ownerDocument ?? host;
  switch (role) {
    case 'button':
      return [...doc.querySelectorAll('button, [role="button"]')];
    case 'link':
      return [...doc.querySelectorAll('a[href], [role="link"]')];
    case 'textbox':
      return [...doc.querySelectorAll('input:not([type]), input[type="text"], input[type="password"], input[type="search"], input[type="email"], textarea, [role="textbox"]')];
    case 'alert':
      return [...doc.querySelectorAll('[role="alert"], [role="status"]')];
    case 'navigation':
      return [...doc.querySelectorAll('nav, [role="navigation"]')];
    case 'heading':
      return [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
    default:
      throw new Error(`未支持的 role：${role}`);
  }
}

/** 让异步渲染/微任务跑完（不依赖真实时钟） */
export function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
