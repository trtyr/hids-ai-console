// 页面：知识库（设计稿 wiki.html）
//
// 两屏一壳：条目列表（搜索 / 分类筛选 / 表格）→ 条目页（标题、元信息、目录、分节正文、
// 右侧条目信息与相关条目、接口字段），可切「编辑」页签改正文并**保存到服务器**。
//
// 数据：`web/src/knowledge.js`（本页唯一发 HTTP 的地方），三个 operation：
//   GET /api/wiki/pages            → 目录（path/id/title/status/updated/revision/characters）
//   GET /api/wiki/pages/{pagePath} → 单页 + content
//   PUT /api/wiki/pages/{pagePath} → 保存（content + expected_revision；P003-T002/D003 选 A）
// P003-T007 起编辑不再落本机草稿：保存走 PUT，页面拿响应的 revision 更新本地版本；
// 版本过期（409）不丢编辑内容，提示刷新后重编辑。
// 稿上有、接口没有的区块照 A2 藏掉（清单见报告「稿→码对照表」与 web/README.md）：
//   标签体系（无 tags 字段）、列表的摘要与分节列（列表接口没有正文）、提交审核入口
//   （POST /api/wiki/sessions 要管理员令牌，控制台没有，实测 503）。
//
// 两处与稿的位置差异（壳禁改，同 P002-T002）：顶栏的「共 N 条 · N 份草稿 · 更新时间 · 刷新」
// 落在内容区顶部一行；页面样式不能在 index.html 里挂 <link>（不在 scope），首次 render 时注入。

import {
  categoryOf,
  findPage,
  formatClock,
  getPage,
  listPages,
  renderMarkdown,
  splitBody,
  stripFrontMatter,
  updatePage,
  wordCount,
} from '../src/knowledge.js';

const STYLE_HREF = '/assets/pages/knowledge.css';

const ICON_REFRESH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

const ICON_SEARCH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" />
    <path d="M10.2 10.2 13.4 13.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>`;

const ICON_WARN = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M8 2.4 14.4 13.6H1.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    <path d="M8 6.4v3.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    <circle cx="8" cy="11.6" r=".7" fill="currentColor" />
  </svg>`;

// 静态骨架：不含任何接口数据，只有一处 innerHTML（同 P002-T002 的做法）
const TEMPLATE = `
<div class="k-bar">
  <span class="k-total">共 <b data-role="total">—</b> 条</span>
  <span class="sep-v" aria-hidden="true"></span>
  <p class="stamp"><b class="mono" data-role="stamp">—</b> 更新</p>
  <span class="sep-v" aria-hidden="true"></span>
  <button type="button" class="textbtn" data-role="refresh">${ICON_REFRESH}刷新</button>
</div>

<p class="k-notice" data-role="notice" role="alert" hidden></p>
<p class="sr-only" role="status" aria-live="polite" data-role="live"></p>

<section data-role="view-index" aria-label="条目列表">
  <div class="k-filters">
    <div class="k-search">
      ${ICON_SEARCH}
      <label class="sr-only" for="knowledge-q">搜索条目</label>
      <input id="knowledge-q" type="search" placeholder="搜索标题、编号或路径" data-role="q" autocomplete="off" />
    </div>
    <label class="sr-only" for="knowledge-cat">按分类筛选</label>
    <select id="knowledge-cat" data-role="cat"></select>
    <button type="button" class="textbtn" data-role="clear" hidden>清除筛选</button>
    <span class="k-count" data-role="count">—</span>
  </div>

  <table class="k-listing">
    <caption class="sr-only">知识库条目目录</caption>
    <thead>
      <tr>
        <th class="col-entry" scope="col">条目</th>
        <th class="col-cat" scope="col">分类</th>
        <th class="col-id" scope="col">编号</th>
        <th class="col-status" scope="col">状态</th>
      </tr>
    </thead>
    <tbody data-role="rows"></tbody>
  </table>

  <div class="k-empty" data-role="empty" hidden>
    <h2 data-role="empty-title">没有匹配的条目</h2>
    <p data-role="empty-note">换个关键词，或点「清除筛选」回到全部条目。</p>
  </div>
</section>

