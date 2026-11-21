---
type: module
id: MOD-MODEL-CLIENT
covers: [src/contexts/triage/infrastructure/model-client.js]
updated: 2026-11-20
---

# 模型客户端（model-client）

这页讲 `model-client` 这个模块：它对外提供哪两个入口、一次模型请求在模块内部走过哪几步、失败时抛什么错。
覆盖的实现文件只有一个：`model-client.js`（37 行）。

**读法**：想知道「后端整体怎么拼起来」先读 [架构篇](../architecture.md)；只想改模型调用这一层，看本页够了。

**证据约定**：本页断言的出处就写在同一行的 `model-client.js:行号` 里，行号对应提交 `35530d8`（本卡写作时的 HEAD）。
标 🟢 的结论是代码里直接看得见的；标 🟡 的是由代码结构推出来的，推的依据写在同一句里。查不到的东西不写成本页结论，
收在第 10 节「边界与未决」，并在 `coding-reports/P001-T005.md` 的「未决」小节留了一份。

## 1. 模块定位与职责

**模块名**：`model-client`。**实现文件**：`model-client.js`，模块内没有别的实现文件，也没有任何 `import`——
它不依赖仓内其他模块，只依赖运行时提供的 `fetch`、`AbortSignal` 与 `URL`（🟢 `model-client.js:1-37`）。

**职责**（一句话）：把「向模型服务发一次请求并取回一条消息」这件事包起来，包括拼请求体、定超时、
把上游的失败翻译成本模块统一的错误信息、以及判断环境变量够不够装配出一个可用实例（🟢 `model-client.js:2`、
`model-client.js:14`、`model-client.js:33`）。

**做什么**：

- 校验构造参数：地址、密钥、模型名三样缺一不可（🟢 `model-client.js:3-5`）。
- 把基地址拼成模型服务的补全端点 URL（🟢 `model-client.js:6-7`）。
- 组装请求体，两种形态二选一：带工具的调用请求，或要求 JSON 输出的普通补全（🟢 `model-client.js:15-17`）。
- 给单次请求挂一个超时信号（🟢 `model-client.js:22`）。
- 解析响应并挑出 `choices[0].message`；上游出错时抛中文错误（🟢 `model-client.js:25-29`）。
- 从环境变量装配实例；必填的三项（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`）里缺哪一项都返回 `null`（🟢 `model-client.js:33-36`）。

**不做什么**（本模块代码里找不到这些行为）：

- **不重试**。请求失败即抛错，没有重试次数、退避或幂等处理（🟢 `model-client.js:18-29`）。
- **不做流式**。请求体里 `stream` 固定为 `false`，模块也不处理增量响应（🟢 `model-client.js:15`）。
- **不校验入参**。`messages` 的内容与格式不被检查；`messages` 传 `undefined` 时该字段在请求体里直接消失，
  传 `null` 时原样发出（🟢 `model-client.js:15`；实测见第 11 节命令 C）。
- **不裁剪上下文**。`messages` 整体进请求体，模块不限制条数或长度（🟢 `model-client.js:15`）。
- **不落盘、不持有请求状态**。模块的代码路径里没有对实例字段的再写入（调用方自己改字段是另一回事），
  请求体是每次调用新建的局部变量（🟢 `model-client.js:8-11`、`model-client.js:15`）。
- **不决定用哪个模型**。模型名由调用方或环境变量给出（🟢 `model-client.js:5`、`model-client.js:9`、`model-client.js:35`）。

## 2. 对外能力

本模块的公开面（对外暴露的能力）只有两个导出物（🟢 实测：`node --input-type=module -e "import * as m from './model-client.js'; console.log(Object.keys(m))"`
输出 `[ 'ChatModelClient', 'createModelFromEnv' ]`）。

| 能力 | 入口 | 入参 | 出参 | 证据 |
| --- | --- | --- | --- | --- |
| 对话补全（要求 JSON 输出） | `ChatModelClient.complete(messages)` | 消息数组 | 模型返回的 `message` 对象 | `model-client.js:14`、`model-client.js:17`、`model-client.js:29` |
| 工具调用请求 | `ChatModelClient.complete(messages, tools, toolChoice)` | 消息数组 + 工具定义数组 + 工具选择策略 | 模型返回的 `message` 对象 | `model-client.js:16`、`model-client.js:29` |
| 构造并校验实例 | `new ChatModelClient({ baseUrl, apiKey, model, timeoutMs?, fetcher? })` | 基地址、密钥、模型名；后两项可选 | 实例 | `model-client.js:2-12` |
| 从环境变量装配实例 | `createModelFromEnv(env?, fetcher?)` | 变量表（默认取 `process.env`） | 实例，或 `null` | `model-client.js:33-37` |

构造参数的两个可选项都有实际作用，不是摆设：

- `timeoutMs`：单次请求超时毫秒数，不传时取 `90000`（🟢 `model-client.js:2`、`model-client.js:10`）。
- `fetcher`：实际发请求的函数，不传时取运行时的全局 `fetch`；它是本模块唯一的测试切入点（🟢 `model-client.js:2`、
  `model-client.js:11`、`model-client.js:18`）。

`createModelFromEnv` 的两个可选参数同理：`env` 默认是 `process.env`，`fetcher` 默认是全局 `fetch`（🟢 `model-client.js:33`）。

## 3. 关键路径

本模块有三条路径：造实例、发一次请求、从环境变量造实例。三条路径的先后顺序由代码写死，下面的行号就是顺序。

### 3.1 路径一：构造实例（`new ChatModelClient`）

1. 校验基地址：必须以 `http://` 或 `https://` 开头，否则抛 `LLM_BASE_URL 必须是 HTTP(S) 地址`（🟢 `model-client.js:3`）。
   这一步只看前缀，大小写敏感——`HTTP://h/v1` 会被拒（🟢 前缀正则见 `model-client.js:3`；实测见第 11 节命令 A）。
