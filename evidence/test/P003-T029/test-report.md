# P003-T029 测试报告（测试席 · 何东阳）— 复审第 2 轮（测试打回后）

- 任务卡：P003-T029 配置可写：牧云与模型运行中任改、落盘、重启仍生效、不回显（后端）
- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T029`（HEAD `f63f6b5`）
- 起活快照 commit：`f63f6b5`（复审提交；本轮树没漂，未走重验预案）
- 代码审查判词：`verdicts/P003-T029-gc-backend-code-review-mwnjhr69.json`（pass）
- 测试审计判词：`verdicts/P003-T029-gc-backend-test-review-mwnjsksg.json`（**fail / reject_test**，三条：无超时上界 major、A1 锚点 minor、探针继承 ambient env minor）— 本轮只改测试面，产品代码一字未动
- 判据来源只有契约文本：`openapi.yaml` 的 `writeConfig`、`docs/modules/http-api.md` §3.1 / §3.5 / §3.6 / §4 / §9、`evidence/recon/P003-T029.md`。没读实现、没按实现补期望。
- 我的套件：`evidence/test/P003-T029/config-write.tester.test.js`（6 条，6 pass / 0 fail；串行连跑 3 次 + 三份并发（负载）3 次，全绿）
- 我的探针：`evidence/test/P003-T029/probe-corrupt-and-auth.sh`（12 PASS / EXIT=0，真进程，`start_app` 起进程用 `env -i`）
- 写者套件与探针（我亲跑）：`config-write.test.js`（10/10）、`probe-config-write.sh`（19 PASS / EXIT=0）
- 上游契约套件（A7）：`evidence/test/P003-T025/config-contract.tester.test.js`（13/13）

## 结论

**PASS。** A1–A7 在我自己终端上重验，全绿。上一轮我补的三样（schema 符合性 / 边界矩阵 / 错误码）断言未动。
本轮按测试审计只修测试面三处：**每条请求都有超时上界**（6 处 fetch 带 `AbortSignal.timeout(5000)`、两个探针 17 处 curl
带 `--max-time 5 --connect-timeout 2`、门禁命令带 `timeout 180` + `--test-timeout=30000`）、**探针起进程清环境**
（`env -i`，两份探针都带，带 `HIDS_BASIC_AUTH_PASSWORD` 环境跑也是 exit=0）、**A1 锚点改 :117-118**。
超时守卫与 `--test-timeout` 各自亲手做过「卡住必变红」的自证（见 §六），不是加了参数就算数。

## 一、验收逐条（A1–A7）

| 验收 | 我的证据 | 实测 |
| --- | --- | --- |
| A1 写后 GET 立刻反映 + live 生效 | 写者探针（我亲跑，`env -i` 起进程）＋ `config-write.tester.test.js:117-118` | 真进程：`POST` 200 → 同一进程 `GET /api/config` 立刻报 `runtime-model`；`/api/status` 从 502 变 200，stub 收到的 Cookie 是 `API-Token=new-token-abcdef`（新 Token 真被用上）；`/api/status` 走新地址。进程内：写后响应里的 `config` 与随即 GET `deepEqual`（`:118`） |
| A2 响应不回显机密 | `config-write.tester.test.js:69`（200 正文）/:151（400 正文）/:227（500 正文）＋ 写者探针 | 200 正文不含新/旧 Token 与密钥原文，`secrets` 只布尔；400 的坏值 `ftp://secret-token-abcdef` 不在错误正文里；500 正文不含 `EACCES`/文件路径/提交值；真进程日志不含 Token |
| A3 鉴权两态 | `config-write.tester.test.js:126` ＋ `probe-corrupt-and-auth.sh` | 配口令：无凭据/错口令 POST 与 GET 都 401，纯文本四条头（`Basic realm="HIDS AI Console", charset="UTF-8"` / `text/plain; charset=utf-8` / `no-store` / `nosniff`）、正文「需要登录后访问」、被拒的写一个字没落盘；正确凭据 200。没配口令：写放行（文档 §3.6 写明）。配口令未配用户名：`admin` 凭据可写、`ops` 401（§4 兜底口径） |
| A4 落盘重启仍生效 | 写者探针重启段（我亲跑）＋ `probe-corrupt-and-auth.sh` | 写 → 杀 → 同一环境变量重启：改过的值仍生效、监听端口与没改过的键照旧读环境变量；覆盖层只存改过的键、权限 0600；删掉覆盖层后回到环境变量。覆盖层写坏（`{ 这不是 JSON`）真进程照常起来、生效值回到环境变量、日志恰一条 `config.load_failed`，坏文件之后仍能写 |
| A5 `config.updated` 只带键名 | `config-write.tester.test.js:121-123` ＋ 两个探针 | 真进程日志 `{"event":"config.updated","keys":["LLM_MODEL"]}`；两次被拒的写不新增该事件（1 → 1）；日志里没有 Token 原文 |
| A6 openapi + http-api 五键同步 | `python3 yaml.safe_load` 现场解析 ＋ `grep` | `/api/config` 恰 `get`+`post`；`requestBody.properties` 恰 5 键（`CLOUDWALKER_URL`/`CLOUDWALKER_API_TOKEN`/`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`）、`additionalProperties:false`、`minProperties:1`；200 `required:['updated','config']`、`updated.items.enum` 五键；400/401/500 都在。http-api §3.1 有 `POST /api/config` 行、计数 37 与 `grep -c` 实测 37 一致；`server.js:642`/`:646-650`、`config-store.js:22`/`:76`、`server.js` 1085 行与 §3.6 锚点逐一对上；全文无「六项/六个」残余 |
| A7 T025 旧断言 POST 400 未动 | `git diff 3c3160d..f63f6b5` ＋ 契约套件亲跑 | 复审两提交的 diff 不含 `config-contract.tester.test.js`；该文件唯一的改动在 `63ae9d3`（群主裁定的 scope 扩一条）：`POST /api/config` 404 → 400 `caller_error`、尾斜杠仍 404。亲跑 13/13 绿 |

