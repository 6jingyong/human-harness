import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectApprovedMcpTools, inspectCodexCapabilities, inspectCodexModels, runCodexTask } from '../src/executors/codex';
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
    startProcess: start('success'), timeoutMs: 10000,
    onEvent: event => events.push(event)
  });
  assert.equal(result.body, 'Real protocol fixture answer');
  assert.deepEqual(events.filter(e => e.kind !== 'progress'), [
    { kind: 'model', provider: 'codex', model: 'test-model' },
    { kind: 'thread', id: 'thread-fixture' }, { kind: 'turn', id: 'turn-fixture' }
  ]);
});

test('the model picker and thread/start share the paginated Codex catalog', async () => {
  const options = { startProcess: start('select-model'), timeoutMs: 3000 };
  const models = await inspectCodexModels(options);
  assert.deepEqual(models.map(model => model.id), ['test-model', 'other-model']);
  await runCodexTask({ ...task, model: 'other-model' }, options);
  await assert.rejects(runCodexTask({ ...task, model: 'removed' }, options), /没有可用的所选模型/);
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
    assert.deepEqual(events.find(e => e.kind === 'skills'), { kind: 'skills', selectors: ['pdf'] });
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

test('Codex inventories installed Skills and Plugins independently of model execution and makes MCP discovery optional', async () => {
  const local = { startProcess: start('inventory'), timeoutMs: 3000 };
  const inventory = await inspectCodexCapabilities(local);
  assert.equal(inventory.mcp, null);
  assert.ok(inventory.skills.ok);
  assert.ok(inventory.plugins.ok);
  assert.deepEqual(inventory.plugins.items.map(p => p.id), ['documents@local']);
  assert.ok(inventory.skills.items.some(s => s.name === 'pdf' && s.pluginId === 'documents@local'));
  assert.ok(inventory.skills.items.every(s => !('path' in s)));

  const withMcp = await inspectCodexCapabilities({ ...local, includeMcp: true });
  assert.ok(withMcp.mcp?.ok);
  assert.deepEqual(withMcp.mcp.items.map(s => [s.name, s.initialized, s.toolCount]), [
    ['example', true, 1], ['uninitialized', false, 0]
  ]);
});

test('the template selects a Plugin Skill for an approved PDF and requires the Codex executor', async () => {
  const pkg = manualProjectPackage({
    id: 'codex-plugin-document-review', title: 'Plugin 文档审查', description: 'Protocol test',
    inputs: '文件:已接受的测试 PDF', objective: '整理授权文件'
  });
  const selector = 'documents@local/pdf';
  pkg.steps[0].codexSkills = [selector];
  store.importPackage(pkg);
  const { id } = store.createProject(pkg.id, 'Requested plugin PDF Skill');
  store.submitMaterial(id, 'input-01', '', { name: 'accepted.pdf', buffer: samplePdf });
  store.reviewReceivedMaterial(id, 'input-01', true, '');
  await assert.rejects(() => executeOneAgentTask(id, 'draft', {
    id: 'demo', async execute() { throw new Error('Demo should not have started'); }
  }), /HH_EXECUTOR=codex/);
  assert.equal(store.getProject(id).steps.draft.state, 'failed');
  assert.equal(store.latestOutput(store.getProject(id), 'draft'), undefined);
  store.retryFailedAgent(id, 'draft');

  const old = process.env.HH_CODEX_DOCUMENTS;
  process.env.HH_CODEX_DOCUMENTS = '1';
  try {
    const executor: TaskExecutor = {
      id: 'codex',
      execute: (input, onEvent) => {
        assert.deepEqual(input.packet.codexSkills, [selector]);
        return runCodexTask(input, { onEvent, timeoutMs: 3000,
          startProcess: cwd => spawn(process.execPath, [fixture, 'plugin-skill'], { stdio: 'pipe', cwd }) });
      }
    };
    const result = await executeOneAgentTask(id, 'draft', executor);
    assert.equal(result.project.steps.draft.state, 'review');
    assert.match(result.project.runs.at(-1)?.lastExecutorEvent ?? '', /agentMessage/);
    assert.deepEqual(result.project.runs.at(-1)?.codexSkills, [selector]);
    assert.ok(result.project.events.some(event => event.type === 'executor.skills' && event.detail === JSON.stringify([selector])));
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_DOCUMENTS;
    else process.env.HH_CODEX_DOCUMENTS = old;
  }
});

test('ambiguous and disabled Plugin Skills and unexpected MCP execution reject results', async () => {
  const old = process.env.HH_CODEX_DOCUMENTS;
  process.env.HH_CODEX_DOCUMENTS = '1';
  try {
    for (const [mode, selector, error] of [
      ['ambiguous-skill', 'pdf', /Ambiguous Codex Skill/],
      ['plugin-disabled', 'documents@local/pdf', /Plugin not installed\/enabled/],
      ['document-mcp', 'documents@local/pdf', /Document task attempted unauthorized tool use: mcpToolCall/]
    ] as const) {
      await assert.rejects(() => runCodexTask({
        ...withPdf, packet: { ...withPdf.packet, codexSkills: [selector] }
      }, { startProcess: cwd => spawn(process.execPath, [fixture, mode], { stdio: 'pipe', cwd }), timeoutMs: 3000 }), error);
    }
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_DOCUMENTS;
    else process.env.HH_CODEX_DOCUMENTS = old;
  }
});

test('MCP picker lists host-approved, live read-only tools without calling them', async () => {
  const old = process.env.HH_CODEX_MCP_READ_ONLY;
  try {
    delete process.env.HH_CODEX_MCP_READ_ONLY;
    assert.deepEqual(await inspectApprovedMcpTools({ startProcess: () => assert.fail('unexpected launch') }),
      { selectors: [], unavailable: 0 });
    process.env.HH_CODEX_MCP_READ_ONLY = 'registry/sample_lookup,registry/missing,registry/sample_lookup,invalid';
    for (const mode of ['mcp-inventory', 'mcp-write', 'mcp-auth', 'mcp-ambiguous']) {
      const available = mode === 'mcp-inventory';
      const result = await inspectApprovedMcpTools({ startProcess: start(mode), timeoutMs: 3000 });
      assert.deepEqual(result, { selectors: available ? ['registry/sample_lookup'] : [], unavailable: available ? 1 : 2 });
    }
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_MCP_READ_ONLY;
    else process.env.HH_CODEX_MCP_READ_ONLY = old;
  }
});

const mcpLookup = { server: 'registry', tool: 'sample_lookup', arguments: { sampleId: 'DEMO-01' } };

test('a template MCP lookup uses Codex without a model turn and waits for Human review', async () => {
  const old = process.env.HH_CODEX_MCP_READ_ONLY;
  process.env.HH_CODEX_MCP_READ_ONLY = 'registry/sample_lookup';
  try {
    const pkg = manualProjectPackage({
      id: 'codex-mcp-review', title: 'MCP 源记录核验', description: 'Protocol test',
      inputs: '待核查项目说明', objective: '查阅匹配的目录记录'
    });
    pkg.steps[0].codexMcp = mcpLookup;
    pkg.steps.push({
      ...pkg.steps[0], id: 'use-lookup', title: '使用已审核目录记录',
      codexMcp: undefined, dependsOn: ['draft'], outputContractId: undefined
    });
    store.importPackage(pkg);
    const { id } = store.createProject(pkg.id, 'Read-only lookup');
    store.submitMaterial(id, 'input-01', 'PRIVATE_PROJECT_NOTE');
    store.reviewReceivedMaterial(id, 'input-01', true, '');
    await assert.rejects(() => executeOneAgentTask(id, 'draft', {
      id: 'demo', async execute() { throw new Error('Demo should not have started'); }
    }), /需要 Codex MCP 查询/);
    store.retryFailedAgent(id, 'draft');
    const executor: TaskExecutor = {
      id: 'codex',
      execute: (input, onEvent) => {
        assert.deepEqual(input.packet.codexMcp, mcpLookup);
        assert.equal(input.evidence[0].content, 'PRIVATE_PROJECT_NOTE');
        return runCodexTask(input, { onEvent, timeoutMs: 3000, startProcess: start('mcp-direct') });
      }
    };
    const result = await executeOneAgentTask(id, 'draft', executor);
    assert.equal(result.project.steps['draft'].state, 'review');
    assert.equal(result.project.steps['use-lookup'].state, 'blocked');
    assert.equal(result.project.runs.at(-1)?.codexMcpLookup, 'registry/sample_lookup');
    assert.equal(result.project.runs.at(-1)?.codexTurnId, undefined);
    const output = store.latestOutput(result.project, 'draft')?.content ?? '';
    assert.match(output, /Synthetic registry record/);
    assert.match(output, /DEMO-01/);
    assert.doesNotMatch(output, /PRIVATE_PROJECT_NOTE/);
    const approved = store.reviewAgentOutput(id, 'draft', true, '确认样例目录条目');
    assert.equal(approved.steps['use-lookup'].state, 'ready');
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_MCP_READ_ONLY;
    else process.env.HH_CODEX_MCP_READ_ONLY = old;
  }
});

test('MCP lookup requires an exact host allowlist and a ready, read-only tool on the selected thread', async () => {
  const old = process.env.HH_CODEX_MCP_READ_ONLY;
  const lookupTask = { ...task, packet: { ...task.packet, codexMcp: mcpLookup } };
  try {
    process.env.HH_CODEX_MCP_READ_ONLY = 'registry/*';
    await assert.rejects(() => runCodexTask(lookupTask, {
      startProcess: () => { throw new Error('no process should start'); }
    }), /not approved in HH_CODEX_MCP_READ_ONLY/);

    process.env.HH_CODEX_MCP_READ_ONLY = 'registry/sample_lookup';
    for (const [mode, error] of [
      ['mcp-write', /does not advertise readOnlyHint/],
      ['mcp-auth', /not ready or authorized/],
      ['mcp-ambiguous', /Ambiguous Codex MCP server registration/],
      ['mcp-tool-error', /tool reported an error/]
    ] as const) {
      await assert.rejects(() => runCodexTask(lookupTask, {
        startProcess: start(mode), timeoutMs: 3000
      }), error);
    }
    const output = await runCodexTask({ ...lookupTask, outputFormat: 'json' }, {
      startProcess: start('mcp-direct'), timeoutMs: 3000
    });
    assert.equal(JSON.parse(output.body).structuredContent.sampleId, 'DEMO-01');
  } finally {
    if (old === undefined) delete process.env.HH_CODEX_MCP_READ_ONLY;
    else process.env.HH_CODEX_MCP_READ_ONLY = old;
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


test('text-only Codex run rejects observed tool execution even when JSON candidate looks valid', async () => {
  await assert.rejects(() => runCodexTask(task, {
    startProcess: start('text-tool-attempt'), timeoutMs: 3000
  }), /Text-only task attempted unauthorized tool use: commandExecution/);
});
