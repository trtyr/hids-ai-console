#!/usr/bin/env node
// P003-T027 验收探针（何东阳 / 后端测试）
//
// 全程走真实进程 + 真实 UDP + 真实 stdout，不 import 被测文件：
//   1. 假牧云 RPC（本地 HTTP）→ node server.js（syslog 模式）→ 真 UDP 报文 → 收 stdout JSON 行
//   2. node maintenance-server.js --preview（真端口 → SIGTERM 收尾）→ 收启动行
//   3. node package-policy.js 三条走法（真临时目录）→ 收 JSON 行 + 退出码 + 文件权限
//
// 断言口径全部来自文档：
//   docs/architecture.md §3.2 / §3.6（事件表 + `syslog.match_failed` 的 rule 取值表）
//   docs/modules/maintenance-service.md §2.4 / §4.1 / §4.2
//
// 可靠性：不等固定 sleep——起进程/收日志/收尾一律 waitUntil 轮询到哨兵或 deadline（P003-T027 审计打回项 1）。
// 正控：A3-1 除「凭据零命中」外要求三类 match_failed 真到齐且出现 [redacted]，管道空转必红（审计打回项 2）。
// 隔离：每次跑把源码树复制到独立临时根（不带 .data），server / maintenance / CLI 全在里面跑，跑完删掉（审计打回项 5）。
//   运行态目录恒为「模块所在目录/.data」且不吃环境变量（docs/modules/http-api.md:42），上次进程留下的
//   running/queued 记录会在下次 start() 时改判 queued 重新排队（docs/modules/triage-pipeline.md §5.1），
//   拿上一轮的 parsed 配本轮的假上游 → nearest_gap 漂（实测 481 而非 480）；跨轮同指纹报文还会被去重表折叠。
//   nonce 改指纹那套是无效修法：指纹只取固定字段 + 分类型字段（triage-pipeline.md §4.1），nonce 不进指纹，已撤。
//
// 端口：维护端端口不写死，向内核要空闲端口后经 HIDS_MAINTENANCE_PORT 传入（architecture.md:59、:464）。
// 测试钩子（只给 verify-mutations.sh 用，人工跑不会用到）：
//   P27_KEEP_RUN_ROOT=1  保留临时运行根并打印 [run-root-kept] <path>——变异脚本用系统自己写的运行态造前置态
//   P27_BASE_SECOND=<秒> 把事件时间基准钉死，重放记录算出的 nearest_gap 才是可复算的定值
//
// 跑法：node evidence/test/P003-T027/acceptance-e2e.mjs
// 退出码 0 = 全部断言过；1 = 有断言失败（失败项逐条打印 文档说 / 实测）。

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WT = path.resolve(new URL('.', import.meta.url).pathname, '../../..');
const SYSLOG_HOST = '127.0.0.1';
const SECRETS = ['SECRET123456', 'hunter2', 'abcdef123456', 'tok-abcdef', 'k-abcdef', 'MaintPassword987', 'BasicPassword987'];

