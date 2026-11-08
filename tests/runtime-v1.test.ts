import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageSchema } from '../src/protocol/v1';
import { manualProjectPackage } from '../src/protocol/manual';
import type { TaskExecutor } from '../src/executors/contracts';

const temp = mkdtempSync(join(tmpdir(), 'hh-v1-runtime-'));
process.env.HH_DATA_DIR = temp;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { executeOneAgentTask, configuredExecutorMode } = await import('../src/executors/runner');

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


test('expired Agent execution needs an explicit recovery action and can be retried', async () => {
  const { expireAbandonedRun, retryAgent } = await import('../src/core/runtime');
  const p = store.createProject('land-investigation', 'Recovery example');
  provideInput(p.id);
  const reserved = store.startAgent(p.id, 'inventory');
  assert.equal(reserved.project.steps.inventory.state, 'running');
  assert.throws(() => expireAbandonedRun(reserved.project, 'inventory'), /15-minute/);
  reserved.project.steps.inventory.startedAt = '2020-01-01T00:00:00.000Z';
  expireAbandonedRun(reserved.project, 'inventory', Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(reserved.project.steps.inventory.state, 'failed');
  assert.equal(reserved.project.runs.at(-1)?.status, 'failed');
  retryAgent(reserved.project, 'inventory');
  assert.equal(reserved.project.steps.inventory.state, 'ready');
});


test('the Mastra-facing packet is scoped and a forged run cannot commit output', () => {
  const p = store.createProject('land-investigation', 'Authorization example');
  provideInput(p.id);
  const reserved = store.startAgent(p.id, 'inventory');
  const packet = store.getTaskPacket(p.id, 'inventory', reserved.runId);
  assert.equal(packet.protocol, 'hh.task/1');
  assert.equal(packet.readableInputs.length, 3);
  assert.deepEqual(packet.toolsAllowed, []);
  assert.deepEqual(packet.readableInputs.map(x => x.role), ['case_evidence', 'case_evidence', 'case_evidence']);
  const forged = {
    protocol: 'hh.result/1', runId: 'another-run', workItemId: 'inventory',
    outcome: 'submitted_for_review',
    producedArtifacts: [{ artifactRef: 'forged-artifact' }], proposedActions: [], limitations: []
  };
  assert.throws(() => store.succeedAgent(p.id, 'inventory', reserved.runId, forged, 'Forged result'),
    /Run identity or state mismatch/);
  assert.equal(stepState(p.id, 'inventory'), 'running');
  store.markAgentFailed(p.id, 'inventory', reserved.runId, 'Test cleanup');
  assert.equal(stepState(p.id, 'inventory'), 'failed');
});


test('rejected material revisions never enter the Agent evidence packet', () => {
  const p = store.createProject('land-investigation', 'Material versioning example');
  const first = store.submitMaterial(p.id, 'project-identity', '无效的项目资料');
  const rejectedId = first.materials['project-identity'].artifactIds[0];
  store.reviewReceivedMaterial(p.id, 'project-identity', false, '不符合项目范围');
  const second = store.submitMaterial(p.id, 'project-identity', '经修正的项目资料及依据');
  const latestId = second.materials['project-identity'].artifactIds.at(-1);
  store.reviewReceivedMaterial(p.id, 'project-identity', true, '资料已核对');
  store.submitMaterial(p.id, 'boundary', '', { name: 'boundary.kml', buffer: Buffer.from('<kml/>') });
  store.reviewReceivedMaterial(p.id, 'boundary', true, '');
  store.submitMaterial(p.id, 'land-use', '用地用途资料');
  store.reviewReceivedMaterial(p.id, 'land-use', true, '');
  const reserved = store.startAgent(p.id, 'inventory');
  const refs = store.getTaskPacket(p.id, 'inventory', reserved.runId).readableInputs.map(i => i.artifactId);
  assert.equal(refs.includes(rejectedId), false);
  assert.equal(refs.includes(latestId!), true);
  assert.equal(refs.length, 3);
  store.markAgentFailed(p.id, 'inventory', reserved.runId, 'Test cleanup');
});


test('P0: executors receive only authorized evidence and do not own project state', async () => {
  const p = store.createProject('land-investigation', 'Executor scope example');
  provideInput(p.id);
  let calls = 0;
  const injected: TaskExecutor = {
    id: 'test-no-model',
    async execute(task) {
      calls++;
      assert.equal(task.packet.workItemId, 'inventory');
      assert.equal(task.packet.projectId, p.id);
      assert.equal(task.evidence.length, 3);
      assert.deepEqual(task.evidence.map(e => e.artifactId),
        task.packet.readableInputs.map(ref => ref.artifactId));
      assert.equal(task.evidence.some(e => 'filePath' in e), false);
      assert.equal('project' in task, false);
      assert.equal('decisions' in task, false);
      assert.equal(task.evidence.find(e => e.name === 'site.kml')?.content, '<kml xmlns="http://www.opengis.net/kml/2.2"/>');
      assert.equal(task.packet.toolsAllowed.length, 0);
      return { body: '模拟适配器产生的受限候选成果', limitations: [], materialRequests: [] };
    }
  };
  const run = await executeOneAgentTask(p.id, 'inventory', injected);
  assert.equal(calls, 1);
  assert.equal(run.project.steps.inventory.state, 'review');
  assert.equal(store.getProject(p.id).steps.inventory.state, 'review');
  assert.equal(store.latestOutput(store.getProject(p.id), 'inventory')?.content, '模拟适配器产生的受限候选成果');
  store.reviewAgentOutput(p.id, 'inventory', true, 'Human Todo accepts candidate');
  assert.equal(stepState(p.id, 'stage1-route'), 'ready');
});

test('P0: invalid executor output fails the run without committing an artifact', async () => {
  const p = store.createProject('land-investigation', 'Malformed adapter output');
  provideInput(p.id);
  const invalid: TaskExecutor = {
    id: 'test-invalid',
    async execute() {
      return {
        body: 'Looks successful',
        limitations: [],
        materialRequests: [],
        // Runtime rejects undeclared mutations, even if returned by an otherwise trusted adapter.
        changeProjectState: 'done'
      } as unknown as Awaited<ReturnType<TaskExecutor['execute']>>;
    }
  };
  const count = store.getProject(p.id).artifacts.length;
  await assert.rejects(() => executeOneAgentTask(p.id, 'inventory', invalid), /Unrecognized key/);
  assert.equal(store.getProject(p.id).artifacts.length, count);
  assert.equal(stepState(p.id, 'inventory'), 'failed');
  assert.equal(store.getProject(p.id).runs.at(-1)?.status, 'failed');
});

test('P0: an unconfigured executor fails before reserving a task', async () => {
  const p = store.createProject('land-investigation', 'No Codex fallback');
  provideInput(p.id);
  const before = store.getProject(p.id).runs.length;
  assert.equal(configuredExecutorMode('demo'), 'demo');
  assert.equal(configuredExecutorMode('mastra'), 'mastra');
  assert.throws(() => configuredExecutorMode('codex'), /Codex is not integrated yet/);
  const original = process.env.HH_EXECUTOR;
  try {
    process.env.HH_EXECUTOR = 'codex';
    await assert.rejects(() => executeOneAgentTask(p.id, 'inventory'), /Codex is not integrated yet/);
  } finally {
    process.env.HH_EXECUTOR = original;
  }
  assert.equal(store.getProject(p.id).runs.length, before);
  assert.equal(stepState(p.id, 'inventory'), 'ready');
});


test('P0 parallel contract: independent Agent jobs and Human Todo progress concurrently', async () => {
  const template = manualProjectPackage({
    id: 'parallel-research',
    title: '并行项目模板',
    description: '两个独立 Agent 工作与一项人工工作并行推进',
    inputs: '项目目标',
    objective: '整理已知材料'
  });
  const originalAgent = template.steps[0];
  const originalOutput = template.outputs[0];
  const makeAgent = (id: string, dependsOn: string[] = []) => ({
    ...originalAgent, id, title: id, dependsOn,
    outputContractId: 'out-' + id
  });
  const pkg = packageSchema.parse({
    ...template,
    steps: [
      makeAgent('agent-a'),
      makeAgent('agent-b'),
      {
        id: 'human-task', stageId: 'work', kind: 'human_action',
        title: '确认外部进度', instructions: '由用户自行确认',
        dependsOn: [], needsMaterials: []
      },
      makeAgent('merge', ['agent-a', 'agent-b', 'human-task'])
    ],
    outputs: ['agent-a', 'agent-b', 'merge'].map(id => ({
      ...originalOutput, id: 'out-' + id, fileName: id + '.md', producingStepId: id
    }))
  });
  store.importPackage(pkg);
  const p = store.createProject(pkg.id, 'Parallel orchestration example');
  assert.equal(stepState(p.id, 'human-task'), 'ready');
  store.submitMaterial(p.id, 'input-01', '已接受的项目初始信息');
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  assert.equal(stepState(p.id, 'agent-a'), 'ready');
  assert.equal(stepState(p.id, 'agent-b'), 'ready');
  assert.equal(stepState(p.id, 'merge'), 'blocked');

  const releases = new Map<string, (body: string) => void>();
  const deferred: TaskExecutor = {
    id: 'controlled-concurrent-test',
    async execute(task) {
      return new Promise(resolve => {
        releases.set(task.packet.workItemId, body => resolve({
          body, limitations: [], materialRequests: []
        }));
      });
    }
  };
  const first = executeOneAgentTask(p.id, 'agent-a', deferred);
  const second = executeOneAgentTask(p.id, 'agent-b', deferred);
  assert.equal(stepState(p.id, 'agent-a'), 'running');
  assert.equal(stepState(p.id, 'agent-b'), 'running');
  assert.equal(releases.size, 2);
  assert.equal(store.getProject(p.id).runs.filter(r => r.status === 'running').length, 2);
  await assert.rejects(
    () => executeOneAgentTask(p.id, 'agent-a', deferred),
    /not ready/
  );
  assert.equal(store.getProject(p.id).runs.length, 2);

  // The user can finish a separate Todo while both Agent tasks are still in flight.
  store.completeHuman(p.id, 'human-task', '外部事项完成，记录已核对');
  assert.equal(stepState(p.id, 'human-task'), 'done');
  assert.equal(stepState(p.id, 'agent-a'), 'running');
  assert.equal(stepState(p.id, 'agent-b'), 'running');

  // Independently completed work is persisted without completing its sibling.
  releases.get('agent-b')!('第二项并行任务成果');
  await second;
  assert.equal(stepState(p.id, 'agent-b'), 'review');
  assert.equal(stepState(p.id, 'agent-a'), 'running');
  store.reviewAgentOutput(p.id, 'agent-b', true, '用户认可第二项成果');
  assert.equal(stepState(p.id, 'merge'), 'blocked');

  releases.get('agent-a')!('第一项并行任务成果');
  await first;
  store.reviewAgentOutput(p.id, 'agent-a', true, '用户认可第一项成果');
  assert.equal(stepState(p.id, 'merge'), 'ready');
  assert.equal(store.getProject(p.id).events.filter(e => e.type === 'run.started').length, 2);
});
