读完 `openapi.yaml`（3339 行 / 50 路径 / 57 个操作）与 `server.js`（1505 行），并追到 `cloudwalker.js` / `triage-monitor.js` / `trace-board.js` / `wiki-store.js` / `wiki-workbench.js` / `rule-store.js` / `fp-maintainer.js` / `update-store.js` / `prompt-store.js` / `log.js` / `maintenance-server.js` 的实际返回形状。

**报告头**
- commit：`e98cd2abd10aab0fabf34457eacf20af470d1002`（2026-11-20 18:02:09 +0800）
- 文件 mtime：`server.js` Nov 20 15:18 / `openapi.yaml` Nov 20 12:45
- 口径：**实现为准**（openapi 只作为交叉核对）；「筛选·排序·搜索」一栏写的是 `server.js` 里真的解析的 query 参数，不是 schema 声称的
- 术语：本仓的 severity 叫 **`level`**（low/medium/high/critical/unknown），下文统一用 level

---

# 一、能力基线总表（50 路径 / 57 操作）

##1. 状态与配置（10 操作）

| path | method | 响应顶层字段 / 数组元素 | 分页·筛选·排序·搜索（实际实现） | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/session` | GET | `{authenticated, user, role}`（role 恒 `operator` 或 null） | 无 | 否 | openapi.yaml:44 / server.js:898 |
| `/api/config` | GET | `{host, port, triage_input_mode, cloudwalker{configured}, model{configured,name,roles{5×{model,source}}}, auth{basic_auth_enabled}, secrets{5 个布尔}, missing_required[]}` | 无 | 否 | openapi.yaml:66 / server.js:909 |
| `/api/config` | POST | `{updated[], config{同 GET}}`；请求 11 个可写键 | 部分更新（只改正文出现的键），表外键 400 | 否 | openapi.yaml:66 / server.js:913 |
| `/api/status` | GET | 200 `{configured, connected, eventTypes[], transport}`；502 `{configured, connected:false, reason, code}` | 无 | 否 | openapi.yaml:471 / server.js:945 |
| `/api/updates` | GET | `{revision, current{version,title,summary,date,modules[],changes{features[],improvements[],fixes[]},updated_at,sequence,id,filename,uploaded_at}, history[], modules[{id,name,version,description}]}` | 无 | 否 | openapi.yaml:507 / server.js:905 |
| `/api/agent/status` | GET | `{configured, model, missing[], prompt_version}` | 无 | 否 | openapi.yaml:515 / server.js:962 |
| `/api/agent/tools` | GET | `{provider, readOnly, count, tools[]}`（tools 元素不透明） | 无 | 否 | openapi.yaml:533 / server.js:952 |
| `/api/trace/tools` | GET | 同上，`provider=cloudwalker-mcp` | 无 | 否 | openapi.yaml:541 / server.js:957 |
| `/api/agent/prompts` | GET | `{version, revision, sections[{id,name,kind(core/scenario/sop),characters,read_only?}]}` | 无 | 否 | openapi.yaml:549 / server.js:1224 |
| `/api/agent/prompts/upload` | POST | 恒 410（入口下线） | — | 否 | openapi.yaml:557 / server.js:1228 |

## 2. 数据管理 · 日志（4 操作）

| path | method | 响应顶层 / 数组元素 | 分页·筛选·排序·搜索 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/data/inventory` | GET | `{data_dir, stores[{kind,label,path,exists,count,bytes,oldest_at,newest_at}], total{count,bytes}}` | 无（固定 7 类，顺序固定） | 否 | openapi.yaml:247 / server.js:920 |
| `/api/data/cleanup` | POST | `{dry_run, kind, action, threshold{older_than,keep}, candidates{count,bytes,items[{name,bytes,at,status?}],truncated}, applied{count,bytes}, inventory}` | 阈值 `older_than`/`keep`；清单**最多 100 条** | 否 | openapi.yaml:278 / server.js:922 |
| `/api/logs` | GET | `{logs[{time,level,event,+事件自定义键}], total, files, truncated, echo{count,offset}}` | 分页 count 1..50 / offset≥0；筛 `event`(逗号多选) `level`(info\|warn\|error 逗号多选) `from` `to`；**排序固定 time 倒序，无 sort 参数**；扫描上限 20000 条 | 否 | openapi.yaml:353 / server.js:929 |
| `/api/logs/cleanup` | POST | `{dry_run, threshold{older_than,max_bytes}, candidates{count,bytes,items[{name,bytes,at}],truncated}, applied{count,bytes}, remaining{count,bytes}}` | 阈值二选一 | 否 | openapi.yaml:416 / server.js:940 |

