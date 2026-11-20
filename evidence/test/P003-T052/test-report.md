# P003-T052 测试报告：记录侧泄漏收口（tester 侧复核）

工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T052`（HEAD `94b5a1d`，起活基线 `bea34bd`）

> **第 1 轮复核快照。** F1–F6 的修复与复跑见 `coding-reports/P003-T052.md` §七；文中引文行号已按修复后树重取，
> 与本轮判定相关的行为未变（修复只动契约文档、测试卫生与两条断言的锁粒度）。
测试者：何东阳。判据只认文档：`docs/modules/triage-pipeline.md` §失败处理 / §5.3 / §6.3、`docs/modules/investigation-agent.md` §3.2（A1 点名的 `:292`）、
`docs/modules/knowledge-base.md` §5、`docs/modules/experience-draft.md` §3/§8、`docs/modules/trace-board.md` §5.3、`openapi.yaml`。
没读实现正文；符号定位只用于变异（`git checkout HEAD~2 -- <file>` 整文件回退），每次当场 `git checkout HEAD -- <file>` 还原。

## 1. 我写了什么

`evidence/test/P003-T052/tester-redaction-boundary.test.js`（5 条，公开落盘面级）。只补写者用例没盖住的口与边界，不重复他的断言：

| 用例 | 覆盖的文档点 | 写者用例的状态 |
| --- | --- | --- |
| A2 轮询失败 `lastError` | triage-pipeline §5 `summary()` / §6 复核补漏（`triage-monitor.js:772-775`，A2 点名） | **无用例**（写者只盖 syslog 解析那一支 `O3`） |
| O6 详情读取失败 | §5.3 失败表「牧云事件详情读取失败」那一行 | **无用例**（`O6` 只盖列表查询） |
| O8 回包不是合法 JSON | knowledge-base §5「模型回包不是合法 JSON（SyntaxError），原文 N 字未落盘」 | **无用例**（`O8` 只盖调用抛错 + 摘录对不上两支） |
| O1 边界：抛字符串（非 Error） | §失败处理「`detail` 记闸后文案」不区分 Error / 非 Error | 无（写者只测 Error） |
| O4 边界：300 字原文 / 成功轮清空 | experience-draft §3「不再截原文 240 字」、§8 `R-EXPD-10` | 无（写者测的是 40 字级的 Error） |

顺带核对写者 11 条的假件性质：`grep -nE "fetch\(|http|net\.|request\(|localhost|127\.0\.0\.1"` 在 `record-redaction.test.js` 上 **exit 1（零命中）**；
16 条（写者 11 + 我 5）单条最长 **9.8ms**，整目录 0.15s——全内存替你件，不碰网络与真实时钟（`waitFor` 只轮询内存状态，200×5ms 上限）。
（修复轮写者给他自己的文件补了 1 条 SyntaxError 支，第三轮补 1 条 ruleEngine error 支、第四轮改成变体数据驱动 + 模板例外，目录现为 19 条；单条仍 ≤10ms。）

## 2. 我亲手跑的（命令原文 + 退出码 + 摘要）

```
$ npm test
ℹ tests 228  pass 228  fail 0  duration_ms 854        # exit 0

$ node --test evidence/test/P003-T052/
ℹ tests 16  pass 16  fail 0  duration_ms 117          # exit 0（写者 11 + 我 5；写者单跑 11/0）

$ node --test evidence/test/P003-T046/ evidence/test/P003-T051/
ℹ tests 32  pass 32  fail 0                           # exit 0（A4 上游契约不破）

