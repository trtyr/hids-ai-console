import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat as statFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rego 规则库（P003-T011）。
//
// 一个目录下一条规则一个 .rego 文件，规则 id 取 `package hids.rules.<id>` 的最后一段，
// 显示名取 `# name: ...` 注释。本模块只做三件事：列规则、按 id 读原文、拿一条告警事实去求值。
//
// **只支持 Rego 的一个子集**，遇到子集外的语法在装载时直接报错（带 file:line），不静默跳过：
//
//   package hids.rules.ssh_bruteforce
//   # name: SSH 暴力破解
//   # description: 可选的一句话说明
//   default match := false
//   match if {
//     input.type == "abnormal_login"
//     input.source_ip != ""
//     contains(input.command, "ssh")
//     not startswith(input.path, "/usr/")
//   }
//
// 支持的表达式只有四类（每行一条，全部成立才算命中）：
//   - `input.<字段> == <字面量>` / `input.<字段> != <字面量>`
//   - `contains|startswith|endswith(input.<字段>, <字面量>)`
//   - 上面任意一条前面加 `not`
// 字面量只有字符串、数字、true / false / null。
//
// 求值语义（按 Rego，不是按"宽松匹配"）：
//   - 规则没写的字段不参与判定——不写就是不限制。
//   - 事实里缺字段时，引用该字段的表达式**不成立**（`!=` 也一样，与 Rego 的 undefined 语义一致）；
//     要"缺字段也算通过"请写 `not input.<字段> == <值>`。
//   - 比较是严格相等：`"1"` 不等于 `1`；`contains` 之类的参数不是字符串时不成立。

const RULE_ID = /^[a-z][a-z0-9_]*$/;
const MAX_RULE_BYTES = 64 * 1024;

function invalid(file, line, message) {
  return new Error(`rules/${file}:${line}: ${message}`);
}

function parseLiteral(raw, file, line) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try { return JSON.parse(raw); } catch { throw invalid(file, line, `字符串字面量无效：${raw}`); }
  }
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  throw invalid(file, line, `字面量只能是字符串、数字、true / false / null：${raw}`);
}

function parseExpression(text, file, line) {
  let negated = false;
  let rest = text;
  if (/^not\s+/.test(rest)) { negated = true; rest = rest.replace(/^not\s+/, ''); }
  const call = rest.match(/^(contains|startswith|endswith)\s*\(\s*input\.([a-z][a-z0-9_]*)\s*,\s*(.+?)\s*\)$/);
  if (call) return { negated, kind: 'call', op: call[1], field: call[2], value: parseLiteral(call[3], file, line) };
  const compare = rest.match(/^input\.([a-z][a-z0-9_]*)\s*(==|!=)\s*(.+)$/);
  if (compare) return { negated, kind: 'compare', op: compare[2], field: compare[1], value: parseLiteral(compare[3], file, line) };
  throw invalid(file, line, `不支持的表达式：${text}`);
}

