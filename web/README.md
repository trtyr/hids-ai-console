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
| `#/alerts` | 告警 | 告警 | `pages/alerts.js` | 已接真接口（P002-T003，见第 10 节） |
| `#/alert-detail/<alertId>` | —（不在侧栏） | 告警详情 | `pages/alert-detail.js` | 已接真接口（P002-T004，见第 11 节）；参数从第二段起原样传，页面自己 `decodeURIComponent` |
| `#/trace` | 深度溯源 | 深度溯源 | `pages/trace.js` | 已接真接口（P002-T005，见第 12 节） |
| `#/rules` | 规则 | 规则 | `pages/rules.js` | 已接真接口（P002-T006，见第 13 节） |
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

## 9. 总览页（`pages/overview.js` + `src/status.js`，P002-T002）

布局、文案、断点照设计稿 `overview.html` + `overview-notes.md`；字段一个不编，全部来自本仓接口。

### 数据 adapter（`src/status.js`，本页唯一发 HTTP 的地方）

```js
loadOverview(options?) → Promise<{
  alerts: { ok:true, total, totals, errors, partial } | { ok:false, error },
  triage: { ok:true, enabled, inputMode, lastPollAt, lastError, counts:{queued,running,done,failed} } | { ok:false, error },
  system: { cloud, agent, tools, rules, updates },   // 同上，各自 ok / error
  failed: string[],                                  // 失败的源名（顺序见 SOURCE_KEYS）
  fetchedAt: Date                                     // 本机时刻，见「与稿的差异 2」
}>
setTriageEnabled(enabled, options?) → Promise<TriageSummary 的归一形态>   // enabled 必须是布尔值
formatClock(date) → 'HH:MM:SS'          // 拿不到时间给 '—'
formatDateTime(iso|null) → 'YYYY-MM-DD HH:mm:ss'  // 空给 '—'，解析不了原样返回
// options: { fetchImpl?, baseUrl?, now? }   // 单测注入用；页面调用时不传，走 globalThis.fetch
// 失败一律抛 OverviewError：kind ∈ 'unauthorized' | 'http' | 'network' | 'invalid'，附 status
```

七个只读源与「失败了会怎样」：

| 源 | operation | 用到的字段 | 失败时页面表现 |
| --- | --- | --- | --- |
| `alerts` | `GET /api/alerts?count=1` | `total` / `totals` / `errors` / `partial` | 摘要带数字与类型表 →「—」，顶部报出这一项 |
| `triage` | `GET /api/agent/triage/status` | `enabled` / `input_mode` / `last_poll_at` / `last_error` / `counts` | 三个数字 + 队列模块 + 进度条 →「—」，暂停按钮禁用 |
| `cloud` | `GET /api/status` | `configured` / `connected` / `reason` | 牧云连接 →「—」。**502 算成功源**（正文仍是这三个字段，`connected:false` + `reason` 进 `title`） |
| `agent` | `GET /api/agent/status` | `configured` / `prompt_version` | 研判模型、提示词版本 →「—」 |
| `tools` | `GET /api/agent/tools` | `count` | 取证工具 →「—」（未配置时接口回 503） |
| `rules` | `GET /api/triage/rules` | `revision` | 规则版本 →「—」（配置取自示例文件时 `revision` 本来就是 `null`） |
| `updates` | `GET /api/updates` | `revision` | 运行状态标题右侧的版本 →「—」 |
| 写 | `PUT /api/agent/triage/control` | 正文 `{ enabled }`，回 `TriageSummary` | 顶部提示「自动研判操作失败：…」，状态保持、按钮恢复可点 |

取数口径（写死在这三条上）：

1. 七路并行、互不拖累：单源失败只让**它对应的那几行**变成「—」，整页不空。
2. **任一路 401** → 整体 `unauthorized`：凭据失效说「登录已失效，请退出后重新登录。」，不冒充网络问题。
3. 七路全失败 → 整页错误态（顶部一行 + 数值全「—」+ 刷新可点重试）。

### 状态矩阵

| 格 | 触发 | 界面 | 断言要点（可写成测试） |
| --- | --- | --- | --- |
| 默认 | 打开页面 / 刷新完成 | 四个数字、11 类类型表（按数量降序）、构成条 + 前三类、队列模块、运行状态、进度条 | 表格行数 = `totals` 的 key 数；首行是数量最多的类型；`[role=status]` 播报「已更新，时间 HH:MM:SS」 |
| loading（稿未画，缺项取值） | `render()` 后请求未回 | 数值全「—」、刷新按钮禁用并转圈、根节点 `aria-busy="true"` | 立即断言：`aria-busy === 'true'`、刷新 `disabled === true`、`[role=status]` 文本「正在读取数据」 |
| empty | `totals` 为空 / 类型全 0 / `counts` 全 0 | 类型表一行「暂无告警数据」；构成说明「接口未返回类型统计。」；进度说明「接口未返回队列计数。」 | 不造行、不编百分比；「告警总数」显示接口给的 `0` |
| partial | `partial === true`（部分类型查询失败） | 稿的警示行可见，点名失败类型（中文名） | 失败类型**不出现在**类型表里；总数仍用接口的 `total`（不自己求和） |
| error | 七路全挂 / 单源挂 | 全挂：顶部 danger 行 + 数值全「—」；单源挂：顶部 warn 行「部分数据读取失败：<源名>」 | 两种都是 `role="alert"`；错误行文案不许把「网络不通」「登录失效」「5xx」混成一句 |
| long-content | `last_error` 很长、`prompt_version` / 版本号很长 | 视觉截断（`od-truncate`），`title` 与 DOM 文本留全文 | `dd.textContent` 与 `title` 都等于原值——截断只发生在视觉层 |
| disabled | 刷新在途 / 队列开关请求在途 | 对应按钮 `disabled`，刷新带 `is-loading` 转圈 | 请求在途时再点不会再发一次（`fetch` 调用数不变） |

