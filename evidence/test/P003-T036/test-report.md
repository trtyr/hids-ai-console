# P003-T036 测试报告（测试席 · 何东阳）— 复审后验收轮

- 任务卡：P003-T036 队列可靠性与恢复（失败退避 / 暂停不丢 / 落盘不暴涨）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T036`，HEAD `15a0924`，起活时树干净、复验结束树干净（只有我这份未跟踪的 `tester-http-acceptance.mjs`）
- 代码审查判词：`verdicts/T036-gc-backend-code-review-mwnnv225.json`（pass，A1–A10 全 pass）
- 判据只取契约文本：`openapi.yaml` 的 `TriageSummary`（:1653 required 十三键）/ `delete: /api/agent/triage/{alertId}`（409/404/400）/ `put: /api/agent/triage/control`，`docs/modules/triage-pipeline.md` §5.1/§5.4/§5.5/§8/§10（R-TRIAGE-05/06/11/12/13）、§12/§13，`docs/modules/http-api.md` §3 路由表（:101-:104）。**没读实现内容**（`triage-monitor.js` / `server.js` 一行没看），也没顺着 stack trace 翻源码。

## 结论

**PASS。** A1–A10 全部在我自己终端上跑过；A4（上轮唯一 fail 的要害）我亲手复现了变异验红与恢复复绿。
另加我自己写的一套 HTTP 契约套件（146 条断言，`TESTER_OK`，exit 0），补上写者套件没覆盖的 HTTP 层 schema/边界/错误码。
一条 `doc-side` 观察不挡路（`openapi.yaml:479` 的 `additionalProperties:false` 与实测不符，本卡之前既存），见 §五。

## 一、门禁（每条都是我在这个终端里跑的）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 后端全套 | `npm test` | `ℹ tests 198 / ℹ pass 198 / ℹ fail 0`，714ms，**exit 0**（跑两遍：695ms / 714ms） |
| 本卡单测 | `node --test --test-timeout=60000 evidence/test/P003-T036/queue-reliability.test.js` | `ℹ pass 18 / ℹ fail 0`，356ms，**exit 0** |
| 留档复现脚本 | `node evidence/test/P003-T036/repro-flush-liveness.mjs` | `writes=2 dirtyGen=3 writtenGen=3 timer=false flushing=false` / `gap-proof on disk? true` / `summary.persist = {"interval_ms":200,"unflushed":false}`，**exit 0** |
| 真进程探针 | `bash evidence/test/P003-T036/probe-queue-reliability.sh` | 29 条 PASS，`PROBE_OK 负载段与空闲段全绿`，**exit 0**（独立数据根 `mkdtemp`，空闲 1.2s 零写入、零在跑） |
| 变异验红 | `bash evidence/test/P003-T036/mutate-check.sh` | 9 条变异**全红**、`恢复后复跑：ℹ pass 18 ℹ fail 0`，**exit 0**；跑完 `git status --porcelain` 只剩我那份未跟踪脚本、`git diff --quiet` 通过（树干净） |
| 我自己写的 HTTP 契约套件 | `node evidence/test/P003-T036/tester-http-acceptance.mjs` | `TESTER_OK 共 146 条断言，失败 0`，**exit 0** |

变异输出留档：`evidence/test/P003-T036/tester-mutations.log`（`*.log` 被 `.gitignore` 忽略，文件在盘上）。9 条逐条红：

```
PASS 变异「A1 死信判定失效」→ 红   PASS 变异「A2 暂停直接丢」→ 红   PASS 变异「A3 删记录不失效 dedupe」→ 红
PASS 变异「A4 逐条全量重存」→ 红   PASS 变异「A4 合并写 liveness 洞」→ 红（恰红「在飞写期间标脏不丢」3008ms）
PASS 变异「A5 TTL 归档不做」→ 红   PASS 变异「A6 summary 不报队列深度」→ 红
PASS 变异「A7 回补退回队列键」→ 红 PASS 变异「A9 取消不判状态」→ 红
```

A4 的变异我自己重跑了两遍（第一遍随手跑、第二遍落日志），两遍都恰红该用例、恢复后 18/0，树干净——断言不是永真。

## 二、验收逐条（A1–A10）

| 验收 | 我的证据 | 实测 |
| --- | --- | --- |
| A1 退避重排 + 死信 | 本卡单测亲跑（A1 四条）＋ 探针 `负载段` | 退避 100→200→400→800→1000 封顶；瞬时故障 3 次内跑通；到上限进死信、`failure{reason,code,at}` 保留；60ms 内不再自动跑；跨重启补排。探针里 2 个持续失败的事件进死信、`summary.failure_reasons={"模型不可达":2}`、`retry{base=50,max=200,max_attempts=3}` 可查。变异 1 撤死信判定 → 该组红 |
| A2 暂停缓冲 / 恢复回灌 | 探针真 UDP ＋ 我的 HTTP 套件 | 探针：暂停期间收 5 条（缓冲 3 / 丢弃 2），缓冲上限 3 时 2 条丢弃**计数不静默**（`syslog_stats.dropped=2`），恢复回灌 3 条全跑完、`replayed=3`。我的 HTTP 套件：`paused.received=2 / buffered=2` → 恢复后 `buffered=0 / replayed=2`，且恢复**不清 queued**（`counts.queued` 保持 1，R-TRIAGE-06）。变异 2 → 红 |
| A3 dropRecord 失效 dedupe | 本卡单测亲跑 ＋ 变异 3 | 取消后 dedupe 条目同步消失、同一报文再来算新记录；TTL 归档同样失效 dedupe。变异 3 → 红（该条与 A5 用例同时红） |
| **A4 合并写（要害）** | `repro-flush-liveness.mjs` ＋ 变异 9 ＋ 探针写盘计数 ＋ 单测 A4 三条 | 在飞写期间标脏 → 写完补排、脏代数归零、盘上拿到那条记录（`gap-proof on disk? true`、`unflushed:false`）；不调 `persist()` 也不丢。探针负载段 200 条报文 / 1s 内只写 2 次快照；重复投递不逐条重存。变异 9 撤 finally 补排 → 恰红「A4 在飞写期间标脏不丢」3008ms、其余绿，恢复 18/0 |
| A5 TTL 归档 | 本卡单测亲跑 ＋ 探针归档段 ＋ 变异 5 | 过期 done 记录移出 `records`、追加 `.archive.jsonl`、`status()` 回 null、`cases()` 不列、`summary().archived.count` 计数；新鲜的 done 与 queued 不动。探针真进程归档 8 + 3 条后文件 11 行可读 |
| A6 summary 新键 + 契约同步 | **我自己的 146 条断言**（`tester-http-acceptance.mjs:47` 起）＋ 变异 6 | `openapi.yaml:1653` 的 required 十三键**一条不缺**；`counts` 四键、`verdict_counts` 四键、`queue` 五键、`retry` 四键、`paused` 六键、`archived` 两键、`persist` 两键、`syslog_stats` 七键逐键类型对上；`input_mode` 枚举命中；`paused.active === !enabled`；空队列与 1 条排队、syslog 与 poll 两种模式各验一遍。变异 6 → 红 |
| A7 回补键序 | 本卡单测亲跑 ＋ 变异 7 | 替身 history 断言第一枪打在 `revshell:77` / `honeypot:99`（结果键优先），没拿队列键去撞；三键都取不到退回队列键且不炸。变异 7 → 红 |
| A8 syslog_stats | 本卡单测亲跑 ＋ 我的 HTTP 套件 | 4 条进 → `accepted 1 / collapsed 1 / rejected 2`；暂停溢出时 `dropped` 同时进 `paused.dropped` 与 `syslog_stats.dropped`；七键在 HTTP 响应里都是整数 |
| A9 cancel + DELETE 错误面 | **我的 HTTP 套件**（`tester-http-acceptance.mjs:267,303`）＋ 探针 | 真 HTTP：`DELETE` 排队记录 → 200、正文**恰三键** `{alert_id,status:"not_queued",cancelled:true}`；随后 `GET` 回 `not_queued`；再删 → 404 `caller_error`；无效 ID `%20` → 400；合法形状但无此记录 → 404；超长 ID（5000 字）→ 400；**running → 409**、**done → 409**，且 409 之后记录仍在（没被顺手删）。四条错误面都断言了 `{error,code}` 两键形状，不只看状态码 |
| A10 探针与上界 | 探针亲跑 | `PROBE_OK`，独立 `mkdtemp` 数据根，状态等待全走 `until()` 带上界、外壳 `timeout`；空闲 1.2s 零快照写入、`depth=0`、`running=0`、`retry_timers=0` |

## 三、schema 符合性 / 边界 / 错误码（我自己补的那三样）

**schema 符合性**（`tester-http-acceptance.mjs:51`）：`GET /api/agent/triage/status` 的响应按 `openapi.yaml:1653` 逐字段验——
顶层 required 十三键、每个嵌套对象的 required 键与类型、`input_mode` 枚举、`since` 无参为 null、`archived.ttl_ms=86400000`、
`persist.interval_ms=1000` 缺省值；syslog 模式下 `syslog{listening,bind,error}` 与 `syslog_stats` 七键在、poll 模式下这两键**不在**
（openapi 明说「仅 syslog 时出现」）；`last_poll_at` 在 poll 模式仍在。空队列 / 1 条排队 / 暂停中 / 恢复后四种状态各验一遍。

**边界矩阵**：`PUT /api/agent/triage/control` 五类非法正文——无正文、`{}`、`{enabled:"yes"}`、`{enabled:1}`、
正文 `true`；`GET /status?since=not-a-time`；`DELETE` 五类边界（无效 ID `%20` / 合法形状无此记录 / 超长 ID 5000 字 /
running / done）。每条都断言状态 + `code` + 错误体两键形状。

**错误码覆盖**：400（六类正文 + since 坏值 + 无效 ID + 超长 ID）、404（无此记录 / 再删一次）、409（running / done）、
503 `not_configured`（`createServer(..., monitor=null)` 时 status / cases / DELETE / control 四条路由全触发），
每个错误体都断言 `{error:string, code:string}` 与 `code` 取值，不只看状态码。

## 四、没查到 / 没压到的（残余风险，不算绿）

1. **合并写的峰值写频率只在 200 条/秒量级压过**（探针 1s 内 2 次快照）。万级流量下合并写窗口是否仍守住
   「≤1 次/`persist_interval_ms`」没压过。
2. **暂停缓冲上限用 3 压的**（探针把 `paused_buffer_limit` 设成 3），缺省 2000 条的真实溢出点没压到 2000 这个数，
   只验了口径（超出计数不静默）。
3. **TTL 归档扫描定时器没按缺省 10 分钟真等过**：探针用 `done_ttl_ms=300ms` + 手动/短窗口触发。缺省 10 分钟扫描
   与 `unref()` 的真时序没验。
4. **没有带 Basic 认证跑**：本卡四条 triage 路由都是在未配 `HIDS_BASIC_AUTH_*` 的进程里验的；配了口令后的
   401 面属既有契约（T025/T029 卡），本卡没回归。
5. **`DELETE` 的 409/400 优先级只验了各自单独触发**（running → 409、无效 ID → 400），一条同时「ID 非法且记录在研判中」
   的叠加路径没构造。

## 五、doc-side 观察（不挡路，本卡之前既存）

`openapi.yaml:479` 给 `PUT /api/agent/triage/control` 的请求体声明了 `additionalProperties: false`，
实测 `{"enabled":true,"foo":1}` 回 **200 并照常切换**，多余键被忽略（`tester-http-acceptance.mjs:236`）。
这行声明在 `a77d43a~1` 就有（不是本卡引入），且 `docs/modules/http-api.md` 正文没写过「多传键回 400」，
所以我按 spec 过度承诺记，不判实现违约。改法两条选一：`additionalProperties: true`，或服务端对多余键回 400。

另有一处轻微口径缺口：`docs/modules/http-api.md:104` 的 DELETE 行列了 503/404/409，没列**400**（无效 ID），
而 openapi 的 delete 有 400、实测也回 400。补一句「ID 不合法回 400」就齐了。

## 六、这棵树上我留了什么

- `evidence/test/P003-T036/tester-http-acceptance.mjs`（**未跟踪**，146 条断言的独立契约套件；下一棒要复跑直接
  `node evidence/test/P003-T036/tester-http-acceptance.mjs`）
- `evidence/test/P003-T036/tester-http-acceptance.log`、`tester-mutations.log`（`*.log` 被 `.gitignore` 忽略）
- 产品代码、写者的测试、文档：**一个字没动**（`git diff --quiet` 通过）
