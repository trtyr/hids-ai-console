// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot, isolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { PromptStore } from '../../../src/contexts/knowledge/infrastructure/prompt-store.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const TOKEN = 'test-prompt-token';

async function serve(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-t082-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts = new PromptStore(path.join(dir, 'prompt-overrides.json'));
  const server = createServer(null, null, null, null, prompts, null, null, null, null, TOKEN);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, prompts };
}

test('T082 B06 提示词元数据带正文与 overridden 标记', async t => {
  const { base } = await serve(t);
  const body = await (await fetch(`${base}/api/agent/prompts`)).json();
  assert.ok(body.sections.length >= 20);
  const triage = body.sections.find(section => section.id === 'triage');
  assert.ok(triage.content.includes('研判'), '正文要真的在');
  assert.equal(triage.overridden, false);
  assert.ok(body.sections.filter(section => section.kind === 'scenario').every(section => section.content.length > 0));
});

test('T084 提示词正文可写：PUT 带 expected_revision，旧版不覆盖、版本刷新、overridden 变真', async t => {
  const { base } = await serve(t);
  const before = await (await fetch(`${base}/api/agent/prompts`)).json();
  const section = before.sections.find(item => item.id === 'deep');
  const next = `${section.content}\n\n# 测试追加段\n这一段用于验证可写。`;
  // 无令牌 → 403；错令牌 → 403
  assert.equal((await fetch(`${base}/api/agent/prompts/deep`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: next, expected_revision: before.revision }) })).status, 403);
  // 令牌对但版本过期 → 409
  assert.equal((await fetch(`${base}/api/agent/prompts/deep`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-prompt-admin-token': TOKEN },
    body: JSON.stringify({ content: next, expected_revision: '0'.repeat(16) }) })).status, 409);
  // 正确写入
  const ok = await fetch(`${base}/api/agent/prompts/deep`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-prompt-admin-token': TOKEN },
    body: JSON.stringify({ content: next, expected_revision: before.revision }) });
  assert.equal(ok.status, 200);
  const after = await (await fetch(`${base}/api/agent/prompts`)).json();
  assert.notEqual(after.revision, before.revision, '版本要刷新');
  const saved = after.sections.find(item => item.id === 'deep');
  assert.ok(saved.content.includes('测试追加段'));
  assert.equal(saved.overridden, true, '覆盖过的段要标 overridden');
  // SOP 只读段不接受写（403）；未知段键 404
  const sop = after.sections.find(item => item.kind === 'sop');
  assert.equal((await fetch(`${base}/api/agent/prompts/${encodeURIComponent(sop.id)}`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-prompt-admin-token': TOKEN },
    body: JSON.stringify({ content: '改 SOP', expected_revision: after.revision }) })).status, 403,
  'SOP 段只读，写入要 403');
  assert.equal((await fetch(`${base}/api/agent/prompts/no-such-section`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-prompt-admin-token': TOKEN },
    body: JSON.stringify({ content: 'x', expected_revision: after.revision }) })).status, 404);
  // 写成功要记审计 prompt.write（append-only，异步落盘：等一拍）
  await new Promise(resolve => setTimeout(resolve, 150));
  const auditDir = path.join(isolatedRoot, 'audit');
  const files = (await readdir(auditDir)).filter(name => name.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map(name => readFile(path.join(auditDir, name), 'utf8'))))
    .join('').trim().split('\n').map(line => JSON.parse(line));
  const written = lines.filter(line => line.action === 'prompt.write');
  assert.equal(written.length, 1, '写提示词要留一条 prompt.write 审计');
  assert.deepEqual(written[0].object, { kind: 'prompt_section', section: 'deep', characters: next.length });
  assert.deepEqual(written[0].actor, { kind: 'token', id: 'prompt-admin' });
});
