# P003-T013 测试报告 · 误报入口与两个维护者

- 任务卡：P003-T013（M3，后端）
- 席位：gc-backend-tester（何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T013`
- 被测面：`POST /api/agent/triage/{alertId}/false-positive`、`GET /api/agent/triage/{alertId}` 上的
  `verdict` / `feedback` / `maintenance` 字段，以及两个维护者真实写盘
- 判据来源：`openapi.yaml`（`reportFalsePositive`、`FalsePositiveRecord`、`FalsePositiveFeedback`、
  `MaintenanceSide`、`CaseMaintenance`、`TriageCase`）、`docs/modules/http-api.md` §2/§3.3/§3.4/§8/§9、
  `docs/modules/knowledge-base.md` §4.2/§4.3、`docs/modules/triage-pipeline.md` §6/§7、任务卡 A1–A4
- 没读任何实现文件内容；`server.js` / `triage-monitor.js` / `rule-store.js` / `wiki-*.js` 只做公开类与方法调用
- 本轮为 **测试审计打回后的补测**（判词 `verdicts/P003-T013-gc-backend-test-review-mwmh4p7t.json`）：
  只改测试与报告，未改产品代码（`git diff --stat 33e6d76..HEAD` 见 §8）

**结论：PASS**（A1/A2/A3/A4 全部成立）。本轮补上两条被打回的判别力：A2 目录文件集合与规则条数、A3 选页。
另有一条契约口径不一（`who` 超长）以 `todo` 用例持续暴露，见 §7.1。

---

## 1 怎么跑的（全部在本树亲跑）

```
$ timeout 180 node --test --test-reporter=tap evidence/test/P003-T013/acceptance.test.js
# tests 9
# pass 8
# fail 0
# todo 1
exit 0            # 连跑 3 次，3 次均 9 / 8 pass / 1 todo / exit 0

$ timeout 300 node --test --test-reporter=tap *.test.js
not ok 98 - maintenance CLI starts when the deployment current path is a symlink
# tests 186
# pass 185
# fail 1
exit 1
```

全套唯一红是 `maintenance-startup.test.js`（`docs/_meta/gaps.md` 记的环境基线，本卡零 diff），与派活给的基线
`186/185/1` 一致。`# todo 1` 是 §7.1 那条待定口径用例：Node 的 todo 用例失败不计入 `fail`、不影响 exit code，
但它每次都出现在输出里，不会被悄悄吞掉。

测试文件：`evidence/test/P003-T013/acceptance.test.js`（9 条，全部集成/e2e；不写单测）。

**装配口径**：真 HTTP + `createServer` 的文档化注入点（`http-api.md` §2）＋ **真的** `TriageMonitor`、
`RuleStore`、`WikiStore`、`WikiWorkbench`、`RegoRuleMaintainer`；只把**外部模型**换成本地假模型。
两个维护者的校验、写盘、三态状态机全部走生产实现。临时 wiki/rules/案件目录都是本用例自己的 `mkdtemp`，
退出即删，不碰共享 `<仓库上一级>/backend/.data`。

**「分析时引用过的页」在夹具里写两处同值**：`result.json` 的 `trace`
（`[{kind:'wiki', action:'page', id:'HP-11'}]`，运行时形状见 `investigation-agent.js:536`）与
`verdict.wiki.consulted: ['HP-11']`（结论字段，`investigation-agent.md` §3.8）。两处同值，夹具不自己制造歧义；
实测哪一处真正驱动选页见 §7.2。

## 2 A1 先落盘后 202

用例把两个维护者都卡在未决 Promise 上，POST 回 202 后立刻三处对读：

| 断言 | 结果 |
| --- | --- |
| 202 响应形状合 `FalsePositiveRecord`（顶层键恰为 `alert_id/verdict/feedback/maintenance`；`verdict.source=human`；`feedback.recorded_at` 可解析） | 绿 |
| 202 到手时**磁盘快照**里已是 `verdict=false_positive`、`verdict_label=误报`、`decision_source=human`、`feedback{reason,who,recorded_at}` 齐 | 绿 |
| 同一时刻磁盘 `maintenance.status === 'updating'`（维护还没收尾） | 绿 |
| `GET /api/agent/triage/{alertId}` 同时读到误报 + `updating`（走真 `monitor.status()`） | 绿 |
| 放行后收尾：总态 `updated`，`rule.status=updated`（`file=honeypot_probe.rego`、`action=update`），`wiki.status=updated`（`page=honeypot/HP-10.md`、有 `revision`） | 绿 |
| 维护结果不改写结论：收尾后 `verdict/verdict_label/feedback.reason` 原样 | 绿 |

