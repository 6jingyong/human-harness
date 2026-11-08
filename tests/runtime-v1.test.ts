import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageSchema } from '../src/protocol/v1';
import { manualProjectPackage } from '../src/protocol/manual';

const temp = mkdtempSync(join(tmpdir(), 'hh-v1-runtime-'));
process.env.HH_DATA_DIR = temp;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/mastra');

after(() => {
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* db handle on Windows */ }
});

const matState = (id: string, material: string) => store.getProject(id).materials[material].state;
const stepState = (id: string, step: string) => store.getProject(id).steps[step].state;

function provideInput(projectId: string) {
  for (const [materialId, content] of [
    ['project-identity', '某地块土地污染调查，委托信息及调查范围'],
    ['boundary', '原始红线暂以文字说明代替，仅为开发测试'],
    ['land-use', '规划用途依据：内部测试资料']
  ]) {
    if (materialId === 'boundary') {
      store.submitMaterial(projectId, materialId, '', { name: 'site.kml', buffer: Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"/>') });
    } else {
      store.submitMaterial(projectId, materialId, content);
    }
    assert.equal(matState(projectId, materialId), 'received');
    assert.equal(stepState(projectId, 'inventory'), 'blocked');
    store.reviewReceivedMaterial(projectId, materialId, true, 'Test acceptance');
    assert.equal(matState(projectId, materialId), 'accepted');
  }
  assert.equal(stepState(projectId, 'inventory'), 'ready');
}
async function approveInventory(id: string) {
  const run = await executeOneAgentTask(id, 'inventory');
  assert.equal(run.executedStepId, 'inventory');
  assert.equal(stepState(id, 'inventory'), 'review');
  const output = store.latestOutput(store.getProject(id), 'inventory');
  assert.match(output?.content ?? '', /演示结果/);
  assert.equal(store.getProject(id).runs.at(-1)?.result?.protocol, 'hh.result/1');
  store.reviewAgentOutput(id, 'inventory', true, 'Test');
  assert.equal(stepState(id, 'stage1-route'), 'ready');
}
test('canonical v1 keeps future QC off the current TodoList and exits at stage one', async () => {
  const p = store.createProject('land-investigation', 'First stage example');
  assert.equal(p.package.protocol, 'hh.package/1');
  assert.match(p.packageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(matState(p.id, 'qc-evidence'), 'dormant');
  assert.throws(() => store.submitMaterial(p.id, 'boundary', '只有描述，没有原始文件'), /original file/);
  assert.equal(stepState(p.id, 'sampling-plan'), 'dormant');
  provideInput(p.id);
  await approveInventory(p.id);
  assert.throws(() => store.completeHuman(p.id, 'stage1-route', 'made-up'), /declared option/);
  store.completeHuman(p.id, 'stage1-route', 'finish');
  assert.equal(matState(p.id, 'qc-evidence'), 'not_applicable');
  assert.equal(stepState(p.id, 'sampling-plan'), 'not_applicable');
  assert.equal(stepState(p.id, 'first-stage-draft'), 'ready');
  await executeOneAgentTask(p.id, 'first-stage-draft');
  store.reviewAgentOutput(p.id, 'first-stage-draft', true, '');
  assert.equal(stepState(p.id, 'first-stage-draft'), 'done');
  assert.equal(store.getProject(p.id).events.filter(e => e.type === 'decision.approved').length, 1);
});

test('canonical v1 only requests QC evidence after real institution milestone is confirmed', async () => {
  const p = store.createProject('land-investigation', 'Sampling example');
  provideInput(p.id);
  await approveInventory(p.id);
  store.completeHuman(p.id, 'stage1-route', 'sampling');
  assert.equal(stepState(p.id, 'first-stage-draft'), 'not_applicable');
  assert.equal(stepState(p.id, 'sampling-plan'), 'ready');
  assert.equal(matState(p.id, 'qc-evidence'), 'expected');
  await executeOneAgentTask(p.id, 'sampling-plan');
  store.reviewAgentOutput(p.id, 'sampling-plan', true, '');
  assert.equal(stepState(p.id, 'plan-approved'), 'ready');
  store.completeHuman(p.id, 'plan-approved', '专业审核，采样点位置与深度已确认（示例收据）');
  assert.equal(stepState(p.id, 'commission'), 'ready');
  store.completeHuman(p.id, 'commission', '按冻结方案委托专业机构（示例）');
  assert.equal(matState(p.id, 'qc-evidence'), 'expected');
  assert.equal(stepState(p.id, 'lab-work-complete'), 'ready');
  store.completeHuman(p.id, 'lab-work-complete', '真实机构已完成采样与实验室工作（模拟测试输入）');
  assert.equal(matState(p.id, 'qc-evidence'), 'requested');
  assert.equal(matState(p.id, 'detection-report'), 'requested');
  for (const material of ['field-records', 'detection-report', 'qc-evidence']) {
    store.submitMaterial(p.id, material, '模拟测试资料，绝非真实检测记录');
    assert.equal(matState(p.id, material), 'received');
    assert.equal(stepState(p.id, 'qc-review'), 'blocked');
    store.reviewReceivedMaterial(p.id, material, true, '');
    assert.equal(matState(p.id, material), 'accepted');
  }
  assert.equal(stepState(p.id, 'qc-review'), 'ready');
  const run = await executeOneAgentTask(p.id, 'qc-review');
  assert.equal(store.getProject(p.id).runs.find(r => r.id === run.runId)?.status, 'review');
});

test('manual package creation is strict, executable and keeps snapshots intact', async () => {
  const template = manualProjectPackage({
    id: 'custom-investigation', title: '自建调查', description: '手动创建项目类型',
    inputs: '调查目标\n文件:原始证据', objective: '根据资料产生内部审查稿'
  });
  assert.equal(packageSchema.parse(template).protocol, 'hh.package/1');
  assert.equal(template.materials.length, 2);
  store.importPackage(template);
  const p = store.createProject('custom-investigation', '自建测试项目');
  assert.equal(matState(p.id, 'input-01'), 'requested');
  assert.equal(stepState(p.id, 'draft'), 'blocked');
  store.submitMaterial(p.id, 'input-01', '项目目标是演示');
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  store.submitMaterial(p.id, 'input-02', '', { name: 'source.txt', buffer: Buffer.from('某份原始资料') });
  store.reviewReceivedMaterial(p.id, 'input-02', true, '');
  assert.equal(stepState(p.id, 'draft'), 'ready');
  await executeOneAgentTask(p.id, 'draft');
  assert.equal(stepState(p.id, 'draft'), 'review');
  store.reviewAgentOutput(p.id, 'draft', false, '请明确区分事实与假设');
  assert.equal(stepState(p.id, 'draft'), 'ready');
  await executeOneAgentTask(p.id, 'draft');
  store.reviewAgentOutput(p.id, 'draft', true, '');
  assert.equal(store.getProject(p.id).artifacts.filter(a => a.ownerId === 'draft').length, 2);
  assert.equal(stepState(p.id, 'draft'), 'done');
  const stored = store.getProject(p.id);
  assert.equal(stored.packageDigest, p.packageDigest);
  assert.throws(() => store.importPackage(template), /already exists/);
});

test('LLM results cannot directly mutate the work ledger', () => {
  const pkg = store.getPackage('land-investigation');
  const p = store.createProject(pkg.id, 'Unauthorized output');
  assert.equal(stepState(p.id, 'inventory'), 'blocked');
  assert.equal(store.getProject(p.id).decisions['stage1-route'], undefined);
  assert.equal(packageSchema.safeParse({ ...pkg, schemaVersion: 3 }).success, false);
});
