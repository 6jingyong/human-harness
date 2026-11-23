import { strToU8, zipSync } from 'fflate';
import type { WordExportProfile } from '../protocol/v1';
import { escapeXml, markdownToWord, wordParagraph, wordText } from './word-markdown';

const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const packageTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const pageWidth = 11906;
const margin = 1440;
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function styles(profile: WordExportProfile): string {
  const bodyFont = escapeXml(profile.bodyFont ?? 'Calibri');
  const headingFont = escapeXml(profile.headingFont ?? profile.bodyFont ?? 'Calibri');
  const fonts = (name: string) => '<w:rFonts w:ascii="' + name + '" w:hAnsi="' + name + '" w:eastAsia="' + name + '"/>';
  const style = (id: string, name: string, p: string, r = '') =>
    '<w:style w:type="paragraph" w:styleId="' + id + '"' + (id === 'Normal' ? ' w:default="1"' : '') +
    '><w:name w:val="' + name + '"/>' + (id === 'Normal' ? '' : '<w:basedOn w:val="Normal"/>') +
    '<w:pPr>' + p + '</w:pPr>' + (r ? '<w:rPr>' + r + '</w:rPr>' : '') + '</w:style>';
  const headings = [32, 28, 26, 24, 24, 24].map((size, index) =>
    style('Heading' + (index + 1), 'heading ' + (index + 1),
      '<w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="100"/><w:ind w:firstLine="0"/>' +
      '<w:outlineLvl w:val="' + index + '"/>', fonts(headingFont) + '<w:b/><w:sz w:val="' + size + '"/>')).join('');
  const toc = Array.from({ length: 6 }, (_, index) =>
    style('TOC' + (index + 1), 'toc ' + (index + 1),
      '<w:spacing w:after="65"/><w:ind w:left="' + index * 240 + '" w:firstLine="0"/>')).join('');
  return xml + '<w:styles xmlns:w="' + word + '">' +
    style('Normal', 'Normal', '<w:spacing w:after="100" w:line="360" w:lineRule="auto"/>' +
      '<w:ind w:firstLine="' + (profile.firstLineIndent ?? 0) + '"/>', fonts(bodyFont) + '<w:sz w:val="24"/>') +
    style('Title', 'Title', '<w:keepNext/><w:spacing w:before="350" w:after="220"/><w:ind w:firstLine="0"/>' +
      '<w:jc w:val="center"/>', fonts(headingFont) + '<w:b/><w:sz w:val="38"/>') +
    style('Subtitle', 'Subtitle', '<w:spacing w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/>') +
    style('TableText', 'Table Text', '<w:spacing w:before="60" w:after="60"/><w:ind w:firstLine="0"/>', '<w:sz w:val="21"/>') +
    style('Indented', 'Indented', '<w:ind w:firstLine="0"/>') +
    style('Code', 'Code', '<w:spacing w:after="0"/><w:ind w:firstLine="0"/>', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>') +
    style('Rule', 'Rule', '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>') +
    headings + toc + '</w:styles>';
}

function contents(depth: number, headings: ReturnType<typeof markdownToWord>['headings']): string {
  const entries = headings.filter(heading => heading.depth <= depth);
  if (!entries.length) return '';
  const start = '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve">' +
      escapeXml(' TOC \\o "1-' + depth + '" \\h \\z \\u ') + '</w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  return wordParagraph(wordText('目录'), 'Title') + entries.map((heading, index) =>
    wordParagraph((index === 0 ? start : '') +
      '<w:hyperlink w:anchor="' + heading.name + '">' + heading.runs + '</w:hyperlink>' +
      (index === entries.length - 1 ? end : ''), 'TOC' + heading.depth)
  ).join('') + pageBreak;
}

/** Create a local Word representation of the approved report text. */
export function renderApprovedWord(source: string, projectTitle: string, profile: WordExportProfile): Uint8Array<ArrayBuffer> {
  const { body, headings } = markdownToWord(source, pageWidth - 2 * margin);
  const document = xml + '<w:document xmlns:w="' + word + '" xmlns:r="' + office + '"><w:body>' +
    wordParagraph(wordText(profile.title), 'Title') + wordParagraph(wordText(projectTitle), 'Subtitle') +
    (profile.tocDepth ? contents(profile.tocDepth, headings) : '') + body +
    '<w:sectPr><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="' + pageWidth + '" w:h="16838"/>' +
    '<w:pgMar w:top="' + margin + '" w:right="' + margin + '" w:bottom="' + margin + '" w:left="' + margin +
      '" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const relation = (id: string, type: string, target: string) =>
    '<Relationship Id="' + id + '" Type="' + office + '/' + type + '" Target="' + target + '"/>';
  const relationships = (rows: string) => xml + '<Relationships xmlns="' + packageRels + '">' + rows + '</Relationships>';
  const override = (file: string, type: string) =>
    '<Override PartName="/word/' + file + '.xml" ContentType="' + wordType + type + '+xml"/>';
  const parts = {
    '[Content_Types].xml': xml + '<Types xmlns="' + packageTypes + '">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      override('document', 'document.main') + override('styles', 'styles') + override('settings', 'settings') +
      override('footer1', 'footer') + '</Types>',
    '_rels/.rels': relationships(relation('document', 'officeDocument', 'word/document.xml')),
    'word/document.xml': document,
    'word/_rels/document.xml.rels': relationships(relation('styles', 'styles', 'styles.xml') +
      relation('settings', 'settings', 'settings.xml') + relation('footer', 'footer', 'footer1.xml')),
    'word/styles.xml': styles(profile),
    'word/settings.xml': xml + '<w:settings xmlns:w="' + word + '"><w:updateFields w:val="true"/></w:settings>',
    'word/footer1.xml': xml + '<w:ftr xmlns:w="' + word + '">' +
      wordParagraph('<w:fldSimple w:instr=" PAGE ">' + wordText('1') + '</w:fldSimple>',
        'Indented', '<w:jc w:val="center"/>') + '</w:ftr>'
  };
  return new Uint8Array(zipSync(Object.fromEntries(Object.entries(parts).map(([path, text]) => [path, strToU8(text)])),
    { mtime: new Date(2000, 0, 1) }));
}
