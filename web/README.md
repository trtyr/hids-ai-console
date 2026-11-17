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

## 9. 知识库页（`pages/knowledge.js` + `src/knowledge.js`）

两屏一壳：**条目列表**（搜索 / 分类筛选 / 表格）→ **条目页**（标题、元信息、目录、分节正文、
右侧条目信息与相关条目、接口字段；「条目 / 编辑」两个页签）。数据全部只读。

### 9.1 数据来源：形态 B（本仓真接口，只用两个只读 operation）

| operation | 用途 | 回包字段 | 出处 |
| --- | --- | --- | --- |
| `GET /api/wiki/pages`（`listWikiPages`） | 目录 | `pages[]: { path, id, title, status, updated, revision, characters }` | `openapi.yaml:432-451`；实现 `server.js:234-240` |
| `GET /api/wiki/pages/{pagePath}`（`getWikiPage`） | 单页 + 正文 | 同上七字段 + `content`（整篇 Markdown，**含 `---` 头部元数据**） | `openapi.yaml:452-466`；实现 `server.js:241-248` |

- 文档只钉了 `id / path / title / status` 四个字段（`openapi.yaml:858-865`，`additionalProperties: true`）；
  `updated / revision / characters / content` 是服务器侧 `wiki-store.js:26-28` 的 `metadata()` 真的回来的，逐条实测过
  （`evidence/recon/P002-T007.md` §2.4）。**字段按实现取，接口定义补全后换成明确解析，别再靠读实现。**
- 错误：`400` 路径编码无效；`404` 正文 `{"error":"ENOENT: no such file or directory, open '/…/wiki/…md'"}`——
  **含服务端绝对路径，前端不显示原文**，只按状态码给中文文案；`503`「尚未配置知识库管理员凭据」只出现在
  `health` / `sessions` 一族，本页不用它们（见 §9.6）。
- 写能力：本仓**没有**「更新页面」的接口。编辑只落本机（§9.3），界面上如实标注「正文来源：本地草稿」。

### 9.2 adapter 契约（`src/knowledge.js`，adapter 之外出现 `fetch` 即缺陷）

```js
listPages(options?) → Promise<{ pages: PageSummary[] }>
getPage(pagePath, options?) → Promise<PageSummary & { content: string }>
// options: { fetchImpl?: typeof fetch, baseUrl?: string }   // 单测注入用
// PageSummary = { path, id, title, status, updated, revision, characters }
//   path 是唯一必需字段；其余缺失时是 null（界面显「—」，不补默认状态/标题）
// 失败一律抛 KnowledgeError：kind ∈ 'unauthorized' | 'http' | 'network' | 'invalid'，附 status（可能为 null）
```

| 场景 | HTTP | 结果 |
| --- | --- | --- |
| 目录正常 | 200 `{pages:[…]}` | resolve `{ pages }` |
| 单页正常 | 200（含 `content`） | resolve 页面对象；`content` 不是字符串 → `invalid` |
| 凭据失效 | 401 | `KnowledgeError{kind:'unauthorized', status:401}`，**不发第二次请求** |
| 页面不存在 | 404 | `KnowledgeError{kind:'http', status:404}` |
| 服务异常 | 其余非 2xx | `KnowledgeError{kind:'http', status:<码>}` |
| 连不上 | fetch 抛 | `KnowledgeError{kind:'network'}` |
| 200 但不是 JSON / `pages` 不是数组 | 200 | `KnowledgeError{kind:'invalid'}` |

**本机草稿**（同文件，接口没有写回页面的能力）：

```js
DRAFTS_KEY = 'hids-wiki-drafts'                 // localStorage：{ [pagePath]: { title, body, savedAt } }
loadDrafts(storage?) → drafts
saveDraft(pagePath, { title, body }, { storage?, now? }) → { persisted, drafts }
// persisted=false 表示没写进本机存储（配额/隐私模式）——界面提示「没能存到本机」，不假装已落盘
```

### 9.3 状态矩阵（六格，稿只画了其中两格）

