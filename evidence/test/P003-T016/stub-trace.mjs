// P003-T016 测试方桩后端 · trace 部分（列表 + 白板）。
// 形状逐字照 openapi.yaml 的 TraceBoardSummary / TraceBoard / TraceBoardHop / TraceBoardLink /
// TraceBoardGap / TraceBoardDiscovery（openapi.yaml:1695-1815）。不是真后端：本机没有牧云/模型凭据。
// 由 stub-api.mjs import；控制面仍走父进程的 /__ctl（mode 对象共享）。

const LONG_HOST = "10.0.0.5.node-with-a-very-long-hostname.intranet.example.corp.internal";
const LONG_LABEL =
  "反弹 shell 外联 192.0.2.2:4444，父进程是 /usr/sbin/sshd -D，祖父进程是 systemd，再往上就查不到启动命令了";
const LONG_GAP =
  "HIDS 上只保留 7 天进程谱系，9 月 30 日之前的父进程已过期；牧云也查不到更早的启动命令——这一跳到此为止，再往回只能靠人工问运维。";

const ALERT = {
  id: "revshell:1",
  type: "revshell",
  title: "反弹 shell 外联",
  host: "10.0.0.5",
  occurred_at: "2026-11-17T10:00:00.000Z",
};

const REVSHELL_HOPS = [
  {
    id: "h1",
    kind: "alert",
    label: "反弹 shell 外联 192.0.2.2:4444",
    host: "10.0.0.5",
    occurred_at: "2026-11-17T10:00:00.000Z",
    evidence_id: "syslog:1",
    discovered: 1,
  },
  {
    id: "h2",
    kind: "host",
    label: "同一主机 09:41 出现 SSH 登录失败",
    host: "10.0.0.5",
    occurred_at: "2026-11-17T09:41:12.000Z",
    evidence_id: "ev:host:1",
    discovered: 2,
  },
  {
    id: "h3",
    kind: "process",
    label: "sshd 子进程 /bin/bash -i",
    host: "10.0.0.5",
    occurred_at: "2026-11-17T09:58:03.000Z",
    evidence_id: "ev:proc:1",
    discovered: 3,
  },
  {
    id: "h4",
    kind: "file",
    label: "/tmp/.x 落地脚本",
    host: "10.0.0.5",
    occurred_at: "2026-11-17T09:52:40.000Z",
    evidence_id: null,
    discovered: 4,
  },
];

const REVSHELL_LINKS = [
  { id: "l1", from: "h1", to: "h2", rel: "同一主机", evidence_id: "ev:link:1" },
  { id: "l2", from: "h2", to: "h3", rel: "进程谱系", evidence_id: "ev:link:2" },
  { id: "l3", from: "h3", to: "h4", rel: "读写", evidence_id: "ev:link:3" },
];

// 7 步：hop / link / hop / link / hop / link / hop —— 第 5 步时 3 个点 2 条线
const REVSHELL_DISCOVERY = [
  { step: 1, kind: "hop", id: "h1" },
  { step: 2, kind: "link", id: "l1" },
  { step: 3, kind: "hop", id: "h2" },
  { step: 4, kind: "link", id: "l2" },
  { step: 5, kind: "hop", id: "h3" },
  { step: 6, kind: "link", id: "l3" },
  { step: 7, kind: "hop", id: "h4" },
];

export const REVSHELL = {
  id: "revshell:1",
  alert_id: "revshell:1",
  title: "反弹 shell 外联",
  seed: "h1",
  run_id: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  created_at: "2026-11-17T10:00:05.000Z",
  updated_at: "2026-11-17T10:03:10.000Z",
  status: "done",
  alert: ALERT,
  hops: REVSHELL_HOPS,
  links: REVSHELL_LINKS,
  discovery: REVSHELL_DISCOVERY,
  chain_length: 4,
  has_gaps: true,
  summary: "",
  gaps: [{ hop_id: "h4", reason: LONG_GAP }],
  investigations: 4,
  model: "stub",
};

