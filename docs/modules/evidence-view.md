---
type: module
id: MOD-EVIDENCE-VIEW
covers: [src/contexts/triage/infrastructure/evidence-view.js]
unit: evidence-view
updated: 2026-11-20
---

# 证据视图（evidence-view）

模块名 `evidence-view`。覆盖文件一个：`evidence-view.js`（模块划分与页面归属见 [docs/modules/_breakdown.json](_breakdown.json) 的 `evidence-view` 条目）。

这篇讲这个模块把一次工具调用的原始返回压成什么形状、投影出来的事实怎么标出处、上下文超限时怎么裁。关键断言标 `文件:行号`，行号对应当前提交 `35530d8`；P003-T039 新增/改写的段落（页内标「P003-T039」「复审 BUG1」的地方，含 §3 公开面、§4.4 的展示裁剪）行号对 P003-T039 复审修复提交 `241c0da`；P003-T040 新增/改写的段落（页内标「P003-T040」的地方：§2 字段投影行、§3 公开面表、§4.3、§4.4 的记账封顶、§8 的两条不变量）行号对提交 `201d278`；代码改动后请重新核对。

原始返回怎么取回来、引用怎么被校验，都不在本篇：前者属 evidence-tools 模块，后者属 investigation-agent 模块；页面归属同样见 `_breakdown.json`。

## 1 模块名与职责

### 1.1 做什么

- **把原始返回压成给模型看的视图**。文件头注释写明：原始 MCP 返回值完整留在 `EvidenceSession`，这里只选择能支持单告警研判的字段（`evidence-view.js:1-2`）。
- **给投影出来的事实留一个能回查的出处**。事实是 `{value, pointer}` 两元组，pointer 指向原始返回里的位置（`evidence-view.js:61`）。
- **按需裁剪展示量**。超过上下文预算时先砍展示行，砍不动就换一份带错误说明的视图（`evidence-view.js:233-235`、`evidence-view.js:254-255`）。
- **对列表页做预聚合**。对当前返回页按风险等级、来源 IP、目标 IP、主机名、进程名等维度计数，口径写死在 `aggregation_scope` 字段里（`evidence-view.js:195-205`、`evidence-view.js:213`）。

### 1.2 不做什么

- **不改原始返回**。本模块不持有也不修改牧云返回的数据，原始返回由 `EvidenceSession` 保存（`evidence-view.js:1`、`agent-tools.js:64`）。
- **不判断结论对错**。投影只做取值与裁剪，不做语义判断；引用校验在 evidence-tools 模块（`agent-tools.js:70`）。
- **不落盘**。文件里没有写文件动作（核查命令见 §10.2）。
- **不解释字段语义**。字段名到候选原始键的映射是静态表（`evidence-view.js:3-40`），表外的字段不进视图。
- **不决定哪些证据进上下文**。选记录、挑顺序由 investigation-agent 决定（`investigation-agent.js:131-139`）。

## 2 覆盖构件

本页覆盖四个构件，与 `_breakdown.json` 里 `evidence-view` 条目的 `components` 一致，逐个点名：

| 构件 | 是什么 | 定义处 |
| --- | --- | --- |
| **字段投影** | 从原始返回里挑出可研判的字段，把候选原始键映射成友好名。P003-T040 起含 `description`（描述正文）与嵌套序列 `cmdlines`（会话命令数组） | `evidence-view.js:3-40`（字段表，`description` 在 `:39`）、`evidence-view.js:42-49`（嵌套序列表，`cmdlines` 在 `:48`）、`evidence-view.js:63-70`（取事实）、`evidence-view.js:71-89`（按资产种类改名） |
| **JSON Pointer** | 给投影出来的事实标出它在原始返回里的位置，供引用校验回查 | `evidence-view.js:49`（转义规则）、`evidence-view.js:61`（生成 pointer） |
| **预聚合计数** | 对列表页当前返回的行按多个维度计数 | `evidence-view.js:94-103`（计数函数）、`evidence-view.js:195-205`（八个维度）、`evidence-view.js:213-214`（口径与落位） |
| **上下文裁剪** | 视图超过字符预算时删展示行，删不动就返回带错误的视图 | `evidence-view.js:234-257` |

四者的关系一句话：**字段投影**决定「有哪些值」，**JSON Pointer**决定「每个值从哪来」，**预聚合计数**给列表页一个不用逐行读的概览，**上下文裁剪**决定「这一屏还放得下多少」。

## 3 公开面

本模块导出六个符号（`grep -n '^export' evidence-view.js` 输出六行，命令见 §10.2）：

| 导出 | 种类 | 用途 | 定义处 | 单位 |
| --- | --- | --- | --- | --- |
| `projectEvidence(tool, result)` | 函数 | 把 `(工具名, 原始返回)` 投成视图 | `evidence-view.js:164` | — |
| `boundEvidenceView(view, maxChars)` | 函数 | 把视图裁到字符预算内 | `evidence-view.js:244` | 字符 |
| `agentDisplayLimits` | 冻结对象 | 模型侧展示上限：`timeline: 8`、`commands: 4`、`cmdlines: 4`（P003-T039 / P003-T040） | `evidence-view.js:281` | 行 |
| `compactEvidenceView(view, limits)` | 函数 | 只裁嵌套序列展示行，计数一律保留（P003-T039） | `evidence-view.js:302` | 行 |
| `boundSyslogView(view, maxChars=3000)` | 函数 | `syslog:1` 载荷视图的长度上限（P003-T039） | `evidence-view.js:341` | 字符 |
| `syslogOmittedFieldsLimit` | 常量 | 记账数组（`omitted_fields` / `truncated_fields`）最多列几个名字：40（P003-T040） | `evidence-view.js:331` | 个 |

表注：单位列只对带数值预算的条目写——`boundEvidenceView` 与 `boundSyslogView` 量的是字符，`agentDisplayLimits` / `compactEvidenceView` 量的是展示行；纯函数写「—」。

业务代码里的调用点（本模块自带测试另有引用，见 `evidence-view.test.js:3`）：

