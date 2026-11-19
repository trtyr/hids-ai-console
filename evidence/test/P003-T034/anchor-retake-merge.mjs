#!/usr/bin/env node
// 合并轮锚点重取（P003-T034 收尾集成）：把文档里的 `file:NNN` 锚点从「合并前的代码状态」搬到「合并后的工作树」。
//
// 背景：本卡文档里的锚点写的是**合并前那棵树**的行号（每一处都核过）；合并 main（P003-T041 等）后
// `server.js` / `wiki-store.js` / `rule-store.js` / `prompt-store.js` / `triage-monitor.js` / `config-store.js`
// 都动了，同一句描述就指到了别的行。判据只有一条，别拿「看起来差不多」当依据：
//   - 合并前该锚点覆盖的那几行原文（`--pre` 提交里的 `file:from-to`）在合并后的工作树里**唯一**出现 →
//     锚点改成那一处的行号（内容映射，可复跑验证）；
//   - 原文被改动过（内容映射定位不到）→ 不自动改，打进「无依据」清单，由人工按描述重新定位并记进 HAND 表。
//
// 用法：
//   node evidence/test/P003-T034/anchor-retake-merge.mjs --pre 1b98ba3 --doc docs/modules/knowledge-base.md            # 重取并落盘
//   node evidence/test/P003-T034/anchor-retake-merge.mjs --pre 1b98ba3 --doc docs/architecture.md --check               # 只看会改什么
//   node evidence/test/P003-T034/anchor-retake-merge.mjs --pre 1b98ba3 --doc docs/modules/http-api.md --verbose        # 连未改的锚点一起打
//   --skip 259-271,300-306                                                              # 跳过取自 main 的冲突块（那些行人工重定位）
//   --only-pre-lines                                                                    # 只动合并前文档里逐字存在的行（三方合并后「取自 main 的新行」不按本文件坐标重算）
// 退出码：0 = 每处改动都有依据；1 = 有内容映射定位不到、又没有 HAND 依据的锚点。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const value = name => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const PRE = value('--pre');
const DOC = value('--doc');
const CHECK = args.includes('--check');
const ONLY_PRE = args.includes('--only-pre-lines'); // 只动「合并前那份文档里逐字存在」的行：取自 main 的新行不按本文件坐标重算
const SKIP = (value('--skip') || '').split(',').filter(Boolean).map(range => range.split('-').map(Number));
const VERBOSE = args.includes('--verbose');
if (!PRE || !DOC) {
  console.error('用法：--pre <合并前提交> --doc <文档路径> [--check] [--verbose]');
  process.exit(2);
}

// 人工判的锚点：`文档行号:旧锚点` → 新锚点（内容映射定位不到的，按文档那句描述重新定位，逐条写理由）
const HAND = {
  // 冲突块外的这些锚点：T041 在方法体里插了 `await this.ready()`、或把构造函数签名拆了两行，
  // 「合并前那几行原文」在合并后不再逐字成块，内容映射定位不到 → 按方法定义首尾逐条核（首行/尾行见右侧理由）。
  '31:345-365': '364-385',   // createExperience() 定义首行 → 收尾 `}`（旧 345-365 整个方法体，内含新插的 ready()）
  '32:269-343': '287-362',   // publishBundle() 定义首行 → 收尾 `}`（同上）
  '74:92-107': '107-123',    // list() 定义首行 → 该方法收尾 `}` 前一行（92-107 是签名块，方法体内部插了一行）
  '75:111-119': '127-136',   // get() 定义首行 → 收尾 `}`（readdir / catch 那几行内容未变、位置 +16）
  '124:92-95': '107-111',    // list() 开头到 readdir 那行：P003-T037 的目录缓存注释块，改后仍在 readdir 之前
  '228:269-343': '287-362',  // 与 doc:32 同一处：publishBundle 全函数
  '237:220': '238',          // `this.pending = job.catch(() => {});`（update 的串行尾巴）在合并后仍同一句、位置 +18
  '237:341': '360',          // 同上（publishBundle 的串行尾巴）
  '237:363': '383',          // 同上（createExperience 的串行尾巴）
  '388:30': '30'             // 构造函数首行：T041 只把签名拆成两行，`constructor(` 仍在第 30 行
};
const REASON = {};

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const codeCache = new Map();
function codeAt(file, rev) {
  const key = `${rev}:${file}`;
  if (codeCache.has(key)) return codeCache.get(key);
  let lines = null;
  try {
    lines = (rev ? git('show', `${rev}:${file}`) : readFileSync(`${ROOT}/${file}`, 'utf8')).split('\n');
  } catch { /* 文件不在这一版 */ }
  codeCache.set(key, lines);
  return lines;
}

