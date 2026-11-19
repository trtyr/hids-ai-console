# P003-T032 取证件：现场验证债（401 全链 / 暂停研判 / 真 IP 溯源建链 / 扫描时效）

- 任务卡：P003-T032
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T032`（分支 `task/hids-ai-console-P003-T032`）
- 起活 commit：`44eca4b5b4fd1d71b7cf3ccf878470552ea6f989`（= main）
- 产品代码：**零改动**（本卡 scope 只有证据与文档）

## 环境标注约定（A6：每条结论都带，别把替身结果读成真牧云）

| 标注 | 含义 |
| --- | --- |
| **真进程** | 本树 `node server.js` 起真实业务进程（`env -i` 等价环境、动态端口），走真实路由与真实鉴权 |
| **替身牧云** | `evidence/test/P003-T032/stub-muyun.mjs` 的 `/rpc`（JSON-RPC 只读方法）+ `/api/mcp`（MCP 三步），**不是真牧云** |
| **替身模型** | 同一文件的 `/v1/chat/completions`，脚本化回包，**不是真模型** |
| **现场数据** | 主仓 `/home/trtyr/code/hids-ai-console/.data/` 里 2026-11-19 上午现场跑出来的案卷与 `triage-monitor.json`；本卡**只读、未复测** |

本卡**没有**任何一条结论来自真牧云或真模型——192.168.24.21 不可达（见 §A5），本机也没有牧云凭据。

## 复跑

```
bash evidence/test/P003-T032/run-all.sh      # 三条探针串跑，退出码 0 = 全过；实测 62s
node evidence/test/P003-T032/probe-a1-401.mjs    # 单跑 A1
node evidence/test/P003-T032/probe-a2-pause.mjs  # 单跑 A2（含两处 ~31s 等待，产品轮询周期就是 30s）
node evidence/test/P003-T032/probe-a3-trace.mjs  # 单跑 A3
T032_DEBUG=1 node evidence/test/P003-T032/probe-a2-pause.mjs   # 失败时加它，会打出替身请求日志与进程日志
```

探针自己清理运行态：起真进程会往本树 `.data/` 写 `triage-monitor.json` / `trace-boards/` 等，探针退出时只删「本次新出现的」文件（`harness.mjs` 的 `snapshotData`/`restoreData`），跑完 `git status --short` 只有本卡新增的 `evidence/` 文件。

**2026-11-19 14:22 实测**：`bash evidence/test/P003-T032/run-all.sh` → A1/A2/A3 三条 `ALL GREEN`，退出码 0，总耗时 62s。

**2026-11-19 23:2x 复跑（按审计意见改证后）**：`timeout 240 bash evidence/test/P003-T032/run-all.sh` → A1/A2/A3 三条 `ALL GREEN`，**64 条 PASS（34 / 19 / 11）、0 FAIL、退出码 0、real 1m1.632s**；同轮变异：`trace-board.js:456` 的 `strength: 0.3` 改 `0.9` → A3 恰红 1 条（新加的 `strength=0.3` 守卫），`git checkout -- trace-board.js` 还原后 `git diff` 无产品文件改动。同轮 `timeout 120 npm test` → `tests 198 / pass 198 / fail 0`，退出码 0（`duration_ms 704.6`）。

## §A1 · 401 全链（真进程 + 替身牧云）

命令：`node evidence/test/P003-T032/probe-a1-401.mjs` → 退出码 0，**34 条 PASS**（2026-11-19 23:2x 本树复跑实测）。

| 断言 | 实测 |
| --- | --- |
| 无凭据 `GET /api/alerts` → 401 | 401 |
| 401 四条头：`WWW-Authenticate: Basic realm="HIDS AI Console", charset="UTF-8"` / `Content-Type: text/plain; charset=utf-8` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` | 四条逐字对上 |
| 401 正文是纯文本「需要登录后访问」（不是 JSON） | 正文恰为该串 |
| 无凭据时**上游零请求** | 替身 `/rpc` 调用 11 → 11 |
| 错口令 → 401 + 同样头 + 上游零请求 | 401，11 → 11 |
| 错用户名（口令对）→ 401 | 401，11 → 11 |
| 非 Basic 前缀（`Bearer …`）→ 401 | 401，11 → 11 |
| 正确凭据 → 200 且读到替身上游那条告警 | 200，`alerts=1`，`id=malware:1` |
| 正确凭据时上游**真被调用** | `/rpc` 11 → 22 |
| `/api/config` 同闸：无凭据 401 / 有凭据 200 | 401 / 200 |

