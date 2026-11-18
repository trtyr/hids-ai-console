// pages/rules.js —— Rego 规则列表页（P003-T017 / D017）：A1 五列 + 六格状态 + A3 无可编辑控件
// 字段一律照接口真名（RegoRuleSummary：id / name / description / file，openapi.yaml:1839-1847）。
// 效果 / 开没开 / 从哪来三列是**展示默认值**，接口没有这三项——断言里把口径钉死，防止有人「顺手」从接口读假字段。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DISPLAY_DEFAULTS, DISPLAY_HINTS, mountRulesPage, page, ruleHref } from '../../pages/rules.js';
import { RegoRulesError, describeRegoRulesError } from '../../src/rego-rules.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
  globalThis.window.location.hash = '';
});

/** 列表项：RegoRuleSummary 的真形状（只有四个键） */
const summary = (overrides = {}) => ({
  id: 'ssh_bruteforce', name: 'SSH 暴力破解来源',
  description: '登录类告警里来源 IP 非空、命令含 ssh 的，列为需要人工复核的候选',
  file: 'ssh_bruteforce.rego', ...overrides,
});

const respond = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/** 一次挂载 + 可控的 fetch 队列（最后一条一直复用）；calls 供断言 */
function mountWith(replies, options = {}) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(String(url), init);
    return next;
  };
  const host = mountRulesPage({ fetchImpl, ...options });
  document.body.append(host);
  return { host, calls };
}

const rows = host => [...host.querySelectorAll('tbody tr')];
const cells = row => [...row.querySelectorAll('td')];

// ---------- A1：进去是列表，列有名字、一句话、效果、开没开、从哪来 ----------

test('A1：进去先是表——五列表头依次是 名字 / 一句话 / 效果 / 开没开 / 从哪来，没有编辑器', async () => {
  const { host } = mountWith([respond({ count: 1, rules: [summary()] })]);
  await flush();
  assert.deepEqual([...host.querySelectorAll('thead th')].map(text),
    ['名字', '一句话', '效果', '开没开', '从哪来']);
  // 旧程序门禁编辑器的两块都不在这里（P003-T017 搬到 #/rules-gate）
  assert.equal(host.querySelector('section[aria-label="规则配置编辑器"]'), null);
  assert.equal(host.querySelector('aside[aria-label="规则操作"]'), null);
});

test('A1：五列逐格对字段——名字 / 一句话 / 效果「放行」 / 开没开「开」 / 从哪来「未标注」', async () => {
  const { host } = mountWith([respond({
    count: 2,
    rules: [summary(), summary({ id: 'webshell_drop', name: 'WebShell 落地脚本', description: null, file: 'webshell_drop.rego' })],
  })]);
  await flush();
  const [first, second] = rows(host).map(cells);

  assert.equal(text(first[0]), 'SSH 暴力破解来源');
  assert.equal(text(first[1]), summary().description);
  assert.equal(text(first[2]), '放行');
  assert.equal(text(first[3]), '开');
  assert.equal(text(first[4]), '未标注');

  // description 为 null（`# description:` 可选）：写「未写说明」，不空着、不编一句
  assert.equal(text(second[1]), '未写说明');
});

test('三列展示默认值有口径说明（title 挂着为什么，不让「开」「未标注」变成没头没尾的字）', async () => {
  const { host } = mountWith([respond({ count: 1, rules: [summary()] })]);
  await flush();
  const [first] = rows(host).map(cells);
  assert.equal(first[2].querySelector('.chip').getAttribute('title'), DISPLAY_HINTS.effect);
  assert.equal(first[3].querySelector('.state-on').getAttribute('title'), DISPLAY_HINTS.enabled);
  assert.equal(first[4].querySelector('.cell-text').getAttribute('title'), DISPLAY_HINTS.source);
  // 页面底部还有一行同口径的脚注
  assert.match(text(host.querySelector('[data-role="note"]')), /展示默认/);
});

// ---------- A2 的入口：点名字进这一条的原文 ----------