| 调用点 | 传入的口径 | 依据 |
| --- | --- | --- |
| 取证会话生成记录里的 `view` | `projectEvidence(...)` 后按默认值 12000 裁；**不套 `compactEvidenceView`**（`record.view` 保持完整投影） | `agent-tools.js:65` |
| 工具结果消息（模型看到的那份） | 先 `compactEvidenceView`（8/4 行），超 20000 字改回一条错误说明 | `investigation-agent.js:273-281` |
| 结论轮 / 复核轮证据 | `compactEvidenceView` 后 `boundEvidenceView(..., 4000)`；记录超过 5 条时只给前 5 条完整视图 | `investigation-agent.js:317-332` |
| `syslog:1` 记录视图 | `boundSyslogView`（默认 3000 字） | `investigation-agent.js:445` |

`record.view` 与模型侧视图分开是有意的（P003-T039）：知识经验复用判定要看「时间线是否完整」，
依据是 `record.view.related_sequences.timeline.shown_count === total_in_record`，
所以裁剪只发生在模型侧副本上，不改 `record.view`。

`boundEvidenceView` 的既有调用点里，`focused` 参数已随 P003-T039 的结论轮口径一起删掉（那条分支从来没被调用过），
现在结论轮与复核轮共用同一份 `conclusionEvidence()`。

## 4 关键路径

### 4.1 一次事件查询的投影

输入是 `(tool, result)`。分支判定按**结果形状**而不是工具名（`evidence-view.js:190`、`evidence-view.js:223`）：

1. 先看三个专用工具：`get_internal_ip_define`（`evidence-view.js:156-159`）、`get_host_risk_overview`（`evidence-view.js:160-176`）、`get_process_asset`（`evidence-view.js:177-189`）。
2. 再看结果里有 `events` / `data` / `result` / `list` 这四个键之一、且值是数组——有就当列表（`evidence-view.js:190`）。
3. 再看结果是不是对象：是就取 `event` 或 `data` 这一层包着的详情（`evidence-view.js:223-228`）。
4. 都不是就当标量（`evidence-view.js:230`）。

工具名不参与第 2–4 步的判定：实测 `projectEvidence('get_revshell_event', { events: [{id:1}] })` 返回 `kind: 'list'`，`projectEvidence('list_honeypot_events', { event: { id: 1 } })` 返回 `kind: 'detail'`（命令见 §10.2）。

详情投影的步骤：

1. **取字段**。按字段表逐个友好名找候选原始键（`evidence-view.js:3-40`、`evidence-view.js:63-70`）。候选键是点号路径，逐段下钻（`evidence-view.js:51-56`）。
2. **丢弃四类值**：取不到、`null`、空串、对象或数组（`evidence-view.js:57`）。

**`host_id` 的候选键里没有裸 `id`**（P003-T035 改）。字段表里 `host_id` 只认 `host_view.host_id`、`host_view.id`、`host_id`
（`evidence-view.js:9`）；裸 `id` 在事件行里是**事件 ID**，拿它当主机 ID 会让必查项按错的主机去查
（`required-evidence.js:71`），再把空页写成「已查当前页但未返回记录」——等于把「查错机器」报成「那台机器没事」。
主机资产视图是例外：`list_host_assets` / `get_host_info_detail` 的行里裸 `id` 就是主机 ID，`projectEvidence` 给这两件工具
打开 `bareHostId` 开关，`get_process_asset` 的 `host_info` 段按 `kind === 'host'` 也开着（`evidence-view.js:50`、
`evidence-view.js:66-79`、`evidence-view.js:80-81`、`evidence-view.js:165`）。
3. **丢弃超长文本**：末段键名属于命令类的（`cmdline` / `command` / `shell_cmdline` / `process_cmdline`）上限 3000 字符，其余上限 500 字符（`evidence-view.js:58-59`）。超限的整条丢弃，不是截断。
4. **丢弃零时间哨兵**：数值小于 `-60000000000` 的时间戳丢掉（`evidence-view.js:60`）。
5. **产出事实**：`{value, pointer}`，pointer 由前缀加上实际走过的段拼成（`evidence-view.js:61`）。

第 3 步是丢弃而不是截断——实测 `cmdline` 长度 3001 时整条 `command_line` 消失、3000 时保留，`comment` 长度 501 时丢弃、500 时保留（命令见 §10.2）。

### 4.2 列表投影与预聚合计数

1. **定位列表**：`events` → `data` → `result` → `list`，取第一个值是数组的键（`evidence-view.js:190`）。
2. **定资产种类**：按工具名分 process / connection / port / event 四类（`evidence-view.js:193-194`）。种类只影响改名与计数字段（见下），不影响投影规则。
3. **算总数与一致性**：`total_reported_by_platform` 是平台报的 total（带 `/total` 指针）；`returned_count` 是本页返回行数；`platform_total_consistent` 判断平台 total 是否不小于返回行数。平台没报 total 时，`total_reported_by_platform` 与 `platform_total_consistent` 都是 `null`（`evidence-view.js:207-208`）。
4. **带出查询覆盖范围**：`query_coverage` 取 `queried_types` 那套字段，没有则退到 `queried_type` 那套，都没有时整个字段是 `undefined`（`evidence-view.js:209-212`）。
5. **算预聚合计数**：八个维度（`evidence-view.js:195-205`）——风险等级、来源 IP、目标 IP、主机名、进程名、监听端口、进程安全状态、连接类型码。计数只用当前返回页的行（`evidence-view.js:94-103`），空维度不落进结果（`evidence-view.js:214`）。
6. **放前 5 行**：视图里的 `items` 只保留前 5 行（`evidence-view.js:215-219`），每行带 `facts`，当该行有嵌套序列时另带 `related_sequences`。

**口径要读清楚**：计数覆盖的是当前返回页的全部行，不是 `items` 里那 5 行（`evidence-view.js:195` 对 `rows`，`evidence-view.js:215` 才切前 5）。`aggregation_scope` 字段把这句话写死成固定文案：「仅当前返回页；不是平台全量统计；平台 total 小于返回条数时以实际返回行取证」（`evidence-view.js:213`）。

