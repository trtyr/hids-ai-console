# P003-T054 测试报告：收尾清洁（泄漏面最后两处 + 测试卫生 + 文档 stale）

工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T054`（HEAD `1844ab3`，起活基线 `b2e1f4e`）
测试者：何东阳。判据只认文档与卡面：`docs/modules/http-api.md:55`、`docs/modules/investigation-agent.md:920`、
`docs/modules/triage-rules.md:388`、`docs/modules/maintenance-service.md:90`、`docs/modules/triage-pipeline.md:1033`、`docs/modules/investigation-agent.md:411-413`、`docs/modules/triage-pipeline.md:285-291`。
没读实现正文；变异只按写者报告里的「改法」做定向替换（脚本打印命中数，不打印源码），每次 `git checkout -- <file>` 还原后 `git diff` 为空。

## 1. 我写了什么

`evidence/test/P003-T054/tester-acceptance.test.js`（7 条，公开面级；与写者 8 条不重复断言）：

| 用例 | 钉的文档点 | 观测面 |
| --- | --- | --- |
| A1-a 规则评估抛错 | http-api.md:55（落盘副本过闸、回灌模型那份原文） | 真 HTTP `POST /api/agent/investigations`（`createServer` 注入替身）+ 响应 + `history.save` 对象 + 模型入参 |
| A1-b 规则评估回 `status=error` | 同上 | 同上 |
| A1-c 研判记录落盘 | 同上（「落盘」而非只抓对象） | 真 `InvestigationStore` + 磁盘 JSON 文件逐个搜原文 |
| A2 未匹配 syslog | investigation-agent.md:920（无白名单，徽标不再保留） | `runUnmatchedSyslog()` 返回体（`verdict.analysis` / `missing_evidence`） |
| A3 triage-rules | triage-rules.md:388（`readConfig().error` 是闸后文案） | 真 `TriageRuleEngine.readConfig()`，文件内容里埋标记（V8 报错会抄开头几个字） |
| A7 drain 兜底 catch | triage-pipeline.md:1033 + :527 | `summary().last_error`、队列状态文件、日志行 |
| 全局根隔离 | P003-T050 A2 | `assertIsolatedRoot()` |

`evidence/test/P003-T054/tester-verification.txt` 是本终端全部门禁的原样摘要。

## 2. 门禁（全部本终端亲跑，exit 0）

```bash
npm test                                                        # 235 tests / 235 pass / 0 fail，exit 0
node --test --test-timeout=120000 --test-force-exit evidence/test/*/*.test.js
                                                                # 449 tests / 448 pass / 0 fail / 1 todo（who-101 豁免），exit 0
node --test evidence/test/P003-T054/*.test.js                   # 15 / 15 pass（写者 8 + 我 7）
node --test evidence/p003-t012-verify/acceptance.test.js        # 17 / 17
node --test evidence/p003-t018-verify/acceptance.test.js        # 9 / 9
node --test evidence/p003-t047-verify/acceptance.test.js        # 17 / 17（单跑）
# 两份并发（同一命令 ×2 同时跑）                                 # A 17/17，B 17/17，两个 exit 0
# config-check 8 路并行 × 10 轮 = 80 跑                          # ENOTEMPTY 0 次，80/80 ℹ fail 0
node .../gate/gate-cli.js docs --cwd .                          # stale 类 violation 0（全量 16 条为其它 code，见 §4 A9）
```

## 3. 变异（逐条亲手做：apply → 恰红 → 还原 → `git diff` 空）

脚本 `/tmp/muts.js` 只做定向正则替换并要求命中恰好 1 处；每条还原用 `git checkout -- <file>`。

| 变异 | 目标（写者报告里的改法反向） | 命中 | 恰红用例 |
| --- | --- | --- | --- |
| M1 | `server.js`：`reason: reasonForRecord(...)` → 原文 | 1 处 | 写者 A1 ×2 + 我的 A1-a/A1-b/A1-c（共 5 红） |
| M2 | `investigation-agent.js`：`recordFailure(String(text ?? ''))` → 原文直通 | 1 处 | T046 未匹配 syslog、T051 tester 未匹配 syslog、我的 A2（3 红） |
| M3a | `update-store.js`：`cause.status ? cause.message : recordFailure(cause)` → `cause.message` | 1 处 | 写者 A3 update-store（1 红） |
| M3b | `triage-rules.js`：`reasonForRecord(error.message)` → `error.message` | 1 处 | 写者 A3 triage-rules + 我的 A3（2 红） |
| M5 | `triage-monitor.js`：`recordFailure(error, { kind: '本地写入失败' })` → `error.message` | 1 处 | 写者 A7 + 我的 A7（2 红） |

每轮变异后 `git diff --stat` 为空、`git status --porcelain` 只剩我这份未提交的测试件（全部还原后才提交）。

## 4. 验收逐条

| id | 结果 | 证据 |
| --- | --- | --- |
| A1 | pass | 我的 A1-a/A1-b/A1-c 7/7；M1 下三条全红（磁盘文件与响应、`history.save` 对象都搜不到原文，`options.ruleEvaluation.reason` 仍是原文） |
| A2 | pass | 我的 A2 pass；M2 下 T046/T051/我的 A2 三条红（`missing_evidence[0]` 是 `上游调用失败，原文 N 字未落盘`，无 `牧云事件…失败：` 徽标） |
| A3 | pass | 我的 A3 triage-rules pass；M3b 下 2 红；`update-store` 侧由写者用例 + M3a（1 红）证实闸在位；两处文档（triage-rules.md:388、maintenance-service.md:90）口径一致 |
| A4 | pass | 文件里是 `mkdtemp` + `freePort()` + `listen(0)`，无硬编码端口/固定 TMP；两份并发各 17/17、exit 0 |
| A5 | pass | t012 17/17；两条改口径的断言逐条对过文档（investigation-agent.md:411-413「deep 与 triage 同一套、改前恒为空」；triage-pipeline.md:285-291「同指纹+已完结→复用结论」），不是迁就实现 |
| A6 | pass | 8 路并行 × 10 轮 = 80 跑：ENOTEMPTY 0 次、`ℹ fail 0` 80/80 |
| A7 | pass | 我的 A7 pass（`last_error` = `研判状态保存失败：本地写入失败，原文 N 字未落盘`，状态文件无原文，`triage.persist_failed` 日志行留原文）；M5 下 2 红 |
| A8 | pass | `grep -n writeSnapshot triage-monitor.js` → `284:  async writeSnapshot() {`；探针注释引 `triage-monitor.js:284`，与实现一致 |
| A9 | pass | gate `docs` 输出里 stale/bad_updated/suspicious_date 三类 violation **0 条**（余 16 条是 missing_type / missing_id / no_units_column / bad_promise_id 等既有 code）；三篇 `updated` 由 `2026-11-17` → `2026-11-20`（今天） |
| A10 | pass | 上面 §2 全绿 + §3 五个变异逐条恰红；who-101 那条仍是 1 todo（卡面豁免） |

## 5. 残留 / 未决（不挡通过）

1. **A8 卡面行号与实测差 4 行**：卡面写 `triage-monitor.js:280`，实测 `writeSnapshot` 在 `:284`（`:280` 是 `flush()` 的收尾大括号）。判据是「注释出处改指实现」，写者按实测写 `:284` 并在注释里注明——成立；卡面应订正到 284。
2. **A1 卡面提的 `result.json` 在 HTTP 路径不产生**：`POST /api/agent/investigations` 不写案件目录（triage-pipeline §3.9：现查记录没有 `case_dir`）。我用真 `InvestigationStore` 的磁盘记录（A1-c）+ 响应 + `history.save` 对象三面钉住「落盘副本」；与写者报告 §3 未决②同一件事，卡面措辞可订正。
3. **gate docs 整体 exit 1**：16 条既有 violation（frontmatter 缺 type/id、值语义表缺单位列、承诺编号不合规）不是本轮引入；A9 只判 stale 类，已清零。
4. **A7 的真实触发路径只有兜底 catch**：`investigator.run` 抛错、`history.save` 抛错、队列写盘失败都走各自的分支（分别落 `triage.failed` / 记录 `failed`），到不了 `drain()` 的这个 catch；所以我的用例与写者用例一样用「换注 `run` 抛错」把 catch 逼出来。这是该落点唯一可达的注入点，不是测试取巧。
