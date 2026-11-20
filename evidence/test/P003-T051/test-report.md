# P003-T051 测试报告：记录侧原文泄漏清零（tester 侧验收）

工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T051`（HEAD `a9c8f1b`，起活 `58e630c`）
测试者：何东阳。口径只认文档：`docs/modules/investigation-agent.md` §3.2（记录侧不写错误原文 / 三个固定文案 / 四个去处表）/ §3.3（复核、修订）/ §3.11（`turns.note`）/ §5.6（断言与可复跑命令），
`docs/modules/http-api.md` §3.3 / §3.10（案卷与回放的读面、ID 校验）。
没读实现正文；符号定位只用 `grep -n -o "符号名(…)"`，代码只改在变异里、当场 `git checkout` 还原。

## 1. 本轮我写了什么

`evidence/test/P003-T051/tester-record-redaction-acceptance.test.js`（10 条，集成/HTTP 级）。
不重复写者自测的断言——写者管模块内文案，我管**落盘字节 + HTTP 读面 + 边界**：

- 每条 `A1` 用例都走真 `InvestigationStore.save()` 落盘，再把 `investigations/` 目录下每份文件**按原始字节读回**断言（不是只看内存里的 result）；两条还经真 HTTP 读 `/api/agent/investigations/{alertId}` 与 `/replay`。
- 覆盖：复核轮解不出 JSON（concerns / trace / turns.note 三处同一句，落盘 + 案卷 + 回放三面干净）、修订失败（summary / missing_evidence / trace）、`validation_error`、六轮解析失败（analysis == missing_evidence[0]、6 条 `parse_error`、§3.2「末次回包 K 字」摘要契约**没被越界删**）。
- A2：致命路径 `run()` 拒绝时 `error.message` / `cause` 链 / `traceModelCall` 三标记照旧；抛错路径不落盘。
- 边界（我自己加的，写者用例没有）：白名单外的错误类名（`EveInjectedError` 不许进记录）、20k 字超长原文（只留字符量 + 记录体积有界）、错误原文伪装成脱敏文案（闸自己复算长度，不抄对方的 `999 字`）、超时口径（`调用超时`）、非 Error 的 throw（不崩、按字符量记账）。
- `evidence/test/P003-T051/probe-o5-required-evidence.mjs`：不是用例（run-all 不收集），只做「必查项查询失败」这条路的文档边界取证，见 §5 发现 1。

## 2. 我亲手跑的（命令原文 + 退出码 + 摘要）

```
$ node --test --test-force-exit evidence/test/P003-T051/tester-record-redaction-acceptance.test.js
ℹ tests 10  pass 10  fail 0  duration_ms 171        # exit 0，三连跑均 10/10

$ node --test --test-force-exit evidence/test/P003-T046/record-redaction.test.js
ℹ tests 7  pass 7  fail 0                           # exit 0（门禁基线，A1 前 5 条 + A2 第 7 条）

$ node --test --test-force-exit evidence/test/P003-T046/record-redaction.test.js investigation-agent.test.js evidence/test/P003-T051/tester-record-redaction-acceptance.test.js
ℹ tests 50  pass 50  fail 0                         # exit 0（写者 7 + 既有 33 + 我 10）

$ npm test                                            # 2 连跑
ℹ tests 228  pass 228  fail 0  （run 1 / run 2 均绿，exit 0）

