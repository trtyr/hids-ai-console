---
id: AL-06b
title: 后渗透行为：全类最硬的证据
applies_to: [abnormal-login]
refs: []
status: deprecated
deprecated_reason: 原始出处与 SOP 重新核查后，由 AL-11 统一判定
superseded_by: AL-11
updated: 2026-11-03
source: 从 docs/knowledge/abnormal-login.md 迁移
used: 0              # 被 Agent 引用次数（tools/wiki_stats.py 自动统计）
failed: 0            # 判错过几次（人工标，>0 必须写清为什么）
evidence: [_evidence/mitre-attack.md]
---

> **历史判据：已退出自动研判。** 当前判断请读 [AL-11](AL-11.md)；以下保留原文供追溯，部分断言未经原文证实。

# AL-06b · 后渗透行为：全类最硬的证据

**登录之后，这台机器上出现了攻击行为。**

MITRE 的检测策略 **DET0269** 原文：

> "Behavioral Detection Strategy for Remote Service Logins and Post-Access Activity"
>
> **AN0750**："Logon via RDP or WMI by a user account followed by
> **uncommon command execution, file manipulation, or lateral network connections**."

**为什么它最硬**：**登录是不是正常，经常看不出来；登录之后做了什么，一看就知道。**

凌晨三点 root 登录可能正常，但**凌晨三点 root 登录完接着提权到 root、再跑一个反弹 shell**，
那不管几点都是攻击。

## 后渗透怎么判

**登录后 300 秒内，同一个 `host_ip` 上出现以下任一：**

| 事件类型 | MsgId | 说明 |
| --- | --- | --- |
| 本地提权 | `cloudwalker-elevation-process` | 登录后立刻提权 |
| 可疑命令 | `cloudwalker-suspicious-command` | 登录后跑可疑命令 |
| WebShell | `cloudwalker-webshell` | 登录后挂了后门 |
| 反弹 Shell | `cloudwalker-revshell` | 登录后连出去 |
| 恶意文件 | `cloudwalker-malware` | 登录后落地了恶意文件 |
| 网络异常 | `cloudwalker-abnormal-network` | 登录后有异常外连 |

**命中一条 → 真实威胁。** 不管来源可不可信、时段正不正常。

> **为什么是 300 秒**：后渗透动作紧跟着登录，不会等半小时。
> 窗口太长会把「几小时后运维自己跑的命令」也算进来 —— 那是别人的行为，不是这个登录的。

## ⚠️ 300 秒内没有任何攻击事件，**不等于**「确认没有后渗透」

这只说明「这一小段时间里没看到」。**攻击者可以等 10 分钟再动手**，
而我们的窗口只看 300 秒。

**所以「没看到后渗透」只能作为一个弱良性信号，不能拿它单独判误报。**
判误报要靠「来源可信 + 时段正常」或「来源可信 + 高频习惯」这类正面证据。
