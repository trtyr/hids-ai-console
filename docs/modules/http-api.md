# HTTP API 模块（http-api）

业务 HTTP 接口的唯一入口。本页讲 `server.js` 这一个文件：它怎么把请求分发到各条路由、怎么判身份、怎么校验入参、怎么把结果封装成响应。

- 模块清单条目：[docs/modules/_breakdown.json](_breakdown.json) 里的 `http-api`
- 全局背景（进程入口、分层依赖、访问边界）：[docs/architecture.md](../architecture.md)
- 行号基准：本页的 `文件:行号` 指向 `server.js` 共 496 行的版本（commit `63f1379`）。改了代码要重新核。P003-T013 新增的误报入口一行与第 3.4 节按本卡提交时的 `server.js` 标号（808 行，见 [evidence/recon/P003-T013.md](../../evidence/recon/P003-T013.md)），其余锚点仍指向 496 行版本。P003-T025 加的两处（§2 的启动闸门与第 3 节路由表的 `GET /api/config`）按 1021 行的 `server.js` 标号（见 [evidence/recon/P003-T025.md](../../evidence/recon/P003-T025.md)）：新代码全部落在文件末尾与 `server.js:612` 一行，前面所有锚点没挪。P003-T029 加的写配置（§3.1 表里 `POST /api/config`、§3.5 的两处小改、新增 §3.6）按 1085 行的 `server.js` 标号（见 [evidence/recon/P003-T029.md](../../evidence/recon/P003-T029.md)）：新代码落在 `server.js:32`、`server.js:65-84`、`server.js:646-650` 与新文件 `config-store.js`，前面所有锚点没挪。P003-T036 加的取消接口（§3 路由表的 `DELETE /api/agent/triage/{alertId}`）按本卡提交时的 `server.js` 标号（`server.js:825-828`，见 [evidence/recon/P003-T036.md](../../evidence/recon/P003-T036.md)）：新代码只在 triage 单条路由那一块加了一个分支，前面所有锚点没挪。P003-T037 并入 P003-T036 之后：`server.js` 仍是 1090 行（只有 triage 装配处一行不同），历史锚点没挪；`triage-monitor.js` 由 860 行涨到 1011 行，本页改到的两处锚点按合并版本重取（`triage-monitor.js:622-631`、`triage-monitor.js:995-1002`），其余行号见 [coding-reports/P003-T037.md](../../coding-reports/P003-T037.md) 的未决小节。P003-T042 的模型分层按 1387 行的 `server.js` 标号（见 [evidence/recon/P003-T042.md](../../evidence/recon/P003-T042.md)）：新增装配在 `server.js:42`（五个角色实例）与 `configSummary` 的 `model.roles`（`server.js:1355`），`applyLiveConfig` 涨到 `server.js:74-95`，路由行号整体 +5（`GET /api/config` 在 `server.js:871`、`POST` 在 `server.js:875-879`）；§3.5 与 §3.6 的表与样例已按本卡更新，其余章节的旧锚点没挪。
P003-T044 加的数据管理两条路由（§3 路由表的 `GET /api/data/inventory` 与 `POST /api/data/cleanup`、新增 §3.7）按本卡提交时的 `server.js` 标号（1309 行，`server.js:598-799` 的 helper、`server.js:864-870` 的两个分支、`server.js:829` 的 `dataDeps`）与 `triage-monitor.js` 标号（924 行，`triage-monitor.js:349-407` 的三个新方法，见 [evidence/recon/P003-T044.md](../../evidence/recon/P003-T044.md)）：新代码全部落在文件末尾与 `server.js:864-870`，前面所有锚点没挪。
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
| 运行态目录 `runtime`（9 条路径） | `server.js:28`、`server.js:1293-1306` | 根由 `HIDS_DATA_DIR` 定，没设就是 `~/.local/share/hids-ai-console/`（§8.1）；**不在仓库内** |
| 监听地址与端口 | `server.js:28-29` | `HIDS_HOST` 缺省 `127.0.0.1`，`HIDS_PORT` 缺省 `8080` |
| 牧云网关 `gateway` 与 API 工具箱 `apiToolbox` | `server.js:30-34` | 牧云地址或 Token 缺一个 → 两者为 `null` |
| 模型五个角色实例 `models` 与两个研判器 | `server.js:40-42`、`server.js:50-53` | `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 缺任一项 → `models` 为 `null`（五个角色都不建），两个研判器也是 `null`。P003-T042：研判=`models.triage`、独立复核=`models.review`、规则维护者=`models.rule_maintainer`、wiki 维护者=`models.wiki_maintainer`、溯源白板=`models.trace_board`；新键不设时逐键回退主判（§3.5 的 `model.roles`） |
| 研判记录、规则集、研判队列、判据工作台、溯源白板 | `server.js:46-59`、`server.js:126` | 队列要 `gateway` 与研判器、白板要 MCP 工具箱与模型，缺任一则该件为 `null` |

运行态路径的默认值全出自导出的 `runtimePaths(root = dataRoot())`（`server.js:1293-1306`，单测直接拿它对照）：`data` / `investigations` / `triageRules` / `triageMonitor` / `cases` / `baseline` / `intel` / `wikiSessions` / `traceBoards`，根由 `dataRoot()`（`config-store.js:31-35`）算：`HIDS_DATA_DIR` 指向哪就落哪，没设就是 `~/.local/share/hids-ai-console/`。**仓库里一个字都不写。** 整仓规则的完整说明在 [architecture.md](../architecture.md) 第 8.1 节。

**`createServer` 是依赖注入点**（`server.js:815-820`）：18 个参数都带默认值，默认指向模块级单例。测试与探针靠传替身换掉 `service`、`investigator`、`history`、`monitor`、`wiki`、`wikiAgent` 这些件。其中 `monitor` 与 `boardService` 的默认值写成「`service` 是不是模块级 `gateway`」的条件式——换了 `service`，就不再挂默认的研判队列与溯源白板。

**规则预筛挂在 `investigate()` 闭包上**（`server.js:262-273`）：`mode === 'triage'` 且 `monitor.ruleEngine` 存在时，先跑一次规则评估，把结果作为 `rule_evaluation` 挂到结论上；评估抛错就记成 `{ status: 'error' }` 继续往下走，不中断研判。

**进程入口**（`server.js:1071-1095`，P003-T025 扩过）：`process.argv[1]` 的真实路径等于本文件路径时才算真进程启动，顺序是「先核配置，再监听」。闸门有**两类问题，一个出口**（`server.js:1076-1083`）：

1. **缺必填**——`configSummary()`（`server.js:1057`）算一遍必填差额。五项必填 `CLOUDWALKER_URL` / `CLOUDWALKER_API_TOKEN` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 缺任一项（**空串算缺**，`.env.example` 的占位就是空串）：不 `listen`，把缺的键名逐个写进 stderr（`缺少必填配置：A、B、…`）。
2. **取值非法**——`invalidConfigValues()`（`server.js:1048`）管唯一一处取值校验：`HIDS_TRIAGE_INPUT_MODE` 只能是 `syslog` 或 `poll`；不设或空串＝缺省 `syslog`（不算非法），其他值一律拒启动，stderr 写 `配置值无效：HIDS_TRIAGE_INPUT_MODE=<坏值>（只能是 syslog 或 poll）`。**不许静默按 `poll` 跑**——那会把 syslog 接收器悄悄关掉，而配置页还回显那个错值。
3. 两类都有时两行都写，然后统一 `process.exitCode = 1`，并打一条 `server.start_failed`（`what: "config"`；`missing` 是缺的键名数组，`invalid` 每条 `{key, value, allowed}`，`error` 是 stderr 那几行拼起来的原话）。**退出码非 0 是契约**，部署脚本按它判「起来没起来」。
4. 两类都干净才 `createServer().listen(...)` 并打 `server.started`（`host`/`port` 两个字段）；随后若生效的输入模式是 `syslog`，再起一个 UDP 接收器（`server.js:1086-1093`）。

**闸门只拦真进程**：`createServer()` 被直接调用（测试、探针、别的入口）时不跑闸门，缺件照旧置空、相关路由 503（见 [architecture.md §3.5](../architecture.md)）。要有意造一个缺件进程做实验，用 `createServer()` 起，别指望 `node server.js` 能起来。

**一份判定三处用**：`configSummary(env = process.env)`（`server.js:1057`）报生效值，`triageInputModeOf(env)`（`server.js:1042`）给模块级装配与 `/api/config` 定生效模式（合法值原样、空值缺省 `syslog`、**坏值不在这里兜**），`invalidConfigValues(env)`（`server.js:1048`）给闸门判坏值——取值表只有一份（`triageInputModes()`，`server.js:1036`）。三者都只读环境变量、不探上游、不碰模块级单例：判的是「键在不在、值在不在表里」，值的形状（URL 前缀、Token 长度）仍由装配处抛（`rpc-client.js:4-5`、`model-client.js:22-24`）。

## 3. 路由分发

**关键路径**：`server.js:843`（处理函数）、`server.js:853`（路径解析）、`server.js:855` 到 `server.js:1270`（依次排列的分支）、`server.js:1272-1273`（404 兜底）。

**分发机制**：没有路由表，是一条 `if` 链。每一支的形状都是「路径条件 + 方法条件」，命中即 `return`，后面的分支不再看。因此**分支顺序决定谁先赢**：`GET /api/agent/triage/status`（`server.js:333-334`）排在 `GET /api/agent/triage/{alertId}`（`server.js:378-385`）前面，所以 `status` 这个词不会被当成告警 ID。

路径与查询串由 `new URL(req.url, 'http://' + (req.headers.host || 'localhost'))` 解析（`server.js:853`），后面的判断都用 `url.pathname` 与 `url.searchParams`。

### 3.1 路由表

39 条「路径 + 方法」组合：「前置条件」写的是这条路由在缺件时的表现；「出处」是该分支所在的行。

> 比历史版本多的四条：P003-T011 的三条 Rego 规则路由（`/api/rules`、`/api/rules/evaluate`、`/api/rules/{id}`）与本卡 P003-T013 的误报入口。P003-T029 又加了一条 `POST /api/config`（写配置，见 §3.6）；P003-T044 再加两条数据管理路由（`GET /api/data/inventory`、`POST /api/data/cleanup`，见 §3.7）。
> `grep -n "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js` 数的是**分支条件行数**（当前 39 行），不是组合数：一行可以给出多条组合（`server.js:819` 的 `/api/agent/triage/{alertId}` 给 GET / POST / DELETE 三条），也有行不算组合（`server.js:718` 只是 `/api/wiki/` 分组入口）。数之前先分清这两种。
41 条「路径 + 方法」组合：「前置条件」写的是这条路由在缺件时的表现；「出处」是该分支所在的行。

