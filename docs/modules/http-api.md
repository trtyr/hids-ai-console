---
type: module
id: MOD-HTTP-API
covers: [server.js]
updated: 2026-11-20
---

# HTTP API 模块（http-api）

业务 HTTP 接口的唯一入口。本页讲 `server.js` 这一个文件：它怎么把请求分发到各条路由、怎么判身份、怎么校验入参、怎么把结果封装成响应。

- 模块清单条目：[docs/modules/_breakdown.json](_breakdown.json) 里的 `http-api`
- 全局背景（进程入口、分层依赖、访问边界）：[docs/architecture.md](../architecture.md)
- 行号基准：本页的 `文件:行号` 指向 `server.js` 共 496 行的版本（commit `63f1379`）。改了代码要重新核。P003-T013 新增的误报入口一行与第 3.4 节按本卡提交时的 `server.js` 标号（808 行，见 [evidence/recon/P003-T013.md](../../evidence/recon/P003-T013.md)），其余锚点仍指向 496 行版本。P003-T025 加的两处（§2 的启动闸门与第 3 节路由表的 `GET /api/config`）按 1021 行的 `server.js` 标号（见 [evidence/recon/P003-T025.md](../../evidence/recon/P003-T025.md)）：新代码全部落在文件末尾与 `server.js:612` 一行，前面所有锚点没挪。P003-T029 加的写配置（§3.1 表里 `POST /api/config`、§3.5 的两处小改、新增 §3.6）按 1085 行的 `server.js` 标号（见 [evidence/recon/P003-T029.md](../../evidence/recon/P003-T029.md)）：新代码落在 `server.js:32`、`server.js:65-84`、`server.js:646-650` 与新文件 `config-store.js`，前面所有锚点没挪。P003-T036 加的取消接口（§3 路由表的 `DELETE /api/agent/triage/{alertId}`）按本卡提交时的 `server.js` 标号（`server.js:825-828`，见 [evidence/recon/P003-T036.md](../../evidence/recon/P003-T036.md)）：新代码只在 triage 单条路由那一块加了一个分支，前面所有锚点没挪。P003-T037 并入 P003-T036 之后：`server.js` 仍是 1090 行（只有 triage 装配处一行不同），历史锚点没挪；`triage-monitor.js` 由 860 行涨到 1011 行，本页改到的两处锚点按合并版本重取（`triage-monitor.js:622-631`、`triage-monitor.js:995-1002`），其余行号见 [coding-reports/P003-T037.md](../../coding-reports/P003-T037.md) 的未决小节。P003-T042 的模型分层按 1387 行的 `server.js` 标号（见 [evidence/recon/P003-T042.md](../../evidence/recon/P003-T042.md)）：新增装配在 `server.js:42`（五个角色实例）与 `configSummary` 的 `model.roles`（`server.js:1355`），`applyLiveConfig` 涨到 `server.js:74-95`，路由行号整体 +5（`GET /api/config` 在 `server.js:871`、`POST` 在 `server.js:875-879`）；§3.5 与 §3.6 的表与样例已按本卡更新，其余章节的旧锚点没挪。P003-T046 新增的研判回放（§3.1 表里 `GET /api/agent/investigations/{alertId}/replay`、新增 §3.10）按本卡提交时 1466 行的 `server.js` 标号（回放分支 `server.js:1301-1312`、既有单条研判阅读分支 `server.js:1313-1321`），其余章节的旧锚点本轮没动。P003-T047 收掉两个维护者、换成统一维护 Agent（新增 `fp-maintainer.js` 与两条会话查询路由），按本卡提交时 1486 行的 `server.js` 标号
（误报路由 `server.js:1134-1191`、维护侧映射 `server.js:325-356`、会话查询 `server.js:1040-1053`、`createServer` 新增三个注入参数在 `server.js:851-852`），
`wiki-workbench.js` 由 355 行涨到 386 行（`recordPublished` 在 `:365-396`），其余章节的旧锚点本轮没动。P003-T030 只重取了 §3.1 路由表里 `POST /api/agent/triage/{alertId}` 那一格的行号（`server.js:826` → `server.js:1169-1179`，按本卡提交时 1449 行的 `server.js`，见 [evidence/recon/P003-T030.md](../../evidence/recon/P003-T030.md)），并新增 §3.9；本轮没改代码，其余锚点一律未动。
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
| 运行态目录 `runtime`（7 条路径） | `server.js:28`、`server.js:1359-1370` | 根由 `HIDS_DATA_DIR` 定，没设就是 `~/.local/share/hids-ai-console/`（§8.1）；**不在仓库内** |
| 监听地址与端口 | `server.js:28-29` | `HIDS_HOST` 缺省 `127.0.0.1`，`HIDS_PORT` 缺省 `8080` |
| 牧云网关 `gateway` 与 API 工具箱 `apiToolbox` | `server.js:30-34` | 牧云地址或 Token 缺一个 → 两者为 `null` |
| 模型五个角色实例 `models` 与两个研判器 | `server.js:40-42`、`server.js:50-53` | `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 缺任一项 → `models` 为 `null`（五个角色都不建），两个研判器也是 `null`。P003-T042：研判=`models.triage`、独立复核=`models.review`、规则维护者=`models.rule_maintainer`、wiki 维护者=`models.wiki_maintainer`、溯源白板=`models.trace_board`；新键不设时逐键回退主判（§3.5 的 `model.roles`） |
| 研判记录、规则集、研判队列、判据工作台、溯源白板 | `server.js:46-59`、`server.js:126` | 队列要 `gateway` 与研判器、白板要 MCP 工具箱与模型，缺任一则该件为 `null` |

运行态路径的默认值全出自导出的 `runtimePaths(root = dataRoot())`（`server.js:1359-1370`，单测直接拿它对照）：`data` / `investigations` / `triageRules` / `triageMonitor` / `cases` / `wikiSessions` / `traceBoards` 七条，根由 `dataRoot()`（`config-store.js:33`）算：`HIDS_DATA_DIR` 指向哪就落哪，没设就是 `~/.local/share/hids-ai-console/`。**仓库里一个字都不写。** P003-T043 砍掉了原来的 `baseline` / `intel` 两键（研判背景改走判据库 `common/GEN-13.md` 与规则层，见 [triage-pipeline.md](triage-pipeline.md) §6.2）。整仓规则的完整说明在 [architecture.md](../architecture.md) 第 8.1 节。

**`createServer` 是依赖注入点**（`server.js:815-820`）：18 个参数都带默认值，默认指向模块级单例。测试与探针靠传替身换掉 `service`、`investigator`、`history`、`monitor`、`wiki`、`wikiAgent` 这些件。其中 `monitor` 与 `boardService` 的默认值写成「`service` 是不是模块级 `gateway`」的条件式——换了 `service`，就不再挂默认的研判队列与溯源白板。

**规则预筛挂在 `investigate()` 闭包上**（`server.js:859-875`）：`mode === 'triage'` 且 `monitor.ruleEngine` 存在时，先跑一次规则评估，把结果作为 `rule_evaluation` 挂到结论上；评估抛错就记成 `{ status: 'error' }` 继续往下走，不中断研判。回灌模型的那份（`options.ruleEvaluation`）带 `reason` 原文，**落盘副本**（`result.rule_evaluation`）的 `reason` 过记录侧闸，只留固定文案 + 原文字符量（P003-T054，与队列侧 `triage-monitor.js:1046-1047` 同口径）。落点随入口不同：syslog 推送路径进案件 `result.json` 与研判记录；本页这条 HTTP 深度研判只写研判记录（`server.js:1332` 走 `history.save`，不产 `result.json`）。

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

44 条「路径 + 方法」组合：「前置条件」写的是这条路由在缺件时的表现；「出处」是该分支所在的行。
P003-T045 加了两条日志路由（`GET /api/logs`、`POST /api/logs/cleanup`，见 §3.8）：41 → 43；P003-T046 加了一条研判回放路由（`GET /api/agent/investigations/{alertId}/replay`，见 §3.10）：43 → 44。

> 比历史版本多的四条：P003-T011 的三条 Rego 规则路由（`/api/rules`、`/api/rules/evaluate`、`/api/rules/{id}`）与 P003-T013 的误报入口。
P003-T047 又加了两条误报维护会话查询（`/api/false-positive/sessions`、`/api/false-positive/sessions/{id}`）。P003-T029 又加了一条 `POST /api/config`（写配置，见 §3.6）。P003-T041 把规则维护做成正式接口，补了 `PUT /api/rules/{id}`、`GET /api/rules/{id}/history`、`POST /api/rules/{id}/rollback`、`GET /api/rules/sessions` 四条。
> `grep -n "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js` 数的是**分支条件行数**（当前 45 行；P003-T045 的两条日志路由、P003-T046 的回放路由各占一行），不是组合数：一行可以给出多条组合（`server.js:1166` 的 `/api/agent/triage/{alertId}` 给 GET / POST / DELETE 三条），也有行不算组合（`server.js:1191` 只是 `/api/wiki/` 分组入口）。数之前先分清这两种。

