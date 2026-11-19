# P003-T034 测试报告（测试席 · 何东阳）— 复审第 2 轮后验收

- 任务卡：P003-T034 数据根迁出仓库：`HIDS_DATA_DIR` 指向机器全局位置
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T034`（HEAD `33e2edd`，分支 `task/hids-ai-console-P003-T034`）
- 代码审查判词：`verdicts/P003-T034-gc-backend-code-review-mwnlo186.json`（**pass**，第 2 轮）；第 1 轮 `mwnl2dam`（fail）的四条已修
- 上游基线（审查席亲跑，我只取它当对照，不转录当我的证据）：全量 347/346/0/1 todo EXIT=0、探针 19+12 PASS、变异恰红×2
- 判据来源：`docs/architecture.md` §8.1/§8.2、`docs/modules/http-api.md` §2/§3.6/§8、`docs/modules/knowledge-base.md` §3/§5.1/§6/§7、
  `docs/modules/prompt-store.md` §1.3/§4.3、`docs/modules/record-store.md` §3.3、`docs/modules/trace-board.md` §5.4、`openapi.yaml` `writeConfig`。
  没读实现内容，没按实现补期望。
- 我的套件：`evidence/test/P003-T034/acceptance.tester.test.js`（**14 条**，14 pass / 0 fail；串行 ×3 + ambient env ×1 全绿，单次约 6.9s）
- 我亲跑的门禁：全量 `361 tests / 360 pass / 0 fail / 1 todo（P003-T013 旧账）EXIT=0`（14.4s，含我的 14 条）、
  `probe-config-write.sh` 19 PASS EXIT=0、`probe-corrupt-and-auth.sh` 12 PASS EXIT=0、变异恰红 ×2

## 结论

**PASS。** A1–A6 在**我自己终端里**逐条重验，全绿。没有 B 类（行为与文档不符）发现；一条 doc-side 小事记在「未决」。

## 一、验收逐条（A1–A6）

| 验收 | 我的证据 | 实测 |
| --- | --- | --- |
| A1 不设 `HIDS_DATA_DIR` → `~/.local/share/hids-ai-console/`，具名路径结构不变 | `acceptance.tester.test.js`「A1 真进程不设…」/「A1 九条具名路径…」 | 真进程（`HOME` 指 tmp）`POST /api/config` 200 → 落 `$HOME/.local/share/hids-ai-console/config-overrides.json`，内容恰 `{"LLM_MODEL":"a1-written-model"}`、权限 0600，同进程 `GET` 立刻报新值；`runtimePaths('/tmp/hids-doc-root')` 九键（`data`/`investigations`/`triageRules`/`triageMonitor`/`cases`/`baseline`/`intel`/`wikiSessions`/`traceBoards`）结构与 §8.2 表逐字一致；默认根与九路径全在仓库外；`XDG_DATA_HOME` 不影响根 |
| A2 设了就用它；测试/探针全注入 tmp | 「A2 HIDS_DATA_DIR 注入…」「A2 空串…」「A2 相对路径…」「A2 只认 HIDS_DATA_DIR…」＋两探针亲跑 | 注入后覆盖层落 `<注入根>/config-overrides.json`，`$HOME` 全局根**不被创建**；重启同一 env 后 `GET` 报写入值（持久化走注入根）；`''`/`'   '`/`'\t\n'` 三种值都按「没设」落全局根；`rel/data` 按进程 cwd 绝对化；`HIDS_WIKI_DIR`/`HIDS_PROMPT_STORE_FILE` 不把根带偏；探针 19+12 PASS、跑完 `~/.local/share/hids-ai-console` 不存在 |
| A3 跑完全套测试仓库不出现 `.data/` | 全量门禁 + `test ! -e .data` | 全量 EXIT=0 后 `test ! -e .data` 成立、`git status --short` 只有我新增的测试文件（未跟踪）、真实全局根不存在；两个探针跑完同样干净 |
| A4 旧位不自动迁移 | 「A4 旧位里躺着数据时…」+ 盘上旧位实测 | 复制树里造 `./.data/investigations/old.json`、`./.data/triage-rules.json`、`./backend/.data/cases/...` 后起真进程（`HIDS_DATA_DIR` 指 tmp）：数据根里**恰** `['config-overrides.json']`（无预建目录、无迁移）、三个旧文件的 SHA-256 一字未变；盘上两处真实旧位仍在（`/home/trtyr/code/backend/.data` 268K、`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/backend/.data` 205M），与 `docs/_meta/gaps.md:8-14` 一致 |
| A5 docs 与行为一致（六处口径） | 六行原文 `sed -n` 亲读 + 行为测试 + 锚点扫描 | `architecture.md:282/:329/:349`、`knowledge-base.md:278/:289`、`record-store.md:78`、`trace-board.md:333` 逐行对上行为：内置 `wiki/` → `<数据根>/wiki-history/`（实测 `$HOME/.local/share/hids-ai-console/wiki-history/GEN-01-<16hex>.md`）；`HIDS_WIKI_DIR` 注入 → `<判据库上一级>/.data/wiki-history/`（实测 `/tmp/…/deploy/.data/wiki-history/`，数据根下**没有** `wiki-history`）；构造参数注入同口径。提示词覆盖文件实测落 `<数据根>/prompt-overrides.json`、`HIDS_PROMPT_STORE_FILE` 仍优先（§1.3）。锚点扫描（README+openapi+docs 全 19 份，只做文件存在与行数越界检查）：**3595 处，0 缺文件，0 越界**。`.env.example` 实测 33 个键（与头注一致，含 `HIDS_DATA_DIR=`）；`.gitignore:10` 保留 `.data/`（报告 §一.6 有理由） |
| A6 全量串行绿（T029 探针与 T025 套件互踩的约束继续有效） | 我亲跑全量 + 两探针 | `timeout 600 node --test --test-concurrency=1 --test-timeout=30000 *.test.js evidence/test/*/*.test.js` → **tests 361 / pass 360 / fail 0 / todo 1**（P003-T013 旧账），REAL 14.4s，EXIT=0；两探针串行跑完 EXIT=0（19 / 12 PASS） |

## 二、schema / 边界 / 错误码（我补的验收三样）

**schema 符合性**：`runtimePaths()` 九条具名路径键名与结构逐条 `deepEqual` 对 `docs/architecture.md` §8.2 表；
`dataRoot({env,home})` 三条口径（不设 / 设了 / 相对）对 §8.1 代码块；`POST /api/config` 200 正文 `updated` 顺序与 `config` 形状照 §3.6。

**边界矩阵**：
- `HIDS_DATA_DIR` = `''` / `'   '` / `'\t\n'` → 算没设（落全局根，不落名字带空白的目录）；
- 相对路径 `rel/data` → 落 `<进程 cwd>/rel/data/`，同时全局根**不**被创建；
- 只认一个键：同进程里给 `HIDS_WIKI_DIR` + `HIDS_PROMPT_STORE_FILE`，根不变；
- 注入 vs 内置两条判据历史路径各测一次（`HIDS_WIKI_DIR` 注入、构造参数注入、内置 `wiki/`），并断言「注入时不写全局根」「内置时不写部署目录」；
- 提示词覆盖：默认落数据根且覆盖文件里**只**有被改的键；`HIDS_PROMPT_STORE_FILE` 配了就用它、数据根不落文件。

**错误码**：
- **500**（§3.6 落盘失败）：数据根在 0500 目录下 → `POST /api/config` 回 `{"error":"服务器内部错误","code":"internal_error"}`（两键、不含路径、不含 `EACCES`），进程不死（随后 `GET /api/config` 仍 200），数据根无残留、无半套文件；
- **400**（§3.6 键不在可写表）：`POST {"HIDS_DATA_DIR":"/tmp/hijack"}` → 400 `caller_error`、原话点键名、覆盖层没落盘。

## 三、变异验红（亲手复现，不引用别人的）

```
M1（把本轮修的判据回退）：sed -i 's/return directory === builtinWikiDirectory()/return directory === defaultDirectory/' wiki-store.js
  → git diff --stat：1 file changed, 1 insertion(+), 1 deletion(-)
  → node --test …acceptance.tester.test.js → tests 14 / pass 13 / fail 1，EXIT=1
  → 恰红「A2/A5 HIDS_WIKI_DIR 注入：判据历史落判据库同级 .data/wiki-history，不落数据根」
  → git checkout -- wiki-store.js，git status 干净
M2（把文档 §8.1 的缺省根改成仓内 .data）：path.join(home, '.local', 'share', 'hids-ai-console') → path.resolve(".data")
  → git diff --stat：1 file changed, 1 insertion(+), 1 deletion(-)
  → node --test …acceptance.tester.test.js → tests 14 / pass 6 / fail 8，EXIT=1
  → 8 条红全是根/落点相关（A1 两条、A2 五条、A1/A5 内置 wiki 一条、提示词覆盖一条）；跑完仓库里真出现了 `.data/wiki-history/GEN-01-*.md` 与 `.data/config-overrides.json`（16K）——A3 的断言不是摆设
  → git checkout -- config-store.js && rm -rf .data，git status 干净（只剩未跟踪的我的测试文件）
```

## 四、门禁原文（全在我终端里跑；每条带上限）

```
$ timeout 600 node --test --test-concurrency=1 --test-timeout=30000 *.test.js evidence/test/*/*.test.js
  → ℹ tests 361  pass 360  fail 0  todo 1  duration_ms 14383.6   GATE EXIT=0   （real 14.4s）
