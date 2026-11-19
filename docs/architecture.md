# HIDS 智能研判平台 · 后端架构

这份文档写给第一次进这个仓的人。它回答三个问题：这套后端在干什么、由哪些件组成、每个件落在哪个文件。
关键结论都标了 `文件:行号`，行号对应当前提交 `a16e0d5`；改动代码后请重新核对。

- 页面地图见 [docs/index.md](index.md)
- 模块级细节见 [docs/modules/](modules/)，清单来源见 [docs/modules/_breakdown.json](modules/_breakdown.json)
- 没查到的、存疑的、留了口子的地方见 [docs/_meta/gaps.md](_meta/gaps.md)

## 1. 这份文档覆盖什么

**覆盖范围**：本仓根目录下这一批平铺的 `.js` 文件构成的后端。仓库里另有三块内容不在这份文档的射程内：

- `wiki/`——研判判据库，Markdown 页面，由 `wiki-store.js` 读取。本文档只说明「代码怎么用它」，页面正文内容本身归 Wiki 维护流程管。
- `prompts/`——提示词与场景卡，由 `prompt-store.js` 读取。同样只讲装载方式，不复述正文。
- `openapi.yaml`——对外 HTTP 接口契约。它与 `server.js` 的路由是两套独立真源，本文档描述运行期行为时以 `server.js` 的路由分支为准，参数细节请查 `openapi.yaml`。

**不覆盖**：客户前端、维护页面、SME lab 里的其余工程。本仓 README 明确说明「只含业务后端，不含客户前端和维护页面」（`README.md:3`）。

**读法**：第 2 到第 3 节是全局地图，第 4 到第 9 节按层展开，第 10 节是配置项速查，第 11 节是验证方法，第 12 节是模块清单（与 `_breakdown.json` 一一对应），第 13 节是已知边界。

**术语约定**：

- **牧云**：外部 HIDS 产品平台，本后端从它读取告警与取证数据。对应环境变量 `CLOUDWALKER_URL`。
- **MCP**：牧云暴露的 Model Context Protocol 服务，地址 `/api/mcp`，本后端用它做只读取证。
- **RPC**：牧云的 `/rpc` JSON-RPC 接口，本后端用它读事件列表与事件详情。
- **常规研判（triage）** 与 **深度研判（deep）**：同一套研判智能体的两种模式，取证工具池和结论口径不同，见第 5 节。
- **三态**：结论只有「真实威胁 / 存疑 / 误报」三种，取值与中文标签的映射写在 `investigation-agent.js:9-14` 与 `triage-output.js:2`。

## 2. 一条告警的完整旅程

这是理解这套系统最短的路径。从牧云产生一条告警到客户拿到一段能读的结论，中间经过下列步骤：

1. **告警进入**。牧云有 11 类事件，类型表在 `cloudwalker.js:2-6`。进入方式有两种：
   - **syslog 推送**：UDP 监听，默认 `127.0.0.1:15514`（`server.js:367-368`、`syslog-input.js:104`）。报文按 RFC5424 解析，正文支持结构化数据、JSON、键值对三种形态（`syslog-input.js:42-57`）。
   - **轮询**：`TriageMonitor.poll()` 定期拉事件列表（`triage-monitor.js:164`）。哪种生效由 `HIDS_TRIAGE_INPUT_MODE` 决定，默认 `syslog`（`server.js:40`）。
2. **去重与排队**。指纹相同、落在同一秒的重复投递合并为一条并累加次数（`triage-monitor.js:232-249`）；队列状态落盘，重启后未完成任务回到 `queued` 继续跑（`triage-monitor.js:56-57`）。
3. **关联牧云事件**。优先按 syslog 里的 `event_id` 精确回查并核对主机身份，回查不到才按主机与时间窗口匹配（`syslog-case.js:15-56`）。匹配不上时走「未匹配」分支，结论强制为存疑（`investigation-agent.js:558-593`）。
4. **规则预筛**（仅常规研判）。规则引擎按主机、字段条件与有效期评估当前事件，命中则作为「误报候选」交给 AI 复核，而不是直接下结论（`triage-rules.js:258-305`、`server.js:117-129`）。
5. **取证**。研判智能体自主选择工具查询，最多 6 轮对话、8 次工具调用（`investigation-agent.js:378`、`investigation-agent.js:396`）。每次调用产出一条带证据编号的记录（`agent-tools.js:57-68`）。
6. **出结论**。模型输出 JSON，结论被映射到三态（`investigation-agent.js:63-73`），随后进入独立复核、引用校验、多级降级三道关卡（第 6 节）。
7. **落盘**。结论写进研判记录库（`investigation-store.js:14-23`）；syslog 触发的案件还会生成一份可读的案件目录，含原始告警、字段表、研判事实、上下文与结果（`syslog-case.js:64-119`）。
8. **交付**。给客户看的 `report` 被限制在 300 字符以内（`triage-output.js:1`、`triage-output.js:47-50`、`triage-output.js:64`），并且必须与三态结论、已核实事实、数据缺口三者一致，否则会被重写（`triage-output.js:35-66`）。

**贯穿全程的一条纪律**：本后端不下指令。它只产出建议——每份研判记录都带 `auto_action: false`（`investigation-agent.js:555`），意思是「未执行任何处置动作」。隔离、封禁、加白一类动作不在本仓范围内。

**另一个闭环**：客户或运维对结论不认可以及，会通过知识库维护会话提出修订，走「会话 → 草案 → 回放 → 人工审核发布」四步（第 7 节），修订后的判据会被后续研判读到。

## 3. 进程与入口

本仓有三个可执行入口，加一个 UDP 监听。它们互不依赖对方进程存活。

### 3.1 业务 API（`server.js`）

`node server.js` 启动，默认监听 `127.0.0.1:8080`（`server.js:25-26`、`server.js:364`）。`npm start` 与之等价；`npm run start:local` 会带上 `--env-file=.env.local`（`package.json:6-7`）。启动时若 `HIDS_TRIAGE_INPUT_MODE` 为 `syslog`，会在监听 HTTP 之后另起一个 UDP 接收器（`server.js:365-370`）。

### 3.2 维护 API（`maintenance-server.js`）

`node maintenance-server.js` 启动，监听地址写死为 `127.0.0.1`，端口取 `HIDS_MAINTENANCE_PORT`，默认 `18081`（`maintenance-server.js:167-168`）。加 `--preview` 参数进入只读预览模式，此时不允许上传或替换（`maintenance-server.js:107`）。

### 3.3 策略包制作（`package-policy.js`）

一个命令行脚本，两个用法（`package-policy.js:7-36`）：

- `node package-policy.js --init-keys <内部密钥目录>`——生成 Ed25519 签名密钥对与 32 字节加密密钥，私钥留在内部不随包交付。
- `node package-policy.js <公开更新说明.json> <输出.hids-policy>`——读取当前提示词快照、打成加密签名包。

两个用法都靠环境变量定位密钥与目标环境：`HIDS_UPDATE_KEY_FILE`、`HIDS_UPDATE_PRIVATE_KEY_FILE`、`HIDS_UPDATE_TARGET`。