| 方法 | 路径 | 成功状态 | 前置条件 | 出处 |
| --- | --- | --- | --- | --- |
| GET | `/api/session` | 200 `{authenticated:true, user, role}` | — | `server.js:208-214` |
| GET | `/api/config` | 200 生效配置（`{host, port, triage_input_mode, cloudwalker, model, auth, secrets, missing_required}`；`model` 段含 `roles`） | —（只读环境变量：不探上游、不因缺件 503；机密只在 `secrets` 里给布尔） | `server.js:871` |
| POST | `/api/config` | 200 `{updated, config}`（写配置，见 §3.6） | 只收可写十一键（含 P003-T042 的复核组 / 轻量组六键）；正文不是 JSON / 键不可写 / 值不合法回 400；落盘失败回 500 | `server.js:875-879` |
| GET | `/api/data/inventory` | 200 七类存储的条数与字节（`{data_dir, stores, total}`，见 §3.7） | —（只读本地运行态目录：不探上游、不碰模型，缺目录按 0 报，不 503） | `server.js:864` |
| POST | `/api/data/cleanup` | 200 `{dry_run, kind, action, threshold, candidates, applied, inventory}`（见 §3.7） | 默认 dry-run；`kind` / 阈值 / 动作 / `execute` 不合法回 400；候选里有没完结的案件回 409；没装配研判队列时清 `queue` 回 503 | `server.js:866-870` |
| GET | `/api/logs` | 200 `{logs, total, files, truncated, echo}`（见 §3.8） | 没配 `HIDS_LOG_FILE` 回 503 `not_configured`（日志只上 stdout，没文件可读）；分页 / `level` / `from` / `to` 不合法回 400。**读的是盘上的文件** | `server.js:929-938` |
| POST | `/api/logs/cleanup` | 200 `{dry_run, threshold, candidates, applied, remaining}`（见 §3.8） | 没配 `HIDS_LOG_FILE` 回 503；阈值一条都不给 / `execute` 非布尔 / 未知参数回 400；默认 dry-run，只清轮转出的历史文件 | `server.js:940-944` |
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
| POST | `/api/agent/triage/{alertId}` | 202 `TriageCase`（**现查告警送研判也走这一条**：按牧云事件 ID 入队） | 无研判队列回 503；队列（排队 + 在跑）已达 `HIDS_TRIAGE_QUEUE_MAX` 回 429「研判队列已满（上限 N），稍后再试」并计入 `summary().dropped`；同一 alert ID 只有一条记录——排队中重复 POST 幂等、在跑中不重启、已完成/失败的按人工重试重跑（详见 §3.9） | `server.js:1169-1179` |
| DELETE | `/api/agent/triage/{alertId}` | 200 `{alert_id, status:"not_queued", cancelled:true}`（取消排队中的记录） | 无研判队列回 503；没有这条记录回 404；已在研判中或已完成（running / done）回 409 | `server.js:828-831` |
| POST | `/api/agent/triage/{alertId}/false-positive` | 202（结论已落盘为误报，统一维护 Agent 开始；正文 `{reason, who?, libraries?}`，`libraries` 是补跑选择器） | 无研判队列回 503；理由不符格式、`libraries` 不是 `rule`/`wiki` 组成的非空数组回 400；无此案件回 404；研判未完成回 409 | `server.js:1134-1191` |
| GET | `/api/false-positive/sessions` | 200 `{sessions}`（误报维护会话摘要，按 `updated_at` 倒序；含 `status`/`terminal`/`libraries`/`sides`/`decision_source`，不含案卷快照与模型正文） | 会话目录不可读回 502 | `server.js:1039-1043` |
| GET | `/api/false-positive/sessions/{id}` | 200（整份维护会话：`turns[]`、`messages[]`、`decision`、`outcomes`、`validation`、`auto_verdict`）/ 404 | ID 不是 36 位 UUID 回 400；会话目录不可读回 502 | `server.js:1044-1053` |
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
| GET | `/api/agent/investigations/{alertId}` | 200 / 404 | — | `server.js:1313-1321` |
| GET | `/api/agent/investigations/{alertId}/replay` | 200 / 404 | 排在上面那条之前；读已保存的研判记录与证据，不重放模型（见 §3.10） | `server.js:1301-1312` |
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
| `validAlertId` | `<小写类型>:<正整数>`，类型须在事件类型表里，序号须是安全整数 | `GET /api/agent/investigations/{alertId}`（`mode=deep` 时）、`GET /api/agent/investigations/{alertId}/replay`（`mode=deep` 时）、单条告警路由的类型段 | `server.js:489-493` |
| `validTriageId` | `validAlertId`，或 syslog 形态 `syslog:<类型>:<16 位十六进制>:<数字或 unknown>:<36 位 UUID>` | `GET/POST /api/agent/triage/{alertId}`、`POST /api/agent/triage/{alertId}/false-positive`、`GET /api/agent/investigations/{alertId}` 与 `/replay`（`mode=triage` 时） | `server.js:492-494` |
| `validTraceTarget` | 告警 ID，或去掉 `ip:` 前缀后的 IPv4（每段 ≤ 255） | 溯源白板三条路由 | `server.js:116-256` |

解码失败与校验失败给的是不同的文案：解码失败回「告警 ID 编码无效」，校验失败回「告警 ID 无效」或「告警 ID 或研判模式无效」。

### 3.4 误报登记与统一维护 Agent（P003-T013 立，P003-T047 收成一个 Agent）

**关键路径**：`server.js:1134-1191`（误报路由）、`server.js:325-356`（会话 outcomes → `record.maintenance` 的映射）、
`fp-maintainer.js:163-470`（统一维护 Agent：四轮会话 + 补跑幂等 + 自校验）、`server.js:236-313`（规则维护者 `RegoRuleMaintainer`）、
`fp-maintainer.js:62-73`（知识库目标页口径）、`wiki-workbench.js:365-396`（发布后置终态）。

**入口**：`POST /api/agent/triage/{alertId}/false-positive`，正文 `{reason, who?, libraries?}`。「分析员把这一条判成误报」只走这一个入口：
理由必填（10 到 4000 字），登记人省略时取业务账号名，没配 Basic 认证时是 `operator`（登记人至少 2 字）。
`libraries` 是可选的补跑选择器（`["rule"]` / `["wiki"]` / 两项都给），不填＝两侧都试，口径见本节「补跑与幂等」。

