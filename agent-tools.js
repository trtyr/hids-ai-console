import { createHash } from 'node:crypto';
import { CloudwalkerMcpClient } from './src/contexts/ingestion/infrastructure/mcp-client.js';
import { eventTypes } from './src/shared/vocabulary.js';
import { boundEvidenceView, projectEvidence } from './evidence-view.js';

// 只将明确选择的查询工具交给研判智能体。牧云 MCP 另有 whitelist_* 写入工具。
const eventToolNames = Object.keys(eventTypes).flatMap(type => [`list_${type}_events`, `get_${type}_event`]);
export const investigationToolNames = Object.freeze([
  ...eventToolNames,
  'list_global_events', 'list_host_events',
  'list_full_commands', 'get_full_command', 'list_full_commands_by_host', 'list_full_commands_by_ssh_client_ip',
  'list_firewall_connection_records', 'get_firewall_topology_detail', 'get_internal_ip_define',
  'list_network_audit_events_by_host', 'list_network_audit_events_by_target', 'list_network_audit_events_by_process_name',
  'list_host_assets', 'list_host_views', 'get_host_info_detail', 'get_host_business_info', 'get_host_risk_overview',
  'list_process_assets', 'get_process_asset', 'list_port_assets', 'list_user_assets',
  'list_windows_user_assets', 'list_domain_user_assets', 'list_crontab_assets', 'list_startup_assets'
]);
const allowed = new Set(investigationToolNames);

function validateArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  const properties = schema?.properties || {};
  for (const name of Object.keys(args)) if (!Object.hasOwn(properties, name)) throw new Error(`不支持的工具参数：${name}`);
  for (const name of schema?.required || []) if (args[name] == null) throw new Error(`缺少必需参数：${name}`);
  if (args.count !== undefined && (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 50)) throw new Error('count 必须在 1 到 50 之间');
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 10000)) throw new Error('offset 超出允许范围');
  if (args.id !== undefined && (!Number.isSafeInteger(args.id) || args.id <= 0)) throw new Error('id 必须是正整数');
}

export class AgentToolbox {
  constructor(client) { this.client = client; this.catalog = null; }

  async listTools() {
    if (!this.catalog) {
      const available = await this.client.listTools();
      this.catalog = new Map(available.filter(tool => allowed.has(tool.name)).map(tool => [tool.name, tool]));
    }
    return [...this.catalog.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async callTool(name, args = {}) {
    if (!allowed.has(name)) throw new Error(`工具 ${name} 未授权给研判智能体`);
    await this.listTools();
    const tool = this.catalog.get(name);
    if (!tool) throw new Error(`牧云 MCP 当前未提供工具 ${name}`);
    validateArgs(tool.inputSchema, args);
    return this.client.callTool(name, args);
  }

  investigation(maxCalls = 20) { return new EvidenceSession(this, maxCalls); }
}

// 每个研判任务独立保存工具结果。模型看到的是带证据 ID 的结果，不直接持有 Token。
export class EvidenceSession {
  constructor(toolbox, maxCalls = 20) { this.toolbox = toolbox; this.records = new Map(); this.started = 0; this.maxCalls = maxCalls; }

  async callTool(name, args = {}) {
    if (this.started >= this.maxCalls) throw new Error(`本次调查的取证调用已达到 ${this.maxCalls} 次上限`);
    const evidenceId = `cw:${++this.started}`;
    const result = await this.toolbox.callTool(name, args);
    const serialized = JSON.stringify({ name, args, result });
    if (serialized.length > 2_000_000) throw new Error('工具结果超出本次调查的单次取证上限');
    const digest = createHash('sha256').update(serialized).digest('hex');
    const record = { evidenceId, tool: name, args: structuredClone(args), fetchedAt: new Date().toISOString(), sha256: digest, result,
      view: boundEvidenceView(projectEvidence(name, result)) };
    this.records.set(evidenceId, record);
    return record;
  }

  // 机器校验只能核实“引用存在且字段值吻合”，不能替代语义和授权判断。
  verifyClaims(claims) {
    const errors = [];
    if (!Array.isArray(claims)) return { ok: false, errors: ['claims 必须是数组'] };
    if (!claims.length) return { ok: false, errors: ['claims 缺少可核验事实'] };
    claims.forEach((claim, index) => {
      if (!Array.isArray(claim?.citations) || !claim.citations.length) {
        errors.push(`claims[${index}] 缺少证据引用`); return;
      }
      claim.citations.forEach((cite, citeIndex) => {
        const record = this.records.get(cite?.evidence_id);
        const prefix = `claims[${index}].citations[${citeIndex}]`;
        if (!record) { errors.push(`${prefix} 引用不存在`); return; }
        if (typeof cite.pointer !== 'string' || !cite.pointer.startsWith('/')) { errors.push(`${prefix} 缺少 JSON Pointer`); return; }
        const parts = cite.pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
        let value = record.result;
        for (const part of parts) value = value != null && Object.hasOwn(Object(value), part) ? value[part] : undefined;
        if (value === undefined) { errors.push(`${prefix} 字段不存在`); return; }
        if (!Object.hasOwn(cite, 'value')) { errors.push(`${prefix} 缺少原始字段值`); return; }
        if (JSON.stringify(value) !== JSON.stringify(cite.value)) errors.push(`${prefix} 字段值不符`);
      });
    });
    return { ok: errors.length === 0, errors };
  }
}

// 常规研判保留牧云事件 API 的事件身份校验，只将 API 缺少的只读补证工具接入 MCP。
export class TriageEvidenceToolbox {
  constructor(eventApi, mcp) { this.eventApi = eventApi; this.mcp = mcp; }

  async listTools() {
    const [apiTools, mcpTools] = await Promise.all([this.eventApi.listTools(), this.mcp.listTools()]);
    const existing = new Set(apiTools.map(tool => tool.name));
    return [...apiTools, ...mcpTools.filter(tool => !existing.has(tool.name) &&
      /^(?:list_full_commands(?:_by_host|_by_ssh_client_ip)?|get_full_command|list_firewall_connection_records|list_process_assets|get_process_asset|list_port_assets)$/.test(tool.name))];
  }

  async callTool(name, args = {}) {
    if ((await this.eventApi.listTools()).some(tool => tool.name === name)) return this.eventApi.callTool(name, args);
    const extras = await this.mcp.listTools();
    if (!extras.some(tool => tool.name === name) ||
      !/^(?:list_full_commands(?:_by_host|_by_ssh_client_ip)?|get_full_command|list_firewall_connection_records|list_process_assets|get_process_asset|list_port_assets)$/.test(name))
      throw new Error(`常规研判不提供 ${name}`);
    return this.mcp.callTool(name, args);
  }

  investigation(maxCalls = 20) { return new EvidenceSession(this, maxCalls); }
}

export function createAgentToolboxFromEnv(env = process.env, fetcher = fetch) {
  if (!env.CLOUDWALKER_URL || !env.CLOUDWALKER_API_TOKEN) return null;
  return new AgentToolbox(new CloudwalkerMcpClient(env.CLOUDWALKER_URL, env.CLOUDWALKER_API_TOKEN, fetcher));
}
