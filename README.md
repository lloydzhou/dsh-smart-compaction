# dsh-smart-compaction

一个可发布的 npm 项目、一个 DSH 插件入口，内部分离**压缩执行**与**自适应经济策略**。不需要安装第二个策略包，不修改 DSH 宿主，不保证缓存命中或全局最低费用。

插件版本跟随 DSH 的三段版本线（当前 `0.2.1`），使用独立递增的 RC 序号（当前 `0.2.1-rc.1`）。插件的 RC 序号不是宿主最低版本；宿主兼容范围由 `engines.dsh` 单独声明。

## 如何确认插件正在工作

1. 插件页面显示 `agent-preset / Running` 只表示 preset 声明已注册，不证明当前会话使用了该引擎。
2. 安装 bundle 后，会从当前宿主和用户配置动态派生 **standard**，只替换 Basic 压缩 provider，保留其他工具、权限、表达式及参数；既有 standard 会话重启宿主后继续原会话即可。保留 **Smart compaction** 同义 preset 兼容已创建会话。非 standard 的自定义 preset 仍需显式接入，不会强行劫持其他压缩实现。
3. 默认 `adaptive.mode: observe`：有请求 header 后，在自动压力检查中记录 `adaptive-compaction/decision` 结构化 **info** 日志。应在运行该会话的 DSH 进程日志／日志导出器中查找，不是聊天消息。具体文件位置由宿主配置决定，本插件不另写日志文件。
4. RC.3/RC.5 的公开模型元数据没有货币价格字段，插件不会伪造读取能力。默认缺价时使用 DeepSeek V4.1 Flash 官方峰时 USD 参考价格，并在策略日志 `pricing` 标明来源、日期和参考型号；这不是当前路由的真实账单。`referencePriceFallback: false` 可关闭兜底；缺价或币种不兼容时返回 `missing-prices`，固定策略和硬压力保护仍有效。observe 始终不应用经济建议。
5. 实际摘要成功时，宿主日志含 `compaction (step pressure): shadowed ...` 或 overflow recovery；会话持久化日志包含 `compaction/start`、`compaction/summary`、替换消息和 `compaction/end`。仅工具裁剪使用 `compaction/prune`，不会凭空出现 summary 记录。

注意：`decisionApplied: true` 仅表示 active 策略返回了决策，不证明已经压缩、更不代表已节省费用。`off` 不生成策略日志；尚无 header 时也不会产生策略检查。后端提供的策略日志现在包含 `sessionId` / `operationId`，可与下面的实际执行日志关联。宿主需启用 info 级别日志才能看到这些条目。

### 实际模型调用与缓存用量日志

启用 `cacheFirst` 时（不论 adaptive 是否关闭），后端在 **info** 级别输出结构化 `cache-first-compaction/operation` 和 `cache-first-compaction/result`，包含 `sessionId`、唯一 `operationId`、`trigger`、`status` 与 `surfaceChanged`。自动检查（含无操作、仅裁剪）、手动 `/compact`、直接 region/model-switch 路径均覆盖；每次 summary attempt 另含可用的持久化 `compactionId`。不写入聊天上下文，不记录 prompt、摘要文本、工具输出或原始错误消息。

