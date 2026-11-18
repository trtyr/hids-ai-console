// 页面：前置规则（P002-T006）
//
// 视觉与结构照设计稿 `design/rules.html`（左侧导航 + 顶栏由壳提供，本文件只写内容区）：
// 左侧编辑面板（头部：标题 + revision + 可写徽标 + 未保存标记 + 表单/JSON 切换 + 撤销修改 + 复制 JSON；
// 中间：按 config 递归生成的表单 / 带行号的 JSON 视图；底部：JSON 状态 + 光标行列）
// + 右侧 320px 操作栏（状态 / 校验 / 保存 / 操作日志）。
//
// 数据只来自本仓接口（adapter 在 `web/src/rules.js`，页面里没有 fetch）：
//   GET  /api/triage/rules → config / revision / writable
//   POST /api/triage/rules/validate → { valid, count }
//   PUT  /api/triage/rules → 新 revision（带 expected_revision + X-Rule-Admin-Token）
//
// 稿的立场（rules-notes.md:10）照做：config 在文档里是自由对象，**页面不预设规则字段**，
// 表单按真实 config 递归生成。实现侧真正的约束（schema_version / enabled / rules 三键，triage-rules.js:126-138）
// 不由前端猜，校验失败时把服务端原话显示出来。
//
// 稿上有、接口没有 / 稿是演示的，处理在 `docs` 之外记进 topics/backend-findings.md（A2）：
//   1) 稿的演示数据（revision 常量、admin-token、setTimeout 模拟的校验与保存）——一律不搬；
//   2) 稿的「保存成功自己造 revision」——用 PUT 返回的真 revision；
//   3) 稿的顶栏「刷新」——顶栏属壳（forbidden），刷新落到内容区首行（与 T005 同一条处理）；
//   4) 稿的「知识库未定稿占位 + 导航拦截」——导航与占位由壳负责，本页不重画。

import { getRules, saveRules, validateRules } from '../src/rules.js';

const STYLE_HREF = 'assets/pages/rules.css';
const VALUE_TYPES = [
  ['string', '字符串'],
  ['number', '数字'],
  ['boolean', '布尔'],
  ['object', '对象'],
  ['array', '数组'],
];

const TEMPLATE = `
<div class="rules-tools">
  <button type="button" class="textbtn" data-role="refresh">
    <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    刷新
  </button>
</div>

<div class="notice" data-role="error" role="alert" hidden>
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.4 14.4 13.6H1.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    <path d="M8 6.4v3.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    <circle cx="8" cy="11.6" r=".7" fill="currentColor" />
  </svg>
  <span><strong data-role="error-title">规则配置读取失败</strong>，<span data-role="error-text">—</span></span>
  <button type="button" class="textbtn" data-role="retry">重试</button>
</div>

<div class="rules-shell" data-role="shell">
  <section class="editor-pane" aria-label="规则配置编辑器">
    <div class="pane-head">
      <div class="title-block">
        <h2>前置规则</h2>
        <span class="rev mono" data-role="rev-label">—</span>
        <span class="badge" data-role="writable-badge">—</span>
        <span class="dirty" data-role="dirty" hidden>未保存</span>
      </div>
      <div class="pane-actions">
        <div class="view-switch" role="group" aria-label="编辑视图">
          <button type="button" data-view="form" data-role="view-form" aria-pressed="true">表单</button>
          <button type="button" data-view="json" data-role="view-json" aria-pressed="false">JSON</button>
        </div>
        <button type="button" class="textbtn" data-role="reset" disabled>撤销修改</button>
        <button type="button" class="textbtn" data-role="copy">复制 JSON</button>
      </div>
    </div>

    <div class="form-wrap" data-role="form-wrap">
      <div class="form" data-role="form"></div>
    </div>

    <div class="editor-wrap" data-role="json-wrap" hidden>
      <pre class="gutter" data-role="gutter" aria-hidden="true">1</pre>
      <textarea data-role="config" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="规则配置 JSON"></textarea>
    </div>

    <div class="editor-foot">
      <span class="syntax" data-role="syntax">JSON 有效</span>
      <span class="mono" data-role="cursor-info">表单视图</span>
    </div>
  </section>

  <aside class="side" aria-label="规则操作">
    <section class="panel">
      <h3>状态</h3>
      <p class="field-note field-note--lead">config 的结构由后端定义，页面只按 JSON 原样编辑，不做字段假设。</p>
      <dl class="kv">
        <div class="kv-row"><dt>revision</dt><dd data-role="rev-value">—</dd></div>
        <div class="kv-row"><dt>可写</dt><dd data-role="writable-value">—</dd></div>
        <div class="kv-row"><dt>条目数</dt><dd data-role="count-value">未校验</dd></div>
      </dl>
    </section>

    <section class="panel">
      <h3>校验</h3>
      <button type="button" class="btn" data-role="validate">校验配置</button>
      <div class="result" data-role="validate-result" hidden></div>
    </section>

    <section class="panel">
      <h3>保存</h3>
      <dl class="kv">
        <div class="kv-row"><dt>expected_revision</dt><dd data-role="expected-rev">—</dd></div>
      </dl>
      <div class="token-field">
        <label for="rule-admin-token">管理令牌（X-Rule-Admin-Token）</label>
        <input id="rule-admin-token" data-role="token" type="password" autocomplete="off" placeholder="输入令牌后保存" />
      </div>
      <button type="button" class="btn primary" data-role="save" disabled>保存规则</button>
      <p class="field-note">令牌只保存在当前页面内存中，刷新即清除；保存时以当前 revision 作为版本前置条件。</p>
    </section>

    <div class="log" data-role="log" aria-live="polite"></div>
  </aside>
</div>

<p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
`;