2. 校验密钥：为空或为 falsy 值（`''`、`0` 等）抛 `缺少 LLM_API_KEY`（🟢 `model-client.js:4`）。
3. 校验模型名：同样为空或 falsy 抛 `缺少 LLM_MODEL`（🟢 `model-client.js:5`）。
4. 基地址末尾没有 `/` 就补一个，再以它为基准解析出 `chat/completions` 端点（🟢 `model-client.js:6-7`）。
   实测：`http://h/v1` 与 `http://h/v1/` 都得到 `http://h/v1/chat/completions`；`https://h` 得到
   `https://h/chat/completions`；`http://h/a/b` 得到 `http://h/a/b/chat/completions`（第 11 节命令 B）。
5. 把密钥、模型名、超时毫秒数、fetcher 存进实例字段（🟢 `model-client.js:8-11`）。

> 校验顺序是 baseUrl → apiKey → model。三个都不合法时先报 baseUrl 那条（🟢 `model-client.js:3-5`；实测见第 11 节命令 A）。
>
> 一个例外：基地址通过了前缀校验但整体不是合法 URL 时，抛出的不是本模块的中文提示，而是运行时 `new URL` 抛的
> `Invalid URL`（如 `http://`）（🟢 抛错点在 `model-client.js:7`，前缀校验在 `model-client.js:3`；实测见第 11 节命令 A）。

### 3.2 路径二：发一次请求（`complete`）

1. 建请求体：固定带上 `model`（实例里的模型名）、`messages`（调用方给的）、`temperature: 0`、`stream: false`（🟢 `model-client.js:15`）。
2. 二选一：传入的工具数组非空 → 请求体带 `tools` 与 `tool_choice`（默认 `'auto'`，可由第三个参数改写）；
   工具数组为空 → 请求体改带 `response_format: { type: 'json_object' }`。两条分支互斥，同一次请求不会同时出现（🟢 `model-client.js:16-17`）。
3. 发请求：`POST`，头是 `Content-Type: application/json` 与 `Authorization: Bearer <密钥>`，
   体是请求体的 JSON 序列化，并挂上 `AbortSignal.timeout(实例超时毫秒数)` 产生的信号（🟢 `model-client.js:18-23`）。
4. 解析响应体。`response.json()` 抛错（响应不是 JSON）→ 抛 `模型接口 HTTP <状态码> 未返回 JSON`（🟢 `model-client.js:24-25`）。
5. 判断失败：`response.ok` 为假，或响应体里有 `error` 字段 → 抛 `模型接口 HTTP <状态码>: <上游信息>`（🟢 `model-client.js:26`）。
6. 取消息：`body.choices?.[0]?.message`（🟢 `model-client.js:27`）。
7. 判定可用：取不到 `message`，或 `message.content` 为空且没有 `tool_calls` → 抛 `模型没有返回可用消息`；
   否则把 `message` 原样返回（🟢 `model-client.js:28-29`）。

### 3.3 路径三：从环境变量装配（`createModelFromEnv`）

1. 读三个必填变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。判断条件是「值为 falsy」，
   所以 `undefined`、空串、其它 falsy 值都会让装配提前结束，立即返回 `null`——不抛错（🟢 `model-client.js:34`）。
2. 读可选变量 `LLM_TIMEOUT_MS`：转成数字后大于 0 才采用，否则回落到 `90000`（🟢 `model-client.js:36`）。
3. 用读到的值构造 `ChatModelClient` 并返回（🟢 `model-client.js:35-36`）。

> 返回 `null` 而不是抛错，是这个模块与上游装配的约定：调用方据此知道「这次没有模型可用」。
> 本页不展开调用方怎么用这个 `null`——调用点不在本卡的证据源清单内（见第 10 节）。

## 4. 覆盖构件

拆卡清单给本模块定的覆盖构件有四项：对话补全、工具调用请求、超时与错误翻译、环境变量装配（🟢 清单出处：
`docs/modules/_breakdown.json` 的 `model-client` 条目 `components` 字段）。逐个点名如下。

### 4.1 对话补全

**是什么**：不带工具的普通请求。调用方给一串消息，模型回一条消息；为了让下游能直接解析，请求体里额外要求
模型输出 JSON（🟢 `model-client.js:17`）。

**输入**：`messages` 数组。模块不检查它的结构（🟢 `model-client.js:15`）。

**输出**：`body.choices[0].message` 对象本身，不做任何加工——`role`、`content` 等字段原样带回（🟢 `model-client.js:27-29`；
实测返回 `{"role":"assistant","content":"hello"}`，见第 11 节命令 F）。

**边界**：

