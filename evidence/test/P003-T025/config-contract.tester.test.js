// P003-T025 测试席（何东阳）黑盒验收：启动闸门 + GET /api/config。
// 依据只有契约文本，不从实现里读答案：
//   openapi.yaml   —— info.description 的启动闸门段；paths./api/config.get 的 200 schema 与 401
//   docs/modules/http-api.md —— §1 三种响应形状 / §2 进程入口（先核配置再监听）/ §3.1 路由表 / §3.2 固定响应
//                              / §3.5 生效配置（字段表、机密口径、不做什么）/ §4 Basic 认证（401 四条头）
//   docs/architecture.md —— §3.5 缺配置时会怎样（闸门五项、装配处抛值的形状）/ §3.6 日志事件表 / §10.1 配置项
// 做法：真进程（env 全隔离）+ 进程内 createServer（文档 §3.5 明确允许的唯一「缺必填」起法）+ 真 HTTP。
// 断言不写死「当前实现长什么样」：200 正文一律按 openapi.getConfig 的 schema 逐字段验一遍。
// 全局根隔离（P003-T050 A2）：本文件触发写接口 → 产生审计事件（P003-T062），必须先隔离数据根。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../server.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 真进程的数据根：全部指到 tmp，一个字节都不许写进仓库或真实全局根（P003-T034 A2）。
// 本文件的真进程 helper 拿不到 `t`，所以用「每个 helper 自己建一个 tmp 数据根 + 进程退出时兜底清理」。
const dataRoots = [];
process.once('exit', () => { for (const directory of dataRoots) { try { rmSync(directory, { recursive: true, force: true }); } catch {} } });
const newDataRoot = () => { const directory = mkdtempSync(path.join(tmpdir(), 'hids-config-contract-data-')); dataRoots.push(directory); return directory; };

// 契约里的固定清单（openapi.yaml / http-api.md §3.5 / architecture.md §3.5 三处同口径）
const REQUIRED = ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
const SECRETS = ['CLOUDWALKER_API_TOKEN', 'LLM_API_KEY', 'HIDS_BASIC_AUTH_PASSWORD',
  'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN'];
