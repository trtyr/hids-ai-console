import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RpcClient } from './rpc-client.js';
import { CloudwalkerGateway, eventTypes } from './cloudwalker.js';
import { createAgentToolboxFromEnv, TriageEvidenceToolbox } from './agent-tools.js';
import { ApiEvidenceToolbox } from './api-tools.js';
import { createModelFromEnv } from './model-client.js';
import { InvestigationAgent } from './investigation-agent.js';
import { InvestigationStore } from './investigation-store.js';
import { PromptStore } from './prompt-store.js';
import { TriageMonitor } from './triage-monitor.js';
import { SyslogReceiver } from './syslog-input.js';
import { eventTypeFor } from './syslog-input.js';
import { WikiStore } from './wiki-store.js';
import { WikiWorkbench } from './wiki-workbench.js';
import { TraceBoardService } from './trace-board.js';
import { UpdateStore } from './update-store.js';
import { TriageRuleEngine, validateRuleSet } from './triage-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HIDS_HOST || '127.0.0.1';
const port = Number(process.env.HIDS_PORT || 8080);
const baseUrl = process.env.CLOUDWALKER_URL;
const token = process.env.CLOUDWALKER_API_TOKEN;
const gateway = baseUrl && token ? new CloudwalkerGateway(new RpcClient(baseUrl, token)) : null;
const apiToolbox = gateway ? new ApiEvidenceToolbox(gateway.rpc) : null;
const agentToolbox = createAgentToolboxFromEnv();
const triageToolbox = apiToolbox && agentToolbox ? new TriageEvidenceToolbox(apiToolbox, agentToolbox) : apiToolbox;
const model = createModelFromEnv();
const promptStore = new PromptStore();
const wikiStore = new WikiStore();
const agent = triageToolbox && model ? new InvestigationAgent(triageToolbox, model, promptStore, wikiStore) : null;
const deepInvestigator = agentToolbox && model ? new InvestigationAgent(agentToolbox, model, promptStore, wikiStore) : null;
const investigationStore = new InvestigationStore(path.join(root, 'backend', '.data', 'investigations'));
const triageRuleEngine = new TriageRuleEngine(path.join(root, 'backend', '.data', 'triage-rules.json'));
const triageInputMode = process.env.HIDS_TRIAGE_INPUT_MODE || 'syslog';
const triageMonitor = gateway && agent ? new TriageMonitor({ service: gateway, investigator: agent,
  history: investigationStore, file: path.join(root, 'backend', '.data', 'triage-monitor.json'),
  inputMode: triageInputMode, concurrency: triageInputMode === 'syslog' ? 1 : 2,
  eventToolbox: apiToolbox, wiki: wikiStore,
  ruleEngine: triageRuleEngine,
  casesDirectory: process.env.HIDS_CASES_DIR || path.join(root, 'backend', '.data', 'cases'),
  baselineFile: path.join(root, 'backend', '.data', 'baseline.json'),
  intelFile: path.join(root, 'backend', '.data', 'intel.json') }) : null;
const wikiWorkbench = new WikiWorkbench(wikiStore, model, promptStore, path.join(root, 'backend', '.data', 'wiki-sessions'));
const traceBoard = agentToolbox && model ? new TraceBoardService({ toolbox: agentToolbox, model, promptStore,
  directory: path.join(root, 'backend', '.data', 'trace-boards') }) : null;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function error(res, status, message) { json(res, status, { error: message }); }
