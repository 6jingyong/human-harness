import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manualProjectPackage } from '../src/protocol/manual';
import { packageSchema } from '../src/protocol/v1';
import { type TaskExecutor } from '../src/executors/contracts';

const dir = mkdtempSync(join(tmpdir(), 'hh-pinned-script-'));
process.env.HH_DATA_DIR = dir;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { LocalScheduler } = await import('../src/executors/scheduler');
const { GET: downloadOutput } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function scriptTemplate(id: string) {
  const base = manualProjectPackage({
    id, title: 'Draft → Human → deterministic assembly',
    description: 'Safe deterministic text assembly without additional model tokens',
    inputs: 'First source statement', objective: 'Write conclusions from source statement'
  });
  const pkg = packageSchema.parse({
    ...base,
    capabilities: [...base.capabilities, {
      id: 'hh.render.markdown', kind: 'script',
      description: 'Built-in, allowlisted Markdown assembly; not user-supplied code'
    }],
    steps: [...base.steps,
      {
        id: 'accept', stageId: 'work', kind: 'human_action',
        title: 'Review conclusions', instructions: 'Human confirms whether to include draft',
        dependsOn: ['draft'], needsMaterials: []
      },
      {
        id: 'assemble', stageId: 'work', kind: 'script',
        title: 'Deterministic final assembly', instructions: 'Assemble approved results verbatim',
        dependsOn: ['draft', 'accept'], needsMaterials: [], capabilityId: 'hh.render.markdown',
        outputContractId: 'assembled-output', requiresReview: true,
        method: {
          procedure: ['Include approved previous-stage conclusions verbatim'],
          checks: [{ id: 'result-reviewed', criterion: 'Verify subject matter before release' }],
          onMissing: 'record_limitation'
        }
      }
    ],
    outputs: [...base.outputs, {
      id: 'assembled-output', title: 'Approved conclusions assembled',
      audience: 'internal', fileName: 'combined.md', format: 'markdown',
      producingStepId: 'assemble', acceptance: ['Matches approved upstream conclusions'],
      humanSignoff: true
    }]
  });
  return pkg;
}
function create(id: string) {
  const pkg = scriptTemplate(id);
  store.importPackage(pkg);
  const project = store.createProject(id, 'Pinned deterministic pipeline');
  store.setExecutionPolicy(project.id, false, 2);
  store.submitMaterial(project.id, 'input-01', 'PRIVATE_SOURCE_ONLY_FOR_UPSTREAM_STEP');
  store.reviewReceivedMaterial(project.id, 'input-01', true, 'Synthetic fixture source');
  return project.id;
}
const badUpstream: TaskExecutor = {
  id: 'intentional-poison',
  async execute() {
    return {
      body: '## 已批准分析结论\n故意错误结论：土豆菜谱能够消除污染。POISONED_B_CONCLUSION',
      limitations: [], materialRequests: []
    };
  }
};
const read = (id: string, artifactId: string) => downloadOutput(
  new Request('http://localhost/script-download'), {
    params: Promise.resolve({ id, artifactId })
  }
);

test('script WorkItem uses ONLY accepted derived results; preserves wrong conclusions and Human handoff verbatim', async () => {
  const id = create('script-internal-poison-test');
  assert.equal(store.getProject(id).steps.assemble.state, 'blocked');
  await executeOneAgentTask(id, 'draft', badUpstream);
  assert.equal(store.getProject(id).steps.assemble.state, 'blocked');
  store.reviewAgentOutput(id, 'draft', true, 'Intentionally approved wrong text for handoff test');
  store.completeHuman(id, 'accept', '人为决定原样传递，不在格式化时复查上游事实。');

  // Even if a test provides a hostile executor override, script steps must use
  // the registered renderer, NEVER a model or arbitrary caller supplied code.
  const poisonOverride: TaskExecutor = {
    id: 'must-not-be-called',
    async execute() { throw new Error('Script incorrectly routed to an injected Agent'); }
  };
  await executeOneAgentTask(id, 'assemble', poisonOverride);
  const p = store.getProject(id);
  assert.equal(p.steps.assemble.state, 'review');
  const artifact = p.artifacts.find(a => a.kind === 'agent_output' && a.ownerId === 'assemble')!;
  assert.match(artifact.content ?? '', /POISONED_B_CONCLUSION/);
  assert.doesNotMatch(artifact.content ?? '', /PRIVATE_SOURCE_ONLY_FOR_UPSTREAM_STEP/,
    'Script must not reread source material');
  assert.match(artifact.content ?? '', /人为决定原样传递/);
  assert.deepEqual(artifact.methodChecks?.map(check => check.status), ['unverified'],
    'Template professional truth checks cannot be certified by deterministic formatting');
  assert.equal((await read(id, artifact.id)).status, 409);
  assert.throws(() => store.reviewAgentOutput(id, 'assemble', true, ''), /Unresolved method checks/);
  store.reviewAgentOutput(id, 'assemble', true, 'Only formatting approved; semantic accuracy not rechecked');
  const exported = await read(id, artifact.id);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('Content-Disposition') ?? '', /combined.md/);
  assert.match(await exported.text(), /POISONED_B_CONCLUSION/);
});

test('no arbitrary source-code execution capability or raw-source script input can be imported', () => {
  const original = scriptTemplate('script-reject-safety');
  const untrusted: any = structuredClone(original);
  untrusted.capabilities.find((c: any) => c.id === 'hh.render.markdown').id = 'unsafe.shell';
  untrusted.steps.find((s: any) => s.id === 'assemble').capabilityId = 'unsafe.shell';
  assert.throws(() => store.importPackage(untrusted), /capability not installed|unsupported deterministic script/);

  const rawSource: any = structuredClone(original);
  rawSource.steps.find((s: any) => s.id === 'assemble').needsMaterials = ['input-01'];
  assert.throws(() => store.importPackage(rawSource), /only accepts approved upstream outputs/);

  const external: any = structuredClone(original);
  external.outputs.find((o: any) => o.id === 'assembled-output').audience = 'external';
  assert.throws(() => store.importPackage(external), /only supports an internal Markdown output/);
});

test('local scheduler automatically dispatches eligible script step after Human review without a model call', async () => {
  const id = create('script-auto-dispatch-test');
  const errors: string[] = [];
  const scheduler = new LocalScheduler(badUpstream, 2, error => errors.push(error));
  try {
    store.setExecutionPolicy(id, true, 2);
    scheduler.pulse();
    await scheduler.waitUntilIdle();
    assert.equal(store.getProject(id).steps.draft.state, 'review');
    assert.equal(store.getProject(id).steps.assemble.state, 'blocked');
    store.reviewAgentOutput(id, 'draft', true, 'Source deliberately accepted');
    store.completeHuman(id, 'accept', '仅执行确定性格式组装。');
    scheduler.pulse();
    await scheduler.waitUntilIdle();
    assert.deepEqual(errors, []);
    assert.equal(store.getProject(id).steps.assemble.state, 'review');
    const candidate = store.getProject(id).artifacts.filter(a => a.ownerId === 'assemble').at(-1)!;
    assert.match(candidate.content ?? '', /POISONED_B_CONCLUSION/);
  } finally {
    scheduler.stop();
    await scheduler.waitUntilIdle();
  }
});
