// pages/alerts.js —— 告警页六格状态矩阵 + 表格字段 + 分页 + 选择/批量 + 抽屉 + 队列开关
// 字段一律照接口真名（cloudwalker.js:31-56 的 normalizeAlert / triage-monitor.js:91-96 的 status）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { formatTime, mountAlertsPage, triageStatusOf, verdictOf } from '../../pages/alerts.js';
import { setCredentials, clearCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

const SUMMARY = {
  initialized: true, enabled: true, input_mode: 'syslog', last_poll_at: null, last_error: null,
  counts: { queued: 2, running: 1, done: 9, failed: 1 },
};

/** 一行的真实形状（取自 normalizeAlert 的返回键） */
function alert(overrides = {}) {
  return {
    id: 'revshell:1', eventType: 'revshell', eventId: 1, hostId: 12,
    createdAt: '2026-11-17T01:02:03.000Z', time: '09:02:03',
    title: '反弹 Shell 外联', level: '高危', levelKey: 'high',
    asset: 'web-prod-01', assetIp: '172.16.221.30',
    source: '172.16.221.30', target: '45.9.1.2', account: 'root', command: 'bash -i',
    verdict: '待研判', verdictKey: 'review', coverage: null, cases: 0,
    scenario: '反弹 Shell', detail: '已从牧云读取原始事件；尚未执行 AI 研判。',
    evidence: ['牧云 反弹 Shell 事件 #1'], gap: '待获取事件详情与关联证据',
    state: null, triage: null,
    ...overrides,
  };
}

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const alertsPage = (body, status = 200) => respond(body, status);

/**
 * 起页面。handler(url, init) 决定回什么；默认：告警列表照 alertsBody，队列照 SUMMARY。
 * @returns {{ host: HTMLElement, calls: {url:string, init:object}[] }}
 */
function mount({ alertsBody = { alerts: [alert()], total: 1 }, alertsStatus = 200, summary = SUMMARY, summaryStatus = 200, handler } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (handler) {
      const custom = await handler(String(url), init);
      if (custom) return custom;
    }
    if (String(url).startsWith('/api/agent/triage/status')) return respond(summary, summaryStatus);
    if (String(url).startsWith('/api/alerts')) return alertsPage(alertsBody, alertsStatus);
    return respond({ error: '未预期的请求' }, 500);
  };
  const host = mountAlertsPage({ fetchImpl, now: () => new Date(2026, 10, 17, 9, 8, 7) });
  document.body.append(host);
  return { host, calls };
}

const rows = host => [...host.querySelectorAll('tbody tr')];
const cellsOf = row => [...row.querySelectorAll('td')].map(cell => text(cell));
const buttonByName = (host, name) => [...host.querySelectorAll('button')].find(button => text(button) === name);

function check(host, index) {
  const box = host.querySelectorAll('tbody tr')[index].querySelector('input[type="checkbox"]');
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change'));
}

// ---------- 六格状态矩阵 ----------

test('格 1「加载中」：先出「正在读取告警…」+ aria-busy，刷新禁用；取到数据后撤掉', async () => {
  const { host } = mount();

  // 同步就能看到的加载态（不发第二次渲染）
  assert.equal(text(host.querySelector('tbody')), '正在读取告警…');
  assert.equal(host.querySelector('.table-wrap').getAttribute('aria-busy'), 'true');
  assert.equal(buttonByName(host, '刷新').disabled, true);

  await flush();

  assert.equal(host.querySelector('.table-wrap').hasAttribute('aria-busy'), false);
  assert.equal(buttonByName(host, '刷新').disabled, false);
  assert.equal(rows(host).length, 1);
  assert.equal(host.querySelector('[data-role="stamp"]').textContent, '09:08:07');
  assert.equal(text(host.querySelector('[data-role="total"]')), '1');
});

