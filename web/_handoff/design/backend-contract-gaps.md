# 后端契约缺口记录

记录当前 OpenAPI 文档中没有定义、但前端页面需要使用的数据结构。仅记录事实，不代表对后端的要求。

---

## 1. 文档未定义内部结构的字段

| 位置 | 文档写法 | 前端无法确定的内容 |
| --- | --- | --- |
| `TriageCase.steps[]` | 元素为 `object`，无 properties | 步骤名称、工具、耗时、输入输出、状态字段名 |
| `Investigation.verdict.claims[]` | 元素为 `object`，无 properties | 依据文本、置信度、是否已验证、引用的证据 ID |
| `Investigation.required_evidence[]` | 元素为 `object`，无 properties | 证据分类、要求描述、是否已具备、关联证据 |
| `Investigation.review` | `object`，无 properties | 复核人、复核时间、复核结论、备注 |
| `Investigation.validation` | `object`，无 properties | 通过项、缺口数、核验时间 |
| `Investigation.trace[]` | 元素为 `object`，无 properties | 调查轨迹的字段含义 |
| `Alert.detail` | `object`，无 properties | 每种事件类型的原始字段（进程、网络、文件、账号、日志源） |
| `TraceBoard.nodes[]` | 元素为 `object`，无 properties | 节点类型、标识、显示名、属性 |
| `TraceBoard.edges[]` | 元素为 `object`，无 properties | 边类型、起点、终点、时间 |
| `TraceBoard.activity[]` | 元素为 `object`，无 properties | 活动记录字段 |

前端对这些对象目前只做“按实际 key 原样渲染”，不假设字段名；字段为空时不显示对应区块。

---

## 2. 可能为空的字段

文档允许以下字段为 `null`，界面需显示「—」或空态：

- `Alert.createdAt`、`Alert.assetIp`、`Alert.hostId`、`Alert.verdict`
- `TriageCase.verdict_label`、`TriageCase.report`、`TriageCase.matched_alert_id`
- `TriageSummary.last_poll_at`、`TriageSummary.last_error`
- `Overview.alerts.totals` 中每种类型的值（部分失败时为 `null`）
- `Investigation.saved_at`（示例中未标 required）
- `TraceBoard.summary`、`TraceBoard.gaps`

---

## 3. 没有对应接口的能力

- 证据条目级数据：文档只有 `verified_facts`、`evidence_sources` 两个数量，没有单条证据、分类或来源明细。
- 未匹配牧云事件的 Syslog 案件列表：`/api/agent/triage/cases` 可以返回，但告警列表不包含这类记录，没有单独视图入口。
- 告警列表的服务端筛选、排序、时间范围：`GET /api/alerts` 仅接受 `count`、`offset`。
- 列表与详情的关联跳转：`Alert.triage` 内只有状态类字段，没有指向案件详情的链接；反过来 `TriageCase.matched_alert_id` 可以拼出告警详情地址。
- 会话用户信息：`/api/session` 只返回 `authenticated`，没有用户名、角色；界面上的账号名是示例。
- 版本号：需要从 `/api/updates.revision` 获取，登录页与总览目前为示例值。

---

## 4. 语义注意

- `Alert.verdict` 是原始列表占位值，文档注明“未承载常规研判结论”；结论应读取 `triage.verdict_label`。
- `TriageCase.alert_id` 是 Syslog 案件 ID，可能与 `Alert.id` 不同；只有 `matched_alert_id` 才是牧云事件 ID。
- 结论枚举只有 `真实威胁 / 存疑 / 误报`；`null` 表示尚未产生结论，界面显示「未研判」，不新增枚举值。
- 研判状态只有 `not_queued / queued / running / done / failed`，界面文案是这五个值的中文映射。

---

## 5. 当前处理方式

- 列表：只读 `alert.triage?.status / verdict_label / verified_facts / evidence_sources`，为空显示「未研判」「—」。
- 详情：`steps`、`claims`、`required_evidence`、`review`、`validation` 按返回对象的 key 渲染；`detail` 按 key 分组渲染；没有数据则隐藏区块。
- 证据：只显示数量，不显示前端编造的分类与条目。
- 关联实体：未取 `TraceBoard` 时不显示该区块。

---

## 6. 知识库

- `GET /api/wiki/pages` 返回 `pages[]`，元素为 `WikiPageSummary`（`id`、`path`、`title`、`status`），允许附加字段但没有定义任何附加字段；没有标签、更新时间、作者字段。
- `GET /api/wiki/pages/{pagePath}` 返回自由对象，正文字段名未定义，也没有说明是 Markdown 还是结构化内容。
- 没有更新页面的接口。页面内容只能通过知识维护会话（`POST /api/wiki/sessions` → 消息 / 重放 / 发布）产生，草稿须人工审核才能发布。
- `status` 是字符串，文档未给枚举，界面按原文展示，不做中文映射。
- 有查询词时最多返回 50 条，未查询时的上限文档未写，因此不知道目录是否需要分页。
- `/api/wiki/health` 返回自由对象，字段未定义，界面未接入。
- 当前处理：目录与元信息取接口字段；正文与标签作为本地草稿存在浏览器里，界面明确标注「本地草稿」，不声称已写回服务端。
