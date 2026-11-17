---
type: module
id: MOD-EVENT-GATEWAY
covers: [cloudwalker.js, rpc-client.js]
unit: event-gateway
updated: 2026-11-17
---

# 事件网关（event-gateway）

模块名 `event-gateway`。实现文件两个：`cloudwalker.js` 放事件语义，`rpc-client.js` 放传输。
本文只讲这两个文件，不讲 HTTP 入口怎么路由、也不讲 AI 怎么研判——那在
[architecture.md](../architecture.md) 与别的模块页里。

行号对应写这篇时的提交 `35530d8`。改了这两个文件，重新核一遍行号。

**覆盖构件**（与 [modules/_breakdown.json](_breakdown.json) 一致）：事件类型表 · RPC 方法映射 ·
只读 RPC 白名单 · 事件归一化 · 多类型合并分页。下面第 3 到第 7 节逐个点名。

## 1 职责

**做什么**：

- 维护牧云 11 类事件的类型表与服务名映射（`cloudwalker.js:2-14`）。
- 把 11 类形状各异的原始事件行，归一成同一个告警结构（`cloudwalker.js:31-58`）。
- 把 11 类事件按时间合并成一条有序序列再分页（`cloudwalker.js:84-146`）。
- 通过牧云 `/rpc` 读事件列表与详情，并且只允许只读方法名发出去（`rpc-client.js:12-29`）。

**不做什么**：

- 不做 AI 研判。归一化输出的 `verdict` 恒为「待研判」、`verdictKey` 恒为 `review`、
  `coverage` 恒为 `null`、`cases` 恒为 `0`（`cloudwalker.js:53`）。
- 不下发处置动作。本模块只调用列表与详情两个读接口，方法名受白名单约束（`rpc-client.js:13-14`）。
- 不落任何状态。两个文件里没有 `fs` / `writeFile` / `readFile` / 目录写入等持久化调用
  （复跑命令见第 16 节）。
- 不判断事件是否真。详情里的事件 ID 与请求对不上时报错，不做语义层面的真伪判断
  （`cloudwalker.js:152-154`）。

## 2 公开面

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 事件类型表 | `eventTypes`（`cloudwalker.js:2`） | 11 个类型键 → 中文名，冻结不可改 |
| RPC 服务名表 | `rpcMethods`（`cloudwalker.js:8`） | 11 个类型键 → 牧云服务名，冻结不可改 |
| 原始行 → 告警 | `normalizeAlert(type, row)`（`cloudwalker.js:31`） | 纯函数，无 IO |
| 详情 → 证据条目 | `detailEvidence(detail)`（`cloudwalker.js:60`） | 纯函数，无 IO |
| 连通性探测 | `CloudwalkerGateway.status()`（`cloudwalker.js:79`） | 探一种类型 |
| 合并列表 | `CloudwalkerGateway.alerts({ count, offset })`（`cloudwalker.js:84`） | 11 类合并分页 |
| 单条详情 | `CloudwalkerGateway.alert(type, id)`（`cloudwalker.js:148`） | 带事件身份校验 |
| RPC 传输 | `new RpcClient(baseUrl, token, fetcher?)`（`rpc-client.js:3`） | `fetcher` 默认 `fetch` |
| 一次调用 | `RpcClient.call(method, params)`（`rpc-client.js:12`） | 白名单拦截 + JSON-RPC |

`CloudwalkerGateway` 通过构造参数接收 RPC 客户端（`cloudwalker.js:77`），`RpcClient` 通过构造参数接收
`fetcher`（`rpc-client.js:3`）。两个文件都没有本地 import：

```
$ grep -n "^import\|require(" cloudwalker.js rpc-client.js
（无输出，退出码 1）
```

## 3 事件类型表

`eventTypes` 冻结了 11 个类型键与其中文名（`cloudwalker.js:2-6`）。中文名在两处被复用：
作为告警的 `scenario` 字段（`cloudwalker.js:54`），以及拼进证据文案「牧云 <中文名> 事件 #<id>」
（`cloudwalker.js:55`）。

| 类型键 | 中文名 | 类型键 | 中文名 |
| --- | --- | --- | --- |
| `webshell` | WebShell | `abnormal_login` | 异常登录 |
| `malware` | 恶意文件 | `elevation_process` | 提权进程 |
| `revshell` | 反弹 Shell | `network_audit` | 网络审计 |
| `memory_webshell` | 内存马 | `suspicious_operation` | 可疑操作 |
| `brute_force` | 暴力破解 | `honeypot` | 蜜罐 |
| `memory_security` | 内存安全 | | |

（两栏排版只为省篇幅；键的完整顺序见 `cloudwalker.js:3-5`。）

类型键还有两个用途：它是告警 `id` 的前缀，`id` 形如 `<类型键>:<事件号>`（`cloudwalker.js:46`）；
它决定 `source` / `target` 取哪套候选字段（`cloudwalker.js:36`）。

`Object.keys(eventTypes)` 的顺序即合并分页时逐类拉取的顺序（`cloudwalker.js:88`）。

## 4 RPC 方法映射

`rpcMethods` 把类型键映射到牧云服务名（`cloudwalker.js:8-14`）。完整动词规则：

