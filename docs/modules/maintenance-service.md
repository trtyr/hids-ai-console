---
type: module
id: MOD-MAINTENANCE-SERVICE
covers: [maintenance-server.js, update-store.js, package-policy.js]
depth: detailed
updated: 2026-11-17
---

# 维护服务（maintenance-service）

独立于业务后端跑的运维入口：运维登录后查看当前安装的研判策略、上传加密签名的升级包、核对详情后确认替换。升级包本身由内部脚本制作，签名私钥不随包交付到客户服务器（`package-policy.js:17`）。

本模块覆盖三个文件：

| 文件 | 职责 |
| --- | --- |
| `maintenance-server.js` | 维护端 HTTP 服务：访问边界、登录与会话、角色授权、升级包上传与替换 |
| `update-store.js` | 升级包信封格式、验签解密、落盘、版本与序号校验 |
| `package-policy.js` | 内部命令行：生成密钥对、把提示词快照打成加密签名的 `.hids-policy` 包 |

页面里的断言都挂 `文件:行号`。行号对应基线提交 `a16e0d5`——这三个文件在本卡基线 `35530d8` 上与该提交逐字节相同（`git diff --stat a16e0d5 HEAD -- maintenance-server.js update-store.js package-policy.js` 输出为空）。第 4 节里的命令块可以原样复跑。

## 1 职责

**做什么**

- 起一个只监听回环地址的独立 HTTP 服务，供运维登录后查看策略现状、上传升级包、确认替换（`maintenance-server.js:164-169`）。
- 把访问限制在本机：来源地址必须是回环，否则 403（`maintenance-server.js:11`、`maintenance-server.js:55`）。
- 管会话与账号角色：`updater` 可读可写，`viewer` 只读（`maintenance-server.js:42-43`、`maintenance-server.js:106-109`）。
- 校验升级包：验签、解密、比对包与环境的匹配关系与发布序号，落盘后给出包详情（`update-store.js:112-125`）。
- 提供内部命令行两件事：生成 Ed25519 签名密钥对与 32 字节加密密钥；把当前提示词快照打成加密签名的 `.hids-policy` 包（`package-policy.js:8-17`、`package-policy.js:18-33`）。

**不做什么**

- 不承载业务研判。本模块只接受 `/api/maintenance/` 前缀的路径，其余路径一律 404（`maintenance-server.js:58`）；比这一行更早的请求地址解析失败走 400（`maintenance-server.js:57`）。
- 不提供业务侧的提示词上传。本模块的上传入口只有 `POST /api/maintenance/packages` 一处（`maintenance-server.js:121-128`）。
- 不自己存提示词。升级包安装转交给提示词存储，本模块只把章节与发布记录递过去（`update-store.js:162`）。
- 不返回 HTML。响应统一由 `json()` 助手写成 JSON——`grep -n "res.end" maintenance-server.js` 只返回第 9 行这一处（`maintenance-server.js:9`）。

### 1.1 覆盖构件

模块拆分清单（[docs/modules/_breakdown.json](_breakdown.json)）给这个模块点了五个构件。下面每一行在本页都有展开：

| 构件 | 本页章节 | 关键出处 |
| --- | --- | --- |
| 维护端认证与角色 | 3.1 | `maintenance-server.js:14-18`、`maintenance-server.js:42-43` |
| 跨站写请求校验 | 3.2 | `maintenance-server.js:28-39`、`maintenance-server.js:66-67` |
| 升级包信封 | 2.3、3.3 | `update-store.js:28-59` |
| 密钥生成 | 4.1 | `package-policy.js:8-17` |
| 策略包制作 | 4.2 | `package-policy.js:18-33` |

## 2 值语义与公开面

本模块对外只有两类入口：HTTP 接口和两条命令行命令。量的取值边界如下。

### 2.1 关键量与单位

