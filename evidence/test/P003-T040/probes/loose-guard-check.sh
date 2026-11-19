#!/usr/bin/env bash
# 守卫硬度探针：验「哪些上界改动套件抓不住」（不是产品缺陷，是断言写宽的证据）。
# 用法：bash evidence/test/P003-T040/probes/loose-guard-check.sh（仓库根跑）
# 语义：前两条变异套件若仍全绿 = 守卫抓不住（本脚本据此 exit 0）；末条是控制组，必须变红，
#       否则说明探针本身失效（exit 1）。每个变异前后用 .bak 还原，不碰其他文件。
set -u
cd "$(dirname "$0")/../../../.." || exit 1
TEST=evidence/test/P003-T040/evidence-rollup.test.js
fail=0

probe() { # $1=名字 $2=文件 $3=旧串 $4=新串 $5=期望: green(抓不住) / red(控制组)
  local name="$1" file="$2" old="$3" new="$4" want="$5"
  cp "$file" "$file.bak"
  if ! OLD="$old" NEW="$new" python3 - "$file" <<'PY'
import os, sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old, new = os.environ['OLD'], os.environ['NEW']
assert s.count(old) == 1, 'anchor count %d' % s.count(old)
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
  then echo "SETUP_FAIL $name"; mv "$file.bak" "$file"; fail=1; return; fi
  if node --test --test-timeout=60000 "$TEST" >/tmp/hids-t040-loose.log 2>&1; then got=green; else got=red; fi
  mv "$file.bak" "$file"
  if [ "$got" = "$want" ]; then
    echo "REPRO $name → 套件 $got（期望 $want）"
  else
    echo "MISMATCH $name → 套件 $got（期望 $want）"
    fail=1
  fi
}

probe "必查项上界 64000→100000（文档值为 64000）" syslog-case.js \
  "requiredEvidenceMaxChars = 64000;" "requiredEvidenceMaxChars = 100000;" green
probe "节点 findings 上界 120000→10^9（上界形同取消）" trace-board.js \
  "export const findingsNodeMaxChars = 120000;" "export const findingsNodeMaxChars = 1000000000;" green
probe "omitted_fields 封顶 40→41（文档值为 40）" evidence-view.js \
  "export const syslogOmittedFieldsLimit = 40;" "export const syslogOmittedFieldsLimit = 41;" green
probe "控制组：节点上界 120000→1000（应当变红）" trace-board.js \
  "export const findingsNodeMaxChars = 120000;" "export const findingsNodeMaxChars = 1000;" red

if [ "$fail" -ne 0 ]; then echo "LOOSE_GUARD_CHECK_FAIL"; exit 1; fi
echo "LOOSE_GUARD_CHECK_REPRODUCED 3 条抓不住 + 1 条控制组变红"
