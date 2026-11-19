# P003-T042 测试报告（测试席 · 何东阳）

- 任务卡：P003-T042 模型分层——研判 / 独立复核 / 两个维护者 / 溯源白板 各用各的配置（后端）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T042`
- 被测提交：`f596141`（复审第 2 轮修复；基线 `9180bb8`）
- 审查判词：`verdicts/P003-T042-gc-backend-code-review-mwnvvijb.json`（复审 pass）
- 我的套件（两件，共 12 条，12 pass / 0 fail）：
  - `evidence/test/P003-T042/model-layers.tester.test.js`（10 条，进程内 HTTP 面）
  - `evidence/test/P003-T042/server-assembly.tester.test.js`（2 条，**shipped 装配**端到端：spawn 真进程；A2 启动装配 + A5 运行中换组）
- 写者套件：`evidence/test/P003-T042/model-layers.test.js`（11 条，我亲跑）
- 判据来源只有契约文本：`openapi.yaml`（`getConfig` 200 schema、`writeConfig` 请求/200、`ModelRoleResolved`）、
  `docs/modules/http-api.md` §2 装配表 / §3.5（`model.roles` 表、来源三态、机密口径）/ §3.6（十一可写键、坏值点组内键名、错误码）、
  `docs/modules/investigation-agent.md` §3.3（复核那一轮的输出契约）、`docs/modules/triage-pipeline.md` §3/§5/§5.5、
  `.env.example` 的 `LLM_REVIEW_*` / `LLM_LIGHT_*` 注释。没读实现内容、没按实现补断言。

## 结论

**PASS（整改轮）。** A1–A5 逐条在自己终端上重跑成立；写者套件与两套旧卡回归件 228 + 11 + 27 + 16 全绿，openapi 解析过。

**审计打回的那条已补**：上一版 A2 的「真研判」是测试自己 `new InvestigationAgent(..., models.review)` 喂的第 6 参，
只证明 agent 收到什么用什么，`server.js` 模块级装配线零覆盖。本轮新增 `server-assembly.tester.test.js`：
spawn 真进程入口 `node server.js`（入口本身就是零参 `createServer().listen(...)`，文档 `docs/architecture.md:57`、
`docs/modules/http-api.md` §2），只给环境变量（`LLM_*` → 假端点 A，`LLM_REVIEW_*` → 假端点 B）与 HTTP/UDP，
真 UDP syslog 进队列、真牧云 RPC/MCP 替身配一条可匹配事件、研判真跑一轮，断言复核那一轮**只**打 B（恰 1 次、
`model=review-model`、`Bearer review-key`、工具数组为空），A 上一次复核提示词都没有，且 `result.json` 的 `review` 段等于 B 的回复。
**变异自证**：副本里把 `server.js` 两处第 6 参 `models.review` 改成 `null` → 新那两条恰红（复核端点 0 次、复核提示词跑到研判端点）；
同一副本下**旧的 10 条 tester 套件与写者 11 条仍全绿**——正是审计描述的那个洞，现在被这两条用例堵上了。
顺带把「运行中生效」也端到端验了（`POST /api/config` 改复核组三键后，同一进程下一次研判的复核轮打新端点、旧端点 0 次）——
上一版 §五 残余风险 1 里「写配置后进程内换值没有端到端用例」这一项（复核角色）本轮关掉了。

新登记的 1 条 doc-side minor（`triage` 的 `source` 定义句字面角落，与复审席同一条，不挡推进）不变。

## 一、验收逐条

| 验收 | 我的用例 | 实测 |
| --- | --- | --- |
| A1 逐键回退矩阵 | `model-layers.tester:156`（真 HTTP，8 种组合 × 复核组/轻量组）、`:201`（`GET /api/config` 十种状态） | 复核组/轻量组各 8 种组合：地址、密钥（`Authorization: Bearer …`）、模型名（请求体 `model`）逐字段回退；不该去的上游 0 请求。summary 三态：全空/只主判/组三键全有/只设单键/设两键/主判全空但组自带值——`own`/`mixed`/`primary` 与逐字段实况一致；`source=mixed` 时模型名若组内没设就回退主判名 |
| A2 五实例互不相同 + 复核真走复核实例 | `model-layers.tester:245`、**`server-assembly.tester:214`（新增，shipped 装配）** | 进程内那 10 条：五个角色五个不同对象；每个角色 `complete()` 只落自己那组上游、带自己那组模型名。**新增那条走真进程**：零参 `createServer` 的进程入口 + `LLM_REVIEW_*`，`GET /api/config` 报 `roles.review={model:'review-model',source:'own'}`，真 syslog 触发一次真研判：复核端点恰 1 次（`model=review-model`、`Bearer review-key-abcdef`、`tools=[]`）、研判端点 0 次复核提示词、研判照常跑过（`done`）、`result.json` 的 `review.assessment` 来自复核端点 |
| A3 `model.roles` 三态 + 机密只回布尔 | `model-layers.tester:298`（两态 + 空串）、`:330`（写配置回显面） | 机密全配：`secrets` 五键恒在、`typeof==='boolean'`、全 true、正文不出现七个假密钥任一原文（含新两组 Key）；全空：全 false、`roles` 全 `null/primary`；空串密钥报 false。`POST /api/config` 写六键成功后正文不含新两组密钥原文，`secrets` 键集不变；错误正文也不回显坏值 |
| A4 `.env.example` 六键双向扫描 + openapi 解析 | `model-layers.tester:358`（文件面）、`:384`（接口/契约面） | 新六键各恰列一次且值为空；老五键在；键名无重复；头注「44 个键」= 实际 44 条；注释含 `LLM_REVIEW_`/`LLM_LIGHT_`/「逐键」/「研判只用上面主判三项」。openapi：`writeConfig` 可写表恰十一项（顺序同表）、`minProperties:1`、`additionalProperties:false`；`ModelRoleResolved.required=[model,source]`、`source enum=[primary,own,mixed]`。双向：`.env.example` 里 10 个 `LLM_*` 键逐个探针——9 个可写键全 200 且 `updated` 只报它，`LLM_TIMEOUT_MS` 400「配置项不可写」；反向十一可写键全在 `.env.example` |
| A5 十一可写键 + 坏值点组内键名 | `model-layers.tester:421`（逐个写 + 全写 + 落盘 + 重启）、`:459`（坏值矩阵）、`:500`（400/401/500）、**`server-assembly.tester:257`（运行中生效，shipped 装配）** | 11 键逐个写 200、`updated` 只报该键；一次逆序写 11 键 `updated` 顺序＝正文顺序；覆盖层落盘恰 11 键、新 store 重读生效、重启后 GET 与写成功响应 `config` 逐字节同值。坏值：四个 `*_BASE_URL` 各点各的组名、`CLOUDWALKER_API_TOKEN` 点自己、三组 API_KEY/MODEL 的空串/空白/非字符串点本组键名，新两组错误原话不含主判键名；反向「回退来的字段坏了才点 `LLM_BASE_URL`」实测成立（env 主判地址坏 + 只写 `LLM_REVIEW_MODEL` → 400 点 `LLM_BASE_URL`）。**运行中生效走真进程**：`POST /api/config` 写复核组三键 → 200、`GET /api/config` 立刻报 `roles.review={model:'swapped-review-model',source:'own'}` → 同一进程再跑一次真研判，复核轮恰打新端点一次（带新模型名与新密钥），旧端点请求数不增、研判端点 0 次复核提示词 |

### 边界与错误码（一条一条请求出来的）

- **400**：正文非 JSON / `null` / `[]` / `{}` / 表外键（`HIDS_PORT`）/ 空串 / 空白串 / 数字 / 对象 / 数组 / URL 前缀错 / Token < 6 位——全部 JSON 正文 `{error, code:"caller_error"}`，错误原话点键名不回显值。
- **401**：`GET` 与 `POST /api/config` 在配了口令后都拦；`WWW-Authenticate: Basic realm="HIDS AI Console", charset="UTF-8"`、`text/plain; charset=utf-8`、`no-store`、`nosniff`、正文「需要登录后访问」。
- **500**：数据根不可写 → `internal_error`「服务器内部错误」，正文不含 `EACCES/EPERM/值原文`，生效值与覆盖层都不变。
- **schema 符合性**：所有 200 正文（十种 env 状态 + 写成功快照 + 重启后 GET）逐条过 `openapi.yaml getConfig` schema（含 `$ref` 展开到 `ModelRoleResolved`），`Content-Type` / `Cache-Control: no-store` 同断。
- **越界 / 超长**：正文超 8KB 的 400「请求正文过大」由 T029 tester 套件覆盖（我亲跑 16/16 绿），本卡新键不引入长度上界（openapi 未声明 `maxLength`）。

## 二、回归（先跑既有全套，再核新用例，全部串行亲跑）

```
$ timeout 300 node --test --test-force-exit *.test.js                                        → tests 228  pass 228  fail 0  exit=0  (串行连跑 11 次同结果)
$ timeout 120 node --test --test-force-exit evidence/test/P003-T042/model-layers.test.js      → tests 11   pass 11   fail 0  exit=0
$ timeout 120 node --test --test-force-exit evidence/test/P003-T042/model-layers.tester.test.js → tests 10  pass 10   fail 0  exit=0
$ timeout 150 node --test --test-force-exit evidence/test/P003-T042/server-assembly.tester.test.js → tests 2  pass 2  fail 0  exit=0  (串行连跑 5 次同结果，约 270+360ms)
$ timeout 120 node --test --test-force-exit evidence/test/P003-T025/config-check.test.js \
    evidence/test/P003-T025/config-contract.tester.test.js                                   → tests 27   pass 27   fail 0  exit=0
