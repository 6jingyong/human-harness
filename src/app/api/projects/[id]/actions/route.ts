import { NextResponse } from 'next/server';
import { DomainError, reviewAgent, skipHuman, submitHuman } from '@/lib/store';
import { runNextAgentTask } from '@/lib/executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await context.params;
  try {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    const taskId = String(form.get('taskId') ?? '');
    let project;
    let executedTaskId: string | null = null;
    if (action === 'submit') {
      const text = String(form.get('text') ?? '');
      const candidate = form.get('file');
      const file = candidate instanceof File && candidate.size > 0 ? candidate : null;
      if (file && file.size > 12 * 1024 * 1024) throw new DomainError('File exceeds 12 MB');
      project = submitHuman(projectId, taskId, text, file ? {
        name: file.name,
        bytes: Buffer.from(await file.arrayBuffer())
      } : undefined);
    } else if (action === 'skip') {
      project = skipHuman(projectId, taskId);
    } else if (action === 'approve') {
      project = reviewAgent(projectId, taskId, true, String(form.get('feedback') ?? ''));
    } else if (action === 'reject') {
      project = reviewAgent(projectId, taskId, false, String(form.get('feedback') ?? ''));
    } else if (action === 'run') {
      const result = await runNextAgentTask(projectId);
      project = result.project;
      executedTaskId = result.executedTaskId;
    } else {
      throw new DomainError('Unknown action');
    }
    return NextResponse.json({ project, executedTaskId });
  } catch (error) {
    if (!(error instanceof DomainError)) console.error('Project action error:', error);
    return NextResponse.json({ error: error instanceof DomainError ? error.message : 'Agent execution failed; see server logs and task event history' },
      { status: error instanceof DomainError ? 400 : 500 });
  }
}
