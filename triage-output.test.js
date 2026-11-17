import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeTriageOutput } from './triage-output.js';

test('customer judgment stays within 300 characters after a long model response', () => {
  const verdict = finalizeTriageOutput({ verdict: 'uncertain',
    report: `建议判定为存疑。${'需要核对原始事件。'.repeat(80)}`,
    summary: '来源主机对目标端口发起探测，当前只看到一次连接。',
    claims: [{ text: '来源为 192.0.2.1' }], missing_evidence: ['缺少发起进程和会话记录'],
    recommended_actions: ['核对来源主机的进程及会话'] });
  assert.ok(Array.from(verdict.report).length <= 300);
  assert.match(verdict.report, /存疑/);
  assert.match(verdict.report, /192\.0\.2\.1/);
  assert.deepEqual(verdict.next_actions, ['建议核对来源主机的进程及会话']);
});

test('downgraded false positive report and contradictory action are replaced', () => {
  const verdict = finalizeTriageOutput({ verdict: 'uncertain',
    report: '本次研判结论为误报。可以关闭告警。',
    summary: '授权情况尚未核实。', missing_evidence: ['独立复核未支持误报结论'],
    next_actions: ['核对工单和当前会话'] });
  assert.match(verdict.report, /建议判定为存疑/);
  assert.doesNotMatch(verdict.report, /误报/);
  assert.deepEqual(verdict.next_actions, ['建议核对工单和当前会话']);

  const benign = finalizeTriageOutput({ verdict: 'false_positive', summary: '已核实为巡检',
    next_actions: ['立即隔离主机'] });
  assert.doesNotMatch(benign.next_actions[0], /隔离/);
  assert.match(benign.next_actions[0], /^建议/);
});

test('customer report keeps a complete model sentence when only the verdict label is missing', () => {
  const report = 'ubuntu 上的 ct 经 sudo 执行 find 枚举 SUID 文件，退出码与授权尚未核实。';
  const verdict = finalizeTriageOutput({ verdict: 'uncertain', report,
    summary: '执行了 find 命令', claims: [{ text: '很长的原始命令 '.repeat(12) }] });
  assert.equal(verdict.report, `建议判定为存疑。${report}`);
});

test('fallback report omits overlong claims instead of clipping a command midword', () => {
  const verdict = finalizeTriageOutput({ verdict: 'uncertain', report: '不合格报告'.repeat(80),
    summary: '主机执行了 find 命令，仍需确认授权。',
    claims: [{ text: `执行命令 ${'find / -user root -perm -4000 -print '.repeat(5)}` }],
    missing_evidence: ['缺少授权记录'] });
  assert.doesNotMatch(verdict.report, /find \/ -user root -pe。/);
  assert.match(verdict.report, /仍需核查：缺少授权记录。/);
  assert.ok(Array.from(verdict.report).length <= 300);
});