## 3. 告警（2 操作）

| path | method | 响应顶层 / 数组元素 | 分页·筛选·排序·搜索 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/alerts` | GET | `{alerts[], total, totals{type:int}, errors{type:msg}, partial, truncated?, triage_configured, query{count,offset}, note}`；**alerts[] 实际 23 个字段**：`id,eventType,eventId,hostId,createdAt,time,title,level,levelKey,asset,source,target,assetIp,account,command,verdict,verdictKey,coverage,cases,scenario,detail,evidence[],gap,state` + 服务端追加 `triage`(TriageCase 全量) | 分页 count/offset；筛 `type`(单值) `level`(逗号多选，收 levelKey 或 1-4) `q`(对 id/title/asset/source/target/account/command 包含匹配) `from` `to` `triage_status`(5 值多选) `verdict`(4 值多选)；排 `sort=time\|level` | 否 | openapi.yaml:570 / server.js:1359；元素 cloudwalker.js:36-64 |
| `/api/alerts/{alertId}` | GET | `{alert{同元素+triage}, detail{牧云原始事件，**无固定 schema**，字段随 11 种类型变}}` | 无 | 否 | openapi.yaml:634 / server.js:1380 |

## 4. 自动研判（7 操作）

| path | method | 响应顶层 / 数组元素 | 分页·筛选·排序·搜索 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/agent/triage/status` | GET | `TriageSummary`：`{initialized,enabled,input_mode,since,last_poll_at,last_error,counts{queued,running,done,failed},verdict_counts{threat,uncertain,false_positive,review},type_counts{},backoff_ms,empty_polls,concurrency,queue_limit,dropped,queue{depth,running,oldest_wait_ms,oldest_alert_id,retry_waiting},failure_reasons{},retry{base_ms,max_ms,max_attempts,dead_letters},paused{active,since,received,buffered,dropped,replayed},archived{count,ttl_ms},persist{interval_ms,unflushed}}` + syslog 模式 `{syslog{listening,bind,error},syslog_stats{...},last_received_at}` | 只 `since`（**无 to，无区间**） | 否 | openapi.yaml:667 / server.js:999 |
| `/api/agent/triage/cases` | GET | `{total, cases[]}`；元素：`alert_id,matched_alert_id,result_alert_id,status,stage,detail,created_at,updated_at,saved_at,case_dir,repeat_count,verdict,verdict_label,summary,report,missing_evidence[],next_actions[],evidence_refs[],evidence[],verified_facts,evidence_sources,msgid,decision_source,rule_id,event_time,host_ip,source_ip,command`（**无 steps**） | 分页 count/offset；筛 `verdict`(多选) `type` `host`(精确) `from` `to`；排 `sort=time\|verdict` | 否 | openapi.yaml:691 / server.js:1123；元素 triage-monitor.js:540-556 |
| `/api/agent/triage/control` | PUT | `TriageSummary`；请求 `{enabled}` | — | 否 | openapi.yaml:722 / server.js:1133 |
| `/api/agent/triage/{alertId}` | GET | `TriageCase`：`alert_id,matched_alert_id,status,attempts,dead_letter,next_attempt_at,failure{reason,code,at},stage,detail,verdict,verdict_label,decision_source,feedback{reason,who,recorded_at},maintenance{status,updated_at,session_id,sides[],decision{source,libraries[],why},auto_verdict,rule{...},wiki{...}},report,verified_facts,evidence_sources,evidence[{evidence_id,tool,fetched_at,sha256,args?,args_omitted?}],steps[{stage,detail,at}]`（**`input` 原始报文被剥掉**） | 无 | 否 | openapi.yaml:749 / server.js:1216；triage-monitor.js:518-524 |
| `/api/agent/triage/{alertId}` | POST | 202 `TriageCase`；429 队列满 | — | 否 | openapi.yaml:749 / server.js:1217 |
| `/api/agent/triage/{alertId}` | DELETE | `{alert_id, status:'not_queued', cancelled:true}` | — | 否 | openapi.yaml:749 / server.js:1220 |
| `/api/agent/triage/{alertId}/false-positive` | POST | 202 `{alert_id, verdict{verdict,verdict_label,source}, feedback{reason,who,recorded_at}, maintenance{...}}`；请求 `{reason,who?,libraries?}` | — | 否（维护在后台跑，只能轮询） | openapi.yaml:817 / server.js:1141 |

