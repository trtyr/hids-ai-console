#!/usr/bin/env bash
# 遗留落点迁移（P003-T074）：把 T034 之前的历史运行态搬进当前数据根。
# 用法：node scripts/migrate-legacy-roots.js [--dry-run]
# 幂等：目标已存在的同名文件跳过（不覆盖）；旧位迁完仅剩空目录时删除。
import { readdirSync, existsSync, cpSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
// 数据根复用 server.js 的唯一定义（不另拼一套）
const { dataRoot } = await import(path.join(repo, 'src/shared/data-root.js'));
const target = dataRoot();

// 候选旧位：仓内 .data/ 与更早的 <上一级>/backend/.data/（P003-T034 A4 记录的两处）
const legacyRoots = [path.join(repo, '.data'), path.resolve(repo, '..', 'backend', '.data')]
  .filter(existsSync);

let copied = 0, skipped = 0;
for (const legacy of legacyRoots) {
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    const from = path.join(legacy, entry.name);
    const to = path.join(target, entry.name);
    if (existsSync(to)) { skipped += 1; continue; }
    const bytes = statSync(from, { throwIfNoEntry: false })?.size ?? 0;
    if (!dryRun) cpSync(from, to, { recursive: true });
    copied += 1;
    console.log(`${dryRun ? '[dry-run] ' : ''}迁 ${path.relative(repo, from)} → ${path.relative(repo, to)}${bytes ? ` (${bytes}B)` : ' (目录)'}`);
  }
}
if (!dryRun) {
  for (const legacy of legacyRoots) {
    const left = readdirSync(legacy);
    if (!left.length) { rmSync(legacy, { recursive: true }); console.log(`旧位已空，删除：${path.relative(repo, legacy)}`); }
    else console.log(`旧位仍有 ${left.length} 项未迁移（目标已存在同名），保留：${path.relative(repo, legacy)}`);
  }
}
console.log(`完成：迁 ${copied} 项、跳过 ${skipped} 项（目标已存在）${dryRun ? '（dry-run 未动盘）' : ''}`);
