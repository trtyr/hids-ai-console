# P003-T045 测试席验收报告（日志落盘 / 轮转 / 查询与清理接口，2026-11-20）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T045`
- HEAD 历程：起验 `1681eb2`（首轮）→ 第二轮复审 `7eeed50` → 第二轮整改 `3fd0e26` → **本轮起验 `d6f655e`**
- 交卷 = `d6f655e` 之上的单提交（`git log -1 --oneline` → `test(P003-T045): 第三轮整改——teardown 钩子顺序 kill→rm、撞窗 detail 分两支、探针三条并发时序（实现零改动）`），
  `git show --stat HEAD` 只有本报告 + 两个测试件；产品代码 / 文档 / `.env.example` 零改动
- `d6f655e` 是**群主（owner）代笔**的 openapi 修复，不是测试席提交——内容：`/api/logs` 的 `level` 参数去 `enum`（`enum` 与「逗号多选」语义互斥）。我本轮用 `yaml.safe_load` 复核在位（§三 末行）
- 上游判词：`verdicts/P003-T045-gc-backend-test-review-mwny59a4.json`（第三轮打回：teardown 钩子顺序 + 撞窗 detail 文案 + 报告 HEAD 落后）
- 判据只取契约：`docs/modules/http-api.md` §3.8（:477 起）/ §7 分页（:714）/ §8（:772）/ §4 认证（:495）、
  `openapi.yaml` 的 `getLogs`（:320）/ `cleanLogs`（:383）/ `LogEntry` / `LogQueryResult` / `LogCleanupRequest` /
  `LogCleanupResult`、`docs/architecture.md` §3.6（事件名表 :126-147）、`.env.example`（三个键 + 头部键数）。
  **实现文件一行内容没读**；`log.js` / `server.js` 只做过符号定位（`grep -n` 行号），变异是照文档里写明的行号/字符串盲改。
- 我自己写的东西：`evidence/test/P003-T045/tester-acceptance.mjs`（独立黑盒探针，151 条断言）+ 本报告。

## 结论

**PASS。** 审计第三轮点的三条全部整改并亲手复验：套件 hook 顺序（8 路并行 160 跑 0 红、0 残留，隔离变异 160 跑红 2）、
撞窗 detail 分两支（真违约照判红且文案不再说「落定」，撞窗通过单独措辞）、报告 HEAD 更新到 `d6f655e` 并写明群主代笔。
本轮门禁亲跑：卡套件 16/16、卡套件 8 路并行 32/32、根套件 228/228、T025 14/14、探针 151 条 MISS 0，全 exit 0；
探针在 16 忙进程 + 8 并行下 96 跑 0 crash / 0 MISS（其中 6 次真撞窗、全部重采通过）。
另外自查出**三条审计没列的测试侧时序**（活动文件 stat ENOENT、采样快照→读盘 ENOENT、借端口 TOCTOU EADDRINUSE），
均已改成确定性并各自给出修前红证据；见 §〇。

## 〇、本轮整改（审计第三轮 reject 后，2026-11-20；实现零改动）

### 〇.1 要害：`t.after` 注册顺序（kill 必须在 rm 前）

先量了一下 node:test 的语义（`/tmp/t045-order/order.mjs`，5 行小例，我亲手跑）：
`SEEN ["first-registered","second-registered"]` —— `t.after` **按注册顺序先注册先跑**；
另一例第一条钩子 `throw` 后 `HOOK2 RAN` 没打印 —— **一条 after 抛错会吞掉后面注册的钩子**。
所以审计说的「rm 先跑 → ENOTEMPTY → kill 被吞」链条成立。