- `messages` 为 `undefined` 时，请求体里没有 `messages` 这个键（🟢 `model-client.js:15`，序列化行为见第 11 节命令 C）。
- `messages` 为 `null` 时，请求体里是 `"messages":null`（同上）。
- 模型返回的 `message.content` 为空串、又没有 `tool_calls` 时，模块判为「没有可用消息」并抛错（🟢 `model-client.js:28`）。
- `temperature` 固定为 `0`，调用方改不了（🟢 `model-client.js:15`）。

### 4.2 工具调用请求

**是什么**：请求体多带 `tools` 与 `tool_choice` 两个字段，让模型可以反过来要求调用工具（🟢 `model-client.js:16`）。

**输入**：第二个参数是工具定义数组（非空才走这条分支），第三个参数是工具选择策略，缺省 `'auto'`（🟢 `model-client.js:14`、`model-client.js:16`）。

**输出**：与对话补全相同——`choices[0].message`。只有 `tool_calls`、没有 `content` 的消息算可用，原样返回（🟢 `model-client.js:28-29`；
实测见第 11 节命令 C 的末行）。

**边界**：

- 工具数组为空时，本模块改走对话补全分支，请求体里出现 `response_format` 而不是 `tools`（🟢 `model-client.js:16-17`）。
  两条分支互斥：一次请求不会出现 `response_format` 与 `tools` 同时存在（🟢 同上）。
- `tool_choice` 只在有工具时出现；无工具分支里不存在这个键（🟢 `model-client.js:16-17`）。
- `tool_choice` 的取值由调用方给，模块不校验（🟢 `model-client.js:16`；实测传 `'required'` 时原样发出，见第 11 节命令 B）。
- 工具定义数组被原样放进请求体，模块不改写、不筛选（🟢 `model-client.js:16`）。

### 4.3 超时与错误翻译

**超时怎么做**：每次请求挂一个 `AbortSignal.timeout(实例超时毫秒数)` 产生的信号（🟢 `model-client.js:22`）。
超时时长来自构造参数 `timeoutMs`，不传时是 `90000` 毫秒（🟢 `model-client.js:2`、`model-client.js:10`）。

**超时会真的中断**：起一个不响应的本地 HTTP 服务、用真实 `fetch` 请求，超时毫秒数设 800，请求在超时点被中断。
这个断言的可复跑证据是命令 G 里的窗口判定（实测耗时落在 800–2000 毫秒之间），而不是一个固定数字——
本卡实测是 806 毫秒，这个值随机器与负载浮动。抛的是 `DOMException`，`name` 为 `TimeoutError`，
`message` 为 `The operation was aborted due to timeout`（🟢 实测，见第 11 节命令 G）。

**错误翻译的范围**：模块只翻译「已经拿到 HTTP 响应」之后的问题。翻译规则有三条（🟢 `model-client.js:25-26`、`model-client.js:28`）：

| 触发条件 | 抛出的错误 | 证据 |
| --- | --- | --- |
| 响应体不是 JSON | `模型接口 HTTP <状态码> 未返回 JSON` | `model-client.js:25` |
| `response.ok` 为假，或响应体里有 `error` 字段 | `模型接口 HTTP <状态码>: <上游信息>` | `model-client.js:26` |
| 取不到可用消息 | `模型没有返回可用消息` | `model-client.js:28` |

**没被翻译的两类错误**（容易踩，单独列）：

- **超时**：抛的是运行时的 `TimeoutError`，原文是英文，模块没有把它包成中文提示（🟢 超时信号在 `model-client.js:22`，
  翻译逻辑只覆盖 `model-client.js:25-28` 这几行；实测见第 11 节命令 G）。
- **连不上模型服务**：抛的是运行时的 `TypeError: fetch failed`，同样没有中文包装（🟢 实测见第 11 节命令 G）。

两者的成因都是请求在拿到 HTTP 响应之前就失败了，翻译逻辑（`model-client.js:25-28`）还没轮到执行。

### 4.4 环境变量装配

**是什么**：把三个必填变量加一个可选变量装配成实例；变量不齐就返回 `null`（🟢 `model-client.js:33-36`）。

**输入**：变量表，缺省取 `process.env`（🟢 `model-client.js:33`）。

**输出**：`ChatModelClient` 实例，或 `null`（🟢 `model-client.js:34-36`）。

| 变量 | 缺了会怎样 | 不合法时 | 证据 |
| --- | --- | --- | --- |
| `LLM_BASE_URL` | 返回 `null` | 前缀不是 `http://` / `https://` 时构造抛错 | `model-client.js:3`、`model-client.js:34` |
| `LLM_API_KEY` | 返回 `null` | 为空串时构造抛 `缺少 LLM_API_KEY` | `model-client.js:4`、`model-client.js:34` |
| `LLM_MODEL` | 返回 `null` | 为空串时构造抛 `缺少 LLM_MODEL` | `model-client.js:5`、`model-client.js:34` |
| `LLM_TIMEOUT_MS` | 回落到 `90000` | 转成数字后不是正数时回落到 `90000`；是正数就照用，不管是不是整数或有限值 | `model-client.js:36` |

实测的取值行为（🟢 第 11 节命令 E）：

- `'5000'` → `5000`；`'  3000  '`（带空格）→ `3000`；`'1e4'` → `10000`；`'1.5'` → `1.5`（小数原样保留）。
- `'0'`、`'-1'`、`'abc'`、`''` → 都是 `90000`（这四种分别落在「零」「负数」「非数字文本」「空串」四类里）。
- 反例一：`'1.5'` 是正数、但不是整数 → 不回落到 `90000`，装配出 `1.5`（见下段）。
- 反例二：`'1e999'` 与 `'Infinity'` 转成 `Infinity`，它是正数但不有限 → 同样不回落到 `90000`，装配出 `Infinity`。

