// 事件类型和 RPC 服务名依据 cloudwalker-master/server 下各事件 API 的实现整理。
export const eventTypes = Object.freeze({
  webshell: 'WebShell', malware: '恶意文件', revshell: '反弹 Shell', memory_webshell: '内存马',
  brute_force: '暴力破解', abnormal_login: '异常登录', elevation_process: '提权进程',
  network_audit: '网络审计', suspicious_operation: '可疑操作', honeypot: '蜜罐', memory_security: '内存安全'
});
// 蜜罐列表方法为 List，其余为 GetEventList；直接请求 /rpc。
export const rpcMethods = Object.freeze({
  webshell: 'WebshellEventService', malware: 'MalwareEventService', revshell: 'RevshellEventService',
  memory_webshell: 'MemoryWebshellEventService', brute_force: 'BruteForceService',
  abnormal_login: 'AbnormalLoginEventService', elevation_process: 'ElevationProcessEventService',
  network_audit: 'NetworkAuditEventService', suspicious_operation: 'SuspiciousOperationService',
  honeypot: 'HoneypotService', memory_security: 'MemorySecurityEventService'
});

const string = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const first = (...values) => values.map(string).find(Boolean) || '';
// 时间口径：纯数字按秒/毫秒自适应，其余交给 Date 解析；解析不了返回 null。
// 对外导出，好让 server.js 的 from/to 校验与事件时间用同一套规则。
export const parseInstant = value => {
  const n = Number(value);
  const date = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const levelNames = { 1: ['低危', 'low'], 2: ['中危', 'medium'], 3: ['高危', 'high'], 4: ['严重', 'critical'] };
export const levelRanks = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
// 单次请求最多扫描多少条原始事件（带后置筛选 / sort=level 时才需要扫窗口）。
export const MAX_SCAN = 500;
function compareAlerts(a, b) {
  return (b.createdAt || '').localeCompare(a.createdAt || '') || a.id.localeCompare(b.id);
}
function compareByLevel(a, b) {
  return (levelRanks[b.levelKey] || 0) - (levelRanks[a.levelKey] || 0) || compareAlerts(a, b);
}
function titleOf(row, type) {
  const name = row.event_name;
  return first(typeof name === 'object' ? name?.zh_cn || name?.name || name?.title : name, row.rule_name, row.name, eventTypes[type]);
}
export function normalizeAlert(type, row) {
  const id = Number(row.id ?? row.event_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`牧云 ${type} 返回无效事件 ID`);
  const host = row.host_view || row.host || {};
  const hostIp = first(host.host_ip, host.ip);
  const outbound = type === 'revshell' || type === 'network_audit';
  const source = outbound
    ? first(row.local_addr, row.src_ip, hostIp, '待核查')
    : first(row.source_ip, row.login_ip, row.ssh_client_ip, row.src_ip, row.client_ip, '待核查');
  const target = outbound
    ? first(row.remote_addr, row.target, row.destination_ip, row.dst_ip, '待核查')
    : first(row.destination_ip, row.dst_ip, row.address, hostIp, '待核查');
  const level = levelNames[Number(row.level)] || ['未知', 'unknown'];
  const when = parseInstant(row.created_at ?? row.detected_at ?? row.event_time);
  return {
    id: `${type}:${id}`, eventType: type, eventId: id, hostId: Number(row.host_id || host.id) || null,
    createdAt: when, time: when ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(when)) : '—',
    title: titleOf(row, type), level: level[0], levelKey: level[1],
    asset: first(host.host_name, row.host_name, '未知主机'),
    source, target, assetIp: hostIp || null,
    account: first(row.username, row.login_username, row.user, row.uname, '待核查'),
    command: first(row.cmdline, row.command, row.shell_cmdline, row.process_cmdline, '需读取事件详情'),
    verdict: '待研判', verdictKey: 'review', coverage: null, cases: 0,
    scenario: eventTypes[type], detail: '已从牧云读取原始事件；尚未执行 AI 研判。',
    evidence: [`牧云 ${eventTypes[type]} 事件 #${id}`], gap: '待获取事件详情与关联证据',
    state: row.state ?? null
  };
}

