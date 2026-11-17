// 页面：深度溯源（P002-T005）
//
// 视觉与结构照设计稿 `design/trace.html`（左侧导航 + 顶栏由壳提供，本文件只写内容区）：
// 左侧白板列表 + 新建目标，右侧点阵画布（圆点节点 + 细线关系）+ 检查器（摘要 / 缺口 / 调研过程）。
// 字段与操作全部来自本仓接口（adapter 在 `web/src/trace.js`，页面里没有 fetch）。
//
// 稿上有、接口没有 → 藏掉并记进 topics/backend-findings.md（A2）：
//   1) 白板列表项的「N 节点 · M 关系」与摘要 —— GET /api/trace/boards 只回
//      id / title / status / created_at / updated_at（trace-board.js:167），列表项只画 id 与状态。
//   2) 检查器里的节点类型（主机 / 账号 / 进程 / 文件 / IP）—— 接口节点只有 kind（asset|external_ip）与
//      address，没有 type；检查器显示 kind 原值，不做中文类型名与分组配色。
//   3) 节点坐标 x / y —— 接口没有位置字段，按 trace-notes.md §5 由前端力导向布局算（展示层）。
//   4) 自动轮询进度 —— 接口 POST 之后就是 202 + 当前白板，没有进度流；稿也只有「刷新」，
//      trace-notes.md §7 把「真实任务进度驱动」列为待补。
//
// 稿的 `trace.html?target=<告警 ID>` 入口在本仓是单页 hash 路由：用 `#/trace/<target>`，
// 路由已经把第二段放进 render(content, { params })。
//
// 「刷新」在稿里位于顶栏，顶栏属壳（web/src/views/shell.js，本卡 forbidden），所以落在内容区首行——
// 只挪位置，不动壳（与 T003 告警页同一条处理）。

import { getTraceBoard, listTraceBoards, startTraceBoard } from '../src/trace.js';

const STYLE_HREF = 'assets/pages/trace.css';
const REVEAL_INTERVAL_MS = 900;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
// 与 server.js:100-111 的 validTraceTarget 同形；eventTypes 白名单只有服务端知道，
// 本地只挡格式明显不对的输入，其余交给 400 的原话。
const ALERT_ID_SHAPE = /^[a-z_]+:[1-9][0-9]*$/;
const IPV4_SHAPE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const TEMPLATE = `
<div class="trace-page">
  <div class="trace-tools">
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
    <span><strong>白板列表读取失败</strong>，<span data-role="error-text">—</span></span>
    <button type="button" class="textbtn" data-role="retry">重试</button>
  </div>

  <div class="trace-shell" data-role="shell">
    <aside class="side">
      <div class="side-head">
        <h2>白板</h2>
        <span class="mono" data-role="board-count">—</span>
      </div>
      <div class="new-board">
        <input data-role="target" type="text" placeholder="告警 ID 或 IPv4" aria-label="新建溯源目标" autocomplete="off" spellcheck="false" />
        <button type="button" data-role="start">新建</button>
      </div>
      <ul class="board-list" data-role="board-list"></ul>
      <p class="side-note" data-role="start-note" role="status" aria-live="polite"></p>
    </aside>

    <section class="stage" aria-label="溯源白板">
      <header class="stage-bar">
        <div class="stage-title">
          <h2 data-role="board-id">—</h2>
          <span class="state" data-role="board-state"><span data-role="board-state-text">—</span></span>
          <span class="meta mono" data-role="board-counts">—</span>
        </div>
        <div class="playback">
          <span class="progress mono" data-role="progress">—</span>
          <button type="button" data-role="replay">重放</button>
          <button type="button" data-role="pause">暂停</button>
          <button type="button" data-role="latest">跳到最新</button>
          <button type="button" data-role="follow" aria-pressed="true">跟随</button>
        </div>
        <div class="zoom">
          <button type="button" data-role="zoom-out" aria-label="缩小">−</button>
          <span class="level" data-role="zoom-level" aria-label="当前缩放">100%</span>
          <button type="button" data-role="zoom-in" aria-label="放大">+</button>
          <button type="button" data-role="fit" aria-label="适应视图">适应</button>
        </div>
      </header>

      <div class="canvas-wrap">
        <div class="canvas" data-role="canvas">
          <div class="world" data-role="world">
            <svg class="edges" data-role="edges" aria-hidden="true"></svg>
            <div class="nodes" data-role="nodes"></div>
          </div>
          <div class="canvas-empty" data-role="canvas-empty">
            <div>
              <h3 data-role="canvas-empty-title">白板为空</h3>
              <p data-role="canvas-empty-text">接口未返回节点。</p>
            </div>
          </div>
        </div>

        <aside class="inspector" aria-label="检查器">
          <div class="inspector-head">
            <h2>检查器</h2>
            <button type="button" class="textbtn" data-role="clear-select" hidden>取消选择</button>
          </div>
          <div class="inspector-body" data-role="inspector"></div>
        </aside>
      </div>
    </section>
  </div>

  <p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
</div>`;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 目标的本地格式校验（与 server.js:100-111 同形；eventTypes 白名单交给服务端）。 */
export function validTraceTarget(value) {
  const text = String(value ?? '').trim();
  if (ALERT_ID_SHAPE.test(text)) return true;
  const address = text.replace(/^ip:/, '');
  return IPV4_SHAPE.test(address) && address.split('.').every(part => Number(part) <= 255);
}

