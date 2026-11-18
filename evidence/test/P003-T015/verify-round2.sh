#!/usr/bin/env bash
# P003-T015 复审轮独立复验（江屿 / gc-frontend-tester）。
# 只验本卡复审轮两条 finding 的判据（F1 横滚 / F2 主机筛选），外加回归兜底靠 e2e-behavior.sh。
# 判据出处：web/README.md §10.5（「值一变就 offset=0 重取」）、§10.7（窄屏只让表格区横滚）
#            + 任务卡 A1–A4（本轮不动）。
# 用法：
#   bash evidence/test/P003-T015/verify-round2.sh                 # 全跑（本树 web/）
#   SEC=F1 bash …/verify-round2.sh                                # 只跑横滚
#   SEC=F2 WEBROOT=/tmp/t015-mut/web bash …/verify-round2.sh      # 只跑筛选（给变异副本用）
# 自起桩后端 + 前端，跑完收进程。不改产品代码。
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
SEC=${SEC:-all}
WEBROOT=${WEBROOT:-$ROOT/web}
API=http://127.0.0.1:18100
WEB=http://127.0.0.1:13016
PASS=0; FAIL=0; FAILED=()
HOSTSEL=${HOSTSEL:-input[type=search]}

ok(){ PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); FAILED+=("$1"); printf 'FAIL  %s\n        期望: %s\n        实测: %s\n' "$1" "${2:-}" "${3:-}"; }
chk(){ if [ "${2:-}" = "${3:-}" ]; then ok "$1"; else no "$1" "${2:-}" "${3:-}"; fi; }
has(){ case "$3" in *"$2"*) ok "$1";; *) no "$1" "包含「$2」" "$3";; esac; }

