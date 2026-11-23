/** Validate locked ATX headings without treating code or comments as report headings. */
export function validateMarkdownHeadings(
  content: string,
  headings: readonly { level: number; title: string }[] | undefined
): void {
  if (!headings?.length) return;
  const required = headings.map(heading => '#'.repeat(heading.level) + ' ' + heading.title);
  const locked = new Set(required);
  let index = 0;
  let fence: string | undefined;
  let inComment = false;
  for (const line of content.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      continue;
    }
    if (inComment || line.trimStart().startsWith('<!--')) {
      inComment = !line.includes('-->');
      continue;
    }
    fence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) continue;
    const match = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (!match) continue;
    const heading = match[1] + ' ' + match[2].replace(/[ \t]+#+$/, '').trim();
    if (heading === required[index]) index++;
    else if (locked.has(heading)) {
      throw new Error('Markdown heading is duplicated or out of order: ' + heading);
    }
  }
  if (index !== required.length) throw new Error('Required Markdown heading is missing: ' + required[index]);
}
