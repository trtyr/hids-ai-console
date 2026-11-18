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
| operation | `GET /api/session`（`getSession`，无参数） | `server.js:208-214` |
| 成功体 | `{ authenticated: true, user, role }`（P003-T006 起带回身份：`user` 是 Basic 账号名、`role` 目前只有 `operator`；服务端未配密码时两者为 `null`） | `server.js:208-214` |
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
probeSession(credentials, options?) → Promise<{ authenticated: true, user: string|null, role: string|null }>
// credentials: { user: string, password: string }
// user/role：非空字符串原样透传，缺键/null/脏类型一律落 null（不补默认名字）
// options: { fetchImpl?: typeof fetch, baseUrl?: string }   // 单测注入用
// 失败一律抛 SessionError：kind ∈ 'unauthorized' | 'http' | 'network' | 'invalid'，附 status（可能为 null）
```

| 场景 | HTTP | 结果 |
| --- | --- | --- |
| 凭据正确 | 200 `{authenticated:true, user, role}` | resolve `{ authenticated: true, user, role }`（缺身份字段时两者 `null`） |
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
| `#/overview` | 总览 | 总览 | `pages/overview.js` | 已接真接口（P002-T002，见第 9 节） |
| `#/alerts` | 告警 | 告警 | `pages/alerts.js` | **研判记录主列表**（P003-T015 换源，见第 10 节） |
| `#/alerts-demo` | 牧云现查（演示） | 牧云现查（演示） | `pages/alerts-demo.js` | 牧云现查的单独入口，标成演示（D020，见第 10.9 节）；牧云没配时只有这一页不可用 |
| `#/alert-detail/<alertId>` | —（不在侧栏） | 告警详情 | `pages/alert-detail.js` | 已接真接口（P002-T004，见第 11 节）；参数从第二段起原样传，页面自己 `decodeURIComponent` |
| `#/trace` | 深度溯源 | 深度溯源 | `pages/trace.js` | **溯源列表**（P003-T016 / D015：进去先是列表，见第 12 节） |
| `#/trace-board/<alertId>` | —（不在侧栏） | 深度溯源 | `pages/trace-board.js` | 这一条的白板（P003-T016 / D016，见第 12 节）；参数是告警 ID，页面自己 `decodeURIComponent` |
| `#/rules` | 规则 | 规则 | `pages/rules.js` | **Rego 规则列表**（P003-T017 / D017：进去先是表，见第 13 节） |
| `#/rules/<ruleId>` | —（同一模块） | 规则 | `pages/rules.js` → `pages/rule-detail.js` | 这一条规则的 Rego 原文（P003-T017）；参数是规则 id，`page.render` 按 `params[0]` 分发 |
| `#/rules-gate` | —（不在侧栏） | 程序门禁 | `pages/rules-gate.js` | 旧程序门禁 JSON 编辑器（P002-T006；P003-T017 搬到隐藏路由，见第 13.10 节） |
| `#/knowledge` | 知识库 | 知识库 | `pages/knowledge.js` | 已接真接口（P002-T007，见第 14 节） |

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

### 账号区（A5，P003-T007 回填）

`GET /api/session` 自 P003-T006 起回 `{ authenticated, user, role }`（`server.js:208-214`：
`user` 是 Basic 账号名，没配账号名时落 `admin`；服务端没配密码时两者都是 `null`；`role` 目前只有 `operator`）。

壳的账号区照稿渲染（`alerts.html:920-932` 的 `.who`）：头像（账号名首字母）+ 账号名 + 角色。

- 身份由 `app.js` 在登录成功时从 `probeSession` 的返回里取，传给 `mountShell({ identity })`；退出登录时清空。
- **`user` 为 `null` 时整块不渲染**——服务端未配密码时没有账号可报，不编名字、也不拿输入框里的账号名冒充身份。
- `role` 映射：`operator` → 「值守账号」（稿上的文案）；未知值原样显示；`role` 为 `null` 时不画角色行。
- 样式在 `assets/app.css` 的 `.who / .avatar / .who-name / .who-role`（稿 `alerts.html:172-186`）；
  ≤1100px 只留头像，≤900px 整块隐藏（稿 `alerts.html:785,813`）。
- 断言：`web/test/session.test.js`（`user`/`role` 透传与脏回包落 `null`）、`web/test/shell.test.js`（有身份 / 无身份 / 未知角色三种）。

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
  pages/                一页一个文件：overview / alerts（研判记录主列表）/ alerts-demo（牧云现查·演示）/
                        alert-detail / trace / trace-board / rules / knowledge
  src/
    app.js              组装：登录 ↔ 壳、hash 路由、退出
    session.js          会话 adapter（唯一 HTTP 处）
    cases.js            研判记录域 adapter（主列表 / 单条 / 入队 / 误报 / 队列）
    alerts.js           牧云告警域 adapter（只给演示页用）
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

## 9. 总览页（`pages/overview.js` + `src/status.js`，P002-T002 / P003-T015 换源）

布局、文案、断点照设计稿 `overview.html` + `overview-notes.md`；字段一个不编，全部来自本仓接口。

**P003-T015（D020 / A1）**：本页数字**全部来自研判聚合** `GET /api/agent/triage/status`，
不再请求 `/api/alerts`——「接口还没有聚合数据时允许空，不许改去拉牧云现查充数」。

### 数据 adapter（`src/status.js`，本页唯一发 HTTP 的地方）

```js
loadOverview(options?) → Promise<{
  triage: { ok:true, enabled, inputMode, lastPollAt, lastReceivedAt, lastError, since,
            counts:{queued,running,done,failed},
            verdictCounts:{threat,uncertain,false_positive,review},   // 结论分布（四键恒在）
            typeCounts:{[type]:number},                               // 类型分布（只列出现过的类型）
            syslog:{listening,bind,error}|null } | { ok:false, error },
  system: { cloud, agent, tools, rules, updates },   // 同上，各自 ok / error
  failed: string[],                                  // 失败的源名（顺序见 SOURCE_KEYS）
  fetchedAt: Date,                                    // 本机时刻，见「与稿的差异 2」
  since: string|null                                   // 本次聚合的起点，与请求一致
}>
setTriageEnabled(enabled, options?) → Promise<TriageSummary 的归一形态>   // enabled 必须是布尔值
formatClock(date) → 'HH:MM:SS'          // 拿不到时间给 '—'
formatDateTime(iso|null) → 'YYYY-MM-DD HH:mm:ss'  // 空给 '—'，解析不了原样返回
// options: { fetchImpl?, baseUrl?, now?, since? }   // 单测注入用；since 非空时只给 triage 那一路加 ?since=
// 失败一律抛 OverviewError：kind ∈ 'unauthorized' | 'http' | 'network' | 'invalid'，附 status
```

**归一规则（写死，测试可直接断言）**：`verdict_counts` 与 `type_counts` 是接口的 required——缺键或类型不对
整源 `invalid`（不拿 0 假装「没有真实威胁」）；`type_counts` 里的非整数值丢掉；
`syslog` 缺席时归一成 `null`（轮询模式本来就没有这个键）。

六个只读源与「失败了会怎样」：

| 源 | operation | 用到的字段 | 失败时页面表现 |
| --- | --- | --- | --- |
| `triage` | `GET /api/agent/triage/status[?since=]` | `enabled` / `input_mode` / `last_poll_at` / `last_received_at` / `last_error` / `counts` / `verdict_counts` / `type_counts` / `syslog` / `since` | 摘要带四个数 + 类型表 + 队列模块 + 进度条 →「—」，暂停按钮禁用，顶部报出这一项 |
| `cloud` | `GET /api/status` | `configured` / `connected` / `reason` | 牧云连接 →「—」。**502 算成功源**（正文仍是这三个字段，`connected:false` + `reason` 进 `title`） |
| `agent` | `GET /api/agent/status` | `configured` / `prompt_version` | 研判模型、提示词版本 →「—」 |
| `tools` | `GET /api/agent/tools` | `count` | 取证工具 →「—」（未配置时接口回 503） |
| `rules` | `GET /api/triage/rules` | `revision` | 规则版本 →「—」（配置取自示例文件时 `revision` 本来就是 `null`） |
| `updates` | `GET /api/updates` | `revision` | 运行状态标题右侧的版本 →「—」 |
| 写 | `PUT /api/agent/triage/control` | 正文 `{ enabled }`，回 `TriageSummary` | 顶部提示「自动研判操作失败：…」，状态保持、按钮恢复可点 |

取数口径（写死在这三条上）：

1. 六路并行、互不拖累：单源失败只让**它对应的那几行**变成「—」，整页不空。
2. **任一路 401** → 整体 `unauthorized`：凭据失效说「登录已失效，请退出后重新登录。」，不冒充网络问题。
3. 六路全失败 → 整页错误态（顶部一行 + 数值全「—」+ 刷新可点重试）。

### 状态矩阵

| 格 | 触发 | 界面 | 断言要点（可写成测试） |
| --- | --- | --- | --- |
| 默认 | 打开页面 / 刷新完成 | 摘要带 = **结论分布**（真实威胁 / 存疑 / 误报 / 待研判）、类型表（按 `type_counts` 数量降序）、构成条 + 前三类、队列模块（含「最后推送」「Syslog 接收」）、运行状态、进度条 | 摘要带四数 = `verdict_counts` 四键；表格行数 = `type_counts` 的 key 数；首行是数量最多的类型；`[role=status]` 播报「已更新，时间 HH:MM:SS」 |
| loading（稿未画，缺项取值） | `render()` 后请求未回 | 数值全「—」、刷新按钮禁用并转圈、根节点 `aria-busy="true"` | 立即断言：`aria-busy === 'true'`、刷新 `disabled === true`、`[role=status]` 文本「正在读取数据」 |
| empty | `type_counts` 为空 / 四档结论全 0 / `counts` 全 0 | 类型表一行「暂无告警数据」；构成说明「接口未返回类型统计。」；进度说明「接口未返回队列计数。」 | 不造行、不编百分比；摘要带四数显示接口给的 `0` |
| 部分失败（partial） | 研判聚合挂掉、其余源正常 | 摘要带/类型表/队列/进度 →「—」，顶部 warn 行「部分数据读取失败：研判聚合」，运行状态那几行照常 | 不把整页推成错误态；`failed` 里点到具体源名 |
| error | 六路全挂 | 全挂：顶部 danger 行 + 数值全「—」+ 刷新可点重试 | 错误行文案不许把「网络不通」「登录失效」「5xx」混成一句 |
| long-content | `last_error` 很长、`prompt_version` / 版本号很长 | 视觉截断（`od-truncate`），`title` 与 DOM 文本留全文 | `dd.textContent` 与 `title` 都等于原值——截断只发生在视觉层 |
| disabled | 刷新在途 / 队列开关请求在途 | 对应按钮与「统计范围」下拉 `disabled`，刷新带 `is-loading` 转圈 | 请求在途时再点不会再发一次（`fetch` 调用数不变）；下拉在途改不动 |

本页没有「部分失败之外的分页/筛选状态」；「不适用」的格子不必为它编状态。

### 交互与事件

| 动作 | 后果 |
| --- | --- |
| 「刷新」 | 重新读六路（6 个 GET），回落 loading，完成后换更新时间并播报「已更新，时间 …」 |
| 「统计范围」下拉（全部时间 / 近 24 小时 / 近 7 天 / 近 30 天） | 选中后重取：只给 `GET /api/agent/triage/status` 加 `since=<now-N>`（其余五路不变）；进度条说明随之变成「窗口内共 N 个任务 · 完成率…」 |
| 「暂停」/「恢复」 | `PUT /api/agent/triage/control`，正文 `{enabled:!当前}`；成功后状态文字、按钮文案、进度与四个计数一起换，播报「自动研判已暂停 / 已恢复」；失败只报错、状态不动 |
| 切页 | 每次 `render` 递增内部序号，晚到的旧响应直接丢弃（不会把上一页的数据写进新页面） |
| 行、格子、数字 | **不可点**：本页没有行级操作，明细与入队都在「告警」页（`overview-notes.md` §5） |