// openapi.yaml getConfig 的 required 八个键（http-api.md §3.5：「JSON 正文八键恒在」）
// P003-T084：新增 sources（每项来源可见），八键→九键（只增不改）。
const BODY_KEYS = ['host', 'port', 'triage_input_mode', 'cloudwalker', 'model', 'auth', 'secrets', 'missing_required', 'sources'];
// 每一项都是假值：形状合法到能过装配，但一点都不像真凭据——本文件不出现任何真 Token / 真密码。
// 五个机密全给假值（P003-T025 复审：先前只给三个，两个 admin 令牌从没配过值，等于没测）。
const SECRET_VALUES = {
  CLOUDWALKER_API_TOKEN: 'fake-token-123456',
  LLM_API_KEY: 'fake-key-abcdef',
  HIDS_BASIC_AUTH_PASSWORD: 'fake-pass-abcdef',
  HIDS_PROMPT_ADMIN_TOKEN: 'fake-prompt-token-abcdef',
  HIDS_RULE_ADMIN_TOKEN: 'fake-rule-token-abcdef'
};
const ENV_KEYS = ['HIDS_HOST', 'HIDS_PORT', 'HIDS_TRIAGE_INPUT_MODE', 'HIDS_SYSLOG_HOST', 'HIDS_SYSLOG_PORT',
  'CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'HIDS_BASIC_AUTH_USER', 'HIDS_BASIC_AUTH_PASSWORD', 'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN'];

// openapi.yaml 里 getConfig 的 200 schema 原文（schema 符合性只认它，不认实现）
const CONFIG_SCHEMA = JSON.parse(execFileSync('python3', ['-c', `
import json, yaml
doc = yaml.safe_load(open(${JSON.stringify(path.join(ROOT, 'openapi.yaml'))}))
print(json.dumps(doc['paths']['/api/config']['get']['responses']['200']['content']['application/json']['schema'], ensure_ascii=False))
`], { encoding: 'utf8' }));

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

// 只实现这份 schema 用到的子集：type（含联合）/ enum / const / required / properties / items。
function schemaErrors(value, schema, at = '$') {
  const errors = [];
  if (schema.type) {
    const want = [].concat(schema.type);
    const got = typeOf(value);
    const ok = want.some(t => t === got || (t === 'number' && got === 'integer'));
    if (!ok) errors.push(`${at}: 类型应为 ${want.join('|')}，实测 ${got}（${JSON.stringify(value)}）`);
  }
  if (schema.enum && !schema.enum.some(v => v === value)) {
    errors.push(`${at}: 取值必须落在 enum ${JSON.stringify(schema.enum)} 里，实测 ${JSON.stringify(value)}`);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: 必须是 ${JSON.stringify(schema.const)}，实测 ${JSON.stringify(value)}`);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: 缺必填键 ${key}`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...schemaErrors(value[key], sub, `${at}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items, `${at}[${i}]`)));
  return errors;
}

const assertConfigSchema = body => {
  const errors = schemaErrors(body, CONFIG_SCHEMA);
  assert.deepEqual(errors, [], `GET /api/config 200 正文不符合 openapi.yaml getConfig schema：\n${errors.join('\n')}`);
};
// 文档 §3.5「JSON 正文八键恒在，secrets 之外没有第二处出现机密键」
const assertOnlyDocumentedKeys = body => {
  assert.deepEqual(Object.keys(body).sort(), [...BODY_KEYS].sort(), `正文顶层键必须是 ${BODY_KEYS.join('/')}，实测 ${Object.keys(body).join('/')}`);
  assert.deepEqual(Object.keys(body.secrets).sort(), [...SECRETS].sort(), `secrets 五个键恒在，实测 ${Object.keys(body.secrets).join('/')}`);
  for (const key of SECRETS) assert.equal(typeof body.secrets[key], 'boolean', `secrets.${key} 必须是布尔`);
};

// 文档 §3.5「响应正文里不出现任何 Token 与密码原文」
const assertNoSecretText = (text, label = '') => {
  for (const [key, value] of Object.entries(SECRET_VALUES)) {
    assert.equal(text.includes(value), false, `${label} 正文里出现了 ${key} 的原文`);
  }
};

// ---------- 进程与端口 ----------
const freePort = kind => new Promise((resolve, reject) => {
  const probe = kind === 'udp' ? net.createServer({ type: 'udp4' }) : net.createServer();
  probe.once('error', reject);
  const listen = () => probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
  listen();
});

const baseEnv = (port, extra = {}) => ({
  PATH: process.env.PATH,
  HIDS_HOST: '127.0.0.1',
  HIDS_PORT: String(port),
  CLOUDWALKER_URL: 'http://127.0.0.1:1',
  CLOUDWALKER_API_TOKEN: SECRET_VALUES.CLOUDWALKER_API_TOKEN,
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_API_KEY: SECRET_VALUES.LLM_API_KEY,
  LLM_MODEL: 'fake-model',
  ...extra
});

// 起一个会自己退出的真进程（闸门拒绝启动 / 装配抛错都是这一类），收齐 stdout+stderr。
function runToExit(env, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
      env: { ...env, HIDS_DATA_DIR: newDataRoot() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`真进程 ${timeoutMs}ms 内没有退出：stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

// 起一个真进程并等它开始接 HTTP；退出用 SIGKILL 兜底（不指望优雅关闭）。
async function startReal(t, env) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'hids-config-contract-data-'));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { ...env, HIDS_DATA_DIR: dataDirectory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { seen.stdout += chunk; });
  child.stderr.on('data', chunk => { seen.stderr += chunk; });
  t.after(() => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once('exit', () => done());
    child.kill('SIGKILL');
  }));
  const base = `http://${env.HIDS_HOST || '127.0.0.1'}:${env.HIDS_PORT}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`真进程起不来（code=${child.exitCode}）：stdout=${seen.stdout} stderr=${seen.stderr}`);
    try {
      await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(300) });
      return { base, seen, child };
    } catch {
      if (Date.now() > deadline) throw new Error(`真进程 8s 内没开始接 HTTP：stdout=${seen.stdout} stderr=${seen.stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

const call = (base, route, init = {}) => fetch(`${base}${route}`, { ...init, signal: AbortSignal.timeout(5000) });

// 进程内 createServer：第 8 个参数是 access（空对象＝不启用认证），其余走默认值。
async function serveInProcess(t) {
  const server = createServer(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

// 把本进程的环境变量清干净再按需注入，测完还回去——configSummary 读的是 process.env。
function withEnv(t, vars) {
  const saved = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  return saved;
}

const canConnect = (port, host = '127.0.0.1') => new Promise(resolve => {
  const socket = net.connect({ port, host });
  const finish = result => { socket.destroy(); resolve(result); };
  socket.setTimeout(1000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

// ================= A1：必填缺了就拒绝启动，并列出缺哪几项 =================
test('A1 真进程：五项逐个缺一条 → 不监听、stderr 只列缺的那一条、退出码非 0、无 server.started', async () => {
  for (const missing of REQUIRED) {
    const port = await freePort();
    const env = baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'poll' });
    delete env[missing];
    const { code, stdout, stderr } = await runToExit(env);

    assert.notEqual(code, 0, `缺 ${missing} 时退出码必须非 0（文档 §3.5「退出码非 0 是契约」），实测 ${code}`);
    assert.match(stderr, new RegExp(`缺少必填配置：${missing}\\s*$`, 'm'), `缺 ${missing} 时 stderr 必须是「缺少必填配置：${missing}」`);
    for (const other of REQUIRED.filter(key => key !== missing)) {
      assert.equal(stderr.includes(other), false, `缺 ${missing} 时 stderr 不该连带点名 ${other}：${stderr}`);
    }
    assert.equal(stdout.includes('server.started'), false, `缺 ${missing} 时不该打 server.started：${stdout}`);
    const failure = stdout.trim().split('\n').filter(line => line.includes('server.start_failed'));
    assert.equal(failure.length, 1, `缺 ${missing} 时必须恰好一条 server.start_failed 日志，实测 ${JSON.stringify(stdout)}`);
    const event = JSON.parse(failure[0]);
    assert.equal(event.what, 'config', 'architecture.md §3.6：server.start_failed 的 what 为 config');
    assert.deepEqual(event.missing, [missing], `server.start_failed.missing 只该有 ${missing}`);
    assert.equal(event.level, 'error', 'server.start_failed 是 error 级');
    assert.equal(await canConnect(port), false, `缺 ${missing} 时进程不该在 ${port} 上监听`);
  }
});

test('A1 真进程：五项全缺 → 按固定顺序全列、退出码非 0、不监听', async () => {
  const port = await freePort();
  const { code, stdout, stderr } = await runToExit({ PATH: process.env.PATH, HIDS_HOST: '127.0.0.1', HIDS_PORT: String(port) });
  assert.notEqual(code, 0, '五项全缺时退出码必须非 0');
  assert.equal(stderr.trim(), `缺少必填配置：${REQUIRED.join('、')}`, 'stderr 逐项列缺的键名（顿号分隔、顺序固定）');
  assert.equal(stdout.includes('server.started'), false, '五项全缺时不该打 server.started');
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)).missing, REQUIRED, 'server.start_failed.missing 按固定顺序全列');
  assert.equal(await canConnect(port), false, '五项全缺时进程不该监听');
});

// ================= A2/A3：真进程五项齐的 HTTP 面 =================
test('A2/A3 真进程五项齐（未配 Basic 口令）：/api/config 八键生效值、schema 合规、正文无凭据原文', async t => {
  const port = await freePort();
  const syslogPort = await freePort('udp');
  const env = baseEnv(port, { HIDS_SYSLOG_PORT: String(syslogPort) });
  const { base } = await startReal(t, env);

  const response = await call(base, '/api/config');
  assert.equal(response.status, 200, '五项齐的正常进程里 GET /api/config 恒为 200');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', '§1：JSON 响应的 Content-Type');
  assert.equal(response.headers.get('cache-control'), 'no-store', '§1：JSON 响应带 Cache-Control: no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', '§1：JSON 响应带 nosniff');

  const text = await response.text();
  assertNoSecretText(text, '五项齐态');
  const body = JSON.parse(text);
  assertConfigSchema(body);
  assertOnlyDocumentedKeys(body);

  // 逐字段对「文档说的取值」，不是对实现
  assert.equal(body.host, '127.0.0.1', 'host 是 HIDS_HOST 的生效值');
  assert.equal(body.port, port, 'port 是 HIDS_PORT 的生效值（也是真实监听端口）');
  assert.equal(body.triage_input_mode, 'syslog', 'HIDS_TRIAGE_INPUT_MODE 未设时缺省 syslog');
  assert.equal(body.cloudwalker.configured, true, '牧云两个键都在 → configured:true');
  assert.equal(body.model.configured, true, '模型三项齐 → configured:true');
  assert.equal(body.model.name, 'fake-model', 'model.name 是 LLM_MODEL 的原值');
  assert.equal(body.auth.basic_auth_enabled, false, '没配 HIDS_BASIC_AUTH_PASSWORD → 不启用 Basic 认证');
  assert.deepEqual(body.secrets, {
    CLOUDWALKER_API_TOKEN: true, LLM_API_KEY: true, HIDS_BASIC_AUTH_PASSWORD: false,
    HIDS_PROMPT_ADMIN_TOKEN: false, HIDS_RULE_ADMIN_TOKEN: false
  }, 'secrets 只报有或没有：两个配了的 true，三个没配的 false');
  assert.deepEqual(body.missing_required, [], '正常起着的进程 missing_required 恒为空数组');
});

test('A2/A3 真进程五项齐 + Basic 口令：401 纯文本四条头、正确凭据 200 且正文无凭据原文', async t => {
  const port = await freePort();
  const env = baseEnv(port, {
    HIDS_BASIC_AUTH_USER: 'ops',
    HIDS_BASIC_AUTH_PASSWORD: SECRET_VALUES.HIDS_BASIC_AUTH_PASSWORD,
    // 两个 admin 令牌一起配：A3 的「正文无原文」要盖住全部五个机密（P003-T025 复审）
    HIDS_PROMPT_ADMIN_TOKEN: SECRET_VALUES.HIDS_PROMPT_ADMIN_TOKEN,
    HIDS_RULE_ADMIN_TOKEN: SECRET_VALUES.HIDS_RULE_ADMIN_TOKEN,
    HIDS_TRIAGE_INPUT_MODE: 'poll'
  });
  const { base } = await startReal(t, env);

  // §4：闸门在请求处理函数第一行，/api/config 也拦；401 是纯文本，不是 JSON 错误体
  for (const [label, headers] of [['无凭据', {}], ['错口令', { Authorization: `Basic ${Buffer.from('ops:wrong-pass').toString('base64')}` }]]) {
    const response = await call(base, '/api/config', { headers });
    assert.equal(response.status, 401, `${label} 时状态码`);
    assert.equal(response.headers.get('www-authenticate'), 'Basic realm="HIDS AI Console", charset="UTF-8"', `${label} 时 WWW-Authenticate`);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', `${label} 时 401 是 JSON`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${label} 时 401 带 no-store`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${label} 时 401 带 nosniff`);
    assert.deepEqual(await response.json(), { error: '需要登录后访问', code: 'unauthorized' }, `${label} 时 401 正文`);
  }

  const ok = await call(base, '/api/config', {
    headers: { Authorization: `Basic ${Buffer.from(`ops:${SECRET_VALUES.HIDS_BASIC_AUTH_PASSWORD}`).toString('base64')}` }
  });
  assert.equal(ok.status, 200, '正确凭据 → 200');
  const text = await ok.text();
  assertNoSecretText(text, '配 Basic 口令态');
  const body = JSON.parse(text);
  assertConfigSchema(body);
  assertOnlyDocumentedKeys(body);
  assert.equal(body.auth.basic_auth_enabled, true, '配了 HIDS_BASIC_AUTH_PASSWORD → 启用 Basic 认证');
  assert.equal(body.secrets.HIDS_BASIC_AUTH_PASSWORD, true, '口令配了 → true（只报有没有）');
  assert.equal(body.secrets.HIDS_PROMPT_ADMIN_TOKEN, true, '知识库令牌配了 → true');
  assert.equal(body.secrets.HIDS_RULE_ADMIN_TOKEN, true, '规则令牌配了 → true');
  assert.equal(body.model.name, 'fake-model', '同一份 env 里模型名照旧生效');
});

test('A2 真进程：HIDS_TRIAGE_INPUT_MODE=poll → 响应报 poll（合法第二值）', async t => {
  const port = await freePort();
  const { base } = await startReal(t, baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'poll' }));
  const body = await (await call(base, '/api/config')).json();
  assertConfigSchema(body);
  assert.equal(body.triage_input_mode, 'poll', 'poll 是 openapi enum 里的合法值，必须原样报出来');
});

