# P003-T002 测试报告 · 知识库写接口与身份（PUT + expected_revision）

- 任务卡：P003-T002（席位 gc-backend-tester / 何东阳）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T002`
- 起活快照：派活单写 `5c23f5f`；实际 HEAD `a06a33e`（同分支多一个 `a06a33e docs: P003-T002 交卷报告`，`5c23f5f` 的子孙提交，**正当漂移**，按实际 HEAD 验收）
- 判据来源（全量文档面，未读实现）：
  - `coding-reports/P003-T002.md` §2「接口契约（实现口径）」（本卡 OpenAPI 缺口由该节代行，见 finding F2）
  - `docs/modules/knowledge-base.md:73`（`update()` 能力面）、`:222-224`（参数表）、`:299`/`:325`（R-KB-03 出处规则）
  - `docs/modules/http-api.md:84-98`（路由与鉴权口径）、`:134`（`hasAccess` 未配密码即放行）
  - 任务卡 A1–A4
- 探针：`evidence/p003-t002-write/verify.mjs`（不 import 任何产品模块；起真 `node server.js` 子进程 + 临时 wiki 目录，只发 HTTP、读产品自己落盘的文件）
- 环境：Node v26.13.0，uid 1000（非 root，只读目录可模拟 EACCES）

## 结论

**PASS。** 派活单四条锚点（A1 写回新 revision / A2 409·400·401 / A3 写失败不留半篇·队列不卡死·同版本并发一成一 409 / A4 身份不两套）在我终端里亲手跑绿；门禁自跑 118/117/1（唯一红 `maintenance-startup` 符号链接用例，起活基线 `e9f4870` 复跑同红，不在本卡 scope）。

自写探针 **100 条断言 / 98 PASS / 2 FAIL，连续两次跑结果一致**；2 条 FAIL 全部来自同一条 minor 发现（`expected_revision` 非字符串类型未被拒，F1），不挡 A1–A4。

## 一、门禁（全部本终端跑，命令原文 + 退出码）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 本树后端全套 | `timeout 300 node --test --test-reporter=tap *.test.js`（日志 `evidence/p003-t002-write/gate-full.log`） | `# tests 118 / pass 117 / fail 1`，`EXIT=1`；唯一红 `not ok 70 - maintenance CLI starts when the deployment current path is a symlink` |
| 基线复跑唯一红 | `git archive e9f4870 \| tar -x -C /tmp/p003t002-base` → `timeout 120 node --test --test-reporter=tap maintenance-startup.test.js`（日志 `baseline-maintenance.log`） | `# tests 1 / pass 0 / fail 1`，`EXIT=1`，同一现象 → 起活基线既有，**不算本卡** |
| 本卡锚点测试 | `timeout 120 node --test --test-reporter=tap wiki-current.test.js`（日志 `anchors-wiki-current.log`） | `# tests 4 / pass 4 / fail 0`，`EXIT=0`；A1/A2/A3 三条锚点分别落在 `wiki-current.test.js:56 / :80 / :113`（`sed -n '56p;80p;113p'` 逐行核对过） |
| 产品树零改动 | `git status --short` | 只有 `?? evidence/p003-t002-write/`（本报告与探针） |
| `server.js` 未被留下改动 | `sha256sum server.js` | `542c1818eeebe2c32d38fd6176f8b132762e9a63a812b403e83180509edb2a90`（变异前后同一值） |

## 二、A1 成功写回新 revision（探针 A1.0–A1.14）

真 `node server.js` 子进程（`HIDS_WIKI_DIR` 指向临时目录，仓库内 `wiki/` 全程未被碰），Basic `operator:op-pass`：

| 断言 | 实测 |
| --- | --- |
| 读页 200，`revision` 16 位十六进制 | `64254a3d5f3ca39c` |
| `PUT` 带 `expected_revision` → 200 | 200 |
| 响应 `id/path` | `HP-01` / `honeypot/HP-01.md` |
| 新 revision 与旧值不同、仍是 16 位十六进制 | `64254a3d5f3ca39c → 28b767e8a306efe5` |
| 响应字段齐全 | `path,id,title,status,updated,revision,characters,content`；`characters === content.length`（116） |
| 盘上正文已变、GET 复读同 revision | 均对 |
| 旧版备份 | `<wiki 同级>/.data/wiki-history/HP-01-64254a3d5f3ca39c.md` 存在 |
| `log.md` | 记 `操作人 operator`，记新旧 revision |
| 目录页 | `GET /api/wiki/pages` 200 且仍含 HP-01 |

## 三、A2 409 / 400 / 401 / 404 + 边界矩阵（探针 A2.1–A2.32）