$ node --test --test-timeout=60000 --test-force-exit evidence/test/*/*.test.js
ℹ tests 407  pass 403  fail 3                         # 3 红：P003-T019 1 / P003-T034 1 / P003-T043 1（runtimePaths 七条路径）
# 口径：我进场时（加我 5 条前）；当前树含 T052 用例 19 条 → 415/411/3（第三轮打回订正：前面写的 412/408/3 是错的；第四轮又补 2 条变体用例），红的是同样 3 条（修复轮复跑同数）

# 基线对照（改动前 bea34bd 的干净导出树，不复活原工作树）
$ git archive bea34bd | tar -x -C /tmp/t052-base
$ cd /tmp/t052-base && node --test evidence/test/P003-T019/*.test.js evidence/test/P003-T034/*.test.js evidence/test/P003-T043/*.test.js
ℹ tests 43  pass 40  fail 3                           # 同样这 3 条红 → 预存，与本卡无关

$ grep -niE 'http|router|auth|token' triage-monitor.js syslog-input.js syslog-case.js
triage-monitor.js:566:      // 绑定失败不能让队列静默收不到消息：记进 summary()，队列照常服务（HTTP 还要活）。   # exit 0，与 triage-pipeline §1 可复跑块逐字一致
```

没有在树里留下改动：跑完 `git status --porcelain` 只有 `?? evidence/test/P003-T052/tester-redaction-boundary.test.js`。

## 3. 变异复现（我自己的，不转录）

### 3.1 写者 8 条用例是否“恰红”（整文件回退，不复刻他逐点的 sed）

| 变异（`git checkout HEAD~2 -- <file>`） | `node --test evidence/test/P003-T052/` | 结论 |
| --- | --- | --- |
| `triage-monitor.js` | 11 条里 **O1/O2/O3 恰 3 红**，其余 8 绿 | 三个落点各有一条守卫，不互相顶替 |
| `knowledge-workbench.js` | **O4 恰 1 红**，10 绿 | 是 |
| `required-evidence.js` | **O5 恰 1 红**，10 绿 | 是 |
| `syslog-case.js` | **O6 恰 1 红**，10 绿 | 是 |
| `trace-board.js` | **O7 两条恰红**，9 绿 | 是（两口两条用例） |
| `wiki-replay.js` | **O8 恰 1 红**，10 绿 | 是 |

每次变异后 `git checkout HEAD -- <file>`；6 轮回退后 `git status --porcelain` 只剩我那条新用例未跟踪。

### 3.2 旧用例改断言后还锁不锁得住（这条最要紧）

`triage-monitor.js` 整文件回退到改动前，跑 T023 + T030 + T036：

```
$ node --test evidence/test/P003-T023/logging.test.js evidence/test/P003-T030/triage-real-fetch.test.js evidence/test/P003-T036/queue-reliability.test.js
ℹ tests 38  pass 35  fail 3
✖ A2 研判入队 → 完成 / 失败都留痕…            （T023:232 精确文案）
✖ R3 目录校验：MCP 目录缺 get_webshell_event…  （T030:286 闸后文案）
✖ A1 连续失败到上限进死信…                    （T036:111/121 文案 + 分桶键）
$ git checkout HEAD -- triage-monitor.js && node --test evidence/test/P003-T023/ evidence/test/P003-T030/ evidence/test/P003-T036/
ℹ tests 53  pass 53  fail 0
```

改过的断言**不是永真**：闸一撤，各恰 1 条红，还原即全绿。

### 3.3 我新加的 5 条也变红

`triage-monitor.js` 回退 → 我的「轮询失败」「抛字符串」2 红；`syslog-case.js` → 详情读取 1 红；`wiki-replay.js` → 回包解析 1 红；`knowledge-workbench.js` → O4 边界 1 红。每条都在还原后复绿（`16/0`）。

## 4. 发现台账

### F1（major，doc-side）`openapi.yaml` 三处仍写「失败原因是错误原文 / 截 250/120 字」

- 文档出处：`openapi.yaml:2509`（`TriageFailure.reason`）、`openapi.yaml:2736`（队列记录 `detail`）、`openapi.yaml:2433`（`failure_reasons`）
- 文档说：「失败原因**原文**（截 250 字，与 detail 同源）」「失败时是**错误原因**（截 250 字）」「键是失败记录上的原因**原文**（截 120 字…）」
- 实测：`detail` / `failure.reason` / `failure_reasons` 的键全是我方固定文案 + 原文字符量，且不再截断。
  复现（两条，都只读公开落盘面）：
  ① `node --test --test-name-pattern='O4 边界' evidence/test/P003-T052/tester-redaction-boundary.test.js` → `last_error === "知识整理失败，原文 322 字未落盘"`（322 = SECRET 22 字 + 300，是原文全量，没有 240/250 截断）；
  ② `node --test --test-name-pattern='A1 连续失败到上限' evidence/test/P003-T036/queue-reliability.test.js` → `failure.reason === "上游调用失败，原文 6 字未落盘"`，`failure.code === 'ETIMEDOUT'`。
  两处都不是「原因原文」，也都不含 250/120 字截断——`openapi.yaml` 的三句描述与它们冲突。
- 严重度：major（契约文档，tester 照它写 schema 断言就会写错；本卡改了这几个字段的产出契约，5 份模块文档同步了，`openapi.yaml` 漏了）
- 建议：按新契约改这三处 description（去掉「原文」「截 250/120 字」，写明「固定文案 + 原文字符量，错误码仍在 `failure.code`」）；`openapi.yaml:2048` 的 `TriageStep.detail` 补一句「规则评估抛错时是闸后文案」。

### F2（minor）三个落点无用例守护（我已补，写者不必重复）

- 落点：`triage-monitor.js:772-775`（A2 复核补漏点）、`syslog-case.js:56-59`（详情读取失败）、`wiki-replay.js:78-82` 的解析失败支
- 实测行为**是对的**（我 3 条新用例全绿，且回退对应文件各恰 1 红），只是写者 11 条用例里没有守这三口的断言 → A3「8/8 恰红」的守卫面不含它们。
- 严重度：minor（行为无违约；守卫缺口已由 tester 用例补上）。
- 建议：不用再加；如果写者不认测试侧用例做守卫，就在自己文件里补同款三条。

### F3（minor，测试卫生）写者用例每跑一次在 `/tmp` 留 3 个目录

- 复现：`before=$(ls -d /tmp/hids-t052-knowledge-* | wc -l)；node --test evidence/test/P003-T052/record-redaction.test.js；after=…` → `delta=3`（我进场时已累积 76 个）
- 出处：`evidence/test/P003-T052/record-redaction.test.js:123-130`（`knowledgeTurn()` 里 `mkdtemp` 没有 `t.after` 清理；同文件 O1/O2/O3/O6/O7 都有清理）
- 严重度：minor（不影响断言；CI 上会把 tmp 撑满）
- 建议：`knowledgeTurn` 返回 `{record, reopened, directory}`，调用处 `t.after(() => rm(directory, {recursive:true,force:true}))`；顺带把 `:107` 那个固定名 `path.join(tmpdir(),'hids-t052-no-cases')` 换成 mkdtemp（现在是只读不写，但并发跑不安全）。

### F4（minor，doc-side）`trace-board.md` 那条 fixed 文案我复现不出

- 文档出处：`docs/modules/trace-board.md:344`（`trace-board.js:560-562`）
- 文档说：模型回包解析失败 → `模型返回的白板操作 JSON 不完整或格式错误（SyntaxError），原文 N 字未落盘`
- 实测：9 种回包（散文 / 未闭合 JSON / 空串 / 无 content / null / 数组 / 嵌套对象 / 带前缀文本 / 合法但未知 action）都只出两种，**没有一次带「（SyntaxError）」或「原文 N 字未落盘」**：
  - 解析不了 → `模型返回的白板操作 JSON 不完整或格式错误；响应长度 N`
  - 解析得了但不是动作 → `白板操作失败，原文 N 字未落盘；响应长度 N`
- 严重度：minor（不泄漏，两处都不带原文；但文档写的文案我实测拿不到。**没查清**是否还有第五支，建议写者核一下这句话的来源）
- 建议：把 `:344` 改成实测文案，或者写明哪一种回包才落那条。

### F5（nit）「字」按 UTF-16 码元算

- `'😀'.repeat(3)`（3 个字、6 个码元）→ `上游调用失败，原文 6 字未落盘`。文档统一写「字」。多字节/emoji 上游报文会把数报大。不泄漏，记一笔。

### F6（nit）T030 改后的断言没锁字符量

- `evidence/test/P003-T030/triage-real-fetch.test.js:286` 用 `/^上游调用失败，原文 \d+ 字未落盘$/`；T023:232、T036:111 都锁了精确数字。建议对齐（字符量本身也是契约）。

## 5. 验收对账

| 项 | 判 | 证据 |
| --- | --- | --- |
| A1 O1–O8 同一道闸、最重一口 `detail`/`failure.reason` 不再落原文 | **pass** | 6 文件回退各恰红（§3.1）；`queue.json` 字节里搜不到原文（我的 O1 边界用例 + 抛 200k 字符串仍 `raw.length < 20000`）；O5 双去处我在 `requiredEvidenceGaps` 侧复算了 `trace[evidence_check].reason` 与 `missing_evidence[0]` 同源；`investigation-agent.md:294` 措辞实测在文件里，且「本模块内部」的限定与 `record-redaction.js` 共享闸相符 |
| A2 复核补漏 `triage-monitor.js:772-775` | **pass（行为）/ 守卫缺口见 F2** | 我的「A2 轮询失败」用例：`summary().last_error = 上游调用失败，原文 N 字未落盘`，`triage.poll_failed` 日志行仍带原文；回退该文件恰 1 红 |
| A3 变异 8/8 恰红 | **pass** | §3.1 我按整文件回退复现 6/6 文件、O1–O8 逐点各恰红，还原全绿；写者 `mutations-output.txt` 的逐点记录与我这次结果不冲突 |
| A4 闸不动错误对象 / `failure.code` 仍取 `error.code` / 回灌模型留原文 | **pass** | 写者 O1 用例断言 `thrown.message` 未变、`failure.code === 'Error'`；T036 断言 `ETIMEDOUT`；写者 O7 第二条断言模型消息里仍有「关系边缺少有效原始证据引用」；我回退 `trace-board.js` 时该条恰红 |
| 旧用例 T023/T030/T036/T043 改断言后仍锁得住 | **pass** | §3.2：回退后 3 红、还原 53/0；T043 的 `566` 行锚点我按可复跑 grep 命令亲手核过（输出逐字一致） |
| 新测试假件全内存 / 单条 ≤100ms | **pass（附 F3）** | 零网络符号；16 条最长 9.8ms（修复轮复跑 19 条最长 ≤11ms）；每跑一次留 3 个 tmp 目录（F3，修复轮已加清理） |
| `docs/api` 契约与实测一致 | **fail（第 1 轮判定）** | F1：`openapi.yaml:2509/2736/2433` 三处与实测冲突（修复轮已改，见 `coding-reports/P003-T052.md` §七）；F4：`trace-board.md:344` 文案复现不出（已改） |

## 6. 我没跑的，为什么

- **HTTP 面没亲跑**：本卡没有改 `server.js`（负范围），`GET /api/agent/triage/status` 与 `/api/agent/investigations/{id}` 只是 `summary()` 与记录 JSON 的序列化；我在模块级验了这两份来源（`summary().last_error` / `failure_reasons`、队列文件字节）。风险：`server.js` 侧若有二次加工就看不见——但本卡 diff 不含它。
- **离线沙箱没做成**：`unshare -rn` 在本机不被允许（exit 1），改用「零网络符号 + 全内存替件 + 0.15s 跑完」作证。
- **O9/O10/O11、日志侧原文**：按群主裁决与 T051/T046 边界，只上报不判；我实测 `triage.poll_failed`、`cloudwalker.call_failed`、`syslog.match_failed` 日志行仍带原文，这是日志侧既有口径，不是本卡违约。

## 7. 残余风险

1. `recordFailure`/`reasonForRecord` 走「keep 白名单精确匹配」与「无徽标原样放行」两套口径：`reasonForRecord('SECRET_RAW…')` 原样返回（我实测）。今天唯一调用方 `syslog-case.js` 传的都是自造判定语或带徽标的错误文案；将来新分支拼一段不合徽标的原文，会直通记录侧。
2. O10（`triage-rules.js` 的 `reason` 经 `record.steps[].detail` 落盘）与 O6 消费侧二次包裹，按 T051/T052 申报仍是 scope 外未决。
3. 写者用例的 `knowledgeTurn` tmp 泄漏（F3）在 CI 上长期跑会累积。（修复轮已加 `t.after` 清理）

## 8. 第六轮复验（纯文档整改轮，HEAD `59e0875` + 本轮补 1 条用例）

写者本轮只动文档与 recon（`docs/modules/triage-pipeline.md`、`triage-rules.md`、`knowledge-base.md`、
`experience-draft.md`、`evidence/recon/P003-T052.md`），无代码改动。A1–A4 按行为重跑。

- 补测写者六变体漏掉的形状：`O2b 超时变体`（`tester-redaction-boundary.test.js:139`）——`reason: '牧云事件查询失败：rpc timeout after 30s'`
  走真实 `TriageMonitor`：断言 `steps[].detail` 与 `result.rule_evaluation.reason` 都是 `调用超时，原文 30 字未落盘`、
  `queue.json` 不含该文本、回灌模型的 `ruleEvaluation.reason` 仍是原文。动机：`triage-pipeline.md:498-511` /
  `triage-rules.md:398-402` 承诺超时态，而写者 O2b 六变体全是 `Unexpected token` 形状（只出兜底「上游调用失败」）。
- 变异自证（我自己的，本树，`--test-name-pattern` 逐条）：`git checkout bea34bd -- triage-monitor.js` → O1 恰 1 红、
  O2b 恰 1 红、O2b 超时变体恰 1 红；`required-evidence.js` → O5 恰 1 红；`wiki-replay.js` → O8 恰 1 红；
  每次 `git checkout HEAD -- <file>` 还原后复绿。
- 本轮数字：`npm test` 228/0；`node --test evidence/test/P003-T052/` **20/0**；`git status` 干净（本文件与新增用例随本轮提交）；
  `/tmp/hids-t052-*` 0 个。
- 锚点（行为侧钉住，非读实现）：`triage-monitor.js:1084`（`detail` / `failure.reason` 过闸）、`:1046-1047`（`result.rule_evaluation`）、
  `:773`（轮询 `lastError`）——分别由 O1 / O2b / A2 用例覆盖，回退该文件各恰 1 红。
