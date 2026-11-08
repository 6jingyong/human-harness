'use client';

import { useEffect, useState } from 'react';
import type { Project, Task } from '@/lib/domain';
import { blockingDependencies, canStart } from '@/lib/domain';

type TemplateSummary = { id: string; title: string; description: string; version: number };
type ProjectSummary = { id: string; title: string; templateId: string; createdAt: string };

const statusLabels: Record<string, string> = {
  pending: '待执行', running: '执行中', review: '待审核',
  completed: '已完成', failed: '执行失败', skipped: '已跳过'
};

async function parseResponse(response: Response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

export function Workspace() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [templateId, setTemplateId] = useState('general-project');
  const [newName, setNewName] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [executorMode, setExecutorMode] = useState('demo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function reloadIndex() {
    const data = await parseResponse(await fetch('/api/projects', { cache: 'no-store' }));
    setTemplates(data.templates);
    setProjects(data.projects);
    setExecutorMode(data.executorMode);
  }

  async function openProject(id: string) {
    setError('');
    const data = await parseResponse(await fetch('/api/projects/' + encodeURIComponent(id), { cache: 'no-store' }));
    setProject(data.project);
  }

  useEffect(() => {
    reloadIndex().catch(e => setError(e.message));
  }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy(true); setError(''); setInfo('');
    try {
      const data = await parseResponse(await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newName, templateId })
      }));
      setProject(data.project); setNewName('');
      await reloadIndex();
      setInfo('项目已创建；请先完成左侧的用户任务。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function action(name: string, task?: Task) {
    if (!project || busy) return;
    setBusy(true); setError(''); setInfo('');
    const form = new FormData();
    form.append('action', name);
    if (task) {
      form.append('taskId', task.id);
      if (name === 'submit') {
        form.append('text', notes[task.id] || '');
        if (files[task.id]) form.append('file', files[task.id]!);
      }
      if (name === 'approve' || name === 'reject') form.append('feedback', reviewNotes[task.id] || '');
    }
    try {
      const data = await parseResponse(await fetch('/api/projects/' + encodeURIComponent(project.id) + '/actions', {
        method: 'POST', body: form
      }));
      setProject(data.project);
      if (name === 'submit') {
        setNotes(previous => ({ ...previous, [task!.id]: '' }));
        setFiles(previous => ({ ...previous, [task!.id]: null }));
      }
      if (name === 'run') setInfo(data.executedTaskId ? '已执行任务：' + data.executedTaskId : '当前没有可执行的 Agent 任务。');
      if (name === 'reject') setInfo('已退回 Agent 任务，反馈将传入下次执行。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (name === 'run') await openProject(project.id).catch(() => {});
    } finally { setBusy(false); }
  }

  const artifactsFor = (id: string) => project?.artifacts.filter(a => a.taskId === id) || [];
  const latestResult = (id: string) => [...artifactsFor(id)].reverse().find(a => a.kind === 'agent_result');
  const humans = project?.tasks.filter(t => t.owner === 'human' || t.status === 'review') || [];
  const agents = project?.tasks.filter(t => t.owner === 'agent') || [];
  const readyAgents = agents.filter(t => canStart(t, project!.tasks));

  function badge(task: Task) {
    const blocked = task.status === 'pending' && blockingDependencies(task, project!.tasks).length > 0;
    return <span className={'badge ' + (blocked ? 'blocked' : task.status)}>{blocked ? '等待依赖' : statusLabels[task.status]}</span>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">H/H</span><span>Human Harness<small>Project-first human × AI</small></span></div>
        <div className="head-info"><span className="tiny-label">Executor</span><b>{executorMode === 'demo' ? '演示模式 · 不调用模型' : 'Mastra · 真实模型'}</b></div>
      </header>
      <div className="shell">
        <aside className="sidebar">
          <div className="section-label">项目空间</div>
          <h2>项目列表</h2>
          <form className="create-form" onSubmit={create}>
            <label htmlFor="template">项目模板</label>
            <select id="template" value={templateId} onChange={e => setTemplateId(e.target.value)}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.title} · v{t.version}</option>)}
            </select>
            <label htmlFor="project-title">项目名称</label>
            <input id="project-title" value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如：新项目可行性研究" maxLength={120} />
            <button className="primary" type="submit" disabled={busy || !newName.trim()}>＋ 从模板创建项目</button>
          </form>
          <div className="section-label with-gap">已创建项目</div>
          <nav className="project-list" aria-label="项目列表">
            {projects.map(p => (
              <button type="button" key={p.id} className={project?.id === p.id ? 'project-item active' : 'project-item'} onClick={() => openProject(p.id).catch(e => setError(e.message))}>
                <strong>{p.title}</strong><small>{p.templateId}</small>
              </button>
            ))}
            {projects.length === 0 && <p className="muted">还没有项目。选择模板后创建一个。</p>}
          </nav>
          <div className="sidebar-foot">模板决定初始任务。人类提供现实素材，Agent 执行可以自动完成的部分。</div>
        </aside>
        <main className="main">
          {error && <div role="alert" className="alert error">{error}</div>}
          {info && <div role="status" className="alert info">{info}</div>}
          {!project ? (
            <div className="empty">
              <span className="eyebrow">WELCOME TO HUMAN HARNESS</span>
              <h1>把项目交给任务系统，不再依赖漫长的聊天记录。</h1>
              <p>从左侧创建项目。系统会立即生成用户待办和 Agent 任务，依赖满足后再执行并等待你审核。</p>
              <div className="empty-flow">模板 → 用户输入 → Agent 执行 → 人工审核 → 成果</div>
            </div>
          ) : (
            <>
              <div className="project-header">
                <div><span className="eyebrow">PROJECT / {project.templateId} v{project.templateVersion}</span><h1>{project.title}</h1></div>
                <div className="stats"><div><b>{humans.filter(t => t.status === 'pending' || t.status === 'review').length}</b><span>用户待办</span></div><div><b>{readyAgents.length}</b><span>可执行 Agent</span></div><div><b>{project.artifacts.length}</b><span>成果与素材</span></div></div>
              </div>
              <div className="columns">
                <section className="panel">
                  <div className="panel-header"><div><span className="eyebrow">01 / HUMAN</span><h2>用户 TodoList</h2><p>提供素材、提交判断、审核 AI 结果。</p></div></div>
                  <div className="cards">
                    {humans.map(task => {
                      const ready = canStart(task, project.tasks);
                      const blockers = blockingDependencies(task, project.tasks);
                      const result = latestResult(task.id);
                      return <article className="task-card" key={task.id}>
                        <div className="task-top"><span className="task-id">{task.id}</span>{badge(task)}</div>
                        <h3>{task.title}</h3><p>{task.description}</p>
                        {blockers.length > 0 && task.status === 'pending' && <div className="blocked-by">等待：{blockers.join('、')}</div>}
                        {task.owner === 'human' && ready && (
                          <div className="task-form">
                            {task.inputKind !== 'file' && <textarea aria-label={task.title + '说明'} value={notes[task.id] || ''} onChange={e => setNotes(previous => ({ ...previous, [task.id]: e.target.value }))} placeholder="填写资料、文字说明或链接" rows={4} />}
                            {task.inputKind !== 'text' && <input aria-label={task.title + '上传文件'} type="file" onChange={e => setFiles(previous => ({ ...previous, [task.id]: e.target.files?.[0] || null }))} />}
                            <div className="actions"><button type="button" disabled={busy} onClick={() => action('submit', task)} className="primary">提交并完成</button>{task.optional && <button type="button" disabled={busy} onClick={() => action('skip', task)}>跳过</button>}</div>
                          </div>
                        )}
                        {task.owner === 'human' && task.status === 'completed' && <div className="muted">已提交 {artifactsFor(task.id).map(a => a.name).join('、')}</div>}
                        {task.owner === 'agent' && task.status === 'review' && (
                          <div className="task-form review-form">
                            {result && <pre className="result">{result.content}</pre>}
                            <textarea aria-label="退回理由" rows={3} placeholder="不满意时说明修改要求" value={reviewNotes[task.id] || ''} onChange={e => setReviewNotes(previous => ({ ...previous, [task.id]: e.target.value }))}/>
                            <div className="actions"><button className="primary" type="button" disabled={busy} onClick={() => action('approve', task)}>批准成果</button><button type="button" disabled={busy || !(reviewNotes[task.id] || '').trim()} onClick={() => action('reject', task)}>退回修改</button></div>
                          </div>
                        )}
                      </article>;
                    })}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-header run-header"><div><span className="eyebrow">02 / AGENT</span><h2>Agent 执行与成果</h2><p>只有依赖满足的任务才会执行。</p></div><button className="primary" type="button" disabled={busy || readyAgents.length === 0} onClick={() => action('run')}>{busy ? '执行中…' : '运行下一项 →'}</button></div>
                  <div className="cards">
                    {agents.map(task => {
                      const output = latestResult(task.id);
                      const blockers = blockingDependencies(task, project.tasks);
                      return <article className="task-card" key={task.id}>
                        <div className="task-top"><span className="task-id">{task.id}</span>{badge(task)}</div>
                        <h3>{task.title}</h3><p>{task.description}</p>
                        {blockers.length > 0 && task.status === 'pending' && <div className="blocked-by">依赖：{blockers.join('、')}</div>}
                        {canStart(task, project.tasks) && <div className="ready-hint">✓ 已具备执行条件</div>}
                        {task.status === 'failed' && <p className="error-text">执行失败，可重试；详情见运行日志。</p>}
                        {output && <details className="output" open={task.status === 'review'}><summary>查看最近一次成果 · {output.createdAt.slice(0, 16).replace('T', ' ')}</summary><pre className="result">{output.content}</pre></details>}
                      </article>;
                    })}
                  </div>
                </section>
              </div>
              <section className="timeline"><div className="panel-header"><div><span className="eyebrow">AUDIT TRAIL</span><h2>项目事件记录</h2></div></div><div className="events">{[...project.events].reverse().slice(0, 15).map(event => <div className="event" key={event.id}><time>{event.createdAt.slice(0, 19).replace('T', ' ')}</time><strong>{event.action}</strong><span>{event.taskId || '项目'} · {event.detail}</span></div>)}</div></section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