$ timeout 120 node --test --test-force-exit evidence/test/P003-T029/config-write.test.js \
    evidence/test/P003-T029/config-write.tester.test.js                                      → tests 16   pass 16   fail 0  exit=0
$ timeout 60 python3 -c "import yaml; yaml.safe_load(open('openapi.yaml')); print('YAML_OK')" → YAML_OK  exit=0
```

**一次未归因的红**（如实记）：根套件本轮首跑时，我同时另开了一条命令并发跑 T042 的三支证据件，
那一次 `pass 227 / fail 1`，失败用例名没抓到；随后**串行**连跑 11 次全部 228/0。
判 C 类（我自己并发压出来的环境抖动），不是本卡改动的行为差异——写者套件与两支证据件那一次都是全绿。

## 三、反向验证（变异恰红，亲手复现，副本里做）

我这条线不改产品代码，全部变异在**一次性副本** `/tmp/t042-mut`（`tar --exclude=.git` 拷贝）里做；
目标树 `git diff` 全程只有 `.pi-child-claim.json` 一条会话账本改动（见 §六）。

```
# 变异 1（行为）：复核实例被串成研判模型（副本尾部追加包装器，不改原行）
$ cd /tmp/t042-mut && node --test --test-force-exit evidence/test/P003-T042/model-layers.tester.test.js
✖ A1 逐键回退矩阵…（actual 'main-model' vs expected 'review-model'）
✖ A2 五角色五个实例、各打各的上游…
ℹ tests 10  pass 8  fail 2   EXIT=1
$ 还原（cp）后同一命令 → ℹ tests 10  pass 10  fail 0  EXIT=0

