// pages/trace-board.js —— 深度溯源白板页（P003-T016 / D016）：A3 方向·拖点·记位·不能自己加 / A4 进行中往左长·
// 完成按 discovery 重放·断点常显 / A5 没有对话输入框，外加六格状态。
// 字段一律照接口真名（TraceBoard / TraceBoardHop / TraceBoardLink / TraceBoardGap / TraceBoardDiscovery，
// openapi.yaml:1708-1815）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  alertHopOf, hopDepths, layoutHops, mountTraceBoardPage, page, readSavedPositions, replaySteps, savePosition,
  visibleSets,
} from '../../pages/trace-board.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

// ---------- 夹具：真接口的形状 ----------

const hop = (id, overrides = {}) => ({
  id, kind: 'host', label: id, host: '172.16.221.41',
  occurred_at: '2026-11-17T01:00:00.000Z', evidence_id: 'cw:1', discovered: 1,
  ...overrides,
});

/** 一条跑完的三跳链：告警（右）→ 来源 IP（左一列）→ 文件（左两列） */
const board = (overrides = {}) => {
  const hops = [
    hop('asset:172.16.221.41', { kind: 'alert', label: 'web-prod-03', host: '172.16.221.41', discovered: 1 }),
    hop('ip:45.32.118.7', { label: '45.32.118.7', host: '45.32.118.7', discovered: 2, evidence_id: 'cw:2' }),
    hop('file:/tmp/x.sh', { kind: 'file', label: '/tmp/x.sh', host: '172.16.221.41', discovered: 3, evidence_id: 'cw:3' }),
  ];
  const links = [
    { id: 'link:0', from: 'asset:172.16.221.41', to: 'ip:45.32.118.7', rel: '谁连了谁', evidence_id: 'cw:1' },
    { id: 'link:1', from: 'ip:45.32.118.7', to: 'file:/tmp/x.sh', rel: '谁写了谁', evidence_id: 'cw:2' },
  ];
  return {
    id: 'revshell:1', alert_id: 'revshell:1', status: 'done', chain_length: hops.length, has_gaps: false,
    alert: { id: 'revshell:1', type: 'revshell', title: '反弹 Shell', host: '172.16.221.41', occurred_at: '2026-11-17T01:00:00.000Z' },
    hops, links, gaps: [],
    discovery: [
      { step: 1, kind: 'hop', id: 'asset:172.16.221.41' },
      { step: 2, kind: 'hop', id: 'ip:45.32.118.7' },
      { step: 3, kind: 'link', id: 'link:0' },
      { step: 4, kind: 'hop', id: 'file:/tmp/x.sh' },
      { step: 5, kind: 'link', id: 'link:1' },
    ],
    summary: '从牧云事件 revshell:1 往回走三步。',
    ...overrides,
  };
};

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** 可控的假定时器：900ms 推进重放、5s 轮询都靠测试自己 tick。 */
function fakeTimers() {
  let next = 1;
  const active = new Map();
  return {
    lastMs: null,
    setInterval(callback, ms) {
      const id = next;
      next += 1;
      active.set(id, callback);
      this.lastMs = ms;
      return id;
    },
    clearInterval(id) { active.delete(id); },
    tick() { for (const callback of [...active.values()]) callback(); },
    get running() { return active.size; },
  };
}

/** 内存版 Storage（真 localStorage 在 jsdom 里可用，但注入一份更好断言） */
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    get raw() { return Object.fromEntries(map); },
  };
}

function mount(handler, options = {}) {
  const calls = [];
  const timers = fakeTimers();
  const storage = options.storage ?? memoryStorage();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init ?? {});
  };
  const host = mountTraceBoardPage({ target: 'revshell:1', fetchImpl, timers, storage, ...options });
  document.body.append(host);
  return { host, calls, timers, storage };
}