// ================= A2/A3：进程内 createServer 的两态（文档 §3.5 允许的唯一「缺必填」起法） =================
test('A2/A3 进程内全缺态：200 + 八键 + missing_required 全列 + secrets 全 false + 缺省值', async t => {
  const base = await serveInProcess(t);
  withEnv(t, {});
  const response = await call(base, '/api/config');
  assert.equal(response.status, 200, '§3.5「缺件也不回 503：这个接口只读环境变量，永远 200」');
  const text = await response.text();
  assertNoSecretText(text, '全缺态');
  const body = JSON.parse(text);
  assertConfigSchema(body);
  assertOnlyDocumentedKeys(body);
  assert.deepEqual(body.missing_required, REQUIRED, 'missing_required 按固定顺序全列五项');
  assert.equal(body.cloudwalker.configured, false, '牧云没配');
  assert.equal(body.model.configured, false, '模型没配');
  assert.equal(body.model.name, null, '未配 LLM_MODEL → name 为 null');
  assert.equal(body.auth.basic_auth_enabled, false, '没配口令 → 不启用认证');
  assert.deepEqual(Object.values(body.secrets), [false, false, false, false, false], '五个机密全 false');
  assert.equal(body.host, '127.0.0.1', 'host 缺省 127.0.0.1');
  assert.equal(body.port, 8080, 'port 缺省 8080');
  assert.equal(body.triage_input_mode, 'syslog', 'triage_input_mode 缺省 syslog');
});

