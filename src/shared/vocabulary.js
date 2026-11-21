// 共享内核 · 词表（P003-T075 批 2 抽取，D034 §8.1：类型/等级是共享内核，不是 ingestion 的私有物）。
// 原来这批常量住在 cloudwalker.js——fan-in 8 里有 5 个文件只为 eventTypes 一个表就得挂上整个网关模块
// （含 RpcClient）。抽出来之后 triage / trace / knowledge / interfaces 依赖的是零依赖叶子。
// 事件类型和 RPC 服务名依据 cloudwalker-master/server 下各事件 API 的实现整理。
export const eventTypes = Object.freeze({
  webshell: 'WebShell', malware: '恶意文件', revshell: '反弹 Shell', memory_webshell: '内存马',
  brute_force: '暴力破解', abnormal_login: '异常登录', elevation_process: '提权进程',
  network_audit: '网络审计', suspicious_operation: '可疑操作', honeypot: '蜜罐', memory_security: '内存安全'
});

export const rpcMethods = Object.freeze({
  webshell: 'WebshellEventService', malware: 'MalwareEventService', revshell: 'RevshellEventService',
  memory_webshell: 'MemoryWebshellEventService', brute_force: 'BruteForceService',
  abnormal_login: 'AbnormalLoginEventService', elevation_process: 'ElevationProcessEventService',
  network_audit: 'NetworkAuditEventService', suspicious_operation: 'SuspiciousOperationService',
  honeypot: 'HoneypotService', memory_security: 'MemorySecurityEventService'
});

// 时间口径：纯数字按秒/毫秒自适应，其余交给 Date 解析；解析不了返回 null。
// 对外导出，好让 server.js 的 from/to 校验与事件时间用同一套规则。
export const parseInstant = value => {
  const n = Number(value);
  const date = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// 等级：内部秩（1-4）↔ 机器键 ↔ 中文名。三份口径只有这一份（T059 的字典接口从这里读）。
export const levelNames = Object.freeze({ 1: ['低危', 'low'], 2: ['中危', 'medium'], 3: ['高危', 'high'], 4: ['严重', 'critical'] });
export const levelRanks = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
export const levelNameOf = rank => levelNames[Number(rank)] || ['未知', 'unknown'];
