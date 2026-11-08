# Parallel-first Human Harness：项目并行与 Codex 多 Agent 的区别

> **架构决策（2026-11-08）**。项目依赖图与 Human / Agent 两类工作队列是默认的工作组织方式，**不是对话或单个 Agent Thread 内的串行循环**。
>
> **当前实现状态：** ProjectState + 共享 runner 支持针对不同 WorkItem 的独立运行预约，新增回归测试验证两个 Agent 同时运行且 Human Todo 不受阻；但 Next.js GUI 仍使用一个全局 `busy`，HTTP `run_agent` 仍等待整个执行完成。**真正支持并行点击/后台任务/事件实时显示属于 P1.2，不得标记为已实现。**
>
> 参考：[Codex 开源多 Agent 配置](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs) · [Codex 子 Agent 工具](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) · [Codex 作为平台](https://developers.openai.com/blog/codex-as-a-platform)

## 1. 为什么默认并行

Codex 可以运行一个任务，并在其内部使用子 Agent 并行处理分工。这属于 **Agent 内部的委派**：一个任务有一个根目标，子 Agent 的结果通常回到父 Agent。

Human Harness 则需要 **项目级并行**，并不预设一个主 Agent 决定所有项目进度：

- **Human WorkItems**：补交材料、审批/确认结果、联系外部机构、做专业决策；
- **Agent WorkItems**：整理资料、抽取信息、调用已有 Skills/Plugins、生成候选成果；
- 两类任务按项目模板明确的依赖关系自动进入 `ready`，可以**独立启动、独立阻塞、独立完成**；
- 只有存在 `dependsOn`、`needsMaterials` 等实际业务依赖的任务必须等待。

**并行是默认调度语义，但不是“所有任务同时启动”。** 依赖项、可用资源、预算、真实文件写入范围和外部授权可能限制并发。

## 2. 两个完全不同的并行层级

| 层级 | 谁决定并行 | Codex 中的对应物 | Human Harness 的职责 |
| --- | --- | --- | --- |
| **项目级并行（默认）** | ProjectPackage 依赖图 + ProjectState | 多个独立 Codex thread/turn | 选出 ready 任务、限制同时运行数、为每个任务安排上下文、维护状态与 Todo |
| **任务内并行（可选）** | Codex Agent 自身与它的多 Agent 工具 | `spawn_agent`、`followup_task` 等 | 将整个任务当作一个有界工作单元，保留其日志/产物，不把所有子 Agent 自动提升为项目任务 |

**同一 WorkItem 不应同时启动两个独立尝试。** 各次执行有自己的 run ID；重复提交必须被拒绝或幂等识别。失败任务可以单独重试，不影响其他正在运行的任务。

## 3. 默认调度规则

1. 每次用户/Agent/外部事件更新项目状态时，根据模板条件计算所有 `ready` 任务，而不是选“唯一下一步”。
2. 人类 Todo 和 Agent 队列展示的是**同一个项目状态**的两个过滤视图，两个角色都可以继续推进。
3. 若资源允许，多个 `ready` Agent WorkItem 可并行运行，**同一个 WorkItem 同时最多一项 active run**。
4. 每项 Agent run 使用明确的 `projectId`、`stepId`、`runId`、Codex `threadId`/`turnId`，日志与结果绝不串号。
5. 每项任务读取已授权的**确定版本素材**，不读取其他项目的私有资料，也不引用未确认的候选成果。
6. 一个 Agent 结束、失败、被取消时只更新该任务及真正依赖它的下游任务；其余任务继续。
7. 完成依赖合流时，只有所有必要前置成果和人类工作都满足要求，才激活汇总任务。
8. 并发上限应由本地执行器与资源策略配置，初期可采用保守上限（如 2 个 active Agent runs）；人类 Todo 不计入 Agent 并发额度。

无需独立的“项目总 Agent”来逐项指挥，否则会把我们与普通聊天 Agent 的区别抹掉。

## 4. 必须避免的并行错误

- **GUI 假并行**：后端有多个 ready 项，但前端一个全局 `busy` 使所有按钮等待一个长时模型调用；P1.2 必须改为后端持久化执行状态、前端仅发起任务并订阅/轮询状态。
- **同步 HTTP 长连接**：单次 `POST run_agent` 直到模型完成才响应，不适合较长任务或离线重连。需要“启动即返回 runId → 后端负责运行 → UI 获取事件和进度”。
- **最后写入者覆盖新状态**：并行完成后不能以启动时拿到的整个旧项目快照覆盖数据库；只允许交易内状态变更，并检查 run 身份与输入版本。
- **输入版本竞态**：如果上游资料被替换，旧 run 的结果不能未经核验继续推进；至少要保存 run→输入版本关系并拒绝过期结果。
- **共享文件系统冲突**：不同任务不能无约束写入同一个文件；优先每任务独立工作目录，只在 HH 确认后合并产物。
- **无限制并行**：可能耗尽本地资源或模型额度；应具备 `maxActiveRuns` 等上限和清晰的排队说明。
- **同一次执行重复完成**：网络重试、事件重放与前端刷新不应重复创建成果或待办。
- **将 Codex 子 Agent 视作独立项目 WorkItem**：除非模板明确把它们提升为独立业务任务，否则其事件属于父 run 的内部执行细节。

## 5. P1 的真实实现先后

**P1.1：先把一个 Codex 任务真正跑通。**  
本地 app-server、任务启动、事件与结果、失败处理。不要为了证明并发先实现自研多 Agent 调度内核。

**P1.2：项目级并行成为工作台的默认行为。**
- 将当前阻塞式 `run_agent` 改为非阻塞提交：服务端确认启动后立即返回 `runId`。
- 持久化 active run 与 Codex thread/turn 对应关系；前端可单独追踪每个任务。
- 去掉工作台对整个项目的全局交互锁，替换为**单工作项**的 pending/running 状态；Human Todo 在模型执行时仍可提交。
- 使用事件通知或轮询刷新数据；不依赖浏览器页面存在才能持续运行。
- 在真实 Codex 环境中启动两项独立 WorkItem，确认都已运行；可分别取消/失败/审阅，后续汇总遵守依赖。
- 检查依赖素材修订、写入资源冲突和并发上限；不把当前“同线程内子 Agent”当成实现项目并行的唯一方法。

**P2：原生技能/插件并行消费。**  
已有 Codex 原生 Plugin/Skill/MCP 能力在各独立 WorkItem 里按任务权限调用。不再为并行另造工具执行器。

## 6. 已落地的测试（与尚未落地的功能）

`tests/runtime-v1.test.ts` 增加 `P0 parallel contract`：
- 同一项目的 `agent-a` 和 `agent-b` **同时预约并保持 running**；
- 同一个 `agent-a` 不能重复启动；
- 两项 Agent 执行中，人类可以完成 `human-task`；
- `agent-b` 提前返回并审核，不会把 `agent-a` 错标完成；
- 只有全部必要依赖满足时，`merge` 才由 `blocked` 变成 `ready`。

该测试使用受控注入执行器，**不是两个真实 Codex 子进程测试**。P1.2 将补足真实 Codex 和 UI 行为。