### 可访问性

- 表格有 `caption`（视觉隐藏）与 `th scope="col"`；四个数字是 `dl / dt / dd`。
- 摘要带 `section aria-label="结论分布"`，进度是 `section aria-label="研判进度"`；统计范围下拉 `aria-label="统计时间范围"`。
- 顶部通知行 `role="alert"`；播报用独立的 `role="status" aria-live="polite"` 节点（视觉隐藏）。
- 长内容只做视觉截断，`title` 带全文；状态不靠颜色单独表达（「运行中 / 已暂停」有文字）。
- 页面只放两个动作：刷新、暂停/恢复；按钮的可访问名就是按钮文字。

### 与稿的差异（三处，都是「稿 / 壳 / 接口」的约束，不是随手改）

1. **「更新时间 + 刷新」的位置**：稿在顶栏 `.bar-right`；壳 `views/shell.js` 不在 T002 的 scope（禁改），所以落在内容区顶部靠右一行，沿用同一套 `.stamp` / `.textbtn` 样式。
2. **「更新时间」是本机时刻**：接口没有 `overview.checkedAt` 这类字段；稿自己的脚本就是本机 `new Date()` 打的时间戳，所以按稿办——它是「这一屏数据什么时候读的」，不是服务端数据时间。
3. **类型中文名**来自稿的 `TYPE_LABELS`（接口只回类型 id）。与后端 `cloudwalker.js` 的 `eventTypes` 相比只有一条不同：`webshell` 稿里叫「网站后门」，后端叫 `WebShell`。界面照稿。

稿上有、接口没有、于是**藏掉**的区块：**没有**（`backend-findings.md` 的 P002-T002 一节记了同一句）。

### P003-T015 的三处稿缺项（D020 要求了、稿没画；取值与依据）

1. **摘要带换成结论分布**：稿的四个数是「告警总数 / 待研判 / 研判中 / 失败」（队列口径）。D020 要「结论分布」，
   而队列四项计数已经在「自动研判」模块与底部进度条各有一份 → 摘要带改放 `verdict_counts` 四档，
   版式仍是稿的四数一行（最近邻：我自己这一页的 `.nums`）。「告警总数」不再出现——它只能从牧云现查来，A1 不许。
2. **「最近轮询」拆成两态**：syslog 模式没有轮询（T010：`last_poll_at` 恒为 null），这一格改成「最后推送」取
   `last_received_at`；轮询模式仍叫「最近轮询」。另加一行「Syslog 接收」显示在不在听（在听 / 未绑定 / 未在听：原因）。
3. **统计范围下拉**：稿没有时间窗控件。D020 要「一段时间里来了多少」→ 加一个 `select`，值为聚合接口的 `since`；
   控件样式取告警页筛选条 `select` 与同页 `.textbtn` 的最近邻（高 26、方角 2、`--line-2` 边框）。
## 10. 告警主列表（`pages/alerts.js` + `src/cases.js` + `assets/pages/alerts.css`）

稿：`design/alerts.html` + `alerts-notes.md`。**P003-T015 起这一页不是牧云告警列表**，而是 D020 的
「推送进来的研判记录」：一行就是一条研判记录（`GET /api/agent/triage/cases`），同一主机同窗口的重复投递合成一行，
重复次数沿用记录上的 `repeat_count`（D008/D012）。牧云现查整份保留在单独入口 `#/alerts-demo`（见 10.9）。

### 10.1 数据来源：形态 B（六个 operation）

| operation | 出处 | 用途 |
| --- | --- | --- |
| `GET /api/agent/triage/cases?count&offset&verdict&type&host&from&to&sort` | `openapi.yaml` 的 `/api/agent/triage/cases`，实现 `server.js:570-579` → `triage-monitor.js:114-151` | 主列表一页 |
| `GET /api/agent/triage/status` | `server.js:537-543` | 队列条（enabled / input_mode / counts / last_error） |
| `PUT /api/agent/triage/control` | `server.js:580-586`，正文 `{enabled}` | 队列暂停/恢复 |
| `POST /api/agent/triage/{alertId}` | `server.js:646`，202 `TriageCase` | 重新入队（详情页发起；本页不批量） |
| `POST /api/agent/triage/{alertId}/false-positive` | `openapi.yaml` 的 `reportFalsePositive`，实现 `server.js:588-643`，正文 `{reason, who?}`，202 `FalsePositiveRecord` | 行级「标为误报」 |
| `GET /api/agent/triage/{id}` | `server.js:645` | 详情页首屏（见第 11 节） |

**A4**：这一页一条 `/api/alerts` 都不发——牧云没配时主列表照常工作（单测与浏览器证据各有一条断言/截图）。

### 10.2 adapter 契约（`src/cases.js`，本页唯一 HTTP 处）

```js
listCases(page?, options?) → Promise<{ cases: TriageCaseListItem[], total: number }>
//   page: { count=20, offset=0, verdict?, type?, host?, from?, to?, sort? }
//   空串 / 未传的筛选项不进查询串；回包缺 cases 数组或 total 不是整数 → CasesError('invalid')
getCase(alertId, options?) → Promise<TriageCase>            // 未入队也回 200 { status: 'not_queued' }
enqueueCase(alertId, options?) → Promise<TriageCase>        // POST，202 也算成功
reportFalsePositive(alertId, { reason, who? }, options?) → Promise<FalsePositiveRecord>
//   理由少于 10 字 / 超过 4000 字在本地就抛 CasesError('invalid_id')，一条请求都不发；who 省略不发
fetchQueueStatus(options?) → Promise<{ enabled, inputMode, counts, lastError, lastReceivedAt }>
setQueueEnabled(enabled, options?) → Promise<同上形态>        // PUT，正文只有 { enabled }
// options: { fetchImpl?, baseUrl? }
// 失败一律抛 CasesError：kind ∈ unauthorized | unavailable | invalid_id | not_found | conflict | http | network | invalid
//   服务端错误体是 { error: "<中文说明>" }，有原话就放进 message
```

字段名逐字照 `TriageCaseListItem`：`alert_id` / `status` / `stage` / `detail` / `repeat_count` / `verdict` /
`verdict_label` / `summary` / `rule_id` / `msgid` / `event_time` / `host_ip` / `source_ip` / `command` /
`maintenance` / `feedback`。**不另造计数**（没有 `delivery_count`），**不读列表项里不存在的 `steps`**。

### 10.3 稿 → 码对照（列）

| 稿上的列 | 本页 | 来源 |
| --- | --- | --- |
| 结论 | `.col-verdict`，`.verdict` / `.verdict-pending` | `verdict_label`；没有结论写「待研判」 |
| 类型 | `.col-type` | `msgid` → `MSGID_TYPE`（`syslog-input.js:9-15`）→ 稿的 `TYPE_LABELS`；映射表外的 msgid 原样显示 |
| 主机 | `.col-ip` | `host_ip`；`title` 带 `来源 <source_ip>` 与 `命令 <command>` 全文 |
| 时间 | `.col-time` | `event_time`（秒级 Unix 或 ISO 都收） |
| 等级 / 告警 ID / 资产 | — | 研判记录上没有这些字段（稿未覆盖新列表） |
| 研判状态 | `.col-state` | `status` 五值：未研判 / 排队中 / 研判中 / 完成 / 失败 |
| **重复** | `.col-dup`，`×N` | `repeat_count`（1 表示只投递过一次） |
| **命中规则** | `.col-rule` | `rule_id`；`status === 'done'` 但没有 `rule_id` → 「没有套上」；未完成 → 「—」 |
| **维护** | `.col-maint` | `maintenance.rule.status` / `maintenance.wiki.status` → 「规则 更新中 · 知识库 已更新」；语气色 `is-updating` / `is-failed` |
| **操作** | `.col-ops` | 「详情」→ `#/alert-detail/<编码 ID>`；「溯源」→ `#/trace-board/<编码 ID>`；「标为误报」按钮 |

### 10.4 状态矩阵（六格）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| loading | 挂载后列表未回 | 表体一行「正在读取研判记录…」，`table-wrap[aria-busy=true]`，刷新与四个筛选控件 `disabled` | 立即断言 skeleton 文案、`aria-busy`、`disabled`；读屏报「正在读取…」不需要（播报只在完成/错误时） |
| empty | `total === 0`；或筛选后 0 条 | 无筛选：「暂无研判记录。」；有筛选：「没有匹配的研判记录。」+「清除筛选」按钮 | 点「清除筛选」→ 回到第一页（`offset=0`）重取，筛选项清空，焦点回主机输入框 |
| 部分失败（partial） | 队列状态挂、列表正常 | 队列条「状态不可用」、计数全「—」、暂停按钮隐藏、`[data-role=qerror]` 可见；**列表照常渲染** | 列表行数与内容不受影响（A4 的同一条口径：主列表不被附带请求拖死） |
| error | 列表请求失败（503 未配置 / 401 / 网络 / 500） | 表体 `role="alert"` 错误块：标题 + 一句说明 + 「重试」 | 503 文案「自动研判未配置 / 服务端没有启用自动研判」；重试会再发请求并恢复表格 |
| long-content | 主机 / 命令 / 规则 id 很长 | 视觉截断（`od-truncate`），`title` 与 DOM 文本留全文 | `textContent` 与 `title` 都等于原值 |
| disabled | 行未完成（queued / running）/ 已是误报 / 请求在途 | 「标为误报」`disabled`；未完成时 `title="研判还没结束，不能登记误报"`，已误报时文案变「已误报」 | 三行（running / 误报 / done）逐个断言 `disabled` 与文案 |

### 10.5 交互与事件

| 动作 | 后果 |
| --- | --- |
| 「刷新」 | 重取一页 + 队列状态，换更新时间并播报「已载入 N 条，共 M 条研判记录」 |
| 结论 / 时间表头 | 点「结论」→ `sort=verdict`（真实威胁在前，同档按时间倒序）；点「时间」→ `sort=time`；`aria-sort` 只报 `descending`（接口没有升序参数，不伪造） |
| 结论 / 类型 / 时间下拉 + 主机输入 | 值一变就 `offset=0` 重取，参数下推（`verdict` / `type` / `host` / `from`）；主机是精确 IP，前后空白会被 trim |
| 主机输入（逐键） | 每敲一键就是一次值变化 → 一轮取数；`input` / `change` / `search` 三道共用同一个闸，**值没变就不发**，所以一次回车（浏览器会连发 `search` 与 `change`）只会有零轮新请求。取数中不清表、不禁用筛选控件（否则打到一半输入框失焦）；多轮并发时只有最后发出的那轮算数，旧响应到了也丢弃 |
| 分页 / 每页 20·50 | `offset` / `count` 跟着走；每页切换回第一页；总页数缩水时游标拉回最后一页并重拉一次 |
| 「标为误报」 | 在该行下面展开理由表单（`textarea` 获得焦点，`aria-label="给 <id> 填误报理由"`）；Esc / 「取消」收起并把焦点还给按钮 |
| 提交误报 | 理由不足 10 字或超过 4000 字 → 就地报错、**不发请求**；合格 → `POST …/false-positive`（正文只有 `{reason}`）→ 202 后**这一行立刻变误报**，`maintenance` 写进「维护」列，表单收起，播报「已把 <id> 标成误报，理由已记录」；409 → 表单内报「研判还没结束，不能登记误报」，行不变 |
| 「详情」/「溯源」 | 真链接：`#/alert-detail/<encodeURIComponent(alert_id)>`、`#/trace-board/<encodeURIComponent(alert_id)>` |

### 10.6 可访问性

- 表格有视觉隐藏 `caption`，每列 `th scope="col"`；排序按钮是 `button`，`aria-sort` 挂在 `th` 上。
- 队列条 `role="group" aria-label="自动研判队列"`；筛选条 `role="group" aria-label="筛选与排序"`。
- 播报用独立 `role="status" aria-live="polite"` 节点（视觉隐藏）；误报表单是 `form aria-label="登记误报"`，
  理由框有可见 `label` 与 `aria-label`，焦点路径：按钮 → 文本框 → 提交/取消 → 返回按钮。
