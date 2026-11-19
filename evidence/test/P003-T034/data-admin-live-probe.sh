#!/usr/bin/env bash
# P003-T034 测试席（何东阳）数据管理活口探针 —— 真进程 + 注入数据根（不碰真实全局根）：
#   schema：GET /api/data/inventory 七类 kind 顺序 / path 全在注入根 / data_dir = 注入根 / total = 各类之和
#   cleanup 200 形状：{dry_run,kind,action,threshold,candidates,applied,inventory}（http-api.md:91、§3.7.2 表）
#   边界 + 错误码：缺 kind / 无阈值 / 非法 kind / keep=-1 / 多带键 → 400 caller_error（含 code 与话术）
#   鉴权：配了 Basic 口令时无凭据 401、admin 凭据 200（http-api.md §3.7 末表、§4）
# 判据出处：docs/modules/http-api.md §3.7（数据管理）、§4（Basic）；openapi.yaml 数据管理段。不读实现。
set -u
cd "$(dirname "$0")/../../.." || exit 1
DATA=$(mktemp -d); PASSWD=probe-pass-123; FAIL=0; LOG=/tmp/t034-data-admin-probe.log
freeport() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
ok()  { echo "PASS $*"; }
bad() { echo "FAIL $*"; FAIL=1; }
cleanup() { rm -rf "$DATA"; kill "${PID:-}" 2>/dev/null; wait "${PID:-}" 2>/dev/null; }
trap cleanup EXIT

start_app() {  # $1.. = extra env
  PORT=$(freeport); BASE="http://127.0.0.1:$PORT"; : > "$LOG"
  env -i HOME="$DATA/home" PATH="$PATH" HIDS_HOST=127.0.0.1 HIDS_PORT="$PORT" HIDS_DATA_DIR="$DATA/root" \
    CLOUDWALKER_URL=http://127.0.0.1:1 CLOUDWALKER_API_TOKEN=fake-token-123456 \
    LLM_BASE_URL=http://127.0.0.1:1/v1 LLM_API_KEY=fake-key-abcdef LLM_MODEL=probe-model "$@" \
    timeout 60 node server.js > "$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 100); do
    # 配了口令时未认证的 /api/config 是 401 —— 401 也说明闸门与进程都活着
    ready=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "$BASE/api/config" 2>/dev/null)
    { [ "$ready" = 200 ] || [ "$ready" = 401 ]; } && return 0
    sleep 0.1
  done
  echo "进程没起来"; tail -5 "$LOG"; return 1
}
stop_app() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
post() { curl --max-time 5 --connect-timeout 2 -s -o /tmp/t034-post-body -w '%{http_code}' -X POST "$BASE/api/data/cleanup" \
           -H 'Content-Type: application/json' -d "$1" ${2:+-u "$2"}; }
code_of() { python3 -c 'import json,sys;print(json.load(open("/tmp/t034-post-body")).get("code",""))' 2>/dev/null; }
err_of()  { python3 -c 'import json,sys;print(json.load(open("/tmp/t034-post-body")).get("error",""))' 2>/dev/null; }

ROOT="$DATA/root"
start_app || exit 1

# ---------- 1) schema：盘点 ----------
headers=$(curl --max-time 5 -s -D - -o /tmp/t034-inv.json "$BASE/api/data/inventory")
grep -qi '^cache-control: no-store' <<<"$headers" && ok "inventory 200 带 Cache-Control: no-store" || bad "inventory 没 no-store"
python3 - "$ROOT" <<'PY' && ok "inventory schema：data_dir/七类顺序/path 全在注入根/total=各类和" || bad "inventory schema 不符（见上）"
import json,sys
root=sys.argv[1]; d=json.load(open('/tmp/t034-inv.json'))
want=['cases','investigations','boards','wiki_sessions','queue','logs','config_overrides']
assert d['data_dir']==root, f"data_dir={d['data_dir']} != {root}"
kinds=[s['kind'] for s in d['stores']]
assert kinds==want, f"kind 顺序 {kinds} != {want}"
for s in d['stores']:
    assert set(s)>= {'kind','label','path','exists','count','bytes'}, s
    assert s['path'].startswith(root), f"{s['kind']} 落点 {s['path']} 不在注入根"
assert d['total']['count']==sum(s['count'] for s in d['stores']), 'total.count 不等于各类之和'
assert d['total']['bytes']==sum(s['bytes'] for s in d['stores']), 'total.bytes 不等于各类之和'
print('  stores', kinds, 'total', d['total'])
PY
[ -e "$ROOT" ] || bad "注入根 $ROOT 不存在（进程应就地建）"
[ -e "$DATA/home/.local/share/hids-ai-console" ] && bad "HOME 全局根被创建了（应零写入）" || ok "HOME 全局根未被创建"
[ -e .data ] && bad "仓库里出现了 .data" || ok "仓库内无 .data"

