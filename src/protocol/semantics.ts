import { z } from 'zod';

/** Optional, reviewable evidence note emitted by an Agent.
 * Source identifiers must later match an authorized, accepted material revision.
 * The model cannot authorize the source or approve its own interpretation.
 */
export const semanticNoteSchema = z.strictObject({
  materialId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  sourceArtifactId: z.string().min(1).max(128),
  sourceRevision: z.number().int().positive(),
  location: z.string().min(1).max(300),
  summary: z.string().min(1).max(4000),
  caveat: z.string().max(1000).optional()
});
export type SemanticNote = z.infer<typeof semanticNoteSchema>;