function parseRule(file, source) {
  if (Buffer.byteLength(source) > MAX_RULE_BYTES) throw invalid(file, 1, `规则文件超过 ${MAX_RULE_BYTES} 字节`);
  const lines = source.split(/\r?\n/);
  let id = null;
  let name = null;
  let description = null;
  let defaultSeen = false;
  let bodies = 0;
  let bodyOpen = false;
  const expressions = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith('#')) {
      const meta = text.match(/^#\s*(name|description)\s*:\s*(.*)$/);
      if (!meta) return;
      const value = meta[2].trim();
      const key = meta[1];
      if (!value) throw invalid(file, line, `${key} 不能为空`);
      if (key === 'name') {
        if (name !== null) throw invalid(file, line, 'name 只能写一次');
        name = value;
      } else {
        if (description !== null) throw invalid(file, line, 'description 只能写一次');
        description = value;
      }
      return;
    }
    if (bodyOpen) {
      if (text === '}') { bodyOpen = false; return; }
      expressions.push(parseExpression(text, file, line));
      return;
    }
    if (text === '}') throw invalid(file, line, '多余的 }');
    if (/^package\s+/.test(text)) {
      if (id !== null) throw invalid(file, line, 'package 只能出现一次');
      const matched = text.match(/^package\s+hids\.rules\.([a-z][a-z0-9_]*)\s*$/);
      if (!matched) throw invalid(file, line, 'package 必须是 hids.rules.<id>，id 用小写标识符');
      id = matched[1];
      return;
    }
    if (/^default\s+match\s*:=\s*false\s*$/.test(text)) {
      if (defaultSeen) throw invalid(file, line, 'default match 只能写一次');
      defaultSeen = true;
      return;
    }
    if (/^match\s*(?:if\s*)?\{\s*$/.test(text)) {
      if (bodies > 0) throw invalid(file, line, '一条规则只能有一个 match 体');
      bodies += 1;
      bodyOpen = true;
      return;
    }
    throw invalid(file, line, `不支持的语法：${text}`);
  });
  if (bodyOpen) throw invalid(file, lines.length, 'match 体没有闭合');
  if (id === null) throw invalid(file, 1, '缺少 package hids.rules.<id>');
  if (name === null) throw invalid(file, 1, '缺少 # name: 显示名');
  if (bodies === 0) throw invalid(file, 1, '缺少 match if { ... } 体');
  if (expressions.length === 0) throw invalid(file, 1, 'match 体至少写一条表达式');
  return { id, name, description, file, rego: source, expressions };
}

const STRING_METHOD = { contains: 'includes', startswith: 'startsWith', endswith: 'endsWith' };

function callBuiltin(op, value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  return value[STRING_METHOD[op]](expected);
}

function holds(expression, fact) {
  const value = Object.hasOwn(fact, expression.field) ? fact[expression.field] : undefined;
  let result;
  if (expression.kind === 'call') result = callBuiltin(expression.op, value, expression.value);
  else if (value === undefined) result = false;
  else result = expression.op === '==' ? value === expression.value : value !== expression.value;
  return expression.negated ? !result : result;
}

export function isRuleId(value) {
  return typeof value === 'string' && RULE_ID.test(value);
}

export class RuleStore {
  constructor(directory = ruleLibraryDirectory(),
    { historyDirectory = ruleHistoryDirectory(directory), seedFrom = seedSourceFor(directory) } = {}) {
    if (typeof directory !== 'string' || !directory) throw new Error('规则目录必须是路径');
    this.directory = path.resolve(directory);
    // 历史版本落点（P003-T041 A3）：数据根库→`<数据根>/rules-history/`，换过的目录→跟目录走，见文件末尾。
    this.historyDirectory = historyDirectory;
    // 种子源（P003-T041 A2）：只有「缺省库」才从仓内 `rules/` 初始化一次；注入的目录一律不碰仓库。
    this.seedSource = seedFrom;
    this.seeding = null;
    // 写队列（P003-T041 复审）：与 `WikiStore.pending` 同一口径——读—比对—写是同一个队列任务里的三段，
    // 并发两次改同一条规则不会都读到旧版再各写一份（后一个在队列里读到前一份，拿 409）。
    this.pending = Promise.resolve();
    // 已解析规则的缓存（A6）：键是文件名，值是（mtimeMs, size, rule）。
    // 命中时只 stat 不 read/parse——求值不再每条规则重读重解析；文件改了 mtime 就重来。
    this.parsed = new Map();
  }

  // 数据根里还没有这本库时，从仓内副本初始化一次（A2）。已存在就一个字都不动；
  // 记忆化在实例上：同一实例反复读不重复整目录拷贝，跨进程的抢占由 `seedLibrary()` 的 mkdir 认领兜住。
  async ready() {
    if (!this.seedSource) return;
    this.seeding ||= seedLibrary(this.directory, this.seedSource);
    await this.seeding;
  }

