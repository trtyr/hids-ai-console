---
type: module
id: MOD-PROMPT-STORE
covers: [prompt-store.js]
updated: 2026-11-20
---

# prompt-store · 提示词与 SOP 的装载、覆盖与版本管理

> **模块名**：`prompt-store`
> **落点**：本页（`docs/modules/prompt-store.md`），模块清单见 [\_breakdown.json](_breakdown.json)
> **真源**：`prompt-store.js`（133 行，单文件模块；本地 import 只有两处，都向下取路径——`config-store.js` 的 `dataRoot` 与 `wiki-store.js` 的判据库目录/种子，见文末 `:132-133`）
> **覆盖构件**：提示词装载、本地覆盖、版本指纹、整包安装（四个构件各占一节，见第 3 至第 6 节）
> **行号基准**：对应提交 `35530d85`；该文件自 `a16e0d5` 起未改动。代码变了要重新核行号。

## 1. 模块职责

### 1.1 做什么

`PromptStore` 回答一个问题：**这次研判用哪一套提示词与 SOP？**

它从三处来源装配出「当前生效」的一套正文，供调用方取用；同时提供四种配套能力：

| 能力 | 构件 | 一句话 | 入口 |
| --- | --- | --- | --- |
| 提示词装载 | 第 3 节 | 把核心提示词、场景卡、SOP 三类来源的正文拼成一份 | `load()`（`prompt-store.js:33`） |
| 本地覆盖 | 第 4 节 | 允许用本机的一份覆盖文件改写其中若干章节 | `update()`（`prompt-store.js:100`） |
| 版本指纹 | 第 5 节 | 给生效正文算一个可比较的短指纹 | `load()` 与 `snapshot()` 的返回值（`prompt-store.js:45`、`prompt-store.js:56-57`） |
| 整包安装 | 第 6 节 | 用一个升级包整体替换 21 个章节 | `install()`（`prompt-store.js:61`） |

### 1.2 不做什么

- **不判断正文好坏**。本模块搬运正文、统计字数、算指纹；提示词该不该这么写，不在这里判。
- **不管理判据库本身**。它只按映射表从判据目录读 12 个 SOP 文件（`prompt-store.js:10-16`、`prompt-store.js:43`），
  判据页的增删改审核不在本模块。
- **不负责把提示词送到模型**。本模块没有模型客户端、没有 HTTP 路由，`prompt-store.js:1-4` 只引入
  `node:crypto`、`node:fs/promises`、`node:path`、`node:url` 四个内置模块。
- **除覆盖文件外不写任何文件**。写盘只发生在 `install()`（`prompt-store.js:78-81`）与
  `update()`（`prompt-store.js:109-112`）两处，目标都是构造时指定的覆盖文件。

### 1.3 覆盖文件在哪

| 项 | 取值 | 出处 |
| --- | --- | --- |
| 覆盖文件默认路径 | `<数据根>/prompt-overrides.json`（数据根＝`HIDS_DATA_DIR`，没设就是 `~/.local/share/hids-ai-console`；**不在仓库内**） | `prompt-store.js:17`、`prompt-store.js:126` |
| 覆盖文件环境变量 | `HIDS_PROMPT_STORE_FILE`，配了就用它 | `prompt-store.js:17` |
| 构造参数 | `new PromptStore(filename)`，给了就用给的 | `prompt-store.js:26` |
| 判据目录环境变量 | `HIDS_WIKI_DIR`，缺省 `<本模块所在目录>/wiki` | `prompt-store.js:9` |
| 提示词目录 | `<本模块所在目录>/prompts`（写死，不可配） | `prompt-store.js:7` |

两个环境变量在模块 import 时读一次（`prompt-store.js:9`、`prompt-store.js:17`），进程启动后再改环境变量不生效——
实测：`import` 之后设 `HIDS_WIKI_DIR` 再 `load()`，仍然读到原来的判据目录。

## 2. 公开面

`PromptStore` 只导出一个类（`prompt-store.js:25`），共 6 个方法加 1 个构造函数。

