// 页面：告警详情（P002-T004）
//
// 结构照设计稿 `design/alert-detail.html`（左侧导航 + 52px 顶栏由壳提供，本文件只写内容区），
// 字段与操作全部来自本仓接口（adapter 在 `web/src/alert-detail.js`，页面里没有 fetch）。
//
// 稿上有、接口没有 → 藏掉并记进 topics/backend-findings.md（A2），逐条：
//   1) 页内顶栏（← 告警列表 / 告警 ID / 复制 / 刷新 / 主题）→ 前四项挪进内容区首行（顶栏属壳，本卡 forbidden），
//      主题切换已在壳的 bar-right 里，不重复造。
//   2) 概况条「依据通过 claimsPassed/claimsTotal」→ 接口没有通过数/总数，只有 verdict.claims[] 与 validation.ok。
//   3) 概况条「证据缺口 validation.gaps」→ 没有 gaps 字段，用 missing_evidence.length。
//   4) 依据条目的「已证实 / 存疑」徽标 → claims[] 只有 text + citations[]，不编状态；改画引用的 evidence_id。
//   5) 步骤的工具名与耗时 → steps[] 元素只有 { stage, detail, at }。
//   6) 证据来源的分类分组与事实文本 → 接口只有数量 + evidence[]（evidence_id / tool / fetched_at）。
//   7) 核验的「证据覆盖 / 核验时间」、复核的「复核人 / 时间 / 结论 / 备注」→ review 是模型独立复核，
//      没有人工复核字段；只画 assessment / concerns / missing_evidence。
//   8) 稿的「ID 不存在」页 → 接口没有 404：未知事件 ID 走 502；只有 400（ID/类型无效）按「没有这条告警」处理。
//   9) 场景行（稿映射 scenario）与「类型」重复，不单列。
//
// 六格状态：loading / empty（未研判）/ partial（研判记录读不到）/ error（告警本体读不到）/ long-content / disabled。

import {
  AlertDetailError,
  enqueueTriage,
  getAlert,
  getInvestigation,
  getTraceBoard,
  getTriageRecord,
} from '../src/alert-detail.js';

const STYLE_HREF = 'assets/pages/alert-detail.css';

/** 研判状态中文（openapi.yaml:800-816 的五值枚举，不新增取值） */
export const TRIAGE_LABEL = {
  not_queued: '未入队', queued: '排队中', running: '研判中', done: '已完成', failed: '研判失败',
};
const TRIAGE_ACTIVE = new Set(['queued', 'running']);
/** 等级色点：稿只有高危/中危/低危三档，critical 与 high 同用危险色（同 P002-T003） */
const LEVEL_CLASS = { low: 'is-low', medium: 'is-mid', high: 'is-high', critical: 'is-high' };
const VERDICT_CLASS = { 真实威胁: 'is-threat', 存疑: 'is-uncertain', 误报: 'is-false' };
const MODE_LABEL = { triage: '常规研判', deep: '深度研判' };
/** 必查证据的五值状态（required-evidence.js:120-140）。稿的二值「已具备/缺失」压不平这五种，照实写 */
const REQUIRED_STATUS = {
  records_returned: { text: '已取到记录', tone: 'ok' },
  empty_page: { text: '本页无记录', tone: 'missing' },
  source_unavailable: { text: '工具未接入', tone: 'missing' },
  missing_identifier: { text: '缺查询标识', tone: 'missing' },
  query_failed: { text: '查询失败', tone: 'missing' },
};
/** 独立复核的三种结论（investigation-agent.js:449-455） */
const REVIEW_LABEL = { supported: '支持原结论', needs_revision: '要求修订', unavailable: '未完成' };
/** 溯源白板节点的 kind → 中文；未登记的类型原样显示（trace-board.js:74-77 的 kind 是自由字符串） */
const ENTITY_LABEL = { asset: '资产', external_ip: '外部 IP' };

