// P003-T047 复审判词 major① 的回归：决策来源的**契约三处**（openapi + 两页文档）与实现必须是同一份取值表，
// 自动判定的生效口径（A/B 已拍板：以 Rego 为准）也得三处同口径。断的是文本一致性——文档漂了这条就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FP_AUTO_VERDICT, FP_DECISION_SOURCES } from '../../../fp-maintainer.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const read = file => readFile(path.join(repoRoot, file), 'utf8');

test('decision.source 三处契约与实现同一份取值表（model / fallback / idempotent）', async () => {
  assert.deepEqual([...FP_DECISION_SOURCES], ['model', 'fallback', 'idempotent']);

  const openapi = await read('openapi.yaml');
  assert.match(openapi, /enum: \[model, fallback, idempotent\]/,
    'openapi 的 CaseMaintenance.decision.source 没写全三个值（idempotent 缺失）');

  const httpApi = await read('docs/modules/http-api.md');
  assert.match(httpApi, /FP_DECISION_SOURCES/, 'http-api 没把取值表的出处指向 FP_DECISION_SOURCES');
  assert.equal(/decision\.source` 只有两个值/.test(httpApi), false, 'http-api 还写着「只有两个值」');
  assert.match(httpApi, /`idempotent`（请求的库都已在同一版本上维护过/, 'http-api 没写 idempotent 的语义');

  const pipeline = await read('docs/modules/triage-pipeline.md');
  assert.match(pipeline, /\| `decision` \| `source`（[^)]*idempotent/, 'triage-pipeline 的 decision 行没补 idempotent');
});

test('闭环自动判定的生效口径三处一致：以 Rego 为准（A/B 已拍板），JSON 规则集只留痕', async () => {
  assert.deepEqual({ ...FP_AUTO_VERDICT },
    { enabled: true, criterion: 'rego', trust: 'single', note: FP_AUTO_VERDICT.note });
  assert.match(FP_AUTO_VERDICT.note, /JSON 规则集修订照写留痕/);

  const openapi = await read('openapi.yaml');
  assert.match(openapi, /required: \[enabled, criterion\]/, 'openapi 的 FpAutoVerdict 没把生效判据列进必填');
  assert.match(openapi, /enum: \[rego\]/, 'openapi 没把生效判据钉成 rego');
  assert.equal(/enum: \[false\]/.test(openapi), false, 'openapi 还留着「自动判定恒为 false」的旧枚举');

  const httpApi = await read('docs/modules/http-api.md');
  assert.match(httpApi, /criterion: "rego"/, 'http-api 的 auto_verdict 还写着待启用');
  assert.equal(/A\/B 口径待拍板/.test(httpApi), false, 'http-api 还写着「A/B 口径待拍板」');
  assert.match(httpApi, /JSON 规则集（`triage-rules\.json`）的修订照写留痕/, 'http-api 没写 JSON 规则集只留痕');

  const pipeline = await read('docs/modules/triage-pipeline.md');
  assert.match(pipeline, /criterion: "rego"/, 'triage-pipeline 的 auto_verdict 行没同步');
  assert.equal(/A\/B 口径待拍板/.test(pipeline), false, 'triage-pipeline 还写着「A/B 口径待拍板」');
});

test('architecture.md §3.6 事件表已补误报维护域（域表是加事件的第一落点）', async () => {
  const architecture = await read('docs/architecture.md');
  const row = architecture.split('\n').find(line => line.startsWith('| `ai.model_call`（`direction: request`）'));
  assert.ok(row, 'architecture.md 里找不到 ai.model_call request 那一行');
  assert.match(row, /`false_positive`/, 'ai.model_call 的 domain 取值表没补 false_positive');
  assert.match(row, /`fp_maintainer`/, 'ai.model_call 的 role 取值表没补 fp_maintainer');
  assert.match(row, /四域/, '「三域」的措辞没改成四域');
  assert.match(architecture, /误报维护域（`domain: false_positive`，P003-T047）/,
    'architecture.md 没写误报维护域那三条调用的口径');
  const resultRow = architecture.split('\n').find(line => line.startsWith('| `maintenance.result`'));
  assert.match(resultRow, /`session_id` `sides`/, 'maintenance.result 的字段表没补 session_id / sides');
});
