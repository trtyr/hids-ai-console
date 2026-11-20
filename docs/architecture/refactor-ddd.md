---
type: guide
id: GUIDE-REFACTOR-DDD
created: 2026-11-21
updated: 2026-11-21
plan: P003-T075
refs: [D034, D035]
---

# DDD 架构升级总纲（P003-T075 定稿）

这份文档把 [D034](../../.plantree 决策，落盘于台账 decisions/D034.md) 的设计变成**可执行的迁移工程**：目录骨架、53 个根文件的逐个去向、七批迁移计划、两条门禁脚本与它们的基线数字。迁移期间本文档是唯一边界真源；每张迁移卡的 blocked_note 都指向这里。

> **确认门**：D034/T075 原要求「文档过群主确认门后才允许开后续迁移卡」。群主 2026-11-21 夜间指令：**「你把下面的所有 plan 都给我实现出来……把所有后端的 plan 都给我结束掉、写完。明天早上我起来的时候，我希望你能看到一个大一统的后端，是一个完全重构之后非常强大的后端。」** 结合 D034 已记录的 2026-11-21 授权「大改大砍，必要时全面改成 DDD」，确认门视为已过。本文档如有偏差，晨间复核时以群主意见为准回滚对应批次。

## 0. 现状量化（基线，2026-11-21 `899ae25` 实测）

| 事实 | 数字 | 出处 |
|---|---|---|
| 仓库根 `.js` 文件 | **53** = 产品 31 + 测试 22 | `ls *.js` |
| `server.js` 行数 | **1504 行，6 个职责块**；路由 `createServer` 占 **559 行（:847-1405）**；22 个构造参数（`knowledge`、`maintenanceEntry` 收了不用） | `wc -l server.js`、D034 §8.2 |
| 直接 import `./server.js` 的测试 | 单测 11 个 + evidence 41 个 | grep |
| 判定（verdict）副本 | 产品代码 **10 个文件**；`investigation-agent.js` 一处 82 行（词元 153 次）；中文名对照后端 3 份 + 前端 3 份 | D034 §1 |
| `TriageMonitor` 方法数 | **36**（含构造），一装四（队列/状态机/持久化/投影） | D034 §1 |
| 状态字面量散落 | 唯一定义 `server.js:495` + `triage-monitor.js` **29 处**字面量 | D034 §4 #6 |
| payload 字段映射 | 至少三套（`triage-monitor` 10 键 / `syslog-case` 9 键 / `cloudwalker` API 形状）——已出 `command` 恒 null 的 bug | D034 §1 |
| 存储层横向直连 | `wiki-store.js:441` import `rule-store` 的 `seedLibrary`；`prompt-store.js:133` import `wiki-store` 的 `ensureWikiLibrary` | D034 §8.1 |
| 脱敏绕闸 | `investigation-agent.js:100-106/113` 自抄 `recordFailure`/`reasonForRecord`（与 `record-redaction.js` 已分叉） | D034 §8.1 |
| handler 超载 | **9 处**承载 ≥2 个用例（最重：`POST /false-positive` 一条 69 行干 9 件事） | 考古 §四 |
| check-layers 基线 | `struct.file-placement` 31（根产品文件）+ `error.json-status` 20（19 维护端 + `server.js:949` 502）+ `error.writehead-status` 1（`server.js:429` 401）= **52** | `scripts/check-layers-baseline.json` |
| check-api 基线 | 契约 **57 操作 ↔ 注册表 58 路由**；实现缺契约 **1**（`PUT /api/wiki/pages/{pagePath}`）；该开出口内部用例 **5**（I-08/I-12/I-13/I-14/I-15）；死代码 2 项 | `scripts/check-api-baseline.json` |
| 用例面 | **58 条实现路由 = 45 个对外用例 + 23 个内部用例** | 考古 §一/§五 |
| 行为锚 | 单测 **235**（`npm test`）+ evidence **492**（`node --test --test-timeout=60000 --test-force-exit $(find evidence -name '*.test.js' | sort)`，pass 491 / todo 1 / fail 0） | 2026-11-21 实测复跑 |

