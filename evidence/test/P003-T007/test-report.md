# P003-T007 · 前端测试报告（江屿 / gc-frontend-tester）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T007`
- 被测 HEAD：`e77043a`（写者实现 `adc6889` + 报告 `deb1961` + 上一棒测试证据 `e77043a`）
- 会话：`p003t007-e2e`（agent-browser 0.41.2，Chrome 157，真浏览器）；装置端口全部 `127.0.0.1` 临时端口，退出回收
- 判据：任务卡 acceptance A1–A5 + 前端验收四样（真浏览器 / 六格 / 交互 / 双宽度截图）

## 一、结论

**PASS。** A1–A5 全部在真浏览器里亲手走到并断言成立；六格状态、键盘路径、两档视口截图都有证据。
本轮没有产品缺陷发现（findings 为空）。测试侧修了一条工具投递故障（K.1，见 §四），并复现了变异验红（§五）。

## 二、亲跑门禁（本终端，日志在 evidence/test/P003-T007/）

| # | 命令（cwd = 本树） | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| G1 | `cd web && npm test` | 0 | `tests 327 / pass 327 / fail 0`（duration 4.7s） | `web-npm-test.log` |
| G2 | `node evidence/test/P003-T007/e2e-checks.mjs` | 0 | `合计 28 条：pass 28 / fail 0` | `e2e-run-211800-1.log` |
| G3 | 同上（连跑第二次，验不 flake） | 0 | `合计 28 条：pass 28 / fail 0` | `e2e-run-211837-2.log` |
| G4 | 变异验红 + 还原复绿（§五） | 0 | 变异红 / 还原绿 / `git diff` 空 | `mutation-211950.log` |

- 装置：`evidence/test/P003-T007/harness.mjs`——`web/serve.js`（真）→ facade → 真 `server.js` → 假牧云 `/rpc`；
  知识库用 `wiki/` 的 `/tmp` 副本（真 `WikiStore`，409/400 是 store 真抛的）。
  **唯一的文档契约替身**是研判记录两条读接口（`GET /api/agent/triage/{id}`、`GET /api/agent/investigations/{id}`），
  字段逐条照 `openapi.yaml` 的 `TriageCase / TriageEvidence / ClaimCitation` 造——本机没有模型与牧云，这一条写在残余风险里。
- 每条断言都从用户入口走（登录表单 → 侧栏 → 表格/下拉/编辑区），读屏幕文字、可访问名、属性、计算样式与 facade 侧真实请求日志。

## 三、验收逐条（我看到的，不是写者报告抄的）

| 验收项 | 用例 | 实测证据（摘） |
| --- | --- | --- |
| A1 筛选真参数 | A1.1–A1.6 | 无筛选请求 `?count=20&offset=0&sort=time`；`type=webshell`→4 条 +「筛选后 4 条」+ 清除按钮出现；`level=critical`→1 条且与 type 同请求；`q=WebShell`→4 条、清空后不再发 `q`；**时间范围只发 `from`、不发 `to`**（from = 24h 前，差 1440 分钟；近 24h→6 条，排除 26h 前与 8 天前）；`verdict=threat`→0 条时「没有匹配的告警」+ 空态清除可退出；`triage_status=not_queued`→8 条 |
| A2 真 sort | A2.1–A2.3 | 点「等级」→ `sort=level`、行序 严重→高危×2→中危→低危、`aria-sort` 从 time 换到 level + `↓`；同列再点 **0 条请求**、顺序不变（接口无方向参数，文档口径）；点「时间」→ `sort=time` + 回时间倒序 |
| A3 证据链逐条 + citation 对账 | A3.1–A3.4 | 证据来源「共 3 条」；两个 `tool` 组 `list_host_events 2 条` / `list_firewall_connection_records 1 条`，前两组 `open`；条目三列 `cw:1 / sha256 aaaaaaaaaaaa / 20:20:37`（`title` 给 64 位全值）；claim 引用 `cw:1`、`mcp:3` 正常色，`cw:99` 带 `is-missing` + 换色（rgb(157,58,43)）+「1 处引用在证据条目中找不到」+ 脚注「证据链不完整」；`evidence[]` 为空时 0 组、脚注「接口只返回了证据来源数量，没有条目明细。」 |
| A4 知识库 PUT + 409/400 | A4.1–A4.4 | 保存改走 **PUT `/api/wiki/pages/common/GEN-12.md`**：磁盘落盘含新小节、front matter `---` 与 `id: GEN-12` 保留、`revision c9dacfa5… → 587afa43…`、界面「已保存到服务器」且全文无「本地草稿/保存草稿」；**别人先改**→409 冲突条 +「刷新正文」、编辑区 857 字保留、**不写盘**、服务端 revision 不变；正文 30050 字→400 显示服务端原话「页面正文必须为 1 到 30000 字」、编辑内容保留、只发一次 PUT；脏态点侧栏→「保存并离开」PUT 成功才离开、磁盘可见 |
| A5 侧栏身份 | A5.1 / A5.2 | 登录 `ops` 后账号区 `O / ops / 值守账号`（operator→值守账号）；回包 `user/role = null` 时账号区不可见、无文字（不编名字） |

