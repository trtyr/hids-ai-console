## 口径- commit `e98cd2abd10aab0fabf34457eacf20af470d1002`（2026-11-21 00:11 生成，`git rev-parse HEAD`）
- **仓库里没有 `data/` 目录**：P003-T034 起运行态全部落在数据根 `HIDS_DATA_DIR` 或 `~/.local/share/hids-ai-console`（`config-store.js:32-37`）。你提到的 `data/investigations/`、`data/cases/` 等，在本机对应的是数据根下的同名目录（旧的仓内 `.data/` 已被搬走，留在 `migration-backup-20261120/repo-dot-data/`）。
- 审计方法：读全部 50 条路径的路由实现（`server.js:898-1400` + `maintenance-server.js:59-140`）+ 四个 store 的写入结构 + 本机数据根实物 + 一次运行时探针（`summary()`/`status()`/`cases()` 的返回键）。

---

## 1. 持久化数据面全盘点（15 个面）

| 面 | 落点 | 写入处 |
|---|---|---|
| 研判记录 | `<root>/investigations/<sha256>.json` | `investigation-store.js:14-22` |
| 研判队列 | `<root>/triage-monitor.json` | `triage-monitor.js:284-295` |
| 队列归档 | `<root>/triage-monitor.json.archive.jsonl` | `triage-monitor.js:429-431`、`482-484` |
| 案卷 | `<root>/cases/<msgid>/<stamp>-<digest>-<uuid>/`（9 个文件） | `syslog-case.js:102-117`、`145-150`、`191-209` |
| 溯源白板 | `<root>/trace-boards/<id>.json` | `trace-board.js:345-357` |
| 知识维护会话 | `<root>/wiki-sessions/<uuid>.json` | `wiki-workbench.js:91-96` |
| 误报维护会话 | `<root>/fp-sessions/<uuid>.json` | `fp-maintainer.js:117-125` |
| 规则维护会话 | `<root>/rule-sessions/<uuid>.json` | `rule-store.js:458-465`、`server.js:249-251` |
| 规则库 | `<root>/rules/<id>.rego` | `rule-store.js:279-283` |
| 规则历史 | `<root>/rules-history/<id>-<rev>.rego` + `.json` | `rule-store.js:292-299` |
| 判据库 | `<root>/wiki/**/*.md`（190 份） | `wiki-store.js:230-236`、`343`、`374-380` |
| 判据历史 | `<root>/wiki-history/<id>-<rev>.md` | `wiki-store.js:226-228`、`331-334` |
| 判据变更日志 | `<root>/wiki/log.md` | `wiki-store.js:234`、`347`、`379` |
| 配置覆盖层 | `<root>/config-overrides.json` | `config-store.js:102-108` |
| 提示词覆盖层 | `<root>/prompt-overrides.json` | `prompt-store.js:84-87`、`115-117` |
| 研判规则集 | `<root>/triage-rules.json` | `triage-rules.js:243-258` |
| 升级包 | `<root>/update-packages/<sha256>.json` | `update-store.js:120-122` |
| 日志 | `HIDS_LOG_FILE` | `log.js:228` |
| 候选经验库 | **未接线**（无实例、无路由） | `knowledge-store.js:21-25` |

---

## 2. 清单 (1)：写进去了，但没有任何 API 返回

**1. 队列里的原始报文与完整载荷** — `triage-monitor.js:891`（`input:{raw,parsed}`）、`:292`（落盘）。
`status()` 在 `triage-monitor.js:518-523` 显式 `const {input, ...visible}` 剥掉；`cases()`（`:528-557`）只从 `input.parsed.payload` 取 6 个派生字段。
**依据（运行时探针）**：`status keys: alert_id,status,stage,…` 无 `input`；`cases item` 无 `raw`。本机载荷实际有 ~60 个字段（`file_sha256`/`file_md5`/`event_description`/`isolate_state`/`process_*`/`hits`…），**一个都不出接口**。

**2. 会话时间窗 `windows[]`** — 写 `triage-monitor.js:923-934`（`at/msgid/event_name/command/file_path/source_ip/target_ip/target_port/host_ip/user_name/repeat_count`）。
`summary()`（`:575-628`）无 `windows` 键（实测 `summary has windows=false`）；`openapi.yaml:2339-2490` 的 TriageSummary 也无。**同会话 ±5 分钟的关联事件对前端完全不可见。**

**3. 去重指纹表 `dedupe[]`** — 写 `triage-monitor.js:895-897`（`delivery_count/event_delivery_count/occurrence_count/last_delivery_second/record_id`）。
只在 `summary()` 之外，无任何出口（实测 `dedupe=false`）。

**4. 轮询游标 `watermark` / `watermark_ids`** — 写 `triage-monitor.js:285-286`。
`summary()` 无这两个键（实测 `watermark=false`）。poll 模式下前端看不到"轮询到哪了/漏了哪些事件"。

**5. 暂停缓冲里的原始报文 `paused.buffer`** — 落盘 `triage-monitor.js:288`，重启后恢复 `:186-190`。
只暴露条数 `paused.buffered`（`:619`），**报文内容永不返回**。