| 阶段 | 做法 | 实跑（命令 + 结果） |
| --- | --- | --- |
| 修前（= 本工作树 `3fd0e26` 版套件副本） | `git show 3fd0e26:evidence/test/P003-T045/log-file.test.js` → `/tmp/t045-old.test.js`（导入路径改绝对） | 8 路并行 × 20 轮 = **160 跑 → 红 2**：`ENOTEMPTY: directory not empty, rmdir '/tmp/hids-log-6Lk1w4'`、`…'/tmp/hids-log-DpgYyX'`（日志 `/tmp/t045-oldlogs2/r13-8.log`、`r8-7.log`），两个残留目录实跑完还在 |
| 隔离变异（只换回钩子顺序、其余不动） | 从**修后**套件复制一份，只把两个 `t.after` 换回原顺序并去掉 `maxRetries` → `/tmp/t045-mut-order.test.js` | 8 路并行 × 20 轮 = **160 跑 → 红 2**：`ENOTEMPTY … '/tmp/hids-log-80YmBy'`、`'/tmp/hids-log-en7ax5'`（`/tmp/t045-mutlogs/`）——红点就是顺序，不是别的改动 |
| 修后（工作树 `log-file.test.js:109-129`） | 真进程那条不用 `workspace(t)`（它一进来就注册 rm）：自己 `mkdtemp` → `spawn` → **先注册 kill 并等 exit**（:123-127）→ **后注册 rm**（:129，带 `maxRetries:5, retryDelay:50` 兜底）；`workspace()` 的 rm 也补了 `maxRetries` | 8 路并行 × 20 轮 = **160 跑 → 0 红、0 非零退出**；跑前后 `/tmp/hids-log-*` 快照 `diff` **无新增残留**。另按派活口径单跑一组 8 路 × 4 轮 = **32 跑全绿**（32× `tests 16 / pass 16 / fail 0`） |
| 单跑 | `node --test --test-timeout=60000 --test-force-exit evidence/test/P003-T045/log-file.test.js` | `ℹ tests 16 / pass 16 / fail 0`，exit 0 |

### 〇.2 撞窗 detail 分两支（真违约不再写「落定」）

`tester-acceptance.mjs:433-439` 现在两支：

- 最终 5 份且有重采 → `（撞 rename→unlink 窗口 N 次后重采通过）`
- 最终不是 5 份 → `（2s 内重采 N 次仍不符（非瞬态违约，不是撞窗））`，断言照判红

| 分支 | 怎么造出来的 | 实跑 |
| --- | --- | --- |
| 真违约（非瞬态） | 整树副本到 `/tmp/t045-mut-tree`，盲改 `log.js:75` `const DEFAULT_KEEP = 5;` → `= 6`（照审计上轮同一手法），在副本里跑探针 | `T045 TESTER MISS 共 151 条断言，MISS 1`，**exit 1**；detail = `6 份：hids.…-454Z-1.log,…,hids.…-458Z.log（2s 内重采 97 次仍不符（非瞬态违约，不是撞窗））` |
| 撞窗重采通过 | 16 个 CPU 忙进程 + 8 并行 × 12 轮 = 96 跑 | 0 MISS；其中 **6 跑真撞窗**，detail = `（撞 rename→unlink 窗口 1 次后重采通过）`（`/tmp/t045-load4/`） |

### 〇.3 报告 HEAD / 代笔归属

本报告头部 `HEAD` 已改成当前树 `d6f655e`，并写明该提交是**群主代笔**的 openapi 修复、我复核在位（§三 末行）；
`§五` 第 1 条「openapi level enum 矛盾」从「doc-side 未修」改成「已在 `d6f655e` 修掉（群主代笔）」。

### 〇.4 自查（审计未列）——三条测试侧时序，都改成确定性

| # | 位置 | 怎么发现的（修前红，亲手） | 改成什么 |
| --- | --- | --- | --- |
| a | `tester-acceptance.mjs:399`（A2 真进程轮转的 `await stat(file)`；修前在 `:359`，栈里就是 359 那一行） | 12 忙进程 + 8 并行 32 跑撞 **1 次**：`PROBE CRASH Error: ENOENT: no such file or directory, stat '/tmp/t045-rotate-dnnt3k/hids.log'`（`/tmp/t045-probe-load/r1-4.log`） | 有界重采 2 s（`:391-399`）：轮转是 `rename(hids.log→历史名)` 后重建，中间活动文件短暂不存在，请求返回 ≠ 这行日志写完；2 s 回不来说明活动文件真没了，照判红 |
| b | `tester-acceptance.mjs:401-409`（采样快照 → 逐个读盘） | 把 a 的重采退回去的副本（`/tmp/t045-mutstat*`）16 忙 + 8 并行 64 跑撞 **1 次**：`PROBE CRASH ENOENT open '/tmp/t045-rotate-AdLh6Q/hids.…Z.log'`（快照里的历史文件随后被 unlink） | 采样前先「等活动文件两次采样等大小」（sink 落定，`:373-385`）+ 读行容忍 `ENOENT`（窗口内合法中间态，`:401-409`） |
| c | `freePort()` / `boot()` 借端口（`:37-45` / `:83`） | 8 并行 64 跑撞 **1 次**：`server 起不来：exit=1 stderr=…Error: listen EADDRINUSE: address already in use 127.0.0.1:44789`（`/tmp/t045-load3/r4-6.log`）——`freePort()` 关掉探针后到子进程绑定之间有 TOCTOU 窗 | `boot` 外层只对 `EADDRINUSE` 重试 4 次（每次重新借端口），其它启动错误照抛；启动失败时先清 `mkdtemp`（`:111`、`:115`）。**证明重试真在用**：`FORCE_PORT` 副本 + 一个占掉该端口 2 s 的监听 → 日志打出 `RETRY attempt=1 err=server 起不来：exit=1 …`，第二次起成功，全场 `151 条 MISS 0` exit 0 |

