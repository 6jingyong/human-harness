import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import eia from '../examples/eia-source-replay.hh.json';
import { packageSchema } from '../src/protocol/v1';
import { type TaskExecutor } from '../src/executors/contracts';

const dir = mkdtempSync(join(tmpdir(), 'hh-eia-replay-'));
process.env.HH_DATA_DIR = dir;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { groupAgentTasks, deriveWorkbenchQueues } = await import('../src/app/workbench-queue');
const { demoExecutor } = await import('../src/executors/demo');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function makeCase(label: string) {
  const p = store.createProject('eia-source-replay', label);
  store.setExecutionPolicy(p.id, false, 3);
  for (const [id, name, value] of [
    ['enterprise-original', '', 'Archive extracted TEXT: origin uncertain'],
    ['enterprise-extracted', '', '{"source_checked":true,"reviewer":"AI simulated"}'],
    ['qc-scan', 'scan.pdf', '%PDF-1.7\\nfixture-only'],
    ['frozen-analysis', '', '{"schema":"fixture.frozen-analysis","source_manifest":[]}'],
    ['word-candidate', 'draft.docx', 'PK-fixture-only']
  ]) {
    store.submitMaterial(p.id, id, name ? '' : value, name ? {
      name, buffer: Buffer.from(value)
    } : undefined);
    store.reviewReceivedMaterial(p.id, id, true, 'Accepted for protocol test, not factual endorsement');
  }
  return p.id;
}

const checks = (task: Parameters<TaskExecutor['execute']>[0],
                status: 'unverified' | 'passed' = 'unverified') =>
  (task.workMethod?.checks ?? []).map(c => ({
    checkId: c.id, status,
    explanation: status === 'unverified' ? 'Synthetic fixture cannot verify source content' : 'Controlled evidence only',
    evidenceRefs: status === 'passed' ? [task.evidence[0].artifactId] : []
  }));

test('EIA real-source replay project template is valid and no private sources are bundled', () => {
  const pkg = packageSchema.parse(eia);
  assert.equal(pkg.agents?.length, 3);
  assert.equal(pkg.materials.length, 7);
  assert.equal(pkg.steps.length, 4);
  assert.ok(pkg.outputs.every(o => o.audience === 'internal'));
  assert.ok(pkg.materials.find(m => m.id === 'qc-scan')?.method?.verification.some(x => x.includes('PDF')));
  assert.ok(pkg.steps.find(s => s.id === 'qc-audit')?.requestableMaterialIds?.includes('qc-source-proof'));
  assert.ok(pkg.steps.find(s => s.id === 'internal-review')?.method?.onMissing === 'record_limitation');
  assert.ok(store.listPackages().some(pkg => pkg.id === 'eia-source-replay' && pkg.builtin));
  const external = structuredClone(eia) as any;
  external.outputs[0].audience = 'external';
  external.outputs[0].humanSignoff = false;
  assert.equal(packageSchema.safeParse(external).success, false);
});

test('EIA pilot defaults to parallel source audits, a Human provenance gate, and a blocked final consumer', () => {
  const p = store.getProject(makeCase('EIA protocol fixture'));
  const lanes = groupAgentTasks(p, deriveWorkbenchQueues(p).agent);
  assert.deepEqual(lanes.map(l => l.id), ['enterprise-agent', 'qc-agent', 'review-agent']);
  assert.equal(lanes[0].counts.ready, 1);
  assert.equal(lanes[1].counts.ready, 1);
  assert.equal(lanes[2].counts.blocked, 1);
  assert.equal(p.steps['human-source-judgment'].state, 'blocked');
  assert.equal(p.steps['internal-review'].state, 'blocked');
});

