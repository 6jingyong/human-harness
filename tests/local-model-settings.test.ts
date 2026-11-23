import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualProjectPackage } from '../src/protocol/manual';

process.env.HH_DATA_DIR = mkdtempSync(join(tmpdir(), 'hh-model-settings-'));
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
const { ollamaModels } = await import('../src/executors/ollama');

test('a workspace model switch applies to the next task and preserves the running model', async t => {
  const names = ['alpha:local', 'beta:local'];
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/tags')) return Response.json({ models: names.map(name => ({ name })) });
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init.body));
    seen.push(body.model);
    assert.equal(body.format.type, 'object');
    assert.equal(body.stream, false);
    await gate;
    return Response.json({ model: body.model, message: { content: JSON.stringify({
      body: 'Synthetic summary', limitations: [], materialRequests: []
    }) } });
  });
  assert.deepEqual((await ollamaModels()).map(item => item.id), names);
  const pkg = manualProjectPackage({ id: 'model-check', title: 'Model selection', description: 'Test', inputs: 'Source', objective: 'Summarize' });
  store.importPackage(pkg);
  function ready() {
    const { id } = store.createProject(pkg.id, 'Synthetic run');
    store.submitMaterial(id, 'input-01', 'Synthetic text');
    store.reviewReceivedMaterial(id, 'input-01', true, '');
    return id;
  }
  store.saveModelSettings({ provider: 'ollama', model: names[0] });
  const first = executeOneAgentTask(ready(), 'draft');
  store.saveModelSettings({ provider: 'ollama', model: names[1] });
  const second = executeOneAgentTask(ready(), 'draft');
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(seen, names);
  assert.deepEqual(results.map(r => [r.project.runs[0].provider, r.project.runs[0].model, r.project.steps.draft.state]),
    names.map(name => ['ollama', name, 'review']));
});