修后合并验证：`tester-acceptance.mjs` **16 忙进程 + 8 并行 × 12 轮 = 96 跑 → 0 crash、0 MISS、0 非零退出**（`/tmp/t045-load4/`）。

## 〇·历史。前两轮整改（仍有效，本轮一并复跑）

| 轮 | 位置 | 改法 | 复跑证据（本轮） |
| --- | --- | --- | --- |
| 第二轮 1 | `log-file.test.js:137-146` | 文件命中后不立刻读 stdout：轮询 stdout 出现 `server.started` 再断言（5 s 上限、只认整行）；修前 4 忙进程 20 跑红 1 → 修后同负载 0 红 | 8 路并行 160 跑 0 红（§〇.1 同批） |
| 第二轮 2 | `tester-acceptance.mjs:424-439` | 撞 rename→unlink 窗口隔 20 ms 重采（2 s 上限、超时照判红） | 96 跑 6 次真撞窗重采通过 + 真违约照判红（§〇.2） |
| 第二轮 3 | `log-file.test.js:104` | A1 用例名「先写文件再写 stdout」补断言（stdout 回调里 `readFileSync` 回看盘面），按 `docs/modules/http-api.md:521` | 卡套件 16/16；负对照历史见下（本轮未重造） |

第一轮的锚点证据（`docs/modules/http-api.md:543` / `:602` / `:607` / `:611`）见 §三，本轮重核仍在位。

## 一、门禁（命令原文 + 退出码，全是我亲跑）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 本卡套件（单跑） | `node --test --test-timeout=60000 --test-force-exit evidence/test/P003-T045/log-file.test.js` | `ℹ tests 16 / pass 16 / fail 0`，281 ms，**exit 0** |
| 本卡套件（8 路并行 × 4 轮 = 32 跑） | 同上命令 × 8 进程 × 4 轮 | 32× `pass 16 / fail 0`，0 非零退出 |
| 本卡套件（8 路并行 × 20 轮 = 160 跑，钩子顺序专项） | 同上命令 × 8 进程 × 20 轮 | 0 红、0 非零；`/tmp/hids-log-*` **无新增残留** |
| 根套件 | `npm test`（= `node --test --test-timeout=60000 --test-force-exit *.test.js`） | `ℹ tests 228 / pass 228 / fail 0`，**exit 0** |
| T025 键集 | `node --test --test-timeout=60000 --test-force-exit evidence/test/P003-T025/config-check.test.js` | `ℹ tests 14 / pass 14 / fail 0`，**exit 0** |
| A6 键数 | `grep -cE '^[A-Z0-9_]+=' .env.example` | `41`，与头注「41 个键」一致 |
| 我的黑盒探针（单跑） | `node evidence/test/P003-T045/tester-acceptance.mjs` | `T045 TESTER OK 共 151 条断言，MISS 0`，**exit 0** |
| 我的黑盒探针（16 忙 + 8 并行 × 12 轮 = 96 跑） | 同上命令 + 16 个忙进程 | 0 crash、0 MISS、0 非零；6 次真撞窗重采通过 |

## 二、验收锚点 A1–A6（每条都是我自己发请求/看盘）