**注**：check-api 的「该开出口」是 5 条不是 4 条——D034 §8.2 把 I-03（队列 worker）更正移出后剩 4 条（I-08/I-12/I-13/I-15）；第 5 条是 I-14（规则维护会话无详情路由，即 A11），与 T070/T086 对齐。三类划分以 `scripts/check-api.mjs` 内嵌清单为准。

## 1. 领域识别：7 个上下文（与 D034 §2 逐字一致）

| 上下文 | 聚合根 | 内部概念 | 核心不变量 |
|---|---|---|---|
| **ingestion** 摄取（ACL，无 domain） | — | AlertType(11)、Level(5)、原始报文 | 外部两种来源收敛成同一个 Alert 形状；字段映射只有一张表。Alert 是厂商 API 的投影，不设 `domain/`；**Alert 形状落 `shared/alert-shape.js`** |
| **triage** 研判 | **TriageCase** | Verdict、Confidence、QueueState(5)、Stage、Evidence、CaseFile | 案件状态迁移合法（不能从 done 回 queued，人工重入队除外）；证据必须有 sha256 才能引用；结论为 uncertain 时必须带 missing_evidence |
| **trace** 溯源 | **TraceBoard** | Hop、Link、Gap、Node、Edge、Citation | link 两端 hop 必须存在；has_gaps 与 gaps 非空一致；每个 claim 的 citation 指向已取证据 |
| **knowledge** 版本化文档（收窄） | **Rule** / **KnowledgePage** / **RuleSet(JSON)** | RuleRevision、TriageRuleSet、PromptSection | 版本只增不改（乐观锁 expected_revision）；回滚产生新版本而非删除。**两套规则不合并聚合**（D034 §8.3） |
| **maintenance** 维护会话 | **MaintenanceSession** | FpSession / RuleSession / WikiSession | 会话是原地推进的状态机（collecting → validating → published）；幂等键 + 可重放；WikiSession 的 publish 状态机单独保留 |
| **dataops** 数据运维 | —（作业型） | Inventory、CleanupJob、Archive、UpdatePackage、ConfigOverride | 清理只动阈值外；归档可还原；一切运行态在数据根下 |
| **audit** 审计 | **AuditEvent** | Actor、Action、Object、Before/After | append-only；不随技术日志轮转丢弃；actor 必须可识别 |

**判定（Verdict）归 triage**：其他上下文要用它，走 triage 的 application 端口（如字典接口）或 `shared/vocabulary` 的机器值表，不许 import triage 的 domain 文件。

**跨上下文通信**：单向 import 对方 `application/**`（端口）或经 `interfaces/` 的读模型装配；事件暂不引入（单进程内没有第二消费者，端口足够）。已知且允许的单向边（D034 §3 修订）：`triage → ingestion.application`（词汇表与取数）、`maintenance → knowledge.application`（误报 Agent 写两库）、`trace → triage.application`（白板复用研判记录与案卷，经注入的 analysis 端口）。

## 2. 结构与四层依赖规则（可执行）

```
src/
  contexts/<ctx>/
    domain/           纯逻辑：实体、值对象、不变量、领域服务。不许 import infrastructure/interfaces、
                      node:http / node:fs / node:dgram（案卷走 CaseFilePort，存取是端口）
    application/      用例：业务编排唯一入口。收 port（构造注入），不许自己 new 适配器；错误只抛「哪一类」
    infrastructure/   存储与外部客户端：fs、RPC、MCP、模型客户端
  interfaces/
    http/business/    业务端路由（薄：解析 → 调用例 → 序列化）+ middleware/{auth,error-model,request-id,logging}.js
    http/maintenance/ 维护端（18081，独立账号 + CSRF）
    http/read-models/ 跨上下文读模型（alert-with-triage 等）
    udp/syslog/       UDP 入站（dgram，15514）
    cli/              命令行入口（package-policy）
  shared/             真正跨上下文的：errors、redaction、logging/、data-root、vocabulary、alert-shape、seed
scripts/check-layers.mjs    分层门禁（基线→清零）
scripts/check-api.mjs       R-API 三方对账（基线→清零）
```

