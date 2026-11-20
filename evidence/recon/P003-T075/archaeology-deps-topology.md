# DDD 依赖拓扑考古报告 · hids-ai-console

**代码基线**：`899ae2575604d5557e8202c55a3b5a558ab251af`（`899ae25`）
**检索时点**：2026-11-21T00:26:31+08:00
**口径**：根目录 53 个 `.js` 中，**31 个产品文件**入图（排除 22 个 `*.test.js`）。`web/` 是独立 npm 工程（根 `package.json:9` 的 `test:web` 走 `npm --prefix web`），不在后端图内；`evidence/`、`docs/`、`coding-reports/`、`wiki/` 排除。
**工具**：本仓**无 `.codegraph/` 索引**（`codegraph files -p .` → `CodeGraph not initialized`），全程用 `ffgrep` + `read` 静态扫 `import ... from './x.js'`。产品代码内**无 `require()`、无动态 `import()`**（动态 import 只出现在 `evidence/test/**` 探针里），故静态 import 图 = 完整运行期依赖图。

**图规模**：31 个节点 · **72 条依赖边**（73 条 import 语句，`server.js` 的 `syslog-input` 导了两次）。

---

## 1. fan-in / fan-out 全表

fan-in = 被几个产品文件 import；fan-out = import 了几个不同的本地模块。

| # | 文件 | 行数 | fan-in | fan-out | fan-in 来源（file:line） |
|---|---|---|---|---|---|
| 1 | `log.js` | 315 | **10** | 0 | server.js:17, investigation-agent.js:5, triage-monitor.js:7, syslog-case.js:5, wiki-workbench.js:6, config-store.js:16, fp-maintainer.js:21, maintenance-server.js:8, package-policy.js:7, syslog-input.js:3 |
| 2 | `record-redaction.js` | 42 | **9** | 0 | server.js:25, triage-monitor.js:8, triage-rules.js:6, syslog-case.js:6, trace-board.js:6, required-evidence.js:1, update-store.js:4, knowledge-workbench.js:2, wiki-replay.js:4 |
| 3 | `cloudwalker.js` | 286 | **8** | 0 | server.js:9, investigation-agent.js:4, triage-monitor.js:5, trace-board.js:4, wiki-workbench.js:4, knowledge-workbench.js:1, agent-tools.js:3, api-tools.js:1 |
| 4 | `prompt-store.js` | 134 | **5** | 2 | server.js:15, investigation-agent.js:8, trace-board.js:5, maintenance-server.js:6, package-policy.js:6 |
| 5 | `config-store.js` | 147 | **4** | 3 | server.js:29, wiki-store.js:440, rule-store.js:481, prompt-store.js:132 |
| 6 | `rule-store.js` | 482 | **4** | 1 | server.js:26, investigation-agent.js:6, wiki-store.js:441, fp-maintainer.js:20 |
| 7 | `syslog-input.js` | 124 | **4**（5 语句） | 1 | server.js:18, server.js:19, investigation-agent.js:7, triage-monitor.js:4, syslog-case.js:4 |
| 8 | `wiki-store.js` | 516 | **3** | 2 | server.js:20, investigation-agent.js:10, prompt-store.js:133 |
| 9 | `update-store.js` | 172 | **3** | 1 | server.js:23, maintenance-server.js:7, package-policy.js:8 |
| 10 | `agent-tools.js` | 123 | **2** | 3 | server.js:10, api-tools.js:2 |
| 10 | `evidence-view.js` | 397 | **2** | 0 | investigation-agent.js:9, agent-tools.js:4 |
| 10 | `model-client.js` | 131 | **2** | 0 | server.js:12, config-store.js:18 |
| 10 | `rpc-client.js` | 31 | **2** | 0 | server.js:8, config-store.js:17 |
| 10 | `syslog-case.js` | 217 | **2** | 3 | investigation-agent.js:11, triage-monitor.js:6 |
| 16 | `api-tools.js` | 94 | 1 | 2 | server.js:11 |
| 16 | `fp-maintainer.js` | 518 | 1 | 2 | server.js:28 |
| 16 | `investigation-agent.js` | 1212 | 1 | 10 | server.js:13 |
| 16 | `investigation-store.js` | 33 | 1 | 0 | server.js:14 |
| 16 | `mcp-client.js` | 77 | 1 | 0 | agent-tools.js:2 |
| 16 | `required-evidence.js` | 207 | 1 | 1 | investigation-agent.js:13 |
| 16 | `trace-board.js` | 635 | 1 | 3 | server.js:22 |
| 16 | `triage-monitor.js` | 1101 | 1 | 5 | server.js:16 |
| 16 | `triage-output.js` | 73 | 1 | 0 | investigation-agent.js:12 |
| 16 | `triage-rules.js` | 316 | 1 | 1 | server.js:24 |
| 16 | `wiki-replay.js` | 123 | 1 | 1 | wiki-workbench.js:5 |
| 16 | `wiki-workbench.js` | 387 | 1 | 3 | server.js:21 |
| 26 | `knowledge-store.js` | 70 | **0** | 0 | —（仅测试：investigation-agent.test.js:8、knowledge-workbench.test.js:6） |
| 26 | `knowledge-workbench.js` | 173 | **0** | 2 | —（仅测试：investigation-agent.test.js:9、knowledge-workbench.test.js:7） |
| 26 | `maintenance-server.js` | 178 | **0** | 3 | —（独立入口进程，仅维护端测试引） |
| 26 | `package-policy.js` | 59 | **0** | 3 | —（内部 CLI，无人 import） |
| 26 | `server.js` | 1505 | **0** | **20**（21 语句） | —（组合根，仅 22 个测试文件引） |

