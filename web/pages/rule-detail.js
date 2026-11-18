// 页面：规则 · 原文（P003-T017 起；`#/rules/<id>`；D017 / D020）
//
// D017：「上面是名字和这句话在放行什么。下面就是这段 Rego，原样。不编译成表单，不藏到后面。」
// 所以这一页只有三样：名字、一句话、`<pre>` 里的整份 `.rego` 原文（含注释与空行，逐字返回，不裁剪）。
// **页面上没有编辑入口**（A3）：没有 input / textarea / contenteditable，Rego 用 `<pre>` 而不是文本域。
//
// 数据来源：形态 B，`GET /api/rules/{id}`（openapi.yaml:664-684），adapter 在 `src/rego-rules.js`。
// id 不存在（404）→ adapter 返回 null → 页面写「规则库里已没有这条」，不抛错、不白屏。
//
// 设计稿：`design/rules.html` 是旧程序门禁编辑页（D017：「不要当成这个」），本页无稿；
// `<pre>` 的视觉取同仓告警详情「命中的规则」那块（`assets/pages/alert-detail.css:153-166` 的 `.rego`），
// 逐条记账见 `coding-reports/P003-T017.md`。

import { describeRegoRulesError, getRegoRule } from '../src/rego-rules.js';

const STYLE_HREF = 'assets/pages/rego-rules.css';

const ICON_REFRESH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

const TEMPLATE = `
<div class="rego-detail">
  <div class="page-tools">
    <a class="textbtn back-link" href="#/rules">← 规则列表</a>
    <button type="button" class="textbtn" data-role="refresh">
      ${ICON_REFRESH}
      刷新
    </button>
  </div>

  <div class="notice" data-role="notice" role="alert" hidden>
    <span><strong>刷新失败</strong>，<span data-role="notice-text">—</span>（下面是上一次读到的原文）</span>
    <button type="button" class="textbtn" data-role="notice-retry">重试</button>
  </div>

  <div class="rule-body" data-role="body">
    <header class="rule-head" data-role="head">
      <h2 data-role="name">规则</h2>
      <p class="what" data-role="what">—</p>
      <p class="rule-meta">
        <span class="rule-id mono" data-role="rule-id"></span>
        <span class="rule-file mono" data-role="file"></span>
      </p>
    </header>

    <div class="rego-wrap" data-role="rego-wrap">
      <pre class="rego-block mono" data-role="rego" aria-label="这条规则的 Rego 原文"></pre>
    </div>

    <div data-role="fallback" hidden></div>
  </div>

  <p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
</div>`;

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

/**
 * 挂载规则原文页。
 * @param {string} ruleId 路由第二段（`#/rules/ssh_bruteforce` → `ssh_bruteforce`）
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountRuleDetailPage(ruleId, options = {}) {
  const document = globalThis.document;
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'rego-detail-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };
  const id = String(ruleId ?? '');

  const state = {
    rule: null,       // ready 后是 adapter 归一过的规则对象
    phase: 'loading', // loading | ready | missing（404）| error
    error: null,
    staleError: null, // 已有原文、这次刷新失败（partial）
  };

  function announce(message) {
    const node = $('sr-status');
    if (node) node.textContent = message;
  }

  function paintTools() {
    $('refresh').disabled = state.phase === 'loading';
    $('refresh').classList.toggle('is-loading', state.phase === 'loading');
  }

  function paintNotice() {
    const notice = $('notice');
    if (!state.staleError || !state.rule) {
      notice.hidden = true;
      $('notice-text').textContent = '—';
      return;
    }
    notice.hidden = false;
    $('notice-text').textContent = describeRegoRulesError(state.staleError);
  }

  /** 三种非 ready 态（loading / missing / error）都换掉原文两块，避免把上一次的原文和新错误拼在一起。 */
  function paintBody() {
    const wrap = $('rego-wrap');
    if (state.phase === 'loading') wrap.setAttribute('aria-busy', 'true');
    else wrap.removeAttribute('aria-busy');

    if (state.phase === 'loading' || state.phase === 'ready') {
      $('head').hidden = false;
      wrap.hidden = false;
      $('fallback').hidden = true;
      $('fallback').replaceChildren();
      const rule = state.rule;
      $('name').textContent = rule ? rule.name : '正在读取规则…';
      $('what').textContent = rule ? (rule.description ?? '这条规则没写一句话说明。') : '—';
      $('what').classList.toggle('is-muted', !rule || !rule.description);
      $('rule-id').textContent = rule ? rule.id : id;
      $('file').textContent = rule?.file ? `· ${rule.file}` : '';
      $('rego').textContent = rule ? rule.rego : '';
      return;
    }

    // missing / error：一条说明 + 出口（missing 不摆「重试」——库里没有这条，重试也读不出来）
    $('head').hidden = true;
    wrap.hidden = true;
    const block = el(document, 'div', { class: 'page-error', role: 'alert' });
    if (state.phase === 'missing') {
      block.append(
        el(document, 'strong', { text: '规则库里已没有这条' }),
        el(document, 'p', { text: `没有 id 为「${id}」的规则，可能已经被删掉或改过 id。` }),
        el(document, 'a', { class: 'btn-primary', href: '#/rules', text: '回规则列表' }),
      );
    } else {
      block.append(
        el(document, 'strong', { text: '规则原文读取失败' }),
        el(document, 'p', { text: describeRegoRulesError(state.error) }),
      );
      const retry = el(document, 'button', { type: 'button', class: 'btn-primary', text: '重试' });
      retry.addEventListener('click', () => { void load(); });
      block.append(retry);
    }
    $('fallback').hidden = false;
    $('fallback').replaceChildren(block);
  }

  function paint() {
    paintTools();
    paintNotice();
    paintBody();
  }

  async function load() {
    if (!state.rule) state.phase = 'loading';
    paint();
    try {
      const rule = await getRegoRule(id, request);
      if (rule === null) {
        state.phase = 'missing';
        state.rule = null;
        state.error = null;
        state.staleError = null;
      } else {
        state.rule = rule;
        state.phase = 'ready';
        state.error = null;
        state.staleError = null;
      }
    } catch (error) {
      if (state.rule) {
        state.staleError = error; // 已有原文：刷新失败只挂提示，不把原文清掉
      } else {
        state.phase = 'error';
        state.error = error;
      }
    }
    paint();
    if (state.phase === 'missing') announce(`规则库里已没有 id 为 ${id} 的规则`);
    else if (state.phase === 'error') announce(`规则原文读取失败：${describeRegoRulesError(state.error)}`);
    else if (state.staleError) announce(`刷新失败：${describeRegoRulesError(state.staleError)}`);
    else announce(`已读到规则 ${state.rule?.name ?? id} 的 Rego 原文`);
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });
  $('notice-retry').addEventListener('click', () => { void load(); });

  void load();

  return host;
}
