# P003-T047 测试报告：误报统一维护 Agent（多轮会话操控双库，单腿可补跑）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T047`（HEAD `1c90121`，分支 `task/hids-ai-console-P003-T047`）
- 被测判词：`P003-T047-gc-backend-code-review-mwo6jjow.json`（二轮复审 PASS）
- 测试者：何东阳（`gc-backend-tester`）。本报告里的每条数字都是我在**这棵树里亲手跑出来的**，没有转录。
- 判定依据只取文档：`docs/modules/http-api.md` §3.1/§3.4/§8.3、`docs/modules/triage-pipeline.md` §7.4、`openapi.yaml`
  （误报入口 `:817-877`、会话两条路径 `:1184-1232`、`MaintenanceSide`/`CaseMaintenance`/`FpAutoVerdict`/`FpMaintenanceSession*` `:2552-2700`）。
  没读实现文件正文；`fp-maintainer.js` / `server.js` 一个字未看。

## 一、怎么测的（黑盒路径）

自己写了一支 HTTP 端到端套件：`evidence/p003-t047-verify/acceptance.test.js`（**不是单测**，不 import 被测模块）。

- 起**真进程**：`spawn(node server.js)`，`HIDS_DATA_DIR` 指到 `/tmp/p003-t047-acceptance/data`，`HIDS_LOG_FILE` 指到临时日志；
- 上游两个都换替身：牧云指向一个必然连不上的地址（只用于满足启动闸门），模型是一个**本进程内的 OpenAI 兼容 stub**
  （按系统提示词区分决策轮 / 规则维护轮 / 知识维护轮，返回各轮提示词文档里规定的 JSON 形状）；
- 案卷与队列用**数据根文件**造：`triage-monitor.json` 里预置 6 条记录（4 条 `done`、1 条 `running`、1 条边界用），
  每条带一份 `cases/<k>/{01-原始告警.txt,03-研判事实.md,result.json}`（`result.json` 里 `rego_rule_ids` 指向
  `honeypot_probe`、`cited_wiki_ids` 指向 `honeypot/HP-10.md`，与 `prompts/false-positive.md` 描述一致）；
- 所有断言都走公开 HTTP 面（`POST /api/agent/triage/{alertId}/false-positive`、`GET /api/agent/triage/{alertId}`、
  `GET /api/false-positive/sessions[/{id}]`、`GET /api/rules/{id}`、`GET /api/rules/{id}/history`、
  `POST /api/wiki/sessions/{id}/publish`）+ 数据根文件系统（规则目录、判据页、日志文件）。
- 503 那条用文档 §2 明确认可的缺件路径：`createServer().listen()` 起一个没配牧云/模型的进程（**真进程起不来，文档也这么说**）。

跑法：

```
node --test evidence/p003-t047-verify/acceptance.test.js
```

## 二、门禁（亲跑，均在本树）

| 命令 | 结果 |
| --- | --- |
| `node --test evidence/test/P003-T047/*.test.js` | `tests 23 / pass 23 / fail 0`，exit=0 |
| `npm test` | `tests 228 / pass 228 / fail 0`，exit=0（23 次里 22 次如此，见「残余风险」第 1 条） |
| `node --check server.js && node --check fp-maintainer.js && node --check wiki-workbench.js` | exit=0 |
| `python3 -c "import yaml; yaml.safe_load(open('openapi.yaml'))"` | `paths=50`，exit=0 |
| `grep -c "待启用\|待拍板" openapi.yaml docs/modules/http-api.md docs/modules/triage-pipeline.md` | `0 / 0 / 0` |
| `sed -n 1214,1216p openapi.yaml` | `:1215` 已是「闭环自动判定的生效口径：以 Rego 规则库为准，见 FpAutoVerdict」 |

**变异验红（我自己做的，不是引用写者的）**：把 `openapi.yaml:1215` 那半句改回「`auto_verdict`（待启用的自动判定）」，跑

```
node --test evidence/test/P003-T047/contract.test.js
→ ✖ 闭环自动判定的生效口径三处一致：以 Rego 为准（A/B 已拍板），JSON 规则集只留痕
→ AssertionError: openapi.yaml 里还留着「待启用」的旧口径   exit=1
```

`git checkout -- openapi.yaml` 还原后 `git status --short` 空、同文件复跑 `fail 0`。守卫不是永真。

## 三、自写 e2e：16 条，全绿（连跑 3 次同结果）

