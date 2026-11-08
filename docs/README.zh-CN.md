# Human Harness（中文说明）

**一个以项目为中心、由人类和 AI Agent 共同执行任务的工作台。**

[通用文档交接 MVP](mvp-document-handoff.md) · [English README](../README.md) · **[Codex 版 V1 开发计划](roadmap-codex-v1.md)** · [Protocol 1.0 协议](protocol/human-harness-1.0.md) · [Codex 参考架构](codex-reference.md) · [插件与跨平台研究](interoperability.md) · [土地污染调查示例](../examples/land-investigation.hh.json)

> **当前定位：本地开发原型。** 已实现基础项目流程、人工审核与演示执行，但并未实现正式 PDF/DOCX 内容解析、跨平台插件部署、真实 GIS 调研或正式行业报告。请勿将软件流程验收等同于专业技术验收。

## 一句话理解

**用项目模板确定工作方法，用持续保存的项目状态确定当前进度，让人类负责现实输入与审核，让成熟 Agent 负责有明确边界的工作。**

传统对话驱动 Agent 常把上下文和下一步行动放在聊天记录里。但真实项目不是一段连续对话：资料可能还没有产生，机构需要时间执行现场工作，有些结论需要人工确认，某个阶段甚至可能直接结束。

Human Harness 希望解决的不是“怎样让 AI 回答得更多”，而是“怎样让一个需要人类、Agent 和外部机构共同参与的项目可靠地往前推进”。

### 具体案例：土地污染调查

新建项目后，用户提供调查目标、地块红线与规划用途；Agent 可以针对**已经收到且可读取的证据**做初步整理。

随后必须由专业人员判断：

- **第一阶段即可结束**：走第一阶段报告审核路线，不要求用户提供根本不会产生的采样和质控报告。
- **需要采样**：先提出候选采样方案，人工确认点位和指标，委托机构开展现场与实验室工作。**机构真正完成相应工作后**，才向用户索取实际检测报告、采样记录及质量控制资料。

也就是说：**项目模板在启动时知道未来可能需要哪些资料，但用户 TodoList 只显示此刻有条件完成的事。**

## 使用方式

1. **手工创建或导入项目模板**。定义初始资料、项目阶段、任务依赖、条件分支、内置资源、能力和最终输出。
2. **从模板创建具体项目**。系统冻结当时的模板版本和摘要；后续改模板不应静默改变已有项目。
3. **在任务工作台直接处理 Todo**。主屏只有左右两列纵向列表：左侧 Human Todo、右侧 Agent Todo；右侧按模板定义的 Agent A/B 和任务状态折叠查看。点击待办才展开表单或审核；汉堡菜单进入独立的项目资料页，原件、模板说明、经过来源引用核验的结构化语义记录和普通 Agent 成果分开展示；人工决策仍是 Human Todo 的一部分。
4. **运行 Agent 任务**。现有 demo/Mastra 和 Codex 本地 app-server（仅文本任务）适配器；任务包限制输入和可用能力。Codex 实际登录调用仍须本机验收。
5. **按条件推进**。资料收到不等于合格；只有通过审核，依赖任务才会被激活。
6. **交付经过审核的成果**。当前支持 Markdown/JSON 下载；真正的 Word/PDF 排版和专业检查尚未接入。

**没有项目模板搜索、推荐或模板市场。** 通用运行内核不负责“找项目”，模板由用户或开发者手工定义。

**新的模板设计要求：** 模板不仅描述材料名称和产生时机，还应描述 [材料的识别、字段提取、验证规则以及遇到异常时生成什么用户任务](template-material-processing.md)。例如，检测报告应当按样品 ID、检测指标、结果、单位和出处提取，再与采样记录及质控资料核对。**这些方法目前仍属于设计方案，尚未接入解析器。**

用户 TodoList 本身就包含资料审核、异常处理和专业决策，**不再单独建设一套审批模块**。只有工具层的沙盒和权限保护仍由 Codex 等执行器遵守。

## 与普通 Agent 的区别

| 通用聊天 Agent | Human Harness |
| --- | --- |
| 对话是主要工作对象 | 项目实例和事件状态才是主要工作对象 |
| 模型经常临时决定下一步 | 工作流条件与人工决策决定任务何时激活 |
| 上传文件多半直接作为上下文 | 资料区分未来需要、待提交、已收到、已审核 |
| 人工确认被当作对话插曲 | 人类 TodoList 和专业决策是核心结构 |
| 运行环境与工具往往耦合 | 通过明确的任务包和工具适配器调用现成 Agent |
| 模型产出通常直接显示 | 候选成果经过验证与人工审核后才能推进 |

