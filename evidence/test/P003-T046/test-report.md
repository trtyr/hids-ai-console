# P003-T046 测试报告：AI 域可观测（三域模型调用事件 + 研判会话回放）

工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T046`（分支 `task/hids-ai-console-P003-T046`，HEAD `4d9c7b0`）
测试者：何东阳。口径只认文档：`docs/modules/http-api.md` §3.10 / §3.8.2 / §3.3、`docs/architecture.md` §3.6、
`docs/modules/investigation-agent.md` §3.11、`openapi.yaml`（`replayInvestigation` / `InvestigationReplay` / `InvestigationTurn`）。
没读实现正文；只按文档造请求断言响应。

## 1. 本轮我写了什么

`evidence/test/P003-T046/tester-http-acceptance.test.js`（6 条，集成/HTTP 级，348 行）。

- 不重复写者自测的断言：写者管模块内行为，我管**接口面**——真 HTTP + 真文件 sink + 真研判（替身牧云 / 替身模型）。
- schema 校验器**直接从 `openapi.yaml` 取**（`python3 -c "yaml.safe_load"` 转 JSON），不手抄字段表：
  只认 `$ref` / `type` / `enum` / `required` / `properties` / `additionalProperties:false` / `items` ——本卡六个 schema 用到的全部关键字。
- 校验器带**自检**：同一份合法响应体改出 5 种违约（多字段 / 缺必填 / 枚举越界 / 嵌套枚举越界 / 类型错），
  校验器必须各报一条错，否则这条用例红——防「断言永真」。

钉住的锚点：

| 用例 | 锚点 |
| --- | --- |
| A3 回放 200 体逐键过 schema | `InvestigationReplay` / `InvestigationTurn` 的必填、类型、枚举、无多出字段；`counts.turns == turns.length`；`verdicts` 只列有结论的轮 |
| A3 旧案卷回放 | schema 同校验；`turns: []` / `verdicts: []` / `counts.turns: 0`、`tool_calls` 按 `trace`（含 `tool_error` 变体） |
| A3 边界与错误码 | §3.10 失败口径表 11 个场景的状态码 + **完整正文**（`error` + `code`）：mode 大小写/表外值、mode 取错、无记录、序号 0/负数、类型段大写、非 ID、**百分号解码失败**（「告警 ID 编码无效」，写者未覆盖）、syslog 形态在 deep 下不认；POST 不带路由回 404 不 5xx |
| A3 分支顺序 | `/replay` 200 且是回放视图；`GET .../{alertId}` 仍回整份案卷；案卷里的 `turns` 过 `Investigation.turns` schema |
| A1/A2/A5 e2e | 真 `HIDS_LOG_FILE` 同级 sink（`useLogFile`）：研判 + 规则维护 + wiki 维护三域全跑 → `GET /api/logs?event=ai.model_call` 拉全（`files >= 1` 证明读盘）；域/角色对表、request/response 成对、`turn`/`attempt` 整数、request 无结局、response 四类结局；**回放前后事件条数一个不涨** |
| A5 解析失败 | `turns` 与日志原始行里搜不到回包标记与 `Unexpected token`；`note === 'parse_error'`；事件侧 `error` 是固定文案 |

## 2. 我亲手跑的（命令原文 + 退出码 + 摘要）

```
$ node --test --test-force-exit evidence/test/P003-T046/tester-http-acceptance.test.js
tests 6  pass 6  fail 0  duration_ms 426        # exit 0

