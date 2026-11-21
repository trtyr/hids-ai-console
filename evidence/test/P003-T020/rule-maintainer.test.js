// P003-T020 单测：规则维护者改已有规则时，原有条件必须还在、且不许更宽（放宽就不落盘）。
// 全部走公开接口 `RegoRuleMaintainer.maintain()`，不用真模型、不碰真实网络与仓库里的 rules/ 目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegoRuleMaintainer } from '../../../server.js';
import { RuleStore } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 现场测试那条规则的原版（P003-T020 A2 的目标状态）。
const ORIGINAL = `package hids.rules.webshell_drop

# name: WebShell 落地脚本
# description: webshell 告警落在 /tmp 下、路径以 .jsp 结尾，且主机非空

default match := false

match if {
  input.type == "webshell"
  input.host != ""
  startswith(input.path, "/tmp/")
  endswith(input.path, ".jsp")
}
`;

// 现场测试被维护者写出来的放宽版：前缀 `/tmp/` 收成 `/tmp`，还多了一条现场测试排除。
const WIDENED = `package hids.rules.webshell_drop

# name: WebShell 落地脚本
# description: webshell 告警落在 /tmp 下、路径以 .jsp 结尾、主机非空，且排除现场测试注入的样例文件

default match := false

match if {
  input.type == "webshell"
  startswith(input.path, "/tmp")
  endswith(input.path, ".jsp")
  input.host != ""
  not contains(input.path, "hids-live-test")
}
`;

const BASE = {
  type: 'input.type == "webshell"',
  host: 'input.host != ""',
  tmpSlash: 'startswith(input.path, "/tmp/")',
  jsp: 'endswith(input.path, ".jsp")'
};

function ruleFile(body, { name = 'WebShell 落地脚本', id = 'webshell_drop' } = {}) {
  return `package hids.rules.${id}\n\n# name: ${name}\n\ndefault match := false\n\nmatch if {\n${body
    .map(line => `  ${line}`).join('\n')}\n}\n`;
}

// 一个规则目录 + 一个只会回一条候选正文的假模型。
async function harness(initial) {
  const root = await mkdtemp(path.join(tmpdir(), 'p003t020-'));
  const rulesDir = path.join(root, 'rules');
  await mkdir(rulesDir, { recursive: true });
  for (const [file, source] of Object.entries(initial)) await writeFile(path.join(rulesDir, file), source, 'utf8');
  let candidate = null;
  const model = { complete: async () => ({ content: JSON.stringify(candidate) }) };
  const prompts = { load: async () => ({ prompts: { rule: '规则维护提示词（单测桩）' } }) };
  const store = new RuleStore(rulesDir);
  const maintainer = new RegoRuleMaintainer(model, store, prompts);
  return {
    root, rulesDir, store,
    /** 让假模型回这份候选正文，然后跑一轮维护。 */
    async run(id, rego) {
      candidate = { ready: true, id, name: 'WebShell 落地脚本', description: '单测', reason: '单测', rego };
      return maintainer.maintain({ caseId: 'c1', eventType: 'webshell', reason: '误报理由够长的一条', who: 'ops', alert: {}, ruleIds: [] });
    },
    async snapshot() {
      const files = (await readdir(rulesDir)).sort();
      const contents = {};
      for (const file of files) contents[file] = await readFile(path.join(rulesDir, file), 'utf8');
      return { files, contents };
    },
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  };
}

/* ---------------- A1：放宽原条件就拒绝 ---------------- */

test('A1 前缀从 /tmp/ 收成 /tmp：判放宽，拒绝落盘，目录一字不变', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const before = await h.snapshot();
    const rego = ruleFile([BASE.type, BASE.host, 'startswith(input.path, "/tmp")', BASE.jsp]);
    await assert.rejects(() => h.run('webshell_drop', rego),
      error => /放宽了原有限制条件/.test(error.message) && error.message.includes('/tmp/'));
    const after = await h.snapshot();
    assert.deepEqual(after, before); // 不落盘：文件名、内容、临时文件都没有
  } finally { await h.cleanup(); }
});

test('A1 后缀从 .jsp 收成 .js：判放宽，拒绝落盘', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const before = await h.snapshot();
    const rego = ruleFile([BASE.type, BASE.host, BASE.tmpSlash, 'endswith(input.path, ".js")']);
    await assert.rejects(() => h.run('webshell_drop', rego), /放宽了原有限制条件/);
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.cleanup(); }
});

test('A1 删掉主机非空条件：判放宽，拒绝落盘', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const before = await h.snapshot();
    const rego = ruleFile([BASE.type, BASE.tmpSlash, BASE.jsp]);
    await assert.rejects(() => h.run('webshell_drop', rego),
      error => /放宽了原有限制条件/.test(error.message) && error.message.includes('input.host != ""'));
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.cleanup(); }
});

test('A1 现存的现场测试排除被删掉：判放宽，拒绝落盘', async () => {
  const h = await harness({ 'webshell_drop.rego': WIDENED });
  try {
    const before = await h.snapshot();
    const rego = ruleFile([BASE.type, BASE.host, 'startswith(input.path, "/tmp")', BASE.jsp]);
    await assert.rejects(() => h.run('webshell_drop', rego), /放宽了原有限制条件/);
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.cleanup(); }
});

