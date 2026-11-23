import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskExecutor } from '../src/executors/contracts';
import { manualProjectPackage } from '../src/protocol/manual';
import { packageSchema } from '../src/protocol/v1';

const folder = mkdtempSync(join(tmpdir(), 'hh-source-version-'));
process.env.HH_DATA_DIR = folder;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { deriveWorkbenchQueues } = await import('../src/app/workbench-queue');
const { GET: downloadOutput } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* Windows */ } });

function makeParallelProject(label: string) {
  const base = manualProjectPackage({
    id: label, title: label, description: 'Independent source branches',
    inputs: 'Evidence A\nEvidence B',
    objective: 'Produce a reviewed proposal'
  });
  const sample = base.steps[0];
  const output = base.outputs[0];
  const makeAgent = (id: string, needsMaterials: string[], dependsOn: string[]) =>
    ({ ...sample, id, needsMaterials, dependsOn, outputContractId: id + '-output' });
  const pkg = packageSchema.parse({
    ...base, steps: [
      makeAgent('a', ['input-01'], []),
      makeAgent('b', ['input-02'], []),
      makeAgent('merge', [], ['a', 'b'])
    ],
    outputs: ['a', 'b', 'merge'].map(id => ({
      ...output, id: id + '-output', producingStepId: id, fileName: id + '.md'
    }))
  });
  store.importPackage(pkg);
  const p = store.createProject(pkg.id, 'Independent branches');
  store.setExecutionPolicy(p.id, false, 2);
  for (const id of ['input-01', 'input-02']) {
    store.submitMaterial(p.id, id, id + ' originally accepted');
    store.reviewReceivedMaterial(p.id, id, true, '');
  }
  return p.id;
}

const executor = (title: string): TaskExecutor => ({
  id: 'source-proposal-' + title,
  async execute(task) {
    return { body: title + ' reviewed proposal for ' +
      task.evidence.map(e => e.name + '#' + e.revision).join(', '),
      limitations: [], materialRequests: [] };
  }
});

async function approve(id: string, stepId: string) {
  await executeOneAgentTask(id, stepId, executor(stepId));
  store.reviewAgentOutput(id, stepId, true, 'Approved in controlled test');
}

const exportArtifact = (id: string, artifactId: string) => downloadOutput(
  new Request('http://localhost/source-export'),
  { params: Promise.resolve({ id, artifactId }) }
);