| 能力 | 方法 | 入参 | 返回 | 抛错 | 单位 |
| --- | --- | --- | --- | --- | --- |
| 装配生效正文 | `load()` | 无 | `{version, revision, source, prompts, scenarios, sop}`（`prompt-store.js:46-47`） | 读文件失败即抛（ENOENT、SyntaxError） | — |
| 取可安装的章节快照 | `snapshot()` | 无 | `{sections, knowledge_revision}`（`prompt-store.js:52-58`） | 同上 | — |
| 整包安装 | `install(sections, release, expectedRevision, knowledgeRevision)` | 4 个，见第 6 节 | 重新 `load()` 的结果（`prompt-store.js:82`） | 400 / 409 / TypeError，见第 6.2 节 | — |
| 列出章节清单 | `metadata()` | 无 | `{version, revision, sections[]}`（`prompt-store.js:90-97`） | 同上 | — |
| 改写单个章节 | `update(section, content, expectedRevision)` | 章节名、正文、期望指纹 | 重新 `load()` 的结果（`prompt-store.js:113`） | 章节名或正文不合法 → 普通 `Error`；版本不符 → `409`。见第 4.3 节 | — |

表注：本表列方法与入参形状，不含量纲，一律「—」；正文长度上限见第 9 节。

两个读方法（`load()`、`snapshot()`）与一个清单方法（`metadata()`）不排队，直接读盘；
两个写方法（`install()`、`update()`）共用实例内的一条串行队列（`prompt-store.js:62`、`prompt-store.js:84`、
`prompt-store.js:101`、`prompt-store.js:115`）。

## 3. 构件一：提示词装载

### 3.1 三处来源

`load()`（`prompt-store.js:33-48`）并行读三类来源（`prompt-store.js:34-37`），SOP 分两个目录取：

| 来源 | 内容 | 位置 | 出处 |
| --- | --- | --- | --- |
| 核心提示词 | 6 个 Markdown 文件，键为 `triage` / `deep` / `trace` / `knowledge` / `knowledge_reuse` / `cross` | `<模块目录>/prompts/<文件名>` | 键与文件名见 `prompt-store.js:18`，读取见 `prompt-store.js:35` |
| 场景卡 | 一个 `scenarios.json`，含 `version` 与 `cards` 数组 | `<模块目录>/prompts/scenarios.json` | `prompt-store.js:36` |
| 判据目录里的 SOP | 12 个场景各一份 SOP 文件 | `<判据目录>/<映射表给出的路径>` | 映射表 `prompt-store.js:10-16`，读取 `prompt-store.js:43` |
| 仓内 SOP | 2 份：`common` 与 `command_whitelist` | `<模块目录>/prompts/sop/<id>.md` | `prompt-store.js:42` |

`common` 与 `command_whitelist` 这两个 id 走 `prompts/sop/`，其余场景卡 id 走判据目录——
分流条件写在 `prompt-store.js:42` 的三元表达式里。因此 `wikiSop` 映射表（`prompt-store.js:10-16`）
只列 12 项，`command_whitelist` 不在其中；它是 13 张场景卡中的一张（当前排在第 7 位），卡片正文来自 `scenarios.json`，
SOP 正文来自 `prompts/sop/command_whitelist.md`。

当前数据下（命令见下）：

- 核心提示词 6 个，键与 `prompt-store.js:18` 的 `coreFiles` 一一对应。
- 场景卡 13 张，SOP 14 条（`common` + 13 张卡各一条）。
- 生效版本 `merged-three-state-2026-11-06`，指纹 `deabe4abb842db81`。

```bash
node -e "
import('./prompt-store.js').then(async m => {
  const active = await new m.PromptStore().load();
  console.log('version:', active.version);
  console.log('revision:', active.revision);
  console.log('core keys:', Object.keys(active.prompts).join(','));
  console.log('scenario cards:', active.scenarios.cards.length);
  console.log('sop ids:', Object.keys(active.sop).join(','));
});
"
```

### 3.2 装配顺序

1. **并行读**：核心 6 个文件、`scenarios.json`、覆盖文件三路同时读（`prompt-store.js:34-37`）。
2. **叠加覆盖**：核心章节用覆盖文件的同名键覆盖（`prompt-store.js:38`），场景卡用 `scenario:<card.id>` 键覆盖
   （`prompt-store.js:40`），`sop:common` 与 `sop:command_whitelist` 用 `sop:<id>` 键覆盖（`prompt-store.js:44`）。
   键名表见第 4.2 节。
