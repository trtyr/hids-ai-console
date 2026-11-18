#!/usr/bin/env bash
# P003-T015 前端验收 · 真浏览器行为测（agent-browser 驱动真实 Chrome；本机没有 lightpanda 二进制，
# 行为测与截图都用 agent-browser，报告里已注明）。
# 前置：没有。本脚本自己起桩后端（evidence/test/P003-T015/stub-api.mjs）+ 前端 serve.js，跑完收进程。
# 判据全部来自 web/README.md（§4 §9 §10 §11）+ 任务卡 A1–A4；不读实现源码。
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
API=http://127.0.0.1:18099
WEB=http://127.0.0.1:13015
PASS=0; FAIL=0; FAILED=()

ok(){ PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); FAILED+=("$1"); printf 'FAIL  %s\n        期望: %s\n        实测: %s\n' "$1" "$2" "$3"; }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "$2" "$3"; fi; }
has(){ case "$3" in *"$2"*) ok "$1";; *) no "$1" "包含「$2」" "$3";; esac; }
hasnt(){ case "$3" in *"$2"*) no "$1" "不含「$2」" "$3";; *) ok "$1";; esac; }

# --- 浏览器 / 桩的薄封装 -------------------------------------------------
clickbtn(){ timeout 60 agent-browser eval "(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>x.textContent.trim()==='$1');if(!b)return 'NO-BTN';b.scrollIntoView({block:'center'});b.click();return 'ok'})()" >/dev/null 2>&1; }
# 真实键入（先点进控件，再逐键）
typename(){ timeout 60 agent-browser click "$1" >/dev/null 2>&1; timeout 60 agent-browser keyboard type "$2" >/dev/null 2>&1; }
ev(){ timeout 60 agent-browser eval "$1" 2>&1 | tail -1 | python3 -c 'import sys,json
s=sys.stdin.read().strip()
try:
    v=json.loads(s)
    print(str(v).lower() if isinstance(v,bool) else v)
except Exception:
    print(s)'; }
click(){ timeout 60 agent-browser scrollintoview "$1" >/dev/null 2>&1; timeout 60 agent-browser click "$1" >/dev/null 2>&1; }
fill(){ timeout 60 agent-browser fill "$1" "$2" >/dev/null 2>&1; }
press(){ timeout 60 agent-browser press "$1" >/dev/null 2>&1; }
mode(){ curl -s -X POST -d "$1" -H 'content-type: application/json' "$API/__ctl/mode" >/dev/null; }
resetlog(){ curl -s -X POST "$API/__ctl/reset-log" >/dev/null; }
hits(){ curl -s --max-time 5 "$API/__ctl/log" | python3 -c "import json,sys;p=sys.argv[1];print(sum(1 for r in json.load(sys.stdin)['requests'] if p in r['path']))" "$1"; }
lastpost(){ curl -s --max-time 5 "$API/__ctl/log" | python3 -c "import json,sys
rs=[r for r in json.load(sys.stdin)['requests'] if r['method']=='POST' and 'false-positive' in r['path']]
print(rs[-1]['body'] if rs else 'NONE')"; }
# 等请求条数到齐（别拿 sleep 当等待）
waitn(){ local pat="$1" n="$2" t0; t0=$(date +%s%3N)
  while :; do [ "$(hits "$pat")" -ge "$n" ] && return 0
    [ $(( $(date +%s%3N) - t0 )) -gt 6000 ] && return 0; sleep 0.1; done; }
# 等状态出现（不当 sleep 用；超时才判失败）
waitfor(){ local expr="$1" want="$2" t0; t0=$(date +%s%3N)
  while :; do
    local v; v=$(ev "$expr")
    [ "$v" = "$want" ] && return 0
    [ $(( $(date +%s%3N) - t0 )) -gt "${3:-12000}" ] && { echo "TIMEOUT(${3:-12000}ms) $expr → $v"; return 1; }
    sleep 0.15
  done; }
rows(){ ev "document.querySelectorAll('table tbody tr').length"; }
cellof(){ ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')].at($1);const c=r&&r.cells[$2];return c?c.textContent.replace(/\s+/g,' ').trim():'NO-CELL'})()"; }
gologin(){ fill "input[type=text]" hids; fill "input[type=password]" hids-2026; press Enter; waitfor "document.querySelector('h1')?.textContent" "总览" 15000; }
gopage(){ timeout 60 agent-browser click "a[href='$1']" >/dev/null 2>&1; }
cleanshot(){ mkdir -p evidence/test/P003-T015/shots; }

# --- 进程：桩后端 + 前端 --------------------------------------------------
echo "== 起桩后端与前端 =="
node evidence/test/P003-T015/stub-api.mjs 18099 > /tmp/t015-stub.log 2>&1 &
STUB=$!
HIDS_API_ORIGIN=$API HIDS_WEB_PORT=13015 node web/serve.js > /tmp/t015-web.log 2>&1 &
SRV=$!
trap 'kill $STUB $SRV 2>/dev/null; timeout 30 agent-browser close >/dev/null 2>&1' EXIT
for _ in $(seq 1 40); do curl -sf --max-time 1 "$WEB/" >/dev/null && break; sleep 0.2; done
curl -sf --max-time 2 "$WEB/" >/dev/null && echo "前端已起 $WEB" || { echo "前端起不来"; exit 1; }
mkdir -p evidence/test/P003-T015/shots

timeout 90 agent-browser open "$WEB/" --args "--no-sandbox" >/dev/null 2>&1
waitfor "document.querySelector('h1')?.textContent" "登录" 15000 || no "S0 登录页可见" "登录" "起不来"

echo
echo "== S0 登录（错误可恢复 + 键盘提交） =="
fill "input[type=text]" hids
fill "input[type=password]" wrong-pass
press Enter
waitfor "!!document.querySelector('[role=alert]')" "true" 8000 >/dev/null
has "S0 错密码：卡片内错误横幅可见" "账号或密码不正确" "$(ev "document.querySelector('[role=alert]')?.textContent.replace(/\s+/g,' ').trim()")"
fill "input[type=password]" hids-2026
press Enter
waitfor "document.querySelector('h1')?.textContent" "总览" 15000 >/dev/null \
  && ok "S0 改对密码后同一张卡片内恢复、进壳" || no "S0 改对密码后恢复" "h1=总览" "$(ev "document.querySelector('h1')?.textContent")"
chk "S0 侧栏六个入口" "总览|告警|牧云现查（演示）|深度溯源|规则|知识库" \
  "$(ev "[...document.querySelectorAll('nav a')].map(a=>a.textContent.trim()).join('|')")"

echo
echo "== S1 / A1 总览数字全部来自 /api/agent/triage/status，且不发 /api/alerts =="
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" 15000 >/dev/null
chk "A1 摘要带四数 = verdict_counts(threat,uncertain,false_positive,review)" "3,5,4,8" \
  "$(ev "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')")"
chk "A1 类型表行数 = type_counts 的 key 数（7）" "7" "$(ev "document.querySelectorAll('table tbody tr').length")"
chk "A1 类型表首行是数量最多的类型（反弹 Shell 6）" "反弹 Shell|6" \
  "$(ev "(()=>{const r=document.querySelector('table tbody tr');return r.cells[0].textContent.trim()+'|'+r.cells[1].textContent.trim()})()")"
has "A1 类型表合计 = 20" "合计 20" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
has "A1 队列模块有「最后推送」（syslog 模式）" "最后推送" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
chk "A1 「最后推送」的时间 = last_received_at 换成本地时间（2026-11-17 18:02:11）" "true" \
  "$(ev "/最后推送\\s*2026-11-17\\s*18:02:11/.test(document.body.innerText.replace(/\\s+/g,' '))")"
has "A1 队列模块有「Syslog 接收 在听」" "在听 udp://127.0.0.1:15514" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
chk "A1 总览一次渲染里 /api/alerts 请求数 = 0" "0" "$(hits /api/alerts)"
resetlog; clickbtn "刷新"; waitn /api/ 6
chk "A1 总览只发六路（去掉 /api/alerts 的六源）" "6" "$(hits /api/)"
resetlog
timeout 60 agent-browser select "select" "近 24 小时" >/dev/null 2>&1
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "1,2,2,0" 15000 >/dev/null
chk "A1 切「近 24 小时」后数字按窗口重算（1,2,2,0）" "1,2,2,0" \
  "$(ev "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')")"
chk "A1 只给 triage/status 加 since=" "1" "$(hits 'triage/status?since=')"
chk "A1 窗口内仍不发 /api/alerts" "0" "$(hits /api/alerts)"
has "A1 进度条说明切成「窗口内共 N 个任务」" "窗口内共 5 个任务" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
timeout 60 agent-browser select "select" "全部时间" >/dev/null 2>&1
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" 15000 >/dev/null

echo
echo "== S1b 总览六格（loading / empty / partial / error / long-content / disabled） =="
mode '{"delayMs":1500}'
gopage '#/alerts'; gopage '#/overview'
waitfor "!!document.querySelector('[aria-busy]')" "true" 3000 >/dev/null \
  || no "总览 loading：aria-busy 3s 内没出现" "true" "$(ev "!!document.querySelector('[aria-busy]')")"
chk "总览 loading：根节点 aria-busy" "true" "$(ev "document.querySelector('[aria-busy]')?.getAttribute('aria-busy')")"
chk "总览 loading：刷新按钮 disabled" "true" "$(ev "!!document.querySelector('button.is-loading')&&document.querySelector('button.is-loading').disabled")"
has "总览 loading：数值全「—」" "—" "$(ev "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')")"
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" 15000 >/dev/null
mode '{"delayMs":0,"status":"empty"}'
resetlog; clickbtn "刷新"
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "0,0,0,0" 15000 >/dev/null
has "总览 empty：类型表一行「暂无告警数据」" "暂无告警数据" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
has "总览 empty：构成说明「接口未返回类型统计。」" "接口未返回类型统计" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
chk "总览 empty：不发 /api/alerts" "0" "$(hits /api/alerts)"
mode '{"status":"503"}'
resetlog; clickbtn "刷新"
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "—,—,—,—" 15000 >/dev/null
has "总览 partial：顶部 warn 行点到具体源名「研判聚合」" "研判聚合" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
has "总览 partial：运行状态那几行照常（规则版本 r-41）" "r-41" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
mode '{"status":"ok","all":"503"}'
resetlog; clickbtn "刷新"
waitfor "document.querySelectorAll('[role=alert]').length>0" "true" 15000 >/dev/null
chk "总览 error：整页错误行 role=alert" "true" "$(ev "document.querySelectorAll('[role=alert]').length>0")"
chk "总览 error：数值全「—」" "—,—,—,—" "$(ev "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')")"
chk "总览 error：刷新按钮存在且可点（可重试）" "true|false" \
  "$(ev "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='刷新');return String(Boolean(b))+'|'+String(b?b.disabled:true)})()")"
