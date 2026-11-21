// P003-T047 单测夹具：真 RuleStore / 真 WikiStore / 真 WikiWorkbench / 真 RegoRuleMaintainer，
// 只把**模型**换成替身（与 evidence/test/P003-T013 的台子同一套思路，但库根都是临时目录，不碰数据根）。
//
// 每个用例 100ms 量级：wiki 只拷 honeypot/ + common/ + _schema.md + _evidence/（判据页引用的证据页要能读到）。
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuleStore } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';
import { WikiStore } from '../../../src/contexts/knowledge/infrastructure/wiki-store.js';
import { WikiWorkbench } from '../../../src/contexts/maintenance/application/wiki-workbench.js';
import { RegoRuleMaintainer } from '../../../server.js';
import { FalsePositiveMaintainer, FpSessionStore } from '../../../src/contexts/maintenance/application/fp-maintainer.js';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
export const CASE_ID = 'syslog:honeypot:0123456789abcdef:1763373600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
export const REASON = '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单';
export const WHO = '值班分析员';
export const TARGET_PAGE = 'honeypot/HP-10.md';

export const TIGHTENED_REGO = `package hids.rules.honeypot_probe

# name: 蜜罐探测（root 用户）
# description: 蜜罐类型告警，对端与来源 IP 都非空、用户为 root 的探测；已登记的授权扫描来源不再命中

default match := false

match if {
  input.type == "honeypot"
  input.peer != ""
  input.source_ip != ""
  input.source_ip != "203.0.113.9"
  input.user == "root"
}
`;

// 判据页修订：保留 id / title / applies_to / evidence，只加一段维护记录并改 updated 日期（发布闸要求 updated 是日期）。
export const pageUpdate = content => content.replace(/^updated: .*$/m, 'updated: 2026-11-20')
  + '\n\n## 维护记录（P003-T047 单测）\n\n已登记的授权扫描来源不改变判据主结论；来源与适用边界见证据页。\n';

export async function makeCase(base) {
  const caseDir = path.join(base, 'cases', CASE_ID.replaceAll(':', '_'));
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '01-原始告警.txt'),
    '<134>1 2026-11-18T10:00:00Z host app - cloudwalker-honeypot event_id=7 host_ip=10.0.0.5 source_ip=203.0.113.9\n');
  await writeFile(path.join(caseDir, '03-研判事实.md'), '# 研判事实\n\n主机 IP：10.0.0.5\n事件时间：2026-11-18 10:00:00\n来源：203.0.113.9\n');
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify({ alert_id: CASE_ID, mode: 'triage',
    trace: [{ kind: 'wiki', action: 'page', id: 'HP-10' }],
    verdict: { verdict: 'threat', rego: { status: 'matched', rule_ids: ['honeypot_probe'] },
      wiki: { consulted: ['HP-10'] } } }));
  return caseDir;
}

function ruleModelProposal() {
  return { complete: async () => ({ content: JSON.stringify({ ready: true, id: 'honeypot_probe',
    name: '蜜罐探测（root 用户）', reason: '把已登记的授权扫描来源排除', rego: TIGHTENED_REGO }) }) };
}

function wikiModelProposal() {
  return { complete: async messages => {
    const user = JSON.parse(messages.at(-1).content);
    return { content: JSON.stringify({ reply: '已给出草案', diagnosis: 'criterion_gap', ready: true,
      proposed_content: pageUpdate(user.current_page), rationale: '补授权扫描来源的适用边界' }) };
  } };
}

const wikiPrompts = {
  load: async () => ({ revision: 'rev-p003t047', prompts: { knowledge: '知识维护提示', triage: '常规研判提示' },
    sop: { common: '通用 SOP' }, scenarios: { cards: [{ id: 'honeypot', prompt: '蜜罐场景提示' }] } })
};

/**
 * 一套真库 + 替身模型的台子。
 * `decide`：决策模型的替身（返回 JSON 字符串），不传＝不配决策模型（走 fallback：按请求的库逐个尝试）。
 * `ruleMode` / `wikiMode`：'ok' 默认；'fail' 让那一侧的执行抛错（单腿失败补跑用）。
 */
