#!/usr/bin/env bash
# P003-T036 探针外壳（A10）：真进程 + 真 UDP + 真 HTTP，独立数据根由 mjs 里的 mkdtemp 提供。
# 超时上界 180s（timeout 命令）；退出码 0 = 负载段与空闲段全过。
set -u
cd "$(dirname "$0")/../../.." || exit 1
timeout --signal=KILL 180 node evidence/test/P003-T036/probe-queue-reliability.mjs
