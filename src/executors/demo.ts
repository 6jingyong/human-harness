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
      body,
      limitations: ['Demo mode: no real Agent or professional investigation tools were called.'],
      materialRequests: []
    };
  }
};
