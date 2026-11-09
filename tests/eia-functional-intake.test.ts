import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderTextContext, type TaskExecutor } from '../src/executors/contracts';
import { deriveWorkbenchQueues } from '../src/app/workbench-queue';

const directory = mkdtempSync(join(tmpdir(), 'hh-eia-functional-intake-'));
process.env.HH_DATA_DIR = directory;
const store = await import('../src/core/store');
const { executeOneAgentTask } = await import('../src/executors/runner');
after(() => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });

function project(label: string) {
  const p = store.createProject('eia-source-replay', label);
  store.setExecutionPolicy(p.id, false, 2);
  return p.id;
}

test('on-demand EIA proof must not appear as Human Todo before Agent asks', () => {
  const id = project('No unnecessary provenance questions on startup');
  const p = store.getProject(id);
  for (const materialId of ['enterprise-identity-proof', 'qc-source-proof']) {
    assert.equal(p.materials[materialId].state, 'expected');
    assert.equal(deriveWorkbenchQueues(p).human.some(item => item.id === materialId), false);
  }
  assert.equal(deriveWorkbenchQueues(p).human.filter(item => item.kind === 'material').length, 5);
});

test('actual uploaded text and JSON bodies reach Agent; Human upload note never replaces source', async () => {
  const id = project('Real upload text and JSON');
  const sourceText = '企业原始说明：关闭搬迁时间需要来源核对，生产工艺存在特殊清洗剂。';
  const jsonBody = JSON.stringify({
    schema: 'land.material-source-analysis.v1', source_kind: 'text',
    items: [{ field_id: 'operating_period', source_quote: sourceText }],
    long_facts: 'FIELD_FROM_REAL_FILE_'.repeat(350),
    last_field: 'END_OF_APPROVED_JSON_SOURCE'
  });
  store.submitMaterial(id, 'enterprise-original', '人类上传说明：本资料只是陈述候选', {
    name: 'original.txt', buffer: Buffer.from(sourceText)
  });
  store.reviewReceivedMaterial(id, 'enterprise-original', true, 'Accepted as source declaration only');
  store.submitMaterial(id, 'enterprise-extracted', 'JSON 为已有模型候选，不是原始证据', {
    name: 'source-analysis.json', buffer: Buffer.from(jsonBody)
  });
  store.reviewReceivedMaterial(id, 'enterprise-extracted', true, 'Accepted as derivative candidate only');

  const p = store.getProject(id);
  const original = p.artifacts.find(a => a.ownerId === 'enterprise-original')!;
  const extracted = p.artifacts.find(a => a.ownerId === 'enterprise-extracted')!;
  assert.equal(original.content, sourceText);
  assert.equal(original.submissionNote, '人类上传说明：本资料只是陈述候选');
  assert.equal(extracted.content, jsonBody);
  assert.equal(extracted.submissionNote, 'JSON 为已有模型候选，不是原始证据');
  assert.ok(jsonBody.length > 4500, 'this fixture catches prior silent 4.5k prompt truncation');

  const inspector: TaskExecutor = {
    id: 'eia-real-file-intake-test',
    async execute(task) {
      assert.equal(task.evidence.length, 2);
      const actual = task.evidence.find(e => e.name === 'source-analysis.json')!;
      assert.equal(actual.content, jsonBody);
      assert.equal(actual.submissionNote, 'JSON 为已有模型候选，不是原始证据');
      const textContext = renderTextContext(task);
      assert.match(textContext, /END_OF_APPROVED_JSON_SOURCE/);
      assert.match(textContext, /Human source note, not original content/);
      return {
        body: '内部来源对照候选，未验证主体身份和空间关系。',
        limitations: ['实体与红线关系尚未核实'], materialRequests: [],
        methodChecks: task.workMethod!.checks.map(check => ({
          checkId: check.id, status: 'unverified' as const,
          explanation: '来源声明需要独立人工核对', evidenceRefs: []
        }))
      };
    }
  };
  await executeOneAgentTask(id, 'enterprise-audit', inspector);
  assert.equal(store.getProject(id).steps['enterprise-audit'].state, 'review');
});

test('a source-level note alongside PDF bytes cannot falsely turn an unread scan into extracted content', () => {
  const id = project('Scan uploaded with contextual note');
  const bytes = Buffer.from('%PDF-1.7\nfixture not a real document');
  store.submitMaterial(id, 'qc-scan', '用户说这是扫描质控报告；未经过图像识读', {
    name: 'qc-scan.pdf', buffer: bytes
  });
  const p = store.getProject(id);
  const scan = p.artifacts.find(a => a.ownerId === 'qc-scan')!;
  assert.equal(scan.content, null);
  assert.equal(scan.submissionNote, '用户说这是扫描质控报告；未经过图像识读');
  assert.equal(scan.name, 'qc-scan.pdf');
});

test('an Agent question reveals only its targeted on-demand input; after text answer the extra material Todo disappears', async () => {
  const id = project('Human on-demand input lifecycle');
  for (const [materialId, text] of [
    ['enterprise-original', '原始文字：企业身份未确认'],
    ['enterprise-extracted', '{"items": [{"status": "not_in_source"}]}']
  ]) {
    store.submitMaterial(id, materialId, text);
    store.reviewReceivedMaterial(id, materialId, true, 'Checked as user supplied candidate');
  }
  await executeOneAgentTask(id, 'enterprise-audit', {
    id: 'ask-human-about-identity',
    async execute(task) {
      assert.equal(task.packet.readableInputs.length, 2);
      return {
        body: 'Need to identify enterprise', limitations: [],
        materialRequests: [{ materialId: 'enterprise-identity-proof',
          reason: '请确认企业完整主体名称及红线关联证明。' }]
      };
    }
  });
  const paused = store.getProject(id);
  assert.equal(paused.steps['enterprise-audit'].state, 'waiting_input');
  assert.equal(paused.materials['enterprise-identity-proof'].state, 'requested');
  assert.equal(paused.materials['qc-source-proof'].state, 'expected');
  const cards = deriveWorkbenchQueues(paused).human;
  assert.equal(cards.filter(item => item.kind === 'request').length, 1);
  assert.equal(cards.some(item => item.kind === 'material' &&
    item.id === 'enterprise-identity-proof'), false, 'request owns the single Human Todo');
  const requestId = paused.humanRequests![0].id;
  store.answerRequestedInput(id, requestId, '暂时无正式红线关联证明，请保留不确定性。');
  const resumed = store.getProject(id);
  assert.equal(resumed.steps['enterprise-audit'].state, 'ready');
  assert.equal(resumed.materials['enterprise-identity-proof'].state, 'expected');
  assert.equal(deriveWorkbenchQueues(resumed).human.some(x =>
    x.id === 'enterprise-identity-proof'), false);
});

test('long uploaded text is explicitly rejected instead of being silently truncated and accepted', () => {
  const id = project('No fake full file ingest');
  assert.throws(() => store.submitMaterial(id, 'enterprise-original', '', {
    name: 'oversize.txt', buffer: Buffer.from('x'.repeat(30_001))
  }), /exceeds 30,000 characters/);
  assert.equal(store.getProject(id).materials['enterprise-original'].artifactIds.length, 0);
});
