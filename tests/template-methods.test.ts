import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import example from '../examples/technical-spec-review.hh.json';
import { packageSchema } from '../src/protocol/v1';
import { renderTextContext, type TaskExecutor } from '../src/executors/contracts';

const folder = mkdtempSync(join(tmpdir(), 'hh-method-pilot-'));
process.env.HH_DATA_DIR = folder;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { deriveWorkbenchQueues, groupAgentTasks } = await import('../src/app/workbench-queue');
after(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* Windows cleanup */ } });

function createPilot(suffix: string) {
  const p = store.createProject('technical-spec-review', suffix);
  store.setExecutionPolicy(p.id, false, 3);
  store.submitMaterial(p.id, 'purchase-spec',
    '正式采购需求 2026-10-05：型号机组M；要求额定电压220 V，功率7.5 kW。');
  store.reviewReceivedMaterial(p.id, 'purchase-spec', true, '来源与单位已核对');
  store.submitMaterial(p.id, 'supplier-spec',
    '供方型号M：额定电压380 V，功率7.5 kW。未附规格表版本号。');
  store.reviewReceivedMaterial(p.id, 'supplier-spec', true, '原文来源有效，缺少版次需单独澄清');
  return p.id;
}

function checked(task: Parameters<TaskExecutor['execute']>[0],
                 status: 'passed' | 'failed' | 'unverified' = 'passed',
                 explanation = '此检查的来源已按模板列示') {
  const ref = task.evidence[0]?.artifactId;
  return (task.workMethod?.checks ?? []).map(check => ({
    checkId: check.id, status, explanation,
    evidenceRefs: ref ? [ref] : []
  }));
}

test('template methods are scoped by Agent and material; legacy templates remain valid', () => {
  const pkg = packageSchema.parse(example);
  assert.equal(pkg.agents?.length, 3);
  assert.equal(pkg.materials[0].method?.verification.length, 2);
  assert.equal(pkg.steps.find(s => s.id === 'check-demand')?.method?.checks.length, 2);
  assert.equal(pkg.steps.find(s => s.id === 'resolve-conflict')?.method, undefined);
  assert.ok(store.listPackages().some(p => p.id === 'technical-spec-review' && p.builtin));
  const broken = structuredClone(example) as any;
  broken.steps[0].method.checks[1].id = broken.steps[0].method.checks[0].id;
  assert.equal(packageSchema.safeParse(broken).success, false);
  broken.steps[0].method.checks[1].id = 'distinct';
  broken.steps[2].method = broken.steps[0].method;
  assert.equal(packageSchema.safeParse(broken).success, false);
  const legacy = packageSchema.parse({
    ...example, materials: example.materials.map(({ method: _m, ...m }) => m),
    steps: example.steps.map(({ method: _m, ...step }) => step)
  });
  assert.ok(legacy.steps.every(step => !step.method));
});

