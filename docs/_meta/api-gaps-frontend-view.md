---
type: guide
id: GUIDE-API-GAPS-FRONTEND
---

# 前端视角 API 缺口（2026-11-21）

**口径**：前端所有数据都从后端来，前端不造数据。判据是——前端渲染任何一屏时，需要自己拼装、计算、写死的，都算后端缺口。

**基线**：`e98cd2a` / 50 路径 57 操作 / server.js 1505 行 / openapi.yaml 3339 行。
**材料**：四路只读审计原始件在 `evidence/recon/P003-T058/`（759 行，含逐条 file:line）。
**标注**：✅ = 群主亲自复跑验证；其余为检索席实测。

## 0. 一句话

**读面覆盖度高，写面与跨对象关联是缺口。** 单条告警的读（列表/详情/研判/溯源/证据）基本齐；缺的是**处置动作、分派协作、审计入口、聚合统计、导出、字典、历史正文、原始载荷**。

---

## 1. A 类 — 完全无接口（前端做不出来）

| ID | 缺什么 | 用户场景 | 证据 |
|---|---|---|---|
| A01 | **研判记录列表** ✅ | 审计员浏览「昨天研判了哪些」——现在只能一个 alert_id 一点 | `server.js:1306/1339/1350`（仅 POST / 按键 GET / replay）；`investigation-store.js:8-11` 文件名是 sha256 不可枚举 |
| A02 | **案卷材料读取** ✅ | 看原始告警、研判事实、必查项——9 个文件只有 `case_dir` 路径字符串 | `syslog-case.js:102-117/145-150/191-209`；`triage-monitor.js:546`；`readCaseFile` 仅 agent 内部调用 |
| A03 | **处置动作（除误报）** ✅ | 人工判威胁/存疑、关单、升级、搁置 | `server.js:1176` 是唯一写 verdict 的人工点，只写 `false_positive`；status 枚举只有 `not_queued/queued/running/done/failed` |
| A04 | **分派与协作** | 负责人、优先级、备注、升级给谁 | `TriageCase` 无 assignee/priority/note（`openapi.yaml:2492-2544`） |
| A05 | **聚合与趋势** | 今日告警数、等级分布、误报率、MTTR、来源 TOP10、近 7 天趋势 | 仅三分布 + 按类型 totals（`triage-monitor.js:575-620`）；全仓无 `bucket/timeseries/trend/top_n` |
| A06 | **导出** | 告警/案件/日志导 CSV、研判报告下载 | 全仓 `csv|attachment|content-disposition` **0 命中** |
| A07 | **业务级批量** | 勾选 20 条批量送研判/批量标误报 | 只有存储级 cleanup；`batch|批量|bulk` 0 命中 |
| A08 | **统一审计留痕** | 谁在何时做了什么 | HTTP 日志行无 user（`server.js:890`）；维护包 `actor` 落盘但 `publicRelease()` 丢掉（`update-store.js:17-23`）；配置变更无流水 |
| A09 | **字典接口** ✅ | 类型/等级/状态中文名 | 表在 `cloudwalker.js:2-6`、`:29`；前端已硬编码 11 个类型名（`web/src/trace-view.js:13-18`） |
| A10 | **队列归档读取** | 查 TTL 归档掉的旧案件 | `.archive.jsonl` 写而不读（`triage-monitor.js:429/482`）；只有 count 和字节数 |
| A11 | **规则维护会话详情** | 模型提了什么、为什么、验过没过 | 列表只给 rule_id/validated，rationale/result/error 全丢；且无 `/api/rules/sessions/{id}` 路由 |
| A12 | **规则历史正文** | 看某版 Rego 原文再决定回不回滚 | 无 `GET /api/rules/{id}/history/{rev}`；`history()` 只给 rev/bytes/note，`replaced_by` 也不出 |
| A13 | **判据页历史/回滚** | 判据被改坏后回到上一版 | `wiki-history/` 有备份无路由；`log.md` 只有摘要无正文 |
| A14 | **原始报文与完整载荷** | 告警详情「原始报文」页签、逐字段复核 | `status()` 剥掉 `input`（`triage-monitor.js:518`）；真实载荷 ~60 字段一个不出 |
| A15 | **同主机/同源 IP 关联告警** | 这个攻击者还打了谁 | 全表无此路径 |
| A16 | **证据原文** | 客户逐字段核对取证结果 | 只有投影 `view`（≤6000 字，省略字段只记计数） |
| A17 | **白板重跑/版本/diff** | 同一目标再溯源一次、对比两次结果 | 同 target 直接返回旧白板（`server.js:1007`），无版本号 |
| A18 | **业务端「可装什么版本」** | 控制台提示「有新版本可更新」 | 升级包列表只在维护端 18081 + 独立账号；业务端 `/api/updates` 只给已装版本 |
| A19 | **权限矩阵** | 这个账号能点哪些按钮 | `role` 恒 `operator`；哪条要 `X-Rule-Admin-Token` 前端只能硬编码 |

