// pages/trace.js —— 深度溯源列表页（P003-T016 / D015）：A1「进去先是列表」+ 七列 + 筛选分页 + 六格状态
// 字段一律照接口真名（TraceBoardSummary，openapi.yaml:1708-1726）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { alertCell, mountTracePage } from '../../pages/trace.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
  globalThis.window.location.hash = '';
});

/** 列表项：TraceBoardSummary 的真形状（不带链，也不带结论） */
const summary = (overrides = {}) => ({
  id: 'revshell:1', alert_id: 'revshell:1', title: '反弹 Shell', type: 'revshell',
  host: '172.16.221.41', occurred_at: '2026-11-17T02:00:00.000Z', status: 'done',
  chain_length: 3, has_gaps: false,
  created_at: '2026-11-17T02:00:00.000Z', updated_at: '2026-11-17T03:00:00.000Z',
  ...overrides,
});

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** 一次挂载 + 一次可控的 fetch 队列；calls 记 url 与 init 供断言下推参数 */
function mountWith(replies, options = {}) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(String(url), init);
    return next;
  };
  const host = mountTracePage({ fetchImpl, ...options });
  return { host, calls };
}

function fire(element, type, dom_) {
  element.dispatchEvent(new dom_.window.Event(type, { bubbles: true }));
}

function query(url) {
  return new URL(url, 'http://localhost').searchParams;
}

const rows = host => [...host.querySelectorAll('tbody tr')];

// ---------- A1：进去先是列表，不是白板 ----------

test('A1：进去先是列表——有七列表格，没有画布（白板是另一页）', async () => {
  const { host } = mountWith([respond({ boards: [summary()], total: 1 })]);
  await flush();
  const heads = [...host.querySelectorAll('thead th')].map(text);
  assert.deepEqual(heads, ['告警', '主机', '告警时间', '状态', '链长', '断点', '更新时间']);
  assert.equal(host.querySelector('.world'), null, '列表页不该有画布');
  assert.equal(host.querySelector('[data-role="nodes"]'), null);
});