```
$ node --test evidence/p003-t047-verify/acceptance.test.js
✔ 契约形状：会话列表与空态（openapi /api/false-positive/sessions）
✔ 错误码：会话 ID 非 UUID 回 400、合法 UUID 不存在回 404
✔ 边界：正文/理由/登记人/libraries 逐条 400，且不落半份会话
✔ 边界（严格契约）：who 上限 100 字、libraries uniqueItems
✔ 错误码：案件不存在 404、研判未完成 409、reason 4000 字合法（用到长度上限）
✔ A1/A2/A7 只动规则：202 形状 → 四轮会话落盘 → 维护侧口径
✔ A3 写入走版本化：规则文件已收紧、旧版进 rules-history、目录无临时文件
✔ A4 单腿补跑不洗掉已成功一侧的判据（成功 → 单腿 → 全量 仍只跑一次）
✔ A2/A3 只动知识库：规则库一字不动、判据页过发布闸、发布后会话终态、无重复发布口子
✔ A2/A6 两边都动：两侧都写、sides 与决策可见
✔ A4 单库失败可补跑：失败侧重跑，维护失败不改结论
✔ A5 每轮 AI 调用都进 T046 事件（域＝误报维护），request/response 成对
✔ 错误码 502：会话目录不可读时列表回 502（不是空列表）
✔ 错误码 503：无研判队列的进程里登记误报回 503 not_configured
✔ 契约静态口径（A7）：openapi 与两页文档同一口径
ℹ tests 16  ℹ pass 16  ℹ fail 0
```

### 覆盖到的 4xx/5xx（每条都断正文形状 `{error, code}`，code 只取四类）

| 触发 | 实测 | 断言 |
| --- | --- | --- |
| 正文不是 JSON / 数组 | 400 `caller_error` | `error` 是字符串 |
| 缺 `reason`、`reason` 9 字、`reason` 4001 字 | 400 `caller_error` | — |
| `who` 1 字 | 400 `caller_error` | — |
| `libraries` 不是数组 / `[]` / 含 `bogus` | 400 `caller_error`，文案「维护库必须是 rule 或 wiki 组成的一到两项」 | — |
| 案件不存在 | 404 `caller_error` | — |
| 记录 `status='running'` | 409 `caller_error`，正文含「研判还没结束」 | — |
| 无研判队列的进程 | 503 `not_configured`，正文「自动研判尚未配置」 | — |
| 会话目录 `chmod 000` | 502 `upstream_error`（不是空列表）；恢复后 200 | — |
| 已发布的知识维护会话再发布 | 409 `caller_error` | — |
| 会话 ID 不是 UUID / 合法 UUID 不存在 | 400 / 404 `caller_error` | — |

## 四、A1–A7 逐条（HTTP 面实测）

