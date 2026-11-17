---
id: EV-06
title: ManageEngine —— 爆破调查：成功登录是最重要的发现
kind: 权威资料
source: <https://manageengine.com>
supports: [BF-02, BF-04]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# ManageEngine —— 爆破调查：成功登录是最重要的发现

| 项 | 值 |
| --- | --- |
| 类型 | 厂商威胁检测指南 |
| 出处 | <https://manageengine.com> |
| 支撑的判据 | `BF-02`, `BF-04` |

## 它说了什么

原话：来自爆破源的**成功登录，是整个调查里最重要的发现**
（the most important finding in the entire investigation）。
要查的是同一来源 / 同一账号在时间窗内及之后 24 小时内的成功登录。

## 我们怎么用它

这是暴力破解类**唯一的硬证据**（`success_count > 0`）的直接依据。
demo 实测 380 条事件 `success_count` **全是 0** —— 所以这条路只有构造样本能验。
