---
type: module
id: MOD-EVIDENCE-TOOLS
covers: [mcp-client.js, agent-tools.js, api-tools.js]
unit: evidence-tools
updated: 2026-11-17
---

# 取证工具箱（evidence-tools）

模块名 `evidence-tools`。覆盖文件三个：`mcp-client.js`、`agent-tools.js`、`api-tools.js`（模块划分与页面归属见 [docs/modules/_breakdown.json](_breakdown.json) 的 `evidence-tools` 条目）。

这篇讲这模块对外给出什么、拿到什么、失败时是什么样。关键断言标 `文件:行号`，行号对应当前提交 `35530d8`；代码改动后请重新核对。

取证结果怎么投影成模型看到的上下文、结论怎么被引用校验消费，都不在本篇：前者属 evidence-view 模块，后者属 investigation-agent 模块，页面归属同样见 `_breakdown.json`。

## 1 模块名与职责

### 1.1 做什么

- **给智能体提供可调用的取证工具**。牧云那边有两条取数通道——MCP（`/api/mcp`，`mcp-client.js:1`）与牧云事件 API（通过注入的 `rpc` 客户端调用，`api-tools.js:14`、`api-tools.js:36`）；本模块把两条通道包装成统一的「工具」概念，上层按名字调用，不直接碰 HTTP 与 JSON-RPC 细节（`mcp-client.js:14-35`、`api-tools.js:31-66`）。
- **决定哪些工具能被看见**。深度研判按一份显式枚举的冻结白名单裁剪牧云 MCP 的工具清单（`agent-tools.js:8-18`）；常规研判保留牧云事件 API 的工具清单（实测 23 个），另外只补 8 个 MCP 只读工具（`agent-tools.js:100-105`）。
- **把每次取数封成一条带证据编号的记录**。记录里带工具名、参数、取证时间、sha256 摘要、原始结果与投影后的视图（`agent-tools.js:64-65`）。
- **校验模型给出的引用**。核对结论里引用的证据编号、JSON Pointer 与字段值是否与本次调查取到的数据一致（`agent-tools.js:71-93`）。

### 1.2 不做什么

- **不做语义判断**。代码注释写明：机器校验只能核实「引用存在且字段值吻合」，不能替代语义和授权判断（`agent-tools.js:70`）。
- **不开放写入类工具**。交给智能体的是查询类工具名；牧云 MCP 另有 `whitelist_*` 写入工具，不在本模块的放行范围内（`agent-tools.js:6-8`）。
- **不把牧云 Token 交出去**。Token 只存在 MCP 客户端实例里（`mcp-client.js:8`），取证记录的字段里没有它（`agent-tools.js:64-65`）。
- **不落盘**。这三个文件里没有写文件动作（核查命令见 §10.2）；结论落盘是 record-store 模块的事。
- **不做证据字段投影的实现**。`projectEvidence` 与 `boundEvidenceView` 来自 evidence-view 模块，本模块只调用（`agent-tools.js:4`、`agent-tools.js:65`）。

## 2 覆盖构件

本页覆盖六个构件，逐个点名：

| 构件 | 是什么 | 定义处 |
| --- | --- | --- |
| **MCP 客户端** | `CloudwalkerMcpClient`：跟牧云 MCP 说 JSON-RPC 2.0 的 HTTP 客户端 | `mcp-client.js:3` |
| **API 取证工具箱** | `ApiEvidenceToolbox`：从牧云事件 API 取数，提供事件详情、事件列表、主机事件三类查询 | `api-tools.js:13` |
| **MCP 取证工具箱** | `AgentToolbox`：把牧云 MCP 的工具按白名单裁给深度研判智能体 | `agent-tools.js:30` |
| **常规研判工具箱** | `TriageEvidenceToolbox`：API 工具为主，MCP 侧只补 8 个只读补证工具 | `agent-tools.js:97` |
| **取证会话** | `EvidenceSession`：一次调查里的调用计数、证据记录与引用校验 | `agent-tools.js:54` |
| **工具白名单** | `investigationToolNames`：工具名的冻结数组，外加由它建出的 `allowed` 集合 | `agent-tools.js:8`、`agent-tools.js:18` |

三者的关系一句话：**MCP 客户端**是通道；**MCP 取证工具箱**与 **API 取证工具箱**是两种取数方式；**常规研判工具箱**把两者拼起来；**取证会话**是每次调查的账本；**工具白名单**是深度研判那侧的闸门。

## 3 对外能力

本模块对外导出的东西只有七个（`grep -n '^export' mcp-client.js agent-tools.js api-tools.js`，命令与输出见 §10.2）：

