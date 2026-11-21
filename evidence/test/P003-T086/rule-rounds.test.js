// P003-T086 A2：规则维护多轮修订——每轮把校验失败原因回灌，收敛即落盘，N 轮不通过才放弃。
// 轮次与每轮失败原因落会话（列表给轮数，详情给 rounds[] 原文）。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RegoRuleMaintainer } from '../../../src/contexts/knowledge/application/rule-maintainer.js';
import { RuleSessionStore, RuleStore } from '../../../src/contexts/knowledge/infrastructure/rule-store.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const ORIGINAL = `package hids.rules.honeypot_probe

# name: 蜜罐探针

default match := false

match if {
  input.type == "honeypot"
  input.source_ip != ""
}
`;
// 子集外语法：解析器会在装载期报错（不出这个目录）。
const BAD = `package hids.rules.honeypot_probe

# name: 蜜罐探针

default match := false

match if {
  some x in input
}
`;
// 通过校验且不放宽原条件的修订：保留原两条，再加一条限定。
const GOOD = `package hids.rules.honeypot_probe

# name: 蜜罐探针

default match := false

match if {
  input.type == "honeypot"
  input.source_ip != ""
  startswith(input.source_ip, "203.")
}
`;

const material = { caseId: 'c-1', eventType: 'honeypot', reason: '运维探针', who: '值班分析员',
  alert: { msgid: 'cloudwalker-honeypot', payload: { source_ip: '203.0.113.7' } }, ruleIds: ['honeypot_probe'] };

async function harness(t, { maxRounds } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hids-t086-rounds-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const rules = path.join(root, 'rules');
  await mkdir(rules, { recursive: true });
  await writeFile(path.join(rules, 'honeypot_probe.rego'), ORIGINAL);
  const sessions = new RuleSessionStore(path.join(root, 'sessions'));
  const calls = [];
  const queue = [];
  const model = { model: 'fake', complete: async messages => {
    calls.push(JSON.parse(JSON.stringify(messages)));
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { content: JSON.stringify(next) };
  } };
  const prompts = { load: async () => ({ prompts: { rule: '维护 Rego 规则' } }) };
  const maintainer = new RegoRuleMaintainer(model, new RuleStore(rules), prompts, sessions,
    maxRounds ? { maxRounds } : {});
  return { root, rules, sessions, queue, calls, maintainer,
    proposed: (rego, reason = '收紧来源') => ({ ready: true, id: 'honeypot_probe', name: '蜜罐探针', reason, rego }) };
}

test('A2 多轮收敛：第一轮校验不过→回灌原因→第二轮通过并落盘，轮次进会话', async t => {
  const env = await harness(t);
  env.queue.push(env.proposed(BAD), env.proposed(GOOD));
  const result = await env.maintainer.maintain(material);
  assert.equal(result.action, 'update');
  assert.equal(env.calls.length, 2, '两轮收敛');
  assert.equal(await readFile(path.join(env.rules, 'honeypot_probe.rego'), 'utf8'), GOOD);
  // 第二轮给模型的反馈里必须带上一轮的校验原因（不是重新发一遍原题）
  const feedback = env.calls[1].at(-1).content;
  assert.match(feedback, /上一轮未通过校验/);
  assert.match(feedback, /\.rego:\d+/, '反馈要带解析器给的文件:行号');

  const listed = await env.sessions.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'updated');
  assert.equal(listed[0].rounds, 2);
  assert.equal(listed[0].max_rounds, 3, '缺省上限 3');
  const detail = await env.sessions.get(listed[0].id);
  assert.deepEqual(detail.rounds.map(row => row.ok), [false, true]);
  assert.match(detail.rounds[0].error, /\.rego:\d+/, '失败原因原文要落会话');
  assert.equal(detail.rounds[1].error, null);
  assert.equal(detail.validation.rev.length, 16);
});

test('A2 放弃分支：N 轮都不通过就失败，文件不动，每轮原因都留档', async t => {
  const env = await harness(t, { maxRounds: 2 });
  env.queue.push(env.proposed(BAD));
  await assert.rejects(() => env.maintainer.maintain(material), /\.rego:\d+/);
  assert.equal(env.calls.length, 2, '上限 2 轮，只调两次模型');
  assert.equal(await readFile(path.join(env.rules, 'honeypot_probe.rego'), 'utf8'), ORIGINAL, '失败不许改原文件');
  const [summary] = await env.sessions.list();
  assert.equal(summary.status, 'failed');
  assert.equal(summary.rounds, 2);
  const detail = await env.sessions.get(summary.id);
  assert.equal(detail.rounds.length, 2);
  assert.ok(detail.rounds.every(row => row.ok === false && /\.rego:\d+/.test(row.error)));
  assert.match(detail.error, /\.rego:\d+/);
});

test('A2 模型说无法修订（ready=false）也按一轮失败处理并重试；放宽原条件被拒同样回灌', async t => {
  const env = await harness(t, { maxRounds: 3 });
  // 第一轮：明确说无法修订；第二轮：放宽 startswith(/tmp/)→/tmp 的等价问题这里用「删掉 source_ip 条件」表达
  const widened = GOOD.replace('  input.source_ip != ""\n', '');
  env.queue.push({ ready: false, reason: '缺授权记录，找当班主管确认' }, env.proposed(widened), env.proposed(GOOD));
  await env.maintainer.maintain(material);
  assert.equal(env.calls.length, 3);
  const detail = await env.sessions.get((await env.sessions.list())[0].id);
  assert.equal(detail.rounds.length, 3);
  assert.match(detail.rounds[0].error, /缺授权记录/);
  assert.match(detail.rounds[1].error, /放宽了原有限制条件/);
  assert.equal(detail.rounds[2].ok, true);
});

test('A2 轮次上限可配：HIDS_RULE_MAINTAIN_MAX_ROUNDS 生效，构造参数优先', async t => {
  const before = process.env.HIDS_RULE_MAINTAIN_MAX_ROUNDS;
  process.env.HIDS_RULE_MAINTAIN_MAX_ROUNDS = '4';
  try {
    const env = await harness(t);
    assert.equal(env.maintainer.maxRounds, 4);
    const strict = new RegoRuleMaintainer({}, {}, { load: async () => ({}) }, null, { maxRounds: 2 });
    assert.equal(strict.maxRounds, 2, '构造参数优先于环境变量');
  } finally {
    if (before === undefined) delete process.env.HIDS_RULE_MAINTAIN_MAX_ROUNDS;
    else process.env.HIDS_RULE_MAINTAIN_MAX_ROUNDS = before;
  }
});
