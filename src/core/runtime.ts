import { randomUUID } from 'node:crypto';
import type { HumanHarnessPackage, Condition, HumanHarnessTaskPacket, HumanHarnessTaskResult } from '../protocol/v1';
import type { SemanticNote } from '../protocol/semantics';

export type WorkState = 'dormant' | 'blocked' | 'ready' | 'running' | 'waiting_input' | 'review' | 'done' | 'not_applicable' | 'failed';
export type RequirementState = 'dormant' | 'expected' | 'requested' | 'received' | 'accepted' | 'rejected' | 'not_applicable';
export type RuntimeStep = { state: WorkState; runId?: string; startedAt?: string };
export type RuntimeMaterial = { state: RequirementState; artifactIds: string[] };
export type RuntimeArtifact = {
  id: string; kind: 'material' | 'agent_output'; name: string; content: string | null;
  ownerId: string; revision: number; filePath?: string; createdAt: string;
  semanticNotes?: SemanticNote[];
};
export type RuntimeRun = { id: string; stepId: string; status: 'running' | 'needs_input' | 'review' | 'failed'; startedAt: string; endedAt?: string; result?: HumanHarnessTaskResult; error?: string; codexThreadId?: string; codexTurnId?: string; lastExecutorEvent?: string };
/** Runtime-only Human Todo spawned by a material question against a template-declared input.
 * The model may request clarification, but cannot add arbitrary requirements to the template.
 */
export type HumanInputRequest = {
  id: string; stepId: string; runId: string; materialId: string;
  reason: string; status: 'pending' | 'answered';
  createdAt: string; answer?: string; answeredAt?: string;
};
export type ProjectEvent = { id: string; type: string; subject: string; detail: string; createdAt: string };
export type ExecutionPolicy = { autoDispatch: boolean; maxParallel: number };
/** Older projects have no policy: keep them paused until the user explicitly enables automation. */
export const executionPolicy = (project: ProjectState): ExecutionPolicy =>
  project.execution ?? { autoDispatch: false, maxParallel: 2 };

export type ProjectState = {
  execution?: ExecutionPolicy;
  id: string; title: string; templateId: string; templateVersion: string;
  packageDigest: string; createdAt: string;
  package: HumanHarnessPackage;
  steps: Record<string, RuntimeStep>;
  materials: Record<string, RuntimeMaterial>;
  decisions: Record<string, string>;
  artifacts: RuntimeArtifact[];
  runs: RuntimeRun[];
  humanRequests?: HumanInputRequest[];
  events: ProjectEvent[];
};

export const now = () => new Date().toISOString();
export const freshId = () => randomUUID();
export const recordEvent = (p: ProjectState, type: string, subject: string, detail = '') => {
  p.events.push({ id: freshId(), type, subject, detail, createdAt: now() });
};
export const isAgentStep = (kind: string) => kind === 'agent' || kind === 'script';
export type Truth = true | false | 'unknown';

export function evaluateCondition(condition: Condition | undefined, project: ProjectState): Truth {
  if (!condition) return true;
  if (condition.type === 'decision') {
    const choice = project.decisions[condition.stepId];
    return choice === undefined ? 'unknown' : choice === condition.option;
  }
  if (condition.type === 'work_done') {
    const step = project.steps[condition.stepId];
    return step?.state === 'done' ? true : step?.state === 'not_applicable' ? false : 'unknown';
  }
  const entries = condition.clauses.map(c => evaluateCondition(c, project));
  if (condition.type === 'all') {
    return entries.includes(false) ? false : entries.every(x => x === true) ? true : 'unknown';
  }
  return entries.includes(true) ? true : entries.every(x => x === false) ? false : 'unknown';
}

