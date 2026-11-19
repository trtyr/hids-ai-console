#!/usr/bin/env bash
# P003-T029 真进程探针（A1/A2/A4/A5 的端到端证据）：
#   1) 写配置不重启进程 → GET /api/config 立刻反映；
#   2) 运行中生效：把 CLOUDWALKER_URL 指到本地 stub，/api/status 立刻连通，且 stub 收到的 Cookie 是新 Token；
#   3) 落盘（只存改过的键、权限 0600）→ 杀掉重启 → 改过的值仍生效、没改过的键照旧读环境变量；
#   4) 任何响应与日志都不出现 Token 原文；config.updated 只带键名；
#   5) 删掉覆盖层 → 回到环境变量。
# 跑法：bash evidence/test/P003-T029/probe-config-write.sh（退出码 0 = 全过）
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
OVERRIDE="$ROOT/.data/config-overrides.json"
freeport() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
PORT=$(freeport)
STUBPORT=$(freeport)
BASE="http://127.0.0.1:$PORT"
STUB="http://127.0.0.1:$STUBPORT"
STUBLOG=/tmp/t029-probe-stub.log
APPLOG=/tmp/t029-probe.log
NEW_TOKEN=new-token-abcdef
FAIL=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; FAIL=1; }

cleanup() { rm -f "$OVERRIDE"; kill "${PID:-}" "${STUBPID:-}" 2>/dev/null; }
trap cleanup EXIT