test('格 2「空」：total 0 时表内一行提示，翻页与全选都禁用', async () => {
  const { host } = mount({ alertsBody: { alerts: [], total: 0 } });
  await flush();

  assert.equal(text(host.querySelector('tbody')), '暂无告警。');
  assert.equal(buttonByName(host, '上一页').disabled, true);
  assert.equal(buttonByName(host, '下一页').disabled, true);
  assert.equal(host.querySelector('[data-role="select-all"]').disabled, true);
  assert.equal(text(host.querySelector('[data-role="total"]')), '0');
});

test('格 3「部分失败」：partial 为真时出提示条，逐条列失败的类型与原因', async () => {
  const { host } = mount({
    alertsBody: { alerts: [alert()], total: 1, partial: true, errors: { honeypot: '牧云 /rpc 超时' } },
  });
  await flush();

  const notice = host.querySelector('[data-role="partial"]');
  assert.equal(notice.hidden, false);
  assert.match(text(notice), /部分类型查询失败/);
  assert.match(text(notice), /honeypot：牧云 \/rpc 超时/);
});

test('格 4「错误」：503 出提示块（区分「没配好」），重试按钮再取一次', async () => {
  let attempt = 0;
  const { host } = mount({
    handler: url => {
      if (!url.startsWith('/api/alerts')) return null;
      attempt += 1;
      return attempt === 1 ? respond({ error: 'CLOUDWALKER_URL 缺失' }, 503) : respond({ alerts: [alert()], total: 1 });
    },
  });
  await flush();

  const block = host.querySelector('[role="alert"]');
  assert.ok(block, '错误态要有 role="alert"');
  assert.match(text(block), /告警接口不可用/);
  assert.doesNotMatch(text(block), /CLOUDWALKER_URL/, '不把服务端原文甩到界面上');

  buttonByName(host, '重试').dispatchEvent(new dom.window.Event('click'));
  await flush();
  assert.equal(attempt, 2);
  assert.equal(rows(host).length, 1);
});

test('格 4b「错误」：连不上与 401 的文案互不相同', async () => {
  const offline = mount({ handler: () => { throw new Error('ECONNREFUSED'); } });
  await flush();
  assert.match(text(offline.host.querySelector('[role="alert"]')), /无法连接/);

  const denied = mount({ alertsStatus: 401 });
  await flush();
  assert.match(text(denied.host.querySelector('[role="alert"]')), /登录已失效/);
});

test('格 5「超长内容」：标题与 ID 原样进 textContent/title（截断交给 CSS），不丢字', async () => {
  const longTitle = `可疑进程 ${'很长'.repeat(60)}`;
  const longId = `suspicious_operation:${'9'.repeat(40)}`;
  const { host } = mount({ alertsBody: { alerts: [alert({ id: longId, title: longTitle })], total: 1 } });
  await flush();

  const titleButton = host.querySelector('.cell-title');
  assert.equal(text(titleButton), longTitle);
  assert.equal(titleButton.getAttribute('title'), longTitle);
  assert.equal(text(host.querySelector('.cell-id')), longId);
});

test('格 6「禁用」：队列暂停时开关变「恢复」；排队中/研判中的抽屉按钮禁用并显示当前状态', async () => {
  const { host } = mount({
    alertsBody: {
      alerts: [alert({ triage: { status: 'running', stage: '研判中' } }), alert({ id: 'webshell:2', eventId: 2 })],
      total: 2,
    },
    summary: { ...SUMMARY, enabled: false },
  });
  await flush();

  assert.equal(text(host.querySelector('[data-role="qstate"]')), '自动研判 已暂停');
  assert.ok(host.querySelector('[data-role="qstate"]').classList.contains('is-paused'));
  const toggle = buttonByName(host, '恢复');
  assert.ok(toggle, '暂停时按钮文案应为「恢复」');

  host.querySelectorAll('.cell-title')[0].dispatchEvent(new dom.window.Event('click'));
  const drawerButton = host.querySelector('[data-role="drawer-queue"]');
  assert.equal(drawerButton.disabled, true);
  assert.equal(text(drawerButton), '研判中');
});

// ---------- 表格字段只来自接口 ----------

