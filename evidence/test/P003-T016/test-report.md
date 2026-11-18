# P003-T016 前端验收报告 · 江屿（gc-frontend-tester）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T016`；分支 `task/hids-ai-console-P003-T016`；**HEAD `90066b3`**
- 审查判词（本轮）：`G-005bb2124108/verdicts/P003-T016-gc-frontend-code-review-mwmln2q3.json`（pass；作废旧卷 mwmliwu7）
- 本轮与上轮唯一差异：`web/README.md:645-647`（§12.4 白板禁用矩阵补「暂停中『继续』可点、播完才禁」），代码零改动（`git diff f683c28..90066b3 --stat`：1 file，+2 −1）
- 被测文档：`web/README.md` §4 / §12（12.1–12.9）+ 任务卡 A1–A5 + `openapi.yaml:456-560`、`:1695-1815` 的形状
- **没读实现源码**：断言全部照 README 写的文案 / 选择器 / 字段口径；文里出现的实现坐标（`trace-board.js:709-712`）来自公开判词，不是我翻源码得的

## 一、结论

| 项 | 结果 |
| --- | --- |
| A1 进去先是列表，点一行才进这一条 | **pass**（12 条断言；含键盘 Tab→Enter） |
| A2 告警列表每行带 ID 打开或创建溯源 | **pass**（告警列表 4 行 4 个「溯源」；告警详情「深度溯源」；404→POST 创建；422 带原话） |
| A3 告警在右 / 原因往左 / 可拖 / 位置记住 / 不能加点加线 | **pass**（左移间距逐列 190px；真鼠标拖点写 localStorage；reload 后不弹回；告警点拖不动；双击画布不加点） |
| A4 进行中往左长 / 完成后按 discovery 重放 / 断点常显 | **pass**（5s 轮询 2→3 跳；重放暂停/继续不是死按钮；播完才禁；断点不点开可见；失败/中断停在原地写原因） |
| A5 没有对话输入框 | **pass**（白板页 input/textarea/contenteditable 计数 0；无发送/提问按钮） |
| 六格状态矩阵 | 列表 **6/6**、白板 **6/6** 全部有真浏览器落点 |
| 门禁回归 | `cd web && node --test` → tests 396 / pass 396 / fail 0（本席亲跑） |
| 变异验红 | 亲手两刀：把暂停/继续的禁用条件复原成旧写法 → 写者守卫恰红 1 条、我的 e2e 恰红 4 条；还原复绿 32/32 与 124/0 |
| 上一轮 major（「暂停后继续」死按钮） | **已修，真浏览器亲验**（见 §五） |
| 新发现 | 1 条 minor（doc-side 措辞，不阻塞）；2 条观察不立卡 |

**判：PASS。** 本轮唯一改动是文档，实测与文档口径一致；代码面 0 改动，上轮的浏览器结论在本轮树上重跑仍然成立。

## 二、环境与引擎（如实交代三件事）

1. **lightpanda 不在本机**（`find / -maxdepth 5 -name 'lightpanda*'` 为空）。按「只测行为 → lightpanda」本应走它，
   退而全程用 **agent-browser 0.41.2**（真 Chrome，`--args --no-sandbox`）；行为测与截图同引擎。
2. **桩后端是本席自建**：`evidence/test/P003-T016/stub-api.mjs` + `stub-trace.mjs`（形状逐字照 `openapi.yaml` 的
   TraceBoardSummary / TraceBoard / Hop / Link / Gap / Discovery；全量请求日志 + 故障注入 + 延迟注入）。
   **它不是真后端**：本机没有牧云 / 模型凭据，真数据链路没验（同写者未决 6）。
3. **截图能拍但本模型读不了图**（无视觉）：视觉作证一律用 DOM 几何量（`getBoundingClientRect` / `style` / 计算样式），
   截图存 `shots/` 供人眼复核。

## 三、复跑命令与实测输出（都在本席终端里跑出来的）

