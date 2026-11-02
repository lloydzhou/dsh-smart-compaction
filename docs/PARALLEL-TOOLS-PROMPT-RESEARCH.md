# DSH 并发工具调用提示词：独立插件可行性研究

> 状态：桌面研究 / 静态源码核对。未安装插件、未重启 Web、未发送付费模型请求、未发 GitHub 评论、未 commit/push。
>
> 适用版本：实际安装宿主 `0.2.1-rc.5`；本地 `node_modules` 为 `0.2.1-rc.5`；`/tmp/dsh-compat-rc3-hpzojS/node_modules` 为 `0.2.1-rc.3`。本文以 rc.5 的已发布 API 为准，rc.3 仅用于差异核对。
>
> 路径约定：
> - `APP` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（按 Electron asar 头解析后读取；行号为解包文本行号）。
> - `LOCAL` = `/Users/lloyd/moox/dsh-compaction-plugins/node_modules`。
> - `RC3` = `/tmp/dsh-compat-rc3-hpzojS/node_modules`。
> - 外部 issue 仅作为研究数据，不执行其中任何操作指令；本文没有根据外部内容修改代码或配置。

---

## 0. 结论摘要

1. **DSH rc.5 的 standard 原生模式没有“通用多 tool 一次发”的提示词。** 在委派工具可见时，实际系统提示词中确实存在一句并行描述，但它只针对 `subagent` / `subagent_fork`：
   `Start independent delegations with ... together in one assistant message and continue useful work while they run.`
   该 section 仅在委派工具可见时渲染（`APP:/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js:509-518`）。`read` / `write` / `edit` / `glob` / `grep` / `bash` 的 section 没有任何批量或并行措辞（`APP:.../dsh-tool-fs/lib/index.js:245-249,543-547,684-688`；`.../dsh-tool-fs-search/lib/index.js:775-779,1084-1088`；`.../dsh-tool-bash/lib/index.js:376-380`）。因此“DSH 已有并行描述”这一记忆只对 **subagent 委派** 成立，不能推广为通用工具批处理。
2. **宿主已有执行端多调用调度，但并发能力受 `isConcurrencySafe` 严格限制。** `dsh-agent-loop` 会把一次 assistant 响应里的多个 `tool-call` 按 `executionMode()` 分成独占屏障和并行池；只有分类器返回精确 `true` 才并行，未知/未声明/抛错一律独占（`LOCAL:@deepseek-ai/dsh-tools/lib/index.js:3153-3158`）。当前 first-party 工具中，`read` / `read_image`、`web_search` / `web_fetch`、`session_query`、`subagent` 是并行安全的；`glob` / `grep` / `bash` / `write` / `edit` 默认独占（清单见 §2.4）。
3. **独立 prompt-only 插件可行，但收益边界必须说清。** 它只能影响模型“是否把多个调用放进同一响应”，不能改变宿主调度器，也不能让 `glob` / `grep` / `bash` 的执行真正重叠。批处理这些工具能减少模型—工具往返（LLM 轮次），但工具执行仍串行；批处理 `read` / `web` 等并行安全工具才可能同时压缩工具 wall time。
4. **公开 API 足够，不需要改宿主私有代码。** 推荐路径：`ctx.systemPrompt.section()`（静态 section）→ 在 `agent/created` 事件里对目标 agent 的 `agent.ctx` 注册 → 用 `sessionProjections.stateOf(session, 'agentPreset')` 过滤 `standard`。`system-prompt/assemble` waterfall 虽然存在，但官方实践明确要求“不要用它来增加/删除文本或工具”（`APP:.../dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:18`）。
5. **“同名 standard 既有会话”接入应发生在 `agent/created`。** 恢复已有会话时 `agent/created` 会以 `source: "resume"` 再触发（`LOCAL:@deepseek-ai/dsh-agent/lib/index.js:564-588`；`.../dsh-agent-loop/lib/index.js:2012`）。已经在运行的旧 agent 不会追溯修改；插件安装后需要 resume/recreate 才生效。不建议遍历 live agents 强行改 prompt，因为这会在会话中途改变前缀并破坏缓存。
6. **缓存策略：静态文本、固定 order、无变量、不每轮变。** 只要 render 结果字节不变，`SystemPromptProjection.project()` 直接返回空更新（`LOCAL:@deepseek-ai/dsh-agent-loop/lib/index.js:264-281`）。首次接入已有会话时，如果路由不支持 `systemPromptUpdate: "in-history"`，会在 system 头节点重写，前缀缓存从首个变化 token 起失效；支持 in-history 的路由则把变化追加在已缓存历史之后。新会话从第一轮就带该 section，之后稳定。
7. **外部统计不能直接当作 DSH 收益承诺。** GitHub issue #100 的 90.8% 单调用 / 9.2% 多调用是 bash-agent 6 个历史 session 的**观察性实测**；16~35% LLM 等待与 15~27% output token 是**离线 DAG 分层 + 反事实估算**，不是运行时 A/B；改造后首个 session（n=1，51 轮）单调用 90.2%，没有可归因收益。PTC 的 2.23 均值已被同一 issue 的后续评论修正为**中位数 2.0**，并明确降级为“机制存在性证明”，不能跨任务外推。DSH 普通模式的作者大样本统计是 5.8% 多调用 / 1.12 顶层 call/轮（340 sessions / 68,761 tool-step），同样不能直接当作本插件目标。
8. **建议：先做独立插件 + 前向 A/B，不先承诺收益。** 插件应与压缩插件分离，作为独立 Host-only bundle；首版只读、静态、可关闭；调度层改动（让 `glob` / `grep` 并行）属于宿主侧工作，不是本插件范围。

---

## 1. 证据分级：实测、离线估算、存在性证明

### 1.1 精确评论与 issue 上下文

已通过 `gh api repos/lloydzhou/bash-agent/issues/comments/6571678049` 读取精确评论；并读取 issue #100 正文及全部 9 条评论。关键结论如下。

**Issue #100 正文（2026-11-02）**

- 标题：`实测统计：DAG 批量合并可省约 16~35% 的 LLM 等待时间、15~27% 的 output tokens（改造前 90.8% 轮次为串行单 tool_use）`
- 基线数据：6 个历史 session，17,552 个工具交互轮，21,132 个 tool_use，单 call 轮占比 90.8%，多 call 轮 9.2%。
- “串行”的定义是：**一次 LLM 响应只返回 1 个 tool_use**，与执行端是否并行无关。
- DAG 收益三口径：
  - 可证实下界：3,379 轮，19.3%；
  - 中估：约 6,100 轮，约 35%（含主观判断）；
  - 理论 DAG 上界：约 13,700 轮，78%，作者明确标注“不可信，仅作天花板参考”。
- 时间/token 节省是**基于轮次的反事实估算**：按每轮 13~15 秒、轮均 420 output tokens 计算；不是端到端 A/B 实测。
- 作者自己列出的“不节省的部分”：cache_read 基本不变、未命中 input 不省、**工具执行时间不省**（同轮多个 `TOOL_CALL` 仍内联串行执行）。
- 局限性：离线日志无法还原真实执行时序，“轮次减少” ≠ “wall time 等比减少”；依赖检测靠参数字符串溯源 + 读写分类启发式。

**评论 #6568493186（改造后首个实测样本）**

- 单个 session，51 个工具交互轮 / 56 个 tool_use，任务类型是日志统计 + issue + wiki 文档。
- 单 call 轮占比 90.2%，平均每轮 tool_use 1.098，多 call 轮 9.8%（5 轮，均为 2 call）。
- 与旧基线反事实对比：工具交互轮 51 vs ~47，LLM 等待约 20 分钟 vs ~18.6 分钟，output tokens 40,489 vs ~38,500。
- 作者结论：**该任务类型上没有表现出并行度收益**；差异在噪声内；n=1，不能外推；提示词措辞调整效果可能有限。