// 进行中：第一次 GET 2 跳 1 线，5s 后那一次 GET 变 3 跳 2 线（验「往左长」）
function runningBoard(target) {
  return {
    id: target,
    alert_id: target,
    title: "蜜罐 SSH 探测",
    seed: "r1",
    run_id: "8c7d6e5f-4a3b-2c1d-0e9f-8a7b6c5d4e3f",
    created_at: "2026-11-17T11:00:00.000Z",
    updated_at: "2026-11-17T11:00:10.000Z",
    status: "running",
    alert: { id: target, type: "honeypot", title: "蜜罐 SSH 探测", host: "10.0.0.9", occurred_at: "2026-11-17T11:00:00.000Z" },
    hops: [
      {
        id: "r1",
        kind: "alert",
        label: "蜜罐 SSH 探测",
        host: "10.0.0.9",
        occurred_at: "2026-11-17T11:00:00.000Z",
        evidence_id: "syslog:2",
        discovered: 1,
      },
      {
        id: "r2",
        kind: "host",
        label: "同一主机 5 分钟内 37 次登录失败",
        host: "10.0.0.9",
        occurred_at: "2026-11-17T10:55:00.000Z",
        evidence_id: "ev:host:2",
        discovered: 2,
      },
    ],
    links: [{ id: "rl1", from: "r1", to: "r2", rel: "同一主机", evidence_id: "ev:link:4" }],
    discovery: [
      { step: 1, kind: "hop", id: "r1" },
      { step: 2, kind: "link", id: "rl1" },
      { step: 3, kind: "hop", id: "r2" },
    ],
    chain_length: 2,
    has_gaps: false,
    summary: "",
    gaps: [],
    investigations: 2,
    model: "stub",
  };
}

function grownRunningBoard(target) {
  const b = runningBoard(target);
  b.hops.push({
    id: "r3",
    kind: "process",
    label: "sshd 拒绝来自 192.0.2.9 的密码登录",
    host: "10.0.0.9",
    occurred_at: "2026-11-17T10:50:30.000Z",
    evidence_id: "ev:proc:2",
    discovered: 3,
  });
  b.links.push({ id: "rl2", from: "r2", to: "r3", rel: "进程谱系", evidence_id: "ev:link:5" });
  b.discovery.push({ step: 4, kind: "link", id: "rl2" }, { step: 5, kind: "hop", id: "r3" });
  b.chain_length = 3;
  b.updated_at = "2026-11-17T11:00:15.000Z";
  return b;
}

const SYSLOG_ALERT_ID = "syslog:revshell:a1b2c3d4e5f60718:1763373600:aaa1";

let polls = 0;
const CREATED = {};

const BOARDS = () => ({
  "revshell:1": REVSHELL,
  [SYSLOG_ALERT_ID]: { ...REVSHELL, id: SYSLOG_ALERT_ID, alert_id: SYSLOG_ALERT_ID, alert: { ...ALERT, id: SYSLOG_ALERT_ID, title: "反弹 shell 外联（告警入口）" } },
  "long:1": {
    ...REVSHELL,
    id: "long:1",
    alert_id: "long:1",
    title: "超长内容白板",
    alert: { ...ALERT, id: "long:1", host: LONG_HOST, title: LONG_LABEL },
    hops: REVSHELL_HOPS.map((h) => ({ ...h, label: `${h.label} · ${LONG_LABEL}`, host: LONG_HOST })),
    gaps: [{ hop_id: "h4", reason: LONG_GAP }],
  },
  "failed:1": {
    ...REVSHELL,
    id: "failed:1",
    alert_id: "failed:1",
    status: "failed",
    summary: "牧云接口限流，任务停在第 4 跳",
  },
  "interrupted:1": {
    ...REVSHELL,
    id: "interrupted:1",
    alert_id: "interrupted:1",
    status: "interrupted",
    hops: REVSHELL_HOPS.slice(0, 2),
    links: REVSHELL_LINKS.slice(0, 1),
    discovery: REVSHELL_DISCOVERY.slice(0, 3),
    chain_length: 2,
    has_gaps: false,
    gaps: [],
    summary: "进程序号变了，读到 running 但任务不在跑，已标成中断",
  },
  "empty:1": {
    ...REVSHELL,
    id: "empty:1",
    alert_id: "empty:1",
    status: "done",
    hops: [],
    links: [],
    discovery: [],
    chain_length: 0,
    has_gaps: false,
    gaps: [],
  },
  "empty-running:1": {
    ...runningBoard("empty-running:1"),
    hops: [],
    links: [],
    discovery: [],
    chain_length: 0,
  },
  "honeypot:2": runningBoard("honeypot:2"),
});

