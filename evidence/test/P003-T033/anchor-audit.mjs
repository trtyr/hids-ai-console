// P003-T033 文档锚点核账工具（可重放）。
//
// 三个动作，按顺序用：
//   ① node evidence/test/P003-T033/anchor-audit.mjs --build-map
//      按文档「行号基准」段落自己点名的历史版本，把每个锚点重取到当前代码的真实行号；
//      人工裁决（anchor-overrides.json）覆盖自动结果。产出 anchor-map.json（按文档顺序排列）。
//   ② node evidence/test/P003-T033/anchor-audit.mjs --apply-map
//      按表改写文档里的锚点文本（只动锚点，不动其它字）。
//   ③ node evidence/test/P003-T033/anchor-audit.mjs
//      核账：文档里的锚点逐个对表（数量、文件名、行号），再用「文档那一行提到的符号」
//      核目标代码块。表里的 manual / verified 是人工逐条读过的，符号层对它们只作提示；
//      自动平移的（drift）没人读过，符号层对它们是硬门。
//
// 附：--tsv=<路径> 写逐条对照件（513 条，含 grep 取证）；--drift-tsv=<路径> 写漂移清单
//（表里 old≠new 的条目，第一列是它在表里的序号）。
//
// 退出码：0 全部对得上；1 有对不上的。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argOf = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const docPath = argOf('doc') || 'docs/modules/triage-pipeline.md';
const overridesPath = argOf('overrides') || 'evidence/test/P003-T033/anchor-overrides.json';
const mapPath = argOf('map') || 'evidence/test/P003-T033/anchor-map.json';
const buildMap = process.argv.includes('--build-map');
const applyMap = process.argv.includes('--apply-map');
const WINDOW = 3; // 符号层容差：目标行上下各 3 行（一条语句常跨几行）
const baselines = ['a16e0d5', '432edfb', 'a77d43a', 'a16e94b', '4061f12', '9572a1f'];

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const revText = (rev, file) => { try { return git(['show', `${rev}:${file}`]); } catch { return null; } };
const splitLines = text => text.split('\n');
const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
const norm = value => { const [x, y] = String(value).split('-').map(Number); return `${x}-${y || x}`; };