test('A2：名字是去原文页的真链接（`#/rules/<id>`），整行点击也跳过去', async () => {
  const { host } = mountWith([respond({ count: 1, rules: [summary()] })]);
  await flush();
  const link = host.querySelector('.rule-link');
  assert.equal(link.getAttribute('href'), '#/rules/ssh_bruteforce');
  assert.equal(link.getAttribute('aria-label'), '打开规则 SSH 暴力破解来源 的 Rego 原文');
  assert.equal(ruleHref('ssh_bruteforce'), '#/rules/ssh_bruteforce');

  rows(host)[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(globalThis.window.location.hash, '#/rules/ssh_bruteforce');
});

test('A2：行里的文件名留在 title（表上不占一列，信息不丢）', async () => {
  const { host } = mountWith([respond({ count: 1, rules: [summary()] })]);
  await flush();
  assert.match(host.querySelector('.rule-link').getAttribute('title'), /ssh_bruteforce\.rego$/);
});

// ---------- A3：这轮页面上不能编辑 ----------

test('A3：列表页没有任何可编辑控件（input / textarea / select / contenteditable 全无）', async () => {
  const { host } = mountWith([respond({ count: 2, rules: [summary(), summary({ id: 'honeypot' })] })]);
  await flush();
  assert.equal(host.querySelector('input, textarea, select, [contenteditable]'), null);
  // 页面上只有「刷新」；另一个按钮是隐藏的刷新失败条里的「重试」（没有失败就不出现）
  assert.deepEqual([...host.querySelectorAll('button')].map(text).sort(), ['刷新', '重试'].sort());
  assert.equal(host.querySelector('[data-role="notice"]').hidden, true);
  assert.equal(host.querySelector('button[type="submit"]'), null);
  for (const label of ['保存', '编辑', '提交', '删除', '新增']) {
    assert.equal(host.textContent.includes(label), false, `页面上不该出现「${label}」`);
  }
});

// ---------- 展示默认值 vs 接口字段：不偷读 ----------

test('服务端哪天多给 effect / enabled / source / updated_at，页面也不认（三列是展示默认，不是接口字段）', async () => {
  const { host } = mountWith([respond({
    count: 1,
    rules: [{ ...summary(), effect: '阻断', enabled: false, source: 'false_positive', updated_at: '2026-11-01' }],
  })]);
  await flush();
  const [first] = rows(host).map(cells);
  assert.equal(text(first[2]), DISPLAY_DEFAULTS.effect);
  assert.equal(text(first[3]), DISPLAY_DEFAULTS.enabled);
  assert.equal(text(first[4]), DISPLAY_DEFAULTS.source);
  assert.equal(host.textContent.includes('2026-11-01'), false, '接口没定的列不许偷偷显示');
});

// ---------- 六格状态矩阵 ----------

test('格 1 loading：表里写正在读取、区域标 aria-busy、刷新禁用、共 N 条是「—」', async () => {
  const pending = new Promise(() => {});
  const { host } = mountWith([async () => pending]);
  await flush();
  assert.match(text(host), /正在读取规则库/);
  assert.equal(host.querySelector('[data-role="table-wrap"]').getAttribute('aria-busy'), 'true');
  assert.equal(host.querySelector('[data-role="refresh"]').disabled, true);
  assert.equal(text(host.querySelector('[data-role="total"]')), '—');
});

test('格 1 loading：读完之后刷新可用、aria-busy 摘掉', async () => {
  const { host } = mountWith([respond({ count: 0, rules: [] })]);
  await flush();
  assert.equal(host.querySelector('[data-role="refresh"]').disabled, false);
  assert.equal(host.querySelector('[data-role="table-wrap"]').hasAttribute('aria-busy'), false);
});

test('格 2 empty：200 + {count: 0, rules: []} 写「规则库还没有规则」，共 0 条，不摆失败块', async () => {
  const { host } = mountWith([respond({ count: 0, rules: [] })]);
  await flush();
  assert.match(text(host), /规则库还没有规则/);
  assert.equal(text(host.querySelector('[data-role="total"]')), '0');
  assert.equal(host.querySelector('.page-error'), null);
});

test('格 3 partial：刷新失败但表里还有规则——挂提示、保留上一次的行', async () => {
  const { host } = mountWith([
    respond({ count: 1, rules: [summary()] }),
    respond({ error: '规则库读取失败：rules/ssh_bruteforce.rego:3: 缺少 # name: 显示名' }, 502),
  ]);
  await flush();
  host.querySelector('[data-role="refresh"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();

  assert.equal(host.querySelector('[data-role="notice"]').hidden, false);
  assert.match(text(host.querySelector('[data-role="notice"]')), /ssh_bruteforce\.rego:3/);
  assert.equal(rows(host).length, 1, '提示归提示，行不能没');
  assert.equal(text(cells(rows(host)[0])[0]), 'SSH 暴力破解来源');
});

test('格 4 error：首次就 502——整块失败写服务端原话（带 rules/<文件>:<行>），重试成功后换成表', async () => {
  const { host, calls } = mountWith([
    respond({ error: '规则库读取失败：rules/broken.rego:7: 不支持的表达式：foo bar' }, 502),
    respond({ count: 1, rules: [summary()] }),
  ]);
  await flush();

  const block = host.querySelector('.page-error');
  assert.ok(block, '应摆整块失败');
  assert.equal(text(block.querySelector('strong')), '规则库读取失败');
  assert.match(text(block), /rules\/broken\.rego:7/, '定位信息一个字都不能丢');
  assert.equal(host.querySelector('[role="status"]').textContent.includes('规则库读取失败'), true);

  block.querySelector('.btn-primary').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(host.querySelector('.page-error'), null);
  assert.equal(rows(host).length, 1);
});

test('格 4 error：401 文案是「登录已失效」，不是服务端纯文本', async () => {
  const { host } = mountWith([respond({ error: '需要登录后访问' }, 401)]);
  await flush();
  assert.match(text(host.querySelector('.page-error')), /登录已失效/);
});

test('格 5 long-content：超长名字 / 一句话全文进 DOM（od-truncate 只视觉截断，title 留全文）', async () => {
  const longName = '很长的规则名字'.repeat(20);
  const longWhat = '这句话在限制什么'.repeat(30);
  const { host } = mountWith([respond({ count: 1, rules: [summary({ name: longName, description: longWhat })] })]);
  await flush();
  const [first] = rows(host).map(cells);
  assert.equal(text(first[0]), longName);
  assert.equal(first[0].querySelector('a').getAttribute('title'), `${longName} · ssh_bruteforce.rego`);
  assert.equal(text(first[1]), longWhat);
  assert.equal(first[1].querySelector('span').getAttribute('title'), longWhat);
});

test('格 6 disabled：请求在飞时刷新禁用且转圈，读完恢复', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { host } = mountWith([async () => {
    await gate;
    return respond({ count: 0, rules: [] });
  }]);
  await flush();
  const refresh = host.querySelector('[data-role="refresh"]');
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.classList.contains('is-loading'), true);

  release();
  await flush();
  assert.equal(refresh.disabled, false);
  assert.equal(refresh.classList.contains('is-loading'), false);
});

