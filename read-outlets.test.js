// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { InvestigationStore } from './investigation-store.js';
import { eventTypes, levelNames } from './src/shared/vocabulary.js';
import { VERDICT_KEYS, VERDICT_LABELS, TRIAGE_STATUSES } from './src/contexts/triage/domain/triage-case.js';
import { CASE_FILE_WHITELIST, CASE_FILE_CONTENT_TYPES } from './src/contexts/triage/application/correlate.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// ── A01：研判记录列表 ────────────────────────────────────────────────────────
test('GET /api/agent/investigations：分页 / 结论 / 时间筛选，items 字段齐全，非法参数 400', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t059-inv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = new InvestigationStore(directory);
  await history.save({ alert_id: 'honeypot:1', mode: 'deep', model: 'fake',
    verdict: { verdict: 'threat', verdict_label: '真实威胁', confidence: '高' },
    validation: { ok: true }, saved_at: undefined });
  await new Promise(resolve => setTimeout(resolve, 5));
  await history.save({ alert_id: 'honeypot:2', mode: 'triage', model: 'fake',
    verdict: { verdict: 'false_positive', verdict_label: '误报', confidence: '中' }, validation: { ok: true } });
  await new Promise(resolve => setTimeout(resolve, 5));
  await history.save({ alert_id: 'honeypot:3', mode: 'deep', model: 'fake',
    verdict: { verdict: 'uncertain', verdict_label: '存疑', confidence: '低' },
    validation: { ok: false, errors: ['降级结论没有可核验的 claims'], degraded: true } });

  const base = await listen(t, createServer(null, null, null, history, null,
    { status: () => null, cases: () => ({ total: 0 }), records: new Map() }));
  const get = async query => {
    const response = await fetch(`${base}/api/agent/investigations${query}`);
    return { status: response.status, body: await response.json() };
  };

  const all = await get('?count=50');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 3, '分母 = investigations/*.json 实际文件数');
  assert.ok(typeof all.body.cases_total === 'number', 'cases_total 并列给出（口径对照）');
  assert.equal(all.body.items.length, 3);
  for (const item of all.body.items) {
    for (const key of ['alert_id', 'mode', 'verdict', 'verdict_label', 'confidence', 'saved_at', 'degraded', 'model'])
      assert.ok(key in item, `items 至少含 ${key}`);
  }
  // 倒序：最后保存的在前
  assert.deepEqual(all.body.items.map(item => item.alert_id), ['honeypot:3', 'honeypot:2', 'honeypot:1']);
  // degraded 标记来自 validation.degraded
  const degraded = all.body.items.find(item => item.alert_id === 'honeypot:3');
  assert.equal(degraded.degraded, true);
  assert.equal(all.body.items.find(item => item.alert_id === 'honeypot:1').degraded, false);

  // 结论筛选（review 匹配无结论记录——本批都有结论，回 0）
  assert.deepEqual((await get('?verdict=threat')).body.items.map(item => item.alert_id), ['honeypot:1']);
  assert.equal((await get('?verdict=false_positive,uncertain')).body.total, 2);
  assert.equal((await get('?verdict=review')).body.total, 0);
  assert.equal((await get('?verdict=bogus')).status, 400);
  assert.equal((await get('?verdict=bogus')).body.code, 'caller_error');
  // 时间筛选（saved_at 闭区间）：取第一条的 saved_at 做单点
  const newest = all.body.items[0];
  assert.deepEqual((await get(`?from=${encodeURIComponent(newest.saved_at)}&to=${encodeURIComponent(newest.saved_at)}`))
    .body.items.map(item => item.alert_id), ['honeypot:3']);
  assert.equal((await get('?from=yesterday')).status, 400);
  // 分页
  const page = await get('?count=2&offset=1');
  assert.equal(page.body.total, 3);
  assert.deepEqual(page.body.items.map(item => item.alert_id), ['honeypot:2', 'honeypot:1']);
  for (const query of ['?count=0', '?count=51', '?offset=-1']) assert.equal((await get(query)).status, 400);
});

