import { z } from 'zod';
import type { HumanHarnessTaskPacket, HumanHarnessPackage } from '../protocol/v1';
import { semanticNoteSchema, type SemanticNote } from '../protocol/semantics';

/** Executor-visible context. Never expose the full project snapshot or private upload paths. */
export type AuthorizedEvidence = Readonly<{
  artifactId: string;
  revision: number;
  role: HumanHarnessTaskPacket['readableInputs'][number]['role'];
  name: string;
  /** Null means the original file is stored but its contents have not been parsed. */
  content: string | null;
  /** User-provided context about a source, never confused with original contents. */
  submissionNote?: string;
  /** A copy of an accepted original, never the private storage path. Codex stages these bytes per run. */
  originalFile?: Readonly<{ bytes: Uint8Array; sha256: string }>;
}>;

export type ExecutorTask = Readonly<{
  packet: HumanHarnessTaskPacket;
  stepTitle: string;
  /** Immutable, pinned template method for this exact step only. */
  workMethod?: HumanHarnessPackage['steps'][number]['method'];
  /** Methods for this step's authorized or requestable material IDs only. */
  materialMethods?: readonly Readonly<{
    materialId: string; title: string;
    method: NonNullable<HumanHarnessPackage['materials'][number]['method']>;
  }>[];
  /** Existing output contract acceptance is always a Human review gate. */
  outputAcceptance?: readonly string[];
  evidence: readonly AuthorizedEvidence[];
  reviewFeedback: readonly string[];
  /** Only material categories declared for this WorkItem in the pinned project template. */
  requestableMaterials?: readonly Readonly<{ id: string; title: string; description: string }>[];
  /** Source-validated and human-approved semantic notes on task-authorized materials. */
  approvedSemanticNotes?: readonly SemanticNote[];
  /** Completed direct upstream Human Todo answers, explicitly scoped by task dependencies. */
  humanHandoffs?: readonly Readonly<{ stepId: string; kind: string; value: string }>[];
}>;

/** A candidate from an executor, never a command to mutate authoritative project state. */
export const executorOutputSchema = z.strictObject({
  body: z.string().min(1).max(100000),
  limitations: z.array(z.string().min(1).max(4000)).max(30),
  semanticNotes: z.array(semanticNoteSchema).max(30).optional(),
  /** Untrusted Agent self-assessment; requires exact template checklist IDs. */
  methodChecks: z.array(z.strictObject({
    checkId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    status: z.enum(['passed', 'failed', 'unverified']),
    explanation: z.string().min(1).max(4000),
    evidenceRefs: z.array(z.string().min(1).max(128)).max(30)
  })).max(20).optional(),
  materialRequests: z.array(z.strictObject({
    materialId: z.string().min(1).max(128),
    reason: z.string().min(1).max(4000)
  })).max(20)
});
export type ExecutorOutput = z.infer<typeof executorOutputSchema>;
export type MethodCheckResult = NonNullable<ExecutorOutput['methodChecks']>[number];

export type ExecutorRunEvent =
  | { kind: 'thread'; id: string }
  | { kind: 'turn'; id: string }
  | { kind: 'progress'; message: string };

export interface TaskExecutor {
  readonly id: string;
  execute(task: ExecutorTask, onEvent?: (event: ExecutorRunEvent) => void, signal?: AbortSignal): Promise<ExecutorOutput>;
}

/** Shared text-only presentation for the existing Mastra adapter.
 * Codex may later use a controlled filesystem view; it must not inherit arbitrary host paths.
 */
export function renderTextContext(task: ExecutorTask): string {
  const chunks = [
    'TASK PACKET (runtime-issued):\n' + JSON.stringify(task.packet, null, 2),
    'Relevant accessible project evidence follows. No other files were authorized.'
  ];
  let remaining = 40000;
  for (const evidence of task.evidence) {
    const body = evidence.content === null
      ? '[Binary document stored but not parsed. Its contents are unavailable.]'
      : evidence.content;
    const sourceNote = evidence.submissionNote
      ? '\n[Human source note, not original content]: ' + evidence.submissionNote.slice(0, 1000) : '';
    const full = 'Artifact ' + evidence.artifactId + ' / ' + evidence.name + ' / ' + evidence.role + ':\n' + body + sourceNote;
    const limit = Math.min(remaining, 12000);
    const text = full.length > limit
      ? full.slice(0, Math.max(0, limit - 90)) +
        '\n[TRUNCATED SOURCE TEXT: remaining content was NOT provided; do not claim full review.]'
      : full;
    chunks.push(text);
    remaining -= Math.min(limit, text.length);
    if (remaining <= 0) break;
  }
  if (task.workMethod) {
    chunks.push('PINNED WORK METHOD (instructions/checks are template-owned, not runtime-generated):\n' +
      JSON.stringify(task.workMethod, null, 2));
  }
  if (task.materialMethods?.length) {
    chunks.push('SCOPED MATERIAL METHODS (acquire/extract/verify only for this step):\n' +
      JSON.stringify(task.materialMethods, null, 2).slice(0, 10000));
  }
  if (task.outputAcceptance?.length) {
    chunks.push('HUMAN OUTPUT ACCEPTANCE REQUIREMENTS:\n' +
      task.outputAcceptance.join('\n'));
  }
  if (task.requestableMaterials?.length) {
    chunks.push('Template-authorized materials for actionable Human clarification requests:\n' +
      JSON.stringify(task.requestableMaterials, null, 2).slice(0, 8000));
  }
  if (task.humanHandoffs?.length) {
    chunks.push('Completed upstream Human Todo answers (user declarations, not independently verified):\n' +
      JSON.stringify(task.humanHandoffs, null, 2));
  }
  if (task.approvedSemanticNotes?.length) {
    chunks.push('Approved, source-version-checked semantic notes for authorized inputs:\n' +
      JSON.stringify(task.approvedSemanticNotes.slice(0, 30), null, 2).slice(0, 12000));
  }
  if (task.reviewFeedback.length) {
    chunks.push('Previous review feedback:\n' + task.reviewFeedback.join('\n'));
  }
  return chunks.join('\n\n');
}
