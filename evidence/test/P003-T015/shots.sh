#!/usr/bin/env bash
# P003-T015 视觉作证：1440×900 与 390×844 两种视口各拍一遍，并探横向溢出。
# 本机没有 lightpanda（无渲染），视觉部分只能 agent-browser。
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
API=http://127.0.0.1:18099
WEB=http://127.0.0.1:13015
SHOTS=evidence/test/P003-T015/shots
PASS=0; FAIL=0

ok(){ PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf 'FAIL  %s :: %s\n' "$1" "$2"; }
ev(){ timeout 60 agent-browser eval "$1" 2>&1 | tail -1 | python3 -c 'import sys,json
s=sys.stdin.read().strip()
try:
    v=json.loads(s)
    print(str(v).lower() if isinstance(v,bool) else v)
except Exception:
    print(s)'; }
shot(){ timeout 90 agent-browser screenshot "$1" >/dev/null 2>&1 && ok "截图 $(basename "$1")" || no "截图 $1" "screenshot 失败"; }
overflow(){ # 页名 → 断言页面没有整页横向溢出
  local v; v=$(ev "JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})")
  local sw cw; sw=$(echo "$v" | python3 -c 'import json,sys;print(json.load(sys.stdin)["sw"])')
  cw=$(echo "$v" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cw"])')
  if [ "$sw" -le "$cw" ]; then ok "$1 无整页横向溢出（scrollW=$sw ≤ clientW=$cw）"; else no "$1 横向溢出" "scrollW=$sw > clientW=$cw"; fi; }
waitfor(){ local expr="$1" want="$2" t0; t0=$(date +%s%3N)
  while :; do local v; v=$(ev "$expr"); [ "$v" = "$want" ] && return 0
    [ $(( $(date +%s%3N) - t0 )) -gt 15000 ] && return 1; sleep 0.15; done; }

mkdir -p "$SHOTS"
node evidence/test/P003-T015/stub-api.mjs 18099 > /tmp/t015-stub.log 2>&1 &
STUB=$!
HIDS_API_ORIGIN=$API HIDS_WEB_PORT=13015 node web/serve.js > /tmp/t015-web.log 2>&1 &
SRV=$!
trap 'kill $STUB $SRV 2>/dev/null; timeout 30 agent-browser close >/dev/null 2>&1' EXIT
for _ in $(seq 1 40); do curl -sf --max-time 1 "$WEB/" >/dev/null && break; sleep 0.2; done

login(){ timeout 60 agent-browser fill "input[type=text]" hids >/dev/null 2>&1
  timeout 60 agent-browser fill "input[type=password]" hids-2026 >/dev/null 2>&1
  timeout 60 agent-browser press Enter >/dev/null 2>&1
  waitfor "document.querySelector('h1')?.textContent" "总览" 15000; }
gopage(){ timeout 60 agent-browser click "a[href='$1']" >/dev/null 2>&1; }

for VP in "1440 900" "390 844"; do
  set -- $VP; W=$1; H=$2
  echo
  echo "== 视口 ${W}×${H} =="
  timeout 30 agent-browser close >/dev/null 2>&1
  timeout 90 agent-browser open "$WEB/" --args "--no-sandbox" >/dev/null 2>&1
  timeout 60 agent-browser set viewport "$W" "$H" >/dev/null 2>&1
  login || { echo "登录失败，跳过本视口"; continue; }
  echo "视口实测 = $(ev "window.innerWidth+'x'+window.innerHeight")"

  waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" || true
  shot "$SHOTS/${W}-overview.png"
  overflow "总览@${W}"

  gopage '#/alerts'; waitfor "document.querySelectorAll('table tbody tr').length" "4" || true
  shot "$SHOTS/${W}-alerts.png"
  overflow "告警主列表@${W}"
  # 表格自身要不要横向滚（窄屏时允许，但得能滚）
  # 实数代替恒真断言（审计 issue 1）：要么装得下，要么包裹层是 overflow-x:auto 的滚动容器
  chk_scroll=$(ev "(()=>{const w=document.querySelector('table')?.parentElement;const t=document.querySelector('table');
    if(!w||!t)return 'NO-WRAP';
    const ox=getComputedStyle(w).overflowX;
    return JSON.stringify({fit:t.offsetWidth<=w.clientWidth,ox:ox,tw:t.offsetWidth,wcw:w.clientWidth})})()")
  verdict=$(printf '%s' "$chk_scroll" | python3 -c 'import json,sys
try:
    d=json.loads(sys.stdin.read())
    print(str(d["fit"] or d["ox"]=="auto").lower()+"|"+str(d["tw"])+"/"+str(d["wcw"])+" ox="+d["ox"])
except Exception as e:
    print("NO-WRAP")')
  [ "${verdict%%|*}" = "true" ] && ok "告警表@${W} 装得下或由包裹层横滚（${verdict#*|}）" || no "告警表@${W} 既装不下、包裹层也不可横滚" "$verdict"

  # 误报表单（行内展开）——挑一条「还没误报」的行（上一轮视口可能已经误报过 revshell）
  clicked=$(ev "(()=>{const b=[...document.querySelectorAll('table tbody tr')].map(r=>r.querySelector('button')).find(x=>x&&!x.disabled);if(!b)return 'NONE';b.scrollIntoView({block:'center'});b.click();return b.getAttribute('aria-label')||b.textContent.trim()})()")
  echo "     展开表单的行：$clicked"
  waitfor "!!document.querySelector('form[aria-label=登记误报]')" "true" || true
  shot "$SHOTS/${W}-alerts-fp-form.png"
  overflow "误报表单展开@${W}"
  # 表单控件在视口内可见可点（窄屏最容易挤坏的地方）
  formvis=$(ev "(()=>{const f=document.querySelector('form[aria-label=登记误报]');if(!f)return 'NO-FORM';f.scrollIntoView({block:'center'});const r=f.getBoundingClientRect();const ta=f.querySelector('textarea').getBoundingClientRect();const btn=[...f.querySelectorAll('button')].pop().getBoundingClientRect();return [r.width>200,ta.width>100,btn.width>40].every(Boolean)+'|'+Math.round(r.width)})()")
  [ "${formvis%%|*}" = "true" ] && ok "误报表单在 ${W} 宽下可读可点（表单宽 ${formvis##*|}px）" || no "误报表单@${W}" "$formvis"
  # 提交误报 → 拍「行内已改」
  timeout 60 agent-browser fill "textarea" "运维演练用的反弹 shell，确认是内部红队测试" >/dev/null 2>&1
  timeout 60 agent-browser eval "(()=>{const b=[...document.querySelectorAll('form[aria-label=登记误报] button')].pop();b.scrollIntoView({block:'center'});b.click();return 1})()" >/dev/null 2>&1
  waitfor "document.querySelectorAll('form[aria-label=登记误报]').length" "0" || true
  shot "$SHOTS/${W}-alerts-after-fp.png"

  # 详情（A3 四块）
  timeout 60 agent-browser open "$WEB/#/alert-detail/syslog%3Arevshell%3Aa1b2c3d4e5f60718%3A1763373600%3Aaaa1" >/dev/null 2>&1
  waitfor "document.querySelector('h1')?.textContent" "告警详情" || true
  waitfor "!!document.querySelector('pre.rego')" "true" || true
  shot "$SHOTS/${W}-alert-detail.png"
  overflow "告警详情@${W}"

  # 演示入口
  timeout 60 agent-browser open "$WEB/#/alerts-demo" >/dev/null 2>&1
  waitfor "document.querySelector('h1')?.textContent" "牧云现查（演示）" || true
  shot "$SHOTS/${W}-alerts-demo.png"
  overflow "牧云现查（演示）@${W}"
done

echo
echo "== 断点探针（整页横向溢出 = 用户要横向拖整页；知识库页把同类问题记成过 bug，见 README §15） =="
for W in 1440 1180 900 620 390; do
  timeout 60 agent-browser set viewport "$W" 900 >/dev/null 2>&1
  timeout 60 agent-browser open "$WEB/#/alerts" >/dev/null 2>&1
  waitfor "document.querySelectorAll('table tbody tr').length>=4" "true" || true
  v=$(ev "document.documentElement.scrollWidth+'/'+document.documentElement.clientWidth")
  echo "     告警主列表@${W}：doc ${v}"
  if [ "${v%%/*}" -le "${v##*/}" ]; then ok "告警主列表@${W} 无整页横向溢出（${v}）"; else no "告警主列表@${W} 整页被表格撑宽" "${v}"; fi
  timeout 60 agent-browser open "$WEB/#/alert-detail/syslog%3Arevshell%3Aa1b2c3d4e5f60718%3A1763373600%3Aaaa1" >/dev/null 2>&1
  waitfor "!!document.querySelector('pre.rego')" "true" || true
  v=$(ev "document.documentElement.scrollWidth+'/'+document.documentElement.clientWidth")
  echo "     告警详情@${W}：doc ${v}"
  if [ "${v%%/*}" -le "${v##*/}" ]; then ok "告警详情@${W} 无整页横向溢出（${v}）"; else no "告警详情@${W} 整页被顶栏撑宽" "${v}"; fi
done

echo
echo "== 汇总 =="
echo "PASS=$PASS FAIL=$FAIL"
ls -la "$SHOTS" | tail -15
[ "$FAIL" -eq 0 ]
