import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskExecutor } from '../src/executors/contracts';
import { packageSchema } from '../src/protocol/v1';
import { manualProjectPackage } from '../src/protocol/manual';

const directory = mkdtempSync(join(tmpdir(), 'hh-scheduler-test-'));
process.env.HH_DATA_DIR = directory;
const store = await import('../src/core/store');
const { LocalScheduler } = await import('../src/executors/scheduler');
after(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows */ } });

function makeProject(name: string) {
  const template = manualProjectPackage({
    id: name, title: name, description: 'Project-level parallel scheduler test',
    inputs: 'One input', objective: 'Produce an independently reviewable result'
  });
  const source = template.steps[0];
  const output = template.outputs[0];
  const makeAgent = (id: string, dependsOn: string[] = []) => ({
    ...source, id, title: id, dependsOn, outputContractId: 'output-' + id
  });
  const pkg = packageSchema.parse({
    ...template,
    steps: [
      makeAgent('a'), makeAgent('b'),
      {
        id: 'human', stageId: 'work', kind: 'human_action',
        title: 'External human input', instructions: 'Confirm this independently',
        dependsOn: [], needsMaterials: []
      },
      makeAgent('merge', ['a', 'b', 'human'])
    ],
    outputs: ['a', 'b', 'merge'].map(id => ({
      ...output, id: 'output-' + id, fileName: id + '.md', producingStepId: id
    }))
  });
  store.importPackage(pkg);
  const p = store.createProject(name, name);
  store.submitMaterial(p.id, 'input-01', 'Source already available');
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  return p.id;
}

const spin = () => new Promise<void>(resolve => setImmediate(resolve));

test('auto-dispatch reserves two independent tasks; Human Todo stays actionable and merge waits for approval', async () => {
  const id = makeProject('auto-parallel-test');
  const releases = new Map<string, (text: string) => void>();
  const executor: TaskExecutor = {
    id: 'deferred-scheduler-fixture',
    execute: task => new Promise(resolve => {
      releases.set(task.packet.workItemId, body => resolve({
        body, limitations: [], materialRequests: []
      }));
    })
  };
  const scheduler = new LocalScheduler(executor, 2, message => { throw new Error(message); });
  assert.deepEqual(store.getProject(id).execution, { autoDispatch: true, maxParallel: 2 });
  scheduler.pulse();
  scheduler.pulse();
  assert.equal(scheduler.activeCount, 2);
  assert.deepEqual([...releases.keys()], ['a', 'b']);
  assert.equal(store.getProject(id).runs.length, 2);
  assert.equal(store.getProject(id).steps.merge.state, 'blocked');

  store.completeHuman(id, 'human', 'Human can work while both Agent runs are active');
  assert.equal(store.getProject(id).steps.human.state, 'done');
  assert.equal(store.getProject(id).steps.a.state, 'running');

  releases.get('b')!('B candidate');
  await spin();
  assert.equal(store.getProject(id).steps.b.state, 'review');
  assert.equal(store.getProject(id).steps.a.state, 'running');
  store.reviewAgentOutput(id, 'b', true, '');
  assert.equal(store.getProject(id).steps.merge.state, 'blocked');

  releases.get('a')!('A candidate');
  await spin();
  store.reviewAgentOutput(id, 'a', true, '');
  assert.equal(store.getProject(id).steps.merge.state, 'ready');
  scheduler.pulse();
  assert.equal(store.getProject(id).steps.merge.state, 'running');
  releases.get('merge')!('Merged candidate');
  await scheduler.waitUntilIdle();
  assert.equal(store.getProject(id).steps.merge.state, 'review');
  assert.equal(store.getProject(id).runs.length, 3);
  scheduler.stop();
});

test('pause blocks only future starts and respects project concurrency limit', async () => {
  const id = makeProject('auto-pause-test');
  store.setExecutionPolicy(id, true, 1);
  const releases = new Map<string, (text: string) => void>();
  const scheduler = new LocalScheduler({
    id: 'pause-fixture',
    execute: task => new Promise(resolve => {
      releases.set(task.packet.workItemId, body => resolve({
        body, limitations: [], materialRequests: []
      }));
    })
  }, 2, message => { throw new Error(message); });
  scheduler.pulse();
  assert.equal(scheduler.activeCount, 1);
  assert.deepEqual([...releases.keys()], ['a']);
  store.setExecutionPolicy(id, false, 1);
  scheduler.pulse();
  assert.equal(scheduler.activeCount, 1);
  releases.get('a')!('Completed while paused');
  await scheduler.waitUntilIdle();
  assert.equal(store.getProject(id).steps.a.state, 'review');
  assert.equal(store.getProject(id).steps.b.state, 'ready');
  store.setExecutionPolicy(id, true, 1);
  scheduler.pulse();
  assert.equal(store.getProject(id).steps.b.state, 'running');
  releases.get('b')!('Resumed B candidate');
  await scheduler.waitUntilIdle();
  assert.equal(store.getProject(id).steps.b.state, 'review');
  scheduler.stop();
});