const results = [];
function check(id, ok, doc, actual) {
  results.push({ id, ok, doc, actual });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}\n  文档说: ${doc}\n  实测  : ${actual}`);
}

// 轮询等待到哨兵或 deadline：不猜「大概这么久够了」。
// 返回 true=哨兵到；false=deadline 内没到（交给断言判红，不吞错）。
function waitUntil(fn, { timeout = 30000, interval = 25, label = '条件' } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = Boolean(fn()); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - start >= timeout) {
        console.error(`[waitUntil] deadline ${timeout}ms 没等到：${label}`);
        return resolve(false);
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

// 等子进程退出：到 deadline 返回 false（调用方 SIGKILL 兜底），不留孤儿进程。
function waitExit(proc, timeout = 10000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeout);
    proc.once('close', () => { clearTimeout(t); resolve(true); });
  });
}

// ---------- 1. 假牧云 RPC ----------
// 事件时间基准：默认取当前秒。P27_BASE_SECOND 只给变异脚本（verify-mutations.sh 的隔离变异 E）
// 造前置态用——把两轮的事件时间钉在已知差值上，重放记录的 nearest_gap 才是可复算的定值。
const BASE = Number(process.env.P27_BASE_SECOND) || Math.floor(Date.now() / 1000);
const EVENT_TIME = BASE + 120;          // 第三条报文（时间窗外）的事件时间
const CANDIDATE_GAPS = [600, 900];      // 假上游候选事件的 created_at 相对 BASE

// 独立运行根：源码树整份复制到临时目录（不含 .git / .data / evidence），运行态从空开始，
// 跑完删。这样上一轮的队列/去重表/记录一条都进不来；仓内 .data 一个字节都不碰（A2-5 校验）。
function makeRunRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-root-'));
  const skip = new Set(['.git', '.data', 'evidence']);
  fs.cpSync(WT, root, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(WT, src);
      return rel === '' || !skip.has(rel.split(path.sep)[0]);
    },
  });
  return root;
}
const RUN_ROOT = makeRunRoot();
console.log(`[run-root] ${RUN_ROOT}（.data 是否随树带过来：${fs.existsSync(path.join(RUN_ROOT, '.data'))}）`);
// P27_KEEP_RUN_ROOT=1 时保留运行根并打出路径：变异脚本用它取「真系统自己写出来的运行态」当种子，
// 不依赖工作树里遗留的 .data（干净树上也能跑）。
const KEEP_RUN_ROOT = process.env.P27_KEEP_RUN_ROOT === '1';
if (KEEP_RUN_ROOT) console.log(`[run-root-kept] ${RUN_ROOT}`);
process.on('exit', () => {
  if (KEEP_RUN_ROOT) return;
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch {}
});
function fakeUpstream() {
  // created_at 是 time_window 分支算 nearest_gap_seconds 取的时间字段（给出即有值，审计确认）：
  // 最近一条候选 +600s、事件时间 +120s → 期望 480。
  const rows = [
    { id: 21, event_id: 21, host_id: 1, host_ip: '10.0.0.5', event_create_time: fmtWall(BASE + 600), detected_at: BASE + 600, created_at: BASE + 600 },
    { id: 22, event_id: 22, host_id: 1, host_ip: '10.0.0.5', event_create_time: fmtWall(BASE + 900), detected_at: BASE + 900, created_at: BASE + 900 },
  ];
  const calls = [];
  const failFlag = path.join(os.tmpdir(), `p27-fail-${process.pid}.flag`);
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = new URL(req.url, 'http://x').searchParams.get('method') || '';
      calls.push(method);
      if (fs.existsSync(failFlag)) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 500, message: 'upstream boom api_token=SECRET123456' } }));
        return;
      }
      const result = /GetEvent$/.test(method)
        ? { event: { id: 7, event_id: 7, host_id: 2, host_ip: '10.0.0.6', detected_at: BASE, created_at: BASE } }
        : { events: rows, total: rows.length };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls, failFlag })));
}
const fmtWall = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 19).replace('T', ' ');
const iso = (epoch) => new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');

// ---------- 2. 拉真 server.js ----------
async function runSyslogPipeline() {
  const up = await fakeUpstream();
  const env = {
    ...process.env,
    HIDS_PORT: '0',
    HIDS_SYSLOG_HOST: SYSLOG_HOST,
    HIDS_SYSLOG_PORT: '0',
    CLOUDWALKER_URL: `http://127.0.0.1:${up.port}`,
    CLOUDWALKER_API_TOKEN: 'tok-abcdef',
    LLM_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'k-abcdef',
    LLM_MODEL: 'fake-model',
    HIDS_TRIAGE_INPUT_MODE: 'syslog',
    HIDS_BASIC_AUTH_PASSWORD: 'BasicPassword987',
    HIDS_MAINTENANCE_PASSWORD: 'MaintPassword987',
  };
  const proc = spawn(process.execPath, ['server.js'], { cwd: RUN_ROOT, env });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const send = (port, line) => new Promise((r) => { const s = dgram.createSocket('udp4'); s.send(line, port, SYSLOG_HOST, () => { s.close(); r(); }); });
  try {
    // 哨兵：接收器绑定行。60s deadline 留给满载机器。
    const up1 = await waitUntil(() => /udp:\/\/127\.0\.0\.1:(\d+)/.test(out), { timeout: 60000, label: 'syslog.listening 绑定行' });
    const m = up1 ? /udp:\/\/127\.0\.0\.1:(\d+)/.exec(out) : null;
    if (!m) throw new Error('syslog 接收器没起来：' + out);
    const port = Number(m[1]);
    // 四条报文各差 60 秒、msgid 不同，跨报文的 match_failed 断言不会被「同秒重复」折叠（triage-pipeline.md §4.2）
    await send(port, `<134>1 ${iso(BASE)} host app - cloudwalker-webshell event_create_time="${fmtWall(BASE)}"`);                       // 缺 host_ip
    await send(port, `<134>1 ${iso(BASE + 60)} host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5 host_id=1 event_create_time="${fmtWall(BASE + 60)}"`); // 详情主机不符
    await send(port, `<134>1 ${iso(EVENT_TIME)} host app - cloudwalker-honeypot host_ip=10.0.0.5 host_id=1 event_create_time="${fmtWall(EVENT_TIME)}"`);          // 时间窗外
    await send(port, `<134>1 ${iso(BASE + 180)} host app - cloudwalker-suspicious-command host_ip=10.0.0.5 host_id=1 api_token=SECRET123456 password=hunter2 authorization=Bearer+abcdef123456 event_create_time="${fmtWall(BASE + 180)}"`); // A3
    // 哨兵：三条基础分支真到齐（不等固定时长；缺哪条后面断言自己会红）。
    // time_window 必须点名 honeypot 那条——否则 suspicious-command 的 time_window 先到就会提前放行，
    // 上一条上游开关还没开就把 honeypot 的查询打成 500（审计 load 假红的真根）。
    await waitUntil(() => {
      const ls = lines(out).filter((l) => l.event === 'syslog.match_failed');
      return ls.some((l) => l.rule === 'payload')
        && ls.some((l) => l.rule === 'event_id')
        && ls.some((l) => l.rule === 'time_window' && l.msgid === 'cloudwalker-honeypot'
          && !String(l.reason || '').startsWith('牧云事件查询失败'));
    }, { timeout: 60000, label: 'payload/event_id + honeypot time_window 三条 match_failed' });
    fs.writeFileSync(up.failFlag, '1');
    await send(port, `<134>1 ${iso(BASE + 240)} host app - cloudwalker-malware host_ip=10.0.0.5 host_id=1 event_create_time="${fmtWall(BASE + 240)}"`);           // 上游 500
    // 哨兵：上游失败分支落日志
    await waitUntil(() => lines(out).some((l) => l.event === 'syslog.match_failed'
      && String(l.reason || '').startsWith('牧云事件查询失败')), { timeout: 60000, label: 'time_window 上游失败分支（reason=牧云事件查询失败）' });
  } finally {
    fs.rmSync(up.failFlag, { force: true });
    proc.kill('SIGTERM');
    if (!(await waitExit(proc, 10000))) proc.kill('SIGKILL');
    up.srv.close();
  }
  return { out, calls: up.calls };
}