**五条依赖规则**（`check-layers.mjs` 强制，违例位置直接打印）：

1. `contexts/X/**` 不许 import `contexts/Y/domain|infrastructure/**`；只许 Y 的 `application/**` 与 `shared/**`；禁止任何环（按上下文折叠后查环）。
2. `contexts/**/domain/**` 不许 import `infrastructure|interfaces` 与 `node:http/fs/dgram/net`。
3. `interfaces/**` 只许 import `contexts/*/application/**` 与 `shared/**`。
4. `shared/**` 不许 import `contexts/**`。
5. **`src/**` 不许 import 仓库根旧 `.js`**（迁移期强制：否则每批「0 违规」是空验收）。
6. `application/`、`interfaces/` 内不许 `new XxxStore|Client|Gateway|Toolbox|Engine|Session(`（R-STRUCT+，收 port）。
7. R-ERROR：`json(res, 4xx|5xx 字面量)` 只许在 `src/shared/errors.js` 与 `middleware/error-model.js`；`res.writeHead(4xx|5xx 字面量)` 只许在中间件白名单。判据是词法扫描（跳过字符串/模板串/注释/正则字面量后按括号配对取第 2 个实参），不是正则——维护端 19 处是无空格写法。
8. R-LOG：`console.*` 只许在 `src/shared/logging/**` 与 `scripts/**`。

## 3. 目标目录骨架：53 个根文件逐个去向

**产品文件 31 个**（`旧文件 → 新文件`，批号见 §4）：