test('表格：十列齐全，每格取接口字段；空值显示「—」；不拿 alert.verdict 当结论', async () => {
  const { host } = mount({
    alertsBody: {
      alerts: [
        alert({ triage: { status: 'done', verdict_label: '真实威胁', verified_facts: 3, evidence_sources: 2, report: '结论正文' } }),
        alert({ id: 'webshell:2', eventId: 2, assetIp: null, hostId: null, createdAt: null, level: '中危', levelKey: 'medium', scenario: 'WebShell' }),
      ],
      total: 2,
    },
  });
  await flush();

  assert.equal(text(host.querySelector('thead')), '等级 告警 ID 告警 类型 资产 IP 研判状态 结论 时间 ↓');
  const [first, second] = rows(host).map(cellsOf);
  assert.equal(first.length, 10);
  assert.equal(first[1], '高危');
  assert.equal(first[2], 'revshell:1');
  assert.equal(first[3], '反弹 Shell 外联');
  assert.equal(first[4], '反弹 Shell', '类型列取接口 scenario');
  assert.equal(first[5], 'web-prod-01');
  assert.equal(first[6], '172.16.221.30');
  assert.equal(first[7], '完成');
  assert.equal(first[8], '真实威胁');
  assert.match(first[9], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  assert.equal(second[6], '—', 'assetIp 为 null → —');
  assert.equal(second[8], '—', '没有 verdict_label → —（不显示 alert.verdict 的占位「待研判」）');
  assert.equal(second[7], '未研判', '没有 triage → 未研判');
  assert.equal(second[9], '—', 'createdAt 为 null → —');
  assert.equal(host.textContent.includes('待研判'), false, '占位结论不得出现在界面上');
});

test('A2 负向钉：筛选/排序控件不存在（接口没有那些参数），时间列只留静态降序标记', async () => {
  const { host } = mount();
  await flush();

  assert.equal(host.querySelectorAll('select').length, 0, '不渲染类型/等级/结论/研判状态筛选');
  assert.equal(host.querySelectorAll('input[type="search"]').length, 0, '不渲染搜索框');
  assert.equal(buttonByName(host, '清除筛选'), undefined);
  assert.equal(host.querySelectorAll('th button').length, 0, '表头没有排序按钮');
  assert.equal(host.querySelector('th.col-time').getAttribute('aria-sort'), 'descending');
  assert.equal(host.textContent.includes('查看 1 条失败'), false, '队列条不渲染「查看失败」（无过滤参数）');
});

// ---------- 分页 ----------

test('分页：请求只带 count/offset；下一页 +20；每页 50 回到第一页；页数按 total 算', async () => {
  const { host, calls } = mount({ alertsBody: { alerts: [alert()], total: 45 } });
  await flush();

  const alertCalls = () => calls.filter(call => call.url.startsWith('/api/alerts')).map(call => call.url);
  assert.deepEqual(alertCalls(), ['/api/alerts?count=20&offset=0']);
  assert.equal(text(host.querySelector('[data-role="pager-info"]')), '1–1 / 45 条 · 共 3 页');

  buttonByName(host, '下一页').dispatchEvent(new dom.window.Event('click'));
  await flush();
  assert.equal(alertCalls().at(-1), '/api/alerts?count=20&offset=20');

  buttonByName(host, '50').dispatchEvent(new dom.window.Event('click'));
  await flush();
  assert.equal(alertCalls().at(-1), '/api/alerts?count=50&offset=0');
  assert.equal(host.querySelector('[data-role="size-50"]').getAttribute('aria-pressed'), 'true');
  assert.equal(host.querySelector('[data-role="size-20"]').getAttribute('aria-pressed'), 'false');

  buttonByName(host, '上一页').dispatchEvent(new dom.window.Event('click'));
  await flush();
  assert.equal(alertCalls().length, 3, '已经在第一页时不再发请求');
});

// ---------- 选择与批量重新研判 ----------

test('选择：勾行出现批量条；全选只作用于当前页；「重新研判所选」逐条 POST，跳过排队中/研判中', async () => {
  const { host, calls } = mount({
    alertsBody: {
      alerts: [
        alert(),
        alert({ id: 'webshell:2', eventId: 2, triage: { status: 'running' } }),
        alert({ id: 'malware:3', eventId: 3, triage: { status: 'queued' } }),
      ],
      total: 3,
    },
  });
  await flush();

  const bar = host.querySelector('[data-role="bulkbar"]');
  assert.equal(bar.hidden, true);

  const selectAll = host.querySelector('[data-role="select-all"]');
  selectAll.checked = true;
  selectAll.dispatchEvent(new dom.window.Event('change'));
  assert.equal(bar.hidden, false);
  assert.equal(text(host.querySelector('[data-role="bulk-count"]')), '3');

  buttonByName(host, '重新研判所选').dispatchEvent(new dom.window.Event('click'));
  await flush();

  const posts = calls.filter(call => call.init?.method === 'POST').map(call => call.url);
  assert.deepEqual(posts, ['/api/agent/triage/revshell%3A1'], '只有未入队的那条被提交');
  assert.equal(bar.hidden, true, '批量操作后清除选择');
  assert.ok(calls.some(call => call.url.startsWith('/api/alerts') && call.init?.method !== 'POST'),
    '操作完重新取一次真实状态');
});

test('选择：全选后取消全选只清当前页的选中项', async () => {
  const { host } = mount({
    alertsBody: { alerts: [alert(), alert({ id: 'webshell:2', eventId: 2 })], total: 2 },
  });
  await flush();

  const selectAll = host.querySelector('[data-role="select-all"]');
  selectAll.checked = true;
  selectAll.dispatchEvent(new dom.window.Event('change'));
  assert.equal(text(host.querySelector('[data-role="bulk-count"]')), '2');

  check(host, 0);
  host.querySelectorAll('tbody tr')[0].querySelector('input[type="checkbox"]').checked = false;
  host.querySelectorAll('tbody tr')[0].querySelector('input[type="checkbox"]').dispatchEvent(new dom.window.Event('change'));
  assert.equal(text(host.querySelector('[data-role="bulk-count"]')), '1');
  assert.equal(selectAll.indeterminate, true);
});

// ---------- 抽屉 ----------

test('抽屉：点标题打开，字段取接口；Esc 关闭且焦点回该行标题；详情链接指向告警详情路由', async () => {
  const { host } = mount({
    alertsBody: {
      alerts: [alert({
        triage: {
          status: 'done', verdict_label: '存疑', verified_facts: 4, evidence_sources: 2, report: '需要补主机登录日志',
          matched_alert_id: 'revshell:1',
          steps: [{ stage: '规则评估', detail: '命中候选', at: '2026-11-17T01:03:00.000Z' }, { stage: '研判', detail: '完成' }],
        },
      })],
      total: 1,
    },
  });
  await flush();

  const titleButton = host.querySelector('.cell-title');
  titleButton.dispatchEvent(new dom.window.Event('click'));

  const drawer = host.querySelector('[data-role="drawer"]');
  assert.equal(drawer.hidden, false);
  assert.equal(text(host.querySelector('[data-role="drawer-id"]')), 'revshell:1');
  assert.equal(text(host.querySelector('[data-role="drawer-level"]')), '高危');
  assert.equal(text(host.querySelector('[data-role="drawer-verdict"]')), '存疑');
  assert.equal(text(host.querySelector('[data-role="drawer-report"]')), '需要补主机登录日志');
  assert.equal(text(host.querySelector('[data-role="drawer-event"]')), '#1');
  assert.equal(text(host.querySelector('[data-role="drawer-host"]')), '#12');
  assert.equal(text(host.querySelector('[data-role="drawer-state"]')), '完成');
  assert.match(text(host.querySelector('[data-role="drawer-evidence"]')), /已验证事实\s*4 条\s*证据来源\s*2 个/);
  assert.equal(text(host.querySelector('[data-role="raw-level"]')), 'high');
  assert.equal(text(host.querySelector('[data-role="raw-matched"]')), 'revshell:1');
  assert.equal(host.querySelector('[data-role="drawer-steps-block"]').hidden, false);
  assert.equal(host.querySelectorAll('[data-role="drawer-steps"] .step').length, 2);
  assert.equal(host.querySelector('[data-role="drawer-detail"]').getAttribute('href'), '#/alert-detail/revshell%3A1');
  assert.equal(document.activeElement, host.querySelector('[data-role="drawer-close"]'), '打开后焦点进抽屉');

  drawer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(drawer.hidden, true);
  assert.equal(document.activeElement, titleButton, '关闭后焦点回原行标题');
});

test('抽屉：没有步骤与结论时不渲染步骤区块，结论写「尚未产生研判结论」', async () => {
  const { host } = mount();
  await flush();

  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));
  assert.equal(host.querySelector('[data-role="drawer-steps-block"]').hidden, true);
  assert.equal(text(host.querySelector('[data-role="drawer-verdict"]')), '未研判');
  assert.equal(text(host.querySelector('[data-role="drawer-report"]')), '该告警尚未产生研判结论。');
  assert.match(text(host.querySelector('[data-role="drawer-evidence"]')), /已验证事实\s*0 条\s*证据来源\s*0 个/);
});

