# web/ · HIDS AI 研判平台前端（壳与登录）

这个目录是本仓的前端：原生 ESM + 静态资源，没有 UI 框架、没有构建步骤。
设计稿只作参考（`~/.plantree/hids-ai-console/plans/002-frontend/decisions/D002.md`），接口以本仓 API 为准。

当前覆盖：**登录页 + 登录后的导航壳**（P002-T001）。五个页面本体（总览 / 告警 / 溯源 / 规则 / 知识库）
还是占位，分别在 P002-T002…T007 里接。

## 1. 怎么起

```bash
# 1) 后端（Basic 认证打开，才有真实的 401 可测）
HIDS_BASIC_AUTH_USER=hids HIDS_BASIC_AUTH_PASSWORD=hids-2026 HIDS_PORT=19880 node server.js

# 2) 前端（静态服务 + /api 反代）
HIDS_API_ORIGIN=http://127.0.0.1:19880 HIDS_WEB_PORT=13300 node web/serve.js
# 打开 http://127.0.0.1:13300/
```

- `web/serve.js` 只做两件事：给 `web/` 里的静态文件、把 `/api/*` 原样反代到 `HIDS_API_ORIGIN`（默认 `http://127.0.0.1:8080`）。
  需要反代是因为：`server.js` 不提供静态文件，也没有 CORS 头（`server.js:53-56`），页面直连 8080 会被浏览器拦。
- **它不许被一条请求打死**（A1 的载体就是它）。返回码就这么几张，`web/test/serve.test.js` 逐条钉着：

  | 情况 | 返回 |
  | --- | --- |
  | 正常路径 | 200 + 按扩展名的 MIME（`.woff2` / `.js` / `.css` / `.html` / `.json` / `.svg`） |
  | 畸形百分号编码（`/%zz`、`/%`、半截 UTF-8） | **400**「请求路径无效」，服务继续接客（不是进程退出） |
  | `..` 越界（含 `%2f` 编码） | 403「禁止访问」 |
  | 文件不存在 | 404「找不到文件」 |
  | `/_handoff/*`（交接件：设计稿副本、设计期契约快照、zip） | **404**——交接件不进产品资源 |
  | `/api/*` 后端连不上 | 502「后端不可达」，页面据此显示「服务异常」 |
  | 处理中意外异常 | 500「服务内部错误」，响应已发出则断开连接 |

- 请求处理抽成了 `createHandler({ webRoot?, apiOrigin? })`（`web/serve.js:102`），`node web/serve.js` 才真正 listen（`:118`）；
  单测直接把它挂到临时端口上，不占固定端口。
- 端口被占就换 `HIDS_PORT` / `HIDS_WEB_PORT`，两个都要换（反代跟着 `HIDS_API_ORIGIN` 走）。
- 单测：`cd web && npm install && npm test`（`node --test`，jsdom 只给单测用；`serve.js` 的用例起在临时端口上，不需要先起服务）。
  仓根 `npm test` 也会跑到 `web/test/*.test.js`（`node --test` 递归发现），结果一致。

## 2. 数据来源：形态 B（对接已就绪后端）

只用一个接口，字段逐字照文档：

| 项 | 值 | 出处 |
| --- | --- | --- |
| operation | `GET /api/session`（`getSession`，无参数） | `openapi.yaml:26-41`，实现 `server.js:134` |
| 成功体 | `{ "authenticated": true }`——**只有这一个字段** | `openapi.yaml:32-40` |
| 失败体 | `401`，正文是纯文本「需要登录后访问」，带 `WWW-Authenticate: Basic`（**不是 JSON**） | `server.js:70-74` |
| 鉴权 | HTTP Basic，**每个请求**都校验 | `server.js:58-68`、`:130` |

由此定的三条口径：

1. **登录＝拿表单里的账号密码打 `GET /api/session`**。200 → 进壳；401 → 卡片内错误横幅；连不上 → 网络提示。
   没有任何写死的演示账号（稿里的 `hids / hids-2026` 与 `DEMO` 常量没有搬进代码）。
2. **凭据只放内存**（`web/src/credentials.js`）：不落 `localStorage` / `sessionStorage`。
   代价是刷新页面要重新登录，这是有意的——本仓没有 token 机制，Basic 凭据落盘等于把密码留在浏览器里。