> 比历史版本多的四条：P003-T011 的三条 Rego 规则路由（`/api/rules`、`/api/rules/evaluate`、`/api/rules/{id}`）与本卡 P003-T013 的误报入口。P003-T029 又加了一条 `POST /api/config`（写配置，见 §3.6）。P003-T041 把规则维护做成正式接口，补了 `PUT /api/rules/{id}`、`GET /api/rules/{id}/history`、`POST /api/rules/{id}/rollback`、`GET /api/rules/sessions` 四条。
> `grep -n "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js` 数的是**分支条件行数**（当前 40 行），不是组合数：一行可以给出多条组合（`server.js:819` 的 `/api/agent/triage/{alertId}` 给 GET / POST / DELETE 三条），也有行不算组合（`server.js:718` 只是 `/api/wiki/` 分组入口）。数之前先分清这两种。

| 方法 | 路径 | 成功状态 | 前置条件 | 出处 |
| --- | --- | --- | --- | --- |
| GET | `/api/session` | 200 `{authenticated:true, user, role}` | — | `server.js:208-214` |
| GET | `/api/config` | 200 生效配置（`{host, port, triage_input_mode, cloudwalker, model, auth, secrets, missing_required}`；`model` 段含 `roles`） | —（只读环境变量：不探上游、不因缺件 503；机密只在 `secrets` 里给布尔） | `server.js:871` |
| POST | `/api/config` | 200 `{updated, config}`（写配置，见 §3.6） | 只收可写十一键（含 P003-T042 的复核组 / 轻量组六键）；正文不是 JSON / 键不可写 / 值不合法回 400；落盘失败回 500 | `server.js:875-879` |
| GET | `/api/data/inventory` | 200 七类存储的条数与字节（`{data_dir, stores, total}`，见 §3.7） | —（只读本地运行态目录：不探上游、不碰模型，缺目录按 0 报，不 503） | `server.js:864` |
| POST | `/api/data/cleanup` | 200 `{dry_run, kind, action, threshold, candidates, applied, inventory}`（见 §3.7） | 默认 dry-run；`kind` / 阈值 / 动作 / `execute` 不合法回 400；候选里有没完结的案件回 409；没装配研判队列时清 `queue` 回 503 | `server.js:866-870` |
| GET | `/api/updates` | 200 升级包概览 | — | `server.js:215` |
| GET | `/api/status` | 200 / 502 | 未配牧云回 200（`configured:false`）；配了但连不上回 502，正文仍是 `{configured, connected:false, reason}`。**探活结果缓存 45 秒**（`HIDS_STATUS_TTL_MS`，P003-T037）：窗口内不再发牧云 RPC，并发请求共用同一次探活；失败不缓存 | `server.js:216-220`、`cloudwalker.js:120-133` |
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
| GET | `/api/rules` | 200 `{count, rules}`（Rego 规则库，活数据在 `<数据根>/rules/`） | 规则库读取失败回 502 | `server.js:752-755` |
| GET | `/api/rules/sessions` | 200 `{sessions}`（规则维护会话摘要，按 `updated_at` 倒序；不含规则正文与误报理由） | 会话目录不可读回 502 | `server.js:758-761` |
| POST | `/api/rules/evaluate` | 200 `{count, matched}` | 正文不是对象回 400；求值失败回 502 | `server.js:762-768` |
| GET | `/api/rules/{id}/history` | 200 `{id, history:[{rev, file, bytes, saved_at, note}]}` 按写入时间升序；规则不存在时回空数组。`note` 是那条历史副本「为什么被替换」（`人工维护：<note>` / `人工回滚（<who>）` / `误报维护（<who>）：<理由>`），没备注的旧副本是 `null` | id 不合格式回 400；历史目录不可读回 502 | `server.js:769-778` |
| POST | `/api/rules/{id}/rollback` | 200 与 `PUT` 同形，另带 `action:"rollback"` 与 `rolled_back_to`；被替换那一版进历史，备注 `人工回滚（<who>）` | 需规则管理员令牌（没配 503／不对 403）；`rev` 不是 16 位十六进制回 400；历史里没有这一版回 404 | `server.js:779-788` |
| PUT | `/api/rules/{id}` | 200 `{id, file, name, rev, previous_rev, action}`（`action` 是 `add` / `update` / `unchanged`） | 需规则管理员令牌（没配 503／不对 403）；正文缺 `rego` 或 `expected_revision` 回 400；正文不在规则子集内回 400 并带 `<id>.rego:<行>`；`expected_revision` 与当前指纹不一致回 409（比对与写在 `RuleStore` 的同一个写队列任务里，并发两个 `PUT` 只成一个）；规则目录写失败回 500 | `server.js:790-812` |
| GET | `/api/rules/{id}` | 200（含 `revision` = 正文 sha256 前 16 位）/ 404 | id 不合格式回 400；规则库读取失败回 502 | `server.js:814-827` |
| GET | `/api/agent/triage/cases` | 200 | 无研判队列回 503 | `server.js:292-299` |
| PUT | `/api/agent/triage/control` | 200 | 无研判队列回 503。暂停期间报文进缓冲不丢、恢复不动游标（P003-T036，见 openapi 该路径说明） | `server.js:771-777` |
| GET | `/api/agent/triage/{alertId}` | 200 | 无研判队列回 503 | `server.js:825` |
| POST | `/api/agent/triage/{alertId}` | 202 | 无研判队列回 503；队列（排队 + 在跑）已达 `HIDS_TRIAGE_QUEUE_MAX` 回 429「研判队列已满（上限 N），稍后再试」并计入 `summary().dropped` | `server.js:826` |
| DELETE | `/api/agent/triage/{alertId}` | 200 `{alert_id, status:"not_queued", cancelled:true}`（取消排队中的记录） | 无研判队列回 503；没有这条记录回 404；已在研判中或已完成（running / done）回 409 | `server.js:828-831` |
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
| GET | `/api/alerts` | 200 | 无牧云服务回 503；上游连不上且窗口内没有快照时回 502 `upstream_error`（**首批列表有 ≤15 秒快照**，`HIDS_LIST_SNAPSHOT_TTL_MS`，P003-T037：窗口内同一 `类型|批大小|起点` 直接回缓存，上游刚挂的这段窗口里可能仍是 200 的陈旧页） | `server.js:440-454` |
| GET | `/api/alerts/{type}:{id}` | 200 | 无牧云服务回 503 | `server.js:456-475` |

