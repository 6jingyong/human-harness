'use client';

import './project-ledger.css';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { comparableMetrics } from '@/core/project-ledger';
import type { ProjectState } from '@/core/runtime';
import type { ProjectLedgerView as LedgerView } from '@/core/store';
import {
  cashKinds, cashKindLabels, centsFromInput, laborKinds, laborKindLabels, ledgerCurrencies,
  projectLedgerCommandSchema, type HistoricalBaseline, type LedgerEntry, type ProjectLedgerCommand,
  type LedgerReference, type ProjectLedgerSettings
} from '@/protocol/project-ledger';

type CommandPayload<T = ProjectLedgerCommand> = T extends ProjectLedgerCommand ? Omit<T, 'revision'> : never;
type Currency = ProjectLedgerSettings['currency'];
type RelatedProject = { id: string; title: string; package_id: string; package_version: string };
type Reference = LedgerReference;
type RefOption = { key: string; title: string; reference: Reference };

const endpoint = (id: string) => '/api/v1/projects/' + encodeURIComponent(id) + '/ledger';
const refGroups = { work_order: '外部事项', step: '流程任务', material: '资料', run: '执行批次' } as const;
const ledgerDate = (project: ProjectState) => new Date().toLocaleDateString('sv-SE', {
  timeZone: project.planning?.settings.timeZone ?? project.coordination?.timeZone
});
export const cashText = (value: number | undefined, currency: Currency) => value === undefined ? '—' :
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency, currencyDisplay: 'code' }).format(value / 100);
const inputAmount = (value?: number) => value === undefined ? '' : (value / 100).toFixed(2);
function timeText(minutes?: number) {
  if (minutes === undefined) return '—';
  const sign = minutes < 0 ? '−' : '';
  const positive = Math.abs(minutes), hours = Math.floor(positive / 60), rest = positive % 60;
  return sign + (hours ? hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '') : rest + ' 分钟');
}

async function readLedger(response: Response): Promise<LedgerView> {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '无法加载项目账务。');
  return payload;
}

function referenceOptions(project: ProjectState): RefOption[] {
  const steps = project.package.steps;
  const stepTitles = new Map(steps.map(step => [step.id, step.title]));
  function list(kind: Reference['kind'], values: { id: string; title: string }[]) {
    return values.map(({ id, title }) => ({ key: kind + ':' + id, title, reference: { kind, id } }));
  }
  return [
    ...list('work_order', project.package.workOrders ?? []),
    ...list('step', steps),
    ...list('material', project.package.materials),
    ...list('run', project.runs.slice().reverse().map(run => ({
      id: run.id, title: (stepTitles.get(run.stepId) ?? run.stepId) + ' · ' + new Date(run.startedAt).toLocaleString('zh-CN')
    })))
  ];
}

type Save = (command: CommandPayload) => Promise<boolean>;
type OnError = (message: string) => void;

function LedgerSettings({ value, locked, busy, save, onError }: {
  value: ProjectLedgerSettings; locked: boolean; busy: boolean; save: Save; onError: OnError;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      void save({ action: 'settings', settings: {
        currency: locked ? value.currency : form.get('currency') as Currency,
        contractCents: centsFromInput(String(form.get('contract') ?? '')),
        hourlyRateCents: centsFromInput(String(form.get('rate') ?? ''))
      } });
    } catch (error) { onError((error as Error).message); }
  }

  return <details className="ledger-panel">
    <summary>账务设置</summary>
    <form className="ledger-form" onSubmit={submit}>
      <fieldset disabled={busy} className="ledger-fields">
        <label>项目币种<select name="currency" defaultValue={value.currency} disabled={locked}>
          {ledgerCurrencies.map(currency => <option key={currency}>{currency}</option>)}
        </select></label>
        <label>合同约定总额<input name="contract" inputMode="decimal" placeholder="未设定" defaultValue={inputAmount(value.contractCents)} /></label>
        <label>人工时薪估值<input name="rate" inputMode="decimal" placeholder="留空只记工时" defaultValue={inputAmount(value.hourlyRateCents)} /></label>
        <button className="primary" type="submit">保存账务设置</button>
      </fieldset>
      <p className="muted">时薪用于估算新增工时的成本。账务按项目币种记录，调整时薪时保留旧工时的估值。</p>
    </form>
  </details>;
}