本页没有「部分失败之外的分页/筛选状态」；「不适用」的格子不必为它编状态。

### 交互与事件

| 动作 | 后果 |
| --- | --- |
| 「刷新」 | 重新读七路（7 个 GET），回落 loading，完成后换更新时间并播报「已更新，时间 …」 |
| 「暂停」/「恢复」 | `PUT /api/agent/triage/control`，正文 `{enabled:!当前}`；成功后状态文字、按钮文案、进度与四个计数一起换，播报「自动研判已暂停 / 已恢复」；失败只报错、状态不动 |
| 切页 | 每次 `render` 递增内部序号，晚到的旧响应直接丢弃（不会把上一页的数据写进新页面） |
| 行、格子、数字 | **不可点**：本页没有行级操作，明细与入队都在「告警」页（`overview-notes.md` §5） |

### 可访问性

- 表格有 `caption`（视觉隐藏）与 `th scope="col"`；四个数字是 `dl / dt / dd`。
- 摘要带 `section aria-label="告警概况"`，进度是 `section aria-label="研判进度"`。
- 顶部通知行 `role="alert"`；播报用独立的 `role="status" aria-live="polite"` 节点（视觉隐藏）。
- 长内容只做视觉截断，`title` 带全文；状态不靠颜色单独表达（「运行中 / 已暂停」有文字）。
- 页面只放两个动作：刷新、暂停/恢复；按钮的可访问名就是按钮文字。

### 与稿的差异（三处，都是「稿 / 壳 / 接口」的约束，不是随手改）

1. **「更新时间 + 刷新」的位置**：稿在顶栏 `.bar-right`；壳 `views/shell.js` 不在 T002 的 scope（禁改），所以落在内容区顶部靠右一行，沿用同一套 `.stamp` / `.textbtn` 样式。
2. **「更新时间」是本机时刻**：接口没有 `overview.checkedAt` 这类字段；稿自己的脚本就是本机 `new Date()` 打的时间戳，所以按稿办——它是「这一屏数据什么时候读的」，不是服务端数据时间。
3. **类型中文名**来自稿的 `TYPE_LABELS`（接口只回类型 id）。与后端 `cloudwalker.js` 的 `eventTypes` 相比只有一条不同：`webshell` 稿里叫「网站后门」，后端叫 `WebShell`。界面照稿。

稿上有、接口没有、于是**藏掉**的区块：**没有**（`backend-findings.md` 的 P002-T002 一节记了同一句）。
## 10. 告警页（`pages/alerts.js` + `src/alerts.js` + `assets/pages/alerts.css`）

稿：`design/alerts.html` + `alerts-notes.md`。值班的主操作面，**自动研判队列不单独成页，开关并进本页**。

### 10.1 数据来源：形态 B（四个 operation，字段逐字照文档与实现）

| 用途 | operation | 出处 | 成功体 |
| --- | --- | --- | --- |
| 列表 / 分页 / 筛选 / 排序 | `GET /api/alerts?count&offset&type&level&q&from&to&sort&triage_status&verdict` | `server.js:440-457`（参数校验 `alertQuery`，`:129-152`）；`cloudwalker.js:107-188` | `alerts[]`、`total`、`totals`、`errors`、`partial`、`truncated`（+ `query`、`note`，本页不渲染） |
| 队列汇总 | `GET /api/agent/triage/status` | `openapi.yaml:178-189`；`server.js:178-180` | `initialized`、`enabled`、`input_mode`、`counts{queued,running,done,failed}`、`last_poll_at`、`last_error` |
| 暂停 / 恢复 | `PUT /api/agent/triage/control` | `openapi.yaml:211-234`；`server.js:213-219` | 正文 `{ enabled: boolean }`（`additionalProperties: false`）→ 同上 `TriageSummary` |
| 入队 / 重试 | `POST /api/agent/triage/{alertId}` | `openapi.yaml:235-260`；`server.js:220-231` | 202 `TriageCase` |

`count` 只接受 1–50、`offset` ≥ 0（`server.js:443`，越界 400）；页面只给 20 / 50 两档。

**筛选 / 排序参数（P003-T007 回填，接口 P003-T001 已支持）**——页面把下拉值直接下推，不在前端自筛：

| 控件 | 参数 | 取值（页面 → 接口） | 非法值 |
| --- | --- | --- | --- |
| 搜索 | `q` | 原样（服务端对 id/title/asset/source/target/account/command 包含匹配） | — |
| 类型 | `type` | 11 个事件类型键（稿上的中文名 → `brute_force` … `memory_security`） | 400 |
| 等级 | `level` | 严重/高/中/低 → `critical` / `high` / `medium` / `low` | 400 |
| 结论 | `verdict` | 真实威胁/存疑/误报/待研判 → `threat` / `uncertain` / `false_positive` / `review` | 400 |
| 研判状态 | `triage_status` | 未研判/排队中/研判中/完成/失败 → `not_queued` / `queued` / `running` / `done` / `failed` | 400 |
| 时间范围 | `from` | 近 24 小时 / 近 7 天 / 近 30 天 → `now - N` 的 ISO 时刻；**`to` 不传**（闭区间不传＝到现在） | 400 |
| 表头排序 | `sort` | `time`（默认）/ `level`，两者都是接口固定降序（**没有方向参数**） | 400 |

- 筛选值一变就回第一页重取（`offset = 0`），已选告警不清空（稿 §4）。
- `truncated: true` 表示研判侧筛选只扫了 500 条原始事件（`cloudwalker.js:182-188`），此时 `total` 只含窗口内匹配，
  页面用一条提示条说明（见 10.3「partial」格）。
