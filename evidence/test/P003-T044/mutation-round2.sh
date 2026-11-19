#!/usr/bin/env bash
# P003-T044 补测轮的变异自证（2026-11-20，测试席 reject_test 打回后补）。
#
# 做事：把工作树复制到 /tmp，按 docs/modules/http-api.md §3.7 / §4 的原话**改实现副本**，再跑同一份用例；
# 每条变异都必须把「它对应的那几条新断言」打红（exit != 0，且红的是预期用例）。工作树的实现一行不动。
#
# 跑法：bash evidence/test/P003-T044/mutation-round2.sh
# 输出：每条一行 MUTATION <编号> … 后面跟红掉的测试名；最后一行汇总。
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TEST=evidence/test/P003-T044/data-admin.test.js
WORK=$(mktemp -d /tmp/t044-mut.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# 变异锚点：在副本里把 old 换成 new，锚点必须恰好命中一次（命中 0 次或多次＝脚本自己错了，直接失败）。
mutate() { # $1=副本目录 $2=相对文件 $3=old $4=new
  python3 - "$1/$2" "$3" "$4" <<'PY'
import pathlib, sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text()
hits = text.count(old)
assert hits == 1, f'锚点命中 {hits} 次（要 1 次）：{old[:70]!r}'
pathlib.Path(path).write_text(text.replace(old, new))
PY
}

fresh() { # $1=样例目录名；复制工作树（不带 .git / web / evidence），只带本文件这一份用例
  local dir="$WORK/$1"
  rsync -a --quiet --exclude .git --exclude web --exclude evidence --exclude '*.tmp' "$ROOT/" "$dir/"
  mkdir -p "$dir/evidence/test/P003-T044"
  cp "$ROOT/$TEST" "$dir/$TEST"
  printf '%s' "$dir"
}

reds=0
case_no=0
run_case() { # $1=副本目录 $2=编号 $3=变异说明（文档原话） $4=期望变红的用例名片段
  local dir=$1 id=$2 what=$3 expect=$4 out code failed detail
  out=$(cd "$dir" && node --test --test-timeout=60000 "$TEST" 2>&1)
  code=$?
  failed=$(printf '%s\n' "$out" | grep '^✖ ' | grep -v 'failing tests:' | sed -E 's/^✖ //; s/ \([0-9.]+ms\)$//' | awk '!seen[$0]++' | paste -sd '；' -)
  # 红在哪条断言上：Spec 输出里失败块的第一行 + actual/expected
  detail=$(printf '%s\n' "$out" | grep -m1 -A3 -E '^  (AssertionError|Error|TypeError)' | tr '\n' ' ' | sed -E 's/ +/ /g' | cut -c1-260)
  if [ $code -eq 0 ]; then
    echo "MUTATION $id ✗ 没红（变异存活）—— $what"
    reds=$((reds + 1))
    return
  fi
  case_no=$((case_no + 1))
  if printf '%s' "$failed" | grep -q "$expect"; then
    echo "MUTATION $id ✓ 红：$failed"
    echo "    断言：$detail"
    echo "    变异：$what"
  else
    echo "MUTATION $id ? 红了但不是预期用例：$failed —— $what"
    reds=$((reds + 1))
  fi
}

# ── 401（docs/modules/http-api.md:506 的四条头与正文；:498 的闸门在第一行）──────────────
dir=$(fresh m1); mutate "$dir" server.js "res.end('需要登录后访问')" "res.end('请登录')"
run_case "$dir" 1 "401 正文不是「需要登录后访问」" '鉴权'

dir=$(fresh m2); mutate "$dir" server.js "'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control'" "'Cache-Control'"
run_case "$dir" 2 "401 少了 Content-Type: text/plain; charset=utf-8" '鉴权'

dir=$(fresh m3); mutate "$dir" server.js "if (!hasAccess(req, access)) {" "if (false) {"
run_case "$dir" 3 "闸门失效（无凭据也放行）" '鉴权'

# 闸门挪到清理之后：401 照样回，但盘已经被动过——专打「被拒的清理一个字节没动盘」这条
dir=$(fresh m4); mutate "$dir" server.js "if (!hasAccess(req, access)) {" "if (!hasAccess(req, access) && req.method !== 'POST') {"
mutate "$dir" server.js "        try { return json(res, 200, await dataCleanup(dataDeps, await readJSON(req))); }" "        try { const outcome = await dataCleanup(dataDeps, await readJSON(req));
          if (!hasAccess(req, access)) return requireAccess(res);
          return json(res, 200, outcome); }"
run_case "$dir" 4 "闸门排在清理之后（401 但盘已动）" '鉴权'

# ── 清理响应回显（DataCleanupResult：kind / threshold.older_than 原样 / threshold.keep / items[].at）──
dir=$(fresh m5); mutate "$dir" server.js "return { dry_run: !execute, kind: body.kind, action," "return { dry_run: !execute, kind: 'cases', action,"
run_case "$dir" 5 "kind 不回显请求值" '回显'

dir=$(fresh m6); mutate "$dir" server.js "threshold: { older_than: body.older_than ?? null, keep }," "threshold: { older_than: olderThan == null ? null : new Date(olderThan).toISOString(), keep },"
run_case "$dir" 6 "older_than 被规范化成 UTC 标准形（不是原样回显）" '回显'

dir=$(fresh m7); mutate "$dir" server.js "threshold: { older_than: body.older_than ?? null, keep }," "threshold: { older_than: body.older_than ?? null, keep: null },"
run_case "$dir" 7 "keep 不回显请求值" '回显'

