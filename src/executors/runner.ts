import { freshId } from '../core/runtime';
import { approvedSemanticNotes } from '../core/semantics';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { awaitHumanInput, getProject, getTaskPacket, markAgentFailed, recordExecutorEvent, startAgent, succeedAgent } from '../core/store';
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
  const requestedAnswers = (project.humanRequests ?? [])
    .filter(request => request.stepId === stepId && !request.invalidatedAt && request.status === 'answered' && request.answer)
    .map(request => ({
      stepId,
      kind: 'agent_requested_input',
      value: 'Question about template material ' + request.materialId + ': ' +
        request.reason + '\nHuman response (not independently verified): ' + request.answer
    }));
  const allowedMaterialIds = new Set([...step.needsMaterials, ...(step.requestableMaterialIds ?? [])]);
  const requestableMaterials = project.package.materials
    .filter(m => allowedMaterialIds.has(m.id))
    .map(m => ({ id: m.id, title: m.title, description: m.description }));
  const materialMethods = project.package.materials.filter(m =>
    allowedMaterialIds.has(m.id) && m.method).map(m => ({
      materialId: m.id, title: m.title, method: m.method!
    }));
  const outputAcceptance = project.package.outputs.find(o =>
    o.id === step.outputContractId)?.acceptance;
  return { packet, stepTitle: step.title, evidence, reviewFeedback,
    workMethod: step.method, materialMethods, outputAcceptance,
    requestableMaterials,
    humanHandoffs: [...humanHandoffs, ...requestedAnswers],
    approvedSemanticNotes: approvedSemanticNotes(project, step.needsMaterials) };
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
    // AI notes are candidates. An invented or cross-scope citation rejects the
    // entire run; only a human-reviewed output can become reusable knowledge.
    const scopedEvidence = new Map(task.evidence
      .filter(e => e.role === 'case_evidence').map(e => [e.artifactId, e]));
    const stepDef = project.package.steps.find(step => step.id === started.stepId);
    for (const note of response.semanticNotes ?? []) {
      const source = scopedEvidence.get(note.sourceArtifactId);
      const artifact = project.artifacts.find(a => a.id === note.sourceArtifactId &&
        a.kind === 'material' && a.ownerId === note.materialId);
      if (!source || !artifact || source.revision !== note.sourceRevision ||
          artifact.revision !== note.sourceRevision ||
          !stepDef?.needsMaterials.includes(note.materialId)) {
        throw new Error('Agent semantic note cites material outside this run\'s accepted evidence scope');
      }
    }
    const evidenceRefs = task.packet.readableInputs.map(a => a.artifactId);
    // A needs-input response pauses the WorkItem. It is not a completed candidate,
    // so the model need not manufacture completed check results.
    if (!response.materialRequests.length) {
      const expected = task.workMethod?.checks.map(check => check.id) ?? [];
      const checks = response.methodChecks ?? [];
      if (checks.length !== expected.length ||
          new Set(checks.map(check => check.checkId)).size !== checks.length ||
          checks.some(check => !expected.includes(check.checkId))) {
        throw new Error('Agent method checks must match the pinned template criteria exactly');
      }
      for (const check of checks) {
        if (check.evidenceRefs.some(ref => !evidenceRefs.includes(ref))) {
          throw new Error('Agent method check cites an unauthorized source');
        }
        if (check.status === 'passed' && evidenceRefs.length && !check.evidenceRefs.length) {
          throw new Error('A passed method check requires an authorized evidence reference');
        }
      }
    }
    if (response.materialRequests.length) {
      if (task.workMethod?.onMissing === 'record_limitation') {
        throw new Error('Pinned template method requires recording limitations instead of asking Human');
      }
      const distinct = new Set<string>();
      for (const request of response.materialRequests) {
        if (!task.requestableMaterials?.some(m => m.id === request.materialId) ||
            distinct.has(request.materialId)) {
          throw new Error('Agent requested an unauthorized or duplicate template material');
        }
        distinct.add(request.materialId);
      }
      const result = taskResultSchema.parse({
        protocol: 'hh.result/1',
        runId: started.runId,
        workItemId: started.stepId,
        outcome: 'needs_input',
        producedArtifacts: [],
        proposedActions: response.materialRequests
          .filter(() => evidenceRefs.length > 0)
          .map(request => ({
            type: 'request_material' as const,
            requirementKind: request.materialId,
            reason: request.reason,
            evidenceRefs: evidenceRefs.slice(0, 30)
          })),
        limitations: response.limitations
      });
      const heldProject = awaitHumanInput(projectId, started.stepId, started.runId,
        result, response.materialRequests);
      return { project: heldProject, executedStepId: started.stepId, runId: started.runId };
    }
    const proposedActions: typeof taskResultSchema._output.proposedActions = [];
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
    const projectAfter = succeedAgent(projectId, started.stepId, started.runId, result, response.body,
      response.semanticNotes ?? [], response.methodChecks ?? []);
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