mode '{"all":"ok","long":true}'
resetlog; clickbtn "刷新"
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" 15000 >/dev/null
chk "总览 long-content：提示词版本 dd 文本 = 原值且 title 也带全文（只视觉截断）" "true" \
  "$(ev "(()=>{const dd=[...document.querySelectorAll('dd')].find(d=>d.textContent.includes('p-2026.11.17-rc3'));if(!dd)return 'NO-DD';return String(dd.textContent===dd.title && dd.textContent.length>100 && dd.classList.contains('od-truncate'))})()")"
mode '{"long":false}'
gopage '#/alerts'; gopage '#/overview'
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" 15000 >/dev/null

echo
echo "== S2 / A4 牧云现查单独入口、标演示；主列表与总览都不请求 /api/alerts =="
chk "A4 演示是独立侧栏入口（单独 href）" "#/alerts-demo|牧云现查（演示）" \
  "$(ev "(()=>{const a=document.querySelector('a[href=\"#/alerts-demo\"]');return a?a.getAttribute('href')+'|'+a.textContent.trim():'NO-LINK'})()")"
resetlog
gopage '#/alerts-demo'
waitfor "document.querySelector('h1')?.textContent" "牧云现查（演示）" 15000 >/dev/null
chk "A4 演示页顶栏标题带「（演示）」" "牧云现查（演示）" "$(ev "document.querySelector('h1')?.textContent")"
has "A4 演示页首行固定说明（直连 GET /api/alerts）" "演示入口：本页直连牧云现查（GET /api/alerts）" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
has "A4 牧云没配时只有这一页显示不可用" "告警接口不可用" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
chk "A4 只有演示页会打 /api/alerts（本次 ≥1）" "true" "$([ "$(hits /api/alerts)" -ge 1 ] && echo true || echo false)"
resetlog; gopage '#/overview'
waitfor "[...document.querySelectorAll('.nums dd')].map(e=>e.textContent.trim()).join(',')" "3,5,4,8" 15000 >/dev/null
chk "A4 从演示页回总览：/api/alerts = 0" "0" "$(hits /api/alerts)"
resetlog; gopage '#/alerts'
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
chk "A4 主列表：/api/alerts = 0（牧云 503 不影响它）" "0" "$(hits /api/alerts)"
waitn /api/ 2
chk "A4 主列表只发 cases + queue status 两路" "2" "$(hits /api/)"