- 列表方法：蜜罐是 `List`，其余 10 类都是 `GetEventList`（`cloudwalker.js:90`，注释在 `cloudwalker.js:7`）。
- 详情方法：11 类都是 `<服务名>.GetEvent`（`cloudwalker.js:150`），蜜罐也不例外。

| 类型键 | 列表方法 | 详情方法 |
| --- | --- | --- |
| `webshell` | `WebshellEventService.GetEventList` | `WebshellEventService.GetEvent` |
| `malware` | `MalwareEventService.GetEventList` | `MalwareEventService.GetEvent` |
| `revshell` | `RevshellEventService.GetEventList` | `RevshellEventService.GetEvent` |
| `memory_webshell` | `MemoryWebshellEventService.GetEventList` | `MemoryWebshellEventService.GetEvent` |
| `brute_force` | `BruteForceService.GetEventList` | `BruteForceService.GetEvent` |
| `abnormal_login` | `AbnormalLoginEventService.GetEventList` | `AbnormalLoginEventService.GetEvent` |
| `elevation_process` | `ElevationProcessEventService.GetEventList` | `ElevationProcessEventService.GetEvent` |
| `network_audit` | `NetworkAuditEventService.GetEventList` | `NetworkAuditEventService.GetEvent` |
| `suspicious_operation` | `SuspiciousOperationService.GetEventList` | `SuspiciousOperationService.GetEvent` |
| `honeypot` | `HoneypotService.List` | `HoneypotService.GetEvent` |
| `memory_security` | `MemorySecurityEventService.GetEventList` | `MemorySecurityEventService.GetEvent` |

**服务名有两种后缀**：`BruteForceService`、`SuspiciousOperationService`、`HoneypotService` 不带 `Event`
（`cloudwalker.js:10`、`cloudwalker.js:12`、`cloudwalker.js:13`），其余带 `EventService`。这直接决定了
下一节的白名单正则必须同时接受两种结尾。

服务名的出处是注释写明的外部目录：`cloudwalker-master/server` 下各事件 API 的实现（`cloudwalker.js:1`）。
该目录不在本仓，本页无法核对它与现网版本是否一致（见第 15 节）。

## 5 只读 RPC 白名单

白名单是一段正则，贴在 `call()` 的第一行（`rpc-client.js:14`）：

```
/^[A-Za-z]+(?:Event)?Service\.(GetEventList|GetEvent|List)$/
```

- 方法名不匹配就抛 `RPC 方法未列入只读白名单`，请求不发出（`rpc-client.js:14`）。
- 注释原文：「不接受任意 RPC 名称，避免通过本控制台调用处置或加白接口」（`rpc-client.js:13`）。
- 允许的动词只有三个：`GetEventList`（列表）、`GetEvent`（详情）、`List`（蜜罐列表）。
- **这是形状匹配，不是逐条枚举**：任何「以 `Service` 或 `EventService` 结尾的服务名 + 上述三个动词之一」
  都能通过。第 4 节那 11 个服务名实测全部命中（复跑命令见第 16 节）。

构造期校验（`rpc-client.js:3-5`）：

| 参数 | 要求 | 不满足时的错误 |
| --- | --- | --- |
| `baseUrl` | 匹配 `^https?://` | `CLOUDWALKER_URL 必须是 HTTP(S) 地址`（`rpc-client.js:4`） |
| `token` | 长度 ≥ 6 | `CLOUDWALKER_API_TOKEN 无效`（`rpc-client.js:5`） |

请求形态（`rpc-client.js:15-21`）：

| 项 | 形态 | 证据 |
| --- | --- | --- |
| URL | `<baseUrl 的 origin>/rpc`，baseUrl 里的路径部分被丢弃 | `rpc-client.js:15` |
| query | `?method=<方法名>` | `rpc-client.js:16` |
| 方法 | POST | `rpc-client.js:18` |
| 请求头 | `Content-Type: application/json`、`Accept-Language: zh-CN`、`Cookie: API-Token=<token>` | `rpc-client.js:19` |
| 请求体 | `{"jsonrpc":"2.0","method":…,"params":…,"id":<自增序号>}`，序号从 1 开始 | `rpc-client.js:20` |
| 超时 | 15 秒（`AbortSignal.timeout(15000)`） | `rpc-client.js:21` |

实测（命令见第 16 节）：base 取 `https://cw.example/base` 时，实际请求是
`https://cw.example/rpc?method=HoneypotService.List`，Cookie 为 `API-Token=abcdef`，
连续两次调用的 `id` 分别是 1 和 2。

## 6 事件归一化

入口 `normalizeAlert(type, row)`（`cloudwalker.js:31`），纯函数，不发请求。

### 6.1 输出形状

**前置条件**：事件 ID 必须是正的安全整数。取 `row.id ?? row.event_id`（`cloudwalker.js:32`）；
不是安全整数或不大于 0 就抛 `牧云 <type> 返回无效事件 ID`（`cloudwalker.js:33`）。
实测 `id: 0` 与 `id: 1.5` 都抛（复跑命令见第 16 节）。