| 导出 | 种类 | 用途 | 定义处 |
| --- | --- | --- | --- |
| `CloudwalkerMcpClient` | 类 | 牧云 MCP 的 JSON-RPC 客户端 | `mcp-client.js:3` |
| `investigationToolNames` | 常量 | 深度研判的工具白名单（冻结数组） | `agent-tools.js:8` |
| `AgentToolbox` | 类 | MCP 取证工具箱 | `agent-tools.js:30` |
| `EvidenceSession` | 类 | 取证会话 | `agent-tools.js:54` |
| `TriageEvidenceToolbox` | 类 | 常规研判工具箱 | `agent-tools.js:97` |
| `createAgentToolboxFromEnv` | 函数 | 按环境变量装配 MCP 取证工具箱 | `agent-tools.js:119` |
| `ApiEvidenceToolbox` | 类 | API 取证工具箱 | `api-tools.js:13` |

三个工具箱的公开方法形状一致——`listTools()` 列工具、`callTool(name, args)` 调工具、`investigation(maxCalls)` 开一次调查：

| 能力 | MCP 取证工具箱 | API 取证工具箱 | 常规研判工具箱 |
| --- | --- | --- | --- |
| 列工具 | `agent-tools.js:33-39` | `api-tools.js:16-29` | `agent-tools.js:100-105` |
| 调工具 | `agent-tools.js:41-48` | `api-tools.js:31-66` | `agent-tools.js:107-114` |
| 开一次调查 | `agent-tools.js:50` | `api-tools.js:92` | `agent-tools.js:116` |

「开一次调查」返回的是取证会话，调用次数上限默认 20，三处默认值一致（`agent-tools.js:50`、`api-tools.js:92`、`agent-tools.js:116`）。

MCP 客户端自己的公开面是 `request(method, params)`、`initialize()`、`listTools()`、`callTool(name, args)`（`mcp-client.js:14`、`mcp-client.js:37`、`mcp-client.js:48`、`mcp-client.js:62`）。

## 4 关键路径

### 4.1 深度研判取一条 MCP 证据

从智能体发起一次工具调用，到拿到一条可被引用的证据记录，走的是这七步：

1. **列工具**。`AgentToolbox.listTools()` 首次调用时向牧云 MCP 取全量工具清单，按白名单过滤后缓存进 `catalog`（`agent-tools.js:33-37`）；之后返回的只含 `name`、`description`、`inputSchema` 三个字段（`agent-tools.js:38`）。
2. **拦名字**。工具名不在白名单就直接抛错，请求不会发往牧云（`agent-tools.js:42`）。白名单本身是冻结数组，同时建出一个 `allowed` 集合用于查名（`agent-tools.js:8`、`agent-tools.js:18`）。
3. **查目录**。名字在白名单里但牧云当前没提供，报「牧云 MCP 当前未提供工具」；清单是首次调用时缓存的（`agent-tools.js:44-45`）。
4. **校验参数**。按该工具自己的 `inputSchema` 校验：未知参数、缺必需参数、`count`/`offset`/`id` 越界都拒绝（`agent-tools.js:20-28`）；校验在 `agent-tools.js:46`，发请求在 `agent-tools.js:47`，参数不合规时不会发请求。
5. **发请求**。`CloudwalkerMcpClient.callTool` 发 `tools/call`；首次使用前先 `initialize` 握手，握手成功后才置位 `initialized`，同一个客户端实例只握手一次（`mcp-client.js:63`、`mcp-client.js:37-45`）。
6. **解析结果**。优先取 `structuredContent`；没有就取文本块拼成一段，`JSON.parse` 成功才算结果（`mcp-client.js:69-74`）。
7. **封成记录**。回到取证会话：先分配证据编号 `cw:<n>`（`n` 从 1 起），再调工具，算 sha256 摘要，组装记录（含投影视图），存进 `records`（`agent-tools.js:57-68`）。

**这条路径上有个次序上的坑**：证据编号在工具调用之前就分配了（`agent-tools.js:59-60`）。所以工具调用失败时，这次调查的名额已经被占掉，但 `records` 里不会留下记录。实测见 §10.1。

### 4.2 常规研判查一次事件

常规研判走的是「API 为主、MCP 补证」的组合：