| 输入 | 期望 | 实测 |
| --- | --- | --- |
| 匿名 PUT | 401 | 401，纯文本「需要登录后访问」，`WWW-Authenticate: Basic realm=…` |
| 口令错 | 401 | 401 |
| 只带 `X-Prompt-Admin-Token` | 401 | 401 |
| `expected_revision` 缺失 / null / 15 位 / 17 位 / 大写 / 非十六进制 | 400 `缺少有效的页面版本` | 全部 400，文案一致 |
| `expected_revision` 为数字 `1234567890123456` | 契约写 string → 400 | **409**（被当成版本指纹参与比对）→ F1 |
| `content` 缺失 / 空串 / 非字符串 / 30001 字 / 含 `\0` | 400 | 全部 400 `页面正文必须为 1 到 30000 字` |
| `content` 恰好 30000 字 | 200（边界含） | 200 |
| `content` 改 `id` / 状态 `archived` / 缺 frontmatter | 400 | 400 `页面 ID 必须保持一致，状态须为 active、draft 或 deprecated` |
| 只缺 `source:`（有 `evidence:`） | 200（`knowledge-base.md:299` R-KB-03：二选一即可） | 200 |
| 只缺 `evidence:`（有 `source:`） | 200 | 200 |
| `evidence:` 与 `source:` 都缺 | 400 `判据需要 evidence 或 source 出处` | 400，文案一致，页面未变 |
| 非法 JSON / 正文超限（130000 字） | 400 `{error}` | 400 `请求正文不是 JSON` / `请求正文过大` |
| 路径 `..%2Fserver.js`、`honeypot%2F..%2F..%2Fserver.js`、`%2Fetc%2Fpasswd`、`docs%2Findex.md`、`HP-01.txt` | 400 | 全部 400 + `{error:string}` |
| URI 编码坏 `%ZZ` | 400 `知识库页面路径编码无效` | 400，文案一致 |
| 空页面路径 `PUT /api/wiki/pages/` | 400 | 400 `请在路径里写明要修改的页面` |
| 页面不存在 `HP-99` | 404 `{error}` | 404（错误体带服务器绝对路径，见 F4） |
| 旧 revision | 409 `知识库页面已更新，请刷新后再提交`，不写盘 | 409，页面 revision 未变，`log.md` 一条没加 |
| 回归：`POST` 该路径只带 Basic / Basic+令牌 | 403（令牌闸）/ 404（知识库接口不存在） | 403 / 404，与 `http-api.md:176` 口径一致 |

401 是纯文本（非 JSON），400/403/404/409 全部 `{"error": string}`，与 `openapi.yaml` 的 `Error` schema 形状一致。

## 四、A3 写失败不留半篇 / 队列不卡死 / 同版本并发（探针 A3.1–A3.8）

| 场景 | 实测 |
| --- | --- |
| `chmod 0500 honeypot/` 后 PUT | 400 `EACCES: permission denied …`（非 2xx；存储错误口径见 review 的 minor，本卡未改） |
| 失败后盘上正文 | 与失败前逐字节相同 |
| 失败后目录 | 无 `.tmp` 残留，`HP-01.md` 仍在 |
| 恢复权限后同版本再写 | 200（串行写队列没卡死） |
| 同 revision 并发两次 PUT | `200,409`（一次成功一次 409，落败方 `{error}` 形状正常） |
| 并发后最终页 | revision/content 都等于胜出请求；无 `.tmp` 残留 |

## 五、A4 身份口径（探针 A4.1–A4.5）

| 请求 | 实测 |
| --- | --- |
| Basic 写页面 | 200（A1） |
| 只带管理员令牌写 | 401（写路径不认维护端令牌） |
| Basic 读 `GET /api/wiki/sessions` | 403 `知识库管理员凭据无效`（两套身份没并成一套） |
| Basic + 令牌读 sessions | 200 `{sessions: []}`（会话族口径未变） |
| Basic 读 `GET /api/wiki/health` | 403 |
| 只带令牌读页面 | 401（读路径仍认 Basic） |
| `log.md` 操作人 | 只有 `operator`，没有第二个身份来源 |

## 六、变异验红（亲手复现，不引用他人）

1. 变异前 `sha256sum server.js` → `542c1818…db2a90`；`cp server.js /tmp/p003t002-server.orig.js`
2. 结构定位（只取行号，不看内容）：`grep -no '0-9a-f\]{16}' server.js` → `271`、`324`（324 为 wiki 写路径的版本指纹守卫）
3. `sed -i '324s/{16}/{99}/' server.js && node --check server.js` → 变异态
4. `timeout 180 node evidence/p003-t002-write/verify.mjs`（日志 `verify-mutant.log`）→ `EXIT=1`，**25 条 FAIL**：A1.1 变 400、A1.2–A1.12 连带红、A2.26/27 由 404/409 变 400、A3.4/3.5 红、A4.5 红 → 断言不是永真
5. 还原：`cp /tmp/p003t002-server.orig.js server.js` → `sha256sum` 与第 1 步逐字相同
6. 还原后重跑探针（`verify-final-3.log` / `verify-final-4.log`）→ `100 / 98 PASS / 2 FAIL`，两次完全一致；`wiki-current.test.js` 4/4 绿，全量门禁回到 118/117/1