ev(){ timeout 60 agent-browser eval "$1" 2>&1 | tail -1 | python3 -c 'import sys,json
s=sys.stdin.read().strip()
try:
    v=json.loads(s)
    print(str(v).lower() if isinstance(v,bool) else v)
except Exception:
    print(s)'; }
fill(){ timeout 60 agent-browser fill "$1" "$2" >/dev/null 2>&1; }
press(){ timeout 60 agent-browser press "$1" >/dev/null 2>&1; }
clickbtn(){ timeout 60 agent-browser eval "(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>x.textContent.trim()==='$1');if(!b)return 'NO-BTN';b.scrollIntoView({block:'center'});b.click();return 'ok'})()" >/dev/null 2>&1; }
# 真实键入：一次调用打完整串（逐键事件照发，但整体够快，好造并发轮次）
typename(){ timeout 60 agent-browser click "$1" >/dev/null 2>&1; timeout 60 agent-browser keyboard type "$2" >/dev/null 2>&1; }
gopage(){ timeout 60 agent-browser click "a[href='$1']" >/dev/null 2>&1; }
mode(){ curl -s -X POST -d "$1" -H 'content-type: application/json' "$API/__ctl/mode" >/dev/null; }
resetlog(){ curl -s -X POST "$API/__ctl/reset-log" >/dev/null; }
hits(){ curl -s --max-time 5 "$API/__ctl/log" | python3 -c "import json,sys;p=sys.argv[1];print(sum(1 for r in json.load(sys.stdin)['requests'] if p in r['path']))" "$1"; }
# 等请求条数不再变（不当 sleep 用：见到「稳定」才走）
settle(){ local pat="$1" tmo="${2:-8000}" last=-1 cur t0; t0=$(date +%s%3N)
  while :; do cur=$(hits "$pat")
    if [ "$cur" = "$last" ]; then return 0; fi; last=$cur
    [ $(( $(date +%s%3N) - t0 )) -gt "$tmo" ] && return 0; sleep 0.2; done; }
waitfor(){ local expr="$1" want="$2" tmo="${3:-15000}" t0; t0=$(date +%s%3N)
  while :; do local v; v=$(ev "$expr"); [ "$v" = "$want" ] && return 0
    [ $(( $(date +%s%3N) - t0 )) -gt "$tmo" ] && { echo "TIMEOUT(${tmo}ms) $expr → $v"; return 1; }; sleep 0.15; done; }
rows(){ ev "document.querySelectorAll('table tbody tr').length"; }
tdtext(){ ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')].filter(x=>x.cells.length>8)[$1];return r?[...r.cells].map(c=>c.textContent.replace(/\s+/g,' ').trim()).slice(0,3).join('|'):'NO-ROW'})()"; }

echo "== 起桩后端（$API）+ 前端（$WEB，web 根 = $WEBROOT） =="
node evidence/test/P003-T015/stub-api.mjs 18100 > /tmp/t015-r2-stub.log 2>&1 &
STUB=$!
HIDS_API_ORIGIN=$API HIDS_WEB_PORT=13016 node "$WEBROOT/serve.js" > /tmp/t015-r2-web.log 2>&1 &
SRV=$!
trap 'kill $STUB $SRV 2>/dev/null; timeout 30 agent-browser close >/dev/null 2>&1' EXIT
for _ in $(seq 1 40); do curl -sf --max-time 1 "$WEB/" >/dev/null && break; sleep 0.2; done
curl -sf --max-time 2 "$WEB/" >/dev/null || { echo "前端起不来（$WEBROOT/serve.js）"; exit 1; }

timeout 30 agent-browser close >/dev/null 2>&1
timeout 90 agent-browser open "$WEB/" --args "--no-sandbox" >/dev/null 2>&1
timeout 60 agent-browser set viewport 1440 900 >/dev/null 2>&1
fill "input[type=text]" hids; fill "input[type=password]" hids-2026; press Enter
waitfor "document.querySelector('h1')?.textContent" "总览" 15000 >/dev/null || { echo "登录失败"; exit 1; }

# ---------------------------------------------------------------- F1 横滚
if [ "$SEC" = "all" ] || [ "$SEC" = "F1" ]; then
echo
echo "== F1 表格横滚收在包裹层：页面不横滚 / 包裹层可横滚（六档视口） =="
for W in 1440 1280 1180 900 620 390; do
  timeout 60 agent-browser set viewport "$W" 900 >/dev/null 2>&1
  timeout 60 agent-browser open "$WEB/#/alerts" >/dev/null 2>&1
  waitfor "document.querySelectorAll('table tbody tr').length>=4" "true" 15000 >/dev/null || echo "     （$W：4 行没等到）"
  # 断言 ③ 要真证明「能滚」：scrollWidth>=clientWidth 按规范恒真（scrollWidth 至少等于 clientWidth），
  # 拔掉 overflow-x 也照样绿。改成把包裹层 scrollLeft 写 1 再读回（滚动容器才会挪），外带读计算样式 overflow-x。
  G=$(ev "(()=>{const w=document.querySelector('table')?.parentElement;const t=document.querySelector('table');
    let sl=-1;if(w){const prev=w.scrollLeft;w.scrollLeft=1;sl=Math.round(w.scrollLeft);w.scrollLeft=prev;}
    return JSON.stringify({vp:window.innerWidth,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,
      wsw:w?w.scrollWidth:-1,wcw:w?w.clientWidth:-1,ox:w?getComputedStyle(w).overflowX:'NO-WRAP',tw:t?t.offsetWidth:-1,sl:sl})})()")
  V=$(python3 - "$G" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
print("|".join(str(d[k]) for k in ("vp","sw","cw","wsw","wcw","ox","tw","sl")))
PY
)
  IFS='|' read -r VP SW CW WSW WCW OX TW SL <<<"$V"
  # ① 页面本身不横滚（doc.scrollWidth == clientWidth，且等于视口宽）
  if [ "$SW" = "$CW" ]; then ok "F1 @${VP} 页面无整页横滚（doc ${SW}/${CW}）"; else no "F1 @${VP} 页面被撑出横滚" "doc ${SW}/${CW}（+$((SW-CW))）"; fi
  # ② 包裹层是 overflow-x:auto 的滚动容器
  chk "F1 @${VP} 表格包裹层 overflow-x = auto" "auto" "$OX"
  # ③ 装不下时由包裹层吸收：overflow-x 是滚动容器 + scrollLeft 写 1 真能读回 >0（表宽>包裹层宽只是前提）
  case "$OX" in auto|scroll) OXOK=ok;; *) OXOK=no;; esac
  if [ "$TW" -gt "$WCW" ]; then
    if [ "$SL" -gt 0 ] && [ "$OXOK" = ok ]; then
      ok "F1 @${VP} 表(${TW})比包裹层视口(${WCW})宽 → 包裹层真可横滚（scrollLeft 1→${SL}，overflow-x=${OX}，scrollW=${WSW}）"
    else
      no "F1 @${VP} 表(${TW})超包裹层视口(${WCW})但包裹层滚不动" \
         "scrollLeft 写 1 应读回 >0 且 overflow-x ∈ {auto,scroll}" \
         "scrollLeft 1→${SL}，overflow-x=${OX}，scrollW=${WSW}/${WCW}"
    fi
  else
    ok "F1 @${VP} 表(${TW})装得下包裹层(${WCW})，不需要横滚"
  fi