function route(overrides = {}) {
  return async (url, init) => {
    if (url === '/api/trace/boards' && init.method === 'POST') {
      if (overrides.post) return overrides.post(url, init);
      return respond(board({ status: 'running' }), 202);
    }
    if (url.startsWith('/api/trace/boards/')) {
      if (overrides.detail) return overrides.detail(decodeURIComponent(url.slice('/api/trace/boards/'.length)), url, init);
      return respond(board());
    }
    return respond({ error: `未预期的请求 ${url}` }, 500);
  };
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await flush();
}

const $ = (host, role) => host.querySelector(`[data-role="${role}"]`);
const click = element => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
/**
 * 真用户点击：禁用的控件点不动（`HTMLElement.click()` 在 disabled 时不派发事件）。
 * 涉及「按钮该不该可点」的用例一律用它——`dispatchEvent` 会绕过 disabled，能把死按钮伪装成能点。
 */
function press(element) {
  assert.equal(element.disabled, false, `「${text(element)}」是禁用状态，真用户点不动`);
  element.click();
}
const nodes = host => [...host.querySelectorAll('.gnode')];
const nodeOf = (host, hopId) => host.querySelector(`.gnode[data-hop="${CSS_ESCAPE(hopId)}"]`);
// jsdom 的 CSS.escape 可能没有：hop id 里有冒号，用属性选择器转义
function CSS_ESCAPE(value) { return String(value).replace(/["\\]/g, '\\$&'); }
const edgeHits = host => [...host.querySelectorAll('.edge-hit')];
const gapNotes = host => [...host.querySelectorAll('.gap-note')];

// ---------- 纯函数：方向、顺序、可见性、位置存储 ----------

test('alertHopOf：取 kind=alert 的那一跳；没有标记就退回第一跳（后端保证它在最前）', () => {
  assert.equal(alertHopOf(board()).id, 'asset:172.16.221.41');
  assert.equal(alertHopOf(board({ hops: [hop('a'), hop('b')] })).id, 'a');
  assert.equal(alertHopOf({ hops: [] }), null);
});

test('A3 方向：告警在右（x=0），原因每往左一列 -190px；同列两跳竖着分开', () => {
  const twoCauses = board();
  twoCauses.hops.push(hop('ip:9.9.9.9', { label: '9.9.9.9', discovered: 4 }));
  twoCauses.links.push({ id: 'link:2', from: 'asset:172.16.221.41', to: 'ip:9.9.9.9', rel: '谁连了谁', evidence_id: null });
  const positions = layoutHops(twoCauses);
  assert.deepEqual([positions.get('asset:172.16.221.41').x, positions.get('asset:172.16.221.41').y], [0, 0]);
  assert.equal(positions.get('ip:45.32.118.7').x, -190);
  assert.equal(positions.get('ip:9.9.9.9').x, -190);
  assert.deepEqual([positions.get('ip:45.32.118.7').y, positions.get('ip:9.9.9.9').y], [-32, 32]);
  assert.equal(positions.get('file:/tmp/x.sh').x, -380, '第二层原因再往左一列');
});

test('hopDepths：沿 links 走（无向），连不上线的跳放到最左一列（不假装它在中间）', () => {
  const orphan = board();
  orphan.hops.push(hop('ip:7.7.7.7', { discovered: 9 }));
  const depth = hopDepths(orphan);
  assert.equal(depth.get('asset:172.16.221.41'), 0);
  assert.equal(depth.get('ip:45.32.118.7'), 1);
  assert.equal(depth.get('file:/tmp/x.sh'), 2);
  assert.equal(depth.get('ip:7.7.7.7'), 3, '孤点排在最左一列');
});

test('A4 重放顺序：按 discovery 的 step 排，接口没给到的补在后面，未知 id 丢掉', () => {
  assert.deepEqual(replaySteps(board()).map(step => step.id),
    ['asset:172.16.221.41', 'ip:45.32.118.7', 'link:0', 'file:/tmp/x.sh', 'link:1']);

  const shuffled = board({ discovery: [
    { step: 3, kind: 'link', id: 'link:0' },
    { step: 1, kind: 'hop', id: 'ip:45.32.118.7' },
    { step: 2, kind: 'hop', id: 'nope:nope' },
  ] });
  assert.deepEqual(replaySteps(shuffled).slice(0, 2).map(step => step.id), ['ip:45.32.118.7', 'link:0']);

  const legacy = board();
  delete legacy.discovery;
  assert.equal(replaySteps(legacy).length, legacy.hops.length + legacy.links.length, '旧白板退回数组顺序');
});

test('A4 可见性：告警那跳永远在；线要等自己的那一步、且两端都出现', () => {
  const first = visibleSets(board(), 0);
  assert.deepEqual([...first.hops], ['asset:172.16.221.41'], '播到 0 步时只有告警点');
  assert.equal(first.links.size, 0);

  const two = visibleSets(board(), 2);
  assert.equal(two.hops.size, 2);
  assert.equal(two.links.size, 0, '线还没到它那一步');

  const three = visibleSets(board(), 3);
  assert.deepEqual([...three.links], ['link:0']);

  const all = visibleSets(board(), 99);
  assert.equal(all.hops.size, 3);
  assert.equal(all.links.size, 2);

  // 线先到、端点没到：不画（D016「两个端点都出现了，线才出现」）
  const early = visibleSets(board({ discovery: [{ step: 1, kind: 'link', id: 'link:1' }] }), 1);
  assert.equal(early.links.size, 0);
});

test('位置存储：按白板分开存，坏数据与写不进去都不抛', () => {
  const storage = memoryStorage();
  savePosition(storage, 'revshell:1', 'ip:45.32.118.7', { x: -300, y: 40 });
  assert.deepEqual(readSavedPositions(storage, 'revshell:1'), { 'ip:45.32.118.7': { x: -300, y: 40 } });
  assert.deepEqual(readSavedPositions(storage, 'other'), {}, '别的白板互不影响');

  storage.setItem('hids.trace.positions.broken', '{not json');
  assert.deepEqual(readSavedPositions(storage, 'broken'), {});
  storage.setItem('hids.trace.positions.odd', JSON.stringify({ a: { x: 'x', y: 2 }, b: { x: 1, y: 2 } }));
  assert.deepEqual(readSavedPositions(storage, 'odd'), { b: { x: 1, y: 2 } });

  const throwing = { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(readSavedPositions(throwing, 'x'), {});
  savePosition(throwing, 'x', 'a', { x: 1, y: 2 });
  assert.deepEqual(readSavedPositions(null, 'x'), {});
});

// ---------- A3：白板画出来的样子 ----------

test('A3：告警钉在右边，原因往左——三跳的横坐标是 0 / -190 / -380', async () => {
  const { host } = mount(route());
  await settle();
  click($(host, 'latest'));

  assert.equal(nodes(host).length, 3);
  assert.equal(nodeOf(host, 'asset:172.16.221.41').style.left, '-4.5px');
  assert.equal(nodeOf(host, 'ip:45.32.118.7').style.left, '-194.5px');
  assert.equal(nodeOf(host, 'file:/tmp/x.sh').style.left, '-384.5px');
  assert.equal(nodeOf(host, 'asset:172.16.221.41').classList.contains('is-alert'), true, '告警点单独一档');
  assert.equal(nodeOf(host, 'ip:45.32.118.7').classList.contains('is-alert'), false);
});

test('A3：点可拖——拖动改这个点的位置，松手把位置写进存储（相对告警点）', async () => {
  const { host, storage } = mount(route());
  await settle();
  click($(host, 'latest'));
  const target = nodeOf(host, 'ip:45.32.118.7');
  assert.equal(target.style.top, '0px');

  target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 110, clientY: 70 }));
  const moved = nodeOf(host, 'ip:45.32.118.7');
  assert.notEqual(moved.style.top, '0px', '拖动要真的动');
  assert.notEqual(moved.style.left, '-194.5px');
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));

  // 存下来的就是画出来的（坐标相对告警点：告警在 0,0，所以等于世界坐标）
  const saved = readSavedPositions(storage, 'revshell:1')['ip:45.32.118.7'];
  assert.equal(saved.y, Number.parseFloat(moved.style.top));
  assert.equal(saved.x, Number.parseFloat(moved.style.left) + 4.5);
  assert.ok(saved.x > -190, '往右拖了');
  assert.ok(saved.y > 0, '往下拖了');
});

