# P003-T018 · 后端验收（黑盒）测试报告

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T018`
- 分支 `task/hids-ai-console-P003-T018`，HEAD `02d396c`（`bfd6525` 之上一个「交卷报告」commit，非漂移）
- 契约来源：`openapi.yaml`（`retryTriage`、`TriageCase`、`FalsePositiveFeedback`）、`docs/modules/http-api.md` §3.1/§3.3/§3.4/§7、
  `docs/modules/triage-pipeline.md` §5.4/§7.4
- 判据：只按文档造请求、按文档断言。**没读 `triage-monitor.js` 的内容**，只做符号定位（`grep -n humanFalsePositive` → `:13`、`:221`、`:454`）。
  没改产品代码；`triage-monitor.js` 曾在变异验红时临时换成改前版本，已按 `sha256` 核回（`9b9c535b2d2840a7…` 一致，`git diff` 空）。

## 一、门禁（全部本终端亲跑，不转录任何人的输出）

| 命令 | 结果 |
| --- | --- |
| `timeout 120 node --test triage-monitor.test.js` | `tests 15 / pass 15 / fail 0`，`exit 0`（写者 4 条新增用例 `:392 / :437 / :458 / :483` 全绿） |
| `timeout 300 node --test --test-reporter=tap agent-api.test.js integration.test.js syslog-pipeline.test.js triage-monitor.test.js triage-output.test.js triage-rules.test.js` | `# tests 74 / pass 74 / fail 0`，`exit 0`；**连跑 3 次全部 74/74**（`/tmp/K1..K3.log`） |
| `timeout 120 node --test evidence/p003-t018-verify/acceptance.test.js` | `tests 8 / pass 8 / fail 0`，`exit 0`；连跑 4 次全绿 |
| `timeout 400 node --test --test-timeout=25000 --test-reporter=tap`（全套） | 6 次里 4 次跑完：`# tests 392 / pass 380 / fail 11 / todo 1`，`exit 1`；红名单与写者声明的基线逐条相同（`web/test/*` 10 条缺 `jsdom`、`maintenance` 符号链接 1 条、`who 101 字` TODO 1 条），**本卡零回归** |
| `git checkout -- evidence/test/P003-T007/shots/` | 全套会重写 `shots/*.png`，已还原（`git status` 只剩未跟踪的本报告目录） |
| `git diff bfd6525^ bfd6525 -- server.js web/ \| wc -l` → `0`；`git diff 6d554ec 02d396c -- server.js web/ \| wc -l` → `0` | A3：误报入口 `server.js` 与本卡两个 commit 零 diff |
| `node evidence/p003-t018-verify/probe-retry-syslog-status.mjs` | `exit 1`，见 F1 |

## 二、我自己写的验收用例（`evidence/p003-t018-verify/acceptance.test.js`，8 条）

全程真 HTTP（`createServer` + `listen(0)`）+ 真 `TriageMonitor`/`InvestigationStore`，研判器用脚本化 fake（外部模型不可用）。
没碰实现文件，断言全部挂在文档句子与 `openapi` schema 上。

| 覆盖 | 断言要点 | 结果 |
| --- | --- | --- |
| A1 真入口全链路（1） | `POST /api/agent/triage/honeypot%3A11` 202 → 首判 `uncertain`；`POST …/false-positive` 202（正文 `{alert_id, verdict:{verdict,verdict_label,source}, feedback{reason,who,recorded_at}}`）；再 `POST …/triage/honeypot%3A11` 202 → `attempts=2`；重跑后 `verdict=false_positive`、`verdict_label=误报`、`decision_source=human`、`summary='首判存疑'`、`feedback` 三键原样、`detail` 跟保留的 summary；**同时** `report`/`missing_evidence`/`next_actions`/`evidence[0].evidence_id`/`saved_at` 都是新的（不是整块跳过） | 绿 |
| A2 未标误报（1） | 首判 `uncertain` → 重试 → `threat`/`真实威胁`/`decision_source=ai`/`detail` 跟着新 summary/`feedback` 不存在 | 绿 |
| A1 口径钉子（1） | AI 自判 `false_positive`（`decision_source=ai`、无 `feedback`）→ 重试 → 被这次研判覆盖成 `threat` | 绿 |
| 持久化（1） | 误报登记 + 重跑后新建 `TriageMonitor` 重载同一 `queue.json`：`verdict/verdict_label/decision_source/feedback/summary/report` 全在（重排五项确实随 `persist()` 落盘） | 绿 |
| 错误码（1） | 重试：`bad-id` → 400「告警 ID 无效」；`%E0%A4%A` → 400「告警 ID 编码无效」；未知 ID → **202 入队**（`retryTriage` summary 是「手动入队或重试」）；`syslog:` 无原始报文 → 502（F1）。误报登记：缺 `reason`/9 字/4001 字/`who` 1 字/正文不是对象 → 400；无此案件 → 404「找不到这条研判案件」；未跑完 → 409「研判还没结束，不能登记误报」，且 409 后记录上不留 `feedback`。每条正文都断言 `Object.keys(body)===['error']`（`openapi Error` 形状） | 绿 |
| 边界（1） | `reason` 恰好 10 字、恰好 4000 字、`who` 恰好 100 字 → 202 且回读与提交一致 | 绿 |
| 重试语义（1） | 研判卡在 gate 上时再 POST → 202 且 `investigator.run` 只被调 1 次（openapi「正在运行的任务不会重复启动」） | 绿 |
| 无研判队列（1） | 误报入口与重试入口都回 503 `{error:'自动研判尚未配置'}`（`http-api.md` §3.1 路由表 + §3.4 表） | 绿 |

