#!/usr/bin/env bash
# P003-T027 变异验证（何东阳 / 后端测试）——证明探针断言不是永真
#
#   A 假上游去掉 created_at           → 恰 A2-3 红（数值断言）
#   B 不发第一条报文（payload）        → A2-1 / A4-1 / A3-1 红
#   C 文档事件表 type→event_type       → 恰 A4-1 红
#   D 删掉文档事件表整行               → 恰 A4-1 红
#   E 隔离失效（运行根也复制 .data）    → A2-3 红（重放的 running 记录抢在本轮报文前到，nearest_gap 540≠480）
#   F 断言活性（重复一条同指纹 honeypot 报文 + 推迟打开上游故障）→ A2-3 的「条数」断言红（条数=2）
#
# E 的前置态由本脚本自己种，不依赖工作树里遗留的 .data（干净树上照样红）：
#   1) 把整棵树复制到临时目录 T；
#   2) 在 T 里用 P27_KEEP_RUN_ROOT=1 真跑一遍探针，拿「系统自己写出来的运行态」当种子；
#   3) 挑出本轮那条 honeypot 记录，把 status 改成 running（模拟进程中断时留在 running 的记录）、
#      case_dir 指到 T 里面，写进 T/.data/triage-monitor.json（目录 700、文件 600）；
#   4) 未变异的探针在 T 里必须 17/17 绿（隔离生效，种下的 .data 不进运行根）——这是 E 的对照；
#   5) 变异探针（skip 里去掉 .data）在 T 里必须红，且日志里 `.data 是否随树带过来：true`。
#   两轮事件时间基准钉在 P27_BASE_SECOND（种子轮 B、复跑轮 B+60），重放的 nearest_gap 因此是可复算的定值。
#
# F 不是产品行为变异，是「条数断言会不会红」的活性验证：E 里重放记录抢在本轮报文前到，
# 本轮那条 honeypot 因为上游已被探针打开成 500 而不计入，条数始终是 1——所以另做一条能红到条数的变异。
#
# 跑法：bash evidence/test/P003-T027/verify-mutations.sh
# 每个变异改前备份、跑完立即还原；脚本退出时 trap 兜底还原并删临时树。
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
LOG=$(mktemp -d /tmp/p27-mut-XXXXXX)
PROBE=evidence/test/P003-T027/acceptance-e2e.mjs
DOC=docs/architecture.md
cp "$PROBE" "$LOG/probe.bak"
cp "$DOC" "$LOG/doc.bak"
TREES=()
restore() { cp "$LOG/probe.bak" "$PROBE"; cp "$LOG/doc.bak" "$DOC"; }
cleanup() { restore; for t in "${TREES[@]:-}"; do [ -n "$t" ] && rm -rf "$t"; done; }
trap cleanup EXIT
fail=0

# run_case <树根> <名字> <期望失败项含子串> [KEY=VALUE ...]
# 断言：退出码非 0、失败项含期望子串。
run_case() {
  local dir=$1 name=$2 expect=$3; shift 3
  ( cd "$dir" && env "$@" timeout 300 node evidence/test/P003-T027/acceptance-e2e.mjs ) > "$LOG/$name.log" 2>&1
  local code=$?
  local line; line=$(grep -o '^失败项：.*' "$LOG/$name.log")
  local count; count=$(grep -o '条数=[0-9]*' "$LOG/$name.log" | head -1)
  local brought; brought=$(grep -o '\.data 是否随树带过来：[a-z]*' "$LOG/$name.log" | head -1 | sed 's/.*：//')
  echo "$name EXIT=$code $(grep -o '==== [0-9]*/[0-9]* PASS ====' "$LOG/$name.log") 运行根带.data=${brought:-?} ${count:+条数=${count#条数=} }${line:-（无失败项）}"
  case "$line" in *"$expect"*) ;; *) echo "  ! 变异 $name 没红到期望项（期望含 $expect）"; fail=1;; esac
  [ "$code" != "0" ] || { echo "  ! 变异 $name 竟然全绿，断言永真"; fail=1; }
}

