// pages/trace.js —— 深度溯源页：六格状态矩阵 + 白板列表 / 画布 / 检查器 + 渐进显示 + 缩放平移
// 字段一律照接口真名（trace-board.js:158-222 的 TraceBoard / node / edge / activity）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoveryOrder, formatTime, mountTracePage, statusClass, validTraceTarget,
} from '../../pages/trace.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

// ---------- 夹具：真接口的形状 ----------

/** 列表项：trace-board.js:167 只回这五个键 */
const summaryBoard = (overrides = {}) => ({
  id: 'revshell:1', title: '反弹 Shell', status: 'done',
  created_at: '2026-11-17T01:00:00.000Z', updated_at: '2026-11-17T01:05:00.000Z',
  ...overrides,
});

/** 一块跑完的白板：节点 / 关系 / 活动记录都是 trace-board.js 生成的形状 */
const board = (overrides = {}) => ({
  id: 'revshell:1', alert_id: 'revshell:1', run_id: 'run-1', title: '反弹 Shell',
  seed: 'asset:172.16.221.41', status: 'done',
  window: { since: '2026-11-16T01:00:00.000Z', until: '2026-11-19T01:00:00.000Z', hours: 72 },
  created_at: '2026-11-17T01:00:00.000Z', updated_at: '2026-11-17T01:05:00.000Z',
  nodes: [
    {
      id: 'asset:172.16.221.41', label: 'web-prod-03', address: '172.16.221.41',
      kind: 'asset', status: 'done', why: '告警涉及的起始资产，先核查它的档案和相关事件',
      profile: { name: 'web-prod-03', ip: '172.16.221.41', os: 'CentOS 7' },
      findings: [], finding_count: 4, discovered_from: [],
      touched_hosts: ['172.16.221.41'], investigated_at: '2026-11-17T01:02:00.000Z',
    },
    {
      id: 'ip:45.32.118.7', label: '45.32.118.7', address: '45.32.118.7',
      kind: 'external_ip', status: 'pending', why: '', profile: { name: '外部 IP（未登记资产）', ip: '45.32.118.7' },
      findings: [], finding_count: 0,
      discovered_from: [{ evidence_id: 'cw:1', pointer: '/events/0/source_ip' }],
    },
  ],
  edges: [{
    from: 'ip:45.32.118.7', to: 'asset:172.16.221.41', rel: '触达线索',
    why: '同一条牧云事件记录包含来源 IP 与目标主机；待 AI 判断关系性质',
    strength: 0.3, by: 'program', at: '2026-11-17T01:01:00.000Z',
    citations: [{ evidence_id: 'cw:1', pointer: '/events/0/source_ip', value: '45.32.118.7' }],
  }],
  activity: [
    { at: '2026-11-17T01:00:00.000Z', kind: 'seed', title: '以告警为起点', detail: 'revshell:1 · 反弹 Shell' },
    { at: '2026-11-17T01:00:05.000Z', kind: 'investigate', title: '调查 web-prod-03', detail: '先核查主机档案',
      node: 'asset:172.16.221.41', result: '6 个工具返回' },
    { at: '2026-11-17T01:00:20.000Z', kind: 'investigate', title: '调查 45.32.118.7', detail: '外联地址',
      node: 'ip:45.32.118.7', result: '2 个工具返回' },
    { at: '2026-11-17T01:01:00.000Z', kind: 'conclude', title: 'AI 完成溯源',
      detail: '从牧云事件 revshell:1 展开，命中 1 台主机与 1 个外联地址。' },
  ],
  summary: '从牧云事件 revshell:1 展开，命中 1 台主机与 1 个外联地址。',
  gaps: ['账号 deploy 的使用人未确认'],
  investigations: 2, model: 'test-model', origin_evidence: null,
  ...overrides,
});

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** 可控的假定时器：页面用 900ms 推进一步，测试自己决定什么时候 tick。 */
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
    /** 跑到点的那一批回调（clearInterval 掉的不再跑） */
    tick() { for (const callback of [...active.values()]) callback(); },
    get running() { return active.size; },
  };
}

