# P003-T022 测试报告：模型没交卷时留下它回了什么

测试席 何东阳。工作树 `/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T022`，
HEAD `6699f59`（代码在 `462010c`），起活 `f3a03ab`。`git diff f3a03ab..HEAD --stat` 只动 scope 内 6 文件。
本页只写自己终端里跑出来的东西；写者与审查贴过的输出一律不当证据，全部重跑。

## 一、回归（先跑既有套件）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test investigation-agent.test.js` | 0 | 25/25 |
| `node --test triage-monitor.test.js` | 0 | 15/15 |
| `node --test integration.test.js` | 0 | 21/21 |
| `node --test agent-api.test.js` | 0 | 22/22 |
| `node --test --test-reporter=tap *.test.js` | 1 | 196 条 / 195 过 / 1 红 = `maintenance CLI starts when the deployment current path is a symlink`（基线：本卡 diff 不含 `maintenance-*`；P003-T018 报告 §六 已记同一条，报错是 `Cannot find module .../current/backend/maintenance-server.js`，环境侧符号链接解析问题） |

全量 `node --test`（含 `web/**`、`evidence/**`）未跑：群主派活明确写了这棵树里全量时长不稳、红全在 `web/**` 与 `evidence/**` 基线，别在本卡耗。上表最后一行是后端线全部 `*.test.js`，本卡碰的文件全在里面。

## 二、文档命令复跑（`docs/modules/investigation-agent.md` §5.6）

```bash
node --test investigation-agent.test.js 2>&1 | grep -E "A1 |A2 |A3 |model-client"
```

实测 10 行 `✔`、退出码 0，逐行与 §5.6 承诺的 10 条对得上（T012 四条 + 本卡 A1×3 / A2 / A3 / model-client）。

§5.6 手工片段（假 model，不碰网络）实跑：

```text
127 模型未在调查轮数内给出有效 JSON 结论（调查 6 轮、已查询 0 项证据后仍没有可用结论；末次回包 18 字：「我先梳理一下这条告警：需要核对授权。」；退回 6 次：输出解析失败：Unexpected token '我', "我先梳理一下这条告警…）
```

127 字、开头结尾与 §5.6 预期一致。

§3.2.1 里那段「实测（假 model 每轮都只回散文，告警 `suspicious_operation:7`）」按原文回包重放（50 字、假 model、6 轮），
得到 159 字消息，与文档示例逐字相同（`末次回包 50 字：…；退回 6 次：输出解析失败：Unexpected token '我', "我先梳理一下这条告警…`）。

## 三、端到端验收（测试席自写脚本，`evidence/test/P003-T022/acceptance.e2e.mjs`）

```bash
node evidence/test/P003-T022/acceptance.e2e.mjs
```

退出码 0，18 条断言全绿。全部用假 model / 假 fetcher / 真 `TriageMonitor` + 真 `InvestigationAgent` + 真 `InvestigationStore`，
不碰网络，全部落 `/tmp` 临时目录。断言内容：

| 组 | 断言 |
| --- | --- |
| A1 形态一 | `status=failed`、`stage=研判失败`；detail 四段齐全（`调查 6 轮、已查询 0 项证据后仍没有可用结论` / `末次回包 25 字：「…` / `退回 6 次：输出解析失败：`）；`[...detail].length <= 250` |
| A1 形态二 | 真 `ChatModelClient` + 假 fetcher 回 `choices[0].message` 正文 0 字 → `error.reply_excerpt` 描述回包形状、不含 apiKey；队列 detail 含 `模型调用失败（第 1 轮、已查询 0 项证据）：…（调用报错：模型没有返回可用消息）`、不含 `Bearer` |
| A1 形态二（表二） | 有 `choices[0]` 没 `message` → `回包没有 choices[0].message（finish_reason=stop，keys=choices）` |
| A1 形态三 | 有知识库但没查、前五轮 `submit_conclusion` 被拒、末轮只发文本 → detail 含 `退回 6 次：结论被退回：…没有调用知识库工具…→ 输出解析失败：`、`末次回包 6 字：「结论：存疑。」` |
| A2 | 失败后 `active=0`、`counts={queued:0,running:0,done:0,failed:1}`；`enqueue(...,{retry:true})` → `done`、`attempts=2`、`verdict=uncertain`、`summary=重跑得到的结论` |
| A3 | 失败前盘上无记录（`latest()` 为 null）；预存一条记录后失败 → 目录文件集合不变、`latest()` 与预存对象 `deepStrictEqual`；重跑成功后才落盘 |
| 边界 | 正文空但点了工具 → `末次回包没有正文；末次工具调用：get_honeypot_event`；5000 字散文 → 消息 162 字 ≤240、带 `末次回包 5000 字` 与 `…」；退回 6 次：`；emoji 回包 → 四段仍齐、detail ≤250；正常长度消息 detail 与 `error.message` 完全一致 |
| model-client 正常面 | 正文只有空格算可用消息，不抛错（文档 §3.2.1 承诺） |

## 四、反向验证（先证后报，自己复现）

