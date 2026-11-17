# HTTP API 模块（http-api）

业务 HTTP 接口的唯一入口。本页讲 `server.js` 这一个文件：它怎么把请求分发到各条路由、怎么判身份、怎么校验入参、怎么把结果封装成响应。

- 模块清单条目：[docs/modules/_breakdown.json](_breakdown.json) 里的 `http-api`
- 全局背景（进程入口、分层依赖、访问边界）：[docs/architecture.md](../architecture.md)
- 行号基准：本页的 `文件:行号` 指向 `server.js` 第 373 行版本（commit `35530d8`）。改了代码要重新核。
- 证据清单：本页每条断言的出处与验证方式见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md)

## 1. 模块职责与边界

**职责**：`server.js` 只做 HTTP 层的四件事——分发路由、判身份、校验入参、把结果封装成响应。业务逻辑不在这个文件里：研判在 `investigation-agent.js`，规则在 `triage-rules.js`，研判队列在 `triage-monitor.js`，判据库在 `wiki-store.js`。本页只讲 HTTP 这一层。

**关键路径**：`server.js:130` 是全部 HTTP 逻辑的入口——一个 `http.createServer` 回调；认证闸门在 `server.js:131`，未捕获异常的出口在 `server.js:357-359`。

**覆盖构件**（拆卡清单里的 `components` 字段，本页逐块对应）：

