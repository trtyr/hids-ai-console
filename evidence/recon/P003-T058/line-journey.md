# 运维一天 → 后端能力倒推报告

**基线**：commit `e98cd2abd10aab0fabf34457eacf20af470d1002`（2026-11-20 18:02 +0800）｜`openapi.yaml` 3339 行 / 50 条路径｜`server.js` 102666 B｜只读审计，未改任何文件。
**方法**：先按运维真实一天写旅程与"屏幕必须有的每一个数据项"（不查 API），再逐项回查 `openapi.yaml` + `server.js` 路由做映射。
**一句话结论**：**"读"的覆盖度高，"写"和"跨对象关联"是缺口**——单条告警的读（列表/详情/研判/溯源/证据）基本齐；缺口集中在 **处置（关单/升级/人工结论只有误报一种）、分派、审计浏览入口（没有研判记录列表）、规则/判据的历史回滚不对称、案卷材料不可读、聚合统计维度不足**。

---

## 一、旅程表

| # | 步骤（运维的一天） | 屏幕必须显示的每一个数据项 | 对应 API | 缺口 |
|---|---|---|---|---|
| 1 | **上班第一屏**：系统是否活着、今日战况 | ①牧云连通 `configured/connected/reason` ②模型就绪 `configured/model/missing/prompt_version` ③输入模式 `input_mode`、syslog 绑定 `listening/bind/error`、最后收到报文 `last_received_at`、收包统计 `inbound/accepted/collapsed/buffered/dropped/rejected/failed` ④队列 `depth/running/oldest_wait_ms/oldest_alert_id/retry_waiting` ⑤四态计数 `counts`、结论分布 `verdict_counts`、类型分布 `type_counts` ⑥失败原因分布 `failure_reasons`、重试参数 `retry{base_ms,max_ms,max_attempts,dead_letters}` ⑦暂停窗 `paused`、归档 `archived`、落盘 `persist` ⑧**今日告警数/等级分布/误报率/MTTR/趋势曲线** ⑨生效配置 `host/port/model.roles/secrets/missing_required` | `GET /api/status`(openapi.yaml:471)·`GET /api/agent/status`(:515)·`GET /api/agent/triage/status`(:667)·`GET /api/config`(:66)·`GET /api/alerts?count=1`(:570)·`GET /api/data/inventory`(:247) | **无任何时间序列/按主机·等级聚合接口**——`triage/status` 只有三个聚合(:2396-2460)、`alerts.totals` 只按事件类型(:620)；"今日告警数/MTTR/误报率趋势"全无接口。`since` 参数(:1775)只作用于那三个聚合，不给趋势 |
| 2 | **告警进来**：列表 + 筛选 | 行：告警 ID、类型中文名、标题、资产名、资产 IP、等级(中文+机器值)、事件时间、来源 IP、目标 IP、账号、命令行、状态、结论、重复次数、覆盖度 `coverage`、内嵌 `triage`；筛：类型(11类)、等级(多选)、关键字、时间范围、排序(时间/等级)、研判状态、结论；分页 `total/offset/count/truncated/partial/errors`；各类总数 `totals`；**是否有新告警到达** | `GET /api/alerts`(:570)、`GET /api/agent/triage/cases`(:691) | ①**无按主机/资产/账号/来源 IP 的结构化筛选**：只有 `q` 模糊(:1707-1713)；而 cases 列表有 `host` 精确筛(:1760)——两列表口径不一致。②**无增量/实时**：无 cursor/SSE；带筛选最多扫 500 条原始事件，超限 `truncated=true`、`total` 不准(:600-607)。③行内无 `owner/assignee/处置位`。④**类型/等级中文名无字典接口**：表在 `cloudwalker.js:2-6`(类型) 与 `:29`(等级)，前端只能硬编码——实例 `web/src/trace-view.js:13-18` |
| 3 | **看详情** | 告警摘要全部字段；牧云原始详情（11 类各自原生键：`path/sha256/detect_reason`、`local_addr/remote_addr`、`exepath/cmdline/origin_uid/target_uid`、`source_ip/address/time_aix`、`login_ip/login_username/auth_type`…）；通用键 `cmdline/shell_cmdline/process_path/uname/remote_addr/local_addr/file_path/description/process_tree/cmdlines`；身份校验；该告警研判任务+步骤时间线 `steps`+结论+证据+复核；**同主机/同源 IP 的其他告警**；**案卷材料 8 个文件**；该告警的溯源白板 | `GET /api/alerts/{alertId}`(:634)·`GET /api/agent/triage/{alertId}`(:749)·`GET /api/trace/boards/{target}`(:1042) | ①**无「同主机/同源 IP 的其他告警」查询**（全表无此路径）。②**案卷内容不可读**：`case_dir` 只给绝对路径(:2741)，而文件 `00-这是什么.md / 01-原始告警.txt / 02-告警字段.md / 03-研判事实.md / 03b-判据索引.md / 04-上下文.md / 05-研判结果.md / result.json`（`syslog-case.js:104-118,144`）**没有任何读取接口**。③「本次同会话时间窗/历史结论」只落在案卷 `04-上下文.md`，无接口 |
| 4 | **派 / 研判** | 触发常规研判入队、重试、取消排队；触发深度研判(SSE 流)；队列位置/等待时长/预计开始；研判步骤时间线 `steps(stage,detail,at)`；**人工分派：负责人、优先级、备注、升级给谁** | `POST /api/agent/triage/{alertId}`(:764)·`DELETE`(:792)·`PUT /api/agent/triage/control`(:723)·`POST /api/agent/investigations`(SSE,:878) | ①**无分派/负责人/优先级/备注字段，也无写接口**。②**案件状态机无处置位**：`status` 枚举只有 `not_queued/queued/running/done/failed`(:2498)，没有"已处置/待复核/已升级/已搁置"。③在跑的案件**不可中止**(:792)。④深度研判只能单条起，无批量派发 |
| 5 | **溯源与证据** | 白板：`hops(id,kind,label,host,occurred_at,evidence_id,discovered)`、`links(from,to,rel,evidence_id)`、`gaps(hop_id,reason)`、`discovery(step,kind,id)`、`chain_length/has_gaps`、`summary`、`window{since,until,hours}`、`investigations/model/focus/origin_evidence`；活动流水 `activity(seed/tool/tool_error/investigate/look/link/conclude/thinking/model_error/error)`；节点档案 `nodes(kind,label,address,status,why,profile,findings,finding_count,touched_hosts,discovered_from)`；边 `edges(rel,why,strength,by=program\|ai,citations,at)`；证据 `evidence[](evidence_id,tool,args,fetched_at,sha256,view)`；引用 `claims[].citations(evidence_id,pointer,value)`；必查项 `required_evidence(id,label,tool,scope,status,reason,returned_count,total_reported,platform_total_consistent,catalog_absent)`；复核 `review(assessment,concerns,missing_evidence)`；校验 `validation(ok,errors,removed_unverified_facts)`；**被 view 省略的证据原文** | `GET /api/trace/boards/{target}`(:1042)·`GET /api/agent/investigations/{alertId}`(:912) | ①**证据只有投影视图**：`view` 单条≤6000 字、省略字段只记计数(:2073-2090)，**无「按 evidence_id 取原始取证结果」接口**，客户逐字段复核只能拿 view。②无「按证据 ID 取单条」接口（必须整份拉）。③**白板不能重跑、不能对比历史版本**：同一 target 直接返回旧白板(:1007)，无版本号/无历史/无 diff。④白板按 target 键存，列表只给 `type/host/status` 筛(:960-990)，**没有 verdict/结论**字段 |
| 6 | **处置**（误报/关单/升级） | 误报：理由(10-4000字)、登记人、登记时刻；登记后：`verdict=false_positive`、`decision_source=human`、两侧维护进度 `rule/wiki{status,state,why,idempotency_key,error,id,file,action,page,revision}`；维护会话全文 `turns/messages/decision/outcomes/validation/auto_verdict`；**关单/升级：动作、目标、原因、时刻**；处置后统计与**操作记录** | `POST /api/agent/triage/{alertId}/false-positive`(:817)·`GET /api/false-positive/sessions`(:1185)·`GET /api/false-positive/sessions/{id}`(:1208) | ①**只有误报一种人工结论**：`server.js:1141` 是唯一改 `verdict` 的路由(:1176-1178 只写 `false_positive`)，**人工判"真实威胁/存疑"无写接口**。②**关单/升级完全无处落地**：无处置动作、无处置人、无处置时间；状态机无处置位(:2498)。③**无案件级操作记录数组**。④误报要求 `status=done`（`server.js:1169`），在跑/排队中的告警不能先标"待处置" |
| 7 | **规则维护** | JSON 前置规则集：`schema_version/enabled/rules[]{id,enabled,action,event_type,host_id,source_alert_id,reason,approved_by,valid_from,expires_at,conditions[]}`；规则集 `revision`+是否可写+来源；校验结果 `valid/count`+错误定位；Rego 库 `id/name/description/file/revision`+原文；单规则历史 `rev/note/saved_at/replaced_by`+回滚；**规则命中历史（哪条规则命中了哪些告警、命中率）**；规则维护会话过程；生效口径 `auto_verdict{rego, single}` | `GET/PUT /api/triage/rules`(:1061)·`POST /api/triage/rules/validate`(:1095)·`GET /api/rules`(:1121)·`GET/PUT /api/rules/{id}`(:1289)·`GET /api/rules/{id}/history`(:1231)·`POST /api/rules/{id}/rollback`(:1257)·`POST /api/rules/evaluate`(:1138)·`GET /api/rules/sessions`(:1162) | ①**JSON 规则集无历史/无回滚**：`triage-rules.js:247-255` 只有乐观锁，Rego 单条才有(`rule-store.js:293-354`)——两套规则体系历史能力不对等。②**规则维护会话只有摘要、无全文**：`server.js:1040` 只 list，误报会话却有全文(`server.js:1050`)——"为什么这么改"不可查。③**无规则命中历史查询**：命中只落在案件记录(`triage-monitor.js:1070` 的 `rule_id` + steps 文字)，只能现场 evaluate(:1138)。④Rego 侧**无整库 revision/发布时间**视图。⑤生效判据只认 Rego(:2618)，前端要同时呈现两套体系，缺"当前生效哪一套+版本"的单一视图接口 |
| 8 | **知识库维护** | 页面目录 `id/title/path`+搜索；页面全文+frontmatter+`revision`；编辑与并发保护 `expected_revision`；维护会话：状态/草稿/追问 `messages`/replay 核对/publish 审核(结论·有效期·备注)；**页面历史版本与回滚**；判据库健康；**本次研判用了哪些判据页** | `GET /api/wiki/pages`(:1346)·`GET/PUT /api/wiki/pages/{pagePath}`(:1376)·`GET/POST /api/wiki/sessions`(:1407)·`GET /api/wiki/sessions/{id}`(:1450)·`POST .../messages`(:1463)·`POST .../replay`(:1500)·`POST .../publish`(:1512)·`GET /api/wiki/health`(:1395) | ①**`PUT /api/wiki/pages/{pagePath}` 没写进 openapi.yaml**：路由真实存在(`server.js:1252`，带 `expected_revision` 乐观锁)，但契约里该路径只有 `get`(:1376-1394)——前后端都会以为"页面不能改"。②**页面历史/回滚无接口**：旧版备份已落 `<数据根>/wiki-history/`(`wiki-store.js:225-235`)，却无路由可列/读/回滚（Rego 侧有）。③**wiki 会话列表与详情响应是无 schema 的 `JsonObject`**(:1405,1447,1461…)，前端拿不到字段约定。④搜索命中上限 50 条(`server.js:1241` slice(0,50)；:1354 描述)，`total` 是截断后的数。⑤「本次用了哪些判据页」只在案卷 `03b-判据索引.md`(`syslog-case.js:117`)，无接口 |
| 9 | **审计回放** | **历史研判记录列表**（时间/告警/结论/模式/操作人）；单次回放 `turns(turn,phase,role,attempt,messages,input_chars,reply_chars,tools,outcome,conclusion,note)`、`tool_calls(step,kind,name,action,evidence_id,found,error,matches)`、`verdicts` 变化、`final(verdict,confidence,summary)`、`review`、`validation`、`evidence` 清单、`degraded/prompt_version/model/saved_at`；误报会话回放(case→libraries→propose→verify)；知识库会话 replay；**队列归档记录**；**操作日志（谁在何时做了什么）**；清理/配置变更历史 | `GET /api/agent/investigations/{alertId}/replay`(:930)·`GET /api/agent/investigations/{alertId}`(:912)·`GET /api/false-positive/sessions/{id}`(:1208)·`POST /api/wiki/sessions/{id}/replay`(:1500)·`GET /api/logs`(:353)·`GET /api/updates`(:507) | ①**没有研判记录列表接口**：investigations 只有 POST(`server.js:1306`)、按键 GET(:1350)、replay(:1339)——审计员**无法浏览"昨天研判了哪些"**，只能一个 alert_id 一点；`data/inventory` 只给条数(:247)。②**逐轮模型消息正文不落盘**：`turns` 明写"消息正文一个字都不在这里"(:2822)。③**队列归档不可读**：`done` 记录 TTL 归档写 `.archive.jsonl`，无查询接口；且 cases 列表"只列有原始 syslog 报文的记录"(:2722)，**poll 模式入队的案件根本不在列表里**。④**操作日志默认不存在**：`/api/logs` 只读盘上文件，没配 `HIDS_LOG_FILE` 就 503(:353)，而 inventory 明说"后端自身不落日志文件（只上 stdout）"(:262)——默认部署下"谁做了什么"无处可查。⑤配置覆盖层变更无流水（`config-store.js` 只存改过的键），`/api/updates` 的 history 是**提示词策略包**历史(`update-store.js:106`)，不是配置变更历史 |
| 10 | **配置与数据清理** | 生效配置 + 机密布尔 + 模型分层角色；数据根路径 + 七类存储 `count/bytes/oldest_at/newest_at/exists`；清理候选清单 `name/bytes/at`(+队列项 `status`)+阈值+执行结果+执行后盘点；**归档目录内容**；日志轮转文件清单与余量；维护端登录/版本/升级包列表·详情·上传·应用；提示词版本与章节（只读） | `GET/POST /api/config`(:66)·`GET /api/data/inventory`(:247)·`POST /api/data/cleanup`(:278)·`GET /api/logs`(:353)·`POST /api/logs/cleanup`(:416)·`/api/maintenance/*`(:1533-1668)·`GET /api/agent/prompts`(:549)·`GET /api/updates`(:507) | ①**可写配置项只有 11 个**（模型/牧云键，:141-160 enum），`HIDS_TRIAGE_INPUT_MODE`/并发度/队列上限/syslog 偏移/日志路径改不了（表外键 400）——改输入模式必须重启。②**清理候选无业务明细**：`items` 只有 `name/bytes/at`(:1985-2000)，看不出"这条是哪个告警/什么结论"。③**归档不可查也不可还原**：执行后进 `<数据根>/archive/<kind>/`(:284-291)，无列表/还原接口——归档即"看不见的数据"。④**清理/配置变更无审计流水**（只有 `data.cleaned`/`config.updated` 一条受限日志，且默认没落文件）。⑤**维护端与 `/api/updates`/`/api/agent/prompts` 响应全是无 schema `JsonObject`**(:1584/1596/1645/1665/514/556)，且维护端在另一端口、另一套鉴权(:1534 servers 覆盖)，前端要单独接 |