test('replacement is a review-gated revision; only source-dependent and downstream work is invalidated', async () => {
  const id = makeParallelProject('source-invalidation-branches');
  await approve(id, 'a'); await approve(id, 'b'); await approve(id, 'merge');
  const original = store.getProject(id);
  const oldA = original.artifacts.find(a => a.kind === 'agent_output' && a.ownerId === 'a')!;
  const oldB = original.artifacts.find(a => a.kind === 'agent_output' && a.ownerId === 'b')!;
  const oldMerged = original.artifacts.find(a => a.kind === 'agent_output' && a.ownerId === 'merge')!;
  const oldSourceId = original.materials['input-01'].acceptedArtifactId;
  assert.ok(oldSourceId);

  store.submitMaterial(id, 'input-01', 'Replacement source from 2026-11', undefined, { replaceAccepted: true });
  const received = store.getProject(id);
  assert.equal(received.materials['input-01'].state, 'received');
  assert.equal(received.materials['input-01'].acceptedArtifactId, oldSourceId);
  assert.equal(received.steps.a.state, 'done', 'unapproved replacement cannot invalidate output');
  assert.equal(received.steps.merge.state, 'done');
  store.reviewReceivedMaterial(id, 'input-01', true, 'New edition accepted');
  const updated = store.getProject(id);
  assert.equal(updated.materials['input-01'].state, 'accepted');
  assert.notEqual(updated.materials['input-01'].acceptedArtifactId, oldSourceId);
  assert.equal(updated.steps.a.state, 'ready');
  assert.equal(updated.steps.merge.state, 'blocked');
  assert.equal(updated.steps.b.state, 'done', 'independent branch remains reviewed');
  assert.ok(updated.artifacts.find(a => a.id === oldA.id)?.invalidatedAt);
  assert.ok(updated.artifacts.find(a => a.id === oldMerged.id)?.invalidatedAt);
  assert.equal(updated.artifacts.find(a => a.id === oldB.id)?.invalidatedAt, undefined);
  assert.equal((await exportArtifact(id, oldA.id)).status, 409);
  assert.equal((await exportArtifact(id, oldMerged.id)).status, 409);
  assert.equal((await exportArtifact(id, oldB.id)).status, 200);
  const actions = updated.events.filter(e => e.type === 'work.invalidated').map(e => e.subject);
  assert.deepEqual(actions.sort(), ['a', 'merge']);

  const a2: TaskExecutor = {
    id: 'rerun-on-current-source',
    async execute(task) {
      assert.equal(task.packet.workItemId, 'a');
      assert.deepEqual(task.evidence.map(e => e.revision), [2]);
      assert.match(task.evidence[0].content ?? '', /Replacement source/);
      return { body: 'Re-extracted from v2', limitations: [], materialRequests: [] };
    }
  };
  await executeOneAgentTask(id, 'a', a2);
  assert.equal(store.getProject(id).steps.merge.state, 'blocked');
  store.reviewAgentOutput(id, 'a', true, '');
  assert.equal(store.getProject(id).steps.merge.state, 'ready');
  await approve(id, 'merge');
  assert.equal(store.getProject(id).steps.b.state, 'done');
  assert.equal((await exportArtifact(id, oldA.id)).status, 409,
    'an older artifact cannot be exported even after the task is reapproved');
});

test('Human clarification with a new original waits for normal source review and then passes bytes to Agent', async () => {
  const base = manualProjectPackage({
    id: 'human-attachment-review', title: 'Human file clarification',
    description: 'Required source plus optional requested attachment',
    inputs: 'Primary facts\n文件：Optional supporting document', objective: 'Check optional evidence'
  });
  const pkg = packageSchema.parse({
    ...base, steps: [{ ...base.steps[0], needsMaterials: ['input-01'], requestableMaterialIds: ['input-02'] }]
  });
  store.importPackage(pkg);
  const p = store.createProject(pkg.id, 'File request');
  store.setExecutionPolicy(p.id, false, 1);
  store.submitMaterial(p.id, 'input-01', 'Primary approved text');
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  await executeOneAgentTask(p.id, 'draft', {
    id: 'request-original',
    async execute(task) {
      assert.deepEqual(task.packet.readableInputs.map(x => x.revision), [1]);
      return { body: 'Please supply supporting document', limitations: [], materialRequests: [
        { materialId: 'input-02', reason: '请补充该支持性文件的原件。' }
      ] };
    }
  });
  const req = store.getProject(p.id).humanRequests![0];
  assert.equal(store.getProject(p.id).steps.draft.state, 'waiting_input');
  const bytes = Buffer.from('Sample\x00original\x01v1');
  store.submitMaterial(p.id, 'input-02', '支持性资料来自用户', {
    name: 'support.pdf', buffer: bytes
  }, { requestId: req.id });
  const waiting = store.getProject(p.id);
  assert.equal(waiting.humanRequests?.[0].status, 'awaiting_review');
  assert.equal(waiting.steps.draft.state, 'waiting_input');
  assert.equal(waiting.materials['input-02'].state, 'received');
  assert.equal(deriveWorkbenchQueues(waiting).human.filter(x => x.kind === 'request').length, 1);
  assert.equal(deriveWorkbenchQueues(waiting).human.some(x => x.key === 'material:input-02'), false);
  assert.throws(() => store.answerRequestedInput(p.id, req.id, 'Skip review'), /not pending/);
  store.reviewReceivedMaterial(p.id, 'input-02', true, 'Original accepted');
  const accepted = store.getProject(p.id);
  assert.equal(accepted.humanRequests?.[0].status, 'answered');
  assert.equal(accepted.materials['input-02'].acceptedArtifactId, accepted.humanRequests?.[0].attachmentArtifactId);
  assert.equal(accepted.steps.draft.state, 'ready');
  await executeOneAgentTask(p.id, 'draft', {
    id: 'resume-with-original',
    async execute(task) {
      const attachment = task.evidence.find(e => e.name === 'support.pdf');
      assert.ok(attachment?.originalFile);
      assert.deepEqual(attachment.originalFile.bytes, bytes);
      assert.equal(attachment.revision, 1);
      assert.match(task.humanHandoffs?.at(-1)?.value ?? '', /支持性资料来自用户/);
      return { body: 'Reviewing attached source', limitations: [], materialRequests: [] };
    }
  });
  assert.equal(store.getProject(p.id).steps.draft.state, 'review');
});

