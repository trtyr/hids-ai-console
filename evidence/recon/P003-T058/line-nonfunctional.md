# hids-ai-console 非功能能力面审计（从「用户操作端」倒推）

**基线**：`HEAD = dfd00fc81396f6f0b59ef683afd2e285f1dc47c8`（2026-11-21T00:13+08:00）。该提交只改 `docs/_meta/live-test-2026-11-19.md`，`server.js / openapi.yaml / maintenance-server.js` 与 `e98cd2a` 逐字相同（`git diff --stat e98cd2a HEAD -- <代码文件>` 输出为空），故下文行号对两个提交都成立。
**生成时间**：2026-11-20T16:14Z ｜ **范围**：`/home/trtyr/code/hids-ai-console`（server.js 1504 行 / maintenance-server.js 177 行 / openapi.yaml 3339 行 50 路径 + 支撑模块）
**索引**：仓内无 `.codegraph/`，全部结论来自直接读文件 + grep。**未改任何文件**（`git status` 只多两个未跟踪 png，是审计前就有的）。

---

## 一、结论摘要

功能面很完整，**非功能面有五个结构性缺口**，每一条都直接逼着前端自己造数据：

1. **分页只有 `count`/`offset` 二档，没有 cursor**；5 个列表接口分页，**5 个列表接口返回全量**（规则库 / 规则会话 / 误报会话 / 知识库会话 / 工具目录）。
2. **聚合只有一块**（`GET /api/agent/triage/status` 的队列三张分布 + `/api/alerts` 的按类型 `totals`）。**没有趋势（时间分桶）、没有 TOP-N、没有跨维度分布**——"一段时间来了多少""哪台机器被攻击最多"只能前端从列表算，而列表本身带 500 条扫描上限，算出来也不准。
3. **零导出**（无 CSV / JSON / 报告下载）、**零业务级批量**（只有存储级 cleanup）、**一条 SSE**（仅 investigations）、**零审计留痕接口**。
4. **错误体在业务端统一（`{error, code}` 四类），维护端 19 处响应全部只有 `{error}`、没有 `code`**，与 openapi 自己声明的 `Error` schema（`required: [error, code]`）直接冲突。
5. "谁在什么时候改了什么"只能靠散落的 `note`/`who` 字段拼；**维护包 apply 的 `actor` 落了盘却不外露**。

---

## 二、能力矩阵

| # | 能力 | 有无 | 接口或缺失 | 关键证据 |
|---|---|---|---|---|
| 1 | 分页 | **部分** | 5 个接口有 `count`+`offset`；5 个接口全量；**无 cursor** | server.js:1361-1363, 931-933, 970-972, 1125-1127, 1232-1241；rule-store.js:218-222, 468-480 |
| 2 | 排序 | **部分** | 仅 2 个接口有 `sort` 参数；其余写死 | server.js:522-523（alerts time\|level）、550（cases time\|verdict） |
| 2 | 筛选 | **部分** | 4 个接口有筛选；**告警级只有类型/等级/状态/结论，无主机/来源IP/账号/命令** | server.js:501-527, 531-546, 553-568, 576-586 |
| 2 | 全文搜索 | **无** | 只有 2 个 `q`，都是子串包含匹配，不是全文检索 | cloudwalker.js:174-181；server.js:1238-1240 |
| 3 | 聚合统计 | **弱** | 只有队列三分布 + 按类型 totals；**无趋势 / 无 TOP-N / 无交叉分布** | triage-monitor.js:575-620；cloudwalker.js:212-215, 249-252 |
| 4 | 导出 | **无** | 无 CSV/JSON/报告下载；报告只是内联文本字段 | `grep -niE "csv\|attachment\|content-disposition" server.js openapi.yaml maintenance-server.js` → **0 命中** |
| 5 | 批量操作 | **仅存储级** | cleanup 两条；**无批量入队/误报/标注/删除/写规则** | server.js:922-928, 940-944；`grep -n "batch\|批量\|bulk" server.js` → **0 命中** |
| 6 | 实时 | **仅 1 条** | 仅 `POST /api/agent/investigations?stream=1`；**无 WebSocket** | server.js:1316-1333；全仓无服务端 WS/EventSource |
| 7 | 权限与会话 | **有但粗** | 业务端单一 operator 角色 + 两把静态管理员令牌（**令牌非身份**）；维护端有 viewer/updater | server.js:898-904, 420-447；maintenance-server.js:70-72 |
| 7 | 审计留痕接口 | **无** | 只有散落的 note/who 字段；**维护包 actor 落盘但不外露** | update-store.js:17-23, 162-168；server.js:890-891 |
| 8 | 错误码一致性 | **业务端统一 / 维护端不合规** | 业务端 `{error, code}` 四类；维护端 19 处只有 `{error}` | server.js:379-402；maintenance-server.js:56-140；openapi.yaml:3245 |

