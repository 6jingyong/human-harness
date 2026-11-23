import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageSchema } from '../src/protocol/v1';
import { coordinationOverview, formatLatestStart } from '../src/core/project-coordination';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';
import { calculateProjectPlan, defaultPlan } from '../src/core/project-plan';

const directory = mkdtempSync(join(tmpdir(), 'hh-coordination-'));
process.env.HH_DATA_DIR = directory;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { PUT } = await import('../src/app/api/v1/projects/[id]/requirements/route');
const template = packageSchema.parse(JSON.parse(readFileSync(
  new URL('../project-templates/land-investigation/land-investigation.hh.json', import.meta.url), 'utf8')));
store.importPackage(template);
after(() => rmSync(directory, { recursive: true, force: true }));

const create = () => {
  const project = store.createProject(template.id, 'Coordination fixture');
  store.setExecutionPolicy(project.id, false, 1);
  return project.id;
};
const requirements = {
  'land-survey': { due: '2026-11-27', brief: '按红线范围验收测绘成果' },
  'government-archive': { due: '2026-11-27', brief: '取政府留存的既有报告' }
};
const select = (projectId: string) =>
  store.saveProjectCoordination(projectId, 0, { timeZone: 'Asia/Shanghai', requirements });
const tasks = (id: string, asOf?: Date) => {
  const queues = deriveWorkbenchQueues(store.getProject(id), asOf);
  return [...queues.human, ...queues.external];
};
function accept(id: string, material: string, filename = 'source.txt') {
  store.submitMaterial(id, material, '', { name: filename, buffer: Buffer.from('Synthetic fixture') });
  store.reviewReceivedMaterial(id, material, true, 'Synthetic fixture');
}

test('requirements activate independent procurement and authority Todos, with contact dates worked backward', () => {
  const id = create();
  assert.ok(!tasks(id).some(row => row.id === 'survey-contact' || row.id === 'archive-access'));
  const project = select(id);
  const asOf = new Date('2026-11-23T01:00:00Z');
  const overview = coordinationOverview(project, asOf);
  assert.equal(formatLatestStart(overview.timings.get('step:survey-contact')!.latestStart), '2026-11-25 09:00');
  assert.equal(formatLatestStart(overview.timings.get('step:archive-access')!.latestStart), '2026-11-23 10:30');
  const human = deriveWorkbenchQueues(project, asOf).human;
  assert.equal(human[0].id, 'project-identity');
  assert.ok(human.findIndex(row => row.id === 'archive-access') < human.findIndex(row => row.id === 'survey-contact'));
  assert.ok(human.some(row => row.id === 'survey-contact'));
  assert.ok(!human.some(row => row.id === 'survey-result' || row.id === 'archive-apply'));
  assert.equal(project.steps['investigation-route'].state, 'blocked');
  assert.throws(() => store.completeHuman(id, 'survey-book', 'Skipped real contact'), /not actionable/);
});

test('external promises and follow-up stay in the original Todo until actual return and evidence acceptance', () => {
  const id = create();
  select(id);
  accept(id, 'project-identity');
  accept(id, 'boundary', 'boundary.geojson');
  accept(id, 'land-use');
  accept(id, 'desk-records');
  assert.equal(store.getProject(id).steps['extract-project'].state, 'blocked');
  assert.equal(store.getProject(id).steps['extract-history'].state, 'blocked');

  store.completeHuman(id, 'survey-contact', '联系示例单位并取得报价');
  store.completeHuman(id, 'survey-book', '交接编号 S-1', '2026-11-27');
  assert.equal(store.getProject(id).materials['survey-result'].state, 'expected');
  let task = tasks(id).find(row => row.id === 'survey-return')!;
  assert.equal(task.followUp?.promisedOn, '2026-11-27');
  assert.equal(task.followUp?.dueOn, '2026-11-27');
  assert.ok(deriveWorkbenchQueues(store.getProject(id), new Date('2026-11-26T04:00:00Z')).external
    .some(row => row.id === 'survey-return'));
  assert.ok(deriveWorkbenchQueues(store.getProject(id), new Date('2026-11-27T04:00:00Z')).human
    .some(row => row.id === 'survey-return' && row.followUp?.due));
  store.recordWorkOrderFollowUp(id, 'survey-return', '对方确认仍在处理', '2026-11-30');
  assert.equal(store.getProject(id).steps['survey-return'].state, 'ready');
  assert.equal(store.getProject(id).materials['survey-result'].state, 'expected');
  task = tasks(id).find(row => row.id === 'survey-return')!;
  assert.equal(task.followUp?.promisedOn, '2026-11-30');
  assert.equal(task.followUp?.lastUpdate, '对方确认仍在处理');
  assert.ok(coordinationOverview(store.getProject(id), new Date()).orderStatus.get('land-survey')?.atRisk);
  store.completeHuman(id, 'survey-return', '实际收到编号 S-2 的成果');
  assert.equal(store.getProject(id).materials['survey-result'].state, 'requested');
  assert.throws(() => store.recordWorkOrderFollowUp(id, 'survey-return', '不该再催办'), /无需跟进/);
  store.submitMaterial(id, 'survey-result', '', { name: 'survey.geojson', buffer: Buffer.from('{}') });
  assert.equal(store.getProject(id).steps['extract-project'].state, 'blocked');
  store.reviewReceivedMaterial(id, 'survey-result', true, 'Synthetic approval');
  const work = store.startAgent(id, 'extract-project');
  assert.ok(store.getTaskPacket(id, work.stepId, work.runId).readableInputs.some(input =>
    store.getProject(id).artifacts.find(artifact => artifact.id === input.artifactId)?.ownerId === 'survey-result'));
  assert.equal(store.getProject(id).steps['extract-history'].state, 'blocked');
  assert.equal(coordinationOverview(store.getProject(id), new Date()).orderStatus.get('land-survey')?.done, true);
  store.completeHuman(id, 'archive-access', '确认受理机关');
  store.completeHuman(id, 'archive-apply', '本人已办理，受理编号 G-1');
  assert.equal(store.getProject(id).materials['government-record'].state, 'expected');
  store.completeHuman(id, 'archive-return', '已取得政府档案回件');
  accept(id, 'government-record', 'government.pdf');
  assert.equal(store.getProject(id).steps['extract-history'].state, 'ready');
});

