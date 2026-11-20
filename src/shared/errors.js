// 统一错误模型（P003-T073）：**全端只有一个出口**。业务端四类 + 维护端具名码 + 401/502/SSE 三个特例，
// 全部从这里出——任何 HTTP 处理不许自己构造错误响应（R-ERROR，check-layers 强制）。
//
// 设计（acceptance 第 1 条的「报告第一节」落在这里 + docs/architecture/refactor-ddd.md）：
//   · shape：`{ error, code }`。`error` 是给人看的原话，`code` 是给程序判断的稳定标识。
//   · 业务端四类（P003-T024 口径不变）：类 → 状态码固定，调用点只说「这是哪一类」，不再自己挑 400/502；
//     同一类在任何路由上都是同一个码。判据只认错误自带的标记（failure / status），不看文案。
//   · 内部异常原文与堆栈只进 http.failed 日志（request_id 反查，见 T072），`internal` 的 error 恒为固定文案。
//   · 错误正文统一擦凭据（scrubCredentials，shared/redaction 单一实现）。
//   · 维护端 21 处 {error} 全部补 code（本表 + sendMaintenanceFailure），与业务端同一套 snake_case 命名。
//   · 特例两处（形状是契约，不能套四类，构造仍只能经本文件）：
//       1) `/api/status` 502：`{configured,connected,reason,error,code}` —— 前端按 connected 判，error/code 是并入
//          统一模型新增的键（reason 保留）。
//       2) 业务 401：`{error, code}` + `WWW-Authenticate` 头 —— Basic 弹窗行为靠头不靠正文，正文从纯文本改 JSON。
//   · SSE 错误帧：HTTP 200 + `{type:'error', error, code}`，前端可只按 code 判成败。
import { timingSafeEqual } from 'node:crypto';
import { scrubCredentials } from './redaction.js';

// ── 业务端四类（P003-T024 的单一真源，server.js 原表搬进来）────────────────────
export const failureClasses = Object.freeze({
  caller: { status: 400, code: 'caller_error' }, // 调用方传错：参数/正文/ID/权限/不存在/状态冲突
  config: { status: 503, code: 'not_configured' }, // 没配置：牧云、模型、管理员令牌、研判队列
  upstream: { status: 502, code: 'upstream_error' }, // 上游失败：牧云、模型、MCP、随部署的只读规则数据
  internal: { status: 500, code: 'internal_error' } // 本程序失败：没预料到的异常、本地运行态读写
});
// 本程序失败对外只说这一句：异常原文与堆栈只进 http.failed 日志，不回给调用方。
export const INTERNAL_ERROR_MESSAGE = '服务器内部错误';

// ── 维护端具名码表（acceptance：21 处 {error} 全部补 code，与业务端同一套命名风格）────────
// 每条 code 的缺省文案与维护端原文案逐字一致——只加 code，不改话术（前端与部署脚本照旧 grep 得到）。
export const maintenanceCodes = Object.freeze({
  not_configured: '维护端尚未配置',
  loopback_only: '维护服务仅允许本机或 SSH 隧道访问',
  preview_loopback_only: '预览仅允许本机监听',
  invalid_url: '请求地址无效',
  not_found: '接口不存在',
  csrf_rejected: '维护请求校验失败，拒绝跨站请求',
  login_disabled: '维护账号尚未配置',
  rate_limited: '登录失败过多，请稍后重试',
  json_required: '登录请求须为 JSON',
  invalid_credentials: '账号或密码错误',
  forbidden_role: '该账号没有后台访问权限',
  unauthorized: '请使用独立维护账号登录',
  preview_read_only: '本地只读预览不允许上传或替换',
  not_updater: '当前账号没有产品更新权限',
  package_media_type: '仅接受加密策略包文件',
  package_name_invalid: '升级包名称编码无效',
  revision_required: '请先刷新版本后确认替换',
  login_disabled_preview: '只读预览未配置维护账号，不可登录执行更新',
  internal_error: '维护服务处理失败，请检查后端记录'
});

