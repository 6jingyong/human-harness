import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageSchema } from '../src/protocol/v1';
import { newProject } from '../src/core/runtime';
import { calculateProjectPlan, capturePlanBaseline, defaultPlan } from '../src/core/project-plan';
import { automaticWindowOpen, readyAgentSteps } from '../src/core/planning-work';
import { dayMinutes, dateMinute } from '../src/core/planning-calendar';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';

const dir = mkdtempSync(join(tmpdir(), 'hh-plan-'));
process.env.HH_DATA_DIR = dir;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { PUT } = await import('../src/app/api/v1/projects/[id]/plan/route');
const { LocalScheduler } = await import('../src/executors/scheduler');
const { executeOneAgentTask } = await import('../src/executors/runner');
after(() => rmSync(dir, { recursive: true, force: true }));

const json = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const land = packageSchema.parse(json('../project-templates/land-investigation/land-investigation.hh.json'));
const twoFiles = packageSchema.parse(json('../examples/document-handoff.hh.json'));
const parallel = packageSchema.parse(json('../examples/approved-conclusions-assembly.hh.json'));
const friday = new Date('2026-11-27T08:00:00Z');
const monday = new Date('2026-11-30T08:00:00Z');
const planProject = (pkg = twoFiles) => {
  const project = newProject(pkg, 'fixture', 'Planning fixture', 'hash');
  project.createdAt = friday.toISOString();
  return project;
};

test('a finite human workday spans business days, reviews consume time, and added resources change ETA', () => {
  const project = planProject();
  const settings = { ...defaultPlan(project, 'UTC'), humanMinutes: 60, due: '2026-11-30' };
  const forecast = calculateProjectPlan(project, settings, friday);
  const byKey = new Map(forecast.rows.map(row => [row.key, row]));
  const first = byKey.get('material:source-a')!;
  const second = byKey.get('material:source-b')!;
  const extract = byKey.get('step:extract')!;
  const review = byKey.get('review:extract')!;
  assert.equal(first.start, dateMinute('2026-11-27') + 540);
  assert.equal(second.start, dateMinute('2026-11-30') + 540);
  assert.ok(extract.start >= Math.max(first.finish, second.finish));
  assert.ok(review.start >= extract.finish);
  assert.ok(byKey.get('step:resolve')!.start >= review.finish);
  assert.equal(forecast.behindTarget, true);
  const moreCapacity = calculateProjectPlan(project, { ...settings, humanLanes: 2, humanMinutes: 180 }, friday);
  assert.ok(moreCapacity.finish! < forecast.finish!);
  assert.equal(moreCapacity.behindTarget, false);
  assert.equal(moreCapacity.remainingMinutes.human, forecast.remainingMinutes.human);
});

test('an estimated branch includes institutional time and gated evidence without changing the real Todo', () => {
  const project = planProject(land);
  const settings = { ...defaultPlan(project, 'Asia/Shanghai'), start: '2026-11-30' };
  const unresolved = calculateProjectPlan(project, settings, monday);
  assert.ok(unresolved.unresolvedDecisions.some(step => step.id === 'investigation-route'));
  assert.throws(() => capturePlanBaseline(project, settings, monday), /planning branches/);
  const preliminary = calculateProjectPlan(project, { ...settings, assumptions: { 'investigation-route': 'preliminary' } }, monday);
  assert.ok(preliminary.rows.some(row => row.key === 'review:report-preliminary'));
  assert.ok(!preliminary.rows.some(row => row.pool === 'external'));
  const full = calculateProjectPlan(project, { ...settings, assumptions: { 'investigation-route': 'sampling' } }, monday);
  assert.equal(full.unresolvedDecisions.length, 0);
  const milestone = full.rows.find(row => row.key === 'step:lab-work-complete')!;
  assert.equal(milestone.pool, 'external');
  assert.equal(milestone.segments.reduce((sum, part) => sum + part.finish - part.start, 0), 2400);
  assert.ok(full.rows.find(row => row.key === 'material:detection-report')!.start >= milestone.finish);
  assert.ok(full.rows.some(row => row.key === 'review:report-complete'));
  assert.equal(project.materials['detection-report'].state, 'dormant');
  assert.ok(!deriveWorkbenchQueues(project).human.some(item => item.id === 'detection-report'));
});

