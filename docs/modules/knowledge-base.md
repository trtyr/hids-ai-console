---
type: module
id: MOD-KNOWLEDGE-BASE
covers: [wiki-store.js, wiki-workbench.js, wiki-replay.js]
unit: knowledge-base
updated: 2026-11-17
---

# 判据库与维护流水线（knowledge-base）

模块名 `knowledge-base`。覆盖文件三个：`wiki-store.js`、`wiki-workbench.js`、`wiki-replay.js`（模块划分与页面归属见 [docs/modules/_breakdown.json](_breakdown.json) 的 `knowledge-base` 条目）。

这篇讲这模块对外给出什么、拿到什么、失败时是什么样。关键断言标 `文件:行号`，行号对应当前提交 `63f1379`；代码改动后请重新核对。

判据正文本身不在本篇：`wiki/` 下的 Markdown 页面由本模块读写，但页面内容归 Wiki 维护流程管——[docs/index.md](../index.md) 的「文档与代码的关系」表把判据内容列为「不属于本套文档」。

三个文件在本篇里分工明确：`wiki-store.js` 管页面与文件，`wiki-workbench.js` 管会话与人工审核，`wiki-replay.js` 管发布前回放。

## 1 模块名与职责

### 1.1 做什么

- **判据页读写**。`WikiStore` 提供目录浏览（`wiki-store.js:41`）、判据清单（`wiki-store.js:60`）、按路径读页（`wiki-store.js:75`）、按编号取页（`wiki-store.js:85`）、标题与编号检索（`wiki-store.js:91`）、一致性体检（`wiki-store.js:136`）与单页修订（`wiki-store.js:159`）。
- **发布前检查**。`checkBundle()` 对一组草案逐条核对格式、编号、状态、日期、来源与引用，返回问题清单而不是直接改（`wiki-store.js:188-230`）。
- **维护会话**。`WikiWorkbench` 把「改判据」变成多轮对话：会话以 JSON 落盘，模型每轮只产出 JSON 草案，不写库（`wiki-workbench.js:65`、`wiki-workbench.js:94`、`wiki-workbench.js:135`）。
- **发布前回放**。`runWikiReplay()` 取冻结的案件材料，分别配旧判据与草案判据各跑一遍，比较结论变化（`wiki-replay.js:79-115`）。
- **客户经验发布**。新建客户经验走独立一条路：会话产出草案，人工审核补上三态结论与复核期限后，由 `createExperience()` 落成 `customer-experience/EX-*.md`（`wiki-workbench.js:271-285`、`wiki-store.js:309-329`）。
- **判据页的批量发布**。`publishBundle()` 一次写 1 至 6 页，写前备份旧版到历史目录，写后追加一条 `log.md` 记录（`wiki-store.js:233-307`）。

### 1.2 不做什么

- **不做研判取证**。这三个文件里没有任何 RPC 或 HTTP 客户端：导入只有 `node:crypto`、`node:fs/promises`、`node:path`、`node:url`（`wiki-store.js:1-4`、`wiki-replay.js:1-3`）以及 `cloudwalker.js` 的事件类型表与 `wiki-replay.js`（`wiki-workbench.js:4-5`）。
- **不让模型直接写库**。系统提示写明「你只能提出 JSON 修订草案，不能直接写库……人工审核后才发布」（`wiki-workbench.js:176`）；真正写库发生在 `publish()` 调 `publishBundle()` / `createExperience()` 那两处（`wiki-workbench.js:285`、`wiki-workbench.js:311`）。
- **不开 HTTP 服务**。三个文件都没有监听或路由代码，对外调用由业务 API 接线，不在本模块。
- **不自动发布**。`publish()` 要求人工填审核人与审核说明，缺一直接拒绝（`wiki-workbench.js:287-290`）。
- **不重新取证**。回放报告自带说明：「同一份冻结材料分别配旧判据和草案判据；这只检验判据变化的影响，不等同于重新调用牧云取证」（`wiki-replay.js:93`）。
- **不判断结论在语义上对不对**。回放只核对模型给出的结论与摘录能否在冻结材料和判据里逐字对上（`wiki-replay.js:70-73`）。

## 2 覆盖构件

本页覆盖五个构件，逐个点名：

| 构件 | 是什么 | 定义处 |
| --- | --- | --- |
| **判据页读写** | `WikiStore`：判据目录的读、检索、体检、单页修订与批量发布 | `wiki-store.js:29` |
| **发布前检查** | `WikiStore.checkBundle()`：对草案组做格式与引用核对，返回问题清单 | `wiki-store.js:188` |
| **维护会话** | `WikiWorkbench`：多轮对话式维护，会话落盘为 JSON，产出草案等人工审核 | `wiki-workbench.js:65` |
| **发布前回放** | `runWikiReplay()`：用冻结案件材料对比旧判据与草案判据的结论变化 | `wiki-replay.js:79` |
| **客户经验发布** | `WikiWorkbench.publish()` 的新经验分支 + `WikiStore.createExperience()`：经验页落盘并写进经验目录 | `wiki-workbench.js:271-285`、`wiki-store.js:309` |

五者的关系一句话：**判据页读写**是底座（页面与文件的唯一出入口），**维护会话**在上面收集信息并产出草案，**发布前检查**卡在草案与落盘之间，**发布前回放**是发布前的最后一道人工凭据，**客户经验发布**是另一类页面（`customer-experience/EX-*.md`）的专属出口，它不走回放那一套。

注意 `customer-experience` 页在两处规则不同：单页修订 `update()` 允许它（路径正则含该目录，`wiki-store.js:8`），但发布前检查 `checkBundle()` 与批量发布 `publishBundle()` 明确拒绝它（`wiki-store.js:206`、`wiki-store.js:243`）——客户经验有自己的一条发布通道。

## 3 对外能力

三个文件合计导出 4 个符号（命令见 §10.2）：`WikiStore`（`wiki-store.js:29`）、`WikiWorkbench`（`wiki-workbench.js:65`）、`replayProposalHash`（`wiki-replay.js:15`）、`runWikiReplay`（`wiki-replay.js:79`）。

**`WikiStore` 的公开方法**（16 个）：

| 方法 | 形状 | 返回 | 定义处 |
| --- | --- | --- | --- |
| `browse()` | — | 目录下全部 `.md` 页的元数据数组，含 `deprecated` 页，按固定优先级排序 | `wiki-store.js:41` |
| `list()` | — | 符合判据页路径格式且非 `deprecated` 的页数组，按路径排序 | `wiki-store.js:60` |
| `get(filename)` | — | 一页的元数据 + 全文 `content`；页面不存在时抛 404，文案 `知识库页面不存在：<相对路径>` | `wiki-store.js:75-83` |
| `getById(id)` | — | 按编号取页；编号不合格式或查不到时返回 `null` | `wiki-store.js:85` |
| `search(query, limit=8)` | — | 编号或标题命中的页数组；关键词为空或超 100 字时返回空数组 | `wiki-store.js:91` |
| `agentIndex(eventType)` | — | 该告警类型下的可用判据目录 + 选读提示 | `wiki-store.js:98` |
| `agentPage(eventType, id)` | — | 一页判据正文（去掉 frontmatter，截 9000 字） | `wiki-store.js:108` |
| `agentContextPages(eventType)` | — | 该场景的判据正文，最多 4 页 | `wiki-store.js:117` |
| `agentSearch(eventType, keyword)` | — | 命中片段列表，最多 8 条 | `wiki-store.js:124` |
| `health()` | — | `{ checked_at, active_pages, issues[] }` | `wiki-store.js:136` |
| `update(filename, content, expectedRevision)` | — | 修订后的页 | `wiki-store.js:159` |
| `checkBundle(changes, evidence=null)` | — | 问题清单数组；空数组表示通过 | `wiki-store.js:188` |
| `publishBundle(changes, evidence, audit)` | — | 已发布页的数组 | `wiki-store.js:233` |
| `createExperience(filename, content)` | — | 新建的经验页 | `wiki-store.js:309` |
| `publishedFor(scenarioId)` | — | 该场景下未过复核期的经验记录，最多 8 条 | `wiki-store.js:331` |
| `file(filename)` | — | 拼出的磁盘路径；路径不合法时抛 400 | `wiki-store.js:32` |

**`WikiWorkbench` 的公开方法**（8 个）：

