// 页面：总览（设计稿 overview.html；P003-T015 起数字改走研判聚合）
//
// 只看「现在什么情况」：结论分布、事件类型构成、自动研判队列与进度、依赖状态。
// 明细与行级操作一概不在本页（overview-notes.md §1 / §3）——本页唯一的写操作是队列暂停/恢复。
//
// 数据：`web/src/status.js`（本页唯一发 HTTP 的地方），**全部来自 `GET /api/agent/triage/status`**。
// D020：数字来自研判记录，不来自牧云现查——本页不再请求 `/api/alerts`，也没有「为了有数去拉牧云」的退路（A1）。
//
// 稿未覆盖、按 D020 要求补的三处（逐条记在 coding-reports/P003-T015.md 的稿→码对照表）：
//   1. 摘要带四个数换成**结论分布**（真实威胁 / 存疑 / 误报 / 待研判，`verdict_counts`）：
//      队列的四项计数仍在「自动研判」模块与底部研判进度条里，不重复占摘要带。
//   2. 「最近轮询」在 syslog 模式改成「最后推送」显示 `last_received_at`（T010：syslog 模式没有轮询，
//      `last_poll_at` 恒为 null），轮询模式仍显示 `last_poll_at`；另加一行「Syslog 接收」
//      显示在不在听（三态：在听 / 未绑定 / 绑定失败）。
//   3. 顶栏一行加「统计范围」下拉（全部时间 / 近 24 小时 / 近 7 天 / 近 30 天），值为聚合接口的 `since`——
//      D020「一段时间里来了多少」就靠它，控件样式取同页 `.textbtn` 与告警页时间筛选的最近邻。
//
// 两处与稿的位置差异（壳禁改，见报告）：
//   1. 稿的「更新时间 + 刷新」在顶栏 `.bar-right`，壳 `web/src/views/shell.js` 不在本卡 scope
//      → 这两个控件落在内容区顶部一行（同样的 .stamp / .textbtn 样式）。
//   2. 「更新时间」是**本机时刻**：接口没有 checkedAt 字段，而稿的 stamp() 本来就是本机时钟。

import { formatClock, formatDateTime, loadOverview, setTriageEnabled } from '../src/status.js';

/** 事件类型中文名：接口只回类型 id（`type_counts` 的 key），中文名取自稿的 TYPE_LABELS（id 与后端 eventTypes 一一对应） */
const TYPE_LABELS = {
  webshell: '网站后门',
  malware: '恶意程序',
  revshell: '反弹 Shell',
  memory_webshell: '内存马',
  brute_force: '暴力破解',
  abnormal_login: '异常登录',
  elevation_process: '提权进程',
  network_audit: '网络审计',
  suspicious_operation: '可疑操作',
  honeypot: '蜜罐',
  memory_security: '内存安全',
};

/** 报错文案里的数据源名（顺序同 status.js 的 SOURCE_KEYS） */
const SOURCE_LABELS = {
  triage: '研判聚合',
  cloud: '牧云连接',
  agent: '研判模型',
  tools: '取证工具',
  rules: '规则版本',
  updates: '版本信息',
};

const STYLE_HREF = '/assets/pages/overview.css';

