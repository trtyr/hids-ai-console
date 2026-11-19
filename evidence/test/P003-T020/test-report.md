# P003-T020 测试报告 · 规则维护者不许放宽原条件（HTTP 层补钉）

- 任务卡：P003-T020（后端）
- 席位：gc-backend-tester（何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T020`，分支 `task/hids-ai-console-P003-T020`（`0070fde` + `c676e1a`，起点 `4cb9fc2`）
- 被测面：`RegoRuleMaintainer.maintain()` 的「不许放宽」守卫（经既有通道暴露为 `POST /api/agent/triage/{alertId}/false-positive`
  → `maintenance.rule.status/error`），以及 `rules/webshell_drop.rego` 原版状态
- 判据来源：任务卡 A1/A2/A3；`docs/modules/http-api.md` §2/§3.4；`openapi.yaml` 的 `reportFalsePositive` /
  `FalsePositiveRecord` / `FalsePositiveFeedback` / `MaintenanceSide` / `CaseMaintenance`
- 实现内容没读；`server.js` 只做**符号名 + 行号**的结构查询（`grep -n`），行为全部经公开类/HTTP 断言
- 本轮为 tester 首轮验收：新增 `evidence/test/P003-T020/false-positive-http.test.js`（3 条集成用例），
  未改产品代码、未改写者测试（`git status --short` 只有本文件与子会话 claim 文件）

**结论：PASS**（A1 / A2 / A3 成立）。写者未决 #4 点名的 HTTP 层那一跳已用真 server 钉住；
两条 minor 见 §6（一条是报告表格计数，一条是换算子误拒的文档缺口，均不挡本卡）。

---

## 1 怎么跑的（全部在本树亲跑）

```
$ timeout 120 node --test evidence/test/P003-T020/rule-maintainer.test.js      # exit 0，13/13
$ timeout 180 node --test evidence/test/P003-T020/false-positive-http.test.js  # exit 0，3/3（本轮新增）
$ timeout 300 node --test *.test.js evidence/test/P003-T013/acceptance.test.js \
        evidence/test/P003-T019/*.test.js evidence/test/P003-T020/*.test.js
  ℹ tests 218  ℹ pass 216  ℹ fail 1  ℹ todo 1                                 # exit 1
  ✖ maintenance CLI starts when the deployment current path is a symlink
```

全套连跑 8 次：7 次 `218/216/1 红(基线)/1 todo`，1 次 `integration.test.js` 整个文件挂住 299s（外层 `timeout` 杀，exit 124）
并连带一条既有用例红；`integration.test.js` 单独连跑 3 次均 21/21 绿，之后的 5 次全套也全部正常——
按「三看分诊」记为 **C 类环境抖动**，不立 finding，但记进 §7 残余风险。

- 唯一红 `maintenance-startup.test.js` 与本卡无关，且不是「改动后变红」：该用例起的是
  `<repo>/backend/maintenance-server.js`，而 `git ls-tree --name-only 4cb9fc2 -- backend` 与
  `git ls-tree --name-only HEAD -- backend` **都为空**、`ls backend` 报 `No such file or directory`——
  路径从来不存在，结构性的红，与 `server.js` 改动无关（写者说的「基线版复跑也红」口径一致，我用路径存在性独立核了）。
- `todo 1` 是 P003-T013 既有的一条待定口径用例（`who` 超长），不计 fail，与本卡无关。
- 本卡最慢用例 <140ms，整套 0.9s；不碰真网络、真时钟、仓库里的 `rules/` 目录（HTTP 用例把 `rules/`、`wiki/` 拷进 `mkdtemp`，退出即删）。

## 2 新增集成用例：`evidence/test/P003-T020/false-positive-http.test.js`

装配：真 HTTP（`createServer` 的文档化注入点，`http-api.md` §2）＋ 真 `TriageMonitor` / `RuleStore` / `WikiStore` /
`WikiWorkbench` / `RegoRuleMaintainer`，只把**外部模型**换成本地假模型。临时 `rules/`、`wiki/`、案件目录都是自己的 `mkdtemp`。

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 放宽的候选（现场那份：前缀 `/tmp/`→`/tmp` + `hids-live-test` 排除） | POST → 202 且响应合 `FalsePositiveRecord`（顶层键恰为 `alert_id/verdict/feedback/maintenance`，`verdict.source=human`，`feedback.recorded_at` 可解析）；收尾后 `maintenance.rule.status=failed`、`error` 含「放宽了原有限制条件」且点名 `startswith(input.path, "/tmp/")`、长度 ≤300（docs §3.4 的截断口径）；wiki 边 `updated`、总态 `failed`；`verdict`/`feedback` 一字不动；`rules/` 目录**文件集合 + 每份全文逐字节 deepEqual**、无点开头临时文件；`GET` 同读同一组字段；`GET /api/rules` 仍是原来三条 | 绿 |
| 收紧的候选（原四条全留 + 叠一条排除） | `maintenance.rule.status=updated`、`action=update`、`file=webshell_drop.rego`，总态 `updated`；文件集合不变、只有那一份变成候选正文、另两份逐字节不变——证明这条路径不是「一律失败」的空转断言 | 绿 |
| 入参边界：400 / 404 / 409 | 三条各自断言 `{error:string}` 形状（理由 9 字 → 400；正文非对象 → 400；格式合法但无此案 → 404；记录 `queued` → 409），且被拒后原记录 JSON 一字不动、规则维护者一次没被叫、`rules/` 快照不变 | 绿 |

这一条把写者未决 #4 的链路钉住了：拒绝路径不再只在 `maintain()` 上验过，`202 → 后台维护 → failed → GET 可读 / 规则不落盘`
整条真 HTTP 链路有断言。

## 3 A1 六方向放宽全拒、收紧放行（跑写者单测，独立核名）

`rule-maintainer.test.js` 13/13 绿。放宽方向逐条可见于用例名，六个方向都在：前缀 `/tmp/`→`/tmp`、后缀 `.jsp`→`.js`、
删 `input.host != ""`、删现存排除、`not startswith` 的针变窄、`==` 字面量换值；收紧方向：前缀加长、加排除、
取反的针拉长、`/tmp` 收回 `/tmp/`。每条拒绝都带 `rules/` 目录快照 `deepEqual`。

**变异验红（亲手做，做完已还原）**：

| 变异（盲改指定行/串，不读实现正文） | 结果 |
| --- | --- |
| `sed -i '236,241d' server.js`（删掉放宽检查，`wc -l` 903→897、`git diff --stat` 6 行删） | 单测 `pass 5 / fail 7`；**本轮新 HTTP 用例恰红 1 条**（`actual 'updated'` vs `expected 'failed'`），另两条用例仍绿 → 新用例确实咬住这道守卫 |
| `next.value.startsWith(previous.value)` → `previous.value.startsWith(next.value)` | 单测 **`pass 8 / fail 5`**（红的五条：前缀放宽、取反方向、现场候选重放、`/tmp` 收回 `/tmp/`、前缀加长）；新 HTTP 用例也恰红 1 条 |
| 还原后 | `git checkout -- server.js`，`cmp` 与备份一致；单测 13/13、HTTP 3/3 复绿 |

第二条变异实测 `8/5`，与写者报告表格里写的 `pass 8 / fail 4` 不符（见 §6 发现 1）。

## 4 A2 `rules/webshell_drop.rego` 是原版 + 求值面钉子

```
$ diff <(git show 4cb9fc2:rules/webshell_drop.rego) rules/webshell_drop.rego   # exit 0，逐字节一致
$ git log --all --oneline -S hids-live-test -- rules/                          # 输出为空
$ grep -c 'startswith(input.path, "/tmp/")' rules/webshell_drop.rego           # 1
$ grep -c 'hids-live-test' rules/webshell_drop.rego                            # 0
```

**变异验红**：把仓库里那份的 `/tmp/` 盲改成 `/tmp`（`git diff --stat` 1 行换）→ 单测恰红
`A2 仓库里的 rules/webshell_drop.rego 是原版`（12/13），求值面钉子（`/tmpfoo/a.jsp` 不应命中）随之失效；
`git checkout -- rules/webshell_drop.rego` 还原后 13/13 复绿、`diff` 与基线再次一致。锚点不是永真断言。

## 5 A3 校验不过不落盘（抛错在 `writeRuleFile` 之前）

- 结构核（只查符号行号，不读正文）：`widenedConditions` 在 `server.js:184`，调用点在 `:238`（落在文档承诺的 `236-241` 区间），
  `writeRuleFile` 定义在 `:196`、调用在 `:244`——**抛错点在写盘调用之前**，行序成立。
- 行为核：单测 7 条拒绝路径每条都做目录快照；本轮 HTTP 用例在真 server 上再验一遍「failed 之后 `rules/` 逐字节不变、无临时文件」。
- 变异核：删掉 `236-241` 后目标文件真的会被改写（HTTP 用例从 failed 变 updated），说明快照断言不是摆设。

## 6 发现（2 条 minor，均不挡本卡）

1. **`coding-reports/P003-T020.md:72` 变异表格计数错（该行还写「三条同时红」，实测五条）**：写 `pass 8 / fail 4`，实测翻转 `startswith` 方向是 `pass 8 / fail 5`
   （漏了两条：`/tmp` 收回 `/tmp/` 与「前缀加长算收紧」也红，8+5=13）。行为没差，纯记录误差。改法：该行数字改成 `8 / 5`，或删掉条数只写「startswith 相关 5 条红」。
2. **换算子收紧会被当放宽拒绝，且文档/提示词没点名（doc-side）**：`startswith(input.path, "/tmp/")` → `input.path == "/tmp/x.jsp"`
   语义上更严，实测被拒、报错文案却说「放宽了原有限制条件」：
   复现：`timeout 60 node evidence/test/P003-T020/probe-cross-op.mjs` → `REJECTED: 规则修订放宽了原有限制条件，拒绝落盘：startswith(input.path, "/tmp/")`。
   fail closed 方向没错，但 `docs/modules/http-api.md` §3.4 判据表与 `prompts/rule-maintenance.md`（只写了 `==`/`!=` 字面量不能换）
   都没说「换算子一律拒绝」。改法：§3.4 判据表补一行 + 提示词补一句「保持原算子，不要换算子」。

## 7 残余风险

- HTML 层的两个维护者是后台跑的，用例靠轮询记录收尾（上限 10s）；本机连跑 3 次均 3/3 绿（整套 0.29~0.30s），但如果 CI 极慢，
  轮询窗口是唯一时间假设。
- wiki 边用假模型（只验证「另一边成功、总态按任一边 failed」的口径），wiki 发布细节不是本卡验收面，由 P003-T013 覆盖。
- `rules/` 快照断言覆盖文件集合与全文，但没盯 inode/权限位；本卡实现用「临时文件 + rename」，权限位变化未断言。
- 未覆盖「维护跑到一半再次登记只说当前进度」这条并发口径（P003-T013 已覆盖，本卡改动没碰 `runningMaintenance`）。
- 全套连跑时见过 1 次 `integration.test.js` 挂住 299s（exit 124，非本卡文件）：单独复跑 3/3 绿、随后 5 次全套正常，
  归为机器抖动；如果 CI 上复发，需要单独立项查那条既有用例。