资产种类带来的改名（`evidence-view.js:71-89`）：

| 种类 | 改名 | 附带处理 |
| --- | --- | --- |
| process | `event_id` → `asset_id` | 删掉 `event_name`；`name` 另作 `process_name`（`evidence-view.js:74-77`） |
| connection | `event_id` → `connection_record_id` | 无（`evidence-view.js:80`） |
| port | `event_id` → `port_asset_id` | `destination_port` → `listening_port`；`cmd` 另作 `process_name`（`evidence-view.js:83-86`） |
| event | 不改名 | 无 |

进程名维度按种类取不同键：process 类计 `name`，connection 类计 `process`，port 类计 `cmd`；event 类没有这个维度，该维度是空对象、不落进结果（`evidence-view.js:200-202`）。

### 4.3 嵌套序列的挑选与统计

原始返回里的 `timeline` / `process_tree` / `state_history` / `commands` 四类数组按各自规则挑行（`evidence-view.js:42-47`、`evidence-view.js:104-121`）：

| 序列 | 长度不超过阈值时 | 超过阈值时 | 阈值 | 依据 |
| --- | --- | --- | --- | --- |
| `timeline` | 取前 20 行 | 按优先级挑 18 行，再补首行与末行 | 20 | `evidence-view.js:111-119`、`evidence-view.js:120` |
| `commands` | 取前 8 行 | 前 4 行 + 后 4 行 | 8 | `evidence-view.js:109-110`、`evidence-view.js:120` |
| `process_tree` | 取前 5 行 | 同左，没有专门规则 | 5 | `evidence-view.js:120` |
| `state_history` | 取前 5 行 | 同左，没有专门规则 | 5 | `evidence-view.js:120` |
| `cmdlines`（P003-T040） | 取前 8 行 | 前 4 行 + 后 4 行 | 8 | `evidence-view.js:109-110`、`evidence-view.js:120` |

timeline 的优先级：有响应长度的排 0，其次是能解出 HTTP 请求行的排 1，再次是有请求长度的排 2，最后是 3；同优先级按原序号排（`evidence-view.js:116-118`）。挑出的 18 个与首尾两行去重后按序号升序排列（`evidence-view.js:118-119`）。所以 25 行的 timeline 展示 19 行，不是 20 行。

每行给出 `total_in_record`（记录里的总行数）、`shown_count`（本次展示行数）与 `shown`（每项带 `index` 与 `facts`）（`evidence-view.js:121`、`evidence-view.js:142`）。

`cmdlines` 的元素可能直接是命令字符串（P003-T040，`evidence-view.js:140-143`）：这时记成 `cmdline` 字段，
pointer 指向数组下标（`/event/cmdlines/0`），**值不截断**——截断会让引用的 `value` 与原文对不上。

timeline 另带五个统计（`evidence-view.js:144-150`）：`nonempty_request_count`（请求长度大于 0 的行数）、`nonzero_response_count`（响应长度大于 0 的行数）、`http_request_lines`（展示行里解出的请求行文本）、`response_payload_available`（是否存在响应载荷）、`timestamp_valid_count`（时间戳为正的行数）。

蜜罐时间线里的 `response_digest` 是 base64：解出首行是 HTTP/RTSP 请求行时，视图给出 `http_request_line`（`value` 仍是原始 base64，`pointer` 指向 `response_digest`，另带 `decoded` 文本）（`evidence-view.js:128-135`）；首两个字节是 `16 03` 时给 `request_payload_type`，文案是「TLS 握手格式载荷；不证明握手成功」（`evidence-view.js:136-138`）。`response_digest` 长度超过 4096 时不解码（`evidence-view.js:128`）。

### 4.4 上下文裁剪

`boundEvidenceView(view, maxChars = 12000)`（`evidence-view.js:234`）：

1. 序列化长度不超预算就原样返回同一个对象引用（`evidence-view.js:235`）。
2. 超预算则深拷贝一份，标 `truncated_for_context: true`（`evidence-view.js:236-238`）。
3. 列表视图逐个删 `items`，至少保留 1 条；删完把 `shown_count` 改成剩余条数（`evidence-view.js:239-242`）。
4. 内网定义视图逐个删 `ranges`，至少保留 1 条；删之前记下 `total_ranges`（`evidence-view.js:243-246`）。
5. 顶层与各 item 的嵌套序列逐个删 `shown` 行，至少保留 1 行；同步改 `shown_count`（`evidence-view.js:247-253`）。
6. 裁完还超预算，则返回只带 `kind`、`tool`、`truncated_for_context` 与 `error` 文案的视图，文案是「精简后仍超出上下文限制；请缩小查询条件或降低 count 后重查，不能引用本次省略的字段。」（`evidence-view.js:254-255`）。

裁剪只动展示行：原始返回不在这个视图里，引用校验仍拿原始返回核对（`evidence-view.js:233`）。第 6 步的文案明确要求「不能引用本次省略的字段」（`evidence-view.js:255`）。

预聚合计数不随裁剪重算：`counts_on_returned_page` 描述的是裁剪前的整页计数（`evidence-view.js:195` 对 `rows`，`evidence-view.js:239-242` 只删 `items`）。

**模型侧还有一层展示裁剪（P003-T039，`evidence-view.js:272-373`）**，与上面的字符预算正交：

- `compactEvidenceView(view, limits = agentDisplayLimits)`：把 `related_sequences.timeline` 收到 8 行、`commands` 收到 4 行。
  `timeline` 先按「有响应长度 > 带 HTTP 请求行/载荷类型 > 有请求字节 > 其余」挑行，再按原下标回排（`evidence-view.js:283-300`），
  关键行不会被裁掉；`commands` 保留头 2 条 + 尾 2 条。两个序列的 `total_in_record`、`shown_count`、
  `nonempty_request_count`、`nonzero_response_count`、`response_payload_available`、`timestamp_valid_count` 全部保留，
  `http_request_lines` 按留下的行重算——**裁的是展示行，不是计数**。