| 格 | 触发 | 界面 | 断言要点（已写成测试） |
| --- | --- | --- | --- |
| 默认 / loading | 进页面、点刷新 | 根节点 `aria-busy="true"`、表格一行「正在读取知识库…」、刷新与搜索/分类禁用 | `aria-busy` 是 `true`；`刷新`.disabled；`#knowledge-q`.disabled |
| empty（筛选无结果） | 搜索或分类筛到 0 条 | 「没有匹配的条目」+「换个关键词，或点「清除筛选」回到全部条目。」+ 出现「清除筛选」 | 空态 `hidden=false`；点清除后行数恢复 |
| empty（目录为空） | 接口回 `pages: []` | 「知识库还没有条目」+「目录接口返回的 pages 是空的。」 | 文案可断言；顶部计数 `0` |
| partial | 目录读到了、单条正文失败（404/5xx） | 条目页局部 notice 带原因与「重试」，列出仍在（面包屑可回列表） | notice 含「（404）」且不含服务端路径；点重试成功后正文出现 |
| error | 目录请求失败（401/5xx/连不上） | 顶部 notice：401 →「登录已失效…」；5xx →「服务返回异常（<码>），目录读取失败。」；网络 →「连不上研判服务…」 | 401 时文案不含服务端正文；重试可恢复。**口径**：刷新失败时**保留上一轮已取到的目录**（只是旧数据，不是假数据），不清空列表；只有「首次加载就失败」才是 0 行——按「清空」判红会误伤 |
| long-content | 189 条目录 / 超长标题 / 超长正文 | 表行不截断数据（靠 CSS 折行与 `overflow-wrap:anywhere`），正文列 `max-width:74ch` | 200 条目录全渲染；长标题 `textContent` 完整；长正文整段保留 |
| disabled | 刚进编辑页签 / 加载中 | 「保存草稿」「撤销修改」禁用；加载中刷新/搜索/分类禁用 | 改一个字后两个按钮启用；加载中刷新禁用 |

### 9.4 交互与事件

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
| 「保存草稿」 | 写 `hids-wiki-drafts`，刷新字数/分节/来源标注/草稿计数；写不进去则提示「没能存到本机」 |
| 「撤销修改」 | 回到上次保存的草稿 |
| `Ctrl/⌘+S` | 编辑页签下等同「保存草稿」 |
| 「复制路径」 | 写剪贴板 + toast；无 clipboard 时退回 `execCommand`，再失败提示手动复制 |
| 「刷新」 | 重取目录；**有未保存修改时不重取正文**（草稿不被接口数据盖掉），toast 说明保留 |
| 有未保存修改时离开条目 | 原生 `<dialog>`：保存并离开 / 放弃修改 / 取消 |
| 有未保存修改时离开**页面**（壳侧栏导航 / 「退出登录」/ 浏览器后退） | 同一个 `<dialog>` 三选一；取消后留在编辑页签、草稿不动 |
| 有未保存修改时关标签页 / 刷新 | 浏览器原生 `beforeunload` 拦一次；草稿存好或撤销后自动摘掉 |

**页面级离开守卫怎么实现的（壳禁改，全在 `pages/knowledge.js` 的闭包里）**

| 离开路径 | 拦法 | 可断言点 |
| --- | --- | --- |
| 壳侧栏导航（`views/shell.js:36-38` 的 `a.nav-item[href="#/…"]`）与「退出登录」 | `document` **捕获阶段** `click`：命中且 `isDirty()` → `preventDefault()` + `stopPropagation()` + 开同一个 `data-role="discard"` 弹窗；放行后「导航」写 `location.hash`、「退出登录」把点击交回壳的按钮 | 脏态点一次导航：`defaultPrevented=true`、`location.hash` 不变、`dialog.open=true`；选「取消」后哈希与编辑内容都不动；选「放弃修改」后哈希变成目标路由 |
| 浏览器后退 | 脏时 `history.pushState` 压一条**同 URL 的守卫条目**；后退只会在同 URL 上 `popstate`（无 `hashchange` → 页面不被 `app.js` 重建，草稿还在）→ 弹窗；放行时 `history.go(-2)` | 脏态 `window.dispatchEvent(new Event('popstate'))` → 弹窗且视图不动；`history.state.knowledgeUnsavedGuard === true` |
| 关标签页 / 刷新 | 脏时挂 `beforeunload`（`preventDefault` + `returnValue=''`），脏标记消失时摘掉 | 脏态派发 `beforeunload`（`cancelable`）→ `defaultPrevented=true`；保存草稿后再派发 → `false` |

