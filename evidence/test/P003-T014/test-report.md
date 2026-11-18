# P003-T014 后端测试报告（黑盒）

- 卡片：P003-T014「溯源列表与往回的链」（M6，后端）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T014`
- HEAD：`2ff6322`（本轮只动 `docs/modules/trace-board.md`、`coding-reports/P003-T014.md`、`evidence/recon/P003-T014.md`，产品代码零 diff）
- 席位：gc-backend-tester（何东阳）
- 自建用例：`evidence/test/P003-T014/acceptance.test.js`（只按 docs/modules/trace-board.md、docs/modules/http-api.md、
  docs/modules/evidence-tools.md、docs/modules/triage-pipeline.md 与 openapi.yaml trace 段写，不读实现文件）

## 一、结论

**行为面全绿，文档锚点有 7 处（8 个引用）差 1–2 行，列 minor。**

- 卡片四条验收（A1 已有即返回 / A2 列表筛选分页 / A3 链方向与断点 / A4 复用分析证据）**自己的 e2e 全部实测通过**，含正反两面。
- 派活锚点 A1（107 个去重锚点）计数成立；但「全落位」不成立：8 个引用落在相邻行（详见第四节）。
- 派活锚点 A7（40/40）成立，连跑两遍都是 40/40、exit 0。
- 全量套件 180 条里 179 pass、1 fail，唯一红是 `docs/_meta/gaps.md:17-28` 记的环境性既有失败（maintenance symlink），与卡片无关。

## 二、我跑了什么（命令原文 + 退出码）

```
$ cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T014
$ node --test trace-board.test.js agent-api.test.js paging-session.test.js
  ℹ tests 40 / pass 40 / fail 0        （exit 0，连跑两遍同结果）
$ node --test evidence/test/P003-T014/acceptance.test.js
  ℹ tests 8 / pass 8 / fail 0          （exit 0，连跑两遍同结果）
$ node --test --test-reporter=tap *.test.js
  # tests 180 / # pass 179 / # fail 1   （exit 1）
  not ok 92 - maintenance CLI starts when the deployment current path is a symlink
$ git show --stat --oneline HEAD
  2ff6322 … 3 files changed：coding-reports/P003-T014.md、docs/modules/trace-board.md、evidence/recon/P003-T014.md
$ git status --porcelain
  ?? .pi-child-claim.json
  ?? evidence/test/P003-T014/
