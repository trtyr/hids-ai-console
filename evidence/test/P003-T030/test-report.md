# P003-T030 测试报告（tester 面：契约 + 真取数链路）

- 任务卡：P003-T030「现查告警能送研判：按牧云事件 ID 入队的后端路径」
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T030`
- HEAD：`3fa8c13`（代码零改动，本卡交付 = 写者 6 条单测 + openapi/http-api.md 契约文字；本报告不改产品文件）
- 审查判词：`verdicts/P003-T030-gc-backend-code-review-mwo2213e.json`（pass，四条锚点已由审查实证）
- 本报告只记**我自己终端跑出来的东西**；转录别人的门禁不算数，所以下面每条都带命令与退出码。

## 环境标注（别把替身读成真牧云）

| 标注 | 含义 |
| --- | --- |
| **真进程内 server** | `createServer(...)` 起在 127.0.0.1 动态端口，走真实路由、真实鉴权（password=null，`§4` 的放行口径） |
| **替身 investigator / 替身 service** | 契约套件用假研判器；`service`（牧云网关）任何方法被调即抛 |
| **替身牧云端点** | 真取数套件在 127.0.0.1 起 `/rpc`（JSON-RPC 只读方法）与 `/api/mcp`（initialize / tools/list / tools/call），形状照 `docs/modules/event-gateway.md` §16 命令 6/7、`docs/modules/evidence-tools.md` §9.1；**不是真牧云** |
| **替身模型** | 按 `docs/modules/investigation-agent.md` §5.5 写法回三态 JSON 的假 `complete()`；**不是真模型** |

本机没有 `CLOUDWALKER_URL` / `CLOUDWALKER_API_TOKEN`，也没有模型凭据——真牧云、真模型**一条都没连过**（与写者自报一致）。

## 复跑

```bash
bash evidence/test/P003-T030/run-all.sh        # 三段串跑 + openapi 解析，退出码 0 = 全绿
node --test evidence/test/P003-T030/live-alert-to-triage.test.js   # 写者的 6 条（本报告亲跑复验）
node --test evidence/test/P003-T030/triage-http-contract.test.js   # tester 契约面 9 条
node --test evidence/test/P003-T030/triage-real-fetch.test.js      # tester 真取数链 5 条
```

**实测（2026-11-19 21:2x，本树）**：

```
bash evidence/test/P003-T030/run-all.sh
  live-alert-to-triage.test.js : tests 6 / pass 6 / fail 0 / exit=0
  triage-http-contract.test.js : tests 9 / pass 9 / fail 0 / exit=0
  triage-real-fetch.test.js    : tests 5 / pass 5 / fail 0 / exit=0
  openapi.yaml yaml ok, paths = 47 / exit=0
  all exit=0                → run-all-exit=0
```

## 一、四条验收锚点的复验（我的证据）

| 锚点 | 卡上要求 | 复验怎么做的 | 结论 |
| --- | --- | --- | --- |
| A1 | 现查事件 ID 入队 → 按 ID 研判 → done 落记录 | 写者测试 1 亲跑绿；**再加真链路 R1**：POST `webshell:9001` → 真 `InvestigationAgent` → 真 `RpcClient`/`ApiEvidenceToolbox` → 替身 `/rpc` 上恰好一次 `WebshellEventService.GetEvent {"id":9001}`（Cookie `API-Token=abcdef`）→ 记录 `status=done`、`verdict=uncertain`、`result_alert_id=webshell:9001`、证据里有 `get_webshell_event` 且 `sha256` 是 64 位十六进制、`fetched_at` 可解析；记录无 `syslog`/`case_dir` 键 | 成立 |
| A2 | 三档重复入队的语义 | 写者测试 2/3/4 亲跑绿；我的契约套件另钉了可观测面：排队中重复 POST 后 `queue.depth` 仍 1（写者已断言）；done 后人工重试 `attempts 1→2`、`created_at` 沿用、**第二轮真取数再发一次 GetEvent**（R2：实测 2 次，印证 `triage-pipeline.md` §5.6 A2「缓存粒度是一次 run()」）；队列满 429 文案与 `summary().dropped`（C6） | 成立 |
| A3 | 假数据走替身，不真连牧云 | 写者测试 1/5 亲跑绿（`service.calls` 全空、`toolboxCalls` 全空）；我的契约套件全程 `service` 被调即抛；真取数套件只连 127.0.0.1 替身端点，`service`（牧云网关）零调用 | 成立 |
| A4 | openapi 与 http-api.md 同步，验收有可重放测试 | 写者测试 6 亲跑绿；**变异验红亲手复现**（见下） | 成立 |

### A4 变异验红（我自己跑的两刀，不是引用）

```
# 第一刀：删掉 POST 条目块里唯一的锚词「重复入队语义」
sed -i 's/重复入队语义/重X入队语义/' openapi.yaml
grep -c "重复入队语义" openapi.yaml          # 0
node --test evidence/test/P003-T030/live-alert-to-triage.test.js
  → pass 5 / fail 1，**唯一红的是 A4**，退出码 1（mutated-run-exit=1）