const summaries = (boards) =>
  Object.values(boards).map((b) => ({
    id: b.id,
    alert_id: b.alert_id,
    title: b.alert?.title ?? b.title ?? "",
    type: b.alert?.type ?? null,
    host: b.alert?.host ?? null,
    occurred_at: b.alert?.occurred_at ?? null,
    status: b.status,
    chain_length: b.chain_length,
    has_gaps: b.has_gaps,
    created_at: b.created_at,
    updated_at: b.updated_at,
  }));

function filterSummaries(rows, q) {
  let out = rows;
  if (q.status) {
    const want = String(q.status).split(",");
    out = out.filter((r) => want.includes(r.status));
  }
  if (q.type) out = out.filter((r) => r.type === q.type);
  if (q.host) out = out.filter((r) => r.host === q.host);
  const ts = (v) => {
    if (!v) return null;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  };
  if (q.from) out = out.filter((r) => ts(r.occurred_at) !== null && ts(r.occurred_at) >= ts(q.from));
  if (q.to) out = out.filter((r) => ts(r.occurred_at) !== null && ts(r.occurred_at) <= ts(q.to));
  out = [...out].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return out;
}

export async function handleTrace({ req, res, path, url, json, readBody, mode }) {
  if (!path.startsWith("/api/trace/boards")) return false;

  // ---- 列表 ----
  if (path === "/api/trace/boards" && req.method === "GET") {
    if (mode.traceList === "503") return json(res, 503, { error: "桩后端注入：白板服务没有配置" }), true;
    if (mode.traceList === "401") {
      res.writeHead(401, { "www-authenticate": 'Basic realm="hids"', "content-type": "text/plain; charset=utf-8" });
      res.end("需要登录后访问");
      return true;
    }
    const q = Object.fromEntries(url.searchParams);
    const boards = BOARDS();
    const rows = mode.traceList === "empty" ? [] : filterSummaries(summaries(boards), q);
    const offset = Number(q.offset ?? 0);
    const count = Number(q.count ?? 20);
    return json(res, 200, { boards: rows.slice(offset, offset + count), total: rows.length }), true;
  }

  // ---- 新建（打开或创建）----
  if (path === "/api/trace/boards" && req.method === "POST") {
    const body = await readBody(req);
    const target = String(body.target ?? body.alert_id ?? body.ip ?? "");
    if (mode.traceBoard === "fail") return json(res, 503, { error: "桩后端注入：模型没配置，起不了白板" }), true;
    if (mode.traceBoard === "422") return json(res, 422, { error: "这条告警没有可用资产，不假装有白板" }), true;
    const boards = BOARDS();
    if (boards[target]) return json(res, 200, boards[target]), true;
    const created = {
      // 新建的白板：进行中、还没有跳（真后端 202 那一下链是空的，跳会随轮询长出来）
      ...runningBoard(target || "unnamed:0"),
      hops: [],
      links: [],
      discovery: [],
      chain_length: 0,
      has_gaps: false,
      gaps: [],
    };
    CREATED[target] = created; // 真后端会落盘；桩也存住，免得页面随后的轮询 GET 404 抖动
    return json(res, 202, created), true;
  }

  // ---- 详情 ----
  const one = path.match(/^\/api\/trace\/boards\/(.+)$/);
  if (one && req.method === "GET") {
    const target = decodeURIComponent(one[1]);
    if (mode.traceBoard === "fail") return json(res, 503, { error: "桩后端注入：模型没配置，读不到白板" }), true;
    if (mode.traceBoard === "500") return json(res, 200, { nope: true }), true; // 形状不对（invalid）
    const boards = BOARDS();
    if (target === "honeypot:2") {
      polls += 1;
      return json(res, 200, polls >= 2 ? grownRunningBoard(target) : boards[target]), true;
    }
    const found = boards[target] ?? CREATED[target];
    if (!found) return json(res, 404, { error: "还没有这条白板" }), true;
    if (mode.traceBoard === "empty" && found.status !== "running")
      return json(res, 200, { ...found, hops: [], links: [], discovery: [], chain_length: 0, has_gaps: false, gaps: [] }), true;
    return json(res, 200, found), true;
  }

  return json(res, 404, { error: `桩后端没有这条路：${path}` }), true;
}
