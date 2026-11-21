import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eventSeconds, eventTypeFor, sessionKey } from '../../ingestion/application/parsing.js';
import { log } from '../../../shared/logging/log.js';
import { reasonForRecord } from '../../../shared/redaction.js';

// 匹配不上的每条分支都从这里出：日志留「哪条规则、差在哪」，返回体保持原样（只增键）。
// rule 取值见 docs/architecture.md「日志」一节的 syslog.match_failed 行。
// 两条路分开走（P003-T052）：日志行是 P003-T027 的契约，留原文（log.js 自己擦凭据）；
// 返回体里的 reason 会被写进案件文件 `03-研判事实.md` 与研判记录，必须过记录侧脱敏闸。
function unmatched(fields) {
  log('syslog.match_failed', fields, 'warn');
  return { matched: false, ...fields,
    ...(fields.reason == null ? {} : { reason: reasonForRecord(fields.reason) }) };
}

function apiSeconds(event) {
  for (const key of ['started_at', 'created_at', 'updated_at']) {
    const value = Number(event?.[key]);
    if (Number.isFinite(value) && value > 0) return value > 1e12 ? value / 1000 : value;
  }
  return null;
}

// 优先按 syslog event_id 精确读取；旧载荷没有 ID 时沿用同类同主机的首批事件时间匹配。
export async function matchSyslogEvent(toolbox, parsed) {
  const type = eventTypeFor(parsed.msgid);
  const hostIp = parsed.payload.host_ip;
  const wanted = eventSeconds(parsed);
  if (!type) return unmatched({ rule: 'msgid_map', msgid: parsed.msgid,
    reason: '该 MsgId 尚无牧云事件类型映射' });
  const eventId = Number(parsed.payload.event_id);
  if (Number.isSafeInteger(eventId) && eventId > 0 && toolbox?.callTool) {
    try {
      const event = await toolbox.callTool(`get_${type}_event`, { id: eventId });
      const returnedHost = event.host_view?.host_ip || event.host_ip;
      const returnedHostId = Number(event.host_id ?? event.host_view?.host_id);
      const returnedId = Number(event.id ?? event.event_id);
      // 差在哪：只把真对不上的那几项收进来，日志里一眼能看出是 ID 还是主机身份不一致。
      const mismatch = {};
      if (returnedId !== eventId) mismatch.event_id = { wanted: eventId,
        returned: Number.isFinite(returnedId) ? returnedId : null };
      if (!hostIp) mismatch.host_ip = { wanted: null, returned: String(returnedHost || '') || null };
      else if (String(returnedHost || '').replace(/\/32$/, '') !== String(hostIp).replace(/\/32$/, ''))
        mismatch.host_ip = { wanted: String(hostIp), returned: String(returnedHost || '') || null };
      if (!Number.isSafeInteger(returnedHostId) || returnedHostId !== Number(parsed.payload.host_id))
        mismatch.host_id = { wanted: Number.isFinite(Number(parsed.payload.host_id)) ? Number(parsed.payload.host_id) : null,
          returned: Number.isSafeInteger(returnedHostId) ? returnedHostId : null };
      if (Object.keys(mismatch).length)
        return unmatched({ rule: 'event_id', type, msgid: parsed.msgid, event_id: eventId, mismatch,
          reason: '牧云事件 ID 对应的主机与 syslog 不一致' });
      return { matched: true, type, alert_id: `${type}:${eventId}`, event_id: eventId, event,
        gap_seconds: wanted == null || apiSeconds(event) == null ? null : Math.floor(Math.abs(apiSeconds(event) - wanted)),
        candidates: 1, coverage: { returned: 1, total: 1, exact_event_id: true } };
    } catch (error) {
      return unmatched({ rule: 'event_id', type, msgid: parsed.msgid, event_id: eventId,
        reason: `牧云事件 ID 详情读取失败：${String(error.message).slice(0, 180)}` });
    }
  }
  if (!hostIp || wanted == null) return unmatched({ rule: 'payload', msgid: parsed.msgid,
    missing: [...(hostIp ? [] : ['host_ip']), ...(wanted == null ? ['event_time'] : [])],
    reason: 'syslog 缺少主机 IP 或有效事件时间' });
  try {
    const list = await toolbox.listEvents(type, { host_ip: hostIp, count: 50, offset: 0 });
    let best = null, gap = Infinity, nearest = null;
    for (const event of list.events || []) {
      const seconds = apiSeconds(event);
      if (seconds == null) continue;
      const current = Math.abs(seconds - wanted);
      // nearest 只为「差在哪」留证：窗内没有候选时，报最近的一条差多远。
      if (nearest == null || current < nearest) nearest = current;
      if (current <= 300 && current < gap) { best = event; gap = current; }
    }
    if (!best) return unmatched({ rule: 'time_window', type, msgid: parsed.msgid, host_ip: hostIp,
      window_seconds: 300, candidates: list.events?.length || 0,
      nearest_gap_seconds: nearest == null ? null : Math.floor(nearest),
      reason: '同主机首批事件中没有落在事件时间前后 5 分钟的同类记录' });
    const id = Number(best.id ?? best.event_id);
    if (!Number.isSafeInteger(id) || id <= 0) return unmatched({ rule: 'time_window', type, msgid: parsed.msgid,
      host_ip: hostIp, candidates: list.events?.length || 0, nearest_gap_seconds: Math.floor(gap),
      reason: '时间最接近的牧云事件没有有效 ID' });
    return { matched: true, type, alert_id: `${type}:${id}`, event_id: id, event: best,
      gap_seconds: Math.floor(gap), candidates: list.events.length,
      coverage: { returned: list.events.length, total: list.total, first_page_only: true } };
  } catch (error) { return unmatched({ rule: 'time_window', type, msgid: parsed.msgid, host_ip: hostIp,
    reason: `牧云事件查询失败：${String(error.message).slice(0, 180)}` }); }
}

