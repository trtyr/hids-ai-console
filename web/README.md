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
| `#/rules` | 规则 | 规则 | `pages/rules.js` | 已接（T006）：表单 / JSON 双视图编辑 + 校验 + 保存 |
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

## 9. 前置规则页（`pages/rules.js` + `src/rules.js`，P002-T006）

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