## 5. 深度研判 · 溯源（6 操作）

| path | method | 响应顶层 / 数组元素 | 分页·筛选·排序·搜索 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/agent/investigations` | POST | 200 `Investigation`：`{alert_id,mode,saved_at,verdict{verdict,verdict_label,report,summary,claims[],missing_evidence[]},review{assessment,concerns[],missing_evidence[]},validation{ok,errors[]},evidence[{evidence_id,tool,args,fetched_at,sha256,view}],trace[],turns[{turn,phase,role,attempt,messages,input_chars,reply_chars,tools[],outcome,conclusion,note}],required_evidence[]}` | 无 | **是**（`?stream=1`；事件 type=progress\|result\|error；15s 心跳） | openapi.yaml:878 / server.js:1306,1317 |
| `/api/agent/investigations/{alertId}` | GET | 200 `Investigation` / 404 | `mode=deep\|triage` | 否 | openapi.yaml:912 / server.js:1350 |
| `/api/agent/investigations/{alertId}/replay` | GET | `InvestigationReplay`：`{alert_id,mode,model,saved_at,prompt_version,degraded,counts{turns,tool_calls,evidence},turns[],tool_calls[{step,kind,turn,name,action,id,keyword,evidence_id,found,error,matches}],verdicts[{turn,phase,verdict,verdict_label,confidence}],final{...},review,validation,evidence[{evidence_id,tool,fetched_at,sha256}]}` | `mode=deep\|triage` | 否 | openapi.yaml:930 / server.js:1338 |
| `/api/trace/boards` | GET | `{boards[], total}`；元素：`id,alert_id,title,type,host,occurred_at,status,chain_length,has_gaps,created_at,updated_at` | 分页 count/offset；筛 `status`(running/done/failed/interrupted 多选) `type` `host`(精确) `from` `to`；排固定 updated_at 倒序 | 否 | openapi.yaml:954 / server.js:968；trace-board.js:82-92 |
| `/api/trace/boards` | POST | 200/202 `TraceBoard`；请求 `{target\|alert_id\|ip, focus?}` | — | 否 | openapi.yaml:954 / server.js:978 |
| `/api/trace/boards/{target}` | GET | `TraceBoard`：`{id,alert_id,title,seed,run_id,created_at,updated_at,status,alert{...},hops[],links[],discovery[],chain_length,has_gaps,nodes[],edges[],activity[],summary,gaps[],investigations,window{since,until,hours},model,focus,origin_evidence}` | 无 | 否 | openapi.yaml:1042 / server.js:990 |

## 6. 规则（12 操作）

| path | method | 响应顶层 / 数组元素 | 分页·筛选·排序·搜索 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/triage/rules` | GET | `{config{schema_version,enabled,rules[{id,enabled,action,event_type,host_id,source_alert_id,reason,approved_by,valid_from,expires_at,conditions[]}]}, revision, writable}` | 无（规则集上限 200 条，一次全量） | 否 | openapi.yaml:1061 / server.js:1007 |
| `/api/triage/rules` | PUT | `JsonObject`（saveConfig 返回，字段未展开）；请求 `{config, expected_revision}` | 乐观并发（409） | 否 | openapi.yaml:1061 / server.js:1022 |
| `/api/triage/rules/validate` | POST | `{valid:true, count}`；请求 `{config}` | — | 否 | openapi.yaml:1095 / server.js:1012 |
| `/api/rules` | GET | `{count, rules[{id,name,description,file}]}` | **无分页/无筛选/无搜索/无排序** | 否 | openapi.yaml:1121 / server.js:1034；rule-store.js:219-223 |
| `/api/rules/evaluate` | POST | `{count, matched[{id,name,rego}]}` | — | 否 | openapi.yaml:1138 / server.js:1061 |
| `/api/rules/sessions` | GET | `{sessions[{id,case_id,event_type,who,status,rule_id,validated,updated_at}]}` | 无分页、无按 case_id/status 筛 | 否 | openapi.yaml:1162 / server.js:1040；rule-store.js:469-480 |
| `/api/rules/{id}/history` | GET | `{id, history[{id,rev,file,bytes,saved_at,note}]}` | 无分页；**不能只读预览某历史版本正文** | 否 | openapi.yaml:1231 / server.js:1075 |
| `/api/rules/{id}/rollback` | POST | `{id,file,name,rev,previous_rev,action:'rollback',rolled_back_to}`；请求 `{rev,who?}` | — | 否 | openapi.yaml:1257 / server.js:1085 |
| `/api/rules/{id}` | GET | `{id,name,description,file,rego,revision}` | — | 否 | openapi.yaml:1289 / server.js:1113 |
| `/api/rules/{id}` | PUT | `{id,file,name,rev,previous_rev,action(add/update/unchanged)}`；请求 `{rego, expected_revision, note?}` | 乐观并发（409） | 否 | openapi.yaml:1289 / server.js:1089 |
| `/api/false-positive/sessions` | GET | `{sessions[{id,case_id,event_type,who,status,terminal,libraries[],sides[],decision_source,updated_at}]}` | 无分页、无按 case_id 筛 | 否 | openapi.yaml:1185 / server.js:1046；fp-maintainer.js:138-148 |
| `/api/false-positive/sessions/{id}` | GET | 全文：`{id,case_id,case_dir,event_type,who,reason,libraries_requested[],status,terminal,turns[{n,phase,at,summary}],messages[{role,kind,content,at}],decision{source,libraries[],why},outcomes{rule,wiki},validation{ok,checks[]},auto_verdict{enabled,criterion,trust,note},error,created_at,updated_at}` | — | 否 | openapi.yaml:1208 / server.js:1050 |

