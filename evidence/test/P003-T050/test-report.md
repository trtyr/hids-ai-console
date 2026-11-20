# P003-T050 测试报告（测试席 · 2026-11-20 12:29–12:41）

工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T050`
HEAD：`1af0b09`（分支 `task/hids-ai-console-P003-T050`）；进场 `git status --porcelain` 空，出场只有本报告与日志（新目录）。
上一棒：复审 pass（`verdicts/P003-T050-gc-backend-code-review-mwohc1ck.json`）。
本卡只动测试面（隔离注入 + 守卫），产品代码零改动。

结论：**pass**。A1–A5 五条锚点全部本终端亲跑，无 4xx/5xx 违约、无隔离漏点；findings 0。
两条卡外账（既有 flake、别树污染）见 §6，已归因，不计本卡。

---

## 1 A1 全量套件：并发 3 轮 + 串行 1 轮 + npm test

```
node --test --test-timeout=120000 --test-force-exit evidence/test/*/*.test.js
```

| 时刻 | 轮次 | exit | tests | pass | fail | todo |
| --- | --- | --- | --- | --- | --- | --- |
| 12:29:34 | 并发 R1 | 0 | 395 | 394 | 0 | 1 |
| 12:29:46 | 并发 R2 | 0 | 395 | 394 | 0 | 1 |
| 12:29:58 | 并发 R3 | 0 | 395 | 394 | 0 | 1 |
| 12:39:08 | 并发（复跑）| 0 | 395 | 394 | 0 | 1 |
| 12:39:20 | `--test-concurrency=1` 串行 | 0 | 395 | 394 | 0 | 1 |
| 12:39:46 | `npm test` | 0 | 235 | 235 | 0 | 0 |

- todo 唯一条 = `evidence/test/P003-T013/acceptance.test.js:654`「who 101 字」待群主定口径（A1 明写豁免，卡面口径）。
- `syslog-pipeline.test.js:96` 既有 flake（12:27 复审观测 1 次）我这边 6 次全量 + 1 次 npm test 均未复现；单文件不属本卡改动面。
- 12:37 两次复跑出现输出截断（`exit=7` 无 summary、`exit=1` 空输出），与同时段别树会话（P003-T052 tree，pid 1930598，12:38:11 起）跑全量套件造成的内存/IO 争用同窗；原命令 12:38、12:39 复跑均绿（上表）。判为环境抖动（C 类），不记 B 类发现。

## 2 A2/A4 守卫（影子根零条目 + A3 种子）

```
node --test --test-timeout=600000 evidence/test/P003-T034/global-root-isolation.test.js
→ exit 0 · tests 2 / pass 2 / fail 0 · duration 10500ms
✔ A3 首启种 wiki/ + rules/、二次启动不重种（202.6ms）
✔ A2/A4 全量测试在临时 HOME 下跑完：影子全局根零文件（10242.1ms）
```

子套件防空转门我自己复跑一遍（与守卫内部同一条命令，63 份文件）：

```
env -i PATH HOME=<mktemp -d> node --test --test-concurrency=2 --test-timeout=60000 --test-force-exit <evidence/**/*.test.js ∪ 根 *.test.js，除守卫自身>
→ exit 1 · tests 671 / pass 668 / fail 2 / todo 1；影子根条目 0（目录都不存在）
✖ 结果形状：run() 必备字段与枚举值符合文档
✖ A4 同主机同事件秒同告警只研判一次，重复投递只累加 repeat_count
```

- `tests 671 ≥ 600`：防空转门成立。
- 那 2 条红在 `evidence/p003-t012-verify/**`，我拿**注入前版本**（`git show 1dbda83:evidence/p003-t012-verify/acceptance.test.js`，手动 `HIDS_DATA_DIR=<tmp>` 跑，不碰真根）复跑：`16 条 / pass 13 / fail 3`——同样的 2 条红 + 注入后才暴露的 GEN-13 一条（已被本卡修掉）。**既有红，非本卡引入**，与复审判词一致。
- 守卫只判「影子根零条目」、不判子套件全绿；那 2 条既有红搭车不影响 A2/A4 判据（已在复审判词 notes 申报）。

## 3 A2 逐件隔离（三份 verify 件临时 HOME 单跑）

```
env -i PATH HOME=$(mktemp -d) node --test evidence/p003-t018-verify/acceptance.test.js
→ exit 0 · 9/9 · 影子根 0 条目
env -i PATH HOME=$(mktemp -d) node --test evidence/p003-t012-verify/acceptance.test.js
→ exit 1 · 17 条 / 15 pass / 2 fail（既有红，同上）· 影子根 0 条目
env -i PATH HOME=$(mktemp -d) node --test evidence/p003-t047-verify/acceptance.test.js
→ exit 0 · 17/17 · 影子根 0 条目
```

（每件跑完 `find $HOME/.local/share/hids-ai-console` 均为 0 条目，日志 `logs/p0*-verify.txt`。）

## 4 A4 真机口径：真全局根前后快照 diff

取 `find ~/.local/share/hids-ai-console -printf "%T@ %s %p\n" | sort -k3` 前后 diff：

| 窗口 | 动作 | diff 行数 |
| --- | --- | --- |
| 12:29:30 → 12:30:10 | 全量 evidence 套件并发 ×3 | **0** |
| 12:30:10 → 12:30:44 | 全量 evidence 套件串行 | **0** |
| 12:30:44 → 12:30:47 | npm test | **0** |
| 12:31:39 → 12:35:56 | A5 变异脚本 23 点（每点临时 HOME） | 20（另树，§6） |
| 12:38:11 → 12:39:0x | 全量并发复跑 + 手抽变异 | **0** |
| 12:39:20 → 12:39:47 | 串行 + npm test | **0** |

另跑本树根单测 `node --test --test-timeout=60000 --test-force-exit agent-api.test.js`（23/23）前后 diff = **0**。

## 5 A5 变异自证

### 5.1 变异脚本（23 个注入点）

```
bash evidence/test/P003-T034/mutation-isolation.sh
→ exit 0 · 12:31:39–12:35:56（4m17s）· 输出 evidence/test/P003-T034/t050-mutation.txt
段数 23；「该文件自证 exit=1」×23；「整套守卫 exit=1」×23；「没有找到 ✖ / 守卫没红」×0
第二轮（废掉助手里的注入语句）：T013 / T039 / agent-api 三件各 exit=1，均红在「✖ 全局根隔离（P003-T050 A2）」
跑完 git status：` M evidence/test/P003-T034/t050-mutation.txt`（只剩这一份，符合卡面）
```

### 5.2 我自己另抽一条（不在复审抽的 p018 / walk 两点里）

`evidence/test/P003-T046/model-call-events.test.js`：删第一条 import（`isolate-data-root.js`）→
- 该文件（临时 HOME）：`exit 1`，7 条 6 pass 1 fail，红在「✖ 全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根」；
- 同一变异树跑整套守卫：`exit 1`，`✔ A3` 绿、`✖ A2/A4` 红（影子根有 211 条目），判据方向正确（变异只砸 A2/A4、不误伤 A3）；
- `git checkout --` 还原后重跑该文件 7/7 绿；`git status` 干净。
日志：`logs/mutation-spotcheck.txt`。

## 6 卡外账（已归因，不计本卡）

1. **`syslog-pipeline.test.js:96` 既有 flake**（复审 12:27 观测 1 次）：我 6 次全量 + npm test 未复现；不在本卡 diff。
2. **真全局根的别树痕迹**：12:31:14/12:31:28/12:33:20/12:35:43/12:39:11 共 5 批、每批 4 份 `fp-sessions/*.json`，
   全部 `who=值班分析员` + `case_dir=/tmp/trace-analysis-*/case`。归因依据（三条独立）：
   - 该形态只见于**根单测 `agent-api.test.js`**（本树 `grep -rln trace-analysis` 仅命中 `./agent-api.test.js`），而它不在 `evidence/test/*/*.test.js` 套件里；
   - 唯一会跑 root 单测的路径是守卫子套件（守卫把 HOME 换临时家目录）——我把注入语句注释掉、临时 HOME 跑 `agent-api.test.js`（=变异脚本第二轮的最坏条件）实测真根 diff=**0**，写的是临时家目录的 `fp-sessions/`（4 份）；
   - 同窗活着一个 cwd 在 **P003-T052** 树的子会话（pid 1930598，12:38:11 起），该树 `agent-api.test.js` 的隔离注入数 = **0**；它在跑自己那套门禁（`npm test` 每跑一次即写 4 份）。
   - 反向对照：本树 `agent-api.test.js` 单跑 23/23 绿、真根 diff 0。
   日志：`logs/other-tree-attribution.txt`、`logs/final-suite-a4.txt`。
3. 12:37 两次截断复跑（exit 7 / exit 1 空输出）与上述并发会话同窗，复跑即绿，判环境争用。

## 7 残余风险（不卡本卡）

- 守卫只判影子根「零条目」，不判子套件全绿：`p003-t012-verify` 的 2 条既有红会长期搭车（该卡自己的账）。
- `p003-t047-verify` 硬编码 `PORT=18147` 与 `/tmp/p003-t047-acceptance`，进守卫子套件后并发/跨树跑会互撞（其夹具，申报在复审）。
- 守卫子套件与外部套件并发时受机器内存约束（14G 机器上同时两套全量会截断，见 §6.3），CI 上单跑不受影响。

## 8 复跑清单（全部可原样跑）

```bash
node --test --test-timeout=120000 --test-force-exit evidence/test/*/*.test.js            # A1 并发
node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit evidence/test/*/*.test.js
npm test                                                                                # A1 主门
node --test --test-timeout=600000 evidence/test/P003-T034/global-root-isolation.test.js  # A2/A3/A4 守卫
env -i PATH="$PATH" HOME=$(mktemp -d) node --test evidence/p003-t018-verify/acceptance.test.js
env -i PATH="$PATH" HOME=$(mktemp -d) node --test evidence/p003-t012-verify/acceptance.test.js
env -i PATH="$PATH" HOME=$(mktemp -d) node --test evidence/p003-t047-verify/acceptance.test.js
bash evidence/test/P003-T034/mutation-isolation.sh                                      # A5，约 4m20s
```