function EntryForm({ project, refs, currency, initialReference, busy, save, onError }: {
  project: ProjectState; refs: RefOption[]; currency: Currency; initialReference?: LedgerReference;
  busy: boolean; save: Save; onError: OnError;
}) {
  const [type, setType] = useState(initialReference?.kind === 'run' ? 'cash:model' : initialReference ? 'labor:delivery' : 'cash:client');
  const attempt = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const isLabor = type.startsWith('labor:');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const read = (key: string) => String(form.get(key) ?? '');
    try {
      const ref = refs.find(item => item.key === read('reference'))?.reference;
      const shared = { date: read('date'), note: read('note').trim(), reference: ref };
      const entry = isLabor
        ? { ...shared, type: 'labor' as const, kind: type.slice(6) as typeof laborKinds[number], minutes: Number(read('minutes')) }
        : { ...shared, type: 'cash' as const, kind: type.slice(5) as typeof cashKinds[number],
            cents: centsFromInput(read('amount')) ?? 0, refund: form.has('refund') };
      if (entry.type === 'cash' && !entry.cents) throw new Error('请填写大于零的收支金额。');
      const fingerprint = JSON.stringify(entry);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
      if (await save({ action: 'record', entry: { ...entry, id: attempt.current.id } })) {
        attempt.current = undefined;
        element.reset();
      }
    } catch (error) { onError((error as Error).message); }
  }

  return <section className="ledger-panel" aria-labelledby="ledger-record-title">
    <h2 id="ledger-record-title">记一笔</h2>
    <form onSubmit={event => void submit(event)} className="ledger-form">
      <fieldset disabled={busy} className="ledger-fields">
        <label>账目类别<select value={type} onChange={event => setType(event.target.value)}>
          <optgroup label="现金收支">{cashKinds.map(kind => <option key={kind} value={'cash:' + kind}>{cashKindLabels[kind]}</option>)}</optgroup>
          <optgroup label="实际人工">{laborKinds.map(kind => <option key={kind} value={'labor:' + kind}>{laborKindLabels[kind]}</option>)}</optgroup>
        </select></label>
        <label>发生日期<input type="date" name="date" required defaultValue={ledgerDate(project)} /></label>
        {isLabor
          ? <label key="minutes">投入分钟<input name="minutes" type="number" min="1" max="10080" step="1" required /></label>
          : <label key="amount">金额（{currency}）<input name="amount" inputMode="decimal" required /></label>}
        <label>关联事项（可选）<select name="reference"
          defaultValue={initialReference ? initialReference.kind + ':' + initialReference.id : ''}>
          <option value="">不关联</option>
          {Object.entries(refGroups).map(([kind, title]) => {
            const group = refs.filter(ref => ref.reference.kind === kind);
            return group.length ? <optgroup key={kind} label={title}>{group.map(ref =>
              <option key={ref.key} value={ref.key}>{ref.title}</option>
            )}</optgroup> : null;
          })}
        </select></label>
        <label className="ledger-note">说明<input name="note" maxLength={500} required
          placeholder={isLabor ? '如核对第三方回件并补件' : '如客户预付款、检测费或模型账单'} /></label>
        {!isLabor && <label className="ledger-checkbox"><input name="refund" type="checkbox" />按实际退款入账</label>}
        <button className="primary" type="submit">保存记录</button>
      </fieldset>
    </form>
  </section>;
}

