# P003-T057 测试报告（第二轮）：prompt-store.md 三组陈旧数值修正（docs-only）

- 卡号：P003-T057（上一轮判词被 test-review 打回：`mwost8q1`，`reject_test`）
- 树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T057`（分支 `task/hids-ai-console-P003-T057`）
- 本轮测试件提交：`697f83a`；被测文档 HEAD：`cb9c0a6`；base：`3d68055`
- 角色：后端 tester，黑盒——只按 `docs/modules/prompt-store.md` 的承诺造调用，**未读任何实现文件内容**（对 `prompt-store.js` 只用了公开返回值、异常对象与 `strace` 的 `openat` 观测）
- 一键复跑：`bash evidence/test/P003-T057/tester-acceptance.sh` → 全程输出 `evidence/test/P003-T057/tester-acceptance-run.txt`，末行 `exit $FAILS`

## 0. 结论

**pass**。A1–A5 我亲手跑全部成立，145 条断言 0 失败、脚本退出码 0（连跑 3 次同结果；另在 `git clone --shared` 的干净树上再跑一次也是 145/0/exit 0）。
本轮把上一轮的假绿修掉了：变异实测 **M1/M2 exit 1–2、还原复绿**（见 `mutation-proof.txt`），断言不再是装饰。
3 条 minor（都不动页面数值、不阻塞）见 §4。

## 1. 针对 reject_test 的四条，各修了什么、怎么证的

| 审计要求 | 修法 | 证据 |
| --- | --- | --- |
| ① `.sh` 无失败能力（末行 echo 吞返回，SCRIPT EXIT 恒 0） | 全部检查改成断言，`pass/fail` 分别计数，末尾 `exit "$FAILS"`；每条外部命令 `timeout` + rc 断言；没有一条「只打印不判」的检查 | `mutation-proof.txt` §2/§3/§4：M1 exit=1、M2 exit=2、M3 exit=1，还原后 exit=0 |
| ② A1 残留正则漏 7 处旧行 | 换成独立词表 `old-values.txt`（32 个固定串，`grep -F`），并加**三层自检**：<br>(a) 改后页面每个词命中 0；<br>(b) 每个词在改前页面（`git show 3d68055:…`）至少命中 1 行（证非永真）；<br>(c) 改前→改后被删的 **34 行**逐行检查「至少被一个词覆盖」（证清单没漏） | `tester-acceptance-run.txt`：32 词各 `残留=0`、32 词各 `改前命中≥1`、`A1 清单漏覆盖的被删行数 = 0`；M3 抽掉两行词表 → `漏覆盖的被删行: -核心 11182 + 场景 14415 + SOP 12083）` + exit=1 |
| ③ 9 条边界只有 3 条在 `.sh` | 9 条全部落进套件（另补 2 条文档承诺的边界，共 11 条），每条断言 `status` + `message` 原文，不只断状态码；造法在 `boundaries.mjs`（可单跑） | `tester-acceptance-run.txt` 的 `CASE1`–`CASE10` + `B1`–`B11` 全 PASS；`B11` 用页面 §3.3 原文块 |
| ④ A3 空数据根先种子，同命令数出 391，不可重放 | 改成：固定数据根 `/tmp/t057-a3/data` → **先不 trace 跑一次 `load()` 完成种子** → 覆盖文件写 `{}`（让 23 次都成功）→ 再 trace 第二次 `load()`；只数目标路径，且断言 `O_RDONLY`、无写标志、无 ENOENT、无重复 | `tester-acceptance-run.txt`：`总次数 23 / 唯一 23 / ENOENT 0 / 全 O_RDONLY 23 / 写标志 0`，分类 `core=7 scenarios=1 sop(仓内)=2 sop(判据库)=12 override=1`；反面对照（空数据根直接 trace）数出 **213/201**，见 `mutation-proof.txt` §5 |

审计的另外两条 minor 也一并修了：

- **§6.4「逐字复跑」不成立** → 现在页面每个代码块是**从 .md 里按小节标题抠出来直接 `bash` 跑**的（§3.1/§3.3/§4.3/§5.3/§5.4/§6.4），不是改写版；抠出的块落在 `/tmp/t057-acc/page-*.sh` 可核对。
- **报告说「真读 23 个文件」不实** → 本轮口径改成「23 次目标路径 `openat`，全部成功且全是只读」，不再说「23 个文件成功读入」这种含糊话；页面 `:448` 的「23 次 `readFile`」是调用数，两边一致。

## 2. 逐条验收（本轮实跑）

### A1 核心提示词 6→7（键列补 `rule`）

- 残留：词表 32 词 × 三层自检全过（见 §1 ②），改后页面 `docs/modules/prompt-store.md` 命中 0。
- 键列：页面 `:80`（§3.1 来源表）与 `:158`（§4.2 键名表）都有 `rule`；断言 `'\`cross\` / \`rule\`'`、`'\`knowledge_reuse\`、\`cross\`、\`rule\`'` 命中。
- 公开输出：`core keys: triage,deep,trace,knowledge,knowledge_reuse,cross,rule` / `core count: 7` / `scenario cards: 13` / `sop count: 14` / `version: merged-three-state-2026-11-06` / `revision: 065221c4b66f7660`。
- 页面 `:92` 的出处句本轮也核了：`git log --oneline -S "rule: 'rule-maintenance.md'" -- prompt-store.js` → 单条 `5256d0e`（可复跑，2 次一致）。

### A2 章节 21→22（7 + 13 + 2）

- `snapshot()`：`sections: 22 | core: 7 | scenario: 13 | sop: 2 | 算式: 22`；`knowledge_revision` 形态 16 位 hex。
- `metadata()` 字数：`core: 7 13177 | scenario: 13 14415 | sop: 14 12210`，`合计: 39802`，与页面 `:459` 一致；页面 §6.1 与 §10 的两处算式断言命中。
- 「21→22」改动量我自己数过（不改报告口径）：改前→改后被删行中独立 `21` 共 **19 处 / 16 行**（`grep -oP '(?<![0-9])21(?![0-9])'`），与 `coding-reports/P003-T057.md:67` 的两个数一致——但那份行号清单只列 14 行（见 §4 finding 2）。

### A3 一次 `load()` 读盘 22→23

```bash
$ HIDS_DATA_DIR=/tmp/t057-a3/data HIDS_PROMPT_STORE_FILE=/tmp/t057-a3/prompt-overrides.json strace -f -e trace=openat -o /tmp/t057-a3/trace.txt node -e "…load()…"
traced revision: 065221c4b66f7660
目标路径 openat 总次数 23 / 唯一 23 / ENOENT 0 / O_RDONLY 23 / 含写标志 0
core=7 scenarios=1 sop(仓内)=2 sop(判据库)=12 override=1 合计=23
```

对账页面 `:448`「23 次 `readFile`：7 个核心文件 + `scenarios.json` + 14 份 SOP + 1 份覆盖文件」→ 7+1+(2+12)+1 = 23，逐项吻合。种子那一步不 trace、不计入。

### A4 门禁改前/改后 `violations=[]`

```bash
$ node ~/.pi/agent/extensions/group-chat/gate/gate-cli.js docs --cwd /tmp/t057-base-check   # git archive 3d68055 导出树
"ok":true … "violations":[]   改前 EXIT=0
$ node ~/.pi/agent/extensions/group-chat/gate/gate-cli.js docs --cwd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T057
"ok":true … "violations":[]   改后 EXIT=0
```

改前基线树确认是旧口径（`grep -cE "6 个核心提示词|21 个章节"` → 12 行命中）。两条既有 `coverage_degraded` warning 改前就有。

### A5 代码面零改动 + 页面脚本逐字复跑

```bash
$ git diff --name-only 3d68055..HEAD -- '*.js' 'web/*' 'prompts/*' 'package.json' 'openapi.yaml'
（无输出，0 个文件）
$ git diff --name-only 3d68055..HEAD
coding-reports/P003-T057.md
docs/architecture.md          # cb9c0a6 顺带收口 :318 的「6 个核心提示词」（审计同族问题）
docs/modules/prompt-store.md
evidence/recon/P003-T057.md
evidence/test/P003-T057/…     # 测试席自己的证据与控制文件
```

页面代码块逐字跑的输出（每块都是从 .md 抠出来的原文，块文件在 `/tmp/t057-acc/page-*.sh`）：

| 小节 | 断言的实际输出 |
| --- | --- |
| §3.1 | `core keys: triage,deep,trace,knowledge,knowledge_reuse,cross,rule` / `revision: 065221c4b66f7660` |
| §4.3 | `prompts.triage = 覆盖后的通用系统提示词` / `覆盖文件键 = triage` |
| §5.3 | `原序: 065221c4b66f7660 | 倒序: 9da15df422ed3b7d | 相同: false` |
| §5.4 | `复算: 065221c4b66f7660 | 上报: 065221c4b66f7660 | 一致: true` |
| §6.4 | `安装后 version: demo-2026-11-20 | revision 变了: true` / `文件顶层键数: 24 | _history 长度: 2` |
| §3.3 | `ENOENT /tmp/empty-wiki/<某页>.md`（见 §4 finding 1：具体哪个文件不确定） |

## 3. 边界与错误码（11 条，全部在套件里，断言 `status` + `message` 原文）

| # | 用例 | 造法 | 期望（文档出处） | 实测（断言串） |
| --- | --- | --- | --- | --- |
| B1 | 22 个真键整包安装 | `install({...snapshot().sections}, release, rev, krev)` | 装上，顶层 24 键（§6.3、§6.4） | `ok version=demo-x topkeys=24 history=2 sections=22` |
| B2 | 22 个键全换名（键数不变） | 每个键改 `other:i` | `400 升级包缺少必需章节或正文格式不正确`（§6.2 检查 3） | `err status=400 message=升级包缺少必需章节或正文格式不正确` |
| B3 | 少一个章节（21 真键） | 删首键 | 同上 400（§6.2） | 同上 400 |
| B4 | `expectedRevision` 不符 | `deadbeefdeadbeef` | `409 当前版本已变化，请刷新后重新确认替换`（§6.2 检查 1） | 一致 |
| B5 | `knowledgeRevision` 不符 | `deadbeefdeadbeef` | `409 升级包与当前知识库版本不兼容`（§6.2 检查 2） | 一致 |
| B6 | `sequence` 等于当前值 | 同包再装一次 | `409 不允许重复应用或降级到旧版本`（§6.2 检查 4、R-PROMPT-04） | 一致 |
| B7 | 白名单 20 个键逐个收 | 7 核心 + 13 `scenario:<id>` 逐个 `update()` 并断言返回值里对应章节被换掉 | 「共 20 个」（§4.3） | `accepted=20 whitelist_keys=20 core=7 scenario=13 rule=规则正文替换测试-rule` |
| B8 | `update('sop:common', …)` | SOP 键 | 普通 `Error`、无 `status`：`不支持的提示词章节`（§4.3、R-PROMPT-03） | `status=undefined message=不支持的提示词章节` |
| B9 | 20001 字正文 | `'x'.repeat(20001)` | 普通 `Error`：`提示词正文必须为 1 到 20000 字`（§4.3、R-PROMPT-09） | `status=undefined message=提示词正文必须为 1 到 20000 字` |
| B10 | 覆盖文件不是合法 JSON | 写 `{not json` | `SyntaxError`，不吞（§4.1） | `name=SyntaxError status=undefined` |
| B11 | 判据目录为空 | 页面 §3.3 原文块 | `load()` 抛 `ENOENT` 并报缺哪个文件（§3.3、§9） | `ENOENT /tmp/empty-wiki/…/….md`（稳定部分；具体页名不确定，见 finding 1） |

`npm test`（单测烟测，**放在套件外**，自毁防线：套件内不跑整套测试）：`tests 235 / pass 235 / fail 0`，`EXIT=0`（`npm-test-run.txt`）。

## 4. 发现（3 条 minor，全是 doc-side，不动页面数值、不阻塞）

1. **`docs/modules/prompt-store.md:134`（§3.3 代码块末行）**：「`# ENOENT /tmp/empty-wiki/webshell/WS-13.md`」不是确定输出——同一块原文块连跑 30 次，样本一 **26 : 4**、样本二 **24 : 6** 落在 `webshell/WS-13.md` 与 `memwebshell/MW-08.md` 两页（`flaky-b11.txt`）。
   文档承诺的**行为**成立（抛 `ENOENT`、报缺哪一页、日志里带路径）；不成立的是「实测输出只此一种」这个写法：读者照字面核会碰到「怎么跑出来是另一页」。
   建议：把该行标成示例（例如「示例输出（并发读，先失败的那页不一定相同）」），或改成两条都列出。
2. **`coding-reports/P003-T057.md:67-68`**：「19 处（16 行）」两个数**都对**（我复算 19/16），但冒号后的行号清单只列 14 行，漏 §10 的 `:450`、`:452` → 复核者照清单数得 14，与「16 行」自相矛盾（审计 `mwost8q1` issue 8，HEAD `cb9c0a6` 未改）。
   建议：补 `:450`、`:452`，或改成「19 处/16 行，逐行见 `git diff 3d68055..HEAD -- docs/modules/prompt-store.md`」。
3. **`coding-reports/P003-T057.md:220`**：「本卡共 5 个提交」对不上：`git rev-list --count 3d68055..ba797d6` = **4**（该段贴的 `git log --oneline -2` 也是 `ba797d6`/`9873db9` 时点）；当前 HEAD 是 **6** 个（追加了测试席 `b24519b` 与复审整改 `cb9c0a6`）。
   建议：写成「快照时点 `ba797d6`，当时 4 个提交；其后测试席与复审整改各追加 1 个，现 HEAD 6 个」。

**卡外记录（非本卡责任）**：`docs/architecture.md:318` 的「6 个核心提示词」已在 `cb9c0a6` 一并收口为 7（不在卡面放开路径内，属群主顺手同族修）；门禁 `violations=[]`，不拦。

## 5. 复跑方式与退出码语义

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T057
bash evidence/test/P003-T057/tester-acceptance.sh; echo "SCRIPT EXIT=$?"   # 0 = 全过；>0 = 失败断言条数
node evidence/test/P003-T057/boundaries.mjs /tmp/t057-bnd                 # 只跑 11 条边界/错误码（可选）
timeout 900 npm test                                                      # 单测烟测，单独跑，不并入上面那条
```

- 每条外部命令都带 `timeout`；临时目录固定 `/tmp/t057-acc`、`/tmp/t057-a3`、`/tmp/t057-bnd`、`/tmp/t057-base-check`，可重复跑。
- 没有一条断言依赖「上一次跑的残留」：A3 每次重建数据根并重新种子；B 系列每次删掉自己的覆盖文件。

## 6. 残余风险

- 页面里 `prompt-store.js:<行号>` 的**行号本身**我按黑盒纪律不读实现，无法逐条目视核对（归 P003-T056 的口径）；本报告只做行为侧证（`readFile` 调用点结构查询 + `strace`）。
- 指纹/字数依赖数据根里判据页内容：本树判据库与仓内 `wiki/` 的 SOP 文件内容一致，换机器种子后应得同一组值；判据页再改则这几个数会变（属正常）。
- B11 的具体页名不确定（finding 1），套件只断言稳定承诺——所以「页面 §3.3 输出逐字一致」这条**本轮不再声称**。
- 未跑 web 侧测试：改动是纯文档 + 后端提示词装载，无 UI 触点（`npm run test:web` 与本次改动无关）。

## 7. 证据文件

- `evidence/test/P003-T057/tester-acceptance.sh` —— 一键验收，145 条断言，`exit $FAILS`
- `evidence/test/P003-T057/old-values.txt` —— A1 旧口径词表（32 词，三层自检的数据源）
- `evidence/test/P003-T057/boundaries.mjs` —— 11 条边界/错误码的造法（可单跑）
- `evidence/test/P003-T057/tester-acceptance-run.txt` —— 本轮全程输出（`PASS=145 FAIL=0`，`SCRIPT EXIT=0`）
- `evidence/test/P003-T057/mutation-proof.txt` —— M0 绿 / M1 红 exit 1 / M1 还原复绿 / M2 红 exit 2 / M3 红 exit 1 / A3 反面对照 213
- `evidence/test/P003-T057/flaky-b11.txt` —— 页面 §3.3 原文块 30 次 × 2 组的分布（finding 1 的原始数据）
- `evidence/test/P003-T057/npm-test-run.txt` —— 单测烟测 `235/0`，`EXIT=0`
- `/tmp/t057-a3/trace.txt`（strace 原始 openat 记录）、`/tmp/t057-acc/`（每步日志与页面块原文件）

## 8. 提交后时点说明（不写「以后不会再动」这种承诺）

`tester-acceptance-run.txt` 的 `HEAD` 行是 **`697f83a`**（测试件提交时点）。其后本卡新增的提交只追加本目录的证据/报告文件：

```bash
$ git diff --name-only 697f83a..HEAD
evidence/test/P003-T057/flaky-b11.txt
evidence/test/P003-T057/mutation-proof.txt
evidence/test/P003-T057/npm-test-run.txt
evidence/test/P003-T057/test-report.md
evidence/test/P003-T057/tester-acceptance-run.txt
```

即：页面 `docs/modules/prompt-store.md` 与产品代码在 `697f83a` 之后没有再动过；要复核这一点，跑上面那条命令即可，
`docs/` 与 `*.js` 都不在输出里。报告这份文件本身随后仍可能因复验补录而变化——不以「不会再改」作承诺。
