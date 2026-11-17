---
type: module
id: MOD-EXPERIENCE-DRAFT
covers: [knowledge-store.js, knowledge-workbench.js]
updated: 2026-11-17
---

# 候选经验整理台 · experience-draft

一句话：**把「一条已人工判断过的告警」整理成九项字段，追问缺口，等人审核后发布、也允许撤回。**

> **模块名**：`experience-draft`
> **落点**：本页（`docs/modules/experience-draft.md`），模块清单见 [\_breakdown.json](_breakdown.json) 的 `experience-draft` 条目
> **真源**：`knowledge-store.js`（69 行，无本地 import）、`knowledge-workbench.js`（167 行，只 import `cloudwalker.js` 的 `eventTypes`）
> **覆盖构件**：九项经验字段、逐项追问、审核发布、撤回（四个构件各占一节，见第 5 节）
> **行号基准**：对应本卡提交；两个实现文件自 `a16e0d5` 起未改动。代码改了要重新核行号。

阅读约定：

- 本页的代码级断言只引两个文件——`knowledge-store.js` 与 `knowledge-workbench.js`（模块清单里本模块的实现文件只有这两个）。
- 凡是推断出来的，句子里写「推断」；凡是查不到的，进第 12 节的「缺口与未决」。
- 页里出现的其它路径只有三类：文档链接、运行时落盘文件、以及标明「不在本页证据范围」的外部模块名。
- 本模块**当前没有接进业务进程**：`server.js` 的 import 列表里没有这两个文件，`docs/architecture.md` 第 4 节末与第 13 节第 2 条记的是同一件事（文档指针，不在本页证据范围内）。

## 1 模块名

| 项 | 值 |
| --- | --- |
| 模块名 | `experience-draft` |
| 页面 | `docs/modules/experience-draft.md` |
| 实现文件 | `knowledge-store.js`（`wc -l` 实测 69 行）、`knowledge-workbench.js`（实测 167 行） |
| 覆盖构件 | 九项经验字段、逐项追问、审核发布、撤回 |

模块名与四个构件名来自模块清单 [\_breakdown.json](_breakdown.json) 的 `name` 与 `components` 字段。
本页第 5 节按这四个构件逐个点名展开；第 3、4 节讲对外方法与状态流转，第 7 节讲落盘形状。

两个文件的分工一句话：

| 文件 | 角色 | 对外导出 |
| --- | --- | --- |
| `knowledge-store.js` | 存储层：一条经验一个 JSON 文件，负责读写、列表、按场景检索、按 id 串行写 | `KnowledgeStore` 类（knowledge-store.js:7） |
| `knowledge-workbench.js` | 整理台：字段表、追问、模型调用、审核发布、撤回、稍后补充 | `KnowledgeWorkbench` 类、`knowledgeFields` 常量（knowledge-workbench.js:3、30） |

## 2 职责

**做什么**

- 开一条候选经验：生成一个 UUID 作 ID，写入首条助手开场白，状态 `draft`（knowledge-store.js:29-36）。
- 收一轮客户输入并整理：先把用户原话追加进 `messages`，再调知识整理模型把原话归纳成九项字段
  （knowledge-workbench.js:89-115）。字段的采纳有门槛，见第 5.1 节。
- 追缺口：从九项字段里按固定顺序挑第一个缺的、且没被标记「稍后补充」的字段追问
  （knowledge-workbench.js:24-27、119、129）。
- 把本轮结果写盘：一条经验一个 JSON 文件，临时文件 + `rename` 原子替换（knowledge-store.js:20-27）。
- 列清单与按告警类型检索已发布经验（knowledge-store.js:38-47、49-54）。
- 人工审核后发布、撤回（knowledge-workbench.js:37-67、69-80）。

**不做什么**

- **不判断经验对不对**。发布只校验四类输入形状与「字段已齐」两个条件（knowledge-workbench.js:39-52、56-58），
  不调牧云、不读工单、不核原始日志。整理提示词里也明写「不得补造工单、授权、日志或事实」
  「不要声称已核验牧云原始证据」（knowledge-workbench.js:101）——那是给模型的约束，不是本模块的核验能力。
- **不把经验直接给研判智能体**。两个文件的 import 只有 Node 标准库与 `cloudwalker.js` 的 `eventTypes`
  （knowledge-store.js:1-3、knowledge-workbench.js:1）；本模块只负责存与检索，检索由调用方发起（knowledge-store.js:49）。
- **不接 HTTP 路由**。两个类没有路由/请求处理之类的方法，对外只有第 3 节那张表里的方法
  （knowledge-store.js:10-56、knowledge-workbench.js:33-145）。
- **不删记录、不删消息**。两个文件没有删除或清空类方法（同上方法清单）；撤回只改状态与场景号（knowledge-workbench.js:69-80）。
- **不扩写字段**。模型返回九项之外的键会被丢弃——采纳循环只遍历 `knowledgeFields`（knowledge-workbench.js:108-115）。
- **一条记录只有一条对话线程**。`messages` 是一个数组，没有分叉、没有多会话（knowledge-store.js:31-34）。

## 3 对外方法

两个类的方法全表。错误都是普通 `Error`，区分靠 `error.status`（400/404/409）。

**KnowledgeStore（存储层）**

| 方法 | 入口 | 正常返回 | 失败形式 |
| --- | --- | --- | --- |
| 构造 | `new KnowledgeStore(directory)`（knowledge-store.js:8） | 实例；`directory` 是落盘目录 | — |
| 算文件路径 | `file(id)`（knowledge-store.js:10） | `<directory>/<id>.json` | id 不是 UUID 形状 → `400`，消息「候选经验 ID 无效」（knowledge-store.js:11） |
| 读一条 | `get(id)`（knowledge-store.js:15） | 记录对象；文件不存在返 `null`（knowledge-store.js:17） | 非法 id → `400`；JSON 解析失败 → `SyntaxError`（knowledge-store.js:16） |
| 整条写盘 | `write(record)`（knowledge-store.js:20） | 传入的 `record`（knowledge-store.js:26） | 文件系统错误直接抛（无翻译） |
| 新建 | `create()`（knowledge-store.js:29） | 新记录，`status: 'draft'`（knowledge-store.js:31） | 同上 |
| 列清单 | `list()`（knowledge-store.js:38） | 投影数组，按 `updated_at` 倒序（knowledge-store.js:44-46） | 目录里有 36 位「非 UUID」文件名时抛 `400`（knowledge-store.js:11、42） |
| 按类型检索 | `publishedFor(scenarioId)`（knowledge-store.js:49） | 已发布、未过期、同类型，最多 8 条（knowledge-store.js:53） | 同上（内部调 `list()`） |
| 按 id 串行改 | `update(id, change)`（knowledge-store.js:56） | `Promise<record>`，改写后已落盘（knowledge-store.js:57-67） | 记录不存在 → `404`（knowledge-store.js:60）；`change` 抛的错原样上抛 |