- 错误块 `role="alert"`；状态不靠颜色单独表达（结论/状态都是文字）。

### 10.7 样式与字段口径

- 沿用 `assets/pages/alerts.css`（稿的表格语言）；新增四列的列宽取同表最近邻（.col-dup 52 / .col-rule 132 /
  .col-maint 148 / .col-ops 168），误报表单样式取同页筛选条与本表行的既有口径（`--bg-input` / `--line-2` / 2px 方角）。
- **横向滚动落在包裹层**：九列固定宽合计 1008（加列间距约 1136），窄屏内容区装不下 → `.table-wrap { overflow-x: auto }`，
  只让表格自己横滚，页面本身不横滚（同 §15 知识库 `.k-table-wrap` 的口径；`web/test/pages/alerts.test.js` 有
  「DOM 类名 ↔ CSS 选择器」对拔断言）。代价：包裹层因此成了滚动容器，`thead` 的 `position:sticky` 只相对它生效
  （包裹层纵向不滚），所以纵向翻页时表头不再吸顶——要两者兼得得把横向滚动换别的形式（如列折叠），属设计取舍。
- 颜色一律令牌（`--text*` / `--line*` / `--accent*` / `--warn` / `--danger`），不写色值。
- 稿未覆盖、本版**不做**的：抽屉（摘要/步骤/证据都在详情页，行内直接跳）、批量「重新研判所选」、
  搜索框（`cases` 接口没有关键词参数）、等级列（记录上没有）。见 `coding-reports/P003-T015.md` 的未决。

### 10.8 失败与退化

- 队列状态失败 → 队列条降级，列表不动（10.4 partial 行）。
- 列表失败 → 整块 `role="alert"` + 重试；筛选控件保留用户选中的值（不清空，方便改条件重试）。
- 误报失败 → 表单留在原地、理由不丢、提交按钮恢复可点；409 / 404 / 网络各自一句人话。
- JS 未加载 / 路由未命中 → 回到总览（壳的行为，见第 4 节）。

### 10.9 牧云现查（演示）：`pages/alerts-demo.js` + `src/alerts.js`

原来的告警列表整份保留（P002-T003 + P003-T007 的行为一字未改：`GET /api/alerts` 的筛选/排序/分页/抽屉/批量），
只换路由 id 与侧栏文案：`#/alerts-demo`，侧栏「牧云现查（演示）」，顶栏标题同名；内容区第一行固定一条说明：

> 演示入口：本页直连牧云现查（`GET /api/alerts`），不来自研判记录。告警主列表在「告警」页；
> 牧云没配时这一页显示不可用，主列表不受影响。

D020 的落法：**牧云现查仍在，但是单独入口并标成演示**；`/api/alerts` 503 只打这一页（页面显示
「告警接口不可用 / 服务端尚未配置牧云接口，取不到告警」），主列表与总览都不请求它，所以都不会 503。
`src/alerts.js` 仍是这一页的 adapter（`listAlerts` / `fetchTriageSummary` / `setTriageEnabled` / `enqueueTriage`），
与新主列表的 `src/cases.js` 各管一个领域；队列状态的两份归一代码是**有意重复**的（两个域各自可独立演进）。

## 11. 告警详情页（`pages/alert-detail.js`，P002-T004）

一条告警的全貌：短结果、依据、命中的 rego（或「没有套上」）、用过的 wiki、证据缺口、研判步骤、
证据来源、核验与复核、原始事件。设计稿 `design/alert-detail.html` + `alert-detail-notes.md`；
字段只来自本仓接口，接口没有的一律不画（11.5 列了每一条）。

**P003-T015（D020 / A3）**：本页**首要数据源换成研判记录**——推送 ID 和牧云事件号对不上时照样打开这条研判，
不跳进一个认不出 ID 的牧云详情；牧云没配时本页也能看研判记录（题干里说明没有原始事件）。

### 11.1 数据来源：形态 B · 六个 operation

| # | operation | 出处 | 用途 | 读不到时 |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/agent/triage/{alertId}`（`getTriageRecord`） | `server.js:645`；未入队也回 200 `{status:'not_queued'}` | **首屏**：状态、结论标签、summary/report、rule_id、repeat_count、msgid/event_time/host_ip、evidence[]、steps[] | 400 → 「没有找到这条告警」；其它失败 → 记 partial，牧云读到就照常显示 |
| 2 | `GET /api/alerts/{alertId}`（`getAlert`） | `openapi.yaml:158-176`；`server.js:347-355` | 牧云事件标题/等级/资产 + 原始事件 `detail`（**可选**） | 失败不清空页面：题干说明「牧云事件没有读到（原因），下面按研判记录显示。」 |
| 3 | `GET /api/agent/investigations/{alertId}?mode=triage|deep` | `openapi.yaml:295-312`；`server.js:326-333` | 短结果的 `summary`、`report`、claims、`required_evidence`、核验/复核、**`verdict.rego`**、**`verdict.wiki`** | partial：那一块写「读取失败：<原因>」 |
| 4 | `GET /api/rules/{id}`（`getRule`） | `openapi.yaml:660-680`；`server.js:570-578` → `rule-store.js` | 命中规则的**名字与整份 Rego 原文** | 404 → 页面写「规则库里已没有这条」，不挡页面 |
| 5 | `GET /api/trace/boards/{target}` | `openapi.yaml:544-560`；`server.js:515-524` | 关联实体（`nodes[]`） | 404 → `null`，区块隐藏 |
| 6 | `POST /api/agent/triage/{alertId}`（`retryTriage`） | `server.js:646`（202） | 「加入研判队列 / 重新研判」 | 播报「提交失败：<原因>」，按钮恢复 |

**读不到 ≠ 整页失败**：只有「研判记录与牧云事件两边都读不到」才整页错误；其余情况是哪块读不到就哪块说读不到。

失败口径（`web/src/alert-detail.js` 的 `request`）：

| 情况 | kind | 页面表现 |
| --- | --- | --- |
| 401 | `unauthorized` | 整页错误「登录已失效」 |
| 503（研判记录那一路） | `unavailable` | partial：状态行「状态读取失败」；牧云也读不到才整页错误 |
| 400（ID/事件类型无效） | `invalid_id` | 「没有找到这条告警」+ 返回链接（研判记录那一路判这个） |
| 502 及其它非 2xx | `http` | 首屏那一路 → 整页错误带状态码 + 重试；可选的牧云/白板 → 各自隐藏或 partial |
| fetch 抛 | `network` | 「无法连接」+ 重试 |
| 2xx 非 JSON / 形状不对 | `invalid` | 「返回格式异常」 |
| 404（operation 2 的规则、4 的研判结果、5 的白板） | — | **不抛**，返回 `null`：没有规则原文 / 没有研判结果 / 没有白板 |

### 11.2 adapter 契约（`web/src/alert-detail.js`，本页唯一 HTTP 处）

```js
getTriageRecord(alertId, options?)           → Promise<TriageCase>          // 首屏；未入队也 200
getAlert(alertId, options?)                  → Promise<{ alert, detail }>   // 可选；detail 非对象时给 {}
getInvestigation(alertId, { mode }?, opts?)  → Promise<Investigation | null>// 默认 mode=triage；404→null
getRule(id, options?)                        → Promise<{ id, name, description, file, rego } | null>  // 404→null
getTraceBoard(target, options?)              → Promise<TraceBoard | null>   // 404→null
enqueueTriage(alertId, options?)             → Promise<TriageCase>          // POST，202
// options: { fetchImpl?, baseUrl? }（单测注入）；失败一律抛 AlertDetailError{kind,status}
// getRule 只在「知道命中了哪条」时才被调用：rule_id（记录上）或 verdict.rego.rule_ids[0]（研判结果里）
```

路径里的告警 ID 一律 `encodeURIComponent`（`revshell:1` → `revshell%3A1`）；服务端 `decodeURIComponent` 后再匹配
（`server.js:346`、`:328`、`:223`）。
取研判结果时先查 `mode=triage`，为 `null` 再查 `mode=deep`——两条都 404 才当「没有研判结果」。

### 11.3 状态矩阵（六格）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| loading | 挂载 / 点刷新 | 「正在读取告警…」，业务区整块不出现，刷新与复制禁用 | 加载中再点刷新不发第二次请求 |
| empty（未研判） | `triage.status = not_queued` 且两条 mode 都 404 | 结论「待研判」+「这条告警还没有研判结论。」；依据/缺失证据/证据来源/关联实体整块隐藏；步骤区一句「还没有研判步骤…」；核验区「尚未核验」；「命中的规则」写「还没有研判结论，规则未评估」 | 概况条的事实/来源/缺口都是「—」，不拿 0 充数 |
| partial | 研判记录或研判结果读不到（牧云读不到也算 partial） | 主体照常；状态行写「状态读取失败」（不是「未入队」），步骤或核验区写「…读取失败：<原因>」；牧云读不到时题干写「牧云事件没有读到（…），下面按研判记录显示。」 | 状态读不到时入队按钮禁用并写「研判状态未知」；牧云 502 不把整页推成错误态 |
| error | 研判记录**与**牧云事件都读不到（401/503/502/网络） | 整页错误块 `role="alert"`：标题 + 原因 + 「重试」 | 重试要真的再发一轮请求 |
| long-content | 超长标题/报告/原始字段 | 原样整段渲染，`overflow-wrap: anywhere`；原始 JSON 的 `<pre>` `max-height:360px` 内滚动 | 标题与报告文本与接口回包逐字相等 |
| disabled | 状态 `queued`/`running`；提交中；加载中 | 按钮文案「已在队列中」/「研判状态未知」，`disabled`；刷新在加载中禁用 | 禁用时点击不发请求 |

另外两态（不在六格里，但页面上真有）：**未找到**（400 或没有 ID）与 **校验未通过**（`validation.ok === false`，
概况条写「N · 未通过校验」，核验区给错误条数）。

### 11.4 交互与事件

| 动作 | 后果 |
| --- | --- |
| ← 告警列表 | `<a href="#/alerts">`（真链接，键盘可达） |
| 复制告警 ID | `navigator.clipboard.writeText(alert.id)`；成功播报「已复制 <ID>」，不可用/失败播报「复制失败，请手动选择 <ID>」 |
| 刷新 | 重新走 1→2→4→5 四轮取数；加载中禁用 |
| 加入研判队列 / 重新研判 | `POST /api/agent/triage/{当前案件 ID}`（研判记录的 `alert_id` 优先，其次牧云事件 ID）；用 202 回包更新状态（不乐观改），成功后按钮转「已在队列中」并禁用；失败播报「提交失败：<原因>」且按钮恢复 |
| 深度溯源 | `<a href="#/trace-board/<encodeURIComponent(alertId)>">`——白板页从 `params[0]` 取；没有 ID 时退回 `#/trace` 列表 |
| 原始事件 / 原始 JSON | 原生 `<details>` 折叠，默认收起 |

播报容器：`[data-role="note"]`（`role="status"` + `aria-live="polite"`，可见文本）。

### 11.5 A2：稿上有、接口没有 → 藏掉（原文见 `topics/backend-findings.md`）

1. 页内顶栏 → 前四项挪进内容区首行；主题切换已在壳的顶栏里，不重复造。
2. 概况条「依据通过 `claimsPassed/claimsTotal`」→ 接口没有通过数/分母，改画 `claims.length`（校验未过时加「未通过校验」）。
3. 概况条「证据缺口 `validation.gaps`」→ 用 `missing_evidence.length`；字段缺席时显示「—」。
4. 依据条目的「已证实 / 存疑」徽标 → `claims[]` 只有 `text` + `citations[]`，改画「引用 N 处证据」+ `evidence_id`。
5. 步骤的工具名与耗时 → `steps[]` 元素只有 `{ stage, detail, at }`。
6. ~~证据来源的分类分组与事实文本~~ **P003-T007 已回填条目**：接口给 `evidence[]` 条目
   （`evidence_id / tool / fetched_at / sha256`，`triage-monitor.js:8-9,103-108`），按 `tool` 分组折叠渲染；
   条目没有事实文本，第三列显示 sha256 前 12 位。分类名不编（稿的「进程树 / 命令行…」在接口里没有对应字段）。
