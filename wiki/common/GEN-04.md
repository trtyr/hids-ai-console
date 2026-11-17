---
id: GEN-04
title: IP 归属地只能加权，不能定罪
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

# GEN-04 · IP 归属地只能加权，不能定罪

云厂商 IP 段**不等于**可信来源 —— 攻击者大量使用云主机，攻击者攻陷云主机后从云内发起攻击更是常态。

反过来说，归属地「罕见」也**不能**单独定罪 —— VPN / 代理 / 移动网络都会造成位置漂移。

## 归属地唯一的作用：提供一个方向的权重，并且必须和其它证据同向出现才有意义