3. **算指纹**：对生效正文算 `revision`（`prompt-store.js:45`），算法见第 5 节。
4. **组装返回**：`{version, revision, source, prompts, scenarios, sop}`（`prompt-store.js:46-47`）。

两个字段的来源要说清楚：

- **`version`**：优先取覆盖文件里的 `_release.version`；没有 `_release` 时取 `scenarios.json` 里的 `version`
  （`prompt-store.js:46`）。整包安装之后，这个值会变成升级包自带的版本号。
- **`source`**：固定的一行说明文案，不随内容变化（`prompt-store.js:47`）。

### 3.3 装配失败的样子

`load()` 不做兜底：任一文件读不到就直接把异常抛给调用方。实测把判据目录指向空目录：

```bash
mkdir -p /tmp/empty-wiki && HIDS_WIKI_DIR=/tmp/empty-wiki node -e "
import('./prompt-store.js').then(async m => {
  try { await new m.PromptStore().load(); } catch (e) { console.log(e.code, e.path); }
});
"
# ENOENT /tmp/empty-wiki/webshell/WS-13.md
```

判据页缺失时**不会**退回仓内 `wiki/` 目录——`HIDS_WIKI_DIR` 一旦配了，它就是唯一来源
（`prompt-store.js:9`）。

## 4. 构件二：本地覆盖

### 4.1 覆盖文件怎么读

`readOverrides()`（`prompt-store.js:28-31`）读构造时指定的覆盖文件：

| 情况 | 结果 | 出处 |
| --- | --- | --- |
| 文件不存在（ENOENT） | 当作空覆盖 `{}`，不报错 | `prompt-store.js:30` |
| 文件不是合法 JSON | 抛 `SyntaxError`，不吞 | `prompt-store.js:29-30`（只特判了 ENOENT） |
| 其他读错误（权限等） | 原样抛出 | `prompt-store.js:30` |

覆盖文件的键就是章节名，可以手写；`load()` 读的键见下表。

### 4.2 覆盖键名表

| 键名形式 | 覆盖对象 | 生效处 | 出处 |
| --- | --- | --- | --- |
| `triage`、`deep`、`trace`、`knowledge`、`knowledge_reuse`、`cross` | 6 个核心提示词 | 覆盖值不是 null/undefined 时用覆盖值，否则用文件正文 | `prompt-store.js:38` |
| `scenario:<card.id>` | 对应场景卡的提示词正文 | 同上 | `prompt-store.js:40` |
| `sop:common`、`sop:command_whitelist` | 仓内那两份 SOP | 同上 | `prompt-store.js:44` |
| `_release` | 升级包元信息（`version` / `sequence` 等） | `version` 取自此处 | `prompt-store.js:45-46` |
| `_history` | 安装历史（模块自己维护） | 不影响生效正文 | `prompt-store.js:77` |

覆盖优先级高于仓内文件：命中覆盖键时，文件正文被替换（`prompt-store.js:38`、`prompt-store.js:40`、
`prompt-store.js:44`）。未命中的章节照旧用文件正文。

### 4.3 改写单个章节：`update()`

`update(section, content, expectedRevision)`（`prompt-store.js:100-117`）按三步检查，顺序写在
`prompt-store.js:103-106`：

| 检查 | 不通过时的表现 | 错误对象带 `status` |
| --- | --- | --- |
| 章节名在白名单内 | `不支持的提示词章节` | 否（普通 `Error`） |
| 正文是字符串、去空白后非空、长度 ≤ 20000、不含 NUL | `提示词正文必须为 1 到 20000 字` | 否 |
| `expectedRevision` 等于当前 `revision` | `提示词已由其他操作更新，请刷新后再保存` | 是，`409` |

白名单是「6 个核心键 + 13 个 `scenario:<id>` 键」（`prompt-store.js:103`），由当前场景卡列表现算。
**SOP 键不在白名单里**：拿 `sop:common` 调 `update()` 会得到 `不支持的提示词章节`；
SOP 只能随整包安装（第 6 节）或手改覆盖文件来变。

通过检查后：读回整个覆盖对象 → 只改这一个键 → 落盘 → 返回重新 `load()` 的结果
（`prompt-store.js:107-113`）。落盘方式与整包安装一致：先建目录（`0o700`），再写临时文件
（`<覆盖文件>.<uuid>.tmp`，`0o600`，`flag: 'wx'` 防覆盖），最后 `rename` 原子替换
（`prompt-store.js:109-112`）。

