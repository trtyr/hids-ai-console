# P003-T019 后端测试报告 · 运行态数据落仓内 `.data/`

- 任务卡：P003-T019（后端）
- 测试席位：gc-backend-tester（何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T019`
- HEAD：`cbdeabe`（代码提交 `8e3c0aa`，基线 `f3a03ab`）
- 代码审查判词：`verdicts/P003-T019-gc-backend-code-review-mwn39y8o.json`（pass）
- 结论：**PASS**（0 blocker / 0 major；2 minor，见「五」）

---

## 一、回归优先（既有全套，改前改后对照）

HEAD：

```
$ cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T019
$ timeout 300 node --test *.test.js
EXIT=1
ℹ tests 190   ℹ pass 189   ℹ fail 1
✖ maintenance CLI starts when the deployment current path is a symlink
  Error: Cannot find module '/tmp/hids-maintenance-startup-.../current/backend/maintenance-server.js'
```

基线 `f3a03ab`（`git archive f3a03ab` → `/tmp/t019-base`，同一命令）：

```
$ timeout 300 node --test *.test.js
EXIT=1
ℹ tests 190   ℹ pass 189   ℹ fail 1
✖ maintenance CLI starts when the deployment current path is a symlink
```

**逐条测试名对比**：`diff <(base 的 189 条 pass 名) <(HEAD 的 189 条 pass 名)` → 无差异。
结论：唯一红项改前就红，本卡在测试面**零回归**（也是 A3 的直接证据之一）。

`node --test *.test.js` 只匹配仓根 21 个 `*.test.js`；新单测在 `evidence/test/P003-T019/` 下，
不在这个 glob 里（所以两次都是 190 条），这也是写者分两条命令跑的原因。

**未裸跑 `node --test`**：写者报告 §四.2 说它会闯进 `evidence/test/P003-T007/` 的浏览器 e2e。
本报告所有命令都带超时（`timeout`），未执行裸 `node --test`。

## 二、变更点测试（A1）

```
$ node --test evidence/test/P003-T019/data-dir.test.js
EXIT=0
ℹ tests 3   ℹ pass 3   ℹ fail 0
```

路径真源实机探针（导入入口模块，打印 `runtimePaths()` 的九条）：

```
$ timeout 60 node -e "import('./server.js').then(m=>{const p=m.runtimePaths();for(const [k,v] of Object.entries(p))console.log(k, JSON.stringify(v.replace(process.cwd()+'/','')));})"
EXIT=0
data ".data"
investigations ".data/investigations"
triageRules ".data/triage-rules.json"
triageMonitor ".data/triage-monitor.json"
cases ".data/cases"
baseline ".data/baseline.json"
intel ".data/intel.json"
wikiSessions ".data/wiki-sessions"
traceBoards ".data/trace-boards"
```

九条，与 `docs/architecture.md:270-279` 的清单逐条对上（八条运行态路径 + §8.1 的仓内 `.data/` 根）；没有一条带 `..` 或 `backend`。
导入本身不建目录（探针后工作树仍无 `.data`）。

### 端到端写盘实测（不只路径断言）

在 `/tmp/t019-run/repo`（`git archive HEAD` 副本，不含任何 `.data`）起真进程，
走公开接口写运行态，看文件到底落在哪：

```
$ HIDS_PORT=28099 HIDS_SYSLOG_PORT=25599 HIDS_BASIC_AUTH_USER=u HIDS_BASIC_AUTH_PASSWORD=p \
  HIDS_RULE_ADMIN_TOKEN=rt HIDS_PROMPT_ADMIN_TOKEN=pt node server.js    # 后台，随后 kill
HIDS API: http://127.0.0.1:28099

$ curl -u u:p http://127.0.0.1:28099/api/triage/rules
HTTP=200   {"config":{...示例规则...},"origin":"example","revision":null,"writable":true}

$ curl -u u:p -H "X-Rule-Admin-Token: rt" -H "Content-Type: application/json" -X PUT \
  --data '{"config":{"schema_version":1,"enabled":false,"rules":[]},"expected_revision":null}' \
  http://127.0.0.1:28099/api/triage/rules
HTTP=200   {"config":{"schema_version":1,"enabled":false,"rules":[]},"origin":"file","revision":"d2adef2ee5b86abf"}

$ find .data -maxdepth 3
.data
.data/triage-rules.json
$ find ../backend
（不存在）
```

**这正是本卡的核心行为**：接口写盘落在 `<仓库>/.data/`，仓库上一级没有生成 `backend/`。
规则文件内容与入参一致；`origin` 从 `example` 变 `file`，`revision` 非空（16 位十六进制），符合 `RuleSetResponse`。

### 边界（同一接口）

```
$ 缺 expected_revision 的 PUT
HTTP=400   {"error":"缺少有效的规则配置版本"}
```

响应体是 `Error` 形状（`{error: string}`），不是裸状态码。该接口本卡未改，此条确认 A3 的规则写入路径行为照旧。

## 三、A2：旧目录不搬不改

两处旧目录仍在（`ls -la` / `du -sh` / `stat`）：

```
$ du -sh /home/trtyr/code/backend/.data
268K
$ ls /home/trtyr/code/backend/.data
cases  investigations  trace-boards  triage-monitor.json  wiki-sessions

