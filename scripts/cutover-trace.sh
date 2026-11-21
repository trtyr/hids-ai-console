#!/bin/bash
# 迁移批 1（trace 上下文）切换脚本（P003-T075 批 1）。
# 前提：三个新文件已就位（src/contexts/trace/{domain,application,infrastructure}）。
# 动作：全仓 import 换路径 → 删旧 trace-board.js → 跑 trace 相关测试 → 全量单测。
# 回滚：git checkout HEAD -- . && git clean -fd src/contexts/trace
set -e
cd "$(dirname "$0")/.."

echo "== 1) server.js 与单测换 import =="
sed -i "s|from './trace-board.js'|from './src/contexts/trace/application/trace-service.js'|g" server.js trace-board.test.js

echo "== 2) evidence 测试换 import（TraceBoardService 走 application；seed 走 domain）=="
for f in $(grep -rl "trace-board\.js" evidence --include='*.test.js' 2>/dev/null); do
  # 先看这个文件 import 了哪些符号
  symbols=$(grep -oE "import \{[^}]+\} from '[^']*trace-board\.js'" "$f" | head -1 | sed "s/import {//; s/}.*//; s/ //g" | tr ',' '\n')
  if echo "$symbols" | grep -q "TraceBoardService" && [ "$(echo "$symbols" | grep -vc TraceBoardService)" -gt 0 ]; then
    # 混合导入：拆成两行
    other=$(echo "$symbols" | grep -v "^TraceBoardService$" | paste -sd, -)
    sed -i "s|import { $other, TraceBoardService } from '\(\([^']*\)\)trace-board\.js'|import { TraceBoardService } from '\1src/contexts/trace/application/trace-service.js';\nimport { $other } from '\1src/contexts/trace/domain/board.js'|; s|import { TraceBoardService, $other } from '\(\([^']*\)\)trace-board\.js'|import { TraceBoardService } from '\1src/contexts/trace/application/trace-service.js';\nimport { $other } from '\1src/contexts/trace/domain/board.js'|" "$f"
  elif echo "$symbols" | grep -q "TraceBoardService"; then
    sed -i "s|from '\(\.\./\)*trace-board\.js'|from '\1src/contexts/trace/application/trace-service.js'|" "$f"
  else
    sed -i "s|from '\(\(\.\./\)*\)[a-z./]*trace-board\.js'|from '\1src/contexts/trace/domain/board.js'|" "$f"
  fi
  echo "  updated: $f ($(echo "$symbols" | tr '\n' ' '))"
done

echo "== 3) 删旧文件 =="
rm trace-board.js

echo "== 4) 残留检查 =="
leftover=$(grep -rn "trace-board\.js" --include='*.js' server.js *.test.js evidence 2>/dev/null | grep -v "src/" || true)
if [ -n "$leftover" ]; then echo "残留引用（需手工处理）:"; echo "$leftover"; exit 1; fi

echo "== 5) 测试 =="
node --test trace-board.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖" | head -6
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" 
echo "== 批 1 切换完成 =="