test('executor failure marks only its own WorkItem failed and does not duplicate a run', async () => {
  const id = makeProject('auto-failure-test');
  const failures: string[] = [];
  const scheduler = new LocalScheduler({
    id: 'failed-fixture',
    async execute(task) {
      if (task.packet.workItemId === 'a') throw new Error('Controlled failure');
      return { body: 'B candidate', limitations: [], materialRequests: [] };
    }
  }, 2, message => failures.push(message));
  scheduler.pulse();
  await scheduler.waitUntilIdle();
  assert.equal(store.getProject(id).steps.a.state, 'failed');
  assert.equal(store.getProject(id).steps.b.state, 'review');
  assert.equal(store.getProject(id).runs.length, 2);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Controlled failure/);
  scheduler.stop();
});

test('legacy projects with no policy do not silently begin paid model calls', async () => {
  const { executionPolicy } = await import('../src/core/runtime');
  const project = store.getProject(makeProject('legacy-safe-default-test'));
  delete project.execution;
  assert.deepEqual(executionPolicy(project), { autoDispatch: false, maxParallel: 2 });
  assert.throws(() => store.setExecutionPolicy(project.id, true, 0), /Invalid execution policy/);
  assert.throws(() => store.setExecutionPolicy(project.id, true, 6), /Invalid execution policy/);
});


test('human cancellation invalidates run, rejects late model output and requires explicit retry', async () => {
  const id = makeProject('cancel-late-output');
  store.setExecutionPolicy(id, true, 1);
  const releases = new Map<string, (text: string) => void>();
  const scheduler = new LocalScheduler({
    id: 'cancel-ignoring-signal-fixture',
    execute: task => new Promise(resolve => {
      releases.set(task.packet.workItemId, body => resolve({ body, limitations: [], materialRequests: [] }));
    })
  }, 2, () => undefined);

  scheduler.pulse();
  const before = store.getProject(id);
  assert.equal(before.steps.a.state, 'running');
  const runId = before.steps.a.runId;
  assert.ok(runId);
  const after = scheduler.cancel(id, 'a');
  assert.equal(after.steps.a.state, 'failed');
  assert.equal(after.runs.find(run => run.id === runId)?.status, 'failed');
  assert.equal(after.artifacts.filter(a => a.ownerId === 'a').length, 0);
  assert.throws(() => scheduler.cancel(id, 'a'), /Run identity changed|not owned/);

  // The executor ignores AbortSignal and returns late. It cannot mutate HH state.
  releases.get('a')!('This result arrived AFTER user cancellation');
  await scheduler.waitUntilIdle();
  assert.equal(store.getProject(id).artifacts.filter(a => a.ownerId === 'a').length, 0);
  assert.equal(store.getProject(id).runs.length, 1);
  store.setExecutionPolicy(id, false, 1);
  store.retryFailedAgent(id, 'a');
  assert.equal(store.getProject(id).steps.a.state, 'ready');
  scheduler.stop();
});

test('first local worker boot marks stranded runs as interrupted, never auto-replays them', async () => {
  const id = makeProject('orphaned-local-restart');
  const started = store.startAgent(id, 'a');
  assert.equal(store.getProject(id).steps.a.state, 'running');
  assert.equal(store.interruptOrphanedRuns(), 1);
  const saved = store.getProject(id);
  assert.equal(saved.steps.a.state, 'failed');
  assert.equal(saved.runs.find(run => run.id === started.runId)?.status, 'failed');
  assert.equal(saved.events.filter(e => e.type === 'run.interrupted' && e.subject === 'a').length, 1);
  assert.equal(store.interruptOrphanedRuns(), 0);
  assert.equal(saved.artifacts.filter(a => a.ownerId === 'a').length, 0);
});
