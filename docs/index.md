# HIDS 智能研判平台 · 后端文档

写给第一次进这个仓的人。每篇文档只讲一件事，读之前先看下面的地图。

## 从哪儿开始

| 页面 | 讲什么 | 适合谁 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 后端的整体结构：进程入口、分层依赖、两条研判路径、证据校验、状态落盘、访问边界、配置项 | 所有人，先读这篇 |
| [modules/](modules/) | 每个模块一页，讲一个模块的职责、对外契约、关键实现 | 改某个模块之前 |
| [modules/_breakdown.json](modules/_breakdown.json) | 模块划分的机器可读清单（模块名、页面、实现文件、覆盖构件） | 想知道「哪个文件归哪一页」时 |

## 文档的组织方式

- **一页一个主题**。架构篇讲全局，模块篇讲局部，跨页的内容写成链接，不复制段落。
- **关键断言挂出处**。文档里的关键断言都标了 `文件:行号`，行号对应写文档时的提交。代码改了，重新核一遍行号。
- **只写现状**。「这里应该改成什么」是评审的活，不写在文档里。想看当前实现有哪些边界与未决，看 [\_meta/gaps.md](_meta/gaps.md)。

## 文档与代码的关系

| 文档 | 真源 |
| --- | --- |
| `docs/architecture.md` | 仓库根目录的 `.js` 文件、`package.json`、`openapi.yaml` |
| `docs/modules/*.md` | 对应模块的实现文件（见 `docs/modules/_breakdown.json` 的 `files` 字段） |
| 判据内容（不属于本套文档） | 数据根下的判据库 `wiki/`（仓内 `wiki/` 只是只读种子），由知识库维护流程管 |
| 提示词内容（不属于本套文档） | `prompts/` 目录 |

## 快速上手

```bash
# 需要 Node.js 20 及以上
npm test                    # 跑后端单测（web 单测：npm run test:web）
node --test triage-rules.test.js   # 只跑一个文件
node server.js              # 起业务 API，默认 127.0.0.1:8080
```

环境变量清单见 [architecture.md 第 10 节](architecture.md#10-配置项速查)；接口契约见 `openapi.yaml`；测试现状见 [architecture.md 第 11 节](architecture.md#11-怎么验证)。
