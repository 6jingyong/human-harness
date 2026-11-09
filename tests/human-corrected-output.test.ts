import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manualProjectPackage } from '../src/protocol/manual';
import { packageSchema } from '../src/protocol/v1';
import type { TaskExecutor } from '../src/executors/contracts';

const dir = mkdtempSync(join(tmpdir(), 'hh-human-correction-'));
process.env.HH_DATA_DIR = dir;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { GET: downloadOutput } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite on Windows */ } });

function makeProject(suffix: string) {
  const base = manualProjectPackage({
    id: 'human-correction-test-' + suffix, title: 'Human correction boundary', description: 'Fixture project',
    inputs: 'Source statement', objective: 'Extract a result for human review'
  });
  const draft = base.steps.find(step => step.id === 'draft')!;
  const output = base.outputs.find(item => item.producingStepId === 'draft')!;
  const pkg = packageSchema.parse({
    ...base,
    steps: [
      { ...draft, method: {
        procedure: ['Extract a claimed value from the approved source'],
        checks: [{ id: 'source-claim', criterion: 'Check the source value' }],
        onMissing: 'record_limitation'
      } },
      { id: 'analysis', stageId: draft.stageId, kind: 'agent',
        title: 'Analyze approved derived result', instructions: 'Analyze the approved derived JSON only',
        dependsOn: ['draft'], needsMaterials: [], outputContractId: 'analysis-output',
        requiresReview: true }
    ],
    outputs: [
      { ...output, format: 'json', fileName: 'draft.json' },
      { id: 'analysis-output', title: 'Downstream result', audience: 'internal',
        fileName: 'analysis.md', format: 'markdown', producingStepId: 'analysis',
        acceptance: ['Only use approved preceding result'], humanSignoff: true }
    ]
  });
  store.importPackage(pkg);
  const p = store.createProject(pkg.id, 'Human correction integration test');
  store.setExecutionPolicy(p.id, false, 2);
  store.submitMaterial(p.id, 'input-01', 'Test source states a value of 220');
  store.reviewReceivedMaterial(p.id, 'input-01', true, 'Fixture accepted');
  return p.id;
}

const mistakenAgent: TaskExecutor = {
  id: 'mistaken-candidate-fixture',
  async execute(task) {
    assert.equal(task.packet.workItemId, 'draft');
    return {
      body: JSON.stringify({ value: 380, marker: 'WRONG_AGENT_VALUE' }),
      limitations: [], materialRequests: [],
      methodChecks: [{
        checkId: 'source-claim', status: 'passed', explanation: 'Incorrect self-claim by Agent',
        evidenceRefs: [task.evidence[0].artifactId]
      }]
    };
  }
};

const getOutput = (id: string, artifactId: string) => downloadOutput(
  new Request('http://localhost/test'), { params: Promise.resolve({ id, artifactId }) }
);

test('Human correction is atomic, auditable, and becomes the only approved downstream input', async () => {
  const id = makeProject('corrected');
  assert.throws(() => store.approveHumanCorrectedOutput(id, 'draft', '{"value":220}', 'not ready'),
    /pending Agent candidate/);
  await executeOneAgentTask(id, 'draft', mistakenAgent);
  const original = store.latestOutput(store.getProject(id), 'draft')!;
  assert.equal(store.getProject(id).steps.analysis.state, 'blocked');
  assert.equal((await getOutput(id, original.id)).status, 409);

  assert.throws(() => store.approveHumanCorrectedOutput(id, 'draft', '{ invalid json', 'fix'),
    /valid JSON/);
  assert.throws(() => store.approveHumanCorrectedOutput(id, 'draft', '{"value":220}', ''),
    /requires a 1–1000 character rationale/);
  assert.throws(() => store.approveHumanCorrectedOutput(id, 'draft', original.content!, 'no edit'),
    /does not change/);
  assert.equal(store.getProject(id).artifacts.filter(a => a.ownerId === 'draft').length, 1,
    'Failed correction attempts must not mutate the project');

  store.approveHumanCorrectedOutput(id, 'draft',
    JSON.stringify({ value: 220, marker: 'HUMAN_CORRECTED_VALUE' }),
    'Human reviewed source and corrected the mistaken value');
  const project = store.getProject(id);
  const revisions = project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === 'draft');
  assert.equal(revisions.length, 2);
  assert.match(revisions[0].content ?? '', /WRONG_AGENT_VALUE/);
  assert.deepEqual(JSON.parse(revisions[1].content!), { value: 220, marker: 'HUMAN_CORRECTED_VALUE' });
  assert.equal(revisions[1].revision, 2);
  assert.equal(revisions[1].humanCorrection?.basedOnArtifactId, revisions[0].id);
  assert.match(revisions[1].humanCorrection?.rationale ?? '', /Human reviewed/);
  assert.deepEqual(revisions[1].methodChecks?.map(check => check.status), ['unverified'],
    'Self-checks of the original Agent output cannot certify a Human rewrite');
  assert.equal(project.steps.draft.state, 'done');
  assert.equal(project.steps.analysis.state, 'ready');
  assert.equal(project.events.some(event => event.type === 'work.human_corrected'), true);
  assert.equal((await getOutput(id, revisions[0].id)).status, 409,
    'The original Agent candidate cannot be exported as the approved deliverable');
  assert.equal((await getOutput(id, revisions[1].id)).status, 200);

  const run = store.startAgent(id, 'analysis');
  const packet = store.getTaskPacket(id, 'analysis', run.runId);
  assert.deepEqual(packet.readableInputs.map(input => input.artifactId), [revisions[1].id]);
  assert.deepEqual(packet.readableInputs.map(input => input.role), ['approved_derived']);
  assert.throws(() => store.approveHumanCorrectedOutput(id, 'draft', '{"value":999}', 'late edit'),
    /pending Agent candidate/);
});

test('unmodified Agent candidate can still follow the original approve/reject review path', async () => {
  const id = makeProject('unmodified');
  await executeOneAgentTask(id, 'draft', mistakenAgent);
  store.reviewAgentOutput(id, 'draft', true, 'Human accepts the unmodified fixture candidate');
  const artifacts = store.getProject(id).artifacts.filter(a => a.ownerId === 'draft');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].humanCorrection, undefined);
  assert.equal(store.getProject(id).steps.analysis.state, 'ready');
});
