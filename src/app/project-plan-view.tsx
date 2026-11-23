'use client';

import { useMemo, useState } from 'react';
import { calculateProjectPlan, defaultPlan, type ScheduledWork } from '@/core/project-plan';
import { civilDate, dateMinute, dayMinutes } from '@/core/planning-calendar';
import type { ProjectState } from '@/core/runtime';
import { planSettingsSchema, type ProjectPlanning, type Pool } from '@/protocol/planning';
import { deriveWorkbenchQueues } from './workbench-queue';

const names: Record<Pool, string> = { human: '人力', agent: 'Agent', external: '外部机构' };
const statuses: Record<ScheduledWork['status'], string> = {
  waiting: '等前置', ready: '可处理', running: '执行中', failed: '待重试', done: '实际完成'
};

const workToday = (row: ScheduledWork, at: number) => {
  const midnight = Math.floor(at / dayMinutes) * dayMinutes;
  return row.segments.reduce((total, part) =>
    total + Math.max(0, Math.min(part.finish, midnight + dayMinutes) - Math.max(part.start, midnight)), 0);
};
const hours = (minutes: number) => (minutes / 60).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 小时';
function timestamp(minute: number) {
  return new Date(minute * 60000).toISOString().slice(0, 16).replace('T', ' ');
}

export function PlanAttention({ project, onOpen }: { project: ProjectState; onOpen: (key: string) => void }) {
  const settings = project.planning?.settings;
  if (!settings) return null;
  const plan = calculateProjectPlan(project, settings, new Date());
  const queues = deriveWorkbenchQueues(project);
  const actionable = new Set([...queues.human, ...queues.agent].map(item => item.key));
  const attention = plan.attention.filter(row => actionable.has(row.todoKey));
  if (!attention.length && !plan.behindTarget) return null;
  const humanToday = attention.filter(row => row.pool === 'human')
    .reduce((total, row) => total + workToday(row, plan.now), 0);
  return <section className="plan-attention" aria-label="项目时间提醒">
    <div>
      <h2>{plan.behindTarget ? '预计超出项目目标日' : '现在需要安排的工作'}</h2>
      {plan.behindTarget && plan.finish !== null &&
        <p>目标 {settings.due} · 预计 {civilDate(plan.finish)}</p>}
      {humanToday > 0 && <p>今天可行动事项已排 {hours(humanToday)} 人力</p>}
    </div>
    {attention.slice(0, 4).map(row => {
      const today = row.pool === 'human' ? workToday(row, plan.now) : 0;
      return <button key={row.key} onClick={() => onOpen(row.todoKey)}>
        <strong>{row.title}</strong>
        <span>{row.overdue ? '逾期 · ' : row.missesTaskDue ? '预计超期 · ' : row.critical ? '影响完工 · ' : ''}
          {row.pool === 'external' ? '确认机构进展' : row.status === 'failed' ? '处理重试'
            : today > 0 ? '今日排 ' + hours(today) + ' · 预计共 ' + hours(row.minutes)
            : '预计 ' + hours(row.minutes)}</span>
        {row.taskDue ? <span>截止 {row.taskDue}</span> : row.overdue && project.planning?.baseline?.tasks[row.key] &&
          <span>基准完成时间 {timestamp(project.planning.baseline.tasks[row.key].finish)}</span>}
      </button>;
    })}
    {attention.length > 4 && <small>其余 {attention.length - 4} 项见项目计划。</small>}
  </section>;
}

type Props = {
  project: ProjectState;
  onBack: () => void;
  onOpen: (key: string) => void;
  onSaved: (projectId: string, planning: ProjectPlanning) => void;
};