| 量 | 取值 | 单位 | 出处 |
| --- | --- | --- | --- |
| 升级包体积上限 | 2×1024×1024 | 字节 | `update-store.js:5` |
| 升级包 ID 长度 | 64 | 位十六进制字符 | `update-store.js:117` |
| 升级包文件名长度上限 | 180 | 字符 | `update-store.js:114` |
| 登录请求正文上限 | 8192 | 字节 | `maintenance-server.js:78` |
| 会话有效期 | 8×60×60×1000 | 毫秒 | `maintenance-server.js:13` |
| 会话标识 | 32 字节随机数转 64 位十六进制 | 字符 | `maintenance-server.js:88` |
| 同时保留的会话数上限 | 100 | 个 | `maintenance-server.js:87` |
| 登录失败统计窗口 / 锁定期 | 60000 | 毫秒 | `maintenance-server.js:47-48` |
| 登录失败阈值 | 10 | 次 | `maintenance-server.js:48` |
| 加密密钥长度 | 32 | 字节 | `update-store.js:29`、`maintenance-server.js:154` |
| AES-256-GCM 初始向量长度 | 12 | 字节 | `update-store.js:30` |
| GCM 认证标签长度 | 16 | 字节 | `update-store.js:51` |
| Ed25519 签名长度 | 64 | 字节 | `update-store.js:49` |
| 提示词章节正文上限 | 20000 | 字符 | `update-store.js:90` |
| 更新日志每类条目数上限 | 20 | 条 | `update-store.js:84` |
| 更新日志条目长度上限 | 1500 | 字符 | `update-store.js:85` |
| 公开说明标题 / 摘要上限 | 120 / 600 | 字符 | `update-store.js:79` |
| 维护端监听端口默认值 | 18081 | 端口号 | `maintenance-server.js:167` |

### 2.2 HTTP 接口

接口根路径是 `/api/maintenance/`（`maintenance-server.js:58`）。下表里的「响应」列只写成功路径的返回体，失败路径见第 5 节。

| 接口 | 方法 | 请求要点 | 成功响应 | 出处 |
| --- | --- | --- | --- | --- |
| `/session` | GET | 无 | 200 `authenticated`、`preview`、`login_enabled`、`user`、`role` | `maintenance-server.js:69-71` |
| `/login` | POST | JSON 正文，含 `username`、`password` | 200 `user`、`role`，并下发会话 Cookie | `maintenance-server.js:72-92` |
| `/logout` | POST | 无 | 200 `logged_out:true` | `maintenance-server.js:101-105` |
| `/overview` | GET | 无 | 200 当前发布、历史、模块列表、包列表、`writable` | `maintenance-server.js:110-120` |
| `/packages` | POST | `application/octet-stream` 正文，`x-package-filename` 头带文件名 | 201 新包 `id` 与 `version` | `maintenance-server.js:121-128` |
| `/packages/{id}` | GET | `id` 为 64 位十六进制 | 200 包详情，含 `compatible`、`applied`、`current` | `maintenance-server.js:129-131` |
| `/packages/{id}/apply` | POST | `If-Match` 头带当前 `revision` | 200 `id`、`version`、`updated_at` | `maintenance-server.js:132-136` |

`{id}` 必须是 64 位小写十六进制，正则写死在 `maintenance-server.js:129`；匹配不上就落到 404（`maintenance-server.js:138`）。

### 2.3 升级包信封

`.hids-policy` 是 JSON 信封，恰好 5 个键——多一个少一个都拒收（`update-store.js:45-47`）：

| 字段 | 含义 | 出处 |
| --- | --- | --- |
| `format` | 固定为 `hids-prompts/v1`，同时用作 AES-GCM 的附加认证数据 | `update-store.js:6`、`update-store.js:32` |
| `iv` | 初始向量，12 字节的 base64 | `update-store.js:30`、`update-store.js:34` |
| `tag` | GCM 认证标签，16 字节的 base64 | `update-store.js:34`、`update-store.js:51` |
| `ciphertext` | 明文的密文，base64 | `update-store.js:33-35` |
| `signature` | Ed25519 签名，64 字节的 base64 | `update-store.js:36`、`update-store.js:49` |

