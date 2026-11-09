import { randomUUID } from 'node:crypto';
import type { HumanHarnessPackage, Condition, HumanHarnessTaskPacket, HumanHarnessTaskResult } from '../protocol/v1';
import type { SemanticNote } from '../protocol/semantics';
import type { MethodCheckResult } from '../executors/contracts';

export type WorkState = 'dormant' | 'blocked' | 'ready' | 'running' | 'waiting_input' | 'review' | 'done' | 'not_applicable' | 'failed';
export type RequirementState = 'dormant' | 'expected' | 'requested' | 'received' | 'accepted' | 'rejected' | 'not_applicable';
export type RuntimeStep = { state: WorkState; runId?: string; startedAt?: string;
  /** HEAD: explicitly adopted revision, null when upstream invalidation clears adoption. */
  approvedArtifactId?: string;
};
export type RuntimeMaterial = { state: RequirementState; artifactIds: string[]; acceptedArtifactId?: string };
export type RuntimeArtifact = {
  id: string; kind: 'material' | 'agent_output'; name: string; content: string | null;
  ownerId: string; revision: number; filePath?: string; createdAt: string;
  submissionNote?: string;
  semanticNotes?: SemanticNote[];
  methodChecks?: MethodCheckResult[];
  invalidatedAt?: string;
  /** Approved Human replacement of an Agent candidate; its predecessor is retained. */
  humanCorrection?: { basedOnArtifactId: string; rationale: string; correctedAt: string };
  /** Concrete artifacts consumed by this result's run, not merely template graph inputs. */
  inputArtifactIds?: string[];
};
export type RuntimeRun = { id: string; stepId: string; status: 'running' | 'needs_input' | 'review' | 'failed'; startedAt: string; endedAt?: string; result?: HumanHarnessTaskResult; error?: string; codexThreadId?: string; codexTurnId?: string; lastExecutorEvent?: string; inputArtifactIds?: string[] };
/** Runtime-only Human Todo spawned by a material question against a template-declared input.
 * The model may request clarification, but cannot add arbitrary requirements to the template.
 */
