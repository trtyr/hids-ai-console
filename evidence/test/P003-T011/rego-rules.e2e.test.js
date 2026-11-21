// P003-T011 验收：Rego 规则库与求值（黑盒 HTTP）
//
// 判据只来自文档：
//   - openapi.yaml  /api/rules、/api/rules/{id}、/api/rules/evaluate
//                  schemas RegoRuleSummary/RegoRule/RegoRuleList/RegoRuleMatch/RegoEvaluation/AlertFact
//                  response RuleLibraryError/BadRequest/NotFound（Error = {error:string}）
//   - docs/modules/http-api.md  方法不匹配落 404；readJSON 缺省上限 8192（F1/F2）
//   - rules/*.rego 是交付的规则数据（策略内容），只当作输入数据读，不读任何实现文件
//
// A1 一规则一 .rego、# name: 显示名、按 id 逐字读回原文
// A2 七字段（host/peer/command/user/path/type/source_ip）都能被规则取值、没写的字段不限制、缺字段按 Rego undefined
// A3 求值返回命中规则名与 Rego 正文、无命中明确空 {count:0,matched:[]}
//
// 只写集成/e2e（真 HTTP，真规则目录），不写单测。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（fp-sessions 写、wiki/rules 读→种子）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../../server.js';
import { RuleStore } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const rulesDir = join(repoRoot, 'rules');

const DOC_FIELDS = ['host', 'peer', 'command', 'user', 'path', 'type', 'source_ip'];

// ---- 被测服务：真 HTTP，真 createServer；第 15 个参数是文档化的规则库注入点 ----
function spawnServer(ruleStore) {
  const server = createServer(null, null, null, null, null, null, null,
    { user: undefined, password: undefined }, null, undefined, undefined, undefined, undefined, undefined, ruleStore);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// 手写 http.request 而不用 fetch：不能让它把 `..` 之类的路径段先在客户端归一化掉。
function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* 保留 text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const jsonBody = (v) => JSON.stringify(v);
const getJSON = (port, path) => request(port, path);
const postJSON = (port, path, body) => request(port, path, {
  method: 'POST', body: typeof body === 'string' ? body : jsonBody(body),
  headers: { 'content-type': 'application/json' },
});

function assertErrorShape(res, { status, label }) {
  assert.equal(res.status, status, `${label}: 期望 ${status}，实测 ${res.status}，正文 ${res.text.slice(0, 200)}`);
  assert.ok(res.json && typeof res.json === 'object', `${label}: 正文不是 JSON 对象：${res.text.slice(0, 200)}`);
  assert.equal(typeof res.json.error, 'string', `${label}: Error 形状要求 error 是字符串，实测 ${JSON.stringify(res.json)}`);
  assert.ok(res.json.error.trim().length > 0, `${label}: error 不能是空串`);
}

// 规则原文（数据文件，不是实现文件）
function ruleFiles() {
  return readdirSync(rulesDir).filter((f) => f.endsWith('.rego')).sort();
}
const ruleSource = (file) => readFileSync(join(rulesDir, file), 'utf8');

// 文档化的 7 个事实字段里，某条规则真正读到的那些（从规则原文推，不依赖实现）
function referencedFields(rego) {
  return [...new Set([...rego.matchAll(/input\.([a-z_]+)/g)].map((m) => m[1]))].sort();
}

let main; // 真规则库（默认 RuleStore 读仓内 rules/）
before(async () => { main = await spawnServer(undefined); });
after(async () => { await main?.close(); });

// =====================================================================
// A1 一条规则一份 Rego，有名字，能列、能按 id 读到原文
// =====================================================================

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('A1 列表：每条规则一个 .rego、字段齐全、按 id 排序', { timeout: 15000 }, async () => {
  const res = await getJSON(main.port, '/api/rules');
  assert.equal(res.status, 200, `正文 ${res.text.slice(0, 200)}`);
  assert.match(res.headers['content-type'] || '', /^application\/json/, 'content-type 应为 application/json');
  const body = res.json;
  assert.deepEqual(Object.keys(body).sort(), ['count', 'rules'], 'RegoRuleList additionalProperties:false');

  const files = ruleFiles();
  assert.ok(files.length >= 1, 'rules/ 下至少一条规则');
  assert.equal(body.count, body.rules.length, 'count 必须等于 rules 长度');
  assert.equal(body.count, files.length, `一条规则一份 .rego：目录 ${files.length} 份，接口列了 ${body.count} 条`);

  const ids = body.rules.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort(), '按 id 排序');
  assert.equal(new Set(ids).size, ids.length, 'id 不重复');
  assert.equal(new Set(body.rules.map((r) => r.file)).size, body.rules.length, '一规则一文件：file 不重复');

  for (const r of body.rules) {
    assert.deepEqual(Object.keys(r).sort(), ['description', 'file', 'id', 'name'],
      `RegoRuleSummary additionalProperties:false，实测 ${JSON.stringify(Object.keys(r))}`);
    assert.match(r.id, /^[a-z][a-z0-9_]*$/, `id 不符合 ^[a-z][a-z0-9_]*$：${r.id}`);
    assert.equal(typeof r.name, 'string');
    assert.ok(r.name.length > 0, `${r.id}: 显示名不能为空`);
    assert.ok(r.description === null || typeof r.description === 'string', `${r.id}: description 必须是 string|null`);
    assert.equal(typeof r.file, 'string');
    assert.match(r.file, /^[A-Za-z0-9_.-]+\.rego$/, `${r.id}: file 是 rules/ 下的文件名（相对、无子路径）`);
    assert.ok(files.includes(r.file), `${r.id}: file=${r.file} 不在 rules/ 里`);
    assert.equal(Object.hasOwn(r, 'rego'), false, '列表不带 Rego 原文（RegoRuleSummary 无 rego 字段）');
  }
});

