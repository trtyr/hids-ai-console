const MAX_JUDGMENT_LENGTH = 300;
const labels = { threat: '真实威胁', uncertain: '存疑', false_positive: '误报' };

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function limit(value, max) {
  const chars = Array.from(clean(value));
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max - 1).join('');
  const boundary = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'));
  return boundary > max / 2 ? head.slice(0, boundary + 1) : `${head.replace(/[，、；：。\s]+$/, '')}。`;
}

function suggestedActions(verdict) {
  const existing = Array.isArray(verdict.next_actions) && verdict.next_actions.length
    ? verdict.next_actions : Array.isArray(verdict.recommended_actions) ? verdict.recommended_actions : [];
  const fallback = verdict.verdict === 'threat'
    ? '安排安全人员优先核对受影响主机和关联会话，保留原始证据后决定隔离范围'
    : verdict.verdict === 'false_positive'
      ? '核对本次行为与已确认的良性条件，确认后再决定是否调整告警规则'
      : `先核查${clean(verdict.missing_evidence?.[0] || '原始告警和相关会话')}，再决定处置方式`;
  const contradictory = verdict.verdict === 'false_positive'
    ? /建议.{0,6}(?:隔离|封禁|阻断|删除|升级处置)/
    : verdict.verdict === 'threat' ? /建议.{0,8}(?:忽略|关闭.{0,3}告警|加白|放行)/ : null;
  const actions = (existing.length ? existing : [fallback]).slice(0, 5)
    .map(value => clean(value)).filter(Boolean)
    .map(value => /^(建议|可考虑)/.test(value) ? value : `建议${value.replace(/^请/, '')}`)
    .filter(value => !contradictory?.test(value));
  verdict.next_actions = actions.length ? actions : [`建议${fallback}`];
  verdict.recommended_actions = verdict.next_actions;
}

export function finalizeTriageOutput(verdict) {
  const label = labels[verdict.verdict] || '存疑';
  verdict.verdict_label = label;
  verdict.summary = limit(verdict.summary, MAX_JUDGMENT_LENGTH);
  suggestedActions(verdict);
  const existing = clean(verdict.report).replace(/^#+\s*/, '');
  const lead = `建议判定为${label}。`;
  const candidate = existing && !existing.includes(label) ? `${lead}${existing}` : existing;
  const conflicts = Object.values(labels).some(other => other !== label &&
    new RegExp(`(?:判定|结论|判断|研判)为?${other}`).test(candidate));
  const forcedReview = label === '存疑' && (verdict.missing_evidence || []).some(item =>
    /引用校验未通过|误报结论缺少|独立复核未支持|独立复核未完成/.test(String(item)));
  const usable = candidate && Array.from(candidate).length <= MAX_JUDGMENT_LENGTH &&
    candidate.includes(label) && !conflicts && !forcedReview && !contradictoryReport(candidate, verdict.verdict) &&
    !/(?:^|\s)#{1,6}\s|\|\s*---|综上所述|AI 的推理/.test(candidate);
  if (usable) { verdict.report = candidate; return verdict; }

  const detail = forcedReview ? '当前证据或独立复核不足以支持更明确的结论。' : limit(verdict.summary, 150);
  const facts = (verdict.claims || []).slice(0, 2).map(item => clean(item.text))
    .filter(item => item && Array.from(item).length <= 65);
  const gap = forcedReview ? '仍缺少支持更明确结论的证据' : limit(verdict.missing_evidence?.[0], 75);
  const sentence = value => /[。！？]$/.test(value) ? value : `${value}。`;
  const parts = [lead, detail ? sentence(detail) : '', facts.length ? `已核实：${facts.join('；')}。` : '',
    gap ? `仍需核查：${sentence(gap)}` : ''].filter(Boolean);
  let output = lead;
  for (const part of parts.slice(1)) {
    if (Array.from(`${output}${part}`).length > MAX_JUDGMENT_LENGTH) break;
    output += part;
  }
  verdict.report = limit(output, MAX_JUDGMENT_LENGTH);
  return verdict;
}

function contradictoryReport(report, verdict) {
  if (verdict === 'false_positive') return /建议.{0,6}(?:隔离|封禁|阻断|删除)/.test(report);
  if (verdict === 'threat') return /建议.{0,8}(?:忽略|关闭.{0,3}告警|加白|放行)/.test(report);
  return false;
}
