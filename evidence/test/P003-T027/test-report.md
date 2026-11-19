# P003-T027 测试席验收报告（何东阳 / gc-backend-tester）

树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T027`，分支 `task/hids-ai-console-P003-T027`。
探针与复跑输出：`68a0386`（父 `d125110`，第 3 轮复审 pass 的那棵树）；本报告随后单独提交。
本轮只动自己的证据（`acceptance-e2e.mjs` / `acceptance-e2e-output.txt` / 本报告）：`git show --stat 68a0386` = 2 文件，全在 `evidence/test/P003-T027/`，**产品代码与文档零改动**（`git status --porcelain` 里只剩本轮报告待提交）。

## 1 结论

**PASS**。A1/A2/A3/A4 全部本终端亲跑通过，审计打回的四项逐条闭合：

- 探针 16/16：**空闲连跑 6 次** + **yes 打满负载 2 次（load 16.36 / 29.37）**，8 次全 `EXIT=0`、全 16/16（§2.2）。
- 写者门禁 `logging.test.js` 13/13（`EXIT=0`）；根后端套件 211/210/1，唯一红是改前既有的 `maintenance-startup.test.js` 扁平布局（`8f500ae..HEAD` 该文件 diff 空）。
- 审计四项：①六处固定 sleep 全换 `waitUntil`/`waitExit`（`grep -c 'sleep(' = 0`）；②A3-1 加正控（三类 match_failed 到齐 + `[redacted]` 出现），缺一条必红（§4 变异 B）；③A2-3 删掉 `typeof l0(tw)==='object'` 恒真断言，改成 `nearest_gap_seconds === 480`（§4 变异 A 必红）；④F2「八种写法」按真因改写（§5 F2）。

另查明审计 load 假红的另一个真根：探针连跑时**跨进程去重表把同内容报文合并**（`.data/triage-monitor.json` 是文档写死的运行态，不依赖环境变量），导致 match_failed 一条都不出；报文加每轮 nonce 后 6 连跑全绿（§2.2、F6）。

## 2 怎么验的（全部本终端亲跑）

### 2.1 写者门禁

```console
$ timeout 300 node --test evidence/test/P003-T027/logging.test.js
ℹ tests 13
ℹ pass 13
ℹ fail 0
EXIT=0
```

### 2.2 我的 e2e 探针（真进程 / 真 UDP / 真 stdout，不 import 被测文件）

`evidence/test/P003-T027/acceptance-e2e.mjs`，最终复跑输出在 `acceptance-e2e-output.txt`。本轮对探针的修改（审计打回项）：

1. **六处固定 sleep → 有 deadline 的轮询等待**（旧行号 :91/:100/:103/:106/:120/:122）：
   - 起 `server.js`：`waitUntil` 等到 `syslog.listening` 绑定行（deadline 60s）；
   - 首轮四报文：`waitUntil` 等到 **payload + event_id + honeypot 的 time_window** 三条真日志到齐（deadline 60s）——time_window 必须点名 honeypot，否则 suspicious-command 的先到会提前放行、上游开关还没开就把 honeypot 打成 500；
   - 上游 500：`waitUntil` 等到 `rule=time_window` 且 `reason` 以「牧云事件查询失败」开头的日志行（deadline 60s）；
   - SIGTERM 收尾：`waitExit` 等进程 `close`（10s 不到则 SIGKILL）；
   - 维护端：`waitUntil` 等到 `maintenance.listening` 启动行（deadline 60s）+ `waitExit`。
   `grep -c 'sleep(' evidence/test/P003-T027/acceptance-e2e.mjs` → `0`。
2. **A3-1 补正控**：除「凭据零命中」外，要求 `payload`/`event_id`/`time_window` 三条 match_failed 真到齐且日志里出现 `[redacted]`。管道空转/只到两条时必红（§4 变异 B）。
3. **A2-3 改真断言**：删掉恒真的 `typeof l0(tw)==='object'`，改成 `window_seconds === 300 && candidates === 2 && nearest_gap_seconds === 480`（假上游 2 条候选 `created_at` 在 +600s/+900s，事件时间 +120s，最近一条差 480s）。取 `msgid === 'cloudwalker-honeypot'` 的那条，避免误抓别的 time_window 分支。
4. **假上游补 `created_at`**（F2 真因）：原来只给 `event_create_time`/`detected_at`，`nearest_gap_seconds` 恒 `null`；给出 `created_at` 即有值（本探针 480）。
5. **每轮报文塞独立 nonce**（本轮新查到的假红根）：运行时是仓内 `.data/`（`docs/modules/http-api.md:42`「不依赖环境变量，恒为仓内 `.data/` 下」），去重表跨进程持久；同一探针连跑时，同内容报文被 `syslog.collapsed` 合并（raw 里 `repeat_count:2`），match_failed 一条不出（实测 10/16）。加 `nonce=<pid>-<BASE>-<n>` 后内容指纹每轮唯一。

```console
$ grep -c 'sleep(' evidence/test/P003-T027/acceptance-e2e.mjs
0
$ for i in 1 2 3 4 5 6; do timeout 180 node evidence/test/P003-T027/acceptance-e2e.mjs > /tmp/p27-n$i.log 2>&1; echo "run$i EXIT=$? $(grep -o '==== [0-9]*/[0-9]* PASS ====' /tmp/p27-n$i.log) gap=$(grep -o '"nearest_gap_seconds":[^,]*' /tmp/p27-n$i.log | head -1)"; done
run1 EXIT=0 ==== 16/16 PASS ==== gap="nearest_gap_seconds":480
run2 EXIT=0 ==== 16/16 PASS ==== gap="nearest_gap_seconds":480
run3 EXIT=0 ==== 16/16 PASS ==== gap="nearest_gap_seconds":480
run4 EXIT=0 ==== 16/16 PASS ==== gap="nearest_gap_seconds":480
run5 EXIT=0 ==== 16/16 PASS ==== gap="nearest_gap_seconds":480
run6 EXIT=0 ==== 16/16 PASS ==== gap="nearest_gap_seconds":480
$ for i in $(seq 1 100); do timeout 120 yes >/dev/null & echo $! >> /tmp/p27-yes.pids; done; sleep 4
load=8.90 yes=100
$ timeout 300 node evidence/test/P003-T027/acceptance-e2e.mjs    # 满载第 1 次
EXIT=0 ==== 16/16 PASS ==== load=16.36
$ timeout 300 node evidence/test/P003-T027/acceptance-e2e.mjs    # 满载第 2 次
EXIT=0 ==== 16/16 PASS ==== load=29.37
$ kill $(cat /tmp/p27-yes.pids); pgrep -c '^yes$' → 0；pgrep -c 'server.js|maintenance-server.js|acceptance-e2e' → 0
```

覆盖：假牧云 RPC（本地 HTTP）+ `node server.js`（syslog 模式）+ UDP 报文 → `syslog.match_failed` 四条分支；
`node maintenance-server.js --preview` 启动行；`node package-policy.js` 三条走法 + 三条边界。
断言口径全部来自 `docs/architecture.md` §3.2 / 事件名表（含 `syslog.match_failed` 的 rule 表与字段名口径）与 `docs/modules/maintenance-service.md` §2.4 / §4.1 / §4.2。

A4-1 仍从 `docs/architecture.md` 事件名表里 `syslog.match_failed` 那一行解析期望字段（首列带 `` `事件名` `` 的行、取第 3 列「关键字段」里的全部 `` `字段` ``，读法照 `logging.test.js:187-207`），不硬编码。

### 2.3 根后端套件

```console
$ timeout 400 node --test *.test.js evidence/test/P003-T027/logging.test.js
✖ maintenance CLI starts when the deployment current path is a symlink
ℹ tests 211 / pass 210 / fail 1
EXIT=1
$ git diff 8f500ae..HEAD -- maintenance-startup.test.js | wc -l
0
```

唯一红是改前既有（`8f500ae` 时同一文件同样红：工作树扁平布局，没有 `backend/` 子目录），与本卡无关。

### 2.4 产品面结构核对（A1）

```console
$ for f in maintenance-server.js package-policy.js syslog-case.js; do printf '%s console.=' $f; grep -c 'console\.' $f; done
maintenance-server.js console.=0
package-policy.js console.=0
syslog-case.js console.=0
```

## 3 逐条验收

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A1 三文件 `console.*` 清零、走 `log.js` | pass | `grep -c "console\." maintenance-server.js package-policy.js syslog-case.js` → 0/0/0；真进程启动行落 `maintenance.listening`（A1-1/A1-2），三条 CLI 走法落 `policy.*`（A1-3/A1-5/A1-6），退出码 0/0/1，边界 A1-7/A1-8 非 0 退出 |
| A2 四条 rule 失败真日志带 `rule` 与差在哪 | pass | A2-1..A2-4 全 PASS：payload `missing:["host_ip"]`、event_id `mismatch.host_ip{10.0.0.5→10.0.0.6}`（ID 对得上 → 不出现 `event_id` 项）、time_window `window_seconds:300 candidates:2 nearest_gap_seconds:480`、查询失败 `reason:"牧云事件查询失败：牧云 /rpc 500 …"`；四条都带 `rule` |
| A3 凭据不落日志 | pass | 报文里塞 `api_token=SECRET123456 password=hunter2 Authorization: Bearer abcdef123456`、上游错误里塞 token、`HIDS_MAINTENANCE_PASSWORD`/`HIDS_BASIC_AUTH_PASSWORD` 配真值 → A3-1/A3-2/A3-3 全 PASS 零命中，同批日志出现 `[redacted]`；**A3-1 带正控**（三条 match_failed + `[redacted]` 到齐，否则红）；`policy.keys_created` 密钥正文零命中 |
| A4 事件名表同步 | pass | `docs/architecture.md:134` 关键字段列 = `rule` `msgid` `type` `reason`，与真管道四条分支键集合逐键对上（探针 A4-1 读文档解析，缺键/缺行/写错名必红，§4） |

## 4 变异验证（亲手，改后全部还原）

| 变异 | 结果 | 说明 |
| --- | --- | --- |
| A：假上游去掉 `created_at` | **15/16，仅 A2-3 红**（`nearest_gap_seconds:null`） | A2-3 真断言绑在数值上，删字段必红 |
| B：不发第一条报文（缺 host_ip 的 payload 分支） | **13/16：A2-1 / A4-1 / A3-1 红**；A3-1 实测「凭据命中：无；`[redacted]` 出现=true；缺分支=[payload]」 | 正控生效：管道少一条时，凭据零命中也不再白捡通过 |
| C：`docs/architecture.md:134` 关键字段列 `type` → `event_type` | **15/16，恰 A4-1 红** | 探针期望真绑在文档上 |
| D：删掉 `docs/architecture.md:134` 整行 | **15/16，恰 A4-1 红**（找不到行） | 不认「文档里出现过这名字」，认「表里有这行」 |
| C/D 同两变异跑写者门禁 | C：12/13（恰 1 红）；D：11/13（恰 2 红）；还原：13/13 | `logging.test.js` 门禁同样非空转（本席亲手跑） |
| 还原 | `sha1sum` 探针 `6e90a72f…`、`diff -q` 文档 identical、`git status --short docs/architecture.md` 空；门禁 13/13、探针 16/16 复绿 | 还原彻底，无残留 |

## 5 findings

### F1（major，route_coding）— **已闭合**｜`syslog.match_failed` 实际字段是 `type`，文档曾写 `event_type`

- 原状：`docs/architecture.md:134` 写 `event_type`；真管道四条分支一条 `event_type` 都没有。
- 现状：文档改 `type`（`d0ecaca`），探针 A4-1 读文档解析后 16/16；把文档改回 `event_type` 探针恰红（§4 变异 C）。

### F2（minor，**test-quality，已闭合**）｜原探针假上游没给 `created_at`，`nearest_gap_seconds` 恒 null

- 原报告的「八种写法」写错了：树里没有那种假上游形状，归类（doc-side）也不对。
- 真因：探针假上游事件行只给 `event_create_time` / `detected_at`，没给 `created_at`——`time_window` 分支算 `nearest_gap_seconds` 取的是 `created_at`；给出即 600（审计直调 `matchSyslogEvent` 的实测口径）。
- 现状：假上游补 `created_at`（本探针候选 +600s/+900s、事件时间 +120s → 480），A2-3 断言 480；去掉 `created_at` 变异必红（§4 变异 A）。
- 文档没写这个数取上游事件的哪个字段——留在 §7 残余风险，不作为 finding。

### F3（minor，doc-side，未闭合，不阻塞本卡）`msgid_map` 在真管道上不可达

- 文档出处：`docs/architecture.md:146` 的 rule 取值表把 `msgid_map` 列为 `syslog.match_failed` 的取值之一，并说「每条失败分支都从这里出」。
- 实测：UDP 送未知 MsgId → `{"event":"syslog.skipped","reason":"no_agent_for_msgid","msgid":"cloudwalker-unknown-type"}`，没有 `syslog.match_failed`（接收侧先按 `syslog-input.js` 映射表跳过，与 `docs/modules/triage-pipeline.md:189` 一致）。
- 建议：文档注明「`msgid_map` 只在直接调用 `matchSyslogEvent` 时成立，UDP 路径到不了」，否则按 rule 分桶的看板永远少一个桶。

### F4（minor，test-quality）— **已闭合**｜门禁的「事件名表同步」用例曾抓不住缺行

- 原状：旧用例只认「文档里出现过这个名字」。现状：`logging.test.js` 按首列找行 + 文档字段 vs 真日志逐键对账。
- 本席本轮亲手复现（不是转录写者）：doc 字段 `type`→`event_type` → 门禁 12/13（恰 1 红）；删整行 → 11/13（恰 2 红）；还原 → 13/13。

### F5（minor，既有，不计本轮）`triage-monitor.js` 锚点族漂移

- 位置：`docs/modules/triage-pipeline.md:743-744`，引用 `triage-monitor.js:40/52/41/53`。
- 实测：`grep -n watermarkIds triage-monitor.js` → 50/70/94/…；`watermark_ids` → 70/94。
- base `8f500ae` 的这两行与现在逐字相同，属改前既有，与本卡无关，另开卡修。

### F6（minor，**test-quality，已闭合**）｜探针连跑被跨进程去重表合并，load 假红的另一半根

- 实测：同一探针连跑，`.data/triage-monitor.json` 的去重表（`docs/modules/http-api.md:42`：运行态恒为仓内 `.data/`，不依赖环境变量）按内容指纹把同报文合并，raw 里出现 `syslog.collapsed repeat_count:2`，`syslog.match_failed` 一条都不出 → 10/16。
- 修法：每条报文塞 `nonce=<pid>-<BASE>-<n>`，指纹每轮唯一；修后空闲 6 连跑 + 满载 2 次全 16/16（§2.2）。
- 这是探针隔离问题，产品行为不变，不改产品代码。

## 6 文档锚点抽查（结构查询：符号/字面量所在行号，不读实现正文）

| 文档断言 | 实测行号 | 结果 |
| --- | --- | --- |
| `package-policy.js:15-26` = `initKeys` | `initKeys` :15 | 对齐 |
| `package-policy.js:28-44` = `buildPackage` | `buildPackage` :28 | 对齐 |
| `package-policy.js:47-51` = `main` | `main` :47（入口调用 :56） | 对齐 |
| 入口 `realpathSync` 守卫 :55-58 | `realpathSync` :55（另 :2 import） | 对齐 |
| 密钥目录 700（:17）、文件 600（:23） | `0o700` :17、`0o600` :23/:41 | 对齐 |
| 扩展名闸 :29、环境变量 :30-31、日志字段 :42-43 | `.hids-policy` :29、`HIDS_UPDATE_KEY_FILE` :30/:37、`HIDS_UPDATE_TARGET` :30/:34/:43 | 对齐 |
| `logListening` :165-177、入口 :176 | 定义 :167、调用 :176 | 对齐 |
| 端口取 `HIDS_MAINTENANCE_PORT` :175-176 | :175 | 对齐 |
| `unmatched()` :7-12 | `unmatched` :9（块 7-12） | 对齐 |
| 材料读取上限 25000 :172、「不在当前告警目录」:170 | :172 / :170 | 对齐 |
| 重复投递行 :125、回写正则 :161 | :125 / :161 | 对齐 |
| `gap_seconds` :50/:80 | :50/:80 | 对齐 |

## 7 残余风险 / 没查清

1. `nearest_gap_seconds` 取上游事件的哪个字段（本次实测 `created_at` 给出即有值），文档只写「最近一条差多远」没写取值字段——属 doc 侧可补，不阻塞本卡；探针断言按本数据构造钉在 480。
2. 匹配失败的日志量未限流（写者未决 6），本卡不涉及，未测。
3. 全仓 `node --test`（含 forbidden 的 `web/test`）跑不完，既有状况；本席只对根后端套件 + 本卡门禁负责。
4. `maintenance-startup.test.js` 既有红已亲验在 base 上同样红，本轮不修（扁平布局）。
5. 探针与写入方共用仓内 `.data/` 运行态（去重表/研判记录会随探针增长）；本轮用 nonce 避免互相干扰，但不清理该目录——清理会毁掉写者/演示数据。
6. 探针 A4-1 现在读文档，文档若把「差在哪」字段从关键字段列搬走（如另起一列），探针会因期望变少而变松——这是「期望来自文档」的固有代价，门禁侧 `logging.test.js` 同样口径；不另记 finding。
