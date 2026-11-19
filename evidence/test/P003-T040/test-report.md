# P003-T040 测试报告（测试席 · 何东阳）— 复审修复轮验收

- 任务卡：P003-T040 证据落盘复算（复审修复轮：A1 复审 major 捷径落盘 + A1/A5 复审 minor 文档闸条件）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T040`，分支 `task/hids-ai-console-P003-T040`，起验 HEAD `30ef12f`
- 代码审查判词：`verdicts/P003-T040-gc-backend-code-review-mwnr9if2.json`（pass，两条修复 + 门禁 pass，一条 minor 不阻塞）
- 判据只取：`docs/modules/investigation-agent.md` §5.7（可照着写测试的探针表）、`docs/modules/triage-pipeline.md` §6.2/:552-558/§6.4/:598/:821/:890/:907、`docs/modules/trace-board.md:248-251`、`docs/modules/evidence-view.md:182-183`、本卡用例 `evidence/test/P003-T040/evidence-rollup.test.js`
- **没读实现内容**（`investigation-agent.js` / `syslog-case.js` / `trace-board.js` / `evidence-view.js` / `triage-monitor.js` 一行没读）。变异只用三种手段：本卡 `mutate-check.sh` 里已有的锚点、`git show 201d278:<file>` 取修复前整文件、常量定义行的字符串替换。

## 结论

**PASS。** 复审两条都立得住：

1. **major（捷径落盘移出知识库 try 块）**：第 8 条用例拿真实修复前代码（`201d278`）跑是红的，且**只红这一条**——失败落在 `evidence-rollup.test.js:275` 的 `modelCalls` 上（actual 3 / expected 1，即修复前的「白跑一整轮」）。变异 8 我自己做了一遍，恰红；还原后 8/8 复绿，`git diff` 空。
2. **minor（25000 字闸条件）**：文档那三句话我逐句做行为核对，边界精确到 24999/25000/25001，不是「大概两万五」。

测试本身我没放过：**4 条上界断言写宽**（3 条实测抓不住、1 条是控制组证明探针有效），都是加固项、不是产品缺陷——对应行为我用公开 API 黑盒探针验过是对的。明细见 §四，每条带复跑命令。

## 一、门禁（每条都是我在这个终端里跑的，没转录任何人）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 后端全套 | `timeout 300 npm test` | `ℹ tests 210 / ℹ pass 210 / ℹ fail 0`，754ms，**exit 0**；复跑第二遍 210/0，**exit 0** |
| 本卡套件 | `timeout 120 node --test --test-timeout=60000 evidence/test/P003-T040/evidence-rollup.test.js` | `pass 8 / fail 0`，157ms，**exit 0**；连跑 4 遍全 8/0（无 flake） |
| 变异检查 | `timeout 300 bash evidence/test/P003-T040/mutate-check.sh` | 8 行 `PASS …→ 变红`，末行 `MUTATION_CHECK_PASS 8/8`，**exit 0**；跑两遍一致，跑完 `git status` 只剩起验前就有的 ` D .pi-child-claim.json` |

**两套口径别混**：`package.json:8` 是根目录 `*.test.js` glob，`npm test` 的 210 条**不含** `evidence/test/` 子目录；本卡套件必须单跑，混读会把 210 当成本卡的数。

## 二、复审修复轮两条，逐条验

### 2.1 A1 复审 major：捷径落盘移出知识库 try 块

**修复前代码真跑（不是模拟变异）**：

```
git show 201d278:investigation-agent.js > investigation-agent.js   # 修复前那版
node --test evidence/test/P003-T040/evidence-rollup.test.js
→ pass 7 / fail 1，唯一红 = 「A1 复审 major：捷径路径写案卷失败当场抛…」
  AssertionError at evidence-rollup.test.js:275 → actual: 3, expected: 1