dir=$(fresh m8); mutate "$dir" server.js "items: chosen.slice(0, DATA_CANDIDATE_LIMIT).map(entry => ({ name: entry.name, bytes: entry.bytes, at: isoOrNull(entry.at) }))," "items: chosen.slice(0, DATA_CANDIDATE_LIMIT).map(entry => ({ name: entry.name, bytes: entry.bytes, at: null })),"
run_case "$dir" 8 "文件类候选条目丢了 at" '回显'

dir=$(fresh m9); mutate "$dir" triage-monitor.js "at: record.updated_at || record.saved_at || record.created_at || null," "at: null,"
run_case "$dir" 9 "队列候选条目丢了 at" '队列只清 done'

# ── 盘点时刻（DataInventory：oldest_at 取最小、newest_at 取最大；没有条目为 null）──────
dir=$(fresh m10); mutate "$dir" server.js "oldest_at: isoOrNull(ats.length ? Math.min(...ats) : null), newest_at: isoOrNull(ats.length ? Math.max(...ats) : null) };" "oldest_at: null, newest_at: null };"
mutate "$dir" server.js "oldestAt: stamps[0] ?? null, newestAt: stamps[stamps.length - 1] ?? null };" "oldestAt: null, newestAt: null };"
run_case "$dir" 10 "七类 newest_at/oldest_at 恒 null" '盘点七类'

dir=$(fresh m11); mutate "$dir" server.js "oldest_at: isoOrNull(ats.length ? Math.min(...ats) : null), newest_at: isoOrNull(ats.length ? Math.max(...ats) : null) };" "oldest_at: isoOrNull(ats.length ? Math.max(...ats) : null), newest_at: isoOrNull(ats.length ? Math.min(...ats) : null) };"
mutate "$dir" server.js "oldestAt: stamps[0] ?? null, newestAt: stamps[stamps.length - 1] ?? null };" "oldestAt: stamps[stamps.length - 1] ?? null, newestAt: stamps[0] ?? null };"
run_case "$dir" 11 "最早/最晚取反" '盘点七类'

dir=$(fresh m12); mutate "$dir" server.js "const isoOrNull = at => (at == null ? null : new Date(at).toISOString());" "const isoOrNull = at => (at == null ? undefined : new Date(at).toISOString());"
run_case "$dir" 12 "没有条目时不是 null（字段整个消失）" '空运行态'

# ── 队列 delete 整对象（docs/modules/http-api.md:261：从内存与队列文件里删掉）──────────
dir=$(fresh m13); mutate "$dir" triage-monitor.js "    for (const record of records) {
      this.dropRecord(record.alert_id);
      this.pendingCounts.delete(record.alert_id);
    }" "    if (action === 'archive') for (const record of records) {
      this.dropRecord(record.alert_id);
      this.pendingCounts.delete(record.alert_id);
    }"
run_case "$dir" 13 "delete 没把记录移出内存/落盘" '队列只清 done'

# 只让非 cases 类报 null：pre-existing 的 cases 断言保持绿，红的只能是本轮补的那几条（证明新断言自己是活的）
dir=$(fresh m14); mutate "$dir" server.js "oldest_at: isoOrNull(ats.length ? Math.min(...ats) : null), newest_at: isoOrNull(ats.length ? Math.max(...ats) : null) };" "oldest_at: store.kind === 'cases' ? isoOrNull(ats.length ? Math.min(...ats) : null) : null, newest_at: store.kind === 'cases' ? isoOrNull(ats.length ? Math.max(...ats) : null) : null };"
run_case "$dir" 14 "除 cases 外的六类时刻恒 null（cases 的老断言仍绿）" '盘点七类'

# 只有 queue.newest_at 变 null：queue.oldest_at 的老断言仍绿
dir=$(fresh m15); mutate "$dir" server.js "oldestAt: stamps[0] ?? null, newestAt: stamps[stamps.length - 1] ?? null };" "oldestAt: stamps[0] ?? null, newestAt: null };"
run_case "$dir" 15 "queue.newest_at 恒 null（oldest 的老断言仍绿）" '盘点七类'

# delete 把活下来的记录改了字段：内存条数仍对，落盘整对象比对才会红（专打本轮补的整对象 deepEqual）
dir=$(fresh m16); mutate "$dir" triage-monitor.js "    for (const record of records) {
      this.dropRecord(record.alert_id);" "    for (const record of this.records.values()) record.cleaned = true;
    for (const record of records) {
      this.dropRecord(record.alert_id);"
run_case "$dir" 16 "delete 顺手改了幸存记录的字段（整对象比对才会红）" '队列只清 done'

# 四条头逐条自证：WWW-Authenticate / Cache-Control / X-Content-Type-Options 各改一处
dir=$(fresh m17); mutate "$dir" server.js "'WWW-Authenticate': 'Basic realm=\"HIDS AI Console\", charset=\"UTF-8\"'," "'WWW-Authenticate': 'Basic realm=\"HIDS\"',"
run_case "$dir" 17 "WWW-Authenticate 少了 realm/charset 原文" '鉴权'

dir=$(fresh m18); mutate "$dir" server.js "'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });" "'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff' });"
run_case "$dir" 18 "401 少了 Cache-Control: no-store" '鉴权'

dir=$(fresh m19); mutate "$dir" server.js "'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });" "'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store' });"
run_case "$dir" 19 "401 少了 X-Content-Type-Options: nosniff" '鉴权'

dir=$(fresh m20); mutate "$dir" server.js "const expected = Buffer.from(\`\${access.user || 'admin'}:\${access.password}\`);" "const expected = Buffer.from(\`\${access.user || 'admin'}:\${access.password}!x\`);"
run_case "$dir" 20 "正确凭据也被拒（比对串改错）" '鉴权'

echo "MUTATION 汇总：${case_no} 条按预期红，${reds} 条不符合预期"
exit $reds
