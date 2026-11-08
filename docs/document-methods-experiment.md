# 实测：用模板方法处理 PDF/DOCX，再生成精确的用户 Todo

> **结果范围**：2026-11-08 在本地运行的可复现合成资料实验。文件是实际 PDF/DOCX 格式，但内容是人为编造的测试数据，**不是来自检测机构的真实报告**。未调用大模型、Codex 或 Human Harness 项目 API，也没有更改 Protocol 1.0。复现代码见 [experiments/document-methods](../experiments/document-methods/README.md)。

## 1. 本轮要验证什么

此前模板已能描述某材料**何时需要**，但用户提出更关键的问题：模板也应当定义**收到后怎么识别、怎么提取、怎样验证，以及什么问题需交给用户**。

因此这次先验证一个不依赖 Agent 的方法合同：

```text
methods.json（声明文档类型、字段和跨文件规则）
    ├── PDF 提取器（pdfplumber）
    ├── DOCX 提取器（python-docx）
    └── 通用规则执行器
           ├── 每行必填字段是否存在
           ├── 跨文件 sample_id → point_id 是否一致
           └── 异常 → 带来源的 Human Todo 建议
```

### 合成测试数据

| 来源文件 | 输入表格 | 预期已知问题 |
| --- | --- | --- |
| `lab-report.pdf` | S-001/P-01/As/8.2/mg/kg；S-002/P-09/As/12.5/mg/kg；S-003/P-03/As/4.1/**空单位** | 单位缺失、S-002 点位故意冲突 |
| `field-log.docx` | S-001/P-01；S-002/**P-02**；S-003/P-03 | 与报告的 S-002 点位不一致 |

PDF 使用真正的文本层和带网格的结果表；DOCX 使用原生 Word 表格。生成的两个文件均有显眼的 **SYNTHETIC / 合成测试** 声明。页面已分别渲染检查，未观察到明显缺字、表格裁切或乱码。

## 2. 实际运行结果

本地命令：

```bash
cd experiments/document-methods
python -m pip install -r requirements.txt
python generate_fixtures.py
python probe.py --method methods.json --out result.json --verify
```

**观测输出：**

```text
PASS: two original-format files parsed; two precise Human Todo proposals
```

- PDF：成功匹配目标表头并抽取 **3 行**；识别中文标题，输出原始文件哈希、实际页码与表格单元格 `bbox`。
- DOCX：成功匹配目标表头并抽取 **3 行**；输出原始文件哈希、表格序号、行列结构定位。**未凭空附加页码**。
- 规则：字段完整性发现 **1 条**，跨文件比对发现 **1 条**；总计 **2 条用户 Todo 建议**，状态为 `proposed`，尚未写入真实 Human Harness Todo。

具体问题：

1. `required_field_missing`：样品 **S-003** 的 `unit` 缺失；PDF 第 1 页、第 1 张表、**第 4 行的 unit 列**，本次生成文件的坐标约为 `[395, 292, 485, 320]`。
2. `cross_material_mismatch`：样品 **S-002** 在报告中为 **P-09**、现场记录中为 **P-02**。PDF 第 1 页/第 1 表/第 3 行 `point_id`，DOCX 第 1 表/第 3 行 `point_id`。系统没有自行认定哪一个正确。

最终用户 Todo 的正文可以直接告诉用户“哪两份原件出现冲突、冲突值分别是什么、下一步要做什么”，不必附加一句空泛的“请审核报告”。

## 3. 方法定义和解析器可以分开

`methods.json` 中的业务部分：

```json
{
  "materials": [
    {
      "id": "lab-report",
      "format": "pdf",
      "recognizeText": "检测报告",
      "tableHeaders": ["sample_id", "point_id", "analyte", "result", "unit"],
      "requiredFields": ["sample_id", "point_id", "analyte", "result", "unit"]
    }
  ],
  "checks": [
    {
      "type": "cross_material_equal",
      "leftMaterial": "lab-report",
      "rightMaterial": "field-log",
      "joinKey": "sample_id",
      "compareKey": "point_id",
      "onMismatch": "create_human_todo"
    }
  ]
}
```

这是**独立实验协议 `hh.method-experiment/0`**，不是当前能导入的 `hh.package/1`。`probe.py` 只是在这份受控实验中用既有 Python 解析库执行方法。以后可以换 Docling、其他 PDF/DOCX 工具乃至 Codex Skill，但不能因此变更业务验收条件。

实验还添加了一个 **[Codex 可发现的演示 Skill](../.agents/skills/document-evidence-demo/SKILL.md)**。它说明具体何时运行、必须报告哪些来源、失败如何处理，以及禁止把合成资料当成专业证据。该 Skill **未在 Codex 中实际启动或验收**；本轮仅验证了其仓库结构和说明内容。

## 4. 设计得到的四点结论

- **素材定义必须包含处理方法。** 至少要能表达文档类型、预期字段、结构位置、验证规则及出现异常后的任务说明。
- **解析结果和业务事实必须分层。** 提取出一个数字并不意味着它正确、真实或合规。原件、抽取记录、验证记录、人工处理记录应可追溯。
- **异常才是 Human Todo 的主要来源之一。** 能由程序明确解决的事不必机械审批；涉及冲突与专业判断时，Todo 需要包含具体上下文。
- **Docx 与 PDF 的定位机制不同。** PDF 可给出实际页面坐标，未渲染的 DOCX 应给出结构路径，跨平台时应统一为带类型的 source locator。

## 5. 此次尚未证明的内容

这次受控测试只覆盖**两份单页/单表、表头固定的合成文件**，不应推广到真实检测报告：

- **扫描件/图片式 PDF**：没有运行 OCR；仅靠文字层提取必然不足。
- **复杂表格**：合并单元格、跨页表头、双栏、页眉脚注、多个指标及单位换算未测试。
- **真实验证**：检测机构真伪、采样链条、检测方法适用性、数值合规性均未验证。
- **全面通用**：不同格式、不同机构实际出具的报告，还需要数据集与覆盖率指标；没有测试 Docling 的真实表现。
- **Codex/MCP/插件兼容**：本轮没有启动 Codex、暴露 MCP 服务或测试其他平台；当前的实验方法不能当成已安装插件。
- **持久化**：本轮仅输出 `proposed` 的 Todo，不更改 Human Harness 项目账本。任务去重、源文件修订后重新校验等问题需要下一轮设计。

## 6. 后续应该先补什么

先收集或制作具有明确再分发许可的**不同布局和异常类型**的样例，尤其是扫描件、合并单元格、多页表格与中文文本。给这些素材建立**人工确认的预期结果和来源锚点**。在此之前，不应直接修改正式模板 Schema，也不应声称“PDF/DOCX 已支持”。

第二步才比较 Docling 与现有轻量解析路径能否生成相同的业务事实结构；第三步再通过 Codex Skill/MCP 接口封装，而不是先开发专属插件壳再补解析质量。