const ICON_REFRESH = `
  <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

// 统计范围：值 → 回看的毫秒数（null = 全部时间，不传 since）。与告警页时间筛选同一套口径。
const WINDOW_OPTIONS = [['', '全部时间', null], ['24h', '近 24 小时', 24 * 60 * 60 * 1000],
  ['7d', '近 7 天', 7 * 24 * 60 * 60 * 1000], ['30d', '近 30 天', 30 * 24 * 60 * 60 * 1000]];

const TEMPLATE = `
<div class="ov-bar">
  <p class="stamp"><b class="mono" data-role="stamp">—</b> 更新</p>
  <span class="sep-v" aria-hidden="true"></span>
  <label class="ov-window">
    <span class="ov-window-label">统计范围</span>
    <select data-role="window" aria-label="统计时间范围">
      ${WINDOW_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>
  </label>
  <span class="sep-v" aria-hidden="true"></span>
  <button type="button" class="textbtn" data-role="refresh">${ICON_REFRESH}刷新</button>
</div>

<p class="notice" data-role="notice" role="alert" hidden></p>


<section class="summary" aria-label="结论分布">
  <div class="nums">
    <dl class="num is-danger"><dt>真实威胁</dt><dd data-role="stat-threat">—</dd></dl>
    <dl class="num is-warn"><dt>存疑</dt><dd data-role="stat-uncertain">—</dd></dl>
    <dl class="num"><dt>误报</dt><dd data-role="stat-false">—</dd></dl>
    <dl class="num"><dt>待研判</dt><dd data-role="stat-review">—</dd></dl>
  </div>
  <div class="compose">
    <span class="compose-label">类型构成</span>
    <div class="compose-bar" data-role="compose" aria-hidden="true"></div>
    <p class="compose-meta" data-role="compose-meta">—</p>
  </div>
</section>

<div class="layout">
  <section aria-labelledby="ov-types-title">
    <div class="section-head">
      <h2 id="ov-types-title">事件类型</h2>
      <span class="meta" data-role="types-meta">—</span>
    </div>
    <table class="type-table">
      <caption class="sr-only">按事件类型统计的告警数量与占比</caption>
      <thead>
        <tr>
          <th scope="col">类型</th>
          <th scope="col" class="col-num">数量</th>
          <th scope="col" class="col-share">占比</th>
          <th scope="col" class="col-bar">分布</th>
        </tr>
      </thead>
      <tbody data-role="types"></tbody>
    </table>
  </section>

  <aside class="side">
    <section class="module" aria-labelledby="ov-queue-title">
      <div class="module-head">
        <h2 id="ov-queue-title">自动研判</h2>
        <button type="button" class="textbtn" data-role="queue-toggle">暂停</button>
      </div>
      <dl class="kv">
        <div class="kv-row"><dt>状态</dt><dd><span class="state" data-role="queue-state">—</span></dd></div>
        <div class="kv-row"><dt>输入方式</dt><dd data-role="queue-mode">—</dd></div>
        <div class="kv-row"><dt data-role="queue-last-label">最近轮询</dt><dd class="mono od-truncate" data-role="queue-poll">—</dd></div>
        <div class="kv-row"><dt>Syslog 接收</dt><dd data-role="queue-syslog">—</dd></div>
        <div class="kv-row is-strong"><dt>待研判</dt><dd data-role="queue-queued">—</dd></div>
        <div class="kv-row"><dt>研判中</dt><dd data-role="queue-running">—</dd></div>
        <div class="kv-row"><dt>已完成</dt><dd data-role="queue-done">—</dd></div>
        <div class="kv-row"><dt>失败</dt><dd data-role="queue-failed">—</dd></div>
        <div class="kv-row"><dt>最近错误</dt><dd class="od-truncate" data-role="queue-error">—</dd></div>
      </dl>
    </section>

    <section class="module" aria-labelledby="ov-env-title">
      <div class="module-head">
        <h2 id="ov-env-title">运行状态</h2>
        <span class="meta mono od-truncate" data-role="version">—</span>
      </div>
      <dl class="kv">
        <div class="kv-row"><dt>牧云连接</dt><dd data-role="sys-cloud">—</dd></div>
        <div class="kv-row"><dt>研判模型</dt><dd data-role="sys-agent">—</dd></div>
        <div class="kv-row"><dt>规则版本</dt><dd class="mono od-truncate" data-role="sys-rules">—</dd></div>
        <div class="kv-row"><dt>取证工具</dt><dd data-role="sys-tools">—</dd></div>
        <div class="kv-row"><dt>提示词版本</dt><dd class="mono od-truncate" data-role="sys-prompt">—</dd></div>
      </dl>
    </section>
  </aside>
</div>

<section class="progress-band" aria-label="研判进度">
  <div class="progress-head">
    <h2>研判进度</h2>
    <span class="meta" data-role="progress-meta">—</span>
  </div>
  <div class="progress-bar" data-role="progress-bar" aria-hidden="true"></div>
  <ul class="progress-legend" data-role="progress-legend"></ul>
</section>

<p class="sr-only" role="status" aria-live="polite" data-role="live"></p>
`;

const PROGRESS_SEGMENTS = [
  { key: 'done', label: '已完成' },
  { key: 'queued', label: '待研判' },
  { key: 'running', label: '研判中' },
  { key: 'failed', label: '失败' },
];

function ensureStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-page-style="overview"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'overview';
  document.head.append(link);
}

/** 只这一处用 innerHTML：TEMPLATE 是常量，不含任何接口数据 */
function mountTemplate(content) {
  const host = document.createElement('div');
  host.className = 'overview';
  host.setAttribute('aria-busy', 'true');
  host.innerHTML = TEMPLATE;
  content.replaceChildren(host);
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  return {
    host,
    stamp: $('stamp'),
    refresh: $('refresh'),
    window: $('window'),
    notice: $('notice'),
    statThreat: $('stat-threat'),
    statUncertain: $('stat-uncertain'),
    statFalse: $('stat-false'),
    statReview: $('stat-review'),
    compose: $('compose'),
    composeMeta: $('compose-meta'),
    typesMeta: $('types-meta'),
    types: $('types'),
    queueToggle: $('queue-toggle'),
    queueState: $('queue-state'),
    queueMode: $('queue-mode'),
    queuePoll: $('queue-poll'),
    queueLastLabel: $('queue-last-label'),
    queueSyslog: $('queue-syslog'),
    queueQueued: $('queue-queued'),
    queueRunning: $('queue-running'),
    queueDone: $('queue-done'),
    queueFailed: $('queue-failed'),
    queueError: $('queue-error'),
    version: $('version'),
    sysCloud: $('sys-cloud'),
    sysAgent: $('sys-agent'),
    sysRules: $('sys-rules'),
    sysTools: $('sys-tools'),
    sysPrompt: $('sys-prompt'),
    progressMeta: $('progress-meta'),
    progressBar: $('progress-bar'),
    progressLegend: $('progress-legend'),
    live: $('live'),
  };
}

const setText = (node, value) => {
  node.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
};

/** 长值：视觉截断，title 与 DOM 文本留全（长内容格不丢数据） */
const setLongText = (node, value) => {
  setText(node, value);
  if (node.textContent === '—' || node.textContent === '无') node.removeAttribute('title');
  else node.title = node.textContent;
};

/** 「最该被看见的一行」——只写 textContent，接口来的字符串不进 HTML */
function setNotice(ui, message, tone) {
  if (!message) {
    ui.notice.hidden = true;
    ui.notice.textContent = '';
    return;
  }
  ui.notice.hidden = false;
  ui.notice.textContent = message;
  ui.notice.dataset.tone = tone;
}

const KIND_TEXT = {
  unauthorized: '登录已失效，请退出后重新登录。',
  network: '连不上研判服务，请检查网络后重试。',
  invalid: '接口返回的数据格式不对，无法显示。',
};

/**
 * 出错时给人看的一句。
 * @param {{ kind?: string, status?: number|null, message?: string }} error
 */
function describeError(error) {
  if (error?.kind === 'http') return `服务返回异常（${error.status}），请稍后重试。`;
  return KIND_TEXT[error?.kind] ?? `数据读取失败：${error?.message || '未知原因'}`;
}

/**
 * type_counts → 按数量降序的类型行（接口没返回的类型不造行：空队列就是空表）。
 * @param {object} model loadOverview 的返回
 */
function typeEntries(model) {
  const triage = model?.triage;
  if (!triage?.ok) return [];
  return Object.entries(triage.typeCounts ?? {})
    .map(([key, count]) => ({ key, label: TYPE_LABELS[key] ?? key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'));
}

/** 窗口内进入队列的记录数＝四个结论档之和（聚合口径与 /api/agent/triage/cases 的 total 一致） */
function windowTotal(triage) {
  const counts = triage?.verdictCounts;
  if (!counts) return null;
  return counts.threat + counts.uncertain + counts.false_positive + counts.review;
}

function renderTypes(ui, model) {
  const entries = typeEntries(model);
  const total = model.triage.ok ? windowTotal(model.triage) : null;
  ui.typesMeta.textContent = total === null ? '—' : `${entries.length} 类 · 合计 ${total}`;

  if (!model.triage.ok) {
    ui.types.replaceChildren(emptyRow('—'));
    return;
  }
  if (!entries.length) {
    ui.types.replaceChildren(emptyRow('暂无告警数据'));
    return;
  }
  const max = entries[0].count || 1;
  const sum = entries.reduce((acc, item) => acc + item.count, 0);
  ui.types.replaceChildren(...entries.map(item => {
    const row = document.createElement('tr');
    const share = sum ? Math.round((item.count / sum) * 100) : 0;
    const width = Math.max(2, Math.round((item.count / max) * 100));

    const name = document.createElement('td');
    name.className = 'col-name';
    name.textContent = item.label;

    const count = document.createElement('td');
    count.className = 'col-num';
    count.textContent = String(item.count);

    const shareCell = document.createElement('td');
    shareCell.className = 'col-share';
    shareCell.textContent = `${share}%`;

    const barCell = document.createElement('td');
    barCell.className = 'col-bar';
    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${width}%`;
    track.append(fill);
    barCell.append(track);

    row.append(name, count, shareCell, barCell);
    return row;
  }));
}

