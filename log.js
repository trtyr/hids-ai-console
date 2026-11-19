// 后端唯一日志落点（P003-T023）。一行一条 JSON 到 stdout：{time, level, event, ...fields}。
// 别在别处 console.log：事件名表与行形状见 docs/architecture.md「日志」一节。
//
// A4：日志里不出现 Authorization / Cookie / API Token——两道闸：
//   1) 键名命中 sensitive 的一律写成 '[redacted]'（递归进对象与数组）；
//   2) 字符串值里 Basic / Bearer 凭据与 token=xxx 之类再擦一遍：错误信息常把请求头或 URL 拼进去。
// 序列化失败（循环引用）不许抛：日志不能反过来搞崩业务，落一条 log.serialize_failed 了事。
//
// 落盘（P003-T045）：配了 `HIDS_LOG_FILE` 才在同目录再写一份同样的行（stdout 照旧），单文件超 `HIDS_LOG_MAX_BYTES`
// 轮转成 `<stem>.<ISO 时刻><ext>`，历史文件只留最新的 `HIDS_LOG_KEEP` 份；不配＝维持只上 stdout。
// 查询与清理读/删的都是这条路径上的真文件（`GET /api/logs`、`POST /api/logs/cleanup`，见 docs/modules/http-api.md §3.8）。
// 读路径落盘的行已经过下面两道闸；`/api/logs` 仍按同一套规则再擦一遍——文件可能是人手改过或老版本写的。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const sensitive = /authorization|cookie|token|password|secret|api[-_]?key/i;
const credential = /\b(basic|bearer)(\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
// 值可以带 Basic / Bearer 前缀：整段（前缀 + 凭据）一起换成 [redacted]，不会擦成两个。
const assignment = /((?:api[-_]?token|access[-_]?token|x-prompt-admin-token|x-rule-admin-token|token|password|secret|cookie|authorization)\s*[=:]\s*)(?:(basic|bearer)\s+)?("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
const reserved = new Set(['time', 'level', 'event']);
const maxText = 1000;
const maxDepth = 4;

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

// ── 文件 sink 与轮转（P003-T045）─────────────────────────────────────────────
// 缺省值：单文件 10 MiB 一换、历史留 5 份。两个键都不是必填（不配就用缺省），非法值（0 / 负数 / 小数 / 非数）
// 同样回落缺省——与 HIDS_TRIAGE_CONCURRENCY 同一口径，坏配置不让进程起不来，也不静默把轮转关掉。
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 5;
// 一次查询最多收多少个命中（再多的结果没人看，先按上限收、报 truncated）。
const QUERY_SCAN_LIMIT = 20000;
// 清理响应里最多列多少个候选文件名（与 /api/data/cleanup 的 100 同口径）。
const CLEAN_LIST_LIMIT = 100;
const queryLevels = Object.freeze(['info', 'warn', 'error']);

const positiveInt = (raw, fallback) => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

// env→落盘参数；`HIDS_LOG_FILE` 空串/纯空白算「没配」（与 HIDS_DATA_DIR 同一口径），相对路径按当前工作目录绝对化。
// env 可注入：单测传字面量，不碰真实 process.env。
export function logFileOptions(env = process.env) {
  const configured = typeof env.HIDS_LOG_FILE === 'string' ? env.HIDS_LOG_FILE.trim() : '';
  if (!configured) return null;
  return { file: path.resolve(configured),
    maxBytes: positiveInt(env.HIDS_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    keep: positiveInt(env.HIDS_LOG_KEEP, DEFAULT_KEEP) };
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

// 文件 sink：一行一次 append；内存里记字节数，`已有 + 这一行 > maxBytes` 且文件非空才轮转——
// **当前这条写进轮转后的新文件**，不丢。轮转后按 keep 删最老的历史文件。
// I/O 一律吞掉：落盘失败不能反过来搞崩业务（stdout 那份照旧）。目录建不出来就退化成只上 stdout。
export function createFileSink({ file, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, now = Date.now } = {}) {
  const target = path.resolve(String(file));
  let size = -1; // -1 = 还没量过：进程重启后接着往老文件里写，不把老内容当 0 从头上限
  let usable = true;
  try { mkdirSync(path.dirname(target), { recursive: true }); } catch { usable = false; }
  const rotate = () => {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    renameSync(target, rotatedNameOf(target, stamp));
    size = 0;
    const history = logFiles({ file: target }).filter(item => item.file !== target);
    for (const item of history.slice(keep)) { try { unlinkSync(item.file); } catch { /* 删不掉就留到下一轮 */ } }
  };
  return function write(line) {
    if (!usable) return;
    const text = String(line);
    const bytes = Buffer.byteLength(text);
    try {
      if (size < 0) size = sizeOf(target);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(target, text);
      size += bytes;
    } catch { /* 盘满 / 权限 / rename 失败：这一行只留在 stdout，不改上抛 */ }
  };
}

// 配了文件路径就把 journal 换成「文件 + stdout 同份写」；不配原样返回现有 journal（A1：行为不变）。
// 先写文件再写 stdout：sink 自己吞异常，stdout 断了（EPIPE）也不至于让文件那份丢。
// `write` 可注入：单测收 stdout 侧原样行，不去撞真 stdout。
export function useLogFile({ file, maxBytes, keep, write = line => process.stdout.write(line) } = {}) {
  if (!file) return log;
  const sink = createFileSink({ file, maxBytes, keep });
  return useJournal(createJournal({ write: line => { sink(line); write(line); } }));
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

// 查询：现读盘（当前文件 + 历史文件，新到旧），按 event / level / 时间范围过滤，再切页。
// `count` / `offset` 的校验在路由里（与其他分页路由同一套 400 文案）；这里只认已经合法的整数。
// 结果按 time 倒序（同一时刻按文件与行序），`truncated: true` 表示命中超过 limit 条只收了前 limit 条。
export function readLogEntries({ file, events = [], levels = [], from = null, to = null,
  count = 20, offset = 0, limit = QUERY_SCAN_LIMIT } = {}) {
  const files = logFiles({ file });
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  const matched = [];
  let truncated = false;
  outer: for (const item of files) {
    let text;
    try { text = readFileSync(item.file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseLogLine(lines[index]);
      if (!entry) continue;
      if (events.length && !events.includes(entry.event)) continue;
      if (levels.length && !levels.includes(entry.level)) continue;
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
