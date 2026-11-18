// 页面：规则 · 列表（P003-T017 起；D017 / D020）
//
// 规则是 OPA 的 Rego，不是 JSON（D017）。这一页回答「现在有哪些规则」：
// 进去先是表，列是 名字 / 一句话 / 效果 / 开没开 / 从哪来；点一行看这一条的 Rego 原文（`#/rules/<id>`）。
// 这一轮页面上不能编辑（D020）：本页与原文页都没有 input / textarea / 可编辑控件。
//
// 数据来源：形态 B，`GET /api/rules`（openapi.yaml:623-639），adapter 在 `src/rego-rules.js`。
// 列表只给元数据 `{ id, name, description, file }`，原文用 `GET /api/rules/{id}` 单取。
//
// **三列是展示默认值，不是接口字段**（群主 2026-11-19 拍板，报告「未决 1」记账）：
//   效果  —— 「放行」：D017 明写这轮只有放行，别的效果没定，先不发明
//   开没开 —— 「开」：规则库里装载着的规则就是在用的，没有「关掉」的数据
//   从哪来 —— 「未标注」：接口没有来源字段，不许猜成「人建的」或「误报反哺的」
// 这三列的来源、以及为什么不做筛选，写进 `web/README.md` §13.6。
//
// 设计稿：`design/rules.html` 是**旧程序门禁编辑页**（D017：「不要当成这个」），新页没有稿。
// 表格语言取同仓最近邻 `pages/trace.js` / `trace.css`（同一个壳、同一个内容区宽度），逐条记账见报告。

import { describeRegoRulesError, listRegoRules } from '../src/rego-rules.js';
import { mountRuleDetailPage } from './rule-detail.js';

const STYLE_HREF = 'assets/pages/rego-rules.css';
const COLUMN_COUNT = 5;

/** 三列的展示默认值（接口没有对应字段）。原文页也用它，页面上只有这一处定义。 */
export const DISPLAY_DEFAULTS = {
  effect: '放行',
  enabled: '开',
  source: '未标注',
};

/** 展示默认值的口径说明（挂在表头上，鼠标悬停能看见；页面底部还有一行同口径的脚注）。 */
export const DISPLAY_HINTS = {
  effect: '这轮只有放行，别的效果没定（D017）',
  enabled: '规则库里装载着的规则就是在用的',
  source: '接口没有来源字段，不猜是人建的还是误报反哺的',
};

const ICON_REFRESH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

const TEMPLATE = `
<div class="rego-rules">
  <div class="page-tools">
    <span class="page-total">共 <b data-role="total">—</b> 条</span>
    <button type="button" class="textbtn" data-role="refresh">
      ${ICON_REFRESH}
      刷新
    </button>
  </div>

  <div class="notice" data-role="notice" role="alert" hidden>
    <span><strong>刷新失败</strong>，<span data-role="notice-text">—</span>（下表是上一次读到的规则）</span>
    <button type="button" class="textbtn" data-role="retry">重试</button>
  </div>

  <div class="table-wrap" data-role="table-wrap">
    <table class="rego-table">
      <caption class="sr-only">规则库；点一条规则的名字看它的 Rego 原文。</caption>
      <thead>
        <tr>
          <th scope="col" class="col-name">名字</th>
          <th scope="col" class="col-what">一句话</th>
          <th scope="col" class="col-effect">效果</th>
          <th scope="col" class="col-state">开没开</th>
          <th scope="col" class="col-source">从哪来</th>
        </tr>
      </thead>
      <tbody data-role="rows"></tbody>
    </table>
  </div>

  <p class="rules-note" data-role="note">
    效果、开没开、从哪来三列是展示默认：接口只给名字和一句话，这三项还没有数据。
  </p>

  <p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
</div>`;

/** 本页样式只在第一次 render 时注入一次（web/index.html 与 app.css 不归本卡）。 */
function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="rego-rules"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'rego-rules';
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

/** 规则 id → 原文页的 hash（id 是 `[a-z0-9_]`，仍然编码一次，不拼裸串）。 */
export function ruleHref(id) {
  return `#/rules/${encodeURIComponent(String(id ?? ''))}`;
}