$ node --test --test-timeout=60000 --test-force-exit *.test.js evidence/test/*/*.test.js evidence/p003-t012-verify/*.test.js
ℹ tests 640  pass 634  fail 5                       # 5 条旧红，见 §4

$ node evidence/test/P003-T051/probe-o5-required-evidence.mjs
exit 0，输出见 §5
```

没有在本工作树里跑整套测试后留下脏改动：`git status --short` 只有 `?? evidence/test/P003-T051/`，`git diff --stat` 为空。

## 3. A3 变异自证（我抽的 2 个，不是转录）

变异前 `sha256sum investigation-agent.js` = `1237688b97c33697bc1b804e5ec84dca3233e6ad34941ead41ebeadbf1c92865`；两次变异后都 `git checkout -- investigation-agent.js`，复原后再核 sha256 **逐字节同值**、`node --check` 通过。

**V1（闸本身透明化）**：把 `recordFailure` 函数体换成 `return String(error?.message ?? error);`（符号定位与改写都用脚本按 `function recordFailure(` 起止，不读上下文）：

```
$ node --check investigation-agent.js           # SYNTAX_OK
$ node --test --test-force-exit evidence/test/P003-T051/tester-record-redaction-acceptance.test.js
ℹ tests 10  pass 1  fail 9      # 只有「A2 致命路径」仍绿（A2 不走记录闸），其余 9 条恰红
$ node --test --test-force-exit evidence/test/P003-T046/record-redaction.test.js
ℹ tests 7  pass 1  fail 6       # 同样只有 A2 绿
```

恰红样本（20k 那条）：`actual: '独立复核未完成：SECRET_BODY_MARKER AAAA…（10027 more characters）'`、`expected: '独立复核未完成：上游调用失败，原文 20019 字未落盘'` —— 原文真的会落盘，守卫不是永真。

**V2（单点：S8 `validation_error`，`investigation-agent.js:1046` 的 `recordFailure(cause)` 换 `cause.message`）**：

```
$ node --test --test-force-exit evidence/test/P003-T046/record-redaction.test.js investigation-agent.test.js
ℹ tests 40  pass 39  fail 1     # 恰红「A1 引用校验退回失败：trace[validation_error]…」（与写者 M4 同点）
$ node --test --test-force-exit evidence/test/P003-T051/tester-record-redaction-acceptance.test.js
ℹ tests 10  pass 9  fail 1      # 恰红同一条；我另 9 条不动
```

样本外说明：写者报的 M1-M8、审查抽的 M2/M8 我**没有复跑**（不转录别人的输出）；我这两个变异是独立构造的——一个打闸，一个打单点，都恰红且范围吻合。

## 4. 全 evidence 面 5 条旧红：不是本卡引进（在起活 commit 上复跑验的）

```
$ node --test --test-timeout=60000 --test-force-exit *.test.js evidence/test/*/*.test.js evidence/p003-t012-verify/*.test.js
✖ 结果形状：run() 必备字段与枚举值符合文档
✖ A4 同主机同事件秒同告警只研判一次，重复投递只累加 repeat_count
✖ A1 七条运行态路径都在数据根下，子结构与 P003-T019 时的仓内 .data/ 逐字一致
✖ A1 七条具名路径的结构与文档表一致，且默认根不在仓库内
✖ A1 runtimePaths 只剩七个具名路径，baseline/intel 两键不在其中
ℹ tests 640  pass 634  fail 5

# 起活 commit 上的同 5 个文件（临时 worktree，跑完删除）
$ git worktree add --detach /tmp/t051-base 58e630c && cd /tmp/t051-base && \
  node --test --test-timeout=60000 --test-force-exit evidence/p003-t012-verify/acceptance.test.js \
  evidence/test/P003-T013/acceptance.test.js evidence/test/P003-T019/data-dir.test.js \
  evidence/test/P003-T034/acceptance.tester.test.js evidence/test/P003-T043/context.test.js
ℹ tests 55  pass 49  fail 5      # 同 5 条同断言红；与本卡无关
$ git worktree remove /tmp/t051-base --force
```

## 5. findings

**1）minor（doc-side，`docs/modules/investigation-agent.md:292`）：「唯一允许写失败原因的出口」这句承诺过宽，实测还有一条路往同两个字段写原文。**

- 文档说：`recordFailure(error)` 是研判记录里**唯一**允许写失败原因的出口；四处记录去处（`review.concerns` / `missing_evidence` / `trace` / `verdict.analysis`）同一道闸、原文不落盘。
- 实测：必查项（`required-evidence.js:151`，recon §4 的 O5）查询抛错时，工具报错原文**原样**进 `trace[evidence_check].reason` 与 `verdict.missing_evidence[0]`——正是文档说已收进闸的两个字段。
- 复现：`node evidence/test/P003-T051/probe-o5-required-evidence.mjs` → `{"trace_reason":"SECRET_BODY_MARKER 必查项上游炸了","missing_evidence_first":"同主机关联事件：查询失败；SECRET_BODY_MARKER 必查项上游炸了","record_clean":false}`
- 为什么不判本卡违约：群主已拍板本卡 scope 只修 `investigation-agent.js` 全部同族点、O1-O12 只盘点（recon §4），O5 属收口卡范围；写者「未决 #2」也自报了这条边界。
- 但是文档在 scope 内且是给测试照着写的契约：这句不改，下一个测试者会照文档写「整份记录无原文」的断言然后撞上这条。建议在 §3.2 这段加一句边界（例如「本句指本模块的出口；必查项 `reason`（O5）与队列 `record.detail`（O1）是另一条闸，见 recon §4」），O5 收口卡落地后再删。**不挡本卡推进**。

其余 A1/A2/A3/A4 判据全部满足，没有 B 类（本模块行为与文档不符）发现。另：审查提的 `syslog-pipeline.test.js:96` 旧抖动我 3 轮 `npm test` 没复现（3/3 绿），不立 finding，只记残余风险。

## 6. 验收逐条

| id | 判定 | 我亲手跑出来的证据 |
| --- | --- | --- |
| A1 四处记录侧经同一脱敏闸、原文不落盘 | pass（in-scope 完整；scope 外的 O5 见发现 1） | 写者契约样例 7/7 绿；我 10 条里 8 条 A1：落盘文件原始字节、HTTP 案卷、回放三面都 `doesNotMatch(/SECRET_BODY_MARKER\|SECRET_BOD\|Unexpected token\|is not valid JSON/)`；复核 / 修订 / validation / 六轮解析四处固定文案逐字对上；边界 4 条（类名白名单、20k、伪装文案、超时）；两个变异恰红证明守卫不宽 |
| A2 原文仍可达调用方、三标记不动 | pass | 我第 5 条：`run()` 拒绝时 `error.message` 含原文、`error.cause.message === raw`、抛错路径目录无文件；`traceModelCall` 的 `model_decode` / `model_reply` / `model_call` 三标记照旧，`message` 里仍有正文片段 |
| A3 变异自证 | pass | 见 §3：闸透明化 → 9 红 1 绿；单点 S8 → 恰红 1 条（两个文件各自只红对应那条）；复原后 sha256 与变异前逐字节一致，50 条全绿 |
| A4 全仓盘点（in-scope 11 处全修、O1-O12 只盘点） | pass | 符号定位：`recordFailure(` 实际调用点 11 处（115/120/676/810/824/867/949/950/971/1046/1133）+ `reasonForRecord` 4 处（1141/1142/1150/1155）→ 汇总到 115；recon §4 的 O1/O2/O3/O4/O5/O6/O7/O8/O10/O11/O12 我逐条 `git grep` 符号核过在库（如 `triage-monitor.js:1067` `record.detail`、`knowledge-workbench.js:136` `last_error`、`required-evidence.js:151`、`trace-board.js:397/398/423/559/615`、`wiki-replay.js:76`、`server.js:309/352` `scrubCredentials`）；O5 的实测泄漏见发现 1 |

## 7. 残余风险（不阻塞）

1. O1-O12 未修（群主已批另派收口卡）：`triage-monitor.js:1067-1068` 的 `record.detail` / `failure.reason` 仍是最大一口（本卡跑不到它，属队列侧）。
2. O5：必查项查询失败时原文进 `trace[evidence_check]` 与 `missing_evidence[0]`（发现 1）；收口卡落地前，「整份记录无原文」不成立于该路。
3. 模型回包摘要（`末次回包 K 字：「…」`、`reply_excerpt`）照旧落盘——P003-T022 既定契约，本卡没越界删（我第 4 条反向钉住了它还在）。
4. 超时口径靠错误文案里的 `timeout/超时/aborted` 判别：`name: TimeoutError` 但 message 不含 timeout 的错会落「上游调用失败（TimeoutError）」。文档没写判别规则，只给三个文案样例；真实 model-client 超时是哪种形状我没查清（不读实现），未立 finding。
5. `syslog-pipeline.test.js:96` 旧抖动 3/3 轮未复现；以后 `npm test` 偶红先看是不是它。
6. `reasonForRecord` 只认 `syslog-case.js:54/:83` 两条徽标前缀（写者未决 #4 自报），以后新增「徽标：<raw>」形状要同步扩。

## 8. 复跑

```
node --test --test-force-exit evidence/test/P003-T051/tester-record-redaction-acceptance.test.js
node --test --test-force-exit evidence/test/P003-T046/record-redaction.test.js
node --test --test-force-exit evidence/test/P003-T046/record-redaction.test.js investigation-agent.test.js evidence/test/P003-T051/tester-record-redaction-acceptance.test.js
npm test
node evidence/test/P003-T051/probe-o5-required-evidence.mjs
```
