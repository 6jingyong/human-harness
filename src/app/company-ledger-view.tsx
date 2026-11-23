'use client';

import { useEffect, useState } from 'react';
import type { CompanyLedgerView as CompanyView } from '@/core/store';
import { cashText } from './project-ledger-view';

export function CompanyLedgerView({ onBack, onOpen }: {
  onBack: () => void; onOpen: (id: string) => void;
}) {
  const [view, setView] = useState<CompanyView>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/ledger', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '无法读取公司账务。');
      setView(payload);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);
  return <section className="ledger-page" aria-label="公司账务">
    <header className="ledger-title">
      <div><h1>公司账务</h1><p>按项目记录收支，按币种查看汇总。</p></div>
      <button type="button" onClick={onBack}>返回工作台</button>
    </header>
    {error && <p role="alert" className="alert error">{error}</p>}
    {view ? <>
      {view.totals.map(group => <section className="ledger-panel" key={group.currency} aria-label={group.currency + ' 汇总'}>
        <h2>{group.currency} 汇总</h2>
        <dl className="ledger-breakdown">
          <div><dt>客户净回款</dt><dd>{cashText(group.clients, group.currency)}</dd></div>
          <div><dt>现金净支出</dt><dd>{cashText(group.paid, group.currency)}</dd></div>
          <div><dt>现金结余</dt><dd>{cashText(group.balance, group.currency)}</dd></div>
          <div><dt>已知合同未收</dt><dd>{cashText(group.receivable, group.currency)}</dd></div>
        </dl>
        {group.missingContract > 0 && <p className="muted">{group.missingContract} 个项目尚未登记合同额。</p>}
      </section>)}
      <section className="ledger-panel" aria-labelledby="ledger-projects-title">
        <h2 id="ledger-projects-title">项目账簿</h2>
        {view.projects.length ? <div className="ledger-scroll"><table>
          <thead><tr><th>项目</th><th>现金结余</th><th>合同未收</th><th>已记成本</th></tr></thead>
          <tbody>{view.projects.map(({ id, title, currency, summary }) => <tr key={id}>
            <th scope="row"><button type="button" onClick={() => onOpen(id)}>{title}</button></th>
            <td>{summary && currency ? cashText(summary.cashBalanceCents, currency) : '待建账'}</td>
            <td>{summary && currency ? cashText(summary.openReceivableCents, currency) : '—'}</td>
            <td>{summary && currency ? cashText(summary.knownCostCents, currency) : '—'}
              {!!summary?.unpricedMinutes && <small>部分人工未估值</small>}</td>
          </tr>)}</tbody>
        </table></div> : <p className="muted">建立项目后，就可以登记项目账务。</p>}
      </section>
    </> : !error && <p className="muted">正在加载公司账务…</p>}
  </section>;
}