echo
echo "== S3 / A2 一行一条研判记录 + 误报 202 后行内即改 + 维护列另标 =="
chk "A2 行数 = 研判记录条数（4）" "4" "$(rows)"
chk "A2 表头九列（结论/类型/主机/时间/重复/命中规则/维护/状态/操作）" "结论|类型|主机|时间↓|重复|命中规则|维护|状态|操作" \
  "$(ev "[...document.querySelectorAll('table thead th')].map(t=>t.textContent.replace(/\s+/g,' ').trim()).join('|')")"
chk "A2 第 4 行 = revshell 记录（结论/类型/主机/重复/命中规则）" "真实威胁|反弹 Shell|10.0.0.5|×3|ssh_bruteforce" \
  "$(ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')].at(-1);const c=[...r.cells].map(x=>x.textContent.replace(/\s+/g,' ').trim());return [c[0],c[1],c[2],c[4],c[5]].join('|')})()")"
chk "A2 「重复」列四行 = repeat_count（×3 / ×1 / ×12 / ×2）" "×1,×12,×2,×3" \
  "$(ev "[...document.querySelectorAll('table tbody tr')].map(r=>r.cells[4].textContent.trim()).sort().join(',')")"
chk "A2 同主机不同记录各占一行（10.0.0.6 蜜罐 ×1）" "存疑|蜜罐|10.0.0.6|×1|没有套上" \
  "$(ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')][2];const c=[...r.cells].map(x=>x.textContent.replace(/\s+/g,' ').trim());return [c[0],c[1],c[2],c[4],c[5]].join('|')})()")"