---

## 二、缺口清单（按"挡住哪一步"排序）

### P0 — 旅程走不通（前端只能造数据或干脆做不出）

| # | 缺口 | 证据 |
|---|---|---|
| P0-1 | **处置动作只有"误报"一种**：人工判威胁/存疑、关单、升级、搁置全无写接口，状态机也没有对应位 | `server.js:1141`（唯一改 verdict 的路由）、`server.js:1176-1178`、`openapi.yaml:2498`（status 五值枚举） |
| P0-2 | **审计回放没有入口**：没有"研判记录列表"，审计员只能逐 alert_id 点 | `server.js:1306`/`:1339`/`:1350`（investigations 仅 POST/按键 GET/replay）；`openapi.yaml:247`（inventory 只给条数） |
| P0-3 | **案卷材料不可读**：`case_dir` 只是一个绝对路径，8 个研判材料文件没有任何读取接口 | `openapi.yaml:2741`；`syslog-case.js:104-118`（00/01/02/03/03b/04）、`:144`（05/result.json） |
| P0-4 | **无分派/协作**：负责人、优先级、备注、升级对象全无 | `openapi.yaml:2492-2544`（TriageCase 无 assignee/priority/note） |
| P0-5 | **操作日志默认无源**：没配 `HIDS_LOG_FILE` 就 503，而后端默认不落文件 | `openapi.yaml:353`（logs 描述）、`openapi.yaml:262`（inventory 注） |