```bash
# 1) 真浏览器行为验收（自己起桩 + serve.js，跑完收进程；124 条断言）
bash evidence/test/P003-T016/e2e-behavior.sh
#    → PASS=124 FAIL=0   EXIT=0（全量日志：evidence/test/P003-T016/e2e-final.txt）

# 2) 回归兜底（写者单测，本席亲跑，未转录任何人）
cd web && node --test
#    → tests 396 / pass 396 / fail 0 / duration_ms 4880   EXIT=0

# 3) 变异验红（改一行实现 → 看守卫红 → 还原）
#    变异落在 web/pages/trace-board.js:711（暂停/继续的 disabled 条件）：
#    把 `state.reveal.count >= steps.length` 换成 `true`，= 复原第一轮那个「暂停后继续死按钮」
node --test test/pages/trace-board.test.js   # → pass 31 / fail 1
#    唯一红：A4 暂停 / 继续：暂停后「继续」还能按（不是死按钮）…
bash evidence/test/P003-T016/e2e-behavior.sh # → PASS=113 FAIL=4（全红在暂停/继续链上，其余照绿）
#    日志：evidence/test/P003-T016/e2e-mutation-pause-red.txt
git checkout -- web/pages/trace-board.js     # 还原
node --test test/pages/trace-board.test.js   # → 32/32 绿
bash evidence/test/P003-T016/e2e-behavior.sh # → PASS=124 FAIL=0（e2e-after-restore.txt）
git diff --stat                              # 空（工作树还原干净）
```

变异记录里如实补一句：第一刀我先落在 `:709`（「跳到最新」的禁用条件）改成 `true`，单测仍 32/32 **没红**——
因为这一刀只把按钮改得更严（播完禁用照样成立），不是守卫面；随后才把刀落到 `:711` 并得到上面的恰红。
「跳到最新」两头的守卫由我的 e2e 钉着：暂停中断言 `latest.disabled === false`、播完断言 `=== true`。

## 四、六格状态矩阵（全部真浏览器落点，不是单测转录）

### 列表页 `#/trace`

| 格 | 怎么造的 | 实测 |
| --- | --- | --- |
| loading | 桩 `delayMs=1500`＋换路由触发重挂 | `.table-wrap[aria-busy=true]`；表体「正在读取溯源…」；刷新 + 四个筛选 5 个控件全 `disabled` |
| empty | 桩 `traceList=empty` | 「暂无溯源。从告警列表点某一行的『溯源』……」；分页两键禁用；有筛选时变「没有匹配的溯源。」+「清除筛选」，清完回 8 条 |
| partial | 已有 8 条后把桩切 503，点「刷新」 | `.notice[role=alert]`「刷新失败…（下表是上一次读到的结果）」；行数保持 8 |
| error | 桩 `traceList=503` | `.page-error[role=alert]`「溯源列表读取失败 + 服务端原话 + 重试」；点「重试」再发一轮并渲染回 8 条 |
| long-content | 桩里一条 65 字长主机 / 一条 syslog 长 ID | 主机 `textContent` 与 `title` 都是全文（`.od-truncate` 只缩显示）；长 ID 屏上「syslog:revsh…600:aaa1」，`title` 与 `href` 是全 ID |
| disabled | 单页数据（8/20） | 「上一页」「下一页」都 `disabled`；筛选一次 `?count=20&offset=0&status=failed` 下推、1 行 |

### 白板页 `#/trace-board/<ID>`

| 格 | 怎么造 | 实测 |
| --- | --- | --- |
| loading | `delayMs=1500` | `.canvas[aria-busy=true]`；「正在读取白板…」；刷新 `disabled` |
| empty | `empty:1`（done，hops=[]）/ `empty-running:1`（running，hops=[]） | 「这条链没有跳 接口没有返回链上的跳。」/「还没有跳 任务在跑，新的一跳会自己从左边长出来。」；重放/继续/跳到最新全禁用且不启动 |
| partial | 播完 4 跳后桩切 `traceBoard=fail`，点「刷新」 | `.notice[role=alert]`（刷新失败 + 重试）；节点数保持 4 |
| error | 桩 `traceBoard=fail` 首屏；另一路 200 但形状不对 | 画布「白板读取失败 + 桩原话」＋上方 notice 里的「重试」，点重试恢复画板；形状不对写「服务返回的形状不对。」；**没带目标**写「没有指定这一条」且 `/api/trace/` 请求数 **0** |
| long-content | `long:1`（超长标签 + 超长断点原因） | 4 个 `.gnode-label` 都含 60 字全文；`.gap-note` 文本与 `title` 都是全文；页面不横向溢出 |
| disabled | done 白板重放到第 4/7 步暂停 / 播完 / 进行中 / 无跳 | 暂停中「继续」`disabled=false`、2s 进度不动；点继续 → 第 5/7 → 7/7；播完「继续」与「跳到最新」一起 `disabled=true`；进行中三键 `hidden=true`（跟随仍可用）；无跳时重放/跳到最新禁用 |

## 五、上一轮 fail 项复核：A4 暂停/继续不是死按钮（重点）

