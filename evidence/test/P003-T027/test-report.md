# P003-T027 测试席验收报告（何东阳 / gc-backend-tester）

树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T027`，分支 `task/hids-ai-console-P003-T027`。

**本轮 = 审计第三轮打回后的第 6 轮，只改我自己的证据**。本轮动过的文件（全在 `evidence/test/P003-T027/`）：
`acceptance-e2e.mjs`、`verify.sh`、`verify-mutations.sh`、新增 `nonce-not-in-fingerprint.sh`、新增 4 个 `clean-tree-*.txt`（干净树重放输出）、4 个 `*-output.txt` 重新生成、本报告。

产品代码与文档本轮**零改动**：

```console
$ for c in 313acfe d125110 add6df9 9ea8f2b; do git show --stat --format='%s' $c; done | grep -v '^ evidence/' | grep '|'
（无输出：本席 4 个 commit 只碰 evidence/ 目录）
$ git rev-parse HEAD
9ea8f2b7a04398f41095e293e803b1d187314932      # 干净树重放用的就是这个 commit
```

## 0 审计打回的五条，逐条处置

| 打回项 | 处置 | 证据 |
| --- | --- | --- |
| **E 依赖工作树里碰巧有的 untracked `.data`**：干净树上全绿，脚本自报「断言永真」 | **E 的前置态由脚本自己种，不读工作树 `.data`**：把整棵树复制到临时目录 → 在副本树里用 `P27_KEEP_RUN_ROOT=1` 真跑一遍探针，拿系统自己写出的运行态当种子 → 挑出本轮那条 honeypot 记录改 `status=running`、`case_dir` 指到副本树内 → 写进副本树的 `.data/triage-monitor.json`。未变异的探针在副本树里必须 17/17 绿（隔离生效），变异探针（skip 里去掉 `.data`）必须红 | `verify-mutations.sh` §E；干净树实测 `clean-tree-mutations-output.txt`：`E-对照 … 17/17 PASS 运行根带.data=false` → `E EXIT=1 16/17 … 运行根带.data=true` |
| **报告把 E 写成「恰 1 条正控」**，实测六次全 1 条、红的是数值断言 | **两件都做了**：① 报告如实改写——E 里重放的 running 记录抢在本轮报文前到，探针随即把上游打开成 500，本轮那条 honeypot 因此以「牧云事件查询失败」落日志、不计入 `twAll`，**所以 E 的条数是 1，红的是数值断言（540≠480）**；② 另做变异 **F** 专测条数断言活性：重复一条同指纹 honeypot 报文（不同秒）并推迟 2 秒打开上游故障，两条都跑完 → **条数=2，恰 A2-3 红** | `clean-tree-mutations-output.txt`：`E … 条数=1 失败项：A2-3`、`F … 条数=2 失败项：A2-3`；F 的失败项只有 A2-3（脚本断言 A2-4 不许连带红） |
| nonce 证据要脚本 | 新增 `nonce-not-in-fingerprint.sh`：照 `triage-pipeline.md` §4.1 的 `fingerprint()` 用法跑两遍换 nonce，并加正对照（改 `source_ip` 必须变），结论不成立就非 0 退出；`verify.sh` 第 5 步跑它 | `nonce-not-in-fingerprint.txt`（脚本输出，EXIT=0） |
| `verify.sh` 的隔离校验在无 `.data` 的机器上空转 | 改成**整棵 `.data` 的文件指纹（相对路径+sha256）+ 存在性 + 目录数**；`.data` 原本不存在 ⇒ 跑完必须仍不存在；并逐遍断言探针自报「`.data` 未随树带过来」 | 干净树实测（`.data` 本就不存在）：`clean-tree-verify-output.txt` §1 `存在=no 文件树指纹=absent 目录数=0` → §6 同样 absent + 「跑完仍不存在（这条以前是空转，现在真判）」 |
| 维护端口写死 18593 | 向内核要空闲端口再经 `HIDS_MAINTENANCE_PORT` 传入（`architecture.md:59`、`:464`），被占换端口重试最多 3 次；A1-1 断言回显端口 == 传入端口，A1-2 断言 message 里的 URL 用的是同一个端口 | `acceptance-e2e-output.txt`：`传入端口=41276 回显={…,"port":41276,…}`（每次跑不同） |

## 1 结论

**PASS**。审计五条逐条闭合，两次全套亲跑（工作树 + `git archive` 干净树）都过：

- 探针 **17/17**：连跑 6 遍 + sleep 2 前后对照 4 遍 = 10 遍，每遍 `EXIT=0`、运行根各不相同、每遍自报「`.data` 未随树带过来：false」、跑完零残留（`verify-output.txt` / `clean-tree-verify-output.txt`，`ALL GREEN`）。
- 写者门禁 `logging.test.js` **13/13**（同上两份输出第 4 步）。
- 根后端套件 **198/197/1**，唯一红是改前既有的 `maintenance-startup.test.js`（`git diff --quiet 8f500ae -- maintenance-startup.test.js` → exit 0，逐字节相同）。
- 变异 **A/B/C/D/E/F 六条全部恰红到期望项，还原后复绿**（`verify-mutations-output.txt` / `clean-tree-mutations-output.txt`，`MUTATIONS OK`）。干净树上没有任何一条变异靠工作树遗留物变红。

## 2 E 的真根（上一轮已查清，本轮改成自种前置态）

### 2.1 复现：旧探针（nonce 修法）在同一棵树上连跑两遍就红

```console
$ git show add6df9:evidence/test/P003-T027/acceptance-e2e.mjs > _old-probe.tmp.mjs
$ timeout 300 node _old-probe.tmp.mjs     # 修前探针
FAIL A2-3 time_window 分支（窗外有候选）
  实测: {…,"rule":"time_window","type":"honeypot","msgid":"cloudwalker-honeypot","candidates":2,"nearest_gap_seconds":724,…}