7. 核验的「证据覆盖 / 核验时间」、复核的「复核人 / 时间 / 结论 / 备注」→ `review` 是模型独立复核，没有人工复核字段。
8. 稿的「ID 不存在」页 → 接口没有 404（未知 ID 走 502），只有 400 按「没有这条告警」处理。
9. 头部「场景」行（稿映射 `scenario`）→ 与「类型」重复，不单列。

### 11.6 A3 的四块：短结果 / 命中的规则 / 用过的 wiki / 证据（P003-T015，稿未覆盖）

D020 明写详情要这四样，稿没画对应区块 → 版式取同页既有 `.block` / `.block-label` 的最近邻，逐条记账在
`coding-reports/P003-T015.md`。字段与判据：

| 区块 | 数据 | 页面怎么写 | 断言要点 |
| --- | --- | --- | --- |
| 短结果 | `investigation.verdict.summary`（≤500 字）→ 读不到时退 `triage.summary`；`report` 取 `triage.report ?? verdict.report` | 结论块里「摘要 + 报告」两段 | 两段文本与接口逐字相等；研判结果 404 时摘要仍来自记录 |
| 命中的规则 | `rule_id`（记录）/ `verdict.rego.rule_ids[]`（研判结果）；`GET /api/rules/{id}` 的 `name` 与 `rego` | 一行「命中 <id>（<name>）」+ `<pre class="rego">` 整份原文；meta 显示文件名或「规则库里已没有这条」 | 命中 → 一次 `/api/rules/<id>` 请求且 `<pre>` 文本等于 `rego`；`rego.status === 'none'` → 文本「没有套上」且不发规则请求；`unavailable` / `not_applicable` 各说各的 |
| 用过的知识库 | `verdict.wiki = { consulted[], adopted[], reason }`（`investigation-agent.js:689-694`） | meta「查阅 N 页」；采纳页逐条 `<li class="wiki-item">`（只给编号）；没采纳时写 `reason` | 采纳 1 页 → 列表 1 条且文本等于编号；`adopted` 空 + `reason` 有 → 列表空、说明显示 reason |
| 证据 | `triage.evidence[]`（见 11.7） | 沿用证据来源区块 | 条数/分组同 11.7 |

`verdict.rego.status` 的四种取值（`investigation-agent.js:295-340`）：`matched`（有 `rule_ids`）、`none`（没有套上）、
`unavailable`（求值失败）、`not_applicable`（这一轮不做规则评估，如深度研判）。

### 11.7 样式与可访问性

- 样式文件 `web/assets/pages/alert-detail.css`，由页面模块首次 render 时插 `<link data-page-style="alert-detail">`
  （`web/index.html` 与 `assets/app.css` 不在本卡 scope）。所有选择器挂在 `.detail-page` 下，避免与别的页面串样式。
- 颜色只用 `theme.css` 变量；间距/圆角/动效只用 `app.css` 的令牌；稿里非令牌的字号/行高照抄（见 `coding-reports/P002-T004.md` 的令牌表）。
- 页面结构：页级 `h1` 由壳提供（页面标题「告警详情」），内容区告警标题是 `h2.head-title`，内容区不出第二个一级标题
  （单测钉 `host.querySelectorAll('h1').length === 0`）；每个区块是 `<section aria-labelledby>` + `<h2>`；概况条是 `<dl>`；
  步骤/依据是 `<ol>`，缺口/证据/实体是 `<ul>`；原始事件是 `<details><summary>`（键盘原生可达）。
- 状态不只靠颜色：等级有文字、结论有文字、必查证据状态有文字。

### 11.8 证据链：`evidence[]` 与 claim 的 citation 对账（P003-T007 回填）

数据来源优先级：`triage.evidence[]`（`TriageCase`，P003-T003 起恒为数组）→ `investigation.evidence[]`（老记录）→ 空。
导出函数（`pages/alert-detail.js`，单测可直接调）：`evidenceOf(triage, investigation)`、`groupEvidence(items)`、`evidenceIdsOf(items)`。

| 界面元素 | 字段 | 断言要点 |
| --- | --- | --- |
| 证据来源区块标题右侧 | `共 N 条`（列表出的条目数）；只有数量没有条目时 `N 个来源`（`evidence_sources`） | 有条目时不再写「接口只返回来源数量」 |
| 分组 `<details class="ev-group">` | 组名 = `tool`（缺失时「未标注工具」），右侧 `N 条` | 组数 = 不同 tool 数；**前两组默认 `open`**，其余收起 |
| 条目 `<li class="ev-item">` | `evidence_id` / `sha256`（前 12 位，`title` 给全值）/ `fetched_at`（本地 `HH:MM:SS`） | 条数 = `evidence[]` 长度；不补事实文本 |
| claim 的引用编号 | `citations[].evidence_id`（去重） | 与条目里出现过的 `evidence_id` 求差集：对不上的编号加 `.is-missing`（危险色 + title 说明），并在该条 claim 里写「N 处引用在证据条目中找不到」 |
| 证据来源脚注 `[data-role="evidence-note"]` | 差集总数 | 差集 > 0 时显示「N 处引用在证据条目中找不到（证据链不完整）。」；差集 0 且有条目时 `hidden` |

稿 → 码：`alert-detail.html:797-801`（区块）、`:407-441`（分组 / 条目样式）、`:1199-1215`（分组折叠 + 组名 + 条数）→
`pages/alert-detail.js` 的 `paintEvidence()` / `paintClaims()` + `assets/pages/alert-detail.css` 的 `.ev-group` / `.ev-item` / `.claim-ref .is-missing`。

## 12. 深度溯源：列表 + 白板（`pages/trace.js` / `pages/trace-board.js` + `src/trace.js` + `src/trace-view.js`）

P003-T016 起按 D015 / D016 拆成两页（P002-T005 的单页「左列表 + 右白板」形态作废）：

| 页 | 路由 | 回答什么 | 文件 |
| --- | --- | --- | --- |
| 列表 | `#/trace` | 看哪一条（列、筛选、分页，**不画链**） | `pages/trace.js` |
| 白板 | `#/trace-board/<告警 ID>` | 这一条怎么触发的（告警在右、原因往左） | `pages/trace-board.js` |

两页共用 `src/trace-view.js`（状态四词 / 种类六词 / 时间 / 短标识 / 错误一句话，纯函数），
样式共用 `assets/pages/trace.css`（首次 render 注入 `<link data-page-style="trace">`；`.trace-list` 与
`.trace-page.trace-board` 两个前缀互不覆盖）。

**入口**：告警主列表每一行的「溯源」、告警详情的「深度溯源」都链到 `#/trace-board/<这条的 ID>`；
没有告警 ID 时退回 `#/trace` 列表。侧栏「深度溯源」进列表。

### 12.1 数据来源：形态 B（三个 operation，主数据是 hops / links / gaps / discovery）

| 用途 | operation | 成功返回 |
| --- | --- | --- |
| 列表 | `GET /api/trace/boards?count&offset&status&type&host&from&to` | `{ boards: TraceBoardSummary[], total }` |
| 白板详情 | `GET /api/trace/boards/{target}` | `TraceBoard`（`hops/links/gaps/discovery` + `alert/chain_length/has_gaps`） |
| 打开或创建 | `POST /api/trace/boards`，正文 `{ target }` | 已有白板 **200**、新建 **202**，都是整块 `TraceBoard` |

`status` 可逗号多选（服务端 `paramList` 拆逗号，`server.js:333`）；`from` 只算起点（`to` 不传＝到现在）。
列表**不在列表上放结论**（威胁 / 误报是告警分析的事，D015）。

### 12.2 adapter 契约（`src/trace.js`，`adapter 之外出现 fetch 即缺陷`）

| 方法 | 说明 |
| --- | --- |
| `listTraceBoards(query, options?)` | `query = { count, offset, statuses, type, host, from, to }`；空值不占参数位；`total` 缺失时退回本页条数（不编总数） |
| `getTraceBoard(target, options?)` | `target` 会 `encodeURIComponent`（冒号要编码）；回包必须含 `id` + `hops`/`links`/`discovery` 三个数组，`gaps` 缺失归一成 `[]` |
| `startTraceBoard(target, options?)` | 正文只有 `{ target }`；200（已有）与 202（新建）都当成功 |

失败一律抛 `TraceError{kind, status}`，`kind ∈ unauthorized | unavailable | notfound | http | network | invalid`：

| 场景 | kind | 页面怎么表现 |
| --- | --- | --- |
| 401 | `unauthorized` | 列表给整块错误；白板给空态说明「登录已失效」 |
| 503（模型或牧云 MCP 未配置） | `unavailable` | 带服务端原话 |
| 404（详情） | `notfound` | **不是故障**：白板页自动走 `POST` 创建（D015「没有就创建并开始」） |
| 400 / 422 / 502 | `http` | 带状态码与服务端原话（422 = 这条告警没有可用资产，不假装有白板） |
| fetch 抛 | `network` | 「连不上研判服务，请检查网络或稍后重试。」 |
| 2xx 形状不对 | `invalid` | 「服务返回的形状不对。」 |

### 12.3 列表页的状态矩阵（六格，全部有单测）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| 加载中 | 首次取列表 | 行里「正在读取溯源…」，`.table-wrap[aria-busy="true"]`，刷新与四个筛选禁用 | `aria-busy`、`refresh.disabled` |
| 空态 | 成功但 `boards` 为空 | 「暂无溯源。从告警列表点某一行的『溯源』……」；分页两键禁用 | 两句文案都在 |
| 部分失败 | 已有数据、这次刷新失败 | 顶部 `.notice[role="alert"]`「刷新失败…（下表是上一次读到的结果）」，表格保留上一次结果与条数 | `notice.hidden === false`、行数不变 |
| 错误 | 首屏失败 | 表格内 `.page-error[role="alert"]` + 「重试」 | 重试再发一轮请求并渲染 |
| 超长内容 | 长主机 / 长 ID | 全文进 `textContent` 与 `title`，屏幕上靠 CSS 省略（短标识只缩显示，`href` 与 `title` 是全 ID） | 文本全等 |
| 禁用 | 见下 | — | 逐条断言 `disabled` |

禁用矩阵：加载中 → 刷新 + 四个筛选禁用；`offset === 0` → 上一页禁用；最后一页 → 下一页禁用；非 `ready` → 分页两键禁用。

### 12.4 白板页的状态矩阵（六格，全部有单测）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| 加载中 | 首次取详情 | 画布「正在读取白板…」，`.canvas[aria-busy="true"]`，刷新禁用 | 标题文案、`disabled` |
| 空态 | 成功但 `hops` 为空 | 进行中：「还没有跳 / 任务在跑，新的一跳会自己从左边长出来」；已完成：「这条链没有跳」 | 两句文案 |
| 部分失败 | 已有白板、刷新失败 | 顶部 `.notice[role="alert"]`，链保持原样（不清空） | 节点数不变 |
| 错误 | 首屏 GET 与随后的 POST 都失败 | 画布只有失败文案：「白板读取失败」+ 服务端原话，**画布内没有按钮**（重试就是顶栏「刷新」）；没带目标时「没有指定这一条」且**不发请求** | 文案、请求次数、画布内可见按钮数 0（e2e「可见重试 = 0」同一口径） |
| 超长内容 | 长标签 / 长断点原因 | 标签全文进 `.gnode-label`（CSS 不截断数据），断点原因全文 + `title` | 文本全等 |
| 禁用 | 见下 | — | 逐条断言 `hidden` / `disabled` |

