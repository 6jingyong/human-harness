import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageSchema } from '../src/protocol/v1';
import { currentApprovedOutput } from '../src/core/runtime';

const directory = mkdtempSync(join(tmpdir(), 'hh-optional-land-template-'));
process.env.HH_DATA_DIR = directory;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { demoExecutor } = await import('../src/executors/demo');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { GET: download } = await import('../src/app/api/v1/projects/[id]/outputs/[artifactId]/route');
const templatePath = new URL('../project-templates/land-investigation/land-investigation.hh.json', import.meta.url);
const template = packageSchema.parse(JSON.parse(readFileSync(templatePath, 'utf8')));
after(() => rmSync(directory, { recursive: true, force: true }));

const state = (id: string, step: string) => store.getProject(id).steps[step]?.state;
const materialState = (id: string, key: string) => store.getProject(id).materials[key].state;
function acceptSource(id: string, key: string) {
  const source = Buffer.from('Synthetic source fixture for ' + key);
  store.submitMaterial(id, key, '', { name: key + '.txt', buffer: source });
  store.reviewReceivedMaterial(id, key, true, 'Accepted as test fixture');
}
async function approve(id: string, step: string) {
  await executeOneAgentTask(id, step);
  assert.equal(state(id, step), 'review');
  store.reviewAgentOutput(id, step, true, 'Reviewed as test fixture');
}
async function research() {
  const project = store.createProject(template.id, 'Synthetic land investigation');
  store.setExecutionPolicy(project.id, false, 2);
  assert.equal(materialState(project.id, 'field-records'), 'dormant');
  const extractions = project.package.steps.filter(step => step.id.startsWith('extract-') && !step.when);
  for (const step of extractions) {
    for (const source of step.needsMaterials) acceptSource(project.id, source);
  }
  assert.ok(extractions.every(step => state(project.id, step.id) === 'ready'));
  for (const step of extractions) await approve(project.id, step.id);
  await approve(project.id, 'desk-results');
  await approve(project.id, 'preliminary-analysis');
  assert.equal(state(project.id, 'investigation-route'), 'ready');
  return project.id;
}
async function draft(id: string, route: string) {
  const reportId = 'report-' + route;
  const reportStep = template.steps.find(step => step.id === reportId)!;
  for (const sectionId of reportStep.dependsOn) {
    if (route === 'complete') {
      await executeOneAgentTask(id, sectionId, {
        id: 'synthetic-full-length-section',
        async execute(task) {
          const candidate = await demoExecutor.execute(task);
          return { ...candidate, body: candidate.body + '\n\n' + '该段为测试占位。'.repeat(470) };
        }
      });
      store.reviewAgentOutput(id, sectionId, true, 'Reviewed as a long synthetic section');
    } else {
      await approve(id, sectionId);
    }
  }
  assert.equal(state(id, reportId), 'ready');
  await executeOneAgentTask(id, reportId);
  const report = store.latestOutput(store.getProject(id), reportId)!;
  const get = (format?: 'docx') => download(new Request('http://localhost' + (format ? '?format=' + format : '')), {
    params: Promise.resolve({ id, artifactId: report.id })
  });
  assert.equal((await get()).status, 409);
  assert.equal((await get('docx')).status, 409);
  assert.throws(() => store.approveHumanCorrectedOutput(id, reportId, '# Manually edited entire report', 'Test'),
    /Revise the source sections/);
  store.reviewAgentOutput(id, reportId, true, 'Approved simulated candidate');
  const response = await get();
  assert.equal(response.status, 200);
  const project = store.getProject(id);
  const approvedSections = reportStep.dependsOn.map(sectionId => currentApprovedOutput(project, sectionId)!);
  const body = approvedSections.map(section => section.content!).join('\n\n') + '\n';
  assert.equal(await response.text(), body);
  assert.deepEqual(report.inputArtifactIds, approvedSections.map(section => section.id));
  const word = await get('docx');
  assert.equal(word.status, 200);
  assert.match(word.headers.get('content-disposition') ?? '', new RegExp('report-' + route + '\\.docx'));
  const archive = unzipSync(new Uint8Array(await word.arrayBuffer()));
  const doc = strFromU8(archive['word/document.xml']);
  const wordHeadings = doc.match(/<w:pStyle w:val="Heading[1-6]"\/>/g) ?? [];
  const expected = template.outputs.find(output => output.producingStepId === reportId)!.markdown!.headings!.length;
  assert.equal(wordHeadings.length, expected);
  assert.ok(doc.includes('Synthetic land investigation'));
  return { report, get, approvedSections };
}

