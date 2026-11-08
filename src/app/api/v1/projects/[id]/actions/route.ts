import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  completeHuman, getProject, retryFailedAgent, reviewAgentOutput, reviewReceivedMaterial,
  RuntimeError, submitMaterial
} from '@/core/store';
import { executeOneAgentTask } from '@/executors/mastra';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    const stepId = String(form.get('stepId') ?? '');
    const materialId = String(form.get('materialId') ?? '');
    const value = String(form.get('value') ?? '');
    const feedback = String(form.get('feedback') ?? '');
    let project;
    if (action === 'complete_human') {
      project = completeHuman(id, stepId, value);
    } else if (action === 'submit_material') {
      const candidate = form.get('file');
      const file = candidate instanceof File && candidate.size ? candidate : undefined;
      if (file && file.size > 12 * 1024 * 1024) throw new RuntimeError('File exceeds 12 MB');
      project = submitMaterial(id, materialId, value, file ? { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) } : undefined);
    } else if (action === 'accept_material' || action === 'reject_material') {
      project = reviewReceivedMaterial(id, materialId, action === 'accept_material', feedback);
    } else if (action === 'approve_agent' || action === 'reject_agent') {
      project = reviewAgentOutput(id, stepId, action === 'approve_agent', feedback);
    } else if (action === 'retry_agent') {
      project = retryFailedAgent(id, stepId);
    } else if (action === 'run_agent') {
      const result = await executeOneAgentTask(id, stepId || undefined);
      project = result.project;
    } else {
      throw new RuntimeError('Unknown action');
    }
    const safe = { ...project, artifacts: project.artifacts.map(({ filePath: _hidden, ...artifact }) => artifact) };
    return NextResponse.json({ project: safe });
  } catch (error) {
    const text = error instanceof ZodError ? error.issues.slice(0, 5).map(e => e.message).join('; ')
      : error instanceof Error ? error.message : 'Unknown runtime error';
    const known = error instanceof RuntimeError || error instanceof ZodError || /not (ready|actionable|requested|pending)|Only |required|mismatch|cannot|invalid|does not|Decision|rejection/i.test(text);
    if (!known) console.error('Action error', error);
    return NextResponse.json({ error: known ? text : 'Project action failed; see server logs' }, { status: known ? 400 : 500 });
  }
}
