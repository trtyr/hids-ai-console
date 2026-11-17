---
type: module
id: MOD-TRIAGE-RULES
covers: [triage-rules.js]
updated: 2026-11-17
---

# 误报规则集（triage-rules）

一句话：**一份 JSON 规则集的校验器、评估器与保存器**。规则命中只产出结论，不产出动作。

阅读约定：

- 本页的代码级断言只引一个文件——`triage-rules.js`（模块清单里本模块的实现文件只有它）。
  行号对应提交 `35530d8`；代码改了要重新核行号。
- 凡是推断出来的，句子里写「推断」；凡是查不到的，进第 12 节的「缺口与未决」表。
- 页里出现的其它路径只有两类：文档链接，和本模块自己读写的运行时文件。

## 1 模块名

| 项 | 值 |
| --- | --- |
| 模块名 | `triage-rules` |
| 页面 | `docs/modules/triage-rules.md` |
| 实现文件 | `triage-rules.js`（`wc -l triage-rules.js` 实测 307 行） |
| 覆盖构件 | 规则集校验、字段取值映射、规则评估、乐观并发保存 |

模块名与这四个构件名来自模块清单 [../modules/_breakdown.json](../modules/_breakdown.json)
的 `name` 与 `components` 字段。本页第 5 节按这四个构件逐个点名展开。

## 2 职责

**做什么**

- 校验一份 JSON 规则集：顶层结构、每条规则的元数据、每条条件；不合法就抛错（triage-rules.js:72-138）。
- 把事件详情里的字段按事件类型映射成规则条件可比较的值，并附上 JSON Pointer 路径（triage-rules.js:140-186）。
- 在事件身份核对通过后评估规则，产出「候选 / 已观察 / 未命中」这类结论（triage-rules.js:258-306）。
- 按「期望版本号」保存规则集：写盘前校验，写盘时先写临时文件再原子替换（triage-rules.js:240-256）。

**不做什么**

- 不下处置动作。`evaluate` 全程只读文件与事件详情，返回体里没有写动作的分支（triage-rules.js:258-306）。
- 不做告警匹配。syslog 与牧云事件的对应关系由调用方传进来，本模块只负责核对（triage-rules.js:188-211、275）。
- 不调用牧云。事件详情靠调用方给的 `toolbox.callTool` 取，本模块只拼工具名与参数（triage-rules.js:277-280）。
- 不持久化规则以外的东西。写盘只写规则集那一个文件（triage-rules.js:248-251）。

## 3 公开面

| 能力 | 入口 | 正常返回 | 失败形式 |
| --- | --- | --- | --- |
| 校验规则集 | `validateRuleSet(config)`（triage-rules.js:126） | 原样返回入参（triage-rules.js:137） | 抛 `Error`，消息见第 5.1 节 |
| 读当前规则集 | `TriageRuleEngine#readConfig()`（triage-rules.js:223） | `{ config, origin, revision }`（triage-rules.js:232、235-236） | 示例文件也非法时抛错（triage-rules.js:234） |
| 保存规则集 | `TriageRuleEngine#saveConfig(config, expectedRevision)`（triage-rules.js:240） | `{ config, origin: 'file', revision }`（triage-rules.js:252） | 抛 `Error`；版本不符时 `error.status = 409`（triage-rules.js:245） |
| 评估一条告警 | `TriageRuleEngine#evaluate({ alertId, parsed, toolbox, match })`（triage-rules.js:258） | `{ status, revision, ... }`（triage-rules.js:262-305） | 不抛错，失败以 `status: 'error'` 之类返回（triage-rules.js:263、267、277、280） |

`evaluate` 的 `status` 取值只有这七个：`disabled`、`error`、`no_candidate`、
`identity_unverified`、`candidate`、`observed`、`no_match`（triage-rules.js:262-305）。
`readConfig` 的 `origin` 取值只有这三个：`file`、`example`、`invalid`（triage-rules.js:224-236）。

## 4 关键路径

本模块有三条关键路径。按这三条读，文件里的分支就不会漏。

**路径一：读——`readConfig`**

1. 读规则集文件（triage-rules.js:225）。
2. 文件不存在（`ENOENT`）就读同目录的示例文件 `triage-rules.example.json`，
   `origin` 记 `example`、`revision` 记 `null`（triage-rules.js:7、226-231）。
3. 解析并校验。文件存在但内容非法时，回落到示例配置，`origin` 记 `invalid`，
   同时带上**原文件**的 `revision` 与错误消息（triage-rules.js:232-237）。
4. 返回 `{ config, origin, revision }`（triage-rules.js:232、235-236）。

**路径二：判——`evaluate`**

