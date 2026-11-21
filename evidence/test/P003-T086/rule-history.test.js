// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { TriageRuleEngine } from '../../../src/contexts/knowledge/infrastructure/triage-rules.js';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const RULESET = (enabled = true) => ({ schema_version: 1, enabled, rules: [] });

test('T086 A3 JSON 规则集历史：改一版旧版进历史、可取回、回滚产生新版本', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-t086-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'triage-rules.json');
  const engine = new TriageRuleEngine(file);
  // 首版
  const first = await engine.saveConfig(RULESET(), null, { note: '首版' });
  assert.equal((await engine.history()).length, 0, '首版没有旧版可归档');
  // 第二版：旧版进历史
  const second = await engine.saveConfig(RULESET(false), first.revision, { note: '第二版' });
  const history = await engine.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].rev, first.revision);
  assert.equal(history[0].note, '第二版', '备注记替换它的那次写入的理由（与 Rego 侧同口径）');
  assert.equal(history[0].replaced_by, second.revision, 'replaced_by 指向后一版');
  // 取回历史正文
  const revision = await engine.readRevision(first.revision);
  assert.equal(revision.rev, first.revision);
  assert.deepEqual(revision.config, RULESET());
  assert.equal(await engine.readRevision('0'.repeat(16)), null);
  // 回滚：把旧版当新版写一次 → 产生新 revision，旧当前版也进历史
  const rolled = await engine.rollback(first.revision, { expectedRevision: second.revision });
  assert.equal(rolled.action, 'rollback');
  assert.equal(rolled.rolled_back_to, first.revision);
  // revision 是内容指纹：回滚到首版内容 → 与首版同 rev（内容寻址，不是自增版本号）
  assert.equal(rolled.revision, first.revision);
  assert.notEqual(rolled.revision, second.revision);
  const after = await engine.history();
  assert.equal(after.length, 2, '回滚后历史有两版（首版 + 被回滚掉的第二版）');
});

test('T086 A4 规则命中统计：按 rule_id 汇总次数与告警列表', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-t086-hits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const monitor = new TriageMonitor({ file: path.join(dir, 'q.json'), service: {}, investigator: {}, history: {}, concurrency: 0 });
  const mk = (id, ruleId, at) => monitor.records.set(id, { alert_id: id, status: 'done', rule_id: ruleId,
    verdict: 'uncertain', created_at: at, updated_at: at, evidence: [] });
  mk('honeypot:1', 'honeypot_probe', '2026-11-21T01:00:00Z');
  mk('honeypot:2', 'honeypot_probe', '2026-11-21T02:00:00Z');
  mk('webshell:1', 'webshell_drop', '2026-11-21T03:00:00Z');
  mk('webshell:2', null, '2026-11-21T04:00:00Z');
  const server = createServer(null, null, null, null, null, monitor);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/rules/hits`)).json();
  assert.equal(body.total_rules, 2, '没有 rule_id 的记录不计');
  assert.equal(body.rules[0].rule_id, 'honeypot_probe');
  assert.equal(body.rules[0].hits, 2);
  assert.deepEqual(body.rules[0].alerts.sort(), ['honeypot:1', 'honeypot:2']);
  assert.equal(body.rules[0].first_at, '2026-11-21T01:00:00Z');
  assert.equal(body.rules[0].last_at, '2026-11-21T02:00:00Z');
  assert.equal(body.rules[1].rule_id, 'webshell_drop');
  assert.equal(body.rules[1].hits, 1);
});

test('T086 路由：历史列表 / 取某版 / 回滚需要管理员令牌', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-t086-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const engine = new TriageRuleEngine(path.join(dir, 'triage-rules.json'));
  const first = await engine.saveConfig(RULESET(), null, { note: 'a' });
  await engine.saveConfig(RULESET(), first.revision, { note: 'b' });
  const server = createServer(null, null, null, null, null, null, null, null, null, null,
    null, null, null, 'test-rule-token', null, null, null, null, null, null, null, null, engine);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/api/triage/rules/history`)).json();
  assert.equal(list.history.length, 1);
  const one = await (await fetch(`${base}/api/triage/rules/history/${first.revision}`)).json();
  assert.equal(one.rev, first.revision);
  assert.equal((await fetch(`${base}/api/triage/rules/history/${'0'.repeat(16)}`)).status, 404);
  // 回滚：无令牌 403
  assert.equal((await fetch(`${base}/api/triage/rules/rollback`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: first.revision }) })).status, 403);
  // 带令牌成功
  const ok = await fetch(`${base}/api/triage/rules/rollback`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rule-admin-token': 'test-rule-token' },
    body: JSON.stringify({ rev: first.revision }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).action, 'rollback');
});