test('A3：位置记住——下次打开按存下来的位置画，不弹回自动排的位置', async () => {
  const storage = memoryStorage({ 'hids.trace.positions.revshell:1': JSON.stringify({ 'ip:45.32.118.7': { x: -300, y: 40 } }) });
  const { host } = mount(route(), { storage });
  await settle();
  click($(host, 'latest'));
  assert.equal(nodeOf(host, 'ip:45.32.118.7').style.left, '-304.5px');
  assert.equal(nodeOf(host, 'ip:45.32.118.7').style.top, '40px');
  assert.equal(nodeOf(host, 'file:/tmp/x.sh').style.left, '-384.5px', '没拖过的跳仍按自动排');
});

test('A3：告警那一跳钉死，拖不动（D016「钉死在右边」）', async () => {
  const { host, storage } = mount(route());
  await settle();
  click($(host, 'latest'));
  const alert = nodeOf(host, 'asset:172.16.221.41');
  alert.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
  assert.equal(nodeOf(host, 'asset:172.16.221.41').style.left, '-4.5px');
  assert.deepEqual(readSavedPositions(storage, 'revshell:1'), {});
});

test('A3：不能自己加点或加线——图上的点/线数只由接口决定，页面上没有新建入口', async () => {
  const { host } = mount(route());
  await settle();
  click($(host, 'latest'));
  assert.equal(nodes(host).length, 3);
  assert.equal(edgeHits(host).length, 2);
  const labels = [...host.querySelectorAll('button, a')].map(text);
  assert.deepEqual(labels.filter(label => /新建|添加|连一条|删除/.test(label)), []);
});

