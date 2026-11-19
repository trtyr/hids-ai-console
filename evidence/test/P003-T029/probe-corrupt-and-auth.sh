#!/usr/bin/env bash
# P003-T029 tester 探针 2：真进程上的三条文档口径（写者探针没盖的部分）
#   1) 覆盖层文件坏了不影响启动（http-api §3.6）：进程照常起来、GET 报环境变量、日志恰一条 config.load_failed
#   2) Basic 配了口令没配用户名 → 按 admin 比对（§4）：admin 凭据能写、别的用户名 401
#   3) 写失败不落 config.updated（§3.6 留痕：「记的是改了，不是想改」）
# 跑法：bash evidence/test/P003-T029/probe-corrupt-and-auth.sh（退出码 0 = 全过）
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
# 数据根指到 tmp（P003-T034 A2）：探针一个字节都不许写进仓库或真实全局根 ~/.local/share/hids-ai-console。
DATA=$(mktemp -d)
OVERRIDE="$DATA/config-overrides.json"
LOG=/tmp/t029-tester-probe.log
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
BASE="http://127.0.0.1:$PORT"
PASSWD=gate-pass-abcdef
FAIL=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; FAIL=1; }

cleanup() { rm -rf "$DATA"; kill "${PID:-}" 2>/dev/null; }
trap cleanup EXIT

start_app() {
  env -i PATH="$PATH" HOME="$HOME" HIDS_DATA_DIR="$DATA" \
    HIDS_HOST=127.0.0.1 HIDS_PORT="$PORT" HIDS_TRIAGE_INPUT_MODE=poll \
    CLOUDWALKER_URL=http://127.0.0.1:1 CLOUDWALKER_API_TOKEN=fake-token-123456 \
    LLM_BASE_URL=http://127.0.0.1:1/v1 LLM_API_KEY=fake-key-abcdef LLM_MODEL=env-model \
    "$@" node server.js >>"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 100); do
    curl --max-time 5 --connect-timeout 2 -sf -o /dev/null "$BASE/api/config" -u admin:"$PASSWD" && return 0
    sleep 0.1
  done
  echo "进程没起来"; tail -5 "$LOG"; return 1
}
stop_app() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }

# ---------- 1) 覆盖层文件坏了不影响启动 ----------
mkdir -p "$(dirname "$OVERRIDE")"
printf '{ 这不是 JSON' > "$OVERRIDE"
rm -f "$LOG"
start_app || exit 1
body=$(curl --max-time 5 --connect-timeout 2 -s "$BASE/api/config")
echo "$body" | grep -q '"model":{"configured":true,"name":"env-model"}' \
  && ok "覆盖层坏了：进程照常起、生效值回到环境变量" || bad "覆盖层坏了：GET 不对 $body"
grep -q '"event":"config.load_failed"' "$LOG" && ok "覆盖层坏了：日志有 config.load_failed" || bad "覆盖层坏了：没有 config.load_failed 日志"
[ "$(grep -c '"event":"config.load_failed"' "$LOG")" = "1" ] && ok "config.load_failed 恰一条" || bad "config.load_failed 不是一条"
# 坏文件还在时写一次（覆盖层被当空）→ 200，坏文件被原子覆盖
code=$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/config" -u admin:"$PASSWD" \
  -H 'Content-Type: application/json' -d '{"LLM_MODEL":"after-corrupt"}')
[ "$code" = "200" ] && ok "坏覆盖层之后仍能写（200）" || bad "坏覆盖层之后写失败：$code"
[ "$(curl --max-time 5 --connect-timeout 2 -s "$BASE/api/config" | python3 -c 'import json,sys;print(json.load(sys.stdin)["model"]["name"])')" = "after-corrupt" ] \
  && ok "写后 GET 报新值" || bad "写后 GET 不对"
stop_app

# ---------- 2) 配口令没配用户名 → admin 兜底 ----------
rm -f "$OVERRIDE" "$LOG"
start_app HIDS_BASIC_AUTH_PASSWORD="$PASSWD" || exit 1
code=$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/config" -u admin:"$PASSWD" \
  -H 'Content-Type: application/json' -d '{"LLM_MODEL":"admin-model"}')
[ "$code" = "200" ] && ok "配口令未配用户名：admin 凭据能写" || bad "admin 凭据应能写，实测 $code"
code=$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/config" -u ops:"$PASSWD" \
  -H 'Content-Type: application/json' -d '{"LLM_MODEL":"ops-model"}')
[ "$code" = "401" ] && ok "配口令未配用户名：别的用户名 401" || bad "别的用户名应 401，实测 $code"
code=$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/config" -u admin:'wrong-password' \
  -H 'Content-Type: application/json' -d '{"LLM_MODEL":"bad-pass-model"}')
[ "$code" = "401" ] && ok "错口令 401" || bad "错口令应 401，实测 $code"
[ "$(curl --max-time 5 --connect-timeout 2 -s "$BASE/api/config" -u admin:"$PASSWD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["model"]["name"])')" = "admin-model" ] \
  && ok "被拒的写没改生效值" || bad "被拒的写改了生效值"

# ---------- 3) 写失败不落 config.updated ----------
before=$(grep -c '"event":"config.updated"' "$LOG")
curl --max-time 5 --connect-timeout 2 -s -o /dev/null -X POST "$BASE/api/config" -u admin:"$PASSWD" \
  -H 'Content-Type: application/json' -d '{"LLM_MODEL":"   "}'
curl --max-time 5 --connect-timeout 2 -s -o /dev/null -X POST "$BASE/api/config" -u admin:"$PASSWD" \
  -H 'Content-Type: application/json' -d '{"HIDS_PORT":"9090"}'
after=$(grep -c '"event":"config.updated"' "$LOG")
[ "$before" = "$after" ] && ok "两次被拒的写没新增 config.updated（$before → $after）" || bad "写失败也落了 config.updated（$before → $after）"
[ "$after" = "1" ] && ok "成功写恰一条 config.updated" || bad "config.updated 计数不对：$after"
grep -q '"keys":\["LLM_MODEL"\]' "$LOG" && ok "config.updated 只带键名" || bad "config.updated 字段不对"
stop_app
rm -f "$OVERRIDE"
exit $FAIL