**6. 队列归档文件 `.archive.jsonl`** — 写 `triage-monitor.js:429-431`、`482-484`。
归档后记录被 `dropRecord`（`:414-418`）移出内存 → `cases()` 再也看不到；只有 `archived.count` 与字节数可见（`server.js:702-717`）。**归档里的旧案件无任何读取接口**（本机该文件 6334 字节、含已完成案件）。

**7. 案卷材料 9 个文件** — `syslog-case.js:102-117`（`00-这是什么.md`/`01-原始告警.txt`/`02-告警字段.md`/`03-研判事实.md`/`03b-判据索引.md`/`04-上下文.md`）、`:145-150`（`05-研判结果.md`/`result.json`）、`:191-209`（`06-必查项.json`）。
接口只给一个路径字符串 `case_dir`（`triage-monitor.js:546`）。读它们的 `readCaseFile`（`syslog-case.js:173`）**只被 agent 内部调用**（`investigation-agent.js:768`、`1104`）；`readRequiredEvidence`（`syslog-case.js:213`）**全仓只有测试在用**。后端不提供静态文件（`server.js` 无 `createReadStream`），前端 `web/` 也从不引用 `case_dir`。**研判材料、原始告警、必查项落盘结果均不可读。**

**8. 规则维护会话正文** — 写 `server.js:249-251` + `296-312`（`proposal:{id,rego,rationale}`、`validation`、`result:{previous_rev}`、`error`）。
`GET /api/rules/sessions`（`server.js:1040-1044` → `rule-store.js:469-478`）只给摘要：`rule_id`（=proposal.id）、`validated`（=validation.ok）——**rationale / result / error 全丢**。且**没有详情路由**：`/api/rules/sessions/<uuid>` 会落到 `server.js:1113` 的规则读接口，`isRuleId` 不通过 → 400。
注：`server.js:305-306` 注释明写"rev / previous_rev / 会话 id 落在会话文件里（`GET /api/rules/sessions` 可按 case_id 找到）"——**列表并不返回这些**。

**9. 规则历史版本的正文与"被谁替换"** — 写 `rule-store.js:292-299`（`<id>-<rev>.rego` + `<id>-<rev>.json` 的 `{id,rev,note,saved_at,replaced_by}`）。
`history()`（`rule-store.js:316-327`）只给 `{id,rev,file,bytes,saved_at,note}`——**`replaced_by` 不出**；读某版正文的 `readRevision()`（`:338-344`）只被 `rollback` 用，**没有 `GET /api/rules/{id}/history/{rev}`**。

**10. 判据页历史版本** — 写 `wiki-store.js:226-228`、`331-334`（`<root>/wiki-history/<id>-<rev>.md`）。
`wiki.get()`（`wiki-store.js:127-140`）只读当前页；**无任何历史读接口**。唯一能读到的是 `log.md`（`/api/wiki/pages/log.md`），里面只有"要点/审核人/案件/回放样本数"，**看不到上一版正文**。

**11. 配置覆盖层的来源信息** — 写 `config-store.js:102-108`。
`configStore.overrides()`（`config-store.js:122`）**全仓无人调用**（`grep overrides()` 零命中）。`GET /api/config`（`server.js:909`）只给生效值 + 机密布尔，**看不出某项是环境变量还是文件覆盖的**。

**12. 数据根里 9 类运行态存储不在盘点/清理口径内** — `DATA_KINDS`（`server.js:621`）只有 `cases/investigations/boards/wiki_sessions/queue/logs/config_overrides`。
漏：`fp-sessions/`、`rules/`、`rules-history/`、`rule-sessions/`、`wiki/`、`wiki-history/`、`prompt-overrides.json`、`triage-rules.json`、`update-packages/`。
**本机实测：`fp-sessions/` 3187 个文件 / 27MB，`wiki/` 190 份 / 852KB —— `GET /api/data/inventory` 一条都不报，`POST /api/data/cleanup` 也清不掉。**

**13. 提示词覆盖层正文与"哪几段被改过"** — 写 `prompt-store.js:115-117`（逐段覆盖正文）。
`GET /api/agent/prompts`（`server.js:1224` → `prompt-store.js:94-104`）只给 `{id,name,kind,characters}`：**没有正文、没有"这段是覆盖的还是仓内默认"的标记**。（`_release/_history` 由 `GET /api/updates` 覆盖，不算缺口。）

**14. 候选经验库整库未接线** — `knowledge-store.js:7-38` 有完整写结构（`fields/missing/deferred_fields/next_field/messages/review`），但 `server.js` 从不 import 它（`grep KnowledgeStore` 仅命中自身）→ **既无 API 也无运行期写入**。

**15. `wiki/_ids.json`** — 编号→class/title 的遗留索引，无任何代码读写（`grep _ids` 无命中），仍随 `wiki/` 种子拷进数据根（`rule-store.js:424-433`），也不被任何接口读。

---

## 3. 清单 (2)：暴露了，但缺关键字段