test('EIA missing provenance routes to Human; no issued PDF is presumed equivalent', async () => {
  const id = makeCase('EIA Human provenance question');
  await executeOneAgentTask(id, 'enterprise-audit', {
    id: 'fixture-enterprise',
    async execute(task) {
      assert.equal(task.evidence.length, 2);
      assert.deepEqual(task.materialMethods?.map(x => x.materialId),
        ['enterprise-original', 'enterprise-extracted']);
      assert.ok(!task.evidence.some(x => x.name === 'scan.pdf'));
      return { body: 'Source statements only; entity location unverified',
        limitations: ['No independent enterprise site relationship'],
        materialRequests: [], methodChecks: checks(task) };
    }
  });
  assert.equal(store.getProject(id).steps['enterprise-audit'].state, 'review');
  assert.throws(() => store.reviewAgentOutput(id, 'enterprise-audit', true, ''),
    /Unresolved method checks/);
  store.reviewAgentOutput(id, 'enterprise-audit', true,
    'This is an internal source transcription candidate, not professional signoff.');
  await executeOneAgentTask(id, 'qc-audit', {
    id: 'fixture-qc',
    async execute(task) {
      assert.equal(task.evidence.length, 3);
      assert.ok(task.evidence.some(e => e.name === 'scan.pdf'));
      assert.equal(task.workMethod?.onMissing, 'request_human');
      return { body: 'Source scan SHA and frozen snapshot are not yet independently mapped',
        limitations: ['Page mapping must be verified'],
        materialRequests: [{ materialId: 'qc-source-proof', reason: 'Please check original images and reconstructed PDF mapping.' }] };
    }
  });
  const pending = store.getProject(id);
  assert.equal(pending.steps['qc-audit'].state, 'waiting_input');
  assert.equal(pending.humanRequests?.[0]?.materialId, 'qc-source-proof');
  assert.equal(deriveWorkbenchQueues(pending).human.some(x => x.kind === 'request'), true);
  store.answerRequestedInput(id, pending.humanRequests![0].id,
    'Original source unavailable; retain uncertainty. This is NOT verified equivalent.');
  await executeOneAgentTask(id, 'qc-audit', {
    id: 'fixture-qc-resume',
    async execute(task) {
      assert.match(task.humanHandoffs?.[0]?.value ?? '', /NOT verified equivalent/);
      return { body: 'QC scan is unverified. Do not draw regulatory conclusions.',
        limitations: ['No original mapping'], materialRequests: [], methodChecks: checks(task) };
    }
  });
  store.reviewAgentOutput(id, 'qc-audit', true,
    'Approved for internal issue logging only, scan equivalence not established.');
  assert.equal(store.getProject(id).steps['human-source-judgment'].state, 'ready');
  store.completeHuman(id, 'human-source-judgment',
    'Enterprise/site relation unverified; scan provenance unverified; do not release.');
  assert.equal(store.getProject(id).steps['internal-review'].state, 'ready');

  await executeOneAgentTask(id, 'internal-review', {
    id: 'fixture-internal',
    async execute(task) {
      assert.equal(task.evidence.filter(x => x.role === 'approved_derived').length, 2);
      assert.equal(task.evidence.filter(x => x.role === 'case_evidence').length, 2);
      assert.match(task.humanHandoffs?.[0]?.value ?? '', /do not release/);
      return { body: 'Internal-only audit. Business conclusions are not approved.',
        limitations: ['Professional review is outstanding'], materialRequests: [],
        methodChecks: checks(task) };
    }
  });
  assert.equal(store.getProject(id).steps['internal-review'].state, 'review');
  assert.throws(() => store.reviewAgentOutput(id, 'internal-review', true, ''),
    /Unresolved method checks/);
});

test('template refuses Human escalation from a record-limitation-only finalizer', async () => {
  const id = makeCase('EIA finalizer policy');
  // Independently check the method's explicit rule without bypassing dependencies.
  const method = store.getProject(id).package.steps.find(s => s.id === 'internal-review')?.method;
  assert.equal(method?.onMissing, 'record_limitation');
  assert.deepEqual(store.getProject(id).humanRequests, []);
});

test('Demo EIA methods never claim visual reading of an image-only PDF', async () => {
  const id = makeCase('EIA demo reads nothing');
  await executeOneAgentTask(id, 'qc-audit', demoExecutor);
  const p = store.getProject(id);
  const candidate = p.artifacts.filter(a => a.ownerId === 'qc-audit').at(-1);
  assert.ok(candidate);
  assert.ok(candidate.methodChecks?.every(c => c.status === 'unverified'));
  assert.match(candidate.content ?? '', /没有进行现场、GIS、采样、检测或任何原始 PDF/);
});
