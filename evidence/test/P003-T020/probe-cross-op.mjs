// P003-T020 探针（不是测试用例）：换算子收紧会不会被当放宽拒绝。
// 结论写进了 evidence/test/P003-T020/test-report.md §6 发现 2（doc-side：docs §3.4 与提示词都没点名换算子会被拒）。
// 只走公开类 RegoRuleMaintainer.maintain()，不碰仓库里的 rules/。
// 跑法（仓根）：timeout 60 node evidence/test/P003-T020/probe-cross-op.mjs
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RegoRuleMaintainer } from '../../../server.js';
import { RuleStore } from '../../../rule-store.js';

const ORIGINAL = `package hids.rules.webshell_drop

# name: WebShell 落地脚本

default match := false

match if {
  input.type == "webshell"
  input.host != ""
  startswith(input.path, "/tmp/")
  endswith(input.path, ".jsp")
}
`;

// 语义上更严（允许集从「/tmp/ 下所有 .jsp」缩到「恰好 /tmp/x.jsp」），但换了算子。
const CROSS_OPERATOR = ORIGINAL.replace('startswith(input.path, "/tmp/")', 'input.path == "/tmp/x.jsp"');

const root = await mkdtemp(path.join(tmpdir(), 'p003t020-probe-'));
const rulesDir = path.join(root, 'rules');
await mkdir(rulesDir, { recursive: true });
await writeFile(path.join(rulesDir, 'webshell_drop.rego'), ORIGINAL);

const model = { complete: async () => ({ content: JSON.stringify({
  ready: true, id: 'webshell_drop', name: 'WebShell 落地脚本', rego: CROSS_OPERATOR
}) }) };
const maintainer = new RegoRuleMaintainer(model, new RuleStore(rulesDir), { load: async () => ({ prompts: { rule: '探针' } }) });

try {
  const result = await maintainer.maintain({ caseId: 'probe', eventType: 'webshell', reason: '探针', who: 'ops', alert: {}, ruleIds: [] });
  console.log('ACTION:', result.action);
} catch (cause) {
  console.log('REJECTED:', cause.message.slice(0, 160));
}
await rm(root, { recursive: true, force: true });
