# P003-T016 前端验收报告 · 江屿（gc-frontend-tester）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T016`；分支 `task/hids-ai-console-P003-T016`
- 跑测时的树：`39a764d`（测试件 `bdc502d` → `39a764d` 补日志）+ 本轮未提交的测试件改动；**本轮只改测试件**，`git diff --quiet -- web/` 为真（产品代码零改动）
- 上轮审计判词：`G-005bb2124108/verdicts/P003-T016-gc-frontend-test-review-mwmmvxg7.json`（**reject_test**：补测，不要求重做）
- 被测文档：`web/README.md` §4 / §12（12.1–12.9）+ 任务卡 A1–A5 + `openapi.yaml` 的形状
- **没读实现源码**：断言全部照 README 写的文案 / 状态 / 禁用边界。文里出现的实现坐标来自公开判词，不是我翻源码得的

## 一、结论

| 项 | 结果 |
| --- | --- |
| A1 进去先是列表，点一行才进这一条 | **pass**（12 条断言；含「焦点在行链接上回车」，**不再自称 Tab 焦点顺序**） |
| A2 告警列表每行带 ID 打开或创建 | **pass**（4 行 4 链接；GET 一次；404→POST 正文 `{target}`；422 带原话） |
| A3 告警在右 / 原因往左 / 可拖 / 位置记住 / 不能加点加线 | **pass**（-190px 逐列、真鼠标拖点写 localStorage、reload 不弹回、告警点钉死、双击不加点） |
| A4 进行中往左长 / 完成后按 discovery 重放 / 断点常显 | **pass**（「点继续接着播」改成**先断可点、再真点、再等文本回「暂停」**，变异下 7 条红，见 §三） |
| A5 没有对话输入框 | **pass**（**先钉住白板已渲染**（顶栏状态/链长/4 个点）再数输入框；列表页做对照证明探针数得出输入框） |
| 六格状态矩阵 | 列表 6/6、白板 6/6 有真浏览器落点；白板 error 格的「重试」按**可见性**断言（见 finding F1） |
| 门禁回归 | `cd web && node --test` → tests 396 / pass 396 / fail 0（本席亲跑） |
| 变异验红 | 亲手两刀：产品侧暂停禁用条件复原旧写法 → 写者守卫 31/1 红、e2e **138/7** 红（全在 A4 暂停/继续链）；测试侧把 A5 停在列表页 → A5 正向锚点 4 条红 |
| 报告数字 | 全部对得上：final **145/0**、还原复绿 **145/0**、变异 **138/7**、A5 自变异 **141/4**；旧的 117 / 124 不再出现 |
| 新发现 | 1 条 **major（文档承诺没兑现，实害：画布里没有可见「重试」）**，见 §七 F1 |

**判：FAIL（route_coding）——不是测试不合格，是 F1 这条实现与文档不符要写者定。** 本轮测试件本身补完：上轮审计 4 条 major + 6 条 minor 逐条落地（§二），A1–A5 的绿全部有真浏览器落点，且两条变异刀证明关键断言不是永真。

## 二、上轮审计 reject_test 的逐条落地