==== 15/16 PASS ====         # 第 2 遍 482，第 3 遍 550…
```
全文见 `audit-repro-old-probe.txt`（该文件是上一轮现场，保留）。

### 2.2 为什么漏：两条文档写明的机制

1. **运行态目录恒为「模块所在目录/.data」，不吃环境变量**（`docs/modules/http-api.md:42`）——探针直接在工作树里起 `server.js`，读写的就是工作树里的 `.data/`。
2. **上次进程中断时留在 `running` 的记录，下次 `start()` 改判 `queued` 重新排队**（`docs/modules/triage-pipeline.md` §5.1）——上一轮拿上一轮 `parsed` 配本轮假上游，`nearest_gap` 按两轮启动差漂。

### 2.3 为什么 nonce 修不了：指纹里根本没有它

`docs/modules/triage-pipeline.md` §4.1 把参与指纹的字段逐项列死（固定部分 = 主机 IP / MsgId / 事件名；honeypot 类型再加 `source_ip`/`target_ip`/`target_port`），`nonce` 不在任何一档。脚本实测（`nonce-not-in-fingerprint.txt`）：

```console
nonce=run1-1 -> a5c222bee141bc9a
nonce=run2-2 -> a5c222bee141bc9a
换 nonce 后指纹是否相同 -> true
对照：只改 source_ip 后指纹是否改变 -> true      # 正对照：脚本量得出变化，不是恒等
```

## 3 修法（只改探针与验证脚本，产品代码一个字节没动）

1. **独立运行根**：`makeRunRoot()` 把源码树整份复制到 `os.tmpdir()/p27-root-*`，过滤 `.git` / `.data` / `evidence`；`server.js`、`maintenance-server.js`、`package-policy.js` 全部 `cwd: RUN_ROOT` 起；退出时删根。工作树 `.data` 一个字节不碰（A2-5 每次校验）。
2. **撤掉 nonce**：报文里不再塞 nonce；结论改由 `nonce-not-in-fingerprint.sh` 承担。
3. **跨报文断言避开同秒折叠**：四条报文秒数各差 60 秒、msgid 不同；A2-3 断言「本轮 honeypot time_window 失败恰 1 条 + `window_seconds=300 / candidates=2 / nearest_gap_seconds=480`」。
4. **维护端端口动态**：`freePort()` 向内核要空闲端口，`HIDS_MAINTENANCE_PORT` 传入，回显端口必须相等。
5. **两个测试钩子**（只给 `verify-mutations.sh` 用，人工跑不传）：
   - `P27_KEEP_RUN_ROOT=1`：保留运行根并打印 `[run-root-kept] <path>`——变异脚本取「系统自己写出来的运行态」当种子。
   - `P27_BASE_SECOND=<秒>`：钉死事件时间基准，重放记录算出的 `nearest_gap` 才是可复算的定值（E 里种子轮 `B`、复跑轮 `B+60` → 540）。

探针本轮改动量（未含脚本）：

```console
$ git show --stat 9ea8f2b | grep acceptance-e2e
 evidence/test/P003-T027/acceptance-e2e.mjs | 57 +++++++++++++--
