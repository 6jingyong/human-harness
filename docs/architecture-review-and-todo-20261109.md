# Human Harness 架构复核与后续待办（2026-11-09）

## 决策

**维持现有项目优先、并行 Todo、稳定任务依赖图的架构；不 fork Codex，不新增 Agent Loop，也不让 B/C 默认回读 A 的原件。**

真实 Codex A→B→C 模型验收因用户当前额度不足暂缓，已创建正式 GitHub Todo：[Issue #4](https://github.com/6jingyong/human-harness/issues/4)。此事项不阻塞其它功能开发。额度恢复后执行 `scripts/codex-abc-live.ts` 的 `real / poison-a / poison-ab`，不要在无额度时重复尝试，也不能用 Demo 冒充模型。

## 静态代码与受控测试复核

| 方面 | 判断 | 依据/边界 |
| --- | --- | --- |
| 模板与项目实例 | 保留 | `hh.package/1` 严格验证依赖与材料循环；项目持有模板快照，单项目持久化于 SQLite |
| Human Todo / Agent Todo | 保留 | 两个视图只是项目图投影，人工补料与审核改变权威状态，不创建第二套审批中心 |
| A→B→C 职责隔离 | 当前设计正确 | `createTaskPacket` 只给当前 WorkItem 的 `needsMaterials` 和已批准直接上游产物；B/C 没授权原件时不能从任务包直接读原件。已用故意传播错误内容的受控测试验证 |
| 真正的并行 | 本地单进程已验证 | `LocalScheduler` 可让另一分支 A 仍在运行时执行已解锁的 B；不是多机器/跨进程队列 |
| 审核与错误传播 | 保留 | 人类批准决定是否释放结果，**不代表事实正确**；故意误结果可向下游传播是必要的职责隔离证明 |
| 资料版本与回退 | 保留 | 新原件通过审核后选择性重开受影响后继；旧成果留历史，当前导出受版本和审核限制 |
| 执行器抽象 | 保留 | 模型只能提交候选，由 runtime/store 管理生命周期；Codex 文本工具动作观察到则拒绝候选，**尚不能保证绝对文件系统隔离** |
| 生产级可靠性 | 未完成 | 跨进程、多个服务实例的租约/取消和多用户权限未验证；当前明确只面向本地单机 |

## 本轮发现的明确实现缺口与处理

此前协议承认 `kind:script`，但 `inspectReadiness` 对所有 script 一律拒绝，`LocalScheduler` 也只自动派发 Agent。因此**不消耗模型额度的确定性处理无法参与同一套依赖/审核链**。

现在补齐第一种有限、可控的脚本能力：

- 内置注册能力 `hh.render.markdown`，只接受**已审核的直接上游 Agent 产物**，按模板依赖顺序原样拼接为内部 Markdown；用户决定/交接作为原文附录。**不判断上游事实，不丢弃故意错误结果，也不碰原始资料**。
- 严格禁用任意 shell/代码或模板自带的脚本，未经登记能力无法导入运行；该 renderer 不允许对外输出契约，也不允许直接 `needsMaterials` 读取原始资料。
- 脚本运行使用与 Agent 相同的 `ready→running→review→done` 和 Human Todo 批准、下载接口；自动调度器支持 script 与 Agent 在同一图中运行。
- 若模板声明专业检查项，脚本全部给出 `unverified`，由人类提供审核理由；不把格式化说成事实检验。
- 可选示例 `examples/approved-conclusions-assembly.hh.json`，展示 A/B 两路结果独立审核后，脚本 C **零额外模型调用**拼装 Markdown；不加入内置模板列表以免污染简洁 GUI。

该能力是**确定性 Markdown 组装**，不是 DOCX/PDF 渲染器，也不意味着用户最终 Word 模板版式已还原。

## 后续工作优先级（不依赖模型额度）

1. **下一步建议：确定性 DOCX 渲染**，以 C 已审核文本和既定 Word 模板为输入，由可信脚本调用现有文档生态，确保文本、图片、标题样式和版式可验收；避免重新编写 LLM Word 排版逻辑。当前仅 Markdown 组装器已实现。
2. 实际项目的文件备份/恢复与中断安全性，保证本地 SQLite + 原件目录不丢失。
3. 将模板的结果/结论作为显式产物分层显示（现有项目资料页已有全局成果列表，后续只在发生真实使用问题时调整）。
4. [**Issue #4：额度恢复后**](https://github.com/6jingyong/human-harness/issues/4) 执行真实 Codex 角色隔离测试，再处理真正的 Skill/模型兼容性问题。

## 测试与诚实边界

- `tests/deterministic-script.test.ts` 验证脚本与 Human Todo、独立 A/B 和自动派发联动，故意错误内容保持不变，脚本无法越权读取原件，未经批准不能下载。
- 真实模型验收仍待办；不能从受控 CI 断言模型一定会听从阶段职责。
- 不宣称脚本支持任意用户代码、DOCX/PDF 生成、多进程安全调度或已经上线。
