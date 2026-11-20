# hids-ai-console 变更半径考古（DDD 域边界用）

> 检索员：姜眠 | 生成时间：2026-11-20T16:29:56Z（UTC） | HEAD：`899ae2575604d5557e8202c55a3b5a558ab251af`（2026-11-21T00:22:09+08:00） | 范围：`/home/trtyr/code/hids-ai-console` | 只读，未改任何文件

---

## 一、要找什么

1. 最近 60 个提交的文件簇规模分布
2. 文件共现矩阵 top15
3. 「改 A 必然要改 B」的强耦合对，每对举一个具体提交作证
4. 反向：从没和别人一起改过的文件（边界清晰）

**假设声明（重要）**：题面给定的 `-60` 窗口按字面执行后**几乎不含源码**——60 个提交里只有 5 个碰了根目录 `.js`（`567268e`、`22dd4ec`、`f4c1ead`、`feacfa6`、`0018202`），其余 48 个是 docs/evidence/test。所以 `-60` 的共现矩阵本质是「文档同族矩阵」，对 DDD 域考古不够用。我按要求原样交付 `-60` 结果（表 A），**并额外扩到全历史 440 提交做源码层共现**（表 B）——那是这题真正要的答案。

---

## 二、找到了什么

### 2.1 提交簇规模分布

**`-60` 窗口（60 提交 → 53 个有文件，7 个 merge 空输出）**

| 改了几个文件 | 提交数 |
|---|---|
| 1 | **16** |
| 2 | 10 |
| 3 | 13 |
| 4 | 1 |
| 5 | 3 |
| **>5** | **10**（6×2、7×1、8×2、10×1、15×1、16×1、18×1、19×1） |

最大簇：`567268e`（19 文件）、`0018202`（18）、`42f1c64`（16）、`2d27b81`（15）——后三个是「门禁清零/收口」型横扫提交，改的是 docs+evidence。

**全历史（440 提交 → 367 个有文件，73 merge 空输出）**：1→118、2→59、3→50、4→17、5→22、**>5→101**。

### 2.2 共现矩阵 TOP15

**表 A — `-60` 窗口全文件（按题面口径）**

| # | 次数 | 文件对 | 证据提交 |
|---|---|---|---|
| 1 | 6 | `docs/architecture.md` + `docs/architecture/architecture.md` | 979970c, bec9e98, 35d55f0 |
| 2 | 6 | `docs/modules/triage-pipeline.md` + `evidence/recon/P003-T052.md` | b708c2d, 59e0875, 22dd4ec |
| 3 | 5 | `docs/architecture.md` + `docs/modules/prompt-store.md` | cb9c0a6, 8aebc0b, bec9e98 |
| 4 | 5 | `coding-reports/P003-T052.md` + `evidence/recon/P003-T052.md` | b708c2d, 22dd4ec, f4c1ead |
| 5 | 4 | `docs/modules/triage-pipeline.md` + `docs/modules/triage-rules.md` | 2d27b81, 59e0875, 22dd4ec |
| 6 | 4 | `coding-reports/P003-T052.md` + `docs/modules/triage-pipeline.md` | b708c2d, 22dd4ec, f4c1ead |
| 7 | 4 | `docs/modules/triage-pipeline.md` + `evidence/test/P003-T052/record-redaction.test.js` | 22dd4ec, f4c1ead, feacfa6 |
| 8 | 4 | `evidence/recon/P003-T052.md` + `evidence/test/P003-T052/record-redaction.test.js` | 22dd4ec, f4c1ead, feacfa6 |
| 9 | 3 | `coding-reports/P003-T055.md` + `docs/architecture.md` | 8aebc0b, 979970c, 2d27b81 |
| 10 | 3 | `coding-reports/P003-T055.md` + `docs/modules/prompt-store.md` | 8aebc0b, 9105884, 2d27b81 |
| 11 | 3 | `coding-reports/P003-T055.md` + `evidence/recon/P003-T055.md` | 9105884, 979970c, 2d27b81 |
| 12 | 3 | `docs/modules/prompt-store.md` + `evidence/recon/P003-T055.md` | 9105884, 3c05bb3, 2d27b81 |
| 13 | 3 | `docs/architecture/architecture.md` + `docs/modules/prompt-store.md` | bec9e98, 35d55f0, 2d27b81 |
| 14 | 3 | `docs/modules/knowledge-base.md` + `docs/modules/triage-pipeline.md` | 2d27b81, 59e0875, 0018202 |
| 15 | 3 | `docs/modules/trace-board.md` + `docs/modules/triage-pipeline.md` | 2d27b81, feacfa6, 0018202 |

