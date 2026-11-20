## 域考古报告 · hids-ai-console 用例清单

**基准**：`commit 899ae25`（`899ae2575604d5557e8202c55a3b5a558ab251af`，2026-11-21 00:22:09 +0800），生成于 2026-11-21 00:33 +0800，工作树干净（仅 `alerts.png`/`overview.png`/`evidence/recon/P003-T075/` 未跟踪）。
**规模**：`server.js` 1504 行（业务端 51 条路由）/ `maintenance-server.js` 177 行（7 条路由）/ `openapi.yaml` 3339 行（**50 路径 57 操作**）。**没有 `.codegraph/` 索引**，全靠 ffgrep/read 逐段读。

**一句话结论**：58 条实现路由 = **45 个独立用例**（业务端 38 + 维护端 7）；另有 **23 个纯内部用例没有路由**。`openapi.yaml` 与 `server.js` 不是一套东西——契约少 1 条真实路由（`PUT /api/wiki/pages/{pagePath}`，前端已在用）。

---

# 一、路由 → 用例映射表

「动词+名词+谁发起+改什么状态」四段拆开。**发起者**共 5 种：`值守`（Basic / role=operator）、`规则管理员`（Basic + `X-Rule-Admin-Token`）、`知识管理员`（Basic + `X-Prompt-Admin-Token`）、`维护员`（独立账号 viewer/updater）、`系统`（无 HTTP 入口）。

## A. 运行配置与身份（4 路由 / 3 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/session` | getSession | `server.js:898` | 查 当前会话身份 | 值守 | —（读 access） | 不改 |
| GET `/api/config` | getConfig | `server.js:909` | 读 生效运行配置 | 值守 | —（读 `config.env`） | 不改 |
| POST `/api/config` | writeConfig | `server.js:913` | 改 运行配置 | 值守 | ConfigOverride | 覆盖层落盘 + **5 个活跃客户端原地换值** |
| GET `/api/updates` | getUpdates | `server.js:905` | 读 已装版本与更新日志 | 值守 | UpdateStore（只读） | 不改 |

## B. 状态、工具目录与下线哨兵（6 路由 / 4 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/status` | getCloudwalkerStatus | `server.js:945` | 探 牧云连通性 | 值守 | CloudwalkerGateway | 不改（45s 缓存） |
| GET `/api/agent/status` | getAgentStatus | `server.js:962` | 读 研判模型与提示词版本状态 | 值守 | PromptStore + 模型角色 | 不改 |
| GET `/api/agent/prompts` | getPromptMetadata | `server.js:1224` | 读 提示词元数据 | 值守 | PromptStore | 不改 |
| GET `/api/agent/tools` | listAgentTools | `server.js:952` | 列 取证工具（牧云 API 箱） | 值守 | ApiEvidenceToolbox | 不改 |
| GET `/api/trace/tools` | listTraceTools | `server.js:957` | 列 取证工具（牧云 MCP 箱） | 值守 | AgentToolbox | 不改 |
| POST `/api/agent/prompts/upload` | legacyPromptUpload | `server.js:1228` | **恒 410，非用例**（下线哨兵） | — | — | — |

`server.js:1227` 另有 `POST /api/agent/prompts` → 恒 405（全仓唯一一处 405）。

## C. 本地存储与日志（4 路由 / 4 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/data/inventory` | getDataInventory | `server.js:920` | 盘点 本地运行态存储（7 类） | 值守 | DataStore×7 | 不改 |
| POST `/api/data/cleanup` | cleanData | `server.js:922` | 归档/删除 老数据 | 值守 | DataStore×7 | 归档或删文件（默认 dry-run） |
| GET `/api/logs` | getLogs | `server.js:929` | 查 落盘日志 | 值守 | LogFile | 不改 |
| POST `/api/logs/cleanup` | cleanLogs | `server.js:940` | 清 轮转历史日志 | 值守 | LogFile | 删历史日志文件 |

## D. 告警（2 路由 / 1 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/alerts` | listAlerts | `server.js:1359` | 列 告警 | 值守 | Alert（外部只读）+ TriageCase | 不改 |
| GET `/api/alerts/{alertId}` | getAlert | `server.js:1378` | 读 单条告警详情 | 值守 | Alert + TriageCase | 不改 |