3. **401 正文不解析**：状态码即结论（账号或密码不对），不把服务端正文直接甩到界面上。

### adapter 契约（唯一发 HTTP 的地方）

`web/src/session.js` —— `adapter 之外出现 fetch 即缺陷`。

```js
probeSession(credentials, options?) → Promise<{ authenticated: true }>
// credentials: { user: string, password: string }
// options: { fetchImpl?: typeof fetch, baseUrl?: string }   // 单测注入用
// 失败一律抛 SessionError：kind ∈ 'unauthorized' | 'http' | 'network' | 'invalid'，附 status（可能为 null）
```

| 场景 | HTTP | 结果 |
| --- | --- | --- |
| 凭据正确 | 200 `{authenticated:true}` | resolve `{ authenticated: true }` |
| 账号或密码错 | 401 | `SessionError{kind:'unauthorized', status:401}` |
| 服务异常 | 5xx / 其它非 2xx | `SessionError{kind:'http', status:<码>}` |
| 连不上 | fetch 抛 | `SessionError{kind:'network'}` |
| 200 但不是 JSON / `authenticated !== true` | 200 | `SessionError{kind:'invalid'}` |

## 3. 登录视图（`src/views/login.js`）

布局与文案来自设计稿 `index.html`：左右分栏，左品牌区（标识 + 立场文案 + 使用范围），右 396px 卡片。卡片里三个要素：标题「登录」、错误横幅、表单（账号 / 密码 / 显示密码 / 提交 / 帮助文案）。

### 状态矩阵

| 格 | 触发 | 界面 | 断言要点（可写成测试） |
| --- | --- | --- | --- |
| 默认（空态） | 打开页面 | 账号框自动获得焦点，提交按钮可用，文案「登录」，横幅隐藏 | `activeElement` 是账号输入框；`banner.hidden === true`；按钮 `disabled === false` |
| 字段校验 | 输入框失焦且为空 | 该字段下方红字 + `aria-invalid="true"`；填上即清 | 账号/密码各自有独立错误节点，`aria-describedby` 指过去 |
| 加载中（loading） | 提交且字段校验通过 | 按钮禁用、转圈出现、文案「正在登录…」、表单 `aria-busy="true"` | 加载中再提交不会发第二次请求 |
| 错误（error） | 401 | 卡片内红色横幅：标题「登录失败」，正文「账号或密码不正确。」；密码清空、焦点回密码框、按钮恢复 | 横幅 `role="alert"`；密码 `value === ''` |
| 网络异常 | fetch 失败 | **警示色**横幅：标题「无法连接」，正文「连不上研判服务，请检查网络或稍后重试。」 | 与 401 的文案/配色必须不同（不许把两种情况混成一句「失败」） |
| 服务异常 | 5xx | 红色横幅：「登录失败」+「服务返回异常（<码>），请稍后重试。」 | 文案里带状态码 |
| 超长输入 | 账号/密码很长（如 200 字） | 不截断、不限长，原样提交；布局不破 | 提交值 === 输入值 |
| 部分失败（partial） | — | **不适用**：登录只有一个整体结论，没有「部分数据」这种中间态 | 文档声明不适用即可，不要为它编状态 |

提交成功的去向：**直接进总览壳**（`#/overview`）。稿里的「会话已建立」摘要页（`#signed-view`）没有实现——`design-notes.md` §6.3 自己写明真实接线应直接进控制台。

### 交互与事件

| 动作 | 后果 |
| --- | --- |
| 提交（按钮 / 回车） | 先本地校验；不通过则聚焦第一个空字段且**不发请求**；通过则调 `onAuthenticate({user, password})`（账号去首尾空格，密码原样） |
| 「显示 / 隐藏」按钮 | 切换密码框 `type`，`aria-pressed` 同步，可访问名在「显示 / 隐藏」之间切换 |
| 失败后重试 | 直接改密码再提交；不必刷新 |

### 可访问性

- 表单字段有 `<label for>`；错误节点通过 `aria-describedby` 关联。
- 错误横幅 `role="alert"` + `aria-live="assertive"`。
- 提交按钮在加载中 `disabled`，文案变化可被读屏读到（按钮内文本，不是装饰）。
- 焦点路径：进页面 → 账号框；401 后 → 密码框；退出登录后 → 账号框。
- 对比度按设计稿 token（`docs` 不在本目录，数值在 `assets/theme.css`），浅深两套由 `theme.js` 切换。

