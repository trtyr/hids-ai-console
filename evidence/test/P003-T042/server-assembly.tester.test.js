// P003-T042 测试席（何东阳）· shipped 装配端到端：独立复核那一轮到底打谁的上游。
//
// 为什么单开一条：进程内 `new InvestigationAgent(..., models.review)` 是测试自己喂的第 6 参，
// 只能证明「agent 收到什么就用什么」，证明不了 server 的装配线（`server.js` 模块级那两个研判器）
// 真把复核实例接进了第 6 参。这里不传任何替身：spawn 真进程入口 `node server.js`
// （文档 docs/architecture.md:57 / docs/modules/http-api.md §2：入口就是零参 `createServer().listen(...)`
// + 启动监视器 + syslog 接收器），只通过环境变量与 HTTP/UDP 驱动，
// 用「同一进程里两个不同的假模型端点」区分研判轮与复核轮。
//
// 判据来源（只有契约文本，不读实现）：
//   docs/modules/http-api.md §2 装配表（研判=models.triage、独立复核=models.review）、§3.5 model.roles、
//     §3.6「改完立刻生效」（进程内角色实例原地换值）
//   docs/modules/investigation-agent.md §3.3（复核是一轮独立调用：提示词「你是独立质疑者……」、无工具、
//     期望输出 {concerns, missing_evidence, assessment}；降级结论那条路不调它）
//   docs/modules/triage-pipeline.md §3/§5（RFC5424 syslog 报文形态、msgid→类型、事件匹配三条、
//     syslog 进来到 run(targetId,{mode:'triage'}) 的链路）、§5.5 case 目录 result.json
//   .env.example（LLM_* 主判三项 / LLM_REVIEW_* 复核组三键）
//
// 假的上游只当 socket 对端（牧云 RPC+MCP 替身、模型端点），不是被测逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ---------- 工具：空闲端口 / 轮询 / 收尸 ----------
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function until(fn, { timeoutMs = 25000, everyMs = 100, label = '条件' }) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
  throw new Error(`${label}超时（${timeoutMs}ms）${lastError ? `；最后一次错误：${lastError.message}` : ''}`);
}

async function reap(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
}

// ---------- 假牧云：RPC（/rpc?method=…）+ MCP（/api/mcp）----------
// 依据 docs/modules/event-gateway.md §（POST <base>/rpc?method=<方法名>，JSON-RPC 2.0，结果在 result）
// 与 docs/modules/evidence-tools.md R-EVID-12（MCP 握手要求 serverInfo.name=cloudwalker 且带工具能力）。
const MATCHED_EVENT = {
  id: 7,
  host_ip: '10.0.0.5',
  host_id: 11,
  event_type: 'honeypot',
  event_name: 'honeypot-access',
  event_create_time: '2026-11-17 12:00:00',
  source_ip: '192.0.2.7',
  target_ip: '10.0.0.5',
  target_port: 2222,
  process_command_line: 'probe'
};

async function fakeCloudwalker(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || 'null'); } catch { body = { raw }; }
      const url = new URL(req.url, 'http://fake');
      seen.push({ path: url.pathname, method: url.searchParams.get('method'), body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname.endsWith('/mcp')) {
        if (body?.method === 'initialize')
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cloudwalker', version: 'fake' } } }));
        if (body?.method === 'tools/list')
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
          result: { content: [{ type: 'text', text: '{"empty":true}' }] } }));
      }
      // 事件详情读一条（匹配要 ID / host_ip / host_id 三对），其余一律空列表
      const rpcMethod = url.searchParams.get('method') ?? body?.method ?? '';
      const result = /Event$/.test(rpcMethod)
        ? { event: MATCHED_EVENT, events: [MATCHED_EVENT], total: 1 }
        : { events: [], total: 0, count: 0 };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { seen, base: `http://127.0.0.1:${server.address().port}` };
}

// ---------- 假模型端点：只记请求、回固定内容（OpenAI 形状，见 docs/modules/model-client.md §3.2）----------
const DRAFT = { verdict: '不确定', confidence: '低', summary: 'assembly 用例草稿结论', claims: [], missing_data: [] };
const REVIEW_REPLY = { concerns: [], missing_evidence: [], assessment: 'supported' };

