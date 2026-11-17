---
id: GEN-05
title: 云厂商 IP ≠ 良性（OWASP Credential Stuffing Prevention Cheat Sheet）
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

# GEN-05 · 云厂商 IP ≠ 良性（OWASP Credential Stuffing Prevention Cheat Sheet）

> 「Many credential stuffing toolkits, such as Sentry MBA, offer the ability to use **proxy networks to distribute requests across a large volume of unique IP addresses**. This may defeat both IP block-lists and rate limiting, as **per IP request volume may remain relatively low, even on high volume attacks**.」

**含义**：

1. 单 IP 封禁 / 单 IP 频次阈值，对代理化攻击无效
2. 判定要看**集合特征**（网段聚集、ASN、目标集中度），不能只看单个 IP
3. 「这个 IP 之前也来过」**不是**良性证据