## 4. 壳（`src/views/shell.js` + `src/router.js`）

结构照设计稿 `overview.html`：196px 侧栏（品牌 / 导航 / 底部动作）+ 52px 顶栏（页面标题 + 右侧主题按钮）+ 内容区。

### 路由表（`src/router.js`，顺序即侧栏顺序）

| hash | 侧栏文案 | 顶栏标题 | 页面模块 | 当前状态 |
| --- | --- | --- | --- | --- |
| `#/overview` | 总览 | 总览 | `pages/overview.js` | 占位（T002 接） |
| `#/alerts` | 告警 | 告警 | `pages/alerts.js` | 已接入（T003；详情页仍占位，T004 接） |
| `#/alert-detail/<alertId>` | —（不在侧栏） | 告警详情 | `pages/alert-detail.js` | 占位（T004 接），参数从第二段起原样传 |
| `#/trace` | 深度溯源 | 深度溯源 | `pages/trace.js` | 占位（T005 接） |
| `#/rules` | 规则 | 规则 | `pages/rules.js` | 占位（T006 接） |
| `#/knowledge` | 知识库 | 知识库 | `pages/knowledge.js` | 占位（T007 接） |

- 空 hash、`#/`、未知 id 一律回落到总览，不报错、不空白；回落时 `params` 为空数组。
- 导航项是 `<a href="#/…">`（真链接，键盘可达），当前项带 `aria-current="page"`，样式上 `.is-active`。
- 「退出登录」是 `<button>`（动作不是跳转），清空内存凭据、去掉 hash、回到登录页、焦点落账号框。

### 页面模块契约（T002–T007 照这个写，不动壳）

```js
// web/pages/<name>.js
export const page = {
  id: 'overview',            // 路由 id，也是 hash 第一段
  title: '总览',              // 顶栏标题
  navLabel: '总览',           // 侧栏文案；null = 不在侧栏（告警详情就是这样）
  render(content, { params }) {
    content.replaceChildren(/* 本页的 DOM */);
  },
};
```

- 加一页 = 新建 `web/pages/<name>.js` 并在 `web/src/router.js` 的 `PAGES` 里登记一行；壳、登录、别的页面都不用动。
- `render` 每次路由切换都会重跑，内容是整块替换——不要在模块顶层缓存上一次的 DOM。
- **一次路由切换只会调一次 `render`**（含登录成功后进壳那一下）：`app.js` 用 `history.replaceState` 落 hash，
  不用 `location.hash = …`（后者会再排一个 `hashchange`，把页面渲染两遍、真实页面会请求两轮）。回归用例 `web/test/app.test.js`。
- 页内取数走 `web/src/` 的 adapter（一个领域一个文件），**页面文件里不许出现 `fetch`**。
- 未接接口前一律用 `src/views/placeholder.js` 的占位，不放假表格假数字。

### A3：屏幕上的账号名与角色

会话接口只返回 `authenticated`，没有账号名、也没有角色（`openapi.yaml:32-40`）。
所以壳里**不渲染账号名与角色**——不编一个名字，也不拿登录框里输入的账号名充当身份。

- 侧栏底栏只有「退出登录」一个动作，没有头像 / 姓名 / 角色块。
- 断言方式：侧栏可见文本里不出现 `账号` / `角色` / `admin` 这类身份字样，也没有头像节点。
- 将来接口真的返回身份字段时，再按新字段加渲染分支，并在本文件记一行。

## 5. 占位页（`src/views/placeholder.js`）

每个未实现的页面渲染「<页面名>尚未接入 / 这一页还没有接后端接口。」，样式沿用设计稿的 `.placeholder`。
不放假表格、假数字、假按钮（D003）。

## 6. 样式来源

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `assets/theme.css` | 深/浅两套颜色 token 与切换按钮样式 | 设计稿 `assets/theme.css` **原样复制**，一个值没改 |
| `assets/theme.js` | 主题初始化、记忆、切换 | 设计稿 `assets/theme.js` **原样复制** |
| `assets/fonts/` | Space Grotesk / JetBrains Mono 本地子集 | 设计稿 `assets/fonts/` **原样复制** |
| `assets/app.css` | 登录页 + 壳的版式 | 设计稿 `index.html`、`overview.html` 的样式块合并；**颜色只用 `theme.css` 的变量**，本文件不新增色值 |

