# P003-T057 测试报告：prompt-store.md 三组陈旧数值修正（docs-only）

- 卡号：P003-T057
- 树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T057`（分支 `task/hids-ai-console-P003-T057`）
- 验收时 HEAD：`ba797d6`，base：`3d68055`
- 测试角色：后端 tester，黑盒——只按 `docs/modules/prompt-store.md` 的承诺造请求/调用，**未读任何实现文件内容**（对 `prompt-store.js` 只做过结构查询：`grep -n readFile` 取调用点行号、不取内容）
- 一键复跑：`bash evidence/test/P003-T057/tester-acceptance.sh` → 全程输出 `evidence/test/P003-T057/tester-acceptance-run.txt`（本次 `SCRIPT EXIT=0`）

## 0. 结论

**pass**。A1–A5 我自己复跑全部成立；页面三组数值（核心 7 / 章节 22 / 读盘 23）与顶层键 24、字数 39802、指纹 `065221c4b66f7660` 与实测逐项对上；门禁改前/改后均 `ok=true / violations=[] / EXIT=0`；产品代码零改动。
三条 minor（都不阻塞、都不改页面数值）见 §3。

## 1. 逐条验收

### A1 核心提示词 6→7（键列补 `rule`）

```bash
$ grep -nE "6 个核心|六个核心|6 个 Markdown|21 个章节|21 个键|22 次|顶层 23|deabe4abb842db81|9bf6e567ce73b60d|11182|12083|37680" docs/modules/prompt-store.md
（无输出）
grep EXIT=1
```

- 旧口径全页零残留（含旧指纹、旧字数 11182/12083/37680、旧「22 次读盘」「顶层 23」）。
- 键列已补 `rule`：`docs/modules/prompt-store.md:80`（§3.1 来源表）、`:158`（§4.2 键名表）。
- 行为核对（`load()` 公开输出）：`core keys: triage,deep,trace,knowledge,knowledge_reuse,cross,rule`，`core count: 7`。EXIT=0。

### A2 章节 21→22（算式 7 + 13 + 2）

```bash
$ node -e "…store.snapshot()…"
sections: 22 | core: 7 scenario: 13 sop: 2 | 算式: 22 | knowledge_revision: c8bc944a1b6c5b41
EXIT=0
```

- 页面算式两处：`:281`（「22 个章节名（7 核心 + 13 场景 + 2 SOP）」）、`:450`（「章节数 22（7 核心 + 13 场景 + 2 SOP）」）——与实测 7/13/2 一致。
- 「21→22」改动面自数：`git diff 3d68055..HEAD -- docs/modules/prompt-store.md | grep '^-' | grep -o 21 | wc -l` → **19 处**；同法按行计 → **16 行**（与报告 `coding-reports/P003-T057.md:67` 的两个数一致）。
- §6.4 顶层键数 23→24（页面自带脚本逐字跑，覆盖文件落到 `/tmp/t057-acc/ok.json`）：
  `正面 22 真键 => version: demo-x | 顶层键数: 24 | _history: 2`，页面对账 `:354`「顶层 24 个键 = 22 个章节 + _release + _history」。

### A3 一次 `load()` 读盘 22→23

不靠代码，靠**系统调用**：`strace -f -e trace=openat` 跑一次 `load()`，数真实读盘文件。

```bash
$ HIDS_PROMPT_STORE_FILE=/tmp/t057-strace/prompt-overrides.json strace -f -e trace=openat -o /tmp/t057-strace/trace.txt node -e "…await new PromptStore().load()…"
revision: 065221c4b66f7660
strace EXIT=0
--- 读盘总次数 ---
23
--- 分类计数 ---
core=7 scenarios=1 sop(仓内)=2 sop(判据库)=12 override=1 合计=23
```

对账 `docs/modules/prompt-store.md:448`「23 次 `readFile`：7 个核心文件 + `scenarios.json` + 14 份 SOP + 1 份覆盖文件」：7 + 1 + (2+12) + 1 = 23，**逐项吻合**（多出来的一份就是 `prompts/rule-maintenance.md`）。
调用点结构查询（不读内容）：`grep -n readFile prompt-store.js` 只出 `2 33 41 42 48`（2 是 import 行），即页面 `:47-49`/`:48` 的引用落在真实调用点上。

字数合计（`metadata()` 公开输出）：`core: 7 13177 | scenario: 13 14415 | sop: 14 12210`，合计 **39802**，与 `:459` 一致。

### A4 门禁改前/改后 violations 均 0

本仓无 `gate/`，按卡面跑法在群扩展目录执行：

```bash
$ cd /home/trtyr/.pi/agent/extensions/group-chat && node gate/gate-cli.js docs --cwd /tmp/t057-base-check   # 改前 = git archive 3d68055 导出树
{"ok":true,"reason":"docs_ok_with_warnings",…,"counts":{"docs":18,"architecture":2,"modules":14,…},"violations":[],…}
改前 EXIT=0