签名覆盖 `format`、`iv`、`tag`、`ciphertext` 四个字段，按这个顺序拼成 JSON 再签（`update-store.js:11-12`）；验签用同样的拼接方式（`update-store.js:50`）。

解开后的载荷字段与约束（校验逻辑在 `update-store.js:72-99`）：

| 载荷字段 | 约束 | 出处 |
| --- | --- | --- |
| `type` | 固定为 `hids-prompts` | `update-store.js:73` |
| `api_version` | 固定为 `1` | `update-store.js:73` |
| `target` | 必须等于本环境的 `HIDS_UPDATE_TARGET` | `update-store.js:75` |
| `version` | 首字符为字母数字，其余限字母数字与 `.` `_` `-`，长度 ≤ 80 | `update-store.js:76` |
| `sequence` | 安全整数且 ≥ 1 | `update-store.js:76-77` |
| `title` / `summary` | 非空字符串，长度 ≤ 120 / ≤ 600 | `update-store.js:79` |
| `date` | `YYYY-MM-DD` 形式且是真实存在的日期 | `update-store.js:80-81` |
| `changes` | `features`、`improvements`、`fixes` 三个数组，每类 ≤ 20 条，每条 ≤ 1500 字符 | `update-store.js:83-86` |
| `sections` | 章节数与当前提示词快照一致，每章 ≤ 20000 字符 | `update-store.js:87-91` |
| `knowledge_revision` | 必须等于当前知识库版本 | `update-store.js:92-93` |

### 2.4 命令行

`package-policy.js` 按参数个数分三种走法：

| 命令 | 参数 | 作用 | 出处 |
| --- | --- | --- | --- |
| `node package-policy.js --init-keys <目录>` | 一个目录 | 生成 `signing-private.pem`、`signing-public.pem`、`encryption.key` | `package-policy.js:8-17` |
| `node package-policy.js <说明.json> <输出.hids-policy>` | 两个路径 | 制作升级包 | `package-policy.js:18-33` |
| 不带参数 | — | 打印用法，退出码 1 | `package-policy.js:34-36` |

制作升级包时还要从环境变量取三样东西：`HIDS_UPDATE_KEY_FILE`、`HIDS_UPDATE_PRIVATE_KEY_FILE`、`HIDS_UPDATE_TARGET`，少一个就报错退出（`package-policy.js:21-22`）。输出文件名必须以 `.hids-policy` 结尾（`package-policy.js:20`）。

两个写文件的地方都带 `flag:'wx'`（`package-policy.js:16`、`package-policy.js:32`）——目标文件已存在时报错，不会覆盖。密钥目录用 `mode:0o700` 建、文件用 `mode:0o600` 写（`package-policy.js:10`、`package-policy.js:16`）。

## 3 行为承诺

下面每条承诺都能被证伪：拿着「依据」列的出处去对代码，或跑第 4 节的命令，看现象是不是「违反症状」那一列写的。

### 3.1 维护端认证与角色

