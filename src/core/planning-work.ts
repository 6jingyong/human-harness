import type { ProjectState } from './runtime';
import { effectiveMaterials } from './work-orders';
import type { Condition } from '../protocol/v1';
import type { PlanSettings, Pool } from '../protocol/planning';
import { civilMinute, dateMinute, nextWorkingMinute } from './planning-calendar';

export type PlanWork = {
  key: string;
  todoKey: string;
  title: string;
  pool: Pool;
  minutes: number;
  dependencies: string[];
  status: 'waiting' | 'ready' | 'running' | 'failed' | 'done';
  startedAt?: string;
  completedAt?: string;
};

const agentWork = (kind: string) => kind === 'agent' || kind === 'script';

export function planWork(project: ProjectState, settings: PlanSettings) {
  const steps = new Map(project.package.steps.map(step => [step.id, step]));
  const materials = new Map(project.package.materials.map(material => [material.id, material]));
  const completion = (id: string) => agentWork(steps.get(id)?.kind ?? '') ? 'review:' + id : 'step:' + id;
  const chosen = (id: string) => Object.hasOwn(project.decisions, id) ? project.decisions[id]
    : Object.hasOwn(settings.assumptions, id) ? settings.assumptions[id] : undefined;
  const newestEvents = new Map<string, string>();
  for (const event of project.events) newestEvents.set(event.type + ':' + event.subject, event.createdAt);
  const latest = (id: string, ...types: string[]) => types
    .map(type => newestEvents.get(type + ':' + id))
    .filter((value): value is string => Boolean(value)).sort().at(-1) ?? project.createdAt;
  const runs = new Map(project.runs.map(run => [run.id, run]));
  const requests = new Map<string, PlanWork[]>();
  for (const request of project.humanRequests ?? []) {
    if (request.invalidatedAt || request.status === 'answered') continue;
    const key = 'request:' + request.id;
    const row: PlanWork = {
      key, todoKey: key, pool: 'human', minutes: settings.estimates[key] ?? 30,
      dependencies: [], status: 'ready', title: '补充说明 · ' + (materials.get(request.materialId)?.title ?? request.materialId)
    };
    requests.set(request.stepId, [...(requests.get(request.stepId) ?? []), row]);
  }

  const memo = new Map<string, boolean>();
  // Protocol validation guarantees the cross-step/material activation graph is acyclic.
  const conditionDeps = (condition: Condition | undefined): string[] | undefined => {
    if (!condition) return [];
    if (condition.type === 'work_order') {
      return Object.hasOwn(project.coordination?.requirements ?? {}, condition.orderId) ? [] : undefined;
    }
    if (condition.type === 'decision') {
      const dependency = completion(condition.stepId);
      return chosen(condition.stepId) === condition.option && applicable(dependency) ? [dependency] : undefined;
    }
    if (condition.type === 'work_done') {
      const dependency = completion(condition.stepId);
      return applicable(dependency) ? [dependency] : undefined;
    }
    const clauses = condition.clauses.map(conditionDeps);
    if (condition.type === 'any') {
      return clauses.find(clause => clause?.every(key => isComplete(key))) ??
        clauses.find(clause => clause !== undefined);
    }
    return clauses.some(clause => clause === undefined) ? undefined : clauses.flatMap(clause => clause ?? []);
  };
  function isComplete(key: string): boolean {
    const [kind, id] = key.split(':');
    return kind === 'material' ? project.materials[id]?.state === 'accepted'
      : project.steps[id]?.state === 'done' || (kind === 'step' && project.steps[id]?.state === 'review');
  }
  function dependenciesOf(key: string): string[] | undefined {
    const [kind, id] = key.split(':');
    if (kind === 'material') {
      const item = materials.get(id);
      if (!item || item.onDemand) return undefined;
      if (isComplete(key)) return [];
      const required = conditionDeps(item.requiredWhen);
      const requested = conditionDeps(item.requestWhen);
      return required && requested ? [...required, ...requested] : undefined;
    }
    if (kind === 'review') return ['step:' + id];
    const step = steps.get(id);
    if (!step) return undefined;
    if (isComplete(key)) return [];
    const activation = conditionDeps(step.when);
    return activation && [...activation, ...step.dependsOn.map(completion),
      ...effectiveMaterials(project, step.id, step.needsMaterials).map(id => 'material:' + id)];
  }
  function applicable(key: string): boolean {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const deps = dependenciesOf(key);
    const included = deps !== undefined && deps.every(applicable);
    memo.set(key, included);
    return included;
  }

  const work: PlanWork[] = [];
  for (const material of project.package.materials) {
    const key = 'material:' + material.id;
    if (!applicable(key)) continue;
    const state = project.materials[material.id]?.state;
    const status = state === 'accepted' ? 'done'
      : state === 'requested' || state === 'received' || state === 'rejected' ? 'ready' : 'waiting';
    work.push({
      key, todoKey: key, title: material.title, pool: 'human', status,
      minutes: settings.estimates[key] ?? material.planningMinutes ?? 60,
      dependencies: dependenciesOf(key) ?? [],
      ...(status === 'done' ? { completedAt: latest(material.id, 'material.accepted') } : {})
    });
  }
  for (const step of project.package.steps) {
    const key = 'step:' + step.id;
    if (!applicable(key)) continue;
    const state = project.steps[step.id];
    const run = state?.runId ? runs.get(state.runId) : undefined;
    const machine = agentWork(step.kind);
    const completed = isComplete(key);
    const outstanding = requests.get(step.id) ?? [];
    const workStatus = completed ? 'done' : state?.state === 'running' ? 'running'
      : state?.state === 'ready' ? 'ready' : state?.state === 'failed' ? 'failed' : 'waiting';
    work.push(...outstanding);
    work.push({
      key, todoKey: key, title: step.title, status: workStatus,
      pool: machine ? 'agent' : step.kind === 'external_milestone' ? 'external' : 'human',
      minutes: settings.estimates[key] ?? step.planning?.workMinutes ??
        (step.kind === 'external_milestone' ? 2400 : step.kind === 'script' ? 30 : 60),
      dependencies: [...(dependenciesOf(key) ?? []), ...outstanding.map(request => request.key)],
      ...(run && (completed || workStatus === 'running') ? { startedAt: run.startedAt } : {}),
      ...(completed ? { completedAt: machine ? run?.endedAt ?? latest(step.id, 'run.review_requested')
        : latest(step.id, 'human.completed', 'decision.approved', 'external.confirmed') } : {})
    });
    if (!machine) continue;
    const reviewKey = 'review:' + step.id;
    work.push({
      key: reviewKey, todoKey: key, title: '审核 · ' + step.title,
      pool: 'human', status: state?.state === 'done' ? 'done' : state?.state === 'review' ? 'ready' : 'waiting',
      minutes: settings.estimates[reviewKey] ?? step.planning?.reviewMinutes ?? 30,
      dependencies: [key],
      ...(state?.state === 'done' ? { completedAt: latest(step.id, 'work.approved', 'work.human_revised_after_approval') } : {})
    });
  }
  const unresolvedDecisions = project.package.steps.filter(step =>
    step.kind === 'human_decision' && !chosen(step.id) && applicable('step:' + step.id));
  return { work, unresolvedDecisions };
}

