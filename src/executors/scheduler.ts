import { executionPolicy } from '../core/runtime';
import { getProject, listProjects } from '../core/store';
import { executeOneAgentTask } from './runner';
import type { TaskExecutor } from './contracts';

/**
 * Local single-process dispatcher. Project state is authoritative in SQLite;
 * active promises are just this server process's worker handles.
 *
 * No new Agent loop, in-memory task ledger, or browser-held execution.
 * The persisted run lease prevents duplicate execution of the same WorkItem.
 */
export class LocalScheduler {
  private readonly active = new Map<string, Promise<void>>();
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

  /** Synchronously reserves all eligible slots, then runs them without awaiting the model. */
  pulse(): void {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      for (const row of listProjects()) {
        if (this.active.size >= this.globalLimit) break;
        const project = getProject(row.id);
        const policy = executionPolicy(project);
        if (!policy.autoDispatch) continue;

        // Includes runs from an earlier process: never silently relaunch an
        // uncertain task after a crash. Explicit recovery is still required.
        let runningCount = Object.values(project.steps)
          .filter(step => step.state === 'running').length;
        if (runningCount >= policy.maxParallel) continue;
        for (const step of project.package.steps) {
          if (this.active.size >= this.globalLimit || runningCount >= policy.maxParallel) break;
          if (step.kind !== 'agent' || project.steps[step.id]?.state !== 'ready') continue;
          const key = project.id + ':' + step.id;
          if (this.active.has(key)) continue;
          const task = executeOneAgentTask(project.id, step.id, this.executor);
          runningCount++;
          const finished = task.then(() => undefined, error => {
            this.onFailure('Agent work item failed [' + key + ']: ' +
              (error instanceof Error ? error.message : String(error)));
          }).finally(() => {
            this.active.delete(key);
            queueMicrotask(() => this.pulse());
          });
          this.active.set(key, finished);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  get activeCount() { return this.active.size; }

  /** Deterministic test helper, not used by API handlers. */
  async waitUntilIdle() {
    while (this.active.size) {
      await Promise.all([...this.active.values()]);
    }
  }

  stop() { this.stopped = true; }
}

const shared = globalThis as typeof globalThis & {
  __humanHarnessLocalScheduler?: LocalScheduler;
  __humanHarnessSchedulerTimer?: ReturnType<typeof setInterval>;
};

/**
 * First request boots an in-process local worker and its periodic sweep.
 * The request never waits for Agent completion; page refresh does not cancel work.
 */
export function ensureLocalScheduler(): LocalScheduler {
  if (!shared.__humanHarnessLocalScheduler) {
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