chk "A2 未完成记录命中规则列写「—」" "—" "$(cellof 1 5)"
chk "A2 已完成但没命中 → 「没有套上」（记录 10.0.0.8）" "没有套上" "$(cellof 0 5)"
chk "A2 维护列另标（已误报那条：规则 已更新 · 知识库 已更新）" "规则 已更新 · 知识库 已更新" "$(cellof 0 6)"
chk "A2 维护列对没有维护的记录是「—」" "—" "$(cellof 2 6)"
chk "A2 未完成行「标为误报」disabled" "true|研判还没结束，不能登记误报" \
  "$(ev "(()=>{const b=[...document.querySelectorAll('table tbody tr')][1].querySelector('button');return b.disabled+'|'+(b.title||b.getAttribute('aria-label')||'')})()")"
chk "A2 已误报行按钮文案「已误报」且 disabled" "已误报|true" \
  "$(ev "(()=>{const b=[...document.querySelectorAll('table tbody tr')][0].querySelector('button');return b.textContent.trim()+'|'+b.disabled})()")"
chk "A2 long-content：主机格 title 带命令全文（253 字）、显示只有 IP" "true|10.0.0.5" \
  "$(ev "(()=>{const s=[...document.querySelectorAll('table tbody tr')].at(-1).querySelector('.cell-ip');return (s.title.length>200 && s.title.includes('命令 bash -i') && s.classList.contains('od-truncate'))+'|'+s.textContent.trim()})()")"