核心三个概念：

- **MaterialRequirement（资料需求）**：项目需要什么证据、何时才需要、由谁产生。
- **WorkItem（工作任务）**：现在由哪个角色完成什么动作。
- **Artifact（实际成果）**：实际收到了什么文件或模型产物、对应哪个版本、是否被接受。

它们不是同一个东西。例如，质控报告是一项未来的资料需求；委托机构是任务；机构签发的文件才是实际成果。

## 当前开发进度

| 模块 | 已实现 | 尚未实现 |
| --- | --- | --- |
| 模板 | 手动表单生成基础模板；导入/编辑严格 JSON | 二进制资源包、批量模板管理、跨平台分发 |
| 项目 | SQLite 持久化、模板版本快照、条件任务激活 | 动态衍生任意新任务、上游修改自动失效重算 |
| 人机协作 | 两栏任务、资料收取、人工选择、批准/退回 | 多用户权限、可公开部署的身份认证 |
| Agent | Demo/Mastra、Codex app-server 文本任务适配器（模拟协议 CI 通过）、严格任务包 | 真实 Codex 模型本机验收、插件及并行调度 |
| 文档 | 可保存上传文件，纯文本可读取，Markdown/JSON 审核后下载 | PDF/DOCX/CAD 稳定解析、复杂文档格式还原 |
| 插件 | 内部能力 ID / 协议预留 | MCP 客户端与服务端、Agent Skills 安装与跨宿主验收 |

**不要误解演示模式：** 它不会调用真实模型，更不会访问 Google Earth、现场踏勘、检测机构或任何真实业务数据。

## 本地启动

需要 Node.js 22.19（推荐，CI 同版本；package.json 声明最低 22.13）、npm、可持久保存本地文件的电脑。

**目前实现代码仍在 PR 开发分支，不在 `main`。** 在 PR 合并前使用：

```bash
git clone https://github.com/6jingyong/human-harness.git
cd human-harness
git switch feat/project-first-foundation
npm install
cp .env.example .env.local
npm run dev
```

Windows PowerShell 可使用 `Copy-Item .env.example .env.local`。访问 **http://localhost:3000**。

默认配置 `HH_EXECUTOR=demo`，不需要模型 API Key。

要尝试真实 Mastra 调用，需设置 `HH_EXECUTOR=mastra`、提供方支持的模型 ID 和对应凭证。**项目尚未做真实模型 API 端到端测试**，请不要认为只要修改配置就一定能运行。

测试：

```bash
npm run typecheck
npm test
npm run build             # 浏览器测试需要已构建的 Next.js
npx playwright install chromium
npm run test:browser      # 使用本地正式构建的 Demo 浏览器交接测试
```

GitHub Actions 的 `gui-smoke` 使用 Ubuntu 24.04、Playwright Chromium 和正式 Next.js 构建，并保存 GUI 截图。该测试不读取真实 PDF/DOCX 内容。

## 认识代码结构

```text
src/
├── protocol/        自定义项目协议与输入输出结构校验
├── core/            项目状态、任务激活、资料审核与 SQLite 存储
├── executors/       Mastra Agent 适配器
└── app/             Next.js 工作台与 /api/v1 接口
examples/            项目模板示例
docs/                协议、业务蓝图、插件兼容方案
tests/               流程与结构化协议回归测试
```

协议分成三个对象：

- `hh.package/1`：定义一个项目类型及其运行规则。
- `hh.task/1`：把当前任务目标、授权的资料引用和工具范围交给执行器。
- `hh.result/1`：Agent 返回结构化候选成果和建议，**不能直接篡改已审核的项目状态**。

目前本地状态保存在 `.human-harness/protocol-v1.sqlite`，上传文件在 `.human-harness/uploads/`。这些文件不提交 Git。旧版测试使用的 `projects.sqlite` 未迁移，也不会由新内核自动读取；删除本地旧目录前需先备份。

## 核心运行原则：人类和 Agent 默认并行

Human Harness 不是一个主 Agent 依次执行全部任务的聊天循环，而是**项目模板的依赖图决定并行程度**：可以同时做的 Human Todo 和 Agent 任务就分别推进，需要等资料或上游成果的任务才阻塞。**满足授权、能力和资源条件的 Agent Todo 默认由后台自动派发**，用户只需处理自己负责的事项，而不必逐项点击执行 Agent。Codex 自身支持子 Agent 并行，但那是**单项任务内部**的机制，不等同于我们的项目级并行。

