import { z } from 'zod';

/** Canonical Human Harness Protocol v1 — no legacy schemaVersion adapters. */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const capabilityId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const description = z.string().min(1).max(4000);

export type Condition =
  | { type: 'decision'; stepId: string; option: string }
  | { type: 'work_done'; stepId: string }
  | { type: 'all' | 'any'; clauses: Condition[] };

const condition: z.ZodType<Condition> = z.lazy(() => z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('decision'), stepId: id, option: id }),
  z.strictObject({ type: z.literal('work_done'), stepId: id }),
  z.strictObject({ type: z.literal('all'), clauses: z.array(condition).min(1).max(20) }),
  z.strictObject({ type: z.literal('any'), clauses: z.array(condition).min(1).max(20) })
]));

const stage = z.strictObject({ id, title: description, description });
const capability = z.strictObject({ id: capabilityId, kind: z.enum(['agent', 'script', 'parser', 'renderer']), description });
const asset = z.strictObject({ id, kind: z.enum(['reference', 'document_master', 'form']), path: z.string().min(1).max(500), sha256: digest, title: description });
const material = z.strictObject({
  id, title: description, producer: z.enum(['human', 'agent', 'external_institution']),
  requiredWhen: condition.optional(), requestWhen: condition.optional(),
  formats: z.array(z.string().min(1).max(100)).max(20),
  acceptance: z.array(description).min(1).max(20), description
});
const step = z.strictObject({
  id, stageId: id,
  kind: z.enum(['agent', 'script', 'human_action', 'human_decision', 'external_milestone']),
  title: description, instructions: description,
  dependsOn: z.array(id).max(50), needsMaterials: z.array(id).max(50),
  when: condition.optional(), capabilityId: capabilityId.optional(),
  options: z.array(z.strictObject({ id, label: description })).min(2).max(20).optional(),
  requiresReview: z.boolean().optional(), outputContractId: id.optional(),
  resourceIds: z.array(id).max(30).optional()
});
const output = z.strictObject({
  id, title: description, audience: z.enum(['internal', 'external']),
  fileName: z.string().min(1).max(160), format: z.enum(['markdown', 'json', 'docx', 'pdf']),
  producingStepId: id, rendererCapabilityId: capabilityId.optional(),
  acceptance: z.array(description).min(1).max(30), humanSignoff: z.boolean()
});