**输出**：固定的一组字段（`cloudwalker.js:45-57`），11 类事件共用同一形状：

| 字段 | 取值 | 缺省 / 空值 | 证据 |
| --- | --- | --- | --- |
| `id` | `<类型键>:<事件号>` | 无 | `cloudwalker.js:46` |
| `eventType` | 传入的 `type` | 无 | `cloudwalker.js:46` |
| `eventId` | 事件号（数字） | 无 | `cloudwalker.js:46` |
| `hostId` | `Number(row.host_id \|\| host.id) \|\| null` | null | `cloudwalker.js:46` |
| `createdAt` | UTC ISO 串 | 解析不出为 `null` | `cloudwalker.js:44`、`cloudwalker.js:47` |
| `time` | Asia/Shanghai 的 时:分:秒 | `createdAt` 为 null 时是 `—` | `cloudwalker.js:47` |
| `title` | `event_name`（对象取 `zh_cn`/`name`/`title`）→ `rule_name` → `name` → 类型中文名 | 类型中文名 | `cloudwalker.js:27-30` |
| `level` / `levelKey` | 1 低危/low、2 中危/medium、3 高危/high、4 严重/critical | 未知/unknown | `cloudwalker.js:23`、`cloudwalker.js:43` |
| `asset` | `host.host_name` → `row.host_name` | `未知主机` | `cloudwalker.js:49` |
| `source` / `target` | 见 6.2 | `待核查` | `cloudwalker.js:36-42` |
| `assetIp` | `host.host_ip` → `host.ip` | null | `cloudwalker.js:35`、`cloudwalker.js:50` |
| `account` | `username` → `login_username` → `user` → `uname` | `待核查` | `cloudwalker.js:51` |
| `command` | `cmdline` → `command` → `shell_cmdline` → `process_cmdline` | `需读取事件详情` | `cloudwalker.js:52` |
| `verdict` / `verdictKey` | 恒 `待研判` / `review` | — | `cloudwalker.js:53` |
| `coverage` / `cases` | 恒 `null` / `0` | — | `cloudwalker.js:53` |
| `scenario` | 类型中文名 | — | `cloudwalker.js:54` |
| `detail` | 恒 `已从牧云读取原始事件；尚未执行 AI 研判。` | — | `cloudwalker.js:54` |
| `evidence` | `["牧云 <类型中文名> 事件 #<事件号>"]` | — | `cloudwalker.js:55` |
| `gap` | 恒 `待获取事件详情与关联证据` | — | `cloudwalker.js:55` |
| `state` | `row.state` | null | `cloudwalker.js:56` |

### 6.2 取数口径

`source` / `target` 的候选字段按事件方向分两套（`cloudwalker.js:36-42`）：

| 方向 | `source` 取值顺序 | `target` 取值顺序 |
| --- | --- | --- |
| 出站（`revshell`、`network_audit`） | `local_addr` → `src_ip` → 主机 IP | `remote_addr` → `target` → `destination_ip` → `dst_ip` |
| 其余 9 类 | `source_ip` → `login_ip` → `ssh_client_ip` → `src_ip` → `client_ip` | `destination_ip` → `dst_ip` → `address` → 主机 IP |

取第一个非空的候选，都空则填 `待核查`（`cloudwalker.js:17`）。

**时间解析**（`cloudwalker.js:18-22`）：先按数值处理——大于 0 且小于 `1e12` 当作秒（乘 1000），否则当作毫秒；
数值走不通就交给 `new Date(value)` 解析字符串；两种都失败返回 `null`。实测：`detected_at: 1767225600`
→ `2026-01-01T00:00:00.000Z`；`created_at: "not-a-date"` → `null`。

**一个容易看错的取数口径**（`cloudwalker.js:16-17`）：候选值先过 `string()`，数字会被转成字符串，
于是数字 `0` 变成字符串 `'0'`，`find(Boolean)` 判定它**非空**——`0` 会被选中，不是「没有值」。
`hostId` 是另一套写法（`Number(row.host_id || host.id) || null`），那里 `0` 被当成没有值；
实测 `host_id: 0` 且 `host.id: 42` 时 `hostId` 是 `42`。

### 6.3 详情证据

`detailEvidence(detail)`（`cloudwalker.js:60-74`）从详情里挑 8 个字段做展示行：

| 标签 | 字段 | 证据 |
| --- | --- | --- |
| 命令行 | `cmdline`、`shell_cmdline` | `cloudwalker.js:62` |
| 进程路径 | `process_path` | `cloudwalker.js:63` |
| 执行用户 | `uname` | `cloudwalker.js:64` |
| 远端地址 | `remote_addr` | `cloudwalker.js:65` |
| 本地地址 | `local_addr` | `cloudwalker.js:66` |
| 文件路径 | `file_path` | `cloudwalker.js:67` |
| 描述 | `description` | `cloudwalker.js:68` |

文本值每条截断到 500 字符（`cloudwalker.js:69`）；`process_tree` 是数组时只给节点数，
`cmdlines` 是数组时只给条数（`cloudwalker.js:71-72`）。

## 7 多类型合并分页

入口 `CloudwalkerGateway.alerts({ count = 20, offset = 0 })`（`cloudwalker.js:84`）。

