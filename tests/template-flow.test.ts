import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';
import { calculateProjectPlan, defaultPlan } from '../src/core/project-plan';
import { manualProjectPackage } from '../src/protocol/manual';
import { addFlowTask, removeFlowTask, templateFlow } from '../src/protocol/template-flow';
import { packageSchema } from '../src/protocol/v1';
import { templateDeliverables } from '../src/protocol/project-launch';

const data = mkdtempSync(join(tmpdir(), 'hh-visual-template-'));
process.env.HH_DATA_DIR = data;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
after(() => rmSync(data, { recursive: true, force: true }));

test('land investigation projects onto the two lanes with review, route and return gates intact', () => {
  const land = packageSchema.parse(JSON.parse(readFileSync(
    new URL('../project-templates/land-investigation/land-investigation.hh.json', import.meta.url), 'utf8')));
  const before = structuredClone(land);
  const flow = templateFlow(land);
  const node = (key: string) => flow.nodes.get(key)!;
  const linked = (from: string, to: string) => flow.incoming.get(to)?.find(edge => edge.from === from);
  for (const key of ['step:survey-contact', 'step:archive-apply', 'step:investigation-route',
    'step:lab-work-complete', 'review:extract-project', 'review:report-preliminary', 'material:detection-report']) {
    assert.equal(node(key).lane, 'human', key);
  }
  assert.equal(node('step:extract-project').lane, 'machine');
  assert.equal(node('step:report-preliminary').kind, 'script');
  assert.equal(linked('step:extract-project', 'review:extract-project')?.rule, 'review');
  assert.ok(flow.outgoing.get('review:extract-project')?.some(link => link.rule === 'dependency'));
  assert.match(linked('step:investigation-route', 'step:report-preliminary')?.label ?? '', /第一阶段结题/);
  assert.equal(linked('step:lab-work-complete', 'material:detection-report')?.rule, 'condition');
  assert.equal(linked('material:survey-result', 'step:extract-project')?.workOrderId, 'land-survey');
  assert.ok(node('step:archive-apply').depth < node('material:government-record').depth);
  assert.deepEqual(land, before);
  assert.throws(() => removeFlowTask(land, node('step:lab-work-complete')), /仍被其他任务/);
});

