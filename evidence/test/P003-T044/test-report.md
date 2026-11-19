# P003-T044 测试席复验报告（补测轮测试复验，2026-11-20）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T044`
- HEAD：`eaed085`（`test(data-admin): P003-T044 补测轮——401 两路由/清理回显五键/七类时刻/队列整对象 + 20 条变异自证`）
- 实现零改动实锤：`git diff 7a53058 HEAD -- server.js triage-monitor.js openapi.yaml | wc -l` → **0**；
  `git diff --name-only 7a53058 HEAD -- '*.test.js' | grep -v evidence/test` → 空（根套件零改动）
- 判据只取契约文本：`docs/modules/http-api.md` §3.7（:347）/ §3.7.1（:353）/ §3.7.2（:396）/ §3.7.2 错误表（:459-471）/
  §4 Basic 认证（:495）/ §8.1 正文上限（:641）；`openapi.yaml` 的 `DataStoreUsage`（:1451）/ `DataInventory`（:1473）/
  `DataCleanupRequest`（:1489）/ `DataCleanupResult`（:1518）。**没读实现内容**（`server.js` / `triage-monitor.js` 一行没看），
  变异脚本里的实现片段是测试席自证材料，不是我读源码得来的上下文。
- 代码审查判词：`verdicts/P003-T044-gc-backend-code-review-mwnsgihg.json`（pass）。

## 结论

**PASS。** 20 条用例 20/20 绿、根套件 210/210 绿、变异 20 条按预期红且与存档逐行一致——三条门禁全部我在自己终端里亲手跑。
另写了一份独立黑盒探针 `tester-acceptance.mjs`（73 条断言，MISS 0），把写者套件没覆盖的 HTTP 层 schema 逐字段、边界、错误码
（含正文上限、断链、空案卷、无队列时读队列文件、恰 100/101 条截断）补上。三条 `doc-side` / 残留风险不挡推进，见 §五。

## 一、门禁（每条命令原文 + 退出码，全是我亲跑）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 本卡单测 | `node --test evidence/test/P003-T044/data-admin.test.js` | `ℹ tests 20 / pass 20 / fail 0`，260ms，**exit 0**（变异前跑一遍；变异脚本跑完后复跑一遍 263ms，仍 20/20 —— 复原复绿） |
| 根套件 | `node --test --test-timeout=60000 --test-force-exit *.test.js` | `ℹ tests 210 / pass 210 / fail 0`，718ms，**exit 0** |
| 变异自证 | `bash evidence/test/P003-T044/mutation-round2.sh` | `MUTATION 汇总：20 条按预期红，0 条不符合预期`，8s，**exit 0**；输出 61 行与存档 `mutation-round2.out` `diff` **零差异**（`grep -c '✓'` = 20，无 `✗` / 「不是预期用例」） |
| 我的黑盒探针 | `node evidence/test/P003-T044/tester-acceptance.mjs` | `T044 TESTER OK 共 73 条断言，MISS 0`，**exit 0** |

变异跑完 `git status --porcelain` 只剩我这份探针，`server.js` / `triage-monitor.js` 无 diff —— 变异在 `/tmp` 副本里做，工作树实现没被碰过。

## 二、验收锚点 A1–A5 逐条

| 锚点 | 脚本出处（我核过行号在位） | 我的证据 |
| --- | --- | --- |
| A1 盘点七类 + 空态 null | `data-admin.test.js:93` 七类（13 条 `oldest_at`/`newest_at` 断言落在 :120-149）、`:155` 空态（:165 映射全 null） | 单测 20/20 绿；探针 13 条盘点 schema 断言全绿（kind 顺序、label、path 绝对、exists/count/bytes 类型、total 求和、queue.bytes＝队列文件+.archive.jsonl、logs 只认顶层）；变异 m10/m11/m14/m15 红 |
| A2 默认 dry-run / 阈值 / 回显 | `data-admin.test.js:189`（回显五键，:196-218）、`:169`、`:238`、`:254` | 单测绿；探针「顶层七键齐全 / kind/action 回显 / threshold 回显 keep=1 / older_than 带时区原样回显 / items 每条全对象且老到新 / candidates 全量 / dry-run applied=0 且盘上不动」全绿；变异 m5-m9 红 |
| A3 真删留痕 | `data-admin.test.js:300`（:307-319） | 单测绿；`git diff 7a53058 HEAD -- evidence/test/P003-T044/data-admin.test.js` 的 hunk 头只有 `:121 :149 :171 :323 :332 :419`，**:300 一带无 hunk**（A3 用例原样未动，与派活口径一致）；探针实跑 `data.cleaned` 只在 `execute:true` 出现，字段 `kind/action/count/bytes` |
| A4 已完结才可清（409 原样 + 401 补测） | `data-admin.test.js:322`（409 队列，:330-336）、`:339`（409 案卷）、`:473`（401 两路由，:473-505） | 单测绿；探针：401 无凭据/错口令/错用户名 × 两路由 → 正文「需要登录后访问」+ 四条头（`WWW-Authenticate` 原文 / `text/plain; charset=utf-8` / `no-store` / `nosniff`）；被拒的 `execute:true` 清理一个字节没动盘；409 三条非 done 原话「3 条记录状态不是 done（queued、running、failed），已完结的案件才可清理」，内存与队列文件都不动；409 案卷原话 + 一个案卷不动；变异 m1-m4、m17-m20 红 |
| A5 清完即反映 + 队列整对象 | `data-admin.test.js:363`（:385-386 整对象 deepEqual）、`:220`（inventory 与紧接 GET 一致） | 单测绿；探针「真删后原来的东西不在旧位」+「响应 inventory 与紧接着 GET deepEqual」+ 归档用例（`:264`，文件进 `.data/archive/<kind>/`、存储里不再有它）全绿；变异 m13（2!==1）、m16（整对象才红）红 |

