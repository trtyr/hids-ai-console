#!/usr/bin/env bash
# P003-T057 测试席验收脚本（黑盒：只按 docs/modules/prompt-store.md 的承诺验证行为，不读产品代码内容）
#
# 用法：bash evidence/test/P003-T057/tester-acceptance.sh
# 退出码：0 = 全部断言通过；>0 = 失败断言条数。每条断言都独立计数，末尾 exit $FAILS，没有「只打印不判」的检查。
# 每条外部命令都带 timeout；临时目录落在固定路径（/tmp/t057-*），可重复跑。
# 全套单测**不放**在本脚本里（自毁防线：套件内不跑整套测试），单独一条命令见 test-report.md §5。

set -uo pipefail

TREE="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$TREE" || { echo "FATAL 进不了 $TREE"; exit 99; }
GATE="/home/trtyr/.pi/agent/extensions/group-chat"
DOC="docs/modules/prompt-store.md"
BASE="3d68055"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOKENS="$HERE/old-values.txt"
ACC="/tmp/t057-acc"
rm -rf "$ACC" && mkdir -p "$ACC"

FAILS=0
PASSED=0
pass() { PASSED=$((PASSED+1)); echo "  PASS  $*"; }
fail() { FAILS=$((FAILS+1)); echo "  FAIL  $*"; }

assert_eq() {   # label expected actual
  if [ "$2" = "$3" ]; then pass "$1 = $3"; else fail "$1 | 期望: [$2] | 实际: [$3]"; fi
}
assert_has() {  # label file needle
  if grep -qF -- "$3" "$2"; then pass "$1 含 [$3]"; else fail "$1 缺 [$3]（$2）"; fi
}
run_ok() {      # name timeout cmd...
  local name="$1" tmo="$2"; shift 2
  timeout "$tmo" "$@" > "$ACC/$name.log" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then pass "$name 命令 rc=0"; else fail "$name 命令 rc=$rc（$ACC/$name.log 末尾见下）"; tail -3 "$ACC/$name.log"; fi
  return 0
}
# 从页面里按小节标题抽出第一个 ```bash 代码块原文（逐字，不改写）
extract_block() { # heading-substring out-file
  awk -v pat="$1" '
    index($0, pat) == 1 && $0 ~ /^#{2,4} / {insec=1; next}
    insec && /^```bash/ {inblock=1; next}
    inblock && /^```/ {exit}
    inblock {print}
  ' "$DOC" > "$2"
}

echo "=== TREE: $TREE"
echo "=== HEAD: $(git rev-parse --short HEAD)  BASE: $(git rev-parse --short "$BASE" 2>/dev/null || echo 未知)"
echo "=== 判定口径：每条断言独立计数，末尾 exit \$FAILS"

# ================================================================ A1 旧口径残留
echo
echo "=== A1 旧口径残留：清单里每个词在改后页面命中数必须为 0 ==="
if [ ! -s "$TOKENS" ]; then fail "旧口径清单缺失或为空：$TOKENS"; fi

git show "$BASE:$DOC" > "$ACC/base-page.md" 2>/dev/null
if [ -s "$ACC/base-page.md" ]; then pass "改前页面已导出（$(wc -l < "$ACC/base-page.md") 行）"; else fail "取不到改前页面 $BASE:$DOC"; fi

echo "--- 3) 清单完整性自检：改前→改后被删掉的每一行，至少命中一个词 ---"
git diff "$BASE"..HEAD -- "$DOC" | grep '^-' | grep -v '^---' > "$ACC/deleted-lines.txt"
n_del=$(wc -l < "$ACC/deleted-lines.txt")
echo "  被删行数: $n_del（$ACC/deleted-lines.txt）"
uncovered=0
while IFS= read -r line; do
  hit=0
  while IFS= read -r tok; do
    case "$tok" in ''|'#'*) continue ;; esac
    if printf '%s\n' "$line" | grep -qF -- "$tok"; then hit=1; break; fi
  done < "$TOKENS"
  if [ "$hit" -eq 0 ]; then uncovered=$((uncovered+1)); echo "  漏覆盖的被删行: $line"; fi
