import test from 'node:test';
import assert from 'node:assert/strict';
import { packageSchema, taskPacketSchema, taskResultSchema } from '../src/protocol/v1';

const base = {
  protocol: 'hh.package/1',
  id: 'land-investigation',
  version: '1.0.0',
  title: '土地污染调查',
  description: '人类与Agent执行的项目模板',
  stages: [
    { id: 'intake', title: '初始资料', description: '收集红线等基础材料' },
    { id: 'investigate', title: '第一阶段', description: '风险识别和专业审核' },
    { id: 'sampling', title: '采样调查', description: '在批准后才触发的工作' }
  ],
  capabilities: [
    { id: 'mastra.agent', kind: 'agent', description: '执行受约束的单项研究任务' }
  ],
  assets: [],
  materials: [
    { id: 'boundary', title: '地块红线', producer: 'human', description: '地块边界资料', formats: ['application/xml'], acceptance: ['原始来源和坐标基准必须明确'] },
    { id: 'qc-evidence', title: '质控记录', producer: 'external_institution', description: '对应实际采样和实验室工作', formats: ['application/pdf'],
      requiredWhen: { type: 'decision', stepId: 'stage1-decision', option: 'sampling' },
      requestWhen: { type: 'work_done', stepId: 'lab-complete' }, acceptance: ['必须有可追溯的样品和点位ID'] }
  ],
  steps: [
    { id: 'inventory', stageId: 'investigate', kind: 'agent', title: '清点资料', instructions: '仅凭可读资料列出问题',
      dependsOn: [], needsMaterials: ['boundary'], capabilityId: 'mastra.agent', requiresReview: true },
    { id: 'stage1-decision', stageId: 'investigate', kind: 'human_decision', title: '采样判断', instructions: '由专业人员选择后续路径',
      dependsOn: ['inventory'], needsMaterials: [], options: [{ id: 'finish', label: '第一阶段结束' }, { id: 'sampling', label: '进入采样' }] },
    { id: 'commission', stageId: 'sampling', kind: 'human_action', title: '委托专业机构', instructions: '先批准采样方案再委托',
      dependsOn: ['stage1-decision'], needsMaterials: [], when: { type: 'decision', stepId: 'stage1-decision', option: 'sampling' } },
    { id: 'lab-complete', stageId: 'sampling', kind: 'external_milestone', title: '机构工作完成', instructions: '人工确认外部机构真实完成',
      dependsOn: ['commission'], needsMaterials: [] },
    { id: 'qc-review', stageId: 'sampling', kind: 'agent', title: '资料审核草稿', instructions: '仅在收到质控证据后核查',
      dependsOn: ['lab-complete'], needsMaterials: ['qc-evidence'], capabilityId: 'mastra.agent',
      requiresReview: true, outputContractId: 'qc-review-draft' }
  ],
  outputs: [
    { id: 'qc-review-draft', title: '内部审核稿', audience: 'internal', fileName: 'qc-review.md',
      format: 'markdown', producingStepId: 'qc-review', acceptance: ['需要列出对应证据'], humanSignoff: true }
  ]
};

test('canonical package accepts a land investigation conditional material lifecycle', () => {
  const parsed = packageSchema.parse(base);
  assert.equal(parsed.protocol, 'hh.package/1');
  assert.equal(parsed.materials.find(m => m.id === 'qc-evidence')?.requestWhen?.type, 'work_done');
});

test('canonical package rejects legacy version formats and unknown fields', () => {
  assert.equal(packageSchema.safeParse({ ...base, schemaVersion: 3 }).success, false);
  assert.equal(packageSchema.safeParse({ ...base, protocol: 'hh.package/0' }).success, false);
});

test('canonical package rejects invalid professional decision refs and cycles', () => {
  const invalid = structuredClone(base);
  invalid.materials[1].requiredWhen = { type: 'decision', stepId: 'stage1-decision', option: 'unapproved' };
  assert.equal(packageSchema.safeParse(invalid).success, false);
  const cycle = structuredClone(base);
  cycle.steps[0].dependsOn = ['qc-review'];
  assert.equal(packageSchema.safeParse(cycle).success, false);
});

test('task packet only contains scoped references and declared tools', () => {
  const valid = {
    protocol: 'hh.task/1', runId: 'run-123', projectId: 'd0ce-4444', workItemId: 'inventory',
    objective: '仅整理可读取资料',
    readableInputs: [{ artifactId: 'artifact-1', revision: 1, role: 'case_evidence', viewId: 'view-1' }],
    templateResources: [], toolsAllowed: ['file.read'], reviewPolicy: 'human_required'
  };
  assert.equal(taskPacketSchema.safeParse(valid).success, true);
  assert.equal(taskPacketSchema.safeParse({ ...valid, readAllUserFiles: true }).success, false);
});

test('task results carry proposals but cannot mutate authoritative state', () => {
  const result = {
    protocol: 'hh.result/1', runId: 'run-123', workItemId: 'inventory',
    outcome: 'needs_input', producedArtifacts: [],
    proposedActions: [{ type: 'request_material', requirementKind: 'risk-enterprise-records',
      reason: '历史企业证据不足', evidenceRefs: ['artifact-1'] }],
    limitations: ['没有获取到真实的历史影像']
  };
  assert.equal(taskResultSchema.safeParse(result).success, true);
  assert.equal(taskResultSchema.safeParse({ ...result, setTaskState: 'done' }).success, false);
});


test('rejects material activation deadlocks across future work and evidence', () => {
  const broken = structuredClone(base);
  broken.materials[1].requestWhen = { type: 'work_done', stepId: 'qc-review' };
  // qc-review requires qc-evidence, which cannot be requested until qc-review finishes.
  assert.equal(packageSchema.safeParse(broken).success, false);
});


test('template-defined Agent lanes validate unique owners and cannot assign human steps', () => {
  const valid = {
    ...base,
    agents: [
      { id: 'agent-a', title: '资料提取 Agent', description: '来源判读与证据提取' },
      { id: 'agent-b', title: '成果整合 Agent', description: '根据审核结果生成草稿' }
    ],
    steps: base.steps.map(s => s.id === 'inventory'
      ? { ...s, agentId: 'agent-a' } : s.id === 'qc-review'
        ? { ...s, agentId: 'agent-b' } : s)
  };
  assert.equal(packageSchema.safeParse(valid).success, true);
  assert.equal(packageSchema.safeParse({
    ...valid, agents: [...valid.agents, valid.agents[0]]
  }).success, false);
  assert.equal(packageSchema.safeParse({
    ...valid, steps: valid.steps.map(s => s.id === 'inventory'
      ? { ...s, agentId: 'agent-x' } : s)
  }).success, false);
  assert.equal(packageSchema.safeParse({
    ...valid, steps: valid.steps.map(s => s.id === 'commission'
      ? { ...s, agentId: 'agent-a' } : s)
  }).success, false);
  // Backwards-compatible packages without named Agent lanes keep a default owner.
  assert.equal(packageSchema.safeParse(base).success, true);
});
