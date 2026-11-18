# P003-T001 测试报告 · 告警筛选与排序

- 任务卡：P003-T001（席位 gc-backend-tester / 何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T001`
- 分支 `task/hids-ai-console-P003-T001`，HEAD `683492f`（代码提交 `85c21cb` + 报告提交），基线 `03dff3c`
- 运行环境：Node v26.13.0、redocly 2.77.0
- 判据来源：`openapi.yaml`（本卡 scope 内的接口契约）+ `docs/modules/http-api.md`、`docs/modules/event-gateway.md`、`docs/architecture.md`（现状文档，只用于回归口径）。本仓没有 `docs/api/**`，接口契约的唯一落点是 `openapi.yaml`。

## 结论

**PASS。** 手上 61 条黑盒用例（48 + 13）全绿，A1–A5 全部有我自己终端里跑出来的证据；没发现实现违约。4 条记账：3 条文档缺口（1 major 已被代码审查记账、2 minor）、1 条（`query`/`note` 未文档化）与审查记的 `server.js:166` 是同一事实的黑盒侧面。

## 一、门禁（全部我自己跑，命令原文 + 退出码）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 本树后端全套（根目录 15 个测试文件） | `node --test --test-reporter=tap *.test.js` | `# tests 107 / pass 106 / fail 1`，`EXIT=1`；唯一红 `maintenance CLI starts when the deployment current path is a symlink` |
| 基线同口径 | 本树内 `git archive 03dff3c` 解到证据目录后跑同命令（跑完即删） | `# tests 99 / pass 98 / fail 1`，`EXIT=1`，同一条红 |
| 仓库级默认发现（含 web/test） | `node --test --test-reporter=tap` | `# tests 232 / pass 221 / fail 11`，`EXIT=1`；11 红全在 `web/test/**`，而 `git diff --stat 03dff3c -- web/` 为空 → 基线预存 |
| OpenAPI | `redocly lint openapi.yaml` / 对基线 `redocly lint --format=json` 比对 | 两次都是 `valid`、`21 warnings`、`EXIT=0`；按 `ruleId|pointer` 比对 `added=[] removed=[]`（日志 `lint-new.json` / `lint-base.json`） |
| 产品代码零改动 | `git status --short` | 只有 `?? evidence/p003-t001-api/`（本报告与探针），无产品文件改动 |

基线红与 A1–A5 无关的依据：`maintenance-startup.test.js`、`maintenance-server.js` 与基线逐字节相同（`git diff 03dff3c -- <file>` 无输出）；根目录测试数 99→107 是新增 8 条用例，且 8 条全绿。

## 二、验收对账（A1–A5）

探针：`evidence/p003-t001-api/checks.mjs`（48 例，真 `node server.js` + 假牧云 `/rpc` 上游）与 `evidence/p003-t001-api/triage-checks.mjs`（13 例，研判队列装配场景）。日志：`checks.log`（`# 用例 48 / 通过 48 / 失败 0`，`EXIT=0`）、`triage-checks.log`（`# 用例 13 / 失败 0`，`EXIT=0`）。

| 验收 | 我的锚点 | 证据（我跑的） |
| --- | --- | --- |
| A1 type 下推 | `checks.mjs:236`（A1）、`checks.mjs:245`（A1b） | `?type=webshell` → `ids=webshell:2,webshell:1,webshell:3`、`total=3`、`totals={webshell:3}`，且该请求上游只收到 **1 个 RPC**（`WebshellEventService.GetEventList`）；`?type=revshell`（该类 0 条）→ `alerts=[] total=0 totals={revshell:0}` |
| A2 level/q/from/to 过滤后切页 | `checks.mjs:254`（A2a）、`checks.mjs:271`（A2d）、`checks.mjs:284`（A2f） | `level=high,critical` → `total=3`；`level=3,4` 与键名写法结果全等；`level=high,critical&count=1&offset=1` → 第二页 `[webshell:1]`、`total` 仍 3；`from=08:00Z&to=09:00Z` → 两端都被包含（2 条）；秒级时间戳与 RFC3339 等价；`q=REVERSE` 大小写不敏感命中 `cmdline`；`type=webshell&q=db-1` → 2；无事件时间的 `honeypot:4` 在带 `from` 时被排除（1→0） |
| A3 triage_status/verdict 挂完 triage | `triage-checks.mjs:116`（A3-1）、`:139`（A3-5）、`:145`（A3-6）、`:158`（A3-7）、`:186`（A3-10） | 无记录：`not_queued`→3 条全中、`done`→0、`verdict=review`→3、`threat`→0；`POST /api/agent/triage/webshell:1`→202，状态 `running→failed`（模型不可达）；终态后 `triage_status=failed` 命中 `webshell:1`、`not_queued` 不再命中它、`total=2`；多选并集 `queued,running,done,failed`=1 条、加 `not_queued` 后=3；筛选后跨页 `count=1&offset=1` 页长 1、`total=2`；有记录时 `alerts[].triage` 形状符合 `TriageCase`，无记录时为 `null` |
| A4 sort=time|level + 无参回归 | `checks.mjs:303`（A4a）、`:318`（A4c）、`:324`（A4d）/`:329`（A4e）/`:334`（A4f） | 无参：`total=6`（=各类 total 之和）、11 类 `totals`、时间倒序、无时间事件排末位；`sort=time` 与不带 `sort` 的 `alerts/total/totals/errors/partial/truncated` 六项全等；`sort=level` → `[webshell:1, malware:5, webshell:3, webshell:2, malware:6, honeypot:4]`（等级降序、同级时间倒序）；`count=2&offset=1` 分页形状不变；`offset=100` → `alerts=[] total=6` |
| A5 openapi 同步 | `evidence/p003-t001-api/lint-*.json` | `redocly lint` 通过；与基线 `03dff3c:openapi.yaml` 比对 21 条 warning **同集**（`added=[] removed=[]`），0 新增 |
| 扫描窗口 / truncated（本卡新承诺） | `checks.mjs:341`（S1）、`:350`（S2）、`:358`（S3） | 600 条造数 + `type=webshell&level=critical` → `truncated=true`、`total=125`（= 最新 500 条窗口内 level=4 的条数）、返回条目全在窗口内；`offset=100` → 页长 25；不带筛选的 600 条库 → `total=600 truncated=false` |

## 三、边界与错误码（逐条都触发过，断言了响应体形状而不只是状态码）

- `count=0 / 51 / abc / 20.5`、`offset=-1 / abc` → 全部 `400` + `{"error":"分页参数无效"}`（`checks.mjs:371` 起，逐条断言见 `:379`）。
- 非法枚举 → 全部 `400` + `{error:string}`：`type=nope` / `type=WebShell` / `type=webshell,nope` / `level=9` / `level=loud` / `sort=name` / `from=abc` / `to=abc` / `from>to` / `triage_status=nope` / `verdict=nope`（`:428` 起）。
- `level=1,high`（键名与序号混选）→ 200，两段都收（`ids=[malware:5,webshell:3,malware:6,honeypot:4]`）。
- `q` 5000 字符 → 200、`total=0`、不 500；`q=` 空串 → 200、`total=6`（按未筛选）。
- `offset` 越过总数 → 200 + `alerts=[]`。
- 401：无凭据 → 纯文本「需要登录后访问」+ `WWW-Authenticate: Basic realm=...`，不是 JSON。
- 502：11 类 RPC 全失败 → `{"error":"全部事件类型查询失败；首个错误：…"}`；`/api/alerts/webshell:1` 详情链路未变（假上游不实现 GetEvent → 502 `{error}`）。
- 503：未配 `CLOUDWALKER_*` → `{"error":"未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN"}`，带筛选参数也先判 503。
- 部分失败：`webshell` 上游 500 → 200、`partial=true`、`errors.webshell` 有文案、其余类型照常（`total=3`）。
- schema 符合性：每条 200 都按 `openapi.yaml` 校验 `alerts/total/totals/errors/partial` 必填与类型、`Alert.id` 匹配 `TypedAlertId`、`levelKey` 在枚举内、`triage` 出现时形状符合 `TriageCase`、`content-type` 为 JSON。

## 四、反向验证（证明断言会变红）

把 `checks.mjs` 复制到 `/tmp`，只把两条期望值改错（A1 的 `total 3→4`、A2f 的期望 id `webshell:3→webshell:2`），跑出来**恰好这两条红**、`EXIT=1`；原文件未动，重跑 48/48 绿。日志：`evidence/p003-t001-api/mutation-red.log`。

```
FAIL A1 … | A1 total（变异：期望值改错）: 期望 4 实测 3
FAIL A2f … | A2f ids（变异：期望值改错）: 期望 ["webshell:2"] 实测 ["webshell:3"]
# 用例 48 / 通过 46 / 失败 2   EXIT=1
```

## 五、文档冲突与记账（4 条，都带复现）

复现命令：`node evidence/p003-t001-api/probe-doc-conflicts.mjs`（输出见 `doc-conflicts.log`，`EXIT=0`）。

1. **major / doc-side（scope 外，已被代码审查记账）**：`docs/modules/http-api.md`、`docs/modules/event-gateway.md` 与实现脱节——`/api/alerts` 新增的 8 个参数、`truncated`、7 类新 400 文案（如「筛选事件类型无效」）在两页里都没有，行号引用也漂移。文档说：`http-api.md:231-238` 只列 `count`/`offset`；实测新参数生效且各有 400 文案。本卡 scope 未含这两页，需一张文档卡。
2. **minor / doc-side**：`openapi.yaml:172` 说 `total`「不带 level/q/from/to/triage_status/verdict 时为各类事件 total 之和」，`openapi.yaml:146` 又说「带 … 或 sort=level 时最多扫 500 条」。实测只带 `sort=level`（600 条库）→ `total=500 truncated=true`：按前者应为 600。两段口径冲突，`total` 描述缺 `sort=level` 情形。
3. **minor / doc-side**：200 响应里带 `query` / `note` 两个字段，`openapi.yaml` 的 200 schema 没声明。且研判筛选路径下 `query` 回显的是内部扫描页大小：`?triage_status=not_queued&count=5&offset=0` → `"query":{"count":50,"offset":0}`（客户端请求的是 5/0），`note` 文案还写着「按事件时间合并各类事件后分页」。与审查记账 `server.js:166` 同一事实的黑盒侧面。
4. **minor / doc-side**：`alerts[].triage` 只在研判队列装配时才出现；未配 `LLM_*`（队列未装配）时**整个字段缺席**（不是 `null`）。`Alert.required` 只有 `[id]`，但 `example` 展示的是 `triage:null`，看不出可缺席。实测（`doc-conflicts.log` 第 3 段）：`triage 字段在不在：false`。调用方照 example 取 `alert.triage.status` 会踩 undefined。

## 六、没覆盖 / 覆盖不到

- **真实牧云 `/rpc`**：本机没有凭据，上游是假实现（字段按 `docs/modules/event-gateway.md` §4/§6 造数，含 11 类方法名）。真实响应形状与现网是否一致不在本卡可验范围。
- **真实模型**：`LLM_*` 是假地址，所以 A3 里研判终态是 `failed`（`running→failed`），不是 `done`。triage 侧的**筛选逻辑**照样验到了（筛选按状态匹配、不清状态），但「`done` + 结论 `threat/uncertain/false_positive` 的 verdict 过滤」只验了 `review`/`threat` 两侧，真实结论值没走通一遍。
- **前端接线**：`web/**` 是 forbidden 面，未验；`web/src/alerts.js` 仍只发 `count/offset`，筛选参数没有前端消费者。
- **A3 的隔离方式**：研判队列一装配就会往 `<仓库上一级>/backend/.data/` 写运行态。为了不动共享目录，`triage-checks.mjs` 把同 commit 的树 `git archive` 到 `evidence/p003-t001-api/runtime/repo` 里跑，运行态落在证据目录内，退出时连副本一起删。A1/A2/A4/S/B/E 各组是在**本工作树真身**上跑的。

## 七、怎么复跑

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T001
node --test --test-reporter=tap *.test.js          # 107/106/1（唯一红 = 基线预存 maintenance symlink）
redocly lint openapi.yaml                          # valid, 21 warnings
node evidence/p003-t001-api/checks.mjs             # 48/48，EXIT=0
node evidence/p003-t001-api/triage-checks.mjs      # 13/13，EXIT=0（自建隔离副本，跑完删）
node evidence/p003-t001-api/probe-doc-conflicts.mjs # 五-2/3/4 三条文档冲突的现场
```

三个探针自己拉假上游、自己起 `node server.js`、自带超时，退出时回收子进程与临时目录；不碰产品代码，不 import 产品模块。