**先结论，后维护**（A1）：路由先改记录——`verdict=false_positive`、`verdict_label=误报`、`decision_source=human`、
`feedback{reason,who,recorded_at}`，`await monitor.persist()` 落盘之后才回 202（`server.js:1155-1176`）。
维护 Agent 这时才在后台起跑，响应不等它；维护还没跑完时 `GET /api/agent/triage/{alertId}` 已经是误报。

| 情况 | 状态 | 正文 |
| --- | --- | --- |
| 结论已落盘，维护开始 / 已在跑 | 202 | `{alert_id, verdict, feedback, maintenance}` |
| 理由短于 10 字或长于 4000、登记人短于 2 字、正文不是对象、ID 编码或格式无效 | 400 | 对应文案 |
| `libraries` 不是数组、空数组、含 `rule` / `wiki` 之外的值 | 400 | 维护库必须是 rule 或 wiki 组成的一到两项 |
| `libraries` 含重复项（如 `["rule","rule"]`） | 400 | 维护库不能重复（libraries 每一项只能出现一次） |
| 没有这条研判记录 | 404 | 找不到这条研判案件 |
| 记录 `status !== 'done'`（还在排队或跑着） | 409 | 研判还没结束，不能登记误报 |
| 研判队列未配置 | 503 | 自动研判尚未配置 |

`409` 的边界只在「已完成」上登记。**重跑不覆盖人工结论**（P003-T018）：`POST /api/agent/triage/{alertId}`（`retry:true`）重排一条已登记误报的记录时，
`enqueue()` 把 `verdict` / `verdict_label` / `summary` / `decision_source` / `feedback` 带到新记录上（`triage-monitor.js:622-631`）；
`run()` 收尾看到 `verdict === 'false_positive'` 且 `decision_source === 'human'` 就不写这四件（`triage-monitor.js:995-1002`），
报告 / 证据 / 缺证 / 下一步 / `saved_at` 照常按这次研判刷新。**AI 自己判出的 `false_positive` 不算人工登记**，重跑照旧被这次研判覆盖。

**一个 Agent，四轮会话**（P003-T047 A1）：维护不再是两个维护者各跑各的，而是 `FalsePositiveMaintainer` 一个案件跑一份多轮会话，
每轮推进都落盘到 `<数据根>/fp-sessions/<uuid>.json`（形制对齐 `wiki-sessions`：`messages[]` 记人读得懂的一段话，`turns[]` 记程序走到第几轮）：

| 轮 | `turns[].phase` | 干什么 | 落进会话的东西 |
| --- | --- | --- | --- |
| 1 | `case` | 读案卷：`01-原始告警.txt`、`03-研判事实.md`、`result.json`（结论 / 命中规则 id / 引用过的判据页） | `messages[].kind='case'`（各截 2000 / 4000 字） |
| 2 | `libraries` | 读两库：规则库清单 + 命中规则的 Rego 原文；知识库目标页正文与同场景其他页 | `messages[].kind='libraries'` |
| 3 | `propose` | 提修订：这一次动哪几边、为什么（一次模型调用，域＝误报维护） | `decision{source, libraries, why}` + `messages[].kind='decision'` |
| 4 | `verify` | 写入 + 自校验：写完之后按库读回版本、规则旧版是否进了历史、知识库会话是否已终态 | `outcomes{rule, wiki}`、`validation{ok, checks}`、`messages[].kind='verify'` |

会话终态三种：`done`（请求的库都收尾）、`partial`（有一侧失败、另一侧成功）、`failed`（请求的侧全失败）。`terminal: true` 之后不会再有自动写入。
读会话的两条路在 §3.1：`GET /api/false-positive/sessions`（摘要）与 `GET /api/false-positive/sessions/{id}`（全文）。

**动哪边、为什么**（A2）：决策轮**只决定「动哪几本库、为什么」**，不写规则正文也不写判据正文——
规则正文由规则维护者产出、判据正文由知识维护者产出，写入路径与 P003-T013 一模一样。三条路径各自的落点：

| 决策 | 规则侧 outcome | 知识库侧 outcome | `record.maintenance.sides` |
| --- | --- | --- | --- |
| 只动规则 | `state: updated` | `state: no_change`（`why` 记决策理由） | `["rule"]` |
| 只动知识库 | `state: no_change` | `state: updated` | `["wiki"]` |
| 两边都动 | `state: updated` | `state: updated` | `["rule", "wiki"]` |

`decision.source` 只有三个值（`fp-maintainer.js` 的 `FP_DECISION_SOURCES` 与 openapi 的 enum 是同一份）：`model`（决策模型给的）、
`fallback`（没配决策模型 / 决策模型回包解不出来时，按请求的库逐个尝试）、`idempotent`（请求的库都已在同一版本上维护过——
这一轮不写盘、不调决策模型，见本节「补跑与幂等」）。
决策模型复用规则维护者那一格（`HIDS_LLM_MODEL_RULE_MAINTAINER` → `LLM_*` 回退），提示词是 `prompts/false-positive.md`，**不新增配置键**。

**写入只有两条老路**（A3）：Agent 自己不碰 `rules/` 与 `wiki/`，两条写入都走 P003-T041 的维护接口。

规则侧：`RegoRuleMaintainer` 用模型 + `prompts/rule-maintenance.md`（`prompt-store.js:18` 的 `coreFiles.rule`）产出一份 `.rego`，
写盘只经 `RuleStore.save()`——校验、旧版进 `<数据根>/rules-history/<id>-<rev>.rego`、原子替换都在那里（`rule-store.js:249-300`）。
`updated` 的含义：那一份文件已写入，并通过 `RuleStore` 解析与整库装载。三道校验全在写盘之前：临时目录里 `new RuleStore(目录).read(id)`
拦子集外语法与 id/package 不一致；**改已有规则时不许放宽原有限制条件**（判据见下）；写盘后再 `new RuleStore(目录).list()` 拦重复 id。
过不了就不写，目录里不留临时文件，已有规则一字不动。它一次只碰一个文件：已有规则的 id 住在别的文件名里时，改的就是那份文件。

**不许放宽（P003-T020，A1）**：`output.id` 命中已有规则时，那条规则的每一条旧条件都要在候选正文里找到一条「至少同样严」的新条件
（`server.js:170-210`：`ruleExpressions` 抽 `match if { }` 体内的行，`atLeastAsStrict` 逐条比，`widenedConditions` 一对一配对）。认不出的行按「无法证明没放宽」处理，
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

拒绝时 `maintain()` 抛 `规则修订放宽了原有限制条件，拒绝落盘：<被放宽的那几行，；分隔，截 200 字>`，Agent 按既有失败通道
写进 `maintenance.rule.error`（截 300 字）并把这一边判 `failed`——**规则文件一个字节都不变**，`verdict` / `feedback` 也不动。
新增规则（`output.id` 与现有规则不重名）不走这条：没有原条件可放宽。

**删条件一律算放宽，连「撤销一条已有的 `not`」也算**：校验只看得见盘上的规则正文，分不清一条排除是安全限制还是现场测试留下的，
所以按 fail closed 处理——那类改动得人工改文件（本次 `rules/webshell_drop.rego` 的 `hids-live-test` 排除就是人工撤的）。
代价写在这里免得后面误读：**维护者只能把规则改严，改宽一律拒绝**。

