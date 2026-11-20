// 记录侧脱敏闸（P003-T052）：落盘只写「固定文案 + 原文字符量」，错误对象本身一个字不动。
// 口径与 P003-T051 的 `investigation-agent.js` `recordFailure()` 同款；那个函数留在研判记录内部，
// 本文件管其余记录侧：队列状态文件（triage-monitor）、案件文件（syslog-case）、白板 JSON（trace-board）、
// 工作台会话（knowledge-workbench）、必查项 trace 与案卷（required-evidence）、回放报告（wiki-replay）。
// 为什么：V8 的 JSON.parse 报错会把回包前 ~10 字原样带出（`Unexpected token 'S', "SECRET_BOD"...`），
// 上游 HTTP/RPC 报错的 message 同理——这些字符串一旦写进磁盘就等于留档。

// 类名只在这几个里出现：判断失败类型有用，且不会把正文带出来。
const namedFailures = new Set(['TypeError', 'SyntaxError', 'RangeError', 'TimeoutError', 'AbortError']);
const timeoutFailure = /timeout|超时|aborted/i;
// `syslog-case.js` 生产的两条上游失败徽标：`牧云事件 ID 详情读取失败：<raw>` / `牧云事件查询失败：<raw>`。
const upstreamFailure = /^(牧云事件(?: ID 详情读取|查询)失败)：/;

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
 * 带徽标的上游失败（`牧云事件…失败：<raw>`）：徽标留给读者，原文段换固定文案 + 字符量。
 * 不匹配徽标的文本原样返回（分支里写死的自造文案照旧）。
 */
export function reasonForRecord(text, options) {
  const raw = String(text ?? '');
  const badge = raw.match(upstreamFailure);
  return badge ? `${badge[1]}：${recordFailure(raw.slice(badge[0].length), options)}` : raw;
}
