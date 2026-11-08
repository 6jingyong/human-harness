import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskExecutor } from '../src/executors/contracts';

const directory = mkdtempSync(join(tmpdir(), 'hh-human-request-test-'));
process.env.HH_DATA_DIR = directory;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { deriveWorkbenchQueues } = await import('../src/app/workbench-queue');
const { packageSchema } = await import('../src/protocol/v1');
const { manualProjectPackage } = await import('../src/protocol/manual');
after(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows */ } });

function createCase(label: string) {
  const pkg = manualProjectPackage({
    id: label, title: label, description: 'Human-input handoff regression',
    inputs: 'A source file description', objective: 'Respond to the source'
  });
  store.importPackage(pkg);
  const p = store.createProject(label, label);
  store.submitMaterial(p.id, 'input-01', '原始资料的已接受内容');
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  return p.id;
}

test('Agent request becomes an actionable Human Todo and answer resumes the same WorkItem', async () => {
  const id = createCase('ask-human-step');
  let firstRun = '';
  const initial: TaskExecutor = {
    id: 'needs-human',
    async execute(task) {
      firstRun = task.packet.runId;
      assert.equal(task.humanHandoffs?.length, 0);
      return {
        body: '无法判断，请用户说明资料版本。',
        limitations: ['缺失信息'],
        materialRequests: [{ materialId: 'input-01', reason: '请确认资料的版本号及来源。' }]
      };
    }
  };
  await executeOneAgentTask(id, 'draft', initial);
  const paused = store.getProject(id);
  assert.equal(paused.steps.draft.state, 'waiting_input');
  assert.equal(paused.runs.at(-1)?.status, 'needs_input');
  assert.equal(paused.runs.at(-1)?.result?.outcome, 'needs_input');
  assert.equal(paused.runs.at(-1)?.result?.producedArtifacts.length, 0);
  assert.equal(paused.artifacts.filter(a => a.kind === 'agent_output').length, 0);
  assert.equal(paused.humanRequests?.length, 1);
  assert.equal(paused.humanRequests?.[0]?.status, 'pending');
  const human = deriveWorkbenchQueues(paused).human;
  assert.equal(human.some(item => item.key === 'request:' + paused.humanRequests?.[0].id), true);
  assert.equal(deriveWorkbenchQueues(paused).agent.find(item => item.id === 'draft')?.state, 'waiting_input');
  assert.equal(paused.humanRequests?.[0]?.runId, firstRun);
  assert.throws(() => store.answerRequestedInput(id, 'unknown', 'answer'), /not pending/);
  assert.throws(() => store.answerRequestedInput(id, paused.humanRequests![0].id, ''), /must contain/);

  const requestId = paused.humanRequests![0].id;
  const answered = store.answerRequestedInput(id, requestId, '版本 2026-11，来源为部门出具的已确认记录。');
  assert.equal(answered.humanRequests![0].status, 'answered');
  assert.equal(answered.steps.draft.state, 'ready');
  assert.equal(deriveWorkbenchQueues(answered).human.some(item => item.key === 'request:' + requestId), false);
  assert.throws(() => store.answerRequestedInput(id, requestId, 'duplicate'), /not pending/);

  const next: TaskExecutor = {
    id: 'resumed-after-answer',
    async execute(task) {
      assert.equal(task.packet.workItemId, 'draft');
      assert.notEqual(task.packet.runId, firstRun);
      assert.equal(task.humanHandoffs?.length, 1);
      assert.match(task.humanHandoffs?.[0].value ?? '', /版本 2026-11/);
      assert.match(task.humanHandoffs?.[0].value ?? '', /请确认资料的版本号/);
      return { body: '资料整理完成，附用户补充信息。', limitations: [], materialRequests: [] };
    }
  };
  await executeOneAgentTask(id, 'draft', next);
  assert.equal(store.getProject(id).steps.draft.state, 'review');
  store.reviewAgentOutput(id, 'draft', true, '可以交付');
  assert.equal(store.getProject(id).steps.draft.state, 'done');
});

