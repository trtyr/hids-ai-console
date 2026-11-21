import { createHash } from 'node:crypto';
import { log } from '../../../shared/logging/log.js';

// 牧云 SysLog 数据格式 2.0：RFC5424 行首，正文有结构化数据、JSON、键值对三种形态。
const pair = /([^\s=]+)="(.*?)"(?=\s+[^\s=]+=|\s*$)/gs;
const barePair = /(?:^|\s)([A-Za-z_][A-Za-z0-9_.-]*)=([^\s"'\[\]{}]+)(?=\s|$)/g;
const sdStart = /\[([A-Za-z0-9_.:-]{1,32})\s+(?=[^\s=]+=")/g;
const header = /^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*([\s\S]*)$/;
const msgids = Object.freeze({
  'cloudwalker-webshell': 'webshell', 'cloudwalker-honeypot': 'honeypot',
  'cloudwalker-suspicious-command': 'suspicious_operation',
  'cloudwalker-abnormal-login': 'abnormal_login', 'cloudwalker-brute-force': 'brute_force',
  'cloudwalker-revshell': 'revshell', 'cloudwalker-malware': 'malware',
  'cloudwalker-elevation-process': 'elevation_process',
  'cloudwalker-abnormal-network': 'network_audit'
});

function pairs(text) {
  const quoted = [...text.matchAll(pair)];
  const result = Object.fromEntries(quoted.map(match => [match[1].replace(/^\uFEFF/, ''), match[2]]));
  // 牧云键值对载荷混用带引号的文本和不带引号的数字字段，例如 event_id=1。
  // 先遮住已识别的引号字段，避免把命令行里的变量误认为告警字段。
  let remainder = text;
  for (const match of quoted.reverse())
    remainder = remainder.slice(0, match.index) + ' '.repeat(match[0].length) + remainder.slice(match.index + match[0].length);
  for (const match of remainder.matchAll(barePair)) result[match[1]] = match[2];
  return result;
}

function structured(text) {
  const starts = [...text.matchAll(sdStart)];
  const result = {};
  for (let index = 0; index < starts.length; index++) {
    const item = starts[index];
    const end = starts[index + 1]?.index ?? text.length;
    const body = text.slice(item.index + item[0].length, end).trim().replace(/\]$/, '');
    result[item[1]] = pairs(body);
  }
  return Object.assign({}, ...Object.values(result));
}

export function parseSyslog(line) {
  const raw = String(line || '').trim();
  const match = raw.match(header);
  if (!match) throw new Error('不是合法的 RFC5424 syslog 行');
  const body = match[8].trim();
  let payload, payloadFormat;
  if (body.startsWith('[')) { payload = structured(body); payloadFormat = 'structured-data'; }
  else if (body.startsWith('{')) {
    payload = JSON.parse(body); payloadFormat = 'json';
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('syslog JSON 正文不是对象');
    if (Object.values(payload).some(value => value && typeof value === 'object' && !Array.isArray(value)))
      payload = Object.assign({}, ...Object.values(payload).filter(value => value && typeof value === 'object' && !Array.isArray(value)));
  } else { payload = pairs(body); payloadFormat = 'keyvalue'; }
  if (!Object.keys(payload).length) throw new Error('syslog 正文解析后为空');
  return { msgid: match[7], ts: match[3], payload_format: payloadFormat, payload };
}

export function eventTypeFor(msgid) { return msgids[msgid] || null; }

export function eventSeconds(parsed, timeOffsetMinutes = Number(process.env.HIDS_SYSLOG_TIME_OFFSET_MINUTES || 0)) {
  const value = parsed.payload?.event_create_time || parsed.payload?.event_start_time || parsed.ts;
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  const text = String(value || '').trim();
  if (/^\d{10,13}$/.test(text)) return Number(text) > 1e12 ? Math.floor(Number(text) / 1000) : Number(text);
  // 牧云的事件字段是没有时区的本地时间；RFC5424 消息头则带 UTC 时区。
  // 部署端显式指定牧云事件的 UTC 偏移，避免受接收服务器本地时区影响。
  const naive = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text);
  const offset = Number.isFinite(timeOffsetMinutes) && Math.abs(timeOffsetMinutes) <= 14 * 60 ? timeOffsetMinutes : 0;
  const date = naive ? new Date(Date.parse(text.replace(' ', 'T') + 'Z') - offset * 60_000) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function envFields(raw) {
  let value = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = raw; } }
  if (Array.isArray(value)) return Object.fromEntries(value.filter(item => typeof item === 'string' && item.includes('='))
    .map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
  if (value && typeof value === 'object') return value;
  return Object.fromEntries([...String(value || '').matchAll(/(?:^|[\s,["])\s*([A-Z_]+)=([^\s,"\]]+)/g)].map(item => [item[1], item[2]]));
}

export function sessionKey(parsed) {
  const p = parsed.payload;
  const env = envFields(p.env);
  if (env.XDG_SESSION_ID) return `${p.host_ip || ''}|session:${env.XDG_SESSION_ID}`;
  if (p.session_id) return `${p.host_ip || ''}|session:${p.session_id}`;
  const source = p.source_ip || p.login_ip || String(env.SSH_CLIENT || env.SSH_CONNECTION || '').split(' ')[0];
  return `${p.host_ip || ''}|${source || 'local'}|${p.user_name || p.login_username || ''}`;
}

export function fingerprint(parsed) {
  const p = parsed.payload;
  const type = eventTypeFor(parsed.msgid);
  const selected = type === 'suspicious_operation'
    ? [p.process_command_line, p.file_path]
    : type === 'honeypot' ? [p.source_ip, p.target_ip, p.target_port]
      : [p.process_command_line, p.file_path, p.source_ip || p.login_ip, p.target_ip, p.target_port, p.file_md5];
  return createHash('sha256').update(JSON.stringify([p.host_ip || '', parsed.msgid, p.event_name || '',
    ...selected.map(value => String(value || ''))])).digest('hex').slice(0, 16);
}

