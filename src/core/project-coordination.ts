import type { ProjectState } from './runtime';
import { currentExternalPromise, enabledWorkOrders } from './work-orders';
import { planWork, type PlanWork } from './planning-work';
import { calculateProjectPlan, defaultPlan } from './project-plan';
import { addWorkingDays, civilDate, civilMinute, dateMinute, dayMinutes, latestWorkingStart } from './planning-calendar';

export type WorkTiming = {
  orderId: string;
  orderTitle: string;
  latestStart: number;
  dueSoon: boolean;
  lateToStart: boolean;
};
export type ExternalFollowUp = {
  stepId: string;
  dueOn: string;
  due: boolean;
  lastUpdate?: string;
  promisedOn?: string;
};

export function coordinationOverview(project: ProjectState, asOf: Date) {
  const timings = new Map<string, WorkTiming>();
  const followUps = new Map<string, ExternalFollowUp>();
  const orderStatus = new Map<string, { done: boolean; atRisk: boolean }>();
  if (!project.coordination) return { timings, followUps, orderStatus };

  const { timeZone, requirements } = project.coordination;
  const now = civilMinute(asOf, timeZone);
  const plan = project.planning?.settings ?? defaultPlan(project, timeZone);
  const capacity = { human: plan.humanMinutes, agent: plan.agentMinutes, external: plan.externalMinutes };
  const orders = enabledWorkOrders(project);
  if (!orders.length) return { timings, followUps, orderStatus };
  const measured = { ...plan, timeZone, assumptions: {} };
  const rows = new Map(planWork(project, measured).work.map(row => [row.key, row]));
  const endTimes = new Map(calculateProjectPlan(project, measured, asOf).rows.map(row => [row.key, row.finish]));
  for (const order of orders) {
    const due = dateMinute(requirements[order.id].due) + dayMinutes;
    const latest = new Map<string, number>();
    const visit = (row: PlanWork | undefined, finish: number) => {
      if (!row || row.status === 'done') return;
      const start = latestWorkingStart(finish, row.minutes, capacity[row.pool]);
      const previous = latest.get(row.key);
      if (previous !== undefined && previous <= start) return;
      latest.set(row.key, start);
      for (const key of row.dependencies) visit(rows.get(key), start);
    };
    for (const id of order.deliverables) visit(rows.get('material:' + id), due);
    let atRisk = false;
    for (const [key, latestStart] of latest) {
      const lateToStart = now > latestStart;
      const dueSoon = civilDate(latestStart) <= civilDate(addWorkingDays(now, 1));
      atRisk ||= lateToStart;
      const old = timings.get(key);
      if (!old || latestStart < old.latestStart) {
        timings.set(key, { orderId: order.id, orderTitle: order.title, latestStart, dueSoon, lateToStart });
      }
    }
    const done = order.deliverables.every(id => project.materials[id]?.state === 'accepted');
    const follow = order.followUp;
    const promise = follow && project.steps[follow.milestoneId]?.state === 'ready'
      ? currentExternalPromise(project, follow.milestoneId) : undefined;
    const materialStarts = order.deliverables.map(id => latest.get('material:' + id) ?? due);
    const acceptanceDay = civilDate(Math.min(...materialStarts));
    const forecastLate = order.deliverables.some(id => (endTimes.get('material:' + id) ?? Infinity) >= due);
    const promiseLate = promise && promise.detail > acceptanceDay;
    orderStatus.set(order.id, { done, atRisk: !done && (atRisk || forecastLate || Boolean(promiseLate)) });


    if (!follow || project.steps[follow.milestoneId]?.state !== 'ready') continue;
    const triggered = project.events.findLast(event => event.type === 'work.state' &&
      event.subject === follow.milestoneId && event.detail === 'ready');
    if (!triggered) continue;
    const last = project.events.findLast(event => event.type === 'work_order.follow_up' &&
      event.subject === follow.milestoneId && event.createdAt >= triggered.createdAt);
    const lastAt = civilMinute((last ?? triggered).createdAt, timeZone);
    const nextRoutine = addWorkingDays(lastAt, last ? 1 : follow.workingDays);
    const updatedPromise = promise && (!last || project.events.indexOf(promise) > project.events.indexOf(last))
      ? dateMinute(promise.detail) : nextRoutine;
    // A new or promised date cannot postpone the first check past the last acceptance slot.
    // Once followed up, wait until at least the next workday to prompt again.
    const firstCheck = Math.min(updatedPromise, ...materialStarts);
    const dueOn = civilDate(last ? Math.max(nextRoutine, firstCheck) : firstCheck);
    followUps.set(follow.milestoneId, {
      stepId: follow.milestoneId, dueOn, due: civilDate(now) >= dueOn,
      ...(last ? { lastUpdate: last.detail } : {}),
      ...(promise ? { promisedOn: promise.detail } : {})
    });
  }
  return { timings, followUps, orderStatus };
}

export function formatLatestStart(minute: number) {
  return new Date(minute * 60000).toISOString().slice(0, 16).replace('T', ' ');
}
