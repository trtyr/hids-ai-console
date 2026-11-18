#!/usr/bin/env bash
# P003-T016 前端验收 · 真浏览器行为测（agent-browser 驱动真实 Chrome）。
# 本机没有 lightpanda 二进制（find / -maxdepth 5 -name 'lightpanda*' 为空），只测行为也走 agent-browser；
# 行为测与视觉截图同引擎，报告里注明。
# 前置：没有。本脚本自己起桩后端（evidence/test/P003-T016/stub-api.mjs + stub-trace.mjs）与 web/serve.js，跑完收进程。
# 判据全部来自 web/README.md §4 / §12（+ 任务卡 A1–A5）与 openapi.yaml 的形状；不看实现源码。
# 断言纪律（P003-T016 审计 reject_test 后补）：
#   1) 可见性：凡说「有按钮」都数 offsetParent≠null && rect>0 的那个；hidden/display:none 的存在性不算（visn 助手）
#   2) 正向锚点：白板断言先等顶栏状态/链长/点数，再数输入框；白板没画出来时 A5 三条否定断言必须红
#   3) 不等 sleep 等状态：异步一律 waitfor/waitcl 轮询；0.3s 短停只用于停在瞬时态（loading）上取样
#   4) 恢复路径用真鼠标坐标（realclick 助手），el.click() 点 display:none 的按钮也能“恢复”，那不算用户能点
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
API=http://127.0.0.1:18106
WEB=http://127.0.0.1:13016
SHOTS=evidence/test/P003-T016/shots
PASS=0; FAIL=0; FAILED=()
CNT=/tmp/t016-e2e-count.$$; : > "$CNT"
mkdir -p "$SHOTS"

ok(){ PASS=$((PASS+1)); printf 'p\n' >> "$CNT"; printf 'PASS  %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); FAILED+=("$1"); printf 'f\n' >> "$CNT"; printf 'FAIL  %s\n        期望: %s\n        实测: %s\n' "$1" "$2" "$3"; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else FAIL=$((FAIL+1)); FAILED+=("$1"); printf 'f\n' >> "$CNT"; printf 'FAIL  %s\n        期望: %s\n        实测: %s\n' "$1" "$3" "$2"; fi; }
has(){ case "$3" in *"$2"*) ok "$1";; *) no "$1" "包含「$2」" "$3";; esac; }
hasnt(){ case "$3" in *"$2"*) no "$1" "不含「$2」" "$3";; *) ok "$1";; esac; }
num(){ python3 -c 'import sys;print(int(sys.argv[1]) if sys.argv[1].lstrip("-").isdigit() else 0)' "$1"; }

