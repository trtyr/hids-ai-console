# P003-T053 测试报告 — syslog-pipeline.test.js:96 抖动修复

**结论：pass。** 三条验收锚点全部由我在本树亲手跑出：修复前竞态我能复现（48 次负载里 1 次），修复后同一负载 0 假红（48 次单文件 + 6 次主门）；
A2 三连变异我逐个重做（含我自己写的黑盒注入，不读实现源码），红点与 actual/expected 逐项对上；`npm test` 连跑 10 次全绿。
findings：**无**。

- 被测树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T053`
- 分支 `task/hids-ai-console-P003-T053`，测试起点 HEAD `704ce3e`
- 机器：node v26.13.0 / 16 核 / 本机 SSD（flake 赔率与机器强相关，见 §6）

## 1. 被测改动（只读核对，未改任何产品代码）

```
$ git diff --stat bea34bd..704ce3e
 coding-reports/P003-T053.md | 134 ++++++++++++
 evidence/recon/P003-T053.md |  73 ++++++++++
 syslog-pipeline.test.js     |   5 ++
 3 files changed, 212 insertions(+)
$ git show bea34bd:syslog-pipeline.test.js | grep -c 'assert\.'   # 43
$ grep -c 'assert\.' syslog-pipeline.test.js                      # 43
```

**零删除、断言数 43→43、实现侧（`triage-monitor.js` / `syslog-case.js` / `syslog-input.js`）0 改动**。
新增内容是一行 `await monitor.writeChain;`（`syslog-pipeline.test.js:98`）+ 4 行注释。

文档口径核对（docs-first，别信报告，自己查）：

```
$ grep -rn 'writeChain' docs/
docs/modules/triage-pipeline.md:360:| `writeChain`（getter） | 测试与调用方当「等落盘」的同步点 | 等价于 `persist()`（`triage-monitor.js:246`） |
docs/modules/triage-pipeline.md:829:| `writeChain`（getter） | 「等落盘」的同步点，等价 `persist()` | `triage-monitor.js:246` |
```

即：修复用的是**文档写明的既有同步点**，不是新发明的等待手法。合并在设计上也有文档：`docs/modules/triage-pipeline.md:358`（热路径只标脏，写盘峰值 ≤1 次 / `persist_interval_ms`）。

## 2. A1 根因 + 确定性

### 2.1 修复后在真实负载下的确定性（我自己跑的）

```
$ for round in 1..4:  8 个并发实例跑该文件 + 每轮并行跑一次 npm test（= I/O 压力源）
$ 结果：单文件 32/32 rc=0，主门 4/4 rc=0，无任何 'fail [1-9]'
$ 加固轮：16 并发单文件 + 2 主门 → 16/16 rc=0，主门 2/2 rc=0
```

合计：**48 次单文件运行（全带并发压力）0 假红，主门 6 次 0 失败**。
证据文件：`/tmp/t053-a1/r*.log`、`/tmp/t053-a1/main-*.log`、`/tmp/t053-a1b/`（本机临时目录）。

### 2.2 修复前同负载确实会红（不是「改完就好了」）

为排除「本来就永远不红」，我把测试文件回滚到修复前（`git show bea34bd:syslog-pipeline.test.js`）、其余不动，跑同一套并发负载：

```
$ 3 轮 × 16 并发单文件 + 每轮并行一次主门
$ 结果：47 次绿 / 1 次红
$ /tmp/t053-prefixlogs/r1-2.log:
    at TestContext.<anonymous> (file:///tmp/t053-prefix/syslog-pipeline.test.js:96:10)
    actual: 1, expected: 2
$ 主门：3/3 rc=0
```

落点与卡面指纹完全一致（`:96:10`、`actual 1 / expected 2`）。**前后对照：同一负载形状，修复前 1/48 红，修复后 0/48 红。**

## 3. A2 变异自证（副本树，逐个重做）

副本树 `/tmp/t053-mut`（`tar` 复制本树，与 HEAD 树测试文件 `diff -q` 一致）。注入脚本已入库：
`evidence/test/P003-T053/probe-slow-snapshot.mjs`、`evidence/test/P003-T053/probe-drop-records.mjs`。**两只脚本我只碰公开符号**
（`TriageMonitor.prototype.writeSnapshot` 与构造选项 `file` / 快照字段 `records`，均有文档出处 `docs/modules/triage-pipeline.md:364`、`:310`），不读实现源码。

| 变异 | 命令 | 结果 |
| --- | --- | --- |
| **M1** 持久化丢记录（快照 records 截成 1 条） | `SUT=<树> node --import file://<树>/evidence/test/P003-T053/probe-drop-records.mjs --test … syslog-pipeline.test.js` | **EXIT=1**，红在 `syslog-pipeline.test.js:101:10`，`actual: 1, expected: 2` → 该断言真能失败 |
| **M2** M1 之上再删掉 `assert.equal(resumed.cases().total, 2)` | 同上（测试副本删 1 行断言） | **EXIT=1**，同文件下一条 `resumed.cases({count:1,offset:1}).cases.length === 1` 接住：`:101:10`，`actual: 0, expected: 1` → 删断言不静默 |
| **M3** 屏障守卫：删掉 `await monitor.writeChain` + 40ms 慢落盘 | `SUT=<树> node --import …probe-slow-snapshot.mjs --test …` | **3/3 EXIT=1**，红在 `:100:10`（=修复前 `:96:10` 行号），`actual: 1, expected: 2` |
| **对照** 有屏障 + 40ms 慢落盘 | 同上 | **副本树 5/5 绿**；**本树 5/5 绿**（`/tmp/t053-probe/real-*.log`）；**入库探针 2/2 绿** |

结论：断言非永真（M1/M2 能红），修复本身有守卫（M3 慢落盘 3/3 抓红），删断言换稳定这条路被同文件下一条断言堵死。

## 4. A3 主门连跑 10 次

```
$ for i in $(seq 1 10); do npm test; done
run 1..10 rc=0                # 10/10
$ grep -h '^ℹ tests|^ℹ pass|^ℹ fail' /tmp/t053-a3/*.log | sort | uniq -c
     10 ℹ fail 0
     10 ℹ pass 228
     10 ℹ tests 228
```

单文件单跑：`ℹ tests 5 / ℹ pass 5 / ℹ fail 0 / ℹ duration_ms 109`（含 40ms 探针时单跑约 100–170ms，压测预算不是问题）。

## 5. 树面 / 范围面（只读核对）

```
$ git rev-parse --abbrev-ref HEAD        → task/hids-ai-console-P003-T053
$ git log --oneline -1                   → 704ce3e docs(P003-T053): 报告补交卷时树状态原文…
$ git status --short                     → (空，除本轮我新增的 evidence/test/P003-T053/)
$ git status --porcelain -uall           → (无未跟踪残留，除上述)
$ git ls-files | grep -Ei 'auth\.json|\.env$'   → 无
```

- 未新增凭据文件（`web/src/credentials.js` 是既有源码模块，非凭据文件，本卡 diff 未触及）。
- 无迁移/删除类改动 → 「旧位目录应不存在」这条判据在本卡 **不适用**（无旧位路径）。

## 6. findings

**无。** A1/A2/A3 全部 pass，无系统行为与文档不符项，无 doc-side 缺失。

## 7. 残余风险（不影响判分，留给下一棒/下一张卡）

1. **修复前真实赔率低**：我这台机器 48 次并发里只红 1 次（卡面写约 1/8，写者实测 1/30~1/60）。所以「竞态窗口存在」靠的是 40ms 慢落盘探针的定向复现（M3 3/3 红 / 对照 5/5 绿），不是靠赔率。换更慢的盘可能赔率更高，但修复的同步点语义与赔率无关。
2. 同文件另 4 个用例仍用 `5ms × 100`（500ms）轮询预算，本轮 48+10 次没红；要统一口径属于另一张卡（写者报告 §6.2 已记）。
3. 新增注释里引用的实现行号（`triage-monitor.js:1045`、`:1075-1079`）与 `docs/modules/triage-pipeline.md:1016` 写的收尾落盘位置（`:1087-1090`）**行号不完全一致**。我按黑盒纪律不读实现源码，无法裁决哪个准；reviewer 在判词里声明行号已核（D028）。若将来有人核出注释行号错，那是注释问题，不影响屏障语义（文档 `:360`/`:829` 已给同步点定义）。
4. 环境面：本机 16 核 SSD，没有慢盘 / 低核 / CI 容器内的对照数据。

## 8. 复现命令汇总（照抄可跑）

```bash
T=$PWD   # 本树根
# 基线
npm test
node --test --test-timeout=60000 --test-force-exit syslog-pipeline.test.js
# A1 并发压测
for j in $(seq 1 16); do node --test --test-timeout=60000 --test-force-exit syslog-pipeline.test.js & done; wait
# A2 M1（断言能红）
SUT=$T node --import file://$T/evidence/test/P003-T053/probe-drop-records.mjs \
  --test --test-timeout=60000 --test-force-exit syslog-pipeline.test.js    # 期望 EXIT=1，:101:10 actual 1 expected 2
# A2 M3（删屏障则红）：把 syslog-pipeline.test.js:98 的 await monitor.writeChain; 删掉后再跑
SUT=$T node --import file://$T/evidence/test/P003-T053/probe-slow-snapshot.mjs \
  --test --test-timeout=60000 --test-force-exit syslog-pipeline.test.js    # 期望 EXIT=1，actual 1 expected 2
# A3 主门连跑
for i in $(seq 1 10); do npm test; done
```
