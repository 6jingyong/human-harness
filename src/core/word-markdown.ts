import { marked, type Token, type Tokens } from 'marked';

const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? match;
    const base = code[1]?.toLowerCase() === 'x' ? 16 : 10;
    const point = parseInt(code.slice(base === 16 ? 2 : 1), base);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

export function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function wordText(value: string, properties = ''): string {
  return '<w:r>' + (properties ? '<w:rPr>' + properties + '</w:rPr>' : '') +
    '<w:t xml:space="preserve">' + escapeXml(value) + '</w:t></w:r>';
}

function inline(tokens: Token[], properties = ''): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'strong': return inline((token as Tokens.Strong).tokens, properties + '<w:b/>');
      case 'em': return inline((token as Tokens.Em).tokens, properties + '<w:i/>');
      case 'del': return inline((token as Tokens.Del).tokens, properties + '<w:strike/>');
      case 'br': return '<w:r><w:br/></w:r>';
      case 'link': {
        const link = token as Tokens.Link;
        const label = inline(link.tokens, properties);
        return label + (link.href === link.text ? '' : wordText(' (' + link.href + ')', properties));
      }
      case 'image': {
        const image = token as Tokens.Image;
        return wordText('[' + decodeEntities(image.text) + '] (' + image.href + ')', properties);
      }
      case 'codespan':
        return wordText((token as Tokens.Codespan).text, properties);
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens, properties) : wordText(decodeEntities(text.text), properties);
      }
      case 'escape':
        return wordText((token as Tokens.Escape).text, properties);
      default:
        return wordText(token.raw, properties);
    }
  }).join('');
}

export function wordParagraph(runs: string, style?: string, extra = ''): string {
  const properties = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + extra;
  return '<w:p>' + (properties ? '<w:pPr>' + properties + '</w:pPr>' : '') + runs + '</w:p>';
}

function wordTable(table: Tokens.Table, width: number): string {
  const columns = table.header.length;
  if (!columns) return '';
  const cellWidth = Math.floor(width / columns);
  const grid = Array.from({ length: columns }, (_, column) =>
    '<w:gridCol w:w="' + (column === columns - 1 ? width - cellWidth * column : cellWidth) + '"/>').join('');
  const row = (cells: Tokens.TableCell[], header: boolean) => {
    const content = cells.map((cell, i) => {
      const align = table.align[i];
      const properties = (header ? '<w:shd w:val="clear" w:fill="E9EEF4"/>' : '');
      return '<w:tc>' + (properties ? '<w:tcPr>' + properties + '</w:tcPr>' : '') +
        wordParagraph(inline(cell.tokens, header ? '<w:b/>' : ''), 'TableText',
          align ? '<w:jc w:val="' + align + '"/>' : '') + '</w:tc>';
    }).join('');
    return '<w:tr>' + (header ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + content + '</w:tr>';
  };
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(side => '<w:' + side + ' w:val="single" w:sz="4" w:color="C3CCD5"/>').join('');
  return '<w:tbl><w:tblPr><w:tblW w:w="' + width + '" w:type="dxa"/>' +
    '<w:tblBorders>' + borders + '</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>' +
    '<w:tblGrid>' + grid + '</w:tblGrid>' + row(table.header, true) +
    table.rows.map(cells => row(cells, false)).join('') + '</w:tbl>';
}

export function markdownToWord(source: string, tableWidth: number) {
  const headings: { depth: number; name: string; runs: string }[] = [];
  function blocks(tokens: Token[], inset = 0, marker = ''): string {
    let prefix = marker;
    return tokens.map(token => {
      if (token.type === 'space') return '';
      if (token.type === 'heading') {
        const heading = token as Tokens.Heading;
        const id = headings.length + 1;
        const name = 'section_' + id;
        const runs = inline(heading.tokens);
        headings.push({ depth: heading.depth, name, runs });
        return wordParagraph('<w:bookmarkStart w:id="' + id + '" w:name="' + name + '"/>' +
          runs + '<w:bookmarkEnd w:id="' + id + '"/>', 'Heading' + heading.depth);
      }
      if (token.type === 'table') return wordTable(token as Tokens.Table, tableWidth);
      if (token.type === 'list') {
        const list = token as Tokens.List;
        const start = typeof list.start === 'number' ? list.start : 1;
        return list.items.map((item, i) =>
          blocks(item.tokens, inset + 360, list.ordered ? (start + i) + '. ' : '• ')).join('');
      }
      if (token.type === 'blockquote') return blocks((token as Tokens.Blockquote).tokens, inset + 360);
      if (token.type === 'code') {
        return (token as Tokens.Code).text.split('\n').map(line => wordParagraph(wordText(line), 'Code')).join('');
      }
      if (token.type === 'hr') return wordParagraph('', 'Rule');
      const item = token as Tokens.Text | Tokens.Paragraph;
      const content = (prefix ? wordText(prefix) : '') +
        (item.tokens ? inline(item.tokens) : wordText(item.type === 'text' ? decodeEntities(item.text) : item.raw));
      prefix = '';
      return wordParagraph(content, inset ? 'Indented' : undefined,
        inset ? '<w:ind w:left="' + inset + '"/>' : '');
    }).join('');
  }
  return { body: blocks(marked.lexer(source, { gfm: true })), headings };
}