口径来源：`docs/modules/http-api.md` §4（401 四条头与纯文本正文）；`server.js:413`（`hasAccess`）、`server.js:421`（`requireAccess`）。

## §A2 · 暂停研判（真进程 poll 模式 + 替身牧云 + 替身模型）

命令：`node evidence/test/P003-T032/probe-a2-pause.mjs` → 退出码 0，**19 条 PASS**（2026-11-19 23:2x 本树复跑实测）。

| 断言 | 实测 |
| --- | --- |
| 起步：首次轮询完成、游标已钉 | `initialized=true`，`last_poll_at` 有值 |
| 起步：研判启用态 | `enabled=true` |
| 暂停：`PUT /api/agent/triage/control {enabled:false}` | 200，`enabled=false` |
| **暂停期间：轮询没跑**（游标时间未前进） | `last_poll_at` 14:19:28.979 → 14:19:28.979（隔了一个完整轮询周期） |
| **暂停期间：新告警不入队**（队列四计数全零） | `{"queued":0,"running":0,"done":0,"failed":0}` |
| 暂停期间：`GET /api/agent/triage/malware:21` | `status=not_queued` |
| 暂停期间：日志无 `triage.enqueued` | 0 条 |
| 恢复：`{enabled:true}` | 200，`enabled=true` |
| **恢复：暂停期到达的那条不补跑**（游标重置到点击秒，文档 R-TRIAGE-06） | 队列仍空，`malware:21` 仍 `not_queued` |
| **恢复：恢复后新到的告警入队** | `malware:22` 记录出现（`running`→`done`），日志 `triage.enqueued {alert_id:"malware:22", source:"poll"}` |
| **恢复：续跑到 done** | `status=done`、`verdict=uncertain`、日志有 `triage.done` |
| 恢复：结论来自真实结论链路（不是替身模型兜底回包） | 正文「替身场景：主机 192.168.24.21 出现 jsp 恶意文件事件…」 |
| 恢复：替身模型确实被调用（研判真的跑起来了） | 3 次（wiki_search → submit_conclusion → 独立复核） |

口径来源：`triage-monitor.js:197-211`（`setEnabled`：恢复重置游标 + 删 `queued`）、`:240-241`（`poll()` 首行守卫）、`:287`（取数后二次守卫）、`:412`（`drain()` 只跑 `enabled` 时的队列）；`docs/modules/triage-pipeline.md` §5 与 R-TRIAGE-05/06。

**探针设计里的一个坑（记下来，免得下一个人再踩）**：牧云事件时间精确到秒、游标带毫秒。若在暂停后立刻把新告警的 `created_at` 设成「此刻」，它的秒级时间会落在游标毫秒之前，被 `row.createdAt < this.watermark` 直接跳过——那时「没入队」是游标挡的，不是暂停挡的。探针因此在暂停/恢复后各等 1.2s 跨过秒边界再放告警（见 `probe-a2-pause.mjs` 的注释）。

## §A3 · 溯源白板建边（真进程 + 替身牧云真实形状记录）

命令：`node evidence/test/P003-T032/probe-a3-trace.mjs` → 退出码 0，**11 条 PASS**（2026-11-19 23:2x 本树复跑实测；含审计要求补的 `strength=0.3` 守卫）。

替身交出的记录形状照现场那份 jsp 恶意文件事件（`host_view.host_ip`、`file_type=jsp_webshell`、`file_path=/dev/shm/detector_tmp/jspxwebshell/...`、`process_name=cava`、`detect_source=jspxwebshell`），**另加一条对端公网地址 `source_ip=203.0.113.77`**——现场那份事件没有 `source_ip` 字段，这个地址是替身构造的（TEST-NET-3 文档段，形状与公网 IPv4 一致，不是现场观测值）。