test('A1 一规则一文件：id 来自 package 最后一段、# name: 就是显示名、文件与规则一一对应', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  for (const r of list.rules) {
    const src = ruleSource(r.file);
    const pkg = src.match(/^package\s+hids\.rules\.([a-z][a-z0-9_]*)\s*$/m);
    assert.ok(pkg, `${r.file}: 缺 package hids.rules.<id>`);
    assert.equal(pkg[1], r.id, `${r.file}: id 取 package 最后一段，实测 ${pkg[1]} ≠ ${r.id}`);

    const nameLine = src.match(/^# name:[ \t]*(.*)$/m);
    assert.ok(nameLine, `${r.file}: 缺 # name:`);
    assert.equal(nameLine[1].trim(), r.name, `${r.file}: 显示名取 # name:`);

    const descLine = src.match(/^# description:[ \t]*(.*)$/m);
    assert.equal(r.description, descLine ? descLine[1].trim() : null,
      `${r.file}: description 取 # description:，没写是 null`);
  }
  // 每个 .rego 都恰好被列到一次（没有一份文件装两条规则，也没有漏列）
  assert.deepEqual([...list.rules].map((r) => r.file).sort(), ruleFiles());
});

test('A1 读原文：内容与文件逐字相同，元数据与列表一致', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  for (const item of list.rules) {
    const res = await getJSON(main.port, `/api/rules/${item.id}`);
    assert.equal(res.status, 200, `${item.id}: 正文 ${res.text.slice(0, 200)}`);
    const rule = res.json;
    assert.deepEqual(Object.keys(rule).sort(), ['description', 'file', 'id', 'name', 'rego', 'revision'],
      'RegoRule additionalProperties:false（T041 起 revision 必填：正文 sha256 前 16 位）');
    assert.match(rule.revision, /^[0-9a-f]{16}$/, `${item.id}: revision 是 16 位十六进制`);
    assert.equal(rule.id, item.id);
    assert.equal(rule.name, item.name);
    assert.equal(rule.description, item.description);
    assert.equal(rule.file, item.file);
    assert.equal(typeof rule.rego, 'string');
    assert.equal(rule.rego, ruleSource(item.file), `${item.id}: rego 必须逐字等于 ${item.file}（含注释、空行、换行结尾）`);
  }
});