test('the core starts without land templates and imports the standalone domain template', () => {
  assert.ok(store.listPackages().every(p => !/land|eia/i.test(p.id)));
  assert.throws(() => store.createProject(template.id, 'Before install'), /not found/);
  const build = spawnSync(process.execPath, [
    new URL('../project-templates/land-investigation/build-template.mjs', import.meta.url).pathname,
    '--check'
  ], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  assert.ok(readFileSync(templatePath).length <= 200000);
  assert.equal(store.importPackage(template).id, template.id);
  assert.equal(store.listPackages().find(p => p.id === template.id)?.builtin, false);
  const headings = template.outputs.find(out => out.producingStepId === 'report-complete')!.markdown!.headings!;
  assert.equal(headings.filter(heading => heading.level === 1).length, 7);
  assert.equal(headings.filter(heading => heading.level === 2).length, 33);
  assert.equal(headings.filter(heading => heading.level > 2).length, 70);
  assert.ok(template.steps.filter(step => step.agentId === 'writing').every(step =>
    step.needsMaterials.length === 0 && step.dependsOn.some(id => id.startsWith('outline-'))));
});

test('stage-one exit never requests lab evidence and revised sections regenerate the manuscript', async () => {
  const id = await research();
  store.completeHuman(id, 'investigation-route', 'preliminary');
  assert.equal(materialState(id, 'detection-report'), 'not_applicable');
  assert.equal(state(id, 'report-complete'), 'not_applicable');
  assert.equal(state(id, 'sampling-plan'), 'not_applicable');
  assert.equal(state(id, 'preliminary-1-2'), 'blocked');
  await approve(id, 'outline-preliminary');
  const { report, get, approvedSections } = await draft(id, 'preliminary');
  assert.throws(() =>
    store.reviseHumanApprovedOutput(id, 'report-preliminary', report.id, '# Edited report', 'Test'),
    /Revise the source sections/);
  const section = approvedSections.find(artifact => artifact.ownerId === 'preliminary-1-2')!;
  const incomplete = section.content!.replace(/^(### 1\.2\.1[^\n]*)/m, '```\n$1\n```');
  assert.throws(() =>
    store.reviseHumanApprovedOutput(id, section.ownerId, section.id, incomplete, 'Test missing locked heading'),
    /Markdown heading/);
  assert.equal(currentApprovedOutput(store.getProject(id), section.ownerId)?.id, section.id);

  store.reviseHumanApprovedOutput(id, section.ownerId, section.id,
    section.content + '\n\n测试修订只落在本节。', 'Revision test');
  assert.equal(state(id, 'report-preliminary'), 'ready');
  assert.equal((await get()).status, 409);
  assert.equal((await get('docx')).status, 409);
  await approve(id, 'report-preliminary');
  const regenerated = currentApprovedOutput(store.getProject(id), 'report-preliminary')!;
  assert.match(regenerated.content ?? '', /测试修订只落在本节/);
  assert.equal(regenerated.inputArtifactIds?.includes(section.id), false);
});

test('the sampling route waits for the institution, then schedules analysis and outline independently', async () => {
  const id = await research();
  store.completeHuman(id, 'investigation-route', 'sampling');
  assert.equal(materialState(id, 'detection-report'), 'expected');
  assert.equal(state(id, 'report-preliminary'), 'not_applicable');
  await approve(id, 'sampling-plan');
  store.completeHuman(id, 'commission', 'Synthetic commission record');
  assert.equal(materialState(id, 'detection-report'), 'expected');
  store.completeHuman(id, 'lab-work-complete', 'Synthetic completion record');

  for (const [step, material] of [
    ['extract-field', 'field-records'], ['extract-lab', 'detection-report'], ['extract-qc', 'qc-evidence']
  ]) {
    assert.equal(materialState(id, material), 'requested');
    acceptSource(id, material);
    await approve(id, step);
  }
  await approve(id, 'sampling-results');
  assert.equal(state(id, 'outline-complete'), 'ready');
  assert.equal(state(id, 'sampling-analysis'), 'ready');
  assert.equal(state(id, 'complete-6-2'), 'blocked');
  await approve(id, 'outline-complete');
  assert.equal(state(id, 'complete-6-2'), 'blocked');
  await approve(id, 'sampling-analysis');
  assert.equal(state(id, 'complete-6-2'), 'ready');
  const { report } = await draft(id, 'complete');
  assert.ok((report.content?.length ?? 0) > 100000);
  assert.match(report.content ?? '', /^#### 6\.2\.2\.2 /m);
  assert.match(report.content ?? '', /^## 7\.5 /m);
});
