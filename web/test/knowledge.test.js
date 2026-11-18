// src/knowledge.js —— 知识库 adapter：两个只读 operation 的归一与错误、本机草稿、纯文本工具
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearCredentials, setCredentials } from '../src/credentials.js';
import {
  DRAFTS_KEY,
  KnowledgeError,
  categoryOf,
  findPage,
  formatClock,
  getPage,
  listPages,
  loadDrafts,
  renderMarkdown,
  resolvePagePath,
  saveDraft,
  splitBody,
  stripFrontMatter,
  wordCount,
} from '../src/knowledge.js';

const DIRECTORY = {
  pages: [
    { path: 'common/GEN-12.md', id: 'GEN-12', title: '研判通则', status: 'active', updated: '2026-11-09', revision: 'abc123', characters: 1028 },
    { path: 'webshell/WS-01.md', id: 'WS-01', title: 'WebShell 判定', status: 'deprecated', updated: '2026-11-03', revision: 'def456', characters: 900 },
  ],
};

const PAGE = {
  ...DIRECTORY.pages[0],
  content: '---\nid: GEN-12\nstatus: active\n---\n\n# GEN-12 · 研判通则\n\n先读 [证据清单](webshell/WS-01.md)。\n\n## 判断顺序\n\n1. 定资产\n',
};

function stubFetch(table) {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = keys.find(candidate => String(url).endsWith(candidate));
    if (key === undefined) throw new Error(`未桩的请求：${url}`);
    const route = typeof table[key] === 'function' ? table[key](init) : table[key];
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => route.body };
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

afterEach(() => {
  clearCredentials();
});

/* ---------------- 目录 ---------------- */

test('listPages：字段逐字照接口，Authorization 用 Basic', async () => {
  const { fetchImpl, calls } = stubFetch({ '/api/wiki/pages': { body: DIRECTORY } });
  const { pages } = await listPages({ fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.deepEqual(pages[0], DIRECTORY.pages[0]);
  assert.equal(pages.length, 2);
});

test('listPages：只有 path 是必需字段，其余缺就是 null（不补默认状态/标题）', async () => {
  const { fetchImpl } = stubFetch({ '/api/wiki/pages': { body: { pages: [{ path: 'index.md' }] } } });
  const { pages } = await listPages({ fetchImpl });
  assert.deepEqual(pages[0], { path: 'index.md', id: null, title: null, status: null, updated: null, revision: null, characters: null });
});

test('listPages：path 缺失 / pages 不是数组 / 非 JSON → invalid', async () => {
  for (const body of [{ pages: [{ id: 'X' }] }, {}, { pages: 'no' }]) {
    const { fetchImpl } = stubFetch({ '/api/wiki/pages': { body } });
    await assert.rejects(listPages({ fetchImpl }), error => error instanceof KnowledgeError && error.kind === 'invalid');
  }
  const broken = { fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error('boom'); } }) };
  await assert.rejects(listPages(broken), error => error.kind === 'invalid');
});

test('listPages：401 / 5xx / 连不上 → unauthorized / http / network（状态码带上）', async () => {
  const unauthorized = stubFetch({ '/api/wiki/pages': { status: 401, body: { error: '需要登录后访问' } } });
  await assert.rejects(listPages({ fetchImpl: unauthorized.fetchImpl }), error =>
    error.kind === 'unauthorized' && error.status === 401);

  const broken = stubFetch({ '/api/wiki/pages': { status: 500, body: { error: 'x' } } });
  await assert.rejects(listPages({ fetchImpl: broken.fetchImpl }), error => error.kind === 'http' && error.status === 500);

  const offline = stubFetch({ '/api/wiki/pages': new TypeError('fetch failed') });
  await assert.rejects(listPages({ fetchImpl: offline.fetchImpl }), error => error.kind === 'network');
});

test('listPages：没有凭据 → unauthorized，且不发请求', async () => {
  clearCredentials();
  const { fetchImpl, calls } = stubFetch({ '/api/wiki/pages': { body: DIRECTORY } });
  await assert.rejects(listPages({ fetchImpl }), error => error.kind === 'unauthorized');
  assert.equal(calls.length, 0);
});

/* ---------------- 单页 ---------------- */