$ du -sh /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/backend/.data
205M
$ stat -c '%n %s %y' .../backend/.data/triage-monitor.json
.../backend/.data/triage-monitor.json 81401959 2026-11-18 18:11:06 +0800
```

时间对照：本卡代码提交 `8e3c0aa` 的时间是 `2026-11-19T13:01:43+08:00`（`git log -1 --format=%cI`）。
两处旧目录最晚修改时间是 `11-18 18:11` 与 `11-19 12:15`，都**早于本卡提交**——本卡没碰过它们。

仓库内 `.data` 在工作树里始终不存在（`ls -d .data` → 不存在），即没有把旧数据搬进来。
`git status --short` 只有本报告与 `.pi-child-claim.json`（测试产物），无产品代码改动。

与 `docs/_meta/gaps.md:11-16` 的实测数字逐条对上：268K / 205M / 81401959 B 三个数一致。

> 注：本卡的契约是「旧目录**不**搬」，与「迁移/删除类任务要求旧位不存在」相反，那条判据对本卡不适用。

## 四、A3：误报/规则/溯源零改动

1. **测试面**：见 §一，改前改后 189 条 pass 集合完全相同，唯一红项为旧账 `maintenance-startup`。
2. **规则写读实测**：`GET /api/triage/rules` → 200 示例规则回退；`PUT` → 200 落盘；`PUT` 缺版本 → 400 `{"error":...}`。
3. **业务文件零改动**：`git diff --name-only f3a03ab..HEAD` → 9 个文件，业务模块（`triage-rules.js`、`triage-monitor.js`、
   `trace-board.js`、`investigation-store.js`、`wiki-workbench.js`、`agent-tools.js`）一个不在列表里，全部是 `server.js` + 5 份文档 + 侦查/测试/报告。

## 五、变异验红（亲手复现，证明断言不是永真）

副本：`/tmp/t019-mut`（`git archive HEAD`）。每条变异跑完都还原并复绿。

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | `server.js` 里把 `const data = path.join(directory, '.data');` 改成 `path.join(directory, '..', 'backend', '.data')` | 3 条全红，首条 `AssertionError: data 应落在仓库内 .data，实际 /tmp/backend/.data`；还原 → 3/3 绿 |
| 2 | 在 `server.js` 末尾追加 `const legacyRoot = 'backend';` | 恰好第 3 条红（`server.js 里又出现了 'backend' 路径段`），另两条绿；还原 → 3/3 绿 |
| 3 | `runtimePaths()` 里把 `directory` 换成写死的 `/tmp/t019-mut` | 恰好第 2 条红（`没跟着目录走`），另两条绿；还原 → 3/3 绿 |
| 4 | 基线 `f3a03ab` + 本卡测试文件 | `SyntaxError: The requested module '../../../server.js' does not provide an export named 'runtimePaths'`，`ℹ fail 1`（旧实现上必红） |

三条断言各有一条变异能把它单独打红：路径落点、参数跟随、源码里不出现 `backend` 段。断言不是装饰品。

## 六、残余风险（没测到的）

1. **cases / investigations / triage-monitor.json 的真实写入没跑通**：这些写路径要牧云凭据或模型，本机没有。
   直接证据只覆盖 `triage-rules.json` 一条真实写盘（落 `<仓库>/.data/`，上一级 `backend/` 不生成），
   九条路径的其余八条是「同一 `runtimePaths()` 返回值 + 单测逐条断言」，属推断，申报。
2. **`HIDS_CASES_DIR` 覆盖未实测**：设了 `HIDS_CASES_DIR` 起进程后 `GET /api/agent/triage/cases` 回
   `503 {"error":"自动研判尚未配置"}`（没网关/模型时该件为 null），覆盖分支无法从公开接口观测。
   文档（`docs/architecture.md:275,376`）说案例目录默认 `<仓库>/.data/cases` 且可被环境变量换掉；默认值已由探针证实，覆盖分支未证。
3. **裸 `node --test` 会闯浏览器 e2e**（旧账，非本卡引入），本报告全程未执行。

## 七、findings（两条 minor，均不挡）

1. `coding-reports/P003-T019.md:70` 与 `evidence/recon/P003-T019.md:63` 写「22 个后端测试文件」，实测
   `ls *.test.js | wc -l` = **21**（代码审查判词已提同一处）。建议改成 21。
2. `docs/architecture.md:259` 把本卡的临时工作树绝对路径
   `/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T019/.data/` 写进正文。当前实测该路径解析正确，
   但工作树合并后即被清掉，读者按文档找不到。建议改成 `<仓库>/.data/`（正文已说「本工作树」，保留说明即可）。

## 八、证据落点

- 新单测：`evidence/test/P003-T019/data-dir.test.js`
- 本报告：`evidence/p003-t019-verify/test-report.md`
- 临时副本（可复跑）：`/tmp/t019-mut`（HEAD 变异）、`/tmp/t019-base`（基线）、`/tmp/t019-run`（真进程写盘）
- 日志：`/tmp/t019-full.log`、`/tmp/t019-base-full.log`、`/tmp/t019-run/server3.log`
