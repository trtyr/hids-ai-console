# P003-T028 测试证据（测试基线卫生）

工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T028`（Node v26.13.0）
所有日志在本目录，命令原始输出未改。

## 一、改前（基线）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `timeout 180 npm test`（`test` 原为裸 `node --test`） | **退出码 124**：180s 到点未跑完，无汇总行；输出里同时出现 `evidence/test/**` 验证件与 `web/test/**` 的失败 | 本目录 `baseline-before-fix-root-sweep.extract.txt`（原文 220K 日志的扫描面 + 失败行摘录） |
| `node --test *.test.js` | 退出码 1：tests 198 / pass 197 / fail 1，唯一红 `maintenance CLI starts when the deployment current path is a symlink`（`Cannot find module '.../current/backend/maintenance-server.js'`） | `baseline-before-fix-backend.txt` |
| `node --test web/test/app.test.js`（`web/node_modules` 未装） | 退出码 1：`ERR_MODULE_NOT_FOUND: Cannot find package 'jsdom'` | `baseline-before-fix-web-jsdom-missing.txt` |

## 二、改后

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npm test` | **退出码 0**：tests 198 / pass 198 / fail 0，2.0s | `npm-test.txt` |
| `npm test`（注入一条必红用例 `zz-t028-exit-probe.test.js`，验完即删） | **退出码 1**：tests 199 / pass 198 / fail 1 | `npm-test-red-probe.txt` |
| `npm run test:web`（先 `npm install --prefix web`，装 jsdom 31.0.1） | **退出码 0**：tests 447 / pass 447 / fail 0，5.8s | 报告正文引用输出 |
| `npm run test:all` | **退出码 0**：198 + 447 全绿，6.3s | `npm-test-all.txt` |

退出码记录：`exit-codes.txt`。

## 三、范围核账

- `git status --short evidence/test/P003-T015` → 空；`git diff --stat` 里没有 `evidence/test/**` 任何文件（A4）。
- 改后 `npm test` 的扫描面 = 仓根 21 个 `*.test.js`，不含 `evidence/test/**`、不含 `web/test/**`。