| 旧文件 | 去向 | 批 |
|---|---|---|
| `server.js` | **保留**（唯一 HTTP 入口），收成「启动闸门 + 装配 + listen」≤200 行；路由逐批搬进 `src/interfaces/http/business/routes/` | 7 |
| `cloudwalker.js` | 拆：`eventTypes/levelNames/levelRanks/parseInstant/rpcMethods → src/shared/vocabulary.js`；`normalizeAlert/detailEvidence → src/shared/alert-shape.js`；`CloudwalkerGateway → src/contexts/ingestion/infrastructure/gateway.js` | 2 |
| `rpc-client.js` | `src/contexts/ingestion/infrastructure/rpc-client.js` | 2 |
| `mcp-client.js` | `src/contexts/ingestion/infrastructure/mcp-client.js` | 2 |
| `syslog-input.js` | 拆：解析与指纹 `parseSyslog/eventTypeFor/eventSeconds/sessionKey/fingerprint → src/contexts/ingestion/application/parsing.js`；`SyslogReceiver（dgram）→ src/interfaces/udp/syslog/receiver.js` | 2 |
| `syslog-case.js` | 拆：`matchSyslogEvent → src/contexts/triage/application/correlate.js`；案卷**内容**生成（domain 产物）`→ src/contexts/triage/domain/case-file.js`；案卷**原子写**与读取 `writeSyslogCase/writeSyslogResult/updateSyslogDeliveryCount/readCaseFile/readRequiredEvidence/writeRequiredEvidence → src/contexts/triage/infrastructure/case-store.js` | 2 |
| `triage-monitor.js` | 拆五栏（见 §4 批 3）：`src/contexts/triage/domain/triage-case.js`（状态/排序/记录形状）+ `application/triage-monitor.js`（门面与生命周期）+ `application/queue.js` + `application/retry-scheduler.js` + `application/projection.js` + `infrastructure/queue-persistence.js` | 3 |
| `investigation-agent.js` | `src/contexts/triage/application/investigation-agent.js`（+ 回放 `replayInvestigation`、`agentConfigured` 同文件导出）；`verdictMap/verdictLabels → src/contexts/triage/domain/verdict.js` | 3 |
| `triage-output.js` | `src/contexts/triage/domain/report.js`（标签改读 domain/verdict） | 3 |
| `investigation-store.js` | `src/contexts/triage/infrastructure/investigation-store.js` | 3 |
| `required-evidence.js` | `src/contexts/triage/application/required-evidence.js` | 3 |
| `agent-tools.js` | `src/contexts/triage/infrastructure/evidence-toolbox.js`（含 EvidenceSession） | 3 |
| `api-tools.js` | `src/contexts/triage/infrastructure/api-toolbox.js` | 3 |
| `evidence-view.js` | `src/contexts/triage/infrastructure/evidence-view.js` | 3 |
| `model-client.js` | `src/contexts/triage/infrastructure/model-client.js` | 3 |
| `record-redaction.js` | `src/shared/redaction.js` | 0 |
| `log.js` | `src/shared/logging/log.js`（T072 增强后迁移） | 0(T072) |
| `trace-board.js` | 拆：`presentBoard/traceBoardSeed/traceIpSeed/summarizeBoard/rowFacts + 不变量 → src/contexts/trace/domain/board.js`；`TraceBoardService → src/contexts/trace/application/trace-service.js`；fs 读写 `→ src/contexts/trace/infrastructure/board-store.js` | 1 |
| `rule-store.js` | 拆：Rego 子集解析 `parseRule/parseExpression/holds/REVISION/ruleRevision → src/contexts/knowledge/domain/rule-parser.js`；`RuleStore → src/contexts/knowledge/infrastructure/rule-store.js`；`RuleSessionStore → src/contexts/maintenance/infrastructure/session-store.js`（T089 统一 Session 形状） | 4/5 |
| `triage-rules.js` | `src/contexts/knowledge/infrastructure/triage-rule-set.js`（JSON 规则集聚合，不与 Rego 合并） | 4 |
| `wiki-store.js` | 拆：页面元数据/摘要纯函数 `→ src/contexts/knowledge/domain/wiki-page.js`；`seedLibrary → src/shared/seed.js`；`WikiStore → src/contexts/knowledge/infrastructure/wiki-store.js` | 4 |
| `prompt-store.js` | `src/contexts/knowledge/infrastructure/prompt-store.js` | 4 |
| `wiki-workbench.js` | `src/contexts/maintenance/application/wiki-workbench.js` | 5 |
| `wiki-replay.js` | `src/contexts/maintenance/application/wiki-replay.js` | 5 |
| `fp-maintainer.js` | `src/contexts/maintenance/application/fp-maintainer.js`；`FpSessionStore → src/contexts/maintenance/infrastructure/session-store.js` | 5 |
| `config-store.js` | 拆：`dataRoot → src/shared/data-root.js`（零依赖叶子）；`createConfigStore → src/contexts/dataops/infrastructure/config-store.js` | 6 |
| `update-store.js` | `src/contexts/dataops/infrastructure/update-store.js` | 6 |
| `package-policy.js` | `src/interfaces/cli/package-policy.js` | 6 |
| `maintenance-server.js` | `src/interfaces/http/maintenance/server.js`（错误模型 T073 先行统一） | 6(T073)/7 |
| `knowledge-store.js` | **删除**（死代码裁决，见 §6 批 5） | 5 |
| `knowledge-workbench.js` | **删除**（同上） | 5 |

**测试文件 22 个**：全部**留在仓库根**（`npm test` 的 glob 契约与台账引用不动），每批随被迁移模块更新 import 路径；行为锚 235 条不许减断言。

**不动的三块**（`check-layers` 豁免）：`web/`（53 个 js/mjs，前端）、`evidence/`（110+ 文件，审计原始件）、`docs/`。仓内实有 225 个 js/mjs/ts——本总纲只管 53 个根文件与 src/ 新增。

## 4. 分批迁移计划（每批一提交，回滚 = git revert 单提交）

每批硬约束：**写盘格式不变**（要变就双向兼容）；HTTP 契约零变化；`npm test` 全绿且 evidence 用例数不减；`check-layers` / `check-api` 基线只减不增；批末旧文件删净、doc 同批更新锚点（锚点成本过高时改「只引用符号名」并在报告说明）。