六格状态矩阵：`M.loading`（`aria-busy=true` +「正在读取告警…」+ 刷新与 6 个筛选控件 disabled）、`M.empty`（「暂无告警。」+ 分页/全选 disabled + 共 0 条）、
`M.partial`（逐类列原因，列表照常）、`M.truncated`（扫描窗口提示条出现/未截断隐藏）、`M.error`（401 → `role=alert`「登录已失效」+ 重试，恢复后点重试列表回来）、
`M.long`（186 字标题 `text-overflow:ellipsis` 且 `textContent`/`title` 是全文）、`M.degrade`（队列状态单独失败只降级队列条）。

交互与视觉：`K.1` 键盘 Tab 链 = 搜索框 → 五个下拉 → 全选 → 「等级」按钮，Enter 真触发 `sort=level` 请求；
`V.1` 1440×900 与 390×844 两档截图（`shots/`）：390 宽 `scrollWidth === innerWidth === 390`、搜索框独占一行、账号区按稿 ≤900 隐藏。

## 四、测试侧修复（A 类：测试自身问题，不是产品缺陷）

整套跑到后半程，`Tab` 会静默丢失：页面 **keydown 计数恒 0**、`document.hasFocus()` 仍是 `true`；`ab close` 后重开同一页面 k=1、焦点照走。
即按键根本没投递到页面——不是应用的焦点陷阱（后者会是「收到 keydown 但焦点不动」，K.1 的链式断言会照红）。

处置（都在测试文件里，没碰产品代码）：
1. `K.1` 改用 CDP `Input.dispatchKeyEvent`（先 `Target.activateTarget` 激活页面），Enter 补 `char` 事件（按钮激活走 keypress 阶段）；
2. `K.1` 换一轮干净的浏览器会话（close → open → 重新登录 → 进告警），跑完把排序复位到时间列；
3. 键盘判据仍然在断言里：重试 4 次仍收不到 keydown 才抛「环境问题」，收到 keydown 但焦点不动会照常红。

复现记录：修前整套 `--only=M.loading,K` / `--only=M.empty,K` 稳定红（k=0），单独 `--only=K` 稳定绿；修后连跑两遍整套 28/28（G2/G3）。

## 五、变异验红（锚点不是永真）

在本树产品源码上做**临时**变异 → 跑对应用例 → 还原 → 复绿，`git diff` 为空（`mutation-211950.log`）：

| 变异 | 变异后 | 还原后 |
| --- | --- | --- |
| `web/src/alerts.js`：`triage_status: page.triageStatus` → `triage_statusX: …`（模拟筛选参数下推写错） | A1.6 **红**：`请求应带 triage_status=not_queued，实测 ?…&triage_statusX=not_queued&sort=time` | A1 六条全绿 |
| `web/pages/alert-detail.js`：缺失引用标记 `is-missing` → `isok`（模拟 A3 对账没标出来） | A3.3 **红**：`对不上的引用应换色（正常 rgb(102,93,80) / 缺失 rgb(102,93,80)）` | A3.3 绿 |

## 六、残余风险

1. **A3 的数据源是文档契约替身**：本机没有模型凭据与牧云，`triage.evidence[]` / `claims[].citations[]` 按 `openapi.yaml` 造，
   真实「模型跑完一次研判」的端到端没有覆盖；替身若与实现漂移，这条要重跑。
2. **agent-browser 键盘投递在长会话里会哑**（§四）：已用 CDP + 干净会话绕开，但这是工具侧风险，不是应用行为。
3. 队列条在本装置里恒为「状态不可用」（真 `server.js` 没配自动研判），`M.degrade` 验的是降级口径，不是正常态队列数字。
4. 升序排序、结果计数分母（`N / 总数`）按文档口径不做，未验——它们不在 acceptance 里。
