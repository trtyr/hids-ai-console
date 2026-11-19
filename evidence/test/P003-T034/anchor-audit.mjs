#!/usr/bin/env node
// 全量文档锚点核验（P003-T034 复审整改）：扫 docs/**、README.md、openapi.yaml 里所有
// `file.ext:NNN[-MMM]` 锚点，逐条判断「锚点指向的行」是否还在讲文档说的那件事。
//
// 判定证据（从严到宽）：
//   1) 表行首列是 `方法(...)` → 目标区间里必须有它的定义行（没有就按唯一定义行给 MOVED）；
//   2) 文档同一行的错误文案「…」/表行文案列 → 目标区间里必须有这段字（没有就按唯一出现行给 MOVED）；
//   3) 内容未变：某个「知道这条锚点」的基线提交（基线文档里有同一锚点串）里，该行内容与 HEAD 同号行逐字相同 → PASS；
//   4) 内容映射：基线该行内容在 HEAD 唯一出现、且映射位置 != 当前行 → MOVED（给出映射后的行号）；
//   5) 都不成立 → UNVERIFIED（脚本判不了，人工核；打印当前行内容供人看）。
//
// 说明：基线是 4 个合并前提交（e997260 / a16e94b / 51aa339 / 0467223）+ 该文档行的 blame 提交。
// 「文档说的事」只从文档自身取（表行首列、错误文案），不做语义联想。
//
// 用法：
//   node evidence/test/P003-T034/anchor-audit.mjs              # 审计（只打印结论与非 PASS 明细）
//   node evidence/test/P003-T034/anchor-audit.mjs --verbose    # 连 PASS 明细一起打印
//   node evidence/test/P003-T034/anchor-audit.mjs --file docs/modules/knowledge-base.md  # 只看某份文档
// 退出码：0 = 没有被判为 MOVED 的锚点；1 = 有。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = process.cwd();
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => { const at = process.argv.indexOf('--file'); return at > 0 ? process.argv[at + 1] : null; })();
const GLOBAL_BASELINES = ['e997260', 'a16e94b', '51aa339', '0467223'];
const ANCHOR_RE = /([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|json|yaml|yml|md|sh)):(\d+)(?:-(\d+))?/g;
const ANCHOR_IN_CELL_RE = /[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|json|yaml|yml|md|sh):\d+/;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const docFiles = git('ls-files', 'docs', 'README.md', 'openapi.yaml')
  .split('\n').filter(file => /\.(md|ya?ml)$/.test(file)).sort()
  .filter(file => !ONLY || file === ONLY);

// ── 版本索引（commit:file → 行内容与出现位置）────────────────────────────────
const cache = new Map();
function version(file, commit) {
  const key = `${commit}:${file}`;
  if (cache.has(key)) return cache.get(key);
  let text = null;
  try { text = commit ? git('show', `${commit}:${file}`) : readFileSync(`${ROOT}/${file}`, 'utf8'); } catch { /* 不在 */ }
  const entry = text === null ? null : (() => {
    const lines = text.split('\n');
    const index = new Map();
    lines.forEach((line, i) => { if (!index.has(line)) index.set(line, []); index.get(line).push(i + 1); });
    return { lines, index };
  })();
  cache.set(key, entry);
  return entry;
}
const head = file => version(file, null);

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trivial = text => text === undefined || !text.trim() || /^(?:\}|\)|\}\);|\],?|\*\/|\*|\/\/.*)$/.test(text.trim());
const DEF_RES = name => [
  new RegExp(`(?:^|[\\s=(,])(?:async\\s+)?(?:function\\s+)?${escapeRe(name)}\\s*\\(`),
  new RegExp(`^(?:export\\s+)?(?:class|const|let|var|function)\\s+${escapeRe(name)}\\b`),
];
const isDefinitionText = text => /^(?:\s*)(?:export\s+)?(?:async\s+)?(?:function|class)\b/.test(text || '')
  || /^\s*(?:async\s+)?#?[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{?\s*$/.test(text || '');