echo "-- 键盘路径：Tab 到「标为误报」→ Enter 展开表单 → 焦点落理由框 → Esc 回按钮 --"
ev "document.activeElement.blur();1" >/dev/null
for _ in $(seq 1 60); do
  press Tab
  if [ "$(ev "(()=>{const e=document.activeElement;return (e.getAttribute('aria-label')||'').startsWith('把 syslog:revshell')?'HIT':'no'})()")" = "HIT" ]; then break; fi
done
chk "A2 键盘：Tab 能落到该行「标为误报」按钮" "HIT" \
  "$(ev "(()=>{const e=document.activeElement;return (e.getAttribute('aria-label')||'').startsWith('把 syslog:revshell')?'HIT':'no'})()")"
press Enter
waitfor "!!document.querySelector('form[aria-label=登记误报]')" "true" 8000 >/dev/null
chk "A2 键盘 Enter 展开理由表单，焦点在 textarea" "TEXTAREA|给 syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1 填误报理由" \
  "$(ev "document.activeElement.tagName+'|'+document.activeElement.getAttribute('aria-label')")"
chk "A2 理由框有可见 label" "误报理由" "$(ev "document.querySelector('form[aria-label=登记误报] label')?.textContent.trim()")"
press Escape
waitfor "!!document.querySelector('form[aria-label=登记误报]')" "false" 8000 >/dev/null
chk "A2 Esc 收起表单并把焦点还给按钮" "BUTTON|标为误报" \
  "$(ev "document.activeElement.tagName+'|'+document.activeElement.textContent.trim()")"

echo "-- 误报：短理由不发请求；合格理由 202 后行内即改 --"
click "button[aria-label^='把 syslog:revshell']"
waitfor "!!document.querySelector('form[aria-label=登记误报]')" "true" 8000 >/dev/null
fill "textarea" "太短"
resetlog
click "form[aria-label=登记误报] button:last-of-type"
waitfor "document.querySelector('form[aria-label=登记误报]')?.textContent.includes('至少')" "true" 8000 >/dev/null
has "A2 短理由：就地报错（表单内可见文案）" "10 到 4000 字" "$(ev "document.querySelector('form[aria-label=登记误报]').textContent.replace(/\s+/g,' ')")"
chk "A2 短理由：一条请求都不发" "0" "$(hits false-positive)"
fill "textarea" "运维演练用的反弹 shell，确认是内部红队测试"
resetlog
click "form[aria-label=登记误报] button:last-of-type"
waitfor "document.querySelectorAll('form[aria-label=登记误报]').length" "0" 12000 >/dev/null
chk "A2 提交：POST …/false-positive 一次" "1" "$(hits false-positive)"
chk "A2 202 后行内即改、不重取整页（cases 请求 0 条）" "0" "$(hits triage/cases)"
chk "A2 提交正文只有 {\"reason\":…}" '{"reason": "运维演练用的反弹 shell，确认是内部红队测试"}' \
  "$(lastpost | python3 -c 'import sys,json;d=json.loads(sys.stdin.read());print(json.dumps({k:d[k] for k in sorted(d)},ensure_ascii=False))')"
chk "A2 202 后这一行结论就地变「误报」" "误报" "$(ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')].at(-1);return r.getAttribute('data-alert-id')?r.cells[0].textContent.trim():[...document.querySelectorAll('table tbody tr')].filter(x=>x.cells.length>8).at(-1).cells[0].textContent.trim()})()")"
chk "A2 维护列写进「规则 更新中 · 知识库 更新中」" "规则 更新中 · 知识库 更新中" \
  "$(ev "[...document.querySelectorAll('table tbody tr')].filter(x=>x.cells.length>8).at(-1).cells[6].textContent.replace(/\s+/g,' ').trim()")"
chk "A2 该行按钮转「已误报」且 disabled" "已误报|true" \
  "$(ev "(()=>{const r=[...document.querySelectorAll('table tbody tr')].filter(x=>x.cells.length>8).at(-1);const b=r.querySelector('button');return b.textContent.trim()+'|'+b.disabled})()")"
has "A2 播报「已把 … 标成误报，理由已记录」" "标成误报，理由已记录" \
  "$(ev "document.querySelector('[data-role=sr-status],[role=status][aria-live]')?.textContent.trim()||''")"

