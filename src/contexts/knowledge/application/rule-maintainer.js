// 规则维护者（P003-T041 A4/A5；P003-T086 从 server.js 搬到规则上下文的 application 层）。
//
// 拿一条已完成的误报案件，让模型改一条 Rego 或新增一条：
// - **写盘只有一条路**：`RuleStore.save()`——与人工维护接口 `PUT /api/rules/{id}` 是同一个方法，
//   校验、旧版进历史、原子替换都在那里；这里不再有第二套直写文件的函数。
// - **多轮修订（T086 A2）**：最多 N 轮（`HIDS_RULE_MAINTAIN_MAX_ROUNDS`，缺省 3；构造参数可覆盖）。
//   每一轮把上一轮的校验失败原因回灌给模型；收敛即写盘，N 轮都不通过才抛错。
//   轮次与每轮失败原因落会话（`rounds[]`），进程挂掉后也看得出卡在哪一轮、为什么。
// - **每次维护落一份会话**（`<数据根>/rule-sessions/<uuid>.json`，形制对齐 wiki-sessions）。
import { randomUUID } from 'node:crypto';
import { isRuleId } from '../infrastructure/rule-store.js';
import { traceModelCall } from '../../../shared/logging/log.js';
import { reasonForRecord, scrubCredentials } from '../../../shared/redaction.js';

export const DEFAULT_RULE_MAINTAIN_ROUNDS = 3;

