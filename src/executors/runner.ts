import { freshId } from '../core/runtime';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getProject, getTaskPacket, markAgentFailed, recordExecutorEvent, startAgent, succeedAgent } from '../core/store';
import { taskResultSchema } from '../protocol/v1';
import { executorOutputSchema, type ExecutorTask, type TaskExecutor } from './contracts';
import { demoExecutor } from './demo';
import { codexExecutor } from './codex';
import { mastraExecutor } from './mastra';

/** Fail closed: HH_EXECUTOR=codex must not quietly run a fake demo task. */
export function configuredExecutorMode(mode = process.env.HH_EXECUTOR): 'demo' | 'mastra' | 'codex' {
  if (!mode || mode === 'demo') return 'demo';
  if (mode === 'mastra' || mode === 'codex') return mode;
  throw new Error('Unsupported HH_EXECUTOR=' + mode);
}

function selectedExecutor(): TaskExecutor {
  const mode = configuredExecutorMode();
  return mode === 'codex' ? codexExecutor : mode === 'mastra' ? mastraExecutor : demoExecutor;
}

/** Only authorized artifact revisions and review feedback are visible to the executor. */
function prepareTask(projectId: string, stepId: string, runId: string): ExecutorTask {
  const project = getProject(projectId);
  const packet = getTaskPacket(projectId, stepId, runId);
  const step = project.package.steps.find(item => item.id === stepId);
  if (!step) throw new Error('Agent step disappeared from its pinned project package');

  let totalOriginalBytes = 0;
  const evidence = packet.readableInputs.map(ref => {
    const artifact = project.artifacts.find(a => a.id === ref.artifactId && a.revision === ref.revision);
    if (!artifact) throw new Error('Authorized artifact was not found at expected revision');
    // Only the exact accepted revision in the scoped packet can be exposed.
    // Do not pass private paths to any executor or stage a rejected revision.
    const bytes = artifact.filePath ? readFileSync(artifact.filePath) : undefined;
    if (bytes) {
      totalOriginalBytes += bytes.byteLength;
      if (bytes.byteLength > 12 * 1024 * 1024 || totalOriginalBytes > 32 * 1024 * 1024) {
        throw new Error('Authorized original files exceed the per-task 32 MB limit');
      }
    }
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      role: ref.role,
      name: artifact.name,
      content: artifact.content,
      ...(bytes ? { originalFile: {
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex')
      } } : {})
    };
  });
  const reviewFeedback = project.events
    .filter(event => event.type === 'work.rejected' && event.subject === stepId)
    .slice(-3)
    .map(event => event.detail);
  const humanHandoffs = step.dependsOn.flatMap(id => {
    const upstream = project.package.steps.find(s => s.id === id);
    if (!upstream || !['human_action', 'human_decision', 'external_milestone'].includes(upstream.kind) ||
        project.steps[id]?.state !== 'done') return [];
    const recent = project.events.filter(event =>
      event.subject === id &&
      ['human.completed', 'decision.approved', 'external.confirmed'].includes(event.type)
    ).at(-1);
    return recent ? [{ stepId: id, kind: upstream.kind, value: recent.detail }] : [];
  });
  return { packet, stepTitle: step.title, evidence, reviewFeedback, humanHandoffs };
}

/** Shared authoritative run lifecycle. Backends return proposals and cannot commit state. */
export async function executeOneAgentTask(projectId: string, requestedStepId?: string,
  override?: TaskExecutor, signal?: AbortSignal) {
  // Select before reserving: an unsupported or missing adapter must not strand a running task.
  const executor = override ?? selectedExecutor();
  const started = startAgent(projectId, requestedStepId);
  let abortHandler: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new Error('Agent run cancelled by human operator');
    const task = prepareTask(projectId, started.stepId, started.runId);
    const completion = executor.execute(task, event => {
      recordExecutorEvent(projectId, started.stepId, started.runId, event);
    }, signal);
    // Some providers do not implement transport cancellation. Even then, no
    // late response may be accepted after the human cancels this WorkItem.
    const responsePromise = signal ? Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(new Error('Agent run cancelled by human operator'));
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      })
    ]) : completion;
    const response = executorOutputSchema.parse(await responsePromise);
    const project = getProject(projectId);
    const knownMaterials = new Set(project.package.materials.map(m => m.id));
    const evidenceRefs = task.packet.readableInputs.map(a => a.artifactId);
    const proposedActions = response.materialRequests
      .filter(request => knownMaterials.has(request.materialId) && evidenceRefs.length > 0)
      .map(request => ({
        type: 'request_material' as const,
        requirementKind: request.materialId,
        reason: request.reason,
        evidenceRefs: evidenceRefs.slice(0, 30)
      }));

    const artifactId = freshId();
    const result = taskResultSchema.parse({
      protocol: 'hh.result/1',
      runId: started.runId,
      workItemId: started.stepId,
      outcome: 'submitted_for_review',
      producedArtifacts: [{
        artifactRef: artifactId,
        ...(task.packet.outputContractId ? { contractId: task.packet.outputContractId } : {})
      }],
      proposedActions,
      limitations: response.limitations
    });
    const projectAfter = succeedAgent(projectId, started.stepId, started.runId, result, response.body);
    return { project: projectAfter, executedStepId: started.stepId, runId: started.runId };
  } catch (error) {
    markAgentFailed(
      projectId, started.stepId, started.runId,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}
