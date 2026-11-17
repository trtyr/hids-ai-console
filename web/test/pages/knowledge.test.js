// pages/knowledge.js —— 知识库页：六格状态矩阵 + 列表/条目/编辑三屏交互 + 可访问性
import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { page } from '../../pages/knowledge.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { DRAFTS_KEY } from '../../src/knowledge.js';
import { allByRole, byRole, setupDom, text } from '../dom.js';

const DIRECTORY = {
  pages: [
    { path: 'index.md', id: 'index', title: 'HIDS 研判知识库', status: 'active', updated: '2026-11-09', revision: 'r-index', characters: 1332 },
    { path: 'common/GEN-12.md', id: 'GEN-12', title: '研判通则', status: 'active', updated: '2026-11-09', revision: 'c9dacfa538de0828', characters: 1028 },
    { path: 'common/GEN-07.md', id: 'GEN-07', title: '证据核验清单', status: 'draft', updated: '2026-11-03', revision: 'r-07', characters: 600 },
    { path: 'webshell/WS-01.md', id: 'WS-01', title: 'WebShell 判定', status: 'deprecated', updated: '2026-11-03', revision: 'r-ws01', characters: 900 },
    { path: 'webshell/WS-02.md', id: 'WS-02', title: '旧 WebShell 判定', status: null, updated: null, revision: null, characters: null },
  ],
};

const PAGE_GEN12 = {
  ...DIRECTORY.pages[1],
  content: [
    '---', 'id: GEN-12', 'status: active', '---', '',
    '# GEN-12 · 研判通则', '',
    '先读 [证据核验](GEN-07.md)，未建页看 [存疑页](common/NOPE-01.md)。', '',
    '## 判断顺序', '',
    '1. 定资产', '2. 定行为', '',
    '## 判定表', '',
    '| 类型 | 含义 |', '| --- | --- |', '| `SUID` | 硬信号 |', '',
    '```', 'hids-cli status', '```',
  ].join('\n'),
};

const PAGE_WS01 = {
  ...DIRECTORY.pages[3],
  content: '---\nid: WS-01\n---\n\n入门说明。\n\n## 判定\n\n证据链完整才算真实威胁。\n',
};

const PAGE_GEN07 = {
  ...DIRECTORY.pages[2],
  content: '---\nid: GEN-07\n---\n\n核验步骤。\n\n## 步骤\n\n按序核对。\n',
};

function routesFor(overrides = {}) {
  return {
    '/api/wiki/pages': { body: DIRECTORY },
    '/api/wiki/pages/common%2FGEN-12.md': { body: PAGE_GEN12 },
    '/api/wiki/pages/common%2FGEN-07.md': { body: PAGE_GEN07 },
    '/api/wiki/pages/webshell%2FWS-01.md': { body: PAGE_WS01 },
    ...overrides,
  };
}

let table = {};
let calls = [];

function stubFetch() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = Object.keys(table)
      .filter(key => String(url).endsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`未桩的请求：${url}`);
    const route = typeof table[hit] === 'function' ? table[hit](init, calls) : table[hit];
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => route.body };
  };
}

const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

let host;

/** 挂页面并把目录请求跑完 */
async function mount() {
  const content = document.createElement('div');
  document.body.append(content);
  page.render(content, { params: [] });
  host = content.firstElementChild;
  await settle();
  return host;
}

const total = () => text(host.querySelector('[data-role="total"]'));
const count = () => text(host.querySelector('[data-role="count"]'));
const rows = () => [...host.querySelectorAll('tbody tr')];
const notice = () => host.querySelector('[data-role="notice"]');
const entryNotice = () => host.querySelector('[data-role="entry-notice"]');
const indexView = () => host.querySelector('[data-role="view-index"]');
const entryView = () => host.querySelector('[data-role="view-entry"]');
const editor = () => host.querySelector('[data-role="editor"]');
const search = () => host.querySelector('#knowledge-q');
const categorySelect = () => host.querySelector('#knowledge-cat');
const saveButton = () => byRole(host, 'button', '保存草稿');
const revertButton = () => byRole(host, 'button', '撤销修改');
const bodyTextarea = () => host.querySelector('#knowledge-edit-body');
const titleInput = () => host.querySelector('#knowledge-edit-title');

