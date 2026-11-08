import { z } from 'zod';
import type { HumanHarnessTaskPacket } from '../protocol/v1';

/** Executor-visible context. Never expose the full project snapshot or private upload paths. */
export type AuthorizedEvidence = Readonly<{
  artifactId: string;
  revision: number;
  role: HumanHarnessTaskPacket['readableInputs'][number]['role'];
  name: string;
  /** Null means the original file is stored but its contents have not been parsed. */
  content: string | null;
  /** A copy of an accepted original, never the private storage path. Codex stages these bytes per run. */
  originalFile?: Readonly<{ bytes: Uint8Array; sha256: string }>;
}>;

export type ExecutorTask = Readonly<{
  packet: HumanHarnessTaskPacket;
  stepTitle: string;
  evidence: readonly AuthorizedEvidence[];
  reviewFeedback: readonly string[];
  /** Completed direct upstream Human Todo answers, explicitly scoped by task dependencies. */
  humanHandoffs?: readonly Readonly<{ stepId: string; kind: string; value: string }>[];
}>;

/** A candidate from an executor, never a command to mutate authoritative project state. */
export const executorOutputSchema = z.strictObject({
  body: z.string().min(1).max(100000),
  limitations: z.array(z.string().min(1).max(4000)).max(30),
  materialRequests: z.array(z.strictObject({
    materialId: z.string().min(1).max(128),
    reason: z.string().min(1).max(4000)
  })).max(20)
});
export type ExecutorOutput = z.infer<typeof executorOutputSchema>;

export type ExecutorRunEvent =
  | { kind: 'thread'; id: string }
  | { kind: 'turn'; id: string }
  | { kind: 'progress'; message: string };

export interface TaskExecutor {
  readonly id: string;
  execute(task: ExecutorTask, onEvent?: (event: ExecutorRunEvent) => void): Promise<ExecutorOutput>;
}

/** Shared text-only presentation for the existing Mastra adapter.
 * Codex may later use a controlled filesystem view; it must not inherit arbitrary host paths.
 */
export function renderTextContext(task: ExecutorTask): string {
  const chunks = [
    'TASK PACKET (runtime-issued):\n' + JSON.stringify(task.packet, null, 2),
    'Relevant accessible project evidence follows. No other files were authorized.'
  ];
  let remaining = 18000;
  for (const evidence of task.evidence) {
    const body = evidence.content === null
      ? '[Binary document stored but not parsed. Its contents are unavailable.]'
      : evidence.content;
    const text = ('Artifact ' + evidence.artifactId + ' / ' + evidence.name + ' / ' + evidence.role + ':\n' + body)
      .slice(0, Math.min(remaining, 4500));
    chunks.push(text);
    remaining -= text.length;
    if (!remaining) break;
  }
  if (task.humanHandoffs?.length) {
    chunks.push('Completed upstream Human Todo answers (user declarations, not independently verified):\n' +
      JSON.stringify(task.humanHandoffs, null, 2));
  }
  if (task.reviewFeedback.length) {
    chunks.push('Previous review feedback:\n' + task.reviewFeedback.join('\n'));
  }
  return chunks.join('\n\n');
}
