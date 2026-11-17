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
| `#/alerts` | 告警 | 告警 | `pages/alerts.js` | 占位（T003 接） |
| `#/alert-detail/<alertId>` | —（不在侧栏） | 告警详情 | `pages/alert-detail.js` | **已接入**（P002-T004）；参数从第二段起原样传，页面自己 `decodeURIComponent` |
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


## 9. 告警详情页（`pages/alert-detail.js`，P002-T004）

一条告警的全貌：结论、依据、证据缺口、研判步骤、证据来源、核验与复核、原始事件。
设计稿 `design/alert-detail.html` + `alert-detail-notes.md`；字段只来自本仓接口，接口没有的一律不画（第 9.5 节列了每一条）。

### 9.1 数据来源：形态 B · 五个 operation

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

### 9.2 adapter 契约（`web/src/alert-detail.js`，本页唯一 HTTP 处）

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

### 9.3 状态矩阵（六格）

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

### 9.4 交互与事件

| 动作 | 后果 |
| --- | --- |
| ← 告警列表 | `<a href="#/alerts">`（真链接，键盘可达） |
| 复制告警 ID | `navigator.clipboard.writeText(alert.id)`；成功播报「已复制 <ID>」，不可用/失败播报「复制失败，请手动选择 <ID>」 |
| 刷新 | 重新走 1→2→4→5 四轮取数；加载中禁用 |
| 加入研判队列 / 重新研判 | `POST /api/agent/triage/{alertId}`；用 202 回包更新状态（不乐观改），成功后按钮转「已在队列中」并禁用；失败播报「提交失败：<原因>」且按钮恢复 |
| 深度溯源 | `<a href="#/trace/<encodeURIComponent(alertId)>">`——trace 页从 `params[0]` 取 |
| 原始事件 / 原始 JSON | 原生 `<details>` 折叠，默认收起 |

播报容器：`[data-role="note"]`（`role="status"` + `aria-live="polite"`，可见文本）。

### 9.5 A2：稿上有、接口没有 → 藏掉（原文见 `topics/backend-findings.md`）

1. 页内顶栏 → 前四项挪进内容区首行；主题切换已在壳的顶栏里，不重复造。
2. 概况条「依据通过 `claimsPassed/claimsTotal`」→ 接口没有通过数/分母，改画 `claims.length`（校验未过时加「未通过校验」）。
3. 概况条「证据缺口 `validation.gaps`」→ 用 `missing_evidence.length`；字段缺席时显示「—」。
4. 依据条目的「已证实 / 存疑」徽标 → `claims[]` 只有 `text` + `citations[]`，改画「引用 N 处证据」+ `evidence_id`。
5. 步骤的工具名与耗时 → `steps[]` 元素只有 `{ stage, detail, at }`。
6. 证据来源的分类分组与事实文本 → 只有数量 + `evidence[]`（`evidence_id / tool / fetched_at`），平铺。
7. 核验的「证据覆盖 / 核验时间」、复核的「复核人 / 时间 / 结论 / 备注」→ `review` 是模型独立复核，没有人工复核字段。
8. 稿的「ID 不存在」页 → 接口没有 404（未知 ID 走 502），只有 400 按「没有这条告警」处理。
9. 头部「场景」行（稿映射 `scenario`）→ 与「类型」重复，不单列。

### 9.6 样式与可访问性

- 样式文件 `web/assets/pages/alert-detail.css`，由页面模块首次 render 时插 `<link data-page-style="alert-detail">`
  （`web/index.html` 与 `assets/app.css` 不在本卡 scope）。所有选择器挂在 `.detail-page` 下，避免与别的页面串样式。
- 颜色只用 `theme.css` 变量；间距/圆角/动效只用 `app.css` 的令牌；稿里非令牌的字号/行高照抄（见 `coding-reports/P002-T004.md` 的令牌表）。
- 页面结构：`h1` = 告警标题；每个区块是 `<section aria-labelledby>` + `<h2>`；概况条是 `<dl>`；
  步骤/依据是 `<ol>`，缺口/证据/实体是 `<ul>`；原始事件是 `<details><summary>`（键盘原生可达）。
- 状态不只靠颜色：等级有文字、结论有文字、必查证据状态有文字。