1. 读文件：文件不存在 → `status: 'disabled'`（triage-rules.js:260-262）；其它读错误 → `status: 'error'`（triage-rules.js:263）。
2. 解析并校验：失败 → `status: 'error'`，消息前缀「规则集校验失败：」（triage-rules.js:266-267）。
3. 规则集未启用 → `status: 'disabled'`（triage-rules.js:269）。
4. 从 `alertId` 拆出事件类型与事件号，挑出「启用中、类型对、在有效期内」的候选规则；
   没有候选 → `status: 'no_candidate'`（triage-rules.js:270-273）。
5. 核对身份：事件号必须是正整数；调用方若传了 `parsed`，还要求 syslog 事件号、
   `match.matched`、`match.event_id` 三者对上，否则 `status: 'identity_unverified'`（triage-rules.js:274-276）。
6. 取事件详情：没有工具箱 → `status: 'error'`；读取抛错 → `status: 'error'`（triage-rules.js:277-280）。
7. 边界检查：详情里的事件号要对上、要有主机 ID 与主机 IP、风险级别 ∈ {1,2,3,4}、
   `state` 必须是 1、syslog 与详情的字段要一致；任一不满足 → `status: 'identity_unverified'`（triage-rules.js:281-287）。
8. 逐条规则匹配：先比 `host_id`，不同就跳过这条规则（triage-rules.js:290）；
   再逐条比这条规则的条件，任一条不满足就跳过这条规则（triage-rules.js:291-292）。
9. 出结论：动作是 `observe` → `status: 'observed'`；其它动作 → `status: 'candidate'`；
   一条都没命中 → `status: 'no_match'`（triage-rules.js:293、302-305）。

**路径三：存——`saveConfig`**

1. 排队。同一实例上的保存请求串行执行，前一个失败不挡下一个（triage-rules.js:241、254-255）。
2. 校验入参规则集，不合法直接抛错（triage-rules.js:242）。
3. 读当前规则集，比对 `expectedRevision` 与当前 `revision`；不一致 → 抛错，
   `error.status = 409`，消息「规则配置已变化，请刷新后重试」（triage-rules.js:243-246）。
4. 落盘：建目录（权限 `0o700`）→ 写临时文件 `<规则集路径>.<uuid>.tmp`（权限 `0o600`、`wx` 不覆盖）
   → `rename` 替换（triage-rules.js:248-251）。
5. 返回 `{ config, origin: 'file', revision }`；`revision` 是新内容的 SHA-256 前 16 位（triage-rules.js:252）。

## 5 覆盖构件

四个构件对应模块清单里的四个 `components` 名。本节逐个点名。

### 5.1 规则集校验

代码位置：`validateRuleSet`（triage-rules.js:126-138，导出）调用 `validateRule`（triage-rules.js:72-124）。
两层校验：规则集层查整体形状，单条规则层查元数据与条件。任一层不通过就抛 `Error`，
消息里带规则 ID（triage-rules.js:84-123），规则集层的问题消息固定为「规则集格式无效」（triage-rules.js:130）。

**规则集层**

| 约束 | 依据 |
| --- | --- |
| 必须是对象；`schema_version` 必须是 `1`；`enabled` 必须是布尔；`rules` 必须是数组 | triage-rules.js:127 |
| `rules` 条数不超过 200（是上界，不是下界——空数组合法） | triage-rules.js:128 |
| 顶层只接受 `schema_version`、`enabled`、`rules` 三个键 | triage-rules.js:129 |
| 同一份规则集里规则 ID 不重复，重复则报「规则 ID 重复：<id>」 | triage-rules.js:131-135 |

**规则元数据层**（每条规则都要过）

| 字段 | 约束 | 依据 |
| --- | --- | --- |
| `id` | 匹配 `^[A-Za-z0-9_-]{3,64}$` | triage-rules.js:73 |
| `event_type` | 必须是 11 类事件之一（`fields` 表的键） | triage-rules.js:9-21、74 |
| `action` | 只能是 `observe`、`review_false_positive`、`classify_false_positive` | triage-rules.js:35、74 |
| `enabled` | 布尔 | triage-rules.js:75 |
| `host_id` | 安全整数且不小于 1 | triage-rules.js:75 |
| `reason`、`approved_by` | 去空白后非空 | triage-rules.js:59、76 |
| `source_alert_id` | 动作为 `review_false_positive` 时必填；非空时必须形如 `<event_type>:<正整数>` | triage-rules.js:77-79 |
| `valid_from`、`expires_at` | 必须匹配 `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$` 且 `Date.parse` 得有限值；`valid_from` 必须早于 `expires_at` | triage-rules.js:61-62、80-81 |
| `conditions` | 必须是数组 | triage-rules.js:81 |
| 未知键 | 元数据与条件都不接受表以外的键 | triage-rules.js:82-83、91-92 |

