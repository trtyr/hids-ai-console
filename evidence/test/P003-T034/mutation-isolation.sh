#!/usr/bin/env bash
# P003-T050 A5 变异自证：删掉任一注入点，该文件的隔离自证恰红；整套守卫也恰红。
#
# 做法：文件都已在树上提交 → 逐文件 `sed` 删掉那一行
#   `import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';`
# → 单跑该文件（期望 ✖）→ 再跑隔离守卫（期望 ✖，因为该文件会往影子全局根写/种子）→ `git checkout` 还原。
# 最后再删一次**助手里的注入语句**（`process.env.HIDS_DATA_DIR = isolatedRoot;`），三个代表文件都红。
#
# 用法（仓根，任何目录都行——脚本自己 cd 到仓根）：
#   bash evidence/test/P003-T034/mutation-isolation.sh
# 输出：evidence/test/P003-T034/t050-mutation.txt（同时打到 stdout）
set -uo pipefail
cd "$(dirname "$0")/../../.."
out=evidence/test/P003-T034/t050-mutation.txt
: > "$out"
say() { printf '%s\n' "$*" | tee -a "$out"; }

files=(
  agent-api.test.js
  api-tools.test.js
  investigation-agent.test.js
  maintenance-auth.test.js
  update-store.test.js
  wiki-current.test.js
  wiki.test.js
  evidence/test/P003-T011/rego-rules.e2e.test.js
  evidence/test/P003-T013/acceptance.test.js
  evidence/test/P003-T014/acceptance.test.js
  evidence/test/P003-T020/false-positive-http.test.js
  evidence/test/P003-T023/logging.test.js
  evidence/test/P003-T030/triage-http-contract.test.js
  evidence/test/P003-T030/triage-real-fetch.test.js
  evidence/test/P003-T039/context-slim.test.js
  evidence/test/P003-T040/evidence-rollup.test.js
  evidence/test/P003-T042/model-layers.test.js
  evidence/test/P003-T042/model-layers.tester.test.js
  evidence/test/P003-T046/investigation-replay.test.js
  evidence/test/P003-T046/model-call-events.test.js
  evidence/test/P003-T046/tester-http-acceptance.test.js
)
guard=evidence/test/P003-T034/global-root-isolation.test.js
summary() { grep -E "^ℹ (pass|fail)" | tr '\n' ' '; }

say "# P003-T050 A5 变异自证（$(date -Iseconds)）"
say "# 基线：注入点在树上时，每一条都绿（见 t050-suite-concurrent.txt / -serial.txt）"
say

for file in "${files[@]}"; do
  git diff --quiet -- "$file" || { say "!! $file 有未提交改动，先提交再跑变异"; exit 1; }
  sed -i '/isolate-data-root\.js/d' "$file"
  own=$(timeout 180 node --test --test-timeout=60000 --test-force-exit "$file" 2>&1)
  own_exit=$?
  own_line=$(grep -E "^✖ 全局根隔离" <<<"$own" | head -1)
  guard_out=$(timeout 240 node --test --test-timeout=120000 --test-force-exit "$guard" 2>&1)
  guard_exit=$?
  guard_line=$(grep -E "^✖ A2/A4" <<<"$guard_out" | head -1)
  git checkout -- "$file"
  say "## 删注入点：$file"
  say "  该文件自证：exit=$own_exit  ${own_line:-（没有找到 ✖ 全局根隔离 行！）}"
  say "  整套守卫：exit=$guard_exit  ${guard_line:-（守卫没红！）}"
  say
done

# 第二轮：不改文件、只把助手里的注入语句废掉——所有被隔离文件的自证都该红。
say "## 删注入语句：evidence/test/P003-T034/isolate-data-root.js 的 \`process.env.HIDS_DATA_DIR = isolatedRoot;\`"
sed -i 's|^  process.env.HIDS_DATA_DIR = isolatedRoot;$|  // 变异：注入语句被删|' evidence/test/P003-T034/isolate-data-root.js
for file in evidence/test/P003-T013/acceptance.test.js evidence/test/P003-T039/context-slim.test.js agent-api.test.js; do
  own=$(timeout 180 node --test --test-timeout=60000 --test-force-exit "$file" 2>&1)
  say "  $file：exit=$?  $(grep -E '^✖ 全局根隔离' <<<"$own" | head -1)"
done
git checkout -- evidence/test/P003-T034/isolate-data-root.js
say
say "## 还原核对"
say "  git status --short（应为空）："
git status --short | sed 's/^/    /' | tee -a "$out"
say "  git diff --stat（应为空）："
git diff --stat | sed 's/^/    /' | tee -a "$out"
