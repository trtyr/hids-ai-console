#!/usr/bin/env bash
# P003-T027 探针自测（何东阳 / 后端测试）——隔离修法的复现法
#
#   1) 探针不含固定 sleep（全部 waitUntil 轮询）
#   2) 探针连跑 6 遍：每遍 EXIT=0、17/17，运行根各不相同、跑完无残留、每遍都报「.data 未随树带过来」
#   3) sleep 2 前后对照：无间隔连跑 A/B，sleep 2 之后 C 并紧接着 D——四遍全绿
#   4) 写者门禁 logging.test.js 13/13
#   5) nonce 结论的可复跑脚本（nonce 不进指纹 + 改参与字段必须变）
#   6) 隔离校验：仓内 .data 整棵树前后指纹一致；**.data 本来不存在时必须仍不存在**
#      （不是「两个空串相等」——已修：缺 .data 的机器上这条以前是空转）
#
# 跑法：bash evidence/test/P003-T027/verify.sh   （任何一步失败即非 0 退出）
# 每个外部命令都带 timeout，子进程由探针自己 waitExit/SIGKILL 收尾。
set -u
cd "$(dirname "$0")/../../.." || exit 1
LOG=$(mktemp -d /tmp/p27-verify-XXXXXX)
PROBE=evidence/test/P003-T027/acceptance-e2e.mjs
fail=0
pass_count() { grep -o '==== [0-9]*/[0-9]* PASS ====' "$1" | tail -1; }

# 仓内运行态指纹：整个 .data 树（相对路径 + 大小 + sha256），目录不存在则打 absent。
# 不用 `sha256sum .data/x 2>/dev/null`——没有 .data 时那会得到空串，前后空串相等等于没校验。
state_fp() {
  if [ ! -e .data ]; then echo absent; return; fi
  find .data \( -type f -o -type l \) -print0 | sort -z \
    | xargs -0 -r sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
}
state_dirs() { [ -e .data ] && find .data -type d | wc -l || echo 0; }

echo "== 0. 探针不含固定 sleep =="
n=$(grep -c 'sleep(' "$PROBE"); echo "sleep( 计数 = $n"
[ "$n" = "0" ] || fail=1

echo "== 1. 仓内运行态基线 =="
before=$(state_fp); before_dirs=$(state_dirs)
echo "存在=$([ -e .data ] && echo yes || echo no) 文件树指纹=$before 目录数=$before_dirs"

echo "== 2. 连跑 6 遍 =="
for i in 1 2 3 4 5 6; do
  timeout 300 node "$PROBE" > "$LOG/run$i.log" 2>&1; code=$?
  brought=$(grep -o '\.data 是否随树带过来：[a-z]*' "$LOG/run$i.log" | head -1 | sed 's/.*：//')
  echo "run$i EXIT=$code $(pass_count "$LOG/run$i.log") 带.data=${brought:-?} $(grep -o '\[run-root\] /tmp/[^（]*' "$LOG/run$i.log")"
  [ "$code" = "0" ] || fail=1
  [ "$brought" = "false" ] || { echo "  ! run$i 的运行根带了 .data（隔离失效）"; fail=1; }
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

echo "== 5. nonce 结论脚本 =="
timeout 60 bash evidence/test/P003-T027/nonce-not-in-fingerprint.sh > "$LOG/nonce.log" 2>&1; code=$?
sed 's/^/  /' "$LOG/nonce.log"; echo "nonce EXIT=$code"
grep -q '换 nonce 后指纹是否相同 -> true' "$LOG/nonce.log" || { echo "  ! nonce 结论不成立"; fail=1; }
grep -q '改 source_ip 后指纹是否改变 -> true' "$LOG/nonce.log" || { echo "  ! 对照没变化，脚本量不出差异"; fail=1; }
[ "$code" = "0" ] || fail=1

echo "== 6. 隔离校验 =="
after=$(state_fp); after_dirs=$(state_dirs)
echo "存在=$([ -e .data ] && echo yes || echo no) 文件树指纹=$after 目录数=$after_dirs"
[ "$before" = "$after" ] || { echo "仓内 .data 被改动！"; fail=1; }
[ "$before_dirs" = "$after_dirs" ] || { echo "仓内 .data 目录数变了！"; fail=1; }
if [ "$before" = "absent" ]; then
  [ ! -e .data ] || { echo "  ! 跑前没有 .data，跑后却出现了"; fail=1; }
  echo "  .data 原本不存在，跑完仍不存在（这条以前是空转，现在真判）"
fi
left=$(find /tmp -maxdepth 1 -type d -name 'p27-root-*' 2>/dev/null | wc -l); echo "运行根残留=$left"; [ "$left" = "0" ] || fail=1

echo "== 汇总 =="
if [ "$fail" = "0" ]; then echo "ALL GREEN（日志在 $LOG）"; else echo "有步骤失败（日志在 $LOG）"; fi
exit "$fail"
