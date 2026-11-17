---
id: WS-02b
title: 「web 目录」到底指哪些
applies_to: [webshell]
refs: []
status: deprecated
deprecated_reason: 原始出处与 SOP 重新核查后，由 WS-13 统一判定
superseded_by: WS-13
updated: 2026-11-03
source: 从 docs/knowledge/webshell.md 迁移
used: 0              # 被 Agent 引用次数（tools/wiki_stats.py 自动统计）
failed: 0            # 判错过几次（人工标，>0 必须写清为什么）
evidence: [_evidence/demo-real-data.md]
---

> **历史判据：已退出自动研判。** 当前判断请读 [WS-13](WS-13.md)；以下保留原文供追溯，部分断言未经原文证实。

# WS-02b · 「web 目录」到底指哪些

**这个不能写死成一张固定列表** —— 每台机器上跑的站点不一样。

**正确做法：从配置基线里读。**

```text
baseline.web_roots = [
  "/var/www/html",           # Ubuntu/Debian 默认
  "/usr/share/nginx/html",   # nginx 默认
  "/home/*/public_html",     # 用户站点
  "/opt/tomcat/webapps",     # Tomcat 应用
]
```

**基线里没登记这台机器的 web 根目录 → 不做路径判定 → 存疑。**

## ⚠️ 别用「路径里有没有 www」这种土办法

- `/var/www/html` 有 `www` ✓
- `/opt/tomcat/webapps` **没有 `www`**，但它是标准 web 目录 ✗
- `/home/app/public_html` 没有 `www` ✗
- `/www-backup/` 有 `www`，但**它不是 web 目录** ✗

**靠字符串猜路径是静默失败的典型** —— 猜错了不报错，只是结论悄悄变差。
