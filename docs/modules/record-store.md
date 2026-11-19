---
type: module
id: MOD-RECORD-STORE
covers: [investigation-store.js]
updated: 2026-11-17
depth: complete
---

# 研判记录存取（record-store）

一句话：把一次研判的结论按「告警 + 模式」存成一个 JSON 文件，下次用同一个键读回最近一次。

- 模块名：`record-store`（拆分清单与架构篇第 12 节的模块表里都用这个名字）
- 实现文件：`investigation-store.js`（32 行；唯一的导出是 `InvestigationStore` 类，`investigation-store.js:6`）
- 模块划分依据：[docs/modules/_breakdown.json](_breakdown.json) 里的 `record-store` 条目
- 本页每条断言的出处（源码原文 + 验证命令 + 实跑输出）：[evidence/recon/P001-T014.md](../../evidence/recon/P001-T014.md)
- 行号基线：提交 `35530d8`。代码改动后重新核对。

## 1 职责

做三件事：

- **存**一次研判结果（`save()`，`investigation-store.js:14`）
- **读**某个「告警 + 模式」最近一次研判结果（`latest()`，`investigation-store.js:25`）
- 由「告警 + 模式」**算出**记录文件的位置（`file()`，`investigation-store.js:9`）

不做的事：

- 不做研判本身——结论怎么来的、怎么校验，是研判智能体的事
- 不校验告警 ID 的**格式**——本模块只要求 `alert_id` 非空（`investigation-store.js:15`），格式校验在 HTTP 路由层（`server.js:331`）
- 不删除、不清理、不管保留期——全文件没有 `unlink` / `rm` 调用（`investigation-store.js:2` 的导入清单里只有 `mkdir`、`readFile`、`rename`、`writeFile`）
- 不做并发协调与版本号——同一键并发写靠 `rename` 竞争解决，见第 6 节

## 2 覆盖构件

拆分清单给这个模块点名了三个构件，逐个对应到代码：

| 构件 | 代码位置 | 一句话 |
| --- | --- | --- |
| 研判记录存取 | `investigation-store.js:14-31` | `save()` 写入、`latest()` 读回；读不到返回 `null` |
| 文件名散列 | `investigation-store.js:9-12` | 文件名 = `sha256(mode + ':' + alert_id)` 的十六进制 + `.json` |
| 原子写入 | `investigation-store.js:18-21` | 先写带 UUID 的 `.tmp`，再 `rename` 覆盖到最终文件名 |

构件全集以拆分清单为准：[docs/modules/_breakdown.json](_breakdown.json) 的 `record-store.components` 列的是上面三项；
[架构篇第 12 节](../architecture.md) 的同一个模块行只写了「研判记录存取」一项（`docs/architecture.md:492`）。
两处写法不同——代码里能逐个对应上的，是拆分清单那三项。

## 3 关键路径

### 3.1 存一条记录

```
save(result)
  ├─ 校验 alert_id 非空、mode ∈ {deep, triage}      investigation-store.js:15
  ├─ 加 saved_at（ISO 8601 UTC）                    investigation-store.js:16
  ├─ 算最终文件名（散列）                           investigation-store.js:17 → :9-12
  ├─ 造临时文件名（加 UUID 后缀 .tmp）              investigation-store.js:18
  ├─ 建目录（0700，已存在则不动）                   investigation-store.js:19
  ├─ 写临时文件（UTF-8、0600、wx 不覆盖）           investigation-store.js:20
  └─ rename 到最终文件名                            investigation-store.js:21
```

`save()` 返回的是加过 `saved_at` 的那个对象（`investigation-store.js:22`），不是文件路径，也不是重新读回来的内容。

### 3.2 读一条记录

```
latest(alertId, mode = 'deep')
  ├─ 算最终文件名（散列）                           investigation-store.js:27 → :9-12
  ├─ 读文件并 JSON.parse                             investigation-store.js:27
  ├─ 文件不存在（ENOENT）→ 返回 null                 investigation-store.js:28
  ├─ 身份不符（alert_id 或 mode 对不上）→ 抛错      investigation-store.js:29
  └─ 返回记录对象                                    investigation-store.js:30
```

### 3.3 记录落在哪

默认落点是仓内 `.data/investigations/`（`runtimePaths().investigations`，定义在 `server.js:805-818`，`server.js:41` 交给构造函数）。
目录名、权限与整仓的运行态目录规则见 [架构篇第 8 节](../architecture.md)；本模块只负责在给定目录下读写文件，
不决定自己被放在哪。