export function detailEvidence(detail) {
  const fields = [
    ['命令行', 'cmdline'], ['命令行', 'shell_cmdline'], ['进程路径', 'process_path'],
    ['执行用户', 'uname'], ['远端地址', 'remote_addr'], ['本地地址', 'local_addr'],
    ['文件路径', 'file_path'], ['描述', 'description']
  ];
  const result = [];
  for (const [label, key] of fields) {
    const value = string(detail[key]);
    if (value) result.push(`${label}：${value.slice(0, 500)}`);
  }
  if (Array.isArray(detail.process_tree)) result.push(`进程树：${detail.process_tree.length} 个节点`);
  if (Array.isArray(detail.cmdlines)) result.push(`会话命令：${detail.cmdlines.length} 条`);
  return result;
}

// 列表动词：蜜罐是 List，其余 10 类是 GetEventList（见文件头注释）。
const listMethod = type => `${rpcMethods[type]}.${type === 'honeypot' ? 'List' : 'GetEventList'}`;
// 牧云可达、但这条事件读不到：HTTP 详情接口按 404 处理（server.js 认 status 字段）。
function eventMissing(type, id) {
  const error = new Error(`牧云 ${eventTypes[type]} 事件 #${id} 不存在或已不可见`);
  error.status = 404;
  return error;
}

// 取数缓存三档 TTL（P003-T037）。默认值就是文档口径；env 与构造参数可覆盖，0 表示不缓存。
// 非法值回落到默认：配置写坏了不能把缓存变成「永不过期」或「永不命中」这两头。
export const defaultTtls = Object.freeze({ status: 45_000, probe: 5_000, snapshot: 15_000 });
const ttlOf = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};
// 快照表只按「类型 × 批大小 × 起点」存，条目有限；超上限先清过期项，过期项也没有才丢最早的一条。
const MAX_SNAPSHOTS = 256;

// 判活缓存：`{ at, value }`，at 用注入的 now()，测试给假时钟即可过期。
const fresh = (entry, at, ttl) => Boolean(entry) && at - entry.at >= 0 && at - entry.at < ttl;

export class CloudwalkerGateway {
  constructor(rpc, { now = Date.now, statusTtlMs, probeTtlMs, snapshotTtlMs } = {}) {
    this.rpc = rpc;
    this.now = now;
    this.statusTtlMs = ttlOf(statusTtlMs ?? process.env.HIDS_STATUS_TTL_MS, defaultTtls.status);
    this.probeTtlMs = ttlOf(probeTtlMs ?? process.env.HIDS_PROBE_TTL_MS, defaultTtls.probe);
    this.snapshotTtlMs = ttlOf(snapshotTtlMs ?? process.env.HIDS_LIST_SNAPSHOT_TTL_MS, defaultTtls.snapshot);
    this.statusCache = null;
    this.probeCache = new Map();
    this.snapshotCache = new Map();
  }

  // /api/status 每次请求都会打到这里（server.js 的路由不改）：只缓存成功探活，30~60 秒内不再发 RPC。
  // 存的是 promise，并发的状态请求共用同一次探活；失败不写缓存——牧云刚恢复时下一次请求要立刻看到 connected。
  async status() {
    const cached = this.statusCache;
    if (fresh(cached, this.now(), this.statusTtlMs)) return { ...(await cached.promise) };
    const promise = this.rpc.call('RevshellEventService.GetEventList', { count: 1, offset: 0 })
      .then(() => ({ connected: true, eventTypes: Object.keys(eventTypes), transport: '牧云 /rpc' }))
      .catch(error => {
        if (this.statusCache?.promise === promise) this.statusCache = null;
        throw error;
      });
    this.statusCache = { at: this.now(), promise };
    return { ...(await promise) };
  }