// ---------- 3. 维护端 ----------
// 端口不写死：先向内核要一个空闲端口，再把它通过 HIDS_MAINTENANCE_PORT 传进去（architecture.md:59、:464）。
// 被占就换一个重试，最多 3 次；返回实际用的端口，A1-1 断言回显端口 == 这个端口。
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function tryMaintenance(port) {
  const proc = spawn(process.execPath, ['maintenance-server.js', '--preview'], {
    cwd: RUN_ROOT,
    env: { ...process.env, HIDS_MAINTENANCE_PORT: String(port), HIDS_MAINTENANCE_PASSWORD: 'MaintPassword987' },
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  try {
    await waitUntil(() => /"event":"maintenance\.listening"/.test(out), { timeout: 30000, label: 'maintenance.listening 启动行' });
  } finally {
    proc.kill('SIGTERM');
    if (!(await waitExit(proc, 10000))) proc.kill('SIGKILL');
  }
  return out;
}
async function runMaintenance() {
  let out = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    out = await tryMaintenance(port);
    if (/"event":"maintenance\.listening"/.test(out)) return { out, port };
    console.error(`[maintenance] 第 ${attempt} 次起在端口 ${port} 没出启动行，换端口重试`);
  }
  return { out, port: null };
}

// ---------- 4. package-policy ----------
function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['package-policy.js', ...args], { cwd: RUN_ROOT, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ out, code }));
  });
}
async function runPackagePolicy() {
  const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-keys-'));
  const a = await runNode(['--init-keys', keys]);
  const perms = {};
  for (const f of fs.readdirSync(keys)) perms[f] = (fs.statSync(path.join(keys, f)).mode & 0o777).toString(8);
  const b = await runNode(['--init-keys', keys]);
  const usage = await runNode([]);
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-out-'));
  fs.writeFileSync(path.join(outdir, 'notes.json'), JSON.stringify({
    version: '26.11.008', sequence: 2, date: '2026-11-17', title: '研判策略更新 26.11.008',
    summary: '示例公开更新说明，用于验证包制作链路。',
    changes: { features: ['示例：新增一条能力说明。'], improvements: ['示例：改进一处体验。'], fixes: [] },
  }));
  const built = await runNode([path.join(outdir, 'notes.json'), path.join(outdir, '26.11.008.hids-policy')], {
    HIDS_UPDATE_KEY_FILE: path.join(keys, 'encryption.key'),
    HIDS_UPDATE_PRIVATE_KEY_FILE: path.join(keys, 'signing-private.pem'),
    HIDS_UPDATE_TARGET: 'demo-customer',
  });
  const missingEnv = await runNode([path.join(outdir, 'notes.json'), path.join(outdir, 'z.hids-policy')], {
    HIDS_UPDATE_KEY_FILE: path.join(keys, 'encryption.key'),
    HIDS_UPDATE_PRIVATE_KEY_FILE: path.join(keys, 'signing-private.pem'),
    HIDS_UPDATE_TARGET: '',
  });
  const badExt = await runNode([path.join(outdir, 'notes.json'), path.join(outdir, 'z.zip')], {
    HIDS_UPDATE_KEY_FILE: path.join(keys, 'encryption.key'),
    HIDS_UPDATE_PRIVATE_KEY_FILE: path.join(keys, 'signing-private.pem'),
    HIDS_UPDATE_TARGET: 'demo-customer',
  });
  return { init: a, perms, again: b, usage, built, missingEnv, badExt, outdir };
}

