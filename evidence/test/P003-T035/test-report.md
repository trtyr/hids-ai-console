# P003-T035 复验测试报告（第二轮复审后的验收）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T035`
- HEAD：`6a57bcc`（`fix(contract+docs): P003-T035 复审补修…`），工作树除本目录新增探针外干净
- 本轮改动面：`git diff --name-only 7d44d8e..6a57bcc` = 5 个文件，全是契约 / 文档 / 侦查图 / 一条契约单测，**实现文件零改动**
  （`git diff --name-only 0230c28..HEAD` 里没有 `investigation-agent.js` / `required-evidence.js` / `evidence-view.js`）
- 判据来源：`openapi.yaml`、`docs/modules/investigation-agent.md`、`docs/modules/evidence-view.md`、`docs/architecture.md`

## 一、必测三项

### ① required-evidence.test.js 的契约用例（`required-evidence.test.js:181-201`）

用例做三件事：抽 `openapi.yaml` 的 `RequiredEvidence` 段 → 断言 `additionalProperties: false` 与 `catalog_absent` 在声明里
→ 用真 `collectRequiredEvidence` 跑「目录缺工具」「目录有工具」两条分支，断言写出的键 ⊆ 声明键集合。

结果：`node --test required-evidence.test.js` → tests 10 / pass 10 / fail 0，exit 0。

**变异验红（我亲手跑，两处）**：

| 变异 | 命令 | 结果 |
| --- | --- | --- |
| 删 `openapi.yaml:1433` 的 `catalog_absent:` 声明行 | `sed -i '/^        catalog_absent:/d' openapi.yaml && node --test required-evidence.test.js` | exit 1，pass 9 / fail 1，报 `catalog_absent 必须声明（required-evidence.js:128 会写这个键）` |
| 删 `openapi.yaml:1431` 的 `total_reported:` 声明行 | 同上手法 | exit 1，pass 9 / fail 1（走「写出的键 ⊆ 声明」那条断言） |
| 复原 | `cp` 备份回写 → `node --test required-evidence.test.js` | exit 0，10/10；`git status --porcelain` 只剩本目录探针，`openapi.yaml` 无 diff |

两条分支都过到了实现真实产出，不是永真断言：`assert.ok(emitted.has('catalog_absent') && emitted.has('args'))` 挂了具体分支缺失名。

### ② 全量 `npm test` 210/210

```
$ npm test            # node --test --test-timeout=60000 --test-force-exit *.test.js
ℹ tests 210
ℹ pass 210
ℹ fail 0
ℹ duration_ms 711.511138
exit=0
```

跑了两遍（变异前 938ms / 变异复原后 711ms），两次都是 210/210。相关既有用例也在里面过：
`HTTP 契约同步…`、`常规研判把必查空页与不可用来源写入结果，deep 采同一套必查项`、
`published customer experience…`（经验复用路径也带 `required_evidence`）、`必查项并发执行…`、`A4 事件视图的裸 id…`。

### ③ 契约抽查

**`openapi.yaml:1408-1434` `RequiredEvidence`**：
- 12 个 property，`required: [id, label, tool, scope, status]`，`additionalProperties: false`（:1434 封闭契约仍在）；
- `catalog_absent` 声明在 :1433，`status` 五值枚举、`id` 六值枚举；
- `total_reported: [integer, null]`（:1431）、`platform_total_consistent: [boolean, null]`（:1432）——两条 null 分支**实际可达**（见下）。

**`openapi.yaml:1869-1873` `Investigation.required_evidence`**：`items: {$ref: '#/components/schemas/RequiredEvidence'}`
（用 `yaml.safe_load` 解出比对，`$ref` 指向一致），description 写「两种模式都有，经验复用捷径也带」——
deep 与经验复用两条路径都有既有绿用例兜着（见 ②）。

**用 jsonschema 4.19.2 对真实产出做 schema 校验**（这是契约用例没做的部分：用例只查键名，不查类型）：

探针 `evidence/test/P003-T035/probe-required-evidence.mjs` 黑盒跑出 8 组场景（目录缺/有授权工具、空页、缺标识、查询抛错、
webshell 文件调用、平台未报总数、蜜罐来源历史），共 **26 条 `required_evidence` 项**，
逐条 `Draft7Validator(RequiredEvidence)` 校验：**failures 0**；另外逐条断言
`id/label/tool/scope/status` 必填键在位、`status`/`id` ⊆ 枚举、`source_unavailable` 与 `missing_identifier` 不带 `args`（与 :1429 description 一致）。

**`platform_total_consistent` 的 null 分支是真的**（`probe-consistency-matrix.mjs`，从 `InvestigationAgent.run` 公开入口走）：

```
平台 total=9, events=0 → returned_count=0 total_reported=9  consistent=true  status=empty_page
平台 total=9, events=2 → returned_count=2 total_reported=9  consistent=true  status=records_returned
不带 total            → returned_count=2 total_reported=null consistent=null status=records_returned
total 是 null          → returned_count=2 total_reported=null consistent=null status=records_returned
平台 total=1, events=5 → returned_count=5 total_reported=1  consistent=false status=records_returned
平台 total=0, events=3 → returned_count=3 total_reported=0  consistent=false status=records_returned
```

即：平台不报总数 → 两个键都落 `null`（:1431/:1432 的「为 null」成立）；返回条数超过自报总数 → `false`。契约与实现一致。

## 二、顺手验的两条文档行为断言

`docs/modules/investigation-agent.md:211-217`「采纳即停的边界」是本轮新增的文档口径，黑盒验（`probe-accept-boundary.mjs`，从 `InvestigationAgent.run` 入口）：

```
① 同批（结论在批首）list_port_assets 调用次数: 1 | 序列: get_suspicious_operation_event,list_port_assets
② 同批两个结论 → 最终 verdict: uncertain | conclusion trace: [summary_chars 1, summary_chars 3]
exit=0
```

① 采纳后同批剩余调用照跑（文档 :212-213）；② 多个 `submit_conclusion` 被接受时取最后一个（文档 :215-216）。
事件详情故意不带 `host_id`，排除必查项调用污染这一段观察。

## 三、没覆盖 / 残余风险

1. 契约用例不查类型——本轮用 jsonschema 探针补上了，但那是**一次性探针，不在门禁里**；类型回退仍无人守。
2. 契约用例是文本抽取式：`RequiredEvidence` 段被挪到 `TraceBoardNode` 之后，用例会先红（找不到块），行为上安全；
   但若有人把段内缩进改掉，`^        ([a-z_]+):` 会抽不到键、`declared` 变空，此时「⊆」断言会整体变红——不会静默放过，只是报错信息不指向根因。
3. `adopted` 在 `conclusion` trace 里恒为 `[]`（探针 ② 观察到的），没查是字段语义未落还是别的原因，不属本卡改动面。
4. A1~A10 的实现面本轮没重跑：实现零改动（上面 git diff 已证），沿用上轮实证 + 本轮全量套件绿。

## 四、结论

PASS。三项必测全绿，变异恰红亲手复现，契约抽查与实现逐条对表，无 finding。