## 三、变异验红（亲手复现，不引用别人）

1. `cp triage-monitor.js /tmp/t18-final.js`（sha256 `9b9c535b…`）。
2. `git show bfd6525^:triage-monitor.js > triage-monitor.js`（换回改前实现）。
3. 恰红：
   - 写者用例 `node --test triage-monitor.test.js` → `exit 1`，`pass 13 / fail 2`，红的正好是两条 A1（`:392`、`:437`），钉子（`:458`）与 A2（`:483`）**照旧绿**。
   - 我的用例 `node --test evidence/p003-t018-verify/acceptance.test.js` → `exit 1`，`pass 6 / fail 2`，红的正好是两条依赖守卫的用例（A1 真入口、持久化），A2/钉子/错误码/边界/重试语义 6 条全绿。
4. 还原：`cp` 回备份，`sha256sum` 与备份一致，`git diff -- triage-monitor.js` 空；再跑 → 写者 15/15、我的 8/8 全绿。

结论：A1 的守卫断言有判别力，不是永真断言；A2 与钉子用例在旧实现上绿，说明它们测的是另一条路，不是跟着 A1 一起动。

## 四、发现

### F1（minor，doc/spec 对不上实现；既有问题，与本卡无关，卡外）

- 文档说：`openapi.yaml` `retryTriage` 的响应里列了 `'404': NotFound`；`docs/modules/triage-pipeline.md` §5.4「`syslog:` 前缀但没有原始报文 → 抛 404『该 syslog 告警的原始报文不存在，无法重试』」。
- 实测：同一条路径回 **502**，正文文案与文档逐字一致。这与 `docs/modules/http-api.md:353`「消息里含『请求正文』四个字的回 400，其余回 502」自洽——即**文档内部自相矛盾**，实测走的是 502 那条。
- 复现：`node evidence/p003-t018-verify/probe-retry-syslog-status.mjs` → `exit 1`
  ```
  POST /api/agent/triage/{syslog-id}（无原始报文） → 502 {"error":"该 syslog 告警的原始报文不存在，无法重试"}
  文档说：404（openapi retryTriage / triage-pipeline §5.4）；实测：502
  ```
- 影响：调用方按 `openapi` 只处理 400/404，会把「记录缺原始报文」误判成上游故障（502 = 可重试），重试风暴。不影响 A1/A2/A3。
- 改法（不代改）：要么 `retryTriage` 的 `404` 删掉/补上 502 并同步 §5.4 的「抛 404」，要么实现把该错误映射成 404。
- **卡外**：`server.js` 本卡禁改（A3），且 `git diff bfd6525^ bfd6525 -- server.js` 为 0 行，属既有行为，建议另立卡。

### F2（minor，doc/spec 对不上实现；既有问题，卡外；已有 TODO 承接，不新立）

- 文档说：`openapi.yaml` `reportFalsePositive` 的 `who` 是 `type: string, maxLength: 100`。
- 实测：`who: '值'.repeat(101)` → **202**（存成 100 字，截断），`who: 123`（数字）→ 202（转成 `"123"`），都不回 400。
- 复现：全套里既有用例已钉住这条：`not ok - 边界（待定口径）who 101 字：按 openapi maxLength=100 应为 400 # TODO openapi maxLength 100 vs http-api 未写上限；实测 202 截断，待群主定口径`。
- 影响：只影响 P003-T013 误报入口的入参校验口径，输出侧仍满足 `FalsePositiveFeedback`（`who` 是 string、≤100 字），不阻塞本卡。
- 改法：等群主定口径（截断收下 or 400）；定了再动 `server.js`。**卡外**。

## 五、观察（不算本卡，供收口参考）

- **O1 全套偶发卡死**：`node --test` 全套在本机 6 次里 2 次卡在 ~115 条（无新红，`Interrupted while running` 列一串小文件）。把本报告的 `acceptance.test.js` 移出仓库后跑同样卡过 1 次 → **与本卡、与本报告的用例都无关**，是这台机器的环境抖动。带 `--test-timeout=25000` 时 4 次跑完（392/380/11/1，每次约 30s）。
- **O2 `web/test/*` 10 条红**：`Cannot find package 'jsdom'`——本工作树没装依赖（无 `node_modules`），属环境，不是回归。
- **O3 `maintenance CLI … symlink` 1 条红**：`Cannot find module '/tmp/hids-maintenance-startup-*/current/backend/maintenance-server.js'`——既有环境基线（P003-T002 报告里同一条）。

## 六、残余风险

- 写者「未决 1/2/3」承接给后续卡，本次实测确认其现状与描述一致：误报记录上的 `summary` 仍是上一轮 AI 那句（`openapi` 只承诺「原样保留」，没承诺它是人工写的）；`detail` 重跑后从「人工登记误报（who）：reason」变成保留的 summary（`triage-pipeline.md` §7.4 已同步，实测与文档一致）；`decision_source` 缺字段的历史记录不受保护（文档没承诺兜底）。
- 跑全套会重写 `evidence/test/P003-T007/shots/*.png`（既有行为）；我已还原，后续任何人跑全套都要 `git checkout -- evidence/test/P003-T007/shots/`。

## 七、树状态

```
$ git status --short
?? .pi-child-claim.json          # 运行时claim
?? evidence/p003-t018-verify/    # 本报告 + 我的用例 + F1 探针
```
`triage-monitor.js`、`triage-monitor.test.js`、`docs/**`、`openapi.yaml` 与 HEAD 一致（`git diff` 空），`shots/*.png` 已还原。
