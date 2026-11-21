#!/usr/bin/env node
// 分层与规则门禁（P003-T075 / D034 §3 / D035 §2）。零依赖，Node 20+。
//
// 五条规则全在这里强制（每条都给出「违例位置」而不是只给数字）：
//   R-STRUCT   文件落点：产品 .js 只能落在 src/contexts|interfaces|shared（scripts/*.mjs 与 *.test.js 豁免）；
//              src/** 不许 import 仓库根旧 .js（迁移期强制，否则「每批 0 违规」是空验收）
//   R-STRUCT+  application/ 与 interfaces/ 不许自己 new 适配器（收 port）——检测 `new XxxStore(` / `new XxxClient(` 等
//   R-STRUCT   跨上下文：只许 import 对方 application/**（端口）与 shared/**；domain 不许 import infrastructure、
//              node:http、node:fs；按上下文折叠后查环
//   R-ERROR    HTTP 错误响应不许自己构造：`json(res, <4xx|5xx 字面量>)` 只许出现在白名单（shared/errors 与
//              error-model 中间件）；`res.writeHead(<4xx|5xx 字面量>)` 同理。判据是**词法扫描**（跳过字符串、
//              模板串、注释后按括号配对找第 2 个实参），不是正则字面量——维护端 19 处是无空格写法 `json(res,404,{...})`
//   R-LOG      console.* 只许出现在 src/shared/logging/**、scripts/** 与测试里
//
// 基线机制：首跑 `--write-baseline` 把当前违例快照存进 scripts/check-layers-baseline.json；
// 之后每次运行，**基线之外的违例**判失败（exit 1），基线内的打印出来并计入下账清单。
// 每批迁移把对应基线项清零（删掉基线里的条目），终态 = 基线空对象 + 输出 0。
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const writeBaseline = args.includes('--write-baseline');
const baselineFile = path.join(repo, 'scripts', 'check-layers-baseline.json');

// ── 词法扫描：把源码剥成「代码骨架」，字符串/模板串/注释都换成空格，长度不变 ─────────
// 判据全部跑在骨架上：`json(res,404,...)` 与 `json (res, 404, ...)` 都能抓到，
// 字符串里的 "json(res,500)" 示例文案、注释里的示例都不会误报。
function skeleton(source) {
  const out = source.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const n = source.length;
  // 前一个非空白有效字符 + 最近一个词：判「这个 / 是除号还是正则开头」。
  const lastMeaningful = () => { let k = out.length - 1; while (k >= 0 && /\s/.test(out[k])) k -= 1; return out[k] ?? ''; };
  const lastWord = () => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    const end = k + 1;
    while (k >= 0 && /\w/.test(out[k])) k -= 1;
    return out.slice(k + 1, end).join('');
  };
  const regexStartsHere = () => {
    const prev = lastMeaningful();
    if (!prev) return true;
    if ('(,=:[!&|?{};+*%~^<>-'.includes(prev)) return true;
    if (prev === '/') return true;
    return ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'].includes(lastWord());
  };
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); blank(i, end < 0 ? n : end); i = end < 0 ? n : end; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); blank(i, end < 0 ? n : end + 2); i = end < 0 ? n : end + 2; continue; }
    if (ch === '/' && regexStartsHere()) {
      // 正则字面量：整个置空。转义与字符类里的 / 都不终止。
      const start = i;
      i += 1;
      let inClass = false, terminated = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') { inClass = true; i += 1; continue; }
        if (c === ']') { inClass = false; i += 1; continue; }
        if (c === '\n') break; // 正则不跨行：跨了就当除号处理过的老代码，别吞整个文件
        if (c === '/' && !inClass) { terminated = true; i += 1; break; }
        i += 1;
      }
      if (terminated) { while (i < n && /[a-z]/i.test(source[i])) i += 1; } // flags
      blank(start, Math.min(i, n));
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { out[j] = ' '; out[j + 1] = ' '; j += 2; continue; }
        if (source[j] === ch) { j += 1; break; }
        if (ch === '`' && source[j] === '$' && source[j + 1] === '{') {
          // 模板串里的 ${...} 是真代码：剥到配对的 }，字面量部分置空、代码部分递归保留。
          const innerStart = j + 2;
          let depth = 1, k = innerStart;
          while (k < n && depth > 0) {
            const c = source[k];
            if (c === '{') depth += 1;
            else if (c === '}') depth -= 1;
            else if (c === '"' || c === "'" || c === '`') {
              const q = c; k += 1;
              while (k < n && source[k] !== q) { if (source[k] === '\\') k += 1; k += 1; }
            }
            k += 1;
          }
          blank(j, innerStart);
          const inner = skeleton(source.slice(innerStart, k - 1));
          for (let t = 0; t < inner.length; t++) out[innerStart + t] = inner[t];
          blank(k - 1, k);
          j = k;
          continue;
        }
        out[j] = ' '; j += 1;
      }
      out[i] = ' ';
      if (j < n) out[j] = ' '; // 闭引号也置空
      i = j; continue;
    }
    i += 1;
  }
  return out.join('');
}