## 7. 知识库（9 操作）

| path | method | 响应顶层 / 数组元素 | 分页·筛选·排序·搜索 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/wiki/pages` | GET | `{pages[{path,id,title,status,updated,revision,characters}], total}` | `q`(匹配 id/title/path 子串，**带 q 时硬截 50 条**)、`count`(可选1..50)、`offset`；**不带 count 时返回全量**；无 status 筛选、无排序 | 否 | openapi.yaml:1346 / server.js:1230-1241 |
| `/api/wiki/pages/{pagePath}` | GET | `{path,id,title,status,updated,revision,characters, content}` | — | 否 | openapi.yaml:1376 / server.js:1249 |
| `/api/wiki/health` | GET | `{checked_at, active_pages, issues[{path,kind,message}]}` | 需 X-Prompt-Admin-Token | 否 | openapi.yaml:1395 / server.js:1263 |
| `/api/wiki/sessions` | GET | `{sessions[{id,page,updated_at,status,message_count}]}` | 无分页、无筛选 | 否 | openapi.yaml:1407 / server.js:1264 |
| `/api/wiki/sessions` | POST | 201 `JsonObject`；请求 `{page}` 或 `{case_id,reason,expected_verdict,who}` | — | 否 | openapi.yaml:1407 / server.js:1265 |
| `/api/wiki/sessions/{sessionId}` | GET | 会话文件原文（字段未在 openapi 定义） | — | 否 | openapi.yaml:1450 / server.js:1284 |
| `/api/wiki/sessions/{sessionId}/messages` | POST | `JsonObject`；请求 `{content}` | — | 否 | openapi.yaml:1463 / server.js:1287 |
| `/api/wiki/sessions/{sessionId}/replay` | POST | `JsonObject` | — | 否 | openapi.yaml:1500 / server.js:1291 |
| `/api/wiki/sessions/{sessionId}/publish` | POST | `JsonObject`；请求 `{审核结论,有效期,备注…}` | — | 否 | openapi.yaml:1512 / server.js:1294 |

> ⚠ **openapi.yaml 里没有 `PUT /api/wiki/pages/{pagePath}`，但实现有**（server.js:1253-1258，Basic 认证 + `expected_revision` 乐观并发），而且前端 `web/src/knowledge.js:9,225` 已经在调它。按 openapi 生成客户端会踩空。

## 8. 维护服务（7 操作，独立端口 18081 / 独立账号）

| path | method | 响应顶层 | 筛选·排序 | SSE | 行号 |
|---|---|---|---|---|---|
| `/api/maintenance/session` | GET | `{authenticated, preview, login_enabled, user, role}` | — | 否 | openapi.yaml:1533 / maintenance-server.js:70 |
| `/api/maintenance/login` | POST | `{user, role}` + Set-Cookie | — | 否 | openapi.yaml:1542 / maintenance-server.js:73 |
| `/api/maintenance/logout` | POST | `{logged_out:true}` | — | 否 | openapi.yaml:1572 / maintenance-server.js:102 |
| `/api/maintenance/overview` | GET | `{revision, current, history[], modules[], packages[], preview, writable}` | — | 否 | openapi.yaml:1586 / maintenance-server.js:111 |
| `/api/maintenance/packages` | POST | 201 `{id, version}` | — | 否 | openapi.yaml:1598 / maintenance-server.js:122 |
| `/api/maintenance/packages/{packageId}` | GET | 包详情（`JsonObject`） | — | 否 | openapi.yaml:1633 / maintenance-server.js:130 |
| `/api/maintenance/packages/{packageId}/apply` | POST | 应用结果（`JsonObject`）；请求头 `If-Match` 必填 | — | 否 | openapi.yaml:1647 / maintenance-server.js:130 |

---

# 二、SSE / 长轮询 总账

| 项 | 结论 |证据 |
|---|---|---|
| SSE | **全仓仅1 处**：`POST /api/agent/investigations?stream=1`（`text/event-stream`，15s 心跳，事件 `progress`/`result`/`error`） | server.js:1317-1345；`grep text/event-stream` 只命中 server.js:1317 + openapi.yaml:908 |
| 长轮询 | **没有**。四个列表的 query 解析器（`alertQuery`/`caseQuery`/`traceQuery`/`logQuery`）全无 `wait`/`_wait`/`timeout` 之类参数 | server.js:507-560 |
| 其它推送 | 无 WebSocket、无 SSE 兜底。**研判队列在跑时，所有列表/详情都只能靠前端轮询** | server.js:1210-1222（triage 单条）、server.js:968-976（boards列表） |

---

# 三、逐屏判断：拿到这个响应够不够，还差什么

> 屏按 `web/src/router.js:27` 的 `PAGES` 列（overview / alerts / alerts-demo / alert-detail / trace / trace-board / rules / rules-gate / knowledge）。

### 1. 概览页 `overview`（`web/pages/overview.js`，adapter `web/src/status.js`）
用：`/api/agent/triage/status?since=`、`/api/status`、`/api/agent/status`、`/api/agent/tools`、`/api/triage/rules`、`/api/updates`

- **够**：结论分布、类型分布、队列四态与完成率、连接状态、模型与提示词版本、规则集 revision。
- **还差**：
  - **告警侧一个数字都拿不到**。后端没有任何告警聚合接口；`/api/alerts` 只给分页列表（`total` 是分页总数，`totals` 按类型）。`web/pages/overview.js:7` 已明写「本页不再请求 `/api/alerts`」——那"今日新增告警 N 起"这一格只能显示研判侧的数或前端自己造。
  - **没有时间序列接口**：`since` 只有起点、没有终点，也没有按小时/天分桶的计数。
  - **没有 top-N 接口**：最近告警、最近任务都只能前端排序全量。

### 2. 告警列表 `alerts`（`web/pages/alerts.js`，adapter `web/src/alerts.js`）
用：`/api/alerts`、`/api/agent/triage/status`、`PUT /api/agent/triage/control`、`POST /api/agent/triage/{alertId}`

- **够**：分页、类型/等级/关键字/时间/研判状态/结论筛选、`sort=time|level`。
- **还差**：
  - **severity 只有 level 一维**（low/medium/high/critical/unknown），且**不支持"≥high"语义**——`level=high` 只出 high 不含 critical（`cloudwalker.js:139` 按秩集合精确匹配）。要"高危以上"前端得自己多值并集再过滤 `levelKey`。
  - **`triage_status` / `verdict` 筛选走的是"逐页翻到流末"的扫描**（server.js:498 `TRIAGE_SCAN_LIMIT = 500`；server.js:590-608），超 500 条即 `truncated:true`、`total` 只统计窗口内匹配 → **前端分页器在这两个筛选下不可信**。
  - **没有按资产 / 主机 / 来源 IP 的结构化筛选**，只能 `q` 模糊包含。
  - **没有 SSE**：研判在跑时列表不自动刷新，状态全靠轮询。

### 3. 告警详情 `alert-detail`（`web/pages/alert-detail.js`，adapter `web/src/alert-detail.js`）
用：`GET /api/alerts/{alertId}`、`GET /api/agent/triage/{alertId}`、`GET /api/rules/{id}`、`POST /api/agent/triage/{alertId}`、`GET /api/agent/investigations/{alertId}?mode=`、`GET /api/trace/boards/{target}`

- **够**：告警摘要 + 牧云原始 detail + 研判记录 + 规则原文 + 溯源白板。
- **还差**：
  - **"相关告警 / 同资产其它告警"没有接口**——详情屏这一块只能前端造或者整页删。
  - **案卷原始报文读不到**：`GET /api/agent/triage/{alertId}` 的 `monitor.status()` 剥掉了 `input`（triage-monitor.js:520），记录里只剩 `case_dir`（服务端本地绝对路径）。**全仓没有任何 HTTP 接口读 `cases/<id>/01-原始告警.txt` / `03-研判事实.md` / `05-研判结果.md`**（server.js:109 只在进程内读）。前端要展示"原始报文 / 研判事实 / 研判结果"三份文件内容，**没有数据源**。
  - **证据原文分两处且 id 不同**：`triage.evidence[]` 只有 `{evidence_id,tool,fetched_at,sha256}`（工具名+指纹），原文在 `investigation.evidence[].view` 里，而后者要用牧云 id 查、且 `mode` 得对。前端要把两套 id 体系拼起来。

### 4. 研判/案件屏（adapter `web/src/cases.js` 已存在，`web/src/router.js:27` 的 PAGES 里还没有这一页）
用：`GET /api/agent/triage/cases`、`GET /api/agent/triage/{alertId}`、`POST /api/agent/triage/{alertId}`、`GET /api/agent/triage/status`、`PUT /api/agent/triage/control`、`POST …/false-positive`

- **还差（这一屏缺口最重）**：
  - **列表只含"有原始 syslog 报文"的记录**：`triage-monitor.js:529` 是 `filter(record => record.input)`。**由 `POST /api/agent/triage/{alertId}` 手工送研判的牧云事件根本没有 `input`，永远不出现在列表里**。"研判记录"屏会静默漏掉一大半记录 —— 缺一个"列出全部研判记录（含非 syslog 来源）"的接口。
  - **没有 level 筛选、没有 status 筛选**（只有 verdict）："排队中的""失败的"筛不出来，只能拉全量前端过滤 —— 这正是"前端造数据"。
  - **没有 `q` 搜索**：alert_id、主机 IP、命令行都搜不了。
  - **没有批量操作**：批量重试/批量取消只有单条 POST/DELETE。
  - **没有 SSE**：误报登记后维护在后台跑（server.js:1204-1216），只能轮询 `maintenance` 字段。

### 5. 溯源 `trace` / `trace-board`（`web/pages/trace.js`、`web/pages/trace-board.js`）
用：`GET/POST /api/trace/boards`、`GET /api/trace/boards/{target}`、`GET /api/trace/tools`

- **够**：白板列表分页 + 状态/类型/主机/时间筛选；详情有 hops/links/gaps/discovery。
- **还差**：
  - **running 白板无 SSE**，进度只能轮询 `GET /api/trace/boards/{target}`。
  - **详情的 `hops/links/nodes/edges/activity` 全量返回、无分页**——一条长链响应会很大。
  - **没有"节点级证据"接口**：单个节点的 findings/profile只能在详情里整体拿。

### 6. 规则 `rules` / `rules-gate` / `rule-detail`（adapters `web/src/rego-rules.js`、`web/src/rules.js`）
用：`/api/rules`、`/api/rules/{id}`、`/api/rules/{id}/history`、`/api/rules/{id}/rollback`、`PUT /api/rules/{id}`、`/api/rules/evaluate`、`/api/rules/sessions`、`/api/triage/rules`、`PUT /api/triage/rules`、`/api/triage/rules/validate`

- **够**：元数据列表、单条原文 + revision、历史、回滚、写入（乐观并发）、试算、前置规则集读写与草稿校验。
- **还差**：
  - **规则列表无分页、无搜索、无按事件类型筛选**（`/api/rules` 就是 `{count, rules[]}` 全量）。
  - **没有"规则命中记录 / 命中统计"接口** —— "哪条规则最常命中"这类图前端造不出来。
  - **历史版本不能只读预览**：`GET /api/rules/{id}/history` 只给 `rev/bytes/note`，回滚是"按 rev 盲提交"，前端没法先看旧版正文再决定。
  - **规则库错误定位靠解析文本**：`rules/<file>:<行>` 是塞在 `error` 一句话里（openapi.yaml:1130），前端要正则解析才能标到行。
  - **维护会话只能按 id 查，没有按 case_id 查**：从一条案件跳到它的规则维护会话，前端得拉全量自己 find。

### 7. 知识库 `knowledge`（`web/pages/knowledge.js`，adapter `web/src/knowledge.js`）
用：`GET /api/wiki/pages`、`GET /api/wiki/pages/{path}`、**`PUT /api/wiki/pages/{path}`**、`GET /api/wiki/health`、`GET /api/wiki/sessions`、`POST /api/wiki/sessions/{id}/messages|replay|publish`

- **够**：目录列表、正文读写（带 `expected_revision` 乐观并发）、判据库体检。
- **还差**：
  - **不带 `count` 时返回全量**（server.js:1241 `pages.slice(offset)`），没有上限 —— 库一大前端一次拉爆。
  - **`q` 不搜正文**，只匹配 id/title/path，且**带 q 时硬截 50 条**，`total` 也是截断后的数（server.js:1238-1241）→ 分页器会算错。
  - **没有按 `status`（active/draft/deprecated/reference）筛选，没有排序**。
  - **契约缺口**：`PUT /api/wiki/pages/{pagePath}` 未进 openapi.yaml（见上）。

### 8. 维护屏（18081，独立账号）
- **够**：登录/登出/概览/包暂存/包详情/应用（`If-Match` 乐观并发）。
- **还差**：**业务前端（8080/8081）拿不到任何维护数据**。可安装的升级包列表只在 18081 且要独立账号；业务端 `/api/updates` 只给"当前装着的版本 + 历史"，不给"能装什么"。若业务控制台要出"有新版本可更新"的提示，**后端没有数据源**。
- 另外：维护端的错误体只有 `{error}`，**没有 `code`**（maintenance-server.js:59,73,102,111…），与业务端 `{error, code}` 四类口径不一致；openapi.yaml:1611-1660 却按 `Error` schema（required: [error, code]）声明。

### 9. 登录 / 外壳（`web/src/session.js`、`web/src/views/login.js`）
- `/api/session` 够显示"账号 + 角色"。
- **还差**：业务端 `role` 恒为 `operator`，**没有权限矩阵接口**（这个账号能点哪些按钮、哪些接口要 `X-Rule-Admin-Token` / `X-Prompt-Admin-Token`）——前端只能靠硬编码判断。

---

# 四、openapi.yaml ↔ 实现 的契约不一致清单

| # | 端点 | openapi 声称 | 实现实际 | 证据 |
|---|---|---|---|---|
| 1 | `PUT /api/wiki/pages/{pagePath}` | **无此操作**（路径下只有 `get`） | 有，Basic 认证 + `expected_revision` 乐观并发；前端已在用 | openapi.yaml:1376 / server.js:1253-1258 / web/src/knowledge.js:9,225 |
| 2 | `GET /api/alerts` 200 | 列7 个键 | 还多 `query{count,offset}` 与 `note` 两键 | cloudwalker.js:252-259 |
| 3 | `Alert` 元素 | 只列 10 个字段 | 实际 `normalizeAlert` 给 23 个（`eventType/eventId/hostId/time/source/target/account/command/coverage/cases/scenario/detail/evidence/gap/state`） | cloudwalker.js:36-64 vs openapi.yaml:2283-2300 |
| 4 | `GET /api/status` 200 | 列 `configured/connected/reason` | 成功时给 `configured/connected/eventTypes[]/transport`，**没有 reason** | cloudwalker.js:116-118 / server.js:946-949 |
| 5 | 维护端错误体 | `Error` schema required `[error, code]` | 只有 `{error}`，无 `code` | maintenance-server.js:59,73,102,111,122,130 / openapi.yaml:1611-1660 |
| 6 | `GET /api/wiki/pages` 的 `total` | "切页前条数" | 带 `q` 时是**截断到 50 条之后**的条数 | server.js:1238-1241 |
| 7 | `/api/updates`、`/api/agent/prompts`、`/api/wiki/health`、`/api/wiki/sessions*`、`GET/PUT /api/triage/rules` | `JsonObject`（字段未定义） | 字段其实是确定的，前端只能照实现写 | update-store.js:102-111 / prompt-store.js:94-105 / wiki-store.js:209 / wiki-workbench.js:104 / server.js:1008,1031 |

---

# 五、给「前端不造数据」这句话最硬的六条缺口

1. **没有研判记录列表** —— `/api/agent/triage/cases` 只列有 syslog 原始报文的记录（triage-monitor.js:529），手工送研判的牧云事件一律缺席；也没有 `<数据根>/investigations/` 的列表接口（只有 `/api/data/inventory` 给计数）。
2. **没有案卷文件读取接口** —— `01-原始告警.txt` / `03-研判事实.md` / `05-研判结果.md`只能进程内读（server.js:109），HTTP 侧只有 `case_dir` 这个本地路径字符串。
3. **没有告警侧聚合/时间序列接口** —— 概览屏的告警数字无从落地（`/api/alerts` 的 `total`/`totals` 只在分页扫描窗口内成立）。
4. **只有 1 个 SSE、0 个长轮询** —— server.js:1317 是全仓唯一流式出口；误报维护进度、研判队列状态、running 白板进度都只能轮询。
5. **筛选维度不齐** —— 案件列表无 level、无 status、无 `q`；白板列表无 level、无 `q`；日志无自由文本搜索；`/api/rules` 无分页/搜索。
6. **历史与正文不可只读预览** —— 规则历史只有 `rev/bytes/note`，回滚是盲操作；知识库目录不带 `count` 时全量返回；`q` 搜索硬截 50 条。

---

# 六、复现命令（全部只读，未改动任何文件）

```bash
# 路由分支的精确行号（server.js 共 1505 行）
grep -n "url.pathname ===" server.js
grep -n "url.pathname.startsWith\|url.pathname.match" server.js

