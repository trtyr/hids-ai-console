// 黑盒探针：捷径「成功」分支——卡内套件只覆盖了落盘失败分支（第 8 条）。
// 这里用真实存在的 case_dir 走一遍：命中已审核经验 → 06-必查项.json 该落、内容该对、模型只调 1 次。
// 只调公开 API（AgentToolbox / InvestigationAgent / KnowledgeStore / writeRequiredEvidence 产物）。
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../../..', import.meta.url).pathname);
const { AgentToolbox } = await import(path.join(ROOT, 'agent-tools.js'));
const { InvestigationAgent } = await import(path.join(ROOT, 'investigation-agent.js'));
const { KnowledgeStore } = await import(path.join(ROOT, 'knowledge-store.js'));
const { knowledgeFields } = await import(path.join(ROOT, 'knowledge-workbench.js'));
const sc = await import(path.join(ROOT, 'syslog-case.js'));

const directory = await mkdtemp(path.join(tmpdir(), 't040-shortcut-ok-'));
const store = new KnowledgeStore(path.join(directory, 'knowledge'));
const created = await store.create();
await store.update(created.id, current => {
  current.status = 'published'; current.scenario_id = 'suspicious_operation';
  current.review = { reviewed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString() };
  current.fields = Object.fromEntries(knowledgeFields.map(([key]) => [key, { value: `${key} 已核对` }]));
  current.fields.reason.value = '已核对本次巡检授权'; return current;
});
const caseDir = path.join(directory, 'real-case');
await mkdir(caseDir, { recursive: true });
const caseInfo = { case_dir: caseDir, files: [] };
const toolbox = new AgentToolbox({
  listTools: async () => [{ name: 'get_suspicious_operation_event',
    inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } }],
  callTool: async () => ({ event_id: 7, host_view: { host_name: 'app-7' }, cmdline: 'systemctl status nginx' })
});
let modelCalls = 0;
const model = { model: 'fake', complete: async () => { modelCalls++; return { content: JSON.stringify({
  case_id: created.id, matched: true, summary: '同一主机的已授权巡检',
  claims: [
    { text: '主机为 app-7', citations: [{ evidence_id: 'cw:1', pointer: '/host_view/host_name', value: 'app-7' }] },
    { text: '执行巡检命令', citations: [{ evidence_id: 'cw:1', pointer: '/cmdline', value: 'systemctl status nginx' }] }
  ], unverified_conditions: [], conflicts: [] }) }; } };
const parsed = { msgid: 'cloudwalker-suspicious-command', ts: '2026-11-03T08:00:00Z', payload_format: 'keyvalue',
  payload: { event_id: '7', host_ip: '10.0.0.5', source_ip: '192.0.2.2', target_ip: '10.0.0.5',
    user_name: 'root', process_command_line: 'id' } };
const result = await new InvestigationAgent(toolbox, model, undefined, store)
  .run('suspicious_operation:7', { mode: 'triage', streamContext: { parsed, context: {}, match: { matched: false }, caseInfo } });
console.log('modelCalls =', modelCalls, '| caseInfo.files =', JSON.stringify(caseInfo.files));
const raw = await readFile(path.join(caseDir, sc.requiredEvidenceFile), 'utf8');
const body = JSON.parse(raw);
console.log('落盘字符 =', raw.length, '| alert_id =', body.alert_id, '| mode =', body.mode,
  '| checks =', body.checks?.length, '| 状态 =', JSON.stringify(body.checks?.map(item => item.status)));
console.log('判定：', modelCalls === 1 && caseInfo.files.includes(sc.requiredEvidenceFile) && body.checks?.length > 0
  ? '捷径成功分支落盘正常' : '捷径成功分支落盘异常');
await rm(directory, { recursive: true, force: true });