```bash
git checkout f3a03ab -- investigation-agent.js model-client.js   # 回到基线实现
node --test investigation-agent.test.js        # 退出码 1：25 条 / 20 过 / 5 红
node evidence/test/P003-T022/acceptance.e2e.mjs # 退出码 1：18 条 / 11 过 / 7 红
git checkout HEAD -- investigation-agent.js model-client.js      # 还原
node --test investigation-agent.test.js        # 退出码 0：25/25
node evidence/test/P003-T022/acceptance.e2e.mjs # 退出码 0：18/18
```

变异下红的正好是变更点：A1×3、A2（同实例重跑）、model-client 摘要 5 条单测；我的 e2e 红 7 条（A1 三形态 + model-client 两条 + 正文空/5000 字/emoji 三条边界）。
A3 单测与 e2e 的 A3 断言在基线实现下照绿——它钉的是「失败不许写记录」，属于回归守卫，这一点写者报告也认了，不是漏测。

还原后 `git status --short` 与开工时一致（只有开工前就在的 `evidence/test/P003-T007/shots/1440-a5-sidebar.png` 修改与 `.pi-child-claim.json`），
产品文件既无修改也无残留。

## 五、验收对账

| 验收 | 判定 | 证据 |
| --- | --- | --- |
| A1 三种失败形态的回包摘要落进 250 字 detail | 满足 | `cmd:node evidence/test/P003-T022/acceptance.e2e.mjs`（18/18，exit 0）；§3.2.1 样例重放 159 字逐字符 |
| A2 失败后 active=0 / counts.failed=1，enqueue retry → done / attempts=2 | 满足 | 同上脚本 A2 组；`cmd:node --test triage-monitor.test.js` 15/15 |
| A3 失败不覆盖已写成结论（盘上单文件 deepEqual） | 满足 | 同上脚本 A3 组（`readdir` 前后相同 + `deepStrictEqual`）；变异下照绿 |

## 六、findings

### F1（minor，doc-side + 实现口径未尽一致）「末次回包 K 字」按 UTF-16 单元计，摘要截取会切在代理对中间

- 文档出处：`docs/modules/investigation-agent.md:209-215`（§3.2.1 消息形状表）、`:662`（§5.6 断言口径）
- 文档说：`末次回包 K 字：「正文开头 50 字」`，只写「字」，没写按码点还是按 UTF-16 单元计；同一份文档在结论工具处明写按字符 `[...text].length`（`:510`）
- 实测：`a😀b` 报 `末次回包 4 字`（真实 3 个字符）；`'😀'.repeat(300)` 报 `末次回包 600 字`；50 字摘要取到代理对中间，detail 里出现孤立代理项（终端显示 `�`）
- 复现：`node --input-type=module -e 'import {InvestigationAgent} from "./investigation-agent.js"; import {AgentToolbox} from "./agent-tools.js"; const tb=new AgentToolbox({listTools:async()=>[{name:"get_honeypot_event",inputSchema:{type:"object",properties:{id:{}},required:["id"]}}],callTool:async()=>({id:7})}); try{await new InvestigationAgent(tb,{model:"fake",complete:async()=>({content:"a😀b"})}).run("honeypot:7",{mode:"triage"})}catch(e){console.log(e.message)}'`
- 严重度：minor。不影响 A1/A2/A3：四段仍在、整条仍 ≤240/250、BMP 中文（真实运维回包绝大多数）无差别
- 建议：二选一——文档把口径写成「字 = JS 字符串长度（UTF-16 单元）」，或实现改用码点计数并把摘要截取做整码点切分，与结论工具的 `[...text].length` 统一。不阻塞本卡。

## 七、残余风险（写者 5 条外，测试席补充观察）

1. 回包摘要抄 50 字原文，可能把告警原文/凭据类字段带进 `status()`/`cases()` HTTP 面（写者未决 2 条，未脱敏）；本卡只验证了不带 `apiKey`/`Authorization`。
2. `240`（investigation-agent）↔`250`（triage-monitor 截断）跨模块耦合仍在；非 BMP 回包下实测不破，但改任一端都会漂（写者未决 1）。
3. A2 队列侧仍无新增单测（`triage-monitor.test.js` 不在本卡 scope）；本次用既有 15 条 + 我的 e2e 兜住，后续要单测级覆盖得另派卡（写者未决 4）。
4. `docs/modules/investigation-agent.md` §3.3 及之后仍是 T012 前旧行号（写者未决 5），本次未核，非本卡范围。
5. 全量 `node --test` 在树里时长不稳、`web/**` 与 `evidence/**` 有基线红（未跑，见 §一备注）。

## 八、树状态

```text
$ git log --oneline -1
6699f59 docs(report): P003-T022 交卷报告（…）
$ git status --short
 M evidence/test/P003-T007/shots/1440-a5-sidebar.png   ← 开工前就在，非本次测试产生
?? .pi-child-claim.json
?? evidence/test/P003-T022/                            ← 本报告与自写 e2e 脚本
```

未改产品代码、未改写者测试；脚本只 import 公开入口。