本仓在稿之上只加了四处（都在 `app.css` 里注明了原因）：

1. `body` 基准字号 13px（壳），登录视图 `.page` 覆写回 15px——单页应用里两个视图共存，稿是两个独立页面。
2. `button.nav-item` 的按钮化重置——「退出登录」用 `<button>` 而不是 `<a>`（语义），稿里 `.nav-item` 只写给 `<a>`。
3. `@media (max-width:900px)` 的 `.app { align-content: start }`——单列时两行会被拉伸填满 `100dvh`，把顶部条撑到 183px；按稿的渲染结果（实测 47px）钉住首行高度。
4. `@media (max-width:620px)` 的顶部条折两行（品牌 + 退出在上、导航独占一行）——稿在 ≤430px 时第 4、5 个导航入口被「退出登录」盖住、点不到，导航项必须可点（`D002`：稿不好用可以改交互）。
5. 去掉稿里没有搬过来的区块的样式（`.signed*` / `.enter` / `.ghost` / `.demo` / `.who` / `.avatar`）。

## 7. 目录

```
web/
  index.html            单页入口（登录 / 壳都渲染进 #root）
  serve.js              静态服务 + /api 反代
  assets/               theme.css / theme.js / fonts/ / app.css
  pages/                一页一个文件：overview / alerts / alert-detail / trace / rules / knowledge
  src/
    app.js              组装：登录 ↔ 壳、hash 路由、退出
    session.js          会话 adapter（唯一 HTTP 处）
    credentials.js      内存凭据 + Authorization 头
    router.js           页面登记表 + hash 解析
    views/login.js      登录视图（状态机在此）
    views/shell.js      壳视图（侧栏 / 顶栏 / 内容槽）
    views/placeholder.js 未接接口时的占位
  test/                 单测（node --test + jsdom）
  _handoff/             设计稿交接件（`handoff.md` + `design/` 原件），只读参考，不参与构建
```

## 8. 已知边界（这一版故意没做）

- 五个页面本体：T002–T007。占位页不假装有数据。
- 客户端频率限制 / 冷却（稿 §3 的「3 次失败锁 30 秒」是演示值）：后端没有对应策略，前端不自己发明一条假规则。
- 登录页底部的版本号（稿取 `/api/updates.revision`）：该接口也要鉴权，登录前拿不到；本卡验收不涉及，先不显示。
- 维护端：设计稿写明是独立入口，本目录不管。
- 凭据不持久化 → 刷新即重新登录（见第 2 节）。
- `web/_handoff/`（开工交接件：`handoff.md` + 设计稿副本）只是参考材料：不参与构建，`serve.js` 对 `/_handoff/*` 一律回 404，不会被当成产品资源发出去。

## 9. 告警页（`pages/alerts.js` + `src/alerts.js` + `assets/pages/alerts.css`）

稿：`design/alerts.html` + `alerts-notes.md`。值班的主操作面，**自动研判队列不单独成页，开关并进本页**。

### 9.1 数据来源：形态 B（四个 operation，字段逐字照文档与实现）

| 用途 | operation | 出处 | 成功体 |
| --- | --- | --- | --- |
| 列表 / 分页 | `GET /api/alerts?count&offset` | `openapi.yaml:134-157`；`server.js:335-345` | `alerts[]`、`total`、`totals`、`errors`、`partial`（+ `query`、`note`，本页不渲染） |
| 队列汇总 | `GET /api/agent/triage/status` | `openapi.yaml:178-189`；`server.js:178-180` | `initialized`、`enabled`、`input_mode`、`counts{queued,running,done,failed}`、`last_poll_at`、`last_error` |
| 暂停 / 恢复 | `PUT /api/agent/triage/control` | `openapi.yaml:211-234`；`server.js:213-219` | 正文 `{ enabled: boolean }`（`additionalProperties: false`）→ 同上 `TriageSummary` |
| 入队 / 重试 | `POST /api/agent/triage/{alertId}` | `openapi.yaml:235-260`；`server.js:220-231` | 202 `TriageCase` |