入参边界每条都断言 `{error:string}` 且 `content-type` 是 JSON：

| 用例 | 实测 |
| --- | --- |
| 缺 reason / reason 9 字 / reason 4001 字 / who 1 字 | 400 |
| 正文 `[]`、`null`、`"mistake"` | 400 |
| 正文 `{`（非 JSON） | 400「请求正文不是 JSON」 |
| `bad-id` | 400 |
| 合法格式但不存在的案件 | 404 |
| `status=queued` 的记录 | 409「研判还没结束」；原记录与 GET 结果都没被改 |
| done 记录：reason 10 字、who 省略 → `operator`；reason 4000 字、who 100 字 | 202，回显正确 |
| 正文长度边界（§8.1 上限 12000）：恰好 12000 字 | 202，响应合 `FalsePositiveRecord` |
| 正文 12001 字 / 超出上限更多 | 400「请求正文过大」 |
| 研判队列未配置（`createServer` 显式传 `monitor=null`、`access={}`） | 503「自动研判尚未配置」 |
| `who` 101 字 | **todo**：按 `openapi.yaml` `maxLength: 100` 应为 400，实测 202 并截断到 100 —— 契约口径待定，见 §7.1 |

## 3 A2 只动一份 Rego

这一节是本轮补强的重点。改规则与加规则两条路径都先取**改前基线**（`rules/` 目录逐文件内容 + `GET /api/rules` 的 id 列表），
收尾后再取一次，逐项对：

| 断言 | 结果 |
| --- | --- |
| 改已有规则：`rules/` 里 `.rego` **文件集合与改前完全相同**（没有多出来的文件，也没有少） | 绿 |
| 改已有规则：`.rego` 份数仍为 3；`GET /api/rules` 仍 3 条，id 集合与改前完全相同 | 绿 |
| 改已有规则：`honeypot_probe.rego` 等于模型给的新正文；其余既有文件逐字节不变 | 绿 |
| 新增规则：`rules/` 里 `.rego` 集合恰为「改前三份 + `ops_probe_allow.rego`」，份数 = 改前 +1 | 绿 |
| 新增规则：`GET /api/rules` 条数 = 改前 +1，id 集合恰为「改前那些 + 新那条」；原有三份逐字节不变 | 绿 |
| 子集外语法（`input.host =~ "..."`）：`maintenance.rule.status=failed`，错误含 `honeypot_probe.rego:<行>`；规则目录与用例前逐字节一致；没有 `.` 开头的临时文件 | 绿 |

判别力验证见 §6.3：在维护窗口里塞一份**合法** `extra_probe.rego`，上一节这条「文件集合不变」断言当场红
（上一轮同类回归曾是绿的，这是本次补强的核心）。

## 4 A3 两个维护者都不是分析 Agent；wiki 改的是分析引用过的那一页

| 断言 | 结果 |
| --- | --- |
| 注入的研判器 `run()` 在整轮维护里调用 0 次（一调就抛，没抛） | 绿 |
| 规则维护者模型调用的 system 提示 = `prompts.rule`（本卡标记串），不是研判提示 | 绿 |
| wiki 维护者模型调用的 system 提示 = `prompts.knowledge` 且带 `_schema.md`（Wiki 操作手册） | 绿 |
| wiki 维护目标 = 分析时引用过的 `honeypot/HP-10.md`（A1 用例，此时引用页与回退首项同页） | 绿 |
| **专设判别用例**：夹具在 `wiki/` 里造一页 active 的 `HP-11`，案件材料的 `trace` 与 `verdict.wiki.consulted` 都指向 `HP-11`；本场景第一页仍是 `HP-10`（路径排序在前）。断言 `maintenance.wiki.page === 'honeypot/HP-11.md'`、`pages === ['honeypot/HP-11.md']`、模型拿到的 `current_page` 是 `HP-11` 不是 `HP-10`、会话 `page=honeypot/HP-11.md` | 绿 |
| 引用页真被写进去：`HP-11` revision 变、正文出现维护记录 | 绿 |
| **没改错页**：`HP-10` 的 revision 与正文逐字节未变 | 绿 |
| `log.md` 追加了审核人（`值班分析员`）与登记理由 | 绿 |
| 会话留痕：`feedback.expected_verdict=false_positive`、`reason`/`who` 为登记人所填 | 绿 |

