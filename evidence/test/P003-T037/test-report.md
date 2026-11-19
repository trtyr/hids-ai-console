# P003-T037 测试报告：取数效率与队列能力

- 任务卡：P003-T037（验收 A1–A12）
- 测试席：gc-backend-tester（何东阳），只写集成/探针，不改产品代码
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T037`（复验 HEAD `5fdbbd2`；首轮报告基于 `4061f12`，分支 `task/hids-ai-console-P003-T037`）
- 判据来源：`docs/modules/triage-pipeline.md`、`docs/modules/event-gateway.md`、`docs/modules/investigation-agent.md`、`docs/modules/knowledge-base.md`、`docs/modules/triage-rules.md`、`docs/modules/http-api.md`、`docs/architecture.md`、`openapi.yaml`
- 复跑入口：`bash evidence/test/P003-T037/tester-run-all.sh`（每支单独 `timeout`，进程自回收）；`timeout 300 npm test` 单独跑
- 运行根全部在 `/tmp`（探针自己 `mkdtemp` 并清理；真进程 e2e 复制一棵临时树，运行态目录不落工作树）

## 〇、复验结论（第二轮，HEAD `5fdbbd2`）

**通过。** 首轮打回的三条逐条闭合，全部由本席终端亲手跑出：

| 打回项 | 复验结果 | 本席亲跑证据（exit 码） |
| --- | --- | --- |
| F1 / A5：真进程 `HIDS_TRIAGE_CONCURRENCY` 不生效 | **已修实**。回显面：env=1/3/5 → `summary().concurrency`=1/3/5，`0`/`abc` → 2，`syslog` 模式 env=3 → 3，同行 `queue_limit=7` 同步生效（6 行矩阵）。行为面：env=1 连发 3 条 → `counts={running:1,queued:2}`；env=3/5 → `{running:3,queued:0}`——并发数真的限制了同时在跑条数 | `cmd:node evidence/test/P003-T037/probe-concurrency.mjs` → 6/6 EXIT 0；`cmd:node evidence/test/P003-T037/tester-http-concurrency.mjs` → 3/3 EXIT 0（连跑 3 次一致） |
| F2 / dispatch-doc-1：openapi 没声明 429 | **已补**。`openapi.yaml:516` 该路由 `responses` 有 `'429': TooManyRequests`；`:2198-2201` 描述扩成两来源（登录失败 / 研判队列满，正文文案逐字）。行为面对账：实测 429 正文 `{"error":"研判队列已满（上限 1），稍后再试","code":"caller_error"}`，与 `Error` schema 的 `required:[error,code]` + `code` enum 一致；`http-api.md:103` 同口径 | `cmd:python3 -c "import yaml; ..."` → 该 operation 响应键 `['202','400','404','429']`；`cmd:node evidence/test/P003-T037/tester-http-e2e.mjs` → 429 状态码 + 文案 + `code` 三断言绿、`dropped=1`（92/92 EXIT 0） |
| F3 / dispatch-doc-2：§5.2 冷启动空轮口径 | **已补且与实码一致**。`triage-pipeline.md:384` 写明冷启动轮计入空轮、重启后首轮真实轮询间隔 `2×intervalMs`。类级对账：冷启动页里有数据仍 `[backoffMs, emptyPolls]=[2000,1]`；真进程对账：刚起来 `empty_polls=1`、`backoff_ms=60000`（interval=30000） | `cmd:node evidence/test/P003-T037/tester-queue.mjs` → 116/116（新增断言行）；`cmd:node evidence/test/P003-T037/tester-http-e2e.mjs` → §5.2 三条断言绿 |

A12 负载探针：`cmd:timeout 300 bash evidence/test/P003-T037/probe-load.sh` → EXIT 0，`✔ 工作树未被写入（before=after=f9bb2046…）`。

**复跑入口**：`bash evidence/test/P003-T037/tester-run-all.sh` → EXIT 0（queue 116 + gateway 23 + stores 18 + agent 16 + http-e2e 92 + http-concurrency 3 + 写者探针 6 + 负载探针）。`timeout 600 npm test` → tests 216 / pass 216 / fail 0，EXIT 0。

### 复验中本席改动（只动自家测试文件，产品代码零改动）

1. `tester-http-e2e.mjs` 的 429 用例原本有竞态（三看判 **A 类：测试自身错**）。首轮能过是运气：假牧云秒回，上游身份校验在第一条记录进入 `running` 后约 10ms 就判 `triage.failed`（server 日志 `MCP 服务不是牧云`），记录立刻退出配额；`POST#2` 落在「配额为空」的毫秒窗口里就变成 `202`。复验时实测 **4 次红 1 次**（`tester-run-all.sh` 第一次跑就红：`队列满时 POST 第二条 -> 429 actual=202`）。改法：429 段加 `holdRpc` 挂住上游响应，让第一条稳定占住在跑名额，并在 `POST#2` 前先断言 `counts.running=1`（把前置条件写进断言，竞态变成硬判据）。改后连跑 3 次全绿。
2. `tester-http-concurrency.mjs` 重写：除 env 回显外，加「连发 3 条 → running/queued 分布」的行为面，并用同一套 `holdRpc` 消除窗口；顺带修掉旧版进程不退出（跑完会被外层 timeout 124 掐掉）的问题。
3. `tester-queue.mjs` 把冷启动那句 `info()` 升成 `eq()` 断言（文档已写死口径，就不该只打印）；`tester-run-all.sh` 头注的「已知红」过期，改成实况，并把写者探针、负载探针并入复跑入口。

