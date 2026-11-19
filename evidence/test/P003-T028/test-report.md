# P003-T028 · 后端验收（黑盒）测试报告

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T028`
- 分支 `task/hids-ai-console-P003-T028`，HEAD `995711e`（开工时 `git status --short` 仅 `.pi-child-claim.json`）
- 环境：Node v26.13.0；`web/node_modules/jsdom` 已存在（按派活要求未重装）
- 判据：任务卡 A1–A4 原文 + `docs/_meta/gaps.md` 第八节测试口径 + `docs/architecture.md` 测试命令段
- 结论：**PASS**（A1–A4 全绿；3 条 minor 全在文档锚点精度，不挡推进）

## 一、门禁（本终端亲跑，未转录任何他人输出）

| # | 命令 | 结果 |
| --- | --- | --- |
| A1 | `timeout 120 node --test maintenance-startup.test.js` | **EXIT=0**，tests 1 / pass 1 / fail 0，duration_ms 104.9 |
| A2 | `timeout 300 npm run test:web` | **EXIT=0**，tests 447 / pass 447 / fail 0，duration_ms 5122.5 |
| A3 | `timeout 180 npm test` | **EXIT=0**，tests 198 / pass 198 / fail 0，duration_ms 666.2，自行结束无挂起 |
| A3 | `timeout 300 npm run test:all` | **EXIT=0**，198/198 + 447/447（两段汇总行都在） |
| — | `for i in 1 2 3; node --test maintenance-startup.test.js` | 3/3 次 EXIT=0，pass 1 / fail 0（无 flake） |

A1 用例读的是真实路径：`maintenance-startup.test.js:14` spawn `<tmp>/current/maintenance-server.js`，
symlink `current → 仓根`，断言输出含 `只读预览` 且 `child.exitCode===null`，5s 超时 + `finally` SIGTERM + `t.after` 清理——
无永真断言、无残留进程（跑完全机 `ps` 探针 `stray_count=0`）。

## 二、变异验红（亲手复现两处，证明退出码语义与守卫有判别力）

1. **套件退出码**：写入 `zz-t028-tester-probe.test.js`（`assert.equal(1,2)`）→ `timeout 180 npm test` **EXIT=1**，
   `tests 199 / pass 198 / fail 1`，红项名恰为 `tester probe must be red`；删除后复跑 **EXIT=0** `198/198`，`git status --short` 回净。
   → 「全绿 0 / 一红 1」不是空口，是实跑。
2. **维护启动路径修复本身**：`git show 8f500ae:maintenance-startup.test.js` 取改前版本落成 `zz-prefix-probe.mjs`
   （非 `*.test.js`，不进 `npm test` 扫描面），`timeout 60 node --test zz-prefix-probe.mjs` → **EXIT=1**，
   `Cannot find module '<tmp>/current/backend/maintenance-server.js'`；删探针后树净。
   → 改前的错误路径确实红、改后绿，修复有判别力，不是把用例改松。

## 三、A4：evidence 历史验证件零改动

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 提交面改动类型 | `git diff --name-only --diff-filter=MD 8f500ae..HEAD -- evidence/ \| wc -l` | `0`（只有 A，10 个新增全在 P003-T028 自己的 recon/test 子目录） |
| 工作树 | `git status --short evidence/ \| wc -l` | `0` |

## 四、范围核对

`git diff --name-only 8f500ae..HEAD` 去掉 `docs/ evidence/ coding-reports/` 后只剩：
`README.md`、`maintenance-startup.test.js`、`package.json`、`web/README.md`——零产品代码改动（server / maintenance-server / web/src 全未动，与 A4 口径一致）。

扫描面实测：仓根 `*.test.js` = **21** 个；`web/test/*.test.js` = 16 个；`evidence/test/**/*.test.js` = 11 个。
`npm test`（`node --test *.test.js`）跑出 198 条 = 只吃仓根，未递归吞 web 与 evidence 验证件，与 `gaps.md` 第八节口径一致。

## 五、发现（3 条，全 minor，doc-side，不影响 A1–A4）

### F1 `docs/architecture.md:468` 的 `package.json:10` 锚已过期（engines 实际在 `:12`）

- 文档出处：`docs/architecture.md:468`（本卡同步的段落）
- 文档说：「需要 Node.js 20 及以上（`package.json:10`）」
- 实测：`package.json:10` 现在是 `"test:all": "npm test && npm run test:web"`；`"engines": { "node": ">=20" }` 在 `package.json:12`。本卡插入 :9–:10 两行把原锚推移了。
- 复现：`sed -n '8,12p' package.json` 与 `sed -n '468p' docs/architecture.md`
- 严重度：minor（指针错，实体在；纯文档）
- 同段 `docs/architecture.md:463` 的 `package.json:8` 是对的（`"test": "node --test *.test.js"` 正在 :8），不列问题。

### F2 `web/package.json:14` 锚指向文件外（jsdom 实际在 `:11`）

- 文档出处：`docs/_meta/gaps.md:114`；同错锚还进了 `evidence/recon/P003-T028.md:14`、`coding-reports/P003-T028.md:34`
- 文档说：「`web/package.json:14` 已声明 `jsdom ^31.0.1`」
- 实测：`web/package.json` 共 13 行，`:14` 不存在；`"jsdom": "^31.0.1"` 在 `web/package.json:11`
- 复现：`grep -n jsdom web/package.json`；`grep -n "" web/package.json | tail -3`
- 严重度：minor（声明本身属实、`npm run test:web` 447 绿，只是锚点笔误）

### F3 `evidence/recon/P003-T028.md:19`/`:22` 写「20 个测试文件」，实际 21

- 文档出处：`evidence/recon/P003-T028.md:19`、`:22`
- 文档说：「只吃仓根 20 个 `*.test.js`」「后端 20 个测试文件互不共享状态」
- 实测：`ls -1 *.test.js | wc -l` → **21**（改前 `8f500ae` 也是 21）
- 复现：`ls -1 *.test.js | wc -l`
- 严重度：minor（施工图数字差一位；正式口径 `gaps.md` 未写死数字，行为无偏差）

另记一条**既有、已申报**的文档漂移，不算本卡新账：`docs/architecture.md:470`「仓里有 18 个测试文件」与实际 21 不符，
本卡 `coding-reports/P003-T028.md` 未决 3 已声明系 `8f500ae` 之前的既有漂移、不在批准改动面内。

## 六、残余风险

1. `npm run test:web` 依赖 `npm install --prefix web`（jsdom 未入库），新克隆首跑会红到装完——本卡未决 1 已申报，属刻意取舍。
2. `npm test` 不再覆盖 web 与 evidence 验证件；只跑 `npm test` 的习惯会漏 web 回归——本卡未决 2 已申报。
3. 本机 Node v26.13.0 实测；Node 20 未实机复跑（未决 6 已披露）。
4. 本卡无接口/契约变更，`docs/api/**` 的 schema 符合性、边界、错误码三样无适用面（N/A），未造空跑用例充数。

---

# 修复轮（审计打回后，2026-11-19 第二棒）

审计现场：负载下 `npm test` 连跑三把全 `EXIT=124`。本终端复现并修掉，载荷口径写在每个证据文件头部。

## 七、三条打回项的复现与修复

| # | 审计说 | 本终端复现 | 改法 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `integration.test.js:353` 的 teardown `rm` 与后台 `queue.json` 写入抢跑，ENOTEMPTY 不退出 | 负载下 3/3 `EXIT=124`；裸 `rm` 变异树 2/8、3/8 红 | `rm(..., { maxRetries: 20, retryDelay: 20 })`——Node 对 ENOTEMPTY/EBUSY 自带线性退避重试 | `load-before-fix.txt`、`mutations.txt` |
| 2 | `agent-api.test.js:560` 依赖调度时序 | **没能复现**：删掉钉住后负载下 20/20 绿 | 保留钉住（`waitFor(() => ruleCalls === 1)`），按构造消掉顺序依赖 | `mutations.txt` 变异 4 |
| 3 | `package.json` 的 `test` 要有挂起上界 | 只加 `--test-timeout=5000` 时，ENOTEMPTY 型挂起仍 3/8 `EXIT=124`（40s 被外部杀） | `node --test --test-timeout=60000 --test-force-exit *.test.js`：超时把用例标 cancelled，force-exit 保证进程退 | `hang-bound-probe.txt`、`mutations.txt` 配置 B |

## 八、修复后门禁（本终端亲跑）

| 命令 | 结果 |
| --- | --- |
| 负载下 `timeout 180 npm test` ×5（24 busy-loop + tmp 读写 churn，nproc=16） | **5/5 EXIT=0**，198/198，2.1–3.7s（`load-after-fix.txt`） |
| 同负载下单跑该用例 ×20 | 20/20 EXIT=0，0 次 ENOTEMPTY |
| `timeout 300 npm run test:web` | EXIT=0，447/447 |
| 注入永不 settle 探针 + `--test-timeout=2000 --test-force-exit` | 6/6 EXIT=1，2.45–2.85s（有界）；撤探针后 `git status` 无 zz- 残留 |

变异验红（都亲手跑）：裸 `rm` → 红；`--test-timeout` 单用 → 挂起无界；两 flag 齐 → 失败也 2s 内收场（`mutations.txt`）。

## 九、三条文档锚点（复审点名）+ 一条连带口径

| 锚 | 修前 | 修后 | 实跑核对 |
| --- | --- | --- | --- |
| `docs/_meta/gaps.md:114`、`coding-reports/P003-T028.md:34`、`evidence/recon/P003-T028.md:14` | `web/package.json:14` | `web/package.json:11` | `sed -n '11p' web/package.json` → `"jsdom": "^31.0.1"` |
| `evidence/recon/P003-T028.md:19`/`:22` | 20 个测试文件 | 21 个 | `ls *.test.js \| wc -l` → 21 |
| `docs/architecture.md:468` | `package.json:10` | `package.json:12` | `sed -n '12p' package.json` → `"engines"` |

改 `test` 命令文本后，把写死了旧命令的几处一并同步（同一口径，不是新账）：`README.md:11`、`web/README.md:38`、
`docs/_meta/gaps.md:108`、`docs/architecture.md:463/493`、`coding-reports/P003-T028.md:12`。
核对记录：`doc-anchors-check.txt`。

## 十、仍在的原账（不在本轮改动面，报给群主定）

1. `docs/architecture.md:470`「仓里有 18 个测试文件」，实际 21（缺 `paging-session` / `rule-store` / `error-observability` 三个，
   表也只列 18 行）。既有漂移，申报过，本轮不动。
2. `npm run test:web` 仍依赖 `npm install --prefix web`（jsdom 未入库），与本轮无关。
