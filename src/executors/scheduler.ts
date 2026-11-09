import { executionPolicy } from '../core/runtime';
import { getProject, interruptOrphanedRuns, listProjects, markAgentFailed, RuntimeError } from '../core/store';
import { executeOneAgentTask } from './runner';
import type { TaskExecutor } from './contracts';

type ActiveTask = {
  promise: Promise<void>;
  controller: AbortController;
  runId: string;
};

/**
 * Local single-process dispatcher. SQLite project state is authoritative,
 * and this map owns only active subprocess handles.
 *
 * Not a distributed job queue: production multi-host deployment is unsupported.
 */
export class LocalScheduler {
  private readonly active = new Map<string, ActiveTask>();
  private scanning = false;
  private stopped = false;

  constructor(
    private readonly executor?: TaskExecutor,
    private readonly globalLimit = 2,
    private readonly onFailure: (message: string) => void = message => console.error(message)
  ) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1 || globalLimit > 8) {
      throw new Error('Scheduler global limit must be 1–8');
    }
  }

  private key(projectId: string, stepId: string) {
    return projectId + ':' + stepId;
  }

  /** Reserve in SQLite immediately; the model runs in a detached promise. */
  private dispatch(projectId: string, stepId: string) {
    const key = this.key(projectId, stepId);
    if (this.active.has(key)) throw new RuntimeError('Agent task is already active locally');
    if (this.active.size >= this.globalLimit) throw new RuntimeError('Global Agent concurrency limit reached');
    const controller = new AbortController();
    const task = executeOneAgentTask(projectId, stepId, this.executor, controller.signal);
    // executeOneAgentTask reserves the run synchronously before its first await.
    const runId = getProject(projectId).steps[stepId]?.runId;
    const record = getProject(projectId).runs.find(r => r.id === runId && r.status === 'running');
    const finished = task.then(() => undefined, error => {
      this.onFailure('Agent work item failed [' + key + ']: ' +
        (error instanceof Error ? error.message : String(error)));
    }).finally(() => {
      this.active.delete(key);
      queueMicrotask(() => this.pulse());
    });
    if (!record || !runId) {
      void finished; // no reservation, failure is already logged
      throw new RuntimeError('Agent run was not reserved');
    }
    this.active.set(key, { promise: finished, controller, runId });
    return record;
  }

  /** Manual explicit run uses the same non-blocking local worker path. */
  runOnce(projectId: string, stepId: string) {
    if (!stepId) throw new RuntimeError('Choose a specific Agent task');
    const project = getProject(projectId);
    if (project.steps[stepId]?.state !== 'ready') throw new RuntimeError('Agent work item is not ready');
    this.dispatch(projectId, stepId);
    return getProject(projectId);
  }

  /** Cancel only a locally-owned, run-ID-matching task. Late output is discarded. */
  cancel(projectId: string, stepId: string) {
    const key = this.key(projectId, stepId);
    const active = this.active.get(key);
    if (!active) throw new RuntimeError('This run is not owned by the current local worker');
    const project = getProject(projectId);
    if (project.steps[stepId]?.state !== 'running' ||
        project.steps[stepId]?.runId !== active.runId) {
      throw new RuntimeError('Run identity changed; cancel request was rejected');
    }
    markAgentFailed(projectId, stepId, active.runId,
      'Cancelled by human operator; no result will be accepted. Retry requires explicit authorization.');
    active.controller.abort();
    return getProject(projectId);
  }

  /** Start all dependency-ready tasks within project/global limits. */
  pulse(): void {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      for (const row of listProjects()) {
        if (this.active.size >= this.globalLimit) break;
        const project = getProject(row.id);
        const policy = executionPolicy(project);
        if (!policy.autoDispatch) continue;
        let runningCount = Object.values(project.steps).filter(s => s.state === 'running').length;
        if (runningCount >= policy.maxParallel) continue;
        for (const step of project.package.steps) {
          if (this.active.size >= this.globalLimit || runningCount >= policy.maxParallel) break;
          if (!['agent', 'script'].includes(step.kind) || project.steps[step.id]?.state !== 'ready') continue;
          if (this.active.has(this.key(project.id, step.id))) continue;
          try {
            this.dispatch(project.id, step.id);
            runningCount++;
          } catch (error) {
            // An unrelated ready task can still start; no failure state is fabricated
            // when reservation itself fails.
            this.onFailure('Agent dispatch failed [' + project.id + ':' + step.id + ']: ' +
              (error instanceof Error ? error.message : String(error)));
          }
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  get activeCount() { return this.active.size; }

  async waitUntilIdle() {
    while (this.active.size) await Promise.all([...this.active.values()].map(r => r.promise));
  }

  stop() { this.stopped = true; }
}

const shared = globalThis as typeof globalThis & {
  __humanHarnessLocalScheduler?: LocalScheduler;
  __humanHarnessSchedulerTimer?: ReturnType<typeof setInterval>;
};

/**
 * First API request boots the worker. Only the first boot in this process
 * marks persisted running tasks from prior process lifetimes as interrupted.
 * It NEVER silently replays potentially side-effecting Agent calls.
 */
export function ensureLocalScheduler(): LocalScheduler {
  if (!shared.__humanHarnessLocalScheduler) {
    interruptOrphanedRuns();
    const configured = Number(process.env.HH_GLOBAL_CONCURRENCY || 2);
    const limit = Number.isInteger(configured) && configured >= 1 && configured <= 8 ? configured : 2;
    shared.__humanHarnessLocalScheduler = new LocalScheduler(undefined, limit);
  }
  if (!shared.__humanHarnessSchedulerTimer) {
    const timer = setInterval(() => shared.__humanHarnessLocalScheduler?.pulse(), 2500);
    timer.unref?.();
    shared.__humanHarnessSchedulerTimer = timer;
  }
  shared.__humanHarnessLocalScheduler.pulse();
  return shared.__humanHarnessLocalScheduler;
}