### P1 — 步骤能走，但屏幕数据项凑不齐

| # | 缺口 | 证据 |
|---|---|---|
| P1-1 | 统计维度不足：无时间序列、无按主机/等级/账号聚合、无误报率、无 MTTR | `openapi.yaml:2396-2460`（仅 counts/verdict_counts/type_counts）、`:620`（totals 仅按类型） |
| P1-2 | 列表筛选维度不对称：`/api/alerts` 只有 `q` 模糊，无 host/account/source 精确筛；而 `/api/agent/triage/cases` 有 `host` | `openapi.yaml:1707-1713` vs `:1760` |
| P1-3 | 无增量/实时通道：带筛选最多扫 500 条原始事件，超限 `total` 不准 | `openapi.yaml:600-607`、`:577`（MAX_SCAN 语义） |
| P1-4 | 证据只有投影视图，无"按 evidence_id 取原始取证结果" | `openapi.yaml:2073-2090` |
| P1-5 | 规则命中历史不可查（只能现场 evaluate） | `triage-monitor.js:1070`（`record.rule_id`）、`openapi.yaml:1138` |
| P1-6 | JSON 规则集无历史/无回滚（与 Rego 不对等） | `triage-rules.js:247-255` vs `rule-store.js:293-354` |
| P1-7 | 规则维护会话只有摘要、无全文（误报会话却能读全文） | `server.js:1040` vs `server.js:1050` |
| P1-8 | 判据页面历史/回滚无接口（备份已在盘上） | `wiki-store.js:225-235`（`<数据根>/wiki-history/`）、无对应路由 |
| P1-9 | 清理候选无业务明细；归档目录无列表/还原接口 | `openapi.yaml:1985-2000`、`:284-291` |
| P1-10 | 可写配置项只有 11 个，其余必须重启 | `openapi.yaml:141-160` |
| P1-11 | 白板不可重跑、无版本、无 diff；列表无 verdict | `openapi.yaml:1007`、`:960-990` |
| P1-12 | 队列归档（`.archive.jsonl`）不可读；poll 模式案件不在 cases 列表 | `openapi.yaml:284`、`:2722` |