# run_green <树根> <名字> [KEY=VALUE ...]：必须 EXIT=0 且 17/17
run_green() {
  local dir=$1 name=$2; shift 2
  ( cd "$dir" && env "$@" timeout 300 node evidence/test/P003-T027/acceptance-e2e.mjs ) > "$LOG/$name.log" 2>&1
  local code=$?
  local brought; brought=$(grep -o '\.data 是否随树带过来：[a-z]*' "$LOG/$name.log" | head -1 | sed 's/.*：//')
  echo "$name EXIT=$code $(grep -o '==== [0-9]*/[0-9]* PASS ====' "$LOG/$name.log") 运行根带.data=${brought:-?}"
  [ "$code" = "0" ] || { echo "  ! $name 本该全绿却红了"; fail=1; }
}

echo "== 变异 A：假上游去掉 created_at =="
python3 - "$PROBE" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
for a, b in ((", created_at: BASE + 600 },", " },"), (", created_at: BASE + 900 },", " },")):
    assert s.count(a) == 1, (a, s.count(a))
    s = s.replace(a, b)
open(p,'w',encoding='utf8').write(s)
PY
run_case "$ROOT" A "A2-3"
restore

echo "== 变异 B：不发第一条报文 =="
python3 - "$PROBE" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old="""    await send(port, `<134>1 ${iso(BASE)} host app - cloudwalker-webshell event_create_time="${fmtWall(BASE)}"`);                       // 缺 host_ip"""
assert old in s
s=s.replace(old, "    // [变异 B] 第一条不发")
open(p,'w',encoding='utf8').write(s)
PY
run_case "$ROOT" B "A2-1"
restore

echo "== 变异 C：文档事件表 type -> event_type =="
python3 - "$DOC" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old="`rule` `msgid` `type` `reason`"
assert s.count(old)==1, s.count(old)
open(p,'w',encoding='utf8').write(s.replace(old, "`rule` `msgid` `event_type` `reason`"))
PY
run_case "$ROOT" C "A4-1"
restore

echo "== 变异 D：删掉文档事件表整行 =="
python3 - "$DOC" <<'PY'
import sys
p=sys.argv[1]; lines=open(p,encoding='utf8').read().split('\n')
idx=[i for i,l in enumerate(lines) if l.startswith('| `syslog.match_failed` |')]
assert len(idx)==1, idx
del lines[idx[0]]
open(p,'w',encoding='utf8').write('\n'.join(lines))
PY
run_case "$ROOT" D "A4-1"
restore

echo "== 变异 E：隔离失效（运行根也带 .data）——前置态本脚本自己种 =="
TREE=$(mktemp -d /tmp/p27-mut-tree-XXXXXX)/tree
TREES+=("$(dirname "$TREE")")
mkdir -p "$TREE"
tar -C "$ROOT" -cf - --exclude=.git --exclude=.data . | tar -C "$TREE" -xf -
B=$(( $(date +%s) - 3600 ))
echo "  种子轮：在副本树里真跑一遍取运行态（P27_BASE_SECOND=$B，保留运行根）"
( cd "$TREE" && env P27_KEEP_RUN_ROOT=1 P27_BASE_SECOND="$B" timeout 300 node evidence/test/P003-T027/acceptance-e2e.mjs ) > "$LOG/E-seed.log" 2>&1
seed_code=$?
seed_root=$(grep -o '\[run-root-kept\].*' "$LOG/E-seed.log" | awk '{print $2}')
if [ "$seed_code" != "0" ] || [ -z "$seed_root" ] || [ ! -f "$seed_root/.data/triage-monitor.json" ]; then
  echo "  ! 种子态没生成（EXIT=$seed_code root=${seed_root:-空}）"; fail=1
else
  echo "  种子态：$seed_root/.data/triage-monitor.json（$(grep -o '==== [0-9]*/[0-9]* PASS ====' "$LOG/E-seed.log")）"
  python3 - "$seed_root/.data/triage-monitor.json" "$TREE" <<'PY'
import json, os, sys
state_path, tree = sys.argv[1], sys.argv[2]
state = json.load(open(state_path, encoding='utf8'))
host = [r for r in state['records'] if r['alert_id'].startswith('syslog:honeypot:')
        and ((r.get('input') or {}).get('parsed') or {}).get('payload', {}).get('host_ip') == '10.0.0.5']
assert len(host) == 1, host
rec = host[0]
rec['status'] = 'running'                                  # 模拟进程中断时留在 running 的记录（docs §5.1）
rec['stage'] = '研判中'
rec['case_dir'] = os.path.join(tree, '.data', 'cases', 'seed-replay')  # 原值是上一轮临时根的绝对路径
d = os.path.join(tree, '.data')
os.makedirs(d, mode=0o700, exist_ok=True)
out = os.path.join(d, 'triage-monitor.json')
with open(out, 'w', encoding='utf8') as f:
    json.dump(state, f, ensure_ascii=False)