# 变异 2（行为）：summary 把复核来源永远报成 own
✖ A1 model.roles 三态…（AssertionError: 全空：roles.review）
✖ A3 机密只回布尔…（secrets 断言）
ℹ tests 10  pass 8  fail 2   EXIT=1
$ 还原 → 10/10 绿  EXIT=0

# 变异 3（文档锚点）：.env.example 删掉 LLM_LIGHT_MODEL= 一行
✖ A4 .env.example 六键双向扫描…  ✖ A4 openapi 契约…（反向扫描找不到可写键）
ℹ tests 10  pass 8  fail 2   EXIT=1
$ 还原 → 10/10 绿

# 变异 4（契约锚点）：openapi ModelRoleResolved.source 的 enum 删掉 mixed
$ sed -i 's/enum: \[primary, own, mixed\]/enum: [primary, own]/' openapi.yaml
✖ A1 model.roles 三态与逐字段实况一致（HTTP GET /api/config）
✖ A4 openapi 契约：writeConfig 可写表十一项、…、ModelRoleResolved 约束与 API 对表
ℹ tests 10  pass 8  fail 2   EXIT=1          ← 本轮实测重取：8 pass / 2 fail（旧报告写的 9/1 是错的，已按实测改）
$ 同一变异下新 e2e（不读 openapi，应无关）→ tests 2  pass 2  fail 0
$ 还原 → 10/10 绿

# 变异 5（本轮新增，装配线）：server.js 两处第 6 参 models.review → null
$ cd /tmp/t042-mut && sed -i 's/models\.review/null/g' server.js && grep -c models.review server.js → 0
$ node --test --test-force-exit evidence/test/P003-T042/server-assembly.tester.test.js
✖ A2（shipped 装配）spawn 真 server.js…
  AssertionError: 独立复核应恰问复核组上游一次，实测 0 次（复核端点总请求 0）
  子进程 trace：syslog.received → triage.done（研判跑完，只是复核那轮打去了研判端点）
