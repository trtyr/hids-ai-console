# P003-T017 · 前端验收（真浏览器 + 真后端）测试报告

- 任务卡：P003-T017（M7 前端，席位 gc-frontend-tester / 江屿）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T017`，分支 `task/hids-ai-console-P003-T017`
- 现场核对：`git log -1` = `52fcaf5`（与派活单一致，无漂移）；`git status --short` 只有 `?? evidence/p003-t017-verify/`、`?? web/node_modules`（本地符号链接）、`?? .pi-child-claim.json`
- 判据来源：`web/README.md` §13（13.1–13.10）+ §4 路由表；任务卡 A1/A2/A3；D017 / D020
- **没读页面实现内容**（`web/pages/*.js`、`web/src/rego-rules.js` 一行未看），只做符号/路径层面的定位；没改产品代码，
  也没在 worktree 里做变异——变异验红整刀都在 `/tmp` 的 `web/` 副本里做的（见第五节）
- 结算：**PASS**。发现 0 条（blocker / major / minor 全 0）。残余风险见第七节

## 一、门禁（本终端亲跑）

| 命令 | 结果 |
| --- | --- |
| `cd web && timeout 600 node --test` | `tests 447 / pass 447 / fail 0 / duration_ms 5172`，`EXIT=0` |
| `timeout 300 node evidence/p003-t017-verify/verify.mjs` | `ALL PASS`（26 条断言），`EXIT=0`；**连跑 3 次全绿**（`EXIT=0 / 0 / 0`） |
| `cd web && node --test test/pages/rules.test.js test/pages/rule-detail.test.js`（/tmp 副本，变异前基线） | `tests 32 / pass 32 / fail 0`，`EXIT=0` |

## 二、真后端联调（写者只用了桩后端，这轮补上）

写者用 `/tmp/p017-api.mjs` 桩（报告第五节自述）。本轮全部改走**真 `node server.js` + 仓根真 `rules/` 目录**：

```
HIDS_PORT=18085 HIDS_BASIC_AUTH_USER=hids HIDS_BASIC_AUTH_PASSWORD=hids-2026 node server.js
HIDS_API_ORIGIN=http://127.0.0.1:18085 HIDS_WEB_PORT=13017 node web/serve.js
→ GET /api/rules → {"count":3,"rules":[honeypot_probe, ssh_bruteforce, webshell_drop]}  HTTP 200
→ GET /api/rules/ssh_bruteforce → rego 234 字符（真 .rego 原文，含注释与空行）
```

- 真数据比桩少一条 `description: null` 的规则，本条另用浏览器内 network mock 单独验（见第三节 empty 格）。
- 三份真 `.rego` 的包里 `name` / `description` 全有；`GET /api/rules/no_such_rule` 真返回 `404 {"error":"规则不存在"}`。

## 三、验收锚点逐条（真后端 + 真浏览器）

浏览器：`agent-browser 0.41.2`（**本机没装 lightpanda**——skill 里的 `~/.local/bin/lightpanda` 不存在，按「双引擎」判据
「撞上边界转 agent-browser」处理：本轮既要截图又要行为断言，本来就该用 agent-browser）。

### A1 · `#/rules` 是五列列表，`#/rules/<id>` 是原文

```
heads: ["名字","一句话","效果","开没开","从哪来"]   rows: 3   total: "3"
rows[0]: ["蜜罐探测（root 用户）","蜜罐类型告警，对端与来源 IP 都非空、用户为 root 的探测","放行","开","未标注"]
rows[1]: ["SSH 暴力破解来源","登录类告警里来源 IP 非空、命令含 ssh 的，列为需要人工复核的候选","放行","开","未标注"]
rows[2]: ["WebShell 落地脚本","webshell 告警落在 /tmp 下、路径以 .jsp 结尾，且主机非空","放行","开","未标注"]
links:  ["#/rules/honeypot_probe","#/rules/ssh_bruteforce","#/rules/webshell_drop"]
```

- 表头**逐字**与 D017 / README §13.3 一致（脚本按数组逐项比，不是「包含」）。
- 三列展示默认 = 放行 / 开 / 未标注，页面底部脚注原话：`效果、开没开、从哪来三列是展示默认：接口只给名字和一句话，这三项还没有数据。`
- 口径挂在格子内元素的 `title` 上（`这轮只有放行，别的效果没定（D017）` / `规则库里装载着的规则就是在用的` /
  `接口没有来源字段，不猜是人建的还是误报反哺的`）——README §13.3 写的是「挂在各格 title 上」，对得上。
- **服务端多给字段也不认**（A1 的钉子）：`network route` 把 `/api/rules` 换成带
  `effect:"拦截", enabled:"关", source:"人建的", updated_at:"…"` 的回包 → 页面仍显示 `["MOCK 名字","MOCK 一句话","放行","开","未标注"]`。
- `description: null` → `未写说明` 且带 `is-muted`（真浏览器 mock 两行同表验的：`["没说明的规则","未写说明","放行","开","未标注"]`）。
- `caption` = `规则库；点一条规则的名字看它的 Rego 原文。`，五个 `th` 全部 `scope="col"`。

### A2 · `<pre data-role=rego>` 的 textContent 逐字等于接口 rego

```
点击名字 → location.hash="#/rules/honeypot_probe"
pre.textContent === GET /api/rules/honeypot_probe 的 rego → 236/236 字符（另一轮 ssh_bruteforce 234/234）
h2 = "蜜罐探测（root 用户）"（名字在原文上面）
textarea: 0   form: 0   [data-role=gutter]（JSON 行号栏）: 0   white-space: pre
```

- 长原文（213 行、8082 字符，见第四节 long-content 格）：`pre.textContent` 与接口 `rego` 仍逐字相等（8082/8082）。
- 原文页**不是 JSON、不是表单、没有行号栏**：三个查询全 0。

### A3 · 两屏无 `input/textarea/select/[contenteditable]`，按钮只有刷新（+失败重试）

```
列表页： editable=0   可见按钮 = ["刷新"]   禁词命中 = []
原文页： editable=0   可见按钮 = ["刷新"]   禁词命中 = []   （禁词表：保存/编辑/提交/删除/新增）
```

- 壳自带的「退出登录」「切换到深色模式」不算页面按钮，脚本已按名字排除后比对（见 `verify.mjs`）。
- 失败态才出现的「重试」在 DOM 里常驻、`hidden` 藏：404 格实测 `visibleRetry=false`（库里没这条，不摆读不出来的重试）。
- 旧程序门禁编辑器（`#/rules-gate`）在旁边活着且可编辑（80 个可编辑控件），但**不在侧栏**（`gateInNav=false`、`navActive=[]`），
  规则页上没有任何入口指向它 —— 与 README §13.10 一致。

## 四、六格状态（真后端，两屏各一格；真 server.js 代码 + 真 RuleStore，数据变体走 /tmp 副本）

真 `rules/` 只有 3 条、且都健康，造不出 empty / 502 / 超长 这三格。做法：把整个工作树 `rsync` 到 `/tmp/p017-realcopy`
（**不进仓**，跑完删除），在**副本的 `rules/` 目录**里加减数据文件，起**同一份真 `server.js`**（另一端口）。

| 格 | 造法 | 实测 |
| --- | --- | --- |
| loading | `/tmp` 里一个 2s 延迟的转发代理挡在 `web/serve.js` 与真后端之间 | 列表：`table-wrap[aria-busy=true]`、刷新 `disabled=true` + `classList.contains('is-loading')`、`共 — 条`、占位行「正在读取规则库…」（2s 内逐帧采样一致）；原文页：`h2="正在读取规则…"`、`.rego-wrap[aria-busy=true]`、刷新禁用，读完后 `preLen=234` |
| empty（列表） | 副本里把 `rules/*.rego` 全移走 → 真接口 `{"count":0,"rules":[]}` | `共 0 条`、表格体一行「规则库还没有规则。」、`sr-status="规则库已更新，共 0 条"`、无失败块 |
| empty（原文 404） | `#/rules/no_such_rule_xyz`（真后端 404） | 「规则库里已没有这条 … 没有 id 为「no_such_rule_xyz」的规则…」+ 回列表链接 ×3、无可见重试、无假原文 |
| partial（列表） | 已有 4 行 → 副本里加一份坏 Rego（`default match = false`）→ 点「刷新」 | `.notice[role=alert]` 可见：`刷新失败，规则库读取失败：rules/broken_drop.rego:5: 不支持的语法：default match = false（下表是上一次读到的规则）`；**表格 4 行原样保留**、`共 4 条`、无整块失败 |
| partial（原文） | 原文已读到 234 字符 → `set offline on` → 点「刷新」 | 提示「刷新失败，连接不上研判服务。（下面是上一次读到的原文）」+ 重试；`preLen` 仍 234（一个字没清）；关掉 offline 点重试 → 提示消失、无 alert |
| error（列表 502） | 副本里放一份子集外语法的 Rego → 整页首读 | 整块 `.page-error[role=alert]`：`规则库读取失败：rules/broken_drop.rego:8: 不支持的表达式：input.path =~ "jsp"`——**服务端原话带 file:line，逐字上屏**；重试可见 |
| error（列表 401） | 真后端 + 请求头覆盖成错密码（`set headers` → `Authorization: Basic aGlkczp3cm9uZw==`） | 整块失败文案 `登录已失效，请重新登录。` + 重试 |
| error → 恢复 | 删掉坏 Rego → 点重试 | 表格 4 行回来（`共 4 条`），失败块消失，`alerts=0` |
| long-content（原文） | 副本里塞一份 213 行 / 8082 字符的 Rego | `lines=213`，`pre.textContent === rego`（8082/8082）；`pre` 块内滚（`scrollHeight 4045 > clientHeight 556`），页面 `sw==cw==1440`；390 下 `pre` 横向滚（`scrollWidth 435 > clientWidth 360`）而页面不横滚 |
| long-content（列表） | 副本里塞一份名字 84 字、一句话 183 字的 Rego | 全文进 DOM（`textContent` 84/183），内层 `a.rule-link` / `span.cell-text` 是 `ellipsis + nowrap + overflow:hidden`（1440：`cw 309 / sw 1008`；390：`cw 121 / sw 1008`），`title` 留全文（106 / 183 字符），行高恒 39、**页面不横滚** |
| disabled（六格里的请求在飞） | 2s 慢网下点刷新（列表）与点刷新（原文） | 刷新 `disabled=true` + `is-loading`；请求回来恢复 `disabled=false`、`aria-busy` 消失 |

## 五、变异验红（亲手复现；整刀在 `/tmp` 副本里做，worktree 一个字节没动）

`rsync -a web/ /tmp/p017-mut/web/`（`node_modules` 符号链接跟着过去），基线 `32 pass / 0 fail`。

| 刀 | 改法 | 结果 | 还原 |
| --- | --- | --- | --- |
| 一：A1 表头锚词 | `pages/rules.js` 里 `开没开` → `开着吗`（4 处） | `✖ A1：进去先是表——五列表头依次是 名字 / 一句话 / 效果 / 开没开 / 从哪来`（+ `page.render` 一条连带红）；`tests 32 / pass 16 / fail 16`，`EXIT=1` | `cp` 回原件 → `32 pass / 0 fail`，`md5sum` 与 worktree 同文件一致 |
| 二：A2 `<pre data-role=rego>` 锚 | `pages/rule-detail.js` 里 `data-role="rego"` → `data-role="rego-x"`（1 处） | `✖ A2：原文逐字进 <pre>…` 起头，原文页 14 条全红（同一选择器是这套断言的共同锚），`EXIT=1` | 同上，还原后复绿、`md5sum` 一致 |

结论：两条断言不是永真，锚词一动就恰红；还原后绿。worktree 终态 `git status` 干净（只有本报告目录）。

## 六、交互与键盘（不是「点了没反应」，是逐条看见）

| 动作 | 实测 |
| --- | --- |
| 点名字链接 | `location.hash` 从 `#/rules` → `#/rules/honeypot_probe`，原文按接口渲染 |
| 点整行（点「一句话」那格） | 同样跳 `#/rules/webshell_drop` → `preLen=259` |
| 浏览器后退 / 前进 | 后退回 `#/rules`（`rows=3 total=3`），前进回原文（`preLen=259`） |
| 键盘 Tab（列表页，真按键，非 JS 伪造） | 序列：…侧栏链接 → 退出登录 → 主题 → **刷新** → `#/rules/honeypot_probe` → `#/rules/ssh_bruteforce` → `#/rules/webshell_drop` → 绕回侧栏；无焦点陷阱、无可编辑控件混进去 |
| 键盘 Enter（Tab 到规则名后按真 Enter） | `hash=#/rules/ssh_bruteforce`，原文渲染 |
| 键盘 Tab（原文页） | `← 规则列表`（`#/rules`）→ **刷新** → 绕回侧栏 |
| `focus-visible` | 聚焦的规则链接 `outline: 2px solid rgb(28,111,92)`（强调色，非 `none`） |
| 连点刷新 ×5（同步连点） | 5 个 `GET /api/rules` 全 200，末态 `rows=3 total=3`、`alerts=0`、无重复行（GET 幂等，无脏状态；文档没承诺去抖） |
| 刷新中途 reload（凭据只在内存） | 回登录页（README §2「刷新即重新登录」是有意设计）；重新登录后 hash 回落 `#/overview` —— 这是壳的行为、全站一致，**不是本卡范围** |

## 七、残余风险（没验到的，写清楚）

1. **`description: null` 只在 mock 下验过**：真 `rules/` 三条都有 description，本机上造不出「真接口返回 null」的规则文件
   （`rules/**` 不在本卡 scope，我没有往里写文件）。页面行为（「未写说明」+ `is-muted`）已在浏览器里对 mock 回包验过。
2. **401 是「请求头覆盖」造出来的**：真后端在有校验的情况下回的 401，但不是「页面持有一份过期凭据」那条路（凭据不落盘，做不到过期）。
   文案与重试行为一致。
3. **视觉比对没有稿**：D017 明写 `design/rules.html` 是旧程序门禁编辑页、不能当这一页的稿，新页无设计稿。
   本轮视觉只到「几何作证」这一层（表格/原文块尺寸、截断与滚动、两宽度下无整页横滚、令牌色 `rgb(28,111,92)`），
   没有逐像素比对对象。这是文档现状，不是缺陷。
4. **截图我看不了图**（本席模型不支持读图）：截图只作 `file` 尺寸与「拍的时候 DOM 量过的状态」的证据；
   所有视觉结论都来自 DOM/几何测量，不是看图。
5. **窄屏的手感**：390 下列表要横向滑动才能看全五列（表格 `min-width:560` 在 362 的包裹层内滚），README §13.5 就这么写的；
   能用但没有「一屏看全」。如果产品要窄屏一屏，是下一张卡的事。

## 八、文档小瑕（不挡收，记账，不算 findings）

1. 写者交卷报告第三节 A1 写「口径说明在 `DISPLAY_HINTS`（挂在**表头** title 上）」；实测挂在**格子内元素**上，`th` 没有 title。
   `web/README.md` §13.3 写的是「挂在各格 title 上」，**README 是对的**，只有报告措辞偏了一格。
2. 连点刷新不去抖（5 击 5 请求）。GET 只读、末态正确，文档也没承诺去抖，记录备查。

## 九、复验脚本

`evidence/p003-t017-verify/verify.mjs`（自起真后端 + `web/serve.js` + 一个 agent-browser 会话，跑完全杀）：

```
node evidence/p003-t017-verify/verify.mjs     # ALL PASS / EXIT=0（连跑 3 次一致）
```

覆盖：A1 五列表头与逐格字段（期望值由 Node 侧真 GET `/api/rules` 取）、三列展示默认脚注、A2 原文逐字、
A3 两屏零可编辑控件与按钮清单、404 格、键盘可聚焦元素清点、1440/390 两宽度无整页横滚、整轮无页面 error。
不覆盖：loading / partial / error / empty 的数据变体（要往 `rules/` 里造数据，脚本不碰仓），这几格是本报告第四节的手工记录。

脚本自身两处修过：`--args --no-sandbox` 必须在首启（先 `open` 再 `set viewport`）；登录点击不能塞进 `waitPage` 的轮询体里。