知识库侧：走知识维护会话（`wikiAgent.create` + 一轮 `reply`），再把草案用 `publishBundle`（发布闸：结构、断链、证据引用、页面版本）
写进判据页；**写完再 `recordPublished()` 把会话置终态 `published`**（`wiki-workbench.js:365-396`）——已发布的会话再发布一次直接 409，
这就是「无重复发布口子」。只出草案、页没写上就算 `failed`。选页口径与 `POST /api/wiki/sessions` 共用 `wikiFeedbackTarget`
（`fp-maintainer.js:62-73`）：优先分析时引用过的判据页，其次本场景第一页。审计字段里 `reviewer` 记登记人、`note` 记他给的理由、`via` 记 `fp_maintainer`。

「页没写上」不能再是一个光秃秃的状态词（P003-T021）：带 `feedback` 的回合里维护者真没改判据时，`reply` 以 502 抛错，正文就是**为什么没改**——
`知识库维护未改判据（data_gap·数据缺口）：判据本身未发现错误；后续由「Syslog 解析、牧云事件匹配与取证接口」处置`
（诊断、`rationale` 原文、后续责任方，整条 ≤300 字，`wiki-workbench.js:31`）。Agent 把这条 message 原封写进
`maintenance.wiki.error`，所以运维看到的仍是「为什么没改」而不是「状态 needs_non_wiki_fix」。`needs_non_wiki_fix` 这个会话状态照旧落在
`WikiWorkbench` 的会话记录里（诊断与 `follow_up` 都在），只是这一轮同时算维护失败。

**状态两格：`status` 与 `state`**（A4）：`maintenance.<边>.status` 仍只有三个值——`updating` / `updated` / `failed`，总态与单边态同一套
（`server.js:154-157`）。P003-T047 新增的两类结果（`no_change` 没动这侧 / `skipped` 幂等跳过 / `updated` 真写了）落在 `maintenance.<边>.state` 上，
`status` 照旧是 `updated`（这一边已收尾、不需要人工介入）——老客户端只读 `status` 不会读错，新客户端看 `state` 知道到底动没动。

- 还有一边在跑 → 总态 `updating`；
- 都收尾后，任一边 `failed` → 总态 `failed`；
- 否则 `updated`。

失败只写 `maintenance.rule.error` / `maintenance.wiki.error`（各截 300 字），**`verdict` 与 `feedback` 一个字节都不动**。
两条 error 在**写之前**过一道凭据擦除（`Basic` / `Bearer` 凭据、`token=` / `api_key=` / `password=` / `secret=` 的值换 `[redacted]`，
`fp-maintainer.js` 的 `scrubCredentials`）：上游 401 / 网络错误会把请求头拼进文案，而这两格会随 `triage-monitor.json` 落盘并随
`GET /api/agent/triage/{alertId}` 外发。

**补跑与幂等**（A4）：同一案件再 POST 一次就是补跑入口，`libraries` 决定只跑哪一侧（不填＝两侧都试，仍受幂等约束）。
判据是**这一条案件上一轮的 `record.maintenance`**（落盘在 `triage-monitor.json` 里，进程重启后还在；不扫会话目录，不会跨案件串味）：
某一侧上一轮 `state: 'updated'` 且它记下的 `revision` 等于这一轮算出来的库版本 → 这一轮记 `state: 'skipped'`，
**不调模型、不写盘**（`fp-maintainer.js:398-417`）。幂等键是三段：`case_id:库:版本`（`maintenance.<边>.idempotency_key`）——

- 规则侧的「版本」是**规则库摘要**：有案件命中的规则就只算那几条的 `id:revision`，没有就整库算，sha256 前 16 位；
- 知识库侧的「版本」是目标判据页的 `revision`。

某一侧上一轮是 `state: 'skipped'`（单腿补跑时没请求它、或它当轮被幂等跳过）但**记着 `revision`** 时，同样按「已成功过」处理：
判据看的是「这一侧在同一库版本上成功过」，不是「上一轮恰好跑了它」。单腿补跑时没请求的那一侧记
`status: 'updated'` + `state: 'skipped'` + `why: 本次只补跑 …`，**并且原样保住上一轮的 `revision` / `idempotency_key`
（以及规则侧的文件名、知识库侧的页面）**——它们下一次全量登记时就是「已成功一侧不重复执行」的判据；
既不谎报「改完了」，也不把总态永久钉在 `updating`，还不会把幂等判据洗掉（成功 → 单腿 → 全量 这条序列上仍然只跑一次）。

失败的一侧照常重跑（`state: 'failed'` 不构成跳过），补跑成功后它自己的 `revision` 也换成新一轮的。

**闭环自动判定以 Rego 为准**（A7，A/B 已拍板）：`maintenance.auto_verdict` 恒为
`{enabled: true, criterion: "rego", trust: "single", note: …}`——
自动判定的生效判据是 **Rego 规则库**：研判管线读的和规则维护写的是同一本库（同源），信任链只走这一条（单源）；
JSON 规则集（`triage-rules.json`）的修订照写留痕，但**不是**生效判据。Agent 的维护产出照写（规则 / 判据页该改就改），
会话里同一格原样留档，回头看能说清「当时按哪条口径生效」。

**每轮 AI 调用都进事件**（A5）：决策轮（`role: fp_maintainer`，`phase: propose`）、规则维护轮（`role: rule_maintainer`）、
知识库维护轮（`role: wiki_maintainer`）统一记 `event=ai.model_call`、`domain=false_positive`（误报维护域）。
决策轮与规则维护轮带误报维护会话 id，知识维护轮带它自己那份 wiki 维护会话 id（那一份 id 就记在误报会话的 wiki outcome 上）。

维护状态随记录一起 `persist()`，所以 `GET /api/agent/triage/{alertId}` 能读到同一组字段。同一轮维护还在本进程里跑时再次登记只回当前进度，
不重起一轮（`server.js:1160`）；挡它的是 `runningMaintenance` 集合（`server.js:872`）——**不是**记录上的 `maintenance.status`：
进程重启后记录会停在 `updating`，拿那个当锁会把案件永久锁死。重启后的残留不挡重新登记，但也不会自动恢复（见 P003-T013 报告「未决」）。

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
- **空串不能用来「删键」**：值必须是非空字符串，空串/空白串回 400。覆盖层只能新增/改值、不能删键；要清掉改过的值，用 P003-T044 的数据管理接口删掉覆盖层（`POST /api/data/cleanup`，`kind: config_overrides`，见 §3.7），或手工删数据根下的 `config-overrides.json`——两种都要**重启进程**才回到「按环境变量生效」，因为覆盖层是启动时同步读进 `env` 的。

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

**它管什么**：给运维一眼看清数据根（`HIDS_DATA_DIR` / `~/.local/share/hids-ai-console`，见 §2）下七类运行态各占多少，再按类型与阈值把老数据**归档或删除**。**不管**页面（`web/**` 不在本卡 scope）、不管各 store 的类（`investigation-store.js` 等仍然没有删除方法——清理是文件系统层的运维动作）、不新增配置键、不引入自动清理定时器。

#### 3.7.1 七类存储与「一条」的口径

`kind` 的枚举顺序就是响应里 `stores[]` 的顺序，测试按它写期望：