test('A5：没有对话输入框——整页没有一个 input / textarea', async () => {
  const { host } = mount(route());
  await settle();
  assert.equal(host.querySelectorAll('input, textarea').length, 0);
});

// ---------- A4：进行中往左长 / 完成后重放 / 断点常显 ----------

test('A4 进行中：新的一跳自己往左长出来，页面上没有重放按钮', async () => {
  const running = board({
    status: 'running',
    hops: board().hops.slice(0, 2),
    links: board().links.slice(0, 1),
    discovery: board().discovery.slice(0, 3),
  });
  const grown = board({ status: 'running' });
  let phase = 'running';
  const { host, timers, calls } = mount(route({ detail: () => respond(phase === 'running' ? running : grown) }));
  await settle();
  assert.equal(nodes(host).length, 2);
  assert.equal(text($(host, 'board-state-text')), '进行中');
  assert.equal($(host, 'replay').hidden, true, '进行中没有重放按钮');
  assert.equal($(host, 'pause').hidden, true);
  assert.equal($(host, 'latest').hidden, true);
  assert.equal(timers.running, 1, '只有一个定时器，且是轮询');
  assert.equal(timers.lastMs, 5000, '进行中是轮询（5s），不是重放');

  // 轮询一次：后端多给了一跳（往左一列）
  phase = 'grown';
  timers.tick();
  await settle();
  assert.ok(calls.length >= 2, '轮询要真的再取一次');
  assert.equal(nodes(host).length, 3);
  assert.equal(nodeOf(host, 'file:/tmp/x.sh').style.left, '-384.5px', '新的一跳长在左边，不是堆在角落');
});