**A. `GET /api/agent/triage/cases` 的 `command` 恒为 null。**
代码读 `payload.process_command_line`（`triage-monitor.js:556`），**真实牧云 syslog 载荷的键是 `process_cmdline`**（同仓 `cloudwalker.js:60`、`trace-board.js:150` 读 API 侧时是 `cmdline|command|shell_cmdline|process_cmdline` 四个都兼容）。
**本机实测 3 条真实记录：`payload.process_command_line = undefined`，`payload.process_cmdline` 有完整命令行 → 接口 `command` 全 null。** 同样只透出 6 个字段的还有 `file_path`/`file_sha256`/`event_name`/`host_name`/`process_name`/`isolate_state`/`event_description` 等 50 余个已落盘字段。

**B. `GET /api/agent/triage/{alertId}`（openapi `TriageCase`，`openapi.yaml:2492-2544`）实际返回但 spec 未声明的字段**：`case_dir`、`summary`、`missing_evidence`、`next_actions`、`evidence_refs`、`rule_id`、`saved_at`、`result_alert_id`、`occurrence_count`、`session_key`（spec 只列 16 键 + `additionalProperties:true`）。前端照 spec 写会漏读。

**C. `GET /api/agent/triage/status`（TriageSummary）缺水位/去重/时间窗**（见 2/3/4 条）：想看"队列游标""同会话关联事件""重复投递指纹"都得自己造。

**D. `GET /api/wiki/pages` 列表项（`WikiPageSummary`，`openapi.yaml:3208-3223`）只有 7 个字段**，frontmatter 的 `applies_to`/`refs`/`evidence`/`source`/`deprecated_reason` 只在单页 `content` 里（`wiki-store.js:25-28` 的 `metadata()` 不解析它们）→ 列表页做不出"适用场景/出处/引用关系"。

**E. `GET /api/agent/prompts` 只给元数据**（见 13 条）→ 前端做不出"查看当前研判提示词 / 与默认对比"。

**F. `GET /api/rules/sessions` 只有摘要，没有详情路由**（见 8 条）→ 规则维护"模型提了什么、为什么、验过没过、落在哪"读不到。

**G. `GET /api/rules/{id}/history` 没有取某版正文的路由**（见 9 条）。

**H. `GET /api/config` 没有配置来源信息**（见 11 条）→ 前端做不出"这一项是从文件覆盖来的"。

**I. `GET /api/agent/investigations/{alertId}`（`openapi.yaml:2781`）spec 未声明 `model`/`prompt_version`/`scenario_ids`/`auto_action`**（`investigation-agent.js:1091-1094` 实际写盘且返回）；**且没有 investigations 列表接口**——文件名是 `sha256(mode:alert_id)` 摘要（`investigation-store.js:8-11`），只能按 alert_id 单查，无法枚举。

**J. `GET /api/data/inventory` + `POST /api/data/cleanup` 只覆盖 7/15 类存储**（见 12 条）→ 数据管理页会漏报 27MB 的误报会话。

**K. `GET /api/agent/triage/cases` 与 `/api/agent/triage/{id}` 都不返回原始报文**，而原始报文在盘上（`01-原始告警.txt` + `input.raw`）→ 告警详情页做不出"原始报文"页签。

---

## 4. 复现命令

```bash
cd /home/trtyr/code/hids-ai-console && git rev-parse HEAD
# 队列口径（summary 不含 watermark/dedupe/windows；status 剥掉 input）
node --input-type=module -e "import {TriageMonitor} from './triage-monitor.js';
const m=new TriageMonitor({file:'/tmp/x.json'});m.records.set('a',{alert_id:'a',input:{raw:'RAW',parsed:{msgid:'m',payload:{host_ip:'1.1.1.1'}}},status:'done',steps:[]});
m.dedupe.set('f',{});m.windows.set('s',[]);m.watermark='w';
console.log(Object.keys(m.summary()));console.log(Object.keys(m.status('a')));"
# 真实载荷键名 vs 代码读的键
node -e "const d=require('fs').readFileSync(process.env.HOME+'/.local/share/hids-ai-console/triage-monitor.json','utf8');
const r=JSON.parse(d).records[0];console.log(Object.keys(r.input.parsed.payload).length,
r.input.parsed.payload.process_command_line, r.input.parsed.payload.process_cmdline?.slice(0,40));"
# 数据根实物与盘点口径差ls ~/.local/share/hids-ai-console; du -sh ~/.local/share/hids-ai-console/fp-sessions
grep -n "DATA_KINDS = " server.js
# 死接口确认
grep -rn "readRequiredEvidence\|config.overrides()\|overrides: () =>" --include=*.js . | grep -v node_modules | grep -v evidence/
```

## 5. 边界（没做的）

- 未审 `web/` 前端实现（只读了 `web/src/cases.js` 确认其字段口径与 `case_dir` 无人使用）；未跑端到端 HTTP 探针（需要配牧云/LLM 环境变量），"未暴露"结论基于路由实现逐条比对 + 运行时键探针 + 盘上实物三方一致。
- 机密类（`config-overrides.json` 原值、升级包密文）按设计不可读，未计入缺口。