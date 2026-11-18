# P003-T015 前端验收报告 · 江屿（gc-frontend-tester）

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T015`
- **本轮（复审轮）HEAD `602b5b1`**；上一轮报告覆盖 `aab721e`，本轮两条 findings 已修，本文件按 `602b5b1` 重写复验部分。
- 审查判词（本轮）：`verdicts/P003-T015-gc-frontend-code-review-mwmjpb6f.json`（pass）
- 审计判词（上一轮，三条 issue 出处）：`G-2902ab74e069/verdicts/P003-T015-gc-frontend-test-review-mwmj7dcn.json`
- 被测文档：`web/README.md` §4 / §9 / §10.5 / §10.7 / §11（+ 任务卡 A1–A4）；接口形状照 `openapi.yaml`
- **没读实现源码**。用到的实现坐标只有「符号名 + 路径 + 行号」（`SOURCE_KEYS` / `.table-wrap` / `filter-host` / `loadSeq` / `quiet`），
  给 findings 定位、给变异下刀用；DOM 断言一律照 README 写的选择器与文案。

## 一、结论（复审轮）

| 项 | 结果 |
| --- | --- |
| F1（上轮 finding 1）整页横滚收进 `.table-wrap` | **通过**：六档视口 `doc.scrollWidth == clientWidth`；包裹层 `overflow-x:auto`；390 下可右滚 276px 到「操作」列 |
| F2（上轮 finding 2）主机筛选逐键取数 / 回车不重复 | **通过**：键入 `1.2.3.4` = 7 轮；回车零轮新增；失焦零轮；逐键在途不清表不禁用不丢焦点；慢的旧响应不覆盖新结果 |
| A1–A4 四条验收锚点 | **未动且全绿**（本轮 e2e 102/0，含 A1 六源 `/api/alerts=0`、A2 误报全链路、A3 详情四块、A4 演示入口隔离） |
| 六格状态矩阵 | 告警主列表 7/7、总览 6/6、详情 3/3 **全部有真浏览器落点**（上轮口径虚报的两格本轮补进 e2e） |
| 变形验红（本席亲手四刀） | 每刀只红对应断言，其余照绿，还原后复绿 30/0 |
| 上一轮审计三条 issue | **本席已在本轮一并补掉**（详见 §九.5） |
| 新发现 | 无 in-scope 缺陷。三条观察（§七），都不阻塞、不立卡 |

判：**PASS**。两条 findings 的修复判据都是实测绿，且断言有作证力（变异恰红）。

## 二、环境与引擎（如实交代三件事）

1. **lightpanda 不在本机**（`~/.local/bin/` 与 `find / -maxdepth 4 -name 'lightpanda*'` 都空）。按「只测行为 → lightpanda」应走它，退而用 agent-browser（真 Chrome 驱动）；行为测与截图同引擎。
2. **桩后端仍是本席自建**（`evidence/test/P003-T015/stub-api.mjs`，形状照 openapi；全量请求日志 + 故障注入）。
   本轮给它加了 `delayByHost`（按 `?host=` 注入延迟），用来造「旧响应晚到」。**它不是真后端**：本机没有牧云/模型凭据，真数据链路未验（同写者未决 6）。
3. **截图能拍但本模型读不了图**（无视觉）：视觉比对一律用 DOM 几何量，截图存 `shots/` 供人眼复核。

## 三、复跑命令（都在本夹里，跑完自己收进程）

```bash
# 1) 回归兜底：行为验收（本轮 102 条断言；自起桩 + serve.js）
bash evidence/test/P003-T015/e2e-behavior.sh          # → PASS=102 FAIL=0  EXIT=0

# 2) 复审轮独立复验：F1 六档横滚 + F2 主机筛选四件事（自起桩 + serve.js，端口 18100/13016）
bash evidence/test/P003-T015/verify-round2.sh         # → PASS=30 FAIL=0  EXIT=0

# 3) 边角探针（吸顶代价 / 表单被逐键关掉 / 刷新中打字 / 慢响应跨页）
bash evidence/test/P003-T015/probe-round2.sh

