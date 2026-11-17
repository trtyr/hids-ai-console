---
id: EV-09
title: 本地链路实跑（2026-11-04）
kind: 自测
source: `infra/receiver.py` + `infra/mock_sender.py`
supports: [GEN-03]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# 本地链路实跑（2026-11-04）

| 项 | 值 |
| --- | --- |
| 类型 | 自测 |
| 出处 | `infra/receiver.py` + `infra/mock_sender.py` |
| 支撑的判据 | `GEN-03` |

## 它说了什么

用真实牧云事件（从 API 拉）走完：API → mock_sender 转 syslog → UDP → receiver → 研判 → 落盘。
实跑一条真实事件（`内置规则_尝试操作 SSH 公钥配置文件` / `vim authorized_keys`），
结论「存疑 · 371 字 · escalate」。

## 我们怎么用它

证明**核心逻辑在真实事件上是通的** —— 但**这不是真实推送**。
真实牧云主动推送在本环境拿不到（demo 有问题、自建环境没搭），
所以「接收端处理推送流量的能力」这一层没验过。
