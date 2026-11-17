---
id: GEN-06
title: 降噪的真正来源是「历史」，不是「白名单」
applies_to: [common]
refs: []
status: deprecated
deprecated_reason: 原始出处与 SOP 重新核查后，由 GEN-12 统一判定
superseded_by: GEN-12
updated: 2026-11-03
source: 从 docs/knowledge/common.md 迁移
used: 0              # 被 Agent 引用次数（tools/wiki_stats.py 自动统计）
failed: 0            # 判错过几次（人工标，>0 必须写清为什么）
evidence: [_evidence/demo-real-data.md, _evidence/mitre-attack.md]
---

> **历史判据：已退出自动研判。** 当前判断请读 [GEN-12](GEN-12.md)；以下保留原文供追溯，部分断言未经原文证实。

# GEN-06 · 降噪的真正来源是「历史」，不是「白名单」

白名单是**人工点确认**的静态清单，它只能覆盖已知的源。

**Agent 侧真正能积累的**：

- 同一来源的历史判定序列（上次怎么判的）
- 同一网段 / ASN 的历史判定序列
- 同一资产的正常行为基线

**「这个来源过去 30 次都被判「误报」」是降噪的主要依据**，比任何静态规则都强，而且它会随时间自动更新。
