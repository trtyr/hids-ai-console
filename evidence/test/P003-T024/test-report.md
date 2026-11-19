# P003-T024 测试报告（测试席 · 何东阳）

- 任务卡：P003-T024 错误分成四类，响应带稳定 code（后端）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T024`，分支 `task/hids-ai-console-P003-T024`
- 被测提交：代码 `e8af56f`、报告 `f60a4ad`；起活基线 `85b483c`
- 审查判词：`verdicts/P003-T024-gc-backend-code-review-mwn9fi4j.json`（pass）
- 我的套件：`evidence/test/P003-T024/error-contract.tester.test.js`（11 条，436ms，全绿）
- 判据来源只有两份契约：`openapi.yaml`（Error / InternalError / `/api/status` 502）与 `docs/modules/http-api.md`（§1、§3.1、§5、§6、§7、§8.1、§8.2、§8.3、§9.2）。没读实现、没按实现补断言。

## 结论

**PASS。** A1–A4 逐条落地，四类同码在文档列出的每条路由上都成立，边界与错误码按文档原文对上；变异三条各自恰红、还原复绿；全套 314 pass / 1 fail（唯一红是本卡之前就红的 `maintenance-startup.test.js`，85b483c 上同红）。另有 3 条 doc-side minor，不挡推进。

## 一、验收逐条

| 验收 | 我的用例 | 实测 |
| --- | --- | --- |
| A1 四类各一条 + `Error.code` 四值 enum | `error-contract.tester.test.js:57`（openapi 解析）、`:96`（四类各一条） | `Error.required=[error,code]`、`code.enum` 恰好四值、`InternalError` 存在且正文口径「服务器内部错误」、`/api/status` 502 schema required 含 `code`/`reason`；运行时四类 = 400/503/502/500 且 code 对应 |
| A2 同类同码三组 | `:120`（调用方七个 4xx 档位）、`:156`（没配置 15 条路由）、`:182`（上游 6 条）、`:209`（本程序 4 处） | 7 个 4xx 档位（400/403/404/405/409/410/422）全 `caller_error`；15 条缺依赖路由全 503 `not_configured`；`/api/alerts`、`/api/alerts/{id}`、`/api/status`、`/api/rules`、`/api/rules/{id}`、`/api/rules/evaluate` 全 502 `upstream_error`；wiki 页读、规则配置写、研判开关、提示词元数据全 500 `internal_error` |
| A3 上游摘要原话 + 本程序固定文案且正文无 ENOSPC/at/node:internal | `:306`、`:209` | 上游 `alerts` 502 正文逐字等于注入的 `牧云 /rpc 5001: 查询超时`；注入 `写盘失败：ENOSPC at /srv/backend/.data/wiki (node:internal/fs/promises:123:45)` 后 500 正文只有 `{"error":"服务器内部错误","code":"internal_error"}`，`ENOSPC`/`at /srv`/`node:internal`/`.js:<行>:<列>` 一个都查不到 |
| A4 注入 Basic/Bearer/token=/api_key= 四凭据，正文查不到、摘要仍在 | `:306` | 上游原话里四种凭据（`dG9rZW46c2VjcmV0`、`sk-live-1234567890`、`abc123`、`key-9`）在 502 正文里一个都没有，`牧云 /rpc 401: 拒绝` 仍在；`/api/status` 502 的 `reason` 走同一道闸（`c2VjcmV0OnNlY3JldA==`、`hunter2` 均不在，`connect ECONNREFUSED 10.0.0.1:443` 仍在）；SSE 错误帧（`?stream=1`，200 + `data:{type:error}`）里 `sk-live-stream-token` 不在、`模型接口 401` 仍在、帧内无 `code`（文档 §9.2） |
| 契约同步 | `:57` | 解析 `openapi.yaml`：`Error` 四值 enum、`required`、`InternalError`、`/api/status` 502 业务体 required 四字段；运行时响应对得上 |
| T18-F1（`POST /api/agent/triage/{syslog-id}` 无原始报文） | 仓内探针 | `node evidence/p003-t018-verify/probe-retry-syslog-status.mjs` → `404 {"error":"该 syslog 告警的原始报文不存在，无法重试","code":"caller_error"}`，`exit=0` |

### 边界与错误码覆盖（自己一条一条请求出来的）

- 缺失/类型错：`/api/triage/rules/validate` 正文 `{}`/`[]`/`null`/`5`/`"文本"` → 400「请求正文缺少 config」；`{"config":{"rules":"不是数组"}}` → 400「规则集格式无效」
- 越界：`/api/alerts?count=0|51|abc|20.5`、`offset=-1`，`/api/wiki/pages?count=0|51` → 全部 400「分页参数无效」
- 超长：`PUT /api/agent/triage/control` 正文 9000 字符 → 400「请求正文过大」；非 JSON → 400「请求正文不是 JSON」；数组正文 → 400「请求正文无效」
- 非法枚举（路径 ID）：`/api/agent/triage/not-an-id`、`/api/agent/investigations/not-an-id?mode=deep`、`POST /api/agent/investigations {alert_id:"not-an-id"}` → 400，`error` 含「告警 ID」
- 状态冲突：误报登记无此案件 → 404「找不到这条研判案件」；研判未完成 → 409「研判还没结束，不能登记误报」；wiki 页版本过期（注入 `status:409`）→ 409；白板启动注入 `status:422` → 422。全部 `caller_error`
- 例外形状：401 是 `text/plain; charset=utf-8` 的「需要登录后访问」，没有 `code`；`/api/status` 502 是业务体 `{configured, connected, reason, code}`，不是 `{error, code}`；成功体（未配牧云的 `/api/status` 200）不带 `code`
- 每个错误体都断言「键集合恰为 `{error, code}`、`error` 是非空字符串、`code` ∈ 四值」——多字段/缺字段/类型不对都算红

## 二、回归（回归优先，先跑后写）

```
$ node --test $(ls *.test.js)          → tests 198  pass 197  fail 1   exit=1
$ node --test <evidence 11 套件>       → tests 118  pass 117  fail 0  todo 1  exit=0
$ 合并跑（含我这 11 条）                → tests 316  pass 314  fail 1  todo 1  exit=1
```

唯一红：`maintenance-startup.test.js`（spawn `<上级>/current/backend/maintenance-server.js`，本树没有 `backend/` 前缀）。**基线坐实**（我自己在 85b483c 的干净导出上跑）:

```
$ git archive 85b483c | tar -x -C /tmp/hids-base-85b483c
$ cd /tmp/hids-base-85b483c && node --test maintenance-startup.test.js
  → pass 0  fail 1，报错 "Cannot find module '…/current/backend/maintenance-server.js'"，exit=1