### 3.2 不是路由的固定响应

三条路径不查后端，直接回固定结果：

| 条件 | 状态 | 正文 | 出处 |
| --- | --- | --- | --- |
| `/api/agent/prompts` 用了非 GET 方法 | 405 | 请使用提示词文件上传入口 | `server.js:1119` |
| `/api/agent/prompts/upload` | 410 | 提示词更新已迁移到独立维护端，业务端不允许上传 | `server.js:1120` |
| `/api/` 开头的未知路径 | 404 | 接口不存在 | `server.js:793-794` |

405 在整个文件里只有这一处（`grep -n "405" server.js` 只命中 `server.js:1119`）。**方法对不上的路径，除这一处外都落到 404**：`POST /api/session` 与 `POST /api/triage/rules` 都回 404「接口不存在」。非 API 路径（如 `/`）也回同一句 404（`server.js:989-990`）。但 404 有两种文案——`/api/` 下的未知路径回「接口不存在」（`server.js:989-990`），`/api/wiki/` 下的未知路径回「知识库接口不存在」（`server.js:1195`）。

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
`enqueue()` 把 `verdict` / `verdict_label` / `summary` / `decision_source` / `feedback` 带到新记录上（`triage-monitor.js:622-631`）；
`run()` 收尾看到 `verdict === 'false_positive'` 且 `decision_source === 'human'` 就不写这四件（`triage-monitor.js:995-1002`），
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
不重起一轮（`server.js:1079`）；挡它的是 `runningMaintenance` 集合（`server.js:840`）——**不是**记录上的 `maintenance.status`：
进程重启后记录会停在 `updating`，拿那个当锁会把案件永久锁死。重启后的残留不挡重新登记，但也不会自动恢复（见本卡报告「未决」）。

### 3.5 生效配置（`GET /api/config`，P003-T025）

**是什么**：一处能看进程实际生效的配置——不用登机器翻环境变量。实现只有一行路由（`server.js:642`），响应体就是 `configSummary(config.env)`（`server.js:1057-1069`）的返回值——`config.env` 缺省就是 `process.env`，写配置盖进去的覆盖层立刻反映在这里（§3.6）；OpenAPI 契约见 `openapi.yaml` 的 `getConfig`。

**请求**：`GET /api/config`，无参数、无正文。和其它业务路由一样过 Basic 认证闸门（§4）：启用认证时没凭据回 401 纯文本。

**响应**：`200`，`Cache-Control: no-store`，JSON 正文八键恒在（`server.js:1057-1069`）：

| 字段 | 类型 | 取值 | 说明 |
| --- | --- | --- | --- |
| `host` | string | 缺省 `127.0.0.1` | `HIDS_HOST` 的生效值 |
| `port` | number | 缺省 `8080` | `HIDS_PORT` 的生效值 |
| `triage_input_mode` | string | `syslog` / `poll`，**恒在这两个值里**；未设或空串为缺省 `syslog` | `HIDS_TRIAGE_INPUT_MODE` 的生效值——表外值（如 `pirate`）不会出现在这里：真进程被闸门拦下（§2 第 2 条），进程内 `createServer()` 按缺省 `syslog` 生效 |
| `cloudwalker.configured` | boolean | — | `CLOUDWALKER_URL` 与 `CLOUDWALKER_API_TOKEN` 是否都在（两个都在才算 `true`） |
| `model.configured` | boolean | — | `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` 三项是否齐全 |
| `model.name` | string \| null | `LLM_MODEL` 原值，未配为 `null` | 主判模型名（研判用它） |
| `model.roles` | object | 五个角色恒在：`triage` / `review` / `rule_maintainer` / `wiki_maintainer` / `trace_board` | **P003-T042 模型分层**：每个角色 resolved 到的模型名与来源，见下面那张表 |
| `auth.basic_auth_enabled` | boolean | — | 配了 `HIDS_BASIC_AUTH_PASSWORD` 才是 `true` |
| `secrets` | object | 五个键恒在，值都是 boolean | `CLOUDWALKER_API_TOKEN` / `LLM_API_KEY` / `HIDS_BASIC_AUTH_PASSWORD` / `HIDS_PROMPT_ADMIN_TOKEN` / `HIDS_RULE_ADMIN_TOKEN`，**只报有或没有** |
| `missing_required` | string[] | 必填五项的子集 | 缺哪几项必填；正常起着的进程是 `[]`（闸门见 §2） |

**模型分层（P003-T042，`model.roles`）**：每个角色一个对象 `{model, source}`——

