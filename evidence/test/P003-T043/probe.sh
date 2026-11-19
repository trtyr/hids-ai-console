#!/usr/bin/env bash
# P003-T043 A6 探针入口：独立数据根 / 真进程 + 替身 / 工作树指纹前后比对 / 超时上界。
#
# 独立数据根：HIDS_DATA_DIR / HIDS_CASES_DIR 指到 mktemp 目录（判据库跟着落 <HIDS_DATA_DIR>/wiki——不设
#   HIDS_WIKI_DIR，否则整库不种子，见 wiki-store.js:427-429），跑前跑后比对
#   工作树指纹（git status + wiki 页摘要 + 无 .data/）——探针不许往仓库里写一个字节。
# 超时上界：整支脚本 timeout 180s，mjs 内部每个等待都是「谓词 + 截止次数」，没有裸 sleep 轮询无限等。
#
# 跑法：bash evidence/test/P003-T043/probe.sh
# 退出码 0 = 全绿；非 0 = 有断言红 / 超时 / 污染工作树。
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
RUN=$(mktemp -d /tmp/t043-probe-XXXXXX)
cleanup() { rm -rf "$RUN"; }
trap cleanup EXIT

# 工作树指纹：已跟踪文件的改动 + 运行态残留 + 仓内 wiki 种子摘要。
manifest() {
  {
    git status --porcelain
    [ -d .data ] && find .data -type f -exec sha1sum {} + | sort
    find wiki -type f -name '*.md' -exec sha1sum {} + | sort
  } | sha1sum
}

BEFORE=$(manifest)
timeout 180 env \
  PROBE_RUN="$RUN" \
  HIDS_DATA_DIR="$RUN/data" \
  HIDS_CASES_DIR="$RUN/cases" \
  node evidence/test/P003-T043/probe.mjs
code=$?
AFTER=$(manifest)

if [ "$BEFORE" != "$AFTER" ]; then
  echo "✖ 探针污染了工作树（独立数据根失效）" >&2
  echo "  before=$BEFORE" >&2
  echo "  after =$AFTER" >&2
  git status --porcelain >&2
  exit 2
fi

if [ "$code" -ne 0 ]; then
  echo "✖ 探针有断言红（退出码 $code）" >&2
  exit "$code"
fi

echo "✔ 工作树指纹未变（独立数据根生效）：$BEFORE"
echo "✔ P003-T043 A6 探针通过"
