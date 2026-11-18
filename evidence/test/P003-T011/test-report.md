# P003-T011 测试报告 · Rego 规则库与求值

- 任务卡：P003-T011（M3，后端）
- 席位：gc-backend-tester（何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T011`
- 分支：`task/hids-ai-console-P003-T011`，实现 `3edcd51`，复审修正 `16df0a5`（只动两份文档）
- 被测面：三条只读 HTTP 接口（真 HTTP、真 `createServer`、真 `rules/` 目录）
- 判据来源：`openapi.yaml`（`/api/rules`、`/api/rules/{id}`、`/api/rules/evaluate`；schema `RegoRuleSummary`/`RegoRule`/`RegoRuleList`/`RegoRuleMatch`/`RegoEvaluation`/`AlertFact`；response `RuleLibraryError`/`BadRequest`/`NotFound`/`Error`）、`docs/modules/http-api.md:276-288`（`readJSON` 缺省正文上限 8192、缺省量字符串长度）、任务卡 A1/A2/A3。`rules/*.rego` 作为**规则数据**读入（不是实现文件）。
- 未读任何实现文件内容：`rule-store.js` / `server.js` 只做符号与路由路径的结构查询；本报告的行为结论全部来自 HTTP 响应与规则数据。

**结论：PASS（A1/A2/A3 全部成立）**，附 3 条 minor（1 条复审遗留未修、2 条文档口径），不阻塞本卡。

---

## 1 怎么跑的（全部在本文工作树里亲跑）

```
$ node --version
v26.13.0
$ node --test --test-reporter=tap evidence/test/P003-T011/rego-rules.e2e.test.js
# tests 23 / # pass 23 / # fail 0        exit 0     （连跑 3 次：23/23、23/23、23/23）
$ node --test --test-reporter=tap *.test.js
not ok 80 - maintenance CLI starts when the deployment current path is a symlink
# tests 161 / # pass 160 / # fail 1      exit 1
$ python3 -c "import yaml; yaml.safe_load(open('openapi.yaml'))"
openapi parse ok                        exit 0
```

后端全套唯一失败项与起活基线同一条（`maintenance-startup`，`docs/_meta/gaps.md` 记录的环境性失败），**不计本卡**；本卡新增面 23/23 全绿。

测试文件：`evidence/test/P003-T011/rego-rules.e2e.test.js`（23 条，全是集成/e2e，无单测）。只用两个注入点：`createServer(...第15个参数 ruleStore)` 与 `new RuleStore(<临时目录>)`，都是交卷报告/recon 里写明的契约；没有 stub 掉被测行为。

## 2 A1 一规则一 `.rego`、`# name:` 显示名、按 id 逐字读回原文

| 断言 | 结果 |
| --- | --- |
| `rules/` 下 3 份 `.rego` ↔ 接口列 3 条，`count`/长度/文件数三者相等，`file` 不重复、是 `rules/` 下真实文件名 | 23/23 绿，逐项在用例里 |
| 每条规则 `id` = `package hids.rules.<id>` 末段；`name` = `# name:` 行；`description` = `# description:` 行，没写是 `null` | 绿（含 `description:null` 用例） |
| `GET /api/rules/{id}` 的 `rego` 与 `rules/<file>` **逐字相等**（含注释、空行、结尾换行） | 绿（`assert.equal(rule.rego, readFileSync(...))`） |
| `RegoRuleList`/`RegoRuleSummary`/`RegoRule` 的键集合 = schema（`additionalProperties:false`），列表不带 `rego` | 绿 |
| 未知 id → 404；大写/数字开头/横线/空格/空 id/编码斜杠/`../server`/点/双斜杠/非 ASCII → 400；非法百分号编码 → 400；超长但合法 id → 404 | 绿（每个都断言 `{error:string}`） |
| 连续 3 次 + 20 并发列表逐字一致；每个 id 读原文 200 | 绿 |
| 空规则库：列表 `{count:0,rules:[]}`、读 id 404 | 绿 |
| 非 `.rego` 文件与子目录被忽略、`.bak` 垃圾不当规则 | 绿 |

## 3 A2 七字段都能被取值、没写的字段不限制、缺字段按 Rego undefined

用语料驱动的**变异矩阵**（不写死实现行为）：从规则原文提取 `input.<字段>`，对每条规则逐个字段做「删除 / 置空 / 改成错误值」，再看求值命中集合。

| 断言 | 结果 |
| --- | --- |
| 三条交付规则引用的字段并集恰为 `host,peer,command,user,path,type,source_ip` 七字段 | 绿 |
| 每条规则引用的每个字段：删掉 → 不命中；置空串 → 不命中；`==`/`contains`/`startswith`/`endswith` 的字段改错值 → 不命中；`!=` 的字段改非空值 → 仍命中 | 绿（含 `peer != ""`、`source_ip != ""` 两类） |
| 规则没写的字段塞垃圾（对象、300 字长串）→ 命中集合不变 | 绿 |
| 缺字段按 undefined：`peer` 缺失时 `input.peer != ""` 不成立 → 不命中 | 绿 |
| `not` 语义（openapi 明文承诺「缺字段也算通过」）：`not input.user == "root"` 在 user 缺失时命中、user 为 root 时不命中 | 绿（自定义规则库，真 HTTP） |
| 严格相等：`type:"1"` 与 `type:1` 结果不同；`type:"HONEYPOT"` 不命中；数字 `command` 不触发子串判定、不 5xx | 绿 |
| 多余键（`additionalProperties:true`）被忽略；`__proto__` 键不污染 `Object.prototype`；求值不改写规则文件 | 绿 |

## 4 A3 命中返回规则名与 Rego 正文、无命中明确空

| 断言 | 结果 |
| --- | --- |
| 命中项键集合 = `{id,name,rego}`（`additionalProperties:false`）；`rego` 逐字等于文件全文；`name` 与列表一致；`count === matched.length` | 绿 |
| 每种事实只命中该命中的规则（基准事实 → `matched` 恰好 1 条且 id 正确） | 绿 |
| 无命中：`{}`、空串字段、类型不匹配、路径前缀不匹配、命令不含 `ssh` → 一律 200 + `{count:0,matched:[]}`（不是 `null`、不是 404） | 绿 |
| 空规则库求值 → `{count:0,matched:[]}` | 绿 |
| 多命中可重复（同一事实两次求值结果逐字相同）；`description` 缺省为 `null`；排序按 id 不按文件名 | 绿（自定义库 `z_alpha.rego`→`alpha`） |

## 5 边界与错误码（每条 4xx/5xx 都触发并断言响应体形状）

| 用例 | 实测 |
| --- | --- |
| 正文 `[]` / `null` / `"x"` / `123` / `true` | 400 `{"error":"告警事实必须是 JSON 对象"}` |
| 正文 `{` / 空 / `not-json` | 400 `{"error":"请求正文不是 JSON"}` |
| 正文恰 8192 字符 / 8193 字符（平台缺省上限，`http-api.md:276-288`） | 200 / 400 `{"error":"请求正文过大"}` |
| 方法不匹配：`POST /api/rules`、`DELETE /api/rules`、`GET /api/rules/evaluate`、`DELETE|PUT /api/rules/{id}` | 一律 404「接口不存在」 |
| 502：缺 `# name:` / `import` / `else` / `some` / `in` / `>=` / `count()` / 多 `match` 体 / 垃圾文件 / 缺 `package` / 大写 id / 规则目录不存在 | 502，列表/读/求值三处都失败，报错带 `rules/<文件>:<行>`（目录不存在除外，报 `规则目录不存在：<路径>`） |
| 502：两条文件同 `package`（id 重复） | 502 `规则库读取失败：规则 id 重复：beta（a.rego 与 b.rego）` |
| 只读性：连续求值 + 列表后规则文件内容不变 | 绿 |

## 6 断言会红（变异验红，亲手复现）

把 `git archive HEAD` 解到 `/tmp/p003t011-mut`（同 HEAD 树 + 本测试文件）做变异，跑同一套：

```
基线（未变异）                # tests 23 / pass 23 / fail 0
M1 删掉 honeypot 的 # name:   # tests 23 / pass 7  / fail 16   （列表/读/幂等/A2/A3 全断）
M2 user == "root" 改 "admin"  # tests 23 / pass 18 / fail 5    （A2 取值矩阵、A3 命中形状）
```

变异删除后 `/tmp` 副本已清理；**没有改本工作树的任何产品文件**（`git status --short` 里本卡范围内无改动，只有建树时既有的 13 个 P003-T007 PNG）。

## 7 findings（全部 minor，不阻塞）

| # | 严重度 | 文档出处 / 文档说 | 实测 | 复现 |
| --- | --- | --- | --- | --- |
| F1 | minor（复审遗留） | `coding-reports/P003-T011.md:15,27,152` 与 `evidence/recon/P003-T011.md:51`：只支持 `match if {}` 体，「子集外语法装载即报错，不静默跳过」 | 规则写 `match { input.type == "a" }`（无 `if`）→ 装载 200、求值正常命中，**不报错**；`some`/`else`/`in`/`>=`/`count()`/多 match 体都会 502 | 临时目录放该规则，`new RuleStore(dir)` 起服务 → `GET /api/rules` 200、`POST /api/rules/evaluate {"type":"a"}` 命中 1；上一轮代码审查已点 `rule-store.js:102` 的 `if` 可选，本轮按群主「只修三处」未修 |
| F2 | minor（doc-side） | `openapi.yaml` 的 `/api/rules/evaluate` 与 `AlertFact` 没写正文上限；平台缺省只记在 `docs/modules/http-api.md:276-288`（8192 字符），且兄弟路由 `POST/PUT /api/triage/rules*` 显式用 100000 | 8193 字符的合法事实 → 400「请求正文过大」；8192 → 200 | 本报告 §5 用例「正文恰 8192 / 8193」；建议 openapi 补一句上限（或把 evaluate 与 triage 路由对齐到 100000） |
| F3 | minor（doc-side） | `openapi.yaml` `RuleLibraryError`：「规则文件读取或解析失败；正文 error 里带 `rules/<文件>:<行>` 定位」 | 规则 id 重复时 → 502 `规则库读取失败：规则 id 重复：beta（a.rego 与 b.rego）`——有文件名、无 `rules/` 前缀、无行号（这是库级校验，不属于「文件读/解析失败」，可视为 spec 少写一类） | `evidence/test/P003-T011/rego-rules.e2e.test.js`「502 规则 id 重复」用例；建议 spec 补「库内规则冲突」一类与它的定位口径 |

## 8 观察（不算 finding）

- 原始请求 `GET /api/rules/..`、`/api/rules/%2e%2e` 实测 404「接口不存在」：`..` 在 URL 解析阶段被消解成 `/api/`，请求根本到不了 id 校验；其余非法 id 都按文档 400。
- 502 文案上列表/读用「规则库读取失败：」，求值用「规则求值失败：」，两者都带 `rules/<文件>:<行>`；spec 未固定前缀，不算违约。
- `HEAD /api/rules` 回 404 且无正文（Node 对 HEAD 不写 body）——方法不匹配按 `docs/modules/http-api.md` 是 404，一致。

## 9 残余风险

- 求值器是仓内 Rego 子集、不是 OPA，本卡未用真 OPA 交叉验证规则可编译性（仓内无 `opa`，交卷报告未决 1 已申报）；本报告只断言文档化子集语义。
- `docs/modules/` 缺 `rule-store` 页（`_breakdown.json` 未登记、`http-api.md` 路由表未收录三条新接口）——scope 外，交卷报告未决 3 已申报；本报告没有据此扣分。
- 未跑 `web/**` 前端链路（本卡无前端入口，`web` 禁改），接口消费方为零。
- 事实字段的 schema 类型违规（数字/对象喂给字符串字段）只验了不崩、不误命中；spec 未规定这类输入的响应码，未深挖。