| 编号 | 陈述 | 依据 | 违反症状 |
| --- | --- | --- | --- |
| R-MAINT-01 | 只接受回环来源：请求来源地址必须是 `127.0.0.1`、`::1` 或 `::ffff:127.0.0.1`，否则返回 403 | `maintenance-server.js:11`、`maintenance-server.js:55` | 非回环来源一律拿到 403「维护服务仅允许本机或 SSH 隧道访问」 |
| R-MAINT-02 | 预览模式下，监听地址本身也必须是回环，否则返回 403 | `maintenance-server.js:56` | 监听非回环地址时每个请求都是 403「预览仅允许本机监听」 |
| R-MAINT-03 | 认证只认两种凭据：会话 Cookie 或 Basic 头；非预览模式下账号密码必须配齐，否则进程启动就失败 | `maintenance-server.js:14-18`、`maintenance-server.js:62`、`maintenance-server.js:146-147` | 未配 `HIDS_MAINTENANCE_USER`/`HIDS_MAINTENANCE_PASSWORD` 时启动报错「必须设置独立的 HIDS_MAINTENANCE_USER 和 HIDS_MAINTENANCE_PASSWORD」 |
| R-MAINT-04 | 角色只分 `updater` 与 `viewer`：经环境变量启动时，其他取值启动即失败；只有 `updater` 能写 | `maintenance-server.js:42-43`、`maintenance-server.js:106-109`、`maintenance-server.js:148-149` | `viewer` 发写请求拿到 403「当前账号没有产品更新权限」；`HIDS_MAINTENANCE_ROLE=admin` 启动报「HIDS_MAINTENANCE_ROLE 只能为 updater 或 viewer」 |
| R-MAINT-05 | 同一来源地址在 60 秒内累计 10 次登录失败即锁 60 秒；登录成功后该计数清零 | `maintenance-server.js:45-49`、`maintenance-server.js:64`、`maintenance-server.js:84` | 第 11 次请求拿到 429「登录失败过多，请稍后重试」，锁定期内读接口也返回 429 |
| R-MAINT-06 | 会话标识是 32 字节随机数的十六进制，有效期 8 小时，Cookie 为 HttpOnly + SameSite=Strict + Path=/（仅在 TLS 连接上加 Secure）；同时最多保留 100 个会话，超出时删掉最早写入的那个 | `maintenance-server.js:13`、`maintenance-server.js:65`、`maintenance-server.js:87-90` | 第 101 个会话建立时，最早那个会话的 Cookie 立即失效 |

### 3.2 跨站写请求校验

| 编号 | 陈述 | 依据 | 违反症状 |
| --- | --- | --- | --- |
| R-MAINT-07 | 非 GET/HEAD 的请求必须过来源校验：带 `x-hids-maintenance: 1` 头；`Sec-Fetch-Site` 出现时只能是 `same-origin` 或 `none`；`Origin` 出现时协议须为 http/https 且 host 与 `Host` 头一致。任一不满足即返回 403 | `maintenance-server.js:28-39`、`maintenance-server.js:66-67` | 缺头、跨站 `Sec-Fetch-Site`、异源 `Origin` 三种情况都拿到 403「维护请求校验失败，拒绝跨站请求」 |

校验只看这三个头，不看 referer、不看 cookie 来源。`Origin` 头解析失败（不是合法 URL）也按拒绝处理（`maintenance-server.js:36`）。

### 3.3 升级包信封、版本与替换

| 编号 | 陈述 | 依据 | 违反症状 |
| --- | --- | --- | --- |
| R-MAINT-08 | 升级包先验签再解密，签名对不上直接拒收；落盘的 id 是包原始字节的 SHA-256 十六进制 | `update-store.js:50`、`update-store.js:52-58`、`update-store.js:117` | 改动签名后上传得到 400「升级包签名校验失败」 |
| R-MAINT-09 | 读回已落盘的包时重算 SHA-256 并与 id 比对，不一致即报完整性失败 | `update-store.js:132` | 磁盘上的包被改动后读取返回「已保存的升级包完整性校验失败」 |
| R-MAINT-10 | 同一个版本号不能重复应用，发布序号不能小于等于当前已装序号 | `update-store.js:95-97` | 重复应用返回 409「该版本已应用，不允许使用相同版本号覆盖」；序号偏小的包返回 409「不允许重复应用或降级到旧版本」 |
| R-MAINT-11 | 加密密钥、验签公钥、环境标识三样没配齐时不能上传也不能替换（503），概览里的 `writable` 为 false | `update-store.js:70`、`update-store.js:113`、`update-store.js:157`、`maintenance-server.js:119` | 上传返回 503「维护端尚未配置升级包密钥和环境标识」，概览 `writable:false` |
| R-MAINT-12 | 替换必须带 `If-Match` 头，缺失时返回 428，服务端不取当前版本号代填 | `maintenance-server.js:133-134` | 不带 `If-Match` 调用替换接口得到 428「请先刷新版本后确认替换」 |

## 4 关键路径与时序

这一节的三条路径按先后顺序排：先生成密钥（4.1），再做包（4.2），最后在维护端上传与应用（4.3）。命令块是原样跑过的，产物都落在临时目录里，不写进仓库。