  // 写盘串行：任务按到达顺序排队，队头失败了队列照样往前走（`this.pending` 只用来串链，不传错误）。
  #enqueue(job) {
    const run = this.pending.then(job);
    this.pending = run.catch(() => {});
    return run;
  }

  async #load() {
    await this.ready();
    let names;
    try { names = await readdir(this.directory); }
    catch (cause) {
      if (cause.code === 'ENOENT') throw new Error(`规则目录不存在：${this.directory}`);
      throw cause;
    }
    const files = names.filter(name => name.endsWith('.rego')).sort();
    const parsed = new Map();
    const rules = [];
    const byId = new Map();
    for (const file of files) {
      const filename = path.join(this.directory, file);
      let info;
      try { info = await statFile(filename); }
      catch (cause) {
        // readdir 与 stat 之间被删掉：当它不存在，不把「列目录时的旧快照」当规则用。
        if (cause.code === 'ENOENT') continue;
        throw cause;
      }
      const cached = this.parsed.get(file);
      const rule = cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size
        ? cached.rule
        : parseRule(file, await readFile(filename, 'utf8'));
      parsed.set(file, { mtimeMs: info.mtimeMs, size: info.size, rule });
      const previous = byId.get(rule.id);
      if (previous) throw new Error(`规则 id 重复：${rule.id}（${previous.file} 与 ${file}）`);
      byId.set(rule.id, rule);
      rules.push(rule);
    }
    // 只保留这一轮还在盘上的文件：删掉的规则不会从缓存里借尸还魂。
    this.parsed = parsed;
    rules.sort((left, right) => (left.id < right.id ? -1 : 1));
    return rules;
  }

  /** 列出全部规则：`{ count, rules: [{ id, name, description, file }] }`，按 id 排序。 */
  async list() {
    const rules = await this.#load();
    return { count: rules.length, rules: rules.map(({ id, name, description, file }) => ({ id, name, description, file })) };
  }

  /** 按 id 读原文：`{ id, name, description, file, rego, revision }`；id 不合法或不存在返回 null。 */
  async read(id) {
    if (!isRuleId(id)) return null;
    const rules = await this.#load();
    const rule = rules.find(item => item.id === id);
    return rule ? { id: rule.id, name: rule.name, description: rule.description, file: rule.file, rego: rule.rego,
      revision: ruleRevision(rule.rego) } : null;
  }

  /**
   * 只校验不落盘（`save()` 与规则维护者共用同一份判据）：
   * 返回 `{ id, name, source, rev }`；id 不合法 / 正文为空 / 语法不在规则子集内 / 包名与 id 不一致都抛。
   * **校验类失败带 `status: 400`**：HTTP 维护接口据此回调用方错误，而不是 500。
   */
  validate(id, rego) {
    const reject = message => Object.assign(new Error(message), { status: 400 });
    if (!isRuleId(id)) throw reject(`规则 id 不合法：${id || '(空)'}`);
    const source = typeof rego === 'string' ? rego : '';
    if (!source.trim()) throw reject('规则正文为空');
    // 文件名只用于报错定位：包名与 id 不一致时 `parseRule` 会先报 package 层面的错。
    let parsed;
    try { parsed = parseRule(`${id}.rego`, source); }
    catch (cause) { throw Object.assign(cause, { status: 400 }); }
    if (parsed.id !== id) throw reject(`规则正文的 package 与规则 id 不一致：${id}`);
    return { id: parsed.id, name: parsed.name, source, rev: ruleRevision(source) };
  }

  /**
   * 写一条规则（A3/A5）：**维护者 Agent 与人工接口共用的唯一写入口**，不再有第二套直写文件的函数。
   *
   * 顺序是有意的：先校验正文（复用装载器同一份 `parseRule`，过不了就一个字都不落）→ 比对 `expectedRevision`
   * （给了才比）→ 旧版原件 + 备注落 `<历史目录>/<id>-<rev>.rego|.json` → 临时文件 + rename 覆盖 `<库>/<id>.rego`。
   * 返回 `{ id, file, name, rev, previous_rev, action }`；正文与原样一致时 `action: 'unchanged'`，
   * 既不写盘也不刷历史（同一份内容重复提交不该把历史灌满）。
   * **整段在实例的写队列里跑**：并发的两次写入按到达顺序串起来，不会交叉着读旧版、各写一份。
   */
  async save(id, rego, { note = '', expectedRevision } = {}) {
    return this.#enqueue(() => this.#write(id, rego, { note, expectedRevision }));
  }

  // 写盘本体：只在队列任务里被调（`save()` 与 `rollback()` 都从这里进，各自再入队会自锁）。
  async #write(id, rego, { note = '', expectedRevision } = {}) {
    const { name, source, rev } = this.validate(id, rego);
    await this.ready();
    const existing = await this.read(id);
    const previousRev = existing ? ruleRevision(existing.rego) : null;
    // 乐观并发（复审 major）：比对与写在同一个队列任务里。`undefined`＝调用方不做并发校验（回滚、维护者）；
    // `null`＝要求当前不存在（新增规则）。不一致抛 409，不让后写的悄悄盖掉前一份。
    if (expectedRevision !== undefined && previousRev !== expectedRevision)
      throw Object.assign(new Error('规则已更新，请刷新后再提交'), { status: 409 });
    if (existing && existing.rego === source)
      return { id, file: existing.file, name, rev, previous_rev: null, action: 'unchanged' };
    // 已有规则的 id 可能住在别的文件名里：改它就要写回它自己那份，不能另起一个同 id 的文件。
    const file = existing?.file || `${id}.rego`;
    if (existing) await this.#archive(id, previousRev, existing.rego, note, rev);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, file);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await rename(temporary, target); }
    catch (cause) { await rm(temporary, { force: true }); throw cause; }
    return { id, file, name, rev, previous_rev: previousRev, action: existing ? 'update' : 'add' };
  }

  // 旧版进历史（复审 major）：正文副本 `<id>-<rev>.rego` + 备注 sidecar `<id>-<rev>.json`
  // （`{id, rev, note, saved_at, replaced_by}`）。备注单独一个文件而不是塞进 `.rego`：历史正文要能逐字读回、
  // 逐字比对（`readRevision()` 就干这个）。同一版被归档第二次（回滚回去又回滚回来）时副本与备注都保留第一次的
  // ——这条历史描述的是「它当初为什么、被谁替换掉」。
  async #archive(id, rev, rego, note, replacedBy) {
    await mkdir(this.historyDirectory, { recursive: true, mode: 0o700 });
    const copy = path.join(this.historyDirectory, `${id}-${rev}.rego`);
    try { await writeFile(copy, rego, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (cause) { if (cause.code === 'EEXIST') return; throw cause; }
    await writeFile(`${copy.slice(0, -'.rego'.length)}.json`,
      JSON.stringify({ id, rev, note: String(note || ''), saved_at: new Date().toISOString(), replaced_by: replacedBy }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      .catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
  }

  // 历史条目的备注：`<id>-<rev>.json` 的 `note`。没这个文件（本卡之前留下的旧历史副本）或内容坏了都当 `null`
  // ——一条坏备注不该把整页历史接口拖成 502。
  async #historyNote(id, rev) {
    try {
      const record = JSON.parse(await readFile(path.join(this.historyDirectory, `${id}-${rev}.json`), 'utf8'));
      return typeof record?.note === 'string' && record.note ? record.note : null;
    } catch (cause) {
      if (cause.code === 'ENOENT' || cause instanceof SyntaxError) return null;
      throw cause;
    }
  }

  /** 列一条规则的历史版本：`[{ id, rev, file, bytes, saved_at, note }]`，按写入时间升序（rev 时间戳相同再按 rev）。 */
  async history(id) {
    if (!isRuleId(id)) return [];
    let names;
    try { names = await readdir(this.historyDirectory); }
    catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    const prefix = `${id}-`;
    const rows = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.rego')) continue;
      const rev = name.slice(prefix.length, -'.rego'.length);
      if (!REVISION.test(rev)) continue;
      let info;
      try { info = await statFile(path.join(this.historyDirectory, name)); }
      catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
      rows.push({ id, rev, file: name, bytes: info.size, saved_at: new Date(info.mtimeMs).toISOString(),
        note: await this.#historyNote(id, rev), at: info.mtimeMs });
    }
    return rows.sort((left, right) => left.at - right.at || (left.rev < right.rev ? -1 : 1))
      .map(({ at, ...row }) => row);
  }

  /** 读某一版历史原文：`{ id, rev, rego }`；rev 不合法或不存在返回 null。 */
  async readRevision(id, rev) {
    if (!isRuleId(id) || !REVISION.test(String(rev || ''))) return null;
    try { return { id, rev, rego: await readFile(path.join(this.historyDirectory, `${id}-${rev}.rego`), 'utf8') }; }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }

  /**
   * 回滚到某一版（A3）：把那一版当新版 `save()` 一次——所以当前版也会进历史，回滚本身可再回滚。
   * 历史里没有这一版时抛错（404 类），不改动现网那份。
   */
  async rollback(id, rev, { note = '' } = {}) {
    // 读历史 + 写回也是一次写：进同一个队列，别插到别人的读—比对—写中间。
    return this.#enqueue(async () => {
      const previous = await this.readRevision(id, rev);
      if (!previous) throw Object.assign(new Error(`规则历史版本不存在：${id}-${rev}`), { status: 404 });
      const saved = await this.#write(id, previous.rego, { note });
      return { ...saved, action: 'rollback', rolled_back_to: rev };
    });
  }

  /**
   * 拿一条告警事实求值：`{ count, matched: [{ id, name, rego }] }`。
   * 没命中时 `matched` 是空数组、`count` 是 0——不返回 null、不抛错。
   * 事实必须是 JSON 对象；缺字段按 Rego 的 undefined 语义处理（见文件头）。
   */
  async evaluate(fact) {
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) throw new Error('告警事实必须是 JSON 对象');
    const rules = await this.#load();
    const matched = rules
      .filter(rule => rule.expressions.every(expression => holds(expression, fact)))
      .map(({ id, name, rego }) => ({ id, name, rego }));
    return { count: matched.length, matched };
  }
}

