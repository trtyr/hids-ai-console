// 页面：告警列表（P002-T003）
//
// 视觉与结构照设计稿 `design/alerts.html`（左侧导航 + 顶栏由壳提供，本文件只写内容区），
// 字段与操作全部来自本仓接口（adapter 在 `web/src/alerts.js`，页面里没有 fetch）。
//
// 稿上有、接口没有 → 藏掉并记进 topics/backend-findings.md（A2）：
//   1) 筛选条（搜索 / 类型 / 等级 / 结论 / 研判状态 / 结果计数 / 清除筛选）
//      —— GET /api/alerts 只认 count 与 offset（server.js:337-339），前端自筛当前页会把它画成全量筛选。
//   2) 等级排序、时间排序按钮 —— 接口没有 sort；时间倒序是接口自己的合并顺序（cloudwalker.js:143），只保留静态箭头。
//   3) 队列条「查看 N 条失败」—— 需要按研判状态过滤，同样没有参数。
//   4) 抽屉「场景」行 —— 接口只有 scenario（= 事件类型中文名），与「事件类型」重复，不单列。
//   5) 证据来源按分类拆条 —— 接口只有 verified_facts / evidence_sources 两个数量。
//
// 「缺失证据」不在上面：TriageCase schema 没列这个键（openapi.yaml:803-816，additionalProperties: true），
// 但实现返回体里有（triage-monitor.js:108；done 态由 :385 从 verdict 填值），稿也画了（alerts.html:1139）——
// 按实现渲染，见 paintDrawer。
//
// 「共 N 条 · 更新时间 · 刷新」在稿里位于顶栏，但顶栏属壳（web/src/views/shell.js，本卡 forbidden），
// 所以落在内容区首行——只挪位置，不动壳。

import { AlertsError, enqueueTriage, fetchTriageSummary, listAlerts, setTriageEnabled } from '../src/alerts.js';

const STYLE_HREF = 'assets/pages/alerts.css';
const COLUMN_COUNT = 10;
const PAGE_SIZES = [20, 50];

const TRIAGE_LABEL = { not_queued: '未研判', queued: '排队中', running: '研判中', done: '完成', failed: '失败' };
const TRIAGE_CLASS = { queued: 'is-queued', running: 'is-running', done: 'is-done', failed: 'is-failed' };
const VERDICT_CLASS = { 真实威胁: 'verdict-threat', 存疑: 'verdict-uncertain', 误报: 'verdict-false' };
// 接口的 levelKey 有四档（low/medium/high/critical，cloudwalker.js:39），稿只有三档色点：
// critical 与 high 同用危险色（稿没有更重的色）。
const LEVEL_DOT = { low: 'sq-low', medium: 'sq-mid', high: 'sq-high', critical: 'sq-high' };
const INPUT_MODE_LABEL = { syslog: 'Syslog 推入', poll: '轮询拉取' };
// 没有结论时按研判状态说实话（不把失败写成「研判中」）
const NO_VERDICT_COPY = {
  not_queued: '未研判', queued: '排队中，暂无结论', running: '研判中，暂无结论',
  failed: '研判失败，暂无结论', done: '未产生结论',
};

