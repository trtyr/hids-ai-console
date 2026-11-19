// P003-T033 人工核账取证帮手：对给定文档行，打印该行原文、行内每个锚点，
// 以及锚点里点到的符号在目标文件中的真实行（grep -n 等价）。
//
// 用法：node evidence/test/P003-T033/anchor-context.mjs 49 50 51 ...
import { readFileSync } from 'node:fs';

const docPath = 'docs/modules/triage-pipeline.md';
const docLines = readFileSync(docPath, 'utf8').split('\n');
const fileCache = new Map();
const linesOf = f => {
  if (!fileCache.has(f)) fileCache.set(f, readFileSync(f, 'utf8').split('\n'));
  return fileCache.get(f);
};

const noGrep = process.argv.includes('--no-grep');
for (const arg of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const n = Number(arg.replace('doc:', ''));
  const line = docLines[n - 1] || '';
  console.log(`\n=== doc:${n}\n${line.trim()}`);
  const anchors = [...line.matchAll(/([a-z0-9-]+\.js):(\d+)(?:-(\d+))?/g)];
  const cont = [...line.matchAll(/、`(\d+)(?:-(\d+))?`/g)];
  const all = [
    ...anchors.map(m => ({ file: m[1], start: +m[2], end: +(m[3] || m[2]) })),
    ...cont.map(m => ({ file: anchors.at(-1)?.[1], start: +m[1], end: +(m[2] || m[1]), cont: true })),
  ];
  for (const a of all) {
    const body = linesOf(a.file);
    const now = body.slice(a.start - 1, a.end).map(l => l.trim()).join(' ⏎ ').slice(0, 120);
    console.log(`  ${a.cont ? '(承前)' : ''}${a.file}:${a.start}-${a.end}  现内容: ${now}`);
  }
  // 该行反引号里的标识符，逐个 grep 出真实行号（最多 6 条）。
  const tokens = new Set();
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const raw = m[1];
    if (!/^[A-Za-z_$][\w$.#]*$/.test(raw)) continue;
    const bare = raw.replace(/^this\./, '');
    if (bare.length < 3 || /\.js$/.test(bare) || /^(null|true|false)$/.test(bare)) continue;
    tokens.add(bare);
  }
  if (noGrep) continue;
  const files = new Set(all.map(a => a.file));
  for (const file of files) {
    const body = linesOf(file);
    for (const token of tokens) {
      const hits = [];
      body.forEach((text, i) => { if (text.includes(token)) hits.push(i + 1); });
      if (!hits.length) continue;
      const shown = hits.length <= 8 ? hits : hits.slice(0, 8);
      console.log(`  grep ${token} ${file} -> ${hits.join(',')}${hits.length > 8 ? ' …' : ''}`);
      for (const h of shown) console.log(`     ${h}: ${body[h - 1].trim().slice(0, 120)}`);
    }
  }
}