1. **列工具**。`TriageEvidenceToolbox.listTools()` 并行拉 API 侧清单与 MCP 侧清单，把 MCP 侧名字命中正则的 8 个工具并进结果，已存在于 API 侧的名字不重复加入（`agent-tools.js:101-104`）。
2. **分流**。`callTool` 先问 API 侧清单：命中就整个交给 API 侧（`agent-tools.js:108`）；不命中才走 MCP 侧，且名字必须同时满足「MCP 确实提供」与「命中那 8 个名字的正则」，否则报「常规研判不提供」（`agent-tools.js:109-112`）。
3. **API 侧按名字分三支**（`api-tools.js:33-43`）：`get_<类型>_event` 走详情、`list_<类型>_events` 走单类列表、`list_host_events` 走主机事件；三支都不匹配则报「牧云 API 不提供取证工具」（`api-tools.js:65`）。
4. **详情分支**。只接受 `id` 一个参数，且必须为正整数；发 `<服务名>.GetEvent` 后核对返回事件的 `id`（或 `event_id`）与请求一致，否则报错（`api-tools.js:35-38`）。
5. **列表分支**。落到 `listEvents`：默认 `count=20`、`offset=0`，分页越界拒绝；筛选字段按类型放行，`host_ip`、`source_ip` 必须是 IPv4（`api-tools.js:68-84`）；响应必须含 `events` 数组与整数 `total`（`api-tools.js:87`）。
6. **主机事件分支**。按类型并发查询（`Promise.allSettled`，`api-tools.js:50`）：部分类型失败照常返回并标 `partial: true`，失败类型记进 `errors`（`api-tools.js:57`、`api-tools.js:62`）；失败类型数等于查询类型数时才抛错（`api-tools.js:59`）。
7. **返回覆盖范围说明**。两个列表分支的返回值都带 `query_scope`，写明只取了当前页、时间条件要在本地核对（`api-tools.js:63`、`api-tools.js:89`）。

### 4.3 结论引用校验

模型给出结论后，`verifyClaims` 逐条 claim、逐条 citation 核对（`agent-tools.js:71-93`）：

1. `claims` 必须是数组且非空，否则直接返回 `ok: false`（`agent-tools.js:73-74`）。
2. 每条 claim 至少要有一个 `citations`，否则记错并跳过这条 claim（`agent-tools.js:76-78`）。
3. citation 的 `evidence_id` 要能在本次调查的记录里找到，否则记「引用不存在」（`agent-tools.js:80-82`）。
4. `pointer` 必须是字符串且以 `/` 开头，否则记「缺少 JSON Pointer」（`agent-tools.js:83`）。
5. 按 JSON Pointer 逐段取值，段内 `~1` 解为 `/`、`~0` 解为 `~`（`agent-tools.js:84-86`）；取不到值记「字段不存在」（`agent-tools.js:87`）。
6. citation 必须带原始字段值 `value`，且与记录里的值 `JSON.stringify` 后一致，否则记「字段值不符」（`agent-tools.js:88-89`）。
7. 返回 `{ ok, errors }`，`ok` 为 `true` 当且仅当 `errors` 为空（`agent-tools.js:92`）。

这一层只认「引得到、值对得上」，不认结论说得对不对——代码注释把这点写明了（`agent-tools.js:70`）。

## 5 值语义

### 5.1 入参

| 参数 | 出现在 | 类型 | 单位 | 合法域 | 默认 | 越界怎么办 | 依据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `count` | MCP 工具参数、API 列表 | 整数 | 条 | 1–50 | 列表 20；主机事件 10 | MCP 侧报「count 必须在 1 到 50 之间」；API 侧报「牧云 API 分页参数无效」 | `agent-tools.js:25`、`api-tools.js:69`、`api-tools.js:71`、`api-tools.js:48` |
| `offset` | MCP 工具参数、API 列表 | 整数 | 条（偏移量） | 0–10000 | 0 | MCP 侧报「offset 超出允许范围」；API 侧报「牧云 API 分页参数无效」 | `agent-tools.js:26`、`api-tools.js:70`、`api-tools.js:71` |
| `id` | 事件详情 | 整数 | 标识符，无单位 | 正整数 | 无 | MCP 侧报「id 必须是正整数」；API 侧报「事件详情需要有效 ID」 | `agent-tools.js:27`、`api-tools.js:35` |
| `host_id` | 主机事件、列表筛选 | 整数 | 标识符，无单位 | 正整数 | 无 | 报「主机事件查询需要有效 host_id」或「host_id 无效」 | `api-tools.js:44`、`api-tools.js:77` |
| `types` | 主机事件 | 字符串数组 | 个（事件类型名） | 1–11 项，每项须是已知事件类型 | 全部事件类型 | 报「事件类型范围无效」 | `api-tools.js:26`、`api-tools.js:45-47` |
| `host_ip` | 列表筛选 | 字符串 | IPv4 点分地址，无单位 | 四段，每段 ≤255 | 无 | 报「host_ip 必须是 IPv4 地址」 | `api-tools.js:80-83` |
| `source_ip` | 列表筛选 | 字符串 | IPv4 点分地址，无单位 | 同上；仅蜜罐与爆破两类事件放行 | 无 | 其他事件类型报「牧云 API 不支持该筛选字段」 | `api-tools.js:5`、`api-tools.js:10`、`api-tools.js:73-74` |
| `maxCalls` | `investigation()` | 整数 | 次 | 非负 | 20 | 超过上限报「本次调查的取证调用已达到 n 次上限」 | `agent-tools.js:50`、`agent-tools.js:55`、`agent-tools.js:58` |
| 工具 `args` | 三处 `callTool` | 普通对象 | 无 | 不得是数组或 `null` | `{}` | 报「工具参数必须是对象」/「API 取证参数必须是对象」 | `agent-tools.js:21`、`api-tools.js:32` |