function click(node) {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function typeIn(node, value) {
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
}

beforeEach(() => {
  setupDom();
  globalThis.localStorage = window.localStorage;
  setCredentials({ user: 'hids', password: 'hids-2026' });
  table = routesFor();
  stubFetch();
});

/* ---------------- loading ---------------- */

test('loading：读目录时 aria-busy、表格一行说明、刷新与搜索禁用', async () => {
  const content = document.createElement('div');
  document.body.append(content);
  page.render(content, { params: [] });
  host = content.firstElementChild;

  assert.equal(host.getAttribute('aria-busy'), 'true');
  assert.match(text(host), /正在读取知识库…/);
  assert.equal(byRole(host, 'button', '刷新').disabled, true);
  assert.equal(search().disabled, true);
  assert.equal(categorySelect().disabled, true);

  await settle();
  assert.equal(host.getAttribute('aria-busy'), 'false');
  assert.equal(byRole(host, 'button', '刷新').disabled, false);
  assert.equal(search().disabled, false);
});

/* ---------------- 列表 ---------------- */

test('列表：行数/标题/分类/编号/状态逐条来自接口，计数 N / M 条 + 共 N 条', async () => {
  await mount();
  assert.equal(rows().length, 5);
  assert.equal(total(), '5');
  assert.equal(count(), '5 / 5 条');

  const gen12 = rows()[1];
  assert.match(text(gen12), /研判通则/);
  assert.match(text(gen12), /common/);
  assert.match(text(gen12), /GEN-12/);
  assert.match(text(gen12), /active/);
  assert.equal(calls.filter(call => call.url.endsWith('/api/wiki/pages')).length, 1);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
});

test('列表：字段缺失就显示「—」，不拿稿上的 status 顶替（A1 不编字段）', async () => {
  await mount();
  const ws02 = rows()[4];
  assert.match(text(ws02), /旧 WebShell 判定/);
  const cells = [...ws02.querySelectorAll('td')].map(cell => text(cell));
  assert.deepEqual(cells.slice(1), ['webshell', 'WS-02', '—']);
});

test('列表：分类下拉的选项来自真实目录名，不出现稿上的「通用口径／案件复盘」', async () => {
  await mount();
  const options = [...categorySelect().options].map(option => option.value);
  assert.deepEqual(options.filter(Boolean).sort(), ['common', 'webshell']);
  assert.doesNotMatch(text(categorySelect().closest('.k-filters')), /通用口径|案件复盘|规则说明|值守交接/);
  assert.equal(host.querySelector('#filter-tag'), null, '标签筛选没有字段支撑，不该出现在页面上');
});

/* ---------------- empty ---------------- */

test('empty（筛选无结果）：空态 + 清除筛选；点清除回到全部条目', async () => {
  await mount();
  typeIn(search(), '不存在的条目');
  assert.equal(rows().length, 0);
  const empty = host.querySelector('[data-role="empty"]');
  assert.equal(empty.hidden, false);
  assert.match(text(empty), /没有匹配的条目/);
  assert.equal(byRole(host, 'button', '清除筛选').hidden, false);

  click(byRole(host, 'button', '清除筛选'));
  assert.equal(rows().length, 5);
  assert.equal(empty.hidden, true);
  assert.equal(byRole(host, 'button', '清除筛选').hidden, true);
});

test('empty（目录为空）：接口回 pages: [] → 「知识库还没有条目」', async () => {
  table = routesFor({ '/api/wiki/pages': { body: { pages: [] } } });
  await mount();
  const empty = host.querySelector('[data-role="empty"]');
  assert.equal(empty.hidden, false);
  assert.match(text(empty), /知识库还没有条目/);
  assert.equal(total(), '0');
});

/* ---------------- error / partial ---------------- */

test('error：目录 5xx → 整页 notice 带状态码与重试；重试成功后列表回来', async () => {
  let attempt = 0;
  table = routesFor({
    '/api/wiki/pages': () => {
      attempt += 1;
      return attempt === 1 ? { status: 500, body: { error: 'boom' } } : { body: DIRECTORY };
    },
  });
  await mount();
  assert.equal(notice().hidden, false);
  assert.match(text(notice()), /服务返回异常（500）/);
  assert.equal(rows().length, 0);

  click(byRole(host, 'button', '刷新'));
  await settle();
  assert.equal(rows().length, 5);
  assert.equal(notice().hidden, true);
});

test('error：401 → 文案是登录失效，不甩服务端正文', async () => {
  table = routesFor({ '/api/wiki/pages': { status: 401, body: { error: '需要登录后访问' } } });
  await mount();
  assert.match(text(notice()), /登录已失效/);
  assert.doesNotMatch(text(notice()), /需要登录后访问/);
});

test('partial：目录读到了、单条正文 404 → 条目页局部报错且列表可回', async () => {
  table = routesFor({ '/api/wiki/pages/webshell%2FWS-01.md': { status: 404, body: { error: 'ENOENT: /srv/wiki/webshell/WS-01.md' } } });
  await mount();
  click(byRole(host, 'button', 'WebShell 判定'));
  await settle();

  assert.equal(entryView().hidden, false);
  assert.equal(entryNotice().hidden, false);
  assert.match(text(entryNotice()), /不存在（404）/);
  assert.doesNotMatch(text(entryNotice()), /\/srv\/wiki/, '服务端绝对路径不外露');
  assert.ok(byRole(host, 'button', '重试'));

  // 目录还在：面包屑能回列表
  click(byRole(host, 'button', '知识库'));
  assert.equal(indexView().hidden, false);
  assert.equal(rows().length, 5);
});

test('partial：条目重试成功后就地渲染正文', async () => {
  let attempt = 0;
  table = routesFor({
    '/api/wiki/pages/webshell%2FWS-01.md': () => {
      attempt += 1;
      return attempt === 1 ? { status: 502, body: { error: 'bad gateway' } } : { body: PAGE_WS01 };
    },
  });
  await mount();
  click(byRole(host, 'button', 'WebShell 判定'));
  await settle();
  assert.match(text(entryNotice()), /服务返回异常（502）/);

  click(byRole(host, 'button', '重试'));
  await settle();
  assert.equal(entryNotice().hidden, true);
  assert.match(text(host.querySelector('[data-role="lead"]')), /入门说明/);
  assert.match(text(host), /证据链完整才算真实威胁/);
});

/* ---------------- long-content ---------------- */

test('long-content：200 条目录 + 超长标题不截断文本、超长正文整段渲染', async () => {
  const longTitle = `超长标题-${'很长的条目名称'.repeat(20)}`;
  const longWord = 'x'.repeat(400);
  const many = Array.from({ length: 200 }, (unused, index) => ({
    path: `common/LONG-${index}.md`,
    id: `LONG-${index}`,
    title: index === 0 ? longTitle : `条目 ${index}`,
    status: 'active',
    updated: '2026-11-09',
    revision: `r-${index}`,
    characters: 10,
  }));
  table = routesFor({
    '/api/wiki/pages': { body: { pages: many } },
    '/api/wiki/pages/common%2FLONG-0.md': { body: { ...many[0], content: `---\nid: LONG-0\n---\n\n${longWord}\n\n## 一节\n\n${longWord}` } },
  });
  await mount();
  assert.equal(rows().length, 200);
  assert.equal(byRole(host, 'button', longTitle).textContent, longTitle, '标题不许截断数据，靠 CSS 折行');

  click(byRole(host, 'button', longTitle));
  await settle();
  const lead = host.querySelector('[data-role="lead"]');
  assert.ok(text(lead).includes(longWord), '超长正文不许被切掉');
  assert.equal(host.querySelectorAll('[data-role="sections"] .k-block').length, 1);
});

/* ---------------- 条目视图 ---------------- */

test('条目：标题/面包屑/头信息/条目信息/相关条目/接口字段都来自接口', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();

  assert.equal(entryView().hidden, false);
  assert.equal(indexView().hidden, true);
  assert.equal(text(byRole(host, 'heading', '研判通则')), '研判通则');
  assert.equal(text(host.querySelector('[data-role="crumbs"]')), '知识库/common/GEN-12');
  assert.equal(text(host.querySelector('[data-role="head-status"]')), 'active');
  assert.equal(text(host.querySelector('[data-role="head-id"]')), 'GEN-12');
  assert.equal(text(host.querySelector('[data-role="head-path"]')), 'common/GEN-12.md');
  assert.equal(text(host.querySelector('[data-role="head-sections"]')), '2 节');
  assert.equal(text(host.querySelector('[data-role="head-source"]')), '正文来源：接口正文');
  assert.match(text(host.querySelector('[data-role="head-updated"]')), /最后修改 2026-11-09/);

  const info = text(host.querySelector('[data-role="info"]'));
  assert.match(info, /修订c9dacfa538de0828/);
  assert.match(info, /路径common\/GEN-12\.md/);

  const related = text(host.querySelector('[data-role="related"]'));
  assert.match(related, /证据核验清单/);
  assert.doesNotMatch(related, /WebShell 判定/, '相关条目只取同分类');

  const raw = host.querySelector('[data-role="raw"]').textContent;
  assert.match(raw, /"revision": "c9dacfa538de0828"/);
  assert.match(raw, /ENOENT|content/, '接口字段面板展示原样回包');
});

