# 验证记录：0.2.1-rc.1

2026-11-02。宿主范围 `>=0.2.1-rc.3`，核心依赖 `^0.2.1-rc.3`；测试版本不是白名单。

## 当前代码验证

- RC.5：构建、主机/客户端类型检查、12文件161测试通过。
- RC.3：独立精确版本依赖环境，同样161测试通过；最终根入口表达式简化后的构建/检查已复跑。
- 49个引擎测试覆盖自动与强制手动共享执行、原始前缀保留、配对、事务邻接、并发稳定性、失败清理、取消、持久化失败优先级、有限恢复及循环保护。
- 22个客户端测试包含运行实际发布版 command/compaction 投影函数，验证手动节点为 `{command,compaction}`，准确关联内层 summaryEventSeq，并保留运行/失败/完成展示。
- 4个真实 Loader + AgentPresetRegistry 测试验证动态替换 standard，同名恢复、无全局 engine 泄漏、保留其他配置/JS表达式、重复注册拒绝和卸载重载。
- 15个真实 LlmRuntime reasoning 测试，10个价格来源测试；缺失缓存计数为未知，不把 stream API 调用当作已计费请求。

## 已确认根因与修复

用户截图对应 session-692a1c5d-9628-42c5-b908-74e64ed36bd2，2026-11-02 14:38:16，489条/131086估算tokens；会话preset standard，没有插件诊断。

旧bundle只新增 smart-compaction preset，且只有嵌套engine行，客户端boot未发现插件。新bundle禁用原standard声明，根入口integration模式通过公开配置组合API读取其完整有效配置，仅转换Basic provider，公开registry注册相同standard身份及兼容别名。原会话历史不改写；既有Agent须宿主重启后恢复。其他非standard preset不自动修改。

根入口保持普通Loader表达式求值，适配器读取声明中的未求值子表达式，不引入宽松schema绕过验证。宿主公共读取器可能执行宿主原有的退役bundle清理，插件不手写profile。

手动执行不再调用super.compactNow；使用共享选择/摘要逻辑和公开Session idle事务。明确手动命令生成摘要checkpoint，不以仅裁剪返回null（宿主将null误显示为无历史）；自动路径保留足够裁剪就不调用模型的优化。异常时不刷新未闭合事务、不用持久化错误掩盖原失败。

## 部署状态

- 2026-11-02 用户手动重启完成，当前Web RC.5、PID91842；此前被Bash Guard拒绝的自动重启未绕过。
- 新认证链接只在本机读取。在线公开agentPresets/list/read接口200：standard仍为默认，无broken项；standard声明含dsh-smart-compaction、不含原Basic provider。
- 与部署前保存的有效standard配置比对：仅一个provider替换，逆转换后所有其他子配置完全相同，含工具、隔离组、动态条件；未改写会话历史。
- 认证HTML200且boot包含插件客户端；实际客户端资源200、27937bytes，含manual-compaction和automatic compaction渲染器，SHA256 122a0e47373166b51f6c4297fd1a0a52dd125aa386b9e216e3dabd13f66d056b。
- 以上确认在线注册及客户端资源下发；未做浏览器像素级视觉验收或真实收费摘要调用，旧摘要无新诊断属正常降级。
- 未执行收费模型验收，不宣称真实缓存改善。没有npm发布或Git推送。

## 后续发现：诊断持久化未通过实际运行验收

用户截图中的318项/90004 tokens来自另一个会话7d07cc7f，手动发生于15:23:20–15:24:42，确实在当前重启后。在线投影smartCompaction.records为空，磁盘也无诊断，不能再用旧记录解释。

全局只读审计890个压缩文件，重启后另有自动压缩：会话707d2238，15:17:00–15:19:30，555项/119555 tokens；input53114、cacheRead90880、output4514。手动那次input126158/output4134，未报告缓存计数。现有日志能证明两次压缩，但无法独立证明插件决策路径；observe仅观察不改变经济触发。

实际app.asar宿主Session与链接插件本地appendPluginRecord组合复现私有类身份TypeError，记录未写入。宿主linked resolver对普通dependency优先本地副本、peer使用宿主；此前同目录测试遗漏这一部署形态。修复将宿主运行库改为peerDependencies+开发依赖，诊断失败新增一次性无敏感内容警告。真实解析环境集成验证进行中；当前进程尚未重新加载此修复，不能声称诊断已生效。

