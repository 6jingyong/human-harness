import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDir = mkdtempSync(join(tmpdir(), 'human-harness-test-'));
process.env.HH_DATA_DIR = temporaryDir;
const store = await import('../src/lib/store');

after(() => { try { rmSync(temporaryDir, { recursive: true, force: true }); } catch { /* Windows can retain an open SQLite handle */ } });

test('human input → agent execution → review rejection → revision → approval', () => {
  const p = store.createProject('general-project', 'Integration workflow');
  assert.equal(p.tasks.length, 4);
  assert.equal(store.reserveAgentTask(p.id), null);
  assert.equal(store.listProjects().find(x => x.id === p.id)?.title, 'Integration workflow');

  const input = store.submitHuman(p.id, 'brief', 'Research ethical human-AI collaboration');
  assert.equal(input.tasks.find(t => t.id === 'brief')?.status, 'completed');

  const reserved = store.reserveAgentTask(p.id);
  assert.equal(reserved?.id, 'plan');
  assert.equal(store.reserveAgentTask(p.id), null); // no concurrent double-claim

  const draft = store.finishAgent(p.id, 'plan', 'Plan v1', true);
  assert.equal(draft.tasks.find(t => t.id === 'plan')?.status, 'review');
  assert.equal(store.reserveAgentTask(p.id), null); // downstream blocked by review

  const rejected = store.reviewAgent(p.id, 'plan', false, 'Provide concrete deliverables');
  assert.equal(rejected.tasks.find(t => t.id === 'plan')?.status, 'pending');
  assert.equal(store.reserveAgentTask(p.id)?.id, 'plan');
  store.finishAgent(p.id, 'plan', 'Plan v2', true);
  const approved = store.reviewAgent(p.id, 'plan', true, '');
  assert.equal(approved.tasks.find(t => t.id === 'plan')?.status, 'completed');

  assert.equal(store.reserveAgentTask(p.id)?.id, 'first-delivery');
  const delivered = store.finishAgent(p.id, 'first-delivery', 'Deliverable v1', true);
  assert.equal(delivered.tasks.find(t => t.id === 'first-delivery')?.status, 'review');
  store.reviewAgent(p.id, 'first-delivery', true, 'Approved');

  const finalState = store.skipHuman(p.id, 'materials');
  assert.equal(finalState.tasks.find(t => t.id === 'materials')?.status, 'skipped');
  assert.equal(finalState.artifacts.filter(a => a.taskId === 'plan' && a.kind === 'agent_result').length, 2);
  assert.equal(finalState.events.filter(e => e.action === 'human.rejected').length, 1);
  assert.equal(store.reserveAgentTask(p.id), null);
});

test('binary uploads are preserved without misrepresenting their readable contents', () => {
  const p = store.createProject('site-investigation', 'File intake test');
  store.submitHuman(p.id, 'site-info', 'Location: example only');
  const uploaded = store.submitHuman(p.id, 'boundary', '', {
    name: 'boundary.pdf',
    bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02])
  });
  const artifact = uploaded.artifacts.find(a => a.taskId === 'boundary');
  assert.equal(artifact?.name, 'boundary.pdf');
  assert.equal(artifact?.kind, 'file');
  assert.equal(artifact?.content, null);
  assert.equal(store.reserveAgentTask(p.id)?.id, 'inventory');
});

test('submitting an unready task is rejected', () => {
  const p = store.createProject('general-project', 'Invalid submit');
  assert.throws(() => store.submitHuman(p.id, 'plan', 'fake completion'), /not ready/);
  assert.throws(() => store.submitHuman(p.id, 'brief', ''), /Enter text/);
});