/**
 * 起页面。route 决定每个请求回什么；默认：列表回一条 summary，详情回整块白板。
 * @returns {{ host: HTMLElement, calls: {url:string, init:object}[], timers: ReturnType<typeof fakeTimers> }}
 */
function mount(handler, options = {}) {
  const calls = [];
  const timers = fakeTimers();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init ?? {});
  };
  const host = mountTracePage({ fetchImpl, timers, ...options });
  document.body.append(host);
  return { host, calls, timers };
}

/** 默认路由：可整体替换列表 / 详情 / POST 的回复 */
function route(overrides = {}) {
  return async (url, init) => {
    if (url === '/api/trace/boards' && init.method === 'POST') {
      if (overrides.post) return overrides.post(url, init);
      return respond(board(), 202);
    }
    if (url === '/api/trace/boards') {
      if (overrides.list) return overrides.list(url, init);
      return respond({ boards: overrides.boards ?? [summaryBoard()] });
    }
    if (url.startsWith('/api/trace/boards/')) {
      const id = decodeURIComponent(url.slice('/api/trace/boards/'.length));
      if (overrides.detail) return overrides.detail(id, url, init);
      return respond(board({ id }));
    }
    return respond({ error: `未预期的请求 ${url}` }, 500);
  };
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await flush();
}

const $ = (host, role) => host.querySelector(`[data-role="${role}"]`);
const click = element => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const nodes = host => [...host.querySelectorAll('.gnode')];
const edgeHits = host => [...host.querySelectorAll('.edge-hit')];
const timelineButtons = host => [...host.querySelectorAll('.timeline button')];
const parseZoom = host => Number(text($(host, 'zoom-level')).replace('%', ''));

// ---------- 纯函数 ----------

test('validTraceTarget：告警 ID / IPv4 / ip: 前缀；格式不对的不放行', () => {
  assert.equal(validTraceTarget('revshell:1'), true);
  assert.equal(validTraceTarget('172.16.221.41'), true);
  assert.equal(validTraceTarget('ip:172.16.221.41'), true);
  assert.equal(validTraceTarget('  revshell:12  '), true);
  assert.equal(validTraceTarget(''), false);
  assert.equal(validTraceTarget('abc'), false);
  assert.equal(validTraceTarget('revshell:0'), false);
  assert.equal(validTraceTarget('172.16.221.999'), false);
});

test('discoveryOrder：activity 里的 node 定顺序，其余按 nodes[] 原顺序补齐', () => {
  const ordered = discoveryOrder({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    activity: [{ node: 'c' }, { kind: 'tool' }, { node: 'a' }],
  });
  assert.deepEqual(ordered, [2, 0, 1]);
});

test('discoveryOrder：activity 没有节点引用时退化为数组顺序（trace-notes.md §5）', () => {
  assert.deepEqual(discoveryOrder({ nodes: [{ id: 'a' }, { id: 'b' }], activity: [{ kind: 'seed' }] }), [0, 1]);
  assert.deepEqual(discoveryOrder(null), []);
});

test('formatTime：ISO → 本地 HH:MM:SS；空值与坏值不炸', () => {
  assert.match(formatTime('2026-11-17T01:02:03.000Z'), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(formatTime(''), '');
  assert.equal(formatTime('not-a-date'), 'not-a-date');
});

test('statusClass：running / done / failed 各有色点类，其它落默认', () => {
  assert.equal(statusClass('running'), 'is-running');
  assert.equal(statusClass('done'), 'is-done');
  assert.equal(statusClass('failed'), 'is-failed');
  assert.equal(statusClass('interrupted'), '');
});

// ---------- 六格状态矩阵 ----------

test('格 1「加载中」：列表说「正在读取白板…」，shell aria-busy，刷新禁用；取到数据后撤掉', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { host } = mount(async (url, init) => {
    if (url === '/api/trace/boards') { await gate; return respond({ boards: [summaryBoard()] }); }
    return route()(url, init);
  });

  assert.match(text($(host, 'board-list')), /正在读取白板/);
  assert.match(text($(host, 'canvas-empty')), /正在读取白板/);
  assert.equal($(host, 'shell').getAttribute('aria-busy'), 'true');
  assert.equal($(host, 'refresh').disabled, true);
  assert.equal($(host, 'board-id').textContent, '—');

  release();
  await settle();
  assert.equal($(host, 'shell').getAttribute('aria-busy'), 'false');
  assert.equal($(host, 'refresh').disabled, false);
  assert.match(text($(host, 'board-list')), /revshell:1/);
});