| `kind` | 中文 | 路径来源（缺省值） | 什么算「一条」 | 条目时刻（`oldest_at` / `newest_at` / 排序） | 单位 |
| --- | --- | --- | --- | --- | --- |
| `cases` | 案卷 | `monitor.casesDirectory` → `HIDS_CASES_DIR` → `<数据根>/cases` | 一级子目录（一个案件目录） | 目录内**文件**的最新 mtime；空目录退回目录自身 mtime | 个案卷 |
| `investigations` | 研判记录 | `history.directory` → `<数据根>/investigations` | 一个 `*.json` | 文件 mtime | 个文件 |
| `boards` | 溯源白板 | `boardService.directory` → `<数据根>/trace-boards` | 一个 `*.json` | 文件 mtime | 个文件 |
| `wiki_sessions` | 知识库会话 | `wikiAgent.directory` → `<数据根>/wiki-sessions` | 一个 `*.json` | 文件 mtime | 个文件 |
| `queue` | 研判队列 | `monitor.file` → `<数据根>/triage-monitor.json` | 一条队列记录 | 记录上 `updated_at` → `saved_at` → `created_at` 第一个能解析的 | 条记录 |
| `logs` | 日志 | `HIDS_LOG_FILE` 的目录（缺省＝数据根） | 该目录**顶层**的一个 `*.log`（当前活动文件 + 轮转出的历史文件） | 文件 mtime | 个文件 |
| `config_overrides` | 配置覆盖层 | `config.file` → `<数据根>/config-overrides.json` | 那一个文件（0 或 1） | 文件 mtime | 个文件 |

表注：这一列说的是「一条」怎么数——案卷按一级子目录数，其余按文件数或队列记录数。
- **路径全部取自注入件**（`createServer` 的 `history` / `monitor` / `boardService` / `wikiAgent` / `config`）：换替身就是换盘点对象，测试不必碰真实数据根。响应里的 `data_dir` 取配置覆盖层文件所在目录（`config.file` 的 `dirname`），缺省就是数据根。
- **`logs` 的真相**（P003-T045 起）：后端**配了 `HIDS_LOG_FILE` 就落文件**，不配仍只上 stdout（见 §3.8）。所以这一类现在有两拨来源：进程自己写的 `*.log`（含轮转出的 `<名>.<时刻>.log`），以及部署端把 stdout 重定向到同目录时产生的文件。**没配 `HIDS_LOG_FILE` 的正常部署恒为 `count: 0`**；子目录里的 `*.log` 不算（只认顶层）。
- **`bytes` 口径**：文件取 `stat.size`；案卷按目录内文件递归累加；`queue` 是队列文件 + 同名 `.archive.jsonl`；读不到的条目按 0 算（一个断掉的符号链接不该让整次盘点 500）。
- **`exists`**：路径在不在盘上。缺目录不报错，回 `count: 0`、`bytes: 0`、`exists: false`。
- **每次请求现扫盘**，没有缓存：清完再盘点，数字立刻是清后的（A5）。

**响应**（200，`Cache-Control: no-store`）：