### 7.1 参数钳制

| 参数 | 量程 | 默认 | 越界处理 | 证据 |
| --- | --- | --- | --- | --- |
| `count` | 1–50 | 20 | 超 50 截到 50；负数抬到 1；非数字按 20 | `cloudwalker.js:85` |
| `offset` | ≥ 0 | 0 | 负数归 0；非数字归 0 | `cloudwalker.js:86` |

内部批量大小 `batchSize = Math.max(20, pageSize)`，落在 20–50 之间（`cloudwalker.js:87`）。
注意 `Number(count) || 20` 这层写法：`count` 传 `0` 会被当成「没传」，得到 20 而不是 1（`cloudwalker.js:85`）。

### 7.2 一轮拉取

1. 首轮并发拉 11 类，每类一个请求（`cloudwalker.js:100`）。
2. 请求参数 `{ count: batchSize, offset: 0 }`，方法名按第 4 节的规则拼（`cloudwalker.js:90-91`）。
3. 列表行取 `data.events ?? data.data ?? data.list`——三个键名依次兜底（`cloudwalker.js:92`）。
4. 响应校验：行必须是数组，且 `data.total` 必须能解析成非负安全整数；否则抛 `<type> 列表响应格式无效`
   （`cloudwalker.js:93-95`）。`total` 缺失（`undefined`）解析成 `NaN`，同样算格式无效。
5. 每类在本地按时间倒序排一遍（`cloudwalker.js:96-97`）——合并顺序不依赖服务端返回的顺序。

### 7.3 合并与补拉

- **失败隔离**：某类失败只记 `errors[type] = 错误消息`（`cloudwalker.js:110`），其余类型照常往下走；
  全部 11 类都失败才抛 `全部事件类型查询失败；首个错误：…`（`cloudwalker.js:112-114`）。
- **空页异常**：某类返回 0 行但 `total > 0`，记 `事件列表返回空页，但总数非零` 并把该类标成失败（`cloudwalker.js:108`）。
- **合并循环**：每轮从各来源当前条目里挑最新的一个追加到结果，直到攒够 `offset + count` 条
  （`cloudwalker.js:116-117`、`cloudwalker.js:135-139`）。挑最新的口径是 `compareAlerts`（`cloudwalker.js:24-26`）：
  `createdAt` 降序，相同则 `id` 升序。`createdAt` 为 `null` 的条目排在有时间的条目之后（实测，命令见第 16 节）。
- **补拉**：某来源取完但 `fetched < total` 时，按 `offset = fetched` 再拉一批（`cloudwalker.js:118-120`）。
  补拉失败则标失败并记错误（`cloudwalker.js:123`）；补拉返回空页且 `fetched < total` 则记
  `事件列表提前返回空页，分页可能不完整` 并标失败（`cloudwalker.js:127-129`）。

### 7.4 返回值

| 字段 | 含义 | 证据 |
| --- | --- | --- |
| `alerts` | 归一化后的告警数组；跳过前 `offset` 条后取 `count` 条 | `cloudwalker.js:141` |
| `total` | 各**成功**类型的 `total` 之和；失败类型不进 `totals`，因此也不计入 | `cloudwalker.js:106`、`cloudwalker.js:142` |
| `totals` | 类型键 → 该类型的 `total` | `cloudwalker.js:106` |
| `errors` | 类型键 → 错误消息 | `cloudwalker.js:110` |
| `partial` | `errors` 非空即为 true | `cloudwalker.js:143` |
| `query` | 钳制后的 `{ count, offset }` | `cloudwalker.js:144` |
| `note` | 固定文案，说明不同请求之间的页边界可能移动 | `cloudwalker.js:145` |

实测（命令见第 16 节）：11 类各 1 条时 `total` 为 3；某类抛错时 `partial` 为 true、`errors` 记下错误、
该类型不进 `totals`、`total` 只算其余 10 类。

## 8 单条详情与连通性探测

### 8.1 `alert(type, id)`

`CloudwalkerGateway.alert(type, id)`（`cloudwalker.js:148`）：

1. `type` 必须是 `eventTypes` 里的键，`id` 必须是正的安全整数，否则抛 `无效的事件类型或 ID`（`cloudwalker.js:149`）。
2. 调 `<服务名>.GetEvent`，参数 `{ id: <数字> }`（`cloudwalker.js:150`）。
3. 详情取 `raw.event || raw`（`cloudwalker.js:151`）。
4. **身份校验**：详情里的 `event_id ?? id` 必须是正的安全整数（否则抛
   `牧云详情缺少事件 ID，无法确认事件身份`），且必须等于请求的 id（否则抛
   `牧云详情事件 ID 与请求不符`）（`cloudwalker.js:152-154`）。
5. 复用 `normalizeAlert` 得到统一结构，再把详情证据追加进去，并用详情里的命令与账号覆盖列表里的缺省文案
   （`cloudwalker.js:155-159`）。
6. 改写 `detail` 与 `gap` 两句文案：证据非空时说「已读取牧云事件详情；证据仅为原始字段，尚未形成 AI 结论。」，
   为空时说「事件详情未提供可展示的行为字段。」（`cloudwalker.js:160-161`）。
