import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { manualProjectPackage } from '../src/protocol/manual';
import { packageSchema } from '../src/protocol/v1';
import type { TaskExecutor } from '../src/executors/contracts';
import { affectedStepsForOutput, currentApprovedOutput } from '../src/core/runtime';
import { ProjectMaterialLibrary } from '../src/app/project-material-library';

const folder = mkdtempSync(join(tmpdir(), 'hh-approved-head-'));
process.env.HH_DATA_DIR = folder;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { GET: outputGET } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* sqlite on Windows */ } });

function project(suffix: string) {
  const base = manualProjectPackage({
    id: 'approved-head-test-' + suffix,
    title: 'Current HEAD and Human override',
    description: 'Two independent branches and a 3-stage chain',
    inputs: 'A evidence\nD independent evidence',
    objective: 'Analyze user-confirmed derived results'
  });
  const sample = base.steps.find(s => s.id === 'draft')!;
  const oldOutput = base.outputs.find(o => o.producingStepId === 'draft')!;
  const makeAgent = (id: string, dependsOn: string[], needsMaterials: string[]) => ({
    ...sample, id, dependsOn, needsMaterials, outputContractId: id + '-output',
    title: id + ' task'
  });
  const steps = [
    makeAgent('a', [], ['input-01']),
    makeAgent('b', ['a'], []),
    makeAgent('c', ['b'], []),
    makeAgent('d', [], ['input-02'])
  ];
  steps[0].method = {
    procedure: ['Extract the specified numeric value from the source'],
    checks: [{ id: 'value-checked', criterion: 'Verify the numeric value' }],
    onMissing: 'record_limitation'
  };
  const pkg = packageSchema.parse({
    ...base, steps, outputs: steps.map(step => ({
      ...oldOutput, id: step.outputContractId, producingStepId: step.id,
      format: step.id === 'a' ? 'json' : 'markdown',
      fileName: step.id === 'a' ? 'a.json' : step.id + '.md'
    }))
  });
  store.importPackage(pkg);
  const p = store.createProject(pkg.id, 'Human revision test');
  store.setExecutionPolicy(p.id, false, 2);
  for (const id of ['input-01', 'input-02']) {
    store.submitMaterial(p.id, id, id === 'input-01' ? 'Source states value 220' : 'Independent D source');
    store.reviewReceivedMaterial(p.id, id, true, 'Test fixture');
  }
  return p.id;
}

const fixture = (name: string, content: string): TaskExecutor => ({
  id: 'fixture-' + name,
  async execute(task) {
    const checks = task.workMethod?.checks.map(check => ({
      checkId: check.id, status: 'passed' as const,
      explanation: 'Synthetic check, NOT a real professional verification',
      evidenceRefs: [task.evidence[0].artifactId]
    }));
    return { body: content, limitations: [], materialRequests: [], ...(checks ? { methodChecks: checks } : {}) };
  }
});
async function approve(id: string, step: string, content: string) {
  await executeOneAgentTask(id, step, fixture(step, content));
  store.reviewAgentOutput(id, step, true, 'Controlled approval for flow test');
}
const exportOutput = (id: string, artifactId: string) => outputGET(
  new Request('http://localhost/head-export'),
  { params: Promise.resolve({ id, artifactId }) }
);