export async function stack({ decide = null, ruleMode = 'ok', wikiMode = 'ok' } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'p003-t047-'));
  const wikiDir = path.join(base, 'wiki');
  await cp(path.join(repoRoot, 'wiki', 'honeypot'), path.join(wikiDir, 'honeypot'), { recursive: true });
  await cp(path.join(repoRoot, 'wiki', 'common'), path.join(wikiDir, 'common'), { recursive: true });
  await cp(path.join(repoRoot, 'wiki', '_evidence'), path.join(wikiDir, '_evidence'), { recursive: true });
  await cp(path.join(repoRoot, 'wiki', '_schema.md'), path.join(wikiDir, '_schema.md'));
  const rulesDir = path.join(base, 'rules');
  await cp(path.join(repoRoot, 'rules'), rulesDir, { recursive: true });
  const caseDir = await makeCase(base);

  const wiki = new WikiStore(wikiDir);
  const ruleStore = new RuleStore(rulesDir);
  // 两侧的失败开关可在用例中途改（补跑用例：先让知识库那侧挂，再修好它重跑）。
  const modes = { rule: ruleMode, wiki: wikiMode };
  let wikiCalls = 0;
  const ruleModel = { complete: async () => {
    if (modes.rule === 'fail') throw new Error('规则模型不可用（单测）');
    // 上游 401 常把请求头带进文案：用来验「写进 maintenance 之前先擦凭据」
    if (modes.rule === 'authError')
      throw new Error('模型接口 401：Authorization: Bearer sk-live-SECRET-TOKEN-123456; token=abcdef123456');
    return ruleModelProposal().complete();
  } };
  const wikiModel = { complete: async messages => {
    wikiCalls += 1;
    if (modes.wiki === 'fail') throw new Error('知识维护模型不可用（单测）');
    return wikiModelProposal().complete(messages);
  } };
  const ruleMaintainer = new RegoRuleMaintainer(ruleModel, ruleStore, { load: async () => ({ prompts: { rule: '规则维护提示' } }) });
  const wikiAgent = new WikiWorkbench(wiki, wikiModel, wikiPrompts, path.join(base, 'wiki-sessions'));
  const sessions = new FpSessionStore(path.join(base, 'fp-sessions'));

  let decisionCalls = 0;
  const decisionModel = decide ? { model: 'stub-fp', complete: async messages => { decisionCalls += 1; return { content: decide(messages) }; } } : null;
  let ruleCalls = 0;
  const originalMaintain = ruleMaintainer.maintain?.bind(ruleMaintainer);
  if (originalMaintain) ruleMaintainer.maintain = async args => { ruleCalls += 1; return originalMaintain(args); };

  const pagesBefore = new Map((await wiki.list()).map(page => [page.path, page]));
  const maintainer = new FalsePositiveMaintainer({ model: decisionModel, ruleMaintainer, ruleStore, wiki, wikiAgent, sessions });
  return {
    base, caseDir, wikiDir, rulesDir, wiki, ruleStore, ruleMaintainer, wikiAgent, sessions, maintainer, pagesBefore,
    get decisionCalls() { return decisionCalls; },
    get wikiCalls() { return wikiCalls; },
    get ruleCalls() { return ruleCalls; },
    modes, setRuleMode: value => { modes.rule = value; }, setWikiMode: value => { modes.wiki = value; },
    args: { caseId: CASE_ID, caseDir, eventType: 'honeypot', reason: REASON, who: WHO,
      alert: { msgid: 'cloudwalker-honeypot', payload: { source_ip: '203.0.113.9' } } }
  };
}

export const sessionFiles = async (sessions) => (await sessions.rows()).map(row => row.id);

export async function readSession(sessions, id) {
  return JSON.parse(await readFile(path.join(sessions.directory, `${id}.json`), 'utf8'));
}