> 三元组 top：`(coding-reports/P003-T052.md, docs/modules/triage-pipeline.md, evidence/recon/P003-T052.md)` 4 次；`(docs/modules/triage-pipeline.md, evidence/recon/P003-T052.md, record-redaction.js)` 3 次。

**表 B — 全历史源码层（根目录 28 个非测试 `.js` + `openapi.yaml`；已剔除 `a16e0d5` 快照导入的假共现）** ← DDD 用这张

| # | 次数 | 文件对 | 证据提交 |
|---|---|---|---|
| 1 | 27 | `openapi.yaml` + `server.js` | 2cfec66, ecf3393, eda72ce |
| 2 | 9 | `server.js` + `triage-monitor.js` | 64ff15b, c578620, a77d43a |
| 3 | 9 | `openapi.yaml` + `triage-monitor.js` | c578620, 201d278, a16e94b |
| 4 | 5 | `server.js` + `wiki-store.js` | ec1eeb7, 6757f51, d7328cc |
| 5 | 4 | `investigation-agent.js` + `openapi.yaml` | 6c76932, 9180bb8, 201d278 |
| 6 | 4 | `config-store.js` + `openapi.yaml` | 9180bb8, d7328cc, 429a005 |
| 7 | 4 | `config-store.js` + `server.js` | 9180bb8, d7328cc, 429a005 |
| 8 | 4 | `openapi.yaml` + `rule-store.js` | ec1eeb7, 6757f51, a16e94b |
| 9 | 4 | `openapi.yaml` + `wiki-store.js` | ec1eeb7, 6757f51, a16e94b |
| 10 | 4 | `evidence-view.js` + `investigation-agent.js` | 201d278, 241c0da, 10a8942 |
| 11 | 4 | `openapi.yaml` + `trace-board.js` | 201d278, 2252285, cd0e915 |
| 12 | 3 | `investigation-agent.js` + `server.js` | 567268e, 6c76932, 9180bb8 |
| 13 | 3 | `record-redaction.js` + `triage-monitor.js` | 22dd4ec, f4c1ead, 0018202 |
| 14 | 3 | `syslog-case.js` + `triage-monitor.js` | 0018202, 64ff15b, 201d278 |
| 15 | 3 | `fp-maintainer.js` + `openapi.yaml` | ac8fe3e, ecf3393, eda72ce |

### 2.3 强耦合对清单（|A∩B| == |A|，改 A 必带 B）

判据：A 出现在 N 个提交里，而这 N 个提交 B 全在（N/N）。已剔除快照导入 `a16e0d5`（一次塞进 27 个源文件，会把所有文件对都染成「必然」，是纯噪声）。