const TEMPLATE = `
<div class="alerts-page">
  <div class="page-tools">
    <span class="page-total">共 <b data-role="total">—</b> 条</span>
    <span class="page-stamp"><b data-role="stamp" class="mono">—</b> 更新</span>
    <button type="button" class="textbtn" data-role="refresh">
      <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      刷新
    </button>
  </div>

  <div class="notice" data-role="partial" hidden>
    <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.4 14.4 13.6H1.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      <path d="M8 6.4v3.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      <circle cx="8" cy="11.6" r=".7" fill="currentColor" />
    </svg>
    <span><strong>部分类型查询失败</strong>，总数只合计成功的类型；<span data-role="partial-reason">—</span></span>
  </div>

  <div class="queuestrip" data-role="queue" role="group" aria-label="自动研判队列">
    <span class="qstate" data-role="qstate"><i class="dot" aria-hidden="true"></i>自动研判 <b data-role="qstate-text">—</b></span>
    <span class="qmeta">输入 <b data-role="qmode">—</b></span>
    <span class="qcounts">
      <span>排队 <b data-role="qc-queued">—</b></span>
      <span>研判中 <b data-role="qc-running">—</b></span>
      <span>完成 <b data-role="qc-done">—</b></span>
      <span class="is-danger">失败 <b data-role="qc-failed">—</b></span>
    </span>
    <span class="qmeta" data-role="qerror" hidden></span>
    <button type="button" class="textbtn" data-role="queue-toggle">暂停</button>
  </div>

  <div class="bulkbar" data-role="bulkbar" hidden>
    <span class="bulk-count">已选 <b data-role="bulk-count">0</b> 条</span>
    <div class="bulk-actions">
      <button type="button" class="btn-primary" data-role="bulk-queue">重新研判所选</button>
      <button type="button" class="textbtn" data-role="bulk-clear">清除选择</button>
    </div>
  </div>

  <div class="table-wrap" data-role="table-wrap">
    <table class="alerts">
      <caption class="sr-only">告警列表，时间倒序；点标题或告警 ID 查看摘要，可勾选后批量重新研判</caption>
      <thead>
        <tr>
          <th scope="col" class="col-check"><input type="checkbox" data-role="select-all" aria-label="全选当前页" /></th>
          <th scope="col" class="col-level">等级</th>
          <th scope="col" class="col-id">告警 ID</th>
          <th scope="col" class="col-title">告警</th>
          <th scope="col" class="col-type">类型</th>
          <th scope="col" class="col-asset">资产</th>
          <th scope="col" class="col-ip">IP</th>
          <th scope="col" class="col-state">研判状态</th>
          <th scope="col" class="col-verdict">结论</th>
          <th scope="col" class="col-time" aria-sort="descending">时间 ↓</th>
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
</div>

<div class="scrim" data-role="scrim" hidden></div>
<aside class="drawer" data-role="drawer" aria-labelledby="drawer-title" hidden>
  <div class="drawer-head">
    <div class="drawer-head-main">
      <div class="drawer-tags">
        <span class="drawer-id mono" data-role="drawer-id">—</span>
        <button type="button" class="copy-btn" data-role="copy-id" aria-label="复制告警 ID">
          <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.6" y="5.6" width="7" height="7" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M10.4 5.6V4.2A1.2 1.2 0 0 0 9.2 3H4.2A1.2 1.2 0 0 0 3 4.2v5a1.2 1.2 0 0 0 1.2 1.2h1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
        <span class="drawer-level" data-role="drawer-level">—</span>
      </div>
      <h2 id="drawer-title" data-role="drawer-title">告警摘要</h2>
      <p class="drawer-meta" data-role="drawer-meta">—</p>
    </div>
    <div class="drawer-actions">
      <a class="detail-link" data-role="drawer-detail" href="#/alerts">查看完整详情 ›</a>
      <button type="button" class="drawer-close" data-role="drawer-close" aria-label="关闭摘要">
        <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>

  <div class="drawer-body">
    <section class="drawer-block is-verdict" data-role="verdict-block" data-tone="muted">
      <span class="block-label">研判结论</span>
      <p class="verdict-big" data-role="drawer-verdict">—</p>
      <p class="report" data-role="drawer-report">—</p>
      <p class="missing" data-role="drawer-missing" hidden></p>
    </section>

    <section class="drawer-block">
      <span class="block-label">关键信息</span>
      <dl class="field-grid">
        <div><dt>资产</dt><dd data-role="drawer-asset">—</dd></div>
        <div><dt>IP</dt><dd class="mono" data-role="drawer-ip">—</dd></div>
        <div><dt>事件类型</dt><dd data-role="drawer-type">—</dd></div>
        <div><dt>事件 ID</dt><dd class="mono" data-role="drawer-event">—</dd></div>
        <div><dt>主机 ID</dt><dd class="mono" data-role="drawer-host">—</dd></div>
        <div><dt>发生时间</dt><dd class="mono" data-role="drawer-time">—</dd></div>
        <div><dt>研判状态</dt><dd data-role="drawer-state">—</dd></div>
      </dl>
    </section>

    <section class="drawer-block" data-role="drawer-steps-block" hidden>
      <span class="block-label">研判步骤</span>
      <ol class="steps" data-role="drawer-steps"></ol>
    </section>

    <section class="drawer-block">
      <span class="block-label">证据来源<span class="label-meta mono" data-role="drawer-evidence-total"></span></span>
      <ul class="evidence" data-role="drawer-evidence"></ul>
    </section>

    <details class="raw">
      <summary>原始字段</summary>
      <dl class="field-grid">
        <div><dt>eventType</dt><dd class="mono" data-role="raw-type">—</dd></div>
        <div><dt>eventId</dt><dd class="mono" data-role="raw-event">—</dd></div>
        <div><dt>hostId</dt><dd class="mono" data-role="raw-host">—</dd></div>
        <div><dt>levelKey</dt><dd class="mono" data-role="raw-level">—</dd></div>
        <div><dt>matched_alert_id</dt><dd class="mono" data-role="raw-matched">—</dd></div>
      </dl>
    </details>

    <p class="drawer-note">完整证据链、研判步骤与原始事件可在详情页查看。</p>
  </div>

  <div class="drawer-foot">
    <button type="button" class="btn-primary" data-role="drawer-queue">加入研判队列</button>
    <button type="button" class="textbtn" data-role="drawer-close-2">关闭</button>
  </div>
</aside>`;

