# P003-T045 测试席验收报告（日志落盘 / 轮转 / 查询与清理接口，2026-11-20）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T045`
- 起验 HEAD：`1681eb2`（首轮）；本轮复审 HEAD `7eeed50`（只加过测试席探针，实现零改动）
- 上游判词：`verdicts/P003-T045-gc-backend-code-review-mwnx5n43.json`（pass，作废链含 mwnx4exb）
- 判据只取契约：`docs/modules/http-api.md` §3.8（:477 起）/ §7 分页（:714）/ §8（:772）/ §4 认证（:495）、
  `openapi.yaml` 的 `getLogs`（:320）/ `cleanLogs`（:383）/ `LogEntry` / `LogQueryResult` / `LogCleanupRequest` /
  `LogCleanupResult`、`docs/architecture.md` §3.6（事件名表 :126-147）、`.env.example`（三个键 + 头部键数）。
  **实现文件一行内容没读**；`log.js` / `server.js` 只做过符号定位（`grep -n` 行号），变异是照文档里写明的行号/字符串做的盲改。
- 我自己写的东西：`evidence/test/P003-T045/tester-acceptance.mjs`（独立黑盒探针，151 条断言）+ 本报告。

## 结论

**PASS。** 四条门禁全部我在自己终端里亲手跑：卡套件 16/16、根套件 228/228、T025 config-check 14/14、
我的黑盒探针 151 条断言 MISS 0；变异 4 条按预期红、还原复绿（本轮又重跑了 M2，仍恰红）。
审计 reject 的两处时序依赖 + 一条名不副实**本轮已整改并复验**（修前红→修后绿、撞窗口径亲手撞到，见 §〇）。
剩下的 `openapi.yaml:354` 自相矛盾（doc-side）与 `syslog-pipeline.test.js:96` 前置抖动不挡推进，见 §五。

## 〇、本轮整改（审计 reject 后，2026-11-20 复审轮；实现零改动）

审计点名「两处时序依赖只假红不假绿 + 一条名不副实」，全在我自己的测试件里，已改；下面每条证据都是本轮亲手跑到：

| # | 位置（改前行号） | 改法 | 修前复现（亲手） | 修后证据（亲手） |
| --- | --- | --- | --- | --- |
| 1 | `evidence/test/P003-T045/log-file.test.js:126` | 文件命中后不再立刻读 stdout：轮询 stdout 到出现 `server.started` 再断言（5 s 上限；只认整行，避开半行）；+7 行 | 把 HEAD 版套件存成临时件、4 个 CPU 忙进程下跑 20 次 → **红 1 次**（`A1 真进程…stdout 也应有一条 server.started`，stdout 还是空） | 同一负载、同一命令 20 次 → **0 红**；不加载 30 次 → 0 红 |
| 2 | `evidence/test/P003-T045/tester-acceptance.mjs:379` | 撞 rename→unlink 窗口不判 MISS：隔 20 ms 重采，采到 5 份再断言（2 s 采不到照判红，不放过真违约），撞窗次数写进 detail；+10 行 | 修前平跑 6 次 → **3 次 MISS**：`MISS A2 缺省 HIDS_LOG_KEEP=5… :: 6 份：hids.…-069Z-1.log,…,hids.…-072Z.log`（`/tmp/t045-probe-r4..r6.log`） | 平跑 5 次 → 0 MISS（其中 1 次真撞窗，detail 写「撞 rename→unlink 窗口 1 次后重采落定」）；4 个忙进程下 12 次 → 0 MISS、**3 次真撞窗**且全部重采落定 |
| 3 | `evidence/test/P003-T045/log-file.test.js:92` | 用例名「顺序文件在前」副实 → 按文档 `docs/modules/http-api.md:521`（§3.8.1「先写文件再写 stdout」）**补断言**：stdout 写回调里 `readFileSync` 回看盘面，断言那一刻文件里已有该行；用例名同步改成「先写文件再写 stdout」 | 旧断言只比两份内容相同，不比顺序 | 卡套件 16/16 绿；负对照（用公开导出 `createFileSink`/`createJournal` 拼一个「先 stdout 后文件」的 journal，临时件跑完已删）**恰红**：`AssertionError: 写 stdout 的时候文件里已经有这行了（先文件后 stdout） actual [''] expected ['{"time":"2026-11-20T00:00:00.000Z",…}']` |

- 审计提到的 `syslog-pipeline.test.js:96` 是前置风险（基提交即抖），按审计口径**不计**，本轮未动。
- 本轮改动只这两个测试件，产品代码 / 文档 / `.env.example` 零改动（`git status` 见 §七）。
- 本轮复审门禁全部重跑：卡套件 16/16、根套件 228/228、T025 14/14、探针 151 条 MISS 0，四条 exit 0（§一）。

