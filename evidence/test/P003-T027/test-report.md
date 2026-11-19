# P003-T027 测试席验收报告（何东阳 / gc-backend-tester）

树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T027`，分支 `task/hids-ai-console-P003-T027`。
HEAD：`d0ecaca`（第 3 轮复审 pass 的那棵树；`git log --oneline -1` = `d0ecaca fix(docs): P003-T027 syslog.match_failed 字段名 event_type→type，门禁加文档字段逐键对账`）。
本轮改动核对：`git show --stat d0ecaca` = 7 文件，全在 `docs/` / `coding-reports/` / `evidence/`，**无产品文件**（负范围兑现）。
本席本轮只动自己的两件证据：探针 `acceptance-e2e.mjs` 的 A4-1 改成从文档解析期望字段（不再硬编码），`acceptance-e2e-output.txt` 换成复跑输出。产品代码与文档一行未改。

## 1 结论

**PASS**。A1/A2/A3/A4 全部本终端亲跑通过：e2e 探针 16/16（exit 0）、写者门禁 13/13（exit 0）、根后端套件 211/210/1（唯一红是既有 `maintenance-startup.test.js` 扁平布局，改前既有，不属于本卡）。

上一轮的两条 FAIL 已由 `d0ecaca` 闭合并复验：
- F1（major，`syslog.match_failed` 文档字段 `event_type` vs 真日志 `type`）→ `docs/architecture.md:134` 关键字段列已是 `type`，`:155` 补了出现条件与 `event_type` 归属；真管道四条分支键集合与文档逐键对上。
- F4（minor，门禁抓不住缺行）→ `logging.test.js` 改成按首列找行 + 文档字段 vs 真日志逐键对账，缺行必红（本席亲手变异复现，见 §4）。

残留：F2/F3/F5 三条 doc-side minor（`nearest_gap_seconds` 取值字段、`msgid_map` 在 UDP 路径不可达、`triage-pipeline.md` 锚点族漂移），与本卡「本轮只改这一处」口径一致，不阻塞。

## 2 怎么验的（全部本终端亲跑）

### 2.1 写者门禁

```console
$ node --test evidence/test/P003-T027/logging.test.js
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ duration_ms 96.06
EXIT=0
```

### 2.2 我的 e2e 探针（真进程 / 真 UDP / 真 stdout，不 import 被测文件）

`evidence/test/P003-T027/acceptance-e2e.mjs`，全文输出在 `acceptance-e2e-output.txt`。

```console
$ node evidence/test/P003-T027/acceptance-e2e.mjs
...
==== 16/16 PASS ====
EXIT=0
```

覆盖：假牧云 RPC（本地 HTTP）+ `node server.js`（syslog 模式）+ UDP 报文 → `syslog.match_failed` 四条分支；
`node maintenance-server.js --preview` 启动行；`node package-policy.js` 三条走法 + 三条边界。
断言口径全部来自 `docs/architecture.md` §3.2 / 事件名表（含 `syslog.match_failed` 的 rule 表与字段名口径）
与 `docs/modules/maintenance-service.md` §2.4 / §4.1 / §4.2。

**本轮对探针的修正**（A4-1，上一轮 15/16 假红的根：断言硬编码了过期期望 `['rule','msgid','event_type','reason']`，不读文档）：
改成从 `docs/architecture.md` 事件名表里 `syslog.match_failed` 那一行解析期望字段——首列带 `` `事件名` `` 的行、
取第 3 列「关键字段」里的全部 `` `字段` ``（读法照 `logging.test.js:187-207` 的 `docRow` + `matchAll`），
再逐键对真日志键集合。改完：文档里写 `event_type` → 红；删掉整行 → 红；`type` → 绿（§4 亲手复现）。
复跑值：`文档字段：rule,msgid,type,reason,mismatch,missing,candidates,nearest_gap_seconds,window_seconds；实测键：…（缺：）`，
其中「实测键」= `candidates,event,event_id,host_ip,level,mismatch,missing,msgid,nearest_gap_seconds,reason,rule,time,type,window_seconds`。

### 2.3 根后端套件

```console
$ node --test *.test.js evidence/test/P003-T027/logging.test.js
✖ maintenance CLI starts when the deployment current path is a symlink (60.578812ms)
  Error: Cannot find module '/tmp/hids-maintenance-startup-…/current/backend/maintenance-server.js'