- `boundSyslogView(view, maxChars = 3000)`（`evidence-view.js:321-373`）：`syslog:1` 是原始键值载荷，没有数组可裁。
  预算量的是「最终要发出去的那个对象」（含 `omitted_fields` / `truncated_fields` 记账字段，`evidence-view.js:338`），超限时按三段收缩：
  1. 整条省略超 600 字的长字段，字段名记进 `omitted_fields`（碎片没有引用价值）；
  2. 逐个把中等长度的字段截成「前 150 字…（截断，原 N 字）」记进 `truncated_fields`，**每个字段只截一次、只截截断后确实更短的字段**；
  3. 仍超限就继续整条省略（最长优先，含已截断的碎片），字段名并进 `omitted_fields`。

  每段每步都真删/真缩短内容，所以循环一定收敛（复审 BUG1：旧写在「总量超限且没有单条长字段」时反复截同一字段、长度不再下降，5 秒挂死）。
  三段走完仍超限（例如字段名比内容还长、或载荷字段极多）就降级成不带 `payload` 的回包：`{msgid, truncated_for_context: true, omitted_fields: <全部字段名>, note}`。
  无论走哪段都置 `truncated_for_context: true`。**短值尽量原样保留**——模型要拿它填 `claims.citations` 的 `value`，截断一个能给的值等于让它引用失败，所以短字段最后才丢、且是整条省略而不是截断。
- **记账数组本身封顶（P003-T040 A5）**：`omitted_fields` / `truncated_fields` 最多各列 40 个字段名（每个名字截 60 字，
  `evidence-view.js:331-339`），超出部分只报 `omitted_fields_total` / `truncated_fields_total`。改前这两个数组没有上限：
  载荷字段一多（实测 4.7KB 输入），「说明省了什么」的记账本身就能把回包写成 3547 字——回包比上限还长。兜底分支
  （`{msgid, truncated_for_context, omitted_fields, note}`，`evidence-view.js:358-366`）走同一个封顶函数。

## 5 值语义

### 5.1 入参

