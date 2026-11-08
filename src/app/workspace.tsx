'use client';

import { useEffect, useState } from 'react';
import type { Project, Task } from '@/lib/domain';
import { blockingDependencies, canStart } from '@/lib/domain';
import { buildManualTemplateDraft } from '@/lib/manual-template';

type TemplateSummary = { id: string; title: string; description: string; version: number };
type ProjectSummary = { id: string; title: string; templateId: string; createdAt: string };

const starterManifest = JSON.stringify({
  id: 'my-project-template', title: '我的项目模板', description: '通过手动定义任务流程运行一个项目',
  version: 1, schemaVersion: 3,
  workflow: { stages: [
    { id: 'intake', title: '用户资料', description: '收集项目初始输入' },
    { id: 'work', title: 'AI执行与审核', description: '根据提交的资料形成待审草稿' }
  ] },
  materials: [{ id: 'project-brief', title: '项目要求', taskId: 'brief', producer: 'human', required: true }],
  resources: [],
  tasks: [
    { id: 'brief', title: '提交项目要求', description: '描述项目目标与预期结果', owner: 'human', dependsOn: [], inputKind: 'text', stageId: 'intake' },
    { id: 'draft', title: '形成内部草稿', description: 'Agent 形成待审核成果', owner: 'agent', dependsOn: ['brief'], prompt: '仅根据已有证据形成内部草稿，无法核实的事项单独标记。', reviewRequired: true, stageId: 'work' }
  ],
  deliverables: [{ id: 'draft-output', taskId: 'draft', fileName: 'draft.md', format: 'markdown', minChars: 20 }]
}, null, 2);

