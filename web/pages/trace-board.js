// 页面：深度溯源 · 白板（P003-T016 起；D016 / D020）
//
// 一页只讲这一条是怎么触发的：主画面是往回的链，告警钉在右边，原因往左长（D016「方向」）。
// 数据只有四样：`hops[]`（一跳）/ `links[]`（谁引起了谁，from 更晚、to 更早）/ `gaps[]`（断点）/
// `discovery[]`（发现顺序，重放只播这个）。`nodes / edges / activity` 是旧字段，本页不当主数据。
//
// 与稿（`design/trace.html`）的关系：
//   - 稿的视觉语言照搬：点阵背景、9px 圆点 + 11px 标签、1.2px 细线 + 箭头、右侧检查器、缩放 25%–250%。
//   - 稿的语义被 D016 换掉：力导向 → 固定方向（告警右、原因左）；`activity` 时间线 → `discovery` 重放；
//     检查器列节点全部字段 → 只列种类 / 机器 / 时间 / 证据（D016「点开」）；列表移走 → `pages/trace.js`。
//   - 稿没有、D016 要的：断点直接写在图上（不点开也看得见）、拖过的位置记住、进行中自己长。
//   逐条记账见 `coding-reports/P003-T016.md` 的稿→码对照表。
//
// 位置记忆：D016 要「写在这一跳上（x / y，相对告警点）」，但接口没有写位置的入口
// （`GET/POST /api/trace/boards` 之外没有 PATCH，见 openapi.yaml:456-560），所以本页写在浏览器
// `localStorage`（键 `hids.trace.positions.<白板 ID>`，值 `{ hopId: {x, y} }`，坐标相对告警点）。
// 这是本卡的「未决」第 1 条：后端补了写位置的入口，这里换过去即可（读写都在 readSavedPositions / writePosition 两个函数里）。
//
// 不能自己加点、加线，不能删、不能改关系：本页没有任何新建/删除/编辑入口，也没有输入框（D016「不做」+ D020）。

import { getTraceBoard, startTraceBoard } from '../src/trace.js';
import {
  describeTraceError, eventTypeLabel, formatClock, kindLabel, shortBoardId, statusClass, statusLabel,
} from '../src/trace-view.js';

const STYLE_HREF = 'assets/pages/trace.css';
const COLUMN_GAP = 190;         // 往左一列的间距（px）
const ROW_GAP = 64;             // 同一列里两跳的间距
const LABEL_ROOM = 150;         // 标签在圆点右边占的宽度（适应视图时算进去）
const REVEAL_STEP_MS = 900;     // 稿 §3：每 900ms 一个
const POLL_MS = 5000;           // 进行中的轮询间隔（接口没有进度流）
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const STORAGE_PREFIX = 'hids.trace.positions.';
const GAP_COPY = '上一步没有了';

const TEMPLATE = `
<div class="trace-page trace-board">
  <div class="trace-tools">
    <a class="textbtn" data-role="back" href="#/trace">← 溯源列表</a>
    <span class="board-id mono od-truncate" data-role="board-id">—</span>
    <button type="button" class="textbtn" data-role="refresh">
      <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      刷新
    </button>
  </div>

  <div class="notice" data-role="notice" role="alert" hidden>
    <span><strong>白板读取失败</strong>，<span data-role="notice-text">—</span></span>
    <button type="button" class="textbtn" data-role="retry">重试</button>
  </div>

  <section class="stage" aria-label="溯源白板">
    <header class="stage-bar">
      <div class="stage-title">
        <h2 data-role="board-title">—</h2>
        <span class="state" data-role="board-state"><span data-role="board-state-text">—</span></span>
        <span class="meta mono" data-role="board-len">—</span>
        <span class="meta" data-role="board-gaps">—</span>
        <span class="meta reason" data-role="board-reason" hidden></span>
      </div>
      <div class="playback" data-role="playback">
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
          <div class="gap-notes" data-role="gap-notes"></div>
          <div class="nodes" data-role="nodes"></div>
        </div>
        <div class="canvas-empty" data-role="canvas-empty">
          <div>
            <h3 data-role="canvas-empty-title">正在读取白板…</h3>
            <p data-role="canvas-empty-text">这一条触发链正在从研判服务读取。</p>
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

  <p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
</div>`;

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