---

## 2. B 类 — 有接口，字段不够

| ID | 缺什么 | 证据 |
|---|---|---|
| B01 | `TriageCase` schema 少 10 个实际返回字段：`case_dir/summary/missing_evidence/next_actions/evidence_refs/rule_id/saved_at/result_alert_id/occurrence_count/session_key` | `openapi.yaml:2492-2544` vs `triage-monitor.js:1066` |
| B02 | `Alert` 只文档化 9 个字段，实际 23 个（靠 `additionalProperties:true` 兜） | `openapi.yaml:2319-2338` vs `cloudwalker.js:52-62` |
| **B03** | **`GET /api/agent/triage/cases` 的 `command` 恒为 null** — 代码读 `process_command_line`，牧云真实键是 `process_cmdline` ✅ | `triage-monitor.js:556`；三条真实记录实测前者 undefined、后者有值 |
| B04 | 规则历史缺 `replaced_by`（被谁替换） | `rule-store.js:316-327` |
| B05 | 配置看不出某项来自环境变量还是覆盖文件 | `configStore.overrides()` 产品代码零调用 |
| B06 | `/api/agent/prompts` 只给元数据，无正文、无「这段是否被覆盖」 | `prompt-store.js:94-104` |
| B07 | Wiki 列表缺 `applies_to/refs/evidence/source`（只在单页正文里） | `wiki-store.js:25-28` |
| B08 | 白板列表无 verdict/结论字段 | `openapi.yaml:960-990` |
| B09 | investigations 详情 spec 未声明 `model/prompt_version/scenario_ids/auto_action` | `investigation-agent.js:1091-1094` |

---

## 3. C 类 — 缺聚合 / 分页 / 排序 / 筛选

| ID | 缺什么 | 证据 |
|---|---|---|
| C01 | 5 个列表**全量返回无分页**：规则、规则会话、误报会话、知识库会话、工具目录 | `rule-store.js:218-222/468-480` 等 |
| C02 | 无 cursor 语义，全 offset；`/api/alerts` 另有 500 条扫描上限，超限 `total` 不准 | `server.js:498`、`cloudwalker.js:249-252` |
| C03 | 只有 2 个接口的排序可配（alerts、cases），其余写死 | `server.js:522/550` |
| C04 | 筛选维度缺：告警无 host/account/source 精确筛（只有 `q` 模糊）；案件无 level/status/q；日志无正文全文 | `openapi.yaml:1707` vs `:1760` |
| C05 | wiki 搜索硬截 50 条，`total` 也是截断后值 | `server.js:1238-1241` |
| C06 | **数据盘点只覆盖 7/15 类存储** ✅ — `fp-sessions/` 27MB / 3187 文件不漏报也不可清；同理 rules-history/rule-sessions/wiki-history/prompt-overrides/triage-rules/update-packages | `server.js:621` `DATA_KINDS` |
| C07 | 告警列表带宽筛选时，前端拿到的是「扫描窗口内」的数，不是全量 | `cloudwalker.js:249-252` |