| 断言 | 实测 |
| --- | --- |
| `POST /api/trace/boards {target:"malware:1"}` | 202，白板起板 |
| 起板种子节点来自替身事件的 `host_view.host_ip` | `asset:192.168.24.21` |
| 调查跑到 `done` | `done`，`gaps` 里有「未核实对端地址归属与连接方向」 |
| 对端地址进图 | `nodes` 含 `ip:203.0.113.77` |
| **白板建出边** | `links` 含 `asset:192.168.24.21 → ip:203.0.113.77` |
| 关系性质 | `rel=触达线索` |
| 边带原始证据引用 | `evidence_id=cw:1` |
| 落盘 `edge.by=program`（代码按同一条记录的来源/主机字段推出来的，不是模型自报） | `program` |
| 两端各一条证据引用 | `["cw:1","cw:1"]` |
| **program 边强度**（`docs/modules/trace-board.md` R-TRACE-05） | `strength=0.3` |
| 白板结论含对端地址 | 「…同页带出对端 203.0.113.77，已按 program 线索建边…」 |

口径来源：`trace-board.js:453-474`（program 边：同一条记录里 `source_ip` 非私网 + `host_ip` 有效；`strength: 0.3`）、`docs/modules/trace-board.md:352`（R-TRACE-05）、`trace-board.js:100-124`（`presentBoard` 的 links 方向：从更晚的一端指向更早的原因，同一时刻按离告警远近）。

## §变异验红（断言不是摆设）

每条都是「临时改产品代码 → 跑探针 → 变红 → 改回」，收尾 `git diff --stat` 为空、`git status --short` 只有本卡新增文件。

| 变异 | 改哪 | 探针反应 |
| --- | --- | --- |
| M1 | `server.js:59` `hasAccess` 之后直接 `return true`（鉴权恒过） | A1 红 12+ 条：状态码、四条头、正文全部失配，且上游请求数从 11 涨到 22/33（被拒的请求打到了上游） |
| M2 | `triage-monitor.js` 两处 `enabled` 守卫一起去掉（暂停期间照样轮询并入队） | A2 红 4 条：`last_poll_at` 前进、`queued=1`、`malware:21` 变 `queued`、日志多出 1 条 `triage.enqueued` |
| M2' | **只去掉其中一处**守卫（`poll()` 首行 或 取数后的二次判定） | **仍全绿**——两道守卫互为兜底，单独去掉可观测行为不变。记在这里：这是产品本来的双保险，不是探针不灵 |
| M3 | `triage-monitor.js:200` 恢复时不重置游标 | A2 红 3 条：暂停期积压被补跑（`malware:21` 变 `running`），连带结论走了兜底回包 |
| M4 | `trace-board.js:453` program 边条件改成 `if (false)` | A3 红 5 条：`links` 空、`rel`/`evidence_id`/`edge.by` 全失配 |
| M5 | `trace-board.js:456` `strength: 0.3` → `0.9` | A3 红 1 条：`建边：program 边 strength=0.3（R-TRACE-05）` 实测 0.9（23:2x 亲手复现；补这条守卫前此处全绿） |

## §A4 · jsp 检测时效：牧云检出过（盘上案卷为证）；端到端四段仍未逐段量到

**结论口径：窗口内未现、后续已检出，具体延迟以盘上时间戳为准。**

上午测试时盯着控制台，观察窗口内没等到这条 jsp 的告警；但**事后盘上案卷证明牧云检出过它**：
主仓 `.data/cases/cloudwalker-malware/20261119-041308-d13452de-a1fe3670/01-原始告警.txt:1` 是 `host_ip="192.168.24.21"`、`event_id=3`、`file_path="/tmp/hids-live-test.jsp"`、`detect_source="jspxwebshell"`、`file_type="jsp_webshell"`；同案卷 `02-告警字段.md:43` 的 `process_cmdline` 就是写这个文件的命令（`bash -c printf … > /tmp/hids-live-test.jsp`，`root`）。时间戳：`file_create_time=2026-11-19 12:09:06` → `event_create_time=2026-11-19 12:09:09`、`first_found_time=2026-11-19 12:09:09`，差 **3s**。
所以「牧云没检出 jsp」不成立；能说的只有「观察窗口内未现、后续已检出」。