// ── 库目录、历史与种子（P003-T041）──────────────────────────────────────────
// 定义在文件末尾、import 也放末尾（ESM 会提升，模块顶层就能用），理由与 `wiki-store.js` / `server.js`
// 末尾的 `runtimePaths()` 一样：不挪动上面所有 `rule-store.js:NNN` 引用的行号。
//   · 活数据（规则正文）落**数据根**下的 `rules/`（数据根见 `config-store.js` 的 `dataRoot()`：
//     `HIDS_DATA_DIR`，没设就是 `~/.local/share/hids-ai-console`）——仓库里一个字都不写；
//   · 历史版本落数据根下 `rules-history/`（注入的目录跟目录走：同级 `.data/rules-history/`，同 `wiki-store.js`）；
//     维护会话落数据根下 `rule-sessions/`；
//   · 仓内 `rules/` 只当种子源：数据根里还没有这本库时整目录拷一次，此后只读（A1/A2）。
// 判「缺省库」只能拿 `ruleLibraryDirectory()` 比：它只由 `dataRoot()` 决定，注入的目录（单测的 tmp、
// 构造参数）永远不等于它，于是注入目录既不读仓库也不写仓库。
export const REVISION = /^[0-9a-f]{16}$/;

/** 规则正文的版本指纹：sha256 前 16 位，与 `WikiStore` 的页面 `revision` 同一口径。 */
export function ruleRevision(rego) {
  return createHash('sha256').update(String(rego)).digest('hex').slice(0, 16);
}

