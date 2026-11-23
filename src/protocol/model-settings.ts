import { z } from 'zod';

export const providerSchema = z.enum(['demo', 'codex', 'ollama', 'mastra']);
export type Provider = z.infer<typeof providerSchema>;
export function configuredExecutorMode(mode = process.env.HH_EXECUTOR): Provider {
  const result = providerSchema.safeParse(mode || 'demo');
  if (!result.success) throw new Error('Unsupported HH_EXECUTOR=' + mode);
  return result.data;
}
const modelId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);
export const modelSettingsSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('demo'), model: z.null() }),
  z.strictObject({ provider: z.literal('codex'), model: modelId.nullable() }),
  z.strictObject({ provider: z.literal('ollama'), model: modelId }),
  z.strictObject({ provider: z.literal('mastra'), model: modelId.regex(/^[\w-]+\/[\w][\w.:/@-]*$/) })
]);
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ModelOption = { id: string; name: string; isDefault?: boolean };