**条件层**

| 约束 | 依据 |
| --- | --- |
| `field` 必须属于该事件类型的可用字段，且同一规则内不重复 | triage-rules.js:9-21、89-90 |
| 条件条数落在「场景必需字段数」与「该事件类型可用字段数」之间 | triage-rules.js:22-34、85-86 |
| `operator: 'equals'` 且字段是 IP 类：值必须是合法 IP，且不能是 `0.0.0.0` 或 `::` | triage-rules.js:47、95 |
| `operator: 'equals'` 且字段是数值类（`success_count`、`failure_count`、`abnormal_type`、`origin_uid`、`target_uid`）：值必须是不小于 0 的整数；其中 `abnormal_type` 只收 1、2、3 | triage-rules.js:36、96-98 |
| `operator: 'equals'` 且字段是其余类型：值必须是非空字符串，且长度不超过 512 | triage-rules.js:59、99 |
| `operator: 'cidr'`：只允许用在 `source_ip` 上；必须是 IPv4 加前缀长度，前缀长度在 24 到 32 之间 | triage-rules.js:101-104 |
| `operator: 'lte'`：只允许用在 `failure_count` 上；取值在 1 到 200 之间 | triage-rules.js:105-107 |
| 其它 `operator`，或用在字段上的 `operator` 与上面不匹配 | triage-rules.js:108 |
| `sha256` 字段的值必须是 64 位十六进制 | triage-rules.js:109-110 |
| 场景必需字段要逐个出现在条件里，缺一个就报错 | triage-rules.js:22-34、112 |

**场景级附加约束**（三条，比通用校验更严）

| 事件类型 | 附加要求 | 依据 |
| --- | --- | --- |
| `network_audit` | `network_type` 必须是 `equals` 且值为 `ip` | triage-rules.js:114-116 |
| `brute_force` | `success_count` 必须是 `equals` 且值为 0，`failure_count` 必须用 `lte` | triage-rules.js:117-120 |
| `suspicious_operation` | `connection_type` 必须是 `equals` 且值为 `ssh` | triage-rules.js:121-123 |

### 5.2 字段取值映射

代码位置：`fact(eventType, detail, field)`（triage-rules.js:140-186）。
它把「事件详情 + 规则里写的字段名」翻译成三样东西：可比较的 `value`、详情里的原始值 `evidence_value`、
以及该原始值在详情里的 JSON Pointer 路径 `pointer`（triage-rules.js:141-152）。

取值按固定顺序找：**特例 → 直取表 → 场景映射表 → 兜底**。

**第一步：特例。** `destination_ip` 在 `abnormal_login`、`brute_force`、`suspicious_operation`
这三类事件上取的不是对端地址，而是被测主机的 IP（先 `host_view.host_ip`，再 `host_ip`），
指针相应指向 `/host_view/host_ip` 或 `/host_ip`（triage-rules.js:141-147）。

**第二步：直取表 `directFields`**（triage-rules.js:37-46）。8 类事件的字段名与详情字段名不同名，
需要一张对照表：

| 事件类型 | 规则字段 → 详情字段 |
| --- | --- |
| `webshell` | `file_path` → `path`；`sha256` → `sha256`；`detection_reference` → `detect_reason` |
| `malware` | `file_path` → `path`；`sha256` → `sha256`；`detection_reference` → `detect_reason` |
| `revshell` | `source_ip` → `local_addr`；`destination_ip` → `remote_addr`；`shell_command` → `shell_cmdline`；`process_path` → `process_path` |
| `memory_webshell` | `server_name` → `server_name`；`class_name` → `class_name`；`sha256` → `sha256`；`detection_reference` → `detect_reason` |
| `elevation_process` | `process_path` → `exepath`；`command_line` → `cmdline`；`origin_uid` → `origin_uid`；`target_uid` → `target_uid`；`privilege_escalation_type` → `privilege_escalation_type` |
| `suspicious_operation` | `source_ip` → `ssh_client_ip`；`connection_type` → `type`；`rule_name` → `rule_name`；`process_path` → `path`；`command_line` → `cmdline`；`user_name` → `uname`；`session_id` → `session_id` |
| `honeypot` | `source_ip` → `source_ip`；`honeypot_address` → `address`；`honeypot_type` → `type` |
| `memory_security` | `plugin_id` → `plugin_id`；`strategy_id` → `strategy_id`；`origin_method` → `origin_method`；`detection_reference` → `detect_reason` |

**第三步：场景映射表。** 两类事件没有直取表，映射写在函数体内：