test('parallel three-Agent method-driven project: Human clarification, explicit exception, resolution and delivery', async () => {
  const id = createPilot('Pilot complete workflow');
  const initial = store.getProject(id);
  const lanes = groupAgentTasks(initial, deriveWorkbenchQueues(initial).agent);
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].counts.ready, 1);
  assert.equal(lanes[1].counts.ready, 1);
  assert.equal(lanes[2].counts.blocked, 1);

  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let observed = 0;
  const demand: TaskExecutor = {
    id: 'fixture-demand-analyser',
    async execute(task) {
      observed++;
      assert.equal(task.packet.workItemId, 'check-demand');
      assert.equal(task.evidence.length, 1);
      assert.equal(task.materialMethods?.length, 1);
      assert.equal(task.materialMethods?.[0].materialId, 'purchase-spec');
      assert.match(renderTextContext(task), /PINNED WORK METHOD/);
      assert.match(renderTextContext(task), /SCOPED MATERIAL METHODS/);
      assert.doesNotMatch(renderTextContext(task), /供应商当前版次的产品规格原文/);
      await barrier;
      return { body: '需求要求：220 V / 7.5 kW；原文第1段。',
        limitations: [], materialRequests: [], methodChecks: checked(task) };
    }
  };
  const supplierNeedsInput: TaskExecutor = {
    id: 'fixture-supplier-analyser',
    async execute(task) {
      observed++;
      assert.equal(task.packet.workItemId, 'check-supplier');
      assert.equal(task.evidence.length, 1);
      assert.equal(task.evidence[0].role, 'case_evidence');
      assert.equal(task.workMethod?.onMissing, 'request_human');
      await barrier;
      return { body: '供应商原件缺版次。',
        limitations: ['供应商版次未确认'],
        materialRequests: [{ materialId: 'supplier-spec', reason: '请确认规格表版次及确认方式。' }] };
    }
  };
  const a = executeOneAgentTask(id, 'check-demand', demand);
  const b = executeOneAgentTask(id, 'check-supplier', supplierNeedsInput);
  assert.equal(store.getProject(id).steps['check-demand'].state, 'running');
  assert.equal(store.getProject(id).steps['check-supplier'].state, 'running');
  release();
  await Promise.all([a, b]);
  assert.equal(observed, 2);
  assert.equal(store.getProject(id).steps['check-demand'].state, 'review');
  assert.equal(store.getProject(id).steps['check-supplier'].state, 'waiting_input');
  assert.equal(store.getProject(id).steps['publish-draft'].state, 'blocked');
  assert.equal(deriveWorkbenchQueues(store.getProject(id)).human.filter(i => i.kind === 'request').length, 1);
  assert.deepEqual(store.getProject(id).artifacts
    .filter(a => a.kind === 'agent_output').map(a => a.ownerId), ['check-demand']);

  store.reviewAgentOutput(id, 'check-demand', true, '已逐项核实来源');
  const requestId = store.getProject(id).humanRequests![0].id;
  store.answerRequestedInput(id, requestId, '邮件称为2026-10版，但目前没有正式盖章规格表。');
  assert.equal(store.getProject(id).steps['check-supplier'].state, 'ready');

  await executeOneAgentTask(id, 'check-supplier', {
    id: 'fixture-supplier-after-human',
    async execute(task) {
      assert.match(task.humanHandoffs?.[0]?.value ?? '', /邮件称为2026-10版/);
      assert.equal(task.evidence.length, 1);
      return {
        body: '供应商：380 V / 7.5 kW；版次依据只有邮件说明。',
        limitations: ['供应商版次缺乏正式原件'],
        materialRequests: [], methodChecks: [
          { checkId: 'supplier-trace', status: 'passed' as const,
            explanation: '供应商原件第1段载明参数', evidenceRefs: [task.evidence[0].artifactId] },
          { checkId: 'supplier-edition', status: 'unverified' as const,
            explanation: '只有人类转述邮件，未核实正式版本', evidenceRefs: [task.evidence[0].artifactId] }
        ]
      };
    }
  });
  assert.throws(() => store.reviewAgentOutput(id, 'check-supplier', true, ''),
    /Unresolved method checks/);
  store.reviewAgentOutput(id, 'check-supplier', true,
    '人工仅批准将它作为带有版次限制的候选信息，不认定供应商满足需求。');
  const before = store.getProject(id);
  assert.equal(before.steps['resolve-conflict'].state, 'ready');
  store.completeHuman(id, 'resolve-conflict',
    '需求明确为220 V；供方仅提供380 V，暂判定不匹配；必须要求供应商提供正式适配说明。');
  const after = store.getProject(id);
  assert.equal(after.steps['publish-draft'].state, 'ready');

  await executeOneAgentTask(id, 'publish-draft', {
    id: 'fixture-final-analyst',
    async execute(task) {
      assert.equal(task.evidence.length, 4); // 2 current originals + 2 approved Agent derivatives
      assert.equal(task.evidence.filter(e => e.role === 'approved_derived').length, 2);
      assert.equal(task.humanHandoffs?.length, 1);
      assert.match(task.humanHandoffs?.[0].value ?? '', /暂判定不匹配/);
      assert.equal(task.workMethod?.checks.length, 2);
      return { body: [
        '# 待审技术规格差异记录',
        '需求 220 V / 7.5 kW（需求原件）；供应商声明 380 V / 7.5 kW（供应商原件）。',
        '人工意见：暂不匹配。供应商规格的正式版次仍需确认，要求提交适配说明。'
      ].join('\n'),
      limitations: ['未取得正式版次确认文件'], materialRequests: [],
      methodChecks: checked(task) };
    }
  });
  assert.equal(store.getProject(id).steps['publish-draft'].state, 'review');
  assert.equal(store.getProject(id).artifacts.filter(a => a.kind === 'agent_output').length, 3);
  store.reviewAgentOutput(id, 'publish-draft', true, '两份来源和人工决定均已对应');
  assert.equal(store.getProject(id).steps['publish-draft'].state, 'done');
  assert.equal(store.getProject(id).steps['check-demand'].state, 'done');
  assert.equal(store.getProject(id).steps['check-supplier'].state, 'done');
});

test('missing, invented, duplicate or out-of-scope check results fail before Human review', async () => {
  async function trial(label: string,
    makeChecks: (task: Parameters<TaskExecutor['execute']>[0]) =>
      Array<{ checkId: string; status: 'passed' | 'failed' | 'unverified'; explanation: string; evidenceRefs: string[] }>) {
    const id = createPilot(label);
    await assert.rejects(() => executeOneAgentTask(id, 'check-demand', {
      id: 'bad-check-fixture',
      async execute(task) {
        return { body: 'Invalid result', limitations: [], materialRequests: [],
          methodChecks: makeChecks(task) };
      }
    }), /method check|method checks/i);
    assert.equal(store.getProject(id).steps['check-demand'].state, 'failed');
    assert.equal(store.getProject(id).artifacts.filter(a => a.kind === 'agent_output').length, 0);
  }
  await trial('check missing', task => checked(task).slice(0, 1));
  await trial('check duplicate', task => [checked(task)[0], checked(task)[0]]);
  await trial('check invented', task => [...checked(task).slice(0, 1),
    { checkId: 'invented', status: 'passed', explanation: 'untracked', evidenceRefs: [] }]);
  await trial('check unauthorized ref', task => checked(task).map(check => ({
    ...check, evidenceRefs: ['not-authorized-in-this-run'] })));
});

test('no self-certified pass: Demo checks remain unverified, requiring Human rationale', async () => {
  const id = createPilot('demo unverified');
  const { demoExecutor } = await import('../src/executors/demo');
  await executeOneAgentTask(id, 'check-demand', demoExecutor);
  const p = store.getProject(id);
  assert.equal(p.steps['check-demand'].state, 'review');
  assert.deepEqual(p.artifacts.at(-1)?.methodChecks?.map(c => c.status),
    ['unverified', 'unverified']);
  assert.throws(() => store.reviewAgentOutput(id, 'check-demand', true, ''),
    /Unresolved method checks/);
});
