// 页面：深度溯源 · 列表（P003-T016 起；D015 / D020）
//
// 这一页回答「看哪一条」，不画链：进去先是列表，点一行才进这一条的白板（`#/trace-board/<id>`）。
// 列照 D015：告警（类型 + 能认出来的短标识）/ 主机 / 告警时间 / 状态 / 链长 / 断点 / 更新时间。
// 不在列表上放结论（威胁 / 误报）——那是告警分析的事（D015）。
//
// 数据来源：形态 B，`GET /api/trace/boards`（openapi.yaml:456-500）。筛选与分页全部下推给接口：
//   status（可逗号多选，这里只做单选）/ type / host（精确）/ from（时间下拉只算 from，to 不传＝到现在）
//   另加 count / offset。前端不自筛——自筛会破坏 `total` 与分页。
//
// 稿（`design/trace.html`）里没有这张列表：稿是「左列表 + 右白板」同屏，D015 明写这个形态不对。
// 表格语言取同仓告警主列表（`pages/alerts.js` 的 `.filters` / `.table-wrap` / `.pager` 与 `alerts.css` 的列宽口径），
// 这是同页最近邻（同一套壳、同一个内容区宽度）；稿的白板部分整块搬到 `pages/trace-board.js`。
// 逐条记账见 `coding-reports/P003-T016.md` 的稿→码对照表与「未决」。

import { listTraceBoards } from '../src/trace.js';
import {
  describeTraceError, eventTypeLabel, formatStamp, shortBoardId, statusClass, statusLabel,
} from '../src/trace-view.js';

const STYLE_HREF = 'assets/pages/trace.css';
const COLUMN_COUNT = 7;
const PAGE_SIZES = [20, 50];

// 事件类型筛选项：与后端 eventTypes（cloudwalker.js:2-6）一一对应，中文名在 `src/trace-view.js`
const TYPE_OPTIONS = ['webshell', 'malware', 'revshell', 'memory_webshell', 'brute_force', 'abnormal_login',
  'elevation_process', 'network_audit', 'suspicious_operation', 'honeypot', 'memory_security']
  .map(type => [type, eventTypeLabel(type)]);

// 状态筛选项：四个真值（openapi.yaml:1728-1731），不摆接口不认的值
const STATUS_OPTIONS = [['running', '进行中'], ['done', '已完成'], ['failed', '失败'], ['interrupted', '中断']];

// 时间范围只算 from（与告警页同口径：to 不传＝到现在）
const TIME_OPTIONS = [['24h', '近 24 小时', 24 * 60 * 60 * 1000], ['7d', '近 7 天', 7 * 24 * 60 * 60 * 1000],
  ['30d', '近 30 天', 30 * 24 * 60 * 60 * 1000]];

const ICON_REFRESH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
const ICON_SEARCH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" />
    <path d="M10.2 10.2 13.4 13.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>`;

