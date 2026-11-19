// P003-T039 A9：前后对比 + 变异验红（自包含，一条命令跑完）。
//
//   1. 用 git 把起活 commit 的树导到临时目录，与当前树用**同一个**测量 harness（context-size.mjs）
//      在同一场景上各跑一遍，比首轮 / 峰值轮 / 复核轮 / 全流程 / 系统段五项；
//   2. 目标：四项体积都至少省 50%；
//   3. 变异：逐项把本卡的改动回退成老样子（改一处源码字符串），该项对应的数字必须变差——
//      数字不动就说明那项改动是白改的，判 FAIL。
//
// 跑法：node evidence/test/P003-T039/mutations.mjs [--base=<commit>]
// 退出码 0 = 全过；非 0 = 有项没过。
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { measure, repoRoot } from './context-size.mjs';

const run = promisify(execFile);

const candidates = [
  { id: 'A1', label: '首轮/终局轮把 match.event 整条内联回来（去掉 matchMeta）',
    file: 'investigation-agent.js', from: 'match: matchMeta(streamContext.match), files:', to: 'match: streamContext.match, files:',
    count: 1, metric: 'first' },
  { id: 'A2', label: '复核轮回到未裁的 record.view（不做 4000 口径）',
    file: 'investigation-agent.js',
    from: '        evidence: conclusionEvidence(session) });',
    to: `        evidence: [...session.records.values()].map(record => ({ evidence_id: record.evidenceId, tool: record.tool,\n          view: record.view })) });`,
    count: 1, metric: 'review' },
  { id: 'A3', label: '首轮必查项回到带 args/scope/reason 的全量状态',
    file: 'investigation-agent.js',
    from: '必查项查询状态：${JSON.stringify(requiredStatus(requiredChecks))}',
    to: '必查项查询状态：${JSON.stringify(requiredChecks)}',
    count: 1, metric: 'first' },
  { id: 'A4', label: 'Wiki 常驻页回到整页正文',
    file: 'investigation-agent.js',
    from: 'JSON.stringify([...wikiPages.values()].slice(0, 4).map(wikiDigest))',
    to: 'JSON.stringify([...wikiPages.values()].slice(0, 4))',
    count: 1, metric: 'first' },
  { id: 'A5', label: '历史工具结果不折叠（全文一直留在上下文里）',
    file: 'investigation-agent.js',
    from: 'const foldIndexes = [...toolMessageEntries.keys()].sort((a, b) => a - b)',
    to: 'const foldIndexes = [].sort((a, b) => a - b)',
    count: 1, metric: 'flow' },
  { id: 'A6', label: '嵌套序列回到 timeline 20 行 / commands 8 行',
    file: 'evidence-view.js',
    from: 'Object.freeze({ timeline: 8, commands: 4 })',
    to: 'Object.freeze({ timeline: 20, commands: 8 })',
    count: 1, metric: 'first' },
  { id: 'A7', label: '工具名清单回到系统提示词里（每轮重发）',
    file: 'investigation-agent.js',
    from: "return '【从本次可用工具里选对应查询；只凭实际返回字段判断】';",
    to: 'return `【可用牧云工具：${names.join(\'、\')}；仅凭实际返回字段判断】`;',
    count: 1, metric: 'system' },
  { id: 'A8', label: 'triage.md 把输出 JSON 模板加回去（与 submit_conclusion schema 重复）',
    file: 'prompts/triage.md', metric: 'system',
    // 模板原文：把删掉的那一段原样贴回「# 输出格式」标题下面，模拟「没删」。
    apply: text => text.replace(/(# 输出格式\n\n)/, `$1{
  "alert_id": "", "verdict": "真实威胁|存疑|误报", "confidence": "高|中|低",
  "risk_level": "严重|高|中|低|无", "summary": "", "evidence_facts": [{"fact": "", "source_tool": "", "query": "", "supports": "威胁|良性|中性"}],
  "analysis": "", "false_positive_reason": "", "missing_data": [], "attack_chain": "",
  "injection_detected": false, "recommended_actions": [], "tuning_suggestion": ""
}\n\n`)
  }
];

const metrics = {
  first: measured => measured.size.first,
  peak: measured => measured.size.peak,
  review: measured => measured.size.review,
  flow: measured => measured.size.flow,
  system: measured => measured.system.total
};
const readable = { first: '首轮', peak: '峰值轮', review: '复核轮', flow: '全流程', system: '系统段' };
const savings = (before, after) => ((before - after) / before) * 100;

async function baseCommit() {
  const arg = process.argv.find(argument => argument.startsWith('--base='));
  if (arg) return arg.slice(7);
  const recon = JSON.parse(await readFile(path.join(repoRoot, '.pi-worktree-recon.json'), 'utf8'));
  return recon.base;
}

async function exportTree(commit) {
  const directory = await mkdtemp(path.join(tmpdir(), `hids-base-${commit.slice(0, 7)}-`));
  // 二进制安全的导出：git archive 直接管道给 tar，不经 Node 的字符串缓冲。
  await run('bash', ['-c', `git -C "$0" archive "$1" | tar -x -C "$2"`, repoRoot, commit, directory]);
  return directory;
}

async function copyTree(source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-mutant-'));
  await cp(source, directory, { recursive: true,
    filter: file => !file.includes(`${path.sep}.git`) && !file.includes(`${path.sep}node_modules`) });
  return directory;
}

function mutateSource(text, mutation) {
  if (mutation.apply) {
    const mutated = mutation.apply(text);
    if (mutated === text) throw new Error(`变异「${mutation.id}」锚点没匹配上`);
    return mutated;
  }
  const occurrences = text.split(mutation.from).length - 1;
  if (occurrences !== mutation.count) {
    throw new Error(`变异「${mutation.id}」锚点出现 ${occurrences} 次（期望 ${mutation.count}）`);
  }
  return text.replaceAll(mutation.from, mutation.to);
}

async function measureMutant(mutation) {
  const directory = await copyTree(repoRoot);
  try {
    const file = path.join(directory, mutation.file);
    const source = await readFile(file, 'utf8');
    await writeFile(file, mutateSource(source, mutation));
    return await measure(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const commit = await baseCommit();
const baseTree = await exportTree(commit);
let failed = 0;
const lines = [];
const say = line => { lines.push(line); console.log(line); };
try {
  say(`# P003-T039 上下文体积：前后对比 + 变异验红（基线 ${commit.slice(0, 7)}）`);
  const [base, current] = [await measure(baseTree), await measure(repoRoot)];
  say(`# 场景：honeypot syslog 主路径，${current.profile.requests} 次请求，事件原文 ${current.profile.eventRawBytes} 字`);
  say('');
  say('指标        基线      现在      省');
  for (const key of ['first', 'peak', 'review', 'flow']) {
    const before = metrics[key](base);
    const after = metrics[key](current);
    const saved = savings(before, after);
    const ok = saved >= 50;
    if (!ok) failed++;
    say(`${readable[key].padEnd(8)} ${String(before).padStart(8)} ${String(after).padStart(8)} ${saved.toFixed(1).padStart(6)}%  ${ok ? 'PASS' : 'FAIL（目标 ≥50%）'}`);
  }
  say(`${readable.system.padEnd(8)} ${String(metrics.system(base)).padStart(8)} ${String(metrics.system(current)).padStart(8)} ` +
    `${savings(metrics.system(base), metrics.system(current)).toFixed(1).padStart(6)}%  （A7 口径：工具名清单不再每轮进系统段）`);
  say('');
  say('# 变异：逐项回退，对应数字必须变差');
  for (const mutation of candidates) {
    const before = metrics[mutation.metric](current);
    try {
      const mutated = await measureMutant(mutation);
      const after = metrics[mutation.metric](mutated);
      const regressed = after > before * 1.005;
      if (!regressed) failed++;
      say(`${regressed ? 'PASS' : 'FAIL'} 变异 ${mutation.id}「${mutation.label}」→ ${readable[mutation.metric]} ${before} → ${after}` +
        `${regressed ? '（变差，改动有效）' : '（没变差：这项改动是白改的）'}`);
    } catch (error) {
      failed++;
      say(`FAIL 变异 ${mutation.id}「${mutation.label}」→ ${error.message}`);
    }
  }
  say('');
  say(failed ? `# 失败项 ${failed} 个` : '# 全部通过（四项 ≥50%，8 条变异各自验红）');
} finally {
  await rm(baseTree, { recursive: true, force: true });
}
await writeFile(path.join(path.dirname(new URL(import.meta.url).pathname), 'context-size.txt'), `${lines.join('\n')}\n`);
process.exit(failed ? 1 : 0);