7. 返回 `{ alert, detail }`，其中 `detail` 是牧云原始详情（`cloudwalker.js:162`）。

实测（命令见第 16 节）：请求蜜罐 11 号时实际调用 `HoneypotService.GetEvent {"id":11}`；
详情事件号 99 与请求的 11 不符时报 `牧云详情事件 ID 与请求不符`；详情里没有事件号时报
`牧云详情缺少事件 ID，无法确认事件身份`。

### 8.2 `status()`

`CloudwalkerGateway.status()`（`cloudwalker.js:79`）只做一件事：用 `count: 1, offset: 0` 调一次
`RevshellEventService.GetEventList`（`cloudwalker.js:80`）。成功返回
`{ connected: true, eventTypes: [...11 个类型键...], transport: '牧云 /rpc' }`（`cloudwalker.js:81`）。
失败时异常照常往上抛（`cloudwalker.js:80`），不会返回 `connected: false`。

## 9 依赖

- **上游**：`CloudwalkerGateway` 靠构造参数拿 RPC 客户端（`cloudwalker.js:77`），`RpcClient` 靠构造参数拿
  `fetcher`（`rpc-client.js:3`）。谁在业务进程里组装它们，见 [architecture.md](../architecture.md)，
  本页不重复。
- **下游**：牧云 `/rpc`（`rpc-client.js:15-16`）。本模块不连牧云的 MCP 接口。
- **外部依赖**：只用标准库——`fetch`、`URL`、`AbortSignal`、`Intl.DateTimeFormat`
  （`rpc-client.js:3`、`rpc-client.js:15`、`rpc-client.js:21`、`cloudwalker.js:47`）。无第三方包。
- **本地依赖**：无。两个文件都没有 import 本仓其他模块（复跑命令见第 16 节）。

## 10 值语义

| 值 | 单位 | 量程 / 合法域 | 精度 | 默认 | 空值含义 |
| --- | --- | --- | --- | --- | --- |
| `count` | 条 | 1–50 | 整数 | 20 | 非数字按 20；`0` 也按 20（`Number(count) \|\| 20` 的写法） |
| `offset` | 条 | ≥ 0 | 整数 | 0 | 非数字按 0 |
| 内部批量 `batchSize` | 条 | 20–50 | 整数 | `max(20, count)` | 不适用 |
| 事件 ID | 事件号 | 正的安全整数 | 整数 | 无 | 非法即抛错，不产出告警 |
| `level` | 等级 | 1–4 | 整数 | 无 | 其他值 → 未知 / unknown |
| 时间输入 | 秒或毫秒 | > 0；小于 `1e12` 视为秒 | 毫秒 | 无 | 解析不出 → `createdAt` 为 `null` |
| `total` | 条 | 非负安全整数 | 整数 | 无 | 缺失或非法 → 列表响应格式无效 |
| RPC `id` | 请求序号 | ≥ 1 | 整数 | 自增，从 1 开始 | 无 |
| `token` | 字符 | 长度 ≥ 6 | — | 无 | 非法即构造失败 |
| RPC 超时 | 毫秒 | 15000 | 整数 | 15000 | 无 |

归一化输出各字段的取值与缺省见第 6.1 节，不在此重复。

## 11 行为承诺

| 编号 | 陈述 | 依据 |
| --- | --- | --- |
| `R-EVENT-GATEWAY-01` | 只有匹配白名单正则的方法名能发出请求，其余抛错且不发请求 | `rpc-client.js:14` |
| `R-EVENT-GATEWAY-02` | 11 类事件的原始行归一化后字段集合一致 | `cloudwalker.js:45-57` |
| `R-EVENT-GATEWAY-03` | 事件 ID 不是正的安全整数时抛错，不产出半条告警 | `cloudwalker.js:32-33` |
| `R-EVENT-GATEWAY-04` | 详情返回的事件 ID 必须与请求一致，否则抛错 | `cloudwalker.js:152-154` |
| `R-EVENT-GATEWAY-05` | 合并结果按 `createdAt` 降序，同一时间按 `id` 升序 | `cloudwalker.js:24-26`、`cloudwalker.js:137-139` |
| `R-EVENT-GATEWAY-06` | 单类事件查询失败不阻断其余类型；全部类型失败才抛错 | `cloudwalker.js:100`、`cloudwalker.js:110`、`cloudwalker.js:112-114` |
| `R-EVENT-GATEWAY-07` | `count` 钳制在 1–50、`offset` 钳制在 ≥ 0，返回值里的 `query` 是钳制后的值 | `cloudwalker.js:85-86`、`cloudwalker.js:144` |
| `R-EVENT-GATEWAY-08` | 详情证据里的单条文本不超过 500 字符 | `cloudwalker.js:69` |

**不保证什么**（测试方据此判「这不是 bug」）：

