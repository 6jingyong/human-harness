import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import handoffPackage from '../examples/document-handoff.hh.json';
import { packageSchema } from '../src/protocol/v1';
import { newProject } from '../src/core/runtime';
import { currentWorkbenchItem, deriveWorkbenchQueues } from '../src/app/workbench-queue';
import { TaskWorkbench } from '../src/app/task-workbench';

const pkg = packageSchema.parse(handoffPackage);
const fresh = () => newProject(pkg, 'example-project', 'Example', 'sha256:' + 'a'.repeat(64));

function markup(project: ReturnType<typeof fresh>, selectedKey = '') {
  return renderToStaticMarkup(createElement(TaskWorkbench, {
    project, selectedKey, executor: 'demo',
    onSelect: () => undefined, onRefresh: () => undefined, onAction: () => undefined,
    values: {}, feedback: {}, files: {},
    onValue: () => undefined, onFeedback: () => undefined, onFile: () => undefined,
    isPending: () => false
  }));
}

test('Human and Agent queue are two projections of one stable task ID across review and archival', () => {
  const p = fresh();
  let queues = deriveWorkbenchQueues(p);
  assert.deepEqual(queues.human.map(x => x.key), ['material:source-a', 'material:source-b']);
  assert.equal(queues.agent.find(x => x.key === 'step:extract')?.state, 'blocked');
  assert.equal(currentWorkbenchItem(queues, '').key, 'material:source-a');

  p.materials['source-a'].state = 'accepted';
  p.materials['source-b'].state = 'accepted';
  p.steps.extract.state = 'ready';
  queues = deriveWorkbenchQueues(p);
  assert.equal(queues.agent.find(x => x.key === 'step:extract')?.state, 'ready');
  assert.equal(queues.history.some(x => x.key === 'material:source-a'), true);

  p.steps.extract.state = 'review';
  queues = deriveWorkbenchQueues(p);
  assert.equal(queues.human.find(x => x.key === 'step:extract')?.state, 'review');
  assert.equal(queues.agent.some(x => x.key === 'step:extract'), false);
  assert.equal(currentWorkbenchItem(queues, 'step:extract')?.owner, 'human');

  p.steps.extract.state = 'done';
  queues = deriveWorkbenchQueues(p);
  assert.equal(currentWorkbenchItem(queues, 'step:extract')?.owner, 'history');
  assert.equal(queues.history.filter(x => x.key === 'step:extract').length, 1);
});

test('selected material renders upload and acceptance UI directly inside inspector', () => {
  const p = fresh();
  const html = markup(p);
  assert.match(html, /任务工作台/);
  assert.match(html, /人类待办/);
  assert.match(html, /Agent 任务/);
  assert.match(html, /提交资料，等待人工核验/);
  assert.match(html, /type="file"/);
  assert.doesNotMatch(html, /定位到任务操作/);

  p.materials['source-a'].state = 'received';
  p.materials['source-a'].artifactIds.push('upload-1');
  p.artifacts.push({
    id: 'upload-1', kind: 'material', name: 'source.pdf',
    content: null, ownerId: 'source-a', revision: 1, createdAt: '2026-11-08T00:00:00Z'
  });
  const review = markup(p, 'material:source-a');
  assert.match(review, /确认接受材料/);
  assert.match(review, /退回补充/);
  assert.match(review, /source\.pdf/);
});

test('Agent candidate review and completed download are handled in the same detail panel', () => {
  const p = fresh();
  p.materials['source-a'].state = 'accepted';
  p.materials['source-b'].state = 'accepted';
  p.steps.extract.state = 'review';
  p.artifacts.push({
    id: 'candidate-1', kind: 'agent_output', name: 'extraction.md',
    content: '候选字段及来源', ownerId: 'extract', revision: 1, createdAt: '2026-11-08T00:00:00Z'
  });
  const html = markup(p, 'step:extract');
  assert.match(html, /候选字段及来源/);
  assert.match(html, /批准并交接下游/);
  assert.match(html, /退回 Agent 重做/);
  assert.doesNotMatch(html, /下载已审核成果/);

  p.steps.extract.state = 'done';
  const done = markup(p, 'step:extract');
  assert.match(done, /下载已审核成果/);
  assert.doesNotMatch(done, /批准并交接下游/);
});
