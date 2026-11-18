// 知识库页的数据 adapter —— 本页唯一发 HTTP 的地方（页面文件里不许出现 fetch）。
//
// 数据来源：形态 B（对接已就绪后端），三个 operation 逐条对过账：
//
//   GET /api/wiki/pages                      → { pages: [ {path,id,title,status,updated,revision,characters} ] }
//                                              openapi.yaml 的 /api/wiki/pages；实现 server.js:322-337
//   GET /api/wiki/pages/{pagePath}           → 上面七个字段 + content（整篇 Markdown，含 --- 头部元数据）
//                                              openapi.yaml:452-466；实现 server.js:343-345
//   PUT /api/wiki/pages/{pagePath}           → 保存到服务器（P003-T002 / D003 选 A：控制台 Basic + expected_revision）
//                                              正文 { content, expected_revision }，200 回更新后的页面对象；
//                                              409 版本过期、400 正文不合规、404 页面不存在；实现 server.js:346-352 → wiki-store.js:159-188
//   400 / 404 / 503                          → {error: "…"}（错误正文只取 "error" 字样，不外露服务端路径）
//
// 本文件另外管纯文本工具（front matter / 分节 / Markdown 渲染）——不碰 DOM，单测可直接跑。

import { authorizationHeader } from './credentials.js';