---

## 4. D 类 — 只能前端计算的派生数据

| ID | 前端现在得算什么 | 根因 |
|---|---|---|
| D01 | 趋势曲线、TOP-N、误报率、MTTR | A05 + C02 共同导致（自己算必然不全） |
| D02 | 11 个事件类型的中文名、等级中文化 | A09 |
| D03 | 按钮显隐、admin token 需求 | A19 |

---

## 5. 契约与实现不一致（照契约写就会错）

| # | 端点 | openapi 说 | 实现是 |
|---|---|---|---|
| 1 | `PUT /api/wiki/pages/{pagePath}` | **没有这个操作** | 有，带 `expected_revision` 乐观锁，前端已在用（`server.js:1253`） |
| 2 | `GET /api/alerts` 200 | 7 个键 | 多 `query{count,offset}` 与 `note` |
| 3 | `GET /api/status` 200 | 含 `reason` | 成功时给 `eventTypes[]/transport`，**没有 reason** |
| 4 | 维护端错误体 | `Error` required `[error, code]` ✅ | 19 处只有 `{error}`，0 处 `code` |
| 5 | `/api/wiki/pages` 的 `total` | 切页前条数 | 带 `q` 时是截断到 50 之后的数 |
| 6 | `/api/updates`、`/api/agent/prompts`、`/api/wiki/*`、`/api/triage/rules` | `JsonObject` 无字段定义 | 字段其实确定，前端只能照实现写 |
| 7 | `/api/agent/prompts/upload` | — | 返回 410，其余方法不对一律 404（全仓仅 1 个 405） |

---

## 6. 需判定（是 bug 还是设计）

| # | 现象 | 证据 |
|---|---|---|
| 1 | `cases` 列表**只列有 syslog 原始报文的记录**，poll 模式入队的案件不在列表里 | `triage-monitor.js:529` |
| 2 | `knowledge-store.js` 整库未接线（`server.js` 0 次 import）✅ | `knowledge-store.js:7-38` |
| 3 | 在跑的研判不可中止 | `server.js:792` 只删排队项 |
| 4 | 误报登记要求 `status=done`，在跑/排队的告警不能先标「待处置」 | `server.js:1169` |

---

## 7. 反证 — 看起来缺，其实有

- **溯源白板**：节点/边/证据/必查项/复核/校验全有，是读面最完整的一块
- **误报维护**有全文会话（`/api/false-positive/sessions/{id}`）——**规则维护**才没有
- **Rego 规则**有历史 + 回滚（`/api/rules/{id}/history`、`/rollback`）——**JSON 规则集**才没有
- **维护端**有 viewer/updater 两级角色 —— **业务端**才没有
- **SSE** 有一条（`investigations?stream=1`），不是零
- **investigations replay** 有完整逐轮 turns/tool_calls/verdicts，审计深度足够——缺的只是「列表入口」

---

## 8. 建议分批

| 批 | 内容 | 理由 |
|---|---|---|
| **第一批（把断点接上）** | A01 研判记录列表、A02 案卷读取、A09 字典、A08 审计流、B03 command bug、C06 盘点补齐 | 都是「有数据没出口」，改动小、收益直接 |
| **第二批（补处置闭环）** | A03 处置动作 + 状态机扩展、A04 分派、A07 批量 | 要动状态机与数据模型，需要设计 |
| **第三批（规模化）** | A05 聚合/趋势、A06 导出、A18 版本可见、C01-C05 分页排序筛选 | 独立新能力，可并行 |
| **第四批（一致性）** | 契约 7 条对齐、A19 权限矩阵、A16-A17 证据与白板 | 治理类，不阻塞前端开工 |

---

## 9. 生产环境注意

- ✅ 后端默认**不落日志文件**（只上 stdout），`/api/logs` 不配 `HIDS_LOG_FILE` 就 503 → 默认部署下「谁做了什么」无处可查
- 维护端在**另一端口 + 另一套鉴权**，前端要单独接