### 遗留 nit（不阻塞）

`docs/modules/record-store.md:147`、`docs/architecture.md:449` 仍把 `this.concurrency = positiveInteger(concurrency, envConcurrency())` 锚到 `triage-monitor.js:76`，实际在 `:83`（本席结构查询 `grep -n "this.concurrency = \|envConcurrency" triage-monitor.js` 确认 `:83`）。审查席已并入「文档锚点重校准」未决卡，本席不另开。

## 一、结论（首轮，HEAD `4061f12`，已被上节复验取代）

> 首轮判「不通过」：1 条 major（F1 真进程 concurrency 不生效）+ 2 条 doc-side minor（F2 openapi 缺 429、F3 冷启动空轮口径）。整改提交 `5fdbbd2` 后三条全部闭合，最终判定见上节「〇、复验结论：通过」。以下为当轮原文，保留作对账。

**不通过（1 条 major + 2 条 doc-side minor）。**

卡面 A1–A4、A6–A12 全部实测成立；**A5 的「并发数可配」在真进程里不成立**：`HIDS_TRIAGE_CONCURRENCY` 设 1/3/5，`GET /api/agent/triage/status` 返回的 `concurrency` 恒为 2（同一条链上 `HIDS_TRIAGE_QUEUE_MAX` 生效），与 `docs/architecture.md:449`、`docs/modules/triage-pipeline.md:542`、`openapi.yaml:1660` 的承诺不一致。monitor 类本身能读这个环境变量（探针 `tester-queue.mjs` 全绿），缺的是 server 装配处没有把它接进队列。

另两条 doc-side：`openapi.yaml` 的 `POST /api/agent/triage/{alertId}` 没有声明 429（实测会回 429 + `caller_error`）；冷启动首轮被计入「空轮」，重启后首轮真实轮询延迟翻倍，`§5.2` 没写这个口径。

## 二、覆盖矩阵（逐条）