test('条目：正文去掉 --- 头部，表格/代码块/列表都渲染出来', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();

  const main = host.querySelector('[data-role="main-col"]');
  assert.doesNotMatch(text(main.querySelector('[data-role="lead"]')), /id: GEN-12/, '头元数据不在正文里重复一遍');
  assert.match(text(main), /定资产/);
  assert.ok(main.querySelector('table.md-table'));
  const tableCells = [...main.querySelectorAll('table.md-table th, table.md-table td')].map(node => text(node));
  assert.deepEqual(tableCells, ['类型', '含义', 'SUID', '硬信号']);
  assert.match(main.querySelector('pre.code').textContent, /hids-cli status/);
});

test('目录与小节编辑：点了不抛错，编辑小节落到对应行', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();

  const tocButtons = [...host.querySelectorAll('[data-role="toc"] button')];
  assert.equal(tocButtons.length, 2);
  assert.doesNotThrow(() => click(tocButtons[1]));

  click(byRole(host, 'button', '编辑小节：判定表'));
  assert.equal(editor().hidden, false);
  assert.equal(text(byRole(host, 'button', '编辑')), '编辑');
  assert.match(bodyTextarea().value, /## 判定表/);
});

/* ---------------- 编辑 / 草稿 ---------------- */

test('disabled：刚进编辑页签时保存/撤销禁用，改一个字后启用', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));

  assert.equal(editor().hidden, false);
  assert.equal(saveButton().disabled, true);
  assert.equal(revertButton().disabled, true);

  typeIn(titleInput(), '研判通则（改）');
  assert.equal(saveButton().disabled, false);
  assert.equal(revertButton().disabled, false);
  assert.equal(text(host.querySelector('[data-role="draft-state"]')), '未保存');
});