### 3.4 Syslog 输入（`syslog-input.js`）

不是一个独立进程，是业务 API 进程内的一个 UDP socket（`syslog-input.js:103-119`），地址取 `HIDS_SYSLOG_HOST` / `HIDS_SYSLOG_PORT`，默认 `127.0.0.1:15514`（`server.js:367-368`）。

### 3.5 缺配置时会怎样

后端不会因为配置不全而拒绝启动，而是把缺的那部分能力置空，相关路由返回 503 并写明缺什么：

| 缺什么 | 结果 | 证据 |
| --- | --- | --- |
| `CLOUDWALKER_URL` 或 `CLOUDWALKER_API_TOKEN` | `gateway`、`apiToolbox` 为 null，自动研判与深度溯源整体不启用 | `server.js:29-30`、`server.js:97` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 任一 | `model` 为 null，两个研判器均为 null | `server.js:33`、`server.js:36-37`、`server.js:305` |
| 牧云 MCP 不可用 | `agentToolbox` 为 null，深度溯源路由返回 503 | `server.js:31`、`server.js:147` |

`/api/status` 是例外：它不 503，而是返回 `{configured:false, connected:false, reason:'请设置牧云地址和 API Token'}`（`server.js:136-139`），供前端判断「是没配还是连不上」。

### 3.6 日志（`log.js`）

全后端只有一个日志落点：`log.js`。`server.js`、`triage-monitor.js`、`syslog-input.js` 都 `import { log } from './log.js'`，这三份文件里不再有自己的 `console.log`。

`log(event, fields = {}, level = 'info')` 往 stdout 写**一行一条 JSON**，键顺序固定：

```text
{"time":"2026-11-19T09:12:03.114Z","level":"info","event":"http.request","method":"GET","path":"/api/status","status":200,"duration_ms":3}
```

- `time` 是调用时刻的 ISO-8601 UTC 字符串，`level` 取 `info | warn | error`，`event` 是下表的事件名。**字段里的 `event` / `time` / `level` 覆盖不了这三个键**（`log.js:39-46`、`log.js:49-56`）。
- 能对上告警的事件带 `alert_id`：syslog 告警是 `syslog:<type>:<指纹>:<秒>:<uuid>`，牧云事件是 `<type>:<id>`（如 `honeypot:7`）。
- **脱敏（A4）**：键名命中 `authorization | cookie | token | password | secret | api_key` 的值一律写成 `[redacted]`，递归进对象与数组、4 层封顶（`log.js:9`、`log.js:24-37`）；字符串值里的 `Basic …` / `Bearer …` / `token=…` 再擦一遍（`log.js:10-12`、`log.js:17-22`）。`server.js:544-545` 只取 `req.method` 与去掉 query 的路径，请求头一个字段都不进日志。
- 字段取值抛错（getter 抛、循环引用）或写入器抛错（管道断开）都不抛给业务：前者落一条 `log.serialize_failed`，后者静默丢弃（`log.js:52-54`）。
- **单测注入缝**：`useJournal(createJournal({ write, now }))` 换成内存 journal，不碰真实 stdout 与真实时钟（`log.js:48`、`log.js:62`）。

事件名表（加事件先补这张表，再加调用）：

| 事件 | 何时写 | 关键字段 |
| --- | --- | --- |
| `server.started` | 业务 API 监听成功 | `host` `port` |
| `server.start_failed` | 自动研判 / syslog 接收器启动失败 | `what` `error` |
| `http.request` | 每个请求收尾（`res` 的 `finish` 事件） | `method` `path`（无 query）`status` `duration_ms` |
| `http.unauthorized` | Basic 认证失败（401） | `method` `path` `status` |
| `http.failed` | 路由没接住的失败（多为牧云 / 模型调用） | `method` `path` `status` `error` |
| `cloudwalker.call_failed` | 牧云调用失败 | `op` `alert_id` `error` |
| `syslog.listening` / `syslog.bind_failed` | UDP 接收器绑定成功 / 失败 | `bind` / `error` |
| `syslog.received` / `syslog.collapsed` | 收下一条 / 重复投递合并到已有记录 | `alert_id` `msgid` `event_type` `occurrence` / `alert_id` `repeat_count` |
| `syslog.parse_failed` / `syslog.skipped` | 报文解析失败 / 无对应事件类型（`reason=no_agent_for_msgid`）或队列已暂停（`reason=paused`） | `error` `bytes` / `reason` `msgid` |
| `syslog.receiver_error` / `syslog.handler_failed` / `syslog.accept_failed` | socket 错误 / 收包回调抛错 / 收包链抛错 | `error` |
| `triage.enqueued` | 进入研判队列 | `alert_id` `source`（`manual` / `retry` / `poll`） |
| `triage.done` / `triage.failed` | 研判完成 / 失败 | `alert_id` `verdict` `attempts` `duration_ms` / `alert_id` `attempts` `error` |
| `triage.persist_failed` / `triage.poll_failed` | 状态落盘失败 / 轮询失败 | `alert_id` `error` / `error` |
| `maintenance.result` | 误报维护收尾（两侧都落定） | `alert_id` `status` `rule` `wiki` `rule_error` `wiki_error` |
| `log.serialize_failed` | 日志字段序列化不出来，兜底一条 | `level=error` |

`cloudwalker.call_failed` 的 `op` 取值：`status` / `alerts` / `alert`（告警详情）/ `tools`（牧云 API 工具列表）/ `mcp_tools` / `call_tool` / `list_events`（syslog 事件匹配）。
日志只上 stdout，不落文件、不轮转；采集交给部署端（本卡不引入日志依赖）。

## 4. 模块分层与依赖

按依赖方向分成下面七组。下层不 import 上层，上层可以组装下层；「存储」是并列的另一支——它不被编排层依赖，也不依赖编排层。

| 组 | 文件 | 职责 |
| --- | --- | --- |
| 传输 | `rpc-client.js`、`mcp-client.js`、`model-client.js` | 跟牧云和模型服务说话。三者各自封装超时、错误翻译与响应校验，没有本地依赖 |
| 事件网关 | `cloudwalker.js` | 11 类事件的类型表、RPC 方法名映射、原始行到统一告警结构的归一化 |
| 取证工具 | `agent-tools.js`、`api-tools.js` | 把「一次查询」包装成模型可调用的工具，并管住可调用的工具名范围 |
| 证据投影 | `evidence-view.js` | 把工具原始返回压成带 JSON Pointer 的精简视图，控制塞进模型上下文的体积 |
| 编排 | `investigation-agent.js`、`triage-monitor.js`、`trace-board.js`、`wiki-workbench.js`、`triage-rules.js` | 各条业务流程的编排者 |
| 存储 | `investigation-store.js`、`wiki-store.js`、`prompt-store.js`、`update-store.js`、`knowledge-store.js` | 读写状态、判据、提示词、升级包、候选经验 |
| 入口 | `server.js`、`maintenance-server.js` | HTTP 路由与鉴权，把上面的件接成进程 |