| 审计条目 | 上轮问题 | 这轮怎么补（落点） |
| --- | --- | --- |
| major① 白板 error「重试」按 DOM 存在性断言 | 命中的是 notice 里 hidden 的按钮，对「有/没重试」都绿 | `visn` 可见性探针（`offsetParent!==null && rect>0 && visibility!=='hidden'`）；断言 error 格 **可见「重试」= 0**、DOM 里那个 `rect 0×0 / offsetParent null`、**可见恢复入口 = 顶栏「刷新」1 个**；恢复路径改真鼠标坐标（`realclick`），不用 `el.click()`（`e2e-final.txt:140-146`） |
| major② 报告 F1 把 hidden 写成「可见可点」 | 一条真实现/文档不一致被降级成 doc-side 措辞 | 按实测重写 F1，并升为 **major finding**（§七 F1：README:641 承诺的画布内「重试」没有兑现，可见入口只有顶栏「刷新」） |
| major③ 引用 `e2e-after-restore.txt` 说 124/0，文件是 117 | 变异/还原两跑用的是脚本前版 | 两份日志用**当前脚本**重跑，145 条；变异日志同版（`138+7=145`），三份日志条数自洽（§三） |
| major④ A4「点继续接着播」只比前后快照 | 按钮死着也 PASS | 改成三段：`disabled===false` 钉住 → 真点击 → `waitcl` 按钮文本回「暂停」（README §12.4）→ `waitfor` 4 跳且此时才禁用；变异下这 4 条 + 2 条相关全红（失败清单 `e2e-mutation-pause-red.txt:190-197`） |
| major⑤ A5 三条全是否定断言 | 停在别的页/白板没画也绿 | 前置正向锚点：顶栏「已完成」+「链长 4 跳」+ 4 个 `.gnode`；再数输入框；另加列表页对照（`>=1` 个输入框）（`e2e-final.txt:89-95`） |
| minor 空态只测一句 | 第二句没钉住 | 列表空态「从告警列表点某一行的」、白板已完成「接口没有返回链上的跳」、白板进行中「任务在跑，新的一跳会自己从左边长出来」各 has 一次 |
| minor Tab→Enter 名不副实 | 实际是 focus + Enter | 断言改名为「焦点在行链接上按回车能进白板（只验回车，没验 Tab 焦点顺序）」 |
| minor 进度串「第 N / M 步」是实现自造 | 契约里没有 | **全脚本清零**：播完锚点改成「重放控件 `disabled===true` 且 4 个点」，中途态改成「重放到 2 个点」；`grep '第 [0-9] / [0-9] 步' e2e-behavior.sh` 为空 |
| minor 十余处 sleep 等异步 | 慢机器假红 | 断言前一律 `waitfor`/`waitcl`；剩下的 0.2–0.3s 只有两类：**故意停在瞬时 loading 态上取样**（已加注释说明）与鼠标事件沉降（down/up 之间） |
| minor 端口不查残留 | 会对旧进程跑 | 起桩前 `ss -ltn | grep -E ':(18106|13016)'` 命中即报错退出 |
| minor 报告头 HEAD 号对不上 | 写 90066b3，实际 39a764d | 见本文件头；且报告与脚本同一次提交 |

## 三、复跑命令与实测输出（本席终端，亲跑）

```bash
# 1) 真浏览器行为验收（脚本自起桩 + serve.js，跑完收进程；145 条断言）
bash evidence/test/P003-T016/e2e-behavior.sh
#    → PASS=145 FAIL=0   EXIT=0    全量日志 evidence/test/P003-T016/e2e-final.txt

# 2) 回归兜底（写者单测，本席亲跑）
cd web && node --test
#    → tests 396 / pass 396 / fail 0 / duration_ms 4917   EXIT=0

# 3) 变异验红（产品侧，刀落在 /tmp 副本，工作树零改动）
#    刀：web/pages/trace-board.js:711 把 `!state.reveal.playing && state.reveal.count >= steps.length`
#        复原成旧写法 `!state.reveal.playing`（= 第一轮那个「暂停后继续死按钮」）
cd /tmp/gc-r2-mut/web && node --test test/pages/trace-board.test.js
#    → tests 32 / pass 31 / fail 1（正是「A4 暂停 / 继续」用例，test/pages/trace-board.test.js:368）
bash /tmp/gc-r2-mut/evidence/test/P003-T016/e2e-behavior.sh
#    → PASS=138 FAIL=7   EXIT=1
#    红：[暂停中「继续」可点] [点「继续」之前按钮确实可点] [点「继续」接着播]
#        [继续后播完] [继续后跳数比暂停时多（2→4）] [播完「跳到最新」一起禁用] [播完 4 跳 3 线]
#    日志 evidence/test/P003-T016/e2e-mutation-pause-red.txt

# 4) 测试侧自变异（证明 A5 正向锚点不是永真）
#    刀：把 A5 段的 nav 目标从白板页改成列表页（只改 /tmp 副本里的测试脚本，不碰产品）
bash /tmp/gc-r2-a5mut/evidence/test/P003-T016/e2e-behavior.sh
#    → PASS=141 FAIL=4   EXIT=1
#    红：[A5 前置正向锚点] [A5 前置链长] [A5 前置 4 个跳] [A5 白板页 input/textarea 计数 0]（列表页有 1 个筛选输入框→探针有牙齿）
#    日志 evidence/test/P003-T016/e2e-mutation-a5-anchor.txt

# 5) 还原复绿（工作树从未被变异过，跑一遍证明树是绿的）
bash evidence/test/P003-T016/e2e-behavior.sh
#    → PASS=145 FAIL=0   EXIT=0    日志 evidence/test/P003-T016/e2e-after-restore.txt
git diff --stat -- web/     # 空（产品代码零改动）
```

数对账：`145 = 138 + 7`（变异）/`145 = 141 + 4`（A5 自变异）——三份日志同一版脚本、同一棵树（除故意那一刀）。

## 四、六格状态矩阵（全部真浏览器落点）

### 列表页 `#/trace`（`e2e-final.txt:97-126`）

