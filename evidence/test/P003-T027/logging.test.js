// P003-T027 日志覆盖收尾：三个文件接 log.js、syslog 匹配失败留原因、日志不出 Token 与密码。
// 只跑这个文件：node --test evidence/test/P003-T027/logging.test.js
// 全部用内存 journal（注入 write / now），不碰真实 stdout、不碰真实时钟、不起外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal, useJournal } from '../../../src/shared/logging/log.js';
import { initKeys, main } from '../../../package-policy.js';
import { logListening } from '../../../maintenance-server.js';
import { parseSyslog } from '../../../syslog-input.js';
import { matchSyslogEvent } from '../../../syslog-case.js';

const AT = '2026-11-19T00:00:00.000Z';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

// 每条日志一行 JSON：lines 是解析后的对象，raw 是原文（查「凭据有没有漏」按原文查）。
function collect() {
  const lines = [];
  const raw = [];
  useJournal(createJournal({ now: () => AT, write: line => { raw.push(line); lines.push(JSON.parse(line)); } }));
  return { lines, raw, event: name => lines.filter(line => line.event === name) };
}

const prefix = '<14>1 2026-11-11T08:00:00Z host cloudwalker 1 ';
const honeypot = fields => parseSyslog(prefix + 'cloudwalker-honeypot ' + fields);
const fields = 'host_ip="10.0.0.5" host_id=1 event_create_time="2026-11-11 08:00:00" source_ip="192.0.2.2"';

test('A1：三个文件里不再有 console 调用，打印一律走 log.js', async () => {
  for (const file of ['maintenance-server.js', 'package-policy.js', 'syslog-case.js']) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.deepEqual(source.match(/\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\b/g), null, `${file} 仍有 console 调用`);
  }
});

test('A1：维护端启动行落 maintenance.listening，旧文案留在 message 里', () => {
  const journal = collect();
  logListening({ port: 18081, preview: false });
  logListening({ port: 0, preview: true });
  const [normal, preview] = journal.event('maintenance.listening');
  assert.equal(normal.time, AT);
  assert.equal(normal.level, 'info');
  assert.deepEqual([normal.host, normal.port, normal.preview], ['127.0.0.1', 18081, false]);
  assert.equal(normal.message, 'HIDS maintenance: http://127.0.0.1:18081');
  // 部署端的就绪探测按这两个子串 grep，改造后仍要能命中。
  assert.equal(preview.preview, true);
  assert.match(preview.message, /HIDS maintenance（只读预览）: http:\/\/127\.0\.0\.1:0/);
});

test('A1：生成密钥落 policy.keys_created，输出文件仍是 700/600 且不覆盖', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'hids-policy-keys-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const directory = path.join(parent, 'keys');
  const journal = collect();
  await initKeys(directory);
  const [line] = journal.event('policy.keys_created');
  assert.equal(line.level, 'info');
  assert.equal(line.directory, directory);
  assert.deepEqual(line.files, ['signing-private.pem', 'signing-public.pem', 'encryption.key']);
  assert.equal(line.message, '密钥已创建。签名私钥只留在内部，不交付客户服务器。');
  assert.deepEqual((await readdir(directory)).sort(), [...line.files].sort());
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of line.files) assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600);
  await assert.rejects(() => initKeys(directory), /EEXIST/);
});

test('A1：命令行三条走法与退出码不变，用法分支落 policy.usage', async () => {
  const journal = collect();
  assert.equal(await main([]), 1);
  const [usage] = journal.event('policy.usage');
  assert.equal(usage.level, 'error');
  assert.match(usage.message, /--init-keys <内部密钥目录>/);
  assert.match(usage.message, /<公开更新说明\.json> <输出\.hids-policy>/);
  assert.match(usage.message, /HIDS_UPDATE_\* 环境变量/);
  // 做包分支的两道前置校验原样保留：缺环境变量 / 扩展名不对都抛错，不会被日志吞掉。
  await assert.rejects(() => main(['notes.json', 'out.hids-policy'], {}), /缺少 HIDS_UPDATE_KEY_FILE/);
  await assert.rejects(() => main(['notes.json', 'out.zip'], { HIDS_UPDATE_KEY_FILE: 'k' }), /\.hids-policy 扩展名/);
});

test('A3：生成密钥与启动行都不把密钥内容、账号口令写进日志', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'hids-policy-secret-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const journal = collect();
  await initKeys(path.join(parent, 'keys'));
  logListening({ port: 18081, preview: false });
  const text = journal.raw.join('');
  assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/);
  assert.doesNotMatch(text, /"content"|"privateKey"|"encryptionKey"/);
  // 日志里只出现路径与文件名，密钥的 base64 正文（以 M 开头的长串）一个字都不该有。
  assert.doesNotMatch(text, /[A-Za-z0-9+/]{60,}/);
});

test('A2：MsgId 不在映射表里时日志指名规则 msgid_map', async () => {
  const journal = collect();
  const match = await matchSyslogEvent({}, parseSyslog(prefix + 'cloudwalker-unknown-type host_ip="10.0.0.5"'));
  assert.equal(match.matched, false);
  const [line] = journal.event('syslog.match_failed');
  assert.equal(line.level, 'warn');
  assert.equal(line.rule, 'msgid_map');
  assert.equal(line.msgid, 'cloudwalker-unknown-type');
  assert.match(line.reason, /尚无牧云事件类型映射/);
});