**依赖方向的两个具体证据**：

- `server.js:7-22` 是唯一一处「什么都 import」的地方，它组装 `RpcClient → CloudwalkerGateway → ApiEvidenceToolbox`（`server.js:29-30`）、`CloudwalkerMcpClient → AgentToolbox`（`agent-tools.js:119-122`）、`ChatModelClient → InvestigationAgent`（`server.js:33-37`）。
- 编排层向下依赖，存储层不依赖编排层：`prompt-store.js`、`investigation-store.js`、`knowledge-store.js` 三个文件没有任何本地 import。

**两处容易看错的地方**：

- `EvidenceSession` 定义在 `agent-tools.js:54`，但牧云 API 侧的取证工具箱 `api-tools.js` 也复用它（`api-tools.js:2`、`api-tools.js:92`）。也就是说「一次取证会话」的通用部分住在 MCP 那侧的模块里，两侧工具箱共享。
- `InvestigationAgent` 的第 4 个构造参数名叫 `knowledgeStore`（`investigation-agent.js:207`），但 `server.js` 传进去的其实是 `WikiStore`（`server.js:36-37`）。智能体用它调的 `agentIndex` / `agentPage` / `agentSearch` / `publishedFor` 都是 `wiki-store.js` 上的方法（`wiki-store.js:91`、`wiki-store.js:101`、`wiki-store.js:117`、`wiki-store.js:324`）。

**另一个同名但不相干的东西**：`knowledge-store.js` 与 `knowledge-workbench.js` 是一套「候选经验整理台」，与 `wiki-store.js` / `wiki-workbench.js` 没有代码关系。全仓 grep 显示这两个文件只被测试文件引用（`investigation-agent.test.js:5-6`、`knowledge-workbench.test.js:6-7`），没有出现在 `server.js` 的 import 列表里，因此当前业务进程不会加载它们。详见 [docs/_meta/gaps.md](_meta/gaps.md)。

## 5. 两条研判路径

同一个 `InvestigationAgent` 类跑两种模式，差别在「工具池」和「结论口径」，不在代码路径——同一个 `run()` 方法用 `mode` 分支（`investigation-agent.js:214-217`）。

### 5.1 工具池不同

| | 常规研判（triage） | 深度研判（deep） |
| --- | --- | --- |
| 工具箱 | `TriageEvidenceToolbox`：牧云 API 事件工具 + 一组受控的 MCP 补证工具 | `AgentToolbox`：纯 MCP |
| 构造位置 | `server.js:32`、`server.js:36` | `server.js:31`、`server.js:37` |
| 可调工具范围 | API 侧 11 类事件的 `get_*_event` / `list_*_events` 与 `list_host_events`，加上正则限定的 8 个 MCP 工具 | `investigationToolNames` 白名单里的 47 个名字（`agent-tools.js:8-17`） |
| 工具白名单执行点 | `TriageEvidenceToolbox.callTool` 先查 API 侧，再查 MCP 侧是否命中正则，不命中直接报错（`agent-tools.js:107-114`） | `AgentToolbox.callTool` 用 `allowed` 集合拦截，不在集合里直接报错（`agent-tools.js:41-48`） |

常规研判之所以要「API + MCP」两路：牧云 API 有事件身份校验，但缺少补证工具；MCP 工具多，但本仓对 MCP 侧的可用工具集合做了更严的限制。

### 5.2 口径不同

只有常规研判才有的东西：

- **Wiki 判据目录**（`investigation-agent.js:247-256`）：加载本类与通用的 active 判据页，另给模型 `wiki_page` / `wiki_search` 两个工具。
- **必查项清单**（`investigation-agent.js:258-260`）：由 `required-evidence.js` 按告警类型生成最低取证清单并执行，缺项进 `missing_evidence`。
- **客户报告契约**（`investigation-agent.js:56`、`investigation-agent.js:357`）：额外要求模型输出 ≤300 字的 `report` 与 `recommended_actions`。
- **通用 SOP**（`investigation-agent.js:355`）与**场景 SOP**（`prompts.sop[card.id]`）。
- **规则预筛**：`server.js:117-129` 只在 `mode === 'triage'` 时先跑 `monitor.ruleEngine.evaluate`，把结果作为 `rule_evaluation` 附加到结论上。

深度研判走的是「单告警深查」提示词（`investigation-agent.js:354`），不带判据目录、不带必查项、不生成客户报告。

### 5.3 模式怎么选

请求体 `mode` 决定，默认 `deep`（`server.js:313`、`server.js:321`）。取值只允许 `deep` 与 `triage`，其他值在 `investigation-agent.js:216` 抛错。

有一个容易看漏的细节：`server.js:304` 写的是 `body.mode === 'deep' && investigator === agent ? deepInvestigator : investigator`。也就是说「切到 deep 研判器」这个动作只在请求方拿到的正是常规研判器时才发生；若调用方注入的已经是另一个实例，请求会继续用注入的那个。

### 5.4 未匹配的 syslog 走另一条路

syslog 推来的告警如果回查不到对应牧云事件，不进入上面的 `run()`，而是走 `runUnmatchedSyslog()`（`investigation-agent.js:558`）。该分支的提示词里写死了「最终结论必须是‘存疑’」（`investigation-agent.js:567`），返回的 `verdict` 也是硬编码的 `uncertain`（`investigation-agent.js:582`），并把「牧云 API 没有匹配到对应事件」列入证据缺口（`investigation-agent.js:585`）。

## 6. 证据链与结论校验

这一节是整个后端最较真的部分：模型说的每一句话都要能指回原始字段，指不回去的就不算事实。

### 6.1 一次取证产出什么

`EvidenceSession.callTool()`（`agent-tools.js:57-68`）每调一次工具就落一条记录：

- 证据编号 `cw:1`、`cw:2`……按本次任务内顺序递增（`agent-tools.js:59`）。
- 工具名、参数副本、取证时刻、原始返回、以及原始返回的 SHA-256（`agent-tools.js:63-65`）。原始返回完整保留在记录里。
- `view`：给模型看的精简视图，由 `projectEvidence()` 投影、`boundEvidenceView()` 裁剪（`evidence-view.js:155`、`evidence-view.js:234`）。裁剪只删展示行，原始返回仍可用于引用校验（`evidence-view.js:233` 注释）。

三条限额：单次任务取证调用不超过 20 次（`agent-tools.js:55`、`agent-tools.js:58`），单次工具结果不超过 200 万字符（`agent-tools.js:62`），塞进模型上下文的单条视图不超过 2 万字符，超了就只回一句错误提示、不给模型看内容（`investigation-agent.js:124-127`）。

### 6.2 引用怎么校验

模型输出的每条事实要带 `citations`，每条引用形如 `{evidence_id, pointer, value}`。`verifyClaims()`（`agent-tools.js:71-93`）逐条核对四件事：证据编号存在、pointer 是以 `/` 开头的 JSON Pointer、该 pointer 在原始返回里能解出值、解出的值与 `value` 严格相等（用 `JSON.stringify` 比较）。

