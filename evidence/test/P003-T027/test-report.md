# P003-T027 测试席验收报告（何东阳 / gc-backend-tester）

树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T027`，分支 `task/hids-ai-console-P003-T027`。

**本轮 = 审计二次打回后的第 5 轮，只改我自己的证据**：`git diff --stat` = `acceptance-e2e.mjs` + `acceptance-e2e-output.txt` 两个跟踪文件，外加本轮新增的 5 个证据文件（`verify.sh` / `verify-output.txt` / `verify-mutations.sh` / `verify-mutations-output.txt` / `audit-repro-old-probe.txt` / `nonce-not-in-fingerprint.txt`）。产品代码与文档零改动（`git status --short` 里除本席证据外只有 `.pi-child-claim.json`）。

## 0 审计打回的三条，逐条处置

| 打回项 | 处置 | 证据 |
| --- | --- | --- |
| nonce 修法无效，fingerprint 不含 nonce | **整套撤掉**（报文里不再有 nonce，注释写明为什么不进指纹） | `nonce-not-in-fingerprint.txt`（用文档 §4.1 给的 `fingerprint()` 用法实测：换 nonce 指纹不变，`57ec0c75b67a4010` 两次相同） |
| server 启动重放 persisted 的 running/queued 记录，拿上一轮 parsed 配本轮假上游，`nearest_gap` 漂 | **每次跑复制源码树到独立临时根（不带 `.data`）**，server / maintenance / package-policy 全在里面跑，跑完删 | `acceptance-e2e.mjs`（`makeRunRoot()` + `cwd: RUN_ROOT`）；`audit-repro-old-probe.txt`（修前 15/16、gap 724/482）VS `verify-output.txt`（修后 6 连跑 + sleep 2 对照全 17/17） |
| 跨报文 match_failed 断言要避开 sameSecond 塌缩 | 四条报文**秒数各差 60 秒、msgid 各自不同**（`triage-pipeline.md` §4.2 同秒折叠只看「指纹 + 事件秒」）；A2-3 再加「本轮 honeypot time_window 失败恰 1 条」的数量正控 | §4 变异 E：隔离一撤，A2-3 必红 |

## 1 结论

**PASS**。A1/A2/A3/A4 全部本终端亲跑通过，审计三条逐条闭合：

- 探针 17/17：**连跑 6 遍**（每遍运行根都不同、跑完零残留）+ **sleep 2 前后对照 4 遍**（无间隔 A/B、sleep 2 后 C 并紧接着 D），10 遍全 `EXIT=0`、全 17/17（`verify-output.txt`，`ALL GREEN`）。
- 写者门禁 `logging.test.js` 13/13（`EXIT=0`）。
- 根后端套件 198/197/1，唯一红是改前既有的 `maintenance-startup.test.js`（`git diff --quiet 8f500ae -- maintenance-startup.test.js` → 与 base 逐字节相同，exit 0）。
- 变异验证 5 条全部恰红到期望项、还原后复绿（`verify-mutations-output.txt`，`MUTATIONS OK`）。

## 2 审计那三条的真根（本终端复现，不是转录）

### 2.1 复现：修前探针在同一棵树上连跑两遍就红

```console
$ git show HEAD:evidence/test/P003-T027/acceptance-e2e.mjs > _old-probe.tmp.mjs
$ timeout 300 node _old-probe.tmp.mjs     # 修前探针（nonce 修法）
FAIL A2-3 time_window 分支（窗外有候选）
  实测: {…,"rule":"time_window","type":"honeypot","msgid":"cloudwalker-honeypot","candidates":2,"nearest_gap_seconds":724,…}