- 不保证不同请求之间的页边界稳定。返回的 `note` 原文就写了这一点：`平台数据变化时，不同请求之间的页边界可能移动`（`cloudwalker.js:145`）。
- 不保证 `total` 是全平台的事件总数。失败的类型不进 `totals`，`total` 只加成功类型的和（`cloudwalker.js:106`、`cloudwalker.js:142`）。
- 不保证列表里带得出命令或账号。取不到时填的是 `需读取事件详情` 与 `待核查`（`cloudwalker.js:51-52`）。
- 不保证 `status()` 能证明 11 类事件都通。它只探 `RevshellEventService` 一类（`cloudwalker.js:80`）。
- 不保证详情接口对每类事件都返回行为字段。没有就写「事件详情未提供可展示的行为字段。」（`cloudwalker.js:160`）。
- 不保证归一化结果能直接判断事件真伪。`verdict` 恒为「待研判」，判定由别的模块做（`cloudwalker.js:53`）。

## 12 失败面

| 失败模式 | 表现 | 失败后状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| 方法名不在白名单 | 抛 `RPC 方法未列入只读白名单` | 请求没发出，无副作用 | 不适用（调用方 bug） | 无 |
| `baseUrl` 非 http(s) / `token` 短于 6 | 构造时抛错 | 对象没建成 | 不适用 | 无 |
| 响应体不是 JSON | 抛 `牧云 /rpc 返回 HTTP <status>，响应不是 JSON` | 没拿到数据，无副作用 | 可以 | 无 |
| 响应体带 `error` | 抛 `牧云 /rpc <code>: <message>` | 同上 | 视错误码而定 | 无 |
| HTTP 非 2xx | 抛 `牧云 /rpc HTTP <status>` | 同上 | 可以 | 无 |
| 响应体缺 `result` | 抛 `牧云 /rpc 响应缺少 result` | 同上 | 可以 | 无 |
| 15 秒超时 | 抛 `TimeoutError`（消息 `The operation was aborted due to timeout`） | 同上 | 可以 | 无 |
| 列表响应格式无效 | 抛 `<type> 列表响应格式无效` | 该类失败，其余类型照常 | 可以 | 进 `errors[type]`，`partial` 为 true |
| 某类查询失败 | 错误消息进 `errors[type]` | 其余类型照常 | 可以 | 同上 |
| 补拉时提前空页 | 记 `事件列表提前返回空页，分页可能不完整` | 该类标失败，结果偏少 | 可以 | 同上 |
| 全部 11 类失败 | 抛 `全部事件类型查询失败；首个错误：…` | 没有结果 | 可以 | 无 |
| 事件 ID 非法 | 抛 `牧云 <type> 返回无效事件 ID` | 没有结果 | 不适用（上游数据问题） | 无 |
| 详情缺事件 ID / 事件号不符 | 抛 `牧云详情缺少事件 ID，无法确认事件身份` 或 `牧云详情事件 ID 与请求不符` | 没有结果 | 不适用（上游数据问题） | 无 |

「无副作用」指这两个文件都不写盘、不改外部状态（复跑命令见第 16 节）。

## 13 资源

| 项 | 数值 | 来源 |
| --- | --- | --- |
| 单次 `alerts()` 的 RPC 请求数 | 至少 11 个（每类 1 个）；补拉时每轮对每个已取完的类型再发 1 个 | `cloudwalker.js:100`、`cloudwalker.js:120` |
| 首轮并发度 | 11 个并发请求 | `cloudwalker.js:100` |
| 单类单次最多取回的条数 | 20–50（`batchSize`） | `cloudwalker.js:87`、`cloudwalker.js:91` |
| 单次返回的告警条数 | ≤ 50 | `cloudwalker.js:85` |
| RPC 单次超时 | 15 秒 | `rpc-client.js:21`（本地实测约 15003 ms，命令见第 16 节命令 9） |
| 详情证据单条文本长度 | ≤ 500 字符 | `cloudwalker.js:69` |

上表全是代码常量，**不是实测值**。本机没有牧云凭据，延迟与吞吐未测量（第 15 节缺口 5）。

## 14 约束与理由

**假设**（代码依赖的外部行为）：

- 牧云 `/rpc` 是 JSON-RPC 2.0，响应体里有 `result`（`rpc-client.js:20`、`rpc-client.js:27`）。
- 列表接口接受 `count`/`offset`，并返回 `total`（`cloudwalker.js:91`、`cloudwalker.js:93`）。
- 详情接口返回事件 ID，且与请求的事件对应（`cloudwalker.js:152-154`）。
- 事件的 `level` 是 1–4 的整数（`cloudwalker.js:23`）。
- 时间字段是秒或毫秒数值，或能被 `new Date` 解析的字符串（`cloudwalker.js:18-22`）。

**限制**：

- 只读：只有 `GetEventList`、`GetEvent`、`List` 三个动词能发出去（`rpc-client.js:14`）。
- 只覆盖 11 类事件，类型表写死在代码里（`cloudwalker.js:2-6`）。
- 新增事件类型要改代码，类型表的键同时是合并拉取的顺序（`cloudwalker.js:88`）。

**被排除的方案：未查到**。代码与注释都没有记录为什么用形状白名单而不是逐条枚举、为什么在本地排序而不是依赖服务端顺序、
为什么 11 类写死而不做成配置。本页不替它编理由，见第 15 节缺口 4。