test('保存草稿：写进本机存储，来源标注变「本地草稿」，草稿计数 +1，保存按钮回到禁用', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(titleInput(), '研判通则（改）');
  click(saveButton());

  const stored = JSON.parse(window.localStorage.getItem(DRAFTS_KEY));
  assert.equal(stored['common/GEN-12.md'].title, '研判通则（改）');
  assert.equal(typeof stored['common/GEN-12.md'].savedAt, 'number');
  assert.equal(saveButton().disabled, true);
  assert.equal(text(host.querySelector('[data-role="drafts"]')), '1');

  click(byRole(host, 'button', '条目'));
  assert.equal(text(host.querySelector('[data-role="head-source"]')), '正文来源：本地草稿');
  assert.equal(text(byRole(host, 'heading', '研判通则（改）')), '研判通则（改）');
  assert.match(text(host.querySelector('[data-role="toast"]')), /草稿已保存到本机/);
});

test('撤销修改：退回上次保存的基线，保存按钮重新禁用', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(bodyTextarea(), '改坏了');
  assert.equal(saveButton().disabled, false);

  click(revertButton());
  assert.equal(bodyTextarea().value, PAGE_GEN12.content.replace(/^---\n[\s\S]*?\n---\n\n/, ''));
  assert.equal(saveButton().disabled, true);
});