**KnowledgeWorkbench（整理台）**

| 方法 | 入口 | 正常返回 | 失败形式 |
| --- | --- | --- | --- |
| 构造 | `new KnowledgeWorkbench(store, model, promptStore)`（knowledge-workbench.js:31） | 实例；`model` 可以为 `null` | — |
| 列清单 / 读一条 / 新建 | `list()` / `get(id)` / `create()`（knowledge-workbench.js:33-35） | 与 store 同名方法一致 | 与 store 一致 |
| 收一轮输入 | `reply(id, content)`（knowledge-workbench.js:82） | 更新后的记录（knowledge-workbench.js:141） | 内容非法 / 消息上限 → `400`；已发布 / 并发 → `409`；不存在 → `404`（knowledge-workbench.js:83-91） |
| 稍后补充某字段 | `defer(id, field)`（knowledge-workbench.js:145） | 更新后的记录（knowledge-workbench.js:150-164） | 字段名不属九项 → `400`；不是当前问题或已不缺 → `409`；不存在 → `404`（knowledge-workbench.js:147、151-153） |
| 审核发布 | `publish(id, {scenario_id, note, valid_until, verdict})`（knowledge-workbench.js:37） | 更新后的记录，`status: 'published'`（knowledge-workbench.js:60） | 表单四类校验 → `400`；状态或字段不满足 → `409`；不存在 → `404`（knowledge-workbench.js:39-58） |
| 撤回 | `withdraw(id)`（knowledge-workbench.js:69） | 更新后的记录，`status: 'ready_for_review'`（knowledge-workbench.js:75） | 未发布 → `409`；并发 → `409`；不存在 → `404`（knowledge-workbench.js:70、74） |

两个补充：

- `reply` 中间调模型失败**不会把错误抛给调用方**：它把错误消息截到 240 字存进 `last_error`，
  再追加一条「这轮内容已保存，但自动整理暂时失败」的助手消息，然后正常返回记录
  （knowledge-workbench.js:96、134-140）。调用方要判这一轮整理成没成，看 `last_error` 是否为空。
- `model` 为 `null` 时也会走上面那条失败路径，`last_error` 是「知识整理模型尚未配置」
  （knowledge-workbench.js:96）。`promptStore.load()` 抛错同理（knowledge-workbench.js:97 在同一个 `try` 里）。

## 4 关键路径与状态机

### 4.1 四个状态

| 状态 | 谁写入 | 含义 | 依据 |
| --- | --- | --- | --- |
| `draft` | `create()` | 刚开记录，一条输入都没整理成功过 | knowledge-store.js:31 |
| `needs_info` | `reply()` | 整理过一轮，仍有缺口没补 | knowledge-workbench.js:127 |
| `ready_for_review` | `reply()` / `withdraw()` | 九项字段已齐，等人审；或者是已发布又被撤回 | knowledge-workbench.js:127、75 |
| `published` | `publish()` | 已人工审核并发布，可被 `publishedFor` 检索 | knowledge-workbench.js:60 |

**状态的写入点只有四处**（`create` 写 `draft`，`reply` 写 `needs_info` 或 `ready_for_review`，
`publish` 写 `published`，`withdraw` 写 `ready_for_review`）；`defer` 不改 `status`，
只改 `deferred_fields` / `next_field` / `next_question` 并追加两条消息（knowledge-workbench.js:154-162）。

### 4.2 路径 A：一轮整理

```
reply(id, content)                                                    knowledge-workbench.js:82
  → 内容校验：非空字符串、≤ 4000 字、不含 NUL                         knowledge-workbench.js:83-85
  → 同一 id 上已有操作在跑 → 409                                     knowledge-workbench.js:86-87
  → 第一次写盘：状态 published 拒；消息数已到 80 拒；追加用户原话     knowledge-workbench.js:89-94
  → 取提示词：promptStore.load().prompts.knowledge                   knowledge-workbench.js:97
  → 拼 system 提示词（输出契约 + 九项字段键名）                       knowledge-workbench.js:100-101
  → 模型输入：已有字段 + 已稍后补充的键 + 最近 24 条用户原话          knowledge-workbench.js:102-106
  → 逐字段验采纳（value/quote 门槛，见 5.1）                          knowledge-workbench.js:108-115
  → 算 missing / deferred / ready / next                             knowledge-workbench.js:116-119
  → 第二次写盘：状态、标题、下一个问题、助手回复                      knowledge-workbench.js:125-133
```

一轮里**写两次盘**：先落用户原话，再落整理结果（knowledge-workbench.js:89、125）。
这个顺序是可观测的：模型那一步失败时，用户原话已经在盘上（knowledge-workbench.js:134-140 的重试日志就能看到）。

### 4.3 路径 B：审核发布

```
publish(id, {scenario_id, note, valid_until, verdict})               knowledge-workbench.js:37
  → 并发检查                                                         knowledge-workbench.js:38
  → 四道表单校验（告警类型 / 审核说明 / 结论 / 复核日期）              knowledge-workbench.js:39-52
  → update(id, ...)：状态必须是 ready_for_review 且九项字段都在       knowledge-workbench.js:55-58
  → 写 status / scenario_id / review，追加一条助手消息                knowledge-workbench.js:59-63
```

### 4.4 路径 C：撤回与再补

```
withdraw(id)                                                          knowledge-workbench.js:69
  → 状态必须是 published，否则 409                                    knowledge-workbench.js:74
  → status 回 ready_for_review，scenario_id 置 null                    knowledge-workbench.js:75
  → 追加一条助手消息，review 对象不删                                  knowledge-workbench.js:76
```

撤回之后这条记录重新可被 `reply()` 接收（`reply` 只拦 `published`，knowledge-workbench.js:90），
也可以直接再 `publish()`（状态已是 `ready_for_review`）。这两件事都有实测，见第 11.3 节命令四。

## 5 覆盖构件

四个构件对应模块清单里的四个 `components` 名。本节逐个点名。

### 5.1 构件一：九项经验字段

字段表定义在 `knowledgeFields`（knowledge-workbench.js:3-13），是一个冻结的数组（knowledge-workbench.js:13），
每项三个值：键、中文名、追问原文。

