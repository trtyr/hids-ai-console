// 误报统一维护 Agent（P003-T047）。
//
// 一个案件一次多轮会话，四轮：读案卷 → 读两库 → 提修订（AI 决策）→ 自校验/写入。
// 三条纪律：
//   1. **写入只有两条老路**：规则走 `RegoRuleMaintainer`（→ `RuleStore.save()`，旧版进 `rules-history/`），
//      wiki 走 `WikiWorkbench.create → reply → publishBundle → recordPublished`（过发布前检查、会话置终态）。
//      本文件不直写 `rules/` 与 `wiki/`，那是 T041 的写入口。
//   2. **单腿可补跑**：幂等键 `case_id:库:库版本`。已成功的一侧（`status: 'updated'` 且库版本仍是当时那个）
//      再跑记 `state: 'skipped'`，不调模型、不写盘；失败的一侧照常重跑。
//   3. **自动判定待启用**（A7）：A/B 口径没拍板之前，Agent 产出照写，闭环标注 `auto_verdict.enabled=false`，
//      不把 AI 结论直接落成案件结论。
//
// 会话形制对齐 `wiki-sessions`（`wiki-workbench.js` 的 `save/list`）：一份 JSON 一个会话，
// `messages[]` 记人读得懂的一段话，`turns[]` 记程序推进到第几步，目录缺省是 `<数据根>/fp-sessions/`。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRuleId } from './rule-store.js';
import { traceModelCall } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_ID = /^[0-9a-f-]{36}$/i;

/** 两个可维护的库：规则库（Rego）与知识库（判据页）。 */
export const FP_LIBRARIES = Object.freeze(['rule', 'wiki']);
/** 决策轮 `decision.source` 的取值表：契约（openapi + 两页文档）与实现共用这一份。 */
export const FP_DECISION_SOURCES = Object.freeze(['model', 'fallback', 'idempotent']);
/** T046 事件里这一域的域名（`ai.model_call.domain`）：误报维护。 */
export const FP_DOMAIN = 'false_positive';
/** 这一域的模型角色名。决策模型复用 `models.rule_maintainer` 实例，角色标签单独记。 */
export const FP_ROLE = 'fp_maintainer';
/** 维护会话的终态：这三种都不会再自动往下跑。 */
export const FP_TERMINAL = Object.freeze(['done', 'partial', 'failed']);
/**
 * 闭环自动判定的生效口径（A7，A/B 已拍板）。
 *
 * 结论：**以 Rego 为准**——研判管线与规则维护读的是同一份 Rego 库（`RuleStore`，「同源」），
 * 自动判定只认这一条信任链（「单源」）；JSON 规则集（`triage-rules.json`）的修订照写留痕，
 * 但不是生效判据。会话与 `record.maintenance` 都带这一格，回头能说清「当时按哪条口径生效」。
 */
export const FP_AUTO_VERDICT = Object.freeze({
  enabled: true,
  criterion: 'rego',
  trust: 'single',
  note: 'A/B 已拍板：闭环自动判定以 Rego 规则库为准（研判管线同源、信任链单源）；JSON 规则集修订照写留痕，不作为生效判据'
});

export const fpSessionDirectory = root => path.join(root, 'fp-sessions');
export const defaultFpPromptFile = path.join(here, 'prompts', 'false-positive.md');

const nowIso = () => new Date().toISOString();
const text = value => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim();
const clipped = (value, limit) => String(value ?? '').slice(0, limit);

/**
 * 失败原因出记录/响应之前的凭据擦除（P003-T013 A4 的口径）。
 *
 * 上游模型客户端的报错常把请求头或 URL 拼进文案（`Authorization: Bearer …`、`?token=…`），
 * 维护侧的单边 `error` 会落进 `<数据根>/triage-monitor.json` 并经 `GET /api/agent/triage/{alertId}` 外发，
 * 所以**写之前**擦，而不是等出口再擦。实现只此一份：`server.js` 从这里 import（反向 import 会成环）。
 */
