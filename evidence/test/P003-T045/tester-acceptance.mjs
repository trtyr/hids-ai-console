// 何东阳的独立黑盒探针（P003-T045 测试席，2026-11-20）。
// 判据只认契约：docs/modules/http-api.md §3.8（两条路由的字段/参数/失败口径）、§4（Basic 认证）、
// §7（分页）；openapi.yaml 的 getLogs / cleanLogs / LogEntry / LogQueryResult / LogCleanupRequest /
// LogCleanupResult；docs/architecture.md §3.6（事件名与字段：http.request / log.cleaned）；
// .env.example（三个键 + 头部键数）。
// 做法：真进程 server.js + 真 HTTP + 真磁盘；全部在 mkdtemp 里，跑完自清。
// 不读实现内容：请求与断言全部照文档造，响应与盘上变化是唯一判据。
//
// 跑法：node evidence/test/P003-T045/tester-acceptance.mjs
// 输出：OK / MISS 逐条（MISS 计数 > 0 → exit 1）；INFO 是文档没写死、只记录现象的观察（不判红）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AUTH = { user: 'ops', password: 'fake-pass-abcdef' };
const AUTHORIZATION = `Basic ${Buffer.from(`${AUTH.user}:${AUTH.password}`).toString('base64')}`;
const ROTATED_NAME = /^hids\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-\d+)?\.log$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

let miss = 0;
let count = 0;
const ok = (name, cond, detail) => { count += 1; if (!cond) miss += 1; console.log(`${cond ? 'OK  ' : 'MISS'} ${name} :: ${detail}`); };
const info = (name, detail) => console.log(`INFO ${name} :: ${detail}`);

const sleeps = () => new Promise(resolve => setTimeout(resolve, 25));

async function makeRoot(tag) {
  return mkdtemp(path.join(tmpdir(), `t045-${tag}-`));
}

// 先借一个空闲端口：server.started 的 port 就是真监听端口，fetch 才连得上。
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 真进程启动：docs §3.8.1 的 env 键 + T025 闸门必填五项；HIDS_PORT=0 由 server.started 报端口。
async function boot(tag, { file, maxBytes, keep } = {}) {
  const root = await makeRoot(tag);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HIDS_HOST: '127.0.0.1',
    HIDS_PORT: '0',
    HIDS_DATA_DIR: path.join(root, 'data'),
    CLOUDWALKER_URL: 'http://127.0.0.1:1',
    CLOUDWALKER_API_TOKEN: 'fake-token-123456',
    LLM_BASE_URL: 'http://127.0.0.1:1/v1',
    LLM_API_KEY: 'fake-key-abcdef',
    LLM_MODEL: 'fake-model',
    HIDS_TRIAGE_INPUT_MODE: 'poll',
    HIDS_BASIC_AUTH_USER: AUTH.user,
    HIDS_BASIC_AUTH_PASSWORD: AUTH.password
  };
  if (file) env.HIDS_LOG_FILE = file;
  if (maxBytes !== undefined) env.HIDS_LOG_MAX_BYTES = String(maxBytes);
  if (keep !== undefined) env.HIDS_LOG_KEEP = String(keep);
  env.HIDS_PORT = String(await freePort());
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { stdout: '', stderr: '', lines: [] };
  let carry = '';
  child.stdout.on('data', chunk => {
    seen.stdout += chunk;
    carry += chunk;
    let cut;
    while ((cut = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, cut);
      carry = carry.slice(cut + 1);
      if (!line.trim()) continue;
      try { seen.lines.push(JSON.parse(line)); } catch { seen.lines.push({ unparsed: line }); }
    }
  });
  child.stderr.on('data', chunk => { seen.stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    await rm(root, { recursive: true, force: true });
  };
  const deadline = Date.now() + 15000;
  let started = null;
  while (!started) {
    started = seen.lines.find(line => line.event === 'server.started') ?? null;
    if (started) break;
    if (child.exitCode !== null) throw new Error(`server 起不来：exit=${child.exitCode} stderr=${seen.stderr}`);
    if (Date.now() > deadline) throw new Error(`15s 内等不到 server.started：stdout=${seen.stdout.slice(-500)} stderr=${seen.stderr.slice(-500)}`);
    await sleeps();
  }
  return { root, file, child, seen, stop, port: started.port, base: `http://127.0.0.1:${started.port}` };
}

async function request(base, method, pathname, { body, headers = {}, auth = true, raw = false } = {}) {
  const allHeaders = { ...headers };
  if (auth) allHeaders.Authorization = AUTHORIZATION;
  if (body !== undefined && !('Content-Type' in allHeaders)) allHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method, headers: allHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, headers: response.headers, text, body: parsed, raw };
}
const getLogs = (base, query = '', options) => request(base, 'GET', `/api/logs${query}`, options);
const cleanLogs = (base, body, options) => request(base, 'POST', '/api/logs/cleanup', { body, ...options });