- 空串 / 未选的筛选参数**不发**（不把 `type=` 当非法值发给服务端）。

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

### 10.2 adapter 契约（`web/src/alerts.js`，本页唯一 HTTP 处）

```js
listAlerts({ count, offset, type?, level?, verdict?, triageStatus?, q?, from?, to?, sort? }, { fetchImpl?, baseUrl? })
  → { alerts, total, totals, errors, partial, truncated }
  // triageStatus 在查询串里落成 triage_status；空串参数不发
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

### 10.3 状态矩阵（六格）

| 格 | 触发 | 界面 | 可断言的形状 |
| --- | --- | --- | --- |
| 加载中 | 首次 render / 刷新 / 翻页 | 表内一行「正在读取告警…」，`.table-wrap` 带 `aria-busy="true"`、降透明，刷新按钮 `disabled` | 刷新 disabled；取到数据后 `aria-busy` 移除 |
| 空 | `total === 0` | 无筛选时表内一行「暂无告警。」；有筛选时「没有匹配的告警。」+「清除筛选」按钮 | 上一页/下一页/全选都 `disabled`；共 N 条 显示 0；空态按钮能退出筛选 |
| 部分失败 | 回包 `partial: true` | 表格上方提示条：`部分类型查询失败，总数只合计成功的类型；<type>：<原因>；…` | 提示条 `[data-role="partial"]` 去掉 `hidden`；原因逐类列出 |
| 部分失败（扫描窗口） | 回包 `truncated: true` | 同一位置的提示条：`筛选结果只统计了扫描窗口：单次最多扫 500 条原始事件…` | `[data-role="truncated"]` 去掉 `hidden`；`false` 时 `hidden` |
| 错误 | 列表请求抛 `AlertsError` | 表位置换成 `role="alert"` 区块：标题按 kind、正文、`重试` 按钮 | 文案区分 401/503/502/网络；服务端原文不出现 |
| 超长内容 | 标题或 ID 很长 | 单行截断（CSS `text-overflow: ellipsis`），`title` 属性给全文 | `textContent` 与 `title` 都是完整原值 |
| 禁用 | 队列暂停 / 任务排队中 / 空页 / 加载中 | 队列开关变「恢复」、`qstate` 加 `is-paused`；抽屉底部按钮 `disabled` 且文案换成当前状态；翻页到头禁用；**加载中筛选控件与刷新都 `disabled`** | 见 `web/test/pages/alerts.test.js` |

队列状态接口单独失败时**只降级队列条**（「状态不可用」、计数全「—」、开关隐藏、右侧一行失败原因），列表照常显示。

### 10.4 交互与事件

| 动作 | 后果 |
| --- | --- |
| 刷新 | 重新取列表 + 队列；成功后「更新时间」换成本地时刻 |
| 搜索框（`change` / `search`） | 回车、失焦或点搜索框自带清除 → `q` 下推、回第一页、`aria-live` 播报 |
| 类型 / 等级 / 结论 / 研判状态 / 时间范围下拉 | `change` 即下推对应参数、回第一页；有筛选时出现「清除筛选」与结果计数（`筛选后 N 条`） |
| 清除筛选 | 控件全复位、排序回 `time`、回第一页重取、焦点回搜索框 |
| 点「等级」/「时间」表头 | 换 `sort` 并回第一页重取；当前排序列 `aria-sort="descending"` + `↓`，另一列 `none`。**同一列再点不发请求**（接口没有方向参数，不伪造升序） |
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

### 10.5 可访问性

- **表格是语义表格**：真 `<table>` + `<caption class="sr-only">`（「告警列表，时间倒序；点标题或告警 ID 查看摘要，可勾选后批量重新研判」），
  表头十列都是 `<th scope="col">`；等级与时间两列各有一个 `.th-sort` 按钮（原生 `<button>`，Tab 可达、Enter / Space 触发），
  `aria-sort` 由当前 `sort` 决定（`descending` / `none`），箭头 `↓` 只在当前列。
- **筛选条**：`.filters` 是 `role="group" aria-label="筛选与排序"`；搜索框 `aria-label="搜索告警"`，
  五个下拉各自 `aria-label`（按事件类型 / 等级 / 研判结论 / 研判状态 / 时间范围筛选）。
- **可访问名**（每个控件都能被单独点名，不靠上下文猜）：全选 `aria-label="全选当前页"`（`:89`）；行内复选框 `选择告警 <id>`（`:363`）；
  复制 `aria-label="复制告警 ID"`（`:128`）；关闭 `aria-label="关闭摘要"`（`:141`）；
  两个具名分组 `role="group"`：队列条「自动研判队列」（`:63`）、每页条数「每页条数」（`:112`）——**无 role 的 `div` 上 `aria-label` 不会被读屏暴露**，所以这两个补了 role。
- **抽屉**：`<aside aria-labelledby="drawer-title">`（`:123`），标题 `h2#drawer-title`（`:136`）。
  🔴 **不是 `role="dialog"`、没有 `aria-modal`、没有 Tab 焦点圈禁**——稿没规定，本卡没做；Tab 可以走到抽屉外的表格与分页。
- **焦点路径**：打开抽屉 → 焦点到关闭按钮（`:586`）；关闭（按钮 / `Esc` / 遮罩）→ 焦点回该行标题（`:598-599`），
  该行已不在页面上 → 回打开前的 `document.activeElement`（`lastTrigger`，`:576`）。
- **键盘可达**：行标题与告警 ID 是 `<button type="button">`（`:355-361`，Tab 到达、Enter / Space 打开抽屉）；
  分页、每页档位、队列开关、抽屉底部按钮都是原生 `<button>`；每页档位用 `aria-pressed` 表示当前档（`:457`）。