```

## 4 自测（本终端亲跑）

### 4.1 工作树

```console
$ timeout 900 bash evidence/test/P003-T027/verify.sh            # EXIT=0
…
== 2. 连跑 6 遍 ==
run1 EXIT=0 ==== 17/17 PASS ==== 带.data=false [run-root] /tmp/p27-root-Ta3eHa
…（run2..run6 同，17/17）
== 3. sleep 2 前后对照 ==
gap0-A / gap0-B / gap2-C / gap2-D 全 EXIT=0 ==== 17/17 PASS ====
== 4. 写者门禁 == gate EXIT=0 / ℹ tests 13 / pass 13 / fail 0
== 5. nonce 结论脚本 == nonce EXIT=0（换 nonce 指纹相同 true；对照改 source_ip 改变 true）
== 6. 隔离校验 == 存在=yes 文件树指纹=8e674a0c… 前后一致 目录数=9 运行根残留=0
== 汇总 == ALL GREEN
```

根后端套件：

```console
$ timeout 900 node --test *.test.js
ℹ tests 198 / pass 197 / fail 1
✖ maintenance CLI starts when the deployment current path is a symlink
$ git diff --quiet 8f500ae -- maintenance-startup.test.js; echo $?
0        # 与 base 逐字节相同，红是改前既有（工作树扁平布局，没有 backend/ 子目录）
```

### 4.2 干净树重放（审计要求：全部改完在 git archive 树上重放全部命令）

```console
$ git rev-parse HEAD
9ea8f2b7a04398f41095e293e803b1d187314932
$ CLEAN=$(mktemp -d /tmp/p27-clean-XXXXXX); git archive HEAD | tar -x -C "$CLEAN"
$ cd "$CLEAN"; ls .git .data
ls: cannot access '.git': No such file or directory
ls: cannot access '.data': No such file or directory
$ find . -type f | wc -l
625
$ timeout 900 bash evidence/test/P003-T027/verify.sh ; echo EXIT=$?
…
== 1. 仓内运行态基线 == 存在=no 文件树指纹=absent 目录数=0
== 2. 连跑 6 遍 == run1..run6 全 EXIT=0 ==== 17/17 PASS ==== 带.data=false
== 3. sleep 2 前后对照 == 四遍全 17/17
== 4. 写者门禁 == gate EXIT=0 / 13/13
== 5. nonce 结论脚本 == nonce EXIT=0
== 6. 隔离校验 == 存在=no 文件树指纹=absent 目录数=0；.data 原本不存在，跑完仍不存在（这条以前是空转，现在真判）；运行根残留=0
== 汇总 == ALL GREEN
EXIT=0
$ timeout 1200 bash evidence/test/P003-T027/verify-mutations.sh ; echo EXIT=$?
…（见 §4.3）
== 汇总 == MUTATIONS OK
EXIT=0
$ timeout 300 node evidence/test/P003-T027/acceptance-e2e.mjs ; echo EXIT=$?
==== 17/17 PASS ====
EXIT=0
$ timeout 900 node --test *.test.js
ℹ tests 198 / pass 197 / fail 1   # 仍是既有的 maintenance-startup.test.js
```

原始输出落盘：`clean-tree-verify-output.txt`、`clean-tree-mutations-output.txt`、`clean-tree-acceptance-e2e-output.txt`、`clean-tree-suite-output.txt`。

### 4.3 变异（`bash evidence/test/P003-T027/verify-mutations.sh`）

干净树实测（工作树结果逐条相同）：

| 变异 | 结果 | 说明 |
| --- | --- | --- |
| A 假上游去掉 `created_at` | **16/17，恰 A2-3 红** | 数值断言绑在 `nearest_gap_seconds` 上，删字段必红 |
| B 不发第一条报文（payload 分支） | **14/17：A2-1 / A4-1 / A3-1 红** | A3-1 正控生效：管道少一条时「凭据零命中」不再白捡通过 |
| C `docs/architecture.md:134` 关键字段 `type` → `event_type` | **16/17，恰 A4-1 红** | 期望真绑在文档上 |
| D 删掉 `docs/architecture.md:134` 整行 | **16/17，恰 A4-1 红** | 不认「文档里出现过这名字」，认「表里有这行」 |
| E **隔离失效**（运行根也复制 `.data`，前置态脚本自种） | **16/17，恰 A2-3 红；运行根带.data=true；`nearest_gap=540`** | 重放的 running 记录抢在本轮报文前到 → 540≠480。**条数是 1**（本轮那条被上游 500 打掉，不计入）——所以 E 证明的是数值断言，不是条数断言（见 F） |
| F **条数断言活性**（同指纹 honeypot 再发一条 + 推迟 2 秒打开上游故障） | **16/17，恰 A2-3 红；条数=2** | 专测 A2-3 的「恰 1 条」不是永真；A2-4 未连带红 |
| 还原 | `cmp` 与备份一致；探针 `a0fea342…`、文档 `87119c19…`；副本树探针也一致；还原后 17/17 复绿；运行根残留 0 | 无残留 |

E 的完整过程（干净树原样）：

```console
== 变异 E：隔离失效（运行根也带 .data）——前置态本脚本自己种 ==
  种子轮：在副本树里真跑一遍取运行态（P27_BASE_SECOND=1795092257，保留运行根）
  种子态：/tmp/p27-root-RjVjVW/.data/triage-monitor.json（==== 17/17 PASS ====）
  种下 running 记录：syslog:honeypot:63b1e344fffb1c61:1795092377:a232667a-…（事件时间 2026-11-19 12:46:17）