禁用矩阵：进行中 → 重放 / 暂停 / 跳到最新三键 `hidden`（D016「进行中没有别的按钮」），只有轮询；没有跳 →
重放与跳到最新禁用且不启动定时器；**暂停中「继续」可点**（暂停只是停定时器，不再禁用按钮——「停」不是单程门，
再点「继续」接着播）；播到最新（`count >= steps.length`）才把「继续」与「跳到最新」一起禁用。

白板 `status` 四值（`running` / `done` / `failed` / `interrupted`）走 `statusLabel()` 显示**进行中 / 已完成 / 失败 / 中断**；
失败与中断在顶栏多一行原因（`board.summary`，接口没给就写「接口没有返回原因」），已经画出的链不清掉（D016「实时」）。

### 12.5 字段映射（界面元素 → 接口字段）

| 界面元素 | 字段 | 备注 |
| --- | --- | --- |
| 列表「告警」列 | `type`（→ 中文，未知原样）+ `id` | 长 ID 只显示首尾（`shortBoardId`），`title`/`href` 是全的 |
| 列表「主机 / 告警时间 / 更新时间」 | `host` / `occurred_at` / `updated_at` | 空值给「—」 |
| 列表「状态 / 链长 / 断点」 | `status` / `chain_length` / `has_gaps` | 链长显示 `N 跳`；断点 `有` / `没有` |
| 告警点（钉在右） | `hops[]` 里 `kind === 'alert'` 的那一跳（没有标记退回第一跳） | 位置 `x = 0`，不可拖 |
| 其余点（往左一列） | `hops[]` 全部 + `links[]` 算出的深度 | `x = -190 × 深度`，同列按 `discovered` 竖排 64px |
| 线 | `links[]`：`from`（更晚、靠告警）→ `to`（更早的原因） | 箭头画在 `to` 那一端（从右往左指）；`rel` 是线上那四个字 |
| 断点 | `gaps[]`：`hop_id` + `reason` | 写在断了的那一跳左边；`hop_id` 为 `null` 时放最左一列 |
| 重放顺序 | `discovery[]`（按 `step`） | 未知 id 丢弃；旧白板没有 `discovery` 时退回「先跳、再线」 |
| 检查器（点跳） | `kind` / `host` / `occurred_at` / `evidence_id` | 证据正文不在白板接口里（见 12.8） |
| 检查器（点线） | `rel` / `from` / `to` / `evidence_id` | — |
| 检查器（未选中） | `summary` / `gaps[]` / `status` | 白板概览 |
| 顶栏 | `alert.title` / `status` / `hops.length` / `gaps.length` | 链长 = `hops` 个数（含告警那一跳） |

### 12.6 交互与事件

| 动作 | 后果 |
| --- | --- |
| 列表行点击 / 行内链接 / 键盘回车在链接上 | 进 `#/trace-board/<编码后的 ID>` |
| 列表筛选（状态 / 类型 / 主机 / 时间）| 下推 `status`/`type`/`host`/`from`，`offset` 回 0；「清除筛选」一次清空四个 |
| 列表分页 / 每页 20·50 | 下推 `offset` / `count`，换每页条数回第一页 |
| 打开白板 | `GET` → 404 就 `POST` 创建 → 画出来；`done` 的白板打开后**自动按 discovery 重放**（稿 §3）|
| 进行中的白板 | 每 5s `GET` 一次（`POLL_MS`），新跳从它该在的左边位置冒出来；路由切走即停 |
| 「重放 / 暂停 · 继续 / 跳到最新」 | 只有 `done` 显示；900ms 一步（`REVEAL_STEP_MS`，稿 §3），线晚于两端；「跳到最新」一次给全 |
| 「跟随」 | `aria-pressed` 切换；开启时新跳出现与播完都自动适应视图 |
| 拖点 | 只改这一个是点在图上的位置，不改谁引起谁；**告警点钉死不拖**；松手写进 `localStorage` |
| 拖空白 / 滚轮 / 「− % + 适应」 | 平移画布 / 以指针为中心缩放（25%–250%）/ 适应视图；只动视图不动数据 |
| 点跳 / 点线 / 键盘 Enter·空格在线命中区 | 右侧检查器展开；再点同一点或点空白收起 |

### 12.7 可访问性

- 列表：`<table>` + `caption` + `th scope="col"`；行内入口是 `<a href>`（键盘可达，`aria-label` 带类型与 ID）；筛选控件都有 `aria-label`。
- 白板：跳是 `<button aria-pressed>`；线是 SVG 命中线（`tabindex="0"`、`role="button"`、可访问名「关系：A → B」），Enter / 空格可选中；
  画布是 `section[aria-label="溯源白板"]`，检查器 `aria-label="检查器"`，播报走 `role="status" aria-live="polite"`。
- 颜色全部取 `theme.css` 令牌；`prefers-reduced-motion` 下动效降到 0.001ms。

### 12.8 与稿的差异（逐条记账；稿是 `design/trace.html` + `trace-notes.md`）

| 稿 | 现在 | 为什么 |
| --- | --- | --- |
| 左列表 + 右白板同屏，新建目标输入框 | 列表独立成页；**没有新建输入框** | D015：「这个形态不对」+「不带告警、手填 IP 的入口不是这轮的事」；D020：「页面上不留输入框」 |
| 力导向布局，节点位置前端算 | 固定方向：告警 `x=0`、原因每列 `-190px` | D016：「不按力导向自己飘」「越往左越早」 |
| 节点只有标签 | 标签 + 机器（`.gnode-host`） | D016：「点上只写两样：标签，和机器」 |
| 检查器列节点全部字段（含 `profile/findings`） | 只列种类 / 机器 / 时间 / 证据 | D016「点开」只要求这四样；`activity` 与节点字段不再是主数据 |
| 未选中时列「调研过程」时间线（`activity`） | 白板概览：摘要 + 断点列表 | D016：「`activity` 不再当主数据」 |
| 缺口只在检查器里 | 断点直接写在图上那一跳左边 | D016：「不点开，也能看得见」 |
| 位置只在当前会话有效（稿 §7 待补） | 拖过的位置记在 `localStorage`（相对告警点） | D016：「拖过的位置要记住」。接口没有写位置的入口 → 见 12.9 |
| 回放只有「重放 / 暂停 / 跳到最新 / 跟随」 | 同左，但进行中不出现（自己长） | D016：「进行中没有『重放』按钮，它自己就在长」 |
| 点阵背景 / 9px 圆点 / 11px 标签 / 1.2px 线 / 280px 检查器 / 25%–250% | 一字未改 | 视觉稿照搬 |

### 12.9 已知限制（这一版故意没做 / 接口不够）

- **位置记忆在浏览器本地**：D016 要求「写在这一跳上（`x`/`y`，相对告警点）」，但三个 operation 里没有写位置的入口
  （`openapi.yaml:456-560`），所以存在 `localStorage`（键 `hids.trace.positions.<白板 ID>`）。换机器 / 换浏览器会丢。
  读写只在 `readSavedPositions` / `savePosition` 两个函数里，后端补了 PATCH 换过去即可（P003-T016 未决 1）。
- **证据正文不在白板接口里**：D016 要「证据里能看的那几行」，`hops[]`/`links[]` 只给 `evidence_id`，没有原文。
  检查器如实写「证据正文在告警详情里看」（未决 2）。
- **进行中靠 5s 轮询**：没有 SSE / 进度流；`POLL_MS` 是页面常量（未决 3）。
- **列表与白板不做结论列**：D015 明确列表上不放威胁 / 误报。
- **工具调用不进图**：D016 明确不做。


## 13. 规则页（`pages/rules.js` + `pages/rule-detail.js` + `src/rego-rules.js`，P003-T017）

规则是 OPA 的 Rego，不是 JSON（D017）。这一页回答「现在有哪些规则、每一条的 Rego 到底写了什么」：
**进去先是列表**，点一行才看这一条；**这一轮页面上不能编辑**（D020），两屏都没有 input / textarea / 可编辑控件。

一个页面模块两屏：`#/rules` → 列表（`mountRulesPage`），`#/rules/<id>` → 原文（`mountRuleDetailPage`，住在
`pages/rule-detail.js`）。分发点在 `pages/rules.js` 的 `page.render`：`params[0]` 为空是列表，有值是原文。
语义来源是 `decisions/D017.md` / `D020.md`——**新页没有设计稿**（`design/rules.html` 是旧程序门禁编辑页，
D017 原话「不要当成这个」），视觉取同仓最近邻，逐条记账见 `coding-reports/P003-T017.md` 的稿→码对照表。

### 13.1 数据来源：形态 B（本仓真接口，两个只读）

| operation | 用途 | 回包字段 | 出处 |
| --- | --- | --- | --- |
| `GET /api/rules`（`listRegoRules`） | 列表 | `{ count, rules: [{ id, name, description, file }] }`，按 id 升序；空库是 `{count: 0, rules: []}` 不是 404 | `openapi.yaml:623-639`；实现 `server.js:559-562` → `rule-store.js:207-210` |
| `GET /api/rules/{id}`（`getRegoRule`） | 这一条的原文 | `{ id, name, description, file, rego }`；`rego` 是整份 `.rego` 原文，含注释与空行、逐字返回 | `openapi.yaml:664-684`；实现 `server.js:570-578` → `rule-store.js:213-218` |

- `description` 可选（`# description:` 不是必填，`rule-store.js:104-110`），列表与原文都可能给 `null`。
- 两个请求都走 HTTP Basic（`credentials.js` 的内存凭据，服务端统一外壳 `server.js:130`）。
- 本页**不调** `POST /api/rules/evaluate`（求值是分析侧的事），也**不碰** `GET|PUT /api/triage/rules`（那是门禁编辑器，见 13.10）。

### 13.2 adapter 契约（`src/rego-rules.js`，adapter 之外出现 fetch 即缺陷）

```js
listRegoRules(options?)      → { count, rules: [{ id, name, description, file }] }
getRegoRule(id, options?)    → { id, name, description, file, rego } | null    // 404 → null，不抛
// options: { fetchImpl?, baseUrl? }   单测注入用
```

| 场景 | HTTP | 结果 |
| --- | --- | --- |
| 读成功 | 200 | 归一成上面四个字段；服务端多给的键（`updated_at` / `enabled` / 任何新字段）**不转发** |
| 列表缺 `count` / `rules`，或条目缺 `id` / `name` | 200 | `RegoRulesError{kind:'invalid'}`——半截数据不上表 |
| 原文缺 `id` / `rego` | 200 | `RegoRulesError{kind:'invalid'}` |
| id 不存在 | 404 | **`null`**（只有 `getRegoRule`；列表没有 404 这一档） |
| 登录失效 | 401 | `RegoRulesError{kind:'unauthorized'}`——**不解析正文**（401 正文是纯文本，`server.js:70-74`） |
| 规则库装载失败 | 502 | `RegoRulesError{kind:'http', status:502}`，`message` 是服务端原话 `规则库读取失败：rules/<文件>:<行>: <原因>` |
| id 不合格式 / 其它非 2xx | 400 等 | `RegoRulesError{kind:'http', status}`，`message` 尽量是服务端 `{error}` 原话 |
| 连不上 | — | `RegoRulesError{kind:'network'}` |
| 2xx 但不是 JSON | 200 | `RegoRulesError{kind:'invalid'}` |

- 两屏的错误文案只有一份：adapter 导出的 `describeRegoRulesError(error)`（`unauthorized` → 「登录已失效，请重新登录。」、
  `network` → 「连接不上研判服务。」、`invalid` → 「规则接口返回的形状不对。」、`http` → 服务端原话、其它 → 原 message）。
- 空 id 不发请求，直接 `null`（原文页据此进「规则库里已没有这条」）。
- id 进路径前 `encodeURIComponent`，不拼裸串。

### 13.3 列表页：五列与字段映射

列照 D017：**名字 / 一句话 / 效果 / 开没开 / 从哪来**（D017 还写了「更新时间」，接口没有 `updated_at`，这轮不画）。