**已知坑**：

- `new URL('/rpc', baseUrl)` 会丢掉 `baseUrl` 里的路径：base 写 `https://cw.example/base` 时，请求实际打到
  `https://cw.example/rpc`（`rpc-client.js:15`）。
- `Number(count) || 20` 把 `0` 当成「没传」，`count: 0` 得到 20 而不是 1（`cloudwalker.js:85`）。
- `first()` 把数字 `0` 转成字符串 `'0'` 并判为非空（`cloudwalker.js:16-17`），与 `hostId` 那套 `||` 口径正好相反（`cloudwalker.js:46`）。
- 蜜罐的列表动词是 `List` 而不是 `GetEventList`，通用代码里写死了这一个特例（`cloudwalker.js:90`）。
- `body.error` 的判断排在 `response.ok` 之前（`rpc-client.js:25-26`）：HTTP 500 且响应体带 JSON-RPC error 时，
  报出来的是 error 文本，不是 HTTP 状态。
- `time` 固定按 Asia/Shanghai 渲染（`cloudwalker.js:47`），与 `createdAt` 的 UTC 串并存；代码没写为什么不跟随调用方时区。
- 排序用 `localeCompare` 比时间串（`cloudwalker.js:25`）。`createdAt` 要么是 `parseTime` 产出的 ISO 串，要么是 `null`
  （`cloudwalker.js:21`、`cloudwalker.js:44`），所以被比的两边要么都是 ISO 串，要么一边是空串。

## 15 缺口

| 编号 | 缺什么 | 为什么查不到 | 影响面 |
| --- | --- | --- | --- |
| `GAP-EG-01` | 牧云 `/rpc` 的真实响应结构 | 本机没有牧云凭据，未发过任何外部请求。代码用 `data.events ?? data.data ?? data.list` 三键兜底（`cloudwalker.js:92`），说明作者见过不止一种形状 | 字段映射可能与现网对不上；列表被判「格式无效」时，分不清是上游改版还是本地映射错 |
| `GAP-EG-02` | 11 类事件的服务名与动词是否与现网一致 | 出处是注释提到的外部目录 `cloudwalker-master/server`（`cloudwalker.js:1`），该目录不在本仓 | 服务名过期时该类拉空，报出来的是「事件列表返回空页，但总数非零」或「列表响应格式无效」 |
| `GAP-EG-03` | 牧云侧是否只有这三个动词是只读 | 白名单是形状匹配（`rpc-client.js:14`），本仓看不到牧云的方法清单 | 若牧云新增了符合形状的写操作动词，本控制台也能调它 |
| `GAP-EG-04` | 各项取舍的理由：形状白名单 vs 逐条枚举、本地排序 vs 服务端排序、11 类写死 vs 配置 | 代码与注释里都没有记录 | 后来的人可能重复推翻同一个决定 |
| `GAP-EG-05` | 延迟与吞吐 | 未对牧云发过真实请求（只在本机用假 `fetcher` 与本地空服务验过） | 容量结论缺失；第 13 节除超时那行是本地实测外，其余全是代码常量 |
| `GAP-EG-06` | 列表接口的 `offset` 分页语义在数据变动时的表现 | 代码只在返回的 `note` 里提醒页边界可能移动（`cloudwalker.js:145`），没有更多说明 | 翻页时可能漏条或重复，调用方从返回值里看不出这一点 |

登记状态：`GAP-EG-01` 与架构篇登记的「牧云 `/rpc` 与 `/api/mcp` 的实际响应格式」是同一件事，见
[docs/_meta/gaps.md](../_meta/gaps.md) 第六节。其余 5 条本卡**未登记到台账**——本卡 scope 不含
`docs/_meta/gaps.md`，登记动作留给有该文件 scope 的卡（见 `coding-reports/P001-T003.md` 的未决小节）。

## 16 复跑命令

以下命令在本仓根目录跑，全部只读、不发外部请求。`node --input-type=module -e` 需要 Node.js 20 及以上。

**命令 1——类型表与服务名，以及 11 个服务名是否都过白名单**：

```bash
node --input-type=module -e '
import { eventTypes, rpcMethods } from "./cloudwalker.js";
const re = /^[A-Za-z]+(?:Event)?Service\.(GetEventList|GetEvent|List)$/;
console.log(Object.keys(eventTypes).length, Object.keys(rpcMethods).length);
console.log(Object.keys(eventTypes).every(k => re.test(rpcMethods[k] + ".GetEventList")));
'
```

输出：`11 11` 与 `true`。

**命令 2——`count` / `offset` 钳制**：

```bash
node --input-type=module -e '
import { CloudwalkerGateway } from "./cloudwalker.js";
const gw = new CloudwalkerGateway({ call: async () => ({ events: [], total: 0 }) });
for (const q of [{}, {count:0}, {count:-5}, {count:100}, {count:"abc"}, {offset:-1}]) {
  const r = await gw.alerts(q);
  console.log(JSON.stringify(q), JSON.stringify(r.query));
}
'
```