test('A4 完成后自动按 discovery 重放：一步一跳，线晚于两端；跳到最新一次给全', async () => {
  const { host, timers } = mount(route());
  await settle();
  assert.equal(nodes(host).length, 1, '开始只有右边的告警点');
  assert.equal(text($(host, 'board-state-text')), '已完成');
  assert.equal($(host, 'replay').hidden, false);

  timers.tick();   // 第 1 步：告警那一跳（已经在图上）
  assert.equal(nodes(host).length, 1);
  timers.tick();   // 第 2 步：来源 IP
  assert.equal(nodes(host).length, 2);
  assert.equal(edgeHits(host).length, 0, '线还没到它那一步');
  timers.tick();   // 第 3 步：line:0
  assert.equal(edgeHits(host).length, 1);
  timers.tick();   // 第 4 步：文件
  assert.equal(nodes(host).length, 3);
  timers.tick();   // 第 5 步：line:1
  assert.equal(edgeHits(host).length, 2);
  assert.equal(timers.running, 0, '播完自己停，不空转');
  assert.equal($(host, 'latest').disabled, true);

  click($(host, 'replay'));
  await settle(1);
  assert.equal(nodes(host).length, 1, '重放从告警点重新开始');
  click($(host, 'latest'));
  assert.equal(nodes(host).length, 3);
  assert.equal(edgeHits(host).length, 2);
});

test('A4 暂停 / 继续：暂停后「继续」还能按（不是死按钮），按了接着往前走，播完才禁', async () => {
  const { host, timers } = mount(route());
  await settle();
  timers.tick();
  timers.tick();
  assert.equal(nodes(host).length, 2);

  press($(host, 'pause'));                        // 暂停
  assert.equal(text($(host, 'pause')), '继续');
  assert.equal(timers.running, 0);
  assert.equal($(host, 'pause').disabled, false, '暂停中「继续」被禁 = 用户只能点「重放」从头来（审查 major 回归点）');
  timers.tick();                                  // 停住之后不该再有一点动静
  assert.equal(nodes(host).length, 2);

  press($(host, 'pause'));                        // 继续（press 先断言没被禁）
  assert.equal(text($(host, 'pause')), '暂停');
  assert.equal(timers.running, 1);
  timers.tick();
  assert.equal(edgeHits(host).length, 1, '继续之后要接着往前走');

  for (let guard = 0; timers.running && guard < 20; guard += 1) timers.tick();
  assert.equal(timers.running, 0, '播完自己停');
  assert.equal($(host, 'pause').disabled, true, '播到最新才禁「继续」');
});

test('A4 断点不点开也看得见：断点写在图上的那一跳旁边，不用点检查器', async () => {
  const withGap = board({ has_gaps: true, gaps: [{ hop_id: 'file:/tmp/x.sh', reason: 'HIDS 上没有更早的记录' }] });
  const { host } = mount(route({ detail: () => respond(withGap) }));
  await settle();
  click($(host, 'latest'));

  const notes = gapNotes(host);
  assert.equal(notes.length, 1);
  assert.match(text(notes[0]), /^上一步没有了 · HIDS 上没有更早的记录$/);
  assert.equal(notes[0].parentElement.getAttribute('data-role'), 'gap-notes', '断点在画布上，不在检查器里');
  assert.equal(text($(host, 'board-gaps')), '断点 1 处');
  // 贴在断了的那一跳左边
  assert.equal(notes[0].style.left, `${-380 - 8 - 176}px`);
});

test('A4 整链缺口（hop_id 为 null）：放在最左一列，也一样不点开就看得见', async () => {
  const chainGap = board({ has_gaps: true, gaps: [{ hop_id: null, reason: '这条链整体没查完' }] });
  const { host } = mount(route({ detail: () => respond(chainGap) }));
  await settle();
  click($(host, 'latest'));
  const notes = gapNotes(host);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].classList.contains('is-chain'), true);
  assert.equal(notes[0].style.left, `${-380 - 190 - 176}px`);
});

test('失败 / 中断：停在已经长出来的地方，顶上写原因，链不清空', async () => {
  const failed = board({ status: 'failed', summary: '按 IP 溯源失败：目标主机不在当前资产范围内。' });
  const { host } = mount(route({ detail: () => respond(failed) }));
  await settle();
  assert.equal(text($(host, 'board-state-text')), '失败');
  assert.equal($(host, 'board-reason').hidden, false);
  assert.match(text($(host, 'board-reason')), /目标主机不在当前资产范围内/);
  assert.equal(nodes(host).length, 3, '已经画出的链要留着');
  assert.equal($(host, 'replay').hidden, true, '失败的白板不能重放');
});