| 批 | 上下文 | 主要动作 | 批末 `server.js` 行数（预期） | 回滚点 |
|---|---|---|---|---|
| 0 | shared 内核 | `data-root` 摘叶子、`record-redaction → shared/redaction`（根删旧、全仓改 import） | ~1500 | 批内独立 |
| 0b | （并入 T072/T073 提交） | `log.js → src/shared/logging/log.js`（T072 重写）；`shared/errors.js` 落位（T073） | ~1500 | 各自提交 |
| 1 | **trace（试点）** | 三层拆分 + 不变量断言（link 端点必须存在、has_gaps↔gaps 一致）；验证「上下文切法」 | ~1480 | revert 批 1 |
| 2 | **ingestion（ACL）** | vocabulary/alert-shape 抽共享内核；gateway/rpc/mcp/syslog 归位；**syslog-case 拆 domain 出内容 + infra 做原子写**；三处 payload 收敛成一张表（T060 先修 command bug 当回归锚） | ~1430 | revert 批 2 |
| 3 | **triage** | TriageMonitor 36 方法拆五栏（16 已归类 + 9 未归类逐个落栏）；Verdict 值对象唯一化（吃掉 investigation-agent / triage-output / wiki-replay 三份后端副本）；agent 收 port（删 :473/:475 两处 new） | ~1240 | revert 批 3 |
| 4 | **knowledge** | rule-store 拆解析器；两套规则同上下文不合并；seed 收口 `shared/seed.js`（消 wiki-store→rule-store 直连）；prompt-store 收口（消 prompt-store→wiki-store 直连）；`RegoRuleMaintainer` 从 server.js 搬出 | ~950 | revert 批 4 |
| 5 | **maintenance** | 统一 Session 存储形状（Fp/Rule/Wiki 三店一实现）；wiki-workbench/wiki-replay/fp-maintainer 归位；**删除 knowledge-store.js + knowledge-workbench.js 及其测试**（死代码裁决） | ~830 | revert 批 5 |
| 6 | **dataops + audit** | 盘点/清理/stats 用例化（T061 扩 16 类）；config-store/update-store/package-policy 归位；T074 落点自检 + 迁移脚本；维护端路由壳迁 `interfaces/http/maintenance/` | ~640 | revert 批 6 |
| 7 | **interfaces** | 路由表化（顺序回归用例先行）+ 中间件链（auth/error-model/request-id/logging/audit）+ read-models/alert-with-triage；22 参装配收成按上下文分组的装配契约（两个死参删除）；**check-layers 清零**；`server.js` 只剩启动与装配 | **≤200** | revert 批 7 |

**三条底线**（每批验收对一遍）：盘上数据不丢（条数校验）；HTTP 契约不破（openapi 零变化，本总纲批次内）；235 单测 + 492 evidence 用例作行为锚（可改写法，不许减覆盖）。

**该砍的包袱**（D034 §4 十条，逐批对账）：批 3 砍 verdict 三份与状态字面量 29 处、payload 三套读法（批 2 已收敛）、案卷两个写者（批 2 收一个写入口）；批 4 砍存储横向直连；批 5 砍 knowledge-store/workbench 半死与 410 死接口保留哨兵；批 6 砍 `config-store` 病态门面（dataRoot 摘叶后依赖图缩圈）；批 7 砍 22 参装配与 11 个测试 import server.js（改按用例 import）。

**handler 超载 9 处 → 迁移批分配**（考古 §四）：误报入口 9 件事 → 批 5/7（T088 再拆三段）；`/api/agent/triage/` 一支三用例 → 批 7 拆三条路由；`/api/wiki/` 77 行 → 批 7 拆页面/会话两组；wiki sessions 一正则四用例 → 批 7 拆四条；rules history/rollback 一正则两用例 → 批 7 拆两条；alerts 双数据通道 → 批 7 读模型化；investigations SSE/JSON 双路径 → 批 7 两个传输适配器共用一个用例；investigations 读/replay 重复校验 → 批 7 合一；wiki/sessions POST 一路径两子用例 → 批 7 显式 source 字段。