/** 归一后的错误：kind ∈ unauthorized | http | network | invalid */
export class KnowledgeError extends Error {
  /**
   * @param {'unauthorized'|'conflict'|'http'|'network'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number|null, cause?: unknown }} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'KnowledgeError';
    this.kind = kind;
    this.status = detail.status ?? null;
    this.cause = detail.cause;
  }
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = value => (typeof value === 'string' && value !== '' ? value : null);

function requireHeader() {
  const header = authorizationHeader();
  if (!header) throw new KnowledgeError('unauthorized', '缺少凭据');
  return header;
}

async function requestJSON(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = requireHeader();

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new KnowledgeError('network', '连接不上服务', { cause });
  }

  if (response.status === 401) throw new KnowledgeError('unauthorized', '登录已失效', { status: 401 });
  if (!response.ok) throw new KnowledgeError('http', `服务返回 ${response.status}`, { status: response.status });

  try {
    return await response.json();
  } catch (cause) {
    throw new KnowledgeError('invalid', '接口返回的不是 JSON', { status: response.status, cause });
  }
}

/** 目录项归一：`path` 是唯一必需字段（没有它打不开条目）；其余字段缺就是缺，界面显「—」，不补默认值 */
function normalizeSummary(raw) {
  if (!isPlainObject(raw)) throw new KnowledgeError('invalid', '目录项不是对象');
  const path = stringOrNull(raw.path);
  if (!path) throw new KnowledgeError('invalid', '目录项缺少 path');
  return {
    path,
    id: stringOrNull(raw.id),
    title: stringOrNull(raw.title),
    status: stringOrNull(raw.status),
    updated: stringOrNull(raw.updated),
    revision: stringOrNull(raw.revision),
    characters: Number.isSafeInteger(raw.characters) && raw.characters >= 0 ? raw.characters : null,
  };
}

/**
 * 取整份目录。
 *
 * 不用服务端的 `q`（openapi.yaml:436-440）而是本地过滤，理由两条：稿要「即时过滤」，本地过滤零延迟；
 * 服务端带 q 时截断到 50 条（server.js:238-239），筛出来会不全。目录一次全量约 40KB / 189 条。
 *
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<{ pages: Array<object> }>}
 */
export async function listPages(options = {}) {
  const body = await requestJSON('/api/wiki/pages', options);
  if (!isPlainObject(body) || !Array.isArray(body.pages)) {
    throw new KnowledgeError('invalid', '目录接口没有返回 pages');
  }
  return { pages: body.pages.map(normalizeSummary) };
}

/**
 * 读一整页（含正文）。
 * @param {string} pagePath 形如 `common/GEN-12.md`（原样传，本函数自己编码斜杠）
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 */
export async function getPage(pagePath, options = {}) {
  const path = stringOrNull(pagePath);
  if (!path) throw new KnowledgeError('invalid', '页面路径为空');
  const body = await requestJSON(`/api/wiki/pages/${encodeURIComponent(path)}`, options);
  if (!isPlainObject(body)) throw new KnowledgeError('invalid', '页面接口返回的不是对象');
  if (typeof body.content !== 'string') throw new KnowledgeError('invalid', '页面接口没有返回正文');
  return { ...normalizeSummary({ ...body, path: stringOrNull(body.path) ?? path }), content: body.content };
}

/* ============================================================
   本机草稿
   ============================================================ */

export const DRAFTS_KEY = 'hids-wiki-drafts';

/** localStorage 不可用时的退路：storage 完全没有（例如无 localStorage 的环境）才用它 */
let memoryDrafts = null;

/** @param {Storage|null} [storage] */
function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 读出全部本机草稿：`{ [pagePath]: { title, body, savedAt } }`。
 * 没有可用的 storage 时退回本次会话的内存副本；storage 里有坏数据当一个草稿都没有。
 * @param {Storage|null} [storage]
 */
export function loadDrafts(storage) {
  const target = storageOf(storage);
  if (!target) return memoryDrafts ?? {};
  try {
    const raw = target.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写一份草稿。
 * @param {string} pagePath
 * @param {{ title: string, body: string }} draft
 * @param {{ storage?: Storage|null, now?: number }} [options]
 * @returns {{ persisted: boolean, drafts: object }} persisted=false 表示只留在本次会话里
 */
export function saveDraft(pagePath, draft, options = {}) {
  const drafts = { ...loadDrafts(options.storage) };
  drafts[pagePath] = {
    title: String(draft.title ?? ''),
    body: String(draft.body ?? ''),
    savedAt: options.now ?? Date.now(),
  };
  memoryDrafts = drafts;
  const target = storageOf(options.storage);
  let persisted = false;
  if (target) {
    try {
      target.setItem(DRAFTS_KEY, JSON.stringify(drafts));
      persisted = true;
    } catch {
      persisted = false;
    }
  }
  return { persisted, drafts };
}

/* ============================================================
   保存到服务器（P003-T002；D003 选 A）
   ============================================================ */

/** 非 2xx 时尽量取服务端原话（{error}）——但没有就不编，用调用方给的兑底文案 */
async function errorText(response, fallback) {
  try {
    const body = await response.json();
    if (isPlainObject(body) && typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  } catch {
    // 正文不是 JSON 就用兑底
  }
  return fallback;
}

/**
 * 把整篇正文写回服务器。
 *
 * 正文要连 front matter 一起发（`wiki-store.js:24-30` 的 metadata 从头部拿 id/title/status/revision），
 * `expected_revision` 是当前页面版本（`GET` 回的 `revision`，16 位十六进制），不匹配服务端回 409。
 *
 * @param {string} pagePath 形如 `common/GEN-12.md`
 * @param {string} content 整篇 Markdown（含 --- 头部）
 * @param {string} expectedRevision 当前 revision；缺失/格式不对不发请求
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options]
 * @returns {Promise<object>} 更新后的页面对象（含新的 revision / content / updated）
 * @throws {KnowledgeError} kind ∈ unauthorized | conflict（409）| http | network | invalid
 */
export async function updatePage(pagePath, content, expectedRevision, options = {}) {
  const path = stringOrNull(pagePath);
  if (!path) throw new KnowledgeError('invalid', '页面路径为空');
  if (typeof content !== 'string' || !content.trim()) throw new KnowledgeError('invalid', '正文为空');
  if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{16}$/.test(expectedRevision)) {
    throw new KnowledgeError('invalid', '缺少有效的页面版本，请刷新后重试');
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '';
  const header = requireHeader();

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/wiki/pages/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { Authorization: header, Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({ content, expected_revision: expectedRevision }),
    });
  } catch (cause) {
    throw new KnowledgeError('network', '连接不上服务', { cause });
  }

  if (response.status === 401) throw new KnowledgeError('unauthorized', '登录已失效', { status: 401 });
  if (response.status === 409) {
    // 版本过期是「别人先改了」，不是故障：页面要把当前编辑内容留着，让用户刷新后重编辑
    throw new KnowledgeError('conflict', '知识库页面已更新，请刷新后再提交', { status: 409 });
  }
  if (!response.ok) {
    throw new KnowledgeError('http', await errorText(response, `服务返回 ${response.status}`), { status: response.status });
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new KnowledgeError('invalid', '协议返回的不是 JSON', { status: response.status, cause });
  }
  if (!isPlainObject(body) || typeof body.content !== 'string') {
    throw new KnowledgeError('invalid', '保存结果没有返回正文，无法确认已落盘', { status: response.status });
  }
  return { ...normalizeSummary({ ...body, path: stringOrNull(body.path) ?? path }), content: body.content };
}

/* ============================================================
   纯文本工具
   ============================================================ */

const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** 正文头部 `---` 元数据块：接口把整篇 Markdown 原样给，读的时候不在正文里重复一遍 */
export function stripFrontMatter(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return text;
  return text.slice(end + 5).replace(/^\n+/, '');
}

/**
 * 按 `## ` 切分：首段是摘要区，其余是分节。
 * `line` 是该分节标题在**传入文本里**的行号——「小节编辑」要把光标定位到那一行。
 * @param {string} source
 * @returns {{ lead: string, sections: Array<{ title: string, line: number, text: string }> }}
 */
export function splitBody(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const lead = [];
  const sections = [];
  let current = null;
  lines.forEach((raw, index) => {
    const text = raw.trim();
    const heading = /^##\s+(.*)$/.exec(text);
    if (heading) {
      current = { title: heading[1].trim(), line: index, lines: [] };
      sections.push(current);
      return;
    }
    if (current) current.lines.push(raw);
    else lead.push(raw);
  });
  return {
    lead: lead.join('\n').trim(),
    sections: sections.map(section => ({ title: section.title, line: section.line, text: section.lines.join('\n').trim() })),
  };
}

/** 字数：去空白后的字符数（稿的口径，与接口的 characters——含头部元数据——不是一回事，报告里记了一笔） */
export const wordCount = source => String(source ?? '').replace(/\s/g, '').length;

/** 分类＝路径首段目录名（`common/GEN-12.md` → `common`；根文档 `index.md` → ''） */
export function categoryOf(pagePath) {
  const path = String(pagePath ?? '');
  const at = path.indexOf('/');
  return at > 0 ? path.slice(0, at) : '';
}

/**
 * 相对链接 → 目录内路径。`webshell/WS-13.md` + `../common/GEN-12.md` → `common/GEN-12.md`。
 * 越出根（`../../x`）返回 null。
 */
export function resolvePagePath(fromPath, target) {
  const raw = String(target ?? '').trim();
  if (!raw || raw.startsWith('/') || /^[a-z]+:/i.test(raw)) return null;
  const base = String(fromPath ?? '').split('/').slice(0, -1);
  const parts = raw.split('/');
  const stack = raw.startsWith('/') ? [] : [...base];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.length ? stack.join('/') : null;
}

/**
 * 在目录里找目标（编号 / 路径 / 去掉 .md 的路径，大小写不敏感）。
 * @param {Array<{id: string|null, path: string, title: string|null}>} pages
 * @param {string} target
 * @param {{ fromPath?: string }} [context] 相对链接要先按 fromPath 解析
 */
export function findPage(pages, target, context = {}) {
  const wanted = String(target ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const byPath = value => pages.find(page => String(page.path).toLowerCase() === value) ?? null;

  const direct = byPath(wanted);
  if (direct) return direct;
  const withoutExt = byPath(`${wanted}.md`);
  if (withoutExt) return withoutExt;
  const byId = pages.find(page => String(page.id ?? '').toLowerCase() === wanted);
  if (byId) return byId;
  if (context.fromPath) {
    const resolved = resolvePagePath(context.fromPath, target);
    if (resolved) return byPath(resolved.toLowerCase()) ?? byPath(`${resolved.toLowerCase()}.md`);
  }
  return null;
}

/* ---------- Markdown ----------
   稿的写法认 h2、- 列表、粗体、行内代码、引用、[[编号]]（wiki.html:1276-1360）；但真正文里还有
   **管道表格 99 个文件**、**围栏代码 36 个文件**、**`[文字](相对路径)` 350 处**（侦察记录 §2.4），
   少了这三样真正文读不了。这里按真正文的形态补齐，输出前一律转义。 */

function inlineMarkdown(text, options) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[\[([^\]]+)\]\]/g, (match, inner) => {
    const [target, label] = String(inner).split('|');
    return wikiLink((label ?? target).trim(), target.trim(), options);
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, target) => wikiLink(label.trim(), target.trim(), options));
  return out;
}