| 参数 | 出现在 | 类型 | 合法域 | 默认 | 越界怎么办 | 依据 | 单位 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tool` | `projectEvidence` | 字符串 | 不校验格式 | 无 | 无 | `evidence-view.js:155` | — |
| `result` | `projectEvidence` | 任意 JSON 值（对象、数组、字符串、数字、`null`） | 不校验 | 无 | 无 | `evidence-view.js:155` | — |
| `view` | `boundEvidenceView` | 视图对象 | 不校验 | 无 | 非对象会在 `JSON.stringify` 后按字符串长度算 | `evidence-view.js:234-235` | — |
| `maxChars` | `boundEvidenceView` | 整数（字符数） | 实测 0 与负数都走裁剪分支并返回带 `error` 的视图 | 12000 | 见 §9.2 | `evidence-view.js:234-235`、`evidence-view.js:254-255` | 字符 |

表注：本节只有 `maxChars` 带量纲（字符），其余入参不含量纲，写「—」。

### 5.2 返回值

**视图的 `kind` 取值**（六种）：

| `kind` | 何时产出 | 依据 |
| --- | --- | --- |
| `internal_network_definition` | 工具是 `get_internal_ip_define` 且 `result.net_address` 是数组 | `evidence-view.js:156-159` |
| `host_risk_overview` | 工具是 `get_host_risk_overview` 且 `result` 是对象 | `evidence-view.js:160-176` |
| `process_asset_detail` | 工具是 `get_process_asset` 且 `result` 是对象 | `evidence-view.js:177-189` |
| `list` | `result` 里有 `events` / `data` / `result` / `list` 之一且值是数组 | `evidence-view.js:190-221` |
| `detail` | `result` 是对象，且没走上面几支 | `evidence-view.js:223-228` |
| `scalar` | 其余 | `evidence-view.js:230` |

**事实的值形状**：普通事实是 `{value, pointer}`（`evidence-view.js:61`）；蜜罐时间线里解出的请求行与 TLS 标记多一个 `decoded` 字段（`evidence-view.js:134-138`）。

**各 `kind` 的字段**：

| `kind` | 字段 | 含义 | 依据 |
| --- | --- | --- | --- |
| `detail` | `facts` | 友好名 → 事实 | `evidence-view.js:228` |
| `detail` | `related_sequences` | 四类嵌套序列的挑选结果，没有则为 `{}` | `evidence-view.js:228`、`evidence-view.js:104-108` |
| `list` | `total_reported_by_platform` | 平台报的 total，带 `/total` 指针；平台没报时为 `null` | `evidence-view.js:207` |
| `list` | `returned_count` | 当前页返回行数 | `evidence-view.js:208` |
| `list` | `platform_total_consistent` | 平台 total 是否不小于返回行数；平台没报 total 时为 `null` | `evidence-view.js:208` |
| `list` | `query_coverage` | 查询覆盖范围；结果里没有对应字段时为 `undefined` | `evidence-view.js:209-212` |
| `list` | `aggregation_scope` | 固定文案，说明计数口径 | `evidence-view.js:213` |
| `list` | `counts_on_returned_page` | 维度 → 计数表，只保留非空维度 | `evidence-view.js:214` |
| `list` | `items` | 前 5 行的 `facts` 与（可选的）`related_sequences` | `evidence-view.js:215-219` |
| `host_risk_overview` | `sections` | 五个 section 名下的统计；输入里没出现的 section 不出现 | `evidence-view.js:162-175` |
| `host_risk_overview` | `sections.<名>.last_scan_time` | 该组的扫描时间 | `evidence-view.js:169` |
| `host_risk_overview` | `sections.<名>.risky_count_summed_from_returned_groups` | 返回组里 `risky` 之和 | `evidence-view.js:168`、`evidence-view.js:170` |
| `host_risk_overview` | `sections.<名>.group_count` | 返回组数 | `evidence-view.js:171` |
| `host_risk_overview` | `sections.<名>.nonzero_groups` | `risky` 大于 0 的组，最多 3 条，每条含 `category` 与 `risky_count` | `evidence-view.js:172-173`、`evidence-view.js:90-93` |
| `process_asset_detail` | `asset_id` | 资产 ID（取 `ID` 字段） | `evidence-view.js:183` |
| `process_asset_detail` | `host` | 主机侧事实 | `evidence-view.js:184` |
| `process_asset_detail` | `process` | 进程侧事实，不含 `asset_id` | `evidence-view.js:180-181` |
| `process_asset_detail` | `executable_file` | 可执行文件侧事实，不含 `process_safety`，另带 `file_safety` | `evidence-view.js:178-179`、`evidence-view.js:186-187` |
| `process_asset_detail` | `collected_at` | 采集时间（取 `collect_time`） | `evidence-view.js:188` |
| `internal_network_definition` | `ranges` | 每条网段带 `value` 与 `/net_address/<序号>` 指针 | `evidence-view.js:157-158` |
| `scalar` | `value` | 原样带回的返回值 | `evidence-view.js:230` |

`host_risk_overview` 的五个 section 名是 `weak_password`、`security_baseline`、`vulnerabilities`、`patch_risk`、`emergency_vulnerabilities`，对应的输入键是 `weak_passwd`、`security_check_stat`、`vuln_stat`、`patch_stat`、`emergency_vuln`（`evidence-view.js:162-163`）。行键优先取 `Data`，不是数组时退回 `data`（`evidence-view.js:166-167`）。

`boundEvidenceView` 的返回值有三种情况：未超预算时返回入参同一个对象引用（`evidence-view.js:235`）；超预算但裁得动时返回深拷贝后的视图，带 `truncated_for_context: true`（`evidence-view.js:236-238`）；裁不动时返回 `{kind, tool, truncated_for_context: true, error}`（`evidence-view.js:254-255`）。

## 6 依赖

| 方向 | 对象 | 说明 | 依据 |
| --- | --- | --- | --- |
| 下游 | 无本地模块 | 文件里没有 import 语句（§10.2 的 `grep -n '^import' evidence-view.js` 无输出，退出码 1） | §10.2 |
| 运行时 | Node 全局 `Buffer` | 把 `response_digest` 按 base64 解码 | `evidence-view.js:114`、`evidence-view.js:130` |
| 运行时 | Node 全局 `structuredClone` | 裁剪前深拷贝视图，避免改到调用方的对象 | `evidence-view.js:236` |
| 上游 | evidence-tools 模块 | 取证会话生成记录里的 `view` | `agent-tools.js:4`、`agent-tools.js:65` |
| 上游 | investigation-agent 模块 | 结论证据与必查项视图的裁剪 | `investigation-agent.js:4`、`investigation-agent.js:139`、`investigation-agent.js:266` |

本模块不访问网络、文件与数据库。

## 7 数据归属

| 数据 | 放在哪 | 生命周期 | 依据 |
| --- | --- | --- | --- |
| 原始返回 | `EvidenceSession.records` 里的 `result` | 一次调查一份 | `agent-tools.js:64` |
| 视图 | `EvidenceSession.records` 里的 `view` | 同上 | `agent-tools.js:65` |
| 字段表 | 模块级常量 `fields` | 进程级常量 | `evidence-view.js:3-40` |
| 嵌套字段表 | 模块级常量 `nestedFields` | 进程级常量 | `evidence-view.js:42-47` |
| 预聚合计数 | 视图对象自身 | 随视图 | `evidence-view.js:214` |

本模块不落盘：文件里没有写文件动作（核查命令见 §10.2）。

## 8 不变量

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-EV-01` | 投影出的事实带指向原始返回的 JSON Pointer | 事实只有 `value` 没有 `pointer` | `evidence-view.js:61` | 引用校验无从回查 |
| `R-EV-02` | 候选原始键按字段表里的顺序试，命中第一个非空候选就停 | 两个候选都有值时取了后者 | `evidence-view.js:66` | 事实取错字段 |
| `R-EV-03` | 超出长度上限的字段整条丢弃，不截断 | 3001 字符的 `cmdline` 被截成 3000 | `evidence-view.js:58-59` | 事实里出现半条命令 |
| `R-EV-04` | 小于 `-60000000000` 的数值时间戳丢弃 | 零时间哨兵进了视图 | `evidence-view.js:60` | 模型把哨兵当真实时间 |
| `R-EV-05` | 预聚合计数只覆盖当前返回页 | 拿平台 total 当本页计数 | `evidence-view.js:195`、`evidence-view.js:213` | 统计口径错 |
| `R-EV-06` | 列表视图的 `items` 不超过 5 行 | `items` 有 8 行 | `evidence-view.js:215` | 上下文占用失控 |
| `R-EV-07` | 嵌套序列的展示行数不超过总行数，且带 `total_in_record` | 展示行数大于总行数 | `evidence-view.js:121` | 计数对不上 |
| `R-EV-08` | 裁剪后至少保留 1 条 `item`、1 条 `range`、1 行序列 | 裁到 0 条 | `evidence-view.js:240`、`evidence-view.js:245`、`evidence-view.js:250` | 视图空掉 |
| `R-EV-09` | 裁剪后仍超预算时返回带 `error` 的视图 | 仍返回超预算的视图 | `evidence-view.js:254-255` | 模型拿到超预算内容 |
| `R-EV-10` | 视图 `kind` 由结果形状决定，不由工具名决定 | 工具名决定 `kind` | `evidence-view.js:190`、`evidence-view.js:223` | 同一工具两种形状产出不同视图 |
| `R-EV-11` | 平台 total 小于返回行数时 `platform_total_consistent` 为 `false` | 平台 total 是 0、返回 1 行却报一致 | `evidence-view.js:208` | 漏判数据不一致 |
| `R-EV-12` | 裁剪只删展示行，原始返回不被改动 | 裁剪同时改了原始 `result` | `evidence-view.js:233`、`evidence-view.js:236` | 引用校验对不上 |
| `R-EV-13` | `boundSyslogView` 的回包（含记账字段）不超过 `maxChars` | 300 个短字段的载荷吐出 3547 字回包 | `evidence-view.js:331-371` | 降级回包比上限还长 |
| `R-EV-14` | 记账数组最多列 `syslogOmittedFieldsLimit` 个名字，超出只报总数 | `omitted_fields` 列了 98 个名字 | `evidence-view.js:334-339` | 记账把回包撑爆 |

