# Runtime-agnostic Human Harness：Codex 生态版与未来 Octop 中国生态版

> **架构方向**：2026-11-08；仅为产品设计/未来扩展方案。**Codex 和 Octop 的真实执行器都尚未接入本仓库**，现有演示仍由 Mastra 驱动。
>
> 核实的上游：  
> - [OpenAI Codex](https://github.com/openai/codex)（Rust、Apache-2.0）：开源 CLI / app-server、Skills、插件与工具生态。  
> - [TencentCloud/Octop](https://github.com/TencentCloud/Octop)（Python、MIT）：自托管多用户多 Agent 平台，国内 IM/文档连接器、插件、MCP、ACP。  
> - [TencentCloud/octop-harness](https://github.com/TencentCloud/octop-harness)（Python、MIT）：Octop 采用的基于 deepagents 的 Agent 运行时。  
>
> 后续应以**实际安装版本及 API 能力验收**为准，不从 README 推断所有插件都能跨宿主运行。

## 决策

**Human Harness 是一份项目协议 + 项目状态机 + 双角色 TodoList；不是 Codex 或 Octop 的重发行版。**

当前首要目标：**使用 Codex 的本地执行器和原生技能/工具/插件生态**，不集成 Codex Cloud、远程多人协作、云端项目同步或其他与任务执行无关的商业产品特性。若任务调用在线模型或联网工具，那仍取决于用户的模型提供方与工具授权；“不依赖 Codex 联机产品”不等于“完全离线运行”。

未来可以建立中国生态版，以 Octop Harness / Octop 插件、国内模型、企业连接器为主，但**不复制 Human Harness 的项目模板、资料生命周期、处理规则与用户 TodoList**。

**先做一个产品内核，再考虑两套发行配置。不要现在 fork 两个完整 Agent 仓库。**

## 分层

```text
                       Human Harness（共用）
  ProjectPackage / MaterialRequirement / ExtractionPlan / ValidationPlan
   ProjectState + Human TodoList + Agent TaskQueue + Evidence / Events
                         │
                   TaskPacket / TaskResult
                         │
                Executor / Capability Adapter
                  ┌──────┴──────┐
                  │             │
           Codex Adapter   Octop Adapter（未来）
                  │             │
       Codex Skills /    Octop Skills /
       Native Plugins /  Native Plugins /
       MCP Tools         MCP Tools
                  │             │
       国际开发生态       国内文档与企业生态
```

对两个生态都不做“大一统插件格式”的预设。**项目模板声明的是业务能力需求与验收条件**；哪一款插件、哪一种工具、哪个模型可以实现这项能力，由当前执行器的环境发现与用户配置来解析。

## 共用的核心对象

| 共用、不随发行版变化 | 随执行环境而变化 |
| --- | --- |
| 项目模板、阶段、条件、分支 | Codex app-server / Octop Harness / Octop API 的调用方式 |
| 材料需求、产生与请求时机 | 本地文件读取及宿主工作目录映射 |
| 识别字段、信息提取目标、验证方法及异常行为 | 实际可用的 Skills、插件、MCP 服务 |
| Human TodoList 与 Agent 任务队列 | 执行器事件、日志、权限与沙盒 |
| 用户专业决策、资料审核和事件账本 | 模型提供方、认证、地区连接器 |
| TaskPacket 与候选 TaskResult | 各执行器的输出转换和运行状态映射 |

例如某项目模板要求“读取检测报告 → 提取样品编号、指标、单位 → 与现场记录比对”：
- **Codex 环境**调用适合的已安装 Skill/Plugin/MCP 工具；
- **Octop 环境**调用该环境已安装、已授权的 Skill/Plugin/连接器；
- 两种执行器都必须返回可追溯的候选结果与失败原因，交给**同一套 Human Harness 项目流程**处理。

有跨文件验证的专业业务逻辑，原则上保留在模板声明/受控的校验能力中；不要放进无法追溯的临时聊天上下文。

## Octop 实际能提供什么

根据腾讯云仓库 README：

- **Octop 本体**：Python/FastAPI，Web Dashboard、桌面端、CLI、用户/Agent、知识库和定时任务；提供飞书、钉钉、QQ、微信、企业微信等渠道，也提供腾讯文档等 OAuth/MCP 连接器。
- **Octop Harness**：基于 deepagents/LangGraph 的可复用 Python Agent 运行时，支持模型路由、Skills、工具/MCP、状态检查点。
- **ACP**：Octop 提供 `octop acp --agent main` 供外部工具调用，也可通过 ACP 委派到 Codex 等编码 Agent。
- **插件**：Octop 有自己的插件安装与管理接口，但**没有证据表明它能原生安装 Codex 的 `plugin.json` 包或自动获得相同插件行为**。

因此，中国版如果确实需要完整的本土连接器和本地部署功能，Octop 是很好的候选；但它也带了聊天渠道、专家团队、多用户和定时任务等**Human Harness 初期不需要**的功能。应优先评估轻量 Harness/ACP 接入，再决定是否借用完整 Octop 平台。

## 不需要的特性

- 不依赖 Codex Cloud、托管任务队列或远程对话同步。
- 不依赖 Octop 云协作、聊天渠道、专家市场、社交功能；国内接口仅按真实业务需要开启。
- 不重造 Codex/Octop 已经成熟的 Agent loop、Skills 或通用工具。
- 不以“为两个版本做一致 UI”作为当前开发目标。
- 不在没有实际宿主测试的情况下声称一个插件安装包跨 Codex/Octop 通用。

## 两种“发行版”的实际含义

**第一阶段：一个 Human Harness 运行内核 + 一个 Codex Adapter。**  
目标是用已有项目模板完成一个真实 Agent 任务：发现可用技能 → 准备必要素材 → 执行 → 返回候选字段/成果 → 触发用户 Todo。用户已有 Codex 环境即可复用其生态，不需要把 Codex 源码 fork 进本仓库。

**第二阶段（可选）：同一个内核 + Octop Adapter。**  
优先通过 Octop Harness、ACP 或稳定的本地 API 集成，不复制 Next.js 项目状态机。试点可选国内插件中确实不同的能力，例如腾讯文档或飞书文件读取。使用同一个 TaskPacket/TaskResult 合约，比较“任务执行成功、信息来源可靠、缺失能力时能解释”的行为。

**第三阶段（有需求时）：独立发行包/产品形态。**  
可以分别提供 Codex 环境安装说明和 Octop 环境安装说明，甚至后续提供预装配置。但真正 fork 某个上游只应发生在无法通过公开 API 或插件机制解决、且确有必要修改上游内核的情况下。

## 需要保持审慎的地方

1. **同一套项目模板 ≠ 两个运行时输出天然相同。** 工具差异和能力缺失必须可检测；不合规的候选结果不能被当作已完成。
2. **MCP/Skills 是可复用接口，不是整套插件零成本兼容证明。** 插件打包、宿主权限与认证仍不同。
3. **不使用联机产品 ≠ 不需要网络。** 云模型、在线文档和外部地图依然会联网；由用户按需授权。
4. **不建设业务审批子系统。** 资料核查、缺失项和专业判断均是普通的 Human Todo；执行器原有工具/沙盒权限仍需保持。
5. **不承诺中国版已经成立。** Octop Adapter 没有实现，当前版本只有 Mastra 演示执行器。

## 下一步

先做 **Codex 本地 app-server + 原生 Plugin/Skill 调用的一个端到端闭环**；只为这一条路径写一个薄的 Executor Adapter。等项目层和任务协议经真实调用稳定后，再评估 Octop Harness / ACP 所需的最小第二适配器。避免提前引入两个上游框架造成的维护负担。
