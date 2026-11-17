---
id: EV-07
title: MITRE ATT&CK —— 攻击技术编号与检测策略
kind: 权威资料
source: <https://attack.mitre.org/>
supports: [AL-01, AL-06b, NA-02, NA-03, SC-06, GEN-07]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# MITRE ATT&CK —— 攻击技术编号与检测策略

| 项 | 值 |
| --- | --- |
| 类型 | 权威框架 |
| 出处 | <https://attack.mitre.org/> |
| 支撑的判据 | `AL-01`, `AL-06b`, `NA-02`, `NA-03`, `SC-06`, `GEN-07` |

## 它说了什么

MITRE ATT&CK 把攻击行为编成 `T####` 技术编号（如 T1110 凭证攻击、T1505.003 WebShell、
T1071 应用层协议 C2）；检测策略（Detection Strategy `DET####`）给出「看哪些数据组件、
怎么组合才能检出」。它给的是**分类和思路**，不是阈值。

## 我们怎么用它

我们用它做两件事：① 给每一类告警挂上对应的技术编号（跨类汇总时能对齐口径）；
② 抄它的「多信号组合」思路——单看一个字段不定罪，看几个字段的**组合**（GEN-07）。
**不抄它的阈值** —— MITRE 不给阈值，给的是「该看什么」。
