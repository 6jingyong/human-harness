import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  }, { startProcess: start('success') }), /capability binding/);
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

const samplePdf = Buffer.from('%PDF-1.7\\n% HH fake PDF for staging only');
const withPdf: ExecutorTask = {
  ...task,
  evidence: [{
    artifactId: 'uploaded-pdf', revision: 1, role: 'case_evidence',
    name: 'source.pdf', content: null,
    originalFile: {
      bytes: samplePdf, sha256: createHash('sha256').update(samplePdf).digest('hex')
    }
  }]
};

test('document execution is opt-in and cannot silently turn on shell access', async () => {
  const old = process.env.HH_CODEX_DOCUMENTS;
  delete process.env.HH_CODEX_DOCUMENTS;
  try {
    await assert.rejects(
      () => runCodexTask(withPdf, { startProcess: start('document'), timeoutMs: 3000 }),
      /HH_CODEX_DOCUMENTS=1/
    );
  } finally {
    if (old !== undefined) process.env.HH_CODEX_DOCUMENTS = old;
  }
});

test('PDF fixture verifies selected Skill path, staged original bytes and no-network sandbox', async () => {
  const old = process.env.HH_CODEX_DOCUMENTS;
  process.env.HH_CODEX_DOCUMENTS = '1';
  try {
    const events: ExecutorRunEvent[] = [];
    const output = await runCodexTask(withPdf, {
      startProcess: cwd => spawn(process.execPath, [fixture, 'document'], { stdio: 'pipe', cwd }),
      timeoutMs: 3000,
      onEvent: event => events.push(event)
    });
    assert.equal(output.body, 'Real protocol fixture answer');
    assert.ok(events.some(e => e.kind === 'progress' && e.message.includes('Installed skill discovered')));
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_DOCUMENTS;
    else process.env.HH_CODEX_DOCUMENTS = old;
  }
});

test('missing document Skill never produces a candidate', async () => {
  const old = process.env.HH_CODEX_DOCUMENTS;
  process.env.HH_CODEX_DOCUMENTS = '1';
  try {
    await assert.rejects(
      () => runCodexTask(withPdf, { startProcess: start('no-skill'), timeoutMs: 3000 }),
      /Required local Codex Skill not installed/
    );
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_DOCUMENTS;
    else process.env.HH_CODEX_DOCUMENTS = old;
  }
});

test('runner transports only currently accepted original bytes, not storage paths', async () => {
  const pkg = manualProjectPackage({
    id: 'codex-accepted-upload-scope', title: '文件读取作用域',
    description: 'Verify only approved file revisions are passed',
    inputs: '文件:证据报告', objective: '从授权资料提取信息'
  });
  store.importPackage(pkg);
  const project = store.createProject(pkg.id, 'Accepted binary evidence');
  store.submitMaterial(project.id, 'input-01', '', {
    name: 'old.pdf', buffer: Buffer.from('rejected-old-pdf')
  });
  store.reviewReceivedMaterial(project.id, 'input-01', false, '旧版不接受');
  store.submitMaterial(project.id, 'input-01', '', {
    name: 'new.pdf', buffer: samplePdf
  });
  store.reviewReceivedMaterial(project.id, 'input-01', true, '');
  const adapter: TaskExecutor = {
    id: 'binary-scope-test',
    async execute(input) {
      assert.equal(input.evidence.length, 1);
      assert.equal(input.evidence[0].name, 'new.pdf');
      assert.deepEqual(Buffer.from(input.evidence[0].originalFile!.bytes), samplePdf);
      assert.ok(!('filePath' in input.evidence[0]));
      return { body: '来源明确的内部候选结果', limitations: [], materialRequests: [] };
    }
  };
  const run = await executeOneAgentTask(project.id, 'draft', adapter);
  assert.equal(run.project.steps.draft.state, 'review');
});


test('AbortSignal interrupts a still-running local Codex child without accepting a candidate', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => runCodexTask(task, {
      startProcess: start('stalled'), timeoutMs: 6000,
      signal: controller.signal,
      onEvent: event => {
        if (event.kind === 'turn') controller.abort();
      }
    }),
    /cancelled/
  );
});


test('Codex adapter passes through template-scoped Human questions (runner remains authority)', async () => {
  const result = await runCodexTask({
    ...task, requestableMaterials: [{
      id: 'input-01', title: '授权原件', description: '需要确认版次'
    }]
  }, { startProcess: start('human-request'), timeoutMs: 3000 });
  assert.deepEqual(result.materialRequests, [
    { materialId: 'input-01', reason: '请确认资料版次' }
  ]);
});

test('Codex adapter can return explicit unverified method checks without pretending a pass', async () => {
  const methodTask: ExecutorTask = {
    ...task, workMethod: {
      procedure: ['Read authorized input only'],
      checks: [{ id: 'source-trace', criterion: 'Source is traceable' }],
      onMissing: 'request_human'
    }
  };
  const result = await runCodexTask(methodTask, {
    startProcess: start('method-checks'), timeoutMs: 3000
  });
  assert.equal(result.methodChecks?.[0]?.checkId, 'source-trace');
  assert.equal(result.methodChecks?.[0]?.status, 'unverified');
});
