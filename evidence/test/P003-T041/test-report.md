# P003-T041 测试报告（测试席 · 何东阳）— 测试审计打回后的修复轮

- 任务卡：P003-T041 规则库与知识库外置：活数据进数据根，维护接口正式化（验收 A1–A8）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T041`，分支 `task/hids-ai-console-P003-T041`
- 被测实现：HEAD `ec1eeb7`（三个实现文件 `hash-object` 与该提交逐一对上，见 §八；本轮一行没动）
- 上一轮：测试审计曾判 `reject_test`（`P003-T041-gc-backend-test-review-mwnuj9g9.json`），本轮只改**测试席自己的套件与报告**，并把审计的一条 major、三条 minor 全部处置（§五）
- 判据只取：`openapi.yaml` 的 `/api/rules*` 五条路径 + `RegoRule` / `RegoSaveResult` / `RegoHistoryEntry` / `RegoRuleHistory` / `RegoSessionSummary` / `RegoRuleWrite` / `RegoRollback` / `Error` / `Conflict` / `RuleLibraryError`、`docs/modules/http-api.md` §3.1 路由表与 §5 令牌三档、`docs/architecture.md` §7.5 / §8.1 / §8.2 / §9.2、`docs/modules/knowledge-base.md` §7.1
- **没读实现内容**（`server.js` / `rule-store.js` / `wiki-store.js` 一行没读）。起服只调文档写明的 `createServer()`（`docs/modules/http-api.md` §2），黑盒只走 HTTP + 数据根文件探针；变异与「断言有没有牙」全在 `/tmp` 副本里做，本树实现文件零改动

## 结论

**PASS。** A1–A8 全部 satisfied，门禁全绿，变异与断言自检亲手复现。

本轮重点是审计打回的那条：A5「PUT 与回滚同队列」原先依赖请求到达顺序（回滚先到按 openapi 回 404 也合法），已改成**两种到达顺序各钉一遍 + 真并发只断顺序无关性质**，并且回滚目标先落进历史；审计当时的 20ms 延迟注入手法复跑现在是绿的（4 种注入全 13/0，§三）。三条 minor 全改（§五）。

## 一、方法与边界

- 测试文件：`evidence/test/P003-T041/http-contract.test.js` + `tester-boot-server.mjs`（测试席自写，仍 13 条）。
- 每个用例起一个真 `node` 进程（独立 `HIDS_DATA_DIR`、独立模块级装配），跑完 `SIGKILL` 回收；回收钩子在 `spawn` 后立刻注册，起服失败也不漏进程（审计顺手提的那条一并改了）。
- 断言只碰 HTTP 响应与数据根文件（`rules/`、`rules-history/`、`rule-sessions/`、`wiki/`、`wiki-history/`），以及仓内 `rules/`、`wiki/` 的全量内容摘要（sha256 逐文件）。
- 新增一个黑盒手法：**慢 body 的 PUT**（`http-contract.test.js:106`）——先发请求头和一小截正文就停手，服务端卡在读 body、一定还没进写队列；这时发回滚就能把「谁先到」钉死，不靠 sleep 猜调度。

## 二、验收逐条

| 锚点 | 我验的 | 结果 | 证据（都在本终端跑出来） |
| --- | --- | --- | --- |
| A1 运行期读写全走数据根，仓内 `rules/`、`wiki/` 不被写 | 缺省数据根下 `rules/` 种出三份且与仓内逐字节一致；`/api/rules` 200 `{count:3}` 按 id 排序；`/api/wiki/pages` 200 且页面来自 `<数据根>/wiki`；全程仓内 `rules/`、`wiki/` 摘要不变 | satisfied | `http-contract.test.js:171`；`tester-http-contract.txt` 13/0 |
| A2 种子只初始化一次，此后变更只在数据根 | 改完规则 → 二次启动仍读改过的正文、历史不丢、count 仍 3；另建「`rules/` 目录在但空」的数据根 → `{count:0, rules:[]}` 不重种 | satisfied | `http-contract.test.js:215`、`:237` |
| A3 版本化 + 备注落盘 | 正文副本 `<id>-<rev>.rego` 逐字等于旧版；sidecar 五字段；`history()` 回 note；缺失/坏 JSON → null；`unchanged` 不刷历史；回滚的 `who` 进被替换那版备注；重复归档保留首次备注 | satisfied | `http-contract.test.js:248`、`:312`；变异 1 下 `note: undefined` 恰红 |
| A4 维护会话留痕（数据根可查） | 数据根 `rule-sessions/` 两份按 architecture §7.5 真形制的记录（含 `proposal{id,rego,rationale}` 与 `validation.ok`）→ `/api/rules/sessions` 按 `updated_at` 倒序列出、八字段齐全、状态枚举合法；**`validation.ok=true` → `validated===true`，`validation.ok=false` → `validated===false`**（上一轮夹具缺 `validation.ok`，读成 false 也没被发现）；响应里没有规则正文与误报理由原文；`sessions` 是合法规则 id 也不会被 `/api/rules/{id}` 抢走 | satisfied（摘要面 + 写者单测那 4 条我亲手跑了绿） | `http-contract.test.js:550`；断真值有牙见 `tester-assertion-teeth.txt` 牙 1（夹具改 false → 恰红）；`tester-writer-suite.txt` 22/0 |
| A5 维护接口正式化 + 同一套写队列 | 列表/读/改/历史/回滚五条路径的合法请求各至少一次；`PUT` 与维护者走同一 `RuleStore.save()`（结构查：`ruleStore.save(` 在 `server.js` 两处，`writeRuleFile`/`validateRego` 无函数定义）；并发：两 PUT 200/409、五并发 1 成 4 冲突、并发新增只成一；**PUT 与回滚**：回滚目标先钉进历史，顺序一「PUT 先到」两 200，顺序二「回滚先到」由慢 body 钉死 → 回滚 200、放行 PUT 恰 409（Conflict 形状），真并发只断与顺序无关性质（§五） | satisfied | `http-contract.test.js:441`、`:471`、`:550`；`grep -n "writeRuleFile\|validateRego" server.js rule-store.js` |
| A6 知识库沿用接口、写路径落外置库 | `GET /api/wiki/pages`、`GET/PUT page`、`GET /api/wiki/sessions`（403 无令牌 / 200 带令牌）都通；写落 `<数据根>/wiki/`、旧版进 `<数据根>/wiki-history/HP-01-<rev>.md`、数据根 `log.md` 记账；仓内 `wiki/` 摘要不变；二次启动读到改过的页 | satisfied | `http-contract.test.js:597` |
| A7 文档同步 | `openapi.yaml` 43 条 path、四条维护路由与 `PUT` 在册、`RegoHistoryEntry.required` 含 `note` 且类型 `[string,'null']`、`RegoSessionSummary.required` 含 `validated`（boolean）、`Conflict` 在册；http-api 路由表三行在；architecture 写 `<数据根>/rules/`、`rule-sessions`；`规则库跟着代码走` 旧口径 0 命中 | satisfied | `tester-a7-contract.txt`；`http-contract.test.js:685` |
| A8 替身全链 | 改一条（PUT+note）→ 数据根正文变 → 历史有副本与备注 → 回滚恢复原正文且被替换版进历史带 `人工回滚（值班主任）` → 再回滚回去历史不重复记 → 重启后正文与两条历史都在，仓内 `rules/` 不变 | satisfied | `http-contract.test.js:641` |

错误码覆盖（每条都断言了响应体形状，不只状态码）：400（id 不合格式×3、正文非对象×2、缺 `rego`/缺 `expected_revision`、空 `rego`、`rev` 不合格式、缺 `rev`、包名不符、子集外语法带 `<id>.rego:<行>`）、403（令牌不对 / 没带，PUT 与回滚各一次）、404（规则不存在、历史里没这版、回滚不存在的规则）、409（`expected_revision` 过期且正文是非空 `error`、对已存在的 id 传 `expected_revision:null`）、502（数据根规则文件缺 `# name:` → 列表 / 读 / 求值都 `upstream_error` 且带 `rules/<文件>:<行>`，还原后回 200）、503（没配 `HIDS_RULE_ADMIN_TOKEN` 起进程 → PUT 与回滚都 `not_configured`）。

## 三、门禁（每一条都是我在这个终端亲手跑的，没有转录任何人）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 测试席本卡套件 | `timeout 200 node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/http-contract.test.js` | `ℹ tests 13 / pass 13 / fail 0`，1.7s，**exit 0**；另**连跑 10 遍全 13/0**（`tester-http-contract.txt` 尾部） |
| 时序注入（复跑审计打回手法） | `JITTER_METHOD=PUT JITTER_MS=20 node --import /tmp/t041-jitter/jitter.mjs --test ... http-contract.test.js`，另 PUT/100ms、POST/20ms、POST/100ms | 四种注入全 `13 pass / 0 fail`、**exit 0**（`tester-jitter.txt`）——审计当时 PUT+20ms 得到的那条 `1 fail：[200,404]` 已不复现 |
| 本卡整套（写者 22 + 测试席 13） | `timeout 240 node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/*.test.js` | `ℹ tests 35 / pass 35 / fail 0`，**exit 0** |
| 写者套件单跑（复核 22 条的来源） | `timeout 200 node --test ... acceptance.test.js rule-library.test.js` | `pass 22 / fail 0`，**exit 0**（`tester-writer-suite.txt`） |
| 后端全量 | `timeout 300 npm test` | `ℹ tests 228 / pass 228 / fail 0`，**exit 0**（`tester-npm-test.txt`） |
| 钉子（T034 数据根三种历史 + T019 九条路径） | `timeout 120 node --test --test-force-exit evidence/test/P003-T034/data-root.test.js evidence/test/P003-T019/data-dir.test.js` | `pass 16 / fail 0`，**exit 0**（`tester-pin-tests.txt`） |
| 邻居卡（T020 + T013） | `timeout 240 node --test ... evidence/test/P003-T020/*.test.js evidence/test/P003-T013/acceptance.test.js` | `pass 24 / fail 0 + todo 1`，**exit 0**；唯一 ⚠ 仍是 `T013:648 who 101 字（待定口径）`，与上轮申报一致（`tester-neighbor-notes.txt`） |

**两套口径别混**：`package.json` 的 `npm test` glob 只扫根目录 `*.test.js`（228 条不含 `evidence/test/` 子目录）；本卡套件必须单跑。

## 四、变异验红与「断言有没有牙」（亲手做，不是引用别人）

**变异 1——换回旧实现（真跑，不是模拟）**：`git archive ec1eeb7` 到 `/tmp/t041-mut-new`，再把 `7fe655e` 的 `rule-store.js`/`server.js`/`wiki-store.js` 换进去，跑**本轮的新测试文件**：

```
ℹ tests 13 / pass 8 / fail 5   EXIT=1
✖ A3 备注落盘…            （history note: undefined）
✖ A3 缺失/坏 JSON…        （第一条就红：sidecar 没落盘）
✖ A5 并发：同一 expected_revision…   （实测 [200,200]——后写盖前写）
✖ A5 并发：新增规则的两路写…         （实测 [200,200]；PUT+回滚那条同用例里一起红）
✖ A8 全链…                （历史 note undefined）
其余 8 条绿（A1/A2/A6/A7 与本轮修复无关，照旧）
```
完整输出：`tester-mutation-old-impl.txt`。**注意**：新写的「回滚先到」慢 body 用例在无队列的旧实现上也能出 409（它钉的是到达顺序语义），真正抓回归的是同文件里 [200,200] 那几条——所以两条都留着。

**变异 2——锚点字符串（全角冒号/括号改半角）**：`/tmp/t041-mut2` 的 `server.js` 上 `s/人工维护：/人工维护:/g; s/人工回滚（/人工回滚(/g`：

```
ℹ tests 13 / pass 10 / fail 3   EXIT=1
✖ A3 备注落盘… / ✖ A3 缺失·坏 sidecar… / ✖ A8 全链…
```
完整输出：`tester-mutation-note-prefix.txt`。

**断言有没有牙（新加，防「永真」）**：只改测试自己的输入，看断言是否恰红，全在 `/tmp/t041-teeth` 副本里做：

1. A4 夹具 `validation.ok` 由 true 改 false → 红在 `validation.ok=true 的会话摘要 validated 应为 true`；
2. 慢 body PUT 改带「回滚后的当前版」当 `expected_revision` → PUT 实测 200，红在 `回滚先到后放行的 PUT 应 409（Conflict），实测 200`。

完整输出：`tester-assertion-teeth.txt`。**还原复绿**：两个副本都没回本树，本树实现文件 `hash-object` 仍等于 `ec1eeb7`（§八），还原后在本树连跑 13/0 ×10。

## 五、审计打回的处置（一条 major + 三条 minor + 一条顺手）

### major：PUT+回滚用例依赖到达顺序（审计判 `reject_test` 的主因）

- 审计说：回滚的 `rev` 取的是当前版、还没进历史，回滚先到按 openapi「历史里没有这一版回 404」是合法结果；`:424` 只认 200/409，注入 20ms 延迟就红 `[200,404]`。
- 我怎么改（`http-contract.test.js:471` 起）：
  1. **回滚目标先钉进历史**：先 PUT 一次把 `r0` 归档，回滚目标一定存在（404 这条合法分支从根上排除）；
  2. **顺序一「PUT 先到」**：依次 PUT → 回滚，两个都 200，终态=回滚目标；
  3. **顺序二「回滚先到」**：慢 body 把 PUT 钉在读 body 阶段（**一定还没进写队列**），回滚确定性地先完成 200；放行 PUT → 它带的 `expected_revision` 已作废，**断 409 + `code=caller_error` + 非空 `error`**，并断回滚已把当时那版归档；
  4. **真并发**只断与顺序无关的性质：无 5xx、状态 ∈ {200,409}、历史增量 === 成功写次数、历史无重复 rev、终态落在回滚目标（有写队列时两种合法次序的终态都是回滚目标，所以这条能断死）。
- 证据：审计的 20ms 注入手法恢复绿（`tester-jitter.txt`，4 种注入 13/0）；顺序二不是永真（`tester-assertion-teeth.txt` 牙 2）。

### minor-1：报告把「静默截断」写成了「不拒也不截」

- 已改成与实测一致：`note` 超 `maxLength: 200` **不拒、静默截断到 200**，加「人工维护：」前缀后历史 `note` 共 **205 字**。
- 实测（`tester-note-truncation.txt`）：200 / 201 / 300 字三档 PUT 全 200，`GET history` 回来的 `note` 全是 205 字。
- 是否改成 400 或把 openapi 上限改成与实现一致，仍按 **T013:648 同类待定口径**上报群主，测试不替它选（用例只断「不 5xx」并记实测）。

### minor-2：`:304` 断包名错误的措辞，超出 openapi

- 已收回：只断 400 + `code=caller_error` + 非空 `error`，不再匹配 `/package|包名/`（openapi 只承诺「包名须与 id 一致，否则回 400」，没约定措辞）。
- 同理没动的边界：409 那条仍断 `/已更新|刷新/`——那是因为 `Conflict` 响应在 openapi 里写了例话「如『规则已更新，请刷新后再提交』」，措辞有出处；如果群主要把它也当「只是例子」，这条可以再收。

### minor-3：A4 夹具缺 `validation.ok`，`validated` 读成 false 也没被发现

- 已改：夹具按 `docs/architecture.md` §7.5 的真形制造 `{…, proposal{id,rego,rationale}, validation:{ok:true|false}}`，两份分别断言 `validated===true` / `validated===false`（`http-contract.test.js:550`）。
- 牙：把夹具 `ok:true` 改 `false` → 恰红（`tester-assertion-teeth.txt` 牙 1）。

### 顺手：`boot()` 的回收钩子注册太晚

- 已挪到 `spawn` 之后立刻注册：端口解析超时 / 提前退出时也收得掉子进程（审计 `notes` 里的非阻塞提醒）。

## 六、发现（2 条 minor，不阻塞；都带复现）

### minor-1 `note` 超 openapi `maxLength: 200` 不拒、静默截断到 200（与 T013:648 同类，待定口径）

- 文档说：`openapi.yaml` `RegoRuleWrite.properties.note.maxLength: 200`（`tester-a7-contract.txt` 解析核过）。
- 实测：`note` 给 201 个「备」→ **PUT 回 200**；历史 `note` 长 **205 字**＝「人工维护：」5 字 + 截断后的 200；200 / 300 字两档同测也是 205，**不拒、静默截断到 200**。
- 复现：`tester-note-truncation.txt`（内附完整探针源，只走 HTTP）。
- 处置建议：要么服务端按 400 拒（`maxLength` 属请求 schema），要么 openapi 把上限改成与实现一致。属**口径待定**（T013:648 是同一类），不据此判本卡 fail。

### minor-2 `PUT /api/wiki/pages/{path}` 不带知识库管理员令牌也回 200（文档口径不符，既有、非本卡引入）

- 文档说：`docs/modules/http-api.md:398`——`/api/wiki/` 底下「别的路径」会先撞令牌判定（两个读接口除外）。
- 实测：不带 `x-prompt-admin-token` 的 `PUT /api/wiki/pages/honeypot%2FHP-01.md` 回 **200**，页面被写进数据根库。
- 既有性：`git archive ec5e5de`（本卡起活前）起旧进程探同一请求，同样 **200**（带错令牌才 409「知识库页面已更新」）。不是本卡引入，是那条文档句子一直写宽了。
- 建议：把 `http-api.md:398` 那句改成「两个读接口与页面 PUT 都排在令牌判定之前」；或在 openapi 里补 `PUT /api/wiki/pages/{pagePath}`——两条都属后续文档卡，不该由本卡背。

## 七、残余风险

1. **A4 的「每次维护落一份会话」只验到黑盒可达的摘要面**：起真进程没有模型，触发不了维护者 Agent 真跑一轮；会话摘要面（字段/倒序/不漏正文/`validation.ok` 真值）我黑盒验了，写者的 A4 两条（假模型全链、失败留痕）我在本终端亲手跑绿。真模型下的会话内容质量没人能在这条线验。
2. **会话文件里「模型草案」的键名文档没钉死**（`architecture.md` §7.5 只写「模型草案（id/rego/rationale）」，没写外层键名）。所以摘要的 `rule_id` 我只断键存在、不断值（实测由 `proposal.id` 驱动，但那是从 wiki-sessions 同形制推断的）；要断值得先在契约里把键名写死——属 doc-side。
3. 并发只测**同一进程内**（真实部署也是单进程）；docs 没承诺跨进程串行，跨进程并发写同一数据根没测。
4. 「真并发」那条的历史增量断言依赖「每次成功写的前一版都还没归档过」——用例特意让前一版都是新版本；若将来回滚/重复归档的去重语义变了，这条要跟着看。
5. 权限级文件故障（`EACCES` 读备注上抛 → 502）没造，审查判词已把它记成 nit。
6. A6 只验了知识库**页面**这条写路径；会话/发布链路（`/api/wiki/sessions/*`）只验到鉴权与列表形状，发布流程要模型，归 T013 的既有覆盖。

## 八、复跑命令与工作树状态

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T041
node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/http-contract.test.js   # 13/0
node --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/*.test.js              # 35/0
npm test                                                                                          # 228/0
node --test --test-force-exit evidence/test/P003-T034/data-root.test.js evidence/test/P003-T019/data-dir.test.js  # 16/0
# 复跑审计的时序注入（任选其一，全绿）：
JITTER_METHOD=PUT JITTER_MS=20 node --import /tmp/t041-jitter/jitter.mjs --test --test-force-exit --test-timeout=60000 evidence/test/P003-T041/http-contract.test.js
```

```
$ for f in rule-store.js server.js wiki-store.js; do printf '%s worktree=%s ec1eeb7=%s\n' "$f" "$(git hash-object $f)" "$(git rev-parse ec1eeb7:$f)"; done
rule-store.js worktree=0af3ec610843326bb58dc1b5d4c43a1ccdc71f75 ec1eeb7=0af3ec610843326bb58dc1b5d4c43a1ccdc71f75
server.js    worktree=0547edaf81a955550b11db12b8abcedc95fb6249 ec1eeb7=0547edaf81a955550b11db12b8abcedc95fb6249
wiki-store.js worktree=9e870a918e295db73d48615cae7c8a8168ffd278 ec1eeb7=9e870a918e295db73d48615cae7c8a8168ffd278
```

即**工作树里的实现内容就是 ec1eeb7**，本轮验收在这个事实上跑；测试产物单独一个提交，`git show --stat HEAD` 里没有任何实现文件。工作树里 `MM rule-store.js / server.js / wiki-store.js` 是起验前就存在的索引/工作树分叉（工作树 blob 等于 `ec1eeb7`，变的是 index 里的旧 blob），不是本轮造成的。

## 九、产物清单（本报告目录）

| 文件 | 是什么 |
| --- | --- |
| `http-contract.test.js` | 测试席黑盒套件（13 条，A1–A8；含慢 body 钉到达顺序的并发用例） |
| `tester-boot-server.mjs` | 起服助手（零参 `createServer()`，端口打 stdout） |
| `tester-http-contract.txt` | 本树 13/0 的完整输出 + 连跑 10 遍 |
| `tester-jitter.txt` | 时序注入复跑（PUT/POST × 20/100ms，全 13/0） |
| `tester-assertion-teeth.txt` | 断言自检：两处改输入恰红（A4 validated / 回滚先到 409） |
| `tester-mutation-old-impl.txt` | 变异 1：`7fe655e` 三文件换进 /tmp 副本 → 5 条恰红 |
| `tester-mutation-note-prefix.txt` | 变异 2：备注前缀改半角 → 3 条恰红 |
| `tester-note-truncation.txt` | minor-1 复测量（200/201/300 三档 → 全 205 字）+ 探针源 |
| `tester-writer-suite.txt` | 写者 22 条的完整输出（复核用） |
| `tester-npm-test.txt` | `npm test` 228 条的完整输出 |
| `tester-pin-tests.txt` | T034 + T019 钉子 16 条的完整输出 |
| `tester-neighbor-notes.txt` | T020 + T013 邻居卡输出（含已知 ⚠） |
| `tester-a7-contract.txt` | openapi YAML 解析 / 43 条 path / schema 字段 / docs greps |
