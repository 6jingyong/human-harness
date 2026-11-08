import test from 'node:test';
import assert from 'node:assert/strict';
import { blockingDependencies, canStart, nextReadyAgentTask, validateTemplate } from '../src/lib/domain';
import type { ProjectTemplate, Task } from '../src/lib/domain';

const base: ProjectTemplate = {
  id: 'test', title: 'Test', description: 'Test workflow', version: 1,
  tasks: [
    { id: 'input', title: 'Input', description: 'Human supplies context', owner: 'human', dependsOn: [], inputKind: 'text' },
    { id: 'draft', title: 'Draft', description: 'Agent drafts plan', owner: 'agent', dependsOn: ['input'], prompt: 'Draft', reviewRequired: true },
    { id: 'deliver', title: 'Deliver', description: 'Agent delivers', owner: 'agent', dependsOn: ['draft'], prompt: 'Deliver', reviewRequired: true }
  ]
};
function makeTasks(): Task[] {
  return base.tasks.map((t, ordinal) => ({ ...t, projectId: 'p1', status: 'pending', ordinal }));
}
test('template accepts valid DAG', () => assert.doesNotThrow(() => validateTemplate(base)));
test('template rejects cyclic dependencies', () => {
  const invalid: ProjectTemplate = { ...base, tasks: base.tasks.map(t => t.id === 'input' ? { ...t, dependsOn: ['deliver'] } : t) };
  assert.throws(() => validateTemplate(invalid), /Cycle/);
});
test('template rejects duplicate and missing IDs', () => {
  assert.throws(() => validateTemplate({ ...base, tasks: [base.tasks[0], base.tasks[0]] }), /Duplicate/);
  assert.throws(() => validateTemplate({ ...base, tasks: [{ ...base.tasks[0], dependsOn: ['missing'] }] }), /Invalid dependency/);
});
test('agent blocked until human input completed', () => {
  const tasks = makeTasks();
  assert.equal(nextReadyAgentTask(tasks), undefined);
  assert.deepEqual(blockingDependencies(tasks[1], tasks), ['input']);
  tasks[0].status = 'completed';
  assert.equal(nextReadyAgentTask(tasks)?.id, 'draft');
});
test('review blocks downstream execution', () => {
  const tasks = makeTasks();
  tasks[0].status = 'completed'; tasks[1].status = 'review';
  assert.equal(canStart(tasks[2], tasks), false);
  tasks[1].status = 'completed';
  assert.equal(canStart(tasks[2], tasks), true);
});
test('completed tasks do not rerun and failed tasks can retry', () => {
  const tasks = makeTasks();
  tasks[0].status = 'completed'; tasks[1].status = 'completed';
  assert.equal(canStart(tasks[1], tasks), false);
  tasks[1].status = 'failed';
  assert.equal(canStart(tasks[1], tasks), true);
});
