# P003-T003 复审修复测试报告 · 详情语义与证据条目

- 任务卡：P003-T003（席位 gc-backend-tester / 何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T003`（分支 `task/hids-ai-console-P003-T003`）
- HEAD：`7c8cdb8fd801e4193b1ffb5e70ddbfaf881590ab`（docs 收口；代码提交 `caecc0a`，基线 `ddd21b1`）
- 现场核对：派活单写 HEAD `caecc0a`，实际 HEAD `7c8cdb8`——同一分支上多一个 docs 提交（`git log --oneline ddd21b1..HEAD` 共两个提交：`caecc0a` 代码 + `7c8cdb8` 报告），属正当漂移，按实际 HEAD 验收。
- 判据来源：`openapi.yaml`（本仓接口契约唯一落点，本卡 scope）+ 任务卡 A1–A4。探针只发 HTTP 请求、只读产品自己的落盘状态文件与响应，不 import 产品模块。
- 运行环境：Node v26.13.0、redocly 2.77.0（离线）

## 结论

**PASS。** 派活单四条锚点（A1 详情错误语义 / A2 TriageCase evidence[] 五态三出口 / A3 triage_configured 两态 / A4 契约零改动 + lint 同基线）全部在我终端里亲手跑绿：

- 自写探针 `evidence/p003-t003-verify/verify.mjs`：**96 PASS / 0 FAIL，EXIT=0**（日志 `verify-final.log`）；探针内另记 1 条 scope 外既有缺口（control 多余字段 200，见 §六）。
- 变异验红亲手复现：删详情 400 守卫（`server.js:423`）→ `integration.test.js` **not ok 20**、我的探针 **5 条 FAIL**（非法 ID 变 502 且真打了牧云）；还原后 sha256 与变异前一致，21/21 复绿、探针 96/0 复绿。
- 全量门禁：115 tests / 114 pass / 1 fail（唯一红 `maintenance-startup symlink`，我在 `1a1355a` 基线复跑同样红）；A4：`openapi.yaml` 与 `ddd21b1` 逐字节相同（sha256 一致），redocly errors 0 / warnings 21，warning 集合 added 0 / removed 0。

## 一、门禁（全部我自己终端跑，命令原文 + 退出码）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 本树后端全套 | `timeout 300 node --test --test-reporter=tap *.test.js` | `# tests 115 / pass 114 / fail 1`，`EXIT=1`；唯一红 `not ok 70 - maintenance CLI starts when the deployment current path is a symlink`（`Cannot find module '…/current/backend/maintenance-server.js'`） |
| 基线同口径复跑唯一红 | `git archive 1a1355a \| tar -x -C /tmp/p003-base-1a1355a` → `timeout 120 node --test --test-reporter=tap maintenance-startup.test.js` | `# tests 1 / pass 0 / fail 1`，`EXIT=1`，同一现象（同一 MODULE_NOT_FOUND）→ 基线既有，不在本卡 scope |
| 本卡相关集成测试 | `timeout 120 node --test --test-reporter=tap integration.test.js` | `# tests 21 / pass 21 / fail 0`，`EXIT=0` |
| OpenAPI lint（现状） | `timeout 180 npx --offline @redocly/cli lint openapi.yaml --format=json` | `EXIT=0`，errors 0 / warnings 21（`lint-now.json`） |
| OpenAPI lint（基线 ddd21b1） | `git show ddd21b1:openapi.yaml > /tmp/p003-baseline-ddd21b1/openapi.yaml` → 同 lint | `EXIT=0`，errors 0 / warnings 21；`ruleId\|pointer` 集合比对 **added 0 / removed 0**（`lint-baseline-ddd21b1.json`） |
| A4 契约零改动 | `git diff ddd21b1..HEAD -- openapi.yaml \| wc -l` | `0`（现状与基线 sha256 同为 `932de6a9…090946`） |
| 产品代码零改动 | `git status --short` | 只有 `?? evidence/p003-t003-verify/`（本报告与探针），无产品文件改动 |

## 二、A1 详情错误语义（派活锚点：webshell:0/abc/webshell/1.5/nope:1→400 且不打牧云；未知 ID→404；不可达→502；正常→200；未配置→503）