test('A2/A3 进程内半配：牧云「两个都在才算配好」，模型不因牧云缺而连坐', async t => {
  const base = await serveInProcess(t);
  withEnv(t, { CLOUDWALKER_URL: 'http://127.0.0.1:1' });
  let body = await (await call(base, '/api/config')).json();
  assertConfigSchema(body);
  assert.equal(body.cloudwalker.configured, false, '只有 CLOUDWALKER_URL、没有 API_TOKEN → 不算配好');
  assert.equal(body.secrets.CLOUDWALKER_API_TOKEN, false, '没配的 Token 报 false');

  withEnv(t, { CLOUDWALKER_URL: 'http://127.0.0.1:1', CLOUDWALKER_API_TOKEN: SECRET_VALUES.CLOUDWALKER_API_TOKEN });
  body = await (await call(base, '/api/config')).json();
  assertConfigSchema(body);
  assert.equal(body.cloudwalker.configured, true, '两个都在 → configured:true');
  assert.equal(body.model.configured, false, '牧云配好不影响「模型没配」的判定');
  assert.deepEqual(body.missing_required, ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'], '只报还缺的三项');
});

test('A3 进程内：机密「有或没有」的边界——空串算没有，admin 令牌配了算有且不回显', async t => {
  const base = await serveInProcess(t);
  withEnv(t, {
    HIDS_BASIC_AUTH_PASSWORD: '',
    HIDS_PROMPT_ADMIN_TOKEN: SECRET_VALUES.HIDS_PROMPT_ADMIN_TOKEN,
    HIDS_RULE_ADMIN_TOKEN: ''
  });
  const response = await call(base, '/api/config');
  const text = await response.text();
  assertNoSecretText(text, 'admin 令牌配了但规则令牌是空串');
  const body = JSON.parse(text);
  assertConfigSchema(body);
  assert.equal(body.secrets.HIDS_BASIC_AUTH_PASSWORD, false, '空串＝没配（§4「设成空串效果一样：不校验身份」）');
  assert.equal(body.auth.basic_auth_enabled, false, '空串口令 → 不启用认证');
  assert.equal(body.secrets.HIDS_PROMPT_ADMIN_TOKEN, true, '配了令牌 → true');
  assert.equal(body.secrets.HIDS_RULE_ADMIN_TOKEN, false, '空串令牌 → false');
  assert.equal(await call(base, '/api/config').then(r => r.status), 200, '空口令时接口无需凭据即可访问');
});

// ================= 值形状不校验：坏值走装配处抛错（architecture §3.5 / http-api §2） =================
test('边界：必填只判「在不在」，值形状报错来自装配处（不是「缺少必填配置」）', async () => {
  // architecture.md §3.5：CLOUDWALKER_API_TOKEN「少于 6 位由 rpc-client.js:4-5 在装配时拒」
  const port = await freePort();
  const shortToken = await runToExit(baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'poll', CLOUDWALKER_API_TOKEN: 'abc' }));
  assert.notEqual(shortToken.code, 0, 'Token 形状非法 → 进程非 0 退出');
  assert.equal(shortToken.stdout.includes('server.started'), false, 'Token 形状非法时不该起来');
  assert.equal(shortToken.stderr.includes('缺少必填配置'), false, '五项都在，不该报「缺少必填配置」');
  assert.match(shortToken.stderr, /CLOUDWALKER_API_TOKEN 无效/, 'stderr 是装配处抛的那条错');

  // http-api.md §2：值的形状（URL 前缀…）仍由装配处抛
  const badUrl = await runToExit(baseEnv(await freePort(), { HIDS_TRIAGE_INPUT_MODE: 'poll', CLOUDWALKER_URL: 'ftp://127.0.0.1' }));
  assert.notEqual(badUrl.code, 0, 'URL 前缀非法 → 进程非 0 退出');
  assert.equal(badUrl.stderr.includes('缺少必填配置'), false, '五项都在，不该报「缺少必填配置」');
  assert.match(badUrl.stderr, /CLOUDWALKER_URL 必须是 HTTP\(S\) 地址/, 'stderr 是装配处抛的那条错');
});

