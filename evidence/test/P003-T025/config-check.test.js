// P003-T025：启动时核配置，能看生效值但不回显密钥。
// 口径见 docs/modules/http-api.md §2（启动闸门）与 §3.5（GET /api/config）：
//   A1 五项必填缺任一 → 不监听、stderr 逐个列出缺的键、退出码非 0（空串算缺，边界也测）
//   A1 取值非法（HIDS_TRIAGE_INPUT_MODE 不在 syslog/poll 里）→ 同一个出口拒启动：stderr 点名键与坏值、退出码非 0
//   A2 GET /api/config 报地址、端口、研判输入模式、牧云与模型配了没有、模型名——只报生效值，triage_input_mode 永远在 enum 里
//   A3 机密只回布尔，响应正文里不出现五个机密值里任何一个的原文
// 真进程三条：缺必填（拒启动）、坏值（拒启动）、五项齐（验生效值 + 机密不外泄）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, configSummary, triageInputModeOf, invalidConfigValues } from '../../../server.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 五项必填的固定清单：实现改了这张表，下面几条会一起红。
const REQUIRED = ['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
const SECRETS = ['CLOUDWALKER_API_TOKEN', 'LLM_API_KEY', 'HIDS_BASIC_AUTH_PASSWORD',
  'HIDS_PROMPT_ADMIN_TOKEN', 'HIDS_RULE_ADMIN_TOKEN'];

// 每一项都是假值：形状合法（URL 前缀、Token ≥6 位）以便装配不被 rpc-client / model-client 挡掉，
// 但一点都不像真凭据——本文件里不许出现任何真 Token / 真密码。
const FAKE_ENV = Object.freeze({
  HIDS_HOST: '127.0.0.1',
  CLOUDWALKER_URL: 'http://127.0.0.1:1',
  CLOUDWALKER_API_TOKEN: 'fake-token-123456',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_API_KEY: 'fake-key-abcdef',
  LLM_MODEL: 'fake-model',
  HIDS_BASIC_AUTH_USER: 'ops',
  HIDS_BASIC_AUTH_PASSWORD: 'fake-pass-abcdef',
  // 两个 admin 令牌也要有值：A3 的「正文无原文」必须盖住五个机密，缺值的键等于没测。
  HIDS_PROMPT_ADMIN_TOKEN: 'fake-prompt-token-abcdef',
  HIDS_RULE_ADMIN_TOKEN: 'fake-rule-token-abcdef',
  HIDS_TRIAGE_INPUT_MODE: 'poll'
});

const completeEnv = (extra = {}) => ({ ...FAKE_ENV, ...extra });

async function serve(t) {
  const server = createServer(null, null, null, null, null, null, null, {}, null, null, null, null, null, null, null, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// 起真进程，收集 stdout / stderr，等到条件成立或进程退出或超时。
async function runServer(t, env, until) {
  // HIDS_DATA_DIR 指到 tmp：真进程不许往仓库或真实全局根写运行态（P003-T034 A2）。
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'hids-config-check-data-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { PATH: process.env.PATH, ...env, HIDS_DATA_DIR: dataDirectory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { seen.stdout += chunk; });
  child.stderr.on('data', chunk => { seen.stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(() => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once('exit', () => done());
    child.kill('SIGKILL');
  }));
  const deadline = Date.now() + 8000;
  while (!until(seen, child)) {
    if (child.exitCode !== null) break;
    if (Date.now() > deadline) throw new Error(`真进程 8s 内既没起也没退出：stdout=${seen.stdout} stderr=${seen.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { child, seen, exited };
}

// ---------------- A1：必填判定（纯函数矩阵） ----------------
test('A1 五项必填全给：missing_required 为空，生效值取环境变量', () => {
  const config = configSummary(completeEnv({ HIDS_PORT: '9099' }));
  assert.deepEqual(config.missing_required, []);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 9099);
  assert.equal(config.triage_input_mode, 'poll');
  assert.equal(config.cloudwalker.configured, true);
  assert.equal(config.model.configured, true);
  assert.equal(config.model.name, 'fake-model');
});

test('A1 五项逐个缺一条：每次都只列缺的那一项（不是「缺一项就全列」）', () => {
  for (const key of REQUIRED) {
    const env = completeEnv();
    delete env[key];
    const config = configSummary(env);
    assert.deepEqual(config.missing_required, [key], `缺 ${key} 时 missing_required 应只有它`);
    // 缺的那项落在哪一半能力上，那半边就是「没配」——牧云两项、模型三项，互不连坐。
    if (key.startsWith('CLOUDWALKER_')) {
      assert.equal(config.cloudwalker.configured, false, `缺 ${key} 时牧云不该算配好`);
      assert.equal(config.model.configured, true, `缺 ${key} 不该连坐模型`);
    } else {
      assert.equal(config.model.configured, false, `缺 ${key} 时模型不该算配好`);
      assert.equal(config.cloudwalker.configured, true, `缺 ${key} 不该连坐牧云`);
    }
  }
});

test('A1 全缺：五项按固定顺序全列出来，牧云与模型都算没配', () => {
  const config = configSummary({});
  assert.deepEqual(config.missing_required, REQUIRED);
  assert.equal(config.cloudwalker.configured, false);
  assert.equal(config.model.configured, false);
  assert.equal(config.model.name, null);
  // 缺省值：地址/端口/输入模式回到代码里的那三个缺省（server.js:29-30、server.js:46）。
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8080);
  assert.equal(config.triage_input_mode, 'syslog');
});

test('A1 Basic 口令与两个 admin Token 不算必填：不配只是那项能力空着，不拦启动', () => {
  const config = configSummary({ ...FAKE_ENV, HIDS_BASIC_AUTH_PASSWORD: '', HIDS_PROMPT_ADMIN_TOKEN: '', HIDS_RULE_ADMIN_TOKEN: '' });
  assert.deepEqual(config.missing_required, []);
  assert.equal(config.auth.basic_auth_enabled, false);
});

test('A1 空串也算缺：五项必填逐个给空串 → missing_required 只列那一项', () => {
  for (const key of REQUIRED) {
    const env = completeEnv();
    env[key] = '';
    assert.deepEqual(configSummary(env).missing_required, [key], `${key} 给空串应算缺（.env.example 的占位就是空串）`);
  }
});

test('A1 取值非法：HIDS_TRIAGE_INPUT_MODE 不在 syslog/poll 里 → 进闸门；报出来的永远是生效值', () => {
  const invalid = invalidConfigValues(completeEnv({ HIDS_TRIAGE_INPUT_MODE: 'pirate' }));
  assert.deepEqual(invalid, [{ key: 'HIDS_TRIAGE_INPUT_MODE', value: 'pirate', allowed: ['syslog', 'poll'] }],
    '坏值要带键名、坏值与允许取值，闸门靠它写 stderr 与日志');

  // 空值/未设＝没配（走文档写的缺省 syslog），非空且在表里＝合法，其余一律非法。
  assert.deepEqual(invalidConfigValues(completeEnv({ HIDS_TRIAGE_INPUT_MODE: '' })), []);
  assert.deepEqual(invalidConfigValues(completeEnv({ HIDS_TRIAGE_INPUT_MODE: 'syslog' })), []);
  assert.deepEqual(invalidConfigValues(completeEnv({ HIDS_TRIAGE_INPUT_MODE: 'poll' })), []);
  const env = completeEnv(); delete env.HIDS_TRIAGE_INPUT_MODE;
  assert.deepEqual(invalidConfigValues(env), []);

  // 只报生效值：大小写、空白、表外词都落回缺省，绝不让域外值从 triage_input_mode 漏出去（openapi enum 两个值）。
  for (const raw of ['pirate', 'POLL', 'Syslog', ' syslog', 'poll ', 'poll\n']) {
    const config = configSummary(completeEnv({ HIDS_TRIAGE_INPUT_MODE: raw }));
    assert.equal(config.triage_input_mode, 'syslog', `${JSON.stringify(raw)} 不该原样出现在响应里`);
    assert.ok(['syslog', 'poll'].includes(config.triage_input_mode), 'triage_input_mode 恒在 openapi 声明的 enum 内');
    assert.equal(invalidConfigValues(completeEnv({ HIDS_TRIAGE_INPUT_MODE: raw })).length, 1, `${JSON.stringify(raw)} 应判为坏值`);
  }
  assert.equal(triageInputModeOf({ HIDS_TRIAGE_INPUT_MODE: 'poll' }), 'poll', '合法第二值原样生效');
  assert.equal(triageInputModeOf({}), 'syslog', '未设取缺省');
});

// ---------------- A3：机密只回布尔 ----------------
test('A3 机密只报有或没有：五个机密键都是布尔，序列化后不带任何原文', () => {
  const config = configSummary(completeEnv());
  assert.deepEqual(Object.keys(config.secrets).sort(), [...SECRETS].sort());
  for (const name of SECRETS) {
    assert.equal(typeof config.secrets[name], 'boolean', `${name} 应只回布尔`);
    assert.equal(config.secrets[name], true, `${name} 配了假值 → true`);
  }

  const text = JSON.stringify(config);
  for (const name of SECRETS)
    assert.equal(text.includes(FAKE_ENV[name]), false, `响应里不该出现 ${name} 的原文 ${FAKE_ENV[name]}`);
});

test('A3 空串算没有：五个机密给空串 → 全是 false，不是空串本身', () => {
  const blank = Object.fromEntries(SECRETS.map(name => [name, '']));
  const config = configSummary(completeEnv(blank));
  for (const name of SECRETS) assert.equal(config.secrets[name], false, `${name} 空串应报 false`);
  assert.equal(config.auth.basic_auth_enabled, false, '空口令 → 不启用 Basic 认证');
  const text = JSON.stringify(config);
  for (const name of SECRETS) assert.equal(text.includes(`${name}":""`), false, `${name} 不该以空串出现在正文里`);
});

// ---------------- A2：GET /api/config 的生效值 ----------------
test('A2 GET /api/config：报地址、端口、研判输入模式、牧云与模型配了没有、模型名', async t => {
  const saved = {};
  const touched = ['HIDS_HOST', 'HIDS_PORT', 'HIDS_TRIAGE_INPUT_MODE', ...REQUIRED];
  for (const key of touched) saved[key] = process.env[key];
  Object.assign(process.env, { HIDS_HOST: '127.0.0.1', HIDS_PORT: '8123', HIDS_TRIAGE_INPUT_MODE: 'poll',
    CLOUDWALKER_URL: FAKE_ENV.CLOUDWALKER_URL, CLOUDWALKER_API_TOKEN: FAKE_ENV.CLOUDWALKER_API_TOKEN,
    LLM_BASE_URL: FAKE_ENV.LLM_BASE_URL, LLM_API_KEY: FAKE_ENV.LLM_API_KEY, LLM_MODEL: 'qwen-fake' });
  t.after(() => { for (const key of touched) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

  const base = await serve(t);
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.host, '127.0.0.1');
  assert.equal(body.port, 8123);
  assert.equal(body.triage_input_mode, 'poll');
  assert.equal(body.cloudwalker.configured, true);
  assert.equal(body.model.configured, true);
  assert.equal(body.model.name, 'qwen-fake');
  assert.equal(body.mcp, undefined, '牧云只有一个判定，不再另报 mcp（同两个键）');
  assert.deepEqual(body.missing_required, []);
});

// ---------------- A1 + A2 + A3：真进程 ----------------
test('A1 真进程缺必填：不监听、退出码非 0、stderr 逐个列出缺的键', async t => {
  // 只给监听地址与端口，五项必填一个不给。
  const { seen, exited } = await runServer(t, { HIDS_HOST: '127.0.0.1', HIDS_PORT: String(await freePort()) },
    (seen, child) => child.exitCode !== null);
  const code = await exited;
  assert.notEqual(code, 0, '缺必填时退出码必须非 0');
  assert.equal(seen.stdout.includes('"event":"server.started"'), false, '拒绝启动时不该打 server.started');
  for (const name of REQUIRED) assert.ok(seen.stderr.includes(name), `stderr 应点名缺的 ${name}：${seen.stderr}`);
  // 启动失败那条日志也点名（运维靠它查），但字段名不叫 token / password。
  assert.ok(seen.stdout.includes('"event":"server.start_failed"'), `应有 server.start_failed 日志：${seen.stdout}`);
});

test('A1 真进程必填给空串：exit≠0、stderr 只点名那一项、无 server.started', async t => {
  const port = await freePort();
  const { seen, exited } = await runServer(t, { ...FAKE_ENV, HIDS_PORT: String(port), LLM_MODEL: '' },
    (seen, child) => child.exitCode !== null);
  assert.notEqual(await exited, 0, '空串必填等于缺 → 退出码非 0');
  assert.equal(seen.stderr.trim(), '缺少必填配置：LLM_MODEL', `stderr 只该点名空串那一项：${seen.stderr}`);
  assert.equal(seen.stdout.includes('"event":"server.started"'), false, '拒绝启动时不该打 server.started');
});

test('A1 真进程取值非法：HIDS_TRIAGE_INPUT_MODE=pirate → 拒启动、stderr 点名键与坏值、日志 what=config', async t => {
  const port = await freePort();
  const { seen, exited } = await runServer(t, { ...FAKE_ENV, HIDS_PORT: String(port), HIDS_TRIAGE_INPUT_MODE: 'pirate' },
    (seen, child) => child.exitCode !== null);
  const code = await exited;
  assert.notEqual(code, 0, '坏值必须拒启动、退出码非 0');
  assert.equal(seen.stdout.includes('"event":"server.started"'), false, '坏值不该起来监听');
  assert.equal(seen.stderr.includes('缺少必填配置'), false, '五项都在，不该报「缺少必填配置」');
  assert.match(seen.stderr, /配置值无效：HIDS_TRIAGE_INPUT_MODE=pirate/, `stderr 要点名键与坏值：${seen.stderr}`);
  assert.match(seen.stderr, /syslog 或 poll/, 'stderr 要写允许的取值，别让人去翻文档');

  const line = seen.stdout.trim().split('\n').find(item => item.includes('server.start_failed'));
  assert.ok(line, `应有 server.start_failed 日志：${seen.stdout}`);
  const event = JSON.parse(line);
  assert.equal(event.what, 'config', '与缺必填同一个事件出口');
  assert.deepEqual(event.missing, [], '五项都在 → missing 为空');
  assert.deepEqual(event.invalid, [{ key: 'HIDS_TRIAGE_INPUT_MODE', value: 'pirate', allowed: ['syslog', 'poll'] }],
    'invalid 带键名、坏值、允许取值');
});

test('A2/A3 真进程五项齐：起得来，/api/config 报生效值且正文没有机密原文', async t => {
  const port = await freePort();
  const { seen } = await runServer(t, { ...FAKE_ENV, HIDS_PORT: String(port), HIDS_SYSLOG_PORT: '0' },
    seen => seen.stdout.includes('"event":"server.started"'));
  assert.ok(seen.stdout.includes('"event":"server.started"'), `五项齐时应起来：${seen.stdout}${seen.stderr}`);

  const authorization = `Basic ${Buffer.from(`ops:${FAKE_ENV.HIDS_BASIC_AUTH_PASSWORD}`).toString('base64')}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Authorization: authorization } });
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const name of SECRETS)
    assert.equal(text.includes(FAKE_ENV[name]), false, `响应正文里不该出现 ${name} 的原文 ${FAKE_ENV[name]}`);

  const body = JSON.parse(text);
  assert.equal(body.port, port);
  assert.equal(body.model.name, FAKE_ENV.LLM_MODEL);
  assert.equal(body.cloudwalker.configured, true);
  assert.equal(body.model.configured, true);
  assert.equal(body.auth.basic_auth_enabled, true);
  for (const name of SECRETS) {
    assert.equal(typeof body.secrets[name], 'boolean');
    assert.equal(body.secrets[name], true, `${name} 配了假值 → 只报 true`);
  }
});

// ---------------- A4：.env.example 与代码读取的键一致 ----------------
// 扫描口径：非测试的 .js（排除 .data / evidence / docs / prompts / rules / wiki / node_modules），
// 抓 HIDS_ / LLM_ / CLOUDWALKER_ 前缀的键名——环境变量既可能写成 process.env.X，也可能写在字符串里，
// 两种都算「代码读取的键」。双向比：代码读的必须列，列出来的必须真有人读。
const SCAN_SKIP = new Set(['node_modules', '.git', '.data', 'evidence', 'coding-reports', 'docs', 'prompts', 'rules', 'wiki']);

async function sourceFiles(directory = ROOT) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SCAN_SKIP.has(entry.name)) found.push(...await sourceFiles(full));
    } else if (entry.name.endsWith('.js') && !entry.name.includes('test') && path.basename(directory) !== 'test') {
      found.push(full);
    }
  }
  return found;
}

test('A4 .env.example 的键与代码真读的键双向一致，且现有键名没被改掉', async () => {
  const readByCode = new Set();
  for (const file of await sourceFiles()) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\b(?:HIDS|LLM|CLOUDWALKER)_[A-Z0-9_]+/g))
      if (!match[0].endsWith('_')) readByCode.add(match[0]);
  }
  const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const listed = new Set(example.split('\n').filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]));

  assert.deepEqual([...readByCode].filter(key => !listed.has(key)).sort(), [],
    '代码读、但 .env.example 没列的键');
  assert.deepEqual([...listed].filter(key => !readByCode.has(key)).sort(), [],
    '.env.example 列了、但代码里没人读的键');

  // 老键名一个都不许丢（A4 明确「不改现有环境变量的名字」）。
  for (const name of ['HIDS_HOST', 'HIDS_PORT', 'CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN', 'LLM_BASE_URL',
    'LLM_MODEL', 'LLM_API_KEY', 'HIDS_BASIC_AUTH_USER', 'HIDS_BASIC_AUTH_PASSWORD', 'HIDS_PROMPT_ADMIN_TOKEN',
    'HIDS_RULE_ADMIN_TOKEN', 'HIDS_TRIAGE_INPUT_MODE', 'HIDS_SYSLOG_HOST', 'HIDS_SYSLOG_PORT'])
    assert.ok(listed.has(name), `.env.example 丢了老键名 ${name}`);

  // 五项必填在示例文件里必须点名标出，否则新部署抄它抄不出一个能起的进程。
  const requiredNote = example.split('\n').filter(line => line.startsWith('#')).join('\n');
  for (const name of REQUIRED) assert.ok(requiredNote.includes(name), `.env.example 注释里应点名必填项 ${name}`);
});
