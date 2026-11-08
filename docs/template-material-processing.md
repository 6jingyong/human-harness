# 模板驱动的素材处理：识别、提取、核验与用户 TodoList

> **设计决策（2026-11-08）**。此文档描述下一阶段模板协议方向，**尚未写入当前 `hh.package/1` 校验器、运行时或 UI**。现有系统只实现资料接收、人工标记接受及状态激活，不能被解释为已经完成 PDF/DOCX 内容核验。

## 0. 结论

Human Harness 不再规划独立的「审批模块」。**任何需要人类动作的事项，都作为一个普通的 Human WorkItem 投影进用户 TodoList**：

- 提供资料、补充说明；
- 检查提取字段或异常；
- 比对多个文件并确认结果；
- 审核 AI/脚本的候选成果；
- 作出专业决策或确认外部里程碑。

Codex 的沙盒/文件/网络权限检查仍是**执行层安全机制**，不得因为取消「业务审批模块」就取消必要的工具权限约束。它不取代 Human TodoList，也不定义业务上的资料是否可靠。

**ProjectTemplate 不是一张任务列表。它应当是一份“工作方法定义”**：指定在实际项目中每种资料何时产生、怎么识别、如何读取、提取哪些信息、用什么依据验证，以及何时需要用户介入。

## 1. 模板中应分别定义的对象

| 对象 | 解决的问题 | 例子 |
| --- | --- | --- |
| `MaterialRequirement` | 什么材料、产生时机及来源 | 检测报告必须来自对应检测机构，通常在实验室完成后请求 |
| `MaterialRecognition` | 用户上传的究竟是什么 | 文档类型、报告标题、机构、签发日期、附件版本 |
| `ExtractionPlan` | 从材料里提取哪些具体信息 | 样品编号、点位、检测项目、结果、单位 |
| `ValidationPlan` | 怎样验证文件及提取结果 | 原件基本完整、字段齐全、数值有效、跨文件关联一致 |
| `StructuredFact` | 已提取的结构化候选事实 | 采样点 A、样品 S-01、某检测指标的值与单位 |
| `HumanWorkItem` | 何时需要人类具体干预 | 检测报告的样品编号与现场记录不一致，请确认映射 |
| `EvidenceArtifact` | 事实从哪里来、哪一版、怎样得到 | 检测报告原件 + 解析结果 + 页码/表格/单元格定位 |

**区分三件事：**「文件已收到」「文档已正确解析」「业务事实已经核验」不是同一状态。即使文件通过了格式检查，也不能自动宣称它已经满足专业要求。

## 2. 建议的材料处理流程

```mermaid
flowchart TD
 A["材料需求被激活"] --> B["用户提交 / 外部机构交付"]
 B --> C["识别材料类型与原件元数据"]
 C --> D["执行指定的提取方法"]
 D --> E["结构化候选信息 + 原始位置"]
 E --> F["执行指定的验证方法"]
 F --> G{"足以继续？"}
 G -->|"是"| H["将已验信息供下游任务使用"]
 G -->|"存在可处理问题"| I["自动补提取或回退至人工核查"]
 I --> J["Human TodoList：具体需处理的问题"]
 J --> F
 G -->|"无法完成"| K["记录明确阻塞原因，允许补料"]
 ```

验证分为**可在接收时做的检查**与**后续资料齐全才能做的跨文件检查**。不能因为当前尚无质控报告，就认定已经收到的检测报告必然不合格；应等待条件满足后再验证一致性。

自动检查应尽量先运行；只有缺失信息、冲突、低置信度或专业判断等**确实需要人类的情形**才产生对应 Human Todo。不要默认每个文件都创建一个“请审核”任务。

## 3. 模板中的推荐声明方式（未实施的扩展草案）

以下是为「检测报告」准备的**模板片段草案**，不是当前可导入的 Protocol 1.0 JSON。字段名称和解释仍需通过真实 PDF/DOCX 样例验证。

```json
{
  "id": "detection-report",
  "title": "正式检测报告",
  "requiredWhen": {
    "type": "decision",
    "stepId": "stage1-route",
    "option": "sampling"
  },
  "requestWhen": {
    "type": "work_done",
    "stepId": "lab-work-complete"
  },
  "recognition": {
    "method": "document.identify",
    "expectedKinds": ["laboratory_detection_report"],
    "checks": ["file_integrity", "issuer_present", "report_identifier_present"]
  },
  "extraction": {
    "capability": "document.read",
    "skill": "lab-report-extraction",
    "methodVersion": "1",
    "fields": [
      "report_id",
      "issuer",
      "issue_date",
      "sample_id",
      "sampling_point_id",
      "analyte",
      "result",
      "unit",
      "detection_limit"
    ],
    "outputSchema": "hh.lab-results/1",
    "provenance": "required"
  },
  "validation": [
    {
      "id": "required-fields",
      "method": "schema.check",
      "inputs": ["hh.lab-results/1"],
      "onIssue": "request_missing_material_or_human_check"
    },
    {
      "id": "match-sampling-records",
      "method": "evidence.cross_check",
      "requires": ["field-records"],
      "joinKeys": ["sample_id", "sampling_point_id"],
      "onIssue": "create_human_todo"
    },
    {
      "id": "professional-review",
      "method": "human.when_needed",
      "trigger": ["unresolved_discrepancy", "critical_professional_judgment"]
    }
  ]
}
```

重要的边界：

