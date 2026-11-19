# HTTP API 模块（http-api）

业务 HTTP 接口的唯一入口。本页讲 `server.js` 这一个文件：它怎么把请求分发到各条路由、怎么判身份、怎么校验入参、怎么把结果封装成响应。

- 模块清单条目：[docs/modules/_breakdown.json](_breakdown.json) 里的 `http-api`
- 全局背景（进程入口、分层依赖、访问边界）：[docs/architecture.md](../architecture.md)
- 行号基准：本页的 `文件:行号` 指向 `server.js` 共 496 行的版本（commit `63f1379`）。改了代码要重新核。P003-T013 新增的误报入口一行与第 3.4 节按本卡提交时的 `server.js` 标号（808 行，见 [evidence/recon/P003-T013.md](../../evidence/recon/P003-T013.md)），其余锚点仍指向 496 行版本。
- 证据清单：本页每条断言的出处与验证方式见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md)；P003-T006 新增的分页与身份断言见 [evidence/recon/P003-T006.md](../../evidence/recon/P003-T006.md)；P003-T014 改动的三条溯源路由（列表筛选、`POST` 200/202/422/502、详情形状）见 [evidence/recon/P003-T014.md](../../evidence/recon/P003-T014.md)，这三行行号按 P003-T014 复审提交

## 1. 模块职责与边界

**职责**：`server.js` 只做 HTTP 层的四件事——分发路由、判身份、校验入参、把结果封装成响应。业务逻辑不在这个文件里：研判在 `investigation-agent.js`，规则在 `triage-rules.js`，研判队列在 `triage-monitor.js`，判据库在 `wiki-store.js`。本页只讲 HTTP 这一层。

**关键路径**：`server.js:275` 是全部 HTTP 逻辑的入口——一个 `http.createServer` 回调；认证闸门在 `server.js:276`，未捕获异常的出口在 `server.js:549-551`。

**覆盖构件**（拆卡清单里的 `components` 字段，本页逐块对应）：