test('getPage：斜杠按 %2F 编码，回包七个字段 + content 原样', async () => {
  const { fetchImpl, calls } = stubFetch({ '/api/wiki/pages/common%2FGEN-12.md': { body: PAGE } });
  const page = await getPage('common/GEN-12.md', { fetchImpl });
  assert.equal(calls[0].url, '/api/wiki/pages/common%2FGEN-12.md');
  assert.equal(page.content, PAGE.content);
  assert.equal(page.id, 'GEN-12');
  assert.equal(page.revision, 'abc123');
  assert.equal(page.characters, 1028);
});

test('getPage：没有 content 视为 invalid（不拿空字符串冒充正文）', async () => {
  const { fetchImpl } = stubFetch({ '/api/wiki/pages/common%2FGEN-12.md': { body: { ...PAGE, content: undefined } } });
  await assert.rejects(getPage('common/GEN-12.md', { fetchImpl }), error => error.kind === 'invalid');
});

test('getPage：404 → http 且 status=404；空路径 → invalid 不发请求', async () => {
  const missing = stubFetch({ '/api/wiki/pages/common%2FNOPE-99.md': { status: 404, body: { error: 'ENOENT' } } });
  await assert.rejects(getPage('common/NOPE-99.md', { fetchImpl: missing.fetchImpl }), error =>
    error.kind === 'http' && error.status === 404);

  const { fetchImpl, calls } = stubFetch({});
  await assert.rejects(getPage('', { fetchImpl }), error => error.kind === 'invalid');
  assert.equal(calls.length, 0);
});

/* ---------------- 本机草稿 ---------------- */

function fakeStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    data,
  };
}

test('saveDraft / loadDrafts：落进 storage，键是页面路径，savedAt 可控', () => {
  const storage = fakeStorage();
  const { persisted, drafts } = saveDraft('common/GEN-12.md', { title: 'T', body: 'B' }, { storage, now: 1700000000000 });
  assert.equal(persisted, true);
  assert.deepEqual(drafts['common/GEN-12.md'], { title: 'T', body: 'B', savedAt: 1700000000000 });
  assert.deepEqual(loadDrafts(storage)['common/GEN-12.md'], { title: 'T', body: 'B', savedAt: 1700000000000 });
  assert.equal(storage.data.has(DRAFTS_KEY), true);
});

test('saveDraft：storage 写不进去 → persisted=false（不假装已落盘），返回值里仍带这份草稿', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceeded'); },
  };
  const { persisted, drafts } = saveDraft('common/GEN-12.md', { title: 'T', body: 'B' }, { storage, now: 1 });
  assert.equal(persisted, false);
  assert.deepEqual(drafts['common/GEN-12.md'], { title: 'T', body: 'B', savedAt: 1 });
});

test('loadDrafts：storage 里是坏 JSON → 当作没有草稿，不抛', () => {
  const storage = fakeStorage();
  storage.setItem(DRAFTS_KEY, '{oops');
  assert.deepEqual(loadDrafts(storage), {});
});

/* ---------------- 纯文本工具 ---------------- */

test('stripFrontMatter：去掉 --- 头，没有头就原样，未闭合也原样', () => {
  assert.equal(stripFrontMatter('---\nid: X\n---\n\n正文'), '正文');
  assert.equal(stripFrontMatter('正文\n---\nid: X\n---'), '正文\n---\nid: X\n---');
  assert.equal(stripFrontMatter('---\nid: X\n\n正文'), '---\nid: X\n\n正文');
  assert.equal(stripFrontMatter(''), '');
});

test('splitBody：首段当摘要，## 切分节，line 是标题在传入文本里的行号', () => {
  const body = '摘要第一段\n\n## 第一节\n内容一\n\n## 第二节\n内容二';
  const parts = splitBody(body);
  assert.equal(parts.lead, '摘要第一段');
  assert.deepEqual(parts.sections.map(section => section.title), ['第一节', '第二节']);
  assert.deepEqual(parts.sections.map(section => section.line), [2, 5]);
  assert.equal(parts.sections[1].text, '内容二');
  assert.deepEqual(splitBody(''), { lead: '', sections: [] });
});

test('wordCount 去空白；categoryOf 取首段目录，根文档为空串', () => {
  assert.equal(wordCount(' a b\n c '), 3);
  assert.equal(categoryOf('common/GEN-12.md'), 'common');
  assert.equal(categoryOf('index.md'), '');
});