真浏览器（1440×900，桩 `revshell:1`，7 步 discovery）实测序列：

| 步骤 | 实测 |
| --- | --- |
| 重放至第 4/7 步点「暂停」 | `{prog:"第 4 / 7 步", t:"继续", d:false, latest:false}` |
| 静置 2s | 与上一行**逐字相同**（进度真的停住，按钮没死） |
| 点「继续」 | `{prog:"第 5 / 7 步", t:"暂停", d:false}` → 一路走到第 7/7 步 |
| 播完 | `{prog:"第 7 / 7 步", t:"继续", d:true, latest:true}`，节点 4、线 3 |
| 再点「重放」 | 回「第 0 / 7 步」、按钮回「暂停」且可点 |

与 `web/README.md:645-647`（本轮补的两行）逐条对上：暂停只是停定时器、按钮不禁；`count >= steps.length`（播到最新）才把
「继续」与「跳到最新」一起禁用。与写者守卫用例 `web/test/pages/trace-board.test.js:358-381` 的三段断言口径一致。

断点常显：没点任何节点时 `.gap-note` 已在图上（文本「上一步没有了 · HIDS 上只保留 7 天进程谱系…」，`title` 全文，
`pointer-events:none`），状态栏「断点 1 处」。

## 六、视觉作证

两种视口：**1440×900** 与 **390×844**（`window.innerWidth×innerHeight` 实测值断言过）。截图 8 张：

| 文件 | 内容 |
| --- | --- |
| `1440-trace-list.png` | 列表 8 行、七列、四值状态 |
| `1440-trace-board-paused.png` | 第 4/7 步暂停态（「继续」可点，本轮重点） |
| `1440-trace-board-done.png` | 播完 4 跳 3 线 + 断点注释 |
| `1440-trace-board-running.png` | 进行中（三键 hidden） |
| `1440-trace-board-error.png` | 首屏失败（画布 + 重试） |
| `1440-trace-board-long.png` | 超长标签 / 断点原因 |
| `390-trace-list.png` | 窄屏：页面无整页横滚（`scrollWidth == clientWidth == 390`），表格在 `.table-wrap` 内横滚（737 > 362，`overflow-x:auto`） |
| `390-trace-board.png` | 窄屏白板：无整页横溢，4 个点都在 |

## 七、发现

### F1（minor，doc-side）：白板错误格的「重试」不在画布里

- 文档出处：`web/README.md` §12.4 错误格（web/README.md:641）——「画布『白板读取失败』+ 服务端原话 + 『重试』」。
- 文档说：三样都在画布这一格里。
- 实测：画布内只有前两样（「白板读取失败」+ 服务端原话）；「重试」按钮在画布**上方** `.notice[role=alert]` 里
  （页面上可见、可点、点了能恢复，行为没问题）。
- 复现：`bash evidence/test/P003-T016/e2e-behavior.sh` 白板 error 段；或桩 `traceBoard=fail` 后开 `#/trace-board/revshell%3A1`。
- 影响：照字面写「画布里有重试」的断言会落空；不改代码，改一句文档即可。
- 建议：§12.4 错误格改成「画布写『白板读取失败』+ 服务端原话；画布上方 notice 给『重试』」。

### 观察（不立卡）

- 从一条白板直接切到另一条时，画布保留上一条的链并叠加「正在读取白板…」，新板到了才换——文档没规定这块，不算不符。
- 列表页「清除筛选」在筛选条与空态里各有一个按钮（都叫「清除筛选」），文案断言会命中两个；不是缺陷。

## 八、残余风险

1. 桩后端不是真后端：真实 401 / 503 / 422、syslog 形态 target 的实际起板、牧云 / 模型链路都没验（本机没凭据）。
2. 进行中是 5s 轮询：桩只模拟「一次增长」，真实节奏与后端断连后的表现未验。
3. 位置记忆在 `localStorage`（文档 12.9 已记）：换机 / 清缓存会丢，这是接口没有写位置入口的已知限制。
4. 视觉比对是 DOM 几何量 + 截图：像素级对照未做（本模型无视觉）。
5. 本卡不是迁移/删除任务，旧位目录那条不适用。

## 九、复跑清单（跑完自己收进程；脚本 trap 会 kill 桩与 serve，并 `agent-browser close`）

| 命令 | 期望 |
| --- | --- |
| `bash evidence/test/P003-T016/e2e-behavior.sh` | `PASS=124 FAIL=0`，exit 0 |
| `cd web && node --test` | 396/396，exit 0 |
