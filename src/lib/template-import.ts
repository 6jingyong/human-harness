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
  inputKind: z.enum(['text', 'file', 'either', 'choice']).optional(),
  prompt: z.string().min(1).max(5000).optional(),
  stageId: z.string().min(1).max(64).optional(),
  resourceRefs: z.array(z.string().min(1).max(64)).max(30).optional(),
  execution: z.strictObject({ mode: z.enum(['llm', 'script']), scriptId: z.string().min(1).max(64).optional() }).optional(),
  choices: z.array(z.strictObject({ value: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), label: z.string().min(1).max(160) })).min(2).max(12).optional(),
  activateWhen: z.strictObject({ gateTaskId: z.string().min(1).max(64), equals: z.string().min(1).max(64) }).optional()
});
const templateSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  title: z.string().min(1).max(150),
  description: z.string().min(1).max(1500),
  version: z.number().int().positive(),
  schemaVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  materials: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    title: z.string().min(1).max(150), taskId: z.string().min(1).max(64),
    producer: z.enum(['human', 'external_institution']),
    required: z.boolean().optional(), note: z.string().max(1000).optional()
  })).max(100).optional(),
  workflow: z.strictObject({ stages: z.array(z.strictObject({ id: z.string().min(1).max(64), title: z.string().min(1).max(150), description: z.string().min(1).max(1500) })).min(1).max(30) }).optional(),
  resources: z.array(z.strictObject({
    id: z.string().min(1).max(64), kind: z.enum(['reference', 'document-template', 'automation']),
    title: z.string().min(1).max(150), content: z.string().max(30000).optional(),
    scriptId: z.string().min(1).max(64).optional(), origin: z.string().max(500).optional()
  })).max(100).optional(),
  deliverables: z.array(z.strictObject({
    id: z.string().min(1).max(64), taskId: z.string().min(1).max(64),
    fileName: z.string().min(1).max(160), format: z.enum(['markdown', 'text', 'json']),
    minChars: z.number().int().min(1).max(100000).optional(),
    requiredHeadings: z.array(z.string().min(1).max(200)).max(30).optional()
  })).max(100).optional(),
  tasks: z.array(taskSchema).min(1).max(100)
});

export function parseTemplate(input: unknown): ProjectTemplate {
  const value = templateSchema.parse(input);
  validateTemplate(value);
  return value;
}
