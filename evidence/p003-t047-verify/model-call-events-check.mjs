// A5 断言的纯检查器：验收套件与变异探针（probe-a5-mutant.mjs）共用同一份逻辑。
// 依据：docs/architecture.md §3.6（ai.model_call 两条一对、定位键、outcome 四值）
//      docs/modules/http-api.md §3.4「每轮 AI 调用都进事件」（决策轮 turn=3 phase=propose）
// 这里只做判定，不碰被测实现，也不读实现源码。
const ROLES = ['fp_maintainer', 'rule_maintainer', 'wiki_maintainer'];
const ROLE_OF_COUNTER = { decision: 'fp_maintainer', rule: 'rule_maintainer', wiki: 'wiki_maintainer' };
const OUTCOMES = new Set(['ok', 'timeout', 'invalid_json', 'error']);

export function checkModelCallEvents(events, { expect, wikiSessionOf = () => undefined } = {}) {
  const wikiOf = typeof wikiSessionOf === 'function' ? wikiSessionOf : (sid) => wikiSessionOf[sid];
  const problems = [];
  const expectedCalls = expect.decision + expect.rule + expect.wiki;

  // 1) 总条数钉死：一次调用必是 request + response 各一条，一条不多一条不少
  if (events.length !== expectedCalls * 2) {
    problems.push(`事件总条数 ${events.length}，期望 ${expectedCalls * 2}（替身共收到 ${expectedCalls} 次调用，每次一对）`);
  }

  const req = events.filter((e) => e.direction === 'request');
  const res = events.filter((e) => e.direction === 'response');

  // 2) 绝对次数：每个 role 的事件条数 == 替身真实收到的调用数（替身是独立真值）
  for (const [counter, role] of Object.entries(ROLE_OF_COUNTER)) {
    const nReq = req.filter((e) => e.role === role).length;
    const nRes = res.filter((e) => e.role === role).length;
    if (nReq !== expect[counter]) problems.push(`role=${role} 的 request 事件 ${nReq} 条，替身实际收到 ${expect[counter]} 次调用`);
    if (nRes !== expect[counter]) problems.push(`role=${role} 的 response 事件 ${nRes} 条，替身实际收到 ${expect[counter]} 次调用`);
  }
  for (const [i, e] of events.entries()) {
    if (!ROLES.includes(e.role)) problems.push(`第 ${i + 1} 条事件 role=${e.role} 不是误报维护的三份角色之一`);
  }

  // 3) 逐轮唯一：每个 (role, session_id, turn, attempt) 每方向只该有一条（漏记第 2/4 次、重复记一条都在这里红）
  const seen = new Map();
  for (const e of events) {
    const k = `${e.direction}|${e.role}|${e.session_id ?? '-'}|${e.turn ?? '-'}|${e.attempt ?? '-'}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) problems.push(`${k} 出现 ${n} 次（每轮每 role 每方向只该有一条）`);
  }

  // 4) 成对：定位键 (role, session_id, turn, phase, attempt) 两侧一一对应
  const keyOf = (e) => `${e.role}|${e.session_id ?? '-'}|${e.turn ?? '-'}|${e.phase ?? '-'}|${e.attempt ?? '-'}`;
  const reqKeys = new Set(req.map(keyOf));
  const resKeys = new Set(res.map(keyOf));
  for (const k of reqKeys) if (!resKeys.has(k)) problems.push(`调用 ${k} 只有 request 没有 response`);
  for (const k of resKeys) if (!reqKeys.has(k)) problems.push(`调用 ${k} 只有 response 没有 request`);

  // 5) response 的结局字段（architecture.md §3.6）
  for (const [i, e] of events.entries()) {
    if (e.direction !== 'response') continue;
    if (!OUTCOMES.has(e.outcome)) problems.push(`第 ${i + 1} 条 response 的 outcome 不在四值里：${e.outcome}`);
    if (typeof e.duration_ms !== 'number') problems.push(`第 ${i + 1} 条 response 缺 duration_ms`);
  }

  // 6) 决策轮口径：role=fp_maintainer 是第 3 轮 propose（http-api.md §3.4）
  for (const [i, e] of events.entries()) {
    if (e.role !== 'fp_maintainer') continue;
    if (e.turn !== 3 || e.phase !== 'propose') {
      problems.push(`第 ${i + 1} 条决策轮应是 turn=3 phase=propose，实测 turn=${e.turn} phase=${e.phase}`);
    }
  }

  // 7) 顺序：同一轮里决策（propose）先于规则 / 知识维护（日志追加写，行序即发生序）
  for (const fpReq of req.filter((e) => e.role === 'fp_maintainer')) {
    const proposeAt = events.indexOf(fpReq);
    const ruleAt = events.findIndex((e) => e.direction === 'request' && e.role === 'rule_maintainer' && e.session_id === fpReq.session_id);
    if (ruleAt >= 0 && ruleAt < proposeAt) problems.push(`会话 ${fpReq.session_id}：规则维护调用出现在决策轮之前`);
    const wikiSession = wikiOf(fpReq.session_id);
    if (wikiSession) {
      const wikiAt = events.findIndex((e) => e.direction === 'request' && e.role === 'wiki_maintainer' && e.session_id === wikiSession);
      if (wikiAt >= 0 && wikiAt < proposeAt) problems.push(`会话 ${fpReq.session_id}：知识维护调用出现在决策轮之前`);
    }
  }

  if (problems.length) throw new Error(`ai.model_call 事件不符合文档口径（A5）：\n- ${problems.join('\n- ')}`);

  return {
    total: events.length,
    requests: req.length,
    responses: res.length,
    byRole: Object.fromEntries(ROLES.map((r) => [r, req.filter((e) => e.role === r).length])),
  };
}