test('A1 读原文：未知 id 404、非法 id 400、编码非法 400，且都不是 5xx', { timeout: 15000 }, async () => {
  assertErrorShape(await getJSON(main.port, '/api/rules/no_such_rule_zzz'), { status: 404, label: '未知 id' });

  const invalid = [
    '/api/rules/Bad',                       // 大写
    '/api/rules/1abc',                      // 数字开头
    '/api/rules/a-b',                       // 非法字符
    '/api/rules/a%20b',                     // 空格
    '/api/rules/',                          // 空 id
    '/api/rules/ssh_bruteforce%2F',         // 编码的斜杠
    '/api/rules/%2e%2e%2fserver',           // ../server
    '/api/rules/.',                         // 点
    '/api/rules//ssh_bruteforce',           // 双斜杠
    '/api/rules/%E8%A7%84%E5%88%99',        // 非 ASCII
  ];
  for (const path of invalid) {
    assertErrorShape(await getJSON(main.port, path), { status: 400, label: `非法 id ${path}` });
  }
  // 非法百分号编码不是「id 无效」而是「编码无效」，规格同样只承诺 400
  assertErrorShape(await getJSON(main.port, '/api/rules/%zz'), { status: 400, label: '非法编码' });
  // 合法格式但不存在（超长 id 也符合同一 pattern）→ 404，不是 400
  assertErrorShape(await getJSON(main.port, `/api/rules/${'a'.repeat(300)}`), { status: 404, label: '超长但合法 id' });
});

test('A1 列表与读原文幂等：连续 3 次 + 20 并发结果完全一致', { timeout: 15000 }, async () => {
  const first = (await getJSON(main.port, '/api/rules')).text;
  for (let i = 0; i < 3; i++) assert.equal((await getJSON(main.port, '/api/rules')).text, first, `第 ${i + 2} 次列表不一致`);
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => getJSON(main.port, '/api/rules')));
  for (const r of concurrent) {
    assert.equal(r.status, 200);
    assert.equal(r.text, first, '并发列表结果与单次不一致');
  }
  const reads = await Promise.all(listIds(first).map((id) => getJSON(main.port, `/api/rules/${id}`)));
  for (const r of reads) assert.equal(r.status, 200);
});
function listIds(text) { return JSON.parse(text).rules.map((r) => r.id); }

// =====================================================================
// A2 七个字段都能被规则取值；没写的字段不限制；缺字段按 Rego undefined
// =====================================================================

// 每条交付规则一条命中事实（按 rules/*.rego 的语义构造）
const HIT_FACT = {
  honeypot_probe: { type: 'honeypot', peer: '10.1.2.3', source_ip: '10.1.2.3', user: 'root' },
  ssh_bruteforce: { type: 'abnormal_login', source_ip: '10.1.2.3', command: 'ssh root@10.0.0.1' },
  webshell_drop: { type: 'webshell', host: 'web-01', path: '/tmp/upload/a.jsp' },
};

async function evaluate(fact) {
  const res = await postJSON(main.port, '/api/rules/evaluate', fact);
  assert.equal(res.status, 200, `求值应 200，实测 ${res.status}：${res.text.slice(0, 200)}`);
  return res.json;
}
const matchedIds = async (fact) => (await evaluate(fact)).matched.map((m) => m.id);

test('A2 规则引用的字段并集恰是文档七字段（host/peer/command/user/path/type/source_ip）', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  assert.deepEqual(Object.keys(HIT_FACT).sort(), list.rules.map((r) => r.id).sort(),
    '用例表必须覆盖每条交付规则（规则集变了这里先红）');
  const union = new Set();
  for (const r of list.rules) for (const f of referencedFields(ruleSource(r.file))) union.add(f);
  assert.deepEqual([...union].sort(), [...DOC_FIELDS].sort(),
    `七字段都要被规则真实引用，实测并集 ${[...union].sort().join(',')}`);
});

test('A2 每条规则：自己引用到的每个字段都真被取值——删掉就该不命中', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  for (const r of list.rules) {
    const base = HIT_FACT[r.id];
    assert.deepEqual(await matchedIds(base), [r.id], `${r.id}: 基准事实应只命中自己`);
    const fields = referencedFields(ruleSource(r.file));
    assert.ok(fields.length > 0, `${r.id}: 规则没引用任何 input 字段?`);
    for (const f of fields) {
      const fact = { ...base };
      delete fact[f];
      assert.ok(!(await matchedIds(fact)).includes(r.id),
        `${r.id}: 删掉字段 ${f} 后仍命中——该字段没被真正取值（或不是 Rego undefined 语义）`);
    }
  }
});

