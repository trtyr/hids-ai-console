# HIDS AI 研判平台 · 前端设计稿

一套可直接打开、可点击操作的高保真设计稿，交付形态是静态 HTML + 本地资源，不依赖构建工具、不联网。

## 打开方式

双击 `index.html`（登录页）即可。所有页面之间可以互相跳转，字体已本地化到 `assets/fonts/`，断网也能正常显示。

演示账号（仅前端模拟，接真实接口时删除）：

| 入口 | 账号 | 密码 |
| --- | --- | --- |
| 业务控制台 | `hids` | `hids-2026` |

## 页面

| 文件 | 页面 | 说明 |
| --- | --- | --- |
| `index.html` | 登录 | 左右分栏品牌区 + 登录卡片，含校验、加载、失败、冷却、断网、成功态 |
| `overview.html` | 总览 | 告警总数与构成、11 类事件表、队列健康、运行状态 |
| `alerts.html` | 告警 | 队列条、筛选、告警表、右侧详情抽屉、批量重研判 |
| `alert-detail.html` | 告警详情 | 结论、依据、所需证据、步骤、证据来源、核验与复核、原始事件 |
| `trace.html` | 深度溯源 | Obsidian Canvas 式白板：节点渐进出现、连线、检查器 |
| `rules.html` | 前置规则 | 表单 / JSON 双视图编辑、校验、保存、只读态 |
| `wiki.html` | 知识库 | 条目列表（搜索 / 分类 / 标签）+ 条目页（摘要、目录、分节、内链、编辑） |

## 设计系统

- 颜色、深色 / 浅色两套 token：`assets/theme.css`；切换脚本：`assets/theme.js`；说明：`theme-notes.md`。
- 字体：Space Grotesk（拉丁）+ 系统中文，等宽用 JetBrains Mono，全部本地子集，见 `assets/fonts/`。
- 版式：196px 侧栏 / 52px 顶栏、13px 正文、发丝分隔线、等宽数字、单一青色主色、0–2px 圆角。
- 深色为默认（跟随系统，可手动切换并记住选择）。

## 数据边界

页面里的业务数据是**示例数据**，集中写在每页脚本顶部，接真实接口时整段替换。所有字段名按 `openapi` 文档取值，文档没有定义的字段不编造：

- 告警、研判、队列、规则、知识库目录的字段与状态码对应关系，见各页 `*-notes.md`。
- 文档中只写了 `object`、没有字段定义的结构（`steps`、`claims`、`required_evidence`、`review`、`validation`、`detail`、`TraceBoard.nodes/edges`），前端按后端实际返回的 key 原样渲染，不预设字段。
- 证据条目、未匹配 Syslog 案件列表、告警列表服务端筛选等能力没有接口，界面不做假控件。
- 知识库正文与标签没有对应字段，也没有更新页面的接口，所以编辑保存在浏览器本地（`hids-wiki-drafts`），发布走维护会话，界面上如实标注。

完整清单见 `backend-contract-gaps.md`。

## 文件

```
index.html / overview.html / alerts.html / alert-detail.html
trace.html / rules.html / wiki.html       页面
assets/theme.css, assets/theme.js         主题 token 与切换
assets/fonts/                             本地字体子集
design-notes.md                           登录页交接说明
overview-notes.md  alerts-notes.md        总览、告警交接说明
alert-detail-notes.md trace-notes.md      详情、溯源交接说明
rules-notes.md  wiki-notes.md             规则、知识库交接说明
theme-notes.md                            主题系统与对比度
backend-contract-gaps.md                  接口缺口记录
```

## 说明

- 页面为纯前端演示，表单提交、入队、保存等动作都是本地模拟，不发送真实请求。
- 该导出包含源码与说明文档；当前环境没有渲染器，因此不包含 PDF / 截图版本。需要 PDF 时可用浏览器打印为 PDF，版式按 1440×900 设计。