# 4) 视觉作证 + 断点探针（1440×900 / 390×844 + 1180/900/620，出 shots/*.png）
bash evidence/test/P003-T015/shots.sh                 # → PASS=34 FAIL=2  两红都是卡外的详情@390
```

本轮实测输出（本席终端）：

```
$ bash evidence/test/P003-T015/e2e-behavior.sh   → PASS=102 FAIL=0   EXIT=0
$ bash evidence/test/P003-T015/verify-round2.sh  → PASS=30  FAIL=0   EXIT=0
$ bash evidence/test/P003-T015/shots.sh          → PASS=34  FAIL=2   EXIT=1
     2 条 FAIL 都是「告警详情@390 被页内顶栏撑宽 484/390」——P002-T004 的旧样式，卡外（§六.3）。
     上一轮同一脚本 7 红，本卡的 5 条（告警主列表@1180/620/390、误报表单@390）已全绿。
```

单测（`cd web && node --test`，写者口径 370/0）**我没有跑、也不用它判本卡**——单测归写者、在编码阶段跑完（D045）；
本席只认浏览器行为与请求日志。

## 四、F1/F2 逐条实测（复审轮专章）

### F1 页面不横滚、横滚收在包裹层（六档视口，`verify-round2.sh`）

| 视口 | doc.scrollWidth / clientWidth | 包裹层 overflow-x | 表宽 / 包裹层可视宽 | 结论 |
| --- | --- | --- | --- | --- |
| 1440 | 1440 / 1440 | auto | 1188 / 1188 | 装得下，不横滚 |
| 1280 | 1280 / 1280 | auto | 1028 / 1028 | 装得下，不横滚 |
| 1180 | 1180 / 1180 | auto | 1008 / 928 | **由包裹层横滚**（页面不动） |
| 900 | 900 / 900 | auto | 860 / 860 | 装得下，不横滚 |
| 620 | 620 / 620 | auto | 638 / 592 | **由包裹层横滚** |
| 390 | 390 / 390 | auto | 638 / 362 | **由包裹层横滚** |

390 下把 `wrap.scrollLeft = scrollWidth`：实测 `scrollLeft=276/276`，末列表头「操作」右边界 376 ≤ 包裹层右边界 376
→ **最后一列真的够得着**（不是「滚不动但页面不宽」的假绿）。截图 `shots/r2-390-alerts-scrolled.png`。

### F2 主机筛选（`verify-round2.sh`，请求数出自桩后端请求日志）

- **逐键一轮**：`typename` 打 `1.2.3.4`（7 个字符）→ `triage/cases` **7 轮**，最后一轮 path 带 `host=1.2.3.4`；
  表体切「没有匹配的研判记录」，输入框 `disabled=false`。
- **回车零轮**：再按 Enter → `cases` 轮数不变（7 → 7）。另在 e2e 里同样断言（102 条里的「F2 §10.5」三条）。
- **失焦零轮**：值没变时 blur → 轮数不变。
- **quiet（不清表/不禁用/不丢焦点）**：`delayMs=1200` 造在途，打一个字符后立刻采样：
  `{"rows":4, disabled:false, focus:true, busy:null}` —— 表体还是上一份 4 行、没切「正在读取」，输入框可用、焦点还在框里。
- **loadSeq（旧响应丢弃）**：`delayByHost {"10.0.0.5":1800}` 让旧查询慢、新查询快——先打 `10.0.0.5`（慢），
  再清空改打 `10.0.0.6`（快）；之后 20 次采样（间隔 150ms，覆盖慢响应落地那一刻）**全部**是 `10.0.0.6`，
  最终表体 = `存疑|蜜罐|10.0.0.6`，输入框值仍是 `10.0.0.6`。

## 五、六格状态矩阵（真浏览器逐格；本轮补齐上轮缺的两格）

| 页面 | 格 | 实测（断言在 `e2e-behavior.sh`，本轮 102 条全绿） |
| --- | --- | --- |
| 告警主列表 | loading | 表体「正在读取研判记录…」，`[aria-busy=true]`，可用控件 0 个、刷新 disabled |
| | empty（无筛选） | 表体一行「暂无研判记录。」 |
| | empty（有筛选） | 「没有匹配的研判记录。」+「清除筛选」→ 回 4 行 |
| | **partial**（本轮新增落点） | `triage/status` 503：队列条降级 `[data-role=qerror]` 可见、列表 4 行照常、本页仍不发 `/api/alerts` |
| | **error**（本轮新增落点） | `cases` 503：`[role=alert]` 写「服务端没有启用自动研判」+「重试」按钮 → 点后回 4 行 |
| | long-content | 主机格 `od-truncate`，`title` 带 253 字命令全文，显示只有 `10.0.0.5` |
| | disabled | 排队行「标为误报」disabled + `title="研判还没结束，不能登记误报"`；已误报行「误报」disabled |
| 总览 | loading | `aria-busy=true`、刷新 `is-loading`+disabled、四数全「—」 |
| | empty | `type_counts={}`：类型表「暂无告警数据」、四数 0 |
| | partial | `triage` 源 503：顶部 warn 写「研判聚合」、摘要区「—」、运行状态那几行照常（r-41） |
| | error | 六源全 503：`role=alert`、数值全「—」、刷新按钮**存在且可点**（本轮改成先断存在再断 disabled） |
| | long-content | `last_error` 290 字 + 提示词版本 151 字：`dd` 文本与 `title` 都是原值、带 `od-truncate` |
| | disabled | 刷新在途 disabled |
| 详情 | partial | 牧云 502 → 题干写原因、正文照常（h1 仍是「告警详情」） |
| | 未命中分支 | `rego.status='none'` → 「没有套上」，不发 `/api/rules/*` |
| | 未找到 | `#/alert-detail/`（无 ID）→「没有找到这条告警 / 链接里没有告警 ID。」+ 返回入口 |

## 六、findings（上一轮回注的两条，本轮复验已闭）

### 1) major（**已修、已验证**）· `.table-wrap` 缺 `overflow-x` 导致整页横滚

- 文档出处：`web/README.md:410-411`（新增四列列宽）+ `web/README.md:908-911`（窄屏兜底口径）；本轮补进 `web/README.md` §10.7。
- 上一轮实测：1180 → `1232/1180`（+52）、620 → `652/620`、390 → `652/390`（+262）。
- **本轮实测（`verify-round2.sh`）**：六档 `doc.scrollWidth == clientWidth`，横滚全部收进包裹层（§四表）。
- 关掉守卫会怎样（本席 M1 刀）：`deleted overflow-x:auto` → 1180/620/390 页面重新被撑宽、六档 `overflow-x=visible`、
  390 末列不可达（scrollLeft 恒 0）—— 断言不是空的。

### 2) minor（**已修、已验证**）· 主机筛选一次回车两轮、逐键不重取

- 文档出处：`web/README.md:394`（§10.5「值一变就 `offset=0` 重取」）。本轮文档同步 §10.5/§10.7。
- 上一轮实测：逐键 0 轮、回车 2 轮。**本轮实测**：逐键 7 轮、回车零轮新增、失焦零轮（§四 F2）。
- 关掉守卫会怎样（本席 M2 刀）：拔掉值闸 → 回车 7 → 9（正好两轮，就是上一轮那个原样）；其余 10 条照绿。

### 3) 观察（**不在本卡改动面**）· 详情页 390 宽被页内顶栏撑宽 94px

- `.detail-page .detail-tools`（`web/assets/pages/alert-detail.css`）单行 flex + `nowrap`：390 视口整页 `484/390`。
  P002-T004 的旧样式，本卡没动。`shots.sh` 本轮 2 条红就是它。要窄屏用详情页得补 `flex-wrap: wrap`。

## 七、观察（只记录，不立卡，不阻塞）

1. **逐键取数会顺手关掉展开中的误报表单**（审查 nit ①，已复现）：在 10.0.0.5 那行点开「误报理由」表单后，
   在主机框打一个字符 → 表单消失（`form[aria-label=登记误报]` = false）。行集本来就在换，属可辩护的既有语义；要用表单时别碰筛选框。
2. **整页刷新在途时打字会被吞**（审查 nit ②，已复现）：点「刷新」（1.2s 延迟）后立刻打 `1.2.3` →
   输入框 `disabled=true`、焦点丢、**已打的字一个不剩**（`val=""`），刷新落地后回 4 行。只在「整页刷新在途」这个窄窗口发生。
3. **表头吸顶代价我没独立复现**：写者称 1440 下 `th.top=-493`（包裹层成滚动容器后 thead 的 sticky 只相对它生效）。
   我用 1440×420 矮视口滚到底，`thTop=129` 表头仍在视口内——桩只有 4 行、页面内容不足一屏，滚不出这个现场。
   所以这一条**我不作为证据**，只认写者/审查的口径（未决 8/9 等拍板）。
4. 慢的旧查询**不会画到别的页上**：`delayByHost` 让 `10.0.0.5` 慢响应在途时跳到总览，等 2.5s——总览仍 `3,5,4,8`、
   无错误横幅（总览上那个常驻空的 `[role=alert]` 基线就在，`text=""`，不是泄漏）。

## 八、变形验红（本席亲手四刀，`/tmp` 副本，仓库未动）

| 刀 | 怎么砍 | 结果 |
| --- | --- | --- |
| M1 | 副本 `.table-wrap` 删 `overflow-x: auto` | F1 段 10 红：1180/620/390 页面被撑宽、六档 `overflow-x=visible`、390 末列不可达；1440/900/1280 的 doc 断言照绿（它们本来就装得下） |
| M2 | 副本拔掉值闸（`value === state.filters.host` 那句） | **只有**「回车零轮新增」红（7 → 9，正好补两轮），其余 10 条绿 |
| M3 | 副本拔掉 `if (seq !== loadSeq) return;` | loadSeq 两条红：20 次采样里 11 次是 `10.0.0.5`、最终表体 `真实威胁|反弹 Shell|10.0.0.5`（输入框还写着 .6）；其余 9 条绿 |
| M4 | 副本把逐键取数改成 `load(true, false)`（关掉 quiet） | quiet 两条红：在途 `{"rows":1, text:"正在读取研判记录…", busy:true, disabled:true, focus:false}`；并连带 5 条红（输入框被禁用后后面的键打不进去） |

四刀跑完删副本、`git status` 只剩 `.pi-child-claim.json` 与本夹（`evidence/test/P003-T015/` 未跟踪）；
再跑 `verify-round2.sh` → **PASS=30 FAIL=0 EXIT=0**（还原复绿）。

## 九、上一轮审计三条 issue 的处置（本席自己的 scope，本轮补掉）

审计判词 `G-2902ab74e069/verdicts/P003-T015-gc-frontend-test-review-mwmj7dcn.json` 打了 fail（打的是证据，不是实现）。
五条里 3 blocker/major + 2 minor，本轮全补：

1. `shots.sh:62` 恒真断言（`scrollWidth>=clientWidth` 按定义恒真）→ 换成实数：读 `getComputedStyle(wrap).overflowX`
   与 `table.offsetWidth vs wrap.clientWidth`，判「装得下 **或** 包裹层 auto」。实测输出形如「告警表@390 装得下或由包裹层横滚（638/362 ox=auto）」。
2. `e2e-behavior.sh` 四处硬等（`:114/:279` 抓 loading、`:237` 等延迟 POST、`:324` 等后退，`shots.sh:97`）→ 全换轮询：
   `waitfor aria-busy`、`waitn false-positive 1`、`waitfor h1=登录`；`shots.sh:97` 的 `sleep 0.3` 删掉（set viewport 是同步命令）。
3. 报告 §五 把告警主列表 partial/error 标成「真浏览器逐格」但脚本里没有 → **本轮真的补进 e2e**（§五表里那两行），
   桩后端注入 `status:503` / `cases:503`，断言 `[data-role=qerror]`、`role=alert` 文案、点「重试」回 4 行。
4. minor：`e2e:135` 空按钮判绿 → 改成「按钮存在 | disabled」双断言。
5. minor：报告比断言多写的四处值 → 都补了断言：最后推送时间（`最后推送 2026-11-17 18:02:11`）、
   重复列四值（`×1,×12,×2,×3`）、202 后 `cases=0`（不重取整页）、失焦零轮。

e2e 断言数 90 → **102**，本轮全绿 `EXIT=0`。

## 十、没验到的（不装作验过）

1. **真后端**：本机没有牧云/模型凭据，跑的是桩（形状照 openapi）。真数据、真误报维护没验——同写者未决 6。
2. **409（研判还没结束）的 UI 路径**：排队行按钮本来就 disabled，界面走不到 409。
3. **录屏**：没有，只有静态截图 + DOM 几何量。
4. **吸顶丢失**：见 §七.3，没复现出。
5. 写者未决 1–9（抽屉/批量/搜索/等级列/命中规则单值/误报理由无处可见/类型筛选 9 类/窄屏/桩后端/两份归一/吸顶代价）
   我没有重复立 finding；其中「窄屏」这条本轮补了硬数据。

## 十一、文件清单

```
evidence/test/P003-T015/stub-api.mjs       自建桩后端（openapi 形状 + 请求日志 + 故障注入；本轮加 delayByHost）
evidence/test/P003-T015/e2e-behavior.sh    行为验收 102 条断言（A1–A4 + 七格 + 键盘 + 连点 + F2 三条 + 边界）
evidence/test/P003-T015/verify-round2.sh   复审轮独立复验（F1 六档横滚 + F2 四件事；支持 WEBROOT 指变异副本）
evidence/test/P003-T015/probe-round2.sh    边角探针（吸顶代价 / 表单被逐键关掉 / 刷新中打字 / 慢响应跨页）
evidence/test/P003-T015/shots.sh           视觉作证 + 断点探针（1440×900 / 390×844 + 1180/900/620）
evidence/test/P003-T015/shots/*.png        13 张（1440 六张、390 六张、390 横滚到此列一张）
evidence/test/P003-T015/test-report.md     本文件
```

## 十二、审计第二次打回：

> 初审之后 test-review 又打回一条：`verify-round2.sh:92` 的 `[ "$WSW" -ge "$WCW" ]`（包裹层 `scrollWidth >= clientWidth`）
> 是**恒真断言**——按规范 `scrollWidth` 至少等于 `clientWidth`，把 CSS 里的 `overflow-x` 拔掉它也照样绿。

### 修法（只动测试脚本，产品代码一行未改）

- 断言 ③ 不再拿 `scrollWidth>=clientWidth` 当「可滚」的证据。原地把包裹层 `scrollLeft` 写 1 再读回：
  只有真正的滚动容器才会挪，`overflow: visible` 下读回 0。
- 同时读 `getComputedStyle(wrap).overflowX`，只有 ∈ {auto, scroll} 才算滚动容器（`hidden` 能被脚本挪，但不该算）。
- 写 1 读完立刻还原 `scrollLeft` 到原值，不影响后续 390 的「滚到最后一列」用例。

改动：`verify-round2.sh:76-102`（断言 ③ 与取数表达式），断言条数不变（SEC=all 仍 30 条）。

### 变异验红（本席亲手，两跑对照）

变异副本 `/tmp/t015-mut-ovx/web`（`cp -r web` 后把 `assets/**/*.css` 的 `overflow-x: auto` 全改成 `visible`），
两版脚本指同一副本跑 `SEC=F1 WEBROOT=/tmp/t015-mut-ovx/web`：

```
旧脚本（恒真版）：PASS  F1 @1180 表(1008)比包裹层视口(928)宽 → 由包裹层横向滚（scrollW=1008）
                  PASS  F1 @620  表(638)比包裹层视口(592)宽 → 由包裹层横向滚（scrollW=638）
                  PASS  F1 @390  表(638)比包裹层视口(362)宽 → 由包裹层横向滚（scrollW=638）
                  → 三条「可滚」在变异下一次没红，实锤恒真           EXIT=1（只有 ②/①/LAST 红）