源码注释说得很清楚（`agent-tools.js:70`）：机器校验只能核实「引用存在且字段值吻合」，不能替代语义判断和授权判断。换句话说，这道关卡能挡住编造的字段值，挡不住「引用正确但结论不成立」。

### 6.3 校验失败怎么降级

1. 首次不通过，退回模型重写，最多两次（`investigation-agent.js:504-519`）。
2. 仍不通过，就删掉没通过校验的事实，并把 `validation.removed_unverified_facts` 置为 true（`investigation-agent.js:520-526`）。
3. 再不行，结论降为存疑、置信度降为低、缺口里加一条「模型引用校验未通过」（`investigation-agent.js:527-531`）。

### 6.4 误报结论的额外门槛

判「误报」比判其他两态更严（`investigation-agent.js:532-541`）：需要有带引用的**正向良性事实**，并且独立复核状态为 `supported`，并且引用校验通过。门槛条数按告警类型分档——高风险类型（内存马、反弹 Shell、提权、WebShell、蜜罐，见 `investigation-agent.js:15`）要 2 条，其余要 1 条。任一条不满足，结论降为存疑。

### 6.5 独立复核

调查结束后会有一次独立的「质疑者」调用（`investigation-agent.js:449-467`）。它不继承调查过程，只看证据视图与已提交结论，检查引用是否支持事实、是否把空查询当成良性、声称合法运维时有无依据、是否忽略反证。

复核有三种结果：`supported`、`needs_revision`、`unavailable`（模型调用失败时落到 `unavailable`，见 `investigation-agent.js:454`）。处理方式：

- `needs_revision`：让模型按复核意见重出结论（`investigation-agent.js:457-466`）。
- 不是 `supported` 且告警类型属于高风险且结论本是「真实威胁」：强制降为存疑、置信度降为低（`investigation-agent.js:468-473`）。
- 蜜罐场景另有一条专门的降级：来源是 `127.` 开头回环地址、且事件时间线里没有任何响应长度时，即使判了真实威胁也会被改写成存疑，并说明回环地址不代表外部入侵（`investigation-agent.js:475-485`）。

### 6.6 必查项不是可选的

常规研判还有一层「必查项」清单（`required-evidence.js`）。清单按告警类型生成（`required-evidence.js:36-89`），例如同主机关联事件、同主机命令会话、相关来源的网络连接、同来源同类告警。每项都有 `scope` 说明（多为「当前返回页；不能代表全部历史」）和五种状态：`records_returned`、`empty_page`、`source_unavailable`、`missing_identifier`、`query_failed`（`required-evidence.js:92-129`）。

这五种状态刻意不互相混同——「查了没查到」和「没有这个数据源」和「查询失败」是三件事。空页与失败都会进 `missing_evidence`（`required-evidence.js:131-139`），并以「必查项：…」的措辞追加到客户报告尾部（`required-evidence.js:154-165`）。

## 7. 提示词与判据从哪里来

研判的「怎么判」分两处存放：**提示词**在 `prompts/`，**判据**在 `wiki/`。两者都由 `prompt-store.js` 与 `wiki-store.js` 装载。

### 7.1 提示词

`prompts/` 下有 6 个核心提示词文件（清单见 `prompt-store.js:18`）：`triage.md`、`deep-investigation.md`、`trace-board.md`、`knowledge-maintenance.md`、`knowledge-reuse.md`、`cross-scenario.md`。另有 `scenarios.json`，当前 13 张场景卡（`prompts/scenarios.json`），版本号 `merged-three-state-2026-11-06`。

SOP 分两类：`prompts/sop/common.md` 和 `prompts/sop/command_whitelist.md` 是仓库内文件；其余 12 个场景的 SOP 实际来自 `wiki/` 下的判据页，映射表在 `prompt-store.js:10-16`（例如 `webshell` → `webshell/WS-13.md`）。

`PromptStore.load()`（`prompt-store.js:33-48`）把这三块拼起来，并叠加 `.data/prompt-overrides.json` 里的本地覆盖（`prompt-store.js:17`、`prompt-store.js:38-44`）。拼完算出一个 `revision`：对 `prompts + scenarios + sop + release` 做 SHA-256 取前 16 位（`prompt-store.js:21-23`、`prompt-store.js:45`）。这个 revision 是整套提示词的版本指纹，写进每份研判记录的 `prompt_version`（形如 `版本号+revision+系统提示摘要`，见 `investigation-agent.js:551`）。

可改的地方与限制：

- `metadata()` 把章节按 `core` / `scenario` / `sop` 三类列出，SOP 一律标 `read_only: true`（`prompt-store.js:88-98`）。
- `update()` 只接受核心章节与场景卡，不接受 SOP（`prompt-store.js:100-117`）。
- `install()` 是升级包整包替换：要求传入的 `expectedRevision` 与当前一致、知识库版本兼容、章节数量与正文格式都对得上，并且发布序号必须大于当前（否则报「不允许重复应用或降级到旧版本」）（`prompt-store.js:61-86`）。

### 7.2 判据库

`wiki/` 是一个 Markdown 判据库，目录约定 16 个（`wiki-store.js:9-11`）：`common`、`webshell`、`memwebshell`、`rasp`、`revshell`、`suspicious-command`、`cmdaudit`、`malware`、`bruteforce`、`honeypot`、`elevation`、`abnormal-login`、`net`、`customer-experience`、`_evidence`、`concepts`。页面的写法与审核要求写在 `wiki/_schema.md`。

研判智能体读判据时只拿 `status: active` 且位于 `common/` 或本类目录的页面（`wiki-store.js:91-99`）。事件类型到目录的映射在 `wiki-store.js:12-17`。入口页 `wiki/index.md` 列出当前生效的判定页与首要问题。

判据页的硬性要求（`wiki-store.js:152-179`、`wiki-store.js:181-224`）：

- 路径必须是判据页或客户经验页（`pagePattern`，`wiki-store.js:8`）。
- 修订时 `id` 不得变，状态只能是 `active` / `draft` / `deprecated`（`wiki-store.js:160-161`）。
- 正文里必须有 `evidence:` 或 `source:` 之一，否则拒绝（`wiki-store.js:162-163`）。
- 发布前检查会核编号重复、编号与路径不符、缺 `title` / `applies_to` / `status` / `updated`、引用了不存在的判据或证据页、退役缺 `deprecated_reason`（`wiki-store.js:181-224`）。
- 每次修订前把上一版存进 `<wiki 目录的父目录>/.data/wiki-history/`（`wiki-store.js:164-167`），并在 `wiki/log.md` 追加一条记录（`wiki-store.js:173-174`）。

`health()`（`wiki-store.js:129-151`）是给运维看的一致性体检：重复编号、缺来源、失效引用、缺证据页各报一条。

### 7.3 客户经验

