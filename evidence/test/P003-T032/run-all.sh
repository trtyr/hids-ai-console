#!/usr/bin/env bash
# P003-T032 三条探针串跑（A1 401 全链 / A2 暂停研判 / A3 溯源建边）。
# 全部是「替身牧云 + 替身模型 + 真 server.js 进程」，不连真牧云、不连 192.168.24.21。
# 跑法：bash evidence/test/P003-T032/run-all.sh   （退出码 0 = 三条全过）
set -u
cd "$(dirname "$0")/../../.." || exit 1
HERE=evidence/test/P003-T032
FAIL=0
for probe in probe-a1-401 probe-a2-pause probe-a3-trace; do
  echo "===== ${probe} ====="
  timeout 300 node "$HERE/${probe}.mjs"
  code=$?
  echo "----- ${probe} 退出码 ${code} -----"
  [ "$code" = "0" ] || FAIL=1
done
echo "===== 汇总：$([ "$FAIL" = "0" ] && echo ALL GREEN || echo 有失败项) ====="
exit "$FAIL"