新脚本（scrollLeft 写 1 读回）：FAIL F1 @1180 表(1008)超包裹层视口(928)但包裹层滚不动
                  FAIL F1 @620  表(638)超包裹层视口(592)但包裹层滚不动
                  FAIL F1 @390  表(638)超包裹层视口(362)但包裹层滚不动
                  实测 scrollLeft 1→0，overflow-x=visible，scrollW=638/592   EXIT=1（13 红）
```

### 还原复绿（本席终端原文）

```
$ SEC=F1 bash evidence/test/P003-T015/verify-round2.sh
PASS  F1 @1180 表(1008)比包裹层视口(928)宽 → 包裹层真可横滚（scrollLeft 1→1，overflow-x=auto，scrollW=1008）
PASS  F1 @620  表(638)比包裹层视口(592)宽 → 包裹层真可横滚（scrollLeft 1→1，overflow-x=auto，scrollW=638）
PASS  F1 @390  表(638)比包裹层视口(362)宽 → 包裹层真可横滚（scrollLeft 1→1，overflow-x=auto，scrollW=638）
PASS=19 FAIL=0   EXIT=0
$ bash evidence/test/P003-T015/verify-round2.sh            # SEC=all
PASS=30 FAIL=0   EXIT=0
$ bash evidence/test/P003-T015/e2e-behavior.sh             # 回归兜底
PASS=102 FAIL=0  EXIT=0
```

变异副本已删（`rm -rf /tmp/t015-mut-ovx`），本树产品代码 `git status` 干净。