- `extraction.fields` 定义 **业务要什么**，而不是强制规定某个模型必须怎么做。插件可以使用 Docling、纯文本解析、版面视觉识别或人工录入实现。
- `validation.method` 必须对应已安装、被允许执行的能力，或有明确人工操作说明。**字符串名字并不会自动创造功能。**
- 验证规则可能跨材料、跨阶段触发，结果需要关联原件版本与每条被比对的字段。
- 未获得原始 PDF/DOCX 时，验证器不能根据假想内容给出「通过」。
- 对专业真伪/合规性的结论，要明确区分可自动验证的格式与一致性、实际需要执业人员判断的事项。

## 4. 信息提取应以“结构化事实”而不是一大段文本作为目标

建议提取结果遵循：

```json
{
  "schema": "hh.extracted-facts/1",
  "sourceArtifactId": "original-report-01",
  "sourceRevision": 2,
  "extractor": {
    "capability": "document.read",
    "version": "actual-version-on-run"
  },
  "status": "partial",
  "facts": [
    {
      "field": "sample_id",
      "value": "S-01",
      "type": "string",
      "source": {
        "page": 9,
        "table": "T2",
        "row": 3,
        "column": "Sample ID"
      }
    }
  ],
  "issues": ["页面 10 的表格边界无法可靠恢复"]
}
```

该 JSON 同样是**未来内部数据格式示例**，不是当前可运行协议。对于 DOCX，若未进行排版渲染，应使用段落或表格结构位置，不得编造固定页码。

原始文件、提取结果、规则检查结果、最终被接受的事实应分别留存。下游报告应按字段引用事实来源，而不是只引用一份模糊的文件名。

## 5. 示例：土地污染调查中的三种材料

| 材料类型 | 首要提取项 | 首要验证方法 | 用户介入点 |
| --- | --- | --- | --- |
| **地块红线 CAD/KML** | 边界几何、坐标系、面积、版本 | 几何闭合、坐标有效性、与地块身份对应 | 缺坐标参考、范围冲突时请用户确认 |
| **历史企业或影像资料** | 时间、位置、企业名称、活动线索、来源 | 日期来源可追溯、红线空间关系、不同年份信息一致性 | 线索不能确认时创建调取资料任务 |
| **检测和质控报告** | 样品 ID、点位、指标、数值、单位、质控信息 | 结构完整性、单位/编号一致性、与采样及质控材料交叉核查 | 编号冲突、关键缺项、专业结论需要核实时 |

同一模板可以定义多个处理策略：
- 优先自动化；
- 指定用户手动提取的格式和说明；
- 必须委托外部机构完成；
- 某项检查的依赖尚不存在，延迟运行。

不要让每一种复杂材料都由一个通用 LLM Prompt“随便读一下”。

## 6. 与 Codex 的分工

**Codex Harness（执行工具）**
- 读取任务包指定的已有素材；调用获授权的 PDF/DOCX、GIS 或专业脚本；
- 按所选 Skill 提取信息、执行验证方法；
- 返回结构化候选事实、来源和问题清单；
- 不替 Human Harness 作出材料接受、项目状态推进、专业决策的权威变更。

**Human Harness（项目方法和状态）**
- 从模板中选择正确的识别、提取和验证策略；
- 在满足前置条件时触发相应处理任务；
- 根据检查结果更新待验证事项；
- 仅在需要人类参与时，生成具体、可审阅、可完成的 Human Todo；
- 保留原始素材、提取结果、检查结果的版本关系及最终事实来源。

Codex app-server 的底层命令权限与沙盒仍按其安全要求运行；它们**不需要被包装成一个独立的项目「审批子系统」**。是否允许敏感工具执行属于执行层安全策略。

## 7. 如何最小化地验证这个设计（暂不开发）

**第一阶段：模板定义是否足够明确。**
选三份不同的资料（原生 PDF、扫描 PDF、带表格 DOCX），手写并审阅其 MaterialRecognition / ExtractionPlan / ValidationPlan；检查每个待提取字段是否有明确输入来源和期望结构。

**第二阶段：只读提取方法比较。**
使用成熟解析器/Skill 运行同一份文件，比较字段完整率、表格位置、来源可追溯性、失败说明。不要只比较 Markdown 的可读性。

**第三阶段：异常驱动用户 Todo。**
故意制造缺失样品编号、文件版本冲突或不可识别表格；验证系统是否能输出一条**具体的**用户任务，而不是泛泛要求「请检查文件」。

**第四阶段：跨 Agent 宿主测试。**
核心提取/验证契约稳定后，再把同一能力通过 MCP + Skills 接入 Codex、其他平台。**测试通过的宿主**才能列为支持，不得仅凭协议名称宣布全平台兼容。

## 8. 验收目标

1. 模板可以清楚表达一类素材的**提取字段 + 验证方法 + 方法依赖 + 异常处置**。
2. 素材原件可定位，提取事实可追溯，验证结论带具体依据与检查级别。
3. 文件接收成功不会自动假定提取成功或业务核验通过。
4. 无法自动解决时，Human Todo 精确指出材料、问题、所需动作和完成依据。
5. 缺失的未来材料不会让尚未到期的验证流程错误失败。
6. 选择不同解析器或 Codex 执行后端，不应改变模板定义的业务字段与验收规则。

**暂定边界：** 先修正模板方法论，再决定是否修改 Protocol 1.0 的正式 schema。不要为尚未验证过的字段规范先开发一套插件兼容层。