// 从骨架里找 `json` 标识符调用，取第 2 个顶层实参；是 400..599 的数字字面量就报。
function findJsonStatusCalls(source, skeletonText) {
  const hits = [];
  const re = /\bjson\s*\(/g;
  let m;
  while ((m = re.exec(skeletonText))) {
    const callStart = m.index;
    let depth = 0;
    let argIndex = 0;
    const args = ['', ''];
    let i = m.index + m[0].length - 1; // 指向 '('
    for (; i < skeletonText.length; i++) {
      const ch = skeletonText[i];
      if (ch === '(') { depth += 1; if (depth === 1) continue; }
      if (ch === ')') { depth -= 1; if (depth === 0) break; }
      if (depth === 1 && ch === ',') { argIndex += 1; continue; }
      if (argIndex < 2 && argIndex >= 0) args[argIndex] += ch;
    }
    const second = args[1].trim();
    if (/^[1-5]\d{2}$/.test(second) && Number(second) >= 400) {
      const line = source.slice(0, callStart).split('\n').length;
      hits.push({ line, snippet: (source.split('\n')[line - 1] || '').trim().slice(0, 160), status: Number(second) });
    }
    re.lastIndex = i;
  }
  return hits;
}

const walk = (dir, base = dir) => readdirSync(base, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'web'
    || entry.name === 'evidence' || entry.name === 'docs' || entry.name.startsWith('.')) return [];
  const full = path.join(base, entry.name);
  if (entry.isDirectory()) return walk(dir, full);
  return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
});