**本地并行工作台第一版已接入**：新建项目默认自动派发互不依赖的 Agent WorkItem（项目内默认最多 2 项），Human Todo 有独立的提交锁，状态每 2 秒轮询；可暂停、恢复、调整项目并发数。旧项目默认暂停，避免未经确认突然产生模型费用。仍仅是单 Node 进程后台 worker，而非跨进程的可靠任务队列；本地任务支持取消并拒绝接受迟到结果，单机进程重启后遗留的执行会标记为失败、需要人工批准重试，不会静默重放；真实 Codex 双运行、服务进程崩溃恢复与浏览器端交互仍需实际验收。**通用文档示例已通过 Chromium 浏览器中的 Demo 模式完整交接测试（2/2）**，但不等于真实 Codex 并行或文档解析验收。详见 [并行优先架构](parallel-first.md) 和 [Agent 任务归属及资料语义记录](agent-groups-and-semantics.md)。当 Agent 在执行中需要补充已在模板声明的资料信息时，现会直接产生 Human Todo；用户回复后相同 Agent WorkItem 自动重新排队，详见 [Agent→Human 补充信息闭环](agent-to-human-request-loop.md)。现在 Human Todo 可以上传补充原件，必须按模板验收后才释放原 Agent；已接受原件也可从资料页替换。新版本通过审核后，按模板依赖图使相关成果失效并重新审核，无关分支不受影响。参见 [原件版本更新和结果失效](material-version-replacement.md)。

项目模板现在可声明每类资料的**获取／提取／验证方法**，以及 Agent 步骤的程序、检查项和缺料去向。执行器必须返回与模板一一对应的来源化自检结果；未通过或未确认的事项需要明确人工审核理由。已提供一个可选的三 Agent 规格冲突核对模板（使用固定测试样例，非真实供应商调查），详见 [模板方法与并行项目验证](template-methods-pilot.md)。

## P0 已完成：把执行器与项目状态分开

当前已实现一层精简的可替换执行器：`src/executors/runner.ts` 统一负责任务预约、限制可见素材、验证候选成果和更新项目状态；`demo` / `mastra` 执行器只接受任务包与授权证据，不拥有整个项目数据库。测试覆盖数据作用域、非法输出以及未知执行器配置不回退演示模式。

**P1.1 已具备 Codex app-server 文本任务接入代码**：设置 `HH_EXECUTOR=codex` 后会尝试调用本机已安装的 Codex CLI，不会回退 demo。首次请先完成本机 Codex 登录，并运行 `npm run codex:smoke` 验证真实模型；CI 只验证模拟 JSON-RPC，并未证明真实调用已成功。文档 Skills/Plugins/MCP 尚未接入。详见 [开发阶段与验收标准](roadmap-codex-v1.md)。

## 优先参考 Codex 的成熟 Harness

**今后的主要技术参考统一为 [Codex 开源架构](codex-reference.md)。** 不再默认平行研究一长串 Agent 框架。

我们重点学习 Codex 的任务执行循环、上下文与会话管理、流式事件、工具路由、沙盒权限、人工审批，以及 `app-server`、SDK、`codex exec` 等集成边界。已经整理 [app-server、Skills、三层审批的源码对照与最小集成方案](codex-app-server-study.md)。真正属于 Human Harness 的仍然是**项目模板、用户待办、资料生命周期、专业决策和最终交付验收**。

当前代码新增了 Codex app-server 文本任务适配器和仅限已接受 PDF/DOCX 的 Skills 发现/显式调用实验桥接；**尚未通过真实登录模型与文档 Skill 的验收，通用 Plugins/MCP 也未接入**。我们先理解并验证接口，不因选定参考对象就马上替换已经可运行的代码。

## 新增：可复现的 PDF/DOCX 素材方法实验

我们没有先开发通用插件，而是制作了**两份明确标注为合成测试资料、但是真正 PDF/DOCX 格式的文件**，用现成解析库读取原始表格，然后按 [方法声明](../experiments/document-methods/methods.json) 做字段完整性和跨文件一致性验证。结果确实找到 **S-002 点位冲突**和 **S-003 单位缺失**，并输出两条带原始位置的 Human Todo 建议。

- [运行实验](../experiments/document-methods/README.md)
- [测试结果与局限](document-methods-experiment.md)
- [Codex 可发现的演示 Skill](../.agents/skills/document-evidence-demo/SKILL.md)