**扇出侧最重的三个**：`server.js` 20（导入 21 条语句，server.js:8-29）、`investigation-agent.js` 10（:4-13）、`triage-monitor.js` 5（:4-8）。

---

## 2. 环清单：**没有环**

**全图无 import 循环，是严格 DAG。** 你怀疑的 `server.js / triage-monitor / investigation-agent` 三者之间**不存在环**：

- `server.js:13` → `investigation-agent.js`，`server.js:16` → `triage-monitor.js`；但 `investigation-agent.js` 与 `triage-monitor.js` **互不 import**（前者 import：cloudwalker/log/rule-store/syslog-input/prompt-store/evidence-view/wiki-store/syslog-case/triage-output/required-evidence；后者 import：syslog-input/cloudwalker/syslog-case/log/record-redaction），且**没有任何产品文件 import `server.js`**（22 个测试文件除外）。
- 唯一看似闭环的链路 `prompt-store.js:133 → wiki-store.js:441 → rule-store.js:481 → config-store.js:17/18` 是单向链，末端 `config-store.js:16 → log.js` 是叶子。

**这个"无环"是刻意维护出来的，不是巧合**，代码里有三处自白：

- `config-store.js:29-30`：「放在本模块而不是 server.js：`server.js` 已经 import 本模块（`server.js:26`），**反向 import 会成环**」
- `fp-maintainer.js:67`：「实现只此一份：`server.js` 从这里 import（**反向 import 会成环**）」
- `docs/architecture.md:207`：「存储层不依赖编排层……四个有 import 的单向无环，层内取用不许出现环」

**但"无环"不等于"边界清晰"**——耦合没有变成环，而是变成了**同层横向 + 跨层穿透**（见第 4 节）。

---

## 3. 枢纽判断

判定口径：**fan-out = 0 且扇入横跨多层 ⇒ 内核（合理）**；**一个模块同时承担多类职责、导致扇入者被迫连带依赖它不该依赖的东西 ⇒ 病态门面**。