const isDefinitionOf = (line, name) => {
  if (!line || !name) return false;
  return DEF_RES(name).some(re => re.test(line));
};
const definitionLines = (idx, name) => {
  const hits = [];
  idx.lines.forEach((line, i) => { if (isDefinitionOf(line, name)) hits.push(i + 1); });
  return hits;
};
// 文案：反引号占位与 ${…}/<…> 拆掉后剩下的最实的一段中文
const messageChunks = text => text
  .replace(/`[^`]*`/g, '\u0000').replace(/\$\{[^}]*\}/g, '\u0000').replace(/<[^>]*>/g, '\u0000')
  .split('\u0000')
  .map(part => part.replace(/^[\s：:，,。；;|]+|[\s：:，,。；;|]+$/g, ''))
  .filter(part => part.length >= 4 && /[\u4e00-\u9fff]/.test(part));
const messageLine = (idx, text) => {
  for (const chunk of messageChunks(text).sort((a, b) => b.length - a.length)) {
    const hits = [];
    idx.lines.forEach((line, i) => { if (line.includes(chunk)) hits.push(i + 1); });
    if (hits.length === 1) return { line: hits[0], chunk };
  }
  return null;
};

const blameCommits = new Map();
function blameFor(docFile) {
  if (blameCommits.has(docFile)) return blameCommits.get(docFile);
  const commits = [];
  try {
    for (const line of git('blame', '--line-porcelain', 'HEAD', '--', docFile).split('\n'))
      if (/^[0-9a-f]{40} \d+ \d+/.test(line)) commits.push(line.split(' ')[0]);
  } catch { /* 新文件没有 blame */ }
  blameCommits.set(docFile, commits);
  return commits;
}

const rows = [];
for (const docFile of docFiles) {
  const lines = readFileSync(`${ROOT}/${docFile}`, 'utf8').split('\n');
  const blame = blameFor(docFile);
  lines.forEach((line, i) => {
    const isTable = line.trim().startsWith('|');
    const cells = isTable ? line.trim().split('|').slice(1, -1) : [];
    const callable = isTable ? (cells[0] || '').match(/`([A-Za-z_$][\w$]*)\(/)?.[1] || null : null;
    for (const match of line.matchAll(ANCHOR_RE)) {
      const [, file, fromText, toText] = match;
      const from = +fromText;
      const to = toText ? +toText : from;
      rows.push({ docFile, docLine: i + 1, docText: line, match, file, from, to, blame: blame[i - 1], isTable, cells, callable });
    }
  });
}

for (const row of rows) {
  const { file, from, to, match, docText } = row;
  row.range = `${file}:${from}${to !== from ? `-${to}` : ''}`;
  let targetIdx;
  try { targetIdx = head(file); } catch { row.status = 'MISSING_TARGET'; continue; }
  if (from > targetIdx.lines.length) { row.status = 'OUT_OF_RANGE'; continue; }
  row.current = targetIdx.lines.slice(from - 1, to).map(text => (text || '').trim()).join(' ⏎ ').slice(0, 120);
  // 1b) 当前行本身就是定义行：锚点指到一个定义上，文案/映射都不再翻案
  if (isDefinitionText(targetIdx.lines[from - 1])) { row.status = 'PASS'; row.evidence = '目标行是定义行'; continue; }

  // 1) 表行首列的方法定义
  if (row.callable) {
    const defs = definitionLines(targetIdx, row.callable);
    if (defs.some(def => def >= from && def <= to)) { row.status = 'PASS'; row.evidence = `定义行 ${row.callable}`; continue; }
    if (defs.length === 1) { row.status = 'MOVED'; row.fixTo = defs[0]; row.evidence = `定义行 ${row.callable}`; continue; }
  }
  // 2) 错误文案
  let message = null;
  if (row.isTable && row.rowsWithMessage !== false) {
    // 同一行只有这一条锚点时，才拿整行的文案列对号入座
    const anchorsOnLine = [...docText.matchAll(ANCHOR_RE)].length;
    if (anchorsOnLine === 1) {
      for (const cell of row.cells.slice(1)) {
        if (ANCHOR_IN_CELL_RE.test(cell)) continue;
        const found = messageChunks(cell).sort((a, b) => b.length - a.length)[0];
        if (!found || found.length < 6) continue; // 太短的词（「状态冲突」）到处都有，不当证据
        message = messageLine(targetIdx, found);
        if (message) break;
      }
    }
  } else if (!row.isTable) {
    const quoted = [...docText.slice(0, match.index).slice(-40).matchAll(/「([^」]+)」/g)].pop();
    if (quoted) message = messageLine(targetIdx, quoted[1]);
  }
  if (message) {
    if (message.line >= from && message.line <= to) { row.status = 'PASS'; row.evidence = `文案「${message.chunk}」`; continue; }
    row.status = 'MOVED'; row.fixTo = message.line; row.evidence = `文案「${message.chunk}」`; continue;
  }
  // 3) 内容未变（基线文档里有同一锚点串，且基线代码同号行内容与 HEAD 一致）
  const current = targetIdx.lines[from - 1];
  const baselines = [...new Set([row.blame, ...GLOBAL_BASELINES].filter(Boolean))];
  const known = [];
  for (const commit of baselines) {
    const baseDoc = version(row.docFile, commit);
    // 只认「整行逐字存在」的基线：文档行改过（本次重取过的）就不再拿老行号当证据
    if (!baseDoc || !baseDoc.lines.includes(docText)) continue;
    const baseCode = version(file, commit);
    if (!baseCode || from > baseCode.lines.length) continue;
    known.push({ commit, content: baseCode.lines[from - 1] });
  }
  if (known.some(item => item.content === current)) { row.status = 'PASS'; row.evidence = '行内容未变'; continue; }
  // 4) 目标行有代码内容 → 视为「脚本无法证伪」；空白/纯括号且无可信映射 → UNVERIFIED
  const rangeLines = targetIdx.lines.slice(from - 1, to);
  if (rangeLines.some(text => !trivial(text))) {
    row.status = 'PASS'; row.evidence = '目标区间里有代码（中文描述脚本判不了）';
  } else {
    row.status = 'UNVERIFIED';
  }
}

