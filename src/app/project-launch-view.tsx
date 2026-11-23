'use client';

import { useEffect, useState } from 'react';
import type { HumanHarnessPackage } from '@/protocol/v1';
import type { ProjectState } from '@/core/runtime';
import { formatLatestStart } from '@/core/project-coordination';
import { defaultPlan } from '@/core/project-plan';
import { projectLaunchSchema, type LaunchPreview, type ProjectSetup } from '@/protocol/project-launch';
import { WorkOrderFields } from './project-requirements';

type Props = {
  template: HumanHarnessPackage;
  title: string;
  onCancel: () => void;
  onCreated: (project: ProjectState) => void;
};

function initialSetup(): ProjectSetup {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { planning: defaultPlan({ createdAt: new Date().toISOString() }, timeZone), requirements: {} };
}

export function ProjectLaunchView({ template, title, onCancel, onCreated }: Props) {
  const [setup, setSetup] = useState(initialSetup);
  const [result, setResult] = useState<{ input: string; preview?: LaunchPreview; error?: string }>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const validation = projectLaunchSchema.safeParse({
    packageId: template.id, packageVersion: template.version, title, setup
  });
  const input = validation.success ? JSON.stringify(validation.data) : '';
  const current = result?.input === input ? result : undefined;
  const preview = current?.preview;
  const fields = setup.planning;
  const choices = template.steps.filter(step => step.kind === 'human_decision');
  const orders = template.workOrders ?? [];

  useEffect(() => {
    if (!input) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/v1/projects/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input, signal: controller.signal
        });
        const payload = await response.json();
        if (controller.signal.aborted) return;
        setResult(response.ok ? { input, preview: payload.preview } :
          { input, error: payload.error || '无法预览项目' });
      } catch {
        if (!controller.signal.aborted) setResult({ input, error: '无法加载项目预览。' });
      }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [input]);

  function update(planning: Partial<ProjectSetup['planning']>) {
    setSetup(previous => ({ ...previous, planning: { ...previous.planning, ...planning } }));
    setError('');
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (!input || creating) return;
    setError('');
    setCreating(true);
    try {
      const response = await fetch('/api/v1/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '无法创建项目');
      onCreated(payload.project);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setCreating(false);
    }
  }

  return <form className="project-launch" aria-label="项目启动设置" onSubmit={start}>
    <header className="launch-heading">
      <div><h1>{title.trim()}</h1><p>{template.title} · {template.version}</p></div>
      <button type="button" onClick={onCancel} disabled={creating}>返回模板选择</button>
    </header>
    <div className="launch-layout">
      <section className="launch-settings">
        <h2>时间与人力</h2>
        <div className="launch-fields">
          <label>计划开始日<input type="date" required value={fields.start}
            onChange={e => update({ start: e.target.value })} /></label>
          <label>项目交付日<input type="date" value={fields.due ?? ''}
            onChange={e => update({ due: e.target.value || undefined })} /></label>
          <label>本人及可并行人数<input type="number" required min={1} max={8} value={fields.humanLanes || ''}
            onChange={e => update({ humanLanes: Number(e.target.value) })} /></label>
          <label>每人每天可投入小时<input type="number" required min={0.5} max={12} step={0.5}
            value={fields.humanMinutes / 60 || ''} onChange={e => update({ humanMinutes: Number(e.target.value) * 60 })} /></label>
          <label>项目时区<input required value={fields.timeZone} onChange={e => update({ timeZone: e.target.value })} /></label>
        </div>
        <p className="muted">默认按周一至周五安排工时。</p>
        <label className="requirement-toggle"><input type="checkbox" checked={fields.restrictAgentStarts ?? false}
          onChange={e => update({ restrictAgentStarts: e.target.checked })} /> 按计划工时限制 Agent 自动启动</label>
        {orders.length > 0 && <div className="project-requirements-editor">
          <h2>本项目需要的对外工作</h2>
          <WorkOrderFields orders={orders} requirements={setup.requirements}
            onChange={requirements => setSetup(previous => ({ ...previous, requirements }))} />
        </div>}
        {choices.length > 0 && <details className="launch-routes">
          <summary>按假设路线估算</summary>
          {choices.map(step => <label key={step.id}>{step.title}<select value={fields.assumptions[step.id] ?? ''}
            onChange={e => {
              const assumptions = { ...fields.assumptions };
              if (e.target.value) assumptions[step.id] = e.target.value;
              else delete assumptions[step.id];
              update({ assumptions });
            }}>
            <option value="">待正式决定</option>
            {step.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label>)}
          <p className="muted">路线假设只用于估时。对应后续任务由正式决定启动。</p>
        </details>}
      </section>
      <section className="launch-preview" aria-label="启动预览" aria-busy={Boolean(input && !current)}>
        <h2>启动后先做什么</h2>
        {preview ? <>
          {preview.humanTodos.length ? <ul className="launch-todos">
            {preview.humanTodos.map(todo => <li key={todo.key}>
              <span>{todo.kind === 'material' ? '提供素材 · ' : ''}{todo.title}</span>
              {todo.latestStart !== undefined && <small className={todo.lateToStart ? 'order-urgent' : 'order-time'}>
                最晚开始 {formatLatestStart(todo.latestStart)}
              </small>}
            </li>)}
          </ul> : <p>当前没有需先处理的 Human Todo。</p>}
          {preview.readyAgent > 0 && <p>{preview.readyAgent} 项 Agent 任务符合启动条件。</p>}
          <h2>模板交付</h2>
          {preview.deliverables.length ? <div className="launch-deliverables">{preview.deliverables.map(output =>
            <details key={output.id}>
              <summary>{output.title} <small>{output.format.toUpperCase()}{output.word ? ' / DOCX' : ''}</small></summary>
              <ul>{template.outputs.find(contract => contract.id === output.id)?.acceptance.map((rule, index) =>
                <li key={index}>{rule}</li>)}</ul>
            </details>)}</div>
            : <p>交付项随任务完成并复核。</p>}
          {preview.finish !== null &&
            <p className={preview.behindTarget ? 'order-urgent' : 'muted'}>
              {preview.partial ? '已明确范围预计完成' : '按当前设置预计完成'} {formatLatestStart(preview.finish)}
              {preview.behindTarget ? '，预计超过交付日。' : '。'}
            </p>}
          {preview.atRisk.length > 0 && <p className="order-urgent">当前容量下可能无法及时验收 · {preview.atRisk.join('、')}</p>}
        </> : <p className={current?.error ? 'error-text' : 'muted'}>
          {current?.error ?? (input ? '正在按模板计算首批任务…' : '填写有效的日期和可用工时后可预览。')}
        </p>}
        <details className="launch-stages">
          <summary>模板如何处理素材</summary>
          <ol>{template.stages.map(stage => <li key={stage.id}><b>{stage.title}</b><p>{stage.description}</p></li>)}</ol>
        </details>
      </section>
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    <footer><button type="submit" className="primary" disabled={!input || creating}>
      {creating ? '正在启动…' : '确认并启动项目'}
    </button></footer>
  </form>;
}
