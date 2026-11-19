#!/usr/bin/env bash
# P003-T027 变异验证（何东阳 / 后端测试）——证明探针断言不是永真
#
#   A 假上游去掉 created_at      → 恰 A2-3 红
#   B 不发第一条报文（payload）  → A2-1 / A4-1 / A3-1 红
#   C 文档事件表 type→event_type → 恰 A4-1 红
#   D 删掉文档事件表整行         → 恰 A4-1 红
#   E 隔离失效（把 .data 也复制进运行根）→ 恰 A2-3 红（重放旧记录）
#
# 跑法：bash evidence/test/P003-T027/verify-mutations.sh
# 每个变异改前备份、跑完立即还原，最后比对 sha256 与绿跑。
set -u
cd "$(dirname "$0")/../../.." || exit 1
LOG=$(mktemp -d /tmp/p27-mut-XXXXXX)
PROBE=evidence/test/P003-T027/acceptance-e2e.mjs
DOC=docs/architecture.md
cp "$PROBE" "$LOG/probe.bak"
cp "$DOC" "$LOG/doc.bak"
restore() { cp "$LOG/probe.bak" "$PROBE"; cp "$LOG/doc.bak" "$DOC"; }
trap restore EXIT
fail=0

run_case() { # $1=名字 $2=期望失败的 id 前缀串
  timeout 300 node "$PROBE" > "$LOG/$1.log" 2>&1; local code=$?
  local line; line=$(grep -o '^失败项：.*' "$LOG/$1.log")
  echo "$1 EXIT=$code $(grep -o '==== [0-9]*/[0-9]* PASS ====' "$LOG/$1.log") ${line:-（无失败项）}"
  case "$line" in *"$2"*) ;; *) echo "  ! 变异 $1 没红到期望项（期望含 $2）"; fail=1;; esac
  [ "$code" != "0" ] || { echo "  ! 变异 $1 竟然全绿，断言永真"; fail=1; }
  restore
}

echo "== 变异 A：假上游去掉 created_at =="
python3 - "$PROBE" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
s=s.replace(", created_at: BASE + 600 },", " },").replace(", created_at: BASE + 900 },", " },")
open(p,'w',encoding='utf8').write(s)
PY
run_case A "A2-3"

echo "== 变异 B：不发第一条报文 =="
python3 - "$PROBE" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old="""    await send(port, `<134>1 ${iso(BASE)} host app - cloudwalker-webshell event_create_time="${fmtWall(BASE)}"`);                       // 缺 host_ip"""
assert old in s
s=s.replace(old, "    // [变异 B] 第一条不发")
open(p,'w',encoding='utf8').write(s)
PY
run_case B "A2-1"

echo "== 变异 C：文档事件表 type -> event_type =="
python3 - "$DOC" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old="`rule` `msgid` `type` `reason`"
assert s.count(old)==1, s.count(old)
open(p,'w',encoding='utf8').write(s.replace(old, "`rule` `msgid` `event_type` `reason`"))
PY
run_case C "A4-1"

echo "== 变异 D：删掉文档事件表整行 =="
python3 - "$DOC" <<'PY'
import sys
p=sys.argv[1]; lines=open(p,encoding='utf8').read().split('\n')
idx=[i for i,l in enumerate(lines) if l.startswith('| `syslog.match_failed` |')]
assert len(idx)==1, idx
del lines[idx[0]]
open(p,'w',encoding='utf8').write('\n'.join(lines))
PY
run_case D "A4-1"

echo "== 变异 E：隔离失效（把 .data 复制进运行根） =="
python3 - "$PROBE" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old="const skip = new Set(['.git', '.data', 'evidence']);"
assert old in s
s=s.replace(old, "const skip = new Set(['.git', 'evidence']);  // [变异 E] 故意带上 .data")
open(p,'w',encoding='utf8').write(s)
PY
run_case E "A2-3"

echo "== 还原校验 =="
sha256sum "$PROBE" "$DOC"
cmp -s "$PROBE" "$LOG/probe.bak" && echo "探针与备份一致" || { echo "探针没还原！"; fail=1; }
cmp -s "$DOC" "$LOG/doc.bak" && echo "文档与备份一致" || { echo "文档没还原！"; fail=1; }
timeout 300 node "$PROBE" > "$LOG/restored.log" 2>&1; code=$?
echo "还原后绿跑 EXIT=$code $(grep -o '==== [0-9]*/[0-9]* PASS ====' "$LOG/restored.log")"
[ "$code" = "0" ] || fail=1

echo "== 汇总 =="
if [ "$fail" = "0" ]; then echo "MUTATIONS OK（5 个变异全部恰红到期望项，还原后复绿；日志在 $LOG）"; else echo "变异验证有问题（日志在 $LOG）"; fi
exit "$fail"