test('离开未保存：点面包屑先确认；放弃修改回列表，保存并离开落草稿再回列表', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(titleInput(), '未保存的改法');

  const dialog = host.querySelector('[data-role="discard"]');
  click(byRole(host, 'button', '知识库'));
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(indexView().hidden, true, '确认之前不许换视图');

  click(byRole(host, 'button', '取消'));
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(editor().hidden, false);

  click(byRole(host, 'button', '知识库'));
  click(byRole(host, 'button', '放弃修改'));
  assert.equal(indexView().hidden, false);
  assert.equal(JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? '{}')['common/GEN-12.md'], undefined);
});

test('保存并离开：草稿落盘后回列表', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(titleInput(), '保存再走');

  click(byRole(host, 'button', '知识库'));
  click(byRole(host, 'button', '保存并离开'));
  assert.equal(indexView().hidden, false);
  assert.equal(JSON.parse(window.localStorage.getItem(DRAFTS_KEY))['common/GEN-12.md'].title, '保存再走');
});

/* ---------------- 其它交互 ---------------- */

test('内链：指向已建条目就跳过去，未建页的红虚线不跳', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();

  const missing = host.querySelector('.wlink.is-missing');
  assert.ok(missing, '未建页的内链要标出来');
  assert.equal(missing.closest('a'), null, '未建页不给链接');
  click(missing);
  assert.equal(text(byRole(host, 'heading', '研判通则')), '研判通则');

  click(byRole(host, 'link', '证据核验'));
  await settle();
  assert.equal(text(byRole(host, 'heading', '证据核验清单')), '证据核验清单');
  assert.equal(text(host.querySelector('[data-role="crumbs"]')), '知识库/common/GEN-07');
});

test('复制路径：写进剪贴板并提示', async () => {
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async value => { copied.push(value); } },
    configurable: true,
  });
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '复制路径'));
  await settle();
  assert.deepEqual(copied, ['common/GEN-12.md']);
  assert.match(text(host.querySelector('[data-role="toast"]')), /已复制路径 common\/GEN-12\.md/);
});

test('刷新：重新拉一次目录；有未保存修改时提示保留', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(titleInput(), '还没保存');

  const before = calls.length;
  click(byRole(host, 'button', '刷新'));
  await settle();
  assert.equal(calls.length, before + 1);
  assert.equal(titleInput().value, '还没保存');
  assert.match(text(host.querySelector('[data-role="toast"]')), /未保存修改保留着/);
});

test('分类筛选：选一个分类只剩该目录的条目，面包屑里的分类也能筛回来', async () => {
  await mount();
  const select = categorySelect();
  select.value = 'webshell';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(rows().length, 2);
  assert.equal(count(), '2 / 5 条');

  click(byRole(host, 'button', 'WebShell 判定'));
  await settle();
  click(host.querySelector('[data-role="crumbs"] [data-kcat]'));
  assert.equal(indexView().hidden, false);
  assert.equal(rows().length, 2);
  assert.equal(categorySelect().value, 'webshell');
});

