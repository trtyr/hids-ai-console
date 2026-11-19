// 后端唯一日志落点（P003-T023）。一行一条 JSON 到 stdout：{time, level, event, ...fields}。
// 别在别处 console.log：事件名表与行形状见 docs/architecture.md「日志」一节。
//
// A4：日志里不出现 Authorization / Cookie / API Token——两道闸：
//   1) 键名命中 sensitive 的一律写成 '[redacted]'（递归进对象与数组）；
//   2) 字符串值里 Basic / Bearer 凭据与 token=xxx 之类再擦一遍：错误信息常把请求头或 URL 拼进去。
// 序列化失败（循环引用）不许抛：日志不能反过来搞崩业务，落一条 log.serialize_failed 了事。

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