- **`Esc`**：仅当抽屉打开时关闭抽屉（`keydown` 挂在页面宿主上，`:778`），其它情况不吞键盘事件。
- **播报**：`role="status" aria-live="polite"` 的 `sr-only` 节点（`:119`）承载「已载入 N 条，共 M 条」/「已选 N 条」/
  「自动研判已暂停」/「复制失败，请手动选择 …」；列表级错误块是 `role="alert"`（`:415`）。
- **焦点可见**：复选框与行内按钮的 `:focus-visible` 是 2px `--accent` 外框（`alerts.css:133`、`:169`），不靠颜色单通道（外框 + 位置）。
- **减少动效**：`@media (prefers-reduced-motion: reduce)` 关掉抽屉入场动画、表格过渡与刷新图标旋转（`alerts.css:525-529`）。
- **对比度**：本页不写色值，全部取 `theme.css` 令牌（浅深两套，`theme.js` 切换）；`critical` 与 `high` 共用 `--danger`（见 `coding-reports/P002-T003.md` 未决 7）。

### 10.6 稿上有、接口没有 → 本页没有（A2）

已全部记进 `~/.plantree/hids-ai-console/plans/002-frontend/topics/backend-findings.md` 的「P002-T003」一节，这里只列清单：

1. ~~**筛选条**~~ **已回填（P003-T007）**：`GET /api/alerts` 自 P003-T001 起认 `type/level/q/from/to/sort/triage_status/verdict`，
   整条按稿渲染并下推（含稿上没有的时间范围，取值见 10.1）。
2. ~~**等级排序 / 时间排序按钮**~~ **已回填（P003-T007）**：`sort=time|level` 两个按钮都接真参数；
   稿的「同列再点切换升降序」只有降序可用，见 10.1 最后一行。
3. **队列条「查看 N 条失败」**：一键跳转没做——研判状态下拉里选「失败」就是等价操作；失败数仍然显示（`counts.failed` 是真的）。
4. **抽屉「场景」行**：接口只有 `scenario`（= 事件类型中文名），与「事件类型」重复。
5. ~~**抽屉「缺失证据」**~~ **已渲染**：`TriageCase` schema 没列这个键（`openapi.yaml:803-816`，`additionalProperties: true` 允许），
   但实现返回体里有（`triage-monitor.js:108`，done 态由 `:385` 从 `verdict.missing_evidence` 填值），稿也画了（`alerts.html:1139`）——
   按实现渲染：`done` 且有值才显示，文案「缺失证据：A、B」，空数组与未研判 `hidden`。
   稿只放了空 `<p>`、没写文案，文案按最近邻取（同页「已验证事实 N 条」的标签式写法），记账在 `coding-reports/P002-T003.md`。
6. **抽屉的证据来源按分类拆条**：抽屉只有 `verified_facts` / `evidence_sources` 两个数量；条目级证据在详情页（11.6，P003-T007 已接）。

页脚「完整证据链…可在详情页查看」保留；详情页在 T004。

### 10.7 样式与落点

- `assets/pages/alerts.css`：只写本页独有的块（筛选条 / 表头排序 / 队列条 / 批量条 / 表格 / 分页 / 抽屉 / 遮罩 / 空态 / 错误态），
  壳的部分（`.app/.rail/.bar/.content/.textbtn/.placeholder`）留在 `app.css`，不重复定义；颜色只用 `theme.css` 变量。
- **样式由页面模块注入**：`pages/alerts.js` 首次 `render` 时往 `<head>` 插 `<link data-page-style="alerts">`（重复 render 不重复插）。
  原因：`web/index.html` 与 `assets/app.css` 不在本卡 scope 里，入口不能改。
- 稿里「共 N 条 · 更新时间 · 刷新」在顶栏，顶栏属壳（`src/views/shell.js`，forbidden）→ 挪到内容区首行（`.page-tools`）。
- 断点照稿 §6：≥1100 显示 IP；≤1100 收导航 + 藏 IP；≤900 藏时间；≤760 藏 ID 与类型、抽屉占满宽度；≤620 藏资产。
  各档实测无横向滚动（见 `coding-reports/P002-T003.md`）。
- 稿没有的两格，按最近邻取值并记账：列表级错误块（登录页错误横幅的最近邻）、研判失败任务的步骤节点（按已完成节点画）。
- **动效令牌映射**：稿在自己 `:root` 里定义了 `--ease: cubic-bezier(.2,.7,.3,1)`（`alerts.html:86`），仓里没有这个名，
  只有值完全相同的 `--ease-out`（`app.css:98`）——本页 8 处缓动全部用 `var(--ease-out)`（复审前误写 `var(--ease)`，静默退化成浏览器默认曲线，已改）。

### 10.8 失败与退化

| 情形 | 页面怎么退化 |
| --- | --- |
| 没有数据（`total === 0`） | 表内一行「暂无告警。」；上一页/下一页/全选 `disabled`；「共 0 条」 |
| 部分类型查不到（回包 `partial: true`） | 表格上方提示条逐类列出原因；总数只合计成功的类型；页面照常可用 |
| 扫描窗口被截断（回包 `truncated: true`） | 提示条说明总数只含窗口内匹配，并建议缩小时间范围或加类型条件；列表照常可用 |
| 列表请求失败 | 表位置换 `role="alert"` 块：按 `kind` 分四类文案（登录已失效 / 接口不可用 / 无法连接 / 返回异常+状态码 / 返回格式异常）+「重试」按钮；刷新按钮恢复可用 |
| 队列状态单独失败 | **只降级队列条**：状态「状态不可用」、四个计数全是「—」、开关隐藏、右侧一行失败原因；列表与分页不受影响 |
| 慢网 / 超时 | **前端不设超时**（`src/alerts.js` 用 `fetch` 的默认行为，没有 `AbortController`）：请求未返回前保持加载态，刷新按钮 `disabled`；用户可重试但不能中途取消 |
| 分页越界（两次请求间数据变少） | 游标拉回最后一页并**重拉一次**（`pages/alerts.js:637-642`）；重拉只做一次，不做无限重试 |
| 剪贴板不可用（非安全上下文） | 不报错：`sr-only` 播报「复制失败，请手动选择 <id>」 |
| 图片 / 外部字体加载失败 | **不适用**：本页无图片；令牌色与字体失败时回落系统字体（`app.css` 已声明 fallback），布局不变 |
| JS 未加载 | **不适用（纯客户端渲染）**：本页由 `app.js` 挂载，脚本跑不起来就没有内容槽——壳已有此限制，非本页特有 |


