import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { centsFromInput } from '../src/protocol/project-ledger';

const directory = mkdtempSync(join(tmpdir(), 'hh-ledger-'));
process.env.HH_DATA_DIR = directory;
const store = await import('../src/core/store');
const { GET, POST } = await import('../src/app/api/v1/projects/[id]/ledger/route');
after(() => rmSync(directory, { recursive: true, force: true }));

const cash = (kind: 'client' | 'vendor' | 'model', cents: number, refund = false) => ({
  id: randomUUID(), type: 'cash', kind, cents, refund, date: '2026-11-23', note: '测试入账'
});

test('cash, labor, refunds and voids stay separate while pricing snapshots survive setting changes', () => {
  const { id } = store.createProject('document-handoff', '账务测试');
  assert.deepEqual(store.getProjectLedger(id).ledger, { revision: 0, settings: { currency: 'CNY' }, entries: [] });

  let revision = 0;
  function update(fields: object) {
    const result = store.updateProjectLedger(id, { ...fields, revision });
    revision = result.ledger.revision;
    return result;
  }
  const settings = (hourlyRateCents: number) => update({
    action: 'settings', settings: { currency: 'CNY', contractCents: 300_000, hourlyRateCents }
  });
  settings(12_000);
  const client = cash('client', 150_000);
  const record = { action: 'record', entry: client, revision };
  assert.equal(update(record).summary.openReceivableCents, 150_000);
  assert.equal(store.updateProjectLedger(id, record).ledger.revision, revision);
  assert.throws(() => store.updateProjectLedger(id, { ...record, entry: { ...client, cents: 1 } }), store.LedgerConflictError);
  update({ action: 'record', entry: cash('client', 10_000, true) });
  update({ action: 'record', entry: cash('vendor', 28_000) });
  const model = cash('model', 325);
  update({ action: 'record', entry: model });
  update({ action: 'record', entry: {
    id: randomUUID(), date: '2026-11-23', note: '资料建档',
    type: 'labor', kind: 'setup', minutes: 90, reference: { kind: 'material', id: 'source-a' }
  } });
  const { summary } = settings(18_000);
  assert.equal(summary.humanMinutes, 90);
  assert.equal(summary.laborCents, 18_000);
  assert.equal(summary.openReceivableCents, 160_000);
  assert.equal(summary.cashBalanceCents, 111_675);
  assert.equal(summary.recordedContributionCents, 253_675);
  assert.throws(() => update({ action: 'settings', settings: { currency: 'USD' } }), /币种已锁定/);
  assert.throws(() => update({ action: 'record', entry: { ...cash('model', 1),
    reference: { kind: 'run', id: randomUUID() } } }), /不属于当前项目/);

  const result = update({ action: 'void', entryId: model.id, reason: '重复导入账单' });
  assert.equal(result.summary.cash.model, 0);
  assert.equal(result.ledger.entries.find(entry => entry.id === model.id)?.voided?.reason, '重复导入账单');
  assert.deepEqual(store.getProjectLedger(id).ledger, result.ledger);
  assert.equal(Object.hasOwn(store.getProject(id), 'ledger'), false);
});

test('historical comparison, incomplete costing and currency-safe rollups stay numerically distinct', () => {
  const a = store.createProject('document-handoff', '首单');
  const b = store.createProject('document-handoff', '第二单');
  store.updateProjectLedger(a.id, { revision: 0, action: 'baseline',
    baseline: { title: '历史对照', humanMinutes: 240, setupMinutes: 120, cashCostCents: 1000 } });
  assert.throws(() => store.updateProjectLedger(a.id, { revision: 1, action: 'baseline',
    baseline: { title: '历史对照', humanMinutes: 20, setupMinutes: 120 } }), /不能超过/);
  store.updateProjectLedger(a.id, { revision: 1, action: 'settings', settings: { currency: 'CNY', contractCents: 1000 } });
  const priced = store.updateProjectLedger(a.id, { revision: 2, action: 'record',
    entry: { id: randomUUID(), date: '2026-11-23', type: 'labor', kind: 'rework', minutes: 20, note: '回件换版核对' } });
  assert.equal(priced.summary.unpricedMinutes, 20);
  assert.equal(priced.summary.recordedContributionCents, undefined);
  assert.equal(store.getProjectLedger(a.id).ledger.baseline?.setupMinutes, 120);
  store.updateProjectLedger(b.id, { revision: 0, action: 'settings', settings: { currency: 'USD' } });
  store.updateProjectLedger(b.id, { revision: 1, action: 'record', entry: cash('client', 42_000) });

  const totals = store.getCompanyLedger().totals;
  assert.equal(totals.find(group => group.currency === 'USD')?.clients, 42_000);
  assert.ok(totals.find(group => group.currency === 'CNY')!.clients > 42_000);
  assert.equal(centsFromInput('0.29'), 29);
  assert.throws(() => centsFromInput('1.234'), /两位小数/);
});

test('ledger reads existing projects and rejects stale writes through the HTTP route', async () => {
  const project = store.createProject('document-handoff', 'HTTP 账务');
  const context = { params: Promise.resolve({ id: project.id }) };
  const request = (body?: unknown) => new Request('http://localhost/ledger', body ? {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
  } : undefined);
  assert.equal((await GET(request(), context)).status, 200);
  assert.equal((await POST(request({ action: 'record', revision: 0, entry: cash('model', 123) }), context)).status, 200);
  assert.equal((await POST(request({ action: 'record', revision: 0, entry: cash('model', 123) }), context)).status, 409);
  assert.equal((await POST(request({ action: 'record', revision: 1, entry: cash('model', 1.5) }), context)).status, 400);
  assert.equal((await GET(request(), { params: Promise.resolve({ id: randomUUID() }) })).status, 404);
  const response = await GET(request(), context);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).summary.cash.model, 123);
});

test('ring-fences a land investigation institution’s waiting from human work and cash', context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-23T01:00:00Z') });
  const template = JSON.parse(readFileSync(
    new URL('../project-templates/land-investigation/land-investigation.hh.json', import.meta.url), 'utf-8'));
  const { id: templateId } = store.importPackage(template);
  const { id } = store.createProject(templateId, '环评经营账');
  store.saveProjectCoordination(id, 0, { timeZone: 'Asia/Shanghai',
    requirements: { 'land-survey': { due: '2026-11-27', brief: '地块边界测量' } } });
  store.completeHuman(id, 'survey-contact', '确认受理');
  assert.equal(store.getProjectLedger(id).waits.length, 0);
  store.submitMaterial(id, 'project-identity', '项目范围和交付要求');
  store.reviewReceivedMaterial(id, 'project-identity', true, '确认真实项目资料');
  store.completeHuman(id, 'survey-book', '已委托地测');
  context.mock.timers.tick(47 * 60_000);
  const open = store.getProjectLedger(id);
  assert.equal(open.waits[0]?.openMinutes, 47);
  assert.equal(open.summary.humanMinutes, 0);
  assert.equal(open.summary.cashCostCents, 0);
  store.completeHuman(id, 'survey-return', '已取得文件');
  context.mock.timers.tick(12 * 60_000);
  const closed = store.getProjectLedger(id);
  assert.equal(closed.waits[0]?.closedMinutes, 47);
  assert.equal(closed.waits[0]?.openSince, undefined);
  assert.equal(closed.summary.externalWaitMinutes, 47);
});