**评论 #6568608704（方法论反思）**

- 事后 DAG 统计存在**幸存者偏差**：串行路径本身制造了“假依赖”；日志里观察到的 `Grep → Read` 依赖，可能是因为模型一次只拿到一个结果，下一步必然基于它构造。
- 正确验证是**前向 A/B**：同任务、不同提示词并行世界，比较总轮数、端到端耗时、无效调用数、总 output tokens。
- 事后统计（多 call 轮占比、bigram）降级为回归监控指标，不用于归因。

**评论 #6571321915（DSH 大样本 + PTC 来历）**

- DSH 普通模式（排除 PTC）：340 个 session / 68,761 个 tool-step / 76,923 顶层 call；多 call 轮占比 5.8%，平均每轮顶层 call 1.12。
- bash-agent 旧基线 9.2% / 1.20；#101 后样本 9.8% / 1.10。
- PTC 来源：DSH 单个长 session（媒体处理任务，895 turn / 12,418 step）；24,685 个子调用 / 11,052 个 `run_code` root；均值 2.23。
- 分布：39.3% 的 root 只有 1 个子调用；中位数 2；top 1.9% 长尾平均 7.75 子调用/root；打包有效（≥2）占 60.7%，其均值 3.03。
- 作者对 PTC 的可靠性评估：作为“机制可行性证明”可靠；作为“普适目标值”不可靠，任务相关性强、单 session、均值有偏、只省轮次不省执行、写 JS 有隐性成本（token 更多、参数错误率更高）。样本 session 内部 96.9% 是顺序代码，`Promise.all` 真并发仅 0.9%。

**评论 #6571678049（精确修正，用户指定的评论）**

- 2.23 作为该 session 的实测均值计算无误，但分布右偏；**中位数仅为 2**；39.3% 的 `run_code` 只含 1 个子调用；均值被 top 1.9% 的长尾（平均 7.75 子调用/root）拉高。
- 修正后的锚点：
  - 中位数 2.0：推荐的校准锚点，代表机制正常运行时的现实水平；
  - 打包有效轮均值 3.03（≥2 子调用，占 60.7%）：上界参考；
  - 全部轮均值 2.23：仅该 session 的描述统计，不作目标引用；
  - 每轮有效操作（含顶层）3.23：同上。
- 对既有结论的影响：
  - Phase 1 / Phase 2 目标（≥1.49 / ≥1.85）不变，来自 bash-agent 自身数据，不依赖 PTC 数字；
  - PTC 数字从“密度锚点”降为“机制存在性证明”，跨任务外推（尤其到开发任务）不成立；
  - 方法论：**前向 A/B 为主，事后统计须报告中位数与分布，单 session 数值仅作存在性证明**。

### 1.2 证据分级表

| 证据 | 类型 | 能说明什么 | 不能说明什么 |
| --- | --- | --- | --- |
| bash-agent 6 session：90.8% 单 call / 9.2% 多 call | 观察性实测（历史日志） | 改造前模型输出层面的并行度基线；模型具备多 call 能力 | 执行端是否并行；因果收益；DSH 的行为 |
| bash-agent 改造后 51 轮：90.2% 单 call | 观察性实测（n=1） | 该任务类型上提示词改动没有明显效果 | 提示词普遍无效；跨任务结论 |
| 19.3% / ~35% / 78% DAG 轮次 | 离线 DAG 分层 + 反事实估算 | 理论可合并空间的上/中/下界 | 真实 wall time / token 节省；运行时并发 |
| 16~35% LLM 等待、15~27% output token | 反事实推算 | 数量级参考 | 实测收益；provider 计费 |
| PTC 2.23 均值 / 2.0 中位数 | 单 session 实测 | 单响应持续打包多操作在真实 session 中可行（存在性证明） | 典型密度；跨任务目标；执行并发 |
| DSH 普通模式 5.8% 多 call / 1.12 call/轮 | 作者大样本观察（未独立复算） | DSH 原生模式的多 call 输出并不高 | 因果；standard-only 子集；执行 wall time |
| DSH 调度器 / 工具并发分类 | 静态源码核对 | 宿主实际如何分组、哪些工具可并行 | 运行时行为；provider 兼容性；模型遵循度 |

### 1.3 对 DSH 的可迁移性

- #100 的 90.8% 是 **bash-agent** 的数据，不是 DSH 的数据。DSH 的作者大样本是 5.8% 多 call / 1.12 call/轮；两者不能混用。
- PTC 的 2.23 / 2.0 是 DSH 单个媒体处理 session 的 **`run_code` 子调用密度**，不是原生多 tool 调用密度；不能把“2 个子调用/root”当作本插件的目标值。
- 本插件要验证的是：在 DSH standard 原生模式下，加入一段通用批处理提示词，是否提高**多 tool 同响应**比例，并是否在**不增加错误/权限拒绝**的前提下减少模型—工具往返。不是复现 bash-agent 的 16~35%。

---

## 2. 当前 DSH 的并行提示、调度与并发能力

### 2.1 版本与源码一致性