| 强耦合 | 强度 | 全部证据提交 | 具体作证 |
|---|---|---|---|
| `config-store.js` ⇒ `server.js` | **4/4** | 9180bb8, d7328cc, 429a005, 63ae9d3 | **429a005**「可写键六→五、失败路径清 tmp」：config-store.js 改写键表，server.js 改挂载路由，openapi.yaml 同步契约，三处同提交 |
| `config-store.js` ⇒ `openapi.yaml` | **4/4** | 同上 | **63ae9d3**「牧云与模型运行中可改、持久化且不回显」：config-store.js + openapi.yaml + server.js 三件套 |
| `evidence-view.js` ⇒ `investigation-agent.js` | **4/4** | 201d278, 241c0da, 10a8942, 0230c28 | **241c0da**「上下文瘦身·复审三处」：evidence-view.js +41 行裁剪逻辑，investigation-agent.js +14 行改调用口径 |
| `rule-store.js` ⇒ `openapi.yaml` | **4/4** | ec1eeb7, 6757f51, a16e94b, 3edcd51 | **3edcd51**「Rego 规则库与求值」：rule-store.js 新增 + openapi.yaml 加 schema + server.js 挂路由 |
| `record-redaction.js` ⇒ `triage-monitor.js` | **3/3** | 22dd4ec, f4c1ead, 0018202 | **22dd4ec**「废掉 reasonForRecord 徽标白名单」：triage-monitor.js 里 `record.steps.push({...detail: reasonForRecord(reason)...})` 与 record-redaction.js 的白名单实现同批改 |
| `cloudwalker.js` ⇒ `openapi.yaml` | **3/3** | a16e94b, 7ac5bab, 85c21cb | **85c21cb**「告警筛选与排序」：cloudwalker.js 取数口径 + openapi.yaml 契约同改 |
| `fp-maintainer.js` ⇒ `openapi.yaml` | **3/3** | ac8fe3e, ecf3393, eda72ce | **eda72ce**「误报统一维护 Agent」：fp-maintainer.js + wiki-workbench.js + openapi.yaml + server.js 四件套 |
| `wiki-workbench.js` ⇒ `openapi.yaml` | **3/3** | eda72ce, 6c76932, e997260 | **6c76932**「三域模型调用结构化事件 + 研判会话回放接口」 |
| `model-client.js` ⇒ `investigation-agent.js` | **2/2** | 9180bb8, 462010c | **462010c**「模型没交卷时失败记录带回包摘要」：model-client.js + investigation-agent.js 同提交 |
| `triage-rules.js` ⇒ `investigation-agent.js` | **2/2** | 567268e, a16e94b | **567268e**「记录侧最后三处原文出口过闸」：investigation-agent.js + server.js + triage-rules.js + update-store.js 四件套 |

**规律读法**：除 `record-redaction.js ⇒ triage-monitor.js` 外，几乎所有 N/N 强耦合都指向 **`openapi.yaml`**——契约文件是这仓库真实的「事务边界标记」：**改接口必改契约**。而 `record-redaction.js ⇒ triage-monitor.js` 是唯一一对「纯代码内部强耦合」，它对应一个横切关注点（记录侧脱敏）。

### 2.4 「边界清晰的模块」清单

**严格口径（全历史，任何提交中都没和别的源码同现过）= 空**——因为 `a16e0d5`（"Extract HIDS AI console backend from the SME lab snapshot."）一次把 27 个源文件全塞进来，这在统计上把所有人都连上了。这条严格口径在此仓库不可用。

按「剔除快照导入后」的可操作口径，分三档：

**A 档：自快照导入后再没被改过一次（完全冻结，边界最清晰）** — 全部出现于 `a16e0d5`

| 文件 | 入度/出度（import 图） | 提交 id |
|---|---|---|
| `agent-tools.js` | 2/3 | a16e0d5 |
| `api-tools.js` | 1/2 | a16e0d5 |
| `investigation-store.js` | 1/0 | a16e0d5 |
| `knowledge-store.js` | **0/0** | a16e0d5 |
| `mcp-client.js` | 1/0 | a16e0d5 |
| `rpc-client.js` | 2/0 | a16e0d5 |
| `triage-output.js` | 1/0 | a16e0d5 |

> 这 7 个是重构最安全的起点——三年没人碰过。但 `knowledge-store.js` 零入零出，是**死代码**；`investigation-store.js` 零出但 server.js 引它（`server.js:14`），是孤立小岛。

**B 档：无内部 import 依赖的叶子模块（不依赖任何同仓模块，边界天然清晰）**

| 文件 | 被谁依赖（入度） | 改动提交 |
|---|---|---|
| `record-redaction.js` | **9** | 22dd4ec, f4c1ead, 0018202 |
| `log.js` | **10** | 4d9c7b0, 432edfb, 7b706c7, 6c76932 |
| `cloudwalker.js` | 8 | a16e94b, 64ff15b, 85c21cb |
| `evidence-view.js` | 2 | 201d278, 241c0da, 10a8942, 0230c28 |
| `model-client.js` | 2 | 9180bb8, 462010c |
| `rpc-client.js` | 2 | a16e0d5 |
| `mcp-client.js` | 1 | a16e0d5 |
| `triage-output.js` | 1 | a16e0d5 |
| `investigation-store.js` | 1 | a16e0d5 |

