---
id: GEN-08
title: 什么才叫「该丢弃」
applies_to: [common]
refs: [GEN-03]
status: deprecated
deprecated_reason: 原始出处与 SOP 重新核查后，由 GEN-12 统一判定
superseded_by: GEN-12
updated: 2026-11-03
source: 从 docs/knowledge/common.md 迁移
used: 0              # 被 Agent 引用次数（tools/wiki_stats.py 自动统计）
failed: 0            # 判错过几次（人工标，>0 必须写清为什么）
evidence: [_evidence/demo-real-data.md]
---

> **历史判据：已退出自动研判。** 当前判断请读 [GEN-12](GEN-12.md)；以下保留原文供追溯，部分断言未经原文证实。

# GEN-08 · 什么才叫「该丢弃」

> ⚠️ **2026-11-03 整条重写。** 原来写的是「已忽略/已处理直接丢、等级缺失直接丢」，
> **两条都是错的**，而且已经造成实测损失：21400 条告警里 4828 条被丢（23%），
> WebShell 类高达 **87%**。

## 只有一种情况该丢

**解析完发现 payload 是空的** —— 那不是「不合格的告警」，
是「送错了」或者「解析器有 bug」。判了也没意义。

## 「已忽略 / 已处理」**不许丢**

有人点过「处理」，**不代表这个判断是对的**：

- 运维手滑点错了
- 或者当时信息不全、事后才发现不对
- 或者根本不是这条告警的主人点的

**降噪的目标是让人少看无关的，不是让人看不到该看的。**
拿「人点过」当「不用看了」，正好把降噪做成了掩盖。

**正确做法**：照常研判，但在结论里标注「这条人工已表态过」。
量太大就排在后面，**但不消失**。

## 「等级缺失」**不许丢** —— 这条错得最直接

`event_level` 是 nil **只代表 syslog 没带**，不代表这条告警没等级。

实测 API 侧全都有：

| 服务 | API 里的 `level` |
| --- | --- |
| `WebshellEventService` | 4 / 3 / 3 |
| `AbnormalLoginEventService` | 2 |
| `HoneypotService` | 2 |
| `SuspiciousOperationService` | 3 |

**正确做法**：`level` 是 nil 时**去 API 拿**（见 GEN-03）。
拿到就正常判；拿不到也不因此丢弃。

## 一句话总结

**「数据不全」不是「不合格」。** 数据不全就去补，补不到就说补不到 ——
**这不构成丢弃一条告警的理由。**
