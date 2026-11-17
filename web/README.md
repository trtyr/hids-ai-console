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
| `#/alert-detail/<alertId>` | —（不在侧栏） | 告警详情 | `pages/alert-detail.js` | 占位（T004 接），参数从第二段起原样传 |
| `#/trace` | 深度溯源 | 深度溯源 | `pages/trace.js` | 已接（T005），`#/trace/<target>` 预填新建目标 |
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

## 9. 深度溯源页（`pages/trace.js` + `src/trace.js`，P002-T005）

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