// ---------- 点开：检查器 ----------

test('点一个点：检查器写种类 / 机器 / 发生时间 / 证据；再点一次收起', async () => {
  const { host } = mount(route());
  await settle();
  click($(host, 'latest'));
  click(nodeOf(host, 'ip:45.32.118.7'));

  const inspector = $(host, 'inspector');
  assert.match(text(inspector), /^45\.32\.118\.7/);
  assert.match(text(inspector), /主机/);
  assert.match(text(inspector), /45\.32\.118\.7/);
  assert.match(text(inspector), /cw:2/);
  assert.match(text(inspector), /证据正文在告警详情里看/);
  assert.equal(nodeOf(host, 'ip:45.32.118.7').getAttribute('aria-pressed'), 'true');

  click(nodeOf(host, 'ip:45.32.118.7'));
  assert.match(text($(host, 'inspector')), /白板概览/, '再点一次同一处收起');
});

test('点一条线（含键盘 Enter）：检查器写关系那一句与撑着这条线的证据', async () => {
  const { host } = mount(route());
  await settle();
  click($(host, 'latest'));
  const hit = edgeHits(host)[0];
  assert.equal(hit.getAttribute('aria-label'), '关系：谁连了谁（asset:172.16.221.41 → ip:45.32.118.7）');

  hit.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const inspector = text($(host, 'inspector'));
  assert.match(inspector, /谁连了谁/);
  assert.match(inspector, /cw:1/);
});

test('点画布空白处：收起检查器（D016「点别处……旁边收起」）', async () => {
  const { host } = mount(route());
  await settle();
  click($(host, 'latest'));
  click(nodeOf(host, 'ip:45.32.118.7'));
  click($(host, 'canvas'));
  assert.match(text($(host, 'inspector')), /白板概览/);
});

// ---------- 六格状态 ----------

test('格 1 加载中：画布写「正在读取白板…」，刷新禁用', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { host } = mount(async () => { await pending; return respond(board()); });
  await flush();
  assert.match(text($(host, 'canvas-empty-title')), /正在读取白板/);
  assert.equal($(host, 'refresh').disabled, true);
  assert.equal($(host, 'canvas').getAttribute('aria-busy'), 'true');
  release();
  await settle();
});

test('格 2 空态：进行中但还没有跳，画布说「任务在跑，新的一跳会自己长出来」', async () => {
  const empty = board({ status: 'running', hops: [], links: [], discovery: [], chain_length: 0 });
  const { host } = mount(route({ detail: () => respond(empty) }));
  await settle();
  assert.match(text($(host, 'canvas-empty-title')), /还没有跳/);
  assert.match(text($(host, 'canvas-empty-text')), /自己从左边长出来/);
  assert.equal(nodes(host).length, 0);
});

test('格 3 部分失败：已有白板时刷新失败只挂提示，链还在', async () => {
  let phase = 'ok';
  const { host } = mount(route({
    detail: () => (phase === 'ok' ? respond(board()) : respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503)),
  }));
  await settle();
  click($(host, 'latest'));
  phase = 'bad';
  click($(host, 'refresh'));
  await settle();

  assert.equal($(host, 'notice').hidden, false);
  assert.match(text($(host, 'notice')), /尚未配置/);
  assert.equal(nodes(host).length, 3, '链要留着');
});

test('格 4 错误：首屏读不到白板就给整块错误 + 重试', async () => {
  let phase = 'bad';
  const { host, calls } = mount(route({
    detail: () => (phase === 'ok' ? respond(board()) : respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503)),
  }));
  await settle();
  assert.match(text($(host, 'canvas-empty-title')), /白板读取失败/);
  assert.match(text($(host, 'canvas-empty-text')), /尚未配置/);

  phase = 'ok';
  click($(host, 'retry'));
  await settle();
  click($(host, 'latest'));
  assert.ok(calls.length >= 2);
  assert.equal(nodes(host).length, 3);
});