export function failureBody(kind, message) {
  const { code } = failureClasses[kind];
  return { error: kind === 'internal' ? INTERNAL_ERROR_MESSAGE : scrubCredentials(message) || code, code };
}

// 一个异常属于哪一类：显式标记（viaCloudwalker 打的上游标）优先，其次 4xx status（各模块自己判过的调用方错误），
// 都没有就落到调用点给的缺省类——调用点知道自己调的是上游还是本地代码。
export function failureKindOf(cause, fallback = 'internal') {
  if (cause?.failure && Object.hasOwn(failureClasses, cause.failure)) return cause.failure;
  const status = Number(cause?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 ? 'caller' : fallback;
}
// status 只在「调用方传错」这一类里覆盖（400 参数 / 403 权限 / 404 不存在 / 405 方法 / 409 冲突 / 410 已下线 / 422 无法溯源），
// 5xx 一律由类决定，免得同一类又冒出两种服务端状态码。
export function failureStatusOf(kind, cause) {
  const status = Number(cause?.status);
  return kind === 'caller' && Number.isInteger(status) ? status : failureClasses[kind].status;
}

// ── HTTP 出口（业务端原 server.js 的 json/fail 家族搬进来；批 7 移交 middleware/error-model.js）──
export function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

export function fail(res, kind, message, status = failureClasses[kind].status) {
  return writeJson(res, status, failureBody(kind, message));
}
export const callerError = (res, message, status = 400) => fail(res, 'caller', message, status);
export const configError = (res, message) => fail(res, 'config', message);
export const upstreamError = (res, message) => fail(res, 'upstream', message);

export function causeError(res, cause, fallback = 'internal') {
  const kind = failureKindOf(cause, fallback);
  const message = cause?.message || (kind === 'upstream' ? '上游请求失败' : '请求无效');
  return fail(res, kind, message, failureStatusOf(kind, cause));
}

// ── 特例 1：业务 401（纯文本 → {error, code}，Basic 弹窗靠 WWW-Authenticate 头不变）────────
export function sendUnauthorized(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="HIDS AI Console", charset="UTF-8"',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error: '需要登录后访问', code: 'unauthorized' }));
}

// ── 特例 2：/api/status 的 502（契约形状保留，error/code 并入统一模型）──────────────────
export function sendCloudwalkerStatusFailure(res, message) {
  writeJson(res, failureClasses.upstream.status, { configured: true, connected: false,
    reason: scrubCredentials(message) || '上游请求失败', error: scrubCredentials(message) || '上游请求失败',
    code: failureClasses.upstream.code });
}

// ── 维护端出口：21 处 {error} 的唯一构造点 ─────────────────────────────────────
// message 缺省用码表文案（调用点只给 code 就能拿到原话），显式传了就擦一遍凭据再出。
export function sendMaintenanceFailure(res, status, code, message) {
  const text = message == null ? maintenanceCodes[code] : scrubCredentials(String(message)) || maintenanceCodes[code] || code;
  writeJson(res, status, { error: text, code });
}
// 动态 catch 的码：实现抛的带 status 的错按类归（4xx=caller 类、503=not_configured、其余=internal），
// 没带 status 的意外归 internal。
export function maintenanceCodeFor(cause) {
  const status = Number(cause?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) return 'caller_error';
  if (status === 503) return 'not_configured';
  return 'internal_error';
}

// ── SSE 错误帧（HTTP 200 + {type:'error', error, code}）─────────────────────────
export function sseErrorFrame(cause, fallback = 'upstream') {
  const kind = failureKindOf(cause, fallback);
  return { type: 'error', error: kind === 'internal' ? INTERNAL_ERROR_MESSAGE
    : scrubCredentials(cause?.message) || failureClasses[kind].code, code: failureClasses[kind].code };
}

// ── 维护端 401 帮手（原来的 authenticated() 也收在这里：错误与身份的判据一处）────────────
export function basicAuthMatches(req, access) {
  if (!access?.user || !access?.password) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`${access.user}:${access.password}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
