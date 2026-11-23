import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { demoExecutor } from '../src/executors/demo';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';

const directory = mkdtempSync(join(tmpdir(), 'hh-general-templates-'));
process.env.HH_DATA_DIR = directory;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { GET: list } = await import('../src/app/api/v1/packages/route');
const { POST: preview } = await import('../src/app/api/v1/projects/preview/route');
const { GET: download } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
after(() => rmSync(directory, { recursive: true, force: true }));

const origin = 'http://localhost';
const setup = {
  planning: {
    timeZone: 'Asia/Shanghai', start: '2034-11-16', due: '2034-12-01',
    humanLanes: 1, humanMinutes: 180, agentMinutes: 480, externalMinutes: 480, externalLanes: 1,
    estimates: {}, expedited: [], assumptions: {}
  },
  requirements: {}
};

function submit(id: string, material: string, text: string) {
  store.submitMaterial(id, material, text);
  store.reviewReceivedMaterial(id, material, true, '验收测试资料');
}

const state = (id: string, step: string) => store.getProject(id).steps[step].state;
function review(id: string, step: string) {
  assert.equal(state(id, step), 'review');
  assert.ok(deriveWorkbenchQueues(store.getProject(id)).human.some(item => item.id === step));
  store.reviewAgentOutput(id, step, true, '批准测试成果');
}

function fetchOutput(id: string, artifactId: string, format: 'md' | 'docx') {
  return download(new Request(origin + '/api/v1/projects/' + id + '/outputs/' + artifactId +
    (format === 'docx' ? '?format=docx' : '')), { params: Promise.resolve({ id, artifactId }) });
}

async function checkApprovedDelivery(id: string, step: string) {
  const project = store.getProject(id);
  const contract = project.package.outputs.find(output => output.id === project.package.steps
    .find(candidate => candidate.id === step)?.outputContractId);
  assert.ok(contract?.word && contract.markdown?.headings?.length);
  const artifact = store.latestOutput(project, step);
  assert.ok(artifact?.content);
  assert.equal((await fetchOutput(id, artifact.id, 'docx')).status, 409);
  review(id, step);

  const md = await fetchOutput(id, artifact.id, 'md');
  assert.equal(md.status, 200);
  assert.equal(await md.text(), artifact.content);
  for (const heading of contract.markdown.headings) assert.ok(artifact.content.includes('## ' + heading.title));
  const docx = await fetchOutput(id, artifact.id, 'docx');
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get('content-disposition') ?? '', /\.docx"/);
  const document = strFromU8(unzipSync(new Uint8Array(await docx.arrayBuffer()))['word/document.xml']);
  assert.ok(document.includes(contract.markdown.headings[0].title));
  return artifact.id;
}

test('general report is selectable out of the box and its launch preview shows the Word deliverable', async () => {
  const response = await list(new Request(origin + '/api/v1/packages'));
  const { packages } = await response.json();
  for (const id of ['general-report', 'project-plan', 'meeting-actions', 'project-retrospective']) {
    assert.ok(packages.some((pkg: { id: string; builtin: boolean }) => pkg.id === id && pkg.builtin));
  }
  const template = store.getPackage('general-report');
  assert.throws(() => store.importPackage(template), /Built-in package ID cannot be overwritten/);
  const before = store.listProjects().length;
  const result = await preview(new Request(origin + '/api/v1/projects/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId: template.id, packageVersion: template.version, title: '试写报告', setup })
  }));
  assert.equal(result.status, 200);
  const { preview: initial } = await result.json();
  assert.deepEqual(initial.humanTodos.map((todo: { key: string }) => todo.key).sort(), ['material:brief', 'material:sources']);
  assert.deepEqual(initial.deliverables, [{ id: 'report-output', title: '项目报告', format: 'markdown', word: true }]);
  assert.equal(store.listProjects().length, before);
});

