#!/usr/bin/env node
// knowledge-base.md 里 wiki-workbench.js 锚点的重取账（P003-T034 复审第 4 轮整改）。
//
// 背景：这篇文档的 wiki-workbench 锚点写于 e997260（P003-T021 给 wiki-workbench.js 加了
// feedbackFailure / feedbackEvidence / 误报回合等十几行）之前；代码改行号而文档没跟，
// 154 处锚点里 100+ 处指向了错位的代码。判据：
//   - 「老行号」的锚点：拿 e997260^ 里该行的原文在 HEAD 里逐行全等定位，唯一定位到哪一行就改成哪一行；
//   - 原文在 HEAD 里被改写过（如系统提示那行拼进了 special/feedbackTurn）：人工按文档那句话重新定位，记在 HAND 表。
//
// 用法：
//   node evidence/test/P003-T034/anchor-retake.mjs                  # 以 HEAD 为基准，打印改动账并自校
//   node evidence/test/P003-T034/anchor-retake.mjs --base <commit>  # 换基准提交
//   node evidence/test/P003-T034/anchor-retake.mjs --verbose        # 连未改动的锚点一起打印
// 退出码：0 = 每处改动都有依据（内容映射落到同一行，或人工判的 HAND 表点了名）；1 = 有不带依据的改动。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const baseAt = args.indexOf('--base');
const BASE = baseAt >= 0 ? args[baseAt + 1] : 'HEAD';
const DOC = 'docs/modules/knowledge-base.md';
const CODE = 'wiki-workbench.js';
const PRE = 'e997260^'; // wiki-workbench.js 上一次改动前的提交，即锚点写作时的代码状态

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const head = readFileSync(`${ROOT}/${CODE}`, 'utf8').split('\n');
const pre = git('show', `${PRE}:${CODE}`).split('\n');
const now = readFileSync(`${ROOT}/${DOC}`, 'utf8').split('\n');
const before = git('show', `${BASE}:${DOC}`).split('\n');
const RE = /wiki-workbench\.js:(\d+)(?:-(\d+))?/g;
const anchorsOf = line => [...line.matchAll(RE)].map(m => `${m[1]}${m[2] ? '-' + m[2] : ''}`);
const split = anchor => anchor.split('-').map(Number);

const mapBlock = (n, e) => {
  const block = pre.slice(n - 1, e);
  if (!block.length) return null;
  const hits = [];
  for (let at = 0; at + block.length <= head.length; at++) {
    if (block.every((text, k) => head[at + k] === text)) hits.push(at + 1);
  }
  const uniq = [...new Set(hits)];
  return uniq.length === 1 ? `${uniq[0]}${e > n ? '-' + (uniq[0] + e - n) : ''}` : null;
};

// 人工判的锚点（旧锚点所在原文在 HEAD 里被改写过，内容映射定位不到）：`doc 行号:旧锚点` → 新锚点
const HAND = {
  '25:65': '77', '25:94': '90-96', '25:135': '147',
  '27:271-285': '292-306', '49:271-285': '292-306', '57:65': '77',
  '33:176': '191', '33:285': '306', '33:311': '332', '35:287-290': '308-311',
  '193:222-223': '237-238', '240:300-305': '295-300', '301:176': '191', '302:176': '191',
  '305:79-82': '90-96', '380:277': '297-300', '383:176': '191', '423:141': '153', '423:253': '274',
  '489:223': '238', '495:142': '154', '496:110': '122', '497:185': '200',
  '498:154': '168', '498:156': '169', '499:164': '177', '499:172': '185', '500:187': '222',
  '501:152': '165', '501:176': '191', '506:13-14': '15-16', '507:277': '298',
  '633:176': '165', '634:8-12': '8-14', '634:190-192': '205-207', '635:102': '114',
  '645:271-285': '292-306', '646:31-36': '43-48', '647:240-242': '255-258',
  '651:220': '235', '651:226': '241', '658:176': '191', '658:285': '306', '658:311': '332',
};
// 本轮新补的坐标（旧文这一行没有这条锚点）
const ADDED = { '27:136': '客户经验的新建入口：文件名生成（:136）' };

const proven = (line, oldA, newA) => {
  if (oldA === undefined) return ADDED[`${line}:${newA}`] !== undefined;
  const [on, oe] = split(oldA);
  return mapBlock(on, oe ?? on) === newA || HAND[`${line}:${oldA}`] === newA;
};

let changed = 0, mapped = 0, hand = 0;
const unproven = [];
for (let i = 0; i < Math.max(now.length, before.length); i++) {
  const oldAnchors = anchorsOf(before[i] || '');
  const newAnchors = anchorsOf(now[i] || '');
  const used = new Set();
  for (const newA of newAnchors) {
    const unchanged = oldAnchors.find(candidate => !used.has(candidate) && candidate === newA);
    if (unchanged !== undefined) { used.add(unchanged); if (VERBOSE) console.log(`未动 doc:${i + 1} ${newA}`); continue; }
    const oldA = oldAnchors.find(candidate => !used.has(candidate) && proven(i + 1, candidate, newA));
    const zero = oldA === undefined;
    if (zero) used.add(newA);
    const changedHere = zero || oldA !== newA;
    if (!changedHere) continue;
    const ok = proven(i + 1, oldA, newA);
    if (ok) {
      changed++;
      const [on, oe] = oldA ? split(oldA) : [0, 0];
      const auto = oldA !== undefined && mapBlock(on, oe ?? on) === newA;
      if (auto) mapped++; else hand++;
      if (VERBOSE || !auto) console.log(`${auto ? '内容映射' : '人工判'} doc:${i + 1} wiki-workbench.js:${oldA ?? '(新增)'} → ${newA} | 新锚点首行: ${(head[split(newA)[0] - 1] || '').trim().slice(0, 88)}`);
    } else {
      unproven.push(`doc:${i + 1} ${oldA ?? '(新增)'} → ${newA}`);
    }
  }
  if (VERBOSE && !newAnchors.length && oldAnchors.length) console.log(`未动 doc:${i + 1} ${oldAnchors.join(' ')}`);
}
console.log('---');
console.log(`基准 ${BASE} → 工作树：wiki-workbench.js 锚点改动 ${changed} 处（内容映射 ${mapped}、人工判 ${hand}、无依据 ${unproven.length}）`);
if (unproven.length) {
  console.log('无依据的改动：');
  for (const u of unproven) console.log('  ' + u);
  process.exit(1);
}