test('A2 每条规则：字段改成错误值不命中；!= 的字段改成别的非空值仍命中（严格相等）', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  for (const r of list.rules) {
    const src = ruleSource(r.file);
    const base = HIT_FACT[r.id];
    for (const f of referencedFields(src)) {
      const notEqual = new RegExp(`input\\.${f}\\s*!=`).test(src);
      const wrong = { ...base, [f]: 'zzz-mismatch-value' };
      if (notEqual) {
        assert.ok((await matchedIds(wrong)).includes(r.id), `${r.id}: ${f} 是 != 条件，改成非空值应仍命中`);
      } else {
        assert.ok(!(await matchedIds(wrong)).includes(r.id), `${r.id}: ${f} 改成错误值仍命中`);
      }
      const empty = { ...base, [f]: '' };
      assert.ok(!(await matchedIds(empty)).includes(r.id),
        `${r.id}: ${f} 置空串仍命中——空串条件/非空条件都该收紧`);
    }
  }
});

test('A2 没写的字段不限制：规则没引用的字段塞任意值（含对象/超长串）仍命中', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  for (const r of list.rules) {
    const used = new Set(referencedFields(ruleSource(r.file)));
    const junk = { ...HIT_FACT[r.id] };
    for (const f of DOC_FIELDS) if (!used.has(f)) junk[f] = f === 'host' ? { nested: true } : `junk-${f}-${'x'.repeat(200)}`;
    assert.deepEqual(await matchedIds(junk), [r.id],
      `${r.id}: 未引用字段（${DOC_FIELDS.filter((f) => !used.has(f)).join(',') || '无'}）应不参与判定`);
  }
});

test('A2 严格相等：字符串 "1" 不等于数字 1；非字符串值不崩、不当真', { timeout: 15000 }, async () => {
  const res = await postJSON(main.port, '/api/rules/evaluate', { type: 1 });
  assert.equal(res.status, 200, `非字符串字段值不应 5xx/400：${res.status} ${res.text.slice(0, 120)}`);
  assert.deepEqual(res.json, { count: 0, matched: [] });
  const numCmd = await postJSON(main.port, '/api/rules/evaluate',
    { type: 'abnormal_login', source_ip: '1.1.1.1', command: 12345 });
  assert.equal(numCmd.status, 200, 'contains 只对字符串成立：非字符串命令不应 5xx');
  assert.ok(!numCmd.json.matched.some((m) => m.id === 'ssh_bruteforce'), '数字 command 不该被子串判定命中');
  // 类型敏感：换一个不是字符串的 type 也不能碰巧命中
  const upperType = await postJSON(main.port, '/api/rules/evaluate',
    { type: 'HONEYPOT', peer: 'p', source_ip: 's', user: 'root' });
  assert.deepEqual(upperType.json, { count: 0, matched: [] }, 'type 是严格相等，大小写不同不命中');
});

