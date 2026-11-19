# P003-T025 测试报告（测试席 · 何东阳）— 第 2 轮刷新

- 任务卡：P003-T025 启动时核配置，能看生效值但不回显密钥（后端）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T025`，分支 `task/hids-ai-console-P003-T025`
- 被测提交：`a140378`（复审第 2 轮修复，diff `03eb0f4..a140378`）；起活基线 `ae9c0de`
- 审查判词：`verdicts/P003-T025-gc-backend-code-review-mwnc87m8.json`（复审第 2 轮 pass）
- 我的套件：`evidence/test/P003-T025/config-contract.tester.test.js`（13 条，13 pass / 0 fail，本轮 +1 条「两类问题同时出现」）
- 写者套件：`evidence/test/P003-T025/config-check.test.js`（14 条，我亲跑）
- 判据来源只有契约文本：`openapi.yaml`（`info.description` 闸门段、`getConfig` 的 200 schema 与 401）、
  `docs/modules/http-api.md`（§1 响应形状 / §2 进程入口 / §3.1 路由表 / §3.2 固定响应 / §3.5 生效配置 / §4 Basic 认证 / §10 自检口令）、
  `docs/architecture.md`（§3.5 缺配置时会怎样 / §3.6 事件表 / §10.1 配置项速查）。没读实现、没按实现补断言。

## 结论

**PASS。** 上一轮的 F1（`HIDS_TRIAGE_INPUT_MODE=pirate` 原样回显、静默走 poll）**已关闭**：
真进程现在拒启动（stderr 点名键与坏值、`EXIT=1`、不监听、一条 `server.start_failed{missing:[],invalid:[{key,value,allowed}]}`），
进程内 `createServer()` 报缺省 `syslog`，`/api/config` 恒在 openapi enum 内。A1–A4 逐条在自己终端上重验，
两套件 27/27 绿（1340ms）；五机密含两个 admin 令牌两态（配/缺）正文原文都不出现；空串必填按缺处理。
新增 1 条断言不永真的反向证据（旧提交 `03eb0f4` 上同一套件恰红 3 条，新提交 13/13 绿）。
新登记 1 条 doc-side minor（文档行号锚点过期，见 F2），不影响 A1–A4，不挡推进。

## 一、验收逐条

| 验收 | 我的用例 | 实测 |
| --- | --- | --- |
| A1 必填项缺了就拒绝启动，并列出缺哪几项 | `:190`（五项逐个缺）、`:213`（五项全缺） | 六次真进程：`code=1`、stderr 恰为「缺少必填配置：<那一条>」（不连带点名其余四项）、stdout 无 `server.started`、恰一条 `server.start_failed`（`what:"config"`、`level:"error"`、`missing` 只含缺的那项）、端口 connect 失败（不监听）。全缺：stderr 顿号分隔五项、`missing` 五项、`code=1` |
| A1 必填给空串＝缺（.env.example 的占位就是空串） | `:402` | `LLM_MODEL=''` → `code=1`、`stderr.trim()==='缺少必填配置：LLM_MODEL'`、`missing:["LLM_MODEL"]`、`invalid:[]`、不监听、无 `server.started` |
| A1 取值非法拒启动（本轮新增的正式断言，旧 todo 已废） | `:381` | `HIDS_TRIAGE_INPUT_MODE=pirate` → `code=1`、stderr「配置值无效：HIDS_TRIAGE_INPUT_MODE=pirate（只能是 syslog 或 poll）」、不含「缺少必填配置」、不监听、`start_failed` 恰一条：`missing:[]`、`invalid:[{key:"HIDS_TRIAGE_INPUT_MODE",value:"pirate",allowed:["syslog","poll"]}]` |
| A1 两类问题同时出现（本轮我加的，`http-api.md` §2 第 3 条：两行都写、一个出口） | `:436` | 缺 `LLM_MODEL` + `pirate`：`code=1`、stderr 两行（缺必填 + 配置值无效）、**一条** `start_failed`（`missing:["LLM_MODEL"]` 且 `invalid:[{…pirate…}]`）、`error` 是两行拼起来的原话、不监听 |
| A2 一处能看非机密生效值 | `:224`（真进程未配口令）、`:257`（真进程配口令）、`:296`（poll）、`:305`（进程内全缺）、`:326`（进程内半配） | 五项齐真进程：`host=127.0.0.1`、`port=<HIDS_PORT 且就是真监听端口>`、`triage_input_mode=syslog`（缺省）、`cloudwalker.configured=true`、`model.configured=true`、`model.name=fake-model`、`auth.basic_auth_enabled=false`、`missing_required=[]`；`HIDS_TRIAGE_INPUT_MODE=poll` → `poll`；进程内全缺 → 200 + `missing_required` 五项 + `model.name=null` + 缺省 `127.0.0.1/8080/syslog`；进程内只给 `CLOUDWALKER_URL` → `cloudwalker.configured=false` |
| A2 `/api/config` 只报生效值（F1 复验） | `:381`（真进程拒启动）＋ 手工探针 | 真进程 pirate 不监听；进程内 `createServer()`（`env -i … HIDS_TRIAGE_INPUT_MODE=pirate node --input-type=module -e 'import {createServer} from "./server.js"…'`）→ `status 200 triage_input_mode="syslog"`，正文恒在 enum 内 |
| A3 机密只报告有或没有，正文不出现五机密原文 | `:224`、`:257`、`:305`、`:342` | `secrets` 五键恒在且 `typeof==='boolean'`；配三项 → 三项 true、两 admin 令牌 false；全配 → 五项 true（真进程实测）；全缺 → 五项 false；空串算「没有」；两态正文 `includes(五个假值原文)===false`；顶层八键之外没有第二处出现机密键名 |
| A4 `.env.example` 与代码读取的键一致，键名没改 | 写者同名套件 A4 条（`:292`，我亲跑）＋ 独立口径核对 | `grep -cE '^[A-Z0-9_]+=' .env.example` → **32**；基线 `ae9c0de` 的 14 个老键名 `comm -23` 差集为空；五项必填在注释第 3/8/11 行点名；`git diff 03eb0f4..a140378 -- .env.example` 只有 `:18` 注释一行 |
| 契约同步（schema 符合性） | `:72`（`assertConfigSchema`，schema 从 `openapi.yaml` 现取现解析，用 python3 yaml） | 每条 200 断言都过同一份 schema：`required` 八键齐、`type`（含 `[string,"null"]` 联合）、`enum`（`triage_input_mode`、`missing_required` 项）、`items`、`const` 全对；`Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` |

### 边界与错误码（自己一条一条请求出来的）

- **必填缺失**：五项逐个缺 × 真进程（`code=1`、stderr 只列缺项、不监听）＋ 五项全缺 ＋ 空串。
- **非法枚举**：`pirate` → 拒启动；`poll` / `syslog` / 未设 / 空串 → 正常生效并原样报。
- **类型/形状错**（`config-contract.tester.test.js:362`）：`CLOUDWALKER_API_TOKEN=abc`（3 位）→ `code=1`，stderr 是装配处那条「CLOUDWALKER_API_TOKEN 无效」，**不含**「缺少必填配置」；`CLOUDWALKER_URL=ftp://127.0.0.1` → `code=1`，stderr「CLOUDWALKER_URL 必须是 HTTP(S) 地址」，同样不含必填文案。与 architecture §3.5、http-api §2「值的形状仍由装配处抛」一致。
- **空数组**：正常进程 `missing_required` 恒 `[]`（真进程三态都验）；`invalid` 在只有缺项时是 `[]`。
- **方法/路径**（`:417`）：`POST /api/config` → 404 `{"error":"接口不存在","code":"caller_error"}`；`GET /api/config/` → 同形状 404；`GET /api/config?debug=1` → 200。
- **401 形状**（`:257`）：无凭据 / 错口令 → 401，`WWW-Authenticate: Basic realm="HIDS AI Console", charset="UTF-8"`、`text/plain; charset=utf-8`、`no-store`、`nosniff`、正文「需要登录后访问」；正确凭据 → 200。
- **不适用**：`/api/config` 无 5xx 分支（http-api §3.5「缺件也不回 503：永远 200」），已按文档口径断言 200。