// ---------- 错误文案 ----------

test('describeRegoRulesError：四类 kind 各说各的，http 用服务端原话，未知错误不漏', () => {
  assert.equal(describeRegoRulesError(new RegoRulesError('unauthorized', '登录已失效，请重新登录')), '登录已失效，请重新登录。');
  assert.equal(describeRegoRulesError(new RegoRulesError('network', '连接不上研判服务')), '连接不上研判服务。');
  assert.equal(describeRegoRulesError(new RegoRulesError('invalid', '规则列表接口没有返回 count / rules')), '规则接口返回的形状不对。');
  assert.equal(describeRegoRulesError(new RegoRulesError('http', '规则库读取失败：rules/a.rego:1: 缺少 package')), '规则库读取失败：rules/a.rego:1: 缺少 package');
  assert.equal(describeRegoRulesError(new Error('别的东西')), '别的东西');
});

// ---------- 页面契约：一个模块两屏 ----------

test('page.render：`#/rules` 出列表，`#/rules/<id>` 出原文（路由只认第一段，参数原样交回来）', async () => {
  const replies = [
    respond({ count: 1, rules: [summary()] }),
    respond({ ...summary(), rego: 'package hids.rules.ssh_bruteforce\n' }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => replies.shift() ?? respond({ count: 0, rules: [] });
  try {
    const content = document.createElement('div');
    page.render(content, { params: [] });
    await flush();
    assert.equal(content.children.length, 1);
    assert.ok(content.querySelector('.rego-rules'), '没有参数是列表');

    page.render(content, { params: ['ssh_bruteforce'] });
    await flush();
    assert.equal(content.children.length, 1);
    assert.ok(content.querySelector('.rego-detail'), '带 id 是原文页');
    assert.equal(page.id, 'rules');
    assert.equal(page.navLabel, '规则');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
