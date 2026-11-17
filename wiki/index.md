---
id: index
title: HIDS 研判知识库 · 2026-11-09 重建版
status: active
updated: 2026-11-09
---

# HIDS 研判知识库

这份库按仓库 `sops/*/SOP.md` 的调查流程组织，依据可定位的原文重新整理。**先读 [GEN-12 研判通则](common/GEN-12.md)，再选本类判定页。** 旧判据保留编号和正文供追溯，已退出 Agent 的自动判据目录。

| 场景 | 当前判定页 | 首要问题 |
| --- | --- | --- |
| 通用 | [GEN-12](common/GEN-12.md) | 事实、行为、结果与授权如何分开核对 |
| WebShell | [WS-13](webshell/WS-13.md) | 文件是否为可执行后门，是否被调用 |
| 异常登录 | [AL-11](abnormal-login/AL-11.md) | 登录是否获授权，后续行为如何 |
| 可疑命令 | [SC-15](suspicious-command/SC-15.md) | 命令实际执行了什么 |
| 蜜罐诱捕 | [HP-10](honeypot/HP-10.md) | 触碰、利用尝试与真实资产后果如何区分 |
| 暴力破解 | [BF-10](bruteforce/BF-10.md) | 是否成功认证，成功者是谁 |
| 本地提权 | [LP-10](elevation/LP-10.md) | 权限是否改变，是否获授权 |
| 命令记录 | [CA-08](cmdaudit/CA-08.md) | 同一会话的命令链是否可信 |
| 恶意文件 | [MA-09](malware/MA-09.md) | 文件是否运行，造成何种影响 |
| 网络异常 | [NA-09](net/NA-09.md) | 进程、目标与时间序列是否异常 |
| 内存后门 | [MW-08](memwebshell/MW-08.md) | 是否有真实注入和调用证据 |
| 内存安全 | [RP-09](rasp/RP-09.md) | 尝试、拦截与执行结果分别是什么 |
| 反弹 Shell | [RS-09](revshell/RS-09.md) | 是否建立可远程执行的通道 |

## 来源与边界

- [MITRE 技术原文核查](_evidence/mitre-original-2026-11-09.md)
- [Wazuh、Talos DNS 原文核查](_evidence/dns-original-2026-11-09.md)
- [仓库原引用的核查边界](_evidence/source-limitations-2026-11-09.md)
- [证据目录](_evidence/index.md) · [维护手册](_schema.md) · [修订日志](log.md)

每个场景目录保留原判据供审计；`customer-experience/` 的四条客户记录仍按各自审核状态独立管理，复用时须逐项核对当前告警和有效期。