## 9 失败面

### 9.1 静默降级类（模块自身不报错）

| 失败模式 | 表现 | 失败后状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| 原始返回形状不认识 | 返回 `kind: 'detail'` 且 `facts` 为空 | 无状态变化 | 换查询条件重试 | 视图里没有可用字段 |
| 顶层是数组、且不在四个列表键里 | 同上（实测 `[1,2,3]` 得到 `facts: {}`） | 无状态变化 | 换查询条件重试 | 视图里没有可用字段 |
| 字段值超长 | 整条事实丢弃 | 无状态变化 | 缩小返回字段重查 | 该事实缺失 |
| 字段值是对象或数组 | 整条事实丢弃 | 无状态变化 | 同上 | 该事实缺失 |
| 字段值是零时间哨兵 | 整条事实丢弃 | 无状态变化 | 同上 | 该事实缺失 |
| 嵌套序列不是数组 | 该序列不进 `related_sequences` | 无状态变化 | 同上 | 序列缺失 |
| 平台 total 小于返回行数 | `platform_total_consistent: false` | 无状态变化 | 重查 | 按实际返回行取证（`evidence-view.js:213`） |
| 平台没报 total | `total_reported_by_platform` 与 `platform_total_consistent` 都是 `null` | 无状态变化 | 重查 | 无从判断一致性 |

### 9.2 裁剪相关

| 失败模式 | 表现 | 失败后状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| 视图超出字符预算 | `truncated_for_context: true`，展示行变少 | 原视图不受影响（裁的是深拷贝） | 缩小 `count` 重查 | 展示行变少 |
| 裁到只剩一行仍超预算 | 返回 `{kind, tool, truncated_for_context, error}` | 同上 | 缩小 `count` 重查 | 模型拿不到内容 |
| 传入带函数的视图 | `structuredClone` 抛 `DOMException` | 抛错中断 | 传入纯 JSON 视图 | 无（`evidence-view.js:236`） |
| 传入循环引用的视图 | `JSON.stringify` 抛 `TypeError` | 抛错中断 | 传入无环视图 | 无（`evidence-view.js:235`） |

后两条是 `boundEvidenceView` 作为公开导出的边界：模块自己产出的视图只含 JSON 值，不会触发；实测输出见 §10.2。

## 10 资源与余量

### 10.1 边界值

| 项 | 数值 | 依据 |
| --- | --- | --- |
| 友好字段名个数 | 52 | `evidence-view.js:3-40`；实测命令见 §10.2 |
| 候选原始键个数 | 106（去重后 104） | 同上 |
| 嵌套序列类别 | 5（`timeline`、`process_tree`、`state_history`、`commands`、`cmdlines`） | `evidence-view.js:42-49` |
| 一般字段长度上限 | 500 字符 | `evidence-view.js:59` |
| 命令类字段长度上限 | 3000 字符 | `evidence-view.js:59` |
| 零时间哨兵阈值 | `-60000000000` | `evidence-view.js:60` |
| timeline 展示上限 | 20（超过时挑 18 行 + 首尾） | `evidence-view.js:111-119`、`evidence-view.js:120` |
| commands 展示上限 | 8（超过时头 4 + 尾 4） | `evidence-view.js:109-110`、`evidence-view.js:120` |
| cmdlines 展示上限 | 8（超过时头 4 + 尾 4）；模型侧 4 行 | `evidence-view.js:109-110`、`evidence-view.js:120`、`evidence-view.js:281` |
| `process_tree` / `state_history` 展示上限 | 5 | `evidence-view.js:120` |
| 列表 `items` 展示上限 | 5 行 | `evidence-view.js:215` |
| 主机风险 `nonzero_groups` 展示上限 | 3 | `evidence-view.js:172-173` |
| `response_digest` 解码长度上限 | 4096 字符 | `evidence-view.js:128` |
| 默认上下文预算 | 12000 字符 | `evidence-view.js:234` |
| 调用点实际预算 | 3000 / 4000 / 12000 | `investigation-agent.js:139`、`investigation-agent.js:266`、`agent-tools.js:65` |
| 结论消息总量上限（上游约束） | 20000 字符 | `investigation-agent.js:126-127` |

### 10.2 实测与静态核查

本地没有牧云凭据，没向牧云发过请求；下面的输出是用构造数据跑本模块函数得到的，只验证本模块自己的分支逻辑，不代表牧云的真实响应。

```bash
# 导出面、导入面、落盘面
grep -n "^export" evidence-view.js
grep -n "^import" evidence-view.js
grep -nE "node:fs|writeFile|appendFile|createWriteStream" evidence-view.js
```

实测输出（后两条命令无匹配，退出码 1）：

```
155:export function projectEvidence(tool, result) {
234:export function boundEvidenceView(view, maxChars = 12000) {
```

```bash
# 字段表规模与指针转义是否会被触发
node --input-type=module -e '
const fs = await import("node:fs");
const src = fs.readFileSync("evidence-view.js","utf8");
const fields = src.slice(src.indexOf("const fields = ["), src.indexOf("const nestedFields"));
const nested = src.slice(src.indexOf("const nestedFields"), src.indexOf("const pointer"));
const tuples = [...fields.matchAll(/\[\x27([a-z_]+)\x27,\s*\[([^\]]*)\]\]/g)];
const keys = tuples.flatMap(m => m[2].split(",").map(s => s.trim().replace(/^\x27|\x27$/g,"")).filter(Boolean));
console.log("友好字段名:", tuples.length, "| 候选原始键:", keys.length, "去重:", new Set(keys).size);
console.log("含 ~ 或 / 的候选键:", [...new Set(keys)].filter(k => /[~\/]/.test(k)).length);
console.log("嵌套字段名里含 ~ 或 /:", [...nested.matchAll(/\x27([a-z_]+)\x27/g)].map(m=>m[1]).filter(k=>/[~\/]/.test(k)).length);
'
```