---

## 三、逐项核查与证据

### 1. 分页

**有分页（`count` + `offset`，`count` 1–50 缺省 20、`offset` ≥ 0）**

| 接口 | 证据 |
|---|---|
| `GET /api/alerts` | server.js:1361-1363 |
| `GET /api/logs` | server.js:931-933 |
| `GET /api/trace/boards` | server.js:970-972 |
| `GET /api/agent/triage/cases` | server.js:1125-1127 |
| `GET /api/wiki/pages` | server.js:1232-1241（**不带 `count` 返回全部**，向后兼容） |

**返回全量（无分页参数）**

| 接口 | 证据 |备注 |
|---|---|---|
| `GET /api/rules` | rule-store.js:218-222（`{count, rules}` 全量，按 id 排序） | 规则条数会随误报维护增长 |
| `GET /api/rules/sessions` | rule-store.js:468-480 | 按 `updated_at` 倒序，全量 |
| `GET /api/false-positive/sessions` | fp-maintainer.js `FpSessionStore.list()` | 全量 |
| `GET /api/wiki/sessions` | wiki-workbench.js `list()` | 全量 |
| `GET /api/agent/tools`、`/api/trace/tools` | server.js:952-960 | 工具目录，可接受 |
| `GET /api/maintenance/overview`（`packages[]`） | maintenance-server.js:111-120 | 全量 |
| `GET /api/updates`（`history[]`） | update-store.js:103-112 | 全量 |

**cursor / limit / page / per_page 全仓不存在。** `grep -n "cursor\|page_token\|next_page\|per_page\|pageSize"` 在 server.js / openapi.yaml 上 0 业务命中；唯一的 `cursor` 出现在 `triage-monitor.test.js:60`（队列水位线语义，与 API 无关）。

**深翻页代价**：全部 offset 语义；`/api/alerts` 更叠一层扫描上限 `TRIAGE_SCAN_LIMIT = 500`（server.js:498），带 `triage_status`/`verdict` 筛选时逐页扫上游（server.js:588-615），最多扫 500 条就 `truncated=true`。

### 2. 排序、筛选、全文搜索

**排序（可参数化）**
- `GET /api/alerts` → `sort=time|level`（server.js:522-523；openapi.yaml:1817-1822 `AlertSort`）
- `GET /api/agent/triage/cases` → `sort=time|verdict`（server.js:550；openapi.yaml:1858-1866 `CaseSort`）

**排序（写死，前端无法改）**
- `GET /api/logs` → 按 `time` 倒序（openapi.yaml:353-355）
- `GET /api/trace/boards` → 按 `updated_at` 倒序（trace-board.js:315）
- `GET /api/rules` → 按 id（rule-store.js:215）；三个 session 列表 → 按 `updated_at` 倒序

**筛选**

| 接口 | 参数 | 证据 |
|---|---|---|
| `/api/alerts` | `type`、`level`（逗号多选/序号）、`from`、`to`、`triage_status`、`verdict` | server.js:501-527 |
| `/api/agent/triage/cases` | `verdict`、`type`、`host`、`from`、`to` | server.js:531-546 |
| `/api/trace/boards` | `status`（多选）、`type`、`host`、`from`、`to` | server.js:553-568 |
| `/api/logs` | `event`（多选）、`level`（多选）、`from`、`to` | server.js:576-586 |
| `/api/wiki/pages` | `q` | server.js:1238-1240 |

**没有的筛选维度**：告警按**主机 / 资产 / 来源 IP / 账号 / 命令**筛（只有 cases 的 `host`、boards 的 `host`）；日志按 `event` 精确匹配但**不能搜日志正文**；研判记录不能按 `stage`/`report`/`evidence` 筛。