<section data-role="view-entry" aria-label="条目" hidden>
  <nav class="k-crumbs" data-role="crumbs" aria-label="面包屑"></nav>

  <div class="k-head">
    <div class="k-head-top">
      <div class="k-head-tags">
        <span data-role="head-cat">—</span>
        <span class="k-dot" aria-hidden="true"></span>
        <span data-role="head-status">—</span>
        <span class="k-dot" aria-hidden="true"></span>
        <span class="mono" data-role="head-id">—</span>
      </div>
      <div class="k-head-actions">
        <div class="k-seg" role="group" aria-label="条目视图">
          <button type="button" data-role="tab-read" aria-pressed="true">条目</button>
          <button type="button" data-role="tab-edit" aria-pressed="false">编辑</button>
        </div>
        <button type="button" class="textbtn" data-role="copy">复制路径</button>
      </div>
    </div>

    <h1 data-role="entry-title" tabindex="-1"></h1>

    <div class="k-head-meta">
      <span class="mono" data-role="head-path">—</span>
      <span class="k-dot" aria-hidden="true"></span>
      <span data-role="head-sections">— 节</span>
      <span class="k-dot" aria-hidden="true"></span>
      <span data-role="head-chars">— 字</span>
      <span class="k-dot" aria-hidden="true"></span>
      <span data-role="head-updated">最后修改 —</span>
      <span class="k-dot" aria-hidden="true"></span>
      <span data-role="head-source">正文来源：—</span>
      <span class="is-dirty" data-role="head-dirty" hidden>有未保存修改</span>
    </div>
  </div>

  <p class="k-notice" data-role="entry-notice" role="alert" hidden></p>

  <div class="k-body" data-role="entry-body">
    <div class="k-main-col" data-role="main-col">
      <section class="k-block">
        <div class="k-block-label"><h2>摘要</h2></div>
        <div class="k-prose k-lede" data-role="lead"></div>
      </section>

      <section class="k-block" data-role="toc-block" hidden>
        <div class="k-block-label"><h2>目录</h2><span class="k-meta" data-role="toc-count">— 节</span></div>
        <div class="k-toc" data-role="toc"></div>
      </section>

      <div data-role="sections"></div>

      <section class="k-block">
        <div class="k-block-label"><h2>分类</h2></div>
        <div class="k-cat-row" data-role="categories"></div>
      </section>
    </div>

    <aside class="k-side" aria-label="条目信息">
      <section class="k-module">
        <div class="k-module-head"><h2>条目信息</h2></div>
        <dl class="k-kv" data-role="info"></dl>
      </section>

      <section class="k-module">
        <div class="k-module-head"><h2>相关条目</h2><span class="k-meta">按分类</span></div>
        <div class="k-related" data-role="related"></div>
      </section>

      <section class="k-module">
        <div class="k-module-head"><h2>接口字段</h2></div>
        <details class="k-raw">
          <summary>GET /api/wiki/pages 返回项</summary>
          <pre class="k-raw-json" data-role="raw"></pre>
        </details>
      </section>
    </aside>
  </div>

  <div class="k-editor" data-role="editor" hidden>
    <div class="k-field">
      <label for="knowledge-edit-title">标题</label>
      <input id="knowledge-edit-title" data-role="edit-title" autocomplete="off" />
    </div>

    <div class="k-field">
      <label for="knowledge-edit-body">正文 · Markdown</label>
      <textarea id="knowledge-edit-body" data-role="edit-body" spellcheck="false"></textarea>
      <p class="k-hint">用 ## 分节；支持 - 列表、**加粗**、\`代码\`、&gt; 引用、| 表格、\`\`\` 代码块，以及 [[编号]] 条目内链。保存会把整篇正文写回服务器（带当前页面版本，版本过期会让你刷新后重编辑）。</p>
    </div>

    <div class="k-editor-foot">
      <span><span data-role="word-count">0</span> 字 · <span data-role="draft-state">—</span></span>
      <span class="k-foot-actions">
        <button type="button" class="k-btn-ghost" data-role="revert" disabled>撤销修改</button>
        <button type="button" class="k-btn-primary" data-role="save" disabled>保存到服务器</button>
      </span>
    </div>
  </div>
</section>

<dialog class="k-dialog" data-role="discard" aria-labelledby="knowledge-discard-title">
  <div class="k-dialog-head">
    <h2 id="knowledge-discard-title">这篇正文还没保存</h2>
    <p>离开会丢掉当前修改。先保存到服务器，还是直接放弃？</p>
  </div>
  <div class="k-dialog-actions">
    <button type="button" class="k-btn-primary" data-kdiscard="save">保存并离开</button>
    <button type="button" class="k-btn-ghost" data-kdiscard="drop">放弃修改</button>
    <button type="button" class="textbtn" data-kdiscard="cancel">取消</button>
  </div>
</dialog>