探针 `verify.mjs:143` 起（非法 ID 循环，每条同时断言「期间 RPC 0 次」）、`:129/:141/:411/:444`。假牧云 `/rpc` + 真 `node server.js` 子进程。

| 输入 | 期望（契约 `openapi.yaml:198-232`） | 实测 |
| --- | --- | --- |
| `webshell:1`（上游正常） | 200 `{alert, detail}` | 200，`alert.id=webshell:1`、`detail` 为对象 |
| `webshell:0` | 400 | 400 `{error}`，期间 RPC 0 次 |
| `webshell:abc` | 400 | 400 `{error}`，期间 RPC 0 次 |
| `webshell` | 400 | 400 `{error}`，期间 RPC 0 次 |
| `1.5` | 400 | 400 `{error}`，期间 RPC 0 次 |
| `webshell:1:2`（多余段） | 400 | 400 `{error}`，期间 RPC 0 次 |
| `nope:1`（类型不在枚举） | 400 | 400 `{error}`，期间 RPC 0 次 |
| `webshell:999` + 上游 `event:null` | 404 | 404 `{error}` |
| `webshell:999` + 上游 GetEvent 报错、列表可达 | 404 | 404 `{error}` |
| `webshell:999` + 上游 `result:{}` | 404 | 404 `{error}` |
| `webshell:1` + 上游回 event_id=99（自相矛盾） | 502 | 502 `{error}` |
| 牧云连不上 | 502 | 502 `{error}` |
| 未配 `CLOUDWALKER_*` | 503 | 503 `{error}` |

「不打牧云」的判法是假网关按方法计数：非法 ID 请求前后 `seen.length` 不变。

## 三、A2 TriageCase evidence[] 恒为数组（五态 / 四字段 / args 不外露 / 三处出口）

出口三处：`GET /api/agent/triage/{id}`、`POST …/{id}` 202、`GET /api/alerts` 的 `alerts[].triage`。五态产生方式与实测：

| 状态 | 怎么造（黑盒） | 实测 |
| --- | --- | --- |
| `not_queued` | `GET /api/agent/triage/webshell:424242`（无记录） | 200、`status=not_queued`、`evidence: []`（`verify.mjs:319`） |
| `queued` | `PUT control enabled=false` → `POST /api/agent/triage/webshell:903` | POST **202** 且 `evidence: []`；随后 GET 单条 200 `status=queued`、`evidence: []`（`verify.mjs:346/349`） |
| `running` | 假 LLM 挂住请求（真产品路径，不注入），`POST /api/agent/triage/webshell:1` 后 100ms 轮询 | 抓到 `status=running`，`evidence` 是数组、四字段（`verify.mjs:393`） |
| `failed` | 模型不可达真跑（syslog 入队 → 模型 500）；另注入一条 `webshell:902` 落盘记录 | cases()/GET 单条均 `status=failed`、`evidence` 四字段数组（`verify.mjs:333` 起） |
| `done` | syslog 真跑记录 + 注入 `done` 记录（带 2 条 evidence） | cases()/GET 单条均数组、四字段、条数对（`verify.mjs:202/307`） |

四字段与 args 断言（`assertEvidence`，`verify.mjs:282` 起）：键集合 **恰为** `evidence_id,tool,fetched_at,sha256`；`args` 出现即红；`sha256` 必为 64 位小写十六进制；`fetched_at` 必可解析为时间。args 不外露的强证据两条：①真跑路径产出的记录四字段干净（`:202`）；②研判记录（产品自己写的 `investigations/*.json`，其中 evidence 带 `args`）经 `load()` 补齐后，`cases()` 与单条出口都只剩四字段（`:307` 起）。三处出口都断言过：`alerts[].triage`（`:325`）、GET 单条（多处）、POST 202（`:346`、`:382` 附近）。

## 四、A3 triage_configured 两态 + false 时 `alerts[].triage` 键在值为 null

