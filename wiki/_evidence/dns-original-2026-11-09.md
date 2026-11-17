---
id: EV-15
title: DNS 隧道与外带检测原文核查
kind: 外部原文
source: https://wazuh.com/blog/detecting-dns-tunneling-attacks-with-wazuh/ ; https://blog.talosintelligence.com/detecting-dns-data-exfiltration/
supports: [NA-09]
date: 2026-11-09
status: active
---

# EV-15 · DNS 隧道与外带检测原文核查

- [Wazuh《Detecting DNS tunneling attacks with Wazuh》](https://wazuh.com/blog/detecting-dns-tunneling-attacks-with-wazuh/)：原文将高熵查询、过长标签及重复的异常查询列为 DNS 隧道指标。文章用的是“indicator”，没有把单个高熵子域名定义为攻击定论。
- [Cisco Talos《Detecting DNS Data Exfiltration》](https://blog.talosintelligence.com/detecting-dns-data-exfiltration/)：原文建议建立正常 DNS 活动模型，再找与预期差异很大的请求；并说明恶意软件可将数据编码在子域名里。2026-11-09 用 Chrome 读取原文正文。
- [MITRE T1071.004](https://attack.mitre.org/techniques/T1071/004/)：攻击者可以借 DNS 携带命令或结果，但此技术描述不能证明一条 DNS 请求就是外带。

使用边界：要判断频率、周期性或外带量，须有时间窗内的 DNS 序列、主机与进程归属和业务基线。只有单条告警时，这些结论保持未知。
