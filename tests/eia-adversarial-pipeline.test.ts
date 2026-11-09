import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutorTask, TaskExecutor } from '../src/executors/contracts';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';

const folder = mkdtempSync(join(tmpdir(), 'hh-adversarial-abc-'));
process.env.HH_DATA_DIR = folder;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { GET: exportOutput } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => { try { rmSync(folder, { recursive: true, force: true }); } catch {} });

function project(label: string) {
  const p = store.createProject('eia-abc-pipeline', label);
  store.setExecutionPolicy(p.id, false, 2);
  const materials: Array<[string, string, string | null]> = [
    ['enterprise-original', '企业陈述：历史上使用过清洗剂，是否涉及地块不明。', null],
    ['enterprise-half-result', '{"facts":[{"topic":"cleaner","status":"reported"}]}', 'fields.json'],
    ['qc-scan', '%PDF synthetic unparsed original', 'scan.pdf'],
    ['qc-frozen-result', '{"results":[{"qc":"unverified"}]}', 'frozen.json'],
    ['word-reference', 'PK synthetic word', 'partial.docx']
  ];
  for (const [id, body, filename] of materials) {
    store.submitMaterial(p.id, id, filename ? '' : body,
      filename ? { name: filename, buffer: Buffer.from(body) } : undefined);
    store.reviewReceivedMaterial(p.id, id, true, 'Synthetic intake only; no professional endorsement');
  }
  return p.id;
}

const claimedPass = (task: ExecutorTask) => (task.workMethod?.checks ?? []).map(check => ({
  checkId: check.id,
  status: 'passed' as const,
  explanation: 'Agent claims this is verified; intentionally dishonest fixture',
  evidenceRefs: [task.evidence[0].artifactId]
}));

const wrongA: TaskExecutor = {
  id: 'adversarial-a',
  async execute(task) {
    assert.equal(task.packet.workItemId, 'a-enterprise-results');
    return {
      body: JSON.stringify({
        title: '家庭烹饪指南',
        ingredients: ['土豆', '巧克力'],
        steps: ['加热', '调味'],
        marker: 'UNRELATED_A_PAYLOAD'
      }),
      limitations: [],
      materialRequests: [],
      methodChecks: claimedPass(task)
    };
  }
};

const wrongB: TaskExecutor = {
  id: 'adversarial-b',
  async execute(task) {
    assert.equal(task.packet.workItemId, 'b-enterprise-analysis');
    assert.deepEqual(task.evidence.map(e => e.role), ['approved_derived']);
    assert.ok(task.evidence[0].content?.includes('cleaner'));
    return {
      body: '# 风险评估\n由于月球引力，地块已经自动修复，因此完全没有污染风险。UNFOUNDED_B_PAYLOAD',
      limitations: [],
      materialRequests: [],
      methodChecks: claimedPass(task)
    };
  }
};

test('irrelevant A output with valid JSON and forged green self-checks is NOT automatically approved or passed to B', async () => {
  const id = project('Irrelevant A candidate');
  await executeOneAgentTask(id, 'a-enterprise-results', wrongA);
  const p = store.getProject(id);
  assert.equal(p.steps['a-enterprise-results'].state, 'review');
  assert.equal(p.steps['b-enterprise-analysis'].state, 'blocked');
  assert.equal(p.artifacts.find(a => a.ownerId === 'a-enterprise-results')?.methodChecks?.every(
    check => check.status === 'passed'), true);
  assert.equal(deriveWorkbenchQueues(p).human.some(item =>
    item.id === 'a-enterprise-results'), true);
  const ref = p.artifacts.find(a => a.ownerId === 'a-enterprise-results')!.id;
  const response = await exportOutput(new Request('http://localhost/adversarial'),
    { params: Promise.resolve({ id, artifactId: ref }) });
  assert.equal(response.status, 409);
  // Crucial: this was not automatically semantically detected.
  // It was merely prevented from propagating until a Human decision.
});

