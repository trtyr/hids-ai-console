// 记录侧脱敏闸 + 出口凭据擦除（P003-T052 口径，批 0 归位到 shared）。
//
// 两个职责，一套闸：
//   1) `recordFailure()` / `reasonForRecord()`：落盘只写「固定文案 + 原文字符量」，错误对象本身一个字不动。
//      口径与 P003-T051 的 `investigation-agent.js` 同款（那份自抄已在批 0 删除，统一 import 这里）。
//   2) `scrubCredentials()`：失败原因出记录/响应**之前**的凭据擦除（P003-T013 A4）。
//      上游报错常把请求头或 URL 拼进文案（`Authorization: Bearer …`、`?token=…`），写之前擦，不等出口。
//
// 为什么：V8 的 JSON.parse 报错会把回包前 ~10 字原样带出（`Unexpected token 'S', "SECRET_BOD"...`），
// 上游 HTTP/RPC 报错的 message 同理——这些字符串一旦写进磁盘就等于留档。

// 类名只在这几个里出现：判断失败类型有用，且不会把正文带出来。
const namedFailures = new Set(['TypeError', 'SyntaxError', 'RangeError', 'TimeoutError', 'AbortError']);
const timeoutFailure = /timeout|超时|aborted/i;

/**
 * 把错误对象压成「固定文案 + 原文字符量」。
 * @param {unknown} error 上游/模型/解析抛出的错误（对象本身不被修改）
 * @param {{kind?: string, keep?: string[]}} [options]
 *   kind：兜底固定文案，默认「上游调用失败」（调用方按落点改写，例如「本地写入失败」）；
 *   keep：本地自造的固定文案白名单（原样返回）——只允许写死的话术，不允许上游原文，
 *         防的是「模型尚未配置」这类要人去动手的提示被抹成一串字数。
 */
export function recordFailure(error, { kind = '上游调用失败', keep = [] } = {}) {
  const raw = String(error?.message ?? error ?? '');
  if (keep.includes(raw)) return raw;
  const label = error?.model_decode ? '模型回包不是合法 JSON'
    : timeoutFailure.test(raw) ? '调用超时' : kind;
  const name = namedFailures.has(error?.name) ? `（${error.name}）` : '';
  return `${label}${name}，原文 ${raw.length} 字未落盘`;
}

/**
 * 记录侧文本一律归一：任何 `reason` / `detail` 文本（不管前缀长什么样）都走 `recordFailure()`，
 * 只留固定文案 + 原文字符量。
 *
 * 设计变更（P003-T052 第四轮打回，群主拍板）：**废掉徽标白名单**。旧版按前缀白名单保留徽标、只换原文段
 * ——白名单穷举不尽，漏一个就是一条原文落盘的路。取舍：本地短文案一起变泛（丢「哪里失败」的语义），
 * 换零泄漏 + 无穷举债。`recordFailure()` 的 `keep` 是**调用点写死的整串**精确匹配，
 * 不是在文本内容上猜「这句像不像我们的话」；本函数不提供任何内容白名单。
 */
export function reasonForRecord(text) {
  return recordFailure(String(text ?? ''));
}

/**
 * 失败原因出记录/响应之前的凭据擦除（P003-T013 A4 口径，原实现住在 `fp-maintainer.js`，批 0 收口到这里）。
 * Basic/Bearer 前缀整段（前缀 + 凭据）换成 `[redacted]`，token=xxx 之类键值对同样擦。
 */
export function scrubCredentials(text) {
  return String(text ?? '')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(token|api[_-]?key|password|secret)=[^\s&"'，。；]+/gi, '$1=[redacted]');
}