| 锚点 | 我跑出来的证据 |
| --- | --- |
| A1 配了落文件、不配 stdout-only | 真进程 `HIDS_LOG_FILE=<tmp>/hids.log`：文件里 `server.started` 带 `host/port`，stdout 同一行（`port` 一致）→ 同份；不配时不建文件，两条路由回 503 `not_configured` |
| A2 单文件上限 + 保留份数 + 不丢当前写入 | 真进程 `HIDS_LOG_MAX_BYTES=200`：12 次请求后历史文件名全部匹配 `^hids\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-\d+)?\.log$`，`HIDS_LOG_KEEP=2` 只留 2 份、缺省只留 5 份，所有文件每行都能解析成 JSON（没出现被切断的半行） |
| A3 过滤 + 分页 + 读盘 | 直接往盘上追加的手写行查得到（`files:2` 把轮转历史文件也计入）；`from`/`to` **闭区间**（`from=to=T` 只回那一条）、`from` 接受 Unix 秒、`level` 大小写不敏感 + 逗号多选、`event` 逗号多选、`event` 表外值 200 空列表；分页 `count=1/50` 200、`count=0/51/abc/20.5`、`offset=-1/abc/1.5` 全部 400「分页参数无效」；`total` 是切页前条数、`echo` 回显；命中 **20000 条 → `truncated:false`、20001 条 → `truncated:true` 且 `total` 封在 20000** |
| A4 清理按时间/大小 + 留痕 | 默认 dry-run 历史文件字节不动（当前活动文件被 server 自己继续追加，不在清理面）；`execute:true` 删 3 份、`applied.bytes=180`、`remaining` 现扫为 0、`hids.log` 还在；`older_than` **严格早于**（mtime 恰等于阈值那份不入候选，晚 1 ms 才入）；两阈值取并集不重复；101 份候选时 `count=101/items=100/truncated:true`、items 从老到新；留痕 `log.cleaned` 只有 `by/count/bytes`（`size`、`age+size` 两分支都验了），dry-run 不留痕 |
| A5 三道闸 | 文件里无 `Bearer/Cookie/?token=` 原文、无 Basic 口令原文与 base64；`http.request` 只记去掉 query 的 `path`；盘上人手写的 `authorization` / `api_token=…` 行在查询结果里被擦成 `[redacted]` |
| A6 键集双向一致 | `.env.example` 41 键、头注 41；三个新键在列；T025 A4 的 17 个守护键全在 `.env.example`，且 T025 双向比对 14/14 绿 |

## 三、文档锚点独立复核（结构查询，不看内容）

| 文档说的 | 我的命令 | 结果 |
| --- | --- | --- |
| `docs/modules/http-api.md:543` → `log.js:77` 的 `QUERY_SCAN_LIMIT` | `grep -nE '^(export )?(function\|const\|let) (QUERY_SCAN_LIMIT\|…)' log.js` | `77:const QUERY_SCAN_LIMIT = 20000;` ✓ |
| `docs/modules/http-api.md:602` → `log.js:66` 模块级 `log` | 同上 | `66:export let log = createJournal();` ✓ |
| `:607` / `:611` 写「16 条」 | `sed -n '607p;611p' docs/modules/http-api.md` + 卡套件实跑 | 两行都是 16 条；套件 `tests 16` ✓ |
| §3.8 关键路径其余锚点 | 同一条符号定位 | `logFileOptions 89` / `logFiles 112` / `createFileSink 129` / `useLogFile 157` / `readLogEntries 177` / `pruneLogFiles 207` / `server.js logQuery 582` / `logCleanup 838` 全部在位；两条路由在 `server.js:929-944`（503 分支在 930/941）✓ |
| `d6f655e`（群主代笔）把 `level` 的 `enum` 去掉 | `python3 -c "yaml.safe_load(open('openapi.yaml'))"` | `paths 47`；`/api/logs` 的 `level` 参数现在是 `{type: string}` + description「逗号分隔可多选（info/warn/error 之外的值回 400）」**无 enum** ✓ |

## 四、变异验红（在 `/tmp` 副本里盲改，工作树实现零改动）

