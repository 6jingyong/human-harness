import { z } from 'zod';

const orderId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const requirementSchema = z.strictObject({
  due: z.iso.date(),
  brief: z.string().trim().max(800)
});

export const coordinationSettingsSchema = z.strictObject({
  timeZone: z.string().max(100).refine(zone => {
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; }
    catch { return false; }
  }, '请选择有效的项目时区。'),
  requirements: z.record(orderId, requirementSchema)
});

export type CoordinationSettings = z.infer<typeof coordinationSettingsSchema>;
export type ProjectCoordination = CoordinationSettings & { revision: number };