start_stub() {
  rm -f "$STUBLOG"
  python3 - "$STUBLOG" "$STUBPORT" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
log, port = sys.argv[1], int(sys.argv[2])
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length') or 0))
        with open(log, 'a') as handle:
            handle.write(json.dumps({'path': self.path, 'cookie': self.headers.get('Cookie')}) + '\n')
        try: rid = json.loads(body).get('id', 1)
        except Exception: rid = 1
        payload = json.dumps({'jsonrpc': '2.0', 'id': rid, 'result': {'total': 0, 'events': []}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *args): pass
HTTPServer(('127.0.0.1', port), Handler).serve_forever()
PY
  STUBPID=$!
}

start_app() {
  env -i PATH="$PATH" HOME="$HOME" \
  HIDS_HOST=127.0.0.1 HIDS_PORT="$PORT" HIDS_TRIAGE_INPUT_MODE=poll \
  CLOUDWALKER_URL=http://127.0.0.1:1 CLOUDWALKER_API_TOKEN=fake-token-123456 \
  LLM_BASE_URL=http://127.0.0.1:1/v1 LLM_API_KEY=fake-key-abcdef LLM_MODEL=env-model \
  node server.js >>"$APPLOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 100); do
    curl --max-time 5 --connect-timeout 2 -sf -o /dev/null "$BASE/api/config" && return 0
    sleep 0.1
  done
  echo "进程没起来"; tail -5 "$APPLOG"; return 1
}
stop_app() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
model_name() { curl --max-time 5 --connect-timeout 2 -s "$BASE/api/config" | python3 -c 'import json,sys;print(json.load(sys.stdin)["model"]["name"])'; }

rm -f "$OVERRIDE" "$APPLOG"
start_stub
start_app || exit 1

[ "$(model_name)" = "env-model" ] && ok "起进程后 GET 报环境变量的值" || bad "起进程后应报 env-model"

# 起点：牧云地址指到不可达的 127.0.0.1:1 → /api/status 502
[ "$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' "$BASE/api/status")" = "502" ] \
  && ok "写之前 /api/status 连不上（502）" || bad "写之前 /api/status 应 502"

WRITE=$(curl --max-time 5 --connect-timeout 2 -s -o /tmp/t029-write.json -w '%{http_code}' -X POST "$BASE/api/config" -H 'Content-Type: application/json' \
  -d "{\"LLM_MODEL\":\"runtime-model\",\"CLOUDWALKER_URL\":\"$STUB\",\"CLOUDWALKER_API_TOKEN\":\"$NEW_TOKEN\"}")
[ "$WRITE" = "200" ] && ok "POST /api/config → 200" || bad "POST 状态码应是 200，实测 $WRITE"
grep -q '"updated":\["LLM_MODEL","CLOUDWALKER_URL","CLOUDWALKER_API_TOKEN"\]' /tmp/t029-write.json \
  && ok "响应 updated 逐键（正文顺序）" || bad "响应 updated 不对：$(cat /tmp/t029-write.json)"
grep -q "$NEW_TOKEN" /tmp/t029-write.json && bad "写成功的正文回显了 Token 原文" || ok "写成功的正文不含 Token 原文"

[ "$(model_name)" = "runtime-model" ] && ok "不重启进程，GET /api/config 立刻报新值" || bad "GET 应报 runtime-model"

# 运行中生效：新地址通、新 Token 真被用上
[ "$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' "$BASE/api/status")" = "200" ] \
  && ok "写完之后 /api/status 立刻连上新地址（200）" || bad "写完之后 /api/status 应 200"
for _ in $(seq 1 50); do grep -q "$NEW_TOKEN" "$STUBLOG" 2>/dev/null && break; sleep 0.1; done
grep -q "API-Token=$NEW_TOKEN" "$STUBLOG" && ok "牧云调用用的是写进去的新 Token（stub 收到 Cookie）" || bad "stub 没收到新 Token：$(cat "$STUBLOG" 2>/dev/null)"

stop_app
[ -f "$OVERRIDE" ] && ok "覆盖层文件已落盘" || bad "覆盖层文件没落盘"
[ "$(stat -c '%a' "$OVERRIDE")" = "600" ] && ok "覆盖层权限 0600" || bad "覆盖层权限不是 600"
python3 - "$OVERRIDE" <<'PY' && ok "覆盖层只存改过的三个键" || bad "覆盖层键集不对"
import json, sys
d = json.load(open(sys.argv[1]))
assert set(d) == {'LLM_MODEL', 'CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN'}, d
PY
# 这条痕迹在第一进程的日志里，重启会清掉日志——趁现在核。
grep -q "\"event\":\"config.updated\",\"keys\":\\[\"LLM_MODEL\",\"CLOUDWALKER_URL\",\"CLOUDWALKER_API_TOKEN\"\\]" "$APPLOG" \
  && ok "config.updated 只带键名" || bad "没找到 config.updated 痕迹"
grep -q "$NEW_TOKEN" "$APPLOG" && bad "日志里出现了 Token 原文" || ok "日志里没有 Token 原文"

# 重启：环境变量仍是 env-model / 127.0.0.1:1，覆盖层的值要赢
start_app || exit 1
[ "$(model_name)" = "runtime-model" ] && ok "重启后改过的值仍生效" || bad "重启后应报 runtime-model"
body=$(curl --max-time 5 --connect-timeout 2 -s "$BASE/api/config")
echo "$body" | grep -q '"model":{"configured":true' && ok "没改过的键照旧读环境变量（模型三项仍齐）" || bad "没改过的键没生效：$body"
echo "$body" | grep -q "\"port\":$PORT" && ok "监听端口仍是环境变量那个" || bad "端口被带偏"
echo "$body" | grep -q "$NEW_TOKEN" && bad "GET 正文回显了 Token 原文" || ok "GET 正文不含 Token 原文"
[ "$(curl --max-time 5 --connect-timeout 2 -s -o /dev/null -w '%{http_code}' "$BASE/api/status")" = "200" ] \
  && ok "重启后牧云仍指向覆盖层里的新地址" || bad "重启后 /api/status 应 200"

stop_app
rm -f "$OVERRIDE"
start_app || exit 1
[ "$(model_name)" = "env-model" ] && ok "删掉覆盖层后回到环境变量" || bad "清理后应回到 env-model"
stop_app
exit $FAIL