| 角色 | `model` | 配置组 | 消费者 |
| --- | --- | --- | --- |
| `triage` | 研判实际用的模型名 | 主判 `LLM_*` | 两个 `InvestigationAgent` |
| `review` | 独立复核实际用的模型名 | 复核组 `LLM_REVIEW_*` | 研判里的独立复核那一轮（`investigation-agent.js:857`） |
| `rule_maintainer` | 规则维护者用的模型名 | 轻量组 `LLM_LIGHT_*` | `RegoRuleMaintainer` |
| `wiki_maintainer` | wiki 维护者用的模型名 | 轻量组 `LLM_LIGHT_*` | `WikiWorkbench` |
| `trace_board` | 溯源白板用的模型名 | 轻量组 `LLM_LIGHT_*` | `TraceBoardService` |

`source` 三态说明这一组配置的来源：`primary` = 这一组三个键全空、**逐键**回退主判（与分层前的行为完全一致）；`own` = 三个键全有、全用自己的；`mixed` = 部分有，空的那几项逐键回退主判。回退按**字段**比，不按组比：只设了 `LLM_REVIEW_MODEL` → 复核的模型名是自己的、地址与密钥仍是主判的，`source` 报 `mixed`。主判三项不齐时五个实例都不装配、`model.configured` 为 `false`；但 `model.roles` 不看装配，仍按 env 逐键解析照报——`model` 恒等于「这一组的模型名 ?? 主判模型名 ?? `null`」，`source` 按组内三键的实际配置报。所以 `model.configured=false` 不等于 `roles[*].model` 全 `null`：只设了 `LLM_REVIEW_MODEL='x'` 而主判三项全空时，`review` 报 `{model:'x', source:'mixed'}`、`triage` 报 `{model:null, source:'primary'}`。**只报模型名与来源，不报地址与密钥**——新两组的 API Key 不进 `secrets`（那里仍是原来五个键），正文里也不出现它们的原文。

**机密口径（A3，可断言）**：响应正文里不出现任何 Token 与密码原文——五个机密键的值都是布尔，`secrets` 之外没有第二个地方出现它们。两个状态都要测：配了 → `true`；没配 → `false`。**别只在「都配了」的状态下测**：那样把实现改成回原文也发现不了（会回一堆字符串，但 `typeof` 断言才抓得住）。

**不做什么**（测试别按这些写期望）：

- 不探上游：`configured:true` 只说明「键在」，不代表牧云/模型连得上——连通性看 `GET /api/status`。
- 缺件也不回 503：这个接口只读环境变量，永远 `200`（`missing_required` 里写着缺什么）。
- 不报维护端（`maintenance-server.js`）的配置：那是另一个进程、另一套账号（见 [architecture.md](../architecture.md) §10.2）。
- 不报 `HIDS_WIKI_DIR` / `HIDS_CASES_DIR` 这类路径项：它们是运行态落点，不是「配了没有」的判断依据。

**典型两态**（探针实测，见 [evidence/recon/P003-T025.md](../../evidence/recon/P003-T025.md)）：

```json
// 五项齐、没配 Basic 与两个 admin token
{"host":"127.0.0.1","port":8080,"triage_input_mode":"syslog","cloudwalker":{"configured":true},
 "model":{"configured":true,"name":"fake-model","roles":{"triage":{"model":"fake-model","source":"primary"},
   "review":{"model":"fake-model","source":"primary"},"rule_maintainer":{"model":"fake-model","source":"primary"},
   "wiki_maintainer":{"model":"fake-model","source":"primary"},"trace_board":{"model":"fake-model","source":"primary"}}},
 "auth":{"basic_auth_enabled":false},
 "secrets":{"CLOUDWALKER_API_TOKEN":true,"LLM_API_KEY":true,"HIDS_BASIC_AUTH_PASSWORD":false,
            "HIDS_PROMPT_ADMIN_TOKEN":false,"HIDS_RULE_ADMIN_TOKEN":false},"missing_required":[]}
// 一个必填都没配（这种进程用 node server.js 起不来，只能用 createServer() 起）
{"host":"127.0.0.1","port":8080,"triage_input_mode":"syslog","cloudwalker":{"configured":false},
 "model":{"configured":false,"name":null,"roles":{"triage":{"model":null,"source":"primary"},
   "review":{"model":null,"source":"primary"},"rule_maintainer":{"model":null,"source":"primary"},
   "wiki_maintainer":{"model":null,"source":"primary"},"trace_board":{"model":null,"source":"primary"}}},
 "auth":{"basic_auth_enabled":false},
 "secrets":{"CLOUDWALKER_API_TOKEN":false,"LLM_API_KEY":false,"HIDS_BASIC_AUTH_PASSWORD":false,
            "HIDS_PROMPT_ADMIN_TOKEN":false,"HIDS_RULE_ADMIN_TOKEN":false},
 "missing_required":["CLOUDWALKER_URL","CLOUDWALKER_API_TOKEN","LLM_BASE_URL","LLM_API_KEY","LLM_MODEL"]}
```

### 3.6 写配置（`POST /api/config`，P003-T029）

**是什么**：不重启进程改牧云与模型的十一项（P003-T042 起加了模型分层的复核组与轻量组六键），改完立刻生效、落盘、重启仍生效，且不回显。实现：路由两行（`server.js:875-879`），行为全在新文件 `config-store.js`（`createConfigStore`，`config-store.js:104`）。OpenAPI 契约见 `openapi.yaml` 的 `writeConfig`。

**可写的只有十一个键**（`WRITABLE_CONFIG_KEYS`，`config-store.js:24-28`）：`CLOUDWALKER_URL`、`CLOUDWALKER_API_TOKEN`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，以及复核组 `LLM_REVIEW_BASE_URL` / `LLM_REVIEW_API_KEY` / `LLM_REVIEW_MODEL` 与轻量组 `LLM_LIGHT_BASE_URL` / `LLM_LIGHT_API_KEY` / `LLM_LIGHT_MODEL`。表外键一律 400，包括看起来很顺手的 `HIDS_PORT`：`HIDS_HOST` / `HIDS_PORT` / `HIDS_TRIAGE_INPUT_MODE` 改起来必须重启进程；Basic 口令与两个管理员令牌是鉴权凭据本身，写进来等于自己给自己开门。新六键与主判三项走**同一张表、同一套覆盖层**（不是 T043 的新机制）：写进去的键进 `config-overrides.json`，重启照样读回。

**请求**：`POST /api/config`，`Content-Type: application/json`，正文是一个对象，只放要改的键（部分更新）：

```json
{"LLM_MODEL":"qwen2.5-72b-instruct"}
```

