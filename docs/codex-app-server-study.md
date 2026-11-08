# Codex app-server 深入对照：Human Harness 最小集成方案

> 2026-11-08 核对官方文档与 \`openai/codex\` 开源协议。
> **状态：研究结论与接口草案；仓库尚未接入 Codex、未运行真实模型。**
> 本文是 [Codex-first 架构总览](codex-reference.md) 的下一层技术说明。
>
> 主要依据：
> - [Codex app-server 官方文档](https://developers.openai.com/codex/app-server)
> - [上游 app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
> - [上游 app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol)
> - [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
> - [Codex Skills](https://developers.openai.com/codex/skills)
> - [OpenAI Agent Plugins 打包规范](https://developers.openai.com/plugins/build/plugins)

## 0. 先做三个设计决策

**D1：Human Harness 拥有项目，Codex 拥有一次执行。**  
项目、模板、资料需求、证据验收、人类 TodoList 由 HH 持久保存；Codex thread/turn 只承载特定 WorkItem 的执行与上下文。Codex 的工具审批 **不是** 土地污染调查的专业审批。

**D2：目标集成面是 app-server；SDK 用于初始冒烟测试。**  
\`codex exec\` 适合一次性、无交互的脚本工作；SDK 简化编码调用；**app-server** 提供我们 GUI 最需要的流式事件、恢复、中断、工具审批。**暂不替换现有 Mastra**，先验证最小可行适配层。

**D3：插件复用 Codex 的 Skills + MCP 方向，核心能力独立。**  
PDF/DOCX 处理不是在项目模板里新增一个“会读文档的提示词”，也不是要求所有平台直接运行同一个 Python 文件；先实现具备独立输入输出契约的文档服务，再分别以 MCP 和 Skill 方式连接。

## 1. Codex app-server 的真实执行流程

官方公开了双向 JSON-RPC 2.0 风格协议：
- 默认 \`codex app-server\` 使用 **stdio / 每行一个 JSON**；适合本地桌面/开发原型。
- Unix socket 可用于本机通信。
- TCP WebSocket 目前仍标为**实验性且不受支持**，不能拿来声称已解决公网或多租户部署；绝不裸露未认证端口。
- 可用 \`codex app-server generate-ts --out ./schemas\` 或 \`generate-json-schema\` 导出**与已安装 Codex 版本对应**的协议类型。不要手写一套永久假设兼容的 RPC 类型。

典型过程（仅表示调用顺序，不是可直接运行的完整 JSON-RPC 程序）：

\`\`\`text
spawn("codex", ["app-server"])
  -> initialize {clientInfo: {name, title, version}}
  <- initialize result
  -> initialized
  -> model/list                         # 查模型可用性，不写死模型名称
  -> skills/list {cwds: [...] }         # 查询所需能力是否存在
  -> thread/start {cwd, model, sandbox, approvalPolicy}
  <- thread.id
  -> turn/start {threadId, input: [...TaskPacket relevant text/skill items]}
  <- turn.id
  <- turn/started
  <- item/started, item/*/delta, item/completed ...
  <- [可能出现服务端发起的工具/权限审批请求]
  -> [在授权用户明确答复后响应对应 request.id]
  <- serverRequest/resolved
  <- turn/completed {status: "completed" | "failed" | "interrupted"}
  -> [HH 单独校验任务候选成果、生成用户审核任务]
\`\`\`

**\`turn/completed: completed\` 表示 Codex 执行结束，不代表业务材料已通过审核、检测合格或正式报告签发。**

### 核心 ID 映射

| Human Harness | Codex app-server | 说明 |
|---|---|---|
| \`project.id\` | 无必要的一一对应对象 | 一个项目包含多项工作、多个 Codex 会话 |
| \`workItem.id\` | 默认一个独立 thread | 最小可控的上下文与权限边界 |
| \`run.id\` | \`threadId\` + \`turnId\` + 本地 \`attempt\` | 必须持久化映射，防止串任务、回调错配 |
| \`taskPacket\` | \`turn/start.input\` + 容器/Skill/工具策略 | 任务包不能仅当自由文本拼到 prompt |
| \`candidate artifact\` | \`item/completed\` + 后处理产物 | 产物附版本、来源，未验收前只是候选 |
| \`human review\` | HH 自己的业务审核步骤 | 不等同 \`item/commandExecution/requestApproval\` |

**建议默认一项 WorkItem 一个 thread**，避免跨项目共享无关资料；同一 WorkItem 退回重做，可在原 thread 追加 turn 以沿用反馈。后续若证明确有必要再支持同一阶段复用 thread，必须附带显式输入和权限范围。

## 2. Codex 事件如何投影到 Human Harness

HH 应保留原始 Codex 事件作审计，并将其转换为**与具体 Codex 版本解耦的内部事件**。

| 上游协议事件 | 建议 HH 内部事件 | 对产品界面的意义 |
|---|---|---|
| \`turn/started\` | \`executor.run_started\` | 显示正在执行 |
| \`item/started\` | \`executor.item_started\` | 当前运行的是命令/工具/消息 |
| \`item/agentMessage/delta\` | \`executor.output_delta\` | 只做进度流显示，非正式结果 |
| \`item/completed\` | \`executor.item_completed\` | 保存实际工具结果或完整消息 |
| \`item/commandExecution/requestApproval\` | \`executor.approval_requested\` | 呈现待授权的命令和作用域 |
| \`item/fileChange/requestApproval\` | \`executor.approval_requested\` | 呈现拟写入文件的变更 |
| \`item/permissions/requestApproval\` | \`executor.approval_requested\` | 呈现网络/文件系统额外授权 |
| \`serverRequest/resolved\` | \`executor.approval_resolved\` | 清理或关闭权限等待 |
| \`turn/completed\` | \`executor.run_ended\` | 已结束/失败/中断，然后校验输出 |
| \`skills/changed\` | \`executor.skills_changed\` | 下次任务前重查可用能力 |

必要行为：
- 事件必须带本地 \`runId\` 与实际 \`threadId/turnId/itemId\`；有重复/乱序时不能重复创建业务任务。
- 进度增量 **不能** 触发下游业务步骤；只有经持久化的完整结果与 HH 验收才可推进。
- 命令、文件修改与 MCP 调用的返回结果是**工具运行证据**，不是专业事实结论。
- 结束为 \`failed\` / \`interrupted\` 时，不得写入“Agent 已完成”。
- 停机重启后应通过 thread resume/read 和本地 run 状态核对，不能仅凭断线断定失败。

## 3. 必须分开的三个审批层

| 审批层 | 触发条件 | 权威主体 | 例子 |
|---|---|---|---|
| **A. 执行权限** | Codex 请求更广的 shell、文件变更、网络访问或 MCP 写权限 | Codex 沙盒/权限策略 + 用户授权 | 允许读取指定文件，允许执行受限命令 |
| **B. 资料/产物验收** | 上传材料或 Agent 成果需要检查 | Human Harness 的 \`MaterialRequirement\` / \`DeliverableContract\` | 检测报告是否确为对应机构与批次 |
| **C. 业务专业决策** | 模板明确设置 DecisionGate | 具备权限的人类专业角色 | 第一阶段结束还是进行采样 |

三层不能互相代替。用户允许 Codex 读取 PDF **不表示接受 PDF 内所有数字**；用户批准一次 shell 命令 **不表示认可最终报告**。

### 权限与执行隔离建议

1. **最小授权为默认值。** Codex 可以申请额外权限，不能因为模型提出请求就自动批准。若未来使用自动审批，仍受受控沙盒和权限边界约束。
2. **每项任务有独立工作目录与挂载清单。** 只提供该任务已授权、已审查的资料副本或受控视图；不要把整个用户资料库暴露给执行器。
3. **权限是实际运行设置，不是提示词。** \`toolsAllowed\` 字符串不能代替真正的沙盒、MCP 工具配置和工作目录隔离。
4. **回应服务端 RPC 时使用 request.id。** \`itemId\` 用于显示哪次操作，不是回应审批的 JSON-RPC ID。
5. **限制持久授权。** 需要将 \`acceptForSession\` 或 session-scoped permissions 视为高于一次性授权的操作；默认一次性且显示影响范围。
6. **由 HH 记录批准人/时间/作用域。** 但不要将机密凭证写入项目日志。

## 4. Skills 的实际加载方式与模板的关系

Codex app-server 已有：
- \`skills/list\`：根据 \`cwd\` 发现已安装技能，可显式刷新；包含启用状态、元数据、部分依赖信息。
- \`skills/changed\`：监听到技能文件变化后通知客户端刷新；不能用旧缓存长期假定能力仍在。
- \`turn/start.input\` 里的 \`{type:"skill", name, path}\`：**明确使用**一个已安装、已定位的 Skill，优于只在自然语言里写 \`$skill-name\`。
- \`skills/config/write\`：启用/禁用技能，属于宿主运行时管理，不是项目模板可以静默调用的安装动作。
- \`SKILL.md\` 按需加载，先露出 \`name\` 和 \`description\`，被选择后再读取内容；这是渐进式上下文披露的价值。

### 我们的模板应该描述“需要哪项能力”，而不是写死本地文件路径

示例（**设计草案，不是当前 \`hh.package/1\` 已实现字段**）：

\`\`\`json
{
  "capability": "document.read",
  "semanticVersion": "1",
  "implementationHint": "mcp",
  "skillHint": "document-read",
  "required": true
}
\`\`\`

运行时：
1. HH 先检查当前项目需要 \`document.read\`。
2. Codex Adapter 调 \`skills/list\` 和 MCP 工具查询，检查是否真的安装、启用、允许访问。
3. 只为当前 WorkItem 注入选定 Skill 和相关资料视图。
4. 若没有安装，标记为 **capability_unavailable** 并给用户明确解决方案；不能由 Agent 自称已读取成功。
5. 将所用 Skill、工具与解析器版本记录到运行证据中。未来可考虑内容哈希或包版本锁定；Codex 的 Skill 路径本身不等于不可变版本。

**不要把用户的历史企业资料、检测报告或其他业务数据塞进 \`SKILL.md\` 当指令。** Skill 属于方法资产，调查材料属于项目证据。

## 5. PDF/DOCX 插件：参照 Codex 的插件结构，而不是绑定 Codex

官方 Agent Plugins 已有可移植的包结构：
- \`plugin.json\` — 包身份与版本；
- \`skills/<name>/SKILL.md\` — 如何完成一个工作流；
- \`mcp.json\` — MCP 工具服务连接；
- 平台专用扩展可放 \`extensions.com.openai\`，不能假设其他客户端理解它。

建议未来一个**独立**的文档能力工程：

\`\`\`text
document-capability/                        # 未来计划，当前未存在
  engine/                                   # 独立的 PDF/DOCX 解析器
  schema/hh.document.v1.json                # 保留页码/章节/表格/来源定位
  fixtures/                                 # 原生PDF、扫描PDF、DOCX、中英混排
  tests/                                    # 精确率/错位/失败用例
  plugin.json                               # 可移植的插件身份
  skills/document-read/SKILL.md             # 使用方法/检查来源/异常处理
  mcp.json                                  # 外部工具调用入口
  adapters/hh/                              # HH 的内部受控调用
\`\`\`

**核心解析引擎不是 MCP，也不是 Skill。** MCP 是调用接口；Skill 是操作说明；解析器负责真实工作；HH 负责资料与结果验收。

Docling 可以作为候选解析器之一，但必须和文字层 PDF、扫描件、复杂表格、DOCX 原始结构解析对比。**DOCX 原件不必天然有页码**，无排版渲染时应以段落、表格、单元格和结构路径定位；PDF 用真实页码和区域定位。

## 6. 最小真实集成试验设计（下一轮再动代码）

**阶段 0：锁定版本/协议**
- 在测试环境安装明确版本的 Codex CLI。
- 记录 \`codex --version\`，运行 \`codex app-server generate-ts --out ./generated/codex-protocol\`。
- 不将自动生成的上游大量结构直接并入 \`hh.package/1\`；只在 adapter 边界引用。
- 不在浏览器侧直接启动 Codex。由受控本机服务/后端进程持有 app-server stdio 生命周期。

**阶段 1：无凭证、无副作用的协议冒烟**
- 只验证子进程启动、\`initialize\` / \`initialized\`、\`model/list\`、\`skills/list\`、关闭与错误路径。
- 如果没有可用登录，**停在协议能力验证**，不能谎称模型执行通过。

**阶段 2：一次只读模型任务（需授权与可用凭证）**
- 人工准备一个可公开的测试文件，把一个 HH TaskPacket 变成 Codex \`turn/start\`。
- 测试 thread/turn 映射、事件流、完成/失败/中断、候选结果与 HH 独立验收。
- 不连真实用户私密资料，不允许修改项目数据库或读取无关目录。

**阶段 3：审批路径**
- 在临时沙盒中执行一条需要审批但无危险副作用的操作。
- 同时测试允许/拒绝、超时/断连、命令审批与业务审批互不替代。

**阶段 4：一个只读文件插件**
- 再验证 \`document.read\` 的原件哈希、段落/表格结构、来源位置、解析失败状态。
- 先用 Codex CLI + 一个不同宿主做同一套合约测试，再考虑正式宣称“跨平台兼容”。

每阶段保留日志、安装版本、操作系统、权限配置与测试断言。**目前 0–4 尚未运行；只有文档和旧 Mastra 原型可用。**

## 7. 四个容易误判的问题

1. **Codex 完成一个 turn ≠ Human Harness 完成一个任务。** HH 还需检查 Result、实际产物和人工审核。
2. **Codex 的工具审批 ≠ 业务决策。** 三层审批不能合并成一个“Approve”按钮。
3. **Skill 可发现 ≠ 工具可用。** 技能可能依赖一个没有安装、没有登录或无权限的 MCP 服务。
4. **本地 app-server ≠ 跨平台插件标准。** 它是一种 Agent 执行集成方式；跨宿主工具仍要通过独立能力契约与 MCP/Skill 适配。

## 官方来源及代码参考

- [Codex app-server](https://developers.openai.com/codex/app-server) — 生命周期、JSON-RPC、审批、Skills。
- [Codex source: app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server) — 服务端实现与 README。
- [Codex source: protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol) — v2 消息/类型来源。
- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform) — 官方产品层与 Agent harness 分工。
- [Build skills](https://developers.openai.com/codex/skills) — SKILL.md 与按需加载。
- [Package your plugin](https://developers.openai.com/plugins/build/plugins) — 可移植 plugin.json/mcp.json/skills。