test('an updated external promise moves the acceptance, dependent work and projected completion', () => {
  const id = create();
  store.saveProjectCoordination(id, 0, { timeZone: 'Asia/Shanghai', requirements: {
    'land-survey': { due: '2026-12-01', brief: '' }
  } });
  accept(id, 'project-identity');
  store.completeHuman(id, 'survey-contact', '模拟约定档期');
  store.completeHuman(id, 'survey-book', '模拟确认委托', '2026-11-27');
  const asOf = new Date('2026-11-23T06:20:00Z');
  const settings = { ...defaultPlan({ createdAt: asOf.toISOString() }, 'Asia/Shanghai'),
    assumptions: { 'investigation-route': 'preliminary' }, due: '2026-12-09' };
  const plan = () => calculateProjectPlan(store.getProject(id), settings, asOf);
  const row = (key: string, forecast = plan()) => forecast.rows.find(task => task.key === key)!;
  const before = plan();
  assert.equal(formatLatestStart(row('step:survey-return', before).finish), '2026-11-27 23:59');
  store.recordWorkOrderFollowUp(id, 'survey-return', '机构延迟交付', '2026-12-15');
  const after = plan();
  assert.equal(formatLatestStart(row('step:survey-return', after).finish), '2026-12-15 23:59');
  assert.equal(row('material:survey-result', after).missesTaskDue, true);
  assert.ok(row('step:extract-project', after).start > row('step:extract-project', before).start);
  assert.ok(after.finish! > before.finish!);
  assert.equal(after.behindTarget, true);
  assert.equal(after.remainingMinutes.external, before.remainingMinutes.external);
  assert.equal(coordinationOverview(store.getProject(id), asOf).orderStatus.get('land-survey')?.atRisk, true);
  assert.equal(store.getProject(id).materials['survey-result'].state, 'expected');

  store.completeHuman(id, 'survey-return', '机构提前交付，核实已取得成果');
  const received = row('step:survey-return');
  assert.equal(received.status, 'done');
  assert.equal(received.promisedOn, undefined);
  assert.ok(received.finish < row('step:survey-return', after).finish);
});

test('a live consumer prevents a scope change and the requirements API rejects stale writes', async () => {
  const id = create();
  for (const material of ['project-identity', 'boundary', 'land-use']) accept(id, material);
  const live = store.startAgent(id, 'extract-project');
  const put = (revision: number) => PUT(new Request('http://localhost', {
    method: 'PUT', body: JSON.stringify({ revision, settings: { timeZone: 'Asia/Shanghai', requirements } })
  }), { params: Promise.resolve({ id }) });
  assert.equal((await put(0)).status, 409);
  assert.equal(store.getProject(id).coordination, undefined);
  store.markAgentFailed(id, live.stepId, live.runId, 'Synthetic stopped run');
  assert.equal((await put(0)).status, 200);
  assert.equal((await put(0)).status, 409);
  assert.equal(store.getProject(id).steps['extract-project'].state, 'blocked');
  assert.equal(store.getProject(id).planning, undefined);
});

test('template rejects a circular order gate and undeclared optional work', () => {
  const copy = structuredClone(template);
  copy.workOrders![0].consumers.push('survey-contact');
  assert.equal(packageSchema.safeParse(copy).success, false);
  const another = structuredClone(template);
  const contact = another.steps.find(step => step.id === 'survey-contact')!;
  contact.when = { type: 'work_order', orderId: 'missing' };
  assert.equal(packageSchema.safeParse(another).success, false);
});

test('enabling a new requirement reopens only its consumers and preserves independent approved work', async () => {
  const id = create();
  const { executeOneAgentTask } = await import('../src/executors/runner');
  for (const material of ['project-identity', 'boundary', 'land-use', 'site-visit']) accept(id, material);
  for (const step of ['extract-project', 'extract-visit']) {
    await executeOneAgentTask(id, step);
    store.reviewAgentOutput(id, step, true, 'Synthetic approval');
  }
  const before = store.getProject(id);
  const changed = store.saveProjectCoordination(id, 0, {
    timeZone: 'Asia/Shanghai', requirements: { 'land-survey': requirements['land-survey'] }
  });
  assert.equal(changed.steps['extract-project'].state, 'blocked');
  assert.equal(changed.steps['extract-visit'].state, 'done');
  assert.equal(changed.steps['extract-visit'].approvedArtifactId, before.steps['extract-visit'].approvedArtifactId);
  assert.ok(changed.artifacts.find(artifact => artifact.id === before.steps['extract-project'].approvedArtifactId)?.invalidatedAt);
  assert.equal(changed.materials['government-record'].state, 'not_applicable');
});