echo "-- 连点：表单提交在途时按钮已 disabled，连点三下只发一条 POST --"
mode '{"delayMs":800}'
click "button[aria-label^='把 syslog:honeypot']"
waitfor "!!document.querySelector('form[aria-label=登记误报]')" "true" 8000 >/dev/null
fill "textarea" "蜜罐探测是扫描器自动巡检，不算攻击行为"
resetlog
timeout 60 agent-browser scrollintoview "form[aria-label=登记误报] button:last-of-type" >/dev/null 2>&1
timeout 60 agent-browser click "form[aria-label=登记误报] button:last-of-type" >/dev/null 2>&1
chk "A2 提交在途：按钮 disabled" "true" "$(ev "(()=>{const b=[...document.querySelectorAll('form[aria-label=登记误报] button')].pop();return b?String(b.disabled):'NO-FORM'})()")"
ev "(()=>{const b=[...document.querySelectorAll('form[aria-label=登记误报] button')].pop();b.click();b.click();return 1})()" >/dev/null
waitn false-positive 1
waitfor "document.querySelectorAll('form[aria-label=登记误报]').length" "0" 12000 >/dev/null
chk "A2 连点三下：仍只有一条 POST" "1" "$(hits false-positive)"
mode '{"delayMs":0}'

echo
echo "== S4 / A3 详情四块：短结果 / 命中 Rego 或没有套上 / 用过的 wiki / 证据 =="
D1='syslog%3Arevshell%3Aa1b2c3d4e5f60718%3A1763373600%3Aaaa1'
D2='syslog%3Ahoneypot%3Ab2c3d4e5f6071829%3A1763377200%3Abbb2'
resetlog
timeout 60 agent-browser open "$WEB/#/alert-detail/$D1" >/dev/null 2>&1
waitfor "document.querySelector('h1')?.textContent" "告警详情" 15000 >/dev/null
BODY=$(ev "document.body.innerText.replace(/\s+/g,' ')")
has "A3 短结果：verdict.summary 整段在页面上（与接口逐字相等）" "主机 10.0.0.5 上出现反弹 shell，外联 192.0.2.2:4444，命令行与进程树一致，判定真实威胁。" "$BODY"
has "A3 短结果：报告段取 triage.report（文档 §11.6 的 triage.report ?? verdict.report）" "【短结果】判定为真实威胁：反弹 shell 成功建立。" "$BODY"
has "A3 命中的规则：写「命中 <id>（<name>）」" "ssh_bruteforce" "$BODY"
has "A3 命中的规则：规则名" "SSH 暴力破解" "$BODY"
chk "A3 命中的规则：<pre class=rego> 文本 = /api/rules 的 rego 原文" "true" \
  "$(ev "(()=>{const p=document.querySelector('pre.rego');if(!p)return 'NO-PRE';return String(p.textContent.trim().startsWith('package hids.rules.ssh_bruteforce')&&p.textContent.includes('count(input.payload.attempts) >= 5'))})()")"
chk "A3 命中的规则：只发一次 GET /api/rules/ssh_bruteforce" "1" "$(hits /api/rules/ssh_bruteforce)"
chk "A3 用过的 wiki：meta「查阅 2 页」" "true" "$(ev "/查阅\\s*2\\s*页/.test(document.body.innerText)")"
chk "A3 用过的 wiki：采纳页逐条列出（1 条，文本=编号）" "1|honeypot/HP-10.md" \
  "$(ev "(()=>{const li=[...document.querySelectorAll('li.wiki-item')];return li.length+'|'+(li[0]?li[0].textContent.trim():'NO-LI')})()")"
has "A3 用过的 wiki：未采纳时写 reason" "本页判据与本次外联行为一致" "$BODY"
has "A3 证据：共 N 条（3 条）" "共 3 条" "$BODY"
chk "A3 证据：条目数 = evidence[] 长度（3）" "3" "$(ev "document.querySelectorAll('li.ev-item').length")"
chk "A3 证据链：citation 与条目对得上 → 脚注隐藏" "true|0" \
  "$(ev "(()=>{const n=document.querySelector('[data-role=evidence-note]');return String(!n||n.hidden)+'|'+document.querySelectorAll('.claim-ref.is-missing').length})()")"