test('Human post-approval revision updates HEAD, preserves historical results and invalidates only descendants', async () => {
  const id = project('cascade');
  await approve(id, 'a', '{"value":380,"marker":"WRONG_A"}');
  await approve(id, 'b', 'B from original A');
  await approve(id, 'c', 'C from original B');
  await approve(id, 'd', 'D completely independent');
  const old = store.getProject(id);
  const [a1, b1, c1, d1] = ['a', 'b', 'c', 'd'].map(step => currentApprovedOutput(old, step)!);
  assert.deepEqual([...affectedStepsForOutput(old, 'a')].sort(), ['b', 'c']);
  assert.deepEqual(old.runs.filter(r => r.stepId === 'b')[0].inputArtifactIds, [a1.id]);
  assert.deepEqual(old.runs.filter(r => r.stepId === 'c')[0].inputArtifactIds, [b1.id]);
  assert.equal(old.steps.a.approvedArtifactId, a1.id);
  assert.equal((await exportOutput(id, c1.id)).status, 200);

  assert.throws(() => store.reviseHumanApprovedOutput(
    id, 'a', 'not-an-actual-head', '{"value":220}', 'human correct'), /HEAD changed/);
  assert.throws(() => store.reviseHumanApprovedOutput(
    id, 'a', a1.id, '{broken json', 'human correct'), /valid JSON/);
  assert.throws(() => store.reviseHumanApprovedOutput(
    id, 'a', a1.id, '{"value":220}', ''), /rationale/);
  assert.equal(store.getProject(id).artifacts.filter(a => a.ownerId === 'a').length, 1);

  store.reviseHumanApprovedOutput(id, 'a', a1.id,
    '{"value":220,"marker":"HUMAN_FIXED"}', 'Human accepts corrected value after source comparison');
  const revised = store.getProject(id);
  const a2 = currentApprovedOutput(revised, 'a')!;
  assert.notEqual(a2.id, a1.id);
  assert.equal(a2.revision, 2);
  assert.equal(a2.humanCorrection?.basedOnArtifactId, a1.id);
  assert.deepEqual(a2.methodChecks?.map(check => check.status), ['unverified']);
  assert.match(a2.humanCorrection?.rationale ?? '', /Human accepts/);
  assert.match(revised.artifacts.find(a => a.id === a1.id)?.content ?? '', /WRONG_A/);
  assert.equal(revised.steps.a.approvedArtifactId, a2.id);
  assert.equal(revised.steps.b.state, 'ready');
  assert.equal(revised.steps.c.state, 'blocked');
  assert.equal(revised.steps.b.approvedArtifactId, undefined);
  assert.equal(revised.steps.d.approvedArtifactId, d1.id);
  assert.equal(revised.steps.d.state, 'done');
  assert.ok(revised.artifacts.find(a => a.id === b1.id)?.invalidatedAt);
  assert.ok(revised.artifacts.find(a => a.id === c1.id)?.invalidatedAt);
  assert.equal(revised.artifacts.find(a => a.id === d1.id)?.invalidatedAt, undefined);
  assert.equal((await exportOutput(id, b1.id)).status, 409);
  assert.equal((await exportOutput(id, c1.id)).status, 409);
  assert.equal((await exportOutput(id, a1.id)).status, 409);
  assert.equal((await exportOutput(id, a2.id)).status, 200);
  assert.equal((await exportOutput(id, d1.id)).status, 200);
  const audit = revised.events.find(e => e.type === 'work.human_revised_after_approval')!;
  assert.deepEqual(JSON.parse(audit.detail).invalidatedSteps.sort(), ['b', 'c']);
  assert.equal(JSON.parse(audit.detail).fromArtifactId, a1.id);
  assert.equal(JSON.parse(audit.detail).toArtifactId, a2.id);

  assert.throws(() => store.reviseHumanApprovedOutput(
    id, 'a', a1.id, '{"value":999}', 'stale browser'), /HEAD changed/);
  assert.equal(store.getProject(id).steps.a.approvedArtifactId, a2.id);

  // Revived B gets only approved A v2; no original A material or previous candidate.
  const run = store.startAgent(id, 'b');
  const packet = store.getTaskPacket(id, 'b', run.runId);
  assert.deepEqual(packet.readableInputs.map(x => x.artifactId), [a2.id]);
  assert.deepEqual(packet.readableInputs.map(x => x.role), ['approved_derived']);
  const before = store.getProject(id).artifacts.length;
  assert.throws(() => store.reviseHumanApprovedOutput(
    id, 'a', a2.id, '{"value":230}', 'attempt during active B'), /Dependent Agent work is active/);
  assert.equal(store.getProject(id).artifacts.length, before,
    'Active-descendant conflict must leave project unchanged');
  store.markAgentFailed(id, 'b', run.runId, 'fixture canceled after collision');
  // Explicit human amendment also invalidates a failed dependent, not unrelated D.
  store.reviseHumanApprovedOutput(id, 'a', a2.id,
    a1.content!, 'Revert to original content as a NEW revision');
  const reverted = store.getProject(id);
  const a3 = currentApprovedOutput(reverted, 'a')!;
  assert.equal(a3.revision, 3);
  assert.equal(a3.content, a1.content);
  assert.equal(a3.humanCorrection?.basedOnArtifactId, a2.id);
  assert.equal(reverted.steps.b.state, 'ready');
  assert.equal(reverted.steps.d.state, 'done');
});

test('Project library exposes HEAD, impacted-work preview, and read-only historic revisions', async () => {
  const id = project('interface');
  await approve(id, 'a', '{"value":380}');
  await approve(id, 'b', 'Read A');
  const state = store.getProject(id);
  const html = renderToStaticMarkup(createElement(ProjectMaterialLibrary, {
    project: state,
    onBack: () => undefined,
    onReplace: () => undefined,
    onRevise: () => undefined,
    values: {}, feedback: {}, files: {},
    onValue: () => undefined, onFeedback: () => undefined,
    onFile: () => undefined, isPending: () => false
  }));
  assert.match(html, /当前有效版本 HEAD/);
  assert.match(html, /人类修订当前已批准成果/);
  assert.match(html, /预计影响后继任务 2 项/);
  assert.match(html, /记录修订、更新 HEAD 并重开受影响任务/);
  assert.match(html, /复制当前 HEAD 到编辑区/);
});