$ test ! -e .data && echo PASS          → PASS
$ git status --short                    → ?? evidence/test/P003-T034/acceptance.tester.test.js（只有我这份新文件）
$ ls -d ~/.local/share/hids-ai-console  → No such file or directory
$ timeout 300 bash evidence/test/P003-T029/probe-config-write.sh        → 19 条 PASS / 0 FAIL，EXIT=0
$ timeout 300 bash evidence/test/P003-T029/probe-corrupt-and-auth.sh    → 12 条 PASS / 0 FAIL，EXIT=0
$ timeout 180 node --test --test-timeout=60000 evidence/test/P003-T034/acceptance.tester.test.js   （串行 ×3）
  → tests 14 / pass 14 / fail 0，EXIT=0 ×3（6.7s / 6.8s / 6.9s，无 flake）
$ env HIDS_DATA_DIR=/tmp/ambient-hijack HIDS_WIKI_DIR=/tmp/ambient-wiki HOME=/tmp/ambient-home \
      HIDS_PROMPT_STORE_FILE=/tmp/ambient-prompt.json node --test …  → 14/14，EXIT=0，/tmp/ambient-* 一个没留（套件不继承 ambient env）
$ python3 锚点扫描（README/docs/openapi 19 份）→ anchors 3595 | missing 0 | out-of-range 0
```

## 五、未决 / 残余风险

1. **doc-side（minor）**：数据根指到**普通文件**（不是目录）时，进程照常起来、`GET /api/config` 200，但装配阶段 `triage` 起不来
   （日志 `server.start_failed`，`ENOTDIR`），写配置回 500。`docs/architecture.md` §8.1 只写了「设了就用它」，没写「指到不可用位置会怎样」；
   §3.6 只覆盖了「落盘失败 500」。建议在 §8.1 补一句失败表现（进程是否拒绝起、triage 怎么退化），别让运维靠猜。我没拿它挡验收。
2. `update-packages/` 只有「默认跟着覆盖文件目录」的文档口径，没有端到端写证据：上传升级包需要三样密钥/环境标识（§3.3 503），本席没造；
   写者单测钉了目录推导，我的 A5 只核了文档口径与提示词覆盖文件落点。
3. `investigations/`、`trace-boards/`、`cases/` 的真实写入要模型 / 牧云 / syslog 链路，本轮用 `runtimePaths()` 结构断言 + 旧位不迁移行为断言覆盖；
   没有端到端「写出一条研判记录落数据根」的证据（成本与伪造上游的噪声不值得）。
4. 跑全量时我这份套件会被 `evidence/test/*/*.test.js` glob 带进主门禁（+14 条、约 7s）；它自己 spawn 真进程、自己 `mkdtemp`，
   ambient 环境变量（`HIDS_*`/`HOME`）全部被覆盖，跑完 /tmp 零残留。

---

## 六、复审第 4 轮复验（测试席 · 何东阳，HEAD `baa28fc`）

被验提交 `baa28fc`：7 文件全为 docs/evidence/报告（`git show --stat baa28fc`），零实现零 `*.test.js` 改动。
以下每个数字都是我自己终端里跑出来的（命令 + 退出码原文）。

| 验收 | 我的命令 | 实测 |
| --- | --- | --- |
| A1 行为面不变 | `git diff --name-only baa28fc^ baa28fc` | 7 文件：`coding-reports/P003-T034.md`、`docs/modules/knowledge-base.md`、`evidence/recon/P003-T034.md`、`evidence/test/P003-T034/{anchor-audit.txt,anchor-retake.mjs,anchor-retake.txt,merge-verify.txt}`；无任何实现/测试套件改动 |
| A2 探针注入 tmp、全局根不新增 | `timeout 180 bash evidence/test/P003-T029/probe-config-write.sh` → 19 PASS / 0 FAIL，EXIT=0；`timeout 180 bash evidence/test/P003-T029/probe-corrupt-and-auth.sh` → 12 PASS / 0 FAIL，EXIT=0；跑前跑后 `stat -c '%y' ~/.local/share/hids-ai-console` | 两探针均 `DATA=$(mktemp -d)` + `env -i … HIDS_DATA_DIR="$DATA"`；全局根 mtime 恒为 `2026-11-20 01:13:16.174617415`（早于 01:54 提交，探针/全量后一字未动），内容仍只有 `wiki/`、`rules-history/` |
| A3 跑完仓内无 `.data` | `find . -maxdepth 2 -name .data -not -path './node_modules/*'` + `test ! -e .data`（探针、全量、我的套件各跑一遍后都测） | 三次全空；`git status --short` 只有 ` D .pi-child-claim.json`（编排面文件，属起活前状态，不在本卡 diff） |
| A4 旧账申报与 MOVED 32 一致 | `timeout 180 node evidence/test/P003-T034/anchor-audit.mjs` | `锚点 3889 处：PASS=3857 MOVED=32 UNVERIFIED=0 其他=0`，EXIT=1（仅因 MOVED 旧账）；逐文档：architecture 1、event-gateway 2、evidence-view 7、experience-draft 1、investigation-agent 13、model-client 1、prompt-store 3、triage-pipeline 4 = 32，与报告 §三 未决 2 对得上；`architecture.md:222` 那条 MOVED 就是申报保留那条 |
| A5 锚点修正与重取账 | `timeout 60 node evidence/test/P003-T034/anchor-retake.mjs --base 4e65742`；`--verbose` 版与仓内 `anchor-retake.txt` `diff` | `104 处（内容映射 86、人工判 18、无依据 0）`，EXIT=0；`--verbose` 输出与 committed `anchor-retake.txt` **逐字节相同**；`anchor-audit.mjs` 里 `knowledge-base.md 413/413/0 0`。判词点名 4 处我按符号名亲验：`wiki-workbench.js:77 export class WikiWorkbench`、`:136 customer-experience/EX-*` 文件名、`:292-306` 新经验分支（`:306 createExperience`）、`:297-300` 366 天期限（`:298 expires > Date.now() + 366*86400000`）；另抽 `:90-96` save、`:153`/`:274` 会话 404、`:168` relatedEvidence、`:222` 六页上限、`:255-258` catch、`:43-48` HTTPS 校验、`:235`/`:241` sourceEvidence、`:114` 快照文件名、`:15-16` 九字段——语义全吻合。wiki-store / wiki-replay 侧另抽 18 处（`:49` browse、`:92` list、`:111` get、`:121` getById、`:127` search、`:172` health、`:195` update、`:224` checkBundle、`:269` publishBundle、`:345` createExperience、`:367` publishedFor、`:404/:449/:457` 三函数、`wiki-replay.js:15/:79/:90/:114` 四行）全对 |
| A6 全量绿 | `timeout 300 npm test`；`timeout 400 node --test --test-timeout=120000 --test-force-exit evidence/test/*/*.test.js`；单跑我的套件 | `tests 228 / pass 228 / fail 0`，EXIT=0；`tests 214 / pass 213 / fail 0 / todo 1`，EXIT=0（todo 是 `evidence/test/P003-T013/acceptance.test.js:648` 旧账）；我的 `acceptance.tester.test.js` 单跑 `tests 14 / pass 14 / fail 0`，EXIT=0 |

### 6.1 变异（守卫不是永真，亲手复现）

```
M1（锚点改动无依据必须恰红）
  sed -i '25s/wiki-workbench\.js:77/wiki-workbench.js:78/' docs/modules/knowledge-base.md
  → node evidence/test/P003-T034/anchor-retake.mjs --base 4e65742   EXIT=1
    「无依据 1：doc:25 (新增) → 78」
  → git checkout -- docs/modules/knowledge-base.md → 重跑 EXIT=0「104 处（…无依据 0）」复绿