`customer-experience/EX-*.md` 是另一类页面，正文里嵌一段 JSON 记录这条经验的适用条件与人工复核结论。`publishedFor()`（`wiki-store.js:324-335`）只返回 `status: active`、场景匹配、且复核期限未过的经验。

常规研判在取证后会尝试复用这些经验：让模型在候选中挑一条，并逐项核对适用条件；核对不通过或证据不足就继续完整研判（`investigation-agent.js:266-345`）。命中时结论直接复用该经验的历史判定，并附一条「若出现经验的失效条件，撤回经验并重新研判」的建议（`investigation-agent.js:323-337`）。

### 7.4 维护工作台的四步

`WikiWorkbench`（`wiki-workbench.js`）把「改判据」变成一条有审核的流水线：

1. `create()`（`wiki-workbench.js:94`）开一个会话。可以从一条已完成的案件反馈开始，此时会把案件目录里的原始告警与研判事实读进来做快照（`wiki-workbench.js:102-112`）。
2. `reply()`（`wiki-workbench.js:135`）逐轮对话，模型只产出**草案**，不写库。会话消息上限 80 条（`wiki-workbench.js:142`）。
3. `replay()`（`wiki-workbench.js:249`）回放：拿冻结的案件材料，分别配旧判据和草案判据各跑一遍，比较结论变化（`wiki-replay.js:79-116`）。回放状态有 `passed`、`no_cases`、`needs_review` 三种。
4. `publish()`（`wiki-workbench.js:265`）人工审核后发布。发布前必须先回放，且草案哈希与提示词版本都要与回放时一致（`wiki-workbench.js:294-298`）；`needs_review` 时必须写至少 20 字的人工复核理由（`wiki-workbench.js:300-302`）。

新建客户经验还要多一道：发布时要选定三态结论、未来一年内的复核截止日，并填至少 5 字审核说明（`wiki-workbench.js:271-279`）。

## 8. 状态落盘：数据都写在哪

### 8.1 运行态目录的解析规则

`server.js:26` 拿到本文件所在目录，`server.js:27` 用它算出模块级常量 `runtime`；具体路径清单由导出的 `runtimePaths(directory = moduleDirectory)`（`server.js:805-818`）给出：

```js
const data = path.join(directory, '.data');
```

`server.js` 里定义的运行态路径一律取自 `runtime.*`（`server.js:41-54`、`server.js:96`），**不再经过仓库的上一级**。也就是说，运行态数据落在仓库内的 `.data/`（被 `.gitignore:10` 忽略，不进 git），在本工作树里解析到：

```
/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T019/.data/
```

P003-T019 之前的版本把这里算成「本文件所在目录的上一级」+ `backend/.data/`，即落到仓库外（工作树是 `.../hids-ai-console/hids-ai-console/backend/.data/`，主仓是 `/home/trtyr/code/backend/.data/`）。**那些旧目录下的数据不自动搬**：进程不会读也不会写它们，要接着用里面的研判记录/基线得人工搬进仓内 `.data/`。

仓内 `.data/` 同一目录下还住着提示词覆盖文件与升级包（`prompt-store.js:17`、`update-store.js:62`），判据页历史版本在 `<wiki 目录的上一级>/.data/wiki-history/`（`wiki-store.js:164`）。

### 8.2 目录与文件清单

下表路径均相对于仓库内的 `.data/`（第 8.1 节）。默认值由 `runtimePaths()`（`server.js:805-818`）给出，`server.js:41-54`、`server.js:96` 把这些默认值交给各构件。

| 路径 | 存什么 | 谁写 | 证据 |
| --- | --- | --- | --- |
| `.data/investigations/` | 研判记录，同一告警同一模式只留最近一次 | `InvestigationStore` | `server.js:41` |
| `.data/triage-rules.json` | 误报规则集 | `TriageRuleEngine` | `server.js:42` |
| `.data/triage-monitor.json` | 自动研判的游标、队列、去重表、会话窗口 | `TriageMonitor.persist()` | `server.js:47`、`triage-monitor.js:69-71` |
| `.data/cases/` | syslog 案件目录（`HIDS_CASES_DIR` 可换掉） | `writeSyslogCase()` | `server.js:51`、`syslog-case.js:64-87` |
| `.data/baseline.json` | 基线（白名单命令、授权运维、已知来源国家等） | 人工维护，研判时读取 | `server.js:52`、`triage-monitor.js:282` |
| `.data/intel.json` | 按 IP 的情报缓存 | 人工维护，研判时读取 | `server.js:53`、`triage-monitor.js:284` |
| `.data/wiki-sessions/` | 知识库维护会话 | `WikiWorkbench` | `server.js:54` |
| `.data/trace-boards/` | 深度溯源白板 | `TraceBoardService` | `server.js:96` |
| `.data/prompt-overrides.json` | 提示词与 SOP 的本地覆盖 | `PromptStore` | `prompt-store.js:17` |
| `<提示词覆盖文件所在目录>/update-packages/` | 已上传的升级包 | `UpdateStore` | `update-store.js:62` |
| `<wiki 目录的上一级>/.data/wiki-history/` | 判据页历史版本 | `WikiStore` | `wiki-store.js:164` |

`.gitignore` 里还忽略了 `*.hids-policy`（`.gitignore:9`）与 `*.pem`、`*.key`（`.gitignore:7-8`），即签名私钥与加密密钥不进仓。

### 8.3 案件目录长什么样

syslog 触发的告警会落一个目录，路径形如 `<cases>/<msgid>/<时间戳>-<摘要>-<随机后缀>/`（`syslog-case.js:66-70`）。目录里先是研判材料：

| 文件 | 内容 | 证据 |
| --- | --- | --- |
| `00-这是什么.md` | 入口，说明先看哪份文件 | `syslog-case.js:74` |
| `01-原始告警.txt` | syslog 原始报文 | `syslog-case.js:75` |
| `02-告警字段.md` | 字段表 | `syslog-case.js:76` |
| `03-研判事实.md` | 主机、时间、来源、命令、牧云匹配情况与 API 补充事件 | `syslog-case.js:77` |
| `04-上下文.md` | 同会话时间窗、基线、情报、历史结论 | `syslog-case.js:78` |
| `03b-判据索引.md` | 本次可用判据编号（传入 wiki 时才有） | `syslog-case.js:80-83` |

研判结束后追加 `05-研判结果.md` 与 `result.json`（`syslog-case.js:112`）。模型在常规研判里可以用 `read_case_file` 工具读这些文件，但文件内容被当作**数据**而不是指令（工具描述写在 `investigation-agent.js:101-103`）。

### 8.4 写入习惯

- 目录权限 `0o700`、文件权限 `0o600`（如 `investigation-store.js:19-20`）。
- 落盘走「临时文件 + rename」原子替换，临时名带 UUID 且用 `flag: 'wx'` 防止覆盖（`investigation-store.js:18-21`、`prompt-store.js:80-81`、`triage-monitor.js:75-77`）。
- 研判记录的文件名是 `sha256(mode + ':' + alert_id)` 的十六进制，不把外部告警 ID 直接写进文件名（`investigation-store.js:9-12`）。