### 5.2 返回值

**取证记录**（`EvidenceSession.callTool` 的返回，`agent-tools.js:57-68`）：

| 字段 | 类型 | 单位 | 含义 | 依据 |
| --- | --- | --- | --- | --- |
| `evidenceId` | 字符串 | — | 形如 `cw:<n>`，`n` 是本次调查里的第几次取证调用 | `agent-tools.js:59` |
| `tool` | 字符串 | — | 工具名 | `agent-tools.js:64` |
| `args` | 对象 | — | 调用参数的深拷贝 | `agent-tools.js:64` |
| `fetchedAt` | 字符串 | ISO 8601 时间戳 | 取证时刻 | `agent-tools.js:64` |
| `sha256` | 字符串 | 64 位十六进制串 | 对 `{name, args, result}` 序列化串的摘要 | `agent-tools.js:61-63` |
| `result` | JSON 值 | 无 | 牧云返回的原始数据（不约束结构） | `agent-tools.js:64` |
| `view` | JSON 值 | 无 | 投影并裁剪后的数据，供模型看的那份 | `agent-tools.js:65` |

**列表结果**（`listEvents`，`api-tools.js:88-89`）：

| 字段 | 类型 | 单位 | 含义 | 依据 |
| --- | --- | --- | --- | --- |
| `total` | 整数 | 条 | 当前页口径下的总数 | `api-tools.js:88` |
| `events` | 数组 | — | 事件数组 | `api-tools.js:88` |
| `queried_type` / `queried_offset` / `queried_count` | 字符串 / 整数 / 整数 | — / 条（偏移量）/ 条 | 本次查询的类型与分页位置 | `api-tools.js:88-89` |
| `query_scope` | 字符串 | — | 覆盖范围说明：只取当前页 | `api-tools.js:89` |

**主机事件结果**（`list_host_events`，`api-tools.js:61-63`）：

| 字段 | 类型 | 单位 | 含义 | 依据 |
| --- | --- | --- | --- | --- |
| `total` | 整数 | 条 | 各成功类型 `total` 之和（失败类型不计） | `api-tools.js:61` |
| `events` | 数组 | — | 合并后按时间倒序的事件数组，每条带 `event_type` | `api-tools.js:56`、`api-tools.js:60` |
| `queried_types` | 字符串数组 | — | 实际查询的类型（去重后） | `api-tools.js:62` |
| `totals_by_type` | 对象 | 条 | 成功类型 → 各自的 `total` | `api-tools.js:55` |
| `errors` | 对象 | — | 失败类型 → 错误文案（截断 200 字） | `api-tools.js:57` |
| `partial` | 布尔 | — | 是否存在失败类型 | `api-tools.js:62` |
| `query_scope` | 字符串 | — | 覆盖范围说明 | `api-tools.js:63` |

**引用校验结果**（`verifyClaims`，`agent-tools.js:92`）：`{ ok, errors }`。引用级错误带 `claims[i].citations[j]` 前缀（`agent-tools.js:81`）。`claims` 不是数组、空数组、某条缺少 citations 这三种不带这个前缀（`agent-tools.js:73-74`、`agent-tools.js:77`）。

## 6 依赖

| 方向 | 对象 | 说明 | 依据 |
| --- | --- | --- | --- |
| 下游 | 牧云 MCP | HTTP POST 到 `<base>/api/mcp`，`Accept` 头同时要 `application/json` 与 `text/event-stream` | `mcp-client.js:1`、`mcp-client.js:7`、`mcp-client.js:16-24` |
| 下游 | 牧云事件 RPC | 详情走 `<服务名>.GetEvent`；列表走 `<服务名>.GetEventList`，蜜罐例外用 `<服务名>.List` | `api-tools.js:36`、`api-tools.js:85` |
| 下游 | evidence-view 模块 | 提供 `projectEvidence` 与 `boundEvidenceView`，用来生成记录的 `view` | `agent-tools.js:4`、`agent-tools.js:65` |
| 下游 | cloudwalker 模块 | 提供事件类型表与 RPC 方法名表 | `agent-tools.js:3`、`api-tools.js:1` |
| 外部库 | `node:crypto` | 只用到 `createHash` | `agent-tools.js:1` |
| 外部库 | 全局 `fetch` | MCP 客户端默认传输；可注入替身 | `mcp-client.js:4`、`agent-tools.js:119` |
| 上游 | 研判智能体 | 调 `listTools` / `callTool` / `investigation` / `verifyClaims` | 属 investigation-agent 模块，本页不展开 |

