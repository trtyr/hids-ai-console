#!/usr/bin/env bash
# P002-T001 复测的 HTTP 面用例（测试席自建，不进产品代码）。
# 自带起停：真 server.js + web/serve.js，跑完回收进程。默认端口 19881/13310/13311。
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BE_PORT="${BE_PORT:-19881}"
WEB_PORT="${WEB_PORT:-13310}"
DEAD_PORT="${DEAD_PORT:-19899}"
WEB2_PORT="${WEB2_PORT:-13311}"
TMP="$(mktemp -d)"
FAIL=0

cleanup() {
  for f in "$TMP/be.pid" "$TMP/web.pid" "$TMP/web2.pid"; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then printf 'PASS  %-60s %s\n' "$1" "$3"
  else printf 'FAIL  %-60s expected=%s actual=%s\n' "$1" "$2" "$3"; FAIL=1; fi
}

cd "$ROOT" || exit 2
HIDS_BASIC_AUTH_USER=hids HIDS_BASIC_AUTH_PASSWORD=hids-2026 HIDS_PORT="$BE_PORT" \
  node server.js >"$TMP/be.log" 2>&1 & echo $! >"$TMP/be.pid"
HIDS_API_ORIGIN="http://127.0.0.1:$BE_PORT" HIDS_WEB_PORT="$WEB_PORT" \
  node web/serve.js >"$TMP/web.log" 2>&1 & echo $! >"$TMP/web.pid"
HIDS_API_ORIGIN="http://127.0.0.1:$DEAD_PORT" HIDS_WEB_PORT="$WEB2_PORT" \
  node web/serve.js >"$TMP/web2.log" 2>&1 & echo $! >"$TMP/web2.pid"
for i in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$WEB_PORT/" && break; sleep 0.2
done
B="http://127.0.0.1:$WEB_PORT"

code() { curl -s --path-as-is -o /dev/null -w '%{http_code}' "$1"; }

# A1 登录页可开、静态资源可达
check "A1 / 登录页 200" 200 "$(code "$B/")"
check "A1 /src/views/login.js 200" 200 "$(code "$B/src/views/login.js")"

# F1 交接件一律 404（含编码/大小写/尾斜杠/查询串绕法）
for p in "/_handoff/design/hids-ai-design.zip" "/_handoff/handoff.md" \
         "/_handoff/design/openapi_2_.yaml" "/_handoff/" "/_handoff" \
         "/%5Fhandoff/handoff.md" "/_HANDOFF/handoff.md" "/_handoff//handoff.md" \
         "/_handoff/handoff.md?x=1" "/_handoff%2Fhandoff.md" "/x/../_handoff/handoff.md"; do
  check "F1 404 $p" 404 "$(code "$B$p")"
done
# 规范化到公开文件的路径不该被误杀
check "F1 /_handoff/../index.html 放行到 200" 200 "$(code "$B/_handoff/../index.html")"

# A1 畸形路径 400 且进程不死
check "A1 /%zz → 400" 400 "$(code "$B/%zz")"
check "A1 畸形后 / 仍 200" 200 "$(code "$B/")"
kill -0 "$(cat "$TMP/web.pid")" 2>/dev/null && echo "PASS  A1 畸形请求后 web 进程存活" || { echo "FAIL  A1 web 进程已退出"; FAIL=1; }

# A2 会话接口：错凭据 401、对凭据 200、无凭据 401
check "A2 /api/session 错凭据 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -u hids:nope "$B/api/session")"
check "A2 /api/session 对凭据 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -u hids:hids-2026 "$B/api/session")"
check "A2 /api/session 无凭据 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/session")"

# 错误态：后端不可达 502，静态面仍 200
B2="http://127.0.0.1:$WEB2_PORT"
check "六格 error: 后端死 → /api/session 502" 502 "$(curl -s -o /dev/null -w '%{http_code}' "$B2/api/session")"
check "六格 error: 同上实例 / 200" 200 "$(code "$B2/")"

# A1 不写死演示账号：静态产物里只有注释命中 demo 字样
HITS="$(for f in index.html assets/app.css assets/theme.js src/app.js src/session.js \
             src/credentials.js src/router.js src/views/login.js src/views/shell.js \
             pages/overview.js pages/alerts.js pages/trace.js pages/rules.js \
             pages/knowledge.js pages/alert-detail.js; do
          curl -s "$B/$f" | grep -nE "hids-2026|DEMO 常量|演示账号" | sed "s|^|$f:|"
        done)"
if echo "$HITS" | grep -vq '^$'; then
  echo "INFO  A1 demo 字样命中（应全在注释里，人工确认）："; echo "$HITS"
fi
if echo "$HITS" | grep -qE 'const DEMO|DEMO *=|DEMO_USER|hids-2026'; then
  echo "FAIL  A1 静态产物里出现可用演示凭据"; FAIL=1
else
  echo "PASS  A1 静态产物无可执行演示凭据（无 hids-2026 / DEMO 常量）"
fi

exit $FAIL
