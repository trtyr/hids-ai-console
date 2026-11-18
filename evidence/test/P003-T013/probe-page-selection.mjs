// P003-T013 附属探针（黑盒）：wiki 维护者选页读的是哪一种「分析时引用过的页」。
// 不读实现内容；只用文档化的 createServer 注入点 + 公开类 + 真 HTTP。
//
// 跑法（仓根）：
//   timeout 120 node evidence/test/P003-T013/probe-page-selection.mjs
//
// 三种夹具（都造一页 active 的 honeypot/HP-11，本场景第一页仍是 HP-10）：
//   1) trace-only       result.json 只有 trace: [{kind:'wiki', action:'page', id:'HP-11'}]
//   2) consulted-only   result.json 只有 verdict.wiki.consulted: ['HP-11']
//   3) neither          两处都没有
// 输出：每种夹具下 wiki 维护者实际改的页（maintenance.wiki.page）。
// 结论写进 test-report.md §7.2：文档没写这一条，实测 trace 驱动、consulted 单独不驱动。
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, RegoRuleMaintainer } from '../../../server.js';
import { TriageMonitor } from '../../../triage-monitor.js';
import { RuleStore } from '../../../rule-store.js';
import { WikiStore } from '../../../wiki-store.js';
import { WikiWorkbench } from '../../../wiki-workbench.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const ID = 'syslog:honeypot:0123456789abcdef:1763373600:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
const REASON = '运维的蜜罐探针，不是攻击，来源已核对授权扫描清单';
const VARIANTS = [
  { name: 'trace-only', trace: true, consulted: false },
  { name: 'consulted-only', trace: false, consulted: true },
  { name: 'neither', trace: false, consulted: false }
];

async function run({ name, trace, consulted }) {
  const base = await mkdtemp(path.join(tmpdir(), 'p003-t013-probe-'));
  await cp(path.join(repoRoot, 'wiki'), path.join(base, 'wiki'), { recursive: true });
  await cp(path.join(repoRoot, 'rules'), path.join(base, 'rules'), { recursive: true });
  const template = await readFile(path.join(base, 'wiki', 'honeypot', 'HP-10.md'), 'utf8');
  await writeFile(path.join(base, 'wiki', 'honeypot', 'HP-11.md'),
    template.replace(/^id: .*$/m, 'id: HP-11').replace(/^title: .*$/m, 'title: 蜜罐诱捕 · 授权扫描核对'));

  const caseDir = path.join(base, 'cases', ID.replace(/[:]/g, '_'));
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '01-原始告警.txt'), 'x\n');
  await writeFile(path.join(caseDir, '03-研判事实.md'), '# 研判事实\n');
  const result = {
    alert_id: ID,
    mode: 'triage',
    verdict: {
      verdict: 'threat', verdict_label: '真实威胁',
      rego: { status: 'matched', rule_ids: ['honeypot_probe'] },
      wiki: { consulted: consulted ? ['HP-11'] : [], adopted: [], reason: '' }
    }
  };
  if (trace) result.trace = [{ kind: 'wiki', action: 'page', id: 'HP-11' }];
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify(result));

  const monitor = new TriageMonitor({
    service: {}, investigator: {}, history: {},
    file: path.join(base, 'tm.json'), inputMode: 'syslog', casesDirectory: path.join(base, 'cases')
  });
  monitor.records.set(ID, {
    alert_id: ID, status: 'done', verdict: 'threat', verdict_label: '真实威胁', decision_source: 'ai', case_dir: caseDir,
    input: { raw: 'x', parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-18T10:00:00Z', payload: { event_id: 7 } } }
  });
  await monitor.persist();

  const wiki = new WikiStore(path.join(base, 'wiki'));
  const ruleStore = new RuleStore(path.join(base, 'rules'));
  const wikiModel = {
    complete: async messages => {
      const user = JSON.parse(messages.at(-1).content);
      const updated = user.current_page.replace(/^updated: .*$/m, 'updated: 2026-11-19') +
        `\n\n## 探针维护记录\n\n${'正'.repeat(120)}\n`;
      return { content: JSON.stringify({ reply: 'ok', diagnosis: 'criterion_gap', ready: true, proposed_content: updated, rationale: 'probe' }) };
    }
  };
  const ruleModel = { complete: async () => ({ content: JSON.stringify({ ready: false, reason: '探针不测规则' }) }) };
  const wikiAgent = new WikiWorkbench(wiki, wikiModel,
    { load: async () => ({ revision: 'r1', prompts: { knowledge: 'K' }, sop: { common: '' }, scenarios: { cards: [] } }) },
    path.join(base, 'sessions'));
  const ruleMaintainer = new RegoRuleMaintainer(ruleModel, ruleStore, { load: async () => ({ prompts: { rule: 'RULE' } }) });
  const server = createServer(undefined, undefined, { model: {}, run: async () => { throw new Error('probe'); } },
    undefined, undefined, monitor, undefined, undefined, undefined, undefined, wiki, wikiAgent, undefined, undefined,
    ruleStore, ruleMaintainer);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${url}/api/agent/triage/${encodeURIComponent(ID)}/false-positive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: REASON, who: '值班分析员' })
  });
  let page = null;
  for (let i = 0; i < 300; i++) {
    const rec = monitor.records.get(ID);
    if (rec?.maintenance && rec.maintenance.status !== 'updating') { page = rec.maintenance.wiki?.page ?? null; break; }
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => server.close(r));
  await new Promise(r => setTimeout(r, 200)); // 让会话落盘收尾，避免 rm 撞上写
  await rm(base, { recursive: true, force: true }).catch(() => {});
  return { name, status: res.status, page };
}

for (const variant of VARIANTS) {
  const out = await run(variant);
  console.log(`${out.name.padEnd(15)} POST=${out.status} wiki 维护目标=${out.page}`);
}