| 变异 | 改什么（文档依据） | 实跑结果 |
| --- | --- | --- |
| M1 | `server.js:929-944` 的 `not_configured` 改名（§3.8.3 失败口径） | **未红（no-op）**：这个字面量只有一处，在 `server.js:387` 的 `configError` 表里；路由 930/941 调 `configError()`。§3.8 说的是「分支在 929-944」，不算错锚点 |
| M1b | `server.js:929-944` 的 503 文案改名（§3.8.3 写了这句原文） | 红：`A3 GET /api/logs：…未配 503`，`pass 15 / fail 1` |
| M2 | `log.js:77` 的 `20000` → `3`（§3.8.2 上限段） | 红：`A3 readLogEntries：…total 是切页前条数`，`pass 15 / fail 1` |
| M3 | 删 `.env.example` 的 `HIDS_LOG_KEEP=` 行（A6 三键） | 红：`A6 .env.example 列出三个新键…`，`pass 15 / fail 1` |
| M4 | `log.js:16-44` 写路径 `[redacted]` → 别的串（§3.6 脱敏段） | 红：`A5 落盘与查询结果都不出现 Authorization / Cookie / Token 原文`，`pass 15 / fail 1` |
| **M5（本轮）** | 修后套件只把两个 `t.after` 换回「rm 在前 kill 在后」 | 红：8 路并行 160 跑 **红 2**（ENOTEMPTY，见 §〇.1）；换回来复绿 160 跑 0 红 |
| **M6（本轮）** | `/tmp` 整树副本 `log.js:75` `DEFAULT_KEEP 5 → 6` | 探针 **exit 1**、MISS 1，detail 落「非瞬态违约」分支（§〇.2） |
| 还原 | 副本目录整体删除，工作树只用修后件 | 复绿：卡套件 16/16、探针 151 条 MISS 0；`ls evidence/test/P003-T045/` 只剩 3 个交付件 |

## 五、minor 记录 / 残留风险

1. ~~**`openapi.yaml` 的 `level` 参数自相矛盾（doc-side）**~~ → **已在 `d6f655e` 修掉（群主代笔，非我提交）**：
   `level` 参数去 `enum`，description 写「逗号分隔可多选（info/warn/error 之外的值回 400）」。我本轮 `yaml.safe_load` 复核无 `enum`（§三 末行）。
2. **根套件负载下会红（pre-existing，非本卡）**：`syslog-pipeline.test.js:96`（「…区分重复投递与跨秒行为」，`1 !== 2`）——
   同一抖动在**基提交 `ed2bd30`** 上也能复现（第一轮实测：基线 8 轮并发红 2 轮），单跑 25 次 0 红。记残留风险，不记本卡 finding。
3. **轮转有 `rename → 重建` 的瞬时窗口**：此刻活动文件 `hids.log` 不存在。文档 §3.8.1 只承诺「当前那条写进轮转后的新文件」，没承诺任意瞬间活动文件都在，
   故不判违约；探针侧按有界重采处理（§〇.4 a/b），不再假红。
4. `docs/modules/http-api.md` §3.8.1 承诺「stdout 断了文件那份也不丢」仍无端到端对应用例（用例名已不声称；A1 判据不要求），记残留不挡本轮。

## 六、实测里的两条 INFO（文档没写死，不判红）

- `POST /api/logs/cleanup` **完全不带正文** → 400 `{"error":"请求正文不是 JSON","code":"caller_error"}`。§3.8.3 表里只有「正文不是 JSON 对象」→「请求正文必须是 JSON 对象」；「请求正文不是 JSON」在 §8（:772）是全局口径，行为一致，只是 §3.8.3 表没点名无正文这一档。
- `GET /api/logs?nope=1` 未知参数不报 400（§3.8.2 参数表没提未知参数）；`?event=` 空串 = 不过滤（§7 的「空串落缺省」同口径）。

## 七、树状态

```
$ git -C . show --stat HEAD | tail -4
 evidence/test/P003-T045/log-file.test.js           |  12 ++-   # 本轮整改 〇.1（kill→rm 钩子顺序 + maxRetries 兜底）
 evidence/test/P003-T045/test-report.md             | 126 +++--  # 本报告（HEAD/代笔、本轮证据）
 evidence/test/P003-T045/tester-acceptance.mjs      |  64 +++-   # 本轮整改 〇.2（detail 分两支）+ 〇.4 a/b/c
 3 files changed

$ git -C . status --short
 M .pi-child-claim.json                             # 引擎运行态（起活前就在，未提交）
```

产品代码 / 文档 / `.env.example` 零改动：变异全在 `/tmp` 副本（M5 换钩子顺序、M6 改 `DEFAULT_KEEP`，跑完删副本）；
修前对照 / 负对照用的临时测试件跑完即删（`ls evidence/test/P003-T045/` 只剩 3 个交付件）；探针跑完自清 `mkdtemp`。