// ---------- 纯函数：排在哪儿、怎么重放（都被单测直接点名） ----------

/** 告警那一跳：`kind === 'alert'`；没有标记就退回第一跳（后端保证它在最前，openapi.yaml:1778）。 */
export function alertHopOf(board) {
  const hops = Array.isArray(board?.hops) ? board.hops : [];
  return hops.find(hop => hop.kind === 'alert') ?? hops[0] ?? null;
}

/**
 * 每一跳离告警有多远：沿 `links` 走（无向），告警是 0 层。
 * 连不上任何线的跳（后端理论上不会给）放到最左一列，不假装它在线中间（D016：不相关的点不出现）。
 * @returns {Map<string, number>} hopId → 深度
 */
export function hopDepths(board) {
  const alert = alertHopOf(board);
  const depth = new Map();
  if (!alert) return depth;
  depth.set(alert.id, 0);
  const neighbours = new Map();
  for (const link of Array.isArray(board?.links) ? board.links : []) {
    if (typeof link?.from !== 'string' || typeof link?.to !== 'string') continue;
    if (!neighbours.has(link.from)) neighbours.set(link.from, []);
    if (!neighbours.has(link.to)) neighbours.set(link.to, []);
    neighbours.get(link.from).push(link.to);
    neighbours.get(link.to).push(link.from);
  }
  const queue = [alert.id];
  while (queue.length) {
    const id = queue.shift();
    for (const next of neighbours.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(id) + 1);
      queue.push(next);
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const hops = Array.isArray(board?.hops) ? board.hops : [];
  for (const hop of hops) if (!depth.has(hop.id)) depth.set(hop.id, maxDepth + 1);
  return depth;
}

/**
 * 自动排：告警在右（x = 0），原因往左一列一列（D016「方向」）。同一列按 `discovered` 竖着分开。
 * 返回的坐标是「相对告警点」的世界坐标（告警在 0,0）——与 D016 要求存进这一跳的 x / y 是同一套数。
 * @returns {Map<string, {x: number, y: number, depth: number}>}
 */
export function layoutHops(board) {
  const hops = Array.isArray(board?.hops) ? board.hops : [];
  const depth = hopDepths(board);
  const byDepth = new Map();
  for (const hop of hops) {
    const level = depth.get(hop.id) ?? 0;
    if (!byDepth.has(level)) byDepth.set(level, []);
    byDepth.get(level).push(hop);
  }
  const positions = new Map();
  for (const [level, group] of byDepth) {
    group.sort((a, b) => (Number(a.discovered) || 0) - (Number(b.discovered) || 0));
    group.forEach((hop, index) => {
      positions.set(hop.id, {
        x: level === 0 ? 0 : -COLUMN_GAP * level,
        y: (index - (group.length - 1) / 2) * ROW_GAP,
        depth: level,
      });
    });
  }
  return positions;
}

/** 发现顺序：`discovery` 按 step 排；没有就退回「先全部跳、再全部线」（旧白板兼容，不编顺序）。 */
export function replaySteps(board) {
  const hops = Array.isArray(board?.hops) ? board.hops : [];
  const links = Array.isArray(board?.links) ? board.links : [];
  const known = new Map([...hops.map(hop => [hop.id, 'hop']), ...links.map(link => [link.id, 'link'])]);
  const discovery = Array.isArray(board?.discovery) ? board.discovery : [];
  const steps = discovery
    .filter(entry => entry && known.has(entry.id) && known.get(entry.id) === entry.kind)
    .map(entry => ({ kind: entry.kind, id: entry.id, step: Number(entry.step) || 0 }))
    .sort((a, b) => a.step - b.step)
    .map(({ kind, id }) => ({ kind, id }));
  const seen = new Set(steps.map(step => step.id));
  for (const hop of hops) if (!seen.has(hop.id)) steps.push({ kind: 'hop', id: hop.id });
  for (const link of links) if (!seen.has(link.id)) steps.push({ kind: 'link', id: link.id });
  return steps;
}

/**
 * 播到第 n 步时哪些东西在图上：告警那一跳永远在（D016「钉死在右边 / 不会被清掉」）；
 * 线要等它自己那一步，且两个端点都已出现（D016「两个端点都出现了，线才出现」）。
 * @param {object} board
 * @param {number} count 已播步数（>= steps.length 表示全都在）
 */
export function visibleSets(board, count) {
  const steps = replaySteps(board);
  const hops = new Set();
  const links = new Set();
  const alert = alertHopOf(board);
  if (alert) hops.add(alert.id);
  const limit = Math.max(0, Math.min(count, steps.length));
  for (let index = 0; index < limit; index += 1) {
    const step = steps[index];
    if (step.kind === 'hop') hops.add(step.id);
  }
  for (let index = 0; index < limit; index += 1) {
    const step = steps[index];
    if (step.kind !== 'link') continue;
    const link = (board.links ?? []).find(item => item.id === step.id);
    if (!link) continue;
    if (hops.has(link.from) && hops.has(link.to)) links.add(link.id);
  }
  return { hops, links, total: steps.length, shown: limit };
}

/** 位置存储：键按白板分，值 `{ hopId: {x, y} }`（相对告警点）。读不到就当没存过，不抛。 */
export function readSavedPositions(storage, boardId) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${boardId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const clean = {};
    for (const [hopId, value] of Object.entries(parsed)) {
      const x = Number(value?.x);
      const y = Number(value?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) clean[hopId] = { x, y };
    }
    return clean;
  } catch {
    return {};
  }
}