export function scrubCredentials(text) {
  return String(text ?? '')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(token|api[_-]?key|password|secret)=[^\s&"'，。；]+/gi, '$1=[redacted]');
}

// 案件里命中的 Rego 规则 id：结果落盘的 result.json 里就有，没有就当没命中（旧案件可能没有这条轨迹）。
export async function caseRegoRuleIds(caseDir) {
  if (!caseDir) return [];
  try {
    const saved = JSON.parse(await readFile(path.join(caseDir, 'result.json'), 'utf8'));
    const ids = saved?.verdict?.rego?.rule_ids;
    return Array.isArray(ids) ? ids.filter(id => isRuleId(id)) : [];
  } catch { return []; }
}

// 误报案件的 wiki 维护目标：优先分析时引用过的判据页，其次本场景第一页。
// `server.js` 的 `POST /api/wiki/sessions` 与本 Agent 共用这一处口径，两条入口选出来的页一致。
export async function wikiFeedbackTarget(wiki, { eventType, caseDir = null, page = null } = {}) {
  const index = await wiki.agentIndex(eventType);
  const eligible = index.pages.filter(item => item.path.startsWith(`${index.category}/`));
  let cited = [];
  try {
    const saved = JSON.parse(await readFile(path.join(caseDir, 'result.json'), 'utf8'));
    cited = (saved.trace || []).filter(item => item.kind === 'wiki' && item.id).map(item => item.id);
  } catch { /* 旧案件可能没有完整的引用轨迹 */ }
  const target = page ? eligible.find(item => item.path === page)
    : eligible.find(item => cited.includes(item.id)) || eligible[0];
  return target ? { page: target, eventType } : null;
}

/** 误报维护会话库：`<数据根>/fp-sessions/<uuid>.json`，原子写、`list()` 只回摘要。 */
export class FpSessionStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory) throw new Error('误报维护会话目录必须是路径');
    this.directory = path.resolve(directory);
  }

  file(id) {
    if (!SESSION_ID.test(String(id || ''))) throw Object.assign(new Error('误报维护会话 ID 无效'), { status: 400 });
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
    catch (cause) { await rm(temporary, { force: true }).catch(() => {}); throw cause; }
    return record;
  }

  async rows() {
    let names;
    try { names = await readdir(this.directory); }
    catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    const loaded = await Promise.all(names
      .filter(name => name.endsWith('.json') && SESSION_ID.test(name.slice(0, -5)))
      .map(name => this.get(name.slice(0, -5)).catch(() => null)));
    return loaded.filter(Boolean);
  }

  /** 摘要列表，按 `updated_at` 倒序：不塞案卷快照与模型正文。 */
  async list() {
    return (await this.rows())
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .map(({ id, case_id, event_type, who, status, terminal, decision, libraries_requested, outcomes, updated_at }) => ({
        id, case_id, event_type, who, status, terminal: terminal === true,
        libraries: Array.isArray(libraries_requested) ? libraries_requested : [],
        sides: FP_LIBRARIES.filter(library => outcomes?.[library]?.state === 'updated'),
        decision_source: decision?.source || null, updated_at }));
  }
}