/** Pure deterministic projection. Never ask an LLM whether a task can run. */
export function reconcile(project: ProjectState): ProjectState {
  const steps = new Map(project.package.steps.map(step => [step.id, step]));
  for (let attempt = 0; attempt < project.package.steps.length + project.package.materials.length + 5; attempt++) {
    let changed = false;
    for (const def of project.package.materials) {
      const state = project.materials[def.id];
      if (!state || ['received', 'accepted', 'rejected'].includes(state.state)) continue;
      const required = evaluateCondition(def.requiredWhen, project);
      const requested = evaluateCondition(def.requestWhen, project);
      const next: RequirementState = required === false ? 'not_applicable'
        : required === 'unknown' ? 'dormant'
        : requested === true ? 'requested' : requested === 'unknown' ? 'expected' : 'expected';
      if (state.state !== next) {
        state.state = next;
        recordEvent(project, 'material.state', def.id, next);
        changed = true;
      }
    }
    for (const def of project.package.steps) {
      const step = project.steps[def.id];
      if (!step || ['running', 'waiting_input', 'review', 'done', 'failed'].includes(step.state)) continue;
      const branch = evaluateCondition(def.when, project);
      const upstream = def.dependsOn.map(id => project.steps[id]?.state);
      const materials = def.needsMaterials.map(id => project.materials[id]?.state);
      const next: WorkState = branch === false || upstream.includes('not_applicable') || materials.includes('not_applicable')
        ? 'not_applicable'
        : branch === 'unknown' ? 'dormant'
        : upstream.every(x => x === 'done') && materials.every(x => x === 'accepted') ? 'ready'
        : 'blocked';
      if (step.state !== next) {
        step.state = next;
        recordEvent(project, 'work.state', def.id, next);
        changed = true;
      }
    }
    if (!changed) return project;
  }
  throw new Error('Project activation failed to converge');
}

export function newProject(pkg: HumanHarnessPackage, id: string, title: string, packageDigest: string): ProjectState {
  const project: ProjectState = {
    id, title, templateId: pkg.id, templateVersion: pkg.version, packageDigest,
    execution: { autoDispatch: true, maxParallel: 2 },
    createdAt: now(), package: pkg,
    steps: Object.fromEntries(pkg.steps.map(s => [s.id, { state: 'dormant' as const }])),
    materials: Object.fromEntries(pkg.materials.map(m => [m.id, { state: 'dormant' as const, artifactIds: [] }])),
    decisions: {}, artifacts: [], runs: [], humanRequests: [], events: []
  };
  recordEvent(project, 'project.created', pkg.id, pkg.version);
  return reconcile(project);
}

export function applyHumanStep(project: ProjectState, stepId: string, value: string): void {
  const def = project.package.steps.find(s => s.id === stepId);
  const item = project.steps[stepId];
  if (!def || !item || item.state !== 'ready' || !['human_action', 'human_decision', 'external_milestone'].includes(def.kind)) {
    throw new Error('Human work item is not actionable');
  }
  const note = value.trim();
  if (!note) throw new Error('Human input or selection is required');
  if (def.kind === 'human_decision') {
    if (!def.options?.some(o => o.id === note)) throw new Error('Decision is not a declared option');
    project.decisions[stepId] = note;
    recordEvent(project, 'decision.approved', stepId, note);
  } else {
    recordEvent(project, def.kind === 'external_milestone' ? 'external.confirmed' : 'human.completed', stepId, note.slice(0, 8000));
  }
  item.state = 'done';
  reconcile(project);
}

export function receiveMaterial(project: ProjectState, materialId: string, artifact: RuntimeArtifact): void {
  const material = project.materials[materialId];
  if (!material || !['requested', 'rejected'].includes(material.state)) throw new Error('Material is not currently requested');
  if (artifact.kind !== 'material' || artifact.ownerId !== materialId || !artifact.content && !artifact.filePath) {
    throw new Error('Invalid material artifact');
  }
  project.artifacts.push(artifact);
  material.artifactIds.push(artifact.id);
  material.state = 'received';
  recordEvent(project, 'material.received', materialId, artifact.id);
  reconcile(project);
}

export function reviewMaterial(project: ProjectState, materialId: string, accepted: boolean, feedback: string): void {
  const material = project.materials[materialId];
  if (material?.state !== 'received') throw new Error('Only received material can be reviewed');
  if (!accepted && !feedback.trim()) throw new Error('A rejection must include an explanation');
  material.state = accepted ? 'accepted' : 'rejected';
  recordEvent(project, accepted ? 'material.accepted' : 'material.rejected', materialId, feedback.slice(0, 500));
  reconcile(project);
}