| 卡面 | 断言什么 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 增量轮询 | 冷启动查询 `{count:50,offset:0,sort:'time'}` 无 `from`；第二轮带 `from=watermark`；两轮共 2 次查询（不翻页找边界）；同秒行靠 `watermark_ids` 去重；`partial` 不推进游标；20 页上限文案；退避 2×/4× 封顶 `maxBackoffMs`、见到新告警立刻回 `intervalMs`；`stop()` 后 150ms 不再轮询 | 绿 | `tester-queue.mjs`（115/115）、`tester-logs/tester-queue.txt` |
| A2 详情一次一拉 | 规则引擎：`match.event` 身份一致时 `callTool` 0 次、status=`observed`；不带 `match.event` 时 1 次；身份不符先判 `identity_unverified` 不取详情。agent 入口：身份一致时不再调 `get_honeypot_event`，仍产出 `cw:N` 证据；未匹配时调 1 次 | 绿 | `tester-agent.mjs`（16/16）、`tester-logs/tester-agent.txt` |
| A2/A11 复用分支两道闸 | `maxCalls=0` → 抛「本次调查的取证调用已达到 0 次上限」；`match.event` 超 2MB → 抛「工具结果超出本次调查的单次取证上限」；两条文案与原生工具路径逐字一致 | 绿 | 同上；变异见 §四 |
| A3 结论复用 | 同指纹不同秒 + 上一条 `done` 且有结论：`{reused:true, repeat_count:2, alert_id:原记录}`、不新建记录、研判不再跑、记录上 `repeat_count`/`verdict` 同步；上一条未完结不复用、新建记录 | 绿 | `tester-queue.mjs` |
| A4 优先级 | `typeRisk` 11 类档位与文档逐项一致（11/10/10/10/9/8/8/7/6/5/4）；`comparePriority` 风险→`occurrence_count` desc→`created_at` asc；行为面：并发位被占住时后入队的 `memory_webshell` 先于先入队的 `honeypot` 执行 | 绿 | `tester-queue.mjs` |
| A5 并发/队列上限 | 配置面：0/-5/1.5/'abc'/null/'' 回落 2，`queueLimit` 同类回落 1000，env 与显式参数优先级；行为面：`concurrency=0` 入队仍跑成 `done`（不卡死）、`concurrency=2` 同时 `running` 恰 2 条；队列满手动 `enqueue` 429 + `dropped` 只增；轮询批量越限只丢弃不抛（5 条上限 1 → 丢 4）；`summary()` 键与类型 | monitor 层绿；**真进程 concurrency 红** | `tester-queue.mjs`；`tester-http-concurrency.mjs`（1/5 都读出 2）；`tester-logs/tester-http-*.txt` |
| A6 RuleStore mtime 缓存 | 同字节数、恢复原 `mtimeMs` 的非法内容**不被重解析**（走缓存）；`mtime` 一变立刻解析并报「不支持的语法」；恢复合法内容后解析恢复；同 id 新文件报「规则 id 重复」；新 id 文件立刻多一条；删文件立刻少一条 | 绿 | `tester-stores.mjs`（18/18）、`tester-logs/tester-stores.txt` |
| A7 Wiki 索引 mtime 缓存 | 同签名两次 `agentIndex` 一致；同字节数、恢复 `mtimeMs` 的标题改动**看不到**；`mtime` 一变标题与 `agentIndex` 同步生效；删页立刻少一条；未知类型照样抛错 | 绿 | `tester-stores.mjs` |
| A8 `/api/status` 探活缓存 | 窗口内两次只发 1 次 RPC；并发 3 次共用同一次（promise）；失败不缓存；`HIDS_STATUS_TTL_MS=60` 过期重探、`=0` 关闭、`=-1` 回落默认；真进程内 `/api/status` 两次 → 1 次 RPC、400ms 后重探 | 绿 | `tester-gateway.mjs`（23/23）、`tester-http-e2e.mjs` |
| A9 详情失败路径探活 TTL | 首次失败补 1 次同类列表探活；5s 窗口内第二次失败不再探；详情本身不缓存；`HIDS_PROBE_TTL_MS=0` 每次都探 | 绿 | `tester-gateway.mjs` |
| A10 列表快照 | 同键 15s 内不再发 RPC；浅拷贝（调用方 `reverse/push` 改不到缓存）；换批大小是新键（重新拉 11 类）；`HIDS_LIST_SNAPSHOT_TTL_MS=0` 关闭；真进程 `/api/alerts?count=50` 连续两次第二次 0 次 RPC，且启动轮询已铺好的快照被筛选直接命中（首次增量 0 次） | 绿 | `tester-gateway.mjs`、`tester-http-e2e.mjs` |
| A11 四个取数点 | 三个改动点见 A2；trace-board 复用路径由既有用例锁住，本树亲跑 `node --test trace-board.test.js` → 12/12，含「A4 告警分析已取到的证据直接引用，不为同一份再查一遍」 | 绿 | `tester-logs`（见 §五 命令） |
| A12 负载探针 | 独立数据根（`mktemp` + 三个 `HIDS_*` 注入口，探针自带仓内路径拒收）、无固定 sleep（`waitUntil` 谓词 + 30s 上界）、跑前跑后工作树指纹一致、退出码 0 | 绿 | `tester-logs/probe-load.txt`（`bash evidence/test/P003-T037/probe-load.sh`，exit 0） |
| 单测 | 写者整套：216/216、exit 0、约 0.74s（测试席亲跑） | 绿 | `tester-logs/npm-test.txt` |