## 一、门禁（命令原文 + 退出码，全是我亲跑）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 本卡套件 | `node --test --test-timeout=60000 --test-force-exit evidence/test/P003-T045/log-file.test.js` | `ℹ tests 16 / pass 16 / fail 0`，约 480 ms，**exit 0**（本轮又跑 50 次全绿：不加载 30 次 + 4 忙进程 20 次，见 §〇 第 1 条） |
| 根套件 | `npm test`（= `node --test --test-timeout=60000 --test-force-exit *.test.js`） | `ℹ tests 228 / pass 228 / fail 0`，784 ms，**exit 0**；随后 13 次里 2 次红在 `syslog-pipeline.test.js:96`——同一抖动在**基提交 `ed2bd30`** 上也能复现（基线 8 轮并发里红 2 轮），不是本卡引入，见 §五 第 3 条 |
| T025 键集 | `node --test --test-timeout=60000 --test-force-exit evidence/test/P003-T025/config-check.test.js` | `ℹ tests 14 / pass 14 / fail 0`，634 ms，**exit 0** |
| A6 键数 | `grep -cE '^[A-Z0-9_]+=' .env.example` | `41`，与头注「41 个键」一致 |
| 我的黑盒探针 | `node evidence/test/P003-T045/tester-acceptance.mjs` | `T045 TESTER OK 共 151 条断言，MISS 0`，**exit 0** |

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

## 四、变异验红（我在 `/tmp` 副本里盲改，工作树实现零改动）

做法：`cp -a` 整树到 `/tmp`，照**文档里写明的行号/字符串**改（不读实现），跑卡套件，再还原。

| 变异 | 改什么（文档依据） | 实跑结果 |
| --- | --- | --- |
| M1 | `server.js:929-944` 的 `not_configured` 改名（§3.8.3 失败口径） | **未红（no-op）**：这个字面量只有一处，在 `server.js:387` 的 `configError` 表里（`grep -n not_configured server.js` → 387）；路由 930/941 调 `configError()`。§3.8 说的是「分支在 929-944」，不算错锚点 |
| M1b | `server.js:929-944` 的 503 文案改名（§3.8.3 写了这句原文） | 红：`A3 GET /api/logs：…未配 503`，`pass 15 / fail 1` |
| M2 | `log.js:77` 的 `20000` → `3`（§3.8.2 上限段） | 红：`A3 readLogEntries：…total 是切页前条数`，`pass 15 / fail 1` |
| M3 | 删 `.env.example` 的 `HIDS_LOG_KEEP=` 行（A6 三键） | 红：`A6 .env.example 列出三个新键…`，`pass 15 / fail 1` |
| M4 | `log.js:16-44` 写路径 `[redacted]` → 别的串（§3.6 脱敏段） | 红：`A5 落盘与查询结果都不出现 Authorization / Cookie / Token 原文`，`pass 15 / fail 1` |
| 还原 | 三个文件都从备份盖回 | 复绿：`pass 16 / fail 0` |

## 五、minor 记录（不挡推进；第 2 条本轮已修）

1. **`openapi.yaml:354` 自相矛盾（doc-side）**：`level` 参数 description 写「逗号分隔可多选」，schema 却是 `{ type: string, enum: [info, warn, error] }`。
   实测 `GET /api/logs?level=warn,error` → 200（§3.8.2 也是这么写的），按 openapi 的 enum 校验会把合法请求判非法。
   复现：`node evidence/test/P003-T045/tester-acceptance.mjs`（A3 level 逗号多选两条）。
   改法：删掉该参数 schema 的 `enum`（取值写在 description），或改成 `type: array, style: form, explode: false`。
2. **卡套件 A1 真进程用例的 race（test-side，本轮已修）**：`log-file.test.js:126` 原先文件行一到就断言 stdout。
   §3.8.1 明写「先写文件再写 stdout」，两者之间必然有窗口。现已改成轮询 stdout 再断言，修前 1/20 红 → 修后 0/20（同负载），见 §〇 第 1 条。
3. **根套件在负载下会红（pre-existing，非本卡）**：`syslog-pipeline.test.js:96`（「…区分重复投递与跨秒行为」，`1 !== 2`），
   并发跑时 HEAD 13 次红 2 次；同一抖动在**基提交 `ed2bd30`**（`git archive ed2bd30` 解到 `/tmp` 后并发 8 轮）也红 2 轮，
   单跑 `syslog-pipeline.test.js` 两边各 25 次 0 红。结论：负载敏感的既有抖动，记残留风险，不记本卡 finding。

## 六、实测里的两条 INFO（文档没写死，不判红）

- `POST /api/logs/cleanup` **完全不带正文** → 400 `{"error":"请求正文不是 JSON","code":"caller_error"}`。§3.8.3 表里只有「正文不是 JSON 对象」→「请求正文必须是 JSON 对象」；「请求正文不是 JSON」在 §8（:772）是全局口径，行为一致，只是 §3.8.3 表没点名无正文这一档。
- `GET /api/logs?nope=1` 未知参数不报 400（§3.8.2 参数表没提未知参数）；`?event=` 空串 = 不过滤（§7 的「空串落缺省」同口径）。

## 七、树状态

```
$ git -C . status --short
 M .pi-child-claim.json                             # 引擎运行态（起活前就在，未碰）
 M evidence/test/P003-T045/log-file.test.js         # 本轮整改第 1、3 条（时序轮询 + 顺序断言）
 M evidence/test/P003-T045/tester-acceptance.mjs    # 本轮整改第 2 条（撞窗重采 + 标注）
```

产品代码 / 文档 / `.env.example` 零改动：变异全在 `/tmp` 副本（本轮 M2 重跑：`log.js:77` 的 `20000`→`3` → 卡套件 15/16 红，删副本后复绿）；
负对照与修前对照用的临时测试件跑完即删（`ls evidence/test/P003-T045/` 只剩 3 个交付件）；探针跑完自清 `mkdtemp`。
