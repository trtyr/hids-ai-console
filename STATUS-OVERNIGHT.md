# 夜间执行状态（写给晨间复核 · 2026-11-21 夜）

**一句话**：四个提交已合入 main 且全绿；T072（日志）代码完成且单测绿（250/250）但全量 evidence 复跑被环境故障打断；T062（审计）与 T059（只读出口）代码与用例已写完、**未验证**；M7 迁移批 1（trace）三个新文件已写好、**未切换**（旧 trace-board.js 原样在位，仓仍处于绿状态基线上叠加未验证改动）。

## 已提交并验证（main，按序）

| 提交 | 内容 | 验证口径 |
|---|---|---|
| `70d71cb` | T075：DDD 总纲 + src 骨架 + check-layers/check-api 双门禁（基线 52/8） | 门禁实测；不动产品代码 |
| `9a847fb` | T060：command 四键回退 + poll 案件进列表 | 单测 237/237 |
| `09478c1` | 批 0：dataRoot 摘叶 + redaction 收口（消 investigation-agent 自抄分叉） | 单测 237/237 |
| `84d2c56` | T073：全端统一错误模型（维护端 21 处补 code、401 改 JSON、SSE 帧 code、405+Allow、未知路径统一） | 单测 242/242 + evidence 492/491+1todo/0fail |

## 写完但未验证（工作树未提交，按依赖顺序）

1. **T072 日志系统化**（最接近完成）：
   - `log.js` 重写并迁 `src/shared/logging/log.js`（根文件已删，全仓 import 已改）
   - 默认落盘（生产开 / 测试进程关）/ ALS request_id+user / 批量异步写（`hitBoundary` 修复并发假轮转）/ q 全文检索 / 总量上限
   - `npm test` 250/250（含 log-system.test.js 8 条新用例）**在边界修复后实测通过**
   - **未完成**：修复后的 evidence 全量复跑（T045 的 16 条已单跑绿；T023/T034/T044/T046/T047 的适配断言已改好但没整跑过）
2. **T062 审计系统**：audit 上下文三件（domain/application/infrastructure）+ server.js 全部写路由挂审计点 + GET /api/audit + openapi + 维护端四动作 + `publicRelease()` 补 actor；`audit.test.js` 6 条用例未跑过
3. **T059 只读出口**：GET /api/dict + GET /api/agent/investigations + case-files 两路由 + InvestigationStore.list() + openapi + `read-outlets.test.js` 未跑过
4. **批 2 前置件**：`src/shared/vocabulary.js` + `src/shared/alert-shape.js` 抽取完成，cloudwalker.js 改 re-export（旧 import 全兼容）——未跑过
5. **批 3 种子**：`src/contexts/triage/domain/triage-case.js`（Verdict/状态单一真源），investigation-agent / triage-output / wiki-replay / server.js 已改 import——未跑过

## 迁移批 1（trace）：新文件就位、未切换

`src/contexts/trace/{domain/board.js, application/trace-service.js, infrastructure/board-store.js}` 已写好（含批 1 完成标志：`assertLink` 领域不变量，AI link 动作与程序自动建边都过闸）。**旧 `trace-board.js` 未删、import 未改**——切换用 `bash scripts/cutover-trace.sh`（换 import → 删旧 → 残留检查 → 跑测试；回滚 `git checkout HEAD -- .`）。

## T081（文档去重）：文档改动已完成、本地门禁已写（未跑）

- 两份架构文档的分工在两页开头定死并互指（`AR-L0` = 边界/不变量/数据流的最上层权威；`AR-BACKEND` = 模块细节与运行手册；refactor-ddd.md = 迁移目标）。
- `docs/index.md` 补上 `architecture/architecture.md` 与 `refactor-ddd.md` 的真实路径。
- `docs/architecture.md` §4 分层表从 21/31 补到 **31/31**（每文件带 DDD 去向列；基础设施类标注归类理由）。
- `scripts/check-docs.mjs`：gate-cli 的本地等价（frontmatter 齐全 / id 无重复 / covers 指到存在的文件）——本机没有 gate-cli，恢复后跑一遍应为 ok。

## 恢复执行的确切步骤（按序）

```bash
# 0) 确认 exec 恢复：node --version 有输出
node --test read-outlets.test.js audit.test.js log-system.test.js   # T059/T062/T072 新用例
npm test                                                            # 全量单测（预期 250+新增）
# 修掉暴露的问题后：
node --test --test-timeout=60000 --test-force-exit $(find evidence -name '*.test.js' | sort)   # evidence 全量
# 1) 提交（建议拆两笔：T072 一笔、T062+T059+批2前置+批3种子 一笔）
# 2) 批 1 trace 切换：bash scripts/cutover-trace.sh → 绿后提交
# 3) 继续批 2–7 与缺口卡（顺序见 docs/architecture/refactor-ddd.md §4）
```

## 环境故障记录

约 01:20 起（T072 收尾阶段）宿主 exec 全挂：所有 Bash 调用（含子代理、干净 shell、env -i）一律 exit 1 无输出；重定向建的文件为空（进程未真正执行）。持续 >1.5h，每 10–25 分钟自动重试一次（后台 sleep+test 任务），恢复后按上面步骤继续。**这不是代码问题**——最后一批绿跑（250/250）之后只叠加了文件编辑。

## 诚实声明

- 台账口径「done」只给已验证的：T072/T062/T059 的卡状态在验证通过前**不改为 done**（D004：没有真数据就不假装验过）。
- `docs/architecture/refactor-ddd.md` 的迁移顺序在执行中有一处微调：shared 内核（vocabulary/alert-shape）提前到批 1 之前做（否则 trace 的 src 文件会违反 src→根禁令），已在批 2 前置件里落实。