test('抽屉：研判失败且没有结论时，结论区写「研判失败」而不是「研判中」', async () => {
  const { host } = mount({
    alertsBody: {
      alerts: [alert({
        triage: {
          status: 'failed', stage: '研判失败', detail: '牧云 MCP HTTP 404',
          steps: [{ stage: '准备研判', detail: '正在读取牧云工具与提示词', at: '2026-11-17T01:02:05.000Z' }],
        },
      })],
      total: 1,
    },
  });
  await flush();

  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));
  assert.equal(text(host.querySelector('[data-role="drawer-verdict"]')), '研判失败，暂无结论');
  assert.equal(text(host.querySelector('[data-role="drawer-state"]')), '失败');
  assert.equal(text(host.querySelector('[data-role="drawer-queue"]')), '重试');
  assert.equal(host.querySelector('[data-role="drawer-queue"]').disabled, false);
  assert.ok(host.querySelector('[data-role="drawer-steps"] .step').classList.contains('is-done'),
    '失败任务的步骤不画成「处理中」');
  const steps = text(host.querySelector('[data-role="drawer-steps"]'));
  assert.match(steps, /准备研判/);
  assert.match(steps, /正在读取牧云工具与提示词/);
});

test('抽屉「缺失证据」：done 态有值就显示（文案取接口数组，逐项不丢）', async () => {
  const { host } = mount({
    alertsBody: {
      alerts: [alert({
        triage: {
          status: 'done', verdict_label: '存疑', verified_facts: 2, evidence_sources: 1,
          missing_evidence: ['主机登录日志', '进程树'],
        },
      })],
      total: 1,
    },
  });
  await flush();

  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));
  const missing = host.querySelector('[data-role="drawer-missing"]');
  assert.equal(missing.hidden, false, 'done 且有 missing_evidence 时不该藏');
  assert.equal(text(missing), '缺失证据：主机登录日志、进程树');
  assert.ok(missing.querySelector('b'), '稿的 .missing 里 b 单独上警示色（alerts.html:645）');
});