| 构件 | 在哪一节 |
| --- | --- |
| 路由分发 | [第 3 节](#3-路由分发) |
| Basic 认证 | [第 4 节](#4-basic-认证) |
| 管理员令牌校验 | [第 5 节](#5-管理员令牌校验) |
| SSE 流式响应 | [第 6 节](#6-sse-流式响应) |
| 分页参数校验 | [第 7 节](#7-分页参数校验) |

**普通响应有三种形状**，别混着读（SSE 是第四种，见第 6 节）：

- **JSON 对象**：`json()` 写 `Content-Type: application/json; charset=utf-8`，并附 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`（`server.js:53-56`）。
- **JSON 错误**：`error()` 把消息包成 `{ "error": "..." }` 后走同一个 `json()`（`server.js:57`）。
- **纯文本 401**：认证失败时的正文是「需要登录后访问」，不是 JSON，也没有 `Content-Type: application/json`（`server.js:66-70`）。

**两个没有使用点的参数**：`createServer` 收了 `knowledge`（`server.js:112`）与 `maintenanceEntry`（`server.js:115`），但整个 `server.js` 里再没有第二处提到它们——`grep -n "knowledge\|maintenanceEntry" server.js` 只命中这两行。本页不描述它们的行为，因为没有行为可描述。

## 2. 启动与依赖装配

**关键路径**：`server.js:24` 到 `server.js:50` 是模块级装配，`server.js:112-116` 是 `createServer` 的签名，`server.js:363-370` 是进程入口。

模块被加载时就建好的东西：

| 件 | 位置 | 缺配置时的结果 |
| --- | --- | --- |
| 运行态根目录 `root` | `server.js:24` | 恒为「本文件所在目录的上一级」 |
| 监听地址与端口 | `server.js:25-26` | `HIDS_HOST` 缺省 `127.0.0.1`，`HIDS_PORT` 缺省 `8080` |
| 牧云网关 `gateway` 与 API 工具箱 `apiToolbox` | `server.js:27-31` | 牧云地址或 Token 缺一个 → 两者为 `null` |
| 模型 `model` 与两个研判器 | `server.js:32-37` | `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 缺任一项 → `model` 为 `null`，两个研判器也是 `null` |
| 研判记录、规则集、研判队列、判据工作台、溯源白板 | `server.js:38-50` | 队列要 `gateway` 与研判器、白板要 MCP 工具箱与模型，缺任一则该件为 `null` |

`root` 的含义容易看错：`server.js:24` 解析出来的是「仓库目录的上一级」，所以运行态数据落在 `<上一级>/backend/.data/`，不是仓内 `.data/`。这条规则的完整说明在 [architecture.md](../architecture.md) 第 8.1 节。

**`createServer` 是依赖注入点**（`server.js:112-116`）：14 个参数都带默认值，默认指向模块级单例。测试与探针靠传替身换掉 `service`、`investigator`、`history`、`monitor`、`wiki`、`wikiAgent` 这些件。其中 `monitor` 与 `boardService` 的默认值写成「`service` 是不是模块级 `gateway`」的条件式——换了 `service`，就不再挂默认的研判队列与溯源白板。

**规则预筛挂在 `investigate()` 闭包上**（`server.js:117-128`）：`mode === 'triage'` 且 `monitor.ruleEngine` 存在时，先跑一次规则评估，把结果作为 `rule_evaluation` 挂到结论上；评估抛错就记成 `{ status: 'error' }` 继续往下走，不中断研判。

**进程入口**（`server.js:363-370`）：`process.argv[1]` 的真实路径等于本文件路径时才启动监听，并打印 `HIDS API: http://<host>:<port>`；随后若输入模式是 `syslog`，再起一个 UDP 接收器。

## 3. 路由分发

**关键路径**：`server.js:130`（处理函数）、`server.js:132`（路径解析）、`server.js:134` 到 `server.js:354`（依次排列的分支）、`server.js:355-356`（404 兜底）。

**分发机制**：没有路由表，是一条 `if` 链。每一支的形状都是「路径条件 + 方法条件」，命中即 `return`，后面的分支不再看。因此**分支顺序决定谁先赢**：`GET /api/agent/triage/status`（`server.js:178-179`）排在 `GET /api/agent/triage/{alertId}`（`server.js:220-227`）前面，所以 `status` 这个词不会被当成告警 ID。

路径与查询串由 `new URL(req.url, 'http://' + (req.headers.host || 'localhost'))` 解析（`server.js:132`），后面的判断都用 `url.pathname` 与 `url.searchParams`。

### 3.1 路由表

31 条「路径 + 方法」组合。「前置条件」写的是这条路由在缺件时的表现；「出处」是该分支所在的行。

> 源码里与路径有关的分支条件也是 31 行（`grep -c "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js` → `31`），但两者不是同一个单位：`/api/agent/triage/{alertId}` 一行分支给出 GET 与 POST 两条组合（`server.js:220-227`），`server.js:234` 那行只是 `/api/wiki/` 的分组入口，不算一条组合。

| 方法 | 路径 | 成功状态 | 前置条件 | 出处 |
| --- | --- | --- | --- | --- |
| GET | `/api/session` | 200 `{authenticated:true}` | — | `server.js:134-135` |
| GET | `/api/updates` | 200 升级包概览 | — | `server.js:134-135` |
| GET | `/api/status` | 200 / 502 | 无 service 时也回 200 | `server.js:136-139` |
| GET | `/api/agent/tools` | 200 工具清单 | 无 API 工具箱回 503 | `server.js:141-149` |
| GET | `/api/trace/tools` | 200 工具清单 | 无 MCP 工具箱回 503 | `server.js:141-149` |
| GET | `/api/agent/status` | 200 | — | `server.js:151-155` |
| GET | `/api/trace/boards` | 200 白板列表 | 无白板服务回 503 | `server.js:157-177` |
| POST | `/api/trace/boards` | 202 | 无白板服务回 503 | `server.js:157-177` |
| GET | `/api/trace/boards/{target}` | 200 / 404 | 无白板服务回 503 | `server.js:157-177` |
| GET | `/api/agent/triage/status` | 200 | 无研判队列回 503 | `server.js:178-179` |
| GET | `/api/triage/rules` | 200 | 读取失败回 502 | `server.js:181-184` |
| POST | `/api/triage/rules/validate` | 200 | 规则集不合法回 400 | `server.js:186-191` |
| PUT | `/api/triage/rules` | 200 | 需规则管理员令牌 | `server.js:193-203` |
| GET | `/api/agent/triage/cases` | 200 | 无研判队列回 503 | `server.js:205-211` |
| PUT | `/api/agent/triage/control` | 200 | 无研判队列回 503 | `server.js:213-218` |
| GET | `/api/agent/triage/{alertId}` | 200 | 无研判队列回 503 | `server.js:220-227` |
| POST | `/api/agent/triage/{alertId}` | 202 | 无研判队列回 503 | `server.js:220-227` |
| GET | `/api/agent/prompts` | 200 | — | `server.js:229-233` |
| GET | `/api/wiki/pages` | 200 | — | `server.js:234-249` |
| GET | `/api/wiki/pages/{path}` | 200 / 404 | — | `server.js:234-249` |
| GET | `/api/wiki/health` | 200 | 需知识库管理员令牌 | `server.js:250-277` |
| GET | `/api/wiki/sessions` | 200 | 需知识库管理员令牌 | `server.js:250-277` |
| POST | `/api/wiki/sessions` | 201 | 需知识库管理员令牌 | `server.js:250-277` |
| GET | `/api/wiki/sessions/{id}` | 200 / 404 | 需知识库管理员令牌 | `server.js:278-299` |
| POST | `/api/wiki/sessions/{id}/messages` | 200 | 需知识库管理员令牌 | `server.js:278-299` |
| POST | `/api/wiki/sessions/{id}/replay` | 200 | 需知识库管理员令牌 | `server.js:278-299` |
| POST | `/api/wiki/sessions/{id}/publish` | 200 | 需知识库管理员令牌 | `server.js:278-299` |
| POST | `/api/agent/investigations` | 200 | 无研判器回 503 | `server.js:301-305` |
| GET | `/api/agent/investigations/{alertId}` | 200 / 404 | — | `server.js:326-333` |
| GET | `/api/alerts` | 200 | 无牧云服务回 503 | `server.js:335-342` |
| GET | `/api/alerts/{type}:{id}` | 200 | 无牧云服务回 503 | `server.js:344-354` |

### 3.2 不是路由的固定响应

三条路径不查后端，直接回固定结果：

| 条件 | 状态 | 正文 | 出处 |
| --- | --- | --- | --- |
| `/api/agent/prompts` 用了非 GET 方法 | 405 | 请使用提示词文件上传入口 | `server.js:232` |
| `/api/agent/prompts/upload` | 410 | 提示词更新已迁移到独立维护端，业务端不允许上传 | `server.js:229-233` |
| `/api/` 开头的未知路径 | 404 | 接口不存在 | `server.js:355-356` |

405 在整个文件里只有这一处（`grep -n "405" server.js` 只命中 `server.js:232`）。**方法对不上的路径，除这一处外都落到 404**：`POST /api/session` 与 `POST /api/triage/rules` 都回 404「接口不存在」。非 API 路径（如 `/`）也回同一句 404（`server.js:355-356`）。但 404 有两种文案——`/api/` 下的未知路径回「接口不存在」（`server.js:355-356`），`/api/wiki/` 下的未知路径回「知识库接口不存在」（`server.js:278-299`）。

### 3.3 路径里的 ID

三段式 ID（类型 + 序号）从路径尾部取出来，解码后要过校验：

| 校验函数 | 接受什么 | 用在哪 | 出处 |
| --- | --- | --- | --- |
| `validAlertId` | `<小写类型>:<正整数>`，类型须在事件类型表里，序号须是安全整数 | `GET /api/agent/investigations/{alertId}`（`mode=deep` 时）、单条告警路由的类型段 | `server.js:100-103` |
| `validTriageId` | `validAlertId`，或 syslog 形态 `syslog:<类型>:<16 位十六进制>:<数字或 unknown>:<36 位 UUID>` | `GET/POST /api/agent/triage/{alertId}`、`GET /api/agent/investigations/{alertId}`（`mode=triage` 时） | `server.js:104-106` |
| `validTraceTarget` | 告警 ID，或去掉 `ip:` 前缀后的 IPv4（每段 ≤ 255） | 溯源白板三条路由 | `server.js:107-111` |

解码失败与校验失败给的是不同的文案：解码失败回「告警 ID 编码无效」，校验失败回「告警 ID 无效」或「告警 ID 或研判模式无效」。

## 4. Basic 认证

**关键路径**：`server.js:131`（闸门位置）、`server.js:58-65`（`hasAccess`）、`server.js:66-70`（`requireAccess`）。

**闸门在请求处理函数的第一行**（`server.js:131`），先于 URL 解析与全部路由。认证不通过就直接回 401，不会碰任何路由分支——连 `/api/session` 这种专门问「我是不是已登录」的接口也拿不到。

**开关语义**：`hasAccess()` 的第一行是「没配密码就放行」（`server.js:58-65`）。具体条件是 `access.password` 为空即返回 `true`——`HIDS_BASIC_AUTH_PASSWORD` 没设，或者设成空串，效果一样：接口不校验身份。用户名没配时按 `admin` 比对。

**比较方式**：请求头必须以 `Basic ` 开头，取后面的 Base64 解码成字节，与 `user:password` 的字节做 `timingSafeEqual`。字节长度不等时先判否，不进 `timingSafeEqual`（`server.js:58-65`）。

**401 的形状与其它错误不同**（`server.js:66-70`）：状态码 401，响应头带 `WWW-Authenticate: Basic realm="HIDS AI Console", charset="UTF-8"`，正文是纯文本「需要登录后访问」——不是 `{error:...}`，也不是 JSON。探针实测：

```
A1 无凭据 | 401 | www-authenticate="Basic realm=\"HIDS AI Console\", charset=\"UTF-8\"" | body="需要登录后访问"
A2 错密码 | 401 | 需要登录后访问
A3 正确凭据 | 200 | {"authenticated":true}
A4 非 Basic 前缀 | 401 | 需要登录后访问
A5 根路径 / | 401 | 需要登录后访问
A6 空密码放行 | 200 | {"authenticated":true}
```

（完整命令见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第三节的探针脚本。）

这一层只管业务 API 这个进程。维护端是另一个进程，认证方式不同，见 [architecture.md](../architecture.md) 第 9.4 节。

## 5. 管理员令牌校验

**关键路径**：`server.js:71-78`（知识库令牌）、`server.js:79-86`（规则令牌）、`server.js:194-195`（规则侧判定顺序）、`server.js:248-249`（知识库侧判定顺序）。

**两套令牌各管一片**，请求头不同：

| 令牌 | 请求头 | 管谁 | 比较函数 |
| --- | --- | --- | --- |
| `HIDS_PROMPT_ADMIN_TOKEN` | `x-prompt-admin-token` | 知识库（判据页维护、会话、发布、健康检查） | `server.js:71-78` |
| `HIDS_RULE_ADMIN_TOKEN` | `x-rule-admin-token` | 误报规则集写入 | `server.js:79-86` |

两个比较函数的形状一样：令牌没配就返回 `false`；请求头必须是字符串；字节长度相等才走 `timingSafeEqual`。

**判定顺序是三档**，以规则写接口为例（`server.js:194-195`）：

| 情况 | 状态 | 正文 |
| --- | --- | --- |
| 令牌没配 | 503 | 尚未配置规则管理员令牌 |
| 令牌不匹配 | 403 | 规则管理员令牌无效 |
| 令牌匹配 | 进业务分支 | — |

知识库侧同构，只是文案换成「尚未配置知识库管理员凭据」与「知识库管理员凭据无效」（`server.js:248-249`）。

**一个容易看错的后果**：知识库分支里，两个读接口排在令牌判定之前（`server.js:234-249`），所以 `GET /api/wiki/pages` 与 `GET /api/wiki/pages/{path}` 只要过了 Basic 认证就能读，不需要管理员令牌。但也因此，`/api/wiki/` 底下**别的**路径——包括不存在的路径——会先撞上令牌判定：探针里不带令牌请求 `/api/wiki/unknown-path` 得到的是 403「知识库管理员凭据无效」，不是 404。

规则侧的读接口 `GET /api/triage/rules` 不需要令牌，但响应里带一个 `writable` 字段，表示当前能不能写（`server.js:181-184`）。

## 6. SSE 流式响应

**关键路径**：`server.js:301-305`（进入判定）、`server.js:306-319`（流式分支）、`server.js:320-324`（非流式分支）。

**触发条件**：`url.searchParams.get('stream') === '1'`（`server.js:306-319`）——**精确等于字符串 `1`**。`stream=0`、`stream=true` 都拿不到流式响应，会走普通 JSON 分支（探针 D3 实测两个值都回 `application/json`）。

**前置判定排在流式分支之前**（`server.js:301-305`）：请求正文先读出来，正文不是对象回 400「请求正文无效」；没有研判器回 503「该研判模式的模型或牧云取证接口尚未配置」。也就是说 `stream=1` 并不绕过配置检查——没配模型时它回的是 503，不是 SSE（探针 D4）。

**响应头**（`server.js:307-308`）：

| 头 | 值 |
| --- | --- |
| `Content-Type` | `text/event-stream; charset=utf-8` |
| `Cache-Control` | `no-store` |
| `Connection` | `keep-alive` |
| `X-Content-Type-Options` | `nosniff` |

**帧格式**：`data: <JSON>\n\n`（`server.js:309`）。响应已销毁或已结束时不写。帧里的 `type` 有三种：

| type | 内容 | 出处 |
| --- | --- | --- |
| `progress` | `{stage, detail}`，由研判过程的 `onProgress` 回调发出 | `server.js:313-314` |
| `result` | `{result: <history.save() 的返回值>}`——发出去的是落盘之后的对象 | `server.js:315` |
| `error` | `{error: <异常消息>}` | `server.js:316` |

**心跳**：每 15000 毫秒写一行 `: heartbeat\n\n`（`server.js:310`），这是 SSE 的注释行，客户端按协议忽略它。连接关闭时清掉定时器（`server.js:311`），`finally` 里再清一次并结束响应（`server.js:317`）。

**异常也回 200**：研判过程抛错时，状态码仍是 200，错误以 `error` 帧的形式发给客户端（`server.js:316`）。探针 D2 实测：

```
D2 异常 status=200 body="data: {\"type\":\"error\",\"error\":\"模型服务不可用\"}\n\n"
```

完整的一次流式响应（探针 D1，替身研判器发了两段进度）：

```
D1 status=200 content-type="text/event-stream; charset=utf-8" cache-control="no-store" connection="keep-alive"
D1 原始报文="data: {\"type\":\"progress\",\"stage\":\"查询证据\",\"detail\":\"正在查询 list_host_events\"}\n\ndata: {\"type\":\"progress\",\"stage\":\"独立复核\",\"detail\":\"正在核对结论\"}\n\ndata: {\"type\":\"result\",\"result\":{\"alert_id\":\"revshell:7\",\"mode\":\"deep\",\"verdict\":{\"verdict\":\"undetermined\"},\"saved_at\":\"2026-11-17T00:00:00.000Z\"}}\n\n"
```

**与非流式分支的差别**（`server.js:320-324`）：走的是同一次 `investigate()`，结果用 `json()` 包装。差别在错误处理——非流式分支把消息命中「告警 ID 无效|研判模式无效」的错误映射成 400，其余映射成 502；流式分支没有这层映射，异常一律变成 `error` 帧（状态码仍是 200）。判断「这次研判成功没有」要看帧里的 `type`，不能只看状态码。

## 7. 分页参数校验

**关键路径**：`server.js:207-210`（案件目录）、`server.js:337-339`（告警列表）。

分页参数出现在两条路由上，规则一样：

| 路由 | 出处 |
| --- | --- |
| `GET /api/agent/triage/cases` | `server.js:207-210` |
| `GET /api/alerts` | `server.js:337-339` |

**取值与边界**：

| 参数 | 缺省值 | 合法范围 | 不合法时 |
| --- | --- | --- | --- |
| `count` | 20 | 1 到 50 之间的安全整数 | 400「分页参数无效」 |
| `offset` | 0 | 大于等于 0 的安全整数 | 400「分页参数无效」 |

取值写法是 `Number(url.searchParams.get('count') || 20)`：参数缺省与传空串都落回缺省值；传 `abc` 得到 `NaN`，`isSafeInteger` 判否；传 `20.5` 也不是整数，一样判否。

**判定顺序**：先判后端有没有配，再判分页。

- `GET /api/alerts` 先判牧云服务在不在（`server.js:335-342`），没有就回 503，分页参数根本没被读到。
- `GET /api/agent/triage/cases` 先判研判队列在不在（`server.js:205-211`），没有就回 503。

探针实测（`/api/alerts` 有牧云服务、`/api/agent/triage/cases` 有研判队列时）：

```
C /api/alerts?count=0 | 400 | {"error":"分页参数无效"}
C /api/alerts?count=51 | 400 | {"error":"分页参数无效"}
C /api/alerts?count=abc | 400 | {"error":"分页参数无效"}
C /api/alerts?count=20.5 | 400 | {"error":"分页参数无效"}
C /api/alerts?offset=-1 | 400 | {"error":"分页参数无效"}
C /api/alerts?count=20&offset=0 | 200 | {"alerts":[],"total":0,"totals":{},"errors":{},"partial":false,"echo":{"count":20,"offset":0}}
C /api/alerts?count=50 | 200 | {"alerts":[],"total":0,"totals":{},"errors":{},"partial":false,"echo":{"count":50,"offset":0}}
C /api/alerts | 200 | {"alerts":[],"total":0,"totals":{},"errors":{},"partial":false,"echo":{"count":20,"offset":0}}
C2 /api/alerts?count=0（无 service） | 503 | {"error":"未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN"}
C3 /api/agent/triage/cases?count=0（无 monitor） | 503 | {"error":"自动研判尚未配置"}
```

## 8. 请求正文与错误翻译

**关键路径**：`server.js:87-94`（`readJSON`）、`server.js:357-359`（未捕获异常的出口）。

### 8.1 正文长度上限

`readJSON(req, maxLength = 8192)` 把请求体读成字符串再 `JSON.parse`（`server.js:87-94`）。上限量的是拼接后字符串的长度（`body.length`），不是字节数。两条报错：

| 情况 | 抛出 | 出处 |
| --- | --- | --- |
| 长度超过上限 | 请求正文过大 | `server.js:91` |
| 不是合法 JSON | 请求正文不是 JSON | `server.js:93` |

各路由传进去的上限不一样：

| 上限 | 路由 | 出处 |
| --- | --- | --- |
| 8192（缺省） | `PUT /api/agent/triage/control`、`POST /api/wiki/sessions`、`POST /api/agent/investigations` | `server.js:213-218`、`server.js:250-277`、`server.js:301-305` |
| 100000 | `POST /api/triage/rules/validate`、`PUT /api/triage/rules` | `server.js:186-191`、`server.js:193-203` |
| 12000 | `POST /api/wiki/sessions/{id}/messages` | `server.js:278-299` |
| 8192（显式传值） | `POST /api/wiki/sessions/{id}/publish` | `server.js:278-299` |

### 8.2 正文形状

`readJSON` 只保证「是合法 JSON」，不保证形状。形状由各路由自己判：不传 `expected_revision` 的规则写请求回 400「缺少有效的规则配置版本」（`server.js:193-203`）；正文不是对象或数组的回 400「请求正文无效」（`server.js:213-218`、`server.js:301-305`）。

### 8.3 错误怎么翻译

未捕获的异常从最外层出口走（`server.js:357-359`）：消息里含「请求正文」四个字的回 400，其余回 502；异常没有消息时用「牧云请求失败」兜底。错误体统一是 `{ "error": "<消息>" }`（`server.js:57`）。

于是「请求正文过大」和「请求正文不是 JSON」都落到 400——探针 F1/F2 实测：

```
F1 POST /api/agent/investigations 正文 8193 字节 | 400 | {"error":"请求正文过大"}
F2 POST /api/agent/investigations 正文 8192 字节 | 400 | {"error":"请求正文不是 JSON"}
```

这两个 400 是靠消息文案里的「请求正文」四个字匹配出来的，不是靠错误类型区分的。

## 9. 边界与未决

### 9.1 与 `openapi.yaml` 的关系

对外 HTTP 契约在 `openapi.yaml`，声明 35 条路径（`grep -c '^  /' openapi.yaml` → `35`）。它与 `server.js` 的路由是**分开维护的两份文本**，改路由时两边都要动（这条在 [architecture.md](../architecture.md) 第 11.3 节也记着）。本页只描述 `server.js` 实际跑出来的行为；两边逐条比对不是本卡做的事。

### 9.2 状态码用得不太齐的地方（只陈述现状）

- **405 只有一处**（`server.js:232`）。方法对不上的路径，除这一处外都落到 404。
- **404 有两种文案**：未知 API 与非 API 路径回「接口不存在」（`server.js:355-356`），`/api/wiki/` 下的未知路径回「知识库接口不存在」（`server.js:278-299`）。
- **503 有两类含义**：后端某一类件没配好（牧云整体没配 `server.js:95-99`、研判队列未配置 `server.js:178-179`、工具箱未配置 `server.js:141-149`），与管理员令牌没配（`server.js:194-195`、`server.js:248-249`），文案不一样。
- **`/api/status` 不走 503**：没配牧云时回 200，用 `configured` / `connected` 两个字段说明状态（`server.js:136-139`）。
- **SSE 里没有状态码级的失败**：研判抛错也是 200，错误在帧里（`server.js:316`）。

### 9.3 本卡没查到的

1. **牧云侧的真实响应**：本机没有 `CLOUDWALKER_URL` / `CLOUDWALKER_API_TOKEN`，未发起任何外部请求。`/api/alerts`、`/api/alerts/{type}:{id}`、`/api/status` 的响应体形状只按代码里的组装逻辑描述。
2. **模型服务的真实行为**：没有真实模型服务，SSE 的进度段条数与内容取决于研判过程本身；本页引用的探针输出用的是替身研判器。
3. **`POST /api/wiki/sessions` 的完整链路**：令牌之后会读研判记录与案件目录（`server.js:250-277`），本卡只探到令牌与正文上限两处。

### 9.4 入口判定的一个边界

`server.js:363` 的入口判定会先对 `process.argv[1]` 做 `realpathSync`。以 `-` 作入口（stdin 方式跑）时该路径不存在，`realpathSync` 抛 ENOENT，模块在加载阶段就失败。用 `node --input-type=module -e "..."` 执行时 `process.argv[1]` 是 `undefined`，判定短路，不受影响——本页的探针就是这么跑的（见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第 5.1 节）。

## 10. 怎么复跑本页的结论

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P001-T002

# 1. 取出运行时探针并执行（覆盖认证、令牌、分页、SSE、路由分发、正文上限六组断言）
awk '/^\/\/ probe:start$/{f=1;next}/^\/\/ probe:end$/{f=0}f' evidence/recon/P001-T002.md > /tmp/httpapi-probe.mjs
HIDS_REPO=$(pwd) node /tmp/httpapi-probe.mjs

# 2. 看清本页的路由表是从哪些分支来的
grep -n "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js

# 3. 契约文件的路径条数
grep -c '^  /' openapi.yaml
```

探针不写任何文件、不连外部服务；它注入替身服务跑真实 HTTP 请求，输出见 [evidence/recon/P001-T002.md](../../evidence/recon/P001-T002.md) 第四节。

本页只描述现状。哪一处该改、改成什么样，是评审的活，不在文档范围内。