**全文搜索：没有。** 仅两处 `q`，都是子串包含匹配：

- `/api/alerts?q` → 对 `id/title/asset/source/target/account/command` 七个字段做小写 `includes`（cloudwalker.js:174-181）。不分词、无相关度排序、无字段限定、无高亮。
- `/api/wiki/pages?q` → 对 `id title path` 三字段子串匹配，**结果硬切前 50 条**（server.js:1238-1240），**不搜正文**；且 `total` 取的是已截断后的长度（server.js:1241，文档 openapi.yaml:1353 已注明）。

**搜不到**：研判报告正文（`TriageCase.report`，triage-monitor.js:547）、结论摘要 `summary`、证据文本、trace board 结论、误报理由原文、规则正文。→ 用户搜自己的历史研判结论，现在做不到。

### 3. 聚合统计

**有（只有两块）**

1. `GET /api/agent/triage/status` —— 队列口径，含 `counts`（四状态）、`verdict_counts`（结论分布）、`type_counts`（类型分布）、`queue`（深度/最老等待）、`failure_reasons`、`retry`、`paused`、`syslog_stats`；支持 `since` 起点（triage-monitor.js:575-620；server.js:999-1005；openapi.yaml:667-690）。
2. `GET /api/alerts` 的 `totals` —— 按事件类型的条数，取自上游 total（cloudwalker.js:212-215）。**注意口径切换**：一旦带 `level/q/from/to/triage_status/verdict`，`total` 变成"扫描窗口内匹配数"，`truncated=true` 时不是全量（cloudwalker.js:249-252；server.js:1367-1370）。
3. 附带：`GET /api/data/inventory` 给七类存储的 `count`/`bytes`（server.js:920-921）——存储口径，不是业务口径。

**缺**

- **趋势 / 时间序列**：全仓无 `bucket` / `timeseries` / `trend` / 按天按小时分桶；只有 `since` 一个单点起点，无法画趋势线。
- **TOP-N**：没有任何"取前 N 名"接口（按主机、来源 IP、命令、账号）；`totals` 只有类型一个维度。
- **分布**：只有 verdict、type 两个一维分布；没有按主机/等级/时间的交叉分布。
- **速率与时长**：没有每小时新增、平均积压时长、MTTR。

→ 前端想画"攻击来源 TOP10"或"近 7 天趋势"，只能拿 `/api/alerts` 的分页数据自己拼，而 `/api/alerts` 单次最多扫 500 条原始事件（server.js:498、610），**前端算出来的数必然不全**。这正是"前端造数据"的高发区。

### 4. 导出

**零。**

- `grep -niE "csv|attachment|content-disposition|text/csv" server.js openapi.yaml maintenance-server.js` → **0 命中**；openapi.yaml 里 `export` 一词也 0 命中。
- 研判报告只是**内联文本字段**：`TriageCase.report`（triage-monitor.js:547；openapi.yaml:2528）、`Investigation.verdict.report`（openapi.yaml:2793，maxLength 300）。没有"下载报告文件/导出 PDF"的接口。
- 唯一的二进制接口是**上传**方向：`POST /api/maintenance/packages`（application/octet-stream，openapi.yaml:1598-1632），不是导出。
- `GET /api/logs` 只能分页读 JSON，`GET /api/alerts` 只能分页读 JSON —— 前端要导 CSV 必须自己把数据拉下来拼装。

### 5. 批量操作

**有（仅存储级，不是业务级）**
- `POST /api/data/cleanup`：按 `kind` + `older_than`/`keep` 批量归档或删除（server.js:799-822；openapi.yaml:278-350）
- `POST /api/logs/cleanup`：按 `older_than`/`max_bytes` 批量删历史日志文件（server.js:840-845；openapi.yaml:416-470）

**缺（业务级全无）**
- 无批量入队研判 —— `POST /api/agent/triage/{alertId}` 是单条（server.js:1217）
- 无批量登记误报 —— `POST /api/agent/triage/{alertId}/false-positive` 是单条（server.js:1138-1191）
- 无批量删除 / 批量标注 / 批量打标 / 批量关闭告警
- 无批量写规则 —— `PUT /api/rules/{id}` 单条（server.js:1089-1112）
- `grep -n "batch\|批量\|bulk\|Array.isArray(body.alert" server.js` → **0 命中**；openapi 里没有任何"数组型请求体"的业务 schema