## E. 研判队列与研判记录（7 路由 / 5 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/agent/triage/status` | getTriageStatus | `server.js:999` | 读 研判队列总览 | 值守 | TriageCase | 不改 |
| GET `/api/agent/triage/cases` | listTriageCases | `server.js:1123` | 列 研判案件 | 值守 | TriageCase | 不改 |
| GET `/api/agent/triage/{alertId}` | getTriageRecord | `server.js:1216` | 读 单条研判记录 | 值守 | TriageCase | 不改（缺记录回 `not_queued` 伪对象，非 404） |
| PUT `/api/agent/triage/control` | setTriageEnabled | `server.js:1133` | 启/停 自动研判 | 值守 | TriageQueue | 开关 + 暂停缓冲 |
| POST `/api/agent/triage/{alertId}` | retryTriage | `server.js:1217` | **(重)入队** 一条告警 | 值守 | TriageCase | 新建/重置记录为 `queued` |
| DELETE `/api/agent/triage/{alertId}` | cancelTriage | `server.js:1219` | 撤 排队中的研判记录 | 值守 | TriageCase | 删记录 + 失效去重条目 |
| POST `/api/agent/triage/{alertId}/false-positive` | reportFalsePositive | `server.js:1140` | **登记 人工误报并起双库维护** | 值守 | TriageCase + FpSession + RegoRule + WikiPage | 写 verdict/feedback/maintenance + 后台起维护 |

## F. 深度研判会话（3 路由 / 2 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| POST `/api/agent/investigations` | createInvestigation | `server.js:1306` | 发起 一次研判（deep/triage；JSON 或 SSE） | 值守 | Investigation + RuleSet + WikiPage + ToolSession | 写研判记录 |
| GET `/api/agent/investigations/{alertId}` | getInvestigation | `server.js:1350` | 读 已保存的研判结果 | 值守 | Investigation | 不改 |
| GET `/api/agent/investigations/{alertId}/replay` | replayInvestigation | `server.js:1338` | 回放 已保存的研判会话（逐轮） | 值守 | Investigation | 不改 |

## G. 溯源白板（3 路由 / 2 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/trace/boards` | listTraceBoards | `server.js:968` | 列 溯源白板 | 值守 | TraceBoard | 不改 |
| POST `/api/trace/boards` | startTraceBoard | `server.js:978` | 起/恢复 一次溯源 | 值守 | TraceBoard | 建板(202)或复用(200) |
| GET `/api/trace/boards/{target}` | getTraceBoard | `server.js:990` | 读 溯源白板进度与结果 | 值守 | TraceBoard | 不改 |

## H. 前置规则集（JSON，3 路由 / 3 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/triage/rules` | getRules | `server.js:1007` | 读 前置规则集 | 值守 | RuleSet(JSON) | 不改 |
| POST `/api/triage/rules/validate` | validateRules | `server.js:1012` | **试算** 规则草稿 | 值守 | RuleSet | 不改（无副作用） |
| PUT `/api/triage/rules` | saveRules | `server.js:1022` | 存 前置规则集（乐观锁） | 规则管理员 | RuleSet | 写 `triage-rules.json` |

## I. Rego 规则库（7 路由 / 4 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/rules` | listRegoRules | `server.js:1034` | 列 Rego 规则 | 值守 | RegoRule | 不改 |
| GET `/api/rules/{id}` | getRegoRule | `server.js:1113` | 读 一条规则原文 | 值守 | RegoRule | 不改 |
| GET `/api/rules/{id}/history` | listRegoRuleHistory | `server.js:1068` | 列 一条规则的历史版本 | 值守 | RuleHistory | 不改 |
| PUT `/api/rules/{id}` | putRegoRule | `server.js:1089` | 写 一条规则（乐观锁） | 规则管理员 | RegoRule + RuleHistory | 写盘 + 旧版进历史 |
| POST `/api/rules/{id}/rollback` | rollbackRegoRule | `server.js:1068` | **回滚**（同写路径的另一入口） | 规则管理员 | RegoRule + RuleHistory | 同上，备注换 |
| POST `/api/rules/evaluate` | evaluateRegoRules | `server.js:1061` | **试算** 规则命中 | 值守 | RegoRule | 不改 |
| GET `/api/rules/sessions` | listRegoSessions | `server.js:1040` | 列 规则维护会话摘要 | 值守 | RuleSession | 不改 |

## J. 误报维护会话（2 路由 / 1 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/false-positive/sessions` | listFpMaintenanceSessions | `server.js:1046` | 列 误报维护会话摘要 | 值守 | FpSession | 不改 |
| GET `/api/false-positive/sessions/{id}` | getFpMaintenanceSession | `server.js:1050` | 读 一份会话全文 | 值守 | FpSession | 不改 |

## K. 判据库与知识维护会话（10 路由 / 8 用例）

