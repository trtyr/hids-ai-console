# P002-T001 复测报告（第三轮复审 PASS 后回归）

- 被测树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P002-T001`，HEAD `32c0d3d`，起测时 `git status` 干净（唯一未跟踪项是本次自建的 `evidence/test/`）
- 本轮改动：`f951c87`（对上轮 findings F1–F4 的整改）+ 其后 4 条 docs commit
- 复审判词：`verdicts/P002-T001-gc-frontend-code-review-mwkx1eeg.json`
- 环境：node v26.13.0、Chrome 157（agent-browser，`--no-sandbox`）、真 `server.js`（Basic 认证）+ 真 `web/serve.js`
- 自建用例：`evidence/test/P002-T001/e2e-checks.sh`（自带起停，跑完进程回收；`bash evidence/test/P002-T001/e2e-checks.sh` → **exit 0**）

## 1. 上轮四条 finding 是否闭合

### F1 `/_handoff/**` 不再发布 —— 闭合

`bash evidence/test/P002-T001/e2e-checks.sh`（exit 0），逐条：

```
200 /                     200 /src/views/login.js
404 /_handoff/design/hids-ai-design.zip   404 /_handoff/handoff.md
404 /_handoff/design/openapi_2_.yaml      404 /_handoff/  404 /_handoff
404 /%5Fhandoff/handoff.md   404 /_HANDOFF/handoff.md   404 /_handoff//handoff.md
404 /_handoff/handoff.md?x=1 404 /_handoff%2Fhandoff.md 404 /x/../_handoff/handoff.md
200 /_handoff/../index.html（规范化后是公开文件，该放行）
```

- 编码绕法（`%5F`、`%2F`、`%2E%2E%2F`）、大小写、尾斜杠、查询串都没绕过去；前缀判断在解码之后
- 文件仍留在树上（`web/_handoff/{handoff.md,design/}`），只是不发——符合任务卡「文件可以留在树上」
- `web/README.md:30` 返回码表有 `/_handoff/* → 404`，`web/README.md:211` 有「不对外」口径

### F2 进壳只渲染一次 —— 闭合

注入 `Element.prototype.replaceChildren` 打点（登录页注入，登录成功后读），真输入 + Tab/Enter 提交：

```
[{"t":".content","connected":false,"stack":"...pages/overview.js:16 → syncRoute → showShell"},
 {"t":"#root","connected":true,"stack":"...showShell → onSuccess"}]
```

- 上轮是三条（`.content(游离) → #root → .content(已挂载)`），本轮 `.content` 只打一次
- 进壳后静置 1s 再读：`replCount=2`（不涨）——`replaceState` 没排 hashchange
- 真点导航每换一页恰 +1 次渲染；连点五个入口 → 5 次（`#/knowledge` 正确）；浏览器 back/forward 各 1 次，无重复渲染
- 带 `#/rules` 冷启动再登录：落到 `#/overview`，`repl=[[".content",false],["#root",true]]`，一次
- 真双击「登录」：`api/session` 请求数 **1**，落 `#/overview`

### F3 ≤620px 导航可点 —— 闭合

390×844（`agent-browser set viewport 390 844`）实测：

```
总览   x[12,77]   y58-100   elementFromPoint → A.nav-item is-active   self=true
告警   x[77,142]            → A.nav-item                               self=true
深度溯源 x[142,232]         → A.nav-item                               self=true
规则   x[232,297]           → A.nav-item                               self=true
知识库 x[297,375]           → A.nav-item                               self=true
退出登录 x[288,378] y0-44（折行到上一行，与导航不同 y，不重叠）
nav scrollWidth=clientWidth=390，documentElement.scrollWidth=390（无横向溢出）
```

- 真点「规则」→ `#/rules` h1=规则；真点「知识库」→ `#/knowledge` h1=知识库（上轮这两个点不动）
- 键盘：进壳后 Tab×5 依次落 总览→告警→深度溯源→规则→知识库，焦点在「知识库」按 Enter → `#/knowledge`
- 屏宽再压到 320×720：nav `overflow-x:auto`（scrollW 387 > client 320），`scrollLeft` 可写、Tab 聚焦「知识库」时自动滚到位——比验收要求的 390 更窄也能到
- 版式与稿的差异（导航独占一行 vs 稿的同一行）`web/README.md:181` 有理由（D002：稿不好用可改交互）；稿在 390 下确实把「规则」压在「退出登录」下（`shots/design-390-overview.png`），产品不再如此

### F4 README 两处口径 —— 闭合

```
web/README.md:30   /_handoff/*（交接件…）| 404——交接件不进产品资源
web/README.md:148  一次路由切换只会调一次 render（含登录成功后进壳那一下）…replaceState
web/README.md:181  ≤620px 顶部条折两行…稿在 ≤430px 第 4、5 个入口被盖住、点不到
web/README.md:211  /_handoff/ 只是参考材料…serve.js 对 /_handoff/* 一律回 404，不会被当成产品资源发出去
```

## 2. 验收锚点（任务卡 A1/A2/A3）

- **A1**：`/` 200 登录页可开；提交只打本仓 `GET /api/session`（网络面板：`GET /api/session (Fetch) 401/200`，无第二个接口）；对照凭据逐字相等。`/%zz` → 400「请求路径无效」，紧跟 `/` → 200，进程存活；`/_handoff/../index.html` 规范化后 200 是公开文件，不是泄漏。静态产物 grep `hids-2026|DEMO 常量|演示账号` 只命中两处注释（`assets/app.css:399-400`、`src/views/login.js:3`），无可执行演示凭据
- **A2**：401 → 横幅 `role=alert aria-live=assertive`「登录失败 / 账号或密码不正确。」、密码清空、焦点回密码框、hash 仍空、请求恰 1 条；502（反代目标端口死）→「登录失败 / 服务返回异常（502），请稍后重试。」；成功 → `#/overview`，五个入口 + 退出登录齐全，鼠标与键盘两条路逐个走通；退出登录 → 清 hash 回登录页焦点落账号框；`#/nonsense` 回落总览；未登录直进 `#/rules` 显示登录页、登录后落 `#/overview`；刷新 → 回登录页（凭据只在内存）
- **A3**：壳可见文本 `总览 告警 深度溯源 规则 知识库 退出登录 总览 总览尚未接入 这一页还没有接后端接口。`，无账号名/角色，`img` 0 个，无 `.who/.avatar`；稿里 `.who/.avatar` 本就在 390/1440 存在，产品正确未搬

## 3. 六格状态

| 格 | 造法 | 结果 |
|---|---|---|
| empty | 五个占位页 | 「XX尚未接入 / 这一页还没有接后端接口。」不画假数据 |
| loading | 注入 fetch 900ms 延迟后点登录 | 按钮文案「正在登录…」`disabled=true`，`form[aria-busy=true]`；加载中再点一次，`fetch` 调用数仍 1 |
| error | 401 / 502 / 后端进程停 | 文案与稿表一致（`web/README.md:82-93`），密码清空、焦点回密码框 |
| long-content | 账号填 201 字 | 原样保留、390 下 `scrollWidth=390`（无横向溢出）、正常提交得 401 |
| disabled | loading 态按钮 | 见上，`disabled` + 二次提交不发请求 |
| partial | — | `web/README.md:93` 声明不适用（登录只有一个整体结论）；不为它编状态 |

## 4. 视觉作证

`shots/`（agent-browser，两档视口）：

- `1440-login.png`、`1440-login-401.png`、`1440-login-502.png`、`1440-shell-overview.png`（rail 196 / bar 52）
- `390-login.png`、`390-shell-overview.png`、`390-check.png`（复核用副本）
- `design-390-overview.png`：稿 `overview.html` 同视口，对照见 F3
- console/errors：1440 与 390 走完全链路后 `agent-browser console` / `errors` 均为空

## 5. 门禁亲跑（本终端，无转录）

| 门 | 命令 | 结果 |
|---|---|---|
| web 单测 | `cd web && node --test` | `tests 43 pass 43 fail 0`，**exit 0** |
| 仓根 | `npm test` | `tests 142 pass 141 fail 1`，**exit 1**；唯一红 `maintenance-startup.test.js:9`（`Cannot find module .../current/backend/maintenance-server.js`）。`git diff --stat d5572b8 -- maintenance-startup.test.js maintenance-server.js package.json` 为空 → 与本卡改动无关，既存 |
| boundary | `node ~/.pi/agent/extensions/group-chat/gate/gate-cli.js boundary --task ~/.plantree/hids-ai-console/plans/002-frontend/tasks/T001.md --base d5572b8` | `{"ok":true,"checked":63,"violations":[]}`，**exit 0** |

boundary 说明：把我自建的 `evidence/test/` 一起算进去会多出 10 条 `out_of_scope`（全是本次截图）。把 `evidence/test/` 临时挪开再跑得 63 文件 0 违例（即写者 diff 本身零越界），随后挪回。两次结果都在上文，未隐藏。

## 6. 变异验红（亲手复现，非引用）

1. 删 `web/serve.js:112` 的 `/_handoff` 判断 → `node --test web/test/serve.test.js` → `tests 8 pass 7 fail 1`，恰红「交接件不发布：/_handoff/* 一律 404」（**exit 1**）；还原 → `8 pass 8 fail 0`（exit 0）
2. 把 `web/src/app.js:32` 的 `history.replaceState` 改回 `window.location.hash = target` → `node --test web/test/app.test.js` → `pass 0 fail 1`，恰红「登录成功进壳：总览只渲染一次，hash 落在 #/overview」（exit 1）；还原 → `pass 1 fail 0`（exit 0）
3. 两次还原后 `git status --porcelain` 只剩 `?? evidence/test/`，产品文件零改动

## 7. 本轮发现

**见 verdict findings（1 条 minor，不阻塞）**：`web/README.md:176` 写「只加了四处」，下面列了 5 条（620px 折行是新增的第 4 条，把原来的第 4 条挤成第 5 条）——数字没跟着改。

## 8. 残余风险

- 本机无 lightpanda 可执行文件，行为断言全部走 agent-browser（Chrome 无头），与双引擎首选路径不同
- 502/连不上用「反代目标端口死」造；真·断网只等价验了 fetch 抛错路径
- 深色主题只确认切换按钮与来回切无 console 错误，未做深色态视觉比对（不在本卡验收）
- 测试期间 `127.0.0.1:13300` 有一个非本席遗留的 `node web/serve.js`（pid 2015367，起测前就在），本席全程用 19881/13310/13311，未碰它
- 本席未改任何产品代码；产物只有 `evidence/test/P002-T001/`（未跟踪）