### P2 — 契约/字典层（前端容易"造数据"的地方）

| # | 缺口 | 证据 |
|---|---|---|
| P2-1 | **类型/等级/状态中文名没有字典接口** → 前端硬编码（已见实例） | `cloudwalker.js:2-6`、`:29`；`web/src/trace-view.js:13-18` |
| P2-2 | `PUT /api/wiki/pages/{pagePath}` 未进 openapi（契约说不可改，实现可改） | `server.js:1252` vs `openapi.yaml:1376-1394` |
| P2-3 | 多处响应是无 schema `JsonObject`：wiki 会话列表/详情/maintenance overview/packages/updates/prompts | `openapi.yaml:1405,1447,1461,1483,1511,1531,1541,1584,1596,1645,1665,514,556` → `:3276` |
| P2-4 | `Alert` schema 只文档化 9 个字段，实际 `normalizeAlert` 还给 `source/target/account/command/eventType/hostId/time/coverage/state/scenario/detail/evidence/gap/cases`（靠 `additionalProperties:true` 兜） | `openapi.yaml:2319-2338` vs `cloudwalker.js:52-62` |
| P2-5 | `TriageCase` schema 未列实现里存在的 `summary/missing_evidence/next_actions/rule_id`（列表项有、单条详情没有） | `openapi.yaml:2492-2544` vs `triage-monitor.js:1066-1074`、`:547-552` |
| P2-6 | 知识库搜索硬上限 50 条且 `total` 为截断值 | `server.js:1241`；`openapi.yaml:1354` |