test('格 2「空态」：一条白板都没有 → 列表与画布各说一句；回放控件全禁用', async () => {
  const { host } = mount(route({ boards: [] }));
  await settle();

  assert.match(text($(host, 'board-list')), /还没有白板。/);
  assert.equal($(host, 'board-count').textContent, '0 个');
  assert.equal($(host, 'canvas-empty').hidden, false);
  assert.equal($(host, 'canvas-empty-title').textContent, '没有白板');
  assert.equal($(host, 'canvas-empty-text').textContent, '在左侧输入告警 ID 或 IPv4 新建。');
  assert.equal($(host, 'replay').disabled, true);
  assert.equal($(host, 'pause').disabled, true);
  assert.equal($(host, 'latest').disabled, true);
  assert.equal($(host, 'error').hidden, true);
});

test('格 3「部分失败」：列表成功、选中白板 404 → 列表还在，画布说「没有这个白板」', async () => {
  const { host } = mount(route({
    boards: [summaryBoard()],
    detail: () => respond({ error: '该告警尚无溯源白板' }, 404),
  }));
  await settle();

  assert.match(text($(host, 'board-list')), /revshell:1/);
  assert.equal(host.querySelectorAll('[data-board-id]').length, 1);
  assert.equal($(host, 'canvas-empty').hidden, false);
  assert.equal($(host, 'canvas-empty-title').textContent, '没有这个白板');
  assert.equal($(host, 'canvas-empty-text').textContent, '该目标还没有溯源白板。');
  // 整页错误提示不该出现（不是列表级失败）
  assert.equal($(host, 'error').hidden, true);
});

test('格 3「部分失败」：详情 503 → 画布说「白板读取失败」并带服务端原话，列表仍可切换', async () => {
  const { host } = mount(route({
    boards: [summaryBoard(), summaryBoard({ id: 'webshell:42' })],
    detail: () => respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503),
  }));
  await settle();

  assert.equal($(host, 'canvas-empty-title').textContent, '白板读取失败');
  assert.match($(host, 'canvas-empty-text').textContent, /深度溯源模型或牧云 MCP 尚未配置/);
  assert.equal(host.querySelectorAll('[data-board-id]').length, 2);
});

test('格 4「错误」：列表 503 → role=alert 整块提示 + 重试；重试成功后恢复正常', async () => {
  let attempts = 0;
  const { host, calls } = mount(route({
    list: () => {
      attempts += 1;
      if (attempts === 1) return respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503);
      return respond({ boards: [summaryBoard()] });
    },
  }));
  await settle();

  const notice = $(host, 'error');
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.match(text(notice), /白板列表读取失败/);
  assert.match(text(notice), /深度溯源模型或牧云 MCP 尚未配置/);
  assert.match(text($(host, 'board-list')), /白板列表读取失败/);
  assert.equal($(host, 'canvas-empty-title').textContent, '白板列表读取失败');

  const before = calls.length;
  click($(host, 'retry'));
  await settle();
  assert.ok(calls.length > before, '重试要真的再请求一次');
  assert.equal($(host, 'error').hidden, true);
  assert.match(text($(host, 'board-list')), /revshell:1/);
});