## 11. 告警详情页（`pages/alert-detail.js`，P002-T004）

一条告警的全貌：结论、依据、证据缺口、研判步骤、证据来源、核验与复核、原始事件。
设计稿 `design/alert-detail.html` + `alert-detail-notes.md`；字段只来自本仓接口，接口没有的一律不画（第 9.5 节列了每一条）。

### 11.1 数据来源：形态 B · 五个 operation

| # | operation | 出处 | 用途 |
| --- | --- | --- | --- |
| 1 | `GET /api/alerts/{alertId}`（`getAlert`） | `openapi.yaml:158-176`；实现 `server.js:347-355` → `cloudwalker.js:148-163` | 告警本体 + 牧云原始事件 |
| 2 | `GET /api/agent/triage/{alertId}`（`getTriageRecord`） | `openapi.yaml:238-248`；`server.js:220-231` | 研判状态、步骤、结论标签、缺口 |
| 3 | `POST /api/agent/triage/{alertId}`（`retryTriage`） | `openapi.yaml:249-260`；`server.js:231`（202） | 「加入研判队列 / 重新研判」 |
| 4 | `GET /api/agent/investigations/{alertId}?mode=triage|deep` | `openapi.yaml:295-312`；`server.js:326-333` | 结论摘要/报告、依据、所需证据、核验、复核、证据条目 |
| 5 | `GET /api/trace/boards/{target}` | `openapi.yaml:353-371`；`server.js:169-176` | 关联实体（`nodes[]`） |

失败口径（`web/src/alert-detail.js` 的 `request`）：

| 情况 | kind | 页面表现 |
| --- | --- | --- |
| 401 | `unauthorized` | 整页错误「登录已失效」 |
| 503 | `unavailable` | 整页错误「告警接口不可用」（动作失败时说「服务端尚未配置自动研判」） |
| 400（事件类型/ID 无效） | `invalid_id` | 「没有找到这条告警」+ 返回链接 |
| 502 及其它非 2xx | `http` | 整页错误带状态码 + 重试 |
| fetch 抛 | `network` | 「无法连接」+ 重试 |
| 2xx 非 JSON / 形状不对 | `invalid` | 「返回格式异常」 |
| 404（仅 operation 4、5） | — | **不抛**，返回 `null`：没有研判记录 / 没有白板 |

### 11.2 adapter 契约（`web/src/alert-detail.js`，本页唯一 HTTP 处）

```js
getAlert(alertId, options?)                  → Promise<{ alert, detail }>   // detail 非对象时给 {}
getTriageRecord(alertId, options?)           → Promise<TriageCase>
enqueueTriage(alertId, options?)             → Promise<TriageCase>          // POST，202
getInvestigation(alertId, { mode }?, opts?)  → Promise<Investigation | null>// 默认 mode=triage；404→null
getTraceBoard(target, options?)              → Promise<TraceBoard | null>   // 404→null
// options: { fetchImpl?, baseUrl? }（单测注入）；失败一律抛 AlertDetailError{kind,status}
```

路径里的告警 ID 一律 `encodeURIComponent`（`revshell:1` → `revshell%3A1`）；服务端 `decodeURIComponent` 后再匹配
（`server.js:346`、`:328`、`:223`）。
取研判结果时先查 `mode=triage`，为 `null` 再查 `mode=deep`——两条都 404 才当「没有研判结果」。

### 11.3 状态矩阵（六格）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| loading | 挂载 / 点刷新 | 「正在读取告警…」，业务区整块不出现，刷新与复制禁用 | 加载中再点刷新不发第二次请求 |
| empty（未研判） | `triage.status = not_queued` 且两条 mode 都 404 | 结论「待研判」+「这条告警还没有研判结论。」；依据/缺失证据/证据来源/关联实体整块隐藏；步骤区一句「还没有研判步骤…」；核验区「尚未核验」 | 概况条的事实/来源/缺口都是「—」，不拿 0 充数 |
| partial | 告警本体拿到了，研判记录或研判结果读不到 | 主体照常；状态行写「状态读取失败」（不是「未入队」），步骤或核验区写「…读取失败：<原因>」 | 状态读不到时入队按钮禁用并写「研判状态未知」 |
| error | operation 1 失败（401/503/502/网络） | 整页错误块 `role="alert"`：标题 + 原因 + 「重试」 | 重试要真的再发一轮请求 |
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
| 加入研判队列 / 重新研判 | `POST /api/agent/triage/{alertId}`；用 202 回包更新状态（不乐观改），成功后按钮转「已在队列中」并禁用；失败播报「提交失败：<原因>」且按钮恢复 |
| 深度溯源 | `<a href="#/trace/<encodeURIComponent(alertId)>">`——trace 页从 `params[0]` 取 |
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

### 11.6 样式与可访问性

