// pages/overview.js —— 总览页：六格状态矩阵 + 队列暂停/恢复 + 刷新 + 可访问性
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { page } from '../../pages/overview.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { allByRole, byRole, setupDom, text } from '../dom.js';

/** 稿 overview.html 里的 11 类示例数量，合计 347 */
const FULL_TOTALS = {
  webshell: 42,
  malware: 17,
  revshell: 9,
  memory_webshell: 6,
  brute_force: 128,
  abnormal_login: 24,
  elevation_process: 11,
  network_audit: 63,
  suspicious_operation: 31,
  honeypot: 12,
  memory_security: 4,
};

const TRIAGE = {
  initialized: true,
  enabled: true,
  input_mode: 'syslog',
  last_poll_at: '2026-11-17T01:02:03.000Z',
  last_error: null,
  counts: { queued: 12, running: 3, done: 331, failed: 1 },
};

const ALERTS = { alerts: [], total: 347, totals: FULL_TOTALS, errors: {}, partial: false };

function routes(overrides = {}) {
  return {
    '/api/alerts?count=1': { body: ALERTS },
    '/api/agent/triage/status': { body: TRIAGE },
    '/api/status': { body: { configured: true, connected: true } },
    '/api/agent/status': { body: { configured: true, model: 'gpt', missing: [], prompt_version: 'p-2026.11+4f2a' } },
    '/api/agent/tools': { body: { provider: 'cloudwalker-api', readOnly: true, count: 28, tools: [] } },
    '/api/triage/rules': { body: { config: {}, origin: 'file', revision: '4f2a9c1d0b7e3311', writable: false } },
    '/api/updates': { body: { revision: '9b1d4f2a7c3e5566' } },
    ...overrides,
  };
}

let calls = [];

/** 桩 fetch。路由值可以是 {status, body}、Error（网络失败）或 (init) => {status, body} */
function stubFetch(table) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(table).find(path => String(url).endsWith(path));
    if (key === undefined) throw new Error(`未桩的请求：${url}`);
    const route = typeof table[key] === 'function' ? table[key](init) : table[key];
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => route.body };
  };
}

const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

let content;

function mount() {
  content = document.createElement('div');
  document.body.append(content);
  page.render(content, { params: [] });
  return content;
}

/** dl 里按 dt 文案取 dd 文本（限定容器，避免「待研判」在摘要带和侧栏各有一个） */
function valueOf(scope, label) {
  const dt = [...scope.querySelectorAll('dt')].find(node => text(node) === label);
  assert.ok(dt, `找不到「${label}」这一行`);
  return text(dt.parentElement.querySelector('dd'));
}

const overview = () => content.querySelector('.overview');
const typeRows = () => [...content.querySelectorAll('.type-table tbody tr')];
const typeNames = () => typeRows().map(row => text(row.querySelector('td')));
const queueModule = () => content.querySelector('.side .module');
const queueToggle = () => byRole(content, 'button', /暂停|恢复/);
const refreshButton = () => byRole(content, 'button', '刷新');
const liveText = () => text(content.querySelector('[role="status"]'));
const notice = () => content.querySelector('[data-role="notice"]');

