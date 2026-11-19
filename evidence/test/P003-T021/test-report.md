# P003-T021 后端测试报告

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T021`（分支 `task/hids-ai-console-P003-T021`）
- 被测提交：`e997260`（HEAD `86b73fd` 报告提交）
- 测试面：只走文档承诺的公开面（HTTP 两个入口 + `WikiStore`/`WikiWorkbench` 文档列出的公开方法），**未读实现文件内容**
- 探针：`evidence/test/P003-T021/verify.mjs`（31 条断言 + 2 条文档口径核对，全临时目录，不碰仓内 `wiki/`）

## 1. 验收锚点（任务卡 A1/A2/A3）

| 锚点 | 判据（任务卡原文口径） | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | 误报路径上要么改一页方法论，要么 `maintenance.wiki.error` 写明为什么没改 | pass | S6：`wiki.status=failed`，`error` 63 字含「知识库维护未改判据（data_gap·数据缺口）：判据本身未发现错误；后续由「Syslog 解析、牧云事件匹配与取证接口」处置」，判据页 sha 未变；S7：`wiki.status=updated`，`honeypot/HP-10.md` 真写入草案正文 |
| A2 | `needs_non_wiki_fix` 不能被收成一句没有正文的失败 | pass | S2a 会话 `status=needs_non_wiki_fix` + 502 body 63 字（诊断+rationale+后续方）；S2b/S2c 同属失败正文，分别 47/46 字；S2d 1000 字 rationale 截到 254 字 ≤300；无一条是裸状态词（断言不含 `needs_non_wiki_fix`） |
| A3 | 失败不把已写成的误报结论改回去 | pass | S6/S7 两支 `verdict=false_positive`、`verdict_label=误报`、`decision_source=human`、`feedback.reason` 一字不动；S6 附 `GET /api/agent/triage/{alertId}` 读回同一组字段 |

补充：`node /tmp/t021-e2e.mjs`（写者 e2e）我也亲手复跑，EXIT=0，输出与报告一致。

## 2. 覆盖矩阵（schema / 边界 / 错误码）

| 类 | 用例 | 结果 |
| --- | --- | --- |
| 200 | 无 `feedback` 会话本轮不出草案 → 200、`status=collecting`、`messages[]` 留痕、页未改（docs knowledge-base §3 末句） | pass |
| 202 | 误报登记 → `{alert_id, verdict, feedback, maintenance}` 四键齐、`verdict=false_positive` | pass |
| 400 | 缺 `content` / `content` 非字符串(number) / 空串 / 4001 字 / 含空字符 / 正文非 JSON（6 条） | pass（均 `{error:string}`） |
| 400 | `create(page, feedback)` 边界：缺 `case_id`、`expected_verdict` 非法枚举、`reason` 9 字、`who` 1 字 | pass |
| 404 | 不存在会话 → 404「知识维护会话不存在」；非 UUID 会话 ID → 404「知识库接口不存在」（openapi `SessionId` 声明 `format: uuid`，合规） | pass |
| 409 | 并发重入（独立 socket，第一轮模型延迟 500ms）→ 409「上一轮知识整理仍在进行」，第一轮随后 200 | pass |
| 502 | 三条失败路径（data_gap / criterion_gap 无草案 / 模型非 JSON）均 `{error:string}`、≤300 字、含诊断+rationale | pass |
| 502 | 1000 字 rationale → 254 字（≤300 截断生效） | pass |
| 502 | 未知诊断值 `bogus_gap` → 502 正文 49 字可读、不含 `undefined`（spec 未枚举模型侧诊断，仅记录行为） | pass |

边界同测：`WikiWorkbench.file('abc')` → 400「知识维护会话 ID 无效」（docs knowledge-base §3 `file` 行）。

## 3. Findings（doc-side，均不挡 A1/A2/A3）

### F1（minor，doc-side）502 正文「后续责任方」的无条件承诺与两支实测不符

- 出处：`docs/modules/http-api.md:172-174`、`openapi.yaml:829-834` 都写「正文 error 是失败原因原文：诊断、`rationale` 摘录与**后续责任方**，整条 ≤300 字」；`openapi.yaml:834` 另承诺会话记录里「`follow_up`、失败消息都在」。
- 文档说：三条失败路径正文都带后续责任方。
- 实测：
  - criterion_gap 无草案：`知识库维护未改判据（criterion_gap·判据缺口）：判据需要补充授权核对；判据页未改动`
  - 模型非 JSON：`知识库维护未改判据（未给诊断）：知识维护模型未返回合法 JSON，本轮无法整理；判据页未改动`
  - 两支尾部是「判据页未改动」，没有后续责任方；非 JSON 支连诊断也没有（`未给诊断`）。
- 反证方：`docs/modules/knowledge-base.md:95-97` 的口径（两支原因分别是诊断说明与 JSON 文案）与实测一致，且 criterion_gap 会话 `follow_up=null`（该诊断本就没有后续责任方）——同一份卡里两处文档互相矛盾。
- 复现：`TREE=$PWD node evidence/test/P003-T021/verify.mjs`，看 `DOC-DELTA S2b / S2c` 两行。
- 建议（二选一）：把 http-api/openapi 两处收窄成「有后续责任方时附上」，或 code 给这两支补责任方（如「后续由「判据维护人」补草案」）。
- 为什么不打回：任务卡 A2 的原文是「`needs_non_wiki_fix` 不能再被收成一句没有正文的失败」，实测三支都有正文；「后续方」是文档加码，属文档精度问题。

### F2（minor，doc-side）`replyWikiSession` 的错误面不全

- 实测：`POST /api/wiki/sessions/{id}/messages` 可达 400（6 条边界）、404（会话不存在）、409（并发）、502（失败正文）。
- 文档：`openapi.yaml:802-836` 列了 200/400/409/502，**缺 404**；`docs/modules/http-api.md:101` 路由表只写「200 / 502」。
- 建议：openapi 补 `'404': { $ref: '#/components/responses/NotFound' }`；http-api 表改成 `200 / 400 / 404 / 409 / 502`。

### 记录（非 finding）

- 非 UUID 会话 ID 回 404 而不是 400：`WikiWorkbench.file()` 类级抛 400（文档一致），HTTP 层因 `SessionId` 声明 `format: uuid` 先判路径不存在——两块文档各自成立。
- 多轮 feedback 会话的失败正文可能沿用上一轮诊断/理由（代码审查已提 nit），本轮未复测。

## 4. 门禁与变异（全部本终端亲跑）

| 命令 | 结果 |
| --- | --- |
| `node --test wiki.test.js` | EXIT=0，pass 10 / fail 0（197ms） |
| `node --test agent-api.test.js` | EXIT=0，pass 22 / fail 0 |
| `node --test *.test.js` | EXIT=1，192 tests / 191 pass / 1 fail——唯一红 `maintenance-startup.test.js`（`MODULE_NOT_FOUND .../current/backend/maintenance-server.js`） |
| `node --test $(ls *.test.js \| grep -v '^maintenance-startup')` | EXIT=0，191/191 |
| `git worktree add --detach /tmp/t021-base-mine f3a03ab` + 在 base 上跑 `node --test maintenance-startup.test.js` | EXIT=1，同一条 `MODULE_NOT_FOUND`——**既有环境/布局问题，非本卡引入**（验完已 `worktree remove`） |
| `node /tmp/t021-e2e.mjs` | EXIT=0，两支端到端输出见 §1 |
| `TREE=$PWD node evidence/test/P003-T021/verify.mjs` | EXIT=0，**PASS 31 / FAIL 0**（+ 2 条 DOC-DELTA） |
| 变异：`sed -i '264s/throw/void /' wiki-workbench.js` → 跑探针 | `git diff --numstat` = 1/1；EXIT=1，**PASS 24 / FAIL 6**：S2a/S2b/S2c/S2d 的 502 断言全红，S6 的 error 变回旧裸状态词「维护者没有产出方法论修订（会话 … 状态 needs_non_wiki_fix）」——恰是这卡要修的洞 |
| 还原：`git checkout -- wiki-workbench.js` → 再跑探针 | EXIT=0，PASS 31 / FAIL 0；`git status --short` 只剩未跟踪 `evidence/test/P003-T021/` 与 `.pi-child-claim.json` |

### 一条自爆记录

本机 `node --test`（不带参数）会递归扫 `web/test/**`、`evidence/**`（P003-T007 的 e2e 脚本跑了 179s 并重写了一张开）：那次误跑改了 `evidence/test/P003-T007/shots/1440-a5-sidebar.png`，已 `git checkout --` 还原，现树干净。后端门禁口径是 `node --test *.test.js`（写者报告同口径）。

## 5. 残余风险

1. **模型真实行为未验**：假模型验证的是本模块分支逻辑，真实模型是否稳定按 `diagnosis`/`rationale` 格式返回不在本轮范围。
2. **维护总态的 `rule` 单边**：探针里规则维护者一律抛错（本卡不改它），所以只对 `maintenance.wiki` 单边下断言；总态 `failed` 的合成规则未重复验（A3 不依赖它）。
3. **多轮 feedback 会话**：本轮只覆盖单轮（现实入口只有误报登记这一条），多轮失败正文可能引用上一轮诊断（审查 nit，未复测）。
4. **`/tmp/t021-e2e.mjs` 未进仓**：写者脚本，我本终端复跑过，但重跑依赖该临时文件存在。
