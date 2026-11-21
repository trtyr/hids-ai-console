#!/usr/bin/env bash
# P003-T048 收尾：删掉 2026-11-19 现场测试写在 24.21 上的 /tmp/hids-live-test.jsp。
# 用法：bash scripts/cleanup-live-test-jsp.sh [user@host]
# 默认 ct@192.168.24.21（现场测试用的账号）。先列目录、再删、再列，两份清单写进 evidence/recon/。
# 不可达就非 0 退出，不产生「已清理」的假记录。
set -euo pipefail

HOST="${1:-ct@192.168.24.21}"
TARGET=/tmp/hids-live-test.jsp
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/evidence/recon/P003-T048-cleanup-$STAMP.txt"

{
  echo "# P003-T048 cleanup  host=$HOST  target=$TARGET  at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## before"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "ls -la /tmp | grep -F 'hids-live-test' || echo '(no such file)'"
  echo
  echo "## remove"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "rm -f '$TARGET' && echo removed"
  echo
  echo "## after"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "ls -la /tmp | grep -F 'hids-live-test' || echo '(no such file)'"
} | tee "$OUT"

echo "证据已写入：$OUT"
