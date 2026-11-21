// 共享内核 · Alert 形状（P003-T075 批 2 抽取，D034 §2：外部两种来源收敛成同一个 Alert 形状，映射只有一张表）。
// normalizeAlert 把牧云 API 的一行原始事件拍平成全站统一的告警投影（列表 / 详情 / 溯源 / 案卷共用）；
// detailEvidence 从事件详情里挑可展示的行为字段。字段映射将来收敛 ingestion ACL 的一张表（T060 的 command
// 四键回退就是这张表的先例）。
import { eventTypes, levelNameOf, parseInstant } from './vocabulary.js';

const string = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
export const first = (...values) => values.map(string).find(Boolean) || '';

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
  const level = levelNameOf(row.level);
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