所以「非正数回落」这条只盖住那四类；正数里的小数与无穷大都会被原样收下，靠发请求那一步的运行时拦。

注意 `'1.5'` 这一条：模块只判「大于 0」，小数照样装配进实例（🟢 `model-client.js:36`）。到了发请求那一步，
`AbortSignal.timeout` 要求毫秒数是整数，非整数会被它拒绝——本机 Node.js v26.13.0 上抛的是
`RangeError`（`code=ERR_OUT_OF_RANGE`，原文 `The value of "delay" is out of range. It must be an integer. Received 1.5`）。
这个错误不在模块的三条翻译规则覆盖范围内（见第 4.3 节），会以原始形态抛给调用方（🟢 实测，见第 11 节命令 I）。

`Infinity` 走同一条路：装配不拦，发请求时被 `AbortSignal.timeout` 拒。抛的也是 `RangeError`，
`code=ERR_OUT_OF_RANGE`，原文的尾缀是 `Received Infinity`（🟢 实测，见第 11 节命令 I）。

## 5. 值语义：参数与返回值

下表是本模块对外的入参与出参。「单位」一列写的是这个量的度量方式——本模块的量只有超时是带单位的（毫秒），
其余是文本、数组与函数，不带单位。

| 名称 | 类型 | 单位 | 缺省 / 必填 | 空值与非法值的处理 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `baseUrl` | string | — | 必填 | 空串或非 `http(s)://` 前缀 → 构造抛 `LLM_BASE_URL 必须是 HTTP(S) 地址` | `model-client.js:3` |
| `apiKey` | string | — | 必填 | 空串或其他 falsy 值 → 构造抛 `缺少 LLM_API_KEY` | `model-client.js:4` |
| `model` | string | — | 必填 | 空串或其他 falsy 值 → 构造抛 `缺少 LLM_MODEL` | `model-client.js:5` |
| `timeoutMs` | number | 毫秒（ms） | 缺省 `90000` | 构造时不做校验；由 `createModelFromEnv` 装配时，非正数回落为 `90000`，正数则原值采用（不要求整数或有限）；非整数与 `Infinity` 不拦，发请求时由运行时抛 `RangeError` | `model-client.js:2`、`model-client.js:10`、`model-client.js:22`、`model-client.js:36` |
| `fetcher` | function | — | 缺省取运行时全局 `fetch` | 不校验 | `model-client.js:2`、`model-client.js:11` |
| `messages` | array | — | `complete` 的第一个参数，必传 | 不校验；`undefined` 时请求体里没有这个键，`null` 时原样发出 | `model-client.js:14`、`model-client.js:15` |
| `tools` | array | — | 缺省 `[]` | 空数组 → 走不带工具的分支；非空数组原样进请求体 | `model-client.js:14`、`model-client.js:16` |
| `toolChoice` | string | — | 缺省 `'auto'` | 不校验，原样进请求体 | `model-client.js:14`、`model-client.js:16` |
| 返回值 `message` | object | — | — | 取不到 `message`，或 `content` 为空且无 `tool_calls` → 抛 `模型没有返回可用消息` | `model-client.js:27-29` |
| `env` | object | — | 缺省取 `process.env` | 三项必填变量（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`）缺哪一项都返回 `null`，不抛错 | `model-client.js:33`、`model-client.js:34` |
| 返回值（装配函数） | 实例 或 `null` | — | — | `null` 表示「环境变量不够，没装配出模型」 | `model-client.js:34-36` |

## 6. 行为承诺

下面的编号是本模块的行为承诺，测试用例可以逐条回指。每条都写清了反例——反例成立就说明这条承诺被破坏。

| 编号 | 陈述 | 反例 | 依据 | 违反症状 |
| --- | --- | --- | --- | --- |
| `R-MODEL-CLIENT-01` | 一次请求的请求体里，`tools` 与 `response_format` 不会同时出现 | 带工具的请求里同时出现 `response_format` | `model-client.js:16-17` | 模型同时收到两种输出约束，回什么全凭它心情 |
| `R-MODEL-CLIENT-02` | 基地址末尾有没有 `/`，拼出的端点相同 | `http://h/v1` 与 `http://h/v1/` 拼出两个不同端点 | `model-client.js:6-7` | 同一份配置换个写法就打到别的路径 |
| `R-MODEL-CLIENT-03` | `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 缺哪一项，装配函数都返回 `null` 而不是抛错 | 缺 `LLM_MODEL` 时抛异常 | `model-client.js:34` | 没配模型的进程直接崩在启动路上 |
| `R-MODEL-CLIENT-04` | `LLM_TIMEOUT_MS` 不是正数时，单次请求超时按 `90000` 毫秒算 | 把它设成 `'0'` 后超时变成 0 毫秒 | `model-client.js:36` | 请求立刻超时，而不是等满 90 秒 |
| `R-MODEL-CLIENT-05` | 抛出的错误信息里，上游原文最多保留 250 字符 | 上游给出 400 字符的报错信息，错误消息里完整保留 | `model-client.js:26` | 超长上游报文顺着错误链进日志 |
| `R-MODEL-CLIENT-06` | 只有 `tool_calls`、没有 `content` 的回复不算失败 | 这种回复被判为「模型没有返回可用消息」 | `model-client.js:28-29` | 工具调用被当成空回复丢掉 |
| `R-MODEL-CLIENT-07` | 每次请求都带一个超时信号；模型迟迟不回应时，请求会在超时后中断而不是一直挂着 | 注入一个不响应的服务后请求永久挂起 | `model-client.js:22`（实测见第 11 节命令 G） | 调用方被一个不响应的模型服务永久占住 |
| `R-MODEL-CLIENT-08` | 一次 `complete()` 至多发出一个 HTTP 请求，失败不重试 | 同一个 `complete()` 里因 500 重发一次 | `model-client.js:18-29` | 重试放大上游压力，也可能重复计费 |
| `R-MODEL-CLIENT-09` | 模块不校验超时毫秒数是不是整数、是不是有限值；非整数与 `Infinity` 都会在发请求时被运行时的 `AbortSignal.timeout` 拒绝 | 传 `1.5` 或 `1e999` 时模块先拦下来，报本模块的中文错误 | `model-client.js:22`、`model-client.js:36`（实测见第 11 节命令 I） | 配置里写错小数或无穷大，调用方收到一个与本模块无关的英文 `RangeError` |

## 7. 失败面

本模块失败时只有一种表现：抛异常（唯一的例外是环境变量不齐时返回 `null`）。模块内部不留状态——
模块的代码路径里没有对实例字段的再写入，请求体是每次调用新建的局部变量（🟢 `model-client.js:8-11`、`model-client.js:15`），
所以失败之后可以直接发起下一次调用，不需要清理。

| 失败模式 | 抛什么 | 失败后状态 | 能否重试 | 有无降级 |
| --- | --- | --- | --- | --- |
| 构造参数不合法 | `Error`，中文提示（哪一项不合法就报哪一项） | 实例没建出来 | 改配置后可以 | 无 |
| 响应体不是 JSON | `Error`：`模型接口 HTTP <状态码> 未返回 JSON` | 模块内无残留 | 可以，同输入重试的结果取决于上游 | 无 |
| HTTP 状态非成功 | `Error`：`模型接口 HTTP <状态码>: <上游信息>` | 模块内无残留 | 可以 | 无 |
| 响应体带 `error` 字段（HTTP 200 也会触发） | `Error`：`模型接口 HTTP <状态码>: <上游信息>` | 模块内无残留 | 可以 | 无 |
| 取不到可用消息 | `Error`：`模型没有返回可用消息` | 模块内无残留 | 可以 | 无 |
| 请求超时 | `DOMException`，`name` 为 `TimeoutError`，英文原文 | 模块内无残留 | 可以 | 无（不翻译成中文提示） |
| 超时毫秒数不是整数或不是有限值 | `RangeError`，`code=ERR_OUT_OF_RANGE`（运行时抛的，未翻译） | 模块内无残留 | 改成正整数后可以 | 无 |
| 连不上模型服务 | `TypeError`：`fetch failed` | 模块内无残留 | 可以 | 无（不翻译成中文提示） |
| 必填环境变量不齐 | 不抛错，装配函数返回 `null` | 模块内无残留 | 补齐变量后可以再装配 | 由调用方决定怎么用这个 `null` |

「能否重试」一列说的是**这个模块自己会不会重试**：不会重试，也不阻止调用方重试。

错误消息的三个细节（🟢 `model-client.js:25-26`）：

- 上游原文只保留前 250 字符，超出部分被截掉（`R-MODEL-CLIENT-05`）。
- 上游 `error` 字段是字符串而不是对象时，取不到 `.message`，错误消息里用「请求失败」占位。
- 响应体带 `error` 字段时，消息里的状态码取的是实际 HTTP 状态码——HTTP 200 也照抄成 200。

## 8. 资源与余量

| 项 | 数值 / 行为 | 来源 |
| --- | --- | --- |
| 单次 `complete()` 的 HTTP 请求数 | 至多 1 个 | 🟢 `model-client.js:18`（`fetcher` 只被调用一次）；`R-MODEL-CLIENT-08` |
| 单次请求超时 | 缺省 90000 毫秒；`createModelFromEnv` 装配时由 `LLM_TIMEOUT_MS` 决定 | 🟢 `model-client.js:2`、`model-client.js:22`、`model-client.js:36` |
| 超时上限 | 模块不设上限——`LLM_TIMEOUT_MS` 给多大就照用多大 | 🟢 `model-client.js:36`（只判 `> 0`） |
| 请求体大小 | 模块不限制，`messages` 原样进请求体 | 🟢 `model-client.js:15` |
| 响应体读法 | 一次性读完整份 JSON（`await response.json()`），不分块、不截断 | 🟡 `model-client.js:25`（代码里只看到这一次 `await response.json()`） |
| 并发使用 | 同一个实例可以被并发调用：请求体是方法内的局部变量，模块的代码路径里没有对实例字段的再写入 | 🟡 依据 `model-client.js:8-11` 与 `model-client.js:15`（模块没有内部状态可被并发写坏） |

「读法」一行是 🟡：代码里只看到一次性 `await response.json()`，由此推断响应体整份进内存、不分块处理；
模块里没有与之矛盾的分支（🟢 `model-client.js:25`）。

## 9. 约束与理由

**硬约束**：

- 本模块没有任何 `import`，不依赖仓内其他模块（🟢 `model-client.js:1-37`）。
- 用到三个运行时内建：`URL`（拼端点，`model-client.js:7`）、`fetch`（发请求，`model-client.js:18`）、
  `AbortSignal.timeout`（超时信号，`model-client.js:22`）。三者都由运行时提供，模块自己不带实现；
  在本机 Node.js v26.13.0 上 `typeof AbortSignal.timeout` 为 `function`（第 11 节命令 H）。
- 密钥只出现在 `Authorization` 头里，不进 URL、不进请求体（🟢 `model-client.js:20-21`：头与体是分开写的，
  请求体只由 `payload` 序列化而来）。

**代码里能看出来的取舍**：

- 端点拼接固定用相对路径 `chat/completions` 配 `new URL` 解析，而不是字符串硬拼（🟢 `model-client.js:6-7`）。
  好处是基地址带不带末尾 `/` 都能落到同一个端点（`R-MODEL-CLIENT-02`）。
- 上游错误原文截断到 250 字符再拼进错误消息（🟢 `model-client.js:26`），避免超长报文顺着错误链传下去。

**代码里没有记录、因而不在本页下结论的**（见第 10 节）：为什么不做重试、为什么截断长度取 250、
为什么传输层错误不翻译。这些属于「该怎么做」的判断，按本仓文档的分工留给评审，不在本页写。

## 10. 边界与未决

**本页的射程之外**（这些不写成本页结论，只给去处）：

- **谁调用这个模块、在哪里装配**：调用点不在本卡给的证据源清单内，本页不展开；全局装配关系见
  [架构篇第 4 节](../architecture.md)。
- **模型服务端的行为**（协议细节、错误码含义、重试建议）：本仓只有请求侧代码，服务端不是本仓的真源。
- **提示词与判据正文**：与本模块无关，归提示词与判据库各自的流程管。

**🔴 查不到、本页不给结论的五条**（代码里既没有实现依据，也没有注释或文档说明）：

1. 重试该由本模块做还是调用方做——文件里没有重试代码，也没有一句话说明归属。
2. 上游错误原文截断到 250 字符，这个数字是怎么定的。
3. 超时、连不上这两类传输层错误没有翻译成中文提示，是有意留给调用方识别，还是漏了。
4. 响应体带 `error` 字段时（HTTP 200 也算），错误消息里照抄状态码 200，是否符合预期。
5. 超时毫秒数写成小数或无穷大时，模块不拦（见 `R-MODEL-CLIENT-09`）；这个兜底该由模块做还是由配置侧保证，代码里没有说明。

这五条按本仓分工属于「现状之外的判断」，本仓文档只写现状，因此本页不替它们下结论；同一条也登记在
`coding-reports/P001-T005.md` 的「未决」小节。本仓的缺口台账 `docs/_meta/gaps.md` 不在本卡可写范围内，
本卡没有改动它。

**本卡没做的事**：没有为这个模块新增测试文件——不在本卡的写入范围里。上面第 11 节给的命令就是这一轮实际跑过的验证路径，
照抄即可复跑。

## 11. 怎么验证

下面 9 条命令（A–I）都在仓根目录下跑，需要 Node.js 20 及以上，只引用 `model-client.js`。
其中 8 条（A、B、C、D、E、F、G、I）用 `node --input-type=module -e`；命令 H 是裸 `node -e`——它只查运行时内建，
不 import 本模块。
输出是本卡写作时实测的原文（Node.js v26.13.0）。命令 B、C、D 用一个假 `fetcher` 拦截请求，不发真实流量；
命令 A、E 只构造对象不发请求；命令 F、G 会起一个本机回环 HTTP 服务；命令 H 不碰网络；命令 I 会在发请求前就失败。

### 11.1 构造校验（命令 A）

```bash
node --input-type=module -e '
import { ChatModelClient } from "./model-client.js";
const mk = (o) => { try { new ChatModelClient({ baseUrl: "http://h/v1", apiKey: "k", model: "m", ...o }); return "接受"; }
  catch (e) { return e.constructor.name + ": " + e.message; } };