| 事件类型 | 规则字段 → 详情字段 |
| --- | --- |
| `network_audit`（triage-rules.js:154-159） | `source_ip` → `local_addr`；`destination_ip` → `target`；`network_type` → `type`；`process_path` → `process_path`；`command_line` → `cmdline`；`detection_reference` → `reference`；`user_name` → `uname` |
| `abnormal_login`（triage-rules.js:161-166） | `source_ip` → `login_ip`；`user_name` → `login_username`；`auth_type` → `auth_type`；`rule_subject` → `rule_subject`；`abnormal_type` → `login_abnormal_type` |

**第四步：兜底。** 剩下的字段按事件类型分三种情况：

- `source_ip` 与 `user_name` 从时间轴数组取（先 `detail.time_aix`，再 `detail.time_axis`）。
  只有数组里的每一行都取得到值、且去重后只剩一个值时，`value` 才是那个值；
  否则 `value` 为 `null`（不参与匹配），指针指向数组首行对应字段
  （triage-rules.js:168-181）。
- 其余字段直接取同名字段：`auth_service` → `auth_service`、
  `success_count` → `success_count`、`failure_count` → `failure_count`（triage-rules.js:182-185）。

**取值变换与指针形式**

| 变换 | 行为 | 依据 |
| --- | --- | --- |
| `ipValue` | 去空白、去掉结尾的 `/32`、剥掉 `IPv4:端口` 与 `[IPv6]:端口`；不是字符串返回 `null` | triage-rules.js:48-56 |
| `integer` | 数字直接取；纯数字字符串转成数字；其它返回 `null` | triage-rules.js:57-58 |
| `text` | 字符串去空白；不是字符串返回空串 | triage-rules.js:59 |
| 指针 | 形如 `/local_addr`、`/host_view/host_ip`、`/time_aix/0/source_ip` | triage-rules.js:144、152、173 |

### 5.3 规则评估

代码位置：`TriageRuleEngine#evaluate`（triage-rules.js:258-306），
配套两个内部函数：`sameSyslogFacts`（triage-rules.js:188-211）、
`conditionMatches`（triage-rules.js:213-218）。路径二的九步讲的是流程，这里讲判定口径。

**候选规则怎么挑**（triage-rules.js:271-272）：同时满足四个条件才进候选——
规则自身 `enabled` 为真、`event_type` 与 `alertId` 拆出的类型一致、
`valid_from` 不晚于当前时刻、当前时刻早于 `expires_at`。
换句话说，**过期规则与停用规则不参与匹配**；一条候选都没有时返回 `no_candidate`（triage-rules.js:273）。

**身份核对**（triage-rules.js:274-276）：`alertId` 形如 `<事件类型>:<数字>`，
拆出来的数字必须是正整数。调用方若传了 `parsed`（即这条告警来自 syslog），
还要求三件事同时成立：syslog 载荷里的 `event_id` 等于这个数字、`match.matched` 为 `true`、
`match.event_id` 等于这个数字。任一不成立 → `identity_unverified`。
没传 `parsed` 时这一步只查事件号本身（triage-rules.js:275）。

**事件边界**（triage-rules.js:281-287）：详情取回来后要同时满足——
详情的 `id`（缺失时取 `event_id`）等于目标事件号、主机 ID 存在、主机 IP 存在、
风险级别 `level` ∈ {1, 2, 3, 4}、`state` 等于 1、syslog 与详情字段一致。
任一不满足 → `identity_unverified`，理由是「事件身份、字段或风险状态不满足自动判定边界」。

**syslog 与详情的一致性**（triage-rules.js:188-211）：没传 `parsed` 时直接算通过（triage-rules.js:189）。
传了 `parsed` 时分两类：

- `network_audit`、`abnormal_login`、`brute_force` 三类：除事件号、主机 ID、主机 IP 之外，
  还要核对来源 IP（syslog 载荷里的 `local_addr` / `login_ip` / `source_ip` 与详情算出的来源必须一致且非空），
  以及各场景自己的字段——网络异常比 `abnormal_reference`、`process_path`、`process_command_line`；
  异常登录比 `user_name`、`auth_type`；暴力破解比 `success_count`、`failure_count`（triage-rules.js:197-210）。
- 其它事件类型：只比事件号、主机 ID、主机 IP；其中 `suspicious_operation` 另比
  `process_command_line` 与 `user_name`（syslog 载荷里没有该字段时跳过该项比对）（triage-rules.js:191-196）。

**条件怎么比**（triage-rules.js:213-218）：取值是 `null`、`undefined` 或空串时判为不匹配；
`cidr` 走网段比较（只认 IPv4，triage-rules.js:64-70）；`lte` 比大小；
其余按类型比——数值用 `Number` 相等比较，字符串严格相等（triage-rules.js:213-218）。