test('格 5「超长内容」：节点标签 / 白板 ID / 摘要 / 缺口原样进 DOM，不截断、不断行', async () => {
  const longLabel = `very-long-host-name-${'a'.repeat(180)}.corp.internal`;
  const longId = `revshell:${'9'.repeat(40)}`;
  const longSummary = '这次溯源从告警出发，沿着来源地址一路核查主机档案、登录记录、进程与外联。'.repeat(8);
  const longBoard = board({
    id: longId,
    nodes: [{ ...board().nodes[0], label: longLabel }],
    edges: [],
    activity: [{ at: '2026-11-17T01:00:00.000Z', kind: 'seed', title: '以告警为起点', detail: '' }],
    summary: longSummary,
    gaps: Array.from({ length: 8 }, (_item, index) => `第 ${index + 1} 条缺口：${'未确'.repeat(20)}`),
  });
  const { host } = mount(route({ boards: [summaryBoard({ id: longId })], detail: () => respond(longBoard) }));
  await settle();
  click($(host, 'latest'));
  await settle();

  assert.equal($(host, 'board-id').textContent, longId);
  assert.equal(nodes(host).length, 1);
  assert.equal(text(nodes(host)[0]), longLabel);
  assert.equal(text($(host, 'inspector').querySelector('.summary')), longSummary);
  assert.equal($(host, 'inspector').querySelectorAll('.gaps li').length, 8);
});

test('格 6「禁用」：加载中刷新禁用；空态回放三键禁用；新建请求在飞时「新建」禁用', async () => {
  // 加载中
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = mount(async (url, init) => {
    if (url === '/api/trace/boards') { await gate; return respond({ boards: [] }); }
    return route()(url, init);
  });
  assert.equal($(first.host, 'refresh').disabled, true);
  release();
  await settle();

  // 新建请求在飞
  let releasePost;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const second = mount(route({ boards: [], post: async () => { await postGate; return respond(board(), 202); } }));
  await settle();
  $(second.host, 'target').value = 'webshell:42';
  click($(second.host, 'start'));
  await settle(2);
  assert.equal($(second.host, 'start').disabled, true);
  releasePost();
  await settle();
  assert.equal($(second.host, 'start').disabled, false);
});

test('格 6「禁用」：白板跑完时「跳到最新」「暂停」禁用；播放中「暂停」可用', async () => {
  const { host, timers } = mount(route());
  await settle();

  assert.equal($(host, 'pause').textContent, '暂停');
  assert.equal($(host, 'pause').disabled, false);
  assert.equal($(host, 'latest').disabled, false);

  timers.tick();   // 第 2 个节点
  await settle(2);
  timers.tick();   // 播放结束
  await settle(2);
  assert.equal($(host, 'pause').disabled, true);
  assert.equal($(host, 'latest').disabled, true);
  assert.equal(timers.lastMs, 900);
});

// ---------- 白板列表 ----------

test('白板列表：切换白板 → 按 id 请求详情，画布换成新白板的 id；只有当前项 is-active', async () => {
  const other = board({ id: 'webshell:42', nodes: [{ ...board().nodes[0], id: 'asset:10.0.0.9', label: 'api-gateway-01' }], edges: [], activity: [] });
  const { host, calls } = mount(route({
    boards: [summaryBoard(), summaryBoard({ id: 'webshell:42', status: 'running' })],
    detail: id => respond(id === 'webshell:42' ? other : board({ id })),
  }));
  await settle();

  const buttons = host.querySelectorAll('[data-board-id]');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].classList.contains('is-active'), true);
  assert.equal(text(buttons[0]).includes('revshell:1'), true);
  assert.match(text(buttons[1]), /webshell:42/);
  assert.match(text(buttons[1]), /running/);

  click(buttons[1]);
  await settle();
  assert.equal($(host, 'board-id').textContent, 'webshell:42');
  assert.ok(calls.some(call => call.url === '/api/trace/boards/webshell%3A42'));
  assert.equal(host.querySelectorAll('[data-board-id]')[1].classList.contains('is-active'), true);
  assert.equal(host.querySelectorAll('[data-board-id]')[0].classList.contains('is-active'), false);
});

test('白板列表：切换时详情读取慢，后到的那次不覆盖（按 id 认结果）', async () => {
  const slow = new Map();
  const { host } = mount(route({
    boards: [summaryBoard(), summaryBoard({ id: 'webshell:42' })],
    detail: id => new Promise(resolve => { slow.set(id, resolve); }),
  }));
  await settle(2);
  // 首次选中 revshell:1 的详情还没回来
  const buttons = host.querySelectorAll('[data-board-id]');
  click(buttons[1]);
  await settle(2);
  slow.get('webshell:42')(respond(board({ id: 'webshell:42' })));
  await settle();
  slow.get('revshell:1')(respond(board({ id: 'revshell:1' })));
  await settle();
  assert.equal($(host, 'board-id').textContent, 'webshell:42');
});