function emptyRow(label) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.className = 'col-name';
  cell.colSpan = 4;
  cell.textContent = label;
  row.append(cell);
  return row;
}

function renderCompose(ui, model) {
  const entries = typeEntries(model);
  ui.compose.replaceChildren(...entries.map(item => {
    const max = entries[0].count || 1;
    const segment = document.createElement('span');
    segment.className = 'compose-seg';
    segment.style.flex = `${item.count} 1 0`;
    segment.style.opacity = (0.35 + (item.count / max) * 0.55).toFixed(2);
    segment.title = `${item.label} ${item.count}`;
    return segment;
  }));
  if (!model.triage.ok) ui.composeMeta.textContent = '—';
  else if (!entries.length) ui.composeMeta.textContent = '接口未返回类型统计。';
  else ui.composeMeta.textContent = entries.slice(0, 3).map(item => `${item.label} ${item.count}`).join(' · ');
}

function renderSummary(ui, model) {
  const verdicts = model.triage.ok ? model.triage.verdictCounts : null;
  setText(ui.statThreat, verdicts ? verdicts.threat : null);
  setText(ui.statUncertain, verdicts ? verdicts.uncertain : null);
  setText(ui.statFalse, verdicts ? verdicts.false_positive : null);
  setText(ui.statReview, verdicts ? verdicts.review : null);
}

