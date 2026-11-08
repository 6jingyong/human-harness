import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const folder = mkdtempSync(join(tmpdir(), 'hh-api-scheduler-'));
process.env.HH_DATA_DIR = folder;
process.env.HH_EXECUTOR = 'demo';
const store = await import('../src/core/store');
const projectAPI = await import('../src/app/api/v1/projects/route');
const actionAPI = await import('../src/app/api/v1/projects/[id]/actions/route');
after(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* DB still open on Windows */ } });

const action = async (projectId: string, name: string, fields: Record<string, string>) => {
  const form = new FormData();
  form.append('action', name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await actionAPI.POST(new Request('http://localhost/api/v1/projects/' + projectId + '/actions', {
    method: 'POST', body: form
  }), { params: Promise.resolve({ id: projectId }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
};

const until = async (verify: () => boolean) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (verify()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for in-process auto-dispatch');
};

test('HTTP actions trigger auto-dispatch and Human → Agent → Human → Agent without manual run clicks', async () => {
  const response = await projectAPI.POST(new Request('http://localhost/api/v1/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId: 'document-handoff', title: 'Demo HTTP handoff' })
  }));
  assert.equal(response.status, 201);
  const created = await response.json() as { project: { id: string } };
  const id = created.project.id;
  assert.equal(store.getProject(id).execution?.autoDispatch, true);

  // Upload one text annotation plus a correctly named original through the real API form.
  for (const [materialId, fileName] of [
    ['source-a', 'a.pdf'], ['source-b', 'b.docx']
  ]) {
    const form = new FormData();
    form.append('action', 'submit_material');
    form.append('materialId', materialId);
    form.append('file', new File([Buffer.from('Synthetic test original')], fileName, {
      type: fileName.endsWith('.pdf') ? 'application/pdf' :
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }));
    const received = await actionAPI.POST(new Request('http://localhost/api/v1/projects/' + id + '/actions', {
      method: 'POST', body: form
    }), { params: Promise.resolve({ id }) });
    assert.equal(received.status, 200);
    await action(id, 'accept_material', { materialId });
  }
  await until(() => store.getProject(id).steps.extract.state === 'review');
  assert.match(store.latestOutput(store.getProject(id), 'extract')?.content ?? '', /演示结果/);
  await action(id, 'approve_agent', { stepId: 'extract' });
  assert.equal(store.getProject(id).steps.resolve.state, 'ready');
  await action(id, 'complete_human', {
    stepId: 'resolve', value: '人工确认并补充了具体修订依据（仅演示）。'
  });
  await until(() => store.getProject(id).steps.final.state === 'review');
  await action(id, 'approve_agent', { stepId: 'final' });
  assert.equal(store.getProject(id).steps.final.state, 'done');
  assert.equal(store.getProject(id).runs.length, 2);
});

test('HTTP execution-policy toggle pauses queued work and is validated', async () => {
  const response = await projectAPI.POST(new Request('http://localhost/api/v1/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId: 'document-handoff', title: 'Manual control example' })
  }));
  const id = ((await response.json()) as { project: { id: string } }).project.id;
  await action(id, 'set_execution_policy', { autoDispatch: 'false', maxParallel: '1' });
  assert.deepEqual(store.getProject(id).execution, { autoDispatch: false, maxParallel: 1 });
  const form = new FormData();
  form.append('action', 'set_execution_policy');
  form.append('autoDispatch', 'true');
  form.append('maxParallel', '5');
  const invalid = await actionAPI.POST(new Request('http://localhost/api/v1/projects/' + id + '/actions', {
    method: 'POST', body: form
  }), { params: Promise.resolve({ id }) });
  assert.equal(invalid.status, 400);
});