## 9. 访问控制边界

这套后端的访问边界按由外到内分几道，越往里越窄。

### 9.1 业务 API 的 Basic 认证

`server.js:58-65` 的 `hasAccess()` 逻辑是：**只有当 `HIDS_BASIC_AUTH_PASSWORD` 配了时才校验**；没配密码就放行（`server.js:59` 直接 `return true`）。校验时把请求头里的 Base64 解出来，与 `user:password` 做 `timingSafeEqual`（长度不等直接判否）。失败时返回纯文本 401「需要登录后访问」，并带 `WWW-Authenticate` 头（`server.js:66-70`）。

默认监听 `127.0.0.1`（`server.js:25`），所以在默认配置下接口只在回环地址可达；开认证是给「前端反向代理到后端」这种部署形态用的。

### 9.2 管理员令牌

两种令牌，只管各自范围内的写操作，请求头分别是 `x-prompt-admin-token`（知识库，`server.js:71-77`）与 `x-rule-admin-token`（规则，`server.js:79-85`），都用 `timingSafeEqual` 比较。

- 知识库：读接口（`/api/wiki/pages`、`/api/wiki/pages/{path}`）对已通过 Basic 认证的调用方开放；健康检查、维护会话、发布等写操作要求管理员令牌（`server.js:248-249`）。令牌没配置时写接口返回 503。
- 规则：`GET /api/triage/rules` 开放，并在响应里带 `writable` 字段说明当前能不能写（`server.js:181-187`）；`PUT /api/triage/rules` 要求规则管理员令牌，并要求请求带上 `expected_revision` 做乐观并发控制（`server.js:193-202`）。

提示词上传在业务端被明确关闭：`POST /api/agent/prompts/upload` 返回 410「提示词更新已迁移到独立维护端，业务端不允许上传」（`server.js:233`）。

### 9.3 牧云侧的只读约束

- RPC 方法走白名单：只有匹配 `^[A-Za-z]+(?:Event)?Service\.(GetEventList|GetEvent|List)$` 的方法名能发出去，其余一律抛错（`rpc-client.js:14`）。注释写明这是为了「避免通过本控制台调用处置或加白接口」（`rpc-client.js:13`）。
- MCP 工具走白名单：`investigationToolNames` 列出可交给研判智能体的工具名（`agent-tools.js:8-17`），`AgentToolbox.callTool` 对不在名单里的名字直接拒绝（`agent-tools.js:42`）。常规研判的 MCP 侧另有一层更窄的正则（`agent-tools.js:104`、`agent-tools.js:111`）。
- 牧云 Token 只留在后端进程内，不下发浏览器、也不进模型上下文（`mcp-client.js:1-2`）。

### 9.4 维护 API 的边界

维护端是独立进程，边界比业务端严（`maintenance-server.js`）：

- 只接受回环来源，非回环直接 403（`maintenance-server.js:55`）；预览模式还要求监听地址本身也是回环（`maintenance-server.js:56`）。
- 写操作要带 `x-hids-maintenance: 1` 头，`Sec-Fetch-Site` 只能是 `same-origin` 或 `none`，`Origin` 头存在时必须与 `Host` 同源（`maintenance-server.js:28-39`、`maintenance-server.js:67`）。
- 登录失败计数：同一来源 60 秒内失败 10 次就锁 1 分钟（`maintenance-server.js:45-49`、`maintenance-server.js:74`）。
- 会话是 8 小时的 HttpOnly + SameSite=Strict Cookie，同时最多保留 100 个（`maintenance-server.js:12-13`、`maintenance-server.js:65`、`maintenance-server.js:87`）。
- 账号角色分 `updater` 与 `viewer`；只有 `updater` 能上传与替换（`maintenance-server.js:107-108`、`maintenance-server.js:148-149`）。非预览模式下 `HIDS_MAINTENANCE_USER` 与 `HIDS_MAINTENANCE_PASSWORD` 必须都配（`maintenance-server.js:146-147`）。

### 9.5 升级包的密码学边界

`.hids-policy` 包是「AES-256-GCM 加密 + Ed25519 签名」的双层信封（`update-store.js:28-40`）：

- 加密密钥必须 32 字节（`update-store.js:29`、`maintenance-server.js:154`）。
- 签名私钥必须是 Ed25519（`package-policy.js:30`），验签公钥同样要求 Ed25519（`maintenance-server.js:158`）。
- 包大小上限 2 MB（`update-store.js:5`、`update-store.js:42`）。
- 包的 `target` 必须与本环境的 `HIDS_UPDATE_TARGET` 一致（`update-store.js:75`）。
- 发布序号必须大于当前已装序号，且同一个版本号不能重复应用（`update-store.js:95-97`）。

### 9.6 本系统不下指令

整条链路上没有「隔离」「封禁」「加白」的执行动作。研判记录里的 `auto_action: false`（`investigation-agent.js:555`）就是这个意思；规则命中也只是「交由 AI 复核」的候选（`server.js:122`、`triage-monitor.js:344`）。

## 10. 配置项速查

全部环境变量及其读取位置（只列非测试代码里出现的）：

### 10.1 业务 API

| 变量 | 缺省 | 作用 | 读取位置 |
| --- | --- | --- | --- |
| `HIDS_HOST` | `127.0.0.1` | 业务 API 监听地址 | `server.js:25` |
| `HIDS_PORT` | `8080` | 业务 API 监听端口 | `server.js:26` |
| `CLOUDWALKER_URL` | 无 | 牧云地址，同时用于 RPC 与 MCP | `server.js:27`、`server.js:29`、`agent-tools.js:120` |
| `CLOUDWALKER_API_TOKEN` | 无 | 牧云 Token；少于 6 位会被拒 | `server.js:28`、`rpc-client.js:5`、`mcp-client.js:6` |
| `LLM_BASE_URL` | 无 | 模型服务地址 | `model-client.js:3` |
| `LLM_API_KEY` | 无 | 模型服务密钥 | `model-client.js:4` |
| `LLM_MODEL` | 无 | 模型名 | `model-client.js:5` |
| `LLM_TIMEOUT_MS` | `90000` | 单次模型请求超时（毫秒） | `model-client.js:36` |
| `HIDS_TRIAGE_INPUT_MODE` | `syslog` | 自动研判输入方式：`syslog` 或 `poll` | `server.js:40` |
| `HIDS_SYSLOG_HOST` | `127.0.0.1` | syslog UDP 监听地址 | `server.js:367` |
| `HIDS_SYSLOG_PORT` | `15514` | syslog UDP 监听端口 | `server.js:368` |
| `HIDS_SYSLOG_TIME_OFFSET_MINUTES` | `0` | 牧云事件时间（无时区）相对 UTC 的偏移分钟数 | `syslog-input.js:61` |
| `HIDS_CASES_DIR` | 仓内 `.data/cases`（`runtimePaths().cases`） | 案件目录根 | `server.js:51` |
| `HIDS_BASIC_AUTH_USER` | 无 | Basic 认证用户名 | `server.js:113` |
| `HIDS_BASIC_AUTH_PASSWORD` | 无 | Basic 认证密码；不配则不启用认证 | `server.js:113`、`server.js:59` |
| `HIDS_PROMPT_ADMIN_TOKEN` | 无 | 知识库写操作令牌（请求头 `x-prompt-admin-token`） | `server.js:114` |
| `HIDS_RULE_ADMIN_TOKEN` | 无 | 规则写操作令牌（请求头 `x-rule-admin-token`） | `server.js:116` |
| `HIDS_WIKI_DIR` | 仓内 `wiki/` | 判据库目录 | `wiki-store.js:6`、`prompt-store.js:9` |
| `HIDS_PROMPT_STORE_FILE` | 仓内 `.data/prompt-overrides.json` | 提示词覆盖文件 | `prompt-store.js:17` |
| `HIDS_MAINTENANCE_ENTRY_URL` | 无 | 被读进 `createServer` 的参数，但路由里没有任何地方使用它 | `server.js:115` |