> **`record-redaction.js` 和 `log.js` 是这仓库最干净的边界**：出度 0，别的模块只调它们的函数，不看内部。`record-redaction.js` 的 9 个消费点全是函数级调用（`server.js:25`、`triage-monitor.js:8`、`syslog-case.js:6`、`trace-board.js:6`、`triage-rules.js:6`、`update-store.js:4`、`wiki-replay.js:4`、`knowledge-workbench.js:2`、`required-evidence.js:1`）。`log.js` 的 10 个消费点同样全是函数级（`server.js:17`、`investigation-agent.js:5`、`config-store.js:16`、`fp-maintainer.js:21`、`maintenance-server.js:8`、`package-policy.js:7`、`syslog-case.js:5`、`syslog-input.js:3`、`triage-monitor.js:7`、`wiki-workbench.js:6`）。→ **这两个是天然的 shared-kernel 候选。**

**C 档：改动几乎不牵动别人的（平均源码同伴 ≤2）**

| 文件 | 改动次数 | 独改次数 | 平均同伴 | 提交 id |
|---|---|---|---|---|
| `package-policy.js` | 2 | 1 | 1.0 | b7e330f, 7b706c7 |
| `fp-maintainer.js` | 3 | 1 | 1.0 | ac8fe3e, ecf3393, eda72ce |
| `server.js` | 37 | 11 | 1.2 | 37 次，含 567268e, 9180bb8, 64ff15b |
| `wiki-workbench.js` | 3 | 1 | 1.7 | eda72ce, 6c76932, e997260 |
| `investigation-agent.js` | 15 | 4 | 1.7 | 0230c28, 201d278, 10a8942, 567268e |
| `triage-monitor.js` | 18 | 3 | 1.8 | 22dd4ec, f4c1ead, 201d278 |
| `log.js` | 4 | 0 | 2.0 | 4d9c7b0, 432edfb, 6c76932 |
| `config-store.js` | 4 | 0 | 2.0 | 9180bb8, d7328cc, 429a005, 63ae9d3 |
| `prompt-store.js` | 4 | 0 | 2.0 | 6757f51, d7328cc, 9180bb8, 5256d0e |

### 2.5 交叉验证：import 图 vs git 共现（本次考古最有价值的副产物）

用 `import ... from './x.js'` 抽出根目录 28 个非测试模块的依赖图，与 git 共现对照：

**（a）git 共现 ≥2 且确有 import 关系**（20 对，历史信号可信）：`server.js↔triage-monitor.js`(10)、`server.js↔wiki-store.js`(6)、`evidence-view.js↔investigation-agent.js`(5)、`investigation-agent.js↔server.js`(4)、`syslog-case.js↔triage-monitor.js`(4)、`config-store.js↔server.js`(4)、`prompt-store.js↔server.js`(4)、`prompt-store.js↔wiki-store.js`(4)、`record-redaction.js↔triage-monitor.js`(3)、`server.js↔wiki-workbench.js`(3)、`log.js↔server.js`(3)、`rule-store.js↔server.js`(3)、`rule-store.js↔wiki-store.js`(3)、`investigation-agent.js↔wiki-store.js`(3)、`cloudwalker.js↔triage-monitor.js`(3)、`server.js↔trace-board.js`(3)、`cloudwalker.js↔server.js`(3)、`server.js↔triage-rules.js`(2)、`server.js↔update-store.js`(2)、`fp-maintainer.js↔server.js`(2)。

**（b）有 import 关系但 git 从未共现（历史信号会骗人的 11 条）**：
`rule-store.js→config-store.js`、`server.js→record-redaction.js`、`triage-rules.js→record-redaction.js`、`update-store.js→record-redaction.js`、`config-store.js→log.js`、`config-store.js→rpc-client.js`、`fp-maintainer.js→log.js`、`fp-maintainer.js→rule-store.js`、`maintenance-server.js→log.js`、`package-policy.js→log.js`、`syslog-case.js→log.js`。

