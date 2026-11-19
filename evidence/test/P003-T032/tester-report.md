# P003-T032 测试侧报告（gc-backend-tester，复验 / 测试审计）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T032`
- 卡况：取证卡，产品代码零改动（`git diff --name-only 44eca4b..HEAD` = 10 个文件，全在 evidence/docs/coding-reports）
- 本卷作用：作废同席位旧卷 `P003-T032-gc-backend-tester-mwno6356.json`，本卷为唯一有效测试判词
- 时间：2026-11-19 22:53–23:0x（本地）

## 现场漂移（正当）

| 项 | 起活快照 | 本次实测 |
| --- | --- | --- |
| 本卡分支 HEAD | 6f1dc44 | **6f1dc44 未变** |
| main | 60a63dd（上卷记） | **1ccbb61**（又往前走了，与本卡无关） |
| 本卡是否已合并 | — | 未合并（`git merge-base --is-ancestor HEAD main` → exit 1），不是被清了目录 |
| T035 分支 | 报告写 7d44d8e/3 提交 | **6a57bcc/4 提交，仍 NOT_MERGED** |

判 scope 要看 `44eca4b..HEAD`（`git diff main..HEAD` 会把别人后来合进 main 的改动反向显示）。

## 门禁（全部本机亲手跑，未转录写者/审查侧输出）

```
$ bash evidence/test/P003-T032/run-all.sh
A1 结果：ALL GREEN / A2 结果：ALL GREEN / A3 结果：ALL GREEN
===== 汇总：ALL GREEN =====      → 退出码 0，real 1m1.636s

$ timeout 180 npm test
ℹ tests 198 / pass 198 / fail 0 / duration_ms 737.29   → 退出码 0
```

## 我自己的契约探针（tester 自建，不属写者取证件）

`evidence/test/P003-T032/tester-probe-contract.mjs`（未跟踪文件，测试侧自带）。真进程 + 替身牧云/替身模型，
按 `openapi.yaml` + `docs/modules/http-api.md` 造请求：

```
$ timeout 180 node evidence/test/P003-T032/tester-probe-contract.mjs
275 条 PASS / 1 条 FAIL   → 退出码 1（唯一 FAIL 见下方发现 1）
```

覆盖矩阵（每条都真发请求，断言响应体字段/类型/形状，不只看状态码）：

| 组 | 内容 |
| --- | --- |
| 401 身份闸 | 三条路由 × 四条头 + 纯文本正文 |
| 固定档位 | 未知 API 404「接口不存在」、`POST /api/agent/prompts` 405、`POST /api/agent/prompts/upload` 410 |
| 分页边界 | `/api/alerts` `count=0/51/abc/20.5`、`offset=-1`、`count=` 空串；`/api/agent/triage/cases`、`/api/trace/boards`、`/api/wiki/pages` 各自的 400 |
| 查询枚举 | `type` 不在 11 类、`sort` 非 time/level、`level=5`、`from` 解析不出、`from>to`、`triage_status`/`verdict` 非法 → 400 |
| schema 符合性 | `/api/alerts` 六个必填键、详情 `{alert,detail}`、`/api/config` 八键且不回显密钥、triage status 七键、`TriageSummary`、`TraceBoard`/`TraceBoardLink`/`TraceBoardSummary`、`RuleSetResponse`、`RegoRuleList`/`RegoEvaluation`、wiki `{pages,total}`/`{sessions}` |
| 正文形状 | `PUT control` 缺 `enabled`、`enabled:"false"`、非 JSON、数组、超 8192 超长（文案「请求正文过大」）；`POST triage/rules/validate` 缺 config / 非 JSON |
| 错误码 | 400 / 401 / 403 / 404 / 405 / 409 / 410 / 422 / 500 / 502 / 503 各至少触发一次，且断言 `{error,code}` 四值枚举 |
| 500 注入 | `.data` chmod 0500 → `POST /api/config` 写盘失败 → 500「服务器内部错误」、响应里没有 stack trace |
| 502 | 停掉替身后 `/api/alerts` → 502 `upstream_error`（带上游原话）；`/api/status` 502 业务体 `{configured,connected,reason,code}` |
| 503 | 第二个未配令牌进程：`PUT /api/triage/rules` → 503「尚未配置规则管理员令牌」、`GET /api/wiki/health` → 503「尚未配置知识库管理员凭据」 |

**补上旧卷记的那个缺口**：旧卷 finding 说 A3 探针没断言程序边 `strength`。我读的是服务落盘的那份白板
（`repoRoot/.data/trace-boards/malware:1.json`，服务自己写的运行态输出，不是源码），实测
`edges[].strength === 0.3`、`by === 'program'`、`why/citations/at` 齐 → 文档口径 `trace-board.md:252`（程序边固定 0.3）
在真实落盘数据上成立。

## 变异验红（亲手复现，不引用上家）

```
$ grep -n "^function hasAccess" server.js          → 413:function hasAccess(req, access) {
$ cp server.js /tmp/t032-server-mine.bak
$ sed -i '413a\  return true;' server.js && node --check server.js     # 鉴权恒放行（盲改，不读实现正文）
$ node evidence/test/P003-T032/probe-a1-401.mjs
21 条 FAIL，退出码 1（首个：无凭据：状态 401 | 实测 200；正文直接吐出 alerts JSON）
$ cp /tmp/t032-server-mine.bak server.js && node --check server.js
$ git diff --stat -- server.js                      → 空
$ node evidence/test/P003-T032/probe-a1-401.mjs     → ALL GREEN，退出码 0
```