### 3.4 谁在调它

| 调用方 | 出处 | 调的是什么 |
| --- | --- | --- |
| 业务 API（流式分支） | `server.js:315` | `history.save(result)` |
| 业务 API（普通分支） | `server.js:322` | `history.save(result)` |
| 业务 API（查最近一次） | `server.js:332` | `history.latest(alertId, mode)` |
| 自动研判流水线 | `triage-monitor.js:375` | `history.save(result)` |
| 自动研判流水线（补证据） | `triage-monitor.js:62` | `history.latest(alert_id, 'triage')` |
| 自动研判流水线（去重后改写） | `triage-monitor.js:242-243` | 先 `latest()` 再 `save()` |

## 4 值语义

| 值 | 形态 / 单位 | 取值域 | 默认 | 空值 / 越界怎么处理 |
| --- | --- | --- | --- | --- |
| `alert_id` | 字符串，无单位 | 本模块只要求非空字符串；格式由上游校验（`server.js:331`、`server.js:100-106`） | 无 | 空串或缺失 → 抛错（`investigation-store.js:15`） |
| `mode` | 字符串枚举，无单位 | 精确等于 `deep` 或 `triage`（区分大小写） | `save()` 无默认；`latest()` 默认 `deep`（`investigation-store.js:25`） | 其他取值（含 `DEEP`）→ 抛错（`investigation-store.js:15`） |
| `saved_at` | ISO 8601 UTC 字符串，无单位 | `new Date().toISOString()` 的输出 | 由 `save()` 生成（`investigation-store.js:16`） | 不为空 |
| 记录其余字段 | JSON 原样保留 | `result` 对象里的全部字段，展开后整体保留（`investigation-store.js:16`） | — | 值里若有 `undefined`，`JSON.stringify` 会丢掉该键 |
| 文件名 | 64 位十六进制 + `.json`，无单位 | `sha256` 输出的十六进制（`investigation-store.js:10`） | — | — |
| 目录权限 | 八进制权限位 | `0o700`，仅在目录被创建时生效（`investigation-store.js:19`） | `0o700` | 目录已存在则保持原权限（实测见清单 C3） |
| 文件权限 | 八进制权限位 | `0o600`（`investigation-store.js:20`） | `0o600` | — |
| 临时文件名 | `<最终文件名>.<UUID>.tmp`，无单位 | UUID v4（`investigation-store.js:18`） | — | — |
| 落盘内容 | 无缩进的紧凑 JSON 字节 | `JSON.stringify(saved)`（`investigation-store.js:20`） | — | — |

## 5 行为承诺

编号 `R-RECORD-nn` 是本页对测试方的承诺编号，每条都带依据与反例。

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| R-RECORD-01 | 同一「告警 + 模式」在目录里至多留一份记录文件，后写的覆盖先写的 | 同一告警保存两次后目录里出现两个文件 | 文件名只由 `mode` 与 `alert_id` 决定（`investigation-store.js:9-12`），`rename` 覆盖同名（`investigation-store.js:21`） | 读到上一次的旧结论 |
| R-RECORD-02 | 文件名里不含外部告警 ID 原文，只含散列十六进制 | 文件名里出现 `revshell:7` 这样的原文 | `investigation-store.js:9-11`；注释 `investigation-store.js:5` | 告警 ID 形态泄露到路径 |
| R-RECORD-03 | 读者看到的记录文件是某一次写入的完整内容，不会读到半截 JSON | `JSON.parse` 抛 `SyntaxError` | 先写 `.tmp` 再 `rename`（`investigation-store.js:20-21`），两者同目录 | 读到被截断的结论 |
| R-RECORD-04 | 记录不存在时 `latest()` 返回 `null`；记录存在但身份与请求不符时抛「研判记录身份不匹配」 | 身份不符时返回 `null` | `investigation-store.js:28`、`investigation-store.js:29` | 把别人的记录当成这条告警的结论 |
| R-RECORD-05 | `save()` 只接受非空 `alert_id` 与 `mode` 精确等于 `deep` / `triage`，其余一律抛同一句错 | `mode: 'DEEP'` 被接受 | `investigation-store.js:15` | 落进一个 `latest()` 读不回来的目录 |
| R-RECORD-06 | `save()` 正常返回时，目录里不出现 `.tmp` 残留 | 保存后目录里多出 `.tmp` 文件 | 临时文件被 `rename` 掉（`investigation-store.js:18`、`investigation-store.js:21`） | 目录里堆垃圾文件 |