test('白板列表：状态色点跟 status 走；接口没给摘要/计数就不画（A2）', async () => {
  const { host } = mount(route({ boards: [summaryBoard({ status: 'failed' })] }));
  await settle();
  const button = host.querySelector('[data-board-id]');
  assert.equal(button.querySelector('.state').classList.contains('is-failed'), true);
  assert.equal(button.querySelector('.board-summary'), null);
  assert.doesNotMatch(text(button), /节点|关系/);
});

// ---------- 新建 ----------

test('新建：空输入只提示、聚焦输入框、不发请求', async () => {
  const { host, calls } = mount(route({ boards: [] }));
  await settle();
  const before = calls.length;
  click($(host, 'start'));
  await settle(1);
  assert.equal($(host, 'start-note').textContent, '请输入告警 ID 或 IPv4 地址。');
  assert.equal(document.activeElement, $(host, 'target'));
  assert.equal(calls.length, before);
});

test('新建：格式不对的目标本地就挡掉，不发 POST（其余交给 400 的原话）', async () => {
  const { host, calls } = mount(route({ boards: [] }));
  await settle();
  const before = calls.length;
  $(host, 'target').value = 'not-a-target';
  click($(host, 'start'));
  await settle(1);
  assert.equal($(host, 'start-note').textContent, '请输入有效告警 ID 或 IPv4 地址。');
  assert.equal(calls.length, before);
});

test('新建：POST 正文 { target }，202 回来后进列表并选中，输入框清空', async () => {
  const created = board({ id: 'webshell:42', status: 'running', nodes: [board().nodes[0]], edges: [], activity: [] });
  const { host, calls } = mount(route({ boards: [], post: () => respond(created, 202) }));
  await settle();
  $(host, 'target').value = 'webshell:42';
  click($(host, 'start'));
  await settle();

  const post = calls.find(call => call.init.method === 'POST');
  assert.ok(post, '要真的发 POST');
  assert.deepEqual(JSON.parse(post.init.body), { target: 'webshell:42' });
  assert.equal($(host, 'board-id').textContent, 'webshell:42');
  assert.equal(host.querySelectorAll('[data-board-id]').length, 1);
  assert.equal($(host, 'start-note').textContent, '已提交溯源任务（202），等待后端返回进度。');
  assert.equal($(host, 'target').value, '');
  assert.match($(host, 'sr-status').textContent, /已提交溯源任务 webshell:42/);
});

test('新建：目标已有白板 → 不发 POST，直接切过去', async () => {
  const { host, calls } = mount(route());
  await settle();
  const before = calls.length;
  $(host, 'target').value = 'revshell:1';
  click($(host, 'start'));
  await settle();
  assert.equal(calls.slice(before).some(call => call.init.method === 'POST'), false);
  assert.equal($(host, 'start-note').textContent, '该目标已有白板，已切换。');
});

test('新建：400 把服务端原话带进提示（不吞成「失败」）', async () => {
  const { host } = mount(route({
    boards: [],
    post: () => respond({ error: '请输入有效告警 ID 或 IPv4 地址' }, 400),
  }));
  await settle();
  $(host, 'target').value = 'revshell:1';
  click($(host, 'start'));
  await settle();
  assert.match($(host, 'start-note').textContent, /新建失败/);
  assert.match($(host, 'start-note').textContent, /请输入有效告警 ID 或 IPv4 地址/);
});

test('入口：`#/trace/<target>` 预填输入框；命中已有白板就直接选中，否则提示点新建', async () => {
  const hit = mount(route(), { initialTarget: 'revshell:1' });
  await settle();
  assert.equal($(hit.host, 'target').value, 'revshell:1');
  assert.equal($(hit.host, 'board-id').textContent, 'revshell:1');

  const miss = mount(route(), { initialTarget: 'webshell:9' });
  await settle();
  assert.equal($(miss.host, 'target').value, 'webshell:9');
  assert.match($(miss.host, 'start-note').textContent, /还没有白板/);
});

