---
id: EV-14
title: MITRE ATT&CK 技术原文核查
kind: 外部原文
source: https://attack.mitre.org/
supports: [GEN-12, AL-11, BF-10, CA-08, LP-10, MA-09, MW-08, NA-09, RP-09, RS-09, SC-15, WS-13]
date: 2026-11-09
status: active
---

# EV-14 · MITRE ATT&CK 技术原文核查

2026-11-09 逐页打开下列技术原文。ATT&CK 描述攻击者**可能采用**的技术及可观察行为；技术匹配本身不证明本次事件属于恶意，也不证明执行成功或客户未授权。

| 技术 | 原文位置 | 本库可采用的事实 | 不能从原文推出 |
| --- | --- | --- | --- |
| T1110 暴力破解 | <https://attack.mitre.org/techniques/T1110/> | 失败尝试后出现同源成功登录是需要关联的模式 | `success_count > 0` 单独证明账号被攻破 |
| T1078 有效账号 | <https://attack.mitre.org/techniques/T1078/> | 有效账号可被攻击者使用，应核对账号和授权 | 成功登录必然是攻击者 |
| T1505.003 WebShell | <https://attack.mitre.org/techniques/T1505/003/> | WebShell 是置于 Web 服务上的脚本，可为远程访问入口 | 文件名、路径或单次扫描命中即证明后门 |
| T1059 命令与脚本解释器 | <https://attack.mitre.org/techniques/T1059/> | 攻击者可借解释器执行命令 | 使用 shell、Python 即为攻击 |
| T1105 工具传入 | <https://attack.mitre.org/techniques/T1105/> | 工具或文件传入可构成攻击链一环 | 下载行为等于执行或入侵成功 |
| T1548.001 Setuid/Setgid | <https://attack.mitre.org/techniques/T1548/001/> | Setuid/Setgid 可被用于提权 | 任意 SUID 或服务账号提权都必为攻击 |
| T1548.003 Sudo | <https://attack.mitre.org/techniques/T1548/003/> | 攻击者也可能滥用 sudo 或 sudo 缓存 | 使用 sudo 即可排除攻击 |
| T1055 进程注入 | <https://attack.mitre.org/techniques/T1055/> | 进程注入可用于在另一进程上下文执行 | 单个类名或进程名可证明注入 |
| T1071.004 DNS | <https://attack.mitre.org/techniques/T1071/004/> | DNS 可承载命令和数据 | DNS 异常或测试域名即证明 C2、数据外带 |
| T1190 公开应用利用 | <https://attack.mitre.org/techniques/T1190/> | 公开应用可成为利用入口 | 蜜罐请求等于真实资产被攻破 |
| T1070.004 文件删除 | <https://attack.mitre.org/techniques/T1070/004/> | 删除文件可作为清痕动作 | 删除文件本身即为反取证 |

核查范围是所列技术页，不包括具体客户环境、牧云告警的真实性或技术页所引用的每个案例。
