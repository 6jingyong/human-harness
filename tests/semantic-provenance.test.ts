import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageSchema } from '../src/protocol/v1';
import { manualProjectPackage } from '../src/protocol/manual';
import type { TaskExecutor } from '../src/executors/contracts';

const directory = mkdtempSync(join(tmpdir(), 'hh-semantic-tests-'));
process.env.HH_DATA_DIR = directory;
const store = await import('../src/core/store');
const { approvedSemanticNotes } = await import('../src/core/semantics');
const { executeOneAgentTask } = await import('../src/executors/runner');
after(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows */ } });

function createSemanticProject(label: string) {
  const basic = manualProjectPackage({
    id: label, title: label, description: 'Provenance-isolated semantic record test',
    inputs: 'One document source', objective: 'Produce sourced semantic notes'
  });
  const pkg = packageSchema.parse({
    ...basic,
    steps: [
      { ...basic.steps[0], id: 'extract', outputContractId: 'extract-output' },
      { ...basic.steps[0], id: 'reuse', dependsOn: ['extract'], outputContractId: 'reuse-output' }
    ],
    outputs: ['extract', 'reuse'].map(id => ({
      ...basic.outputs[0], id: id + '-output', fileName: id + '.md', producingStepId: id
    }))
  });
  store.importPackage(pkg);
  const project = store.createProject(pkg.id, 'Semantic record');
  store.submitMaterial(project.id, 'input-01', '来源说明与段落内容：实验有效数据为 12。');
  store.reviewReceivedMaterial(project.id, 'input-01', true, '');
  return project.id;
}

test('only cited, human-approved semantic notes become reusable context', async () => {
  const id = createSemanticProject('semantic-valid');
  let sourceId = '';
  const proposal: TaskExecutor = {
    id: 'semantic-proposal',
    async execute(task) {
      assert.equal(task.packet.workItemId, 'extract');
      assert.equal(task.approvedSemanticNotes?.length, 0);
      const source = task.evidence[0];
      sourceId = source.artifactId;
      return {
        body: '内部候选结果，包含带出处的说明。',
        limitations: [], materialRequests: [],
        semanticNotes: [{
          materialId: 'input-01', sourceArtifactId: source.artifactId,
          sourceRevision: source.revision, location: '用户文本第 1 段',
          summary: '有效数据为 12', caveat: '仍须按项目模板核验'
        }]
      };
    }
  };
  await executeOneAgentTask(id, 'extract', proposal);
  const submitted = store.getProject(id);
  assert.equal(submitted.steps.extract.state, 'review');
  assert.equal(submitted.artifacts.at(-1)?.semanticNotes?.[0].sourceArtifactId, sourceId);
  assert.deepEqual(approvedSemanticNotes(submitted, ['input-01']), []);
  store.reviewAgentOutput(id, 'extract', true, '人工审核通过');
  assert.equal(approvedSemanticNotes(store.getProject(id), ['input-01']).length, 1);
  assert.deepEqual(approvedSemanticNotes(store.getProject(id), []), []);

  const downstream: TaskExecutor = {
    id: 'semantic-reuse',
    async execute(task) {
      assert.equal(task.packet.workItemId, 'reuse');
      assert.equal(task.approvedSemanticNotes?.length, 1);
      assert.equal(task.approvedSemanticNotes?.[0].summary, '有效数据为 12');
      assert.equal(task.approvedSemanticNotes?.[0].sourceArtifactId, sourceId);
      const { renderTextContext } = await import('../src/executors/contracts');
      assert.match(renderTextContext(task), /Approved, source-version-checked semantic notes/);
      return { body: '沿用已审核语义记录形成候选成果。', limitations: [], materialRequests: [] };
    }
  };
  await executeOneAgentTask(id, 'reuse', downstream);
  assert.equal(store.getProject(id).steps.reuse.state, 'review');
});

test('unsupported or invented provenance fails the run before any semantic artifact is stored', async () => {
  const id = createSemanticProject('semantic-invalid');
  const executor: TaskExecutor = {
    id: 'fabricated-citation',
    async execute(task) {
      return {
        body: 'Not accepted',
        limitations: [], materialRequests: [],
        semanticNotes: [{
          materialId: 'input-01',
          sourceArtifactId: 'invented-artifact', sourceRevision: 1,
          location: 'p.99', summary: 'Fabricated fact'
        }]
      };
    }
  };
  await assert.rejects(() => executeOneAgentTask(id, 'extract', executor), /outside this run/);
  assert.equal(store.getProject(id).steps.extract.state, 'failed');
  assert.equal(store.getProject(id).artifacts.filter(a => a.kind === 'agent_output').length, 0);
});

test('notes from older source versions are not reused when currently accepted revision changes', async () => {
  const id = createSemanticProject('semantic-stale');
  const project = store.getProject(id);
  const original = project.artifacts.find(a => a.kind === 'material')!;
  project.steps.extract.state = 'done';
  project.artifacts.push({
    id: 'derived-1', kind: 'agent_output', name: 'extract.md', ownerId: 'extract',
    content: 'Result', revision: 1, createdAt: '2026-11-08T00:00:00Z',
    semanticNotes: [{
      materialId: 'input-01', sourceArtifactId: original.id, sourceRevision: 1,
      location: 'p.1', summary: 'Historical version'
    }]
  });
  assert.equal(approvedSemanticNotes(project, ['input-01']).length, 1);
  // Controlled version substitution in pure projection (not an API mutation).
  project.materials['input-01'].artifactIds.push('new-version');
  project.artifacts.push({
    id: 'new-version', kind: 'material', name: 'Updated text', ownerId: 'input-01',
    content: 'Different evidence', revision: 2, createdAt: '2026-11-09T00:00:00Z'
  });
  assert.deepEqual(approvedSemanticNotes(project, ['input-01']), []);
});
