import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