真进程 HTTP 面（`tester-http-e2e.mjs`，85 绿 / 1 红）：`/api/config` 口径、`TriageSummary` 全部 required 与 P003-T037 新键的类型/取值、`since` 三种边界（RFC3339 归一 / 空值不筛 / `abc` 400「筛选起始时间无效：abc」`caller_error`）、`POST` 非法 ID 400、`syslog:` 无原始报文 404、`cases?count=0` 400「分页参数无效」、`control` 缺键/非布尔 400、队列满 `POST` 429（正文 `{error:"研判队列已满（上限 1），稍后再试", code:"caller_error"}`）且 `dropped=1`、`createServer()` 缺件时 `/api/agent/triage/status` 503 `not_configured` 与 `/api/status` 200 `configured:false`、syslog 模式 `TriageSummary.syslog` 三键与 `bind` 形如 `udp://…`、`last_poll_at` 恒 null。

## 三、发现（findings）

### F1（major，实现与文档不一致）真进程里 `HIDS_TRIAGE_CONCURRENCY` 不生效

- 文档出处：`docs/architecture.md:449`（「自动研判同时跑几条……改完要重启进程」）、`docs/modules/triage-pipeline.md:542` 与 `:900`、`openapi.yaml:1660`（`TriageSummary.concurrency` 描述「HIDS_TRIAGE_CONCURRENCY，缺省 2」）
- 文档说：环境变量决定同时研判条数；`summary().concurrency` 应回报生效值。
- 实测：真进程 `HIDS_TRIAGE_CONCURRENCY=1 / 3 / 5` → `GET /api/agent/triage/status` 的 `concurrency` **恒为 2**；同一棵临时树上 `HIDS_TRIAGE_QUEUE_MAX=1 / 10` 分别读出 1 / 10（说明 env 确实进了进程，队列上限接得上，只有并发没接上）。monitor 类本身能读：`new TriageMonitor({})` 在 `HIDS_TRIAGE_CONCURRENCY=3` 下 `summary().concurrency=3`，`concurrency:0` 还会回落到 2。
- 复现：`timeout 60 node evidence/test/P003-T037/tester-http-concurrency.mjs` → exit 1，输出 `✖ HIDS_TRIAGE_CONCURRENCY=1 -> summary().concurrency=2`、`✖ …=5 -> 2`。
- 影响：`A5` 的「并发数可配」在生产路径上等于不存在，运维按文档调这个变量不会生效，只能吃默认 2；`TriageSummary.concurrency` 对调用方恒报 2。
- 建议改法：`server.js` 装配 `TriageMonitor` 的地方把并发从环境变量传进去（`concurrency: positiveInteger(process.env.HIDS_TRIAGE_CONCURRENCY, 2)` 之类，让 `triage-monitor.js:83` 的规范化继续兜底），或确认现在是哪里显式传了 2 覆盖掉 env；改完用 `tester-http-concurrency.mjs` 复验（应 1/5 各自成立）。

### F2（minor，doc-side）`POST /api/agent/triage/{alertId}` 的 429 没进 openapi

- 文档出处：`docs/modules/triage-pipeline.md:472` 写明队列满时 `enqueue` 抛 429；`openapi.yaml:506-515` 这条路由只声明了 202/400/404。
- 实测：`HIDS_TRIAGE_QUEUE_MAX=1`、第一条在跑时 `POST /api/agent/triage/honeypot:2` → **429**，正文 `{"error":"研判队列已满（上限 1），稍后再试","code":"caller_error"}`。
- 复现：`timeout 200 node evidence/test/P003-T037/tester-http-e2e.mjs`（「队列上限 429」段）。
- 影响：按 openapi 生成客户端/网关会把这个 429 当未声明状态码，前端拿不到契约里的处置口径。
- 建议改法：`openapi.yaml` 该路由 `responses` 补 `'429'`（复用 `#/components/responses/TooManyRequests` 或 `Error`），并在 `description` 里写清「排队 + 在跑达到 `queue_limit`」；顺带把同路由缺声明的 503 一并补（http-api 文档已写，openapi 没有）。

