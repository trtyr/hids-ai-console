// 页面：告警主列表 —— 推送进来的研判记录（P003-T015 起；D020）
//
// 主列表**不是牧云现查**：一行就是一条研判记录（`GET /api/agent/triage/cases`），
// 同一主机同窗口的重复投递合成一行、计数沿用记录上的 `repeat_count`（D008/D012）。
// 牧云现查不再是单独入口（P003-T026 / D025）：拉取是本页上的一个动作，拉到的行与研判记录分区显示，
// 拉取只读、不自动入队；要分析某一条，点该行的「送研判」显式送。主列表首屏不碰 `/api/alerts`，
// 所以牧云没配时主列表照常工作（A4）。
//
// 视觉沿用设计稿 `design/alerts.html` 的表格语言（表头吸顶、单行单元格、固定列宽、分页）。
// 稿画的是牧云告警列表（等级/告警 ID/资产/IP/研判状态/结论），D020 把主列表换成了研判记录，
// 新列（主机/重复/命中规则/维护）稿未覆盖 → 按同页最近邻取值（同一套 `.cell-*` / `.verdict` /
// `.triage` 样式与列宽口径），逐条记在 `coding-reports/P003-T015.md` 的稿→码对照表与「未决」。
//
// 稿上有、这一版没做的（同一原因：稿未覆盖研判记录列表，且 D020 没要求）：
//   1) 抽屉：摘要/步骤/证据已在详情页（`#/alert-detail/<id>`），行内直接跳过去，不复刻一份。
//   2) 批量「重新研判所选」：单条重新入队保留在状态/操作列之外由详情页发起；主列表不做多选。
//   3) 搜索框：`GET /api/agent/triage/cases` 没有关键词参数（server.js:364-382），不前端自筛。
//   4) 等级列：研判记录上没有等级字段（TriageCaseListItem 只有 msgid/主机/事件时间/命令）。
//
// 误报（A2 / D020「点误报，这一行马上变成误报，理由留着。规则改没改成，旁边另标」）：
// 点「标为误报」在行下展开理由表单（稿未覆盖，取值取同页既有表单/文本按钮样式），
// 提交走后端 `POST /api/agent/triage/{id}/false-positive`，202 回来就把这一行改成误报并显示维护状态；
// 两个维护者的进度另标在「维护」列（updating / updated / failed），不影响结论。

import {
  CasesError, fetchQueueStatus, listCases, reportFalsePositive, setQueueEnabled,
} from '../src/cases.js';
// P003-T026：牧云现查不再是单独页面，而是本页上的「拉取」动作——只读拉取 + 逐条显式送研判。
import { AlertsError, enqueueTriage, listAlerts } from '../src/alerts.js';

const STYLE_HREF = 'assets/pages/alerts.css';
const COLUMN_COUNT = 9;
const PAGE_SIZES = [20, 50];

// syslog MsgId → 事件类型（syslog-input.js:9-15 的映射表；接口只回 msgid，类型名要自己映射才筛得了）
const MSGID_TYPE = {
  'cloudwalker-webshell': 'webshell',
  'cloudwalker-honeypot': 'honeypot',
  'cloudwalker-suspicious-command': 'suspicious_operation',
  'cloudwalker-abnormal-login': 'abnormal_login',
  'cloudwalker-brute-force': 'brute_force',
  'cloudwalker-revshell': 'revshell',
  'cloudwalker-malware': 'malware',
  'cloudwalker-elevation-process': 'elevation_process',
  'cloudwalker-abnormal-network': 'network_audit',
};

// 类型中文名（稿的 TYPE_LABELS，与后端 eventTypes 一一对应）
const TYPE_LABELS = {
  webshell: '网站后门', malware: '恶意程序', revshell: '反弹 Shell', memory_webshell: '内存马',
  brute_force: '暴力破解', abnormal_login: '异常登录', elevation_process: '提权进程',
  network_audit: '网络审计', suspicious_operation: '可疑操作', honeypot: '蜜罐', memory_security: '内存安全',
};

// 类型筛选项：只列 syslog 真能映射出来的 9 类。`memory_webshell` / `memory_security` 在接口枚举里
// （openapi.yaml:1076-1077）但没有对应 MsgId（syslog-input.js:9-15），选了永远是空表，不摆出来。
const TYPE_OPTIONS = Object.entries(MSGID_TYPE)
  .map(([, type]) => type)
  .map(type => [type, TYPE_LABELS[type] ?? type]);

const TRIAGE_LABEL = { not_queued: '未研判', queued: '排队中', running: '研判中', done: '完成', failed: '失败' };
const TRIAGE_CLASS = { queued: 'is-queued', running: 'is-running', done: 'is-done', failed: 'is-failed' };
const VERDICT_CLASS = { 真实威胁: 'verdict-threat', 存疑: 'verdict-uncertain', 误报: 'verdict-false' };
const VERDICT_OPTIONS = [['threat', '真实威胁'], ['uncertain', '存疑'], ['false_positive', '误报'], ['review', '待研判']];
const MAINT_LABEL = { updating: '更新中', updated: '已更新', failed: '失败' };
const INPUT_MODE_LABEL = { syslog: 'Syslog 推入', poll: '轮询拉取' };
// 时间范围（同 demo 页的取值口径：只算 from，to 不传＝到现在）
const TIME_OPTIONS = [['24h', '近 24 小时', 24 * 60 * 60 * 1000], ['7d', '近 7 天', 7 * 24 * 60 * 60 * 1000],
  ['30d', '近 30 天', 30 * 24 * 60 * 60 * 1000]];
