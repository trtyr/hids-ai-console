#!/usr/bin/env bash
# P003-T037 负载探针入口：独立数据根 / 无固定 sleep / 超时上界 / 负载全绿。
#
# 独立数据根：HIDS_DATA_DIR / HIDS_WIKI_DIR / HIDS_CASES_DIR 全部指到 mktemp 目录，
#   跑前跑后比对工作树的未跟踪文件与 .data、wiki 清单——探针不许往仓里写一个字节。
# 无固定 sleep：等待全走 probe-load.mjs 里的 waitUntil（谓词 + 截止时间），shell 里没有 sleep。
# 超时上界：整支脚本 timeout 120s，每段负载在 mjs 里另有 30s 上界。
#
# 跑法：bash evidence/test/P003-T037/probe-load.sh
# 退出码 0 = 全绿；非 0 = 有负载红 / 超时 / 污染工作树。
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT=$(pwd)
RUN=$(mktemp -d /tmp/p37-probe-XXXXXX)
cleanup() { rm -rf "$RUN"; }
trap cleanup EXIT

# 工作树指纹：未跟踪/已改文件 + 两个运行态目录的文件清单与内容摘要。
manifest() {
  {
    git status --porcelain
    [ -d .data ] && find .data -type f -exec sha1sum {} + | sort
    [ -d wiki ] && find wiki -type f -name '*.md' -exec sha1sum {} + | sort
  } | sha1sum
}

BEFORE=$(manifest)
timeout 120 env \
  HIDS_DATA_DIR="$RUN/data" \
  HIDS_WIKI_DIR="$RUN/wiki" \
  HIDS_CASES_DIR="$RUN/cases" \
  HIDS_TRIAGE_CONCURRENCY=4 \
  HIDS_TRIAGE_QUEUE_MAX=64 \
  node evidence/test/P003-T037/probe-load.mjs
code=$?
AFTER=$(manifest)

if [ "$BEFORE" != "$AFTER" ]; then
  echo "✖ 探针污染了工作树（独立数据根失效）" >&2
  echo "  before=$BEFORE" >&2
  echo "  after=$AFTER" >&2
  exit 1
fi
if [ "$code" -ne 0 ]; then
  echo "✖ 负载探针未全绿（退出码 $code）" >&2
  exit "$code"
fi
echo "✔ 工作树未被写入（before=after=$BEFORE）"
echo "✔ 运行根=$RUN（已清理）"