// ---------- 跑 ----------
const lines = (out) => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const pick = (ls, ev) => ls.filter((l) => l.event === ev);

// 隔离正控：仓内 .data/triage-monitor.json 是跨进程持久运行态（http-api.md:42），本轮跑完必须一字节不变。
const REPO_STATE = path.join(WT, '.data', 'triage-monitor.json');
const repoState = () => {
  if (!fs.existsSync(REPO_STATE)) return 'absent';
  const st = fs.statSync(REPO_STATE);
  return `${st.mtimeMs}:${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(REPO_STATE)).digest('hex').slice(0, 16)}`;
};
const repoStateBefore = repoState();

const pipe = await runSyslogPipeline();
const repoStateAfter = repoState();
const L = lines(pipe.out);
const matchFailed = pick(L, 'syslog.match_failed');

check('A2-1 payload 分支（缺 host_ip）',
  matchFailed.some((l) => l.rule === 'payload' && Array.isArray(l.missing) && l.missing.includes('host_ip') && typeof l.reason === 'string' && l.level === 'warn'),
  'rule=payload、missing 列缺项、reason 说明、level=warn',
  JSON.stringify(matchFailed.find((l) => l.rule === 'payload') || null));

const evId = matchFailed.find((l) => l.rule === 'event_id');
check('A2-2 event_id 分支（主机不符）',
  Boolean(evId && evId.mismatch && evId.mismatch.host_ip && evId.mismatch.host_ip.wanted === '10.0.0.5' && evId.mismatch.host_ip.returned === '10.0.0.6' && evId.mismatch.host_id && 'event_id' in evId.mismatch === false),
  'mismatch 只列真对不上的项，每项 {wanted, returned}（ID 对得上 → 不出现 event_id 项）',
  JSON.stringify(evId || null));

const twAll = matchFailed.filter((l) => l.rule === 'time_window' && l.msgid === 'cloudwalker-honeypot'
  && l.reason && !String(l.reason).startsWith('牧云事件查询失败'));
const tw = twAll[0];
const EXPECT_NEAREST_GAP = (BASE + CANDIDATE_GAPS[0]) - EVENT_TIME;   // 600 - 120 = 480
// 恰 1 条：上一轮重放出来的旧记录拿自己那轮的事件时间配本轮假上游，会多出一条同 rule 的 match_failed、
// 或抢在本轮报文之前先到（两种都实测过：nearest_gap 481 / 583）。条数就是隔离是否真生效的正控——不是 1 就红。
check('A2-3 time_window 分支（窗外有候选，且本轮恰 1 条）',
  twAll.length === 1 && tw.window_seconds === 300 && tw.candidates === 2 && tw.nearest_gap_seconds === EXPECT_NEAREST_GAP,
  'window_seconds=300、candidates=本次取到的条数（假上游 2 条）、nearest_gap_seconds=最近一条差多远（候选 created_at +600s、事件时间 +120s → 480）；同一条只应出现一次',
  `条数=${twAll.length} 首条=${JSON.stringify(tw || null)}`);

