#!/usr/bin/env node
// docs 门禁的本地等价实现（P003-T081）。台账里的 `gate-cli docs` 在本机不存在；
// 这里按同等口径校验：frontmatter 齐全（type/id）、id 不重复、frontmatter 里 covers/refs 指到的文件存在。
// 退出码：0 = ok；1 = 有 errors。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repo, 'docs');
const errors = [];
const ids = new Map();

const walk = (dir, base = dir) => readdirSync(base, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(base, entry.name);
  if (entry.isDirectory()) return walk(dir, full);
  return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
});

for (const file of walk(docsDir)) {
  const rel = path.relative(repo, file);
  const text = readFileSync(file, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) { errors.push(`${rel}: 缺 frontmatter`); continue; }
  const type = fm[1].match(/^type:\s*(\S+)/m)?.[1];
  const id = fm[1].match(/^id:\s*(\S+)/m)?.[1];
  if (!type) errors.push(`${rel}: frontmatter 缺 type`);
  if (!id) errors.push(`${rel}: frontmatter 缺 id`);
  else {
    if (ids.has(id)) errors.push(`${rel}: id ${id} 与 ${ids.get(id)} 重复`);
    else ids.set(id, rel);
  }
  // covers / refs 指到的实现文件必须存在（相对仓根）
  for (const m of text.matchAll(/(?:covers|files):\s*\[([^\]]*)\]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '');
      if (!name || name.includes('*') || name.startsWith('$')) continue;
      if (!existsSync(path.join(repo, name)) && !name.endsWith('/'))
        errors.push(`${rel}: covers/files 指到不存在的文件 ${name}`);
    }
  }
}

if (errors.length) {
  console.log(`check-docs: ${errors.length} 个错误`);
  for (const line of errors) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
} else {
  console.log(`check-docs: ok（${ids.size} 篇文档，id 无重复，引用文件齐全）`);
}
