# P003-T043 测试报告（gc-backend-tester）· 复审 pass 后的验收轮（审计打回后重交）

- 任务卡：P003-T043「砍掉 baseline/intel：研判背景统一走 wiki 环境基线页与规则白名单」
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T043`（HEAD `d1bf027`）
- 送测依据：第三轮复审判词 `P003-T043-gc-backend-code-review-mwo3j67a.json`（pass，supersede `mwo3ipzf`）；
  上一版报告被测试审计打回（`P003-T043-gc-backend-test-review-mwo3qwul.json`：1 major + 6 minor），本轮逐条整改后重交
- 验收锚点：A1–A6（判据见判词 `criteria[]`）
- **判定：pass**——上轮打回的 1 major + 6 minor 全部亲手关闭（含三条 A4 守卫的变异恰红复现、A6 新判据的失败自证），本轮无新 finding。
- **口径更正声明**：上一版 §三 曾写「四条 `test ! -e` 全成立 exit 0」，实况是从工作树根跑整条 `&&` 链 **exit 1**
  （`../backend/.data` 存在：205M、mtime 2026-11-18，属 P003-T019 负范围的旧数据根）。该句**曾被测试审计纠正**，
  本轮已改为文件级判据并附实测，见 §二 F1 与 §三。
- 恢复单的提交链与用例分布还有三处小的记述不准，见 §六；不涉 A1–A6 的任何判据页/行为，记录不打回。
- 本报告所有绿色与红色均出自本机终端亲跑，未转录他人输出；全部外部命令带 `timeout`。

## 一、亲跑门禁（命令原文 + 退出码，本轮实测）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `timeout 240 node --test evidence/test/P003-T043/context.test.js` | `tests 13 / pass 13 / fail 0`（duration_ms 157.2），**exit 0** |
| 2 | `timeout 300 npm test` | `tests 228 / pass 228 / fail 0`（duration_ms 802.8），**exit 0** |
| 3 | `timeout 200 bash evidence/test/P003-T043/probe.sh`（连跑两次） | 两次都 8 条断言全绿，工作树指纹 `14ac431d673ca369a27a17631f807e5b4ebc9b4a` 前后一致，**exit 0**；数据根 196 个运行态文件、牧云替身被调 1 次、模型替身被调 1 次 |
| 4 | `timeout 120 node --test --test-force-exit evidence/test/P003-T019/data-dir.test.js evidence/test/P003-T034/data-root.test.js` | `tests 16 / pass 16 / fail 0`（duration_ms 126.7），**exit 0** |
| 5 | `timeout 200 node --test --test-timeout=60000 evidence/test/P003-T034/acceptance.tester.test.js` | `tests 14 / pass 14 / fail 0`（duration_ms 7083.4），**exit 0** |
| 6 | `timeout 120 node evidence/test/P003-T043/tester-wiki-api.mjs`（测试者自写 e2e，未提交） | 8 组断言全绿，**exit 0**（190 页、GEN-13 `characters=4056`、404 体、分页边界 6 条全 400、数据根 192 个运行态文件） |
| 7 | `timeout 200 bash evidence/test/P003-T043/old-locations.sh`（**本轮新增，A6 文件级判据**） | 三处旧根零命中 + 旧单文件基线页不存在，**exit 0** |
| 8 | `grep -niE 'http\|router\|auth\|token' triage-monitor.js syslog-input.js syslog-case.js` | 只输出 `triage-monitor.js:562: …（HTTP 还要活）。`，与 `docs/modules/triage-pipeline.md:48-58`（引用行 :52）逐字一致；命令 **exit 0** |

工作树指纹与审计那轮的 `71a91cbd…` 不同是**预期变化**：`probe.sh` 的指纹含 `git status --porcelain`，
本轮整改新增/改动了 `context.test.js`、`probe.mjs`、`old-locations.sh`、`mutation.txt` 并提交为 `d1bf027`，
已跟踪面与未跟踪面都变了。指纹只用来证明「探针没写工作树」，不承诺跨轮恒定；同一轮内连跑两次一致（`14ac431d…`）。

跑完后 `git status --porcelain` 与变异前逐行一致（`M .pi-child-claim.json` + 本报告、`tester-wiki-api.mjs` 两个未跟踪文件）；
`pgrep -af 'node evidence/test|node .*P003-T043'` 只命中 pgrep 自身的 shell，无本卡残留进程。

## 二、上轮 7 条 findings 的关闭验证（逐条亲手复做）

| 上轮 finding | 我看到的现状 | 关闭证据 |
| --- | --- | --- |
| F1 **major** `test-report.md:45` 四条 `test ! -e` 写成「全成立 exit 0」 | 已改：判据落到**文件级**——新增 `evidence/test/P003-T043/old-locations.sh`，逐根 `find -maxdepth 3 \( -name baseline.json -o -name intel.json \)` 零命中；`../backend/.data` 明确写「P003-T019 负范围保留的旧数据根，不删，只核其中无两份文件」；目录级现状只在第 3 段记录不作判据 | 亲跑：`.data`/`../.data` 不存在 ✅，`../backend/.data`（205M）零命中 ✅，`~/.local/share/hids-ai-console` 零命中 ✅，`wiki/environment-baseline.md` 不存在 ✅ → **exit 0**；目录级 `test ! -e ../backend/.data` 实测 **exit 1**，报告与判词不再写「全成立」 |
| F2 minor A2 段号指错 | 已改：A2 的证据指向 `probe.mjs` **段 3**（`:131-152`，实断言 `:146-149`：真 UDP → 案卷 `04-上下文.md` 的 JSON 键集 `['history','window']`）；段 5（`:159-165`）只说目录结构 | `grep -n '段 3\|段 5' probe.mjs` → `:131` / `:159`；`probe.sh` 输出「04-上下文.md 只有 window/history」取自段 3 |
| F3 minor `probe.mjs:161` 恒真分支 + `:163`「0 次也算链路真跑起来」 | 已改：段 5 只钉 `dataDir/wiki`、`dataDir/triage-monitor.json` 两项，`X==='cases'` 那条恒真 `|| existsSync(join(casesDir,'..',X))` 删掉；说明串改成 `模型替身调用 N 次`，**0 次时明写「模型侧未被触达，不据此判链路跑通」**（不再有「0 次也算跑起来」的措辞） | 本轮两次跑均打印 `模型替身调用 1 次`；改坏 `dataDir/wiki` 会话面属其他卡的判据，本段只作结构记录，实断言仍在段 3/段 4 |
| F4 minor 报告 nit 行号 `context.test.js:108` | 已改：审计实测在 **`:111`**，我原写 `:108` 是旧行号；该行注释「无程序消费者」已改成「没有判定消费者；装配侧仍会被读入」（与断言口径一致）。因上方新增两行静态守卫说明，修好后该注释现处 `:113` | `awk 'NR==113'` → 注释已新口径；`grep -c '无程序消费者' context.test.js` → 0 |
| F5 minor `/tmp/t043-probe-*` 零残留口径不成立 | 已改：口径收窄到 probe.sh 自己的 RUN 目录（`mktemp -d /tmp/t043-probe-XXXXXX`，`trap cleanup EXIT`），复核方式 `ls -d /tmp/t043-probe-??????` 为空；我自己留在盘上的 `/tmp/t043-probe-run2.txt`、`/tmp/t043-pre-status.txt` 已删 | `ls /tmp \| grep -i t043` → 零命中（exit 1）；`ls -d /tmp/t043-probe-??????` → 无匹配（exit 2） |
| F6 minor `tester-wiki-api.mjs:138` `&& true` 装饰断言 | 已改：删掉 `&& true`，改成 `assert.ok(existsSync(…), '仓内种子页缺失')`；真正要验的「读的是注入根副本」由 `:137` 的注入根断言承担 | 亲跑 e2e 仍 8 组全绿 **exit 0** |
| F7 minor `context.test.js:34` 源码 grep 被当行为断言 | 已改：断言上方加两行注明「静态守卫，不是行为断言；A1 的行为证据在 `:25-29`（runtimePaths 七键）/ `:41-63`（坏 JSON 不致命 + contextFor 六键）」 | `awk 'NR>=32 && NR<=33'` → 两行说明在位 |

## 三、文档 ↔ 行为一致性（逐条亲验，本轮复核）

| 文档出处 | 文档说 | 实测 |
| --- | --- | --- |
| `wiki/common/GEN-13.md` 全页 | 105 行 / 4056 字符 | `wc -l`=105、`wc -m`=4056；HTTP 正文 `characters=4056`，与探针同数 |
| `docs/modules/triage-pipeline.md:627` | `contextFor` 在 `triage-monitor.js:899-914` | 结构查询：`async contextFor` 起于 899、`:916` 已是 `rememberWindow` → 与文档同口径 |
| `docs/modules/http-api.md:43,49` | 7 条路径、`runtimePaths()` 在 `server.js:1359-1370`、`dataRoot()` 在 `config-store.js:33` | 亲跑 `runtimePaths('/tmp/t043-verify')` → `data/investigations/triageRules/triageMonitor/cases/wikiSessions/traceBoards` 七键；结构查询行号吻合 |
| `docs/architecture.md` §8.2 表行 | `server.js:59` 研判记录 / `:60` 规则集 / `:62-63` 研判队列 / `:68` 案卷 / `:69` wiki 会话 / `:138` 白板 | 结构查询逐行吻合 |
| `docs/architecture.md:392-400` | 基线不再有运行态文件可搬；老文件手工誊进 GEN-13 | 与 GEN-13「不读不搬」同口径，无打架 |
| **删除类判据：旧位彻底不存在（含未跟踪残留）** | 本卡删的是**两份运行态文件**与旧的单文件基线页 | **文件级判据**（`old-locations.sh`，exit 0 实测）：`.data`/`../.data` 不存在；`../backend/.data` **存在（205M，P003-T019 负范围保留）但 `baseline.json`/`intel.json` 零命中**；默认数据根 `~/.local/share/hids-ai-console` 零命中；`wiki/environment-baseline.md` 不存在。目录级 `test ! -e ../backend/.data` = **exit 1**，不作判据（与 P003-T019「不删旧目录」相撞） |
| `wiki/log.md` 本次登记与 `GEN-13` 分层口径 | 两处同口径（规则层两个程序载体、场景提示不是判定层） | 按行比对一致；M9 变异恰红证明守卫钉得住 |

A6 文件级判据的**失败自证**（不是永真脚本）：造 `.data/baseline.json` → `✖ .data 命中：.data/baseline.json` + `✖ A6 旧位判据有命中`、**exit 1**；`rm -rf .data` → `✔ A6 旧位判据（文件级）全部满足`、**exit 0**。

## 四、变异复现（本轮亲手做，逐条改坏 → 恰红 → 复原）

| 变异 | 改坏什么 | 实测 | 复原 |
| --- | --- | --- | --- |
| M9 | `wiki/log.md:23` 规则层行挂回 `command_whitelist` 场景提示 | `✖ A4 wiki/log.md 的本次登记与 GEN-13 的分层口径一致`，pass 12 / fail 1、**exit 1** | `git checkout -- wiki/log.md` → 13/13、exit 0 |
| M10 | `GEN-13:97` 同目录引用 `[GEN-12](GEN-12.md)` → `[GEN-01](GEN-01.md)`（deprecated） | `✖ A4 判据页只引用当前 active 页，不引 deprecated 页`，pass 12 / fail 1、**exit 1** | `git checkout -- wiki/common/GEN-13.md` → 13/13、exit 0 |
| M11 | `GEN-13:87` 「没有判定消费者」→「没有程序消费者」 | `✖ A4 GEN-13 写清白名单命令哪层是硬判定、哪层只是研判参考`，pass 12 / fail 1、**exit 1** | 同上复原 → 13/13、exit 0 |

三条守卫都不是永真断言：改坏就红、还原就绿，每次只红 1 条。复原后 `git status --porcelain` 与变异前逐行一致。
记录已追加进 `evidence/test/P003-T043/mutation.txt`（含 A6 判据的失败自证）。

## 五、测试者自写 e2e（`tester-wiki-api.mjs`，本轮复跑）

真进程（`node server.js`，独立 `HIDS_DATA_DIR`/`HIDS_CASES_DIR`/端口，五项必填给占位值）+ 无 token 直连，按
`docs/modules/http-api.md` §3.1/§7 与 `docs/modules/knowledge-base.md` §7.1-7.2 断言：

- `GET /api/wiki/pages` → 200 `{pages,total}`，190 页，每项 7 字段齐、无 `content`、`revision` 16 位十六进制、`status` 在四值域内；
- GEN-13 `path=common/GEN-13.md`、`status=active`、`characters=4056`；单页读取正文含分层口径（4 个 marker）；
- 不存在的页 → 404 `{"error":"知识库页面不存在：common/GEN-99.md","code":"caller_error"}`；
- 分页边界 6 条全 400 + `{"error":"分页参数无效"}`：`count=abc/0/51/20.5`、`offset=-1/1.5`；`count=1` 切页 `total` 不变；`offset=10000` 回空页；
- 种子落注入根、数据根零 `baseline.json`/`intel.json`（192 个运行态文件）。

5xx N/A：本卡没改任何 5xx 路径（改的是运行态路径与判据页内容）。

## 六、本轮新看到的三处记述不准（minor，不涉 A1–A6，记录不打回）

| # | 位置 | 文档说 | 实测 |
| --- | --- | --- | --- |
| 1 | `coding-reports/P003-T043.md:5` | 提交链止于 `0b21753`（第二轮变异自证），「两轮整改见 §五、§六」 | HEAD 已是 `d1bf027`；第三轮 `d28b558`/`8694bbb`/`7dc53da` 与本轮 `d1bf027` 都不在链上 |
| 2 | `coding-reports/P003-T043.md:14` | `contextFor()`（现 `:899-916`） | `:916` 已是 `rememberWindow`，正文止于 914——与同报告 §六 minor 2 及 `docs/modules/triage-pipeline.md:627` 的 `:899-914` 自相矛盾 |
| 3 | `coding-reports/P003-T043.md:38` | 「13 条单测（A1×4 / A2×1 / A3×2 / A4×3 / A5×3）」 | 实测分布 A1×4 / A2×1 / A3×2 / **A4×4** / **A5×2**（总数 13 对） |

上一版记的 nit（`context.test.js` 注释残留「无程序消费者」）已被审计指正为 `:111`，本轮已修（现处 `:113`，见 §二 F4），不再挂账。

## 七、未覆盖 / 残余风险

1. **A3 的「模型真的在研判里调 `wiki_page`」仍未做真模型端到端**（报告未决⑤同口径）：可达性由 `agentIndex`/`agentPage`/`agentSearch`、HTTP 单页读取与 `agentContextPages` 亲跑证明。探针里模型替身本轮被调 1 次，但**调用次数不稳定（审计两次跑见过 0 次）**，所以不拿它判「链路真跑起来」，段 5 说明串已按此口径改。
2. **已部署数据根不会自动长出新页**（报告未决④）：判据库只在目录不存在时播种，老环境要删库重种，本卡没验这条运维步骤。
3. **既有行号债**：`docs/architecture.md` §8.2 的 `config-overrides.json`（`server.js:31`、`config-store.js:37`）与 `wiki-history`（`wiki-store.js:30`）两行实测已漂（`server.js:35`、`config-store.js:40`、`wiki-store.js:31`）——本卡未改这两行，已按「只核自己改过的句子」申报。
4. **卡片判据口径**：本卡派活的 A6 写的是「旧位 `.data` / `../.data` / `../backend/.data` 亲手 `test ! -e` 全不存在」，而 `../backend/.data` 按 P003-T019 负范围**不删**，这条目录级判据在本机恒为红（exit 1）。本轮按审计给的改法落到文件级（baseline/intel 零命中），A6 勾选只取「探针独立数据根 + 指纹未变 + 文件级零命中」三项。**卡片文字要不要跟一句负范围说明，请群主定**——测试席不替卡片改判据。
5. `.pi-child-claim.json` 在本卡提交里被顺带入库、当前工作树为 `M`——按派活与报告声明按引擎文件处理，不计 finding；**新增**凭据/引擎文件入库仍须群主拍板。

## 八、环境清理

所有外部命令带 `timeout`；探针（`probe.sh` 的 `trap cleanup EXIT`）与自写 e2e（`finally` 里 `rm -rf`）都回收子进程与临时目录；
跑完 `ls /tmp | grep -i t043` 零命中、`ls -d /tmp/t043-probe-??????` 无匹配；上一版留在盘上的两个自用中间文件已删；
三条变异全部还原，`git status --short` 与变异前逐行一致（`M .pi-child-claim.json`、本报告、`tester-wiki-api.mjs`）。
