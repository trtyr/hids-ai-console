#!/usr/bin/env bash
# P003-T057 测试席验收脚本（黑盒：只按 docs/modules/prompt-store.md 的承诺验证行为，不读产品代码内容）
# 用法：bash evidence/test/P003-T057/tester-acceptance.sh
# 每条外部命令都带 timeout；临时目录落在 /tmp/t057-*，跑完可删。
set -u
TREE="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$TREE" || exit 1
GATE="/home/trtyr/.pi/agent/extensions/group-chat"

echo "=== TREE: $TREE"
echo "=== HEAD: $(git rev-parse --short HEAD)  BASE: $(git rev-parse --short 3d68055)"

echo
echo "=== A1 残留扫描：页面上不得再有「6 个核心」「21 个章节」等旧口径 ==="
timeout 60 grep -nE "6 个核心|六个核心|6 个 Markdown|21 个章节|21 个键|22 次|顶层 23|deabe4abb842db81|9bf6e567ce73b60d|11182|12083|37680" docs/modules/prompt-store.md
echo "grep EXIT=$?（1 = 无残留）"

echo
echo "=== A1 键列与实跑：coreFiles 键数 + load() 公开输出 ==="
timeout 120 node -e "
import('./prompt-store.js').then(async m => {
  const a = await new m.PromptStore().load();
  console.log('core keys:', Object.keys(a.prompts).join(','));
  console.log('core count:', Object.keys(a.prompts).length);
  console.log('scenario cards:', a.scenarios.cards.length);
  console.log('sop ids:', Object.keys(a.sop).join(','));
  console.log('sop count:', Object.keys(a.sop).length);
  console.log('version:', a.version, '| revision:', a.revision);
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
echo "EXIT=$?"

echo
echo "=== A2 章节数：snapshot().sections 与算式 7+13+2 ==="
timeout 120 node -e "
import('./prompt-store.js').then(async m => {
  const s = await new m.PromptStore().snapshot();
  const keys = Object.keys(s.sections);
  const core = keys.filter(k=>!k.includes(':'));
  const scen = keys.filter(k=>k.startsWith('scenario:'));
  const sop  = keys.filter(k=>k.startsWith('sop:'));
  console.log('sections:', keys.length, '| core:', core.length, 'scenario:', scen.length, 'sop:', sop.length,
              '| 算式:', core.length+scen.length+sop.length, '| knowledge_revision:', s.knowledge_revision);
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
echo "EXIT=$?"

echo
echo "=== A2/§6.2 边界：22 真键装上 / 22 键改名拒 / 21 键拒 ==="
rm -rf /tmp/t057-acc && mkdir -p /tmp/t057-acc
timeout 120 node -e "
import('node:fs/promises').then(async fs => {
  const {PromptStore} = await import('./prompt-store.js');
  const rel = {version:'demo-x', sequence:1, title:'t', summary:'s', date:'2026-11-20', modules:[], changes:{}};
  // 正面：22 个真键
  {
    const st = new PromptStore('/tmp/t057-acc/ok.json');
    const snap = await st.snapshot(); const cur = await st.load();
    const after = await st.install({...snap.sections}, rel, cur.revision, snap.knowledge_revision);
    const raw = JSON.parse(await fs.readFile('/tmp/t057-acc/ok.json','utf8'));
    console.log('正面 22 真键 => version:', after.version, '| 顶层键数:', Object.keys(raw).length, '| _history:', raw._history.length);
  }
  // 边界1：22 个键全改名（键数不变）
  {
    const st = new PromptStore('/tmp/t057-acc/renamed.json');
    const snap = await st.snapshot(); const cur = await st.load();
    const renamed = Object.fromEntries(Object.keys(snap.sections).map((k,i)=>['other:'+i,'正文']));
    try { await st.install(renamed, rel, cur.revision, snap.knowledge_revision); console.log('边界1 22 键改名 => 装上了（与文档不符）'); }
    catch(e){ console.log('边界1 22 键改名 => Error | status:', e.status, '| message:', e.message); }
  }
  // 边界2：少一个（21 个真键）
  {
    const st = new PromptStore('/tmp/t057-acc/miss.json');
    const snap = await st.snapshot(); const cur = await st.load();
    const cut = {...snap.sections}; delete cut[Object.keys(cut)[0]];
    try { await st.install(cut, rel, cur.revision, snap.knowledge_revision); console.log('边界2 21 键 => 装上了（与文档不符）'); }
    catch(e){ console.log('边界2 21 键 => Error | status:', e.status, '| message:', e.message); }
  }
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
echo "EXIT=$?"

echo
echo "=== A3 读盘次数：strace 数 openat，不读源码 ==="
rm -rf /tmp/t057-strace && mkdir -p /tmp/t057-strace
HIDS_PROMPT_STORE_FILE=/tmp/t057-strace/prompt-overrides.json timeout 180 strace -f -e trace=openat -o /tmp/t057-strace/trace.txt \
  node -e "import('./prompt-store.js').then(async m => { const a = await new m.PromptStore().load(); console.log('revision:', a.revision); });"
echo "strace EXIT=$?"
echo "--- 读盘明细（各一次）---"
grep -oE '"[^"]*(prompts/[^"]*\.(md|json)|wiki/[^"]*\.md|prompt-overrides\.json)"' /tmp/t057-strace/trace.txt | sort -u
echo "--- 读盘总次数 ---"
grep -oE '"[^"]*(prompts/[^"]*\.(md|json)|wiki/[^"]*\.md|prompt-overrides\.json)"' /tmp/t057-strace/trace.txt | sort -u | wc -l
echo "--- 分类计数（core / scenarios / 仓内 SOP / 判据库 SOP / 覆盖文件）---"
L=/tmp/t057-strace/list.txt
grep -oE '"[^"]*(prompts/[^"]*\.(md|json)|wiki/[^"]*\.md|prompt-overrides\.json)"' /tmp/t057-strace/trace.txt | sort -u > "$L"
c_core=$(grep -c 'prompts/[a-z-]*\.md"$' "$L")
c_scen=$(grep -c 'prompts/scenarios\.json"$' "$L")
c_soprepo=$(grep -c 'prompts/sop/' "$L")
c_sopwiki=$(grep -c '/wiki/' "$L")
c_ov=$(grep -c 'prompt-overrides\.json"$' "$L")
echo "core=$c_core scenarios=$c_scen sop(仓内)=$c_soprepo sop(判据库)=$c_sopwiki override=$c_ov 合计=$((c_core+c_scen+c_soprepo+c_sopwiki+c_ov))"

echo
echo "=== A3 章节数字段：metadata() 字数合计 39802 = 13177 + 14415 + 12210 ==="
timeout 120 node -e "
import('./prompt-store.js').then(async m => {
  const md = await new m.PromptStore().metadata();
  const sum = k => md.sections.filter(x=>x.kind===k).reduce((a,b)=>a+b.characters,0);
  const cnt = k => md.sections.filter(x=>x.kind===k).length;
  console.log('core:', cnt('core'), sum('core'), '| scenario:', cnt('scenario'), sum('scenario'), '| sop:', cnt('sop'), sum('sop'));
  console.log('合计:', sum('core')+sum('scenario')+sum('sop'), '(页面写 39802)');
}).catch(e=>{console.error('ERR',e);process.exit(1)});
"
echo "EXIT=$?"

echo
echo "=== 页面自带脚本逐字复跑（§5.3 键序 / §5.4 复算 / §6.4 安装）==="
timeout 120 node -e "
import('node:crypto').then(async ({createHash}) => {
  const {PromptStore} = await import('./prompt-store.js');
  const sha16 = o => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,16);
  const a = await new PromptStore().load();
  const base = {prompts:a.prompts, scenarios:a.scenarios, sop:a.sop, release:null};
  const swapped = {...base, scenarios: Object.fromEntries(Object.entries(a.scenarios).reverse())};
  console.log('§5.3 原序:', sha16(base), '| 倒序:', sha16(swapped), '| 相同:', sha16(base) === sha16(swapped));
  const recomputed = sha16(base);
  console.log('§5.4 复算:', recomputed, '| 上报:', a.revision, '| 一致:', recomputed === a.revision);
});
"
echo "EXIT=$?"

echo
echo "=== A4 门禁：改前（3d68055 导出树）/ 改后（本树） ==="
rm -rf /tmp/t057-base-check && mkdir -p /tmp/t057-base-check
git archive 3d68055 | tar -x -C /tmp/t057-base-check
echo "--- 改前基线树里旧口径确认（应有输出）---"
timeout 60 grep -cE "6 个核心提示词|21 个章节" /tmp/t057-base-check/docs/modules/prompt-store.md
echo "--- 改前 ---"
cd "$GATE" && timeout 300 node gate/gate-cli.js docs --cwd /tmp/t057-base-check
echo "改前 EXIT=$?"
echo "--- 改后 ---"
timeout 300 node gate/gate-cli.js docs --cwd "$TREE"
echo "改后 EXIT=$?"
cd "$TREE" || exit 1

echo
echo "=== A5 产品代码零改动 ==="
echo "--- diff --name-only 3d68055..HEAD ---"
git diff --name-only 3d68055..HEAD
echo "--- 只点了 js/web/prompts/package/openapi ---"
git diff --name-only 3d68055..HEAD -- '*.js' 'web/*' 'prompts/*' 'package.json' 'openapi.yaml'
echo "代码面 EXIT=$?（无输出即零改动）"

echo
echo "=== 附：全套单测 ==="
timeout 600 npm test 2>&1 | tail -8
echo "npm test EXIT=${PIPESTATUS[0]}"