- 样式文件 `web/assets/pages/alert-detail.css`，由页面模块首次 render 时插 `<link data-page-style="alert-detail">`
  （`web/index.html` 与 `assets/app.css` 不在本卡 scope）。所有选择器挂在 `.detail-page` 下，避免与别的页面串样式。
- 颜色只用 `theme.css` 变量；间距/圆角/动效只用 `app.css` 的令牌；稿里非令牌的字号/行高照抄（见 `coding-reports/P002-T004.md` 的令牌表）。
- 页面结构：页级 `h1` 由壳提供（页面标题「告警详情」），内容区告警标题是 `h2.head-title`，内容区不出第二个一级标题
  （单测钉 `host.querySelectorAll('h1').length === 0`）；每个区块是 `<section aria-labelledby>` + `<h2>`；概况条是 `<dl>`；
  步骤/依据是 `<ol>`，缺口/证据/实体是 `<ul>`；原始事件是 `<details><summary>`（键盘原生可达）。
- 状态不只靠颜色：等级有文字、结论有文字、必查证据状态有文字。

### 11.7 证据链：`evidence[]` 与 claim 的 citation 对账（P003-T007 回填）

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

## 12. 深度溯源页（`pages/trace.js` + `src/trace.js`，P002-T005）

以关系图的方式看一次溯源调研：左侧白板列表 + 新建目标，右侧点阵画布（圆点节点 + 细线关系）按调研顺序
逐个长出节点，检查器给白板摘要 / 缺口 / 调研时间线，选中节点或关系时列该对象的全部字段。
视觉照 `design/trace.html`，字段只来自本仓接口。样式在 `assets/pages/trace.css`，首次 render 时注入
（`<link data-page-style="trace">`），选择器全部挂 `.trace-page` 前缀。

### 结构（稿 → 文件）

| 稿上的区块 | 落在哪 |
| --- | --- |
| 顶栏「刷新」 | 稿在壳顶栏，本卡不改壳 → 落到内容区首行 `.trace-tools`（同 T003） |
| 左侧白板列表 / 新建目标 / 提示行 | `.side` → `.side-head`（标题 + `N 个`）/ `.new-board`（输入 + 新建）/ `.board-list` / `.side-note`（`role="status"`） |
| 画布顶栏（白板 ID · 状态 · 节点/关系数 · 回放 · 缩放） | `.stage-bar` → `.stage-title` / `.playback` / `.zoom` |
| 画布（点阵背景、圆点节点、细线关系） | `.canvas` > `.world` > `svg.edges` + `.nodes` |
| 检查器 | `.inspector`（`aria-label="检查器"`）：节点/关系字段 或 白板概览 |
| 列表级失败提示（稿没有） | `.notice[role="alert"]` + 「重试」 |

### adapter 契约（`src/trace.js`，`adapter 之外出现 fetch 即缺陷`）

| 方法 | operation | 成功返回 | 说明 |
| --- | --- | --- | --- |
| `listTraceBoards(options?)` | `GET /api/trace/boards` | `boards[]`，每项只有 `id/title/status/created_at/updated_at` | 不传参数（接口没有分页） |
| `getTraceBoard(target, options?)` | `GET /api/trace/boards/{target}` | 整块 `TraceBoard` | `target` 会 `encodeURIComponent`（冒号要编码） |
| `startTraceBoard(target, options?)` | `POST /api/trace/boards` | 202 + `TraceBoard` | 正文只有 `{ target }` |

失败一律抛 `TraceError{kind, status}`，`kind ∈ unauthorized | unavailable | notfound | http | network | invalid`：

| 场景 | kind | 页面怎么表现 |
| --- | --- | --- |
| 401 | `unauthorized` | 整页提示「登录已失效，请重新登录。」 |
| 503（模型或牧云 MCP 未配置） | `unavailable` | 整页提示带服务端原话 |
| 404（该目标还没有白板） | `notfound` | **不是故障**：画布说「没有这个白板」，列表仍可切换 |
| 400 / 422 / 502 | `http` | 提示带状态码与服务端原话（新建时进 `.side-note`） |
| fetch 抛 | `network` | 「连不上研判服务，请检查网络或稍后重试。」 |
| 2xx 形状不对 | `invalid` | 「服务返回的形状不对。」 |

### 状态矩阵（六格，全部有单测）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| 加载中 | 首次取列表 / 取选中白板详情 | 列表与画布都写「正在读取白板…」，`.trace-shell[aria-busy="true"]`，刷新与新建禁用（进行中） | `aria-busy`、`refresh.disabled` |
| 空态 | 列表成功但 `boards` 为空 | 列表「还没有白板。」；画布「没有白板」+「在左侧输入告警 ID 或 IPv4 新建。」；回放三键禁用 | `replay/pause/latest.disabled === true` |
| 部分失败 | **列表成功、选中白板详情失败** | 列表照常可点；画布按错误分两种标题：「没有这个白板」（404）/「白板读取失败」（503 等） | 列表项仍在、画布标题与说明、整页 alert 不出现 |
| 错误 | 列表接口失败 | `.notice[role="alert"]`：标题 + 服务端原话 + 「重试」；列表与画布都说失败 | `role="alert"`、重试再请求一次 |
| 超长内容 | 节点标签 / 白板 ID / 摘要 / 缺口很长 | 全部原样进 DOM（CSS 负责 `overflow-wrap` 与省略号），不截断数据 | 节点按钮文本 === 完整 label；摘要全文；缺口条数不变 |
| 禁用 | 见下 | — | 逐条断言 `disabled` |

禁用矩阵：加载中 → 刷新、新建禁用；空态 / 无节点 → 重放、暂停、跳到最新禁用；新建 POST 在飞 → 新建禁用；
白板播放完毕 → 跳到最新、暂停禁用；时间线上「节点还没出现」的条目禁用；只有一个节点 → 不启动定时器。