| 方法 | 形状 | 说明 | 定义处 |
| --- | --- | --- | --- |
| `create(page, feedback=null)` | — | 开一个维护会话；`page` 取 `'new-experience'` 表示新建客户经验 | `wiki-workbench.js:94` |
| `reply(id, content)` | — | 推进一轮对话，产出或更新草案 | `wiki-workbench.js:135` |
| `replay(id)` | — | 对当前草案跑发布前回放 | `wiki-workbench.js:249` |
| `publish(id, review)` | — | 人工审核后落库 | `wiki-workbench.js:265` |
| `get(id)` | — | 读会话；不存在时返回 `null` | `wiki-workbench.js:74` |
| `list()` | — | 会话摘要列表，按更新时间倒序 | `wiki-workbench.js:85` |
| `save(record)` | — | 落盘一个会话 | `wiki-workbench.js:78` |
| `file(id)` | — | 会话文件路径；ID 不是 UUID 时抛 400 | `wiki-workbench.js:70` |

会话的状态机有四个取值：`collecting`（收集信息中）、`ready_for_review`（草案可审核）、`published`（已发布）、`needs_non_wiki_fix`（问题不归判据库管）。`collecting` 既是默认值（`wiki-workbench.js:129`），也是反馈类会话诊断为 `criterion_gap` 或 `needs_info` 时的取值（`wiki-workbench.js:18`），草案生不出来时也落回它（`wiki-workbench.js:238`）。

## 4 关键路径

### 4.1 读一页判据

研判侧读判据走的是 `agentIndex()` → `agentPage()` 两步：

1. **按告警类型定分类**。`classForEvent` 把 13 个告警类型映射到 12 个判据目录（`wiki-store.js:12-17`；`suspicious_operation` 与 `command_whitelist` 都落在 `suspicious-command`）；映射不到的类型直接抛「Wiki 没有 `<类型>` 对应的判据分类」（`wiki-store.js:100`）。
2. **筛出可用判据**。只取 `status: active` 且路径在 `common/` 或本类目录下的页（`wiki-store.js:101-102`）；一页都没有时抛「Wiki 分类 `<类>` 没有可用判据」（`wiki-store.js:103`）。
3. **读正文**。`agentPage()` 在上一步的目录里找编号，找不到抛「当前场景不可读取 Wiki 判据 `<编号>`」（`wiki-store.js:111`）；读到的正文去掉 frontmatter 并截到 9000 字（`wiki-store.js:114`）。
4. **检索**。`agentSearch()` 先过一道参数检查：关键词长度不在 2 到 80 字之间直接抛「Wiki 检索词需为 2 到 80 字」（`wiki-store.js:126`）；命中片段取关键词前后各 80 / 120 字，最多 8 条（`wiki-store.js:130-133`）。

下面这条命令可以复跑这条路径（输出见 §10.2）：

```bash
node --input-type=module -e '
import { WikiStore } from "./wiki-store.js";
const wiki = new WikiStore();
const index = await wiki.agentIndex("honeypot");
console.log("分类:", index.category, "| 判据页数:", index.pages.length);
console.log("编号:", index.pages.map(page => page.id).join(", "));
try { await wiki.agentIndex("nope_type"); } catch (e) { console.log("未知类型 ->", e.message); }
'
```

运维看一致性用 `health()`：它对**生效中**的判据页逐页检查来源、失效引用与缺失证据页，并单独报告重复编号；`index.md`、`rules.md` 这类根文档不在检查范围内，因为筛选条件是路径符合判据页格式（`wiki-store.js:138-155`）。

### 4.2 维护会话：从对话到草案

一次维护是「开会话 → 多轮对话 → 出草案」三步：

1. **开会话**。`create()` 读目标页的当前版本，存下 `page_revision`（`wiki-workbench.js:125-126`、`wiki-workbench.js:129`）；会话状态为 `collecting`，首条消息是助手发的开场白（`wiki-workbench.js:130-133`）。
2. **每轮对话**。`reply()` 先做入参检查（1 到 4000 字、不含空字符，`wiki-workbench.js:136-137`）与并发检查（同会话上一轮未完时抛 409，`wiki-workbench.js:138`），再把用户这句话存进 `messages`（`wiki-workbench.js:145`）。随后模型一次调用，输入是当前页、相关证据页、相关判据页、最近 16 条用户消息（`wiki-workbench.js:177-185`）。
3. **判读模型输出**。只有 `ready === true` 且正文长度在 100 到 30000 字之间才算草案（`wiki-workbench.js:190-191`）；否则 `proposal` 保持 `null`，会话停在 `collecting`（`wiki-workbench.js:234`、`wiki-workbench.js:238`）。
4. **出草案**。草案里存着 `changes`（每项带 `path`、`content`、`rationale`、`page_revision`）、证据预览与 `rationale`（`wiki-workbench.js:234-237`）；会话状态转为 `ready_for_review`（`wiki-workbench.js:238`）。

这条路上有两个容易看错的地方：

- **模型输出里的错误不会抛出**。`reply()` 内层的校验失败会被 `catch` 住，变成一条助手消息「本轮输入已保存；自动整理暂时失败：<原因>」（`wiki-workbench.js:240-242`），会话继续停在 `collecting`。实测：反馈会话里模型没给 `diagnosis`，会话不会报错，只多出一条这样的助手消息。
- **多页草案的页面范围被限死**。允许修改的页面只有当前页与被判为「相关」的判据页（`wiki-workbench.js:209`），页数不超过 6，且必须包含当前页（`wiki-workbench.js:207-208`）。

### 4.3 发布前检查

`checkBundle(changes, evidence)` 不改任何东西，只返回问题清单（`wiki-store.js:188-230`）。它检查两类东西：

**新证据页**（传了 `evidence` 才查）：

- 路径要匹配 `_evidence/<8 到 100 位小写字母数字或连字符>.md`，正文要有 frontmatter、`id: EV-...`、`source:`、`supports: [...]`（`wiki-store.js:196-201`）。
- 路径或编号不能与既有页撞车（`wiki-store.js:202-203`）。

**每条草案变更**（`wiki-store.js:204-228`）：

| 检查项 | 判定依据 |
| --- | --- |
| 路径必须是判据页格式，且不能是 `customer-experience/` | `wiki-store.js:206` |
| 编号与路径文件名一致，且正文有明确的 `id:` 行 | `wiki-store.js:211-213` |
| 状态 ∈ `active` / `draft` / `deprecated` | `wiki-store.js:214` |
| 有 `evidence: [...]` 或 `source:` 之一 | `wiki-store.js:215-216` |
| `title`、`applies_to`、`status`、`updated` 四个字段都有非空值 | `wiki-store.js:217-218` |
| `updated` 是 `YYYY-MM-DD` | `wiki-store.js:219` |
| `refs:` 里的编号在全库存在 | `wiki-store.js:220-221` |
| `evidence:` 里的路径格式合法且指向存在的证据页 | `wiki-store.js:222-226` |
| 标为 `deprecated` 时必须写 `deprecated_reason:` | `wiki-store.js:227-228` |

另外还会报一条全库级的「判据编号重复 N 次」（`wiki-store.js:193-195`）。

两处调用它：`reply()` 出草案时先查一遍，不通过就把前 3 条拼成错误抛在内部（`wiki-workbench.js:222-223`）；`publishBundle()` 落盘前再查一遍，不通过抛 400 并带上前 5 条（`wiki-store.js:240-241`）。

实测（命令与输出见 §10.2）：拿一页真实判据改坏三个字段，检查结果精确指出「状态无效」「缺少 title」「更新日期无效」三项。

### 4.4 发布前回放

回放回答的是「换了判据之后，同一份案件材料的结论会不会变」。它比的不是新旧结论谁对，而是变化本身（`wiki-replay.js:103-107`）。