## 7 数据归属

| 数据 | 放在哪 | 生命周期 | 依据 |
| --- | --- | --- | --- |
| 证据记录 | `EvidenceSession.records`（Map） | 一次调查一份，调查结束即弃；本模块不落盘 | `agent-tools.js:55`、`agent-tools.js:66` |
| 调用计数 | `EvidenceSession.started` / `maxCalls` | 同上 | `agent-tools.js:55` |
| 工具目录缓存 | `AgentToolbox.catalog` | 客户端实例级，首次列工具后常驻 | `agent-tools.js:31`、`agent-tools.js:34-37` |
| MCP 端点与 Token | `CloudwalkerMcpClient.url` / `.token` | 客户端实例级，不外传 | `mcp-client.js:7-8` |
| 请求序号与初始化标记 | `CloudwalkerMcpClient.sequence` / `.initialized` | 客户端实例级 | `mcp-client.js:10-11` |

## 8 不变量

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-EVID-01` | 深度研判发往牧云的工具名都在冻结白名单里 | 传一个白名单外的名字 | `agent-tools.js:8-18`、`agent-tools.js:42` | 报错，请求不发出 |
| `R-EVID-02` | 常规研判经 MCP 只放行 8 个只读查询工具 | 常规研判调一个 `whitelist_*` 写入工具 | `agent-tools.js:103-104`、`agent-tools.js:110-112` | 报「常规研判不提供」 |
| `R-EVID-03` | 每次取证分配一个递增的证据编号 `cw:<n>` | 两条记录共用一个编号 | `agent-tools.js:59`、`agent-tools.js:66` | `started` 自增，Map 键不重复 |
| `R-EVID-04` | 单次调查的取证调用不超过 `maxCalls`（默认 20） | 第 21 次调用 | `agent-tools.js:55`、`agent-tools.js:58` | 抛错；失败的调用也占名额（`agent-tools.js:59-60`） |
| `R-EVID-05` | 每条记录带 `sha256`，摘要覆盖 `name`/`args`/`result` | 记录缺 `sha256` | `agent-tools.js:61-63` | 证据链里少一个可复算的摘要 |
| `R-EVID-06` | 记录的 `view` 由 `projectEvidence` + `boundEvidenceView` 生成 | `view` 直接等于 `result` | `agent-tools.js:65` | 投影逻辑在 evidence-view 模块 |
| `R-EVID-07` | 事件详情返回的事件 ID 与请求 ID 相同 | 牧云返回了别的 ID | `api-tools.js:38` | 抛错，不返回数据 |
| `R-EVID-08` | 列表响应必须含 `events` 数组与整数 `total` | 响应缺 `events` | `api-tools.js:87` | 抛错 |
| `R-EVID-09` | 主机事件部分类型失败时照常返回并标 `partial` | 部分失败被当成整体失败 | `api-tools.js:50`、`api-tools.js:57`、`api-tools.js:62` | `errors` 非空、`partial` 为 `true` |
| `R-EVID-10` | 引用校验只判「引用存在且字段值吻合」 | 语义错的结论被放行 | `agent-tools.js:70`、`agent-tools.js:83-89` | 校验层不判语义 |
| `R-EVID-11` | MCP 响应必须 `jsonrpc` 为 `2.0` 且 `id` 与请求一致 | 串号响应 | `mcp-client.js:31` | 抛错 |
| `R-EVID-12` | 同一个 MCP 客户端只握手一次；服务端须自称 `cloudwalker` 且带工具能力 | 重复握手、连上别的服务 | `mcp-client.js:38`、`mcp-client.js:43-45` | 握手校验失败则抛错 |
| `R-EVID-13` | 缺 `CLOUDWALKER_URL` 或 `CLOUDWALKER_API_TOKEN` 时返回 `null`，不抛错 | 未配凭据就启动崩掉 | `agent-tools.js:120` | 返回 `null`，由调用方处理 |

## 9 失败面

### 9.1 MCP 通道上的错误文案

| 场景 | 文案 | 依据 |
| --- | --- | --- |
| 地址不是 HTTP(S) | `CLOUDWALKER_URL 必须是 HTTP(S) 地址` | `mcp-client.js:5` |
| Token 少于 6 个字符 | `CLOUDWALKER_API_TOKEN 无效` | `mcp-client.js:6` |
| HTTP 非 2xx | `牧云 MCP HTTP <状态码>` | `mcp-client.js:26` |
| 响应 content-type 不是 JSON | `牧云 MCP 未返回 JSON 响应` | `mcp-client.js:27-29` |
| `jsonrpc` 版本或 `id` 不匹配 | `牧云 MCP 响应身份不匹配` | `mcp-client.js:31` |
| JSON-RPC 错误 | `牧云 MCP <code>: <message 截 200 字>` | `mcp-client.js:32` |
| 响应缺 `result` | `牧云 MCP 响应缺少 result` | `mcp-client.js:33` |
| 服务端不自称牧云 | `MCP 服务不是牧云` | `mcp-client.js:43` |
| 服务端没有工具能力 | `牧云 MCP 未提供工具能力` | `mcp-client.js:44` |
| 工具清单不是数组 | `牧云 MCP 工具清单格式无效` | `mcp-client.js:54` |
| 工具清单超 500 条 | `牧云 MCP 工具清单超出限制` | `mcp-client.js:57` |
| 工具返回 `isError` | `牧云工具 <名>: <文本截 250 字>` | `mcp-client.js:65-67` |
| 工具没给文本结果 | `牧云工具 <名> 未返回文本结果` | `mcp-client.js:71` |
| 工具文本超 2,000,000 字符 | `牧云工具 <名> 返回内容过大` | `mcp-client.js:72` |
| 工具文本不是 JSON | `牧云工具 <名> 返回内容不是 JSON` | `mcp-client.js:73-74` |

### 9.2 工具箱与会话层的错误文案

| 场景 | 文案 | 依据 |
| --- | --- | --- |
| 深度研判调用白名单外工具 | `工具 <名> 未授权给研判智能体` | `agent-tools.js:42` |
| 牧云 MCP 当前没提供该工具 | `牧云 MCP 当前未提供工具 <名>` | `agent-tools.js:45` |
| 参数不是对象 | `工具参数必须是对象` | `agent-tools.js:21` |
| 参数里有 schema 未声明的字段 | `不支持的工具参数：<名>` | `agent-tools.js:23` |
| 缺 schema 声明的必需参数 | `缺少必需参数：<名>` | `agent-tools.js:24` |
| `count` 越界 | `count 必须在 1 到 50 之间` | `agent-tools.js:25` |
| `offset` 越界 | `offset 超出允许范围` | `agent-tools.js:26` |
| `id` 不是正整数 | `id 必须是正整数` | `agent-tools.js:27` |
| 取证调用超过上限 | `本次调查的取证调用已达到 <n> 次上限` | `agent-tools.js:58` |
| 单次结果超 2,000,000 字符 | `工具结果超出本次调查的单次取证上限` | `agent-tools.js:62` |
| 常规研判请求未开放的工具 | `常规研判不提供 <名>` | `agent-tools.js:112` |
| API 侧不认识这个工具 | `牧云 API 不提供取证工具 <名>` | `api-tools.js:65` |
| API 参数不是对象 | `API 取证参数必须是对象` | `api-tools.js:32` |
| 事件详情参数不对（多传或 `id` 非法） | `事件详情需要有效 ID` | `api-tools.js:35` |
| 返回事件 ID 与请求不符 | `牧云 API 详情事件 ID 与请求不符` | `api-tools.js:38` |
| 主机事件 `host_id` 非法 | `主机事件查询需要有效 host_id` | `api-tools.js:44` |
| 主机事件类型范围无效 | `事件类型范围无效` | `api-tools.js:46-47` |
| 主机事件单类条数超限 | `单类查询条数超出范围` | `api-tools.js:49` |
| 主机事件全部类型失败 | `主机事件 API 全部查询失败：<首个错误>` | `api-tools.js:59` |
| 列表分页参数无效 | `牧云 API 分页参数无效` | `api-tools.js:71-72` |
| 筛选字段不被支持 | `牧云 API 不支持该筛选字段` | `api-tools.js:74` |
| IP 不是 IPv4 | `<字段名> 必须是 IPv4 地址` | `api-tools.js:82` |
| 引用了不存在的证据 | `claims[i].citations[j] 引用不存在` | `agent-tools.js:82` |
| 引用缺 JSON Pointer | `claims[i].citations[j] 缺少 JSON Pointer` | `agent-tools.js:83` |
| 引用字段不存在 | `claims[i].citations[j] 字段不存在` | `agent-tools.js:87` |
| 引用缺原始字段值 | `claims[i].citations[j] 缺少原始字段值` | `agent-tools.js:88` |
| 引用字段值与记录不符 | `claims[i].citations[j] 字段值不符` | `agent-tools.js:89` |

### 9.3 失败之后的状态

| 失败模式 | 失败后的状态 | 能否重试 | 降级 |
| --- | --- | --- | --- |
| 本地参数被拒（白名单外、未知参数、越界） | 本次会话没新增记录；调用名额已被占 | 改参数后可重试，但受剩余名额限制 | 无 |
| 牧云 HTTP 失败或 15 秒超时 | 同上 | 可重试（推断：这几个分支都是只读查询，代码未对幂等性作保证） | 无 |
| 工具返回 `isError`、非 JSON 或超大文本 | 同上 | 取决于牧云侧 | 无 |
| 主机事件部分类型失败 | 记录已写入，返回体带 `partial: true` 与 `errors` | 可单独重查失败的类型 | 部分结果可用 |
| 主机事件全部类型失败 | 本次会话没新增记录；调用名额已被占 | 可重试 | 无 |
| 引用校验不通过 | `records` 不变，返回 `ok: false` 与错误清单 | 由调用方决定 | 本次结论不可用 |
| 未配牧云凭据 | 不产生会话 | —— | `createAgentToolboxFromEnv` 返回 `null`，由调用方处理 |

“调用名额已被占”指的是证据编号在工具调用之前就分配了（`agent-tools.js:59-60`），而记录是在调用成功后才写入 `records`（`agent-tools.js:66`）。

## 10 资源与余量

### 10.1 边界值

| 项 | 数值 | 依据 |
| --- | --- | --- |
| MCP 单次请求超时 | 15,000 毫秒 | `mcp-client.js:24` |
| MCP 工具清单条数上限 | 500 条 | `mcp-client.js:57` |
| MCP 工具文本结果上限 | 2,000,000 字符 | `mcp-client.js:72` |
| 单次调查单条结果上限 | 2,000,000 字符 | `agent-tools.js:62` |
| 单次调查取证调用上限 | 20 次（默认） | `agent-tools.js:55`、`agent-tools.js:50` |
| 深度研判白名单长度 | 47 个工具名（实测） | `agent-tools.js:8`；命令见下 |
| 常规研判的 MCP 补证工具 | 8 个 | `agent-tools.js:104` |
| API 侧工具数 | 23 个（11 类事件 × 2 + `list_host_events`） | `api-tools.js:16-29`；命令见下 |
| API 单页 `count` 上限 | 50 条 | `api-tools.js:71` |
| API `offset` 上限 | 10,000 | `api-tools.js:71` |
| 主机事件 `count` 上限 | 20 条 | `api-tools.js:49` |
| 主机事件类型数上限 | 11 项 | `api-tools.js:46` |
| 主机事件并发度 | 一次最多 11 个并发 RPC | `api-tools.js:50` |
| 错误文案截断 | JSON-RPC 错误 200 字；工具 `isError` 250 字；主机事件单类错误 200 字 | `mcp-client.js:32`、`mcp-client.js:67`、`api-tools.js:57` |

### 10.2 实测与静态核查

本地没牧云凭据，没向牧云发过真实请求；下面几条是用假传输层（假 `fetch` / 假 `rpc`）跑出来的，只验证本模块自己的分支逻辑，不代表牧云的真实响应。

```bash
# 白名单长度与重复项
node --input-type=module -e '
import { investigationToolNames } from "./agent-tools.js";
console.log("白名单长度:", investigationToolNames.length);
console.log("重复项:", investigationToolNames.filter((n,i)=>investigationToolNames.indexOf(n)!==i).length);
'
# API 侧工具数
node --input-type=module -e '
import { ApiEvidenceToolbox } from "./api-tools.js";
const api = new ApiEvidenceToolbox({ call: async () => ({ total: 0, events: [] }) });
console.log("API 侧工具数:", (await api.listTools()).length);
'
# 调用失败是否占用名额
node --input-type=module -e '
import { EvidenceSession } from "./agent-tools.js";
const s = new EvidenceSession({ callTool: async () => { throw new Error("boom"); } }, 2);
try { await s.callTool("x", {}); } catch {}
console.log("失败后 started =", s.started, " records =", s.records.size);
'
```

实跑输出：

```
白名单长度: 47
重复项: 0
API 侧工具数: 23
失败后 started = 1  records = 0
```

静态核查（导出面与落盘面）：

```bash
grep -n "^export" mcp-client.js agent-tools.js api-tools.js
grep -nE "node:fs|writeFile|appendFile|createWriteStream" mcp-client.js agent-tools.js api-tools.js
```

第二条命令退出码 1（无匹配），即这三个文件没有写文件动作。逐条错误文案、常规研判合并清单等更长的探针与输出记在 `evidence/recon/P001-T004.md`。

## 11 约束与理由

### 11.1 假设

- 牧云 MCP 是 JSON-RPC 2.0 over HTTP，路径固定在 `<base>/api/mcp`，响应 content-type 含 `application/json`（`mcp-client.js:1`、`mcp-client.js:7`、`mcp-client.js:23`、`mcp-client.js:27`）。
- 服务端 `serverInfo.name` 是 `cloudwalker`，且声明了工具能力（`mcp-client.js:43-44`）。
- 事件类型表与 RPC 方法名表由 cloudwalker 模块提供；本模块按类型名拼方法名（`agent-tools.js:3`、`api-tools.js:1`、`api-tools.js:36`、`api-tools.js:85`）。
- 蜜罐事件的列表方法名与其他事件不同（`List` 对 `GetEventList`）（`api-tools.js:85`）。
- 事件 ID 字段可能叫 `id` 也可能叫 `event_id`（`api-tools.js:38`）。
- 工具的 `inputSchema` 由牧云 MCP 提供，本模块在 schema 之上再叠一层自己的区间校验（`agent-tools.js:46`、`agent-tools.js:20-28`）。

### 11.2 限制

- **白名单只是上限**。名字在白名单里但牧云当前没提供该工具时，调用报「牧云 MCP 当前未提供工具」（`agent-tools.js:45`）。
- **白名单是硬编码的**。牧云新增工具不会自动进来；反过来，新增一类事件会自动多出两个工具名（`agent-tools.js:7`）。
- **常规研判的 MCP 侧只放 8 个工具**，牧云 MCP 的其余工具在常规研判路径不可达（`agent-tools.js:104`）。
- **列表只取当前页**，时间条件要在返回后本地核对（`api-tools.js:21`、`api-tools.js:89`）。
- **API 侧不按 schema 校验参数**，除列表分支外基本只做工具名匹配（`api-tools.js:33-43`）。

### 11.3 已知坑

- **证据编号先分配、后调用**。工具调用失败时名额已占、`records` 里却没有记录（`agent-tools.js:59-60`、`agent-tools.js:66`）。
- **主机事件的 `total` 只算成功类型**。失败类型的数量不在 `total` 里，得连着 `errors` 与 `partial` 一起读（`api-tools.js:55`、`api-tools.js:61`）。
- **`types` 长度检查在去重之前**。重复的类型名也占 11 的名额，去重发生在之后（`api-tools.js:46`、`api-tools.js:50`）。
- **常规研判每次调用都重拉一次 API 工具清单**，没有像深度研判那样的 `catalog` 缓存（`agent-tools.js:108` 对 `agent-tools.js:34`）。
- **两处 2,000,000 上限口径不同**。MCP 侧量的是工具返回文本的字符数（`mcp-client.js:72`）；会话侧量的是 `{name, args, result}` 序列化后的长度（`agent-tools.js:61-62`）。

### 11.4 被排除的方案

- 深度研判的工具放行用的是**显式枚举的白名单**，不是「牧云提供的工具减去 `whitelist_*`」这种前缀排除。代码里只留下注释说明意图——「只将明确选择的查询工具交给研判智能体。牧云 MCP 另有 `whitelist_*` 写入工具」（`agent-tools.js:6-8`）——**为什么选显式枚举而不是前缀排除，代码与注释里都没写，没查到**。

## 12 指针与未决

**相关页面**（模块页由各自的模块卡产出，归属见 [docs/modules/_breakdown.json](_breakdown.json)）：整体结构见 [docs/architecture.md](../architecture.md)；证据字段投影见 evidence-view 模块页；调用本模块的研判智能体见 investigation-agent 模块页；结论落盘见 record-store 模块页；牧云事件与 RPC 方法名表见 event-gateway 模块页。

**本页未决**：

1. **牧云的真实响应形状没实测**。本机没有牧云凭据，本卡未发起任何外部请求。本文关于响应结构的描述，依据是代码里的映射与用假传输层跑出的分支结果，不是真实响应。
2. **白名单里 47 个工具名，牧云 MCP 实际提供哪些、各自的 `inputSchema` 长什么样，没实测**。牧云没提供的名字，调用时报「牧云 MCP 当前未提供工具」（`agent-tools.js:45`）。
3. **常规研判的 8 个补证工具与 API 侧 23 个工具在真实牧云清单下是否同名，没实测**。同名时以 API 侧为准（`agent-tools.js:102-104`）。
4. **为什么用显式枚举白名单而不是按前缀排除，没查到**（见 §11.4）。
5. **`verifyClaims` 的调用方与失败后的处理没在本页考证**。属 investigation-agent 模块页的范围。