**不保证什么**（这几条不是 bug）：

- 不保证记录的保留期、容量上限与清理时机——本模块没有删除接口，也没有相关配置项
- 不保证 `alert_id` 的格式合法——只保证非空
- 不保证并发写时的先后顺序——同一个键并发写是「最后一次 `rename` 算数」，没有版本号也没有排队
- 不保证 `latest()` 读到的就是「业务上最新的一次」——它读的是那个键当前落在盘上的那一份

## 6 执行概念

**状态**：对本模块来说只有两种——「这个键有记录」和「这个键没记录」。本模块没有删除路径（`investigation-store.js:2`），
所以记录一旦写入就不会由本模块移除。

**时序**：`save()` 内部三步是有序的（写临时文件 → `rename` → 返回）；`latest()` 是一次读 + 一次解析。
`save()` 与 `latest()` 各自是单次调用内自洽的，跨调用没有顺序保证。

**并发**：

- 同一个「告警 + 模式」并发写：每次调用各自写一个带 UUID 的临时文件（`investigation-store.js:18`），
  再各自 `rename` 到同一个目标名（`investigation-store.js:21`）。谁最后 `rename` 谁算数，落盘内容是某一次完整写入
  （实测见清单 C3 的 D、E 两行）。
- 不同的「告警 + 模式」并发写：文件名不同，互不影响。
- 读与写并发：读者要么看到旧内容要么看到新内容，不会看到半截（R-RECORD-03）。

**幂等**：`latest()` 幂等。`save()` 不是严格幂等——同一个 `result` 保存两次，第二次会覆盖第一次，
且 `saved_at` 会更新（`investigation-store.js:16`）。

**排队与背压**：本模块没有队列，没有容量上限，也没有限流。并发压力由调用方自己控制
（自动研判监控器的并发度是 `server.js:43` 的 `concurrency`，本模块不参与决定）。

## 7 失败面

| 失败模式 | 表现（抛什么 / 返回什么） | 失败之后的状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| `alert_id` 为空或 `mode` 非法 | 抛 `Error('研判记录缺少告警 ID 或模式')`（`investigation-store.js:15`） | 没写出任何文件 | 修正入参后可重试 | 无 |
| 目录或文件权限不足 | 抛带 `code` 的错误（如 `EACCES`，实测见清单 C4） | 目标文件保持原内容 | 修好权限后可重试 | 无 |
| 临时文件已存在（同 UUID） | 抛 `EEXIST`（`flag: 'wx'` 的语义，实测见清单 C5） | 原文件未被覆盖 | 可重试（换一个 UUID） | 无 |
| `rename` 失败 | 抛错 | 临时文件已写出且**没有清理语句**（`investigation-store.js:20-21` 之间没有 `try/finally`），目标文件保持旧内容 | 可重试 | 无 |
| 记录文件不存在 | `latest()` 返回 `null`（`investigation-store.js:28`） | — | — | 由调用方决定；HTTP 层回 404（`server.js:333`） |
| 记录文件不是合法 JSON | 抛 `SyntaxError`（实测见清单 C3 的 B 行） | — | 不可重试，要人工修文件 | 无 |
| 记录内容身份与请求不符 | 抛 `Error('研判记录身份不匹配')`（`investigation-store.js:29`） | — | 不可重试，要人工修文件 | 无 |

从 HTTP 入口触发时还有一层映射要留意：路由把「告警 ID 无效 / 研判模式无效」判成 400，其余错误判成 502
（`server.js:324`）。本模块 `save()` 抛出的文案是「研判记录缺少告警 ID 或模式」，与那个正则不匹配，
所以经 HTTP 入口触发时落到 502 那一支。

## 8 资源与余量

| 项 | 数值 | 来源 |
| --- | --- | --- |
| 单条记录大小 | 结论 JSON 的字节数加上 `saved_at`（约 30 字节）；代码里没有大小上限 | 推断，依据 `investigation-store.js:16`、`investigation-store.js:20` |
| 目录里的文件数 | 每个「告警 × 模式」一份文件；没有硬上限 | 推断，依据 `investigation-store.js:9-12` |
| 单次 `save()` 的文件系统动作 | 1 次 `mkdir`（幂等）+ 1 次 `writeFile` + 1 次 `rename` | `investigation-store.js:19-21` |
| 单次 `latest()` 的文件系统动作 | 1 次 `readFile` | `investigation-store.js:27` |
| 单次调用延迟 | 未测量 | — |
| 权限 | 目录 0700（仅在目录被创建时）、文件 0600 | `investigation-store.js:19-20`，实测见清单 C1 |