判别力验证见 §6.2：把「引用过的页」这条选页分支断掉（改为永远取本场景第一页），这条用例当场红，
报的正是 `wiki 维护者改的不是分析时引用过的页：actual 'honeypot/HP-10.md' expected 'honeypot/HP-11.md'`。

## 5 A4 失败不回滚 + 三态

| 场景 | 实测 |
| --- | --- |
| 规则失败（子集外语法）、wiki 成功 | 总态 `failed`；`rule.status=failed` + 错误原文；`wiki.status=updated`（`page=honeypot/HP-10.md`）；`verdict/feedback` 一字不动；GET 同读 |
| 规则维护者直接抛错（模型 `ready:false`） | 同上，`rule.error` 带模型原文；wiki 的 `page=honeypot/HP-10.md`、revision 照常可见 |
| 记录上残留 `maintenance.status=updating`、本进程没在跑 | 重新登记 202 → 重起一轮 → 收尾 `updated`；结论仍误报，`feedback` 更新为新理由；规则模型只调 1 次（没重复起轮） |

**状态词表**：断言只允许 `updating` / `updated` / `failed` 三值（总态与单边都查）。

## 6 变异验红（全部在 `/tmp` 副本里做，未碰工作树）

### 6.1 结论落盘区段与三态计算（沿用上一轮两处）

1. `cp -a` 工作树到 `/tmp/p013-mut1`，盲删 `server.js:618-624`（写结论 + persist 区段）：

```
$ node --test evidence/test/P003-T013/acceptance.test.js
not ok 1..7  （A1/A2/A3/A4 共 7 条）
ok 8 # TODO（who 超长，todo 恒挂在输出里）
ok 9 - 503
# tests 9 / pass 1 / fail 7 / todo 1    exit 1
```

2. `/tmp/p013-mut2`，盲把 `server.js:100-115` 里的 `'failed'` 全换成 `'updated'`（三态计算区段）：

```
ok 1 / ok 2 / ok 3
not ok 4 - A4 规则维护失败（子集外语法）
not ok 5 - A4 规则维护者抛错、wiki 正常
ok 6 / ok 7 / ok 8(todo) / ok 9
# tests 9 / pass 6 / fail 2 / todo 1    exit 1
```

### 6.2 A3 选页分支（本轮新增，针对上一轮「删 cited 分支仍全绿」）

`/tmp/p013-mut-a3`：盲改 `server.js:193-205` 区段里的 kind 字面量 `'wiki'` → `'wiki_mutated'`
（sha1 由 `5ba12d9c…` 变 `6b090196…`，确认改动落到了 `wikiFeedbackTarget` 区段；未读该区段内容）：

```
$ node --test --test-name-pattern="A3 wiki 维护目标" evidence/test/P003-T013/acceptance.test.js
not ok 1 - A3 wiki 维护目标取分析时引用过的页（HP-11），不是本场景第一页（HP-10）
    wiki 维护者改的不是分析时引用过的页
    + actual: 'honeypot/HP-10.md'
    - expected: 'honeypot/HP-11.md'
# tests 1 / pass 0 / fail 1    exit 1
```

这条用例在未变异的工作树上是绿的（§1 的 3 次连跑）。上一轮对同一分支的变异是 7/7 全绿，本轮不再复现。

### 6.3 A2 多一份合法 Rego（本轮新增，针对上一轮「多写一份合法规则仍绿」）

`/tmp/p013-mut-a2`：在 A1 用例 POST 回 202 之后、两个维护者仍卡在 gate 上时，往 `rules/` 里写一份**合法子集**
`extra_probe.rego`（模拟「实现多写一份合法规则」），其余不动：

```
$ node --test --test-name-pattern="A1 POST 回 202" evidence/test/P003-T013/acceptance.test.js
not ok 1 - A1 POST 回 202 ...
    改一条规则后 rules 目录的文件集合变了：
      extra_probe.rego,honeypot_probe.rego,ssh_bruteforce.rego,webshell_drop.rego
      vs honeypot_probe.rego,ssh_bruteforce.rego,webshell_drop.rego
# tests 1 / pass 0 / fail 1    exit 1
```

