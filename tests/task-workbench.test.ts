import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import handoffPackage from '../examples/document-handoff.hh.json';
import { packageSchema } from '../src/protocol/v1';
import { newProject } from '../src/core/runtime';
import { currentWorkbenchItem, deriveWorkbenchQueues, groupAgentTasks } from '../src/app/workbench-queue';
import { TaskWorkbench } from '../src/app/task-workbench';
import { ProjectMaterialLibrary } from '../src/app/project-material-library';

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
  assert.equal(currentWorkbenchItem(queues, '')?.key, 'material:source-a');

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
  assert.match(html, /Human Todo/);
  assert.match(html, /Agent TodoList/);
  assert.match(html, /Agent A · 资料提取/);
  assert.match(html, /Agent B · 成果整理/);
  assert.match(html, /等待依赖/);
  assert.doesNotMatch(html, /提交资料，等待人工核验/);
  assert.doesNotMatch(html, /type="file"/);
  const selected = markup(p, 'material:source-a');
  assert.match(selected, /提交资料，等待人工核验/);
  assert.match(selected, /type="file"/);
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
  assert.match(html, /人工直接修订候选结果/);
  assert.match(html, /将候选稿复制到编辑区/);
  assert.match(html, /保存人工修订版、批准并交接下游/);
  assert.doesNotMatch(html, /下载已审核成果/);

  p.steps.extract.state = 'done';
  p.artifacts.push({
    id: 'candidate-human-2', kind: 'agent_output', name: 'extraction.md',
    content: '人工订正后的结果', ownerId: 'extract', revision: 2,
    createdAt: '2026-11-09T00:00:00Z',
    humanCorrection: {
      basedOnArtifactId: 'candidate-1', rationale: 'Corrected source value',
      correctedAt: '2026-11-09T00:00:00Z'
    }
  });
  const done = markup(p, 'step:extract');
  assert.doesNotMatch(done, /下载已审核成果/);
  assert.doesNotMatch(done, /批准并交接下游/);
  const library = renderToStaticMarkup(createElement(ProjectMaterialLibrary, {
    project: p, onBack: () => undefined, onReplace: () => undefined,
    values: {}, files: {}, onValue: () => undefined,
    onFile: () => undefined, isPending: () => false
  }));
  assert.match(library, /套用项目模板后的资料说明/);
  assert.match(library, /候选字段及来源/);
  assert.match(library, /人工订正后的结果/);
  assert.match(library, /下载已审核成果/);
});


test('Agent lanes are planned by template; states remain foldable without creating extra runtimes', () => {
  const p = fresh();
  let groups = groupAgentTasks(p, deriveWorkbenchQueues(p).agent);
  assert.deepEqual(groups.map(g => g.id), ['agent-a', 'agent-b']);
  assert.equal(groups[0].counts.blocked, 1);
  assert.equal(groups[1].counts.blocked, 1);
  p.materials['source-a'].state = 'accepted';
  p.materials['source-b'].state = 'accepted';
  p.steps.extract.state = 'running';
  groups = groupAgentTasks(p, deriveWorkbenchQueues(p).agent);
  assert.equal(groups[0].counts.running, 1);
  assert.equal(groups[1].counts.blocked, 1);
  const html = markup(p);
  assert.match(html, /agent-folder/);
  assert.match(html, /agent-state-folder/);
});


test('Agent missing-information proposal appears in Human Todo without a separate approval center', () => {
  const p = fresh();
  p.steps.extract.state = 'waiting_input';
  p.humanRequests = [{
    id: 'request-1', stepId: 'extract', runId: 'run-1',
    materialId: 'source-a', reason: '请说明文档中的项目编号是否已更正。',
    status: 'pending', createdAt: '2026-11-09T00:00:00Z'
  }];
  const queues = deriveWorkbenchQueues(p);
  assert.equal(queues.human.some(item => item.key === 'request:request-1'), true);
  assert.equal(queues.human.some(item => item.key === 'material:source-a'), false,
    'clarification and source upload share one Human Todo rather than duplicates');
  assert.equal(queues.agent.find(item => item.id === 'extract')?.state, 'waiting_input');
  const html = markup(p, 'request:request-1');
  assert.match(html, /Agent 请求补充信息/);
  assert.match(html, /项目编号是否已更正/);
  assert.match(html, /提交说明并继续 Agent/);
  assert.match(html, /等待人工答复/);
  assert.doesNotMatch(html, /确认接受材料/);
});