// 决策模型的回包：必须是 JSON 对象；形状不对就抛（调用方退回「按请求的库逐个尝试」）。
function parseDecision(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let output;
  try { output = JSON.parse(raw); } catch { throw new Error('误报维护模型没有返回 JSON'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('误报维护模型没有返回 JSON 对象');
  return output;
}

// 规则库版本：这个库当前长什么样。有案件命中的规则就只算那几条（维护者只会动它们），
// 没有就整库算——改动任何一条都会让版本变，补跑判据才认得出「这一侧已经成功过」。
async function ruleLibraryRevision(ruleStore, ruleIds = []) {
  if (!ruleStore) return null;
  let ids = ruleIds.filter(id => isRuleId(id));
  let scope = 'case_rules';
  if (!ids.length) {
    const listed = await ruleStore.list();
    ids = listed.rules.map(item => item.id);
    scope = 'library';
  }
  const rows = [];
  for (const id of [...ids].sort()) {
    const rule = await ruleStore.read(id);
    if (rule) rows.push(`${id}:${rule.revision}`);
  }
  if (!rows.length) return null;
  return createHash('sha256').update(JSON.stringify({ scope, rows })).digest('hex').slice(0, 16);
}

const idempotencyKey = (caseId, library, revision) => `${caseId}:${library}:${revision ?? 'none'}`;

/**
 * 误报统一维护 Agent。依赖全部注入：单测里换的是模型与临时目录，生产走同一套代码。
 *
 * - `model`：决策模型（可以没有——没配就退化为「按请求的库逐个尝试」并记 `decision.source='fallback'`）。
 * - `ruleMaintainer`：`RegoRuleMaintainer`（T041 的版本化写入口），规则侧的执行就是它。
 * - `wikiAgent` / `wiki`：`WikiWorkbench` 与 `WikiStore`（T041 的发布闸）。
 * - `sessions`：`FpSessionStore`。
 */
export class FalsePositiveMaintainer {
  constructor({ model = null, ruleMaintainer = null, ruleStore = null, wikiAgent = null, wiki = null,
    sessions, promptFile = defaultFpPromptFile, now = nowIso } = {}) {
    if (!sessions) throw new Error('误报维护 Agent 需要会话存储');
    this.model = model;
    this.ruleMaintainer = ruleMaintainer;
    this.ruleStore = ruleStore || ruleMaintainer?.ruleStore || null;
    this.wikiAgent = wikiAgent;
    this.wiki = wiki || wikiAgent?.wiki || null;
    this.sessions = sessions;
    this.promptFile = promptFile;
    this.now = now;
  }

  // 读一页判据：库没给读接口（注入的替身）时回 null，调用方按「读不到」处理。
  async #page(filename) {
    if (!filename || typeof this.wiki?.get !== 'function') return null;
    try { return await this.wiki.get(filename); } catch { return null; }
  }

  // 会话每推进一轮就落盘：维护跑在后台，进程挂了数据根里也得看得出走到第几轮。
  async #step(record, patch = {}) {
    const next = { ...record, ...patch, updated_at: this.now() };
    await this.sessions.save(next);
    return next;
  }

  // 读案卷（第一轮）：原始告警 + 研判事实 + results.json 里的结论与引用。
  async #caseBrief({ caseId, caseDir, eventType, alert }) {
    const brief = { case_id: caseId, event_type: eventType, case_dir: caseDir || null, alert: alert || null };
    if (!caseDir) return { ...brief, files: {}, note: '案件没有目录：只按告警与人工理由维护' };
    for (const [key, name, limit] of [['raw', '01-原始告警.txt', 2000], ['facts', '03-研判事实.md', 2000], ['result', 'result.json', 4000]]) {
      try { brief[`file_${key}`] = clipped(await readFile(path.join(caseDir, name), 'utf8'), limit); }
      catch { brief[`file_${key}`] = null; }
    }
    try {
      const saved = JSON.parse(brief.file_result || 'null') || {};
      brief.verdict = saved.verdict?.verdict || null;
      brief.rego_rule_ids = saved.verdict?.rego?.rule_ids || [];
      brief.cited_wiki_ids = (saved.trace || []).filter(item => item.kind === 'wiki' && item.id).map(item => item.id);
    } catch { /* 旧案件 result.json 可能不完整：案卷正文照旧进上下文 */ }
    return brief;
  }

  // 读两库（第二轮）：规则库清单 + 命中规则的原文；知识库的维护目标页与同场景其他页。
  async #libraryBrief({ eventType, caseDir, ruleIds }) {
    const brief = { rules: { count: 0, candidates: [], matched: [] }, wiki: { target: null, siblings: [] } };
    if (this.ruleStore) {
      try {
        const listed = await this.ruleStore.list();
        brief.rules.count = listed.count;
        brief.rules.candidates = listed.rules.map(({ id, name, file }) => ({ id, name, file }));
      } catch (cause) { brief.rules.error = text(cause?.message || cause); }
      for (const id of ruleIds) {
        try {
          const rule = await this.ruleStore.read(id);
          if (rule) brief.rules.matched.push({ id: rule.id, name: rule.name, rego: clipped(rule.rego, 4000) });
        } catch { /* 读不到就当没命中：规则维护者会按 id 自己再读一遍 */ }
      }
    } else {
      brief.rules.error = '规则库未接线';
    }
    if (this.wiki) {
      try {
        const target = await wikiFeedbackTarget(this.wiki, { eventType, caseDir });
        if (target) {
          // 判据页正文与 revision 只在库给了读接口时取（注入的替身可能只有目录 + 发布两件）；
          // 取不到就把 revision 留空——补跑判据那一格宁可保守（不跳），也不要拿错的版本号去判「已维护过」。
          const page = await this.#page(target.page.path);
          brief.wiki.target = { path: target.page.path, id: target.page.id, title: target.page.title,
            revision: page?.revision ?? null, content: clipped(page?.content ?? '', 9000) };
          const index = await this.wiki.agentIndex(eventType);
          brief.wiki.siblings = index.pages.filter(item => item.path !== target.page.path).slice(0, 8)
            .map(({ id, title, path: value }) => ({ id, title, path: value }));
        } else {
          brief.wiki.error = '当前场景缺少可维护的判据页';
        }
      } catch (cause) { brief.wiki.error = text(cause?.message || cause); }
    } else {
      brief.wiki.error = '知识库未接线';
    }
    return brief;
  }

  // 提修订（第三轮）：这一次动哪边、为什么。没配模型就退化为按请求的库逐个尝试（决策来源如实记下）。
  async #decide({ record, pending, caseBrief, libraryBrief, reason, who }) {
    const fallback = why => ({ source: 'fallback', libraries: pending, why, at: this.now(), error: null });
    if (!this.model) return fallback('统一维护模型未配置：按请求的库逐个尝试');
    let prompt;
    try { prompt = await readFile(this.promptFile, 'utf8'); }
    catch (cause) { return fallback(`维护提示词读取失败（${text(cause?.message || cause)}）：按请求的库逐个尝试`); }
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ false_positive_reason: reason, reported_by: who,
        libraries_requested: pending, case: caseBrief, libraries: libraryBrief,
        output_contract: { libraries: ['rule', 'wiki'], why: '本次为什么动这几边（一到三句）' } }) }
    ];
    try {
      const replied = await traceModelCall({ domain: FP_DOMAIN, role: FP_ROLE, turn: record.turns.length + 1,
        phase: 'propose', sessionId: record.id, alertId: record.case_id,
        model: this.model?.model || null, messages, tools: [] },
      () => this.model.complete(messages, [], 'none'), { decode: value => parseDecision(value.content) });
      const output = replied.decoded;
      const picked = (Array.isArray(output.libraries) ? output.libraries : [])
        .map(value => text(value)).filter(value => pending.includes(value));
      return { source: 'model', libraries: [...new Set(picked)],
        why: clipped(text(output.why) || '模型未说明理由', 500), at: this.now(), error: null,
        call: replied.call };
    } catch (cause) {
      return fallback(`决策模型没有给出可用结论（${clipped(text(cause?.message || cause), 200)}）：按请求的库逐个尝试`);
    }
  }

  // 规则侧：执行交给 `RegoRuleMaintainer`（唯一写入口在 `RuleStore.save()`），这里只做自校验。
  async #maintainRule({ caseId, caseDir, eventType, reason, who, alert, ruleIds, why, currentRevision, sessionId }) {
    if (!this.ruleMaintainer) throw new Error('规则维护者未配置');
    // 域传下去：规则维护这一轮的 `ai.model_call` 也记在误报维护域（A5）。
    const result = await this.ruleMaintainer.maintain({ caseId, caseDir, eventType, reason, who, alert, ruleIds,
      domain: FP_DOMAIN, sessionId });
    // 自校验：注入的维护者不带规则库（单测替身）时只记 skipped，不把「读不到」算成失败。
    const checks = [];
    if (!this.ruleStore) {
      checks.push({ name: 'rule_readable', ok: false, skipped: true, detail: '注入的规则维护者没有规则库，跳过读回校验' });
    } else {
      const written = await this.ruleStore.read(result.id);
      checks.push({ name: 'rule_readable', ok: Boolean(written), detail: written?.file || result.file || null });
      if (result.action === 'update') {
        // A3 的版本化：改已有规则时旧版必须已经进历史（`<数据根>/rules-history/<id>-<rev>.rego`）。
        const history = await this.ruleStore.history(result.id).catch(() => []);
        checks.push({ name: 'rule_versioned', ok: history.length > 0, detail: history.at(-1)?.rev || null });
      }
    }
    return { library: 'rule', state: 'updated', why, id: result.id, file: result.file, name: result.name,
      action: result.action, rationale: clipped(result.rationale, 500), revision: currentRevision,
      previous_revision: null, checks };
  }

  // 知识库侧：走 T041 的维护会话与发布闸，发布成功后会话置终态（`recordPublished`）。
  async #maintainWiki({ caseId, caseDir, eventType, reason, who, libraryBrief, why, currentRevision }) {
    if (!this.wikiAgent || !this.wiki) throw new Error('知识维护端未配置');
    const target = libraryBrief.wiki?.target;
    if (!target) throw new Error(libraryBrief.wiki?.error || '当前场景缺少可维护的判据页');
    const session = await this.wikiAgent.create(target.path, { case_id: caseId, case_dir: caseDir,
      event_type: eventType, reason, who, expected_verdict: 'false_positive', domain: FP_DOMAIN });
    let wikiSession = session;
    try {
      const advanced = await this.wikiAgent.reply(session.id,
        `人工登记误报：${reason}。请按 _schema.md 核对判据是否需要修订，需要就给出完整修订草案。`);
      wikiSession = advanced || session;
      const proposal = advanced?.proposal;
      if (!proposal) throw new Error(`维护者没有产出方法论修订（会话 ${session.id} 状态 ${advanced?.status || '未知'}）`);
      const changes = Array.isArray(proposal.changes) && proposal.changes.length ? proposal.changes
        : [{ path: target.path, content: proposal.content, page_revision: proposal.page_revision }];
      if (!changes.some(change => change.path === target.path)) throw new Error('方法论修订草案没有覆盖当前判据页');
      // 发布闸：结构、断链、证据引用、页面版本全在 `publishBundle` 里过；reviewer 记登记人，note 记他给的理由。
      const pages = await this.wiki.publishBundle(changes, proposal.evidence_preview || null,
        { reviewer: who, note: reason.slice(0, 500), case_id: caseId });
      // 发布成功后把会话置终态（A3）。注入的知识维护端没有这一件时跳过——生产里 `WikiWorkbench` 有。
      const canClose = typeof this.wikiAgent.recordPublished === 'function';
      const published = canClose ? await this.wikiAgent.recordPublished(session.id, { pages, reviewer: who, note: reason,
        case_id: caseId, evidence_path: proposal.evidence_preview?.path || null }) : null;
      const written = pages.find(item => item.path === target.path) || pages[0];
      const page = await this.#page(written.path);
      const checks = [
        page
          ? { name: 'wiki_published', ok: page.revision === written.revision, detail: written.revision || null }
          : { name: 'wiki_published', ok: false, skipped: true, detail: '注入的知识库没有读接口，按写入返回值收尾' },
        canClose
          ? { name: 'wiki_session_terminal', ok: published?.status === 'published', detail: published?.status || null }
          : { name: 'wiki_session_terminal', ok: false, skipped: true, detail: '注入的知识维护端没有 recordPublished' }
      ];
      return { library: 'wiki', state: 'updated', why, session_id: session.id, page: written.path,
        pages: pages.map(item => item.path), revision: page?.revision ?? written.revision ?? null,
        previous_revision: currentRevision, wiki_session_status: published?.status ?? advanced?.status ?? null, checks };
    } catch (cause) {
      // 失败原因挂上会话 id 与它当前的状态：草案留在 `ready_for_review` 时，人工还能接着审核发布。
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const current = typeof this.wikiAgent.get === 'function'
        ? await this.wikiAgent.get(session.id).catch(() => null) || wikiSession : wikiSession;
      Object.assign(error, { wiki_session_id: session.id, wiki_session_status: current?.status || null });
      throw error;
    }
  }

  /**
   * 跑一轮维护。
   * `previous` 是**这一条案件上一轮的 `record.maintenance`**（误报入口在重置它之前捞出来传进来）：
   * 补跑判据读它，不扫会话目录——同一案件的历史就在案件记录上，不跨案件、不跨部署串味。
   */
  async maintain({ caseId, caseDir = null, eventType = null, reason, who, alert = null,
    libraries = FP_LIBRARIES, previous = null }) {
    const requested = [...new Set((Array.isArray(libraries) ? libraries : [libraries]).map(text).filter(Boolean))];
    const unknown = requested.filter(value => !FP_LIBRARIES.includes(value));
    if (!requested.length || unknown.length)
      throw Object.assign(new Error(`维护库无效：${requested.length ? unknown.join('、') : '(空)'}（只能是 rule 或 wiki）`), { status: 400 });

    const at = this.now();
    let record = await this.sessions.save({ id: randomUUID(), case_id: caseId, case_dir: caseDir || null,
      event_type: eventType, who, reason, libraries_requested: requested, status: 'collecting', terminal: false,
      decision: null, turns: [], messages: [], outcomes: {}, validation: null,
      auto_verdict: { ...FP_AUTO_VERDICT }, created_at: at, updated_at: at });

    const turn = async (phase, summary, message = null) => {
      record.turns.push({ n: record.turns.length + 1, phase, at: this.now(), summary });
      if (message) record.messages.push({ ...message, at: this.now() });
      record = await this.#step(record);
    };

    try {
      // ── 第一轮：读案卷 ────────────────────────────────────────────────
      const caseBrief = await this.#caseBrief({ caseId, caseDir, eventType, alert });
      const ruleIds = [...new Set([...(await caseRegoRuleIds(caseDir)), ...(caseBrief.rego_rule_ids || []).filter(id => isRuleId(id))])];
      await turn('case', `读案卷：${caseDir ? '原始告警 / 研判事实 / result.json 已进上下文' : '案件无目录，按告警与人工理由维护'}`,
        { role: 'user', kind: 'case', content: JSON.stringify({ case_id: caseId, event_type: eventType,
          false_positive_reason: reason, reported_by: who, case: caseBrief }) });

      // ── 第二轮：读两库 ────────────────────────────────────────────────
      const libraryBrief = await this.#libraryBrief({ eventType, caseDir, ruleIds });
      await turn('libraries', `读两库：规则库 ${libraryBrief.rules.count} 条、命中 ${libraryBrief.rules.matched.length} 条；`
        + `知识库目标页 ${libraryBrief.wiki.target?.path || '未定（' + (libraryBrief.wiki.error || '无') + '）'}`,
      { role: 'user', kind: 'libraries', content: JSON.stringify(libraryBrief) });

      // ── 幂等：同一案件、同一库、同一版本已经成功过的，这一次不重复执行 ──────────
      const currentRevision = {
        rule: requested.includes('rule') ? await ruleLibraryRevision(this.ruleStore, ruleIds).catch(() => null) : null,
        wiki: requested.includes('wiki') ? libraryBrief.wiki.target?.revision ?? null : null
      };
      const outcomes = {};
      let pending = [];
      for (const library of requested) {
        // 已成功的一侧：上一轮写完之后库停在这个版本上，现在还是这个版本 → 这一轮不重复执行。
        // `skipped` 也算「已成功过」：单腿补跑（只跑另一侧）那一轮会把这一侧标 skipped 但保住 revision，
        // 补完之后再全量登记时，这一侧仍然是同一版本 —— A4 的承诺在「成功 → 单腿 → 全量」序列上才成立。
        const side = previous?.[library] || null;
        const done = side && ['updated', 'skipped'].includes(side.state) && side.revision &&
          side.revision === currentRevision[library];
        if (done) {
          outcomes[library] = { library, state: 'skipped', status: 'updated', why: '幂等：同一案卷、同一库、同一版本已经维护过',
            idempotency_key: idempotencyKey(caseId, library, currentRevision[library]), revision: currentRevision[library],
            previous_session: side.session_id || null, at: this.now() };
        } else {
          pending.push(library);
        }
      }
      if (!pending.length) {
        record = await this.#step(record, { outcomes, status: 'done', terminal: true,
          validation: { ok: true, checks: [] },
          decision: { source: 'idempotent', libraries: [], why: '请求的库都已维护过：这一轮没有执行任何写入', at: this.now(), error: null } });
        await turn('skip', '补跑判定：请求的库都已在同一版本上维护过，本轮不写盘、不调模型');
        return record;
      }

      // ── 第三轮：提修订（动哪边、为什么）────────────────────────────────
      const decision = await this.#decide({ record, pending, caseBrief, libraryBrief, reason, who });
      record = await this.#step(record, { decision });
      await turn('propose', `决策（${decision.source}）：动 ${decision.libraries.join('、') || '无'}；${decision.why}`,
        { role: 'assistant', kind: 'decision', content: decision.why });

      // ── 第四轮：写入 + 自校验 ──────────────────────────────────────────
      for (const library of requested) {
        if (outcomes[library]) continue; // 幂等跳过的一侧
        if (!decision.libraries.includes(library)) {
          outcomes[library] = { library, state: 'no_change', status: 'updated', why: decision.why,
            idempotency_key: idempotencyKey(caseId, library, currentRevision[library]),
            revision: currentRevision[library], at: this.now() };
          continue;
        }
        try {
          const outcome = library === 'rule'
            ? await this.#maintainRule({ caseId, caseDir, eventType, reason, who, alert, ruleIds,
              why: decision.why, currentRevision: currentRevision.rule, sessionId: record.id })
            : await this.#maintainWiki({ caseId, caseDir, eventType, reason, who, libraryBrief,
              why: decision.why, currentRevision: currentRevision.wiki });
          // 写完之后这一侧的库版本（补跑判据拿它跟下一次的当前版本比）。
          const after = library === 'rule'
            ? await ruleLibraryRevision(this.ruleStore, ruleIds).catch(() => currentRevision.rule)
            : outcome.revision ?? currentRevision.wiki;
          // skipped 的校验项不算失败（注入的替身缺读接口时只能跳到下一项）。
          const failedCheck = (outcome.checks || []).find(check => check.ok !== true && check.skipped !== true);
          outcomes[library] = { ...outcome, revision: after, at: this.now(),
            idempotency_key: idempotencyKey(caseId, library, after),
            ...(failedCheck ? { state: 'failed', status: 'failed', error: `自校验未通过：${failedCheck.name}` } : {}) };
        } catch (cause) {
          // 先擦凭据再落：这条 error 会进 `record.maintenance.<边>.error` 并随记录外发（T013 A4）。
          outcomes[library] = { library, state: 'failed', status: 'failed',
            why: decision.why, error: clipped(scrubCredentials(cause?.message || cause), 300),
            idempotency_key: idempotencyKey(caseId, library, currentRevision[library]),
            revision: currentRevision[library], at: this.now(),
            ...(cause?.wiki_session_id ? { session_id: cause.wiki_session_id, wiki_session_status: cause.wiki_session_status } : {}) };
        }
        await this.#step(record, { outcomes: { ...outcomes } });
      }

      const executed = requested.map(library => outcomes[library]).filter(Boolean);
      const failed = executed.filter(outcome => outcome.state === 'failed');
      const status = !failed.length ? 'done' : failed.length === executed.length ? 'failed' : 'partial';
      const checks = executed.flatMap(outcome => (outcome.checks || []).map(check => ({ library: outcome.library, ...check })));
      record = await this.#step(record, { outcomes, status, terminal: FP_TERMINAL.includes(status),
        validation: { ok: !failed.length, checks } });
      await turn('verify', `自校验：${failed.length ? `${failed.length} 侧失败` : '全部通过'}`,
        { role: 'assistant', kind: 'verify', content: JSON.stringify({ status, outcomes: executed.map(({ library, state, error }) =>
          ({ library, state, ...(error ? { error } : {}) })) }) });
      return record;
    } catch (cause) {
      record = await this.#step(record, { status: 'failed', terminal: true,
        error: clipped(scrubCredentials(cause?.message || cause), 300) });
      throw cause;
    }
  }
}

