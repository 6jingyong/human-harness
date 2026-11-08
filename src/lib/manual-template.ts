import type { ProjectTemplate, TaskDefinition } from './domain';
import { validateTemplate } from './domain';

export type ManualTemplateDraft = {
  id: string;
  title: string;
  description: string;
  initialInputs: string;
  agentGoal: string;
};

/** Manual authoring scaffold only. Users may then edit the full JSON manifest. */
export function buildManualTemplateDraft(input: ManualTemplateDraft): ProjectTemplate {
  const id = input.id.trim();
  const title = input.title.trim();
  const description = input.description.trim() || '手动创建的可复用项目流程';
  const goals = input.agentGoal.trim();
  const lines = input.initialInputs.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('模板 ID 需使用英文字母开头，可含数字、横线或下划线');
  if (!title || title.length > 150) throw new Error('请填写不超过150字的模板名称');
  if (description.length > 1500) throw new Error('模板描述过长');
  if (!goals || goals.length > 1000) throw new Error('请填写本项目 Agent 需要完成的工作');
  if (!lines.length || lines.length > 20) throw new Error('请填写1–20条初始用户资料');
  const tasks: TaskDefinition[] = lines.map((line, index) => {
    const file = /^\[文件\]|^文件[:：]/.test(line);
    const taskTitle = line.replace(/^\[文件\]\s*|^文件[:：]\s*/, '').trim();
    if (!taskTitle || taskTitle.length > 150) throw new Error('初始资料名称无效或过长');
    return {
      id: 'input-' + String(index + 1).padStart(2, '0'),
      title: taskTitle,
      description: file ? '上传该项资料的原始文件' : '填写该项项目资料或说明',
      owner: 'human', dependsOn: [], inputKind: file ? 'file' : 'text', stageId: 'intake'
    };
  });
  const materialDefs = tasks.map(t => ({
    id: 'material-' + t.id, title: t.title, taskId: t.id,
    producer: 'human' as const, required: true
  }));
  const template: ProjectTemplate = {
    id, title, description, version: 1, schemaVersion: 3,
    workflow: { stages: [
      { id: 'intake', title: '初始资料', description: '用户提交可获得的项目资料' },
      { id: 'work', title: 'Agent 执行与审核', description: 'Agent 整理和生成待审成果' }
    ] },
    materials: materialDefs,
    resources: [],
    tasks: [
      ...tasks,
      { id: 'draft-output', title: '生成待审成果', description: goals,
        owner: 'agent', dependsOn: tasks.map(t => t.id), stageId: 'work',
        prompt: goals + '。必须区分确认事实与缺失证据，不能假称已运行未安装的技能。',
        reviewRequired: true }
    ],
    deliverables: [{ id: 'review-draft', taskId: 'draft-output', fileName: 'project-draft.md', format: 'markdown', minChars: 20 }]
  };
  validateTemplate(template);
  return template;
}