| # | 键 | 名称 | 追问（客户看到的话） | 单位 / 形态 |
| --- | --- | --- | --- | --- |
| 1 | `record_ref` | 原始告警或处置记录 | 请提供告警 ID、发生时间或可回查的处置记录编号。 | 文本，告警号/时间/编号 |
| 2 | `customer_scope` | 客户或环境范围 | 这条经验适用于哪个客户、业务环境或组织？ | 文本，客户/环境名 |
| 3 | `subject_scope` | 资产、账号或地址范围 | 涉及哪些资产、账号或来源/目标地址？请说清适用范围。 | 文本，资产/账号/地址 |
| 4 | `behavior` | 触发行为 | 触发的具体命令、进程、连接或操作是什么？ | 文本，命令/进程/连接 |
| 5 | `reason` | 人工研判结论与理由 | 你的研判结论是什么？具体依据是什么？ | 文本，结论 + 依据 |
| 6 | `supporting_evidence` | 支持依据 | 你当时查了什么记录或证据来支持这个判断？ | 文本，查过的记录 |
| 7 | `applicability` | 复用条件 | 以后遇到相似告警，必须满足哪些条件才能复用这条经验？ | 文本，前置条件 |
| 8 | `counterexample` | 反例与失效条件 | 哪些差异会推翻这一判断？若暂无已知反例，也请明确说明。 | 文本，反例/失效条件 |
| 9 | `validity` | 有效期或复核触发条件 | 这条经验何时生效、何时失效，或者发生什么变化时必须重审？ | 文本，生效/失效时点 |

**表头顺序就是追问顺序**。`deriveMissing` 按这个顺序排缺项（knowledge-workbench.js:23），
`nextGap` 取其中第一个没被标记「稍后补充」的（knowledge-workbench.js:24-27）。

**一条字段被采纳要同时过四道门槛**（knowledge-workbench.js:108-115）：

| 门槛 | 具体条件 | 不过关的结果 | 依据 |
| --- | --- | --- | --- |
| 两个字段都得是字符串 | `value` 与 `source_quote` 都是 `string` | 本轮跳过这个字段 | knowledge-workbench.js:110 |
| 归纳值够长且不是未答词 | 去空白后 ≥ 2 字且不匹配未答词正则 | 跳过 | knowledge-workbench.js:111、113、22 |
| 引用片段够长 | 去空白后 ≥ 2 字 | 跳过 | knowledge-workbench.js:112-113 |
| 引用能在客户原话里找到 | 某条用户消息包含 `source_quote` | 跳过 | knowledge-workbench.js:114 |

两个细节值得单独记：

- **未答词只整串匹配**。正则带 `^…$`（knowledge-workbench.js:22），所以「不知道」被当未回答，
  而「不知道 ID，但这是例行巡检」会被采纳（实测见第 11.2 节命令三）。
- **引用校验只做子串包含**。它只证明「模型引的话客户确实说过」，不证明这句话与牧云原始证据对得上
  （knowledge-workbench.js:113-114）。

**两句截断**：`value` 与 `source_quote` 都截到 1000 字（knowledge-workbench.js:111-112）；
截断之后才做长度判断。实测把 1200 字的 value 交给模型，落盘的是 1000 字。

**九项以外的键被丢弃**：采纳循环只遍历 `knowledgeFields`（knowledge-workbench.js:108），
模型返回的其它键不会进记录。

### 5.2 构件二：逐项追问

追问只问一个字段，挑法是 `nextGap(missing, deferred)`（knowledge-workbench.js:24-27）：
按 `knowledgeFields` 的顺序找第一个「在 `missing` 里、不在 `deferred_fields` 里」的字段，
`key` 与 `question` 都从表里取；一个都挑不出来时返 `{key: null, question: ''}`（knowledge-workbench.js:26）。

**一轮整理后写入的三个追问支点**（knowledge-workbench.js:125-133）：

| 字段 | 内容 | 依据 |
| --- | --- | --- |
| `missing` | 还缺的字段键数组，按表头顺序 | knowledge-workbench.js:23、126 |
| `deferred_fields` | 本轮之后仍然缺、且被标过稍后补充的键（已补上的自动从这份名单里消失） | knowledge-workbench.js:117、126 |
| `next_field` / `next_question` | 下一个要问的键与追问原文；都齐了就是 `null` / 空串 | knowledge-workbench.js:119、129 |

**助手回复分三支**（knowledge-workbench.js:121-124）：

| 分支 | 条件 | 回复末尾说什么 |
| --- | --- | --- |
| 字段已齐 | `missing` 为空 | 已达到字段完整标准，状态为「待人工审核」，审核前不会供告警智能体直接使用 |
| 还有未延后的缺口 | `nextGap` 选出字段 | 「还需要补充：<追问原文>」，并告知可以点「稍后补充本项」 |
| 缺口全被延后 | `nextGap` 返回 `null` | 其余缺口已标记为稍后补充 |

**稍后补充（`defer`）的实际动作**（knowledge-workbench.js:145-166）：

1. 字段名必须是九项之一，否则 `400`（knowledge-workbench.js:147）。
2. 必须恰好是当前问题（`next_field === field`）且仍在 `missing` 里，否则 `409`「当前问题已变化」（knowledge-workbench.js:151-153）。
3. 把字段加进 `deferred_fields` 并去重（knowledge-workbench.js:154）。
4. 重算下一个问题（knowledge-workbench.js:155-156）。
5. 追加两条消息：一条 `role: 'user'`、`kind: 'defer'` 的「稍后补充：<字段名>」，
   一条助手回复（knowledge-workbench.js:159-162）。

第 5 步那条 `kind: 'defer'` 的用户消息**不进模型输入**：拼对话时筛的是
`role === 'user' && kind !== 'defer'`（knowledge-workbench.js:98-99）。所以模型看不到「稍后补充：客户或环境范围」
这类系统生成的句子，也就不可能把它当成客户原话再引回来。

**标题跟随字段**：每轮取 `behavior` 的前 32 字；没有就取 `record_ref` 的前 32 字；都没有就回到「新建研判经验」
（knowledge-workbench.js:130）。实测一份只有 `record_ref` 的记录，标题就是 `record_ref` 的前 32 字。

### 5.3 构件三：审核发布

`publish` 的检查分两段：**先验表单，再验记录状态**。表单检查全部在写盘之前（knowledge-workbench.js:38-52），
记录状态检查在 `store.update` 的回调里（knowledge-workbench.js:55-58）。

**第一段：表单四类校验**