chk "A3 推送 ID 对不上牧云号时照样打开（h1 仍是告警详情）" "告警详情" "$(ev "document.querySelector('h1')?.textContent")"
has "A3 题干说明「牧云事件没有读到」" "牧云事件没有读到" "$BODY"
resetlog
timeout 60 agent-browser open "$WEB/#/alert-detail/$D2" >/dev/null 2>&1
waitfor "document.body.innerText.includes('蜜罐只收到探测请求')" "true" 15000 >/dev/null
BODY2=$(ev "document.body.innerText.replace(/\s+/g,' ')")
has "A3 没有套上：rego.status=none 的研判写「没有套上」" "没有套上" "$BODY2"
chk "A3 没有套上：不发 GET /api/rules/*" "0" "$(hits /api/rules/)"
has "A3 wiki 未采纳：列表空 + 说明显示 reason" "没有采纳页" "$BODY2"
chk "A3 wiki 未采纳：采纳列表为空" "0" "$(ev "document.querySelectorAll('li.wiki-item').length")"

echo
echo "== S5 告警页六格剩余两格（loading / empty / filtered-empty） =="
mode '{"delayMs":1500}'
gopage '#/overview'; gopage '#/alerts'
waitfor "!!document.querySelector('[aria-busy]')" "true" 3000 >/dev/null \
  || no "告警 loading：aria-busy 3s 内没出现" "true" "$(ev "!!document.querySelector('[aria-busy]')")"
has "告警 loading：表体一行「正在读取研判记录…」" "正在读取研判记录" "$(ev "document.querySelector('table tbody')?.innerText.replace(/\s+/g,' ').trim()")"
chk "告警 loading：table-wrap aria-busy=true" "true" "$(ev "document.querySelector('[aria-busy]')?.getAttribute('aria-busy')")"
chk "告警 loading：刷新 + 四个筛选控件全部 disabled（没有可用控件）" "0|0|true" \
  "$(ev "(()=>{const en=[...document.querySelectorAll('input,select')].filter(e=>!e.disabled).length;const rb=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='刷新')[0];return en+'|'+[...document.querySelectorAll('select')].filter(s=>!s.disabled).length+'|'+String(rb&&rb.disabled)})()")"
waitfor "document.querySelectorAll('table tbody tr').length" "4" 20000 >/dev/null
mode '{"delayMs":0,"cases":"empty"}'
resetlog; clickbtn "刷新"
waitfor "document.body.innerText.includes('暂无研判记录')" "true" 15000 >/dev/null
has "告警 empty（无筛选）：一行「暂无研判记录。」" "暂无研判记录" "$(ev "document.querySelector('table tbody')?.innerText.replace(/\s+/g,' ').trim()")"
mode '{"cases":"ok"}'
resetlog; clickbtn "刷新"
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
resetlog
typename "input" "1.2.3.4"
waitfor "document.body.innerText.includes('没有匹配的研判记录')" "true" 8000 >/dev/null
waitn triage/cases 7
chk "F2 §10.5：逐键输入 1.2.3.4（7 键）→ cases 请求 7 轮（值一变就重取）" "7" "$(hits triage/cases)"
B=$(hits triage/cases); press Enter; waitn triage/cases $((B+1)); waitfor "document.body.innerText.includes('没有匹配的研判记录')" "true" 4000 >/dev/null
chk "F2 §10.5：按 Enter 不再补一轮（回车零轮新增）" "$B" "$(hits triage/cases)"
ev "document.querySelector('input[type=search]')?.blur();1" >/dev/null
waitfor "document.body.innerText.includes('没有匹配的研判记录')" "true" 4000 >/dev/null
chk "F2 §10.5：失焦（值没变）也不补请求（失焦零轮）" "$B" "$(hits triage/cases)"
has "告警 empty（有筛选）：「没有匹配的研判记录。」+ 清除筛选" "没有匹配的研判记录" "$(ev "document.querySelector('table tbody')?.innerText.replace(/\s+/g,' ').trim()")"
clickbtn "清除筛选"
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
chk "告警 empty→清除筛选后回到 4 行" "4" "$(rows)"