| 列 | 取值 | 性质 |
| --- | --- | --- |
| **名字** | `name`，是一枚去原文页的真链接 `#/rules/<id>`；`title` 里带 `name · file` | 接口字段 |
| **一句话** | `description`；为 `null` 写「未写说明」（`is-muted`） | 接口字段 |
| **效果** | 恒为「放行」 | **展示默认值**（D017：这轮只有放行，别的效果没定） |
| **开没开** | 恒为「开」 | **展示默认值**（规则库里装载着的规则就是在用的，没有「关掉」的数据） |
| **从哪来** | 恒为「未标注」 | **展示默认值**（接口没有来源字段，**不猜**「人建的」或「误报反哺的」） |

- 三列的值只有一处定义：`pages/rules.js` 导出的 `DISPLAY_DEFAULTS`（`{effect:'放行', enabled:'开', source:'未标注'}`），
  口径说明在 `DISPLAY_HINTS`（挂在各格 `title` 上）；页面底部还有一行脚注写明「三列是展示默认」。
- 接口哪天多给 `effect` / `enabled` / `source`，页面**也不会读**——改这三列只在 `rowElement()` 一处换映射（单测钉着这条）。
- 列表页没有筛选、没有分页、没有搜索框：接口一次返回全库、没有 `count` / `offset`；
  三列都是常量，做「按效果 / 开关 / 来源筛」筛不出任何东西（D017 的这一句等后端补字段后再做，见 13.9）。
- 列表顶部只写「共 N 条」（`count`）与「刷新」。

### 13.4 原文页：三块，从上到下

1. **名字** `name`（`h2`）；
2. **这句话在放行什么** `description`（为 `null` 写「这条规则没写一句话说明。」）；
3. **元信息**：规则 id + 文件名（`id` / `file`，等宽字体）；
4. **原文**：`<pre class="rego-block" aria-label="这条规则的 Rego 原文">` 里是 `rego` **逐字**（含注释、空行、缩进；
   不折叠、不换成 JSON、不渲染成表单）。长了在块内滚动（`max-height: 62vh`，样式层的事，数据层不截断）。

- A2 的判据：`pre.textContent === 接口的 rego`；页面上 `textarea` / `form` / JSON 行号栏（`[data-role="gutter"]`）全部不存在。
- A3 的判据：`input, textarea, select, [contenteditable]` 全为 `null`；按钮只有「刷新」（+ 失败时的「重试」）；
  页面上不出现「保存 / 编辑 / 提交 / 删除 / 新增」这些字。
- id 不存在（404）：整块写「规则库里已没有这条」，给「回规则列表」链接（`#/rules`），**不摆重试**（库里没有这条，重试也读不出来）。

### 13.5 六格状态矩阵（两屏各一格，全部有单测）

| 格 | 列表页 | 原文页 | 断言要点 |
| --- | --- | --- | --- |
| loading | 表里一行「正在读取规则库…」，`.table-wrap[aria-busy="true"]`（`opacity:.45`），刷新 `disabled` 且图标转圈，「共 N 条」是 `—` | 标题写「正在读取规则…」，`.rego-wrap[aria-busy="true"]`，刷新禁用 | `aria-busy === 'true'`；`[data-role="refresh"].disabled === true` |
| empty | 200 + `{count:0, rules:[]}` → 「规则库还没有规则。」，「共 0 条」，不摆失败块 | 404 → 「规则库里已没有这条」+ 回列表链接；`description:null` → 「这条规则没写一句话说明。」 | 文案断言；`[data-role="total"]` 文本是 `0` |
| partial | 已有规则、刷新失败 → `.notice[role="alert"]` 挂一条提示（服务端原话）+「重试」，**表格保留上一次的行** | 已有原文、刷新失败 → 同样挂提示，`<pre>` 里的原文**不清空** | `[data-role="notice"].hidden === false` 且行数不变 |
| error | 首次即失败 → 整行 `.page-error[role="alert"]`：「规则库读取失败」+ 原因 +「重试」；502 的原因带 `rules/<文件>:<行>`（定位哪份 Rego 写错，一个字都不能丢）；401 写「登录已失效」 | 「规则原文读取失败」+ 原因 +「重试」（404 不算这一格） | `.page-error` 存在；文案含 `rules/` 与`:行`；点重试成功后换成表 / 原文 |
| long-content | 名字与一句话全文进 DOM，视觉上 `od-truncate` 截断、`title` 留全文；`.table-wrap` 内横滚（表格 `min-width: 720px`） | 200 行 Rego 全文进 `<pre>`（行数一致），块内滚动 | `textContent` 与 `title` 都是原值；`pre.textContent === rego` |
| disabled | 请求在飞：刷新禁用 + `is-loading`（图标转圈）；读完恢复 | 同左 | `disabled` 与 `classList.contains('is-loading')` 逐条断言 |

- 两屏都有 `role="status" aria-live="polite"` 的 `[data-role="sr-status"]`：读成功后播「规则库已更新，共 N 条」/「已读到规则 <名字> 的 Rego 原文」，失败播原因。

### 13.6 三列展示默认值的口径（记账，不许悄悄改）

- 后端 `RegoRuleSummary` 只有 `id / name / description / file`（`openapi.yaml:1839-1847`），
  **没有** `effect` / `enabled` / `source` / `updated_at`；`rules/*.rego` 里也没有来源注释（`prompts/rule-maintenance.md` 只要求 `# name:` / `# description:`）。
- 群主 2026-11-19 拍板：五列全画，三列写展示默认（放行 / 开 / 未标注），**不许猜**「人建的」或「误报反哺的」；
  报告记账「后端缺 effect、enabled、source、updated_at」，今晚不新开后端卡。
- 后端补上字段后要改的地方只有两处：`pages/rules.js` 的 `DISPLAY_DEFAULTS`（删掉对应默认）与 `rowElement()` 的取值；
  `pages/rules.js` 的单测「服务端多给 effect/enabled/source 也不认」届时反过来写。

### 13.7 交互与事件

| 动作 | 后果 |
| --- | --- |
| 点「名字」链接 / 点整行 | 跳到 `#/rules/<id>`（链接是入口，键盘可达；行点击只是给鼠标省一步） |
| 点「刷新」（两屏） | 重新 `GET`；已有内容时失败只挂提示、不清屏；没有内容时失败进 error 格 |
| 点失败块里的「重试」（两屏） | 同「刷新」 |
| 点提示条里的「重试」（partial） | 同上；成功后提示条消失 |
| 点原文页「← 规则列表」/ 404 块的「回规则列表」 | 回 `#/rules` |

### 13.8 可访问性

- 列表是 `<table>`：`<caption class="sr-only">` 说明「点一条规则的名字看它的 Rego 原文」，五列表头都是 `<th scope="col">`。
- 名字链接的可访问名是「打开规则 <名字> 的 Rego 原文」；`focus-visible` 有 2px 强调色描边。
- 原文是 `<pre aria-label="这条规则的 Rego 原文">`（读屏能拿名字）；名字是 `h2`。
- 两屏都有 `role="status" aria-live="polite"` 的播报节点；失败块是 `role="alert"`。
- 键盘可达：链接与按钮都是原生元素；页面没有自定义 Tab 拦截，也没有可编辑控件（Tab 只走链接和按钮）。

### 13.9 已知限制（这一页故意没做）

- **没有筛选 / 分页 / 搜索**：接口一次返回全库、没有 `count|offset|q`；三列是常量，筛不出东西（见 13.6）。
- **更新时间不画**：D017 提过，但接口没有 `updated_at`。
- **不在页面上编辑**（D020）：改规则是误报反哺那条路上的维护者（D010 / D018），入口在告警列表的「误报」，不在这里。
- **和告警详情的 `getRule` 是两份读法**：`src/alert-detail.js:162-175` 自己有一份 `GET /api/rules/{id}`（T015 的「命中的规则」用），
  本卡不动它；两份合并等下次动告警详情时做，现在各自有单测。
- **旧程序门禁编辑器没删**：搬到 `#/rules-gate`（见 13.10），D020 说的「这轮不做规则页上的编辑」指的是 Rego 规则页。

### 13.10 旧程序门禁编辑页（`pages/rules-gate.js` + `src/rules.js`，P002-T006；`#/rules-gate`）

P003-T017 把原来的 `#/rules` 编辑器整份搬到 `web/pages/rules-gate.js`：页面 id `rules-gate`、顶栏标题「程序门禁」、
`navLabel: null`（**不进侧栏**，`#/rules-gate` 直达）。代码、样式（`assets/pages/rules.css`）与 27 条单测
（`test/pages/rules-gate.test.js`）一字未改，下列行为照旧有效——它维护的是 `GET|PUT /api/triage/rules` 那份
**程序门禁 JSON 配置**，不是 Rego 规则库。

#### 结构（稿 → 文件）

| 稿中区块 | 落在哪 | 备注 |
| --- | --- | --- |
| 内容区首行「刷新」 | `pages/rules-gate.js` 的 `.rules-tools` | 稿里在顶栏，顶栏属壳（forbidden）→ 挪进内容区，与 T005 同一条处理 |
| 编辑面板头部：标题 / revision / 可写徽标 / 未保存 / 视图切换 / 撤销修改 / 复制 JSON | `.pane-head` + `.title-block` + `.pane-actions` | 文案照稿 |
| 表单区（按 config 递归生成） | `[data-role="form"]`，渲染函数 `paintForm()` / `valueEl()` | 对象 → `details.nested`（默认折叠）；数组 → `details.nested open={true}`；布尔 → 勾选框；数字 → number；字符串 → text；`null` → 原样显示，不给编辑 |
| JSON 区（行号 + 等宽文本域） | `.editor-wrap` + `[data-role="gutter"]` + `[data-role="config"]` | 行号随 `input` 与 `scroll` 同步 |
| 编辑区底栏：JSON 状态 + 光标行列 | `.editor-foot` | 表单视图显示「表单视图」 |
| 右侧 320px 操作栏：状态 / 校验 / 保存 / 操作日志 | `.side` 的四个 `.panel` / `.log` | 保存卡的令牌只存在页面内存，刷新即清 |
| 整页读取失败提示（稿没画） | `.notice` `[data-role="error"]` | 缺项：稿是演示数据，无失败态；按同批页面（T005 `.notice`）先例补 |

#### adapter 契约（`src/rules.js`，`adapter 之外出现 fetch 即缺陷`）

```js
getRules(options?)                          → { config, revision, writable, origin, error }
validateRules(config, options?)             → { valid: true, count }
saveRules({ config, expectedRevision, token, ...options }) → { config, revision, origin }
// options: { fetchImpl?, baseUrl? }   单测注入用
```

| 场景 | HTTP | 结果 |
| --- | --- | --- |
| 读成功 | 200 | `{ config, revision, writable, origin, error }`；`revision` 可为 `null`（配置取自 `triage-rules.example.json`，`triage-rules.js:231`） |
| 读回包缺 `config` / `writable` | 200 | `RulesError{kind:'invalid'}` |
| 登录失效 | 401 | `RulesError{kind:'unauthorized'}`——**不解析正文**（401 正文是纯文本「需要登录后访问」，`server.js:70-74`） |
| 管理令牌无效 | 403 | `RulesError{kind:'forbidden', message:<服务端原话>}` |
| 版本过期 | 409 | `RulesError{kind:'conflict'}`（`triage-rules.js:245`；`openapi.yaml` 没写这一档） |
| 服务端没配令牌 | 503 | `RulesError{kind:'unavailable'}`（`server.js:194`） |
| 校验不合法 / 其它非 2xx | 400 等 | `RulesError{kind:'http', status}` |
| 连不上 | — | `RulesError{kind:'network'}` |
| 2xx 但不是 JSON | 200 | `RulesError{kind:'invalid'}` |

- 每个请求都带 `Authorization: Basic`（`credentials.js` 的内存凭据）；`PUT` 另带 `X-Rule-Admin-Token`（页面令牌输入框，**不进** `credentials.js`）。
- `saveRules` 的 body 逐字是 `{ config, expected_revision }`；成功后 revision 只取响应里的，不自造。