const title = {
  webshell: 'WebShell', honeypot: '蜜罐诱捕', suspicious_operation: '可疑命令',
  abnormal_login: '异常登录', brute_force: '暴力破解', revshell: '反弹 Shell',
  malware: '恶意文件', elevation_process: '本地提权', network_audit: '网络异常'
};

export async function writeSyslogCase({ directory, raw, parsed, context, match, wiki }) {
  const type = eventTypeFor(parsed.msgid);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const digest = createHash('sha1').update(`${raw}\0${JSON.stringify(match?.event || {})}\0${JSON.stringify(context)}`)
    .digest('hex').slice(0, 8);
  const caseDir = path.join(directory, parsed.msgid, `${stamp}-${digest}-${randomUUID().slice(0, 8)}`);
  await mkdir(caseDir, { recursive: true, mode: 0o700 });
  const fields = Object.entries(parsed.payload).map(([key, value]) =>
    `| ${key.replaceAll('|', '\\|')} | ${String(value ?? '（空）').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`).join('\n');
  const files = {
    '00-这是什么.md': `# ${title[type] || type}告警的研判材料\n\n先看 03-研判事实.md，再按需核对原始告警、字段和上下文。判据从服务器 Wiki 按编号读取。\n\n告警类型：${parsed.msgid}\n生成时间：${new Date().toISOString()}\n`,
    '01-原始告警.txt': raw,
    '02-告警字段.md': `# 告警字段\n\n消息时间：${parsed.ts}；载荷格式：${parsed.payload_format}\n\n| 字段 | 值 |\n| --- | --- |\n${fields}\n`,
    '03-研判事实.md': `# 研判事实\n\n- syslog 消息类型：${parsed.msgid}\n- 主机 IP：${parsed.payload.host_ip || '未提供'}\n- 事件时间：${parsed.payload.event_create_time || parsed.payload.event_start_time || parsed.ts}\n- 来源：${parsed.payload.source_ip || parsed.payload.login_ip || '未提供'}\n- 命令：${parsed.payload.process_command_line || '未提供'}\n- 文件路径：${parsed.payload.file_path || '未提供'}\n- API 对应事件：${match?.matched ? match.alert_id : '未匹配'}\n- 匹配情况：${match?.matched ? match.coverage?.exact_event_id ? `按 syslog event_id 精确读取牧云事件；时间差 ${match.gap_seconds ?? '未知'} 秒` : `时间差 ${match.gap_seconds} 秒；只查询首批 ${match.coverage.returned}/${match.coverage.total} 条` : match?.reason || '未查询'}\n\n## 牧云 API 补充的当前页事件\n\n\`\`\`json\n${JSON.stringify(match?.event || {}, null, 2)}\n\`\`\`\n`,
    '04-上下文.md': `# 上下文\n\n会话：${sessionKey(parsed)}\n本条出现次数：${context.occurrence_count || 1}\n本条投递次数：${context.delivery_count || 1}\n同会话时间窗：前后各 5 分钟，当前已收到 ${context.window?.length || 0} 条。\n\n\`\`\`json\n${JSON.stringify({ window: context.window || [], history: context.history || [] }, null, 2)}\n\`\`\`\n`
  };
  if (wiki) {
    const index = await wiki.agentIndex(type);
    files['03b-判据索引.md'] = `# 本次可用判据\n\n${index.pages.map(page => `- ${page.id} · ${page.title}`).join('\n')}\n`;
  }
  await Promise.all(Object.entries(files).map(([name, body]) => writeFile(path.join(caseDir, name), body,
    { encoding: 'utf8', mode: 0o600 })));
  return { case_dir: caseDir, files: Object.keys(files) };
}