function BaselineForm({ value, currency, busy, save, onError }: {
  value?: HistoricalBaseline; currency: Currency; busy: boolean; save: Save; onError: OnError;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const minutes = (key: string) => form.get(key) ? Number(form.get(key)) : undefined;
    try {
      void save({ action: 'baseline', baseline: {
        title: String(form.get('title') ?? ''),
        humanMinutes: minutes('human') ?? 0, setupMinutes: minutes('setup'),
        followUpMinutes: minutes('followUp'), reworkMinutes: minutes('rework'), externalWaitMinutes: minutes('external'),
        cashCostCents: centsFromInput(String(form.get('cash') ?? ''))
      } });
    } catch (error) { onError((error as Error).message); }
  }
  return <details className="ledger-baseline">
    <summary>{value ? '修改历史项目基线' : '录入历史项目基线'}</summary>
    <form onSubmit={submit} className="ledger-form">
      <fieldset disabled={busy} className="ledger-fields">
        <label>历史项目名称<input name="title" defaultValue={value?.title} maxLength={120} required /></label>
        <label>人工总分钟<input name="human" type="number" min="0" step="1" defaultValue={value?.humanMinutes} required /></label>
        <label>接入与建档分钟<input name="setup" type="number" min="0" step="1" defaultValue={value?.setupMinutes} /></label>
        <label>沟通与追件分钟<input name="followUp" type="number" min="0" step="1" defaultValue={value?.followUpMinutes} /></label>
        <label>变更与返工分钟<input name="rework" type="number" min="0" step="1" defaultValue={value?.reworkMinutes} /></label>
        <label>机构等待分钟<input name="external" type="number" min="0" step="1" defaultValue={value?.externalWaitMinutes} /></label>
        <label>现金净支出（{currency}）<input name="cash" inputMode="decimal" defaultValue={inputAmount(value?.cashCostCents)} /></label>
        <button className="primary">保存历史基线</button>
        {value && <button type="button" onClick={() => void save({ action: 'baseline', baseline: null })}>移除历史基线</button>}
      </fieldset>
    </form>
  </details>;
}

function Comparison({ view, projects, busy, save, onError }: {
  view: LedgerView; projects: RelatedProject[]; busy: boolean; save: Save; onError: OnError;
}) {
  const [compareId, setCompareId] = useState('');
  const [comparison, setComparison] = useState<{ id: string; view?: LedgerView; error?: string }>();
  useEffect(() => {
    if (!compareId) return;
    const abort = new AbortController();
    fetch(endpoint(compareId), { signal: abort.signal, cache: 'no-store' }).then(readLedger)
      .then(other => setComparison({ id: compareId, view: other }))
      .catch(error => { if (!abort.signal.aborted) setComparison({ id: compareId, error: error.message }); });
    return () => abort.abort();
  }, [compareId]);

  const { ledger, summary } = view;
  const currency = ledger.settings.currency;
  const selected = projects.find(project => project.id === compareId);
  const active = compareId && comparison?.id === compareId ? comparison : undefined;
  const otherCurrency = active?.view?.ledger.settings.currency ?? currency;
  const baseline = active?.view
    ? comparableMetrics(active.view.summary, active.view.ledger, active.view.waits)
    : !compareId ? ledger.baseline : undefined;
  const current = comparableMetrics(summary, ledger, view.waits);
  const diff = (currentValue?: number, previousValue?: number) =>
    currentValue === undefined || previousValue === undefined ? undefined : currentValue - previousValue;
  const rows: [string, number | undefined, number | undefined][] = [
    ['人工总投入', current.humanMinutes, baseline?.humanMinutes],
    ['接入与建档', current.setupMinutes, baseline?.setupMinutes],
    ['沟通与追件', current.followUpMinutes, baseline?.followUpMinutes],
    ['变更与返工', current.reworkMinutes, baseline?.reworkMinutes],
    ['机构累计等待', current.externalWaitMinutes, baseline?.externalWaitMinutes]
  ];

  return <section className="ledger-panel" aria-labelledby="ledger-comparison-title">
    <h2 id="ledger-comparison-title">对照项目</h2>
    <label>选择对照<select value={compareId} onChange={event => setCompareId(event.target.value)}>
      <option value="">{ledger.baseline?.title ?? '历史项目基线'}</option>
      {projects.map(project => <option key={project.id} value={project.id}>{project.title} · {project.package_version}</option>)}
    </select></label>
    {active?.error && <p role="alert" className="error-text">{active.error}</p>}
    {compareId && !active && <p className="muted">正在读取对照项目账务…</p>}
    {baseline && <div className="ledger-scroll"><table>
      <thead><tr><th>记录指标</th><th>本项目</th><th>{selected?.title ?? ledger.baseline?.title}</th><th>本项目减对照</th></tr></thead>
      <tbody>
        {rows.map(([label, value, before]) => <tr key={label}><th scope="row">{label}</th>
          <td>{timeText(value)}</td><td>{timeText(before)}</td><td>{timeText(diff(value, before))}</td>
        </tr>)}
        <tr><th scope="row">现金净支出</th><td>{cashText(current.cashCostCents, currency)}</td>
          <td>{cashText(baseline.cashCostCents, otherCurrency)}</td>
          <td>{currency !== otherCurrency ? '币种不同' : cashText(diff(current.cashCostCents, baseline.cashCostCents), currency)}</td>
        </tr>
      </tbody>
    </table></div>}
    <p className="muted">比较同类项目的相同交付阶段。空值代表该指标未登记，机构等待可能重叠。</p>
    <BaselineForm key={JSON.stringify(ledger.baseline) + currency} value={ledger.baseline}
      currency={currency} busy={busy} save={save} onError={onError} />
  </section>;
}