| 构件 | 在哪一节 |
| --- | --- |
| 路由分发 | [第 3 节](#3-路由分发) |
| Basic 认证 | [第 4 节](#4-basic-认证) |
| 管理员令牌校验 | [第 5 节](#5-管理员令牌校验) |
| SSE 流式响应 | [第 6 节](#6-sse-流式响应) |
| 分页参数校验 | [第 7 节](#7-分页参数校验) |

**普通响应有三种形状**，别混着读（SSE 是第四种，见第 6 节）：

- **JSON 对象**：`json()` 写 `Content-Type: application/json; charset=utf-8`，并附 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`（`server.js:332-335`）。
- **JSON 错误**：`callerError` / `configError` / `upstreamError` / `causeError` 把失败包成 `{ "error": "...", "code": "<四类之一>" }` 后走同一个 `json()`（`server.js:339-383`，口径见 §8.3）。
- **纯文本 401**：认证失败时的正文是「需要登录后访问」，`Content-Type` 是 `text/plain; charset=utf-8`（**不是** `application/json`），并带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`（`server.js:392-399`）。

**两个没有使用点的参数**：`createServer` 收了 `knowledge`（`server.js:257`）与 `maintenanceEntry`（`server.js:260`），但整个 `server.js` 里再没有第二处提到它们——`grep -n "knowledge\|maintenanceEntry" server.js` 只命中这两行。本页不描述它们的行为，因为没有行为可描述。

## 2. 启动与依赖装配

**关键路径**：`server.js:26` 到 `server.js:54` 是模块级装配（运行态路径取 `server.js:27` 的 `runtime`），`server.js:257-261` 是 `createServer` 的签名，`server.js:555-562` 是进程入口。

模块被加载时就建好的东西：

| 件 | 位置 | 缺配置时的结果 |
| --- | --- | --- |
| 运行态目录 `runtime`（9 条路径） | `server.js:27`、`server.js:876-889` | 不依赖环境变量，恒为仓内 `.data/` 下 |
| 监听地址与端口 | `server.js:28-29` | `HIDS_HOST` 缺省 `127.0.0.1`，`HIDS_PORT` 缺省 `8080` |
| 牧云网关 `gateway` 与 API 工具箱 `apiToolbox` | `server.js:30-34` | 牧云地址或 Token 缺一个 → 两者为 `null` |
| 模型 `model` 与两个研判器 | `server.js:35-40` | `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 缺任一项 → `model` 为 `null`，两个研判器也是 `null` |
| 研判记录、规则集、研判队列、判据工作台、溯源白板 | `server.js:41-54`、`server.js:95-97` | 队列要 `gateway` 与研判器、白板要 MCP 工具箱与模型，缺任一则该件为 `null` |

运行态路径的默认值全出自导出的 `runtimePaths(directory = moduleDirectory)`（`server.js:876-889`，单测直接拿它对照）：`data` / `investigations` / `triageRules` / `triageMonitor` / `cases` / `baseline` / `intel` / `wikiSessions` / `traceBoards`，全部落在仓内 `.data/` 下。整仓规则的完整说明在 [architecture.md](../architecture.md) 第 8.1 节。

**`createServer` 是依赖注入点**（`server.js:257-261`）：14 个参数都带默认值，默认指向模块级单例。测试与探针靠传替身换掉 `service`、`investigator`、`history`、`monitor`、`wiki`、`wikiAgent` 这些件。其中 `monitor` 与 `boardService` 的默认值写成「`service` 是不是模块级 `gateway`」的条件式——换了 `service`，就不再挂默认的研判队列与溯源白板。

**规则预筛挂在 `investigate()` 闭包上**（`server.js:262-273`）：`mode === 'triage'` 且 `monitor.ruleEngine` 存在时，先跑一次规则评估，把结果作为 `rule_evaluation` 挂到结论上；评估抛错就记成 `{ status: 'error' }` 继续往下走，不中断研判。

**进程入口**（`server.js:555-562`）：`process.argv[1]` 的真实路径等于本文件路径时才启动监听，并打印 `HIDS API: http://<host>:<port>`；随后若输入模式是 `syslog`，再起一个 UDP 接收器。

## 3. 路由分发

**关键路径**：`server.js:275`（处理函数）、`server.js:277`（路径解析）、`server.js:279` 到 `server.js:546`（依次排列的分支）、`server.js:547-548`（404 兜底）。

**分发机制**：没有路由表，是一条 `if` 链。每一支的形状都是「路径条件 + 方法条件」，命中即 `return`，后面的分支不再看。因此**分支顺序决定谁先赢**：`GET /api/agent/triage/status`（`server.js:333-334`）排在 `GET /api/agent/triage/{alertId}`（`server.js:378-385`）前面，所以 `status` 这个词不会被当成告警 ID。

路径与查询串由 `new URL(req.url, 'http://' + (req.headers.host || 'localhost'))` 解析（`server.js:277`），后面的判断都用 `url.pathname` 与 `url.searchParams`。

### 3.1 路由表

35 条「路径 + 方法」组合：「前置条件」写的是这条路由在缺件时的表现；「出处」是该分支所在的行。

> 比历史版本多的四条：P003-T011 的三条 Rego 规则路由（`/api/rules`、`/api/rules/evaluate`、`/api/rules/{id}`）与本卡 P003-T013 的误报入口。
> `grep -n "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js` 数的是**分支条件行数**（当前 35 行），不是组合数：一行可以给出多条组合（`server.js:704` 的 `/api/agent/triage/{alertId}` 给 GET 与 POST 两条），也有行不算组合（`server.js:718` 只是 `/api/wiki/` 分组入口）。数之前先分清这两种。

| 方法 | 路径 | 成功状态 | 前置条件 | 出处 |
| --- | --- | --- | --- | --- |
| GET | `/api/session` | 200 `{authenticated:true, user, role}` | — | `server.js:208-214` |
| GET | `/api/updates` | 200 升级包概览 | — | `server.js:215` |
| GET | `/api/status` | 200 / 502 | 未配牧云回 200（`configured:false`）；配了但连不上回 502，正文仍是 `{configured, connected:false, reason}` | `server.js:216-220` |
| GET | `/api/agent/tools` | 200 工具清单 | 无 API 工具箱回 503 | `server.js:221-225` |
| GET | `/api/trace/tools` | 200 工具清单 | 无 MCP 工具箱回 503 | `server.js:226-230` |
| GET | `/api/agent/status` | 200 | — | `server.js:231-236` |
| GET | `/api/trace/boards` | 200 白板列表（`{boards, total}`，接 `count`／`offset` 与 `status`／`type`／`host`／`from`／`to`；`total` 是筛选后、切页前总数） | 无白板服务回 503；分页或筛选参数不合法回 400 | `server.js:328-336` |
| POST | `/api/trace/boards` | 200（已有白板，原样返回）/ 202（新建） | 无白板服务回 503；目标不合法回 400；告警起不了板回 422；建板过程出错回 502 | `server.js:338-352` |
| GET | `/api/trace/boards/{target}` | 200（`hops`／`links`／`gaps`／`discovery` 为详情主数据）/ 404 | 无白板服务回 503；目标格式不合法回 400 | `server.js:353-361` |
| GET | `/api/agent/triage/status` | 200 | 无研判队列回 503 | `server.js:262-264` |
| GET | `/api/triage/rules` | 200 | 读取失败回 502 | `server.js:265-269` |
| POST | `/api/triage/rules/validate` | 200 `{valid:true,count}` | 正文不是对象 / 缺 `config` 键回 400「请求正文缺少 config」；`config` 不是合法规则集回 400「规则集格式无效」 | `server.js:270-279` |
| PUT | `/api/triage/rules` | 200 | 需规则管理员令牌 | `server.js:280-291` |
| GET | `/api/rules` | 200 `{count, rules}`（Rego 规则库） | 规则库读取失败回 502 | `server.js:559-562` |
| POST | `/api/rules/evaluate` | 200 `{count, matched}` | 正文不是对象回 400；求值失败回 502 | `server.js:563-569` |
| GET | `/api/rules/{id}` | 200 / 404 | id 不合格式回 400；规则库读取失败回 502 | `server.js:570-578` |
| GET | `/api/agent/triage/cases` | 200 | 无研判队列回 503 | `server.js:292-299` |
| PUT | `/api/agent/triage/control` | 200 | 无研判队列回 503 | `server.js:300-306` |
| GET | `/api/agent/triage/{alertId}` | 200 | 无研判队列回 503 | `server.js:307-315` |
| POST | `/api/agent/triage/{alertId}` | 202 | 无研判队列回 503 | `server.js:633-641` |
| POST | `/api/agent/triage/{alertId}/false-positive` | 202（结论已落盘为误报，两个维护者开始） | 无研判队列回 503；理由不符格式回 400；无此案件回 404；研判未完成回 409 | `server.js:597-632` |
| GET | `/api/agent/prompts` | 200 | — | `server.js:316-318` |
| GET | `/api/wiki/pages` | 200 `{pages, total}`，接 `count`／`offset` | 分页参数不合法回 400 | `server.js:322-334` |
| GET | `/api/wiki/pages/{path}` | 200 / 404 | — | `server.js:340-343` |
| GET | `/api/wiki/health` | 200 | 需知识库管理员令牌 | `server.js:355` |
| GET | `/api/wiki/sessions` | 200 | 需知识库管理员令牌 | `server.js:356` |
| POST | `/api/wiki/sessions` | 201 | 需知识库管理员令牌 | `server.js:683-699` |
| GET | `/api/wiki/sessions/{id}` | 200 / 404 | 需知识库管理员令牌 | `server.js:702-705` |
| POST | `/api/wiki/sessions/{id}/messages` | 200 / 502 | 需知识库管理员令牌；带 `feedback` 的会话没产出可发布草案时 502，正文写为什么没改 | `server.js:706-709` |
| POST | `/api/wiki/sessions/{id}/replay` | 200 | 需知识库管理员令牌 | `server.js:711-714` |
| POST | `/api/wiki/sessions/{id}/publish` | 200 | 需知识库管理员令牌 | `server.js:715-719` |
| POST | `/api/agent/investigations` | 200 | 无研判器回 503 | `server.js:406-430` |
| GET | `/api/agent/investigations/{alertId}` | 200 / 404 | — | `server.js:431-439` |
| GET | `/api/alerts` | 200 | 无牧云服务回 503 | `server.js:440-454` |
| GET | `/api/alerts/{type}:{id}` | 200 | 无牧云服务回 503 | `server.js:456-475` |

### 3.2 不是路由的固定响应

三条路径不查后端，直接回固定结果：

| 条件 | 状态 | 正文 | 出处 |
| --- | --- | --- | --- |
| `/api/agent/prompts` 用了非 GET 方法 | 405 | 请使用提示词文件上传入口 | `server.js:319` |
| `/api/agent/prompts/upload` | 410 | 提示词更新已迁移到独立维护端，业务端不允许上传 | `server.js:316-320` |
| `/api/` 开头的未知路径 | 404 | 接口不存在 | `server.js:793-794` |

405 在整个文件里只有这一处（`grep -n "405" server.js` 只命中 `server.js:319`）。**方法对不上的路径，除这一处外都落到 404**：`POST /api/session` 与 `POST /api/triage/rules` 都回 404「接口不存在」。非 API 路径（如 `/`）也回同一句 404（`server.js:793-794`）。但 404 有两种文案——`/api/` 下的未知路径回「接口不存在」（`server.js:793-794`），`/api/wiki/` 下的未知路径回「知识库接口不存在」（`server.js:721`）。

### 3.3 路径里的 ID

三段式 ID（类型 + 序号）从路径尾部取出来，解码后要过校验：

| 校验函数 | 接受什么 | 用在哪 | 出处 |
| --- | --- | --- | --- |
| `validAlertId` | `<小写类型>:<正整数>`，类型须在事件类型表里，序号须是安全整数 | `GET /api/agent/investigations/{alertId}`（`mode=deep` 时）、单条告警路由的类型段 | `server.js:102-105` |
| `validTriageId` | `validAlertId`，或 syslog 形态 `syslog:<类型>:<16 位十六进制>:<数字或 unknown>:<36 位 UUID>` | `GET/POST /api/agent/triage/{alertId}`、`POST /api/agent/triage/{alertId}/false-positive`、`GET /api/agent/investigations/{alertId}`（`mode=triage` 时） | `server.js:383` |
| `validTraceTarget` | 告警 ID，或去掉 `ip:` 前缀后的 IPv4（每段 ≤ 255） | 溯源白板三条路由 | `server.js:116-256` |

解码失败与校验失败给的是不同的文案：解码失败回「告警 ID 编码无效」，校验失败回「告警 ID 无效」或「告警 ID 或研判模式无效」。

### 3.4 误报登记与两个维护者（P003-T013）

**关键路径**：`server.js:668-703`（路由）、`:209-250`（两个维护者的编排）、`:145-177`（规则维护者）、`:193-205`（wiki 维护目标）。

**入口**：`POST /api/agent/triage/{alertId}/false-positive`，正文 `{reason, who?}`。「分析员把这一条判成误报」只走这一个入口：
理由必填（10 到 4000 字），登记人省略时取业务账号名，没配 Basic 认证时是 `operator`（登记人至少 2 字）。

**先结论，后维护**（A1）：路由先改记录——`verdict=false_positive`、`verdict_label=误报`、`decision_source=human`、
`feedback{reason,who,recorded_at}`，`await monitor.persist()` 落盘之后才回 202（写结论在 `server.js:689-695`，起维护在 `server.js:697`）。
两个维护者这时才开始跑，响应不等它们；维护还没跑完时 `GET /api/agent/triage/{alertId}` 已经是误报。

| 情况 | 状态 | 正文 |
| --- | --- | --- |
| 结论已落盘，维护开始 / 已在跑 | 202 | `{alert_id, verdict, feedback, maintenance}` |
| 理由短于 10 字或长于 4000、登记人短于 2 字、正文不是对象、ID 编码或格式无效 | 400 | 对应文案 |
| 没有这条研判记录 | 404 | 找不到这条研判案件 |
| 记录 `status !== 'done'`（还在排队或跑着） | 409 | 研判还没结束，不能登记误报 |
| 研判队列未配置 | 503 | 自动研判尚未配置 |

`409` 的边界只在「已完成」上登记。**重跑不覆盖人工结论**（P003-T018）：`POST /api/agent/triage/{alertId}`（`retry:true`）重排一条已登记误报的记录时，
`enqueue()` 把 `verdict` / `verdict_label` / `summary` / `decision_source` / `feedback` 带到新记录上（`triage-monitor.js:219-226`）；
`run()` 收尾看到 `verdict === 'false_positive'` 且 `decision_source === 'human'` 就不写这四件（`triage-monitor.js:452-458`），
报告 / 证据 / 缺证 / 下一步 / `saved_at` 照常按这次研判刷新。**AI 自己判出的 `false_positive` 不算人工登记**，重跑照旧被这次研判覆盖。

**两个维护者都不是跑研判的那个 Agent**（A3）：

| 维护者 | 用什么 | 改什么 | `updated` 的含义 |
| --- | --- | --- | --- |
| 规则维护者 | 模型 + `prompts/rule-maintenance.md`（`prompt-store.js:18` 的 `coreFiles.rule`） | `rules/` 下**一份** `.rego`：改已有的那条，或新增一条 | 那一份文件已写入，并通过 `RuleStore` 解析与整库装载 |
| wiki 维护者 | `WikiWorkbench` + `prompts/knowledge-maintenance.md` | 一页方法论（判据页） | 页面已通过 `publishBundle` 的发布前检查写进去（响应给 `page` / `revision`） |

规则维护者三道校验，全部在写盘之前：临时目录里 `new RuleStore(目录).read(id)`（`server.js:120-128`）拦子集外语法与 id/package 不一致；
**改已有规则时不许放宽原有限制条件**（`server.js:184-193`，判据见下）；写盘后（临时文件 + `rename`）再 `new RuleStore(目录).list()`（`server.js:196-203`）拦重复 id。
过不了就不写，目录里不留临时文件，已有规则一字不动。它一次只碰一个文件：已有规则的 id 住在别的文件名里时，改的就是那份文件（`server.js:242-243`）。

**不许放宽（P003-T020，A1）**：`output.id` 命中已有规则时，那条规则的每一条旧条件都要在候选正文里找到一条「至少同样严」的新条件
（`server.js:133-193`：`ruleExpressions` 抽 `match if { }` 体内的行，`atLeastAsStrict` 逐条比，`widenedConditions` 一对一配对）。认不出的行按「无法证明没放宽」处理，
所以未知语法不是拒绝的理由——候选正文先过 `RuleStore` 解析，认不出的只剩被改过的行，同样算放宽。

| 旧条件 | 候选 | 判定 |
| --- | --- | --- |
| `startswith(input.path, "/tmp/")` | `startswith(input.path, "/tmp")` | **放宽**（新值不以旧值打头）→ 拒绝 |
| `startswith(input.path, "/tmp/")` | `startswith(input.path, "/tmp/shell")` | 收紧（新值以旧值打头）→ 放行 |
| `endswith(input.path, ".jsp")` | `endswith(input.path, ".js")` | **放宽** → 拒绝；`".jsp"` → `"shell.jsp"` 收紧 → 放行 |
| `contains(input.command, "ssh")` | `contains(input.command, "ssh -R")` | 收紧（新值含旧值）→ 放行 |
| `input.host != ""` | 候选里没有这一条 | **放宽**（条件被删）→ 拒绝 |
| `input.host != ""` | `input.host != "10.0.0.1"` | **放宽**（换了字面量，旧限制不再成立）→ 拒绝 |
| `not startswith(input.path, "/usr/")` | `not startswith(input.path, "/usr/local/")` | **放宽**（取反翻方向：针变窄 ⇒ 放行的变多）→ 拒绝 |
| `not startswith(input.path, "/usr/")` | `not startswith(input.path, "/usr")` | 收紧 → 放行 |

拒绝时 `maintain()` 抛 `规则修订放宽了原有限制条件，拒绝落盘：<被放宽的那几行，；分隔，截 200 字>`，调用方按既有失败通道
写进 `maintenance.rule.error`（截 300 字）并把这一边判 `failed`——**规则文件一个字节都不变**，`verdict` / `feedback` 也不动。
新增规则（`output.id` 与现有规则不重名）不走这条：没有原条件可放宽。

**删条件一律算放宽，连「撤销一条已有的 `not`」也算**：校验只看得见盘上的规则正文，分不清一条排除是安全限制还是现场测试留下的，
所以按 fail closed 处理——那类改动得人工改文件（本次 `rules/webshell_drop.rego` 的 `hids-live-test` 排除就是人工撤的）。
代价写在这里免得后面误读：**维护者只能把规则改严，改宽一律拒绝**。

wiki 维护者只改方法论：走已有的知识维护会话（`wikiAgent.create` + 一轮 `reply`），再把草案用 `publishBundle` 写进判据页；
只出草案、页没写上就算 `failed`。选页口径与 `POST /api/wiki/sessions` 共用 `wikiFeedbackTarget`（`server.js:264-276`）：
优先分析时引用过的判据页，其次本场景第一页。审计字段里 `reviewer` 记登记人、`note` 记他给的理由。

「页没写上」不能再是一个光秃秃的状态词（P003-T021）：带 `feedback` 的回合里维护者真没改判据时，`reply` 以 502 抛错，正文就是**为什么没改**——
`知识库维护未改判据（data_gap·数据缺口）：判据本身未发现错误；后续由「Syslog 解析、牧云事件匹配与取证接口」处置`
（诊断、`rationale` 原文、后续责任方，整条 ≤300 字，`wiki-workbench.js:31`）。`settle` 把这条 message 原封写进
`maintenance.wiki.error`，所以运维看到的仍是「为什么没改」而不是「状态 needs_non_wiki_fix」。`needs_non_wiki_fix` 这个会话状态照旧落在
`WikiWorkbench` 的会话记录里（诊断与 `follow_up` 都在），只是这一轮同时算维护失败。

**状态词表只有三个**（A4）：`updating` / `updated` / `failed`，总态与单边态同一套（`server.js:106-109`）：

- 还有一边在跑 → 总态 `updating`；
- 都收尾后，任一边 `failed` → 总态 `failed`；
- 否则 `updated`。

失败只写 `maintenance.rule.error` / `maintenance.wiki.error`（各截 300 字），**`verdict` 与 `feedback` 一个字节都不动**。
维护状态随记录一起 `persist()`，所以 `GET /api/agent/triage/{alertId}` 能读到同一组字段。同一轮维护还在本进程里跑时再次登记只回当前进度，
不重起一轮（`server.js:686`）；挡它的是 `runningMaintenance` 集合（`server.js:530`）——**不是**记录上的 `maintenance.status`：
进程重启后记录会停在 `updating`，拿那个当锁会把案件永久锁死。重启后的残留不挡重新登记，但也不会自动恢复（见本卡报告「未决」）。

## 4. Basic 认证

**关键路径**：`server.js:276`（闸门位置）、`server.js:58-65`（`hasAccess`）、`server.js:66-72`（`requireAccess`）。

**闸门在请求处理函数的第一行**（`server.js:276`），先于 URL 解析与全部路由。认证不通过就直接回 401，不会碰任何路由分支——连 `/api/session` 这种专门问「我是不是已登录」的接口也拿不到。

**开关语义**：`hasAccess()` 的第一行是「没配密码就放行」（`server.js:58-65`）。具体条件是 `access.password` 为空即返回 `true`——`HIDS_BASIC_AUTH_PASSWORD` 没设，或者设成空串，效果一样：接口不校验身份。用户名没配时按 `admin` 比对。

**比较方式**：请求头必须以 `Basic ` 开头，取后面的 Base64 解码成字节，与 `user:password` 的字节做 `timingSafeEqual`。字节长度不等时先判否，不进 `timingSafeEqual`（`server.js:58-65`）。

**会话自报的身份**（`server.js:279-285`）：`GET /api/session` 在 `authenticated` 之外回 `user` 与 `role`。业务侧只有一套 Basic 账号，`role` 固定 `operator`（值守操作员）；管理员权限走维护端令牌那条线，不在这套身份里。配了密码没配用户名时 `user` 落回 `admin`（与 `hasAccess` 的比对口径一致）；没配密码时没有账号可报，`user` 与 `role` 都是 `null`。

**401 的形状与其它错误不同**（`server.js:66-72`）：状态码 401，响应头固定四条——`WWW-Authenticate: Basic realm="HIDS AI Console", charset="UTF-8"`、`Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；正文是纯文本「需要登录后访问」——不是 `{error:...}`，也不是 JSON。探针实测（P003-T006 在当前提交复跑，含 `user` / `role` 与 `Content-Type`）：

```
A1 无凭据 | 401 | www-authenticate="Basic realm=\"HIDS AI Console\", charset=\"UTF-8\"" | content-type=text/plain; charset=utf-8 | body="需要登录后访问"
A2 错密码 | 401 | 需要登录后访问
A3 正确凭据 | 200 | {"authenticated":true,"user":"ops","role":"operator"}
A4 非 Basic 前缀 | 401 | 需要登录后访问
A5 根路径 / | 401 | 需要登录后访问
A6 空密码放行 | 200 | {"authenticated":true,"user":null,"role":null}
```

（完整命令见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第三节的探针脚本。）

这一层只管业务 API 这个进程。维护端是另一个进程，认证方式不同，见 [architecture.md](../architecture.md) 第 9.4 节。

## 5. 管理员令牌校验

**关键路径**：`server.js:73-80`（知识库令牌）、`server.js:81-88`（规则令牌）、`server.js:352-353`（规则侧判定顺序）、`server.js:424-425`（知识库侧判定顺序）。

**两套令牌各管一片**，请求头不同：

| 令牌 | 请求头 | 管谁 | 比较函数 |
| --- | --- | --- | --- |
| `HIDS_PROMPT_ADMIN_TOKEN` | `x-prompt-admin-token` | 知识库（判据页维护、会话、发布、健康检查） | `server.js:73-80` |
| `HIDS_RULE_ADMIN_TOKEN` | `x-rule-admin-token` | 误报规则集写入 | `server.js:81-88` |

两个比较函数的形状一样：令牌没配就返回 `false`；请求头必须是字符串；字节长度相等才走 `timingSafeEqual`。

**判定顺序是三档**，以规则写接口为例（`server.js:352-353`）：

| 情况 | 状态 | 正文 |
| --- | --- | --- |
| 令牌没配 | 503 | 尚未配置规则管理员令牌 |
| 令牌不匹配 | 403 | 规则管理员令牌无效 |
| 令牌匹配 | 进业务分支 | — |

知识库侧同构，只是文案换成「尚未配置知识库管理员凭据」与「知识库管理员凭据无效」（`server.js:424-425`）。

**一个容易看错的后果**：知识库分支里，两个读接口排在令牌判定之前（`server.js:392-425`），所以 `GET /api/wiki/pages` 与 `GET /api/wiki/pages/{path}` 只要过了 Basic 认证就能读，不需要管理员令牌。但也因此，`/api/wiki/` 底下**别的**路径——包括不存在的路径——会先撞上令牌判定：探针里不带令牌请求 `/api/wiki/unknown-path` 得到的是 403「知识库管理员凭据无效」，不是 404。

规则侧的读接口 `GET /api/triage/rules` 不需要令牌，但响应里带一个 `writable` 字段，表示当前能不能写（`server.js:336-339`）。

## 6. SSE 流式响应

**关键路径**：`server.js:477-501`（进入判定）、`server.js:482-495`（流式分支）、`server.js:496-500`（非流式分支）。

**触发条件**：`url.searchParams.get('stream') === '1'`（`server.js:482-495`）——**精确等于字符串 `1`**。`stream=0`、`stream=true` 都拿不到流式响应，会走普通 JSON 分支（探针 D3 实测两个值都回 `application/json`）。

**前置判定排在流式分支之前**（`server.js:477-501`）：请求正文先读出来，正文不是对象回 400「请求正文无效」；没有研判器回 503「该研判模式的模型或牧云取证接口尚未配置」。也就是说 `stream=1` 并不绕过配置检查——没配模型时它回的是 503，不是 SSE（探针 D4）。

**响应头**（`server.js:483-484`）：

| 头 | 值 |
| --- | --- |
| `Content-Type` | `text/event-stream; charset=utf-8` |
| `Cache-Control` | `no-store` |
| `Connection` | `keep-alive` |
| `X-Content-Type-Options` | `nosniff` |

**帧格式**：`data: <JSON>\n\n`（`server.js:485`）。响应已销毁或已结束时不写。帧里的 `type` 有三种：

| type | 内容 | 出处 |
| --- | --- | --- |
| `progress` | `{stage, detail}`，由研判过程的 `onProgress` 回调发出 | `server.js:489-490` |
| `result` | `{result: <history.save() 的返回值>}`——发出去的是落盘之后的对象 | `server.js:491` |
| `error` | `{error: <异常消息>}`；原文过一遍凭据擦除（`Basic …`/`Bearer …`/`token=…` → `[redacted]`），帧里没有 `code` | `server.js:888` |

**心跳**：每 15000 毫秒写一行 `: heartbeat\n\n`（`server.js:486`），这是 SSE 的注释行，客户端按协议忽略它。连接关闭时清掉定时器（`server.js:487`），`finally` 里再清一次并结束响应（`server.js:493`）。

**异常也回 200**：研判过程抛错时，状态码仍是 200，错误以 `error` 帧的形式发给客户端（`server.js:492`）。探针 D2 实测：

```
D2 异常 status=200 body="data: {\"type\":\"error\",\"error\":\"模型服务不可用\"}\n\n"
```

完整的一次流式响应（探针 D1，替身研判器发了两段进度）：

```
D1 status=200 content-type="text/event-stream; charset=utf-8" cache-control="no-store" connection="keep-alive"
D1 原始报文="data: {\"type\":\"progress\",\"stage\":\"查询证据\",\"detail\":\"正在查询 list_host_events\"}\n\ndata: {\"type\":\"progress\",\"stage\":\"独立复核\",\"detail\":\"正在核对结论\"}\n\ndata: {\"type\":\"result\",\"result\":{\"alert_id\":\"revshell:7\",\"mode\":\"deep\",\"verdict\":{\"verdict\":\"undetermined\"},\"saved_at\":\"2026-11-17T00:00:00.000Z\"}}\n\n"
```

**与非流式分支的差别**（`server.js:496-500`）：走的是同一次 `investigate()`，结果用 `json()` 包装。差别在错误处理——非流式分支把消息命中「告警 ID 无效|研判模式无效」的错误映射成 400，其余映射成 502；流式分支没有这层映射，异常一律变成 `error` 帧（状态码仍是 200）。判断「这次研判成功没有」要看帧里的 `type`，不能只看状态码。

## 7. 分页参数校验

**关键路径**：`server.js:365-368`（案件目录）、`server.js:513-515`（告警列表）、`server.js:310-313`（白板列表）、`server.js:395-399`（知识库列表）。

分页参数出现在四条路由上，缺省与边界基本一样，只有知识库列表的 `count` 例外：

| 路由 | 出处 | `count` 缺省 |
| --- | --- | --- |
| `GET /api/agent/triage/cases` | `server.js:365-368` | 20 |
| `GET /api/alerts` | `server.js:513-515` | 20 |
| `GET /api/trace/boards` | `server.js:310-313` | 20 |
| `GET /api/wiki/pages` | `server.js:395-399` | **不切页，返回全部** |

**取值与边界**：

| 参数 | 缺省值 | 合法范围 | 不合法时 |
| --- | --- | --- | --- |
| `count` | 20 | 1 到 50 之间的安全整数 | 400「分页参数无效」 |
| `offset` | 0 | 大于等于 0 的安全整数 | 400「分页参数无效」 |

取值写法是 `Number(url.searchParams.get('count') || 20)`：参数缺省与传空串都落回缺省值；传 `abc` 得到 `NaN`，`isSafeInteger` 判否；传 `20.5` 也不是整数，一样判否。

**知识库列表的例外**（`server.js:393-404`）：`count` 缺省时**不切页**，返回全部页面——控制台知识库页目前一次取全量，改成默认 20 会静默少显示（D002 只加不改）。它用 `rawCount ? Number(rawCount) : null` 区分「没传」与「传了」，`offset` 仍缺省为 0，单独传 `offset` 就等于跳过前 N 条。显式传 `count` 时范围同表（1 到 50），`total` 永远是切页前的条数。

**判定顺序**：先判后端有没有配，再判分页。

- `GET /api/alerts` 先判牧云服务在不在（`server.js:511-525`），没有就回 503，分页参数根本没被读到。
- `GET /api/agent/triage/cases` 先判研判队列在不在（`server.js:363-369`），没有就回 503。
- `GET /api/trace/boards` 先判白板服务在不在（`server.js:308-309`），没有就回 503；`?count=0` 也先吃 503。
- `GET /api/wiki/pages` 没有「服务没配」这一层，分页参数是它唯一的 400 来源。

探针实测（`/api/alerts` 有牧云服务、`/api/agent/triage/cases` 有研判队列时）：

```
C /api/alerts?count=0 | 400 | {"error":"分页参数无效"}
C /api/alerts?count=51 | 400 | {"error":"分页参数无效"}
C /api/alerts?count=abc | 400 | {"error":"分页参数无效"}
C /api/alerts?count=20.5 | 400 | {"error":"分页参数无效"}
C /api/alerts?offset=-1 | 400 | {"error":"分页参数无效"}
C /api/alerts?count=20&offset=0 | 200 | {"alerts":[],"total":0,"totals":{},"errors":{},"partial":false,"echo":{"count":20,"offset":0}}
C /api/alerts?count=50 | 200 | {"alerts":[],"total":0,"totals":{},"errors":{},"partial":false,"echo":{"count":50,"offset":0}}
C /api/alerts | 200 | {"alerts":[],"total":0,"totals":{},"errors":{},"partial":false,"echo":{"count":20,"offset":0}}
C2 /api/alerts?count=0（无 service） | 503 | {"error":"未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN"}
C3 /api/agent/triage/cases?count=0（无 monitor） | 503 | {"error":"自动研判尚未配置"}
```

## 8. 请求正文与错误翻译

**关键路径**：`server.js:415-423`（`readJSON`）、`server.js:945-951`（未捕获异常的出口）、`server.js:339-387`（四类错误落点）。

### 8.1 正文长度上限

`readJSON(req, maxLength = 8192)` 把请求体读成字符串再 `JSON.parse`（`server.js:415-423`）。上限量的是拼接后字符串的长度（`body.length`），不是字节数。两条报错：

| 情况 | 抛出 | 出处 |
| --- | --- | --- |
| 长度超过上限 | 请求正文过大 | `server.js:420` |
| 不是合法 JSON | 请求正文不是 JSON | `server.js:422` |

各路由传进去的上限不一样：

| 上限 | 路由 | 出处 |
| --- | --- | --- |
| 8192（缺省） | `PUT /api/agent/triage/control`、`POST /api/wiki/sessions`、`POST /api/agent/investigations` | `server.js:300-305`、`server.js:355-382`、`server.js:406-430` |
| 100000 | `POST /api/triage/rules/validate`、`PUT /api/triage/rules` | `server.js:270-278`、`server.js:280-290` |
| 12000 | `POST /api/wiki/sessions/{id}/messages`、`POST /api/agent/triage/{alertId}/false-positive` | `server.js:706-709`、`server.js:597-632` |
| 8192（显式传值） | `POST /api/wiki/sessions/{id}/publish` | `server.js:715-719` |

### 8.2 正文形状

`readJSON` 只保证「是合法 JSON」，不保证形状。形状由各路由自己判：不传 `expected_revision` 的规则写请求回 400「缺少有效的规则配置版本」（`server.js:351-361`）；正文不是对象或数组的回 400「请求正文无效」（`server.js:371-376`、`server.js:477-501`）。

### 8.3 错误怎么翻译：四类，一类一个稳定 code（P003-T024）

业务错误体只有一个出口（`server.js:339-383`），形状固定 `{ "error": "<原话>", "code": "<稳定标识>" }`
（契约在 `openapi.yaml` 的 `components/schemas/Error`）。`code` 只有四个值，类 → 状态码是固定对照：

| 类 | 状态码 | `code` | 谁判的 | 正文 `error` 写什么 |
| --- | --- | --- | --- | --- |
| 调用方传错 | 4xx：400 参数/正文、403 权限、404 不存在、405 方法、409 状态冲突、410 已下线、422 无法溯源 | `caller_error` | 路由自己判出来走 `callerError`（`server.js:364`）；异常自带 4xx `status`（各模块判过的档位，如 `wiki-store.js` 的 400/404/409、`trace-board.js` 的 422）也算这一类 | 校验原话，如「分页参数无效」「告警 ID 无效」 |
| 没配置 | 503 | `not_configured` | 路由开头判依赖在不在，走 `configError`（`server.js:365`） | 点名缺哪个变量/组件，如「未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN」 |
| 上游失败 | 502 | `upstream_error` | `viaCloudwalker` 在异常上打的 `failure: 'upstream'` 标（`server.js:431-437`）；**随部署的只读规则数据**（`rules/` 的 Rego、`.data/triage-rules.json`）读/解析失败也归这类 | 上游那句摘要原话：牧云 `/rpc <code>: <message>`、`connect ECONNREFUSED <ip>:<port>`、`模型接口 HTTP <status>: <message>`、`规则库读取失败：rules/<文件>:<行> …` |
| 本程序失败 | 500 | `internal_error` | 其余没被认领的异常：路由里调本地存储/自己代码的 catch 用 `causeError(res, cause, 'internal')`，外层 catch 的缺省类也是它（`server.js:945-951`） | 恒为「服务器内部错误」；异常原文与堆栈只进 `http.failed` 日志 |

判定顺序（`failureKindOf`，`server.js:370-374`）：异常上有 `failure` 标记 → 按标记；否则异常带 4xx `status` → `caller`；
否则落到调用点给的缺省类。**判据不看文案**——旧版靠 `/请求正文/`、`/告警 ID 无效|研判模式无效/` 两条正则从消息里猜分类，
两条都已删除：`readJSON` 的两条错自己带 `status: 400`（`server.js:415-423`），研判 POST 的 ID/模式在进研判器之前就判完（`server.js:874-877`）。

四条纪律：

1. **5xx 不给调用点覆盖**：`fail()` 的状态码由类决定（`server.js:361-367`），只有 `callerError` 能指定 4xx 里的哪一档。
   前端按 403/404/409/503 分辨 forbidden / notfound / conflict / unavailable，这些档位一个没动。
2. **本程序失败不回原文**：`internal_error` 的 `error` 恒为 `INTERNAL_ERROR_MESSAGE`（`server.js:346`、`:355-358`）；
   异常原文由外层 catch 写进 `http.failed`（`server.js:948-949`），响应里既没有异常消息也没有 `at …` 堆栈行。
3. **上游失败带上游那句摘要**：`error` 就是上游原话（已过下一道擦除），调用方可原样上屏；没有可用消息时兜底「上游请求失败」。
4. **凭据不回显**：所有错误原文出口都过 `scrubCredentials`（`server.js:349-353`）——`Basic …` / `Bearer …` 换成 `[redacted]`，
   `token=` / `api_key=` / `password=` / `secret=` 的值换成 `[redacted]`。SSE 的错误帧（§6）与误报维护落盘的
   `maintenance.*.error` 过同一道闸；`/api/status` 的 502 业务体同理。

两处不属于四类：业务认证失败的 **401 是纯文本**（`server.js:392-398`，身份闸）；`/api/status` 配了却连不上时 **502 是业务体**
`{configured, connected, reason, code}`（见 §9.2）。

分类落地前这些地方是混的，改动实测（`evidence/test/P003-T024/error-classes.test.js`）：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| `PUT /api/triage/rules` 保存时本地写盘失败 | 400 + 异常原文 | 500 `{"error":"服务器内部错误","code":"internal_error"}` |
| `PUT /api/agent/triage/control` 本地写盘失败 | 502 + 异常原文 | 500 + 固定文案 |
| `GET`/`PUT /api/wiki/pages/…` 读/写失败且异常不带 4xx `status` | 400 + 异常原文 | 500 + 固定文案 |
| `POST /api/wiki/sessions` 创建时本地意外 | 400 + 异常原文 | 500 + 固定文案 |
| 外层 catch 里没被认领的异常（如 `GET /api/agent/prompts` 读元数据失败） | 502 + 异常原文 | 500 + 固定文案 |
| `POST /api/agent/triage/{syslog-id}`（该 syslog 告警没有原始报文） | 502（T18-F1：与 openapi `retryTriage` / triage-pipeline §5.4 承诺的 404 不符） | 404 `{"error":"该 syslog 告警的原始报文不存在，无法重试","code":"caller_error"}` |
| `POST /api/agent/investigations` 正文不是 JSON | 400（靠 `/请求正文/` 匹配文案） | 400 `{"error":"请求正文不是 JSON","code":"caller_error"}`（靠 `status` 标记，不读文案） |

> 行号口径：P003-T024 在 `server.js` 顶部插了分类块（约 +60 行），本页其它小节里 `server.js:<行>` 的老引用会整体后移；
> 按符号 `grep -n` 定位即可，语义没变。

## 9. 边界与未决

### 9.1 与 `openapi.yaml` 的关系

对外 HTTP 契约在 `openapi.yaml`，声明 39 条路径（`grep -c '^  /' openapi.yaml` → `39`，P003-T013 提交时）。它与 `server.js` 的路由是**分开维护的两份文本**，改路由时两边都要动（这条在 [architecture.md](../architecture.md) 第 11.3 节也记着）。本页只描述 `server.js` 实际跑出来的行为；两边逐条比对不是本卡做的事。

### 9.2 同一类为什么还有多个 4xx，以及还剩下的不齐之处

四类落地后，**类 → 状态码是固定的**，没有再出现「同一类这处 400、那处 502」；但「调用方传错」这一类内部保留了 4xx 的既有档位，
因为它们表达的是不同的调用方结论，前端（`web/src/*`）按档位分流：

| 档位 | 含义 | 出现处举例 |
| --- | --- | --- |
| 400 | 参数/正文/ID 不合法 | 分页参数、正文不是 JSON、`请求正文无效` |
| 403 | 管理令牌不对 | 规则管理员令牌（`server.js:688`）、知识库管理员凭据（`server.js:824`） |
| 404 | 目标不存在 | 未知 API（`server.js:943-944`）、知识库页面/会话、研判记录、告警事件 |
| 405 | 方法不对（只有提示词入口一处，`server.js:790`） | `POST /api/agent/prompts` |
| 409 | 状态冲突 | 研判未完成不能登记误报（`server.js:752`）、页面版本过期、缺可维护判据页 |
| 410 | 入口已下线 | `POST /api/agent/prompts/upload`（`server.js:791`） |
| 422 | 目标无法溯源 | 白板启动时告警没资产（`trace-board.js:344-355`） |

仍然不齐、但**不影响四类口径**的几处：

- **404 有两种文案**：未知 API 与非 API 路径回「接口不存在」，`/api/wiki/` 下的未知路径回「知识库接口不存在」——两条都是 `caller_error`。
- **`/api/status` 不走 503**：没配牧云时回 200（`configured:false`）；配了但连不上时回 **502**，正文是业务体
  `{configured:true, connected:false, reason, code:"upstream_error"}`——502 在这里是「上游连不上」的业务体，
  不是「整个服务不可用」，前端按正文处理。
- **SSE 里没有状态码级的失败**：研判抛错也是 200，错误在帧里（`data: {"type":"error","error":…}`），帧里的错误原文同样过凭据擦除，但没有 `code`。

### 9.3 本卡没查到的

1. **牧云侧的真实响应**：本机没有 `CLOUDWALKER_URL` / `CLOUDWALKER_API_TOKEN`，未发起任何外部请求。`/api/alerts`、`/api/alerts/{type}:{id}`、`/api/status` 的响应体形状只按代码里的组装逻辑描述。
2. **模型服务的真实行为**：没有真实模型服务，SSE 的进度段条数与内容取决于研判过程本身；本页引用的探针输出用的是替身研判器。
3. **`POST /api/wiki/sessions` 的完整链路**：令牌之后会读研判记录与案件目录（`server.js:426-453`），本卡只探到令牌与正文上限两处。

### 9.4 入口判定的一个边界

`server.js:555` 的入口判定会先对 `process.argv[1]` 做 `realpathSync`。以 `-` 作入口（stdin 方式跑）时该路径不存在，`realpathSync` 抛 ENOENT，模块在加载阶段就失败。用 `node --input-type=module -e "..."` 执行时 `process.argv[1]` 是 `undefined`，判定短路，不受影响——本页的探针就是这么跑的（见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第 5.1 节）。

## 10. 怎么复跑本页的结论

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P001-T002

# 1. 取出运行时探针并执行（覆盖认证、令牌、分页、SSE、路由分发、正文上限六组断言）
awk '/^\/\/ probe:start$/{f=1;next}/^\/\/ probe:end$/{f=0}f' evidence/recon/P001-T002.md > /tmp/httpapi-probe.mjs
HIDS_REPO=$(pwd) node /tmp/httpapi-probe.mjs

# 2. 看清本页的路由表是从哪些分支来的
grep -n "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js

# 3. 契约文件的路径条数
grep -c '^  /' openapi.yaml
```

探针不写任何文件、不连外部服务；它注入替身服务跑真实 HTTP 请求，输出见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第四节。

本页只描述现状。哪一处该改、改成什么样，是评审的活，不在文档范围内。