function buildLineMap(rev, file) {
  let diff = '';
  try { diff = execFileSync('git', ['diff', '-U0', rev, 'HEAD', '--', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
  const hunks = [];
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) hunks.push({ oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newCount: m[4] === undefined ? 1 : +m[4] });
  }
  hunks.sort((a, b) => a.oldStart - b.oldStart);
  return n => {
    let shift = 0;
    for (const h of hunks) {
      if (h.oldCount === 0) { if (h.oldStart < n) shift += h.newCount; continue; }
      if (n < h.oldStart) break;
      if (n < h.oldStart + h.oldCount) return null; // 这行本身被改了，没有 1:1 对应
      shift += h.newCount - h.oldCount;
    }
    return n + shift;
  };
}

const docLines = splitLines(readFileSync(docPath, 'utf8'));

// 锚点解析：① `file.js:12-34`；② 同一行承前的 `file.js:12`、`34`。顺序即文档顺序。
function parseAnchors(lines) {
  const anchors = [];
  const primary = /([a-z0-9-]+\.js):(\d+)(?:-(\d+))?/g;
  const contOnLine = /、`(\d+)(?:-(\d+))?`/g;
  lines.forEach((line, index) => {
    const found = [];
    primary.lastIndex = 0;
    let m;
    while ((m = primary.exec(line)))
      found.push({ docLine: index + 1, col: m.index, file: m[1], start: +m[2], end: +(m[3] || m[2]), raw: m[0] });
    if (found.length) {
      const file = found[found.length - 1].file;
      const lastPrimaryCol = found[found.length - 1].col;
      contOnLine.lastIndex = 0;
      let c;
      while ((c = contOnLine.exec(line))) {
        if (c.index <= lastPrimaryCol) continue;
        found.push({ docLine: index + 1, col: c.index, file, start: +c[1], end: +(c[2] || c[1]), cont: true });
      }
    }
    found.sort((a, b) => a.col - b.col);
    found.forEach((item, i) => { item.ordinal = i; item.key = `${item.docLine}#${i}`; });
    anchors.push(...found);
  });
  return anchors;
}

// 文档里的写法与代码里的写法常常一个 snake 一个 camel（`watermark_ids` vs `watermarkIds`），
// 带点的（`paused.dropped`）在代码里只出现后半截——核对时都算同一个符号。
const variantsOf = token => {
  const bare = token.replace(/^this\./, '');
  const tail = bare.split('.').pop();
  const camel = tail.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const snake = tail.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return [...new Set([bare, tail, camel, snake])];
};

const tokensNear = (line, col) => {
  const tokens = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const raw = m[1];
    if (!/^[A-Za-z_$][\w$.#]*$/.test(raw)) continue;
    const bare = raw.replace(/^this\./, '');
    if (bare.length < 3 || /\.js$/.test(bare) || /^(null|true|false)$/.test(bare)) continue;
    tokens.push({ token: bare, distance: Math.abs(m.index - col) });
  }
  return tokens.sort((a, b) => a.distance - b.distance).map(t => t.token);
};

const anchors = parseAnchors(docLines);
const files = [...new Set(anchors.map(a => a.file))];
const headLines = Object.fromEntries(files.map(f => [f, splitLines(readFileSync(f, 'utf8'))]));

if (buildMap) {
  const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
  const revLines = {};
  const lineMaps = {};
  for (const rev of baselines) {
    revLines[rev] = {};
    for (const f of files) {
      const text = revText(rev, f);
      revLines[rev][f] = text === null ? null : splitLines(text);
      lineMaps[`${rev}:${f}`] = text === null ? null : buildLineMap(rev, f);
    }
  }
  // 分节 + 逐节定基准（判据：基准版本与 HEAD 在那几行原文逐行一致）。
  const sectionOf = new Array(docLines.length).fill(0);
  {
    let current = 0;
    docLines.forEach((line, i) => { if (/^## /.test(line)) current = i + 1; sectionOf[i] = current; });
  }
  const sectionAnchors = new Map();
  for (const a of anchors) {
    const key = sectionOf[a.docLine - 1];
    if (!sectionAnchors.has(key)) sectionAnchors.set(key, []);
    sectionAnchors.get(key).push(a);
  }
  const sectionBaseline = new Map();
  for (const [section, list] of sectionAnchors) {
    let best = { rev: null, score: -1 };
    for (const rev of baselines) {
      let score = 0;
      for (const a of list) {
        const src = revLines[rev][a.file];
        const hay = headLines[a.file];
        if (!src || a.end > src.length || a.end > hay.length) continue;
        if (same(hay.slice(a.start - 1, a.end), src.slice(a.start - 1, a.end))) score++;
      }
      if (score > best.score) best = { rev, score };
    }
    sectionBaseline.set(section, best);
  }
  const map = [];
  const unresolved = [];
  for (const a of anchors) {
    const rev = sectionBaseline.get(sectionOf[a.docLine - 1]).rev;
    const src = revLines[rev][a.file];
    const lineMap = lineMaps[`${rev}:${a.file}`];
    let start = a.start;
    let end = a.end;
    let status = 'unresolved';
    if (src && lineMap && a.end <= src.length) {
      const s = lineMap(a.start);
      const e = lineMap(a.end);
      if (s !== null && e !== null && e - s === a.end - a.start) {
        start = s; end = e;
        status = same(src.slice(a.start - 1, a.end), headLines[a.file].slice(s - 1, e))
          ? (s === a.start && e === a.end ? 'ok' : 'drift')
          : 'mismatch';
      }
    }
    const manual = overrides[a.key];
    if (manual === 'keep') { start = a.start; end = a.end; status = 'verified'; }
    else if (manual) {
      const [ms, me] = manual.split('-').map(Number);
      if (Number.isInteger(ms)) { start = ms; end = me || ms; status = 'manual'; }
    }
    map.push({ file: a.file, old: `${a.start}-${a.end}`, new: `${start}-${end}`, status });
    if (status === 'unresolved') unresolved.push(a.key);
  }
  writeFileSync(mapPath, `${JSON.stringify(map, null, 1)}\n`);
  // 逐条对照件：每个锚点一条，附「grep -nF 现场行」是否命中该锚点行——A4 要的可复跑取证。
  const tsvPath = argOf('tsv');
  if (tsvPath) {
    const rows = ['docLine\tfile\tnewRange\tstatus\tgrep命中\tgrep命令\t首行原文'];
    anchors.forEach((a, index) => {
      const entry = map[index];
      if (!entry) return;
      const [s2] = entry.new.split('-').map(Number);
      const line = (headLines[a.file] || [])[s2 - 1] ?? '';
      const snippet = line.trim().slice(0, 40).replace(/\t/g, ' ');
      const command = `grep -nF ${JSON.stringify(snippet)} ${a.file}`;
      const hits = (headLines[a.file] || []).map((text, i) => (text.includes(snippet) ? i + 1 : 0)).filter(Boolean);
      rows.push([`doc:${a.docLine}`, a.file, entry.new, entry.status, hits.includes(s2) ? 'yes' : 'NO', command, snippet].join('\t'));
    });
    writeFileSync(tsvPath, `${rows.join('\n')}\n`);
    console.log(`逐条对照写到 ${tsvPath}（${rows.length - 1} 条）。`);
  }
  const tally = map.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  console.log(`建表 ${map.length} 条：${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (unresolved.length) console.log(`未落定（要人工补 overrides）：${unresolved.join(' ')}`);
  console.log(`分节基准：${[...sectionBaseline].map(([s, v]) => `doc:${s}=${v.rev}`).join(' ')}`);
  process.exitCode = unresolved.length ? 1 : 0;
} else if (applyMap) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const lines = [...docLines];
  const byLine = new Map();
  if (map.length !== anchors.length) {
    console.error(`表 ${map.length} 条、文档 ${anchors.length} 条，数量对不上，先核表再改。`);
    process.exitCode = 2;
  } else {
    anchors.forEach((a, index) => {
      if (norm(`${a.start}-${a.end}`) === norm(map[index].new)) return;
      if (!byLine.has(a.docLine)) byLine.set(a.docLine, []);
      byLine.get(a.docLine).push({ anchor: a, entry: map[index] });
    });
    for (const [docLine, items] of byLine) {
      items.sort((x, y) => y.anchor.col - x.anchor.col);
      for (const { anchor, entry } of items) {
        const oldText = anchor.cont ? `\`${anchor.start}${anchor.end !== anchor.start ? `-${anchor.end}` : ''}\`` : anchor.raw;
        const at = anchor.cont ? anchor.col + 1 : anchor.col;
        const replacement = anchor.cont ? `\`${entry.new}\`` : `${anchor.file}:${entry.new}`;
        const line = lines[docLine - 1];
        if (line.slice(at, at + oldText.length) !== oldText) {
          console.error(`doc:${docLine} 定位失败：期望 ${JSON.stringify(oldText)}，实得 ${JSON.stringify(line.slice(at, at + oldText.length))}`);
          process.exitCode = 2;
          continue;
        }
        lines[docLine - 1] = line.slice(0, at) + replacement + line.slice(at + oldText.length);
      }
    }
    writeFileSync(docPath, lines.join('\n'));
    console.log(`按表改写 ${[...byLine.values()].reduce((n, v) => n + v.length, 0)} 处锚点（${byLine.size} 行）。`);
  }
} else {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const bad = [];
  const soft = [];
  if (map.length !== anchors.length) bad.push({ key: '-', why: `数量不一致：文档 ${anchors.length} 条，表 ${map.length} 条` });
  anchors.forEach((a, index) => {
    const entry = map[index];
    if (!entry) return;
    const key = `doc:${a.docLine}#${a.ordinal}`;
    if (entry.file !== a.file) { bad.push({ key, why: `文件名不一致：文档 ${a.file}，表 ${entry.file}` }); return; }
    if (norm(`${a.start}-${a.end}`) !== norm(entry.new)) { bad.push({ key, why: `行号不一致：文档 ${a.start}-${a.end}，表 ${entry.new}` }); return; }
    const [s, e0] = entry.new.split('-').map(Number);
    const e = Number.isFinite(e0) ? e0 : s; // 单行锚点（`708`）与退化区间写法（`708-708`）等价
    const body = headLines[a.file];
    if (!body || e > body.length) { bad.push({ key, why: `行号越界：${a.file}:${entry.new}（文件 ${body ? body.length : 0} 行）` }); return; }
    const tokens = tokensNear(docLines[a.docLine - 1], a.col);
    if (!tokens.length) return;
    const near = body.slice(Math.max(0, s - 1 - WINDOW), e + WINDOW).join('\n');
    if (tokens.slice(0, 3).some(t => variantsOf(t).some(v => v.length >= 3 && near.includes(v)))) return;
    // manual / verified 是人工逐条读过的，符号层对它们只作提示；自动平移的没人读过，算失败。
    const note = { key, why: `符号对不上：${a.file}:${entry.new} 附近没有文档提到的 ${tokens.slice(0, 3).join(' / ')}` };
    if (entry.status === 'manual' || entry.status === 'verified') soft.push(note); else bad.push(note);
  });
  // 逐条对照件：每个锚点一条，附「grep -nF 现场行」是否命中该锚点行——A4 要的可复跑取证。
  const tsvPath = argOf('tsv');
  if (tsvPath) {
    const rows = ['docLine\tfile\tnewRange\tstatus\tgrep命中\tgrep命令\t首行原文'];
    anchors.forEach((a, index) => {
      const entry = map[index];
      if (!entry) return;
      const [s2] = entry.new.split('-').map(Number);
      const line = (headLines[a.file] || [])[s2 - 1] ?? '';
      const snippet = line.trim().slice(0, 40).replace(/\t/g, ' ');
      const command = `grep -nF ${JSON.stringify(snippet)} ${a.file}`;
      const hits = (headLines[a.file] || []).map((text, i) => (text.includes(snippet) ? i + 1 : 0)).filter(Boolean);
      rows.push([`doc:${a.docLine}`, a.file, entry.new, entry.status, hits.includes(s2) ? 'yes' : 'NO', command, snippet].join('\t'));
    });
    writeFileSync(tsvPath, `${rows.join('\n')}\n`);
    console.log(`逐条对照写到 ${tsvPath}（${rows.length - 1} 条）。`);
  }
  const driftTsvPath = argOf('drift-tsv');
  if (driftTsvPath) {
    const rows = ['#\tfile\told(文档原行号)\tnew(当前真实行号)\tstatus'];
    map.forEach((entry, index) => {
      if (norm(entry.old) === norm(entry.new)) return;
      rows.push([index, entry.file, entry.old, entry.new, entry.status].join('\t'));
    });
    writeFileSync(driftTsvPath, `${rows.join('\n')}\n`);
    console.log(`漂移清单写到 ${driftTsvPath}（${rows.length - 1} 条）。`);
  }
  const tally = map.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  console.log(`锚点 ${anchors.length} 条，表 ${map.length} 条（${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}）；对不上 ${bad.length} 条，符号层提示 ${soft.length} 条。`);
  for (const item of bad) console.log(`  ✗ ${item.key}\t${item.why}`);
  process.exitCode = bad.length ? 1 : 0;
}