const twErr = matchFailed.find((l) => l.rule === 'time_window' && String(l.reason || '').startsWith('牧云事件查询失败'));
check('A2-4 time_window 分支（上游查询失败）',
  Boolean(twErr && twErr.reason.includes('牧云 /rpc 500')),
  '查询本身失败时同 rule 带 reason（牧云事件查询失败：…）',
  JSON.stringify(twErr || null));

// 文档事件表字段名：从 docs/architecture.md 的事件名表里 syslog.match_failed 那一行解析（不硬编码期望）
// 读法照 logging.test.js 的 docRow：首列里带 `事件名` 的那行，取「关键字段」列（第 3 列）里的全部 `字段`。
const archDoc = fs.readFileSync(path.join(WT, 'docs/architecture.md'), 'utf8');
const archRow = archDoc.split('\n').find((line) => line.startsWith('|')
  && (line.split('|')[1] || '').includes('`syslog.match_failed`'));
const docFields = archRow ? [...archRow.split('|')[3].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]) : [];
const keySet = new Set(matchFailed.flatMap((l) => Object.keys(l)));
check('A4-1 文档事件表字段名与真日志一致（architecture.md 事件名表 syslog.match_failed 行）',
  Boolean(archRow) && docFields.length > 0 && docFields.every((f) => keySet.has(f)),
  '事件表 syslog.match_failed 行「关键字段」列里写的每个 `字段`，真日志里都有',
  (archRow ? '文档字段：' + docFields.join(',') : '文档事件名表里找不到 syslog.match_failed 行')
    + '；实测键：' + [...keySet].sort().join(',')
    + (docFields.length ? '（缺：' + docFields.filter((f) => !keySet.has(f)).join(',') + '）' : ''));

// 正控（审计打回项 2）：三类 match_failed 必须真到齐、[redacted] 必须出现——
// 否则「日志里没有凭据」是管道空转的白捡（load 下只到两三条时曾假绿）。
const BASE_RULES = ['payload', 'event_id', 'time_window'];
const missingRules = BASE_RULES.filter((r) => !matchFailed.some((l) => l.rule === r));
const redactedSeen = pipe.out.includes('[redacted]');
const leak = SECRETS.filter((s) => pipe.out.includes(s));
check('A3-1 真管道日志不出现凭据（正控：三类 match_failed + [redacted] 到齐）',
  missingRules.length === 0 && redactedSeen && leak.length === 0,
  '日志不出现 Token 与密码；文本里的 token=… / Bearer … 擦成 [redacted]；正控要求 payload/event_id/time_window 三条真日志到齐',
  `凭据命中：${leak.length ? leak.join(',') : '无'}；[redacted] 出现=${redactedSeen}；缺分支=[${missingRules.join(',')}]`);

check('A2-5 独立运行根：本轮不碰仓内 .data（triage-monitor.json 前后一致）',
  repoStateBefore === repoStateAfter,
  '运行态目录恒为「模块所在目录/.data」（http-api.md:42），且上次中断留在 running 的记录下次 start() 改判 queued 重新排队（triage-pipeline.md §5.1）；探针在临时根里跑，上一轮的队列/去重表/记录一条都进不来',
  `前=${repoStateBefore} 后=${repoStateAfter} 运行根=${RUN_ROOT}`);

// ---------- 维护端 ----------
const maint = await runMaintenance();
const mOut = maint.out;
const mPort = maint.port;
const mLines = lines(mOut);
const listening = pick(mLines, 'maintenance.listening')[0];
check('A1-1 维护端启动行走 log.js（maintenance.listening）',
  Boolean(listening && listening.level === 'info' && listening.host === '127.0.0.1' && listening.port === mPort && typeof mPort === 'number' && listening.preview === true),
  'host/port/preview/message 四键，level=info，port=启动时传入的 HIDS_MAINTENANCE_PORT（architecture.md §3.2、:59、:464）',
  `传入端口=${mPort} 回显=${JSON.stringify(listening || null)}`);