// 误报理由长度是服务端口径（server.js:607）；页面先自己拦一遍，别把 400 当网络错误显示
const REASON_MIN = 10;
const REASON_MAX = 4000;

const ICON_REFRESH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
const ICON_PULL = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.4v6.2M5.6 6.2 8 8.6l2.4-2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M3.2 10.2v2.2c0 .7.5 1.2 1.2 1.2h7.2c.7 0 1.2-.5 1.2-1.2v-2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>`;
const ICON_SEARCH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" />
    <path d="M10.2 10.2 13.4 13.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>`;

const TEMPLATE = `
<div class="alerts-page">
  <div class="page-tools">
    <span class="page-total">共 <b data-role="total">—</b> 条</span>
    <span class="page-stamp"><b data-role="stamp" class="mono">—</b> 更新</span>
    <button type="button" class="textbtn" data-role="refresh">
      ${ICON_REFRESH}
      刷新
    </button>
    <button type="button" class="textbtn" data-role="pull-open" aria-expanded="false" aria-controls="pull-panel">
      ${ICON_PULL}
      从牧云拉取
    </button>
  </div>

  <div class="queuestrip" data-role="queue" role="group" aria-label="自动研判队列">
    <span class="qstate" data-role="qstate"><i class="dot" aria-hidden="true"></i>自动研判 <b data-role="qstate-text">—</b></span>
    <span class="qmeta">输入 <b data-role="qmode">—</b></span>
    <span class="qcounts">
      <span>排队 <b data-role="qc-queued">—</b></span>
      <span>研判中 <b data-role="qc-running">—</b></span>
      <span>完成 <b data-role="qc-done">—</b></span>
      <span class="is-danger">失败 <b data-role="qc-failed">—</b></span>
    </span>
    <span class="qmeta" data-role="qerror" hidden></span>
    <button type="button" class="textbtn" data-role="queue-toggle">暂停</button>
  </div>

  <section class="pull-panel" data-role="pull" id="pull-panel" hidden aria-label="牧云现存告警（拉取）">
    <div class="pull-head">
      <span class="pull-title">牧云现存告警 <span class="pull-tag">拉取</span></span>
      <span class="pull-meta" data-role="pull-meta"></span>
      <span class="pull-message" data-role="pull-message" role="status" aria-live="polite"></span>
      <button type="button" class="textbtn" data-role="pull-close">收起</button>
    </div>
    <div class="pull-body" data-role="pull-body"></div>
    <div class="pull-pager">
      <button type="button" class="page-btn" data-role="pull-prev">上一页</button>
      <span class="pager-info" data-role="pull-page">—</span>
      <button type="button" class="page-btn" data-role="pull-next">下一页</button>
    </div>
  </section>

  <div class="filters" role="group" aria-label="筛选与排序">
    <div class="search">
      ${ICON_SEARCH}
      <input type="search" data-role="filter-host" placeholder="主机 IP（精确匹配）" aria-label="按主机 IP 筛选" />
    </div>

    <select data-role="filter-type" aria-label="按事件类型筛选">
      <option value="">全部类型</option>
      ${TYPE_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>

    <select data-role="filter-verdict" aria-label="按研判结论筛选">
      <option value="">全部结论</option>
      ${VERDICT_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>

    <select data-role="filter-time" aria-label="按时间范围筛选">
      <option value="">全部时间</option>
      ${TIME_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>

    <button type="button" class="textbtn" data-role="clear-filters" hidden>清除筛选</button>
    <span class="filter-count" data-role="filter-count"></span>
  </div>

  <div class="table-wrap" data-role="table-wrap">
    <table class="alerts">
      <caption class="sr-only">研判记录列表，最新在前；点「详情」看这条研判，点「溯源」进深度溯源。</caption>
      <thead>
        <tr>
          <th scope="col" class="col-verdict" data-role="th-verdict" aria-sort="none">
            <button type="button" class="th-sort" data-role="sort-verdict" data-sort="verdict">结论<span class="arrow" data-role="arrow-verdict"></span></button>
          </th>
          <th scope="col" class="col-type">类型</th>
          <th scope="col" class="col-ip">主机</th>
          <th scope="col" class="col-time" data-role="th-time" aria-sort="descending">
            <button type="button" class="th-sort" data-role="sort-time" data-sort="time">时间<span class="arrow is-active" data-role="arrow-time">↓</span></button>
          </th>
          <th scope="col" class="col-dup">重复</th>
          <th scope="col" class="col-rule">命中规则</th>
          <th scope="col" class="col-maint">维护</th>
          <th scope="col" class="col-state">状态</th>
          <th scope="col" class="col-ops">操作</th>
        </tr>
      </thead>
      <tbody data-role="rows"></tbody>
    </table>
  </div>

  <div class="pager">
    <span class="pager-info" data-role="pager-info">—</span>
    <div class="pager-btns">
      <button type="button" class="page-btn" data-role="prev-page">上一页</button>
      <span class="pager-nums" data-role="page-numbers"></span>
      <button type="button" class="page-btn" data-role="next-page">下一页</button>
    </div>
    <div class="pagesize" role="group" aria-label="每页条数">
      <span class="pagesize-label">每页</span>
      <button type="button" data-role="size-20" aria-pressed="true">20</button>
      <button type="button" data-role="size-50" aria-pressed="false">50</button>
    </div>
  </div>

  <p class="sr-only" data-role="sr-status" role="status" aria-live="polite"></p>
</div>`;