/** activity 条目上的 `at`（ISO）→ 时间线上显示的时刻（本地时区 HH:MM:SS）。 */
export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 白板状态 → 稿上的色点类（is-running / is-done / is-failed；interrupted 走默认灰）。 */
export function statusClass(status) {
  if (status === 'running') return 'is-running';
  if (status === 'done') return 'is-done';
  if (status === 'failed') return 'is-failed';
  return '';
}

/** 节点标签：接口给 label；缺了退回 id（不编「节点 N」以外的名字）。 */
export function nodeLabel(node) {
  return node?.label || node?.id || '';
}

/**
 * 渐进显示顺序：activity 里带 `node` 的记录按出现顺序，其余节点按 nodes[] 原顺序补齐。
 * @param {object} board TraceBoard
 * @returns {number[]} nodes 下标序列
 */
export function discoveryOrder(board) {
  const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const order = [];
  const seen = new Set();
  for (const entry of Array.isArray(board?.activity) ? board.activity : []) {
    const key = entry?.node;
    if (key == null) continue;
    let index = indexById.get(key);
    if (index === undefined) index = nodes.findIndex(node => nodeLabel(node) === key);
    if (index === undefined || index < 0 || seen.has(index)) continue;
    seen.add(index);
    order.push(index);
  }
  nodes.forEach((_node, index) => { if (!seen.has(index)) order.push(index); });
  return order;
}

/** 失败归一成一句人能读的话（与后端 server.js:57 的错误体一起用）。 */
export function describeTraceError(error) {
  switch (error?.kind) {
    case 'unauthorized': return '登录已失效，请重新登录。';
    case 'unavailable': return error.message ? `${error.message}。` : '深度溯源尚未配置。';
    case 'notfound': return '该目标还没有溯源白板。';
    case 'network': return '连不上研判服务，请检查网络或稍后重试。';
    case 'invalid': return '服务返回的形状不对。';
    default: return error?.status ? `服务返回异常（${error.status}）：${error.message}` : (error?.message || '未知错误');
  }
}

function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="trace"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'trace';
  document.head.append(link);
}

