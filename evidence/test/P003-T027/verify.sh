#!/usr/bin/env bash
# P003-T027 探针自测（何东阳 / 后端测试）——审计打回第 5 轮（隔离修法）的复现法
#
#   1) 探针连跑 6 遍：每遍 EXIT=0、17/17，运行根各不相同、跑完无残留
#   2) sleep 2 前后对照：无间隔连跑 A/B，sleep 2 之后 C 并紧接着 D——四遍全绿
#   3) 写者门禁 logging.test.js 13/13
#   4) 隔离校验：仓内 .data/triage-monitor.json sha256 全程不变（探针跑在临时根里）
#
# 跑法：bash evidence/test/P003-T027/verify.sh   （任何一步失败即非 0 退出）
# 每个外部命令都带 timeout，子进程由探针自己 waitExit/SIGKILL 收尾。
set -u
cd "$(dirname "$0")/../../.." || exit 1
LOG=$(mktemp -d /tmp/p27-verify-XXXXXX)
PROBE=evidence/test/P003-T027/acceptance-e2e.mjs
fail=0
pass_count() { grep -o '==== [0-9]*/[0-9]* PASS ====' "$1" | tail -1; }

echo "== 0. 探针不含固定 sleep =="
n=$(grep -c 'sleep(' "$PROBE"); echo "sleep( 计数 = $n"
[ "$n" = "0" ] || fail=1

echo "== 1. 仓内运行态基线 =="
sha_before=$(sha256sum .data/triage-monitor.json 2>/dev/null | awk '{print $1}'); echo "before=$sha_before"

echo "== 2. 连跑 6 遍 =="
for i in 1 2 3 4 5 6; do
  timeout 300 node "$PROBE" > "$LOG/run$i.log" 2>&1; code=$?
  echo "run$i EXIT=$code $(pass_count "$LOG/run$i.log") $(grep -o '\[run-root\] /tmp/[^（]*' "$LOG/run$i.log")"
  [ "$code" = "0" ] || fail=1
done

echo "== 3. sleep 2 前后对照 =="
for i in A B; do
  timeout 300 node "$PROBE" > "$LOG/gap0-$i.log" 2>&1; code=$?
  echo "gap0-$i EXIT=$code $(pass_count "$LOG/gap0-$i.log")"; [ "$code" = "0" ] || fail=1
done
sleep 2
for i in C D; do
  timeout 300 node "$PROBE" > "$LOG/gap2-$i.log" 2>&1; code=$?
  echo "gap2-$i EXIT=$code $(pass_count "$LOG/gap2-$i.log")"; [ "$code" = "0" ] || fail=1
done

echo "== 4. 写者门禁 =="
timeout 300 node --test evidence/test/P003-T027/logging.test.js > "$LOG/gate.log" 2>&1; code=$?
echo "gate EXIT=$code"; grep -E '^ℹ (tests|pass|fail)' "$LOG/gate.log"; [ "$code" = "0" ] || fail=1

echo "== 5. 隔离校验 =="
sha_after=$(sha256sum .data/triage-monitor.json 2>/dev/null | awk '{print $1}'); echo "after=$sha_after"
[ "$sha_before" = "$sha_after" ] || { echo "仓内 .data 被改动！"; fail=1; }
left=$(find /tmp -maxdepth 1 -type d -name 'p27-root-*' 2>/dev/null | wc -l); echo "运行根残留=$left"; [ "$left" = "0" ] || fail=1

echo "== 汇总 =="
if [ "$fail" = "0" ]; then echo "ALL GREEN（日志在 $LOG）"; else echo "有步骤失败（日志在 $LOG）"; fi
exit "$fail"