const statusLabels: Record<string, string> = {
  inactive: '分支未激活', not_applicable: '当前分支不适用',
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
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [templateJson, setTemplateJson] = useState(starterManifest);
  const [authorId, setAuthorId] = useState('my-custom-project');
  const [authorTitle, setAuthorTitle] = useState('自定义项目');
  const [authorDescription, setAuthorDescription] = useState('由用户手工配置的项目流程');
  const [authorInputs, setAuthorInputs] = useState('项目目标与边界\n文件:项目原始资料');
  const [authorGoal, setAuthorGoal] = useState('根据已收到的资料生成可审核的项目成果');
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

  async function importTemplate(event: React.ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const file = field.files?.[0];
    if (!file || busy) return;
    setBusy(true); setError(''); setInfo('');
    try {
      if (file.size > 100000) throw new Error('模板 JSON 不能超过 100 KB');
      const data = await parseResponse(await fetch('/api/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text()
      }));
      await reloadIndex();
      setTemplateId(data.template.id);
      setInfo('模板已导入：' + data.template.title + ' v' + data.template.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      field.value = '';
      setBusy(false);
    }
  }

  function generateManualTemplate() {
    setError(''); setInfo('');
    try {
      const template = buildManualTemplateDraft({
        id: authorId, title: authorTitle, description: authorDescription,
        initialInputs: authorInputs, agentGoal: authorGoal
      });
      setTemplateJson(JSON.stringify(template, null, 2));
      setInfo('已根据表单生成完整任务模板。你可以继续修改下面的 JSON，再保存。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadTemplateForEditing() {
    setBusy(true); setError(''); setInfo('');
    try {
      const data = await parseResponse(await fetch('/api/templates?id=' + encodeURIComponent(templateId), { cache: 'no-store' }));
      const builtIn = ['general-project', 'site-investigation', 'land-investigation-runtime'].includes(data.template.id);
      const draft = {
        ...data.template,
        id: builtIn ? data.template.id + '-custom' : data.template.id,
        version: builtIn ? 1 : data.template.version + 1
      };
      setTemplateJson(JSON.stringify(draft, null, 2));
      setShowTemplateEditor(true);
      setInfo(builtIn ? '已创建内置模板副本；可以自由编辑后另存。' : '已载入模板新版本；校验通过后可保存。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function saveTemplateJson() {
    if (busy) return;
    setBusy(true); setError(''); setInfo('');
    try {
      if (templateJson.length > 100000) throw new Error('模板 JSON 不能超过 100 KB');
      const data = await parseResponse(await fetch('/api/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: templateJson
      }));
      await reloadIndex();
      setTemplateId(data.template.id);
      setInfo('模板已保存并完成结构校验：' + data.template.title + ' v' + data.template.version);
      setShowTemplateEditor(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

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
      if (name === 'run') {
        try {
          const fresh = await parseResponse(await fetch('/api/projects/' + encodeURIComponent(project.id), { cache: 'no-store' }));
          setProject(fresh.project);
        } catch { /* preserve original model error */ }
      }
    } finally { setBusy(false); }
  }

  const artifactsFor = (id: string) => project?.artifacts.filter(a => a.taskId === id) || [];
  const latestResult = (id: string) => [...artifactsFor(id)].reverse().find(a => a.kind === 'agent_result');
  const humans = project?.tasks.filter(t => t.status === 'review' || (t.owner === 'human' && canStart(t, project.tasks))) || [];
  const pastHumanTasks = project?.tasks.filter(t => t.owner === 'human' && (t.status === 'completed' || t.status === 'skipped')) || [];
  const agents = project?.tasks.filter(t => t.owner === 'agent' && t.status !== 'not_applicable') || [];
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
            <label htmlFor="template-import">导入自定义模板（JSON）</label>
            <input id="template-import" type="file" accept=".json,application/json" aria-label="导入项目模板 JSON" onChange={importTemplate} disabled={busy} />
            <label htmlFor="project-title">项目名称</label>
            <input id="project-title" value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如：新项目可行性研究" maxLength={120} />
            <button className="primary" type="submit" disabled={busy || !newName.trim()}>＋ 从模板创建项目</button>
          </form>
          <div className="section-label with-gap">手动管理模板</div>
          <button type="button" disabled={busy} onClick={() => { setTemplateJson(starterManifest); setShowTemplateEditor(true); setError(''); }}>＋ 新建模板</button>
          <button type="button" disabled={busy} onClick={loadTemplateForEditing}>复制 / 编辑所选模板</button>
          <div className="section-label with-gap">已创建项目</div>
          <nav className="project-list" aria-label="项目列表">
            {projects.map(p => (
              <button type="button" key={p.id} className={project?.id === p.id ? 'project-item active' : 'project-item'} onClick={() => { setShowTemplateEditor(false); openProject(p.id).catch(e => setError(e.message)); }}>
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
          {showTemplateEditor ? (
            <section className="editor-screen">
              <span className="eyebrow">MANUAL TEMPLATE STUDIO</span>
              <h1>手动创建或修改项目模板</h1>
              <p>先通过表单生成一个可运行的基础流程，再按需在 JSON 中添加人工决策、后续资料、内置资源和脚本。模板不需要搜索服务。</p>
              <div className="author-grid">
                <label>模板 ID（英文）<input value={authorId} onChange={e => setAuthorId(e.target.value)} /></label>
                <label>模板名称<input value={authorTitle} onChange={e => setAuthorTitle(e.target.value)} /></label>
                <label className="wide">项目描述<input value={authorDescription} onChange={e => setAuthorDescription(e.target.value)} /></label>
                <label>初始用户资料（每行一项，文件项前缀“文件:”）<textarea rows={4} value={authorInputs} onChange={e => setAuthorInputs(e.target.value)} /></label>
                <label>Agent 需要执行的任务说明<textarea rows={4} value={authorGoal} onChange={e => setAuthorGoal(e.target.value)} /></label>
              </div>
              <button type="button" disabled={busy} onClick={generateManualTemplate}>根据以上内容生成模板草稿</button>
              <details className="advanced-editor" open>
                <summary>高级设置：完整项目模板 JSON</summary>
              <textarea aria-label="项目模板 JSON 编辑器" spellCheck={false} className="json-editor" value={templateJson} onChange={event => setTemplateJson(event.target.value)} /></details>
              <div className="actions"><button type="button" className="primary" disabled={busy} onClick={saveTemplateJson}>校验并保存模板</button><button type="button" disabled={busy} onClick={() => setShowTemplateEditor(false)}>返回项目</button></div>
              <p className="muted">项目创建后会冻结模板版本。可从仓库中的 examples/template.land-investigation-runtime.json 导入真实的分支示例。</p>
            </section>
          ) : !project ? (
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
                <div className="stats"><div><b>{humans.length}</b><span>用户待办</span></div><div><b>{readyAgents.length}</b><span>可执行 Agent</span></div><div><b>{project.artifacts.length}</b><span>成果与素材</span></div></div>
              </div>
              {(project.template?.schemaVersion === 2 || project.template?.schemaVersion === 3) && (
                <section className="package-summary" aria-label="项目模板内置资源与交付契约">
                  <div><strong>项目流程</strong><p>{project.template.workflow?.stages.map(s => s.title).join(' → ')}</p></div>
                  <div><strong>内置资源与自动化</strong><p>{project.template.resources?.map(r => r.title).join(' · ') || '无'}</p></div>
                  <div><strong>最终交付要求</strong><p>{project.template.deliverables?.map(d => d.fileName + '（' + d.format + '）').join(' · ') || '未规定'}</p></div>
                </section>
              )}
              <div className="columns">
                <section className="panel">
                  <div className="panel-header"><div><span className="eyebrow">01 / HUMAN</span><h2>用户 TodoList</h2><p>提供素材、提交判断、审核 AI 结果。</p></div></div>
                  <div className="cards">
                    {humans.map(task => {
                      const ready = canStart(task, project.tasks);
                      const blockers = blockingDependencies(task, project.tasks);
                      const result = latestResult(task.id);
                      return <article className="task-card" key={task.id}>
                        <div className="task-top"><span className="task-id">{task.stageId ? task.stageId + " / " : ""}{task.id}</span>{badge(task)}</div>
                        <h3>{task.title}</h3><p>{task.description}</p>
                        {blockers.length > 0 && task.status === 'pending' && <div className="blocked-by">等待：{blockers.join('、')}</div>}
                        {task.owner === 'human' && ready && (
                          <div className="task-form">
                            {task.inputKind === 'choice' && <select aria-label={task.title + '决策选项'} value={notes[task.id] || ''} onChange={e => setNotes(previous => ({ ...previous, [task.id]: e.target.value }))}><option value="">请选择专业决策结果</option>{task.choices?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
                            {task.inputKind !== 'file' && task.inputKind !== 'choice' && <textarea aria-label={task.title + '说明'} value={notes[task.id] || ''} onChange={e => setNotes(previous => ({ ...previous, [task.id]: e.target.value }))} placeholder="填写资料、文字说明或链接" rows={4} />}
                            {(task.inputKind === 'file' || task.inputKind === 'either') && <input aria-label={task.title + '上传文件'} type="file" onChange={e => setFiles(previous => ({ ...previous, [task.id]: e.target.files?.[0] || null }))} />}
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
                    <details className="completed-group"><summary>已完成的用户任务（{pastHumanTasks.length}）</summary>
                      {pastHumanTasks.map(t => <div key={t.id} className="completed-line"><span>{t.title}</span><span>{statusLabels[t.status]}</span></div>)}
                    </details>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-header run-header"><div><span className="eyebrow">02 / AGENT</span><h2>Agent 执行与成果</h2><p>只有依赖满足的任务才会执行。</p></div><button className="primary" type="button" disabled={busy || readyAgents.length === 0} onClick={() => action('run')}>{busy ? '执行中…' : '运行下一项 →'}</button></div>
                  <div className="cards">
                    {agents.map(task => {
                      const outputs = [...artifactsFor(task.id)].filter(a => a.kind === 'agent_result').reverse();
                      const blockers = blockingDependencies(task, project.tasks);
                      return <article className="task-card" key={task.id}>
                        <div className="task-top"><span className="task-id">{task.id}</span>{badge(task)}</div>
                        <h3>{task.title}</h3><p>{task.description}</p>
                        {blockers.length > 0 && task.status === 'pending' && <div className="blocked-by">依赖：{blockers.join('、')}</div>}
                        {canStart(task, project.tasks) && <div className="ready-hint">✓ 已具备执行条件</div>}
                        {task.status === 'failed' && <p className="error-text">执行失败，可重试；详情见运行日志。</p>}
                        {outputs.map((output, version) => <details key={output.id} className="output" open={version === 0 && task.status === 'review'}><summary>成果版本 {outputs.length - version} · {output.createdAt.slice(0, 16).replace('T', ' ')}</summary><pre className="result">{output.content}</pre></details>)}
                      </article>;
                    })}
                  </div>
                </section>
              </div>
              {project.materials && project.materials.length > 0 && (
                <section className="timeline material-overview">
                  <div className="panel-header"><div><span className="eyebrow">MATERIAL REQUIREMENTS</span><h2>资料需求与产生时机</h2><p>未激活的是未来可能需要的资料，不属于当前用户待办；已收到也不代表专业验证通过。</p></div></div>
                  <div className="material-grid">{project.materials.map(m => <div className="material-item" key={m.id}>
                    <strong>{m.title}</strong><span className={'badge ' + m.status}>{m.status === 'needed' ? '当前需提供' : m.status === 'received' ? '已收到·待核验' : m.status === 'not_applicable' ? '本分支不适用' : '未来阶段'}</span>
                    <small>{m.producer === 'external_institution' ? '来源：外部专业机构' : '来源：用户'}{m.note ? ' · ' + m.note : ''}</small>
                  </div>)}</div>
                </section>
              )}
              <section className="timeline"><div className="panel-header"><div><span className="eyebrow">AUDIT TRAIL</span><h2>项目事件记录</h2></div></div><div className="events">{[...project.events].reverse().slice(0, 15).map(event => <div className="event" key={event.id}><time>{event.createdAt.slice(0, 19).replace('T', ' ')}</time><strong>{event.action}</strong><span>{event.taskId || '项目'} · {event.detail}</span></div>)}</div></section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
