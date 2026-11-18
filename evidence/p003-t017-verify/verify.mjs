// P003-T017 前端黑盒验收（tester 江屿）：真浏览器 + 真后端（node server.js + 仓根 rules/）。
//
// 断言只挂在 web/README.md §13（13.1–13.9）与 D017 / D020 的话上；不 import 页面实现、不读 pages/*.js 的内容。
// 引擎：agent-browser（本机没装 lightpanda，按「双引擎」判据转 agent-browser；这里只要行为 + 截图）。
//
// 起法：node evidence/p003-t017-verify/verify.mjs [--keep]
//   自己起真后端（server.js）+ 静态反向代理（web/serve.js）+ 一个 agent-browser 会话；跑完全杀，不留进程。
//   默认账号 hids / hids-2026（可用 HIDS_BASIC_AUTH_USER / HIDS_BASIC_AUTH_PASSWORD 覆盖）。
//   --keep 保留进程与浏览器（调试用）。
//
// 走的是真接口：列表与原文的期望值由 Node 侧直接 GET /api/rules(/:id) 取，页面必须和它逐字一致。

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER = process.env.HIDS_BASIC_AUTH_USER || 'hids';
const PASSWORD = process.env.HIDS_BASIC_AUTH_PASSWORD || 'hids-2026';
const KEEP = process.argv.includes('--keep');
const kids = [];
let failures = 0;
const ok = (label, extra = '') => console.log(`PASS ${label}${extra ? ' — ' + extra : ''}`);
const bad = (label, extra = '') => { failures += 1; console.log(`FAIL ${label}${extra ? ' — ' + extra : ''}`); };
const check = (cond, label, extra = '') => (cond ? ok(label, extra) : bad(label, extra));