/** Syslog 接收三态（openapi.yaml 的 TriageSummary.syslog）：在听 / 未绑定 / 绑定失败 */
function syslogStateText(triage) {
  if (triage.inputMode !== 'syslog') return null;
  const syslog = triage.syslog;
  if (!syslog) return '—';
  if (syslog.listening) return syslog.bind ? `在听 ${syslog.bind}` : '在听';
  if (syslog.error) return `未在听：${syslog.error}`;
  return '未绑定';
}

function renderQueue(ui, model) {
  const triage = model.triage;
  if (!triage.ok) {
    setText(ui.queueState, null);
    ui.queueState.classList.remove('is-paused');
    setText(ui.queueMode, null);
    ui.queueLastLabel.textContent = '最近轮询';
    setText(ui.queuePoll, null);
    setText(ui.queueSyslog, null);
    setText(ui.queueQueued, null);
    setText(ui.queueRunning, null);
    setText(ui.queueDone, null);
    setText(ui.queueFailed, null);
    setText(ui.queueError, null);
    ui.queueToggle.disabled = true;
    return;
  }

  const paused = !triage.enabled;
  ui.queueState.textContent = paused ? '已暂停' : '运行中';
  ui.queueState.classList.toggle('is-paused', paused);
  ui.queueToggle.textContent = paused ? '恢复' : '暂停';
  ui.queueToggle.disabled = false;
  setText(ui.queueMode, triage.inputMode === 'poll' ? '轮询拉取' : triage.inputMode === 'syslog' ? 'Syslog 推入' : null);
  // syslog 模式没有轮询（T010）：这一格改说「最后推送」，值用 last_received_at
  const syslogMode = triage.inputMode === 'syslog';
  ui.queueLastLabel.textContent = syslogMode ? '最后推送' : '最近轮询';
  setLongText(ui.queuePoll, formatDateTime(syslogMode ? triage.lastReceivedAt : triage.lastPollAt));
  setText(ui.queueSyslog, syslogStateText(triage));
  setText(ui.queueQueued, triage.counts.queued);
  setText(ui.queueRunning, triage.counts.running);
  setText(ui.queueDone, triage.counts.done);
  setText(ui.queueFailed, triage.counts.failed);
  setLongText(ui.queueError, triage.lastError ?? '无');
}