- `summaryAttempts`：真正进入 stock summarize hook 的次数，包含重试、失败和取消；不等同于调用模型次数。
- `llmStreamCalls` 与 `calls[]`：实际观察到的公开 `llm/stream` 调用，或成功 summarize 返回的 `llmStreamCall: true` 证据；`evidence` 区分来源。每条含独立 `callId`、attempt 序号、provider/model、结束状态和实际 usage。`attempts[].llmStreamCall: true` 表示 Basic 成功返回该标记；失败时未知，不写 false。
- **不能把 stream 调用当作已计费请求**：已核对发布版 RC.3 / RC.5，公开 waterfall 在 adapter 查找、prepare 与真正 dispatch 之前触发；无 adapter、middleware 短路、隐藏传输重试都不提供可靠的已计费次数。因此仅裁剪/无摘要时 `modelCalls: 0`、`providerDispatch: none`；有摘要尝试时这两个字段分别为 `null` / `unknown`。`unknownSummaryAttempts` 表示未获得 stream 证据的尝试，绝不能当作免费。
- `usage` 的 `inputTokens` 是**未缓存输入**，DSH 三类输入计数互斥；完整计数时 `promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`，`cacheHitRatio = cacheReadTokens / promptTokens`（范围 0–1）。分母为零时比率为 `null`。
- 缺失计数（包括可选 cache 字段）记为 `null` 而不是 0。多条 usage chunk 按宿主 BlockAssembler 语义取最后一份快照、不累加。失败/取消前已收到的 usage 保留，但不是最终账单证明。
- `knownUsageCalls` / `unknownUsageCalls` 按四个用量字段是否完整划分已知 stream 调用；`knownUsageTotals` 只汇总已报告字段，**不是完整总成本**。`usage` 的每个汇总字段只有所有调用都报告该字段且无未知 summary attempt 时才有值；任意缺失导致该字段 `null`。失败且未报告 usage 的调用不会被当作零消耗。

例：`summaryAttempts: 2, llmStreamCalls: 2, knownUsageCalls: 1, unknownUsageCalls: 1` 表示两次已观察 stream 调用，其中一次用量缺失/不完整；只能参考 `calls[]` 中已报告的缓存命中，不能宣称总费用。正常完整用量 `{inputTokens:20, outputTokens:5, cacheReadTokens:70, cacheWriteTokens:10}` 的缓存命中率是 **70%**，不是 `70 / 20`。这些数据来自宿主 stream/summary API，不是经济策略预测，也不保证真实计费、缓存命中或节省。插件卸载时监听器随 scope 清理；自定义子类若绕过本插件 summarize hook，则不在该 hook 的计量范围内。

### 摘要参数连续性

同会话、同 provider/model 的 stock 摘要请求若未显式提供 `reasoningEffort`，插件从最后一次已路由 request header 补齐；不同路由不继承，已有参数不覆盖。采用实例隔离的异步作用域和公开 `llm/stream` 拦截点，不替换全局服务，保留后续中间件与宿主错误处理。关闭 cacheFirst 时仍为原生行为。