ℹ tests 211 / pass 210 / fail 1
EXIT=1
```

改前既有红，上一轮已亲验：在 `8f500ae` 上跑同一条用例同样红（工作树是扁平布局，没有 `backend/` 子目录），与本卡无关。

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
| A2 四条 rule 失败真日志带 `rule` 与差在哪 | pass | 探针 A2-1..A2-4 全 PASS：payload `missing:["host_ip"]`、event_id `mismatch.host_ip{10.0.0.5→10.0.0.6}`（ID 对得上 → 不出现 `event_id` 项）、time_window `window_seconds:300 candidates:2`、time_window 查询失败 `reason:"牧云事件查询失败：牧云 /rpc 500 …"`；四条都带 `rule` |
| A3 凭据不落日志 | pass | 报文里塞 `api_token=SECRET123456 password=hunter2 Authorization: Bearer abcdef123456`、上游错误里塞 token、`HIDS_MAINTENANCE_PASSWORD`/`HIDS_BASIC_AUTH_PASSWORD` 配真值 → A3-1/A3-2/A3-3 全 PASS 零命中，同批日志出现 `[redacted]`；`policy.keys_created` 密钥正文零命中 |
| A4 事件名表同步（本轮唯一改点：doc 字段 `type`） | pass | `docs/architecture.md:134` 关键字段列 = `rule` `msgid` `type` `reason`，与真管道四条分支键集合逐键对上（探针 A4-1 现读文档解析，缺键/缺行/写错名必红，§4 亲手变异）；`grep -n event_type docs/architecture.md` 只剩 `syslog.received` 行与 `:155` 说明；门禁 `logging.test.js` 13/13 |

## 4 变异验证（亲手，改后全部还原）

| 变异 | 结果 | 说明 |
| --- | --- | --- |
| `docs/architecture.md:134` 关键字段列 `type` → `event_type` | **探针 15/16**，恰 `A4-1` 红（`缺：event_type`） | 探针期望现在真绑在文档上 |
| 删掉 `docs/architecture.md:134` 整行 | **探针 15/16**，恰 `A4-1` 红（`文档事件名表里找不到 syslog.match_failed 行`） | 不认「文档里出现过这名字」，认「表里有这行」 |
| 同上两变异跑写者门禁 | 各 1 红（字段名）/ 2 红（删行：缺行 + 逐键对账） | `logging.test.js` 新增门禁有效，非空转 |
| 还原 `docs/architecture.md` | `diff -q /tmp/arch.orig docs/architecture.md` → identical；`git status --short docs/architecture.md` 空；门禁 13/13、探针 16/16 复绿 | 还原彻底，无残留 |

另（上一轮在旧版门禁上做的）：`syslog-case.js` 里事件名改成 `syslog.matchfail` → 5 红，A2 断言真绑日志输出。

## 5 findings

### F1（major，route_coding）— **已闭合**｜`syslog.match_failed` 实际字段是 `type`，文档曾写 `event_type`

- 原状：`docs/architecture.md:134` 写 `event_type`；真管道四条分支一条 `event_type` 都没有。
- 现状（`d0ecaca` 后复验）：文档改 `type`，探针 A4-1 读文档解析后 16/16；把文档改回 `event_type` 探针恰红。

### F2（minor，doc-side，未闭合，不阻塞本卡）`nearest_gap_seconds` 在真管道上恒为 `null`，文档没写它从上游事件的哪个字段取时间

- 文档出处：`docs/architecture.md:153`「`nearest_gap_seconds`（最近一条差多远）」。
- 实测：`candidates:2` 时仍 `nearest_gap_seconds:null`；假上游事件行同时给了 `created_at`/`event_create_time`/`event_time`/`occur_time`/`create_time`/`time`/`timestamp`/`detected_at` 八种写法（秒与 ISO 都有），仍是 `null`。写者单测能断言 600，用的是他们自造的事件形状，那个形状文档里没有。
- 复现：`node evidence/test/P003-T027/acceptance-e2e.mjs` 的 `PASS A2-3` 实测行。
- 结论：**没查清**是哪一侧的问题（上游真形状本仓没有，见 `docs/modules/event-gateway.md` GAP-EG-01）；但「外部照着文档造不出这一条」是事实。建议文档补一句取值字段，或在 gaps 里登记。

### F3（minor，doc-side，未闭合，不阻塞本卡）`msgid_map` 在真管道上不可达

- 文档出处：`docs/architecture.md:146` 的 rule 取值表把 `msgid_map` 列为 `syslog.match_failed` 的取值之一，并说「每条失败分支都从这里出」。
- 实测：UDP 送未知 MsgId → `{"event":"syslog.skipped","reason":"no_agent_for_msgid","msgid":"cloudwalker-unknown-type"}`，没有 `syslog.match_failed`（接收侧先按 `syslog-input.js` 映射表跳过，与 `docs/modules/triage-pipeline.md:189` 一致）。
- 建议：文档注明「`msgid_map` 只在直接调用 `matchSyslogEvent` 时成立，UDP 路径到不了」，否则按 rule 分桶的看板永远少一个桶。

### F4（minor，test-quality）— **已闭合**｜门禁的「事件名表同步」用例曾抓不住缺行

- 原状：旧用例只认「文档里出现过这个名字」。现状：`logging.test.js` 按首列找行 + 文档字段 vs 真日志逐键对账；本席变异亲验（§4）缺行必红。

### F5（minor，既有，不计本轮）`triage-monitor.js` 锚点族漂移

- 位置：`docs/modules/triage-pipeline.md:743-744`，引用 `triage-monitor.js:40/52/41/53`。
- 实测：`grep -n watermarkIds triage-monitor.js` → 50/70/94/…；`watermark_ids` → 70/94。
- base `8f500ae` 的这两行与现在逐字相同，属改前既有，与本卡无关，另开卡修。

## 6 文档锚点抽查（结构查询：符号/字面量所在行号，不读实现正文）

| 文档断言 | 实测行号 | 结果 |
| --- | --- | --- |
| `package-policy.js:15-26` = `initKeys` | `initKeys` :15 | 对齐 |
| `package-policy.js:28-44` = `buildPackage` | `buildPackage` :28 | 对齐 |
| `package-policy.js:47-51` = `main` | `main` :47 | 对齐 |
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

1. `nearest_gap_seconds` 为何在真管道恒 null（F2）——本仓没有真牧云响应样本，判不了是映射还是文档问题。
2. 匹配失败的日志量未限流（写者未决 6），本卡不涉及，未测。
3. 全仓 `node --test`（含 forbidden 的 `web/test`）跑不完，既有状况；本席只对根后端套件 + 本卡门禁负责。
4. `maintenance-startup.test.js` 既有红已亲验在 base 上同样红，本轮不修（扁平布局）。
5. 探针 A4-1 现在读文档，文档若把「差在哪」字段从关键字段列搬走（如另起一列），探针会因期望变少而变松——这是「期望来自文档」的固有代价，门禁侧 `logging.test.js` 同样口径；不另记 finding。