1. **前置条件**。会话状态必须是 `ready_for_review` 且草案里有变更，否则抛 409「当前没有可回放的判据草案」（`wiki-workbench.js:254-255`）。
2. **版本对账**。每条变更的 `page_revision` 要与当前页的 revision 一致，否则抛 409「判据 `<编号>` 已更新，请重新整理草案」（`wiki-replay.js:83-87`）。
3. **选样本**。`loadCases()` 扫会话目录，取文件名是 UUID 的 `.json` 会话中 `status === 'published'` 且带审核人与反馈的那些（`wiki-replay.js:23-26`），按审核时间倒序（`wiki-replay.js:27`），再加上当前会话自己的反馈（标「待审核反馈」）与别的已发布会话（标「已审核反馈」）（`wiki-replay.js:28-29`）。
4. **样本过滤**。预期结论必须是三态之一、`case_id` 不重复、原始告警与研判事实都不为空、该事件类型能算出判据目录，且目录里至少有一页在本次变更清单里（`wiki-replay.js:33-38`）。最多取 5 条，并记下 `eligible` 与 `omitted`（`wiki-replay.js:45`）。
5. **两遍对照**。同一条样本分别用旧判据（空 candidate）和草案判据（变更内容）组装上下文，两次模型调用并发（`wiki-replay.js:96-102`）；上下文里 `deprecated` 的页被剔除，每页截 15000 字（`wiki-replay.js:53-54`）。
6. **摘录校验**。模型必须给出 `basis_quote`（逐字出现在冻结材料里）与 `criterion_quote`（逐字出现在某页判据里），两段长度都不少于 4 字，否则本条判为错误「模型结论缺少可在冻结材料和判据中逐字核对的摘录」（`wiki-replay.js:70-73`）。
7. **逐条定性**（`wiki-replay.js:103-107`）：

| 取值 | 含义 |
| --- | --- |
| `invalid` | 任一侧出错（模型没返回合规结论或调用失败） |
| `regression` | 已审核反馈的样本，旧判据命中预期、新判据没命中 |
| `improved` | 新判据命中预期，且与旧判据结论不同 |
| `matched` | 新判据命中预期，且与旧判据结论相同 |
| `mismatch` | 新判据没命中预期 |

8. **汇总**。只要有一条落在 `invalid`、`regression`、`mismatch` 里，报告状态就是 `needs_review`；否则是 `passed`（`wiki-replay.js:113-114`）。没有可用样本时报告状态是 `no_cases`（`wiki-replay.js:90`、`wiki-replay.js:94`）。

发布时对回放报告有硬要求（`wiki-workbench.js:294-304`）：报告必须存在且 `proposal_hash` 与当前变更一致（否则 409「发布前请先回放当前判据草案」）；`prompt_revision` 要与当前提示词版本一致（否则 409「研判提示词版本已变化，请重新回放」）；`no_cases` 要求显式确认 `replay_no_cases_ack === true`（否则 400）；`needs_review` 要求写至少 20 字的人工复核理由（否则 400）。

### 4.5 判据页落库

`publishBundle(changes, evidence, audit)` 是判据页唯一的批量发布通道（`wiki-store.js:233-307`）：

1. **入参把关**。变更 1 至 6 条，审核人姓名去空白后不少于 2 个字，否则抛 400「维护发布需要 1 至 6 条判据修订及审核人」（`wiki-store.js:235-237`）。
2. **先检查再写**。`checkBundle()` 有任何一条问题就停在这里，错误消息带前 5 条（`wiki-store.js:240-241`）。
3. **逐页对账**。路径合法、不重复、不属于 `customer-experience/`（`wiki-store.js:243-245`）；`page_revision` 与当前页一致，否则 409「判据 `<编号>` 已更新，请重新整理草案」（`wiki-store.js:247-248`）；正文 100 到 30000 字且不含空字符（`wiki-store.js:250-251`）；编号、状态、`title`、`updated`、`applies_to`、来源都要齐（`wiki-store.js:253-257`）。
4. **证据页约束**。格式不合法抛 400「反馈证据页格式无效」（`wiki-store.js:261-265`）；每一条被发布的判据正文都必须引用这个证据页，否则 400「判据 `<编号>` 未引用本次反馈证据」（`wiki-store.js:266-267`）；证据页不得已存在，否则 409「反馈证据页已存在」（`wiki-store.js:268-270`）。
5. **写入顺序**。先备份旧版到历史目录（`wiki-store.js:274-280`），再写证据页（`wiki-store.js:281-284`），再逐页「临时文件 + rename」原子替换（`wiki-store.js:285-291`），最后追一条 `log.md`（`wiki-store.js:292-293`）。`log.md` 那条记录包含审核人、反馈案件号、证据页路径、回放状态与样本数、审核要点（截 500 字）。
6. **失败回滚**。中途出错时，把已经写过的页改回旧内容，并删掉刚写的证据页，然后重抛（`wiki-store.js:294-302`）。

同一时刻只允许一次写：`WikiStore` 的三个写方法 `update()`、`publishBundle()`、`createExperience()` 都挂在同一条 `pending` promise 链上（`wiki-store.js:30`、`wiki-store.js:160`、`wiki-store.js:234`、`wiki-store.js:310`、`wiki-store.js:184`、`wiki-store.js:305`、`wiki-store.js:327`）。

### 4.6 客户经验发布

客户经验走另一条通道，不经回放：

1. **开会话**。`create('new-experience')` 生成文件名 `customer-experience/EX-<时间戳><随机数>.md`，正文是一份 `status: draft` 的模板（`wiki-workbench.js:124-126`、`wiki-workbench.js:57`）。
2. **草案校验**。模板里的 JSON 块要写满九项字段（`record_ref`、`customer_scope`、`subject_scope`、`behavior`、`reason`、`supporting_evidence`、`applicability`、`counterexample`、`validity`，见 `wiki-workbench.js:13-14`）；`id` 要等于文件名、`scenario_id` 要落在已知事件类型里、每项字段的 `source_quote` 都要逐字出现在用户发过的消息里，缺一项就拒绝（`wiki-workbench.js:198-201`）。
3. **人工审核**。审核人要选三态结论之一、填一个未来 366 天以内的复核截止日（按 `+08:00` 时区解析）、写至少 5 字的审核说明，缺一抛 400「请选择三态结论、未来一年内的复核日期，并填写至少 5 字审核说明」（`wiki-workbench.js:274-279`）。
4. **落盘**。审核结果写进 JSON 块的 `review` 字段，块内状态置 `published`，frontmatter 的 `status: draft` 改成 `status: active`（`wiki-workbench.js:280-284`），然后交给 `createExperience()`（`wiki-workbench.js:285`）。
5. **`createExperience()` 的校验**。路径要匹配 `customer-experience/EX-<数字>.md`，编号要等于文件名，状态要已经是 `active`，要有 `source:`，正文不超过 30000 字，缺一抛 400「客户经验缺少有效编号、发布状态或来源」（`wiki-store.js:311-316`）。
6. **目录与日志**。`customer-experience/index.md` 不存在则建，然后追一行 `- [<编号>](<文件名>) · <标题>`（`wiki-store.js:319-322`）；`log.md` 追加一条 `ingest` 记录（`wiki-store.js:323-324`）。
7. **复用**。`publishedFor(scenarioId)` 取 `customer-experience/` 下 `status: active` 的页，解析页内 JSON 块，筛出 `scenario_id` 匹配、有 `review`、且 `expires_at` 晚于当前时刻的记录，最多 8 条（`wiki-store.js:331-340`）。它不校验 `review.verdict` 的取值——只按场景与复核期限过滤（`wiki-store.js:339`）。

## 5 值语义

### 5.1 入参

**`WikiStore`**

| 参数 | 出现在 | 含义 | 合法域 | 违反时 | 依据 |
| --- | --- | --- | --- | --- | --- |
| `directory` | 构造 | 判据库目录 | 存在的目录 | 后续读写抛文件错误 | `wiki-store.js:30`；缺省取 `HIDS_WIKI_DIR`，再缺省为仓内 `wiki/`（`wiki-store.js:6`） |
| `filename` | `get` / `update` | 页面路径 | 两段式 `<目录>/<文件名>.md`（目录在 16 个约定目录内）或根文档 `index.md`/`rules.md`/`log.md`/`_schema.md` | 抛 400「知识库页面路径无效」；路径合法但文件不存在抛 404「知识库页面不存在：`<相对路径>`」 | `wiki-store.js:32-38`、`wiki-store.js:75-83` |
| `expectedRevision` | `update` | 期望的当前版本指纹 | 必须等于当前页的 `revision` | 抛 409「知识库页面已更新，请刷新后再提交」 | `wiki-store.js:163` |
| `content` | `update` | 新正文 | 1 到 30000 字，不含空字符 | 抛 400「页面正文必须为 1 到 30000 字」 | `wiki-store.js:164-165` |
| `changes[].path` | `checkBundle` / `publishBundle` | 被修订页的路径 | 判据页格式，且不是 `customer-experience/` | 检查阶段报「无效的判据路径」 | `wiki-store.js:206`、`wiki-store.js:243` |
| `changes[].content` | 同上 | 新正文 | `publishBundle` 下 100 到 30000 字 | 抛 400「判据 `<编号>` 正文无效」 | `wiki-store.js:250-251` |
| `changes[].page_revision` | 同上 | 起草时的页版本指纹 | 必须等于当前页 `revision` | 抛 409「判据 `<编号>` 已更新，请重新整理草案」 | `wiki-store.js:247-248` |
| `audit.reviewer` | `publishBundle` | 审核人姓名 | 去空白后至少 2 字 | 抛 400「维护发布需要 1 至 6 条判据修订及审核人」 | `wiki-store.js:236-237` |
| `evidence.path` | `publishBundle` | 新证据页路径 | `_evidence/<8 到 100 位小写字母数字或连字符>.md` | 抛 400「反馈证据页格式无效」 | `wiki-store.js:261` |
| `evidence.content` | 同上 | 新证据页正文 | 不超过 12000 字，含 `id: EV-...` 与 `source:` | 同上 | `wiki-store.js:262-264` |
| `scenarioId` | `publishedFor` | 告警场景标识 | 场景标识字符串；匹配不上就返回空数组 | 不抛错 | `wiki-store.js:331` |