function EntryHistory({ entries, refs, currency, save, busy }: {
  entries: LedgerEntry[]; refs: RefOption[]; currency: Currency; save: Save; busy: boolean;
}) {
  const titles = new Map(refs.map(ref => [ref.key, ref.title]));
  return <section className="ledger-panel" aria-labelledby="ledger-history-title">
    <h2 id="ledger-history-title">账务明细</h2>
    {entries.length === 0 ? <p className="muted">新增一笔收支或实际工时，就会显示在这里。</p> :
      <div className="ledger-scroll"><table>
        <thead><tr><th>日期</th><th>账目</th><th>金额或投入</th><th>说明</th><th>操作</th></tr></thead>
        <tbody>{entries.slice().reverse().map(entry => <tr key={entry.id} className={entry.voided ? 'ledger-voided' : ''}>
          <td>{entry.date}</td>
          <td>{entry.type === 'cash' ? cashKindLabels[entry.kind] + (entry.refund ? '退款' : '') : laborKindLabels[entry.kind]}</td>
          <td>{entry.type === 'cash' ? cashText(entry.cents, currency) : timeText(entry.minutes)}
            {entry.type === 'labor' && <small>{entry.hourlyRateCents === undefined ? '未设时薪'
              : cashText(entry.hourlyRateCents, currency) + ' / 小时'}</small>}</td>
          <td>{entry.note}{entry.reference && <small>{refGroups[entry.reference.kind]} · {
            titles.get(entry.reference.kind + ':' + entry.reference.id) ?? entry.reference.id
          }</small>}</td>
          <td>{entry.voided ? <span>已作废<small>{entry.voided.reason}</small></span> :
            <details><summary>作废记录</summary>
              <form className="ledger-void" onSubmit={event => {
                event.preventDefault();
                const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
                void save({ action: 'void', entryId: entry.id, reason });
              }}>
                <label>作废原因<input name="reason" required maxLength={240} /></label>
                <button type="submit" disabled={busy}>确认作废</button>
              </form>
            </details>}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

export function ProjectLedgerView({ project, projects, initialReference, onBack }: {
  project: ProjectState; projects: RelatedProject[]; initialReference?: LedgerReference; onBack: () => void;
}) {
  const [view, setView] = useState<LedgerView>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refs = useMemo(() => referenceOptions(project), [project]);
  const url = endpoint(project.id);
  useEffect(() => {
    const abort = new AbortController();
    fetch(url, { signal: abort.signal, cache: 'no-store' }).then(readLedger).then(setView)
      .catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [url]);

  async function reload() {
    setError('');
    setNotice('');
    setBusy(true);
    try { setView(await readLedger(await fetch(url, { cache: 'no-store' }))); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function save(payload: CommandPayload) {
    if (!view || busy) return false;
    setError('');
    setNotice('');
    const parsed = projectLedgerCommandSchema.safeParse({ ...payload, revision: view.ledger.revision });
    if (!parsed.success) {
      setError(parsed.error.issues.find(issue => issue.code === 'custom')?.message ?? '请检查日期、金额和投入时间。');
      return false;
    }
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data)
      });
      setView(await readLedger(response));
      setNotice(payload.action === 'void' ? '已作废，历史说明已保留。' : '项目账务已保存。');
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    } finally { setBusy(false); }
  }

  const summary = view?.summary;
  const ledger = view?.ledger;
  const currency = ledger?.settings.currency ?? 'CNY';
  const metrics = summary && ledger ? [
    { label: '客户净回款', value: cashText(summary.cash.client, currency), detail: '合同额 ' + cashText(ledger.settings.contractCents, currency) },
    { label: '合同未收', value: cashText(summary.openReceivableCents, currency), detail: '按合同额与净回款计算' },
    { label: '现金结余', value: cashText(summary.cashBalanceCents, currency), detail: '现金净支出 ' + cashText(summary.cashCostCents, currency) },
    { label: '已记成本', value: cashText(summary.knownCostCents, currency),
      detail: summary.unpricedMinutes ? timeText(summary.unpricedMinutes) + '人工未估值'
        : '合同额减已记成本 ' + cashText(summary.recordedContributionCents, currency) }
  ] : [];
  return <section className="ledger-page" aria-label="项目账务">
    <header className="ledger-title">
      <div><span className="eyebrow">{project.title}</span><h1>项目账务</h1></div>
      <div><button type="button" onClick={() => void reload()} disabled={busy}>刷新账务</button> <button type="button" onClick={onBack}>返回项目</button></div>
    </header>
    {error && <p role="alert" className="alert error">{error}</p>}
    {notice && <p role="status" className="alert info">{notice}</p>}
    {view && ledger && summary ? <>
      <div className="ledger-metrics">{metrics.map(metric => <section key={metric.label} aria-label={metric.label}>
        <h2>{metric.label}</h2><strong>{metric.value}</strong><small>{metric.detail}</small>
      </section>)}</div>
      <LedgerSettings key={JSON.stringify(ledger.settings)} value={ledger.settings}
        locked={ledger.entries.length > 0 || ledger.baseline?.cashCostCents !== undefined}
        busy={busy} save={save} onError={setError} />
      <EntryForm project={project} refs={refs} currency={currency} initialReference={initialReference} busy={busy} save={save} onError={setError} />
      <section className="ledger-panel" aria-labelledby="ledger-cost-title">
        <h2 id="ledger-cost-title">项目投入明细</h2>
        <dl className="ledger-breakdown">
          <div><dt>人工总投入</dt><dd>{timeText(summary.humanMinutes)}</dd></div>
          <div><dt>已估值人工</dt><dd>{cashText(summary.laborCents, currency)}</dd></div>
          {(['vendor', 'model', 'other'] as const).map(kind =>
            <div key={kind}><dt>{cashKindLabels[kind]}</dt><dd>{cashText(summary.cash[kind], currency)}</dd></div>
          )}
          <div><dt>机构累计等待</dt><dd>{timeText(summary.externalWaitMinutes)}</dd></div>
        </dl>
        {view.waits.length > 0 && <details>
          <summary>查看外部回件等待</summary>
          <ul className="ledger-waits">{view.waits.map(wait => <li key={wait.stepId}>
            <span>{wait.title}</span><span>累计 {timeText(wait.closedMinutes + wait.openMinutes)}{
              wait.openSince ? ' · 等待中' : ''
            }</span>
          </li>)}</ul>
        </details>}
        <p className="muted">人工投入来自已登记工时。外部等待从机构事项进入等待环节起算，可重叠，单独显示。</p>
      </section>
      <Comparison view={view} projects={projects.filter(item => item.id !== project.id && item.package_id === project.templateId)}
        busy={busy} save={save} onError={setError} />
      <EntryHistory entries={ledger.entries} refs={refs} currency={currency} save={save} busy={busy} />
    </> : !error && <p className="muted">正在加载项目账务…</p>}
  </section>;
}