test('rejected supplemental original returns Human request to pending; no false acceptance', async () => {
  const base = manualProjectPackage({
    id: 'rejected-attachment', title: 'Rejected attachment',
    description: 'Human clarification attachment may be rejected',
    inputs: '文件：Primary PDF', objective: 'Process after confirmation'
  });
  store.importPackage(base);
  const p = store.createProject(base.id, 'Rejected attachment');
  store.setExecutionPolicy(p.id, false, 1);
  store.submitMaterial(p.id, 'input-01', '', { name: 'v1.pdf', buffer: Buffer.from('first') });
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  await executeOneAgentTask(p.id, 'draft', {
    id: 'request-replacement',
    async execute() { return { body: 'Need revision', limitations: [], materialRequests: [
      { materialId: 'input-01', reason: '请更新 PDF 原件。' }
    ] }; }
  });
  const request = store.getProject(p.id).humanRequests![0];
  const oldId = store.getProject(p.id).materials['input-01'].acceptedArtifactId;
  store.submitMaterial(p.id, 'input-01', 'New version', {
    name: 'bad.pdf', buffer: Buffer.from('incomplete')
  }, { requestId: request.id });
  store.reviewReceivedMaterial(p.id, 'input-01', false, 'Missing pages');
  const state = store.getProject(p.id);
  assert.equal(state.humanRequests?.[0].status, 'pending');
  assert.equal(state.steps.draft.state, 'waiting_input');
  assert.equal(state.materials['input-01'].acceptedArtifactId, oldId);
  assert.equal(state.materials['input-01'].state, 'rejected');
  assert.equal(state.artifacts.filter(a => a.kind === 'agent_output').length, 0);
  store.submitMaterial(p.id, 'input-01', 'Revised', {
    name: 'fixed.pdf', buffer: Buffer.from('complete')
  }, { requestId: request.id });
  store.reviewReceivedMaterial(p.id, 'input-01', true, 'Accepted');
  assert.equal(store.getProject(p.id).steps.draft.state, 'ready');
  assert.equal(store.getProject(p.id).materials['input-01'].artifactIds.length, 3);
});

test('active dependent execution blocks acceptance of a new source rather than overwriting a live run', async () => {
  const id = makeParallelProject('active-source-guard');
  const running = store.startAgent(id, 'a');
  store.submitMaterial(id, 'input-01', 'New version', undefined, { replaceAccepted: true });
  assert.throws(() => store.reviewReceivedMaterial(id, 'input-01', true, ''),
    /Dependent Agent work is active/);
  assert.equal(store.getProject(id).steps.a.state, 'running');
  store.markAgentFailed(id, 'a', running.runId, 'Explicit human-controlled cancellation');
  store.reviewReceivedMaterial(id, 'input-01', true, '');
  assert.equal(store.getProject(id).steps.a.state, 'ready');
});