`count` 只接受 1–50、`offset` ≥ 0（`server.js:339`，越界 400）；页面只给 20 / 50 两档。

**告警行字段**（`normalizeAlert`，`cloudwalker.js:31-56`）——页面用到的就是这些，别的不画：

| 列 | 字段 | 空值 |
| --- | --- | --- |
| 等级 | `level`（低危/中危/高危/严重）+ `levelKey`（low/medium/high/critical，决定色点） | 色点回落 `sq-low` |
| 告警 ID | `id`（`type:eventId`）+ `eventId`（抽屉里带 `#`） | 「—」 |
| 告警 | `title` | 「—」 |
| 类型 | `scenario`（11 类事件的中文名） | 回落 `eventType` |
| 资产 / IP | `asset` / `assetIp` | 「—」 |
| 研判状态 | `triage.status`（`not_queued/queued/running/done/failed` → 未研判/排队中/研判中/完成/失败） | 没有 `triage` → 未研判 |
| 结论 | `triage.verdict_label`（真实威胁/存疑/误报） | 「—」 |
| 时间 | `createdAt`（ISO → `YYYY-MM-DD HH:MM:SS` 本地） | 「—」 |

**不要读 `alert.verdict`**：它是 `normalizeAlert` 里的占位值（恒为「待研判」），不是结论（`backend-contract-gaps.md` §4）。
结论只认 `triage.verdict_label`。

### 9.2 adapter 契约（`web/src/alerts.js`，本页唯一 HTTP 处）

```js
listAlerts({ count, offset }, { fetchImpl?, baseUrl? })
  → { alerts, total, totals, errors, partial }
fetchTriageSummary({ fetchImpl?, baseUrl? })        → TriageSummary
setTriageEnabled(enabled, { fetchImpl?, baseUrl? }) → TriageSummary
enqueueTriage(alertId, { fetchImpl?, baseUrl? })    → TriageCase        // alertId 会被 encodeURIComponent
```

失败一律抛 `AlertsError`，`kind` 决定界面文案：

| kind | 触发 | 页面怎么显示 |
| --- | --- | --- |
| `unauthorized` | 401（含没有凭据时**一条请求都不发**） | 「登录已失效」+ 请重新登录 |
| `unavailable` | 503（牧云或自动研判没配） | 「告警接口不可用」/ 队列条「状态不可用」 |
| `http` | 其它非 2xx | 「服务返回异常」+ 状态码 |
| `network` | fetch 抛（连不上、超时） | 「无法连接」 |
| `invalid` | 2xx 但回包形状不对 | 「返回格式异常」 |

服务端正文（`{error: '...'}`）**不直接贴到界面上**；401 的纯文本正文也不解析（同登录页口径）。

### 9.3 状态矩阵（六格）

| 格 | 触发 | 界面 | 可断言的形状 |
| --- | --- | --- | --- |
| 加载中 | 首次 render / 刷新 / 翻页 | 表内一行「正在读取告警…」，`.table-wrap` 带 `aria-busy="true"`、降透明，刷新按钮 `disabled` | 刷新 disabled；取到数据后 `aria-busy` 移除 |
| 空 | `total === 0` | 表内一行「暂无告警。」 | 上一页/下一页/全选都 `disabled`；共 N 条 显示 0 |
| 部分失败 | 回包 `partial: true` | 表格上方提示条：`部分类型查询失败，总数只合计成功的类型；<type>：<原因>；…` | 提示条 `[data-role="partial"]` 去掉 `hidden`；原因逐类列出 |
| 错误 | 列表请求抛 `AlertsError` | 表位置换成 `role="alert"` 区块：标题按 kind、正文、`重试` 按钮 | 文案区分 401/503/502/网络；服务端原文不出现 |
| 超长内容 | 标题或 ID 很长 | 单行截断（CSS `text-overflow: ellipsis`），`title` 属性给全文 | `textContent` 与 `title` 都是完整原值 |
| 禁用 | 队列暂停 / 任务排队中 / 空页 | 队列开关变「恢复」、`qstate` 加 `is-paused`；抽屉底部按钮 `disabled` 且文案换成当前状态；翻页到头禁用 | 见 `web/test/pages/alerts.test.js` |