## 七、findings

| # | 严重度 | 类型 | 文档出处 | 文档说 | 实测 | 复现 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | minor | 实现（类型不严） | `coding-reports/P003-T002.md:35` | `expected_revision` 是 string，16 位十六进制；「不是 16 位十六进制 → 400」 | 传 JSON 数字 `1234567890123456`（16 位数字）：格式校验按字符串化通过，最终与当前 revision 不等 → **409**「知识库页面已更新，请刷新后再提交」，而不是 400 | `node evidence/p003-t002-write/verify.mjs`，看 `FAIL A2.11`（两次连跑一致） |
| F2 | major（doc-side，卡上 forbidden 留给 T004） | 契约漏写 | `openapi.yaml:505-519` | `/api/wiki/pages/{pagePath}` 只有 `get`；本卡新增的 `put`（Basic + expected_revision、200/400/401/404/409）无机器可读契约 | 实测 PUT 行为完整（A1–A4），但 `openapi.yaml` 里没有这条 operation；T007 前端只能读交卷报告 | `sed -n '505,520p' openapi.yaml`（该路径段只有 get，无 put）；对照 `coding-reports/P003-T002.md:27-51` |
| F3 | minor（doc-side） | 契约措辞歧义 | `coding-reports/P003-T002.md:47` | 400 条件写成「缺 `evidence:` 或 `source:`」，读起来像任一缺失就 400 | 按 `docs/modules/knowledge-base.md:299`（R-KB-03「二选一」）：单缺一条 → 200，两条都缺才 400「判据需要 evidence 或 source 出处」；实测与模块文档一致 | 探针 `A2.19 / A2.20 / A2.20b-c` |
| F4 | minor（doc-side / 信息暴露） | 错误体泄露路径 | `coding-reports/P003-T002.md:50` | 404 体是 `{"error":"ENOENT: ..."}` | 实际 body 带服务器绝对路径：`ENOENT: no such file or directory, open '/tmp/…/wiki/honeypot/HP-99.md'`；契约没写会泄露绝对路径 | 探针 `A2.26`（日志 `verify-final-4.log`） |
| F5 | minor（doc-side） | 模块文档未同步 | `docs/modules/knowledge-base.md:73` | `update(filename, content, expectedRevision)` 三参 | 本卡给 `update()` 加了可选第四参 `note`（log.md 「要点」记操作人），文档签名与错误面表（`:222-224`）未提 | `grep -n "update(filename" docs/modules/knowledge-base.md`；对照 `coding-reports/P003-T002.md:11`（第 5 行改动） |
| F6 | minor（doc-side） | 路由表未同步 | `docs/modules/http-api.md:90-98` | 路由表里 `/api/wiki/pages/{path}` 只有 GET | 新增 `PUT` 分支未进表；`http-api.md` 行号基准还是 `35530d8` | 同上文件；对照 `coding-reports/P003-T002.md:15` |

F2–F6 全部是文档面（本卡 scope 明写 docs/openapi 留给 T004），不挡本卡；F1 是实现面的 minor（类型严格性），改法：入口处 `typeof expected_revision === 'string'` 不满足就落 400，或在 T004 的 OpenAPI 里把类型放宽并在契约里写明「数字会被字符串化」——二选一，别两头不一致。

## 八、残余风险 / 未决

1. **未配 `HIDS_BASIC_AUTH_PASSWORD` 的部署里写接口对任何人开放**：这是全站 `hasAccess` 的既有口径（`docs/architecture.md:311`、`docs/modules/http-api.md:134`），本卡写路径继承未改；属产品口径，交卷报告 §5.3 已挂未决。
2. `expected_revision` 只接受 16 位十六进制、`null` 不当创建——「控制台新建页面」仍是缺口（交卷报告 §5.4）。
3. 探针里的写失败用 `chmod 0500` 模拟（uid 1000 非 root 有效；root 下该模拟不成立，探针未跳）。
4. 本报告与探针未提交 git（`?? evidence/p003-t002-write/`），保持产品树零改动。
5. 本卡没有 5xx 响应契约（PUT 的 4xx 四种已全部触发；存储层无 status 的错误统一落 400，见 review 的 minor 与 F1 同源错误面）。
