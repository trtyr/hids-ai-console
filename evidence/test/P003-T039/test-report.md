# P003-T039 测试报告（测试席 · 何东阳）— 复审修复轮验收

- 任务卡：P003-T039 上下文瘦身（复审修复：R1 挂死 / R2 覆写 / R3 schema）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T039`，HEAD `cd234e0`（分支 `task/hids-ai-console-P003-T039`）
- 代码审查判词：`verdicts/P003-T039-gc-backend-code-review-mwnq2f38.json`（pass，R1/R2/R3 + 门禁全 pass，两条 minor 不阻塞）
- 判据只取：文档 `docs/modules/evidence-view.md` §4.4、`docs/modules/investigation-agent.md` §3.8 B/D + §3.9 A5、`docs/modules/evidence-tools.md` §4.4、`package.json:8`（门禁口径）、本卡回归用例 `evidence/test/P003-T039/context-slim.test.js`。**没读实现内容**（`investigation-agent.js` / `evidence-view.js` 一行没看），变异全部用「整文件换回修复前版本」做，不对源码猜锚点。

## 结论

**PASS。** 三条门禁我在自己终端各跑过；修复前代码 3 条回归全红、修复版 12 条全绿、逐 BUG 单独回退的隔离矩阵成立、抽掉 4 条关键断言后旧代码恰好只绿 BUG2（断言不是永真）。树上干净、无残留进程。
复审两条 minor 我独立复现确认仍在（有界、不阻塞），见 §四。

## 一、门禁（每条都是我在这个终端里跑的，没转录任何人）

| 门 | 命令原文 | 实测 |
| --- | --- | --- |
| 后端全套 | `npm test` | `ℹ tests 210 / ℹ pass 210 / ℹ fail 0`，722ms，**exit 0**；复跑第二遍 210/0，**exit 0** |
| 本卡回归套件 | `node --test evidence/test/P003-T039/context-slim.test.js` | `ℹ pass 12 / ℹ fail 0`，251ms，**exit 0**；连跑 4 遍全 12/0（无 flake） |
| 体积对比 + 变异 | `node evidence/test/P003-T039/mutations.mjs` | `# 全部通过（四项 ≥50%，8 条变异各自验红）`，**exit 0** |

体积实测（基线 2aa89ff → HEAD）：

```
首轮 47868 → 23298  -51.3% PASS      复核轮  71935 → 21116  -70.6% PASS
峰值轮 81068 → 36948 -54.4% PASS      全流程 396020 → 174281 -56.0% PASS
系统段 54196 → 51671   4.7%（A7 口径，工具名清单不再每轮进系统段）
```

8 条变异（A1–A8）逐项回退后对应指标全部变差：首轮 23298→33773/23980/24741/29036、复核轮 21116→70492、全流程 174281→208900、系统段 51671→52051/53546。数字都动了，没有白改的项。

**两套要分开跑的口径我验了**：`package.json:8` 是 `*.test.js` 根目录 glob，`npm test` 210 条不含 `evidence/test/` 子目录；本卡套件单独跑 12 条。混跑会把 210 读成本卡的数。

## 二、修复前代码复跑（红）

从 `git show d9eaea6:` 取两个实现文件覆盖到临时树（不动工作树），跑 `node --test --test-name-pattern="复审" evidence/test/P003-T039/context-slim.test.js`：

```
✖ 复审 BUG1 ... (2004.7ms)  Error: boundSyslogView 在 2000ms 内没有返回（裁剪循环不收敛）
✖ 复审 BUG2 ...  AssertionError: actual: undefined, expected: 1
✖ 复审 BUG3 ...  AssertionError: 输入未匹配 /摘要/，actual: '按编号读取当前告警类型或通用判据的完整 Wiki 页面。...'
ℹ tests 3 / pass 0 / fail 3   exit=1
```

BUG1 走的是 2s 看门狗（worker 隔离），没把整柜挂住——挂死场景被判成一条失败用例，设计兑现。

## 三、隔离矩阵 + 断言强度（防治「一次过的东西八成没测干净」）

只换回一个文件，确认每条回归只对自己那个 bug 红：

| 变异（临时树） | BUG1 | BUG2 | BUG3 | exit |
| --- | --- | --- | --- | --- |
| 只回退 `evidence-view.js`（修复前） | ✖ 2003.9ms | ✔ | ✔ | 1 |
| 只回退 `investigation-agent.js`（修复前） | ✔ | ✖ undefined≠1 | ✖ 描述不匹配 | 1 |
| 全修复版（HEAD） | ✔ | ✔ | ✔ | 0 |

断言强度：在「修回 `investigation-agent.js` 的旧版」上删掉 BUG2 的 4 条关键断言（`:377`、`:382-384`）后，BUG2 **变绿**，BUG1/BUG3 照旧（BUG1 因 evidence-view 是修复版而绿）→ 抓 BUG2 的活是那几条断言干的，不是顺带绿。临时树跑完即删。

## 四、复审两条 minor（我独立复现，确认仍在、不阻塞）

1. 降级回包可超 maxChars：`boundSyslogView({payload: 400 个 30 字字段名 × 5 字值})` → 回包 11297 字、**32ms 返回**、`payload` 被降级掉、只剩 `msgid/truncated_for_context/omitted_fields/note`。挂死已解、输出有界，但「≤3000」不覆盖这个降级例外，文档（`docs/modules/evidence-view.md:175`）没声明。
2. 同一注册动作行号口径不一：`docs/modules/investigation-agent.md:620` 与 `docs/modules/evidence-tools.md:124` 写 `investigation-agent.js:725-732`，`docs/modules/investigation-agent.md:637` 写 `:725-733`——差一行边界，不构成幽灵实体。

两条都是 minor，已在代码审查判词里记录，我不重复立账。

## 五、验收面与卫生

- A1–A10 未重开：`git diff --stat 2aa89ff..HEAD -- '*.test.js'` → 只有 `evidence/test/P003-T039/context-slim.test.js +397`（纯新增），既有测试一行没改。
- 树卫生：跑完 `git status --porcelain` = 0 行（除本报告未跟踪）；`ps` 无残留 `context-slim`/worker 进程；临时树全部在 `/tmp` 且已删。

## 六、残余风险

- 挂死场景的看门狗 2000ms 是本机口径；CI 机器更慢时非挂死路径也不会接近 2s（实测 16-17ms），风险低。
- 降级回包超限这条 minor 只要以后有人按「降级=进限」写上游代码就会踩，建议下一轮顺手补文档一句。