**`WikiWorkbench`**

| 参数 | 出现在 | 含义 | 合法域 | 违反时 | 依据 |
| --- | --- | --- | --- | --- | --- |
| `wiki` / `model` / `prompts` / `directory` | 构造 | 判据库、模型、提示词仓、会话目录 | —— | —— | `wiki-workbench.js:66-69` |
| `page` | `create` | 要维护的页路径，或 `'new-experience'` | 存在的页路径，或字符串 `'new-experience'` | 读页时抛文件错误 | `wiki-workbench.js:95`、`wiki-workbench.js:126` |
| `feedback.case_id` / `case_dir` / `event_type` | `create` | 反馈对应的案件 | 三者都要有 | 抛 400「反馈需要案件、预期结论、至少 10 字理由和反馈人」 | `wiki-workbench.js:97-101` |
| `feedback.expected_verdict` | 同上 | 人工预期的结论 | `threat` / `uncertain` / `false_positive` | 同上 | `wiki-workbench.js:16`、`wiki-workbench.js:98` |
| `feedback.reason` | 同上 | 人工理由 | 10 到 4000 字 | 同上 | `wiki-workbench.js:99` |
| `feedback.who` | 同上 | 反馈人 | 2 到 100 字 | 同上 | `wiki-workbench.js:100` |
| `content` | `reply` | 本轮用户输入 | 1 到 4000 字，不含空字符 | 抛 400「输入必须为 1 到 4000 字」 | `wiki-workbench.js:136-137` |
| `id` | `reply` / `replay` / `publish` | 会话标识 | UUID 形式 | 抛 400「知识维护会话 ID 无效」 | `wiki-workbench.js:7`、`wiki-workbench.js:71` |
| `review.reviewer` / `review.note` | `publish` | 判据页发布的审核人与说明 | 审核人 2 到 100 字，说明 10 到 500 字 | 抛 400「请填写审核人和至少 10 字审核说明」 | `wiki-workbench.js:287-290` |
| `review.verdict` / `review.valid_until` / `review.note` | `publish` | 客户经验发布的审核三件套 | 结论三选一；日期 `YYYY-MM-DD` 且落在未来 366 天内；说明 5 到 500 字 | 抛 400「请选择三态结论、未来一年内的复核日期，并填写至少 5 字审核说明」 | `wiki-workbench.js:274-279` |
| `review.replay_no_cases_ack` | `publish` | 回放无样本时的确认 | 必须是 `true` | 抛 400「没有可用的已保存案件；请确认样本覆盖缺口」 | `wiki-workbench.js:298-299` |
| `review.replay_override_reason` | `publish` | 回放需人工复核时的理由 | 至少 20 字 | 抛 400「回放存在结论不符、退化或无效结果；须说明至少 20 字的人工复核理由」 | `wiki-workbench.js:300-302` |
| `review.source_verified` | `publish` | 外部原文已核查的确认 | 外部证据时必须是 `true` | 抛 400「请先核查新证据原文、摘录及适用边界，再确认来源已核查」 | `wiki-workbench.js:306-307` |

### 5.2 返回值

**页面元数据**（`metadata()`，`wiki-store.js:20-27`）：`path`、`id`（缺 `id:` 字段时取文件名）、`title`（缺 `title:` 时取正文首个一级标题，再缺取文件名）、`status`（缺 `status:` 时为 `reference`）、`updated`、`revision`（页面源文件全文的 SHA-256 前 16 位，含 frontmatter 围栏与字段行）、`characters`（页面源文件全文的字符数，含 frontmatter）。两个值都由 `hash(source)` / `source.length` 算出，入参是整份页面文本而非去掉 frontmatter 的正文（`wiki-store.js:26`）。

**体检结果**（`health()`，`wiki-store.js:156`）：`checked_at`（ISO 时间戳）、`active_pages`（生效中判据页数）、`issues`（数组，每条含 `path`、`kind`、`message`；`kind` 取 `duplicate_id`、`missing_source`、`broken_ref`、`missing_evidence`，见 `wiki-store.js:146`、`wiki-store.js:150`、`wiki-store.js:152`、`wiki-store.js:154`）。

**会话记录**（`WikiWorkbench` 落盘的 JSON，`wiki-workbench.js:128-133`）：`id`、`page`、`new_experience`、`feedback`、`template`、`page_revision`、`status`、`created_at`、`updated_at`、`messages[]`；多轮之后追加 `diagnosis`、`diagnosis_note`、`follow_up`、`proposal`（`wiki-workbench.js:228-237`），发布之后追加 `published_pages`、`audit`（`wiki-workbench.js:315-319`）。`list()` 只暴露其中一部分字段：`id`、`page`、`updated_at`、`status`、`message_count`（`wiki-workbench.js:92`）。

**草案**（`record.proposal`，`wiki-workbench.js:234-237`）：`content`（当前页的新正文）、`changes[]`（每项 `path`、`content`、`rationale`、`page_revision`）、`evidence_preview`、`rationale`、`page_revision`、`replay`（回放报告，初始为 `null`）。

**回放报告**（`wiki-replay.js:90-93`）：`status`、`at`、`proposal_hash`、`prompt_revision`、`model`、`corpus`（`eligible` / `selected` / `omitted`）、`cases[]`、`explanation`。每条样本含 `case_id`、`event_type`、`label_kind`、`expected_verdict`、`original_verdict`、`input_sha256`、`before`、`after`、`changed`、`status`（`wiki-replay.js:108-111`）；`before` / `after` 是模型结论（`verdict`、`verdict_label`、`basis_quote`、`criterion_quote`、`reason`、`missing_data`）或 `{ error }`（`wiki-replay.js:74-76`）。

## 6 依赖

| 方向 | 对象 | 说明 | 依据 |
| --- | --- | --- | --- |
| 下游 | 判据库目录 | `HIDS_WIKI_DIR`，缺省为仓内 `wiki/` | `wiki-store.js:6` |
| 下游 | 判据库里的 `_schema.md` | 工作台每轮把它当「Wiki 操作手册」读进系统提示，截 14000 字 | `wiki-workbench.js:152`、`wiki-workbench.js:176` |
| 下游 | 提示词仓 `prompts.load()` | 维护轮取 `knowledge` 提示；回放轮取 `triage` 提示、`sop.common`、场景卡；发布时比对提示词版本 | `wiki-workbench.js:152`、`wiki-workbench.js:176`、`wiki-replay.js:89`、`wiki-workbench.js:296` |
| 下游 | 模型服务 `model.complete()` | 两处调用：维护会话一轮一次；回放每条样本两次。两处的工具参数都是空数组，第三参都是 `'none'` | `wiki-workbench.js:175`、`wiki-replay.js:64` |
| 下游 | 事件类型表 `eventTypes` | 校验客户经验的 `scenario_id` 是不是已知场景 | `wiki-workbench.js:4`、`wiki-workbench.js:198` |
| 下游 | 维护会话目录 | 会话 JSON 落在这里；回放时又把它当样本库扫 | `wiki-workbench.js:79-82`、`wiki-replay.js:21` |
| 下游 | 历史版本目录 | `<判据库目录的上一级>/.data/wiki-history/`，存每次修订前的旧版 | `wiki-store.js:171`、`wiki-store.js:275` |
| 外部库 | `node:crypto` | `createHash`（三个文件都用）与 `randomUUID`（只有前两个文件用） | `wiki-store.js:1`、`wiki-workbench.js:1`、`wiki-replay.js:5` |
| 外部库 | `node:fs/promises` | 读写文件、建目录、改名、追加日志 | `wiki-store.js:2`、`wiki-workbench.js:2`、`wiki-replay.js:2` |
| 外部库 | `node:path` / `node:url` | 拼路径、定位模块所在目录 | `wiki-store.js:3-4`、`wiki-replay.js:3` |
| 上游 | 研判智能体 | 读判据的四个方法（`agentIndex` / `agentPage` / `agentContextPages` / `agentSearch`），属 investigation-agent 模块，本页不展开 | `wiki-store.js:98`、`wiki-store.js:108`、`wiki-store.js:117`、`wiki-store.js:124` |