test('抽屉「缺失证据」：未研判与空数组都 hidden（不画空行）', async () => {
  const { host } = mount();
  await flush();
  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));
  assert.equal(host.querySelector('[data-role="drawer-missing"]').hidden, true);
  assert.equal(text(host.querySelector('[data-role="drawer-missing"]')), '');
});

test('抽屉「缺失证据」：done 但数组为空时 hidden', async () => {
  const { host } = mount({
    alertsBody: {
      alerts: [alert({ triage: { status: 'done', verdict_label: '误报', missing_evidence: [] } })],
      total: 1,
    },
  });
  await flush();
  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));
  assert.equal(host.querySelector('[data-role="drawer-missing"]').hidden, true);
});

test('抽屉底部按钮：未研判→加入队列（POST），失败→重试，完成→重新研判', async () => {
  const { host, calls } = mount({
    handler: (url, init) => (url.startsWith('/api/agent/triage/') && init?.method === 'POST'
      ? respond({ alert_id: 'revshell:1', status: 'queued', stage: '等待研判' }, 202)
      : null),
  });
  await flush();

  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));
  const button = host.querySelector('[data-role="drawer-queue"]');
  assert.equal(text(button), '加入研判队列');
  assert.equal(button.disabled, false);

  button.dispatchEvent(new dom.window.Event('click'));
  await flush();
  assert.ok(calls.some(call => call.init?.method === 'POST' && call.url === '/api/agent/triage/revshell%3A1'));
  assert.equal(text(button), '排队中');
  assert.equal(button.disabled, true);
});