/** 本页样式只在第一次 render 时注入一次（web/index.html 与 app.css 不归本卡，见文件头）。 */
function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="alerts"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'alerts';
  document.head.append(link);
}

const pad2 = value => String(value).padStart(2, '0');

/** ISO → `YYYY-MM-DD HH:MM:SS`（本地时区）；空值或非法时间显示「—」（照稿） */
export function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function stampOf(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 研判状态（没有 triage 时后端给 null → 未研判） */
export function triageStatusOf(alert) {
  const status = alert?.triage?.status;
  return typeof status === 'string' && Object.hasOwn(TRIAGE_LABEL, status) ? status : 'not_queued';
}

/** 结论只读 triage.verdict_label；未产生结论时 null（不拿 alert.verdict 顶上，那是占位值） */
export function verdictOf(alert) {
  const label = alert?.triage?.verdict_label;
  return label === '真实威胁' || label === '存疑' || label === '误报' ? label : null;
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

/**
 * 挂载告警页。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, now?: () => Date }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountAlertsPage(options = {}) {
  const document = globalThis.document;
  const now = options.now ?? (() => new Date());
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'alerts-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);

  const state = {
    count: PAGE_SIZES[0],
    offset: 0,
    alerts: [],
    total: 0,
    partial: false,
    partialErrors: {},
    phase: 'loading', // loading | ready | error
    error: null,
    summary: null,
    summaryError: null,
    selected: new Set(),
    openIndex: -1,
    lastTrigger: null,
    updatedAt: null,
  };

  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  // ---------- 渲染 ----------

  function announce(message) {
    $('sr-status').textContent = message;
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.total / state.count));
  }

  function paintToolbar() {
    $('total').textContent = String(state.total);
    $('stamp').textContent = state.updatedAt ? stampOf(state.updatedAt) : '—';
    $('refresh').disabled = state.phase === 'loading';
  }

  function paintNotice() {
    const notice = $('partial');
    notice.hidden = !state.partial;
    if (!state.partial) return;
    const reasons = Object.entries(state.partialErrors).map(([type, reason]) => `${type}：${reason}`);
    $('partial-reason').textContent = reasons.length ? reasons.join('；') : '未返回失败原因';
  }

  function paintQueue() {
    const summary = state.summary;
    const qstate = $('qstate');
    const toggle = $('queue-toggle');
    const qerror = $('qerror');

    if (!summary) {
      // 队列状态读不到时：不假装队列在跑，也不拿 0 充数（稿没有这一格，按登录页「无法连接」最近邻处理）
      qstate.classList.remove('is-paused');
      $('qstate-text').textContent = '状态不可用';
      $('qmode').textContent = '—';
      for (const key of ['queued', 'running', 'done', 'failed']) $(`qc-${key}`).textContent = '—';
      toggle.hidden = true;
      qerror.hidden = !state.summaryError;
      qerror.textContent = state.summaryError ? `队列状态读取失败：${state.summaryError}` : '';
      return;
    }

    toggle.hidden = false;
    qerror.hidden = true;
    const paused = summary.enabled === false;
    qstate.classList.toggle('is-paused', paused);
    $('qstate-text').textContent = paused ? '已暂停' : '运行中';
    $('qmode').textContent = INPUT_MODE_LABEL[summary.input_mode] ?? summary.input_mode ?? '—';
    toggle.textContent = paused ? '恢复' : '暂停';
    const counts = summary.counts ?? {};
    for (const key of ['queued', 'running', 'done', 'failed']) {
      $(`qc-${key}`).textContent = Number.isSafeInteger(counts[key]) ? String(counts[key]) : '—';
    }
  }

  function levelCell(alert) {
    const dot = el(document, 'i', { class: `sq ${LEVEL_DOT[alert.levelKey] ?? 'sq-low'}`, 'aria-hidden': 'true' });
    return el(document, 'span', { class: 'lvl' }, [dot, document.createTextNode(alert.level ?? '—')]);
  }

  function triageCell(alert) {
    const status = triageStatusOf(alert);
    return el(document, 'span', { class: `triage ${TRIAGE_CLASS[status] ?? ''}`.trim(), text: TRIAGE_LABEL[status] });
  }

  function verdictCell(alert) {
    const verdict = verdictOf(alert);
    if (!verdict) return el(document, 'span', { class: 'verdict-pending', text: '—' });
    return el(document, 'span', { class: `verdict ${VERDICT_CLASS[verdict]}`, text: verdict });
  }

  function rowElement(alert, index) {
    const open = () => openDrawer(index);
    const idButton = el(document, 'button', { type: 'button', class: 'cell-id', text: alert.id ?? '—', title: alert.id ?? '' });
    idButton.addEventListener('click', open);
    const titleButton = el(document, 'button', {
      type: 'button', class: 'cell-title', text: alert.title ?? '—', title: alert.title ?? '',
    });
    titleButton.addEventListener('click', open);

    const checkbox = el(document, 'input', { type: 'checkbox', 'aria-label': `选择告警 ${alert.id ?? ''}` });
    checkbox.checked = state.selected.has(alert.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(alert.id);
      else state.selected.delete(alert.id);
      paintBulk();
      announce(`已选 ${state.selected.size} 条`);
    });

    const time = formatTime(alert.createdAt);
    const cells = [
      el(document, 'td', { class: 'col-check' }, [checkbox]),
      el(document, 'td', { class: 'col-level' }, [levelCell(alert)]),
      el(document, 'td', { class: 'col-id' }, [idButton]),
      el(document, 'td', {}, [titleButton]),
      el(document, 'td', { class: 'col-type', text: alert.scenario ?? alert.eventType ?? '—' }),
      el(document, 'td', { class: 'col-asset' }, [el(document, 'span', {
        class: 'cell-asset', text: alert.asset ?? '—', title: alert.asset ?? '',
      })]),
      el(document, 'td', { class: 'col-ip' }, [el(document, 'span', { class: 'cell-ip', text: alert.assetIp || '—' })]),
      el(document, 'td', { class: 'col-state' }, [triageCell(alert)]),
      el(document, 'td', { class: 'col-verdict' }, [verdictCell(alert)]),
      el(document, 'td', { class: 'col-time' }, [el(document, 'span', { class: 'cell-time', text: time, title: time })]),
    ];
    const row = el(document, 'tr', { dataset: { index: String(index) } }, cells);
    if (state.openIndex === index) row.classList.add('is-open');
    return row;
  }

  function messageRow(text, action) {
    const cell = el(document, 'td', { colspan: String(COLUMN_COUNT) }, [document.createTextNode(text)]);
    if (action) {
      const button = el(document, 'button', { type: 'button', class: 'textbtn', text: action.label });
      button.addEventListener('click', action.onClick);
      cell.append(button);
    }
    return el(document, 'tr', { class: 'empty-row' }, [cell]);
  }

  function paintTable() {
    const body = $('rows');
    const wrap = $('table-wrap');
    wrap.classList.toggle('is-busy', state.phase === 'loading');
    if (state.phase === 'loading') wrap.setAttribute('aria-busy', 'true');
    else wrap.removeAttribute('aria-busy');

    if (state.phase === 'loading') {
      body.replaceChildren(messageRow('正在读取告警…'));
      return;
    }
    if (state.phase === 'error') {
      const { title, detail } = describeError(state.error);
      const block = el(document, 'div', { class: 'page-error', role: 'alert' });
      block.append(el(document, 'strong', { text: title }), el(document, 'p', { text: detail }));
      const retry = el(document, 'button', { type: 'button', class: 'btn-primary', text: '重试' });
      retry.addEventListener('click', () => { void load(); });
      block.append(retry);
      const cell = el(document, 'td', { colspan: String(COLUMN_COUNT) }, [block]);
      body.replaceChildren(el(document, 'tr', { class: 'empty-row' }, [cell]));
      return;
    }
    if (!state.alerts.length) {
      body.replaceChildren(messageRow(state.total === 0 ? '暂无告警。' : '本页没有告警，请回到上一页。'));
      return;
    }
    body.replaceChildren(...state.alerts.map((alert, index) => rowElement(alert, index)));
  }

  function paintPager() {
    const totalPages = pageCount();
    const start = state.alerts.length ? state.offset + 1 : 0;
    const end = state.offset + state.alerts.length;
    $('pager-info').textContent = `${start}–${end} / ${state.total} 条 · 共 ${totalPages} 页`;
    $('prev-page').disabled = state.offset === 0;
    $('next-page').disabled = state.offset + state.count >= state.total;

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

    for (const size of PAGE_SIZES) {
      $(`size-${size}`).setAttribute('aria-pressed', String(size === state.count));
    }
  }

  function paintBulk() {
    const bar = $('bulkbar');
    bar.hidden = state.selected.size === 0;
    $('bulk-count').textContent = String(state.selected.size);

    const selectAll = $('select-all');
    const onPage = state.alerts.filter(alert => state.selected.has(alert.id)).length;
    selectAll.checked = state.alerts.length > 0 && onPage === state.alerts.length;
    selectAll.indeterminate = onPage > 0 && onPage < state.alerts.length;
    selectAll.disabled = state.alerts.length === 0;
  }

  function paint() {
    paintToolbar();
    paintNotice();
    paintQueue();
    paintTable();
    paintPager();
    paintBulk();
  }

  // ---------- 抽屉 ----------

  function paintDrawer(alert) {
    const status = triageStatusOf(alert);
    const verdict = verdictOf(alert);
    const levelClass = { low: 'is-low', medium: 'is-mid', high: 'is-high', critical: 'is-high' }[alert.levelKey] ?? '';
    const verdictClass = verdict ? {
      真实威胁: 'is-threat', 存疑: 'is-uncertain', 误报: 'is-false',
    }[verdict] : 'is-pending';

    $('drawer-id').textContent = alert.id ?? '—';
    $('drawer-level').className = `drawer-level ${levelClass}`.trim();
    $('drawer-level').textContent = alert.level ?? '—';
    $('drawer-title').textContent = alert.title ?? '告警摘要';
    $('drawer-meta').textContent = [alert.asset ?? '—', alert.assetIp || '—', formatTime(alert.createdAt)].join(' · ');
    $('drawer-detail').href = `#/alert-detail/${encodeURIComponent(alert.id ?? '')}`;

    const verdictEl = $('drawer-verdict');
    verdictEl.textContent = verdict ?? NO_VERDICT_COPY[status];
    verdictEl.className = `verdict-big ${verdictClass}`;
    $('verdict-block').dataset.tone = verdict === '真实威胁' ? 'danger' : verdict === '存疑' ? 'warn' : 'muted';
    $('drawer-report').textContent = alert.triage?.report
      || (verdict ? '' : '该告警尚未产生研判结论。');

    // 缺失证据：TriageCase schema 没列该键（openapi.yaml:803-816，additionalProperties: true），
    // 实现里 status() 返回体带它（triage-monitor.js:108），done 态由 verdict 填值（:385）。
    // 稿只在 DOM 里放了空 <p>、没写文案（alerts.html:1139），文案按最近邻取「缺失证据：A、B」。
    const missing = Array.isArray(alert.triage?.missing_evidence)
      ? alert.triage.missing_evidence.filter(item => typeof item === 'string' && item.trim())
      : [];
    const missingEl = $('drawer-missing');
    missingEl.hidden = missing.length === 0;
    missingEl.replaceChildren(...(missing.length === 0 ? [] : [
      el(document, 'b', { text: '缺失证据' }),
      el(document, 'span', { text: `：${missing.join('、')}` }),
    ]));

    $('drawer-asset').textContent = alert.asset ?? '—';
    $('drawer-ip').textContent = alert.assetIp || '—';
    $('drawer-type').textContent = alert.scenario ?? alert.eventType ?? '—';
    $('drawer-event').textContent = alert.eventId === undefined || alert.eventId === null ? '—' : `#${alert.eventId}`;
    $('drawer-host').textContent = alert.hostId === null || alert.hostId === undefined ? '—' : `#${alert.hostId}`;
    $('drawer-time').textContent = formatTime(alert.createdAt);
    $('drawer-state').textContent = TRIAGE_LABEL[status];

    // 步骤：接口给 {stage, detail, at}（triage-monitor.js:343,356）；有数据才出区块，前端不生成时间线
    const steps = Array.isArray(alert.triage?.steps) ? alert.triage.steps : [];
    $('drawer-steps-block').hidden = steps.length === 0;
    $('drawer-steps').replaceChildren(...steps.map((step, index) => {
      // 稿只画了「已完成（实心）/ 处理中（空心）」两种节点，没有失败节点：
      // 失败任务的最后一步按已完成样子画（最近邻取值），不假装还在跑
      const done = index < steps.length - 1 || status === 'done' || status === 'failed';
      const item = el(document, 'li', { class: `step${done ? ' is-done' : ' is-active'}` }, [
        el(document, 'span', { class: 'step-dot', 'aria-hidden': 'true' }),
        el(document, 'span', { class: 'step-main' }, [
          el(document, 'span', { class: 'step-title', text: step.stage ?? '—' }),
          step.detail ? el(document, 'span', { class: 'step-detail', text: String(step.detail) }) : null,
        ]),
        el(document, 'span', { class: 'step-time', text: step.at ? formatTime(step.at) : '' }),
      ]);
      return item;
    }));

    // 证据：接口只有两个数量（backend-contract-gaps.md §3），不编条目与分类
    const facts = Number.isSafeInteger(alert.triage?.verified_facts) ? alert.triage.verified_facts : 0;
    const sources = Number.isSafeInteger(alert.triage?.evidence_sources) ? alert.triage.evidence_sources : 0;
    $('drawer-evidence-total').textContent = sources ? `共 ${sources} 个来源` : '';
    $('drawer-evidence').replaceChildren(
      el(document, 'li', {}, [el(document, 'span', { text: '已验证事实' }), el(document, 'span', { class: 'mono', text: `${facts} 条` })]),
      el(document, 'li', {}, [el(document, 'span', { text: '证据来源' }), el(document, 'span', { class: 'mono', text: `${sources} 个` })]),
    );

    $('raw-type').textContent = alert.eventType ?? '—';
    $('raw-event').textContent = alert.eventId === undefined || alert.eventId === null ? '—' : String(alert.eventId);
    $('raw-host').textContent = alert.hostId === null || alert.hostId === undefined ? '—' : String(alert.hostId);
    $('raw-level').textContent = alert.levelKey ?? '—';
    $('raw-matched').textContent = alert.triage?.matched_alert_id || '—';

    paintDrawerAction(alert, status);
  }

  /** 底部按钮：失败→重试、完成→重新研判、排队中/研判中→禁用并显示当前状态、未研判→加入队列 */
  function paintDrawerAction(alert, status) {
    const button = $('drawer-queue');
    button.disabled = status === 'queued' || status === 'running';
    button.textContent = {
      queued: '排队中', running: '研判中', failed: '重试', done: '重新研判', not_queued: '加入研判队列',
    }[status];
    button.dataset.alertId = alert.id ?? '';
  }

  function openDrawer(index) {
    const alert = state.alerts[index];
    if (!alert) return;
    state.lastTrigger = document.activeElement;
    state.openIndex = index;
    paintDrawer(alert);
    $('drawer').hidden = false;
    // 稿：≤760px 抽屉占满宽度，此时才上遮罩（桌面端抽屉与列表可同时操作）
    const narrow = globalThis.matchMedia?.('(max-width: 760px)')?.matches === true;
    $('scrim').hidden = !narrow;
    for (const row of $('rows').querySelectorAll('tr[data-index]')) {
      row.classList.toggle('is-open', Number(row.dataset.index) === index);
    }
    $('drawer-close').focus();
  }

  function closeDrawer() {
    const drawer = $('drawer');
    if (drawer.hidden) return;
    drawer.hidden = true;
    $('scrim').hidden = true;
    const index = state.openIndex;
    state.openIndex = -1;
    for (const row of $('rows').querySelectorAll('tr[data-index]')) row.classList.remove('is-open');
    const row = $('rows').querySelector(`tr[data-index="${index}"]`);
    const target = row?.querySelector('.cell-title') ?? state.lastTrigger;
    if (target && typeof target.focus === 'function') target.focus();
  }

  // ---------- 取数 ----------

  function describeError(error) {
    if (error instanceof AlertsError) {
      if (error.kind === 'unauthorized') return { title: '登录已失效', detail: '账号或密码不再有效，请重新登录后再打开告警。' };
      if (error.kind === 'unavailable') return { title: '告警接口不可用', detail: '服务端尚未配置牧云接口，取不到告警。' };
      if (error.kind === 'network') return { title: '无法连接', detail: '连不上研判服务，请检查网络或稍后重试。' };
      if (error.kind === 'http') return { title: '服务返回异常', detail: `告警接口返回 ${error.status ?? '未知状态码'}，请稍后重试。` };
      return { title: '返回格式异常', detail: '告警接口返回的内容不是约定结构，请联系维护人员。' };
    }
    return { title: '加载失败', detail: error?.message ?? '未知错误' };
  }

  /**
   * 取一页列表 + 队列汇总。
   * 两次请求之间后端数据可能变少：此时游标被拉回最后一页，必须跟着重拉一次，
   * 否则页脚按新 `total` 画、行区还是超界请求的空数组（「281–300 / 300 条」+「本页没有告警」）。
   * @param {boolean} [refetchOnClamp] 仅在游标真被拉回时重拉；重拉最多一次，防止数据连续缩水时空转
   */
  async function load(refetchOnClamp = true) {
    state.phase = 'loading';
    paint();
    const [alertsResult, summaryResult] = await Promise.allSettled([
      listAlerts({ count: state.count, offset: state.offset }, request),
      fetchTriageSummary(request),
    ]);

    if (alertsResult.status === 'fulfilled') {
      state.alerts = alertsResult.value.alerts;
      state.total = alertsResult.value.total;
      state.partial = alertsResult.value.partial;
      state.partialErrors = alertsResult.value.errors;
      state.phase = 'ready';
      state.error = null;
      state.updatedAt = now();
      // 总页数缩水时把游标拉回最后一页（接口数据在两次请求之间会变）
      const maxOffset = Math.max(0, (pageCount() - 1) * state.count);
      if (state.offset > maxOffset) {
        state.offset = maxOffset;
        if (refetchOnClamp) return load(false);
      }
    } else {
      state.phase = 'error';
      state.error = alertsResult.reason;
      state.alerts = [];
      state.total = 0;
      state.partial = false;
      state.partialErrors = {};
    }

    if (summaryResult.status === 'fulfilled') {
      state.summary = summaryResult.value;
      state.summaryError = null;
    } else {
      state.summary = null;
      state.summaryError = summaryResult.reason?.message ?? '未知错误';
    }

    paint();
    if (state.phase === 'ready') announce(state.total ? `已载入 ${state.alerts.length} 条，共 ${state.total} 条告警` : '暂无告警');
  }

  function goToPage(page) {
    const maxPage = pageCount();
    const target = Math.min(Math.max(1, page), maxPage);
    if (target === Math.floor(state.offset / state.count) + 1) return;
    state.offset = (target - 1) * state.count;
    closeDrawer();
    void load();
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });

  $('prev-page').addEventListener('click', () => goToPage(Math.floor(state.offset / state.count)));
  $('next-page').addEventListener('click', () => goToPage(Math.floor(state.offset / state.count) + 2));

  for (const size of PAGE_SIZES) {
    $(`size-${size}`).addEventListener('click', () => {
      if (size === state.count) return;
      state.count = size;
      state.offset = 0;
      closeDrawer();
      announce(`每页 ${size} 条`);
      void load();
    });
  }

  $('select-all').addEventListener('change', () => {
    const selectAll = $('select-all');
    for (const alert of state.alerts) {
      if (selectAll.checked) state.selected.add(alert.id);
      else state.selected.delete(alert.id);
    }
    paintTable();
    paintBulk();
    announce(`已选 ${state.selected.size} 条`);
  });

  $('bulk-clear').addEventListener('click', () => {
    state.selected.clear();
    paint();
    announce('已清除选择');
  });

  $('bulk-queue').addEventListener('click', () => { void enqueueSelected(); });

  async function enqueueSelected() {
    const ids = [...state.selected].filter(id => {
      const onPage = state.alerts.find(alert => alert.id === id);
      const status = onPage ? triageStatusOf(onPage) : null;
      return status !== 'queued' && status !== 'running';
    });
    if (!ids.length) {
      announce('所选告警都已在队列中');
      return;
    }
    const button = $('bulk-queue');
    button.disabled = true;
    let moved = 0;
    for (const id of ids) {
      try {
        await enqueueTriage(id, request);
        moved += 1;
      } catch (error) {
        announce(`入队失败：${describeError(error).detail}`);
      }
    }
    button.disabled = false;
    state.selected.clear();
    announce(moved ? `已重新入队 ${moved} 条` : '入队失败，未提交任何告警');
    await load();
  }

  $('queue-toggle').addEventListener('click', async () => {
    if (!state.summary) return;
    const button = $('queue-toggle');
    button.disabled = true;
    try {
      const next = await setTriageEnabled(state.summary.enabled === false, request);
      state.summary = next;
      state.summaryError = null;
      paintQueue();
      announce(next.enabled === false ? '自动研判已暂停' : '自动研判已恢复');
    } catch (error) {
      announce(`队列开关失败：${describeError(error).detail}`);
    } finally {
      button.disabled = false;
    }
  });

  $('drawer-queue').addEventListener('click', async () => {
    const alert = state.alerts[state.openIndex];
    if (!alert) return;
    const status = triageStatusOf(alert);
    if (status === 'queued' || status === 'running') return;
    const button = $('drawer-queue');
    button.disabled = true;
    try {
      const record = await enqueueTriage(alert.id, request);
      alert.triage = { ...(alert.triage ?? {}), ...record };
      paintDrawer(alert);
      paintTable();
      announce(`${alert.id} 已加入研判队列`);
    } catch (error) {
      button.disabled = false;
      announce(`入队失败：${describeError(error).detail}`);
    }
  });

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-close-2').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  host.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('drawer').hidden) {
      event.stopPropagation();
      closeDrawer();
    }
  });

  $('copy-id').addEventListener('click', async () => {
    const id = $('drawer-id').textContent;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(id);
      announce(`已复制告警 ID ${id}`);
    } catch {
      announce(`复制失败，请手动选择 ${id}`);
    }
  });

  void load();
  return host;
}

export const page = {
  id: 'alerts',
  title: '告警',
  navLabel: '告警',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} _context 路由参数（本页不用）
   */
  render(content, _context) {
    content.replaceChildren(mountAlertsPage());
  },
};