## 二、schema / 边界 / 错误码（我补的那三样）

**schema 符合性**（`config-write.tester.test.js:69`）：200 正文顶层恰 `{updated, config}`；`updated` 是正文顺序的键名数组；
`config` 八键恒在（`host` string / `port` integer / `triage_input_mode` ∈ {syslog,poll} / `cloudwalker` 恰 `{configured:boolean}` /
`model` 恰 `{configured, name}` / `auth` 恰 `{basic_auth_enabled:boolean}` / `secrets` 五键且都是 boolean / `missing_required` string[]）；
头三条 `application/json; charset=utf-8` + `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`。

**边界与 400 矩阵**（`:151`，20 条逐条请求）：非 JSON、`null`/`[]`/`"str"`/`42`、`{}`、表外键逐个
（`HIDS_PORT`/`HIDS_TRIAGE_INPUT_MODE`/`HIDS_PROMPT_ADMIN_TOKEN`/`HIDS_RULE_ADMIN_TOKEN`）、多键不可写（「、」隔开且互不吞）、
`""`/`"   "`/`7`/`null`/`["x"]`/`{"a":1}`、`ftp://` URL、无 scheme 的牧云地址、5 位 Token、正文 9000 字（`请求正文过大`）。
每条都断言 **状态 + `code` + 原话 + 错误正文两键形状**，且跑完 `GET` 仍是旧值、覆盖层 `{}`、目录里没落文件。
下界放行：Token 恰 6 位 + `http://a` → 200（`:201-211`）。合并后生效值：env 缺 `LLM_API_KEY` 时只改 `LLM_MODEL` 也 400（§3.6 口径，`:222` 段）。

**错误码覆盖**：400（上表六类）、401（形状四条头 + 正文纯文本）、500（`:244` 段把目标目录 chmod 500 → 落盘失败 →
`{"error":"服务器内部错误","code":"internal_error"}`，正文两键、不漏异常原文、内存与 env 不变、不留 `.tmp`）。
404/405 与 `PUT /api/config` → 404 由写者套件与 T025 套件覆盖，我亲跑全绿。

## 三、变异验红（上一轮亲做，断言本轮未改）

```
1) config-store.js:72 删 `await unlink(temporary).catch(() => {});`
   → node --test evidence/test/P003-T029/config-write.test.js
   → tests 10 / pass 9 / fail 1，恰红「写盘失败不留临时文件」；git checkout 还原（树干净）
2) config-store.js:97 「配置项取值必须是非空字符串：」→「配置项取值不合法：」
   → node --test …/config-write.tester.test.js → tests 6 / pass 5 / fail 1，恰红「边界与 400 矩阵」；还原
3) server.js:375 INTERNAL_ERROR_MESSAGE「服务器内部错误」→「内部错误」
   → 同一套件 → tests 6 / pass 5 / fail 1，恰红「500：落盘失败回 internal_error」；还原
```

## 四、门禁原文（全串行，一条一条跑；每条都带上限）