| 检查 | 条件 | 不过关 | 依据 |
| --- | --- | --- | --- |
| 并发 | 同一 id 上没有其它操作在跑 | `409`「上一轮整理仍在进行，请稍后再试」 | knowledge-workbench.js:38、28 |
| 告警类型 | `scenario_id` 是 `eventTypes` 表里已有的键 | `400`「请选择适用的告警类型」 | knowledge-workbench.js:39-41 |
| 审核说明 | 字符串；去空白后 ≥ 5 字；原串（未去空白）长度 ≤ 500 | `400`「审核说明必须为 5 到 500 字」 | knowledge-workbench.js:42-44 |
| 经验结论 | `verdict` ∈ `threat` / `uncertain` / `false_positive`，缺省 `false_positive` | `400`「经验结论只能为真实威胁、存疑或误报」 | knowledge-workbench.js:37、45-47 |
| 复核日期 | `valid_until` 形如 `YYYY-MM-DD`，按当天 `23:59:59+08:00` 解析；必须晚于现在且不晚于现在 + 366 天 | `400`「请选择未来一年内的复核截止日期」 | knowledge-workbench.js:48-52 |

复核日期的两个边界是实测出来的：**选「今天」能过**（当天 23:59:59+08:00 仍在未来）；
**第 365 天能过、第 366 天不能**——现在是当天夜里，第 366 天那天的 23:59:59 距现在
比 366 × 24 小时还多出几个钟头，被上限挡下。`2026/12/01` 这种斜杠格式直接拒。

**第二段：记录状态与字段完整性**（knowledge-workbench.js:56-58）

两个条件同时成立才放行：`status === 'ready_for_review'`，且按 `current.fields` 重算的缺项为空。
任一不成立就 `409`「候选经验尚未达到人工审核标准」。注意消息是这一句——
**对一条已发布的记录再调 `publish`，得到的也是这句 `409`**，而不是「已发布」之类的话（实测）。

**通过后写入什么**（knowledge-workbench.js:59-63）

| 字段 | 内容 | 依据 |
| --- | --- | --- |
| `status` | `published` | knowledge-workbench.js:60 |
| `scenario_id` | 入参原值 | knowledge-workbench.js:60 |
| `review.note` | 去空白后的审核说明 | knowledge-workbench.js:61 |
| `review.verdict` | `threat` / `uncertain` / `false_positive` 之一 | knowledge-workbench.js:61 |
| `review.reviewed_at` | 审核当时的 ISO 时间 | knowledge-workbench.js:59、61 |
| `review.valid_until` | 入参的 `YYYY-MM-DD` 字符串，原样存 | knowledge-workbench.js:62 |
| `review.expires_at` | 上面那个日期换成的 ISO 时刻（当天 `23:59:59+08:00`） | knowledge-workbench.js:62 |
| `messages` | 追加一条助手消息，内含该告警类型的显示名（`eventTypes[scenario_id]`） | knowledge-workbench.js:63 |

**发布后怎么被检索到**：`KnowledgeStore#publishedFor(scenarioId)`（knowledge-store.js:49-54）
只返回同时满足三件事的记录：状态是 `published`、`scenario_id` 相等、`review.expires_at` 晚于现在。
取数顺序是「`list()` 倒序 → 前 20 条 → 读盘 → 过期过滤 → 前 8 条」——
所以**一个类型最多同时检出 8 条**；超过 20 条已发布记录时，只在前 20 条里筛（knowledge-store.js:51-53）。

### 5.4 构件四：撤回

`withdraw` 只做三件事（knowledge-workbench.js:69-80）：

| 步骤 | 内容 | 依据 |
| --- | --- | --- |
| 并发检查 | 同一 id 上有操作在跑就 `409` | knowledge-workbench.js:70 |
| 状态检查 | 必须是 `published`，否则 `409`「经验未发布」 | knowledge-workbench.js:74 |
| 回写 | `status` 改回 `ready_for_review`，`scenario_id` 置 `null`，追加一条助手消息 | knowledge-workbench.js:75-76 |

三个可观测的后果：

- **`review` 对象不删**。撤回只改上面两个字段（knowledge-workbench.js:75），所以记录里仍留着上一次的
  审核说明、结论、审核时间与失效时刻。实测：撤回后 `review` 还在，`scenario_id` 是 `null`。
- **检索立刻失效**。`publishedFor` 要求状态是 `published`（knowledge-store.js:51），撤回后就不在结果里了（实测）。
- **同一条可以反复发布、撤回**。撤回后状态是 `ready_for_review`，再调 `publish` 会重新走第二段状态检查
  （knowledge-workbench.js:56）并通过；第二次 `withdraw` 对未发布记录给 `409`（实测）。

## 6 依赖

| 方向 | 内容 | 依据 |
| --- | --- | --- |
| 上游 | 落盘目录：`new KnowledgeStore(directory)` 的 `directory` | knowledge-store.js:8 |
| 上游 | 知识整理模型：只要求一个 `complete(messages, [], 'none')` 方法，返回 `{content}` | knowledge-workbench.js:31、104-106 |
| 上游 | 提示词源：只要求一个 `load()` 方法，返回体要带 `prompts.knowledge` 作为 system 提示词开头的公共部分 | knowledge-workbench.js:31、97、101 |
| 下游 | `cloudwalker.js` 的 `eventTypes`：用它验告警类型键（knowledge-workbench.js:39）与拼发布消息里的类型显示名（knowledge-workbench.js:63）。这份表的键名与显示名不在本页证据范围，见第 12 节 | knowledge-workbench.js:1 |
| 标准库 | `node:crypto`（`randomUUID`）、`node:fs/promises`（`mkdir`/`readFile`/`readdir`/`rename`/`writeFile`）、`node:path` | knowledge-store.js:1-3 |
| 文件系统 | 读写目录里每个 `<uuid>.json` | knowledge-store.js:12、20-27、40-43 |

两个「接口窄」的事实值得说清：

- `KnowledgeStore` **不关心记录内容是什么**，`write(record)` 就是 `JSON.stringify` 后落盘（knowledge-store.js:24）；
  字段形状由整理台维护，存储层不校验。
- `KnowledgeWorkbench` **不持有落盘目录**，所有读写都转发给传进来的 `store`（knowledge-workbench.js:33-35、89、125）。
  两个实例共享同一个 `store` 时，串行化靠 `store` 里按 id 的队列（knowledge-store.js:57-66），不靠整理台。

## 7 数据与落盘

**一条经验 = 一个 JSON 文件**，文件名 `<id>.json`，目录由构造参数给（knowledge-store.js:12）。

