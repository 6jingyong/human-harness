import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import template from '../examples/eia-abc-pipeline.hh.json';
import { packageSchema } from '../src/protocol/v1';
import { type ExecutorTask, type TaskExecutor } from '../src/executors/contracts';

const folder = mkdtempSync(join(tmpdir(), 'hh-abc-stage-pipeline-'));
process.env.HH_DATA_DIR = folder;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { LocalScheduler } = await import('../src/executors/scheduler');
const { groupAgentTasks, deriveWorkbenchQueues } = await import('../src/app/workbench-queue');
const { GET: downloadOutput } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* Windows file locks */ } });

function createCase(label: string) {
  const p = store.createProject('eia-abc-pipeline', label);
  store.setExecutionPolicy(p.id, false, 2);
  const sources: Array<{ id: string; text?: string; filename?: string; bytes?: Buffer }> = [
    { id: 'enterprise-original', text: '企业陈述：已停产，清洗剂来源不明。' },
    { id: 'enterprise-half-result', filename: 'enterprise.json',
      bytes: Buffer.from(JSON.stringify({ items: [{ field: 'closed', value: 'reported' }] })) },
    { id: 'qc-scan', filename: 'qc.pdf', bytes: Buffer.from('%PDF-1.7\nFIXTURE_NO_REAL_PDF_PARSING') },
    { id: 'qc-frozen-result', filename: 'qc-results.json',
      bytes: Buffer.from(JSON.stringify({ result: [{ label: 'repeat', value: 'pending' }] })) },
    { id: 'word-reference', filename: 'reference.docx', bytes: Buffer.from('PK-FIXTURE_WORD_NO_REAL_PARSING') }
  ];
  for (const source of sources) {
    store.submitMaterial(p.id, source.id, source.text ?? '',
      source.filename ? { name: source.filename, buffer: source.bytes! } : undefined);
    store.reviewReceivedMaterial(p.id, source.id, true, 'Accept simulated input for runtime validation only');
  }
  return p.id;
}
const checks = (task: ExecutorTask) => (task.workMethod?.checks ?? []).map(c => ({
  checkId: c.id, status: 'passed' as const,
  explanation: 'Controlled pipeline contract test: no external professional validation',
  evidenceRefs: [task.evidence[0].artifactId]
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out: ' + message);
}
const exportArtifact = (id: string, artifactId: string) => downloadOutput(
  new Request('http://localhost/abc-output'), { params: Promise.resolve({ id, artifactId }) }
);

test('A/B/C are processing roles, not source categories; dependencies exclude cross-stage raw files', () => {
  const pkg = packageSchema.parse(template);
  assert.equal(pkg.agents?.length, 3);
  const steps = pkg.steps.filter(s => s.kind === 'agent');
  assert.deepEqual(steps.filter(s => s.agentId === 'agent-a').map(s => s.id),
    ['a-enterprise-results', 'a-qc-results']);
  assert.deepEqual(steps.filter(s => s.agentId === 'agent-b').map(s => s.id),
    ['b-enterprise-analysis', 'b-qc-analysis']);
  assert.deepEqual(steps.filter(s => s.agentId === 'agent-c').map(s => s.id),
    ['c-final-output']);
  for (const s of steps.filter(s => s.agentId !== 'agent-a')) {
    assert.deepEqual(s.needsMaterials, [], 'B/C must never directly read originals');
    assert.equal(s.requestableMaterialIds, undefined);
  }
  const caseId = createCase('ABC stage graph and simple Todo');
  const project = store.getProject(caseId);
  const lanes = groupAgentTasks(project, deriveWorkbenchQueues(project).agent);
  assert.deepEqual(lanes.map(group => group.id), ['agent-a', 'agent-b', 'agent-c']);
  assert.equal(lanes[0].counts.ready, 2);
  assert.equal(lanes[1].counts.blocked, 2);
  assert.equal(lanes[2].counts.blocked, 1);
  assert.equal(project.steps['human-conclusion-review'].state, 'blocked');
});

test('real local scheduler pipelines B1 while A2 still runs; C waits for both reviewed B results and Human signoff', async () => {
  const id = createCase('ABC multi-branch runtime pipeline');
  const a2Gate = deferred();
  const b1Gate = deferred();
  const started: string[] = [];
  let a2Holding = false;
  let b1Holding = false;
  const worker: TaskExecutor = {
    id: 'controlled-pipeline-worker',
    async execute(task) {
      const work = task.packet.workItemId;
      started.push(work);
      if (work === 'a-enterprise-results') {
        assert.equal(task.evidence.filter(e => e.role === 'case_evidence').length, 2);
        assert.equal(task.evidence.filter(e => e.role === 'approved_derived').length, 0);
        return { body: JSON.stringify({ facts: [{ name: '停产', value: '企业陈述' }], incomplete: true }),
          limitations: ['企业主体与红线关系尚未独立核实'], materialRequests: [],
          methodChecks: checks(task) };
      }
      if (work === 'a-qc-results') {
        assert.equal(task.evidence.length, 3);
        a2Holding = true;
        await a2Gate.promise;
        return { body: JSON.stringify({ results: [{ name: 'QC', status: 'unverified' }] }),
          limitations: ['扫描PDF未被真实模型识读'], materialRequests: [],
          methodChecks: checks(task) };
      }
      if (work === 'b-enterprise-analysis') {
        assert.equal(task.evidence.length, 1);
        assert.ok(task.evidence.every(e => e.role === 'approved_derived'));
        assert.equal(task.evidence[0].name, 'enterprise-results.json');
        assert.match(task.evidence[0].content ?? '', /"停产"/);
        assert.equal(task.evidence.some(e => e.name === 'enterprise.json'), false);
        b1Holding = true;
        await b1Gate.promise;
        return { body: '## 企业分析结论\n只有企业自述停产，主体身份与地块关联不足，不能做肯定性风险判定。',
          limitations: ['未确认地块空间关系'], materialRequests: [],
          methodChecks: checks(task) };
      }
      if (work === 'b-qc-analysis') {
        assert.equal(task.evidence.length, 1);
        assert.ok(task.evidence.every(e => e.role === 'approved_derived'));
        assert.equal(task.evidence[0].name, 'qc-results.json');
        return { body: '## 质控分析结论\n依据A2结果，本例不能声称质控全部合格。',
          limitations: ['扫描PDF未独立验证'], materialRequests: [],
          methodChecks: checks(task) };
      }
      if (work === 'c-final-output') {
        assert.equal(task.evidence.length, 2);
        assert.ok(task.evidence.every(e => e.role === 'approved_derived'));
        assert.deepEqual(task.evidence.map(e => e.name).sort(),
          ['enterprise-conclusion.md', 'qc-conclusion.md']);
        assert.equal(task.evidence.some(e => e.name.endsWith('.json') || e.name.endsWith('.pdf')), false);
        assert.equal(task.humanHandoffs?.length, 1);
        assert.match(task.humanHandoffs![0].value, /只允许内部展示/);
        return { body: [
          '# 环评 Agent 分阶段内部成果',
          '',
          '## 企业方面',
          '企业陈述停产，但与本地块的关系尚未核实。',
          '',
          '## 质控方面',
          '现有结果尚不能支持质控全部合格的判断。',
          '',
          '## 结论',
          '本稿仅供内部专业审核，不构成正式环评报告。'
        ].join('\n'),
        limitations: ['不能对外签发'], materialRequests: [],
        methodChecks: checks(task) };
      }
      throw new Error('Unexpected step: ' + work);
    }
  };
  const scheduler = new LocalScheduler(worker, 2, err => { throw new Error(err); });
  try {
    store.setExecutionPolicy(id, true, 2);
    scheduler.pulse();
    await until(() => a2Holding &&
      store.getProject(id).steps['a-enterprise-results'].state === 'review',
      'A1 and A2 should start concurrently');
    const pre = store.getProject(id);
    assert.equal(pre.steps['a-qc-results'].state, 'running');
    assert.equal(pre.steps['b-enterprise-analysis'].state, 'blocked');

    const a1Artifact = pre.artifacts.find(a => a.ownerId === 'a-enterprise-results')!;
    assert.equal((await exportArtifact(id, a1Artifact.id)).status, 409,
      'unapproved result cannot be consumed or downloaded');
    store.reviewAgentOutput(id, 'a-enterprise-results', true, 'A1 result accepted for internal analysis only');
    assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'ready');
    scheduler.pulse();
    await until(() => b1Holding, 'B1 should start before A2 ends');
    const middle = store.getProject(id);
    assert.equal(middle.steps['a-qc-results'].state, 'running');
    assert.equal(middle.steps['b-enterprise-analysis'].state, 'running');
    assert.equal(scheduler.activeCount, 2);
    assert.equal(middle.steps['c-final-output'].state, 'blocked');

    b1Gate.resolve();
    await until(() => store.getProject(id).steps['b-enterprise-analysis'].state === 'review',
      'B1 should finish while A2 still running');
    assert.equal(store.getProject(id).steps['a-qc-results'].state, 'running');
    store.reviewAgentOutput(id, 'b-enterprise-analysis', true, 'B1 conclusion internal review done');

    a2Gate.resolve();
    await until(() => store.getProject(id).steps['a-qc-results'].state === 'review',
      'A2 should eventually finish');
    store.reviewAgentOutput(id, 'a-qc-results', true, 'A2 is incomplete fixture, accepted for pipeline only');
    scheduler.pulse();
    await until(() => store.getProject(id).steps['b-qc-analysis'].state === 'review',
      'B2 should consume reviewed A2 result');
    store.reviewAgentOutput(id, 'b-qc-analysis', true, 'B2 conclusion reviewed');
    assert.equal(store.getProject(id).steps['human-conclusion-review'].state, 'ready');
    assert.equal(store.getProject(id).steps['c-final-output'].state, 'blocked');

    store.completeHuman(id, 'human-conclusion-review',
      '只允许内部展示：保留企业与质控结论的不确定性，绝不写作正式签发结论。');
    scheduler.pulse();
    await until(() => store.getProject(id).steps['c-final-output'].state === 'review',
      'C should generate final artifact after Human signoff');
    const cCandidate = store.getProject(id).artifacts.find(a => a.ownerId === 'c-final-output')!;
    assert.ok(cCandidate.content?.includes('# 环评 Agent 分阶段内部成果'));
    assert.equal((await exportArtifact(id, cCandidate.id)).status, 409,
      'the final file remains unavailable before C candidate is reviewed');
    store.reviewAgentOutput(id, 'c-final-output', true, 'C internal output final human acceptance');
    const file = await exportArtifact(id, cCandidate.id);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('Content-Disposition') ?? '', /eia-internal-final.md/);
    assert.match(await file.text(), /仅供内部专业审核/);
    const finished = store.getProject(id);
    assert.equal(finished.package.version, '1.0.0');
    assert.deepEqual(Object.fromEntries(finished.package.steps.map(s => [s.id, finished.steps[s.id].state])),
      Object.fromEntries(finished.package.steps.map(s => [s.id, 'done'])));
    assert.ok(started.indexOf('b-enterprise-analysis') < started.indexOf('b-qc-analysis'),
      'B1 must be allowed to start while another branch is still running');
  } finally {
    a2Gate.resolve();
    b1Gate.resolve();
    scheduler.stop();
    await scheduler.waitUntilIdle();
  }
});