### 4.1 生成密钥

时序：建目录（`mode:0o700`）→ 生成 Ed25519 密钥对 → 写三个文件（`mode:0o600`，`flag:'wx'`）→ 打印提示。

```bash
KEYS=$(mktemp -d)
node package-policy.js --init-keys "$KEYS"
stat -c '%n %a %s字节' "$KEYS"/*
```

实测输出（退出码 0，临时目录名已省略）：

```
密钥已创建。签名私钥只留在内部，不交付客户服务器。
/tmp/.../encryption.key 600 32字节
/tmp/.../signing-private.pem 600 119字节
/tmp/.../signing-public.pem 600 113字节
```

三个文件都是 `600` 权限，目录是 `700`（`package-policy.js:10`、`package-policy.js:16`）。`signing-private.pem` 是 PKCS#8 的 PEM，`signing-public.pem` 是 SPKI 的 PEM，`encryption.key` 是 32 字节裸密钥（`package-policy.js:12-16`）。

### 4.2 制作升级包

时序：读公开更新说明 → 取当前提示词快照 → 拼载荷 → AES-256-GCM 加密 → Ed25519 签名 → 写 `.hids-policy`（`package-policy.js:18-33`）。

```bash
OUT=$(mktemp -d)
cat > "$OUT/notes.json" <<'EOF'
{
  "version": "26.11.008",
  "sequence": 2,
  "date": "2026-11-17",
  "title": "研判策略更新 26.11.008",
  "summary": "示例公开更新说明，用于验证包制作链路。",
  "changes": { "features": ["示例：新增一条能力说明。"], "improvements": ["示例：改进一处体验。"], "fixes": [] }
}
EOF
HIDS_UPDATE_KEY_FILE="$KEYS/encryption.key" \
HIDS_UPDATE_PRIVATE_KEY_FILE="$KEYS/signing-private.pem" \
HIDS_UPDATE_TARGET=demo-customer \
node package-policy.js "$OUT/notes.json" "$OUT/26.11.008.hids-policy"
```

实测输出（退出码 0）：

```
已生成加密签名策略包；请通过维护端上传，核对详情后应用。
```

载荷里的公开说明字段（`version`、`sequence`、`date`、`title`、`summary`、`changes`）来自 `notes.json`，`sections` 与 `knowledge_revision` 来自本机的提示词快照（`package-policy.js:24-27`）。所以 `notes.json` 的取值必须满足第 2.3 节的约束，否则包做出来了也会在上传时被拒。

做出来的文件是 JSON 信封，键恰好 5 个：

```bash
node -e "const b=require('fs').readFileSync(process.argv[1]);const e=JSON.parse(b.toString('utf8'));\
console.log('字节数:',b.length);console.log('键:',Object.keys(e).sort().join(','));\
console.log('iv:',Buffer.from(e.iv,'base64').length,'tag:',Buffer.from(e.tag,'base64').length,'signature:',Buffer.from(e.signature,'base64').length);" \
  "$OUT/26.11.008.hids-policy"
```

实测输出：

```
字节数: 90844
键: ciphertext,format,iv,signature,tag
iv: 12 tag: 16 signature: 64
```

### 4.3 上传并应用一个升级包

时序：启动维护端 → 登录拿会话 Cookie（或直接用 Basic 头）→ 上传包 → 读详情核对 → 从概览取 `revision` → 带 `If-Match` 确认替换。

```bash
HIDS_MAINTENANCE_USER=ops HIDS_MAINTENANCE_PASSWORD=s3cret \
HIDS_MAINTENANCE_ROLE=updater HIDS_MAINTENANCE_PORT=18099 \
HIDS_UPDATE_KEY_FILE="$KEYS/encryption.key" HIDS_UPDATE_PUBLIC_KEY_FILE="$KEYS/signing-public.pem" \
HIDS_UPDATE_TARGET=demo-customer HIDS_UPDATE_STORE_DIR="$OUT/packages" \
HIDS_PROMPT_STORE_FILE="$OUT/prompt-overrides.json" \
node maintenance-server.js &
```