  // 详情失败后的探活（alert 的失败路径）：同类型短期内只探一次。
  // 返回值只表示「这个类型列表探得通」，探活自己抛了什么不往外带——调用方要看的是详情那个原错。
  async #probeReachable(type) {
    const cached = this.probeCache.get(type);
    if (fresh(cached, this.now(), this.probeTtlMs)) return cached.reachable;
    let reachable = true;
    try { await this.rpc.call(listMethod(type), { count: 1, offset: 0 }); }
    catch { reachable = false; }
    this.probeCache.set(type, { at: this.now(), reachable });
    return reachable;
  }

  // 快照存的是 promise：并发的研判筛选与轮询同时到达时共用同一次取数（A10），不只共用已完成的结果。
  // 失败不缓存（失败的那个 promise 从表里摘掉）。
  #snapshot(key, load) {
    const cached = this.snapshotCache.get(key);
    if (fresh(cached, this.now(), this.snapshotTtlMs)) return cached.promise;
    const promise = load().catch(error => {
      if (this.snapshotCache.get(key)?.promise === promise) this.snapshotCache.delete(key);
      throw error;
    });
    if (this.snapshotCache.size >= MAX_SNAPSHOTS) {
      const at = this.now();
      for (const [entryKey, entry] of this.snapshotCache)
        if (!fresh(entry, at, this.snapshotTtlMs)) this.snapshotCache.delete(entryKey);
      if (this.snapshotCache.size >= MAX_SNAPSHOTS) this.snapshotCache.delete(this.snapshotCache.keys().next().value);
    }
    this.snapshotCache.set(key, { at: this.now(), promise });
    return promise;
  }

  async alerts({ count = 20, offset = 0, type, level, q, from, to, sort = 'time' } = {}) {
    if (type !== undefined && !Object.hasOwn(eventTypes, type)) throw new Error('不支持的事件类型');
    if (sort !== 'time' && sort !== 'level') throw new Error('不支持的排序方式');
    const pageSize = Math.min(Math.max(Number(count) || 20, 1), 50);
    const pageOffset = Math.max(Number(offset) || 0, 0);
    const batchSize = Math.max(20, pageSize);
    // type 下推：只查这一类，total 随之只含该类。
    const types = type ? [type] : Object.keys(eventTypes);
    const levels = Array.isArray(level) && level.length ? new Set(level) : null;
    const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase() : null;
    const matches = alert => {
      if (levels && !levels.has(levelRanks[alert.levelKey] || 0)) return false;
      if (from && !(alert.createdAt && alert.createdAt >= from)) return false;
      if (to && !(alert.createdAt && alert.createdAt <= to)) return false;
      if (needle) {
        const text = [alert.id, alert.title, alert.asset, alert.source, alert.target, alert.account, alert.command];
        if (!text.some(value => String(value ?? '').toLowerCase().includes(needle))) return false;
      }
      return true;
    };
    // 无后置筛选且按时间排时沿用流式归并（不额外扫描）；否则要扫窗口才能过滤计数与排序。
    const scanMode = Boolean(levels || needle || from || to) || sort === 'level';
    // 首批结果按（类型, 批大小, 起点）做 TTL 快照：研判侧筛选与自动研判轮询读的是同一批列表，
    // 同一窗口里只发一次 RPC。返回浅拷贝——调用方会排序/切页，不能让它改到缓存里的数组。
    const fetchBatch = async (type, start) => {
      const method = listMethod(type);
      const snapshot = await this.#snapshot(`${type}|${batchSize}|${start}`, async () => {
        const data = await this.rpc.call(method, { count: batchSize, offset: start });
        const rows = data.events ?? data.data ?? data.list;
        if (!Array.isArray(rows) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) {
          throw new Error(`${type} 列表响应格式无效`);
        }
        const events = rows.map(row => normalizeAlert(type, row));
        events.sort(compareAlerts);
        return { total: Number(data.total), events };
      });
      return { total: snapshot.total, events: [...snapshot.events] };
    };
    const settled = await Promise.allSettled(types.map(type => fetchBatch(type, 0)));
    const sources = [], totals = {}, errors = {};
    settled.forEach((item, index) => {
      const type = types[index];
      if (item.status === 'fulfilled') {
        const { total, events } = item.value;
        totals[type] = total;
        sources.push({ type, total, events, position: 0, fetched: events.length, failed: false });
        if (!events.length && total > 0) { errors[type] = '事件列表返回空页，但总数非零'; sources.at(-1).failed = true; }
      }
      else errors[type] = item.reason.message;
    });
    if (!sources.length) {
      throw new Error(`全部事件类型查询失败；首个错误：${Object.values(errors)[0]}`);
    }
    const selected = [];
    const pageLimit = pageOffset + pageSize;
    const scanLimit = scanMode ? Math.max(pageLimit, MAX_SCAN) : pageLimit;
    let scanned = 0;
    while (scanned < scanLimit) {
      const empty = sources.filter(source => !source.failed && source.position >= source.events.length && source.fetched < source.total);
      if (empty.length) {
        const refills = await Promise.allSettled(empty.map(source => fetchBatch(source.type, source.fetched)));
        refills.forEach((item, index) => {
          const source = empty[index];
          if (item.status === 'rejected') { errors[source.type] = item.reason.message; source.failed = true; return; }
          const { total, events } = item.value;
          source.total = total;
          totals[source.type] = total;
          if (!events.length && source.fetched < total) {
            errors[source.type] = '事件列表提前返回空页，分页可能不完整'; source.failed = true; return;
          }
          source.events = events;
          source.position = 0;
          source.fetched += events.length;
        });
      }
      const available = sources.filter(source => source.position < source.events.length);
      if (!available.length) break;
      available.sort((a, b) => compareAlerts(a.events[a.position], b.events[b.position]));
      const source = available[0];
      const event = source.events[source.position++];
      scanned += 1;
      if (!scanMode || matches(event)) selected.push(event);
      if (!scanMode && selected.length >= pageLimit) break;
    }
    if (scanMode) selected.sort(sort === 'level' ? compareByLevel : compareAlerts);
    const alerts = selected.slice(pageOffset, pageOffset + pageSize);
    const total = scanMode ? selected.length : Object.values(totals).reduce((sum, value) => sum + value, 0);
    const truncated = scanMode && scanned >= scanLimit
      && sources.some(source => source.position < source.events.length || (!source.failed && source.fetched < source.total));
    return { alerts, total, totals, errors, partial: Object.keys(errors).length > 0, truncated,
      query: { count: pageSize, offset: pageOffset },
      note: scanMode
        ? `筛选结果按扫描窗口统计：单次最多扫描 ${MAX_SCAN} 条原始事件，truncated 为 true 时 total 只含窗口内匹配。`
        : '按事件时间合并各类事件后分页；平台数据变化时，不同请求之间的页边界可能移动。' };
  }

  async alert(type, id) {
    if (!Object.hasOwn(eventTypes, type) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('无效的事件类型或 ID');
    let raw;
    try { raw = await this.rpc.call(`${rpcMethods[type]}.GetEvent`, { id: Number(id) }); }
    catch (cause) {
      // 拿不到「不可达」的结构化错误码（RpcClient 不在本卡 scope），只能再探一次同类列表：
      // 探得通说明故障只属于这条事件（通常就是 ID 不存在）→ 404；探不通算牧云不可达 → 原错上抛（502）。
      // 探活本身带短 TTL：一批详情同时失败时不会一条一个探活请求（A9）。
      if (!await this.#probeReachable(type)) throw cause;
      throw eventMissing(type, id);
    }
    const detail = raw && typeof raw === 'object' && raw.event && typeof raw.event === 'object' ? raw.event : raw;
    const returned = Number(detail?.event_id ?? detail?.id);
    // result 里没有事件身份（null / {} / {event:null}）同样是「这条事件读不到」。
    if (!Number.isSafeInteger(returned) || returned <= 0) throw eventMissing(type, id);
    if (returned !== Number(id)) throw new Error('牧云详情事件 ID 与请求不符');
    const normalized = normalizeAlert(type, { ...detail, id: Number(id) });
    const evidence = detailEvidence(detail);
    normalized.evidence.push(...evidence);
    normalized.command = first(detail.cmdline, detail.command, detail.shell_cmdline, normalized.command);
    normalized.account = first(detail.username, detail.login_username, detail.user, detail.uname, normalized.account);
    normalized.detail = evidence.length ? '已读取牧云事件详情；证据仅为原始字段，尚未形成 AI 结论。' : '事件详情未提供可展示的行为字段。';
    normalized.gap = '需核查会话授权、资产用途及相关历史；当前没有已审核案例结论';
    return { alert: normalized, detail };
  }
}