**结论怎么出**（triage-rules.js:289-305）：按候选规则的顺序逐条试。
先比 `rule.host_id` 与事件主机 ID，不同就跳过（triage-rules.js:290）；
再逐条比这条规则的条件，任一条不满足就跳过这条规则（triage-rules.js:291-292）。
命中后按动作分两种结果：

| 动作 | 结果 | 行为 |
| --- | --- | --- |
| `observe` | `status: 'observed'` | 记下结论，继续找下一条规则（triage-rules.js:293、303） |
| `review_false_positive`、`classify_false_positive` | `status: 'candidate'` | **立刻返回**这条结论，不再看后面的规则（triage-rules.js:302） |

一轮下来没有命中任何规则 → `status: 'no_match'`（triage-rules.js:305）。

**结论体的字段**（triage-rules.js:293-301）

| 字段 | 内容 | 依据 |
| --- | --- | --- |
| `status` | `observed` 或 `candidate` | triage-rules.js:293 |
| `revision` | 本次读到的规则集内容哈希前 16 位 | triage-rules.js:268、293 |
| `rule` | 命中的规则摘要：`id`、`event_type`、`action`、`reason`、`source_alert_id`、`approved_by`、`expires_at` | triage-rules.js:294-296 |
| `facts` | 主机 ID 一条；命中的条件各出一条，每条带 `field`、原始值 `value`、指针 `pointer` | triage-rules.js:297-300 |
| `evidence_sha256` | 事件详情整个 JSON 的 SHA-256 十六进制摘要 | triage-rules.js:301 |

### 5.4 乐观并发保存

代码位置：`TriageRuleEngine#saveConfig(config, expectedRevision)`（triage-rules.js:240-256）。

**并发控制怎么做的**：保存前先读一遍当前规则集，拿它的 `revision` 与调用方传的
`expectedRevision` 比；不相等就抛错并把 `error.status` 置为 409（triage-rules.js:243-246）。
本模块不自己合并版本、不留冲突记录——冲突了就是让调用方重新读一遍再改。

**`revision` 是什么**：规则集文件**文本内容**的 SHA-256 十六进制摘要的前 16 位
（triage-rules.js:231、252、268）。注意是文件文本，不是解析后的对象：
同一份配置写成不同缩进，revision 就不同（triage-rules.js:247 固定用两空格缩进加末尾换行写出）。

**`expectedRevision` 该传什么**：必须是**当前**文件的 `revision`。
两个容易踩的边界：

- 文件还不存在时，`readConfig` 会回落到示例文件，`revision` 是 `null`（triage-rules.js:231）。
  所以**首次创建要传 `null`**；传 `undefined` 会因为 `null !== undefined` 撞上 409
  （实测见第 11 节命令三）。
- 文件存在但内容非法时，`readConfig` 仍会返回**原文件**的 `revision`，只是 `origin` 记成 `invalid`
  （triage-rules.js:235-236）。拿着这个 `revision` 调 `saveConfig` 能正常覆盖掉坏文件
  （实测见第 11 节命令四）。

**写入动作**（triage-rules.js:247-252）

| 步骤 | 动作 | 依据 |
| --- | --- | --- |
| 排队 | 挂在实例的 `pending` 链上串行执行；前一个任务失败不挡下一个（`this.pending = job.catch(() => {})`） | triage-rules.js:241、254-255 |
| 校验 | 先 `validateRuleSet(config)`，不合法直接抛错，不写盘 | triage-rules.js:242 |
| 建目录 | `mkdir(..., { recursive: true, mode: 0o700 })` | triage-rules.js:248 |
| 写临时文件 | 文件名 `<规则集路径>.<uuid>.tmp`，`mode: 0o600`、`flag: 'wx'`（同名文件已存在就报错，不覆盖） | triage-rules.js:249-250 |
| 替换 | `rename` 把临时文件改成正式文件名 | triage-rules.js:251 |
| 返回 | `{ config, origin: 'file', revision }` | triage-rules.js:252 |

**失败时系统状态**：校验失败（242）与版本不符（244-246）都发生在写盘之前，规则集内容不变；
写临时文件失败（250）时正式文件仍是旧的，临时文件可能留下一个同名冲突文件。

## 6 依赖

| 方向 | 内容 | 依据 |
| --- | --- | --- |
| 上游 | 装配层：业务 HTTP 层与自动研判流水线把告警、工具箱传进来。接入点见 [架构篇](../architecture.md) 第 5.2 节「规则预筛」、第 9.2 节「管理员令牌」、第 12 节模块清单里的 `triage-rules` 行（文档指针，不在本页的证据范围内） | — |
| 下游 | 本模块不 import 仓内其它实现文件。顶部 5 条 import 都是 Node 标准库：`node:crypto`、`node:fs/promises`、`node:net`、`node:path`、`node:url` | triage-rules.js:1-5 |
| 外部 | 牧云事件详情——靠调用方给的 `toolbox.callTool` 取，工具名由本模块拼成 `get_<事件类型>_event` | triage-rules.js:277-280 |
| 外部 | 文件系统——规则集文件，以及同目录下的示例文件 `triage-rules.example.json` | triage-rules.js:7、225、228、248-251 |