async function modelUpstream(t, label, reply, key = `${label}-key-abcdef`) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = { raw }; }
      seen.push({ url: req.url, auth: req.headers.authorization, body, raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { label, seen, base: `http://127.0.0.1:${server.address().port}/v1`,
    reviewCalls: () => seen.filter(call => /独立质疑者/.test(call.raw)) };
}

// ---------- 被测件：真进程入口（零参 createServer 的 shipped 装配）----------
// syslog 报文：docs/modules/triage-pipeline.md §3.3 的 JSON 正文形态 + §3.4 的 msgid→类型表；
// target_port 参与指纹（§4.1），换它就是为了让第二条报文算新记录而不是重复折叠。
const syslogLine = targetPort => '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-honeypot '
  + JSON.stringify({ event_id: 7, host_ip: '10.0.0.5', host_id: 11, source_ip: '192.0.2.7',
    target_ip: '10.0.0.5', target_port: targetPort });

async function startShippedServer(t, { cloudwalkerBase, primaryBase, reviewBase }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hids-assembly-tester-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();

  // 环境变量就是装配输入：主判三项指向 primary 端点，复核组三键指向 review 端点（两个不同 base_url）。
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HIDS_HOST: '127.0.0.1',
      HIDS_PORT: String(port),
      HIDS_SYSLOG_PORT: '0',
      HIDS_DATA_DIR: dataDir,
      HIDS_TRIAGE_INPUT_MODE: 'syslog',
      CLOUDWALKER_URL: cloudwalkerBase,
      CLOUDWALKER_API_TOKEN: 'fake-cw-token-abcdef',
      LLM_BASE_URL: primaryBase,
      LLM_API_KEY: 'main-key-abcdef',
      LLM_MODEL: 'main-model',
      LLM_REVIEW_BASE_URL: reviewBase,
      LLM_REVIEW_API_KEY: 'review-key-abcdef',
      LLM_REVIEW_MODEL: 'review-model',
      LLM_TIMEOUT_MS: '5000'
    }
  });
  t.after(() => reap(child));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const context = label => `${label}\n--- 子进程 stdout ---\n${stdout.slice(-3000)}\n--- 子进程 stderr ---\n${stderr.slice(-1000)}`;

  const base = `http://127.0.0.1:${port}`;
  const getJson = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { response, json, text };
  };
  // 真进程入口先核配置再监听。
  await until(async () => (await getJson('/api/session')).response.ok, { timeoutMs: 20000, label: 'server.js 监听' });
  return { child, base, getJson, context };
}

// 发一条 syslog → 等这条研判跑完 → 返回记录详情（done / failed 都停，交给调用方判）。
async function runOneSyslog({ getJson, context }, targetPort) {
  const before = new Set(((await getJson('/api/agent/triage/cases')).json?.cases ?? []).map(item => item.alert_id));
  const status = (await getJson('/api/agent/triage/status')).json;
  const bind = status?.syslog?.bind ?? '';
  const syslogPort = Number(new URL(bind.replace('udp://', 'http://')).port);
  assert.ok(Number.isInteger(syslogPort) && syslogPort > 0,
    context(`syslog 接收器没有绑上端口：${JSON.stringify(status?.syslog)}`));
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.send(syslogLine(targetPort), syslogPort, '127.0.0.1', error => { socket.close(); error ? reject(error) : resolve(); });
  });
  return until(async () => {
    const list = (await getJson('/api/agent/triage/cases')).json;
    const fresh = (list?.cases ?? []).map(item => item.alert_id).filter(id => !before.has(id));
    if (fresh.length !== 1) return null;
    const detail = (await getJson(`/api/agent/triage/${encodeURIComponent(fresh[0])}`)).json;
    return detail && ['done', 'failed'].includes(detail.status) ? detail : null;
  }, { timeoutMs: 40000, label: '研判记录跑完' });
}