```

与卡上给的全套基线一致（报告写 302 pass，我实测同口径 303 pass：根 197 + evidence 106，差异只是计数口径，无行为差）。

## 三、反向验证（变异三条，自己改、自己跑、自己还原）

每条都是 `sed -i` 改一处 → 只跑我的套件 → `git checkout -- server.js` 还原 → `cmp` 与改前一致。

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| `服务器内部错误` → `服务器内部故障`（`INTERNAL_ERROR_MESSAGE`，§8.3 钉死的固定文案） | A1 四类 + A2 本程序类红 | 恰红 2 条（`:96`、`:209`），pass 9 fail 2，exit=1 |
| `caller_error` → `caller-error`（四值 enum 里的一值） | 所有断言 `code` 的用例红 | 恰红 5 条（A1、A2 调用方、边界×2、e2e），pass 6 fail 5，exit=1 |
| `upstream_error` → `upstream-error` | 上游相关三处红 | 恰红 3 条（A1、A2 上游、A3/A4），pass 8 fail 3，exit=1 |
| 还原后复跑 | 全绿 | pass 11 fail 0，436ms，exit=0；`server.js` 与改前 `cmp` 一致 |

A4 的「凭据不回显」另有正向佐证（不是我编的断言）：注入四凭据的那次请求，服务端自己的日志行
`{"event":"cloudwalker.call_failed","error":"牧云 /rpc 401: 拒绝 Basic [redacted]，Bearer [redacted]，token=[redacted]&request=api_key=key-9 无效"}`
里 Basic/Bearer/token= 三段已被擦；正文里四种形态也都不在。

## 四、发现（3 条 minor，全是 doc-side，不挡推进）

### F1 `docs/modules/http-api.md:54` 入口打印说明已过时

- 文档说：进程入口「打印 `HIDS API: http://<host>:<port>`」
- 实测：stdout 只有结构化日志 `{"event":"server.started","host":"127.0.0.1","port":…}`（P003-T023 起），全文没有 `HIDS API:` 字样
- 复现：`HIDS_HOST=127.0.0.1 HIDS_PORT=18099 node server.js` 看 stdout
- 代价实证：我 e2e 首版按文档等这一行，8s 超时失败；改按 `"event":"server.started"` 才起得来
- 建议：§2 该句改成「打印结构化启动日志 `server.started`（host/port）」

