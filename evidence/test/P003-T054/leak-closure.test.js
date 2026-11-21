// P003-T054 A1/A2/A3：记录侧闸在最后三处出口上的行为用例。
// 口径来源：docs/modules/triage-pipeline.md:497-520（记录侧不写错误原文、模型那份仍原文）、
// docs/modules/investigation-agent.md:300-312、docs/modules/triage-rules.md:398-403。
// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——createServer 的缺省件指着真全局根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../../../server.js';
import { InvestigationAgent } from '../../../src/contexts/triage/application/investigation-agent.js';
import { AgentToolbox } from '../../../src/contexts/triage/infrastructure/evidence-toolbox.js';
import { InvestigationStore } from '../../../src/contexts/triage/infrastructure/investigation-store.js';
import { PromptStore } from '../../../src/contexts/knowledge/infrastructure/prompt-store.js';
import { TriageRuleEngine } from '../../../src/contexts/knowledge/infrastructure/triage-rules.js';
import { UpdateStore, openPackage, sealPackage } from '../../../src/contexts/dataops/infrastructure/update-store.js';

const MARKER = 'SECRET_BODY_MARKER';
const GATED = /^(上游调用失败|调用超时|模型回包不是合法 JSON)，原文 \d+ 字未落盘$/;

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function tempDir(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-t054-leak-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// ---------------------------------------------------------------- A1 HTTP 深度研判路径

// 一份能过 InvestigationStore.save 的最小结果（真实字段形状见 docs §4）。
const fakeResult = alertId => ({ alert_id: alertId, mode: 'triage',
  verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: '待核查', claims: [], missing_evidence: [] },
  validation: { ok: true }, trace: [] });

async function runTriage(t, evaluate) {
  const directory = await tempDir(t);
  const history = new InvestigationStore(path.join(directory, 'investigations'));
  const calls = [];
  const investigator = { model: { model: 'fake-model' },
    prompts: async () => ({ triage: 'T', deep: 'D', knowledge: 'K', scenarios: { cards: [] } }),
    run: async (alertId, options) => { calls.push({ alertId, options });
      return fakeResult(alertId); } };
  const monitor = { ruleEngine: { evaluate } };
  const server = createServer(null, null, investigator, history,
    new PromptStore(path.join(directory, 'prompt-overrides.json')), monitor, null, {}, null, null);
  const base = await listen(t, server);
  const response = await fetch(`${base}/api/agent/investigations`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alert_id: 'suspicious_operation:7', mode: 'triage' }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const files = await readdir(path.join(directory, 'investigations'));
  assert.equal(files.length, 1, '研判记录应落一份');
  const onDisk = await readFile(path.join(directory, 'investigations', files[0]), 'utf8');
  return { body: JSON.parse(text), onDisk, files, calls };
}

test('A1 规则评估抛错：catch 拼的原文进不了研判记录，回灌模型的那份仍是原文', async t => {
  const raw = `${MARKER} cause.message 全文`;
  const { body, onDisk, calls } = await runTriage(t, async () => { throw new Error(raw); });

  // 回灌模型的那份（options.ruleEvaluation）保留原文——模型靠它认出配置 / 网络错在哪。
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.ruleEvaluation.reason, `规则评估失败：${raw}`);
  assert.equal(calls[0].options.ruleEvaluation.status, 'error');

  // 落盘副本过闸：固定文案 + 字符量，字符量算的是闸前文本（含「规则评估失败：」前缀）。
  const expected = `上游调用失败，原文 ${`规则评估失败：${raw}`.length} 字未落盘`;
  assert.equal(body.rule_evaluation.reason, expected);
  assert.equal(JSON.parse(onDisk).rule_evaluation.reason, expected);
  for (const text of [JSON.stringify(body), onDisk])
    assert.equal(text.includes(MARKER), false, '研判记录 / 响应正文里不该出现规则错误原文');
});

test('A1 ruleEngine 回 status=error：decision.reason 同样过闸，模型那份不改', async t => {
  const raw = `${MARKER} 配置里的一段原文`;
  const reason = `规则集校验失败：${raw}`;
  const { body, onDisk, calls } = await runTriage(t, async () => ({ status: 'error', reason }));

  assert.equal(calls[0].options.ruleEvaluation.reason, reason, '模型那份仍是原文');
  const expected = `上游调用失败，原文 ${reason.length} 字未落盘`;
  assert.equal(body.rule_evaluation.reason, expected);
  assert.equal(JSON.parse(onDisk).rule_evaluation.reason, expected);
  assert.equal(body.rule_evaluation.status, 'error', 'status 字段照旧带出去');
  for (const text of [JSON.stringify(body), onDisk]) assert.equal(text.includes(MARKER), false);
});

// ---------------------------------------------------------------- A2 未匹配 syslog 旁路