// ── A02：案卷材料读取 ────────────────────────────────────────────────────────
test('case-files：白名单清单、按键取正文带 content-type、404 与三种穿越变体 400', async t => {
  const caseDir = await mkdtemp(path.join(tmpdir(), 'hids-t059-case-'));
  t.after(() => rm(caseDir, { recursive: true, force: true }));
  await writeFile(path.join(caseDir, '00-这是什么.md'), '# 蜜罐告警的研判材料\n');
  await writeFile(path.join(caseDir, '01-原始告警.txt'), '<134>1 2026-11-21T00:00:00Z host cloudwalker-honeypot - - - event_id=1');
  await writeFile(path.join(caseDir, 'result.json'), JSON.stringify({ verdict: { verdict: 'uncertain' } }));
  await writeFile(path.join(caseDir, '06-必查项.json'), JSON.stringify({ checks: [] }));
  await writeFile(path.join(caseDir, '07-不在白名单.txt'), '不该被列出');

  const monitor = {
    status: id => id === 'honeypot:7' ? { alert_id: id, status: 'done', case_dir: caseDir, evidence: [] } : null,
    cases: () => ({ total: 1 }),
    records: new Map()
  };
  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const get = async p => fetch(`${base}${p}`);

  // 清单：只列白名单且真实存在的（00/01/result/06 四份；07-不在白名单 不列）
  const list = await (await get('/api/agent/triage/honeypot:7/case-files')).json();
  assert.equal(list.alert_id, 'honeypot:7');
  assert.ok(list.case_dir.endsWith('hids-t059-case-') || list.case_dir.startsWith('/tmp'), 'case_dir 指向数据根内目录');
  const names = list.files.map(file => file.name);
  assert.ok(names.includes('00-这是什么.md'));
  assert.ok(names.includes('01-原始告警.txt'));
  assert.ok(names.includes('result.json'));
  assert.ok(names.includes('06-必查项.json'));
  assert.equal(names.includes('07-不在白名单.txt'), false, '目录里非白名单文件不列');
  for (const file of list.files) {
    assert.equal(typeof file.bytes, 'number');
    assert.match(file.mtime, /^\d{4}-\d{2}-\d{2}T/);
  }
  // 白名单齐全性：9 个文件名都在 CASE_FILE_WHITELIST（列出的只是盘上存在的子集）
  assert.equal(CASE_FILE_WHITELIST.length, 9);

  // 按键取正文 + content-type
  const md = await get('/api/agent/triage/honeypot:7/case-files/00-这是什么.md');
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), CASE_FILE_CONTENT_TYPES['.md']);
  assert.match(await md.text(), /研判材料/);
  const jsonFile = await get('/api/agent/triage/honeypot:7/case-files/result.json');
  assert.equal(jsonFile.headers.get('content-type'), CASE_FILE_CONTENT_TYPES['.json']);
  assert.deepEqual(await jsonFile.json(), { verdict: { verdict: 'uncertain' } });
  const txt = await get('/api/agent/triage/honeypot:7/case-files/01-原始告警.txt');
  assert.equal(txt.headers.get('content-type'), CASE_FILE_CONTENT_TYPES['.txt']);

  // 白名单里但案卷没有的那份 → 404
  assert.equal((await get('/api/agent/triage/honeypot:7/case-files/05-研判结果.md')).status, 404);
  // 没有案卷目录的告警 → 404
  assert.equal((await get('/api/agent/triage/honeypot:8/case-files')).status, 404);
  assert.equal((await get('/api/agent/triage/honeypot:8/case-files/result.json')).status, 404);
  // 路径穿越三种变体：../、绝对路径、URL 编码（%2e%2e）——全都不可能命中白名单 → 400
  const traversal = [
    '/api/agent/triage/honeypot:7/case-files/..%2F..%2Fetc%2Fpasswd',
    '/api/agent/triage/honeypot:7/case-files/%2e%2e%2f%2e%2e%2fconfig-overrides.json',
    '/api/agent/triage/honeypot:7/case-files/..\\..\\secret.txt'
  ];
  for (const p of traversal) {
    const response = await get(p);
    assert.equal(response.status, 400, `${p} 应回 400`);
    assert.equal((await response.json()).code, 'caller_error');
  }
  // 告警 ID 无效
  assert.equal((await get('/api/agent/triage/not-an-id/case-files')).status, 400);
});

// ── A09：字典接口与真源一致性 ────────────────────────────────────────────────
test('GET /api/dict：四张表与代码唯一真源逐项一致（不出第二份对照表）', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, null));
  const response = await fetch(`${base}/api/dict`);
  assert.equal(response.status, 200);
  const dict = await response.json();
  // 事件类型：与 vocabulary 的 eventTypes 逐项一致
  assert.equal(dict.event_types.length, Object.keys(eventTypes).length);
  for (const [key, label] of Object.entries(eventTypes)) {
    const row = dict.event_types.find(item => item.key === key);
    assert.ok(row, `字典缺事件类型 ${key}`);
    assert.equal(row.label, label);
  }
  // 等级：与 levelNames 一致（秩 + 中文 + 机器键）
  assert.equal(dict.levels.length, 4);
  for (const [rank, [label, key]] of Object.entries(levelNames)) {
    const row = dict.levels.find(item => item.key === key);
    assert.equal(row.rank, Number(rank));
    assert.equal(row.label, label);
  }
  // 结论：三态（与 triage 领域词表一致；「待研判」不在字典里——那是前端的 review 投影）
  assert.deepEqual(dict.verdicts.map(item => item.key), VERDICT_KEYS);
  assert.deepEqual(dict.verdicts.map(item => item.label), Object.values(VERDICT_LABELS));
  // 状态：五值
  assert.deepEqual(dict.triage_statuses, TRIAGE_STATUSES);
});