样式另已恢复原生小字号、图标悬停切换、sticky标题及代码栏避让；tokens按宿主算法显示K/M，实际在线客户端200已确认。缓存未知有诊断时明确标记Unknown。当前167测试和类型检查通过，未发起收费模型请求。

## 启停兼容最终代码验证与重启后检查

- 用户明确接受启用/禁用后重启Web生效，不要求热切换非空Agent。
- 独立启动adapter根据主开关选择原生/插件standard；主条目禁用不会再丢失standard。整个bundle禁用时宿主声明恢复。
- 真实registry mount/serviceFor检查：ON绑定CacheFirst，OFF绑定Basic，OFF四个压缩方法来自Basic原型，不只是文档名称变化。
- 真实SlotCore + Cordis六测试覆盖两个加载顺序、优先级、完整卸载、声明重建及disposer：插件-10、原生0；撤销覆盖后原生恢复。
- 实际app.asar隔离宿主的公开解析器验证共享Session/helper身份一致；真实编译诊断sink写入临时内存Session并经投影得到1条记录。negative control普通依赖复现类身份错误和0条记录，无真实历史变更、无付费请求。
- RC.3/RC.5最终各14文件186测试通过，类型检查通过；构建已完成。用户再次重启后当前Web PID1876；新认证成功，公开API确认standard为默认且无broken，声明含smart、不含Basic。实际下发客户端200，验证priority -10、sticky与K/M格式存在。
- 线上启用状态配置/资源已核实；未为了验收切换用户bundle或触发收费压缩。禁用后Basic与原生渲染恢复由隔离真实Loader/registry/SlotCore测试证明，新的真实压缩诊断仍待用户正常使用时核对，不对历史记录补造信息。

## 可选缓存写入字段兼容修复

- 新增共享纯用量计算模块，后端与客户端使用相同规则。可信totalTokens减outputTokens提供总输入；无总量时允许完整互斥计数求和。缺失cacheWriteTokens仍保留null，不补零；不一致总量拒绝计算比例。
- 多调用按各次可靠分母加权汇总，不平均百分比；未知尝试阻止计算完整操作命中率。诊断schema v1新增可选totalTokens，旧无此字段的记录仍可读取。
- 用户实际数据6215未缓存/6144命中/3891输出/16250总量的回归测试得到6144/12359，约49.7%。既有旧诊断曾丢弃totalTokens，未改写历史，旧记录仍显示Unknown。
- RC.3和RC.5各15文件194测试通过；构建与类型检查通过。后端需重启才开始保存新字段，客户端刷新加载；未发收费模型请求。

## 后续兼容审计与真实历史回放

- 宿主RC.5桥接仅保留正缓存计数；上游OpenAI实现把缺失缓存明细默认0。因此host事件缺少cacheRead不能区分零值或未报告，不能断言原API缺字段，也不能显示观测0%。
- 投影v2强制旧checkpoint回放，精确单次seq+compactionId关联恢复旧total，只读、不修改事件；聚合增加有界逐调用原始计数证据，避免矛盾总量相消和缺输出导致丢失已知分母。
- 对真实会话只读回放，44382客户端成功解析并生成`cache 49.7%`；44390成功解析并生成`cache read count unavailable (zero or unreported)`。验证原历史文件字节未改变。
- RC.3/RC.5各216测试通过；构建、完整类型检查及diff检查通过。此次尚未重启线上服务，需重启并刷新以回放旧投影；不需新模型调用。

## 已知限制

- 公开模型元数据不提供货币价格；有来源的DeepSeek Flash峰时USD参考兜底不是当前路由账单。
- bash-agent算法不是等价移植，尚无差分一致性验证。
- 模型切换宿主私有预压缩路径不在共享执行覆盖范围。
- 诊断为实验性ignorable记录，不进入模型上下文；投影保留最近64次有意义操作，旧记录无诊断正常降级。
- 依赖联网审计报告24个high项；离线install的零漏洞不是安全证明。

最新修复已重新打包：52,297 bytes，SHA1 `aa3e1efcb46f9aa22350551d08eb4a5e3adf1937`。此前47,263-byte/SHA1 6bad139a987ef2ce4886af5c0591f70ddd21fd18是修复前产物，已被替代。