export function reserveAgent(project: ProjectState, stepId: string): string {
  const def = project.package.steps.find(s => s.id === stepId);
  const state = project.steps[stepId];
  if (!def || !state || state.state !== 'ready' || !isAgentStep(def.kind)) throw new Error('Agent work item is not ready');
  const runId = freshId();
  state.state = 'running'; state.runId = runId; state.startedAt = now();
  project.runs.push({ id: runId, stepId, status: 'running', startedAt: now() });
  recordEvent(project, 'run.started', stepId, runId);
  return runId;
}

export function finishAgent(project: ProjectState, stepId: string, runId: string, result: HumanHarnessTaskResult, artifact: RuntimeArtifact): void {
  const state = project.steps[stepId];
  const run = project.runs.find(r => r.id === runId && r.stepId === stepId);
  if (!state || state.state !== 'running' || state.runId !== runId || !run || result.runId !== runId || result.workItemId !== stepId) {
    throw new Error('Run identity or state mismatch');
  }
  if (artifact.kind !== 'agent_output' || artifact.ownerId !== stepId) throw new Error('Output does not belong to this Agent step');
  if (result.outcome !== 'submitted_for_review' || !result.producedArtifacts.some(a => a.artifactRef === artifact.id)) {
    throw new Error('The current adapter must submit a verifiable candidate artifact');
  }
  project.artifacts.push(artifact);
  run.status = 'review'; run.endedAt = now(); run.result = result;
  state.state = 'review';
  recordEvent(project, 'run.review_requested', stepId, runId);
}

/**
 * A needs-input response is not a completed candidate. It creates Human Todo
 * questions and suspends only this Agent WorkItem. No automatic approval.
 */
export function holdAgentForHuman(project: ProjectState, stepId: string, runId: string,
  result: HumanHarnessTaskResult, requests: readonly { materialId: string; reason: string }[]): void {
  const step = project.steps[stepId];
  const run = project.runs.find(item => item.id === runId && item.stepId === stepId);
  if (step?.state !== 'running' || step.runId !== runId || run?.status !== 'running' ||
      result.runId !== runId || result.workItemId !== stepId || result.outcome !== 'needs_input') {
    throw new Error('Run identity or needs-input result mismatch');
  }
  if (!requests.length || requests.length > 5 || result.producedArtifacts.length) {
    throw new Error('Human input request must have 1–5 questions and no completed artifact');
  }
  const declared = new Set(project.package.materials.map(m => m.id));
  const outstanding = project.humanRequests ?? [];
  const unique = new Set<string>();
  for (const request of requests) {
    if (!declared.has(request.materialId) || !request.reason.trim() ||
        unique.has(request.materialId)) {
      throw new Error('Human input request must cite a distinct template-declared material');
    }
    unique.add(request.materialId);
    // A second identical request after an answer is a loop, not new evidence.
    if (outstanding.some(item => item.stepId === stepId && item.materialId === request.materialId)) {
      throw new Error('Repeated human request for the same material; retry needs human review');
    }
  }
  if (outstanding.filter(item => item.stepId === stepId).length + requests.length > 5) {
    throw new Error('Agent exceeded the per-step human request limit');
  }
  project.humanRequests ??= [];
  for (const request of requests) {
    const id = freshId();
    project.humanRequests.push({
      id, stepId, runId, materialId: request.materialId,
      reason: request.reason.trim(), status: 'pending', createdAt: now()
    });
    recordEvent(project, 'human.requested', id, stepId + '/' + request.materialId);
  }
  run.status = 'needs_input'; run.result = result; run.endedAt = now();
  step.state = 'waiting_input';
  recordEvent(project, 'run.needs_input', stepId, runId);
}

/** Human answer is the only authorization needed to resume this Agent task.
 * Human wording remains explicitly declared information, not validated evidence.
 */