实测：

```bash
node -e "
import('node:fs/promises').then(async fs => {
  const {PromptStore} = await import('./prompt-store.js');
  const store = new PromptStore('/tmp/cover-demo/prompt-overrides.json');
  const cur = await store.load();
  const after = await store.update('triage', '覆盖后的通用系统提示词', cur.revision);
  console.log('prompts.triage =', after.prompts.triage);
  console.log('覆盖文件键 =', Object.keys(JSON.parse(await fs.readFile('/tmp/cover-demo/prompt-overrides.json','utf8'))).join(','));
});
"
# prompts.triage = 覆盖后的通用系统提示词
# 覆盖文件键 = triage
```

## 5. 构件三：版本指纹

### 5.1 算法

`revisionOf()`（`prompt-store.js:21-23`）就一句：对入参做 `JSON.stringify`，算 SHA-256，取十六进制前 16 位。

```js
createHash('sha256').update(JSON.stringify(prompts)).digest('hex').slice(0, 16)
```

入参名叫 `prompts`，但调用处传进来的不只有提示词（`prompt-store.js:45`）。

### 5.2 两个指纹的区别

| | `revision` | `knowledge_revision` |
| --- | --- | --- |
| 算什么 | `{prompts, scenarios, sop, release}` 整体（`prompt-store.js:45`） | 去掉 `common` 与 `command_whitelist` 之后的 SOP 字典（`prompt-store.js:56-57`） |
| 覆盖范围 | 6 个核心提示词 + 13 张场景卡 + 14 条 SOP + 发布版本号 | 判据目录里那 12 条场景 SOP |
| 从哪取 | `load()`、`metadata()` 都返回（`prompt-store.js:46`、`prompt-store.js:90`） | 只在 `snapshot()` 里返回（`prompt-store.js:56-57`） |
| 用途 | 乐观并发的校验值；写章节与整包安装都要比 | 整包安装的第二道校验（第 6 节） |

`knowledge_revision` 只能从 `snapshot()` 拿：`metadata()` 的返回里没有这个字段
（`prompt-store.js:88-97`）。

### 5.3 指纹会变什么

| 变动 | `revision` | `knowledge_revision` |
| --- | --- | --- |
| 改 6 个核心提示词之一 | 变 | 不变 |
| 改 13 张场景卡之一 | 变 | 不变 |
| 改判据目录里那 12 条 SOP 之一 | 变 | 变 |
| 改 `prompts/sop/` 里的 `common` 或 `command_whitelist` | 变 | 不变 |
| 整包安装（章节正文或版本号变了） | 变 | 不变 |
| 改 `scenarios.json` 里的**字段顺序**（内容不变） | 变 | 不变 |

最后一行值得单独说一句：指纹算的是 JSON **文本**，所以键序也参与计算。实测把 `scenarios` 的键顺序
颠倒后，内容没变，指纹从 `deabe4abb842db81` 变成 `9bf6e567ce73b60d`。

```bash
node -e "
import('node:crypto').then(async ({createHash}) => {
  const {PromptStore} = await import('./prompt-store.js');
  const sha16 = o => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,16);
  const a = await new PromptStore().load();
  const base = {prompts:a.prompts, scenarios:a.scenarios, sop:a.sop, release:null};
  const swapped = {...base, scenarios: Object.fromEntries(Object.entries(a.scenarios).reverse())};
  console.log('原序:', sha16(base), '| 倒序:', sha16(swapped), '| 相同:', sha16(base) === sha16(swapped));
});
"
# 原序: deabe4abb842db81 | 倒序: 9bf6e567ce73b60d | 相同: false
```

### 5.4 复算命令

想自己核对某个 `revision` 是怎么来的，用这行：

```bash
node -e "
import('node:crypto').then(async ({createHash}) => {
  const {PromptStore} = await import('./prompt-store.js');
  const sha16 = o => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,16);
  const a = await new PromptStore().load();
  const recomputed = sha16({prompts:a.prompts, scenarios:a.scenarios, sop:a.sop, release:null});
  console.log('复算:', recomputed, '| 上报:', a.revision, '| 一致:', recomputed === a.revision);
});
"
# 复算: deabe4abb842db81 | 上报: deabe4abb842db81 | 一致: true
```