done
# 390 下真能滚到最后一列
timeout 60 agent-browser set viewport 390 844 >/dev/null 2>&1
timeout 60 agent-browser open "$WEB/#/alerts" >/dev/null 2>&1
waitfor "document.querySelectorAll('table tbody tr').length>=4" "true" 15000 >/dev/null
LAST=$(ev "(()=>{const w=document.querySelector('table').parentElement;const th=[...document.querySelectorAll('table thead th')].at(-1);
  w.scrollLeft=w.scrollWidth;const wr=w.getBoundingClientRect(),tr=th.getBoundingClientRect();
  return JSON.stringify({sl:Math.round(w.scrollLeft),max:Math.round(w.scrollWidth-w.clientWidth),thRight:Math.round(tr.right),wrapRight:Math.round(wr.right),label:th.textContent.trim()})})()")
chk "F1 @390 包裹层可滚到最后一列表头（操作列）可见" "true" \
  "$(python3 - "$LAST" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
print(str(d["sl"]>=d["max"]-1 and d["thRight"]<=d["wrapRight"]+1 and d["label"]=="操作").lower(), end="")
PY
)"
echo "     390 实测：$(printf '%s' "$LAST" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("scrollLeft=%d/%d，末列表头「%s」右边界 %d ≤ 包裹层右边界 %d" % (d["sl"],d["max"],d["label"],d["thRight"],d["wrapRight"]))')"
timeout 60 agent-browser screenshot evidence/test/P003-T015/shots/r2-390-alerts-scrolled.png >/dev/null 2>&1
timeout 60 agent-browser set viewport 1440 900 >/dev/null 2>&1
fi

# ---------------------------------------------------------------- F2 主机筛选
if [ "$SEC" = "all" ] || [ "$SEC" = "F2" ]; then
echo
echo "== F2 主机筛选：逐键一轮 / 回车零轮 / quiet 不清表不禁用 / 旧响应丢弃 =="
timeout 60 agent-browser set viewport 1440 900 >/dev/null 2>&1
timeout 60 agent-browser open "$WEB/#/alerts" >/dev/null 2>&1
waitfor "document.querySelectorAll('table tbody tr').length>=4" "true" 15000 >/dev/null
settle triage/cases 2>/dev/null
resetlog

# ① 逐键一轮：7 个字符 = 7 轮 cases
typename "$HOSTSEL" "1.2.3.4"
settle triage/cases
chk "F2 逐键取数：键入 1.2.3.4（7 键）→ cases 请求 7 轮" "7" "$(hits triage/cases)"
chk "F2 逐键取数：筛到的值也进了请求（最后一次带 host=1.2.3.4）" "true" \
  "$(curl -s "$API/__ctl/log" | python3 -c 'import json,sys
rs=[r for r in json.load(sys.stdin)["requests"] if "triage/cases" in r["path"]]
print(str(bool(rs) and "host=1.2.3.4" in rs[-1]["path"]).lower())')"
has "F2 逐键取数：无匹配时表体写「没有匹配的研判记录」" "没有匹配的研判记录" "$(ev "document.querySelector('table tbody')?.innerText.replace(/\s+/g,' ').trim()")"
chk "F2 逐键取数：筛选控件没被禁用" "false" "$(ev "document.querySelector('$HOSTSEL')?.disabled")"

