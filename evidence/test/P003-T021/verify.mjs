// P003-T021 后端验收探针（黑盒）——只走文档承诺的公开面：
//   HTTP：POST /api/wiki/sessions/{id}/messages、GET /api/wiki/sessions/{id}、
//         POST /api/agent/triage/{alertId}/false-positive、GET /api/agent/triage/{alertId}
//   类：  WikiStore / WikiWorkbench（docs/modules/knowledge-base.md §3 列出的公开方法）
// 不读实现文件：会话/页面都从磁盘上的公开产物核对。
// 跑法：TREE=<worktree 绝对路径> node evidence/test/P003-T021/verify.mjs
// 退出码：0 = 全绿；1 = 有断言 FAIL；2 = 看门狗/装配失败。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';

const TREE = process.env.TREE || process.cwd();
const TOKEN = 't021-probe-token';
const HDR = { 'content-type': 'application/json', 'x-prompt-admin-token': TOKEN };
const ALERT = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
const RAW = '<134>1 2026-11-18T03:00:00Z host app 1 cloudwalker-honeypot [meta host_ip="172.20.208.23" source_ip="64.177.57.21"]';
const PAGE = '---\nid: HP-10\ntitle: 蜜罐背景扫描\nstatus: active\nsource: 现场记录\n---\n\n外网背景扫描需要核对请求。\n';
const DRAFT = '---\nid: HP-10\ntitle: 蜜罐背景扫描\napplies_to: [honeypot]\nstatus: active\nupdated: 2026-11-25\nsource: 现场记录\n---\n\n单次根路径请求不能直接证明入侵；需要核对授权和后续行为。';

const { createServer } = await import(`${TREE}/server.js`);
const { WikiStore } = await import(`${TREE}/wiki-store.js`);
const { WikiWorkbench } = await import(`${TREE}/wiki-workbench.js`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const L = s => s.length;

const rows = [];
let fails = 0;
function ok(name, detail = '') { rows.push(['PASS', name, detail]); }
function bad(name, err) { fails += 1; rows.push(['FAIL', name, String(err && err.message || err)]); }
async function check(name, fn) {
  try { const detail = await fn(); ok(name, detail == null ? '' : String(detail)); }
  catch (e) { bad(name, e); }
}

const watchdog = setTimeout(() => { console.error('WATCHDOG: 探针超时 150s'); process.exit(2); }, 150_000);
watchdog.unref();

// ---------- 夹具：临时判据库 + 真 WikiStore/WikiWorkbench + 假模型 ----------
async function makeFixture(model) {
  const root = await mkdtemp(path.join(tmpdir(), 't021-probe-'));
  const dir = path.join(root, 'wiki');
  await Promise.all(['common', 'honeypot', '_evidence'].map(n => mkdir(path.join(dir, n), { recursive: true })));
  await writeFile(path.join(dir, 'index.md'), '# 入口\n');
  await writeFile(path.join(dir, '_schema.md'), '# 先有证据再改判据\n');
  await writeFile(path.join(dir, 'log.md'), '# 日志\n');
  await writeFile(path.join(dir, 'honeypot', 'HP-10.md'), PAGE);
  const caseDir = path.join(root, 'case');
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, '01-原始告警.txt'), RAW);
  await writeFile(path.join(caseDir, '03-研判事实.md'), '# 事实\n仅有一次根路径请求');
  const wiki = new WikiStore(dir);
  const fake = { calls: 0, async complete() { this.calls += 1; const o = await model(this.calls); return { content: typeof o === 'string' ? o : JSON.stringify(o) }; } };
  const workbench = new WikiWorkbench(wiki, fake, { load: async () => ({ prompts: { knowledge: '整理 Wiki' } }) }, path.join(root, 'sessions'));
  return { root, dir, wiki, workbench, model: fake, caseDir, pagePath: path.join(dir, 'honeypot', 'HP-10.md') };
}

