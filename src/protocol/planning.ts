import { z } from 'zod';

export const pools = ['human', 'agent', 'external'] as const;
export type Pool = (typeof pools)[number];
const minutesPerSlot = 30;
export const estimateMinutes = z.number().int().min(15).max(24000).multipleOf(15);
const workingMinutes = z.number().int().min(minutesPerSlot).max(720).multipleOf(minutesPerSlot);
const lanes = z.number().int().min(1).max(8);
const key = z.string().regex(/^(step|material|review|request):[\w-]{1,128}$/);
const identifier = z.string().regex(/^[\w-]{1,128}$/);
const timeZone = z.string().max(100).refine(zone => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'Invalid project time zone');

export const planSettingsSchema = z.strictObject({
  timeZone, start: z.iso.date(), due: z.iso.date().optional(),
  humanLanes: lanes, externalLanes: lanes,
  humanMinutes: workingMinutes, agentMinutes: workingMinutes, externalMinutes: workingMinutes,
  restrictAgentStarts: z.boolean().optional(),
  estimates: z.record(key, estimateMinutes),
  taskDueDates: z.record(key, z.iso.date()).optional(),
  assumptions: z.record(identifier, identifier),
  expedited: z.array(key).max(100)
}).refine(plan => !plan.due || plan.start <= plan.due, 'Target date must be on or after the start date');

export type PlanSettings = z.infer<typeof planSettingsSchema>;
export type PlanBaseline = {
  capturedAt: string;
  timeZone: string;
  due?: string;
  finish: number | null;
  tasks: Record<string, { start: number; finish: number }>;
};
export type ProjectPlanning = {
  revision: number;
  settings: PlanSettings;
  baseline?: PlanBaseline;
};