# ② 回车零轮：回车不再补一轮
B=$(hits triage/cases)
press Enter
settle triage/cases 3000
chk "F2 回车：按 Enter 后 cases 请求轮数不变（零轮新增）" "$B" "$(hits triage/cases)"

# ③ quiet：取数在途时不清表、不禁用输入框、焦点不丢
clickbtn "清除筛选"; settle triage/cases
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
mode '{"delayMs":1200}'
resetlog
typename "$HOSTSEL" "1"
for _ in $(seq 1 40); do [ "$(hits triage/cases)" -ge 1 ] && break; sleep 0.05; done
BODY=$(ev "(()=>{const tb=document.querySelector('table tbody');const i=document.querySelector('$HOSTSEL');
  return JSON.stringify({rows:tb.querySelectorAll('tr').length,text:tb.innerText.replace(/\s+/g,' ').trim().slice(0,24),
    busy:document.querySelector('[aria-busy]')?.getAttribute('aria-busy'),
    disabled:i.disabled,focus:document.activeElement===i,val:i.value})})()")
chk "F2 quiet：取数在途时表体保留上一份结果（4 行，不切「正在读取」）" "4" \
  "$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["rows"])' "$BODY")"
chk "F2 quiet：在途时输入框可用（disabled=false）且焦点仍在输入框" "false|true" \
  "$(python3 -c 'import json,sys;d=json.loads(sys.argv[1]);print(str(d["disabled"]).lower()+"|"+str(d["focus"]).lower())' "$BODY")"
echo "     在途实测：$BODY"
waitfor "document.querySelectorAll('table tbody tr').length>=0" "true" 100 >/dev/null
mode '{"delayMs":0}'
settle triage/cases
clickbtn "清除筛选"; settle triage/cases
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null

# ④ 旧响应丢弃：慢的旧查询（host=10.0.0.5，1.8s）不能盖掉快的新查询（host=10.0.0.6）
mode '{"delayByHost":{"10.0.0.5":1800}}'
resetlog
typename "$HOSTSEL" "10.0.0.5"                                  # 最后一轮慢
for _ in $(seq 1 60); do [ "$(hits 'host=10.0.0.5')" -ge 1 ] && break; sleep 0.05; done
fill "$HOSTSEL" ""; typename "$HOSTSEL" "10.0.0.6"              # 新一轮快，先落地
settle triage/cases 4000
# 慢响应到达前后持续采样 3s：不许出现 .5 那行
SAMPLES=$(for _ in $(seq 1 20); do
  ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')].filter(x=>x.cells.length>8)[0];
    return (r?r.cells[2].textContent.trim():'NO-ROW')+'|'+String(document.querySelector('$HOSTSEL').value)})()"
  sleep 0.15; done | sort | uniq -c | tr '\n' ';')
chk "F2 loadSeq：输入 10.0.0.6 后，慢的 10.0.0.5 旧响应到达也不覆盖（采样 20 次全是 10.0.0.6）" "20 10.0.0.6|10.0.0.6" \
  "$(printf '%s' "$SAMPLES" | sed 's/;$//; s/^ *//; s/ *$//')"
chk "F2 loadSeq：最终表体 = 新查询那条（10.0.0.6 蜜罐，存疑）" "存疑|蜜罐|10.0.0.6" "$(tdtext 0)"
chk "F2 loadSeq：输入框值仍是最后一次键入的 10.0.0.6" "10.0.0.6" "$(ev "document.querySelector('$HOSTSEL')?.value")"
mode '{"delayByHost":{}}'
clickbtn "清除筛选"; settle triage/cases
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
chk "F2 收尾：清除筛选后回到 4 行（页面还能用）" "4" "$(rows)"
fi

echo
echo "== 汇总（SEC=$SEC，web 根=$WEBROOT） =="
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then printf '失败项：\n'; printf ' - %s\n' "${FAILED[@]}"; exit 1; fi
echo "全部通过"
