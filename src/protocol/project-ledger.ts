import { z } from 'zod';

export const ledgerCurrencies = ['CNY', 'USD', 'HKD', 'SGD', 'EUR'] as const;
export const cashKinds = ['client', 'vendor', 'model', 'other'] as const;
export const laborKinds = ['setup', 'follow_up', 'rework', 'delivery'] as const;
const referenceKinds = ['step', 'material', 'work_order', 'run'] as const;
const cents = z.number().int().nonnegative().max(1_000_000_000);
const recordedMinutes = z.number().int().positive().max(10_080);
const baselineMinutes = z.number().int().nonnegative().max(10_000_000);

export const projectLedgerSettingsSchema = z.strictObject({
  currency: z.enum(ledgerCurrencies),
  contractCents: cents.optional(),
  hourlyRateCents: cents.optional()
});

const historicalBaselineSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  humanMinutes: baselineMinutes,
  setupMinutes: baselineMinutes.optional(),
  followUpMinutes: baselineMinutes.optional(),
  reworkMinutes: baselineMinutes.optional(),
  externalWaitMinutes: baselineMinutes.optional(),
  cashCostCents: cents.optional()
}).refine(baseline =>
  [baseline.setupMinutes, baseline.followUpMinutes, baseline.reworkMinutes].reduce<number>((sum, value) => sum + (value ?? 0), 0)
    <= baseline.humanMinutes, { message: '建档、跟进和返工工时合计不能超过人工总工时。' });

const entryFields = {
  id: z.uuid(),
  date: z.iso.date(),
  note: z.string().trim().min(1).max(500),
  reference: z.strictObject({ kind: z.enum(referenceKinds), id: z.string().min(1).max(150) }).optional()
};

const entrySchema = z.discriminatedUnion('type', [
  z.strictObject({ ...entryFields, type: z.literal('cash'), kind: z.enum(cashKinds),
    cents: cents.positive(), refund: z.boolean() }),
  z.strictObject({ ...entryFields, type: z.literal('labor'), kind: z.enum(laborKinds), minutes: recordedMinutes })
]);

const revision = z.number().int().nonnegative();
export const projectLedgerCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ revision, action: z.literal('settings'), settings: projectLedgerSettingsSchema }),
  z.strictObject({ revision, action: z.literal('record'), entry: entrySchema }),
  z.strictObject({ revision, action: z.literal('void'), entryId: z.uuid(), reason: z.string().trim().min(1).max(240) }),
  z.strictObject({ revision, action: z.literal('baseline'), baseline: historicalBaselineSchema.nullable() })
]);

export type ProjectLedgerSettings = z.infer<typeof projectLedgerSettingsSchema>;
export type ProjectLedgerCommand = z.infer<typeof projectLedgerCommandSchema>;
export type HistoricalBaseline = z.infer<typeof historicalBaselineSchema>;
export type LedgerEntryInput = z.infer<typeof entrySchema>;
export type LedgerReference = NonNullable<LedgerEntryInput['reference']>;
export type LedgerEntry = LedgerEntryInput & {
  recordedAt: string;
  voided?: { at: string; reason: string };
  hourlyRateCents?: number;
};
export type ProjectLedger = {
  revision: number;
  settings: ProjectLedgerSettings;
  entries: LedgerEntry[];
  baseline?: HistoricalBaseline;
};

export const cashKindLabels: Record<typeof cashKinds[number], string> = {
  client: '客户回款', vendor: '外包与第三方', model: '模型与工具', other: '其他支出'
};
export const laborKindLabels: Record<typeof laborKinds[number], string> = {
  setup: '接入与建档', follow_up: '沟通与追件', rework: '变更与返工', delivery: '制作与审核'
};

/** Parse user-facing decimal amounts exactly, with no floating point currency rounding. */
export function centsFromInput(raw: string): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) throw new Error('金额须为非负数，最多保留两位小数。');
  const [whole, decimal = ''] = value.split('.');
  const parsed = cents.safeParse(Number(whole) * 100 + Number(decimal.padEnd(2, '0')));
  if (!parsed.success) throw new Error('金额超出可记录范围。');
  return parsed.data;
}