# 还原
git checkout -- openapi.yaml
diff -q openapi.yaml /tmp/openapi.t030.bak   # restored-identical
node --test evidence/test/P003-T030/live-alert-to-triage.test.js
  → pass 6 / fail 0，退出码 0（restored-run-exit=0）
git status --short                            # 只剩本报告与两条 tester 测试文件（未跟踪）
```

守卫不是永真：锚词一杀，恰 A4 红；还原即复绿，树净。

## 二、我新增的两条套件（覆盖什么）

### `triage-http-contract.test.js`（9 条）——按 `docs/modules/http-api.md` §3.1/§3.3/§3.4/§3.9 + `openapi.yaml` 造请求

| 用例 | 覆盖 |
| --- | --- |
| C1 | **schema 符合性**：POST 202 + `TriageCase`（required `alert_id`/`status`，`status` 五值枚举，`attempts` 整数，`evidence` 数组）；GET 单条 200；GET `status` 200 且 `TriageSummary` 13 个 required 键 + `counts`/`verdict_counts`/`queue`/`retry`/`paused`/`archived`/`persist` 子键逐条断言；GET `cases` 200 `{total, cases}`；PUT `control` 200 且 `enabled` 随回包翻转 |
| C2 | **边界**：路径 ID 的解析失败 vs 校验失败两种文案（编码无效 / 无效）、未知类型、0 号、小数、空序号、超 `MAX_SAFE_INTEGER`、合法 syslog 形态（200 `not_queued`） |
| C3 | §3.9「现查记录不进 cases」：done 之后 `GET /cases` 仍 `total=0`，单条可见且无 `syslog`/`case_dir` |
| C4 | 取消：200 恰三键（`additionalProperties: false`）、done 后 409、不存在 404 |
| C5 | 误报登记错误面：短理由/超长理由/短登记人/非对象正文 400、无此案件 404、未完成 409、done 后 202 且 `FalsePositiveRecord` 四段形状（`verdict{verdict,verdict_label,source}` / `feedback{reason,who,recorded_at}` / `maintenance{status,rule,wiki}`）逐条断言；「先结论后维护」：回包后单条查询立刻是 `false_positive` + `decision_source=human` |
| C5b | **闭区间边界**：理由恰 10 字、恰 4000 字、登记人恰 2 字 → 都收下（202），防 off-by-one |
| C6 | 队列满：429 + 文档原话「研判队列已满（上限 1），稍后再试」+ `code=caller_error`，`summary().dropped=1`、被拒那条不建记录 |
| C7 | **错误码面**：没装配研判队列时七条 triage 路由全 503 + `Error{error,code}`，`code=not_configured` |
| C8 | `GET /cases` 筛选与分页边界：非法 `verdict`/`type`/`count`/`offset`/`from>to` 一律 400 且文案对得上；合法组合 200 |

### `triage-real-fetch.test.js`（5 条）——真取数链路（写者用替身绕开、归 tester 的那一面）

本地 127.0.0.1 起替身牧云（`/rpc` + `/api/mcp`），链路全用真类：`RpcClient` → `ApiEvidenceToolbox` →（`CloudwalkerMcpClient` → `AgentToolbox`）→ `TriageEvidenceToolbox` → `InvestigationAgent` → `TriageMonitor` → HTTP server。

| 用例 | 覆盖 |
| --- | --- |
| R1 | 真取数 happy：一次 GetEvent、参数 `{id:9001}`、API-Token Cookie、记录 done、证据 tool/sha256/fetched_at、记录无 syslog 键、不进 cases |
| R2 | 人工重试（done→再 POST）：`attempts 1→2`、`created_at` 沿用、第二轮再取一次详情（缓存不跨 run） |
| R3 | **目录校验**：MCP 目录缺 `get_webshell_event` → agent 抛「牧云 MCP 缺少 get_webshell_event」（`investigation-agent.md` §2.1 第 3 条），经队列时记录 `failed` + `failure.reason` 含该句、`failure.at` 是时间、`attempts=1`，且 `/rpc` 一条详情请求都没发 |
| R4 | 真 MCP 链路错误面（`evidence-tools.md` §9.1）：JSON-RPC 错误「牧云 MCP -32601: 没有这个工具」、串号「牧云 MCP 响应身份不匹配」、非 JSON「牧云 MCP 未返回 JSON 响应」、非牧云 serverInfo「MCP 服务不是牧云」 |
| R5 | 真 /rpc 错误面（`event-gateway.md` §5/§12、`evidence-tools.md` §4.2/R-EVID-07）：白名单外方法「RPC 方法未列入只读白名单」且请求没发出、详情 ID 不符、非法 ID「事件详情需要有效 ID」、常规研判不提供 `whitelist_add_ip`、HTTP 500「牧云 /rpc HTTP 500」、JSON-RPC error「牧云 /rpc -32603: boom」、非 JSON「牧云 /rpc 返回 HTTP 502，响应不是 JSON」 |

## 三、门禁亲跑（全部我自己终端，退出码照录）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 卡内单测 | `node --test evidence/test/P003-T030/live-alert-to-triage.test.js` | `tests 6 / pass 6 / fail 0`，退出码 0（161ms；变异与还原两轮见 §一） |
| 契约套件 | `node --test evidence/test/P003-T030/triage-http-contract.test.js` | `tests 9 / pass 9 / fail 0`，退出码 0（243ms） |
| 真取数套件 | `node --test evidence/test/P003-T030/triage-real-fetch.test.js` | `tests 5 / pass 5 / fail 0`，退出码 0（215ms） |
| 三段串跑 | `bash evidence/test/P003-T030/run-all.sh` | `all exit=0`，退出码 0 |
| 整仓 | `timeout 300 npm test` | `tests 228 / pass 228 / fail 0`，退出码 0（749ms） |
| 契约可解析 | `python3 -c "import yaml; yaml.safe_load(open('openapi.yaml'))"` | 退出码 0，`paths = 47` |
| 树净 | `git status --short` | 只有本报告 + 两条 tester 测试文件 + run-all.sh（全部未跟踪；产品文件零改动） |

**没有固定 sleep**：等状态一律用带超时上界的 `until()`；每个外部命令带 `timeout`；server / 替身端点 / monitor 全在 `t.after` 回收，跑完 `pgrep -af "node --test"` 无残留。

## 四、发现（D 类分诊：spec 与实测）

### F1（doc-side，minor）openapi 的 `{alertId}` 有三条 operation 缺 503（GET / POST / DELETE）

- **文档出处**：`docs/modules/http-api.md:117` 起的 §3.1 路由表——`GET /api/agent/triage/{alertId}`、`POST`、`DELETE` 三行的「失败」列都写明「无研判队列回 503」；`openapi.yaml:749` 起这三个 operation 的 `responses`。
- **文档说**：没装配研判队列时这三条都回 503。
- **实测**：`C7` 七条 triage 路由（含 GET/POST/DELETE）全 503 `{"error":"自动研判尚未配置","code":"not_configured"}`。而 `openapi.yaml` 里 **GET 只有 `200`/`400`（:756-762）、POST 只有 `202`/`400`/`404`/`429`（:781-789）、DELETE 只有 `200`/`400`/`404`/`409`（:798-813），三条都没有 `503`**；`/status`（`:540`）、`/cases`（`:548`）、`/control`（`:748`）、`/false-positive`（`:865`）四条都挂了这个响应。
- **复现**：`node --test evidence/test/P003-T030/triage-http-contract.test.js`（C7）；`sed -n '749,813p' openapi.yaml | grep -c "'503'"` → 0。
- **严重度**：minor（既有缺口，非本卡引入）；顺带纠正审查判词 issue 2 的表述——它说「同路径 GET 在 `:748` 挂了 ServiceUnavailable」，与文件不符：`:748` 属 `/api/agent/triage/control`（该 path 从 `:722` 起），`{alertId}` 的 GET 从 `:752` 才开始，里面没有 503。缺口不是「POST 缺一条」，而是**GET / POST / DELETE 三条都缺**。
- **怎么改才过**：上述三个 operation 的 `responses` 各补一行 `'503': { $ref: '#/components/responses/ServiceUnavailable' }`（与 `/control`、`/false-positive` 同款）。

**除此之外没有发现实现与文档不符的地方**：本卡主链路（A1–A4）、重复入队三档、取消/误报/队列满/503 各错误面、真取数链路的取数次数与错误文案，全部按文档口径通过。

## 五、未覆盖 / 残余风险（没查清就写没查清）

1. **真牧云没连过**：`CLOUDWALKER_URL` / `CLOUDWALKER_API_TOKEN` 本机没有，真取数链路的端点仍是 127.0.0.1 替身。替代证据是：R1 证明客户端在真 HTTP 上发的报文形状（method/params/Cookie）与文档一致；但**真牧云的实际响应字段是否与替身同形，未验**（`docs/_meta/gaps.md:86` 登记过同一件事）。
2. **真模型没连过**：研判结论由替身 `complete()` 给出，所以「模型给的结论质量」不在本报告结论范围内；本报告只证明链路把结论落进了记录。
3. **误报后的两个维护者**：只断言了 202 回包里的 `maintenance` 三态形状与「先结论后维护」；两个维护者真正的改规则/改 wiki 行为归 P003-T013 面，本卡没验（本树没配模型，维护者是 `failed`）。
4. **并发与时序**：重复入队三档都在单条记录上验；并发 N 条同时入队只有写者测试 2（concurrency=0）与我的 C6（队满）覆盖到，未做压测。
5. **审查判词的另外三条 minor（行号 531→525、438-459→480、recon checklist 半句）**：属写作文档问题，我不复核也不修（测试不改产品文件与文档），由机器回注给写者。