输出（依次）：`{} {"count":20,"offset":0}`、`{"count":0} {"count":20,"offset":0}`、
`{"count":-5} {"count":1,"offset":0}`、`{"count":100} {"count":50,"offset":0}`、
`{"count":"abc"} {"count":20,"offset":0}`、`{"offset":-1} {"count":20,"offset":0}`。

**命令 3——合并排序**：

```bash
node --input-type=module -e '
import { CloudwalkerGateway } from "./cloudwalker.js";
const data = {
  "RevshellEventService.GetEventList": { events: [{id:2, created_at:"2026-02-01T00:00:00Z"}], total: 1 },
  "WebshellEventService.GetEventList": { events: [{id:1, created_at:"2026-01-01T00:00:00Z"}], total: 1 }
};
const gw = new CloudwalkerGateway({ call: async m => data[m] ?? { events: [], total: 0 } });
const r = await gw.alerts({ count: 2 });
console.log(r.alerts.map(a => a.id).join(" "), r.total);
'
```

输出：`revshell:2 webshell:1 2`。

**命令 4——单类失败隔离**：

```bash
node --input-type=module -e '
import { CloudwalkerGateway } from "./cloudwalker.js";
const gw = new CloudwalkerGateway({ call: async m => {
  if (m === "MalwareEventService.GetEventList") throw new Error("boom");
  return { events: [{id:1, created_at:"2026-01-01T00:00:00Z"}], total: 7 };
} });
const r = await gw.alerts({ count: 2 });
console.log(r.partial, JSON.stringify(r.errors), r.total, "malware" in r.totals);
'
```

输出：`true {"malware":"boom"} 70 false`。

**命令 5——归一化缺省值与详情证据截断**：

```bash
node --input-type=module -e '
import { normalizeAlert, detailEvidence } from "./cloudwalker.js";
const a = normalizeAlert("webshell", { id: 7, created_at: "2026-03-04T05:06:07Z", level: 3 });
console.log(a.id, a.level, a.time, a.account, a.command);
console.log(detailEvidence({ cmdline: "x".repeat(600) })[0].length);
'
```

输出：`webshell:7 高危 13:06:07 待核查 需读取事件详情` 与 `504`（「命令行：」4 字 + 500 字符）。

**命令 6——详情身份校验**：

```bash
node --input-type=module -e '
import { CloudwalkerGateway } from "./cloudwalker.js";
const mk = d => new CloudwalkerGateway({ call: async () => ({ event: d }) });
for (const [d, label] of [[{ event_id: 99 }, "mismatch"], [{ name: "x" }, "no-id"]]) {
  try { await mk(d).alert("webshell", 11); } catch (e) { console.log(label, e.message); }
}
'
```

输出：`mismatch 牧云详情事件 ID 与请求不符` 与 `no-id 牧云详情缺少事件 ID，无法确认事件身份`。

**命令 7——请求形态与白名单拦截**：

```bash
node --input-type=module -e '
import { RpcClient } from "./rpc-client.js";
let seen;
const c = new RpcClient("https://cw.example/base", "abcdef", async (u, o) => {
  seen = { u: u.toString(), h: o.headers, b: o.body };
  return { ok: true, status: 200, json: async () => ({ result: {} }) };
});
await c.call("HoneypotService.List", { count: 20, offset: 0 });
console.log(seen.u, seen.h.Cookie, seen.b);
try { await c.call("WhitelistService.Add", {}); } catch (e) { console.log(e.message); }
'
```

输出两行：

```
https://cw.example/rpc?method=HoneypotService.List API-Token=abcdef {"jsonrpc":"2.0","method":"HoneypotService.List","params":{"count":20,"offset":0},"id":1}
RPC 方法未列入只读白名单
```

**命令 8——没有本地依赖、没有持久化调用**：

```bash
grep -nE "\bfs\b|node:fs|writeFile|readFile|mkdir|localStorage" cloudwalker.js rpc-client.js; echo "exit=$?"
grep -n "^import\|require(" cloudwalker.js rpc-client.js; echo "exit=$?"
```

两行都是 `exit=1`（无输出）。

**命令 9——超时行为**（本地起一个只收连接不回话的服务，约 15 秒后返回）：

```bash
node --input-type=module -e '
import http from "node:http";
import { RpcClient } from "./rpc-client.js";
const srv = http.createServer(() => {});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const c = new RpcClient(`http://127.0.0.1:${srv.address().port}`, "abcdef");
const t0 = Date.now();
try { await c.call("HoneypotService.List"); console.log("no throw"); }
catch (e) { console.log(e.name, "|", e.message, "| elapsed_ms:", Date.now() - t0); }
srv.close();
'
```

输出：`TimeoutError | The operation was aborted due to timeout | elapsed_ms: 15003` 左右（毫秒数随机器负载浮动）。

## 17 指针

- 架构篇 [architecture.md](../architecture.md)——全局地图；本模块在其中的位置见第 4 节与第 12 节。
- 模块清单 [modules/_breakdown.json](_breakdown.json)——模块名、实现文件与覆盖构件的机器可读版本。
- 缺口台账 [docs/_meta/gaps.md](../_meta/gaps.md)——跨模块的未决与边界。
- 其他模块页见 [architecture.md 第 12 节](../architecture.md#12-模块清单)。