done < "$ACC/deleted-lines.txt"
assert_eq "A1 清单漏覆盖的被删行数" 0 "$uncovered"
if [ "$n_del" -gt 0 ]; then pass "A1 确有被删行（$n_del 行），残留断言非空转"; else fail "A1 改前→改后没删任何行"; fi

echo "--- 1) 每个词在改后页面命中 0 ---"
while IFS= read -r tok; do
  case "$tok" in ''|'#'*) continue ;; esac
  assert_eq "残留 [$tok]" 0 "$(grep -cF -- "$tok" "$DOC")"
done < "$TOKENS"

echo "--- 2) 每个词在改前页面至少命中 1 行（证断言非永真）---"
while IFS= read -r tok; do
  case "$tok" in ''|'#'*) continue ;; esac
  n=$(grep -cF -- "$tok" "$ACC/base-page.md")
  if [ "$n" -ge 1 ]; then pass "改前命中 [$tok] = $n 行"; else fail "改前也不命中 [$tok] —— 废词，断言永真"; fi
done < "$TOKENS"

# ================================================================ A1 行为
echo
echo "=== A1 公开输出：7 个核心键（含 rule）/ 13 张场景卡 / 14 条 SOP ==="
run_ok a1-load 120 node -e "
import('./prompt-store.js').then(async m => {
  const a = await new m.PromptStore().load();
  console.log('core keys:', Object.keys(a.prompts).join(','));
  console.log('core count:', Object.keys(a.prompts).length);
  console.log('scenario cards:', a.scenarios.cards.length);
  console.log('sop count:', Object.keys(a.sop).length);
  console.log('version:', a.version);
  console.log('revision:', a.revision);
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
assert_has "A1" "$ACC/a1-load.log" "core keys: triage,deep,trace,knowledge,knowledge_reuse,cross,rule"
assert_has "A1" "$ACC/a1-load.log" "core count: 7"
assert_has "A1" "$ACC/a1-load.log" "scenario cards: 13"
assert_has "A1" "$ACC/a1-load.log" "sop count: 14"
assert_has "A1" "$ACC/a1-load.log" "version: merged-three-state-2026-11-06"
assert_has "A1" "$ACC/a1-load.log" "revision: 065221c4b66f7660"
assert_has "A1 页面 §3.1 键列" "$DOC" '`cross` / `rule`'
assert_has "A1 页面 §4.2 键列" "$DOC" '`knowledge_reuse`、`cross`、`rule`'

# ================================================================ A2 章节数
echo
echo "=== A2 章节数 22 = 7 核心 + 13 场景 + 2 SOP ==="
run_ok a2-snapshot 120 node -e "
import('./prompt-store.js').then(async m => {
  const s = await new m.PromptStore().snapshot();
  const keys = Object.keys(s.sections);
  const core = keys.filter(k=>!k.includes(':'));
  const scen = keys.filter(k=>k.startsWith('scenario:'));
  const sop  = keys.filter(k=>k.startsWith('sop:'));
  console.log('sections:', keys.length, '| core:', core.length, '| scenario:', scen.length, '| sop:', sop.length,
              '| 算式:', core.length+scen.length+sop.length);
  console.log('knowledge_revision 形态:', /^[0-9a-f]{16}$/.test(s.knowledge_revision) ? 'hex16' : 'BAD:'+s.knowledge_revision);
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
assert_has "A2" "$ACC/a2-snapshot.log" "sections: 22 | core: 7 | scenario: 13 | sop: 2 | 算式: 22"
assert_has "A2" "$ACC/a2-snapshot.log" "knowledge_revision 形态: hex16"
assert_has "A2 页面 §6.1 算式" "$DOC" "22 个章节名（7 核心 + 13 场景 + 2 SOP）"
assert_has "A2 页面 §10 章节数" "$DOC" "| 章节数 | 22（7 核心 + 13 场景 + 2 SOP） |"

echo
echo "=== A2 字数：metadata() 合计 39802 = 13177 + 14415 + 12210 ==="
run_ok a2-metadata 120 node -e "
import('./prompt-store.js').then(async m => {
  const md = await new m.PromptStore().metadata();
  const sum = k => md.sections.filter(x=>x.kind===k).reduce((a,b)=>a+b.characters,0);
  const cnt = k => md.sections.filter(x=>x.kind===k).length;
  console.log('core:', cnt('core'), sum('core'), '| scenario:', cnt('scenario'), sum('scenario'), '| sop:', cnt('sop'), sum('sop'));
  console.log('合计:', sum('core')+sum('scenario')+sum('sop'));
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
assert_has "A2 字数" "$ACC/a2-metadata.log" "core: 7 13177 | scenario: 13 14415 | sop: 14 12210"
assert_has "A2 字数" "$ACC/a2-metadata.log" "合计: 39802"
assert_has "A2 页面字数" "$DOC" "核心 13177 + 场景 14415 + SOP 12210"

# ================================================================ A3 读盘次数
echo
echo "=== A3 一次 load() 读盘 23 次：固定数据根、先种子后 trace、只数 readFile 目标路径 ==="
A3ROOT="/tmp/t057-a3"
rm -rf "$A3ROOT" && mkdir -p "$A3ROOT/data"
export HIDS_DATA_DIR="$A3ROOT/data"
export HIDS_PROMPT_STORE_FILE="$A3ROOT/prompt-overrides.json"
# 第一步：不 trace 地跑一次 load()，把判据库种子到固定数据根（否则空库会先种子，数出 391）
run_ok a3-seed 180 node -e "import('./prompt-store.js').then(async m=>{const a=await new m.PromptStore().load();console.log('seed revision:',a.revision)})"
assert_has "A3 种子" "$ACC/a3-seed.log" "seed revision: 065221c4b66f7660"
assert_eq "A3 数据根已种子（wiki 目录存在）" yes "$([ -d "$A3ROOT/data/wiki" ] && echo yes || echo no)"
# 覆盖文件写成 {}，让 23 次读盘全部成功（不留 ENOENT 噪声）
printf '{}\n' > "$HIDS_PROMPT_STORE_FILE"
# 第二步：trace 第二次 load()
run_ok a3-trace 180 strace -f -e trace=openat -o "$A3ROOT/trace.txt" \
  node -e "import('./prompt-store.js').then(async m=>{const a=await new m.PromptStore().load();console.log('traced revision:',a.revision)})"
assert_has "A3 traced" "$ACC/a3-trace.log" "traced revision: 065221c4b66f7660"
unset HIDS_DATA_DIR HIDS_PROMPT_STORE_FILE

PAT='"[^"]*(/prompts/[^"]*\.(md|json)|/data/wiki/[^"]*\.md|prompt-overrides\.json)"'
L="$A3ROOT/targets.txt"
grep -oE "$PAT" "$A3ROOT/trace.txt" > "$L" || true
assert_eq "A3 目标路径 openat 总次数" 23 "$(wc -l < "$L")"
assert_eq "A3 目标路径唯一数（=总次数，无重复读）" 23 "$(sort -u "$L" | wc -l)"
assert_eq "A3 目标路径打开失败（ENOENT）数" 0 "$(grep -cE "$PAT.*= -1" "$A3ROOT/trace.txt" || true)"
assert_eq "A3 目标路径全是只读 openat（O_RDONLY）" 23 "$(grep -E "$PAT" "$A3ROOT/trace.txt" | grep -cE "O_RDONLY")"
assert_eq "A3 目标路径含写标志（O_WRONLY/O_CREAT/O_TRUNC）的 openat 数" 0 "$(grep -E "$PAT" "$A3ROOT/trace.txt" | grep -cE "O_WRONLY|O_CREAT|O_TRUNC" || true)"
c_core=$(grep -cE '/prompts/[a-z-]+\.md"$' "$L" || true)
c_scen=$(grep -cE '/prompts/scenarios\.json"$' "$L" || true)
c_soprepo=$(grep -cE '/prompts/sop/' "$L" || true)
c_sopwiki=$(grep -cE '/data/wiki/' "$L" || true)
c_ov=$(grep -cE '/prompt-overrides\.json"$' "$L" || true)
assert_eq "A3 分类 core（核心提示词文件）" 7 "$c_core"
assert_eq "A3 分类 scenarios.json" 1 "$c_scen"
assert_eq "A3 分类 仓内 SOP" 2 "$c_soprepo"
assert_eq "A3 分类 判据库 SOP" 12 "$c_sopwiki"
assert_eq "A3 分类 覆盖文件" 1 "$c_ov"
assert_eq "A3 分类合计" 23 "$((c_core+c_scen+c_soprepo+c_sopwiki+c_ov))"
assert_has "A3 页面 §10 读盘数" "$DOC" '| 一次 `load()` 的读盘次数 | 23 次 `readFile`：7 个核心文件 + `scenarios.json` + 14 份 SOP + 1 份覆盖文件 |'

# ================================================================ A4 门禁
echo
echo "=== A4 门禁：改前（$BASE 导出树）/ 改后（本树）均 ok=true violations=[] ==="
BASE_TREE="/tmp/t057-base-check"
rm -rf "$BASE_TREE" && mkdir -p "$BASE_TREE"
run_ok a4-export 120 bash -c "git archive $BASE | tar -x -C $BASE_TREE"
assert_eq "A4 改前基线树确为旧口径（命中行数）" 12 "$(grep -cE '6 个核心提示词|21 个章节' "$BASE_TREE/$DOC")"
run_ok a4-gate-base 300 node "$GATE/gate/gate-cli.js" docs --cwd "$BASE_TREE"
assert_has "A4 改前门禁 ok" "$ACC/a4-gate-base.log" '"ok":true'
assert_has "A4 改前门禁 violations 空" "$ACC/a4-gate-base.log" '"violations":[]'
run_ok a4-gate-head 300 node "$GATE/gate/gate-cli.js" docs --cwd "$TREE"
assert_has "A4 改后门禁 ok" "$ACC/a4-gate-head.log" '"ok":true'
assert_has "A4 改后门禁 violations 空" "$ACC/a4-gate-head.log" '"violations":[]'

# ================================================================ A5 代码面 + 页面脚本逐字
echo
echo "=== A5 产品代码零改动 ==="
git diff --name-only "$BASE"..HEAD > "$ACC/a5-all.txt"
git diff --name-only "$BASE"..HEAD -- '*.js' 'web/*' 'prompts/*' 'package.json' 'openapi.yaml' > "$ACC/a5-code.txt"
echo "--- 本卡改动面 ---"; cat "$ACC/a5-all.txt"
assert_eq "A5 代码面改动文件数" 0 "$(wc -l < "$ACC/a5-code.txt")"
assert_eq "A5 改动面只落在 docs/ coding-reports/ evidence/" 0 "$(grep -vcE '^(docs/|coding-reports/|evidence/)' "$ACC/a5-all.txt" || true)"

echo
echo "=== A5 页面自带脚本逐字复跑（从页面抠出来直接 bash 跑，不改写）==="
for spec in "3.1 三处来源" "5.3 指纹会变什么" "5.4 复算命令" "6.4 实测" "4.3 改写单个章节"; do
  sec="${spec%% *}"; head="### $sec"
  out="$ACC/page-$sec.sh"
  extract_block "$head" "$out"
  assert_eq "页面 §$sec 代码块已抽出（行数 >0）" yes "$([ -s "$out" ] && echo yes || echo no)"
  run_ok "page-$sec" 180 bash "$out"
done
assert_has "页面 §3.1 输出" "$ACC/page-3.1.log" "core keys: triage,deep,trace,knowledge,knowledge_reuse,cross,rule"
assert_has "页面 §3.1 输出" "$ACC/page-3.1.log" "revision: 065221c4b66f7660"
assert_has "页面 §5.3 输出" "$ACC/page-5.3.log" "原序: 065221c4b66f7660 | 倒序: 9da15df422ed3b7d | 相同: false"
assert_has "页面 §5.4 输出" "$ACC/page-5.4.log" "复算: 065221c4b66f7660 | 上报: 065221c4b66f7660 | 一致: true"
assert_has "页面 §6.4 输出" "$ACC/page-6.4.log" "安装后 version: demo-2026-11-20 | revision 变了: true"
assert_has "页面 §6.4 输出" "$ACC/page-6.4.log" "文件顶层键数: 24 | _history 长度: 2"
assert_has "页面 §4.3 输出" "$ACC/page-4.3.log" "prompts.triage = 覆盖后的通用系统提示词"
assert_has "页面 §4.3 输出" "$ACC/page-4.3.log" "覆盖文件键 = triage"

# ================================================================ 边界与错误码
echo
echo "=== 边界与错误码：22 真键 / 22 改名 / 21 键 / 3×409 / 白名单 20 / SOP 拒 / 20001 字 / 非法 JSON / 空判据库 ==="
rm -rf /tmp/t057-bnd
run_ok bnd 180 node "$HERE/boundaries.mjs" /tmp/t057-bnd
B="$ACC/bnd.log"
cat "$B"
assert_has "B1 22 真键装上"       "$B" "CASE1 ok version=demo-x topkeys=24 history=2 sections=22"
assert_has "B2 22 键改名拒 400"   "$B" "CASE2 err status=400 message=升级包缺少必需章节或正文格式不正确"
assert_has "B3 21 键拒 400"       "$B" "CASE3 err status=400 message=升级包缺少必需章节或正文格式不正确"
assert_has "B4 expectedRevision 409" "$B" "CASE4 err status=409 message=当前版本已变化，请刷新后重新确认替换"
assert_has "B5 knowledgeRevision 409" "$B" "CASE5 err status=409 message=升级包与当前知识库版本不兼容"
assert_has "B6 sequence 相等 409" "$B" "CASE6 err status=409 message=不允许重复应用或降级到旧版本"
assert_has "B7 白名单 20 个全收（rule 在内）" "$B" "CASE7 ok accepted=20 whitelist_keys=20 core=7 scenario=13 rule=规则正文替换测试-rule"
assert_has "B8 SOP 键拒（无 status）" "$B" "CASE8 err status=undefined message=不支持的提示词章节"
assert_has "B9 20001 字拒（无 status）" "$B" "CASE9 err status=undefined message=提示词正文必须为 1 到 20000 字"
assert_has "B10 非法 JSON → SyntaxError" "$B" "CASE10 err name=SyntaxError status=undefined"

echo "--- B11 判据目录为空（页面 §3.3 原文逐字跑）---"
extract_block "### 3.3 装配失败的样子" "$ACC/page-3.3.sh"
assert_eq "页面 §3.3 代码块已抽出" yes "$([ -s "$ACC/page-3.3.sh" ] && echo yes || echo no)"
rm -rf /tmp/empty-wiki
run_ok page-3.3 120 bash "$ACC/page-3.3.sh"
# 只断言稳定承诺（抛 ENOENT 且指向空判据目录下某个 .md）：
# 页面 §3.3 写死的那一页（webshell/WS-13.md）不是确定输出——30 次里 26 次是它、4 次是 memwebshell/MW-08.md
# （readFile 并发，首个 rejection 决定报哪个文件）。断言写死具体页名会让套件 13% 概率假红，故不写；
# 页面这行示例输出的不稳定已记 test-report.md 的 finding（doc-side, minor）。
assert_eq "B11 空判据库抛 ENOENT 且指向空判据目录下的 .md" 1 \
  "$(grep -cE '^ENOENT /tmp/empty-wiki/[a-z-]+/[A-Za-z0-9-]+\.md$' "$ACC/page-3.3.log" || true)"
assert_has "B11 报的是 ENOENT" "$ACC/page-3.3.log" "ENOENT /tmp/empty-wiki/"

# ================================================================ 汇总
echo
echo "=== 汇总：PASS=$PASSED FAIL=$FAILS ==="
if [ "$FAILS" -ne 0 ]; then echo "=== 结论：FAIL（退出码 $FAILS）==="; else echo "=== 结论：PASS（退出码 0）==="; fi
exit "$FAILS"