| 排名 | 文件 | fan-in | 判定 | 依据 |
|---|---|---|---|---|
| 1 | `log.js` | 10 | **健康内核** | 零本地依赖（log.js:13-14 只有 node:fs/node:path）；`log.js:66` 进程级唯一实例；`log.js:68` `useJournal()` 用 ESM 活绑定做注入缝，不产生环；它承载的是**安全闸**（log.js:16-17 键名 + 值双闸）不是业务门面。10 个扇入者横跨传输/编排/存储/入口/CLI，正是内核该有的形态。**小瑕疵**：一个文件同时塞了写日志（`log`）、读日志/轮转（`readLogEntries`/`queryLevels`/`pruneLogFiles`/`logFileOptions`）、模型埋点（`traceModelCall`）——`server.js:17` 一行 import 了 7 个符号。fan-in 高有一部分是"顺手塞一起"，拆成 log-writer / log-query / model-trace 三个会掉 fan-in。 |
| 2 | `record-redaction.js` | 9 | **结构健康，边界名存实亡** | 43 行、零本地依赖，是标准共享内核。但两个病点见第 4 节 V7：**最重的记录面（investigation-agent）根本没用它，自己抄了一份**，且 9 个调用点散在 7 个模块——是"约定式脱敏"不是"结构式脱敏"。 |
| 3 | `cloudwalker.js` | 286 | **健康内核，但耦合的是词汇表不是网关** | 零本地依赖。8 个扇入者里 5 个（investigation-agent.js:4、triage-monitor.js:5、trace-board.js:4、wiki-workbench.js:4、knowledge-workbench.js:1）**只为了 `eventTypes` 这一个常量表**。说明大家要的是"事件分类词汇表"，却为此依赖了"事件网关"整个模块。DDD 上该把 `eventTypes` 抽成独立的分类值对象。 |
| 4 | `prompt-store.js` | 134 | **偏病态（共享存储实现被当作公共设施）** | 5 个扇入者分属 4 个不同上下文（server / investigation-agent / trace-board / maintenance-server+package-policy）。它没有独立扇入型职责，是"被共享的具体 repository 实现"。 |
| 5 | `config-store.js` | 147 | **病态（万能门面）** | 见下面专门一节。 |
| 6 | `rule-store.js` | 482 | 中性 | 4 个扇入者，扇出 1（config-store.js:481）。但 `wiki-store.js:441` 把它当函数库调用（`seedLibrary`）——聚合根被当工具箱用。 |
| 7 | `syslog-input.js` | 124 | 中性偏病 | 扇入 4，但它是**输入适配器**（syslog 解析），却同时被 `syslog-case.js:4` 这种存储模块直接引用——解析逻辑落点错层。 |
| 8 | `wiki-store.js` | 516 | 偏病态 | 一个文件里混了「聚合根（判据页读写）」+「纯文本投影函数（`pageSummary`:491 / `pageExcerpts`:499 / `pageBody`:446）」+「种子逻辑」，编排层 `investigation-agent.js:356-359` 为了用两个纯函数被迫 import 整个存储模块。 |
| 9 | `update-store.js` | 172 | 健康 | 升级包信封，扇入 3，全在维护链路内，方向一致。 |
| 10 | `agent-tools.js` / `evidence-view.js` / `model-client.js` / `rpc-client.js` / `syslog-case.js`（各 2） | — | 健康 | 均零扇出或低扇出，方向一致。`evidence-view.js`（397 行、扇入 2、扇出 0）是干净的共享内核。 |

### 特别关注三问

**① `log.js` 被大量 import —— 好事。**
判据：零本地依赖（`log.js:13-14`）；进程级单例 + 可替换注入缝（`log.js:66-69`），不制造环；扇入者横跨 6 类层次。唯一建议是拆出 `log-query` / `model-trace`，让不需要读日志的模块不必拉整个模块进来。

**② `record-redaction.js` 被大量 import —— 扇入本身是好事，但当前形态病态。**
- 好的一面：43 行、零依赖、纯函数（`record-redaction.js:20-27`），是教科书式共享内核。
- 病的一面一：**最大的记录面绕过了它**。`investigation-agent.js:100-106` 自己抄了一份 `recordFailure`，`:113` 又抄了一份 `reasonForRecord`，`:98` 自带 `namedFailures`、`:101` 自带超时正则。两份实现**已经分叉**：record-redaction 版支持 `{kind, keep}`（`record-redaction.js:20`），investigation-agent 版两个都没有——本地自造的固定话术也会被抹成字数。**判据**：不是"扇入 9 高"，而是"共享内核的两个实现不同步"。
- 病的一面二：闸门分散在 7 个模块 9 个调用点（`required-evidence.js:154`、`update-store.js:148`、`trace-board.js:398/399/424/561/620`、`triage-monitor.js:773/820/952/1084`、`wiki-replay.js:4`…），每写一次盘都要"记得调用"。**结构上应该收口到持久化边界统一施加**，而不是靠约定。

**③ `config-store.js` 被大量 import —— 是坏事，病态门面。**
fan-in 只有 4（数字不大），但它是**本仓唯一一条"存储层 → 传输层"的管道**，且被当成了三层功能的合体：
- 职责一：数据根路径解析——`dataRoot()`（`config-store.js:34-38`），一个纯函数；
- 职责二：可写配置覆盖层——`WRITABLE_CONFIG_KEYS`（`config-store.js:21-24`）、`createConfigStore()`；
- 职责三：配置值合法性校验——`validateConfigValues()`（`config-store.js:51-66`），**为此 `new RpcClient()`（:53）和 `new ChatModelClient()`（:64）**，即 `config-store.js:17-18` 把两个 HTTP 客户端拖了进来。