export function ruleLibraryDirectory() {
  return path.join(dataRoot(), 'rules');
}

/**
 * 历史版本落点：缺省库与仓内种子库 → 数据根 `rules-history/`；换过的目录 → 同级 `.data/rules-history/`
 * （与 `wiki-store.js:418` 的 `historyDirectoryFor` 同一先例：库搬到别处部署，它的历史该跟它走，
 * 也不该让单测/注入目录往真实全局根写）。
 */
export function ruleHistoryDirectory(directory = ruleLibraryDirectory()) {
  const target = path.resolve(directory);
  return target === ruleLibraryDirectory() || target === repositoryRulesDirectory()
    ? path.join(dataRoot(), 'rules-history')
    : path.join(path.dirname(target), '.data', 'rules-history');
}

export function ruleSessionsDirectory() {
  return path.join(dataRoot(), 'rule-sessions');
}

/** 仓内 `rules/`：种子源，也是「这本库原本长什么样」的出处。进程只读它。 */
function repositoryRulesDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules');
}

function seedSourceFor(directory) {
  return path.resolve(directory) === ruleLibraryDirectory() ? repositoryRulesDirectory() : null;
}

/**
 * 一次性种子初始化（A2）：目标目录**不存在**时从 `source` 整目录拷一份，已存在就一个字都不动。
 *
 * 用「非递归 mkdir 认领」而不是先 stat 再 cp：mkdir 在文件系统层面是原子的，两个进程同时起也只有
 * 一个能建出目录，另一个拿 EEXIST 直接退出——不会两边各拷一半。拷贝失败时把刚建的目录删掉再抛，
 * 下一次启动还能重新初始化，不会留一个半成品目录顶替「已初始化」。
 * 返回 `true`＝这一轮真的拷了，`false`＝库早就存在（这次什么都没做）。
 */