test('A stage cannot silently submit prose as a JSON result', async () => {
  const id = createCase('Reject false JSON result');
  await assert.rejects(
    () => executeOneAgentTask(id, 'a-enterprise-results', {
      id: 'invalid-json-worker',
      async execute(task) {
        return { body: 'We found several facts but did not make a structured result',
          limitations: [], materialRequests: [], methodChecks: checks(task) };
      }
    }), /invalid JSON for the pinned JSON output contract/);
  assert.equal(store.getProject(id).steps['a-enterprise-results'].state, 'failed');
  assert.equal(store.getProject(id).artifacts.filter(a => a.kind === 'agent_output').length, 0);
});

test('a rejected A result cannot unlock B; retry and signoff are mandatory', async () => {
  const id = createCase('Rejected A output blocks downstream');
  const fixture: TaskExecutor = {
    id: 'fact-results-fixture',
    async execute(task) {
      return { body: JSON.stringify({ results: [{ observed: 'enterprise source supplied' }] }),
        limitations: [], materialRequests: [], methodChecks: checks(task) };
    }
  };
  await executeOneAgentTask(id, 'a-enterprise-results', fixture);
  assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'blocked');
  store.reviewAgentOutput(id, 'a-enterprise-results', false, 'Source quote is missing');
  assert.equal(store.getProject(id).steps['a-enterprise-results'].state, 'ready');
  assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'blocked');
  await executeOneAgentTask(id, 'a-enterprise-results', fixture);
  store.reviewAgentOutput(id, 'a-enterprise-results', true, 'Corrected original quote manually confirmed');
  assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'ready');
});