| 记录字段 | 内容 | 谁写入 | 依据 |
| --- | --- | --- | --- |
| `id` | UUID | `create()` | knowledge-store.js:31 |
| `title` | 初值「新建研判经验」；整理后取 `behavior` 或 `record_ref` 前 32 字 | `create()` / `reply()` | knowledge-store.js:31、knowledge-workbench.js:130 |
| `status` | 四状态之一，见 4.1 | 四处，见 4.1 | 同上 |
| `created_at` / `updated_at` | ISO 时间；`updated_at` 每次写盘前刷新 | `create()` / `update()` | knowledge-store.js:30-31、62 |
| `messages` | 对话数组，每项 `{role, content, at}`，稍后补充那条多一个 `kind: 'defer'` | `create` / `reply` / `defer` / `publish` / `withdraw` | knowledge-store.js:32、knowledge-workbench.js:92、131、159-162、63、76 |
| `fields` | 已采纳字段：`{字段键: {value, source_quote}}` | `reply()`（整体替换） | knowledge-workbench.js:107-115、126 |
| `missing` | 还缺的字段键数组 | `reply()` | knowledge-workbench.js:126 |
| `deferred_fields` | 被标「稍后补充」且仍缺的键 | `reply()` / `defer()` | knowledge-workbench.js:117、154 |
| `next_field` / `next_question` | 下一个追问 | `create` / `reply` / `defer` | knowledge-store.js:33-34、knowledge-workbench.js:129、156 |
| `scenario_id` | 发布后才有；撤回时置 `null` | `publish()` / `withdraw()` | knowledge-workbench.js:60、75 |
| `review` | 发布后才有：`{note, verdict, reviewed_at, valid_until, expires_at}` | `publish()` | knowledge-workbench.js:61-62 |
| `last_error` | 上一轮整理失败的短消息（≤ 240 字）；成功轮清空 | `reply()` | knowledge-workbench.js:128、136 |

**写盘方式**（knowledge-store.js:20-27）：

1. `mkdir(directory, { recursive: true, mode: 0o700 })`（knowledge-store.js:21）。
2. 写临时文件 `<id>.json.<uuid>.tmp`，`mode: 0o600`、`flag: 'wx'`（knowledge-store.js:23-24）。
3. `rename` 换成正式文件名（knowledge-store.js:25）。

**id 校验**：`file(id)` 先验 UUID 形状的正则（knowledge-store.js:5、10-11）；
所以 ID 里拼不进出目录的东西（例如 `../etc/passwd`），拿到的会是 `400` 而不是一个路径（实测）。

**列表形状**：`list()` 不返回 `fields` 与 `review`，只给八个键：
`id`、`title`、`status`、`scenario_id`、`created_at`、`updated_at`、`missing_count`、`message_count`
（knowledge-store.js:45-46）。**要看字段就得再 `get(id)`**——`publishedFor` 就是这么干的（knowledge-store.js:52）。

**并发写法**：同一个 id 的 `update` 挂在前一个的 promise 键上串行执行，前一个失败不挡下一个
（`previous.catch(() => {})`，knowledge-store.js:57-58）；按 id 分开排队，不同记录之间并行。
回调在锁内拿到 `current`，改完返回，由 `update` 统一刷新 `updated_at` 再落盘（knowledge-store.js:59-63）。

## 8 行为承诺（不变量）

