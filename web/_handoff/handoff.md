# 前端开工说明

先读这份，再读设计稿原件。不要凭印象做。

## 你在哪

项目仓：/home/trtyr/code/hids-ai-console
你的工作树是这张卡自己的 worktree，前端只写 web/。
不要改 server.js、openapi.yaml、wiki/、docs/。

## 设计稿原件（必读，摘要代替不了）

目录：/home/trtyr/.plantree/hids-ai-console/plans/002-frontend/design/
工作树里也有一份：web/_handoff/design/

- index.html：登录页。视觉和布局以它为准
- overview.html：总览
- alerts.html：告警列表和抽屉
- alert-detail.html：单条告警详情
- trace.html：深度溯源
- rules.html：前置规则
- wiki.html：知识库
- assets/theme.css 和 assets/theme.js：色、字、间距、组件。搬进 web/，不要另起一套皮肤
- README.md：七页怎么分、导航叫什么
- design-notes.md：设计口径
- theme-notes.md：主题
- overview-notes.md、alerts-notes.md、alert-detail-notes.md、trace-notes.md、rules-notes.md、wiki-notes.md：每页自己的说明
- backend-contract-gaps.md：做设计稿时对过的缺口。当线索，不当事实。以本仓现在的代码为准
- openapi_2_.yaml：设计当时的契约副本，可能过期。真契约是仓里的 openapi.yaml，再对 server.js

打开 HTML 看结构、文案、空态、错误态。不要把里面的演示数据抄进产品。

## 接口在哪

按这个顺序信：

1. 跑起来的接口，server.js 里注册的路由
2. 仓根的 openapi.yaml
3. docs/modules/ 里对应模块页，用来看字段是什么意思
4. 设计稿里的 openapi_2_.yaml 和 backend-contract-gaps.md，只作对照

客户控制台现在能用的大致是这些，以 server.js 为准，对不上就记下来：

- 会话：GET /api/session。登录路由看 server.js 里的 cookie 和登录处理。不要用设计稿里的演示账号
- 总览：GET /api/status。告警计数若接口没有，不要画假数字
- 告警：GET /api/alerts。单条 GET /api/alerts/{type}:{id}
- 研判：GET/POST /api/agent/triage/{alertId}。队列 GET /api/agent/triage/status。PUT /api/agent/triage/control。案例 GET /api/agent/triage/cases
- 规则：GET/PUT /api/triage/rules。POST /api/triage/rules/validate
- 溯源：POST /api/agent/investigations。GET /api/agent/investigations/{alertId}。工具 GET /api/trace/tools
- 知识库：/api/wiki/ 下列页面、读页面。没有更新页面的写接口，就不要做「已保存到服务器」
- 提示词：GET /api/agent/prompts。上传接口是 410，不要做上传按钮

每页动手前，用本仓代码对一下路径和回包字段。设计稿上有、回包里没有的，不画。回包里有、设计稿没画的，可以放进详情或检查器，不要为了像设计稿把它丢掉。

## 怎么用设计稿

- 布局、导航、文案、空态、颜色：照设计稿。
- 字段、按钮会不会真的打接口：照后端。
- 两边打架：听后端。报告里写一句差在哪。
- 设计稿不好用：可以改交互，报告里写一句为什么。不要默默换一套。
- 登录页上的演示账号删掉。走真会话。
- 静态稿里的数字、人名、告警样例，一律换成接口数据。没有就显示「—」或藏掉。

## 文件怎么放

壳负责导航和登录。页面文件按这个名字留位，后面的人各写各的：

- web/pages/overview
- web/pages/alerts
- web/pages/alert-detail
- web/pages/trace
- web/pages/rules
- web/pages/knowledge

主题从 design/assets/ 搬进 web/。不要六个人各写一套 CSS。

## 今晚的规矩

用户睡了。做完就交卷，不要等他。

撞上后端问题就写到：
/home/trtyr/.plantree/hids-ai-console/plans/002-frontend/topics/backend-findings.md

写清楚：哪个接口、实际回了什么、设计稿想要什么。不要改后端，不要用假数据绕过去，也不要为了这个问题停工。这页接不上的区块藏掉，继续下一页。