test('resolvePagePath：同目录 / ../ / 越界', () => {
  assert.equal(resolvePagePath('webshell/index.md', 'WS-13.md'), 'webshell/WS-13.md');
  assert.equal(resolvePagePath('webshell/index.md', '../common/GEN-12.md'), 'common/GEN-12.md');
  assert.equal(resolvePagePath('webshell/index.md', '../../x.md'), null);
  assert.equal(resolvePagePath('webshell/index.md', 'https://example.com/a'), null);
});

test('findPage：编号 / 路径 / 去 .md 路径 / 相对链接都能找到，找不到给 null', () => {
  const pages = DIRECTORY.pages;
  assert.equal(findPage(pages, 'WS-01').path, 'webshell/WS-01.md');
  assert.equal(findPage(pages, 'common/GEN-12.md').path, 'common/GEN-12.md');
  assert.equal(findPage(pages, 'common/GEN-12').path, 'common/GEN-12.md');
  assert.equal(findPage(pages, 'ws-01.md', { fromPath: 'webshell/WS-01.md' }).path, 'webshell/WS-01.md');
  assert.equal(findPage(pages, 'GEN-99'), null);
});

/* ---------------- Markdown ---------------- */

test('renderMarkdown：段落 / 粗体 / 行内码 / 列表 / 有序 / 引用 / 标题', () => {
  const html = renderMarkdown('第一段 **粗** 与 `code`\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用\n\n### 小标题');
  assert.match(html, /<p>第一段 <strong>粗<\/strong> 与 <code>code<\/code><\/p>/);
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<h3>小标题<\/h3>/);
});

test('renderMarkdown：管道表格渲染成 table（真正文里 99 个文件有表）', () => {
  const html = renderMarkdown('| 类型 | 含义 |\n| --- | --- |\n| `SUID` | 硬信号 |\n| 未知 | 存疑 |');
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th scope="col">类型<\/th><th scope="col">含义<\/th>/);
  assert.match(html, /<td><code>SUID<\/code><\/td><td>硬信号<\/td>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
});

test('renderMarkdown：围栏代码块原样保留、内部不再解析 markdown', () => {
  const html = renderMarkdown('```\n## 不是标题\n**不是粗体**\n```');
  assert.match(html, /<pre class="code"><code>## 不是标题\n\*\*不是粗体\*\*<\/code><\/pre>/);
  assert.doesNotMatch(html, /<h3>/);
});

test('renderMarkdown：接口给的文字一律转义，注入标签不生效', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n| a<b | c |\n| --- | --- |\n| <script> | d |');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
});

test('renderMarkdown：内链——有对应条目给 data-kpath，没有的标 is-missing 且不给链接', () => {
  const pages = DIRECTORY.pages;
  const resolve = target => findPage(pages, target, { fromPath: 'common/index.md' });
  const html = renderMarkdown('见 [判定](../webshell/WS-01.md) 与 [未建](common/NOPE-01.md)，以及 [[WS-01|编号内链]]', { resolve });
  assert.match(html, /<a class="wlink" href="#" data-kpath="webshell\/WS-01.md">判定<\/a>/);
  assert.match(html, /<span class="wlink is-missing" title="条目尚未创建：common\/NOPE-01.md">未建<\/span>/);
  assert.match(html, /<a class="wlink" href="#" data-kpath="webshell\/WS-01.md">编号内链<\/a>/);
});

test('renderMarkdown：没有 resolve 时一律按未建页处理（不猜链接）', () => {
  const html = renderMarkdown('[甲](common/GEN-12.md)');
  assert.match(html, /is-missing/);
  assert.doesNotMatch(html, /data-kpath/);
});

test('renderMarkdown：列表项的缩进续行接回上一条，不断成新段', () => {
  const html = renderMarkdown('1. 第一句\n   （补充说明）\n2. 第二句');
  assert.match(html, /<li>第一句 （补充说明）<\/li>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test('formatClock：本机时分秒，非法输入给「—」', () => {
  assert.equal(formatClock(new Date(2026, 10, 18, 9, 5, 3)), '09:05:03');
  assert.equal(formatClock(new Date('nope')), '—');
  assert.equal(formatClock(null), '—');
});
