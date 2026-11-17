---
id: EV-12
title: Wazuh —— DNS 隧道检测（高熵子域名）
kind: 权威资料
source: <https://wazuh.com/blog/detecting-dns-tunneling-attacks-with-wazuh/>
supports: [NA-02, NA-03]
date: 2026-11-04
status: deprecated
---

> **历史资料：已退出当前判据目录。** 原出处与可验证范围见[来源审计](../_evidence/source-limitations-2026-11-09.md)；以下保留旧文供追溯。

# Wazuh —— DNS 隧道检测（高熵子域名）

| 项 | 值 |
| --- | --- |
| 类型 | 开源 SIEM 文档 |
| 出处 | <https://wazuh.com/blog/detecting-dns-tunneling-attacks-with-wazuh/> |
| 支撑的判据 | `NA-02`, `NA-03` |

## 它说了什么

DNS 隧道会生成看起来随机或伪随机的子域名，包含长串无意义字符。
**高熵是「编码数据（base32/base64）在被传输」的强指标。**

## 我们怎么用它

网络异常类「发的是什么」那条判据的依据：子域名是长随机串 → 加重。
配合 MITRE DET0400 的「非浏览器、非系统进程发起」一起用。