#### 状态矩阵（六格，全部有单测）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| loading | 首帧 | 表单区「正在读取规则配置…」，revision / 可写 / expected_revision 全是 `—`，保存 / 撤销 / 校验禁用，`.rules-shell` 带 `aria-busy="true"` | 按钮 `disabled === true`；`[data-role="rev-value"]` 文本为 `—` |
| empty | `config === {}` | 「当前 config 为空对象。添加字段，或切到 JSON 粘贴配置。」+ 添加字段行；JSON 视图是 `{}` | 文案断言 + 新字段行存在 |
| partial | `writable === false`（只读）/ JSON 语法错 / `config` 不是对象 / 409 冲突 | 只读：徽标「只读」、控件 `disabled`、`.form-wrap.is-readonly`（`opacity:.65`、`pointer-events:none`）、JSON `readOnly`、保存禁用；语法错：底栏红字并挡住切表单与校验；非对象：表单提示「config 不是对象」；409：结果条带「刷新」 | 只读时 `form` 里所有 `input`/`select` 都 `disabled`；语法错时 `[data-role="json-wrap"]` 仍可见 |
| error | 读取失败（网络 / 401 / 502 / 503） | `.notice` 整块提示 + 「重试」；表单区「规则配置没有读到，点上方「重试」。」；已有数据时刷新失败**不清屏**，只在结果条与日志报错 | `[data-role="error"]` 的 `hidden === false`；点重试成功后重新渲染表单 |
| long-content | 深嵌套 / 超长字符串 | 表单区与 JSON 区各自内部滚动，不撑破页面；行号与行数一致 | 4 层嵌套 → 4 个 `details`；`gutter` 行数 === textarea 行数 |
| disabled | 只读 / 加载中 / 未修改 / 没填令牌 / 请求在飞 | 保存：`!writable || !dirty || !token || busy` 任一为真即禁用；撤销：`!writable || !dirty`；校验：加载中或请求在飞时禁用；刷新：请求在飞时禁用并转圈 | 逐条断言 `disabled` |

#### 字段映射（稿元素 → 接口字段）

| 界面元素 | 字段 | 备注 |
| --- | --- | --- |
| 头部 revision / 状态卡 revision / 保存卡 expected_revision | `GET` 的 `revision` | 三个位置同值；`null` 显示 `null`，头部显示「无 revision」 |
| 可写徽标 / 状态卡「可写」 | `writable` | 语义是「服务端有没有配 `HIDS_RULE_ADMIN_TOKEN`」（`server.js:182`），不是当前用户权限 |
| 表单与 JSON 内容 | `config` | 表单按 JSON 类型递归生成，**不预设字段名**；`config` 结构由后端定 |
| 状态卡「条目数」 | `POST /validate` 的 `count` | 未校验显示「未校验」，校验失败显示 `—`；实现里等于 `config.rules.length`（`server.js:190`） |
| 保存 / 撤销 / 未保存 | 本地模型 vs 上次保存快照 | 纯前端状态，不来自接口 |
| 操作日志 | 本地时间 + 事件文案 | 不来自接口 |

#### 交互与事件

| 动作 | 后果 |
| --- | --- |
| 「表单 / JSON」切换 | 切 JSON：先按当前模型格式化并同步行号；切表单：先解析，**语法错就停在 JSON 并提示**，解析成功才重建表单 |
| 改字段名（失焦） | 空名或与同级重名 → 记一条错误日志并恢复原名；合法 → 就地重排字段顺序 |
| 值输入（字符串 / 数字） | `input` 即时写回本地模型；数字清空不写回（避免把 `""` 当 0） |
| 布尔勾选 | `change` 写回 `true/false` 并同步旁边文案 |
| 删除字段 / 删除项 / 上移 / 下移 / 添加字段 / 添加一项 | 只改本地模型并重绘；只读态一律无效 |
| 「校验配置」 | 先同步 JSON 视图内容（语法错直接拒），`config` 不是对象也拒；发 `POST /validate`，成功显示「校验通过 · 条目数 N」 |
| 「保存规则」 | 需要「可写 + 有未保存改动 + 令牌非空」；`PUT` 成功后用响应 revision 刷新三个位置、清掉未保存标记；失败（403/409/网络）**保留编辑内容**，结果条显示服务端原话 |
| 「撤销修改」 | 模型回到上次保存的快照，清空结果条 |
| 「复制 JSON」 | `navigator.clipboard.writeText(格式化 JSON)`；不支持或失败时记一条错误日志 |
| 「刷新」/「重试」 | 重新 `GET`，丢弃未保存改动，清掉结果条；已有数据时刷新失败不清屏 |
| `Ctrl/Cmd + S` | 保存按钮可用时等同点它 |

#### 可访问性

- 编辑面板 `section[aria-label="规则配置编辑器"]`，操作栏 `aside[aria-label="规则操作"]`；视图切换是 `role="group"` + 两枚 `aria-pressed` 按钮。
- 每组字段：字段名输入 `aria-label="字段名"`；值控件 `aria-label="值 · <字段路径>"`（如 `值 · rules / 0 / id`）；数组项按钮可访问名是「上移第 1 项 / 下移第 1 项 / 删除第 1 项」。
- 令牌输入有 `<label for>`；JSON 文本域 `aria-label="规则配置 JSON"`。
- 操作日志 `aria-live="polite"`；页面另有一个 `role="status"` 的读屏播报节点（`[data-role="sr-status"]`），汇报读取 / 校验 / 保存结论。
- 只读态除视觉置灰外，控件同时 `disabled`——键盘也改不了（稿只写「置灰不可操作」）。
- 焦点：渲染时不给焦点；「没填令牌就保存」把焦点送回令牌框。

#### 已知限制（这一页故意没做）

- **`config` 的真实约束不在前端**：`openapi.yaml:854` 写 `additionalProperties: true`，实现 `validateRuleSet` 要求恰好 `{schema_version, enabled, rules[]}` 三键（`triage-rules.js:126-138`）。页面不猜字段，校验失败显示服务端原话（`规则集格式无效`）。
- **没有规则专用控件**（告警类型 / 主机 / 生效时间 / 条件阈值）：需要后端给 `config` 的 schema，`rules-notes.md:5` 已把这条列为后续。
- **`null` 只能看不能编辑**，也不做字符串 / 数字 / 布尔互转（稿 §5 同样保留）。
- **`origin` / `error` 两个键不渲染**：实现会返回它们（`triage-rules.js:223-238`，配置坏时会退回示例并带 `error`），稿上没有对应区块。
- **没有 409 自动合并**：冲突只能「刷新后重编辑」。
- 稿的「知识库未定稿占位 + 导航拦截」不实现：导航与占位属壳。


## 14. 知识库页（`pages/knowledge.js` + `src/knowledge.js`）

两屏一壳：**条目列表**（搜索 / 分类筛选 / 表格）→ **条目页**（标题、元信息、目录、分节正文、
右侧条目信息与相关条目、接口字段；「条目 / 编辑」两个页签）。读只读接口，编辑**保存到服务器**（P003-T007 / D003 选 A）。

### 14.1 数据来源：形态 B（本仓真接口，两个只读 + 一个写）

| operation | 用途 | 回包字段 | 出处 |
| --- | --- | --- | --- |
| `GET /api/wiki/pages`（`listWikiPages`） | 目录 | `pages[]: { path, id, title, status, updated, revision, characters }` | `openapi.yaml:432-451`；实现 `server.js:234-240` |
| `GET /api/wiki/pages/{pagePath}`（`getWikiPage`） | 单页 + 正文 | 同上七字段 + `content`（整篇 Markdown，**含 `---` 头部元数据**） | `server.js:343-345`（`wiki-store.js:75-84`） |
| `PUT /api/wiki/pages/{pagePath}`（`updateWikiPage`，P003-T002） | 保存正文 | 正文 `{ content, expected_revision }` → 200 回更新后的页面对象（含新 `revision`） | `server.js:346-352` → `wiki-store.js:159-188` |

- 文档只钉了 `id / path / title / status` 四个字段（`openapi.yaml:858-865`，`additionalProperties: true`）；
  `updated / revision / characters / content` 是服务器侧 `wiki-store.js:26-28` 的 `metadata()` 真的回来的，逐条实测过
  （`evidence/recon/P002-T007.md` §2.4）。**字段按实现取，接口定义补全后换成明确解析，别再靠读实现。**
- 错误：`400` 路径编码无效；`404` 正文可能含服务端绝对路径——**前端不显示原文**，保存失败只显示服务端给的 `error` 文案
  （`wiki-store.js:159-188` 的校验文案，如「判据需要 evidence 或 source 出处」）；`503`「尚未配置知识库管理员凭据」只出现在
  `health` / `sessions` 一族，本页不用它们（见 §9.6）。
- 写能力（P003-T002 / D003 选 A）：`PUT` 走控制台 Basic 账号 + `expected_revision` 防覆盖。
  正文要带 `---` 头部元数据一起发（`id` / `status` / `evidence` 都在里面），服务端还会校验正文 1–30000 字、
  `id` 不变、状态只能是 `active/draft/deprecated`、必须有 `evidence` 或 `source` 出处。
- 编辑**不再落本机草稿**（`hids-wiki-drafts` 那套从页面退场；adapter 里的 `loadDrafts/saveDraft` 仍导出，供旧调用与单测）。

### 14.2 adapter 契约（`src/knowledge.js`，adapter 之外出现 `fetch` 即缺陷）

```js
listPages(options?) → Promise<{ pages: PageSummary[] }>
getPage(pagePath, options?) → Promise<PageSummary & { content: string }>
updatePage(pagePath, content, expectedRevision, options?) → Promise<PageSummary & { content: string }>
// options: { fetchImpl?: typeof fetch, baseUrl?: string }   // 单测注入用
// PageSummary = { path, id, title, status, updated, revision, characters }
//   path 是唯一必需字段；其余缺失时是 null（界面显「—」，不补默认状态/标题）
// 失败一律抛 KnowledgeError：kind ∈ 'unauthorized' | 'conflict' | 'http' | 'network' | 'invalid'，附 status（可能为 null）
// updatePage 的正文逐字是 { content, expected_revision }；content 为空 / revision 不是 16 位十六进制 → invalid，且不发请求
```

| 场景 | HTTP | 结果 |
| --- | --- | --- |
| 目录正常 | 200 `{pages:[…]}` | resolve `{ pages }` |
| 单页正常 | 200（含 `content`） | resolve 页面对象；`content` 不是字符串 → `invalid` |
| 凭据失效 | 401 | `KnowledgeError{kind:'unauthorized', status:401}`，**不发第二次请求** |
| 保存时版本过期 | 409 | `KnowledgeError{kind:'conflict', status:409}`——文件头不改，页面把编辑内容留着 |
| 保存时正文不合规 | 400 | `KnowledgeError{kind:'http', status:400}`，`message` 是服务端原话（不透路径） |
| 页面不存在 | 404 | `KnowledgeError{kind:'http', status:404}` |
| 服务异常 | 其余非 2xx | `KnowledgeError{kind:'http', status:<码>}` |
| 连不上 | fetch 抛 | `KnowledgeError{kind:'network'}` |
| 200 但不是 JSON / `pages` 不是数组 | 200 | `KnowledgeError{kind:'invalid'}` |

**本机草稿**（`DRAFTS_KEY` / `loadDrafts` / `saveDraft` 仍导出，但页面不再使用；P003-T007 起保存走服务器）：

```js
DRAFTS_KEY = 'hids-wiki-drafts'                 // localStorage：{ [pagePath]: { title, body, savedAt } }
loadDrafts(storage?) → drafts
saveDraft(pagePath, { title, body }, { storage?, now? }) → { persisted, drafts }
// persisted=false 表示没写进本机存储（配额/隐私模式）
```

### 14.3 状态矩阵（六格，稿只画了其中两格）