## 我在自建探针里踩的坑（记录，免得下一个人再花时间）

起进程前就把 webshell 告警灌进替身上游时，poll 模式的研判监视器**启动首轮会把它入队**，研判链路与溯源白板
**抢同一份替身模型脚本**；白板拿到的是兜底回包，于是「尚未调查任何节点，不能结束」→ 白板 `failed`。
表现是 3 连跑里 2 次白板失败、6 条断言红（复现条件：先灌告警再建板）。

**分诊：A 类（探针自身错），不是产品缺陷。** 处置：起进程后先 `PUT control {enabled:false}` 隔离监视器，
灌告警做列表断言，白板跑完再恢复研判。改完 3 连跑稳定：**275 PASS / 1 FAIL**（同一 FAIL）。
写者那条 A3 探针没这个干扰（它 `lists: {}`），所以它的绿不是侥幸。

## 发现

### 1（minor，非本卡引入）`PUT /api/agent/triage/control` 收表外字段回 200，与 openapi 声明不符

- 文档：`openapi.yaml:473-477` `setTriageEnabled` 的 body schema 声明 `additionalProperties: false`
- 复现：

```
$ node evidence/test/P003-T032/tester-probe-contract.mjs    # 组「PUT control 表外键」
PUT /api/agent/triage/control  body {"enabled":true,"junk":1}  → 200 {"initialized":true,"enabled":true,...}
```

- 预期：400（`caller_error`，「表外键」）
- 实测：200，`junk` 被静默忽略
- 说明：`docs/modules/http-api.md` §8.2 只承诺「缺 enabled / 类型错 / 非 JSON」等，没有承诺拒表外键；
  所以这是 **spec 比实现严** 的松紧不一致。本卡产品代码零改动，此不一致**不是本卡引入**，
  建议另立小卡（二选一：实现加白名单校验，或 openapi 去掉 `additionalProperties:false`）。

### 2（minor，承接上家）交卷报告 `coding-reports/P003-T032.md:113-115` 仍有一对空代码围栏

```
$ sed -n '113,115p' coding-reports/P003-T032.md | cat -A   → ``` / (空行) / ```
```

纯排版，不挡过。

### 3（minor，承接上家）`evidence/test/P003-T032/test-report.md:129` 的 T035 提交号是快照

报告写 `7d44d8e / 3 提交`，实测 `6a57bcc / 4 提交`，仍 `NOT_MERGED`（结论不变）。T048 开工时须重取两边 HEAD。

## 逐条验（A1–A6）

| 项 | 判定 | 证据 |
| --- | --- | --- |
| A1 401 三态 + 四条头 + 被拒不碰上游 | satisfied | `run-all.sh` A1 33 条 PASS；我另跑 3 条路由 × 四条头；变异 M1 下 21 条恰红 |
| A2 暂停不轮询 / 恢复不补跑 / 恢复后新告警跑到 done | satisfied | `run-all.sh` A2 18 条 PASS（`last_poll_at` 不前进、`malware:21` not_queued、`malware:22` → done）；我探针里也复验了暂停/恢复往返 |
| A3 替身形状建 program 边 203.0.113.77 | satisfied | `run-all.sh` A3 11 条 PASS；我另验落盘 `strength=0.3`/`by=program` |
| A4 只记待真环境复验 | satisfied | `docs/modules/triage-pipeline.md:835/:878` 仍标「未测量」；`test-report.md:109-127` 三段待复验 + 判据未定 |
| A5 隧道恢复后两项 | **not-satisfied**（群主已裁拆 T048） | 本机复测：`ping -c 2 -W 2 192.168.24.21` → 2 发 0 收 100% 丢包；`echo > /dev/tcp/192.168.24.21/22` → exit 124（timeout）；`grep -c 192.168.24.21 ~/.ssh/known_hosts` → 0（exit 1）；`git merge-base --is-ancestor task/hids-ai-console-P003-T035 main` → exit 1（6a57bcc） |
| A6 环境标注 + 三处否认 | satisfied | `test-report.md:8-17` 四条标注表 + 「本卡没有任何一条结论来自真牧云或真模型」；三条探针头部分别标了真进程/替身牧云/替身模型；`docs/_meta/gaps.md:120-148` 已验/还欠分列 |

## 没验到的（别读成验过了）

- 真牧云、真模型的任何响应与结论质量（全程替身）。
- `/api/alerts` 的 **503（未配牧云）** 真进程不可达：启动闸门先拒启动（缺必填不 listen），这条只能由注入依赖的单测覆盖（`npm test` 内）。
- 维护服务（`maintenance-server.js`，18081 独立进程）整片未验：不属于本卡锚点。
- SSE 流式响应（`/api/agent/investigations` 流）未验。
- 管理令牌 `timingSafeEqual` 侧信道未验（只验了 403/503 两档 + 正常放行）。
- 过期会话 / 并发写规则集的竞争未验。

## 收尾

- `git status --short`：只有 `?? evidence/test/P003-T032/tester-probe-contract.mjs`（本测试侧自带）
- `.data`：无（`ls .data` → No such file or directory）
- 残留进程：0（`ps | grep stub-muyun|P003-T032/server` → 0）
- 产品代码：`git diff --stat -- server.js` 空（变异已还原）
