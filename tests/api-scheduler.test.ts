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


test('local material download returns exact project-owned bytes without internal filesystem paths', async () => {
  const { GET } = await import('../src/app/api/v1/projects/[id]/materials/[artifactId]/route');
  const p = store.createProject('document-handoff', 'File access boundary');
  const content = Buffer.from('%PDF-1.7\noriginal-private-file');
  const updated = store.submitMaterial(p.id, 'source-a', '', {
    name: 'source.pdf', buffer: content
  });
  const artifact = updated.artifacts.find(a => a.kind === 'material' && a.ownerId === 'source-a');
  assert.ok(artifact);
  const result = await GET(new Request('http://localhost/material'), {
    params: Promise.resolve({ id: p.id, artifactId: artifact.id })
  });
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), content);
  assert.match(result.headers.get('content-disposition') ?? '', /source\.pdf/);
  assert.ok(!JSON.stringify(Object.fromEntries(result.headers)).includes('.human-harness'));
  const another = store.createProject('document-handoff', 'Other project');
  const foreign = await GET(new Request('http://localhost/material'), {
    params: Promise.resolve({ id: another.id, artifactId: artifact.id })
  });
  assert.equal(foreign.status, 404);
});


test('Human Todo HTTP action answers a model-requested clarification without creating fake material', async () => {
  const { executeOneAgentTask } = await import('../src/executors/runner');
  const p = store.createProject('document-handoff', 'HTTP clarification test');
  store.setExecutionPolicy(p.id, false, 1);
  for (const [materialId, name] of [['source-a', 'a.pdf'], ['source-b', 'b.docx']]) {
    store.submitMaterial(p.id, materialId, '', { name, buffer: Buffer.from('test fixture') });
    store.reviewReceivedMaterial(p.id, materialId, true, '');
  }
  await executeOneAgentTask(p.id, 'extract', {
    id: 'http-human-request-fixture',
    async execute() {
      return {
        body: 'Need to confirm the document edition',
        limitations: [], materialRequests: [
          { materialId: 'source-a', reason: '请核实这份 PDF 的年份。' }
        ]
      };
    }
  });
  const paused = store.getProject(p.id);
  assert.equal(paused.steps.extract.state, 'waiting_input');
  const questionId = paused.humanRequests?.[0]?.id;
  assert.ok(questionId);

  const bad = new FormData();
  bad.append('action', 'answer_human_request');
  bad.append('requestId', questionId);
  bad.append('value', '');
  const badResponse = await actionAPI.POST(
    new Request('http://localhost/api/v1/projects/' + p.id + '/actions', { method: 'POST', body: bad }),
    { params: Promise.resolve({ id: p.id }) }
  );
  assert.equal(badResponse.status, 400);
  await action(p.id, 'answer_human_request', {
    requestId: questionId, value: '这份 PDF 是 2026 年发布的正式版。'
  });
  const resumed = store.getProject(p.id);
  assert.equal(resumed.steps.extract.state, 'ready');
  assert.match(resumed.humanRequests?.[0]?.answer ?? '', /2026/);
  assert.equal(resumed.materials['source-a'].artifactIds.length, 1);
  assert.equal(resumed.materials['source-a'].state, 'accepted');
});