/** A strict, package-local validator. Runtime capability availability is a separate check. */
export const packageSchema = z.strictObject({
  protocol: z.literal('hh.package/1'),
  id, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: description, description,
  stages: z.array(stage).min(1).max(100),
  capabilities: z.array(capability).max(100),
  assets: z.array(asset).max(200),
  materials: z.array(material).max(300),
  steps: z.array(step).min(1).max(400),
  outputs: z.array(output).min(1).max(100)
}).superRefine((pkg, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) error('Duplicate ' + label + ' IDs');
  };
  unique(pkg.stages.map(x => x.id), 'stage');
  unique(pkg.steps.map(x => x.id), 'step');
  unique(pkg.materials.map(x => x.id), 'material');
  unique(pkg.capabilities.map(x => x.id), 'capability');
  unique(pkg.assets.map(x => x.id), 'asset');
  unique(pkg.outputs.map(x => x.id), 'output');

  const stageIds = new Set(pkg.stages.map(x => x.id));
  const steps = new Map(pkg.steps.map(x => [x.id, x]));
  const materials = new Set(pkg.materials.map(x => x.id));
  const capabilities = new Map(pkg.capabilities.map(x => [x.id, x]));
  const assets = new Set(pkg.assets.map(x => x.id));
  const outputs = new Map(pkg.outputs.map(x => [x.id, x]));

  const checkCondition = (c: Condition | undefined, owner: string): void => {
    if (!c) return;
    if (c.type === 'decision') {
      const gate = steps.get(c.stepId);
      if (!gate || gate.kind !== 'human_decision' || !gate.options?.some(option => option.id === c.option)) {
        error(owner + ': invalid decision condition ' + c.stepId + '/' + c.option);
      }
    } else if (c.type === 'work_done') {
      if (!steps.has(c.stepId)) error(owner + ': unknown work completion ' + c.stepId);
    } else {
      for (const clause of c.clauses) checkCondition(clause, owner);
    }
  };

  for (const a of pkg.assets) {
    if (a.path.startsWith('/') || a.path.includes('\\') || a.path.split('/').some(p => !p || p === '.' || p === '..')) {
      error('Unsafe asset path ' + a.path);
    }
  }
  for (const m of pkg.materials) {
    checkCondition(m.requiredWhen, 'material ' + m.id);
    checkCondition(m.requestWhen, 'material ' + m.id);
  }
  for (const s of pkg.steps) {
    if (!stageIds.has(s.stageId)) error(s.id + ': unknown stage');
    for (const dep of s.dependsOn) if (!steps.has(dep) || dep === s.id) error(s.id + ': invalid dependency ' + dep);
    for (const m of s.needsMaterials) if (!materials.has(m)) error(s.id + ': unknown material ' + m);
    for (const r of s.resourceIds ?? []) if (!assets.has(r)) error(s.id + ': unknown resource ' + r);
    checkCondition(s.when, 'step ' + s.id);
    if (s.kind === 'human_decision') {
      if (!s.options || new Set(s.options.map(option => option.id)).size !== s.options.length) error(s.id + ': invalid choice gate options');
    } else if (s.options) error(s.id + ': only a human decision may contain options');
    if (s.kind === 'script' || s.kind === 'agent') {
      if (!s.capabilityId || capabilities.get(s.capabilityId)?.kind !== s.kind) {
        error(s.id + ': missing or mismatched declared execution capability');
      }
    } else if (s.capabilityId) error(s.id + ': human/external steps cannot execute tools');
    if (s.outputContractId && outputs.get(s.outputContractId)?.producingStepId !== s.id) {
      error(s.id + ': output contract must belong to producing step');
    }
  }
  for (const out of pkg.outputs) {
    const producer = steps.get(out.producingStepId);
    if (!producer || (producer.kind !== 'agent' && producer.kind !== 'script')) error(out.id + ': output requires a producing agent/script step');
    if (producer?.outputContractId !== out.id) error(out.id + ': producing step must name output contract');
    const suffix = { markdown: '.md', json: '.json', docx: '.docx', pdf: '.pdf' }[out.format];
    if (out.fileName.startsWith('.') || out.fileName.includes('/') || out.fileName.includes('\\') || !out.fileName.endsWith(suffix)) error(out.id + ': invalid output filename or format');
    if (out.rendererCapabilityId && capabilities.get(out.rendererCapabilityId)?.kind !== 'renderer') error(out.id + ': unknown renderer capability');
    if (out.audience === 'external' && !out.humanSignoff) error(out.id + ': external output requires human signoff');
  }
  // Detect deadlocks that cross step/material boundaries, not only task-to-task cycles.
  // Example: a QC material cannot be requested only after the task that requires it is completed.
  const graph = new Map<string, string[]>();
  const append = (node: string, dep: string) => graph.set(node, [...(graph.get(node) ?? []), dep]);
  const conditionRefs = (c: Condition | undefined): string[] => {
    if (!c) return [];
    if (c.type === 'decision' || c.type === 'work_done') return [c.stepId];
    return c.clauses.flatMap(conditionRefs);
  };
  for (const step of pkg.steps) {
    const key = 'step:' + step.id;
    graph.set(key, []);
    for (const dep of step.dependsOn) append(key, 'step:' + dep);
    for (const materialId of step.needsMaterials) append(key, 'material:' + materialId);
    for (const dep of conditionRefs(step.when)) append(key, 'step:' + dep);
  }
  for (const material of pkg.materials) {
    const key = 'material:' + material.id;
    graph.set(key, []);
    for (const dep of [...conditionRefs(material.requiredWhen), ...conditionRefs(material.requestWhen)]) {
      append(key, 'step:' + dep);
    }
  }
  const visitingGraph = new Set<string>(), resolvedGraph = new Set<string>();
  const inspectGraph = (key: string): void => {
    if (resolvedGraph.has(key)) return;
    if (visitingGraph.has(key)) { error('Dependency deadlock at ' + key); return; }
    visitingGraph.add(key);
    for (const ref of graph.get(key) ?? []) if (graph.has(ref)) inspectGraph(ref);
    visitingGraph.delete(key); resolvedGraph.add(key);
  };
  for (const key of graph.keys()) inspectGraph(key);
  const active = new Set<string>(), visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (active.has(stepId)) { error('Cycle at step ' + stepId); return; }
    active.add(stepId);
    for (const dep of steps.get(stepId)?.dependsOn ?? []) if (steps.has(dep)) visit(dep);
    active.delete(stepId); visited.add(stepId);
  };
  for (const stepId of steps.keys()) visit(stepId);
});

const artifactPointer = z.strictObject({
  artifactId: id, revision: z.number().int().positive(),
  role: z.enum(['case_evidence', 'reference', 'approved_derived']), viewId: id
});
export const taskPacketSchema = z.strictObject({
  protocol: z.literal('hh.task/1'),
  runId: id, projectId: id, workItemId: id, objective: description,
  readableInputs: z.array(artifactPointer).max(100),
  templateResources: z.array(z.strictObject({ resourceId: id, revision: z.number().int().positive(), role: z.literal('reference') })).max(100),
  toolsAllowed: z.array(capabilityId).max(100),
  outputContractId: id.optional(),
  reviewPolicy: z.enum(['human_required', 'automated_validation'])
});
export const taskResultSchema = z.strictObject({
  protocol: z.literal('hh.result/1'),
  runId: id, workItemId: id,
  outcome: z.enum(['submitted_for_review', 'needs_input', 'blocked', 'failed']),
  producedArtifacts: z.array(z.strictObject({ artifactRef: id, contractId: id.optional() })).max(100),
  proposedActions: z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('request_material'), requirementKind: id, reason: description, evidenceRefs: z.array(id).min(1).max(30) }),
    z.strictObject({ type: z.literal('propose_task'), title: description, reason: description, evidenceRefs: z.array(id).min(1).max(30) }),
    z.strictObject({ type: z.literal('flag_risk'), description, evidenceRefs: z.array(id).min(1).max(30) })
  ])).max(100),
  limitations: z.array(description).max(100)
});

export type HumanHarnessPackage = z.infer<typeof packageSchema>;
export type HumanHarnessTaskPacket = z.infer<typeof taskPacketSchema>;
export type HumanHarnessTaskResult = z.infer<typeof taskResultSchema>;