/**
 * 挂载规则列表页。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountRulesPage(options = {}) {
  const document = globalThis.document;
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'rego-rules-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  const state = {
    rules: [],
    count: 0,
    phase: 'loading', // loading | ready | error（首次加载）
    error: null,
    staleError: null, // 已有数据、这次刷新失败（partial）
  };

  function announce(message) {
    const node = $('sr-status');
    if (node) node.textContent = message;
  }

  function paintToolbar() {
    $('total').textContent = state.phase === 'ready' ? String(state.count) : '—';
    $('refresh').disabled = state.phase === 'loading';
    $('refresh').classList.toggle('is-loading', state.phase === 'loading');
  }

  function paintNotice() {
    const notice = $('notice');
    if (!state.staleError || !state.rules.length) {
      notice.hidden = true;
      $('notice-text').textContent = '—';
      return;
    }
    notice.hidden = false;
    $('notice-text').textContent = describeRegoRulesError(state.staleError);
  }

  function messageRow(copy) {
    return el(document, 'tr', { class: 'empty-row' }, [
      el(document, 'td', { colspan: String(COLUMN_COUNT), text: copy }),
    ]);
  }

  /** 一行：名字是去原文页的真链接，整行点击也过去（键盘走链接）。 */
  function rowElement(rule) {
    const name = String(rule?.name ?? '') || String(rule?.id ?? '');
    const nameCell = el(document, 'td', { class: 'col-name' }, [
      el(document, 'a', {
        class: 'rule-link od-truncate',
        href: ruleHref(rule?.id),
        title: rule?.file ? `${name} · ${rule.file}` : name,
        'aria-label': `打开规则 ${name} 的 Rego 原文`,
        text: name,
      }),
    ]);

    const what = rule?.description || '未写说明';
    const whatCell = el(document, 'td', { class: `col-what${rule?.description ? '' : ' is-muted'}`.trim() }, [
      el(document, 'span', { class: 'cell-text od-truncate', text: what, title: what }),
    ]);

    const effectCell = el(document, 'td', { class: 'col-effect' }, [
      el(document, 'span', { class: 'chip', text: DISPLAY_DEFAULTS.effect, title: DISPLAY_HINTS.effect }),
    ]);
    const stateCell = el(document, 'td', { class: 'col-state' }, [
      el(document, 'span', { class: 'state-on', text: DISPLAY_DEFAULTS.enabled, title: DISPLAY_HINTS.enabled }),
    ]);
    const sourceCell = el(document, 'td', { class: 'col-source is-muted' }, [
      el(document, 'span', { class: 'cell-text', text: DISPLAY_DEFAULTS.source, title: DISPLAY_HINTS.source }),
    ]);

    const row = el(document, 'tr', { class: 'rule-row', dataset: { ruleId: String(rule?.id ?? '') } },
      [nameCell, whatCell, effectCell, stateCell, sourceCell]);
    row.addEventListener('click', event => {
      if (event.target.closest('a')) return;
      const target = globalThis.window?.location;
      if (target) target.hash = ruleHref(rule?.id);
    });
    return row;
  }

  function paintTable() {
    const body = $('rows');
    const wrap = $('table-wrap');
    if (state.phase === 'loading') wrap.setAttribute('aria-busy', 'true');
    else wrap.removeAttribute('aria-busy');

    if (state.phase === 'loading') {
      body.replaceChildren(messageRow('正在读取规则库…'));
      return;
    }
    if (state.phase === 'error') {
      const block = el(document, 'div', { class: 'page-error', role: 'alert' });
      block.append(
        el(document, 'strong', { text: '规则库读取失败' }),
        el(document, 'p', { text: describeRegoRulesError(state.error) }),
      );
      const retry = el(document, 'button', { type: 'button', class: 'btn-primary', text: '重试' });
      retry.addEventListener('click', () => { void load(); });
      block.append(retry);
      body.replaceChildren(el(document, 'tr', { class: 'empty-row' }, [
        el(document, 'td', { colspan: String(COLUMN_COUNT) }, [block]),
      ]));
      return;
    }
    if (!state.rules.length) {
      body.replaceChildren(messageRow('规则库还没有规则。'));
      return;
    }
    body.replaceChildren(...state.rules.map(rowElement));
  }

  function paint() {
    paintToolbar();
    paintNotice();
    paintTable();
  }

  async function load() {
    const first = state.phase !== 'ready';
    if (first) state.phase = 'loading';
    paint();
    try {
      const { rules, count } = await listRegoRules(request);
      state.rules = rules;
      state.count = count;
      state.phase = 'ready';
      state.error = null;
      state.staleError = null;
    } catch (error) {
      if (state.rules.length) {
        // 已有数据：刷新失败只挂提示，表格保持上一次读到的规则（partial）
        state.staleError = error;
      } else {
        state.phase = 'error';
        state.error = error;
        state.rules = [];
        state.count = 0;
      }
    }
    paint();
    if (state.phase === 'error') announce(`规则库读取失败：${describeRegoRulesError(state.error)}`);
    else if (state.staleError) announce(`刷新失败：${describeRegoRulesError(state.staleError)}`);
    else announce(`规则库已更新，共 ${state.count} 条`);
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });
  $('retry').addEventListener('click', () => { void load(); });

  void load();

  return host;
}

export const page = {
  id: 'rules',
  title: '规则',
  navLabel: '规则',
  /**
   * 一个模块两屏：没有参数是列表（D017「进去先是表」），带一段 id 是这条规则的 Rego 原文。
   * 路由是 `#/rules` 与 `#/rules/<id>`（壳只认第一段，参数原样交回来，router.js:36-46）。
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} [context] 路由参数
   */
  render(content, context = {}) {
    const [ruleId] = context.params ?? [];
    content.replaceChildren(ruleId ? mountRuleDetailPage(ruleId) : mountRulesPage());
  },
};