这仅修复参数连续性，不证明 effort 一定影响缓存。工具结果提前裁剪也会改变历史前缀；提供商缓存键、预热与网关路由需要分别控制变量验证。相关讨论：[DSH #11816](https://github.com/deepseek-ai/deepseek-harness/discussions/11816)。

## 启用与禁用（重启后生效）

RC.3/RC.5 会为运行中的 Agent 保留旧引擎版本，公开接口不支持非空会话直接换引擎。因此切换后须重启 Web，再恢复原会话；不需要新建、不改历史。

- **启用 bundle / 主开关**：启动适配器从当前 standard 配置派生插件引擎。手动/自动走缓存优先逻辑，客户端在原生交互上增强文本。
- **禁用主条目 `smart-compaction-integration`**：保留 bundle 的启动适配器；下次启动注册未经转换的原生 standard，旧 smart-compaction 别名也指向原生配置。客户端停止覆盖，恢复宿主默认渲染。
- **禁用整个 bundle**：整层 patch 撤销，原宿主 standard 声明恢复。重启后 standard 会话使用默认引擎。早期显式 smart-compaction 别名会话需保留 bundle、关闭主开关来继续，不改写其历史身份。
- `smart-compaction-preset-adapter` 是 bundle 的启动连接组件，不是第二个功能开关；不要只禁用这个辅助条目。
- 主开关取启动时状态，不承诺即时切换。正在执行的压缩不要中途重启。

前端使用公开优先级 -10 覆盖原生优先级0，保留原生注册；卸载释放覆盖而非删除默认组件。摘要仍是原生事件，诊断另存为ignorable记录。

## Chat UI 压缩卡片

外部 client bundle 使用公开 `conversation.chat.node` 的 `compaction` 与 `manual-compaction` 渲染插槽，保留摘要与原有估算数量。使用原生 secondary 字号、行高和间距，图标在同一位置悬停切换，不并排显示额外箭头。折叠时保持单行，在原有文本中追加观测到的摘要流调用数和缓存比例，窄窗口整体省略。展开后标题吸顶，并为摘要代码块的吸顶工具栏保留避让位置。展开后先显示决策与实际执行详情，再显示原摘要。只有会话 ID 和摘要事件序号准确匹配才显示诊断；无记录时保留摘要展示。

诊断采用实验性的 ignorable plugin records，不进入模型上下文。投影最多保留最近64次有意义操作，迁移是 best effort。手动命令通过宿主的 `{ command, compaction }` 合并节点显示相同详情，并保留运行／失败状态；只匹配内层摘要事件序号，不能拿命令序号替代。仅裁剪、失败或取消没有摘要卡片时，诊断保留于日志／插件记录，不伪造成功卡片。独立摘要钩子的记录可能延迟到下一安全边界。尚未在运行中的 GUI 验证视觉效果，需要更新插件客户端并刷新后确认。

## 开关与默认行为

| `cacheFirst` | `adaptive.mode` | 行为 |
| --- | --- | --- |
| `true`（默认） | `observe`（默认） | 缓存优先执行；只记录经济建议，不应用建议 |
| `true` | `off` | 固定配置的缓存优先执行，不安装策略观察器 |
| `true` | `active` | 缓存优先执行，启用有界经济策略 |
| `false` | `off` | 原生 `BasicCompactionEngine`，不安装策略观察器 |
| `false` | `observe` / `active` / 未填写 | **拒绝配置**，必须显式设为 `off` |

根入口 `{ integration: true }` 仅作为启用标记和客户端发现入口，不提供全局 compaction 引擎；bundle 的独立启动适配器读取该标记，选择注册插件或原生 standard。preset 内普通配置挂载一个 engine 子插件，其依赖为 Basic 服务及 sessionProjections；backend 与经济观察器共享该子插件作用域。卸载父入口统一清理子插件。

## 构建、打包与兼容性

需要 Node.js >=24.9.0。支持已验证的 **DSH 0.2.1-rc.3 与 0.2.1-rc.5**、Cordis **4.0.5**、Schemastery **3.18.5**。假定核心公开 API 向后兼容：`engines.dsh` 使用最低版本 `>=0.2.1-rc.3`，DSH 依赖使用 `^0.2.1-rc.3`。实际测试版本不是安装白名单；npm 的标准 semver 规则仍适用（caret 不跨 0.3，也不自动接纳另一版本号的预发布版）。原始源码参考 ce7073d51254c26cd63b22a60835b8f948deb447（alpha）；兼容验证使用实际发布的两组 npm 包，无 workspace 链接或私有 API 导入。

宿主运行库声明为 peerDependencies，同时列入 devDependencies 供开发测试；链接安装必须由宿主解析器共享这些库，避免两份 Session 导致公开插件记录函数的类身份校验失败。诊断失败会输出一次无敏感内容的 warning，不再静默丢弃。

锁文件仍固定 RC.5 作为默认开发基线；无锁全新安装按兼容范围解析可用版本。已有完整 RC.3 宿主依赖满足同一范围，已验证正常 npm 安装会复用 RC.3，不另装 RC.5 backend。不要将独立目录中解析出的 RC.5 依赖树直接复制到 RC.3 宿主；应由目标宿主安装 tarball 并检查依赖去重。

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack
# 在兼容的目标宿主中，由操作者明确执行：
dsh plugin --profile web add ./dsh-smart-compaction-0.2.1-rc.1.tgz
```

尚未发布到 npm。安装 bundle 并重启后，既有 **standard** 会话会使用动态派生的压缩配置，无需另开会话；标准 preset 的其他配置来自当前实际的 bundle/用户/启动覆盖层，不再使用固定副本。适配器保留同名 standard 注册，并提供 smart-compaction 兼容别名。已运行 Agent 持有旧配置版本，更新后必须重启宿主再恢复会话。普通 `npm install` 仅安装文件，不激活 Cordis bundle。公开宿主读取配置可能像正常启动一样清理已退役 bundle 声明；插件不直接写用户配置或会话历史。

RC.3 与 RC.5 均通过包级兼容验证。当前 Web 宿主已更新 RC.5；引擎接入修复的部署验证通过公开 preset 读取和客户端资源接口检查，不为验收自动发起收费模型请求。

## 自定义 preset 配置

将原隔离 compaction group 的 Basic provider **替换**成此插件，不要并存两个 provider。原 Basic 配置放入 `base`。策略配置现在统一嵌套在 `adaptive` 中，不再添加独立策略插件行。保留同组 pruner 与 `/compact` 命令；CLI/headless 同样采用显式 provider 替换。

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-backend
      name: dsh-smart-compaction
      config:
        cacheFirst: true
        base:
          thresholdRatio: 0.8
          retainRatio: 0.16
        summaryFallbackAttempts: 2
        maxCandidateChecks: 128
        adaptive:
          mode: observe
          prices: []
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
```

要完全回到原生 Basic 引擎：

```yaml
cacheFirst: false
adaptive:
  mode: off
base:
  thresholdRatio: 0.8
```

`base` 保留完整现有 `BasicCompactionConfig`（含 `auto` 和 `modelPolicies`）。`summaryFallbackAttempts` 默认 2，为非负安全整数；`maxCandidateChecks` 默认 128，为至少 2 的安全整数。这两个执行参数在原生 Basic 模式仍校验，但不改变 Basic 行为。

## 执行与经济策略

自动 pressure / context-overflow 入口先试算工具结果裁剪，仅在足够降压时提交；否则先对原始、工具配对完整的前缀生成摘要，再按实际压力裁剪保留部分。取消阻止继续提交或重试，摘要溢出允许有限次缩小前缀。**手动 `/compact` 使用同一缓存优先执行器**，绕过自动压力门槛及经济暂缓，保留最近完整配对单元；目标取初始用量75%与“保留上下文＋摘要预算”的较小值。手动命令要求真实摘要 checkpoint，因此不以仅裁剪返回成功（宿主把 null 显示为“无可压缩历史”）；手动始终先摘要原始前缀，一次有效摘要即可满足请求。自动压缩保留“裁剪足够则不调用模型”的优化。手动 idle 事务使用公开 Session API，保留命令关联、持久化和取消保护。模型切换的宿主私有预压缩路径不在共享执行逻辑覆盖内。

`adaptive` 的全部既有参数均保留。`observe` 只记录结构化预测；`active` 才应用建议。main/summary 两条实际路由分别解析价格：精确匹配的显式旧配置优先，否则默认使用有来源标记的 DeepSeek Flash 峰时参考价格。显式价格默认币种 unspecified；若一条显式、一条 USD 兜底，须明确设置 `legacyPriceCurrency: USD` 才允许混用，否则不作经济建议。无论经济模型建议如何，硬压力和溢出兜底仍由执行层负责。价格、预计调用数、缓存比例、摘要长度和信息损失惩罚是操作者假设，不是在线学习结果或实测收益。

## 项目结构与公共 API

- [统一入口](<src/index.ts>)：默认及命名 `apply`、`Config`、`resolveConfig`，配置矩阵与组合生命周期。
- [执行引擎](<src/engine.ts>)、[选择逻辑](<src/selection.ts>)、[策略协议](<src/policy.ts>)；保留公共 `CacheFirstCompactionEngine` 和 `dsh-smart-compaction/policy` 类型入口。
- [内部策略](<src/adaptive/policy.ts>)、[策略配置](<src/adaptive/config.ts>)、[纯经济评分](<src/adaptive/economics.ts>)；根入口导出 `evaluatePolicy`、`resolveAdaptiveConfig`、策略/价格/观察类型，另有 `dsh-smart-compaction/economics` 入口。
- [执行详细说明](<docs/cache-first.md>)、[经济模型和全部参数](<docs/adaptive.md>)、[验证记录](<VALIDATION.md>)。

源码、测试、脚本、依赖锁文件均在本项目根部统一管理，没有 workspace 或第二个 package manifest。旧目录和旧 tarballs 已移至项目外的独立历史归档，不参与发布。运行时发布白名单仅包含构建产物、文档和一个 preset patch。