test('A2：前置字段缺失时日志指名规则 payload，并列出缺哪几项', async () => {
  const journal = collect();
  const noHost = await matchSyslogEvent({}, honeypot('source_ip="192.0.2.2"'));
  assert.equal(noHost.matched, false);
  // 报文头的时间戳是 '-' 时事件时间也算缺：想要的时间读不出来。
  const noTime = await matchSyslogEvent({}, parseSyslog(
    '<14>1 - host cloudwalker 1 cloudwalker-honeypot host_ip="10.0.0.5"'));
  assert.equal(noTime.matched, false);
  const [first, second] = journal.event('syslog.match_failed');
  assert.equal(first.rule, 'payload');
  assert.deepEqual(first.missing, ['host_ip']);
  assert.match(first.reason, /缺少主机 IP 或有效事件时间/);
  assert.deepEqual(second.missing, ['event_time']);
});

test('A2：event_id 对不上时日志指名规则 event_id，并给出差在哪几项', async () => {
  const journal = collect();
  const parsed = honeypot(fields + ' event_id=7');
  const toolbox = { callTool: async () => ({ id: 9, host_id: 2, host_view: { host_ip: '10.0.0.6' } }) };
  const match = await matchSyslogEvent(toolbox, parsed);
  assert.equal(match.matched, false);
  const [line] = journal.event('syslog.match_failed');
  assert.equal(line.rule, 'event_id');
  assert.equal(line.event_id, 7);
  assert.deepEqual(line.mismatch, {
    event_id: { wanted: 7, returned: 9 },
    host_ip: { wanted: '10.0.0.5', returned: '10.0.0.6' },
    host_id: { wanted: 1, returned: 2 }
  });
  assert.match(line.reason, /主机与 syslog 不一致/);
});

test('A2：时间窗里没有候选时日志指名规则 time_window，并报最近一条差多远', async () => {
  const journal = collect();
  const parsed = honeypot(fields);
  const wanted = Date.parse('2026-11-11T08:00:00Z') / 1000;
  const toolbox = { listEvents: async () => ({ total: 2, events: [
    { id: 3, started_at: wanted + 600 }, { id: 4, started_at: wanted + 900 }] }) };
  const match = await matchSyslogEvent(toolbox, parsed);
  assert.equal(match.matched, false);
  const [line] = journal.event('syslog.match_failed');
  assert.equal(line.rule, 'time_window');
  assert.equal(line.window_seconds, 300);
  assert.equal(line.candidates, 2);
  assert.equal(line.nearest_gap_seconds, 600);
  assert.match(line.reason, /前后 5 分钟/);
});

test('A2：牧云查询失败时日志指名规则 time_window，并带失败原因', async () => {
  const journal = collect();
  const match = await matchSyslogEvent({ listEvents: async () => { throw new Error('rpc timeout'); } }, honeypot(fields));
  assert.equal(match.matched, false);
  const [line] = journal.event('syslog.match_failed');
  assert.equal(line.rule, 'time_window');
  assert.match(line.reason, /牧云事件查询失败：rpc timeout/);
});

test('A3：匹配失败原因里带凭据时，落到日志的原文已擦除', async () => {
  const journal = collect();
  const toolbox = { listEvents: async () => { throw new Error(
    'GET /api/v1/host/list?api_token=SECRET123456 failed, password=hunter2, Authorization: Bearer abcdef123456'); } };
  const match = await matchSyslogEvent(toolbox, honeypot(fields));
  assert.equal(match.matched, false);
  const text = journal.raw.join('');
  assert.equal(journal.lines.length, 1);
  assert.doesNotMatch(text, /SECRET123456/);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /abcdef123456/);
  assert.match(text, /\[redacted\]/);
});

// 事件名表的一行：首列里带反引号的 `事件名`，删掉整行就要红（不能只认「文档里出现过这个名字」）。
const docRow = (doc, event) => doc.split('\n').find(line => line.startsWith('|')
  && (line.split('|')[1] || '').includes('`' + event + '`'));

test('A1/A2：新事件名在 docs/architecture.md 事件名表里各占一行', async () => {
  const doc = await readFile(path.join(root, 'docs/architecture.md'), 'utf8');
  for (const event of ['maintenance.listening', 'policy.keys_created', 'policy.package_built',
    'policy.usage', 'syslog.match_failed'])
    assert.ok(docRow(doc, event), `docs/architecture.md 事件名表缺 ${event} 这一行`);
});

test('A2：事件表写的 syslog.match_failed 字段名与四条 rule 分支的真日志逐键对得上', async () => {
  const doc = await readFile(path.join(root, 'docs/architecture.md'), 'utf8');
  const row = docRow(doc, 'syslog.match_failed');
  assert.ok(row, 'docs/architecture.md 事件名表缺 syslog.match_failed 这一行');
  const documented = [...row.split('|')[3].matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
  const journal = collect();
  // 四条 rule 分支各真跑一次，键集合以落下来的日志为准，不以文档为准。
  await matchSyslogEvent({}, parseSyslog(prefix + 'cloudwalker-unknown-type ' + fields)); // msgid_map
  await matchSyslogEvent({}, honeypot('source_ip="192.0.2.2" event_create_time="2026-11-11 08:00:00"')); // payload
  await matchSyslogEvent({ callTool: async () => ({ id: 9, host_id: 2, host_view: { host_ip: '10.0.0.6' } }) },
    honeypot(fields + ' event_id=7')); // event_id
  await matchSyslogEvent({ listEvents: async () => ({ total: 0, events: [] }) }, honeypot(fields)); // time_window
  const lines = journal.event('syslog.match_failed');
  assert.deepEqual(lines.map(line => line.rule), ['msgid_map', 'payload', 'event_id', 'time_window']);
  const emitted = new Set(lines.flatMap(line => Object.keys(line)));
  assert.ok(documented.includes('type'), `事件表没写实际字段 type（实际键：${[...emitted].sort().join(',')}）`);
  for (const field of documented)
    assert.ok(emitted.has(field),
      `事件表写了 ${field}，真日志里没有这个键（实际键：${[...emitted].sort().join(',')}）`);
});