## 6. 构件四：整包安装

### 6.1 入口与入参

`install(sections, release, expectedRevision, knowledgeRevision)`（`prompt-store.js:61`）把 21 个章节整体换成一份升级包。

| 入参 | 是什么 | 从哪来 |
| --- | --- | --- |
| `sections` | 章节字典，键是 21 个章节名（6 核心 + 13 场景 + 2 SOP），值是正文 | `snapshot()` 的 `sections`（`prompt-store.js:52-55`） |
| `release` | 升级包元信息；`version` 决定安装后的生效版本号，`sequence` 参与序号检查 | 升级包自己带的 |
| `expectedRevision` | 调用方看到的当前指纹 | `load()` 或 `metadata()` 的 `revision` |
| `knowledgeRevision` | 调用方看到的当前知识库指纹 | `snapshot()` 的 `knowledge_revision`（`prompt-store.js:56-57`） |

### 6.2 四道检查，按顺序

| # | 检查 | 不通过时的表现 | 错误带 `status` | 出处 |
| --- | --- | --- | --- | --- |
| 1 | 当前 `revision` 等于 `expectedRevision` | `当前版本已变化，请刷新后重新确认替换` | `409` | `prompt-store.js:65` |
| 2 | 当前 `knowledge_revision` 等于 `knowledgeRevision` | `升级包与当前知识库版本不兼容` | `409` | `prompt-store.js:66` |
| 3 | `sections` 的键数等于 21；21 个值逐一检查：必须是字符串、去空白后非空、长度 ≤ 20000、不含 NUL | `升级包缺少必需章节或正文格式不正确` | `400` | `prompt-store.js:67-70` |
| 4 | `release.sequence` 大于已记录的 `sequence`（无记录时按 0 算） | `不允许重复应用或降级到旧版本` | `409` | `prompt-store.js:72-73` |

第 3 条的实际效果是「键集合必须与当前快照一致」，实现方式是两步（`prompt-store.js:67-70`）：先比键数是否等于 21，
再拿**快照里那 21 个键**逐个查传入字典的值是不是合法字符串。传入的键名不同就会查不到某个键，
那个键的值是 `undefined`，按「非字符串」处理，整包被拒。实测把 21 个键换成另一套 21 个名字，键数不变，照样被拒：

```
21 个键换成另一套名字（键数仍为 21）=> Error | status: 400 | 升级包缺少必需章节或正文格式不正确
```

`release` 缺字段时，第 4 条会在读 `release.sequence` 时抛 `TypeError`
（`prompt-store.js:72`），而不是返回 400：

```
release undefined => TypeError | status: undefined | Cannot read properties of undefined (reading 'sequence')
```

注意这是「`release` 整个缺失」的情况。`release` 存在但字段缺时行为不同：
`release.version` 缺失时生效版本号回落到 `scenarios.json` 的 `version`（`prompt-store.js:46`）；
`release.sequence` 缺失时第 4 条的比较结果是 false，检查放行——实测一个既没有 `version` 也没有 `sequence`
的 `release` 能装上，装完的版本号是 `merged-three-state-2026-11-06`。

### 6.3 写入什么

通过四道检查后，覆盖文件被整体重写（`prompt-store.js:76-77`）：

| 键 | 内容 |
| --- | --- |
| 21 个章节键 | 升级包给的新正文 |
| `_release` | 升级包元信息，原样写入 |
| `_history` | 安装历史：已有历史则追加一条 `release`；没有则先放一条「初始研判策略」再追加 |

那条「初始研判策略」是本模块硬编码的兜底记录（`prompt-store.js:74-75`）：版本取安装前的 `current.version`，
标题 `初始研判策略`，摘要 `随当前应用安装的研判策略`，日期 `2026-11-06`，模块列表
`['告警研判', '深度溯源', '知识经验']`，`updated_at` 为 `null`。

落盘三步：建目录（`0o700`）→ 写临时文件 `<覆盖文件>.<uuid>.tmp`（`0o600`，`flag: 'wx'`）→ `rename` 原子替换
（`prompt-store.js:78-81`）。最后重新 `load()` 并把结果返回（`prompt-store.js:82`），
所以调用方拿到的就是安装后的生效状态。

