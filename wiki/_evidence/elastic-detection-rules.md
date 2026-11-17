---
id: EV-03
title: Elastic Security —— 检测规则库（含 SSH 爆破规则）
kind: 权威资料
source: <https://www.elastic.co/guide/en/security/current/>
supports: [BF-01, BF-05, SC-01, SC-06]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# Elastic Security —— 检测规则库（含 SSH 爆破规则）

| 项 | 值 |
| --- | --- |
| 类型 | 厂商工程实践 |
| 出处 | <https://www.elastic.co/guide/en/security/current/> |
| 支撑的判据 | `BF-01`, `BF-05`, `SC-01`, `SC-06` |

## 它说了什么

Elastic 的公开检测规则里，SSH 爆破那一条明确写了「**对外开 SSH 的机器会产生大量噪音**，
因为攻击者满互联网扫」。它把「失败次数到阈值」当作**触发条件**，而不是结论。

## 我们怎么用它

这条是我们暴力破解类「失败次数只衡量噪音、`success_count` 才是结论」的直接依据（BF-02）。
也用于可疑命令类：规则命中 ≠ 有事，要接着看上下文。