function wikiLink(label, target, options) {
  const page = options?.resolve?.(target) ?? null;
  const text = escapeHtml(label || target);
  if (!page) {
    return `<span class="wlink is-missing" title="条目尚未创建：${escapeHtml(target)}">${text}</span>`;
  }
  return `<a class="wlink" href="#" data-kpath="${escapeHtml(page.path)}">${text}</a>`;
}

/**
 * Markdown → HTML 字符串（结果由页面塞进 `.prose`，所有文本都经过转义）。
 * @param {string} source
 * @param {{ resolve?: (target: string) => object|null }} [options] 解析内链目标；不传时一律算「未建页」
 */
export function renderMarkdown(source, options = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(' '), options)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.tag}>${list.items.map(item => `<li>${inlineMarkdown(item, options)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${inlineMarkdown(quote.join(' '), options)}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  const tableStart = index => /^\s*\|/.test(lines[index] ?? '') && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[index + 1] ?? '');

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

    if (/^```/.test(line)) {
      flushAll();
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i += 1; }
      html.push(`<pre class="code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (tableStart(i)) {
      flushAll();
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const head = cells(lines[i]);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      i -= 1;
      html.push('<div class="k-table-wrap"><table class="md-table"><thead><tr>' +
        head.map(cell => `<th scope="col">${inlineMarkdown(cell, options)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell, options)}</td>`).join('')}</tr>`).join('') +
        '</tbody></table></div>');
      continue;
    }

    if (!line) { flushAll(); continue; }

    // 稿只认 `###` / `####`（wiki.html:1346）；真正文里还有 `# 篇名`（如 `# GEN-12 · 研判通则`），
    // 所以这里吃 `#{1,4}`，一级篇名行也归 h3——页面标题已经由接口的 title 占了 h1。见 README §9.7。
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      html.push(`<h3>${inlineMarkdown(heading[1], options)}</h3>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(bullet[1]);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(ordered[1]);
      continue;
    }

    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph(); flushList();
      quote.push(quoted[1]);
      continue;
    }

    // 列表项的续行（缩进的下一行）：接回上一条，别断成独立段落
    if (list && /^\s+\S/.test(raw) && list.items.length) {
      list.items[list.items.length - 1] += ` ${line}`;
      continue;
    }

    flushList(); flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return html.join('');
}

/** 本机时刻 `HH:MM:SS`——稿顶栏的「更新时间」就是本机时钟，接口没有这个字段（同 P002-T002 口径） */
export function formatClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  const pad = value => (value < 10 ? `0${value}` : String(value));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
