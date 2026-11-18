// 溯源两页（列表 + 白板）共用的纯展示口径：状态中文、跳的种类中文、时间格式、短标识、错误一句话。
//
// 为什么单独一份：D015 的列表与 D016 的白板是两张页面（`pages/trace.js` / `pages/trace-board.js`），
// 「进行中 / 已完成 / 失败 / 中断」这四个词和「告警 / 主机 / 进程 / 文件 / 账号 / 请求」必须在两页一致，
// 复制两份迟早漂移。这里只有纯函数，不发 HTTP、不碰 DOM。
//
// 口径来源：
//   状态四值  —— openapi.yaml:1728-1731（TraceBoardSummary.status 枚举），中文词取 D015 列表列名
//   种类六值  —— openapi.yaml:1746（TraceBoardHop.kind 枚举），中文词取 D016「点」一节
//   关系四句  —— D016「线」：谁触发了谁 / 谁写了谁 / 谁连了谁 / 谁登录了谁（接口只给 rel 原值，这里不翻译）

// 事件类型中文名（与后端 eventTypes 一一对应：cloudwalker.js:2-6；告警页 pages/alerts.js 同一套词）
const TYPE_LABELS = {
  webshell: 'WebShell', malware: '恶意文件', revshell: '反弹 Shell', memory_webshell: '内存马',
  brute_force: '暴力破解', abnormal_login: '异常登录', elevation_process: '提权进程',
  network_audit: '网络审计', suspicious_operation: '可疑操作', honeypot: '蜜罐', memory_security: '内存安全',
};

/** 事件类型 → 中文名；表外的原值照显示（手填 IP 起的白板没有类型，给 null → 「告警」兜底由调用方决定）。 */
export function eventTypeLabel(type) {
  if (!type) return null;
  return TYPE_LABELS[type] ?? String(type);
}

/** 白板状态 → 中文（D015：进行中、已完成、失败、中断）；枚举外的原值照显示，不猜。 */
const STATUS_LABEL = { running: '进行中', done: '已完成', failed: '失败', interrupted: '中断' };

export function statusLabel(status) {
  if (!status) return '—';
  return STATUS_LABEL[status] ?? String(status);
}

/** 状态 → 稿上的色点类（is-running / is-done / is-failed；interrupted 走默认灰）。 */
export function statusClass(status) {
  if (status === 'running') return 'is-running';
  if (status === 'done') return 'is-done';
  if (status === 'failed') return 'is-failed';
  return '';
}

/** 跳的种类 → 中文（D016：种类只有告警、主机、进程、文件、账号、请求）；枚举外的原值照显示。 */
const KIND_LABEL = { alert: '告警', host: '主机', process: '进程', file: '文件', account: '账号', request: '请求' };

export function kindLabel(kind) {
  if (!kind) return '—';
  return KIND_LABEL[kind] ?? String(kind);
}

const pad2 = value => String(value).padStart(2, '0');

/** 时间 → `YYYY-MM-DD HH:MM:SS`（本地时区）。解析不出来显示 `—`，不编时间。 */
export function formatStamp(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 时间 → `HH:MM:SS`（检查器里只占一行）；空值给空串。 */
export function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * 列表「告警」列的短标识（D015：类型，加上能认出来的短标识）。
 * 短的是原样（revshell:1 就能认）；长的（syslog 形态会把类型、哈希、时间戳、UUID 串起来）只留首尾，
 * 完整 ID 永远进 `title` 与链接 href，不丢信息。
 */
export function shortBoardId(id) {
  const text = String(id ?? '');
  if (text.length <= 28) return text;
  return `${text.slice(0, 12)}…${text.slice(-8)}`;
}

/** 失败归一成一句人能读的话（错误体文案优先，后端在 server.js:57）。 */
export function describeTraceError(error) {
  switch (error?.kind) {
    case 'unauthorized': return '登录已失效，请重新登录。';
    case 'unavailable': return error.message ? `${error.message}。` : '深度溯源尚未配置。';
    case 'notfound': return '该目标还没有溯源白板。';
    case 'network': return '连不上研判服务，请检查网络或稍后重试。';
    case 'invalid': return '服务返回的形状不对。';
    default: return error?.status ? `服务返回异常（${error.status}）：${error.message}` : (error?.message || '未知错误');
  }
}
