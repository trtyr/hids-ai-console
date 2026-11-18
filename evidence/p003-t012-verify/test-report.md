# P003-T012 · 后端验收（黑盒）测试报告

- 工作树：`/home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T012`
- 分支：`task/hids-ai-console-P003-T012`，HEAD `b502494`（复审通过后未再漂移；`git status` 只有 `.pi-child-claim.json` 与本报告目录未跟踪）
- 契约来源：`docs/modules/investigation-agent.md` §3.8/§4/§5.5、`docs/modules/triage-pipeline.md` §4、`openapi.yaml`、`docs/_meta/gaps.md`
- 判据：只按文档造请求、按文档断言；没有读 `investigation-agent.js` 的内容，只做结构定位与变异定位（行号来自复审判词与报告）。

## 一、门禁（全部本终端亲跑，不转录）

| 命令 | 结果 |
| --- | --- |
| `node --check investigation-agent.js` | exit 0 |
| `timeout 120 node --test investigation-agent.test.js` | tests 19 / pass 19 / fail 0（143ms） |
| `timeout 180 node --test triage-monitor.test.js syslog-pipeline.test.js agent-api.test.js integration.test.js` | tests 46 / pass 46 / fail 0（255ms） |
| `timeout 300 node --test --test-reporter=tap *.test.js` | tests 166 / pass 165 / fail 1（exit 1）；唯一 `not ok 85 - maintenance CLI starts when the deployment current path is a symlink`，属 `docs/_meta/gaps.md` 一的环境基线；`git diff d6a280f..HEAD --name-only \| grep maintenance` 为空，本卡零触碰 |
| `timeout 120 node --test evidence/p003-t012-verify/acceptance.test.js` | tests 16 / pass 16 / fail 0（203ms） |

范围核对：`git diff d6a280f..HEAD --stat` 只动 5 个文件；`git diff HEAD~1 -- triage-monitor.js` 为 0 行。

## 二、我自己写的验收用例（`evidence/p003-t012-verify/acceptance.test.js`，16 条）

全部按文档断言，用真 `RuleStore('rules')`、真 `WikiStore()`、真 `TriageMonitor`/`InvestigationStore`；模型与牧云侧用脚本化替身（外部服务不可用，测试替身的最高一档是 fake）。

| 覆盖 | 用例（条数） | 结果 |
| --- | --- | --- |
| A1 Rego 注入 | 命中（prompt 含 `# 套上的 Rego 规则`/规则名/`package hids.rules.honeypot_probe`/「规则只说明字段命中」+ `verdict.rego={matched,[honeypot_probe]}` + trace 同口径）、未命中 `none`、载荷缺 `target_ip` 时 `peer` 不进事实 → 规则套不上、deep 无 syslog 事实 `not_applicable`、规则目录不存在 `unavailable`（研判不中断、原因进 prompt）（5） | 16/16 绿 |
| A2 知识库必查/采纳 | 真判据库 `wiki_page SC-15` → 采纳后 `{consulted:['SC-15'],adopted:['SC-15'],reason:''}`；`wiki_search` 命中 GEN-12/SC-15 都进 consulted；三条硬校验（未查先交/采纳未查页/未采纳不写原因）各被退回且循环继续；模型直接吐 JSON 先催一轮（trace `{kind:'wiki',action:'required'}`）并写缺口；**A1/A2 捷径**（webshell 已审核经验命中，真 KnowledgeStore）：`verdict.rego={matched,[webshell_drop]}`、`verdict.wiki={consulted:[],adopted:[],reason:'命中已审核经验捷径，未调用知识库工具'}`（5） | 同上 |
| A3 结论工具 | 空正文被退 / 501 字被退 / 500 字收下（`[...summary].length===500`、trace `summary_chars:500`）；**按字符计**：500 个四字节 emoji 收下（UTF-16 长度 1000）；deep 模式带 `wiki_adopted` 不被拒、`verdict.wiki===undefined`；缺 verdict 与表外写法被退回（4） | 同上 |
| 结果形状 | `run()` 12 个必备字段、`auto_action===false`、`rego.status` 四态枚举、`review.assessment` 四态枚举、`validation` 形状、deep 的 `required_evidence=[]`、`evidence[].sha256`（1） | 同上 |
| A4 回归（公开入口 `acceptSyslog`） | 同报文两次 → `collapsed:true`、`repeat_count:2`、同 alert_id、**只研判一次**、history `repeat_count:2`、`05-研判结果.md` 含「重复投递：2 次」；跨事件秒 → 新记录、另一次研判（`triage-pipeline.md:293`）（1） | 同上 |

A4 另有既有回归用例亲跑：`node --test syslog-pipeline.test.js` → 5/5（含「重复投递：2 次 / repeat_count=2 / 跨秒另建记录」）。

## 三、变异验红（亲手复现，锚点守卫不是空口）

1. 备份 `investigation-agent.js` 并记 sha256：`a2a48ba2…d8df`。
2. `sed -i '436,437d' investigation-agent.js`（复审 major 修的两行赋值），`node --check` = 0。
3. 守卫恰红：
   - `node --test investigation-agent.test.js` → 18/19，唯一红项是 `published customer experience avoids a full repeat investigation…`（:88-90 的 deepEqual）。
   - `node --test --test-name-pattern='捷径' evidence/p003-t012-verify/acceptance.test.js` → 1/1 恰红（我独立写的捷径守卫同样抓到）。