$ cd /home/trtyr/.pi/agent/extensions/group-chat && node gate/gate-cli.js docs --cwd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T057
{"ok":true,"reason":"docs_ok_with_warnings",…,"counts":{"docs":18,"architecture":2,"modules":14,…},"violations":[],…}
改后 EXIT=0
```

两次都只剩既有的两条 `coverage_degraded` warning（分母缺 `no_base_commit`、`no_codegraph_affected`），改前就有、与本次改动无关；`violations` 均为 `[]`。
基线树确为改前状态（`grep -cE "6 个核心提示词|21 个章节" /tmp/t057-base-check/docs/modules/prompt-store.md` → **12** 处命中）。

### A5 产品代码零改动 + 每条改动带旧值→新值→依据

```bash
$ git diff --name-only 3d68055..HEAD
coding-reports/P003-T057.md
docs/modules/prompt-store.md
evidence/recon/P003-T057.md

$ git diff --name-only 3d68055..HEAD -- '*.js' 'web/*' 'prompts/*' 'package.json' 'openapi.yaml'
（无输出）
代码面 EXIT=0
```

- 三个路径全在 scope 内，代码面零改动。
- `coding-reports/P003-T057.md` §3 有 26 行「旧值 → 新值 → 依据」对照表；我抽验其中可行为验证的项：指纹（`:94`/`:240`/`:253`/`:270`）、字数（`:457`/`:459`）、顶层键（`:351`/`:354`）、白名单 20 个（`:178`）、读盘 23（`:448`）——全部命中。
- 页面自带脚本逐字复跑（防「输出是抄的」）：

```bash
§5.3 原序: 065221c4b66f7660 | 倒序: 9da15df422ed3b7d | 相同: false
§5.4 复算: 065221c4b66f7660 | 上报: 065221c4b66f7660 | 一致: true
§6.4 文件顶层键数: 24 | _history 长度: 2
```

## 2. 边界与错误码（本页承诺的行为逐条触发）

| 用例 | 造法 | 期望（文档出处） | 实测 |
| --- | --- | --- | --- |
| 22 个真键整包安装 | `install({...snapshot().sections}, release, rev, krev)` | 装上，顶层 24 键（`:354`） | `version: demo-x / 顶层键数: 24 / _history: 2`，EXIT=0 |
| 22 个键全换名（键数不变） | 每个键改 `other:i` | `400 升级包缺少必需章节或正文格式不正确`（`:292`、`:300`） | `Error \| status: 400 \| 升级包缺少必需章节或正文格式不正确` |
| 少一个章节（21 个真键） | 删首键 | `400`（`:292`「键数等于 22」） | `Error \| status: 400 \| 升级包缺少必需章节或正文格式不正确` |
| `expectedRevision` 不符 | 传 `deadbeefdeadbeef` | `409 当前版本已变化，请刷新后重新确认替换`（`:290`） | 一致 |
| `knowledgeRevision` 不符 | 传 `deadbeefdeadbeef` | `409 升级包与当前知识库版本不兼容`（`:291`） | 一致 |
| `sequence` 等于当前值 | 同包再装一次 | `409 不允许重复应用或降级到旧版本`（`:293`） | 一致 |
| `update('rule', …)` | 第 7 个核心键 | 白名单收（`:178`「共 20 个」） | `prompts.rule = 规则正文替换测试` |
| `update('sop:common', …)` | SOP 键 | 普通 `Error`、无 `status`：`不支持的提示词章节`（`:179`） | 一致 |
| 判据库目录为空 | `HIDS_WIKI_DIR=/tmp/t057-emptywiki` | `load()` 抛 `ENOENT`（`:426`） | `Error \| ENOENT \| … open '/tmp/t057-emptywiki/webshell/WS-13.md'` |

## 3. 发现（三条 minor，不阻塞；数值本身全对，问题都在旁证文字）

1. **`coding-reports/P003-T057.md:220-242`**：报告的「**提交后**（本卡两个提交，均已落树）」标题下贴的 `git log --oneline -2 = 9873db9 / 4346b85` 已不可复现——本卡共 **4 个提交**（4346b85、9873db9、9bffc0a、ba797d6），HEAD 是 `ba797d6`；紧邻的 `:242`「交卷后再有改动只会是动本报告这一节，不再动页面与产品代码」被 `ba797d6` 反证（该提交改了 `docs/modules/prompt-store.md:92` 与 `evidence/recon/P003-T057.md:5-6`）。
   复现：`git log --oneline 3d68055..HEAD`；`git show --stat --oneline ba797d6`。
2. **`docs/modules/prompt-store.md:92`**：括号里「`git log -S` 全仓只此一处」按字面不复现——不带路径过滤 `git log --oneline -S rule-maintenance.md | wc -l` → **8**。能得出「只此一处」的是带过滤那条：`git log -S "rule: 'rule-maintenance.md'" -- prompt-store.js` → 仅 `5256d0e`（我实跑，输出单条）。出处本身（P003-T013 / `5256d0e`）是对的。
3. **`coding-reports/P003-T057.md:67`**：「19 处（16 行）」两个数都对（我按 diff 数：19 处 / 16 行），但冒号后的行号清单只列了 14 行，漏 §10 的 `:450`、`:452`，复核者照清单数会得出 14 与「16 行」自相矛盾。

**卡外记录（非本卡责任，不立 finding）**：`docs/architecture.md:318` 仍写「`prompts/` 下有 6 个核心提示词文件」，不在本卡放开路径内（本卡只动 `docs/modules/prompt-store.md`），P003-T013/T056 已记过同一处；门禁 `violations` 为 `[]`，不拦。

## 4. 残余风险

- 页面里引用 `prompt-store.js:<行号>` 的**行号本身**我按黑盒纪律不读实现、无法逐条目视核对；只做了两类侧证：`readFile` 调用点结构查询（`2 33 41 42 48`）与行为实测。行号漂移若存在，本报告看不出来（页面 159 处行号引用的一致性归 P003-T056 那张卡的口径）。
- 门禁两条 `coverage_degraded` warning 是环境既有（`no_base_commit` / `no_codegraph_affected`），不是本卡引入，也无法在本树消掉。
- 本卡未跑浏览器/e2e 面：改动是纯文档数值，无 UI 触点。

## 5. 证据文件

- `evidence/test/P003-T057/tester-acceptance.sh`（一键复跑脚本，每条外部命令带 timeout）
- `evidence/test/P003-T057/tester-acceptance-run.txt`（本次全程输出，`SCRIPT EXIT=0`）
- `/tmp/t057-strace/trace.txt`（strace 原始 openat 记录，23 条读盘明细）
- `/tmp/t057-base-check/`（`git archive 3d68055` 导出的改前基线树，门禁改前跑在这上面）