try { new ChatModelClient({}); console.log("空参数对象   接受"); }
catch (e) { console.log("空参数对象   ", e.constructor.name + ": " + e.message); }
console.log("大写 scheme ", mk({ baseUrl: "HTTP://h/v1" }));
console.log("只有 http:// ", mk({ baseUrl: "http://" }));
console.log("apiKey 空串  ", mk({ apiKey: "" }));
console.log("model 空串   ", mk({ model: "" }));
'
```

```
空参数对象    Error: LLM_BASE_URL 必须是 HTTP(S) 地址
大写 scheme  Error: LLM_BASE_URL 必须是 HTTP(S) 地址
只有 http://  TypeError: Invalid URL
apiKey 空串   Error: 缺少 LLM_API_KEY
model 空串    Error: 缺少 LLM_MODEL
```

### 11.2 端点拼接与请求体形态（命令 B）

```bash
node --input-type=module -e '
import { ChatModelClient } from "./model-client.js";
for (const b of ["http://h/v1", "http://h/v1/", "https://h", "http://h/a/b", "http://h/v1?x=1"])
  console.log(b, "->", new ChatModelClient({ baseUrl: b, apiKey: "k", model: "m" }).url.toString());
const bodies = [];
const fetcher = async (u, i) => { bodies.push(i.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }; };
const c = new ChatModelClient({ baseUrl: "http://h/v1", apiKey: "k", model: "m", fetcher });
await c.complete([{ role: "user", content: "hi" }]);
await c.complete([{ role: "user", content: "hi" }], [{ type: "function", function: { name: "f" } }], "required");
console.log("无工具:", bodies[0]);
console.log("带工具:", bodies[1]);
'
```

```
http://h/v1 -> http://h/v1/chat/completions
http://h/v1/ -> http://h/v1/chat/completions
https://h -> https://h/chat/completions
http://h/a/b -> http://h/a/b/chat/completions
http://h/v1?x=1 -> http://h/chat/completions
无工具: {"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0,"stream":false,"response_format":{"type":"json_object"}}
带工具: {"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0,"stream":false,"tools":[{"type":"function","function":{"name":"f"}}],"tool_choice":"required"}
```

最后一行 `http://h/v1?x=1` 是提醒：基地址带查询串时，路径部分会被 URL 解析规则吃掉，拼出来的端点与预期不同（🟢 `model-client.js:6-7`）。

### 11.3 入参边界与工具调用回复（命令 C）

```bash
node --input-type=module -e '
import { ChatModelClient } from "./model-client.js";
const bodies = [];
const fetcher = async (u, i) => { bodies.push(i.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ id: "1", function: { name: "f" } }] } }] }) }; };
const c = new ChatModelClient({ baseUrl: "http://h/v1", apiKey: "k", model: "m", fetcher });
await c.complete(undefined);
await c.complete(null);
console.log("messages=undefined:", bodies[0]);
console.log("messages=null     :", bodies[1]);
console.log("只有 tool_calls 的返回:", JSON.stringify(await c.complete([])));
'
```

```
messages=undefined: {"model":"m","temperature":0,"stream":false,"response_format":{"type":"json_object"}}
messages=null     : {"model":"m","messages":null,"temperature":0,"stream":false,"response_format":{"type":"json_object"}}
只有 tool_calls 的返回: {"tool_calls":[{"id":"1","function":{"name":"f"}}]}
```

### 11.4 错误翻译（命令 D）

```bash
node --input-type=module -e '
import { ChatModelClient } from "./model-client.js";
const run = async (label, resp) => {
  const c = new ChatModelClient({ baseUrl: "http://h/v1", apiKey: "k", model: "m", fetcher: async () => resp });
  try { await c.complete([]); console.log(label, "-> 未抛错"); }
  catch (e) { console.log(label, "->", e.message); }
};
await run("响应不是 JSON ", { ok: false, status: 502, json: async () => { throw new Error("boom"); } });
await run("HTTP 500       ", { ok: false, status: 500, json: async () => ({ error: { message: "内部错误" } }) });
await run("HTTP 200 带 error", { ok: true, status: 200, json: async () => ({ error: { message: "配额超了" } }) });
await run("error 是字符串 ", { ok: false, status: 400, json: async () => ({ error: "plain string" }) });
await run("没有 choices   ", { ok: true, status: 200, json: async () => ({}) });
await run("content 空     ", { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }) });
const long = "x".repeat(400);
const c = new ChatModelClient({ baseUrl: "http://h/v1", apiKey: "k", model: "m", fetcher: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: long } }) }) });
try { await c.complete([]); } catch (e) { console.log("上游 400 字原文 -> 错误消息长度", e.message.length, "| 原文还在吗", e.message.includes(long)); }
'
```

```
响应不是 JSON  -> 模型接口 HTTP 502 未返回 JSON
HTTP 500        -> 模型接口 HTTP 500: 内部错误
HTTP 200 带 error -> 模型接口 HTTP 200: 配额超了
error 是字符串  -> 模型接口 HTTP 400: 请求失败
没有 choices    -> 模型没有返回可用消息
content 空      -> 模型没有返回可用消息
上游 400 字原文 -> 错误消息长度 265 | 原文还在吗 false
```

### 11.5 环境变量装配（命令 E）

```bash
node --input-type=module -e '
import { createModelFromEnv } from "./model-client.js";
const env = { LLM_BASE_URL: "http://h/v1", LLM_API_KEY: "k", LLM_MODEL: "m" };
console.log("三项齐全        ->", createModelFromEnv(env) ? "实例" : "null");
console.log("缺 LLM_MODEL    ->", createModelFromEnv({ ...env, LLM_MODEL: undefined }) ? "实例" : "null");
console.log("缺 LLM_API_KEY  ->", createModelFromEnv({ ...env, LLM_API_KEY: undefined }) ? "实例" : "null");
console.log("缺 LLM_BASE_URL ->", createModelFromEnv({ ...env, LLM_BASE_URL: undefined }) ? "实例" : "null");
for (const v of ["5000", "0", "-1", "abc", "", "  3000  ", "1e4", "1.5", "1e999"])
  console.log("LLM_TIMEOUT_MS=" + JSON.stringify(v).padEnd(11), "->", createModelFromEnv({ ...env, LLM_TIMEOUT_MS: v }).timeoutMs);
'
```

```
三项齐全        -> 实例
缺 LLM_MODEL    -> null
缺 LLM_API_KEY  -> null
缺 LLM_BASE_URL -> null
LLM_TIMEOUT_MS="5000"      -> 5000
LLM_TIMEOUT_MS="0"         -> 90000
LLM_TIMEOUT_MS="-1"        -> 90000
LLM_TIMEOUT_MS="abc"       -> 90000
LLM_TIMEOUT_MS=""          -> 90000
LLM_TIMEOUT_MS="  3000  "  -> 3000
LLM_TIMEOUT_MS="1e4"       -> 10000
LLM_TIMEOUT_MS="1.5"       -> 1.5
LLM_TIMEOUT_MS="1e999"     -> Infinity
```

### 11.6 真实链路（命令 F）

起一个本机回环 HTTP 服务返回 200 + JSON，用 `createModelFromEnv` 装配后发一次真实请求：

```bash
node --input-type=module -e '
import http from "node:http";
import { createModelFromEnv } from "./model-client.js";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const client = createModelFromEnv({ LLM_BASE_URL: "http://127.0.0.1:" + port + "/v1", LLM_API_KEY: "k", LLM_MODEL: "m" });
console.log("真实 200 的返回:", JSON.stringify(await client.complete([{ role: "user", content: "hi" }])));
server.close();
'
```

```
真实 200 的返回: {"role":"assistant","content":"hello"}
```

### 11.7 超时与连不上（命令 G）

第一个服务故意不响应，逼出超时路径；第二个地址没人监听，逼出连接失败路径：

```bash
node --input-type=module -e '
import http from "node:http";
import { ChatModelClient } from "./model-client.js";
const server = http.createServer(() => {});   // 故意不响应，逼出超时
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const c = new ChatModelClient({ baseUrl: "http://127.0.0.1:" + port + "/v1", apiKey: "k", model: "m", timeoutMs: 800 });
const t0 = Date.now();
try { await c.complete([{ role: "user", content: "hi" }]); console.log("未抛错"); }
catch (e) { const el = Date.now() - t0; console.log("超时   ->", e.constructor.name, "| name=" + e.name, "| message=" + e.message, "| code=" + e.code, "| 耗时落在 800-2000ms 窗口内:", el >= 800 && el < 2000); }
const c2 = new ChatModelClient({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" });
try { await c2.complete([]); console.log("未抛错"); }
catch (e) { console.log("连不上 ->", e.constructor.name, "| name=" + e.name, "| message=" + e.message); }
server.close();
'
```

```
超时   -> DOMException | name=TimeoutError | message=The operation was aborted due to timeout | code=23 | 耗时落在 800-2000ms 窗口内: true
连不上 -> TypeError | name=TypeError | message=fetch failed
```

这两行就是第 4.3 节说的「没被翻译的两类错误」：抛出来的是运行时的原始错误对象。第一行输出的是窗口判定而不是
原始毫秒数，因为实测耗时逐次有几十毫秒的浮动（本卡两次实测为 804 与 806 毫秒）——写死一个数字就不能原样复跑。

### 11.8 运行时内建（命令 H）

```bash
node -e 'console.log("node", process.version, "| AbortSignal.timeout:", typeof AbortSignal.timeout, "| fetch:", typeof fetch, "| URL:", typeof URL)'
```

```
node v26.13.0 | AbortSignal.timeout: function | fetch: function | URL: function
```

### 11.9 超时毫秒数不是整数或不是有限值（命令 I）

```bash
node --input-type=module -e '
import { createModelFromEnv } from "./model-client.js";
const env = { LLM_BASE_URL: "http://h/v1", LLM_API_KEY: "k", LLM_MODEL: "m" };
for (const raw of ["1.5", "1e999"]) {
  const c = createModelFromEnv({ ...env, LLM_TIMEOUT_MS: raw });
  console.log("LLM_TIMEOUT_MS=" + JSON.stringify(raw), "-> 装配出的 timeoutMs =", c.timeoutMs);
  try { await c.complete([{ role: "user", content: "hi" }]); console.log("  未抛错"); }
  catch (e) { console.log("  complete 抛出 =>", e.constructor.name, "| code=" + e.code, "| message=" + e.message); }
}
'
```

```
LLM_TIMEOUT_MS="1.5" -> 装配出的 timeoutMs = 1.5
  complete 抛出 => RangeError | code=ERR_OUT_OF_RANGE | message=The value of "delay" is out of range. It must be an integer. Received 1.5
LLM_TIMEOUT_MS="1e999" -> 装配出的 timeoutMs = Infinity
  complete 抛出 => RangeError | code=ERR_OUT_OF_RANGE | message=The value of "delay" is out of range. It must be an integer. Received Infinity
```

模块没拦这两个值（`R-MODEL-CLIENT-09`）：装配时它只看「大于 0」，小数与无穷大照收；拦住它们的是运行时的
`AbortSignal.timeout`。两条请求都没有发出——`AbortSignal.timeout` 在 `fetch` 之前就抛了。

## 12. 指针

- 本模块在模块清单里的位置：[docs/modules/_breakdown.json](_breakdown.json) 的 `model-client` 条目
  （实现文件 `model-client.js`，覆盖构件四项）。
- 全局视角（分层、两条研判路径、配置项速查）：[docs/architecture.md](../architecture.md)。
- 侦察记录（本卡核过的 28 条事实与当时的输出）：`evidence/recon/P001-T005.md`。
- 本卡的交卷报告（含未决项）：`coding-reports/P001-T005.md`。