- 脏标记翻转的两个收口是 `updateFoot()` 与 `showIndex()`，两处都调 `syncLeaveGuard()`；弹窗动作分两路：页内导航走 `state.pendingNav`，页面级离开走 `state.leave`，二者互斥，Esc 关闭时一起清。
- 页面模块没有 unmount 钩子（`router.js` 的 page 契约只有 `render`）→ 监听器靠 `MutationObserver`（host 被换掉时）与事件里的 `host.isConnected`（兜底）自净；旧页不会在后台继续拦导航。
- 边界：确认离开后历史栈里仍留一条同 URL 的守卫条目（浏览器不允许删历史项），所以「离开 → 再进知识库 → 后退」会先回到知识库而不是上一页；不影响正确性，也不产生空白页。

### 9.5 可访问性

- 表格有 `<caption>` 与 `scope="col"`；行标题是 `<button>`（键盘可达，可访问名＝条目标题）。
- 搜索框、分类下拉各有 `sr-only` `<label for>`；分段切换用 `aria-pressed`。
- 通知条 `role="alert"`；另有一处 `role="status" aria-live="polite"` 播报「正在读取 / 已更新 / 失败」。
- 条目页 `<h1 tabindex="-1">`：打开条目与小节跳转后焦点落到标题上；dialog 关闭后焦点回原控件。
- 深/浅两套由 `theme.js` 切换，本页颜色全部走 `theme.css` 变量。

### 9.6 稿上有、接口没有 → 藏掉（A2，明细见 `topics/backend-findings.md` 的 P002-T007 节）

| 稿上区块 | 为什么不画 |
| --- | --- |
| 标签下拉 / 分类标签增删 / 条目页「分类」标签组 | 目录与单页回包都没有 `tags` 字段；「分类」改显真实目录名（`common` / `webshell` …） |
| 列表的**摘要**与**分节**列 | 列表接口不返正文，要算就得逐条取 189 个页面；只藏这两列，其余四列都是真字段 |
| 顶栏「共 N 条 · N 份本地草稿 · 更新时间 · 刷新」 | 顶栏归壳（`views/shell.js` 禁改）→ 落在内容区顶部一行 |
| 「提交审核」按钮与弹窗 | `POST /api/wiki/sessions` 要 `X-Prompt-Admin-Token`（`server.js:250`），控制台凭据只有 Basic → 实测一律 `503`；不放死按钮 |
| 「正文来源：示例草稿（接口未定义）」 | 接口**有** `content`：正文照接口渲染，标注改成「接口正文 / 本地草稿」 |
| 稿的四个中文分类（通用口径 / 案件复盘 / 规则说明 / 值守交接） | 真实目录是 18 个英文键，不编中文名；分类选项由目录数据生成 |
| `/api/wiki/health`、维护会话、重放、发布 | 不在本页面出现（都要管理员令牌） |

### 9.7 样式与令牌

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

### 9.8 已知边界（这一版故意没做）

- 编辑只在本机，没有「已保存到服务器」（接口不存在）。刷新页面后草稿还在（localStorage），但换浏览器就没了。
- 目录不分页：`GET /api/wiki/pages` 一次回全部（本仓 189 条），表格整段渲染；要分页得后端加参数。
- 服务端的 `q` 参数没接：本地过滤零延迟且不被 50 条截断（`server.js:238-239`）。
- 401 只提示不自动登出：登出逻辑在 `app.js`（禁改），本页不重复实现。
- 头部元数据（`applies_to` / `refs` / `evidence` / `used` / `failed`）不进正文视图，在「接口字段」折叠面板里看原样回包。
