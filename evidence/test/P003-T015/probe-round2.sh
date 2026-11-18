#!/usr/bin/env bash
# P003-T015 复审轮探针（江屿）：本轮改动新引入的边角，只记录现象，不判本卡对错。
# ① 表头吸顶代价（写者未决 8 的实测数）② 逐键取数是否顺手关掉展开中的误报表单（审查 nit ①）
# ③ 整页刷新在途时打字（审查 nit ②）④ 慢的旧查询在页面跳转后能不能画到别的页上
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
API=http://127.0.0.1:18101
WEB=http://127.0.0.1:13017
SEL=input[type=search]
ev(){ timeout 60 agent-browser eval "$1" 2>&1 | tail -1 | python3 -c 'import sys,json
s=sys.stdin.read().strip()
try:
    v=json.loads(s); print(str(v).lower() if isinstance(v,bool) else v)
except Exception: print(s)'; }
fill(){ timeout 60 agent-browser fill "$1" "$2" >/dev/null 2>&1; }
press(){ timeout 60 agent-browser press "$1" >/dev/null 2>&1; }
typename(){ timeout 60 agent-browser click "$1" >/dev/null 2>&1; timeout 60 agent-browser keyboard type "$2" >/dev/null 2>&1; }
clickbtn(){ timeout 60 agent-browser eval "(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>x.textContent.trim()==='$1');if(!b)return 'NO-BTN';b.scrollIntoView({block:'center'});b.click();return 'ok'})()" >/dev/null 2>&1; }
gopage(){ timeout 60 agent-browser click "a[href='$1']" >/dev/null 2>&1; }
mode(){ curl -s -X POST -d "$1" -H 'content-type: application/json' "$API/__ctl/mode" >/dev/null; }
waitfor(){ local expr="$1" want="$2" tmo="${3:-15000}" t0; t0=$(date +%s%3N)
  while :; do local v; v=$(ev "$expr"); [ "$v" = "$want" ] && return 0
    [ $(( $(date +%s%3N) - t0 )) -gt "$tmo" ] && return 1; sleep 0.15; done; }

node evidence/test/P003-T015/stub-api.mjs 18101 > /tmp/t015-probe-stub.log 2>&1 & STUB=$!
HIDS_API_ORIGIN=$API HIDS_WEB_PORT=13017 node web/serve.js > /tmp/t015-probe-web.log 2>&1 & SRV=$!
trap 'kill $STUB $SRV 2>/dev/null; timeout 30 agent-browser close >/dev/null 2>&1' EXIT
for _ in $(seq 1 40); do curl -sf --max-time 1 "$WEB/" >/dev/null && break; sleep 0.2; done
timeout 30 agent-browser close >/dev/null 2>&1
timeout 90 agent-browser open "$WEB/" --args "--no-sandbox" >/dev/null 2>&1
timeout 60 agent-browser set viewport 1440 900 >/dev/null 2>&1
fill "input[type=text]" hids; fill "input[type=password]" hids-2026; press Enter
waitfor "document.querySelector('h1')?.textContent" "总览" 15000 >/dev/null
gopage '#/alerts'; waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null

echo "== ① 表头吸顶代价（未决 8 的实测数） =="
timeout 60 agent-browser set viewport 1440 420 >/dev/null 2>&1
sleep 0.4
echo "   视口 1440x420，滚到页面底部前：$(ev "(()=>{const th=document.querySelector('table thead th');const w=document.querySelector('table').parentElement;const sc=document.scrollingElement;return JSON.stringify({thTop:Math.round(th.getBoundingClientRect().top),wrapTop:Math.round(w.getBoundingClientRect().top),pos:getComputedStyle(th).position,scrollH:sc.scrollHeight,clientH:sc.clientHeight,canScroll:sc.scrollHeight>sc.clientHeight+4})})()")"
ev "(()=>{const sc=document.scrollingElement;sc.scrollTop=sc.scrollHeight;return String(sc.scrollTop)})()" >/dev/null
sleep 0.4
echo "   滚到底之后（thTop 为负 = 表头跟着滚走了、没吸顶）：$(ev "(()=>{const th=document.querySelector('table thead th');const w=document.querySelector('table').parentElement;const sc=document.scrollingElement;return JSON.stringify({scrollTop:Math.round(sc.scrollTop),thTop:Math.round(th.getBoundingClientRect().top),wrapTop:Math.round(w.getBoundingClientRect().top)})})()")"
timeout 60 agent-browser set viewport 1440 900 >/dev/null 2>&1; sleep 0.3

echo
echo "== ② 逐键取数会不会顺手关掉展开中的误报表单（审查 nit ①） =="
timeout 60 agent-browser click "button[aria-label^='把 syslog:revshell']" >/dev/null 2>&1
waitfor "!!document.querySelector('form[aria-label=登记误报]')" "true" 8000 >/dev/null \
  || echo "     （表单没展开，探针 ② 无效）"
echo "   展开后表单在：$(ev "!!document.querySelector('form[aria-label=登记误报]')")"
typename "$SEL" "1"
waitfor "document.querySelector('input[type=search]').value" "1" 5000 >/dev/null
sleep 0.6
echo "   打了 1 个字符之后表单还在：$(ev "!!document.querySelector('form[aria-label=登记误报]')")（false = 被逐键取数关掉）"
fill "$SEL" ""; clickbtn "清除筛选"; sleep 0.6

echo
echo "== ③ 整页刷新在途时打字（审查 nit ②） =="
mode '{"delayMs":1500}'
clickbtn "刷新"
typename "$SEL" "1.2.3"
echo "   刷新在途 + 刚打的字：$(ev "(()=>{const i=document.querySelector('input[type=search]');return JSON.stringify({val:i.value,disabled:i.disabled,focus:document.activeElement===i,rows:document.querySelectorAll('table tbody tr').length,busy:document.querySelector('[aria-busy]')?.getAttribute('aria-busy')})})()")"
mode '{"delayMs":0}'
waitfor "document.querySelectorAll('table tbody tr').length>=0" "true" 4000 >/dev/null
sleep 1.5
echo "   稳定之后：$(ev "(()=>{const i=document.querySelector('input[type=search]');return JSON.stringify({val:i.value,rows:document.querySelectorAll('table tbody tr').length})})()")"
fill "$SEL" ""; clickbtn "清除筛选"; sleep 0.8

echo
echo "== ④ 慢的旧查询跨页跳转后会不会画到别的页上 =="
mode '{"delayByHost":{"10.0.0.5":1800}}'
typename "$SEL" "10.0.0.5"
sleep 0.2
gopage '#/overview'
sleep 2.5
echo "   跳到总览后（慢响应已到达）：$(ev "(()=>{const n=[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',');return JSON.stringify({nums:n,alerts:document.querySelectorAll('[role=alert]').length,h1:document.querySelector('h1')?.textContent})})()")"
gopage '#/alerts'
waitfor "document.querySelectorAll('table tbody tr').length>=1" "true" 15000 >/dev/null
echo "   回到告警页：$(ev "(()=>JSON.stringify({rows:document.querySelectorAll('table tbody tr').length,val:document.querySelector('input[type=search]').value,hosts:[...document.querySelectorAll('table tbody tr')].filter(r=>r.cells.length>8).map(r=>r.cells[2].textContent.trim()).join(',')}))()")"
mode '{"delayByHost":{}}'
echo
echo "== ⑤ 总览上的 role=alert 基线 vs 慢请求在途时 =="
mode '{"delayByHost":{}}'
gopage '#/overview'; sleep 1
echo "   无慢请求（基线）：$(ev "(()=>{const a=[...document.querySelectorAll('[role=alert]')];return JSON.stringify({n:a.length,text:a.map(x=>x.textContent.replace(/\\s+/g,' ').trim().slice(0,40)).join(' / ')})})()")"
mode '{"delayByHost":{"10.0.0.5":1800}}'
gopage '#/alerts'; waitfor "document.querySelectorAll('table tbody tr').length>=1" "true" 15000 >/dev/null
typename "$SEL" "10.0.0.5"; sleep 0.2; gopage '#/overview'; sleep 2.5
echo "   慢请求在途时跳总览：$(ev "(()=>{const a=[...document.querySelectorAll('[role=alert]')];return JSON.stringify({n:a.length,text:a.map(x=>x.textContent.replace(/\\s+/g,' ').trim().slice(0,60)).join(' / '),nums:[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')})})()")"
mode '{"delayByHost":{}}'
echo
echo "探针跑完"
