#!/usr/bin/env bash
# P003-T036 变异检查：逐条把本卡的实现改回错的样子，确认对应的单测会红（断言不是废断言）。
# 跑法：bash evidence/test/P003-T036/mutate-check.sh（每条打印「期望红 / 实际红」；最后恢复原文件）
set -u
cd "$(dirname "$0")/../../.." || exit 1
python3 - <<'PY'
import subprocess, sys

PATH = 'triage-monitor.js'
TEST = ['node', '--test', '--test-timeout=60000', 'evidence/test/P003-T036/queue-reliability.test.js']

MUTATIONS = [
    ('A1 死信判定失效（attempts 到上限也不标 dead_letter）',
     "    if (attempts >= this.retryMaxAttempts) {",
     "    if (false) {"),
    ('A2 暂停直接丢（不进缓冲）',
     "      if (this.pausedBuffer.length >= this.pausedBufferLimit) {",
     "      if (true) {"),
    ('A3 删记录时不失效 dedupe',
     "    for (const [fp, entry] of this.dedupe) if (entry.record_id === alertId) this.dedupe.delete(fp);",
     "    // 变异：不失效 dedupe"),
    ('A4 重复投递回到每条全量重存 + 立即写盘',
     "        } else this.pendingCounts.set(record.alert_id, record.repeat_count);",
     "        } else { await this.saveDeliveryCount(record.alert_id, record.repeat_count); await this.persist(); }"),
    ('A5 TTL 归档不做（记录一直留在内存）',
     "    if (!expired.length) return { archived: 0, remaining: this.records.size };",
     "    if (expired.length >= 0) return { archived: 0, remaining: this.records.size };"),
    ('A7 回补退回队列键',
     "    const keys = [...new Set([record.result_alert_id, record.matched_alert_id, record.alert_id].filter(Boolean))];",
     "    const keys = [record.alert_id];"),
    ('A9 取消接口不做状态判断（running 也能取消）',
     "    if (!['queued', 'failed'].includes(record.status)) {",
     "    if (false) {"),
    ('A6 summary 不报队列深度与失败原因',
     "        queue.depth += 1;",
     "        queue.depth += 0;"),
    ('A4 合并写 liveness 洞（在飞期间标脏后不补排）',
     "        .finally(() => { this.flushing = false; this.flushDone = null; if (this.writtenGen < this.dirtyGen) this.markDirty(); });",
     "        .finally(() => { this.flushing = false; this.flushDone = null; });"),
]

original = open(PATH).read()
overall = 0
print('# P003-T036 变异检查（每条都应打印 PASS）')
try:
    for name, old, new in MUTATIONS:
        assert original.count(old) == 1, f'变异锚点不唯一：{name}'
        open(PATH, 'w').write(original.replace(old, new))
        result = subprocess.run(TEST, capture_output=True, text=True)
        red = [line for line in result.stdout.splitlines() if line.startswith('✖ ')]
        if red:
            print(f'PASS 变异「{name}」→ {len(red)} 条单测变红')
            for line in red:
                print(f'       {line}')
        else:
            overall = 1
            print(f'FAIL 变异「{name}」→ 单测全绿（断言是废的）')
        open(PATH, 'w').write(original)
finally:
    open(PATH, 'w').write(original)

restored = subprocess.run(TEST, capture_output=True, text=True)
summary = [line for line in restored.stdout.splitlines() if line.startswith('ℹ pass') or line.startswith('ℹ fail')]
print('# 恢复后复跑：' + ' '.join(summary))
sys.exit(overall)
PY