git checkout -- investigation-agent.js && 再跑 → pass 8 / fail 0
```

红点落在 `modelCalls`（3 比 1），说明修复前的问题正是「落盘失败被吞 → 继续进调查循环白跑」，与判词描述一致。

**变异 8 恰红复现（我自己做的）**：把 `mutate-check.sh` 的 m8 片段手工打到 `investigation-agent.js`，跑出来：

```
✔ ×7（其余 7 条全绿）   ✖ A1 复审 major …（唯一红）
ℹ pass 7 / fail 1    EXIT=1
还原（cp /tmp 备份）→ ℹ pass 8 / fail 0，git diff --stat -- investigation-agent.js 空
```

**守卫硬度逐条核**（删掉对应实现会不会红）：

| 断言 | 排除什么 | 结论 |
| --- | --- | --- |
| `assert.rejects(..., /ENOENT\|no such file/i)` | 干脆不落盘 / 失败不抛（会 resolve → 红） | 硬 |
| `assert.doesNotMatch(error.message, /经验核对失败/)` | 吞成「经验核对失败，继续完整研判」 | 硬 |
| `assert.equal(modelCalls, 1)` | 白跑一整轮（实测修复前 = 3） | 硬 |
| `assert.deepEqual(caseInfo.files, [])` | 失败落盘留下半个白名单项 | 硬 |

**没覆盖到的分支**：捷径**成功**分支（真实 `case_dir` 下落盘成功再返回）套件里没有断言（第 8 条只测失败分支；`investigation-agent.test.js:59-109` 那条捷径用例没有 `caseInfo`）。我用黑盒探针补验了行为——见 §四 F3，行为是对的，只是没断言。

### 2.2 A1/A5 复审 minor：triage-pipeline.md 的 25000 字闸条件

文档 `triage-pipeline.md:552-558` 三句话，我逐句做行为核对（`node evidence/test/P003-T040/probes/case-file-gate.mjs`，EXIT=0）：

```
[闸] 原始 字符=12765 字节=24825
[闸] 24999 字符 -> CONTENT len=24999
[闸] 25000 字符 -> CONTENT len=25000          ← ≤25000 给内容
[闸] 25001 字符 -> ERROR 材料超过本次读取上限，请使用 03-研判事实.md 的摘要
[上界] 30 项×5 行 200 字 -> 落盘 63565 字符（常量 64000），slimmed=undefined, omitted=0
[上界] 超 25000 的这份：readCaseFile=ERROR，readRequiredEvidence checks=30
[上界] 600 项 -> 落盘 63932 字符（<=常量 true） slimmed=1 omitted=569 truncated=true 守恒 checks+omitted=600/600
```

- 「≤25000 模型能直接读」→ 24999/25000 都给内容；
- 「超过 25000 模型读到错误提示」→ 25001 起给错误对象、不给内容；
- 「复算走 `readRequiredEvidence()`，它没有这道闸、读全文」→ 63565 字符的文件，`readCaseFile` 报错，`readRequiredEvidence` 读回 30 项；
- 「上界 64000」→ 600 项 63932 字符不越界，降级 1 项、整项丢弃 569 条、`truncated: true`，`checks + omitted_items = 600` 不静默丢项。

**结论：文档这三句与实测逐字对上，不是补了一句空话。**

## 三、常量 / 文档对账（运行时取值 vs 文档行）

| 常量 | 运行时值 | 文档 |
| --- | --- | --- |
| `persistedEvidenceViewMax` | 6000 | `investigation-agent.md:673` |
| `requiredEvidenceMaxChars` | 64000 | `triage-pipeline.md:552` |
| `findingsRowLimit` | 50 | `trace-board.md:248` |
| `findingsRowsMaxChars` | 16000 | `trace-board.md:248` |
| `findingsNodeMaxChars` | 120000 | `trace-board.md:249` |
| `syslogOmittedFieldsLimit` | 40 | `evidence-view.md:58`、`:182` |
| `agentDisplayLimits.cmdlines` | 4 | `evidence-view.md:55`、`:326` |
| `queueArgValueMaxChars` / `queueArgsMaxChars` | 80 / 200 | 卡面 A6 口径 |

命令：`node --input-type=module -e "…import 后逐个打印…"`（EXIT=0）。值与文档一致。

## 四、测试本身审计：4 条断言写宽（加固项，非产品缺陷）

先把话说清：下面 3 条「抓不住」我都在**行为面**用公开 API 验过，产品是对的——**问题在断言判别力，不在实现**。复跑：`bash evidence/test/P003-T040/probes/loose-guard-check.sh`（EXIT=0，`LOOSE_GUARD_CHECK_REPRODUCED 3 条抓不住 + 1 条控制组变红`）。

### F1（minor）必查项 64000 上界是自引用断言，改常量抓不住

- 文档：`triage-pipeline.md:552`「**上界 64000 字符**」
- 断言：`evidence-rollup.test.js:127` `text.length <= requiredEvidenceMaxChars`（比的是**自己 import 的常量**）
- 实测：把常量改成 `100000`，套件 **8/8 全绿**（那 120 项数据在 100000 下照样会触发降级，`slimmed_items > 0`、`checks + omitted = 120` 都还成立）
- 复现：`loose-guard-check.sh` 第 1 条 → `REPRO …64000→100000 → 套件 green`
- 建议：加 `assert.equal(requiredEvidenceMaxChars, 64000)`；或用「降级阈值刚好卡在 64000」的数据集，让常量一变就红

### F2（minor）A4 用例名承诺「超界只缩行并记 rows_omitted」，但一个超界数据都没喂

- 文档：`trace-board.md:248-251`「每调用 16000 字、每节点 120000 字；超界只收缩行，砍掉的行数累加进 `rows_omitted`，`truncated` 同时置真」
- 断言：`evidence-rollup.test.js:151-180` 只喂 30 行，结果 `rows_omitted === 0`、`truncated === false`；16000 与 50 只是被 `assert.equal` 钉住的常量（`:185-186`）
- 实测：把 `findingsNodeMaxChars` 改成 `1000000000`（上界形同取消）→ 套件 **8/8 全绿**；改成 `1000`（控制组）→ 第 5 条红
- 复现：`loose-guard-check.sh` 第 2、4 条
- 建议：补一条 >50 行的数据（如 60 行），断言 `rows.length === 50`、`rows_omitted === 10`、`truncated === true`、`evidence_id/returned` 不丢

### F3（minor）捷径「成功」分支无断言（行为正确，只是没测）

- 文档：`investigation-agent.md` §5.7 表只写了失败分支；卡面 A1-3 是「triage 且有 `streamContext.caseInfo` 时落该文件」
- 实测（`node evidence/test/P003-T040/probes/shortcut-success.mjs`，EXIT=0）：真实 `case_dir` 下走捷径 → `modelCalls = 1`、`caseInfo.files = ["06-必查项.json"]`、落盘 914 字符、`alert_id/mode` 对、`checks = 3`。**行为是对的**
- 缺口：套件里没有这条断言，把「落盘后返回的是什么」写坏不会被现有用例抓住（成功分支只有 `investigation-agent.test.js:59-109`，无 `caseInfo`，走不到落盘）
- 建议：把探针收敛成第 9 条用例（成功分支断言文件存在 + `verdict` 正常 + `modelCalls === 1`）

### F4（nit）`omitted_fields` 封顶也是自引用断言

- 文档：`evidence-view.md:58`「40」
- 断言：`evidence-rollup.test.js:141` `bounded.omitted_fields.length === syslogOmittedFieldsLimit`（比常量）
- 实测：40→41，套件 **8/8 全绿**（硬的那一半 `JSON ≤ 3000` 仍在，所以只是 nit）
- 复现：`loose-guard-check.sh` 第 3 条
- 建议：钉死 `assert.equal(syslogOmittedFieldsLimit, 40)`

## 五、环境与残留

- 产品代码零改动：本轮结束时 `git diff` 空（`investigation-agent.js` / `syslog-case.js` / `trace-board.js` / `evidence-view.js` 还原后逐个 `git diff --stat` 空）。
- 变异/探针全部自带还原；树上无 `.bak` 残留，无挂着不动的 `node` 进程。
- 本轮新增未跟踪文件：本报告 + `evidence/test/P003-T040/probes/`（3 个探针 + 1 个守卫硬度脚本）。
- ` D .pi-child-claim.json`：起验前就在（判词已记 minor），不是这轮弄的。

## 六、残余风险（没查清的写没查清）

- **文档行号锚点没复核**：`triage-pipeline.md` 引的 `syslog-case.js:172/:180`、`investigation-agent.md` 引的 `:502/:592-595/:966` 这些**行号**我这轮没验（测试席不读实现内容，只验了值域与行为）。行号若漂属于文档侧，需 code-docs 探针复核。
- **F1/F2 是放行风险**：本卡这两条上界现在靠「常量被钉死 + 数据不超界」，下一个人改上界不会红。不影响本卡验收，但下次碰这几行先补断言。