$ node --test --test-force-exit evidence/test/P003-T046/*.test.js
tests 15  pass 15  fail 0                       # exit 0（写者 9 + 我 6）

$ node --test --test-force-exit *.test.js evidence/test/P003-T046/*.test.js
tests 243  pass 243  fail 0  duration_ms 832    # exit 0（含既有 228 条）

$ for f in log.js investigation-agent.js server.js wiki-workbench.js; do node --check $f; done
exit 0

$ python3 -c "import yaml;d=yaml.safe_load(open('openapi.yaml'));print(len(d['paths']))"
48；/api/agent/investigations/{alertId}/replay 的 operationId = replayInvestigation
```

行号锚点抽核（符号定位，不看正文）：`turnRecord` 在 `investigation-agent.js:101`、`replayInvestigation` 在 `:1161`、
既有单条研判 `startsWith` 分支在 `server.js:1313` —— 与 §3.10/§3.11 写的基准一致。

## 3. 两处新增守卫：变异验红（我自己打的，不转录）

复原凭据：`md5sum log.js investigation-agent.js`（变异前/复原后各一次，两次一致：
`2157e5a8… log.js`、`9722e1a4… investigation-agent.js`）。

**M4（invalid_json 的 error 固定文案）**——只做文本替换，在固定文案模板串前拼上 V8 原始 message（保留原 log 调用结构）：

```
✖ A1 结局四值：超时记 timeout、回包解不出 JSON 记 invalid_json、调用报错记 error（并原样抛出）
  actual:   `Unexpected token 'S', "SECRET_BOD"... is not valid JSON 模型回包无法解析为 JSON（SyntaxError）`
  expected: '模型回包无法解析为 JSON（SyntaxError）'
tests 6  pass 5  fail 1     # 恰红在守卫上；`SECRET_BODY_MARKER` 逐字进日志行
```

**M5（超时那次的 turns 快照）**——注释掉 `investigation-agent.js:815`：

```
✖ A5 超时重试在快照里留痕：turns 里 timeout 与 error 分得开，不再恒记 error
  actual: 1    expected: 2      # investigate 快照少一条，[[1,'timeout'],[2,'ok']] 立不住
tests 1  pass 0  fail 1
```

两次 `git checkout -- <文件>` 复原后复跑 15 pass / 243 pass，`git status --short` 只剩我这个新测试文件（未跟踪）。
另：第一次盲改 M4 时整行替换把 decode 分支的 log 调用连根拔掉（红是红了，但红在「少一条 response 事件」上，不是守卫断言上）——
当场上探针确认后重做成「保留结构、只改 error 值」，本条只记正确的这次。

## 4. 验收逐条

| id | 判定 | 我自己跑出来的证据 |
| --- | --- | --- |
| A1 三域每次调用落结构化事件（域/角色/轮次/方向/字符量/耗时/结局），密钥与正文不出现 | pass | 我 6 条里 2 条：schema 化字段断言 + 真文件 sink 三域 e2e；原始日志行里 `SUMMARY_BODY_MARKER` / `CLAIM_BODY_MARKER` / `TOOL_BODY_MARKER` / 判据正文逐字搜不到；M4 变异恰红证明红线有守卫 |
| A2 事件经既有查询接口可按域/角色/时间过滤 | pass（口径按 §3.8.2） | `GET /api/logs?event=ai.model_call&count=50` 真 HTTP 回 200、`files>=1`、三域齐全；文档写明字段级筛选在客户端（§3.8.2 本轮补的一条），未越界要求服务端参数 |
| A3 回放接口：逐轮摘要 / 工具序列 / 结论变化，读案卷不重放模型 | pass | 200 体逐键过 `InvestigationReplay` schema；旧案卷降级；边界与 11 个错误场景对表；回放前后 `ai.model_call` 条数不变（事件级证据，不只是假模型计数器） |
| A4 规则维护单发调用落事件并与 T041 会话互引 | pass | 我的 e2e 让 `RegoRuleMaintainer` 真跑一遍，`domain=rule` / `role=rule_maintainer` 事件进真日志文件并可由 `/api/logs` 拉出；写者用例的 session 互引我一并复跑（15 pass） |
| A5 三域齐全 + 字段口径（含超时快照） | pass | 三域事件同一次 e2e 拉全、request/response 成对；超时快照由写者用例钉住并经我 M5 变异复现；解析失败快照与日志行搜不到回包正文（我新增） |

## 5. findings

**B 类（系统行为与文档不符）：0 条。** 本轮贴的文档承诺逐条命中：
§3.10 的 200 形状、404/400 三条正文与 code、分支顺序；§3.6 的两行事件字段；§3.11 的 turns 口径与「挂掉也留快照」。
D 类（spec 与实测不一致）：0 条——回放 200 体、旧记录降级体都按 `openapi.yaml` 逐键过校验器，没有多出/缺失字段。

**残余风险**（不阻塞，均已由审查判词或写者未决登记）：

1. 快照干净 ≠ 案卷干净：解析失败时 `verdict.analysis` / `missing_evidence` 仍带「末次回包 50 字」与 `Unexpected token` 原文——
   这是 `investigation-agent.md:269-276` 明写的降级文案契约，不是本卡违约；§3.11 的「原文不进记录」只覆盖 `turns` 与事件 `error`，两者都实测干净。
   复核 catch / `review.concerns` 那条同族旧债见复审判词 minor（建议单独派卡）。
2. A2 的域/角色细分靠客户端筛字段；若 T045 查询面要加 `domain`/`role` 参数，得同步改 §3.8.2 与本卡事件字段口径。
3. 回放 `tool_calls` 的 `read_evidence` / `case_file` / `wiki`（`action`/`id`/`keyword`/`matches`）变体本轮没有真实数据触发，
   schema 校验器与写者用例只覆盖了 `tool` / `tool_error`；要全覆盖得造一次带判据检索与读回证据的研判。
4. 我的 schema 校验器只实现本卡六个 schema 用到的关键字（不含 `format` / `pattern` / `oneOf` 等）；`openapi.yaml` 以后加这些关键字时要扩校验器。
5. 回放只测了 GET 与文档化的 `mode`；`/replay/`（尾斜杠）、`?mode=deep&mode=triage` 这类未文档化输入只抽看了「不 5xx」，没写成契约。