test('可访问性：表格有 caption，搜索/分类有 label，页面有一处 role=status 播报', async () => {
  await mount();
  const caption = host.querySelector('caption');
  assert.equal(text(caption), '知识库条目目录');
  assert.ok(host.querySelector('label[for="knowledge-q"]'));
  assert.ok(host.querySelector('label[for="knowledge-cat"]'));
  assert.ok(allByRole(host, 'alert').length >= 2, '通知条与条目页局部通知各一处 role=alert');
  assert.ok(host.querySelector('[data-role="live"][aria-live="polite"]'));
  assert.ok(host.classList.contains('knowledge'));
});

test('没有凭据时：目录请求不发，页面报登录失效', async () => {
  clearCredentials();
  await mount();
  assert.equal(calls.length, 0);
  assert.match(text(notice()), /登录已失效/);
});

test('表格包裹层的类名与样式表对得上（审查打回过的死选择器，防回归）', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();

  const wrapper = host.querySelector('[data-role="main-col"] table.md-table')?.parentElement;
  assert.ok(wrapper, '正文里的管道表格要有包裹层');
  assert.ok(wrapper.classList.contains('k-table-wrap'), `包裹层类名应为 k-table-wrap，实际 ${wrapper.className}`);

  // 样式表里必须有同名选择器：jsdom 不读 <link>，直接读文件把「DOM 类名 ↔ CSS 选择器」钉在一起
  const css = readFileSync(new URL('../../assets/pages/knowledge.css', import.meta.url), 'utf8');
  assert.match(css, /\.k-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
});

test('Esc 关闭确认弹窗：pendingNav 清掉，焦点回到原控件', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(titleInput(), '未保存的改法');

  const dialog = host.querySelector('[data-role="discard"]');
  const crumb = byRole(host, 'button', '知识库');
  click(crumb);
  assert.equal(dialog.hasAttribute('open'), true);

  // 真实浏览器按 Esc 走原生 cancel → close，不经过 closeDialog()；jsdom 没有 dialog.close()，手刻这两步
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new window.Event('close'));
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(indexView().hidden, true, 'Esc 等于取消：视图不动');
  assert.equal(editor().hidden, false);

  // pendingNav 已清：再点一次面包屑要重新弹窗，而不是拿旧动作直接跳
  click(crumb);
  assert.equal(dialog.hasAttribute('open'), true, '旧动作不该残留');
  click(byRole(host, 'button', '放弃修改'));
  assert.equal(indexView().hidden, false);
});

/* ---------------- 页面级离开守卫（侧栏导航 / 浏览器后退 / 关页面） ---------------- */
// 壳禁改（views/shell.js / app.js / router.js），所以这三条路径都在页面自己的作用域里拦：
// 侧栏锚点是默认行为导航 → document 捕获阶段 preventDefault；后退 → 同 URL 守卫条目 + popstate。

const dialog = () => host.querySelector('[data-role="discard"]');

/** 壳的侧栏入口（页面作用域外），照 shell.js:36-38 的形状造一个 */
function sidebarLink(href = '#/overview') {
  const link = document.createElement('a');
  link.className = 'nav-item';
  link.dataset.route = 'overview';
  link.href = href;
  link.textContent = '总览';
  document.body.append(link);
  return link;
}

function pressClick(node) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
}

/** 进条目 → 切编辑 → 改标题：脏标记立起来 */
async function dirtyEdit() {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();
  click(byRole(host, 'button', '编辑'));
  typeIn(titleInput(), '未保存的改法');
  assert.equal(text(host.querySelector('[data-role="head-dirty"]')), '有未保存修改');
}