每一条都可以用第 11 节的命令或第 9 节的失败面反推。

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-EXPD-01` | 经 `reply()` 写入的 `fields` 只可能出现九项键 | 模型返回一个 `owner` 键也被采纳 | knowledge-workbench.js:108-115 | 下游按九项读会漏读，字段契约漂移 |
| `R-EXPD-02` | 每个被采纳的字段都带一段客户原话（子串校验过） | 模型编的 `source_quote` 也进记录 | knowledge-workbench.js:113-114 | 经验里出现客户没说过的话 |
| `R-EXPD-03` | 记录从 `ready_for_review` 进入 `published` 时九项字段都非空 | 缺三项也能发布 | knowledge-workbench.js:56-58 | 半成品经验被告警检索到 |
| `R-EXPD-04` | `publishedFor` 只返回状态 `published`、类型相同、未过期的记录 | 撤回后仍被检出 | knowledge-store.js:51-53 | 撤回对外无效 |
| `R-EXPD-05` | 已发布记录不能直接被 `reply` 改内容 | 发布后继续补充而不撤回 | knowledge-workbench.js:90 | 已审核内容未经审核被改 |
| `R-EXPD-06` | 同一个 `store` 实例上，同一个 id 的 `update` 串行执行 | 两个 `reply` 同时读到同一份旧记录、各自落盘 | knowledge-store.js:56-68 | 后写覆盖前写，丢一轮内容（两个 store 指向同一目录时真会发生，见 11.4 命令七） |
| `R-EXPD-07` | 同一 id 上整理台的四个写方法互斥（`reply` / `defer` / `publish` / `withdraw`） | `reply` 与 `publish` 并发 | knowledge-workbench.js:38、70、86、146 | 发布与整理交叉，发布状态被后到的整理盖掉 |
| `R-EXPD-08` | 写盘要么完整可见要么不可见 | 直接往正式文件名写 | knowledge-store.js:20-27 | 读盘读到半个 JSON |
| `R-EXPD-09` | 发布记录的 `review.expires_at` 晚于发布时间，且不晚于发布后 366 天 | 复核日期选过去 | knowledge-workbench.js:48-52 | 刚发布就过期，永远检索不到 |
| `R-EXPD-10` | `last_error` 只在失败轮写，成功轮置 `null` | 成功后还留着上一轮的错 | knowledge-workbench.js:128、136 | 调用方误判「这轮也没成」 |
| `R-EXPD-11` | 撤回不删 `review`，也不改 `fields` | 撤回把审核信息清掉 | knowledge-workbench.js:69-80 | 审核痕迹丢失；下次发布时 `review` 被整体替换（knowledge-workbench.js:61） |

## 9 失败面

| 失败模式 | 表现 | 错误类型 / `status` | 失败后系统状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- | --- |
| id 不是 UUID 形状 | 抛「候选经验 ID 无效」 | `Error` / `400` | 不读写文件 | 换合法 id | 无 |
| 记录不存在 | 抛「候选经验不存在」 | `Error` / `404` | 不写盘 | 换 id | 无 |
| 输入为空 / 全空白 / 超 4000 字 / 含 NUL | 抛「每次输入必须为 1 到 4000 字」 | `Error` / `400` | 不写盘，连用户消息也不存 | 改输入 | 无 |
| 已发布还调 `reply` | 抛「已发布经验请先撤回再补充」 | `Error` / `409` | 不写盘 | 先撤回 | 无 |
| 消息数已达 80 | 抛「当前对话已达到上限，请新建一条经验」 | `Error` / `400` | 不写盘 | 新建记录 | 无 |
| 同一整理台实例上，同一 id 已有操作在跑 | 抛「上一轮整理仍在进行，请稍后再试」 | `Error` / `409` | 不写盘 | 稍后重试 | 无 |
| 没传模型 / 模型抛错 / 返回非 JSON / 返回不是对象 | `last_error` 记一条短消息（≤ 240 字），追加一条助手消息 | 不抛错，靠 `last_error` 表达 | 用户原话已落盘，字段与状态不变 | 下一轮继续输入 | 人工先看原话 |
| `promptStore.load()` 抛错或返回体缺 `prompts.knowledge` | 同上一行（同一个 `try`） | 不抛错，靠 `last_error` | 同上 | 修提示词后再试 | 同上 |
| 发布表单四类校验不过 | 抛对应消息（类型 / 说明 / 结论 / 日期） | `Error` / `400` | 不写盘 | 改参数 | 无 |
| 发布时状态不是 `ready_for_review` 或字段不齐 | 抛「候选经验尚未达到人工审核标准」 | `Error` / `409` | 不写盘 | 补齐字段后重试 | 无 |
| 撤回时记录未发布 | 抛「经验未发布」 | `Error` / `409` | 不写盘 | — | 无 |
| `defer` 字段名不属九项 | 抛「待补充字段无效」 | `Error` / `400` | 不写盘 | 传表内的键 | 无 |
| `defer` 的字段不是当前问题 | 抛「当前问题已变化，请刷新候选经验」 | `Error` / `409` | 不写盘 | 重新 `get` 拿 `next_field` | 无 |
| 目录里有 36 位「非 UUID」文件名（例：36 个连字符） | `list()` / `publishedFor()` 整体抛错 | `Error` / `400` | 其它记录不受损，但列表读不出来 | 清掉那个文件 | 无 |
| JSON 文件内容损坏 | `get()` 抛 `SyntaxError`；`list()` 也会跟着 reject（`get` 只吞 ENOENT，且 `list` 用 `Promise.all` 直接上抛） | `SyntaxError` | 文件不动 | 修好或删掉那个文件 | 无 |
| 已发布记录过期 | 不入结果，不报错 | — | 文件不动 | — | 当作没有这条经验 |

两点补充：

- **模型失败的失败面是「不丢输入」**。`reply` 先落用户原话，再调模型；模型那一步的任何异常都被内层 `catch`
  转成 `last_error` + 一条助手消息，记录本身保留且状态不变（knowledge-workbench.js:89、134-140）。
- **并发保护有两层，覆盖范围不同**：整理台的 `active` 集合挡「同一个实例上的同 id 操作」
  （knowledge-workbench.js:31、38、70、86、146）；存储层的按 id 队列挡「同一个 store 上的同 id 写」
  （knowledge-store.js:57-66）。两个 `KnowledgeWorkbench` 共享一个 store 时，后到的发布拿到 `409`；
  但两个 `KnowledgeStore` 指向同一目录时，两层都失效——实测两次发布都返回成功，盘上留下后写的那份
  （第 11.4 节命令七）。

## 10 资源与限额

| 项 | 数值 / 现状 | 依据 |
| --- | --- | --- |
| 单条客户输入 | 1 到 4000 字（含首尾空白仍算非空）；不能含 NUL | knowledge-workbench.js:83 |
| 一条对话的消息数上限 | 拒收门槛：已有 80 条就拒新输入；因为一轮会加「用户一条 + 助手一条」，实测从 79 条起再收一轮后为 81 条 | knowledge-workbench.js:91 |
| 字段 `value` / `source_quote` | 各 1000 字（先截断再判长度） | knowledge-workbench.js:111-112 |
| 本轮归纳 `summary` | 700 字 | knowledge-workbench.js:120 |
| `last_error` | 240 字 | knowledge-workbench.js:136 |
| 标题 | 32 字 | knowledge-workbench.js:130 |
| 审核说明 `note` | 500 字（下限 5 字，去空白后算） | knowledge-workbench.js:42 |
| 进模型的对话条数 | 最近 24 条用户原话（不含 `kind: 'defer'`） | knowledge-workbench.js:98-99、103 |
| `publishedFor` 的抽样规模 | 先取倒序前 20 条，再过滤过期，最后返最多 8 条 | knowledge-store.js:52-53 |
| `list()` 的读盘次数 | 目录里每个 `<36 位十六进制与连字符>.json` 读一次 | knowledge-store.js:42-43 |
| 写队列 | 每个 id 一条链；没有长度上限，也不设超时 | knowledge-store.js:57-66 |
| 模型调用次数 | 一轮整理只调一次 | knowledge-workbench.js:104 |

两个文件里**没有超时控制、没有重试、没有限流**：模型调用与文件读写都是直接 `await`，
失败就落到第 9 节那两张表里的分支。超时只能靠传进来的模型客户端自己管（knowledge-workbench.js:31）。

数据体积由调用方决定：本模块不限制一个目录里能放多少条记录，也不清理过期记录
（两个文件没有删除方法，见第 2 节）。

## 11 值语义与怎么验

### 11.1 值语义

| 值 | 出现在 | 类型与格式 | 单位 | 空值 / 异常含义 |
| --- | --- | --- | --- | --- |
| `status` | 记录顶层 | 四个枚举字符串之一（见 4.1） | 无 | 不会为空；其它值不会出现 |
| `missing` | 记录顶层 | 字段键数组，顺序同表头 | 个（字段数） | 空数组 = 九项已齐 |
| `deferred_fields` | 记录顶层 | 字段键数组，去重 | 个 | 空数组 = 没有延后项（已补上的会自动消失，knowledge-workbench.js:117） |
| `next_field` | 记录顶层 | 九项键之一或 `null` | 无 | `null` = 当前没有要问的（已是 `ready_for_review` 或缺口全延后） |
| `fields[key].value` | 记录 | 字符串，≤ 1000 字 | 字 | 没采纳过的键就不存在 |
| `fields[key].source_quote` | 记录 | 字符串，≤ 1000 字，是客户原话的连续片段 | 字 | 同上；必须能在某条用户消息里找到 |
| `title` | 记录顶层 | 字符串，≤ 32 字 | 字 | 没有 `behavior` 与 `record_ref` 时是「新建研判经验」 |
| `last_error` | 记录顶层 | 字符串，≤ 240 字；成功轮为 `null`；从未失败过时不存在 | 字 | `null` = 上一轮整理成功 |
| `review.valid_until` | `review` | `YYYY-MM-DD`，原样存输入值 | 日 | 只有 `published` 才有 `review`；撤回不删 |
| `review.expires_at` | `review` | ISO 8601 时刻，当天 `23:59:59+08:00` | 毫秒级 ISO | `publishedFor` 拿它与「现在」比大小 |
| `review.verdict` | `review` | `threat` / `uncertain` / `false_positive` | 无 | 缺省 `false_positive`（knowledge-workbench.js:37） |
| `scenario_id` | 记录顶层 | `eventTypes` 的键或 `null` | 无 | 未发布时不存在这个字段；撤回后是 `null` |
| `id` | 记录顶层与文件名 | 带连字符的 UUID | 无 | 形状不对 → `400`（knowledge-store.js:5、11） |

### 11.2 怎么验（可复跑命令）

以下六条都在本仓根目录跑，临时数据都落在 `/tmp`，不写工作树。命令输出就是本页断言的证据。

**命令一：九项字段的清单与顺序**

```bash
node --input-type=module -e "
import { knowledgeFields } from './knowledge-workbench.js';
console.log('字段数:', knowledgeFields.length);
console.log(knowledgeFields.map(([key]) => key).join(','));
"
```

```
字段数: 9
record_ref,customer_scope,subject_scope,behavior,reason,supporting_evidence,applicability,counterexample,validity
```

**命令二：一轮整理的采纳门槛**（编造引用与整串未答词都进不了库）

```bash
rm -rf /tmp/ed-demo && node --input-type=module -e "
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench } from './knowledge-workbench.js';
const store = new KnowledgeStore('/tmp/ed-demo');
const model = { complete: async () => ({ content: JSON.stringify({ fields: {
  record_ref: { value: '蜜罐 7', source_quote: '蜜罐 7' },
  reason: { value: '属于运维扫描', source_quote: '运维扫描' },
  supporting_evidence: { value: '已有工单', source_quote: '不存在的工单' },
  customer_scope: { value: '不知道', source_quote: '不知道' }
}, summary: '已记录。' }) }) };
const wb = new KnowledgeWorkbench(store, model, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const rec = await wb.create();
const one = await wb.reply(rec.id, '蜜罐 7 是运维扫描，所以我认为是误报。');
console.log('状态:', one.status, '| 采纳:', Object.keys(one.fields).join(','), '| 下一个问题:', one.next_field);
console.log('编造引用是否入库:', 'supporting_evidence' in one.fields, '| 未答词是否入库:', 'customer_scope' in one.fields);
"
```

```
状态: needs_info | 采纳: record_ref,reason | 下一个问题: customer_scope
编造引用是否入库: false | 未答词是否入库: false
```

**命令三：未答词只整串匹配**

```bash
rm -rf /tmp/ed-quote && node --input-type=module -e "
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench } from './knowledge-workbench.js';
const store = new KnowledgeStore('/tmp/ed-quote');
let calls = 0;
const model = { complete: async () => ({ content: JSON.stringify(calls++ === 0
  ? { fields: { reason: { value: '不知道 ID，但这是例行巡检', source_quote: '不知道 ID' } }, summary: '' }
  : { fields: { record_ref: { value: '不知道', source_quote: '不知道' } }, summary: '' }) }) };