// ---------- 队列条 ----------

test('队列条：计数与输入模式来自 /api/agent/triage/status；点开关 PUT control 并换文案', async () => {
  const { host, calls } = mount({
    handler: (url, init) => (url === '/api/agent/triage/control' && init?.method === 'PUT'
      ? respond({ ...SUMMARY, enabled: false })
      : null),
  });
  await flush();

  assert.equal(text(host.querySelector('[data-role="qmode"]')), 'Syslog 推入');
  assert.equal(text(host.querySelector('[data-role="qc-queued"]')), '2');
  assert.equal(text(host.querySelector('[data-role="qc-running"]')), '1');
  assert.equal(text(host.querySelector('[data-role="qc-done"]')), '9');
  assert.equal(text(host.querySelector('[data-role="qc-failed"]')), '1');

  buttonByName(host, '暂停').dispatchEvent(new dom.window.Event('click'));
  await flush();

  const put = calls.find(call => call.init?.method === 'PUT');
  assert.equal(put.url, '/api/agent/triage/control');
  assert.deepEqual(JSON.parse(put.init.body), { enabled: false });
  assert.equal(text(host.querySelector('[data-role="qstate"]')), '自动研判 已暂停');
  assert.ok(buttonByName(host, '恢复'));
});

test('队列条：状态接口挂了只降级这一条，列表照常显示，不拿 0 充数', async () => {
  const { host } = mount({ summaryStatus: 503 });
  await flush();

  assert.equal(rows(host).length, 1, '列表不受影响');
  assert.equal(text(host.querySelector('[data-role="qstate"]')), '自动研判 状态不可用');
  assert.equal(text(host.querySelector('[data-role="qc-queued"]')), '—');
  assert.equal(host.querySelector('[data-role="queue-toggle"]').hidden, true);
  const note = host.querySelector('[data-role="qerror"]');
  assert.equal(note.hidden, false);
  assert.match(text(note), /队列状态读取失败/);
});

// ---------- 复制与纯函数 ----------

test('复制告警 ID：环境不支持剪贴板时降级为提示，不抛异常', async () => {
  const { host } = mount();
  await flush();
  host.querySelector('.cell-title').dispatchEvent(new dom.window.Event('click'));

  host.querySelector('[data-role="copy-id"]').dispatchEvent(new dom.window.Event('click'));
  await flush();
  assert.match(text(host.querySelector('[data-role="sr-status"]')), /复制失败，请手动选择 revshell:1/);
});

test('formatTime：ISO 转本地 YYYY-MM-DD HH:MM:SS；空值/非法值给「—」', () => {
  assert.match(formatTime('2026-11-17T01:02:03.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatTime(null), '—');
  assert.equal(formatTime(''), '—');
  assert.equal(formatTime('不是时间'), '—');
});

test('triageStatusOf / verdictOf：只认接口的枚举，别的一律回落', () => {
  assert.equal(triageStatusOf({ triage: null }), 'not_queued');
  assert.equal(triageStatusOf({ triage: { status: 'queued' } }), 'queued');
  assert.equal(triageStatusOf({ triage: { status: '乱写' } }), 'not_queued');

  assert.equal(verdictOf({ triage: { verdict_label: '真实威胁' } }), '真实威胁');
  assert.equal(verdictOf({ triage: { verdict_label: null } }), null);
  assert.equal(verdictOf({ triage: null, verdict: '待研判' }), null, 'alert.verdict 是占位值，不当结论');
});