// ---------- 纯函数（只依赖全局 document，便于单测直接调） ----------

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function pretty(value) {
  return JSON.stringify(value, null, 2);
}

/** 深拷贝：本地模型绝不直接改 adapter 返回的那个对象（同一份回包可能被复用）。 */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 字段路径 → 人类可读标签（`rules / 0 / id`）。用于值控件的可访问名。 */
export function pathLabel(path) {
  return path.map(String).join(' / ');
}

function el(tag, className, text) {
  const node = globalThis.document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function withPath(node, path) {
  node.dataset.path = JSON.stringify(path);
  return node;
}

function actButton(label, act, path, ariaLabel, extraClass) {
  const button = el('button', extraClass || null, label);
  button.type = 'button';
  button.dataset.act = act;
  button.setAttribute('aria-label', ariaLabel);
  return withPath(button, path);
}

function typeSelect(role, ariaLabel) {
  const select = el('select');
  select.dataset.role = role;
  select.setAttribute('aria-label', ariaLabel);
  for (const [value, label] of VALUE_TYPES) {
    const option = el('option', null, label);
    option.value = value;
    select.append(option);
  }
  return select;
}

function addFieldRow(path) {
  const row = withPath(el('div', 'add-row'), path);
  const keyInput = el('input', 'key-input');
  keyInput.type = 'text';
  keyInput.placeholder = '新字段名';
  keyInput.dataset.role = 'new-key';
  keyInput.setAttribute('aria-label', '新字段名');
  const add = el('button', null, '添加字段');
  add.type = 'button';
  add.dataset.act = 'add-key';
  row.append(keyInput, typeSelect('new-type', '新字段类型'), add);
  return row;
}

function addItemRow(path) {
  const row = withPath(el('div', 'add-row'), path);
  const add = el('button', null, '添加一项');
  add.type = 'button';
  add.dataset.act = 'add-item';
  row.append(typeSelect('item-type', '新项目类型'), add);
  return row;
}

function boolField(value, path) {
  const label = el('label', 'bool-field');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.dataset.act = 'bool';
  input.setAttribute('aria-label', `值 · ${pathLabel(path)}`);
  withPath(input, path);
  const text = el('span', null, value ? 'true' : 'false');
  text.dataset.role = 'bool-text';
  label.append(input, text);
  return label;
}

function numberField(value, path) {
  const input = el('input', 'val-input');
  input.type = 'number';
  input.step = 'any';
  input.value = String(value);
  input.dataset.act = 'number';
  input.setAttribute('aria-label', `值 · ${pathLabel(path)}`);
  return withPath(input, path);
}

function textField(value, path) {
  const input = el('input', 'val-input');
  input.type = 'text';
  input.value = String(value);
  input.dataset.act = 'string';
  input.setAttribute('aria-label', `值 · ${pathLabel(path)}`);
  return withPath(input, path);
}

function rowEl(key, value, path) {
  const row = el('div', 'form-row');
  const keyInput = el('input', 'key-input');
  keyInput.type = 'text';
  keyInput.value = key;
  keyInput.dataset.role = 'key';
  keyInput.setAttribute('aria-label', '字段名');
  withPath(keyInput, path);

  const cell = el('div', 'value-cell');
  cell.append(valueEl(value, path));

  const actions = el('div', 'row-actions');
  actions.append(actButton('删除', 'del', path, `删除字段 ${pathLabel(path)}`));

  row.append(keyInput, cell, actions);
  return row;
}

function objectBlock(value, path) {
  const keys = Object.keys(value);
  const details = withPath(el('details', 'nested'), path);
  details.append(el('summary', null, `对象 · ${keys.length} 个字段`));
  const body = el('div', 'nested-body');
  if (!keys.length) body.append(el('p', 'form-empty', '空对象'));
  for (const key of keys) body.append(rowEl(key, value[key], path.concat(key)));
  body.append(addFieldRow(path));
  details.append(body);
  return details;
}

function arrayBlock(items, path) {
  const details = withPath(el('details', 'nested'), path);
  details.open = true; // 稿：数组默认展开
  details.append(el('summary', null, `数组 · ${items.length} 项`));
  const body = el('div', 'nested-body');
  if (!items.length) body.append(el('p', 'form-empty', '空数组'));
  items.forEach((item, index) => {
    const itemPath = path.concat(index);
    const itemRow = withPath(el('div', 'array-item'), itemPath);
    itemRow.append(el('span', 'idx mono', String(index)));
    const cell = el('div', 'value-cell');
    cell.append(valueEl(item, itemPath));
    const actions = el('div', 'row-actions');
    actions.append(
      actButton('↑', 'up', itemPath, `上移第 ${index + 1} 项`),
      actButton('↓', 'down', itemPath, `下移第 ${index + 1} 项`),
      actButton('×', 'del-item', itemPath, `删除第 ${index + 1} 项`, 'is-danger'),
    );
    itemRow.append(cell, actions);
    body.append(itemRow);
  });
  body.append(addItemRow(path));
  details.append(body);
  return details;
}

/** 按 JSON 类型递归生成控件（对象 / 数组 / 布尔 / 数字 / 字符串 / null 原样）。 */
function valueEl(value, path) {
  if (Array.isArray(value)) return arrayBlock(value, path);
  if (isObject(value)) return objectBlock(value, path);
  if (typeof value === 'boolean') return boolField(value, path);
  if (typeof value === 'number') return numberField(value, path);
  if (value === null) return el('span', 'null-val', 'null');
  return textField(value, path);
}

function defaultFor(type) {
  if (type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'object') return {};
  if (type === 'array') return [];
  return '';
}

/** 错误 → 给人看的一句话（kind 来自 src/rules.js 的 RulesError）。 */
export function describeRulesError(error) {
  switch (error?.kind) {
    case 'unauthorized': return '登录已失效，请重新登录。';
    case 'forbidden': return error.message || '规则管理员令牌无效。';
    case 'conflict': return `${error.message || '规则配置已变化'}（刷新后按新版本重编辑）`;
    case 'unavailable': return error.message || '服务端还没有配置规则管理员令牌。';
    case 'network': return '连不上研判服务，请检查网络或稍后重试。';
    case 'invalid': return `服务返回的形状不对：${error.message}`;
    case 'http': return error.message;
    default: return error?.message || '未知错误';
  }
}

function describeSafety(error) {
  if (error?.kind === 'http' && error.status === 400) return error.message;
  return describeRulesError(error);
}

function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="rules"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'rules';
  document.head.append(link);
}