`HIDS_PROMPT_STORE_FILE` 指到临时目录，是为了让替换写到的提示词覆盖文件不落在仓库里；`HIDS_UPDATE_STORE_DIR` 同理。

登录（写请求要带 `x-hids-maintenance: 1`）：

```bash
curl -s -c "$OUT/jar" -X POST -H 'x-hids-maintenance: 1' \
  -H 'Content-Type: application/json' \
  -d '{"username":"ops","password":"s3cret"}' \
  http://127.0.0.1:18099/api/maintenance/login
```

实测输出：`200 {"user":"ops","role":"updater"}`，同时下发名为 `hids_maintenance_session` 的 Cookie（`maintenance-server.js:88-90`）。

上传（把响应里的 `id` 接进 `$ID`，下面用它）：

```bash
ID=$(curl -s -b "$OUT/jar" -X POST -H 'x-hids-maintenance: 1' \
  -H 'Content-Type: application/octet-stream' \
  -H "x-package-filename: 26.11.008.hids-policy" \
  --data-binary "@$OUT/26.11.008.hids-policy" \
  http://127.0.0.1:18099/api/maintenance/packages \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
echo "$ID"
sha256sum "$OUT/26.11.008.hids-policy"
```

实测输出（两行是同一个值）：

```
a1f221fe313898f44c127c67b1b89f3f6f1a6e20d54272ac6e4b4bd87db45551
a1f221fe313898f44c127c67b1b89f3f6f1a6e20d54272ac6e4b4bd87db45551  /tmp/.../26.11.008.hids-policy
```

`id` 就是包原始字节的 SHA-256（`update-store.js:117`），可以直接用 `sha256sum` 复核。它每次重做包都会变——信封里的 `iv` 是随机数（`update-store.js:30`），所以本节不写死 id，一律用 `$ID`。上传响应体本身是 `201 {"id":"<64 位十六进制>","version":"26.11.008"}`（`maintenance-server.js:127`）。此时包已落盘，但提示词还没换——上传与应用是分开的两步。

确认替换：

```bash
REV=$(curl -s -b "$OUT/jar" http://127.0.0.1:18099/api/maintenance/overview \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).revision))")
curl -s -b "$OUT/jar" -X POST -H 'x-hids-maintenance: 1' -H "If-Match: $REV" \
  http://127.0.0.1:18099/api/maintenance/packages/$ID/apply
```

实测输出：

```
200 {"id":"afe568fd...","version":"26.11.008","updated_at":"2026-11-17T10:40:52.697Z"}
```

把同一条命令再跑一遍（模拟误操作重放），实测得到 `409 {"error":"该版本已应用，不允许使用相同版本号覆盖"}`。

### 4.4 只读预览

加 `--preview` 启动（`maintenance-server.js:164-166`），此时不配账号也能读，写一律被拒：

```bash
HIDS_MAINTENANCE_PORT=18097 node maintenance-server.js --preview
```

实测：`GET /api/maintenance/session` 返回 `200 {"authenticated":false,"preview":true,...}`；`GET /api/maintenance/overview` 返回一个写死的演示包 `id` 为 `preview-only`、版本 `26.11.007-preview`，`writable:false`（`maintenance-server.js:112-119`）；`POST /api/maintenance/packages` 返回 `403 {"error":"本地只读预览不允许上传或替换"}`（`maintenance-server.js:107`）。

## 5 失败面

下表的响应码与文案是实测或代码里写死的，测试方可直接按这一列断言。