4. 还原：`cp` 回备份，`sha256sum -c` = OK；再跑 `node --test investigation-agent.test.js` → 19/19 绿。

结论：捷径的 `verdict.rego`/`verdict.wiki` 断言有判别力，不是永真断言。

## 四、发现

### F1（minor，doc/spec 对不上实现）deep 模式下非字符串 `summary` 原样写进结果，违反 openapi 的 string 类型

- 文档说：`docs/modules/investigation-agent.md` §3.8.C「正文取 `summary`，按字符计（`[...text].length`）……空正文或超限都退回」；`openapi.yaml:1508` `Investigation.verdict.summary: { type: string }`（`POST /api/agent/investigations`、`GET /api/agent/investigations/{alertId}` 都回这个 schema，见 `openapi.yaml:377`、`397`）。
- 实测：deep 模式下 `submit_conclusion` 的 `summary` 传数字/对象/数组不被退回，`result.verdict.summary` 分别是 `number` / `object`，即调研记录对 wire 契约违约。triage 模式因 `finalizeTriageOutput` 整形会落成字符串，问题只在 deep。
- 复现：`node evidence/p003-t012-verify/probe-summary-type.mjs` → exit 1：
  ```
  123 -> verdict.summary typeof=number value=123 | spec(type:string) VIOLATED
  {"note":"obj"} -> verdict.summary typeof=object value={"note":"obj"} | spec(type:string) VIOLATED
  ["a","b"] -> verdict.summary typeof=object value=["a","b"] | spec(type:string) VIOLATED
  ```
- 影响：模型偶尔把 summary 写成数字时，deep 结果会产出违反 openapi 的响应体（前端按 string 处理会拿到非字符串）。不阻塞 A1-A4，但下游按 schema 取值会踩。
- 改法（不代改）：`submit_conclusion` 入口把 `summary` 非字符串直接退回（与空正文同档），或收下时 `String(summary)` 归一再入结果。

### 文档侧记录（不立 blocker，供写者/审查参考）

- **D1**：`docs/modules/investigation-agent.md` §3.8.C 写「`verdict` 必须是三态（真实威胁/存疑/误报）」，实测结论工具还收 §3.1 映射表里的别名（如「攻击尝试未成功」→ 结果 `uncertain`），只有缺 verdict 与表外写法才退回。§3.1 又写输出契约定「『攻击尝试未成功』不作为 verdict」。两处措辞互相打架，文档没写清结论工具到底收哪些写法。
- **D2**：`openapi.yaml` 的 `Investigation.verdict` 没有声明新增的 `rego` / `wiki` 字段（靠 `additionalProperties: true` 兜着，不算违约，但 wire 契约里看不到这两个字段；`docs/modules/investigation-agent.md` §4 已声明）。本卡文档 scope 只放开 investigation-agent.md，故只记 doc-side，不判违约。
- **D3**：三条结论工具退回文案里，文档给了「本次分析还没有调用知识库工具…」与「必须写明采纳了哪一页…」的引文，但「`wiki_adopted` 里有没查过的页 → 退回」只写了结论、没给文案。测试只按文档给了的句子断言，没给的那条只断言「循环未结束」，不替 spec 猜文案。

## 五、边界与错误路径覆盖（本卡可触发的部分）

- 必填缺失：`submit_conclusion` 缺 `verdict` → 退回「verdict 必须是…」；缺 `summary` → 退回「summary 结论正文不能为空」。
- 类型错：数字/对象/数组 `summary`（F1）、表外 verdict 写法 → 退回。
- 越界：501 字退回、500 字与 500 个四字节字符收下（字符计而非 UTF-16 计）。
- 空：空字符串 summary 退回。
- 非法枚举：`rego.status` 四态全触发（matched/none/unavailable/not_applicable），`review.assessment`、`required_evidence.status` 按文档枚举断言。
- 失败不中断：规则目录不存在 → `unavailable`，run 正常返回且 `validation.ok===true`。
- A2 退回路径：三条校验各触发一次，且退回后调查循环继续（工具调用计数从脚本消费条数可证）。

## 六、残余风险

- 没打真模型、没连真牧云：结论工具被真实模型触发的频率、非字符串 summary 的现实概率未测（本机无凭据，`docs/_meta/gaps.md` 口径）。
- 我的 A2 用例用脚本化模型驱动工具顺序；真实模型乱序/不调工具时的行为只覆盖了文档写明的兼容路径（催一轮）。
- 全量根目录套件里 `maintenance-startup` symlink 一条仍是环境基线旧账（本卡零 diff），不作为本卡结论。
- 验收用例只跑在 node 当前版本；`node --test` 版本差异未做矩阵。

## 七、可复跑清单

```bash
cd /home/trtyr/.pi-worktrees/hids-ai-console/hids-ai-console/P003-T012
node --check investigation-agent.js
timeout 120 node --test investigation-agent.test.js
timeout 180 node --test triage-monitor.test.js syslog-pipeline.test.js agent-api.test.js integration.test.js
timeout 120 node --test evidence/p003-t012-verify/acceptance.test.js
timeout 300 node --test --test-reporter=tap *.test.js            # 165/166，唯一红为 maintenance symlink 环境基线
node evidence/p003-t012-verify/probe-summary-type.mjs            # exit 1 = F1 成立
```
