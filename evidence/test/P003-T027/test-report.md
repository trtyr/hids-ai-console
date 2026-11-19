# P003-T027 测试席验收报告（何东阳 / gc-backend-tester）

树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T027`，分支 `task/hids-ai-console-P003-T027`。
HEAD：`b7e330f`（`git log main..HEAD --oneline | wc -l` = 3）。
本轮改动核对：`git show b7e330f | grep -E '^[+-][^+-]'` = 两行，文档锚点 `80→53` 与 `package-policy.js` 注释 `164→172`，产品行为零变化。

## 1 结论

**FAIL**，route_coding，1 条 major + 4 条 minor。
卡住的地方只有一处：`syslog.match_failed` 的实际字段是 `type`，文档事件表写的是 `event_type`；真管道四次分支一条 `event_type` 都没有，门禁里也没有任何一条用例盯这个键（`grep -c event_type evidence/test/P003-T027/logging.test.js` = 0）。
A1/A2/A3 的行为本身全部实测通过，A4 的「文档事件名表同步」只有这一处塌陷。

## 2 怎么验的（全部本终端亲跑）

### 2.1 主门禁（写者的 12 条）

```console
$ node --test evidence/test/P003-T027/logging.test.js
ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ duration_ms 96.748843
```

### 2.2 我的 e2e 探针（真进程 / 真 UDP / 真 stdout，不 import 被测文件）

`evidence/test/P003-T027/acceptance-e2e.mjs`，全文输出在 `acceptance-e2e-output.txt`。

```console
$ node evidence/test/P003-T027/acceptance-e2e.mjs
...
==== 15/16 PASS ====
失败项：A4-1 文档事件表字段名一致（architecture.md §3.6：rule msgid event_type reason）
```

覆盖：假牧云 RPC（本地 HTTP）+ `node server.js`（syslog 模式）+ UDP 报文 → `syslog.match_failed` 四条分支；
`node maintenance-server.js --preview` 启动行；`node package-policy.js` 三条走法 + 三条边界。
断言全部来自 `docs/architecture.md` §3.2/§3.6 与 `docs/modules/maintenance-service.md` §2.4/§4.1/§4.2。

### 2.3 根后端套件

```console
$ node --test *.test.js evidence/test/P003-T027/logging.test.js
✖ maintenance CLI starts when the deployment current path is a symlink (81.879104ms)
  Error: Cannot find module '/tmp/hids-maintenance-startup-…/current/backend/maintenance-server.js'