| 配置 | 实测 |
| --- | --- |
| 配了模型（研判监视器在） | `GET /api/alerts` 200、`triage_configured === true`，required 六字段齐（`verify.mjs:173` 附近）；带 `triage_status/verdict/level/type/sort/q` 的筛选分支同样带布尔（`:178` 起） |
| 没配模型 | `triage_configured === false`，`alerts[].triage` 每条 `=== null`（键在，非 undefined）；`triage_status=not_queued` 全中、`done` 为 0、`verdict=review` 全中（`verify.mjs:425` 起） |
| 参数边界 | `count=0/51/abc`、`offset=-1`、`triage_status/verdict/level/type/sort` 非法枚举 → 全部 400 `{error}`（`:184` 起） |

## 五、A4 openapi 本轮零改动 + lint 同基线

- `git diff ddd21b1..HEAD -- openapi.yaml` → 0 行；`sha256sum openapi.yaml` 与 `git show ddd21b1:openapi.yaml` 全部 `932de6a9d8200a600c2eb5cfb4a879e9468dae918f9b47aa1c71db700a090946`。
- redocly 现状与基线均 `errors 0 / warnings 21`，按 `ruleId|pointer` 比对 added 0 / removed 0。
- 契约三句承诺（`openapi.yaml:208`「格式不对或类型不在枚举 → 400」、`:149`「false 时 triage 恒为 null」、`:936-946`「evidence 四字段 / 未配置或排队时是空数组」）逐条被 §二/§三/§四实测兑现。

## 六、变异验红（亲手复现，不引用他人）

1. `sha256sum server.js` → `1ec656e728ebdf00525cb2f00a52eb7bb2bb3d4e48e62ff27faafd86a1f7707a`
2. `sed -i '423s/.*/;/' server.js`（删「告警 ID 无效 → 400」守卫；`node --check` 通过）
3. `timeout 120 node --test --test-reporter=tap integration.test.js` → `EXIT=1`，`not ok 20 - HTTP 详情：告警 ID 格式不对或类型不在枚举 → 400，不浪费一次牧云调用`，其余 20 绿（`/tmp/p003-int-mut.log`）
4. 变异态跑自写探针 → `EXIT=1`，5 条 FAIL：`webshell:0/abc/webshell` 变 **502**、`webshell:1:2` 变 502、且 `webshell:1:2` 真发出了 `WebshellEventService.GetEvent`（`/tmp/p003-verify-mut.log`）
5. 还原（`cp /tmp/p003-server.orig.js server.js`）→ `sha256sum` 与 1 相同；`integration.test.js` 21/21 绿；探针 96 PASS / 0 FAIL（`verify-final.log`）；`git status --short` 无产品文件改动

结论：两条门禁断言都会红、不是永真断言。

## 七、记账（findings）

| # | 严重度 | 文档出处 | 文档说 | 实测 | 复现 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | minor（既有，非本卡引入） | `openapi.yaml:277-287`（`/api/agent/triage/control` requestBody `additionalProperties:false`，responses 有 400） | 请求体多带字段 → 400 | 多带 `extra:1` → **200**，多余字段被忽略 | `node evidence/p003-t003-verify/verify.mjs`（KNOWN-FAIL 行）；基线复跑：`git archive ddd21b1` 解到 `/tmp/p003-base-ddd21b1` 起真 server，同请求 → 200 | 本卡 scope 外（control 未改），属既有契约缺口，另开卡处理，不挡本卡 |

## 八、残余风险 / 未决

1. F1 未修（本卡未动 control），需要另一张卡：要么实现 400，要么把契约的 `additionalProperties:false` 撤掉。
2. `done`/`failed` 两态用了落盘状态注入（产品自己的 `triage-monitor.json`）作为 setup；这两态的**输出**仍按接口断言，`running`/`queued`/`not_queued` 三态全部走真产品路径（假 LLM 挂住 / 暂停入队 / 无记录），无注入。
3. 探针里 `webshell:1` 的 running 场景依赖「模型调用期间状态是 running」这一时序；5 秒窗口内轮询 50 次，本机两次连跑都抓到；换慢机器可调窗口。
4. 探针/报告未提交 git（`?? evidence/p003-t003-verify/`），保持产品树零改动；要入库请群主定。