## 7 数据归属

| 数据 | 放在哪 | 生命周期 | 依据 |
| --- | --- | --- | --- |
| 判据页 Markdown | 判据库目录下 | 长期；人工与工作台共同维护 | `wiki-store.js:6` |
| 页面历史版本 | `<判据库目录的上一级>/.data/wiki-history/<编号>-<revision>.md` | 长期保留，不清理 | `wiki-store.js:171-174`、`wiki-store.js:277-279` |
| 变更日志 `log.md` | 判据库目录根 | 追加写，一条变更一段 | `wiki-store.js:180-181`、`wiki-store.js:292-293`、`wiki-store.js:323-324` |
| 证据页 | 判据库目录下的 `_evidence/` | 随引用它的判据页长期存在 | `wiki-workbench.js:37`、`wiki-workbench.js:51` |
| 客户经验目录页 | 判据库目录下的 `customer-experience/index.md` | 追加写，一页一行 | `wiki-store.js:319-322` |
| 维护会话 | 会话目录下 `<UUID>.json` | 长期；发布后成为回放样本 | `wiki-workbench.js:70-72`、`wiki-workbench.js:78-83` |
| 案件材料快照 | 会话 JSON 内的 `feedback.case_snapshot` | 随会话；四个固定文件各截 12000 字 | `wiki-workbench.js:102`、`wiki-workbench.js:110`、`wiki-workbench.js:119` |
| 回放报告 | 会话 JSON 内的 `proposal.replay` | 随会话 | `wiki-workbench.js:258` |
| 客户经验记录 | 经验页正文里的 JSON 块 | 随页；过期后不再被复用 | `wiki-store.js:335-337`、`wiki-store.js:339-340` |

### 7.1 页面结构（WikiPage）

`GET /api/wiki/pages/{pagePath}` 返回一页；`GET /api/wiki/pages` 返回同一组元数据但没有 `content`。
`openapi.yaml` 里分别是 `WikiPage` 与 `WikiPageSummary`，字段按这张表：

| 字段 | 类型 | 必填 | 含义 | 依据 |
| --- | --- | --- | --- | --- |
| `path` | string | 是 | 相对判据库根目录的路径，如 `common/GEN-12.md` | `wiki-store.js:24` |
| `id` | string | 是 | frontmatter 的 `id:`；缺省取文件名 | `wiki-store.js:24` |
| `title` | string | 是 | frontmatter 的 `title:`（去首尾引号）；缺省取一级标题，再缺取文件名 | `wiki-store.js:23-25` |
| `status` | 枚举，见下 | 是 | frontmatter 的 `status:`；缺这个字段时读作 `reference` | `wiki-store.js:25` |
| `updated` | string | 是 | frontmatter 的 `updated:`（`YYYY-MM-DD`）；缺省是**空串**，不是 null | `wiki-store.js:25` |
| `revision` | string | 是 | 正文全文的 SHA-256 前 16 位十六进制 | `wiki-store.js:18`、`wiki-store.js:26` |
| `characters` | integer | 是 | 正文全文（含 frontmatter）的 JS 字符串 `length`：按 UTF-16 码元计，一个汉字算 1，一个基本平面外字符算 2 | `wiki-store.js:26` |
| `content` | string | 只在 `WikiPage` | 含 frontmatter 的完整 Markdown 正文 | `wiki-store.js:82` |

`status` 四个取值（枚举）：

| 取值 | 含义 | 依据 |
| --- | --- | --- |
| `active` | 生效的判据；智能体只读这一类（`agentIndex` 只取 active） | `wiki-store.js:101`、`wiki-store.js:167` |
| `draft` | 草案，不进智能体目录 | `wiki-store.js:167` |
| `deprecated` | 作废；`list()` 直接过滤掉，但 `browse()` 仍列出 | `wiki-store.js:70`、`wiki-store.js:167`、`wiki-store.js:214` |
| `reference` | 不是 frontmatter 能写的值，而是**缺 `status:` 时的读时默认值** | `wiki-store.js:25` |

写入面（`PUT /api/wiki/pages/{pagePath}` 与发布流程）只接受前三个：状态不在 `active` / `draft` / `deprecated` 里就抛 400
（`wiki-store.js:167`、`wiki-store.js:214`、`wiki-store.js:253`）。

### 7.2 列表分页（`GET /api/wiki/pages`）

列表走 `browse()`（一次读全部页的元数据，含 `deprecated`），分页在 HTTP 层做（`server.js:322-333`）：

| 参数 | 缺省 | 合法域 | 违反时 | 依据 |
| --- | --- | --- | --- | --- |
| `q` | 无 | 任意字符串，匹配 `id` / `title` / `path`（小写包含） | ——（无匹配就回空数组） | `server.js:329-332` |
| `count` | **不切页，返回全部** | 1 到 50 的安全整数 | 400「分页参数无效」 | `server.js:324-328` |
| `offset` | 0 | 大于等于 0 的安全整数 | 400「分页参数无效」 | `server.js:326-328` |

响应固定是 `{ pages, total }`：`total` 是切页前的条数，带 `q` 时是过滤后（且被 50 条上限截断后）的条数。顺序是「过滤 → 切页」，所以 `total` 与页内条数能对上。
`count` 缺省不切页是为了向后兼容：控制台知识库页现在一次取全量，默认 20 会让它静默少显示（D002 只加不改）。