### F2 `docs/modules/http-api.md:75` §3.1 路由表 `/api/status` 502 正文漏 `code`

- 文档说：「正文仍是 `{configured, connected:false, reason}`」
- 实测：`{configured:true, connected:false, reason:"connect ECONNREFUSED 10.0.0.1:443", code:"upstream_error"}`
- 复现：`node -e` 注入 `service.status` 抛错请求 `/api/status`（我的 `:182` 用例，断言 deepEqual 四字段）
- 说明：§9.2 同页已写全，属同页自相矛盾；审查判词 minor #2 已报同一条，我独立复现了一遍
- 建议：该行补充 `code:upstream_error`

### F3 `docs/modules/http-api.md:36`/`:50` `createServer` 参数个数写少，写测试时无从照抄

- 文档说：「`createServer` 是依赖注入点（`server.js:257-261`）：14 个参数都带默认值」（`docs/_meta/gaps.md:62` 又写 15 个）
- 实测：注入点接受 16 个位置参数——第 14 个 `ruleAdminToken`、15 个 `ruleStore`、16 个 `ruleMaintainer`（我的用例就是按 16 个传的，`ruleStore.list` 抛错能稳定命中 `/api/rules` 的 502）
- 影响：本卡测试必须用这个顺序；文档没给顺序，只能照既有测试文件抄
- 建议：§2 补一张参数顺序表（或直接给签名行）
- 注：这是起活前就有的 doc 债，不是本卡引入

## 五、残余风险（文档承诺了、我这轮没 e2e 触发的）

1. **`maintenance.*.error` 的凭据擦除**（§8.3 纪律 4 末段）：要跑完一整轮误报维护才看得到，这轮没造那个现场；只验到 SSE 帧与 `/api/status`、上游 502 三处同闸。
2. **`POST /api/wiki/sessions/{id}/messages` 带 feedback 的 502**（§3.1）：需要知识维护会话真跑一轮，没覆盖。
3. **`internal_error` 排障线索为零**（报告未决 6）：正文固定一句话，异常原文只进 `http.failed`——我验到了「不回原文」，但没验日志里确实有原文（日志是 stdout，测试进程内断言不稳）。
4. **SSE 帧条数/内容**取决于真模型，这轮用替身研判器，只验帧类型与擦除。
5. **上游结构化错误码**仍不存在（未决 5），A3 按「摘要」满足。

## 六、怎么复跑

```
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T024
node --test evidence/test/P003-T024/error-contract.tester.test.js   # 11/11，~440ms，exit 0
node --test evidence/test/P003-T024/error-classes.test.js           # 写者 8 条，exit 0
node evidence/p003-t018-verify/probe-retry-syslog-status.mjs        # 404 caller_error，exit 0
node --test $(ls *.test.js)                                          # 197/1（基线红），exit 1
```