| 失败模式 | 响应 | 出处 |
| --- | --- | --- |
| 来源不是回环地址 | 403「维护服务仅允许本机或 SSH 隧道访问」 | `maintenance-server.js:55` |
| 预览模式下监听地址不是回环 | 403「预览仅允许本机监听」 | `maintenance-server.js:56` |
| 路径不在 `/api/maintenance/` 下 | 404「接口不存在」 | `maintenance-server.js:58` |
| 写请求缺头或来源不可信 | 403「维护请求校验失败，拒绝跨站请求」 | `maintenance-server.js:67` |
| 未配维护账号就登录 | 503「维护账号尚未配置」；预览模式下是「只读预览未配置维护账号，不可登录执行更新」 | `maintenance-server.js:73` |
| 登录失败次数超限 | 429「登录失败过多，请稍后重试」 | `maintenance-server.js:74`、`maintenance-server.js:95` |
| 登录正文不是 JSON 类型 | 415「登录请求须为 JSON」 | `maintenance-server.js:75-76` |
| 登录正文不是合法 JSON | 400「登录请求格式不正确」 | `maintenance-server.js:78-79` |
| 账号或密码不对 | 401「账号或密码错误」 | `maintenance-server.js:82` |
| 账号没有后台访问权限 | 403「该账号没有后台访问权限」 | `maintenance-server.js:83`、`maintenance-server.js:99` |
| 未登录访问需要认证的接口 | 401「请使用独立维护账号登录」 | `maintenance-server.js:97` |
| 预览模式下发写请求 | 403「本地只读预览不允许上传或替换」 | `maintenance-server.js:107` |
| `viewer` 角色发写请求 | 403「当前账号没有产品更新权限」 | `maintenance-server.js:108` |
| 上传正文不是 `application/octet-stream` | 415「仅接受加密策略包文件」 | `maintenance-server.js:122-123` |
| 文件名头不是合法的 URL 编码 | 400「升级包名称编码无效」 | `maintenance-server.js:124-125` |
| 包超过 2 MiB | 413「升级包超过 2 MB」 | `maintenance-server.js:23`、`update-store.js:41` |
| 包不是合法 UTF-8 JSON | 400「升级包格式不正确，仅接受签名加密的 .hids-policy 文件」 | `update-store.js:43-44` |
| 信封的键不是规定的 5 个 | 400「升级包类型不正确」 | `update-store.js:45-47` |
| 维护端没配加密密钥或验签公钥 | 503「维护端尚未配置升级包密钥」 | `update-store.js:48` |
| base64 字段编码不合法 | 400「升级包编码不正确」 | `update-store.js:13-17` |
| 签名对不上 | 400「升级包签名校验失败」 | `update-store.js:50` |
| 解密失败或明文不是 JSON | 400「升级包解密失败或内容无效」 | `update-store.js:58` |
| 文件名不是 `.hids-policy` | 400「请选择 .hids-policy 加密策略包」 | `update-store.js:114-115` |
| 载荷类型或接口版本不对 | 400「升级包类型或应用接口版本不兼容」 | `update-store.js:73-74` |
| 包的目标环境与本机不符 | 400「升级包不适用于当前客户环境」 | `update-store.js:75` |
| 版本号或序号格式不对 | 400「升级包版本不正确」 | `update-store.js:76-78` |
| 公开说明缺字段或日期不真 | 400「升级包公开说明不完整」 | `update-store.js:79-82` |
| 更新日志格式不对 | 400「升级包更新日志格式不正确」 | `update-store.js:83-86` |
| 章节数不符或正文超长 | 400「升级包缺少完整提示词章节或章节格式不正确」 | `update-store.js:89-91` |
| 包与当前知识库版本不兼容 | 409「升级包与当前知识库版本不兼容」 | `update-store.js:92-93` |
| 版本号已应用过 | 409「该版本已应用，不允许使用相同版本号覆盖」 | `update-store.js:95` |
| 序号不比当前大 | 409「不允许重复应用或降级到旧版本」 | `update-store.js:96-97` |
| 包 ID 不是 64 位十六进制 | 404「升级包 ID 无效」 | `update-store.js:128` |
| 存的包不存在 | 404「升级包不存在」 | `update-store.js:134` |
| 存的包被改动过 | 400「已保存的升级包完整性校验失败」 | `update-store.js:132` |
| 替换缺 `If-Match` | 428「请先刷新版本后确认替换」 | `maintenance-server.js:133-134` |
| 其它未预期的异常 | 500「维护服务处理失败，请检查后端记录」 | `maintenance-server.js:139-141` |