### F3（minor，doc-side）冷启动首轮被计入「空轮」，重启后首轮真实轮询延迟翻倍

- 文档出处：`docs/modules/triage-pipeline.md:374`（首次轮询只钉游标、不入队）与 `:384`（「空轮（含失败轮）把 `emptyPolls` 加一」）。
- 实测：首次轮询页里有数据、只是不入队 → `poll()` 返回 `empty:true`，`empty_polls=1`、`backoff_ms=2×intervalMs`（`tester-queue.mjs`「A1 指数退避」段的 `· 冷启动后 [2000,1]`；真进程 `tester-http-e2e.mjs` 里刚起来 `empty_polls=1`、`backoff_ms=60000`）。
- 影响：不是「漏告警」，但重启后的第一轮真实增量轮询要等 2×interval（默认 60s）才发生；文档没写这个口径，验收方会按「空轮=没新告警」去理解。
- 建议改法：`§5.2` 的退避段补一句「冷启动钉游标的这一轮也算空轮，因此重启后首轮间隔为 2×interval」；若认为不该算空轮，改动实现后同步文档。

## 四、变异验红（测试席亲手跑，各恰红后还原）

| 变异 | 结果 | 还原后 |
| --- | --- | --- |
| 在 `triage-monitor.js:83` 后插回 `this.concurrency = concurrency;`（复审整改删掉的覆盖行） | `tester-queue.mjs` 恰红 10 条（`concurrency=0 → 2` 等字段面 + 「concurrency=0 入队跑成 done」行为面），pass 105 / fail 10 | `git checkout -- triage-monitor.js` → 115/115 绿 |
| 删 `investigation-agent.js:368`（复用分支次数闸） | `tester-agent.mjs` 恰红 2 条（该用例本身 + 文案），14/16 | 还原 → 16/16 |
| 删 `investigation-agent.js:370`（复用分支 2MB 闸） | `tester-agent.mjs` 恰红 2 条（同用例的两条断言），14/16 | 还原 → 16/16 |

日志：`tester-logs/mutation-1-concurrency.txt`、`mutation-2-maxcalls.txt`、`mutation-3-2mb.txt` 及对应 `*-restored.txt`。三次变异全部 `git checkout` 还原，工作树产品文件无改动（`git status --porcelain` 只剩测试席新增文件）。

## 五、命令与结果（本树亲跑）

```
$ timeout 600 bash evidence/test/P003-T037/tester-run-all.sh     # exit 1（已知红＝F1）
  tester-queue   pass 115 / fail 0
  tester-gateway pass 23 / fail 0
  tester-stores  pass 18 / fail 0
  tester-agent   pass 16 / fail 0
  tester-http-e2e pass 85 / fail 1（concurrency=3 -> 2）
  tester-http-concurrency ✖ 2 条不成立（env 1 / 5 都读出 2）

$ timeout 300 npm test                                           # exit 0
  tests 216 / pass 216 / fail 0 / duration_ms 740

$ timeout 150 bash evidence/test/P003-T037/probe-load.sh         # exit 0
  ✔ 工作树未被写入（before=after=…）  ✔ 运行根=…（已清理）

$ timeout 120 node --test trace-board.test.js                    # exit 0
  tests 12 / pass 12 / fail 0（含「A4 告警分析已取到的证据直接引用…」）
```

## 六、残余风险 / 没查到的

1. 牧云真实环境未接：所有「不再发 RPC」都是本机假 RPC 计数，真实平台的 `from` 语义（是否含端点、排序键是否真按 `created_at desc, id asc`）按文档假设，未在现网核实。
2. F1 的根因（server 哪里把并发写死/覆盖）测试席不看实现、未定位，只给出可观测面与复验命令。
3. 2MB 超限路径没有真实样本（写者已申报），探针用合成 2,000,001 字符构造；只要实现按字符数判就不会误判。
4. `concurrency` 显式传数字字符串 `'4'` 时被当成 4（文档把「非数」算非法，但数字字符串算不算数没写）——只记录，不判。
5. 真进程 e2e 用复制树 + 假 RPC/假模型，没有跑真牧云与真模型；进程内 `createServer()` 缺件路径覆盖了 503，但真进程启动闸门（缺配置拒启）不在本卡验收面。
