import { z } from 'zod';
import { validateTemplate, type ProjectTemplate } from './domain';

// Imported templates are untrusted JSON. Validation precedes persistence and execution.
const taskSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  title: z.string().min(1).max(150),
  description: z.string().min(1).max(1500),
  owner: z.enum(['human', 'agent']),
  dependsOn: z.array(z.string()).max(100),
  optional: z.boolean().optional(),
  reviewRequired: z.boolean().optional(),
  inputKind: z.enum(['text', 'file', 'either']).optional(),
  prompt: z.string().min(1).max(5000).optional()
});
const templateSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  title: z.string().min(1).max(150),
  description: z.string().min(1).max(1500),
  version: z.number().int().positive(),
  tasks: z.array(taskSchema).min(1).max(100)
});

export function parseTemplate(input: unknown): ProjectTemplate {
  const value = templateSchema.parse(input);
  validateTemplate(value);
  return value;
}