const jsonLine = (time, event, fields = {}, level = 'info') => `${JSON.stringify({ time, level, event, ...fields })}\n`;
async function appendLines(file, lines) { await appendFile(file, lines.join('')); }
async function readJsonLines(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { return { __bad: index, text: line }; }
  });
}
async function names(dir) { return (await readdir(dir)).sort(); }
const rotatedOf = list => list.filter(name => ROTATED_NAME.test(name));

// 边车断言：错误体形状（docs §3.8.3 失败口径表：全部 caller_error / not_configured + 中文 error）
function assertCallerError(name, response, message) {
  ok(`${name} 状态 400`, response.status === 400, `status=${response.status} body=${response.text.slice(0, 200)}`);
  ok(`${name} 正文 {error, code:'caller_error'}`, response.body && response.body.code === 'caller_error' && typeof response.body.error === 'string',
    JSON.stringify(response.body));
  if (message !== undefined) ok(`${name} 文案`, response.body?.error === message, `实际 ${JSON.stringify(response.body?.error)} ≠ ${JSON.stringify(message)}`);
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  // A1：配了路径就同份落文件（盘 + stdout 都能看见 server.started）；不配＝无文件可读（503）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('a1');
    const file = path.join(root, 'hids.log');
    const s = await boot('a1-live', { file });
    try {
      const onDisk = await readJsonLines(file);
      const started = onDisk.find(line => line.event === 'server.started');
      ok('A1 配有 HIDS_LOG_FILE：server.started 落进文件', Boolean(started), `文件里 ${onDisk.length} 行，事件=${onDisk.map(l => l.event).join(',')}`);
      ok('A1 server.started 行有 host/port（architecture §3.6 事件表）',
        started?.host === '127.0.0.1' && Number.isInteger(started?.port),
        JSON.stringify(started));
      const stdoutStarted = s.seen.lines.find(line => line.event === 'server.started');
      ok('A1 同份：stdout 也有 server.started 且 port 与文件一致',
        Boolean(stdoutStarted) && stdoutStarted.port === started?.port,
        `stdout=${JSON.stringify(stdoutStarted)} 文件=${JSON.stringify(started)}`);
      ok('A1 落盘行形状：time/level/event 三键 + 行内 JSON 可解析',
        typeof started?.time === 'string' && ISO.test(started.time) && ['info', 'warn', 'error'].includes(started.level),
        JSON.stringify(started));
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // 不配 HIDS_LOG_FILE：两条路由都回 503 not_configured（不拿空列表冒充「没有日志」）
  {
    const s = await boot('unconfigured');
    try {
      const list = await getLogs(s.base);
      ok('未配：GET /api/logs 503', list.status === 503, `status=${list.status} body=${list.text}`);
      ok('未配：GET /api/logs 正文 {error, code:not_configured}',
        list.body?.code === 'not_configured' && list.body?.error === '日志未落盘：未配置 HIDS_LOG_FILE',
        JSON.stringify(list.body));
      const clean = await cleanLogs(s.base, { max_bytes: 0 });
      ok('未配：POST /api/logs/cleanup 503', clean.status === 503, `status=${clean.status} body=${clean.text}`);
      ok('未配：cleanup 正文 {error, code:not_configured}',
        clean.body?.code === 'not_configured' && clean.body?.error === '日志未落盘：未配置 HIDS_LOG_FILE',
        JSON.stringify(clean.body));
    } finally { await s.stop(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 鉴权：两条路由都在 Basic 闸门后（§3.8.3「与其它业务路由同一个 Basic 闸门」+ §4 的 401 形状）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('auth');
    const file = path.join(root, 'hids.log');
    const s = await boot('auth', { file });
    try {
      for (const [name, call] of [
        ['GET /api/logs', () => getLogs(s.base, '', { auth: false })],
        ['POST /api/logs/cleanup', () => cleanLogs(s.base, { max_bytes: 0 }, { auth: false })]
      ]) {
        const r = await call();
        ok(`鉴权：${name} 无凭据 401`, r.status === 401, `status=${r.status} body=${r.text.slice(0, 120)}`);
        ok(`鉴权：${name} 正文是纯文本「需要登录后访问」（不是 JSON 错误体）`,
          r.text.trim() === '需要登录后访问' && /text\/plain/.test(r.headers.get('content-type') ?? ''),
          `content-type=${r.headers.get('content-type')} body=${JSON.stringify(r.text)}`);
        ok(`鉴权：${name} 四条头（WWW-Authenticate / no-store / nosniff）`,
          r.headers.get('www-authenticate') === 'Basic realm="HIDS AI Console", charset="UTF-8"' &&
          r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff',
          JSON.stringify([...r.headers.entries()]));
      }
      const wrong = await getLogs(s.base, '', { headers: { Authorization: `Basic ${Buffer.from('ops:nope').toString('base64')}` }, auth: false });
      ok('鉴权：错口令 401', wrong.status === 401, `status=${wrong.status}`);
      const good = await getLogs(s.base);
      ok('鉴权：正确凭据 200', good.status === 200, `status=${good.status}`);
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A3/schema：GET /api/logs 响应逐字段 + 读盘 + 过滤（event/level/from/to 闭区间）+ 分页
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('query');
    const file = path.join(root, 'hids.log');
    const s = await boot('query', { file });
    try {
      const T = ['2026-11-20T00:00:01.000Z', '2026-11-20T00:00:02.000Z', '2026-11-20T00:00:03.000Z',
        '2026-11-20T00:00:04.000Z', '2026-11-20T00:00:05.000Z'];
      // 直接往盘上追加：docs §3.8.2「读的是盘上的文件……人手写的空行直接跳过」
      await appendLines(file, [
        jsonLine(T[0], 'probe.range', { i: 1 }, 'info'),
        jsonLine(T[1], 'probe.range', { i: 2 }, 'warn'),
        jsonLine(T[2], 'probe.range', { i: 3 }, 'error'),
        jsonLine(T[3], 'probe.range', { i: 4 }, 'info'),
        jsonLine(T[4], 'probe.range', { i: 5 }, 'info'),
        jsonLine(T[0], 'probe.other', { i: 9 }),
        '{不是完整的一行\n',
        '\n'
      ]);

      const all = await getLogs(s.base, '?event=probe.range');
      ok('schema：200 + application/json + total 5', all.status === 200 && /application\/json/.test(all.headers.get('content-type') ?? '') && all.body.total === 5,
        `status=${all.status} ct=${all.headers.get('content-type')} total=${all.body?.total}`);
      const required = ['logs', 'total', 'files', 'truncated', 'echo'];
      ok('schema：LogQueryResult 五个必填键齐全', required.every(key => key in (all.body ?? {})), Object.keys(all.body ?? {}).join(','));
      ok('schema：logs 是数组、每页 ≤50、total/files/truncated 类型对',
        Array.isArray(all.body.logs) && all.body.logs.length === 5 && Number.isInteger(all.body.total) &&
        Number.isInteger(all.body.files) && typeof all.body.truncated === 'boolean',
        JSON.stringify({ len: all.body.logs.length, total: all.body.total, files: all.body.files, truncated: all.body.truncated }));
      const entry = all.body.logs[0];
      ok('schema：LogEntry 每行 time/level/event 三键且类型对（含倒序首条 = 最新）',
        all.body.logs.every(l => ISO.test(l.time) && ['info', 'warn', 'error'].includes(l.level) && typeof l.event === 'string') &&
        all.body.logs[0].time === T[4],
        JSON.stringify(all.body.logs.map(l => [l.time, l.level, l.event])));
      ok('A3 倒序：time 新的在前', all.body.logs.map(l => l.i).join(',') === '5,4,3,2,1', all.body.logs.map(l => l.i).join(','));
      ok('schema：echo 回显缺省分页 count=20 / offset=0',
        all.body.echo?.count === 20 && all.body.echo?.offset === 0, JSON.stringify(all.body.echo));
      ok('A3 读盘：绕过 server 直接落到盘上的行也查得到（不是内存缓存）',
        all.body.logs.some(l => l.event === 'probe.range' && l.i === 5), JSON.stringify(all.body.logs.map(l => l.event)));
      ok('A3 坏行容错：半行/空行跳过不报错（total 仍 5）', all.body.total === 5, `total=${all.body.total}`);

      const pages = await getLogs(s.base, '?event=probe.range&count=2&offset=1');
      ok('A3 分页：count=2&offset=1 → 第 2、3 条，total 仍是筛选后切页前 5',
        pages.body.logs.map(l => l.i).join(',') === '4,3' && pages.body.total === 5 &&
        pages.body.echo.count === 2 && pages.body.echo.offset === 1,
        JSON.stringify({ got: pages.body.logs.map(l => l.i), total: pages.body.total, echo: pages.body.echo }));
      const maxPage = await getLogs(s.base, '?event=probe.range&count=50');
      ok('A3 边界：count=50（上限）200', maxPage.status === 200 && maxPage.body.echo.count === 50, `status=${maxPage.status} echo=${JSON.stringify(maxPage.body.echo)}`);
      const minPage = await getLogs(s.base, '?event=probe.range&count=1');
      ok('A3 边界：count=1（下限）200', minPage.status === 200 && minPage.body.logs.length === 1, `status=${minPage.status} len=${minPage.body.logs.length}`);

      // §7 明写「参数缺省与传空串都落回缺省值」：空串不是 400，是缺省
      const emptyCount = await getLogs(s.base, '?event=probe.range&count=&offset=');
      ok('A3/§7 空串落回缺省：?count=&offset= → 200 + echo {20,0}',
        emptyCount.status === 200 && emptyCount.body?.echo?.count === 20 && emptyCount.body?.echo?.offset === 0,
        `status=${emptyCount.status} echo=${JSON.stringify(emptyCount.body?.echo)}`);
      for (const query of ['?count=0', '?count=51', '?count=abc', '?count=20.5', '?offset=-1', '?offset=abc', '?offset=1.5']) {
        assertCallerError(`分页非法 ${query}`, await getLogs(s.base, query), '分页参数无效');
      }

      const levelMulti = await getLogs(s.base, '?event=probe.range&level=warn,error');
      ok('A3 level 逗号多选：warn,error → 2 条', levelMulti.status === 200 && levelMulti.body.logs.map(l => l.i).join(',') === '3,2',
        `status=${levelMulti.status} got=${levelMulti.body?.logs?.map(l => l.i)}`);
      const levelUpper = await getLogs(s.base, '?event=probe.range&level=INFO');
      ok('A3 level 大小写不敏感：INFO → info 的 3 条', levelUpper.status === 200 && levelUpper.body.total === 3,
        `status=${levelUpper.status} total=${levelUpper.body?.total} body=${levelUpper.text.slice(0, 160)}`);
      const levelMixed = await getLogs(s.base, '?event=probe.range&level=Info,WARN');
      ok('A3 level 混合大小写多选：Info,WARN → 4 条', levelMixed.status === 200 && levelMixed.body.total === 4,
        `status=${levelMixed.status} total=${levelMixed.body?.total}`);
      const levelBad = await getLogs(s.base, '?level=trace');
      assertCallerError('level 表外值 trace', levelBad, '筛选等级无效：trace');

      const closedFrom = await getLogs(s.base, `?event=probe.range&from=${T[1]}`);
      ok('A3 from 闭区间（含端点）：from=T2 → 2,3,4,5', closedFrom.body.logs.map(l => l.i).join(',') === '5,4,3,2',
        closedFrom.body?.logs?.map(l => l.i).join(','));
      const closedTo = await getLogs(s.base, `?event=probe.range&to=${T[1]}`);
      ok('A3 to 闭区间（含端点）：to=T2 → 2,1', closedTo.body.logs.map(l => l.i).join(',') === '2,1',
        closedTo.body?.logs?.map(l => l.i).join(','));
      const sameMoment = await getLogs(s.base, `?event=probe.range&from=${T[1]}&to=${T[1]}`);
      ok('A3 恰好一刻：from=to=T2 → 只 2', sameMoment.body.logs.map(l => l.i).join(',') === '2', sameMoment.body?.logs?.map(l => l.i).join(','));
      const unixSecond = Math.floor(Date.parse(T[1]) / 1000);
      const unixFrom = await getLogs(s.base, `?event=probe.range&from=${unixSecond}`);
      ok('A3 from 接受 Unix 秒（文档：ISO 8601 或 Unix 秒/毫秒）', unixFrom.status === 200 && unixFrom.body.total === 4,
        `status=${unixFrom.status} total=${unixFrom.body?.total} body=${unixFrom.text.slice(0, 160)}`);
      assertCallerError('from=yesterday', await getLogs(s.base, '?from=yesterday'), '筛选起始时间无效：yesterday');
      assertCallerError('to=nope', await getLogs(s.base, '?to=nope'), '筛选结束时间无效：nope');
      assertCallerError('from > to', await getLogs(s.base, `?from=${T[4]}&to=${T[0]}`), '筛选起始时间晚于结束时间');

      const unknownEvent = await getLogs(s.base, '?event=probe.no-such-event');
      ok('A3 event 不做取值校验：表外事件名 → 200 空列表（不是 400）',
        unknownEvent.status === 200 && unknownEvent.body.total === 0 && unknownEvent.body.logs.length === 0,
        `status=${unknownEvent.status} body=${unknownEvent.text.slice(0, 160)}`);

      // files 是「这次读了几个文件」：造一个文档口径的轮转历史文件，同名事件应被算进 files
      await writeFile(path.join(root, 'hids.2026-11-20T00-00-00-000Z.log'), jsonLine('2026-11-20T00:00:00.500Z', 'probe.rotated', { i: 77 }));
      const withHistory = await getLogs(s.base, '?event=probe.rotated');
      ok('A3 files 计入轮转历史文件：历史文件里的行查得到且 files ≥ 2',
        withHistory.status === 200 && withHistory.body.total === 1 && withHistory.body.files >= 2,
        `status=${withHistory.status} total=${withHistory.body?.total} files=${withHistory.body?.files}`);

      info('GET 未知参数', JSON.stringify((await getLogs(s.base, '?event=probe.range&nope=1')).body?.error ?? '（无错）'));
      info('GET event= 空串', JSON.stringify((await getLogs(s.base, '?event=')).body?.total));
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 上限 truncated：命中 20000 条不变红、20001 条才 truncated:true（docs §3.8.2 上限段）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('cap');
    const file = path.join(root, 'hids.log');
    await writeFile(file, '');
    const s = await boot('cap', { file, maxBytes: 50 * 1024 * 1024 });
    try {
      const base = Date.parse('2026-11-19T00:00:00.000Z');
      const bulk = (event, n) => {
        const out = [];
        for (let i = 0; i < n; i += 1) out.push(jsonLine(new Date(base + i).toISOString(), event, { i }));
        return out;
      };
      await appendLines(file, bulk('probe.exact', 20000));
      const exact = await getLogs(s.base, '?event=probe.exact&count=50');
      ok('上限边界：命中恰好 20000 → truncated:false、total 20000',
        exact.body?.total === 20000 && exact.body?.truncated === false && exact.body.logs.length === 50,
        JSON.stringify({ total: exact.body?.total, truncated: exact.body?.truncated, len: exact.body?.logs?.length }));
      await appendLines(file, bulk('probe.over', 20001));
      const over = await getLogs(s.base, '?event=probe.over&count=50');
      ok('上限边界：命中 20001 → truncated:true、total 20000（只收前 20000）',
        over.body?.total === 20000 && over.body?.truncated === true && over.body.logs.length === 50,
        JSON.stringify({ total: over.body?.total, truncated: over.body?.truncated, len: over.body?.logs?.length }));
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A2：真进程轮转（上限小 → 多次请求把小文件转出去）+ 保留份数 + 文名/后缀/不丢行
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('rotate');
    const file = path.join(root, 'hids.log');
    const s = await boot('rotate', { file, maxBytes: 200, keep: 2 });
    try {
      for (let i = 0; i < 12; i += 1) await getLogs(s.base, '?event=probe.never');
      const list = await names(root);
      const rotated = rotatedOf(list);
      ok('A2 超上限就会轮转出历史文件（真进程）', rotated.length >= 1, list.join(','));
      ok('A2 轮转命名 <名>.<ISO>.log 且落在同一目录（docs §3.8.1 命名段）',
        rotated.every(name => ROTATED_NAME.test(name)), rotated.join(','));
      ok('A2 保留份数 keep=2：历史文件只留 2 份', rotated.length <= 2, `${rotated.length} 份：${rotated.join(',')}`);
      ok('A2 当前活动文件还在且非空', (await stat(file)).size > 0, `size=${(await stat(file)).size}`);
      let bad = 0;
      for (const name of list) {
        const lines = await readJsonLines(path.join(root, name));
        bad += lines.filter(line => line.__bad !== undefined).length;
      }
      ok('A2 轮转不把行切断：所有文件每一行都能解析成 JSON', bad === 0, `坏行 ${bad} 条 / 文件 ${list.join(',')}`);
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A2 缺省保留份数：不给 HIDS_LOG_KEEP 时按文档缺省 5 份
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('keepdefault');
    const file = path.join(root, 'hids.log');
    const s = await boot('keepdefault', { file, maxBytes: 200 });
    try {
      for (let i = 0; i < 14; i += 1) await getLogs(s.base, '?event=probe.never');
      const rotated = rotatedOf(await names(root));
      ok('A2 缺省 HIDS_LOG_KEEP=5：历史文件只留 5 份', rotated.length === 5, `${rotated.length} 份：${rotated.join(',')}`);
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A4 清单上限：>100 份时 items 只列 100、truncated:true、count/bytes 仍是全量（openapi LogCleanupResult.candidates）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('manyfiles');
    const file = path.join(root, 'hids.log');
    const ATS = [];
    for (let i = 0; i < 101; i += 1) {
      const at = Date.parse('2025-01-01T00:00:00.000Z') + i * 60_000;
      ATS.push(at);
      const name = `hids.${new Date(at).toISOString().replace(/[:.]/g, '-')}.log`;
      await writeFile(path.join(root, name), 'x'.repeat(10));
      await utimes(path.join(root, name), at / 1000, at / 1000);
    }
    const s = await boot('manyfiles', { file, maxBytes: 50 * 1024 * 1024 });
    try {
      const listed = await cleanLogs(s.base, { max_bytes: 0 });
      ok('A4 清单上限：101 份候选 → count=101 全量、items 只列 100、truncated:true',
        listed.body?.candidates?.count === 101 && listed.body?.candidates?.items?.length === 100 &&
        listed.body?.candidates?.truncated === true && listed.body?.candidates?.bytes === 1010,
        JSON.stringify({ count: listed.body?.candidates?.count, len: listed.body?.candidates?.items?.length,
          truncated: listed.body?.candidates?.truncated, bytes: listed.body?.candidates?.bytes }));
      const times = (listed.body?.candidates?.items ?? []).map(item => Date.parse(item.at));
      ok('A4 清单顺序：items 按 mtime 从老到新（openapi 写明）',
        times.every((value, index) => index === 0 || times[index - 1] <= value), JSON.stringify(times.slice(0, 3)));
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A4/schema：POST /api/logs/cleanup —— 默认 dry-run、当前文件永不入候选、execute 真删、
  // 回显/清单/余量逐字段、留痕 log.cleaned 字段口径、阈值边界与错误表
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('cleanup');
    const file = path.join(root, 'hids.log');
    // 先造三个文档口径的历史文件（mtime 可控），当前活动文件由 server 自己写
    const OLD = Date.parse('2020-01-01T00:00:00.000Z');
    const MID = Date.parse('2024-01-01T00:00:00.000Z');
    const fixtures = [
      ['hids.2019-12-31T00-00-00-000Z.log', 60, OLD],
      ['hids.2023-12-31T00-00-00-000Z.log', 60, MID],
      ['hids.2026-11-19T00-00-00-000Z.log', 60, Date.parse('2026-11-19T00:00:00.000Z')]
    ];
    for (const [name, bytes, at] of fixtures) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'x'.repeat(bytes));
      await utimes(target, at / 1000, at / 1000);
    }
    const s = await boot('cleanup', { file, maxBytes: 50 * 1024 * 1024 });
    try {
      const before = await names(root);
      const filesBefore = (await Promise.all(before.map(async name => `${name}:${(await stat(path.join(root, name))).size}`))).sort();

      const dry = await cleanLogs(s.base, { max_bytes: 0 });
      ok('A4 默认 dry-run：200 + dry_run:true + applied 全 0',
        dry.status === 200 && dry.body?.dry_run === true && dry.body?.applied?.count === 0 && dry.body?.applied?.bytes === 0,
        JSON.stringify({ status: dry.status, dry_run: dry.body?.dry_run, applied: dry.body?.applied }));
      const resultKeys = ['dry_run', 'threshold', 'candidates', 'applied', 'remaining'];
      ok('schema：LogCleanupResult 五个必填键齐全', resultKeys.every(key => key in (dry.body ?? {})), Object.keys(dry.body ?? {}).join(','));
      ok('schema：threshold 回显 {older_than:null,max_bytes:0}',
        dry.body?.threshold?.older_than === null && dry.body?.threshold?.max_bytes === 0, JSON.stringify(dry.body?.threshold));
      ok('schema：candidates 四个键 count/bytes/items/truncated 且 types 对',
        Number.isInteger(dry.body?.candidates?.count) && Number.isInteger(dry.body?.candidates?.bytes) &&
        Array.isArray(dry.body?.candidates?.items) && typeof dry.body?.candidates?.truncated === 'boolean',
        JSON.stringify(dry.body?.candidates && { count: dry.body.candidates.count, bytes: dry.body.candidates.bytes, len: dry.body.candidates.items?.length, truncated: dry.body.candidates.truncated }));
      ok('schema：candidates.items 每条 {name,bytes,at} 且 name 只是文件名、at 是 ISO',
        dry.body.candidates.items.every(item => typeof item.name === 'string' && !item.name.includes('/') &&
          Number.isInteger(item.bytes) && ISO.test(item.at)),
        JSON.stringify(dry.body.candidates.items));
      ok('schema：remaining 是 {count,bytes}',
        Number.isInteger(dry.body?.remaining?.count) && Number.isInteger(dry.body?.remaining?.bytes),
        JSON.stringify(dry.body?.remaining));
      ok('A4 候选含三条历史文件、当前活动文件不在候选里',
        dry.body.candidates.count === 3 && !dry.body.candidates.items.some(item => item.name === 'hids.log'),
        JSON.stringify(dry.body.candidates.items.map(item => item.name)));
      const histState = async () => Promise.all((await names(root)).filter(name => ROTATED_NAME.test(name))
        .map(async name => `${name}:${(await stat(path.join(root, name))).size}`)).then(list => list.sort());
      const afterDryHist = await histState();
      const beforeHist = filesBefore.filter(item => ROTATED_NAME.test(item.split(':')[0]));
      ok('A4 dry-run 历史文件一个字节都不动（当前活动文件会被 server 自己继续追加，不在此列）',
        JSON.stringify(afterDryHist) === JSON.stringify(beforeHist), `前=${beforeHist.join('|')} 后=${afterDryHist.join('|')}`);
      const explicitDry = await cleanLogs(s.base, { max_bytes: 0, execute: false });
      ok('A4 execute:false 与不给等价（dry_run:true、applied 0）',
        explicitDry.body?.dry_run === true && explicitDry.body.applied.count === 0, JSON.stringify(explicitDry.body?.dry_run));

      const applied = await cleanLogs(s.base, { max_bytes: 0, execute: true });
      ok('A4 execute:true 真删：dry_run:false + applied.count=3 + remaining.count=0',
        applied.status === 200 && applied.body?.dry_run === false && applied.body?.applied?.count === 3 &&
        applied.body?.remaining?.count === 0,
        JSON.stringify({ dry_run: applied.body?.dry_run, applied: applied.body?.applied, remaining: applied.body?.remaining }));
      ok('A4 applied.bytes 等于候选字节和（3×60）', applied.body?.applied?.bytes === 180, JSON.stringify(applied.body?.applied));
      ok('A4 历史文件清空、当前活动文件仍在且非空',
        rotatedOf(await names(root)).length === 0 && (await stat(file)).size > 0,
        (await names(root)).join(','));
      ok('A4 remaining 是执行后重扫的余量（不是照抄 applied）',
        applied.body.remaining.count === 0 && applied.body.remaining.bytes === 0, JSON.stringify(applied.body.remaining));

      // 留痕：执行后落一条 log.cleaned（by/count/bytes，不记文件名/内容）
      const lines = await readJsonLines(file);
      const traces = lines.filter(line => line.event === 'log.cleaned');
      ok('A4 留痕：真执行落一条 log.cleaned', traces.length === 1, `找到 ${traces.length} 条：${JSON.stringify(traces)}`);
      ok('A4 留痕字段只有 by/count/bytes（+三键），不记文件名',
        traces[0] && traces[0].by === 'size' && traces[0].count === 3 && traces[0].bytes === 180 &&
        Object.keys(traces[0]).sort().join(',') === 'by,bytes,count,event,level,time',
        JSON.stringify(traces[0]));

      // ══ 阈值边界：older_than「mtime 早于它」严格早于；两条阈值取并集（三份历史文件刚被删掉，重新摆回去）
      for (const [name, bytes, at] of fixtures) {
        await writeFile(path.join(root, name), 'x'.repeat(bytes));
        await utimes(path.join(root, name), at / 1000, at / 1000);
      }
      const T = '2026-11-19T00:00:00.000Z';
      const ageEq = await cleanLogs(s.base, { older_than: T });
      const ageEqNames = ageEq.body?.candidates?.items?.map(item => item.name) ?? [];
      ok('A4 older_than 边界：mtime 恰等于阈值那份不算「早于」→ 只选真正更早的 2 份',
        ageEq.body?.candidates?.count === 2 && !ageEqNames.includes('hids.2026-11-19T00-00-00-000Z.log'),
        JSON.stringify(ageEqNames));
      const agePlus = await cleanLogs(s.base, { older_than: '2026-11-19T00:00:00.001Z' });
      const agePlusNames = agePlus.body?.candidates?.items?.map(item => item.name) ?? [];
      ok('A4 older_than 边界：阈值晚 1ms → 恰等于那份也进候选（共 3 份）',
        agePlus.body?.candidates?.count === 3 && agePlusNames.includes('hids.2026-11-19T00-00-00-000Z.log'),
        JSON.stringify(agePlusNames));
      const union = await cleanLogs(s.base, { older_than: '2021-01-01T00:00:00.000Z', max_bytes: 0 });
      ok('A4 两条阈值取并集不重复计：older_than 选 1 份 + max_bytes 选 3 份 → count=3',
        union.body?.candidates?.count === 3 && union.body?.threshold?.older_than === '2021-01-01T00:00:00.000Z',
        JSON.stringify(union.body?.candidates?.count));
      const byAge = await cleanLogs(s.base, { older_than: '2026-11-19T00:00:00.000Z' });
      ok('A4 只按时间清（无 max_bytes）：max_bytes 回显 null', byAge.body?.threshold?.max_bytes === null, JSON.stringify(byAge.body?.threshold));

      // ══ 错误表逐条（§3.8.3「失败口径」）
      assertCallerError('cleanup 无阈值 {}', await cleanLogs(s.base, {}),
        '至少要给一个阈值：older_than（早于某时间）或 max_bytes（历史文件总字节上限）');
      assertCallerError('cleanup older_than=yesterday', await cleanLogs(s.base, { older_than: 'yesterday' }),
        'older_than 必须是可解析的时间（ISO 8601）');
      assertCallerError('cleanup max_bytes=-1', await cleanLogs(s.base, { max_bytes: -1 }), 'max_bytes 必须是不小于 0 的整数');
      assertCallerError('cleanup max_bytes=1.5', await cleanLogs(s.base, { max_bytes: 1.5 }), 'max_bytes 必须是不小于 0 的整数');
      assertCallerError('cleanup max_bytes="100"', await cleanLogs(s.base, { max_bytes: '100' }), 'max_bytes 必须是不小于 0 的整数');
      assertCallerError('cleanup execute="yes"', await cleanLogs(s.base, { max_bytes: 0, execute: 'yes' }), 'execute 必须是布尔值');
      assertCallerError('cleanup execute=1', await cleanLogs(s.base, { max_bytes: 0, execute: 1 }), 'execute 必须是布尔值');
      assertCallerError('cleanup 未知参数 keep', await cleanLogs(s.base, { max_bytes: 0, keep: 3 }), '不认识的参数：keep');
      for (const body of ['[]', '"x"', 'null', '1']) {
        assertCallerError(`cleanup 正文不是对象 ${body}`, await cleanLogs(s.base, body), '请求正文必须是 JSON 对象');
      }
      const noBody = await request(s.base, 'POST', '/api/logs/cleanup', {});
      ok('cleanup 无正文：400 + code=caller_error（openapi requestBody required）',
        noBody.status === 400 && noBody.body?.code === 'caller_error', `status=${noBody.status} body=${noBody.text.slice(0, 160)}`);
      info('cleanup 无正文文案', JSON.stringify(noBody.body?.error));
      info('cleanup older_than 用 Unix 秒', JSON.stringify(await (async () => {
        const r = await cleanLogs(s.base, { older_than: Math.floor(Date.now() / 1000) });
        return { status: r.status, error: r.body?.error ?? null };
      })()));

      // ══ by=age+size 留痕分支
      await writeFile(path.join(root, 'hids.2019-12-31T00-00-00-000Z.log'), 'y'.repeat(30));
      await utimes(path.join(root, 'hids.2019-12-31T00-00-00-000Z.log'), OLD / 1000, OLD / 1000);
      await cleanLogs(s.base, { older_than: '2021-01-01T00:00:00.000Z', max_bytes: 0, execute: true });
      const traces2 = (await readJsonLines(file)).filter(line => line.event === 'log.cleaned');
      ok('A4 留痕 by 取值：时间+大小同时命中 → by=age+size', traces2.at(-1)?.by === 'age+size',
        JSON.stringify(traces2.map(trace => trace.by)));
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A5：凭据三道闸——请求头 / query 里的凭据不进文件，也不出现在查询结果里
  // ══════════════════════════════════════════════════════════════════════════
  {
    const root = await makeRoot('redact');
    const file = path.join(root, 'hids.log');
    const SECRETS = ['SECRET-BEARER-abcdef', 'SECRET-COOKIE-abcdef', 'SECRET-QUERY-abcdef', 'SECRET-HANDWRITTEN', 'SECRET-INLINE-abcdef'];
    const s = await boot('redact', { file, maxBytes: 50 * 1024 * 1024 });
    try {
      await getLogs(s.base, `?token=${SECRETS[2]}`, {
        headers: { Authorization: `Bearer ${SECRETS[0]}`, Cookie: `session=${SECRETS[1]}` }, auth: false
      });
      await request(s.base, 'GET', '/api/session', {
        headers: { Authorization: `Bearer ${SECRETS[0]}`, Cookie: `session=${SECRETS[1]}` }, auth: false
      });
      const raw = await readFile(file, 'utf8');
      for (const secret of SECRETS.slice(0, 3)) ok(`A5 文件里没有 ${secret}`, !raw.includes(secret), `文件里 ${raw.includes(secret) ? '有' : '没有'}`);
      const passwordB64 = Buffer.from(`${AUTH.user}:${AUTH.password}`).toString('base64');
      ok('A5 文件里没有 Basic 凭据原文与 base64', !raw.includes(AUTH.password) && !raw.includes(passwordB64),
        `password=${raw.includes(AUTH.password)} base64=${raw.includes(passwordB64)}`);
      ok('A5 http.request 只记去掉 query 的 path', raw.includes('"path":"/api/logs"') && !raw.includes('token='),
        '见文件 http.request 行');

      // 盘上人手写脏行：读路径按同一套规则再擦一遍
      await appendFile(file, jsonLine('2026-11-20T00:00:09.000Z', 'probe.dirty',
        { authorization: `Bearer ${SECRETS[0]}`, note: `api_token=${SECRETS[4]}`, hand: SECRETS[3] }));
      const dirty = await getLogs(s.base, '?event=probe.dirty');
      const bodyText = dirty.text;
      ok('A5 查询结果：键名命中 + Basic/Bearer/token= 三类凭据被擦掉（文档承诺的三道闸）',
        !bodyText.includes(SECRETS[0]) && !bodyText.includes(SECRETS[4]), bodyText.slice(0, 300));
      info('A5 裸串（既不命中键名、也不是 Basic/Bearer/token= 形态）文档不承诺擦除', `hand=${JSON.stringify(dirty.body?.logs?.[0]?.hand)}`);
      ok('A5 查询结果：键名命中写 [redacted]（authorization）',
        dirty.body?.logs?.[0]?.authorization === '[redacted]', JSON.stringify(dirty.body?.logs?.[0]));
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A6：.env.example 三个新键 + 头部键数与实际键数一致 + T025 A4 清单里的键都在
  // ══════════════════════════════════════════════════════════════════════════
  {
    const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
    const listed = example.split('\n').filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]);
    const unique = new Set(listed);
    for (const key of ['HIDS_LOG_FILE', 'HIDS_LOG_MAX_BYTES', 'HIDS_LOG_KEEP'])
      ok(`A6 .env.example 列出 ${key}`, unique.has(key), `实际 ${unique.size} 键`);
    const claimed = example.match(/（P003-T025 立[^）]*?(\d+) 个键/);
    ok('A6 头部注释的键数与实际键数一致', claimed && Number(claimed[1]) === unique.size,
      `注释写 ${claimed?.[1]}，实际 ${unique.size}`);
    ok('A6 键总数 41（.env.example 头注口径）', unique.size === 41, `actual=${unique.size}`);
    const t025 = await readFile(path.join(ROOT, 'evidence/test/P003-T025/config-check.test.js'), 'utf8');
    const guardList = t025.slice(t025.indexOf('for (const name of ['), t025.indexOf('for (const name of [') + 1200);
    const guarded = [...guardList.matchAll(/'(HIDS|LLM|CLOUDWALKER)_[A-Z0-9_]+'/g)].map(match => match[0].slice(1, -1));
    ok('A6 T025 A4 键名清单含本卡三个新键',
      ['HIDS_LOG_FILE', 'HIDS_LOG_MAX_BYTES', 'HIDS_LOG_KEEP'].every(key => guarded.includes(key)),
      `清单 ${guarded.length} 个：${guarded.join(',')}`);
    ok('A6 T025 清单里的键都在 .env.example', guarded.every(key => unique.has(key)),
      guarded.filter(key => !unique.has(key)).join(',') || '全部在');
  }

  console.log(`\nT045 TESTER ${miss === 0 ? 'OK' : 'MISS'} 共 ${count} 条断言，MISS ${miss}`);
  return miss === 0 ? 0 : 1;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error('PROBE CRASH', error);
  process.exitCode = 2;
});