// ================= 取值边界：表外值拒启动（P003-T025 复审：todo 转正式断言） =================
// 契约来源：openapi.yaml info.description 的闸门段（「取值校验：HIDS_TRIAGE_INPUT_MODE 只能是 syslog 或 poll」）、
// http-api.md §2 启动闸门第 2 条、architecture.md §3.5 闸门表与 §3.6 事件表（server.start_failed 的 invalid 字段）。
test('A1 真进程：HIDS_TRIAGE_INPUT_MODE 取值非法 → 拒启动、stderr 点名键与坏值、退出码非 0', async () => {
  const port = await freePort();
  const { code, stdout, stderr } = await runToExit(baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'pirate' }));

  assert.notEqual(code, 0, '坏值必须拒启动（不许静默按 poll 跑），退出码非 0');
  assert.equal(stdout.includes('server.started'), false, '坏值不该起来监听');
  assert.equal(stderr.includes('缺少必填配置'), false, '五项都在，不该报「缺少必填配置」');
  assert.match(stderr, /配置值无效：HIDS_TRIAGE_INPUT_MODE=pirate/, `stderr 要点名键与坏值：${stderr}`);
  assert.match(stderr, /syslog 或 poll/, `stderr 要写允许的取值：${stderr}`);
  assert.equal(await canConnect(port), false, `坏值不该在 ${port} 上监听`);

  const line = stdout.trim().split('\n').find(item => item.includes('server.start_failed'));
  assert.ok(line, `坏值要落一条 server.start_failed：${stdout}`);
  const event = JSON.parse(line);
  assert.equal(event.what, 'config', 'architecture §3.6：与缺必填同一个事件出口');
  assert.equal(event.level, 'error', 'server.start_failed 是 error 级');
  assert.deepEqual(event.missing, [], '五项都在 → missing 为空');
  assert.deepEqual(event.invalid, [{ key: 'HIDS_TRIAGE_INPUT_MODE', value: 'pirate', allowed: ['syslog', 'poll'] }],
    'invalid 每条带键名、坏值、允许取值');
});

