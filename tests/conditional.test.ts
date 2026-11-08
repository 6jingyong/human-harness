import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'hh-conditional-'));
process.env.HH_DATA_DIR = dataDir;
const store = await import('../src/lib/store');
after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* active SQLite handle on Windows */ }
});

function startProject() {
  return store.createProject('land-investigation-runtime', 'Sample property');
}
function submitInputs(projectId: string) {
  store.submitHuman(projectId, 'site-info', 'Example municipality, scope TBD');
  store.submitHuman(projectId, 'boundary', '', { name: 'boundary.kml', bytes: Buffer.from('<kml>example only</kml>') });
  store.submitHuman(projectId, 'land-use', 'Intended land use is under review');
  assert.equal(store.reserveAgentTask(projectId)?.id, 'stage1-inventory');
  store.finishAgent(projectId, 'stage1-inventory', 'Evidence inventory is incomplete and needs professional review.', true);
  store.reviewAgent(projectId, 'stage1-inventory', true, 'Test review only');
}
function taskStatus(projectId: string, taskId: string) {
  return store.getProject(projectId)!.tasks.find(t => t.id === taskId)?.status;
}
test('first-stage exit never asks for sampling, QC or detection materials', () => {
  const p = startProject();
  assert.equal(taskStatus(p.id, 'sampling-plan'), 'inactive');
  assert.equal(taskStatus(p.id, 'qc-report'), 'pending'); // exists as a future graph node, but is blocked
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'qc-evidence')?.status, 'inactive');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'identity')?.status, 'needed');
  submitInputs(p.id);
  assert.equal(store.getProject(p.id)!.tasks.find(t => t.id === 'stage1-decision')?.inputKind, 'choice');
  assert.throws(() => store.submitHuman(p.id, 'stage1-decision', 'random'), /allowed decision/);
  store.submitHuman(p.id, 'stage1-decision', 'finish');
  assert.equal(taskStatus(p.id, 'first-stage-draft'), 'pending');
  assert.equal(taskStatus(p.id, 'sampling-plan'), 'not_applicable');
  assert.equal(taskStatus(p.id, 'qc-report'), 'not_applicable');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'qc-evidence')?.status, 'not_applicable');
  assert.equal(store.reserveAgentTask(p.id)?.id, 'first-stage-draft');
});

test('sampling branch activates commissioning before requests for institution reports', () => {
  const p = store.createProject('land-investigation-runtime', 'Sampling property');
  submitInputs(p.id);
  store.submitHuman(p.id, 'stage1-decision', 'sampling');
  assert.equal(taskStatus(p.id, 'first-stage-draft'), 'not_applicable');
  assert.equal(store.reserveAgentTask(p.id)?.id, 'sampling-plan');
  store.finishAgent(p.id, 'sampling-plan', 'Proposed planning questions (not actual coordinates)', true);
  assert.equal(taskStatus(p.id, 'commission'), 'pending');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'qc-evidence')?.status, 'inactive');
  store.reviewAgent(p.id, 'sampling-plan', true, '');
  store.submitHuman(p.id, 'approve-plan', 'Approved by reviewer with referenced site plan version 1');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'commission')?.status, 'needed');
  store.submitHuman(p.id, 'commission', 'Institution engaged for approved plan v1');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'qc-evidence')?.status, 'inactive');
  store.submitHuman(p.id, 'institution-complete', 'Institution has actually finished contracted field and laboratory work');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'qc-evidence')?.status, 'needed');
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'detection-report')?.status, 'needed');
  store.submitHuman(p.id, 'field-records', '', { name: 'field.pdf', bytes: Buffer.from('mock record') });
  store.submitHuman(p.id, 'detection-report', '', { name: 'detection.pdf', bytes: Buffer.from('mock report') });
  store.submitHuman(p.id, 'qc-report', '', { name: 'quality.pdf', bytes: Buffer.from('mock QC report') });
  assert.equal(store.getProject(p.id)!.materials?.find(m => m.id === 'qc-evidence')?.status, 'received');
  assert.equal(store.reserveAgentTask(p.id)?.id, 'qc-review');
  const decisions = store.getProject(p.id)!.decisions;
  assert.equal(decisions?.['stage1-decision'], 'sampling');
});

test('v3 template validates gate options, material ownership and conditional dependencies', () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'examples/template.land-investigation-runtime.json'), 'utf8'));
  assert.throws(() => store.addTemplate({ ...raw, id: 'bad-option', tasks: raw.tasks.map((t: {id: string}) =>
    t.id === 'sampling-plan' ? { ...t, activateWhen: { gateTaskId: 'stage1-decision', equals: 'unknown' } } : t) }), /Activation/);
  assert.throws(() => store.addTemplate({ ...raw, id: 'bad-dependency', tasks: raw.tasks.map((t: {id: string}) =>
    t.id === 'sampling-plan' ? { ...t, dependsOn: [] } : t) }), /Conditional task must depend/);
  assert.throws(() => store.addTemplate({ ...raw, id: 'bad-material', materials: [{ id: 'bad', title: 'Bad', taskId: 'stage1-inventory', producer: 'human' }] }), /Material must be produced/);
});