/**
 * 会话里的单边状态 → `record.maintenance` 的单边状态。
 * `status` 仍用既有词表（`updating|updated|failed`，T013 与 openapi 都按它写），新状态（`no_change` / `skipped` / `updated`）落在 `state`。
 * 没请求 / 没这条 outcome 的一侧沿用调用方给的兜底（`{status:'updated', state:'skipped', why}`）。
 */
export function maintenanceSide(outcome, fallback = { status: 'updated' }) {
  if (!outcome) return { ...fallback };
  const { library, state, why, error, idempotency_key, revision, previous_revision, at, checks, ...rest } = outcome;
  return { status: state === 'failed' ? 'failed' : 'updated', state, ...(why ? { why } : {}),
    ...(error ? { error } : {}), ...(idempotency_key ? { idempotency_key } : {}),
    ...(revision ? { revision } : {}), ...(previous_revision ? { previous_revision } : {}),
    ...(at ? { at } : {}), ...(checks?.length ? { checks } : {}), ...rest };
}

/** 会话里「这次都动了哪边」：真的写了库的一侧（`updated`），以及没动的原因。 */
export function maintenanceSides(record) {
  const outcomes = record?.outcomes || {};
  return FP_LIBRARIES.filter(library => outcomes[library]?.state === 'updated');
}