实测输出：

```
友好字段名: 52 | 候选原始键: 106 去重: 104
含 ~ 或 / 的候选键: 0
嵌套字段名里含 ~ 或 /: 0
```

```bash
# 分支判定按形状而非工具名
node --input-type=module -e '
import { projectEvidence } from "./evidence-view.js";
console.log("详情工具返回数组 →", projectEvidence("get_revshell_event", { events: [{id:1}] }).kind);
console.log("列表工具返回对象 →", projectEvidence("list_honeypot_events", { event: { id: 1 } }).kind);
console.log("包一层 event →", JSON.stringify(projectEvidence("get_revshell_event", { event: { id: 7, cmdline: "bash -i" } }).facts.command_line));
console.log("包一层 data →", JSON.stringify(projectEvidence("get_x_event", { data: { id: 7 } }).facts.event_id));
console.log("数组结果 →", JSON.stringify(projectEvidence("get_x", [1,2,3])));
console.log("字符串结果 →", JSON.stringify(projectEvidence("get_x", "hello")));
console.log("null 结果 →", JSON.stringify(projectEvidence("get_x", null)));
'
```

实测输出：

```
详情工具返回数组 → list
列表工具返回对象 → detail
包一层 event → {"value":"bash -i","pointer":"/event/cmdline"}
包一层 data → {"value":7,"pointer":"/data/id"}
数组结果 → {"kind":"detail","tool":"get_x","facts":{},"related_sequences":{}}
字符串结果 → {"kind":"scalar","tool":"get_x","value":"hello"}
null 结果 → {"kind":"scalar","tool":"get_x","value":null}
```

```bash
# 长度上限与零时间哨兵
node --input-type=module -e '
import { projectEvidence } from "./evidence-view.js";
const v = projectEvidence("get_x_event", { comment: "c".repeat(501), cmdline: "b".repeat(3001) });
console.log("超限：facts =", JSON.stringify(v.facts));
const v2 = projectEvidence("get_x_event", { comment: "c".repeat(500), cmdline: "b".repeat(3000) });
console.log("边界：comment 500 保留 =", "comment" in v2.facts, "| cmdline 3000 保留 =", "command_line" in v2.facts);
const v3 = projectEvidence("get_x_event", { observed_at: -62135596800, last_seen_at: -62135596799 });
console.log("零时间哨兵：observed_at =", v3.facts.observed_at, "| last_seen_at =", v3.facts.last_seen_at);
'
```

实测输出：

```
超限：facts = {}
边界：comment 500 保留 = true | cmdline 3000 保留 = true
零时间哨兵：observed_at = undefined | last_seen_at = undefined
```

```bash
# 嵌套序列的挑选
node --input-type=module -e '
import { projectEvidence } from "./evidence-view.js";
const v = projectEvidence("get_x_event", { timeline: Array.from({length: 25}, (_,i)=>({timestamp:i, request_length:1, response_length:0})),
  commands: Array.from({length: 12}, (_,i)=>({seq:i, cmdline:"c"})),
  process_tree: Array.from({length: 9}, (_,i)=>({pid:i})),
  state_history: Array.from({length: 7}, (_,i)=>({state:i})) });
for (const name of ["timeline","commands","process_tree","state_history"]) {
  const s = v.related_sequences[name];
  console.log(name, "total =", s.total_in_record, "shown =", s.shown_count, "索引 =", s.shown.map(r=>r.index).join(","));
}
'
```

实测输出：

```
timeline total = 25 shown = 19 索引 = 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,24
commands total = 12 shown = 8 索引 = 0,1,2,3,8,9,10,11
process_tree total = 9 shown = 5 索引 = 0,1,2,3,4
state_history total = 7 shown = 5 索引 = 0,1,2,3,4
```

```bash
# 列表计数与平台 total 的一致性判断
node --input-type=module -e '
import { projectEvidence } from "./evidence-view.js";
const rows = Array.from({ length: 8 }, (_, i) => ({ id: i+1, level: i%2 ? 3 : 1, source_ip: "192.0.2.1", host_view: { host_name: "db-"+(i%3) } }));
const v = projectEvidence("list_honeypot_events", { total: 100, events: rows });
console.log("kind =", v.kind, "| returned_count =", v.returned_count, "| items =", v.items.length);
console.log("counts_on_returned_page =", JSON.stringify(v.counts_on_returned_page));
console.log("反例 platform_total_consistent =", projectEvidence("list_host_events", { total: 0, events: [{ id: 62558 }] }).platform_total_consistent);
console.log("无 total：", projectEvidence("list_host_events", { events: [{ id: 1 }] }).total_reported_by_platform);
'
```

实测输出：

```
kind = list | returned_count = 8 | items = 5
counts_on_returned_page = {"by_risk_level":{"1":4,"3":4},"by_source_ip":{"192.0.2.1":8},"by_host":{"db-0":3,"db-1":3,"db-2":2}}
反例 platform_total_consistent = false
无 total： null
```

```bash
# 上下文裁剪
node --input-type=module -e '
import { projectEvidence, boundEvidenceView } from "./evidence-view.js";
const raw = { total: 50, result: Array.from({ length: 5 }, (_, i) => ({ id: i+1, name: "process-"+i, cmdline: "x".repeat(1100), path: "p".repeat(450), user: "root" })) };
const view = projectEvidence("list_process_assets", raw);
const b = boundEvidenceView(view, 3500);
console.log("裁剪前 items =", view.items.length, "长度 =", JSON.stringify(view).length);
console.log("裁剪后 items =", b.items.length, "长度 =", JSON.stringify(b).length, "truncated =", b.truncated_for_context, "shown_count =", b.shown_count);
console.log("returned_count =", b.returned_count, "| 计数仍在 =", JSON.stringify(b.counts_on_returned_page));
console.log("裁不动时 =", JSON.stringify(boundEvidenceView({ kind: "list", tool: "t", items: [{ facts: { x: { value: "y".repeat(5000), pointer: "/x" } } }] }, 100)));
'
```

