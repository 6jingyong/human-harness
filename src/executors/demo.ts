import type { TaskExecutor } from './contracts';

/** No-key demo: tests workflow transitions only, never claims a real Agent/tool call. */
export const demoExecutor: TaskExecutor = {
  id: 'demo',
  async execute(task) {
    if (task.packet.toolsAllowed.length) {
      throw new Error('Demo executor cannot claim a run requiring external tools');
    }
    const body = [
      '# ' + task.stepTitle,
      '',
      '【演示结果：没有调用真实大模型或专业调查工具】',
      '',
      '当前任务：' + task.packet.objective,
      '',
      '输入证据数：' + task.packet.readableInputs.length,
      '没有进行现场、GIS、采样、检测或任何原始 PDF/CAD 解析。',
      '',
      '下一步：人工审核；本输出仅用于检验任务流程。'
    ].join('\n');
    return {
      body: task.outputFormat === 'json'
        ? JSON.stringify({
          demo: true, verified: false, workItemId: task.packet.workItemId,
          warning: '演示数据，不含真实提取结果；未调用模型或专业 Skill。',
          inputArtifactCount: task.evidence.length, results: []
        }, null, 2)
        : body,
      limitations: ['Demo mode: no real Agent or professional investigation tools were called.'],
      materialRequests: [],
      ...(task.workMethod ? { methodChecks: task.workMethod.checks.map(check => ({
        checkId: check.id, status: 'unverified' as const,
        explanation: 'Demo 未运行模型、专业 Skill 或实际验证方法，因此不能证明此项通过。',
        evidenceRefs: []
      })) } : {})
    };
  }
};
