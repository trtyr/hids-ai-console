// 后端唯一日志落点（P003-T023 立；T072 系统化：默认落盘 + request_id 贯穿 + 非阻塞写 + 全文检索 + 总量上限）。
// 一行一条 JSON：{time, level, event, ...fields}；处于请求上下文时自动带上 request_id（与 user）。
// 别在别处 console.log：事件名表与行形状见 docs/architecture.md「日志」一节；R-LOG 由 check-layers 强制。
//
// A4：日志里不出现 Authorization / Cookie / API Token——两道闸：
//   1) 键名命中 sensitive 的一律写成 '[redacted]'（递归进对象与数组）；
//   2) 字符串值里 Basic / Bearer 凭据与 token=xxx 之类再擦一遍：错误信息常把请求头或 URL 拼进去。
// 序列化失败（循环引用）不许抛：日志不能反过来搞崩业务，落一条 log.serialize_failed 了事。
//
// 落盘（T045 → T072 增强）：
//   · **默认落盘**：不配任何环境变量时写 `<数据根>/logs/hids.log`（数据根见 shared/data-root）；
//     `HIDS_LOG_FILE` 仍可整条覆盖；显式关闭走 `HIDS_LOG_FILE=none`（不是「不配」）。
//     测试进程（node --test 注入 NODE_TEST_CONTEXT）默认关闭——测试要文件就显式配路径，不污染真实数据根。
//   · **非阻塞写**：journal 只把行推进内存队列（O(1)，永不 await），真正的 appendFile 由异步任务串行消化；
//     轮转语义不变——`已有 + 这一行 > maxBytes` 且文件非空才轮转，当前这条写进轮转后的新文件，不丢。
//     测试与关停用 `flushLogs()` 等队列排空。
//   · 轮转三重上限：单文件 `HIDS_LOG_MAX_BYTES`（缺省 10 MiB）、份数 `HIDS_LOG_KEEP`（缺省 5）、
//     总量 `HIDS_LOG_TOTAL_MAX_BYTES`（缺省 200 MiB，超了从最老的历史文件删起）。超限行为：删旧不丢当前行。
//   · 查询（T045 → T072 增强）：`q` 全文搜索（对原始行做不区分大小写的子串匹配，限定尾部窗口、
//     超窗标 truncated）、`request_id` / `user` 过滤——从一条 error 反查整条请求链就靠它。
import { appendFile, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { appendFile as appendFileAsync } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { dataRoot } from '../data-root.js';

const sensitive = /authorization|cookie|token|password|secret|api[-_]?key/i;
const credential = /\b(basic|bearer)(\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
// 值可以带 Basic / Bearer 前缀：整段（前缀 + 凭据）一起换成 [redacted]，不会擦成两个。
const assignment = /((?:api[-_]?token|access[-_]?token|x-prompt-admin-token|x-rule-admin-token|token|password|secret|cookie|authorization)\s*[=:]\s*)(?:(basic|bearer)\s+)?("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
const reserved = new Set(['time', 'level', 'event']);
const maxText = 1000;
const maxDepth = 4;

// ── 请求上下文（T072）：同一 HTTP 请求产生的全部日志共享 request_id ─────────────────
const requestStore = new AsyncLocalStorage();
/** 在 ctx（{ request_id, user }）里跑 fn：期间所有 log() 自动带 request_id / user。 */
export function runWithRequestContext(ctx, fn) { return requestStore.run(ctx, fn); }
/** 当前请求上下文（无则 null）。中间件用它回填 user。 */
export function currentRequestContext() { return requestStore.getStore() ?? null; }

function scrub(raw) {
  const text = String(raw);
  const clipped = text.length > maxText ? `${text.slice(0, maxText)}…` : text;
  return clipped.replace(assignment, (match, key, scheme) => `${key}${scheme ? `${scheme} ` : ''}[redacted]`)
    .replace(credential, (match, scheme, gap) => `${scheme}${gap}[redacted]`);
}

function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return scrub(value.message || value.name);
  if (depth >= maxDepth) return '[depth]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = sensitive.test(key) ? '[redacted]' : redact(item, depth + 1);
    return result;
  }
  return scrub(value);
}

function payload(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const body = redact(fields);
  // 保留键不许被字段覆盖：调用方写 fields.event 也改不动这一条日志的事件名。
  for (const key of reserved) delete body[key];
  return body;
}

// write / now 可注入：单测用内存写的 journal，不碰真实 stdout 与真实时钟。
export function createJournal({ write = line => process.stdout.write(line), now = () => new Date().toISOString() } = {}) {
  return function journal(event, fields = {}, level = 'info') {
    const head = { time: now(), level, event: String(event) };
    // T072：请求上下文里的日志自动带 request_id（有 user 也带）——同请求多行日志串成一条链。
    const ctx = requestStore.getStore();
    if (ctx?.request_id) head.request_id = ctx.request_id;
    if (ctx && 'user' in ctx && ctx.user != null) head.user = String(ctx.user);
    let line;
    try { line = JSON.stringify({ ...head, ...payload(fields) }); }
    catch { line = JSON.stringify({ ...head, level: 'error', event: 'log.serialize_failed' }); }
    try { write(`${line}\n`); } catch { /* 管道断了也不能反过来搞崩业务 */ }
  };
}

// 进程级唯一实例；本模块只此一份 writer，各处 import 同一个 log。
export let log = createJournal();

// 单测的注入缝：ESM 活绑定，换掉后已 import 的模块也走新 journal。
export function useJournal(next) { log = next || createJournal(); return log; }

// ── 模型调用事件（P003-T046）─────────────────────────────────────────────────
// 三域（研判 / 规则维护 / wiki 维护）每一次模型调用落**两条** `ai.model_call`：
//   `direction: 'request'`  —— 发出去那一刻：域、角色、轮次、input_chars、消息与工具条数；
//   `direction: 'response'` —— 收回来那一刻：同一批定位字段 + input_chars / output_chars / duration_ms / outcome。
// 拆两条的理由：调用挂死或被 kill 时，只有 request 那条能证明「这次确实发出去了」；单条事件做不到。
// **正文与密钥一个字都不进字段**：请求体只在下面这个函数栈上算长度，落日志的只有字符量；
// 失败原因走 `error` 字段，与其它事件一样过两道脱敏闸（键名 + 字符串里的 Basic/Bearer/token=）。
const MODEL_EVENT = 'ai.model_call';

// 请求体字符量：真发出去的那两份（messages / tools）序列化之后多长。
const requestChars = (messages, tools) => {
  try { return JSON.stringify({ messages, tools }).length; } catch { return 0; }
};
const replyChars = reply => (typeof reply?.content === 'string' ? reply.content.length : 0);
const toolCallCount = reply => (Array.isArray(reply?.tool_calls) ? reply.tool_calls.length : 0);
const errorText = error => String(error?.message || error).slice(0, 120);

// 结局四值（`docs/architecture.md` §3.6 的事件表按它写）：ok / timeout / invalid_json / error。
// 超时判据与研判循环里的重试判据同一套（AbortSignal 报 TimeoutError，文案带 timeout / 超时 / aborted）。
function outcomeOf(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  return /timeout|超时|aborted/i.test(text) ? 'timeout' : 'error';
}

/**
 * 包一次模型调用：进两条 `ai.model_call` 事件，把回包与「解码结果」一起交回调用方。
 *
 * - `meta`：`{ domain, role, turn, phase, attempt, alertId, sessionId, model, messages, tools }`；
 *   `domain` 取 `triage | rule | wiki`，`role` 取 `triage | review | rule_maintainer | wiki_maintainer`。
 * - `run`：真正发出请求的函数（`() => client.complete(...)`）。
 * - `decode`：可选。回包解码（`parseJSON` / `normalizeVerdict` 之类）。解不出来记 `outcome: 'invalid_json'`，
 *   原始错误上打 `model_decode` / `model_reply` / `model_call` 三个标记后原样抛出——调用方的退回逻辑不必改形状。
 *
 * 返回 `{ reply, decoded, call }`；`call` 是这一条的计量（input_chars / output_chars / duration_ms / outcome /
 * tool_calls），研判侧拿它填逐轮快照（`turns`），不再自己算一遍。
 */
export async function traceModelCall(meta = {}, run, { decode = null } = {}) {
  const { domain, role, turn = 1, phase = null, attempt = 1, alertId = null, sessionId = null,
    model = null, messages = [], tools = [] } = meta;
  const base = { domain, role, turn, attempt };
  if (phase) base.phase = phase;
  if (alertId) base.alert_id = alertId;
  if (sessionId) base.session_id = sessionId;
  if (model) base.model = model;
  const inputChars = requestChars(messages, tools);
  const startedAt = Date.now();
  log(MODEL_EVENT, { ...base, direction: 'request', input_chars: inputChars,
    messages: Array.isArray(messages) ? messages.length : 0, tools: Array.isArray(tools) ? tools.length : 0 });
  const settle = fields => log(MODEL_EVENT, { ...base, direction: 'response', input_chars: inputChars,
    duration_ms: Date.now() - startedAt, ...fields });
  let reply;
  try { reply = await run(); }
  catch (error) {
    const call = { input_chars: inputChars, output_chars: 0,
      duration_ms: Date.now() - startedAt, outcome: outcomeOf(error), tool_calls: 0 };
    settle({ ...call, error: errorText(error) });
    // 计量挂在错误上：调用方的逐轮快照（turns）靠它把「这一轮超时了」和「调用报错了」分开记。
    Object.assign(error, { model_call: call });
    throw error;
  }
  let decoded = null;
  if (decode) {
    try { decoded = decode(reply); }
    catch (error) {
      // 回包到手了但解不出来：这是「模型没按约定输出」，与调用失败分开记，调用方的退回逻辑照旧。
      const call = { input_chars: inputChars, output_chars: replyChars(reply),
        duration_ms: Date.now() - startedAt, outcome: 'invalid_json', tool_calls: toolCallCount(reply) };
      // `error` 字段只写固定文案 + 错误类名：V8 的 JSON.parse 报错原文会带出回包正文前 ~10 个字
      //（`Unexpected token 'S', "SECRET_BOD"...`），两道脱敏闸擦的是凭据，正文只能靠这里不写。
      settle({ ...call, error: `模型回包无法解析为 JSON（${error?.name || 'Error'}）` });
      Object.assign(error, { model_decode: true, model_reply: reply, model_call: call });
      throw error;
    }
  }
  const call = { input_chars: inputChars, output_chars: replyChars(reply),
    duration_ms: Date.now() - startedAt, outcome: 'ok', tool_calls: toolCallCount(reply) };
  settle(call);
  return { reply, decoded, call };
}

// ── 文件 sink 与轮转（T045 立、T072 增强：非阻塞 + 总量上限 + 默认落盘）────────────
// 缺省值：单文件 10 MiB 一换、历史留 5 份、总量 200 MiB。三个键都不是必填（不配就用缺省），非法值
// （0 / 负数 / 小数 / 非数）同样回落缺省——坏配置不让进程起不来，也不静默把轮转关掉。
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP = 5;
export const DEFAULT_TOTAL_MAX_BYTES = 200 * 1024 * 1024;
// 一次查询最多收多少个命中（再多的结果没人看，先按上限收、报 truncated）。
const QUERY_SCAN_LIMIT = 20000;
// 全文检索的尾部窗口：从最新文件往回最多读这么多行（acceptance：限定尾部窗口并在响应里标 truncated）。
const QUERY_WINDOW_LINES = 50000;
// 清理响应里最多列多少个候选文件名（与 /api/data/cleanup 的 100 同口径）。
const CLEAN_LIST_LIMIT = 100;
const queryLevels = Object.freeze(['info', 'warn', 'error']);

const positiveInt = (raw, fallback) => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

// 测试进程判定：node --test 给子进程注入 NODE_TEST_CONTEXT。可注入 env + 开关，单测两条路都能走到。
const underTestRunner = (env = process.env) => Boolean(env.NODE_TEST_CONTEXT);

/**
 * env → 落盘参数（T072 默认落盘口径）：
 *   · `HIDS_LOG_FILE=none|off` → 显式关闭（null）；
 *   · 显式路径 → 用它（相对路径按 cwd 绝对化）；
 *   · 未配 → 测试进程（NODE_TEST_CONTEXT）返回 null（默认关，不污染真实数据根）；
 *     生产进程返回 `<数据根>/logs/hids.log`（默认开）。
 */
export function logFileOptions(env = process.env, { test = underTestRunner() } = {}) {
  const configured = typeof env.HIDS_LOG_FILE === 'string' ? env.HIDS_LOG_FILE.trim() : '';
  if (configured === 'none' || configured === 'off') return null;
  if (!configured) {
    if (test) return null;
    return { file: path.join(dataRoot({ env }), 'logs', 'hids.log'),
      maxBytes: positiveInt(env.HIDS_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
      keep: positiveInt(env.HIDS_LOG_KEEP, DEFAULT_KEEP),
      totalMaxBytes: positiveInt(env.HIDS_LOG_TOTAL_MAX_BYTES, DEFAULT_TOTAL_MAX_BYTES) };
  }
  return { file: path.resolve(configured),
    maxBytes: positiveInt(env.HIDS_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    keep: positiveInt(env.HIDS_LOG_KEEP, DEFAULT_KEEP),
    totalMaxBytes: positiveInt(env.HIDS_LOG_TOTAL_MAX_BYTES, DEFAULT_TOTAL_MAX_BYTES) };
}

const sizeOf = (file, stat = statSync) => { try { return stat(file).size; } catch { return 0; } };
const mtimeOf = (file, stat = statSync) => { try { return stat(file).mtimeMs; } catch { return 0; } };
// 轮转名：`<stem>.<2026-11-20T02-44-01-123Z><ext>`——保留原扩展名，落盘目录里的 *.log 仍能被
// /api/data/inventory 的 logs 类看见。同一毫秒轮转两次时后加 -1、-2（rename 会静默覆盖同名目标）。
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;
const rotatedNameOf = (file, stamp) => {
  const ext = path.extname(file);
  const base = path.join(path.dirname(file), `${path.basename(file, ext)}.${stamp}`);
  let candidate = `${base}${ext}`;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${base}-${n}${ext}`;
  return candidate;
};

// 一条路径上的全部日志文件：当前活动文件 + 轮转出来的历史文件，按 mtime 新到旧。
// 历史文件的判定是名字形状（stem + 时间戳 + 原扩展名），不是「目录里所有 .log」——同目录可能有别人的文件。
export function logFiles({ file, stat = statSync, readdir = readdirSync } = {}) {
  const target = path.resolve(String(file));
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  let names = [];
  try { names = readdir(path.dirname(target)); } catch { names = []; }
  const history = names.filter(name => name.startsWith(`${stem}.`) && name.endsWith(ext))
    .filter(name => STAMP.test(name.slice(stem.length + 1, ext ? -ext.length : undefined)))
    .map(name => path.join(path.dirname(target), name))
    .map(path_ => ({ file: path_, bytes: sizeOf(path_, stat), mtime: mtimeOf(path_, stat) }));
  const current = { file: target, bytes: sizeOf(target, stat), mtime: mtimeOf(target, stat) };
  return [current, ...history].sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
}

// 异步 drain 的活动 sink 注册表：flushLogs() 等所有还没写完的行落盘（测试与优雅关停用）。
const liveSinks = new Set();

// 文件 sink（T072 非阻塞版）：write() 只把行推进内存队列并排一次 drain，真正的 I/O 在异步任务里
// 逐行消化（逐行才能保住「当前这条写进轮转后的新文件」的轮转语义）。I/O 一律吞掉：
// 落盘失败不能反过来搞崩业务（stdout 那份照旧）。目录建不出来就退化成只上 stdout。
// 内存里记字节数；进程重启后第一次写先 stat 现有文件，不把老内容当 0 从头上限。
export function createFileSink({ file, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP,
  totalMaxBytes = DEFAULT_TOTAL_MAX_BYTES, now = Date.now, afterWrite = null } = {}) {
  const target = path.resolve(String(file));
  let size = -1; // -1 = 还没量过
  let usable = true;
  try { mkdirSync(path.dirname(target), { recursive: true }); } catch { usable = false; }
  const queue = [];       // 待写的行（FIFO）
  const pendingAfter = []; // afterWrite 的逐行登记：文件落盘**之后**再逐行发（先文件后 stdout）
  let scheduled = false;  // 已排了一个 drain（还没开跑）
  let running = false;    // drain 正在跑（任何时刻至多一个，否则批写会乱序落盘）
  const rotate = () => {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    renameSync(target, rotatedNameOf(target, stamp));
    size = 0;
    const history = logFiles({ file: target }).filter(item => item.file !== target);
    for (const item of history.slice(keep)) { try { unlinkSync(item.file); } catch { /* 删不掉就留到下一轮 */ } }
    enforceTotalCap();
  };
  // 总量上限（T072）：历史文件总字节超过 totalMaxBytes 就从最老的删起，只删历史、不碰当前文件。
  const enforceTotalCap = () => {
    const history = logFiles({ file: target }).filter(item => item.file !== target); // 新到旧
    let total = history.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of history.slice().reverse()) {
      if (total <= totalMaxBytes) break;
      try { unlinkSync(item.file); total -= item.bytes; } catch { break; }
    }
  };
  const drain = async () => {
    // 批量攒写：到轮转边界或队列排空为止一次 appendFile——吞吐贴近同步写，热路径仍是 O(1) 入队。
    while (queue.length) {
      if (!usable) { queue.length = 0; pendingAfter.length = 0; return; }
      if (size < 0) size = sizeOf(target);
      let batch = '';
      let hitBoundary = false; // 只有真撞上单文件上限才轮转——await 期间新到的行不算边界（否则并发写一次一转）
      while (queue.length) {
        const bytes = Buffer.byteLength(queue[0]);
        if (size > 0 && size + bytes > maxBytes) { hitBoundary = true; break; }
        batch += queue.shift();
        size += bytes;
      }
      if (batch) {
        try { await appendFileAsync(target, batch, { encoding: 'utf8', mode: 0o600 }); }
        catch { size = -1; /* 盘满 / 权限：这批只留在 stdout；size 重查盘面，不改上抛 */ }
      }
      if (hitBoundary) rotate(); // 当前这条写进轮转后的新文件，不丢
    }
    // 文件那份已经落盘（或确认放弃），stdout 那份现在逐行发——先文件后 stdout 的承诺保持。
    if (afterWrite) for (const line of pendingAfter.splice(0)) { try { afterWrite(line); } catch { /* stdout 断了不搞崩业务 */ } }
  };
  const start = () => {
    scheduled = false; running = true;
    drain().catch(() => {}).finally(() => {
      running = false;
      // drain 在跑的时候新来的行没赶上这批：排下一轮，保证最终不剩队列。
      if (queue.length && !scheduled) { scheduled = true; setImmediate(start); }
    });
  };
  const write = line => {
    queue.push(String(line));
    if (afterWrite) pendingAfter.push(line);
    if (!scheduled && !running) { scheduled = true; setImmediate(start); }
  };
  const handle = line => write(line);
  handle.flush = () => new Promise(resolve => {
    const check = () => { if (!queue.length && !scheduled && !running) resolve(); else setImmediate(check); };
    setImmediate(check);
  });
  liveSinks.add(handle);
  return handle;
}

// 排空所有活动 sink（测试断言前 / 进程优雅关停时用）：所有队列清空后 resolve。
export async function flushLogs() {
  await Promise.all([...liveSinks].map(sink => sink.flush()));
}

// 配了文件路径就把 journal 换成「文件 + stdout 同份写」；不配原样返回现有 journal（A1：行为不变）。
// T072：文件那份走异步 sink（不阻塞事件循环），stdout 那份**在文件落盘之后**发（先文件后 stdout 的
// 承诺保持；stdout 断了文件那份不丢）。`write` 可注入：单测收 stdout 侧原样行，不去撞真 stdout。
export function useLogFile({ file, maxBytes, keep, totalMaxBytes, write = line => process.stdout.write(line) } = {}) {
  if (!file) return log;
  const sink = createFileSink({ file, maxBytes, keep, totalMaxBytes, afterWrite: write });
  return useJournal(createJournal({ write: sink }));
}

// 读盘上的一行：不是 JSON 对象、没有字符串 time/event 的行（截断的半行、人手写的空行）一律跳过。
function parseLogLine(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  let entry;
  try { entry = JSON.parse(text); } catch { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.time !== 'string' || typeof entry.event !== 'string') return null;
  return redact(entry); // 读路径也过一遍脱敏：盘上的文件不一定是本进程刚写的
}

// 查询：现读盘（当前文件 + 历史文件，新到旧），按 event / level / 时间 / q 全文 / request_id / user 过滤，再切页。
// `count` / `offset` 的校验在路由里（与其他分页路由同一套 400 文案）；这里只认已经合法的整数。
// 结果按 time 倒序（同一时刻按文件与行序）。两个 truncated 口径都标进 `truncated`：
//   命中超过 limit（先按上限收），或读行数超过 QUERY_WINDOW_LINES 的尾部窗口（T072 全文检索的窗口界）。
export function readLogEntries({ file, events = [], levels = [], from = null, to = null,
  q = null, requestId = null, user = null,
  count = 20, offset = 0, limit = QUERY_SCAN_LIMIT } = {}) {
  const files = logFiles({ file });
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
  const matched = [];
  let truncated = false;
  let linesRead = 0;
  outer: for (const item of files) {
    let text;
    try { text = readFileSync(item.file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      linesRead += 1;
      if (linesRead > QUERY_WINDOW_LINES) { truncated = true; break outer; }
      const raw = lines[index];
      const entry = parseLogLine(raw);
      if (!entry) continue;
      if (events.length && !events.includes(entry.event)) continue;
      if (levels.length && !levels.includes(entry.level)) continue;
      if (needle && !raw.toLowerCase().includes(needle)) continue;
      if (requestId && entry.request_id !== requestId) continue;
      if (user && entry.user !== user) continue;
      const at = Date.parse(entry.time);
      if (fromMs != null && !(at >= fromMs)) continue;
      if (toMs != null && !(at <= toMs)) continue;
      if (matched.length >= limit) { truncated = true; break outer; }
      matched.push(entry);
    }
  }
  matched.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return { logs: matched.slice(offset, offset + count), total: matched.length, files: files.length, truncated };
}

// 清理：只动轮转出来的历史文件——**当前活动文件永不在候选里**（删了它，正在写的这一份就断在半行上）。
// 阈值取并集：`olderThan`（mtime 早于它）与 `maxBytes`（历史文件总字节超了就从最老的删到不超）。
// 默认 dry-run（execute 缺省 false），返回候选清单与执行后剩余；真删的条数/字节由调用方决定要不要留痕。
export function pruneLogFiles({ file, olderThan = null, maxBytes = null, execute = false } = {}) {
  const target = path.resolve(String(file));
  const history = logFiles({ file: target }).filter(item => item.file !== target); // 新到旧
  const chosen = new Map();
  if (Number.isFinite(olderThan)) for (const item of history) if (item.mtime < olderThan) chosen.set(item.file, item);
  if (Number.isFinite(maxBytes)) {
    let total = history.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of history.slice().reverse()) { // 末尾是最老的
      if (total <= maxBytes) break;
      chosen.set(item.file, item);
      total -= item.bytes;
    }
  }
  const candidates = [...chosen.values()].sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
  const bytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
  if (execute) for (const item of candidates) { try { unlinkSync(item.file); } catch { /* 删不掉的留在盘上，剩余量会体现出来 */ } }
  const left = logFiles({ file: target }).filter(item => item.file !== target);
  return { dry_run: !execute,
    threshold: { older_than: Number.isFinite(olderThan) ? new Date(olderThan).toISOString() : null, max_bytes: Number.isFinite(maxBytes) ? maxBytes : null },
    candidates: { count: candidates.length, bytes,
      items: candidates.slice(0, CLEAN_LIST_LIMIT).map(item => ({ name: path.basename(item.file), bytes: item.bytes,
        at: new Date(item.mtime).toISOString() })),
      truncated: candidates.length > CLEAN_LIST_LIMIT },
    applied: { count: execute ? candidates.length : 0, bytes: execute ? bytes : 0 },
    remaining: { count: left.length, bytes: left.reduce((sum, item) => sum + item.bytes, 0) } };
}

export { queryLevels };
