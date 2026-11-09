import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  approveHumanCorrectedOutput, answerRequestedInput, getProject, completeHuman, recoverAbandonedAgent, retryFailedAgent, reviewAgentOutput, reviewReceivedMaterial,
  RuntimeError, submitMaterial, setExecutionPolicy
} from '@/core/store';
import { ensureLocalScheduler } from '@/executors/scheduler';

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
    if (action === 'answer_human_request') {
      const requestId = String(form.get('requestId') ?? '');
      const candidate = form.get('file');
      const file = candidate instanceof File && candidate.size ? candidate : undefined;
      if (file && file.size > 12 * 1024 * 1024) throw new RuntimeError('File exceeds 12 MB');
      if (file) {
        const pending = getProject(id).humanRequests?.find(request => request.id === requestId);
        if (!pending || pending.status !== 'pending' || pending.invalidatedAt) {
          throw new RuntimeError('Human request is not pending');
        }
        project = submitMaterial(id, pending.materialId, value,
          { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) }, { requestId });
      } else {
        project = answerRequestedInput(id, requestId, value);
      }
    } else if (action === 'complete_human') {
      project = completeHuman(id, stepId, value);
    } else if (action === 'submit_material') {
      const candidate = form.get('file');
      const file = candidate instanceof File && candidate.size ? candidate : undefined;
      if (file && file.size > 12 * 1024 * 1024) throw new RuntimeError('File exceeds 12 MB');
      project = submitMaterial(id, materialId, value, file ? { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) } : undefined);
    } else if (action === 'replace_material') {
      const candidate = form.get('file');
      const file = candidate instanceof File && candidate.size ? candidate : undefined;
      if (file && file.size > 12 * 1024 * 1024) throw new RuntimeError('File exceeds 12 MB');
      project = submitMaterial(id, materialId, value,
        file ? { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) } : undefined,
        { replaceAccepted: true });
    } else if (action === 'accept_material' || action === 'reject_material') {
      project = reviewReceivedMaterial(id, materialId, action === 'accept_material', feedback);
    } else if (action === 'amend_agent') {
      project = approveHumanCorrectedOutput(id, stepId, value, feedback);
    } else if (action === 'approve_agent' || action === 'reject_agent') {
      project = reviewAgentOutput(id, stepId, action === 'approve_agent', feedback);
    } else if (action === 'retry_agent') {
      project = retryFailedAgent(id, stepId);
    } else if (action === 'recover_agent') {
      project = recoverAbandonedAgent(id, stepId);
    } else if (action === 'set_execution_policy') {
      const enabled = form.get('autoDispatch');
      const maxParallel = Number(form.get('maxParallel'));
      if (enabled !== 'true' && enabled !== 'false') throw new RuntimeError('Invalid autoDispatch');
      project = setExecutionPolicy(id, enabled === 'true', maxParallel);
    } else if (action === 'run_agent') {
      project = ensureLocalScheduler().runOnce(id, stepId);
    } else if (action === 'cancel_agent') {
      project = ensureLocalScheduler().cancel(id, stepId);
    } else {
      throw new RuntimeError('Unknown action');
    }
    ensureLocalScheduler();
    const safe = { ...project, artifacts: project.artifacts.map(({ filePath: _hidden, ...artifact }) => artifact) };
    return NextResponse.json({ project: safe });
  } catch (error) {
    const text = error instanceof ZodError ? error.issues.slice(0, 5).map(e => e.message).join('; ')
      : error instanceof Error ? error.message : 'Unknown runtime error';
    const conflict = /Dependent Agent work is active/.test(text);
    const known = conflict || error instanceof RuntimeError || error instanceof ZodError ||
      /not (ready|actionable|requested|pending)|Only |required|mismatch|cannot|invalid|does not|Decision|rejection/i.test(text);
    if (!known) console.error('Action error', error);
    return NextResponse.json({ error: known ? text : 'Project action failed; see server logs' },
      { status: conflict ? 409 : known ? 400 : 500 });
  }
}
