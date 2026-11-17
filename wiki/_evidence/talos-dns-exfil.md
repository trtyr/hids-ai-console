---
id: EV-11
title: Cisco Talos —— DNS 数据外带检测（靠基线看偏离）
kind: 权威资料
source: <https://blog.talosintelligence.com/detecting-dns-data-exfiltration/>
supports: [NA-02, NA-03]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# Cisco Talos —— DNS 数据外带检测（靠基线看偏离）

| 项 | 值 |
| --- | --- |
| 类型 | 厂商安全研究 |
| 出处 | <https://blog.talosintelligence.com/detecting-dns-data-exfiltration/> |
| 支撑的判据 | `NA-02`, `NA-03` |

## 它说了什么

Talos 的方法论：**先有「正常」的基线，才能看出「偏离」**。
熟悉常见的 DNS 请求模式之后，才能发现「现实和预期差得很远」的那一次。

## 我们怎么用它

这是网络异常类「发多少」那条判据的依据 —— 但**我们拿不到频次**（API 只给单条事件），
所以那条判据现在是**判不了**的状态，已写进 `net/open-questions.md`。