| id | 结论 | 实测证据 |
| --- | --- | --- |
| A1 单一 Agent、多轮会话落盘可查 | 满足 | 202 响应 `maintenance.status='updating'`；同一时刻 `GET /api/agent/triage/{id}` 已是 `verdict=false_positive`、`decision_source=human`（先结论后维护）；`GET /api/false-positive/sessions/{id}` 回整份会话：`turns[].phase=['case','libraries','propose','verify']`、`messages[].kind` 含 case/libraries/decision/verify、`evidence` 无、`terminal=true`；摘要列表按 `updated_at` 倒序且字段集与 `FpMaintenanceSessionSummary` 完全一致（`additionalProperties:false` 逐键核过） |
| A2 只动规则 / 只动知识库 / 双动，动哪边为什么可见 | 满足 | 三条路径各跑一遍：`sides=['rule']` / `['wiki']` / `['rule','wiki']`，`decision.libraries` 与 `decision.why` 同步可读；只动规则时 `wiki.state='no_change'`、只动知识库时规则文件 sha 前后一致、规则维护模型调用数不增 |
| A3 走 T041 版本化 / 发布闸 / 终态 / 无重复发布 | 满足 | 规则侧：`GET /api/rules/honeypot_probe` 正文已含新收紧条件、`GET .../history` 末条 `note` 匹配「误报维护（何东阳）」，`rules/` 目录除 3 个 `.rego` 无任何残留；知识库侧：判据页文件已追加段落、`maintenance.wiki.wiki_session_status='published'`、同一 wiki 会话再 `POST /publish` 回 409 |
| A4 单腿补跑幂等（case_id+库+revision） | 满足 | 成功 → 单腿（`libraries:['rule']`）→ 全量 这条序列上，规则维护模型调用数**全程不增**、`rule.idempotency_key` / `rule.revision` 逐轮完全一致（单腿那一轮没被洗掉）；全量后再请求 `['rule']` → `decision.source='idempotent'`、`sides=[]`、决策模型调用数不增。失败路径：第一次给放宽规则 → `status='failed'`、`rule.error` 含「放宽」、规则文件一字未动、目录无临时文件、`verdict` 仍 `false_positive`；`libraries:['rule']` 补跑 → `rule.state='updated'`，未请求的 wiki 记 `skipped` 且 `why` 含「本次只补跑」 |
| A5 每轮 AI 调用进 T046 事件（域＝误报维护） | 满足 | 从 `HIDS_LOG_FILE` 读回事件：`event=ai.model_call` 且 `domain=false_positive` 的行里，角色集含 `fp_maintainer` / `rule_maintainer` / `wiki_maintainer`；按 `(role,turn,attempt,session_id)` 分组，request 条数 == response 条数（成对）；`fp_maintainer` 带 `phase=propose` |
| A6 替身模型验证三条路径 + 补跑不重发 | 满足 | 三条路径的模型调用数由 stub 计数：只动规则时 rule=1/wiki=0，只动知识库时 rule=0，双动时各 1；幂等轮 0 次调用；失败补齐轮只发一次规则调用 |
| A7 自动判定口径（A/B 已拍板：以 Rego 为准） | 满足 | `record.maintenance.auto_verdict = {enabled:true, criterion:'rego', trust:'single', note}`（`note` 含「JSON 规则集…不作为生效判据」），会话里同一格一致；`openapi.yaml:1215` 与 `FpAutoVerdict`（`required:[enabled,criterion]`、`criterion enum:[rego]`、`trust enum:[single]`）同口径；`openapi.yaml` / `http-api.md` / `triage-pipeline.md` 三处 `待启用|待拍板` 命中数均为 0 |

## 五、发现（doc-side，均 minor；不挡 A1–A7）

1. **`openapi.yaml:857` 的 `who.maxLength: 100` 在服务端不是「拒收」而是「截断」**：101 字 `who` 实测回 202，
   落盘 `feedback.who` 是 100 字。文档 §3.4 的 400 表只写了「登记人短于 2 字」，没写超长处置；
   `FalsePositiveFeedback` 的 `who` 描述也没说截断。建议二选一：路由按 `maxLength` 回 400（与 requestBody 一致），
   或把契约改成「超长截到 100 字」并在 §3.4 的 400 表隔壁写明。
2. **`openapi.yaml:862` 的 `libraries.uniqueItems: true` 服务端没校验**：`libraries:['rule','rule']` 实测回 202（按去重后的库跑）。
   §3.4 的 400 表同样只列了「不是数组 / 空数组 / 含 rule、wiki 之外的值」。建议同上：要么校验，要么在契约里去掉 `uniqueItems`
   并在表里补一句「重复项按去重处理」。
3. （复现）两条都跑在专门的一条边界记录上，见 `acceptance.test.js` 的「边界（严格契约）」子测试与服务端 `t.diagnostic` 输出。

## 六、残余风险（没查清 / 没测到）

1. **`npm test` 一次 `pass 227 / fail 1`（23 次里 1 次）**，当时没接住失败用例名；之后连跑 22 次（含 3 次带 4 个 CPU 打满的
   负载跑）全部 228/228，**没复现、没查清**。与复审判词里「T013 一次未复现时序红」可能是同一类时序抖动，但我没有证据把它钉到具体用例上。
2. **「同一轮维护还在跑时再登记只回当前进度」没卡到时间窗**：所有登记都太快（单轮 <100ms），没能稳定命中
   `runningMaintenance` 那条分支；这条只有写者单测覆盖。
3. **500 `internal_error` 没在误报两条路由上触发**：喂给它们的所有畸形输入都在 400/404/409/502/503 里被拦住了，
   没找到能把内部异常打出来的黑盒输入。
4. **知识库发布闸的负例（断链 / 证据引用缺失 → 拒绝）没在本卡重测**：那一层是 T042 的契约，本轮只用「正常草案能写进去 +
   再发布 409」证明它还在链路上。
5. **重启残留**（进程死在维护中途停在 `updating`）按文档是已知不恢复行为，本卡未测。
6. 替身模型的回包是**我自己编的**，只按 `prompts/*.md` 的输出契约造形；真实模型回包的长尾没有覆盖。
