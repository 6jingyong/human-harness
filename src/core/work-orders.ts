import type { ProjectState } from './runtime';

export function enabledWorkOrders(project: ProjectState) {
  return (project.package.workOrders ?? []).filter(order =>
    Object.hasOwn(project.coordination?.requirements ?? {}, order.id));
}

export function workOrderForMaterial(project: ProjectState, materialId: string) {
  return project.package.workOrders?.find(order => order.deliverables.includes(materialId));
}

export function effectiveMaterials(project: ProjectState, stepId: string, base: readonly string[]) {
  const extra = enabledWorkOrders(project).filter(order => order.consumers.includes(stepId))
    .flatMap(order => order.deliverables);
  return [...new Set([...base, ...extra])];
}

export function workOrderHandoffTarget(project: ProjectState, stepId: string) {
  const steps = project.package.steps;
  return enabledWorkOrders(project).map(order => order.followUp?.milestoneId).find(id =>
    id && steps.find(step => step.id === id)?.dependsOn.includes(stepId));
}

export function currentExternalPromise(project: ProjectState, milestoneId: string) {
  const triggered = project.events.findLastIndex(event => event.type === 'work.state' &&
    event.subject === milestoneId && event.detail === 'ready');
  if (triggered < 0) return undefined;
  return project.events.slice(triggered + 1).findLast(event =>
    event.type === 'work_order.promise' && event.subject === milestoneId);
}
