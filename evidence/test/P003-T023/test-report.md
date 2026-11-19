# P003-T023 后端测试报告

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T023`（分支 `task/hids-ai-console-P003-T023`）
- 被测提交：`432edfb`（产品代码，之后产品路径零 diff）；其后的提交只有纸与本席证据（`603559d`、`eb2c5a3`、本轮复审修正提交＝本报告的 HEAD）
- 测试面：**只走文档承诺的公开面**——`docs/architecture.md` §3.6「日志」事件名表 / §8.1 运行态路径表 / §11.1-11.3、`docs/modules/http-api.md` 路由表与错误码、`docs/modules/triage-pipeline.md`（poll 模式与落盘习惯）、`log.js` 文档化的三个导出（`createJournal` / `log` / `useJournal`）。**未读实现文件内容**，行号核对只用 `grep -n` 做符号级定位。
- 探针：`evidence/test/P003-T023/probe.mjs`（**70 条断言 / 7 段**：真进程 `spawn(server.js)` + 真 HTTP + 真 UDP，子进程逐个 `SIGKILL` 回收；S7 在 `tmpdir` 的源码副本里跑，不碰仓内 `.data`；外部依赖一律 `127.0.0.1:1` 与本机回环，不碰外网）
- 写者单测：`evidence/test/P003-T023/logging.test.js`（15 条，我亲跑，绿）

## 0. 本轮复审修正（test-review 判 reject_test 的两条）

| 退回项 | 上一版的说法 | 本轮核实与处置 |
| --- | --- | --- |
| ① 报告称六条 FATAL 事件「只在写者单测里有断言」 | §6 第 1 条这么写，但全仓单测**零命中** | 上一版是错的，已删。证据：`git grep -n "server.start_failed\|syslog.handler_failed\|syslog.receiver_error\|syslog.accept_failed\|triage.persist_failed\|triage.poll_failed" -- '*.test.js'` → **EXIT=1，零命中**；`logging.test.js:273` 那条名字叫「syslog 绑定失败与接收器错误也在日志里」，正文（`:281`/`:283`）只断言 `syslog.bind_failed`，「接收器错误」没有断言。处置：**不写不存在的断言**——能黑盒造的四条（`syslog.accept_failed` / `syslog.handler_failed` / `triage.poll_failed` / `server.start_failed`）本轮补进探针 S6/S7 真进程实测，剩下两条（`syslog.receiver_error` / `triage.persist_failed`）在 §2 与 §6 里如实标「无断言」 |
| ② `probe.mjs` 两处 `sleep(150)` 当同步 | S1 数 `http.request`、S2 数 `cloudwalker.call_failed` 前先睡 150ms | 已换成哨兵等待 `waitUntil(predicate, ms, label)`（轮询条件 + 超时抛错，失败落一条 FAIL 而不是静默少数）。`grep -n "sleep(150)" probe.mjs` → 零命中。变异验红：把 S1 期望条数改成 `>=13` → 探针 **EXIT=1**，恰红在「S1 各请求的 http.request 都到齐（哨兵等待 12 条…）:: 等不到「http.request × 12」（2500ms）」；把 S2 期望 op 里加 `tools` → **EXIT=1** 恰红在同一段哨兵；还原后 **EXIT=0 复绿** |

## 1. 验收锚点（任务卡 A1-A5）

| 锚点 | 判据（任务卡原文） | 结果 | 证据（我这轮实测） |
| --- | --- | --- | --- |
| A1 | 有一个落点写日志，不是各处自己 console.log | **pass** | `grep -n "console\." server.js triage-monitor.js syslog-input.js log.js` → 只命中 `log.js:2` 一行注释，0 处调用；四个真进程段 stdout **逐行都能 `JSON.parse`**（`badLines=[]`），无一行自由文本；`server.started` / `http.request` / syslog 三行 / 研判两行 / `maintenance.result` 同出一处形状 |
| A2 | HTTP、syslog 收下或解析失败、研判入队到完成或失败、牧云调用失败、误报维护结果，都能在日志里找到 | **pass** | 五类全在真进程里拿到：HTTP（S1/S2：`http.request` 12 条、`http.unauthorized` 2 条、`http.failed` 2 条）；syslog（S3/S4：`listening`/`received`/`collapsed`/`parse_failed`/`skipped`/`bind_failed`）；研判（S3：`triage.enqueued` source=`manual` 与 `retry`、`triage.done`、`triage.failed`）；牧云（S2：op=`status`/`alerts`/`alert`；S3：op=`call_tool`）；维护（S3：`maintenance.result` 带两侧状态与原因）。逐事件覆盖见 §2 |
| A3 | 每条有时间和事件名。能对上告警的带告警 ID | **pass** | 每一行断言 `Object.keys(line).slice(0,3) === ['time','level','event']`、`time` 匹配 ISO-8601 UTC、`level ∈ {info,warn,error}`；字段里的 `event/time/level` 覆盖不了保留键（S5 注假值后仍原样）；`alert_id` 实测：`syslog.received`/`syslog.collapsed`（两侧同 ID）、`triage.enqueued`/`triage.done`/`maintenance.result`、`cloudwalker.call_failed`（有该键，syslog 匹配侧为 `null`），形态分别对上 `syslog:<type>:<16hex>:<秒>:<uuid>` 与 `honeypot:<id>` |
| A4 | 日志里不出现 Authorization、Cookie、API Token | **pass** | 真进程带 `Authorization: Basic <base64>`、`Cookie`、`x-prompt-admin-token`、`?token=` 打请求，整份 stdout 对 5 个凭据值（口令原文、base64、Cookie 值、管理令牌、query 令牌）**零命中**；另加环境里的 `CLOUDWALKER_API_TOKEN` / `LLM_API_KEY` 也零命中；`log.js` 契约侧矩阵：敏感键大写/嵌套/数组一律 `[redacted]`，字符串里 `Basic …` / `Bearer …` / `token=…` 全擦（S5） |
| A5 | 不新增日志依赖 | **pass** | `git diff a6cbaa3..432edfb -- package.json` → 空（0 行）；`grep -n "^import\|require(" log.js` → 无命中（exit 1）；`git show --stat 432edfb` 只有 7 个文件，无 `package.json` / lockfile |

**本轮零 diff 复核**：`git diff --stat 432edfb..HEAD` → 只有 `coding-reports/P003-T023.md`、`evidence/recon/P003-T023.md` 两张纸与本席证据（`evidence/test/P003-T023/` 下 probe + 报告），**产品路径零改动**（`git diff --stat 432edfb..HEAD -- server.js triage-monitor.js syslog-input.js log.js package.json` → 空）。A1/A3/A4/A5 判定因此与第一轮同口径，A2 判据由本轮探针独立重跑。

### D028 五处补记行号（逐一对照实物）

| recon 声明 | 实物（`grep -n`） | 结论 |
| --- | --- | --- |
| `server.js:892` `http.failed` | `892: log('http.failed'` | 命中 |
| `triage-monitor.js:303` `syslog.accept_failed` | `303:` | 命中 |
| `triage-monitor.js:346` `syslog.collapsed` | `346:` | 命中 |
| `triage-monitor.js:254` poll 侧 `cloudwalker.call_failed`(alerts) | `254:` | 命中 |
| `triage-monitor.js:430-447` `cloudwalkerCall` + `observedToolbox`、`:461` 调用点 | `430: async cloudwalkerCall`、`440: observedToolbox()`、`446: this.cloudwalkerCall(op, …)`、`461: matchSyslogEvent(this.observedToolbox(), …)` | 命中 |
| 附：「改动前这几处一行日志都没有」 | `git grep -c "'http.failed'\|'syslog.accept_failed'\|'syslog.collapsed'\|'cloudwalker.call_failed'" a6cbaa3 -- server.js triage-monitor.js` → 四条全空 | 命中 |

另抽查 recon §2 其余锚点：`server.js:385/545/548/721/919/927`、`triage-monitor.js:97/163/167/235/289/295/310/317/322/362/422/486/526/530`、`syslog-input.js:112/113`、六处 `viaCloudwalker` 调用点（494/563/568/573/861/878）——逐条与实物一致。checklist `[x]` 16 条 / `[ ]` 0 条。

## 2. 事件覆盖矩阵（文档 §3.6 事件表 × 谁验的）

| 事件 | 本轮真进程实测 | 备注 |
| --- | --- | --- |
| `server.started` | ✅ S1/S2/S3/S4（host/port/level 断言） | |
| `http.request` | ✅ S1（12 条）/S2/S3：method/path/status/duration_ms 全断言，path 去 query | |
| `http.unauthorized` | ✅ S1（无凭据 / 错口令各一条） | |
| `http.failed` | ✅ S2：`/api/alerts`、`/api/alerts/honeypot:7`，status=502 + error | `/api/status` 的 502 走自身分支（文档写明正文带 `configured/connected/reason`），不落 `http.failed`——与文档一致 |
| `cloudwalker.call_failed` | ✅ S2 op=`status`/`alerts`/`alert`；S3 op=`call_tool` | op=`tools`/`mcp_tools`/`list_events` 黑盒未触发（见 §6） |
| `syslog.listening` | ✅ S2/S3：`bind=udp://127.0.0.1:<port>` | |
| `syslog.bind_failed` | ✅ S4：端口被占，error 含 `EADDRINUSE`，HTTP 面照常 200 | |
| `syslog.received` | ✅ S3：alert_id 形态 + msgid + event_type + occurrence | |
| `syslog.collapsed` | ✅ S3：重复投递，alert_id 与 received 相同、repeat_count≥1 | |
| `syslog.parse_failed` | ✅ S3：垃圾报文，error 含 RFC5424、bytes>0 | |
| `syslog.skipped` | ✅ S3：`reason=no_agent_for_msgid` | `reason=paused` 未触发（§6） |
| `triage.enqueued` | ✅ S3：source=`manual`（手动入队新告警）与 `retry`（重排已完成记录） | syslog 直达执行不发这条，见 F3 |
| `triage.done` | ✅ S3：alert_id/verdict/attempts/duration_ms | |
| `triage.failed` | ✅ S3：手动入队后牧云不可达，alert_id/attempts/error | |
| `maintenance.result` | ✅ S3：alert_id/status=`failed`/rule/wiki/两侧 error（词表 `updating|updated|failed`） | 成功态（两侧 `updated`）未造（§6） |
| `log.serialize_failed` | ✅ S5：getter 抛错时落一条 level=error | |
| `server.start_failed` | ✅ S7：状态文件写成非法 JSON（临时副本），落 `what:"triage"` + `error`（含 JSON 解析原文） | 上一版「⛔ 未触发」作废 |
| `syslog.accept_failed` | ✅ S7：状态目录不可写，收包链抛错 → 一条，`error` 含 `EACCES` | 上一版「⛔ 未触发」作废 |
| `syslog.handler_failed` | ✅ S7：同一抛错在收包回调兜底再落一条，`error` 非空 | 上一版「⛔ 未触发」作废 |
| `syslog.receiver_error` | ⛔ **无断言**（探针与单测都没有） | 需 UDP socket 的 `error` 事件，黑盒只能从进程外发包，造不出（§6） |
| `triage.poll_failed` | ✅ S6：`HIDS_TRIAGE_INPUT_MODE=poll` + 牧云不可达，启动第一轮即落，`error` 非空 | **不用等 30s 定时器**：首轮在 `server.started` 后立刻跑 |
| `triage.persist_failed` | ⛔ **无断言**（探针与单测都没有） | 已落盘的两条路径是后台 `drain()` / 进度回调：要把研判跑过半程才触发，黑盒造不出；同步入队路径的状态落盘失败实测走 **502 + `http.failed`**，不落这条（F5，§3 已钉） |

## 3. 边界与错误码（黑盒实造）

| 类 | 用例 | 实测 |
| --- | --- | --- |
| 401 | 无凭据 `/`、错口令 `/api/session` | 均 401；正文纯文本「需要登录后访问」、`Content-Type: text/plain`（与 docs/modules/http-api.md:30 一致）；日志另有 `http.unauthorized` |
| 400 | 误报理由 2 字 | 400 `{error:string}`；同请求在日志里留下 http.request(status=400) |
| 404 | `/api/nope`、`POST /api/session`、误报无此案件 | 均 404；前两者正文「接口不存在」、无案件正文 `{error}` |
| 405 / 410 | `POST /api/agent/prompts` / `/api/agent/prompts/upload` | 405「请使用提示词文件上传入口」/ 410「提示词更新已迁移到独立维护端…」，与固定响应表一致 |
| 502 | 牧云配了但连不上：`/api/status`、`/api/alerts`、`/api/alerts/{id}` | 502；status 正文仍是 `{configured:true, connected:false, reason}`；其余 `{error}`，另有 `http.failed` |
| 503 | 未配牧云 `/api/alerts`、`/api/agent/triage/status`、无队列时误报登记 | 503；正文分别「未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN」「自动研判尚未配置」、`{error}` |
| 202 | 误报登记 / 手动入队 / 重排 | 202；误报正文 `{alert_id, verdict, feedback, maintenance}`（`verdict.verdict=false_positive`），记录读回 `verdict=false_positive`、`decision_source=human` |
| 超长 | 1400 字路径 | 回 JSON 错误；日志里 path 截断（≤1001 字），行仍合法 JSON、单行 |
| 空/怪字段（log API） | 无字段 / `null` / 字符串 / 数组 / 空对象 | 均落一条合法行且不炸；非对象字段被丢弃（与现行实现一致） |
| 循环引用 | `{self: 环}` | 不抛业务异常；正常落一条、环处写 `"[depth]"`（文档说落 `log.serialize_failed`，见 F2） |
| 写入器抛错 | `write` 抛 EPIPE | 不抛业务异常（静默丢弃） |
| 注入 | 字符串值含 `\n` / `\r` | JSON 转义，一条日志仍只占一行 |
| 5xx（状态落盘失败） | 状态目录不可写时 `POST /api/agent/triage/{id}` | 502 `{error:"EACCES…"}` + `http.failed`；文档只写 202/503（F5） |
| 非法环境值 | `HIDS_SYSLOG_PORT=99999` / `abc` / `65536` | 不报错也不回落到文档默认 `15514`：`99999` 绑到 **34463**（= 99999−65536，按 16 位截断）；`abc` / `65536` 绑到系统分配的随机端口（两轮分别 41048/42917 与 57432/55483）；文档未写非法值行为（F6） |

## 4. 门禁与变异（全部本终端亲跑，退出码原样）

| 命令 | 结果 |
| --- | --- |
| `timeout 120 node --test evidence/test/P003-T023/logging.test.js` | **EXIT=0**，tests 15 / pass 15 / fail 0（341.8ms）——写者单测，我亲跑 |
| `timeout 200 node evidence/test/P003-T023/probe.mjs`（本席探针） | **EXIT=0**，PASS 70 / FAIL 0（约 1.2s）；连跑 3 次全绿（1214ms / 1193ms / 1188ms）（状态隔离：每次用一次性随机 syslog 指纹与一次性告警 ID，见 §6） |
| 变异 M5（哨兵不是摆设）：S1 期望条数改 `>=13` | 探针 **EXIT=1**，恰红在 `S1 各请求的 http.request 都到齐（哨兵等待 12 条…）:: 等不到「http.request × 12」（2500ms）`；还原后 **EXIT=0 复绿** |
| 变异 M6：S2 期望 op 里加 `tools` | **EXIT=1**，恰红在 `S2 三条牧云失败与 http.failed 都到齐（哨兵等待…）:: 等不到「cloudwalker.call_failed × 3 与 http.failed × 2」（5000ms）`；还原后 **EXIT=0 复绿** |
| `timeout 300 node --test *.test.js` | **EXIT=1**，tests 198 / pass 197 / fail 1——唯一红 `maintenance CLI starts when the deployment current path is a symlink`（`maintenance-startup.test.js`），与 `docs/_meta/gaps.md:19,30` 记载的既有基线一致；与 docs/architecture.md §11.1 的 198/197/1 计数一致 |
| 基线对照：`git worktree add --detach /tmp/p023-base a6cbaa3` + 在 base 上跑 `timeout 120 node --test maintenance-startup.test.js` | **EXIT=1**，tests 1 / pass 0 / fail 1，`MODULE_NOT_FOUND`——**开工前就红，非本卡引入**（验完 `git worktree remove --force`，`git worktree list` 无残留） |
| 变异 M1：`sed -i "s/'\[redacted\]'/'[leaked]'/g" log.js` | 探针 **EXIT=1**（PASS 69 / FAIL 1），恰红在 `A4 敏感键一律 [redacted]…:: authorization: actual="[leaked]" expected="[redacted]"`；`git checkout -- log.js` 后 **EXIT=0 复绿** |
| 变异 M2：`sed -i "s/'http\.request'/'http.requestMUTED'/g" server.js` | **EXIT=1**（PASS 68 / FAIL 2）：哨兵段 `S1 各请求的 http.request 都到齐…:: 等不到「http.request × 12」（5000ms）` 先红，`S1 超长路径在日志里被截断` 跟着红；还原后复绿 |
| 变异 M3：`sed -i "s/'triage\.enqueued'/…MUTED/g"` triage-monitor.js | **EXIT=1**（PASS 68 / FAIL 4，21.2s）：`S3 triage.enqueued 留痕（手动重排）` 等不到，已见事件里是 `triage.enqueuedMUTED`；还原后复绿 |
| 变异 M4：`sed -i "s/'maintenance\.result'/…MUTED/g"` server.js | **EXIT=1**（PASS 69 / FAIL 2，31.2s）：等不到 `maintenance.result`，已见事件里是 `maintenance.resultMUTED`；还原后复绿 |
| 变异后的收尾核对 | `git diff --stat` → 空；最终一次探针 **EXIT=0，PASS 70 / FAIL 0（1238ms）** |
| 还原核对 | `git diff --stat` → 空（变异全部还原）；`git status --short` → 只有未跟踪 `.pi-child-claim.json`（本席证据本轮已提交，见头部） |

## 5. Findings（全部 doc-side、minor，不挡 A1-A5）

### F1（minor，doc-side）启动文案的旧说法还留在 http-api 页

- 出处：`docs/modules/http-api.md:54`。
- 文档说：进程入口「启动监听，并打印 `HIDS API: http://<host>:<port>`」。
- 实测：S1 真进程 stdout 里 `HIDS API:` **零命中**，只有 `{"event":"server.started",…}` 一行 JSON（`docs/architecture.md` §11.2 已改，这一页没跟）。
- 复现：`timeout 200 node evidence/test/P003-T023/probe.mjs`，看 `S1 旧启动文案「HIDS API:」不再输出` 一条。
- 建议：把 `http-api.md:54` 改成「打印一行 `server.started` JSON（形状见 architecture.md §3.6）」。

### F2（minor，doc-side）「循环引用落 log.serialize_failed」与实测不符

- 出处：`docs/architecture.md:99`。
- 文档说：「字段取值抛错（getter 抛、**循环引用**）或写入器抛错…前者落一条 `log.serialize_failed`」。
- 实测：getter 抛错 → 落 `log.serialize_failed`（对）；**循环引用不落**，而是正常落一条、环处写 `"[depth]"`（4 层封顶截断），不抛业务异常。行为本身更安全（日志不丢），但文档承诺的这条事件没有发生。
- 复现：`timeout 200 node evidence/test/P003-T023/probe.mjs`，看 `S5 循环引用实测…` 与 `S5 循环引用 / getter 抛错…` 两条。
- 建议：文档改成「getter 抛错落 `log.serialize_failed`；循环引用按 4 层封顶写成 `[depth]`，照常落原事件」。
- 另：文档 §3.6 通篇没提「超长字符串截断 1000 字」，实测 5000 字被截到 1001（S5 断言过）。建议同一句补上截断口径，否则读者不知道长字段会被剪。

### F3（minor，doc-side）`triage.enqueued` 的「何时写」写宽了

- 出处：`docs/architecture.md:116`（§3.6 事件表 `triage.enqueued` 行：「进入研判队列」）。
- 文档说：进入研判队列就写，`source` 取 `manual` / `retry` / `poll`。
- 实测：**syslog 收包直达执行不发这条**——S3 里一条合法 UDP 报文的日志顺序是 `syslog.received → cloudwalker.call_failed → triage.done`，全程无 `triage.enqueued`；只有手动入队（source=`manual`）与重排（`retry`）才发。source 枚举本来不含 syslog，说明实现口径如此，但「何时写」这一栏会让排查的人以为收包路径漏记。
- 复现：同一条探针命令，看 `S3 记录：syslog 收包直达执行时不见 triage.enqueued`。
- 建议：该行补一句「syslog 路径由 `syslog.received` 记进入队列，本事件只覆盖手动/重试/轮询」。

### F4（minor，doc-side）交卷报告里的行号没跟 recon 同步

- 出处：`coding-reports/P003-T023.md:28`。
- 文档说：研判收尾在 `triage-monitor.js:524/528`。
- 实测：`grep -n "'triage.done'\|'triage.failed'" triage-monitor.js` → `526` / `530`；本轮已改对的 recon 写的就是 `526-527 / :530`。同一张卡两份纸自相矛盾。
- 复现：`grep -n "'triage.done'" triage-monitor.js`。
- 建议：报告该行改成 `526/530`（recon 为准）。

### F5（minor，doc-side）状态落盘失败在同步入队路径上回 502，文档没写这个 5xx

- 出处：`docs/architecture.md:118`（事件表 `triage.persist_failed`「状态落盘失败」）+ `docs/modules/http-api.md:92`（`POST /api/agent/triage/{alertId}` 只写「202 / 无研判队列回 503」）。
- 文档说：状态落盘失败落 `triage.persist_failed`；该路由只会 202 或 503。
- 实测：状态目录不可写（临时副本里 `.data` 置 0555）时 `POST /api/agent/triage/honeypot:<随机>` → **502** `{error:"EACCES: permission denied, open '…/triage-monitor.json.<uuid>.tmp'"}`，日志只有 `triage.enqueued(source=manual)` + `http.failed(status=502)`，**没有** `triage.persist_failed`。回 502 本身比假装 202 好，但两条文档都没写这条路径。
- 复现：`timeout 200 node evidence/test/P003-T023/probe.mjs`，看 `S7 状态目录不可写时手动入队不得回 2xx（实测 502 {error}…）` 与 `S7 该失败另有 http.failed…`。
- 建议：`http-api.md:92` 补一行「状态落盘失败回 502 `{error}`」；`architecture.md:118` 把 `triage.persist_failed` 的「何时写」限定为后台 `drain()` / 进度回调两处（同步入队路径的失败由 `http.failed` 记）。

### F6（minor，doc-side）`HIDS_SYSLOG_PORT` 非法值时绑到随机端口，文档没写

- 出处：`docs/architecture.md:413`（环境变量表 `HIDS_SYSLOG_PORT`，默认 `15514`）。
- 文档说：默认 `127.0.0.1:15514`。
- 实测：`HIDS_SYSLOG_PORT=99999` / `abc` / `65536` 三值都能起进程、都不回落到文档默认 `15514`——`99999` 稳定绑到 `udp://127.0.0.1:34463`（恰为 99999−65536，按 16 位截断；两次复跑同值），`abc` 与 `65536` 绑到系统分配的随机端口（两轮分别 41048/42917 与 57432/55483）。部署端把端口写错一位，进程照常起来、照常打 `syslog.listening`，但听的不是配置里那个端口。
- 复现：见 §7 第 4 条（三个值各起一次，读 `syslog.listening` 的 `bind`）。
- 建议：文档写明非法值的行为；若预期是「回落默认」，补一句「非法值按 15514 处理」并加对应实现约束——**这条与日志无关，非本卡引入**，只作记录。

**记录（非 finding）**：`log('x', {}, 'debug')` 会原样输出 `level:"debug"`——文档只说 `level` 取 `info|warn|error`，没有校验承诺，属调用方契约，本轮不记。

## 6. 残余风险

1. **两条事件至今没有任何断言**（上一版「只在写者单测里有断言」是错的，已作废）：
   - `syslog.receiver_error`：需要 UDP socket 的 `error` 事件，黑盒只能从进程外发包，造不出。
   - `triage.persist_failed`：只剩后台 `drain()` / 进度回调两处，要把研判跑到半程才落盘失败；同步入队路径的落盘失败走 502 + `http.failed`（F5），不落这条。
   - 零断言的证据（本轮亲跑）：`git grep -n "server.start_failed\|syslog.handler_failed\|syslog.receiver_error\|syslog.accept_failed\|triage.persist_failed\|triage.poll_failed" -- '*.test.js'` → **EXIT=1 零命中**；探针里现在有前四条里能黑盒造的四条（`server.start_failed` / `syslog.handler_failed` / `syslog.accept_failed` / `triage.poll_failed`），这两条仍然没有。
2. **写者单测名与断言不符（记录，不是本席可改的文件）**：`evidence/test/P003-T023/logging.test.js:273` 名为「syslog 绑定失败与接收器错误也在日志里」，正文 `:281`/`:283` 只断言 `syslog.bind_failed`，没有「接收器错误」的断言——上一版报告把它当成了 `receiver_error` / `handler_failed` 的断言来源，这正是本次退回的起因。`handler_failed` / `accept_failed` 本轮由探针 S7 独立覆盖。
3. **`cloudwalker.call_failed` 的 op=`tools`/`mcp_tools`/`list_events`**：`/api/agent/tools` 在牧云不可达时实测回 **200 工具清单**（工具清单是本地定义，不打网络），op=`tools` 的失败分支只能靠替身工具箱造；`list_events` 需匹配路径走到该分支。黑盒未触发。
4. **`maintenance.result` 只验到失败态**（rule/wiki 至少一侧 failed）；两侧都 `updated` 的成功态需要模型与知识库都到位，本轮没造。
5. **状态面持久化的副作用**：`.data/triage-monitor.json` 跨进程留存去重表与记录，探针已用一次性随机指纹/一次性告警 ID 隔离；仓库 `.data/` 被 `.gitignore` 忽略，未污染 git 面。
6. **日志本身不落盘**：本轮只验 stdout（文档就只承诺 stdout）；轮转/采集不在卡内。

## 7. 怎么复跑

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T023
timeout 200 node evidence/test/P003-T023/probe.mjs          # 本席黑盒探针，期望 PASS 70 / FAIL 0，EXIT=0（约 1.2s）
timeout 120 node --test evidence/test/P003-T023/logging.test.js  # 写者单测，期望 15/15，EXIT=0
timeout 300 node --test *.test.js                            # 全套，期望 198/197/1，EXIT=1（唯一红是既有基线）
git grep -n "server.start_failed\|syslog.handler_failed\|syslog.receiver_error\|syslog.accept_failed\|triage.persist_failed\|triage.poll_failed" -- '*.test.js'  # 期望 EXIT=1 零命中（§6 第 1 条的证据）
```

F6 的复现（三个非法端口各起一次，读 `syslog.listening` 的 `bind`）：

```bash
for p in 99999 abc 65536; do
  HIDS_PORT=0 HIDS_TRIAGE_INPUT_MODE=syslog HIDS_SYSLOG_PORT=$p CLOUDWALKER_URL=http://127.0.0.1:1 \
  CLOUDWALKER_API_TOKEN=probe-token LLM_BASE_URL=http://127.0.0.1:1 LLM_API_KEY=probe-key LLM_MODEL=m \
  timeout 2 node server.js | grep syslog.listening
done
```