<div class="k-toast" role="status" aria-live="polite" data-role="toast"></div>
`;

function ensureStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-page-style="knowledge"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'knowledge';
  document.head.append(link);
}

const CLONE = draft => ({ title: draft.title, body: draft.body });

/** 错误 → 界面文案。401 是会话问题，不甩状态码；其余带码，方便运维对日志 */
function describeError(error, scope = '目录') {
  switch (error?.kind) {
    case 'unauthorized':
      return '登录已失效，请刷新页面重新登录后再试。';
    case 'network':
      return `连不上研判服务，${scope}读取失败；检查网络或后端是否在跑。`;
    case 'invalid':
      return `${scope}接口返回的数据不是预期形状（${error.message}）。`;
    default:
      if (error?.status === 404) return `${scope}不存在（404），可能已被移出知识库。`;
      return error?.status
        ? `服务返回异常（${error.status}），${scope}读取失败。`
        : `${scope}读取失败：${error?.message ?? '未知错误'}`;
  }
}

// 「这次 render 是否已被下一次取代」的序号：不缓存 DOM，只用来丢弃晚到的响应（同 P002-T002）
let renderId = 0;

export const page = {
  id: 'knowledge',
  title: '知识库',
  navLabel: '知识库',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} _context 路由参数（本页无参数）
   */
  render(content, _context) {
    ensureStylesheet();
    const mine = ++renderId;
    const isCurrent = () => mine === renderId;

    const host = document.createElement('div');
    host.className = 'knowledge';
    host.setAttribute('aria-busy', 'true');
    host.innerHTML = TEMPLATE;
    content.replaceChildren(host);

    const $ = role => host.querySelector(`[data-role="${role}"]`);
    const ui = {
      total: $('total'),
      stamp: $('stamp'),
      refresh: $('refresh'),
      notice: $('notice'),
      live: $('live'),
      viewIndex: $('view-index'),
      q: $('q'),
      cat: $('cat'),
      clear: $('clear'),
      count: $('count'),
      rows: $('rows'),
      empty: $('empty'),
      emptyTitle: $('empty-title'),
      emptyNote: $('empty-note'),
      viewEntry: $('view-entry'),
      crumbs: $('crumbs'),
      headCat: $('head-cat'),
      headStatus: $('head-status'),
      headId: $('head-id'),
      headPath: $('head-path'),
      headSections: $('head-sections'),
      headChars: $('head-chars'),
      headUpdated: $('head-updated'),
      headSource: $('head-source'),
      headDirty: $('head-dirty'),
      entryTitle: $('entry-title'),
      entryNotice: $('entry-notice'),
      entryBody: $('entry-body'),
      mainCol: $('main-col'),
      lead: $('lead'),
      tocBlock: $('toc-block'),
      tocCount: $('toc-count'),
      toc: $('toc'),
      sections: $('sections'),
      categories: $('categories'),
      info: $('info'),
      related: $('related'),
      raw: $('raw'),
      editor: $('editor'),
      tabRead: $('tab-read'),
      tabEdit: $('tab-edit'),
      copy: $('copy'),
      editTitle: $('edit-title'),
      editBody: $('edit-body'),
      wordCount: $('word-count'),
      draftState: $('draft-state'),
      save: $('save'),
      revert: $('revert'),
      discard: $('discard'),
      toast: $('toast'),
    };

    const state = {
      pages: [],
      loading: true,
      error: null,
      loadedAt: null,
      view: 'index',
      mode: 'read',
      filters: { q: '', cat: '' },
      currentPath: null,
      entry: null, // { page, working, baseline, loading, error }
      saving: false, // 保存请求在飞：按钮禁用，避免连点两次 PUT
      pendingNav: null, // 页内导航：确认后要执行的动作
      leave: null, // 页面级离开（侧栏导航 / 后退）：{ href } | { signout } | { history: true }
      lastFocus: null,
    };

    const announce = message => { ui.live.textContent = message; };

    let toastTimer = null;
    function toast(message) {
      ui.toast.textContent = message;
      ui.toast.classList.add('is-visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => ui.toast.classList.remove('is-visible'), 2600);
    }

    /* ---------- 目录 ---------- */

    const categoryLabel = path => categoryOf(path) || '—';

    function categories() {
      const seen = new Map();
      for (const item of state.pages) {
        const key = categoryOf(item.path);
        if (!key) continue;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }

    function filtered() {
      const term = state.filters.q.trim().toLowerCase();
      return state.pages.filter(item => {
        if (state.filters.cat && categoryOf(item.path) !== state.filters.cat) return false;
        if (!term) return true;
        const hay = `${item.title ?? ''} ${item.id ?? ''} ${item.path} ${categoryOf(item.path)}`.toLowerCase();
        return hay.includes(term);
      });
    }

    function renderCategoryFilter() {
      const current = state.filters.cat;
      const option = (label, value) => {
        const node = document.createElement('option');
        node.textContent = label;
        node.value = value;
        return node;
      };
      const options = [option('全部分类', '')];
      for (const [key, amount] of categories()) options.push(option(`${key}（${amount}）`, key));
      ui.cat.replaceChildren(...options);
      ui.cat.value = options.some(item => item.value === current) ? current : '';
      if (ui.cat.value !== current) state.filters.cat = ui.cat.value;
    }

    function renderRows() {
      const list = filtered();
      if (state.loading && !state.pages.length) {
        ui.rows.replaceChildren(...rowOf([{ class: 'k-loading-row', colspan: 4, text: '正在读取知识库…' }]));
        return;
      }
      ui.rows.replaceChildren(...list.map(item => {
        const tr = document.createElement('tr');
        tr.dataset.kpath = item.path;

        const titleCell = document.createElement('td');
        titleCell.className = 'col-entry';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'k-row-title';
        button.dataset.kpath = item.path;
        button.textContent = item.title ?? item.path;
        if (item.title) button.title = item.title;
        titleCell.append(button);

        tr.append(titleCell, cell('col-cat', categoryLabel(item.path)),
          cell('col-id', item.id ?? '—', 'k-cell-mono'),
          cell('col-status', item.status ?? '—', 'k-cell-status'));
        return tr;
      }));
    }

    function cell(className, content, extra) {
      const td = document.createElement('td');
      td.className = className;
      const span = document.createElement('span');
      if (extra) span.className = extra;
      span.textContent = content;
      td.append(span);
      return td;
    }

    function rowOf(rows) {
      return rows.map(({ class: className, colspan, text }) => {
        const tr = document.createElement('tr');
        if (className) tr.className = className;
        const td = document.createElement('td');
        td.colSpan = colspan;
        td.textContent = text;
        tr.append(td);
        return tr;
      });
    }

    function renderEmpty() {
      const list = filtered();
      const filteredOn = Boolean(state.filters.q.trim() || state.filters.cat);
      if (state.loading || state.error) {
        ui.empty.hidden = true;
        return;
      }
      if (!state.pages.length) {
        ui.empty.hidden = false;
        ui.emptyTitle.textContent = '知识库还没有条目';
        ui.emptyNote.textContent = '目录接口返回的 pages 是空的。';
        return;
      }
      ui.empty.hidden = list.length > 0 || !filteredOn;
      ui.emptyTitle.textContent = '没有匹配的条目';
      ui.emptyNote.textContent = '换个关键词，或点「清除筛选」回到全部条目。';
    }

    function renderIndex() {
      renderRows();
      const list = filtered();
      ui.count.replaceChildren(bold(String(list.length)), document.createTextNode(` / ${state.pages.length} 条`));
      ui.clear.hidden = !(state.filters.q.trim() || state.filters.cat);
      renderEmpty();
    }

    function bold(text) {
      const node = document.createElement('b');
      node.textContent = text;
      return node;
    }

    function renderCounts() {
      ui.total.textContent = String(state.pages.length);
      ui.stamp.textContent = state.loadedAt ? formatClock(state.loadedAt) : '—';
    }

    function setNotice(node, message, tone = 'danger') {
      if (!message) {
        node.hidden = true;
        node.replaceChildren();
        return;
      }
      node.dataset.tone = tone;
      node.replaceChildren(...(tone === 'danger' ? [warnIcon(), document.createTextNode(message)] : [document.createTextNode(message)]));
      node.hidden = false;
    }

    function warnIcon() {
      const wrap = document.createElement('span');
      wrap.innerHTML = ICON_WARN;
      return wrap.firstElementChild;
    }

    function setBusy(busy) {
      host.setAttribute('aria-busy', busy ? 'true' : 'false');
      host.classList.toggle('is-busy', busy);
      ui.refresh.disabled = busy;
      ui.q.disabled = busy;
      ui.cat.disabled = busy;
      ui.refresh.classList.toggle('is-loading', busy);
    }

    /* ---------- 条目 ---------- */

    function currentRow() {
      return state.pages.find(item => item.path === state.currentPath) ?? null;
    }

    function isDirty() {
      const { entry } = state;
      if (!entry?.working || !entry?.baseline) return false;
      return entry.working.title !== entry.baseline.title || entry.working.body !== entry.baseline.body;
    }

    function renderCrumbs() {
      const row = currentRow();
      const parts = [];
      const home = document.createElement('button');
      home.type = 'button';
      home.dataset.khome = '1';
      home.textContent = '知识库';
      parts.push(home);

      const sep = () => {
        const node = document.createElement('span');
        node.className = 'k-sep';
        node.setAttribute('aria-hidden', 'true');
        node.textContent = '/';
        return node;
      };
      parts.push(sep());

      const category = categoryOf(state.currentPath);
      if (category) {
        const catButton = document.createElement('button');
        catButton.type = 'button';
        catButton.dataset.kcat = category;
        catButton.textContent = category;
        parts.push(catButton, sep());
      }

      const id = document.createElement('span');
      id.className = 'mono';
      id.textContent = row?.id ?? state.currentPath;
      parts.push(id);
      ui.crumbs.replaceChildren(...parts);
    }

    function renderEntry() {
      const { entry } = state;
      if (!entry) return;
      const row = entry.page ?? currentRow();
      const path = state.currentPath;
      renderCrumbs();

      ui.headCat.textContent = categoryOf(path) || '—';
      ui.headStatus.textContent = row?.status ?? '—';
      ui.headId.textContent = row?.id ?? '—';
      ui.headPath.textContent = path;
      ui.copy.disabled = false;

      if (entry.loading) {
        setNotice(ui.entryNotice, null);
        ui.entryTitle.textContent = row?.title ?? path;
        ui.headSections.textContent = '— 节';
        ui.headChars.textContent = '— 字';
        ui.headUpdated.textContent = `最后修改 ${row?.updated ?? '—'}`;
        ui.headSource.textContent = '正文来源：读取中';
        ui.headDirty.hidden = true;
        ui.lead.replaceChildren(text('正在读取正文…'));
        ui.tocBlock.hidden = true;
        ui.toc.replaceChildren();
        ui.sections.replaceChildren();
        ui.categories.replaceChildren(text('—', 'k-cat-empty'));
        ui.info.replaceChildren();
        ui.related.replaceChildren(text('—', 'k-related-empty'));
        ui.raw.textContent = '{}';
        return;
      }

      if (entry.error) {
        // partial：目录还在（面包屑能回列表），只有这一条的正文没取到
        const notice = document.createElement('span');
        notice.append(text(`${describeError(entry.error, '正文')} 列表仍可返回。`));
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'textbtn';
        retry.dataset.kretry = '1';
        retry.textContent = '重试';
        notice.append(retry);
        setNotice(ui.entryNotice, null);
        ui.entryNotice.dataset.tone = 'danger';
        ui.entryNotice.replaceChildren(warnIcon(), notice);
        ui.entryNotice.hidden = false;

        ui.entryTitle.textContent = row?.title ?? path;
        ui.headSections.textContent = '— 节';
        ui.headChars.textContent = '— 字';
        ui.headUpdated.textContent = `最后修改 ${row?.updated ?? '—'}`;
        ui.headSource.textContent = '正文来源：—';
        ui.headDirty.hidden = true;
        ui.lead.replaceChildren();
        ui.tocBlock.hidden = true;
        ui.sections.replaceChildren();
        ui.categories.replaceChildren(text('—', 'k-cat-empty'));
        ui.info.replaceChildren();
        ui.related.replaceChildren(text('—', 'k-related-empty'));
        ui.raw.textContent = '{}';
        return;
      }

      setNotice(ui.entryNotice, null);

      const body = entry.working.body;
      const parts = splitBody(body);
      ui.entryTitle.textContent = entry.working.title || path;
      ui.headSections.textContent = `${parts.sections.length} 节`;
      ui.headChars.textContent = `${wordCount(body)} 字`;
      ui.headUpdated.textContent = `最后修改 ${row?.updated ?? '—'}`;
      // 正文可能是接口拿的、也可能是刚保存回服务器的：都是服务器上的那一版，未落盘的改动由「有未保存修改」表达
      ui.headSource.textContent = '正文来源：服务器正文';
      ui.headDirty.hidden = !isDirty();

      const resolve = target => findPage(state.pages, target, { fromPath: path });
      const options = { resolve };

      ui.lead.innerHTML = parts.lead
        ? renderMarkdown(parts.lead, options)
        : '<p>这一条没有摘要——接口给的正文直接从第一节开始。</p>';

      if (parts.sections.length) {
        ui.tocBlock.hidden = false;
        ui.tocCount.textContent = `${parts.sections.length} 节`;
        ui.toc.replaceChildren(...parts.sections.map((section, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.ksec = `k-sec-${index}`;
          const idx = document.createElement('span');
          idx.className = 'k-idx';
          idx.textContent = String(index + 1).padStart(2, '0');
          button.append(idx, document.createTextNode(section.title));
          return button;
        }));

        ui.sections.replaceChildren(...parts.sections.map((section, index) => {
          const block = document.createElement('section');
          block.className = 'k-block';
          block.id = `k-sec-${index}`;

          const label = document.createElement('div');
          label.className = 'k-block-label';
          const heading = document.createElement('h2');
          heading.textContent = section.title;
          const edit = document.createElement('button');
          edit.type = 'button';
          edit.className = 'textbtn';
          edit.dataset.kline = String(section.line);
          edit.setAttribute('aria-label', `编辑小节：${section.title}`);
          edit.textContent = '编辑';
          label.append(heading, edit);

          const prose = document.createElement('div');
          prose.className = 'k-prose';
          prose.innerHTML = renderMarkdown(section.text, options);

          block.append(label, prose);
          return block;
        }));
      } else {
        ui.tocBlock.hidden = true;
        ui.toc.replaceChildren();
        ui.sections.replaceChildren();
      }

      const category = categoryOf(path);
      if (category) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'k-cat-link';
        button.dataset.kfiltercat = category;
        button.textContent = category;
        ui.categories.replaceChildren(button);
      } else {
        ui.categories.replaceChildren(text('尚未分类', 'k-cat-empty'));
      }

      renderInfo(row, parts);
      renderRelated(row);
      ui.raw.textContent = JSON.stringify(row ?? {}, null, 2);
    }

    function text(value, className) {
      const span = document.createElement('span');
      if (className) span.className = className;
      span.textContent = value;
      return span;
    }

    function renderInfo(row, parts) {
      const rows = [
        ['编号', row?.id ?? '—', true],
        ['路径', state.currentPath, true],
        ['状态', row?.status ?? '—'],
        ['分类', categoryOf(state.currentPath) || '—'],
        ['分节', `${parts.sections.length} 节`],
        ['字数', `${wordCount(state.entry.working.body)} 字`],
        ['修订', row?.revision ?? '—', true],
        ['最后修改', row?.updated ?? '—'],
      ];
      ui.info.replaceChildren(...rows.map(([key, value, mono]) => {
        const wrap = document.createElement('div');
        wrap.className = 'k-kv-row';
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        if (mono) dd.className = 'mono';
        dd.textContent = value;
        wrap.append(dt, dd);
        return wrap;
      }));
    }

    function renderRelated(row) {
      const category = categoryOf(state.currentPath);
      const related = state.pages
        .filter(item => item.path !== state.currentPath && category && categoryOf(item.path) === category)
        .slice(0, 4);
      if (!related.length) {
        ui.related.replaceChildren(text(category ? '这个分类下没有别的条目' : '根文档没有同分类的条目', 'k-related-empty'));
        return;
      }
      ui.related.replaceChildren(...related.map(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.kpath = item.path;
        const title = document.createElement('span');
        title.className = 'k-rel-title';
        title.textContent = item.title ?? item.path;
        const meta = document.createElement('span');
        meta.className = 'k-rel-meta';
        meta.textContent = `${item.id ?? '—'} · ${item.status ?? '—'}`;
        button.append(title, meta);
        return button;
      }));
    }

    /* ---------- 视图切换 ---------- */

    function showIndex({ focusSearch = false } = {}) {
      state.view = 'index';
      state.mode = 'read';
      state.currentPath = null;
      state.entry = null;
      ui.viewIndex.hidden = false;
      ui.viewEntry.hidden = true;
      ui.editor.hidden = true;
      renderCategoryFilter();
      renderIndex();
      renderCounts();
      syncLeaveGuard();
      if (focusSearch) ui.q.focus();
    }

    function openEntry(path, { force = false } = {}) {
      if (!path) return;
      if (isDirty() && !force) {
        state.pendingNav = () => openEntry(path, { force: true });
        openDialog(ui.discard, '[data-kdiscard="save"]');
        return;
      }
      state.view = 'entry';
      state.mode = 'read';
      state.currentPath = path;
      state.entry = { page: currentRow(), working: null, baseline: null, loading: true, error: null };
      ui.viewIndex.hidden = true;
      ui.viewEntry.hidden = false;
      ui.editor.hidden = true;
      mountMode();
      renderEntry();
      loadEntry(path);
      ui.entryTitle.focus();
    }

    async function loadEntry(path) {
      const minePath = path;
      const entry = state.entry;
      try {
        const pageData = await getPage(path);
        if (!isCurrent() || state.currentPath !== minePath || state.entry !== entry) return;
        entry.page = pageData;
        const body = stripFrontMatter(pageData.content ?? '');
        const title = (pageData.title || path).trim();
        entry.working = { title, body };
        entry.baseline = CLONE(entry.working);
        entry.loading = false;
        entry.error = null;
        renderEntry();
        if (state.mode === 'edit') fillEditor();
        updateFoot();
        announce(`已打开 ${title}`);
      } catch (error) {
        if (!isCurrent() || state.currentPath !== minePath || state.entry !== entry) return;
        entry.loading = false;
        entry.error = error;
        renderEntry();
        updateFoot();
        announce(`正文读取失败`);
      }
    }

    function mountMode() {
      const editing = state.mode === 'edit' && state.view === 'entry';
      ui.tabRead.setAttribute('aria-pressed', editing ? 'false' : 'true');
      ui.tabEdit.setAttribute('aria-pressed', editing ? 'true' : 'false');
      ui.entryBody.hidden = editing;
      ui.editor.hidden = !editing;
      if (editing) fillEditor();
    }

    function setMode(next) {
      if (state.view !== 'entry' || state.mode === next) return;
      state.mode = next;
      mountMode();
      if (next === 'edit') {
        ui.editTitle.focus();
        return;
      }
      renderEntry();
      ui.entryTitle.focus();
    }

    function fillEditor() {
      const { entry } = state;
      if (!entry?.working) return;
      if (ui.editTitle.value !== entry.working.title) ui.editTitle.value = entry.working.title;
      if (ui.editBody.value !== entry.working.body) ui.editBody.value = entry.working.body;
      updateFoot();
    }

    function updateFoot() {
      const { entry } = state;
      if (!entry?.working) {
        ui.wordCount.textContent = '0';
        ui.draftState.textContent = '—';
        ui.save.disabled = true;
        ui.revert.disabled = true;
        ui.headDirty.hidden = true;
        syncLeaveGuard();
        return;
      }
      const dirty = isDirty();
      const body = entry.working.body;
      const revision = typeof entry.page?.revision === 'string' && /^[0-9a-f]{16}$/.test(entry.page.revision);
      ui.wordCount.textContent = String(wordCount(body));
      if (dirty) ui.draftState.replaceChildren(text('未保存的修改', 'is-dirty'));
      else ui.draftState.replaceChildren(document.createTextNode(revision ? '已保存到服务器' : '尚未修改'));
      ui.save.disabled = !dirty || !revision || state.saving;
      ui.revert.disabled = !dirty;
      ui.headDirty.hidden = !dirty;
      ui.headChars.textContent = `${wordCount(body)} 字`;
      ui.headSections.textContent = `${splitBody(body).sections.length} 节`;
      syncLeaveGuard();
    }

    function editAtLine(line) {
      if (!state.entry?.working) return;
      state.mode = 'edit';
      mountMode();
      const textarea = ui.editBody;
      const lines = textarea.value === '' ? [] : textarea.value.split('\n');
      const limit = Math.min(Math.max(Number(line) || 0, 0), Math.max(lines.length - 1, 0));
      let offset = 0;
      for (let i = 0; i < limit; i += 1) offset += lines[i].length + 1;
      textarea.focus();
      if (typeof textarea.setSelectionRange === 'function') {
        textarea.setSelectionRange(offset, offset + (lines[limit]?.length ?? 0));
      }
    }

    /**
     * 拼回整篇 Markdown：原来的 front matter + 编辑区正文。
     * 服务端要求 id/status 不变、evidence/source 仍在（wiki-store.js:159-188），所以头部整段原样带回去；
     * 标题改过就把 `title:` 那一行改写（标题存在头部元数据里，正文里不重复）。
     */
    function composeContent(entry) {
      const source = String(entry.page?.content ?? '');
      const body = entry.working.body;
      if (!source.startsWith('---\n')) return body;
      const end = source.indexOf('\n---\n', 3);
      if (end < 0) return body;
      const head = source.slice(0, end + 5);
      const originalTitle = String(entry.page?.title ?? '').trim();
      const title = entry.working.title.trim();
      let nextHead = head;
      if (title && title !== originalTitle) {
        // 页面可能没有 title 行（metadata() 会退回一级标题），那就补一行在头部开头
        nextHead = /^title:.*$/m.test(head)
          ? head.replace(/^title:.*$/m, `title: ${title}`)
          : head.replace(/^---\n/, `---\ntitle: ${title}\n`);
      }
      return `${nextHead}${body}`;
    }

    /** 保存失败 → 结果条：409 是「别人先改了」，正文留着，给刷新入口；其余照实说 */
    function showSaveError(error) {
      ui.entryNotice.dataset.tone = 'danger';
      const wrap = document.createElement('span');
      wrap.append(text(error?.kind === 'conflict'
        ? '知识库页面已被别人更新，当前修改还留在编辑器里；刷新正文会丢掉它们。'
        : `保存失败：${error?.message ?? '未知错误'}`));
      if (error?.kind === 'conflict') {
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'textbtn';
        reload.dataset.kreload = '1';
        reload.textContent = '刷新正文';
        wrap.append(reload);
      }
      ui.entryNotice.replaceChildren(warnIcon(), wrap);
      ui.entryNotice.hidden = false;
    }

    /**
     * 保存到服务器（PUT，带 expected_revision）。
     * @returns {Promise<boolean>} true = 已落盘；false = 没保存（正文与脏标记都留着）
     */
    async function saveToServer(announceResult) {
      const entry = state.entry;
      if (!state.currentPath || !entry?.working || !isDirty() || state.saving) return false;
      state.saving = true;
      updateFoot();
      let saved = false;
      try {
        const page = await updatePage(state.currentPath, composeContent(entry), entry.page?.revision ?? '');
        if (!isCurrent() || state.entry !== entry) return true;
        entry.page = page;
        entry.baseline = CLONE(entry.working);
        setNotice(ui.entryNotice, null);
        renderEntry();
        saved = true;
      } catch (error) {
        if (!isCurrent() || state.entry !== entry) return false;
        showSaveError(error);
        if (announceResult) {
          const message = error?.kind === 'conflict' ? '页面已被别人更新，请刷新后重试' : `保存失败：${error?.message ?? '未知错误'}`;
          toast(message);
          announce(message);
        }
      } finally {
        state.saving = false;
        if (isCurrent() && state.entry === entry) updateFoot();
      }
      if (saved && announceResult) {
        toast('已保存到服务器');
        announce('已保存到服务器');
      }
      return saved;
    }

    /* ---------- 弹窗 ---------- */

    function openDialog(dialog, focusSelector) {
      state.lastFocus = document.activeElement;
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      const target = focusSelector ? dialog.querySelector(focusSelector) : dialog.querySelector('button, input, textarea');
      if (target) target.focus();
    }

    function closeDialog(dialog, restoreFocus = true) {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      if (restoreFocus && state.lastFocus && typeof state.lastFocus.focus === 'function') state.lastFocus.focus();
    }

    function guardThen(action) {
      if (!isDirty()) {
        action();
        return;
      }
      state.pendingNav = action;
      openDialog(ui.discard, '[data-kdiscard="save"]');
    }

    /* ---------- 数据 ---------- */

    async function load({ keepEntry = false } = {}) {
      setBusy(true);
      state.loading = true;
      state.error = null;
      if (state.view === 'index') renderIndex();
      announce('正在读取知识库目录');
      try {
        const { pages } = await listPages();
        if (!isCurrent()) return;
        state.pages = pages;
        state.loadedAt = new Date();
        state.loading = false;
        renderCategoryFilter();
        renderIndex();
        renderCounts();
        setNotice(ui.notice, null);
        // 有未保存修改就不重取正文——刷新只换目录，草稿不能被接口数据盖掉（稿 §4「保留未保存修改」）
        if (keepEntry && state.view === 'entry' && state.currentPath && !isDirty()) {
          loadEntry(state.currentPath);
        }
        announce(`目录已更新，共 ${pages.length} 条`);
      } catch (error) {
        if (!isCurrent()) return;
        state.loading = false;
        state.error = error;
        renderIndex();
        renderCounts();
        setNotice(ui.notice, describeError(error), 'danger');
        announce(`知识库目录读取失败`);
      } finally {
        if (isCurrent()) setBusy(false);
      }
    }

    /* ---------- 事件 ---------- */

    ui.rows.addEventListener('click', event => {
      const trigger = event.target.closest('[data-kpath]');
      if (trigger) guardThen(() => openEntry(trigger.dataset.kpath));
    });

    ui.q.addEventListener('input', () => {
      state.filters.q = ui.q.value;
      renderIndex();
    });
    ui.cat.addEventListener('change', () => {
      state.filters.cat = ui.cat.value;
      renderIndex();
    });
    ui.clear.addEventListener('click', () => {
      state.filters = { q: '', cat: '' };
      ui.q.value = '';
      ui.cat.value = '';
      renderIndex();
      ui.q.focus();
    });

    ui.refresh.addEventListener('click', () => {
      if (ui.refresh.disabled) return;
      const dirty = isDirty();
      load({ keepEntry: true });
      if (dirty) toast('已刷新目录，当前条目的未保存修改保留着');
    });

    ui.crumbs.addEventListener('click', event => {
      if (event.target.closest('[data-khome]')) {
        guardThen(() => showIndex({ focusSearch: true }));
        return;
      }
      const cat = event.target.closest('[data-kcat]');
      if (cat) {
        guardThen(() => {
          state.filters = { q: '', cat: cat.dataset.kcat };
          showIndex();
          renderIndex();
        });
      }
    });

    ui.tabRead.addEventListener('click', () => setMode('read'));
    ui.tabEdit.addEventListener('click', () => setMode('edit'));

    ui.mainCol.addEventListener('click', event => {
      const edit = event.target.closest('[data-kline]');
      if (edit) {
        editAtLine(Number(edit.dataset.kline));
        return;
      }
      const section = event.target.closest('[data-ksec]');
      if (section) {
        const target = host.querySelector(`#${section.dataset.ksec}`);
        if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
        return;
      }
      const filterCat = event.target.closest('[data-kfiltercat]');
      if (filterCat) {
        guardThen(() => {
          state.filters = { q: '', cat: filterCat.dataset.kfiltercat };
          showIndex();
          renderIndex();
        });
        return;
      }
      const link = event.target.closest('[data-kpath]');
      if (link) {
        event.preventDefault();
        guardThen(() => openEntry(link.dataset.kpath));
      }
    });

    ui.related.addEventListener('click', event => {
      const trigger = event.target.closest('[data-kpath]');
      if (trigger) guardThen(() => openEntry(trigger.dataset.kpath));
    });

    ui.entryNotice.addEventListener('click', event => {
      if (event.target.closest('[data-kretry]') && state.currentPath) loadEntry(state.currentPath);
      // 409 之后「刷新正文」：用服务器上的最新版本重取（会覆盖手里的修改，按钮文案已经说清楚）
      if (event.target.closest('[data-kreload]') && state.currentPath) {
        setNotice(ui.entryNotice, null);
        void loadEntry(state.currentPath);
      }
    });

    ui.copy.addEventListener('click', () => {
      if (!state.currentPath) return;
      copyText(state.currentPath);
    });

    function copyText(value) {
      const fallback = () => {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.append(area);
        area.select();
        let done = false;
        try {
          done = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        } catch {
          done = false;
        }
        area.remove();
        toast(done ? `已复制路径 ${value}` : '复制失败，请手动选择路径');
      };
      const clipboard = (host.ownerDocument?.defaultView ?? globalThis).navigator?.clipboard;
      if (clipboard?.writeText) {
        clipboard.writeText(value).then(() => toast(`已复制路径 ${value}`), fallback);
        return;
      }
      fallback();
    }

    ui.editTitle.addEventListener('input', () => {
      if (!state.entry?.working) return;
      state.entry.working.title = ui.editTitle.value;
      updateFoot();
    });

    ui.editTitle.addEventListener('blur', () => {
      const entry = state.entry;
      if (!entry?.working) return;
      if (!ui.editTitle.value.trim()) {
        entry.working.title = entry.baseline.title;
        ui.editTitle.value = entry.baseline.title;
        updateFoot();
      }
    });

    ui.editBody.addEventListener('input', () => {
      if (!state.entry?.working) return;
      state.entry.working.body = ui.editBody.value;
      updateFoot();
    });

    ui.save.addEventListener('click', () => { void saveToServer(true); });

    ui.revert.addEventListener('click', () => {
      const entry = state.entry;
      if (!entry?.working || !isDirty()) return;
      entry.working = CLONE(entry.baseline);
      fillEditor();
      updateFoot();
      toast('已撤销到上次保存的版本');
    });

    ui.discard.addEventListener('click', event => {
      const action = event.target.closest('[data-kdiscard]');
      if (!action) return;
      const kind = action.dataset.kdiscard;
      const next = state.pendingNav;
      const leave = state.leave;
      state.pendingNav = null;
      state.leave = null;

      if (kind === 'cancel') {
        closeDialog(ui.discard);
        return;
      }
      // 先把「正在离开」的旗立上：saveToServer → updateFoot → syncLeaveGuard 不该再去 history.back()，
      // 否则它会把刚跳走的导航拉回守卫条目上。
      if (leave) guardLeaving = true;
      if (kind === 'drop' && state.entry) {
        state.entry.working = CLONE(state.entry.baseline);
        state.mode = 'read';
      }
      closeDialog(ui.discard, false);
      const proceed = async () => {
        // 「保存并离开」：保存没成功就不离开（正文留着，结果条给原因），不假装存了再把人带走
        if (kind === 'save' && isDirty()) {
          const ok = await saveToServer(false);
          if (!ok) {
            guardLeaving = false;
            return;
          }
        }
        if (leave) performLeave(leave);
        else if (typeof next === 'function') next();
      };
      void proceed();
    });

    // Esc 关闭走浏览器原生的 cancel → close，绕过了 closeDialog()：收尾要在这里做一份，
    // 否则 pendingNav 留着旧动作、焦点落在 body 上不再回到原控件（第三轮审查 minor）。
    ui.discard.addEventListener('close', () => {
      state.pendingNav = null;
      state.leave = null;
      const active = host.ownerDocument?.activeElement;
      if (state.lastFocus && typeof state.lastFocus.focus === 'function' &&
        (!active || active === host.ownerDocument.body)) {
        state.lastFocus.focus();
      }
    });

    /* ---------- 页面级离开守卫（侧栏导航 / 浏览器后退 / 关页面） ---------- */
    // 三条离开路径都不经过本页的事件处理：
    //   1. 壳侧栏导航（`shell.js:36-38` 的 `a.nav-item[href="#/…"]`）与「退出登录」按钮——壳挂载后不再
    //      通知页面（壳禁改），只能在 document 捕获阶段 preventDefault，再用同一个确认弹窗收。
    //   2. 浏览器后退——同文档后退不触发 beforeunload；app.js 的 hashchange 会在同一次派发里先换掉页面 DOM。
    //      脏时压一条**同 URL 的守卫条目**：后退只会在同 URL 上 popstate、不触发 hashchange，页面不被重建，
    //      草稿还在；用户选完再 go(-2) 放行。
    //   3. 关标签页 / 刷新——脏时挂 beforeunload，干净时摘掉。
    const GUARD_STATE = { knowledgeUnsavedGuard: true };
    let guardArmed = false; // 守卫条目已在 history 里
    let guardLeaving = false; // 用户已确认离开，别再拦
    let guardSelfPops = 0; // 自己 history.back() 引起的 popstate，不算用户后退
    let unloadArmed = false;
    const win = host.ownerDocument?.defaultView ?? globalThis;

    function onBeforeUnload(event) {
      if (!isDirty() || guardLeaving) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    }

    function armGuard() {
      try {
        win.history.pushState(GUARD_STATE, '', win.location.href);
        guardArmed = true;
      } catch {
        guardArmed = false;
      }
    }

    function disarmGuard() {
      if (!guardArmed) return;
      guardArmed = false;
      guardSelfPops += 1;
      try {
        win.history.back();
      } catch {
        guardSelfPops -= 1;
      }
    }

    /** 脏标记变真/变假时同步三件套；`updateFoot()` 与 `showIndex()` 是脏标记翻转的两个收口 */
    function syncLeaveGuard() {
      const dirty = isDirty() && !guardLeaving;
      if (dirty && !guardArmed) armGuard();
      else if (!dirty && !guardLeaving) disarmGuard();
      if (dirty && !unloadArmed) {
        win.addEventListener('beforeunload', onBeforeUnload);
        unloadArmed = true;
      } else if (!dirty && unloadArmed) {
        win.removeEventListener('beforeunload', onBeforeUnload);
        unloadArmed = false;
      }
    }

    function openLeaveConfirm(leave) {
      state.pendingNav = null;
      state.leave = leave;
      openDialog(ui.discard, '[data-kdiscard="save"]');
    }

    function onDocClick(event) {
      if (!host.isConnected) {
        detachLeaveGuard();
        return;
      }
      const target = event.target;
      if (guardLeaving || !isDirty() || !target?.closest) return;
      if (host.contains(target)) return;
      const link = target.closest('a[href^="#/"]');
      const signout = target.closest('[data-role="signout"]');
      if (!link && !signout) return;
      // 锚点是默认行为导航（壳没挂 click 监听），preventDefault 就足够把跳转按在原地
      event.preventDefault();
      event.stopPropagation();
      openLeaveConfirm(signout ? { signout } : { href: link.getAttribute('href') });
    }

    function onPopState() {
      if (!host.isConnected) {
        detachLeaveGuard();
        return;
      }
      if (guardSelfPops > 0) {
        guardSelfPops -= 1;
        return;
      }
      if (!isDirty() || guardLeaving) return;
      // 回到的是同 URL 的那一条：把守卫重新压回去，等用户选完再放行
      armGuard();
      if (ui.discard.open) return;
      openLeaveConfirm({ history: true });
    }

    function performLeave(leave) {
      guardLeaving = true;
      detachLeaveGuard();
      if (leave.signout) {
        leave.signout.click();
        return;
      }
      if (leave.history) {
        try {
          win.history.go(-2);
        } catch { /* 历史不够深就留在原地，不编导航 */ }
        return;
      }
      if (leave.href) {
        try {
          win.location.hash = leave.href;
        } catch { /* 地址非 hash 路由时不动，也不算离开成功 */ }
      }
    }

    // 页面模块没有 unmount 钩子（router.js 的 page 契约只有 render）→ 新页 replaceChildren 时自己摘监听，
    // 否则旧页会在后台继续拦导航。MutationObserver 负责「立刻」，事件里的 isConnected 负责兜底。
    const leaveWatcher = typeof win.MutationObserver === 'function'
      ? new win.MutationObserver(() => { if (!host.isConnected) detachLeaveGuard(); })
      : null;
    leaveWatcher?.observe(content, { childList: true });

    function detachLeaveGuard() {
      guardLeaving = true;
      leaveWatcher?.disconnect();
      win.removeEventListener('popstate', onPopState, true);
      win.removeEventListener('beforeunload', onBeforeUnload);
      host.ownerDocument?.removeEventListener('click', onDocClick, true);
      unloadArmed = false;
    }

    host.ownerDocument?.addEventListener('click', onDocClick, true);
    win.addEventListener('popstate', onPopState, true);

    host.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (state.mode !== 'edit' || !isDirty()) return;
        event.preventDefault();
        void saveToServer(true);
      }
    });

    showIndex();
    load();
  },
};