| 格 | 触发 | 界面 | 断言要点（已写成测试） |
| --- | --- | --- | --- |
| 默认 / loading | 进页面、点刷新 | 根节点 `aria-busy="true"`、表格一行「正在读取知识库…」、刷新与搜索/分类禁用 | `aria-busy` 是 `true`；`刷新`.disabled；`#knowledge-q`.disabled |
| empty（筛选无结果） | 搜索或分类筛到 0 条 | 「没有匹配的条目」+「换个关键词，或点「清除筛选」回到全部条目。」+ 出现「清除筛选」 | 空态 `hidden=false`；点清除后行数恢复 |
| empty（目录为空） | 接口回 `pages: []` | 「知识库还没有条目」+「目录接口返回的 pages 是空的。」 | 文案可断言；顶部计数 `0` |
| partial | 目录读到了、单条正文失败（404/5xx） | 条目页局部 notice 带原因与「重试」，列出仍在（面包屑可回列表） | notice 含「（404）」且不含服务端路径；点重试成功后正文出现 |
| error | 目录请求失败（401/5xx/连不上） | 顶部 notice：401 →「登录已失效…」；5xx →「服务返回异常（<码>），目录读取失败。」；网络 →「连不上研判服务…」 | 401 时文案不含服务端正文；重试可恢复。**口径**：刷新失败时**保留上一轮已取到的目录**（只是旧数据，不是假数据），不清空列表；只有「首次加载就失败」才是 0 行——按「清空」判红会误伤 |
| long-content | 189 条目录 / 超长标题 / 超长正文 | 表行不截断数据（靠 CSS 折行与 `overflow-wrap:anywhere`），正文列 `max-width:74ch` | 200 条目录全渲染；长标题 `textContent` 完整；长正文整段保留 |
| disabled | 刚进编辑页签 / 加载中 / 保存中 / 页面没有 revision | 「保存到服务器」「撤销修改」禁用；加载中刷新/搜索/分类禁用；保存请求在飞时保存禁用 | 改一个字后两个按钮启用；`revision` 不是 16 位十六进制时保存恒禁用（保存不了就不给死按钮） |

### 14.4 交互与事件

| 动作 | 后果 |
| --- | --- |
| 行标题（`<button>`）或整行点击 | 打开条目页（先取正文；有未保存修改先弹确认） |
| 搜索框输入 / 分类下拉 | 即时本地过滤，右侧 `N / M 条`；有筛选时出现「清除筛选」 |
| 面包屑「知识库」 | 回列表并保留当前筛选，焦点落搜索框（首次进页面不抢焦点） |
| 面包屑分类项 / 条目页「分类」链接 | 回列表并按该分类筛选 |
| 目录项 | 滚动到对应小节（`scrollIntoView`） |
| 小节右侧「编辑」 | 切到编辑页签并把光标定位到该节标题那一行 |
| 正文里的 `[[编号]]` / `[文字](相对路径)` | 解析到目录里的条目就跳过去；未建的标红虚线、不跳 |
| 「条目 / 编辑」分段 | 切页签；未保存修改留在编辑视图里 |
| 「保存到服务器」 | `PUT /api/wiki/pages/{path}`：`content` = 原 front matter + 编辑区正文（标题改过就改写头部 `title:` 行），`expected_revision` = 页面当前 `revision`。成功 → 用响应更新 `revision`/正文，脏标记清掉，脚注转「已保存到服务器」，toast + `aria-live` 播报 |
| 保存失败（409 版本过期） | 编辑内容与脏标记都留着；结果条写「知识库页面已被别人更新，当前修改还留在编辑器里；刷新正文会丢掉它们。」+「刷新正文」按钮（点它重取服务器版本） |
| 保存失败（400/401/5xx/连不上） | 结果条写「保存失败：<原因>」；400 显示服务端原话 |
| 「撤销修改」 | 回到上次保存（服务器版）的基线 |
| `Ctrl/⌘+S` | 编辑页签下等同「保存到服务器」 |
| 「复制路径」 | 写剪贴板 + toast；无 clipboard 时退回 `execCommand`，再失败提示手动复制 |
| 「刷新」 | 重取目录；**有未保存修改时不重取正文**（草稿不被接口数据盖掉），toast 说明保留 |
| 有未保存修改时离开条目 | 原生 `<dialog>`：保存并离开（先 PUT，成功才走；失败留在原地）/ 放弃修改 / 取消 |
| 有未保存修改时离开**页面**（壳侧栏导航 / 「退出登录」/ 浏览器后退） | 同一个 `<dialog>` 三选一；取消后留在编辑页签、编辑内容不动 |
| 有未保存修改时关标签页 / 刷新 | 浏览器原生 `beforeunload` 拦一次；保存到服务器成功或撤销后自动摘掉 |

**页面级离开守卫怎么实现的（壳禁改，全在 `pages/knowledge.js` 的闭包里）**

| 离开路径 | 拦法 | 可断言点 |
| --- | --- | --- |
| 壳侧栏导航（`views/shell.js:36-38` 的 `a.nav-item[href="#/…"]`）与「退出登录」 | `document` **捕获阶段** `click`：命中且 `isDirty()` → `preventDefault()` + `stopPropagation()` + 开同一个 `data-role="discard"` 弹窗；放行后「导航」写 `location.hash`、「退出登录」把点击交回壳的按钮 | 脏态点一次导航：`defaultPrevented=true`、`location.hash` 不变、`dialog.open=true`；选「取消」后哈希与编辑内容都不动；选「放弃修改」后哈希变成目标路由 |
| 浏览器后退 | 脏时 `history.pushState` 压一条**同 URL 的守卫条目**；后退只会在同 URL 上 `popstate`（无 `hashchange` → 页面不被 `app.js` 重建，草稿还在）→ 弹窗；放行时 `history.go(-2)` | 脏态 `window.dispatchEvent(new Event('popstate'))` → 弹窗且视图不动；`history.state.knowledgeUnsavedGuard === true` |
| 关标签页 / 刷新 | 脏时挂 `beforeunload`（`preventDefault` + `returnValue=''`），脏标记消失时摘掉 | 脏态派发 `beforeunload`（`cancelable`）→ `defaultPrevented=true`；保存到服务器后再派发 → `false` |

- 脏标记翻转的两个收口是 `updateFoot()` 与 `showIndex()`，两处都调 `syncLeaveGuard()`；弹窗动作分两路：页内导航走 `state.pendingNav`，页面级离开走 `state.leave`，二者互斥，Esc 关闭时一起清。
- 页面模块没有 unmount 钩子（`router.js` 的 page 契约只有 `render`）→ 监听器靠 `MutationObserver`（host 被换掉时）与事件里的 `host.isConnected`（兜底）自净；旧页不会在后台继续拦导航。
- 边界：确认离开后历史栈里仍留一条同 URL 的守卫条目（浏览器不允许删历史项），所以「离开 → 再进知识库 → 后退」会先回到知识库而不是上一页；不影响正确性，也不产生空白页。

### 14.5 可访问性

- 表格有 `<caption>` 与 `scope="col"`；行标题是 `<button>`（键盘可达，可访问名＝条目标题）。
- 搜索框、分类下拉各有 `sr-only` `<label for>`；分段切换用 `aria-pressed`。
- 通知条 `role="alert"`；另有一处 `role="status" aria-live="polite"` 播报「正在读取 / 已更新 / 失败」。
- 条目页 `<h1 tabindex="-1">`：打开条目与小节跳转后焦点落到标题上；dialog 关闭后焦点回原控件。
- 深/浅两套由 `theme.js` 切换，本页颜色全部走 `theme.css` 变量。

### 14.6 稿上有、接口没有 → 藏掉（A2，明细见 `topics/backend-findings.md` 的 P002-T007 节）

| 稿上区块 | 为什么不画 |
| --- | --- |
| 标签下拉 / 分类标签增删 / 条目页「分类」标签组 | 目录与单页回包都没有 `tags` 字段；「分类」改显真实目录名（`common` / `webshell` …） |
| 列表的**摘要**与**分节**列 | 列表接口不返正文，要算就得逐条取 189 个页面；只藏这两列，其余四列都是真字段 |
| 顶栏「共 N 条 · N 份本地草稿 · 更新时间 · 刷新」 | 顶栏归壳 → 落在内容区顶部一行；**「N 份本地草稿」随 A4 退场**（保存改到服务器后没有本地草稿可数），只留「共 N 条 · 更新时间 · 刷新」 |
| 「提交审核」按钮与弹窗 | `POST /api/wiki/sessions` 要 `X-Prompt-Admin-Token`（`server.js:250`），控制台凭据只有 Basic → 实测一律 `503`；不放死按钮 |
| 「正文来源：示例草稿（接口未定义）」 | 接口**有** `content`，且编辑可保存回服务器：标注为「正文来源：服务器正文」，未落盘的改动由「有未保存修改」表达 |
| 稿的四个中文分类（通用口径 / 案件复盘 / 规则说明 / 值守交接） | 真实目录是 18 个英文键，不编中文名；分类选项由目录数据生成 |
| `/api/wiki/health`、维护会话、重放、发布 | 不在本页面出现（都要管理员令牌） |

### 14.7 样式与令牌

- `assets/pages/knowledge.css`：稿 `wiki.html:66-545` 里本页用到的块；**所有选择器挂在 `.knowledge` 下**
  （`app.css` 里 `.field` 已被登录页占用，裸写会改到登录页）。
- 颜色只用 `theme.css` 变量；字号/间距照稿的 px（稿 `:root` 只有颜色 token，同 P002-T001 记的一笔）。
- 样式表不能在 `index.html` 里挂（不在本卡 scope）：页面首次 `render` 时注入 `<link data-page-style="knowledge">`（同 P002-T002）。
- 稿没画、但真正文里有的：**管道表格**（99 个文件）与**围栏代码块**（36 个文件）按同一套 token 补了样式（`.md-table` / `pre.code`）。
- **表格包裹层的类名两边必须同名**：`renderMarkdown` 生成 `<div class="k-table-wrap">`，样式挂在 `.k-table-wrap`（`overflow-x:auto` 是窄屏兜底）。
  两边不同名过一次（生成 `table-wrap`），窄屏宽单元格会把整页撑到 1791px；现在 `web/test/pages/knowledge.test.js` 有一条对拔断言：
  既查 DOM 里的包裹层类名，也读 `knowledge.css` 源码查出 `.k-table-wrap { … overflow-x: auto }`，改名就红。
- **稿与实现的两处偏差（记账在案，非疏漏）**：
  | 稿 | 实现 | 为什么 |
  | --- | --- | --- |
  | 标题只认 `###` / `####`（`wiki.html:1346`） | `#{1,4}` 一律渲染成 `h3` | 真正文带一级篇名（如 `# GEN-12 · 研判通则`），页面的 `h1` 已被接口 `title` 占住，篇名行归 `h3` 不重复主标题 |
  | 条目头的「N 字」 | 正文去掉 front matter 后**去空白**计数（稿 `wiki.html:1569` 的公式） | 接口的 `characters` 含 `---` 头部元数据（GEN-12：接口 1028 / 界面 779），两个口径都能对上游，界面照稿 |
  | 断点 1180 / 1100 / 900 / 620（`wiki.html:497-544`） | 页面侧 1180 / 900 / 620 三档 | 1100 那一档在稿里全是壳（侧栏收成图标栏）的规则，`app.css` 已有且本卡禁改壳；本页行为无缺口 |

### 14.8 已知边界（这一版故意没做）

- ~~编辑只在本机~~ **P003-T007 起保存到服务器**（PUT + `expected_revision`）；刷新后看到的是服务器上的那一版。
- 没有「提交审核」入口：`POST /api/wiki/sessions` 要管理员令牌，控制台只有 Basic（§14.6）。
- 目录不分页：`GET /api/wiki/pages` 一次回全部（本仓 189 条），表格整段渲染；要分页得后端加参数。
- 服务端的 `q` 参数没接：本地过滤零延迟且不被 50 条截断（`server.js:238-239`）。
- 401 只提示不自动登出：登出逻辑在 `app.js`（禁改），本页不重复实现。
- 头部元数据（`applies_to` / `refs` / `evidence` / `used` / `failed`）不进正文视图，在「接口字段」折叠面板里看原样回包。