## 8 不变量

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-KB-01` | 修订判据页时页的编号不得变 | 提交一份改了 `id:` 的正文 | `wiki-store.js:167` | 抛 400「页面 ID 必须保持一致，状态须为 active、draft 或 deprecated」 |
| `R-KB-02` | 判据页状态只能是 `active` / `draft` / `deprecated` | 状态写成别的 | `wiki-store.js:167`、`wiki-store.js:214` | 抛 400 或报「状态无效」 |
| `R-KB-03` | 判据页要有 `evidence:` 或 `source:` 之一 | 两个都没有 | `wiki-store.js:169-170` | 抛 400「判据需要 evidence 或 source 出处」 |
| `R-KB-04` | 单页修订靠版本指纹防覆盖 | 用旧 `expectedRevision` 提交 | `wiki-store.js:163` | 抛 409「知识库页面已更新，请刷新后再提交」，不写盘 |
| `R-KB-05` | 批量发布一次 1 至 6 页，且路径不重复 | 传 7 条或两条同路径 | `wiki-store.js:235`、`wiki-store.js:243-245` | 抛 400 |
| `R-KB-06` | 判据页发布前必须先回放，且回放对应同一份草案 | 直接发布或草案改过 | `wiki-workbench.js:294-295` | 抛 409「发布前请先回放当前判据草案」 |
| `R-KB-07` | 发布时的提示词版本要与回放时一致 | 回放后提示词升级了 | `wiki-workbench.js:296-297` | 抛 409「研判提示词版本已变化，请重新回放」 |
| `R-KB-08` | 回放结论的两段摘录要逐字出现在冻结材料与判据里 | 模型编一段不在输入里的原文 | `wiki-replay.js:70-73` | 该条判为 `invalid`，报告状态转 `needs_review` |
| `R-KB-09` | 客户经验九项字段的 `source_quote` 要逐字出现在用户发过的消息里 | 字段里写了一段没说过的话 | `wiki-workbench.js:199-200` | 抛 400「客户经验尚缺告警场景、九项字段或原话出处，请继续补充」 |
| `R-KB-10` | 客户经验的复核期限在一年以内，过期后不再复用 | 填一个两年后的日期，或期限已过 | `wiki-workbench.js:277`、`wiki-store.js:339-340` | 抛 400；过期后 `publishedFor()` 不再返回它 |
| `R-KB-11` | 判据库的写操作串行执行，不并发 | 同时发起两次修订 | `wiki-store.js:30`、`wiki-store.js:160`、`wiki-store.js:184` | 后一条排队等前一条完成 |
| `R-KB-12` | 批量发布中途失败要回滚到旧内容 | 写第二页时出错 | `wiki-store.js:294-302` | 已写页改回旧内容，证据页被删 |
| `R-KB-13` | 模型只能产出草案，不能直接写库 | 模型想直接改文件 | `wiki-workbench.js:176` | 写库只发生在 `publish()` 里 |
| `R-KB-14` | 一个会话最多 80 条消息 | 第 81 条 | `wiki-workbench.js:142` | 抛 400「会话已达到上限，请新建会话」 |

## 9 失败面

### 9.1 错误文案

**`wiki-store.js`**

| 场景 | 文案 | status | 依据 |
| --- | --- | --- | --- |
| 页面路径不合法 | 知识库页面路径无效 | 400 | `wiki-store.js:37` |
| 页面不存在（`get`，以及经 `get` 读旧版的 `update`） | 知识库页面不存在：`<相对路径>` | 404 | `wiki-store.js:75-83` |
| 修订的路径不是判据页 | 只允许修订判据页和客户经验页 | 400 | `wiki-store.js:161` |
| 版本指纹对不上 | 知识库页面已更新，请刷新后再提交 | 409 | `wiki-store.js:163` |
| 正文超长或含空字符 | 页面正文必须为 1 到 30000 字 | 400 | `wiki-store.js:164-165` |
| 编号变了或状态非法 | 页面 ID 必须保持一致，状态须为 active、draft 或 deprecated | 400 | `wiki-store.js:167-168` |
| 缺来源 | 判据需要 evidence 或 source 出处 | 400 | `wiki-store.js:169-170` |
| 发布参数不合规 | 维护发布需要 1 至 6 条判据修订及审核人 | 400 | `wiki-store.js:237` |
| 发布前检查不通过 | 维护草案未通过检查：<前 5 条问题> | 400 | `wiki-store.js:241` |
| 路径重复或非法 | 维护草案包含重复或无效的判据路径 | 400 | `wiki-store.js:244` |
| 页版本对不上 | 判据 `<编号>` 已更新，请重新整理草案 | 409 | `wiki-store.js:248` |
| 正文不合规 | 判据 `<编号>` 正文无效 | 400 | `wiki-store.js:251` |
| 元数据缺项 | 判据 `<编号>` 缺少编号、适用范围、状态、日期或来源 | 400 | `wiki-store.js:257` |
| 证据页格式不合规 | 反馈证据页格式无效 | 400 | `wiki-store.js:265` |
| 判据没引用本次证据 | 判据 `<编号>` 未引用本次反馈证据 | 400 | `wiki-store.js:267` |
| 证据页已存在 | 反馈证据页已存在 | 409 | `wiki-store.js:269` |
| 经验页路径不合规 | 客户经验页面路径无效 | 400 | `wiki-store.js:312` |
| 经验页缺编号、状态或来源 | 客户经验缺少有效编号、发布状态或来源 | 400 | `wiki-store.js:316` |
| 告警类型没有对应分类 | Wiki 没有 `<类型>` 对应的判据分类 | 无 | `wiki-store.js:100` |
| 分类下没有可用判据 | Wiki 分类 `<类>` 没有可用判据 | 无 | `wiki-store.js:103` |
| 编号不在当前场景目录里 | 当前场景不可读取 Wiki 判据 `<编号>` | 无 | `wiki-store.js:111` |
| 检索词长度不合法 | Wiki 检索词需为 2 到 80 字 | 无 | `wiki-store.js:126` |

**`wiki-workbench.js`**

| 场景 | 文案 | status | 依据 |
| --- | --- | --- | --- |
| 输入不是 1 到 4000 字 | 输入必须为 1 到 4000 字 | 400 | `wiki-workbench.js:137` |
| 同一会话上一轮未完 | 上一轮知识整理仍在进行 | 409 | `wiki-workbench.js:138` |
| 会话不存在 | 知识维护会话不存在 | 404 | `wiki-workbench.js:141`、`wiki-workbench.js:253` |
| 消息已达 80 条 | 会话已达到上限，请新建会话 | 400 | `wiki-workbench.js:142` |
| 模型未配置 | 知识维护模型尚未配置 | 无 | `wiki-workbench.js:149` |
| 反馈参数不全 | 反馈需要案件、预期结论、至少 10 字理由和反馈人 | 400 | `wiki-workbench.js:101` |
| 案件材料缺件 | 案件缺少原始告警或研判事实，无法建立反馈 | 400 | `wiki-workbench.js:116` |
| 模型没返回 JSON 对象 | 知识维护模型未返回 JSON 对象 | 无 | `wiki-workbench.js:10` |
| 反馈会话没定诊断 | 案件反馈必须先区分判据、数据、提示词、来源或个案问题 | 无 | `wiki-workbench.js:193` |
| 多页草案超 6 页或漏当前页 | 多页草案必须包含当前判据且不超过 6 页 | 无 | `wiki-workbench.js:208` |
| 多页草案越界或重复 | 多页草案包含重复页面或超出当前场景 | 无 | `wiki-workbench.js:213` |
| 草案没过检查 | 草案未通过发布前检查：<前 3 条问题> | 无 | `wiki-workbench.js:223` |
| 外部证据不合规 | 新证据须包含 HTTPS 原文、标题、核查日期、客户提供的原文片段、支持命题和适用边界 | 无 | `wiki-workbench.js:36` |
| 外部证据缺 URL | 新证据缺少可核查的原文 URL | 无 | `wiki-workbench.js:30` |
| 经验页缺 JSON 块 | 客户经验草案缺少 JSON 结构 | 400 | `wiki-workbench.js:60` |
| 经验页 JSON 块解析失败 | 客户经验 JSON 结构无效 | 400 | `wiki-workbench.js:62` |
| 经验九项字段不全 | 客户经验尚缺告警场景、九项字段或原话出处，请继续补充 | 400 | `wiki-workbench.js:201` |
| 没有可回放的草案 | 当前没有可回放的判据草案 | 409 | `wiki-workbench.js:255` |
| 同一会话有操作在跑 | 知识维护操作仍在进行 | 409 | `wiki-workbench.js:250` |
| 没有可审核的草案 | 当前没有可审核的修订草案 | 409 | `wiki-workbench.js:269` |
| 整理仍在进行 | 知识整理仍在进行 | 409 | `wiki-workbench.js:266` |
| 审核人或说明不合规 | 请填写审核人和至少 10 字审核说明 | 400 | `wiki-workbench.js:290` |
| 没回放就发布 | 发布前请先回放当前判据草案 | 409 | `wiki-workbench.js:295` |
| 提示词版本变了 | 研判提示词版本已变化，请重新回放 | 409 | `wiki-workbench.js:297` |
| 无样本且未确认 | 没有可用的已保存案件；请确认样本覆盖缺口 | 400 | `wiki-workbench.js:299` |
| 回放需复核但没写理由 | 回放存在结论不符、退化或无效结果；须说明至少 20 字的人工复核理由 | 400 | `wiki-workbench.js:302` |
| 回放状态非法 | 回放状态无效，请重新回放 | 409 | `wiki-workbench.js:304` |
| 外部证据没核查 | 请先核查新证据原文、摘录及适用边界，再确认来源已核查 | 400 | `wiki-workbench.js:307` |
| 经验审核三件套不齐 | 请选择三态结论、未来一年内的复核日期，并填写至少 5 字审核说明 | 400 | `wiki-workbench.js:279` |
| 本轮内部整理失败 | 本轮输入已保存；自动整理暂时失败：<原因> | 不抛出，转成助手消息 | `wiki-workbench.js:241` |

**`wiki-replay.js`**

| 场景 | 文案 | 形态 | 依据 |
| --- | --- | --- | --- |
| 没有草案 | 当前没有可回放的判据草案 | 抛出 | `wiki-replay.js:80` |
| 页版本对不上 | 判据 `<编号>` 已更新，请重新整理草案 | 抛出（409） | `wiki-replay.js:86` |
| 模型未配置 | 知识回放模型尚未配置 | 抛出 | `wiki-replay.js:95` |
| 摘录核不上 | 模型结论缺少可在冻结材料和判据中逐字核对的摘录 | 写进 `before.error` / `after.error` | `wiki-replay.js:72`、`wiki-replay.js:76` |

### 9.2 失败之后的状态

| 失败模式 | 失败后的状态 | 能否重试 | 降级 |
| --- | --- | --- | --- |
| 页面路径不合法（读） | 不读任何文件 | 改正路径后可重试 | 无 |
| 单页修订被拒（参数类） | 正文未换，历史目录也不新增备份（备份在全部校验之后才写） | 改正后可重试 | 无 |
| 单页修订版本冲突 | 正文未换，历史目录无新增备份 | 重新读页拿新 `revision` 后可重试 | 无 |
| 批量发布中途失败 | 已写的页回滚成旧内容，新写的证据页被删；历史目录里留下本次的旧版备份 | 重新整理草案后可重试 | 无 |
| 草案没过检查 | 会话停在 `collecting`，`proposal` 为 `null` | 补齐证据与字段后重新对话 | 无 |
| 模型输出不合规 | 会话停在 `collecting`，多一条助手消息说明原因 | 重新对话即可 | 无 |
| 回放样本为空 | 报告状态 `no_cases`；发布时需要显式确认 | 补样本后重新回放 | 无 |
| 回放出现 `invalid` / `regression` / `mismatch` | 报告状态 `needs_review`；发布时需要至少 20 字人工理由 | 改判据后重新回放 | 无 |
| 回放时模型调用失败 | 该条样本判为 `invalid`，报告 `needs_review` | 模型恢复后重新回放 | 无 |
| 回放时未配置模型 | 抛「知识回放模型尚未配置」，不产出报告 | 配置模型后重新回放 | 无 |
| 外部证据不合规 | 草案不成立，会话停在 `collecting` | 补齐原文信息后重新对话 | 无 |
| 客户经验字段不全 | 草案不成立，会话停在 `collecting` | 补齐九项字段后重新对话 | 无 |

## 10 资源与余量

### 10.1 边界值

| 项 | 数值 | 依据 |
| --- | --- | --- |
| 单页修订正文字数 | 1 到 30000 | `wiki-store.js:164` |
| 批量发布正文字数 | 100 到 30000 | `wiki-store.js:250` |
| 批量发布页数 | 1 到 6 | `wiki-store.js:235` |
| 新证据页正文字数 | 不超过 12000 | `wiki-store.js:262` |
| 新证据页路径长度 | 8 到 100 位小写字母数字或连字符 | `wiki-store.js:261` |
| 检查问题的展示条数 | 发布时 5 条、对话时 3 条 | `wiki-store.js:241`、`wiki-workbench.js:223` |
| 判据正文截断（给模型看） | 9000 字 | `wiki-store.js:114` |
| 场景上下文页数 | 最多 4 页 | `wiki-store.js:120` |
| 检索词长度 | 2 到 80 字；命中最多 8 条 | `wiki-store.js:126`、`wiki-store.js:133` |
| 标题检索词长度 | 不超过 100 字；默认返回 8 条 | `wiki-store.js:93`、`wiki-store.js:95` |
| 单轮用户输入 | 1 到 4000 字 | `wiki-workbench.js:136` |
| 会话消息条数 | 最多 80 | `wiki-workbench.js:142` |
| 案件快照单文件 | 截 12000 字 | `wiki-workbench.js:110` |
| 回看的用户消息 | 最近 16 条 | `wiki-workbench.js:185` |
| 相关证据页 | 最多 3 个，各截 3000 字 | `wiki-workbench.js:154`、`wiki-workbench.js:156` |
| 相关判据页 | 正文不超过 12000 字，最多 5 页 | `wiki-workbench.js:164`、`wiki-workbench.js:172` |
| 多页草案页数 | 最多 6 页 | `wiki-workbench.js:207` |
| `_schema.md` 读入量 | 截 14000 字 | `wiki-workbench.js:176` |
| 回放样本数 | 最多 5 条 | `wiki-replay.js:45` |
| 回放单页判据上下文 | 截 15000 字 | `wiki-replay.js:54` |
| 回放输入里的提示词 | 通用研判 14000 字、通用 SOP 6000 字、场景提示 10000 字 | `wiki-replay.js:59` |
| 回放结论字段 | 摘录各 250 字、理由 500 字、缺项最多 5 条各 200 字 | `wiki-replay.js:74-75` |
| 客户经验字段数 | 9 项 | `wiki-workbench.js:13-14` |
| 客户经验复核期限 | 上限 366 天 | `wiki-workbench.js:277` |
| `publishedFor` 返回条数 | 最多 8 条 | `wiki-store.js:340` |
| 告警类型到判据目录的映射 | 13 个类型映射到 12 个目录 | `wiki-store.js:12-17` |

### 10.2 实测与静态核查

本地没有模型服务与牧云凭据，所以下面对「模型返回什么」的部分用假模型跑——它只验证本模块自己的分支逻辑，不代表模型的实际表现。写盘类探针全部在临时目录里跑，仓内 `wiki/` 未被改动。

**导出面与判据库现状**（只读）：

```bash
node --input-type=module -e '
import { WikiStore } from "./wiki-store.js";
import { WikiWorkbench } from "./wiki-workbench.js";
console.log("WikiStore 方法:", Object.getOwnPropertyNames(WikiStore.prototype).filter(n=>n!=="constructor").join(", "));
console.log("WikiWorkbench 方法:", Object.getOwnPropertyNames(WikiWorkbench.prototype).filter(n=>n!=="constructor").join(", "));
const wiki = new WikiStore();
const browse = await wiki.browse();
const list = await wiki.list();
const health = await wiki.health();
console.log("browse 页数:", browse.length, "| list 页数:", list.length, "| active:", health.active_pages, "| issues:", health.issues.length);
const index = await wiki.agentIndex("honeypot");
console.log("honeypot 可用判据:", index.pages.map(p=>p.id).join(", "));
const byStatus = browse.reduce((a,p)=>{a[p.status]=(a[p.status]||0)+1;return a;},{});
console.log("browse 按状态:", JSON.stringify(byStatus));
'
```

实跑输出：

```
WikiStore 方法: file, browse, list, get, getById, search, agentIndex, agentPage, agentContextPages, agentSearch, health, update, checkBundle, publishBundle, createExperience, publishedFor
WikiWorkbench 方法: file, get, save, list, create, reply, replay, publish
browse 页数: 189 | list 页数: 17 | active: 14 | issues: 0
honeypot 可用判据: GEN-12, HP-10
browse 按状态: {"active":47,"deprecated":139,"draft":3}
```

即：仓库里共 189 个 Markdown 页，其中生效 47 个、退役 139 个、草稿 3 个；能被 `list()` 当作判据页列出的只有 17 页——13 个判据目录各一页生效判据，加上 4 页客户经验（1 页生效、3 页草稿）；`health()` 当前报 0 条问题。

**发布前检查的正反例**（只读）：

```bash
node --input-type=module -e '
import { WikiStore } from "./wiki-store.js";
const wiki = new WikiStore();
const hp = await wiki.get("honeypot/HP-01.md");
const broken = hp.content.replace(/^title:.*$/m, "").replace(/^status:.*$/m, "status: whatever").replace(/^updated:.*$/m, "updated: 2026/11/07");
console.log("原样内容检查结果:", JSON.stringify(await wiki.checkBundle([{ path: "honeypot/HP-01.md", content: hp.content, page_revision: hp.revision }])));
console.log("改坏三个字段后:", JSON.stringify(await wiki.checkBundle([{ path: "honeypot/HP-01.md", content: broken, page_revision: hp.revision }]), null, 1));
'
```

实跑输出：

```
原样内容检查结果: []
改坏三个字段后: [
 "honeypot/HP-01.md 状态无效",
 "honeypot/HP-01.md 缺少 title",
 "honeypot/HP-01.md 更新日期无效"
]
```

**写路径冒烟**（临时目录）：修订一页 → 看历史目录与 `log.md` → 批量发布两页 → 发布一页客户经验 → 看 `publishedFor()`。

```
原 status: deprecated | 新 status: active
update 后 revision: c12562a2b4d9bf7a | status: active
历史目录存在: HP-01-64254a3d5f3ca39c.md
log.md 末段: "## [2026-11-17T10:30:26.644Z] update | HP-01 | 影响判据：HP-01 | 要点：通过知识库工作台更新；上版 64254a3d5f3ca39c，新版 c12562a2b4d9bf7a。"
旧 revision 提交 -> 409 知识库页面已更新，请刷新后再提交
publishBundle 前 checkBundle: []
publishBundle 发布页数: 2 | 返回 revision: c12562a2b4d9bf7a,d837ef7e3a3236f8
ingest 记录: ["[2026-11-17T10:30:26.666Z] ingest | HP-01, HP-10","审核人：审核员A","反馈案件：无","证据：原页面出处","回放：passed，样本 3 条","要点：冒烟测试用审核说明"]
createExperience -> customer-experience/EX-9001.md | id: EX-9001 | status: active
客户经验目录末行: "- [EX-9001](EX-9001.md) · 探针经验"
publishedFor(honeypot) 条数: 2 | 含新页: true
```

**工作台全流程**（临时目录 + 假模型）：开会话 → 对话出草案 → 回放 → 发布。

```
create -> status: collecting | page: honeypot/HP-10.md | 消息数: 1
reply -> status: ready_for_review | proposal 存在: true | changes: 1 | messages: 3
最后一条助手消息: "已生成草案"
replay -> status: no_cases | corpus: {"eligible":0,"selected":0,"omitted":0}
未确认 no_cases 就发布 -> 400 没有可用的已保存案件；请确认样本覆盖缺口
publish -> session.status: published | page.revision: d837ef7e3a3236f8
audit: {"reviewer":"审核员A","note":"冒烟测试用的审核说明文本","at":"2026-11-17T10:30:42.856Z","evidence_path":null,"replay_status":"no_cases","replay_count":0,"replay_override_reason":null,"replay_no_cases_ack":true}
第二条会话 -> status: ready_for_review
replay(有样本) -> status: passed | corpus: {"eligible":1,"selected":1,"omitted":0}
cases: [{"case_id":"case-1","label_kind":"已审核反馈","status":"matched","changed":false}]
```

**回放的失败面**（假模型故意返回不在输入里的摘录）：

```
report.status: needs_review
corpus: {"eligible":1,"selected":1,"omitted":0}
case.status: invalid
before: {"error":"模型结论缺少可在冻结材料和判据中逐字核对的摘录"}
after: {"error":"模型结论缺少可在冻结材料和判据中逐字核对的摘录"}
无模型 -> 知识回放模型尚未配置
无草案 -> 当前没有可回放的判据草案
版本对不上 -> 409 判据 HP-10 已更新，请重新整理草案
```

**对话内校验失败的表现**（假模型不按格式输出）：

```
reply 是否抛出: false
会话 status: collecting
proposal: null
最后一条消息: {"role":"assistant","content":"本轮输入已保存；自动整理暂时失败：案件反馈必须先区分判据、数据、提示词、来源或个案问题"}
外部证据(http) 最后一条消息: "本轮输入已保存；自动整理暂时失败：新证据须包含 HTTPS 原文、标题、核查日期、客户提供的原文片段、支持命题和适用边界"
```

完整探针脚本与逐条输出记在 `evidence/recon/P001-T010.md`。

## 11 约束与理由

### 11.1 假设

- 判据库按 16 个约定目录组织，页编号形如 `XX-01` 或 `XX-01a`（`wiki-store.js:7`、`wiki-store.js:9-11`）。
- 告警类型到判据目录的映射是写死的 13 条（`wiki-store.js:12-17`）。
- 提示词仓提供 `knowledge` 与 `triage` 两段提示、`sop.common` 与带 `id` 的场景卡，并给出一个 `revision`（`wiki-workbench.js:176`、`wiki-replay.js:58-59`、`wiki-replay.js:91`）。
- 模型返回 JSON 对象（`wiki-workbench.js:8-12`），维护轮还要带 `ready`、`diagnosis` 等字段（`wiki-workbench.js:190-192`）。
- 案件目录里有 `01-原始告警.txt`、`03-研判事实.md`、`05-研判结果.md`、`result.json` 四个固定文件名的文件（`wiki-workbench.js:102`）。
- 判据库里有一份 `_schema.md`，工作台把它当操作手册读（`wiki-workbench.js:152`）。

### 11.2 限制

- **目录与映射写死**。新增一类告警或新开一个判据目录，要改 `wikiDirectories` 与 `classForEvent`（`wiki-store.js:9-17`）。
- **单页修订不跑完整的发布前检查**。`update()` 只查路径、版本、正文长度、编号与状态、来源五项（`wiki-store.js:161-170`），不查 `title` / `applies_to` / `updated` 格式，也不查 `refs` 与 `evidence` 指向的页是否存在（那些检查在 `checkBundle()`，`wiki-store.js:217-226`）。
- **回放样本只来自会话目录**。样本必须是文件名像 UUID 的会话文件，且带 `status: published`、审核人与反馈（`wiki-replay.js:23-26`）；判据库目录本身不提供样本。
- **回放不重新取证**（`wiki-replay.js:93`），所以它能回答「判据变了结论变没变」，回答不了「现在的判据对不对」。
- **回放只比变化不比对错**。结论定性只依据「与预期一致与否」和「与旧判据是否不同」（`wiki-replay.js:103-107`）。
- **客户经验不走回放**。它的发布通道是 `createExperience()`，审核要求是三态结论 + 复核期限 + 说明（`wiki-workbench.js:271-285`）。
- **外部原文证据要求很紧**：必须 HTTPS、不能带用户名密码、路径不能是根、核查日期不能是未来、四个字段各不少于 8 字，且摘录要逐字出现在客户发过的消息里（`wiki-workbench.js:31-36`）。
- **对话里的模型输出问题不报错**。校验失败被转成助手消息（`wiki-workbench.js:240-242`），调用方拿不到异常。

### 11.3 已知坑

- **`reply()` 里 `sourceEvidence()` 被调了两次**，入参相同（`wiki-workbench.js:220` 与 `wiki-workbench.js:226`）。第一次抛错就不会走到第二次。代码与注释里都没写为什么这么写，**没查到**。
- **单页修订的历史备份写在全部校验之后**。所以「参数不合规」与「版本冲突」两种失败不会在历史目录里留下任何东西（`wiki-store.js:161-174`）——想从历史目录反查失败原因是不行的。
- **`publishedFor()` 不校验 `review.verdict`**（`wiki-store.js:339`）。实测仓库里有一条 `review.verdict` 为 `unsuccessful_attack` 的经验同样被返回（`wiki-store.js:331-340`）。
- **回放的 `before` 一侧用的是空 candidate**（`wiki-replay.js:98`），也就是旧判据正文；但 `wikiContext()` 仍会重新读一遍磁盘（`wiki-replay.js:50`），所以“旧”指的是回放那一刻磁盘上的版本，不是起草时的版本。

### 11.4 被排除的方案

- **模型不直接写库**。系统提示里写死了「你只能提出 JSON 修订草案，不能直接写库……人工审核后才发布」（`wiki-workbench.js:176`），写库只发生在 `publish()` 里（`wiki-workbench.js:285`、`wiki-workbench.js:311`）。**为什么用「对话出草案 + 人工审核」而不是让模型直接改文件，代码与注释里没有进一步说明，没查到**。

## 12 指针与未决

**相关页面**（模块页由各自的模块卡产出，归属见 [docs/modules/_breakdown.json](_breakdown.json)）：整体结构见 [docs/architecture.md](../architecture.md)；读判据的调用方见 investigation-agent 模块页；另一套候选经验整理台（`knowledge-store.js` / `knowledge-workbench.js`）见 experience-draft 模块页。

**本页未决**：

1. **模型的实际行为没验证**。本机没有模型服务，本卡用假模型验证了本模块的分支逻辑（摘录校验、诊断缺失、证据校验），不代表模型真会按这个格式返回。
2. **判据库目录的内容没逐页读**。本卡的证据源限 `wiki-store.js`、`wiki-workbench.js`、`wiki-replay.js` 三个实现文件，判据页正文与 `_schema.md` 的具体内容没查。因此「操作手册」（`wiki-workbench.js:152` 读入的那份）具体要求了什么，本页只能给出代码层面的要求。
3. **为什么客户经验不走回放那一套**，代码与注释里都没写，没查到。
4. **单页修订不跑 `checkBundle()` 是设计还是遗漏**，代码里没有说明，没查到。
5. **回放样本依赖别的会话已经发布过**，这条链路在真实使用中的覆盖情况没查到——本卡的实测样本是现造的。
6. **`_evidence/` 下已有 17 个 `.md` 文件**（实测清点，含一个 `index.md`），但这三个文件里没有任何一处统计证据页的引用关系，`health()` 只查被引用方是否存在（`wiki-store.js:153-154`），孤儿证据页查不出来。
 |