# ---------- 2) cleanup 200 形状（dry-run，keep=0）----------
c=$(post '{"kind":"cases","keep":0}')
[ "$c" = 200 ] && ok "cleanup dry-run keep=0 → 200" || bad "cleanup keep=0 回 $c"
python3 - <<'PY' && ok "cleanup 200 形状 {dry_run,kind,action,threshold,candidates,applied,inventory}" || bad "cleanup 200 形状不符"
import json
d=json.load(open('/tmp/t034-post-body'))
need=['dry_run','kind','action','threshold','candidates','applied','inventory']
assert set(d)==set(need), f"键 {sorted(d)} != {sorted(need)}"
assert d['dry_run'] is True and d['kind']=='cases' and d['action']=='archive', d
assert d['threshold']=={'older_than':None,'keep':0}, d['threshold']
assert isinstance(d['candidates'],dict) and {'count','bytes','items','truncated'} <= set(d['candidates']), d['candidates']
assert d['applied']=={'count':0,'bytes':0}, f"dry-run applied 恒为 {{count:0,bytes:0}}，实为 {d['applied']}"
assert set(d['inventory'])=={'data_dir','stores','total'}, d['inventory'].keys()
print('  dry_run', d['dry_run'], 'action', d['action'], 'applied', d['applied'], 'threshold', d['threshold'])
PY

# ---------- 3) 边界 + 错误码 400（每条都断言 code 与话术点）----------
c=$(post '{}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && ok "缺 kind → 400 caller_error：$(err_of)" || bad "缺 kind 回 $c / $(cat /tmp/t034-post-body)"
for body in '{"kind":"cases"}' '{"kind":"queue"}'; do
  c=$(post "$body"); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && grep -q '至少' <<<"$(err_of)" \
    && ok "无阈值 $body → 400 caller_error：$(err_of)" || bad "无阈值 $body 回 $c / $(cat /tmp/t034-post-body)"
done
c=$(post '{"kind":"pirate","keep":1}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && ok "非法 kind → 400 caller_error：$(err_of)" || bad "非法 kind 回 $c / $(cat /tmp/t034-post-body)"
c=$(post '{"kind":"cases","keep":-1}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && grep -q 'keep' <<<"$(err_of)" && ok "keep=-1 → 400 caller_error：$(err_of)" || bad "keep=-1 回 $c / $(cat /tmp/t034-post-body)"
c=$(post '{"kind":"cases","keep":0,"bogus":1}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && ok "多带键 → 400 caller_error：$(err_of)" || bad "多带键回 $c / $(cat /tmp/t034-post-body)"
c=$(post '{"kind":"cases","keep":0,"action":"burn"}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && ok "非法 action → 400 caller_error：$(err_of)" || bad "非法 action 回 $c / $(cat /tmp/t034-post-body)"
c=$(post '{"kind":"cases","keep":1.5}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && ok "keep=1.5（非整数）→ 400 caller_error：$(err_of)" || bad "keep=1.5 回 $c / $(cat /tmp/t034-post-body)"
c=$(post '{"kind":"cases","older_than":"不是时间","keep":0}'); [ "$c" = 400 ] && [ "$(code_of)" = caller_error ] && ok "older_than 非时间串 → 400 caller_error：$(err_of)" || bad "older_than 非时间串回 $c / $(cat /tmp/t034-post-body)"

# ---------- 4) 鉴权：配了口令 → 无凭据 401，admin 凭据 200 ----------
stop_app
start_app HIDS_BASIC_AUTH_PASSWORD="$PASSWD" || exit 1
c=$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' "$BASE/api/data/inventory")
[ "$c" = 401 ] && ok "启用了 Basic：无凭据 inventory → 401" || bad "无凭据 inventory 回 $c"
c=$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' -u admin:"$PASSWD" "$BASE/api/data/inventory")
[ "$c" = 200 ] && ok "admin 凭据 inventory → 200" || bad "admin 凭据回 $c"
c=$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/data/cleanup" -H 'Content-Type: application/json' -d '{"kind":"cases","keep":0}')
[ "$c" = 401 ] && ok "启用了 Basic：无凭据 cleanup → 401（防误删第一层）" || bad "无凭据 cleanup 回 $c"
c=$(curl --max-time 5 -s -o /tmp/t034-post-body -w '%{http_code}' -u admin:"$PASSWD" -X POST "$BASE/api/data/cleanup" -H 'Content-Type: application/json' -d '{"kind":"cases","keep":0}')
[ "$c" = 200 ] && ok "admin 凭据 cleanup → 200" || bad "admin cleanup 回 $c / $(cat /tmp/t034-post-body)"

# ---------- 5) 收尾：不碰真实全局根 ----------
echo "  log error 行数：$(grep -c '"level":"error"' "$LOG" || true)"
echo "  DATA 注入根条目：$(find "$ROOT" -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null)"
stop_app
[ "$FAIL" = 0 ] && echo "ALL PASS" || echo "FAILURES present"
exit "$FAIL"