```json
{"data_dir":"/home/ops/.local/share/hids-ai-console",
 "stores":[{"kind":"cases","label":"案卷","path":"/home/ops/.local/share/hids-ai-console/cases","exists":true,
            "count":2,"bytes":12,"oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"investigations","label":"研判记录","path":"/home/ops/.local/share/hids-ai-console/investigations","exists":true,
            "count":2,"bytes":9,"oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"boards","label":"溯源白板","path":"/home/ops/.local/share/hids-ai-console/trace-boards","exists":true,"count":1,"bytes":11,
            "oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2020-01-01T00:00:00.000Z"},
           {"kind":"wiki_sessions","label":"知识库会话","path":"/home/ops/.local/share/hids-ai-console/wiki-sessions","exists":true,"count":1,"bytes":7,
            "oldest_at":"2026-11-19T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"queue","label":"研判队列","path":"/home/ops/.local/share/hids-ai-console/triage-monitor.json","exists":true,"count":2,"bytes":333,
            "oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"logs","label":"日志","path":"/home/ops/.local/share/hids-ai-console","exists":true,"count":1,"bytes":9,
            "oldest_at":"2026-11-19T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"},
           {"kind":"config_overrides","label":"配置覆盖层","path":"/home/ops/.local/share/hids-ai-console/config-overrides.json","exists":true,
            "count":1,"bytes":33,"oldest_at":"2020-01-01T00:00:00.000Z","newest_at":"2026-11-19T00:00:00.000Z"}],
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
- **`archive` 落到哪**：文件/案卷目录 `rename` 进 `<数据根>/archive/<kind>/<执行时刻>-<原名>`（前缀是 ISO 时间去掉了 `:` 与 `.`，同一路径清两次不会覆盖上一份）；队列记录追加到 `<数据根>/triage-monitor.json.archive.jsonl`（带 `archived_at`，与 TTL 归档 `archiveDone()` 同格式）再移出队列。**归档目录不在七类盘点的任何一类里**，所以盘点数字会降。
- **`delete` 落到哪**：文件/目录 `rm -r`；队列记录从内存与队列文件里删掉，并按 triage-pipeline 页「删记录必须同时失效 `dedupe` 条目」那条承诺（[triage-pipeline.md](triage-pipeline.md) 第 10 节）同时失效指向它的 `dedupe` 条目（走 `dropRecord()`，`triage-monitor.js:322-330`）。
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
- 不保证「归档后还能从接口读回来」：归档目录只落盘，没有读它的接口；要翻旧案直接看数据根下的 `archive/**`。
- 队列候选只挑 `done`：`failed` / `queued` / `running` 一律 409，不静默跳过。

**可重放证据**（`evidence/test/P003-T044/data-admin.test.js`，20 条，约 270ms）：

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T044
node --test evidence/test/P003-T044/data-admin.test.js   # 20 条全绿
node --test --test-timeout=60000 --test-force-exit *.test.js   # 根套件 210 条全绿（回归）
bash evidence/test/P003-T044/mutation-round2.sh   # 20 条实现变异逐条打红新断言（断言自证的复现入口）
```

单测全部在 tmp 目录里跑（`mkdtemp`）：替身目录 + 内存队列 + 进程内 HTTP 请求，mtime 用 `utimes` 钉死，不碰真实网络、不碰真实数据根、不依赖真实时钟。

### 3.8 日志落盘与查询清理（`GET /api/logs`、`POST /api/logs/cleanup`，P003-T045）

**关键路径**：两个分支在 `server.js:929-944`；参数解析 `logQuery()` 在 `server.js:582-597`，清理入口 `logCleanup()` 在 `server.js:838-860`；文件侧全部在 `log.js`：env 解析 `logFileOptions()`（`log.js:89-94`）、文件 sink 与轮转 `createFileSink()`（`log.js:129-155`）、改 journal `useLogFile()`（`log.js:157-162`）、列文件 `logFiles()`（`log.js:112-124`）、查询 `readLogEntries()`（`log.js:177-205`）、清理 `pruneLogFiles()`（`log.js:207-231`）。装 sink 的两行在 `server.js:31-32`（**在 `createConfigStore` 之前**）。OpenAPI 契约见 `openapi.yaml` 的 `getLogs` / `cleanLogs`。

**它管什么**：把「日志只上 stdout」扩成**可选落盘**——配了路径就同份写文件、单文件超限轮转、历史按份数自动清；再给两个接口让人按事件名/级别/时间翻日志、按时间或总大小清旧文件。**不管**页面（`web/**` 不在 scope）、不管日志内容本身（事件名表在 [architecture.md](../architecture.md) §3.6）、不引入日志依赖（只用 `node:fs`）。

#### 3.8.1 落盘：三个配置键与文件布局

| 键 | 缺省 | 作用 | 不配 / 非法时 |
| --- | --- | --- | --- |
| `HIDS_LOG_FILE` | 空 | 日志文件路径（相对路径按进程 cwd 绝对化） | **空／纯空白＝不落文件**，行为与 P003-T023 起完全一样（只上 stdout） |
| `HIDS_LOG_MAX_BYTES` | `10485760`（10 MiB） | 单文件字节上限，超了就轮转 | 0 / 负数 / 小数 / 非数回落缺省（`positiveInt()`，`log.js:82-85`） |
| `HIDS_LOG_KEEP` | `5` | 轮转出的历史文件最多留几份 | 同上回落缺省 |

- 三个键都**不进启动闸门**（`configSummary` 的八键形状不变）：不配是合法部署。
- **同份**：同一行既给 stdout 又给文件，逐字相同；先写文件再写 stdout（sink 自己吞异常，stdout 断了不至于让文件那份丢，`log.js:157-162`）。
- **轮转命名**：`<名>.<2026-11-20T02-44-01-123Z><扩展名>`，落在**同一个目录**（`hids.log` → `hids.2026-11-20T02-44-01-123Z.log`）。同一毫秒轮转两次时后加 `-1`、`-2`（`log.js:102-108`）。轮转出的文件仍以 `.log` 结尾，所以 §3.7 的 `logs` 盘点看得见它们。
- **轮转时机**：写之前判 `已有字节 + 这一行 > 上限`，且**文件非空**才轮转——**当前这一行写进轮转后的新文件，不丢**（`log.js:129-155`）。反过来：一行本身就比上限大时，空文件不轮转，照样写进去（单文件可以超上限）。
- **重启接续**：进程起来后 sink 第一次写之前先 `stat` 现有文件，按盘上大小接着算——不会把老内容当 0 从头上限。
- **目录**建不出来就退化成只上 stdout；写盘失败（盘满、权限、rename 失败）一律吞掉，不改上抛业务。

#### 3.8.2 查询 `GET /api/logs`

**读的是盘上的文件**：当前活动文件 + 轮转出的历史文件，现读现解析（没有内存缓存，也没有索引）。

| 参数 | 缺省 | 合法值 | 不合法时 |
| --- | --- | --- | --- |
| `count` | 20 | 1 到 50 的整数 | 400「分页参数无效」（§7 同一套） |
| `offset` | 0 | ≥0 的整数 | 400「分页参数无效」 |
| `event` | 不过滤 | 事件名，**逗号分隔可多选**（精确匹配） | 不校验取值（事件名表之外的值只是查不到，不 400） |
| `level` | 不过滤 | `info` / `warn` / `error`，逗号分隔可多选（大小写不敏感） | 400「筛选等级无效：trace」 |
| `from` / `to` | 不过滤 | ISO 8601 或 Unix 秒/毫秒（`parseInstant`，与 `/api/alerts` 同一套） | 400「筛选起始时间无效：…」/「筛选结束时间无效：…」；`from` 晚于 `to` 回 400「筛选起始时间晚于结束时间」 |

- 时间范围是**闭区间**（含 `from` / `to` 那一刻）。多个过滤条件是 **AND**。
- 结果按 `time` **倒序**（新的在前）。
- `total` 是**筛选后、切页前**的条数；`echo` 回显本次的 `count` / `offset`。
- `files` 是这次读了几个文件——测试拿它证明「读的是盘，不是内存」。
- **上限**：命中超过 20000 条时只收前 20000 条并回 `truncated: true`（`log.js:77` 的 `QUERY_SCAN_LIMIT`）：调窄时间范围再查。
- **过滤只有事件名 / 级别 / 时间三项，不按字段过滤**：三域模型调用（P003-T046）统一是 `event=ai.model_call`，行里带 `domain`（`triage` / `rule` / `wiki`）与 `role`（`triage` / `review` / `rule_maintainer` / `wiki_maintainer`）——先按事件名拉，再在客户端按这两个字段细分；本接口不做字段级筛选。事件字段口径见 [architecture.md §3.6](../architecture.md)。
- 不是 JSON 对象、没有字符串 `time` / `event` 的行（截断的半行、人手写的空行）直接跳过，不报错（`parseLogLine()`，`log.js:164-175`）。
- **脱敏第三道闸**：落盘那行已经过脱敏，读的时候按同一套规则**再擦一遍**——盘上的文件可能是人手改过或老版本写的。

响应（200）：

```json
{"logs":[{"time":"2026-11-20T00:00:09.000Z","level":"warn","event":"external.row"},
         {"time":"2026-11-20T00:00:01.000Z","level":"info","event":"log.cleaned","by":"size","count":3,"bytes":216}],
 "total":3,"files":2,"truncated":false,"echo":{"count":2,"offset":0}}
```

**没配 `HIDS_LOG_FILE` 时回 503**：`{"error":"日志未落盘：未配置 HIDS_LOG_FILE","code":"not_configured"}`——不拿「空列表」冒充「没有日志」，两种状态在日志里查不出区别是运维事故。

#### 3.8.3 清理 `POST /api/logs/cleanup`

**只清轮转出来的历史文件**：当前活动文件（正在追加的那一份）**永不在候选里**——删了它，正在写的那行就断在半行上。

| 正文键 | 类型 | 说明 |
| --- | --- | --- |
| `older_than` | ISO 8601 字符串 | 历史文件 **mtime 早于**它的进候选 |
| `max_bytes` | ≥0 的整数 | 历史文件**总字节**上限；超了从**最老的**删起，删到不超为止 |
| `execute` | 布尔，缺省 `false` | 不给或 `false`＝dry-run，盘上一个字节都不动 |

- 两条阈值**至少给一条**（都给取并集，不重复计）；一条都不给回 400——不许无阈值一把抹掉。
- 值校验与失败文案见下表；`logCleanup()` 在 `server.js:838-860`，挑候选与删文件在 `pruneLogFiles()`（`log.js:207-231`）。
- **留痕**：`execute: true` 时落一条 `log.cleaned`，字段只有 `by`（`age` / `size` / `age+size`）、`count`、`bytes`——与 `data.cleaned` 同口径：**不记文件名、不记日志内容**。dry-run 不留痕。
- `remaining` 是执行后**重新扫出来**的历史文件余量（删不掉的会体现在这里，不假装成功）。

响应（200）：

```json
{"dry_run":false,
 "threshold":{"older_than":null,"max_bytes":0},
 "candidates":{"count":2,"bytes":144,"items":[{"name":"hids.2026-11-20T00-00-03-000Z.log","bytes":72,"at":"2026-11-20T00:00:03.000Z"},
                                               {"name":"hids.2026-11-20T00-00-05-000Z.log","bytes":72,"at":"2026-11-20T00:00:05.000Z"}],
               "truncated":false},
 "applied":{"count":2,"bytes":144},
 "remaining":{"count":0,"bytes":0}}
```

失败口径：

| 情况 | 状态 | `code` | 正文 |
| --- | --- | --- | --- |
| 两条路由在没配 `HIDS_LOG_FILE` 时被调用 | 503 | `not_configured` | 「日志未落盘：未配置 HIDS_LOG_FILE」 |
| 分页 / `level` / `from` / `to` 不合法 | 400 | `caller_error` | 见 §3.8.2 的表 |
| 正文不是 JSON 对象 | 400 | `caller_error` | 「请求正文必须是 JSON 对象」 |
| 带未知参数 | 400 | `caller_error` | 「不认识的参数：keep」 |
| `execute` 不是布尔 | 400 | `caller_error` | 「execute 必须是布尔值」 |
| `older_than` 解析不出时间 | 400 | `caller_error` | 「older_than 必须是可解析的时间（ISO 8601）」 |
| `max_bytes` 不是非负整数 | 400 | `caller_error` | 「max_bytes 必须是不小于 0 的整数」 |
| 两条阈值都没给 | 400 | `caller_error` | 「至少要给一个阈值：older_than（早于某时间）或 max_bytes（历史文件总字节上限）」 |

**鉴权**：与其它业务路由同一个 Basic 闸门（§4），**没有**独立令牌——与 `/api/data/*` 同口径（日志里的凭据已经过脱敏三道闸，A5）。

**不做什么**（测试别按这些写期望）：

- 不动 `web/**`、不装日志依赖（`package.json` 不变）。
- 不按天/按行分割、不压缩、不做跨进程文件锁：单进程一套实例（`log.js:66` 的模块级 `log`）。
- 不改 stdout 行形状与 `createJournal` 签名（既有四套日志测试靠这条缝）。
- 清理不删当前活动文件，也不按行裁剪（要缩当前文件请先轮转：调小 `HIDS_LOG_MAX_BYTES` 后重启，下一次写就会轮转）。
- 查询不做全文检索/正则，`event` 只做精确匹配。

**可重放证据**（`evidence/test/P003-T045/log-file.test.js`，16 条，约 280ms）：

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T045
node --test evidence/test/P003-T045/log-file.test.js          # 16 条全绿
node --test evidence/test/P003-T025/config-check.test.js      # A4 键集双向一致（新键已进 .env.example）
grep -cE '^[A-Z0-9_]+=' .env.example                          # 41（头部注释写的也是 41）
```

单测全在 tmp 目录跑：注入时钟与写入器，进程内 HTTP 请求；只有 A1 那条真进程小样碰 `spawn`（验「同份落文件」）。

### 3.9 现查告警送研判（按牧云事件 ID 入队，P003-T030）

**入口只有一条：`POST /api/agent/triage/{alertId}`**（`server.js:1176`）——它同时是「人工入队」「人工重试」与「现查送研判」
三个说法的同一个接口，没有另起一条路径。`{alertId}` 就是 `GET /api/alerts` 列表里那条事件的 `id`（`webshell:62169` 这种
`<类型>:<正整数>`，校验在 `validAlertId`，`server.js:489-493`）；不要求先收到 syslog 报文，也不要求这条事件进过队列。

**链路**（每一步都有能重放的单测，见 `evidence/test/P003-T030/live-alert-to-triage.test.js`）：

1. **入队**：`monitor.enqueue(alertId, {retry:true})`（`triage-monitor.js:670-702`）在 `records` 里落一条 `status=queued` 的
   记录并 `persist()` 到 `<数据根>/triage-monitor.json`；紧接着 `drain()`（`triage-monitor.js:942-959`）排工，
   所以 202 回包里 `status` 可能已经是 `running`。回包是 `TriageCase`。
2. **研判**：现查记录没有 `record.input`，`run()` 跳过 syslog 关联（不建案卷、不写 `syslog` 键），直接
   `investigator.run(alertId, {mode:'triage'})`（`triage-monitor.js:1042`）→ `InvestigationAgent.run` 按事件 ID 调
   `get_<类型>_event` 从牧云拉详情（`investigation-agent.js:438-459`）。配了规则预筛时照常评估，只是没有解析后的报文（`parsed=null`）。
3. **记录**：结果 `history.save(result)` 按 `alert_id + mode=triage` 落 `<数据根>/investigations/`（`triage-monitor.js:1053`），
   随后记录置 `done` 并把 `verdict` / `summary` / `evidence` / `result_alert_id` 挂回去（`triage-monitor.js:1056-1073`）。

**与推送路径一致的三件事**：同一个队列、同一套状态机（`queued → running → done/failed`）、同一份研判记录存储。
**不同的两件事**：现查记录没有 `input`，所以没有 `syslog` / `case_dir` 键，也不会出现在
`GET /api/agent/triage/cases`（那个列表只列有原始报文的案件，`triage-monitor.js:531`）；`dedupe` / `repeat_count`
这套重复投递归并只服务 syslog，现查记录不参与。

**重复入队语义**：同一 alert ID 只有一条记录（`records` 的键就是 `alert_id`，`triage-monitor.js:670-697`），
重复 POST 不会产生第二条、也不会排第二份工：

| 当前状态 | 重复 POST 的结果 |
| --- | --- |
| 没有记录 | 新建一条 `queued` 记录，202 |
| `queued` | 幂等：仍是一条，回 `queued`，不返回 409 |
| `running` | 不重启：202 回当前记录（`running`），`attempts` 不变 |
| `done` / `failed`（含死信） | **人工重试**：状态回 `queued`，`attempts` 加 1，`created_at` 沿用，重跑一轮 |

队列（排队 + 在跑）满 `HIDS_TRIAGE_QUEUE_MAX` 时回 429，不建记录；撤掉排队中的记录走 `DELETE`（§3.1）。

**替身纪律**：下面那条单测只用假 `service`（任何方法被调即抛）、假 `investigator` 与临时目录，不连真牧云、不读真数据根。

```bash
node --test evidence/test/P003-T030/live-alert-to-triage.test.js
```

### 3.10 研判会话回放（`GET /api/agent/investigations/{alertId}/replay`，P003-T046）

**关键路径**：分支在 `server.js:1301-1312`；纯函数构建器 `replayInvestigation()` 在 `investigation-agent.js:1161-1185`；
逐轮快照 `turns` 在研判过程中生成（`investigation-agent.js:483`、`:101-106` 的 `turnRecord()`，随结果一起落盘 `investigation-agent.js:1071`）；
记录存储仍是 `investigation-store.js` 的 `InvestigationStore.latest()`。OpenAPI 契约见 `openapi.yaml` 的 `replayInvestigation` / `InvestigationReplay`。

**它管什么**：把一次研判会话摊开给人看——**逐轮消息摘要**（每轮发了多少条消息、输入/输出字符量、模型点了哪些工具、结局）、
**工具调用序列**（按发生顺序，含重复查询、读回证据、读判据页、失败的那次）、**各轮结论变化**（调查轮 / 修订轮 / 校验退回轮
给出的三态结论），外加终局结论、独立复核、引用校验与证据清单（编号 / 工具 / 取到时刻 / 指纹，不带正文）。

**它不做什么**：**不重放模型、不重查牧云、不读案卷目录**。数据只来自已经落盘的那份研判记录
（`<数据根>/investigations/<sha256>.json`）与其中的 `evidence` / `trace` / `turns`；记录里没有的东西就回空，
不补、不猜、不 500。回放接口本身不产生任何 `ai.model_call` 事件（没有模型调用）。

**参数**

| 位置 | 名称 | 缺省 | 合法值 | 不合法时 |
| --- | --- | --- | --- | --- |
| path | `alertId` | — | `mode=deep`：`validAlertId`；`mode=triage`：`validTriageId`（syslog 形态也认） | 400「告警 ID 编码无效」/「告警 ID 或研判模式无效」（§3.3） |
| query | `mode` | `deep` | `deep` / `triage`，与 `GET /api/agent/investigations/{alertId}` 同一套 | 400「告警 ID 或研判模式无效」 |

**响应（200）**

```json
{"alert_id":"revshell:7","mode":"deep","model":"fake-model","saved_at":"2026-11-20T00:00:00.000Z","prompt_version":"…",
 "degraded":false,
 "counts":{"turns":3,"tool_calls":2,"evidence":2},
 "turns":[{"turn":1,"phase":"investigate","role":"triage","attempt":1,"messages":2,
           "input_chars":12512,"reply_chars":0,"tools":["list_host_events"],"outcome":"ok","conclusion":null,"note":null},
          {"turn":2,"phase":"investigate","role":"triage","attempt":1,"messages":4,
           "input_chars":11612,"reply_chars":183,"tools":[],"outcome":"ok",
           "conclusion":{"verdict":"uncertain","verdict_label":"存疑","confidence":"低"},"note":null},
          {"turn":3,"phase":"review","role":"review","attempt":1,"messages":2,
           "input_chars":2859,"reply_chars":62,"tools":[],"outcome":"ok","conclusion":null,"note":"独立复核=supported"}],
 "tool_calls":[{"step":1,"kind":"tool","name":"get_revshell_event","evidence_id":"cw:1"},
               {"step":2,"kind":"tool","turn":1,"name":"list_host_events","evidence_id":"cw:2"}],
 "verdicts":[{"turn":2,"phase":"investigate","verdict":"uncertain","verdict_label":"存疑","confidence":"低"}],
 "final":{"verdict":"uncertain","verdict_label":"存疑","confidence":"低","summary":"需要更多证据"},
 "review":{"assessment":"supported","concerns":[],"missing_evidence":[]},
 "validation":{"ok":true,"errors":[]},
 "evidence":[{"evidence_id":"cw:1","tool":"get_revshell_event","fetched_at":"…","sha256":"…"}]}
```

| 字段 | 口径 |
| --- | --- |
| `turns[]` | 每次模型调用一条快照（**包括挂掉的那次**：超时/报错也留一条，`outcome=timeout`/`error`，计量可能为 null）：`turn` 是调查轮次，循环外的单发调用顺延（捷径=1、独立复核=轮数+1、修订=+2、引用校验退回=+3+第几次）；`phase` 取 `shortcut / investigate / review / revision / validation / narrative`；`role` 取 `triage / review`；`attempt` 是同一轮同一 phase 的第几次（超时重试=2）；`tools` 是**这一轮模型点了哪些工具**（不是请求里给了哪些可选工具）；`outcome` 与 `ai.model_call` 的结局同一套四值（§architecture §3.6）；`conclusion` 是这一轮给出的三态结论摘要，没有结论时为 `null`；`note` 是附注（解析失败 / 结论被退回 / 复核结论 / 修订失败的原因摘要） |
| `tool_calls[]` | 按发生顺序的 `trace` 白名单映射：`kind` 取 `tool`（真查询）/`tool_reuse`（同一查询已取过）/`tool_error`（失败）/`read_evidence`（取回已取证据）/`case_file`（读案卷文件）/`wiki`（读判据页或检索，带 `action` / `id` / `keyword`）；只带名与编号，**请求参数与正文不进回放** |
| `verdicts[]` | 各轮结论变化：只列 `turns[].conclusion` 非空的轮 |
| `final` | 落盘结论的三态 + 置信度 + 摘要；没有结论时各字段 `null` |
| `degraded` | 降级结论标记：`validation.degraded === true`，或 `trace` 里有 `degraded_conclusion` |
| `evidence[]` | 证据清单四项（编号 / 工具 / 取到时刻 / sha256），**不带证据正文与视图** |
| `counts` | `turns` / `tool_calls` / `evidence` 三条计数，供页面做空态判断 |

**旧记录（P003-T046 之前落的案卷）**：没有 `turns` 键 → `turns: []`、`verdicts: []`、`counts.turns: 0`，
`tool_calls` / `evidence` / `final` 照旧按 `trace` 与 `verdict` 给出。这是**有意的降级**：不伪造逐轮数据。

**失败口径**

| 情况 | 状态 | `code` | 正文 |
| --- | --- | --- | --- |
| 这条告警没有已保存的研判记录（或 `mode` 取错） | 404 | `caller_error` | 「该告警暂无已保存的研判记录」（与 `GET /api/agent/investigations/{alertId}` 同一句） |
| `alertId` 解码失败 | 400 | `caller_error` | 「告警 ID 编码无效」 |
| `alertId` 形状不对 / `mode` 不在白名单 | 400 | `caller_error` | 「告警 ID 或研判模式无效」 |

**分支顺序**：这条分支必须排在 `GET /api/agent/investigations/{alertId}` 的 `startsWith` 之前，否则 `/replay` 会被当成
告警 ID 的后半段解码，回 400「告警 ID 或研判模式无效」。`evidence/test/P003-T046/investigation-replay.test.js` 钉住这一点。

**可重放证据**：

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T046
node --test evidence/test/P003-T046/investigation-replay.test.js   # 3 条全绿，约 0.15s
```

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

**关键路径**：`server.js:365-368`（案件目录）、`server.js:513-515`（告警列表）、`server.js:310-313`（白板列表）、`server.js:395-399`（知识库列表）、`server.js:931-932`（日志，P003-T045 加，行号按加完两条日志路由之后重数）。

分页参数出现在五条路由上，缺省与边界基本一样，只有知识库列表的 `count` 例外：

| 路由 | 出处 | `count` 缺省 | 单位 |
| --- | --- | --- | --- |
| `GET /api/agent/triage/cases` | `server.js:365-368` | 20 | 条 |
| `GET /api/alerts` | `server.js:513-515` | 20 | 条 |
| `GET /api/trace/boards` | `server.js:310-313` | 20 | 条 |
| `GET /api/logs` | `server.js:931-932` | 20 | 条 |
| `GET /api/wiki/pages` | `server.js:395-399` | **不切页，返回全部** | 条 |

表注：`count` 的单位是条（页大小）；知识库列表那行不切页，按整份集合返回，单位仍记作条。

**取值与边界**：

| 参数 | 缺省值 | 合法范围 | 不合法时 | 单位 |
| --- | --- | --- | --- | --- |
| `count` | 20 | 1 到 50 之间的安全整数 | 400「分页参数无效」 | 条 |
| `offset` | 0 | 大于等于 0 的安全整数 | 400「分页参数无效」 | 条 |

表注：`count` 量页大小（条），`offset` 量跳过的条数，两者同单位。

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
| 400 | 参数/正文/ID 不合法 | 分页参数、正文不是 JSON、`请求正文无效`、误报登记的 `libraries` 不是 `rule`/`wiki` 组成的非空数组 |
| 403 | 管理令牌不对 | 规则管理员令牌（`server.js:962`）、知识库管理员凭据（`server.js:1153`） |
| 404 | 目标不存在 | 未知 API（`server.js:943-944`）、知识库页面/会话、研判记录、告警事件 |
| 405 | 方法不对（只有提示词入口一处，`server.js:790`） | `POST /api/agent/prompts` |
| 409 | 状态冲突 | 研判未完成不能登记误报（`server.js:1157`）、页面版本过期、缺可维护判据页、知识维护会话已发布又发布一次（`wiki-workbench.js:368`） |
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

## 11. 行为承诺

接口层面的可被测试反驳的行为：每条都能用一次 HTTP 请求判真假。正文在前面各节，本表只做索引。

| 承诺 | 反例 | 正文 |
| --- | --- | --- |
| 闸门先于路由：认证不过直接 401、纯文本回包，连 `/api/session` 也拿不到；未配密码则全部放行 | 没带凭据却拿到 200 的业务数据 | 第 4 节 |
| 请求正文超过该路由上限回 400「请求正文过大」，不是合法 JSON 回 400「请求正文不是 JSON」 | 超长正文被截断后照常解析 | 第 8.1 节 |
| 错误翻译成四类、一类一个稳定 `code`；测试判 `code`，不判中文文案 | 同一类错误今天 `caller_error` 明天 `internal` | 第 8.3 节 |
| 分页参数非法一律 400「分页参数无效」；「服务没配」的 503 判定先于分页 | `count=abc` 回 200 的空列表 | 第 7 节 |
| SSE 分支里研判异常变成 `error` 帧，HTTP 状态仍是 200；判成败看帧不看状态码 | 拿 200 当成功并读 `result` | 第 6 节 |
| 知识库列表不传 `count` 时返回全量，不静默切成 20 | 默认切页导致控制台漏页 | 第 7 节 |

本页只描述现状。哪一处该改、改成什么样，是评审的活，不在文档范围内。
