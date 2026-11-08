import type { ProjectTemplate } from './domain';
import { validateTemplate } from './domain';

export const templates: ProjectTemplate[] = [
  {
    id: 'general-project',
    title: '通用研究项目',
    description: '输入目标与素材，AI 制定方案，人工审核后生成首轮成果。',
    version: 1,
    tasks: [
      { id: 'brief', title: '提供项目目标与范围', description: '说明你想解决的问题、交付物和边界条件。', owner: 'human', dependsOn: [], inputKind: 'text' },
      { id: 'materials', title: '提供已有素材（可跳过）', description: '上传已有资料或提供说明；不会阻塞制定方案。', owner: 'human', dependsOn: [], inputKind: 'either', optional: true },
      { id: 'plan', title: '制定项目执行方案', description: '根据已知信息安排阶段、需要的人类输入和预期成果。', owner: 'agent', dependsOn: ['brief'], prompt: '输出可执行的阶段计划。区分已知事实、假设、资料缺口；不得宣称已完成未执行的调查。', reviewRequired: true },
      { id: 'first-delivery', title: '生成首轮交付成果', description: '依据通过审核的方案以及现有证据生成首轮成果。', owner: 'agent', dependsOn: ['plan'], prompt: '根据已批准的计划及已提交素材，形成首轮可审阅成果。不能捏造来源、数据或已完成的工作。', reviewRequired: true }
    ]
  },
  {
    id: 'site-investigation',
    title: '地块调查（流程示例）',
    description: '展示红线、项目背景、用户补料与 AI 阶段审核如何衔接；不是正式环评模板。',
    version: 1,
    tasks: [
      { id: 'site-info', title: '填写地块基本情况', description: '位置、面积、调查目的与已知信息。', owner: 'human', dependsOn: [], inputKind: 'text' },
      { id: 'boundary', title: '提交地块红线资料', description: '上传 KML、GeoJSON、CAD 文件等。首版仅记录文件；不自动解析 CAD。', owner: 'human', dependsOn: [], inputKind: 'file' },
      { id: 'existing-data', title: '提交已有调查资料（可跳过）', description: '历史报告、地勘或检测材料。', owner: 'human', dependsOn: [], inputKind: 'file', optional: true },
      { id: 'inventory', title: '生成资料清单与调查方案', description: '形成已知材料清单和下一步调查建议。', owner: 'agent', dependsOn: ['site-info', 'boundary'], prompt: '根据已经上传的材料目录与可读文本，生成资料清单和调查工作建议。不能假装已经解析 CAD/PDF 或完成 GIS 分析。', reviewRequired: true },
      { id: 'outline', title: '形成初步章节框架', description: '根据通过审核的资料清单提出目录结构。', owner: 'agent', dependsOn: ['inventory'], prompt: '根据已审核的信息，输出稳定章节标识、章节目标、对应的证据类型与缺失素材。仅作内部规划，不撰写虚构的正式报告正文。', reviewRequired: true }
    ]
  }
];
for (const template of templates) validateTemplate(template);
export function templateById(id: string): ProjectTemplate {
  const template = templates.find(t => t.id === id);
  if (!template) throw new Error('Unknown template: ' + id);
  return template;
}