ℹ tests 210 / pass 209 / fail 1
```

改前既有红，亲验：`git worktree add --detach /tmp/base 7b706c7^` → 在 `8f500ae` 上跑同一条用例
`tests 1 / pass 0 / fail 1 / Cannot find module …/current/backend/maintenance-server.js`，与本轮无关（工作树是扁平布局，没有 `backend/` 子目录）。

## 3 逐条验收

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A1 三文件 `console.*` 清零 | pass | `grep -c "console\." maintenance-server.js package-policy.js syslog-case.js` → 0/0/0；三文件各 `import { log } from './log.js'`（:8 / :7 / :5）；真实进程启动行落 `maintenance.listening`，三条 CLI 走法落 `policy.*`，退出码 0/0/1 |
| A2 四条 rule 失败日志带差在哪 | pass（字段名口径见 finding-1） | payload `missing:["host_ip"]`、event_id `mismatch.host_ip{10.0.0.5→10.0.0.6}`+`host_id{1→2}`、time_window `window_seconds:300 candidates:2`、time_window 查询失败 `reason:"牧云事件查询失败：牧云 /rpc 500 …"` |
| A3 凭据不落日志 | pass | 报文里塞 `api_token=SECRET123456 password=hunter2 Authorization: Bearer abcdef123456`、上游错误里塞 token、`HIDS_MAINTENANCE_PASSWORD`/`HIDS_BASIC_AUTH_PASSWORD` 都配了真值 → 全部零命中，且同批日志出现 `[redacted]`；`policy.keys_created` 密钥正文零命中 |
| A4 证据可重放 + 事件名表同步 | **fail** | 探针 16 条断言 15 过；文档事件表补齐了 5 个新事件行，但 `syslog.match_failed` 的字段名与实测不符（finding-1）；门禁的文档表用例偏松（finding-4） |

## 4 变异验证（亲手，改后全部还原，`git status` 只剩本报告与探针）

| 变异 | 结果 | 说明 |
| --- | --- | --- |
| 删 `docs/architecture.md:134`（`syslog.match_failed` 事件表行） | **12/12 仍全绿** | 用例只认「名字在文档里出现过」，不认「事件表里有这行」 |
| 删满 4 条新事件行（134/139/140/141） | 1 红（`A1/A2：新事件名都进了 …事件名表`） | 说明用例有效但过松 |
| `syslog-case.js` 里 `syslog.match_failed` → `syslog.matchfail` | 5 红（四条 A2 + 凭据那条） | A2 断言真绑在日志输出上，不空转 |

还原后：`node --test evidence/test/P003-T027/logging.test.js` → 12/12 绿，`git status --short` 无产品文件改动。

## 5 findings

### F1（major，route_coding）`syslog.match_failed` 实际字段是 `type`，文档写 `event_type`

- 文档出处：`docs/architecture.md:134`「`rule` `msgid` `event_type` `reason`」。
- 文档说：`event_type`。
- 实测：四次分支的键集合 `rule/msgid/reason/type/missing/mismatch/candidates/window_seconds/nearest_gap_seconds/host_ip/event_id`，**没有一次带 `event_type`**；`payload` 分支连 `type` 都没有。兄弟事件 `syslog.received` 用的是 `event_type`。
- 复现：`node evidence/test/P003-T027/acceptance-e2e.mjs`（看 `FAIL A4-1` 那段的「实测」行）。
- 影响：按文档写采集规则（`event_type=webshell`）的人在 `syslog.match_failed` 上一行都匹配不到；门禁的全 12 条用例一条都不盯这个键。

### F2（minor，doc-side）`nearest_gap_seconds` 在真管道上恒为 `null`，文档没写它从上游事件的哪个字段取时间

- 文档出处：`docs/architecture.md:153`「`nearest_gap_seconds`（最近一条差多远）」。
- 实测：`candidates:2` 时仍 `nearest_gap_seconds:null`；假上游事件行同时给了 `created_at`/`event_create_time`/`event_time`/`occur_time`/`create_time`/`time`/`timestamp`/`detected_at` 八种写法（秒与 ISO 都有），仍是 `null`。写者单测能断言 600，用的是他们自造的事件形状，那个形状文档里没有。
- 复现：`node evidence/test/P003-T027/acceptance-e2e.mjs` 的 `PASS A2-3` 实测行。
- 结论：**没查清**是哪一侧的问题（上游真形状本仓没有，见 `docs/modules/event-gateway.md` GAP-EG-01）；但「外部照着文档造不出这一条」是事实。建议文档补一句取值字段，或在 gaps 里登记。

### F3（minor，doc-side）`msgid_map` 在真管道上不可达

- 文档出处：`docs/architecture.md:146` 的 rule 取值表把 `msgid_map` 列为 `syslog.match_failed` 的取值之一，并说「每条失败分支都从这里出」。
- 实测：UDP 送未知 MsgId → `{"event":"syslog.skipped","reason":"no_agent_for_msgid","msgid":"cloudwalker-unknown-type"}`，没有 `syslog.match_failed`（接收侧先按 `syslog-input.js` 的映射表跳过，这与 `docs/modules/triage-pipeline.md:189` 一致）。
- 建议：文档注明「`msgid_map` 只在直接调用 `matchSyslogEvent` 时成立，UDP 路径到不了」，否则看板上按 rule 分桶会永远少一个桶。

### F4（minor，test-quality）门禁的「事件名表同步」用例抓不住缺行

- 位置：`evidence/test/P003-T027/logging.test.js:176-180`。
- 实测：删 `docs/architecture.md:134`（唯一那行 `syslog.match_failed`）→ 12/12 仍绿；删满 4 条才红。
- 建议：断言改成「事件表里存在 `| \`<event>\` |` 这一行」，而不是「文档里出现过这个名字」。

### F5（minor，既有，不计本轮）`triage-monitor.js` 锚点族漂移

- 位置：`docs/modules/triage-pipeline.md:743-744`，引用 `triage-monitor.js:40/52/41/53`。
- 实测：`grep -n watermarkIds triage-monitor.js` → 50/70/94/…；`watermark_ids` → 70/94。
- base `8f500ae` 的这两行与现在逐字相同（`git show 7b706c7^:docs/modules/triage-pipeline.md | sed -n '743,744p'`），属改前既有，与本卡无关，另开卡修。
- 另：`evidence/recon/P003-T027.md:22` 仍写「照 `maintenance-server.js:164` 的写法」，与代码注释改后的 `:172` 不一致（快照，不阻塞）。

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
3. 全仓 `node --test`（含 forbidden 的 `web/test`）跑不完，既有状况；本席只对根后端套件 + 本卡单测负责。
4. `maintenance-startup.test.js` 既有红已亲验在 base 上同样红，本轮不修。