**这不是正式 PDF/DOCX 读取功能，也没有启动 Codex。** 实验只验证固定表头的合成表格，后续仍需扫描件、复杂表格及真实布局的系统测试。

## 共用项目内核，未来可有 Codex / Octop 两种生态配置

Human Harness 主要利用 **Codex 本地的 Agent、Skill、Plugin、MCP 生态**，不必继承 Codex Cloud、云端多人协作等在线产品特性。通过在线模型 API 执行任务仍可能需要网络，但这不等于依赖 Codex 云端产品。

未来中国生态版可以优先评估腾讯云开源的 **Octop / Octop Harness**：它已有国内模型与飞书、钉钉、微信、企业微信、腾讯文档等连接器，以及独立的插件和 Skills 机制。

**两者应共享同一套 Human Harness 项目模板、素材处理方法、项目状态和用户 TodoList**；不同的仅是执行器、可用插件、宿主权限及连接器。不把 Codex 插件格式和 Octop 插件格式假定为直接兼容，也不立即维护两套 fork。

[两种生态发行方案与边界](ecosystem-distributions.md)。**Codex 适配器已实现基础协议，但未完成真实模型验收；Octop 尚未接入。**

## 优先原生复用 Codex 插件，不再自行开发通用解析器

**下一步不开发自己的 PDF/DOCX 读取器。** Human Harness 只给出「当前项目需要提取哪些字段、核验什么、出现问题如何生成用户 Todo」，由 Codex 直接调用环境中已经安装、启用和可执行的 Plugin / Skill / MCP 工具。缺少能力时优先通过 Codex 原生机制安装/连接；只有确有缺口才研发新工具。

[原生 Codex 插件复用方案](codex-native-plugins.md) 给出了 `plugin/list`、`skills/list`、MCP 就绪状态、能力绑定及缺失能力处理方案。把 Human Harness 自身发布成一个 Codex Plugin 是**另一条可选方向**，但不是我们复用现成 PDF/DOCX 插件的前提。

之前的合成 PDF/DOCX 实验仅保留作方法合同验证，不继续作为解析器研发路线。**目前已有 PDF/DOCX Skill 的发现与显式调用桥接，但真实本机模型 + 文档 Skill 尚未验收；其他插件/MCP 能力仍未接入。**

## 我们接下来怎样学习成熟 Agent / 插件？

**不复制整个成熟框架，而是优先复用它已经解决的问题。**

- **Codex**：作为唯一主要的 Agent Harness 架构参考；优先核验 SDK、app-server 与权限/事件机制。Mastra 暂时保留为当前执行器。
- **MCP**：优先使用现成 Codex Plugin 中已提供的 PDF/DOCX、GIS、文件检索工具；无需为它们重新开发服务。
- **Agent Skills**：使用 `SKILL.md` 组织操作说明、参考资料和可复用脚本。
- **平台适配器**：分别测试 ChatGPT/Codex、Claude Code、Gemini CLI、Cursor 等环境的文件访问、工具权限、安装与认证差异。
- **专业文档能力**：优先查询 Codex 已安装插件和 Skill；确无现成方法且业务确实需要时，才评估 Docling 等后端。

**跨平台不等于所有平台零配置、功能百分百一致。** 我们要追求的是“同一个核心能力，在不同环境有清晰、可测试的接入方式”，而不是为每个平台复制一套 PDF 阅读器。

首个接入场景仍是 PDF/DOCX 读取，但不预设必须开发名叫 `document.read` 的新插件。关键是让已有插件返回模板需要的字段、来源定位与异常说明；**Codex 的插件实现负责怎么读，Human Harness 的模板负责需要读什么、如何验收。**

参考：[插件与跨平台研究路线](interoperability.md)。

## 贡献与边界

欢迎提交 ProjectPackage 示例、测试场景、可在多个宿主使用的文档能力、错误报告和改进建议。新能力应同时说明输入输出、支持的运行系统、权限、依赖、失败方式与可验证用例。

**安全提醒：** 当前仅供本地开发；缺少身份认证、沙盒和多租户隔离，不应公开暴露，也不应上传无法安全保管的敏感业务资料。人工点击“资料可接受”只是工作流状态，不代表已经完成检测数据的专业审查。

项目使用 [MIT License](../LICENSE)，当前尚未发布可直接安装的跨平台插件包。

---

**核心原则：模板定义计划，项目记录现实，人类提供证据并做决定，Agent 负责在授权边界内完成工作。**