队列状态接口单独失败时**只降级队列条**（「状态不可用」、计数全「—」、开关隐藏、右侧一行失败原因），列表照常显示。

### 9.4 交互与事件

| 动作 | 后果 |
| --- | --- |
| 刷新 | 重新取列表 + 队列；成功后「更新时间」换成本地时刻 |
| 上一页 / 下一页 / 页码 | 换 `offset = (页-1) × count` 重新取数；页数 = `ceil(total / count)` |
| 每页 20 / 50 | 换 `count` 并回到第一页 |
| 勾行 / 全选当前页 | 出现批量条「已选 N 条」；选择跨页保留；表头复选框 `indeterminate` 表示部分选中 |
| 重新研判所选 | 逐条 `POST /api/agent/triage/{id}`；**排队中/研判中跳过**；完成后清空选择并重新取数，`aria-live` 播报数量 |
| 点标题 / 告警 ID / 行 | 打开右侧抽屉（480px），焦点移到关闭按钮 |
| 抽屉关闭（按钮 / `Esc`） | 焦点回到该行标题；`≤760px` 才有遮罩 |
| 抽屉「加入研判队列 / 重试 / 重新研判」 | 未研判→加入、失败→重试、完成→重新研判；排队中/研判中禁用 |
| 抽屉「查看完整详情」 | `#/alert-detail/<encodeURIComponent(id)>` |
| 抽屉「复制」 | `navigator.clipboard` 可用则复制，否则播报「复制失败，请手动选择 …」 |
| 队列「暂停 / 恢复」 | `PUT /api/agent/triage/control`，正文只有 `{ enabled }` |

### 9.5 稿上有、接口没有 → 本页没有（A2）

已全部记进 `~/.plantree/hids-ai-console/plans/002-frontend/topics/backend-findings.md` 的「P002-T003」一节，这里只列清单：

1. **筛选条**（搜索 / 类型 / 等级 / 结论 / 研判状态 / 结果计数 / 清除筛选）：`GET /api/alerts` 只认 `count` 与 `offset`。
   前端自筛当前页会把它画成「全量筛选」，所以整条不渲染。
2. **等级排序 / 时间排序按钮**：接口没有 `sort`。时间列保留静态「↓」+ `aria-sort="descending"`（接口本身就是时间倒序合并，`cloudwalker.js:143`）。
3. **队列条「查看 N 条失败」**：需要按研判状态过滤，同样没有参数。失败数仍然显示（`counts.failed` 是真的）。
4. **抽屉「场景」行**：接口只有 `scenario`（= 事件类型中文名），与「事件类型」重复。
5. **抽屉「缺失证据」**：`TriageCase` 文档与实现都没有这个字段。
6. **证据来源按分类拆条**：只有 `verified_facts` / `evidence_sources` 两个数量，没有条目级数据。

页脚「完整证据链…可在详情页查看」保留；详情页在 T004。

### 9.6 样式与落点

- `assets/pages/alerts.css`：只写本页独有的块（队列条 / 批量条 / 表格 / 分页 / 抽屉 / 遮罩 / 空态 / 错误态），
  壳的部分（`.app/.rail/.bar/.content/.textbtn/.placeholder`）留在 `app.css`，不重复定义；颜色只用 `theme.css` 变量。
- **样式由页面模块注入**：`pages/alerts.js` 首次 `render` 时往 `<head>` 插 `<link data-page-style="alerts">`（重复 render 不重复插）。
  原因：`web/index.html` 与 `assets/app.css` 不在本卡 scope 里，入口不能改。
- 稿里「共 N 条 · 更新时间 · 刷新」在顶栏，顶栏属壳（`src/views/shell.js`，forbidden）→ 挪到内容区首行（`.page-tools`）。
- 断点照稿 §6：≥1100 显示 IP；≤1100 收导航 + 藏 IP；≤900 藏时间；≤760 藏 ID 与类型、抽屉占满宽度；≤620 藏资产。
  各档实测无横向滚动（见 `coding-reports/P002-T003.md`）。
- 稿没有的两格，按最近邻取值并记账：列表级错误块（登录页错误横幅的最近邻）、研判失败任务的步骤节点（按已完成节点画）。
