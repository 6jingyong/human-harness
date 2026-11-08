import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ExecutorTask } from './contracts';

export type StagedDocument = Readonly<{
  artifactId: string;
  revision: number;
  /** Relative to the isolated work directory. Never the project's private upload path. */
  path: string;
  format: 'pdf' | 'docx';
  sha256: string;
}>;

const formats = new Map<string, 'pdf' | 'docx'>([['.pdf', 'pdf'], ['.docx', 'docx']]);

/** Stage only the exact approved originals supplied by the shared runner.
 * This directory is a temporary task capability, not a shared project mount.
 */
export function stageAuthorizedDocuments(task: ExecutorTask, workdir: string): StagedDocument[] {
  const candidates = task.evidence.filter(e => e.originalFile);
  if (!candidates.length) return [];
  const inputs = join(workdir, 'inputs');
  mkdirSync(inputs, { recursive: true, mode: 0o700 });
  const staged: StagedDocument[] = [];
  for (const evidence of candidates) {
    const original = evidence.originalFile!;
    const format = formats.get(extname(evidence.name).toLowerCase());
    if (!format) {
      throw new Error('Codex document workspace currently supports only PDF/DOCX originals, not ' + evidence.name);
    }
    const actualHash = createHash('sha256').update(original.bytes).digest('hex');
    if (actualHash !== original.sha256) throw new Error('Authorized document byte digest mismatch');
    const safeName = basename(evidence.name).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-96) || ('document.' + format);
    const filename = evidence.artifactId.replace(/[^a-zA-Z0-9_-]/g, '_') + '-' +
      String(evidence.revision) + '-' + safeName;
    const relativePath = 'inputs/' + filename;
    const absolute = join(inputs, filename);
    writeFileSync(absolute, original.bytes, { flag: 'wx', mode: 0o400 });
    chmodSync(absolute, 0o400);
    staged.push({
      artifactId: evidence.artifactId, revision: evidence.revision,
      path: relativePath, format, sha256: actualHash
    });
  }
  return staged;
}