const TEMPLATE = `
<div class="detail-page">
  <div class="detail-tools">
    <a class="back" href="#/alerts">← 告警列表</a>
    <span class="sep-v" aria-hidden="true"></span>
    <span class="crumb mono" data-role="crumb">—</span>
    <div class="tools-right">
      <button type="button" class="textbtn" data-role="copy" disabled>复制告警 ID</button>
      <span class="sep-v" aria-hidden="true"></span>
      <button type="button" class="textbtn" data-role="refresh">
        <svg class="od-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <path d="M13.4 2.6v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        刷新
      </button>
    </div>
  </div>

  <p class="action-note" data-role="note" role="status" aria-live="polite"></p>

  <p class="detail-loading" data-role="loading">
    <span class="spinner" aria-hidden="true"></span>正在读取告警…
  </p>

  <div class="detail-error" data-role="error" role="alert" hidden>
    <h2 data-role="error-title">—</h2>
    <p data-role="error-detail">—</p>
    <button type="button" class="textbtn" data-role="retry">重试</button>
  </div>

  <div class="not-found" data-role="not-found" hidden>
    <h2>没有找到这条告警</h2>
    <p data-role="not-found-detail">链接里的告警 ID 不在当前数据中，可能已被清理或 ID 写错。</p>
    <a class="textbtn" href="#/alerts">返回告警列表</a>
  </div>

  <div data-role="main" hidden>
    <header class="head">
      <div class="head-top">
        <div class="head-tags">
          <span class="level" data-role="level">—</span>
          <span class="head-type" data-role="type">—</span>
          <span class="state" data-role="state">—</span>
        </div>
        <div class="head-actions">
          <button type="button" class="btn-primary" data-role="queue">加入研判队列</button>
          <a class="textbtn" data-role="trace" href="#/trace">深度溯源</a>
        </div>
      </div>
      <h2 class="head-title" data-role="title">—</h2>
      <div class="head-meta" data-role="meta"></div>

      <dl class="stats" aria-label="研判概况">
        <div class="stat"><dt class="stat-label">已验证事实</dt><dd class="stat-value" data-role="stat-facts">—</dd></div>
        <div class="stat"><dt class="stat-label">证据来源</dt><dd class="stat-value" data-role="stat-sources">—</dd></div>
        <div class="stat"><dt class="stat-label">依据通过</dt><dd class="stat-value" data-role="stat-claims">—</dd></div>
        <div class="stat"><dt class="stat-label">证据缺口</dt><dd class="stat-value" data-role="stat-gaps">—</dd></div>
        <div class="stat"><dt class="stat-label">任务状态</dt><dd class="stat-value stat-text" data-role="stat-status">—</dd></div>
        <div class="stat"><dt class="stat-label">研判模式</dt><dd class="stat-value stat-text" data-role="stat-mode">—</dd></div>
      </dl>
    </header>

    <div class="body">
      <div class="col-main">
        <section class="block" aria-labelledby="ad-verdict-label">
          <h2 class="block-label" id="ad-verdict-label">研判结论</h2>
          <p class="verdict" data-role="verdict">—</p>
          <p class="summary" data-role="summary" hidden></p>
          <p class="report" data-role="report" hidden></p>
          <p class="side-note" data-role="verdict-note" hidden></p>
        </section>

        <section class="block" data-role="claims-block" aria-labelledby="ad-claims-label" hidden>
          <h2 class="block-label" id="ad-claims-label">结论依据<span class="meta" data-role="claims-meta"></span></h2>
          <ol class="claims" data-role="claims"></ol>
        </section>

        <section class="block" data-role="gap-block" aria-label="证据缺口" hidden>
          <div class="split">
            <div data-role="missing-wrap">
              <h2 class="block-label">缺失证据</h2>
              <ul class="missing" data-role="missing"></ul>
            </div>
            <div data-role="required-wrap">
              <h2 class="block-label">所需证据<span class="meta" data-role="required-meta"></span></h2>
              <ul class="checklist" data-role="required"></ul>
            </div>
          </div>
        </section>
      </div>

      <div class="col-side">
        <section class="block" data-role="steps-block" aria-labelledby="ad-steps-label">
          <h2 class="block-label" id="ad-steps-label">研判步骤</h2>
          <ol class="steps" data-role="steps"></ol>
          <p class="side-note" data-role="steps-note" hidden></p>
        </section>

        <section class="block" data-role="evidence-block" aria-labelledby="ad-evidence-label" hidden>
          <h2 class="block-label" id="ad-evidence-label">证据来源<span class="meta" data-role="evidence-meta"></span></h2>
          <ul class="ev-list" data-role="evidence"></ul>
          <p class="side-note" data-role="evidence-note" hidden></p>
        </section>
      </div>

      <section class="block block-wide" data-role="review-block" aria-labelledby="ad-review-label">
        <h2 class="block-label" id="ad-review-label">核验与复核<span class="meta" data-role="review-meta"></span></h2>
        <div class="review-grid">
          <dl class="kv" data-role="validation"></dl>
          <div>
            <dl class="kv" data-role="review-kv"></dl>
            <p class="review-note" data-role="review-note" hidden></p>
          </div>
        </div>
      </section>

      <section class="block block-wide" data-role="entities-block" aria-labelledby="ad-entities-label" hidden>
        <h2 class="block-label" id="ad-entities-label">关联实体<span class="meta" data-role="entities-meta"></span></h2>
        <ul class="entities" data-role="entities"></ul>
      </section>

      <details class="block block-wide raw-block" data-role="raw">
        <summary><h2 class="block-label">原始事件<span class="raw-hint">展开</span></h2></summary>
        <div data-role="detail"></div>
        <details class="json">
          <summary>原始 JSON</summary>
          <pre data-role="json"></pre>
        </details>
      </details>
    </div>
  </div>
</div>`;

