---
id: EV-10
title: Signal Fieldnotes / reverseshell.app —— 「链路」比「载荷」重要
kind: 权威资料
source: <https://signalfieldnotes.com/>  ·  <https://reverseshell.app/>
supports: [RS-01, RS-02, RS-04]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# Signal Fieldnotes / reverseshell.app —— 「链路」比「载荷」重要

| 项 | 值 |
| --- | --- |
| 类型 | 独立安全研究 |
| 出处 | <https://signalfieldnotes.com/>  ·  <https://reverseshell.app/> |
| 支撑的判据 | `RS-01`, `RS-02`, `RS-04` |

## 它说了什么

Signal Fieldnotes：决定性的是**网络通道和执行之间的那条链路**，而不是端口、加密或编程语言。
reverseshell.app 列举的好信号：带 socket 方向父进程的 shell、从 web worker 拉起的解释器、
数据库引擎拉起的命令 shell。

## 我们怎么用它

支撑 RS-02「父进程是最强信号」——**web 进程起 shell 这件事，业务逻辑里没有正当理由**。
也解释了为什么我们不按「连到哪个端口」判（4444 只是惯例，不是判据）。