## 7 数据

**规则集文件**。路径由构造参数 `filename` 决定（triage-rules.js:221），本模块不改它。
内容是 JSON，顶层只有 `schema_version`、`enabled`、`rules` 三个键（triage-rules.js:129）。
写盘格式固定为两空格缩进加末尾一个换行（triage-rules.js:247）。
目录权限 `0o700`、文件权限 `0o600`（triage-rules.js:248、250）。

**示例文件**。模块自带一份示例规则集 `triage-rules.example.json`，路径写死为「与本模块同一个目录」
（triage-rules.js:7）。本模块读文件只有三处：规则集文件（triage-rules.js:225）
与示例文件（triage-rules.js:228、235）。

**读到的三种来源**（`origin`）

| `origin` | 什么时候 | `revision` | 依据 |
| --- | --- | --- | --- |
| `file` | 规则集文件读到了，且内容合法 | 文件内容的哈希前 16 位 | triage-rules.js:231-232 |
| `example` | 规则集文件不存在（`ENOENT`），回落到示例文件 | `null` | triage-rules.js:226-231 |
| `invalid` | 规则集文件存在但内容非法，仍回落到示例配置 | **原文件**的哈希前 16 位，另有 `error` 字段带错误消息 | triage-rules.js:233-237 |

## 8 不变量

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-TR-01` | 写进文件的规则集一定通过 `validateRuleSet` | 文件里出现 `schema_version: 2` | triage-rules.js:242 | 下次读到这份配置时整体报 `status: 'error'`，规则一条都用不上 |
| `R-TR-02` | 一份规则集里规则 ID 不重复 | 两条同 `id` 的规则 | triage-rules.js:131-135 | 加载即抛「规则 ID 重复」，整份配置不可用 |
| `R-TR-03` | 只有身份核对通过的事件才进规则匹配 | syslog 事件号与牧云详情对不上仍给出结论 | triage-rules.js:275-276、285-287 | 把一条告警的规则结论写到另一条告警上 |
| `R-TR-04` | 只有 `host_id` 与事件主机一致的规则参与匹配 | 规则 `host_id` 是 9、事件主机是 7 | triage-rules.js:290 | 规则串到别的机器上 |
| `R-TR-05` | 一条规则的条件要逐条命中才算命中 | 三个条件只中两个 | triage-rules.js:292 | 误报候选泛滥，AI 复核成本上升 |
| `R-TR-06` | 保存只在当前 `revision` 等于 `expectedRevision` 时发生 | 两个写者拿同一个旧版本号先后保存 | triage-rules.js:243-246 | 后写的覆盖先写的，后写者看不到自己覆盖了谁 |
| `R-TR-07` | 评估不产生处置动作 | `evaluate` 返回体里多出隔离、封禁一类动作字段 | triage-rules.js:258-306 | 越权处置——本仓只产出建议 |

## 9 失败面

`evaluate` 的失败用返回体里的 `status` 表达，不抛错（triage-rules.js:258-306）；
`saveConfig` 与 `validateRuleSet` 的失败都以抛 `Error` 的形式表达（triage-rules.js:242、245）。

| 失败模式 | 表现 | 系统状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| 规则集文件不存在 | `status: 'disabled'`，理由「未配置规则集」 | 文件不动，其它研判照常 | 能（等文件出现） | 等同没有规则 |
| 规则集读失败（权限等非 `ENOENT` 错误） | `status: 'error'`，理由「规则集读取失败：…」 | 文件不动 | 能 | 规则不生效 |
| 规则集内容非法 | `evaluate` 给 `status: 'error'`，理由前缀「规则集校验失败：」；`readConfig` 给 `origin: 'invalid'` 与 `error` 字段，配置回落成示例 | 文件不动 | 能（改文件） | 规则不生效 |
| 规则集未启用 | `status: 'disabled'`，理由「规则集未启用」 | 文件不动 | 能 | 规则不生效 |
| 没有候选规则（类型不匹配 / 全过期 / 全停用） | `status: 'no_candidate'` | 文件不动 | — | 无候选可给 |
| syslog 与牧云事件对不上 | `status: 'identity_unverified'`，理由「syslog 与牧云事件 ID 未精确关联」 | 文件不动 | 能 | 不给结论 |
| 详情字段或风险状态不满足边界 | `status: 'identity_unverified'`，理由「事件身份、字段或风险状态不满足自动判定边界」 | 文件不动 | 能 | 不给结论 |
| 工具箱不可用 | `status: 'error'`，理由「牧云详情接口不可用」 | 文件不动 | 能 | 不给结论 |
| 事件详情读取抛错 | `status: 'error'`，理由「牧云事件详情读取失败：…」 | 文件不动 | 能 | 不给结论 |
| 保存：规则集不合法 | 抛 `Error`，消息来自校验层 | 文件不动（校验在写盘前） | 能（改配置） | 保存不发生 |
| 保存：版本号对不上 | 抛 `Error`，`error.status = 409`，消息「规则配置已变化，请刷新后重试」 | 文件不动 | 能（重新读再改） | 保存不发生 |
| 保存：临时文件已存在 | `writeFile` 因 `wx` 抛错 | 正式文件仍是旧的 | 能 | 保存不发生 |

## 10 资源与限额

| 项 | 数值 | 依据 |
| --- | --- | --- |
| 一个规则集的规则条数上限 | 200 | triage-rules.js:128 |
| 一条规则的条件条数 | 下限是该事件类型的必需字段数（3 到 7 条），上限是该事件类型的可用字段数（3 到 8 条） | triage-rules.js:9-34、85-86 |
| `equals` 条件的字符串值长度上限 | 512 | triage-rules.js:99 |
| `cidr` 的前缀长度范围 | 24 到 32（IPv4） | triage-rules.js:103 |
| `lte` 的 `failure_count` 取值范围 | 1 到 200 | triage-rules.js:106 |
| 规则 ID 长度 | 3 到 64 | triage-rules.js:73 |
| 一次评估的文件读次数 | 1（规则集文件） | triage-rules.js:260 |
| 一次保存的文件操作 | 读 1 次当前配置、建目录、写临时文件、rename | triage-rules.js:243、248-251 |

规则集文件本身的大小没有代码级上限——**推断**：实际约束来自上表的条数与长度上限相乘，
但这不是代码里的限制，别当成承诺写进测试。

## 11 值语义与怎么验

### 11.1 值语义

| 值 | 出现在 | 类型与格式 | 空值与异常含义 |
| --- | --- | --- | --- |
| `revision` | `readConfig` / `saveConfig` / `evaluate` 的返回体 | 16 位十六进制字符串：规则集文件**文本**的 SHA-256 摘要前 16 位（triage-rules.js:231、252、268） | 文件不存在、回落到示例时是 `null`（triage-rules.js:231） |
| `expectedRevision` | `saveConfig` 入参 | 必须是当前 `revision` 的同一个值（triage-rules.js:244） | 与当前值不相等 → 409（triage-rules.js:245） |
| `alertId` | `evaluate` 入参 | `<事件类型>:<数字>`（triage-rules.js:270） | 数字部分不是正整数 → `identity_unverified`（triage-rules.js:275-276） |
| `parsed` | `evaluate` 入参 | syslog 解析结果，用到 `payload.event_id`（triage-rules.js:275、190） | 不传则跳过 syslog 字段核对（triage-rules.js:189、275）；传了但 `payload` 缺失会被判身份不符 |
| `match` | `evaluate` 入参 | 用到 `matched` 与 `event_id`（triage-rules.js:275） | 传了 `parsed` 就必须传 `match`，否则 `identity_unverified` |
| `status` | `evaluate` 返回 | 七个取值，见第 3 节 | — |
| `origin` | `readConfig` 返回 | 三个取值，见第 7 节 | — |

### 11.2 怎么验（可复跑命令）

以下五条都在本仓根目录跑，临时文件都落在 `/tmp`，不写工作树。命令一验证规则集校验，
命令二验证「未配置规则集」，命令三、四验证乐观并发，命令五验证规则命中。

**命令一：规则集被拒**

```bash
node --input-type=module -e "
import { validateRuleSet } from './triage-rules.js';
try { validateRuleSet({ schema_version: 2, enabled: true, rules: [] }); }
catch (e) { console.log('schema_version=2 ->', e.message); }
"
```

```
schema_version=2 -> 规则集格式无效
```

**命令二：未配置规则集时评估返回 disabled**

```bash
node --input-type=module -e "
import { TriageRuleEngine } from './triage-rules.js';
const engine = new TriageRuleEngine('/tmp/triage-rules-absent-demo.json');
console.log(await engine.evaluate({ alertId: 'network_audit:1' }));
"
```

```
{ status: 'disabled', reason: '未配置规则集' }
```

**命令三：版本号对不上时保存被拒**

```bash
node --input-type=module -e "
import { TriageRuleEngine } from './triage-rules.js';
const engine = new TriageRuleEngine('/tmp/triage-rules-new-demo.json');
try { await engine.saveConfig({ schema_version: 1, enabled: false, rules: [] }, undefined); }
catch (e) { console.log('status=' + e.status, e.message); }
"
```

```
status=409 规则配置已变化，请刷新后重试
```

这条不会留下文件——建目录的动作排在版本检查之后（triage-rules.js:244-248）。

**命令四：坏文件也能被带 revision 覆盖**

```bash
node --input-type=module -e "
import { TriageRuleEngine } from './triage-rules.js';
import { writeFile } from 'node:fs/promises';
const file = '/tmp/triage-rules-bad-demo.json';
await writeFile(file, '{ not json');
const engine = new TriageRuleEngine(file);
const cur = await engine.readConfig();
console.log('origin=' + cur.origin, 'revision=' + cur.revision);
await engine.saveConfig({ schema_version: 1, enabled: false, rules: [] }, cur.revision);
console.log('覆盖后 origin ->', (await engine.readConfig()).origin);
"
```

```
origin=invalid revision=0228f717792ffbc0
覆盖后 origin -> file
```

**命令五：一条规则命中时给出的结论**

```bash
node --input-type=module -e "
import { TriageRuleEngine } from './triage-rules.js';
import { writeFile } from 'node:fs/promises';
const iso = t => new Date(t).toISOString().slice(0, 19) + 'Z';
const rule = { id: 'demo-001', enabled: true, action: 'observe', event_type: 'honeypot', host_id: 7,
  reason: 'demo', approved_by: 'demo', valid_from: iso(Date.now() - 3600000), expires_at: iso(Date.now() + 3600000),
  conditions: [ { field: 'source_ip', operator: 'equals', value: '10.0.0.5' },
    { field: 'honeypot_address', operator: 'equals', value: '10.0.0.9' },
    { field: 'honeypot_type', operator: 'equals', value: 'ssh' } ] };