test('A2 未匹配 syslog：`牧云事件…失败：` 徽标不再保留，一律归一', async t => {
  const directory = await tempDir(t);
  await writeFile(path.join(directory, '03-研判事实.md'), '# 研判事实\n来源 192.0.2.2\n');
  const upstream = `${MARKER} 上游 503`;
  const toolbox = new AgentToolbox({ listTools: async () => [],
    callTool: async () => ({ id: 7 }) });
  const model = { model: 'fake', complete: async () => { throw new Error(`${MARKER} 说明调用炸了`); } };
  const agent = new InvestigationAgent(toolbox, model,
    { load: async () => ({ prompts: { triage: 'T' }, sop: {}, version: 'v1', revision: 'r1' }) },
    { agentIndex: async () => ({ category: 'honeypot', pages: [] }), agentContextPages: async () => [] },
    { evaluate: async () => ({ matched: [] }) });
  const reason = `牧云事件查询失败：${upstream}`;
  const result = await agent.runUnmatchedSyslog({ raw: 'raw', context: {}, parsed: {
    msgid: 'cloudwalker-honeypot', payload: { host_ip: '10.0.0.5' } } },
  { type: 'honeypot', matched: false, reason },
  { case_dir: directory, files: ['03-研判事实.md'] });

  const expected = `上游调用失败，原文 ${reason.length} 字未落盘`;
  for (const value of [result.verdict.missing_evidence[0], result.review.missing_evidence[0],
    result.trace.find(item => item.kind === 'tool_error').error]) {
    assert.match(value, GATED);
    assert.equal(value, expected);
    assert.equal(value.includes('牧云事件查询失败'), false, '徽标白名单已删，不许再保留前缀');
  }
  assert.equal(JSON.stringify(result).includes(MARKER), false);
});

// ---------------------------------------------------------------- A3 update-store.js

// 造一份能过 read() 的已落盘升级包（信封 + SHA-256 id，与 update-store.js:112-125 同形）。
async function stagedPackage(directory, payload) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const encryptionKey = randomBytes(32);
  const buffer = sealPackage(payload, { encryptionKey, privateKey });
  const id = createHash('sha256').update(buffer).digest('hex');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, filename: 'update.hids-policy',
    uploaded_at: '2026-11-20T00:00:00.000Z', envelope: buffer.toString('base64') }));
  assert.equal(openPackage(buffer, { encryptionKey, publicKey }).type, 'hids-prompts');
  return { id, options: { directory, encryptionKey, publicKey, target: 'test-customer' } };
}

function payloadFor(snapshot, extra = {}) {
  return { type: 'hids-prompts', api_version: 1, target: 'test-customer', version: '26.11.007', sequence: 1,
    date: '2026-11-20', title: '策略更新', summary: '更新研判策略的公开说明',
    changes: { features: [], improvements: [], fixes: [] }, ...snapshot, ...extra };
}

test('A3 update-store:兼容性检查的上游报错原文不进 compatibility_reason，本地提示照留', async t => {
  const directory = await tempDir(t);
  const { id, options } = await stagedPackage(directory, payloadFor({ sections: {}, knowledge_revision: 'r1' }));
  const raw = `${MARKER} /srv/secret/prompts.json 读失败`;
  const prompts = { filename: path.join(directory, 'prompts.json'),
    readOverrides: async () => ({ _history: [] }),
    snapshot: async () => { throw new Error(raw); } };

  const detail = await new UpdateStore(prompts, options).detail(id);
  assert.equal(detail.compatible, false);
  assert.match(detail.compatibility_reason, GATED);
  assert.equal(detail.compatibility_reason.includes(MARKER), false, '上游原文不许进接口字段');
  assert.equal(detail.compatibility_reason, `上游调用失败，原文 ${raw.length} 字未落盘`);

  // 本地自造的可执行提示（过 `fail()`，带 status）照原样留给运维——闸不吞自己写的话术。
  const local = path.join(directory, 'local');
  const staged = await stagedPackage(local, payloadFor({ sections: {}, knowledge_revision: 'r1' },
    { target: 'other-customer' }));
  const localDetail = await new UpdateStore(prompts, staged.options).detail(staged.id);
  assert.equal(localDetail.compatibility_reason, '升级包不适用于当前客户环境');
});

// ---------------------------------------------------------------- A3 triage-rules.js

test('A3 triage-rules:配置解析失败原文不进 readConfig().error，revision / 回落照旧', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'triage-rules.json');
  await writeFile(file, `{ "${MARKER}" oops }`, 'utf8');
  const config = await new TriageRuleEngine(file).readConfig();

  assert.equal(config.origin, 'invalid', '仍回落示例配置并记 invalid');
  assert.match(config.error, GATED);
  assert.equal(config.error.includes(MARKER), false, 'JSON.parse 原文不许进接口字段');
  assert.equal(typeof config.revision, 'string', 'revision 仍是原文件的哈希');
  assert.ok(Array.isArray(config.config.rules), '回落的示例配置仍可用');
});
