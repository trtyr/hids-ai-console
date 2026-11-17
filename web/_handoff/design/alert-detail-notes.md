# 告警详情页设计稿 · 开发交接说明

对应文件：`alert-detail.html`
入口：`alerts.html` 右侧抽屉底部「查看完整详情」，链接形如 `alert-detail.html?id=revshell%3A1`

---

## 1. 页面职责

一屏多一点看完一条告警：结论、依据、缺口、步骤、证据，以及原始数据和关联实体。左栏读结论与依据，右栏看过程与证据，低频的原始数据折叠在页面底部。

---

## 2. 结构

```
顶栏：← 告警列表 · 告警 ID ｜ 复制 ID · 刷新
头部：等级 · 类型 · 状态 ／ 操作
     标题
     资产 · IP · 时间 · 事件 ID · 主机 ID · Syslog 案件
     概况条：事实 / 来源 / 依据通过 / 缺口 / 任务状态 / 研判模式
正文两栏：
  左：研判结论（结论 + 摘要 + 报告）
      结论依据
      缺失证据 ｜ 所需证据（并排）
  右：研判步骤（时间、工具、结果、耗时）
      证据来源（分组折叠）
通栏：
  核验与复核（左：核验数据；右：复核人与备注）
  关联实体（横排）
  原始事件（默认收起；展开后按事件 / 进程 / 网络 / 文件 / 账号 / 日志源分组，并附原始 JSON）
```

### 为什么这样排

上一版是单列九段，页面接近三屏，必须一直滚。这一版：

- 删掉页内锚点导航——页面短了，不再需要；
- 头部把状态、操作、元信息压进三行，概况条用一格一指标替代右栏列表；
- 主体改双栏，依据与步骤并行，纵向长度大约减半；
- 缺失证据与所需证据并排，核验与复核通栏横排；
- 原始事件与原始 JSON 默认折叠，需要时再展开；
- 证据分组默认收起，只显示分组名与条数。

---

## 3. 数据映射

| 界面元素 | 接口字段 |
| --- | --- |
| 标题、资产、IP、等级、时间 | `alert` 对象 |
| 事件 ID / 主机 ID / 场景 | `eventId`、`hostId`、`scenario` |
| 概况条 | `triage.verified_facts`、`triage.evidence_sources`、`investigation.validation`、`triage.status`、`investigation.mode` |
| 结论与报告 | `triage.verdict_label`、`triage.report`；深层用 `investigation.verdict.report` |
| 摘要 | `investigation.verdict.summary` |
| 依据 | `investigation.verdict.claims[]` |
| 缺失证据 | `investigation.verdict.missing_evidence[]` |
| 所需证据 | `investigation.required_evidence[]` |
| 步骤 | `triage.steps[]`、`triage.stage`（工具名与耗时需后端在 steps 中给出） |
| 证据 | `triage.verified_facts`、`triage.evidence_sources`；条目级数据待补 |
| 核验 / 复核 | `investigation.validation`、`investigation.review` |
| 原始事件 | `GET /api/alerts/{alertId}` 的 `detail` |
| 关联实体 | `TraceBoard.nodes` |
| 关联标识 | `triage.alert_id`、`triage.matched_alert_id` |
| 加入队列 / 重判 | `POST /api/agent/triage/{alertId}` |

示例覆盖四种状态：`revshell:1`（真实威胁、已复核）、`webshell:42`（真实威胁）、`brute_force:128`（存疑、复核维持）、`suspicious_operation:31`（待研判）。报告、依据、证据条目、复核备注为示例文案；原始事件与实体按 `detail`、`TraceBoard.nodes` 的结构编排。

---

## 4. 交互与状态

| 状态 | 触发方式 | 呈现 |
| --- | --- | --- |
| 默认 | 打开链接 | 按 `?id=` 渲染；缺省展示 `revshell:1` |
| ID 不存在 | 链接里的 ID 不在数据中 | 隐藏正文，显示未找到与返回链接 |
| 加入队列 / 重判 | 头部主按钮 | 状态、概况条、按钮文案同步；待研判补上「加入队列」步骤；读屏播报 |
| 深度溯源 | 头部次要按钮 | 跳转 `trace.html?target=<告警 ID>` |
| 复制 ID | 顶栏按钮 | 写剪贴板，失败时提示手动选择 |
| 刷新 | 顶栏按钮 | 重新渲染示例数据 |
| 证据 / 原始事件 / JSON | 点击标题 | 原生 `details` 展开收起 |

### 已知限制

- 返回列表是普通链接，会丢失列表筛选与页码。
- 「刷新」只重渲染示例数据，不代表重新请求。
- 加入队列只切换本地状态，未模拟 SSE 进度。
- 证据条目级数据与复核字段在接口中暂无严格定义，示例按扩展字段展示。

---

## 5. 响应式

- ≥ 1100px：双栏，概况条 6 列
- ≤ 1100px：概况条 3 列，两栏间距收窄
- ≤ 900px：正文单栏，步骤与证据顺序落到结论之后
- ≤ 620px：概况条 2 列；缺失证据与所需证据上下排列；核验与复核上下排列；原始事件键值对单列
- 无横向滚动

---

## 6. 后续待补

- 深度溯源已接入 `trace.html`，带告警 ID 跳转；关系图待节点 / 关系字段定义。
- 证据条目级接口与复核字段的正式定义。
- SSE 实时进度，替换本地状态切换。
- 返回列表保留筛选与页码。
- 「导出报告 / 创建复盘」入口（`/api/wiki/sessions`）。

---

## 7. 主题

深色为默认，顶栏右侧可切换浅色，选择会记忆。颜色统一由 `assets/theme.css` 提供；步骤、核验、证据等状态色两套均重新核算，详见 `theme-notes.md`。

---

## 8. 待对接说明

本页当前仍按示例结构渲染 `claims`、`required_evidence`、`validation`、`review`、`steps`、`detail` 等自由对象；这些结构的字段名尚未由接口定义，联调时需改为按后端实际返回的 key 渲染，证据分类与关联实体不再由前端编造。详见 `backend-contract-gaps.md`。
