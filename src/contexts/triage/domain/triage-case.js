// triage 上下文 · 领域内核（P003-T075 批 3 的种子，T059/T085 先用）。
//
// 判定（Verdict）与案件状态（QueueState）的**唯一真源**——D034 §1 的头号包袱就是这里的值散在
// investigation-agent（verdictMap/verdictLabels）、triage-output（labels）、wiki-replay（names）、
// server.js（triageStatusFilters）四处的副本。本文件落地后，谁要判定词表谁 import 这里；
// 对外的字典接口（GET /api/dict，T059）也直接读这里，前端不再硬编码。

/** 三态结论（后端口径）；前端多出的「待研判」是 review 投影，不是第四种结论（D034 §4 #1）。 */
export const VERDICT_LABELS = Object.freeze({ threat: '真实威胁', uncertain: '存疑', false_positive: '误报' });
export const VERDICT_KEYS = Object.freeze(Object.keys(VERDICT_LABELS));

/** 模型输出的各种说法 → 三态。中英文别名与既有提示词口径一致，一处维护。 */
export const VERDICT_MAP = Object.freeze({
  '真实威胁': 'threat', '存疑': 'uncertain', '误报': 'false_positive',
  threat: 'threat', uncertain: 'uncertain', false_positive: 'false_positive',
  '确认威胁': 'threat', '疑似威胁': 'uncertain', '攻击尝试未成功': 'uncertain', '无法判定': 'uncertain',
  confirmed_threat: 'threat', suspected_threat: 'uncertain', unsuccessful_attack: 'uncertain',
  undetermined: 'uncertain', needs_review: 'uncertain', needs_data: 'uncertain', suggested_benign: 'false_positive'
});

/** 任意输入归一到三态键；认不出的回 null（调用方按存疑降级，不得编造第四态）。 */
export function normalizeVerdictInput(value) {
  return VERDICT_MAP[value] ?? null;
}

/** 案件队列状态五值：状态机的全部合法状态（迁移规则在 TriageMonitor，词表在这里）。 */
export const TRIAGE_STATUSES = Object.freeze(['not_queued', 'queued', 'running', 'done', 'failed']);

// ── 记录形状（P003-T077 批 3：从 triage-monitor.js 的队列/持久化两栏摘出来的纯函数）──────
// 人工登记的误报（误报入口写的就是 verdict=false_positive + decision_source=human）：重跑不覆盖结论区。
// AI 自己判出的 false_positive 不算——那种重跑仍旧按这次研判覆盖。
export const humanFalsePositive = record => record.verdict === 'false_positive' && record.decision_source === 'human';

// A6：队列里的证据条目只外露可复算的最小集合。工具入参要留——RPC 路径的 args 就是 {id} / {count,offset}，
// 剥掉之后看不出「这条证据查的是哪个范围」。只有含原文（长字符串/大对象）的 args 才剥，并标 args_omitted。
export const queueArgsMaxChars = 200;
export const queueArgValueMaxChars = 80;
function argsHaveRawText(args) {
  return Object.values(args).some(value => typeof value === 'string'
    ? value.length > queueArgValueMaxChars
    : value && typeof value === 'object' && JSON.stringify(value).length > queueArgValueMaxChars);
}
export function queueEvidenceItem({ evidence_id, tool, args, fetched_at, sha256 }) {
  const item = { evidence_id, tool, fetched_at, sha256 };
  if (args === undefined) return item;
  if (!argsHaveRawText(args) && JSON.stringify(args).length <= queueArgsMaxChars) item.args = args;
  else item.args_omitted = true;
  return item;
}
export const evidenceItems = entries => (Array.isArray(entries) ? entries : []).map(queueEvidenceItem);

// 结论区的事实/证据源计数：校验通过（或只删了未核验事实）时按有引用的 claim 算。
export function evidenceSummary(result) {
  const claims = result?.validation?.ok || result?.validation?.removed_unverified_facts
    ? (result?.verdict?.claims || []).filter(claim => Array.isArray(claim.citations) && claim.citations.length) : [];
  return { verified_facts: claims.length,
    evidence_sources: new Set(claims.flatMap(claim => claim.citations.map(citation => citation.evidence_id).filter(Boolean))).size };
}
