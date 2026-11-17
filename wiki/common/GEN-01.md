---
id: GEN-01
title: MITRE ATT&CK《Finding Cyber Threats with ATT&CK-Based Analytics》(16-3713)
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

# GEN-01 · MITRE ATT&CK《Finding Cyber Threats with ATT&CK-Based Analytics》(16-3713)

> 「adversaries tend to exhibit consistent patterns of behavior while interacting with endpoint or victim systems.」

**含义**：判定看**行为模式**，不看单条事件。孤立一条看不出结论，要放进时间窗里看模式。
