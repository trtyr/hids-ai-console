import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import path from 'node:path';

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
  constructor(directory) {
    if (typeof directory !== 'string' || !directory) throw new Error('规则目录必须是路径');
    this.directory = path.resolve(directory);
    // 已解析规则的缓存（A6）：键是文件名，值是（mtimeMs, size, rule）。
    // 命中时只 stat 不 read/parse——求值不再每条规则重读重解析；文件改了 mtime 就重来。
    this.parsed = new Map();
  }

  async #load() {
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

  /** 按 id 读原文：`{ id, name, description, file, rego }`；id 不合法或不存在返回 null。 */
  async read(id) {
    if (!isRuleId(id)) return null;
    const rules = await this.#load();
    const rule = rules.find(item => item.id === id);
    return rule ? { id: rule.id, name: rule.name, description: rule.description, file: rule.file, rego: rule.rego } : null;
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
