import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';

const root = mkdtempSync(join(tmpdir(), 'hh-launch-'));
process.env.HH_DATA_DIR = root;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const { POST: create } = await import('../src/app/api/v1/projects/route');
const { POST: preview } = await import('../src/app/api/v1/projects/preview/route');
after(() => rmSync(root, { recursive: true, force: true }));

const template = JSON.parse(readFileSync(
  new URL('../project-templates/land-investigation/land-investigation.hh.json', import.meta.url), 'utf8'));
store.importPackage(template);

const setup = {
  planning: {
    timeZone: 'Asia/Shanghai', start: '2034-11-16', due: '2034-12-01',
    humanLanes: 1, humanMinutes: 180, agentMinutes: 480, externalMinutes: 480, externalLanes: 1,
    estimates: {}, expedited: [], assumptions: { 'investigation-route': 'sampling' }
  },
  requirements: { 'land-survey': { due: '2034-11-27', brief: '按模板流程验收实际地测成果' } }
};
const request = (body: unknown) => new Request('http://localhost/api/v1/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('startup preview uses the real Todo projection while project creation saves scope and plan together', async () => {
  const payload = { packageId: template.id, packageVersion: template.version, title: '计划启动环评', setup };
  const before = store.listProjects();
  const response = await preview(request(payload));
  assert.equal(response.status, 200);
  const { preview: forecast } = await response.json();
  assert.deepEqual(store.listProjects(), before);
  assert.equal(forecast.partial, false);
  const keys = forecast.humanTodos.map((todo: { key: string }) => todo.key);
  assert.ok(keys.includes('step:survey-contact'));
  assert.ok(!keys.includes('step:archive-access'));
  assert.ok(!keys.includes('material:survey-result'));
  assert.deepEqual(forecast.deliverables.map(({ id }: { id: string }) => id), [
    'report-preliminary-output', 'report-complete-output'
  ]);

  const started = await create(request(payload));
  assert.equal(started.status, 201);
  const { project } = await started.json();
  const stored = store.getProject(project.id);
  assert.deepEqual(deriveWorkbenchQueues(stored).human.map(todo => todo.key), keys);
  assert.deepEqual(stored.planning?.settings, setup.planning);
  assert.deepEqual(stored.coordination?.requirements, setup.requirements);
  assert.deepEqual(stored.decisions, {});
  assert.equal(stored.materials['detection-report'].state, 'dormant');
  assert.ok(!stored.events.some(event =>
    event.subject === 'survey-contact' && event.detail === 'not_applicable'));
  assert.equal(stored.events.filter(event => event.type === 'project.created').length, 1);
});

test('scope validation rejects unknown template work and leaves no partially-created project', async () => {
  const before = store.listProjects();
  const payload = {
    packageId: 'document-handoff', title: '无关工作单',
    setup: { ...setup, planning: { ...setup.planning, assumptions: {} } }
  };
  assert.equal((await preview(request(payload))).status, 400);
  assert.equal((await create(request(payload))).status, 400);
  assert.deepEqual(store.listProjects(), before);
  const legacy = await create(request({ packageId: 'document-handoff', title: '原有调用' }));
  assert.equal(legacy.status, 201);
  const { project } = await legacy.json();
  assert.equal(project.planning, undefined);
  assert.equal(project.coordination, undefined);
});

test('a template update between preview and start uses the originally selected immutable version', async () => {
  const pkg = store.getPackage('document-handoff');
  const first = { ...pkg, id: 'launch-version-test', title: 'Original template', version: '1.0.0' };
  store.importPackage(first);
  const payload = {
    packageId: first.id, packageVersion: first.version, title: '版本固定',
    setup: { planning: { ...setup.planning, assumptions: {} }, requirements: {} }
  };
  assert.equal((await preview(request(payload))).status, 200);
  store.importPackage({ ...first, title: 'New template', version: '1.0.1' });
  assert.equal(store.getPackage(first.id).version, '1.0.1');
  const response = await create(request(payload));
  assert.equal(response.status, 201);
  const { project } = await response.json();
  assert.equal(project.templateVersion, '1.0.0');
  assert.equal(project.package.title, 'Original template');
});
