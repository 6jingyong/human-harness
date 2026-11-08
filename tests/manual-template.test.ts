import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManualTemplateDraft } from '../src/lib/manual-template';
import { parseTemplate } from '../src/lib/template-import';

test('nontechnical manual builder emits an importable v3 package', () => {
  const template = buildManualTemplateDraft({
    id: 'project-example', title: '专项研究',
    description: '用于内部研究', initialInputs: '项目目标\n文件:已有文档\n联系人',
    agentGoal: '整理研究计划并形成可审查成果'
  });
  const parsed = parseTemplate(JSON.parse(JSON.stringify(template)));
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.tasks.length, 4);
  assert.equal(parsed.materials?.length, 3);
  assert.equal(parsed.tasks[1].inputKind, 'file');
  assert.equal(parsed.tasks[3].owner, 'agent');
  assert.deepEqual(parsed.tasks[3].dependsOn, ['input-01', 'input-02', 'input-03']);
});
test('manual template generation rejects invalid identifiers and empty work', () => {
  assert.throws(() => buildManualTemplateDraft({
    id: '土地调查', title: 'Example', description: '', initialInputs: 'Project brief', agentGoal: 'Review text'
  }), /模板 ID/);
  assert.throws(() => buildManualTemplateDraft({
    id: 'template', title: 'Example', description: '', initialInputs: '', agentGoal: 'Review text'
  }), /初始用户资料/);
});
