# 原生 Codex Plugin 优先：Human Harness 的能力复用策略

> **设计决策：2026-11-08。** 本文替代此前“先开发通用 PDF/DOCX 解析器，再包装插件”的默认路线。**尚未接入 Codex app-server，亦未实测插件安装或调用。**
>
> 官方依据：[Codex / ChatGPT Plugins 架构](https://developers.openai.com/plugins/concepts/plugins) · [Plugin 打包规范](https://developers.openai.com/plugins/build/plugins) · [Codex app-server 源码协议](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

## 结论

**把 Codex 视为已经存在的 Agent + Skills + Plugins 运行时。Human Harness 只负责项目，不重新实现文件读取、通用解析或插件系统。**

之前的 PDF/DOCX 表格解析实验只证明了一件事：**业务模板需要描述“提取什么、如何验什么、什么时候请求人类帮助”**。它不是我们下一阶段要产品化的通用文档解析器。

今后优先顺序：

1. **使用已安装、已授权、实际可执行的现成 Codex Plugin / Skill / MCP 工具**，例如文档读取、GIS、网页搜索、数据表处理；
2. 如果现成能力不足，优先组合多个已有插件和现成方法，通过模板指定步骤及输出约束；
3. 只有出现明确的功能缺口、合约不兼容或质量不足时，才研发独立工具，并优先打包为**原生 Agent Plugin**；
4. 不为 Human Harness 单独维护“PDF 引擎 / DOCX 引擎 / Skill 执行器 / 另一个插件市场”。

**“原生支持 Codex 插件”有两个不同方向：**

- **A（优先）：Human Harness 使用 Codex 作为执行器，直接调用用户已经在 Codex 里安装和授权的插件。** 这是 HH 的执行能力来源。
- **B（可选）：把 Human Harness 本身打包为一个 Codex/Agent Plugin，向 Codex 提供项目查询、待办与材料提交接口。** 这用于用户直接从 Codex 操作 HH 项目，不是读取 PDF 的前置条件。

不要把 A 和 B 混在一起，也不要为了 B 延误 A。

## 1. 最小边界

```text
ProjectTemplate（业务方法）
  ├─ 素材/任务何时需要
  ├─ 必须提取哪些字段
  ├─ 验证哪些业务条件与跨素材关系
  └─ 失败后要人类完成什么
      │
      ▼
Human Harness（任务计划与进度账本）
  ├─ 挑选本次任务的素材引用
  ├─ 校验所需能力是否可用
  ├─ 生成 TaskPacket
  └─ 汇总到一个 Human TodoList
      │
      ▼
Codex app-server（成熟 Agent 执行层）
  ├─ Skills（已有方法）
  ├─ Plugins（安装包身份/依赖/连接）
  ├─ MCP Tools（实际解析/数据/网络等）
  ├─ 沙盒、权限、工具结果
  └─ 返回任务候选结构化成果
      │
      ▼
Human Harness（依据模板核验 + 异常变成 Todo）
```

**项目模板不应复制插件实现的详细操作逻辑。** 模板只负责业务目标、要使用的能力、输入/输出约定与接受规则。插件或 Skill 负责实现“怎么做”。

## 2. Codex 已经提供的真实接口

| 目的 | Codex 原生能力 / API | Human Harness 应做的事 |
| --- | --- | --- |
| 获取用户已经安装的插件 | `plugin/list`、`plugin/installed`、`plugin/read` | 验证插件是否存在、启用、版本是否符合目标 |
| 识别可调用的 Skills | `skills/list` | 仅选择当前任务对应的方法 |
| 检查 MCP 服务是否就绪 | `mcpServerStatus/list` | 验证真实连接、认证和能力，不凭插件名称假定工具可用 |
| 执行项目任务 | `thread/start` / `turn/start` | 将 TaskPacket 映射为一次受控 Codex 任务 |
| 接收执行结果 | `item/completed` / `turn/completed` | 保存有来源的候选产物，由模板规则判定下游动作 |
| 安装/连接用户缺少的能力 | Codex 原生插件管理与连接流程 | 在用户 TodoList 中提示安装或完成授权，**不自行执行静默安装** |

官方文档说明 app-server 的 `plugin/list` 等接口可报告插件是否启用；`mcpServerStatus/list` 返回 MCP 服务宣告的能力与连接情况。

**需要特别注意一个当前真实限制：** 上游文档写明 `thread/settings/update` 或 `turn/start` 的 `disabledPluginIds` 虽然保存了禁用选择，**目前还不会实际过滤插件能力**。因此不能依赖它做权限边界；在严格项目隔离场景中，仍要依靠实际的 Codex 执行环境、工具授权与文件作用域，不可当成已实现的按任务插件沙盒。

上游源码说明：
https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#thread-plugin-settings

## 3. 项目模板只需要引用能力和定义业务检查

**示例为设计草案，不是现有 `hh.package/1` 有效字段。**

```json
{
  "materialId": "detection-report",
  "requiredCapabilities": [
    {
      "runtime": "codex",
      "kind": "plugin_or_skill",
      "semanticGoal": "read_pdf_or_docx_tables",
      "installedPluginId": null,
      "skillName": null
    }
  ],
  "extract": {
    "fields": ["sample_id", "point_id", "result", "unit"],
    "mustIncludeSourceReferences": true
  },
  "validate": [
    {
      "kind": "compare",
      "withMaterial": "field-records",
      "joinOn": "sample_id",
      "fields": ["point_id"]
    }
  ],
  "onUnresolvedIssue": "create_specific_human_todo"
}
```

解释：

- `semanticGoal` 描述需求，但**不能保证插件真的能做**；必须在安装后验证具体功能。
- `installedPluginId` 应来自当次运行的 `plugin/list`，不能由模型凭空猜测。
- `skillName` 与插件工具是可以独立存在的：某些能力只需要 Skill，另一些需要 MCP 服务和登录。
- 验证方法可以来自原有 Skill、MCP 工具，也可以是 HH 已有的确定性条件检查。**优先复用，不复制实现。**
- Agent 返回候选字段与来源，无法确定时说明问题；由模板触发精确的用户 Todo，而不是另建审批模块。

模板可以持久存储“需要某类能力”及首选插件标识；实际 `pluginId`、Skill 路径、可用权限和凭证应按环境/执行时解析，不能把宿主本机路径写死到可移植模板。

## 4. 原生 Plugin 打包方式：需要自己扩展时再使用

OpenAI 当前采用可移植的 **Agent Plugins** 格式。一个最小插件是：

```text
my-document-helper/
  plugin.json
  skills/
    document-review/
      SKILL.md
  mcp.json          # 可选：必须提供真实工具时才需要
```

- 根目录 `plugin.json` 声明插件身份和版本；
- `skills/` 提供方法、上下文和工作流；
- `mcp.json`（可选）连接工具服务；
- Codex 旧兼容结构 `.codex-plugin/plugin.json` 仍有支持，但新项目优先按可移植格式编写。

官方完整说明：[Package your plugin](https://developers.openai.com/plugins/build/plugins)。

**复用现有 Plugin 不需要把插件源代码复制进 Human Harness 仓库。** 安装与更新由 Codex 插件环境负责，HH 只校验能力是否可用和任务结果是否满足模板。

## 5. 那之前的文档解析实验怎么处理？

保留 `experiments/document-methods/` 作为**历史方法合同验证样例**，停止将其视为产品主线：

- 有价值的是“结构化字段、来源引用、跨文件检查和精确 Human Todo”这一业务约定；
- 不再计划把 `pdfplumber` / `python-docx` 实验脚本升级为通用读取插件；
- 既不扩展真实报告解析数据集，也不把自制 Docling 比选作为 Codex 插件集成的前置里程碑；
- 若安装的 Codex 插件输出不符合模板要求，才选取最小材料进行针对性的质量测试。

## 6. 下一项真正有意义的验证

**一次原生插件发现与调用闭环即可，不需要制作更多 PDF/DOCX 解析器。**

1. 在本机明确版本的 Codex 环境中启动 app-server，完成协议初始化；
2. 调用 `plugin/list`、`skills/list`、`mcpServerStatus/list`，记录**真实已安装**、启用和可调用的能力；
3. 选择一个实际存在、能读取测试资料的插件或 Skill，用受控的任务包调用 Codex；
4. 检查输出是否满足模板预期结构及来源引用，不能满足就返回具体限制；
5. 把“读取成功但存在字段冲突”映射为一项 Human Todo；不修改项目真实状态直到运行结果被接收；
6. 若目标能力根本不存在，只提示用户安装/连接现成插件，不自行制造一个假实现。

验收标准是：

> **同一个 Human Harness 项目方法，能由 Codex 环境中的真实现成工具执行，并返回可用于项目流转的候选结果。**

这是产品方向，而非当前完成状态；现在仓库仍由 Mastra 模式运行，Codex plugin/list 尚未接入。