export function priorityClosure(work: readonly PlanWork[], urgent: readonly string[]) {
  const byKey = new Map(work.map(item => [item.key, item]));
  const chosen = new Set<string>();
  const visit = (key: string) => {
    const row = byKey.get(key);
    if (!row || chosen.has(key) || row.status === 'done') return;
    chosen.add(key);
    row.dependencies.forEach(visit);
  };
  urgent.forEach(visit);
  return chosen;
}

/** Runtime priorities follow current work and its prerequisites. Scenario assumptions never unlock tasks. */
export function priorityKeys(project: ProjectState): Set<string> {
  const settings = project.planning?.settings;
  if (!settings?.expedited.length) return new Set();
  const { work } = planWork(project, { ...settings, assumptions: {} });
  return priorityClosure(work, settings.expedited);
}

export function readyAgentSteps(project: ProjectState) {
  const priority = priorityKeys(project);
  return project.package.steps.filter(step =>
    agentWork(step.kind) && project.steps[step.id]?.state === 'ready')
    .sort((a, b) => Number(priority.has('step:' + b.id)) - Number(priority.has('step:' + a.id)));
}

/** A saved window constrains auto-dispatch. Explicit manual starts still use the normal concurrency gate. */
export function automaticWindowOpen(project: ProjectState, instant: Date) {
  const plan = project.planning?.settings;
  if (!plan?.restrictAgentStarts) return true;
  const local = civilMinute(instant, plan.timeZone);
  return local >= dateMinute(plan.start) && local === nextWorkingMinute(local, plan.agentMinutes);
}
