import type { ProjectState } from './runtime';
import { pools, type PlanBaseline, type PlanSettings, type Pool } from '../protocol/planning';
import { civilDate, civilMinute, dateMinute, dayMinutes, nextWorkingMinute, workWindow } from './planning-calendar';
import { planWork, priorityClosure, type PlanWork } from './planning-work';

type PlanWindow = { start: number; finish: number };
export type ScheduledWork = PlanWork & PlanWindow & {
  segments: PlanWindow[];
  lane?: number;
  critical: boolean;
  overdue: boolean;
  delayed: boolean;
  taskDue?: string;
  missesTaskDue: boolean;
};
type Lane = { available: number; previous?: string };

export function defaultPlan(project: Pick<ProjectState, 'createdAt'>, timeZone: string): PlanSettings {
  return {
    timeZone, start: civilDate(civilMinute(project.createdAt, timeZone)),
    humanLanes: 1, externalLanes: 1, humanMinutes: 120, agentMinutes: 480, externalMinutes: 480,
    estimates: {}, assumptions: {}, expedited: []
  };
}

export function calculateProjectPlan(project: ProjectState, settings: PlanSettings, asOf: Date,
  baseline = project.planning?.baseline) {
  const now = civilMinute(asOf, settings.timeZone);
  const earliest = Math.max(now, dateMinute(settings.start));
  const deadline = settings.due ? dateMinute(settings.due) + dayMinutes : undefined;
  const sameZoneBaseline = baseline?.timeZone === settings.timeZone ? baseline : undefined;
  const capacity: Record<Pool, { lanes: Lane[]; minutes: number }> = {
    human: { lanes: Array.from({ length: settings.humanLanes }, (): Lane => ({ available: earliest })), minutes: settings.humanMinutes },
    agent: { lanes: Array.from({ length: project.execution?.maxParallel ?? 2 }, (): Lane => ({ available: earliest })), minutes: settings.agentMinutes },
    external: { lanes: Array.from({ length: settings.externalLanes }, (): Lane => ({ available: earliest })), minutes: settings.externalMinutes }
  };
  const { work, unresolvedDecisions } = planWork(project, settings);
  const urgent = priorityClosure(work, settings.expedited);
  const scheduled = new Map<string, ScheduledWork>();
  const drivers = new Map<string, string[]>();
  const pending: PlanWork[] = [];

  function store(row: PlanWork, window: ReturnType<typeof workWindow>, lane?: number) {
    const baselineFinish = sameZoneBaseline?.tasks[row.key]?.finish;
    const taskDue = settings.taskDueDates?.[row.key];
    const taskDeadline = taskDue ? dateMinute(taskDue) + dayMinutes : undefined;
    const missesTaskDue = taskDeadline !== undefined && window.finish >= taskDeadline;
    const incomplete = row.status !== 'done';
    const overdue = incomplete && ((baselineFinish !== undefined && now > baselineFinish) ||
      (taskDeadline !== undefined && now >= taskDeadline));
    const delayed = baselineFinish !== undefined && window.finish > baselineFinish;
    scheduled.set(row.key, { ...row, ...window, lane, critical: false, overdue, delayed, taskDue, missesTaskDue });
  }

  for (const row of work) {
    if (row.completedAt) {
      const finish = civilMinute(row.completedAt, settings.timeZone);
      const start = row.startedAt ? civilMinute(row.startedAt, settings.timeZone) : finish;
      store(row, { start, finish, segments: [{ start, finish }] });
    } else if (row.status === 'running' && row.startedAt) {
      const start = civilMinute(row.startedAt, settings.timeZone);
      const resource = capacity[row.pool];
      const estimate = workWindow(start, row.minutes, resource.minutes);
      const finish = Math.max(now + 30, estimate.finish);
      const lane = resource.lanes.findIndex(slot => !slot.previous);
      if (lane >= 0) resource.lanes[lane] = { available: finish, previous: row.key };
      // Reducing configured concurrency while jobs are active keeps planned capacity reserved until they finish.
      if (lane < 0) for (const slot of resource.lanes) slot.available = Math.max(slot.available, finish);
      store(row, { start, finish, segments: [{ start, finish }] }, lane >= 0 ? lane + 1 : undefined);
    } else {
      pending.push(row);
    }
  }

  while (pending.length) {
    let chosen: { index: number; start: number; lane: number; readyAt: number; urgent: boolean } | undefined;
    for (const [index, row] of pending.entries()) {
      if (row.dependencies.some(key => !scheduled.has(key))) continue;
      const readyAt = Math.max(earliest, ...row.dependencies.map(key => scheduled.get(key)!.finish));
      const resource = capacity[row.pool];
      for (const [lane, slot] of resource.lanes.entries()) {
        const start = nextWorkingMinute(Math.max(readyAt, slot.available), resource.minutes);
        const high = urgent.has(row.key);
        if (!chosen || start < chosen.start || (start === chosen.start && high && !chosen.urgent)) {
          chosen = { index, start, lane, readyAt, urgent: high };
        }
      }
    }
    if (!chosen) throw new Error('Project schedule has unresolved task dependencies');
    const [row] = pending.splice(chosen.index, 1);
    const resource = capacity[row.pool];
    const previous = resource.lanes[chosen.lane];
    const window = workWindow(chosen.start, row.minutes, resource.minutes);
    const constrainedAt = Math.max(chosen.readyAt, previous.available);
    drivers.set(row.key, [
      ...row.dependencies.filter(key => scheduled.get(key)!.finish === constrainedAt),
      ...(previous.previous && previous.available === constrainedAt ? [previous.previous] : [])
    ]);
    resource.lanes[chosen.lane] = { available: window.finish, previous: row.key };
    store(row, window, chosen.lane + 1);
  }

  const rows = [...scheduled.values()].sort((a, b) => a.start - b.start || a.finish - b.finish);
  const last = rows.reduce<ScheduledWork | undefined>((latest, row) =>
    !latest || row.finish > latest.finish ? row : latest, undefined);
  const markDriver = (key: string) => {
    const row = scheduled.get(key);
    if (!row || row.critical || row.status === 'done') return;
    row.critical = true;
    drivers.get(key)?.forEach(markDriver);
  };
  if (last) markDriver(last.key);
  const finish = last?.finish ?? null;
  const behindTarget = finish !== null && deadline !== undefined && finish >= deadline;
  const remainingMinutes = Object.fromEntries(pools.map(pool => [
    pool, rows.filter(row => row.pool === pool && row.status !== 'done').reduce((sum, row) => sum + row.minutes, 0)
  ])) as Record<Pool, number>;
  const attention = rows.filter(row => row.status === 'failed' ||
    (row.status === 'ready' && row.pool !== 'agent' && (
      row.overdue || row.missesTaskDue || urgent.has(row.key) || civilDate(row.start) === civilDate(now) || (behindTarget && row.critical)
    ))).sort((a, b) => Number(b.overdue) - Number(a.overdue) ||
      Number(b.missesTaskDue) - Number(a.missesTaskDue) || Number(b.critical) - Number(a.critical));
  return { rows, attention, urgent, unresolvedDecisions, finish, now, deadline, behindTarget, remainingMinutes };
}

export function capturePlanBaseline(project: ProjectState, settings: PlanSettings, asOf: Date): PlanBaseline {
  const plan = calculateProjectPlan(project, settings, asOf);
  if (plan.unresolvedDecisions.length) throw new Error('Please confirm or assume the remaining planning branches first');
  return {
    capturedAt: asOf.toISOString(), timeZone: settings.timeZone,
    ...(settings.due ? { due: settings.due } : {}),
    finish: plan.finish,
    tasks: Object.fromEntries(plan.rows.map(row => [row.key, { start: row.start, finish: row.finish }]))
  };
}