✖ A5（shipped 装配）POST /api/config 改复核组 → …
ℹ tests 2   pass 0   fail 2   EXIT=1
$ 同一变异下跑旧的 10 条 → ℹ tests 10  pass 10  fail 0  EXIT=0     ← 审计说「改 null 全套照样绿」在这里被复现
$ 同一变异下跑写者 11 条 → ℹ tests 11  pass 11  fail 0  EXIT=0
$ 还原（cp server.js.orig）→ 两件合跑 12/12 绿  EXIT=0；grep -c models.review → 2
```

## 四、发现台账

### F1（open，doc-side minor，与复审席 minor 同一条）`source` 三态定义句对 `triage` 有个字面角落

- 文档出处：`docs/modules/http-api.md:266`（「`primary` = 这一组三个键全空、逐键回退主判」）
- 文档说：`primary` 成立的条件是「这一组三个键全空」
- 实测：`triage` 的组就是主判组，主判只设一部分（如只设 `LLM_MODEL`）时 `triage` 报 `source:"primary"`，而此刻主判组三个键**并非全空**
- 复现：`node --input-type=module -e "import { configSummary } from './server.js'; console.log(JSON.stringify(configSummary({LLM_MODEL:'only-model'}).model.roles.triage))"` → `{"model":"only-model","source":"primary"}`
- 严重度：minor（§3.5「典型两态」示例里 `triage` 恒报 `primary`、实现行为与直觉一致；只有定义句的字面意思与 triage 不合，无 pinned 行为被它误述）
- 建议：在 §3.5 source 三态句后补半句「`triage` 的组就是主判组，`source` 恒为 `primary`」，或把 `primary` 定义改成「没有可回退的独立组（`triage` 即此态）」。不挡代码。

本轮无新增 finding（shipped 装配用例跑通，未发现行为与文档不符）。

## 五、残余风险（写清楚，不当成通过）

1. **「运行中换值」只端到端验了复核角色**：`server-assembly.tester:257` 证明写 `LLM_REVIEW_*` 后同一进程下一次研判的复核轮打新端点。文档 §3.6 里同一段还承诺 `gateway.rpc`、`agentToolbox`（含 MCP 重新 initialize）与其余四个角色实例原地换值——那几项仍只有写者单测覆盖（我亲跑写者 11 条绿），黑盒面没验。要补的话是同一套替身下改 `CLOUDWALKER_*` / 主判三项再触发一次研判；本轮没做，不算验过。
2. **T025 tester 的 schema 校验器不展开 `$ref`**：本卡给 `getConfig` 引入 `ModelRoleResolved` `$ref` 后，那个文件对 `roles` 的校验只剩「五个角色键在」（`required` 有断，形状没断）。本轮新套件已用 `$ref` 展开补齐；T025 那个校验器建议后续顺手补齐，不影响本卡。
3. **`.env.example` 与「代码真读的键」的代码级反向扫描仍是写者单测的活**：黑盒面只能扫到「文件 ↔ 可写表 ↔ 实际接受」三面对齐（本轮已扫），「文件里没有代码没读的键」需要看代码，不在我的判定面。
4. **shipped 装配用例依赖假牧云的匹配规则**：事件匹配三条（事件 ID / `host_ip` / `host_id`）按 `docs/modules/triage-pipeline.md:672` 的文档口径喂进去；若将来匹配规则收紧（多比一个字段），这条用例会变成「未匹配」分支而红——那是文档与实现同步的问题，不是本卡回归，红的时候先对文档。
5. `git status` 里 `.pi-child-claim.json` 的改动在起活第一条命令即见，是会话账本不是代码；我全程没碰。

## 六、现场

```
$ git log -1 --oneline      → f596141 fix(model,docs): P003-T042 复审——契约按实现改（主判不齐时自带模型名照报）、锚点 857、recon 记 MODEL_GROUP_KEYS 实名
$ git status --porcelain    → " M .pi-child-claim.json"（起活前既有）
                              "?? evidence/test/P003-T042/model-layers.tester.test.js"（上一轮我写的）
                              "?? evidence/test/P003-T042/server-assembly.tester.test.js"（本轮新增）
                              "?? evidence/test/P003-T042/test-report.md"（本文件）
$ git diff --stat           → .pi-child-claim.json | 2 +-   （产品代码 diff 为空；openapi/docs/model-client/server/config-store 一字未动）
$ pgrep -af "node server.js" | 逐个 readlink /proc/<pid>/cwd → 只有别的卡（main / P003-T034）的进程，本树 0 个
                            （新用例 spawn 的子进程在 t.after 里 SIGKILL 收尸，跑完 pgrep 复查 0 个；T025 真进程探针自带兜底）
$ rm -rf /tmp/t042-mut /tmp/t042-probe* /tmp/server.js.orig /tmp/openapi.orig → 变异副本与探针清掉
```

没改产品代码。变异全在 `/tmp/t042-mut` 副本里做、做完还原并复绿；目标树只多出我的两件套件与本报告。