M2（anchor-audit 的弱证据面仍在：改错行仍报全 PASS）
  把 §1.1 的「单页修订（wiki-store.js:195）」改成 wiki-store.js:49（browse 的定义行）
  → node evidence/test/P003-T034/anchor-audit.mjs --file docs/modules/knowledge-base.md
    「锚点 413 处：PASS=413 MOVED=0 …」EXIT=0
  → git checkout -- docs/modules/knowledge-base.md 还原
```

M1 证明 A5 的主判据（anchor-retake 内容映射 + HAND 表）会红；M2 证明 A5 的第二半（anchor-audit 413/413/0）**只说明没有可证伪的漂移**——非 `wiki-workbench.js` 的锚点落错行它也放行（脚本自己的注释写明「目标区间里有代码（中文描述脚本判不了）」），这一点与审查席 minor issue 1 同一事实，不是新错。

### 6.2 本轮未决 / 残余风险

1. **doc-side（nit）**：`coding-reports/P003-T034.md:219` 与 `evidence/recon/P003-T034.md:264` 写「非本卡 scope 的 **8 份**模块页共 31 处」，实际枚举 7 份（2+7+1+13+1+3+4=31），总数与 MOVED 32 对得上，是「8 份」这个措辞写错（前几轮遗留）。不影响验收。
2. **残余**：A5 的 audit 那一半对非 `wiki-workbench.js` 锚点是弱证据（见 M2 与 §6.1），本轮 `knowledge-base.md` 里 wiki-store/wiki-replay/其他文件的锚点没有逐条语义复核，我只抽了 18 处 wiki-store/wiki-replay 侧锚点全部吻合。缝与审查席 issue 1 同源，不阻塞。
