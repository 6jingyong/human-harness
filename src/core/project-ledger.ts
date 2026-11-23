import type { ProjectState } from './runtime';
import type { HistoricalBaseline, LedgerEntryInput, ProjectLedger } from '../protocol/project-ledger';

const milliMinute = 60_000;

export type ExternalWait = {
  stepId: string;
  title: string;
  closedMinutes: number;
  openMinutes: number;
  openSince?: string;
};

/** An external interval begins when the milestone becomes actionable after the handoff. */
export function externalWaits(project: ProjectState, asOf: Date): ExternalWait[] {
  const waits = new Map(project.package.steps.filter(step => step.kind === 'external_milestone')
    .map(step => [step.id, { stepId: step.id, title: step.title, closedMs: 0, openSince: undefined as string | undefined }]));
  const end = asOf.getTime();
  for (const event of project.events) {
    const wait = waits.get(event.subject);
    if (!wait) continue;
    const at = Date.parse(event.createdAt);
    if (at > end) continue;
    if (event.type === 'work.state' && event.detail === 'ready') {
      wait.openSince ??= event.createdAt;
    } else if (wait.openSince && (event.type === 'external.confirmed' || event.type === 'work.invalidated' ||
      event.type === 'work.state')) {
      wait.closedMs += Math.max(0, at - Date.parse(wait.openSince));
      wait.openSince = undefined;
    }
  }
  return [...waits.values()].filter(wait => wait.openSince || wait.closedMs > 0).map(wait => ({
    stepId: wait.stepId,
    title: wait.title,
    closedMinutes: Math.floor(wait.closedMs / milliMinute),
    openMinutes: wait.openSince ? Math.floor(Math.max(0, end - Date.parse(wait.openSince)) / milliMinute) : 0,
    openSince: wait.openSince
  }));
}

export function ledgerSummary(ledger: ProjectLedger, waits: ExternalWait[]) {
  const cash = { client: 0, vendor: 0, model: 0, other: 0 };
  const labor = { setup: 0, follow_up: 0, rework: 0, delivery: 0 };
  let laborCents = 0;
  let unpricedMinutes = 0;
  for (const entry of ledger.entries) {
    if (entry.voided) continue;
    if (entry.type === 'cash') {
      cash[entry.kind] += entry.refund ? -entry.cents : entry.cents;
    } else {
      labor[entry.kind] += entry.minutes;
      if (entry.hourlyRateCents === undefined) unpricedMinutes += entry.minutes;
      else laborCents += Math.round(entry.hourlyRateCents * entry.minutes / 60);
    }
  }
  const cashCostCents = cash.vendor + cash.model + cash.other;
  const knownCostCents = cashCostCents + laborCents;
  const { contractCents } = ledger.settings;
  return {
    cash, labor, laborCents, unpricedMinutes, cashCostCents, knownCostCents,
    humanMinutes: Object.values(labor).reduce((sum, value) => sum + value, 0),
    externalWaitMinutes: waits.reduce((sum, wait) => sum + wait.closedMinutes + wait.openMinutes, 0),
    cashBalanceCents: cash.client - cashCostCents,
    openReceivableCents: contractCents === undefined ? undefined : Math.max(0, contractCents - cash.client),
    recordedContributionCents: contractCents === undefined || unpricedMinutes ? undefined : contractCents - knownCostCents
  };
}

export type LedgerSummary = ReturnType<typeof ledgerSummary>;

export type LedgerComparisonMetrics = Partial<Omit<HistoricalBaseline, 'title'>>;

/** A zero entry total with no evidence of measurement is missing data for comparisons. */
export function comparableMetrics(summary: LedgerSummary, ledger: ProjectLedger, waits: ExternalWait[]): LedgerComparisonMetrics {
  const active = ledger.entries.filter(entry => !entry.voided);
  const hasLabor = active.some(entry => entry.type === 'labor');
  const hasCashCosts = active.some(entry => entry.type === 'cash' && entry.kind !== 'client');
  return {
    humanMinutes: hasLabor ? summary.humanMinutes : undefined,
    setupMinutes: hasLabor ? summary.labor.setup : undefined,
    followUpMinutes: hasLabor ? summary.labor.follow_up : undefined,
    reworkMinutes: hasLabor ? summary.labor.rework : undefined,
    externalWaitMinutes: waits.length ? summary.externalWaitMinutes : undefined,
    cashCostCents: hasCashCosts ? summary.cashCostCents : undefined
  };
}

export function ledgerReferenceExists(project: ProjectState, reference: NonNullable<LedgerEntryInput['reference']>) {
  switch (reference.kind) {
    case 'step': return project.package.steps.some(step => step.id === reference.id);
    case 'material': return project.package.materials.some(material => material.id === reference.id);
    case 'work_order': return project.package.workOrders?.some(order => order.id === reference.id) ?? false;
    case 'run': return project.runs.some(run => run.id === reference.id);
  }
}