### 10.2 维护 API 与策略包

| 变量 | 缺省 | 作用 | 读取位置 |
| --- | --- | --- | --- |
| `HIDS_MAINTENANCE_USER` | 无 | 维护账号；非预览模式下必填 | `maintenance-server.js:146` |
| `HIDS_MAINTENANCE_PASSWORD` | 无 | 维护密码；非预览模式下必填 | `maintenance-server.js:146` |
| `HIDS_MAINTENANCE_ROLE` | `updater` | 账号角色，只能是 `updater` 或 `viewer` | `maintenance-server.js:148-149` |
| `HIDS_MAINTENANCE_PORT` | `18081` | 维护 API 端口（监听地址写死回环） | `maintenance-server.js:167` |
| `HIDS_UPDATE_KEY_FILE` | 无 | 32 字节对称加密密钥文件 | `maintenance-server.js:152`、`package-policy.js:21` |
| `HIDS_UPDATE_PUBLIC_KEY_FILE` | 无 | Ed25519 验签公钥 | `maintenance-server.js:156` |
| `HIDS_UPDATE_PRIVATE_KEY_FILE` | 无 | Ed25519 签名私钥（只在制作包时用） | `package-policy.js:21` |
| `HIDS_UPDATE_STORE_DIR` | `<提示词覆盖目录>/update-packages` | 已上传升级包的存放目录 | `maintenance-server.js:160`、`update-store.js:62` |
| `HIDS_UPDATE_TARGET` | 无 | 目标环境标识，包与环境的匹配依据 | `maintenance-server.js:160`、`package-policy.js:21` |

`.env.example` 只列了业务侧的一部分变量（14 个），维护与升级相关的变量不在其中，需要按 `openapi.yaml` 与本表自行补齐。

## 11. 怎么验证

### 11.1 跑测试

```bash
npm test                # 等价于 node --test（package.json:8）
node --test triage-rules.test.js   # 只跑一个文件
```

需要 Node.js 20 及以上（`package.json:10`）。本机实测环境为 Node v26.13.0。

仓里有 18 个测试文件，覆盖情况：

| 测试文件 | 主要覆盖 |
| --- | --- |
| `agent-api.test.js` | 业务 HTTP 路由、研判记录存储、提示词存储 |
| `integration.test.js` | RPC 客户端 + 事件网关 + 业务路由的串联 |
| `agent-tools.test.js` | MCP 客户端、两个取证工具箱、工具白名单 |
| `api-tools.test.js` | 牧云 API 取证工具箱与参数校验 |
| `evidence-view.test.js` | 证据投影与上下文裁剪 |
| `investigation-agent.test.js` | 研判智能体、工具参数收窄、候选经验整理台 |
| `knowledge-workbench.test.js` | 候选经验整理台与业务路由的接线 |
| `maintenance-auth.test.js` | 维护端认证、限速、角色与升级包存取 |
| `maintenance-startup.test.js` | 维护端在符号链接路径下的启动 |
| `required-evidence.test.js` | 必查项清单的生成与状态机 |
| `syslog-pipeline.test.js` | syslog 解析、事件匹配、自动研判流水线 |
| `trace-board.test.js` | 深度溯源白板 |
| `triage-monitor.test.js` | 自动研判队列、持久化、去重 |
| `triage-output.test.js` | 客户报告的长度与一致性修正 |
| `triage-rules.test.js` | 规则集校验、规则引擎、路由 |
| `update-store.test.js` | 升级包加解密、签名、版本序列 |
| `wiki-current.test.js` | 当前生效判据与提示词是否一致（只读） |
| `wiki.test.js` | 判据库读写、维护会话、发布与回放 |

**本卡实测结果**（命令：`node --test *.test.js`，21 个后端测试文件 198 条，输出中 1 条失败）：

```
ℹ tests 198
ℹ pass 197
ℹ fail 1
```

唯一失败的仍是 `maintenance-startup.test.js`。原因是它自己把部署路径写死成 `<当前目录的上一级>/backend/maintenance-server.js`（`maintenance-startup.test.js:12-14`）。
**这条与第 8.1 节的运行态目录已经是两回事了**：P003-T019 把运行态位置改回仓库内 `.data/`（`server.js:27`），但那个测试仍然按「仓库名为 `backend`」的老布局拼路径，所以本仓目录名下依旧 `Cannot find module '.../current/backend/maintenance-server.js'`。改前改后同样红，已记入 [docs/_meta/gaps.md](_meta/gaps.md)。

### 11.2 手工冒烟

不配任何凭据启动业务 API，有一批只读接口仍能给出稳定结果。**本卡实测**（命令 `HIDS_PORT=18099 node server.js`，另起端口是因为本机 8080 已被别的进程占用）：

```bash
$ for p in /api/session /api/status /api/agent/status /api/updates /api/agent/prompts /api/triage/rules "/api/wiki/pages?q=HP" /api/alerts /api/agent/triage/status; do
    curl -s -o /tmp/body.json -w "%{http_code} " "http://127.0.0.1:18099$p"; head -c 120 /tmp/body.json; echo
  done
/api/session             200 {"authenticated":true}
/api/status              200 {"configured":false,"connected":false,"reason":"请设置牧云地址和 API Token"}
/api/agent/status        200 {"configured":false,"model":null,"missing":["LLM_BASE_URL","LLM_API_KEY","LLM_MODEL"],"prompt_version":"merged-three-state-2026-11-06+deabe4abb842db81"}
/api/updates             200 {"revision":"deabe4abb842db81","current":{"version":"merged-three-state-2026-11-06",...
/api/agent/prompts       200 {"version":"merged-three-state-2026-11-06","revision":"deabe4abb842db81","sections":[{"id":"triage",...
/api/triage/rules        200 {"config":{"schema_version":1,"enabled":false,"rules":[{"id":"approved-network-egress-001",...
/api/wiki/pages?q=HP     200 {"pages":[{"path":"honeypot/HP-01.md","id":"HP-01","title":"ENISA《Honeypots study》...
/api/alerts              503 {"error":"未配置 CLOUDWALKER_URL 和 CLOUDWALKER_API_TOKEN"}
/api/agent/triage/status 503 {"error":"自动研判尚未配置"}
```