实测输出：

```
裁剪前 items = 5 长度 = 9798
裁剪后 items = 1 长度 = 2283 truncated = true shown_count = 1
returned_count = 5 | 计数仍在 = {"by_process_name":{"process-0":1,"process-1":1,"process-2":1,"process-3":1,"process-4":1}}
裁不动时 = {"kind":"list","tool":"t","truncated_for_context":true,"error":"精简后仍超出上下文限制；请缩小查询条件或降低 count 后重查，不能引用本次省略的字段。"}
```

模块自带的测试：

```bash
node --test evidence-view.test.js
```

```
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

## 11 约束与理由

### 11.1 假设

- 牧云返回的字段名落在字段表的候选键里；表外的字段不进视图（`evidence-view.js:3-40`）。
- `response_digest` 是 base64；解不开时走 catch 分支，不展示请求行（`evidence-view.js:114-115`、`evidence-view.js:140`）。
- 时间戳是 Unix 秒；牧云的零时间哨兵是 `-62135596800`（`evidence-view.js:60`；测试数据见 `evidence-view.test.js:48`）。
- 原始返回能序列化成 JSON（`evidence-view.js:235`）。

### 11.2 限制

- **字段表是静态的**。牧云新增字段不会自动进视图（`evidence-view.js:3-40`）。
- **视图不做语义解释**。`http_request_line.decoded` 是 base64 解出的首行，代码不判断服务端是否真的处理了它（`evidence-view.js:133-135`）。
- **TLS 标记只说明首两字节像 TLS 握手格式**，文案里已写明「不证明握手成功」（`evidence-view.js:136-138`）。
- **计数键取第一个命中的候选键**，同一维度下的不同来源不合并（`evidence-view.js:97`）。
- **列表视图只留前 5 行**，其余行只能通过 `returned_count` 与预聚合计数感知（`evidence-view.js:215`）。
- **嵌套序列只带白名单字段**。`timeline`、`process_tree`、`state_history`、`commands` 各自只取固定的几个键（`evidence-view.js:42-47`、`evidence-view.js:124-127`）。

### 11.3 已知坑

- **`kind` 由形状决定**。工具名与结果形状对不上时走形状那一支（`evidence-view.js:190`、`evidence-view.js:223`）。
- **顶层数组的结果会得到空视图**。`[1,2,3]` 这种返回不是四个列表键之一，会落到详情分支，`facts` 为空（`evidence-view.js:223-228`；实测见 §10.2）。
- **计数与 `items` 的口径不同**。计数覆盖整页，`items` 只有前 5 行（`evidence-view.js:195`、`evidence-view.js:215`）。
- **timeline 超 20 行时展示 19 行**，不是 20 行（`evidence-view.js:111-119`）。
- **裁剪后计数不重算**，`counts_on_returned_page` 仍是裁剪前的整页计数（`evidence-view.js:239-242`）。
- **指针转义在当前字段表下不会触发**。`pointer()` 把 `~` 转成 `~0`、`/` 转成 `~1`（`evidence-view.js:49`），而 104 个候选键与嵌套字段名里没有这两个字符（实测见 §10.2）。
- **视图被裁两次**。取证会话先按 12000 裁一次（`agent-tools.js:65`），结论证据再按 3000 / 4000 裁一次（`investigation-agent.js:139`）。
- **`host_id` 没有兜底之后，缺 `host_id` 的事件行就拿不到主机身份**（P003-T035）。这不是回归：事件行只有裸 `id` 时，
  下游必查项会落成 `missing_identifier`（「无法发起限定范围查询」），而不是拿事件 ID 去查另一台机器。`host_ip` 仍保留裸 `ip` 兜底，
  这一条没跟着改——它是否同样会指向别的实体，本卡没有核实。

### 11.4 被排除的方案

- **没有采用「直接改原始结果」的写法**。注释写明「删减的是展示行，原始结果仍可用于本次引用校验」（`evidence-view.js:233`），这也是 `R-EV-12` 的由来。
- **投影是有意为之的白名单**，不是通用裁剪。文件头注释写明「只选择能支持单告警研判的字段」（`evidence-view.js:1-2`）。
- **为什么用静态字段表而不是通用 JSON 裁剪、为什么对超长字段丢弃而不是截断**，代码与注释里都没写，**没查到**。

## 12 指针与未决

**相关页面**（模块页由各自的模块卡产出，归属见 [docs/modules/_breakdown.json](_breakdown.json)）：整体结构见 [docs/architecture.md](../architecture.md)；取证工具与引用校验见 evidence-tools 模块页；结论证据与必查项视图见 investigation-agent 模块页。

**本页未决**：

1. **牧云的真实响应形状没实测**。本机没有牧云凭据，本卡未发起任何外部请求。本文关于响应结构的描述，依据的是代码里的字段表与用构造数据跑出的分支结果，不是真实响应。
2. **52 个友好字段覆盖牧云多少字段没实测**。牧云若有字段名不在候选键里，它不会出现在视图里（`evidence-view.js:3-40`）。
3. **`get_host_risk_overview` 的 `Data` / `data` 双写与 `emergency_vuln` 的真实键名没实测**。代码两种行键都试，哪个是数组用哪个（`evidence-view.js:166-167`）。
4. **时间戳单位按 Unix 秒推定**，未与牧云核对（`evidence-view.js:60`）。
5. **为什么丢弃超长字段而不是截断、为什么用静态字段表而不是通用裁剪，没查到**（见 §11.4）。
6. **12000 / 4000 / 3000 三个预算的取值理由没查到**。代码里只有数值（`evidence-view.js:234`、`investigation-agent.js:139`、`investigation-agent.js:266`）。
7. **`investigation-agent` 侧怎么消费这些字段没在本页考证**。属 investigation-agent 模块页的范围。