// ---------- 画布 / 渐进显示 ----------

test('渐进显示：打开完成态白板也从头重放——先 1 个节点，900ms 一个；连线两端都出现后才画', async () => {
  const { host, timers } = mount(route());
  await settle();

  assert.equal(nodes(host).length, 1);
  assert.equal(edgeHits(host).length, 0, '只有一个端点时不画关系');
  assert.match($(host, 'progress').textContent, /已发现 1 \/ 2 节点 · 0 \/ 1 关系/);
  assert.equal(timers.lastMs, 900);

  timers.tick();
  await settle(2);
  assert.equal(nodes(host).length, 2);
  assert.equal(edgeHits(host).length, 1);
  assert.match($(host, 'progress').textContent, /已发现 2 \/ 2 节点 · 1 \/ 1 关系/);
  assert.equal(text(edgeHits(host)[0].getAttribute('aria-label')) !== null, true);
  assert.equal(timers.running, 0, '播放结束后定时器要停');
});

test('重放 / 跳到最新 / 暂停继续 / 跟随：四键行为照稿 §4', async () => {
  const { host, timers } = mount(route());
  await settle();

  click($(host, 'latest'));
  await settle(2);
  assert.equal(nodes(host).length, 2);
  assert.equal($(host, 'latest').disabled, true);

  click($(host, 'replay'));
  await settle(2);
  assert.equal(nodes(host).length, 1, '重放从第一个节点开始');
  assert.equal($(host, 'pause').textContent, '暂停');

  click($(host, 'pause'));
  await settle(1);
  assert.equal($(host, 'pause').textContent, '继续');
  assert.equal(timers.running, 0, '暂停要停掉定时器');

  click($(host, 'pause'));
  await settle(1);
  assert.equal($(host, 'pause').textContent, '暂停');
  timers.tick();
  await settle(2);
  assert.equal(nodes(host).length, 2);

  assert.equal($(host, 'follow').getAttribute('aria-pressed'), 'true');
  click($(host, 'follow'));
  assert.equal($(host, 'follow').getAttribute('aria-pressed'), 'false');
});

test('缩放：按钮在 25%–250% 之间夹住，滚轮以指针为中心也能缩放', async () => {
  const { host } = mount(route());
  await settle();
  const start = parseZoom(host);
  assert.ok(start >= 25 && start <= 250);

  for (let i = 0; i < 30; i += 1) click($(host, 'zoom-in'));
  assert.equal(parseZoom(host), 250);
  for (let i = 0; i < 60; i += 1) click($(host, 'zoom-out'));
  assert.equal(parseZoom(host), 25);

  const wheel = new dom.window.Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperties(wheel, { deltaY: { value: -100 }, clientX: { value: 10 }, clientY: { value: 10 } });
  $(host, 'canvas').dispatchEvent(wheel);
  assert.ok(parseZoom(host) > 25, '向上滚要放大');

  click($(host, 'fit'));
  assert.ok(parseZoom(host) >= 25);
});

test('选中节点：检查器列该对象的全部字段，点「取消选择」回到白板概览', async () => {
  const { host } = mount(route());
  await settle();
  click(nodes(host)[0]);
  await settle(1);

  const inspector = $(host, 'inspector');
  assert.equal(inspector.querySelector('h3').textContent, 'web-prod-03');
  assert.match(text(inspector), /asset/);
  const terms = [...inspector.querySelectorAll('dt')].map(term => text(term));
  assert.ok(terms.includes('address'), '节点的接口字段要原样列出');
  assert.ok(terms.includes('finding_count'));
  assert.equal(nodes(host)[0].getAttribute('aria-pressed'), 'true');
  assert.equal($(host, 'clear-select').hidden, false);

  click($(host, 'clear-select'));
  await settle(1);
  assert.equal($(host, 'inspector').querySelector('h3').textContent, '白板概览');
  assert.equal($(host, 'clear-select').hidden, true);
});