function renderSystem(ui, model) {
  const { cloud, agent, rules, tools, updates } = model.system;

  setText(ui.sysCloud, cloud.ok ? (cloud.connected ? '已连接' : '未连接') : null);
  if (cloud.ok && cloud.reason) ui.sysCloud.title = cloud.reason;
  else ui.sysCloud.removeAttribute('title');

  setText(ui.sysAgent, agent.ok ? (agent.configured ? '已就绪' : '未配置') : null);
  setLongText(ui.sysRules, rules.ok ? rules.revision : null);
  setText(ui.sysTools, tools.ok ? `${tools.count} 个` : null);
  setLongText(ui.sysPrompt, agent.ok ? agent.promptVersion : null);
  setLongText(ui.version, updates.ok ? updates.revision : null);
}

function renderProgress(ui, model) {
  const triage = model.triage;
  if (!triage.ok) {
    ui.progressMeta.textContent = '—';
    ui.progressBar.replaceChildren();
    ui.progressLegend.replaceChildren(...PROGRESS_SEGMENTS.map(item => legendItem(item, null, null)));
    return;
  }

  const { counts } = triage;
  const total = counts.done + counts.queued + counts.running + counts.failed;
  const scopeText = triage.since ? '窗口内共' : '共';
  ui.progressMeta.textContent = total
    ? `${scopeText} ${total} 个任务 · 完成率 ${Math.round((counts.done / total) * 100)}%`
    : '接口未返回队列计数。';

  ui.progressBar.replaceChildren(...PROGRESS_SEGMENTS.filter(item => counts[item.key] > 0).map(item => {
    const segment = document.createElement('span');
    segment.className = `progress-seg is-${item.key}`;
    segment.style.flex = `${counts[item.key]} 1 0`;
    return segment;
  }));
  ui.progressLegend.replaceChildren(...PROGRESS_SEGMENTS.map(item =>
    legendItem(item, counts[item.key], total ? Math.round((counts[item.key] / total) * 100) : 0)));
}

function legendItem(item, count, share) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = `dot is-${item.key}`;
  const value = document.createElement('b');
  value.textContent = count === null || count === undefined ? '—' : String(count);
  const shareText = document.createElement('span');
  shareText.className = 'share';
  shareText.textContent = share === null ? '—' : `${share}%`;
  li.append(dot, document.createTextNode(`${item.label} `), value, document.createTextNode(' '), shareText);
  return li;
}

function renderAll(ui, model) {
  ui.stamp.textContent = formatClock(model.fetchedAt);
  renderSummary(ui, model);
  renderCompose(ui, model);
  renderTypes(ui, model);
  renderQueue(ui, model);
  renderSystem(ui, model);
  renderProgress(ui, model);

  if (!model.failed.length) setNotice(ui, null);
  else setNotice(ui, `部分数据读取失败：${model.failed.map(key => SOURCE_LABELS[key] ?? key).join('、')}`, 'warn');
}

