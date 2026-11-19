// A5 断言的可失败性自证：拿真跑出来的日志做变异，检查器必须恰红。
// 用途只有一个——证明 checkModelCallEvents 不是永真式（变异只在内存里做，不碰任何实现文件）。
// 跑法：node probe-a5-mutant.mjs [日志路径] [数据根]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { checkModelCallEvents } from './model-call-events-check.mjs';

const logPath = process.argv[2] || '/tmp/p003-t047-acceptance/server.log';
const dataDir = process.argv[3] || '/tmp/p003-t047-acceptance/data';

const events = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((e) => e.event === 'ai.model_call' && e.domain === 'false_positive');

// 替身真值：从原始日志的 request 条数反推（变异前先记下，变异只动副本）
const expect = { decision: 0, rule: 0, wiki: 0 };
for (const e of events) {
  if (e.direction !== 'request') continue;
  const k = e.role === 'fp_maintainer' ? 'decision' : e.role === 'rule_maintainer' ? 'rule' : 'wiki';
  expect[k] += 1;
}

const wikiSessionOf = {};
const dir = `${dataDir}/fp-sessions`;
if (existsSync(dir)) {
  for (const f of readdirSync(dir)) {
    try {
      const s = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      if (s.outcomes?.wiki?.session_id) wikiSessionOf[s.id] = s.outcomes.wiki.session_id;
    } catch { /* 半份会话不参与 */ }
  }
}

let failed = 0;
const run = (label, list, wantRed) => {
  let message = null;
  try { checkModelCallEvents(list, { expect, wikiSessionOf }); } catch (err) { message = err.message; }
  const red = message !== null;
  if (red === wantRed) {
    console.log(`${label}：${red ? '恰红' : '绿'}\n${red ? message.split('\n').slice(0, 6).join('\n') : ''}`);
  } else {
    failed += 1;
    console.log(`${label}：不该${wantRed ? '绿' : '红'}（checker 没抓住变异）`);
  }
};

run(`控制组（原始日志 ${events.length} 条，替身计数 ${JSON.stringify(expect)}）`, events, false);

// 变异 1：审计用过的那个——把每个 role 的第 2、4 次调用整对抹掉（漏记），成对关系不变
const dropped = new Set();
const seenCount = { fp_maintainer: 0, rule_maintainer: 0, wiki_maintainer: 0 };
const mutantDrop = events.filter((e) => {
  if (e.direction !== 'request') return true;
  seenCount[e.role] += 1;
  const drop = seenCount[e.role] === 2 || seenCount[e.role] === 4;
  if (drop) dropped.add(`${e.role}|${e.session_id}|${e.turn}`);
  return !drop;
}).filter((e) => e.direction !== 'response' || !dropped.has(`${e.role}|${e.session_id}|${e.turn}`));
run(`变异 1（每个 role 的第 2/4 次调用整对不落事件，删 ${events.length - mutantDrop.length} 条）`, mutantDrop, true);

// 变异 2：同一轮的规则维护调用挪到决策轮之前（顺序断言必须红）
const mutantOrder = events.slice();
const fpReq = mutantOrder.find((e) => e.direction === 'request' && e.role === 'fp_maintainer'
  && mutantOrder.some((x) => x.direction === 'request' && x.role === 'rule_maintainer' && x.session_id === e.session_id));
const ruleReq = mutantOrder.find((e) => e.direction === 'request' && e.role === 'rule_maintainer' && e.session_id === fpReq.session_id);
mutantOrder.splice(mutantOrder.indexOf(ruleReq), 1);
mutantOrder.splice(mutantOrder.indexOf(fpReq), 0, ruleReq);
run('变异 2（规则维护调用挪到同一轮决策之前）', mutantOrder, true);

process.exit(failed ? 1 : 0);