| 格 | 怎么造的 | 实测 |
| --- | --- | --- |
| loading | 桩 `delayMs=1500`＋换路由重挂 | `.table-wrap[aria-busy=true]`；「正在读取溯源…」；刷新 + 四个筛选 5 个控件全 `disabled` |
| empty | 桩 `traceList=empty` | 「暂无溯源」+ 第二句「从告警列表点某一行的…」；分页两键禁用；有筛选时「没有匹配的溯源」+「清除筛选」 |
| partial | 有 8 条后桩切 503，点「刷新」 | `.notice[role=alert]`「刷新失败…（下表是上一次读到的结果）」，**`notice.hidden === false`**；行数保持 8 |
| error | 桩 `traceList=503` | `.page-error[role=alert]`「溯源列表读取失败」+ 原话；**`.page-error` 里有 1 个可见「重试」**，真鼠标点它 → 重新渲染 8 行 |
| long-content | 桩里 65 字长主机 / 长 syslog ID | 主机 `textContent` 与 `title` 都是全文；长 ID 屏上「syslog:revsh…600:aaa1」，`title`/`href` 是全 ID |
| disabled | 单页数据（8/20） | 「上一页」「下一页」都 `disabled`；筛选下推 `?status=failed&offset=0`、1 行 |

### 白板页 `#/trace-board/<ID>`（`e2e-final.txt:127-153`）

| 格 | 怎么造 | 实测 |
| --- | --- | --- |
| loading | `delayMs=1500` | `.canvas[aria-busy=true]`；「正在读取白板…」；刷新 `disabled` |
| empty | `empty:1`（done，hops=[]）/ `empty-running:1`（running，hops=[]） | 已完成：「这条链没有跳」+「接口没有返回链上的跳。」；进行中：「还没有跳」+「任务在跑，新的一跳会自己从左边长出来。」；重放/继续/跳到最新全禁用且不启动 |
| partial | 播完 4 跳后桩切 `traceBoard=fail`，点「刷新」 | `.notice[role=alert]`，**hidden=false**，**可见「重试」= 1（同一探针的正向对照）**；节点数保持 4 |
| error | 桩 `traceBoard=fail` 首屏；另一路 404→POST 422；没带目标 | 画布「白板读取失败」+ 原话（可见）；**DOM 里「重试」rect 0×0 / offsetParent null，可见「重试」= 0**；可见恢复入口 = 顶栏「刷新」1 个、可点，**真鼠标点它恢复画板**；422 带原话；没带目标写「没有指定这一条」且 `/api/trace/` 请求数 **0** |
| long-content | `long:1`（超长标签 + 超长断点原因） | 4 个 `.gnode-label` 都含 60 字全文；`.gap-note` 文本与 `title` 都是全文；页面不横向溢出 |
| disabled | done 白板重放中途暂停 / 播完 / 进行中 / 无跳 | 暂停中「继续」`disabled=false`、2s 不动；点继续 → 文本回「暂停」→ 播到 4 跳；播完「继续」与「跳到最新」一起 `disabled=true`；进行中三键 `hidden=true`（跟随仍可用）；无跳时重放/跳到最新禁用 |

## 五、上轮 fail 项复核：A4 暂停/继续不是死按钮（重点）

真浏览器（1440×900，桩 `revshell:1`，7 步 discovery）实测序列（`e2e-final.txt:56-70`）：

| 步骤 | 实测 |
| --- | --- |
| 打开已完成白板 | 顶栏「已完成 · 链长 4 跳」；自动播到最新，`{t:"继续", d:true, latest:true, nodes:4}` |
| 点「重放」 | 跳数回落到 2（从头播） |
| 点「暂停」 | `{t:"继续", d:false, latest:false, nodes:2}` |
| 静置 2s | 与上一行**逐字相同**（进度真的停住，按钮没死） |
| **点「继续」**（点前先断 `disabled===false`） | 4s 内按钮文本回「暂停」→ 一路播到 4 跳 → `{t:"继续", d:true, latest:true, nodes:4}` |
| 再点「重放」 | 按钮回「暂停」且 `disabled=false` |

与 `web/README.md:645-647` 的禁用矩阵逐条对上；变异成旧写法后这一整段 7 条红（§三第 3 步），证明断言不是永真。

断点常显：没点任何节点时 `.gap-note` 已在图上（文本 + `title` 全文，`pointer-events:none`），顶栏「断点 1 处」。

## 六、视觉作证

两种视口：**1440×900** 与 **390×844**（`innerWidth×innerHeight` 实测值断言）。截图 8 张，脚本每次重跑覆盖：