> 全部是 **0 次共现**——说明这些依赖是「建好就没再动过」的接缝，重构时**不会**被 git 历史提醒。`record-redaction.js` 被 9 个模块 import 却只与 `triage-monitor.js` 有过 3 次共现，就是典型：横切关注点扩散全仓，但历史只记录了其中一条线。

**（c）组合根**：`server.js` 一行 import 20 个内部模块（`server.js:8-29`），是唯一入度为 0 的编排者；`investigation-agent.js` 出度 10（`investigation-agent.js:4-13`），是第二大扇出。

**（d）模块↔自身测试文件的共现度**（重构时搬测试的成本信号）：`triage-monitor.js` 11/19、`investigation-agent.js` 8/16、`rule-store.js` 2/4、`trace-board.js` 2/6 —— 而 **`server.js` 0/38、`wiki-store.js` 0/9、`prompt-store.js` 0/5、`log.js` 0/4、`config-store.js` 0/4**：这些模块的测试不在根目录同名字段，而在 `evidence/test/P003-T0xx/` 下按任务卡散落。

---

## 三、怎么找的

```bash
cd /home/trtyr/code/hids-ai-console
git rev-parse HEAD                      # 899ae2575604d5557e8202c55a3b5a558ab251af
git log --name-only --pretty=format:'---%h' -60 > /tmp/w60.txt   # 窗口 A
git log --name-only --pretty=format:'---%h'      > /tmp/wall.txt # 全历史
git log --merges --oneline | wc -l        # 73 → merge 提交 --name-only 默认不出文件，统计中被排除
git show --stat --oneline a16e0d5         # 确认快照导入：249 文件、27 个源文件一次入仓
```

```bash
# import 图（ESM，非 require）
for f in *.js; do case "$f" in *.test.js) continue;; esac
  grep -nE "^import .*from '\./" "$f"; done
# 或 python: re.findall(r"from\s+'\./([^']+\.js)'", txt)
```

共现/蕴含/分布统计用 `python3` 现场跑 `itertools.combinations` + `collections.Counter`（未落任何文件到仓库，临时文件只在 `/tmp`）。

---

## 四、没找到 / 拿不准的

- **严格意义的「从没和别人一起改过」的源码文件：0 个**。原因单一且已定位——`a16e0d5` 快照导入一次入仓 27 个源文件。已在 2.4 给出可操作的三档替代口径。
- **`-60` 窗口的源码层共现样本太薄**：只有 5 个提交碰源码，N/N 蕴含关系在 n=1 的样本上无统计意义。表 A 是按题面口径原样交付，**不可直接当耦合证据用**；请以表 B 为准。
- **merge 提交的改动被系统性排除**：`git log --name-only` 对 73 个 merge 默认不输出文件（我用 `git show -m` 逐个核对过，确实藏有源码改动，如 `72ebf16` 19 个、`843a971` 24 个）。本报告的共现数因此是**下界**，真实改动簇比这里看到的大。
- **未验证**：`docs/architecture.md` 与 `docs/architecture/architecture.md` 是同名的两份文件（6/6 共现），疑似历史遗留重复，本次未查证二者内容差异。

---

## 五、下一步建议（只指方向，不下命令）

- 埋点方向：域边界不只在 git 簇里，也在 **import 图 + openapi.yaml 契约**这两条线上；`record-redaction.js` / `log.js` 这类「出度 0」模块是最稳的切缝候选。
- 复核方向：merge 提交（73 个）用 `git show -m` 展开后重跑共现，得到完整改动簇；这是当前结果的下界补全。
- 取证方向：模块↔自身测试的共现度落差（`server.js` 0/38）指向测试布局问题，域拆分时要一并决定测试归属。
- 外部查证不在本地范围内（本仓库全量历史已覆盖 440 提交）。

---

**FOUND** — 变更半径考古完成：`-60` 窗口共现矩阵 top15 + 源码层全历史 top15 + 10 组 N/N 强耦合对（每组带全部证据提交 id）+ 三档「边界清晰模块」清单（7 冻结 / 9 叶子 / 9 低牵动），全部附可复跑命令；报告未落盘（只读任务，内容即本回复）。