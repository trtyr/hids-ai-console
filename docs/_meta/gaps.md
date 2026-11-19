# 已知边界与未决

这份文件记录写文档时**查不清、查不动、或前后对不上**的地方。每条都带证据。
只描述现状，不给改法——改法是评审的活。

最后更新：架构篇（P001-T001）；旧运行态目录一条由 P003-T019 改写；第一节末段与第八节由 P003-T028 改写（测试基线）。

## 一、旧运行态目录还在盘上，不自动搬

P003-T019 之前，`server.js` 把运行态根目录算成「本文件所在目录的上一级」+ `backend/.data/`，于是数据落在仓库之外。实测现在两处旧目录仍在、里面有数据：

```
/home/trtyr/code/backend/.data/                     268K（主仓跑出来的：cases/ investigations/ trace-boards/ triage-monitor.json wiki-sessions/）
.../hids-ai-console/hids-ai-console/backend/.data/  205M（工作树跑出来的；其中 triage-monitor.json 单个 81401959 B）
```

P003-T019 把运行态从「上一级 + `backend/.data/`」挪到仓库内 `.data/`；**P003-T034 又把它挪出仓库**：现在的唯一落点是数据根（`HIDS_DATA_DIR` 指到哪就落哪，没设就是 `~/.local/share/hids-ai-console/`；`server.js:1005-1018` 的 `runtimePaths()` 给清单，根由 `config-store.js:31-35` 的 `dataRoot()` 算）。

**两批旧目录里的数据都没有迁移**（A4：迁移是运维的手工活）：进程不读也不写它们，里面的研判记录、案卷、`triage-monitor.json`、基线要接着用得人工搬进数据根。同理，搬到新根之后第一次启动时 `triage-monitor.json` 不存在，游标/队列/去重表是空的。

同一段老布局也曾写在测试里。`maintenance-startup.test.js` 原来把 `root` 算成「本文件的上一级」（旧布局下正好推出 `<仓>/backend/maintenance-server.js`），
P003-T019 把运行态改回仓内、`maintenance-server.js` 挪到仓根之后，这个测试没跟着改，于是成了测试集里唯一的必红项。

P003-T028 已把它改到真实路径（`maintenance-startup.test.js:12-14`：`root` 取本文件所在目录，spawn `<临时目录>/current/maintenance-server.js --preview`），
symlink 部署场景不变，单文件约 60ms 跑绿。**所以这条不再是缺口**，留在这里只作为「测试与部署布局漂移」的先例。
测试命令与依赖安装口径见第八节。
`README.md:14` 已按 P003-T034 改口径：「运行中的案件、研判记录与配置落在机器全局的数据根（`HIDS_DATA_DIR` / `~/.local/share/hids-ai-console`），仓库里不写任何运行态」。

## 二、一套模块只被测试引用，没接进业务进程

`knowledge-store.js` 与 `knowledge-workbench.js` 是一套「候选经验整理台」，有完整的字段定义、追问与审核发布流程
（`knowledge-workbench.js:3-12`、`knowledge-workbench.js:37-67`）。

全仓 grep 的结果：只有两个测试文件 import 它——

```
$ grep -rn "knowledge-store.js\|knowledge-workbench.js" --include=*.js .
./knowledge-workbench.test.js:6:import { KnowledgeStore } from './knowledge-store.js';
./knowledge-workbench.test.js:7:import { KnowledgeWorkbench } from './knowledge-workbench.js';
./investigation-agent.test.js:5:import { KnowledgeStore } from './knowledge-store.js';
./investigation-agent.test.js:6:import { KnowledgeWorkbench, knowledgeFields } from './knowledge-workbench.js';
```

`server.js:7-22` 的 import 列表里没有它们。因此当前业务进程加载的是另一套：
`wiki-store.js` + `wiki-workbench.js`（判据库与维护会话）。

两套都在 `InvestigationAgent` 构造参数里叫「知识库」角色，但只有 `wiki-store.js` 那套被实际接线——
`server.js:36-37` 把 `wikiStore` 传进智能体的第 4 个参数（`investigation-agent.js:207`）。

**没查到**：这两套是「一旧一新」还是「一新一旧并存」，代码里没有注释、没有开关、没有迁移脚本能说明。
`git log` 里也没有相关说明。要确认得问产品/开发。

## 三、`createServer` 有两个参数没有使用点

`server.js:112` 的 `createServer(...)` 签名里有 15 个参数。其中两个在请求处理函数里找不到任何引用：