## 二、回归（先跑既有全套，再核新用例）

```
$ node --test *.test.js                                                → tests 198  pass 197  fail 1  exit=1
$ node --test evidence/*/*.test.js evidence/*/*/*.test.js              → tests 144  pass 143  fail 0  todo 1  exit=0
$ node --test evidence/test/P003-T025/config-check.test.js \
  evidence/test/P003-T025/config-contract.tester.test.js               → tests 27   pass 27   fail 0  exit=0  (1340ms)
$ 重复三次跑上面这条                                                     → 26/26、26/26、26/26（加新条后 27/27），无 flake
```

- 唯一红 `maintenance-startup.test.js` 与本卡无关，基线同红：`sha256sum maintenance-startup.test.js` → `04168e44…d0467e6`；
  `git show ae9c0de:maintenance-startup.test.js | sha256sum` → 同值；`git ls-tree -r --name-only ae9c0de | grep -c '^backend/'` → 0；
  `git diff --name-only 03eb0f4..a140378 | grep -c maintenance` → 0。
- evidence 全量那 1 个 todo 是 **P003-T013 遗留**（`evidence/test/P003-T013/acceptance.test.js:648`，`who` 超长口径待定），不是本卡。
- **裸 `node --test` 仍会挂**：`evidence/test/P003-T015/stub-api.mjs` 是常驻 stub（`timeout 20 node --test …` → `RC=124`）。本报告一律用显式路径跑。

