// P003-T007 前端验收 · 真浏览器端到端用例（测试席自建，不进产品代码）
//
// 跑法（在本树根目录）：node evidence/test/P003-T007/e2e-checks.mjs [--only=A1,A2] [--keep]
// 依赖：agent-browser（真 Chrome，--no-sandbox）、Node ≥ 21；不需要 npm 依赖、不跑 `npm test`。
// 每条断言都能指回任务卡 acceptance A1–A5；M.* 是六格状态矩阵，K.* 是键盘路径，V.* 是视觉作证。
//
// 判定口径（黑盒）：只从用户可见入口走（登录表单 → 侧栏导航 → 表格/表单控件），
// 断言读的是屏幕上的文字、可访问树、属性与计算样式，以及页面真发出去的请求（facade 侧日志）。
// 唯一「文档契约替身」是研判记录两条读接口（见 harness.mjs 头注），其余全走真 server.js。
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  REPO, boot, cleanupAll, state, log as plog, auth, readWiki, writeWiki,
} from './harness.mjs';

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const SHOTS = path.join(REPO, 'evidence/test/P003-T007/shots');
mkdirSync(SHOTS, { recursive: true });
const SESSION = 'p003t007-e2e';

const ab = (...args) => {
  try {
    return execFileSync('agent-browser', ['--session', SESSION, '--args', '--no-sandbox', ...args], {
      timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`agent-browser ${args.join(' ')} 失败（exit ${e.status}）：${(e.stdout || '') + (e.stderr || '')}`);
  }
};
/** eval 一个表达式，返回 JS 值；页面抛错时把错误抛出来，不静默成 undefined。 */
const ev = (js) => {
  const raw = ab('eval', js).trim();
  try { return JSON.parse(raw); } catch { return raw; }
};
async function waitFor(desc, expr, pred, timeout = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = ev(expr);
    if (pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`等待超时「${desc}」：最后看到 ${JSON.stringify(last)}`);
}
/** 点一下 + 等某个状态成立；壳/表格重渲染会吞掉一次点击（复现过），所以等不到就再点一次。 */
async function clickAndWait(sel, desc, expr, pred, timeout = 20000, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(250);
    await clickSel(sel);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout / tries + 1500) {
      last = ev(expr);
      if (pred(last)) return last;
      await sleep(150);
    }
  }
  throw new Error(`等待超时「${desc}」：最后看到 ${JSON.stringify(last)}`);
}
const shots = (name) => { ab('screenshot', path.join(SHOTS, name)); return name; };

/* ---------------- 请求面（facade 日志） ---------------- */
const stub = (p) => `http://127.0.0.1:${env.facadePort}${p}`;
let env;
const control = async (obj) => { await fetch(stub('/__stub/control'), { method: 'POST', body: JSON.stringify(obj) }); };
const resetLog = async () => { await fetch(stub('/__stub/resetlog'), { method: 'POST' }); };
const reqLog = async () => (await fetch(stub('/__stub/log'))).json();
const lastAlertQuery = async () => { const l = await reqLog(); return l.alerts[l.alerts.length - 1] ?? ''; };

/* ---------------- 页面动作 ---------------- */
const login = async (user = 'ops', pass = 'ops123') => {
  ab('find', 'label', '账号', 'fill', user);
  ab('find', 'label', '密码', 'fill', pass);
  await clickSel('button[type=submit]');
  await waitFor('登录进壳', 'location.hash', (h) => String(h).startsWith('#/'));
};
const NAV_HASH = { 总览: '#/overview', 告警: '#/alerts', 深度溯源: '#/trace', 规则: '#/rules', 知识库: '#/knowledge' };
const nav = async (name) => {
  const want = NAV_HASH[name];
  for (let i = 0; i < 3; i++) {
    await clickName('link', name);
    for (let n = 0; n < 20; n++) {
      if (ev('location.hash') === want) return;
      await sleep(150);
    }
  }
  throw new Error(`点侧栏「${name}」没进 ${want}（当前 ${ev('location.hash')}）`);
};
/** 退出登录：真实点击；壳在重渲染窗口里会吞掉一次点击（复现过），所以点完等不到表单就再点一次。 */
const logout = async () => {
  for (let i = 0; i < 3; i++) {
    await clickName('button', '退出登录');
    for (let n = 0; n < 20; n++) {
      if (ev('!!document.querySelector("form")') === true) return;
      await sleep(120);
    }
  }
  throw new Error('退出登录点不动（三次点击后仍在壳里）');
};
const PROBE_JS = `(() => {
  if (!window.__piClickBound) {
    window.__piClickProbe = 0;
    window.__piClickBound = true;
    document.addEventListener('click', () => { window.__piClickProbe++; }, true);
  }
  return window.__piClickProbe;
})()`;
/** 按可访问名点按钮/链接；agent-browser 指针点击静默丢失时退回页面内 el.click()（真事件处理链）。 */
const clickName = async (role, name) => {
  const before = ev(PROBE_JS);
  ab('find', 'role', role, 'click', '--name', name);
  await sleep(120);
  if (ev(PROBE_JS) === before) {
    const tag = role === 'link' ? 'a' : 'button';
    ab('eval', `(() => {
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('${tag}')].filter((n) => n.getBoundingClientRect().width > 0);
      const want = ${JSON.stringify(name)};
      const el = all.find((n) => norm(n.innerText) === want) || all.find((n) => norm(n.innerText).startsWith(want));
      if (!el) throw new Error('找不到可点的 ${role}：${name}');
      el.click();
      return 'ok';
    })()`);
  }
};

/** 点一个 CSS 选择器命中的元素。
 *  agent-browser 的指针点击在壳里会「静默丢失」（文档已记：会话内 click 事件不送达页面），
 *  所以先记 document 上的 click 计数：没送达就退回页面内 el.click()——仍是真 Chrome、真事件处理链，
 *  只是不经过指针；送达了就不重复点（避免双击出两次效果）。 */
const clickSel = async (sel) => {
  const before = ev(PROBE_JS);
  ab('click', sel);
  await sleep(120);
  if (ev('window.__piClickProbe') === before) {
    ab('eval', `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('找不到 ${sel}'); el.click(); return 'ok'; })()`);
  }
};
const REFRESH_DISABLED_JS = `(() => { const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '刷新'); return b ? b.disabled : null; })()`;
/** 刷新前先等按钮可用（上一轮请求还在飞时按钮是 disabled，点了 agent-browser 直接报错）。 */
const refreshNow = async () => {
  await waitFor('刷新按钮可用', REFRESH_DISABLED_JS, (v) => v === false);
  await clickName('button', '刷新');
};
/** 每个状态格开测前把替身桩复位，避免上一格的中途失败污染下一格（用例之间互相独立）。 */
const resetStub = async () => {
  await control({ upstream: 'normal', alerts401: false, delayAlerts: 0, big: 0, detail: 'full', session: 'real' });
};
const selectSel = (sel, val) => ab('select', sel, val);
const fillSel = (sel, text) => ab('fill', sel, text);

