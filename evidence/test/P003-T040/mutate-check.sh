#!/usr/bin/env bash
# P003-T040 变异检查：逐项把改动回退成老样子，evidence-rollup.test.js 必须变红。
# 用法：bash evidence/test/P003-T040/mutate-check.sh（在仓库根跑；每次变异前后用 .bak 还原，不碰其他文件）
set -u
cd "$(dirname "$0")/../../.." || exit 1
TEST=evidence/test/P003-T040/evidence-rollup.test.js
fail=0

mutate() { # $1=名字 $2=文件 $3=python 脚本文件
  local name="$1" file="$2" script="$3"
  cp "$file" "$file.bak"
  if ! python3 "$script" "$file"; then echo "MUTATION_SETUP_FAIL $name"; mv "$file.bak" "$file"; fail=1; return; fi
  if node --test --test-timeout=60000 "$TEST" >/tmp/hids-t040-mut.log 2>&1; then
    echo "FAIL 变异「$name」没有变红"
    fail=1
  else
    echo "PASS 变异「$name」→ 变红"
  fi
  mv "$file.bak" "$file"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/m1.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "  const bounded = boundedFindingsRows(matching, key);"
new = "  const bounded = { rows: matching.slice(0, 12).map(({ row, index }) => ({ facts: rowFacts(row, [key, index]) })), omitted: 0 };"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF
cat >"$work/m2.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "export const syslogOmittedFieldsLimit = 40;"
new = "export const syslogOmittedFieldsLimit = 100000;"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF
cat >"$work/m3.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "    view: view ? boundEvidenceView(view, persistedEvidenceViewMax) : null }));"
new = "    view: null }));"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF
cat >"$work/m4.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "    return Array.isArray(items) && items.length ? { ...check, first_rows: items.slice(0, requiredEvidenceRows) } : check;"
new = "    return check;"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF
cat >"$work/m5.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "  if (!argsHaveRawText(args) && JSON.stringify(args).length <= queueArgsMaxChars) item.args = args;\n  else item.args_omitted = true;"
new = "  item.args_omitted = true;"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF
cat >"$work/m6.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "  cmdlines: ['seq', 'cmdline', 'command', 'started_at', 'finished_at', 'exit_code', 'label']"
new = "  unused_cmdlines: ['seq', 'cmdline']"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF
cat >"$work/m7.py" <<'EOF'
import sys
p, s = sys.argv[1], open(sys.argv[1], encoding='utf-8').read()
old = "  ['comment', ['comment']], ['description', ['description']]"
new = "  ['comment', ['comment']]"
assert s.count(old) == 1, "anchor"
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
EOF

mutate "A4 findings 回到 12 行" trace-board.js "$work/m1.py"
mutate "A5 omitted_fields 不封顶" evidence-view.js "$work/m2.py"
mutate "A2 evidence 只留 sha256" investigation-agent.js "$work/m3.py"
mutate "A1 必查项不落前 5 行" investigation-agent.js "$work/m4.py"
mutate "A6 队列一律剥 args" triage-monitor.js "$work/m5.py"
mutate "A7 cmdlines 不进证据视图" evidence-view.js "$work/m6.py"
mutate "A7 description 不进证据视图" evidence-view.js "$work/m7.py"

if [ "$fail" -ne 0 ]; then echo "MUTATION_CHECK_FAIL"; exit 1; fi
echo "MUTATION_CHECK_PASS 7/7"