beforeEach(() => {
  setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

test('loading：首屏先画骨架——数值「—」、刷新禁用转圈、aria-busy、读屏报「正在读取数据」', async () => {
  stubFetch(routes());
  mount();

  assert.equal(overview().getAttribute('aria-busy'), 'true');
  assert.equal(refreshButton().disabled, true);
  assert.equal(refreshButton().classList.contains('is-loading'), true);
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '—');
  assert.equal(liveText(), '正在读取数据');

  await settle();
  assert.equal(overview().getAttribute('aria-busy'), 'false');
  assert.equal(refreshButton().disabled, false);
});

test('默认态：四个数字、类型表按数量降序、构成条与三段摘要、队列、运行状态、进度全来自接口', async () => {
  stubFetch(routes());
  mount();
  await settle();

  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '347');
  assert.equal(valueOf(content.querySelector('.summary'), '待研判'), '12');
  assert.equal(valueOf(content.querySelector('.summary'), '研判中'), '3');
  assert.equal(valueOf(content.querySelector('.summary'), '失败'), '1');

  assert.equal(content.querySelector('[data-role="types-meta"]').textContent, '11 类 · 合计 347');
  const rows = typeRows();
  assert.equal(rows.length, 11);
  assert.equal(typeNames()[0], '暴力破解');
  assert.deepEqual(rows[0].querySelectorAll('td').length, 4);
  assert.equal(text(rows[0].querySelector('.col-num')), '128');
  assert.equal(text(rows[0].querySelector('.col-share')), '37%');
  assert.equal(rows[0].querySelector('.bar-fill').style.width, '100%');
  assert.equal(typeNames().at(-1), '内存安全');
  assert.equal(text(rows.at(-1).querySelector('.col-num')), '4');

  assert.equal(content.querySelectorAll('.compose-seg').length, 11);
  assert.equal(content.querySelector('[data-role="compose-meta"]').textContent, '暴力破解 128 · 网络审计 63 · 网站后门 42');

  const queue = queueModule();
  assert.equal(valueOf(queue, '状态'), '运行中');
  assert.equal(valueOf(queue, '输入方式'), 'Syslog 推入');
  assert.match(valueOf(queue, '最近轮询'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(valueOf(queue, '待研判'), '12');
  assert.equal(valueOf(queue, '已完成'), '331');
  assert.equal(valueOf(queue, '最近错误'), '无');
  assert.equal(text(queueToggle()), '暂停');

  const env = content.querySelectorAll('.side .module')[1];
  assert.equal(valueOf(env, '牧云连接'), '已连接');
  assert.equal(valueOf(env, '研判模型'), '已就绪');
  assert.equal(valueOf(env, '规则版本'), '4f2a9c1d0b7e3311');
  assert.equal(valueOf(env, '取证工具'), '28 个');
  assert.equal(valueOf(env, '提示词版本'), 'p-2026.11+4f2a');
  assert.equal(content.querySelector('[data-role="version"]').textContent, '9b1d4f2a7c3e5566');

  assert.equal(content.querySelector('[data-role="progress-meta"]').textContent, '共 347 个任务 · 完成率 95%');
  assert.equal(content.querySelectorAll('.progress-seg').length, 4);
  assert.equal(content.querySelectorAll('.progress-legend li').length, 4);
  assert.match(text(content.querySelector('.progress-legend')), /已完成 331 95%/);

  assert.equal(notice().hidden, true);
  assert.match(liveText(), /^已更新，时间 \d{2}:\d{2}:\d{2}$/);
});

test('空态：类型表给一行「暂无告警数据」，队列计数说明接口没回，不画假行假数字', async () => {
  stubFetch(routes({
    '/api/alerts?count=1': { body: { alerts: [], total: 0, totals: {}, errors: {}, partial: false } },
    '/api/agent/triage/status': { body: { ...TRIAGE, counts: { queued: 0, running: 0, done: 0, failed: 0 }, last_poll_at: null } },
  }));
  mount();
  await settle();

  assert.deepEqual(typeNames(), ['暂无告警数据']);
  assert.equal(content.querySelector('[data-role="types-meta"]').textContent, '0 类 · 合计 0');
  assert.equal(content.querySelector('[data-role="compose-meta"]').textContent, '接口未返回类型统计。');
  assert.equal(content.querySelector('[data-role="progress-meta"]').textContent, '接口未返回队列计数。');
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '0');
  assert.equal(valueOf(queueModule(), '最近轮询'), '—');
});

test('部分失败：稿的 partial 提示可见、点出失败类型，总数仍按接口的 total，缺的类型不造行', async () => {
  stubFetch(routes({
    '/api/alerts?count=1': {
      body: {
        alerts: [],
        total: 334,
        totals: Object.fromEntries(Object.entries(FULL_TOTALS).filter(([type]) => type !== 'malware')),
        errors: { malware: '请求超时' },
        partial: true,
      },
    },
  }));
  mount();
  await settle();

  const partial = content.querySelector('[data-role="partial"]');
  assert.equal(partial.hidden, false);
  assert.match(text(partial), /部分类型查询失败/);
  assert.match(text(partial), /恶意程序/);
  assert.equal(typeNames().includes('恶意程序'), false);
  assert.equal(typeRows().length, 10);
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '334');
});

test('单源失败：整页不空，只是那几行「—」，顶部说明哪几项没读到', async () => {
  stubFetch(routes({ '/api/agent/tools': { status: 503, body: { error: '牧云 API 未配置' } } }));
  mount();
  await settle();

  assert.equal(notice().hidden, false);
  assert.match(text(notice()), /部分数据读取失败：取证工具/);
  assert.equal(notice().getAttribute('role'), 'alert');
  assert.equal(valueOf(content.querySelectorAll('.side .module')[1], '取证工具'), '—');
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '347');
});

test('error：七路全挂 → 整页错误提示 + 全部「—」+ 刷新可点重试', async () => {
  stubFetch(Object.fromEntries(Object.keys(routes()).map(path => [path, new TypeError('fetch failed')])));
  mount();
  await settle();

  assert.equal(notice().hidden, false);
  assert.equal(text(notice()), '连不上研判服务，请检查网络后重试。');
  assert.equal(notice().dataset.tone, 'danger');
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '—');
  assert.deepEqual(typeNames(), ['—']);
  assert.equal(refreshButton().disabled, false);
  assert.match(liveText(), /数据读取失败/);
});

test('error：凭据失效（401）说人话「登录已失效」，不冒充网络问题', async () => {
  stubFetch(Object.fromEntries(Object.keys(routes()).map(path => [path, { status: 401, body: {} }])));
  mount();
  await settle();

  assert.equal(text(notice()), '登录已失效，请退出后重新登录。');
});