## 三、变异验红（断言不是永真，我亲手跑）

复跑命令：`bash evidence/test/P003-T044/mutation-round2.sh`（exit 0，20/20 按预期红）。摘四条要害：

```
MUTATION 3 ✓ 红：鉴权：两条新路由都在 Basic 闸门后…（闸门失效 if (false)）
MUTATION 4 ✓ 红：鉴权…（闸门排在清理之后：401 但盘已动）  断言：401 !== 200
MUTATION 13 ✓ 红：A4 队列只清 done（delete 没把记录移出内存/落盘）
MUTATION 16 ✓ 红：A4 队列只清 done（delete 顺手改了幸存记录的字段——只有整对象 deepEqual 才红）
```

锚点机制本身是硬的（命中必须恰 1 次，红了还要对上预期用例名）；m14/m15/m16 专测「只红本轮新断言」，证明新加断言自己是活的。
输出与存档 `mutation-round2.out` 逐行一致，非编造。

## 四、我这份黑盒探针补的覆盖面（`tester-acceptance.mjs`，73 条断言）

- **schema 逐字段**：`data_dir` 绝对、`stores` 七类顺序、每类 label/path/exists/count/bytes/oldest_at/newest_at 类型与下界、
  ISO 串格式、`total` 求和、两条路由都 `Cache-Control: no-store`；
- **口径**：queue 时刻 `updated_at→saved_at→created_at` 回退、queue.bytes＝队列文件+`.archive.jsonl`、logs 只认顶层、
  断链不 500 且 bytes 按 0、空案卷 count=1/bytes=0/时刻退回目录 mtime、**无队列时 queue 读队列文件 records**（openapi §3.7.1 明写，写者套件没测）；
- **边界**：两个阈值都缺、`older_than` 等于条目时刻不进候选/早 1ms 才进、`keep=0` 全量、keep/`execute`/`action` 类型与枚举逐条、
  未知参数、正文不是对象/数组/字符串/null、**正文上限边界 8192 内 8193 外**、恰 100 条 `truncated:false` / 101 条 `true` 且 items 老到新；
- **错误码**：400 十条文案逐条对原文、401 两路由×三种凭据（正文+四头+不动盘）、409 两类原话+不动盘、503 原话+不删队列文件、盘点 POST→404。

## 五、doc-side / 残留风险（都不挡推进）

1. **`docs/modules/http-api.md:641` §8.1 的「各路由正文上限」表没登记 `/api/data/cleanup`。** §3.7.2 只承诺「过大 → 400 请求正文过大」，
   没说上限多少；我实测边界是 **8192 内通过、8193 回 400**（探针 INFO 行）。要照文档造边界用例得自己反推。建议 §8.1 表补一行「8192（缺省）｜`POST /api/data/cleanup`」。
2. **显式 `action: null` / `execute: null` 走「未给」缺省（200），与 §3.7.2 错误表字面不一致。** 错误表写「`action` 不是 archive/delete → 400」
   「`execute` 不是布尔 → 400」，而 null 实测是 200：`action:null` → `action:"archive"`、`execute:null` → `dry_run:true`。
   方向偏安全（archive + dry-run），写者套件也没覆盖这条边界；建议二选一：文档补一句「null 等同未给」，或实现按表回 400 并补一条断言。
3. **`older_than` 的数字 `0` / `1` 被当时间接受（200，`threshold.older_than` 回显数字）**，而 `1700000000` 这类数字回 400——
   差异来自 V8 `Date.parse` 的遗留解析（`Date.parse(0)` → 2000-01-01）。与文档口径「`Date.parse` 解析得出」不冲突，但 openapi 声明的是
   `type: string`。属类型宽松，非契约违约，记残留风险。
4. `evidence/recon/P003-T044.md:106`「不改已有断言」与同文件触点清单第 3 行改过 A4 delete 断言自相矛盾——**代码审查判词已点名**（minor，
   建议改一句话），我不重复登记。

## 六、现场处置

- 上一轮遗留的未跟踪探针 `evidence/test/P003-T044/coverage-audit.tester.mjs`（头注「跑完即删」）：我先跑了一遍（40 条检查 0 MISS，观测被本报告采纳），
  随后**删除**；本轮黑盒证据由 `tester-acceptance.mjs`（入库、可复跑）承接。
- 探针全部 `mkdtemp` 独立数据根、结束即 `rm -rf`；仓内 `.data/` 不存在、未被写入；`git status --porcelain` 只剩本报告与探针两个新增文件（本轮提交）。
- 没改产品代码、没改写者的 20 条用例、没顺着任何 stack trace 翻源码。