await writeFile('/tmp/triage-rules-demo.json', JSON.stringify({ schema_version: 1, enabled: true, rules: [rule] }));
const detail = { id: 123, host_id: 7, host_view: { host_id: 7, host_ip: '10.0.0.5' }, level: 2, state: 1,
  source_ip: '10.0.0.5', address: '10.0.0.9', type: 'ssh' };
const parsed = { payload: { event_id: 123, host_id: 7, host_ip: '10.0.0.5' } };
const engine = new TriageRuleEngine('/tmp/triage-rules-demo.json');
const r = await engine.evaluate({ alertId: 'honeypot:123', parsed,
  match: { matched: true, event_id: 123 }, toolbox: { callTool: async () => detail } });
console.log(r.status, JSON.stringify(r.facts));
"
```

```
observed [{"field":"host_id","value":7,"pointer":"/host_id"},{"field":"source_ip","value":"10.0.0.5","pointer":"/source_ip"},{"field":"honeypot_address","value":"10.0.0.9","pointer":"/address"},{"field":"honeypot_type","value":"ssh","pointer":"/type"}]
```

把 `parsed.payload.event_id` 改成 `999`，或把 `detail.state` 改成 `2`，同一条命令会返回
`identity_unverified`（triage-rules.js:275-276、285-287）。

## 12 缺口与未决

| 没查到的 | 为什么查不到 | 影响 |
| --- | --- | --- |
| 规则集文件在部署里的实际路径 | 路径由装配层传进构造函数，本模块只管传进来的 `filename`（triage-rules.js:221） | 本页不能给出文件位置；架构篇第 8.2 节记的是它当时的结论 |
| `time_aix` / `time_axis` 在牧云侧的真实形状 | 没有牧云凭据，本卡没发过外部请求 | 第 5.2 节里走时间轴的两条兜底分支只能按代码写，不能按实测写（triage-rules.js:168-181） |
| `fields` 表里 11 类事件名与牧云事件类型表是否一一对应 | 对照另一份真源超出本卡的证据源约束（本卡只引 `triage-rules.js`） | 第 5.1、5.2 节的字段表只保证与本模块内部一致 |
| 本模块的 L2 单元条目 | `docs/contexts/` 下还没有对应页面 | 公开面只能在本页里按 `triage-rules.js:行号` 描述，没有更细的单元页可链 |

全局缺口台账是 [../_meta/gaps.md](../_meta/gaps.md)。本卡的可写范围里没有那个文件，
上面四条没有登记进去，等下一棒补。

## 13 指针

- [架构篇](../architecture.md)：第 5.2 节「规则预筛」、第 8.2 节规则集文件位置、第 9.2 节规则写接口、第 12 节模块清单
- [模块清单](../modules/_breakdown.json)：本模块的 `name` / `doc` / `files` / `components`
- [已知边界](../_meta/gaps.md)：全局缺口台账
- [侦察与复现记录](../../evidence/recon/P001-T009.md)：本页第 11 节命令的原始跑法与输出