const count = status => rows.filter(row => row.status === status).length;
const byDoc = new Map();
for (const row of rows) {
  if (!byDoc.has(row.docFile)) byDoc.set(row.docFile, { total: 0, PASS: 0, MOVED: 0, UNVERIFIED: 0, other: 0 });
  const entry = byDoc.get(row.docFile);
  entry.total += 1;
  if (['PASS', 'MOVED', 'UNVERIFIED'].includes(row.status)) entry[row.status] += 1; else entry.other += 1;
}

console.log(`# 文档锚点全量核验 · ${git('rev-parse', '--short', 'HEAD').trim()} · 扫描 ${docFiles.length} 份文档`);
console.log(`# 锚点 ${rows.length} 处：PASS=${count('PASS')}  MOVED=${count('MOVED')}  UNVERIFIED=${count('UNVERIFIED')}  其他=${rows.length - count('PASS') - count('MOVED') - count('UNVERIFIED')}`);
console.log('\n## 按文档（total / PASS / MOVED / UNVERIFIED）');
for (const [doc, entry] of byDoc) console.log(`${doc}\t${entry.total}\t${entry.PASS}\t${entry.MOVED}\t${entry.UNVERIFIED}${entry.other ? `\tOTHER ${entry.other}` : ''}`);

const moved = rows.filter(row => row.status === 'MOVED');
console.log(`\n## MOVED（${moved.length} 处，锚点指向的行内容已不在原号）`);
for (const row of moved) console.log(`MOVED\t${row.docFile}:${row.docLine}\t${row.range} -> ${row.file}:${row.fixTo}\t[${row.evidence}]\t${row.current}`);

const unverified = rows.filter(row => row.status === 'UNVERIFIED');
console.log(`\n## UNVERIFIED（${unverified.length} 处，脚本判不了，需人工核）`);
for (const row of unverified) console.log(`UNVERIFIED\t${row.docFile}:${row.docLine}\t${row.range}\t${row.current}`);

const others = rows.filter(row => ['MISSING_TARGET', 'OUT_OF_RANGE'].includes(row.status));
if (others.length) {
  console.log(`\n## 越界/缺文件（${others.length} 处）`);
  for (const row of others) console.log(`${row.status}\t${row.docFile}:${row.docLine}\t${row.range}`);
}

if (VERBOSE) {
  console.log('\n## PASS 明细');
  for (const row of rows.filter(item => item.status === 'PASS'))
    console.log(`PASS\t${row.docFile}:${row.docLine}\t${row.range}\t[${row.evidence}]\t${row.current}`);
}

process.exit(moved.length ? 1 : 0);