test('格 5 超长内容：标签、机器、断点原因全文进 DOM（不截断数据）', async () => {
  const longLabel = '/var/lib/docker/overlay2/abcdef0123456789/merged/app/static/upload/webshell_final_v3.jsp';
  const longReason = 'HIDS 的进程谱系只保留了 7 天，这条跳发生在 9 天前，已经没有更早的记录可以对上。';
  const long = board({
    has_gaps: true,
    gaps: [{ hop_id: 'file:/tmp/x.sh', reason: longReason }],
    hops: board().hops.map(item => (item.id === 'file:/tmp/x.sh' ? { ...item, label: longLabel } : item)),
  });
  const { host } = mount(route({ detail: () => respond(long) }));
  await settle();
  click($(host, 'latest'));
  assert.equal(nodeOf(host, 'file:/tmp/x.sh').querySelector('.gnode-label').textContent, longLabel);
  assert.equal(text(gapNotes(host)[0]), `上一步没有了 · ${longReason}`);
  assert.equal(gapNotes(host)[0].getAttribute('title'), longReason);
});

test('格 6 禁用：没有跳时不启动重放、不占定时器；跳到最新播完就禁用', async () => {
  const empty = board({ hops: [], links: [], discovery: [], status: 'done' });
  const { host, timers } = mount(route({ detail: () => respond(empty) }));
  await settle();
  assert.equal(timers.running, 0);
  assert.equal($(host, 'replay').disabled, true);
  assert.equal($(host, 'latest').disabled, true);
});

// ---------- A2：带着告警 ID 打开或创建 ----------

test('A2：打开已有白板——GET 一次就画出来，不发 POST', async () => {
  const { host, calls } = mount(route());
  await settle();
  assert.deepEqual(calls.map(call => [call.url, call.init.method]), [['/api/trace/boards/revshell%3A1', 'GET']]);
  assert.equal(text($(host, 'board-id')), 'revshell:1');
});

test('A2：这条还没有白板——404 后自动创建（POST），回 202 就画', async () => {
  const { host, calls } = mount(route({
    detail: () => respond({ error: '该告警尚无溯源白板' }, 404),
    post: () => respond(board({ status: 'running' }), 202),
  }));
  await settle();
  assert.deepEqual(calls.map(call => [call.url, call.init.method]), [
    ['/api/trace/boards/revshell%3A1', 'GET'],
    ['/api/trace/boards', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { target: 'revshell:1' });
  assert.equal(text($(host, 'board-state-text')), '进行中');
});

test('A2：创建被拒（422 没有可用资产）——把服务端原话显示出来，不假装有白板', async () => {
  const { host } = mount(route({
    detail: () => respond({ error: '该告警尚无溯源白板' }, 404),
    post: () => respond({ error: '该告警没有可用的资产或来源 IP' }, 422),
  }));
  await settle();
  assert.match(text($(host, 'canvas-empty-text')), /没有可用的资产/);
  assert.equal(nodes(host).length, 0);
});

test('没有目标（直接开 #/trace-board）：说清楚从哪儿进来，不擅自请求', async () => {
  const calls = [];
  const host = mountTraceBoardPage({ target: '', fetchImpl: async (url) => { calls.push(url); return respond({}); } });
  document.body.append(host);
  await settle();
  assert.match(text($(host, 'canvas-empty-title')), /没有指定这一条/);
  assert.equal(calls.length, 0);
});


test('page 契约：id / title / navLabel，参数是编码过的告警 ID（冒号要还原）', async () => {
  assert.equal(page.id, 'trace-board');
  assert.equal(page.title, '深度溯源');
  assert.equal(page.navLabel, null, '白板不在侧栏（列表才是入口）');

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(board());
  };
  try {
    const content = document.createElement('div');
    page.render(content, { params: [encodeURIComponent('revshell:1')] });
    await settle();
    assert.equal(calls[0].url, '/api/trace/boards/revshell%3A1', '参数要解码再编码进路径，不能双重编码');
  } finally {
    globalThis.fetch = original;
  }
});