test('HTTP Human request file upload remains pending until material approval', async () => {
  const { executeOneAgentTask } = await import('../src/executors/runner');
  const p = store.createProject('document-handoff', 'HTTP attachment review');
  store.setExecutionPolicy(p.id, false, 1);
  for (const [materialId, name] of [['source-a', 'a.pdf'], ['source-b', 'b.docx']]) {
    store.submitMaterial(p.id, materialId, '', { name, buffer: Buffer.from('original input') });
    store.reviewReceivedMaterial(p.id, materialId, true, '');
  }
  await executeOneAgentTask(p.id, 'extract', {
    id: 'file-request-fixture',
    async execute() {
      return {
        body: 'A newer original is required', limitations: [], materialRequests: [
          { materialId: 'source-a', reason: '请提供最新版 PDF。' }
        ]
      };
    }
  });
  const questionId = store.getProject(p.id).humanRequests![0].id;
  const oldId = store.getProject(p.id).materials['source-a'].acceptedArtifactId;
  const form = new FormData();
  form.append('action', 'answer_human_request');
  form.append('requestId', questionId);
  form.append('value', '替换来源为最新版本');
  form.append('file', new File([Buffer.from('%PDF-revised-fixture')], 'a-v2.pdf', {
    type: 'application/pdf'
  }));
  const received = await actionAPI.POST(
    new Request('http://localhost/api/v1/projects/' + p.id + '/actions', { method: 'POST', body: form }),
    { params: Promise.resolve({ id: p.id }) }
  );
  assert.equal(received.status, 200, JSON.stringify(await received.json()));
  const awaiting = store.getProject(p.id);
  assert.equal(awaiting.steps.extract.state, 'waiting_input');
  assert.equal(awaiting.humanRequests![0].status, 'awaiting_review');
  assert.equal(awaiting.materials['source-a'].acceptedArtifactId, oldId);
  await action(p.id, 'accept_material', { materialId: 'source-a' });
  const accepted = store.getProject(p.id);
  assert.equal(accepted.steps.extract.state, 'ready');
  assert.equal(accepted.humanRequests![0].status, 'answered');
  assert.equal(accepted.materials['source-a'].state, 'accepted');
  assert.equal(accepted.materials['source-a'].artifactIds.length, 2);
  assert.notEqual(accepted.materials['source-a'].acceptedArtifactId, oldId);
});

test('HTTP replace_material queues a new revision without bypassing source acceptance', async () => {
  const p = store.createProject('document-handoff', 'HTTP explicit source replacement');
  store.setExecutionPolicy(p.id, false, 1);
  store.submitMaterial(p.id, 'source-a', '', {
    name: 'a-v1.pdf', buffer: Buffer.from('initial')
  });
  store.reviewReceivedMaterial(p.id, 'source-a', true, '');
  const oldAccepted = store.getProject(p.id).materials['source-a'].acceptedArtifactId;
  const form = new FormData();
  form.append('action', 'replace_material');
  form.append('materialId', 'source-a');
  form.append('file', new File([Buffer.from('new document')], 'a-v2.pdf', {
    type: 'application/pdf'
  }));
  const response = await actionAPI.POST(
    new Request('http://localhost/api/v1/projects/' + p.id + '/actions', { method: 'POST', body: form }),
    { params: Promise.resolve({ id: p.id }) }
  );
  assert.equal(response.status, 200);
  assert.equal(store.getProject(p.id).materials['source-a'].state, 'received');
  assert.equal(store.getProject(p.id).materials['source-a'].acceptedArtifactId, oldAccepted);
  await action(p.id, 'accept_material', { materialId: 'source-a' });
  const updated = store.getProject(p.id);
  assert.equal(updated.materials['source-a'].state, 'accepted');
  assert.notEqual(updated.materials['source-a'].acceptedArtifactId, oldAccepted);
});


test('HTTP replacement review reports 409 while a dependent Agent run is active', async () => {
  const p = store.createProject('document-handoff', 'HTTP active replacement conflict');
  store.setExecutionPolicy(p.id, false, 1);
  for (const [materialId, name] of [['source-a', 'a.pdf'], ['source-b', 'b.docx']]) {
    store.submitMaterial(p.id, materialId, '', { name, buffer: Buffer.from('original source') });
    store.reviewReceivedMaterial(p.id, materialId, true, '');
  }
  const active = store.startAgent(p.id, 'extract');
  store.submitMaterial(p.id, 'source-a', '', {
    name: 'a-new.pdf', buffer: Buffer.from('replacement source')
  }, { replaceAccepted: true });
  const form = new FormData();
  form.append('action', 'accept_material');
  form.append('materialId', 'source-a');
  const conflict = await actionAPI.POST(new Request('http://localhost/api/v1/projects/' +
    p.id + '/actions', { method: 'POST', body: form }), {
    params: Promise.resolve({ id: p.id })
  });
  assert.equal(conflict.status, 409);
  assert.match(JSON.stringify(await conflict.json()), /Dependent Agent work is active/);
  store.markAgentFailed(p.id, 'extract', active.runId, 'Explicit cancellation in test');
  await action(p.id, 'accept_material', { materialId: 'source-a' });
  assert.equal(store.getProject(p.id).steps.extract.state, 'ready');
});