E-对照（未变异，种了 .data 也不该进运行根） EXIT=0 ==== 17/17 PASS ==== 运行根带.data=false
E EXIT=1 ==== 16/17 PASS ==== 运行根带.data=true 条数=1 失败项：A2-3 time_window 分支（窗外有候选，且本轮恰 1 条）
```

## 5 逐条验收

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A1 三文件 `console.*` 清零、走 `log.js` | pass | `grep -c "console\." maintenance-server.js package-policy.js syslog-case.js` → 0/0/0；A1-1/A1-2 真启动行（端口动态传入并回显）、A1-3/A1-5/A1-6 三条 CLI、A1-7/A1-8 边界非 0 退出 |
| A2 四条 rule 失败真日志带 `rule` 与差在哪 | pass | A2-1..A2-4 全 PASS（含 A2-5 隔离校验）：payload `missing:["host_ip"]`、event_id `mismatch.host_ip{10.0.0.5→10.0.0.6}`、time_window `window_seconds:300 candidates:2 nearest_gap_seconds:480`（恰 1 条）、查询失败 `reason:"牧云事件查询失败：牧云 /rpc 500 …"` |
| A3 凭据不落日志 | pass | 报文塞 `api_token=SECRET123456 password=hunter2 authorization=Bearer abcdef123456`、上游错误里塞 token、两个口令环境变量配真值 → A3-1/A3-2/A3-3 零命中，同批日志出现 `[redacted]`；A3-1 带正控（三条 match_failed 到齐，变异 B 实测） |
| A4 事件名表同步 | pass | `docs/architecture.md:134` 关键字段列 = `rule` `msgid` `type` `reason`（+差在哪字段），与真日志键集合逐键对上；缺键/缺行/写错名必红（变异 C/D） |

## 6 findings

### F1（major，route_coding）— **已闭合**｜`syslog.match_failed` 实际字段是 `type`，文档曾写 `event_type`

文档已改 `type`（`d0ecaca`），探针 A4-1 读文档解析后 17/17；改回 `event_type` 探针恰红（§4.3 变异 C）。

### F2（minor，test-quality）— **已闭合**｜假上游没给 `created_at`，`nearest_gap_seconds` 恒 null

假上游已补 `created_at`，A2-3 断言 480；去掉即红（变异 A）。

### F3（minor，doc-side，未闭合，不阻塞本卡）`msgid_map` 在真管道上不可达

- 文档出处：`docs/architecture.md:146` 的 rule 取值表把 `msgid_map` 列为 `syslog.match_failed` 的取值之一，并说「每条失败分支都从这里出」。
- 实测：UDP 送未知 MsgId → `{"event":"syslog.skipped","reason":"no_agent_for_msgid",…}`，没有 `syslog.match_failed`（与 `docs/modules/triage-pipeline.md:189` 一致）。
- 建议：文档注明「`msgid_map` 只在直接调用 `matchSyslogEvent` 时成立，UDP 路径到不了」。

### F4（minor，test-quality）— **已闭合**｜门禁的「事件名表同步」用例曾抓不住缺行

`logging.test.js` 按首列找行 + 文档字段 vs 真日志逐键对账；改文档必红（变异 C：12/13；变异 D：11/13；还原 13/13）。

### F5（minor，既有，不计本轮）`triage-monitor.js` 锚点族漂移

`docs/modules/triage-pipeline.md:743-744` 引用 `triage-monitor.js:40/52/41/53`，实测 `watermarkIds` 在 50/70/94。base `8f500ae` 这两行与现在逐字相同，属改前既有，另开卡修。

### F6（minor，test-quality）— **已闭合**｜「nonce 修法」是假绿，真根是跨轮运行态

- 「每轮报文塞独立 nonce → 指纹唯一 → 6 连跑全绿」**作废**：指纹里没有 nonce（`triage-pipeline.md` §4.1；`nonce-not-in-fingerprint.sh` 实测两次指纹相同，正对照能变）。
- 真根两条：①运行态目录恒为仓内 `.data` 且不吃环境变量（`http-api.md:42`）；②上次中断留下的 `running`/`queued` 记录下次启动改判 `queued` 重新排队（`triage-pipeline.md` §5.1）。
- 修法：独立临时运行根；nonce 撤掉。探针隔离问题，不改产品代码。

### F7（minor，test-quality）— **本轮闭合**｜变异 E 依赖工作树 untracked `.data`，干净树上是空转

- 实测（上轮）：`git archive` 干净树上 E 不变红，脚本自己打「断言永真」；红的前提是工作树里恰好躺着我前几轮留下的 `.data`。
- 修法：E 自己造前置态（副本树 + `P27_KEEP_RUN_ROOT=1` 真跑一轮取系统运行态 + 写一条 `status=running` 的 honeypot 记录），并要求「未变异对照必须绿、变异后 `运行根带.data=true`」。
- 证据：`clean-tree-mutations-output.txt` §E（干净树 16/17，`带.data=true`，`nearest_gap=540`）。

### F8（minor，test-quality）— **本轮闭合**｜报告把 E 说成「恰 1 条正控」，与实际不符

- 实测：E、以及之前 6 连跑，honeypot `time_window` 条数都是 1；E 红的是数值断言（540≠480）。原因是重放的 running 记录先到、探针随即把上游打开成 500，本轮那条以「牧云事件查询失败」落日志、不计入条数。
- 处置：报告如实改写；另加变异 F 专测条数断言（`条数=2` 恰红 A2-3、不带红 A2-4），两种口径都有实测。
- 证据：`clean-tree-mutations-output.txt` §E / §F。

### F9（minor，test-quality）— **本轮闭合**｜`verify.sh` 隔离校验在无 `.data` 的机器上恒真 + 维护端口写死 18593

- 旧校验 `sha256sum .data/triage-monitor.json 2>/dev/null`：没有 `.data` 时前后都是空串，相等 ⇒ 空转。
- 现校验：整棵 `.data` 文件指纹 + 存在性 + 目录数；absent⇒absent 真判；逐遍断言运行根不带 `.data`。干净树实测走的就是 absent 分支（`clean-tree-verify-output.txt` §1/§6）。
- 维护端口：`freePort()` 动态取端口经 `HIDS_MAINTENANCE_PORT` 传入并断言回显相等（A1-1/A1-2）。

## 7 残余风险 / 没查清

1. `nearest_gap_seconds` 取上游事件哪个字段（实测 `created_at` 给出即有值），文档只写「最近一条差多远」没写取值字段——doc 侧可补，探针断言按本数据构造钉在 480。
2. 探针每次复制源码树到 `/tmp`（约 5MB、~60ms/次）；将来 `server.js` 若要 `node_modules` 或绝对路径配置，复制根会失效——本卡无依赖（`package.json` 无 dependencies），现状成立。
3. 变异 E 的种子记录 `case_dir` 被改写到副本树内（原值是上一轮临时根的绝对路径，已删）——这是测试夹具的路径调整，不影响 `status=running` 与水印重放这条被测行为。
4. E 里「条数」不进正控的原因已查清（上游 500 先于本轮记录生效），不是没查清；条数断言活性改由 F 证明。
5. 匹配失败的日志量未限流（写者未决 6），本卡不涉及，未测。
6. 全仓 `node --test`（含 `web/test`）跑不完，既有状况；本席只对根后端套件 + 本卡门禁负责。
7. `maintenance-startup.test.js` 既有红已亲验与 base 逐字节相同，本轮不修（扁平布局）。
8. 探针 A4-1 的期望来自文档：文档若把「差在哪」字段从关键字段列搬走，探针会因期望变少而变松——这是「期望来自文档」的固有代价，门禁侧 `logging.test.js` 同口径；不另记 finding。