==== 15/16 PASS ====         # 第 2 遍 482，第 3 遍 550…
```

`nearest_gap_seconds` 每遍不一样（480 → 481 → 482 → 550 → 724），不是数据构造错，是**上一轮的运行态漏进来了**。全文见 `audit-repro-old-probe.txt`。

### 2.2 为什么漏：两条文档写明的机制

1. **运行态目录恒为「模块所在目录/.data」，不吃环境变量**（`docs/modules/http-api.md:42`）——探针直接在工作树里起 `server.js`，读写的就是我上一轮留下的 `.data/`。
2. **上次进程中断时留在 `running` 的记录，下次 `start()` 改判 `queued` 重新排队**（`docs/modules/triage-pipeline.md` §5.1）——探针 SIGTERM 收尾时手里总有 1～3 条没跑完的记录；下一轮启动后它们被重新排队，**拿着上一轮的 `parsed`（上一轮的事件时间）去配本轮的假上游事件**，于是 `nearest_gap` 按「两轮启动差几秒」漂。实测 `.data/triage-monitor.json` 里就躺着 `running:1 / queued:2` 这种记录。
3. 同一份去重表还跨进程持久：同指纹报文会被 §4.2 的「五分钟内再次到达」叠 `occurrence_count`，同秒则直接折叠（`syslog.collapsed`），match_failed 可能一条不出。

### 2.3 为什么 nonce 修不了：指纹里根本没有它

`docs/modules/triage-pipeline.md` §4.1 把参与指纹的字段逐一列死（固定部分 = 主机 IP / MsgId / 事件名；其余按事件类型分三档），`nonce` 不在任何一档。用文档给出的 `fingerprint()` 用法实测（`nonce-not-in-fingerprint.txt`）：

```console
nonce=run1-1 -> 57ec0c75b67a4010
nonce=run2-2 -> 57ec0c75b67a4010
换 nonce 后指纹是否相同 -> true
```

所以上一轮报告里「加 nonce 后 6 连跑全绿」是**假绿**：那 6 遍恰好各自没撞上重放/折叠的窗口，不是 nonce 起了作用。这条已从修法里撤掉，报告里原先的因果也一并改掉（见 §6 F6）。

## 3 修法（只改探针，产品代码一个字节没动）

1. **独立运行根**：`makeRunRoot()` 把源码树整份复制到 `os.tmpdir()/p27-root-*`，过滤掉 `.git` / `.data` / `evidence`；`server.js`、`maintenance-server.js`、`package-policy.js` 全部 `cwd: RUN_ROOT` 起；`process.on('exit')` 删根。运行态从空开始，上一轮的队列、去重表、记录、cases 一条都进不来。仓内 `.data` 一个字节不碰（A2-5 校验）。
2. **撤掉 nonce**：报文里不再塞 nonce，注释改成「指纹只取固定字段 + 分类型字段（§4.1），nonce 不进指纹」。
3. **跨报文断言避开同秒折叠**：四条报文秒数各差 60 秒、msgid 不同；A2-3 从「找第一条」改成「**本轮 honeypot time_window 失败恰 1 条**」并断言 `window_seconds=300 / candidates=2 / nearest_gap_seconds=480`——多一条（重放）或数值不对都红。

探针改动量：

```console
$ git diff --stat
 evidence/test/P003-T027/acceptance-e2e-output.txt | 26 ++++----
 evidence/test/P003-T027/acceptance-e2e.mjs        | 76 +++++++++++++++++------