白板 `status` 另有三个状态（接口真值，照稿显示原值、不做中文映射）：`running`（强调色点）/`done` /
`failed`（危险色；无节点时画布写「任务失败」+ 接口 `summary`）——`interrupted` 走默认灰点（稿没有这一档）。

### 字段映射（稿元素 → 接口字段）

| 界面元素 | 字段 | 备注 |
| --- | --- | --- |
| 白板列表项 | `id`、`status` | 列表接口只给这五个键，**节点数 / 关系数 / 摘要不画**（A2） |
| 画布顶栏 | `id`、`status`、`nodes.length`、`edges.length` | 计数由已返回数组算，不是接口独有字段 |
| 节点标签 | `label`（缺了退回 `id`） | 圆点位置由前端力导向布局算（接口没有坐标） |
| 关系文字 | `rel` | 只取第一个可用关系字段，不拼接 |
| 关系端点 | `from` / `to`（都是 `node.id`） | 两端都对上节点、且两端都已出现才画 |
| 检查器（选中节点/关系） | 对象的**全部键**原样列出 | 嵌套对象转 JSON 字符串 |
| 白板概览 | `summary`、`gaps[]`、`status` | 摘要为空写「接口未返回摘要。」，缺口为空写「接口未返回缺口。」 |
| 调研过程 | `activity[].at` / `title` / `node` | `at` 转本地 `HH:MM:SS`；`detail` 不进时间线（稿每行只有一段文字） |
| 渐进显示顺序 | `activity[].node` 出现的先后，其余按 `nodes[]` 原顺序 | 见 `discoveryOrder()` |

### 交互与事件

| 动作 | 后果 |
| --- | --- |
| 点白板列表项 | `GET` 该白板详情 → 重置选中、重新布局、**从第一个节点重放**；慢请求后到时按 id 丢弃 |
| 输入框 + 「新建」/ 回车 | 空 → 提示并聚焦；格式不对 → 提示、不发请求；目标已有白板 → 直接切过去；否则 `POST` → 新白板进列表并选中，输入框清空 |
| 「刷新」 | 重新取列表与当前白板详情；请求在飞时按钮禁用并转圈 |
| 「重放」 | 从第一个节点重新开始（900ms 一个） |
| 「暂停 / 继续」 | 停掉 / 恢复定时器；按钮文案随之切换 |
| 「跳到最新」 | 一次显示全部节点与关系，停止播放 |
| 「跟随」 | `aria-pressed` 切换；开启时新节点自动居中，播放结束自动适应全图 |
| 「− / % / + / 适应」 | 缩放夹在 25%–250%；「适应」按画布尺寸算 |
| 滚轮 | 以指针为中心缩放（25%–250%） |
| 拖空白 | 平移画布（`world` 的 transform） |
| 拖节点 | 移动圆点，连线实时跟随；**拖动时自动暂停回放** |
| 点节点 | 选中，检查器列该节点全部字段，节点带 `aria-pressed="true"` |
| 点关系命中线 / 焦点上按 Enter 或空格 | 选中关系，检查器列关系字段（键盘可达） |
| 点调研过程条目 | 定位到对应节点；节点未出现时条目禁用 |
| 「取消选择」 | 回到白板概览（选中态才显示） |

### 可访问性

- 白板列表项、节点、回放按钮、缩放按钮都是 `<button>`；节点带 `aria-pressed` 表示选中态。
- 关系是 SVG 线：`.edge-hit` 带 `tabindex="0"`、`role="button"` 与可访问名「关系：A → B（rel）」，Enter / 空格可选中。
- 「新建」输入框有 `aria-label="新建溯源目标"`；提示行与播报走 `role="status" aria-live="polite"`。
- 画布容器有 `section aria-label="溯源白板"`，检查器 `aria-label="检查器"`。
- 颜色全部取 `theme.css` 令牌，深浅两套跟随主题脚本；`prefers-reduced-motion` 下动效降到 0.001ms。

### 已知限制（这一页故意没做）

- **不自动轮询**：`POST` 之后只有 202 + 当前白板，没有进度流；跑着的白板要看进度只能点「刷新」。
  稿的 `trace-notes.md` §7 把「真实任务进度驱动」列为待补。
- **列表项不显示节点数 / 关系数 / 摘要**：`GET /api/trace/boards` 只回五个键（A2，记进 `backend-findings.md`）。
- **节点没有类型中文名**：接口只有 `kind`（`asset|external_ip`）与 `address`，检查器显示 `kind` 原值，不做分组配色。
- **动效时长**：稿本页 `--dur: 160ms`，本仓全局令牌是 220ms（`app.css:96`）；本页跟着全局令牌，差 60ms 记账。
- **入口**：稿是 `trace.html?target=<id>`，本仓是 `#/trace/<target>`（第二段进 `params[0]`）；命中已有白板就选中，
  没有只预填输入框并提示点「新建」，不自动发起任务。
- 节点拖动位置只在当前会话有效，刷新 / 重新布局会重算（稿 §7 同样列为待补）。


## 13. 前置规则页（`pages/rules.js` + `src/rules.js`，P002-T006）

维护「前置规则」配置：读 `GET /api/triage/rules` 的 `config` / `revision` / `writable`，
用「表单 ⇄ JSON」双视图编辑，校验走 `POST /api/triage/rules/validate`，保存走 `PUT /api/triage/rules`。
视觉与结构来自设计稿 `rules.html`（`rules-notes.md` 是交接说明）；颜色只用 `assets/theme.css` 的令牌。

### 结构（稿 → 文件）