check('A1-2 旧中文启动文案留在 message（部署端 grep 就绪探测）',
  Boolean(listening && typeof listening.message === 'string' && listening.message.includes('HIDS maintenance') && listening.message.includes('只读预览')
    && typeof mPort === 'number' && listening.message.includes(`http://127.0.0.1:${mPort}`)),
  'message 里保留 `HIDS maintenance（只读预览）: http://127.0.0.1:<port>`',
  JSON.stringify(listening && listening.message));
check('A3-2 维护端日志不出现 HIDS_MAINTENANCE_PASSWORD',
  !mOut.includes('MaintPassword987'),
  '口令不进日志',
  mOut.includes('MaintPassword987') ? '命中 MaintPassword987' : '零命中');

// ---------- package-policy ----------
const pp = await runPackagePolicy();
const pLines = lines(pp.init.out + pp.built.out + pp.usage.out + pp.again.out + pp.missingEnv.out + pp.badExt.out);
const keysCreated = pick(pLines, 'policy.keys_created')[0];
const built = pick(pLines, 'policy.package_built')[0];
const usageLine = pick(pLines, 'policy.usage')[0];
check('A1-3 policy.keys_created 形状 + 退出码 0',
  Boolean(keysCreated && pp.init.code === 0 && Array.isArray(keysCreated.files) && keysCreated.files.length === 3 && typeof keysCreated.directory === 'string' && typeof keysCreated.message === 'string'),
  'event=policy.keys_created，directory/files/message，退出码 0（maintenance-service.md §4.1）',
  `code=${pp.init.code} line=${JSON.stringify(keysCreated || null)}`);
check('A1-4 密钥文件权限 600（目录 700）',
  ['signing-private.pem', 'signing-public.pem', 'encryption.key'].every((f) => pp.perms[f] === '600'),
  '三个文件 600（package-policy.js:17、:23）',
  JSON.stringify(pp.perms));
check('A1-5 policy.package_built 形状 + 退出码 0',
  Boolean(built && pp.built.code === 0 && built.version === '26.11.008' && built.sequence === 2 && built.target === 'demo-customer' && typeof built.output === 'string'),
  'event=policy.package_built，output/version/sequence/target/message，退出码 0（§4.2）',
  `code=${pp.built.code} line=${JSON.stringify(built || null)}`);
check('A1-6 policy.usage 形状 + 退出码 1（level=error）',
  Boolean(usageLine && usageLine.level === 'error' && pp.usage.code === 1 && String(usageLine.message).includes('--init-keys')),
  'event=policy.usage、level=error、message 是用法、退出码 1（§2.4）',
  `code=${pp.usage.code} line=${JSON.stringify(usageLine || null)}`);
check('A1-7 边界：缺环境变量 / 扩展名不对都非 0 退出',
  pp.missingEnv.code !== 0 && pp.badExt.code !== 0,
  '少一个 HIDS_UPDATE_* 或扩展名不是 .hids-policy 就报错退出（§2.4）',
  `缺 TARGET exit=${pp.missingEnv.code}；扩展名 .zip exit=${pp.badExt.code}`);
check('A1-8 边界：重复生成密钥 EEXIST 非 0、不覆盖',
  pp.again.code !== 0 && /EEXIST/.test(pp.again.out),
  '重复跑同一条命令会报 EEXIST 并以非 0 退出（§4.1）',
  `exit=${pp.again.code}，输出含 EEXIST=${/EEXIST/.test(pp.again.out)}`);
const ppLeak = SECRETS.concat(['BEGIN', 'PRIVATE KEY']).filter((s) => pLines.some((l) => JSON.stringify(l).includes(s)));
check('A3-3 package-policy 日志不出现密钥正文 / 密钥路径取值',
  ppLeak.length === 0,
  '日志里只有输出路径、版本、序号、环境标识，密钥内容不进（package-policy.js:42-43）',
  ppLeak.length ? '命中：' + ppLeak.join(',') : '零命中；policy.* 三条的键里最大字段长度 = ' + Math.max(...pLines.filter((l) => String(l.event).startsWith('policy.')).flatMap((l) => Object.values(l).map((v) => String(v).length))));

fs.rmSync(pp.outdir, { recursive: true, force: true });

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length) console.log('失败项：' + failed.map((f) => f.id).join(' | '));
process.exit(failed.length ? 1 : 0);