- **值的形状**用模块级装配处同一套构造器判（`config-store.js:63-76` → `rpc-client.js:4-5`、`model-client.js:14-21`）：`CLOUDWALKER_URL` / 三组 `*_BASE_URL` 必须 `http(s)://` 开头；`CLOUDWALKER_API_TOKEN` 至少 6 位；三组 `*_API_KEY`、`*_MODEL` 非空。校验对象是**合并后的生效值**（只改 `LLM_MODEL` 也要主判三项齐——进程里这三项本来就被启动闸门保证齐全；只改复核组一个键时，另外两项逐键回退主判，所以照样 200）。
- **坏值报错点组内键名**（P003-T042）：写坏的 `LLM_LIGHT_BASE_URL` 回「LLM_LIGHT_BASE_URL 必须是 HTTP(S) 地址」，不是笼统的 `LLM_BASE_URL`；回退来的字段出问题才点主判键名（那才是要改的键）。
- **空串不能用来「删键」**：值必须是非空字符串，空串/空白串回 400。覆盖层只能新增/改值、不能删键；要清掉改过的值，用 P003-T044 的数据管理接口删掉覆盖层（`POST /api/data/cleanup`，`kind: config_overrides`，见 §3.7），或手工删 `.data/config-overrides.json`——两种都要**重启进程**才回到「按环境变量生效」，因为覆盖层是启动时同步读进 `env` 的。

**响应**：`200`，`Cache-Control: no-store`：

```json
{"updated":["LLM_MODEL"],"config":{"host":"127.0.0.1","port":8080,"triage_input_mode":"syslog",
  "cloudwalker":{"configured":true},"model":{"configured":true,"name":"qwen2.5-72b-instruct",
  "roles":{"triage":{"model":"qwen2.5-72b-instruct","source":"primary"},"review":{"model":"qwen3-32b-review","source":"own"},
  "rule_maintainer":{"model":"qwen-flash","source":"own"},"wiki_maintainer":{"model":"qwen-flash","source":"own"},
  "trace_board":{"model":"qwen-flash","source":"own"}}},
  "auth":{"basic_auth_enabled":false},"secrets":{"CLOUDWALKER_API_TOKEN":true,"LLM_API_KEY":true,
  "HIDS_BASIC_AUTH_PASSWORD":false,"HIDS_PROMPT_ADMIN_TOKEN":false,"HIDS_RULE_ADMIN_TOKEN":false},
  "missing_required":[]}}
```

- `updated`：这次改了哪几个键，顺序＝正文里的顺序。
- `config`：写完之后的生效值，与 `GET /api/config` 的 200 正文**同形状同口径**（八键恒在、机密只布尔）。

**写完之后的三件事（A1/A4，可分别断言）**：

1. **立刻反映**：`GET /api/config` 下一次请求就报新值——store 把覆盖层写进 `env`，而 GET 读的就是 `configSummary(config.env)`。
2. **运行中生效**：进程内活着的客户端对象**原地换值**（`applyLiveConfig`，`server.js:74-95`：`gateway.rpc.baseUrl/token`、`agentToolbox.client.url/token`（并把 `initialized` 置 false，新服务端要重新 initialize MCP 会话）、五个角色实例的 `url/apiKey/model`），后续牧云 / 模型调用立刻走新地址与新凭据。**P003-T042 起按新值重新解析五个角色**：回退主判的角色（`source` 为 `primary` / `mixed`）跟着主判三项一起动，自有组（`own`）只认自己那组——只改主判不会把复核组覆盖掉，把复核组写空之后复核会立刻回退到主判。不重建对象是因为 `createServer` 的 `service` / `toolbox` / `investigator` / `monitor` 都是值捕获，重建等于换了一批引用，路由手里还是旧的。
3. **持久化**：值落到**数据根**下的 `config-overrides.json`（`~/.local/share/hids-ai-console/config-overrides.json`，或 `HIDS_DATA_DIR` 指的目录；同目录临时文件 + `rename`，权限 0600），文件里**只有改过的键**。进程启动时 store 在建模块级客户端**之前**同步读回它（`server.js:32`），所以重启后改过的值仍生效，**没改过的键继续读环境变量**。文件坏了（不是合法 JSON、不是对象）不当场死：当空处理并落一条 `config.load_failed`（`level: error`，字段 `file` / `error`），进程照常起来、按环境变量生效。

**鉴权（A3）**：和其它业务路由一样过 Basic 认证闸门（§4，`server.js:413` / `server.js:421`），闸门在 URL 解析之前。**没配 `HIDS_BASIC_AUTH_PASSWORD` 时闸门放行，写接口也放行**——那是一个合法部署（单机探针、内网只读演示），不是推荐部署：任一能访问到端口的人都能把牧云地址指到自己的服务器再把模型密钥送出去。要挡住写就把 Basic 认证配上（配了就回 401，见 A3 用例）。这一点不是本节的推论，是写进 `openapi.yaml` `writeConfig.description` 的契约。

**不回显（A2）**：写成功的响应、`GET /api/config`、以及所有错误正文里都不出现 Token / 密钥原文——机密只以布尔出现在 `secrets` 里；错误原话只点键名（如「LLM_BASE_URL 必须是 HTTP(S) 地址」），即便坏值里塞了一段像凭据的东西也不漏出去。

**留痕（A5）**：每次写落一条 `config.updated`，字段只有 `keys`（数组，本次改了的键名），不带值：

```json
{"time":"…","level":"info","event":"config.updated","keys":["LLM_MODEL"]}
```

写失败（校验不过 / 落盘失败）不落这条事件——它记的是「改了」，不是「想改」。

**错误**（四类口径见 §8，路由自己判的一律走 `callerError`）：

| 情形 | 状态 | `code` | 正文 `error`（原话） |
| --- | --- | --- | --- |
| 正文不是 JSON / 过大 | 400 | `caller_error` | 「请求正文不是 JSON」/「请求正文过大」 |
| 正文不是对象（数组、字符串、null） | 400 | `caller_error` | 「请求正文必须是 JSON 对象」 |
| 正文没有可写的键（`{}`） | 400 | `caller_error` | 「请求正文没有可写的配置项」 |
| 键不在可写表里 | 400 | `caller_error` | 「配置项不可写：HIDS_PORT」（多个用、「」隔开） |
| 值是空串/空白/非字符串 | 400 | `caller_error` | 「配置项取值必须是非空字符串：LLM_MODEL」 |
| 值形状不合法 | 400 | `caller_error` | 装配处那句原话，键名换成这一组真正的键，如「LLM_BASE_URL 必须是 HTTP(S) 地址」「LLM_LIGHT_BASE_URL 必须是 HTTP(S) 地址」「CLOUDWALKER_API_TOKEN 无效」 |
| 落盘失败（目录不可写等） | 500 | `internal_error` | 「服务器内部错误」（异常原文只进 `http.failed` 日志） |
| 没通过 Basic 认证（启用了认证时） | 401 | —（纯文本） | 「需要登录后访问」，见 §4 |

**失败时什么都不变**：先校验、再落盘、再改内存与 `env`——被拒的写不会留下覆盖层，也不会让 `GET /api/config` 报出半套值。

**不做什么**（测试别按这些写期望）：

- 不在运行中**新建**原本为空的客户端：启动闸门要求五项必填齐全，进程里 `gateway` / 五个角色实例恒存在；`applyLiveConfig` 只换值不建对象（进程内注入空客户的测试路径不会因为一次写就跑起来）。新建实例只在进程启动时发生一次（`createModelRolesFromEnv`，`server.js:42`）。
- 不写前端：本卡不动 `web/**`，配置页要不要加输入框是另一张卡。
- 不动数据根：覆盖层路径固定由 `runtimePaths().data` 推出，根怎么算不归这条接口管（P003-T034 起由 `HIDS_DATA_DIR` / 全局默认决定，见 §2）。`HIDS_DATA_DIR` 改起来必须重启进程，它不在可写十一项里。
- 不改 `GET /api/config` 的既有字段语义：根还是八个键，`model.configured` / `model.name` 仍是主判口径；P003-T042 只在 `model` 段里加了 `roles`（§3.5）。
- 不做 T043 的覆盖层新机制：新六键走的就是上面这套 `config-overrides.json`（读回、原子写、0600、只有改过的键）。

