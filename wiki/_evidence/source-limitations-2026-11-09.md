---
id: EV-16
title: 仓库外部出处的核查边界
kind: 来源审计
source: source-review/ai-hids-ops/docs/wiki/_evidence/
supports: [GEN-12]
date: 2026-11-09
status: active
---

# EV-16 · 仓库外部出处的核查边界

仓库原有证据页中，CISA/NSA/ACSC、Elastic、ENISA、Invicti/Sysdig、ManageEngine、Signal Fieldnotes 多数只给机构首页或博客栏目，无法定位所引语句及版本。2026-11-09 已尝试用 Chrome 和直连请求查找；这些概括暂不作为自动定性的原文证据。

OPSWAT 原链接返回 403，未确认其“扫描结果回答不了是否执行”的原文措辞。该区分在本库作为**分析问题**使用：文件存在、扫描命中、进程运行与实际危害是不同事实；其依据应来自事件本身的独立取证。

仓库 SOP 和 `demo-real-data.md` 是方案设计与演示环境记录，不是客户环境的独立事实。引用它们可以说明应检查哪些字段或复现过哪些样本，不能把演示统计推广到当前客户告警。`sops/*/SOP.md` 自述部分是底稿，流程改动还应核对同目录 `analysis-steps.html`。

旧判据中“成功登录必为账号攻破”“回连测试域名必为真实威胁”“服务账号提权必为攻击”“正常服务出现 class_name 必为内存马”“防护拦截意味着漏洞存在”等绝对化说法，没有从已核查原文得到充分支撑。新版均要求补齐事件链、授权与执行结果。