/** loading / 全失败共用：数值回到「—」，别把上一轮的数字留在屏幕上当现状 */
function renderBlank(ui) {
  for (const node of [ui.statThreat, ui.statUncertain, ui.statFalse, ui.statReview, ui.queueState, ui.queueMode,
    ui.queuePoll, ui.queueSyslog, ui.queueQueued, ui.queueRunning, ui.queueDone, ui.queueFailed, ui.queueError,
    ui.version, ui.sysCloud, ui.sysAgent, ui.sysRules, ui.sysTools, ui.sysPrompt, ui.typesMeta,
    ui.composeMeta, ui.progressMeta]) {
    setText(node, null);
  }
  ui.queueLastLabel.textContent = '最近轮询';
  ui.queueState.classList.remove('is-paused');
  ui.queueToggle.textContent = '暂停';
  ui.queueToggle.disabled = true;
  ui.compose.replaceChildren();
  ui.progressBar.replaceChildren();
  ui.progressLegend.replaceChildren();
  ui.types.replaceChildren(emptyRow('—'));
}

function setBusy(ui, busy) {
  ui.host.setAttribute('aria-busy', busy ? 'true' : 'false');
  ui.host.classList.toggle('is-busy', busy);
  ui.refresh.disabled = busy;
  ui.refresh.classList.toggle('is-loading', busy);
  ui.window.disabled = busy;
}

// 「这次 render 是否已被下一次取代」的序号。不缓存 DOM（页面模块契约：render 每次整块重画），
// 只用来丢弃晚到的响应，免得切页后旧数据写进新页面。
let renderId = 0;

export const page = {
  id: 'overview',
  title: '总览',
  navLabel: '总览',
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} _context 路由参数（本页无参数）
   */
  render(content, _context) {
    ensureStylesheet();
    const mine = ++renderId;
    const isCurrent = () => mine === renderId;

    const ui = mountTemplate(content);
    let model = null;

    const announce = message => {
      ui.live.textContent = message;
    };

    const load = async () => {
      setBusy(ui, true);
      renderBlank(ui);
      ui.refresh.disabled = true;
      announce('正在读取数据');
      try {
        const next = await loadOverview({ since: sinceOf() });
        if (!isCurrent()) return;
        model = next;
        renderAll(ui, next);
        setBusy(ui, false);
        announce(`已更新，时间 ${formatClock(next.fetchedAt)}`);
      } catch (error) {
        if (!isCurrent()) return;
        renderBlank(ui);
        setBusy(ui, false);
        const message = describeError(error);
        setNotice(ui, message, 'danger');
        announce(`数据读取失败：${message}`);
      }
    };

    // 统计范围 → 聚合起点（每次取数按当前时刻重算；空值＝全部时间，不传 since）
    const sinceOf = () => {
      const option = WINDOW_OPTIONS.find(([value]) => value === ui.window.value);
      return option?.[2] ? new Date(Date.now() - option[2]).toISOString() : null;
    };

    ui.refresh.addEventListener('click', () => {
      if (ui.refresh.disabled) return;
      load();
    });

    ui.window.addEventListener('change', () => {
      announce(ui.window.value ? `统计范围：${ui.window.selectedOptions?.[0]?.textContent ?? ui.window.value}` : '统计范围：全部时间');
      load();
    });

    ui.queueToggle.addEventListener('click', async () => {
      if (ui.queueToggle.disabled || !model?.triage.ok) return;
      const next = !model.triage.enabled;
      ui.queueToggle.disabled = true;
      announce(next ? '正在恢复自动研判' : '正在暂停自动研判');
      try {
        const summary = await setTriageEnabled(next);
        if (!isCurrent()) return;
        model = { ...model, triage: { ok: true, ...summary } };
        renderQueue(ui, model);
        renderProgress(ui, model);
        announce(summary.enabled ? '自动研判已恢复' : '自动研判已暂停');
      } catch (error) {
        if (!isCurrent()) return;
        setNotice(ui, `自动研判操作失败：${describeError(error)}`, 'danger');
        announce('自动研判操作失败');
      } finally {
        if (isCurrent()) ui.queueToggle.disabled = false;
      }
    });

    renderBlank(ui);
    load();
  },
};