test('A1 真进程：必填给空串等于缺（.env.example 五项必填就是空占位）', async () => {
  // 文档 §3.5 闸门第 1 条只判「在不在」；空串是新部署抄 .env.example 后第一个撞到的形态。
  const port = await freePort();
  const { code, stdout, stderr } = await runToExit(baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'poll', LLM_MODEL: '' }));

  assert.notEqual(code, 0, '空串必填 → 退出码非 0');
  assert.equal(stderr.trim(), '缺少必填配置：LLM_MODEL', `stderr 只该点名空串那一项：${stderr}`);
  assert.equal(stdout.includes('server.started'), false, '空串必填不该起来');
  assert.equal(await canConnect(port), false, `空串必填不该在 ${port} 上监听`);
  const event = JSON.parse(stdout.trim().split('\n').find(item => item.includes('server.start_failed')));
  assert.deepEqual(event.missing, ['LLM_MODEL'], 'missing 只列空串那一项');
  assert.deepEqual(event.invalid, [], '空串不算取值非法（走缺省），只算缺');
});

// ================= 路由/方法边界（§3.1 没有这条组合时落到 §3.2 的 404） =================
test('边界：POST /api/config 自 P003-T029 起是写路由，尾斜杠仍落 404「接口不存在」', async t => {
  const port = await freePort();
  const { base } = await startReal(t, baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'poll' }));
  // 旧断言（P003-T025）：「POST /api/config 也回 404」——已被 P003-T029 的写配置接口取代。
  // 现在无正文的 POST 走 readJSON：正文不是 JSON 是调用方传错，回 400 caller_error，不再是 404。
  const written = await call(base, '/api/config', { method: 'POST' });
  assert.equal(written.status, 400, 'POST /api/config 已是写路由，缺正文属调用方传错');
  assert.equal(written.headers.get('content-type'), 'application/json; charset=utf-8', 'POST /api/config 是 JSON 错误体');
  const rejected = await written.json();
  assert.deepEqual(Object.keys(rejected).sort(), ['code', 'error'], 'POST /api/config 正文形状 {error, code}');
  assert.equal(rejected.code, 'caller_error', 'POST /api/config 的 code（正文不是 JSON 属调用方错误）');

  // 尾斜杠不匹配任何路由：仍落到 §3.2 的 404「接口不存在」。
  const trailing = await call(base, '/api/config/', {});
  assert.equal(trailing.status, 404, 'GET /api/config/ 的状态码（§3.2：路径对不上的落 404）');
  assert.equal(trailing.headers.get('content-type'), 'application/json; charset=utf-8', 'GET /api/config/ 是 JSON 错误体');
  const body = await trailing.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error'], 'GET /api/config/ 正文形状 {error, code}');
  assert.equal(body.error, '接口不存在', 'GET /api/config/ 的文案');
  assert.equal(body.code, 'caller_error', 'GET /api/config/ 的 code（T024：404 属调用方错误）');

  // 无参数、忽略查询串：仍是同一条路由
  assert.equal((await call(base, '/api/config?debug=1')).status, 200, 'GET /api/config 带查询串照旧 200');
});

