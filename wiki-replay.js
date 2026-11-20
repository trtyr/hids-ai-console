import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { recordFailure } from './src/shared/redaction.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const verdicts = new Set(['threat', 'uncertain', 'false_positive']);
const names = { threat: '真实威胁', uncertain: '存疑', false_positive: '误报' };
const normalize = value => ({ 真实威胁: 'threat', 存疑: 'uncertain', 误报: 'false_positive' })[value] || value;
const caseMaterial = feedback => ({
  raw: String(feedback.case_snapshot?.['01-原始告警.txt'] || '').slice(0, 12000),
  facts: String(feedback.case_snapshot?.['03-研判事实.md'] || '').slice(0, 12000),
  human_reason: String(feedback.reason || '').slice(0, 4000)
});

export function replayProposalHash(changes) {
  return hash(changes.map(({ path, content, page_revision }) => ({ path, content, page_revision })));
}

async function loadCases(record, directory, wiki, changedPaths) {
  let files = [];
  try { files = await readdir(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const prior = (await Promise.all(files.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(async name => {
    try { return JSON.parse(await readFile(path.join(directory, name), 'utf8')); }
    catch { return null; }
  }))).filter(item => item?.status === 'published' && item?.audit?.reviewer && item?.feedback);
  prior.sort((a, b) => String(b.audit.at || '').localeCompare(String(a.audit.at || '')));
  const candidates = [...(record.feedback ? [{ ...record, label_kind: '待审核反馈' }] : []),
    ...prior.filter(item => item.id !== record.id).map(item => ({ ...item, label_kind: '已审核反馈' }))];
  const cases = [], seen = new Set();
  for (const item of candidates) {
    const feedback = item.feedback;
    if (!verdicts.has(feedback.expected_verdict) || !feedback.case_id || seen.has(feedback.case_id)) continue;
    const material = caseMaterial(feedback);
    if (!material.raw || !material.facts) continue;
    let index;
    try { index = await wiki.agentIndex(feedback.event_type); } catch { continue; }
    if (!index.pages.some(page => changedPaths.has(page.path))) continue;
    seen.add(feedback.case_id);
    cases.push({ case_id: feedback.case_id, event_type: feedback.event_type,
      expected_verdict: feedback.expected_verdict, label_kind: item.label_kind,
      original_verdict: feedback.original_verdict || null, material,
      input_sha256: hash(material), wiki_paths: index.pages.map(page => page.path) });
  }
  return { selected: cases.slice(0, 5), omitted: Math.max(0, cases.length - 5), eligible: cases.length };
}

async function wikiContext(item, wiki, candidate) {
  const pages = await Promise.all(item.wiki_paths.map(async filename => {
    const original = await wiki.get(filename);
    return { path: filename, id: original.id, content: candidate.get(filename) || original.content };
  }));
  return pages.filter(page => !/^status:\s*deprecated\s*$/m.test(page.content))
    .map(page => ({ ...page, content: page.content.slice(0, 15000) }));
}

async function evaluate(model, prompts, item, pages) {
  const scenario = prompts.scenarios?.cards?.find(card => card.id === item.event_type)?.prompt || '';
  const system = `你在做 Wiki 发布前的冻结材料回放。使用同一份已保存的案件材料作三态判断；只考虑给定判据版本，不能查询实时 API，也不能虚构不存在的授权、结果或工具调用。人工理由是现场声明，须核对其具体范围；缺关键事实判存疑。只输出 JSON：{"verdict":"threat|uncertain|false_positive","basis_quote":"案件材料中的一段连续原文","criterion_quote":"给定判据中的一段连续原文","missing_data":["还缺的事实"],"reason":"简短理由"}。basis_quote 和 criterion_quote 必须逐字出现在输入中，不得只用判据代替本案事实。\n\n# 当前通用研判提示\n${String(prompts.prompts?.triage || '').slice(0, 14000)}\n\n# 通用 SOP\n${String(prompts.sop?.common || '').slice(0, 6000)}\n\n# 场景提示\n${String(scenario).slice(0, 10000)}`;
  const input = { event_type: item.event_type, case_material: item.material,
    criteria: pages.map(page => ({ id: page.id, content: page.content })) };
  try {
    const response = await model.complete([{ role: 'system', content: system },
      { role: 'user', content: JSON.stringify(input) }], [], 'none');
    const result = JSON.parse(String(response.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const verdict = normalize(result.verdict);
    const basis = String(result.basis_quote || '').trim();
    const criterion = String(result.criterion_quote || '').trim();
    const materialText = Object.values(item.material).join('\n');
    if (!verdicts.has(verdict) || basis.length < 4 || !materialText.includes(basis) ||
        criterion.length < 4 || !pages.some(page => page.content.includes(criterion)))
      throw new Error('模型结论缺少可在冻结材料和判据中逐字核对的摘录');
    return { verdict, verdict_label: names[verdict], basis_quote: basis.slice(0, 250),
      criterion_quote: criterion.slice(0, 250), reason: String(result.reason || '').slice(0, 500),
      missing_data: Array.isArray(result.missing_data) ? result.missing_data.map(value => String(value).slice(0, 200)).slice(0, 5) : [] };
  // 记录侧不写错误原文（P003-T052）：这份 error 经 `wiki-workbench.js` 的 `save()` 进 `proposal.replay`，
  // 只留固定文案 + 原文字符量；「摘录对不上」是本模块自己写死的判定语，照原样留（调用方要知道差在哪）。
  } catch (error) {
    return { error: recordFailure(error, { kind: error instanceof SyntaxError ? '模型回包不是合法 JSON' : '回放失败',
      keep: ['模型结论缺少可在冻结材料和判据中逐字核对的摘录'] }) };
  }
}

export async function runWikiReplay({ record, directory, wiki, model, prompts }) {
  if (!record.proposal?.changes?.length) throw new Error('当前没有可回放的判据草案');
  const changes = record.proposal.changes;
  const changedPaths = new Set(changes.map(item => item.path));
  for (const change of changes) {
    const page = await wiki.get(change.path);
    if (page.revision !== change.page_revision)
      throw Object.assign(new Error(`判据 ${page.id} 已更新，请重新整理草案`), { status: 409 });
  }
  const corpus = await loadCases(record, directory, wiki, changedPaths);
  const prompt = await prompts.load();
  const report = { status: 'no_cases', at: new Date().toISOString(), proposal_hash: replayProposalHash(changes),
    prompt_revision: prompt.revision, model: model?.model || 'unknown',
    corpus: { eligible: corpus.eligible, selected: corpus.selected.length, omitted: corpus.omitted },
    cases: [], explanation: '同一份冻结材料分别配旧判据和草案判据；这只检验判据变化的影响，不等同于重新调用牧云取证。' };
  if (!corpus.selected.length) return report;
  if (!model) throw new Error('知识回放模型尚未配置');
  const candidate = new Map(changes.map(item => [item.path, item.content]));
  for (const item of corpus.selected) {
    const oldPages = await wikiContext(item, wiki, new Map());
    const newPages = await wikiContext(item, wiki, candidate);
    const [before, after] = await Promise.all([
      evaluate(model, prompt, item, oldPages), evaluate(model, prompt, item, newPages)
    ]);
    const changed = Boolean(before.verdict && after.verdict && before.verdict !== after.verdict);
    const matchesExpected = after.verdict === item.expected_verdict;
    const status = before.error || after.error ? 'invalid' :
      item.label_kind === '已审核反馈' && before.verdict === item.expected_verdict && !matchesExpected ? 'regression' :
        matchesExpected ? changed ? 'improved' : 'matched' : 'mismatch';
    report.cases.push({ case_id: item.case_id, event_type: item.event_type,
      label_kind: item.label_kind, expected_verdict: item.expected_verdict,
      original_verdict: item.original_verdict, input_sha256: item.input_sha256,
      before, after, changed, status });
  }
  report.status = report.cases.some(item => ['invalid', 'regression', 'mismatch'].includes(item.status))
    ? 'needs_review' : 'passed';
  return report;
}