const TEMPLATE = `
<div class="trace-list">
  <div class="page-tools">
    <span class="page-total">共 <b data-role="total">—</b> 条</span>
    <button type="button" class="textbtn" data-role="refresh">
      ${ICON_REFRESH}
      刷新
    </button>
  </div>

  <div class="notice" data-role="notice" role="alert" hidden>
    <span><strong>刷新失败</strong>，<span data-role="notice-text">—</span>（下表是上一次读到的结果）</span>
    <button type="button" class="textbtn" data-role="retry">重试</button>
  </div>

  <div class="filters" role="group" aria-label="筛选">
    <select data-role="filter-status" aria-label="按状态筛选">
      <option value="">全部状态</option>
      ${STATUS_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>

    <select data-role="filter-type" aria-label="按事件类型筛选">
      <option value="">全部类型</option>
      ${TYPE_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>

    <div class="search">
      ${ICON_SEARCH}
      <input type="search" data-role="filter-host" placeholder="主机 IP（精确匹配）" aria-label="按主机 IP 筛选" />
    </div>

    <select data-role="filter-time" aria-label="按告警时间筛选">
      <option value="">全部时间</option>
      ${TIME_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>

    <button type="button" class="textbtn" data-role="clear-filters" hidden>清除筛选</button>
    <span class="filter-count" data-role="filter-count"></span>
  </div>

  <div class="table-wrap" data-role="table-wrap">
    <table class="trace-boards">
      <caption class="sr-only">溯源列表，最近的在后；点一行看这一条是怎么触发的。</caption>
      <thead>
        <tr>
          <th scope="col" class="col-alert">告警</th>
          <th scope="col" class="col-host">主机</th>
          <th scope="col" class="col-time">告警时间</th>
          <th scope="col" class="col-state">状态</th>
          <th scope="col" class="col-chain">链长</th>
          <th scope="col" class="col-gaps">断点</th>
          <th scope="col" class="col-updated">更新时间</th>
        </tr>
      </thead>
      <tbody data-role="rows"></tbody>
    </table>
  </div>

  <div class="pager">
    <span class="pager-info" data-role="pager-info">—</span>
    <div class="pager-btns">
      <button type="button" class="page-btn" data-role="prev-page">上一页</button>
      <span class="pager-nums" data-role="page-numbers"></span>
      <button type="button" class="page-btn" data-role="next-page">下一页</button>
    </div>
    <div class="pagesize" role="group" aria-label="每页条数">
      <span class="pagesize-label">每页</span>
      <button type="button" data-role="size-20" aria-pressed="true">20</button>
      <button type="button" data-role="size-50" aria-pressed="false">50</button>
    </div>
  </div>

  <p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
</div>`;

/** 本页样式只在第一次 render 时注入一次（web/index.html 与 app.css 不归本卡）。 */
function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="trace"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'trace';
  document.head.append(link);
}

