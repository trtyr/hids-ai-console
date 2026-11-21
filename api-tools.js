import { eventTypes, rpcMethods } from './src/shared/vocabulary.js';
import { EvidenceSession } from './agent-tools.js';

const eventNames = Object.keys(eventTypes);
const sourceFilters = new Set(['honeypot', 'brute_force']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const listSchema = type => ({ type: 'object', properties: {
  count: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 },
  host_id: { type: 'integer', minimum: 1 }, host_ip: { type: 'string' },
  ...(sourceFilters.has(type) ? { source_ip: { type: 'string' } } : {})
} });

export class ApiEvidenceToolbox {
  constructor(rpc) { this.rpc = rpc; }

  async listTools() {
    return [
      ...eventNames.flatMap(type => [
        { name: `get_${type}_event`, description: `通过牧云 API 按事件 ID 读取${eventTypes[type]}详情`,
          inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } },
        { name: `list_${type}_events`, description: `通过牧云 API 查询${eventTypes[type]}事件；时间范围在返回后本地核对，不能把当前页当全量`,
          inputSchema: listSchema(type) }
      ]),
      { name: 'list_host_events', description: '通过牧云 API 按主机 ID 查询指定类型的相关事件；返回部分类型或页时需记录覆盖范围',
        inputSchema: { type: 'object', properties: { host_id: { type: 'integer', minimum: 1 },
          types: { type: 'array', items: { type: 'string', enum: eventNames }, maxItems: 11 },
          count: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['host_id'] } }
    ];
  }

  async callTool(name, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('API 取证参数必须是对象');
    const detail = name.match(/^get_([a-z_]+)_event$/);
    if (detail && Object.hasOwn(eventTypes, detail[1])) {
      if (!positive(args.id) || Object.keys(args).some(key => key !== 'id')) throw new Error('事件详情需要有效 ID');
      const raw = await this.rpc.call(`${rpcMethods[detail[1]]}.GetEvent`, { id: args.id });
      const event = raw?.event || raw;
      if (Number(event?.id ?? event?.event_id) !== args.id) throw new Error('牧云 API 详情事件 ID 与请求不符');
      return event;
    }
    const list = name.match(/^list_([a-z_]+)_events$/);
    if (list && Object.hasOwn(eventTypes, list[1])) return this.listEvents(list[1], args);
    if (name === 'list_host_events') {
      if (!positive(args.host_id)) throw new Error('主机事件查询需要有效 host_id');
      const types = args.types || eventNames;
      if (!Array.isArray(types) || !types.length || types.length > 11 || types.some(type => !Object.hasOwn(eventTypes, type)))
        throw new Error('事件类型范围无效');
      const count = args.count ?? 10;
      if (!positive(count) || count > 20) throw new Error('单类查询条数超出范围');
      const settled = await Promise.allSettled([...new Set(types)].map(type => this.listEvents(type, { host_id: args.host_id, count })));
      const events = [], errors = {}, totals = {};
      [...new Set(types)].forEach((type, index) => {
        const item = settled[index];
        if (item.status === 'fulfilled') {
          totals[type] = item.value.total;
          events.push(...item.value.events.map(event => ({ ...event, event_type: type })));
        } else errors[type] = String(item.reason?.message || item.reason).slice(0, 200);
      });
      if (Object.keys(errors).length === new Set(types).size) throw new Error(`主机事件 API 全部查询失败：${Object.values(errors)[0]}`);
      events.sort((a, b) => Number(b.created_at || b.start_time || 0) - Number(a.created_at || a.start_time || 0));
      return { total: Object.values(totals).reduce((sum, value) => sum + value, 0), events,
        queried_types: [...new Set(types)], totals_by_type: totals, errors, partial: Object.keys(errors).length > 0,
        query_scope: '各事件类型只取当前页；未查询的分页和失败类型不代表无事件' };
    }
    throw new Error(`牧云 API 不提供取证工具 ${name}`);
  }

  async listEvents(type, args) {
    const count = args.count ?? 20;
    const offset = args.offset ?? 0;
    if (!positive(count) || count > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      throw new Error('牧云 API 分页参数无效');
    const allowed = new Set(['count', 'offset', 'host_id', 'host_ip', ...(sourceFilters.has(type) ? ['source_ip'] : [])]);
    if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('牧云 API 不支持该筛选字段');
    const params = { count, offset };
    if (args.host_id != null) {
      if (!positive(args.host_id)) throw new Error('host_id 无效');
      params.host_id = [args.host_id];
    }
    for (const key of ['host_ip', 'source_ip']) if (args[key] != null) {
      if (typeof args[key] !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(args[key]) ||
        args[key].split('.').some(part => Number(part) > 255)) throw new Error(`${key} 必须是 IPv4 地址`);
      params[key] = [args[key]];
    }
    const method = `${rpcMethods[type]}.${type === 'honeypot' ? 'List' : 'GetEventList'}`;
    const raw = await this.rpc.call(method, params);
    if (!Array.isArray(raw?.events) || !Number.isSafeInteger(Number(raw?.total))) throw new Error('牧云 API 列表响应无效');
    return { total: Number(raw.total), events: raw.events, queried_type: type, queried_offset: offset,
      queried_count: count, query_scope: '牧云 API 当前页；时间条件须对返回行在本地核对' };
  }

  investigation(maxCalls = 20) { return new EvidenceSession(this, maxCalls); }
}
