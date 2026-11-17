---
id: GEN-03
title: 「缺信息」要明说，不要用猜的填
applies_to: [common]
refs: []
status: deprecated
deprecated_reason: 原始出处与 SOP 重新核查后，由 GEN-12 统一判定
superseded_by: GEN-12
updated: 2026-11-03
source: 从 docs/knowledge/common.md 迁移
used: 0              # 被 Agent 引用次数（tools/wiki_stats.py 自动统计）
failed: 0            # 判错过几次（人工标，>0 必须写清为什么）
evidence: [_evidence/zero-token-audit-2026-11-04.md, _evidence/realtime-pipeline-local.md]
---

> **历史判据：已退出自动研判。** 当前判断请读 [GEN-12](GEN-12.md)；以下保留原文供追溯，部分断言未经原文证实。

# GEN-03 · 「缺信息」要明说，不要用猜的填

**Agent 的输入只有四块**：这条告警的字段、自己的配置基线、滑动窗口、IP 情报。**任何一块缺失都不能编。**

- **先去 API 查**（`api_evidence` 里有没有？）→ 查不到才写进 `questions_for_human`，结论给「存疑」
- **不要**用「通常情况下…」补全缺失字段
- **不要**把产品自己给的结论（牧云的 `rule_subject` / `repair` 字段）当成证据 —— 那是产品的判断，不是你的