export function ProjectPlanView({ project, onBack, onOpen, onSaved }: Props) {
  const defaults = useMemo(() => defaultPlan(project, Intl.DateTimeFormat().resolvedOptions().timeZone), [project.id]);
  const saved = project.planning?.settings ?? defaults;
  const [draft, setDraft] = useState(saved);
  const [revision, setRevision] = useState(project.planning?.revision ?? 0);
  const [selectedKey, select] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const parsed = planSettingsSchema.safeParse(draft);
  const currentTime = new Date();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const comparison = calculateProjectPlan(project, saved, currentTime);
  const plan = dirty && parsed.success ? calculateProjectPlan(project, parsed.data, currentTime) : comparison;
  const baseline = project.planning?.baseline?.timeZone === (parsed.success ? draft.timeZone : saved.timeZone)
    ? project.planning?.baseline : undefined;
  const selected = plan.rows.find(row => row.key === selectedKey);
  const queues = deriveWorkbenchQueues(project);
  const canOpenSelected = selected && [...queues.human, ...queues.agent, ...queues.external].some(item => item.key === selected.todoKey);
  const stale = revision !== (project.planning?.revision ?? 0);
  const comparable = draft.timeZone === saved.timeZone;
  const delta = comparable && comparison.finish !== null && plan.finish !== null ? plan.finish - comparison.finish : null;
  const previousSlot = comparable && selected ? comparison.rows.find(row => row.key === selected.key) : undefined;
  const displaced = dirty && comparable ? plan.rows.filter(row =>
    comparison.rows.some(previous => previous.key === row.key && previous.finish < row.finish)).length : 0;

  async function save(freeze: boolean) {
    if (!parsed.success || pending || stale) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/projects/' + encodeURIComponent(project.id) + '/plan', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, settings: parsed.data, freeze })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '保存失败');
      const planning = body.planning as ProjectPlanning;
      setRevision(planning.revision);
      setDraft(planning.settings);
      onSaved(project.id, planning);
      setNotice(freeze ? '已锁定计划基准。' : '已保存项目计划与优先级。');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setPending(false);
    }
  }

  return <section className="plan-page" aria-label="项目计划">
    <header className="plan-title">
      <div><button type="button" onClick={onBack}>← 返回双 Todo</button><h1>{project.title}</h1></div>
      <div className="plan-save">
        <button type="button" onClick={() => void save(true)}
          disabled={pending || stale || !parsed.success || plan.unresolvedDecisions.length > 0}>
          {baseline ? '更新基准' : '锁定基准'}
        </button>
        <button type="button" className="primary" onClick={() => void save(false)}
          disabled={pending || stale || !parsed.success || (!dirty && Boolean(project.planning))}>保存计划</button>
      </div>
    </header>
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <p className="inspector-success" role="status">{notice}</p>}
    {stale && <p className="error-text">计划已在另一处更新。 <button type="button" onClick={() => {
      setDraft(saved);
      setRevision(project.planning?.revision ?? 0);
      setError('');
    }}>载入已保存计划</button></p>}
    <div className="plan-metrics">
      <div><span>{plan.unresolvedDecisions.length ? '已明确范围预计完成' : '预计完工'}</span>
        <strong>{plan.finish === null ? '—' : timestamp(plan.finish)}</strong>
        <small>{(parsed.success ? draft : saved).timeZone}{baseline?.finish != null ? ' · 基准 ' + timestamp(baseline.finish) : ''}</small></div>
      <div><span>交付目标</span><strong className={plan.behindTarget ? 'error-text' : ''}>{(parsed.success ? draft : saved).due || '未设目标日'}</strong>
        {plan.behindTarget && <small>当前排程预计逾期</small>}
        {dirty && delta !== null && <small>{delta === 0 ? '调整后完工时间相同'
          : '调整后' + (delta < 0 ? '提前 ' : '推迟 ') + hours(Math.abs(delta))}</small>}
        {displaced > 0 && <small>{displaced} 项任务的完工时间推后</small>}</div>
      <div><span>剩余工作量</span><strong>{hours(plan.remainingMinutes.human)} 人力</strong>
        <small>Agent {hours(plan.remainingMinutes.agent)} · 外部机构 {hours(plan.remainingMinutes.external)}</small></div>
    </div>
    <div className="plan-settings">
      <details open={!project.planning || undefined}>
        <summary>工作日与资源容量</summary>
        <div className="plan-settings-grid">
          <label>计划开始<input type="date" value={draft.start}
            onChange={e => setDraft({ ...draft, start: e.target.value })} /></label>
          <label>交付目标日<input type="date" value={draft.due ?? ''}
            onChange={e => setDraft({ ...draft, due: e.target.value || undefined })} /></label>
          <label>项目时区<input value={draft.timeZone}
            onChange={e => setDraft({ ...draft, timeZone: e.target.value })} /></label>
          <label>可并行人数<input type="number" min={1} max={8} step={1} value={draft.humanLanes || ''}
            onChange={e => setDraft({ ...draft, humanLanes: Number(e.target.value) })} /></label>
          <label>每人每天可投入小时<input type="number" min={0.5} max={12} step={0.5} value={draft.humanMinutes / 60 || ''}
            onChange={e => setDraft({ ...draft, humanMinutes: Number(e.target.value) * 60 })} /></label>
          <label>Agent 每通道每日小时<input type="number" min={0.5} max={12} step={0.5} value={draft.agentMinutes / 60 || ''}
            onChange={e => setDraft({ ...draft, agentMinutes: Number(e.target.value) * 60 })} /></label>
          <label>机构并行通道<input type="number" min={1} max={8} step={1} value={draft.externalLanes || ''}
            onChange={e => setDraft({ ...draft, externalLanes: Number(e.target.value) })} /></label>
          <label>机构每通道每日小时<input type="number" min={0.5} max={12} step={0.5} value={draft.externalMinutes / 60 || ''}
            onChange={e => setDraft({ ...draft, externalMinutes: Number(e.target.value) * 60 })} /></label>
        </div>
        <label className="plan-checkbox"><input type="checkbox" checked={draft.restrictAgentStarts ?? false}
          onChange={e => setDraft({ ...draft, restrictAgentStarts: e.target.checked })} />
          按工时窗口限制 Agent 自动启动</label>
        <p className="muted">估算使用周一至周五，从 09:00 起分配工时。Agent 计划按项目并发 {project.execution?.maxParallel ?? 2}，
          实际派发受工作台策略及全局并发限制。</p>
        {project.execution?.autoDispatch === false && <p className="muted">Agent 自动派发已暂停，预测按后续恢复估算。</p>}
        {!parsed.success && <p className="error-text">
          请填写有效日期、时区及并行数。每日容量按半小时填写，任务工时按 15 分钟填写。目标日应等于或晚于开始日。
        </p>}
      </details>
      {!!project.package.steps.some(step => step.kind === 'human_decision' && !project.decisions[step.id]) &&
        <details open={plan.unresolvedDecisions.length > 0 || undefined}>
          <summary>尚未决定的路线</summary>
          <div className="plan-settings-grid">
            {project.package.steps.filter(step => step.kind === 'human_decision' && !project.decisions[step.id]).map(step =>
              <label key={step.id}>{step.title}<select value={draft.assumptions[step.id] ?? ''} onChange={e => {
                const assumptions = { ...draft.assumptions };
                if (e.target.value) assumptions[step.id] = e.target.value;
                else delete assumptions[step.id];
                setDraft({ ...draft, assumptions });
              }}>
                <option value="">待定</option>
                {step.options?.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
              </select></label>)}
          </div>
          <p className="muted">路线假设只用于排程。实际任务仍由双 Todo 中的人工决定触发。</p>
        </details>}
    </div>
    {!plan.rows.length && <p>当前路线暂无可排任务。</p>}
    {plan.rows.length > 0 && <Gantt rows={plan.rows} now={plan.now} deadline={plan.deadline}
      baseline={baseline} selectedKey={selectedKey} onSelect={select} />}
    {selected && <section className="plan-task" aria-label="排程任务详情">
      <div><h2>{selected.title}</h2>
        <p>{names[selected.pool]} · {statuses[selected.status]} · {timestamp(selected.start)} 至 {timestamp(selected.finish)}</p>
        {dirty && previousSlot && previousSlot.finish !== selected.finish &&
          <p className="muted">调整前预计完成 {timestamp(previousSlot.finish)}</p>}
        {selected.dependencies.length > 0 && <p className="muted">
          前置 {selected.dependencies.map(key => plan.rows.find(row => row.key === key)?.title ?? key).join('、')}
        </p>}
      </div>
      <div className="plan-task-controls">
        {selected.status !== 'done' && <label>估计工时（小时）
          <input type="number" min={0.25} max={400} step={0.25}
            value={(draft.estimates[selected.key] ?? selected.minutes) / 60 || ''}
            onChange={e => setDraft({ ...draft, estimates: { ...draft.estimates, [selected.key]: Number(e.target.value) * 60 } })} />
        </label>}
        {selected.status !== 'done' && <label>任务截止日
          <input type="date" value={draft.taskDueDates?.[selected.key] ?? ''} onChange={e => {
            const taskDueDates = { ...draft.taskDueDates };
            if (e.target.value) taskDueDates[selected.key] = e.target.value;
            else delete taskDueDates[selected.key];
            setDraft({ ...draft, taskDueDates });
          }} />
        </label>}
        {selected.status !== 'done' && <button type="button" onClick={() => setDraft({
          ...draft, expedited: draft.expedited.includes(selected.key)
            ? draft.expedited.filter(key => key !== selected.key) : [...draft.expedited, selected.key]
        })}>{draft.expedited.includes(selected.key) ? '取消优先' : '设为优先'}</button>}
        {canOpenSelected && <button type="button" onClick={() => onOpen(selected.todoKey)}>去处理 Todo</button>}
      </div>
    </section>}
  </section>;
}

