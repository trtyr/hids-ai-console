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
