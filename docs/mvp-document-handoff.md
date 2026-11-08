# 通用文档交接样例（实验性）

Human Harness 的示例模板 **双文档信息核对与交付**（\`examples/document-handoff.hh.json\`）用于验证：

**人类上传两份原件 → 审核并接受 → Agent 提取/比对 → 人类审核结果并填写核对意见 → Agent 结合人工意见形成最终候选结果 → 人类最终审核。**

## 当前已接入

- \`src/core/store.ts\` 注册两个内置模板：此通用样例与原土地调查案例。前者是 GUI 默认选择。
- Human TodoList 和 Agent 工作卡片共用项目状态；顶部新增交接总览与任务依赖/材料详情导航。
- 原件仅在被 **接受** 后通过任务包的 \`readableInputs\` 授权；runner 加载受限原件字节但不把私有上传路径交给执行器。
- 受控工作目录只暂存该次任务允许的 PDF/DOCX 原件，使用临时文件名与 SHA-256 核对；任务结束清理目录。上传的 KML/CSV 等已有可读文本继续以文本提供，不被误送到文档 Skill。
- 文档任务通过本机 \`codex app-server\` 的 \`skills/list\` 找到启用的 \`pdf\`/\`docx\` Skill，使用 \`turn/start\` 的 Skill input 显式指定，不由 Human Harness 重新解析 Office 文件。任务请求限制为 \`workspaceWrite\`、仅临时工作目录可写、禁用网络，并拒绝交互权限升级。
- 完成人类行动/专业决策/外部里程碑时，**只将直接前置且已完成**的 Human Todo 文字传给下游 Agent，避免透露整个项目的其他私有任务。
- 经过人工接受的上游 Agent 成果与原件、人工补充意见同时进入最后一步。

## 本机运行

1. 安装 Node.js 22+ 和最新版 Codex CLI，使用本机 \`codex login\` 完成登录。
2. 确认本机 Codex 已经安装并启用 PDF、DOCX Skills，并且对应解析依赖（Python/文档工具）可用。不是所有 Codex 安装都预装这两项。
3. 在 \`.env.local\` 中配置：

\`\`\`bash
HH_EXECUTOR=codex
HH_CODEX_DOCUMENTS=1
# 如果 Skill 名称不同，可按实际 skills/list 值指定：
# HH_CODEX_PDF_SKILL=pdf
# HH_CODEX_DOCX_SKILL=docx
\`\`\`

4. \`npm install\`、\`npm run codex:smoke\` 检查真实文本任务；\`npm run dev\` 打开本机工作台，选择「双文档信息核对与交付」。
5. 上传真实可用的 PDF 与 DOCX，分别接受两份资料，再执行第一个 Agent 任务，审核结果，填写处理意见，再运行第二个 Agent 任务并人工审核成果。

使用 \`HH_EXECUTOR=demo\` 也能验证该流程，但**不会读取或解析文档，不代表真实 Codex/Skill 验收**。

## 现阶段限制

- CI 采用模拟的 stdio JSON-RPC 进程，测试消息、沙盒参数、模拟技能清单与已授权文件字节。**没有真实 Codex CLI 登录/模型调用/实际 PDF 或 DOCX Skill 的验收记录。** 真实运行能否通过还依赖所安装 Codex 版本、Skill 清单字段和本机依赖。
- 目前文档只作为读取/提取输入；最终交付仍是经人工审核的 **Markdown/JSON**。没有正式 DOCX/PDF 输出或附加文件回收流程。
- 每个原件最多 12 MB，一次任务全部原件总计最多 32 MB；不支持扫描 OCR、CAD、复杂图纸的内建解析。
- \`HH_CODEX_DOCUMENTS=1\` 是明确启用本机文档技能/命令执行能力，不保证能彻底隔离恶意文档与有缺陷的第三方脚本。只在可信单机上处理可信资料，禁止公网部署。
- Agent 执行仍是单次阻塞 HTTP；GUI 仍有全局 \`busy\`。真正后台自动并行、独立事件流与主动取消尚未实现。
- 缺失技能、Skill 路径不符合协议、权限或依赖不满足时明确失败，不退回 Demo，不编造解析结果。
- 模板 \`mastra.agent\` 是 Protocol 1.0 的历史通用 Agent 能力标识，实际执行器由 \`HH_EXECUTOR\` 选择。之后再考虑更新命名，不在本轮迁移协议。