---

## 三、复现命令（可重跑）

```bash
cd /home/trtyr/code/hids-ai-console
git log -1 --format='%H %ci'                     # e98cd2a 2026-11-20 18:02:09 +0800
grep -n '^  /' openapi.yaml                     # 50 条路径
grep -n "url.pathname ===\|startsWith('/api" server.js   # 实际路由分支
grep -n "status: { type: string, enum: \[not_queued" openapi.yaml   # :2498 / :2735
grep -n "agent/investigations" server.js         # :1306 :1339 :1350 → 无列表
grep -n "wiki/pages" openapi.yaml                # :1346 :1376 → 无 put
grep -n "case_dir:" openapi.yaml                # :2655 :2741 → 只有路径字符串
grep -n "TYPE_LABELS" -A6 web/src/trace-view.js # :13-18 前端硬编码字典（实例）
```

## 四、我没查的（残余风险）

- **维护端实际字段**：maintenance-server.js 的 `overview`/`packages` 响应体没在 openapi 定义（是 `JsonObject`），我没有起服务实测其真实键名——只确认"契约里无字段定义"这一事实。
- **前端逐页行为**：只扫了 `web/src/*.js` 的 fetch 面（确认哪些接口已被前端调用、哪些页面根本没接），未逐页核对渲染字段。
- **生产部署形态**：反向代理、端口、凭据来源不在本仓（`docs/_meta/gaps.md` 第六节），因此"某接口在生产是否可达"未核。
- **牧云侧字段**：无凭据，未发外部请求；`AlertDetail` 的原生键清单取自 `cloudwalker.js:16-74` 的映射表与 openapi `:2291` 描述，非实测响应。
- **未改任何文件**：本次为纯只读审计。