# 深度溯源白板 · trace-board

这篇讲一个模块：`trace-board.js`。它把「一条告警」或「一个 IP」变成一张可追溯的白板——节点是资产与 IP，边是它们之间的关系，
关系要带原始证据引用。

- 实现文件：`trace-board.js`（模块归属见 [docs/modules/_breakdown.json](_breakdown.json) 的 `trace-board` 条目）
- 在架构里的位置：编排层，见 [architecture.md 第 4 节](../architecture.md#4-模块分层与依赖)
- 证据约定：本页每一处 `文件:行号` 引用都能在 [evidence/recon/P001-T011.md](../../evidence/recon/P001-T011.md) 的清单表里查到；
  清单里没有的引用不出现在本页。行号对应提交 `35530d8`。

## 1 职责

### 1.1 做什么

- **开白板**：以告警 ID（`<类型>:<数字>`）或一个 IPv4 为起点，生成一张初始白板——起点节点、起始时间窗、一条「以告警／IP 为起点」的活动记录
  （`trace-board.js:64-71`、`trace-board.js:72-78`、`trace-board.js:79-85`、`trace-board.js:88-100`）。
- **让模型自己追**：进入一个自主循环，模型每轮从 `look`／`investigate`／`link`／`conclude` 四种动作里选一个
  （`trace-board.js:143-149`、`trace-board.js:365`）。
- **查节点**：程序按节点类型发起牧云只读查询，把资产档案、跨类事件、同类事件、防火墙连接记录取回来，按时间窗过滤后算成资产档案与事实摘要
  （`trace-board.js:248`、`trace-board.js:249-257`、`trace-board.js:259-267`、`trace-board.js:268-277`、`trace-board.js:278-279`、`trace-board.js:327-330`）。
- **连关系**：模型可以给两个节点连边，但边必须带能核验的原始证据引用，且引用要覆盖两端地址（`trace-board.js:396-416`）。
- **落盘**：整张白板存成一个 JSON 文件，进程重启后仍能读（`trace-board.js:184-197`、`trace-board.js:173-183`）。

### 1.2 不做什么

- **不下指令**：本模块只调用以 `get_` 或 `list_` 开头的查询类工具（`trace-board.js:207-213`、`trace-board.js:249-257`、
  `trace-board.js:259-267`、`trace-board.js:268-277`、`trace-board.js:278-279`），不碰处置类接口。
- **不做告警的日常判定**：告警列表怎么判由另一个智能体负责，这里只做溯源（`prompts/trace-board.md:3`）。
- **不替人把线索说成结论**：程序画的那条「触达线索」只是同一条记录里的来源 IP 与目标主机，提示词要求 AI 自己判断它算不算真关系
  （`trace-board.js:304-311`、`prompts/trace-board.md:12`）。
- **不写客户端**：本仓只含业务后端，不含客户前端和维护页面（`README.md:3`）。

## 2 公开面

### 2.1 类与函数

| 能力 | 入口 | 证据 |
| --- | --- | --- |
| 开一张新白板并启动追查 | `TraceBoardService.start` | `trace-board.js:198-202`、`trace-board.js:214-216` |
| 读一张白板 | `TraceBoardService.get` | `trace-board.js:173-183` |
| 列白板（按更新时间倒序） | `TraceBoardService.list` | `trace-board.js:158-172` |
| 调查一个节点 | `TraceBoardService.investigate` | `trace-board.js:226-229` |
| 跑一轮自主追查 | `TraceBoardService.explore` | `trace-board.js:356-363` |
| 保存白板 | `TraceBoardService.save` | `trace-board.js:184-197` |
| 造告警起点的初始白板 | `traceBoardSeed` | `trace-board.js:64-71` |
| 造 IP 起点的初始白板 | `traceIpSeed` | `trace-board.js:88-100` |

各能力的细节在第 5 节按构件逐段展开。

`TraceBoardService` 的构造参数是 `toolbox`、`model`、`promptStore`、`directory` 四项，其中 `promptStore` 有默认值
（`trace-board.js:151-155`）。白板文件名规则：入参是裸 IP 就落成 `ip:<IP>.json`，否则原样加 `.json`（`trace-board.js:157`）。

### 2.2 HTTP 入口（接线在 `server.js`）

| 请求 | 行为 | 证据 |
| --- | --- | --- |
| `POST /api/trace/boards` | 请求体取 `target`／`alert_id`／`ip` 与 `focus`，目标不合法返回 400，成功返回 202 与白板快照 | `server.js:161-168` |
| `GET /api/trace/boards` | 返回白板列表 | `server.js:157-160` |
| `GET /api/trace/boards/{id}` | 返回单张白板；没有这张白板返回 404 | `server.js:169-178` |
| `GET /api/trace/tools` | 返回牧云 MCP 的工具目录（`provider` 为 `cloudwalker-mcp`，`readOnly` 为 `true`） | `server.js:146-150` |

`/api/trace/tools` 依赖牧云 MCP 工具箱（`server.js:146-150`）；另外三条依赖 `boardService`，它默认为 `traceBoard` 实例，而 `traceBoard` 只在牧云 MCP 工具箱与模型都在时才创建
（`server.js:113`、`server.js:50-51`）。没配齐时这些路由返回 503（`server.js:146-150`、`server.js:157-160`、`server.js:161-168`、`server.js:169-178`）。

### 2.3 两个起点

`start()` 接受两种目标（`trace-board.js:198-202`）：

| 目标形式 | 例子 | 起点节点 | 初始时间窗 | `alert_id` |
| --- | --- | --- | --- | --- |
| 告警 ID | `honeypot:7` | 优先是资产 IP（取自告警资产、原始证据里的 `host_ip`，或内网目的地址），取不到才用来源 IP（`trace-board.js:64-71`） | 观测时间前 24 小时到后 48 小时（`trace-board.js:79-85`） | 告警 ID（`trace-board.js:79-85`） |
| IPv4 | `64.177.57.21` | 这个 IP 本身（`trace-board.js:88-100`） | 最近 72 小时（`trace-board.js:88-100`） | `null`（`trace-board.js:88-100`） |

告警起点还会把告警里的 `source_ip` 与 `destination_address` 额外追加成节点（`trace-board.js:72-78`）；IP 起点只有一个节点（`trace-board.js:88-100`）。

两处口径差异，读数据时要留意：

- 告警起点的 `window.hours` 字段写的是 72，而 `since`／`until` 实际是观测时间前 24 小时到后 48 小时（`trace-board.js:79-85`）；
  IP 起点的 `since` 就是最近 72 小时（`trace-board.js:88-100`）。
- 提示词要求按白板与工具返回值为准，不要把覆盖范围说成固定的最近 72 小时（`prompts/trace-board.md:19`）。

同一种目标第二次 `start()` 时不重开：进程内已有在跑的任务就直接返回现有白板（`trace-board.js:203-205`）。

### 2.4 依赖

| 方向 | 依赖什么 | 证据 |
| --- | --- | --- |
| 本模块用到 | Node 内置模块（文件、路径、UUID）、事件类型表与告警归一化、提示词装载 | `trace-board.js:1-5` |
| 上游 | 业务 API 引入本模块，把 HTTP 请求转成本模块的方法调用 | `server.js:20`、`server.js:113` |
| 下游 | 事件类型表决定 `get_<类型>_event` 与 `list_<类型>_events` 的类型名；告警归一化把牧云事件行转成告警 | `cloudwalker.js:2-6`、`cloudwalker.js:31-34` |
| 下游 | 取证会话：开一个会话、记录每次调用与证据编号；引用校验给关系边把关 | `agent-tools.js:50`、`agent-tools.js:55`、`agent-tools.js:57-67`、`agent-tools.js:71-93` |
| 下游 | 提示词装载：`prompts.trace` 段对应仓内 `prompts/trace-board.md` | `prompt-store.js:18-19` |

## 3 白板的数据形状

### 3.1 节点

| 字段 | 含义 | 证据 |
| --- | --- | --- |
| `id` | `asset:<IP>` 或 `ip:<IP>` | `trace-board.js:64-71`、`trace-board.js:88-100` |
| `kind` | `asset` 或 `external_ip`，按内网地址判定 | `trace-board.js:72-78`、`trace-board.js:102-110` |
| `status` | 初始 `pending`，查完置 `done` | `trace-board.js:64-71`、`trace-board.js:325-326` |
| `label`／`address` | 显示名与地址 | `trace-board.js:64-71` |
| `profile` | 资产档案：名称、IP、系统、内核、分组、状态、暴露 IP、标签、最后出现时间、备注 | `trace-board.js:126-142` |
| `findings`／`finding_count` | 本次调查每条工具结果的摘要与命中条数 | `trace-board.js:327-330`、`trace-board.js:112-125` |
| `discovered_from` | 这个节点是从哪条证据的哪个指针发现的 | `trace-board.js:72-78`、`trace-board.js:102-110` |
| `touched_hosts` | 外部 IP 节点在窗口内碰到过的主机 | `trace-board.js:303` |
| `why`／`investigated_at` | 查它的理由与查完的时间 | `trace-board.js:325-326` |

### 3.2 边

| 字段 | 含义 | 证据 |
| --- | --- | --- |
| `from`／`to` | 两端节点 ID | `trace-board.js:304-311` |
| `rel` | 关系名；程序画的边固定写成「触达线索」 | `trace-board.js:304-311` |
| `why` | 这条关系的理由 | `trace-board.js:304-311`、`trace-board.js:396-416` |
| `strength` | 证据强度，不是攻击成功概率；程序边是 0.3，AI 边由模型给、夹在 0–1 | `trace-board.js:304-311`、`trace-board.js:396-416` |
| `citations` | 原始证据引用：`evidence_id` + `pointer` + `value` | `trace-board.js:304-311`、`trace-board.js:396-416` |
| `by` | `program`（程序画的）或 `ai`（模型连的） | `trace-board.js:304-311`、`trace-board.js:396-416` |

### 3.3 白板顶层

| 字段 | 含义 | 证据 |
| --- | --- | --- |
| `id`／`alert_id`／`run_id` | 白板 ID、来源告警 ID、本次运行 ID | `trace-board.js:79-85`、`trace-board.js:88-100` |
| `seed` | 起点节点 ID | `trace-board.js:64-71` |
| `status` | `running` → `done`／`failed`／`interrupted` | `trace-board.js:79-85`、`trace-board.js:217-223`、`trace-board.js:173-183` |
| `window` | 时间窗：`since`／`until`／`hours` | `trace-board.js:79-85`、`trace-board.js:88-100` |
| `nodes`／`edges`／`activity` | 节点、边、活动流水 | `trace-board.js:79-85` |
| `summary`／`gaps` | 结论摘要与缺口清单 | `trace-board.js:417-423` |
| `investigations` | 已调查的节点数 | `trace-board.js:331-334` |
| `model`／`focus` | 本次用的模型名与操作员给的焦点 | `trace-board.js:214-216` |
| `origin_evidence` | 起点那条原始事件的摘要 | `trace-board.js:79-85`、`trace-board.js:112-125` |

## 4 关键路径

### 4.1 一次溯源从头到尾

1. **操作员发起**：`POST /api/trace/boards`，请求体给 `target`（告警 ID 或 IP）与可选的 `focus`（`server.js:161-168`）。
2. **路由层校验目标格式**，不合法的直接 400（`server.js:107-111`）。
3. **服务层再校验一次**：目标要么匹配 `<类型>:<数字>`（类型要在事件类型表里），要么是 IPv4，否则抛 400「请输入有效告警 ID 或 IPv4 地址」
   （`trace-board.js:198-202`）。
4. **开一个取证会话**，上限 2000 次工具调用（`trace-board.js:203-205`）。
5. **造初始白板**：告警起点先调 `get_<类型>_event` 取原始事件、再归一化成告警（`trace-board.js:207-213`）；这个告警既没有可用资产也没有来源 IP 时抛 422
   （`trace-board.js:207-213`）。IP 起点直接造白板（`trace-board.js:207-213`）。
6. **记下模型名与操作员焦点**，首次落盘（`trace-board.js:214-216`）。
7. **后台开跑**：`start()` 把追查循环挂在后台并立即返回初始快照（`trace-board.js:217-223`）。
8. **模型每轮给一个动作**：循环开始时载入溯源提示词与 MCP 工具目录，首轮用户消息带上告警 ID、起点、时间窗、操作员焦点与 12 次调查上限
   （`trace-board.js:356-363`）。
9. **动作执行**：`look`（`trace-board.js:386-391`）、`investigate`（`trace-board.js:392-395`）、`link`（`trace-board.js:396-416`）、
   `conclude`（`trace-board.js:417-423`）；每轮结果回灌给模型（`trace-board.js:431-435`）。
10. **收尾**：`conclude` 把状态置 `done`（`trace-board.js:417-423`）；32 轮用尽也置 `done`，并在缺口里写明有路径没查完（`trace-board.js:437-439`）。
11. **操作员读结果**：`GET /api/trace/boards/{id}`（`server.js:169-178`）。

### 4.2 起点不同，走的路不同

| | 告警起点 | IP 起点 |
| --- | --- | --- |
| 起点节点 | 资产优先，取不到才用来源 IP（`trace-board.js:64-71`） | 就是这个 IP（`trace-board.js:88-100`） |
| 附带节点 | 追加 `source_ip` 与 `destination_address`（`trace-board.js:72-78`） | 无（`trace-board.js:88-100`） |
| 时间窗 | 观测时间前 24 小时到后 48 小时（`trace-board.js:79-85`） | 最近 72 小时（`trace-board.js:88-100`） |
| `alert_id` | 告警 ID（`trace-board.js:79-85`） | `null`（`trace-board.js:88-100`） |
| `origin_evidence` | 起点那条事件的摘要（`trace-board.js:79-85`、`trace-board.js:112-125`） | `null`（`trace-board.js:88-100`） |
| 节点类型 | 私有地址记 `asset`，其余记 `external_ip`（`trace-board.js:72-78`） | 同左；操作员给的是内网地址时也是资产节点（`trace-board.js:88-100`、`trace-board.js:102-110`） |

节点类型决定查询范围：资产节点按 `host_ip` 过滤（`trace-board.js:248`），外部 IP 节点按 `source_ip` 过滤，并额外查防火墙连接记录
（`trace-board.js:248`、`trace-board.js:278-279`）。

## 5 覆盖构件

本页要覆盖的四个构件：白板节点与边、节点调查、自主追查循环、白板持久化。下面四小节逐个展开。

### 5.1 白板节点与边

**节点**：

- 节点只有两种 `kind`：`asset` 与 `external_ip`，判据是地址算不算内网段（`trace-board.js:72-78`、`trace-board.js:102-110`、`trace-board.js:17-19`）。
- 节点 ID 统一是 `asset:<IP>` 或 `ip:<IP>`；节点表、候选表、边两端用的是同一套 ID（`trace-board.js:64-71`、`trace-board.js:102-110`、
  `trace-board.js:304-311`）。
- 起始节点由起点决定（`trace-board.js:64-71`、`trace-board.js:88-100`）；告警起点还会追加 `source_ip` 与 `destination_address` 两个节点
  （`trace-board.js:72-78`）。
- 邻接地址是程序从事件行里统计出来的：扫 `host_ip`、`source_ip`、`destination_address` 三个字段，合法且不等于当前节点地址的才计数
  （`trace-board.js:292-301`）。
- 入图有上限：节点总数 64（`trace-board.js:102-110`）；资产节点单轮最多加 12 个邻居，按出现次数降序取前几个，超出时写一条缺口
  （`trace-board.js:314-321`）。

**边**：

- 边有两类来源。程序画的边标 `by: 'program'`：同一条事件里同时有公网来源 IP 与目标主机时，记一条 `rel: '触达线索'`、强度 0.3 的边
  （`trace-board.js:304-311`）。
- 程序边入图要求两端节点都在图里，且同一对节点之间没有同类型的程序边（`trace-board.js:322-324`）。
- 模型连的边标 `by: 'ai'`，校验见 5.3（`trace-board.js:396-416`）。
- 提示词里写明了口径：程序画的「触达线索」只是同一条记录里的来源 IP 与目标主机，是粗筛，不算 AI 确认的关系（`prompts/trace-board.md:12`）。

**元素字段（契约）**。`openapi.yaml` 的 `TraceBoardNode` / `TraceBoardEdge` / `TraceBoardActivity` 按这三张表写；字段名不一致就是破坏性变更。

节点（`nodes[]`）：

| 字段 | 类型 | 什么时候有 | 含义 | 证据 |
| --- | --- | --- | --- | --- |
| `id` | string | 恒有 | `asset:<IP>` 或 `ip:<IP>` | `trace-board.js:68`、`trace-board.js:74`、`trace-board.js:106` |
| `label` | string | 恒有 | 展示名；资产节点优先主机名，取不到才用 IP | `trace-board.js:68`、`trace-board.js:94` |
| `address` | string（IPv4） | 恒有 | 节点地址 | `trace-board.js:69`、`trace-board.js:94` |
| `kind` | enum `asset` / `external_ip` | 恒有 | 决定后续查询口径 | `trace-board.js:69`、`trace-board.js:108` |
| `status` | enum `pending` / `done` | 恒有 | 建板时是 `pending`，调查收尾置 `done` | `trace-board.js:69`、`trace-board.js:326` |
| `why` | string | 恒有 | AI 给的理由；建板时是预置句或空串，收尾时改写 | `trace-board.js:70`、`trace-board.js:326` |
| `profile` | object | 恒有 | 资产档案；外部 IP 节点是 `{name: '外部 IP（未登记资产）', ip}` | `trace-board.js:70`、`trace-board.js:96`、`trace-board.js:284` |
| `findings` | object[] | 恒有 | 每条工具结果的摘要，收尾时写入 | `trace-board.js:70`、`trace-board.js:327` |
| `finding_count` | integer | 恒有 | 命中记录数（按工具类名加权，见下文） | `trace-board.js:70`、`trace-board.js:328-330` |
| `discovered_from` | object[] | 恒有 | 这个节点从哪条证据的哪个字段发现；起点节点是空数组 | `trace-board.js:71`、`trace-board.js:76`、`trace-board.js:97`、`trace-board.js:109` |
| `investigated_at` | string（date-time） | 调查收尾后 | 收尾时间 | `trace-board.js:326` |
| `touched_hosts` | string[] | 调查收尾后 | 调查外部 IP 时命中的内网主机地址 | `trace-board.js:325` |

`findings[]` 元素固定带 `evidence_id`、`tool`、`total`、`returned`、`rows`；列表结果另有 `page_returned`，单对象结果另有 `truncated`
（`trace-board.js:112-123`）。`discovered_from[]` 元素是 `{evidence_id, pointer}`，`pointer` 取不到时为 `null`（`trace-board.js:71`、`trace-board.js:76`、`trace-board.js:298`）。

边（`edges[]`）：

| 字段 | 类型 | 含义 | 证据 |
| --- | --- | --- | --- |
| `from` / `to` | string | 两端节点 ID | `trace-board.js:307`、`trace-board.js:410` |
| `rel` | string | 关系性质；程序边固定 `触达线索` | `trace-board.js:308`、`trace-board.js:410` |
| `why` | string | 关系理由 | `trace-board.js:308`、`trace-board.js:410` |
| `strength` | number（0–1） | 关系强度；程序边固定 0.3，AI 边出界时夹回 | `trace-board.js:309`、`trace-board.js:411` |
| `by` | enum `program` / `ai` | 谁画的 | `trace-board.js:309`、`trace-board.js:411` |
| `citations` | object[] | `{evidence_id, pointer, value}`；AI 边至少一条且引用值要覆盖两端地址 | `trace-board.js:309-310`、`trace-board.js:402-406` |
| `at` | string（date-time） | 写入时间 | `trace-board.js:309`、`trace-board.js:411` |

活动（`activity[]`）：

| 字段 | 类型 | 含义 | 证据 |
| --- | --- | --- | --- |
| `at` | string（date-time） | 发生时间 | `trace-board.js:83`、`trace-board.js:332` |
| `kind` | enum，见下 | 事件类型 | 各 push 点 |
| `title` | string | 一句话标题 | 各 push 点 |
| `detail` | string | 补充说明 | `trace-board.js:84`、`trace-board.js:243`、`trace-board.js:333` |
| `node` | string | 关联节点 ID（`investigate`） | `trace-board.js:333` |
| `edge` | integer | 关联边在 `edges` 里的下标（`link`） | `trace-board.js:413` |
| `result` | string | 这一轮的结果摘要（`investigate`、`look`） | `trace-board.js:333`、`trace-board.js:387-388` |

`kind` 的十个取值（枚举，十种全部在代码里有 push 点）：

| `kind` | 什么时候 | 证据 |
| --- | --- | --- |
| `seed` | 建板 | `trace-board.js:83`、`trace-board.js:96` |
| `tool` | 一次牧云查询 | `trace-board.js:238` |
| `tool_error` | 查询失败，或动作未过校验 | `trace-board.js:243`、`trace-board.js:427` |
| `investigate` | 调查一个节点收尾 | `trace-board.js:332` |
| `look` | 模型查看白板 | `trace-board.js:389` |
| `link` | 模型连边 | `trace-board.js:412` |
| `conclude` | 模型收尾 | `trace-board.js:421` |
| `thinking` | 模型选下一步 | `trace-board.js:367` |
| `model_error` | 模型输出格式错误正在重试 | `trace-board.js:375` |
| `error` | 调查中断，或整板失败 | `trace-board.js:178`、`trace-board.js:219` |

### 5.2 节点调查

- **前置**：节点必须已在白板里；已查过的节点（`status: 'done'`）再查会抛错（`trace-board.js:226-229`）。
- **起点节点那一次调查**会把会话里的第一条证据 `cw:1` 计入本次记录（`trace-board.js:230-231`）。
- **工具调用有两道闸**：工具名得在 MCP 工具目录里，且会话调用数没到上限；任一不满足就跳过这次调用（`trace-board.js:232-247`）。
- **查询失败不中断调查**：记一条 `tool_error` 活动后继续往下走（`trace-board.js:232-247`）。
- **查询范围**按节点类型分（`trace-board.js:248`）。
- **资产节点**先查资产档案（`list_host_assets`，取 5 条），拿到主机 ID 再查同机事件（`list_host_events`，50 条）（`trace-board.js:249-257`）。
- **跨类事件**最多翻 30 页、每页 50 条；行数不足一页，或出现早于时间窗的行，就停下（`trace-board.js:259-267`）。
- **分类型事件**对窗口内出现过的每种事件类型再翻最多 10 页（`trace-board.js:268-277`）。
- **两处翻页到顶**都会往 `gaps` 写一条，说明后面还有没查到的部分（`trace-board.js:259-267`、`trace-board.js:268-277`）。
- **外部 IP 节点**额外查防火墙连接记录（`trace-board.js:278-279`）。
- **窗口之外的行不参与统计**（`trace-board.js:22-36`）。
- **取行与字段抽取**：工具返回先从 `events`／`data`／`result`／`list`／`hosts` 里认出数组键（`trace-board.js:37-40`）；每一行再映射成具名字段并
  带上 JSON Pointer，`command_line` 上限 3000 字符、其余字段上限 500 字符（`trace-board.js:41-63`）。
- **节点收尾**：`status` 置 `done`，`why` 记 AI 给的理由（`trace-board.js:325-326`）；`findings` 存每条工具结果的摘要（`trace-board.js:327-330`）；
  `finding_count` 只算 `list_` 开头且不属于跨类事件、资产档案、同机事件的那几类查询，外加一次单事件查询（`trace-board.js:327-330`）。
- **交给模型的内容**按工具分组，每组最多留 3 行事实；序列化超过 30000 字符就逐行裁（`trace-board.js:335-352`）。

### 5.3 自主追查循环

- **起点**：载入溯源提示词与 MCP 工具目录（`trace-board.js:356-363`）；系统提示词是 `prompts.trace`，对应仓内 `prompts/trace-board.md`
  （`prompt-store.js:18-19`）。
- **首轮用户消息**带：任务说明、告警 ID、目标、起点、节点列表、起点证据、时间窗、操作员焦点，以及 12 次调查上限（`trace-board.js:356-363`）。
- **最多 32 轮**（`trace-board.js:365`）。
- **模型每轮只输出一个 JSON 对象**：程序解析时剥掉 markdown 代码围栏，并要求 `action` 是 `look`／`investigate`／`link`／`conclude` 之一
  （`trace-board.js:143-149`、`prompts/trace-board.md:5-10`）。
- **解析失败**（JSON 不完整或动作不在白名单）：记一条 `model_error` 活动，把纠正指令发回模型重试；连续 3 次失败就抛错
  （`trace-board.js:371-382`）。
- **`look`**：返回节点 ID、状态、命中数与白板当前的边，并记一条 `look` 活动（`trace-board.js:386-391`）。
- **`investigate`**：调查次数已达 12 时抛错，让模型转去总结现有证据与缺口（`trace-board.js:392-395`）。
- **`link`** 有六道校验（`trace-board.js:396-416`）：

  1. 两端节点都在白板里，且不是同一个节点；
  2. 至少一端已经调查过（`status` 是 `done`）；
  3. 关系性质与理由都不能空；
  4. 引用非空，且通过 `verifyClaims`——核对引用存在、pointer 是 JSON Pointer、字段能解出、值相等（`agent-tools.js:71-93`）；
  5. 引用必须覆盖两端地址；
  6. 同一对节点、同一个 `rel` 不能重复。

  过校验后边的 `strength` 夹在 0–1（`trace-board.js:396-416`）。
- **`conclude`**：至少调查过一个节点才能结束；`summary` 截断到 2500 字符，`gaps` 最多 8 条、每条 240 字符（`trace-board.js:417-423`）。
- **动作没过校验**：把错误回灌给模型并记一条 `tool_error`；连续 5 次失败就抛错（`trace-board.js:425-430`）。
- **消息体裁剪**：超过 70000 字符时，从第 3 条起裁到只剩最近 8 条（`trace-board.js:431-435`）。
- **32 轮用尽**：状态置 `done`，摘要写明已达轮次上限，`gaps` 添一条「未完成的路径需继续人工核查」（`trace-board.js:437-439`）。
- **抛错的后果**：整张白板状态置 `failed`，错误进 `gaps`，并记一条 `error` 活动（`trace-board.js:217-223`）。

### 5.4 白板持久化

- **目录**：`<root>/backend/.data/trace-boards`（`server.js:50-51`）；`root` 的解析规则见架构篇第 8.1 节。
- **文件名**：入参是裸 IP 就落成 `ip:<IP>.json`，否则原样加 `.json`（`trace-board.js:157`）。
- **写入方式**：先写 `<目标>.<UUID>.tmp`，再 `rename` 覆盖；文件权限 `0o600`；写失败先删临时文件再抛（`trace-board.js:184-197`）。
- **落盘很频繁**：每次工具调用后（成功或失败）都存一次（`trace-board.js:232-247`）。调查收尾也存一次（`trace-board.js:331-334`），后面这几处动作执行完同样存：
  `trace-board.js:386-391`、`trace-board.js:396-416`、`trace-board.js:417-423`、`trace-board.js:425-430`。
- **读**：`get()` 读不到文件返回 `null`；读到状态是 `running` 而进程内没有对应在跑任务时（一般是进程重启过），改写成 `interrupted`、
  追加一条「调查已中断」活动并回写（`trace-board.js:173-183`）。
- **列**：`list()` 扫目录里的 `.json`，逐个读出 `id`／`title`／`status`／`created_at`／`updated_at`，读坏的文件跳过，按 `updated_at` 倒序，
  条数夹在 1–50（`trace-board.js:158-172`）。目录不存在时返回空数组（`trace-board.js:158-172`）。
- **并发读**：写入是「临时文件 + rename」，并发读不会读到写了一半的文件——仓内测试盯的就是这一条（`trace-board.test.js:8-34`）。

## 6 不变量

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| R-TRACE-01 | 一条 AI 连的边要带能核验的原始引用，且引用覆盖两端地址 | 只写「A 打了 B」而不给引用 | `trace-board.js:396-416`、`agent-tools.js:71-93` | 边被拒，错误回灌给模型 |
| R-TRACE-02 | 同一个节点只查一次 | 查完的节点再查一次 | `trace-board.js:226-229`、`trace-board.js:325-326` | 本轮调查抛错 |
| R-TRACE-03 | 一张白板的节点数不超过 64 | 第 65 个候选节点被丢弃 | `trace-board.js:102-110` | 邻居不再被发现，缺口里有记录 |
| R-TRACE-04 | 一次追查最多调查 12 个节点 | 第 13 次 `investigate` | `trace-board.js:392-395` | 抛错，模型被要求转去总结 |
| R-TRACE-05 | 程序画的边只标「触达线索」，强度 0.3，来源 `program` | 把粗筛线索说成已确认关系 | `trace-board.js:304-311`、`prompts/trace-board.md:12` | 结论夸大 |
| R-TRACE-06 | 同一对节点、同一个 `rel` 不重复连边 | 重复连一次 | `trace-board.js:396-416` | 抛错，模型收到「这条关系已存在」 |
| R-TRACE-07 | 白板落盘是原子的，读到的是完整快照 | 读到写了一半的 JSON | `trace-board.js:184-197`、`trace-board.test.js:8-34` | 解析失败，该条白板在列表里被跳过 |

## 7 失败面

| 失败模式 | 表现 | 白板状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| 目标格式非法 | HTTP 400「请输入有效告警 ID 或 IPv4 地址」 | 未创建 | 改对再发 | 无（`server.js:161-168`、`trace-board.js:198-202`） |
| 告警既无资产也无来源 IP | HTTP 422 | 未创建 | 换 IP 起点重发 | 无（`trace-board.js:207-213`） |
| 同一白板已在跑 | 返回现有白板快照 | `running` | — | 不重开（`trace-board.js:203-205`） |
| 工具不在 MCP 目录，或会话调用数到顶 | 该次查询被跳过 | `running` | 否 | 继续用已有结果（`trace-board.js:232-247`） |
| 工具查询失败 | 记一条 `tool_error` 活动 | `running` | 模型可以换个工具再试 | 该工具无结果，其余照跑（`trace-board.js:232-247`） |
| 分页翻到上限 | `gaps` 写一条 | `running`／`done` | 否 | 明写没查到的范围（`trace-board.js:259-267`、`trace-board.js:268-277`） |
| 模型连续 3 次输出坏 JSON | 抛错 | `failed` | 重新 start | 错误进 `gaps`（`trace-board.js:371-382`、`trace-board.js:217-223`） |
| 动作连续 5 次不通过校验 | 抛错 | `failed` | 重新 start | 错误进 `gaps`（`trace-board.js:425-430`、`trace-board.js:217-223`） |
| 调查次数到 12 | `investigate` 抛错 | `running` | 模型转去总结 | 提示总结现有证据与缺口（`trace-board.js:392-395`） |
| 轮次到 32 | 循环收尾 | `done` | 否 | 摘要写明已达上限，缺口记一条（`trace-board.js:437-439`） |
| 后端进程重启 | 读到的 `running` 白板被改写 | `interrupted` | 可以重新 start | 追加一条「调查已中断」活动（`trace-board.js:173-183`） |
| 白板目录不存在 | `list()` 返回空数组 | — | — | 无（`trace-board.js:158-172`） |
| 白板文件损坏 | `list()` 跳过该条；`get()` 把错误抛出来 | — | — | 无（`trace-board.js:158-172`、`trace-board.js:173-183`） |

## 8 资源与上限

上限常量集中在 `trace-board.js:7-14`（`MAX_INVESTIGATIONS`、`MAX_ROUNDS`、`WINDOW_HOURS`、`PAGE_SIZE`、`MAX_GLOBAL_PAGES`、`MAX_TYPE_PAGES`、
`MAX_NODES`、`MAX_ASSET_NEIGHBORS`）。用到它们的地方如下。

| 项 | 数值 | 来源 |
| --- | --- | --- |
| 一次追查的节点调查上限 | 12 | `trace-board.js:392-395`、`prompts/trace-board.md:14` |
| 自主循环轮次上限 | 32 | `trace-board.js:365` |
| 白板节点总数上限 | 64 | `trace-board.js:102-110` |
| 资产节点单轮新增邻居上限 | 12 | `trace-board.js:314-321` |
| 单次取证会话调用上限 | 2000 | `trace-board.js:203-205` |
| 每页条数 | 50 | `trace-board.js:259-267` |
| 跨类事件翻页上限 | 30 页 | `trace-board.js:259-267` |
| 分类型事件翻页上限 | 10 页 | `trace-board.js:268-277` |
| 交给模型的结果上限 | 30000 字符（超出逐行裁） | `trace-board.js:335-352` |
| 每个工具分组保留的事实行 | 3 行 | `trace-board.js:335-352` |
| 消息体上限 | 70000 字符，超了裁到最近 8 条 | `trace-board.js:431-435` |
| 结论摘要上限 | 2500 字符 | `trace-board.js:417-423` |
| 缺口清单 | 8 条，每条 240 字符 | `trace-board.js:417-423` |
| 模型回复解析重试 | 连续 3 次失败抛错 | `trace-board.js:371-382` |
| 动作校验失败重试 | 连续 5 次抛错 | `trace-board.js:425-430` |
| 时间窗 | 告警起点：观测时间前 24 小时到后 48 小时；IP 起点：最近 72 小时 | `trace-board.js:79-85`、`trace-board.js:88-100` |
| 列表返回条数 | 1–50 | `trace-board.js:158-172` |

## 9 边界与未决

- **本卡没实测的部分**：牧云 MCP 工具的真实响应结构、模型在真实提示词下的追查质量、客户端怎么渲染白板、「触达线索」在真实数据里的误报率。
  清单与原因见 [evidence/recon/P001-T011.md 第五节](../../evidence/recon/P001-T011.md#五没查到的部分)；这四项在页面上没有断言。
- **节点类型只有两类**：白板只支持资产与 IP 节点；操作员的焦点若是原始文件、命令或账号，按提示词要求保留在 `why` 与结论里，
  不捏造节点或查询能力（`prompts/trace-board.md:19`）。
- **窗口字段与实际区间不一致**：告警起点的 `window.hours` 是 72，实际区间是观测时间前 24 小时到后 48 小时（见 2.3，`trace-board.js:79-85`）。
- **程序边不等于真关系**：数据上靠 `by` 字段分得清，但「触达线索」该不该升级成真关系由模型判断，代码不替它判断
  （`trace-board.js:304-311`、`prompts/trace-board.md:12`）。
- **翻页上限造成的漏查**只写进 `gaps`，不会自动续查（`trace-board.js:259-267`、`trace-board.js:268-277`）。
- **告警归一化不在本模块**：`normalizeAlert` 住在 `cloudwalker.js`，事件 ID 无效时它抛错（`cloudwalker.js:31-34`）。

## 10 怎么验证

```bash
node --test trace-board.test.js
```

本卡实测结果：5 项测试全过，退出码 0（`node --version` 为 `v26.13.0`）。5 项测试各自盯的是：

| 测试 | 盯什么 | 证据 |
| --- | --- | --- |
| 并发读快照 | 写入期间不会读到写了一半的文件 | `trace-board.test.js:8-34` |
| 模型 JSON 不完整 | 记 `model_error`、重试、调查不中断 | `trace-board.test.js:36-52` |
| 关系边引用校验 | 无效引用被拒，有效引用入边并带 `citations` | `trace-board.test.js:54-112` |
| IP 起点 | `alert_id` 为 null、`touched_hosts` 有值、程序边 `by: 'program'` | `trace-board.test.js:114-145` |
| 资产调查新增外部 IP | 新发现的外部 IP 与程序边共用同一套节点 ID | `trace-board.test.js:147-175` |

页面的引用与证据清单的一致性，用 [evidence/recon/P001-T011.md 第四节](../../evidence/recon/P001-T011.md#四核对方法) 的脚本核对：
页面里每一处 `文件:行号` 都要能在清单表里查到，且文件存在、行号不越界。

## 11 指针

- 架构篇：[architecture.md](../architecture.md)——第 4 节（模块分层）、第 8.2 节（白板目录的落点）、第 12 节（模块清单）。
- 模块拆分清单：[docs/modules/_breakdown.json](_breakdown.json)——`trace-board` 条目记着实现文件与覆盖构件。
- 已知边界与未决台账：[docs/_meta/gaps.md](../_meta/gaps.md)。
- 溯源提示词正文：`prompts/trace-board.md`——模型每轮要输出的四种动作写在这里（`prompts/trace-board.md:5-10`）。
- 相邻模块：`event-gateway`（事件类型表与告警归一化，文件 `cloudwalker.js`）、`evidence-tools`（取证会话与引用校验，文件 `agent-tools.js`）、
  `http-api`（路由接线，文件 `server.js`）。这三页由各自的模块卡写。

本页只描述现状。「这里应该改成什么」是评审的活，不写在文档里。
