# 并发工具提示词插件：后续工作清单

> 配套研究：`docs/PARALLEL-TOOLS-PROMPT-RESEARCH.md`。本文件只列后续工作，不代表已实现、已安装或已验证。

## P0：独立插件骨架（未开始）

- [ ] 新建独立 repo/package（例如 `dsh-parallel-tools-prompt`），不要并入 `dsh-smart-compaction`。
- [ ] Host-only bundle：`package.json` 的 `dsh.bundle.patch` + `index.js` 的 `apply(ctx, config)` / `Config`。
- [ ] `inject: ['systemPrompt', 'sessionProjections']`；不 import 宿主私有模块。
- [ ] `agent/created` 中按 `agentPreset === 'standard'` 过滤；默认不影响 subagent / creator / ptc / minimal。
- [ ] 静态 section：唯一 name、固定 order（建议 1050）、`interpolate: false`、无变量/时间戳/工具列表。
- [ ] 幂等 guard：同一 agent 只注册一次；插件 unload / agent dispose 都能释放。
- [ ] 默认 `enabled: false` 或显式配置开启，便于 A/B 与回滚。

验收：

- 离线单测：mock agent/session，assembly 中只出现一次目标 section；非 standard 不渲染；order 正确。
- 不安装到真实 profile，不重启 Web。

## P1：离线事件回放（未开始）

- [ ] 从本地 `~/.dsh/sessions` 取历史 standard session（注意隐私，只保留聚合统计）。
- [ ] 计算 baseline：tool-bearing responses、multi-call ratio、calls/response、single-call ratio。
- [ ] 计算 LLM wait 代理、tool walltime、output tokens、error/retry 计数。
- [ ] 区分 PTC / 非 PTC；排除 PTC 后再比较。
- [ ] 报告中位数与分布，不只均值。

产出：

- `docs/` 或独立 repo 的离线统计脚本与基线表；不产生模型费用。

## P2：小规模前向 A/B（需用户明确批准后才可发付费请求）

- [ ] 10~20 个分层任务（高/中/低并行机会），每臂每任务 ≥3 次。
- [ ] 固定模型/provider/reasoning effort/tools/cwd/permission。
- [ ] 主指标：每完成任务 model attempts（或 tool-bearing responses）。
- [ ] 次指标：LLM wait、tool walltime、output tokens、cacheRead/cacheWrite、错误/权限/重试。
- [ ] 盲法标注 “avoidable serial” 抽样；报告 median/IQR/配对 CI。
- [ ] treatment 首次接入后的 1~2 轮单独标记，不混入稳态 cache 比较。

## P3：缓存专项（未开始）

- [ ] 对比 `systemPromptUpdate: 'in-history'` 路由与 head rewrite 路由的 cacheRead 变化。
- [ ] 确认新会话首轮 vs 第二轮之后的稳态差异。
- [ ] 如果首次接入 miss 成本显著，评估“只对新会话启用 / resume 后延迟一轮启用”的策略（注意：延迟启用会中途改前缀，需谨慎）。

## P4：调度层评估（上游工作，非本插件）

- [ ] 向 DSH 上游确认 `glob`/`grep` 不标记 `isConcurrencySafe` 是否有意。
- [ ] 若要让 `glob`/`grep` 执行并发，评估子进程/fd 竞争、结果顺序、取消语义；不要在本插件里强改。
- [ ] `bash`/`write`/`edit` 的独占应保持；不要为了 walltime 牺牲正确性。

## P5：发布前检查（未开始）

- [ ] 不把 `tool/call` 数当 provider API 调用数；文档明确三种“调用”的区别。
- [ ] 不引用 16~35% 作为 DSH 承诺；只引用为外部离线估算。
- [ ] 不把 PTC 2.23 均值当目标；引用中位数 2.0 且标注“存在性证明”。
- [ ] 检查插件 disable 后 system prompt 是否恢复原状（无残留 section）。
- [ ] 检查 A/B 期间没有在同一 session 内切换文案/order。
