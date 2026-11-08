import { freshId } from '../core/runtime';
import { getProject, getTaskPacket, markAgentFailed, startAgent, succeedAgent } from '../core/store';
import { taskResultSchema } from '../protocol/v1';
import { executorOutputSchema, type ExecutorTask, type TaskExecutor } from './contracts';
import { demoExecutor } from './demo';
import { mastraExecutor } from './mastra';

/** Fail closed: HH_EXECUTOR=codex must not quietly run a fake demo task. */
export function configuredExecutorMode(mode = process.env.HH_EXECUTOR): 'demo' | 'mastra' {
  if (!mode || mode === 'demo') return 'demo';
  if (mode === 'mastra') return 'mastra';
  throw new Error('Unsupported HH_EXECUTOR=' + mode + '; Codex is not integrated yet');
}

function selectedExecutor(): TaskExecutor {
  return configuredExecutorMode() === 'mastra' ? mastraExecutor : demoExecutor;
}

/** Only authorized artifact revisions and review feedback are visible to the executor. */
function prepareTask(projectId: string, stepId: string, runId: string): ExecutorTask {
  const project = getProject(projectId);
  const packet = getTaskPacket(projectId, stepId, runId);
  const step = project.package.steps.find(item => item.id === stepId);
  if (!step) throw new Error('Agent step disappeared from its pinned project package');

  const evidence = packet.readableInputs.map(ref => {
    const artifact = project.artifacts.find(a => a.id === ref.artifactId && a.revision === ref.revision);
    if (!artifact) throw new Error('Authorized artifact was not found at expected revision');
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      role: ref.role,
      name: artifact.name,
      content: artifact.content
    };
  });
  const reviewFeedback = project.events
    .filter(event => event.type === 'work.rejected' && event.subject === stepId)
    .slice(-3)
    .map(event => event.detail);
  return { packet, stepTitle: step.title, evidence, reviewFeedback };
}

/** Shared authoritative run lifecycle. Backends return proposals and cannot commit state. */
export async function executeOneAgentTask(projectId: string, requestedStepId?: string, override?: TaskExecutor) {
  // Select before reserving: an unsupported or missing adapter must not strand a running task.
  const executor = override ?? selectedExecutor();
  const started = startAgent(projectId, requestedStepId);
  try {
    const task = prepareTask(projectId, started.stepId, started.runId);
    const response = executorOutputSchema.parse(await executor.execute(task));
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
  }
}
