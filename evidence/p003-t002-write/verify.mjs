#!/usr/bin/env node
// P003-T002 黑盒验收探针（e2e）· gc-backend-tester / 何东阳
//
// 判据来源：coding-reports/P003-T002.md 第 2 节「接口契约（实现口径）」+ 任务卡 A1–A4。
// 本文件不 import 任何产品模块；只起真 `node server.js` 子进程、发 HTTP、读产品自己落盘的文件。
//
// 用法：node evidence/p003-t002-write/verify.mjs
// 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 探针自身起不来。

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = process.cwd();
const account = { user: 'operator', password: 'op-pass' };
const adminToken = 'test-admin-token';
const basicHeader = `Basic ${Buffer.from(`${account.user}:${account.password}`).toString('base64')}`;
const PAGE = '/api/wiki/pages/honeypot%2FHP-01.md';

const results = [];
function check(id, ok, detail = '') {
  results.push({ id, ok: !!ok, detail });
  if (!ok) console.log(`FAIL ${id} ${detail}`);
  else console.log(`PASS ${id}${detail ? ' ' + detail : ''}`);
}
function section(name) { console.log(`\n## ${name}`); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function request(port, method, rawPath, { headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath,
      headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${method} ${rawPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const page = (body, opts = {}) => {
  const { id = 'HP-01', title = '蜜罐背景扫描', status = 'active', source = 'ENISA',
    evidence = '[_evidence/enisa-honeypot.md]' } = opts;
  const lines = ['---', `id: ${id}`, `title: ${title}`, `status: ${status}`];
  if (source !== null) lines.push(`source: ${source}`);
  if (evidence !== null) lines.push(`evidence: ${evidence}`);
  lines.push('---', '', body, '');
  return lines.join('\n');
};
const marker = '外网背景扫描必须核对请求。';

async function startServer(root) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HIDS_HOST: '127.0.0.1',
      HIDS_PORT: String(port),
      HIDS_BASIC_AUTH_USER: account.user,
      HIDS_BASIC_AUTH_PASSWORD: account.password,
      HIDS_PROMPT_ADMIN_TOKEN: adminToken,
      HIDS_WIKI_DIR: path.join(root, 'wiki'),
      HIDS_CASES_DIR: path.join(root, 'cases'),
      HIDS_SYSLOG_PORT: '0',
      HIDS_TRIAGE_INPUT_MODE: 'syslog',
      HIDS_SERVICE_URL: '',
      CLOUDWALKER_URL: '',
      CLOUDWALKER_TOKEN: '',
      LLM_BASE_URL: '',
      LLM_API_KEY: '',
      LLM_MODEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const res = await request(port, 'GET', '/api/session', { headers: { authorization: basicHeader }, timeoutMs: 1000 });
      if (res.status === 200) return { port, child, log: () => log };
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server not ready in 15s\n${log}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const t0 = Date.now();
  while (child.exitCode === null && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
  if (child.exitCode === null) child.kill('SIGKILL');
}

const hex16 = /^[0-9a-f]{16}$/;
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const errorShape = (text) => {
  const body = json(text);
  return body && typeof body.error === 'string' && body.error.length > 0;
};

const pageArtifacts = async (root) => {
  const pages = await readdir(path.join(root, 'wiki', 'honeypot'));
  const tmp = (await readdir(path.join(root, 'wiki'), { recursive: true }))
    .filter(name => name.includes('.tmp'));
  return { pages, tmp };
};

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'p003t002-e2e-'));
  let readOnlyDir = null;
  let server = null;
  try {
    await cp(path.join(repo, 'wiki'), path.join(root, 'wiki'), { recursive: true });
    await mkdir(path.join(root, 'cases'), { recursive: true });
    server = await startServer(root);
    const port = server.port;
    const getPage = async () => json((await request(port, 'GET', PAGE, { headers: { authorization: basicHeader } })).text);
    const put = async (rawPath, payload, extraHeaders = {}) => request(port, 'PUT', rawPath, {
      headers: { authorization: basicHeader, 'content-type': 'application/json', ...extraHeaders },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload)
    });

    // ================= A1 成功写回新 revision =================
    section('A1 控制台 Basic + expected_revision：200 回新 revision');
    const before = await getPage();
    check('A1.0 读页 200 且 revision 是 16 位十六进制', hex16.test(before?.revision || ''), `revision=${before?.revision}`);

    const savedRes = await put(PAGE, { content: page(marker), expected_revision: before.revision });
    const saved = json(savedRes.text);
    check('A1.1 200', savedRes.status === 200, `status=${savedRes.status} body=${savedRes.text.slice(0, 120)}`);
    check('A1.2 响应 id/path 正确', saved?.id === 'HP-01' && saved?.path === 'honeypot/HP-01.md', `id=${saved?.id} path=${saved?.path}`);
    check('A1.3 revision 是新的 16 位十六进制', hex16.test(saved?.revision || '') && saved.revision !== before.revision, `${before.revision} -> ${saved?.revision}`);
    check('A1.4 响应字段齐全（title/status/updated/characters/content）',
      typeof saved?.title === 'string' && typeof saved?.status === 'string' && typeof saved?.updated === 'string' &&
      typeof saved?.characters === 'number' && typeof saved?.content === 'string',
      `keys=${Object.keys(saved || {}).join(',')}`);
    check('A1.5 characters 等于 content 长度', saved?.characters === saved?.content?.length, `${saved?.characters} vs ${saved?.content?.length}`);
    check('A1.6 响应正文含写入内容', String(saved?.content || '').includes(marker));

    const onDisk = await readFile(path.join(root, 'wiki', 'honeypot', 'HP-01.md'), 'utf8');
    check('A1.7 落盘正文已更新', onDisk.includes(marker));
    const reread = await getPage();
    check('A1.8 GET 复读 revision 与新值一致', reread?.revision === saved?.revision, `${reread?.revision} vs ${saved?.revision}`);
    check('A1.9 GET 复读正文含写入内容', String(reread?.content || '').includes(marker));

    const historyFiles = await readdir(path.join(root, '.data', 'wiki-history')).catch(() => []);
    check('A1.10 旧版备份进 .data/wiki-history', historyFiles.some(name => name.includes(before.revision)),
      `history=${historyFiles.filter(n => n.includes(before.revision)).join(',') || '(none)'}`);
    const logText = await readFile(path.join(root, 'wiki', 'log.md'), 'utf8').catch(() => '');
    check('A1.11 log.md 记操作人 operator', /操作人 operator/.test(logText));
    check('A1.12 log.md 记新旧 revision', logText.includes(before.revision) && logText.includes(saved?.revision || '\u0000'));

    const listRes = await request(port, 'GET', '/api/wiki/pages', { headers: { authorization: basicHeader } });
    const listBody = json(listRes.text);
    check('A1.13 目录页仍可读且含 HP-01', listRes.status === 200 && Array.isArray(listBody?.pages) &&
      listBody.pages.some(p => p.id === 'HP-01'), `status=${listRes.status}`);

    // ================= A2 401 / 400 / 404 / 409 边界矩阵 =================
    section('A2 鉴权与入参边界（401/400/404/409）');
    const current = await getPage();
    const revisionNow = current.revision;

    const anonymous = await request(port, 'PUT', PAGE, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: page(marker + 'anon'), expected_revision: revisionNow })
    });
    check('A2.1 匿名 PUT 401', anonymous.status === 401, `status=${anonymous.status}`);
    check('A2.2 401 是纯文本「需要登录后访问」且带 WWW-Authenticate',
      anonymous.text.includes('需要登录后访问') && typeof anonymous.headers['www-authenticate'] === 'string',
      `ctype=${anonymous.headers['content-type']} www=${anonymous.headers['www-authenticate']}`);

    const wrongPass = await request(port, 'PUT', PAGE, {
      headers: { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: page(marker + 'wrong'), expected_revision: revisionNow })
    });
    check('A2.3 口令错 401', wrongPass.status === 401, `status=${wrongPass.status}`);

    const tokenOnly = await request(port, 'PUT', PAGE, {
      headers: { 'x-prompt-admin-token': adminToken, 'content-type': 'application/json' },
      body: JSON.stringify({ content: page(marker + 'token'), expected_revision: revisionNow })
    });
    check('A2.4 只带管理员令牌 401（写路径不认维护端令牌）', tokenOnly.status === 401, `status=${tokenOnly.status}`);

    const badBodies = [
      ['A2.5 expected_revision 缺失', rev => ({ content: page(marker) }), '缺少有效的页面版本'],
      ['A2.6 expected_revision=null', rev => ({ content: page(marker), expected_revision: null }), '缺少有效的页面版本'],
      ['A2.7 expected_revision 15 位', rev => ({ content: page(marker), expected_revision: '0'.repeat(15) }), '缺少有效的页面版本'],
      ['A2.8 expected_revision 17 位', rev => ({ content: page(marker), expected_revision: '0'.repeat(17) }), '缺少有效的页面版本'],
      ['A2.9 expected_revision 大写十六进制', rev => ({ content: page(marker), expected_revision: 'A'.repeat(16) }), '缺少有效的页面版本'],
      ['A2.10 expected_revision 非十六进制', rev => ({ content: page(marker), expected_revision: 'z'.repeat(16) }), '缺少有效的页面版本'],
      ['A2.11 expected_revision 是数字（类型错）', rev => ({ content: page(marker), expected_revision: 1234567890123456 }), '缺少有效的页面版本'],
      ['A2.12 content 缺失', rev => ({ expected_revision: rev }), '页面正文'],
      ['A2.13 content 空串', rev => ({ content: '', expected_revision: rev }), '页面正文'],
      ['A2.14 content 不是字符串', rev => ({ content: { text: marker }, expected_revision: rev }), '页面正文'],
      ['A2.15 content 30001 字', rev => ({ content: page('x'.repeat(30001)), expected_revision: rev }), '页面正文'],
      ['A2.16 content 含 \\0', rev => ({ content: page('前文\u0000后文'), expected_revision: rev }), '页面正文'],
      ['A2.17 content 改了 id', rev => ({ content: page(marker, { id: 'HP-02' }), expected_revision: rev }), '页面 ID 必须保持一致'],
      ['A2.18 content 状态不在枚举', rev => ({ content: page(marker, { status: 'archived' }), expected_revision: rev }), '页面 ID 必须保持一致']
    ];
    for (const [id, build, hint] of badBodies) {
      const revBefore = (await getPage()).revision;
      const res = await put(PAGE, build(revBefore));
      check(`${id} → 400`, res.status === 400, `status=${res.status} body=${res.text.slice(0, 120)}`);
      check(`${id} 错误体 {error:string}`, errorShape(res.text), res.text.slice(0, 120));
      if (hint) check(`${id} 文案含「${hint}」`, String(json(res.text)?.error || '').includes(hint), String(json(res.text)?.error || ''));
      if (res.status !== 400) check(`${id} 被拒后页面未变`, (await getPage()).revision === revBefore, `revision ${revBefore} -> ${(await getPage()).revision}`);
    }

    // 出处规则以 docs/modules/knowledge-base.md:299（R-KB-03）/ :325 为准：
    //   「判据页要有 evidence: 或 source: 之一；两个都没有 → 400「判据需要 evidence 或 source 出处」」
    // 所以单缺一条应当能写、两条都缺才是 400。用 HP-02 单独验，避免 409 级联。
    const hp02Path = '/api/wiki/pages/honeypot%2FHP-02.md';
    const hp02Raw = await readFile(path.join(root, 'wiki', 'honeypot', 'HP-02.md'), 'utf8');
    const stripLine = (text, name) => text.split('\n').filter(line => !line.startsWith(name + ':')).join('\n');
    const hp02Now = async () => json((await request(port, 'GET', hp02Path, { headers: { authorization: basicHeader } })).text);
    for (const [id, strips, expected] of [
      ['A2.19 只缺 source（有 evidence）应可写', ['source'], 200],
      ['A2.20 只缺 evidence（有 source）应可写', ['evidence'], 200]
    ]) {
      const hp02 = await hp02Now();
      let variant = hp02Raw;
      for (const name of strips) variant = stripLine(variant, name);
      const res = await put(hp02Path, { content: variant, expected_revision: hp02.revision });
      check(`${id} → ${expected}`, res.status === expected, `status=${res.status} body=${res.text.slice(0, 140)}`);
      if (res.status === 200) {
        const restored = await put(hp02Path, { content: hp02Raw, expected_revision: json(res.text).revision });
        check(`${id} 验完已写回原文`, restored.status === 200, `status=${restored.status}`);
      }
    }
    {
      const hp02 = await hp02Now();
      const bothGone = stripLine(stripLine(hp02Raw, 'source'), 'evidence');
      const res = await put(hp02Path, { content: bothGone, expected_revision: hp02.revision });
      check('A2.20b evidence 与 source 都缺 → 400 + {error}', res.status === 400 && errorShape(res.text), `status=${res.status} body=${res.text.slice(0, 140)}`);
      if (res.status === 400) check('A2.20c 文案含「判据需要 evidence 或 source 出处」',
        String(json(res.text)?.error || '').includes('判据需要 evidence 或 source 出处'), String(json(res.text)?.error || ''));
      check('A2.20d 被拒后 HP-02 未变', (await hp02Now()).revision === hp02.revision, '');
    }

    // 正边界：正文恰好 30000 字应当收（契约：1 到 30000 字）
    {
      const revBefore = (await getPage()).revision;
      const base = page(marker);
      const p30000 = page(marker + 'x'.repeat(30000 - base.length));
      check('A2.31 正文恰好 30000 字（长度 ' + p30000.length + '）→ 200',
        (await put(PAGE, { content: p30000, expected_revision: revBefore })).status === 200, '');
      const p30000b = page(marker + 'x'.repeat(30000 - base.length));
      check('A2.31b 正文长度确为 30000', p30000b.length === 30000, `len=${p30000b.length}`);
    }
    // 正文没有 frontmatter 头部 → 400
    {
      const revBefore = (await getPage()).revision;
      const res = await put(PAGE, { content: marker, expected_revision: revBefore });
      check('A2.32 正文缺 frontmatter → 400 + {error}', res.status === 400 && errorShape(res.text), `status=${res.status} body=${res.text.slice(0, 120)}`);
    }

    const revNow = (await getPage()).revision;
    const logBeforeRejects = await readFile(path.join(root, 'wiki', 'log.md'), 'utf8').catch(() => '');
    const invalidJson = await put(PAGE, '{not json');
    check('A2.21 非法 JSON → 400 + {error}', invalidJson.status === 400 && errorShape(invalidJson.text), `status=${invalidJson.status} body=${invalidJson.text.slice(0, 80)}`);

    const huge = await put(PAGE, JSON.stringify({ content: 'x'.repeat(130000), expected_revision: revNow }));
    check('A2.22 正文超限 → 400 + {error}', huge.status === 400 && errorShape(huge.text), `status=${huge.status} body=${huge.text.slice(0, 80)}`);

    const escapePaths = ['..%2Fserver.js', 'honeypot%2F..%2F..%2Fserver.js', '%2Fetc%2Fpasswd',
      'docs%2Findex.md', 'honeypot%2FHP-01.txt'];
    for (const escape of escapePaths) {
      const res = await put(`/api/wiki/pages/${escape}`, { content: page(marker), expected_revision: revNow });
      check(`A2.23 路径越界/非判据页 ${escape} → 400 + {error}`,
        res.status === 400 && errorShape(res.text), `status=${res.status} body=${res.text.slice(0, 100)}`);
    }
    const badEncoding = await put('/api/wiki/pages/honeypot%2F%ZZ.md', { content: page(marker), expected_revision: revNow });
    check('A2.24 URI 编码坏 → 400 + {error}', badEncoding.status === 400 && errorShape(badEncoding.text), `status=${badEncoding.status} body=${badEncoding.text.slice(0, 100)}`);
    const emptyPath = await put('/api/wiki/pages/', { content: page(marker), expected_revision: revNow });
    check('A2.25 空页面路径 → 400 + {error}', emptyPath.status === 400 && errorShape(emptyPath.text), `status=${emptyPath.status} body=${emptyPath.text.slice(0, 100)}`);

    const missing = await put('/api/wiki/pages/honeypot%2FHP-99.md',
      { content: page(marker, { id: 'HP-99' }), expected_revision: revNow });
    check('A2.26 页面不存在 → 404 + {error}', missing.status === 404 && errorShape(missing.text), `status=${missing.status} body=${missing.text.slice(0, 120)}`);

    const stale = await put(PAGE, { content: page(marker + 'stale'), expected_revision: '0'.repeat(16) });
    check('A2.27 旧 revision → 409 + {error}', stale.status === 409 && errorShape(stale.text), `status=${stale.status} body=${stale.text.slice(0, 120)}`);
    const afterRejects = await getPage();
    check('A2.28 被拒请求（400/404/409）一条也没改页面', afterRejects?.revision === revNow, `${revNow} -> ${afterRejects?.revision}`);
    const logAfterRejects = await readFile(path.join(root, 'wiki', 'log.md'), 'utf8').catch(() => '');
    check('A2.28b 被拒请求没有往 log.md 写记录', logAfterRejects === logBeforeRejects,
      `log ${logBeforeRejects.length} -> ${logAfterRejects.length} 字符`);

    section('A2 回归：方法/身份口径边界（不是本卡新增语义）');
    const postBasic = await request(port, 'POST', PAGE, {
      headers: { authorization: basicHeader, 'content-type': 'application/json' }, body: '{}'
    });
    check('A2.29 POST 该路径只带 Basic → 403（维护端令牌闸）', postBasic.status === 403, `status=${postBasic.status} body=${postBasic.text.slice(0, 100)}`);
    const postToken = await request(port, 'POST', PAGE, {
      headers: { authorization: basicHeader, 'x-prompt-admin-token': adminToken, 'content-type': 'application/json' }, body: '{}'
    });
    check('A2.30 POST 该路径带 Basic+令牌 → 404 知识库接口不存在', postToken.status === 404 && errorShape(postToken.text), `status=${postToken.status} body=${postToken.text.slice(0, 100)}`);

    // ================= A3 原子写 / 队列 / 并发 =================
    section('A3 失败不留半篇、队列不卡死、同版本并发一成一 409');
    const base3 = await getPage();
    const diskBefore = await readFile(path.join(root, 'wiki', 'honeypot', 'HP-01.md'), 'utf8');
    const folder = path.join(root, 'wiki', 'honeypot');
    readOnlyDir = folder;
    await chmod(folder, 0o500);
    const failed = await put(PAGE, { content: page(marker + 'FAILED-WRITE'), expected_revision: base3.revision });
    check('A3.1 只读目录下写失败 → 非 2xx（实际按存储错误口径）', failed.status >= 400 && failed.status < 500,
      `status=${failed.status} body=${failed.text.slice(0, 120)}`);
    const afterFailDisk = await readFile(path.join(root, 'wiki', 'honeypot', 'HP-01.md'), 'utf8');
    check('A3.2 失败后盘上正文一字未变', afterFailDisk === diskBefore);
    const artifacts1 = await pageArtifacts(root);
    check('A3.3 失败后目录里没有 .tmp 残留、HP-01 仍在', artifacts1.tmp.length === 0 && artifacts1.pages.includes('HP-01.md'),
      `pages=${artifacts1.pages.length} 个 tmp=${artifacts1.tmp.join(',') || '(none)'}`);
    await chmod(folder, 0o700);
    readOnlyDir = null;
    const recovered = await put(PAGE, { content: page(marker + 'RECOVERED'), expected_revision: base3.revision });
    check('A3.4 失败没有卡死串行写队列（下一次同版本写入 200）', recovered.status === 200, `status=${recovered.status} body=${recovered.text.slice(0, 120)}`);
    const recoveredPage = json(recovered.text);

    const raceRevision = recoveredPage?.revision;
    const [raceA, raceB] = await Promise.all([
      put(PAGE, { content: page(marker + 'RACE-A'), expected_revision: raceRevision }),
      put(PAGE, { content: page(marker + 'RACE-B'), expected_revision: raceRevision })
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort((a, b) => a - b);
    check('A3.5 同版本并发两次提交 → 一次 200 一次 409', raceStatuses.join(',') === '200,409', `statuses=${raceA.status},${raceB.status}`);
    const loser = raceA.status === 409 ? raceA : raceB;
    if (loser.status === 409) check('A3.6 并发落败方错误体 {error:string}', errorShape(loser.text), loser.text.slice(0, 120));
    const winner = raceA.status === 200 ? raceA : raceB;
    const winnerBody = json(winner.text);
    const finalPage = await getPage();
    check('A3.7 最终页面等于胜出请求的正文', finalPage?.revision === winnerBody?.revision && finalPage?.content === winnerBody?.content,
      `revision=${finalPage?.revision} vs ${winnerBody?.revision}`);
    const artifacts2 = await pageArtifacts(root);
    check('A3.8 并发后无 .tmp 残留、HP-01 仍在', artifacts2.tmp.length === 0 && artifacts2.pages.includes('HP-01.md'),
      `pages=${artifacts2.pages.length} 个 tmp=${artifacts2.tmp.join(',') || '(none)'}`);

    // ================= A4 身份口径 =================
    section('A4 写路径只认控制台 Basic，管理员令牌仍归会话族');
    const sessionsBasic = await request(port, 'GET', '/api/wiki/sessions', { headers: { authorization: basicHeader } });
    check('A4.1 Basic 读会话仍 403（两套身份没并成一套）', sessionsBasic.status === 403 && errorShape(sessionsBasic.text),
      `status=${sessionsBasic.status} body=${sessionsBasic.text.slice(0, 100)}`);
    const sessionsBoth = await request(port, 'GET', '/api/wiki/sessions', {
      headers: { authorization: basicHeader, 'x-prompt-admin-token': adminToken }
    });
    check('A4.2 Basic+令牌读会话 200（会话族口径未变）', sessionsBoth.status === 200 && Array.isArray(json(sessionsBoth.text)?.sessions),
      `status=${sessionsBoth.status}`);
    const healthBasic = await request(port, 'GET', '/api/wiki/health', { headers: { authorization: basicHeader } });
    check('A4.3 Basic 读 health 仍 403（health 归令牌）', healthBasic.status === 403, `status=${healthBasic.status}`);
    const readTokenOnly = await request(port, 'GET', PAGE, { headers: { 'x-prompt-admin-token': adminToken } });
    check('A4.4 只带令牌读页 401（读路径仍认 Basic）', readTokenOnly.status === 401, `status=${readTokenOnly.status}`);
    const logFinal = await readFile(path.join(root, 'wiki', 'log.md'), 'utf8').catch(() => '');
    const operatorLines = (logFinal.match(/操作人 operator/g) || []).length;
    check('A4.5 身份唯一来源：log.md 只有 operator，没有第二个身份', operatorLines >= 2 && !/操作人 (?!operator)/.test(logFinal), `operator 行数=${operatorLines}`);

    // A1 的仓库源文件没被碰（用的是临时 wiki）
    check('A1.14 探针只写临时 wiki，仓内 wiki/ 未被改动',
      !(await readFile(path.join(repo, 'wiki', 'honeypot', 'HP-01.md'), 'utf8')).includes(marker));
  } finally {
    if (readOnlyDir) await chmod(readOnlyDir, 0o700).catch(() => {});
    if (server) await stopServer(server.child);
    await rm(root, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n# probes ${results.length} / pass ${results.length - failed.length} / fail ${failed.length}`);
  console.log(`# server log tail:\n${(server?.log?.() || '').split('\n').slice(-8).join('\n')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.error('PROBE CRASH', error);
  process.exitCode = 2;
});
