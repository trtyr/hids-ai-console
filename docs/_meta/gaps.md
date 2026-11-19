# 已知边界与未决

这份文件记录写文档时**查不清、查不动、或前后对不上**的地方。每条都带证据。
只描述现状，不给改法——改法是评审的活。

最后更新：架构篇（P001-T001）；旧运行态目录一条由 P003-T019 改写。

## 一、旧运行态目录还在盘上，不自动搬

P003-T019 之前，`server.js` 把运行态根目录算成「本文件所在目录的上一级」+ `backend/.data/`，于是数据落在仓库之外。实测现在两处旧目录仍在、里面有数据：

```
/home/trtyr/code/backend/.data/                     268K（主仓跑出来的：cases/ investigations/ trace-boards/ triage-monitor.json wiki-sessions/）
.../hids-ai-console/hids-ai-console/backend/.data/  205M（工作树跑出来的；其中 triage-monitor.json 单个 81401959 B）
```

P003-T019 起运行态改到仓库内 `.data/`（`server.js:27` 取目录、`server.js:805-818` 的 `runtimePaths()` 给清单，`.gitignore:10` 已忽略）。**旧目录里的数据没有迁移**：进程不读也不写它们，里面的研判记录、案卷、`triage-monitor.json`、基线要接着用得人工搬进仓内 `.data/`。同理，改完后第一次启动时 `triage-monitor.json` 不存在，游标/队列/去重表是空的。

同一段老布局也写在测试里。`maintenance-startup.test.js:12-14` 拼的是 `<上一级>/backend/maintenance-server.js`，
在本仓目录名下拼出的是 `.../current/backend/maintenance-server.js`。**它与运行态目录已经不是同一件事了**（运行态已改回仓内），
但那个测试自身还没跟着改，所以仍是测试集里唯一的失败项：

**实测**（命令 `node --test *.test.js`，退出码 1）：

```
ℹ tests 190
ℹ pass 189
ℹ fail 1

✖ maintenance CLI starts when the deployment current path is a symlink
  Error: Cannot find module '/tmp/hids-maintenance-startup-jisyLi/current/backend/maintenance-server.js'
```

`README.md:14` 写的是「运行中的案件和配置在被 Git 忽略的 `.data/`」——P003-T019 之前这句与代码对不上（.gitignore 忽略的仓内 `.data/` 只存提示词覆盖文件），**现在对上了**。

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