// ================= 两类问题同时出现（http-api.md §2 第 3 条：两行都写、同一个出口） =================
test('A1 真进程：缺必填与取值非法同时出现 → 两类都点名、仍是一条 start_failed、退出码非 0', async () => {
  const port = await freePort();
  const env = baseEnv(port, { HIDS_TRIAGE_INPUT_MODE: 'pirate' });
  delete env.LLM_MODEL; // 缺一项必填 + 坏值，两个问题一起撞
  const { code, stdout, stderr } = await runToExit(env);

  assert.notEqual(code, 0, '两类问题都在也要非 0 退出');
  assert.equal(stdout.includes('server.started'), false, '两类问题都在时不监听');
  assert.match(stderr, /缺少必填配置：LLM_MODEL/, `stderr 要点名缺的键：${stderr}`);
  assert.match(stderr, /配置值无效：HIDS_TRIAGE_INPUT_MODE=pirate/, `stderr 要点名坏值与允许取值：${stderr}`);
  const failures = stdout.trim().split('\n').filter(line => line.includes('server.start_failed'));
  assert.equal(failures.length, 1, `两类问题合并成一条 start_failed，实测 ${failures.length} 条：${stdout}`);
  const event = JSON.parse(failures[0]);
  assert.deepEqual(event.missing, ['LLM_MODEL'], 'missing 只列缺的那一项');
  assert.deepEqual(event.invalid, [{ key: 'HIDS_TRIAGE_INPUT_MODE', value: 'pirate', allowed: ['syslog', 'poll'] }], 'invalid 带键名/坏值/允许取值');
  assert.equal(typeof event.error, 'string', 'event.error 是 stderr 那几行拼起来的原话');
  assert.equal(await canConnect(port), false, '两类问题都在时不该监听');
});