test('脏态点侧栏导航：先拦下并弹确认，取消不导航，放弃修改才跳走', async () => {
  await dirtyEdit();
  const nav = sidebarLink();

  const first = pressClick(nav);
  assert.equal(first.defaultPrevented, true, '脏态下侧栏链接的默认跳转要被按住');
  assert.equal(dialog().hasAttribute('open'), true, '离开知识库页要先弹未保存确认');
  assert.equal(window.location.hash, '', '确认之前不导航');

  click(byRole(host, 'button', '取消'));
  assert.equal(dialog().hasAttribute('open'), false);
  assert.equal(window.location.hash, '', '取消之后仍然停在原页');
  assert.equal(editor().hidden, false, '取消不换视图');

  pressClick(sidebarLink());
  click(byRole(host, 'button', '放弃修改'));
  assert.equal(window.location.hash, '#/overview', '放弃修改后才真的跳走');
});

test('脏态点侧栏导航选「保存并离开」：草稿先落盘再跳', async () => {
  await dirtyEdit();
  pressClick(sidebarLink('#/alerts'));
  click(byRole(host, 'button', '保存并离开'));

  const stored = JSON.parse(window.localStorage.getItem(DRAFTS_KEY));
  assert.equal(stored['common/GEN-12.md'].title, '未保存的改法');
  assert.equal(window.location.hash, '#/alerts');
});

test('脏态点「退出登录」：同样先弹确认，放行后才真的退出', async () => {
  await dirtyEdit();
  const signout = document.createElement('button');
  signout.type = 'button';
  signout.className = 'nav-item';
  signout.dataset.role = 'signout';
  signout.textContent = '退出登录';
  let signedOut = 0;
  signout.addEventListener('click', () => { signedOut += 1; });
  document.body.append(signout);

  pressClick(signout);
  assert.equal(dialog().hasAttribute('open'), true);
  assert.equal(signedOut, 0, '确认之前不许退出');

  pressClick(signout);
  click(byRole(host, 'button', '放弃修改'));
  assert.equal(signedOut, 1, '放行后交回壳的退出按钮');
});

test('没脏标记时侧栏导航照常放行，一个都不拦', async () => {
  await mount();
  click(byRole(host, 'button', '研判通则'));
  await settle();

  const event = pressClick(sidebarLink());
  assert.equal(event.defaultPrevented, false);
  assert.equal(dialog().hasAttribute('open'), false);
});

test('脏态浏览器后退：拦在同一条 URL 上并弹确认（守卫条目在 history 里）', async () => {
  await dirtyEdit();
  assert.equal(window.history.state?.knowledgeUnsavedGuard, true, '脏时先压一条守卫条目');

  window.dispatchEvent(new window.Event('popstate'));
  assert.equal(dialog().hasAttribute('open'), true, '后退要弹未保存确认');

  click(byRole(host, 'button', '取消'));
  assert.equal(editor().hidden, false, '取消之后页面还在、草稿还在');
  assert.equal(titleInput().value, '未保存的改法');

  // 取消后再按后退仍要弹（守卫条目压回去了，不残留旧动作）
  window.dispatchEvent(new window.Event('popstate'));
  assert.equal(dialog().hasAttribute('open'), true);
});

test('脏态关页面/刷新会被 beforeunload 拦一次，保存草稿后不再拦', async () => {
  await dirtyEdit();
  const blocked = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, true);

  click(saveButton());
  const afterSave = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(afterSave);
  assert.equal(afterSave.defaultPrevented, false, '草稿已存本机，不再拦');

  // 保存后守卫条目也退掉了（jsdom 的 history.back() 是排队执行的）：history 里不再带守卫标记
  await settle();
  assert.notEqual(window.history.state?.knowledgeUnsavedGuard, true);
});

test('页面被换掉后旧守卫不再拦导航（监听器自净）', async () => {
  await dirtyEdit();

  // 模拟路由换页：新页面 render 会把 host 从 content 里换掉
  const content = host.parentElement;
  content.replaceChildren(document.createElement('div'));
  await settle();
  assert.equal(host.isConnected, false);

  const event = pressClick(sidebarLink());
  assert.equal(event.defaultPrevented, false, '旧页面的守卫不该继续拦');
});
