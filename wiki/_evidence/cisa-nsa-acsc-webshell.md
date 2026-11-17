---
id: EV-01
title: CISA / NSA / ACSC —— WebShell 检测联合指引
kind: 权威资料
source: <https://www.cisa.gov/>  ·  <https://www.nsa.gov/>  ·  <https://www.cyber.gov.au/>
supports: [WS-01, WS-02, SC-02, SC-04]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# CISA / NSA / ACSC —— WebShell 检测联合指引

| 项 | 值 |
| --- | --- |
| 类型 | 政府机构联合发布 |
| 出处 | <https://www.cisa.gov/>  ·  <https://www.nsa.gov/>  ·  <https://www.cyber.gov.au/> |
| 支撑的判据 | `WS-01`, `WS-02`, `SC-02`, `SC-04` |

## 它说了什么

几份联合指引的共同结论：WebShell 检测不能只靠文件特征（会被混淆绕过），
要看**落地位置 + 写入者 + 是否被访问**这条链；`chmod +s` 这类「改系统文件」的动作
本身就有攻击语义，不需要等后续链走完。

## 我们怎么用它

WebShell 类「三条硬证据路径」（WS-08）的骨架就是从这几份指引来的。
可疑命令类「给系统命令加 SUID 直接算硬证据」（SC-02）也来自这里。
