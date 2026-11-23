'use client';

import { useState } from 'react';
import type { ProjectState } from '@/core/runtime';
import { coordinationOverview } from '@/core/project-coordination';
import { coordinationSettingsSchema, type CoordinationSettings } from '@/protocol/coordination';

type Requirements = CoordinationSettings['requirements'];
type Orders = NonNullable<ProjectState['package']['workOrders']>;

export function ProjectRequirements({ project, onSaved }: {
  project: ProjectState;
  onSaved: (project: ProjectState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [requirements, setRequirements] = useState(project.coordination?.requirements ?? {});
  const [revision, setRevision] = useState(project.coordination?.revision ?? 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const orders = project.package.workOrders ?? [];
  if (!orders.length) return null;

  const timeZone = project.coordination?.timeZone ?? project.planning?.settings.timeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { orderStatus } = coordinationOverview(project, new Date());
  const canSave = coordinationSettingsSchema.safeParse({ timeZone, requirements }).success;

  function open() {
    if (!expanded) {
      setRequirements(project.coordination?.requirements ?? {});
      setRevision(project.coordination?.revision ?? 0);
      setError('');
    }
    setExpanded(!expanded);
  }

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/projects/' + encodeURIComponent(project.id) + '/requirements', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, settings: { timeZone, requirements } })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法保存项目要求');
      onSaved(data.project);
      setExpanded(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="project-requirements" aria-label="项目要求">
    <header>
      <div><h2>项目要求</h2>
        <p>{orderStatus.size ? '外协和对外办理事项已纳入 Todo'
          : '选择需要交付的外协或对外办理事项。'}</p>
      </div>
      <button type="button" onClick={open} aria-expanded={expanded}>{expanded ? '收起' : '设置项目要求'}</button>
    </header>
    {orders.filter(order => orderStatus.has(order.id)).map(order => {
      const status = orderStatus.get(order.id)!;
      return <div className="project-requirement-summary" key={order.id}>
        <strong>{order.title}</strong>
        <span>验收截止 {project.coordination?.requirements[order.id].due}</span>
        <span className={status.atRisk ? 'order-urgent' : 'order-time'}>{status.done ? '已验收' : status.atRisk ? '交付有风险' : '待验收'}</span>
      </div>;
    })}
    {expanded && <div className="project-requirements-editor">
      <WorkOrderFields orders={orders} requirements={requirements} onChange={setRequirements} />
      {error && <p role="alert" className="error-text">{error}</p>}
      <button className="primary" type="button" disabled={!canSave || busy} onClick={() => void save()}>
        保存并更新 Todo
      </button>
      <small className="muted">项目时区 {timeZone}</small>
    </div>}
  </section>;
}

export function WorkOrderFields({ orders, requirements, onChange }: {
  orders: Orders; requirements: Requirements; onChange: (requirements: Requirements) => void;
}) {
  return orders.map(order => {
    const active = Object.hasOwn(requirements, order.id);
    return <fieldset key={order.id}>
      <legend>{order.title}</legend>
      <p>{order.description}</p>
      <label className="requirement-toggle"><input type="checkbox" checked={active} onChange={event => {
        const next = { ...requirements };
        if (event.target.checked) next[order.id] = { due: '', brief: '' };
        else delete next[order.id];
        onChange(next);
      }} /> 本项目需要{order.title}</label>
      {active && <div className="requirement-inputs">
        <label>{order.title}验收截止日<input type="date" required value={requirements[order.id].due}
          onChange={e => onChange({ ...requirements, [order.id]: { ...requirements[order.id], due: e.target.value } })} /></label>
        <label>办理范围或交付要求<textarea rows={2} maxLength={800} value={requirements[order.id].brief}
          onChange={e => onChange({ ...requirements, [order.id]: { ...requirements[order.id], brief: e.target.value } })} /></label>
      </div>}
    </fieldset>;
  });
}
