import { packageSchema, type HumanHarnessPackage } from './v1';

export type ManualProjectSpec = {
  id: string;
  title: string;
  description: string;
  inputs: string;
  objective: string;
};

/**
 * Generates a *canonical* package from simple manual authoring inputs.
 * Users can extend the generated protocol JSON with decisions, rules and tool references.
 */
export function manualProjectPackage(spec: ManualProjectSpec): HumanHarnessPackage {
  const id = spec.id.trim();
  const title = spec.title.trim();
  const description = spec.description.trim();
  const objective = spec.objective.trim();
  const lines = spec.inputs.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('模板 ID 必须以英文字母开头');
  if (!title || !description || !objective) throw new Error('请填写名称、描述和 Agent 工作目标');
  if (lines.length < 1 || lines.length > 30) throw new Error('需定义 1–30 项初始资料');
  const materials = lines.map((line, index) => ({
    id: 'input-' + String(index + 1).padStart(2, '0'),
    title: line.replace(/^文件[:：]/, '').trim(),
    description: '由项目用户提供并人工核验原始来源',
    producer: 'human' as const,
    formats: /^文件[:：]/.test(line) ? ['application/octet-stream'] : ['text/plain'],
    acceptance: ['有来源说明且与本次项目相关']
  }));
  if (materials.some(m => !m.title)) throw new Error('资料名称不能为空');
  return packageSchema.parse({
    protocol: 'hh.package/1', id, version: '1.0.0', title, description,
    stages: [
      { id: 'intake', title: '资料收集', description: '用户提供并人工审阅项目资料' },
      { id: 'work', title: 'Agent 执行', description: 'Agent 根据已核验素材形成可审核成果' }
    ],
    capabilities: [{ id: 'mastra.agent', kind: 'agent', description: '受控 Mastra 单项执行器' }],
    assets: [], materials,
    steps: [
      {
        id: 'draft', stageId: 'work', kind: 'agent', title: '生成待审成果',
        instructions: objective, dependsOn: [], needsMaterials: materials.map(m => m.id),
        capabilityId: 'mastra.agent', outputContractId: 'internal-draft', requiresReview: true
      }
    ],
    outputs: [
      {
        id: 'internal-draft', title: '待审项目草稿', audience: 'internal',
        fileName: 'draft.md', format: 'markdown', producingStepId: 'draft',
        acceptance: ['不得编造没有证据的事实'], humanSignoff: true
      }
    ]
  });
}