**可重放证据**（`evidence/test/P003-T029/config-write.test.js`，10 条）：

```bash
node --test evidence/test/P003-T029/config-write.test.js   # 10 条全绿，约 160ms
# 真进程手工验三件事（起进程 → 写 → 读 → 杀 → 再起 → 读）
```

### 3.7 数据管理（`GET /api/data/inventory`、`POST /api/data/cleanup`，P003-T044）

**关键路径**：两个分支在 `server.js:864-870`；实现是 `server.js:601-812` 的一批 helper（`DATA_KINDS` 在 `server.js:611`、`dataStores()` 在 `server.js:623`、`dataInventory()` 在 `server.js:725`、`dataCleanup()` 在 `server.js:789`）；队列侧的候选挑选与清理在 `triage-monitor.js:439-500`（`cleanCandidates()` / `clean()` / `blockedCaseDirs()`）；路径来源在 `server.js:842` 的 `dataDeps`（`{history, monitor, boardService, wikiAgent, config}`）。

**它管什么**：给运维一眼看清仓内 `.data/` 下七类运行态各占多少，再按类型与阈值把老数据**归档或删除**。**不管**页面（`web/**` 不在本卡 scope）、不管各 store 的类（`investigation-store.js` 等仍然没有删除方法——清理是文件系统层的运维动作）、不新增配置键、不引入自动清理定时器。

#### 3.7.1 七类存储与「一条」的口径

`kind` 的枚举顺序就是响应里 `stores[]` 的顺序，测试按它写期望：

| `kind` | 中文 | 路径来源（缺省值） | 什么算「一条」 | 条目时刻（`oldest_at` / `newest_at` / 排序） |
| --- | --- | --- | --- | --- |
| `cases` | 案卷 | `monitor.casesDirectory` → `HIDS_CASES_DIR` → `.data/cases` | 一级子目录（一个案件目录） | 目录内**文件**的最新 mtime；空目录退回目录自身 mtime |
| `investigations` | 研判记录 | `history.directory` → `.data/investigations` | 一个 `*.json` | 文件 mtime |
| `boards` | 溯源白板 | `boardService.directory` → `.data/trace-boards` | 一个 `*.json` | 文件 mtime |
| `wiki_sessions` | 知识库会话 | `wikiAgent.directory` → `.data/wiki-sessions` | 一个 `*.json` | 文件 mtime |
| `queue` | 研判队列 | `monitor.file` → `.data/triage-monitor.json` | 一条队列记录 | 记录上 `updated_at` → `saved_at` → `created_at` 第一个能解析的 |
| `logs` | 日志 | `.data/` 目录本身 | `.data/` **顶层**的一个 `*.log` | 文件 mtime |
| `config_overrides` | 配置覆盖层 | `config.file` → `.data/config-overrides.json` | 那一个文件（0 或 1） | 文件 mtime |

- **路径全部取自注入件**（`createServer` 的 `history` / `monitor` / `boardService` / `wikiAgent` / `config`）：换替身就是换盘点对象，测试不必碰仓内 `.data/`。
- **`logs` 的真相**：后端日志只上 stdout、不落文件（`docs/architecture.md` §3.6 末句）。这一类只盘点**部署端自己**把 stdout 重定向到 `.data/*.log` 时产生的文件，正常部署下恒为 `count: 0`；子目录里的 `*.log` 不算（只认顶层）。
- **`bytes` 口径**：文件取 `stat.size`；案卷按目录内文件递归累加；`queue` 是队列文件 + 同名 `.archive.jsonl`；读不到的条目按 0 算（一个断掉的符号链接不该让整次盘点 500）。
- **`exists`**：路径在不在盘上。缺目录不报错，回 `count: 0`、`bytes: 0`、`exists: false`。
- **每次请求现扫盘**，没有缓存：清完再盘点，数字立刻是清后的（A5）。

**响应**（200，`Cache-Control: no-store`）：

```json
{"data_dir":"/…/.data",
 "stores":[{"kind":"cases","label":"案卷","path":"/…/.data/cases","exists":true,
            "count":2,"bytes":12,"oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"investigations","label":"研判记录","path":"/…/.data/investigations","exists":true,
            "count":2,"bytes":9,"oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"boards","label":"溯源白板","path":"/…/.data/trace-boards","exists":true,"count":1,"bytes":11,
            "oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2020-01-01T00:00:00.000Z"},
           {"kind":"wiki_sessions","label":"知识库会话","path":"/…/.data/wiki-sessions","exists":true,"count":1,"bytes":7,
            "oldest_at":"2026-11-19T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"queue","label":"研判队列","path":"/…/.data/triage-monitor.json","exists":true,"count":2,"bytes":333,
            "oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"logs","label":"日志","path":"/…/.data","exists":true,"count":1,"bytes":9,
            "oldest_at":"2026-11-19T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"config_overrides","label":"配置覆盖层","path":"/…/.data/config-overrides.json","exists":true,
            "count":1,"bytes":33,"oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2020-01-01T00:00:00.000Z"}],
 "total":{"count":10,"bytes":414}}
```

`total` 就是七类 `count` / `bytes` 之和（上面这份样例逐项加起来对得上）。空运行态时七类全 0、`total` 为 `{count:0,bytes:0}`，不报错。

#### 3.7.2 清理（`POST /api/data/cleanup`）

**请求**：`Content-Type: application/json`，正文对象只收五个键（`additionalProperties: false`，多带一个就 400）：

```json
{"kind":"investigations","older_than":"2026-11-01T00:00:00.000Z","keep":200,"action":"archive","execute":false}
```

| 键 | 必填 | 取值 | 缺省 | 语义 |
| --- | --- | --- | --- | --- |
| `kind` | 是 | 七类之一 | — | 与盘点同一套 `kind` |
| `older_than` | 二选一 | ISO 8601 时间串（`Date.parse` 解析得出） | `null` | 条目时刻**早于**它 → 进候选 |
| `keep` | 二选一 | 不小于 0 的整数 | `null` | 保留最新 N 条（按条目时刻倒序），排在后面的进候选 |
| `action` | 否 | `archive` / `delete` | `archive` | 归档或删除 |
| `execute` | 否 | 布尔 | `false` | `false`＝dry-run 只报清单；`true` 才真动盘 |