function maxRoundsOf(options = {}) {
  const explicit = Number(options.maxRounds);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const configured = Number(process.env.HIDS_RULE_MAINTAIN_MAX_ROUNDS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RULE_MAINTAIN_ROUNDS;
}

export function ruleProposal(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let output;
  try { output = JSON.parse(raw); } catch { throw new Error('规则维护模型没有返回 JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('规则维护模型没有返回 JSON 对象');
  return output;
}

// 一份规则正文里的条件行（`match if { }` 体内，按出现顺序）。
// **这里不校验语法**：候选正文先过 `validateRego`、原规则由装载器读进来，两边都是规则子集内的合法正文，
// 抽取只为比对。认不出的行留着 `raw` 原文，比对时按「无法证明没放宽」处理（见 `atLeastAsStrict`）。
export function ruleExpressions(rego) {
  const expressions = [];
  let inside = false;
  for (const line of String(rego).split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (!inside) {
      if (/^match\s*(?:if\s*)?\{\s*$/.test(text)) inside = true;
      continue;
    }
    if (text === '}') { inside = false; continue; }
    let rest = text;
    const negated = /^not\s+/.test(rest);
    if (negated) rest = rest.replace(/^not\s+/, '');
    const call = rest.match(/^(contains|startswith|endswith)\s*\(\s*input\.([a-z][a-z0-9_]*)\s*,\s*(.+?)\s*\)$/);
    const compare = call ? null : rest.match(/^input\.([a-z][a-z0-9_]*)\s*(==|!=)\s*(.+)$/);
    if (call) expressions.push({ text, negated, kind: 'call', op: call[1], field: call[2], raw: call[3], value: stringLiteral(call[3]) });
    else if (compare) expressions.push({ text, negated, kind: 'compare', op: compare[2], field: compare[1], raw: compare[3], value: stringLiteral(compare[3]) });
    else expressions.push({ text, negated, kind: 'opaque', op: null, field: null, raw: null, value: null });
  }
  return expressions;
}

// 字面量里只有字符串能做「包含/前缀/后缀」比较；其它类型（数字、true / false / null）只认同值。
function stringLiteral(raw) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// 「被限定的那组事实，新的是旧的子集」——相同 kind / op 下逐个比：
// startswith 新值以旧值打头（`/tmp/` → `/tmp/webshell` 更严）、endswith 新值以旧值结尾（`.jsp` → `shell.jsp` 更严）、
// contains 新值含旧值（`tmp` → `tmp/shell` 更严）、`==` / `!=` 必须同值。跨 op / 跨类型一律判「不算更严」。
function innerAtLeastAsStrict(previous, next) {
  if (previous.kind === 'opaque' || next.kind === 'opaque') return previous.text === next.text;
  if (previous.kind !== next.kind || previous.op !== next.op) return false;
  if (previous.value === null || next.value === null) return previous.raw === next.raw;
  if (previous.kind === 'compare') return previous.value === next.value;
  if (previous.op === 'startswith') return next.value.startsWith(previous.value);
  if (previous.op === 'endswith') return next.value.endsWith(previous.value);
  return next.value.includes(previous.value);
}

// 新条件是否至少和旧条件一样严。取反要翻方向：`not A` 比 `not B` 更严 ⇔ A 比 B 更宽。
export function atLeastAsStrict(previous, next) {
  if (!next || previous.field !== next.field || previous.negated !== next.negated) return false;
  return previous.negated ? innerAtLeastAsStrict(next, previous) : innerAtLeastAsStrict(previous, next);
}

// A1（P003-T020）：改已有规则时，原有限制条件必须还在、且不许更宽——把 `/tmp/` 收成 `/tmp` 这种前缀放宽
// 会让这一类攻击静默漏报。逐条给旧条件配一条「至少同样严」的新条件（一对一），配不上的就是被放宽/删掉了。
// 新增规则没有原条件可放宽，不走这条。
export function widenedConditions(previousRego, nextRego) {
  const remaining = ruleExpressions(nextRego);
  const widened = [];
  for (const previous of ruleExpressions(previousRego)) {
    const index = remaining.findIndex(candidate => atLeastAsStrict(previous, candidate));
    if (index < 0) widened.push(previous.text);
    else remaining.splice(index, 1);
  }
  return widened;
}

// 本地校验错误标 `local`：这些话是我们自己写死的（语法位置、放宽的条件、缺字段），
// 可以把原因原文落进会话；上游/模型错误仍走 `reasonForRecord`（只留固定文案 + 字符量）。
const localError = message => Object.assign(new Error(message), { local: true });

export class RegoRuleMaintainer {
  constructor(model, ruleStore, prompts, sessions = null, options = {}) {
    this.model = model; this.ruleStore = ruleStore; this.prompts = prompts; this.sessions = sessions;
    this.maxRounds = maxRoundsOf(options);
  }

  // 一轮的输出 → 可落盘的 {id, rego, rationale}；任何一道闸不过就抛（调用方回灌给下一轮）。
  async checked(output) {
    if (output.ready === false)
      throw localError(`规则维护者没有给出可落盘的修订：${String(output.reason || '').slice(0, 200) || '未说明原因'}`);
    const id = String(output.id || '').trim();
    if (!isRuleId(id)) throw localError(`规则 id 不合法：${id || '(空)'}`);
    const rego = String(output.rego || '');
    if (!rego.trim()) throw localError('规则正文为空');
    const rationale = String(output.reason || '').slice(0, 500);
    // 第一道校验：语法必须在规则子集内（与装载器同一份 `parseRule`，报错带 file:line）。
    try { this.ruleStore.validate(id, rego); }
    catch (cause) { throw localError(String(cause?.message || cause).slice(0, 300)); }
    const existing = await this.ruleStore.read(id);
    // 第二道校验：改已有规则时原条件不许更宽。放在写盘之前——校验不过就一个字都不落。
    if (existing) {
      const widened = widenedConditions(existing.rego, rego);
      if (widened.length)
        throw localError(`规则修订放宽了原有限制条件，拒绝落盘：${widened.join('；').slice(0, 200)}`);
    }
    return { id, rego, rationale };
  }

  async maintain({ caseId, caseDir = null, eventType, reason, who, alert, ruleIds = [], domain = null, sessionId = null }) {
    const now = new Date().toISOString();
    const session = this.sessions ? await this.sessions.save({ id: randomUUID(),
      case_id: caseId, case_dir: caseDir, event_type: eventType, reason, who, status: 'collecting',
      max_rounds: this.maxRounds, rounds: [], proposal: null, validation: null, result: null, error: null,
      created_at: now, updated_at: now }) : null;
    // 会话的每次状态推进都落盘：维护跑在后台，进程挂掉后数据根里还能看出这次维护到哪一步。
    // 累积在 `record` 上（不是在原始 `session` 上）——后一次推进不能把前一次记下的草案/校验结果冲掉。
    let record = session;
    const settle = async patch => {
      if (!record) return;
      record = { ...record, ...patch, updated_at: new Date().toISOString() };
      await this.sessions.save(record);
    };
    const rounds = [];
    try {
      const inventory = await this.ruleStore.list();
      const matched = [];
      for (const id of ruleIds) {
        const rule = await this.ruleStore.read(id);
        if (rule) matched.push({ id: rule.id, name: rule.name, rego: rule.rego });
      }
      const prompt = (await this.prompts.load())?.prompts?.rule;
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('规则维护提示词未配置');
      const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify({ case_id: caseId, event_type: eventType, false_positive_reason: reason,
          reported_by: who, alert, matched_rules: matched, existing_rules: inventory.rules,
          max_rounds: this.maxRounds }) }
      ];
      let lastError = null;
      for (let round = 1; round <= this.maxRounds; round++) {
        // P003-T046 A4：规则维护调用同样落 ai.model_call；session_id 与 T041 的维护会话互引
        //（事件说「这次调用属于哪次维护」，会话文件说「这次维护提了什么、验过没过、落在哪」）。
        // 域缺省是「规则维护」；误报统一维护 Agent 跑这一轮时传 `false_positive`。
        const maintainMeta = { domain: domain === 'false_positive' ? 'false_positive' : 'rule', role: 'rule_maintainer',
          turn: round, phase: 'maintain', attempt: round,
          sessionId: sessionId ?? record?.id ?? null, model: this.model?.model || null, messages, tools: [] };
        let output;
        try {
          const replied = await traceModelCall(maintainMeta, () => this.model.complete(messages, [], 'none'),
            { decode: value => ruleProposal(value.content) });
          output = replied.decoded;
        } catch (cause) {
          lastError = cause;
          rounds.push({ round, id: null, ok: false, error: reasonForRecord(cause) });
          await settle({ status: 'validating', rounds });
          // 回灌给下一轮：调用/解析失败也带原因，别让模型以为是「没有反馈」。
          messages.push({ role: 'user', content:
            `上一轮没有返回可解析的 JSON（${reasonForRecord(cause)}）。请只输出一个 JSON 对象，包含 ready / id / rego / reason。` });
          continue;
        }
        let proposal = null;
        try {
          proposal = await this.checked(output);
          // 草案先记进会话：即便后面写盘失败，数据根里也留得下模型最终提了什么。
          const saved = await this.ruleStore.save(proposal.id, proposal.rego,
            { note: `误报维护（${who}）：${proposal.rationale.slice(0, 120)}` });
          rounds.push({ round, id: proposal.id, ok: true, error: null });
          await settle({ status: saved.action === 'unchanged' ? 'no_change' : 'updated',
            rounds, proposal: { id: proposal.id, rego: proposal.rego, rationale: proposal.rationale },
            validation: { ok: true, name: saved.name, file: saved.file, rev: saved.rev, rounds: rounds.length },
            result: { action: saved.action, file: saved.file, rev: saved.rev, previous_rev: saved.previous_rev } });
          // 返回形状与 P003-T013 一致（调用方 `maintainFalsePositive` 与既有测试都按这四个字段读）；
          // `rev` / `previous_rev` / 轮次落在会话文件里（`GET /api/rules/sessions/{id}` 可读全文）。
          return { id: proposal.id, file: saved.file, name: saved.name, action: saved.action,
            rationale: proposal.rationale };
        } catch (cause) {
          lastError = cause;
          rounds.push({ round, id: output?.id ?? null, ok: false,
            error: cause?.local ? String(cause.message).slice(0, 300) : reasonForRecord(cause) });
          await settle({ status: 'validating', rounds,
            proposal: output && typeof output === 'object' ? { id: String(output.id || ''), rego: String(output.rego || ''),
              rationale: String(output.reason || '').slice(0, 500) } : record?.proposal ?? null });
          messages.push({ role: 'assistant', content: JSON.stringify(output) });
          messages.push({ role: 'user', content:
            `上一轮未通过校验：${cause.message}。请修正后重新输出完整 JSON；如果确实无法在不放宽原条件的前提下修订，` +
            '输出 {"ready":false,"reason":"具体原因"}。' });
        }
      }
      throw lastError || new Error(`规则维护在 ${this.maxRounds} 轮内没有给出可落盘的修订`);
    } catch (cause) {
      // 会话落盘本身再挂，也不能顶掉原始错误：调用方要看到的是「为什么维护没成」。
      await settle({ status: 'failed', rounds,
        error: scrubCredentials(cause?.message || cause).slice(0, 300) }).catch(() => {});
      throw cause;
    }
  }
}
