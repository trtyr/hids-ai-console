---
id: EV-05
title: Invicti / Sysdig —— 反弹 Shell 检测的三个关联条件
kind: 权威资料
source: <https://www.invicti.com/blog/web-security/>  ·  <https://sysdig.com/blog/>
supports: [RS-01, RS-02, RS-03]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# Invicti / Sysdig —— 反弹 Shell 检测的三个关联条件

| 项 | 值 |
| --- | --- |
| 类型 | 厂商安全研究 |
| 出处 | <https://www.invicti.com/blog/web-security/>  ·  <https://sysdig.com/blog/> |
| 支撑的判据 | `RS-01`, `RS-02`, `RS-03` |

## 它说了什么

Invicti 的原话：实用的检测模型不是「识别某个具体载荷」，而是**关联三个条件**——
异常的父进程（比如 web 服务器或应用进程）、出站连接、以及子进程创建。
Sysdig 补了一句：所有规则都可能误报，取决于 Execution / Remote Connection /
child process / fd 这几个 building block 怎么组合。

## 我们怎么用它

直接成了反弹 Shell 类的判定骨架（RS-05）：先看进程是不是 shell/连接器，
再看父进程是不是 web/数据库，最后看命令行有没有反弹特征。
