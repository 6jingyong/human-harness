import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { renderApprovedWord } from '../src/core/word-export';
import { manualProjectPackage } from '../src/protocol/manual';
import { packageSchema } from '../src/protocol/v1';

const profile = {
  fileName: 'test-report.docx', title: '调查内审稿', bodyFont: '宋体',
  headingFont: '黑体', tocDepth: 4, firstLineIndent: 480
};

test('Word renders approved headings, original values, tables and figure references reproducibly', () => {
  const manuscript = [
    '# 1 地块调查',
    '#### 1.1.1.1 样品记录',
    '| 指标 | 值 |',
    '| --- | ---: |',
    '| **原值** | 12.30 &amp; &lt;0.05 |',
    '',
    '原件图位 ![历史影像原件](https://example.invalid/figure.png)',
    '',
    '1. 保留条目',
    '2. 保留次序',
    '',
    '<script>literal evidence marker</script>'
  ].join('\n');
  const a = renderApprovedWord(manuscript, '测试项目 <A>', profile);
  const b = renderApprovedWord(manuscript, '测试项目 <A>', profile);
  assert.deepEqual(a, b);
  const files = unzipSync(a);
  const doc = strFromU8(files['word/document.xml']);
  assert.match(doc, /w:val="Heading4"/);
  assert.match(doc, /w:anchor="section_2"/);
  assert.match(doc, /TOC \\o &quot;1-4&quot;/);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:tblHeader\/>/);
  assert.match(doc, /12\.30 &amp; &lt;0\.05/);
  assert.match(doc, /\[历史影像原件\] \(https:\/\/example\.invalid\/figure\.png\)/);
  assert.match(doc, /<w:t xml:space="preserve">2\. <\/w:t>/);
  assert.match(doc, /&lt;script&gt;literal evidence marker&lt;\/script&gt;/);
  assert.match(doc, /测试项目 &lt;A&gt;/);
  assert.match(strFromU8(files['word/styles.xml']), /w:eastAsia="宋体"/);
  assert.match(strFromU8(files['word/footer1.xml']), /w:instr=" PAGE "/);
  assert.doesNotMatch(strFromU8(files['word/_rels/document.xml.rels']), /TargetMode="External"/);
  assert.ok(Object.keys(files).every(path => !path.startsWith('word/media/')));
});

test('Word export only applies to opted-in reviewed Markdown with a safe file name', () => {
  const pkg = manualProjectPackage({
    id: 'word-test', title: 'Word export fixture', description: 'Fixture',
    inputs: 'Material', objective: 'Review the source'
  });
  assert.equal(packageSchema.safeParse(pkg).success, true);
  pkg.outputs[0].word = profile;
  assert.equal(packageSchema.safeParse(pkg).success, true);
  pkg.outputs[0].word = { ...profile, fileName: '../outside.docx' };
  assert.equal(packageSchema.safeParse(pkg).success, false);
  pkg.outputs[0].word = profile;
  pkg.outputs[0].humanSignoff = false;
  assert.equal(packageSchema.safeParse(pkg).success, false);
});