test('material questions cannot create new template requirements or cause infinite automatic request loops', async () => {
  const id = createCase('invalid-human-request');
  const invented: TaskExecutor = {
    id: 'invented-material',
    async execute() {
      return { body: 'Need unknown material', limitations: [], materialRequests: [
        { materialId: 'unknown-secret', reason: 'Give me a password' }
      ] };
    }
  };
  await assert.rejects(() => executeOneAgentTask(id, 'draft', invented), /unknown or duplicate/);
  assert.equal(store.getProject(id).steps.draft.state, 'failed');
  assert.equal(store.getProject(id).humanRequests?.length, 0);
  store.retryFailedAgent(id, 'draft');

  const requestOnce: TaskExecutor = {
    id: 'one-request',
    async execute() {
      return { body: 'Need clarification', limitations: [], materialRequests: [
        { materialId: 'input-01', reason: '请补充来源。' }
      ] };
    }
  };
  await executeOneAgentTask(id, 'draft', requestOnce);
  const req = store.getProject(id).humanRequests?.[0];
  assert.ok(req);
  store.answerRequestedInput(id, req.id, '当前无法补充，按不确定处理。');
  await assert.rejects(() => executeOneAgentTask(id, 'draft', requestOnce), /Repeated human request/);
  assert.equal(store.getProject(id).steps.draft.state, 'failed');
  assert.equal(store.getProject(id).humanRequests?.length, 1);
});

test('Human question never changes the accepted original material into a fictitious new version', async () => {
  const id = createCase('request-immutable-evidence');
  const accepted = store.getProject(id);
  const originalId = accepted.materials['input-01'].artifactIds.at(-1);
  await executeOneAgentTask(id, 'draft', {
    id: 'ask-for-provenance',
    async execute() {
      return { body: 'Need help', limitations: [], materialRequests: [
        { materialId: 'input-01', reason: '请说明资料是否有附注。' }
      ] };
    }
  });
  store.answerRequestedInput(id, store.getProject(id).humanRequests![0].id,
    '没有附注，按原文处理。');
  const later = store.getProject(id);
  assert.equal(later.materials['input-01'].state, 'accepted');
  assert.deepEqual(later.materials['input-01'].artifactIds, [originalId]);
  assert.equal(later.artifacts.filter(a => a.kind === 'material').length, 1);
});


test('multiple pending Human questions must all be answered before Agent becomes runnable', async () => {
  const p = store.createProject('document-handoff', 'Two missing-input questions');
  store.submitMaterial(p.id, 'source-a', '', {
    name: 'a.pdf', buffer: Buffer.from('fixture-a')
  });
  store.reviewReceivedMaterial(p.id, 'source-a', true, '');
  store.submitMaterial(p.id, 'source-b', '', {
    name: 'b.docx', buffer: Buffer.from('fixture-b')
  });
  store.reviewReceivedMaterial(p.id, 'source-b', true, '');
  await executeOneAgentTask(p.id, 'extract', {
    id: 'two-questions',
    async execute() {
      return { body: 'Missing two details', limitations: [], materialRequests: [
        { materialId: 'source-a', reason: '请确认 A 的版本。' },
        { materialId: 'source-b', reason: '请确认 B 的来源。' }
      ] };
    }
  });
  const requests = store.getProject(p.id).humanRequests ?? [];
  assert.equal(requests.length, 2);
  store.answerRequestedInput(p.id, requests[0].id, 'A 为当前正式版');
  assert.equal(store.getProject(p.id).steps.extract.state, 'waiting_input');
  assert.equal(deriveWorkbenchQueues(store.getProject(p.id)).human.filter(x => x.kind === 'request').length, 1);
  store.answerRequestedInput(p.id, requests[1].id, 'B 来自资料提供单位');
  assert.equal(store.getProject(p.id).steps.extract.state, 'ready');
});