```
$ grep -n "maintenanceEntry" server.js
115:  maintenanceEntry = process.env.HIDS_MAINTENANCE_ENTRY_URL,

$ grep -n "knowledge" server.js
112:export function createServer(service = gateway, ..., knowledge = null, ...
```

`HIDS_MAINTENANCE_ENTRY_URL` 这个环境变量也只在这一处出现，`openapi.yaml` 里没有它。

**没查到**：这两个参数是预留接口、还是接线遗漏。没有别的线索。

## 四、接口契约有两套真源

`openapi.yaml` 自己写明「依据 backend/server.js 和 backend/maintenance-server.js 的实际路由整理」（`openapi.yaml:6`），
但它是独立文件、独立维护。两边对不上的地方不会自动暴露——本卡没有逐条比对 35 条路径与路由分支，
那属于接口契约卡的事。

## 五、模块页

14 个模块页都已写完，落在 `docs/modules/<name>.md`。清单见 [docs/modules/_breakdown.json](../modules/_breakdown.json)。
架构篇第 12 节的覆盖构件已与清单里的 `components` 对齐。各篇自己的「未决」还在模块页里，不在这里复制一份。

## 六、没查到的部分

以下几项在本卡里查不到，文档中相应位置一律没有断言：

| 没查到的 | 为什么查不到 |
| --- | --- |
| 牧云 `/rpc` 与 `/api/mcp` 的实际响应格式 | 本机没有牧云凭据，本卡未发起任何外部请求。文档里的字段映射全部来自代码中的映射表（`cloudwalker.js:16-74`、`evidence-view.js:4-47`），不是实测响应 |
| 模型的真实行为与结论质量 | 需要真实模型服务与牧云凭据。文档只描述代码如何约束模型输出，不描述模型表现 |
| 客户前端与维护页面的行为 | 不在本仓（`README.md:3`） |
| 生产部署形态（反向代理、端口、凭据来源） | `openapi.yaml:7` 描述了客户前端默认 8081、维护页面默认 18082，但这两个工程不在本仓，无法核对 |
| `HIDS_SYSLOG_TIME_OFFSET_MINUTES` 在各部署环境的实际取值 | 属于部署配置，代码只提供换算逻辑（`syslog-input.js:61-72`） |

## 七、还没做的

- 上面第一节到第四节四条，代码改动时需回头核对架构篇第 8.1、4、13 节的对应段落。
- 第六节那五条仍然没查到。没有牧云凭据、没有生产部署，补不了。
- 各模块页里的局部未决留在各自页面，不升成全局缺口。

## 八、测试怎么跑：命令口径与范围

P003-T028 之前根 `package.json` 的 `test` 是裸 `node --test`。无参时它从仓根递归扫「测试命名约定 + `test/` 目录」，把三类东西一起吞进来：

- 仓根 21 个后端单测（`*.test.js`）——这才是单测基线；
- `evidence/test/**` 21 个历史验证件，其中 6 个要 spawn `server.js` 并等 20s 超时（缺 `LLM_*` 配置就启动失败）——`timeout 180 npm test` 到点被杀、没有汇总行，看着就是「挂起」；
- `web/test/**` 浏览器测试——它们的 DOM 环境来自 jsdom，而 `web/node_modules` 不在 git 里，没装时每个文件都以 `ERR_MODULE_NOT_FOUND: Cannot find package 'jsdom'` 失败。

现在的口径（`package.json:8-10`）：

| 命令 | 跑什么 | 实测 |
| --- | --- | --- |
| `npm test` | `node --test --test-timeout=60000 --test-force-exit *.test.js`，只跑仓根后端单测；`--test-timeout`/`--test-force-exit` 是复审修复轮加的挂起上界 | 198 条全绿，约 2s，退出码 0 |
| `npm run test:web` | `npm --prefix web test`，跑 `web/test/**` | 447 条全绿，约 5.8s，退出码 0 |
| `npm run test:all` | 上面两段串跑 | 198 + 447 全绿，约 6.3s，退出码 0 |

退出码：任一用例失败 → 1（实跑注入一条必红用例验证过），全绿 → 0。

**前置条件**：`npm run test:web` / `npm run test:all` 需要先 `npm install --prefix web`（`web/package.json:11` 已声明 `jsdom ^31.0.1`，锁文件 `web/package-lock.json` 已提交）。不装也能跑 `npm test`——它零外部依赖。

**范围边界**：`evidence/test/**` 是逐卡验证件，不是单测基线，命令里不扫它们；要复跑旧卡片按该卡 test-report 里的原始命令单独跑。`maintenance-startup.test.js` 的修复见第一节末段。

证据：`evidence/test/P003-T028/`（改前红/挂起日志、改后三条命令日志、退出码探针）。
