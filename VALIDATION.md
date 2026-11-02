# 验证记录

2026-11-02：依赖已从最初的 alpha 基线切换到用户 Homebrew 对应的已发布 **DSH 0.2.1-rc.5**。Node v26.12.1；Cordis 4.0.5、Schemastery 3.18.5、Loader 1.0.6、Include 1.0.10。

## 已验证

- 根项目唯一 npm 包：dsh-smart-compaction@0.1.0，无 workspace 或第二个策略包依赖。
- `npm run build`、`npm run typecheck` 均通过。
- `npm test`：6 个文件，**65 个测试全部通过**。覆盖配置矩阵、成本评分、裁剪试算、真实摘要事务、取消、单一 provider、Loader 生命周期与策略卸载重载。
- RC 的 TokenMeter 在构造阶段要求 SessionProjectionRegistry；已在单元测试 fixture 中补齐真实 registry。真实 Loader 集成测试原本已包含该服务。不是跳过失败测试或伪造注册。
- npm 正常 clean install 成功，未使用 force/legacy-peer-deps。旧 alpha node_modules/lockfile 已保留到临时归档。
- `npm pack` 生成一个 tarball，21 个文件、22,706 bytes，包含许可证及上游声明。SHA-1：`b459096f4dfe62960fbad92f5a361486b7392636`。
- 最终 tarball 在独立临时目录安装 RC 依赖后，[smoke 脚本](<scripts/packed-smoke.mjs>) 验证 default observe、cache-first/off、active、native Basic/off 四种模式，以及卸载/重载无重复，全部通过。

## 范围与注意事项

原始源码研究和 preset 副本来自 DSH ce7073d512（alpha）；来源注释保留，不冒充 RC 源码。当前执行接口和包安装已针对 RC.5 验证，但没有安装全部 Web standard 工具、操作当前 GUI 或验证 preset 菜单。测试使用确定性 LLM adapter 及植入历史，不代表真实模型账单、缓存命中率或完整工具回合测试。

手动 /compact 与模型切换使用宿主行为。经济策略基于配置假设，并非实测收益或全局最优保证。

联网依赖安装报告 **22 个 high 审计条目**；未强制修复宿主依赖。此前 alpha 的17条结论不适用于当前依赖树；离线 install 显示零漏洞不是有效联网审计结果。部署前需审阅并跟进依赖公告。

没有发布 npm，没有修改运行中 GUI。GitHub 推送由用户另行明确授权，npm 发布仍由用户自行操作。