**现场可推算的量（现场数据，本卡未复测；来源 `主仓 .data/cases/cloudwalker-malware/*/01-原始告警.txt`）**

| 案卷 | 文件 | `file_create_time` | `event_create_time` | 差 |
| --- | --- | --- | --- | --- |
| 20261119-040910-ff70cd3d | `/dev/shm/detector_tmp/jspxwebshell/…/bat4iskw….jsp` | 2026-11-19 12:09:08 | 2026-11-19 12:09:09 | 1s |
| 20261119-041106-46300e25 | `/dev/shm/detector_tmp/jspxwebshell/…/belbr8b9….jsp` | 2026-11-19 12:09:08 | 2026-11-19 12:09:09 | 1s |
| 20261119-041308-d13452de | `/tmp/hids-live-test.jsp`（人工 live-test 写入，`event_id=3`） | 2026-11-19 12:09:06 | 2026-11-19 12:09:09 | 3s |

三条都是 `detect_source=jspxwebshell`、`file_type=jsp_webshell`、主机 `192.168.24.21`。**这仍不是「扫描时效」的完整口径**：`file_create_time` 是文件自身的时间戳，`event_create_time` 是牧云事件时间，中间的「引擎扫到 → 落事件 → syslog 投递 → 控制台入队」四段没有一段被单独量到；3s 只覆盖「文件写入 → 事件落库」，**不含** syslog 投递与控制台入队，具体延迟以盘上时间戳为准。

**待真环境复验项（本卡没做，谁也别说验过了）**

1. 端到端时效：在 24.21 写一个测试 jsp → 记录「写入时刻 / 牧云事件 `event_create_time` / 控制台 `triage.enqueued` 时刻」三个时间戳，给出三段差。**「牧云会不会检出 jsp」这一问已有盘上答案（会，见上），欠的只是中间四段的逐段耗时。** 判据是现场先定口径，不是本卡定的。
2. `docs/modules/triage-pipeline.md` §12 里「单条告警端到端延迟」本来就标着**未测量**（同文件 `:835`、`:878`）——本卡没有推翻它，也没有补上它。
3. 需要：能连 24.21（现不可达，见 §A5）+ 真牧云凭据 + 真模型服务。

## §A5 · 隧道恢复后：两项都做不了（**本卡没做**）

**群主已裁（2026-11-19 22:34）**：A5 拆 **T048 挂起**（等 T035 合并 + 隧道恢复；2026-11-19 23:2x 补：T035 已并入 main `2aa89ff`，这条前置解除，T048 只剩主机可达），本卡按现状收口，A5 记 `not-satisfied`。下面两处「对不上」也已对齐：卡面「两条失败」是上午现场报告当时的口径（后来三条都 failed，后续重跑以盘上三条为准）；`/tmp/hids-live-test.jsp` 是现场测试人工写上 24.21 的，与 `/dev/shm/detector_tmp/jspxwebshell/...` 那批牧云自检样本不是同一个东西。

### 一、`/tmp/hids-live-test.jsp` 清理：主机不可达

在本树实测（19:1x 与 22:1x 各一次，结果一致）：

```
$ ping -c 2 -W 2 192.168.24.21
--- 192.168.24.21 ping statistics ---
2 packets transmitted, 0 received, 100% packet loss, time 1021ms

$ ssh -o BatchMode=yes -o ConnectTimeout=4 root@192.168.24.21 'ls -l /tmp/hids-live-test.jsp'
ssh: connect to host 192.168.24.21 port 22: Connection timed out

$ for p in 22 8080 15514; do timeout 3 bash -c "echo > /dev/tcp/192.168.24.21/$p" …; done
22 timeout / 8080 timeout / 15514 timeout
```

旁证：`~/.ssh/known_hosts` 里没有这个地址；`tailscale status` 的对端只有 100.64.0.1/0.3/0.4/0.7/0.8，没有 24.21 段；`ip route get 192.168.24.21` 走 `192.168.3.1 dev wlp4s0`（家宽默认路由，不是隧道）。**隧道现在没恢复，这条路走不通。**