/** 节点 / 关系对象 → 检查器的键值行（接口对象原样展示，嵌套值转 JSON）。 */
function fieldValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 挂载深度溯源页。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, timers?: { setInterval: Function, clearInterval: Function } }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountTracePage(options = {}) {
  const document = globalThis.document;
  const timers = options.timers ?? {
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: id => globalThis.clearInterval(id),
  };
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'trace-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  const state = {
    phase: 'loading',      // loading | ready | error —— 白板列表
    listError: null,
    boards: [],
    selectedId: null,
    board: null,
    boardPhase: 'idle',    // idle | loading | ready | partial —— 选中白板的详情
    boardError: null,
    selectedNode: null,
    selectedEdge: null,
    positions: new Map(),  // node.id → { x, y }（力导向布局与拖动都在这里，不写回接口数据）
    view: { x: 40, y: 40, k: 1 },
    follow: true,
    reveal: { order: [], count: 0, playing: false, timer: null },
    busy: { start: false, refresh: false },
    pendingTarget: null,
  };

  // ---------- 渲染 ----------

  function announce(message) {
    $('sr-status').textContent = message;
  }

  function note(message) {
    $('start-note').textContent = message;
  }

  function emptyCopy() {
    if (state.phase === 'loading') return { title: '正在读取白板…', text: '白板列表与详情正在从研判服务读取。' };
    if (state.listError) return { title: '白板列表读取失败', text: describeTraceError(state.listError) };
    if (state.boardPhase === 'partial') {
      return state.boardError?.kind === 'notfound'
        ? { title: '没有这个白板', text: describeTraceError(state.boardError) }
        : { title: '白板读取失败', text: describeTraceError(state.boardError) };
    }
    if (state.boardPhase === 'loading') return { title: '正在读取白板…', text: '正在读取选中白板的节点与关系。' };
    if (!state.boards.length) return { title: '没有白板', text: '在左侧输入告警 ID 或 IPv4 新建。' };
    if (state.board && !state.board.nodes.length) {
      return state.board.status === 'failed'
        ? { title: '任务失败', text: state.board.summary || '接口未返回失败原因。' }
        : { title: '白板为空', text: '接口未返回节点，等待任务生成。' };
    }
    return null;
  }

  function paintList() {
    const list = $('board-list');
    const count = $('board-count');
    if (state.phase === 'loading') {
      count.textContent = '—';
      list.replaceChildren(listItem('muted', '正在读取白板…'));
      return;
    }
    if (state.listError) {
      count.textContent = '—';
      list.replaceChildren(listItem('muted', '白板列表读取失败。'));
      return;
    }
    count.textContent = `${state.boards.length} 个`;
    if (!state.boards.length) {
      list.replaceChildren(listItem('muted', '还没有白板。'));
      return;
    }
    list.replaceChildren(...state.boards.map(board => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'board-item';
      button.dataset.boardId = board.id;
      if (board.id === state.selectedId) button.classList.add('is-active');
      const id = document.createElement('span');
      id.className = 'board-id';
      id.textContent = board.id;
      const meta = document.createElement('span');
      meta.className = 'board-meta';
      const status = document.createElement('span');
      status.className = `state ${statusClass(board.status)}`.trim();
      status.textContent = board.status || '—';
      meta.append(status);
      button.append(id, meta);
      item.append(button);
      return item;
    }));
  }

  function listItem(className, copy) {
    const item = document.createElement('li');
    const paragraph = document.createElement('p');
    paragraph.className = className;
    paragraph.textContent = copy;
    item.append(paragraph);
    return item;
  }

  function visibleState() {
    const order = state.reveal.order;
    const count = Math.min(state.reveal.count, order.length);
    const visible = new Set(order.slice(0, count));
    return { order, count, visible, latest: count ? order[count - 1] : undefined };
  }

  function visibleEdgeCount(visible) {
    const nodes = state.board?.nodes ?? [];
    return (state.board?.edges ?? []).filter(edge => {
      const from = nodes.findIndex(node => node.id === edge.from);
      const to = nodes.findIndex(node => node.id === edge.to);
      return from >= 0 && to >= 0 && visible.has(from) && visible.has(to);
    }).length;
  }

  function paintStage() {
    const board = state.board;
    const copy = emptyCopy();
    const empty = $('canvas-empty');
    if (copy) {
      empty.hidden = false;
      $('canvas-empty-title').textContent = copy.title;
      $('canvas-empty-text').textContent = copy.text;
    } else {
      empty.hidden = true;
    }

    if (!board) {
      $('board-id').textContent = '—';
      $('board-state').className = 'state';
      $('board-state-text').textContent = '—';
      $('board-counts').textContent = '—';
      $('progress').textContent = '—';
      return;
    }

    const { order, count, visible } = visibleState();
    $('board-id').textContent = board.id;
    $('board-state').className = `state ${statusClass(board.status)}`.trim();
    $('board-state-text').textContent = board.status || '—';
    $('board-counts').textContent = `${board.nodes.length} 节点 · ${board.edges.length} 关系`;
    $('progress').textContent = `已发现 ${count} / ${order.length} 节点 · ` +
      `${visibleEdgeCount(visible)} / ${board.edges.length} 关系`;
  }

  function paintNodes() {
    const layer = $('nodes');
    const board = state.board;
    if (!board?.nodes.length) {
      layer.replaceChildren();
      return;
    }
    const { visible, latest } = visibleState();
    const shown = (board.nodes ?? []).map((node, index) => {
      if (!visible.has(index)) return null;
      const position = state.positions.get(node.id) ?? { x: 0, y: 0 };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gnode';
      if (index === latest) button.classList.add('is-new');
      if (index === state.selectedNode) button.classList.add('is-active');
      button.dataset.index = String(index);
      button.setAttribute('aria-pressed', index === state.selectedNode ? 'true' : 'false');
      button.style.left = `${position.x - 4.5}px`;
      button.style.top = `${position.y}px`;
      const dot = document.createElement('span');
      dot.className = 'gnode-dot';
      const label = document.createElement('span');
      label.className = 'gnode-label';
      label.textContent = nodeLabel(node);
      button.append(dot, label);
      return button;
    }).filter(Boolean);
    layer.replaceChildren(...shown);
  }

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  }

  function edgeLabelText(edge) {
    // 稿的规则是取第一个可用的关系字段；接口的真字段是 rel（trace-board.js:410）。
    return edge.rel || '';
  }

  function paintEdges() {
    const layer = $('edges');
    const board = state.board;
    if (!board?.nodes.length) {
      layer.replaceChildren();
      layer.removeAttribute('width');
      layer.removeAttribute('height');
      layer.removeAttribute('viewBox');
      return;
    }
    const nodes = board.nodes;
    const { visible, latest } = visibleState();
    const indexById = new Map(nodes.map((node, index) => [node.id, index]));
    let maxX = 1;
    let maxY = 1;
    for (const [index, node] of nodes.entries()) {
      if (!visible.has(index)) continue;
      const position = state.positions.get(node.id) ?? { x: 0, y: 0 };
      maxX = Math.max(maxX, position.x + 160);
      maxY = Math.max(maxY, position.y + 60);
    }
    layer.setAttribute('width', String(maxX));
    layer.setAttribute('height', String(maxY));
    layer.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);

    const parts = [];
    for (const [edgeIndex, edge] of board.edges.entries()) {
      const from = indexById.get(edge.from);
      const to = indexById.get(edge.to);
      if (from === undefined || to === undefined) continue;   // 端点必须能对上节点才画（稿 §5）
      if (!visible.has(from) || !visible.has(to)) continue;    // 两端都出现后才画（稿 §3）
      const a = state.positions.get(nodes[from].id) ?? { x: 0, y: 0 };
      const b = state.positions.get(nodes[to].id) ?? { x: 0, y: 0 };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / distance;
      const uy = dy / distance;
      const tipX = b.x - ux * 9;
      const tipY = b.y - uy * 9;
      const angle = Math.atan2(dy, dx);
      const size = 7;
      const spread = 0.42;
      const active = state.selectedEdge === edgeIndex;
      const fresh = from === latest || to === latest;
      const line = svg('line', { class: 'edge', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      if (active) line.classList.add('is-active');
      if (fresh) line.classList.add('is-new');
      const arrow = svg('polygon', {
        class: `edge-arrow${active ? ' is-active' : ''}`,
        points: `${tipX},${tipY} ${tipX - size * Math.cos(angle - spread)},${tipY - size * Math.sin(angle - spread)} ` +
          `${tipX - size * Math.cos(angle + spread)},${tipY - size * Math.sin(angle + spread)}`,
      });
      parts.push(line, arrow);
      const label = edgeLabelText(edge);
      if (label) {
        const text = svg('text', {
          class: `edge-label${active ? ' is-active' : ''}`,
          x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 7, 'text-anchor': 'middle',
        });
        text.textContent = label;
        parts.push(text);
      }
      // 细线只有 1.2px，点不中：稿用一条透明的 12px 命中线（trace.html 的 .edge-hit），并补键盘可达。
      const hit = svg('line', {
        class: 'edge-hit', 'data-edge': edgeIndex, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        tabindex: '0', role: 'button',
        'aria-label': `关系：${nodeLabel(nodes[from])} → ${nodeLabel(nodes[to])}${label ? `（${label}）` : ''}`,
      });
      parts.push(hit);
    }
    layer.replaceChildren(...parts);
  }

  function paintInspector() {
    const inspector = $('inspector');
    const clear = $('clear-select');
    const board = state.board;

    if (board && state.selectedNode !== null && board.nodes[state.selectedNode]) {
      const node = board.nodes[state.selectedNode];
      const heading = document.createElement('h3');
      heading.textContent = nodeLabel(node);
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = node.kind || '节点';
      const list = document.createElement('dl');
      list.className = 'kv';
      for (const [key, value] of Object.entries(node)) {
        const row = document.createElement('div');
        row.className = 'kv-row';
        const term = document.createElement('dt');
        term.textContent = key;
        const detail = document.createElement('dd');
        detail.textContent = fieldValue(value);
        row.append(term, detail);
        list.append(row);
      }
      inspector.replaceChildren(heading, kind, list);
      clear.hidden = false;
      return;
    }

    if (board && state.selectedEdge !== null && board.edges[state.selectedEdge]) {
      const edge = board.edges[state.selectedEdge];
      const heading = document.createElement('h3');
      heading.textContent = '关系';
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = `edge #${state.selectedEdge}`;
      const list = document.createElement('dl');
      list.className = 'kv';
      for (const [key, value] of Object.entries(edge)) {
        const row = document.createElement('div');
        row.className = 'kv-row';
        const term = document.createElement('dt');
        term.textContent = key;
        const detail = document.createElement('dd');
        detail.textContent = fieldValue(value);
        row.append(term, detail);
        list.append(row);
      }
      inspector.replaceChildren(heading, kind, list);
      clear.hidden = false;
      return;
    }

    clear.hidden = true;
    if (!board) {
      const paragraph = document.createElement('p');
      paragraph.className = 'muted';
      paragraph.textContent = '没有选中的白板。';
      inspector.replaceChildren(paragraph);
      return;
    }

    const { order, count, visible, latest } = visibleState();
    const nodes = board.nodes;
    const heading = document.createElement('h3');
    heading.textContent = '白板概览';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = board.status || '—';
    const summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = board.summary || '接口未返回摘要。';

    const gapsLabel = document.createElement('span');
    gapsLabel.className = 'section-label';
    gapsLabel.textContent = `缺口 · ${board.gaps.length}`;
    const gaps = document.createElement('ul');
    gaps.className = 'gaps';
    if (board.gaps.length) {
      for (const gap of board.gaps) {
        const item = document.createElement('li');
        item.textContent = gap;
        gaps.append(item);
      }
    } else {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = '接口未返回缺口。';
      gaps.append(item);
    }

    const activityLabel = document.createElement('span');
    activityLabel.className = 'section-label';
    activityLabel.textContent = `调研过程 · 已发现 ${count} / ${order.length}`;
    const timeline = document.createElement('ul');
    timeline.className = 'timeline';
    if (board.activity.length) {
      for (const entry of board.activity) {
        const nodeIndex = nodes.findIndex(node => node.id === entry.node);
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        if (nodeIndex >= 0) button.dataset.node = String(nodeIndex);
        if (nodeIndex >= 0 && !visible.has(nodeIndex)) button.disabled = true;
        if (nodeIndex >= 0 && nodeIndex === latest) button.classList.add('is-latest');
        const time = document.createElement('time');
        time.textContent = formatTime(entry.at);
        const copy = document.createElement('span');
        copy.textContent = entry.title || entry.kind || '';
        button.append(time, copy);
        item.append(button);
        timeline.append(item);
      }
    } else {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = '接口未返回活动记录。';
      timeline.append(item);
    }

    inspector.replaceChildren(heading, kind, summary, gapsLabel, gaps, activityLabel, timeline);
  }

  function paintPlayback() {
    const board = state.board;
    const has = Boolean(board?.nodes.length);
    const order = state.reveal.order;
    const done = state.reveal.count >= order.length;
    $('replay').disabled = !has;
    $('latest').disabled = !has || done;
    $('pause').disabled = !has || (!state.reveal.playing && done);
    $('pause').textContent = state.reveal.playing ? '暂停' : '继续';
    $('follow').setAttribute('aria-pressed', String(state.follow));
    $('zoom-level').textContent = `${Math.round(state.view.k * 100)}%`;
  }

  function paintBusy() {
    $('refresh').disabled = state.busy.refresh || state.phase === 'loading';
    $('start').disabled = state.busy.start;
    $('refresh').classList.toggle('is-loading', state.busy.refresh);
    $('shell').setAttribute('aria-busy', String(state.phase === 'loading' || state.boardPhase === 'loading'));
  }

  function paintError() {
    const notice = $('error');
    if (state.phase === 'error' && state.listError) {
      notice.hidden = false;
      $('error-text').textContent = describeTraceError(state.listError);
    } else {
      notice.hidden = true;
      $('error-text').textContent = '—';
    }
  }

  function paintAll() {
    paintError();
    paintList();
    paintStage();
    paintNodes();
    paintEdges();
    applyView();
    paintInspector();
    paintPlayback();
    paintBusy();
  }

  // ---------- 视图变换 ----------

  function applyView() {
    $('world').style.transform =
      `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.k})`;
  }

  function applyZoom(next) {
    state.view.k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    applyView();
    paintPlayback();
  }

  function canvasRect() {
    return $('canvas').getBoundingClientRect();
  }

  function fitView() {
    const board = state.board;
    if (!board?.nodes.length) {
      state.view = { x: 40, y: 40, k: 1 };
      applyView();
      paintPlayback();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of board.nodes) {
      const position = state.positions.get(node.id) ?? { x: 0, y: 0 };
      minX = Math.min(minX, position.x - 30);
      minY = Math.min(minY, position.y - 30);
      maxX = Math.max(maxX, position.x + 160);
      maxY = Math.max(maxY, position.y + 30);
    }
    const pad = 60;
    const width = maxX - minX + pad * 2;
    const height = maxY - minY + pad * 2;
    const rect = canvasRect();
    let k = Math.min(rect.width / width, rect.height / height, 1.2);
    k = Math.max(ZOOM_MIN, Number.isFinite(k) ? k : 1);
    state.view.k = k;
    state.view.x = (rect.width - (maxX - minX) * k) / 2 - minX * k;
    state.view.y = (rect.height - (maxY - minY) * k) / 2 - minY * k;
    applyView();
    paintPlayback();
  }

  function centerOnLatest() {
    const { latest } = visibleState();
    if (latest === undefined || !state.board) return;
    const position = state.positions.get(state.board.nodes[latest].id);
    if (!position) return;
    const rect = canvasRect();
    state.view.x = rect.width / 2 - position.x * state.view.k;
    state.view.y = rect.height / 2 - position.y * state.view.k;
    applyView();
  }

  function focusNode(index) {
    const board = state.board;
    if (!board?.nodes[index]) return;
    setSelection(index, null);
    const position = state.positions.get(board.nodes[index].id);
    if (!position) return;
    const rect = canvasRect();
    state.view.x = rect.width / 2 - position.x * state.view.k;
    state.view.y = rect.height / 2 - position.y * state.view.k;
    applyView();
  }

  // ---------- 力导向布局（展示层；接口没有坐标） ----------

  function layout(board) {
    const nodes = board?.nodes ?? [];
    state.positions = new Map();
    if (!nodes.length) return;
    const points = nodes.map((node, index) => {
      const angle = (Math.PI * 2 * index) / nodes.length;
      const radius = 200 + (index % 3) * 30;
      return { id: node.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
    const indexById = new Map(points.map((point, index) => [point.id, index]));
    const links = (board.edges ?? [])
      .map(edge => [indexById.get(edge.from), indexById.get(edge.to)])
      .filter(([from, to]) => from !== undefined && to !== undefined);
    const minDistance = 130;
    for (let step = 0; step < 320; step += 1) {
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          const a = points[i];
          const b = points[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const push = 9000 / (distance * distance);
          const ux = dx / distance;
          const uy = dy / distance;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
      for (const [from, to] of links) {
        const a = points[from];
        const b = points[to];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const pull = (distance - minDistance) * 0.012;
        const ux = dx / distance;
        const uy = dy / distance;
        a.x += ux * pull;
        a.y += uy * pull;
        b.x -= ux * pull;
        b.y -= uy * pull;
      }
      for (const point of points) {
        point.x *= 0.996;
        point.y *= 0.996;
      }
    }
    let minX = Infinity;
    let minY = Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
    }
    for (const point of points) state.positions.set(point.id, { x: point.x + 80 - minX, y: point.y + 80 - minY });
  }

  // ---------- 渐进显示 ----------

  function stopReveal() {
    if (state.reveal.timer !== null) {
      timers.clearInterval(state.reveal.timer);
      state.reveal.timer = null;
    }
    state.reveal.playing = false;
  }

  function tickReveal() {
    if (!host.isConnected) {   // 路由切走：停掉定时器，不空转
      stopReveal();
      return;
    }
    const board = state.board;
    if (!board) { stopReveal(); return; }
    if (state.reveal.count >= state.reveal.order.length) {
      stopReveal();
      paintAll();
      if (state.follow) fitView();
      return;
    }
    state.reveal.count += 1;
    const finished = state.reveal.count >= state.reveal.order.length;
    paintAll();
    if (state.follow) centerOnLatest();
    if (finished) {   // 最后一个节点出现就收工：不等下一拍，也不再空转
      stopReveal();
      if (state.follow) fitView();
      paintPlayback();
    }
  }

  function startReveal() {
    stopReveal();
    const board = state.board;
    state.reveal.order = board ? discoveryOrder(board) : [];
    state.reveal.count = state.reveal.order.length ? 1 : 0;
    paintAll();
    if (!state.reveal.order.length) return;
    if (state.follow) centerOnLatest();
    if (state.reveal.count >= state.reveal.order.length) {   // 只有一个节点：直接收工
      if (state.follow) fitView();
      return;
    }
    state.reveal.playing = true;
    state.reveal.timer = timers.setInterval(tickReveal, REVEAL_INTERVAL_MS);
    paintPlayback();
  }

  function resumeReveal() {
    const board = state.board;
    if (!board?.nodes.length) return;
    if (state.reveal.count >= state.reveal.order.length) return;
    state.reveal.count = Math.max(1, state.reveal.count);
    paintAll();
    state.reveal.playing = true;
    state.reveal.timer = timers.setInterval(tickReveal, REVEAL_INTERVAL_MS);
    paintPlayback();
  }

  // ---------- 取数 ----------

  function adoptBoard(board) {
    state.board = board;
    state.boardPhase = 'ready';
    state.boardError = null;
    state.selectedNode = null;
    state.selectedEdge = null;
    stopReveal();
    layout(board);
    state.reveal.count = 0;
    state.reveal.order = discoveryOrder(board);
    paintAll();
    fitView();
    startReveal();
  }

  async function selectBoard(id) {
    state.selectedId = id;
    state.selectedNode = null;
    state.selectedEdge = null;
    stopReveal();
    state.board = null;
    state.boardPhase = 'loading';
    state.boardError = null;
    state.reveal.count = 0;
    state.reveal.order = [];
    paintAll();
    try {
      const board = await getTraceBoard(id, request);
      if (state.selectedId !== id) return;   // 期间又切走了
      adoptBoard(board);
    } catch (error) {
      if (state.selectedId !== id) return;
      state.boardPhase = 'partial';
      state.boardError = error;
      paintAll();
      announce(`白板 ${id} 读取失败：${describeTraceError(error)}`);
    }
  }

  async function loadList() {
    if (!state.boards.length) state.phase = 'loading';
    state.busy.refresh = true;
    paintAll();
    try {
      const boards = await listTraceBoards(request);
      state.boards = boards;
      state.phase = 'ready';
      state.listError = null;
      const preferred = state.pendingTarget ?? state.selectedId;
      const found = boards.some(board => board.id === preferred) ? preferred : boards[0]?.id ?? null;
      state.pendingTarget = null;
      if (!found) {
        state.selectedId = null;
        state.board = null;
        state.boardPhase = 'idle';
        state.reveal.order = [];
        state.reveal.count = 0;
        paintAll();
        announce(boards.length ? '白板列表已更新' : '还没有白板');
        return;
      }
      await selectBoard(found);
      announce('白板列表已更新');
    } catch (error) {
      state.phase = 'error';
      state.listError = error;
      state.boards = [];
      state.selectedId = null;
      state.board = null;
      state.boardPhase = 'idle';
      paintAll();
      announce(`白板列表读取失败：${describeTraceError(error)}`);
    } finally {
      state.busy.refresh = false;
      paintAll();
    }
  }

  async function createBoard() {
    if (state.busy.start) return;
    const input = $('target');
    const value = input.value.trim();
    if (!value) {
      note('请输入告警 ID 或 IPv4 地址。');
      input.focus();
      return;
    }
    if (!validTraceTarget(value)) {
      note('请输入有效告警 ID 或 IPv4 地址。');
      input.focus();
      return;
    }
    const existing = state.boards.find(board => board.id === value);
    if (existing) {
      note('该目标已有白板，已切换。');
      await selectBoard(existing.id);
      return;
    }
    state.busy.start = true;
    paintBusy();
    try {
      const board = await startTraceBoard(value, request);
      state.boards = [board, ...state.boards.filter(item => item.id !== board.id)];
      state.selectedId = board.id;
      adoptBoard(board);
      note('已提交溯源任务（202），等待后端返回进度。');
      announce(`已提交溯源任务 ${value}`);
      input.value = '';
    } catch (error) {
      note(`新建失败：${describeTraceError(error)}`);
      announce(`新建失败：${describeTraceError(error)}`);
    } finally {
      state.busy.start = false;
      paintAll();
    }
  }

  // ---------- 选择 ----------

  function setSelection(nodeIndex, edgeIndex) {
    state.selectedNode = nodeIndex;
    state.selectedEdge = edgeIndex;
    paintNodes();
    paintEdges();
    paintInspector();
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void loadList(); });
  $('retry').addEventListener('click', () => { void loadList(); });
  $('start').addEventListener('click', () => { void createBoard(); });
  $('target').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void createBoard();
  });

  $('board-list').addEventListener('click', event => {
    const button = event.target.closest('[data-board-id]');
    if (!button) return;
    const id = button.dataset.boardId;
    if (!id || id === state.selectedId) return;
    note('');
    void selectBoard(id);
  });

  $('replay').addEventListener('click', () => {
    if (!state.board?.nodes.length) return;
    startReveal();
  });
  $('pause').addEventListener('click', () => {
    if (state.reveal.playing) {
      stopReveal();
      paintPlayback();
      return;
    }
    resumeReveal();
  });
  $('latest').addEventListener('click', () => {
    const board = state.board;
    if (!board?.nodes.length) return;
    stopReveal();
    state.reveal.count = state.reveal.order.length;
    paintAll();
    if (state.follow) fitView();
    announce('已跳到最新');
  });
  $('follow').addEventListener('click', () => {
    state.follow = !state.follow;
    paintPlayback();
    announce(state.follow ? '跟随已开启' : '跟随已关闭');
  });
  $('zoom-in').addEventListener('click', () => applyZoom(state.view.k * 1.15));
  $('zoom-out').addEventListener('click', () => applyZoom(state.view.k / 1.15));
  $('fit').addEventListener('click', () => fitView());
  $('clear-select').addEventListener('click', () => {
    setSelection(null, null);
    announce('已取消选择');
  });

  $('canvas').addEventListener('click', event => {
    const nodeButton = event.target.closest('.gnode');
    if (nodeButton) {
      setSelection(Number(nodeButton.dataset.index), null);
      return;
    }
    const edge = event.target.closest('[data-edge]');
    if (edge) setSelection(null, Number(edge.getAttribute('data-edge')));
  });

  // 关系到节点的连线是 SVG：用键盘（Enter / 空格）也能选中，可访问性最低线要求键盘可达。
  $('edges').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const edge = event.target.closest('[data-edge]');
    if (!edge) return;
    event.preventDefault();
    setSelection(null, Number(edge.getAttribute('data-edge')));
  });

  $('inspector').addEventListener('click', event => {
    const button = event.target.closest('[data-node]');
    if (!button || button.disabled) return;
    focusNode(Number(button.dataset.node));
  });

  // 画布：拖空白平移、滚轮以指针为中心缩放、拖节点改位置（稿 §4）
  let drag = null;
  let pan = null;

  $('canvas').addEventListener('pointerdown', event => {
    const nodeButton = event.target.closest('.gnode');
    if (nodeButton) {
      const index = Number(nodeButton.dataset.index);
      const node = state.board?.nodes[index];
      const position = node && state.positions.get(node.id);
      if (!node || !position) return;
      drag = { index, nodeId: node.id, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, moved: false };
      stopReveal();
      paintPlayback();
      nodeButton.classList.add('is-dragging');
      if (typeof nodeButton.setPointerCapture === 'function') nodeButton.setPointerCapture(event.pointerId);
      setSelection(index, null);
      event.preventDefault();
      return;
    }
    if (event.target.closest('[data-edge]')) return;
    pan = { startX: event.clientX, startY: event.clientY, x: state.view.x, y: state.view.y };
    $('canvas').classList.add('is-panning');
    setSelection(null, null);
  });

  $('canvas').addEventListener('pointermove', event => {
    if (drag) {
      const dx = (event.clientX - drag.startX) / state.view.k;
      const dy = (event.clientY - drag.startY) / state.view.k;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      state.positions.set(drag.nodeId, { x: drag.x + dx, y: drag.y + dy });
      paintNodes();
      paintEdges();
      return;
    }
    if (pan) {
      state.view.x = pan.x + (event.clientX - pan.startX);
      state.view.y = pan.y + (event.clientY - pan.startY);
      applyView();
    }
  });

  function endPointer() {
    if (drag) {
      drag = null;
      const dragging = $('nodes').querySelector('.gnode.is-dragging');
      if (dragging) dragging.classList.remove('is-dragging');
    }
    if (pan) {
      pan = null;
      $('canvas').classList.remove('is-panning');
    }
  }

  $('canvas').addEventListener('pointerup', endPointer);
  $('canvas').addEventListener('pointercancel', endPointer);

  $('canvas').addEventListener('wheel', event => {
    if (!state.board) return;
    event.preventDefault();
    const rect = canvasRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    const nextK = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.view.k * factor));
    state.view.x = mx - (mx - state.view.x) * (nextK / state.view.k);
    state.view.y = my - (my - state.view.y) * (nextK / state.view.k);
    state.view.k = nextK;
    applyView();
    paintPlayback();
  }, { passive: false });

  // ---------- 起 ----------

  const initialTarget = options.initialTarget ? String(options.initialTarget) : null;
  if (initialTarget) {
    state.pendingTarget = initialTarget;
    $('target').value = initialTarget;
  }
  void loadList().then(() => {
    if (!initialTarget || state.boards.some(board => board.id === initialTarget)) return;
    note(`「${initialTarget}」还没有白板，点「新建」开始溯源。`);
  });

  return host;
}

export const page = {
  id: 'trace',
  title: '深度溯源',
  navLabel: '深度溯源',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} context 路由参数（`#/trace/<target>` 的第二段作为预填目标）
   */
  render(content, context) {
    const initialTarget = context?.params?.[0] ?? null;
    content.replaceChildren(mountTracePage({ initialTarget }));
  },
};
