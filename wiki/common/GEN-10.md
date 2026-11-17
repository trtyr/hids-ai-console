---
id: GEN-10
title: 输出必须能被人复核
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

# GEN-10 · 输出必须能被人复核

每条结论要能回答：

1. 你看了哪些字段？（列出来）
2. 你依据了什么？（引用知识库 ID + 证据）
3. 你为什么不是另外三种结论？（至少排除一个）
4. 你还缺什么？（信息不足时明说）

## 判据一句话：值班的人看完这份结论，不需要再去翻原始日志就能决定要不要拦