export async function seedLibrary(target, source) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { await mkdir(target, { mode: 0o700 }); }
  catch (cause) { if (cause.code === 'EEXIST') return false; throw cause; }
  try { await cp(source, target, { recursive: true, force: false, errorOnExist: false }); }
  catch (cause) { await rm(target, { recursive: true, force: true }); throw cause; }
  return true;
}

// ── 规则维护会话（P003-T041 A4）─────────────────────────────────────────────
// 形制对齐 `wiki-sessions`（`wiki-workbench.js:77-105`）：一维护一份 `<uuid>.json`，目录 `0o700`、
// 文件 `0o600`、临时文件 + rename 原子替换，`list()` 只回摘要。会话里记的是「这次维护为什么来、
// 模型提了什么、校验过没过、最后落在哪」——**不是**规则正文的第二份副本（正文在库与历史里）。
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RuleSessionStore {
  constructor(directory = ruleSessionsDirectory()) {
    if (typeof directory !== 'string' || !directory) throw new Error('规则维护会话目录必须是路径');
    this.directory = path.resolve(directory);
  }

  file(id) {
    if (!SESSION_ID.test(String(id || ''))) throw Object.assign(new Error('规则维护会话 ID 无效'), { status: 400 });
    return path.join(this.directory, `${id}.json`);
  }

  async get(id) {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }

  async save(record) {
    const filename = this.file(record?.id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await rename(temporary, filename); }
    catch (cause) { await rm(temporary, { force: true }); throw cause; }
    return record;
  }

  /** 维护会话摘要，按 `updated_at` 倒序：列表里不塞规则正文与案卷快照。 */
  async list() {
    let names;
    try { names = await readdir(this.directory); }
    catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    const rows = await Promise.all(names.filter(name => name.endsWith('.json') && SESSION_ID.test(name.slice(0, -5)))
      .map(name => this.get(name.slice(0, -5)).catch(() => null)));
    return rows.filter(Boolean).sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .map(({ id, case_id, event_type, who, status, proposal, validation, updated_at }) => ({ id, case_id, event_type,
        who, status, rule_id: proposal?.id || null, validated: validation?.ok === true, updated_at }));
  }
}

import { dataRoot } from './config-store.js';