echo "-- 告警 partial：triage/status 503 → 队列条降级，列表照常 4 行 --"
mode '{"delayMs":0,"status":"503"}'
resetlog; clickbtn "刷新"
waitfor "!!document.querySelector('[data-role=qerror]')" "true" 15000 >/dev/null \
  || no "告警 partial：队列条降级提示没出现（[data-role=qerror]）" "true" "false"
chk "告警 partial：队列条降级提示可见" "true" "$(ev "!!document.querySelector('[data-role=qerror]')")"
chk "告警 partial：列表 4 行照常（只有队列条降级）" "4" "$(rows)"
chk "告警 partial：本页仍不发 /api/alerts" "0" "$(hits /api/alerts)"
mode '{"status":"ok"}'

echo "-- 告警 error：cases 503 → role=alert 说明 + 点「重试」回 4 行 --"
mode '{"cases":"503"}'
resetlog; clickbtn "刷新"
waitfor "document.querySelectorAll('[role=alert]').length>0" "true" 15000 >/dev/null
has "告警 error：role=alert 写「服务端没有启用自动研判」" "服务端没有启用自动研判" \
  "$(ev "document.querySelector('[role=alert]')?.textContent.replace(/\s+/g,' ').trim()")"
chk "告警 error：给出「重试」按钮" "1" "$(ev "[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='重试').length")"
mode '{"cases":"ok"}'
clickbtn "重试"
waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
chk "告警 error：点「重试」回 4 行" "4" "$(rows)"

echo
echo "== S6 边界：401 失效不冒充网络问题 / 无 ID 详情不白屏 / 凭据不落盘 =="
mode '{"all":"401"}'
gopage '#/overview'; clickbtn "刷新"
waitfor "document.querySelectorAll('[role=alert]').length>0" "true" 12000 >/dev/null
has "401：总览说「登录已失效」，不冒充网络问题" "登录已失效" "$(ev "document.body.innerText.replace(/\s+/g,' ')")"
mode '{"all":"ok"}'
timeout 60 agent-browser open "$WEB/#/alert-detail/" >/dev/null 2>&1
waitfor "document.querySelector('h1')?.textContent" "告警详情" 12000 >/dev/null
B=$(ev "document.body.innerText.replace(/\\s+/g,' ')")
has "无 ID 进详情：「没有找到这条告警」" "没有找到这条告警" "$B"
has "无 ID 进详情：写清原因（链接里没有告警 ID），不白屏" "链接里没有告警 ID" "$B"
chk "无 ID 详情：给「返回告警列表」的退路" "1" "$(ev "[...document.querySelectorAll('a')].filter(a=>a.textContent.includes('返回告警列表')).length")"
timeout 60 agent-browser reload >/dev/null 2>&1
waitfor "document.querySelector('h1')?.textContent" "登录" 15000 >/dev/null
chk "刷新页面回登录页（凭据只在内存：localStorage / sessionStorage 都是 0）" "登录|0|0" \
  "$(ev "document.querySelector('h1')?.textContent+'|'+localStorage.length+'|'+sessionStorage.length")"
gologin
gopage '#/alerts'; waitfor "document.querySelectorAll('table tbody tr').length" "4" 15000 >/dev/null
timeout 60 agent-browser eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='退出登录');b.click();return 1})()" >/dev/null
waitfor "document.querySelector('h1')?.textContent" "登录" 12000 >/dev/null
timeout 60 agent-browser back >/dev/null 2>&1
waitfor "document.querySelector('h1')?.textContent" "登录" 5000 >/dev/null
chk "退出登录后按后退：仍是登录页，不回放带数据的旧页" "登录" "$(ev "document.querySelector('h1')?.textContent")"

echo
echo "== 控制台 =="
CONS=$(timeout 60 agent-browser console 2>&1 | tail -30)
ERRC=$(printf '%s' "$CONS" | grep -ci "error" || true)
echo "     控制台含 error 字样行数：$ERRC"
printf '%s\n' "$CONS" | grep -i "error" | head -5

echo
echo "== 汇总 =="
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then printf '失败项：\n'; printf ' - %s\n' "${FAILED[@]}"; exit 1; fi
echo "全部通过"
