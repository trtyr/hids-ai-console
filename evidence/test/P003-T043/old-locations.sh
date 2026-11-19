#!/usr/bin/env bash
# P003-T043 A6 旧位判据（文件级）：旧数据根里不得再有 baseline.json / intel.json，仓内旧的单文件基线页不得存在。
#
# 为什么不是「目录不存在」：`../backend/.data` 是 P003-T019 负范围明写要留的旧数据根
#   （205M，mtime 2026-11-18，早于本卡全部提交），拿 `test ! -e ../backend/.data` 当删除判据
#   与那张卡的裁决相撞。所以判据落到文件级：旧根可以在，里面那两份运行态文件不许在。
#   目录级现状只在第 3 段记录，不作判据。
#
# 跑法：bash evidence/test/P003-T043/old-locations.sh
# 退出码 0 = 全部满足；非 0 = 有命中（逐条打印）。
set -u
cd "$(dirname "$0")/../../.." || exit 1
rc=0

echo "== 1) 旧数据根里的运行态文件（baseline.json / intel.json，maxdepth 3）"
for root in .data ../.data ../backend/.data "$HOME/.local/share/hids-ai-console"; do
  if [ -e "$root" ]; then
    hits=$(timeout 60 find "$root" -maxdepth 3 \( -name baseline.json -o -name intel.json \) -print 2>/dev/null)
    if [ -n "$hits" ]; then
      echo "  ✖ $root 命中："
      echo "$hits" | sed 's/^/      /'
      rc=1
    else
      echo "  ✔ $root 存在，零命中"
    fi
  else
    echo "  ✔ $root 不存在（旧位已清）"
  fi
done

echo "== 2) 仓内旧的单文件基线页"
if [ -e wiki/environment-baseline.md ]; then
  echo "  ✖ wiki/environment-baseline.md 仍存在"
  rc=1
else
  echo "  ✔ wiki/environment-baseline.md 不存在"
fi

echo "== 3) 目录级现状（只记录，不作判据；../backend/.data 属 P003-T019 负范围，不删）"
for p in .data ../.data ../backend/.data; do
  if [ -e "$p" ]; then
    echo "  · $p 存在（$(du -sh "$p" 2>/dev/null | cut -f1)）"
  else
    echo "  · $p 不存在"
  fi
done

if [ "$rc" -eq 0 ]; then
  echo "✔ A6 旧位判据（文件级）全部满足：baseline/intel 零命中"
else
  echo "✖ A6 旧位判据有命中，见上"
fi
exit "$rc"