## 三、反向验证（断言会不会红，黑盒范围内怎么做）

我这条线**不改产品代码、不读实现内容**，所以不在目标树上做变异；反向证据用**旧提交上的真红灯**：
`git archive 03eb0f4 | tar -x -C /tmp/t025-old`（一次性拷贝），把**当前**套件原样放进去跑：

```
$ node --test evidence/test/P003-T025/config-contract.tester.test.js   （/tmp/t025-old，server.js = 03eb0f4）
✖ A1 真进程：HIDS_TRIAGE_INPUT_MODE 取值非法 → 拒启动…（10006ms，旧进程根本不肯退）
✖ A1 真进程：必填给空串等于缺…  AssertionError: 空串不算取值非法（走缺省），只算缺：actual undefined
✖ A1 真进程：缺必填与取值非法同时出现…  AssertionError: stderr 要点名坏值与允许取值：缺少必填配置：LLM_MODEL
ℹ tests 13  pass 10  fail 3  EXIT=1
```

同一份文件在新提交 `a140378` 上 13/13 绿 → 这三条不是永真断言，旧行为确实被判红。拷贝用完即删，目标树 `git diff server.js` 为空。

写者这轮动过我的套件三处（`SECRET_VALUES` 3→5、todo 转正式断言、加空串真进程条），我逐条核过：
都是加严（假值集合更大、todo 变成硬断言、多一条真进程用例），没有删断言、没有放宽取值，与审查席结论一致。

## 四、发现台账

### F1（closed）`GET /api/config` 原样回显非法 `HIDS_TRIAGE_INPUT_MODE`

- 上一轮我记 minor、test-review 打回判 major + route_coding，群主定「拒启动」。本轮复验**已修成立**：
  - 复现：`env -i PATH="$PATH" HIDS_HOST=127.0.0.1 HIDS_PORT=<空闲> CLOUDWALKER_URL=http://127.0.0.1:1 CLOUDWALKER_API_TOKEN=fake-token-123456 LLM_BASE_URL=http://127.0.0.1:1/v1 LLM_API_KEY=fake-key-abcdef LLM_MODEL=fake-model HIDS_TRIAGE_INPUT_MODE=pirate node server.js`
  - 实测：`EXIT=1`；stderr `配置值无效：HIDS_TRIAGE_INPUT_MODE=pirate（只能是 syslog 或 poll）`；stdout 一条 `server.start_failed`（`what:"config"`、`missing:[]`、`invalid:[{key,value,allowed}]`）；端口 connect 失败
  - 进程内（`createServer`）：`200`，`triage_input_mode="syslog"`（缺省），恒在 enum
  - 关闭。