test('baseline dates stay fixed and surface an overdue user-owned task', () => {
  const project = planProject();
  const settings = { ...defaultPlan(project, 'UTC'), taskDueDates: { 'material:source-a': '2026-11-27' } };
  const baseline = capturePlanBaseline(project, settings, friday);
  const report = calculateProjectPlan(project, settings, monday, baseline);
  const overdue = report.attention.find(row => row.key === 'material:source-a')!;
  assert.ok(overdue.overdue && overdue.missesTaskDue);
  assert.equal(overdue.todoKey, 'material:source-a');
  assert.ok(overdue.start - baseline.tasks[overdue.key].start >= 3 * dayMinutes);
  assert.equal(calculateProjectPlan(project, settings, monday, baseline).finish, report.finish);
});

test('actual Agent runtime timestamps and the remaining review are shown separately', async () => {
  const project = store.createProject('document-handoff', 'Actual fixture');
  store.setExecutionPolicy(project.id, false, 1);
  for (const key of ['source-a', 'source-b']) {
    store.submitMaterial(project.id, key, '', { name: key + '.txt', buffer: Buffer.from('Fixture') });
    store.reviewReceivedMaterial(project.id, key, true, '');
  }
  await executeOneAgentTask(project.id, 'extract');
  const state = store.getProject(project.id);
  const plan = calculateProjectPlan(state, defaultPlan(state, 'UTC'), new Date());
  const work = plan.rows.find(row => row.key === 'step:extract')!;
  const review = plan.rows.find(row => row.key === 'review:extract')!;
  assert.ok(work.startedAt && work.completedAt);
  assert.equal(work.status, 'done');
  assert.equal(review.status, 'ready');
  assert.ok(review.dependencies.includes(work.key));
});

test('saving a plan validates task keys, pins the baseline, and rejects stale edits', async () => {
  const project = store.createProject('document-handoff', 'Plan route');
  store.setExecutionPolicy(project.id, false, 2);
  const settings = defaultPlan(project, 'Asia/Shanghai');
  const put = (revision: number, plan: unknown, freeze = false) => PUT(new Request('http://localhost', {
    method: 'PUT', body: JSON.stringify({ revision, settings: plan, freeze })
  }), { params: Promise.resolve({ id: project.id }) });
  assert.equal((await put(0, { ...settings, expedited: ['step:unknown'] })).status, 400);
  assert.equal((await put(0, { ...settings, humanMinutes: 34 })).status, 400);
  const saved = await put(0, settings, true);
  assert.equal(saved.status, 200);
  assert.equal((await put(0, settings)).status, 409);
  const updated = await put(1, { ...settings, humanMinutes: 180 });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).planning.baseline, (await saved.json()).planning.baseline);
  assert.equal(store.getProject(project.id).planning?.revision, 2);
});

test('expediting a review prioritizes its prerequisite in the real Agent dispatch order', async () => {
  store.importPackage(parallel);
  const project = store.createProject(parallel.id, 'Agent priority fixture');
  store.setExecutionPolicy(project.id, false, 1);
  for (const material of parallel.materials) {
    store.submitMaterial(project.id, material.id, '', { name: 'source.txt', buffer: Buffer.from('Sample') });
    store.reviewReceivedMaterial(project.id, material.id, true, '');
  }
  const settings = { ...defaultPlan(project, 'UTC'), expedited: ['review:analyze-b'] };
  const saved = store.saveProjectPlan(project.id, 0, settings, false);
  assert.equal(readyAgentSteps(saved)[0]?.id, 'analyze-b');
  const constrained = { ...saved, planning: { ...saved.planning!, settings: { ...settings, restrictAgentStarts: true, start: '2026-11-27' } } };
  assert.equal(automaticWindowOpen(constrained, friday), false);
  assert.equal(automaticWindowOpen(constrained, new Date('2026-11-27T10:00:00Z')), true);
  assert.equal(automaticWindowOpen(constrained, new Date('2026-11-28T10:00:00Z')), false);

  const started: string[] = [];
  const scheduler = new LocalScheduler({
    id: 'plan-order-fixture',
    async execute(task) {
      started.push(task.packet.workItemId);
      return { body: 'Synthetic output', limitations: [], materialRequests: [] };
    }
  }, 1);
  store.setExecutionPolicy(project.id, true, 1);
  scheduler.pulse();
  await scheduler.waitUntilIdle();
  scheduler.stop();
  assert.equal(started[0], 'analyze-b');
});