→ 用户在告警列表勾选 20 条"批量送研判"或"批量标记误报"，现在只能前端循环发 N 个单条请求（无幂等批号、无部分失败汇总、无事务语义）。

### 6. 实时

**有：全仓仅 1 条 SSE**
`POST /api/agent/investigations?stream=1`（server.js:1316-1333）：`text/event-stream`，事件 `progress` / `result` / `error`，15 秒心跳注释帧（server.js:1320）。全仓无服务端 WebSocket、无 `EventSource` 广播、无 pub/sub。

**现在只能轮询的场景**

| 场景 | 现在的取数方式 | 证据 |
|---|---|---|
| 研判队列进度 / 单案阶段 | 轮询 `GET /api/agent/triage/status` 或 `GET /api/agent/triage/{alertId}` | server.js:999-1005 / 1216 |
| 溯源白板进度 | 前端自己 5 秒轮询 | web/pages/trace-board.js:31「`POLL_MS = 5000; // 进行中的轮询间隔（接口没有进度流）`」、:445-451 |
| 日志 tail | 轮询 `GET /api/logs`（读盘 + offset 分页，**无 `follow`/`tail` 参数**） | server.js:929-938；openapi.yaml:353-415 |
| 维护包上传/应用进度 | `POST /api/maintenance/packages/{id}/apply` 同步阻塞到装完返回，**无进度、无流** | maintenance-server.js:133-137 |
| 误报维护进度 | `POST .../false-positive` 返 202，之后轮询 `GET /api/agent/triage/{alertId}` 的 `maintenance` 字段 | openapi.yaml:817-876 |
| 知识库会话 / 发布进度 | `POST` 后轮询 `GET /api/wiki/sessions/{id}` | openapi.yaml:1450-1532 |
| 新告警到达 | 轮询 `GET /api/alerts` | server.js:1359-1375 |

→ "维护包正在应用，进度到哪了"这一类，前端连轮询对象都没有（apply 是同步阻塞的）。

### 7. 权限与会话

**`GET /api/session`**（server.js:898-904；openapi.yaml:44-65）
- 返回 `{authenticated, user, role}`，业务端**角色固定 `operator`**，无更细角色
- 全局一道 Basic 闸门 `hasAccess` / `requireAccess`（server.js:420-434），认证不过任何接口都拿不到，**包括 `/api/session` 本身**
- **管理员权限是两把静态令牌**：`X-Rule-Admin-Token`（server.js:440-447）、`X-Prompt-Admin-Token`（server.js:436-439）。令牌**不是身份** → 持令牌者不可追溯
- 未配 `HIDS_BASIC_AUTH_PASSWORD` 时全部放行，`user`/`role` 都是 null（合法部署，但等于没有身份）

**`GET /api/maintenance/session`**（maintenance-server.js:70-72；openapi.yaml:1533-1541）
- 返回 `{authenticated, preview, login_enabled, user, role: viewer|updater}`
- 8 小时 HttpOnly/SameSite=Strict Cookie 会话（maintenance-server.js:13, 92）
- 写操作还要 `X-Hids-Maintenance: 1` 头 + Origin/Sec-Fetch-Site 校验（maintenance-server.js:29-42, 68）
- 这条线比业务端完整

**审计留痕接口：没有。** 现存痕迹逐条：

| 痕迹 | 落点 | 有没有接口能读到 | 缺什么 |
|---|---|---|---|
| HTTP访问 | 日志行 `{method, path, status, duration_ms}` | `GET /api/logs` | **没有用户字段**（server.js:890-891）→ 查不出"谁调的" |
| 规则改写 | 历史副本的 `note`（`人工维护：…` / `人工回滚（<who>）`） | `GET /api/rules/{id}/history`（server.js:1079-1084） | **只有这一类有结构化历史** |
| 规则维护会话 | `who` 字段 | `GET /api/rules/sessions` | 无分页、无筛选 |
| Wiki 页面编辑 | 操作人写进页面正文的 changelog（server.js:1257） | 只能 `GET /api/wiki/pages/{path}` 读正文 | **无结构化历史接口**；备份只在磁盘 `wiki-history/`（wiki-store.js:225-227） |
| 误报登记 | `feedback{reason, who, recorded_at}` | `GET /api/agent/triage/{alertId}` | 逐案，不是全局审计流；无按人查 |
| **维护包应用** | `release.actor` 落盘（update-store.js:162-168） | **读不到**：`publicRelease()` 把 `actor` 丢掉了（update-store.js:17-23），`overview()` 的 `history` 全部经它映射 | **应用人完全不可见** |
| 配置改动 | 日志 `config.updated{keys}`（config-store.js:142） | `GET /api/logs` | 只有键名，无值、无操作人 |