- **阈值至少给一个**：`older_than` 与 `keep` 都不给回 400——不许无阈值一把抹掉。
- **两条同给取并集**：早于时间的 ∪ 超出数量的，同一「条」不会重复计。
- **`archive` 落到哪**：文件/案卷目录 `rename` 进 `.data/archive/<kind>/<执行时刻>-<原名>`（前缀是 ISO 时间去掉了 `:` 与 `.`，同一路径清两次不会覆盖上一份）；队列记录追加到 `.data/triage-monitor.json.archive.jsonl`（带 `archived_at`，与 TTL 归档 `archiveDone()` 同格式）再移出队列。**归档目录不在七类盘点的任何一类里**，所以盘点数字会降。
- **`delete` 落到哪**：文件/目录 `rm -r`；队列记录从内存与队列文件里删掉，并按 R-TRIAGE-13 同时失效指向它的 `dedupe` 条目（走 `dropRecord()`，`triage-monitor.js:322-330`）。
- **`config_overrides` 的特殊后果**：删/归档只动盘上的覆盖层文件，**进程内的 `env` 仍是旧值**；要回到「按环境变量生效」必须重启进程（覆盖层是启动时同步读进 `env` 的，见 §3.6）。

**已完结案件才可清（A4）**：

| 情形 | 状态 | 行为 |
| --- | --- | --- |
| `queue` 候选里有 `queued` / `running` / `failed` | **409**（`caller_error`） | 整个请求拒绝，内存与队列文件都不动；`error` 原话形如「2 条记录状态不是 done（queued、running），已完结的案件才可清理」 |
| `cases` 候选目录上挂着非 `done` 的记录（记录的 `case_dir` 就是它） | **409** | 同上，一个案卷都不动 |
| 没装配研判队列（没配牧云或模型）时清 `queue` | **503**（`not_configured`） | 不读也不改队列文件——那是另一条进程的状态 |

`failed` 也按「没完结」拒：它还可能被重排（`resumeRetries()`，`triage-monitor.js:306-318`）。要清就先把阈值调窄，或者等它重排/收尾。

没有装配研判队列（`monitor` 为 `null`，没配牧云或模型）时，`cases` 清理不按案件状态拦（没有记录可判）：这时能进候选的就是没有活案件的目录。`queue` 反过来直接 503——它没有内存主人，不许拿队列文件硬删。

**响应**（200）：

```json
{"dry_run":false,"kind":"investigations","action":"delete",
 "threshold":{"older_than":"2026-11-01T00:00:00.000Z","keep":null},
 "candidates":{"count":1,"bytes":7,"items":[{"name":"old.json","bytes":7,"at":"2020-01-01T00:00:00.000Z"}],"truncated":false},
 "applied":{"count":1,"bytes":7},
 "inventory":{"data_dir":"…","stores":[…七类…],"total":{"count":…,"bytes":…}}}
```

| 字段 | 含义 |
| --- | --- |
| `dry_run` | `true`＝没动盘（`execute` 不给或 `false`） |
| `threshold` | 回显请求里的 `older_than` / `keep`（没给为 `null`） |
| `candidates` | 将清清单：`count` / `bytes` 是全量，`items` 最多 100 条（条目时刻从老到新），超出只体现在 `truncated: true` |
| `candidates.items[]` | `{name, bytes, at}`；`queue` 的 `name` 是告警 ID，并多一个 `status: "done"`（能进候选的一律是 done） |
| `applied` | 这次真清掉的条数与字节；dry-run 恒为 `{count:0, bytes:0}` |
| `inventory` | **执行之后**重新扫出来的盘点，与紧接着 `GET /api/data/inventory` 完全一致（dry-run 时就是当下未变的数字） |

**留痕（A3）**：`execute: true` 时落一条 `data.cleaned`，字段只有 `kind` / `action` / `count` / `bytes`——与 `config.updated` 同口径（§3.6「留痕」），**不记文件名、不记记录内容**；dry-run 与校验失败都不落这条：

```json
{"time":"…","level":"info","event":"data.cleaned","kind":"investigations","action":"delete","count":1,"bytes":7}
```

> 这条事件还没进 `docs/architecture.md` §3.6 的事件名表——那张表不在本卡 scope，已在 `coding-reports/P003-T044.md` 的「未决」里申报。

**错误**（四类口径见 §8，路由自己判的一律走 `callerError`）：

| 情形 | 状态 | `code` | 正文 `error`（原话） |
| --- | --- | --- | --- |
| 正文不是 JSON / 过大 | 400 | `caller_error` | 「请求正文不是 JSON」/「请求正文过大」 |
| 正文不是对象 | 400 | `caller_error` | 「请求正文必须是 JSON 对象」 |
| `kind` 不在七类里（或没给） | 400 | `caller_error` | 「要清理的类型只能是 cases、investigations、boards、wiki_sessions、queue、logs、config_overrides」 |
| 带未知参数 | 400 | `caller_error` | 「不认识的参数：surprise」 |
| `action` 不是 archive/delete | 400 | `caller_error` | 「action 只能是 archive 或 delete」 |
| `execute` 不是布尔 | 400 | `caller_error` | 「execute 必须是布尔值」 |
| `older_than` 解析不出时间 | 400 | `caller_error` | 「older_than 必须是可解析的时间（ISO 8601）」 |
| `keep` 不是非负整数 | 400 | `caller_error` | 「keep 必须是不小于 0 的整数」 |
| 两个阈值都没给 | 400 | `caller_error` | 「至少要给一个阈值：older_than（早于某时间）或 keep（保留最新 N 条）」 |
| 候选里有没完结的案件 | 409 | `caller_error` | 「N 条记录状态不是 done（queued、…），已完结的案件才可清理」/「N 个案卷对应的案件还在排或在跑，已完结的案件才可清理」 |
| 没装配研判队列时清 `queue` | 503 | `not_configured` | 「自动研判尚未配置（没有研判队列），无法清理队列」 |
| 没通过 Basic 认证（启用了认证时） | 401 | —（纯文本） | 「需要登录后访问」，见 §4 |

**鉴权**：与其它业务路由同一个 Basic 闸门（§4）。本卡**没有**为清理新增独立令牌（`.env.example` 不在 scope，新增配置键要同步那份文件与启动闸门文档）；防误删靠两层：默认 dry-run + `execute: true` 必须显式给，再加 Basic 认证。

**不做什么**（测试别按这些写期望）：

- 不做页面、不动 `web/**`。
- 不改各 store 的类：`InvestigationStore` / `TraceBoardService` / `WikiWorkbench` 仍然没有删除方法。
- 不自动清理：没有定时器，只有这两个接口（队列的 TTL 归档 `archiveDone()` 是既有能力，不受本卡影响）。
- 不保证「归档后还能从接口读回来」：归档目录只落盘，仓内没有读它的接口；要翻旧案直接看 `.data/archive/**`。
- 队列候选只挑 `done`：`failed` / `queued` / `running` 一律 409，不静默跳过。