const freePort = () => new Promise(resolve => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitHttp(url, { headers, timeoutMs = 15000, label } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { headers });
      await res.text();
      if (res.status < 500) return res.status;
    } catch { /* 还没起来 */ }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label} (${url})`);
    await sleep(100);
  }
}

function boot(cmd, args, env, label) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(child);
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  child.on('exit', code => { if (code && code !== 0) console.error(`[${label}] 退出 ${code}\n${log}`); });
  return child;
}

// agent-browser 的一条命令（每条命令一个进程，串行等它跑完）
function ab(session, args, { timeout = 60000 } = {}) {
  const out = execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return out.trim();
}
const abEval = (session, js) => JSON.parse(ab(session, ['eval', js]));

// 轮询页面直到 predicate 为真（不用 sleep 当等待）
const waitPage = (session, body, timeoutMs = 10000) => abEval(session, `new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const value = (() => { try { return (${body})(); } catch (e) { return null; } })();
    if (value !== null && value !== false && value !== undefined) return resolve(value);
    if (Date.now() - t0 > ${timeoutMs}) return reject(new Error('页面等待超时'));
    setTimeout(tick, 60);
  };
  tick();
})`);

async function main() {
  if (!existsSync(path.join(root, 'server.js'))) throw new Error(`不在工作树里：${root}`);
  const apiPort = await freePort();
  const webPort = await freePort();
  const session = `p017-verify-${webPort}`;
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const webBase = `http://127.0.0.1:${webPort}/`;
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');

  boot('node', ['server.js'], { HIDS_PORT: String(apiPort), HIDS_BASIC_AUTH_USER: USER, HIDS_BASIC_AUTH_PASSWORD: PASSWORD }, 'server.js');
  boot('node', ['web/serve.js'], { HIDS_API_ORIGIN: apiBase, HIDS_WEB_PORT: String(webPort), HIDS_WEB_HOST: '127.0.0.1' }, 'web/serve.js');
  await waitHttp(`${apiBase}/api/rules`, { headers: { Authorization: basic }, label: '真后端 /api/rules' });
  await waitHttp(webBase, { label: 'web 静态服务' });

  // 期望值直接来自真接口（页面必须与它逐字一致）
  const list = await (await fetch(`${apiBase}/api/rules`, { headers: { Authorization: basic } })).json();
  console.log(`真后端：${list.count} 条规则 [${list.rules.map(r => r.id).join(', ')}]`);

  try {
    // --args 只在首启生效（先 open 再 set viewport，反了会先起一个没有 --no-sandbox 的 Chrome）
    ab(session, ['open', webBase, '--args', '--no-sandbox']);
    ab(session, ['set', 'viewport', '1440', '900']);
    const loginClicked = abEval(session, `(() => {
      const inputs = [...document.querySelectorAll('input')];
      if (inputs.length < 2) return false;
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(inputs[0], ${JSON.stringify(USER)});
      set(inputs[1], ${JSON.stringify(PASSWORD)});
      const submit = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '登录');
      if (!submit) return false;
      submit.click();
      return true;
    })()`);
    check(loginClicked === true, '登录表单提交（真 /api/session）');
    await waitPage(session, `() => document.querySelector('nav a[href="#/rules"]') ? true : null`);
    ok('登录后进到壳里（真密码走 Basic）');

    // ── A1：进去先是五列列表 ────────────────────────────────────────────
    ab(session, ['eval', `location.hash = '#/rules'`]);
    const table = await waitPage(session, `() => {
      const rows = [...document.querySelectorAll('.rego-table tbody tr')];
      if (rows.length !== ${list.count}) return null;
      return {
        heads: [...document.querySelectorAll('.rego-table thead th')].map(th => th.textContent),
        rows: rows.map(tr => [...tr.children].map(td => td.textContent.trim())),
        total: document.querySelector('[data-role=total]')?.textContent,
        links: [...document.querySelectorAll('.rego-table tbody tr a')].map(a => a.getAttribute('href')),
        editable: document.querySelectorAll('input,textarea,select,[contenteditable]').length,
        forbidden: ['保存', '编辑', '提交', '删除', '新增'].filter(w => document.body.innerText.includes(w)),
        note: [...document.querySelectorAll('.rules-note,.rego-note')].map(n => n.textContent).join(''),
        caption: document.querySelector('.rego-table caption')?.textContent || '',
        thScope: [...document.querySelectorAll('.rego-table thead th')].every(th => th.getAttribute('scope') === 'col'),
        visibleButtons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
          .map(b => b.textContent.trim()).filter(t => !['退出登录', '深色', '浅色', '切换到深色模式', '切换到浅色模式'].includes(t))
      };
    }`);
    check(JSON.stringify(table.heads) === JSON.stringify(['名字', '一句话', '效果', '开没开', '从哪来']), 'A1 五列表头逐字', JSON.stringify(table.heads));
    check(table.rows.length === list.count && table.total === String(list.count), 'A1 行数与「共 N 条」', `rows=${table.rows.length} total=${table.total}`);
    const fieldOk = table.rows.every((row, i) => {
      const rule = list.rules[i];
      return row[0] === rule.name && row[1] === (rule.description ?? '未写说明')
        && row[2] === '放行' && row[3] === '开' && row[4] === '未标注';
    });
    check(fieldOk, 'A1 逐格字段（名字/一句话取接口，三列是展示默认 放行·开·未标注）', JSON.stringify(table.rows));
    check(table.links.length === list.count && table.links.every((href, i) => href === `#/rules/${list.rules[i].id}`), 'A1 名字是去原文页的真链接', JSON.stringify(table.links));
    check(table.editable === 0, 'A3 列表页无 input/textarea/select/[contenteditable]', `editable=${table.editable}`);
    check(table.forbidden.length === 0, 'A3 列表页不出现 保存/编辑/提交/删除/新增', JSON.stringify(table.forbidden));
    // 脚注原话：「效果、开没开、从哪来三列是展示默认：接口只给名字和一句话，这三项还没有数据。」
    check(/三列是展示默认/.test(table.note) && /还没有数据/.test(table.note), 'A1 三列展示默认有口径脚注', table.note.slice(0, 40));
    check(table.caption.length > 0 && table.thScope, '可访问性：caption + th scope=col', table.caption);
    check(JSON.stringify(table.visibleButtons) === JSON.stringify(['刷新']), 'A3 列表页可见按钮只有「刷新」', JSON.stringify(table.visibleButtons));

    // ── A2：点开是这段 Rego，原文逐字 ──────────────────────────────────
    const target = list.rules[0];
    const detail = await (await fetch(`${apiBase}/api/rules/${target.id}`, { headers: { Authorization: basic } })).json();
    ab(session, ['eval', `document.querySelector('a[href="#/rules/${target.id}"]').click()`]);
    const detailView = await waitPage(session, `() => {
      const pre = document.querySelector('pre[data-role=rego]');
      if (!pre || !pre.textContent.length) return null;
      return {
        hash: location.hash,
        pre: pre.textContent,
        h2: document.querySelector('h2')?.textContent,
        textarea: document.querySelectorAll('textarea').length,
        form: document.querySelectorAll('form').length,
        gutter: document.querySelectorAll('[data-role=gutter]').length,
        editable: document.querySelectorAll('input,textarea,select,[contenteditable]').length,
        forbidden: ['保存', '编辑', '提交', '删除', '新增'].filter(w => document.body.innerText.includes(w)),
        visibleButtons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
          .map(b => b.textContent.trim()).filter(t => !['退出登录', '深色', '浅色', '切换到深色模式', '切换到浅色模式'].includes(t)),
        whiteSpace: getComputedStyle(pre).whiteSpace
      };
    }`);
    check(detailView.hash === `#/rules/${target.id}`, 'A2 点名字进到这一条的原文', detailView.hash);
    check(detailView.pre === detail.rego, 'A2 pre.textContent 与接口 rego 逐字相等', `${detailView.pre.length}/${detail.rego.length} 字符`);
    check(detailView.h2 === target.name, 'A2 上面是名字', detailView.h2);
    check(detailView.textarea === 0 && detailView.form === 0 && detailView.gutter === 0, 'A2 不是 JSON、不是表单、没有行号栏',
      `textarea=${detailView.textarea} form=${detailView.form} gutter=${detailView.gutter}`);
    check(detailView.editable === 0, 'A3 原文页无 input/textarea/select/[contenteditable]', `editable=${detailView.editable}`);
    check(detailView.forbidden.length === 0, 'A3 原文页不出现 保存/编辑/提交/删除/新增', JSON.stringify(detailView.forbidden));
    check(JSON.stringify(detailView.visibleButtons) === JSON.stringify(['刷新']), 'A3 原文页可见按钮只有「刷新」', JSON.stringify(detailView.visibleButtons));
    check(detailView.whiteSpace === 'pre', 'A2 原文不被折行（white-space: pre）', detailView.whiteSpace);

    // ── 404 格：库里没有这条 ───────────────────────────────────────────
    ab(session, ['eval', `location.hash = '#/rules/no_such_rule_xyz'`]);
    const missing = await waitPage(session, `() => {
      const text = document.body.innerText;
      return text.includes('规则库里已没有这条') ? {
        text: text.replace(/\\s+/g, ' '),
        backLinks: [...document.querySelectorAll('a')].filter(a => a.getAttribute('href') === '#/rules').length,
        visibleRetry: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '重试' && b.offsetParent !== null),
        visiblePre: [...document.querySelectorAll('pre')].some(p => p.offsetParent !== null && p.textContent.length > 0)
      } : null;
    }`);
    check(missing.text.includes('no_such_rule_xyz') && missing.backLinks >= 1, '404 格：写「规则库里已没有这条」并给回列表的出口', `backLinks=${missing.backLinks}`);
    check(missing.visibleRetry === false, '404 格不摆读不出来的重试', `visibleRetry=${missing.visibleRetry}`);
    check(missing.visiblePre === false, '404 格没有假原文', `visiblePre=${missing.visiblePre}`);

    // ── 键盘：可聚焦元素全是原生链接/按钮，规则名与刷新都在序列里 ──────
    ab(session, ['eval', `location.hash = '#/rules'`]);
    await waitPage(session, `() => document.querySelectorAll('.rego-table tbody tr').length === ${list.count} || null`);
    const focusables = abEval(session, `(() => {
      const all = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')];
      return { total: all.length,
        nonNative: all.filter(el => !['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.tabIndex >= 0).length,
        ruleLinks: all.filter(el => (el.getAttribute('href') || '').startsWith('#/rules/')).length,
        refresh: all.filter(el => el.matches('[data-role=refresh]')).length };
    })()`);
    check(focusables.nonNative === 0, '键盘可达性：可聚焦元素全是原生链接/按钮（无自定义 Tab 拦截）', JSON.stringify(focusables));
    check(focusables.ruleLinks === list.count && focusables.refresh >= 1, '键盘可达性：每条规则名与刷新都在 Tab 序列里', JSON.stringify(focusables));

    // ── 截图作证：1440 与 390 两个宽度 ────────────────────────────────
    const shot = (name) => ab(session, ['screenshot', path.join('evidence/p003-t017-verify', name)]);
    shot('agent-rules-list-1440.png');
    ab(session, ['set', 'viewport', '390', '844']);
    await sleep(300);
    const narrow = abEval(session, `(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      wrapCW: document.querySelector('.table-wrap')?.clientWidth, wrapSW: document.querySelector('.table-wrap')?.scrollWidth,
      rows: document.querySelectorAll('.rego-table tbody tr').length }))()`);
    shot('agent-rules-list-390.png');
    check(narrow.sw === narrow.cw && narrow.sw <= 390, '窄屏 390：页面无整页横滚（表格在包裹层内横滚）', JSON.stringify(narrow));
    ab(session, ['eval', `location.hash = '#/rules/${target.id}'`]);
    await waitPage(session, `() => { const pre = document.querySelector('pre[data-role=rego]'); return pre && pre.textContent.length ? true : null; }`);
    shot('agent-rule-detail-390.png');
    const narrowDetail = abEval(session, `(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      preCW: document.querySelector('pre[data-role=rego]')?.clientWidth, preSW: document.querySelector('pre[data-role=rego]')?.scrollWidth }))()`);
    check(narrowDetail.sw === narrowDetail.cw, '窄屏 390 原文页：页面无整页横滚（原文在块内滚）', JSON.stringify(narrowDetail));

    const errors = ab(session, ['errors']);
    check(errors === '' || /no .*errors|0/i.test(errors), '整轮浏览器无页面 error', errors.slice(0, 160));
  } finally {
    if (!KEEP) { try { ab(session, ['close']); } catch { /* 会话已经没了 */ } }
  }
}

main()
  .catch(error => { failures += 1; console.log(`FAIL 运行中断：${error.message}`); })
  .finally(async () => {
    if (KEEP) console.log('--keep：进程保留');
    else for (const kid of kids.reverse()) { try { kid.kill('SIGKILL'); } catch { /* 已退 */ } }
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`);
    process.exit(failures === 0 ? 0 : 1);
  });