test('A1：点一行进这一条——行里的链接带白板路由，整行点击也跳过去', async () => {
  const { host } = mountWith([respond({ boards: [summary()], total: 1 })]);
  await flush();
  const link = host.querySelector('.board-link');
  assert.equal(link.getAttribute('href'), '#/trace-board/revshell%3A1');
  assert.match(link.getAttribute('aria-label'), /反弹 Shell/);

  rows(host)[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(globalThis.window.location.hash, '#/trace-board/revshell%3A1');
});

// ---------- 七列字段 ----------

test('七列逐格对字段：类型中文 + 短标识（title 留全 ID）/ 主机 / 时间 / 状态中文 / 链长 / 断点 / 更新时间', async () => {
  const long = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
  const { host } = mountWith([respond({
    boards: [
      summary(),
      summary({ id: long, type: 'honeypot', status: 'running', host: '10.0.0.9', chain_length: 1, has_gaps: true }),
      summary({ id: 'ip:172.16.221.41', type: null, status: 'interrupted', host: null, chain_length: 0 }),
    ],
    total: 3,
  })]);
  await flush();
  const cells = rows(host).map(row => [...row.querySelectorAll('td')]);

  assert.equal(text(cells[0][0]), '反弹 Shell revshell:1');
  assert.equal(text(cells[0][1]), '172.16.221.41');
  assert.match(text(cells[0][2]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(text(cells[0][3]), '已完成');
  assert.equal(text(cells[0][4]), '3 跳');
  assert.equal(text(cells[0][5]), '没有');
  assert.match(text(cells[0][6]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // 超长 ID：屏幕上短，title 与 href 里是全的（不丢信息）
  assert.notEqual(text(cells[1][0]), long);
  assert.match(text(cells[1][0]), /^蜜罐 /);
  assert.equal(cells[1][0].querySelector('.board-short').getAttribute('title'), long);
  assert.equal(cells[1][0].querySelector('a').getAttribute('href'), `#/trace-board/${encodeURIComponent(long)}`);
  assert.equal(text(cells[1][3]), '进行中');
  assert.equal(text(cells[1][5]), '有');

  // 没有类型（手填 IP 起的白板）：退回「告警」；没有主机给「—」
  assert.match(text(cells[2][0]), /^告警 /);
  assert.equal(text(cells[2][1]), '—');
  assert.equal(text(cells[2][3]), '中断');
  assert.equal(text(cells[2][4]), '0 跳');
});

test('alertCell：类型名走 eventTypeLabel，未知类型原样显示（不吞数据）', () => {
  const cell = alertCell(dom.window.document, summary({ type: 'brand_new_type' }));
  assert.match(text(cell), /^brand_new_type /);
});

// ---------- 六格状态 ----------

test('格 1 加载中：表格 aria-busy、刷新与四个筛选禁用、行里写「正在读取溯源…」', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { host } = mountWith([async () => { await pending; return respond({ boards: [], total: 0 }); }]);
  await flush();
  assert.equal(host.querySelector('[data-role="table-wrap"]').getAttribute('aria-busy'), 'true');
  assert.equal(host.querySelector('[data-role="refresh"]').disabled, true);
  for (const role of ['filter-status', 'filter-type', 'filter-host', 'filter-time']) {
    assert.equal(host.querySelector(`[data-role="${role}"]`).disabled, true, `${role} 应禁用`);
  }
  assert.match(text(rows(host)[0]), /正在读取溯源/);
  release();
  await flush();
});

test('格 2 空态：没有白板时写「暂无溯源」并指出去哪儿起（告警列表的「溯源」）', async () => {
  const { host } = mountWith([respond({ boards: [], total: 0 })]);
  await flush();
  assert.match(text(rows(host)[0]), /暂无溯源/);
  assert.match(text(rows(host)[0]), /告警列表/);
  assert.equal(host.querySelector('[data-role="prev-page"]').disabled, true);
  assert.equal(host.querySelector('[data-role="next-page"]').disabled, true);
});

test('格 3 部分失败：已有数据时刷新失败只挂一条提示，表格保留上一次的结果', async () => {
  const { host } = mountWith([
    respond({ boards: [summary()], total: 1 }),
    respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503),
  ]);
  await flush();
  assert.equal(rows(host).length, 1);

  host.querySelector('[data-role="refresh"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();

  const notice = host.querySelector('[data-role="notice"]');
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.match(text(notice), /刷新失败/);
  assert.match(text(notice), /尚未配置/);
  assert.equal(rows(host).length, 1, '上一次的结果要留着');
  assert.equal(host.querySelector('[data-role="total"]').textContent, '1');
});

test('格 4 错误：首屏失败给整块错误 + 重试；重试成功后表格出来', async () => {
  const { host, calls } = mountWith([
    respond({ error: '深度溯源模型或牧云 MCP 尚未配置' }, 503),
    respond({ boards: [summary()], total: 1 }),
  ]);
  await flush();
  const block = host.querySelector('.page-error');
  assert.equal(block.getAttribute('role'), 'alert');
  assert.match(text(block), /溯源列表读取失败/);
  assert.match(text(block), /尚未配置/);

  [...host.querySelectorAll('button')].find(button => text(button) === '重试')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(host.querySelector('.page-error'), null);
  assert.equal(rows(host).length, 1);
});

test('格 5 超长内容：主机与 ID 全文进 DOM（CSS 负责省略），不截断数据', async () => {
  const longHost = '2001:0db8:85a3:0000:0000:8a2e:0370:7334-fallback';
  const { host } = mountWith([respond({ boards: [summary({ host: longHost })], total: 1 })]);
  await flush();
  const cell = rows(host)[0].querySelector('.cell-ip');
  assert.equal(cell.textContent, longHost);
  assert.equal(cell.getAttribute('title'), longHost);
});

test('格 6 禁用：首页的「上一页」禁用；最后一页的「下一页」禁用；空表时都禁用', async () => {
  const { host } = mountWith([respond({ boards: [summary()], total: 45 })]);
  await flush();
  assert.equal(host.querySelector('[data-role="prev-page"]').disabled, true);
  assert.equal(host.querySelector('[data-role="next-page"]').disabled, false);
  assert.match(text(host.querySelector('[data-role="pager-info"]')), /1–1 \/ 45 条 · 共 3 页/);
});

// ---------- 筛选与分页：全部下推给接口 ----------

test('筛选下推：状态 / 类型 / 主机 / 时间各发对应的查询参数，并把 offset 退回第一页', async () => {
  const fixedNow = () => new Date('2026-11-18T00:00:00.000Z');
  const { host, calls } = mountWith([respond({ boards: [summary()], total: 1 })], { now: fixedNow });
  await flush();
  assert.equal(query(calls[0].url).get('count'), '20');
  assert.equal(query(calls[0].url).get('offset'), '0');

  const status = host.querySelector('[data-role="filter-status"]');
  status.value = 'running';
  fire(status, 'change', dom);
  await flush();
  assert.equal(query(calls[1].url).get('status'), 'running');

  const type = host.querySelector('[data-role="filter-type"]');
  type.value = 'revshell';
  fire(type, 'change', dom);
  await flush();
  assert.equal(query(calls[2].url).get('type'), 'revshell');
  assert.equal(query(calls[2].url).get('status'), 'running');

  const hostInput = host.querySelector('[data-role="filter-host"]');
  hostInput.value = ' 172.16.221.41 ';
  fire(hostInput, 'change', dom);
  await flush();
  assert.equal(query(calls[3].url).get('host'), '172.16.221.41', '主机去空格后精确下推');

  const time = host.querySelector('[data-role="filter-time"]');
  time.value = '24h';
  fire(time, 'change', dom);
  await flush();
  assert.equal(query(calls[4].url).get('from'), '2026-11-17T00:00:00.000Z');
  assert.equal(query(calls[4].url).get('offset'), '0', '换筛选回第一页');

  // 清除筛选：四个参数一起消失
  host.querySelector('[data-role="clear-filters"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  const cleared = query(calls[5].url);
  for (const key of ['status', 'type', 'host', 'from']) assert.equal(cleared.get(key), null, `${key} 应消失`);
});

test('筛选生效时显示「筛选后 N 条」；没有筛选时不显示', async () => {
  const { host } = mountWith([respond({ boards: [summary()], total: 1 })]);
  await flush();
  assert.equal(text(host.querySelector('[data-role="filter-count"]')), '');
  const type = host.querySelector('[data-role="filter-type"]');
  type.value = 'revshell';
  fire(type, 'change', dom);
  await flush();
  assert.equal(text(host.querySelector('[data-role="filter-count"]')), '筛选后 1 条');
});

test('分页：下一页 offset=20；每页 50 改 count 并回第一页', async () => {
  const { host, calls } = mountWith([respond({ boards: [summary()], total: 45 })]);
  await flush();
  host.querySelector('[data-role="next-page"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(query(calls[1].url).get('offset'), '20');
  assert.equal(query(calls[1].url).get('count'), '20');

  host.querySelector('[data-role="size-50"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(query(calls[2].url).get('count'), '50');
  assert.equal(query(calls[2].url).get('offset'), '0');
  assert.equal(host.querySelector('[data-role="size-50"]').getAttribute('aria-pressed'), 'true');
});

test('筛选后空表：写「没有匹配的溯源」并给「清除筛选」', async () => {
  const { host, calls } = mountWith([respond({ boards: [summary()], total: 1 }), respond({ boards: [], total: 0 })]);
  await flush();
  const status = host.querySelector('[data-role="filter-status"]');
  status.value = 'failed';
  fire(status, 'change', dom);
  await flush();
  assert.match(text(rows(host)[0]), /没有匹配的溯源/);
  [...rows(host)[0].querySelectorAll('button')].find(button => text(button) === '清除筛选')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(query(calls[2].url).get('status'), null);
});

test('A5 的反面证据：列表页的输入框只有「按主机筛选」，没有对话输入框', async () => {
  const { host } = mountWith([respond({ boards: [summary()], total: 1 })]);
  await flush();
  const inputs = [...host.querySelectorAll('input, textarea')];
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].getAttribute('aria-label'), '按主机 IP 筛选');
});