os.chmod(out, 0o600)
print('  种下 running 记录：%s（事件时间 %s）' % (rec['alert_id'], rec['input']['parsed']['payload'].get('event_create_time')))
PY
  rm -rf "$seed_root"
fi
run_green "$TREE" "E-对照（未变异，种了 .data 也不该进运行根）" P27_BASE_SECOND=$((B + 60))
python3 - "$TREE/evidence/test/P003-T027/acceptance-e2e.mjs" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old="const skip = new Set(['.git', '.data', 'evidence']);"
assert old in s
open(p,'w',encoding='utf8').write(s.replace(old, "const skip = new Set(['.git', 'evidence']);  // [变异 E] 故意带上 .data"))
PY
run_case "$TREE" E "A2-3" P27_BASE_SECOND=$((B + 60))
grep -q '\.data 是否随树带过来：true' "$LOG/E.log" || { echo "  ! 变异 E 没把 .data 带进运行根，前置态没起作用"; fail=1; }
grep -q 'nearest_gap_seconds":540' "$LOG/E.log" || { echo "  ! 变异 E 的 nearest_gap 不是重放记录算出的 540"; fail=1; }
cp "$LOG/probe.bak" "$TREE/evidence/test/P003-T027/acceptance-e2e.mjs"

echo "== 变异 F：断言活性——重复一条同指纹 honeypot 报文，条数断言必须红 =="
python3 - "$PROBE" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
old='    await send(port, `<134>1 ${iso(EVENT_TIME)} host app - cloudwalker-honeypot host_ip=10.0.0.5 host_id=1 event_create_time="${fmtWall(EVENT_TIME)}"`);          // 时间窗外'
assert old in s
s=s.replace(old, old + '\n    await send(port, `<134>1 ${iso(BASE + 30)} host app - cloudwalker-honeypot host_ip=10.0.0.5 host_id=1 event_create_time="${fmtWall(BASE + 30)}"`);   // [变异 F] 同指纹再发一条（不同秒）')
old2="    fs.writeFileSync(up.failFlag, '1');"
assert old2 in s
s=s.replace(old2, "    await new Promise((r) => setTimeout(r, 2000));  // [变异 F] 推迟打开上游故障，让两条 honeypot 都跑完\n" + old2)
open(p,'w',encoding='utf8').write(s)
PY
run_case "$ROOT" F "A2-3"
grep -q '条数=2' "$LOG/F.log" || { echo "  ! 变异 F 没让「条数」断言变红（期望 条数=2）"; fail=1; }
grep -o '^失败项：.*' "$LOG/F.log" | grep -q 'A2-4' && { echo "  ! 变异 F 连带打红了 A2-4，不干净"; fail=1; }
restore

echo "== 还原校验 =="
sha256sum "$PROBE" "$DOC"
cmp -s "$PROBE" "$LOG/probe.bak" && echo "探针与备份一致" || { echo "探针没还原！"; fail=1; }
cmp -s "$DOC" "$LOG/doc.bak" && echo "文档与备份一致" || { echo "文档没还原！"; fail=1; }
cmp -s "$TREE/evidence/test/P003-T027/acceptance-e2e.mjs" "$LOG/probe.bak" && echo "副本树探针与备份一致" || { echo "副本树探针没还原！"; fail=1; }
timeout 300 node "$PROBE" > "$LOG/restored.log" 2>&1; code=$?
echo "还原后绿跑 EXIT=$code $(grep -o '==== [0-9]*/[0-9]* PASS ====' "$LOG/restored.log")"
[ "$code" = "0" ] || fail=1
left=$(find /tmp -maxdepth 1 -type d -name 'p27-root-*' 2>/dev/null | wc -l)
echo "运行根残留=$left"; [ "$left" = "0" ] || fail=1

echo "== 汇总 =="
if [ "$fail" = "0" ]; then echo "MUTATIONS OK（A/B/C/D/E/F 全部恰红到期望项，E 的前置态自种，还原后复绿；日志在 $LOG）"; else echo "变异验证有问题（日志在 $LOG）"; fi
exit "$fail"