const ANCHOR_RE = /([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|json|yaml|yml|md|sh)):(\d+)(?:-(\d+))?/g;
const same = (a, b) => a.length === b.length && a.every((text, i) => text === b[i]);
const locate = (haystack, block) => {
  const hits = [];
  for (let at = 0; at + block.length <= haystack.length; at++) if (same(haystack.slice(at, at + block.length), block)) hits.push(at + 1);
  return [...new Set(hits)];
};

const docPath = DOC;
const before = codeAt(docPath, null);
const after = before.slice();
let changed = 0, mapped = 0, hand = 0;
const unproven = [];
const beforeDocLines = new Set(codeAt(docPath, PRE) || []);
const skipped = lineNo => SKIP.some(([a, b]) => lineNo >= a && lineNo <= (b || a))
  || (ONLY_PRE && !beforeDocLines.has(before[lineNo - 1]));
for (let i = 0; i < before.length; i++) {
  const line = before[i];
  if (skipped(i + 1)) continue; // 冲突块里取自 main 的行：锚点由人工按合并后代码重定位（见 HAND）
  if (!ANCHOR_RE.test(line)) continue;
  ANCHOR_RE.lastIndex = 0;
  after[i] = line.replace(ANCHOR_RE, (whole, file, fromText, toText) => {
    const from = +fromText;
    const to = toText ? +toText : from;
    const oldCode = codeAt(file, PRE);
    const newCode = codeAt(file, null);
    if (!oldCode || !newCode) return whole;
    const block = oldCode.slice(from - 1, to);
    if (!block.length || block.every(text => text.trim() === '')) return whole; // 指到空行的锚点不在本工具判定范围
    const anchor = `${from}${toText ? '-' + to : ''}`;
    const handKey = `${i + 1}:${anchor}`;
    if (same(newCode.slice(from - 1, to), block)) { // 行内容没变：锚点仍然指对
      if (VERBOSE) console.log(`未动 doc:${i + 1} ${file}:${anchor}`);
      return whole;
    }
    if (HAND[handKey]) {
      changed++; hand++;
      console.log(`人工判 doc:${i + 1} ${file}:${anchor} → ${HAND[handKey]} | ${REASON[handKey] || ''}`);
      const target = HAND[handKey].split('-');
      return `${file}:${target[0]}${target[1] ? '-' + target[1] : ''}`;
    }
    const hits = locate(newCode, block);
    if (hits.length !== 1) {
      unproven.push(`doc:${i + 1} ${file}:${anchor}（合并后命中 ${hits.length} 处）| ${line.trim().slice(0, 100)}`);
      return whole;
    }
    const moved = `${hits[0]}${to > from ? '-' + (hits[0] + to - from) : ''}`;
    changed++; mapped++;
    console.log(`内容映射 doc:${i + 1} ${file}:${anchor} → ${moved} | ${(newCode[hits[0] - 1] || '').trim().slice(0, 80)}`);
    return `${file}:${moved}`;
  });
}

const text = after.join('\n');
if (text !== before.join('\n') && !CHECK) writeFileSync(`${ROOT}/${docPath}`, text);
console.log('---');
console.log(`${CHECK ? '（--check，不落盘）' : ''}${docPath}：${PRE} → 工作树，锚点改动 ${changed} 处（内容映射 ${mapped}、人工判 ${hand}、无依据 ${unproven.length}）`);
if (unproven.length) {
  console.log('无依据的改动（内容映射定位不到，需人工判）：');
  for (const item of unproven) console.log('  ' + item);
  process.exit(1);
}