ev(){ timeout 60 agent-browser eval "$1" 2>&1 | tail -1 | python3 -c 'import sys,json
s=sys.stdin.read().strip()
try:
    v=json.loads(s)
    print(str(v).lower() if isinstance(v,bool) else v)
except Exception:
    print(s)'; }
shot(){ timeout 90 agent-browser screenshot "$1" >/dev/null 2>&1 && ok "截图 $(basename "$1")" || no "截图 $1" "screenshot 失败" ""; }
ctl(){ curl -s -X POST -d "$1" -H 'content-type: application/json' "$API/__ctl/mode" >/dev/null; }
resetlog(){ curl -s -X POST "$API/__ctl/reset-log" >/dev/null; }
hits(){ curl -s --max-time 5 "$API/__ctl/log" | python3 -c "import json,sys;p=sys.argv[1];m=sys.argv[2]
rs=json.load(sys.stdin)['requests']
print(sum(1 for r in rs if p in r['path'] and (m=='*' or r['method']==m)))" "$1" "${2:-*}"; }
lastbody(){ curl -s --max-time 5 "$API/__ctl/log" | python3 -c "import json,sys;p=sys.argv[1]
rs=[r for r in json.load(sys.stdin)['requests'] if r['method']=='POST' and p in r['path']]
print(rs[-1]['body'] if rs else 'NONE')" "$1"; }
waitfor(){ local expr="$1" want="$2" t0; t0=$(date +%s%3N)
  while :; do
    local v; v=$(ev "$expr")
    [ "$v" = "$want" ] && return 0
    [ $(( $(date +%s%3N) - t0 )) -gt "${3:-12000}" ] && return 1
    sleep 0.12
  done; }
waitcl(){ local expr="$1" pat="$2" t0; t0=$(date +%s%3N)
  while :; do
    local v; v=$(ev "$expr")
    case "$v" in *"$pat"*) return 0;; esac
    [ $(( $(date +%s%3N) - t0 )) -gt "${3:-12000}" ] && { echo "TIMEOUT $expr ~ $pat → $v"; return 1; }
    sleep 0.12; done; }
nav(){ # 先跳去别的路由再回来，强制页面重新挂载取数（不整页 reload，reload 会丢内存凭据）
  timeout 60 agent-browser eval "location.hash='$1';'ok'" >/dev/null 2>&1; sleep 0.35
  timeout 60 agent-browser eval "location.hash='$2';'ok'" >/dev/null 2>&1; }
clicktext(){ timeout 60 agent-browser eval "(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>x.textContent.trim()==='$1');if(!b)return 'NO-BTN';b.click();return 'ok'})()" 2>&1 | tail -1; }
login(){ timeout 60 agent-browser fill "input[type=text]" hids >/dev/null 2>&1
  timeout 60 agent-browser fill "input[type=password]" hids-2026 >/dev/null 2>&1
  timeout 60 agent-browser press Enter >/dev/null 2>&1
  waitfor "document.querySelector('h1')?.textContent" "总览" 15000; }
rows(){ ev "document.querySelectorAll('table tbody tr').length"; }
# 可见性探针：offsetParent 非空 + rect 有尺寸 + visibility 不是 hidden（display:none 的 hidden 按钮一律不算“可见”）
visn(){ ev "((txt)=>{const vis=e=>e.offsetParent!==null&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';return [...document.querySelectorAll('button,a')].filter(b=>b.textContent.trim()===txt&&vis(b)).length})('$1')"; }
# 白板页正向锚点：重放控件存在且已禁用（README §12.4：播到最新才禁用）；用它替掉「第 N / M 步」这类实现自造串
PB_PAUSE_TEXT="(()=>{const b=[...document.querySelectorAll('.playback button')].find(x=>['暂停','继续'].includes(x.textContent.trim()));return b?b.textContent.trim():''})()"
PB_PAUSEDONE="(()=>{const b=[...document.querySelectorAll('.playback button')].find(x=>['暂停','继续'].includes(x.textContent.trim()));return !!b&&b.disabled===true&&document.querySelectorAll('.gnode').length===4})()"
PAUSE_STATE="(()=>{const bs=[...document.querySelectorAll('.playback button')];const p=bs.find(b=>['暂停','继续'].includes(b.textContent.trim()));const g=bs.find(b=>b.textContent.trim()==='跳到最新');return JSON.stringify({t:p?p.textContent.trim():'',d:p?p.disabled:null,latest:g?g.disabled:null,nodes:document.querySelectorAll('.gnode').length})})()"
realclick(){ # $1 = 回 {x,y} 的 JS 表达式；用真鼠标坐标点（不走 el.click()，disabled/遮挡都骗不过去）
  local box x y
  box=$(ev "$1")
  x=$(printf '%s' "$box" | python3 -c 'import json,sys
s=sys.stdin.read().strip()
try:
    d=json.loads(s)
    print(d["x"] if isinstance(d,dict) and "x" in d else -1)
except Exception:
    print(-1)')
  y=$(printf '%s' "$box" | python3 -c 'import json,sys
s=sys.stdin.read().strip()
try:
    d=json.loads(s)
    print(d["y"] if isinstance(d,dict) and "y" in d else -1)
except Exception:
    print(-1)')
  if [ "$x" = "-1" ] || [ "$y" = "-1" ]; then printf 'NORECT %s\n' "$box"; return 1; fi
  timeout 30 agent-browser mouse move "$x" "$y" >/dev/null 2>&1
  timeout 30 agent-browser mouse down >/dev/null 2>&1
  timeout 30 agent-browser mouse up >/dev/null 2>&1
  return 0; }

# --- 进程：桩后端 + 前端 -------------------------------------------------
echo "== 起桩后端与前端 =="
# 上一轮残留会绑不上端口、curl 却仍然通（等于对旧进程跑），先查再起
if ss -ltn 2>/dev/null | grep -qE ':(18106|13016)[[:space:]]'; then echo "端口 18106/13016 已被占用，先清理再跑"; exit 1; fi
node evidence/test/P003-T016/stub-api.mjs 18106 > /tmp/t016-stub.log 2>&1 &
STUB=$!
HIDS_API_ORIGIN=$API HIDS_WEB_PORT=13016 node web/serve.js > /tmp/t016-web.log 2>&1 &
SRV=$!
trap 'kill $STUB $SRV 2>/dev/null; timeout 30 agent-browser close >/dev/null 2>&1' EXIT
for _ in $(seq 1 40); do curl -sf --max-time 1 "$WEB/" >/dev/null && break; sleep 0.2; done
curl -sf --max-time 2 "$WEB/" >/dev/null && echo "前端已起 $WEB" || { echo "前端起不来"; exit 1; }
curl -sf --max-time 2 "$API/api/trace/boards" >/dev/null && echo "桩后端已起 $API" || { echo "桩后端起不来"; exit 1; }

timeout 90 agent-browser open "$WEB/" --args "--no-sandbox" >/dev/null 2>&1
timeout 30 agent-browser set viewport 1440 900 >/dev/null 2>&1
login && ok "S0 登录（凭据进内存）" || no "S0 登录" "总览" "起不来"
timeout 60 agent-browser eval "localStorage.clear();'ok'" >/dev/null 2>&1
chk "S0 视口 1440×900" "$(ev "innerWidth+'x'+innerHeight")" "1440x900"

echo
echo "== A1 列表页：七列 / 无画布 / 行链接 / 键盘回车 =="
nav '#/alerts' '#/trace'
waitfor "document.querySelectorAll('table tbody tr').length" "8" 12000 || true
chk "A1 标题「深度溯源」" "$(ev "document.querySelector('h1')?.textContent")" "深度溯源"
chk "A1 七列表头" "$(ev "[...document.querySelectorAll('table thead th')].map(t=>t.textContent.trim()).join('|')")" "告警|主机|告警时间|状态|链长|断点|更新时间"
chk "A1 列表页没有画布（.canvas）" "$(ev "document.querySelector('.canvas')===null")" "true"
chk "A1 行数 = 桩的 8 条" "$(rows)" "8"
has "A1 第一行是「溯源」对白板的真链接" "#/trace-board/" "$(ev "document.querySelector('table tbody tr a')?.getAttribute('href')")"
has "A1 链接里告警 ID 已编码（冒号 %3A）" "%3A" "$(ev "document.querySelector('table tbody tr a')?.getAttribute('href')")"
has "A1 四值状态都在列表里（进行中/已完成/失败/中断）" "进行中" "$(ev "[...document.querySelectorAll('table tbody tr')].map(r=>r.cells[3].textContent).join(',')")"
has "A1 已完成" "已完成" "$(ev "[...document.querySelectorAll('table tbody tr')].map(r=>r.cells[3].textContent).join(',')")"
has "A1 失败" "失败" "$(ev "[...document.querySelectorAll('table tbody tr')].map(r=>r.cells[3].textContent).join(',')")"
has "A1 中断" "中断" "$(ev "[...document.querySelectorAll('table tbody tr')].map(r=>r.cells[3].textContent).join(',')")"
# 键盘路径：焦点进第一个行链接，回车进白板
timeout 60 agent-browser eval "(()=>{const a=document.querySelector('table tbody tr a');a.focus();return document.activeElement===a})()" >/dev/null 2>&1
timeout 30 agent-browser press Enter >/dev/null 2>&1
waitcl "location.hash" "#/trace-board/" 8000 && ok "A1 焦点在行链接上按回车能进白板（只验回车，没验 Tab 焦点顺序）" || no "A1 行链接回车" "#/trace-board/" "$(ev "location.hash")"
waitfor "document.querySelector('h1')?.textContent" "深度溯源" 8000 || true
chk "A1 白板页仍叫「深度溯源」（壳标题）" "$(ev "document.querySelector('h1')?.textContent")" "深度溯源"

echo
echo "== A2 入口：告警列表「溯源」/ 告警详情「深度溯源」/ 404 后自动创建 =="
nav '#/trace' '#/alerts'
waitfor "document.querySelectorAll('table tbody tr').length" "4" 12000 || true
LINKS=$(ev "JSON.stringify([...document.querySelectorAll('table tbody tr')].map(r=>{const a=[...r.querySelectorAll('a')].find(x=>x.textContent.trim()==='溯源');return a?a.getAttribute('href'):null}))")
has "A2 告警列表每一行都有「溯源」链接" "#/trace-board/" "$LINKS"
chk "A2 每行都有（4 行 4 个）" "$(echo "$LINKS" | python3 -c 'import json,sys;print(sum(1 for x in json.load(sys.stdin) if x and x.startswith("#/trace-board/")))')" "4"
# 点这一行的「溯源」：桩里 syslog:revshell 那条有白板 → GET 200 直接画
resetlog
timeout 60 agent-browser eval "(()=>{const r=[...document.querySelectorAll('table tbody tr')].find(r=>{const a=[...r.querySelectorAll('a')].find(x=>x.textContent.trim()==='溯源');return a&&a.getAttribute('href').includes('revshell')});const a=[...r.querySelectorAll('a')].find(x=>x.textContent.trim()==='溯源');a.click();return 'ok'})()" >/dev/null 2>&1
waitcl "decodeURIComponent(location.hash)" "syslog:revshell:" 8000 && ok "A2 点「溯源」带着这条的 ID 进白板（hash 已解码对得上）" || no "A2 点溯源" "hash 带 syslog:revshell:" "$(ev "decodeURIComponent(location.hash)")"
waitcl "document.querySelector('.stage-title')?.textContent" "反弹 shell 外联" 8000 && ok "A2 打开已有白板（GET 一次就画）" || no "A2 打开已有白板" "标题画出来" "$(ev "document.querySelector('.canvas')?.textContent")"
chk "A2 GET 一次（不是先 POST）" "$(hits '/api/trace/boards/' GET)" "1"
chk "A2 不该有 POST" "$(hits '/api/trace/boards' POST)" "0"
# 告警详情「深度溯源」
timeout 60 agent-browser eval "location.hash='#/alert-detail/'+encodeURIComponent('syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1');'ok'" >/dev/null 2>&1
waitfor "document.querySelector('h1')?.textContent" "告警详情" 10000 || true
DEEP=$(ev "JSON.stringify([...document.querySelectorAll('a')].filter(a=>a.textContent.includes('溯源')).map(a=>a.getAttribute('href')))")
has "A2 告警详情「深度溯源」链到白板" "#/trace-board/syslog%3Arevshell%3A" "$DEEP"
# 没有白板 → 404 后自动 POST 创建（202）
resetlog
nav '#/alerts' '#/trace-board/' 
sleep 0.2
timeout 60 agent-browser eval "location.hash='#/trace-board/'+encodeURIComponent('brand-new:7');'ok'" >/dev/null 2>&1
waitcl "document.querySelector('.canvas')?.textContent" "还没有跳" 8000 && ok "A2 没有白板：404 后自动 POST 创建并画（空链进行中）" || { no "A2 404 后创建" "还没有跳" "$(ev "document.querySelector('.canvas')?.textContent")"; echo "      [诊断] hash=$(ev "location.hash") 请求=$(curl -s "$API/__ctl/log" | python3 -c 'import json,sys;print([(r["method"],r["path"]) for r in json.load(sys.stdin)["requests"]][-5:])')"; }
for _ in $(seq 1 50); do [ "$(hits '/api/trace/boards' POST)" -ge 1 ] && break; sleep 0.1; done
chk "A2 POST 一次" "$(hits '/api/trace/boards' POST)" "1"
has "A2 POST 正文只有 target" '{"target":"brand-new:7"}' "$(lastbody '/api/trace/boards')"
# POST 失败：422 带服务端原话
ctl '{"traceBoard":"422"}'
nav '#/alerts' '#/trace-board/'
sleep 0.2
timeout 60 agent-browser eval "location.hash='#/trace-board/'+encodeURIComponent('no-asset:8');'ok'" >/dev/null 2>&1
waitcl "document.querySelector('.canvas')?.textContent" "这条告警没有可用资产" 10000 || true
has "A2 422：白板错误态带服务端原话（不假装有白板）" "这条告警没有可用资产" "$(ev "document.querySelector('.canvas')?.textContent.replace(/\s+/g,' ').trim()")"
ctl '{"traceBoard":"ok"}'

echo
echo "== A3 白板：告警在右 / 原因往左 / 可拖 / 位置记住 / 不能加点加线 =="
nav '#/alerts' '#/trace-board/revshell%3A1'
waitfor "$PB_PAUSEDONE" "true" 15000 || true
leftof(){ ev "(()=>{const ns=[...document.querySelectorAll('.gnode')];const pick=(i)=>{const n=ns[i];if(!n)return 'NONE';const m=/left:\s*(-?[\d.]+)px/.exec(n.getAttribute('style')||'');return m?m[1]:'NO-STYLE'};return JSON.stringify({alert:pick(0),h2:pick(1),h3:pick(2),h4:pick(3),n:ns.length})})()" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(",".join(str(d[k]) for k in ("alert","h2","h3","h4","n")))'; }
waitcl "document.querySelector('h1')?.textContent" "深度溯源" 8000 >/dev/null 2>&1
POS=$(leftof); echo "      位置：$POS"
A_LEFT=$(echo "$POS" | cut -d, -f1); H2=$(echo "$POS" | cut -d, -f2); H3=$(echo "$POS" | cut -d, -f3); H4=$(echo "$POS" | cut -d, -f4)
chk "A3 四个点都画出来（=hops 数）" "$(echo "$POS" | cut -d, -f5)" "4"
chk "A3 告警点钉在最右（x=0，点半径 4.5 的偏移）" "$A_LEFT" "-4.5"
d2=$(python3 -c "print(round(float('$A_LEFT')-float('$H2'),2))"); d3=$(python3 -c "print(round(float('$H2')-float('$H3'),2))"); d4=$(python3 -c "print(round(float('$H3')-float('$H4'),2))")
chk "A3 第 2 跳往左 190px" "$d2" "190.0"
chk "A3 第 3 跳再往左 190px" "$d3" "190.0"
chk "A3 第 4 跳再往左 190px" "$d4" "190.0"
# 拖第 2 跳（真鼠标：move/down/move/up）
BOX=$(ev "(()=>{const n=[...document.querySelectorAll('.gnode')][1];const r=n.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()")
BX=$(echo "$BOX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["x"])')
BY=$(echo "$BOX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["y"])')
timeout 30 agent-browser mouse move "$BX" "$BY" >/dev/null 2>&1
timeout 30 agent-browser mouse down >/dev/null 2>&1
timeout 30 agent-browser mouse move $((BX+60)) $((BY+30)) >/dev/null 2>&1
timeout 30 agent-browser mouse move $((BX+70)) $((BY+40)) >/dev/null 2>&1
timeout 30 agent-browser mouse up >/dev/null 2>&1
sleep 0.3
STORE=$(ev "localStorage['hids.trace.positions.revshell:1'] ?? 'NONE'")
has "A3 拖点后写进 localStorage（相对告警点）" '"h2"' "$STORE"
NEWLEFT=$(leftof | cut -d, -f2)
[ "$NEWLEFT" != "$H2" ] && ok "A3 拖点：点真的动了（$H2 → $NEWLEFT）" || no "A3 拖点" "left 变化" "$H2 没变"
# 告警点拖不动
ABOX=$(ev "(()=>{const n=document.querySelector('.gnode.is-alert');const r=n.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()")
AX=$(echo "$ABOX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["x"])')
AY=$(echo "$ABOX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["y"])')
ALEFT_BEFORE=$(leftof | cut -d, -f1)
timeout 30 agent-browser mouse move "$AX" "$AY" >/dev/null 2>&1
timeout 30 agent-browser mouse down >/dev/null 2>&1
timeout 30 agent-browser mouse move $((AX+70)) $((AY+50)) >/dev/null 2>&1
timeout 30 agent-browser mouse up >/dev/null 2>&1
sleep 0.25
chk "A3 告警点拖不动（钉死）" "$(leftof | cut -d, -f1)" "$ALEFT_BEFORE"
# 刷新后位置还在：整页 reload → 重新登录 → 回白板
STORED_LEFT="$NEWLEFT"
timeout 60 agent-browser reload >/dev/null 2>&1
sleep 1
if waitfor "document.querySelector('h1')?.textContent" "登录" 10000; then
  login >/dev/null 2>&1
fi
timeout 60 agent-browser eval "location.hash='#/trace-board/'+encodeURIComponent('revshell:1');'ok'" >/dev/null 2>&1
waitfor "$PB_PAUSEDONE" "true" 15000 || true
RELOADED_LEFT=$(leftof | cut -d, -f2)
KEPT=$(python3 -c "print('yes' if abs(float('$RELOADED_LEFT')-float('$STORED_LEFT'))<=1.5 else 'no:$RELOADED_LEFT vs $STORED_LEFT')")
chk "A3 刷新后拖过的位置不弹回（存 $STORED_LEFT，读到 $RELOADED_LEFT）" "$KEPT" "yes"
# 不能自己加点 / 加线
chk "A3 白板没有输入入口（input/textarea/select 0）" "$(ev "document.querySelectorAll('input,textarea,select').length")" "0"
chk "A3 没有「新建/添加/连一条」的按钮" "$(ev "[...document.querySelectorAll('button,a')].filter(x=>/新建|添加|连一条|加一跳/.test(x.textContent)).length")" "0"
# 双点画布：不加点
timeout 60 agent-browser eval "(()=>{const c=document.querySelector('.canvas');const r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:r.x+40,clientY:r.y+40}));return 'ok'})()" >/dev/null 2>&1
sleep 0.3
chk "A3 双击画布不凭空加点" "$(ev "document.querySelectorAll('.gnode').length")" "4"
chk "A3 线数 = links 数（3），没有多出来的线" "$(ev "document.querySelectorAll('svg [role=button]').length")" "3"

echo
echo "== A4 进行中往左长 / 重放·暂停·继续 / 断点常显 =="
# 进行中：轮询自己长
resetlog
nav '#/alerts' '#/trace-board/honeypot%3A2'
waitcl "document.querySelectorAll('.gnode').length" "2" 8000 && ok "A4 进行中先画已有的 2 跳" || no "A4 进行中首帧" "2 跳" "$(ev "document.querySelectorAll('.gnode').length")"
chk "A4 进行中：重放/暂停/跳到最新三键 hidden（D016）" "$(ev "[...document.querySelectorAll('.playback button')].filter(b=>['重放','暂停','继续','跳到最新'].includes(b.textContent.trim())).every(b=>b.hidden===true)")" "true"
chk "A4 进行中：跟随仍可用" "$(ev "[...document.querySelectorAll('.playback button')].find(b=>b.textContent.trim()==='跟随')?.hidden")" "false"
GAIN=$(waitcl "document.querySelectorAll('.gnode').length" "3" 9000 && echo yes || echo no)
chk "A4 进行中：5s 轮询后新的一跳自己长出来（2→3）" "$GAIN" "yes"
chk "A4 进行中：线也跟着长（1→2）" "$(ev "document.querySelectorAll('svg [role=button]').length")" "2"
# 完成态：先等自动播完（正向锚点）→ 点「重放」走到中途 → 暂停 → 「继续」可点 → 点它必须真的接着播 → 播完才禁
nav '#/alerts' '#/trace-board/revshell%3A1'
waitcl "document.querySelector('.stage-title')?.textContent" "已完成" 15000 && ok "A4 白板画出来（顶栏状态「已完成」= 正向锚点）" || no "A4 正向锚点" "顶栏写「已完成」" "$(ev "document.querySelector('.stage-title')?.textContent")"
waitfor "$PB_PAUSEDONE" "true" 15000 && ok "A4 打开已完成白板：自动按 discovery 播到最新（播完才禁用）" || no "A4 自动播完" "重放控件 disabled=true" "$(ev "$PAUSE_STATE")"
clicktext "重放" >/dev/null
waitfor "document.querySelectorAll('.gnode').length" "2" 8000 && ok "A4 点「重放」从头播（跳数又长到 2）" || no "A4 重放" "跳数回到 2" "$(ev "$PAUSE_STATE")"
clicktext "暂停" >/dev/null
sleep 0.3
S1=$(ev "$PAUSE_STATE"); echo "      暂停后：$S1"
has "A4 暂停后按钮文本变「继续」" '"t":"继续"' "$S1"
has "A4 暂停中「继续」可点（disabled=false，第一轮的死按钮）" '"d":false' "$S1"
sleep 2
S2=$(ev "$PAUSE_STATE")
chk "A4 暂停中真的停住（2s 后按钮与跳数都不动）" "$S2" "$S1"
PAUSED_NODES=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["nodes"])' "$S1")
# 审计点的关键：不许只比前后快照。点之前先钉住「可点」，再真点，再等按钮文本回「暂停」（README §12.4），最后等播完
chk "A4 点「继续」之前按钮确实可点（disabled=false）" "$(ev "(()=>{const b=[...document.querySelectorAll('.playback button')].find(x=>x.textContent.trim()==='继续');return b?b.disabled:'NO-BTN'})()")" "false"
clicktext "继续" >/dev/null
waitcl "$PB_PAUSE_TEXT" "暂停" 4000 && ok "A4 点「继续」后按钮文本回「暂停」（真的接上播，不是死按钮）" || no "A4 点「继续」接着播" "4s 内按钮文本回到「暂停」" "$(ev "$PAUSE_STATE")"
waitfor "$PB_PAUSEDONE" "true" 15000 && ok "A4 继续之后一路播到最新（4 跳），此时才禁用" || no "A4 继续后播完" "4 跳且「继续」disabled=true" "$(ev "$PAUSE_STATE")"
chk "A4 继续后跳数比暂停时多（$PAUSED_NODES → 4）" "$(ev "document.querySelectorAll('.gnode').length>$PAUSED_NODES")" "true"
S4=$(ev "$PAUSE_STATE"); echo "      播完：$S4"
has "A4 播完（count>=steps.length）「继续」才禁用" '"t":"继续","d":true' "$S4"
has "A4 播完「跳到最新」一起禁用" '"latest":true' "$S4"
chk "A4 播完 4 跳 3 线" "$(ev "document.querySelectorAll('.gnode').length")" "4"
# 再点重放：从头来，「暂停」可点
clicktext "重放" >/dev/null
waitcl "$PB_PAUSE_TEXT" "暂停" 4000 && ok "A4 再点「重放」又从头播（按钮回「暂停」且可点）" || no "A4 再点重放" "按钮文本回「暂停」" "$(ev "$PAUSE_STATE")"
has "A4 重放后按钮可点" '"d":false' "$(ev "$PAUSE_STATE")"
waitfor "$PB_PAUSEDONE" "true" 15000 || true
# 断点不点开也看得见（没有点任何节点）
GAP=$(ev "JSON.stringify([...document.querySelectorAll('.gap-note')].map(e=>({t:e.textContent.trim(),title:e.getAttribute('title'),pe:getComputedStyle(e).pointerEvents})))")
has "A4 断点写在图上（不点开也看得见）" "上一步没有了" "$GAP"
has "A4 断点原因全文在 title" "牧云也查不到更早的启动命令" "$GAP"
chk "A4 断点不可点（pointer-events:none，不挡拖拽）" "$(ev "getComputedStyle(document.querySelector('.gap-note')).pointerEvents")" "none"
chk "A4 断点 1 处写在状态栏" "1" "$(ev "(document.querySelector('.stage-title')?.textContent.match(/断点 (\d+) 处/)||[])[1]")"
# 检查器：点跳 / 键盘选线（交互路径）
timeout 60 agent-browser eval "(()=>{document.querySelector('.gnode.is-alert').click();return 'ok'})()" >/dev/null 2>&1
sleep 0.3
INS=$(ev "document.querySelector('[aria-label=检查器]')?.textContent.replace(/\s+/g,' ').trim()")
has "A4 点一跳：检查器展开（种类/机器/证据）" "种类告警" "$INS"
has "A4 点一跳：证据号带出来" "syslog:1" "$INS"
timeout 60 agent-browser eval "(()=>{const l=document.querySelector('svg [role=button]');l.focus();return document.activeElement===l})()" >/dev/null 2>&1
timeout 30 agent-browser press Enter >/dev/null 2>&1
sleep 0.3
INS2=$(ev "document.querySelector('[aria-label=检查器]')?.textContent.replace(/\s+/g,' ').trim()")
has "A4 键盘 Enter 选线：检查器显示关系" "同一主机" "$INS2"
has "A4 键盘 Enter 选线：从 h1 到 h2" "h1到h2" "$INS2"
# 跟随开关（默认开；点一下关、再点开）
chk "A4「跟随」默认 aria-pressed=true" "$(ev "[...document.querySelectorAll('.playback button')].find(x=>x.textContent.trim()==='跟随')?.getAttribute('aria-pressed')")" "true"
clicktext "跟随" >/dev/null 2>&1; sleep 0.2
chk "A4「跟随」点一下 aria-pressed=false" "$(ev "[...document.querySelectorAll('.playback button')].find(x=>x.textContent.trim()==='跟随')?.getAttribute('aria-pressed')")" "false"
clicktext "跟随" >/dev/null 2>&1; sleep 0.2
chk "A4「跟随」再点回 true" "$(ev "[...document.querySelectorAll('.playback button')].find(x=>x.textContent.trim()==='跟随')?.getAttribute('aria-pressed')")" "true"
# 失败 / 中断：停在原地并写原因
nav '#/alerts' '#/trace-board/failed%3A1'
waitcl "document.querySelector('.stage-title')?.textContent" "失败" 10000 || true
has "A4 失败：顶栏写失败与原因" "失败：牧云接口限流" "$(ev "document.querySelector('.stage-title')?.textContent.replace(/\s+/g,' ').trim()")"
chk "A4 失败：画出来的链不清掉（4 跳）" "$(ev "document.querySelectorAll('.gnode').length")" "4"
nav '#/trace-board/revshell%3A1' '#/trace-board/interrupted%3A1'
waitcl "document.querySelector('.stage-title')?.textContent" "中断" 10000 || true
has "A4 中断：顶栏写中断与原因" "中断：进程序号变了" "$(ev "document.querySelector('.stage-title')?.textContent.replace(/\s+/g,' ').trim()")"

echo
echo "== A5 没有对话输入框 =="
nav '#/alerts' '#/trace-board/revshell%3A1'
# 正向锚点：先把「白板页真的渲染出来了」钉住，再数输入框；否则路由坏了/停在别的页也会“没有输入框”
waitcl "document.querySelector('.stage-title')?.textContent" "已完成" 15000 && ok "A5 前置正向锚点：白板页已渲染（顶栏写状态「已完成」）" || no "A5 前置正向锚点" "顶栏写「已完成」" "$(ev "document.querySelector('.stage-title')?.textContent")"
waitcl "document.querySelector('.stage-title')?.textContent" "链长 4 跳" 15000 && ok "A5 前置：顶栏链长 = hops 个数（4 跳）" || no "A5 前置链长" "链长 4 跳" "$(ev "document.querySelector('.stage-title')?.textContent")"
waitfor "document.querySelectorAll('.gnode').length" "4" 15000 && ok "A5 前置：白板真的画出 4 个跳（点）" || no "A5 前置 4 个跳" "4 个点" "$(ev "document.querySelectorAll('.gnode').length")"
chk "A5 白板页 input/textarea 计数 0" "$(ev "document.querySelectorAll('input,textarea').length")" "0"
chk "A5 白板页 contenteditable 计数 0" "$(ev "document.querySelectorAll('[contenteditable=true]').length")" "0"
chk "A5 白板页没有「发送/提问」按钮" "$(ev "[...document.querySelectorAll('button')].filter(b=>/发送|提问|对话|问一句/.test(b.textContent)).length")" "0"
# 对照：同一个探针在列表页必须数得出筛选输入框，白板页的 0 才不是“探针不灵”
nav '#/alerts' '#/trace'
waitfor "document.querySelectorAll('table tbody tr').length" "8" 12000 || true
chk "A5 对照：列表页数得出筛选输入框（探针有牙齿）" "$(ev "document.querySelectorAll('input,textarea').length>=1")" "true"

echo
echo "== 六格 · 列表页 =="
# loading（这里的 0.3s 是故意停在瞬时态上取样，不是等异步结束）
ctl '{"delayMs":1500}'
nav '#/alerts' '#/trace'
sleep 0.3
chk "列表 loading：table-wrap aria-busy=true" "$(ev "document.querySelector('.table-wrap')?.getAttribute('aria-busy')")" "true"
has "列表 loading：骨架文案「正在读取溯源…」" "正在读取溯源" "$(ev "document.querySelector('table tbody')?.textContent")"
chk "列表 loading：刷新 + 四个筛选全禁用" "$(ev "[...document.querySelectorAll('.page-tools button, .filters select, .filters input')].every(e=>e.disabled)")" "true"
waitfor "document.querySelectorAll('table tbody tr').length" "8" 12000 >/dev/null 2>&1
ctl '{"delayMs":0}'
# empty
ctl '{"traceList":"empty"}'
nav '#/alerts' '#/trace'
waitcl "document.querySelector('table tbody')?.textContent" "暂无溯源" 10000 && ok "列表 empty：空态第一句「暂无溯源」" || no "列表 empty 第一句" "暂无溯源" "$(ev "document.querySelector('table tbody')?.textContent")"
has "列表 empty：第二句「从告警列表点某一行的『溯源』…」（README §12.3 要求两句都在）" "从告警列表点某一行的" "$(ev "document.querySelector('table tbody')?.textContent")"
chk "列表 empty：分页两键都禁用" "$(ev "[...document.querySelectorAll('button')].filter(b=>/上一页|下一页/.test(b.textContent)).every(b=>b.disabled)")" "true"
# empty + 有筛选
timeout 60 agent-browser eval "(()=>{const s=[...document.querySelectorAll('.filters select')][0];s.value='failed';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()" >/dev/null 2>&1
waitcl "document.querySelector('table tbody')?.textContent" "没有匹配的溯源" 10000 || true
has "列表 empty（有筛选）：改为「没有匹配」" "没有匹配的溯源" "$(ev "document.querySelector('table tbody')?.textContent")"
has "列表 empty（有筛选）：给「清除筛选」" "清除筛选" "$(ev "document.querySelector('table tbody')?.textContent")"
clicktext "清除筛选" >/dev/null
ctl '{"traceList":"ok"}'
nav '#/alerts' '#/trace'
waitfor "document.querySelectorAll('table tbody tr').length" "8" 12000 >/dev/null 2>&1
chk "列表 清除筛选后回到全部 8 条" "$(rows)" "8"
# error + 恢复
resetlog
ctl '{"traceList":"503"}'
nav '#/alerts' '#/trace'
waitcl "document.querySelector('.page-error')?.textContent" "溯源列表读取失败" 8000 && ok "列表 error：整块错误 + 服务端原话" || no "列表 error" "读取失败文案" "$(ev "document.querySelector('table tbody')?.textContent")"
chk "列表 error：role=alert" "$(ev "document.querySelector('.page-error')?.getAttribute('role')")" "alert"
# README §12.3 错误格：表格内 .page-error + 「重试」——这个「重试」必须是可见可点的，用可见性探针钉住
chk "列表 error：.page-error 里有 1 个可见「重试」" "$(ev "(()=>{const vis=e=>e.offsetParent!==null&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;return [...document.querySelectorAll('.page-error button,.page-error a')].filter(b=>b.textContent.trim()==='重试'&&vis(b)).length})()")" "1"
ctl '{"traceList":"ok"}'
realclick "(()=>{const vis=e=>e.offsetParent!==null&&e.getBoundingClientRect().width>0;const b=[...document.querySelectorAll('.page-error button,.page-error a')].find(x=>x.textContent.trim()==='重试'&&vis(x));if(!b)return 'NONE';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()" >/dev/null || echo "      [诊断] 列表 error 的「重试」拿不到坐标"
waitfor "document.querySelectorAll('table tbody tr').length" "8" 12000 >/dev/null 2>&1 && ok "列表 error：点「重试」再发一轮并渲染" || no "列表 重试" "8 行" "$(rows)"
# partial：已有数据刷新失败
ctl '{"traceList":"503"}'
clicktext "刷新" >/dev/null
waitcl "document.querySelector('.notice')?.textContent" "刷新失败" 10000 || true
chk "列表 partial：.notice role=alert" "$(ev "document.querySelector('.notice')?.getAttribute('role')")" "alert"
chk "列表 partial：notice 真的可见（hidden=false，README §12.3 断言要点）" "$(ev "document.querySelector('.notice')?.hidden")" "false"
has "列表 partial：写明是刷新失败下表示上一次结果" "刷新失败" "$(ev "document.querySelector('.notice')?.textContent")"
chk "列表 partial：行数保持 8 条" "$(rows)" "8"
ctl '{"traceList":"ok"}'
clicktext "刷新" >/dev/null
waitfor "document.querySelectorAll('table tbody tr').length" "8" 12000 >/dev/null 2>&1
# long-content
LONGROW="(()=>{const r=[...document.querySelectorAll('table tbody tr')].find(r=>{const a=r.querySelector('a');return a&&a.getAttribute('href').includes('long')});if(!r)return 'NOROW';const span=r.cells[1].querySelector('span')||r.cells[1];const idspan=r.cells[0].querySelector('.board-short');return JSON.stringify({host:span.textContent,hostTitle:span.getAttribute('title'),id:idspan?idspan.textContent:'',idTitle:idspan?idspan.getAttribute('title'):''})})()"
LR=$(ev "$LONGROW"); echo "      长内容行：$LR"
has "列表 long-content：长主机全文进 textContent" "10.0.0.5.node-with-a-very-long-hostname.intranet.example.corp.internal" "$LR"
has "列表 long-content：长主机 title 也是全文" '"hostTitle":"10.0.0.5.node-with-a-very-long-hostname.intranet.example.corp.internal"' "$LR"
SYSROW="(()=>{const r=[...document.querySelectorAll('table tbody tr')].find(r=>{const a=r.querySelector('a');return a&&a.getAttribute('href').includes('syslog')});const s=r.cells[0].querySelector('.board-short');return JSON.stringify({shown:s.textContent,title:s.getAttribute('title'),href:r.querySelector('a').getAttribute('href')})})()"
SR=$(ev "$SYSROW"); echo "      长 ID 行：$SR"
has "列表 long-content：长 ID 屏幕上缩成首尾" "…" "$SR"
has "列表 long-content：长 ID title 是全 ID" "syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1" "$SR"
has "列表 long-content：href 也是全 ID（编码后）" "syslog%3Arevshell%3Aa1b2c3d4e5f60718%3A1763373600%3Aaaa1" "$SR"
# disabled：单页时两个分页键都禁
chk "列表 disabled：单页时「上一页」「下一页」都禁用" "$(ev "[...document.querySelectorAll('button')].filter(b=>/上一页|下一页/.test(b.textContent)).map(b=>b.disabled).join(',')")" "true,true"
# 筛选下推
resetlog
timeout 60 agent-browser eval "(()=>{const s=[...document.querySelectorAll('.filters select')][0];s.value='failed';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()" >/dev/null 2>&1
waitfor "document.querySelectorAll('table tbody tr').length" "1" 10000 || true
chk "列表 筛选下推 status=failed（offset 回 0）" "$(hits 'status=failed' GET)" "1"
chk "列表 筛选后 1 行（失败那条）" "$(rows)" "1"
has "列表 筛选下推带 offset=0" "offset=0" "$(curl -s "$API/__ctl/log" | python3 -c 'import json,sys;print([r["path"] for r in json.load(sys.stdin)["requests"] if "status=" in r["path"]][-1])')"
timeout 60 agent-browser eval "(()=>{const s=[...document.querySelectorAll('.filters select')][0];s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()" >/dev/null 2>&1
sleep 1

echo
echo "== 六格 · 白板页 =="
# loading（同样：0.3s 是停在瞬时态上取样）
ctl '{"delayMs":1500}'
nav '#/alerts' '#/trace-board/revshell%3A1'
sleep 0.3
chk "白板 loading：.canvas aria-busy=true" "$(ev "document.querySelector('.canvas')?.getAttribute('aria-busy')")" "true"
has "白板 loading：「正在读取白板…」" "正在读取白板" "$(ev "document.querySelector('.canvas')?.textContent")"
chk "白板 loading：刷新禁用" "$(ev "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='刷新')?.disabled")" "true"
waitcl "document.querySelectorAll('.gnode').length" "1" 12000 || true
ctl '{"delayMs":0}'
# empty done / empty running
nav '#/alerts' '#/trace-board/empty%3A1'
waitcl "document.querySelector('.canvas')?.textContent" "这条链没有跳" 8000 && ok "白板 empty（已完成）：第一句「这条链没有跳」" || no "白板 empty 第一句" "这条链没有跳" "$(ev "document.querySelector('.canvas')?.textContent")"
has "白板 empty（已完成）：第二句「接口没有返回链上的跳。」（README §12.4 要求两句）" "接口没有返回链上的跳" "$(ev "document.querySelector('.canvas')?.textContent")"
chk "白板 empty：重放/跳到最新禁用（不启动）" "$(ev "[...document.querySelectorAll('.playback button')].filter(b=>['重放','跳到最新'].includes(b.textContent.trim())).every(b=>b.disabled)")" "true"
nav '#/alerts' '#/trace-board/empty-running%3A1'
waitcl "document.querySelector('.canvas')?.textContent" "还没有跳" 8000 && ok "白板 empty（进行中）：第一句「还没有跳」" || no "白板 empty 进行中第一句" "还没有跳" "$(ev "document.querySelector('.canvas')?.textContent")"
has "白板 empty（进行中）：第二句「任务在跑，新的一跳会自己从左边长出来。」" "任务在跑，新的一跳会自己从左边长出来" "$(ev "document.querySelector('.canvas')?.textContent")"
# partial：已有白板刷新失败，链保持
nav '#/alerts' '#/trace-board/revshell%3A1'
waitfor "$PB_PAUSEDONE" "true" 15000 || true
BEFORE_NODES=$(ev "document.querySelectorAll('.gnode').length")
ctl '{"traceBoard":"fail"}'
clicktext "刷新" >/dev/null
waitcl "document.querySelector('.notice')?.textContent" "白板读取失败" 10000 || true
chk "白板 partial：.notice role=alert（刷新失败）" "$(ev "document.querySelector('.notice')?.getAttribute('role')")" "alert"
chk "白板 partial：notice 真的可见（hidden=false）" "$(ev "document.querySelector('.notice')?.hidden")" "false"
chk "白板 partial：刷新失败时「重试」是可见的（同一探针的正向对照）" "$(visn 重试)" "1"
chk "白板 partial：链保持原样（节点数不变）" "$(ev "document.querySelectorAll('.gnode').length")" "$BEFORE_NODES"
# error：首屏失败（GET 直接失败这条路；404→POST 422 那条在 A2）
nav '#/alerts' '#/trace-board/revshell%3A1'
waitcl "document.querySelector('.canvas')?.textContent" "白板读取失败" 10000 || true
has "白板 error：画布「白板读取失败」" "白板读取失败" "$(ev "document.querySelector('.canvas')?.textContent.replace(/\s+/g,' ').trim()")"
has "白板 error：服务端原话带出来（画布里可见）" "模型没配置" "$(ev "document.querySelector('.canvas')?.textContent.replace(/\s+/g,' ').trim()")"
# README §12.4 错误格写「画布…+『重试』」。实测：DOM 里有一个「重试」，但它是 hidden 的（rect 0×0、offsetParent null），
# 页面上没有任何可见「重试」。这里只断言可见性，不替文档圆场（见报告 finding）
chk "白板 error：DOM 里的「重试」不可见（rect 0×0 / offsetParent null）" "$(ev "(()=>{const bs=[...document.querySelectorAll('button,a')].filter(b=>b.textContent.trim()==='重试');return JSON.stringify(bs.map(b=>{const r=b.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),op:b.offsetParent!==null}}))})()")" '[{"w":0,"h":0,"op":false}]'
chk "白板 error：可见「重试」数量 = 0" "$(visn 重试)" "0"
chk "白板 error：可见恢复入口是顶栏「刷新」= 1（README:641 承诺的画布内重试没有兑现）" "$(visn 刷新)" "1"
chk "白板 error：顶栏「刷新」可点（disabled=false）" "$(ev "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='刷新'&&x.offsetParent!==null);return b?b.disabled:'NO-BTN'})()")" "false"
# 恢复路径走真鼠标坐标（el.click() 点 hidden 按钮也能“恢复”，那不算用户能点）
ctl '{"traceBoard":"ok"}'
realclick "(()=>{const vis=e=>e.offsetParent!==null&&e.getBoundingClientRect().width>0;const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='刷新'&&vis(x));if(!b)return 'NONE';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()" >/dev/null || echo "      [诊断] 顶栏「刷新」拿不到坐标"
waitfor "document.querySelectorAll('.gnode').length>0" "true" 12000 && ok "白板 error：真鼠标点可见的「刷新」能恢复画板" || no "白板 error 恢复" "真鼠标点「刷新」后节点出现" "$(ev "document.querySelector('.canvas')?.textContent.replace(/\s+/g,' ').trim().slice(0,80)")"
# 没带目标：不发请求
resetlog
nav '#/alerts' '#/trace-board/'
waitcl "document.querySelector('.canvas')?.textContent" "没有指定这一条" 10000 || true
has "白板 error：没带目标写「没有指定这一条」" "没有指定这一条" "$(ev "document.querySelector('.canvas')?.textContent")"
chk "白板 error：没带目标不发请求" "$(hits '/api/trace/' '*')" "0"
# long-content
nav '#/alerts' '#/trace-board/long%3A1'
waitfor "$PB_PAUSEDONE" "true" 15000 || true
LONGOK=$(ev "(()=>{const l=[...document.querySelectorAll('.gnode-label')];const want='反弹 shell 外联 192.0.2.2:4444，父进程是 /usr/sbin/sshd -D，祖父进程是 systemd，再往上就查不到启动命令了';return JSON.stringify({n:l.length,allFull:l.every(x=>x.textContent.includes(want)),gapTitle:(document.querySelector('.gap-note')?.getAttribute('title')||'').includes('再往回只能靠人工问运维'),gapText:(document.querySelector('.gap-note')?.textContent||'').includes('再往回只能靠人工问运维')})})()")
has "白板 long-content：超长标签全文进 .gnode-label（4 跳全中）" '"allFull":true' "$LONGOK"
has "白板 long-content：断点原因全文在 title" '"gapTitle":true' "$LONGOK"
has "白板 long-content：断点原因全文在图上文本" '"gapText":true' "$LONGOK"
chk "白板 long-content：页面不横向溢出" "$(ev "document.documentElement.scrollWidth<=document.documentElement.clientWidth")" "true"

echo
echo "== 控制台 =="
ERRS=$(timeout 30 agent-browser errors 2>&1 | tail -5)
if [ -z "$ERRS" ] || [ "$ERRS" = "No errors" ]; then ok "浏览器控制台无 page error"; else no "浏览器控制台" "无 error" "$ERRS"; fi

echo
echo "== 视觉作证：1440×900 与 390×844 =="
timeout 30 agent-browser set viewport 1440 900 >/dev/null 2>&1
nav '#/alerts' '#/trace'
waitfor "document.querySelectorAll('table tbody tr').length" "8" 10000 >/dev/null 2>&1
shot "$SHOTS/1440-trace-list.png"
nav '#/trace' '#/trace-board/revshell%3A1'
waitfor "$PB_PAUSEDONE" "true" 15000 || true
clicktext "重放" >/dev/null
waitfor "document.querySelectorAll('.gnode').length" "2" 8000 || true
clicktext "暂停" >/dev/null
waitcl "$PB_PAUSE_TEXT" "继续" 4000 || true
shot "$SHOTS/1440-trace-board-paused.png"
clicktext "继续" >/dev/null
waitfor "$PB_PAUSEDONE" "true" 15000 || true
shot "$SHOTS/1440-trace-board-done.png"
nav '#/alerts' '#/trace-board/honeypot%3A2'
waitfor "document.querySelectorAll('.gnode').length>0" "true" 8000 || true
shot "$SHOTS/1440-trace-board-running.png"
ctl '{"traceBoard":"fail"}'
nav '#/alerts' '#/trace-board/revshell%3A1'
waitcl "document.querySelector('.canvas')?.textContent" "白板读取失败" 10000 || true
shot "$SHOTS/1440-trace-board-error.png"
ctl '{"traceBoard":"ok"}'
nav '#/alerts' '#/trace-board/long%3A1'
waitfor "$PB_PAUSEDONE" "true" 15000 || true
shot "$SHOTS/1440-trace-board-long.png"
# 390 视口
timeout 30 agent-browser set viewport 390 844 >/dev/null 2>&1
chk "视口切到 390×844" "$(ev "innerWidth+'x'+innerHeight")" "390x844"
nav '#/alerts' '#/trace'
waitfor "document.querySelectorAll('table tbody tr').length" "8" 10000 >/dev/null 2>&1
chk "390 列表：页面无整页横向溢出" "$(ev "document.documentElement.scrollWidth<=document.documentElement.clientWidth")" "true"
chk "390 列表：表格在包裹层里横滚（overflow-x auto）" "$(ev "getComputedStyle(document.querySelector('.table-wrap')).overflowX")" "auto"
chk "390 列表：包裹层可滚（scrollWidth > clientWidth）" "$(ev "document.querySelector('.table-wrap').scrollWidth>document.querySelector('.table-wrap').clientWidth")" "true"
shot "$SHOTS/390-trace-list.png"
nav '#/trace' '#/trace-board/revshell%3A1'
waitfor "$PB_PAUSEDONE" "true" 15000 || true
chk "390 白板：页面无整页横向溢出" "$(ev "document.documentElement.scrollWidth<=document.documentElement.clientWidth")" "true"
chk "390 白板：四个点都在（没被挤没）" "$(ev "document.querySelectorAll('.gnode').length")" "4"
shot "$SHOTS/390-trace-board.png"

echo
echo "== 汇总 =="
PASS=$(grep -c '^p' "$CNT"); FAIL=$(grep -c '^f' "$CNT")
printf 'PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
rm -f "$CNT"
if [ "$FAIL" -gt 0 ]; then printf '失败项：\n'; for f in "${FAILED[@]}"; do printf ' - %s\n' "$f"; done; exit 1; fi
exit 0