export type HumanInputRequest = {
  id: string; stepId: string; runId: string; materialId: string;
  reason: string; status: 'pending' | 'awaiting_review' | 'answered';
  createdAt: string; answer?: string; answeredAt?: string; attachmentArtifactId?: string;
  invalidatedAt?: string;
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
      // An on-demand material does not burden Human Todo before an Agent asks.
      // Once every clarification has been answered without an uploaded source,
      // the optional requirement falls back to "expected" (not actionable).
      const activeQuestion = def.onDemand && (project.humanRequests ?? []).some(question =>
        question.materialId === def.id && !question.invalidatedAt &&
        question.status !== 'answered');
      const required = evaluateCondition(def.requiredWhen, project);
      const requested = evaluateCondition(def.requestWhen, project);
      const next: RequirementState = def.onDemand
        ? (activeQuestion ? 'requested' : 'expected')
        : required === false ? 'not_applicable'
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

/** Select the last *accepted* artifact; a pending upload does not replace it. */
export function acceptedMaterialArtifact(p: ProjectState, materialId: string): RuntimeArtifact | undefined {
  const material = p.materials[materialId];
  if (!material || (material.state !== 'accepted' && !material.acceptedArtifactId)) return;
  const artifactId = material.acceptedArtifactId ??
    (material.state === 'accepted' ? material.artifactIds.at(-1) : undefined);
  return p.artifacts.find(a => a.id === artifactId && a.kind === 'material' && a.ownerId === materialId);
}

/** Resolve the adopted HEAD, never the most recently generated rejected/review candidate.
 * Older stored projects can still resolve their last valid approved artifact.
 */
export function currentApprovedOutput(project: ProjectState, stepId: string): RuntimeArtifact | undefined {
  const state = project.steps[stepId];
  if (state?.state !== 'done') return undefined;
  const revisions = project.artifacts.filter(a =>
    a.kind === 'agent_output' && a.ownerId === stepId && !a.invalidatedAt);
  if (state.approvedArtifactId) return revisions.find(a => a.id === state.approvedArtifactId);
  return revisions.at(-1);
}

/** Scope effect propagation to actual descendants and work activated by their conditions. */
export function affectedStepsForOutput(project: ProjectState, sourceStepId: string): Set<string> {
  const affected = new Set<string>();
  const upstream = new Set([sourceStepId]);
  for (let pass = 0; pass < project.package.steps.length; pass++) {
    let changed = false;
    for (const step of project.package.steps) {
      if (upstream.has(step.id)) continue;
      const viaStep = step.dependsOn.some(id => upstream.has(id)) ||
        conditionMentionsStep(step.when, upstream);
      const viaMaterialCondition = step.needsMaterials.some(id => {
        const material = project.package.materials.find(m => m.id === id);
        return Boolean(material && (conditionMentionsStep(material.requiredWhen, upstream) ||
          conditionMentionsStep(material.requestWhen, upstream)));
      });
      if (viaStep || viaMaterialCondition) {
        affected.add(step.id);
        upstream.add(step.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return affected;
}

export function invalidateOutputDependents(project: ProjectState, sourceStepId: string): string[] {
  const affected = affectedStepsForOutput(project, sourceStepId);
  for (const id of affected) {
    if (['running', 'waiting_input'].includes(project.steps[id]?.state)) {
      throw new Error('Dependent Agent work is active; finish or cancel it before accepting a revision');
    }
  }
  const invalidated: string[] = [];
  for (const id of affected) {
    const state = project.steps[id];
    if (!state) continue;
    if (['done', 'review', 'failed'].includes(state.state)) {
      state.state = 'blocked';
      delete state.runId; delete state.startedAt;
      delete state.approvedArtifactId;
      delete project.decisions[id];
      for (const req of project.humanRequests ?? []) {
        if (req.stepId === id) req.invalidatedAt ??= now();
      }
      for (const artifact of project.artifacts) {
        if (artifact.kind === 'agent_output' && artifact.ownerId === id) {
          artifact.invalidatedAt ??= now();
        }
      }
      recordEvent(project, 'work.invalidated', id, 'Adopted upstream output revised: ' + sourceStepId);
      invalidated.push(id);
    }
  }
  reconcile(project);
  return invalidated;
}

const conditionMentionsStep = (condition: Condition | undefined, stepIds: Set<string>): boolean => {
  if (!condition) return false;
  if (condition.type === 'decision' || condition.type === 'work_done') return stepIds.has(condition.stepId);
  return condition.clauses.some(clause => conditionMentionsStep(clause, stepIds));
};

/** Conservative template graph reachability: direct evidence users plus descendants.
 * Includes condition references so an old human decision cannot silently select a stale branch.
 */
export function affectedStepsForMaterial(p: ProjectState, materialId: string): Set<string> {
  const affected = new Set(p.package.steps.filter(step =>
    step.needsMaterials.includes(materialId) ||
    (step.requestableMaterialIds ?? []).includes(materialId)
  ).map(step => step.id));
  for (let i = 0; i < p.package.steps.length; i++) {
    let changed = false;
    for (const step of p.package.steps) {
      if (affected.has(step.id)) continue;
      if (step.dependsOn.some(id => affected.has(id)) ||
          conditionMentionsStep(step.when, affected)) {
        affected.add(step.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return affected;
}

/** Source replacement impacts only tasks that could have used this material.
 * Never race an active run: the operator must finish/cancel it first.
 * Historical outputs remain available as history, but no longer count as approved.
 */
export function invalidateMaterialDependents(p: ProjectState, materialId: string, exemptStepId?: string) {
  const affected = affectedStepsForMaterial(p, materialId);
  for (const stepId of affected) {
    if (stepId === exemptStepId) continue;
    if (['running', 'waiting_input'].includes(p.steps[stepId]?.state)) {
      throw new Error('Dependent Agent work is active; finish or cancel it before accepting a replacement');
    }
  }
  let invalidated = 0;
  for (const stepId of affected) {
    if (stepId === exemptStepId) continue;
    const state = p.steps[stepId];
    if (!state) continue;
    if (state.state === 'done' || state.state === 'review' || state.state === 'failed') {
      state.state = 'blocked';
      delete state.runId; delete state.startedAt;
      delete state.approvedArtifactId;
      delete p.decisions[stepId];
      for (const request of p.humanRequests ?? []) {
        if (request.stepId === stepId) request.invalidatedAt ??= now();
      }
      for (const artifact of p.artifacts) {
        if (artifact.kind === 'agent_output' && artifact.ownerId === stepId) {
          artifact.invalidatedAt ??= now();
        }
      }
      recordEvent(p, 'work.invalidated', stepId, 'Source material replaced: ' + materialId);
      invalidated++;
    }
  }
  if (invalidated) recordEvent(p, 'material.dependents_invalidated', materialId, String(invalidated));
  reconcile(p);
}

export function receiveMaterial(project: ProjectState, materialId: string,
  artifact: RuntimeArtifact, replaceAccepted = false): void {
  const material = project.materials[materialId];
  if (!material || !(['requested', 'rejected'].includes(material.state) ||
        (replaceAccepted && material.state === 'accepted'))) {
    throw new Error('Material is not currently requested or eligible for replacement');
  }
  if (artifact.kind !== 'material' || artifact.ownerId !== materialId || !artifact.content && !artifact.filePath) {
    throw new Error('Invalid material artifact');
  }
  if (material.state === 'accepted' && replaceAccepted && !material.acceptedArtifactId) {
    material.acceptedArtifactId = material.artifactIds.at(-1);
  }
  project.artifacts.push(artifact);
  material.artifactIds.push(artifact.id);
  material.state = 'received';
  recordEvent(project, replaceAccepted ? 'material.replacement_received' : 'material.received', materialId, artifact.id);
  reconcile(project);
}

export function reviewMaterial(project: ProjectState, materialId: string, accepted: boolean, feedback: string): void {
  const material = project.materials[materialId];
  if (material?.state !== 'received') throw new Error('Only received material can be reviewed');
  if (!accepted && !feedback.trim()) throw new Error('A rejection must include an explanation');
  const candidateId = material.artifactIds.at(-1);
  const oldAccepted = material.acceptedArtifactId;
  const attachedRequest = project.humanRequests?.find(request =>
    request.attachmentArtifactId === candidateId && request.status === 'awaiting_review');
  if (accepted && oldAccepted && oldAccepted !== candidateId) {
    invalidateMaterialDependents(project, materialId, attachedRequest?.stepId);
  }
  material.state = accepted ? 'accepted' : 'rejected';
  if (accepted) {
    material.acceptedArtifactId = candidateId;
  }
  if (attachedRequest) {
    if (accepted) {
      attachedRequest.status = 'answered';
      attachedRequest.answer = attachedRequest.answer?.trim() ||
        '已提供新原件，经过人工核验，文件标识 ' + candidateId;
      attachedRequest.answeredAt = now();
      recordEvent(project, 'human.attachment_accepted', attachedRequest.id, candidateId ?? '');
      resumeAfterHumanAnswers(project, attachedRequest.stepId);
    } else {
      attachedRequest.status = 'pending';
      delete attachedRequest.attachmentArtifactId;
      recordEvent(project, 'human.attachment_rejected', attachedRequest.id, feedback.slice(0, 500));
    }
  }
  recordEvent(project, accepted ? 'material.accepted' : 'material.rejected', materialId, feedback.slice(0, 500));
  reconcile(project);
}


export function reserveAgent(project: ProjectState, stepId: string): string {
  const def = project.package.steps.find(s => s.id === stepId);
  const state = project.steps[stepId];
  if (!def || !state || state.state !== 'ready' || !isAgentStep(def.kind)) throw new Error('Agent work item is not ready');
  const runId = freshId();
  state.state = 'running'; state.runId = runId; state.startedAt = now();
  const run: RuntimeRun = { id: runId, stepId, status: 'running', startedAt: now() };
  project.runs.push(run);
  // Snapshot the exact readable input refs at reservation time.
  run.inputArtifactIds = createTaskPacket(project, stepId, runId).readableInputs.map(x => x.artifactId);
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
  const inputIds = createTaskPacket(project, stepId, runId).readableInputs.map(x => x.artifactId);
  if (run.inputArtifactIds && JSON.stringify(inputIds) !== JSON.stringify(run.inputArtifactIds)) {
    throw new Error('Run input revisions changed; stale output cannot be submitted');
  }
  artifact.inputArtifactIds = [...(run.inputArtifactIds ?? inputIds)];
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
  const stepDef = project.package.steps.find(item => item.id === stepId);
  const declared = new Set([
    ...(stepDef?.needsMaterials ?? []), ...(stepDef?.requestableMaterialIds ?? [])
  ]);
  const outstanding = project.humanRequests ?? [];
  const unique = new Set<string>();
  for (const request of requests) {
    if (!declared.has(request.materialId) || !request.reason.trim() ||
        unique.has(request.materialId)) {
      throw new Error('Human input request must cite a distinct template-declared material');
    }
    unique.add(request.materialId);
    // A second identical request after an answer is a loop, not new evidence.
    if (outstanding.some(item => !item.invalidatedAt && item.stepId === stepId && item.materialId === request.materialId)) {
      throw new Error('Repeated human request for the same material; retry needs human review');
    }
  }
  if (outstanding.filter(item => !item.invalidatedAt && item.stepId === stepId).length + requests.length > 5) {
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
  reconcile(project); // activate any on-demand source for the newly created Human Todo
}

/** Human answer is the only authorization needed to resume this Agent task.
 * Human wording remains explicitly declared information, not validated evidence.
 */
/** All questions must be settled before the single originating WorkItem can resume. */
function resumeAfterHumanAnswers(project: ProjectState, stepId: string) {
  if (!project.humanRequests?.some(request =>
    request.stepId === stepId && !request.invalidatedAt && request.status !== 'answered')) {
    const step = project.steps[stepId];
    if (step?.state !== 'waiting_input') throw new Error('Agent task is not waiting for Human input');
    step.state = 'blocked';
    delete step.runId; delete step.startedAt;
    recordEvent(project, 'run.resumed_from_human', stepId);
    reconcile(project);
  }
}

/** Bind a newly submitted candidate material version to a still-pending question.
 * Its answer is NOT accepted until the normal material review passes.
 */
export function attachHumanRequestArtifact(project: ProjectState, requestId: string, artifactId: string, note: string) {
  const request = project.humanRequests?.find(item => item.id === requestId);
  if (!request || request.invalidatedAt || request.status !== 'pending' ||
      project.steps[request.stepId]?.state !== 'waiting_input') {
    throw new Error('Human request is not pending');
  }
  if (!project.artifacts.some(a => a.id === artifactId && a.kind === 'material' &&
      a.ownerId === request.materialId)) {
    throw new Error('Attachment does not match the request material');
  }
  request.status = 'awaiting_review';
  request.attachmentArtifactId = artifactId;
  request.answer = note.trim();
  recordEvent(project, 'human.attachment_submitted', requestId, artifactId);
}

export function answerHumanRequest(project: ProjectState, requestId: string, rawValue: string): void {
  const value = rawValue.trim();
  if (!value || value.length > 8000) throw new Error('Human answer must contain 1–8000 characters');
  const item = project.humanRequests?.find(request => request.id === requestId);
  if (!item || item.invalidatedAt || item.status !== 'pending' ||
      project.steps[item.stepId]?.state !== 'waiting_input') {
    throw new Error('Human request is not pending');
  }
  item.status = 'answered'; item.answer = value; item.answeredAt = now();
  recordEvent(project, 'human.request_answered', requestId, item.stepId);
  resumeAfterHumanAnswers(project, item.stepId);
}

export function reviewAgent(project: ProjectState, stepId: string, approved: boolean, feedback: string): void {
  const state = project.steps[stepId];
  if (!state || state.state !== 'review') throw new Error('Task is not pending review');
  if (!approved && !feedback.trim()) throw new Error('Rejection requires feedback');
  const def = project.package.steps.find(step => step.id === stepId);
  const current = project.artifacts.filter(a =>
    a.kind === 'agent_output' && a.ownerId === stepId).at(-1);
  if (approved && def?.method && (!current?.methodChecks ||
      current.methodChecks.length !== def.method.checks.length)) {
    throw new Error('Template method checklist is missing; cannot approve');
  }
  if (approved && current?.methodChecks?.some(check => check.status !== 'passed') &&
      !feedback.trim()) {
    throw new Error('Unresolved method checks require explicit Human approval rationale');
  }
  state.state = approved ? 'done' : 'ready';
  if (approved) {
    if (!current || current.invalidatedAt) throw new Error('No valid candidate to adopt');
    state.approvedArtifactId = current.id;
  } else {
    delete state.approvedArtifactId;
  }
  recordEvent(project, approved ? 'work.approved' : 'work.rejected', stepId, feedback.slice(0, 1000));
  reconcile(project);
}

/** Human Todo may correct a candidate instead of spending model tokens on a redo.
 * This is a NEW attributed revision, not a rewrite of the Agent's original output.
 * Downstream tasks see only the Human-approved latest revision.
 */
export function amendAndApproveAgent(project: ProjectState, stepId: string, rawContent: string, rationale: string): void {
  const state = project.steps[stepId];
  if (state?.state !== 'review') throw new Error('Only a pending Agent candidate can be corrected');
  const note = rationale.trim();
  if (!note || note.length > 1000) throw new Error('Human correction requires a 1–1000 character rationale');
  const content = rawContent.trim();
  if (!content || content.length > 120000) throw new Error('Human correction must contain 1–120000 characters');
  const definition = project.package.steps.find(step => step.id === stepId);
  if (!definition || (definition.kind !== 'agent' && definition.kind !== 'script')) {
    throw new Error('Only Agent or script outputs can be corrected');
  }
  const contract = project.package.outputs.find(output => output.id === definition.outputContractId);
  if (!contract || !['json', 'markdown'].includes(contract.format)) {
    throw new Error('Human text correction supports only JSON or Markdown outputs');
  }
  if (contract.format === 'json') {
    try { JSON.parse(content); } catch { throw new Error('Corrected output must be valid JSON'); }
  }
  const previous = project.artifacts.filter(artifact =>
    artifact.kind === 'agent_output' && artifact.ownerId === stepId).at(-1);
  if (!previous || previous.content === null || previous.invalidatedAt) {
    throw new Error('No current Agent candidate available for correction');
  }
  if (content === previous.content.trim()) throw new Error('Correction does not change the candidate content');
  // Previous Agent semantic notes and self-check verdicts cannot certify the edited text.
  const methodChecks: MethodCheckResult[] | undefined = definition.method?.checks.map(check => ({
    checkId: check.id, status: 'unverified',
    explanation: 'Human changed the candidate; original Agent self-check does not cover this revision.',
    evidenceRefs: []
  }));
  const correctedAt = now();
  const replacement: RuntimeArtifact = {
    id: freshId(), kind: 'agent_output', name: previous.name, content,
    ownerId: stepId,
    revision: project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === stepId).length + 1,
    createdAt: correctedAt,
    humanCorrection: { basedOnArtifactId: previous.id, rationale: note, correctedAt },
    ...(methodChecks ? { methodChecks } : {})
  };
  project.artifacts.push(replacement);
  recordEvent(project, 'work.human_corrected', stepId, previous.id + ' -> ' + replacement.id);
  reviewAgent(project, stepId, true, note);
}

/** Revise an ALREADY approved result. Human authority is recorded, never silent overwrite.
 * Caller must present HEAD observed by the user (compare-and-swap).
 */
export function reviseApprovedOutput(project: ProjectState, stepId: string, expectedHead: string,
  rawContent: string, rationale: string): string[] {
  const head = currentApprovedOutput(project, stepId);
  if (!head || project.steps[stepId]?.state !== 'done') {
    throw new Error('Only an already approved result can be revised');
  }
  if (!expectedHead || head.id !== expectedHead) {
    throw new Error('Approved output HEAD changed; refresh and review the latest version');
  }
  const note = rationale.trim();
  if (!note || note.length > 1000) throw new Error('Human revision requires a 1–1000 character rationale');
  const content = rawContent.trim();
  if (!content || content.length > 120000) throw new Error('Human revision must contain 1–120000 characters');
  if (content === head.content?.trim()) throw new Error('Revision does not change the approved content');
  const definition = project.package.steps.find(step => step.id === stepId);
  const contract = project.package.outputs.find(out => out.id === definition?.outputContractId);
  if (!contract || !['markdown', 'json'].includes(contract.format)) {
    throw new Error('Human text revision supports only JSON or Markdown outputs');
  }
  if (contract.format === 'json') {
    try { JSON.parse(content); } catch { throw new Error('Revised output must be valid JSON'); }
  }
  // A running dependent cannot be silently reinterpreted against a new upstream.
  const affected = affectedStepsForOutput(project, stepId);
  for (const id of affected) {
    if (['running', 'waiting_input'].includes(project.steps[id]?.state)) {
      throw new Error('Dependent Agent work is active; finish or cancel it before accepting a revision');
    }
  }
  const revisedAt = now();
  const methodChecks: MethodCheckResult[] | undefined = definition?.method?.checks.map(check => ({
    checkId: check.id, status: 'unverified',
    explanation: 'Human revised an already approved result; prior Agent checks are not inherited.',
    evidenceRefs: []
  }));
  const revised: RuntimeArtifact = {
    id: freshId(), kind: 'agent_output', name: head.name, content, ownerId: stepId,
    revision: project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === stepId).length + 1,
    createdAt: revisedAt, humanCorrection: {
      basedOnArtifactId: head.id, rationale: note, correctedAt: revisedAt
    },
    ...(head.inputArtifactIds ? { inputArtifactIds: [...head.inputArtifactIds] } : {}),
    ...(methodChecks ? { methodChecks } : {})
  };
  project.artifacts.push(revised);
  project.steps[stepId].approvedArtifactId = revised.id;
  const invalidated = invalidateOutputDependents(project, stepId);
  recordEvent(project, 'work.human_revised_after_approval', stepId, JSON.stringify({
    actor: 'human', fromArtifactId: head.id, toArtifactId: revised.id,
    rationale: note, invalidatedSteps: invalidated
  }));
  return invalidated;
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
  const attachedIds = (project.humanRequests ?? [])
    .filter(request => request.stepId === stepId && !request.invalidatedAt && request.status === 'answered' &&
      request.attachmentArtifactId)
    .map(request => request.materialId);
  const materialIds = [...new Set([...def.needsMaterials, ...attachedIds])];
  const materials = materialIds.flatMap(id =>
    project.materials[id]?.state === 'accepted'
      ? [acceptedMaterialArtifact(project, id)].filter((a): a is RuntimeArtifact => Boolean(a))
      : []);
  const upstreamOutputs = def.dependsOn.flatMap(id => {
    const approved = currentApprovedOutput(project, id);
    return approved ? [approved] : [];
  });
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