**路由顺序回归用例**（任何路由表化之前先落测试，批 7 scope）：`/api/agent/triage/status` 先于 `/api/agent/triage/{alertId}`；`/api/agent/investigations/{id}/replay` 先于 `/{id}`；`/api/rules/sessions` 先于 `/api/rules/{id}`。每条：命中后者形状的请求在改前/改后同响应。

**装配线收敛**（批 7）：`createServer` 22 参按上下文分组为 7 组依赖对象（ingestion/triage/trace/knowledge/maintenance/dataops/audit），`knowledge` 与 `maintenanceEntry` 两个收了不用的死参删除；单测以组对象替身注入，替身键名与装配契约一致。

## 5. 门禁脚本

- **`scripts/check-layers.mjs`**（零依赖）：§2 的 8 条判据全内置；词法器跳过字符串/模板串（含 `${}` 嵌套）/行注释/块注释/**正则字面量**（含字符类与 flags），判据跑在骨架上。`--write-baseline` 建基线；基线外违例 exit 1。**当前基线 52 条**（§0 表）。
- **`scripts/check-api.mjs`**（零依赖）：解析 `openapi.yaml` 路径+方法 ↔ 58 条实现路由注册表（每条带 probe 字面量防漂移，probe 落空即红）↔ 45 对外 + 23 内部用例清单。参数名归一化后比对（`{id}` ≡ `{packageId}`）。**当前欠账 8 条**（§0 表）；application 层落地后（批 3 起）在上下文 application 模块导出 `USE_CASES`，本脚本升级为三方对账（用例导出与注册表不一致即红）。

## 6. 域考古实证的落点（D034 §8 逐条）

| 实证 | 落点 |
|---|---|
| `dataRoot()` 是病态门面（三 store 为一个路径函数挂上 RpcClient/ChatModelClient） | 批 0：`src/shared/data-root.js` 零依赖叶子；`config-store` 保留 re-export 至批 6 删旧 |
| `eventTypes`/`level` 是共享内核不是 ingestion 私有物（fan-in 8 中 5 个只为常量表） | 批 2：`src/shared/vocabulary.js`；triage/knowledge/trace 改依赖 shared，ingestion 依赖边消失 |
| 脱敏两处实现且分叉（investigation-agent 自抄版无 `{kind,keep}`） | 批 0 删自抄、统一 import `shared/redaction.js`；持久化边界收口在批 3（store 写盘前统一过闸） |
| `wiki-store→rule-store`、`prompt-store→wiki-store` 横向直连 | 批 4：`seedLibrary → shared/seed.js`；prompt 的库初始化经 dataops 装配注入（构造传目录，不 import wiki-store） |
| `verdict` 中文名表三份 + 前端四态分裂 | 批 3：`domain/verdict.js` 单一真源 + `GET /api/dict`（T059）给字典；前端另改（不在本总纲） |
| `TriageMonitor` 一装四 | 批 3 五栏拆分（36 方法逐栏，归属表随批 3 报告交付） |
| `createServer` 22 参、`knowledge`/`maintenanceEntry` 死参 | 批 7 分组装配，死参删除 |
| 23 内部用例三类划分 | `check-api.mjs` 内嵌清单；4 条 exit_needed 对应 T059/T068/T088/T070/T087/T089 |

## 7. 批末自检清单（每批提交前过一遍）

- [ ] `npm test` 235 全绿；evidence 492 口径（tests 不减、fail 0）
- [ ] `node scripts/check-layers.mjs` 基线外 0 违例；本批涉及条目已从基线删除
- [ ] `node scripts/check-api.mjs` 基线外 0 差值
- [ ] 批内被迁移文件的旧根文件已删除，全仓（含 evidence）无残留 import
- [ ] HTTP 契约零变化（openapi 未动）；写盘格式未变
- [ ] `docs/modules/` 受影响页面 covers/锚点同批更新（或声明改法）
- [ ] 行为对照：抽样 5 条请求改前/改后响应逐字段一致