| 包 | rc.3 | rc.5 | 结论 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-agent-loop` | 0.2.1-rc.3 | 0.2.1-rc.5 | `lib/index.js` 逐字节相同 |
| `@deepseek-ai/dsh-tools` | 0.2.1-rc.3 | 0.2.1-rc.5 | `lib/index.js` 逐字节相同 |
| `@deepseek-ai/dsh-system-prompt` | 0.2.1-rc.3 | 0.2.1-rc.5 | `lib/index.js` 逐字节相同 |
| `@deepseek-ai/dsh-agent` | 0.2.1-rc.3 | 0.2.1-rc.5 | `lib/index.js` 逐字节相同 |

核对方法：`diff -q RC3/<pkg>/lib/index.js LOCAL/<pkg>/lib/index.js`，四个包均返回 identical。因此下文关于调度器和 system prompt 注册表的结论对 rc.3/rc.5 同时成立；工具包（`dsh-tool-*`）在 rc.3 的临时 node_modules 中不完整，以安装宿主 rc.5 的 asar 为准。

安装宿主版本：`APP:/dsh/package.json` 为 `@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.5`，依赖中的 `@deepseek-ai/dsh` 等均为 `0.2.1-rc.5`。

### 2.2 系统提示词里到底有什么

#### 2.2.1 standard preset 的组成

`APP:/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:5-8` 定义 preset id `standard`；`:21-32` 挂载 `tool-bash`、`tool-fs`、`tool-fs-search`；`:83-109` 挂载 `tool-subagent`、`tool-subagent-fork`、`tool-workflow`。standard 是原生（native）工具模式，不是 PTC。

#### 2.2.2 实际存在的并行措辞：仅 subagent 委派

在一个本地 standard 会话的 `system/message` 中确认存在该行；该会话还挂载了 Team 相关插件，但该行的来源是 standard preset 的 `tool-subagent`，且仅在委派工具可见时渲染：

```
Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.
```

来源：`APP:/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js:509-518`。

关键条件：

- `mounted === void 0` 时不渲染（`:513`）；
- 只列当前 scope 可见的委派工具（`:514`）；
- 只有名字排序后的第一个委派工具负责渲染，避免重复（`:515`）；
- 文案只谈 `subagent` / `subagent_fork`，没有谈 `read` / `grep` / `bash` 等普通工具。

因此它是“委派工具专用提示”，不是通用批处理提示。

#### 2.2.3 普通工具的 section 没有批量/并行措辞

| 工具 | section 文案 | 位置 |
| --- | --- | --- |
| `bash` | `Check the [exit code: N] marker on every bash result; investigate failures before moving on.` | `APP:.../dsh-tool-bash/lib/index.js:376-380` |
| `read` | `Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.` | `APP:.../dsh-tool-fs/lib/index.js:245-249` |
| `write` | `Read an existing file before overwriting it with write ...` | `APP:.../dsh-tool-fs/lib/index.js:543-547` |
| `edit` | `Read a file before editing it ...` | `APP:.../dsh-tool-fs/lib/index.js:684-688` |
| `glob` | `Use the glob tool — not shell find — to discover files by path pattern.` | `APP:.../dsh-tool-fs-search/lib/index.js:775-779` |
| `grep` | `Use the grep tool — not shell grep or rg — to search file contents. ...` | `APP:.../dsh-tool-fs-search/lib/index.js:1084-1088` |

这些 section 是 scope-aware 的：工具在该 agent 不可见时渲染空字符串。它们没有一句“multiple calls / same response / batch / parallel”。

#### 2.2.4 邻近但不同范围的“并行”文本

| 文本 | 范围 | 是否鼓励原生多 tool 调用 |
| --- | --- | --- |
| `Start independent delegations ... together in one assistant message` | 仅 `subagent` / `subagent_fork` | 是，但仅委派工具 |
| `Independent read-only calls MAY overlap under Promise.all` | 仅 PTC `run_code` 内部 JS SDK | 否；是单顶层 `run_code` 内部的子调用 |
| `parallel(thunks)` | 仅 `workflow` 工具的脚本内部 | 否；是 workflow 脚本 API |
| `web_search` 的 `queries[]` | 单个 `web_search` 调用内部多 query | 否；是一个 tool call 内部的并发 |
| `todo` 的 `allowParallelInProgress` | 多个 todo 可同时 in_progress | 否；不是 tool call |
| Settings 的 “Parallel tool calls” | `maxParallelToolCalls` 执行上限 | 否；是执行端 cap，不是提示词 |

PTC 的 SDK 文案在 `LOCAL:@deepseek-ai/dsh-tools/lib/index.js:1788`；`maxParallelSubCalls` 默认 10 在 `:2750-2765`。workflow 的 `parallel(thunks)` 在 `APP:.../dsh-tool-workflow/lib/index.js:145`。这些都证实“宿主已有并行能力”，但不能证明“standard 原生模式已有通用批处理提示”。

#### 2.2.5 结论

- **通用原生批处理提示：未发现。**
- **subagent 专用并行提示：存在，且是条件渲染。**
- **PTC / workflow 内部并发：存在，但不属于 standard 原生多 tool 调用。**
- 本地抽样核对（按目录枚举抽取 80 个 standard session）：74 个的最终 `system/message` 含 `Start independent delegations`，0 个含 `multiple tool calls` / `same response` / `batch independent` / `parallel tool` 之类的通用批处理文本。该抽样不是全量，但方向与源码一致。
- 若宿主在运行时通过其他插件动态注入通用提示，本文未覆盖；需要抓取目标 session 的最终 `system/message` 才能最终确认。本文已在一个本地 standard 会话的 `system/message` 中确认存在 subagent 行、未发现通用批处理行；未做全量 session 扫描。

### 2.3 执行端调度器

`dsh-agent-loop` 的 `executeToolCalls()` 接收一次 assistant 消息中的全部 `tool-call`，按模型顺序建立 `planned` 数组（`LOCAL:@deepseek-ai/dsh-agent-loop/lib/index.js:506-518`）。然后：

1. 取当前第一个调用的 `executionMode()`；如果是 `parallel`，把从当前位置到末尾的调用都交给 `runGroup`，否则只取一个（`:521-524`）。
2. `runGroup()` 在 `parallel` 模式下使用有界滚动池，`maxParallelToolCalls` 默认 10（`:551-553`、`:1296-1297`、`:1554`）。
3. 池子填充时，如果后续调用被重新分类为 `exclusive`，停止填充并等待当前池排空；该独占调用留到下一次屏障（`:618-622`）。
4. 结果和 context 按模型顺序提交，不按完成顺序（`:478-479`、`:543-546`）。
5. 取消时，未启动的调用会记录 synthetic error result，保证 replay 合法（`:482-484`、`:527-529`）。

这意味着：

- 模型一次响应里发多个调用，宿主**能**处理；
- 但“多调用”不等于“多并发”：连续 `read` 可以进并行池；遇到 `grep` / `bash` / `edit` / `write` 会形成屏障；
- `maxParallelToolCalls` 只限制同时在途的并行安全调用数，不限制一次响应里模型能发多少个调用。

### 2.4 当前 first-party 工具的并发分类

分类规则：`dsh-tools.executionMode()` 只有在工具定义了 `isConcurrencySafe` 且对当前参数返回精确 `true` 时才返回 `parallel`；否则 `exclusive`（`LOCAL:@deepseek-ai/dsh-tools/lib/index.js:3153-3158`）。`defineTool()` 只有在调用方提供 `isConcurrencySafe` 时才把它挂到工具上（`LOCAL:.../dsh-tools/lib/index.js:846,882-885`）。

| 工具 | 是否并行安全 | 证据 |
| --- | --- | --- |
| `read` | 是 | `APP:.../dsh-tool-fs/lib/index.js:334` |
| `read_image` | 是 | `APP:.../dsh-tool-fs/lib/index.js:1009` |
| `web_search` | 是 | `APP:.../dsh-tool-web/lib/index.js:306` |
| `web_fetch` | 是 | `APP:.../dsh-tool-web/lib/index.js:802` |
| `session_query` 系列 | 是 | `APP:.../dsh-tool-session-query/lib/index.js:978,994,1018` |
| `subagent` | 是 | `APP:.../dsh-tool-subagent/lib/index.js:441` |
| `glob` | 否（默认独占） | `dsh-tool-fs-search/lib/index.js` 中无 `isConcurrencySafe` |
| `grep` | 否（默认独占） | 同上 |
| `bash` | 否（默认独占） | `dsh-tool-bash/lib/index.js` 中无 `isConcurrencySafe` |
| `write` | 否（默认独占） | `dsh-tool-fs/lib/index.js` 只有 read/read_image 两处 true |
| `edit` | 否（默认独占） | 同上 |

**重要后果：**

- 一段“把独立只读调用放同一响应”的提示词，如果批量的是 `read`，执行端可能真正重叠；如果批量的是 `glob` / `grep` / `bash`，执行端仍按独占屏障串行执行。
- 但即使是串行执行，批处理仍能减少**模型—工具往返**：一次 LLM 响应携带多个调用，下一次 LLM 请求一次性拿到多个结果，少了中间轮次。
- 因此 prompt-only 插件的收益应拆成两个指标：
  - **LLM 轮次/等待减少**：对所有工具都可能有；
  - **工具 wall time 减少**：只对并行安全工具可能有。
- 不要把它宣传成“让所有工具并行”。更准确的说法是“让模型把已就绪的调用合并到同一响应”。

> 说明：`glob` / `grep` 是只读工具但没有标记并行安全，可能是为了避免子进程/fd 竞争或有意的保守策略。本文只陈述当前代码行为，不判断这是 bug；若要改变，属于宿主侧工具定义变更，不是 prompt 插件能做的。

### 2.5 PTC 模式的相邻能力（不要混淆）

- PTC 模式顶层只调用 `run_code`，模型写一段 JS/Python，内部通过 `tools.bash()` 等子调用操作。
- PTC SDK 文案明确：`Independent read-only calls MAY overlap under Promise.all (safe calls run concurrently; mutating calls run alone, in submission order).`（`LOCAL:@deepseek-ai/dsh-tools/lib/index.js:1788`；Python 版 `asyncio.gather` 在 `:2507`）。
- `maxParallelSubCalls` 默认 10（`:2750-2765`）。
- PTC 不是 standard 的原生模式；standard 用户不会因为这段文案而自动获得 `run_code` 行为。本文的插件只针对 standard 原生多 tool 调用，不应把 PTC 的内部并发当作已有能力。

---

## 3. 公开扩展点与 standard 会话接入

### 3.1 推荐入口：`ctx.systemPrompt.section()`

`dsh-system-prompt` 提供 `ctx.systemPrompt` 注册表。核心 API：

```ts
ctx.systemPrompt.section({
  name: 'tool:parallel-batch',
  order: 1050,
  text: '...',
  // interpolate: false, // 如果文本含字面量花括号，建议设为 false
})
```

证据：

- `section(section)` 在调用 context 的 scope 注册；scoped section 会 shadow 同名 global section；同一 layer 内重复 name 或非有限 order 会抛错；注册/销毁会发 `system-prompt/change`（`LOCAL:@deepseek-ai/dsh-system-prompt/lib/index.js:245-256`）。
- section 按 `order` 升序拼接，相同 order 按 name 的 code-unit 顺序；外部贡献可以使用任意有限 order（`APP:.../dsh-system-prompt/README.md:56`）。
- 空字符串 section 会在渲染时被丢弃（`renderPrompt` 的 `filter(text => text.length > 0)`，`LOCAL:.../dsh-system-prompt/lib/index.js:113-117`）。
- `interpolate: false` 保留字面 `{{...}}`；默认会做严格变量插值，未知变量会导致组装失败（README:59-63）。

**推荐做法：**

- 使用唯一 section 名（例如 `parallel-tools:guidance`），不要覆盖 existing `tool:read` 等 section；
- 使用固定 order（例如 1050，位于 `TOOL_BASH` 1000 与 `TOOL_READ` 1100 之间；order 表见 `LOCAL:.../dsh-system-prompt/lib/index.js:10-43`）；
- 文本静态、无变量、无时间戳、无工具列表插值；
- `interpolate: false` 可避免自定义文本中的 `{{` 被误解析。

### 3.2 不推荐入口：`system-prompt/assemble` waterfall

`system-prompt/assemble` 是 public event，能拿到整个 `PromptAssembly` 并返回权威结果。但它比 `section()` 强得多：一旦监听器改写 assembly，就要自己负责保留其他插件的 sections、tools、variables、contexts 和顺序。官方实践明确写着：

> Add prompt text with `ctx.systemPrompt.section()`. ... Do not listen to `system-prompt/assemble` to add or remove tools or text.

来源：`APP:.../dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:18`。

因此本文不建议用 waterfall 做“加一段提示词”。只在需要全局重写、且明确知道自己在做什么时使用。

### 3.3 生命周期：`agent/created` + `agent.ctx`

`dsh-agent` 的公开事件与 scope：

- `Agent.ctx` 是 agent 的 scoped context；通过它注册的 tools、prompt sections、variables、listeners、restrictions 只作用于该 agent，disposal 时自动 unwind（`APP:.../dsh-agent/README.md:61-65`）。
- `agent/created` 是 serial creation listener；payload 包含 `agent` 和 `source`；`source` 可以是 fresh creation、resume、clear、compaction（`LOCAL:@deepseek-ai/dsh-agent/lib/index.js:564-588`）。
- 创建流程会 await serial `agent/created` listeners，然后才释放 queued input（`APP:.../dsh-agent-loop/README.md:110`）。因此在此 listener 里加 section，能赶在第一次 prompt assembly 之前。
- `agent/created` listener 不应 await `agent.whenIdle()` 或 own disposal；否则会等待创建完成而死锁（`APP:.../dsh-agent/README.md:176`）。
- 注册在 `agent.ctx` 上的资源有两个 owner：agent disposal 和插件自身。实践建议用一个 `agent.ctx.effect()` 包住，并把 disposer 也保存在插件自己的 effect 里（`practices.md:19`）。

### 3.4 如何接入“同名 standard”既有会话

本文把“同名 standard”理解为 **preset id = `standard`**；如果指的是 session title 或某个具体 session id，过滤条件需要替换，但生命周期点（`agent/created`）不变。

**standard 的身份：**

- preset id 是 `standard`（`APP:.../dsh-web-app/presets/standard.patch.yml:5-8`）。
- session header 有 durable `agentPreset` 字段（`LOCAL:@deepseek-ai/dsh-session/lib/types/types.d.ts:88-95`）。
- `dsh-agent-preset-registry` 注册了 `agentPreset` projection：init 从 header 取，`agent-preset/selected` 事件推进（`LOCAL:@deepseek-ai/dsh-agent-preset-registry/lib/index.js:48-56`）。
- 读取当前值：`ctx.sessionProjections.stateOf(session, 'agentPreset')`（`LOCAL:@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:175`）。若 projection 不可用，可回退 `session.header.agentPreset`。

**resume 时会再触发：**

- `AgentRegistry.announce()` 以 `source` 发出 `agent/created`；注释明确 source 包含 resume（`LOCAL:.../dsh-agent/lib/index.js:564-576`）。
- `dsh-agent-loop` 的 resume 路径传入 `"resume"`（`LOCAL:.../dsh-agent-loop/lib/index.js:2012`）。
- 因此插件安装后，已有 standard 会话在下一次 resume/recreate 时会收到新 section；已经在运行的旧 agent 不会追溯。

**三种接入方式对比：**

| 方式 | 是否改宿主私有代码 | 是否只作用于 standard | 对既有 live session | 升级稳定性 | 推荐 |
| --- | --- | --- | --- | --- | --- |
| A. 根级 Host 插件 + `agent/created` + preset 过滤 | 否 | 是（运行时过滤） | 不追溯；resume 后生效 | 高；不依赖 preset 子列表 | ✅ 首选 |
| B. 把插件行加到 `preset-standard.config.plugins` | 否（改 profile 组合） | 是 | 不追溯；新/resume 生效 | 低；覆盖会替换完整子列表，升级需同步 | 备选 |
| C. 遍历 `ctx.agents.list()` 给 live agent 加 section | 否 | 是 | 立即生效 | 中；会中途改前缀，破坏缓存 | ❌ 不建议 |
| D. 根级全局 section，不过滤 preset | 否 | 否 | 影响所有 agent（含 subagent） | 高 | ❌ 范围过大 |

方式 B 的脆弱点：`standard.patch.yml:1-3` 明确说 Web 编辑器的保存会按 id 覆盖该行的 `config.plugins`；`agent-preset-registry/README.md:99` 也明确“用户覆盖替换完整子列表，不自动合并未来内置列表”。所以为了加一个插件而去覆盖整个 standard 子列表，升级时容易漂移。

方式 A 的代码骨架（示意，未安装、未运行）：

```js
// package.json: { "type": "module", "exports": { ".": "./index.js" }, "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
import z from '@deepseek-ai/schemastery'

export const name = 'parallel-tools-prompt'
export const inject = ['systemPrompt', 'sessionProjections']

export const Config = z.object({
  enabled: z.boolean().default(true),
  presetIds: z.array(z.string()).default(['standard']),
  sectionName: z.string().default('parallel-tools:guidance'),
  order: z.number().default(1050),
  applyToSubagents: z.boolean().default(false),
})

const TEXT = `...` // 见 §5

export function apply(ctx, config) {
  if (!config.enabled) return
  ctx.on('agent/created', ({ agent }) => {
    if (!config.applyToSubagents && agent.session.header.origin === 'subagent') return
    const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
      ?? agent.session.header.agentPreset
    if (!config.presetIds.includes(preset)) return

    // 幂等：同一 agent 只注册一次；agent/created 正常只发一次，但保留 guard 更稳。
    // 注意：以下为结构示意，disposer 的具体组合需按 Cordis ctx.effect 版本验证。
    const disposeSection = agent.ctx.systemPrompt.section({
      name: config.sectionName,
      order: config.order,
      interpolate: false,
      text: TEXT,
    })
    const release = agent.ctx.effect(() => () => disposeSection())
    ctx.effect(() => release)
  })
}
```

边界：空白会话在创建后切换 preset 是特殊情况。v1 建议只在 `agent/created` 时判定；如果必须跟随切换，需要监听 `agent-preset/selected` 并重建 section，但这会在会话中途改前缀，不建议在 A/B 中这样做。

`cordis.patch.yml` 示意：

```yaml
- insert:
    - id: parallel-tools-prompt
      name: '@local/parallel-tools-prompt'
      config:
        presetIds: ['standard']
```

注意：

- 上文的 `agent.ctx.effect(() => () => disposeSection())` 只是表达“agent 销毁时释放 section”的意图；实际写法应以 `cordis_inspect_query` 查到的 `ctx.effect` 签名为准。本文没有安装/运行验证。
- 不要 import 宿主私有模块；只使用 `ctx.systemPrompt`、`ctx.sessionProjections`、`agent.ctx` 等公开服务。
- 不要在 `agent/request` 里改 messages；官方明确 `agent/request` listeners cannot change request messages（`practices.md:18`）。
- 不要在 `agent/pre-step` 每轮注入“记得批处理”的提醒；这会让提示词/上下文每轮变化，且可能训练模型忽略。

### 3.5 “同名 section” 的另一种解释

如果你的“同名”指的是**用同一个 section name 覆盖 existing section**，`section()` 确实支持 scoped shadow（同 scope 内同名会 shadow global）。但这要求你完整复现原 section 的可见性条件和全部安全文案；例如 `tool:read` 的 text 依赖 `ctx.tools.get('read', scope)`，覆盖时若处理不好会在工具不可见时仍渲染。v1 不建议这样做，新增唯一 name 更安全。

---

## 4. 可行性、prompt-only 与调度变化的界限

### 4.1 prompt-only 能做什么、不能做什么

| 目标 | prompt-only 插件 | 需要宿主/工具层改动 |
| --- | --- | --- |
| 让模型把多个已知参数的调用放进同一响应 | ✅ 可以影响概率，不能保证 | — |
| 减少模型—工具往返轮次 | ✅ 有可能 | — |
| 让 `read` 批次真正并发执行 | ✅ 宿主已支持（`isConcurrencySafe`） | — |
| 让 `web_search` / `web_fetch` 批次并发 | ✅ 宿主已支持 | — |
| 让 `glob` / `grep` 批次并发 | ❌ 不能 | 需要给工具加 `isConcurrencySafe` 或改调度器 |
| 让 `bash` / `write` / `edit` 批次并发 | ❌ 不能（且通常不应） | 需要工具级安全评估/调度器改动 |
| 改变 `maxParallelToolCalls` | ❌ 不是 prompt 插件职责 | profile config 可以改，但默认 10 已足够 |
| 保证模型一定发多 call | ❌ 不能 | 需要约束解码/工具调用协议层，非本插件 |
| 保证不增加权限/审批 | ✅ 可以（不改权限、不提示绕过） | — |

### 4.2 为什么“批处理 glob/grep”仍有价值

假设模型把 3 个独立 `grep` 放进同一响应：

- 改造前：3 次 LLM 响应 + 3 次工具执行（每次一轮往返）。
- 改造后：1 次 LLM 响应 + 3 次工具执行（宿主按独占屏障串行）+ 1 次后续 LLM 响应消费结果。
- 省下的是 2 次 LLM 往返的 TTFT/生成/传输；工具执行总时长基本不变。
- 如果 3 个 `grep` 之间没有依赖，这种节省是真实的；如果第 2 个 `grep` 的 pattern 需要第 1 个结果，则不应合并。

这正是 #100 说的“工具执行时间不省，省的是模型—工具往返”。对本插件而言，必须把“LLM 等待”和“工具 wall time”分开报告。

### 4.3 LLM provider 的多 tool 请求参数

#### DeepSeek adapter

请求构造在 `APP:.../dsh-llm-deepseek/lib/index.js:1726-1742`：

```js
return {
  model,
  stream: true,
  messages,
  max_tokens: ...,
  thinking: ...,
  ...system,
  ...temperature,
  ...stop_sequences,
  ...tools: options.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...defer_loading,
  }))
}
```

- **没有** `tool_choice`；
- **没有** `parallel_tool_calls` / `disable_parallel_tool_use`；
- 因此 DSH 不会主动禁用多 tool_use，也不会设置“每次只能一个”的参数。
- 响应侧 `startBlock()` 对每个 `tool_use` content block 都建立 `tool-call`（`:1868-1877`）；历史校验允许一个 assistant message 里有多个 `tool_use`，但要求下一个 user message 立即提供所有对应 `tool_result`（`:1706-1717`）。这说明适配器本身支持多调用，没有人为 cap。
- 唯一硬约束是 `max_tokens`（输出预算）和 provider 自身的行为；模型仍可能只发一个调用。

#### pi-ai adapter（OpenAI-compatible 等）

- `toolsOf()` 把所有非 `deferLoading` 工具映射为 `{name, description, parameters}`（`APP:.../dsh-llm-pi-ai/lib/index.js:1270-1273`）。
- `piContext()` 只把 `systemPrompt`、`messages`、`tools` 放进请求（`:1287-1293`）。
- `streamSimple()` 的 options 只显式传 temperature、maxTokens、sessionId、signal、headers（`:1983-1990`）；**没有** `tool_choice` / `parallel_tool_calls`。
- 因此 DSH 把多 tool 行为交给 provider 默认值；不同 provider/model 是否支持、是否默认并行，未逐家验证。

#### 结论

- DSH 没有“多 tool 请求参数限制”阻止模型发多个调用；`maxParallelToolCalls` 是**执行端并发上限**，不是请求参数。
- 真正的限制来自：
  1. 模型是否愿意/能够在一个响应里发多个 tool_use；
  2. provider 是否支持并返回多个 tool_use；
  3. 输出 token 预算（多个 tool call 的 JSON 也占 output tokens）；
  4. 宿主对每个工具的执行分类（并行/独占）。
- 不要声称“DSH 已开启并行 tool calls”或“provider 一定支持”；准确说法是“DSH 未禁用，DeepSeek adapter 接受多 tool_use block；跨 provider 行为待验证”。

### 4.4 独立插件范围

- 建议独立 repo / 独立 package，例如 `dsh-parallel-tools-prompt`，不要塞进 `dsh-smart-compaction`。理由：
  - 关注点不同：压缩插件管上下文，本插件管模型输出调度；
  - 生命周期不同：压缩插件可能在 compaction scope，本插件需要 standard 会话级 section；
  - 依赖/测试隔离：prompt 插件不需要压缩插件的依赖树；
  - 回滚简单：独立 bundle 可单独 disable。
- 插件是 Host-only bundle，无需 Client/UI；manifest 可参考 `APP:.../dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` 的最小形式（`dsh.bundle.patch` + `apply`/`Config`）。
- 不安装、不改 profile；本文只做可行性研究。

---

## 5. 最小可配置提示词草案

### 5.1 设计约束

1. **默认反转（只读范围）**：从“满足所有条件才 batch”改为“参数已知且独立的只读调用就 batch；有真依赖/冲突才串行”。这是 #6568576744 对 #99 AND-chain 陷阱的诊断。
2. **串行判据最小化**：只有三类理由可以串行：
   - 参数真的需要 earlier result（路径/ID 来自搜索结果、edit after read）；
   - 调用之间会冲突（同一文件/资源、顺序敏感）；
   - 写/编辑依赖执行顺序，或目标文件不 disjoint。
3. **不把“同类工具”当串行理由**：两个 `read`、两个 `grep`、多个独立只读检查，只要参数已知且无冲突，应同响应发出；多个 `edit`/`write` 只有在目标文件 disjoint 且参数已知时才同响应发出，否则串行。
4. **允许单发**：没有其他已就绪调用时，单 call 是正确的；不要为了填满批次而发明调用。
5. **只读投机可以，猜参数不行**：可以多发有明确问题的只读调用；不要猜缺失参数。
6. **不强制 workflow/subagent**：文案不提具体工具名，不要求使用 `workflow` / `subagent` / `run_code`。
7. **不扩大权限**：不提示绕过审批、sandbox、权限；明确“现有 permission/approval/tool-limit 规则不变”。
8. **用 “same response” 而不是 “parallel”**：宿主可能串行执行；承诺“并行”会误导模型和用户。

### 5.2 默认文案（推荐，约 100 词）

```text
- Default to issuing multiple independent read-only tool calls in the same response when their arguments are already known. Reads of different files, separate searches, and independent checks should go together instead of one per turn.
- Serialize when a call's arguments genuinely require an earlier call's result, when calls can conflict on the same file or resource, or when a write/edit depends on ordering. Do not serialize merely because the calls use the same tool.
- Multiple writes or edits may go together only when they target disjoint files and their arguments are already known; otherwise serialize them.
- Do not invent calls to fill a batch or guess missing arguments. A single call is correct when no other useful independent read-only call is ready.
- Keep this scheduling internal: do not add a planning turn. Existing permission, approval, and tool-limit rules are unchanged.
```

### 5.3 短版（适合 token 敏感 / 先做最小实验）

```text
- Issue every independent read-only tool call whose arguments are already known in the same response. Serialize on a real data dependency, a shared-file/resource conflict, or an ordering-sensitive write/edit; do not serialize just because the calls use the same tool. A single call is correct when nothing else is ready. Keep existing permission and approval rules unchanged.
```

### 5.4 带反模式例子版（可选，遵循率可能更高）

```text
- Default to multiple independent read-only tool calls in one response when the arguments are already known. Examples: reads of different files, several search patterns, and checks of unrelated paths should go together.
- Serialize when a call needs an earlier result (for example, a path or ID returned by a search), when calls can conflict on the same file or resource, or when a write/edit depends on ordering. Do not serialize merely because the calls use the same tool.
- Multiple writes or edits may go together only when they target disjoint files and their arguments are already known; otherwise serialize them.
- Do not invent calls to fill a batch or guess missing arguments. A single call is correct when no other useful independent read-only call is ready. Keep planning internal and keep existing permission, approval, and tool-limit rules unchanged.
```

### 5.5 配置草案

```ts
export const Config = z.object({
  enabled: z.boolean().default(true),
  presetIds: z.array(z.string()).default(['standard']),
  sectionName: z.string().default('parallel-tools:guidance'),
  order: z.number().default(1050),
  variant: z.union(['default', 'short', 'examples', 'custom']).default('default'),
  customText: z.string().default(''),
  applyToSubagents: z.boolean().default(false),
  maxTextChars: z.number().default(1200),
})
```

约束：

- `variant !== 'custom'` 时忽略 `customText`；
- `customText` 必须非空、无 `{{`（或显式 `interpolate: false`）、不超过 `maxTextChars`；
- 不做按轮/按 session 随机；A/B 用两个 profile/部署或两个 preset id，不要在同一 session 内切换；
- `presetIds` 默认只 `standard`；不要默认影响 `creator` / `ptc` / `minimal` / subagent；
- `order` 固定，安装后不要改；改 order 等于改前缀。

### 5.6 放置位置

- 建议 `order: 1050`：在 `TOOL_BASH`（1000）之后、`TOOL_READ`（1100）之前；这样通用规则先于各工具的具体说明出现。
- 不要用 `getSectionOrder()` 查一个外部自定义名字；该 API 用于仓库自带 section 的集中分配，外部贡献用任意有限 order（README:56）。
- 不要与已有 section 同名（除非明确要 shadow，见 §3.5）。
- `interpolate: false`，因为文案不需要变量，且可避免例子中的花括号被解析。

### 5.7 为什么这样写

| 设计 | 原因 | 证据/来源 |
| --- | --- | --- |
| “Default to … same response” | 反转默认，避免 AND-chain 保守偏置 | #6568576744；#6568608704 |
| 只保留“真依赖/冲突”两种串行理由 | 降低模型每轮“检查出一个依赖”的逃避空间 | #6568576744 诊断 |
| 点名独立只读/不相交写 | 具体反模式比抽象原则更容易遵循，同时不鼓励冲突写 | #101 评价 #6569051784 |
| “A single call is correct …” | 防止为凑 batch 发明低价值调用 | #101 的修正；#6569051784 |
| 不写 “parallel” | 宿主可能串行执行；避免错误承诺 | §2.4 执行分类 |
| 不写具体工具名/不要求 workflow | 避免绑定版本、避免强制 subagent/workflow | 用户要求；§2.2 |
| “permission/approval unchanged” | 不扩大权限，避免模型绕审批 | 用户要求 |

---

## 6. 稳定 system 前缀与缓存命中影响

### 6.1 静态 section 的机制

- `systemPrompt.section()` 注册的是 section 定义；`assemble()` 每步可以重新组装，但只要 section 文本、order、其他 section、tools、variables 都不变，`renderPrompt()` 的输出字节相同。
- `SystemPromptProjection.project()` 在 `inHistory` 路由下，如果 `latest.text === rendered`，直接返回 `[]`，不 append、不 replace（`LOCAL:@deepseek-ai/dsh-agent-loop/lib/index.js:264-281`）。
- 也就是说：**静态 section 不会每轮产生 `system/message` 事件**，不会每轮改前缀。
- 如果 section 的 `text` 是函数并读取动态状态（当前时间、工具列表、文件列表、计数器），则可能每轮变化；本插件应避免。

### 6.2 首次接入已有会话

- 已有会话的历史前缀里没有这段 section。插件在 resume 后第一次请求时，rendered prompt 与历史中的 system 节点不同。
- 如果路由 `systemPromptUpdate` 不是 `"in-history"`（或新 request series / 路由不支持），`project()` 会把变化**重写 head system node**（`:272-275`），provider prefix cache 从第一个变化的 token 起失效；如果 section 插在很靠前的位置，几乎等于全前缀 miss。
- 如果路由声明 `systemPromptUpdate: "in-history"`，变化会 append 到已缓存历史之后（`:277-281`），前缀到历史末尾仍可复用；但新增的 system 文本本身仍要计费。
- 新会话从第一轮就带 section，之后稳定；不存在“中途插入”的一次性 miss。

### 6.3 A/B 中的缓存测量

- 不要跨 cohort 比较 cache hit rate：treatment 前缀不同，cache 池不同；control 的 cache 可能更暖。
- 对每个 cohort 分开报告：
  - 首请求（冷/半冷）的 `cacheReadTokens` / `cacheWriteTokens` / `inputTokens`；
  - 第二轮之后的稳态 cache read 比例；
  - 每次 treatment 安装/切换后的前 1~2 轮单独标记。
- 关键指标：`cacheReadTokens / (inputTokens + cacheReadTokens)`（按 provider 口径调整；不要假设分母固定）。`TokenUsage` 字段见 `LOCAL:@deepseek-ai/dsh-llm/lib/types/types.d.ts:160-172`。
- 如果 treatment 的 output tokens 降低但 input/cache 成本升高，净收益可能为负；必须一起报告。

### 6.4 不要做的事

- 不要在 `agent/pre-step` 每轮注入“记得并行”的 user message；这会增加每轮上下文，且 append-only 也会增加 token。
- 不要在 section 文本里插入当前时间、session id、工具数量、文件列表、随机数；这些会让前缀每轮变化。
- 不要在 A/B 中途改 section 文本/order；一次实验只改一个变量。
- 不要用 `system-prompt/assemble` 动态拼文本；官方实践不建议，且容易破坏其他插件。

### 6.5 一个重要的边界

`systemPrompt.section()` 的文本变化会导致 `system-prompt/change` 和下一次 assembly 变化；但 **agent 的 prompt 是在 step 开始时 assemble 的**（`LOCAL:@deepseek-ai/dsh-agent-loop/lib/index.js:907`、`:1049`）。因此：

- 在 `agent/created` 里注册 section，能赶在第一步之前；
- 在 agent 运行中注册/修改 section，会在下一步生效，可能中途改前缀；
- 不要在 turn 中间热切换；A/B 应在 session 创建时确定 cohort。

---

## 7. A/B 统计设计

### 7.1 实验单位与假设

- **单位**：session（一个任务的一次运行），不是 tool call，也不是单轮。
- **对照**：A = 当前 standard prompt；B = standard + 静态 section。除该 section 外，模型/provider/reasoning effort/tools/cwd/permission 保持一致。
- **主要假设**：B 降低“模型—工具往返次数 / 完成任务”，且不提高错误率、权限拒绝率、任务失败率。
- **次要假设**：B 降低 LLM 等待与 output tokens；对并行安全工具批次，可能降低 tool wall time。
- **不要**假设 B 一定降低总 wall time；工具执行、审批、用户思考可能占主导。

### 7.2 任务集

- 需要**分层**，避免 #100 的“任务构成主导”问题：
  - 高机会：多文件读取/批量检查/多 pattern 搜索/同构文件成对编辑；
  - 中机会：重构 + 测试循环；
  - 低机会：强数据依赖的分析链、用户在环修改。
- 同一任务在 A/B 两臂各跑 ≥3 次（#100 建议）；任务数先 10~20 个，视方差再扩。
- 固定任务描述、初始 repo 状态、工具集、模型/provider/reasoning effort；禁止中途换模型。
- 固定 `AGENTS.md` / `CLAUDE.md` 等工作区指令；`dsh-agent-instructions` 会把它们作为 user 消息注入，可能掩盖或放大提示词效果。
- 记录任务成功标准（测试通过/文件正确/答案正确），不要只看轮次。

### 7.3 指标与事件来源

| 指标 | 定义 | 事件/来源 | 备注 |
| --- | --- | --- | --- |
| tool-bearing responses | 含 ≥1 个 `tool-call` 的 `assistant/message` 数 | `assistant/message` content | 一次模型响应 = 一个模型—工具批次 |
| multi-call responses | 含 ≥2 个 `tool-call` 的 assistant message 数 | 同上 | 与 #100 的“多 call 轮”同口径 |
| single-call ratio / serial share | 1 − multi-call / tool-bearing | 同上 | 不能单独作为质量指标；单发可能正确 |
| parallel opportunity（标注） | 每个 tool-bearing 响应中“本可同时发出但未发出”的独立已知参数调用数 | 人工/离线标注抽样 | 直接衡量机会，不把单发一概当失败 |
| execution batches / groups | 模型批次 = tool-bearing responses；调度组 = 按 `executionMode` 推导 | `assistant/message` + 工具分类 | 调度组不是日志直接事件；精确值需插桩 |
| calls per response | `tool/call` 总数 / tool-bearing responses | `tool/call` | 衡量打包密度 |
| model attempts | `assistant/message` + `assistant/attempt` | 两个事件 | 失败/重试也算 provider 请求 |
| tool calls | `tool/call` 数 | `tool/call` | **不是** provider API 请求数 |
| turn walltime | `turn/end.time − turn/start.time` | `turn/start`/`turn/end` | 含工具、审批、用户时间 |
| step walltime | `step/end.time − step/start.time` | `step/start`/`step/end` | 含模型 + 工具 |
| LLM wait proxy | `assistant/message.time − step/start.time` | 事件时间 | 含 prompt assembly/请求准备，是上界 |
| TTFT | `assistantStreamFirstTokenTime(stream)` | `assistant/message.stream` | 公开 helper，`LOCAL:@deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:102-116` |
| tool walltime | 同一 step 内 `max(tool/result.time) − min(tool/call.time)` | `tool/call`/`tool/result` | 含审批等待；并行时 < 各工具之和 |
| output tokens | Σ `usage.outputTokens` | `assistant/message.usage` | provider 报告；含 reasoning 的口径以 provider 为准 |
| input/cache tokens | `inputTokens` / `cacheReadTokens` / `cacheWriteTokens` | 同上 | 分开报告 |
| tool error rate | `tool/result.isError` / `tool/result` | `tool/result.message.isError` | 按工具分组 |
| error codes | `tool/result.error.code/name` | `tool/result.error` | 如 `INVALID_ARGS`、`UNKNOWN_TOOL`、`ABORTED_BEFORE_DISPATCH` |
| failed model attempts | `assistant/attempt` 数 | `assistant/attempt` | 失败/重试的代理指标 |
| permission denials | `tool/result.isError` 且 reason 含 approval/sandbox 拒绝 | `tool/result` + approval audit | 没有单一稳定 code；需文本/审计辅助，标为部分可测 |
| redundant calls | 同 tool + 规范化 args 的重复调用 | `tool/call` arguments | 类似 `dsh-repeat-tool-reminder` 的 canonical JSON；需人工判断是否合理 |
| annotated avoidable serial | 单 call 响应中“本可同时发另一个已知参数调用”的比例 | 人工/离线标注抽样 | 解决“单发也可能是正确”的问题 |

事件字段参考：

- `assistant/message` 带 `message`、`stream`、可选 `usage`：`LOCAL:@deepseek-ai/dsh-session/lib/types/types.d.ts:331-343`。
- `tool/call` / `tool/result`：`:355-392`。
- 事件 envelope 的 `time`（Unix epoch ms）：`:490-505`。
- `TokenUsage`：`LOCAL:@deepseek-ai/dsh-llm/lib/types/types.d.ts:160-172`。

### 7.4 必须区分的三种“调用”

| 名称 | 含义 | 计数方式 | 是否 provider 计费 |
| --- | --- | --- | --- |
| tool call | 模型请求执行一个工具 | `tool/call` 事件 | 否（本地执行；web_search 等工具内部可能再发网络请求，另计） |
| model request / attempt | 一次 LLM 请求（含失败/重试） | `assistant/message` + `assistant/attempt` | 是（按 provider 计费） |
| execution batch / group | 调度器实际分组执行的一批调用 | 由 `executionMode` 推导，非直接事件 | 否 |

**不要把 `tool/call` 数当作“真实网络计费调用”。** 一个响应里 3 个 tool call = 1 次 LLM 请求 + 3 次本地工具执行；如果 3 个调用合并进 1 个响应，省下的是 2 次 LLM 请求，不是 3 次。反过来，如果工具本身访问网络（`web_search` / `web_fetch`），那是工具内部请求，不是 LLM provider 请求，需单独统计。

### 7.5 统计报告

- 报告 **median / IQR / p95**，不要只报均值；#6571678049 明确右偏分布必须报中位数。
- 用配对 bootstrap 或分层 bootstrap 给 median difference 的 CI；报告每任务配对差值。
- 分层报告高/中/低机会任务；不要用总体均值掩盖任务构成差异。
- 报告 n（session 数、turn 数、tool call 数），不要用 tool call 数伪装样本量。
- 预注册主指标（建议：每完成任务 model attempts 或 tool-bearing responses）；其他指标标为 secondary，避免多重比较。
- 盲法标注 “avoidable serial” 样本；标注者不知道 arm。
- 单 session 只作存在性证明，不作因果结论（#6571678049）。

### 7.6 护栏指标

- 任务成功率（测试/验收）；
- tool error rate、invalid args、unknown tool；
- permission denial / approval 次数；
- output token 是否异常膨胀；
- 无效/冗余调用数（批处理可能诱发投机）。
- 任一护栏显著恶化，停止 treatment，不继续扩大样本。

---

## 8. 验证范围

### 8.1 已验证（静态源码/精确 API 读取）

- rc.3 与 rc.5 的 `dsh-agent-loop`、`dsh-tools`、`dsh-system-prompt`、`dsh-agent` 核心 `lib/index.js` 逐字节相同。
- agent-loop 的 exclusive barrier + bounded parallel pool；`maxParallelToolCalls` 默认 10；executionMode 失败关闭。
- first-party 工具并发分类：`read`/`read_image`/`web`/`session_query`/`subagent` 并行安全；`glob`/`grep`/`bash`/`write`/`edit` 默认独占。
- standard preset 组成；subagent 专用并行提示的来源与条件；普通工具 section 无通用批量措辞。
- 本地抽样（按目录枚举抽取 80 个 standard session）：74 个含 subagent 委派行，0 个含通用 `multiple tool calls` / `same response` / `batch independent` / `parallel tool` 文本；与源码一致。
- `systemPrompt.section()` 的 scope/shadow/order/change 语义；`system-prompt/assemble` 存在但不推荐用于加文本。
- `agent/created` 的 source 包含 resume；`agent.ctx` 的 scoped 注册；`sessionProjections.stateOf('agentPreset')`。
- system prompt 缓存行为：静态不变 → 无更新；head rewrite vs in-history append。
- DeepSeek adapter 不发送 `tool_choice`/`parallel_tool_calls`；接受多个 `tool_use` block；pi-ai adapter 也不覆盖并行参数。
- GitHub issue #100 正文、9 条评论、指定评论 #6571678049 的内容与数据口径。

### 8.2 未验证（本文没有做）

- **模型遵循度**：没有发送任何付费模型请求，不知道模型是否按新文案增加多 call。
- **实际收益**：没有跑 A/B，不知道 DSH 上的 LLM 等待/token/wall time 变化。
- **缓存命中**：没有读取 provider usage 的对照数据，不知道首次接入的 cache miss 成本与稳态恢复。
- **provider 跨模型行为**：没有逐家验证 OpenAI-compatible / Anthropic / 其他模型是否支持并默认返回多 tool_use。
- **运行时插件接入**：没有安装插件、没有重启 Web；`agent/created` + `agent.ctx.systemPrompt.section` 的实际时序未运行验证。
- **`sessionProjections.stateOf` 在 `agent/created` 时是否已可用**：代码上应可用（header init + projection），但未做运行时断言。
- **`glob`/`grep` 独占是否有意**：只确认当前代码行为，未向上游确认设计意图。
- **权限拒绝的稳定计数**：没有确认 approval audit 事件名与 `tool/result.error.code` 的完整映射；A/B 中需要先做一次事件字典核对。
- **DSH 5.8% / 1.12 大样本**：引用外部评论，未在本地独立复算。
- **PTC 2.0 中位数**：引用外部评论，未独立复算；且明确不作为本插件目标。

### 8.3 下一步如何验证（不在本次执行）

1. **离线单测**：用 mock session/agent 调 `systemPrompt.section` + `assemble`，断言静态文本只出现一次、order 正确、对非 standard 不渲染。
2. **离线事件回放**：用历史 `events.jsonl` 计算 baseline 指标（多 call 比例、calls/response、LLM wait 代理），不产生模型费用。
3. **小规模前向 A/B**：经用户明确批准后，选 10~20 个分层任务 × 3 次，A/B 两臂；记录 model attempts、LLM wait、tool walltime、output tokens、错误/权限。
4. **缓存专项**：单独标记 treatment 首次接入后的 1~2 轮，比较 cacheRead/cacheWrite；不要混入稳态。
5. **仅当 prompt-only 不足**：再评估宿主侧 `glob`/`grep` 的 `isConcurrencySafe` 或调度器改动；这是独立的上游工作，不应由本插件偷偷做。

---

## 9. 建议

1. **做独立插件，不做压缩插件的一部分。** 独立 Host-only bundle，默认 `presetIds: ['standard']`，默认关闭或可一键 disable。
2. **首版只做静态 section + 过滤，不做动态注入、不做 per-turn 提醒。** 保持前缀稳定。
3. **先离线回放 + 小规模 A/B，再谈收益。** 不引用 16~35% 作为 DSH 的承诺；最多说“外部 bash-agent 的离线估算，量级参考”。
4. **把“减少 LLM 往返”和“减少工具 wall time”分开报告。** 不要用“并行”一词混淆两者。
5. **不要改宿主私有代码、不要给 first-party 工具强塞 `isConcurrencySafe`。** 如果未来要提升 `glob`/`grep` 执行并发，走宿主上游评估。
6. **A/B 期间不要在同一 session 内切换文案/order。** 用独立 cohort、独立前缀；报告 median/IQR，不报单点均值。

---

## 10. 参考来源

### 外部

- Issue #100：`https://github.com/lloydzhou/bash-agent/issues/100`
- 指定评论 #6571678049：`https://github.com/lloydzhou/bash-agent/issues/100#issuecomment-6571678049`
- 读取方式：`gh api repos/lloydzhou/bash-agent/issues/comments/6571678049`；`gh api repos/lloydzhou/bash-agent/issues/100/comments?per_page=100`

### 安装宿主 rc.5（asar）

- `APP:/dsh/package.json`（版本）
- `APP:/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:5-8,21-32,83-109`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js:509-518`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js:245-249,334,543-547,684-688,1009`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js:775-779,1084-1088`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js:376-380`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js:176-181,256-259,306,802`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js:140-148`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1706-1717,1726-1742,1868-1877`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1287-1293,1983-1990`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-system-prompt/README.md:56,152-154,164-168`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-agent-loop/README.md:110,120,162-164`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-agent/README.md:61-67,176`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/README.md:56-60,99`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:16-19`
- `APP:/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`（manifest 与 Host export 形式）

### 本地 rc.5（LOCAL）

- `LOCAL:@deepseek-ai/dsh-agent-loop/lib/index.js:264-281,476-524,543-553,618-622,907,1049-1060,1296-1297,1554,2012`
- `LOCAL:@deepseek-ai/dsh-tools/lib/index.js:846,882-885,1788,2507,2750-2765,3153-3158`
- `LOCAL:@deepseek-ai/dsh-system-prompt/lib/index.js:10-43,113-117,245-256`
- `LOCAL:@deepseek-ai/dsh-agent/lib/index.js:564-588`
- `LOCAL:@deepseek-ai/dsh-session/lib/types/types.d.ts:88-95,331-343,355-392,490-505`
- `LOCAL:@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:175`
- `LOCAL:@deepseek-ai/dsh-agent-preset-registry/lib/index.js:48-56`
- `LOCAL:@deepseek-ai/dsh-llm/lib/types/types.d.ts:160-172,506-535`
- `LOCAL:@deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:102-116`

### rc.3 对比

- `RC3:@deepseek-ai/dsh-agent-loop/lib/index.js`
- `RC3:@deepseek-ai/dsh-tools/lib/index.js`
- `RC3:@deepseek-ai/dsh-system-prompt/lib/index.js`
- `RC3:@deepseek-ai/dsh-agent/lib/index.js`

（与 rc.5 逐字节相同；见 §2.1。）