## 7 契约缺口与残余风险

### 7.1 `who` 超长：openapi 与 http-api 口径不一（未定，todo 用例持续暴露）

- `openapi.yaml` 给 `who` 的 `maxLength` 是 100，`FalsePositiveFeedback.who` 也写「2 到 100 字」；
- `docs/modules/http-api.md` §3.4 的 400 条件清单只写「登记人短于 2 字」，没写上限与超限状态码；
- 实测：`who` 101 字 → **202**，响应里 `who` 被截到 100 字。

「按 `maxLength` 应回 400」与「超长就截断再说」两种口径都说得通，测试者不替契约拍板：
用例标 `todo`（断言 400，当前红但不阻塞），每次跑都出现在输出里；这条要群主定口径后才能转成硬断言。
**这是 spec 内部不一致，不是我在实现里挑的刺。**

### 7.2 文档没写「分析时引用过的页」怎么取（doc-side）

`docs/modules/http-api.md` §3.4 只写「优先分析时引用过的判据页，其次本场景第一页」，**没写**从哪个字段取
（`result.json` 的 `trace` 条目还是 `verdict.wiki.consulted`）。本轮黑盒实测（探针可复跑）：

```
$ timeout 120 node evidence/test/P003-T013/probe-page-selection.mjs
trace-only      POST=202 wiki 维护目标=honeypot/HP-11.md
consulted-only  POST=202 wiki 维护目标=honeypot/HP-10.md
neither         POST=202 wiki 维护目标=honeypot/HP-10.md
exit 0
```

也就是说：`trace` 里的页级条目驱动选页，`verdict.wiki.consulted` 单独**不驱动**（回退到本场景第一页 `HP-10`）。
`trace` 里 `kind:'wiki'` 页级条目的形状在 `investigation-agent.md` 只有零散提及、没有成节定义。
夹具因此两处同值，并且不把「只写 `consulted` 就够」写成断言——文档该补一句：选页读的是 `trace` 里哪一条。

### 7.3 其余残余风险

1. 两个维护者的**模型输出质量**没验：假模型只覆盖「合法一份 Rego / 合法一页修订 / 明确失败」三种形状；
   真实模型产出的语义好坏、wiki 正文质量不在本卡。
2. `result.json` 的历史材料形状：本用例按 `investigation-agent.md` §3.8（`verdict.rego`/`verdict.wiki`）
   与 `triage-pipeline.md` §7.3 构造；缺 `trace` 或 `verdict.wiki` 时走回退分支（落到本场景第一页）的行为
   只在 §7.2 的探针里观察过，没有写成断言。
3. 共享运行态（`<仓库上一级>/backend/.data`）没有真进程端到端跑一遍：本用例用真类 + 临时目录，
   进程重启后的残留 `updating` 只在记录层面模拟（生产同样不带自动恢复，见写者未决 3）。
4. 本卡已知的两条 minor（`writeRuleFile` 复验窄窗口、`architecture.md:201` 计数）仍成立，测试不改变结论。

## 8 本轮改了什么（只动测试与报告）

```
evidence/test/P003-T013/acceptance.test.js        # 补断言 + 新增 A3 选页判别用例 + 长度边界 + todo 用例
evidence/test/P003-T013/probe-page-selection.mjs  # 附属黑盒探针：选页读 trace 还是 consulted（§7.2 的复跑入口）
evidence/test/P003-T013/test-report.md            # 本文件：A2/A3 的口径与实测对齐，补契约缺口
```

- A2：改规则路径补「`.rego` 文件集合不变 + 份数 3 + `/api/rules` 3 条且 id 集合不变」；加规则路径补
  「份数 +1 + `/api/rules` 条数 +1 且 id 集合恰为原集合 + 新的那条」。
- A3：新增判别用例（`HP-11` 引用页 vs `HP-10` 首项），断言发布页、会话页、模型看到的当前页、未改错页四件事。
- A1：正文长度补「恰好 12000 字 → 202」「12001 字 → 400」；`who` 101 字标 todo（§7.1）。
- 503：`createServer` 显式传 `monitor=null`、`access={}`，不再吃本机环境变量。
- 报告上一轮写的「GET /api/rules 仍只有 3 条」「规则库列 4 条」「wiki 维护目标 = 分析时引用过的页」三句，
  本轮都有对应断言落点；没有落点的说法一律删掉或写进 §7。