后果：`wiki-store.js:440`、`rule-store.js:481`、`prompt-store.js:132` **三个存储模块只为了 `dataRoot` 一个纯路径函数，却因此在模块图里挂上了牧云 RPC 客户端和模型 HTTP 客户端**（`config-store.js:17-18`）。更糟的是 `prompt-store.js`→`wiki-store.js`→`rule-store.js`→`config-store.js` 形成一条存储层内部链，编排层经 `investigation-agent.js:8` / `trace-board.js:5` 间接继承全部传输层依赖。
**判据**：扇入者"只用一个纯函数却被迫连带依赖两个网络客户端"——这是病态门面，不是内核。

---

## 4. 越层引用清单

分层标尺取自仓库自己的 `docs/architecture.md:190-199`（传输 / 事件网关 / 取证工具 / 证据投影 / 编排 / 存储 / 入口，共覆盖 21/31 个文件）。

| # | 越层类型 | 位置（file:line） | 说明 |
|---|---|---|---|
| **V1** | **存储层 → 传输层** | `config-store.js:17`（rpc-client）、`config-store.js:18`（model-client）；受害存储模块 `wiki-store.js:440`、`rule-store.js:481`、`prompt-store.js:132` | 存储模块只要 `dataRoot()` 纯函数，却被 config-store 的校验逻辑连带拉进两个 HTTP 客户端。**这是最该先拆的一条**——把 `dataRoot` 单独摘成零依赖叶子即可断链。 |
| **V2** | **编排层 → 存储层 → 传输层**（传递越层） | `investigation-agent.js:8` → `prompt-store.js:132` → `config-store.js:17-18`；`trace-board.js:5` → `prompt-store.js:132` → 同上 | 编排层因此在模块图上依赖了传输层，编译期就绑死。 |
| **V3** | **编排层 → 存储实现的静态函数** | `investigation-agent.js:10` → `wiki-store.js:491`（`pageSummary`）、`wiki-store.js:499`（`pageExcerpts`）；调用点 `investigation-agent.js:356-359` | 编排层为做证据投影，直接调存储文件里的纯函数。纯函数被关在聚合根文件里，是分层泄漏的典型形态。 |
| **V4** | **编排层自己 new 存储实现** | `investigation-agent.js:473`（`promptStore = new PromptStore()`）、`investigation-agent.js:475`（`this.ruleStore = ruleStore \|\| new RuleStore(defaultRulesDirectory)`） | 应用服务在缺省参数里直接构造 adapter，而不是收 port。DDD 上这是最硬的一条越层。 |
| **V5** | **存储层横向跨聚合直连** | `wiki-store.js:441`（`import { seedLibrary } from './rule-store.js'`）→ 调用点 `wiki-store.js:436`；`prompt-store.js:133`（`import { ensureWikiLibrary, wikiLibraryDirectory } from './wiki-store.js'`） | 判据库直接调规则库的播种函数；提示词库直接调判据库的播种函数。跨聚合无接口、无 port，是直连。 |
| **V6** | **同层横向耦合** | `api-tools.js:2` → `agent-tools.js:54`（`EvidenceSession`） | 牧云 API 侧工具箱复用 MCP 侧模块的会话类型（仓库自己在 `docs/architecture.md:203-204` 标了"容易看错"）。两个工具箱共用一个会话概念，边界在文件边界上错位。 |
| **V7** | **共享内核被绕过（实现分叉）** | `investigation-agent.js:100-106` + `:113` + `:98` + `:101`（私货）vs `record-redaction.js:20-27` + `:40`（正规实现） | 脱敏闸有两份不同步的实现，扇入 9 的那个模块反而不是研判记录面在用的那个。 |
| **V8** | **入口层含领域/应用逻辑** | `server.js:242`（`export class RegoRuleMaintainer`，规则维护领域服务）、`server.js:84`（`applyLiveConfig`）、`server.js:114`（`createAnalysisProvider`）、`server.js:735`（`dataInventory`）、`server.js:799`（`dataCleanup`）、`server.js:744`（`assertCasesSettled`，409 业务规则）、`server.js:757`（`archiveTarget`，归档命名规则）、`server.js:847`（`createServer`，**22 个构造参数**） | HTTP 入口同时是应用服务与领域规则宿主。`createServer` 的 22 参里 `knowledge` 与 `maintenanceEntry` **收了不用**（`docs/modules/http-api.md:42` 用 grep 证实只命中定义行）——两个未接线的边界缝。 |
| **V9** | **编排层契约命名错位** | `investigation-agent.js:473` 第 4 参名 `knowledgeStore`，`server.js:53` 实际传的是 `WikiStore`；`docs/architecture.md:212` 已记录 | 同一个参数名在两个模块里指向两套东西（`knowledge-store.js` 另有其人）。边界靠命名传达，命名已失效。 |
| **V10** | **孤儿模块（未接线）** | `knowledge-store.js`（70 行，fan-in 0）、`knowledge-workbench.js`（173 行，fan-in 0）；仅 `investigation-agent.test.js:8-9`、`knowledge-workbench.test.js:6-7` 引用 | 一套「候选经验整理台」有实现有测试，但业务进程永不加载。DDD 重构时必须先决定它是新限界上下文还是死代码。 |
| **V11** | **分层文档不覆盖 1/3 的产品代码** | `docs/architecture.md:190-199` 的分层表只列 21 个文件；未分层 10 个：`log.js`、`config-store.js`、`syslog-input.js`、`syslog-case.js`、`fp-maintainer.js`、`package-policy.js`、`required-evidence.js`、`triage-output.js`、`wiki-replay.js`、`knowledge-workbench.js` | "没分层"不等于"没耦合"——V1/V2/V5/V7 全部落在这 10 个未分层文件上。分层表与真实依赖图两张皮，是重构最容易踩空的地方。 |