/** 把筛选复位到全量（有筛选才点清除）。 */
const resetFilters = async () => {
  const active = ev('document.querySelector(\'[data-role="clear-filters"]\').hidden === false');
  if (active) {
    await clickSel(SEL.clear);
    await waitFor('清除筛选复位', ROW_COUNT_JS, (n) => n === 8);
  }
};

const FILTER_VALUES_JS = `[...document.querySelectorAll('.filters select, .filters input')].map((n) => n.value).filter((v) => v !== '')`;
const ensureAlerts = async (expectRows = 8) => {
  await nav('告警');
  await waitFor('告警列表出数', ROW_COUNT_JS, (n) => n >= 1);
  // 「有没有筛选」看控件值，不看清除按钮的 hidden（刚渲染完那一拍 hidden 还没落，会误判成有筛选）
  if (ev(FILTER_VALUES_JS).length > 0) {
    await clickSel(SEL.clear);
    await waitFor('清除筛选复位', ROW_COUNT_JS, (n) => n === 8);
    await waitFor('清除后控件复位', `JSON.stringify(${FILTER_VALUES_JS})`, (v) => JSON.parse(v).length === 0);
  }
  if (expectRows) await waitFor(`列表 ${expectRows} 条`, ROW_COUNT_JS, (n) => n === expectRows);
  return rowIds();
};