export function answerHumanRequest(project: ProjectState, requestId: string, rawValue: string): void {
  const value = rawValue.trim();
  if (!value || value.length > 8000) throw new Error('Human answer must contain 1–8000 characters');
  const item = project.humanRequests?.find(request => request.id === requestId);
  if (!item || item.status !== 'pending' ||
      project.steps[item.stepId]?.state !== 'waiting_input') {
    throw new Error('Human request is not pending');
  }
  item.status = 'answered'; item.answer = value; item.answeredAt = now();
  recordEvent(project, 'human.request_answered', requestId, item.stepId);
  if (!project.humanRequests?.some(request =>
    request.stepId === item.stepId && request.status === 'pending')) {
    const step = project.steps[item.stepId];
    step.state = 'ready';
    delete step.runId; delete step.startedAt;
    recordEvent(project, 'run.resumed_from_human', item.stepId);
    reconcile(project);
  }
}

export function reviewAgent(project: ProjectState, stepId: string, approved: boolean, feedback: string): void {
  const state = project.steps[stepId];
  if (!state || state.state !== 'review') throw new Error('Task is not pending review');
  if (!approved && !feedback.trim()) throw new Error('Rejection requires feedback');
  state.state = approved ? 'done' : 'ready';
  recordEvent(project, approved ? 'work.approved' : 'work.rejected', stepId, feedback.slice(0, 1000));
  reconcile(project);
}

export function failAgent(project: ProjectState, stepId: string, runId: string, error: string): void {
  const state = project.steps[stepId]; const run = project.runs.find(r => r.id === runId);
  if (state?.state !== 'running' || state.runId !== runId || !run) return;
  state.state = 'failed'; run.status = 'failed'; run.endedAt = now(); run.error = error.slice(0, 1000);
  recordEvent(project, 'run.failed', stepId, run.error);
}

/** Explicit crash recovery. Never silently duplicate a still-running model call. */
export function expireAbandonedRun(project: ProjectState, stepId: string, currentTime = Date.now()): void {
  const state = project.steps[stepId];
  if (state?.state !== 'running' || !state.runId || !state.startedAt) {
    throw new Error('No active run to recover');
  }
  const elapsed = currentTime - Date.parse(state.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 15 * 60 * 1000) {
    throw new Error('Running task has not exceeded the 15-minute recovery threshold');
  }
  const runId = state.runId;
  failAgent(project, stepId, runId, 'Run exceeded the 15-minute lease; human-authorized recovery required');
  recordEvent(project, 'run.timeout_recovered', stepId, runId);
}

export function retryAgent(project: ProjectState, stepId: string): void {
  const state = project.steps[stepId];
  const def = project.package.steps.find(s => s.id === stepId);
  if (state?.state !== 'failed' || !def || !isAgentStep(def.kind)) throw new Error('Agent step is not failed');
  state.state = 'ready'; delete state.runId; delete state.startedAt;
  recordEvent(project, 'run.retry_authorized', stepId);
}

export function createTaskPacket(project: ProjectState, stepId: string, runId: string): HumanHarnessTaskPacket {
  const def = project.package.steps.find(s => s.id === stepId);
  const item = project.steps[stepId];
  if (!def || !item || item.runId !== runId || item.state !== 'running') throw new Error('Task packet is not authorized');
  const materials = def.needsMaterials.flatMap(id =>
    project.materials[id]?.state === 'accepted'
      ? project.materials[id].artifactIds.slice(-1).map(ref => project.artifacts.find(a => a.id === ref)).filter((a): a is RuntimeArtifact => Boolean(a))
      : []);
  const upstreamOutputs = def.dependsOn.flatMap(id => project.steps[id]?.state === 'done'
    ? project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === id).slice(-1) : []);
  const inputs = [...materials, ...upstreamOutputs];
  return {
    protocol: 'hh.task/1', runId, projectId: project.id, workItemId: stepId,
    objective: def.instructions,
    readableInputs: inputs.map(a => ({
      artifactId: a.id, revision: a.revision,
      role: a.kind === 'material' ? 'case_evidence' : 'approved_derived', viewId: a.id
    })),
    templateResources: [], toolsAllowed: [],
    ...(def.outputContractId ? { outputContractId: def.outputContractId } : {}),
    reviewPolicy: 'human_required'
  };
}