### 6.4 实测

```bash
rm -rf /tmp/install-demo   # 重复跑时先清掉上一轮的覆盖文件（序号只能前进）
node -e "
import('node:fs/promises').then(async fs => {
  const {PromptStore} = await import('./prompt-store.js');
  const store = new PromptStore('/tmp/install-demo/prompt-overrides.json');
  const snap = await store.snapshot();
  const cur = await store.load();
  const release = {version:'demo-2026-11-20', sequence:1, title:'演示', summary:'s', date:'2026-11-20', modules:[], changes:{}};
  const after = await store.install({...snap.sections}, release, cur.revision, snap.knowledge_revision);
  console.log('安装后 version:', after.version, '| revision 变了:', cur.revision !== after.revision);
  const raw = JSON.parse(await fs.readFile('/tmp/install-demo/prompt-overrides.json','utf8'));
  console.log('文件顶层键数:', Object.keys(raw).length, '| _history 长度:', raw._history.length);
});
"
# 安装后 version: demo-2026-11-20 | revision 变了: true
# 文件顶层键数: 23 | _history 长度: 2
```

顶层 23 个键 = 21 个章节 + `_release` + `_history`。

## 7. 关键路径

### 路径 A：只读装配（最常用）

```
load()
  → 并行读 6 个核心文件 + scenarios.json + 覆盖文件      prompt-store.js:34-37
  → 叠加覆盖（核心 / 场景卡 / 两份仓内 SOP）                prompt-store.js:38-44
  → 算 revision                                           prompt-store.js:45
  → 返回 {version, revision, source, prompts, scenarios, sop}
```

用途：取一份生效正文与它的指纹。特点：**只读，不落盘**，重复调用结果相同（前提是期间没人改覆盖文件）。

### 路径 B：改写单个章节

```
load() 或 metadata()            → 拿到当前 revision
  → update(section, content, expectedRevision)            prompt-store.js:100
      → 章节名 / 正文形状 / 版本三道检查                    prompt-store.js:103-106
      → 读回覆盖对象，只改一个键                            prompt-store.js:107-108
      → 临时文件 + rename 落盘                              prompt-store.js:109-112
      → 返回重新 load() 的结果                              prompt-store.js:113
```

用途：在本机试一段提示词正文。特点：**只影响覆盖文件里的那一个章节**，其余章节照旧；
改完 `revision` 变，别的调用方拿旧 `revision` 再来写会被 409 拦下（`prompt-store.js:106`）。

### 路径 C：整包替换

```
snapshot()                      → 拿到 sections（21 个章节）与 knowledge_revision
load() 或 metadata()            → 拿到当前 revision
  → install(sections, release, expectedRevision, knowledgeRevision)   prompt-store.js:61
      → revision 检查 → knowledge_revision 检查 → 章节形状检查 → 序号检查   prompt-store.js:65-73
      → 写 21 个章节 + _release + _history                 prompt-store.js:76-77
      → 临时文件 + rename 落盘                              prompt-store.js:78-81
      → 返回重新 load() 的结果                              prompt-store.js:82
```

用途：把一整套新提示词换上去。特点：**整体替换**，21 个章节一次性换掉；
版本号从升级包带过来（此后 `load()` 的 `version` 取 `_release.version`，`prompt-store.js:46`）。

### 三条路径的共同点

写路径（路径 B、C）都在实例内的同一条队列上排队（`prompt-store.js:62`、`prompt-store.js:84`、
`prompt-store.js:101`、`prompt-store.js:115`）；读路径不排队。同一实例上两个并发 `update()`，
后到的那个会拿到 409（实测：一次 fulfilled、一次 409 `提示词已由其他操作更新，请刷新后再保存`）。

