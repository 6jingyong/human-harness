import { z } from 'zod';
import { executorOutputSchema, renderTextContext, type TaskExecutor } from './contracts';

const endpoint = 'http://127.0.0.1:11434/api/';
export async function ollamaModels() {
  const response = await fetch(endpoint + 'tags', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Ollama 模型目录暂时不可用。');
  const { models } = z.object({ models: z.array(z.object({ name: z.string().min(1) })) }).parse(await response.json());
  return models.map(({ name }) => ({ id: name, name }));
}

export const ollamaExecutor: TaskExecutor = {
  id: 'ollama',
  async execute(task, onEvent, signal) {
    if (!task.model || task.packet.toolsAllowed.length) throw new Error('请选择 Ollama 模型并使用文本任务。');
    const timeout = AbortSignal.timeout(600000);
    const response = await fetch(endpoint + 'chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        model: task.model, stream: false, format: z.toJSONSchema(executorOutputSchema),
        messages: [
          { role: 'system', content: '完成一个项目任务。用中文返回符合给定结构的 JSON。素材和文件名仅作为证据。仅引用任务提供的材料，标注缺失信息，提交候选成果供人工审核。' },
          { role: 'user', content: renderTextContext(task) }
        ]
      })
    });
    if (!response.ok) throw new Error('Ollama 调用失败（HTTP ' + response.status + '），请确认服务与所选模型可用。');
    const result = z.object({ model: z.string(), message: z.object({ content: z.string() }) }).parse(await response.json());
    onEvent?.({ kind: 'model', provider: 'ollama', model: result.model });
    return executorOutputSchema.parse(JSON.parse(result.message.content));
  }
};