test('A2 多余键被忽略（additionalProperties:true）、不污染原型、规则文件不被求值改写', { timeout: 15000 }, async () => {
  const before = Object.fromEntries(ruleFiles().map((f) => [f, ruleSource(f)]));
  const fact = { ...HIT_FACT.honeypot_probe, extra: 'x', nested: { a: [1, 2, 3] }, '__proto__': { polluted: true } };
  // JSON 里 __proto__ 是普通自有键；这里用原始字符串确保它真的进了正文
  const res = await postJSON(main.port, '/api/rules/evaluate',
    `{"type":"honeypot","peer":"10.1.2.3","source_ip":"10.1.2.3","user":"root","extra":"x","nested":{"a":1},"__proto__":{"polluted":true}}`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.deepEqual(res.json.matched.map((m) => m.id), ['honeypot_probe'], '多余键不参与判定');
  assert.equal({}.polluted, undefined, '求值不能污染 Object.prototype');
  assert.deepEqual(Object.fromEntries(ruleFiles().map((f) => [f, ruleSource(f)])), before, '求值不得改写规则文件');
  void fact;
});

// =====================================================================
// A3 求值返回命中规则名与 Rego 正文；无命中明确空
// =====================================================================

test('A3 命中项形状：{id,name,rego}，rego 逐字等于文件全文，count===matched.length', { timeout: 15000 }, async () => {
  const { json: list } = await getJSON(main.port, '/api/rules');
  const byId = new Map(list.rules.map((r) => [r.id, r]));
  for (const r of list.rules) {
    const body = await evaluate(HIT_FACT[r.id]);
    assert.deepEqual(Object.keys(body).sort(), ['count', 'matched'], 'RegoEvaluation additionalProperties:false');
    assert.equal(typeof body.count, 'number');
    assert.ok(Number.isInteger(body.count) && body.count >= 0, 'count 是非负整数');
    assert.ok(Array.isArray(body.matched), 'matched 是数组');
    assert.equal(body.count, body.matched.length, 'count 必须等于 matched 长度');
    for (const m of body.matched) {
      assert.deepEqual(Object.keys(m).sort(), ['id', 'name', 'rego'], 'RegoRuleMatch additionalProperties:false');
      assert.equal(m.name, byId.get(m.id).name, '命中项返回规则显示名');
      assert.equal(m.rego, ruleSource(byId.get(m.id).file), '命中项 rego 是整份文件原文，逐字');
    }
    assert.deepEqual(body.matched.map((m) => m.id), [r.id], `${r.id}: 只命中该规则`);
  }
});

test('A3 没有命中时明确空：{count:0,matched:[]}（不是 null、不是 404、不抛错）', { timeout: 15000 }, async () => {
  for (const fact of [
    {},                                                                     // 七字段全缺
    { host: '' },                                                           // 空串
    { type: 'no_such_type', peer: 'p', source_ip: 's', user: 'root' },      // 类型不匹配
    { type: 'webshell', host: 'h', path: '/var/www/x.jsp' },                // 路径前缀不匹配
    { type: 'abnormal_login', source_ip: '1.1.1.1', command: 'curl http://x' }, // 命令不含 ssh
  ]) {
    const res = await postJSON(main.port, '/api/rules/evaluate', fact);
    assert.equal(res.status, 200, `没命中应 200，实测 ${res.status}`);
    assert.deepEqual(res.json, { count: 0, matched: [] }, `没命中必须明确空对象，实测 ${res.text.slice(0, 160)}`);
  }
});

test('A3 空规则库：列表 {count:0,rules:[]}、求值 {count:0,matched:[]}、按 id 读 404', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p003t011-empty-'));
  const srv = await spawnServer(new RuleStore(dir));
  try {
    const list = await getJSON(srv.port, '/api/rules');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json, { count: 0, rules: [] });
    const evalRes = await postJSON(srv.port, '/api/rules/evaluate', HIT_FACT.honeypot_probe);
    assert.equal(evalRes.status, 200);
    assert.deepEqual(evalRes.json, { count: 0, matched: [] });
    assertErrorShape(await getJSON(srv.port, '/api/rules/honeypot_probe'), { status: 404, label: '空库读 id' });
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3 自定义规则库：not 语义（缺字段算通过）、多命中、description 缺省为 null、按 id 排序', { timeout: 15000 }, async () => {
  const files = {
    // 文件名与 id 故意错位：id 只看 package，排序只看 id
    'z_alpha.rego': 'package hids.rules.alpha\n\n# name: Alpha\n\ndefault match := false\n\nmatch if {\n  input.type == "t1"\n  not input.user == "root"\n}\n',
    'a_beta.rego': 'package hids.rules.beta\n\n# name: Beta\n# description: 只限制 type\n\ndefault match := false\n\nmatch if {\n  input.type == "t1"\n}\n',
    'm_gamma.rego': 'package hids.rules.gamma\n\n# name: Gamma\n\ndefault match := false\n\nmatch if {\n  input.source_ip == "10.0.0.1"\n  input.peer != ""\n  startswith(input.path, "/tmp/")\n  endswith(input.command, ".jsp")\n}\n',
    'n_delta.rego': 'package hids.rules.delta\n\n# name: Delta\n\ndefault match := false\n\nmatch if {\n  input.type == "1"\n}\n',
  };
  const dir = writeLib(files);
  const srv = await spawnServer(new RuleStore(dir));
  try {
    const list = await getJSON(srv.port, '/api/rules');
    assert.equal(list.status, 200, list.text.slice(0, 200));
    assert.deepEqual(list.json.rules.map((r) => r.id), ['alpha', 'beta', 'delta', 'gamma'], '按 id 排序（不是按文件名）');
    assert.equal(list.json.rules.find((r) => r.id === 'gamma').description, null, '没写 # description: 是 null');
    assert.equal(list.json.rules.find((r) => r.id === 'beta').description, '只限制 type');
    assert.equal(list.json.rules.find((r) => r.id === 'alpha').file, 'z_alpha.rego', 'file 是真实文件名');

    // not：user 缺字段 → undefined → not 成立 → 命中 alpha
    let res = await postJSON(srv.port, '/api/rules/evaluate', { type: 't1' });
    assert.deepEqual(res.json.matched.map((m) => m.id).sort(), ['alpha', 'beta'], '缺 user 时 not input.user == "root" 应成立');

    // user 就是 root → not 不成立，只剩 beta（多命中收窄）
    res = await postJSON(srv.port, '/api/rules/evaluate', { type: 't1', user: 'root' });
    assert.deepEqual(res.json.matched.map((m) => m.id), ['beta']);

    // 只限制 type 的规则：其它六个字段塞满也照样命中（没写的字段不限制）
    res = await postJSON(srv.port, '/api/rules/evaluate',
      { type: 't1', user: 'root', host: 'h', peer: 'p', command: 'c', path: '/p', source_ip: 's' });
    assert.deepEqual(res.json.matched.map((m) => m.id), ['beta']);

    // 子串/前缀/后缀 + != 组合
    res = await postJSON(srv.port, '/api/rules/evaluate',
      { source_ip: '10.0.0.1', peer: 'p', path: '/tmp/a', command: 'x.jsp' });
    assert.deepEqual(res.json.matched.map((m) => m.id), ['gamma']);
    res = await postJSON(srv.port, '/api/rules/evaluate',
      { source_ip: '10.0.0.1', peer: '', path: '/tmp/a', command: 'x.jsp' });
    assert.deepEqual(res.json, { count: 0, matched: [] }, 'peer 为空串时 != "" 不成立');
    res = await postJSON(srv.port, '/api/rules/evaluate',
      { source_ip: '10.0.0.1', peer: 'p', path: '/var/a', command: 'x.jsp' });
    assert.deepEqual(res.json, { count: 0, matched: [] }, 'startswith 前缀不匹配');

    // 严格相等：字符串 "1" ≠ 数字 1
    res = await postJSON(srv.port, '/api/rules/evaluate', { type: '1' });
    assert.deepEqual(res.json.matched.map((m) => m.id), ['delta']);
    res = await postJSON(srv.port, '/api/rules/evaluate', { type: 1 });
    assert.ok(!res.json.matched.some((m) => m.id === 'delta'), '"1" 不等于 1');

    // 多命中是可重复的（顺序自洽）
    const a = await postJSON(srv.port, '/api/rules/evaluate', { type: 't1' });
    const b = await postJSON(srv.port, '/api/rules/evaluate', { type: 't1' });
    assert.deepEqual(a.json, b.json, '同一事实多次求值结果必须一致');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// 边界 / 错误码：4xx、5xx 每条都触发一次并断言响应体形状
// =====================================================================

test('边界 400：正文不是 JSON 对象 / 不是 JSON / 超过平台缺省上限', { timeout: 15000 }, async () => {
  for (const raw of ['[]', 'null', '"x"', '123', 'true']) {
    const res = await postJSON(main.port, '/api/rules/evaluate', raw);
    assertErrorShape(res, { status: 400, label: `正文 ${raw}` });
    assert.match(res.json.error, /告警事实必须是 JSON 对象/, `正文 ${raw} 的报错文案`);
  }
  for (const raw of ['{', '', 'not-json']) {
    assertErrorShape(await postJSON(main.port, '/api/rules/evaluate', raw), { status: 400, label: `坏 JSON ${JSON.stringify(raw)}` });
  }
  // docs/modules/http-api.md:276-288：readJSON 缺省上限 8192（量的是字符串长度），超限 400「请求正文过大」
  const pad = (n) => jsonBody({ type: 'honeypot', peer: 'p', source_ip: 's', user: 'root', host: 'h'.repeat(n) });
  const atLimit = fitBody(pad, 8192);
  const ok = await postJSON(main.port, '/api/rules/evaluate', atLimit);
  assert.equal(ok.status, 200, `正文恰 8192 字符应被接受：${ok.status} ${ok.text.slice(0, 160)}`);
  const over = await postJSON(main.port, '/api/rules/evaluate', atLimit + ' ');
  assert.equal(over.status, 400, `8193 字符应 400，实测 ${over.status}`);
  assert.equal(over.json.error, '请求正文过大');
});
// 把合法事实补到恰好 n 个字符
function fitBody(build, n) {
  let body = build(0);
  const need = n - body.length;
  assert.ok(need > 0, `基准正文已经超过 ${n}`);
  body = build(need);
  assert.equal(body.length, n, `正文长度未对齐：${body.length}`);
  return body;
}

test('边界 方法不匹配统一落 405 + Allow（P003-T073；原 404；且不会跑到写操作）', { timeout: 15000 }, async () => {
  assertErrorShape(await request(main.port, '/api/rules', { method: 'POST', body: '{}' }), { status: 405, label: 'POST /api/rules' });
  assertErrorShape(await request(main.port, '/api/rules', { method: 'DELETE' }), { status: 405, label: 'DELETE /api/rules' });
  // GET /api/rules/evaluate 命中的是「按 id 读规则」分支（路由顺序语义，'evaluate' 是合法 id 形状）→ 404 规则不存在。
  // 批 7 路由表化时这是第三条顺序回归点（与 sessions、triage/status 同族）。
  assertErrorShape(await getJSON(main.port, '/api/rules/evaluate'), { status: 404, label: 'GET /api/rules/evaluate（按 id 读，不存在）' });
  assertErrorShape(await request(main.port, '/api/rules/ssh_bruteforce', { method: 'DELETE' }), { status: 405, label: 'DELETE 读接口' });
  // T041 起 PUT /api/rules/{id} 是真路由（规则维护接口）：未配管理员令牌回 503 not_configured，不再是方法不匹配。
  assertErrorShape(await request(main.port, '/api/rules/ssh_bruteforce', { method: 'PUT', body: '{}' }), { status: 503, label: 'PUT 维护路由（无令牌 503）' });
  // PATCH 仍无此方法：P003-T073 起统一 405（带 Allow）。
  assertErrorShape(await request(main.port, '/api/rules/ssh_bruteforce', { method: 'PATCH', body: '{}' }), { status: 405, label: 'PATCH 方法不匹配' });
});

// ---- 502：规则库坏了必须整次失败并带定位，不静默跳过 ----
function writeLib(files) {
  const dir = mkdtempSync(join(tmpdir(), 'p003t011-lib-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

async function withBrokenLib(files, fn) {
  const dir = writeLib(files);
  const srv = await spawnServer(new RuleStore(dir));
  try { await fn(srv, dir); } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_OK = 'package hids.rules.ok\n\n# name: OK\n\ndefault match := false\n\nmatch if {\n  input.type == "a"\n}\n';

function assertLocated502(res, { label, file }) {
  assertErrorShape(res, { status: 502, label });
  assert.match(res.json.error, /规则/, `${label}: 报错应说清是规则库问题`);
  assert.ok(res.json.error.includes(`rules/${file}:`), `${label}: RuleLibraryError 承诺带 rules/<文件>:<行> 定位，实测 ${JSON.stringify(res.json.error)}`);
  assert.match(res.json.error, /rules\/[^:\s]+:\d+/, `${label}: 定位必须是 rules/<文件>:<行>，实测 ${JSON.stringify(res.json.error)}`);
}
const allThree = async (srv, id) => [
  await getJSON(srv.port, '/api/rules'),
  await getJSON(srv.port, `/api/rules/${id}`),
  await postJSON(srv.port, '/api/rules/evaluate', { type: 'a' }),
];

test('502 规则文件缺 # name:：列表/读/求值三处都失败并带 rules/<文件>:<行>', { timeout: 15000 }, async () => {
  await withBrokenLib({ 'x.rego': VALID_OK.replace('# name: OK\n', '') }, async (srv) => {
    const [list, read, evalRes] = await allThree(srv, 'x');
    assertLocated502(list, { label: '缺 name 列表', file: 'x.rego' });
    assertLocated502(read, { label: '缺 name 读', file: 'x.rego' });
    assertLocated502(evalRes, { label: '缺 name 求值', file: 'x.rego' });
  });
});

test('502 子集外语法与垃圾内容：装载即报错，不静默跳过', { timeout: 15000 }, async () => {
  const subsetOut = [
    'package hids.rules.x\n\n# name: X\n\nimport future.keywords.if\n\ndefault match := false\n\nmatch if {\n  input.type == "a"\n}\n',
    'package hids.rules.x\n\n# name: X\n\ndefault match := false\n\nmatch if {\n  else := true\n}\n',
    'package hids.rules.x\n\n# name: X\n\ndefault match := false\n\nmatch if {\n  count(input.peer) > 0\n}\n',
  ];
  for (const text of subsetOut) {
    await withBrokenLib({ 'x.rego': text }, async (srv) => {
      const [list, read, evalRes] = await allThree(srv, 'x');
      assertLocated502(list, { label: `子集外 ${text.split('\n').find((l) => l.includes('import') || l.includes('else') || l.includes('count('))}`, file: 'x.rego' });
      assertLocated502(read, { label: '子集外读', file: 'x.rego' });
      assertLocated502(evalRes, { label: '子集外求值', file: 'x.rego' });
    });
  }
  // 垃圾文件 / 缺 package：同样整次失败
  for (const [label, text, file] of [
    ['垃圾内容', 'this is not rego at all\n', 'g.rego'],
    ['缺 package', VALID_OK.replace(/^package.*\n\n/, ''), 'g.rego'],
    ['大写 id', VALID_OK.replace('hids.rules.ok', 'hids.rules.Bad'), 'g.rego'],
  ]) {
    await withBrokenLib({ [file]: text }, async (srv) => {
      const [list] = await allThree(srv, 'ok');
      assertLocated502(list, { label, file });
    });
  }
});

test('502 规则 id 重复：整次失败，报错点名两个文件（文档承诺的 rules/<文件>:<行> 这里只有文件名，见报告）', { timeout: 15000 }, async () => {
  const second = VALID_OK.replace(/ok/g, 'ok2');
  await withBrokenLib({ 'a.rego': VALID_OK, 'b.rego': second.replace('hids.rules.ok2', 'hids.rules.ok') }, async (srv) => {
    const [list, read, evalRes] = await allThree(srv, 'ok');
    for (const [label, res] of [['重复 id 列表', list], ['重复 id 读', read], ['重复 id 求值', evalRes]]) {
      assertErrorShape(res, { status: 502, label });
      assert.match(res.json.error, /规则 id 重复/, `${label}: 报错应说明重复，实测 ${JSON.stringify(res.json.error)}`);
      assert.ok(res.json.error.includes('a.rego') || res.json.error.includes('b.rego'), `${label}: 报错应点名文件`);
    }
  });
});

test('502 规则目录不存在：读不到整库就失败，不退化成空库', { timeout: 15000 }, async () => {
  const missing = join(tmpdir(), `p003t011-missing-${process.pid}-${Date.now()}`);
  const srv = await spawnServer(new RuleStore(missing));
  try {
    assertErrorShape(await getJSON(srv.port, '/api/rules'), { status: 502, label: '目录不存在列表' });
    assertErrorShape(await getJSON(srv.port, '/api/rules/any_rule'), { status: 502, label: '目录不存在读' });
    assertErrorShape(await postJSON(srv.port, '/api/rules/evaluate', {}), { status: 502, label: '目录不存在求值' });
  } finally {
    await srv.close();
  }
});

test('边界 规则目录里的非 .rego 文件与子目录被忽略，不误当规则', { timeout: 15000 }, async () => {
  const dir = writeLib({ 'ok.rego': VALID_OK, 'notes.txt': 'hello', 'README.md': '# x', 'broken.rego.bak': 'garbage' });
  const srv = await spawnServer(new RuleStore(dir));
  try {
    const list = await getJSON(srv.port, '/api/rules');
    assert.equal(list.status, 200, list.text.slice(0, 200));
    assert.deepEqual(list.json.rules.map((r) => r.id), ['ok'], `只该看到 ok，实测 ${list.text.slice(0, 200)}`);
    assert.equal(list.json.count, 1);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界 只读接口真只读：GET 接口不产生数据目录/不碰规则文件', { timeout: 15000 }, async () => {
  const before = Object.fromEntries(ruleFiles().map((f) => [f, ruleSource(f)]));
  await evaluate(HIT_FACT.honeypot_probe);
  await evaluate(HIT_FACT.ssh_bruteforce);
  await getJSON(main.port, '/api/rules');
  assert.deepEqual(Object.fromEntries(ruleFiles().map((f) => [f, ruleSource(f)])), before, '只读接口不得改写 rules/');
});