```

## 三、自建 e2e 覆盖（8 条，逐条对应验收）

| 用例 | 断言要点 | 文档出处 |
| --- | --- | --- |
| A1 IP 起点 | POST 回 202；响应合 `TraceBoard`/`TraceBoardHop`/`TraceBoardLink`/`TraceBoardGap`/`TraceBoardDiscovery` 必填与枚举；`chain_length === hops.length`、`has_gaps === gaps.length>0`；同目标再 POST 回 200 且上游零调用 | openapi.yaml:1571-1690、docs/modules/trace-board.md §2.2/§3.3 |
| A1 告警起点 | 非法目标 400「请输入有效告警 ID 或 IPv4 地址」、空正文 400、无分析记录的 syslog 告警 422，错误体都是 `{error}` | openapi.yaml:488-520、http-api.md:79 |
| A2 列表 | 摘要必填字段齐；列表 `chain_length`/`has_gaps` 与详情逐条一致；`type`/`host`/`from-to`/`status` 筛选口径（IP 板不被 type 选中、12 月窗口只选中 honeypot 那条、四种状态全选=不筛）；`count/offset` 切页，`total` 是筛后总数 | openapi.yaml:400-445、docs/modules/trace-board.md §2.2 |
| A2 边界 | `count=0/51/abc/1.5`、`offset=-1/abc`、`status=bogus`、`from=abc`、`to=abc`、起点晚于终点 —— 10 条非法值逐条 400，正文是 `{error}` | 同上 |
| A3 详情 | 落盘的边故意写反方向（from=更早的来源），详情仍按 `occurred_at` 重算：`from`=告警那一跳、`to`=08:00 的来源；旧板字符串缺口归一成 `{hop_id:null, reason}`；旧板无 discovery 时按 hops、links 补齐；`hops[0].kind === 'alert'` | openapi.yaml:1598-1640、docs/modules/trace-board.md §4.3 |
| A3 错误 | 无白板 404、目标格式非法 400，正文 `{error}` | http-api.md:80 |
| A4 复用 | 真 `InvestigationStore` + 真 `createAnalysisProvider` + 案卷 `01-原始告警.txt`：POST syslog 告警 202，`alert.type/host/occurred_at` 来自案卷，`origin_evidence.evidence_id === 'syslog:1'`、`reused === true`，且 `get_*_event` 零调用。**对照组**：牧云告警同一装置下 202 且确实调用 `get_webshell_event`（证明观测装置不是聋子），`reused` 不为 true | docs/modules/trace-board.md §4.3 |
| 公开面 | 没有白板服务时三条路由 503；`/api/trace/tools` 无 MCP 工具箱 503，正文 `{error}` | http-api.md:74-80 |

**变异验红（证明断言不是永真）**：

1. 把 A3 夹具里两跳的 `occurred_at` 对调（告警 08:00、来源 10:00）→ A3 恰好红：
   `AssertionError: from 应是更晚的告警那一跳：{"id":"link:0","from":"ip:192.0.2.9","to":"asset:10.0.0.5",...}`，还原复绿。
2. 把 A4 的复用通道去掉（`analysis = null`）→ A4 恰好红（`origin_evidence` 与「不查事件」两条同时红），还原复绿。
3. 把 A4 断言的 `reused` 期望改成 false → 恰好红。

## 四、文档锚点复核（派活锚点 A1 的「落位」部分）

计数（成立）：

```
$ grep -o 'trace-board\.js:[0-9-]*' docs/modules/trace-board.md | sort -u | wc -l
107
```

逐锚点核对（只看符号名与行号，不看源码内容）。函数级 15 组全部对得上：
`traceBoardSeed 158`、`traceIpSeed 188`、`addCandidate 204`、`summarizeRecord 215`、`profileFrom 229`、`parseAction 246`、
`constructor 255`、`file 262`、`summaries 268`、`page 282`、`list 294`、`get 297`、`save 309`、`startOrResume 326`、`start 369`、
`investigate 371`、`explore 505`；常量 `7-14`；`presentBoard 87-126`、`summarizeBoard 75-85`、`rowFacts 135-156`。

**不落位的 8 个引用（7 处）**——文档说 / 实测：

| # | 文档处 | 文档说 | 实测（符号所在行） | 复现 |
| --- | --- | --- | --- | --- |
| 1 | docs/modules/trace-board.md:229 | `id` 的出处含 `trace-board.js:208` | 208 是节点总数上限守卫（`MAX_NODES`），`id` 生成在 **206** | `sed -n '206p;208p' trace-board.js \| grep -oE '[A-Za-z_][A-Za-z_0-9]*'` |
| 2 | docs/modules/trace-board.md:238、243 | `discovered_from` 的出处含 `trace-board.js:173` | 173 是外网 IP 节点的 profile 行；`discovered_from` 在 **175** | `grep -no discovered_from trace-board.js` → 168/175/198/211 |
| 3 | docs/modules/trace-board.md:252、253、255 | AI 边的 `strength`/`by`/`at` 出处含 `trace-board.js:561` | 560 是这几个字段的赋值行；561 是 `board.edges.push(edge)` | `sed -n '560p;561p' trace-board.js \| grep -oE '[A-Za-z_][A-Za-z_0-9]*'` |
| 4 | docs/modules/trace-board.md:273 | `seed` 活动出处 `182`、`197` | `kind: 'seed'` 在 **183**（建板）与 **199**（IP 板）；182 是 `created_at/updated_at`、197 是 profile | `grep -no "'seed'" trace-board.js` → 183/199 |
| 5 | docs/modules/trace-board.md:261 | 活动 `at` 出处含 `182` | 183 才是 seed 活动的 `at`；482 正确 | 同 4 |
| 6 | docs/modules/trace-board.md:264 | 活动 `detail` 出处含 `483` | 482 是 investigate 活动的 `detail`；483 是统计行 | `sed -n '482p;483p' trace-board.js \| grep -oE '[A-Za-z_][A-Za-z_0-9]*'` |
| 7 | docs/modules/trace-board.md:277 | `look` 活动出处 `540` | 539 是 `kind: 'look'`；540 是 `await this.save(board)` | `sed -n '539p;540p' trace-board.js \| grep -oE '[A-Za-z_][A-Za-z_0-9]*'` |

另有两处**同文自相矛盾**（server.js 锚点混了两套基线）：

- docs/modules/trace-board.md:63（§2.2）与 docs/modules/http-api.md:80 的详情路由写 `server.js:353-361`（分支实际 350 起，差 3 行），
  而 docs/modules/trace-board.md:166（§4.1 第 11 步）同一路由写 `server.js:253-262`（63f1379 旧号，差 ~100 行）。
  实测：`grep -n "'/api/trace/boards/" server.js` → 350；`server.js:350` 是详情分支入口。
- §4.1 第 2 步（:152）写「路由层校验目标格式（`server.js:116-120`）」，实测 116-120 是 `res.end` 与 `hasPromptAdminAccess`，
  目标校验在 `server.js:342`/`355`（`validTraceTarget` 定义在 161）。旧基线号。

第 8 处（属标签错位，不属行号错）：§2.1 第 41 行把「开一张新白板并启动追查」记成 `TraceBoardService.start` 并引 `326-369`、`358-359`，
但 326-368 是 `startOrResume`（现有编号下 `start` 在 369 单独一行，`358-359` 的 `model`/`focus` 也落在 `startOrResume` 里）。
按 §4.3「`start` 保留旧签名」的口径，这行的入口名与锚点应二选一对齐。

（`trace-board.js:450` 记 `touched_hosts` 也不算错：450 是 `touched.add(...)` 收集处，475 是字段赋值处，同页 :240 已引 475。「范围内可还原」的一律不打回。）

## 五、卡片验收逐条

| 验收 | 结果 | 依据 |
| --- | --- | --- |
| A1 从一条告警创建溯源；已有则返回那条 | pass | 自建 e2e 第 1、2 条；write 单测 40/40 |
| A2 列表字段、分页、筛选 | pass | 自建 e2e 第 3、4 条（含 10 条非法值） |
| A3 详情 hops/links/gaps/discovery、线从更晚指向更早、断点写明哪一跳 | pass | 自建 e2e 第 5、6 条 + 变异验红 |
| A4 分析证据直接引用、不重查 | pass | 自建 e2e 第 7 条（真 `createAnalysisProvider` 生产路径）+ 变异验红 |
| 文档锚点落位（派活 A1 的语义部分） | **不成立** | 8 个引用差 1–2 行，见第四节；计数 107 成立 |
| 测试 40/40（派活 A7） | pass | 连跑两遍 40/40、exit 0 |

## 六、未决 / 残余风险

1. 自建 e2e 的 A4 用 `InvestigationStore` 手写记录 + 手写案卷（文档给了记录字段与案卷文件名），没起真 UDP syslog 接收器与真研判队列；
   `TriageMonitor.status()` 兜底分支（`case_dir` 定位）未在我的用例里覆盖（`agent-api.test.js:374-472` 有覆盖，属写者的单测）。
2. `analysis` 注入函数的返回形状在文档里没有定义（只写了「分析已落盘的起点事实」），所以自建用例走的是文档里的生产接线
   `createAnalysisProvider({monitor, history})`，没有直接造 `analysis` 替身。若要单测该注入点，文档得补返回形状。
3. 文档锚点第五节列的两处 server.js 基线混用只在文档层面；行为面不受影响。