/** 本页样式只在第一次 render 时注入一次（web/index.html 与 app.css 不归本卡）。 */
function ensureStyles(document) {
  if (document.querySelector('link[data-page-style="alert-detail"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pageStyle = 'alert-detail';
  document.head.append(link);
}

const pad2 = value => String(value).padStart(2, '0');

/** ISO → `YYYY-MM-DD HH:MM:SS`（本地时区）；空值或非法时间显示「—」（照稿） */
export function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** ISO → `HH:MM:SS`（步骤时间，照稿只到时分秒） */
export function formatClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 研判状态中文；不在五值枚举里的一律当「未入队」（接口是唯一取值来源） */
export function triageLabelOf(triage) {
  const status = triage?.status;
  return Object.hasOwn(TRIAGE_LABEL, status) ? TRIAGE_LABEL[status] : TRIAGE_LABEL.not_queued;
}

/** 结论只认 verdict_label（三值枚举）；没有就 null，不拿 alert.verdict 顶上（那是恒为「待研判」的占位值） */
export function verdictLabelOf(triage, investigation) {
  const label = triage?.verdict_label ?? investigation?.verdict?.verdict_label;
  return label === '真实威胁' || label === '存疑' || label === '误报' ? label : null;
}

/** 证据缺口：优先研判记录里的 missing_evidence，其次研判结果里的（两者都是字符串数组） */
export function missingEvidenceOf(triage, investigation) {
  const list = triage?.missing_evidence ?? investigation?.verdict?.missing_evidence;
  return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim()) : [];
}

/** 结论依据：claims[] 元素 { text, citations[{ evidence_id }] }；引用编号去重后给页面画 */
export function claimsOf(investigation) {
  const claims = investigation?.verdict?.claims;
  if (!Array.isArray(claims)) return [];
  return claims
    .filter(claim => claim && typeof claim === 'object' && typeof claim.text === 'string' && claim.text.trim())
    .map(claim => {
      const refs = Array.isArray(claim.citations)
        ? [...new Set(claim.citations.map(cite => cite?.evidence_id).filter(id => typeof id === 'string' && id))]
        : [];
      return { text: claim.text, refs };
    });
}

/** 所需证据：五值 status 原样映射成中文 + 语气（ok / missing），reason 进 title */
export function requiredEvidenceOf(investigation) {
  const checks = investigation?.required_evidence;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter(check => check && typeof check === 'object')
    .map(check => {
      const known = REQUIRED_STATUS[check.status];
      const label = typeof check.label === 'string' && check.label ? check.label : (check.id ?? '—');
      const note = [check.scope, check.reason].filter(part => typeof part === 'string' && part).join(' · ');
      return {
        label,
        text: known?.text ?? (typeof check.status === 'string' ? check.status : '—'),
        tone: known?.tone ?? 'missing',
        note,
      };
    });
}

/** 溯源白板节点 → 关联实体行；kind 未登记的照原文显示 */
export function entityOf(node) {
  const kind = typeof node?.kind === 'string' ? node.kind : '';
  const value = node?.label ?? node?.address ?? node?.id;
  return {
    type: ENTITY_LABEL[kind] ?? (kind || '—'),
    value: typeof value === 'string' && value ? value : '—',
  };
}

/** 步骤：steps[] 元素 { stage, detail, at }（triage-monitor.js:343、:356），没有工具名与耗时 */
export function stepsOf(triage) {
  const steps = triage?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter(step => step && typeof step === 'object')
    .map(step => ({
      time: formatClock(step.at),
      title: typeof step.stage === 'string' && step.stage ? step.stage : '—',
      detail: typeof step.detail === 'string' ? step.detail : '',
    }));
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

/** 路由参数 → 告警 ID（详情入口 `#/alert-detail/revshell%3A1`；router.js 只按 / 切段不 decode） */
function alertIdFrom(params = []) {
  const raw = params[0];
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 挂载告警详情页。
 * @param {string[]} params 路由参数，params[0] = 告警 ID（URL 编码过）
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, now?: () => Date }} [options] 单测注入用
 * @returns {HTMLElement} 交给壳放进内容槽
 */
export function mountAlertDetailPage(params = [], options = {}) {
  const document = globalThis.document;
  ensureStyles(document);

  const host = document.createElement('div');
  host.className = 'detail-host';
  host.innerHTML = TEMPLATE;
  const $ = role => host.querySelector(`[data-role="${role}"]`);
  const request = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl };
  const alertId = alertIdFrom(params);

  const state = {
    phase: 'loading', // loading | ready | error | not_found
    error: null,
    alert: null,
    detail: {},
    triage: null,
    triageError: null,
    investigation: null,
    investigationError: null,
    board: null,
    busy: false,
    note: '',
  };

  // ---------- 渲染 ----------

  function note(message) {
    state.note = message;
    $('note').textContent = message;
  }

  function describeError(error) {
    if (error instanceof AlertDetailError) {
      if (error.kind === 'unauthorized') return { title: '登录已失效', detail: '账号或密码不再有效，请重新登录后再打开告警。' };
      if (error.kind === 'unavailable') return { title: '告警接口不可用', detail: '服务端尚未配置牧云接口，取不到这条告警。' };
      if (error.kind === 'network') return { title: '无法连接', detail: '连不上研判服务，请检查网络或稍后重试。' };
      if (error.kind === 'http') return { title: '服务返回异常', detail: `告警接口返回 ${error.status ?? '未知状态码'}，请稍后重试。` };
      return { title: '返回格式异常', detail: '告警接口返回的内容不是约定结构，请联系维护人员。' };
    }
    return { title: '加载失败', detail: error?.message ?? '未知错误' };
  }

  function paintShell() {
    $('loading').hidden = state.phase !== 'loading';
    $('error').hidden = state.phase !== 'error';
    $('not-found').hidden = state.phase !== 'not_found';
    $('main').hidden = state.phase !== 'ready';
    $('refresh').disabled = state.phase === 'loading';
    $('copy').disabled = state.phase !== 'ready';

    if (state.phase === 'error') {
      const info = describeError(state.error);
      $('error-title').textContent = info.title;
      $('error-detail').textContent = info.detail;
    }
    $('crumb').textContent = alertId || '—';
  }

  function paintHead() {
    const alert = state.alert ?? {};
    const level = $('level');
    level.textContent = alert.level ?? '—';
    level.className = `level ${LEVEL_CLASS[alert.levelKey] ?? ''}`.trim();

    $('type').textContent = alert.scenario ?? alert.eventType ?? '—';

    const status = state.triage?.status;
    const stateEl = $('state');
    // 研判记录读不到时不猜状态（不是「未入队」）：照实说读不到
    stateEl.textContent = state.triageError ? '状态读取失败' : triageLabelOf(state.triage);
    stateEl.className = `state${TRIAGE_ACTIVE.has(status) ? ' is-queued' : ''}`;

    $('title').textContent = alert.title ?? '（无标题）';

    const meta = [];
    if (alert.asset) meta.push({ text: alert.asset });
    if (alert.assetIp) meta.push({ text: alert.assetIp, mono: true });
    meta.push({ text: formatTime(alert.createdAt), mono: true });
    if (Number.isSafeInteger(alert.eventId)) meta.push({ text: `#${alert.eventId}`, mono: true });
    if (Number.isSafeInteger(alert.hostId)) meta.push({ text: `#${alert.hostId}`, mono: true });
    // Syslog 案件 ID（triage.alert_id）只在与本告警 ID 不同时才显示——相同就是牧云事件自己
    const caseId = state.triage?.alert_id;
    if (typeof caseId === 'string' && caseId && caseId !== alert.id) meta.push({ text: caseId, mono: true });

    const metaHost = $('meta');
    metaHost.replaceChildren(...meta.flatMap((item, index) => {
      const node = el(document, 'span', { class: item.mono ? 'mono' : '', text: item.text });
      return index === 0 ? [node] : [el(document, 'span', { class: 'dot', 'aria-hidden': 'true' }), node];
    }));

    // 深度溯源：真链接，参数从第二段起传（router.js:38-46；trace 页 T005 读 params[0]）
    $('trace').href = `#/trace/${encodeURIComponent(alert.id ?? '')}`;

    const button = $('queue');
    if (state.triageError) {
      // 状态未知时不提交：后端会把在跑的任务重排，不能凭猜发这一下
      button.textContent = '研判状态未知';
      button.disabled = true;
    } else if (TRIAGE_ACTIVE.has(status)) {
      button.textContent = '已在队列中';
      button.disabled = true;
    } else {
      button.textContent = status === 'done' || status === 'failed' ? '重新研判' : '加入研判队列';
      button.disabled = state.busy;
    }
  }

  function paintStats() {
    const triage = state.triage;
    const investigation = state.investigation;
    const facts = triage?.verified_facts;
    const sources = triage?.evidence_sources;
    $('stat-facts').textContent = Number.isSafeInteger(facts) ? String(facts) : '—';
    $('stat-sources').textContent = Number.isSafeInteger(sources) ? String(sources) : '—';

    const claims = claimsOf(investigation);
    const claimsCell = $('stat-claims');
    if (claims.length) {
      const failed = investigation?.validation?.ok === false;
      claimsCell.textContent = failed ? `${claims.length} · 未通过校验` : String(claims.length);
      claimsCell.className = `stat-value${failed ? ' stat-text' : ''}`;
      claimsCell.title = failed ? '结论引用校验未通过，见「核验与复核」' : '已引用证据的依据条数';
    } else {
      claimsCell.textContent = '—';
      claimsCell.className = 'stat-value';
      claimsCell.removeAttribute('title');
    }

    // 缺口数只在接口真的给了 missing_evidence 时才算：字段缺席不是「0 个缺口」
    const gapsRaw = state.triage?.missing_evidence ?? state.investigation?.verdict?.missing_evidence;
    $('stat-gaps').textContent = Array.isArray(gapsRaw) ? String(missingEvidenceOf(state.triage, investigation).length) : '—';
    $('stat-status').textContent = state.triageError ? '读取失败' : triageLabelOf(triage);
    $('stat-mode').textContent = MODE_LABEL[investigation?.mode] ?? '—';
  }

  function paintVerdict() {
    const label = verdictLabelOf(state.triage, state.investigation);
    const verdict = $('verdict');
    verdict.textContent = label ?? '待研判';
    verdict.className = `verdict ${VERDICT_CLASS[label] ?? 'is-pending'}`;

    const summary = state.investigation?.verdict?.summary;
    const summaryEl = $('summary');
    summaryEl.hidden = typeof summary !== 'string' || !summary.trim();
    summaryEl.textContent = summaryEl.hidden ? '' : summary;

    const report = state.triage?.report ?? state.investigation?.verdict?.report;
    const reportEl = $('report');
    reportEl.hidden = typeof report !== 'string' || !report.trim();
    reportEl.textContent = reportEl.hidden ? '' : report;

    const noteEl = $('verdict-note');
    // 结论标签有就画；「暂无结论」只在确实没有标签时出现——
    // 本轮研判失败但上一次的研判结果还存着时，页面上会同时有结论与「研判失败」的任务状态，两句话不打架
    const triageFailed = state.triage?.status === 'failed';
    noteEl.hidden = Boolean(label);
    if (noteEl.hidden) noteEl.textContent = '';
    else noteEl.textContent = triageFailed ? '研判失败，暂无结论。' : '这条告警还没有研判结论。';
  }

  function paintClaims() {
    const claims = claimsOf(state.investigation);
    const block = $('claims-block');
    block.hidden = claims.length === 0;
    if (!claims.length) return;

    const failed = state.investigation?.validation?.ok === false;
    $('claims-meta').textContent = `${claims.length} 条${failed ? ' · 校验未通过' : ''}`;
    $('claims').replaceChildren(...claims.map((claim, index) => el(document, 'li', { class: 'claim' }, [
      el(document, 'span', { class: 'claim-idx mono', text: pad2(index + 1) }),
      el(document, 'span', {}, [
        el(document, 'span', { class: 'claim-text', text: claim.text }),
        el(document, 'span', { class: 'claim-meta' }, [
          el(document, 'span', { class: `claim-state ${claim.refs.length ? 'is-confirmed' : 'is-plain'}`, text: claim.refs.length ? `引用 ${claim.refs.length} 处证据` : '未引用证据' }),
          claim.refs.length
            ? el(document, 'span', { class: 'claim-ref mono', text: claim.refs.slice(0, 4).join(' · ') + (claim.refs.length > 4 ? ' …' : '') })
            : null,
        ]),
      ]),
    ])));
  }

  function paintGaps() {
    const missing = missingEvidenceOf(state.triage, state.investigation);
    const required = requiredEvidenceOf(state.investigation);
    const block = $('gap-block');
    block.hidden = missing.length === 0 && required.length === 0;
    if (block.hidden) return;

    $('missing-wrap').hidden = missing.length === 0;
    $('missing').replaceChildren(...missing.map(text => el(document, 'li', { text })));

    $('required-wrap').hidden = required.length === 0;
    if (required.length) {
      const ok = required.filter(item => item.tone === 'ok').length;
      $('required-meta').textContent = `${ok} / ${required.length} 已取到`;
      $('required').replaceChildren(...required.map(item => {
        const li = el(document, 'li', { class: 'check-item' }, [
          el(document, 'span', { class: 'check-name', text: item.label }),
          el(document, 'span', { class: `check-state ${item.tone}`, text: item.text }),
        ]);
        if (item.note) li.title = item.note;
        return li;
      }));
    }
  }

  function paintSteps() {
    const steps = stepsOf(state.triage);
    const list = $('steps');
    const noteEl = $('steps-note');
    list.replaceChildren(...steps.map(step => el(document, 'li', { class: 'step' }, [
      el(document, 'span', { class: 'step-dot', 'aria-hidden': 'true' }),
      el(document, 'span', {}, [
        el(document, 'span', { class: 'step-head' }, [el(document, 'span', { class: 'step-title', text: step.title })]),
        el(document, 'span', { class: 'step-result', text: step.detail }),
      ]),
      el(document, 'span', { class: 'step-time mono' }, [el(document, 'b', { text: step.time })]),
    ])));

    noteEl.hidden = steps.length > 0;
    if (noteEl.hidden) {
      noteEl.textContent = '';
    } else if (state.triageError) {
      noteEl.textContent = `研判记录读取失败：${state.triageError}`;
    } else {
      noteEl.textContent = TRIAGE_ACTIVE.has(state.triage?.status)
        ? '研判进行中，步骤会随任务进度出现。'
        : '还没有研判步骤。加入队列后这里会出现模型的执行记录。';
    }
  }

  function paintEvidence() {
    const evidence = Array.isArray(state.investigation?.evidence) ? state.investigation.evidence : [];
    const count = state.triage?.evidence_sources;
    const block = $('evidence-block');
    block.hidden = evidence.length === 0 && !Number.isSafeInteger(count);
    if (block.hidden) return;

    // 计数用研判记录里的 evidence_sources；读不到时退回「列出来的条目数」，不写「暂无」又不给列表
    const shownCount = Number.isSafeInteger(count) ? count : evidence.length;
    $('evidence-meta').textContent = `${shownCount} 个来源`;
    $('evidence').replaceChildren(...evidence
      .filter(item => item && typeof item === 'object')
      .map(item => el(document, 'li', { class: 'ev-item' }, [
        el(document, 'span', { class: 'ev-id mono', text: item.evidence_id ?? '—' }),
        el(document, 'span', { class: 'ev-fact', text: typeof item.tool === 'string' ? item.tool : '—' }),
        el(document, 'span', { class: 'ev-time mono', text: formatClock(item.fetched_at) }),
      ])));

    const noteEl = $('evidence-note');
    noteEl.hidden = evidence.length > 0;
    noteEl.textContent = noteEl.hidden ? '' : '接口只返回来源数量，没有条目明细。';
  }

  function paintReview() {
    const validation = state.investigation?.validation;
    const review = state.investigation?.review;
    const validationList = $('validation');
    const reviewList = $('review-kv');
    const noteEl = $('review-note');
    const metaEl = $('review-meta');

    if (!validation && !review) {
      metaEl.textContent = state.investigationError ? '核验记录读取失败' : '尚未核验';
      validationList.replaceChildren();
      reviewList.replaceChildren();
      noteEl.hidden = false;
      noteEl.textContent = state.investigationError
        ? `研判结果读取失败：${state.investigationError}`
        : '该告警尚未进入研判流程，暂时没有核验与复核记录。';
      return;
    }

    const validationRows = [];
    if (validation) {
      validationRows.push(['引用校验', validation.ok === true ? '通过' : '未通过']);
      const errors = Array.isArray(validation.errors) ? validation.errors : [];
      if (validation.ok !== true) validationRows.push(['校验错误', `${errors.length} 条`]);
      if (Object.hasOwn(validation, 'removed_unverified_facts')) {
        validationRows.push(['移除未核验事实', validation.removed_unverified_facts ? '是' : '否']);
      }
    }
    validationList.replaceChildren(...validationRows.map(([key, value]) => el(document, 'div', { class: 'kv-row' }, [
      el(document, 'dt', { text: key }),
      el(document, 'dd', { text: value }),
    ])));
    if (validation && Array.isArray(validation.errors) && validation.errors.length) {
      validationList.title = validation.errors.join('；');
    }

    const reviewRows = [];
    if (review) {
      reviewRows.push(['独立复核', REVIEW_LABEL[review.assessment] ?? (typeof review.assessment === 'string' ? review.assessment : '—')]);
      const concerns = Array.isArray(review.concerns) ? review.concerns.filter(item => typeof item === 'string' && item) : [];
      const reviewGaps = Array.isArray(review.missing_evidence) ? review.missing_evidence.filter(item => typeof item === 'string' && item) : [];
      reviewRows.push(['复核意见', concerns.length ? concerns.join('；') : '—']);
      if (reviewGaps.length) reviewRows.push(['复核缺口', reviewGaps.join('；')]);
    }
    reviewList.replaceChildren(...reviewRows.map(([key, value]) => el(document, 'div', { class: 'kv-row' }, [
      el(document, 'dt', { text: key }),
      el(document, 'dd', { text: value }),
    ])));

    metaEl.textContent = validation ? (validation.ok === true ? '引用校验通过' : '引用校验未通过') : '尚未核验';
    noteEl.hidden = reviewRows.length > 0;
    noteEl.textContent = noteEl.hidden ? '' : '尚未独立复核。';
  }

  function paintEntities() {
    const nodes = Array.isArray(state.board?.nodes) ? state.board.nodes : [];
    const block = $('entities-block');
    block.hidden = nodes.length === 0;
    if (block.hidden) return;
    $('entities-meta').textContent = `${nodes.length} 个`;
    $('entities').replaceChildren(...nodes.map(node => {
      const entity = entityOf(node);
      return el(document, 'li', { class: 'entity' }, [
        el(document, 'span', { class: 'entity-type', text: entity.type }),
        el(document, 'span', { class: 'entity-value mono', text: entity.value }),
      ]);
    }));
  }

  function paintRaw() {
    const detail = state.detail ?? {};
    const groups = [];
    const flat = [];
    for (const [key, value] of Object.entries(detail)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        groups.push(el(document, 'div', { class: 'raw-group' }, [
          el(document, 'h3', { text: key }),
          el(document, 'div', { class: 'kv-pairs' }, Object.entries(value).map(([innerKey, innerValue]) => el(
            document, 'div', { class: 'kv-pair' },
            [el(document, 'span', { class: 'kv-k', text: innerKey }), el(document, 'span', { class: 'kv-v mono', text: valueText(innerValue) })],
          ))),
        ]));
      } else {
        flat.push(el(document, 'div', { class: 'kv-pair' }, [
          el(document, 'span', { class: 'kv-k', text: key }),
          el(document, 'span', { class: 'kv-v mono', text: valueText(value) }),
        ]));
      }
    }

    const host = $('detail');
    const parts = [];
    if (flat.length) parts.push(el(document, 'div', { class: 'raw-group' }, [el(document, 'div', { class: 'kv-pairs' }, flat)]));
    parts.push(...groups);
    if (!parts.length) {
      parts.push(el(document, 'p', { class: 'side-note', text: '这条路接口没有返回原始事件字段。' }));
    }
    host.replaceChildren(...parts);
    $('json').textContent = Object.keys(detail).length ? JSON.stringify(detail, null, 2) : '{}';
  }

  function paint() {
    paintShell();
    if (state.phase !== 'ready') return;
    paintHead();
    paintStats();
    paintVerdict();
    paintClaims();
    paintGaps();
    paintSteps();
    paintEvidence();
    paintReview();
    paintEntities();
    paintRaw();
  }

  // ---------- 取数 ----------

  /** 动作（入队 / 复制）失败时的说明：与「读不到这条告警」区分开，不把读取文案套在提交上 */
  function actionErrorDetail(error) {
    if (error instanceof AlertDetailError) {
      if (error.kind === 'unauthorized') return '账号或密码不再有效，请重新登录。';
      if (error.kind === 'unavailable') return '服务端尚未配置自动研判。';
      if (error.kind === 'network') return '连不上研判服务，请检查网络或稍后重试。';
      if (error.kind === 'invalid_id') return '告警 ID 无效。';
      if (error.kind === 'http') return `服务返回 ${error.status ?? '未知状态码'}，请稍后重试。`;
      return '服务返回的内容不是约定结构，请联系维护人员。';
    }
    return error?.message ?? '未知错误';
  }

  async function loadInvestigation() {
    const triage = await getInvestigation(alertId, { mode: 'triage' }, request);
    if (triage) return triage;
    return getInvestigation(alertId, { mode: 'deep' }, request);
  }

  async function load() {
    state.phase = 'loading';
    state.error = null;
    state.triage = null;
    state.triageError = null;
    state.investigation = null;
    state.investigationError = null;
    state.board = null;
    paint();

    if (!alertId) {
      state.phase = 'not_found';
      $('not-found-detail').textContent = '链接里没有告警 ID。';
      paint();
      return;
    }

    try {
      const { alert, detail } = await getAlert(alertId, request);
      state.alert = alert;
      state.detail = detail;
      state.phase = 'ready';
    } catch (error) {
      state.error = error;
      state.alert = null;
      if (error instanceof AlertDetailError && error.kind === 'invalid_id') {
        state.phase = 'not_found';
        $('not-found-detail').textContent = `链接里的告警 ID「${alertId}」不是本仓支持的事件类型或编号。`;
      } else {
        state.phase = 'error';
      }
      paint();
      note(state.phase === 'error' ? `读取失败：${describeError(error).detail}` : '');
      return;
    }

    // 三块次要数据各自失败只影响自己那块（partial）：研判记录 / 研判结果 / 溯源白板
    const [triageResult, investigationResult, boardResult] = await Promise.allSettled([
      getTriageRecord(alertId, request),
      loadInvestigation(),
      getTraceBoard(alertId, request),
    ]);

    if (triageResult.status === 'fulfilled') state.triage = triageResult.value;
    else state.triageError = actionErrorDetail(triageResult.reason);

    if (investigationResult.status === 'fulfilled') state.investigation = investigationResult.value;
    else state.investigationError = actionErrorDetail(investigationResult.reason);

    state.board = boardResult.status === 'fulfilled' ? boardResult.value : null;

    paint();
  }

  // ---------- 事件 ----------

  $('refresh').addEventListener('click', () => { void load(); });
  $('retry').addEventListener('click', () => { void load(); });

  $('copy').addEventListener('click', async () => {
    const id = state.alert?.id ?? alertId;
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('no clipboard');
      await globalThis.navigator.clipboard.writeText(id);
      note(`已复制 ${id}`);
    } catch {
      note(`复制失败，请手动选择 ${id}`);
    }
  });

  $('queue').addEventListener('click', async () => {
    if (!state.alert || state.busy) return;
    if (TRIAGE_ACTIVE.has(state.triage?.status)) return;
    state.busy = true;
    paintHead();
    try {
      const record = await enqueueTriage(state.alert.id, request);
      state.triage = { ...(state.triage ?? {}), ...record };
      note(`已提交研判：${state.alert.id}`);
    } catch (error) {
      note(`提交失败：${actionErrorDetail(error)}`);
    } finally {
      state.busy = false;
      paint();
    }
  });

  void load();
  return host;
}

/** 原始事件里的值 → 文本：标量原样，对象/数组走 JSON（超长内容靠 CSS 换行，不截断） */
function valueText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const page = {
  id: 'alert-detail',
  title: '告警详情',
  navLabel: null,
  /**
   * @param {HTMLElement} content 内容区容器（壳提供的空 div）
   * @param {{ params: string[] }} context 路由参数（第二段起，`#/alert-detail/revshell%3A1` → `['revshell%3A1']`）
   */
  render(content, context = {}) {
    content.replaceChildren(mountAlertDetailPage(context.params ?? []));
  },
};