test('A1 取反方向：not startswith 的针收窄算放宽，拉长算收紧', async () => {
  const h = await harness({ 'webshell_drop.rego': ruleFile([BASE.type, 'not startswith(input.path, "/usr/")']) });
  try {
    const before = await h.snapshot();
    // 取反里的针变窄（/usr/ → /usr/local/）= 放行的路径变多 = 放宽。
    const wider = ruleFile([BASE.type, 'not startswith(input.path, "/usr/local/")']);
    await assert.rejects(() => h.run('webshell_drop', wider), /放宽了原有限制条件/);
    assert.deepEqual(await h.snapshot(), before);
    // 针变宽（/usr/ → /usr）后取反覆盖更多路径 = 收紧，放行。
    const tighter = ruleFile([BASE.type, 'not startswith(input.path, "/usr")']);
    assert.equal((await h.run('webshell_drop', tighter)).action, 'update');
  } finally { await h.cleanup(); }
});

test('A1 比较值被换掉（== "webshell" → == "web_shell"）：判放宽，拒绝落盘', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const before = await h.snapshot();
    const rego = ruleFile(['input.type == "web_shell"', BASE.host, BASE.tmpSlash, BASE.jsp]);
    await assert.rejects(() => h.run('webshell_drop', rego), /放宽了原有限制条件/);
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.cleanup(); }
});

test('A3 现场测试那份候选正文（前缀 /tmp + hids-live-test 排除）原样重放：拒绝落盘', async () => {
  // 就是 2026-11-19 现场测试里维护者交出来的那份（docs/_meta/live-test-2026-11-19.md）。
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const before = await h.snapshot();
    await assert.rejects(() => h.run('webshell_drop', WIDENED),
      error => /放宽了原有限制条件/.test(error.message) && error.message.includes('startswith(input.path, "/tmp/")'));
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.cleanup(); }
});

/* ---------------- A2：撤销现场测试排除是收紧，必须放行 ---------------- */

test('A2 前缀从放宽的 /tmp 收回 /tmp/（其它条件原样保留）：收紧，放行并落盘', async () => {
  const h = await harness({ 'webshell_drop.rego': WIDENED });
  try {
    const result = await h.run('webshell_drop', WIDENED.replace('startswith(input.path, "/tmp")', 'startswith(input.path, "/tmp/")'));
    assert.equal(result.action, 'update');
    assert.equal(result.file, 'webshell_drop.rego');
    assert.match(await readFile(path.join(h.rulesDir, 'webshell_drop.rego'), 'utf8'), /startswith\(input\.path, "\/tmp\/"\)/);
  } finally { await h.cleanup(); }
});

// 撤销现存排除不归维护者：删条件一律算放宽（fail closed，不认「这条排除是不是测试留下的」）。
// 现场那条由人工改回（本卡 rules/webshell_drop.rego 就是原版），维护者只能再加更严的条件。
test('A2 撤销现存排除由人工完成，维护者删它会被拒', async () => {
  const h = await harness({ 'webshell_drop.rego': WIDENED });
  try {
    const before = await h.snapshot();
    await assert.rejects(() => h.run('webshell_drop', ORIGINAL),
      error => /放宽了原有限制条件/.test(error.message) && error.message.includes('hids-live-test'));
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.cleanup(); }
});

test('A2 仓库里的 rules/webshell_drop.rego 是原版：前缀 /tmp/、没有 hids-live-test 排除', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'rules/webshell_drop.rego'), 'utf8');
  assert.match(source, /startswith\(input\.path, "\/tmp\/"\)/);
  assert.ok(!source.includes('/tmp"'), '前缀不能是不带斜杠的 /tmp');
  assert.ok(!source.includes('hids-live-test'), '现场测试排除必须撤掉');
  // 求值面：现场测试那个文件名现在照旧命中（排除撤掉后不该被跳过）。
  const evaluated = await new RuleStore(path.join(REPO_ROOT, 'rules'))
    .evaluate({ type: 'webshell', host: '192.168.24.21', path: '/tmp/hids-live-test.jsp' });
  assert.deepEqual(evaluated.matched.map(item => item.id), ['webshell_drop']);
  // 前缀还是 /tmp/：放宽成 /tmp 后这里会多一条命中，所以这条断言能盯住“又悄悄少写一个斜杠”。
  const widenedPrefix = await new RuleStore(path.join(REPO_ROOT, 'rules'))
    .evaluate({ type: 'webshell', host: '192.168.24.21', path: '/tmpfoo/a.jsp' });
  assert.deepEqual(widenedPrefix.matched, []);
});

/* ---------------- 收紧与新增不受这条约束 ---------------- */

test('收紧放行：原条件全留、再加一条排除', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const tighter = [...Object.values(BASE), 'not contains(input.path, "hids-live-test")'];
    const result = await h.run('webshell_drop', ruleFile(tighter));
    assert.equal(result.action, 'update');
    assert.match(await readFile(path.join(h.rulesDir, 'webshell_drop.rego'), 'utf8'), /hids-live-test/);
  } finally { await h.cleanup(); }
});

test('前缀加长算收紧（/tmp/ → /tmp/shell）：放行', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const tighter = ruleFile([BASE.type, BASE.host, 'startswith(input.path, "/tmp/shell")', BASE.jsp]);
    assert.equal((await h.run('webshell_drop', tighter)).action, 'update');
  } finally { await h.cleanup(); }
});

test('新增一条规则没有原条件可放宽：放行', async () => {
  const h = await harness({ 'webshell_drop.rego': ORIGINAL });
  try {
    const added = ruleFile(['input.type == "webshell"'], { id: 'ops_allow', name: '运维放行' });
    const result = await h.run('ops_allow', added);
    assert.equal(result.action, 'add');
    assert.equal(result.file, 'ops_allow.rego');
    // 原规则一个字都没动。
    assert.equal(await readFile(path.join(h.rulesDir, 'webshell_drop.rego'), 'utf8'), ORIGINAL);
  } finally { await h.cleanup(); }
});