// ================================================================================================
// A2（shipped 装配）：启动时 LLM_REVIEW_* 接进复核那一轮，研判上游一次复核提示词都收不到
// ================================================================================================
test('A2（shipped 装配）spawn 真 server.js：独立复核那一轮打到复核组上游，研判上游 0 次复核提示词',
  { timeout: 90000 }, async t => {
    const cloudwalker = await fakeCloudwalker(t);
    const primary = await modelUpstream(t, 'primary', DRAFT, 'main-key-abcdef');
    const review = await modelUpstream(t, 'review', REVIEW_REPLY, 'review-key-abcdef');
    const server = await startShippedServer(t, {
      cloudwalkerBase: cloudwalker.base, primaryBase: primary.base, reviewBase: review.base
    });
    const { getJson, context } = server;

    // 1. 装配面自证：GET /api/config 报复核组是自有组（own），不是回退主判。
    const config = (await getJson('/api/config')).json;
    assert.deepEqual(config?.model?.roles?.review, { model: 'review-model', source: 'own' },
      context('shipped 装配应把 LLM_REVIEW_* 解析成复核组的自有实例'));

    // 2. syslog 进来（真 UDP）→ 匹配牧云事件 → 研判队列真跑一次研判。
    const record = await runOneSyslog(server, 2222);
    assert.equal(record.status, 'done',
      context(`研判应跑完（failed 说明链路没走到复核轮）：${JSON.stringify({ stage: record.stage, detail: record.detail, failure: record.failure })}`));

    // 3. 核心断言一：复核那一轮恰一次，落在复核组端点，带复核组的模型名与密钥。
    const reviewCalls = review.reviewCalls();
    assert.equal(reviewCalls.length, 1,
      context(`独立复核应恰问复核组上游一次，实测 ${reviewCalls.length} 次（复核端点总请求 ${review.seen.length}）`));
    assert.equal(reviewCalls[0].body?.model, 'review-model', context('复核请求必须带复核组的模型名'));
    assert.equal(reviewCalls[0].auth, 'Bearer review-key-abcdef', context('复核请求必须带复核组的密钥'));
    assert.deepEqual(reviewCalls[0].body?.tools ?? [], [], context('复核那一轮按契约不传工具（investigation-agent.md §3.3）'));

    // 4. 核心断言二：研判端点一次复核提示词都不能收到（第 6 参接回研判实例这里就红）。
    assert.equal(primary.reviewCalls().length, 0,
      context(`复核提示词打到了研判上游 ${primary.reviewCalls().length} 次——装配线把复核接到研判实例上了`));
    assert.ok(primary.seen.length > 0, context('研判端点应收到过研判调用（否则这一轮根本没跑）'));

    // 5. 核心断言三：复核结论进了产品落盘物（result.json 的 review 段来自复核实例的回复）。
    const resultPath = path.join(record.case_dir ?? '', 'result.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.deepEqual(result.review, REVIEW_REPLY,
      context(`案卷 result.json 的 review 段应等于复核实例给出的解析结果（review 那个键）：${resultPath}`));
  });

// ================================================================================================
// A5 运行中生效（shipped 装配）：POST /api/config 改复核组三键 → 下一次研判的复核轮打新端点
// ================================================================================================
test('A5（shipped 装配）POST /api/config 改复核组 → 同一进程下一次研判的复核轮打新端点（旧端点 0 次）',
  { timeout: 90000 }, async t => {
    const cloudwalker = await fakeCloudwalker(t);
    const primary = await modelUpstream(t, 'primary', DRAFT, 'main-key-abcdef');
    const review = await modelUpstream(t, 'review', REVIEW_REPLY, 'review-key-abcdef');
    const swapped = await modelUpstream(t, 'swapped', REVIEW_REPLY, 'swapped-key-abcdef');
    const server = await startShippedServer(t, {
      cloudwalkerBase: cloudwalker.base, primaryBase: primary.base, reviewBase: review.base
    });
    const { base, getJson, context } = server;

    // 先跑一轮：复核落在起初那组端点上。
    const first = await runOneSyslog(server, 2222);
    assert.equal(first.status, 'done', context(`第一轮研判应跑完：${JSON.stringify({ stage: first.stage, failure: first.failure })}`));
    assert.equal(review.reviewCalls().length, 1, context('第一轮复核应打起初的复核组端点'));

    // 运行中改复核组三键（§3.6 可写键、改完立刻生效）。
    const write = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        LLM_REVIEW_BASE_URL: swapped.base,
        LLM_REVIEW_API_KEY: 'swapped-key-abcdef',
        LLM_REVIEW_MODEL: 'swapped-review-model'
      }),
      signal: AbortSignal.timeout(5000)
    });
    const written = await write.text();
    assert.equal(write.status, 200, context(`写复核组三键应 200，实测 ${write.status}：${written}`));
    const afterWrite = (await getJson('/api/config')).json;
    assert.deepEqual(afterWrite?.model?.roles?.review, { model: 'swapped-review-model', source: 'own' },
      context('写后 GET /api/config 的 roles.review 应立刻换成新组的模型名'));

    // 再跑一轮（换 target_port：指纹含它，所以是新记录）：复核必须打新端点，旧端点一次都不能再收。
    const reviewBefore = review.seen.length;
    const second = await runOneSyslog(server, 2299);
    assert.equal(second.status, 'done', context(`第二轮研判应跑完：${JSON.stringify({ stage: second.stage, failure: second.failure })}`));
    const swappedCalls = swapped.reviewCalls();
    assert.equal(swappedCalls.length, 1,
      context(`写配置后复核应恰问新端点一次，实测 ${swappedCalls.length} 次（新端点总请求 ${swapped.seen.length}）`));
    assert.equal(swappedCalls[0].body?.model, 'swapped-review-model', context('复核请求必须带新组的模型名'));
    assert.equal(swappedCalls[0].auth, 'Bearer swapped-key-abcdef', context('复核请求必须带新组的密钥'));
    assert.equal(review.seen.length, reviewBefore,
      context('写配置后旧复核端点不该再收到任何请求（进程内实例没换值这里就红）'));
    assert.equal(primary.reviewCalls().length, 0, context('复核提示词不该落到研判端点'));
  });