const wb = new KnowledgeWorkbench(store, model, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const rec = await wb.create();
const one = await wb.reply(rec.id, '不知道 ID，但这是例行巡检。');
const two = await wb.reply(rec.id, '不知道。');
console.log('「不知道 ID，但这是例行巡检」采纳:', one.fields.reason?.value);
console.log('「不知道」采纳:', 'record_ref' in two.fields);
"
```

```
「不知道 ID，但这是例行巡检」采纳: 不知道 ID，但这是例行巡检
「不知道」采纳: false
```

### 11.3 命令四：发布边界、检索与撤回

先把一条记录直接推到 `ready_for_review`（绕过对话），再试发布。

```bash
rm -rf /tmp/ed-publish && node --input-type=module -e "
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench, knowledgeFields } from './knowledge-workbench.js';
const store = new KnowledgeStore('/tmp/ed-publish');
const wb = new KnowledgeWorkbench(store, null, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const rec = await store.create();
await store.update(rec.id, current => {
  current.status = 'ready_for_review';
  current.fields = Object.fromEntries(knowledgeFields.map(([k]) => [k, { value: '值', source_quote: '值' }]));
  return current;
});
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
try { await wb.publish(rec.id, { scenario_id: 'webshell', note: '审核说明文字', valid_until: day(366) }); }
catch (e) { console.log('第 366 天: status=' + e.status, e.message); }
const pub = await wb.publish(rec.id, { scenario_id: 'webshell', note: '  运维确认误报  ', valid_until: day(365) });
console.log('第 365 天: status=' + pub.status, '| review.note=' + pub.review.note, '| expires_at=' + pub.review.expires_at);
console.log('publishedFor(webshell):', (await store.publishedFor('webshell')).length, '| publishedFor(honeypot):', (await store.publishedFor('honeypot')).length);
console.log('已发布再补充:', await wb.reply(rec.id, '再补一句').catch(e => 'status=' + e.status + ' ' + e.message));
const back = await wb.withdraw(rec.id);
console.log('撤回: status=' + back.status, '| scenario_id=' + back.scenario_id, '| review 还在=' + !!back.review);
console.log('撤回后再撤回:', await wb.withdraw(rec.id).catch(e => 'status=' + e.status + ' ' + e.message));
console.log('撤回后 publishedFor:', (await store.publishedFor('webshell')).length);
"
```

```
第 366 天: status=400 请选择未来一年内的复核截止日期
第 365 天: status=published | review.note=运维确认误报 | expires_at=2027-11-17T15:59:59.000Z
publishedFor(webshell): 1 | publishedFor(honeypot): 0
已发布再补充: status=409 已发布经验请先撤回再补充
撤回: status=ready_for_review | scenario_id=null | review 还在=true
撤回后再撤回: status=409 经验未发布
撤回后 publishedFor: 0
```

### 11.4 命令五到七：列表、消息上限、跨实例并发

**命令五：36 位「非 UUID」文件名会让列表读不出来**

```bash
rm -rf /tmp/ed-list && node --input-type=module -e "
import { KnowledgeStore } from './knowledge-store.js';
import { writeFile } from 'node:fs/promises';
const store = new KnowledgeStore('/tmp/ed-list');
console.log('空目录:', JSON.stringify(await store.list()));
await store.create();
console.log('一条记录:', (await store.list()).length);
await writeFile('/tmp/ed-list/------------------------------------.json', '{}');
console.log('混入 36 个连字符的文件名:', await store.list().then(r => 'ok ' + r.length).catch(e => 'status=' + e.status + ' ' + e.message));
"
```

```
空目录: []
一条记录: 1
混入 36 个连字符的文件名: status=400 候选经验 ID 无效
```

**命令六：消息上限的准确位置**

```bash
rm -rf /tmp/ed-limit && node --input-type=module -e "
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench } from './knowledge-workbench.js';
const store = new KnowledgeStore('/tmp/ed-limit');
const wb = new KnowledgeWorkbench(store, null, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const rec = await store.create();
await store.update(rec.id, current => { current.messages = Array.from({ length: 79 }, (_, i) => ({ role: 'user', content: 'm' + i, at: current.created_at })); return current; });
const one = await wb.reply(rec.id, '再补一条。');
const two = await wb.reply(rec.id, '再补一条。').catch(e => e);
console.log('从 79 条起收一轮后:', one.messages.length, '| 紧接着再收:', two.status, two.message);
"
```

```
从 79 条起收一轮后: 81 | 紧接着再收: 400 当前对话已达到上限，请新建一条经验
```

**命令七：跨实例并发发布的边界**（两段：共享一个 store / 两个 store 指同一目录）

```bash
rm -rf /tmp/ed-race && node --input-type=module -e "
import { KnowledgeStore } from './knowledge-store.js';
import { KnowledgeWorkbench, knowledgeFields } from './knowledge-workbench.js';
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const note = n => n + '号审核说明文字';
const ready = async store => { const rec = await store.create(); await store.update(rec.id, current => { current.status = 'ready_for_review'; current.fields = Object.fromEntries(knowledgeFields.map(([k]) => [k, { value: '值', source_quote: '值' }])); return current; }); return rec.id; };
const shared = new KnowledgeStore('/tmp/ed-race');
const a = new KnowledgeWorkbench(shared, null, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const b = new KnowledgeWorkbench(shared, null, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const id1 = await ready(shared);
const r1 = await Promise.all([a.publish(id1, { scenario_id: 'webshell', note: note(1), valid_until: day(10) }).then(() => 'ok').catch(e => 'status=' + e.status), b.publish(id1, { scenario_id: 'webshell', note: note(2), valid_until: day(10) }).then(() => 'ok').catch(e => 'status=' + e.status)]);
console.log('共享 store 并发发布:', r1.join(' / '));
const s1 = new KnowledgeStore('/tmp/ed-race');
const s2 = new KnowledgeStore('/tmp/ed-race');
const w1 = new KnowledgeWorkbench(s1, null, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const w2 = new KnowledgeWorkbench(s2, null, { load: async () => ({ prompts: { knowledge: '整理' } }) });
const id2 = await ready(s1);
const r2 = await Promise.all([w1.publish(id2, { scenario_id: 'webshell', note: note(1), valid_until: day(10) }).then(() => 'ok').catch(e => 'status=' + e.status), w2.publish(id2, { scenario_id: 'webshell', note: note(2), valid_until: day(10) }).then(() => 'ok').catch(e => 'status=' + e.status)]);
console.log('两个 store 同目录并发发布:', r2.join(' / '), '| 盘上 review.note:', (await s1.get(id2)).review.note);
"
```

```
共享 store 并发发布: ok / status=409
两个 store 同目录并发发布: ok / ok | 盘上 review.note: 2号审核说明文字
```

命令四里发布用的 `scenario_id: 'webshell'` 是事件类型表里的一个键；那份表定义在 `cloudwalker.js`，
不在本页证据范围（见第 12 节），这里只用它构造一个合法入参。

## 12 缺口与未决

| 没查到的 | 为什么查不到 | 影响 |
| --- | --- | --- |
| `eventTypes` 表的键名与显示名 | 表定义在 `cloudwalker.js`；本卡证据源只限两个实现文件（`knowledge-workbench.js:1` 只能证明它被引入） | 5.3 的类型显示名与 11.3、11.4 命令里的 `webshell` 只能按「表里的一个键」描述 |
| 生产环境里谁调用这两个文件 | `server.js` 的 import 列表里没有它们（架构篇第 4 节末、第 13 节第 2 条记的是同一件事）；本页不引用测试文件的行号 | 本页只能说到「没接进业务进程」，说不到调用方契约 |
| HTTP 路由与请求体字段名 | 两个实现文件里没有路由代码（方法清单见第 3 节） | 不能给接口契约；想做接口得先把接入层做出来 |
| 过期 `published` 记录的产生路径 | `publish` 拒绝过去日期（knowledge-workbench.js:48-52），本卡没找到合法的造出法 | 「过期不返回」只有代码依据（knowledge-store.js:53），没有端到端实测 |
| 同一毫秒更新的多条记录的返回顺序 | 实测 10 条同时发布的记录，`publishedFor` 返回 8 条，但不是最新 8 条（返回的 id 序号是 1,3,4,5,6,7,8,9）；`updated_at` 相同，顺序取决于 `readdir` | 「前 20 条 / 前 8 条」在同时刻写入的场景下不保证是「最新 8 条」 |
| 模型输出质量与 `source_quote` 准确率 | 需要真实模型服务与牧云原始数据 | 本页只写门槛（子串校验），不写准确率 |
| `knowledge-*` 与 `wiki-*` 两套知识库的先后关系 | 架构篇 [\_meta/gaps.md](../_meta/gaps.md) 第二节已记为「没查到」；跨模块对照超出本页证据源 | 本页不判断哪套是现行实现 |

本仓没有 `docs/contexts/` 下的单元页，所以本页的公开面只能按两个文件的 `文件:行号` 描述，没有更细的单元页可链。
全局缺口台账是 [../_meta/gaps.md](../_meta/gaps.md)；本卡可写范围里没有那个文件，上面七条没有登记进去。

## 13 指针

- [架构篇](../architecture.md)：第 4 节末「另一个同名但不相干的东西」、第 12 节模块清单里的 `experience-draft` 行、第 13 节第 2 条
- [模块清单](_breakdown.json)：本模块的 `name` / `doc` / `files` / `components`
- [已知边界](../_meta/gaps.md)：第二节记了「一套模块只被测试引用」
- [侦察与复现记录](../../evidence/recon/P001-T015.md)：本页每个锚点的源码摘录、七条命令的原始跑法与输出
- [首页索引](../index.md)：文档全图