test('选中关系：鼠标点命中线与 Enter 键都能选中，检查器列关系字段', async () => {
  const { host } = mount(route());
  await settle();
  click($(host, 'latest'));
  await settle(2);

  click(edgeHits(host)[0]);
  await settle(1);
  assert.equal($(host, 'inspector').querySelector('h3').textContent, '关系');
  assert.match(text($(host, 'inspector')), /触达线索/);
  assert.match(text($(host, 'inspector')), /edge #0/);

  click($(host, 'clear-select'));
  await settle(1);
  edgeHits(host)[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(1);
  assert.equal($(host, 'inspector').querySelector('h3').textContent, '关系');
});

test('调研过程：点已出现的条目定位到节点；未出现的条目禁用', async () => {
  const { host, timers } = mount(route());
  await settle();

  const first = timelineButtons(host);
  assert.ok(first.length >= 3);
  const forNodeOne = first.find(button => button.dataset.node === '1');
  const forNodeZero = first.find(button => button.dataset.node === '0');
  assert.equal(forNodeOne.disabled, true, '第二个节点还没出现');
  assert.equal(forNodeZero.disabled, false);

  click(forNodeZero);
  await settle(1);
  assert.equal($(host, 'inspector').querySelector('h3').textContent, 'web-prod-03');

  // 回到白板概览才看得到时间线（选中节点时检查器列的是该节点字段）
  click($(host, 'clear-select'));
  await settle(1);
  timers.tick();
  await settle(2);
  const second = timelineButtons(host).find(button => button.dataset.node === '1');
  assert.equal(second.disabled, false);
  click(second);
  await settle(1);
  assert.equal($(host, 'inspector').querySelector('h3').textContent, '45.32.118.7');
});

test('拖动节点：位置跟着指针走，连线重算；拖动时自动暂停回放', async () => {
  const { host, timers } = mount(route());
  await settle();
  const node = nodes(host)[0];
  const before = node.style.left;

  node.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 110, clientY: 60 }));
  await settle(1);
  assert.notEqual(nodes(host)[0].style.left, before);
  assert.equal($(host, 'pause').textContent, '继续', '拖动要暂停回放');
  assert.equal(timers.running, 0);

  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
});

test('拖空白平移：画布 world 的位移跟着指针走', async () => {
  const { host } = mount(route());
  await settle();
  const world = $(host, 'world');
  const before = world.style.transform;

  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 20 }));
  assert.notEqual(world.style.transform, before);
  $(host, 'canvas').dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
});

test('没有节点的失败白板：画布说「任务失败」+ 接口给的摘要', async () => {
  const failed = board({ status: 'failed', nodes: [], edges: [], activity: [], summary: '按 IP 溯源失败：目标主机不在当前资产范围内。' });
  const { host } = mount(route({ boards: [summaryBoard({ status: 'failed' })], detail: () => respond(failed) }));
  await settle();

  assert.equal($(host, 'canvas-empty-title').textContent, '任务失败');
  assert.equal($(host, 'canvas-empty-text').textContent, '按 IP 溯源失败：目标主机不在当前资产范围内。');
  assert.equal($(host, 'replay').disabled, true);
  assert.equal($(host, 'board-state-text').textContent, 'failed');
});

test('路由切走：页面不在文档里时定时器停掉，不空转', async () => {
  const { host, timers } = mount(route());
  await settle();
  assert.equal(timers.running, 1);
  host.remove();
  timers.tick();
  assert.equal(timers.running, 0);
});

test('刷新：重新拉列表与详情，按钮在飞时禁用', async () => {
  let listCalls = 0;
  const { host } = mount(route({
    list: () => { listCalls += 1; return respond({ boards: [summaryBoard()] }); },
  }));
  await settle();
  assert.equal(listCalls, 1);
  click($(host, 'refresh'));
  await settle();
  assert.equal(listCalls, 2);
  assert.equal($(host, 'refresh').disabled, false);
});

test('页面注入了本页样式，且不重复注入', async () => {
  mount(route());
  await settle();
  mount(route());
  await settle();
  assert.equal(document.querySelectorAll('link[data-page-style="trace"]').length, 1);
});
