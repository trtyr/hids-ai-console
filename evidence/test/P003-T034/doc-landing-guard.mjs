// P003-T034 A5 守卫（测试席 · 何东阳，集成后重走轮）——文档落点表述的账：
// 数据管理（§3.7）与 openapi 数据管理段必须把运行态落点写成「数据根」，不许再出现「仓内 .data/」当落点。
// 这是文档即契约的 e2e 探针：只读 docs / openapi / .env.example，不读实现，不跑进程。
// 跑法：node evidence/test/P003-T034/doc-landing-guard.mjs   退出码 0 = 全过，1 = 有红。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = rel => readFileSync(path.join(root, rel), 'utf8');
let failures = 0;
const ok = (name, detail = '') => console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`);
const bad = (name, detail) => { failures += 1; console.log(`FAIL ${name} :: ${detail}`); };
const assert = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

// ── 1. docs/modules/http-api.md §3.7（数据管理）──────────────────────────
const httpApi = read('docs/modules/http-api.md');
const start = httpApi.indexOf('### 3.7 数据管理');
const end = httpApi.indexOf('\n## 4.');
assert(start > 0 && end > start, 'http-api.md 找得到 §3.7 区段（到 §4 为止）', `start=${start} end=${end}`);
const section = start > 0 && end > start ? httpApi.slice(start, end) : '';

// 1.1 不许再出现「仓内 / 缺省 .data」当落点（历史旧位说明与注入目录例外不在此区段内）
const forbidden = [
  { re: /仓内\s*`?\.data/, why: '§3.7 里出现「仓内 .data」落点表述' },
  { re: /缺省\s*`?\.data/, why: '§3.7 里出现「缺省 .data」落点表述' },
  { re: /落仓内/, why: '§3.7 里出现「落仓内」表述' }
];
for (const { re, why } of forbidden) {
  const hit = section.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => re.test(line));
  assert(hit.length === 0, `§3.7 无「仓内/缺省 .data」落点：${re}`, why + ' → ' + hit.map(([n, l]) => `§3.7+${n}: ${l.trim().slice(0, 90)}`).join(' | '));
}

// 1.2 数据管理文档必须写出的落点（七类存储 + 归档 + 测试口径），逐条查原文
const requiredLandings = [
  ['给运维一眼看清数据根', '§3.7 开头把盘点对象写成数据根'],
  ['`<数据根>/cases`', 'cases 缺省落点 = <数据根>/cases'],
  ['`<数据根>/investigations`', 'investigations 缺省落点'],
  ['`<数据根>/trace-boards`', 'boards 缺省落点'],
  ['`<数据根>/wiki-sessions`', 'wiki_sessions 缺省落点'],
  ['`<数据根>/triage-monitor.json`', 'queue 缺省落点'],
  ['`<数据根>/config-overrides.json`', 'config_overrides 缺省落点'],
  ['数据根目录本身', 'logs 一类的盘点面 = 数据根顶层'],
  ['`<数据根>/archive/<kind>/', 'archive 落点'],
  ['`<数据根>/triage-monitor.json.archive.jsonl`', '队列归档落点'],
  ['测试不必碰真实数据根', '测试口径 = 真实数据根'],
  ['不碰真实数据根', '「不做什么」里的数据根口径']
];
for (const [needle, name] of requiredLandings) {
  assert(section.includes(needle), `§3.7 落点原文：${name}`, `缺「${needle}」`);
}

// 1.3 §3.6 里「清覆盖层」的手工动作也必须指数据根（该句在 §3.6，不在 §3.7 区段）
assert(httpApi.includes('手工删数据根下的 `config-overrides.json`'), '§3.6 清覆盖层的手工动作指数据根', '缺「手工删数据根下的 `config-overrides.json`」');

// ── 2. openapi.yaml（数据管理段 + schema description）───────────────────
const openapi = read('openapi.yaml');
const dotData = openapi.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /\.data\//.test(line));
assert(dotData.length === 0, 'openapi.yaml 全文零「.data/」落点', dotData.map(([n, l]) => `:${n}: ${l.trim().slice(0, 90)}`).join(' | '));
const openapiRequired = [
  ['`<数据根>/cases`', 'inventory 表 cases 缺省落点'],
  ['`<数据根>/archive/<kind>/', 'cleanup archive 落点'],
  ['运行态根目录（`HIDS_DATA_DIR`', 'data_dir 的根口径']
];
for (const [needle, name] of openapiRequired) {
  assert(openapi.includes(needle), `openapi 落点原文：${name}`, `缺「${needle}」`);
}

// ── 3. .env.example（键默认值说明）──────────────────────────────────────
const envExample = read('.env.example');
const envLines = envExample.split('\n');
const commentBefore = key => {
  const i = envLines.findIndex(line => line.startsWith(`${key}=`));
  if (i <= 0) return '';
  let j = i - 1;
  const out = [];
  while (j >= 0 && envLines[j].startsWith('#')) {
    out.unshift(envLines[j]);
    j -= 1;
  }
  return out.join('\n');
};
assert(/HIDS_DATA_DIR=/.test(envExample), '.env.example 收录 HIDS_DATA_DIR');
assert(commentBefore('HIDS_DATA_DIR').includes('~/.local/share/hids-ai-console'), '.env.example 的数据根默认值 = 全局位置', commentBefore('HIDS_DATA_DIR'));
assert(commentBefore('HIDS_WIKI_DIR').includes('<数据根>/wiki'), '.env.example 的判据库默认值 = <数据根>/wiki', commentBefore('HIDS_WIKI_DIR'));
assert(commentBefore('HIDS_PROMPT_STORE_FILE').includes('<数据根>/prompt-overrides.json'), '.env.example 的提示词覆盖默认值 = <数据根>/prompt-overrides.json', commentBefore('HIDS_PROMPT_STORE_FILE'));

// ── 4. 旧位说明必须是「否定句 / 历史句」，不许当现行落点 ─────────────────
const architecture = read('docs/architecture.md');
assert(architecture.includes('旧位不自动搬'), 'architecture.md §8.1 有 A4「旧位不自动搬」说明');
assert(/P003-T019 时仓内/.test(architecture) || /P003-T019 的仓内 `\.data\/`/.test(architecture),
  'architecture.md 的仓内 .data 只在 P003-T019 历史句里出现');

console.log(failures === 0 ? '\nALL PASS' : `\nFAILURES ${failures}`);
process.exit(failures === 0 ? 0 : 1);