```
$ timeout 180 node --test --test-timeout=30000 evidence/test/P003-T029/config-write.tester.test.js   （串行 ×3）
  → tests 6  pass 6  fail 0  exit=0   ×3（175ms / 177ms / 174ms，无 flake）
$ for i in 1 2 3; do timeout 180 node --test --test-timeout=30000 …config-write.tester.test.js & done; wait   （三份并发＝负载）
  → 每份 tests 6 / pass 6 / fail 0，三个 exit 全 0
$ timeout 180 node --test --test-timeout=30000 evidence/test/P003-T029/config-write.test.js
  → tests 10  pass 10  fail 0  exit=0
$ timeout 180 node --test --test-concurrency=1 --test-timeout=30000 evidence/test/P003-T025/config-contract.tester.test.js
  → tests 13  pass 13  fail 0  exit=0
$ timeout 180 env HIDS_BASIC_AUTH_PASSWORD=gate-pass-abcdef bash evidence/test/P003-T029/probe-config-write.sh
  → 19 PASS  EXIT=0（ambient 带口令也过：start_app 用 env -i 起进程）
$ timeout 180 env HIDS_BASIC_AUTH_PASSWORD=gate-pass-abcdef bash evidence/test/P003-T029/probe-corrupt-and-auth.sh
  → 12 PASS  EXIT=0（同上，端到端脚本退出后才 next）
$ timeout 600 node --test --test-concurrency=1 --test-timeout=30000 *.test.js evidence/test/*/*.test.js
  → tests 334  pass 332  fail 1  todo 1  exit=1
  → 唯一红：maintenance-startup.test.js「maintenance CLI starts when the deployment current
    path is a symlink」（docs/_meta/gaps.md:19-31 既有项，与本卡无关）
$ python3 -c "yaml.safe_load(open('openapi.yaml'))"                → EXIT=0（五键/additionalProperties/minProperties/enum 如上）
$ grep -c "url.pathname ===\|url.pathname.startsWith\|decodedPath.match\|url.pathname.match" server.js → 37（与 §3.1 计数一致）
```

## 五、复审修正（测试审计第 1 条：无超时上界）

- 套件 6 处 fetch（`:52` / `:117` / `:143` / `:194` / `:222` / `:244`）全部带 `signal: AbortSignal.timeout(5000)`；
  请求卡住 → fetch 抛 `TimeoutError` → 用例变红、进程能退，不再无限挂门禁。改后**行号未移位**（全部就地补参数，无新增行），
  本报告与判词里的旧锚点仍然对得上。
- 探针 curl 共 17 处（`probe-corrupt-and-auth.sh` 10 处、`probe-config-write.sh` 7 处）全部带
  `--max-time 5 --connect-timeout 2`；`start_app` 的 100×0.1s 轮询保留作上限。
- 门禁命令统一 `timeout 180 node --test --test-timeout=30000 …`（§四原文）。

## 六、测试审计第 2/3 条与守卫自证

1. **A1 锚点**：`config-write.tester.test.js:122` → **`:117-118`**（`:118` 是 `assert.deepEqual(get, config, …)`）；
   A5 保留 `:121-123`。本轮逐行核对过 52/69/117/118/121/122/123/126/143/151/194/222/227/244 的内容与报告指向一致。
2. **探针继承 ambient env**：`probe-config-write.sh:54` 的 `start_app` 补 `env -i PATH="$PATH" HOME="$HOME"`（产物层修正，
   断言一字未动）；我的 `probe-corrupt-and-auth.sh:23` 起进程本就是 `env -i`。实测（原命令照抄，带口令）：
   `timeout 180 env HIDS_BASIC_AUTH_PASSWORD=gate-pass-abcdef bash …/probe-config-write.sh` → 19 PASS / exit=0（审计打回时是 exit=1）。
3. **守卫不是永真**（`/tmp/t029-guard` 现场，不落仓）：
   - fetch 守卫：起一个「接受连接但永不复包」的 server，同一写法 `AbortSignal.timeout(500)` → `{"name":"TimeoutError","ms":504}`，
     `GUARD-OK` / exit=0 —— 证明这条超时会真的掐断并抛错（不是装饰参数）。
   - 门禁守卫：一个 `await new Promise(() => {})` 的用例，`timeout 30 node --test --test-timeout=2000 hang.test.mjs`
     → `test timed out after 2000ms` / exit=1 —— 证明挂死变红、门禁不会无限等。
   - curl 守卫：对同一不回包的端口 `curl --max-time 5 --connect-timeout 2` → `exit=28`，耗时 5s。

## 七、残余风险（没查清的，不写成查清了的）

1. **500 用例依赖非 root**：`config-write.tester.test.js:244` 段用 `chmod 0o500` 造不可写目录；以 root 跑时写盘会成功，
   该条会红——不是实现变了。本机 `whoami=trtyr`，非 root。
2. **http-api §2「`createServer` 14 个参数」与当前签名数目对不上**（本卡尾部加了 `config`，recon §二记「16 → 17」）。
   页首声明 §2 锚点按 496 行版本，本卡之前的漂移就已经存在；我没法在不读实现的前提下数准（默认值里有条件式含 `=`），
   **没查清**，也**没记 finding**——不在 A6 口径内、且非本卡引入。要收就另开一张文档小卡。
3. **并发写未测**：文档没承诺并发语义（同目录 tmp + rename 的最后写入者赢），本卡也没写。不按没写的口径判。
4. 探针会写仓内 `.data/config-overrides.json`，与契约测试并行会撞写窗口——本报告所有命令**全串行**跑；两个探针跑完都已清掉覆盖层（`test ! -e .data/config-overrides.json` 成立），无残留 server 进程。
5. `probe-config-write.sh` 是写者本轮提交的测试产物，我按审计打回在产物层补了 `env -i` 与 `--max-time`（见 §六），
   **未改其任何断言**；若写者后续重写该文件，这两条要保留。