/** 本页样式只在第一次 render 时注入一次（web/index.html 与 app.css 不归本卡，见文件头）。 */
function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="alerts"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'alerts';
  document.head.append(link);
}

const pad2 = value => String(value).padStart(2, '0');

/**
 * 事件时间 → `YYYY-MM-DD HH:MM:SS`（本地时区）。
 * 接口给的是 syslog 事件时间：秒级 Unix 时间（数字或数字串），或者已经是 ISO 串（triage-monitor.js:143）。
 * 解析不出来显示「—」（照稿：空值不编时间）。
 */
export function formatEventTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  let date;
  if (typeof value === 'number' || /^\d{9,13}$/.test(String(value))) {
    const num = Number(value);
    // 13 位是毫秒（牧云个别事件给毫秒），10 位是秒
    date = new Date(num > 1e11 ? num : num * 1000);
  } else {
    date = new Date(String(value));
  }
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function stampOf(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** msgid → 事件类型键（映射表外原样给 null，不猜） */
export function typeOf(record) {
  return MSGID_TYPE[record?.msgid] ?? null;
}

/** msgid → 中文类型名；映射表外的 msgid 原样显示（不吞数据） */
export function typeLabelOf(record) {
  const type = typeOf(record);
  if (type) return TYPE_LABELS[type] ?? type;
  return typeof record?.msgid === 'string' && record.msgid ? record.msgid : '—';
}

/** 结论只读 verdict_label；未产生结论时 null（不拿 msgid / detail 顶上） */
export function verdictOf(record) {
  const label = record?.verdict_label;
  return label === '真实威胁' || label === '存疑' || label === '误报' ? label : null;
}

/** 重复次数：沿用记录上的 repeat_count（1 表示只投递过一次），别的字段不当第二口径 */
export function repeatOf(record) {
  const count = record?.repeat_count;
  return Number.isSafeInteger(count) && count >= 1 ? count : 1;
}

/** 命中规则：命中的规则 id；研判完成但没命中 → 「没有套上」；还没结论 → null */
export function ruleOf(record) {
  if (typeof record?.rule_id === 'string' && record.rule_id) return record.rule_id;
  if (record?.status === 'done') return null;
  return undefined;
}

/** 维护状态一句话（规则 / 知识库两条边各自的状态，另标在「维护」列） */
export function maintenanceText(record) {
  const maintenance = record?.maintenance;
  if (!maintenance || typeof maintenance !== 'object') return '—';
  const side = key => {
    const status = maintenance[key]?.status;
    return MAINT_LABEL[status] ?? '—';
  };
  return `规则 ${side('rule')} · 知识库 ${side('wiki')}`;
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

/**
 * 挂载告警主列表页。
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, now?: () => Date }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountAlertsPage(options = {}) {
  const document = globalThis.document;
  const now = options.now ?? (() => new Date());
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'alerts-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);

  const state = {
    count: PAGE_SIZES[0],
    offset: 0,
    cases: [],
    total: 0,
    // 筛选与排序全部下推给接口（server.js:364-382），前端不自筛
    filters: { host: '', type: '', verdict: '', time: '' },
    sort: 'time',
    phase: 'loading', // loading | ready | error
    error: null,
    summary: null,
    summaryError: null,
    updatedAt: null,
    fpIndex: -1, // 正在填误报理由的行；-1 = 没有
    // P003-T026：拉取面板与主列表互不影响；拉取失败只让这一块报错，主列表照常。
    pull: { open: false, phase: 'idle', alerts: [], total: 0, offset: 0, count: 10,
      error: null, message: null, sending: new Set() },
  };

  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };

  function announce(message) {
    const node = $('sr-status');
    if (node) node.textContent = message;
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.total / state.count));
  }

  function paintToolbar() {
    $('total').textContent = String(state.total);
    $('stamp').textContent = state.updatedAt ? stampOf(state.updatedAt) : '—';
    $('refresh').disabled = state.phase === 'loading';
  }

  function filtersActive() {
    const { host, type, verdict, time } = state.filters;
    return Boolean(host || type || verdict || time) || state.sort !== 'time';
  }

  function paintFilters() {
    $('clear-filters').hidden = !filtersActive();
    // 接口不回「未筛选总量」时的对比数——只说筛选后有几条
    $('filter-count').textContent = filtersActive() && state.phase === 'ready' ? `筛选后 ${state.total} 条` : '';
    const disabled = state.phase === 'loading';
    for (const role of ['filter-host', 'filter-type', 'filter-verdict', 'filter-time']) $(role).disabled = disabled;
  }

  /** 表头排序：接口只有 sort=time|verdict（都是固定顺序），aria-sort 只报真实方向 */
  function paintSort() {
    $('th-verdict').setAttribute('aria-sort', state.sort === 'verdict' ? 'descending' : 'none');
    $('th-time').setAttribute('aria-sort', state.sort === 'time' ? 'descending' : 'none');
    $('arrow-verdict').textContent = state.sort === 'verdict' ? '↓' : '';
    $('arrow-verdict').classList.toggle('is-active', state.sort === 'verdict');
    $('arrow-time').textContent = state.sort === 'time' ? '↓' : '';
    $('arrow-time').classList.toggle('is-active', state.sort === 'time');
  }

  function paintQueue() {
    const summary = state.summary;
    const qstate = $('qstate');
    const toggle = $('queue-toggle');
    const qerror = $('qerror');

    if (!summary) {
      // 队列状态读不到时：不假装队列在跑，也不拿 0 充数。列表本身照常（partial）
      qstate.classList.remove('is-paused');
      $('qstate-text').textContent = '状态不可用';
      $('qmode').textContent = '—';
      for (const key of ['queued', 'running', 'done', 'failed']) $(`qc-${key}`).textContent = '—';
      toggle.hidden = true;
      qerror.hidden = !state.summaryError;
      qerror.textContent = state.summaryError ? `队列状态读取失败：${state.summaryError}` : '';
      return;
    }

    toggle.hidden = false;
    qerror.hidden = true;
    const paused = summary.enabled === false;
    qstate.classList.toggle('is-paused', paused);
    $('qstate-text').textContent = paused ? '已暂停' : '运行中';
    $('qmode').textContent = INPUT_MODE_LABEL[summary.inputMode] ?? summary.inputMode ?? '—';
    toggle.textContent = paused ? '恢复' : '暂停';
    const counts = summary.counts ?? {};
    for (const key of ['queued', 'running', 'done', 'failed']) {
      $(`qc-${key}`).textContent = Number.isSafeInteger(counts[key]) ? String(counts[key]) : '—';
    }
  }

  function verdictCell(record) {
    const verdict = verdictOf(record);
    if (!verdict) return el(document, 'span', { class: 'verdict-pending', text: '待研判' });
    return el(document, 'span', { class: `verdict ${VERDICT_CLASS[verdict]}`, text: verdict });
  }

  function statusCell(record) {
    const status = Object.hasOwn(TRIAGE_LABEL, record?.status) ? record.status : 'not_queued';
    return el(document, 'span', { class: `triage ${TRIAGE_CLASS[status] ?? ''}`.trim(), text: TRIAGE_LABEL[status] });
  }

  /** 命中规则列：命中给 id；完成但没命中写「没有套上」（D020）；还没结论给「—」 */
  function ruleCell(record) {
    const rule = ruleOf(record);
    if (rule === undefined) return el(document, 'span', { class: 'verdict-pending', text: '—' });
    if (rule === null) return el(document, 'span', { class: 'rule-none', text: '没有套上' });
    return el(document, 'span', { class: 'rule-id mono od-truncate', text: rule, title: rule });
  }

  function maintCell(record) {
    const maintenance = record?.maintenance;
    const text = maintenanceText(record);
    const tone = maintenance?.status === 'failed' ? 'is-failed' : maintenance?.status === 'updating' ? 'is-updating' : '';
    return el(document, 'span', { class: `maint ${tone}`.trim(), text, title: text });
  }

  function opsCell(record, index) {
    const id = String(record?.alert_id ?? '');
    const detail = el(document, 'a', { class: 'textbtn ops-link', href: `#/alert-detail/${encodeURIComponent(id)}`, text: '详情' });
    const trace = el(document, 'a', { class: 'textbtn ops-link', href: `#/trace-board/${encodeURIComponent(id)}`, text: '溯源' });
    const canFalsePositive = record?.status === 'done' && verdictOf(record) !== '误报';
    const fp = el(document, 'button', {
      type: 'button',
      class: 'textbtn ops-link',
      text: record?.status === 'done' && verdictOf(record) === '误报' ? '已误报' : '标为误报',
      'aria-label': `把 ${id} 标为误报`,
    });
    fp.disabled = !canFalsePositive;
    if (record?.status !== 'done') fp.title = '研判还没结束，不能登记误报';
    fp.addEventListener('click', () => openFalsePositiveForm(index));
    return el(document, 'td', { class: 'col-ops' }, [detail, trace, fp]);
  }

  function rowElement(record, index) {
    const id = String(record?.alert_id ?? '');
    const hostIp = record?.host_ip || '—';
    const source = record?.source_ip || null;
    const command = record?.command || null;
    const hostTitle = [hostIp, source ? `来源 ${source}` : null, command ? `命令 ${command}` : null]
      .filter(Boolean).join(' · ');
    const time = formatEventTime(record?.event_time);

    const cells = [
      el(document, 'td', { class: 'col-verdict' }, [verdictCell(record)]),
      el(document, 'td', { class: 'col-type', text: typeLabelOf(record) }),
      el(document, 'td', { class: 'col-ip' }, [el(document, 'span', {
        class: 'cell-ip mono od-truncate', text: hostIp, title: hostTitle,
      })]),
      el(document, 'td', { class: 'col-time' }, [el(document, 'span', { class: 'cell-time', text: time, title: time })]),
      el(document, 'td', { class: 'col-dup mono', text: `×${repeatOf(record)}`, title: `重复投递 ${repeatOf(record)} 次` }),
      el(document, 'td', { class: 'col-rule' }, [ruleCell(record)]),
      el(document, 'td', { class: 'col-maint' }, [maintCell(record)]),
      el(document, 'td', { class: 'col-state' }, [statusCell(record)]),
      opsCell(record, index),
    ];
    const row = el(document, 'tr', { dataset: { index: String(index), caseId: id } }, cells);
    if (state.fpIndex === index) row.classList.add('is-open');
    return row;
  }

  /** 误报理由表单（行下展开）。稿未覆盖：取值取同页既有表单样式，交互按 D020。 */
  function falsePositiveRow(index) {
    const record = state.cases[index];
    const textarea = el(document, 'textarea', {
      class: 'fp-reason', rows: '3', maxlength: String(REASON_MAX),
      placeholder: '误报理由（10 到 4000 字）：哪里不对、依据是什么',
      'aria-label': `给 ${record?.alert_id ?? ''} 填误报理由`,
    });
    const hint = el(document, 'span', { class: 'fp-hint', text: `至少 ${REASON_MIN} 字` });
    const submit = el(document, 'button', { type: 'button', class: 'btn-primary', text: '提交误报' });
    const cancel = el(document, 'button', { type: 'button', class: 'textbtn', text: '取消' });

    const form = el(document, 'form', { class: 'fp-form', 'aria-label': '登记误报' }, [
      el(document, 'label', { class: 'fp-label', for: 'fp-reason-input' }, [document.createTextNode('误报理由')]),
      textarea, el(document, 'div', { class: 'fp-actions' }, [hint, cancel, submit]),
    ]);
    textarea.id = 'fp-reason-input';

    cancel.addEventListener('click', () => closeFalsePositiveForm());
    form.addEventListener('submit', event => { event.preventDefault(); void submitFalsePositive(index, textarea, hint, submit); });
    submit.addEventListener('click', event => {
      event.preventDefault();
      void submitFalsePositive(index, textarea, hint, submit);
    });
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeFalsePositiveForm();
      }
    });

    const cell = el(document, 'td', { colspan: String(COLUMN_COUNT) }, [form]);
    return { row: el(document, 'tr', { class: 'fp-row', dataset: { fpIndex: String(index) } }, [cell]), textarea };
  }

  async function submitFalsePositive(index, textarea, hint, submit) {
    const record = state.cases[index];
    if (!record) return;
    const reason = textarea.value.trim();
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      hint.textContent = `理由要 ${REASON_MIN} 到 ${REASON_MAX} 字`;
      hint.classList.add('is-error');
      textarea.setAttribute('aria-invalid', 'true');
      textarea.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '提交中…';
    try {
      const result = await reportFalsePositive(record.alert_id, { reason }, request);
      // 后端先写结论再回 202：这一行马上变误报，理由留在记录上（D020）
      state.cases[index] = {
        ...record,
        verdict: 'false_positive',
        verdict_label: '误报',
        feedback: result.feedback ?? { reason },
        maintenance: result.maintenance ?? record.maintenance,
        decision_source: 'human',
      };
      state.fpIndex = -1;
      paintTable();
      paintPager();
      announce(`已把 ${record.alert_id} 标成误报，理由已记录`);
    } catch (error) {
      submit.disabled = false;
      submit.textContent = '提交误报';
      hint.textContent = describeFalsePositiveError(error);
      hint.classList.add('is-error');
    }
  }

  function openFalsePositiveForm(index) {
    if (state.fpIndex === index) return;
    state.fpIndex = index;
    paintTable();
    const textarea = host.querySelector(`.fp-row[data-fp-index="${index}"] textarea`);
    if (textarea) textarea.focus();
    announce(`正在给 ${state.cases[index]?.alert_id ?? ''} 填误报理由`);
  }

  function closeFalsePositiveForm() {
    const index = state.fpIndex;
    if (index < 0) return;
    state.fpIndex = -1;
    paintTable();
    const trigger = host.querySelector(`tr[data-index="${index}"] button[aria-label*="误报"]`);
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  function messageRow(textValue, action) {
    const cell = el(document, 'td', { colspan: String(COLUMN_COUNT) }, [document.createTextNode(textValue)]);
    if (action) {
      const button = el(document, 'button', { type: 'button', class: 'textbtn', text: action.label });
      button.addEventListener('click', action.onClick);
      cell.append(button);
    }
    return el(document, 'tr', { class: 'empty-row' }, [cell]);
  }

  function paintTable() {
    const body = $('rows');
    const wrap = $('table-wrap');
    wrap.classList.toggle('is-busy', state.phase === 'loading');
    if (state.phase === 'loading') wrap.setAttribute('aria-busy', 'true');
    else wrap.removeAttribute('aria-busy');

    if (state.phase === 'loading') {
      body.replaceChildren(messageRow('正在读取研判记录…'));
      return;
    }
    if (state.phase === 'error') {
      const { title, detail } = describeError(state.error);
      const block = el(document, 'div', { class: 'page-error', role: 'alert' });
      block.append(el(document, 'strong', { text: title }), el(document, 'p', { text: detail }));
      const retry = el(document, 'button', { type: 'button', class: 'btn-primary', text: '重试' });
      retry.addEventListener('click', () => { void load(); });
      block.append(retry);
      const cell = el(document, 'td', { colspan: String(COLUMN_COUNT) }, [block]);
      body.replaceChildren(el(document, 'tr', { class: 'empty-row' }, [cell]));
      return;
    }
    if (!state.cases.length) {
      body.replaceChildren(filtersActive()
        ? messageRow('没有匹配的研判记录。', { label: '清除筛选', onClick: () => { clearFilters(); } })
        : messageRow(state.total === 0 ? '暂无研判记录。' : '本页没有记录，请回到上一页。'));
      return;
    }

    const nodes = [];
    state.cases.forEach((record, index) => {
      nodes.push(rowElement(record, index));
      if (state.fpIndex === index) {
        nodes.push(falsePositiveRow(index).row);
      }
    });
    body.replaceChildren(...nodes);
  }

  function paintPager() {
    const totalPages = pageCount();
    const start = state.cases.length ? state.offset + 1 : 0;
    const end = state.offset + state.cases.length;
    $('pager-info').textContent = `${start}–${end} / ${state.total} 条 · 共 ${totalPages} 页`;
    $('prev-page').disabled = state.offset === 0;
    $('next-page').disabled = state.offset + state.count >= state.total;

    const page = Math.floor(state.offset / state.count) + 1;
    const numbers = [];
    for (let p = 1; p <= totalPages; p += 1) {
      if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) numbers.push(p);
    }
    const nodes = [];
    let previous = 0;
    for (const p of numbers) {
      if (previous && p - previous > 1) nodes.push(el(document, 'span', { class: 'page-gap', text: '…' }));
      const button = el(document, 'button', { type: 'button', class: 'page-btn', text: String(p) });
      if (p === page) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => goToPage(p));
      nodes.push(button);
      previous = p;
    }
    $('page-numbers').replaceChildren(...nodes);

    for (const size of PAGE_SIZES) $(`size-${size}`).setAttribute('aria-pressed', String(size === state.count));
  }

  /* ---------- 牧云拉取（P003-T026 / D025）：只读拉取 + 逐条显式送研判 ---------- */

  // 拉取行与主列表分区：主列表是研判记录；这里显示牧云此刻库里的告警，拉取本身不入队。
  const PULL_STATUS_LABEL = { not_queued: '未研判', queued: '排队中', running: '研判中', done: '已完成', failed: '失败' };

  function pullStatusOf(alert) {
    const status = alert?.triage?.status;
    return Object.hasOwn(PULL_STATUS_LABEL, status) ? status : 'not_queued';
  }

  function pullNotice(textValue, action) {
    const wrap = el(document, 'div', { class: 'pull-empty' }, [document.createTextNode(textValue)]);
    if (action) {
      const button = el(document, 'button', { type: 'button', class: 'textbtn', text: action.label });
      button.addEventListener('click', action.onClick);
      wrap.append(button);
    }
    return wrap;
  }

  function pullRow(alert) {
    const id = String(alert?.id ?? '');
    const status = pullStatusOf(alert);
    const sending = state.pull.sending.has(id);
    const statusText = alert?.triage?.verdict_label || PULL_STATUS_LABEL[status];
    const send = el(document, 'button', { type: 'button', class: 'textbtn ops-link',
      text: sending ? '送入中…' : status === 'not_queued' ? '送研判' : '已入队' });
    send.disabled = sending || status !== 'not_queued';
    if (status !== 'not_queued') send.title = '这条已在研判队列里';
    send.addEventListener('click', () => { void sendPulled(alert); });
    const hostText = alert?.assetIp || alert?.asset || '—';
    const hostTitle = [alert?.asset, alert?.assetIp, alert?.source ? `来源 ${alert.source}` : null]
      .filter(Boolean).join(' · ');
    return el(document, 'tr', { dataset: { pullId: id } }, [
      el(document, 'td', { class: 'col-type', text: TYPE_LABELS[alert?.eventType] ?? alert?.eventType ?? '—' }),
      el(document, 'td', { class: 'col-ip' }, [el(document, 'span', {
        class: 'cell-ip mono od-truncate', text: hostText, title: hostTitle })],
      ),
      el(document, 'td', { class: 'col-time' }, [el(document, 'span', {
        class: 'cell-time', text: formatEventTime(alert?.createdAt), title: String(alert?.createdAt ?? '') })]),
      el(document, 'td', { class: 'col-verdict' }, [el(document, 'span', {
        class: `triage ${TRIAGE_CLASS[status] ?? ''}`.trim(), text: statusText })]),
      el(document, 'td', { class: 'col-ops' }, [send]),
    ]);
  }

  function renderPull() {
    const panel = $('pull');
    const pull = state.pull;
    panel.hidden = !pull.open;
    $('pull-open').setAttribute('aria-expanded', String(pull.open));
    if (!pull.open) return;

    const meta = $('pull-meta');
    const pageInfo = $('pull-page');
    const body = $('pull-body');
    $('pull-message').textContent = pull.message ?? '';
    const loading = pull.phase === 'loading' || pull.phase === 'idle';
    $('pull-prev').disabled = loading || pull.offset === 0;
    $('pull-next').disabled = loading || pull.offset + pull.count >= pull.total;

    if (loading) {
      meta.textContent = '正在拉取…';
      pageInfo.textContent = '—';
      body.replaceChildren(pullNotice('正在从牧云读取现存告警……'));
      return;
    }
    if (pull.phase === 'unavailable') {
      meta.textContent = '不可用';
      pageInfo.textContent = '—';
      body.replaceChildren(pullNotice('牧云尚未配置，拉取不可用。主列表不受影响。'));
      return;
    }
    if (pull.phase === 'error') {
      meta.textContent = '读取失败';
      pageInfo.textContent = '—';
      body.replaceChildren(pullNotice(`拉取失败：${pull.error?.message ?? '未知错误'}`, {
        label: '重试', onClick: () => { void loadPull(pull.offset); },
      }));
      return;
    }

    meta.textContent = `共 ${pull.total} 条 · 拉取只读，不会自动入队`;
    pageInfo.textContent = `${pull.offset + (pull.alerts.length ? 1 : 0)}–${pull.offset + pull.alerts.length} / ${pull.total} 条`;
    if (!pull.alerts.length) {
      body.replaceChildren(pullNotice('牧云当前没有告警。'));
      return;
    }
    const head = el(document, 'thead', {}, [el(document, 'tr', {}, [
      el(document, 'th', { scope: 'col', class: 'col-type', text: '类型' }),
      el(document, 'th', { scope: 'col', class: 'col-ip', text: '主机' }),
      el(document, 'th', { scope: 'col', class: 'col-time', text: '时间' }),
      el(document, 'th', { scope: 'col', class: 'col-verdict', text: '研判' }),
      el(document, 'th', { scope: 'col', class: 'col-ops', text: '操作' }),
    ])]);
    const rows = el(document, 'tbody', {}, pull.alerts.map(pullRow));
    body.replaceChildren(el(document, 'table', { class: 'alerts pull-table' }, [head, rows]));
  }

  let pullSeq = 0;
  async function loadPull(offset = state.pull.offset) {
    const seq = ++pullSeq;
    state.pull.offset = Math.max(0, offset);
    state.pull.phase = 'loading';
    state.pull.error = null;
    state.pull.message = null;
    renderPull();
    try {
      const page = await listAlerts({ count: state.pull.count, offset: state.pull.offset, sort: 'time' }, request);
      if (seq !== pullSeq) return;
      state.pull.alerts = page.alerts;
      state.pull.total = page.total;
      state.pull.phase = 'ready';
      state.pull.error = null;
      announce(`已从牧云拉取 ${page.alerts.length} 条，共 ${page.total} 条`);
    } catch (error) {
      if (seq !== pullSeq) return;
      state.pull.alerts = [];
      state.pull.total = 0;
      state.pull.error = error;
      // 503 = 牧云/自动研判没配：这一块说「不可用」，主列表照常（D020 A4）
      state.pull.phase = error instanceof AlertsError && error.kind === 'unavailable' ? 'unavailable' : 'error';
    }
    renderPull();
  }

  async function sendPulled(alert) {
    const id = String(alert?.id ?? '');
    if (!id || state.pull.sending.has(id)) return;
    state.pull.sending.add(id);
    state.pull.message = null;
    renderPull();
    try {
      // 显式送：只有点这一下才入队；拉取本身从不整批入队（D025）。
      const record = await enqueueTriage(id, request);
      alert.triage = { ...(alert.triage ?? {}), ...record };
      state.pull.message = `已把 ${id} 送进研判队列`;
      announce(`已把 ${id} 送进研判队列`);
      void load(true, true); // 主列表静默刷新，不闪骨架
    } catch (error) {
      state.pull.message = `送研判失败：${error instanceof AlertsError && error.kind === 'unavailable'
        ? '自动研判未配置' : error?.message ?? '未知错误'}`;
    } finally {
      state.pull.sending.delete(id);
      renderPull();
    }
  }

  function openPull() {
    state.pull.open = true;
    renderPull();
    if (state.pull.phase === 'idle') void loadPull(0);
  }

  function closePull() {
    state.pull.open = false;
    renderPull();
    announce('已收起牧云拉取');
  }

  function paint() {
    paintToolbar();
    paintFilters();
    paintSort();
    paintQueue();
    paintTable();
    paintPager();
    renderPull();
  }

  function describeError(error) {
    if (error instanceof CasesError) {
      if (error.kind === 'unauthorized') return { title: '登录已失效', detail: '账号或密码不再有效，请重新登录后再打开告警。' };
      if (error.kind === 'unavailable') return { title: '自动研判未配置', detail: '服务端没有启用自动研判，读不到研判记录。' };
      if (error.kind === 'invalid_id') return { title: '筛选条件无效', detail: error.message };
      if (error.kind === 'network') return { title: '无法连接', detail: '连不上研判服务，请检查网络或稍后重试。' };
      if (error.kind === 'http') return { title: '服务返回异常', detail: `研判记录接口返回 ${error.status ?? '未知状态码'}，请稍后重试。` };
      return { title: '返回格式异常', detail: '研判记录接口返回的内容不是约定结构，请联系维护人员。' };
    }
    return { title: '加载失败', detail: error?.message ?? '未知错误' };
  }

  function describeFalsePositiveError(error) {
    if (error instanceof CasesError) {
      if (error.kind === 'conflict') return '研判还没结束，不能登记误报';
      if (error.kind === 'not_found') return '找不到这条研判案件';
      if (error.kind === 'unauthorized') return '登录已失效，请重新登录';
      if (error.kind === 'unavailable') return '自动研判未配置，登记不了误报';
      if (error.kind === 'network') return '连接不上研判服务';
      return error.message;
    }
    return error?.message ?? '登记失败';
  }

  /** 时间范围 → `from`（只算 from；`to` 不传＝到现在）。每次取数时按当前时刻重算 */
  function fromOf() {
    const option = TIME_OPTIONS.find(([value]) => value === state.filters.time);
    return option ? new Date(now().getTime() - option[2]).toISOString() : undefined;
  }

  /**
   * 取一页研判记录 + 队列状态。
   * 两次请求之间记录可能变少：游标被拉回最后一页时必须跟着重拉一次，
   * 否则页脚按新 total 画、行区还是超界请求的空数组。
   * @param {boolean} [refetchOnClamp] 仅在游标真被拉回时重拉；最多一次
   * @param {boolean} [quiet] 主机逐键取数用：已有表格时不闪骨架、不禁用筛选控件（否则打到一半输入框失焦）
   */
  let loadSeq = 0;
  async function load(refetchOnClamp = true, quiet = false) {
    const seq = ++loadSeq;
    const keepRows = quiet && state.phase !== 'loading';
    if (!keepRows) state.phase = 'loading';
    state.fpIndex = -1;
    if (!keepRows) paint();
    const [casesResult, queueResult] = await Promise.allSettled([
      listCases({
        count: state.count,
        offset: state.offset,
        host: state.filters.host,
        type: state.filters.type,
        verdict: state.filters.verdict,
        from: fromOf(),
        sort: state.sort,
      }, request),
      fetchQueueStatus(request),
    ]);

    if (seq !== loadSeq) return; // 逐键取数会并发：更新的那轮已经接手，这一轮的响应作废

    if (casesResult.status === 'fulfilled') {
      state.cases = casesResult.value.cases;
      state.total = casesResult.value.total;
      state.phase = 'ready';
      state.error = null;
      state.updatedAt = now();
      const maxOffset = Math.max(0, (pageCount() - 1) * state.count);
      if (state.offset > maxOffset) {
        state.offset = maxOffset;
        if (refetchOnClamp) return load(false);
      }
    } else {
      state.phase = 'error';
      state.error = casesResult.reason;
      state.cases = [];
      state.total = 0;
    }

    // 队列读不到只让队列条显示「状态不可用」，列表照常（partial）
    if (queueResult.status === 'fulfilled') {
      state.summary = queueResult.value;
      state.summaryError = null;
    } else {
      state.summary = null;
      state.summaryError = queueResult.reason?.message ?? '未知错误';
    }

    paint();
    if (state.phase === 'ready') {
      announce(state.total ? `已载入 ${state.cases.length} 条，共 ${state.total} 条研判记录` : '暂无研判记录');
    }
  }

  function goToPage(page) {
    const maxPage = pageCount();
    const target = Math.min(Math.max(1, page), maxPage);
    if (target === Math.floor(state.offset / state.count) + 1) return;
    state.offset = (target - 1) * state.count;
    void load();
  }

  /* ---------- 筛选 / 排序 ---------- */

  function readFilters() {
    state.filters = {
      host: $('filter-host').value.trim(),
      type: $('filter-type').value,
      verdict: $('filter-verdict').value,
      time: $('filter-time').value,
    };
  }

  function onFilterChange(message) {
    readFilters();
    state.offset = 0;
    announce(message);
    void load();
  }

  function clearFilters() {
    for (const role of ['filter-host', 'filter-type', 'filter-verdict', 'filter-time']) $(role).value = '';
    state.filters = { host: '', type: '', verdict: '', time: '' };
    state.sort = 'time';
    state.offset = 0;
    $('filter-host').focus();
    announce('已清除筛选');
    void load();
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });

  // P003-T026：拉取面板开关与翻页（拉取只读；送研判在每一行的按钮上，不在这里批量入队）
  $('pull-open').addEventListener('click', () => {
    if (state.pull.open) closePull(); else openPull();
  });
  $('pull-close').addEventListener('click', closePull);
  $('pull-prev').addEventListener('click', () => {
    if (!state.pull.open || state.pull.offset === 0) return;
    void loadPull(Math.max(0, state.pull.offset - state.pull.count));
  });
  $('pull-next').addEventListener('click', () => {
    if (!state.pull.open) return;
    if (state.pull.offset + state.pull.count < state.pull.total)
      void loadPull(state.pull.offset + state.pull.count);
  });

  // 主机 IP：值一变就重取（§10.5），逐键取数。input / change / search 三道共用一个闸——
  // 值没变就不发，所以一次回车（浏览器会连发 search 与 change）只会有一轮相同请求。
  function onHostValue() {
    const value = $('filter-host').value.trim();
    if (value === state.filters.host) return;
    state.filters.host = value;
    state.offset = 0;
    void load(true, true);
  }
  for (const type of ['input', 'change', 'search']) {
    $('filter-host').addEventListener(type, onHostValue);
  }
  for (const [role, message] of [
    ['filter-type', '已按事件类型筛选'],
    ['filter-verdict', '已按研判结论筛选'],
    ['filter-time', '已按时间范围筛选'],
  ]) {
    $(role).addEventListener('change', () => onFilterChange(message));
  }
  $('clear-filters').addEventListener('click', clearFilters);

  // 表头排序：接口只有 sort=time|verdict（方向固定），同一列再点不会再变一个顺序
  for (const name of ['verdict', 'time']) {
    $(`sort-${name}`).addEventListener('click', () => {
      if (state.sort === name) return;
      state.sort = name;
      state.offset = 0;
      announce(name === 'verdict' ? '已按结论排序，真实威胁在前' : '已按时间倒序排序');
      void load();
    });
  }

  $('prev-page').addEventListener('click', () => goToPage(Math.floor(state.offset / state.count)));
  $('next-page').addEventListener('click', () => goToPage(Math.floor(state.offset / state.count) + 2));

  for (const size of PAGE_SIZES) {
    $(`size-${size}`).addEventListener('click', () => {
      if (size === state.count) return;
      state.count = size;
      state.offset = 0;
      announce(`每页 ${size} 条`);
      void load();
    });
  }

  $('queue-toggle').addEventListener('click', async () => {
    if (!state.summary) return;
    const button = $('queue-toggle');
    button.disabled = true;
    try {
      const next = await setQueueEnabled(state.summary.enabled === false, request);
      state.summary = next;
      state.summaryError = null;
      paintQueue();
      announce(next.enabled === false ? '自动研判已暂停' : '自动研判已恢复');
    } catch (error) {
      announce(`队列开关失败：${describeError(error).detail}`);
    } finally {
      button.disabled = false;
    }
  });

  host.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.fpIndex >= 0) {
      event.stopPropagation();
      closeFalsePositiveForm();
    }
  });

  void load();
  return host;
}

export const page = {
  id: 'alerts',
  title: '告警',
  navLabel: '告警',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} _context 路由参数（本页不用）
   */
  render(content, _context) {
    content.replaceChildren(mountAlertsPage());
  },
};