function Gantt({ rows, now, deadline, baseline, selectedKey, onSelect }: {
  rows: ScheduledWork[]; now: number; deadline?: number; baseline?: ProjectPlanning['baseline'];
  selectedKey: string; onSelect: (key: string) => void;
}) {
  const reference = rows.flatMap(row => baseline?.tasks[row.key] ? [baseline.tasks[row.key]] : []);
  const start = Math.floor(Math.min(now, ...rows.map(r => r.start), ...reference.map(r => r.start)) / dayMinutes) * dayMinutes;
  const finish = Math.max(now, ...(deadline === undefined ? [] : [deadline]),
    ...rows.map(r => r.finish), ...reference.map(r => r.finish));
  const days = Math.max(2, Math.ceil((finish - start) / dayMinutes));
  const stride = Math.max(1, Math.ceil(days / 30));
  const width = Math.ceil(days / stride) * 68;
  const position = (minute: number) => (minute - start) / (days * dayMinutes) * 100;
  const plotStyle = { width, backgroundSize: `${stride / days * 100}% 100%` };
  const ticks = Array.from({ length: Math.ceil(days / stride) }, (_, i) => start + i * stride * dayMinutes);
  return <section className="plan-gantt" aria-label="项目甘特图">
    <header><h2>甘特图</h2><p><span className="plan-legend human">人力</span><span className="plan-legend agent">Agent</span>
      <span className="plan-legend external">外部机构</span>{baseline && <span className="plan-legend baseline">基准</span>}
      <span className="plan-legend current">当前</span>{deadline !== undefined && <span className="plan-legend target">交付日</span>}</p></header>
    <div className="plan-scroll" tabIndex={0} aria-label="按日期滚动查看任务">
      <div className="gantt-row gantt-times">
        <div className="gantt-label">任务</div>
        <div className="gantt-plot" style={plotStyle}>
          {ticks.map(at => <time key={at} style={{ left: position(at) + '%' }}>{civilDate(at).slice(5)}</time>)}
        </div>
      </div>
      {rows.map(row => {
        const planned = baseline?.tasks[row.key];
        const title = `${row.title} · ${timestamp(row.start)} 至 ${timestamp(row.finish)}` +
          (row.promisedOn ? ' · 对方承诺回件 ' + row.promisedOn : '');
        const blocks = stride === 1 ? row.segments :
          [{ start: row.start, finish: row.segments.at(-1)?.finish ?? row.finish }];
        const promise = row.promisedOn ? dateMinute(row.promisedOn) + dayMinutes - 1 : undefined;
        return <div key={row.key} className={'gantt-row' + (selectedKey === row.key ? ' selected' : '')}>
          <button className="gantt-label" type="button" onClick={() => onSelect(row.key)} aria-pressed={selectedKey === row.key} title={title}>
            <strong>{row.title}</strong><small>{row.overdue ? '逾期' : row.missesTaskDue ? '预计超期' : row.delayed ? '晚于基准' : row.critical ? '制约工期' : statuses[row.status]}
              {row.promisedOn && ' · 承诺回件 ' + row.promisedOn}</small>
          </button>
          <div className="gantt-plot" style={plotStyle}
            onClick={() => onSelect(row.key)} title={title}>
            {planned && <span className="gantt-baseline" style={{ left: position(planned.start) + '%',
              width: Math.max(position(planned.finish) - position(planned.start), 0) + '%' }} />}
            {blocks.map(block => <span key={block.start} className={`gantt-bar ${row.pool} ${row.status}`} style={{
              left: position(block.start) + '%', width: Math.max(position(block.finish) - position(block.start), 0) + '%'
            }} />)}
            {promise !== undefined && promise >= start &&
              <span className="gantt-promise" style={{ left: position(promise) + '%' }} />}
            <span className="gantt-today" style={{ left: position(now) + '%' }} />
            {deadline !== undefined && deadline >= start &&
              <span className="gantt-due" style={{ left: position(deadline) + '%' }} />}
          </div>
        </div>;
      })}
    </div>
  </section>;
}