// ---------- 挂载 ----------

/**
 * 挂载前置规则页。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, clipboard?: { writeText(text: string): Promise<void> }, now?: () => Date }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountRulesPage(options = {}) {
  const document = globalThis.document;
  const clipboard = options.clipboard ?? null;
  const now = options.now ?? (() => new Date());
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'rules-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  const state = {
    phase: 'loading',   // loading | ready | error
    error: null,
    revision: null,
    writable: false,
    model: {},
    savedSnapshot: '{}',
    view: 'form',
    jsonError: null,
    counts: { validated: false, count: null },
    busy: { refresh: false, validate: false, save: false },
  };

  // ---------- 渲染 ----------

  function announce(message) {
    $('sr-status').textContent = message;
  }

  function log(message, tone) {
    const date = now();
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const entry = el('div', tone ? `log-entry is-${tone}` : 'log-entry');
    entry.append(el('time', null, time), el('span', null, message));
    $('log').prepend(entry);
  }

  function setResult(message, tone) {
    const box = $('validate-result');
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      box.className = 'result';
      return;
    }
    box.hidden = false;
    box.className = tone ? `result is-${tone}` : 'result';
    box.textContent = message;
  }

  function paintSyntax(message) {
    const node = $('syntax');
    node.textContent = message || 'JSON 有效';
    node.classList.toggle('is-error', Boolean(message));
  }

  function paintNotice() {
    const banner = $('error');
    if (!state.error) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    $('error-text').textContent = describeRulesError(state.error);
  }

  function paintCount() {
    const node = $('count-value');
    if (state.counts.count !== null) node.textContent = String(state.counts.count);
    else node.textContent = state.counts.validated ? '—' : '未校验';
  }

  function isDirty() {
    return JSON.stringify(state.model) !== state.savedSnapshot;
  }

  function paintMeta() {
    const ready = state.phase === 'ready';
    $('rev-label').textContent = !ready ? '—' : (state.revision || '无 revision');
    $('rev-value').textContent = !ready ? '—' : (state.revision ?? 'null');
    $('expected-rev').textContent = !ready ? '—' : (state.revision ?? 'null');
    $('writable-value').textContent = !ready ? '—' : (state.writable ? '可用' : '只读');
    const badge = $('writable-badge');
    badge.textContent = !ready ? '—' : (state.writable ? '可写' : '只读');
    badge.classList.toggle('is-writable', ready && state.writable);
    $('config').readOnly = !state.writable;
    $('form-wrap').classList.toggle('is-readonly', !state.writable);
    paintCount();
  }

  function paintButtons() {
    const ready = state.phase === 'ready';
    const dirty = isDirty();
    $('dirty').hidden = !dirty;
    $('reset').disabled = !ready || !state.writable || !dirty || state.busy.refresh;
    $('save').disabled = !ready || !state.writable || !dirty || state.busy.save
      || !$('token').value.trim();
    $('validate').disabled = !ready || state.busy.validate || state.busy.refresh;
    const refresh = $('refresh');
    refresh.disabled = state.busy.refresh;
    refresh.classList.toggle('is-loading', state.busy.refresh);
    $('shell').setAttribute('aria-busy', String(state.phase === 'loading' || state.busy.refresh));
  }

  function paint() {
    paintMeta();
    paintButtons();
    paintNotice();
  }

  function emptyForm(text) {
    const node = el('p', 'form-empty', text);
    $('form').replaceChildren(node);
    applyReadonly();
  }

  function applyReadonly() {
    const wrap = $('form-wrap');
    if (state.writable) return;
    for (const node of wrap.querySelectorAll('input, select, button')) node.disabled = true;
  }

  function paintForm() {
    if (state.phase === 'loading') return emptyForm('正在读取规则配置…');
    if (state.phase === 'error') return emptyForm('规则配置没有读到，点上方「重试」。');
    if (!isObject(state.model)) return emptyForm('config 不是对象，请在 JSON 视图里改为对象。');

    const form = $('form');
    const keys = Object.keys(state.model);
    form.replaceChildren();
    for (const key of keys) form.append(rowEl(key, state.model[key], [key]));
    if (!keys.length) form.append(el('p', 'form-empty', '当前 config 为空对象。添加字段，或切到 JSON 粘贴配置。'));
    form.append(addFieldRow([]));
    applyReadonly();
  }

  function syncEditor() {
    $('config').value = pretty(state.model);
    paintGutter();
  }

  function paintGutter() {
    const editor = $('config');
    const lines = editor.value.split('\n').length;
    const text = Array.from({ length: lines }, (_, index) => String(index + 1)).join('\n');
    $('gutter').textContent = text;
    $('gutter').scrollTop = editor.scrollTop;
  }

  function paintCursor() {
    const node = $('cursor-info');
    if (state.view !== 'json') {
      node.textContent = '表单视图';
      return;
    }
    const editor = $('config');
    const upto = editor.value.slice(0, editor.selectionStart ?? 0).split('\n');
    node.textContent = `第 ${upto.length} 行 · 第 ${upto[upto.length - 1].length + 1} 列`;
  }

  function paintView() {
    $('view-form').setAttribute('aria-pressed', String(state.view === 'form'));
    $('view-json').setAttribute('aria-pressed', String(state.view === 'json'));
    $('form-wrap').hidden = state.view !== 'form';
    $('json-wrap').hidden = state.view !== 'json';
    paintCursor();
  }

  /** 编辑后：未保存标记、条目数回到「未校验」 */
  function changed() {
    state.counts = { validated: false, count: null };
    paintSyntax(null);
    paint();
  }

  // ---------- JSON 视图 ⇄ 模型 ----------

  function tryParse() {
    try {
      return { ok: true, value: JSON.parse($('config').value) };
    } catch (error) {
      return { ok: false, message: 'JSON 语法错误' };
    }
  }

  /** 表单操作前同步 JSON 视图里的最新内容；语法错误返回 false（不拿旧模型顶替）。 */
  function readModelFromView() {
    if (state.view !== 'json') return true;
    const parsed = tryParse();
    if (!parsed.ok) {
      state.jsonError = parsed.message;
      paintSyntax('JSON 语法错误，修正后才能继续');
      return false;
    }
    state.model = parsed.value;
    state.jsonError = null;
    return true;
  }

  function ensureObjectModel() {
    if (isObject(state.model)) return true;
    setResult('config 必须是 JSON 对象。', 'error');
    log('config 不是对象，操作已阻止', 'error');
    return false;
  }

  // ---------- 表单操作 ----------

  function pathOf(node) {
    try {
      return JSON.parse(node.dataset.path || '[]');
    } catch {
      return [];
    }
  }

  function at(path) {
    return path.reduce((current, key) => (current == null ? current : current[key]), state.model);
  }

  function setAt(path, value) {
    if (!path.length) {
      state.model = value;
      return;
    }
    const parent = at(path.slice(0, -1));
    if (parent == null) return;
    parent[path[path.length - 1]] = value;
  }

  function renameAt(path, nextKey) {
    if (!path.length) return false;
    const oldKey = path[path.length - 1];
    if (!nextKey || nextKey === oldKey) return false;
    const parent = at(path.slice(0, -1));
    if (!isObject(parent)) return false;
    if (Object.hasOwn(parent, nextKey)) return false;
    const rebuilt = {};
    for (const key of Object.keys(parent)) {
      if (key === oldKey) rebuilt[nextKey] = parent[oldKey];
      else rebuilt[key] = parent[key];
    }
    setAt(path.slice(0, -1), rebuilt);
    return true;
  }

  $('form').addEventListener('click', event => {
    if (!state.writable || state.phase !== 'ready') return;
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    const path = pathOf(button);
    if (act === 'del') {
      const parent = at(path.slice(0, -1));
      if (isObject(parent)) delete parent[path[path.length - 1]];
    } else if (act === 'del-item') {
      const parent = at(path.slice(0, -1));
      if (Array.isArray(parent)) parent.splice(path[path.length - 1], 1);
    } else if (act === 'up' || act === 'down') {
      const parent = at(path.slice(0, -1));
      if (!Array.isArray(parent)) return;
      const index = path[path.length - 1];
      const next = index + (act === 'up' ? -1 : 1);
      if (next < 0 || next >= parent.length) return;
      [parent[index], parent[next]] = [parent[next], parent[index]];
    } else if (act === 'add-key') {
      const row = button.closest('.add-row');
      const keyInput = row.querySelector('[data-role="new-key"]');
      const typeSelectNode = row.querySelector('[data-role="new-type"]');
      const parent = at(pathOf(row));
      const key = keyInput.value.trim();
      if (!key) {
        keyInput.focus();
        return;
      }
      if (isObject(parent) && Object.hasOwn(parent, key)) {
        log(`字段 ${key} 已存在`, 'error');
        return;
      }
      if (!isObject(parent)) return;
      parent[key] = defaultFor(typeSelectNode.value);
    } else if (act === 'add-item') {
      const row = button.closest('.add-row');
      const parent = at(pathOf(row));
      if (!Array.isArray(parent)) return;
      parent.push(defaultFor(row.querySelector('[data-role="item-type"]').value));
    } else {
      return;
    }
    changed();
    paintForm();
  });

  $('form').addEventListener('input', event => {
    if (!state.writable || state.phase !== 'ready') return;
    const target = event.target;
    const act = target.dataset.act;
    if (act !== 'string' && act !== 'number') return;
    if (act === 'number') {
      if (target.value === '') return;
      const number = Number(target.value);
      if (!Number.isFinite(number)) return;
      setAt(pathOf(target), number);
    } else {
      setAt(pathOf(target), target.value);
    }
    changed();
  });

  $('form').addEventListener('change', event => {
    if (!state.writable || state.phase !== 'ready') return;
    const target = event.target;
    if (target.dataset.act === 'bool') {
      setAt(pathOf(target), target.checked);
      const text = target.parentElement?.querySelector('[data-role="bool-text"]');
      if (text) text.textContent = target.checked ? 'true' : 'false';
      changed();
      return;
    }
    if (target.dataset.role === 'key') {
      const path = pathOf(target);
      if (!renameAt(path, target.value.trim())) log('字段名不能为空或与已有字段重复', 'error');
      changed();
      paintForm();
    }
  });

  // ---------- JSON 视图事件 ----------

  $('config').addEventListener('input', () => {
    paintGutter();
    const parsed = tryParse();
    if (parsed.ok) {
      state.model = parsed.value;
      state.jsonError = null;
      paintSyntax(null);
      state.counts = { validated: false, count: null };
    } else {
      state.jsonError = parsed.message;
      paintSyntax(parsed.message);
    }
    paintButtons();
    paintCount();
    paintCursor();
  });
  $('config').addEventListener('scroll', () => {
    $('gutter').scrollTop = $('config').scrollTop;
  });
  for (const type of ['keyup', 'click', 'select']) $('config').addEventListener(type, paintCursor);
  $('config').addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      if (!$('save').disabled) $('save').click();
    }
  });

  $('view-form').addEventListener('click', () => setView('form'));
  $('view-json').addEventListener('click', () => setView('json'));

  function setView(next) {
    if (next === state.view) return;
    if (next === 'json') {
      syncEditor();
      state.view = 'json';
      paintSyntax(state.jsonError);
      paintView();
      paint();
      return;
    }
    const parsed = tryParse();
    if (!parsed.ok) {
      // 稿：语法错误时停在 JSON 视图并提示，不切
      state.jsonError = parsed.message;
      paintSyntax('JSON 语法错误，修正后才能切回表单');
      return;
    }
    state.model = parsed.value;
    state.jsonError = null;
    state.view = 'form';
    paintSyntax(null);
    paintView();
    paintForm();
    changed();
  }

  // ---------- 取数 / 校验 / 保存 ----------

  async function load({ initial }) {
    if (state.busy.refresh) return;
    state.busy.refresh = true;
    if (state.phase !== 'ready') {
      state.phase = 'loading';
      state.error = null;
      paintForm();
    }
    paint();
    try {
      const rules = await getRules(request);
      state.revision = rules.revision;
      state.writable = rules.writable;
      state.model = clone(rules.config);
      state.savedSnapshot = JSON.stringify(rules.config);
      state.jsonError = null;
      state.counts = { validated: false, count: null };
      state.phase = 'ready';
      state.error = null;
      if (state.view === 'json') syncEditor();
      paintForm();
      paintView();
      // 刷新 = 回到已保存状态：结果条一并清掉（与「撤销修改」同一处理，见 rules-notes §4）
      setResult('');
      paint();
      log(initial ? '已加载前置规则配置' : '已重新读取规则配置');
      announce('规则配置已加载');
    } catch (error) {
      if (state.phase === 'ready') {
        // 已有数据：刷新失败不清屏，改动保留
        const message = describeRulesError(error);
        setResult(`刷新失败：${message}`, 'error');
        log(`刷新失败：${message}`, 'error');
        announce(`刷新失败：${message}`);
      } else {
        state.phase = 'error';
        state.error = error;
        paintForm();
        log(`读取失败：${describeRulesError(error)}`, 'error');
        announce(`规则配置读取失败：${describeRulesError(error)}`);
      }
    } finally {
      state.busy.refresh = false;
      paint();
    }
  }

  $('refresh').addEventListener('click', () => load({ initial: false }));
  $('retry').addEventListener('click', () => load({ initial: false }));

  $('validate').addEventListener('click', async () => {
    if ($('validate').disabled) return;
    if (!readModelFromView()) {
      setResult('JSON 语法错误，无法校验。', 'error');
      log('校验失败：JSON 语法错误', 'error');
      return;
    }
    if (!ensureObjectModel()) return;
    state.busy.validate = true;
    setResult('正在校验…', '');
    paintButtons();
    try {
      const result = await validateRules(state.model, request);
      state.counts = { validated: true, count: result.count };
      setResult(`校验通过 · 条目数 ${result.count}`, 'ok');
      log(`校验通过，条目数 ${result.count}`, 'ok');
      announce('规则校验通过');
    } catch (error) {
      state.counts = { validated: true, count: null };
      const message = describeSafety(error);
      setResult(`校验失败：${message}`, 'error');
      log(`校验失败：${message}`, 'error');
      announce(`校验失败：${message}`);
    } finally {
      state.busy.validate = false;
      paint();
    }
  });

  $('token').addEventListener('input', () => {
    setResult('');
    paintButtons();
  });

  $('save').addEventListener('click', async () => {
    if ($('save').disabled) return;
    if (!readModelFromView()) {
      setResult('JSON 语法错误，无法保存。', 'error');
      log('保存失败：JSON 语法错误', 'error');
      return;
    }
    if (!ensureObjectModel()) return;
    const token = $('token').value.trim();
    if (!token) {
      log('保存失败：缺少管理令牌', 'error');
      $('token').focus();
      return;
    }
    state.busy.save = true;
    setResult('正在保存…', '');
    paintButtons();
    try {
      const saved = await saveRules({
        config: state.model,
        expectedRevision: state.revision,
        token,
        fetchImpl: request.fetchImpl,
        baseUrl: request.baseUrl,
      });
      state.model = clone(saved.config);
      state.revision = saved.revision;
      state.savedSnapshot = JSON.stringify(saved.config);
      state.jsonError = null;
      state.counts = { validated: false, count: null };
      if (state.view === 'json') syncEditor();
      paintForm();
      setResult(`已保存 · ${saved.revision}`, 'ok');
      log(`保存成功，revision 更新为 ${saved.revision}`, 'ok');
      announce('规则已保存');
    } catch (error) {
      const message = describeSafety(error);
      setResult(`保存失败：${message}`, 'error');
      log(`保存失败：${message}`, 'error');
      announce(`保存失败：${message}`);
    } finally {
      state.busy.save = false;
      paint();
    }
  });

  $('reset').addEventListener('click', () => {
    if ($('reset').disabled) return;
    state.model = JSON.parse(state.savedSnapshot);
    state.jsonError = null;
    state.counts = { validated: false, count: null };
    if (state.view === 'json') syncEditor();
    paintForm();
    setResult('');
    paint();
    log('已撤销未保存修改');
    announce('已撤销修改');
  });

  $('copy').addEventListener('click', async () => {
    const text = pretty(state.model);
    const api = clipboard ?? globalThis.navigator?.clipboard ?? null;
    try {
      if (!api?.writeText) throw new Error('no clipboard');
      await api.writeText(text);
      log('JSON 已复制到剪贴板');
      announce('JSON 已复制');
    } catch {
      log('复制失败，请手动选择', 'error');
      announce('复制失败');
    }
  });

  // ---------- 首帧 ----------

  paintForm();
  paintView();
  paint();
  load({ initial: true });

  return host;
}

export const page = {
  id: 'rules',
  title: '规则',
  navLabel: '规则',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} _context 路由参数（本页不分段）
   */
  render(content, _context) {
    content.replaceChildren(mountRulesPage());
  },
};