test('long-content：200 字最近错误与 16 位版本号全文在 DOM 与 title 里，只靠 CSS 截断视觉', async () => {
  const longError = `牧云 ${'超时'.repeat(90)}`;
  stubFetch(routes({ '/api/agent/triage/status': { body: { ...TRIAGE, last_error: longError } } }));
  mount();
  await settle();

  const errorCell = queueModule().querySelector('[data-role="queue-error"]');
  assert.equal(errorCell.textContent, longError);
  assert.equal(errorCell.getAttribute('title'), longError);
  assert.ok(errorCell.classList.contains('od-truncate'));
  const rules = content.querySelector('[data-role="sys-rules"]');
  assert.equal(rules.getAttribute('title'), '4f2a9c1d0b7e3311');
});

test('disabled：刷新在途禁用；暂停按钮请求在途禁用，回包后同步状态文案', async () => {
  let releaseControl;
  stubFetch(routes({
    '/api/agent/triage/control': () => ({ body: { ...TRIAGE, enabled: false } }),
  }));
  mount();
  await settle();

  const gate = new Promise(resolve => { releaseControl = resolve; });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/agent/triage/control')) await gate;
    return inner(url, init);
  };

  const toggle = queueToggle();
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.disabled, true);
  assert.equal(liveText(), '正在暂停自动研判');

  releaseControl();
  await settle();
  assert.equal(toggle.disabled, false);
  assert.equal(text(toggle), '恢复');
  assert.equal(valueOf(queueModule(), '状态'), '已暂停');
  assert.match(queueModule().querySelector('[data-role="queue-state"]').className, /is-paused/);
  assert.equal(liveText(), '自动研判已暂停');
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/control')).init.body), { enabled: false });
});

test('暂停失败：提示失败、状态保持、按钮恢复可点（不假装成功）', async () => {
  stubFetch(routes({ '/api/agent/triage/control': { status: 503, body: {} } }));
  mount();
  await settle();

  queueToggle().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();

  assert.equal(text(notice()), '自动研判操作失败：服务返回异常（503），请稍后重试。');
  assert.equal(valueOf(queueModule(), '状态'), '运行中');
  assert.equal(text(queueToggle()), '暂停');
  assert.equal(queueToggle().disabled, false);
});

test('刷新：点一下重新取七路，更新时间跟着换，读屏播报', async () => {
  stubFetch(routes());
  mount();
  await settle();
  assert.equal(calls.length, 7);

  refreshButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(refreshButton().disabled, true);
  await settle();

  assert.equal(calls.length, 14);
  assert.match(liveText(), /^已更新，时间 \d{2}:\d{2}:\d{2}$/);
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '347');
});

test('切页作废旧响应：第二次 render 的页面不会被第一次的晚到数据覆盖', async () => {
  const pending = [];
  globalThis.fetch = (url, init) => new Promise(resolve => pending.push({ url: String(url), init, resolve }));

  const respond = (entry, total) => entry.resolve({
    status: 200,
    ok: true,
    json: async () => (entry.url.endsWith('/api/alerts?count=1')
      ? { alerts: [], total, totals: { honeypot: total }, errors: {}, partial: false }
      : entry.url.endsWith('/api/agent/triage/status') ? TRIAGE
        : entry.url.endsWith('/api/agent/status') ? { configured: true, prompt_version: 'x' }
          : entry.url.endsWith('/api/agent/tools') ? { count: 1 }
            : entry.url.endsWith('/api/triage/rules') ? { revision: null }
              : entry.url.endsWith('/api/updates') ? { revision: null } : { configured: true, connected: true }),
  });

  mount();            // 第一轮：7 个请求挂起
  await new Promise(resolve => setTimeout(resolve, 0));
  mount();            // 第二轮（模拟切走再切回）：又 7 个
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pending.length, 14);

  pending.slice(7).forEach(entry => respond(entry, 222));
  await settle();
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '222');

  pending.slice(0, 7).forEach(entry => respond(entry, 111));
  await settle();
  assert.equal(content.querySelectorAll('.overview').length, 1);
  assert.equal(valueOf(content.querySelector('.summary'), '告警总数'), '222');
});

test('可访问性：表格有 caption 与 th scope，概况/进度是带名字的 region，status 有 aria-live', () => {
  stubFetch(routes());
  mount();

  assert.equal(text(content.querySelector('table caption')), '按事件类型统计的告警数量与占比');
  assert.deepEqual([...content.querySelectorAll('thead th')].map(th => th.getAttribute('scope')), ['col', 'col', 'col', 'col']);
  assert.equal(content.querySelector('section.summary').getAttribute('aria-label'), '告警概况');
  assert.equal(content.querySelector('.progress-band').getAttribute('aria-label'), '研判进度');
  const status = content.querySelector('[role="status"]');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  // 载入中不许靠颜色传达状态：状态文字本身在 DOM 里
  assert.equal(allByRole(content, 'heading', '事件类型').length, 1);
});

test('本页只留两个动作：刷新 + 队列暂停/恢复，没有行级操作（稿 §5）', async () => {
  stubFetch(routes());
  mount();
  await settle();
  assert.deepEqual(allByRole(content, 'button').map(button => text(button)), ['刷新', '暂停']);
  assert.equal(content.querySelectorAll('table button, table a').length, 0);
});