→ 缺一个 **`GET /api/audit`**（按时间 + 操作人 + 动作 + 对象 + 前后值查）的统一留痕接口。

### 8. 错误码与一致性

**业务端：统一。** 四类失败各一个稳定 `code`，状态码由类决定（server.js:379-384 `failureClasses`、:391-394 `failureBody`、:397-399 `fail`、:400-402 三个 helper；openapi.yaml:19-33 + 3239-3254）。所有业务路由的 4xx/5xx 都经 `fail()`，同一类在哪条路由都是同一对（code, status）。`error` 原文统一过凭据擦除。

**不一致 5 处**

1. **维护端完全没有 `code`（与自家 openapi 冲突）**。`maintenance-server.js` 里 19 处响应全是 `{error: ...}`：`maintenance-server.js:56,57,58,59,68,74,75,77,80,83,84,96,97,98,108,109,124,126,135,139,140`。而 `openapi.yaml:1542-1571` 把 `/api/maintenance/login` 的 401/403/429 声明为 `Unauthorized`/`Forbidden`/`TooManyRequests`，三者都 `$ref: '#/components/schemas/Error'`，而 `Error` 的 `required: [error, code]`（openapi.yaml:3245）。**声明与实现直接矛盾**。
2. **业务 401 是纯文本**，不是 `{error, code}`（server.js:428-434 `requireAccess`）。已文档化（`BusinessUnauthorized`，openapi.yaml:3255-3262），但前端要为它写第二套解析。
3. **`/api/status` 的 502 是第四种形状**：`{configured, connected, reason, code}`，**没有 `error` 字段**（server.js:948-950）。已文档化为例外（openapi.yaml:479-494）。
4. **SSE 的错误帧是 HTTP 200**：`{type:'error', error}`，没有 `code`（server.js:1326）。前端判成败只能看帧内 `type`。
5. **同一类错误两套文案 + 方法不对回 404**：未知路径回「接口不存在」（server.js:1395-1396），但 `/api/wiki/` 下未知路径回「知识库接口不存在」（server.js:1304）；全仓**只有一个 405**（`/api/agent/prompts`，server.js:1227）和一个 410（`/api/agent/prompts/upload`，server.js:1228），其余方法不匹配一律 404。

（一致的地方：`分页参数无效` 这句在 server.js:933 / 972 / 1127 / 1363 四处文案统一。）

---

## 四、从「用户操作端」倒推的缺口清单（按影响排序）

**P0 —— 直接逼前端造数据**

| # | 缺口 | 建议形态 | 证据锚点 |
|---|---|---|---|
| 1 | 导出 | `GET /api/export?dataset=alerts\|cases\|logs\|boards&format=csv\|json` | 全仓 0 命中；报告只是内联文本 triage-monitor.js:547 |
| 2 | 趋势 / TOP-N 聚合 | `GET /api/stats/trend?bucket=hour\|day`、`GET /api/stats/top?dimension=host\|source_ip` | 只有 triage-monitor.js:575-620 与 cloudwalker.js:212-215 |
| 3 | 统一审计留痕 | `GET /api/audit?from&to&actor&action` | server.js:890-891 无 user；update-store.js:17-23 丢 actor |
| 4 | 维护端错误体补 `code` | 19 处 `{error}` → `{error, code}` | maintenance-server.js:56-140 vs openapi.yaml:3245 |

**P1 —— 体验与规模**

