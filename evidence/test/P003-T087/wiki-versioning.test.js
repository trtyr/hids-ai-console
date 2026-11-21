// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../server.js';
import { WikiStore } from '../../../src/contexts/knowledge/infrastructure/wiki-store.js';
import { InvestigationStore } from '../../../src/contexts/triage/infrastructure/investigation-store.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function seeded(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hids-t087-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wikiDir = path.join(dir, 'wiki');
  await cp(path.join(ROOT, 'wiki'), wikiDir, { recursive: true });
  const wiki = new WikiStore(wikiDir, { historyDirectory: path.join(dir, 'wiki-history'), seedFrom: null });
  return { dir, wiki };
}

test('T087 A1 判据页版本：改一版旧版进历史、可取回、回滚回到旧版内容', async t => {
  const { wiki } = await seeded(t);
  const page = 'honeypot/HP-01.md';
  const before = await wiki.get(page);
  const next = before.content.replace('蜜罐', '蜜罐（改过）');
  const saved = await wiki.update(page, next, before.revision, '测试改写');
  assert.notEqual(saved.revision, before.revision);
  const history = await wiki.history(page);
  assert.ok(history.some(item => item.rev === before.revision), `历史里应有旧版：${JSON.stringify(history.slice(0, 3))}`);
  const revision = await wiki.readRevision(before.id, before.revision);
  assert.equal(revision.content, before.content, '取回的历史正文与旧版逐字相同');
  assert.equal(await wiki.readRevision(before.id, '0'.repeat(16)), null);
  // 回滚
  const rolled = await wiki.rollbackTo(page, before.revision, { note: '测试回滚' });
  assert.equal(rolled.revision, before.revision, '回滚到旧版内容 → revision 回到旧值（内容寻址）');
  assert.equal((await wiki.get(page)).content, before.content);
  // 回滚本身也进历史（被回滚掉的那版）
  const after = await wiki.history(page);
  assert.ok(after.some(item => item.rev === saved.revision), '回滚前的那版必须进历史');
});

test('T087 A2 引用图：正反向边都在，evidence 与 refs 分开', async t => {
  const { wiki } = await seeded(t);
  const graph = await wiki.referenceGraph();
  assert.ok(graph.nodes.length > 10, `节点数应覆盖判据库：${graph.nodes.length}`);
  assert.ok(graph.edges.length > 0, '至少有一条引用边');
  const refs = graph.edges.filter(edge => edge.kind === 'refs');
  const evidence = graph.edges.filter(edge => edge.kind === 'evidence');
  assert.ok(refs.length > 0, '有 refs 边');
  assert.ok(evidence.length > 0, '有 evidence 边');
  // 反向索引：某条边的 to 能在 inbound 里找到 from
  const sample = refs[0];
  assert.ok((graph.inbound[sample.to] || []).includes(sample.from), 'inbound 要能反查');
});

test('T087 A4 研判闭环：判据页反查用过它的研判与结论分布', async t => {
  const { dir, wiki } = await seeded(t);
  const history = new InvestigationStore(path.join(dir, 'investigations'));
  await history.save({ alert_id: 'honeypot:1', mode: 'triage', verdict: { verdict: 'uncertain' },
    trace: [{ kind: 'wiki', action: 'page', id: 'HP-01' }], validation: { ok: true } });
  await history.save({ alert_id: 'honeypot:2', mode: 'triage', verdict: { verdict: 'false_positive' },
    verdict_wiki: null, trace: [], validation: { ok: true } });
  const server = createServer(null, null, null, history, null, null, null, null, null, null,
    wiki, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = await (await fetch(`${base}/api/wiki/usage?id=HP-01`)).json();
  assert.equal(body.id, 'HP-01');
  assert.equal(body.total, 1, '只有 trace 里引用了 HP-01 的那条算');
  assert.equal(body.investigations[0].alert_id, 'honeypot:1');
  assert.equal(body.verdicts.uncertain, 1);
  assert.equal((await fetch(`${base}/api/wiki/usage`)).status, 400);
});