即：**读本地状态与本地文件的接口**（会话、状态、提示词、升级包概览、规则集、判据目录）不依赖牧云与模型，返回 200；
**需要牧云或模型才能工作的接口**（告警列表、自动研判状态）返回 503，并写明缺什么。

`/api/status` 不返回 503，而是用 `configured` 与 `connected` 两个字段区分「没配」和「连不上」（`server.js:136-139`）。`/api/agent/status` 同理，会列出缺哪个环境变量（`server.js:141-144`）。

启动日志是一行 JSON：`{"time":…,"event":"server.started","host":…,"port":…}`（见 3.6）。`HIDS_TRIAGE_INPUT_MODE` 为 `syslog` 时还会多一行 `syslog.listening`（`bind` 形如 `udp://…`）或 `syslog.bind_failed`（`error` 写明端口被占 / 权限不足）；未配牧云时这两行都不出现，因为自动研判器整个不启用。

### 11.3 接口契约

`openapi.yaml` 是对外 HTTP 契约，声明为 OpenAPI 3.1（`openapi.yaml:1`），头部注明它「依据 backend/server.js 和 backend/maintenance-server.js 的实际路由整理」（`openapi.yaml:6`）。它列了 35 条路径。**它与 `server.js` 是两套独立维护的真源**：改路由时两边都要动。

## 12. 模块清单

下表与 [docs/modules/_breakdown.json](modules/_breakdown.json) 一一对应。14 个模块页都已写完，覆盖构件的用词与清单里的 `components` 相同。清单里的 `files` 已逐个验过存在。

| 模块 | 页面 | 实现文件 | 覆盖构件 | 职责一句话 |
| --- | --- | --- | --- | --- |
| `http-api` | [modules/http-api.md](modules/http-api.md) | `server.js` | 路由分发、Basic 认证、管理员令牌校验、SSE 流式响应、分页参数校验 | 业务 HTTP 接口的唯一入口，把编排层的能力包成路由 |
| `event-gateway` | [modules/event-gateway.md](modules/event-gateway.md) | `cloudwalker.js`、`rpc-client.js` | 事件类型表、RPC 方法映射、只读 RPC 白名单、事件归一化、多类型合并分页 | 读牧云事件列表与详情，并把不同类型的原始行归一成同一形状 |
| `evidence-tools` | [modules/evidence-tools.md](modules/evidence-tools.md) | `mcp-client.js`、`agent-tools.js`、`api-tools.js` | MCP 客户端、API 取证工具箱、MCP 取证工具箱、常规研判工具箱、取证会话、工具白名单 | 把「一次取证」包装成模型可调用的工具，并限制可调范围 |
| `model-client` | [modules/model-client.md](modules/model-client.md) | `model-client.js` | 对话补全、工具调用请求、超时与错误翻译、环境变量装配 | 与模型服务对话的唯一通道 |
| `evidence-view` | [modules/evidence-view.md](modules/evidence-view.md) | `evidence-view.js` | 字段投影、JSON Pointer、预聚合计数、上下文裁剪 | 把工具原始返回压成模型看得懂、引用得了的精简视图 |
| `investigation-agent` | [modules/investigation-agent.md](modules/investigation-agent.md) | `investigation-agent.js`、`required-evidence.js`、`triage-output.js` | 三态结论映射、工具轮次与调用上限、独立复核、引用校验与降级、必查项清单、客户报告整形 | 研判的决策内核：取证、质疑、校验、降级、出报告 |
| `triage-pipeline` | [modules/triage-pipeline.md](modules/triage-pipeline.md) | `triage-monitor.js`、`syslog-input.js`、`syslog-case.js` | syslog 接收与解析、指纹去重、队列与游标、案件目录、结果写回 | 把告警变成一条排队中的研判任务，并落好案件材料 |
| `triage-rules` | [modules/triage-rules.md](modules/triage-rules.md) | `triage-rules.js` | 规则集校验、字段取值映射、规则评估、乐观并发保存 | 已审核的误报规则，作为候选交给 AI 复核 |
| `knowledge-base` | [modules/knowledge-base.md](modules/knowledge-base.md) | `wiki-store.js`、`wiki-workbench.js`、`wiki-replay.js` | 判据页读写、发布前检查、维护会话、发布前回放、客户经验发布 | 判据库的存储与「会话→草案→回放→人工发布」流水线 |
| `trace-board` | [modules/trace-board.md](modules/trace-board.md) | `trace-board.js` | 白板节点与边、节点调查、自主追查循环、白板持久化 | 从一条告警或一个 IP 出发，追出关联资产与事件 |
| `prompt-store` | [modules/prompt-store.md](modules/prompt-store.md) | `prompt-store.js` | 提示词装载、本地覆盖、版本指纹、整包安装 | 决定本次研判用哪一套提示词与 SOP |
| `maintenance-service` | [modules/maintenance-service.md](modules/maintenance-service.md) | `maintenance-server.js`、`update-store.js`、`package-policy.js` | 维护端认证与角色、跨站写请求校验、升级包信封、密钥生成、策略包制作 | 独立维护端与升级包链路 |
| `record-store` | [modules/record-store.md](modules/record-store.md) | `investigation-store.js` | 研判记录存取、文件名散列、原子写入 | 按「告警 + 模式」保存最近一次研判结果 |
| `experience-draft` | [modules/experience-draft.md](modules/experience-draft.md) | `knowledge-store.js`、`knowledge-workbench.js` | 九项经验字段、逐项追问、审核发布、撤回 | 候选经验的整理台；当前只被测试引用，未接入业务 API（第 4 节末） |

模块名与 `docs/modules/` 下的文件名一一对应，拆分依据是「谁拥有这份状态、谁定义这份契约」，不是按目录或按行数切。

## 13. 已知边界与未决

写这份文档时碰到的几处「读代码读不出来的东西」，全部记在 [docs/_meta/gaps.md](_meta/gaps.md)。这里只列个引子：

1. **`maintenance-startup.test.js` 按老布局写死路径**。它拼 `<当前目录的上一级>/backend/maintenance-server.js`（`maintenance-startup.test.js:12-14`），本仓目录名不是 `backend`，所以它是 `node --test` 里唯一的失败项（第 11.1 节）。P003-T019 已把运行态目录改回仓库内 `.data/`（第 8.1 节），这条测试自身还没跟着改。
2. **候选经验整理台未接线**。`knowledge-store.js` 与 `knowledge-workbench.js` 只被测试文件引用（第 4 节末）。
3. **`createServer` 有两个没被路由使用的参数**：`maintenanceEntry`（`server.js:115`）与 `knowledge`（`server.js:112`）。
4. **接口契约有两套真源**：`openapi.yaml` 与 `server.js` 的路由各自独立（第 11.3 节）。

本页只描述现状。哪一处该改、改成什么样，是评审的活，不在本页范围内。
