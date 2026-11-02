# dsh-smart-compaction

一个可发布的 npm 项目、一个 DSH 插件入口，内部分离**压缩执行**与**自适应经济策略**。不需要安装第二个策略包，不修改 DSH 宿主，不保证缓存命中或全局最低费用。

## 开关与默认行为

| `cacheFirst` | `adaptive.mode` | 行为 |
| --- | --- | --- |
| `true`（默认） | `observe`（默认） | 缓存优先执行；只记录经济建议，不应用建议 |
| `true` | `off` | 固定配置的缓存优先执行，不安装策略观察器 |
| `true` | `active` | 缓存优先执行，启用有界经济策略 |
| `false` | `off` | 原生 `BasicCompactionEngine`，不安装策略观察器 |
| `false` | `observe` / `active` / 未填写 | **拒绝配置**，必须显式设为 `off` |

默认 `apply` 在同一 Cordis scope/fiber 中创建恰好一个 backend，以及零个或一个内部策略 listener。入口的 `inject` 等待 Basic 所需的 `llm`、`tokenMeter`、`sessions` 服务；策略不等待同一个尚未激活 fiber 提供的服务，因此不会出现子插件就绪死锁。卸载入口会一起移除 backend 与观察器。

## 构建、打包与兼容性

需要 Node.js >=24.9.0。精确目标为 **DSH 0.2.1-rc.5**、Cordis **4.0.5**、Schemastery **3.18.5**；原始源码参考 ce7073d51254c26cd63b22a60835b8f948deb447（alpha）；当前兼容验证使用已发布 RC.5 包。运行时 RC 依赖保持精确版本，不使用 workspace 链接或私有 API 导入。

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack
# 在兼容的目标宿主中，由操作者明确执行：
dsh plugin --profile web add ./dsh-smart-compaction-0.1.0.tgz
```

尚未发布到 npm。安装后按目标宿主要求重启，并在**新会话**选择 **Smart compaction** Agent preset。插件只添加一个源自该版本 standard preset 的固定副本，原有 standard/custom presets 和已有会话不变，也不自动继承用户对其他 presets 的修改。普通 `npm install` 仅安装文件，不激活 Cordis 插件。

当前桌面 GUI 的旧 **0.2.1-rc.3 不在兼容验证范围内**；此次实现不升级、重启或修改它。

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

自动 pressure / context-overflow 入口先试算工具结果裁剪，仅在足够降压时提交；否则先对原始、工具配对完整的前缀生成摘要，再按实际压力裁剪保留部分。取消阻止继续提交或重试，摘要溢出允许有限次缩小前缀。**手动 `/compact` 与模型切换预压缩保留原生选择行为**，不承诺同样的缓存优先顺序。

`adaptive` 的全部既有参数均保留。`observe` 只记录结构化预测；`active` 才应用建议。必须提供 main/summary 两条实际路由的显式价格；默认空价格表不产生经济建议。无论经济模型建议如何，硬压力和溢出兜底仍由执行层负责。价格、预计调用数、缓存比例、摘要长度和信息损失惩罚是操作者假设，不是在线学习结果或实测收益。

## 项目结构与公共 API

- [统一入口](<src/index.ts>)：默认及命名 `apply`、`Config`、`resolveConfig`，配置矩阵与组合生命周期。
- [执行引擎](<src/engine.ts>)、[选择逻辑](<src/selection.ts>)、[策略协议](<src/policy.ts>)；保留公共 `CacheFirstCompactionEngine` 和 `dsh-smart-compaction/policy` 类型入口。
- [内部策略](<src/adaptive/policy.ts>)、[策略配置](<src/adaptive/config.ts>)、[纯经济评分](<src/adaptive/economics.ts>)；根入口导出 `evaluatePolicy`、`resolveAdaptiveConfig`、策略/价格/观察类型，另有 `dsh-smart-compaction/economics` 入口。
- [执行详细说明](<docs/cache-first.md>)、[经济模型和全部参数](<docs/adaptive.md>)、[验证记录](<VALIDATION.md>)。

源码、测试、脚本、依赖锁文件均在本项目根部统一管理，没有 workspace 或第二个 package manifest。旧目录和旧 tarballs 已移至项目外的独立历史归档，不参与发布。运行时发布白名单仅包含构建产物、文档和一个 preset patch。