const rel = file => path.relative(repo, file).replaceAll('\\', '/');
// 根目录白名单：进程入口按设计住在仓根（package.json 的 start 脚本指向它）。
const ROOT_ALLOWED = new Set(['server.js']);
const isProductJs = file => {
  const r = rel(file);
  if (r.endsWith('.test.js') || r.startsWith('scripts/') || ROOT_ALLOWED.has(r)) return false;
  return true;
};
const inSrc = r => r.startsWith('src/');
const contextOf = r => {
  const m = r.match(/^src\/contexts\/([a-z-]+)\//);
  return m ? m[1] : r.startsWith('src/shared/') ? 'shared'
    : r.startsWith('src/interfaces/') ? 'interfaces' : null;
};
const layerOf = r => {
  const m = r.match(/^src\/(?:contexts\/[a-z-]+\/)?([a-z]+)\//);
  return m ? m[1] : null;
};

const errors = { 'struct.file-placement': [], 'struct.src-root-import': [], 'struct.domain-boundary': [],
  'struct.cross-context': [], 'struct.app-new-adapter': [], 'struct.cycle': [],
  'error.json-status': [], 'error.writehead-status': [], 'log.console': [] };

// R-STRUCT 文件落点：产品 .js（非测试、非脚本）必须在 src/ 下。
// 迁移期：仓库根的旧 .js 在基线里挂着，每批删完对应条目；src/ 之外新出现的才是真违例。
const allJs = existsSync(path.join(repo, 'src')) ? walk(path.join(repo, 'src')) : [];
for (const file of walk(repo)) {
  if (!isProductJs(file)) continue;
  if (!inSrc(rel(file))) errors['struct.file-placement'].push({ file: rel(file) });
}

// src/** 的 import 图（供跨上下文 / domain 边界 / 查环 / src→根）
const importGraph = new Map();
for (const file of allJs) {
  const r = rel(file);
  const text = readFileSync(file, 'utf8');
  const skel = skeleton(text);
  const specs = [...skel.matchAll(/import\s+[^'"]*from\s*['"]([^'"]+)['"]/g)].map(m => m[1])
    .concat([...skel.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]));
  const targets = specs.map(spec => {
    if (!spec.startsWith('.')) return spec.startsWith('node:') ? spec : `pkg:${spec}`;
    return rel(path.resolve(path.dirname(file), spec));
  });
  importGraph.set(r, targets);

  // src → 仓库根旧 .js（R-STRUCT 迁移期强制）
  for (const target of targets)
    if (!target.startsWith('src/') && target.endsWith('.js'))
      errors['struct.src-root-import'].push({ file: r, target });

  // domain 边界：不许 import infrastructure、interfaces、node 内建 I/O（案卷走 CaseFilePort）
  if (layerOf(r) === 'domain') {
    for (const target of targets) {
      const targetLayer = layerOf(target);
      if (targetLayer === 'infrastructure' || targetLayer === 'interfaces')
        errors['struct.domain-boundary'].push({ file: r, target, why: 'domain → infrastructure/interfaces' });
      if (/^node:(http|fs|dgram|net)$/.test(target))
        errors['struct.domain-boundary'].push({ file: r, target, why: 'domain → node 内建 I/O' });
    }
  }

  // 跨上下文：只许 import 对方 application/** 与 shared/**；interfaces 只许 application + shared
  const ctx = contextOf(r);
  for (const target of targets) {
    const targetCtx = contextOf(target);
    if (!targetCtx || targetCtx === ctx) continue;
    const targetLayer = layerOf(target);
    if (!(targetCtx === 'shared' || targetLayer === 'application'))
      errors['struct.cross-context'].push({ file: r, target, why: `${ctx} → ${targetCtx}/${targetLayer ?? '?'}` });
  }
}

// 按上下文折叠查环（文件级无环拦不住上下文环）
{
  const fold = r => contextOf(r) ?? null;
  const graph = new Map();
  for (const [file, targets] of importGraph) {
    const from = fold(file);
    if (!from) continue;
    const set = graph.get(from) ?? new Set();
    for (const target of targets) {
      const to = fold(target);
      if (to && to !== from) set.add(to);
    }
    graph.set(from, set);
  }
  const state = new Map(); // undefined=未访, 0=在栈, 1=完成
  const stack = [];
  const visit = node => {
    if (state.get(node) === 1) return;
    if (state.get(node) === 0) {
      errors['struct.cycle'].push({ cycle: [...stack.slice(stack.indexOf(node)), node].join(' → ') });
      return;
    }
    state.set(node, 0); stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop(); state.set(node, 1);
  };
  for (const node of graph.keys()) visit(node);
}

// R-STRUCT+ / R-ERROR / R-LOG：**横向覆盖**——src/ 里的产品文件 + 仓库根的迁移遗留都逐个过骨架
//（R-ERROR / R-LOG 管的是「每一个 HTTP 处理、每一行日志」，不看文件住哪；根目录遗留每批清零）。
const ADAPTER_SUFFIXES = ['Store', 'Client', 'Gateway', 'Toolbox', 'Engine', 'Session'];
const JSON_STATUS_ALLOWED = new Set(['src/shared/errors.js', 'src/interfaces/http/business/middleware/error-model.js']);
const WRITEHEAD_STATUS_ALLOWED = new Set([...JSON_STATUS_ALLOWED, 'src/interfaces/http/business/middleware/auth.js',
  'src/interfaces/http/business/middleware/request-id.js', 'src/interfaces/udp/syslog/receiver.js']);
const CONSOLE_ALLOWED = r => r.startsWith('src/shared/logging/') || r.startsWith('scripts/');

const scannedFiles = [...allJs, ...walk(repo).filter(isProductJs)];
for (const file of scannedFiles) {
  const r = rel(file);
  const text = readFileSync(file, 'utf8');
  const skel = skeleton(text);
  if (layerOf(r) === 'application' || r.startsWith('src/interfaces/')) {
    const re = /new\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(skel)))
      if (ADAPTER_SUFFIXES.some(suffix => m[1].endsWith(suffix)))
        errors['struct.app-new-adapter'].push({ file: r, line: text.slice(0, m.index).split('\n').length, name: m[1] });
  }
  if (!JSON_STATUS_ALLOWED.has(r))
    for (const hit of findJsonStatusCalls(text, skel))
      errors['error.json-status'].push({ file: r, line: hit.line, status: hit.status, snippet: hit.snippet });
  if (!WRITEHEAD_STATUS_ALLOWED.has(r)) {
    const re = /writeHead\s*\(\s*([1-5]\d{2})\b/g;
    let m;
    while ((m = re.exec(skel)))
      if (Number(m[1]) >= 400)
        errors['error.writehead-status'].push({ file: r, line: text.slice(0, m.index).split('\n').length, status: Number(m[1]) });
  }
  if (!CONSOLE_ALLOWED(r)) {
    const re = /\bconsole\s*\.\s*(log|error|warn|info|debug)\s*\(/g;
    let m;
    while ((m = re.exec(skel)))
      errors['log.console'].push({ file: r, line: text.slice(0, m.index).split('\n').length });
  }
}

// ── 基线对比与输出 ────────────────────────────────────────────────────────────
const flat = {};
for (const [kind, list] of Object.entries(errors))
  for (const item of list) {
    const key = `${kind}|${JSON.stringify(item)}`;
    flat[key] = { kind, ...item };
  }

let baseline = {};
if (existsSync(baselineFile)) baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
const baselineKeys = new Set(Object.keys(baseline));
const currentKeys = new Set(Object.keys(flat));
const unexpected = [...currentKeys].filter(key => !baselineKeys.has(key));
const resolved = [...baselineKeys].filter(key => !currentKeys.has(key));

if (writeBaseline) {
  writeFileSync(baselineFile, `${JSON.stringify(flat, null, 2)}\n`);
  console.log(`check-layers: baseline written — ${Object.keys(flat).length} findings → scripts/check-layers-baseline.json`);
  process.exitCode = 0;
} else {
  const byKind = {};
  for (const key of currentKeys) { const kind = flat[key].kind; byKind[kind] = (byKind[kind] ?? 0) + 1; }
  console.log('check-layers 现状：');
  for (const [kind, count] of Object.entries(byKind).sort()) console.log(`  ${kind}: ${count}`);
  if (resolved.length) console.log(`基线中已清零 ${resolved.length} 条（记得从 check-layers-baseline.json 删掉它们）`);
  if (unexpected.length) {
    console.log(`\n基线之外的违例 ${unexpected.length} 条：`);
    for (const key of unexpected) console.log(`  ✗ [${flat[key].kind}] ${key.slice(key.indexOf('|') + 1)}`);
    process.exitCode = 1;
  } else console.log('\n基线之外 0 违例 ✓');
}