带 `status` 的异常会原样透出状态码；没有 `status` 的一律按 500 处理（`maintenance-server.js:140`）。

## 6 资源与余量

| 项 | 取值 | 出处 |
| --- | --- | --- |
| 升级包体积上限 | 2 MiB（2×1024×1024 字节） | `update-store.js:5` |
| 落盘占用 | 包字节的 base64，约 4/3 倍（实测 90844 字节的包落盘 121291 字节） | `update-store.js:121` |
| 同时保留的会话数 | 100 个 | `maintenance-server.js:87` |
| 会话有效期 | 8 小时 | `maintenance-server.js:13` |
| 登录失败窗口与锁定期 | 60 秒 | `maintenance-server.js:47-48` |
| 登录请求正文上限 | 8192 字节 | `maintenance-server.js:78` |
| 升级包目录与文件权限 | 目录 700、文件 600 | `update-store.js:119-122` |
| 密钥目录与文件权限 | 目录 700、文件 600 | `package-policy.js:10`、`package-policy.js:16` |

单次请求的耗时与并发没有实测值——本卡只测了功能分支。

## 7 约束与理由

**约束**

- 维护端是独立进程，监听地址写死回环（`maintenance-server.js:168`）；运维的访问路径是本机或 SSH 隧道，代码里的 403 文案就是这么写的（`maintenance-server.js:55`）。
- 维护账号与业务端凭据分开配，代码要求「独立的 HIDS_MAINTENANCE_USER 和 HIDS_MAINTENANCE_PASSWORD」（`maintenance-server.js:146-147`）。
- 上传与应用是分开的两步：上传只把包落盘并返回 `id` 与 `version`（`maintenance-server.js:126-127`），应用是另一个请求，且必须带 `If-Match`（`maintenance-server.js:132-135`）。这样运维能在替换前先读包详情（`update-store.js:144-145`）。
- 加密与签名分两层：制包时先用 AES-256-GCM 加密，再对信封的四个字段做 Ed25519 签名（`update-store.js:28-37`）；开包时先验签再解密（`update-store.js:50-58`）。
- 签名私钥只留在内部：密钥生成后提示「签名私钥只留在内部，不交付客户服务器」（`package-policy.js:17`），维护端只配公钥（`maintenance-server.js:156-159`）。
- 加密密钥、验签公钥、目标标识三样齐了才能上传或替换（`update-store.js:70`、`update-store.js:113`）。

**已知边界**

- 读正文超限时直接抛 413，读正文的循环随即中止，不会把超限的正文读完（`maintenance-server.js:21-25`）。
- 预览模式返回的包列表是写死的常量，不读上传目录（`maintenance-server.js:112-118`）。
- 概览里的 `writable` 由三件事同时决定：不在预览模式、角色是 `updater`、密钥/验签公钥/目标标识三样都配齐（`maintenance-server.js:119`、`update-store.js:70`）。
- 包列表每多一个包，概览就多一次详情计算（`update-store.js:152`）。详情计算只在包**还没应用过**时重跑一遍载荷校验（`update-store.js:142`），那次校验会重取一次提示词快照（`update-store.js:87`）；已应用的包跳过校验，不取快照。包多时这项开销随包数增长。

## 8 指针

- 架构篇 [../architecture.md](../architecture.md)：第 3.2、3.3 节讲这两个进程入口，第 9.4、9.5 节讲维护端的访问边界与升级包的密码学边界，第 10.2 节列相关环境变量。
- 模块拆分清单 [_breakdown.json](_breakdown.json)：本模块的 `files` 与 `components` 字段。
- 已知边界台账 [../_meta/gaps.md](../_meta/gaps.md)：本模块未查清、存疑的地方。

本页的证据范围只有 `maintenance-server.js`、`update-store.js`、`package-policy.js` 三个文件。提示词存储的行为不在范围内——涉及它的地方，本页只写到「转交」那一步（`update-store.js:162`）。