5. 业务级批量（批量入队 / 批量误报 / 批量标注 / 批量删除 / 批量写规则），带批号与部分失败汇总。
6. 实时推送扩到：研判队列进度、溯源白板进度、日志 tail、维护包应用进度（后者现在连轮询对象都没有）。
7. 剩余列表接口补分页（`/api/rules`、`/api/rules/sessions`、`/api/false-positive/sessions`、`/api/wiki/sessions`）+ 引入 cursor 语义。
8. 告警级筛选维度（主机 / 来源 IP / 账号 / 命令）+ 对研判报告与结论摘要的全文搜索。

**P2 —— 一致性与治理**

9. 排序参数补齐到 rules / sessions / boards / logs。
10. 统一 405 与统一 404 文案；SSE 错误帧补 `code`。
11. 权限矩阵：把两把静态管理员令牌换成带身份的账号 + 角色，使"谁"可追溯。

---

## 五、复现命令

```bash
cd /home/trtyr/code/hids-ai-console

# 基线
git log -1 --format='%H %cI %s'
git diff --stat e98cd2a HEAD -- server.js openapi.yaml maintenance-server.js   # → 空

# 1 分页：全仓无 cursor/limit/page
grep -rn "cursor\|page_token\|next_page\|per_page" server.js openapi.yaml
grep -n "searchParams.get('count')\|searchParams.get('offset')" server.js

# 1 全量列表
sed -n '218,222p' rule-store.js ; sed -n '468,480p' rule-store.js

# 2 排序/筛选
sed -n '501,527p' server.js ; sed -n '531,568p' server.js ; sed -n '576,586p' server.js
sed -n '174,181p' cloudwalker.js            # q 的子串匹配
sed -n '1238,1241p' server.js               # wiki q 的 50 条上限

# 3 聚合
sed -n '575,620p' triage-monitor.js         # summary() 三张分布
sed -n '249,252p' cloudwalker.js            # scanMode 下 total 的口径切换
grep -rniE "bucket|timeseries|trend|top_n" *.js openapi.yaml

# 4 导出：应 0 命中
grep -niE "csv|attachment|content-disposition|text/csv" server.js openapi.yaml maintenance-server.js

# 5 批量：应 0 命中
grep -n "batch\|批量\|bulk" server.js

# 6 实时：只有这一处 SSE
grep -rn "text/event-stream" server.js

# 7 审计
sed -n '890,891p' server.js                # http.request 无 user
sed -n '17,23p;162,168p' update-store.js # publicRelease 丢掉 actor
grep -rn "actor" update-store.js prompt-store.js

# 8 错误体
sed -n '379,402p' server.js                 # 业务端四类
grep -c "json(res,[0-9]*,{error" maintenance-server.js   # → 19，且 grep -n code → 0
sed -n '3239,3246p' openapi.yaml            # Error required [error, code]
```

---

## 六、没找到 / 拿不准的

- **没有**「按主机统计」的现成接口，但 `/api/alerts` 的 `q` 能命中 `asset`/`source` 字段（cloudwalker.js:177）——这是巧合不是能力，没有结构化聚合。
- `openapi.yaml` 声称 `/api/trace/boards`「按更新时间倒序分页」（openapi.yaml:954-960），代码是 `summaries()` 内 sort 后再切页（trace-board.js:315, 318-328）——**声明与实现一致**，无偏差。
- `/api/wiki/pages` 的 `q` 50 条上限会同步压低 `total`（server.js:1241），文档已注明（openapi.yaml:1353、openapi.yaml:1360），不是缺陷，但前端必须当"截断"处理而不是"总数"。
- 当前前端在概览页已经**基本不造数据**：结论分布、类型分布、队列计数全部取自 `GET /api/agent/triage/status`（web/pages/overview.js:270 只是对服务端给的 `type_counts` 重排）。所以第 3 项缺口对应的是**新增的用户问题**（趋势 / TOP-N），而非修一个既有的造假。

---

**found** — 8 项非功能能力逐项查清并给出 file:line：分页（5 有5 全量、无 cursor）、排序筛选搜索（2 个可配排序、4 组筛选、无全文检索）、聚合（仅队列三分布 + 按类型 totals，缺趋势/TOP-N）、导出（零）、批量（仅存储级 cleanup）、实时（仅 1 条 SSE）、权限会话（有但令牌非身份；**审计留痕接口零**，维护包 actor 落盘不外露）、错误一致性（业务端统一四类 `{error, code}`，**维护端 19 处无 `code` 且与 openapi 声明冲突**）。全程只读，未改任何文件。