| 路由 | opId | server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/wiki/pages` | listWikiPages | `server.js:1230` | 浏览 已发布判据页 | 值守 | WikiPage | 不改 |
| GET `/api/wiki/pages/{pagePath}` | getWikiPage | `server.js:1248` | 读 一页判据 | 值守 | WikiPage | 不改 |
| **PUT `/api/wiki/pages/{pagePath}`** | **⚠️ openapi 无此操作** | `server.js:1253` | 改写 一页判据（乐观锁） | 值守 | WikiPage | 写页面 + 备份旧版 |
| GET `/api/wiki/health` | getWikiHealth | `server.js:1263` | 查 判据库文件与索引健康 | 知识管理员 | WikiPage | 不改 |
| GET `/api/wiki/sessions` | listWikiSessions | `server.js:1264` | 读 知识维护会话（列表） | 知识管理员 | WikiSession | 不改 |
| GET `/api/wiki/sessions/{sessionId}` | getWikiSession | `server.js:1283` | 读 知识维护会话（单条） | 知识管理员 | WikiSession | 不改 |
| POST `/api/wiki/sessions` | createWikiSession | `server.js:1265` | **开** 会话（从页面 / 从已完成案件复盘） | 知识管理员 | WikiSession (+TriageCase) | 建会话 + 快照案卷 |
| POST `/api/wiki/sessions/{id}/messages` | replyWikiSession | `server.js:1283` | 提交 材料/回答，推进会话 | 知识管理员 | WikiSession | 追加消息 + 生成草案 |
| POST `/api/wiki/sessions/{id}/replay` | replayWikiSession | `server.js:1283` | 重放 当前草稿的历史案件核对 | 知识管理员 | WikiSession | 重算草案 |
| POST `/api/wiki/sessions/{id}/publish` | publishWikiSession | `server.js:1283` | 审核并发布 草案 | 知识管理员 | WikiSession + WikiPage | **写页面正文** + 会话终态 |

## L. 维护端（18081 端口，7 路由 / 7 用例）

| 路由 | opId | maintenance-server.js | 用例 | 发起者 | 聚合 | 改什么状态 |
|---|---|---|---|---|---|---|
| GET `/api/maintenance/session` | getMaintenanceSession | `:70` | 查 维护登录状态 | 维护员 | MaintenanceSession | 不改 |
| POST `/api/maintenance/login` | loginMaintenance | `:73` | 登录 维护端 | 维护员 | MaintenanceSession | 建会话 + 发 cookie + 失败计数 |
| POST `/api/maintenance/logout` | logoutMaintenance | `:102` | 登出 维护端 | 维护员 | MaintenanceSession | 删会话 + 清 cookie |
| GET `/api/maintenance/overview` | getMaintenanceOverview | `:111` | 读 版本概览与升级包列表 | 维护员 | UpdateStore | 不改 |
| POST `/api/maintenance/packages` | stageMaintenancePackage | `:122` | 暂存 加密签名包 | 维护员(updater) | PolicyPackage | 写暂存区 |
| GET `/api/maintenance/packages/{id}` | getMaintenancePackage | `:130` | 读 包详情与兼容性 | 维护员 | PolicyPackage | 不改 |
| POST `/api/maintenance/packages/{id}/apply` | applyMaintenancePackage | `:130` | 应用 包（`If-Match` 版本） | 维护员(updater) | PolicyPackage + PromptStore | **覆盖提示词/策略** |

---

# 二、同义合并：58 路由 → 45 独立用例

**合并掉的 13 处冗余**（这就是"同一用例的不同入口"）：

| # | 合并 | 证据 | 说明 |
|---|---|---|---|
| M1 | `POST /api/agent/triage/{alertId}` = **人工入队 = 人工重试 = 现查告警送研判** | `openapi.yaml:769`「现查告警送研判走的就是这一条」；`server.js:1217` 恒 `monitor.enqueue(alertId, { retry: true })` | 实现层**根本分不开**：`triage-monitor.js:675` 的 `if (existing && !retry) return this.status(alertId)` 因恒 true 而永不触发。三个说法 = 一个命令 |
| M2 | `GET /api/agent/tools` + `GET /api/trace/tools` = 同一「列取证工具」 | `api-tools.js:16` / `agent-tools.js:30` 两套 provider | 一个用例两个来源 |
| M3 | `GET /api/alerts` + `GET /api/alerts/{id}` = 同一「读告警」 | `server.js:1359` / `server.js:1378` | 同聚合 Alert 的列表/详情 |
| M4 | `GET /api/agent/triage/status` + `/cases` + `/{alertId}` = 同一「读研判记录」 | `triage-monitor.js:575`(summary) / `:531`(cases) / `:518`(status) | 同一聚合 TriageCase 的三种投影，**不是三个用例** |
| M5 | `GET /api/agent/investigations/{id}` + `/replay` = 同一「读研判结果」 | `server.js:1350` / `server.js:1338` 同一套 `history.latest()`，只换视图函数 | 两条分支重复做同一套 mode/ID 校验 |
| M6 | `GET /api/trace/boards` + `/boards/{target}` = 同一「读白板」 | `server.js:968` / `server.js:990` | 同聚合 TraceBoard |
| M7 | `GET /api/rules` + `/rules/{id}` + `/rules/{id}/history` = 同一「读规则」 | `rule-store.js:219/225/316` | 同聚合 RegoRule |
| M8 | `PUT /api/rules/{id}` + `POST /api/rules/{id}/rollback` = 同一「写规则」 | `openapi.yaml:1263`「回滚＝把历史里那一版当新版再写一次（走同一个 `RuleStore.save()`）」；`rule-store.js:348` rollback 内部调 save | 只差 note |
| M9 | `GET /api/wiki/pages` + `/pages/{pagePath}` = 同一「读判据页」 | `wiki-store.js:63` / `:127` | 同聚合 WikiPage |
| M10 | `GET /api/wiki/sessions` + `/sessions/{id}` = 同一「读知识会话」 | `wiki-workbench.js:98` / `:87` | 同聚合 WikiSession |
| M11 | `GET /api/false-positive/sessions` + `/{id}` = 同一「读误报会话」 | `fp-maintainer.js:138` / `:112` | 同聚合 FpSession |
| M12 | `POST /api/wiki/sessions` 一条路径两个子用例 | `server.js:1269-1278` | `body.case_id` 有 → 从已完成案件建复盘（读研判聚合）；无 → 从页面建 |
| M13 | `POST /api/agent/triage/{id}/false-positive` 一条路径两个子动作 | `server.js:1176-1196` + `1198-1207` | ①写人工误报结论（同步） ②起双库维护（异步后台） |

**答案：58 条实现路由 → 45 个独立用例**（业务端 44 条路由 → 38 个；维护端 7 条 → 7 个，无合并）。
注意 `POST /api/agent/prompts/upload`（410）不是用例，是下线哨兵，实际候选路由 57 条。

---

# 三、真实用例清单（45 条，按聚合归组）

> 输入/输出只列对外契约面；「触及聚合」是这次 DDD 划界的直接依据。

| # | 用例 | 输入 | 输出 | 触及聚合 | 发起者 |
|---|---|---|---|---|---|
| **运行配置 ConfigOverride** ||||
| UC-01 | 读生效配置 | env + 覆盖层 | `{host,port,triage_input_mode,cloudwalker,model{roles},auth,secrets,missing_required}` | ConfigOverride | 值守 |
| UC-02 | 改运行配置 | 11 键部分更新 | `{updated, config}` | ConfigOverride + **5 个活客户端对象** | 值守 |
| **身份 Access** ||||
| UC-03 | 查会话身份 | Basic 头 | `{authenticated,user,role}` | — | 值守 |
| **更新 UpdateStore** ||||
| UC-04 | 读版本与更新日志 | — | 升级包概览 | UpdateStore | 值守 |
| **牧云 CloudwalkerGateway** ||||
| UC-05 | 探连通性 | — | `{configured,connected,reason}` | CloudwalkerGateway | 值守 |
| **研判服务状态 / PromptStore** ||||
| UC-06 | 读模型与提示词版本 | — | `{configured,model,missing,prompt_version}` | PromptStore + 模型角色 | 值守 |
| UC-07 | 读提示词元数据 | — | 版本/修订元数据 | PromptStore | 值守 |
| **取证工具目录 Toolbox** ||||
| UC-08 | 列取证工具 | provider=api\|mcp | `{provider,readOnly,count,tools}` | ApiEvidenceToolbox / AgentToolbox | 值守 |
| **本地存储 DataStore×7** ||||
| UC-09 | 盘点本地存储 | — | `{data_dir,stores,total}` | DataStore×7（cases/investigations/boards/wiki_sessions/queue/logs/config_overrides）`server.js:621` | 值守 |
| UC-10 | 归档/删除老数据 | `{kind,action,execute,older_than,keep}` | `{dry_run,candidates,applied,inventory}` | DataStore×7 + TriageQueue | 值守 |
| **日志 LogFile** ||||
| UC-11 | 查落盘日志 | `count,offset,level,q,from,to` | `{logs,total,files,truncated}` | LogFile | 值守 |
| UC-12 | 清历史日志 | `{older_than,max_bytes,execute}` | `{dry_run,candidates,applied,remaining}` | LogFile | 值守 |
| **告警 Alert** ||||
| UC-13 | 读告警 | `count,offset,q,level,type,status,verdict` / `{alertId}` | `{alerts,total,totals,partial,triage_configured}` / 单条详情 | Alert + TriageCase | 值守 |
| **研判记录与队列 TriageCase** ||||
| UC-14 | 读研判记录 | `since` / `count,offset,verdict,type,host` / `{alertId}` | 队列总览 / 案件列表 / 单条 | TriageCase | 值守 |
| UC-15 | 启停自动研判 | `{enabled}` | 队列 summary（含 paused 块） | TriageQueue | 值守 |
| UC-16 | (重)入队一条告警 | `{alertId}` | 202 `TriageCase` | TriageCase | 值守 |
| UC-17 | 撤排队中的记录 | `{alertId}` | `{alert_id,status:"not_queued",cancelled:true}` | TriageCase | 值守 |
| UC-18 | 登记人工误报 + 起双库维护 | `{reason,who?,libraries?}` | 202 研判记录视图 | TriageCase + FpSession + RegoRule + WikiPage | 值守 |
| **研判会话 Investigation** ||||
| UC-19 | 发起一次研判 | `{alert_id,mode}` + `stream=1` | 200 结果 JSON / SSE(progress,result,error) | Investigation + RuleSet(JSON) + WikiPage + ToolSession | 值守 |
| UC-20 | 读已保存研判结果 | `{alertId},mode` | 记录本体 / `turns,verdicts,tool_calls` 回放视图 | Investigation | 值守 |
| **溯源白板 TraceBoard** ||||
| UC-21 | 起/恢复一次溯源 | `{target\|alert_id\|ip, focus}` | 200 已有 / 202 新建 | TraceBoard | 值守 |
| UC-22 | 读白板 | `count,offset,status,type,host,from,to` / `{target}` | `{boards,total}` / `{hops,links,gaps,discovery}` | TraceBoard | 值守 |
| **前置规则集 RuleSet(JSON)** ||||
| UC-23 | 读规则集 | — | 规则集 + `writable` | RuleSet | 值守 |
| UC-24 | 试算规则草稿 | `{config}` | `{valid,count}` | RuleSet | 值守 |
| UC-25 | 存规则集 | `{config,expected_revision}` | 保存结果 | RuleSet | 规则管理员 |
| **Rego 规则库 RegoRule** ||||
| UC-26 | 读规则 | — / `{id}` / `{id}` | `{count,rules}` / 原文+revision / `{id,history[]}` | RegoRule + RuleHistory | 值守 |
| UC-27 | 写规则（含回滚） | `{rego,expected_revision,note}` / `{rev,who}` | `{id,file,name,rev,previous_rev,action}` | RegoRule + RuleHistory | 规则管理员 |
| UC-28 | 试算规则命中 | 告警事实 JSON | `{count,matched}` | RegoRule | 值守 |
| UC-29 | 列规则维护会话 | — | `{sessions[]}` | RuleSession | 值守 |
| **误报维护会话 FpSession** ||||
| UC-30 | 读误报维护会话 | — / `{id}` | 摘要列表 / 全文（turns/messages/decision/outcomes/validation/auto_verdict） | FpSession | 值守 |
| **判据页 WikiPage** ||||
| UC-31 | 读判据页 | `count,offset,q` / `{pagePath}` | `{pages,total}` / 页面正文 | WikiPage | 值守 |
| UC-32 | 改写判据页 | `{content,expected_revision}` | 更新结果 | WikiPage + WikiHistory | 值守 |
| UC-33 | 查判据库健康 | — | 文件与索引状态 | WikiPage | 知识管理员 |
| **知识维护会话 WikiSession** ||||
| UC-34 | 读知识维护会话 | — / `{id}` | `{sessions}` / 会话全文 | WikiSession | 知识管理员 |
| UC-35 | 开会话 | `{page}` 或 `{case_id,reason,expected_verdict,who}` | 201 会话 | WikiSession (+TriageCase 快照) | 知识管理员 |
| UC-36 | 提交材料/回答 | `{content}` | 200 会话（含草案） | WikiSession | 知识管理员 |
| UC-37 | 重放当前草稿 | — | 200 重算结果 | WikiSession | 知识管理员 |
| UC-38 | 审核并发布草案 | `{scenario_id,note,valid_until,verdict}` | 200 发布结果 | WikiSession + **WikiPage 正文** | 知识管理员 |
| **维护端身份 MaintenanceSession** ||||
| UC-39 | 查维护登录状态 | — | `{authenticated,preview,login_enabled,user,role}` | MaintenanceSession | 维护员 |
| UC-40 | 登录维护端 | `{username,password}` | 200 + Set-Cookie | MaintenanceSession | 维护员 |
| UC-41 | 登出维护端 | cookie | `{logged_out:true}` | MaintenanceSession | 维护员 |
| **策略包 PolicyPackage** ||||
| UC-42 | 读版本概览与包列表 | — | `{overview,packages,preview,writable}` | UpdateStore | 维护员 |
| UC-43 | 暂存加密签名包 | 二进制体 + `X-Package-Filename` | 201 `{id,version}` | PolicyPackage | 维护员(updater) |
| UC-44 | 读包详情 | `{packageId}` | 详情 + 兼容性 | PolicyPackage | 维护员 |
| UC-45 | 应用包 | `If-Match` 修订号 | 200 应用结果 | PolicyPackage + PromptStore | 维护员(updater) |

---

# 四、Handler 超载清单

按"一个 handler 干几件事"排序。行号为 `server.js` 当前值。

| 级别 | 位置 | 一个 handler 干了什么 | 建议拆法 |
|---|---|---|---|
| 🔴 严重 | `server.js:1140-1208`（69 行，POST `/false-positive`） | ①校验 reason/who/libraries ②查记录+判 `status==='done'` ③判"本进程已在跑" ④保留上一轮 `maintenance` 的 `kept` 字段算单腿补跑 ⑤写 `verdict/feedback/detail/maintenance` ⑥`persist()` ⑦起后台 fpAgent ⑧写 `maintenance.result` 日志 ⑨回 202 | 拆成 `登记误报结论`（同步事务）+ `启动双库维护`（异步作业）两个用例；④⑧是纯逻辑，可独立成 `计算补跑范围` |
| 🔴 严重 | `server.js:1210-1223`（`startsWith('/api/agent/triage/')`） | 一条分支同时承载 **3 个方法 3 个用例**：GET 读记录 / POST 入队 / DELETE 取消 | 拆 3 条独立分支 |
| 🔴 严重 | `server.js:1229-1305`（`startsWith('/api/wiki/')`，77 行） | 9 个路由 + **2 套鉴权**（读页面走 Basic 闸前、写会话走管理员令牌闸后）+ 2 级路径解析（`wikiPagePath`）+ 页面 PUT 乐观锁 + 会话 4 命令 | 拆「页面资源」与「会话资源」两个资源组，鉴权分层下沉到各自入口 |
| 🟠 重 | `server.js:1283`（一条正则） | `^\/api\/wiki\/sessions\/([0-9a-f-]{36})(?:\/(messages\|replay\|publish))?$` 一条正则派发 **4 个用例** | 拆 4 条 |
| 🟠 重 | `server.js:1068`（一条正则） | `^\/api\/rules\/([^/]+)\/(history\|rollback)$` 派发 2 个用例；rollback 内再叠令牌判+版本格式判+备注生成+写队列 | 拆 2 条 |
| 🟠 重 | `server.js:1359-1373`（GET `/api/alerts`） | 同一 handler 内**两条数据通道**：`triageFilteredAlerts`（走研判聚合）vs `service.alerts`（走牧云），再叠一层 `monitor.status()` 覆盖 | 拆「读牧云告警」+「按研判结论过滤」；聚合器下沉到用例层 |
| 🟠 重 | `server.js:1306-1337`（POST `/api/agent/investigations`） | 一个 POST 内分 **SSE / JSON 两条实现路径**（重复的写回与错误处理）+ 按 `mode` 换 executor + 规则预筛 + `history.save` | SSE 与 JSON 拆成两个传输适配器，共用一个用例 |
| 🟠 重 | `server.js:1350-1358` vs `server.js:1338-1349` | 两条分支**重复**同一套 `mode` 白名单 + ID 校验 + `history.latest()`，只有输出视图不同 | 合 1 条，用「视图参数」区分 |
| 🟠 重 | `server.js:1265-1282`（POST `/api/wiki/sessions`） | 一条路径两个子用例（从页面建 / 从已完成案件复盘），后者跨读 `monitor.records` + `wikiFeedbackTarget` | 拆 2 条或用显式 `source` 字段 |
| 🟡 中 | `server.js:922-928` → `dataCleanup()` `server.js:800-836` | 7 类存储 × {archive,delete} × {dry-run,execute} 四路分派；**执行完还再跑一次 `dataInventory()`** 回填 | 7 类各自成用例，inventory 复用 UC-09 |
| 🟡 中 | `server.js:1089-1112`（PUT `/api/rules/{id}`） | 令牌判 + id 判 + 正文判 + `expected_revision` 判 + 备注生成 + 写队列 + 乐观锁（7 件事） | 校验抽成规约（Specification），handler 只做编排 |
| 🟡 中 | `server.js:1133-1139`（PUT `/api/agent/triage/control`） | 表面 1 件事，实际 `monitor.setEnabled()` (`triage-monitor.js:631-658`) 内部做：开暂停窗/计数归零 → 回灌缓冲 → 排逾期重试 → poll → drain → persist | 「启停」与「恢复」是两个用例 |
| 🟡 中 | `server.js:1046-1060`（fp/sessions 列表+详情） | 两条分支，且 UUID 校验、编码异常处理重复 | 合 1 条 |
| 🟡 中 | `server.js:898-904` vs `server.js:962-966` | 两处各自算「模型/提示词版本状态」，`/api/agent/status` 还漏出 `missing` 列表 | 合成一个「读运行态」用例 |
| 🔴 严重 | `maintenance-server.js:59-139`（整段） | **4 层前置闸**（loopback / preview / CSRF `writeAllowed` / cookie session + 失败计数）× 7 个路由挤在一个 try 里 | 闸门下沉为中间件，路由只留业务 |

**统计**：8 条路由承载 ≥2 个用例（占 14%），最重的一条（误报入口）混了 9 件事。

---

# 五、没有对应路由的内部用例（23 个）

这些是真实业务动作，但**只能被系统自己或后台 Agent 触发**——用户点不到。

| # | 内部用例 | 位置 | 触发者 | 触及聚合 |
|---|---|---|---|---|
| I-01 | 接收并入队 syslog 报文 | `syslog-input.js:104` → `server.js:1500` → `triage-monitor.js:796` | 系统（UDP 15514） | TriageCase |
| I-02 | 轮询牧云事件列表并入队 | `triage-monitor.js:711` | 系统（定时） | TriageCase + Alert |
| I-03 | 出队并跑一轮常规研判 | `triage-monitor.js:938` / `:993` | 系统（队列 worker） | TriageCase + Investigation |
| I-04 | 失败重试排期与死信判定 | `triage-monitor.js:365` / `:404` | 系统 | TriageCase |
| I-05 | 已完成案件 TTL 归档 | `triage-monitor.js:423` | 系统（定时） | TriageCase |
| I-06 | 重复投递次数回写 | `triage-monitor.js:306` | 系统 | TriageCase + 案卷文件 |
| I-07 | 匹配牧云事件、建立案卷 | `syslog-case.js:27` / `:96` / `:121` | 系统 | 案卷（文件） |
| I-08 | **Agent 读案卷材料** | `syslog-case.js:173`（调用点 `investigation-agent.js:768`、`:1104`） | Agent 内部 | 案卷 |
| I-09 | 必查项落盘与复算 | `required-evidence.js:123` / `syslog-case.js:191` / `:213` | Agent 内部 | 案卷 |
| I-10 | **研判前规则预筛** | `triage-rules.js:261`（调用点 `server.js:866`，`investigate()` 内） | 系统 | RuleSet(JSON) |
| I-11 | 证据声明机器校验 | `agent-tools.js:71` | Agent 内部 | ToolSession |
| I-12 | 证据投影与脱敏 | `evidence-view.js:173` / `:253`、`record-redaction.js:39`、`fp-maintainer.js:68` | 系统 | ToolSession |
| I-13 | **误报维护四轮推进**（读案卷→读两库→提修订→写入+自校验） | `fp-maintainer.js:377` | 后台 Agent（由 UC-18 触发） | FpSession + RegoRule + WikiPage + 案卷 |
| I-14 | 规则维护者提修订并自校验 | `fp-maintainer.js:302` | 后台 Agent | RegoRule |
| I-15 | 判据维护者生成草案 | `wiki-workbench.js:150` / `:280` | 后台 Agent | WikiSession |
| I-16 | 判据发布前的 bundle 检查 | `wiki-store.js:242` | 系统 | WikiPage |
| I-17 | 升级包验签与落盘 | `update-store.js:73` / `:162` | 系统 | PolicyPackage + PromptStore |
| I-18 | **写配置后的活跃客户端原地换值** | `server.js:74`（`applyLiveConfig`） | 系统 | gateway.rpc / mcp client / 5 个模型角色 |
| I-19 | 启动闸门校验（5 必填 + 取值表） | `server.js:1491-1503` | 系统（进程入口） | Config |
| I-20 | 覆盖层加载进 `env` | `config-store.js:112` | 系统（启动时） | ConfigOverride |
| I-21 | 日志文件 sink 与轮转 | `log.js:209` / `:237` | 系统 | LogFile |
| I-22 | 判据库/规则库从仓内种子初始化到数据根 | `wiki-store.js:47` / `rule-store.js:168` | 系统（首次读） | WikiPage / RegoRule |
| I-23 | 未匹配 syslog 的兜底研判（强制存疑） | `investigation-agent.js:1097` | 系统 | Investigation |

> `knowledge-store.js` 整库未接线（`server.js` 0 次 import），其 4 个方法（`publish/withdraw/reply/defer`）是**第四类**：有实现、无调用方、无路由。

---

# 六、边界与耦合观察（DDD 划界的直接依据）

1. **`server.js` 是唯一装配点，也是唯一路由表。** `createServer()` 有 **23 个位置参数**（`server.js:840-846`），注入 20 个构件。路由层直接持有全部聚合的引用，没有应用服务层——这就是 handler 超载的根因。

2. **三条硬耦合跨越了聚合边界，不能靠"路由拆开"解决：**
   - `POST /api/config` → `applyLiveConfig` (`server.js:74-100`) **原地改** `gateway.rpc.baseUrl/token`、`agentToolbox.client.url/token`（并把 `initialized` 置 false 强制重连 MCP）、5 个模型角色的 `url/apiKey/model`。配置聚合与运行时对象图是同一张。
   - `POST /api/agent/investigations` → `investigate()` (`server.js:862-880`) 在**一个用例里串了 4 个聚合**：规则预筛 → Agent 取证 → 独立复核 → `history.save`。
   - `POST /api/trace/boards` → `boardService.analysis` 由 `createAnalysisProvider({monitor, history})` (`server.js:858`) 现接 —— **溯源白板聚合直接依赖研判聚合 + 研判记录聚合**。

3. **两套"规则"是两个聚合，不要合并：** JSON 前置规则集（`triage-rules.js`，研判前预筛，有 `PUT` 乐观锁 + 独立管理员令牌）vs Rego 规则库（`rule-store.js`，人工维护 + 历史 + 回滚）。它们只在 `server.js:1010` 与 `:1029` 通过 `monitor?.ruleEngine || triageRuleEngine` 这一个表达式相连。

4. **"会话"是三种形状的同构概念**（WikiSession / RuleSession / FpSession），三个不同的存储类（`wiki-workbench.js:87` / `rule-store.js:453` / `fp-maintainer.js:112`），JSON 结构刻意对齐（`fp-maintainer.js` 注释明说"形制对齐 wiki-sessions"）。**可以合并成一个 Session 抽象 + 三种类型**，但 WikiSession 有额外的 publish 状态机，另两个没有。

5. **契约与实现有两处真实缺口**：
   - `PUT /api/wiki/pages/{pagePath}` 在 `server.js:1253` 已实现、前端 `web/src/knowledge.js:225` 已在调，**`openapi.yaml` 里没有**。
   - `GET /api/rules/sessions` 只有摘要，**没有 `/api/rules/sessions/{id}`**（`docs/_meta/api-gaps-frontend-view.md` A11 已记录）——与 FpSession 侧不对称。

6. **两套鉴权 + 一套 CSRF，三层身份在一条链上**：`hasAccess`（Basic，值守）→ `hasRuleAdminAccess`（规则令牌）→ `hasPromptAdminAccess`（知识令牌），维护端另起一套独立账号。知识会话 5 条路由对控制台不可达（`web/src/knowledge.js:14` 实测 503）。

7. **前端只消费了 19 条路由。** `grep -rhoE "'/api/[^']*'" web/` 的结果里**完全没有**：`/api/config`(GET/POST)、`/api/data/*`、`/api/logs*`、`/api/agent/prompts`、`/api/trace/tools`、`/api/rules/sessions`、`/api/rules/{id}/history|rollback`、`/api/false-positive/sessions*`、`/api/wiki/health`、`/api/wiki/sessions*`（实测 503）、`DELETE /api/agent/triage/{id}`。这些不是死代码，但**没有消费者**——重构时它们的优先级最低。

8. **路由顺序是语义的一部分**（`if` 链，命中即 return）：
   - `/api/agent/triage/status` (`server.js:999`) 必须排在 `/api/agent/triage/{alertId}` (`server.js:1210`) 前面；
   - `/api/agent/investigations/{id}/replay` (`server.js:1338`) 必须排在 `/api/agent/investigations/{id}` (`server.js:1350`) 前面；
   - `/api/rules/sessions` (`server.js:1040`) 必须排在 `/api/rules/{id}` (`server.js:1113`) 前面（`sessions` 本身是合法规则 id 形状）。
   这三条在任何"路由表化"重构里都会变成隐性回归点。

---

# 七、复跑命令

```bash
cd /home/trtyr/code/hids-ai-console
git rev-parse --short HEAD                    # 899ae25
wc -l server.js openapi.yaml maintenance-server.js
# 路由分支（45 个条件行 ≈ 58 条实现路由）
ffgrep "url.pathname" path=server.js
ffgrep "pathname" path=maintenance-server.js
# 契约：50 路径 / 57 操作
ffgrep "^  /api"              # 50 个路径行
ffgrep "operationId:" context=6 limit=80
# 聚合方法面
ffgrep "async " path=triage-monitor.js / fp-maintainer.js / wiki-workbench.js / rule-store.js / wiki-store.js / trace-board.js
# 前端实际消费的路由
grep -rhoE "'/api/[a-zA-Z0-9_/:{}.$-]*'" web/ --include=*.js | sort -u
```

**未查到的（供下次接力）**：`openapi.yaml` 与 `server.js` 的**逐操作差异表**未做（我只标出了 1 条未文档化路由 + 2 条已下线路由）；`/api/data/cleanup` 的 7 类存储与 `DATA_KINDS`（`server.js:621`）之外的**漏盘点存储**（`fp-sessions/`、`rules-history/`、`rule-sessions/`、`wiki-history/`、`prompt-overrides/`）没有对应路由；`openapi.yaml` 的 `components/schemas`（约 1700 行）未逐字段核对。
**外部依赖**：无（未联网、未装包、未构建、未改任何文件）。