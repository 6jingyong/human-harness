/**
 * Live A→B→C stage-isolation drill.
 *
 * Usage on a local machine with authenticated Codex:
 *   HH_EXECUTOR=codex npm run codex:abc:live -- --scenario=real
 *   HH_EXECUTOR=codex npm run codex:abc:live -- --scenario=poison-a
 *   HH_EXECUTOR=codex npm run codex:abc:live -- --scenario=poison-ab
 *
 * IMPORTANT:
 * - No fallback to Demo or mocked model is allowed for stages marked "codex".
 * - Uses synthetic EIA-like text ONLY, never uploads private EIA originals.
 * - Human approvals are deliberately scripted for this stage-routing drill and
 *   do not constitute a professional review.
 * - Codex stages have fresh ephemeral sessions and no staged PDF/DOCX.
 * - This verifies authorized *model input packets* and observes tool attempts.
 *   It is not proof of OS-level filesystem-read isolation on all Codex versions.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExecutorOutput, ExecutorTask, TaskExecutor } from '../src/executors/contracts';

type Scenario = 'real' | 'poison-a' | 'poison-ab';
const arg = process.argv.find(a => a.startsWith('--scenario='));
const scenario = (arg?.slice('--scenario='.length) || 'poison-a') as Scenario;
if (!['real', 'poison-a', 'poison-ab'].includes(scenario)) {
  throw new Error('Expected --scenario=real|poison-a|poison-ab');
}
const outdir = resolve(process.env.HH_EVAL_OUT ||
  join(process.cwd(), '.human-harness-live-eval', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(outdir, { recursive: true });
process.env.HH_DATA_DIR = join(outdir, 'runtime');
const resultPath = join(outdir, 'report.json');
const report: {
  scenario: Scenario; status: 'started' | 'complete' | 'failed';
  authenticity: string; projectId?: string; stages: unknown[];
  assertions: string[]; observations: Record<string, boolean | string | number>;
  failure?: string;
} = {
  scenario, status: 'started',
  authenticity: 'Only stages explicitly labeled codex are live authenticated model calls; remaining stages are declared fault-injection fixtures.',
  stages: [], assertions: [], observations: {}
};
const save = () => writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
save();

const code = process.env.HH_CODEX_COMMAND || 'codex';
const probe = spawnSync(code, ['--version'], { encoding: 'utf8', timeout: 12000 });
if (probe.error || probe.status !== 0) {
  report.status = 'failed';
  report.failure = 'Codex CLI not installed/available on PATH; no live model was called';
  save();
  process.stderr.write(report.failure + '\nReport: ' + resultPath + '\n');
  process.exit(1);
}

function checks(task: ExecutorTask) {
  return (task.workMethod?.checks ?? []).map(check => ({
    checkId: check.id, status: 'unverified' as const,
    explanation: 'Deliberate stage isolation test, not a professional source validation',
    evidenceRefs: []
  }));
}
const injected: TaskExecutor = {
  id: 'explicit-fault-injection-not-a-model',
  async execute(task): Promise<ExecutorOutput> {
    const step = task.packet.workItemId;
    if (step === 'a-enterprise-results') return {
      body: JSON.stringify({ title: '家庭菜谱', ingredients: ['土豆', '巧克力'],
        marker: 'UNRELATED_A_PAYLOAD' }),
      limitations: [], materialRequests: [], methodChecks: checks(task)
    };
    if (step === 'b-enterprise-analysis') return {
      body: '## 企业分析结论\n土豆配方可使污染自行消失。UNFOUNDED_B_PAYLOAD',
      limitations: [], materialRequests: [], methodChecks: checks(task)
    };
    if (step === 'a-qc-results') return {
      body: JSON.stringify({ results: [{ status: 'unverified' }] }),
      limitations: ['QC input is synthetic and was not visually parsed'],
      materialRequests: [], methodChecks: checks(task)
    };
    if (step === 'b-qc-analysis') return {
      body: '## 质控结论\n没有原件视觉核验，不能声称质控通过。',
      limitations: ['No visual verification'], materialRequests: [],
      methodChecks: checks(task)
    };
    throw new Error('No fixture for ' + step);
  }
};

async function main() {
  const store = await import('../src/core/store');
  const { executeOneAgentTask } = await import('../src/executors/runner');
  const { codexExecutor } = await import('../src/executors/codex');
  const { GET: download } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');

  const project = store.createProject('eia-abc-pipeline', 'Stage isolation live drill ' + randomUUID().slice(0, 8));
  report.projectId = project.id;
  store.setExecutionPolicy(project.id, false, 2);
  for (const [id, body, filename] of [
    ['enterprise-original', '企业自述曾使用清洗剂；与调查红线的关系尚无证据。', ''],
    ['enterprise-half-result', '{"items":[{"id":"source-1","quote":"使用清洗剂","certainty":"self-reported"}]}', 'existing.json'],
    ['qc-scan', '%PDF-1.7 synthetic non-parseable', 'fake.pdf'],
    ['qc-frozen-result', '{"results":[{"name":"QC","certainty":"unverified"}]}', 'frozen.json'],
    ['word-reference', 'PK synthetic non-parseable', 'existing.docx']
  ] as const) {
    store.submitMaterial(project.id, id, filename ? '' : body,
      filename ? { name: filename, buffer: Buffer.from(body) } : undefined);
    store.reviewReceivedMaterial(project.id, id, true,
      'Synthetic input accepted for model role-routing experiment only');
  }

  async function run(stepId: string, executor: TaskExecutor) {
    let callNumber = 0;
    const monitor: TaskExecutor = {
      id: 'stage-boundary-monitor:' + executor.id,
      async execute(task, onEvent, signal) {
        callNumber++;
        const input = task.evidence.map(e => ({
          role: e.role, name: e.name, artifactId: e.artifactId, revision: e.revision
        }));
        if (stepId.startsWith('b-')) {
          if (!input.every(e => e.role === 'approved_derived') ||
              input.some(e => /\\.pdf$|\\.docx$|^existing\\.json$|^frozen\\.json$/.test(e.name))) {
            throw new Error('B received unauthorized original or non-derived input');
          }
          report.assertions.push(stepId + ': B saw approved A result only');
        }
        if (stepId === 'c-final-output') {
          const names = input.map(e => e.name).sort();
          if (JSON.stringify(names) !== JSON.stringify(['enterprise-conclusion.md', 'qc-conclusion.md']) ||
              !input.every(e => e.role === 'approved_derived')) {
            throw new Error('C received an A result or original instead of B-only conclusions');
          }
          report.assertions.push('C saw only two approved B conclusions');
        }
        const output = await executor.execute(task, onEvent, signal);
        report.stages.push({
          stepId, attempt: callNumber, actor: executor === codexExecutor ? 'codex-live' : 'injected-fixture',
          inputs: input, outputBody: output.body, limitations: output.limitations,
          materialRequests: output.materialRequests, methodChecks: output.methodChecks
        });
        save();
        return output;
      }
    };
    await executeOneAgentTask(project.id, stepId, monitor);
    let status = store.getProject(project.id).steps[stepId].state;
    if (status === 'waiting_input') {
      const questions = store.getProject(project.id).humanRequests?.filter(r =>
        r.stepId === stepId && r.status === 'pending') ?? [];
      for (const question of questions) {
        store.answerRequestedInput(project.id, question.id,
          '本次测试无法提供进一步证明，请保持来源限制，不重新打开其他阶段原件。');
      }
      await executeOneAgentTask(project.id, stepId, monitor);
      status = store.getProject(project.id).steps[stepId].state;
    }
    if (status !== 'review') throw new Error(stepId + ' ended in ' + status + ', not review');
    store.reviewAgentOutput(project.id, stepId, true,
      'INTENTIONAL HANDOFF: approval validates packet routing only, not truthfulness of contents');
  }

  const modelForA = scenario === 'real' ? codexExecutor : injected;
  const modelForB = scenario === 'poison-ab' ? injected : codexExecutor;
  await run('a-enterprise-results', modelForA);
  await run('a-qc-results', injected);
  await run('b-enterprise-analysis', modelForB);
  await run('b-qc-analysis', injected);

  store.completeHuman(project.id, 'human-conclusion-review',
    '本次只批准处理流水线交接，不对分析内容真实性作保证。允许故意错误沿链路传播。');
  await run('c-final-output', codexExecutor);

  const final = store.getProject(project.id).artifacts.filter(a =>
    a.kind === 'agent_output' && a.ownerId === 'c-final-output').at(-1);
  if (!final) throw new Error('Missing C output artifact');
  const response = await download(new Request('http://localhost/outputs/' + final.id),
    { params: Promise.resolve({ id: project.id, artifactId: final.id }) });
  if (response.status !== 200) throw new Error('C export status ' + response.status);
  const result = await response.text();
  writeFileSync(join(outdir, 'eia-internal-final.md'), result);
  report.assertions.push('Approved C output was actually downloadable (HTTP 200)');
  const b1 = (report.stages as Array<{ stepId: string; outputBody: string }>)
    .filter(stage => stage.stepId === 'b-enterprise-analysis').at(-1)?.outputBody || '';
  report.observations = {
    aInjected: scenario !== 'real',
    bInjected: scenario === 'poison-ab',
    bResultMentionsPoisonA: /UNRELATED_A_PAYLOAD|菜谱|土豆|巧克力/.test(b1),
    cResultMentionsBogusB: /UNFOUNDED_B_PAYLOAD|土豆|污染.{0,15}消失/.test(result),
    cContainsExactBMarker: result.includes('UNFOUNDED_B_PAYLOAD'),
    cContainsExactAMarker: result.includes('UNRELATED_A_PAYLOAD'),
    finalBytes: Buffer.byteLength(result, 'utf8')
  };
  // Whether a real model preserves nonsensical content is an *observation*, not
  // an invariant. A model may restate an unsupported B claim as uncertainty
  // without reopening any forbidden source; scope is checked separately.
  report.status = 'complete';
  save();
  process.stdout.write('LIVE STAGE DRILL COMPLETED\nreport: ' + resultPath +
    '\nfinal file: ' + join(outdir, 'eia-internal-final.md') + '\n');
}

try {
  await main();
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.message : String(error);
  save();
  process.stderr.write('LIVE STAGE DRILL FAILED: ' + report.failure +
    '\nPartial report: ' + resultPath + '\n');
  process.exitCode = 1;
}