const DRAWER_OPEN_JS = `(() => { const d = document.querySelector('[aria-labelledby=drawer-title]'); if (!d) return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;

/** 从列表进详情页：点行标题开抽屉 → 抽屉里「查看完整详情」（用户真实路径）。 */
const openDetail = async (title = 'WebShell 二次落地') => {
  if (!String(ev('location.hash')).includes('/alert-detail/')) {
    await ensureAlerts(8);
    let opened = false;
    for (let i = 0; i < 3 && !opened; i++) {
      await clickName('button', title);
      opened = await waitFor('抽屉打开', DRAWER_OPEN_JS, (v) => v === true, 6000).then(() => true, () => false);
    }
    ok(opened, `点行标题「${title}」应打开抽屉`);
    await clickName('link', '查看完整详情');
    await waitFor('详情页地址', 'location.hash', (h) => String(h).includes('/alert-detail/'));
  }
  await waitFor('详情页正文渲染', 'document.body.innerText.length', (n) => n > 250);
};

const KN_TITLE = '研判通则 · 事实、行为、结果与授权分开核对';
/** 知识库 → GEN-12 → 编辑页签（用户真实路径），返回编辑区字数。 */
const LIST_VISIBLE_JS = `(() => { const tr = document.querySelector('tbody tr'); return !!tr && tr.getBoundingClientRect().width > 0; })()`;
/** 回到知识库列表视图：脏态先放弃、条目页点面包屑「知识库」、别处走侧栏。 */
const backToKnowledgeList = async () => {
  if (!ev('!!document.querySelector("#knowledge-q")')) await nav('知识库');
  if (!ev(LIST_VISIBLE_JS)) {
    for (let i = 0; i < 3 && !ev(LIST_VISIBLE_JS); i++) {
      await clickName('button', '知识库');
      await sleep(400);
      if (ev('[...document.querySelectorAll("dialog")].some((d) => d.open)')) {
        await clickName('button', '放弃修改');
        await sleep(400);
      }
    }
  }
  ok(ev(LIST_VISIBLE_JS) === true, '应回到知识库列表视图（有未保存修改时先放弃）');
  await waitFor('知识库目录', 'document.querySelectorAll("tbody tr").length', (n) => n > 10);
};
const openKnowledgeEdit = async () => {
  await backToKnowledgeList();
  let onEntry = false;
  for (let i = 0; i < 3 && !onEntry; i++) {
    await clickName('button', KN_TITLE);
    await sleep(500);
    onEntry = ev('!!document.querySelector("#knowledge-edit-body")') === true;
  }
  ok(onEntry, '打开 GEN-12 条目页');
  for (let i = 0; i < 3; i++) {
    await clickName('button', '编辑');
    await sleep(400);
    const n = ev('document.querySelector("#knowledge-edit-body")?.value.length ?? 0');
    if (n > 200) return n;
  }
  throw new Error('编辑页签没载入正文');
};
const appendEdit = async (text) => {
  ab('eval', `(() => { const t = document.querySelector('#knowledge-edit-body'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return 'ok'; })()`);
  ab('keyboard', 'type', text);
  await sleep(200);
};

const SEL = {
  q: '[data-role="filter-q"]',
  type: '[data-role="filter-type"]',
  level: '[data-role="filter-level"]',
  verdict: '[data-role="filter-verdict"]',
  triage: '[data-role="filter-triage"]',
  time: '[data-role="filter-time"]',
  count: '[data-role="filter-count"]',
  clear: '[data-role="clear-filters"]',
  sortLevel: '[data-role="sort-level"]',
  sortTime: '[data-role="sort-time"]',
};

const ROWS_JS = `[...document.querySelectorAll('tbody tr')].map(tr => {
  const tds = [...tr.querySelectorAll('td')];
  return { id: (tds[2] && tds[2].innerText.trim()) || '', cells: tds.map(td => td.innerText.trim()) };
}).filter(r => /^[a-z_]+:[0-9]+$/.test(r.id))`;
const IDS_JS = `JSON.stringify(${ROWS_JS}.map(r => r.id))`;
const ROW_COUNT_JS = `${ROWS_JS}.length`;
const rowIds = async () => JSON.parse(ev(IDS_JS) || '[]');
const rows = async () => JSON.parse(ev(`JSON.stringify(${ROWS_JS})`) || '[]');

/* ---------------- 结果台账 ---------------- */
const results = [];
const wanted = (id) => ONLY.length === 0 || ONLY.some((p) => id.startsWith(p));
async function check(id, name, fn) {
  if (!wanted(id)) return;
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail });
    console.log(`ok   ${id} ${name}${detail ? ' | ' + detail : ''}`);
  } catch (e) {
    results.push({ id, name, ok: false, detail: e.message });
    console.log(`FAIL ${id} ${name} | ${e.message.split('\n')[0]}`);
    if (process.env.E2E_DEBUG) console.log(e.message.split('\n').slice(1).join('\n'));
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}：期望 ${b} 实测 ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

/* ---------------- 用例 ---------------- */
async function run() {
  env = await boot();
  const A = { authorization: auth('ops', 'ops123') };
  const api = async (p, init = {}) => {
    const r = await fetch(env.webOrigin + p, { ...init, headers: { ...A, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text };
  };

  ab('set', 'viewport', '1440', '900');
  ab('open', `${env.webOrigin}/`);
  await login();

  /* ===== A5 侧栏身份 ===== */
  await check('A5.1', '登录后侧栏显示头像/账号名/角色（operator → 值守账号）', async () => {
    await waitFor('.who 出现', '!!document.querySelector(".rail .who") || !!document.querySelector(".who")', (v) => v === true);
    const who = ev('JSON.stringify({ txt: document.querySelector(".rail .who")?.innerText ?? document.querySelector(".who")?.innerText, avatar: document.querySelector(".rail .who .avatar")?.innerText ?? document.querySelector(".who .avatar")?.innerText })');
    const w = JSON.parse(who);
    ok(w.avatar && w.avatar.trim() === 'O', `头像应是账号名首字母 O，实测 ${JSON.stringify(w.avatar)}`);
    ok(/ops/.test(w.txt || ''), `账号名 ops 应出现在账号区，实测 ${JSON.stringify(w.txt)}`);
    ok(/值守账号/.test(w.txt || ''), `role=operator 应显示「值守账号」，实测 ${JSON.stringify(w.txt)}`);
    shots('1440-a5-sidebar.png');
    return `账号区=${JSON.stringify((w.txt || '').replace(/\s+/g, ' ').trim())}`;
  });

  /* ===== A1 筛选真参数 ===== */
  await check('A1.1', '默认列表：时间倒序 8 条，未筛选时不带筛选参数、清除按钮隐藏', async () => {
    await resetLog();
    const ids = await ensureAlerts(8);
    eq(ids, ['webshell:9', 'webshell:2', 'webshell:1', 'webshell:3', 'malware:5', 'malware:7', 'malware:6', 'honeypot:4'], '时间倒序行序');
    const q = await lastAlertQuery();
    ok(!/type=|level=|verdict=|triage_status=|q=|from=|to=/.test(q), `未筛选的请求不应带筛选参数，实测 ${q}`);
    ok(/sort=time/.test(q), `默认排序应显式发 sort=time（README 10.1），实测 ${q}`);
    const ui = ev('JSON.stringify({ count: document.querySelector(\'[data-role="filter-count"]\').innerText, clearHidden: document.querySelector(\'[data-role="clear-filters"]\').hidden })');
    const u = JSON.parse(ui);
    eq(u.count, '', '未筛选时结果计数');
    eq(u.clearHidden, true, '未筛选时清除按钮 hidden');
    return `ids=${ids.join(',')} 请求=${q}`;
  });

  await check('A1.2', '类型筛选下推 type=webshell：4 条、计数「筛选后 4 条」、清除按钮出现、回第一页', async () => {
    await resetLog();
    await selectSel(SEL.type, 'webshell');
    await waitFor('类型筛选生效', ROW_COUNT_JS, (n) => n === 4);
    const ids = await rowIds();
    eq(ids, ['webshell:9', 'webshell:2', 'webshell:1', 'webshell:3'], 'type=webshell 行序');
    const q = await lastAlertQuery();
    ok(/type=webshell/.test(q), `请求应带 type=webshell，实测 ${q}`);
    ok(/offset=0/.test(q) || !/offset=/.test(q), `筛选变化应回第一页，实测 ${q}`);
    const count = ev('document.querySelector(\'[data-role="filter-count"]\').innerText');
    ok(/筛选后\s*4\s*条/.test(count), `结果计数应为「筛选后 4 条」，实测 ${JSON.stringify(count)}`);
    eq(ev('document.querySelector(\'[data-role="clear-filters"]\').hidden'), false, '有筛选时清除按钮应可见');
    return `ids=${ids.join(',')} 计数=${count} 请求=${q}`;
  });

  await check('A1.3', '等级筛选下推 level=critical：只剩 1 条', async () => {
    await resetLog();
    await selectSel(SEL.level, 'critical');
    await waitFor('等级筛选生效', ROW_COUNT_JS, (n) => n === 1);
    eq(await rowIds(), ['webshell:1'], 'level=critical 行');
    const q = await lastAlertQuery();
    ok(/level=critical/.test(q), `请求应带 level=critical，实测 ${q}`);
    ok(/type=webshell/.test(q), `已选类型应保留在同一请求里，实测 ${q}`);
    return `请求=${q}`;
  });

  await check('A1.4', '搜索下推 q=WebShell：4 条（id 含 webshell 也算命中）；清空搜索后不再发 q', async () => {
    await resetFilters();
    await resetLog();
    await fillSel(SEL.q, 'WebShell');
    ab('press', 'Enter');
    await waitFor('搜索结果', ROW_COUNT_JS, (n) => n === 4);
    eq(await rowIds(), ['webshell:9', 'webshell:2', 'webshell:1', 'webshell:3'], 'q=WebShell 行序');
    const qWith = await lastAlertQuery();
    ok(/q=WebShell/.test(qWith), `请求应带 q=WebShell，实测 ${qWith}`);
    await resetLog();
    await fillSel(SEL.q, '');
    ab('press', 'Enter');
    await waitFor('清空搜索后回全量 8 条', ROW_COUNT_JS, (n) => n === 8);
    const qEmpty = await lastAlertQuery();
    ok(!/q=/.test(qEmpty), `空搜索不应发 q，实测 ${qEmpty}`);
    return `有值请求=${qWith} 清空后请求=${qEmpty}`;
  });

  await check('A1.5', '时间范围下推 from=now-N，且**不发 to**：近 24 小时 6 条（排除 26 小时前与 8 天前）', async () => {
    await resetFilters();
    await resetLog();
    await selectSel(SEL.time, '24h');
    await waitFor('时间筛选生效', ROW_COUNT_JS, (n) => n === 6);
    const q = await lastAlertQuery();
    ok(/from=/.test(q), `请求应带 from，实测 ${q}`);
    ok(!/\bto=/.test(q), `时间范围不应发 to，实测 ${q}`);
    const from = new URLSearchParams(q).get('from');
    const delta = Date.now() - Date.parse(from);
    ok(delta > 23.5 * 3600e3 && delta < 24.5 * 3600e3, `from 应是 24 小时前的时刻，实测 ${from}（差 ${Math.round(delta / 60000)} 分钟）`);
    await resetLog();
    await clickSel(SEL.clear);
    await waitFor('清除筛选回全量', ROW_COUNT_JS, (n) => n === 8);
    const q2 = await lastAlertQuery();
    ok(!/type=|level=|from=/.test(q2), `清除后请求不应再带筛选参数，实测 ${q2}`);
    const ui = JSON.parse(ev('JSON.stringify({ t: document.querySelector(\'[data-role="filter-type"]\').value, l: document.querySelector(\'[data-role="filter-level"]\').value, tm: document.querySelector(\'[data-role="filter-time"]\').value, clear: document.querySelector(\'[data-role="clear-filters"]\').hidden })'));
    eq(ui, { t: '', l: '', tm: '', clear: true }, '清除筛选后的控件状态');
    return `from=${from} 差 ${Math.round(delta / 60000)} 分钟；清除后请求=${q2}`;
  });

  await check('A1.6', '结论筛下发 verdict=threat（0 条，空态可退出）；研判状态下推 triage_status=not_queued（8 条）', async () => {
    await resetFilters();
    await resetLog();
    await selectSel(SEL.verdict, 'threat');
    await waitFor('结论筛选返回空', `document.querySelector("tbody tr")?.innerText`, (t) => /没有匹配的告警|暂无告警/.test(String(t)));
    let q = await lastAlertQuery();
    ok(/verdict=threat/.test(q), `请求应带 verdict=threat，实测 ${q}`);
    const empty = ev('document.querySelector("tbody tr").innerText.replace(/\\s+/g, " ").trim()');
    ok(/没有匹配的告警/.test(empty), `有筛选且 0 条时应显示「没有匹配的告警」，实测 ${JSON.stringify(empty)}`);
    ok(/清除筛选/.test(empty), `空态应带「清除筛选」入口，实测 ${JSON.stringify(empty)}`);
    const emptyShot = shots('1440-a1-empty-filtered.png');
    // 空态里的清除入口真的能退出筛选
    await clickSel('tbody .empty-row button');
    await waitFor('空态清除筛选回 8 条', ROW_COUNT_JS, (n) => n === 8);
    await resetLog();
    await selectSel(SEL.triage, 'not_queued');
    await waitFor('研判状态筛选生效', ROW_COUNT_JS, (n) => n === 8);
    q = await lastAlertQuery();
    ok(/triage_status=not_queued/.test(q), `请求应带 triage_status=not_queued，实测 ${q}`);
    await clickSel(SEL.clear);
    await waitFor('复位', ROW_COUNT_JS, (n) => n === 8);
    return `空态截图=${emptyShot} 请求=${q}`;
  });

  /* ===== A2 真排序 ===== */
  await check('A2.1', '点「等级」表头：sort=level、顺序按等级降序、aria-sort 从 time 换到 level', async () => {
    await ensureAlerts(8);
    await resetLog();
    await clickAndWait(SEL.sortLevel, '等级排序生效', IDS_JS, (v) => JSON.parse(v)[0] === 'webshell:1');
    let ids = await rowIds();
    const want = ['webshell:1', 'webshell:9', 'webshell:3', 'malware:5', 'webshell:2', 'malware:7', 'malware:6', 'honeypot:4'];
    await waitFor('等级降序行序', IDS_JS, (v) => JSON.parse(v).join() === want.join());
    ids = await rowIds();
    const q = await lastAlertQuery();
    ok(/sort=level/.test(q), `请求应带 sort=level，实测 ${q}`);
    const ui = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('thead th')].map(th => ({ txt: th.innerText.replace(/\\s+/g,' ').trim(), sort: th.getAttribute('aria-sort') })))`));
    const levelTh = ui.find((t) => /^等级/.test(t.txt));
    const timeTh = ui.find((t) => /^时间/.test(t.txt));
    eq(levelTh.sort, 'descending', '等级列 aria-sort');
    eq(timeTh.sort, 'none', '时间列 aria-sort');
    ok(/等级.*↓/.test(levelTh.txt), `等级列应显示 ↓，实测 ${JSON.stringify(levelTh.txt)}`);
    ok(!/↓/.test(timeTh.txt), `时间列不应再显示 ↓，实测 ${JSON.stringify(timeTh.txt)}`);
    shots('1440-a2-sort-level.png');
    return `行序=${ids.join(',')} 请求=${q}`;
  });

  await check('A2.2', '同一列再点不发请求（接口没有方向参数，不伪造升序）', async () => {
    await ensureAlerts(8);
    await resetLog();
    const before = await rowIds();
    await clickSel(SEL.sortLevel);
    await sleep(800);
    const l = await reqLog();
    eq(l.alerts.length, 0, `同列再点应一条 /api/alerts 都不发，实测 ${JSON.stringify(l.alerts)}`);
    eq(await rowIds(), before, '同列再点后顺序不变');
    return '同列再点：请求 0 条、顺序不变';
  });

  await check('A2.3', '点「时间」表头：sort=time、回时间倒序、aria-sort 换列', async () => {
    await ensureAlerts(8);
    await resetLog();
    const want = ['webshell:9', 'webshell:2', 'webshell:1', 'webshell:3', 'malware:5', 'malware:7', 'malware:6', 'honeypot:4'];
    await clickAndWait(SEL.sortTime, '时间排序生效', IDS_JS, (v) => JSON.parse(v).join() === want.join());
    const q = await lastAlertQuery();
    ok(/sort=time/.test(q), `请求应带 sort=time，实测 ${q}`);
    const ui = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('thead th')].map(th => ({ txt: th.innerText.replace(/\\s+/g,' ').trim(), sort: th.getAttribute('aria-sort') })))`));
    eq(ui.find((t) => /^时间/.test(t.txt)).sort, 'descending', '时间列 aria-sort');
    eq(ui.find((t) => /^等级/.test(t.txt)).sort, 'none', '等级列 aria-sort');
    return `请求=${q}`;
  });

  /* ===== A3 详情页证据链 ===== */
  await check('A3.1', '详情页证据来源按 evidence[] 分组：共 3 条、两个 tool 组、前两组展开', async () => {
    await ensureAlerts(8);
    await resetLog();
    await clickName('button', 'WebShell 二次落地');
    await waitFor('抽屉打开', DRAWER_OPEN_JS, (v) => v === true);
    await clickName('link', '查看完整详情');
    await waitFor('详情页地址', 'location.hash', (h) => String(h).includes('/alert-detail/'));
    await waitFor('详情页证据区块', 'document.querySelectorAll("details.ev-group").length', (n) => n === 2);
    const groups = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('details.ev-group')].map(d => ({ open: d.open, head: d.querySelector('summary').innerText.replace(/\\s+/g,' ').trim(), items: d.querySelectorAll('li').length })))`));
    eq(groups.length, 2, '分组数');
    eq(groups[0], { open: true, head: 'list_host_events 2 条', items: 2 }, '第一组');
    eq(groups[1], { open: true, head: 'list_firewall_connection_records 1 条', items: 1 }, '第二组');
    const head = ev('document.body.innerText.match(/证据来源[^\\n]*\\n?/)?.[0] ?? ""');
    const total = ev('JSON.stringify(document.body.innerText.match(/共\\s*3\\s*条/g))');
    ok(/共\s*3\s*条/.test(String(total)), `证据来源应写「共 3 条」，实测 ${total}`);
    const reqs = await reqLog();
    eq(reqs.triageHits, ['webshell:9'], '前端应读 triage 单条记录');
    return `分组=${JSON.stringify(groups)}`;
  });

  await check('A3.2', '证据条目三列：evidence_id / sha256 前 12 位（title 给全值）/ 时间', async () => {
    await openDetail();
    const items = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('details.ev-group li')].map(li => ({ txt: li.innerText.replace(/\\s+/g,' ').trim(), titles: [...li.querySelectorAll('[title]')].map(n => n.title), code: [...li.querySelectorAll('code, [data-role]')].map(n => n.innerText.trim()) })))`));
    eq(items.length, 3, '条目数');
    ok(/^cw:1\b/.test(items[0].txt), `第一条应是 cw:1，实测 ${items[0].txt}`);
    ok(/sha256\s*a{12}/.test(items[0].txt), `应显示 sha256 前 12 位，实测 ${items[0].txt}`);
    ok(items[0].titles.some((t) => /^a{64}$/.test(t)), `title 应给 sha256 全值，实测 ${JSON.stringify(items[0].titles)}`);
    ok(/\d{2}:\d{2}:\d{2}/.test(items[0].txt), `应显示本地时间，实测 ${items[0].txt}`);
    shots('1440-a3-evidence.png');
    return items.map((i) => i.txt).join(' || ');
  });

  await check('A3.3', 'claim 与 citation 对账：对得上的不标红，cw:99 标红并写「1 处引用在证据条目中找不到」+ 脚注', async () => {
    await openDetail();
    const miss = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('.claim-ref > span')].map(n => ({ txt: n.innerText.trim(), color: getComputedStyle(n).color, cls: n.className, title: n.title })))`));
    const normals = miss.filter((m) => /^cw:1$|^mcp:3$/.test(m.txt));
    const bad = miss.find((m) => m.txt === 'cw:99');
    ok(normals.length >= 2, `引用编号应逐个列出（cw:1 / mcp:3），实测 ${JSON.stringify(miss.map((m) => m.txt))}`);
    ok(bad, `应出现对不上的引用编号 cw:99，实测 ${JSON.stringify(miss.map((m) => m.txt))}`);
    ok(bad.color !== normals[0].color, `对不上的引用应换色（正常 ${normals[0].color} / 缺失 ${bad.color}）`);
    ok(/is-missing/.test(bad.cls), `缺失引用应带 is-missing 标记，实测 class=${bad.cls}`);
    ok(bad.title && bad.title.length > 0, '缺失引用应有 title 说明');
    const claimNote = ev(`JSON.stringify([...document.querySelectorAll('*')].map(n => n.childElementCount === 0 ? (n.innerText || '').trim() : '').filter(t => /处引用在证据条目中找不到/.test(t)))`);
    ok(/1 处引用在证据条目中找不到/.test(claimNote), `claim 里应写「1 处引用在证据条目中找不到」，实测 ${claimNote}`);
    const foot = JSON.parse(ev(`JSON.stringify([...document.querySelectorAll('[data-role="evidence-note"]')].map(n => ({ hidden: n.hidden, txt: n.innerText.replace(/\\s+/g, ' ').trim() })))`));
    eq(foot.length, 1, '脚注节点数');
    eq(foot[0].hidden, false, '差集 > 0 时脚注应可见');
    ok(/证据链不完整/.test(foot[0].txt), `脚注应写「证据链不完整」，实测 ${foot[0].txt}`);
    return `正常引用色=${normals[0].color} 缺失=${bad.color} 脚注=${foot[0].txt}`;
  });

  await check('A3.4', '只有来源数量、没有条目时不编条目：0 个分组 + 脚注说明「没有条目明细」', async () => {
    await control({ detail: 'no_evidence' });
    await nav('告警');
    await waitFor('列表就绪', ROW_COUNT_JS, (n) => n === 8);
    await openDetail();
    await waitFor('详情页渲染出证据区块', 'document.body.innerText.includes("证据来源")', (v) => v === true);
    const ui = JSON.parse(ev(`JSON.stringify({ groups: document.querySelectorAll("details.ev-group").length, note: [...document.querySelectorAll('[data-role="evidence-note"]')].map(n => ({ hidden: n.hidden, txt: n.innerText.trim() })), txt: document.body.innerText.match(/证据来源[\s\S]{0,60}/)?.[0] ?? "" })`));
    eq(ui.groups, 0, '没有 evidence[] 条目时不应有分组');
    ok(ui.note.length === 1 && ui.note[0].hidden === false, `脚注应说明只有数量没有明细（可见），实测 ${JSON.stringify(ui.note)}`);
    ok(/没有条目明细/.test(ui.note[0].txt), `脚注应写「接口只返回了证据来源数量，没有条目明细」，实测 ${JSON.stringify(ui.note[0].txt)}`);
    ok(/2 个来源/.test(ev('document.body.innerText')), '标题右侧应给来源数量「2 个来源」');
    await control({ detail: 'full' });
    return `分组 0 个；脚注=${JSON.stringify(ui.note[0].txt)}`;
  });

  /* ===== A4 知识库保存走 PUT ===== */
  await check('A4.1', '编辑正文 → 保存到服务器：PUT 落盘、front matter 保留、revision 变化、界面转「已保存到服务器」', async () => {
    const before = (await api('/api/wiki/pages/common/GEN-12.md')).json;
    ok(before && before.revision, '前置：GET GEN-12 应有 revision');
    await resetLog();
    await openKnowledgeEdit();
    await waitFor('正文来源标注', 'document.body.innerText.includes("服务器正文")', (v) => v === true);
    ok(!/本地草稿|保存草稿/.test(ev('document.body.innerText')), 'A4 语义：界面不应再出现「本地草稿 / 保存草稿」');
    const marker = `## 测试追加 ${Date.now()}`;
    await appendEdit(`\n\n${marker}\n`);
    await clickName('button', '保存到服务器');
    await waitFor('保存成功状态', 'document.body.innerText.includes("已保存到服务器")', (v) => v === true);
    const l = await reqLog();
    ok(l.all.some((r) => r.m === 'PUT' && decodeURIComponent(r.p) === '/api/wiki/pages/common/GEN-12.md'), `应发出 PUT /api/wiki/pages/common/GEN-12.md，实测 ${JSON.stringify(l.all.filter((r) => r.m === 'PUT'))}`);
    const disk = readWiki(env.wikiDir, 'common/GEN-12.md');
    ok(disk.includes(marker), '磁盘正文应含本次追加的小节');
    ok(disk.startsWith('---\n'), `正文应以 front matter 开头（front matter 未被保存流程吃掉），实测开头 ${JSON.stringify(disk.slice(0, 12))}`);
    ok(/^id: GEN-12$/m.test(disk), 'front matter 的 id 行应保留');
    const after = (await api('/api/wiki/pages/common/GEN-12.md')).json;
    ok(after.revision !== before.revision, `revision 应变化（前 ${before.revision} / 后 ${after.revision}）`);
    ok(after.content.includes(marker), 'GET 回来的正文应含新增小节');
    shots('1440-a4-knowledge-saved.png');
    return `revision ${before.revision} → ${after.revision}，磁盘含 ${marker}`;
  });

  await check('A4.2', '版本过期（别人先改）：409 → 结果条冲突文案 +「刷新正文」，编辑内容不丢、不写盘', async () => {
    await openKnowledgeEdit();
    // 磁盘侧先改动同一个文件，制造 revision 变化
    const cur = readWiki(env.wikiDir, 'common/GEN-12.md');
    writeWiki(env.wikiDir, 'common/GEN-12.md', cur + '\n\n## 别人改的\n');
    const rev = (await api('/api/wiki/pages/common/GEN-12.md')).json.revision;
    const editedBefore = `\n\n我的改动-${Date.now()}\n`;
    ab('eval', `(() => { const t = document.querySelector('#knowledge-edit-body'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return 'ok'; })()`);
    ab('keyboard', 'type', editedBefore);
    const taBefore = ev('document.querySelector("#knowledge-edit-body").value.length');
    await resetLog();
    await clickName('button', '保存到服务器');
    await waitFor('冲突提示出现', 'document.body.innerText.includes("已被别人更新")', (v) => v === true, 20000);
    const ui = JSON.parse(ev('JSON.stringify({ txt: document.body.innerText.match(/知识库页面已被别人更新[\\s\\S]{0,70}/)?.[0] ?? "", refresh: [...document.querySelectorAll("button")].some(b => b.innerText.trim() === "刷新正文") })'));
    ok(ui.refresh, '冲突结果条应带「刷新正文」按钮');
    const taAfter = ev('document.querySelector("#knowledge-edit-body").value.length');
    ok(taAfter >= taBefore, `编辑内容应保留（前 ${taBefore} 字 / 后 ${taAfter} 字）`);
    const disk = readWiki(env.wikiDir, 'common/GEN-12.md');
    ok(!disk.includes('我的改动-'), '409 时不应写盘（磁盘里不该出现本次编辑内容）');
    const l = await reqLog();
    ok(l.all.some((r) => r.m === 'PUT'), '应真的发过 PUT');
    const revAfter = (await api('/api/wiki/pages/common/GEN-12.md')).json.revision;
    eq(revAfter, rev, '409 后服务端 revision 不应变化');
    shots('1440-a4-knowledge-conflict.png');
    return `冲突文案=${ui.txt.replace(/\s+/g, ' ').slice(0, 60)}；编辑区 ${taAfter} 字保留`;
  });

  await check('A4.3', '正文超限 → 400，界面显示服务端原话、编辑内容保留', async () => {
    await openKnowledgeEdit();
    await resetLog();
    ab('eval', `(() => { const t = document.querySelector('#knowledge-edit-body'); t.value = 'x'.repeat(30050); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(300);
    await clickName('button', '保存到服务器');
    await waitFor('400 结果条', 'document.body.innerText.includes("页面正文必须为 1 到 30000 字")', (v) => v === true, 20000);
    const notices = JSON.parse(ev(`JSON.stringify([...new Set([...document.querySelectorAll('[role=alert],[role=status],[data-role="entry-notice"],[data-role="toast"],[data-role="live"],[data-role="content"]')].map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()).filter((t) => /保存失败/.test(t)))])`));
    const full = notices.find((t) => /保存失败：页面正文必须为 1 到 30000 字/.test(t));
    ok(full, `结果条应是「保存失败：<服务端原话>」，实测 ${JSON.stringify(notices)}`);
    const txt = full;
    const ta = ev('document.querySelector("#knowledge-edit-body").value.length');
    ok(ta > 30000, `失败后编辑内容应保留，实测 ${ta} 字`);
    const l = await reqLog();
    const put = l.all.filter((r) => r.m === 'PUT');
    ok(put.length === 1, `应只发一次 PUT，实测 ${put.length}`);
    return `结果条=${txt.replace(/\s+/g, ' ').slice(0, 50)}`;
  });

  await check('A4.4', '脏态离开：弹「保存并离开」→ PUT 成功才离开，落盘可见', async () => {
    await openKnowledgeEdit();
    const marker = `保存并离开 ${Date.now()}`;
    await appendEdit(`\n\n## ${marker}\n`);
    await resetLog();
    await clickName('link', '告警');
    await waitFor('离开守卫弹窗', '[...document.querySelectorAll("dialog")].some(d => d.open)', (v) => v === true);
    const dlg = ev('JSON.stringify([...document.querySelectorAll("dialog")].filter(d => d.open).map(d => d.innerText.replace(/\\s+/g, " ").trim()))');
    ok(/保存并离开/.test(dlg), `弹窗应提供「保存并离开」，实测 ${dlg}`);
    await clickName('button', '保存并离开');
    await waitFor('保存并离开后离开条目', 'location.hash', (h) => String(h).includes('/alerts'), 20000);
    const disk = readWiki(env.wikiDir, 'common/GEN-12.md');
    ok(disk.includes(marker), '磁盘应含「保存并离开」这次追加');
    return `弹窗=${dlg.slice(0, 50)} hash=${ev('location.hash')}`;
  });

  /* ===== 六格状态矩阵 ===== */
  await check('M.loading', '加载中：aria-busy + 「正在读取告警…」+ 刷新与筛选控件禁用，数据到后解除', async () => {
    await nav('告警');
    await waitFor('列表就绪', ROW_COUNT_JS, (n) => n === 8);
    await control({ delayAlerts: 1500 });
    await refreshNow();
    await sleep(250);
    const during = JSON.parse(ev(`JSON.stringify({
      busy: document.querySelector('.table-wrap').getAttribute('aria-busy'),
      row: document.querySelector('tbody tr')?.innerText.replace(/\\s+/g,' ').trim(),
      refreshDisabled: [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '刷新')?.disabled,
      selectsDisabled: [...document.querySelectorAll('.filters select, .filters input')].map(n => n.disabled),
    })`));
    eq(during.busy, 'true', '加载中 .table-wrap 的 aria-busy');
    ok(/正在读取告警/.test(during.row), `加载中应显示「正在读取告警…」，实测 ${JSON.stringify(during.row)}`);
    eq(during.refreshDisabled, true, '加载中刷新按钮应禁用');
    ok(during.selectsDisabled.length >= 5 && during.selectsDisabled.every((d) => d === true), `加载中筛选控件应全部禁用，实测 ${JSON.stringify(during.selectsDisabled)}`);
    shots('1440-m-loading.png');
    await waitFor('数据到后解除 loading', `document.querySelector('.table-wrap')?.getAttribute('aria-busy')`, (v) => v === 'false' || v === null);
    await waitFor('数据行回来', ROW_COUNT_JS, (n) => n === 8);
    await control({ delayAlerts: 0 });
    return `加载中 aria-busy=true、刷新 disabled、${during.selectsDisabled.length} 个筛选控件 disabled`;
  });

  await check('M.empty', '无筛选空数据：「暂无告警。」+ 分页/全选禁用 + 共 0 条', async () => {
    await resetStub();
    await control({ upstream: 'empty' });
    await resetLog();
    await refreshNow();
    await waitFor('空态文案', 'document.querySelector("tbody tr")?.innerText', (t) => /暂无告警/.test(String(t)));
    const ui = JSON.parse(ev(`JSON.stringify({
      txt: document.body.innerText.match(/共\\s*\\d+\\s*条/)?.[0] ?? '',
      prev: [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '上一页')?.disabled,
      next: [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '下一页')?.disabled,
      allBox: document.querySelector('[data-role="select-all"]')?.disabled,
    })`));
    eq(ui.txt.replace(/\s+/g, ''), '共0条', '空列表的「共 N 条」');
    eq(ui.prev, true, '上一页应禁用');
    eq(ui.next, true, '下一页应禁用');
    eq(ui.allBox, true, '全选应禁用');
    shots('1440-m-empty.png');
    await control({ upstream: 'normal' });
    await refreshNow();
    await waitFor('恢复 8 条', ROW_COUNT_JS, (n) => n === 8);
    return `空态=${ui.txt}`;
  });

  await check('M.partial', '部分类型失败：提示条逐类列原因，列表照常可用', async () => {
    await resetStub();
    await control({ upstream: 'failOne' });
    await resetLog();
    await refreshNow();
    await waitFor('partial 提示条可见', `document.querySelector('[data-role="partial"]')?.hidden`, (v) => v === false);
    const txt = ev('document.querySelector(\'[data-role="partial"]\').innerText.replace(/\\s+/g, " ").trim()');
    ok(/部分类型查询失败/.test(txt), `提示条应写「部分类型查询失败」，实测 ${JSON.stringify(txt)}`);
    ok(/webshell/.test(txt), `提示条应列出失败类型 webshell，实测 ${JSON.stringify(txt)}`);
    ok((await rowIds()).length > 0, '部分失败时列表仍应显示成功的类型');
    shots('1440-m-partial.png');
    await control({ upstream: 'normal' });
    await refreshNow();
    await waitFor('partial 提示条收起', `document.querySelector('[data-role="partial"]')?.hidden`, (v) => v === true);
    return `提示条=${txt.slice(0, 80)}`;
  });

  await check('M.truncated', '扫描窗口被截断：truncated 提示条出现并说明只统计窗口内，未截断时隐藏', async () => {
    await resetStub();
    await control({ big: 600 });
    await resetLog();
    await refreshNow();
    await waitFor('大列表就绪', ROW_COUNT_JS, (n) => n === 20);
    eq(ev('document.querySelector(\'[data-role="truncated"]\').hidden'), true, '无筛选时 truncated 应为 hidden');
    await resetLog();
    await selectSel(SEL.level, 'high');
    await waitFor('truncated 提示条可见', `document.querySelector('[data-role="truncated"]')?.hidden`, (v) => v === false);
    const txt = ev('document.querySelector(\'[data-role="truncated"]\').innerText.replace(/\\s+/g, " ").trim()');
    ok(/扫描窗口/.test(txt) && /500/.test(txt), `提示条应说明只统计扫描窗口（500 条），实测 ${JSON.stringify(txt)}`);
    shots('1440-m-truncated.png');
    const l = await reqLog();
    ok(l.alerts.some((q) => /level=high/.test(q)), '触发请求应带 level=high');
    await clickSel(SEL.clear);
    await control({ big: 0 });
    await sleep(200);
    await refreshNow();
    await waitFor('恢复默认 8 条', ROW_COUNT_JS, (n) => n === 8);
    return `提示条=${txt.slice(0, 70)}`;
  });

  await check('M.error', '错误格：401 → role=alert 错误块 + 重试；恢复后点重试列表回来', async () => {
    await resetStub();
    await control({ alerts401: true });
    await resetLog();
    await refreshNow();
    await waitFor('错误块出现', 'document.querySelector(\'.table-wrap [role=alert], [role=alert]\')?.innerText', (t) => /登录已失效|服务返回异常|无法连接/.test(String(t)));
    const txt = ev('document.querySelector(\'.table-wrap [role=alert]\')?.innerText.replace(/\\s+/g, " ").trim() ?? ""');
    ok(/登录已失效/.test(txt), `401 应显示「登录已失效」，实测 ${JSON.stringify(txt)}`);
    ok(/重试/.test(txt), `错误块应带「重试」，实测 ${JSON.stringify(txt)}`);
    shots('1440-m-error.png');
    await control({ alerts401: false });
    await clickName('button', '重试');
    await waitFor('重试后列表回来', ROW_COUNT_JS, (n) => n === 8);
    return `错误文案=${txt.slice(0, 60)}`;
  });

  await check('M.long', '超长标题：单元格单行截断但 textContent / title 都是全文', async () => {
    await resetStub();
    const row = JSON.parse(ev(`(() => {
      const tr = [...document.querySelectorAll('tbody tr')].find(r => /异常进程链/.test(r.innerText));
      if (!tr) return 'null';
      const btn = [...tr.querySelectorAll('button')].find(b => /异常进程链/.test(b.innerText));
      const cs = getComputedStyle(btn);
      return JSON.stringify({ len: btn.innerText.length, title: btn.title, ellipsis: cs.textOverflow, nowrap: cs.whiteSpace, overflow: btn.scrollWidth > btn.clientWidth });
    })()`));
    ok(row.len > 100, `长标题全文应完整保留在 textContent，实测 ${row.len} 字`);
    eq(row.title, ev(`[...[...document.querySelectorAll('tbody tr')].find(r => /异常进程链/.test(r.innerText)).querySelectorAll('button')].find(b => /异常进程链/.test(b.innerText)).innerText`), 'title 应是全文');
    eq(row.ellipsis, 'ellipsis', '截断样式');
    ok(row.overflow, '应真的溢出（scrollWidth > clientWidth）');
    return `标题 ${row.len} 字、textOverflow=${row.ellipsis}、溢出=${row.overflow}`;
  });

  await check('M.degrade', '队列状态单独失败只降级队列条（状态不可用 + 计数「—」），列表不受影响', async () => {
    await resetStub();
    const txt = ev('document.body.innerText');
    ok(/状态不可用/.test(txt), '无研判队列时队列条应显示「状态不可用」');
    ok((await rowIds()).length === 8, '队列条降级不应影响列表');
    return '队列条：状态不可用；列表 8 条照常';
  });

  /* ===== 键盘路径 ===== */
  await check('K.1', '键盘路径：Tab 依次到搜索框/五个下拉/排序按钮，排序按钮 Enter 触发', async () => {
    await resetStub();
    await ensureAlerts(8);
    ab('focus', SEL.q);
    await sleep(150);
    eq(ev('document.activeElement?.getAttribute?.("aria-label")'), '搜索告警', '键盘路径起点：搜索框获得焦点');
    const chain = [];
    const here = JSON.parse(ev('JSON.stringify({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute?.("aria-label") || document.activeElement?.innerText?.trim().slice(0, 12) })'));
    chain.push(`${here.tag}:${here.label}`);
    for (let i = 0; i < 10; i++) {
      ab('press', 'Tab');
      const a = JSON.parse(ev('JSON.stringify({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute?.("aria-label") || document.activeElement?.innerText?.trim().slice(0, 12) })'));
      chain.push(`${a.tag}:${a.label}`);
      if (a.tag === 'BUTTON' && /等级|时间/.test(a.label || '')) break;
    }
    const hasAll = ['搜索告警', '按事件类型筛选', '按等级筛选', '按研判结论筛选', '按研判状态筛选', '按时间范围筛选'].every((l) => chain.some((c) => c.includes(l)));
    ok(hasAll, `Tab 应走到搜索框与五个下拉，实测 ${JSON.stringify(chain)}`);
    const focused = chain[chain.length - 1];
    ok(/BUTTON:(等级|时间)/.test(focused), `Tab 应能走到表头排序按钮，实测 ${focused}`);
    await resetLog();
    ab('press', 'Enter');
    await sleep(900);
    const l = await reqLog();
    ok(l.alerts.some((q) => /sort=(level|time)/.test(q)), `Enter 应触发排序请求，实测 ${JSON.stringify(l.alerts)}`);
    return `Tab 链=${chain.join(' → ')} 请求=${l.alerts.join(' ')}`;
  });

  /* ===== 视觉作证：两种宽度 ===== */
  await check('V.1', '1440×900 与 390×844 两档截图：窄屏筛选条独占行、无横向滚动、账号区按稿隐藏', async () => {
    await resetStub();
    await ensureAlerts(8);
    await clickSel(SEL.sortLevel);
    await selectSel(SEL.type, 'webshell');
    await waitFor('筛选排序状态', ROW_COUNT_JS, (n) => n === 4);
    shots('1440-v-alerts.png');
    ab('set', 'viewport', '390', '844');
    await sleep(500);
    const narrow = JSON.parse(ev(`JSON.stringify({
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      searchTop: document.querySelector('[data-role="filter-q"]').getBoundingClientRect().top,
      typeTop: document.querySelector('[data-role="filter-type"]').getBoundingClientRect().top,
      whoVisible: (() => { const w = document.querySelector('.rail .who') || document.querySelector('.who'); if (!w) return false; const r = w.getBoundingClientRect(); return r.width > 0 && getComputedStyle(w).display !== 'none'; })(),
    })`));
    eq(narrow.scrollW, narrow.innerW, '窄屏不应有横向滚动');
    ok(narrow.searchTop < narrow.typeTop, `390 宽下搜索框应独占一行（搜索 ${narrow.searchTop} < 下拉 ${narrow.typeTop}），照稿 alerts.html:829-831`);
    eq(narrow.whoVisible, false, '≤900px 账号区应隐藏（稿 alerts.html:813 / README §4）');
    shots('390-v-alerts.png');
    await clickName('link', '知识库');
    await waitFor('窄屏知识库', 'document.querySelectorAll("tbody tr").length', (n) => n > 5);
    shots('390-v-knowledge.png');
    ab('set', 'viewport', '1440', '900');
    return `390 宽 scrollWidth=${narrow.scrollW} innerWidth=${narrow.innerW}，账号区可见=${narrow.whoVisible}`;
  });

  await check('A5.2', '服务端没配账号（user/role 为 null）时账号区整块不渲染，不编名字', async () => {
    await control({ session: 'anonymous' });
    await logout();
    await login();
    await sleep(500);
    const who = JSON.parse(ev(`(() => {
      const w = document.querySelector('.rail [data-role="who"], .rail .who');
      if (!w) return JSON.stringify({ rendered: false });
      const r = w.getBoundingClientRect();
      return JSON.stringify({ rendered: true, visible: r.width > 0 && r.height > 0 && getComputedStyle(w).display !== 'none', txt: w.innerText.trim() });
    })()`));
    ok(!(who.rendered && who.visible), `user 为 null 时账号区不应可见，实测 ${JSON.stringify(who)}`);
    eq(who.txt ?? '', '', '无身份时账号区不应有文字');
    await control({ session: 'real' });
    return `账号区=${JSON.stringify(who)}`;
  });

  /* ===== 汇总 ===== */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 条：pass ${results.length - failed.length} / fail ${failed.length}`);
  if (failed.length) {
    console.log('失败清单：' + failed.map((f) => f.id).join(', '));
    return 1;
  }
  return 0;
}

let code = 1;
try {
  code = await run();
} catch (e) {
  console.error('装置异常：' + (e.stack || e.message));
  code = 2;
} finally {
  try { execFileSync('agent-browser', ['--session', SESSION, '--args', '--no-sandbox', 'close'], { timeout: 30000, stdio: 'ignore' }); } catch { /* 已关 */ }
  cleanupAll();
  rmSync(path.join(REPO, 'evidence/test/P003-T007/shots/.tmp'), { recursive: true, force: true });
}
process.exit(code);
