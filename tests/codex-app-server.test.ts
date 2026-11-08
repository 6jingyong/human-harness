import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexTask } from '../src/executors/codex';
import type { ExecutorTask, ExecutorRunEvent, TaskExecutor } from '../src/executors/contracts';
import { manualProjectPackage } from '../src/protocol/manual';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-codex-app-server.cjs');
const start = (mode: string) => () => spawn(process.execPath, [fixture, mode], { stdio: 'pipe' });
const task: ExecutorTask = {
  packet: {
    protocol: 'hh.task/1', runId: 'run-fixture', projectId: 'project-fixture',
    workItemId: 'draft', objective: 'Summarize a provided sentence',
    readableInputs: [], templateResources: [], toolsAllowed: [], reviewPolicy: 'human_required'
  },
  stepTitle: 'Short summary', evidence: [], reviewFeedback: []
};

test('P1.1: real JSON-RPC stdio handshake, model selection, identities and validated result', async () => {
  const events: ExecutorRunEvent[] = [];
  const result = await runCodexTask(task, {
    startProcess: start('success'), timeoutMs: 3000,
    onEvent: event => events.push(event)
  });
  assert.equal(result.body, 'Real protocol fixture answer');
  assert.deepEqual(events.filter(e => e.kind !== 'progress'), [
    { kind: 'thread', id: 'thread-fixture' }, { kind: 'turn', id: 'turn-fixture' }
  ]);
});

test('P1.1: fail closed on model failure, JSON mismatch, disconnected server and wrong turn', async () => {
  for (const [mode, reason] of [
    ['failed', /Fixture model execution failed/],
    ['bad-json', /required JSON candidate/],
    ['disconnect', /exited before completion/],
    ['wrong-turn', /identity mismatch/]
  ] as const) {
    await assert.rejects(
      () => runCodexTask(task, { startProcess: start(mode), timeoutMs: 3000 }),
      reason, mode
    );
  }
});

test('P1.1: interactive tool approvals are never granted by text-only host', async () => {
  await assert.rejects(
    () => runCodexTask(task, { startProcess: start('approval'), timeoutMs: 3000 }),
    /Approval refused/
  );
});

test('P1.1: missing local Codex process is explicit and cannot produce a candidate', async () => {
  await assert.rejects(
    () => runCodexTask(task, {
      startProcess: () => spawn('human-harness-codex-missing-binary', ['app-server'], { stdio: 'pipe' }),
      timeoutMs: 3000
    }),
    /Cannot start local Codex/
  );
});

test('P1.1: tools and template resources are rejected before app-server launch', async () => {
  await assert.rejects(() => runCodexTask({
    ...task, packet: { ...task.packet, toolsAllowed: ['uninstalled.parser'] }
  }, { startProcess: start('success') }), /text-only/);
});

const temp = mkdtempSync(join(tmpdir(), 'hh-codex-runtime-test-'));
process.env.HH_DATA_DIR = temp;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
after(() => { try { rmSync(temp, { recursive: true, force: true }); } catch { /* Windows DB handle */ } });

test('P1.1: runner persists Codex identities; only runner submits candidate for review', async () => {
  const pkg = manualProjectPackage({
    id: 'codex-protocol-fixture',
    title: 'Codex 协议测试',
    description: '仅用于回归测试',
    inputs: '项目资料', objective: '整理已提供资料'
  });
  store.importPackage(pkg);
  const p = store.createProject(pkg.id, 'Codex local protocol run');
  store.submitMaterial(p.id, 'input-01', '受控测试资料');
  store.reviewReceivedMaterial(p.id, 'input-01', true, '');
  const executor: TaskExecutor = {
    id: 'codex-protocol-fixture',
    execute: (input, onEvent) => runCodexTask(input, { startProcess: start('success'), timeoutMs: 3000, onEvent })
  };
  const result = await executeOneAgentTask(p.id, 'draft', executor);
  const saved = store.getProject(p.id).runs.find(r => r.id === result.runId);
  assert.equal(saved?.codexThreadId, 'thread-fixture');
  assert.equal(saved?.codexTurnId, 'turn-fixture');
  assert.equal(saved?.status, 'review');
  assert.equal(store.latestOutput(store.getProject(p.id), 'draft')?.content, 'Real protocol fixture answer');
  assert.equal(store.getProject(p.id).events.filter(e => e.type === 'executor.turn').length, 1);
});