function el(document, tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** 告警那一格：「类型（中文）+ 短标识」，整格是一条去白板的真链接。 */
export function alertCell(document, board) {
  const id = String(board?.id ?? '');
  const type = eventTypeLabel(board?.type) ?? '告警';
  const link = el(document, 'a', {
    class: 'board-link',
    href: `#/trace-board/${encodeURIComponent(id)}`,
    'aria-label': `打开 ${type} ${id} 的溯源白板`,
  }, [
    el(document, 'span', { class: 'board-type', text: type }),
    document.createTextNode(' '),
    el(document, 'span', { class: 'board-short mono', text: shortBoardId(id), title: id }),
  ]);
  return el(document, 'td', { class: 'col-alert' }, [link]);
}

/**
 * 挂载深度溯源列表页。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, now?: () => Date }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountTracePage(options = {}) {
  const document = globalThis.document;
  const now = options.now ?? (() => new Date());
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'trace-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  const state = {
    count: PAGE_SIZES[0],
    offset: 0,
    boards: [],
    total: 0,
    filters: { status: '', type: '', host: '', time: '' },
    phase: 'loading',   // loading | ready | error —— 首次加载
    error: null,
    staleError: null,   // 已有数据、这次刷新失败（partial）
  };

  function announce(message) {
    const node = $('sr-status');
    if (node) node.textContent = message;
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.total / state.count));
  }

  function filtersActive() {
    const { status, type, host, time } = state.filters;
    return Boolean(status || type || host || time);
  }

  /** 时间范围 → `from`（只算 from；每次取数按当前时刻重算，同告警页口径）。 */
  function fromOf() {
    const option = TIME_OPTIONS.find(([value]) => value === state.filters.time);
    return option ? new Date(now().getTime() - option[2]).toISOString() : undefined;
  }

  function paintToolbar() {
    $('total').textContent = String(state.total);
    $('refresh').disabled = state.phase === 'loading';
    $('refresh').classList.toggle('is-loading', state.phase === 'loading');
  }

  function paintFilters() {
    $('clear-filters').hidden = !filtersActive();
    $('filter-count').textContent = filtersActive() && state.phase === 'ready' ? `筛选后 ${state.total} 条` : '';
    const disabled = state.phase === 'loading';
    for (const role of ['filter-status', 'filter-type', 'filter-host', 'filter-time']) $(role).disabled = disabled;
  }

  function paintNotice() {
    const notice = $('notice');
    if (!state.staleError || !state.boards.length) {
      notice.hidden = true;
      $('notice-text').textContent = '—';
      return;
    }
    notice.hidden = false;
    $('notice-text').textContent = describeTraceError(state.staleError);
  }

  function messageRow(copy, action) {
    const cell = el(document, 'td', { colspan: String(COLUMN_COUNT) }, [document.createTextNode(copy)]);
    if (action) {
      const button = el(document, 'button', { type: 'button', class: 'textbtn', text: action.label });
      button.addEventListener('click', action.onClick);
      cell.append(button);
    }
    return el(document, 'tr', { class: 'empty-row' }, [cell]);
  }

  function statusCell(board) {
    const status = String(board?.status ?? '');
    return el(document, 'span', { class: `state ${statusClass(status)}`.trim() }, [
      el(document, 'span', { text: statusLabel(status) }),
    ]);
  }

  function rowElement(board) {
    const id = String(board?.id ?? '');
    const hostIp = board?.host || '—';
    const occurred = formatStamp(board?.occurred_at);
    const updated = formatStamp(board?.updated_at);
    const chain = Number.isSafeInteger(board?.chain_length) ? `${board.chain_length} 跳` : '—';
    const gaps = board?.has_gaps === true ? '有' : '没有';
    const cells = [
      alertCell(document, board),
      el(document, 'td', { class: 'col-host' }, [el(document, 'span', { class: 'cell-ip mono od-truncate', text: hostIp, title: hostIp })]),
      el(document, 'td', { class: 'col-time' }, [el(document, 'span', { class: 'cell-time', text: occurred, title: occurred })]),
      el(document, 'td', { class: 'col-state' }, [statusCell(board)]),
      el(document, 'td', { class: 'col-chain mono', text: chain }),
      el(document, 'td', { class: `col-gaps${board?.has_gaps === true ? ' is-gap' : ''}`.trim(), text: gaps }),
      el(document, 'td', { class: 'col-updated' }, [el(document, 'span', { class: 'cell-time', text: updated, title: updated })]),
    ];
    // 整行可点（D015「点一行才进这一条」）：链接是入口，键盘走链接；行点击只是给鼠标省一步。
    const row = el(document, 'tr', { class: 'board-row', dataset: { boardId: id } }, cells);
    row.addEventListener('click', event => {
      if (event.target.closest('a')) return;
      const target = globalThis.window?.location;
      if (target) target.hash = `#/trace-board/${encodeURIComponent(id)}`;
    });
    return row;
  }

  function paintTable() {
    const body = $('rows');
    const wrap = $('table-wrap');
    if (state.phase === 'loading') wrap.setAttribute('aria-busy', 'true');
    else wrap.removeAttribute('aria-busy');

    if (state.phase === 'loading') {
      body.replaceChildren(messageRow('正在读取溯源…'));
      return;
    }
    if (state.phase === 'error') {
      const block = el(document, 'div', { class: 'page-error', role: 'alert' });
      block.append(
        el(document, 'strong', { text: '溯源列表读取失败' }),
        el(document, 'p', { text: describeTraceError(state.error) }),
      );
      const retry = el(document, 'button', { type: 'button', class: 'btn-primary', text: '重试' });
      retry.addEventListener('click', () => { void load(); });
      block.append(retry);
      body.replaceChildren(el(document, 'tr', { class: 'empty-row' }, [el(document, 'td', { colspan: String(COLUMN_COUNT) }, [block])]));
      return;
    }
    if (!state.boards.length) {
      body.replaceChildren(filtersActive()
        ? messageRow('没有匹配的溯源。', { label: '清除筛选', onClick: () => { clearFilters(); } })
        : messageRow('暂无溯源。从告警列表点某一行的「溯源」，就会带着这条告警的 ID 起一条。'));
      return;
    }
    body.replaceChildren(...state.boards.map(rowElement));
  }

  function paintPager() {
    const totalPages = pageCount();
    const start = state.boards.length ? state.offset + 1 : 0;
    const end = state.offset + state.boards.length;
    $('pager-info').textContent = `${start}–${end} / ${state.total} 条 · 共 ${totalPages} 页`;
    $('prev-page').disabled = state.offset === 0 || state.phase !== 'ready';
    $('next-page').disabled = state.offset + state.count >= state.total || state.phase !== 'ready';

    const page = Math.floor(state.offset / state.count) + 1;
    const numbers = [];
    for (let p = 1; p <= totalPages; p += 1) {
      if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) numbers.push(p);
    }
    const nodes = [];
    let previous = 0;
    for (const p of numbers) {
      if (previous && p - previous > 1) nodes.push(el(document, 'span', { class: 'page-gap', text: '…' }));
      const button = el(document, 'button', { type: 'button', class: 'page-btn', text: String(p) });
      if (p === page) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => goToPage(p));
      nodes.push(button);
      previous = p;
    }
    $('page-numbers').replaceChildren(...nodes);

    for (const size of PAGE_SIZES) $(`size-${size}`).setAttribute('aria-pressed', String(size === state.count));
  }

  function paint() {
    paintToolbar();
    paintFilters();
    paintNotice();
    paintTable();
    paintPager();
  }

  async function load() {
    const first = state.phase !== 'ready';
    if (first) state.phase = 'loading';
    paint();
    const query = {
      count: state.count,
      offset: state.offset,
      statuses: state.filters.status ? [state.filters.status] : [],
      type: state.filters.type || undefined,
      host: state.filters.host.trim() || undefined,
      from: fromOf(),
    };
    try {
      const { boards, total } = await listTraceBoards(query, request);
      state.boards = boards;
      state.total = total;
      state.phase = 'ready';
      state.error = null;
      state.staleError = null;
    } catch (error) {
      if (state.boards.length) {
        // 已有数据：刷新失败只挂一条提示，表格保持上一次的结果（partial）
        state.staleError = error;
      } else {
        state.phase = 'error';
        state.error = error;
        state.boards = [];
        state.total = 0;
      }
    }
    paint();
    if (state.phase === 'error') announce(`溯源列表读取失败：${describeTraceError(state.error)}`);
    else if (state.staleError) announce(`刷新失败：${describeTraceError(state.staleError)}`);
    else announce(`溯源列表已更新，共 ${state.total} 条`);
  }

  function goToPage(page) {
    state.offset = Math.max(0, (page - 1) * state.count);
    void load();
  }

  function clearFilters() {
    state.filters = { status: '', type: '', host: '', time: '' };
    $('filter-status').value = '';
    $('filter-type').value = '';
    $('filter-host').value = '';
    $('filter-time').value = '';
    state.offset = 0;
    void load();
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });
  $('retry').addEventListener('click', () => { void load(); });
  $('filter-status').addEventListener('change', event => {
    state.filters.status = event.target.value;
    state.offset = 0;
    void load();
  });
  $('filter-type').addEventListener('change', event => {
    state.filters.type = event.target.value;
    state.offset = 0;
    void load();
  });
  $('filter-host').addEventListener('change', event => {
    state.filters.host = event.target.value;
    state.offset = 0;
    void load();
  });
  $('filter-host').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    state.filters.host = $('filter-host').value;
    state.offset = 0;
    void load();
  });
  $('filter-time').addEventListener('change', event => {
    state.filters.time = event.target.value;
    state.offset = 0;
    void load();
  });
  $('clear-filters').addEventListener('click', () => clearFilters());
  $('prev-page').addEventListener('click', () => goToPage(Math.max(1, Math.floor(state.offset / state.count))));
  $('next-page').addEventListener('click', () => goToPage(Math.floor(state.offset / state.count) + 2));
  for (const size of PAGE_SIZES) {
    $(`size-${size}`).addEventListener('click', () => {
      if (state.count === size) return;
      state.count = size;
      state.offset = 0;
      void load();
    });
  }

  void load();

  return host;
}

export const page = {
  id: 'trace',
  title: '深度溯源',
  navLabel: '深度溯源',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} [context] 路由参数（列表页不读参数；`#/trace/<id>` 只当列表看）
   */
  render(content, _context) {
    content.replaceChildren(mountTracePage());
  },
};
