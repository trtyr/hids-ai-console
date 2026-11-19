# P003-T041 测试报告（测试席 · 何东阳）— 复审通过后的验收

- 任务卡：P003-T041 规则库与知识库外置：活数据进数据根，维护接口正式化（验收 A1–A8）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T041`，分支 `task/hids-ai-console-P003-T041`，验的是 HEAD `ec1eeb7`
- 代码审查判词：`verdicts/P003-T041-gc-backend-code-review-mwnu4sqt.json`（pass）
- 判据只取：`openapi.yaml` 的 `/api/rules*` 五条路径 + `RegoRule` / `RegoSaveResult` / `RegoHistoryEntry` / `RegoRuleHistory` / `RegoSessionSummary` / `RegoRuleWrite` / `RegoRollback` / `Error` / `Conflict` / `RuleLibraryError`、`docs/modules/http-api.md` §3.1 路由表与 §5 令牌三档、`docs/architecture.md` §7.5 / §8.1 / §8.2 / §9.2、`docs/modules/knowledge-base.md` §7.1
- **没读实现内容**（`server.js` / `rule-store.js` / `wiki-store.js` 一行没读）。起服只调文档写明的 `createServer()`（`docs/modules/http-api.md` §2：「createServer 是依赖注入点……测试与探针靠传替身换掉」），黑盒只走 HTTP + 数据根文件探针；变异用 `git show 7fe655e:<file>` 整文件替换与文档常量的字符串替换，全部在 `/tmp` 副本里做，本树实现文件零改动

## 结论

**PASS。** A1–A8 全部 satisfied，门禁全绿，变异验红亲手复现。本卡两条重点我按验收锚点逐条压过：

1. **A3 备注落盘**：PUT 带 `note` → 数据根 `rules-history/<id>-<rev>.json` 里是 `{id, rev, note, saved_at, replaced_by}`，`note = 人工维护：<note>`；`GET /api/rules/{id}/history` 逐条回读同一个 note；sidecar 删除 / 坏 JSON / note 非字符串 → 该条 `note` 读作 `null` 且接口照旧 200；回滚把被替换那版标成 `人工回滚（<who>）`；同一版归档第二次保留第一次备注、历史不重复记。
2. **A5 并发**：两个 PUT 同 `expected_revision` → `[200, 409]`；五个并发 → 1 成 4 冲突；两个并发新增同一 id → 1 成 1 冲突且只落一个文件；PUT 与回滚并发 → 无 5xx、历史条数与成功次数相等、无重复 rev。旧实现（`7fe655e`）下这两条恰红（实测 `[200, 200]`、`note: undefined`）。

两条 minor 不阻塞（都是口径/既有文档面，不是本卡引入的行为违约），见 §五。

## 一、方法与边界

- 测试文件：`evidence/test/P003-T041/http-contract.test.js` + `tester-boot-server.mjs`（测试席自写，13 条）。
- 每个用例起一个真 `node` 进程（独立 `HIDS_DATA_DIR`、独立模块级装配），跑完 `SIGKILL` 回收；断言只碰 HTTP 响应与数据根文件（`rules/`、`rules-history/`、`rule-sessions/`、`wiki/`、`wiki-history/`），以及仓内 `rules/`、`wiki/` 的全量内容摘要（sha256 逐文件）。
- 仓内副本「没被写」用**文件名 + 内容 sha256 前后逐条比对**钉住——只比文件名抓不到原地改写。
- 响应形状逐字段断言：列表不带 `revision`；`RegoSaveResult` 六个键、历史条目六个键、错误体 `{error, code}` 四类 code。

## 二、验收逐条

| 锚点 | 我验的 | 结果 | 证据（都在本终端跑出来） |
| --- | --- | --- | --- |
| A1 运行期读写全走数据根，仓内 `rules/`、`wiki/` 不被写 | 缺省数据根下 `rules/` 种出三份且与仓内逐字节一致；`/api/rules` 200 `{count:3}` 按 id 排序；`/api/wiki/pages` 200 且页面来自 `<数据根>/wiki`；全程仓内 `rules/`、`wiki/` 摘要不变 | satisfied | `http-contract.test.js:103`（A1 用例）；`tester-http-contract.txt` 13/0 |
| A2 种子只初始化一次，此后变更只在数据根 | 改完规则 → 二次启动仍读改过的正文、历史不丢、count 仍 3；另建「`rules/` 目录在但空」的数据根 → `{count:0, rules:[]}` 不重种 | satisfied | `http-contract.test.js:147`、`:169` |
| A3 版本化 + 备注落盘 | 正文副本 `<id>-<rev>.rego` 逐字等于旧版；sidecar 五字段；`history()` 回 note；缺失/坏 JSON → null；`unchanged` 不刷历史；回滚的 `who` 进被替换那版备注；重复归档保留首次备注 | satisfied | `http-contract.test.js:180`、`:244`；`rule-store.js:292/305`（审查判词同口径） |
| A4 维护会话留痕（数据根可查） | 数据根 `rule-sessions/` 里两份记录 → `/api/rules/sessions` 按 `updated_at` 倒序列出、摘要八字段齐全、状态枚举合法、响应里没有规则正文与误报理由原文；空目录回 `{sessions:[]}`；`sessions` 是合法规则 id 也不会被 `/api/rules/{id}` 抢走 | satisfied（摘要面 + 写者单测那 4 条我亲手跑了绿） | `http-contract.test.js:434`；`tester-writer-suite.txt` 22/0 |
| A5 维护接口正式化 + 同一套写队列 | 列表/读/改/历史/回滚五条路径的合法请求各至少一次；`PUT` 与维护者走同一 `RuleStore.save()`（结构查：`ruleStore.save(` 在 `server.js` 两处，`writeRuleFile`/`validateRego` 无函数定义）；并发四种组合见结论 | satisfied | `http-contract.test.js:274`、`:370`、`:400`、`:434`；`grep -n "writeRuleFile\|validateRego" server.js rule-store.js` |
| A6 知识库沿用接口、写路径落外置库 | `GET /api/wiki/pages`、`GET/PUT page`、`GET /api/wiki/sessions`（403 无令牌 / 200 带令牌）都通；写落 `<数据根>/wiki/`、旧版进 `<数据根>/wiki-history/HP-01-<rev>.md`、数据根 `log.md` 记账；仓内 `wiki/` 摘要不变；二次启动读到改过的页 | satisfied | `http-contract.test.js:473` |
| A7 文档同步 | `openapi.yaml` 43 条 path、四条维护路由与 `PUT` 在册、`RegoHistoryEntry.required` 含 `note` 且类型 `[string,'null']`、`Conflict` 在册；http-api 路由表三行在；architecture 写 `<数据根>/rules/`、`rule-sessions`；`规则库跟着代码走` 旧口径 0 命中 | satisfied | `tester-a7-contract.txt`；`http-contract.test.js:561` |
| A8 替身全链 | 改一条（PUT+note）→ 数据根正文变 → 历史有副本与备注 → 回滚恢复原正文且被替换版进历史带 `人工回滚（值班主任）` → 再回滚回去历史不重复记 → 重启后正文与两条历史都在，仓内 `rules/` 不变 | satisfied | `http-contract.test.js:517` |

错误码覆盖（每条都断言了响应体形状，不只状态码）：400（id 不合格式×3、正文非对象×2、缺 `rego`/缺 `expected_revision`、空 `rego`、`rev` 不合格式、缺 `rev`、包名不符、子集外语法带 `<id>.rego:<行>`）、403（令牌不对 / 没带，PUT 与回滚各一次）、404（规则不存在、历史里没这版、回滚不存在的规则）、409（`expected_revision` 过期且正文提示刷新、对已存在的 id 传 `expected_revision:null`）、502（数据根规则文件缺 `# name:` → 列表 / 读 / 求值都 `upstream_error` 且带 `rules/<文件>:<行>`，还原后回 200）、503（没配 `HIDS_RULE_ADMIN_TOKEN` 起进程 → PUT 与回滚都 `not_configured`）。

## 三、门禁（每一条都是我在这个终端亲手跑的，没有转录任何人）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 测试席本卡套件 | `timeout 200 node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/http-contract.test.js` | `ℹ tests 13 / pass 13 / fail 0`，1.6s，**exit 0**；连跑 3 遍全 13/0（无 flake） |
| 本卡整套（写者 22 + 测试席 13） | `timeout 240 node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/*.test.js` | `ℹ tests 35 / pass 35 / fail 0`，1.9s，**exit 0** |
| 写者套件单跑（复核 22 条的来源） | `timeout 200 node --test ... evidence/test/P003-T041/acceptance.test.js evidence/test/P003-T041/rule-library.test.js` | `pass 22 / fail 0`，0.51s，**exit 0** |
| 后端全量 | `timeout 300 npm test` | `ℹ tests 228 / pass 228 / fail 0`，0.85s，**exit 0** |
| 钉子（T034 数据根三种历史 + T019 九条路径） | `timeout 120 node --test --test-force-exit evidence/test/P003-T034/data-root.test.js evidence/test/P003-T019/data-dir.test.js` | `pass 16 / fail 0`，118ms，**exit 0** |
| 邻居卡（T020 + T013） | `timeout 200 node --test ... evidence/test/P003-T020/*.test.js evidence/test/P003-T013/acceptance.test.js` | `pass 24 / fail 0` + 唯一 ⚠ = `T013:648 who 101 字（待定口径）`，与上轮申报一致，没多出新的 |

**两套口径别混**：`package.json` 的 `npm test` glob 只扫根目录 `*.test.js`（228 条不含 `evidence/test/` 子目录）；本卡套件必须单跑，混读会把 228 当成本卡数。

## 四、变异验红（亲手做，不是引用别人）

**变异 1——换回旧实现（真跑，不是模拟）**：

```
$ mkdir /tmp/t041-mut-old && git archive ec1eeb7 | tar -x -C /tmp/t041-mut-old
$ for f in rule-store.js server.js wiki-store.js; do git show 7fe655e:$f > /tmp/t041-mut-old/$f; done
$ cd /tmp/t041-mut-old && node --test ... evidence/test/P003-T041/http-contract.test.js
ℹ tests 13 / pass 8 / fail 5   EXIT=1
✖ A3 备注落盘…            （history note: undefined）
✖ A3 缺失/坏 JSON…        （第一条就红：sidecar 没落盘）
✖ A5 并发 PUT…            （响应实测 [200,200]——后写盖前写）
✖ A5 并发新增/回滚…       （响应实测 [200,200]）
✖ A8 全链…                （历史 note undefined）
其余 8 条绿（A1/A2/A6/A7 与本轮修复无关，照旧）
```

红点正落在验收锚点 A3/A5/A8 上，说明这几条断言不是永真。

**变异 2——锚点字符串（删/改锚词 → 守卫恰红）**：

```
$ cd /tmp/t041-mut（ec1eeb7 副本）
$ sed -i 's/人工维护：/人工维护:/g; s/人工回滚（/人工回滚(/g' server.js      # 全角冒号/括号改成半角
$ node --test ... evidence/test/P003-T041/http-contract.test.js
ℹ tests 13 / pass 10 / fail 3   EXIT=1
✖ A3 备注落盘… / ✖ A3 缺失·坏 sidecar… / ✖ A8 全链…
（A5 并发两条、A1/A2/A6/A7 照旧绿——说明注备断言只钉备注，不是靠别的行为顺带绿）
```

**还原复绿**：变异只在 `/tmp` 副本里发生；本树实现文件 `git diff ec1eeb7 -- server.js rule-store.js wiki-store.js` 空（下面 §七 贴了 `git status`），还原后我在本树连跑 3 遍 13/0、整套 35/0。

## 五、发现（2 条 minor，不阻塞；都带复现）

### minor-1 `note` 超 openapi `maxLength: 200` 不拒也不截断（与 T013:648 同类，待定口径）

- 文档说：`openapi.yaml` `RegoRuleWrite.properties.note.maxLength: 200`（我 `yaml.safe_load` 读出来核过，见 `tester-a7-contract.txt`）。
- 实测：`note` 给 201 个「备」→ **PUT 回 200**；`rules-history/<id>-<rev>.json` 与 `GET history` 里 `note` 长度 **205**（`人工维护：` + 201），没拒也没截。
- 复现：

```
$ D=$(mktemp -d); HIDS_DATA_DIR=$D HIDS_RULE_ADMIN_TOKEN=t node evidence/test/P003-T041/tester-boot-server.mjs &
# 取 revision 后：
$ curl -s -X PUT -H 'content-type: application/json' -H 'x-rule-admin-token: t' \
    -d '{"rego":"...","expected_revision":"<rev>","note":"备×201"}' http://127.0.0.1:<port>/api/rules/honeypot_probe
→ 200 {"action":"update",...}；随后 GET .../history → note 长 205
```

- 处置建议：要么服务端按 400 拒（`maxLength` 属请求 schema），要么 openapi 把上限改成与实现一致。属**口径待定**（T013:648 是同一类），不据此判本卡 fail。

### minor-2 `PUT /api/wiki/pages/{path}` 不带知识库管理员令牌也回 200（文档口径不符，既有、非本卡引入）

- 文档说：`docs/modules/http-api.md:398`——`/api/wiki/` 底下「别的路径」会先撞令牌判定（两个读接口除外）。
- 实测：不带 `x-prompt-admin-token` 的 `PUT /api/wiki/pages/honeypot%2FHP-01.md` 回 **200**，页面被写进数据根库。
- 既有性：`git archive ec5e5de`（本卡起活前）起旧进程探同一请求，同样 **200**（带错令牌才 409「知识库页面已更新」）。所以不是本卡引入，是那条文档句子一直写宽了。
- 建议：把 `http-api.md:398` 那句改成「两个读接口与页面 PUT 都排在令牌判定之前」；或在 openapi 里补 `PUT /api/wiki/pages/{pagePath}`（现在 openapi 里**没有**这条路径，而 `http-api.md:552` 与 `knowledge-base.md:358` 都在讲它的行为）——两条都属后续文档卡，不该由本卡背。

## 六、残余风险

1. **A4 的「每次维护落一份会话」我只验到黑盒可达的那半**：起真进程没有模型，触发不了维护者 Agent 真跑一轮；会话摘要面（字段/倒序/不漏正文）我黑盒验了，写者的 A4 两条（假模型全链、失败留痕）我在本终端亲手跑绿。仍有残余：真模型下的会话内容质量没人能在这条线验。
2. 并发只测**同一进程内**（真实部署也是单进程）；docs 没承诺跨进程串行，跨进程并发写同一数据根没测。
3. 权限级文件故障（`EACCES` 读备注上抛 → 502）没造，审查判词已把它记成 nit。
4. `note`/`who` 的 schema 上界（200/100）都属 minor-1 那类待定口径，`who` 101 已由 T013:648 挂着。
5. A6 只验了知识库**页面**这条写路径；会话/发布链路（`/api/wiki/sessions/*`）只验到鉴权与列表形状，发布流程要模型，归 T013 的既有覆盖。

## 七、复跑命令与工作树状态

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T041
node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/http-contract.test.js   # 13/0
node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/*.test.js              # 35/0
npm test                                                                                          # 228/0
node --test --test-force-exit evidence/test/P003-T034/data-root.test.js evidence/test/P003-T019/data-dir.test.js  # 16/0
```

```
$ git log --oneline -2
fe01c88 test(P003-T041): 测试席黑盒验收——HTTP 契约 13 条 + 门禁/变异证据 + 报告（PASS，两条 minor 不阻塞）
ec1eeb7 fix(rules): P003-T041 复审——note/who 落历史备注（sidecar）、写队列串行与 409、四处 minor
$ git show --stat HEAD | tail -3
 11 files changed, 1734 insertions(+)        # 只有测试席产物，没有实现文件

$ git status --short
 D .pi-child-claim.json
MM rule-store.js
MM server.js
MM wiki-store.js
```

上表后三行 `MM` 是**起验前就存在**的索引/工作树分叉（我是从 git status 看到它的第一眼就查过，不是这轮造成的）：`git hash-object` 三个文件与 `git rev-parse ec1eeb7:<file>` 逐个相同，即**工作树内容等于 ec1eeb7**，变的只是 index 里的旧 blob。我的验收是在「工作树 = ec1eeb7」这个事实上跑的；测试产物单独一个提交，`git show --stat HEAD` 里没有任何实现文件。

## 八、产物清单（本报告目录）

| 文件 | 是什么 |
| --- | --- |
| `http-contract.test.js` | 测试席黑盒套件（13 条，A1–A8） |
| `tester-boot-server.mjs` | 起服助手（零参 `createServer()`，端口打 stdout） |
| `tester-http-contract.txt` | 本树 13/0 的完整输出 |
| `tester-writer-suite.txt` | 写者 22 条的完整输出（复核用） |
| `tester-npm-test.txt` | `npm test` 228 条的完整输出 |
| `tester-pin-tests.txt` | T034 + T019 钉子 16 条的完整输出 |
| `tester-neighbor-notes.txt` | T020 + T013 邻居卡输出（含已知 ⚠） |
| `tester-a7-contract.txt` | openapi YAML 解析 / 43 条 path / schema 字段 / docs greps |
| `tester-mutation-old-impl.txt` | 变异 1：`7fe655e` 三文件换进 `/tmp` 副本 → 5 条恰红 |
| `tester-mutation-note-prefix.txt` | 变异 2：备注前缀改半角 → 3 条恰红 |