没有边界可超，所以也没有「拒绝」这回事：磁盘写满时 `writeFile` 抛错，错误从 `save()` 抛出
（推断，依据 `investigation-store.js:20`）。

## 9 约束与理由

**假设**

- 一个「告警 + 模式」唯一对应一份记录——文件名只由这两个值决定（`investigation-store.js:9-12`）
- 临时文件与目标文件同目录、同文件系统，`rename` 是原子替换（`investigation-store.js:18`、`investigation-store.js:21`）
- 本机时钟可信——`saved_at` 取自 `new Date()`（`investigation-store.js:16`）

**限制**

- 不能删记录，也不能按条件查——只能按键取一份
- 不提供版本号与历史，写入即覆盖
- 不协调并发写，同键并发是「谁最后 `rename` 算数」
- 不校验 `alert_id` 格式，也不校验结论内容

**取舍（只写代码里留了痕迹的）**

- 文件名用散列而不是外部告警 ID 原文：注释写明「文件名不直接使用外部告警 ID」（`investigation-store.js:5`）。
  「为什么不用可读文件名」——代码与注释里没有记录，本页不替它编。
- 先写临时文件再 `rename`：写法见 `investigation-store.js:20-21`，效果是读者不会读到半截 JSON。
  「为什么不直接写最终文件名」——仓内没有记录。
- 散列输入把 `mode` 放在 `alert_id` 前面（`investigation-store.js:10`）：效果是同一告警的两种模式得到不同文件名。

**已知坑**

1. 目录权限只在目录被创建时生效；目录已存在时 `mkdir` 不改权限（实测见清单 C3 的 C 行）。
2. `save()` 的错误文案与 HTTP 路由判 400 的正则对不上（`investigation-store.js:15` 对 `server.js:324`）。
3. 进程在写临时文件与 `rename` 之间挂掉，目录里会留下 `.tmp` 残留；本模块没有清理语句。

**历史**：实现文件在仓内只有一次提交——`a16e0d5`「Extract HIDS AI console backend from the SME lab snapshot.」
（`git log -- investigation-store.js`）。仓内没有更早的修改记录，所以「曾经出过什么故障」在本仓无从查证。

## 10 怎么验证

清单 [evidence/recon/P001-T014.md](../../evidence/recon/P001-T014.md) 第三节列了 6 组可复跑命令与实跑输出
（C1 散列与权限、C2 覆盖与入参校验、C3 身份不符与并发写、C4 权限错误、C5 `wx` 语义、C6 仓内历史）。
最常用的一条，输出见清单 C1：

```bash
node --input-type=module -e "
import { InvestigationStore } from './investigation-store.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
const dir = await mkdtemp(path.join(os.tmpdir(), 'rec-'));
const store = new InvestigationStore(path.join(dir, 'investigations'));
await store.save({ alert_id: 'revshell:7', mode: 'deep', verdict: 'real_threat' });
console.log('目录内容:', await readdir(path.join(dir,'investigations')));
console.log('期望摘要:', createHash('sha256').update('deep:revshell:7').digest('hex'));
console.log('文件权限:', (await stat(store.file('revshell:7','deep'))).mode.toString(8));
"
```

## 11 未决

1. **保留期与清理责任**：代码里没有删除接口，也没有相关配置项；记录留多久、谁来清，仓内查不到。
2. **历史故障**：实现文件在仓内只有一次提交，没有更早的修改记录，「曾经怎么坏过」无从查证。
3. **单条记录的大小上界**：结论对象的大小由上游（研判智能体与证据视图）决定，本模块没有约束，也没有实测数据。
4. **为什么不用别的存储方案**（数据库、直接写最终文件名、可读文件名）：代码与注释里没有留下理由，本页不推断。

## 相关页面

- [架构篇](../architecture.md)：第 8 节「状态落盘」、第 12 节「模块清单」
- [模块拆分清单](_breakdown.json)：`record-store` 条目
- [侦察清单 P001-T014](../../evidence/recon/P001-T014.md)：本页每条断言的源码原文与验证命令