test('A and B can each produce plausible-looking but false self-checks; Human rejection must isolate and repair the chain', async () => {
  const id = project('Human rejection against A and B contamination');

  // A: syntactically valid unrelated result; reject it and demand a relevant redo.
  await executeOneAgentTask(id, 'a-enterprise-results', wrongA);
  store.reviewAgentOutput(id, 'a-enterprise-results', false,
    '结果是菜谱，与环评任务无关；请重新抽取企业清洗剂陈述，并如实说明未知事项。');
  let p = store.getProject(id);
  assert.equal(p.steps['a-enterprise-results'].state, 'ready');
  assert.equal(p.steps['b-enterprise-analysis'].state, 'blocked');
  const badA = p.artifacts.find(a => a.ownerId === 'a-enterprise-results')!;
  assert.match(badA.content ?? '', /UNRELATED_A_PAYLOAD/);

  await executeOneAgentTask(id, 'a-enterprise-results', {
    id: 'corrected-a',
    async execute(task) {
      assert.equal(task.reviewFeedback.length, 1);
      assert.match(task.reviewFeedback[0], /与环评任务无关/);
      assert.ok(task.evidence.every(e => e.role === 'case_evidence'));
      return { body: JSON.stringify({
        facts: [{ topic: 'cleaner', claim: '企业陈述使用清洗剂', certainty: 'source-statement-only' }],
        unverified: ['地块关系']
      }), limitations: ['独立主体/空间关系未核实'],
      materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  p = store.getProject(id);
  assert.equal(p.steps['a-enterprise-results'].state, 'review');
  assert.equal(p.steps['b-enterprise-analysis'].state, 'blocked');
  store.reviewAgentOutput(id, 'a-enterprise-results', true, '人工核对 A 的修订来源；允许作为后续内部分析输入。');
  assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'ready');

  // B: starts only after A is approved and must not see previously rejected A.
  await executeOneAgentTask(id, 'b-enterprise-analysis', wrongB);
  p = store.getProject(id);
  assert.equal(p.steps['b-enterprise-analysis'].state, 'review');
  assert.equal(p.steps['human-conclusion-review'].state, 'blocked');
  const badB = p.artifacts.find(a => a.ownerId === 'b-enterprise-analysis')!;
  assert.match(badB.content ?? '', /UNFOUNDED_B_PAYLOAD/);
  assert.equal((await exportOutput(new Request('http://localhost/adversarial'),
    { params: Promise.resolve({ id, artifactId: badB.id }) })).status, 409);

  store.reviewAgentOutput(id, 'b-enterprise-analysis', false,
    '月球引力与污染结论无关，不能从企业陈述推出完全无风险；必须基于 A 的事实重新分析。');
  assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'ready');

  await executeOneAgentTask(id, 'b-enterprise-analysis', {
    id: 'corrected-b',
    async execute(task) {
      assert.equal(task.evidence.length, 1);
      assert.equal(task.evidence[0].role, 'approved_derived');
      assert.match(task.evidence[0].content ?? '', /source-statement-only/);
      assert.doesNotMatch(task.evidence[0].content ?? '', /UNRELATED_A_PAYLOAD/);
      assert.equal(task.reviewFeedback.length, 1);
      assert.match(task.reviewFeedback[0], /月球引力与污染结论无关/);
      return { body: '## 企业分析\n清洗剂使用仅见于企业陈述，缺少地块关联，不能直接认定污染风险大小。',
        limitations: ['空间关系未证实'],
        materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  store.reviewAgentOutput(id, 'b-enterprise-analysis', true, '人工确认结论边界与 A 的来源一致。');

  // Finish unrelated branch to unlock the human join and C.
  await executeOneAgentTask(id, 'a-qc-results', {
    id: 'qc-a',
    async execute(task) {
      return { body: JSON.stringify({ results: [{ status: 'unverified' }] }),
        limitations: ['PDF 未识读'], materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  store.reviewAgentOutput(id, 'a-qc-results', true, '仅核实内部流程，不等于 PDF 质控通过。');
  await executeOneAgentTask(id, 'b-qc-analysis', {
    id: 'qc-b',
    async execute(task) {
      return { body: '## 质控分析\n未核实数据，不能判定质控合格。',
        limitations: ['原件未视觉解析'], materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  store.reviewAgentOutput(id, 'b-qc-analysis', true, '限制条件保留');
  assert.equal(store.getProject(id).steps['human-conclusion-review'].state, 'ready');
  store.completeHuman(id, 'human-conclusion-review',
    '保留两路真实限制，只供内部参考，禁止采纳退回过的菜谱和月球结论。');

  await executeOneAgentTask(id, 'c-final-output', {
    id: 'final-c',
    async execute(task) {
      assert.equal(task.evidence.length, 2);
      assert.ok(task.evidence.every(e => e.role === 'approved_derived'));
      assert.equal(task.evidence.some(e => /UNRELATED_A_PAYLOAD|UNFOUNDED_B_PAYLOAD/.test(
        e.content ?? '')), false, 'C may not ingest rejected candidates');
      assert.match(task.humanHandoffs?.[0]?.value ?? '', /禁止采纳/);
      return { body: '# 内部结论\n企业清洗剂陈述和质控来源均有未核实事项，不得作出确定性污染结论。',
        limitations: ['没有独立专业证据'],
        materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  p = store.getProject(id);
  assert.equal(p.steps['c-final-output'].state, 'review');
  assert.equal((await exportOutput(new Request('http://localhost/adversarial'),
    { params: Promise.resolve({ id, artifactId: p.artifacts.at(-1)!.id }) })).status, 409);
  store.reviewAgentOutput(id, 'c-final-output', true, '对错误结果的污染隔离检查通过');
  const final = await exportOutput(new Request('http://localhost/adversarial'),
    { params: Promise.resolve({ id, artifactId: p.artifacts.at(-1)!.id }) });
  assert.equal(final.status, 200);
  const body = await final.text();
  assert.doesNotMatch(body, /UNRELATED_A_PAYLOAD|UNFOUNDED_B_PAYLOAD/);
  assert.match(body, /不得作出确定性污染结论/);
  assert.equal(store.getProject(id).artifacts.filter(a =>
    a.ownerId === 'a-enterprise-results').length, 2);
  assert.equal(store.getProject(id).artifacts.filter(a =>
    a.ownerId === 'b-enterprise-analysis').length, 2);
});

test('EXPECTED: approved irrelevant A result contaminates B, bogus B conclusion contaminates C and is downloadable after signoff', async () => {
  const id = project('Intentional contamination validates stage isolation');
  await executeOneAgentTask(id, 'a-enterprise-results', wrongA);
  // The Human choice is intentionally to ACCEPT an unrelated artifact for this
  // stage-isolation exercise. There is no cross-stage source revalidation.
  store.reviewAgentOutput(id, 'a-enterprise-results', true,
    'INTENTIONAL HANDOFF: accept irrelevant valid JSON without semantic revalidation');
  const p = store.getProject(id);
  assert.equal(p.steps['b-enterprise-analysis'].state, 'ready');
  await executeOneAgentTask(id, 'b-enterprise-analysis', {
    id: 'observes-upstream-poison',
    async execute(task) {
      assert.equal(task.evidence.length, 1);
      assert.deepEqual(task.evidence.map(e => e.role), ['approved_derived']);
      assert.equal(task.evidence[0].name, 'enterprise-results.json');
      assert.match(task.evidence[0].content ?? '', /UNRELATED_A_PAYLOAD/,
        'approved unrelated A result is the sole input for B');
      assert.equal(task.evidence.some(e => /enterprise\.json|qc\.pdf|partial\.docx/.test(e.name)), false,
        'B must not reread source files even to disprove a bad A result');
      return { body: '胡扯分析：从土豆配方推导地块的污染全部消失。',
        limitations: [], materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  assert.equal(store.getProject(id).steps['b-enterprise-analysis'].state, 'review');
  assert.equal(store.getProject(id).steps['c-final-output'].state, 'blocked',
    'at least B still needs Human approval');

  // Continue the intentionally contaminated but correctly delegated pipeline.
  store.reviewAgentOutput(id, 'b-enterprise-analysis', true,
    'INTENTIONAL HANDOFF: accept nonsensical B conclusion as next stage input');
  await executeOneAgentTask(id, 'a-qc-results', {
    id: 'qc-source-fixture',
    async execute(task) {
      return { body: JSON.stringify({ results: [{ status: 'unverified' }] }),
        limitations: [], materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  store.reviewAgentOutput(id, 'a-qc-results', true, 'QC branch approved solely for controlled simulation');
  await executeOneAgentTask(id, 'b-qc-analysis', {
    id: 'qc-analysis-fixture',
    async execute(task) {
      return { body: '## 质控分析\n未取得完整结果，不能直接判定合格。',
        limitations: [], materialRequests: [], methodChecks: claimedPass(task) };
    }
  });
  store.reviewAgentOutput(id, 'b-qc-analysis', true, 'QC limitation kept');
  store.completeHuman(id, 'human-conclusion-review',
    'INTENTIONAL HANDOFF: continue with B conclusions without rereading A or source files.');
  assert.equal(store.getProject(id).steps['c-final-output'].state, 'ready');

  await executeOneAgentTask(id, 'c-final-output', {
    id: 'c-sees-poison-fixture',
    async execute(task) {
      assert.equal(task.evidence.length, 2);
      assert.ok(task.evidence.every(e => e.role === 'approved_derived'));
      assert.deepEqual(task.evidence.map(e => e.name).sort(),
        ['enterprise-conclusion.md', 'qc-conclusion.md']);
      assert.ok(task.evidence.some(e => (e.content ?? '').includes('土豆配方')),
        'C actually receives B\'s nonsensical approved conclusion');
      assert.ok(task.evidence.every(e => !/\.json$|\.pdf$|\.docx$/.test(e.name)),
        'C must never reread A results or original source files');
      return {
        body: '# 恶化流水线验收样稿\n污染被土豆配方消除。POISONED_C_CANDIDATE',
        limitations: [], materialRequests: [], methodChecks: claimedPass(task)
      };
    }
  });
  const state = store.getProject(id);
  const candidate = state.artifacts.find(a => a.ownerId === 'c-final-output')!;
  assert.match(candidate.content ?? '', /POISONED_C_CANDIDATE/);
  assert.equal(state.steps['c-final-output'].state, 'review');
  assert.equal((await exportOutput(new Request('http://localhost/adversarial'),
    { params: Promise.resolve({ id, artifactId: candidate.id }) })).status, 409,
    'even corrupted C output still requires final Human approval');
  // Approval is a Human workflow decision, NOT a semantic truth certification.
  // The intended test is successful handoff of incorrect content across stages.
  store.reviewAgentOutput(id, 'c-final-output', true,
    'INTENTIONAL PIPELINE TEST: authorize publishing the knowingly incorrect fixture');
  const final = await exportOutput(new Request('http://localhost/adversarial'),
    { params: Promise.resolve({ id, artifactId: candidate.id }) });
  assert.equal(final.status, 200, 'C file is downloadable after explicit final signoff');
  assert.match(final.headers.get('Content-Disposition') ?? '', /eia-internal-final\.md/);
  const contents = await final.text();
  assert.match(contents, /POISONED_C_CANDIDATE/);
  assert.match(contents, /污染被土豆配方消除/);
  assert.equal(store.getProject(id).steps['c-final-output'].state, 'done');
});