test('the report waits for two reviewed inputs and material replacement invalidates only affected work', async () => {
  const { id } = store.createProject('general-report', '设备调研试写', setup);
  store.submitMaterial(id, 'brief', '给项目组评估设备选型，范围为交付周期和安装条件');
  assert.equal(state(id, 'outline'), 'blocked');
  store.reviewReceivedMaterial(id, 'brief', true, '确认报告要求');
  assert.equal(state(id, 'outline'), 'ready');
  assert.equal(state(id, 'evidence'), 'blocked');
  submit(id, 'sources', '资料 A 表 1 记录可用面积为 120 平方米。');
  assert.equal(state(id, 'evidence'), 'ready');
  await Promise.all([executeOneAgentTask(id, 'outline'), executeOneAgentTask(id, 'evidence')]);
  assert.equal(state(id, 'report'), 'blocked');
  review(id, 'outline');
  assert.equal(state(id, 'report'), 'blocked');
  review(id, 'evidence');
  assert.equal(state(id, 'report'), 'ready');
  const project = store.getProject(id);
  await executeOneAgentTask(id, 'report', {
    id: 'demo-asserted-scope',
    async execute(task) {
      const inputs = task.packet.readableInputs;
      assert.deepEqual(new Set(inputs.map(input => input.artifactId)),
        new Set([project.steps.evidence.approvedArtifactId, project.steps.outline.approvedArtifactId]));
      assert.ok(inputs.every(input => input.role === 'approved_derived'));
      return demoExecutor.execute(task);
    }
  });
  const oldArtifact = await checkApprovedDelivery(id, 'report');

  store.submitMaterial(id, 'sources', '修订版 A 表 1 记录可用面积为 125 平方米。', undefined, { replaceAccepted: true });
  store.reviewReceivedMaterial(id, 'sources', true, '采纳新证据');
  assert.equal(state(id, 'outline'), 'done');
  assert.equal(state(id, 'evidence'), 'ready');
  assert.equal(state(id, 'report'), 'blocked');
  assert.equal((await fetchOutput(id, oldArtifact, 'docx')).status, 409);
});

const workflows = [
  {
    id: 'project-plan', first: 'options', handoff: 'choose', deliverable: 'kickoff',
    inputs: { mission: '交付现状清单和优先方案', constraints: '两人、三天，外部确认由负责人办理' },
    decision: '采用先确认范围再实施的方案，三天内交付草稿'
  },
  {
    id: 'meeting-actions', first: 'extract', handoff: 'confirm', deliverable: 'minutes',
    inputs: { context: '设计评审，测试会议', notes: '第 3 段，负责人决定让李工下周一交付核对清单' },
    decision: '李工周一提交第一版清单，联系人到场时间待确认'
  },
  {
    id: 'project-retrospective', first: 'variance', handoff: 'commit', deliverable: 'retrospective',
    inputs: { baseline: '计划人工三小时，完成标准为验收清单通过', actuals: '同范围记录实际人工四小时，机构等待两天' },
    decision: '下一单在建项时确认联络窗口，比较追件工时'
  }
] as const;

for (const workflow of workflows) {
  test(workflow.id + ' keeps the final work behind the explicit human handoff', async () => {
    const { id } = store.createProject(workflow.id, '通用模板试跑', setup);
    for (const [key, text] of Object.entries(workflow.inputs)) submit(id, key, text);
    await executeOneAgentTask(id, workflow.first);
    assert.equal(state(id, workflow.handoff), 'blocked');
    review(id, workflow.first);
    assert.equal(state(id, workflow.handoff), 'ready');
    assert.equal(state(id, workflow.deliverable), 'blocked');
    store.completeHuman(id, workflow.handoff, workflow.decision);
    assert.equal(state(id, workflow.deliverable), 'ready');
    await executeOneAgentTask(id, workflow.deliverable);
    await checkApprovedDelivery(id, workflow.deliverable);
  });
}
