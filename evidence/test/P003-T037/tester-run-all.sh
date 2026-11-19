#!/usr/bin/env bash
# P003-T037 测试席复跑入口（黑盒探针）。每支单独 timeout，进程自回收，不跑整套 npm test（单测归写者）。
# 用法：bash evidence/test/P003-T037/tester-run-all.sh
# 退出码 = 有红即 1。已知红：tester-http-e2e / tester-http-concurrency 的 HIDS_TRIAGE_CONCURRENCY 断言（见 test-report.md finding 1）。
set -u
cd "$(dirname "$0")/../../.." || exit 1
OUT=evidence/test/P003-T037/tester-logs
mkdir -p "$OUT"
fail=0
run() {
  local name=$1; shift
  echo "== $name =="
  timeout 240 "$@" > "$OUT/$name.txt" 2>&1
  local code=$?
  tail -1 "$OUT/$name.txt"
  [ "$code" -ne 0 ] && { echo "  ✖ $name 退出码 $code（日志：$OUT/$name.txt）"; fail=1; }
  return 0
}
run tester-queue node evidence/test/P003-T037/tester-queue.mjs
run tester-gateway node evidence/test/P003-T037/tester-gateway.mjs
run tester-stores node evidence/test/P003-T037/tester-stores.mjs
run tester-agent node evidence/test/P003-T037/tester-agent.mjs
run tester-http-e2e node evidence/test/P003-T037/tester-http-e2e.mjs
run tester-http-concurrency node evidence/test/P003-T037/tester-http-concurrency.mjs
exit "$fail"
