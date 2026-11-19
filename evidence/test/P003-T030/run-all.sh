#!/usr/bin/env bash
# P003-T030 验收复跑：卡内六条单测 + tester 两条集成套件 + openapi 可解析。
# 退出码 0 = 全绿。任何一步非 0 就在最后以 1 退出（逐段打印各自 exit 码）。
# 不跑整仓 `npm test`（那是 CI 门，不属于卡内复跑；要跑请单独 `npm test`）。
set -u
cd "$(dirname "$0")/../../.."

fail=0
run() {
  echo "=== $*"
  timeout 300 "$@"
  local code=$?
  echo "--- exit=$code"
  [ "$code" -ne 0 ] && fail=1
  return 0
}

run node --test evidence/test/P003-T030/live-alert-to-triage.test.js
run node --test evidence/test/P003-T030/triage-http-contract.test.js
run node --test evidence/test/P003-T030/triage-real-fetch.test.js
run python3 -c "import yaml; d=yaml.safe_load(open('openapi.yaml')); assert len(d['paths']) > 0; print('openapi.yaml yaml ok, paths =', len(d['paths']))"

echo "=== all exit=$fail"
exit "$fail"