`1440-trace-list.png`（8 行七列）、`1440-trace-board-paused.png`（重放中途暂停态，「继续」可点）、
`1440-trace-board-done.png`（4 跳 3 线 + 断点）、`1440-trace-board-running.png`（进行中三键 hidden）、
`1440-trace-board-error.png`（首屏失败：画布文案 + 原话；**画布里没有可见「重试」，恢复靠顶栏「刷新」——见 F1**）、
`1440-trace-board-long.png`、`390-trace-list.png`（表格在 `.table-wrap` 内横滚 737>362）、`390-trace-board.png`（4 点都在、无整页横溢）。

## 七、发现

### F1（**major**，文档与实现不符，不是措辞问题）：白板首屏错误态画布里没有可见的「重试」

- 文档出处：`web/README.md:641`（§12.4 白板状态矩阵 · 错误格）——「画布『白板读取失败』+ 服务端原话 + 『重试』」；`README.md:639` 的断言要点同样按「画布内」口径。
- 文档说：这三样都在画布这一格里，用户在那里点重试。
- 实测（桩 `traceBoard=fail`，开 `#/trace-board/revshell%3A1`）：
  - 画布内**只有**「白板读取失败 + 桩原话」（这两样在，可见）；
  - 页面上**可见的「重试」数量 = 0**；DOM 里那一个「重试」在 `.notice` 里，`hidden=true`、`offsetParent=null`、`rect 0×0`（探针把祖先链都打了：`.notice` 的 computed `display:none`）；
  - 用户真正能点的恢复入口是**顶栏「刷新」**（可见 1 个、`disabled=false`；用真鼠标坐标点它，画板恢复）；
  - 刷新失败（partial）时「重试」才可见（同一探针数出 1 个）——所以这不是「探针不灵」，是首屏错误态真的没给。
- 复现：`bash evidence/test/P003-T016/e2e-behavior.sh` 白板 error 段（`e2e-final.txt:140-146`）；或桩 `traceBoard=fail` 后开上面的 hash。
- 影响：照文档写「画布里有重试」的用例必然落空；用户遇到首屏失败时，画布里没有可点的出口，要自己去找顶栏「刷新」。这不是 doc-side 措辞——文档承诺的控件在该场景不存在。
- 建议（写者二选一，我不改产品）：
  1. 实现侧：首屏错误态在画布里给一个可见的「重试」（现在那个 hidden 的 `.notice` 重试要么露出来、要么画布里补一个），并保证 `offsetParent!==null`；
  2. 文档侧：`README.md:641` 错误格改写「画布：白板读取失败 + 服务端原话；恢复用顶栏『刷新』；『重试』只在刷新失败 notice 里」，并把断言要点改成「可见控件口径」。
  改完这条，我这边 §四 的白板 error 格断言按文档新口径重跑即可（现断言已按实测钉住可见性，改哪边都能落地）。

### 观察（不立卡）

- 从一条白板直接切到另一条时，画布保留上一条的链并叠加「正在读取白板…」，新板到了才换——文档没规定这块。
- 列表页「清除筛选」在筛选条与空态里各一个（都叫「清除筛选」），文案断言会命中两个；不是缺陷。

## 八、残余风险

1. 桩后端不是真后端：真实 401 / 503 / 422、syslog 形态 target 的实际起板、牧云 / 模型链路都没验（本机没凭据）。
2. 进行中是 5s 轮询：桩只模拟「一次增长」，真实节奏与后端断连后的表现未验。
3. 位置记忆在 `localStorage`（文档 12.9 已记）：换机 / 清缓存会丢，这是接口没有写位置入口的已知限制。
4. 视觉比对是 DOM 几何量 + 截图：像素级对照未做（本模型无视觉）。
5. 白板空态「接口没有返回链上的跳。」这一句 README §12.4 只写了第一句（「这条链没有跳」）；我按实测把第二句也钉住了，算**实现文案锚点**，文档要不要补这句由写者定（与 F1 一起处理更省事）。
6. 本卡不是迁移/删除任务，旧位目录那条不适用。

## 九、复跑清单（跑完自己收进程；脚本 trap 会 kill 桩与 serve，并 `agent-browser close`）

| 命令 | 期望 |
| --- | --- |
| `bash evidence/test/P003-T016/e2e-behavior.sh` | `PASS=145 FAIL=0`，exit 0 |
| `cd web && node --test` | 396/396，exit 0 |
| 变异（`/tmp` 副本，`:711` 复原旧写法） | 守卫 31/1、e2e `138/7`（全在 A4 暂停/继续链） |
| A5 自变异（`/tmp` 副本，A5 停在列表页） | e2e `141/4`（正向锚点与输入框计数红） |