**可重放证据**（`evidence/test/P003-T044/data-admin.test.js`，20 条，约 270ms）：

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T044
node --test evidence/test/P003-T044/data-admin.test.js   # 20 条全绿
node --test --test-timeout=60000 --test-force-exit *.test.js   # 根套件 210 条全绿（回归）
bash evidence/test/P003-T044/mutation-round2.sh   # 20 条实现变异逐条打红新断言（断言自证的复现入口）
```

单测全部在 tmp 目录里跑（`mkdtemp`）：替身目录 + 内存队列 + 进程内 HTTP 请求，mtime 用 `utimes` 钉死，不碰真实网络、不碰仓内 `.data/`、不依赖真实时钟。

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

知识库侧同构，只是文案换成「尚未配置知识库管理员凭据」与「知识库管理员凭据无效」（`server.js:870-871`）。

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

**心跳**：每 15000 毫秒写一行 `: heartbeat\n\n`（`server.js:1211`），这是 SSE 的注释行，客户端按协议忽略它。连接关闭时清掉定时器（`server.js:1212`），`finally` 里再清一次并结束响应（`server.js:1218`）。

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
| 长度超过上限 | 请求正文过大 | `server.js:449` |
| 不是合法 JSON | 请求正文不是 JSON | `server.js:464` |

各路由传进去的上限不一样：

| 上限 | 路由 | 出处 |
| --- | --- | --- |
| 8192（缺省） | `PUT /api/agent/triage/control`、`POST /api/wiki/sessions`、`POST /api/agent/investigations` | `server.js:300-305`、`server.js:355-382`、`server.js:406-430` |
| 100000 | `POST /api/triage/rules/validate`、`PUT /api/triage/rules` | `server.js:270-278`、`server.js:280-290` |
| 12000 | `POST /api/wiki/sessions/{id}/messages`、`POST /api/agent/triage/{alertId}/false-positive` | `server.js:706-709`、`server.js:597-632` |
| 8192（显式传值） | `POST /api/wiki/sessions/{id}/publish` | `server.js:715-719` |

### 8.2 正文形状

`readJSON` 只保证「是合法 JSON」，不保证形状。形状由各路由自己判：不传 `expected_revision` 的规则写请求回 400「缺少有效的规则配置版本」（`server.js:967`）；正文不是对象或数组的回 400「请求正文无效」（`server.js:1018`、`server.js:1199`）。

### 8.3 错误怎么翻译：四类，一类一个稳定 code（P003-T024）

业务错误体只有一个出口（`server.js:339-383`），形状固定 `{ "error": "<原话>", "code": "<稳定标识>" }`
（契约在 `openapi.yaml` 的 `components/schemas/Error`）。`code` 只有四个值，类 → 状态码是固定对照：

| 类 | 状态码 | `code` | 谁判的 | 正文 `error` 写什么 |
| --- | --- | --- | --- | --- |
| 调用方传错 | 4xx：400 参数/正文、403 权限、404 不存在、405 方法、409 状态冲突、410 已下线、422 无法溯源 | `caller_error` | 路由自己判出来走 `callerError`（`server.js:364`）；异常自带 4xx `status`（各模块判过的档位，如 `wiki-store.js` 的 400/404/409、`trace-board.js` 的 422）也算这一类 | 校验原话，如「分页参数无效」「告警 ID 无效」 |
| 没配置 | 503 | `not_configured` | 路由开头判依赖在不在，走 `configError`（`server.js:407`） | 点名缺哪个变量/组件，如「未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN」 |
| 上游失败 | 502 | `upstream_error` | `viaCloudwalker` 在异常上打的 `failure: 'upstream'` 标（`server.js:431-437`）；**规则数据只读解析失败**（数据根下 `rules/` 的 Rego、数据根下的 `triage-rules.json`）也归这类 | 上游那句摘要原话：牧云 `/rpc <code>: <message>`、`connect ECONNREFUSED <ip>:<port>`、`模型接口 HTTP <status>: <message>`、`规则库读取失败：rules/<文件>:<行> …` |
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

对外 HTTP 契约在 `openapi.yaml`，声明 42 条路径（`grep -c '^  /' openapi.yaml` → `42`，P003-T044 提交时；P003-T013 提交时是 39，本卡加了两条数据管理路由）。它与 `server.js` 的路由是**分开维护的两份文本**，改路由时两边都要动（这条在 [architecture.md](../architecture.md) 第 11.3 节也记着）。本页只描述 `server.js` 实际跑出来的行为；两边逐条比对不是本卡做的事。

### 9.2 同一类为什么还有多个 4xx，以及还剩下的不齐之处

四类落地后，**类 → 状态码是固定的**，没有再出现「同一类这处 400、那处 502」；但「调用方传错」这一类内部保留了 4xx 的既有档位，
因为它们表达的是不同的调用方结论，前端（`web/src/*`）按档位分流：

| 档位 | 含义 | 出现处举例 |
| --- | --- | --- |
| 400 | 参数/正文/ID 不合法 | 分页参数、正文不是 JSON、`请求正文无效` |
| 403 | 管理令牌不对 | 规则管理员令牌（`server.js:962`）、知识库管理员凭据（`server.js:1153`） |
| 404 | 目标不存在 | 未知 API（`server.js:943-944`）、知识库页面/会话、研判记录、告警事件 |
| 405 | 方法不对（只有提示词入口一处，`server.js:790`） | `POST /api/agent/prompts` |
| 409 | 状态冲突 | 研判未完成不能登记误报（`server.js:793`）、页面版本过期、缺可维护判据页 |
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

`server.js:1354` 的入口判定会先对 `process.argv[1]` 做 `realpathSync`。以 `-` 作入口（stdin 方式跑）时该路径不存在，`realpathSync` 抛 ENOENT，模块在加载阶段就失败。用 `node --input-type=module -e "..."` 执行时 `process.argv[1]` 是 `undefined`，判定短路，不受影响——本页的探针就是这么跑的（见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第 5.1 节）。

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

# 4. P003-T025 的启动闸门与生效值（A1/A2/A3/A4）
node --test evidence/test/P003-T025/config-check.test.js            # 14 条：必填矩阵（含空串）/ 取值非法 / 真进程拒绝启动 / 生效值与机密（五个）/ 键集双向一致
env -i PATH="$PATH" HIDS_HOST=127.0.0.1 HIDS_PORT=18099 node server.js; echo "退出码=$?"
#   ↑ 五项必填一个不给：stderr 逐个列名、退出码 1、不打 server.started
CLOUDWALKER_URL=http://127.0.0.1:1 CLOUDWALKER_API_TOKEN=fake-token-123456 \
LLM_BASE_URL=http://127.0.0.1:1/v1 LLM_API_KEY=fake-key-abcdef LLM_MODEL=fake-model \
HIDS_PORT=18099 HIDS_SYSLOG_PORT=0 node server.js & PID=$!; sleep 1
curl -s 127.0.0.1:18099/api/config; kill $PID
#   ↑ 五项齐才起得来；正文里只有布尔，没有 Token / 密码原文
env -i PATH="$PATH" HIDS_HOST=127.0.0.1 HIDS_PORT=18099 CLOUDWALKER_URL=http://127.0.0.1:1 \
CLOUDWALKER_API_TOKEN=fake-token-123456 LLM_BASE_URL=http://127.0.0.1:1/v1 \
LLM_API_KEY=fake-key-abcdef LLM_MODEL=fake-model HIDS_TRIAGE_INPUT_MODE=pirate node server.js
#   ↑ 取值非法：stderr「配置值无效：HIDS_TRIAGE_INPUT_MODE=pirate（只能是 syslog 或 poll）」、退出码 1、不监听（不许静默按 poll 跑）
```

探针不写任何文件、不连外部服务；它注入替身服务跑真实 HTTP 请求，输出见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第四节。

本页只描述现状。哪一处该改、改成什么样，是评审的活，不在文档范围内。