export async function writeSyslogResult(caseInfo, result) {
  const verdict = result.verdict || {};
  const lines = [
    '# 研判结果',
    '',
    `结论：${verdict.verdict_label || '存疑'}`,
    `置信度：${verdict.confidence || '低'}`,
    `事件关联：${result.syslog?.event_id_match ? '已关联牧云事件' : '牧云事件未匹配'}`,
    `重复投递：${result.repeat_count || 1} 次`,
    '',
    '## 给运维看的报告',
    '',
    verdict.report || verdict.analysis || verdict.summary || '本次研判未生成报告',
    '',
    '## 证据与复核',
    '',
    `可核验事实：${(verdict.claims || []).length} 条；证据校验：${result.validation?.ok ? '通过' : '未通过，需人工复核'}`,
    `数据缺口：${(verdict.missing_evidence || []).join('；') || '无已记录缺口'}`,
    `建议行动：${(verdict.next_actions || []).join('；') || '人工复核'}`,
    '',
    '结构化证据、引用与独立复核见同目录 result.json。',
    ''
  ];
  const output = { '05-研判结果.md': `${lines.join('\n')}\n`, 'result.json': JSON.stringify(result, null, 2) };
  for (const [name, body] of Object.entries(output)) {
    const filename = path.join(caseInfo.case_dir, name);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  }
}

export async function updateSyslogDeliveryCount(caseDir, count) {
  if (!caseDir) return;
  const jsonFile = path.join(caseDir, 'result.json');
  let result;
  try { result = JSON.parse(await readFile(jsonFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  result.repeat_count = count;
  if (result.syslog) result.syslog.repeat_count = count;
  const markdownFile = path.join(caseDir, '05-研判结果.md');
  const markdown = await readFile(markdownFile, 'utf8');
  for (const [filename, body] of [
    [jsonFile, JSON.stringify(result, null, 2)],
    [markdownFile, markdown.replace(/^重复投递：.*$/m, `重复投递：${count} 次`)]
  ]) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  }
}

export async function readCaseFile(caseInfo, name) {
  if (!caseInfo?.files?.includes(name)) throw new Error('研判材料文件不在当前告警目录');
  const content = await readFile(path.join(caseInfo.case_dir, name), 'utf8');
  if (content.length > 25000) return { name, error: '材料超过本次读取上限，请使用 03-研判事实.md 的摘要' };
  return { name, content };
}

// A1/A5：必查项结果落案卷。每项写「前 5 行 + returned_count + total + 证据编号」，
// 复算（重跑）只读本文件，不再发牧云 RPC。文件有字节上界：超界时先整项降级成「只留计数」，
// 仍放不下的项不静默丢——omitted_items 计数 + truncated 标记（读的人知道少了几项）。
export const requiredEvidenceFile = '06-必查项.json';
export const requiredEvidenceMaxChars = 64000;

// 案卷文件白名单（P003-T059 A02）：HTTP 出口只接受这些名字——路径穿越（../、绝对路径、URL 编码变体）
// 不可能命中白名单，天然被拒。清单 = 本模块产出的全部文件名 + 必查项 JSON（`requiredEvidenceFile`，
// 声明在上面：本表必须排在它之后，否则 const TDZ）。
export const CASE_FILE_WHITELIST = Object.freeze([
  '00-这是什么.md', '01-原始告警.txt', '02-告警字段.md', '03-研判事实.md', '03b-判据索引.md',
  '04-上下文.md', '05-研判结果.md', 'result.json', requiredEvidenceFile
]);
export const CASE_FILE_CONTENT_TYPES = Object.freeze({
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
});

function slimCheck(check) {
  const { first_rows: rows, ...rest } = check;
  return rows ? rest : check;
}

export async function writeRequiredEvidence(caseInfo, { alertId, mode, checks }) {
  const body = { alert_id: alertId, mode, written_at: new Date().toISOString(), checks: [] };
  let omittedItems = 0, slimmedItems = 0;
  for (const check of Array.isArray(checks) ? checks : []) {
    // 量的是真正要写出去的那串（pretty JSON），不是半成品。
    const measure = candidate => JSON.stringify({ ...body, checks: [...body.checks, candidate] }, null, 2).length;
    if (measure(check) <= requiredEvidenceMaxChars) body.checks.push(check);
    else if (measure(slimCheck(check)) <= requiredEvidenceMaxChars) { body.checks.push(slimCheck(check)); slimmedItems++; }
    else omittedItems++;
  }
  if (slimmedItems) { body.slimmed_items = slimmedItems; body.note = '部分项超过落盘上界，已降级为只留计数（前 5 行仍可从 result.json 的证据视图复算）'; }
  if (omittedItems) { body.truncated = true; body.omitted_items = omittedItems; }
  const filename = path.join(caseInfo.case_dir, requiredEvidenceFile);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
  if (!Array.isArray(caseInfo.files)) caseInfo.files = [];
  if (!caseInfo.files.includes(requiredEvidenceFile)) caseInfo.files.push(requiredEvidenceFile);
  return body;
}

// 复算入口：只读盘，不碰牧云。
export async function readRequiredEvidence(caseInfo) {
  if (!caseInfo?.case_dir) throw new Error('当前告警没有案卷目录');
  return JSON.parse(await readFile(path.join(caseInfo.case_dir, requiredEvidenceFile), 'utf8'));
}