# openapi.yaml 的 50 个路径键行号
grep -n "^  /api/" openapi.yaml
# （ffgrep 对含 "/" 的模式分词失效，改用首段锚点亦可，例如 grep -n "session:" openapi.yaml）

# 每个 operation 的 schema锚点
grep -n "operationId" openapi.yaml

# SSE 只有一处
grep -rn "text/event-stream" --include=*.js --include=*.yaml .

# 关键实现点
grep -n "TRIAGE_SCAN_LIMIT\|MAX_SCAN\|QUERY_SCAN_LIMIT" server.js cloudwalker.js log.js
grep -n "filter(record => record.input)" triage-monitor.js
grep -n "pages.slice(offset" server.js
grep -n "async list()\|async browse()\|async overview()\|async metadata()" rule-store.js fp-maintainer.js wiki-store.js update-store.js prompt-store.js
```

**证据引用汇总**：`server.js:898,905,909,913,920,922,929,940,945,952,957,962,968,978,990,999,1007,1012,1022,1034,1040,1046,1050,1061,1068,1075,1085,1089,1110,1113,1123,1131,1137,1141,1216,1217,1220,1224,1227,1228,1230,1249,1253-1258,1263,1264,1265,1284,1287,1291,1294,1306,1317,1338,1350,1359,1371,1380,1392` / `openapi.yaml:44,66,247,278,353,416,471,507,515,533,541,549,557,570,634,667,691,722,749,817,878,912,930,954,1042,1061,1095,1121,1138,1162,1185,1208,1231,1257,1289,1346,1376,1395,1407,1450,1463,1500,1512,1533,1542,1572,1586,1598,1633,1647` / `cloudwalker.js:28,36-64,116-118,139,252-259` / `triage-monitor.js:518-524,529,540-556,575-640` / `trace-board.js:82-92,318-329` / `wiki-store.js:20-26,63,127-135,189-209` / `wiki-workbench.js:87-105` / `rule-store.js:219-233,469-480` / `fp-maintainer.js:138-148` / `update-store.js:19-26,102-111` / `prompt-store.js:94-105` / `log.js:157,257-281` / `maintenance-server.js:59,70,73,102,111,122,130`