---

## 5. 给重构的三句话（只指方向，不下方案）

1. **先把 `dataRoot` 从 `config-store.js` 里摘出来**（V1/V2）——单点动作，直接断掉全仓唯一的「存储→传输」管道，并让 3 个存储模块的依赖图缩一圈。
2. **`server.js` 是唯一的上帝模块**（1505 行、扇出 20、`createServer` 22 参、V8）：传输、应用服务、领域规则三合一，域边界只能从它身上切。
3. **`record-redaction` 的扇入 9 是假象**（V7）：真正的问题是最重的记录面在用私货。统一到一处实现，比重新划边界更早见效。

---

## 6. 复现方法

```bash
# 本仓无 codegraph 索引（不可用于本报告）
codegraph files -p .          # → CodeGraph not initialized in /home/trtyr/code/hids-ai-console

# 依赖边（逐个被依赖模块各扫一次，limit 30，按文件分组输出 file:line）
ffgrep "from './log.js'"              # → log.js 的 10 个扇入者
ffgrep "from './record-redaction.js'" # → 9 个
ffgrep "from './cloudwalker.js'"      # → 8 个
ffgrep "from './prompt-store.js'"     # → 5 个
ffgrep "from './config-store.js'"     # → 4 个
ffgrep "from './rule-store.js'"       # → 4 个
ffgrep "from './syslog-input.js'"     # → 4 文件 / 5 语句
ffgrep "from './wiki-store.js'"       # → 3 个
ffgrep "from './update-store.js'"     # → 3 个
ffgrep "from './agent-tools.js'"  "from './evidence-view.js'"  "from './model-client.js'"
ffgrep "from './rpc-client.js'"  "from './syslog-case.js'"    # → 各 2 个
# 出边（扇出）与全部 import 语句行号
ffgrep "from './"  --path "*.js"       # 配合 path/exclude 过滤根目录产品文件
ffgrep "^import"   --path "*.js"       # 补齐续行 import（server.js:27-28、wiki-store.js:440-441 等）
# 确认无动态依赖
ffgrep "import\("                       # 命中全在 evidence/test/** 探针，产品代码 0 命中
# 规模
read <file> --offset 9999 --limit 1     # → "Offset 9999 is beyond end of file (NNN lines total)"
```

**残余风险 / 未覆盖**：
- 本报告只做**静态 import 图**。运行期的**对象图耦合**不在其中——最典型的是 `server.js:847` 的 22 参装配线，以及 `investigation-agent.js:473` 的 6 参构造，二者把多个限界上下文在运行时缝在一起，静态图看不见。
- `web/`（前端独立工程）未纳入；若前端也有 API 契约耦合，需另做一次跨栈考古。
- `evidence/test/**` 下有 30+ 个测试/探针脚本 import 后端模块，测试侧的耦合未纳入本图（按需求排除 `*.test.js`）。
- 本仓**无 `.codegraph/` 索引**；若要持续跟踪依赖漂移，`codegraph init` 建索引后可自动化，但需另行决定（本次只读，未建）。
- 代码一动本报告即过期——重跑上述 `ffgrep` 序列即可复核。