export function savePosition(storage, boardId, hopId, position) {
  if (!storage || !hopId) return;
  try {
    const current = readSavedPositions(storage, boardId);
    current[hopId] = { x: Math.round(position.x), y: Math.round(position.y) };
    storage.setItem(`${STORAGE_PREFIX}${boardId}`, JSON.stringify(current));
  } catch {
    // 隐私模式 / 配额满：位置只在这次会话里有效，不因为存不下就把页面弄坏
  }
}

/**
 * 挂载白板页。
 * @param {{ target?: string, fetchImpl?: typeof fetch, baseUrl?: string,
 *   timers?: { setInterval: Function, clearInterval: Function }, storage?: Storage }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountTraceBoardPage(options = {}) {
  const document = globalThis.document;
  const timers = options.timers ?? {
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: id => globalThis.clearInterval(id),
  };
  const storage = options.storage ?? (() => {
    try { return globalThis.localStorage ?? null; } catch { return null; }
  })();
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'trace-board-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  const state = {
    target: options.target ? String(options.target) : '',
    phase: 'loading',       // loading | ready | error
    error: null,
    staleError: null,       // 已有白板、这次刷新失败（partial）
    board: null,
    positions: new Map(),   // hopId → {x, y}
    selectedHop: null,
    selectedLink: null,
    reveal: { count: 0, playing: false, timer: null },
    view: { x: 40, y: 40, k: 1 },
    follow: true,
    poll: null,
    busy: false,
  };

  function announce(message) {
    $('sr-status').textContent = message;
  }

  // ---------- 取数与状态 ----------

  function stopPoll() {
    if (state.poll !== null) {
      timers.clearInterval(state.poll);
      state.poll = null;
    }
  }

  function stopReveal() {
    if (state.reveal.timer !== null) {
      timers.clearInterval(state.reveal.timer);
      state.reveal.timer = null;
    }
    state.reveal.playing = false;
  }

  function replayable() {
    return state.board?.status === 'done';
  }

  /** 显示几步：完成为重放中按状态播，其余一律「已知的全在」。 */
  function shownCount() {
    if (!replayable()) return replaySteps(state.board).length;
    return state.reveal.count;
  }

  function emptyCopy() {
    if (!state.target) return { title: '没有指定这一条', text: '从列表点一行进来，或者从告警列表点某一行的「溯源」。' };
    if (state.phase === 'loading') return { title: '正在读取白板…', text: '这一条触发链正在从研判服务读取。' };
    if (state.phase === 'error') {
      if (state.error?.kind === 'notfound') {
        return { title: '这条溯源还没建起来', text: '目标无效或白板已被删掉。回列表重新从告警进入。' };
      }
      return { title: '白板读取失败', text: describeTraceError(state.error) };
    }
    if (!state.board) return null;
    if (!state.board.hops.length) {
      return state.board.status === 'running'
        ? { title: '还没有跳', text: '任务在跑，新的一跳会自己从左边长出来。' }
        : { title: '这条链没有跳', text: '接口没有返回链上的跳。' };
    }
    return null;
  }

  function adoptPositions(board, { keep } = {}) {
    const auto = layoutHops(board);
    const saved = readSavedPositions(storage, board.id);
    const next = new Map();
    for (const [hopId, position] of auto) {
      if (keep && state.positions.has(hopId)) {
        next.set(hopId, state.positions.get(hopId));   // 已经画出来的跳不跟着重新排（D016：不突然改已有点的含义）
        continue;
      }
      const stored = saved[hopId];
      next.set(hopId, stored ? { x: stored.x, y: stored.y } : { x: position.x, y: position.y });
    }
    state.positions = next;
  }

  function adoptBoard(board, { first = false } = {}) {
    const previousStatus = state.board?.status;
    state.board = board;
    state.phase = 'ready';
    state.error = null;
    state.staleError = null;
    adoptPositions(board, { keep: !first });

    if (board.status === 'running') {
      stopReveal();
      state.reveal.count = replaySteps(board).length;
      startPoll();
    } else {
      stopPoll();
      if (first && board.status === 'done') {
        fitView();
        startReveal();        // 稿 §3：完成态白板打开时从第一个节点重放
        return;
      }
      if (previousStatus === 'running') stopReveal();
      state.reveal.count = replaySteps(board).length;
    }
    paint();
    if (first || previousStatus === 'running') fitView();
    else if (state.follow) fitView();
  }

  async function load({ silent = false } = {}) {
    if (state.busy) return;
    if (!state.target) {
      state.phase = 'error';
      state.error = null;
      paint();
      return;
    }
    state.busy = true;
    if (!silent && !state.board) {
      state.phase = 'loading';
      paint();
    }
    try {
      let board;
      try {
        board = await getTraceBoard(state.target, request);
      } catch (error) {
        if (error?.kind !== 'notfound') throw error;
        // 列表入口带过来的告警还没有白板：直接起一条（D015「没有就创建并开始」）
        board = await startTraceBoard(state.target, request);
        announce(`已开始为 ${state.target} 建白板`);
      }
      adoptBoard(board, { first: !state.board });
    } catch (error) {
      if (state.board) {
        state.staleError = error;
        paint();
        announce(`刷新失败：${describeTraceError(error)}`);
      } else {
        state.phase = 'error';
        state.error = error;
        paint();
        announce(`白板读取失败：${describeTraceError(error)}`);
      }
    } finally {
      state.busy = false;
      paint();
    }
  }

  function startPoll() {
    if (state.poll !== null) return;
    state.poll = timers.setInterval(() => {
      if (!host.isConnected) { stopPoll(); return; }   // 路由切走：停掉，不空转
      if (state.busy) return;
      void load({ silent: true });
    }, POLL_MS);
  }

  // ---------- 渲染 ----------

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

    $('board-id').textContent = board?.id || state.target || '—';
    $('back').href = '#/trace';
    if (!board) {
      $('board-title').textContent = '—';
      $('board-state').className = 'state';
      $('board-state-text').textContent = '—';
      $('board-len').textContent = '—';
      $('board-gaps').textContent = '—';
      $('board-reason').hidden = true;
      $('progress').textContent = '—';
      return;
    }

    const type = eventTypeLabel(board.alert?.type);
    $('board-title').textContent = board.alert?.title || type || shortBoardId(board.id);
    $('board-title').title = board.alert?.title || board.id;
    $('board-state').className = `state ${statusClass(board.status)}`.trim();
    $('board-state-text').textContent = statusLabel(board.status);
    $('board-len').textContent = `链长 ${board.hops.length} 跳`;
    $('board-gaps').textContent = board.gaps.length ? `断点 ${board.gaps.length} 处` : '没有断点';
    $('board-gaps').classList.toggle('is-gap', board.gaps.length > 0);

    const reason = $('board-reason');
    const failed = board.status === 'failed' || board.status === 'interrupted';
    reason.hidden = !failed;
    reason.textContent = failed
      ? (board.summary ? `${statusLabel(board.status)}：${board.summary}` : `${statusLabel(board.status)}：接口没有返回原因`)
      : '';

    const { hops: visibleHops, links: visibleLinks, total, shown } = visibleSets(board, shownCount());
    $('progress').textContent = `${visibleHops.size} / ${board.hops.length} 跳 · ` +
      `${visibleLinks.size} / ${board.links.length} 条线${replayable() ? ` · 第 ${shown} / ${total} 步` : ''}`;
  }

  function paintNodes() {
    const layer = $('nodes');
    const board = state.board;
    if (!board?.hops.length) {
      layer.replaceChildren();
      return;
    }
    const { hops: visible } = visibleSets(board, shownCount());
    const alert = alertHopOf(board);
    const buttons = [];
    for (const hop of board.hops) {
      if (!visible.has(hop.id)) continue;
      const position = state.positions.get(hop.id) ?? { x: 0, y: 0 };
      const isAlert = hop.id === alert?.id;
      const button = el(document, 'button', {
        type: 'button',
        class: `gnode${isAlert ? ' is-alert' : ''}${hop.id === state.selectedHop ? ' is-active' : ''}`,
        'aria-pressed': hop.id === state.selectedHop ? 'true' : 'false',
        'aria-label': `${kindLabel(hop.kind)}：${hop.label ?? hop.id}${hop.host ? `，机器 ${hop.host}` : ''}`,
        dataset: { hop: hop.id },
      }, [
        el(document, 'span', { class: 'gnode-dot' }),
        el(document, 'span', { class: 'gnode-label', text: hop.label || hop.id }),
        hop.host ? el(document, 'span', { class: 'gnode-host mono', text: hop.host }) : null,
      ]);
      button.style.left = `${position.x - 4.5}px`;
      button.style.top = `${position.y}px`;
      buttons.push(button);
    }
    layer.replaceChildren(...buttons);
  }

  function svg(tag, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  }

  function paintEdges() {
    const layer = $('edges');
    const board = state.board;
    if (!board?.links.length) {
      layer.replaceChildren();
      return;
    }
    const { links: visible } = visibleSets(board, shownCount());
    let maxX = 1;
    let maxY = 1;
    for (const position of state.positions.values()) {
      maxX = Math.max(maxX, position.x + LABEL_ROOM);
      maxY = Math.max(maxY, position.y + 60);
    }
    layer.setAttribute('width', String(maxX + 400));
    layer.setAttribute('height', String(maxY + 400));
    const parts = [];
    for (const link of board.links) {
      if (!visible.has(link.id)) continue;
      const from = state.positions.get(link.from);
      const to = state.positions.get(link.to);
      if (!from || !to) continue;
      // 线是「谁引起了谁」，从右往左指：from（更晚、靠告警）→ to（更早的原因），箭头落在 to 那一端。
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / distance;
      const uy = dy / distance;
      const tipX = to.x + ux * 6;
      const tipY = to.y + uy * 6;
      const angle = Math.atan2(dy, dx);
      const size = 7;
      const spread = 0.42;
      const active = state.selectedLink === link.id;
      const line = svg('line', { class: `edge${active ? ' is-active' : ''}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      const arrow = svg('polygon', {
        class: `edge-arrow${active ? ' is-active' : ''}`,
        points: `${tipX},${tipY} ${tipX - size * Math.cos(angle - spread)},${tipY - size * Math.sin(angle - spread)} ` +
          `${tipX - size * Math.cos(angle + spread)},${tipY - size * Math.sin(angle + spread)}`,
      });
      parts.push(line, arrow);
      if (link.rel) {
        const text = svg('text', {
          class: `edge-label${active ? ' is-active' : ''}`,
          x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 7, 'text-anchor': 'middle',
        });
        text.textContent = link.rel;
        parts.push(text);
      }
      const hit = svg('line', {
        class: 'edge-hit', 'data-link': link.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        tabindex: '0', role: 'button',
        'aria-label': `关系：${link.rel || '谁引起了谁'}（${link.from} → ${link.to}）`,
      });
      parts.push(hit);
    }
    layer.replaceChildren(...parts);
  }

  function paintGaps() {
    const layer = $('gap-notes');
    const board = state.board;
    if (!board?.gaps.length) {
      layer.replaceChildren();
      return;
    }
    const { hops: visible } = visibleSets(board, shownCount());
    let minX = 0;
    for (const position of state.positions.values()) minX = Math.min(minX, position.x);
    const notes = [];
    for (const gap of board.gaps) {
      const reason = String(gap?.reason ?? '').trim();
      const hopId = gap?.hop_id ?? null;
      let x = minX - COLUMN_GAP;
      let y = 0;
      if (hopId) {
        if (!visible.has(hopId)) continue;    // 那一跳还没出现，断点也还没到画的时候
        const position = state.positions.get(hopId);
        if (!position) continue;
        x = position.x - 8;
        y = position.y;
      }
      const note = el(document, 'p', {
        class: `gap-note${hopId ? ' is-hop' : ' is-chain'}`,
        text: `${GAP_COPY}${reason ? ` · ${reason}` : ''}`,
        title: reason,
      });
      // 断点写在「断了的那一跳」左边（D016：不点开，也能看见）；x 是右边界，文字向左展开。
      note.style.left = `${x - 176}px`;
      note.style.top = `${y}px`;
      notes.push(note);
    }
    layer.replaceChildren(...notes);
  }

  function kvRow(term, value) {
    const row = el(document, 'div', { class: 'kv-row' }, [
      el(document, 'dt', { text: term }),
      el(document, 'dd', { text: value === null || value === undefined || value === '' ? '—' : String(value) }),
    ]);
    return row;
  }

  function paintInspector() {
    const inspector = $('inspector');
    const clear = $('clear-select');
    const board = state.board;
    if (!board) {
      clear.hidden = true;
      inspector.replaceChildren(el(document, 'p', { class: 'muted', text: '还没有白板。' }));
      return;
    }

    const hop = board.hops.find(item => item.id === state.selectedHop);
    if (hop) {
      clear.hidden = false;
      const list = el(document, 'dl', { class: 'kv' }, [
        kvRow('种类', kindLabel(hop.kind)),
        kvRow('机器', hop.host),
        kvRow('发生时间', formatClock(hop.occurred_at) || '未知'),
        kvRow('证据', hop.evidence_id),
      ]);
      inspector.replaceChildren(
        el(document, 'h3', { text: hop.label || hop.id }),
        el(document, 'span', { class: 'kind', text: kindLabel(hop.kind) }),
        list,
        el(document, 'p', { class: 'summary', text: hop.evidence_id
          ? '证据正文在告警详情里看；白板这一页只记证据号。'
          : '接口没有返回撑着这一跳的证据号。' }),
      );
      return;
    }

    const link = board.links.find(item => item.id === state.selectedLink);
    if (link) {
      clear.hidden = false;
      inspector.replaceChildren(
        el(document, 'h3', { text: link.rel || '谁引起了谁' }),
        el(document, 'span', { class: 'kind', text: '线' }),
        el(document, 'dl', { class: 'kv' }, [
          kvRow('从', link.from),
          kvRow('到', link.to),
          kvRow('证据', link.evidence_id),
        ]),
      );
      return;
    }

    clear.hidden = true;
    const gaps = board.gaps.length
      ? el(document, 'ul', { class: 'gaps' }, board.gaps.map(gap => el(document, 'li', {
        text: `${GAP_COPY}${gap?.reason ? ` · ${gap.reason}` : ''}`,
      })))
      : el(document, 'p', { class: 'muted', text: '整条链没有断点。' });
    inspector.replaceChildren(
      el(document, 'h3', { text: '白板概览' }),
      el(document, 'span', { class: 'kind', text: statusLabel(board.status) }),
      el(document, 'p', { class: 'summary', text: board.summary || '接口没有返回摘要。' }),
      el(document, 'span', { class: 'section-label', text: `断点 · ${board.gaps.length}` }),
      gaps,
    );
  }

  function paintPlayback() {
    const board = state.board;
    const can = replayable();
    const steps = replaySteps(board);
    for (const role of ['replay', 'pause', 'latest']) $(role).hidden = !can;
    $('progress').hidden = false;
    $('replay').disabled = !can || !steps.length;
    $('latest').disabled = !can || state.reveal.count >= steps.length;
    // 播完才禁（稿 trace.html:1200 的条件）：暂停中按钮文本是「继续」，必须还能点，否则「停」成了单程门
    $('pause').disabled = !can || !steps.length || (!state.reveal.playing && state.reveal.count >= steps.length);
    $('pause').textContent = state.reveal.playing ? '暂停' : '继续';
    $('follow').setAttribute('aria-pressed', String(state.follow));
    $('zoom-level').textContent = `${Math.round(state.view.k * 100)}%`;
  }

  function paintNotice() {
    const notice = $('notice');
    if (!state.staleError) {
      notice.hidden = true;
      $('notice-text').textContent = '—';
      return;
    }
    notice.hidden = false;
    $('notice-text').textContent = describeTraceError(state.staleError);
  }

  function paint() {
    paintStage();
    paintNodes();
    paintEdges();
    paintGaps();
    paintInspector();
    paintPlayback();
    paintNotice();
    applyView();
    const busy = state.phase === 'loading';
    $('refresh').disabled = busy;
    $('refresh').classList.toggle('is-loading', busy);
    $('canvas').setAttribute('aria-busy', String(busy));
  }

  // ---------- 视图 ----------

  function applyView() {
    $('world').style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.k})`;
  }

  function canvasRect() {
    return $('canvas').getBoundingClientRect();
  }

  function bounds() {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const position of state.positions.values()) {
      minX = Math.min(minX, position.x - 20);
      minY = Math.min(minY, position.y - 24);
      maxX = Math.max(maxX, position.x + LABEL_ROOM);
      maxY = Math.max(maxY, position.y + 24);
    }
    return { minX, minY, maxX, maxY };
  }

  function fitView() {
    const rect = canvasRect();
    const { minX, minY, maxX, maxY } = bounds();
    const pad = 60;
    const width = Math.max(120, maxX - minX) + pad * 2;
    const height = Math.max(80, maxY - minY) + pad * 2;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(rect.width / width, rect.height / height, 1.2)));
    state.view.k = k;
    state.view.x = (rect.width - (maxX - minX) * k) / 2 - minX * k;
    state.view.y = (rect.height - (maxY - minY) * k) / 2 - minY * k;
    applyView();
    paintPlayback();
  }

  function applyZoom(next) {
    state.view.k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    applyView();
    paintPlayback();
  }

  // ---------- 重放 ----------

  function tickReveal() {
    if (!host.isConnected) { stopReveal(); return; }
    const steps = replaySteps(state.board);
    if (state.reveal.count >= steps.length) {
      stopReveal();
      paint();
      if (state.follow) fitView();
      return;
    }
    state.reveal.count += 1;
    paint();
    if (state.follow) fitView();
    if (state.reveal.count >= steps.length) {
      stopReveal();
      paint();
      announce('重放结束');
    }
  }

  /** 重放：从告警那一跳开始，按 discovery 一步一步往左长（D016「重放」）。 */
  function startReveal() {
    stopReveal();
    const steps = replaySteps(state.board);
    state.reveal.count = steps.length ? 0 : 0;
    paint();
    if (!steps.length) return;
    state.reveal.playing = true;
    state.reveal.timer = timers.setInterval(tickReveal, REVEAL_STEP_MS);
    paint();
  }

  function resumeReveal() {
    const steps = replaySteps(state.board);
    if (!steps.length || state.reveal.count >= steps.length) return;
    state.reveal.playing = true;
    state.reveal.timer = timers.setInterval(tickReveal, REVEAL_STEP_MS);
    paint();
  }

  // ---------- 选择 ----------

  function select(hopId, linkId) {
    state.selectedHop = hopId;
    state.selectedLink = linkId;
    paint();
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });
  $('retry').addEventListener('click', () => { void load(); });
  $('replay').addEventListener('click', () => { startReveal(); announce('正在重放这一条链'); });
  $('pause').addEventListener('click', () => {
    if (state.reveal.playing) { stopReveal(); paint(); announce('重放已暂停'); return; }
    resumeReveal();
    announce('重放继续');
  });
  $('latest').addEventListener('click', () => {
    stopReveal();
    state.reveal.count = replaySteps(state.board).length;
    paint();
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
  $('clear-select').addEventListener('click', () => { select(null, null); announce('已取消选择'); });

  $('canvas').addEventListener('click', event => {
    const node = event.target.closest('[data-hop]');
    if (node) {
      const hopId = node.dataset.hop;
      // 再点一次同一个点 → 收起（D016「点别处，或再点一次，旁边收起」）
      if (state.selectedHop === hopId) select(null, null);
      else select(hopId, null);
      return;
    }
    const edge = event.target.closest('[data-link]');
    if (edge) {
      const linkId = edge.getAttribute('data-link');
      if (state.selectedLink === linkId) select(null, null);
      else select(null, linkId);
      return;
    }
    select(null, null);
  });

  $('edges').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const edge = event.target.closest('[data-link]');
    if (!edge) return;
    event.preventDefault();
    select(null, edge.getAttribute('data-link'));
  });

  // 拖点：只改这个点在图上的位置，不改谁引起谁；告警那一跳钉死，不给拖（D016）
  let drag = null;
  let pan = null;

  $('canvas').addEventListener('pointerdown', event => {
    const node = event.target.closest('[data-hop]');
    if (node) {
      const hopId = node.dataset.hop;
      const alert = alertHopOf(state.board);
      const position = state.positions.get(hopId);
      if (!position || hopId === alert?.id) return;
      drag = { hopId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
      stopReveal();
      paintPlayback();
      node.classList.add('is-dragging');
      try { node.setPointerCapture?.(event.pointerId); } catch { /* 合成事件没有真指针：拖拽照走 */ }
      event.preventDefault();
      return;
    }
    if (event.target.closest('[data-link]')) return;
    pan = { startX: event.clientX, startY: event.clientY, x: state.view.x, y: state.view.y };
    $('canvas').classList.add('is-panning');
  });

  $('canvas').addEventListener('pointermove', event => {
    if (drag) {
      const dx = (event.clientX - drag.startX) / state.view.k;
      const dy = (event.clientY - drag.startY) / state.view.k;
      state.positions.set(drag.hopId, { x: drag.x + dx, y: drag.y + dy });
      paintNodes();
      paintEdges();
      paintGaps();
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
      savePosition(storage, state.board?.id, drag.hopId, state.positions.get(drag.hopId));
      drag = null;
      const dragging = $('nodes').querySelector('.gnode.is-dragging');
      if (dragging) dragging.classList.remove('is-dragging');
    }
    pan = null;
    $('canvas').classList.remove('is-panning');
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

  void load();

  return host;
}

export const page = {
  id: 'trace-board',
  title: '深度溯源',
  navLabel: null,
  /**
   * @param {HTMLElement} content 内容区容器
   * @param {{ params: string[] }} context 路由参数（`#/trace-board/<target>` 的第一段是告警 ID）
   */
  render(content, context) {
    const raw = context?.params?.[0] ?? '';
    let target = raw;
    try { target = decodeURIComponent(raw); } catch { target = raw; }   // 链接里冒号是编码过的（%3A）
    content.replaceChildren(mountTraceBoardPage({ target }));
  },
};