function feedbackOf(caseDir) {
  return { case_id: 'CASE-T021', case_dir: caseDir, event_type: 'honeypot', expected_verdict: 'false_positive', reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' };
}

async function serve(f, argsOverride = null) {
  const args = new Array(16).fill(null);
  args[9] = TOKEN; args[10] = f.wiki; args[11] = f.workbench;
  if (argsOverride) Object.assign(args, argsOverride);
  const server = createServer(...args);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  f.server = server;
  return f;
}

async function http1(f, method, url, { body, headers = HDR, raw = null } = {}) {
  const payload = raw != null ? raw : (body !== undefined ? JSON.stringify(body) : null);
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: f.server.address().port, path: url, method, agent: false,
      headers: { ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json, type: res.headers['content-type'] || '' });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

const postMsg = (f, id, body, opt = {}) => http1(f, 'POST', `/api/wiki/sessions/${id}/messages`, { body, ...opt });
const getSession = (f, id) => http1(f, 'GET', `/api/wiki/sessions/${id}`);

const out = [];
const say = line => out.push(line);

try {
  // ===== S1 交互会话（无 feedback）：200 + 记录，页不动 =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'needs_info', ready: false, reply: '证据还不够，先补请求日志', rationale: '材料不足' }));
    await serve(f);
    const s = await f.workbench.create('honeypot/HP-10.md');
    const before = sha(await readFile(f.pagePath, 'utf8'));
    const r = await postMsg(f, s.id, { content: '补充：客户提供了完整请求记录' });
    await check('S1 无 feedback 会话本轮未成形 -> 200（docs knowledge-base §3 末句）', () => {
      assert.equal(r.status, 200, `实测 ${r.status} ${r.text.slice(0, 160)}`);
      assert.ok(r.type.includes('application/json'), `content-type=${r.type}`);
      assert.equal(typeof r.json.id, 'string', 'body.id 应为 string');
      assert.equal(r.json.status, 'collecting', `status=${r.json.status}`);
      assert.ok(Array.isArray(r.json.messages), 'body.messages 应为数组');
      assert.equal(r.json.proposal, null, `proposal=${JSON.stringify(r.json.proposal)}`);
      return `200 status=collecting messages=${r.json.messages.length}`;
    });
    const g = await getSession(f, s.id);
    await check('S1 会话落盘：GET 200 且用户原话在 messages 里、页未改', async () => {
      assert.equal(g.status, 200);
      const msgs = g.json.messages || [];
      assert.ok(msgs.some(m => m.role === 'user' && m.content.includes('完整请求记录')), '用户消息未落盘');
      assert.equal(sha(await readFile(f.pagePath, 'utf8')), before, '页不应被改');
      return `messages=${msgs.length}`;
    });
    f.server.close();
  }

  // ===== S2 三条失败路径：502 正文 =====
  const failureCases = [
    {
      label: 'S2a', key: 'data_gap',
      model: () => ({ diagnosis: 'data_gap', ready: true, reply: '缺少完整请求记录，应先补齐案件数据。', rationale: '判据本身未发现错误' }),
      needles: ['知识库维护未改判据', 'data_gap·数据缺口', '判据本身未发现错误'],
      followUpInBody: true,
      diagnosis: 'data_gap',
      expectFollowUp: true,
      expectStatus: 'needs_non_wiki_fix',
    },
    {
      label: 'S2b', key: 'criterion_gap 无草案',
      model: () => ({ diagnosis: 'criterion_gap', ready: false, reply: '需要补一条授权核对判据', rationale: '判据需要补充授权核对' }),
      needles: ['知识库维护未改判据', 'criterion_gap', '判据需要补充授权核对'],
      followUpInBody: true, // docs/modules/http-api.md:174-175 与 openapi.yaml:830-833 无条件承诺
      diagnosis: 'criterion_gap',
      expectFollowUp: false,
      expectStatus: 'collecting',
    },
    {
      label: 'S2c', key: '模型输出非 JSON',
      model: () => '这不是 JSON，是散文',
      needles: ['知识维护模型未返回合法 JSON，本轮无法整理'],
      followUpInBody: true,
      diagnosis: null,
    },
  ];
  for (const c of failureCases) {
    const f = await makeFixture(c.model);
    await serve(f);
    const s = await f.workbench.create('honeypot/HP-10.md', feedbackOf(f.caseDir));
    const before = sha(await readFile(f.pagePath, 'utf8'));
    const r = await postMsg(f, s.id, { content: '这条是误报，请改判据' });
    const g = await getSession(f, s.id);
    await check(`${c.label} ${c.key} 反馈回合没写成 -> 502 + 诊断/rationale 正文、≤300 字`, () => {
      assert.equal(r.status, 502, `实测 ${r.status} ${r.text.slice(0, 160)}`);
      assert.equal(typeof r.json?.error, 'string', `502 体应是 {error:string}，实测 ${r.text.slice(0, 120)}`);
      assert.ok(L(r.json.error) <= 300, `正文 ${L(r.json.error)} 字 > 300`);
      for (const n of c.needles) assert.ok(r.json.error.includes(n), `正文缺「${n}」：${r.json.error}`);
      assert.ok(!r.json.error.includes('needs_non_wiki_fix'), '正文仍是裸状态词');
      return `${r.status} ${L(r.json.error)} 字：${r.json.error}`;
    });
    // 文档口径核对（不计入硬断言）：docs/modules/http-api.md:174-175 与 openapi.yaml:830-833
    // 无条件写「诊断 + rationale 摘录 + 后续责任方」，knowledge-base.md:95-98 只对 data_gap 举例。
    const errText = r.json?.error || '';
    const hasFollow = errText.includes('后续由「');
    if (c.followUpInBody && !hasFollow) {
      say(`DOC-DELTA ${c.label} ${c.key}：正文无后续责任方（docs/modules/http-api.md:174-175、openapi.yaml:830-833 无条件承诺）：${errText}`);
    } else {
      ok(`${c.label} ${c.key} 正文带后续责任方`, hasFollow ? '含「后续由「…」处置」' : '按 knowledge-base.md:95-98 口径无后续方也合规');
    }
    await check(`${c.label} ${c.key} 失败后会话仍落盘（原始输入/诊断/后续方）且页未改`, async () => {
      assert.equal(g.status, 200);
      const rec = g.json;
      const msgs = rec.messages || [];
      assert.ok(msgs.some(m => m.role === 'user' && m.content.includes('这条是误报')), '原始输入未落盘');
      assert.ok(msgs.some(m => m.role === 'assistant' && m.content.length > 0), '没有助手消息');
      if (c.diagnosis) {
        assert.equal(rec.diagnosis, c.diagnosis, `diagnosis=${rec.diagnosis}`);
        if (c.expectFollowUp) assert.ok(rec.follow_up, 'follow_up 缺失');
        if (c.expectStatus) assert.equal(rec.status, c.expectStatus, `status=${rec.status}`);
      }
      assert.equal(sha(await readFile(f.pagePath, 'utf8')), before, '页被改了');
      return `session.status=${rec.status} diagnosis=${rec.diagnosis} messages=${msgs.length}`;
    });
    f.server.close();
  }

  // ===== S2d 超长 rationale：正文仍 ≤300 =====
  {
    const long = '甲'.repeat(1000);
    const f = await makeFixture(() => ({ diagnosis: 'data_gap', ready: true, reply: '补齐数据', rationale: long }));
    await serve(f);
    const s = await f.workbench.create('honeypot/HP-10.md', feedbackOf(f.caseDir));
    const r = await postMsg(f, s.id, { content: '这条是误报' });
    await check('S2d 1000 字 rationale -> 正文 ≤300 字', () => {
      assert.equal(r.status, 502, `实测 ${r.status}`);
      const err = r.json?.error || '';
      assert.ok(L(err) <= 300, `正文 ${L(err)} 字 > 300`);
      return `${r.status} ${L(err)} 字（尾部：${err.slice(-24)}）`;
    });
    f.server.close();
  }

  // ===== S2e 未知诊断值：不崩溃、正文合法（spec 未枚举，记录行为） =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'bogus_gap', ready: false, reply: '随便', rationale: '理由' }));
    await serve(f);
    const s = await f.workbench.create('honeypot/HP-10.md', feedbackOf(f.caseDir));
    const r = await postMsg(f, s.id, { content: '这条是误报' });
    await check('S2e 未知诊断值 -> 502/200 均可，但正文非空、≤300、不含 undefined', () => {
      assert.ok([200, 502].includes(r.status), `实测 ${r.status} ${r.text.slice(0, 120)}`);
      if (r.status === 502) {
        const err = r.json?.error || '';
        assert.ok(err.length > 0 && err.length <= 300, `正文 ${err.length} 字`);
        assert.ok(!err.includes('undefined'), `正文含 undefined：${err}`);
        return `502 ${err.length} 字：${err}`;
      }
      return '200（本轮视为未成形但无 feedback 失败语义）';
    });
    f.server.close();
  }

  // ===== S3 400 边界矩阵 =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'needs_info', ready: false, reply: '追问', rationale: 'x' }));
    await serve(f);
    const s = await f.workbench.create('honeypot/HP-10.md');
    const matrix = [
      ['S3a 缺 content', s.id, { body: {} }],
      ['S3b content 非字符串(number)', s.id, { body: { content: 123 } }],
      ['S3c content 空串', s.id, { body: { content: '' } }],
      ['S3d content 4001 字', s.id, { body: { content: 'a'.repeat(4001) } }],
      ['S3e content 含空字符', s.id, { body: { content: 'abc\u0000def' } }],
      ['S3f 正文不是 JSON', s.id, { raw: '{bad json' }],
    ];
    for (const [label, id, opt] of matrix) {
      const r = await postMsg(f, id, opt.body, opt.raw != null ? { raw: opt.raw } : {});
      await check(`${label} -> 400 + {error}`, () => {
        assert.equal(r.status, 400, `实测 ${r.status} ${r.text.slice(0, 160)}`);
        assert.equal(typeof r.json?.error, 'string', `体不是 {error:string}：${r.text.slice(0, 120)}`);
        assert.ok(r.json.error.length > 0, 'error 为空');
        return `400 ${r.json.error}`;
      });
    }
    await check('S3g 会话 ID 非 UUID -> 404 知识库接口不存在（openapi SessionId format: uuid，路径不匹配）', async () => {
      const r = await postMsg(f, 'not-a-uuid', { content: '材料' });
      assert.equal(r.status, 404, `实测 ${r.status} ${r.text.slice(0, 160)}`);
      assert.equal(typeof r.json?.error, 'string');
      return `404 ${r.json.error}`;
    });
    await check('S3h 类级 WikiWorkbench.file(非 UUID) -> 400（docs knowledge-base §3 file 行）', () => {
      let caught = null;
      try { f.workbench.file('abc'); } catch (e) { caught = e; }
      assert.ok(caught, '未抛错');
      assert.equal(caught.status, 400, `status=${caught.status}`);
      return `400 ${caught.message}`;
    });
    f.server.close();
  }

  // ===== S4 会话不存在：404（openapi 未列，记录实测） =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'needs_info', ready: false, reply: '追问', rationale: 'x' }));
    await serve(f);
    const missing = '11111111-2222-3333-4444-555555555555';
    const r = await postMsg(f, missing, { content: '材料' });
    await check('S4 不存在的会话 -> 404 且 {error:string}（记录实际档位，openapi 未列 404）', () => {
      assert.equal(r.status, 404, `实测 ${r.status} ${r.text.slice(0, 160)}`);
      assert.equal(typeof r.json?.error, 'string', `体不是 {error:string}：${r.text.slice(0, 120)}`);
      return `404 ${r.json.error}`;
    });
    f.server.close();
  }

  // ===== S5 并发重入 -> 409（独立 socket，避开客户端连接复用） =====
  {
    const f = await makeFixture(async () => { await sleep(500); return { diagnosis: 'needs_info', ready: false, reply: '追问', rationale: 'x' }; });
    await serve(f);
    const s = await f.workbench.create('honeypot/HP-10.md');
    const p1 = postMsg(f, s.id, { content: '第一轮材料' });
    await sleep(120);
    const r2 = await postMsg(f, s.id, { content: '第二轮材料' });
    const r1 = await p1;
    await check('S5 上一轮未完时重入 -> 409 + {error}（docs knowledge-base §4.2 第 2 步）', () => {
      assert.equal(r2.status, 409, `实测 ${r2.status} ${r2.text.slice(0, 160)}`);
      assert.equal(typeof r2.json?.error, 'string', `体不是 {error:string}：${r2.text.slice(0, 120)}`);
      assert.equal(r1.status, 200, `第一轮 ${r1.status} ${r1.text.slice(0, 120)}`);
      return `第二轮 409 "${r2.json.error}"，第一轮后来 ${r1.status}`;
    });
    f.server.close();
  }

  // ===== S8 create(page, feedback) 的字段边界（docs knowledge-base.md:244-247） =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'needs_info', ready: false, reply: '追问', rationale: 'x' }));
    const good = feedbackOf(f.caseDir);
    const cases = [
      ['S8a 缺 case_id', { ...good, case_id: undefined }],
      ['S8b expected_verdict 非法枚举', { ...good, expected_verdict: 'definitely_attack' }],
      ['S8c reason 9 字', { ...good, reason: '九个字九个字九个字' }],
      ['S8d who 1 字', { ...good, who: '值' }],
    ];
    for (const [label, fb] of cases) {
      await check(`${label} -> 400（create 的 feedback 校验）`, async () => {
        let caught = null;
        try { await f.workbench.create('honeypot/HP-10.md', fb); } catch (e) { caught = e; }
        assert.ok(caught, '未抛错');
        assert.equal(caught.status, 400, `status=${caught.status} ${caught.message}`);
        return `400 ${caught.message}`;
      });
    }
  }

  // ===== S6 端到端：误报入口 data_gap -> 失败带原因、结论不动、页未改 =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'data_gap', ready: true, reply: '缺少完整请求记录，应先补齐案件数据。', rationale: '判据本身未发现错误' }));
    const record = {
      alert_id: ALERT, status: 'done', stage: '研判完成', verdict: 'threat', verdict_label: '真实威胁', decision_source: 'ai',
      case_dir: f.caseDir, steps: [], evidence: [], updated_at: '2026-11-18T03:00:00.000Z',
      input: { raw: RAW, parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-18T03:00:00Z', payload: { host_ip: '172.20.208.23', source_ip: '64.177.57.21' } } },
    };
    const monitor = {
      records: new Map([[ALERT, record]]), persisted: 0,
      status(id) { const r = this.records.get(id); if (!r) return null; const { input, ...visible } = r; return { ...visible, steps: [], evidence: [] }; },
      async persist() { this.persisted += 1; },
    };
    const ruleMaintainer = { maintain: async () => { throw new Error('规则维护不在本探针范围'); } };
    await serve(f, { 5: monitor, 15: ruleMaintainer });
    const before = sha(await readFile(f.pagePath, 'utf8'));
    const r = await http1(f, 'POST', `/api/agent/triage/${encodeURIComponent(ALERT)}/false-positive`, { body: { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' } });
    await check('S6 登记误报 -> 202 且 {alert_id, verdict, feedback, maintenance}（http-api §3.4 表）', () => {
      assert.equal(r.status, 202, `实测 ${r.status} ${r.text.slice(0, 160)}`);
      for (const k of ['alert_id', 'verdict', 'feedback', 'maintenance']) assert.ok(k in r.json, `202 体缺 ${k}`);
      assert.equal(r.json.verdict.verdict, 'false_positive', `verdict=${r.json.verdict.verdict}`);
      assert.equal(r.json.feedback.reason, '运维的蜜罐探针，不是攻击');
      return `202 ${r.json.verdict.verdict} maintenance=${r.json.maintenance.status}`;
    });
    const deadline = Date.now() + 8000;
    while (monitor.records.get(ALERT).maintenance.status === 'updating' && Date.now() < deadline) await sleep(20);
    const rec = monitor.records.get(ALERT);
    await check('S6 data_gap 收尾：wiki=failed 且 error 是完整原因（诊断+rationale+后续方，≤300）', () => {
      assert.ok(rec.maintenance.status !== 'updating', '维护 8s 内未收尾');
      assert.equal(rec.maintenance.wiki.status, 'failed', `wiki.status=${rec.maintenance.wiki.status}`);
      const err = rec.maintenance.wiki.error || '';
      assert.ok(err.includes('知识库维护未改判据'), `error=${err}`);
      assert.ok(err.includes('data_gap·数据缺口'), `error=${err}`);
      assert.ok(err.includes('判据本身未发现错误'), `error=${err}`);
      assert.ok(err.includes('后续由「'), `error=${err}`);
      assert.ok(L(err) <= 300, `error ${L(err)} 字 > 300`);
      assert.ok(!err.includes('needs_non_wiki_fix'), 'error 仍是裸状态词');
      return `${rec.maintenance.status} ${L(err)} 字：${err}`;
    });
    await check('S6 误报结论与理由一字不动、判据页未改（A3）', async () => {
      assert.equal(rec.verdict, 'false_positive', `verdict=${rec.verdict}`);
      assert.equal(rec.verdict_label, '误报');
      assert.equal(rec.decision_source, 'human');
      assert.equal(rec.feedback.reason, '运维的蜜罐探针，不是攻击');
      assert.equal(sha(await readFile(f.pagePath, 'utf8')), before, '判据页被改了');
      return `verdict=${rec.verdict} decision_source=${rec.decision_source} page sha 未变`;
    });
    const g = await http1(f, 'GET', `/api/agent/triage/${encodeURIComponent(ALERT)}`, { headers: {} });
    await check('S6 GET 案件能读到同一组维护字段（http-api §3.4 末段）', () => {
      assert.equal(g.status, 200, `实测 ${g.status}`);
      assert.equal(g.json.verdict, 'false_positive', `GET.verdict=${g.json.verdict}`);
      assert.equal(g.json.maintenance.wiki.status, 'failed');
      assert.ok(String(g.json.maintenance.wiki.error).includes('知识库维护未改判据'));
      return `GET maintenance.wiki.status=${g.json.maintenance.wiki.status}`;
    });
    f.server.close();
  }

  // ===== S7 端到端：误报入口 criterion_gap -> 页真写上、结论不动 =====
  {
    const f = await makeFixture(() => ({ diagnosis: 'criterion_gap', ready: true, reply: '已形成待审核草案', rationale: '仅有探测，需核对授权', proposed_content: DRAFT }));
    const record = {
      alert_id: ALERT, status: 'done', stage: '研判完成', verdict: 'threat', verdict_label: '真实威胁', decision_source: 'ai',
      case_dir: f.caseDir, steps: [], evidence: [], updated_at: '2026-11-18T03:00:00.000Z',
      input: { raw: RAW, parsed: { msgid: 'cloudwalker-honeypot', ts: '2026-11-18T03:00:00Z', payload: { host_ip: '172.20.208.23', source_ip: '64.177.57.21' } } },
    };
    const monitor = {
      records: new Map([[ALERT, record]]), persisted: 0,
      status(id) { const r = this.records.get(id); if (!r) return null; const { input, ...visible } = r; return { ...visible, steps: [], evidence: [] }; },
      async persist() { this.persisted += 1; },
    };
    const ruleMaintainer = { maintain: async () => { throw new Error('规则维护不在本探针范围'); } };
    await serve(f, { 5: monitor, 15: ruleMaintainer });
    const r = await http1(f, 'POST', `/api/agent/triage/${encodeURIComponent(ALERT)}/false-positive`, { body: { reason: '运维的蜜罐探针，不是攻击', who: '值班分析员' } });
    const deadline = Date.now() + 8000;
    while (monitor.records.get(ALERT).maintenance.status === 'updating' && Date.now() < deadline) await sleep(20);
    const rec = monitor.records.get(ALERT);
    const pageNow = await readFile(f.pagePath, 'utf8');
    await check('S7 criterion_gap 收尾：wiki=updated、判据页真写上（A1 第一支）', () => {
      assert.equal(r.status, 202, `登记 ${r.status}`);
      assert.ok(rec.maintenance.status !== 'updating', '维护 8s 内未收尾');
      assert.equal(rec.maintenance.wiki.status, 'updated', `wiki.status=${rec.maintenance.wiki.status} error=${rec.maintenance.wiki.error}`);
      assert.ok(pageNow.includes('需要核对授权和后续行为'), '判据页没写上新内容');
      return 'wiki=updated page 有草案正文';
    });
    await check('S7 误报结论不动（A3 第二支）', () => {
      assert.equal(rec.verdict, 'false_positive', `verdict=${rec.verdict}`);
      assert.equal(rec.decision_source, 'human');
      assert.equal(rec.feedback.reason, '运维的蜜罐探针，不是攻击');
      return `verdict=${rec.verdict} 理由保留`;
    });
    f.server.close();
  }
} catch (e) {
  fails += 1;
  rows.push(['FAIL', '探针装配/执行异常', String(e && e.stack || e)]);
}

clearTimeout(watchdog);
const summary = `PASS ${rows.filter(r => r[0] === 'PASS').length} / FAIL ${rows.filter(r => r[0] === 'FAIL').length}`;
for (const [s, n, d] of rows) console.log(`${s} | ${n}${d ? ' | ' + d : ''}`);
console.log('---- 明细 ----');
for (const line of out) console.log(line);
console.log(summary);
process.exit(fails ? 1 : 0);