test('imported JSON templates are validated, versioned and instantiated', () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'examples/template.document-review.json'), 'utf8'));
  const imported = store.addTemplate(raw);
  assert.equal(imported.id, 'document-review');
  assert.equal(imported.version, 2);
  assert.equal(store.listTemplateSummaries().find(t => t.id === 'document-review')?.version, 2);
  const first = store.createProject('document-review', 'Document review v2');
  assert.equal(first.templateVersion, 2);
  assert.equal(first.template?.workflow?.stages.length, 3);
  assert.equal(first.template?.resources?.length, 3);
  assert.equal(first.template?.deliverables?.[0].fileName, 'document-review.md');
  assert.equal(first.tasks.find(t => t.id === 'source-document')?.inputKind, 'file');
  assert.throws(() => store.addTemplate(raw), /version must be greater/);
  const newer = { ...raw, version: 3, tasks: raw.tasks.map((t: { id: string }) =>
    t.id === 'objective' ? { ...t, description: 'Revised instructions' } : t) };
  store.addTemplate(newer);
  assert.equal(store.listTemplateSummaries().find(t => t.id === 'document-review')?.version, 3);
  assert.equal(store.createProject('document-review', 'Document review v3').templateVersion, 3);
  assert.equal(store.getProject(first.id)?.templateVersion, 2); // existing projects are snapshots
  assert.throws(() => store.addTemplate({ ...raw, id: 'unsafe', tasks: [{ ...raw.tasks[0], owner: 'root' }] }));
  assert.throws(() => store.addTemplate({ ...raw, id: 'cycle', tasks: raw.tasks.map((t: { id: string }) =>
    t.id === 'objective' ? { ...t, dependsOn: ['revision-suggestions'] } : t) }), /Cycle/);
});


test('v2 package executes trusted script and enforces delivery output contract', async () => {
  const { executeRegisteredScript } = await import('../src/lib/scripts');
  const project = store.createProject('document-review', 'Document review executable package');
  store.submitHuman(project.id, 'objective', 'Identify unclear claims and trace evidence');
  store.submitHuman(project.id, 'source-document', '', {
    name: 'input.md', bytes: Buffer.from('# Source\n\nThe document asserts a claim with no citation.')
  });
  const findings = store.reserveAgentTask(project.id);
  assert.equal(findings?.id, 'review-findings');
  store.finishAgent(project.id, findings!.id, 'Missing citations and context', true);
  store.reviewAgent(project.id, findings!.id, true, '');

  const revision = store.reserveAgentTask(project.id);
  assert.equal(revision?.id, 'revision-suggestions');
  store.finishAgent(project.id, revision!.id, 'Insert references and clarify scope', true);
  store.reviewAgent(project.id, revision!.id, true, '');

  const compile = store.reserveAgentTask(project.id);
  assert.equal(compile?.id, 'compile-deliverable');
  assert.equal(compile?.execution?.mode, 'script');
  const assembled = executeRegisteredScript(compile!.execution!.scriptId!, store.getProject(project.id)!, compile!);
  assert.match(assembled, /## 输入材料/);
  assert.match(assembled, /## 审核成果/);
  assert.match(assembled, /Missing citations/);
  assert.throws(() => store.finishAgent(project.id, compile!.id, '# Short', true), /shorter than/);
  const finished = store.finishAgent(project.id, compile!.id, assembled, true);
  assert.equal(finished.artifacts.at(-1)?.name, 'document-review.md');
  assert.equal(finished.tasks.find(t => t.id === compile!.id)?.status, 'review');
  store.reviewAgent(project.id, compile!.id, true, '');
});

test('v2 package rejects arbitrary code and invalid references', () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'examples/template.document-review.json'), 'utf8'));
  assert.throws(() => store.addTemplate({ ...raw, id: 'bad-script', resources: raw.resources.map((r: { id: string }) =>
    r.id === 'md-compiler' ? { ...r, scriptId: 'run-arbitrary-shell' } : r) }), /Unknown automation script/);
  assert.throws(() => store.addTemplate({ ...raw, id: 'bad-resource', tasks: raw.tasks.map((t: { id: string }) =>
    t.id === 'compile-deliverable' ? { ...t, resourceRefs: ['not-in-template'] } : t) }), /Unknown task resource/);
  assert.throws(() => store.addTemplate({ ...raw, id: 'bad-output', deliverables: [{ ...raw.deliverables[0], fileName: '../escape.md' }] }), /safe basename/);
});