### F2（open，doc-side minor）http-api §3.5 与头注的行号锚点过期，同一函数在本页有两套行号

- 文档出处：`docs/modules/http-api.md:7`（行号基准写「按 1021 行的 `server.js` 标号」）、`:224`（「`configSummary()`（`server.js:987`）」）、`:228`（「八键恒在（`server.js:987-998`）」）
- 文档说：这几处指向 `configSummary` 的定义与正文生成区
- 实测：`wc -l server.js` → **1047**（`a140378`）；`grep -n "^export function configSummary" server.js` → **1009**；同一文档的 `:56` 与 `:63`、`architecture.md:76` 已写 1009。即 §3.5 的 987/987-998 是第 2 轮插代码（`server.js:983-1006`）之前的位置，头注「1021 行」是上一轮的基线
- 复现：`wc -l server.js; grep -n "^export function configSummary" server.js; sed -n '224p;228p' docs/modules/http-api.md`
- 严重度：minor（只影响照着文档找锚点的人；契约文字与实际行为全对，A1–A4 不受影响）
- 建议：`:224` 的 `server.js:987` → `1009`，`:228` 的 `987-998` → `1009-1022`；`:7` 的「1021 行」改「1047 行」（或把这页 P003-T025 的锚点统一改挂当前提交）。顺带 `coding-reports/P003-T025.md:47` 的 `server.js:987` 同源过期。
- 状态：open（document 侧，不挡代码）

## 五、残余风险（写清楚，不当成通过）

1. **值形状一律不校验**：`HIDS_PORT=abc` 时闸门放行、`listen(NaN)` 抛 `RangeError [ERR_SOCKET_BAD_PORT]` 栈退出（`code=1`）。退出码契约仍成立；文档没写这条边界，属「文档没覆盖」，不立 finding。
2. **`/api/config` 报的是环境变量口径**：`configSummary` 读 `process.env`，模块级 host/port 是加载时快照。真进程 env 不变时两者恒等；进程内 `createServer()` 按文档缺省报 `8080` 而实际监听随机端口——§3.5「典型两态」就是这么写的，属已知边界。
3. **裸 `npm test` 跑不完**（`evidence/test/P003-T015/stub-api.mjs` 常驻，RC=124）：本卡验证不依赖它，建议另开卡收窄 `package.json` 的 `test`。
4. **`maintenance-startup.test.js` 基线红**：fixture 找 `<上级>/current/backend/maintenance-server.js`，仓里没有 `backend/` 前缀；与基线逐字节同文件。
5. **`web/test/**` 基线红**（`Cannot find package 'jsdom'`）：本工作树没装依赖，`web/**` 属禁改区，我没碰。

## 六、现场

```
$ git log -1 --oneline   → a140378 fix(config): P003-T025 取值非法拒启动，/api/config 只报生效值（复审第 2 轮）
$ git status --porcelain → " M evidence/test/P003-T025/config-contract.tester.test.js"   ← 本轮我加的两类问题条
                           "?? evidence/test/P003-T025/test-report.md"                    ← 本文件
（收口补提交：上面两个文件同批进分支，见 `git log --oneline -- evidence/test/P003-T025/`；提交前重跑 27/27 绿 exit=0）
$ pgrep -af "node server.js" 过滤 cwd 本树 → 空（探针与用例真进程全回收；本轮我漏掉的一个已被杀）
```

没改产品代码；`server.js` / openapi / docs 的 diff 全是写者的。我只动了我的套件（+1 条）与本报告。
