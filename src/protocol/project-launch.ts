import { z } from 'zod';
import type { HumanHarnessPackage } from './v1';
import { coordinationSettingsSchema } from './coordination';
import { planSettingsSchema } from './planning';

export const projectSetupSchema = z.strictObject({
  planning: planSettingsSchema,
  requirements: coordinationSettingsSchema.shape.requirements
});

export const projectLaunchSchema = z.strictObject({
  packageId: z.string().min(1).max(128),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  title: z.string().trim().min(1).max(150),
  setup: projectSetupSchema.optional()
});

export type ProjectSetup = z.infer<typeof projectSetupSchema>;
export type ProjectLaunch = z.infer<typeof projectLaunchSchema>;

export type LaunchPreview = {
  humanTodos: {
    key: string;
    title: string;
    kind: string;
    latestStart?: number;
    lateToStart?: boolean;
  }[];
  deliverables: { id: string; title: string; format: string; word?: boolean }[];
  readyAgent: number;
  finish: number | null;
  behindTarget: boolean;
  partial: boolean;
  atRisk: string[];
};

/** Older templates infer delivery from their terminal outputs. */
export function templateDeliverables(template: HumanHarnessPackage) {
  const declared = template.outputs.filter(output => output.deliverable);
  if (declared.length) return declared;
  const internal = new Set(template.steps.flatMap(step => step.dependsOn));
  return template.outputs.filter(out => !internal.has(out.producingStepId));
}