**必须写清楚的一条（2026-11-19 23:2x 更正；早前版本写反了）**：24.21 上的 `/tmp/hids-live-test.jsp` **有盘上案卷，牧云检出过**——`主仓 .data/cases/cloudwalker-malware/20261119-041308-d13452de-a1fe3670/01-原始告警.txt:1` 是 `host_ip="192.168.24.21"`、`event_id=3`、`file_path="/tmp/hids-live-test.jsp"`、`detect_source="jspxwebshell"`；同案卷 `02-告警字段.md:43` 的 `process_cmdline` 就是写这个文件的命令（`bash -c printf … > /tmp/hids-live-test.jsp`，`root`）；时间戳 `file_create_time=12:09:06` → `event_create_time=12:09:09`（3s）。
另一条 `host_ip="10.9.9.9"`、`event_id=9001` 的人工注入 syslog（`.data/cases/cloudwalker-webshell/20261119-040850-b8d13018-73a6ead7/01-原始告警.txt`，结论「人工登记误报（live-test）：现场测试注入的样例」）是**另一件事**，不能拿它推断 24.21 上没有这个文件。
**没查到**：24.21 的 `/tmp/` 下这个文件**现在**还在不在——主机连不上，无法核实，不猜。清理范围按「文件确实被写入过、且已被检出」记进 T048。

### 二、上午两条失败研判重跑：依赖已解除，只剩取数通道不可用

- 卡面写「依赖 T035 已合并」。22:1x 时确实没合并；**23:2x 复核已并入**（`Bash` 于主仓，2026-11-19 23:2x）：

```
$ git -C /home/trtyr/code/hids-ai-console rev-parse --short main          → 2aa89ff
$ git -C /home/trtyr/code/hids-ai-console log --oneline -1 main
2aa89ff merge: P003-T035 研判结论质量——降级存疑/复核口径/缺口不撒谎（吸收 T031）
$ git -C /home/trtyr/code/hids-ai-console merge-base --is-ancestor task/hids-ai-console-P003-T035 main  → exit 0（已并入）
```

  本卡树起活 commit 是 `44eca4b`（早于这次 merge），所以本树里没有「新结论逻辑」；但**依赖面已经解除**——T048 重跑时基于合并后的 main 即可。

- 剩下唯一阻塞是取数通道：重跑要读牧云事件（`/rpc` 在 192.168.24.21:8080）——主机不可达（见上）。这一项现在是**单阻塞：主机可达**。

- 上午的失败记录（**现场数据，只读**，`主仓 .data/triage-monitor.json`）：

| alert_id | 状态 | 失败原因 | 匹配到的牧云事件 |
| --- | --- | --- | --- |
| `syslog:malware:301104f9e5eb139c:…` | failed | 模型没有返回可用消息 | `malware:1` |
| `syslog:malware:ed7b08a6d101a71b:…` | failed | 模型未在调查轮数内给出有效 JSON 结论 | `malware:2` |
| `syslog:malware:8b7250f74ee2d100:…` | failed | 模型未在调查轮数内给出有效 JSON 结论 | `malware:3` |

  卡面说「两条失败研判」，盘上是 **3 条 failed**；其中「模型未在调查轮数内给出有效 JSON 结论」恰好 **2 条**——如果卡面指的是这一种失败，那就是这 2 条（`malware:2` / `malware:3`）。**没查到**：卡面原本指哪两条。确认要问群主，不猜。

## 本卡没有验到的（别读成验过了）

- 真牧云的任何响应形状、真模型的结论质量（本卡全程替身）。
- 192.168.24.21 上的任何文件状态（不可达）。
- 24.21 上 jsp 从写入到控制台入队的逐段耗时（§A4：牧云检出过、盘上 3s 只是 `file_create` → `event_create`，四段没逐段量到）。
- 上午 3 条失败研判的重跑与案卷补齐（§A5：T035 已并入 main `2aa89ff`，唯一前置是主机可达）。
- 暂停/恢复在 **syslog 输入模式**下的行为（本卡验的是 poll 模式；syslog 模式的暂停是 `triage-monitor.js:309-311` 的 `skipped:'paused'`，只有单测覆盖）。