## 8. 不变量

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-PROMPT-01` | 覆盖文件里对应键的值不是 null/undefined 时，生效正文取覆盖值 | 覆盖文件写了 `triage`，生效的却是仓内 `triage.md` | `prompt-store.js:38`、`prompt-store.js:40`、`prompt-store.js:44` | 本机改的提示词不生效 |
| `R-PROMPT-02` | `revision` 的输入包含生效中的核心提示词、场景卡、SOP 与发布版本 | 改了场景卡正文而 `revision` 不变 | `prompt-store.js:45` | 乐观并发失效，旧指纹仍能写入 |
| `R-PROMPT-03` | `update()` 不接受 SOP 章节 | 拿 `sop:common` 调 `update()` 并成功 | `prompt-store.js:103-104` | SOP 被局部改写，与整包安装口径不一致 |
| `R-PROMPT-04` | 整包安装要求 `sequence` 严格大于当前值，等于或更小都拒绝 | `sequence` 等于当前值也能装上 | `prompt-store.js:72-73` | 旧包覆盖新包 |
| `R-PROMPT-05` | 整包安装的章节集合必须与当前快照一致（21 个） | 少一个章节也能装上 | `prompt-store.js:67-70` | 装出一套残缺的提示词 |
| `R-PROMPT-06` | 单章节改写不丢覆盖文件里的其他键 | 改完 `triage`，`_release` 与 `_history` 没了 | `prompt-store.js:107-108` | 版本号与安装历史被清掉 |
| `R-PROMPT-07` | 同一实例上两个写操作不交叉 | 两个 `update()` 同时读到同一份旧覆盖文件并各自落盘 | `prompt-store.js:62`、`prompt-store.js:84`、`prompt-store.js:101`、`prompt-store.js:115` | 后写覆盖前写 |
| `R-PROMPT-08` | 覆盖文件权限 `0600`、所在目录 `0700` | 覆盖文件是 `0644` | `prompt-store.js:78-80`、`prompt-store.js:109-111` | 提示词正文对本机其他用户可读 |
| `R-PROMPT-09` | 章节正文长度不超过 20000 字、不含 NUL | 写入 20001 字或带 NUL 的正文 | `prompt-store.js:69`、`prompt-store.js:105` | 写入被拒 |

## 9. 失败面

| 失败模式 | 表现 | 错误类型 / `status` | 失败后系统状态 | 能否重试 | 降级 |
| --- | --- | --- | --- | --- | --- |
| 覆盖文件不存在 | 当作无覆盖 | 无 | 不变 | — | 继续用仓内正文 |
| 覆盖文件不是合法 JSON | `load()` 抛错 | `SyntaxError` | 不变 | 修好文件后可以 | 无 |
| 提示词文件缺失（6 个核心之一或 `scenarios.json`） | `load()` 抛错 | `Error` / `ENOENT` | 不变 | 补回文件后可以 | 无 |
| 判据页缺失（`HIDS_WIKI_DIR` 指错、或判据页被删） | `load()` 抛错，报缺哪个文件 | `Error` / `ENOENT` | 不变 | 补回页面后可以 | 无 |
| 场景卡 id 不在 `wikiSop` 映射表里 | `path.join` 收到 `undefined`（推断，本仓没有实测触发） | `TypeError` | 不变 | 补上映射表后可以 | 无 |
| 章节名不在白名单 | `update()` 抛错 | `Error` / 无 `status` | 不变 | 换个章节名 | 无 |
| 正文不合法（非字符串 / 全空白 / 超长 / 带 NUL） | `update()` 抛错 | `Error` / 无 `status` | 不变 | 改正文 | 无 |
| 版本对不上（`expectedRevision` 或 `knowledgeRevision`） | `install()` / `update()` 抛错 | `Error` / `409` | 不变（未落盘） | 重新读当前版本后可以 | 无 |
| 章节集合或正文形状不合 | `install()` 抛错 | `Error` / `400` | 不变（未落盘） | 修包后可以 | 无 |
| 发布序号不前进 | `install()` 抛错 | `Error` / `409` | 不变（未落盘） | 换新包 | 无 |
| `release` 整个缺失 | `install()` 抛 `TypeError` | `TypeError` / 无 `status` | 不变（未落盘） | 补 `release` | 无 |
| `release` 缺 `version` 或 `sequence` | 装得上；版本号回落到 `scenarios.json` 的 `version`，序号检查放行 | 无 | 已落盘 | — | 无 |

两点补充：

- **写失败不留半成品**。两个写方法都是「先算好内容，再落盘」，落盘本身是临时文件 + `rename`
  （`prompt-store.js:79-81`、`prompt-store.js:110-112`）；`rename` 是同目录原子替换，中断不会留下半个覆盖文件。
- **检查与写之间存在时间窗**。第 1、2 道检查读的是当时的状态（`prompt-store.js:63-64`），
  落盘发生在其后（`prompt-store.js:78-81`）。同一个实例内的两个写操作被队列串起来（`R-PROMPT-07`），
  但不同实例之间不共享队列（`prompt-store.js:26` 的 `this.pending` 是实例字段）。

## 10. 资源与限额

| 项 | 数值 / 现状 | 依据 |
| --- | --- | --- |
| 一次 `load()` 的读盘次数 | 22 次 `readFile`：6 个核心文件 + `scenarios.json` + 14 份 SOP + 1 份覆盖文件 | `prompt-store.js:29`、`prompt-store.js:35`、`prompt-store.js:36`、`prompt-store.js:41-43` |
| 读盘并发度 | 6 个核心文件、场景卡、覆盖文件三路并发；14 份 SOP 也并发 | `prompt-store.js:34-37`、`prompt-store.js:41` |
| 章节数 | 21（6 核心 + 13 场景 + 2 SOP） | `prompt-store.js:18`、`prompt-store.js:52-55` |
| 单章节正文上限 | 20000 字（写与装都是这个数） | `prompt-store.js:69`、`prompt-store.js:105` |
| 覆盖文件大小上限 | 无显式上限；受 21 个章节各自的 20000 字约束 | `prompt-store.js:69`、`prompt-store.js:105` |
| 指纹长度 | 十六进制 16 位，即 64 位摘要 | `prompt-store.js:22` |
| 指纹计算量 | 一次 `JSON.stringify` 加一次 SHA-256，体积与生效正文总量成正比 | `prompt-store.js:22`、`prompt-store.js:45` |
| 缓存 | 无。`load()` / `snapshot()` / `metadata()` 每次调用都重新读盘 | `prompt-store.js:33`、`prompt-store.js:51`、`prompt-store.js:89` |

数据量本身由仓里的文件决定：当前 6 个核心文件、13 张场景卡、14 份 SOP 的正文合计 37680 字
（`metadata()` 报告的各章节 `characters` 之和，`prompt-store.js:92-96` 实测值：
核心 11182 + 场景 14415 + SOP 12083）。

## 11. 约束与理由

- **SOP 是只读的，这条纪律由两处代码共同保证**。`load()` 会读 `sop:common` 与 `sop:command_whitelist`
  两个覆盖键（`prompt-store.js:44`），而 `update()` 的白名单只收核心键与 `scenario:<id>` 键
  （`prompt-store.js:103`）。结果是：SOP 正文要么随整包安装整体换掉，要么手工改覆盖文件，
  局部接口碰不到它。
- **整包安装的四道检查分成三组**：前两道是「对得上吗」（当前版本、知识库版本，`prompt-store.js:65-66`），
  第三道是「长得对吗」（章节集合与正文形状，`prompt-store.js:67-70`），
  第四道是「往前进吗」（发布序号，`prompt-store.js:72-73`）。
- **两处写盘都是临时文件 + rename**（`prompt-store.js:79-81`、`prompt-store.js:110-112`），
  临时名带 UUID 且用 `flag: 'wx'` 防止覆盖已有文件；目录 `0o700`、文件 `0o600`。
- **指纹只比一次**。`install()` 与 `update()` 拿 `expectedRevision` 与当前 `revision` 做一次字符串相等比较
  （`prompt-store.js:65`、`prompt-store.js:106`）；截断到 64 位摘要之后不再做二次确认。
- **已知边界一**：写操作的串行化只在单个实例内成立（`prompt-store.js:26`）。
  两个 `PromptStore` 实例各写各的，没有跨实例的互斥。
- **已知边界二**：读方法不入队列（`prompt-store.js:33`、`prompt-store.js:50`、`prompt-store.js:88`），
  与写操作并发时可能读到写前或写后的状态。

## 12. 指针

- 本模块在整体结构中的位置见 [架构篇 §7.1](../architecture.md#71-提示词)。
- 模块归属与构件清单见 [\_breakdown.json](_breakdown.json) 的 `prompt-store` 条目。
- 本页的实测命令与原始输出见 [侦察记录](../../evidence/recon/P001-T012.md)：
  第九节是本页 77 个 `prompt-store.js` 锚点的清单（逐条附源码摘录），第十节是引用核对脚本。