function hasAccess(req, access) {
  if (!access?.password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`${access.user || 'admin'}:${access.password}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function requireAccess(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="HIDS AI Console", charset="UTF-8"',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end('需要登录后访问');
}
function hasPromptAdminAccess(req, token) {
  if (!token) return false;
  const supplied = req.headers['x-prompt-admin-token'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function hasRuleAdminAccess(req, token) {
  if (!token) return false;
  const supplied = req.headers['x-rule-admin-token'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readJSON(req, maxLength = 8192) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxLength) throw new Error('请求正文过大');
  }
  try { return JSON.parse(body); } catch { throw new Error('请求正文不是 JSON'); }
}
function configured(res) {
  if (gateway) return true;
  error(res, 503, '未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN');
  return false;
}
function validAlertId(value) {
  const match = String(value || '').match(/^([a-z_]+):([1-9][0-9]*)$/);
  return Boolean(match && Object.hasOwn(eventTypes, match[1]) && Number.isSafeInteger(Number(match[2])));
}
function validTriageId(value) {
  return validAlertId(value) || /^syslog:[a-z_]+:[a-f0-9]{16}:(?:[0-9]+|unknown):[a-f0-9-]{36}$/.test(String(value));
}
function validTraceTarget(value) {
  if (validAlertId(value)) return true;
  const address = String(value || '').replace(/^ip:/, '');
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(part => Number(part) <= 255);
}
export function createServer(service = gateway, toolbox = apiToolbox, investigator = agent, history = investigationStore, prompts = promptStore, monitor = service === gateway ? triageMonitor : null, knowledge = null,
  access = { user: process.env.HIDS_BASIC_AUTH_USER, password: process.env.HIDS_BASIC_AUTH_PASSWORD }, boardService = service === gateway ? traceBoard : null,
  promptAdminToken = process.env.HIDS_PROMPT_ADMIN_TOKEN, wiki = wikiStore, wikiAgent = wikiWorkbench,
  maintenanceEntry = process.env.HIDS_MAINTENANCE_ENTRY_URL,
  ruleAdminToken = process.env.HIDS_RULE_ADMIN_TOKEN) {
  const investigate = async (executor, alertId, mode, onProgress = null) => {
    if (mode === 'triage' && monitor?.ruleEngine) {
      let decision;
      try { decision = await monitor.ruleEngine.evaluate({ alertId, toolbox }); }
      catch (cause) { decision = { status: 'error', reason: `规则评估失败：${String(cause.message).slice(0, 180)}` }; }
      if (decision.status === 'candidate') onProgress?.('规则评估', `命中 ${decision.rule.id}，交由 AI 复核`);
      const options = onProgress ? { mode, onProgress, ruleEvaluation: decision } : { mode, ruleEvaluation: decision };
      const result = await executor.run(alertId, options);
      result.rule_evaluation = decision;
      return result;
    }
    return executor.run(alertId, onProgress ? { mode, onProgress } : { mode });
  };
  return http.createServer(async (req, res) => {
    if (!hasAccess(req, access)) return requireAccess(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: true });
      if (url.pathname === '/api/updates' && req.method === 'GET') return json(res, 200, await new UpdateStore(prompts).overview());
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!service) return json(res, 200, { configured: false, connected: false, reason: '请设置牧云地址和 API Token' });
        try { return json(res, 200, { configured: true, ...(await service.status()) }); }
        catch (e) { return json(res, 502, { configured: true, connected: false, reason: e.message }); }
      }
      if (url.pathname === '/api/agent/tools' && req.method === 'GET') {
        if (!toolbox) return error(res, 503, '牧云 API 未配置');
        const tools = await toolbox.listTools();
        return json(res, 200, { provider: 'cloudwalker-api', readOnly: true, count: tools.length, tools });
      }
      if (url.pathname === '/api/trace/tools' && req.method === 'GET') {
        if (!agentToolbox) return error(res, 503, '牧云 MCP 未配置');
        const tools = await agentToolbox.listTools();
        return json(res, 200, { provider: 'cloudwalker-mcp', readOnly: true, count: tools.length, tools });
      }
      if (url.pathname === '/api/agent/status' && req.method === 'GET') {
        const activePrompts = await prompts.load();
        return json(res, 200, { configured: Boolean(investigator), model: investigator?.model?.model || null,
          missing: investigator ? [] : ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter(name => !process.env[name]),
          prompt_version: `${activePrompts.version}+${activePrompts.revision}` });
      }
      if (url.pathname === '/api/trace/boards' && req.method === 'GET') {
        if (!boardService) return error(res, 503, '深度溯源模型或牧云 MCP 尚未配置');
        return json(res, 200, { boards: await boardService.list() });
      }
      if (url.pathname === '/api/trace/boards' && req.method === 'POST') {
        if (!boardService) return error(res, 503, '深度溯源模型或牧云 MCP 尚未配置');
        const body = await readJSON(req);
        const target = body?.target || body?.alert_id || body?.ip;
        if (!validTraceTarget(target)) return error(res, 400, '请输入有效告警 ID 或 IPv4 地址');
        try { return json(res, 202, await boardService.start(target, body.focus)); }
        catch (cause) { return error(res, cause.status || 502, cause.message); }
      }
      if (url.pathname.startsWith('/api/trace/boards/') && req.method === 'GET') {
        if (!boardService) return error(res, 503, '深度溯源模型或牧云 MCP 尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/trace/boards/'.length)); }
        catch { return error(res, 400, '告警 ID 编码无效'); }
        if (!validTraceTarget(alertId)) return error(res, 400, '告警 ID 或 IP 无效');
        const board = await boardService.get(alertId);
        return board ? json(res, 200, board) : error(res, 404, '该告警尚无溯源白板');
      }
      if (url.pathname === '/api/agent/triage/status' && req.method === 'GET') {
        return monitor ? json(res, 200, monitor.summary()) : error(res, 503, '自动研判尚未配置');
      }
      if (url.pathname === '/api/triage/rules' && req.method === 'GET') {
        try { return json(res, 200, { ...await (monitor?.ruleEngine || triageRuleEngine).readConfig(),
          writable: Boolean(ruleAdminToken) }); }
        catch (cause) { return error(res, 502, `规则配置读取失败：${cause.message}`); }
      }
      if (url.pathname === '/api/triage/rules/validate' && req.method === 'POST') {
        try {
          const body = await readJSON(req, 100000);
          validateRuleSet(body.config);
          return json(res, 200, { valid: true, count: body.config.rules.length });
        } catch (cause) { return error(res, 400, cause.message); }
      }
      if (url.pathname === '/api/triage/rules' && req.method === 'PUT') {
        if (!ruleAdminToken) return error(res, 503, '尚未配置规则管理员令牌');
        if (!hasRuleAdminAccess(req, ruleAdminToken)) return error(res, 403, '规则管理员令牌无效');
        try {
          const body = await readJSON(req, 100000);
          if (!body || !Object.hasOwn(body, 'expected_revision') ||
            !(body.expected_revision === null || /^[0-9a-f]{16}$/.test(body.expected_revision)))
            return error(res, 400, '缺少有效的规则配置版本');
          return json(res, 200, await (monitor?.ruleEngine || triageRuleEngine)
            .saveConfig(body.config, body.expected_revision));
        } catch (cause) { return error(res, cause.status || 400, cause.message); }
      }
      if (url.pathname === '/api/agent/triage/cases' && req.method === 'GET') {
        if (!monitor) return error(res, 503, '自动研判尚未配置');
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0)
          return error(res, 400, '分页参数无效');
        return json(res, 200, monitor.cases({ count, offset }));
      }
      if (url.pathname === '/api/agent/triage/control' && req.method === 'PUT') {
        if (!monitor) return error(res, 503, '自动研判尚未配置');
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, '请求正文无效');
        try { return json(res, 200, await monitor.setEnabled(body.enabled)); }
        catch (cause) { return error(res, cause.status || 502, cause.message); }
      }
      if (url.pathname.startsWith('/api/agent/triage/')) {
        if (!monitor) return error(res, 503, '自动研判尚未配置');
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/agent/triage/'.length)); }
        catch { return error(res, 400, '告警 ID 编码无效'); }
        if (!validTriageId(alertId)) return error(res, 400, '告警 ID 无效');
        if (req.method === 'GET') return json(res, 200, monitor.status(alertId) || { alert_id: alertId, status: 'not_queued' });
        if (req.method === 'POST') return json(res, 202, await monitor.enqueue(alertId, { retry: true }));
      }
      if (url.pathname === '/api/agent/prompts' && req.method === 'GET') {
        return json(res, 200, await prompts.metadata());
      }
      if (url.pathname === '/api/agent/prompts' && req.method !== 'GET') return error(res, 405, '请使用提示词文件上传入口');
      if (url.pathname === '/api/agent/prompts/upload') return error(res, 410, '提示词更新已迁移到独立维护端，业务端不允许上传');
      if (url.pathname.startsWith('/api/wiki/')) {
        if (url.pathname === '/api/wiki/pages' && req.method === 'GET') {
          const query = url.searchParams.get('q');
          const pages = await wiki.browse();
          return json(res, 200, { pages: query ? pages.filter(page =>
            `${page.id} ${page.title} ${page.path}`.toLowerCase().includes(String(query).toLowerCase())).slice(0, 50) : pages });
        }
        if (url.pathname.startsWith('/api/wiki/pages/') && req.method === 'GET') {
          let filename;
          try { filename = decodeURIComponent(url.pathname.slice('/api/wiki/pages/'.length)); }
          catch { return error(res, 400, '知识库页面路径编码无效'); }
          try { return json(res, 200, await wiki.get(filename)); }
          catch (cause) { return error(res, cause.code === 'ENOENT' ? 404 : cause.status || 400, cause.message); }
        }
        if (!promptAdminToken) return error(res, 503, '尚未配置知识库管理员凭据');
        if (!hasPromptAdminAccess(req, promptAdminToken)) return error(res, 403, '知识库管理员凭据无效');
        if (url.pathname === '/api/wiki/health' && req.method === 'GET') return json(res, 200, await wiki.health());
        if (url.pathname === '/api/wiki/sessions' && req.method === 'GET') return json(res, 200, { sessions: await wikiAgent.list() });
        if (url.pathname === '/api/wiki/sessions' && req.method === 'POST') {
          const body = await readJSON(req);
          try {
            if (body.case_id) {
              const record = monitor?.records.get(body.case_id);
              if (!record?.input || record.status !== 'done' || !record.case_dir)
                return error(res, 404, '找不到已完成的 Syslog 案件');
              const eventType = eventTypeFor(record.input.parsed.msgid);
              const index = await wiki.agentIndex(eventType);
              const eligible = index.pages.filter(page => page.path.startsWith(`${index.category}/`));
              let cited = [];
              try {
                const saved = JSON.parse(await readFile(path.join(record.case_dir, 'result.json'), 'utf8'));
                cited = (saved.trace || []).filter(item => item.kind === 'wiki' && item.id).map(item => item.id);
              } catch { /* 旧案件可能没有完整的引用轨迹 */ }
              const current = body.page ? eligible.find(page => page.path === body.page) :
                eligible.find(page => cited.includes(page.id)) || eligible[0];
              if (!current) return error(res, 409, '当前场景缺少可维护的判据页');
              return json(res, 201, await wikiAgent.create(current.path, {
                case_id: body.case_id, case_dir: record.case_dir, event_type: eventType,
                reason: body.reason, expected_verdict: body.expected_verdict, who: body.who }));
            }
            return json(res, 201, await wikiAgent.create(body.page));
          }
          catch (cause) { return error(res, cause.status || (cause.code === 'ENOENT' ? 404 : 400), cause.message); }
        }
        const sessionMatch = url.pathname.match(/^\/api\/wiki\/sessions\/([0-9a-f-]{36})(?:\/(messages|replay|publish))?$/i);
        if (sessionMatch) {
          if (req.method === 'GET' && !sessionMatch[2]) {
            const session = await wikiAgent.get(sessionMatch[1]);
            return session ? json(res, 200, session) : error(res, 404, '知识维护会话不存在');
          }
          if (req.method === 'POST' && sessionMatch[2] === 'messages') {
            const body = await readJSON(req, 12000);
            try { return json(res, 200, await wikiAgent.reply(sessionMatch[1], body.content)); }
            catch (cause) { return error(res, cause.status || 502, cause.message); }
          }
          if (req.method === 'POST' && sessionMatch[2] === 'replay') {
            try { return json(res, 200, await wikiAgent.replay(sessionMatch[1])); }
            catch (cause) { return error(res, cause.status || 502, cause.message); }
          }
          if (req.method === 'POST' && sessionMatch[2] === 'publish') {
            const body = await readJSON(req, 8192);
            try { return json(res, 200, await wikiAgent.publish(sessionMatch[1], body)); }
            catch (cause) { return error(res, cause.status || 502, cause.message); }
          }
        }
        return error(res, 404, '知识库接口不存在');
      }
      if (url.pathname === '/api/agent/investigations' && req.method === 'POST') {
        const body = await readJSON(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, '请求正文无效');
        const executor = body.mode === 'deep' && investigator === agent ? deepInvestigator : investigator;
        if (!executor) return error(res, 503, '该研判模式的模型或牧云取证接口尚未配置');
        if (url.searchParams.get('stream') === '1') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
            Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
          const send = payload => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
          const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
          res.on('close', () => clearInterval(heartbeat));
          try {
            const result = await investigate(executor, body.alert_id, body.mode || 'deep',
              (stage, detail) => send({ type: 'progress', stage, detail }));
            send({ type: 'result', result: await history.save(result) });
          } catch (cause) { send({ type: 'error', error: cause.message || '研判失败' }); }
          finally { clearInterval(heartbeat); if (!res.destroyed) res.end(); }
          return;
        }
        try {
          const result = await investigate(executor, body.alert_id, body.mode || 'deep');
          return json(res, 200, await history.save(result));
        }
        catch (e) { return error(res, /告警 ID 无效|研判模式无效/.test(e.message) ? 400 : 502, e.message); }
      }
      if (url.pathname.startsWith('/api/agent/investigations/') && req.method === 'GET') {
        let alertId;
        try { alertId = decodeURIComponent(url.pathname.slice('/api/agent/investigations/'.length)); }
        catch { return error(res, 400, '告警 ID 编码无效'); }
        const mode = url.searchParams.get('mode') || 'deep';
        if (!(mode === 'triage' ? validTriageId(alertId) : validAlertId(alertId)) || !['deep', 'triage'].includes(mode)) return error(res, 400, '告警 ID 或研判模式无效');
        const saved = await history.latest(alertId, mode);
        return saved ? json(res, 200, saved) : error(res, 404, '该告警暂无已保存的研判记录');
      }
      if (url.pathname === '/api/alerts' && req.method === 'GET') {
        if (!service) return configured(res);
        const count = Number(url.searchParams.get('count') || 20);
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(offset) || offset < 0) return error(res, 400, '分页参数无效');
        const result = await service.alerts({ count, offset });
        if (monitor) result.alerts = result.alerts.map(alert => ({ ...alert, triage: monitor.status(alert.id) }));
        return json(res, 200, result);
      }
      let decodedPath;
      try { decodedPath = decodeURIComponent(url.pathname); }
      catch { return error(res, 400, '事件路径编码无效'); }
      const match = decodedPath.match(/^\/api\/alerts\/([a-z_]+):([0-9]+)$/);
      if (match && req.method === 'GET') {
        if (!service) return configured(res);
        if (!Object.hasOwn(eventTypes, match[1])) return error(res, 400, '不支持的事件类型');
        const result = await service.alert(match[1], Number(match[2]));
        if (monitor) result.alert.triage = monitor.status(result.alert.id);
        return json(res, 200, result);
      }
      if (url.pathname.startsWith('/api/')) return error(res, 404, '接口不存在');
      return error(res, 404, '接口不存在');
    } catch (e) {
      error(res, /请求正文/.test(e.message || '') ? 400 : 502, e.message || '牧云请求失败');
    }
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port, host, () => console.log(`HIDS API: http://${host}:${port}`));
  if (triageMonitor) void triageMonitor.start().then(async () => {
    if (triageInputMode === 'syslog') {
      const receiver = new SyslogReceiver({ host: process.env.HIDS_SYSLOG_HOST || '127.0.0.1',
        port: Number(process.env.HIDS_SYSLOG_PORT || 15514), onLine: line => triageMonitor.acceptSyslog(line) });
      const address = await receiver.start();
      console.log(`牧云 syslog 接收：udp://${address.address}:${address.port}`);
    }
  }).catch(error => console.error(`自动研判启动失败：${error.message}`));
}