| 稿中区块 | 落在哪 | 备注 |
| --- | --- | --- |
| 内容区首行「刷新」 | `pages/rules.js` 的 `.rules-tools` | 稿里在顶栏，顶栏属壳（forbidden）→ 挪进内容区，与 T005 同一条处理 |
| 编辑面板头部：标题 / revision / 可写徽标 / 未保存 / 视图切换 / 撤销修改 / 复制 JSON | `.pane-head` + `.title-block` + `.pane-actions` | 文案照稿 |
| 表单区（按 config 递归生成） | `[data-role="form"]`，渲染函数 `paintForm()` / `valueEl()` | 对象 → `details.nested`（默认折叠）；数组 → `details.nested open={true}`；布尔 → 勾选框；数字 → number；字符串 → text；`null` → 原样显示，不给编辑 |
| JSON 区（行号 + 等宽文本域） | `.editor-wrap` + `[data-role="gutter"]` + `[data-role="config"]` | 行号随 `input` 与 `scroll` 同步 |
| 编辑区底栏：JSON 状态 + 光标行列 | `.editor-foot` | 表单视图显示「表单视图」 |
| 右侧 320px 操作栏：状态 / 校验 / 保存 / 操作日志 | `.side` 的四个 `.panel` / `.log` | 保存卡的令牌只存在页面内存，刷新即清 |
| 整页读取失败提示（稿没画） | `.notice` `[data-role="error"]` | 缺项：稿是演示数据，无失败态；按同批页面（T005 `.notice`）先例补 |

### adapter 契约（`src/rules.js`，`adapter 之外出现 fetch 即缺陷`）

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

### 状态矩阵（六格，全部有单测）

| 格 | 触发 | 界面 | 断言要点 |
| --- | --- | --- | --- |
| loading | 首帧 | 表单区「正在读取规则配置…」，revision / 可写 / expected_revision 全是 `—`，保存 / 撤销 / 校验禁用，`.rules-shell` 带 `aria-busy="true"` | 按钮 `disabled === true`；`[data-role="rev-value"]` 文本为 `—` |
| empty | `config === {}` | 「当前 config 为空对象。添加字段，或切到 JSON 粘贴配置。」+ 添加字段行；JSON 视图是 `{}` | 文案断言 + 新字段行存在 |
| partial | `writable === false`（只读）/ JSON 语法错 / `config` 不是对象 / 409 冲突 | 只读：徽标「只读」、控件 `disabled`、`.form-wrap.is-readonly`（`opacity:.65`、`pointer-events:none`）、JSON `readOnly`、保存禁用；语法错：底栏红字并挡住切表单与校验；非对象：表单提示「config 不是对象」；409：结果条带「刷新」 | 只读时 `form` 里所有 `input`/`select` 都 `disabled`；语法错时 `[data-role="json-wrap"]` 仍可见 |
| error | 读取失败（网络 / 401 / 502 / 503） | `.notice` 整块提示 + 「重试」；表单区「规则配置没有读到，点上方「重试」。」；已有数据时刷新失败**不清屏**，只在结果条与日志报错 | `[data-role="error"]` 的 `hidden === false`；点重试成功后重新渲染表单 |
| long-content | 深嵌套 / 超长字符串 | 表单区与 JSON 区各自内部滚动，不撑破页面；行号与行数一致 | 4 层嵌套 → 4 个 `details`；`gutter` 行数 === textarea 行数 |
| disabled | 只读 / 加载中 / 未修改 / 没填令牌 / 请求在飞 | 保存：`!writable || !dirty || !token || busy` 任一为真即禁用；撤销：`!writable || !dirty`；校验：加载中或请求在飞时禁用；刷新：请求在飞时禁用并转圈 | 逐条断言 `disabled` |

### 字段映射（稿元素 → 接口字段）

| 界面元素 | 字段 | 备注 |
| --- | --- | --- |
| 头部 revision / 状态卡 revision / 保存卡 expected_revision | `GET` 的 `revision` | 三个位置同值；`null` 显示 `null`，头部显示「无 revision」 |
| 可写徽标 / 状态卡「可写」 | `writable` | 语义是「服务端有没有配 `HIDS_RULE_ADMIN_TOKEN`」（`server.js:182`），不是当前用户权限 |
| 表单与 JSON 内容 | `config` | 表单按 JSON 类型递归生成，**不预设字段名**；`config` 结构由后端定 |
| 状态卡「条目数」 | `POST /validate` 的 `count` | 未校验显示「未校验」，校验失败显示 `—`；实现里等于 `config.rules.length`（`server.js:190`） |
| 保存 / 撤销 / 未保存 | 本地模型 vs 上次保存快照 | 纯前端状态，不来自接口 |
| 操作日志 | 本地时间 + 事件文案 | 不来自接口 |

### 交互与事件

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

### 可访问性

- 编辑面板 `section[aria-label="规则配置编辑器"]`，操作栏 `aside[aria-label="规则操作"]`；视图切换是 `role="group"` + 两枚 `aria-pressed` 按钮。
- 每组字段：字段名输入 `aria-label="字段名"`；值控件 `aria-label="值 · <字段路径>"`（如 `值 · rules / 0 / id`）；数组项按钮可访问名是「上移第 1 项 / 下移第 1 项 / 删除第 1 项」。
- 令牌输入有 `<label for>`；JSON 文本域 `aria-label="规则配置 JSON"`。
- 操作日志 `aria-live="polite"`；页面另有一个 `role="status"` 的读屏播报节点（`[data-role="sr-status"]`），汇报读取 / 校验 / 保存结论。
- 只读态除视觉置灰外，控件同时 `disabled`——键盘也改不了（稿只写「置灰不可操作」）。
- 焦点：渲染时不给焦点；「没填令牌就保存」把焦点送回令牌框。

### 已知限制（这一页故意没做）

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