test('a different template activates only authored Human Todos and respects review and follow-up timing', async context => {
  const now = new Date('2026-11-23T01:00:00Z');
  context.mock.timers.enable({ apis: ['Date'], now });
  const initial = manualProjectPackage({
    id: 'exhibition-content', title: '展览文案', description: '制作有来源的展览文案',
    inputs: '展品说明', objective: '根据馆方核验的资料撰写展览文案'
  });
  const { pkg } = addFlowTask(addFlowTask(initial, 'human_decision', 'intake').pkg, 'order', 'intake');
  const decision = pkg.steps.find(step => step.kind === 'human_decision')!;
  decision.title = '选择是否进入撰稿';
  const draft = pkg.steps.find(step => step.id === 'draft')!;
  draft.when = { type: 'decision', stepId: decision.id, option: decision.options![1].id };
  const order = pkg.workOrders![0];
  order.consumers = [draft.id];
  order.title = '征询图片授权';
  order.followUp!.workingDays = 2;
  const returnId = order.followUp!.milestoneId;
  const submitId = pkg.steps.find(step => step.id === returnId)!.dependsOn[0];
  const contactId = pkg.steps.find(step => step.id === submitId)!.dependsOn[0];
  const materialId = order.deliverables[0];
  const delivery = addFlowTask(pkg, 'human_action', 'work');
  const deliveryId = delivery.key.split(':')[1];
  delivery.pkg.steps.find(step => step.id === deliveryId)!.dependsOn = [draft.id];
  store.importPackage(delivery.pkg);
  const planning = { ...defaultPlan({ createdAt: now.toISOString() }, 'Asia/Shanghai'), due: '2026-12-04' };
  const disabled = store.createProject(pkg.id, '未启用外部事项', { planning, requirements: {} });
  const id = store.createProject(pkg.id, '需要取得图片许可', {
    planning, requirements: { [order.id]: { due: '2026-11-30', brief: '取得馆方书面许可' } }
  }).id;
  const queues = (at = now) => deriveWorkbenchQueues(store.getProject(id), at);
  const humanHas = (key: string) => queues().human.some(item => item.id === key);
  assert.ok(!deriveWorkbenchQueues(disabled, now).human.some(item => item.id === contactId));
  assert.equal(store.completeHuman(disabled.id, decision.id, decision.options![0].id).steps[draft.id].state, 'not_applicable');
  assert.ok(humanHas(contactId) && humanHas(decision.id));
  assert.ok(!humanHas(returnId) && !humanHas(materialId) && !humanHas(deliveryId));
  assert.throws(() => store.startAgent(id, contactId), /not ready/);
  const timing = queues().human.find(item => item.id === contactId)?.timing;
  assert.equal(timing?.orderId, order.id);
  store.completeHuman(id, decision.id, decision.options![1].id);
  store.completeHuman(id, contactId, '示例联系记录');
  store.completeHuman(id, submitId, '示例受理凭据');
  assert.ok(!humanHas(returnId));
  assert.equal(queues().external.find(item => item.id === returnId)?.followUp?.dueOn, '2026-11-25');
  assert.ok(queues(new Date('2026-11-25T04:00:00Z')).human.some(item => item.id === returnId));
  assert.ok(!humanHas(materialId));
  store.completeHuman(id, returnId, '示例书面许可已到');
  assert.ok(humanHas(materialId));
  for (const idOfMaterial of [initial.materials[0].id, materialId]) {
    store.submitMaterial(id, idOfMaterial, '用于流程验收的示例资料');
    assert.equal(store.getProject(id).steps[draft.id].state, 'blocked');
    store.reviewReceivedMaterial(id, idOfMaterial, true, '验收示例');
  }
  const { rows } = calculateProjectPlan(store.getProject(id), planning, now);
  assert.deepEqual(rows.find(row => row.key === delivery.key)?.dependencies, ['review:' + draft.id]);
  assert.equal(rows.find(row => row.key === 'step:' + returnId)?.pool, 'external');
  await executeOneAgentTask(id, draft.id);
  assert.ok(humanHas(draft.id) && !humanHas(deliveryId));
  store.reviewAgentOutput(id, draft.id, true, '验收示例成果');
  assert.ok(humanHas(deliveryId));
});

test('an all-human workflow starts without a placeholder AI task or deliverable', () => {
  const starter = manualProjectPackage({
    id: 'human-only-check', title: '现场核对', description: '人工确认现场事项',
    inputs: '交接清单', objective: '校验交接清单'
  });
  const { pkg, key } = addFlowTask(starter, 'human_action', 'intake');
  const automatic = templateFlow(pkg).nodes.get('step:draft')!;
  const humanOnly = removeFlowTask(pkg, automatic);
  assert.equal(humanOnly.outputs.length, 0);
  store.importPackage(humanOnly);
  const project = store.createProject(pkg.id, '现场人工核对');
  const queue = deriveWorkbenchQueues(project);
  assert.equal(queue.agent.length, 0);
  assert.ok(queue.human.some(item => item.key === key));
  assert.equal(templateFlow(project.package).nodes.size, 2);
});

test('explicitly removing a terminal draft from delivery preserves its review', () => {
  const draft = manualProjectPackage({
    id: 'internal-only-output', title: '内部分析', description: '发布前由经办人核对',
    inputs: '内部资料', objective: '生成内部分析'
  });
  assert.equal(templateDeliverables(draft).length, 1);
  draft.outputs[0].deliverable = false;
  const validated = packageSchema.parse(draft);
  assert.equal(templateDeliverables(validated).length, 0);
  assert.ok(templateFlow(validated).nodes.has('review:draft'));
});