```

## 4 自测（审计的复现法，本终端亲跑）

跑法一条命令：`bash evidence/test/P003-T027/verify.sh`（每个外部命令带 timeout；探针自己 `waitExit`/SIGKILL 收尾）。全文在 `verify-output.txt`：

```console
$ timeout 900 bash evidence/test/P003-T027/verify.sh
== 0. 探针不含固定 sleep ==
sleep( 计数 = 0
== 1. 仓内运行态基线 ==
before=a9efbf09d1c3d5eb54b23a4a4a1c9b66fb2f0540892bf5b4bcab825cf6595ea8
== 2. 连跑 6 遍 ==
run1 EXIT=0 ==== 17/17 PASS ==== [run-root] /tmp/p27-root-9QqPsx
run2 EXIT=0 ==== 17/17 PASS ==== [run-root] /tmp/p27-root-aDigcs
run3 EXIT=0 ==== 17/17 PASS ==== [run-root] /tmp/p27-root-FyAaYg
run4 EXIT=0 ==== 17/17 PASS ==== [run-root] /tmp/p27-root-C5AWTs
run5 EXIT=0 ==== 17/17 PASS ==== [run-root] /tmp/p27-root-sHI47S
run6 EXIT=0 ==== 17/17 PASS ==== [run-root] /tmp/p27-root-vF1cqv
== 3. sleep 2 前后对照 ==
gap0-A EXIT=0 ==== 17/17 PASS ====
gap0-B EXIT=0 ==== 17/17 PASS ====
gap2-C EXIT=0 ==== 17/17 PASS ====
gap2-D EXIT=0 ==== 17/17 PASS ====
== 4. 写者门禁 ==
gate EXIT=0
ℹ tests 13
ℹ pass 13
ℹ fail 0
== 5. 隔离校验 ==
after=a9efbf09d1c3d5eb54b23a4a4a1c9b66fb2f0540892bf5b4bcab825cf6595ea8
运行根残留=0
== 汇总 ==
ALL GREEN（日志在 /tmp/p27-verify-7uQ40x）
EXIT=0
```

根后端套件（含既有红，不属本卡）：

```console
$ timeout 500 node --test *.test.js
ℹ tests 198 / pass 197 / fail 1
✖ maintenance CLI starts when the deployment current path is a symlink
EXIT=1
$ git diff --quiet 8f500ae -- maintenance-startup.test.js; echo $?
0        # 该文件与 base 逐字节相同，红是改前既有（工作树扁平布局，没有 backend/ 子目录）
```

### 4.1 变异验证（`bash evidence/test/P003-T027/verify-mutations.sh` → `verify-mutations-output.txt`）

| 变异 | 结果 | 说明 |
| --- | --- | --- |
| A 假上游去掉 `created_at` | **16/17，恰 A2-3 红** | A2-3 绑在数值上，删字段必红 |
| B 不发第一条报文（payload 分支） | **14/17：A2-1 / A4-1 / A3-1 红** | A3-1 正控生效：管道少一条时「凭据零命中」不再白捡通过 |
| C `docs/architecture.md:134` 关键字段 `type` → `event_type` | **16/17，恰 A4-1 红** | 期望真绑在文档上 |
| D 删掉 `docs/architecture.md:134` 整行 | **16/17，恰 A4-1 红** | 不认「文档里出现过这名字」，认「表里有这行」 |
| E **隔离失效**（`.data` 也复制进运行根） | **16/17，恰 A2-3 红** | 重放记录抢在本轮报文前到，`nearest_gap` 583 ≠ 480——A2-3 的「恰 1 条」正控就是为这一条设的 |
| 还原 | `cmp` 与备份一致、`sha256sum` 探针 `6fac53ef…`、文档 `87119c19…`；还原后 17/17 复绿 | 无残留 |

## 5 逐条验收

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A1 三文件 `console.*` 清零、走 `log.js` | pass | `grep -c "console\." maintenance-server.js package-policy.js syslog-case.js` → 0/0/0；真进程启动行落 `maintenance.listening`（A1-1/A1-2），三条 CLI 走法落 `policy.*`（A1-3/A1-5/A1-6），退出码 0/0/1，边界 A1-7/A1-8 非 0 退出 |
| A2 四条 rule 失败真日志带 `rule` 与差在哪 | pass | A2-1..A2-4 全 PASS（含 A2-5 隔离校验）：payload `missing:["host_ip"]`、event_id `mismatch.host_ip{10.0.0.5→10.0.0.6}`、time_window `window_seconds:300 candidates:2 nearest_gap_seconds:480`（**恰 1 条**）、查询失败 `reason:"牧云事件查询失败：牧云 /rpc 500 …"` |
| A3 凭据不落日志 | pass | 报文塞 `api_token=SECRET123456 password=hunter2 authorization=Bearer abcdef123456`、上游错误里塞 token、`HIDS_MAINTENANCE_PASSWORD`/`HIDS_BASIC_AUTH_PASSWORD` 配真值 → A3-1/A3-2/A3-3 零命中，同批日志出现 `[redacted]`；**A3-1 带正控**（三条 match_failed 到齐，否则红，变异 B 实测） |
| A4 事件名表同步 | pass | `docs/architecture.md:134` 关键字段列 = `rule` `msgid` `type` `reason`（+差在哪字段），与真日志键集合逐键对上；探针 A4-1 读文档解析，缺键/缺行/写错名必红（变异 C/D） |

## 6 findings

### F1（major，route_coding）— **已闭合**｜`syslog.match_failed` 实际字段是 `type`，文档曾写 `event_type`

文档已改 `type`（`d0ecaca`），探针 A4-1 读文档解析后 17/17；改回 `event_type` 探针恰红（§4.1 变异 C）。

### F2（minor，test-quality）— **已闭合**｜假上游没给 `created_at`，`nearest_gap_seconds` 恒 null

假上游已补 `created_at`（候选 +600s/+900s、事件时间 +120s → 480），A2-3 断言 480；去掉即红（变异 A）。

### F3（minor，doc-side，未闭合，不阻塞本卡）`msgid_map` 在真管道上不可达

- 文档出处：`docs/architecture.md:146` 的 rule 取值表把 `msgid_map` 列为 `syslog.match_failed` 的取值之一，并说「每条失败分支都从这里出」。
- 实测：UDP 送未知 MsgId → `{"event":"syslog.skipped","reason":"no_agent_for_msgid",…}`，没有 `syslog.match_failed`（接收侧先按 `syslog-input.js` 映射表跳过，与 `docs/modules/triage-pipeline.md:189` 一致）。
- 建议：文档注明「`msgid_map` 只在直接调用 `matchSyslogEvent` 时成立，UDP 路径到不了」，否则按 rule 分桶的看板永远少一个桶。

### F4（minor，test-quality）— **已闭合**｜门禁的「事件名表同步」用例曾抓不住缺行

`logging.test.js` 现按首列找行 + 文档字段 vs 真日志逐键对账；改文档必红（变异 C：12/13；变异 D：11/13；还原 13/13）。

### F5（minor，既有，不计本轮）`triage-monitor.js` 锚点族漂移

`docs/modules/triage-pipeline.md:743-744` 引用 `triage-monitor.js:40/52/41/53`，实测 `watermarkIds` 在 50/70/94。base `8f500ae` 的这两行与现在逐字相同，属改前既有，另开卡修。

### F6（minor，**test-quality，本轮重写**）｜「nonce 修法」是假绿，真根是跨轮运行态

- 上一轮报告写的「每轮报文塞独立 nonce → 指纹唯一 → 6 连跑全绿」**作废**：指纹里没有 nonce（`triage-pipeline.md` §4.1 字段清单；`nonce-not-in-fingerprint.txt` 实测两次指纹相同），nonce 改不动去重表。
- 真根两条：①运行态目录恒为仓内 `.data` 且不吃环境变量（`http-api.md:42`）；②上次中断留下的 `running`/`queued` 记录下次启动改判 `queued` 重新排队（`triage-pipeline.md` §5.1），拿上一轮 `parsed` 配本轮假上游 → `nearest_gap` 漂（实测 481/482/550/583/724）。
- 修法：每次都起独立临时运行根（`makeRunRoot()`），仓内 `.data` 零写入（A2-5 每次校验 sha256 前后一致）；nonce 撤掉。
- 这是探针隔离问题，产品行为不变，不改产品代码。

## 7 残余风险 / 没查清

1. `nearest_gap_seconds` 取上游事件的哪个字段（实测 `created_at` 给出即有值），文档只写「最近一条差多远」没写取值字段——doc 侧可补，探针断言按本数据构造钉在 480。
2. 探针每次复制源码树到 `/tmp`（约 5MB、62ms/次）；如果将来 `server.js` 需要 `node_modules` 或绝对路径配置，复制根会失效——本卡无依赖（`package.json` 无 dependencies），现状成立。
3. 隔离只保证探针之间互不干扰：仓内 `.data` 里历史遗留的 `running/queued` 记录（本席前几轮探针留下的 1～3 条）仍在，属运行态垃圾，本席不清理（清理会动写者/演示数据）。
4. 匹配失败的日志量未限流（写者未决 6），本卡不涉及，未测。
5. 全仓 `node --test`（含 `web/test`）跑不完，既有状况；本席只对根后端套件 + 本卡门禁负责。
6. `maintenance-startup.test.js` 既有红已亲验与 base 逐字节相同，本轮不修（扁平布局）。
7. 探针 A4-1 的期望来自文档：文档若把「差在哪」字段从关键字段列搬走，探针会因期望变少而变松——这是「期望来自文档」的固有代价，门禁侧 `logging.test.js` 同口径；不另记 finding。
