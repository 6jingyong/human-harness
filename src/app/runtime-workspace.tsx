'use client';

import { useEffect, useState } from 'react';
import type { ProjectState, RuntimeMaterial, RuntimeArtifact, RuntimeStep } from '@/core/runtime';
import type { HumanHarnessPackage } from '@/protocol/v1';
import { manualProjectPackage } from '@/protocol/manual';

type PackageSummary = { id: string; version: string; title: string; description: string; builtin: boolean };
type ProjectSummary = { id: string; title: string; package_id: string; package_version: string };
const workLabels: Record<string, string> = {
  dormant: '未来阶段', blocked: '等待依赖', ready: '可执行', running: '执行中',
  review: '待人工审核', done: '已完成', not_applicable: '本分支不适用', failed: '执行失败'
};
const materialLabels: Record<string, string> = {
  dormant: '未来阶段', expected: '预计产生', requested: '当前需提供',
  received: '已收到·待审核', accepted: '已接受', rejected: '已退回',
  not_applicable: '本分支不适用'
};

async function parseResponse(response: Response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}
function withoutPaths(p: ProjectState): ProjectState {
  return { ...p, artifacts: p.artifacts.map(({ filePath: _hidden, ...artifact }) => artifact) };
}

export function RuntimeWorkspace() {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [packageId, setPackageId] = useState('land-investigation');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'project' | 'editor'>('project');
  const [executor, setExecutor] = useState('demo');
  const [editor, setEditor] = useState('');
  const [form, setForm] = useState({
    id: 'my-investigation', title: '我的项目', description: '项目模板',
    inputs: '项目范围与目标\n文件:原始资料', objective: '根据已核验资料形成可审阅的内部成果'
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refreshIndex() {
    const data = await parseResponse(await fetch('/api/v1/projects', { cache: 'no-store' }));
    setPackages(data.packages);
    setProjects(data.projects);
    setExecutor(data.executor);
  }
  async function openProject(id: string) {
    const data = await parseResponse(await fetch('/api/v1/projects/' + encodeURIComponent(id), { cache: 'no-store' }));
    setProject(withoutPaths(data.project));
    setMode('project');
  }
  useEffect(() => { refreshIndex().catch(e => setError(e.message)); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await parseResponse(await fetch('/api/v1/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId, title: name })
      }));
      setProject(data.project); setMode('project'); setName('');
      await refreshIndex();
      setNotice('项目已创建。请先完成当前显示的用户资料任务。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function openTemplateEditor() {
    setBusy(true); setError('');
    try {
      const data = await parseResponse(await fetch('/api/v1/packages?id=' + encodeURIComponent(packageId)));
      const selected: HumanHarnessPackage = data.package;
      // Built-ins use a new ID so users do not overwrite the installed reference package.
      const copy = { ...selected, id: selected.id + '-custom', version: '1.0.0' };
      setEditor(JSON.stringify(copy, null, 2));
      setMode('editor');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function generateTemplate() {
    setError(''); setNotice('');
    try {
      const generated = manualProjectPackage(form);
      setEditor(JSON.stringify(generated, null, 2));
      setNotice('模板草稿已生成，可继续编辑完整 JSON 并保存。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function saveTemplate() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!editor.trim()) throw new Error('请先生成或填写模板 JSON');
      const data = await parseResponse(await fetch('/api/v1/packages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: editor
      }));
      await refreshIndex();
      setPackageId(data.package.id);
      setMode('project');
      setNotice('新协议模板已保存：' + data.package.id + ' @ ' + data.package.version);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function importFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 200000) { setError('项目模板不能超过 200KB'); return; }
    setEditor(await file.text());
    setMode('editor');
    setNotice('已载入本地模板。请检查内容并保存。');
  }

  async function action(type: string, extra: { stepId?: string; materialId?: string } = {}) {
    if (!project || busy) return;
    setBusy(true); setError(''); setNotice('');
    const key = extra.stepId || extra.materialId || '';
    const data = new FormData();
    data.append('action', type);
    if (extra.stepId) data.append('stepId', extra.stepId);
    if (extra.materialId) data.append('materialId', extra.materialId);
    data.append('value', values[key] || '');
    data.append('feedback', feedback[key] || '');
    if (files[key]) data.append('file', files[key]!);
    try {
      const result = await parseResponse(await fetch('/api/v1/projects/' + encodeURIComponent(project.id) + '/actions', {
        method: 'POST', body: data
      }));
      setProject(withoutPaths(result.project));
      if (['complete_human', 'submit_material'].includes(type)) {
        setValues(old => ({ ...old, [key]: '' }));
        setFiles(old => ({ ...old, [key]: undefined }));
      }
      setNotice(type === 'run_agent' ? 'Agent 已执行一项任务，结果等待人工审核。' : '状态已保存，并重新检查后续任务依赖。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Agent can fail after reservation; refresh the persisted failure state.
      try { await openProject(project.id); } catch { /* original error takes precedence */ }
    } finally { setBusy(false); }
  }

  const readyMaterials = project?.package.materials.filter(m => ['requested', 'received', 'rejected'].includes(project.materials[m.id].state)) ?? [];
  const futureMaterials = project?.package.materials.filter(m => ['dormant', 'expected', 'not_applicable'].includes(project.materials[m.id].state)) ?? [];
  const readyHumanSteps = project?.package.steps.filter(s =>
    ['human_action', 'human_decision', 'external_milestone'].includes(s.kind) && project.steps[s.id].state === 'ready') ?? [];
  const agentSteps = project?.package.steps.filter(s => ['agent', 'script'].includes(s.kind) && project.steps[s.id].state !== 'not_applicable') ?? [];
  const agentReviews = project?.package.steps.filter(s => ['agent', 'script'].includes(s.kind) && project.steps[s.id].state === 'review') ?? [];
  const humanCount = readyHumanSteps.length + readyMaterials.length + agentReviews.length;
  const agentReady = agentSteps.filter(s => project?.steps[s.id].state === 'ready');
  const outputFor = (stepId: string) => project?.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === stepId).at(-1);

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">H/H</span><span>Human Harness<small>项目运行 · Protocol 1.0</small></span></div>
      <div className="head-info"><span className="tiny-label">Executor</span><b>{executor === 'demo' ? 'Demo（不调用模型）' : 'Mastra（真实模型）'}</b></div>
    </header>
    <div className="shell">
      <aside className="sidebar">
        <div className="section-label">项目模板（手动）</div>
        <h2>创建项目</h2>
        <form className="create-form" onSubmit={create}>
          <label htmlFor="package-select">选择已安装模板</label>
          <select id="package-select" value={packageId} onChange={e => setPackageId(e.target.value)}>
            {packages.map(p => <option key={p.id} value={p.id}>{p.title} · {p.version}</option>)}
          </select>
          <label htmlFor="new-project-name">本次项目名称</label>
          <input id="new-project-name" maxLength={150} value={name} onChange={e => setName(e.target.value)} placeholder="例如：某地块污染状况调查" />
          <button className="primary" type="submit" disabled={!name.trim() || busy}>＋ 创建项目</button>
        </form>
        <div className="section-label with-gap">模板管理</div>
        <button onClick={() => { setEditor(''); setMode('editor'); }} disabled={busy}>＋ 新建模板</button>
        <button onClick={openTemplateEditor} disabled={busy}>复制所选模板</button>
        <label className="upload-label">导入本地 JSON 模板<input type="file" accept=".json,application/json" onChange={importFile} disabled={busy} /></label>
        <div className="section-label with-gap">已有项目</div>
        <nav className="project-list">
          {projects.map(p => <button key={p.id} type="button" className={'project-item ' + (project?.id === p.id ? 'active' : '')}
            onClick={() => openProject(p.id).catch(e => setError(e.message))}>
            <strong>{p.title}</strong><small>{p.package_id} · {p.package_version}</small>
          </button>)}
          {!projects.length && <p className="muted">创建第一个项目。</p>}
        </nav>
        <p className="sidebar-foot">当前为本地开发版本。未配置账户认证，请勿公开部署。</p>
      </aside>
      <main className="main">
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert info" role="status">{notice}</div>}

        {mode === 'editor' ? <section className="editor-screen">
          <span className="eyebrow">MANUAL PACKAGE AUTHORING</span>
          <h1>手动创建项目模板</h1>
          <p>简单项目可由表单生成 Protocol 1.0 模板；复杂阶段、专业决策、未来资料和脚本引用使用下方 JSON 完整声明。</p>
          <div className="author-grid">
            <label>模板 ID<input value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} /></label>
            <label>模板名称<input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></label>
            <label className="wide">项目描述<input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></label>
            <label>用户初始资料（每行一项）<textarea rows={4} value={form.inputs} onChange={e => setForm(f => ({ ...f, inputs: e.target.value }))} /></label>
            <label>Agent 任务目标<textarea rows={4} value={form.objective} onChange={e => setForm(f => ({ ...f, objective: e.target.value }))} /></label>
          </div>
          <button type="button" onClick={generateTemplate} disabled={busy}>生成标准模板草稿</button>
          <details className="advanced-editor" open>
            <summary>完整模板 JSON（hh.package/1）</summary>
            <textarea className="json-editor" aria-label="Protocol 1.0 项目模板 JSON" spellCheck={false}
              value={editor} onChange={e => setEditor(e.target.value)} />
          </details>
          <div className="actions"><button className="primary" type="button" onClick={saveTemplate} disabled={busy}>验证并保存模板</button>
            <button type="button" onClick={() => setMode('project')} disabled={busy}>返回项目</button></div>
          <p className="muted">每次更新模板请修改 version。已有项目继续使用创建时冻结的版本。只有已安装执行能力的模板可以运行。</p>
        </section> : !project ? <div className="empty">
          <span className="eyebrow">HUMAN HARNESS / PROJECT OPERATOR</span>
          <h1>从项目模板开始，而不是从聊天开始。</h1>
          <p>手动选择、创建或导入模板；系统按资料需求与任务依赖推进。专业机构的结果必须由真实的人类或机构提供。</p>
          <div className="empty-flow">模板 → 项目实例 → 当前人工待办 / Agent 执行 → 人工审核 → 交付</div>
        </div> : <>
          <div className="project-header">
            <div><span className="eyebrow">{project.templateId} / {project.templateVersion}</span><h1>{project.title}</h1></div>
            <div className="stats"><div><b>{humanCount}</b><span>当前用户任务</span></div>
              <div><b>{agentReady.length}</b><span>Agent 可执行</span></div>
              <div><b>{project.artifacts.length}</b><span>已归档成果</span></div></div>
          </div>
          <section className="package-summary">
            <div><strong>执行阶段</strong><p>{project.package.stages.map(s => s.title).join(' → ')}</p></div>
            <div><strong>模板版本</strong><p>{project.templateVersion} · {project.packageDigest.slice(0, 20)}…</p></div>
            <div><strong>最终交付（按分支）</strong><p>{project.package.outputs.map(o => o.fileName).join(' · ')}</p></div>
          </section>
          <div className="columns">
            <section className="panel">
              <div className="panel-header"><span className="eyebrow">HUMAN</span><h2>当前用户 TodoList</h2><p>只显示此刻可以采取行动的资料、决策及审核；未来资料不提前索取。</p></div>
              <div className="cards">
                {!humanCount && <p className="muted">暂时没有待办。可查看 Agent 执行区或等待外部工作完成。</p>}
                {readyMaterials.map(m => {
                  const state = project.materials[m.id];
                  const key = m.id;
                  return <article className="task-card" key={m.id}>
                    <div className="task-top"><span className="task-id">{m.id} · {m.producer}</span>
                      <span className={'badge ' + state.state}>{materialLabels[state.state]}</span></div>
                    <h3>{m.title}</h3><p>{m.description}</p>
                    {state.state === 'received' ? <>
                      <p>已收到：{state.artifactIds.map(id => project.artifacts.find(a => a.id === id)?.name).join('、')}。须由用户核实真实来源与要求，不能仅凭上传即视为合格。</p>
                      <textarea aria-label={m.title + '审核备注'} placeholder="退回时请说明原因" value={feedback[key] || ''} onChange={e => setFeedback(f => ({ ...f, [key]: e.target.value }))} />
                      <div className="actions"><button type="button" className="primary" disabled={busy} onClick={() => action('accept_material', { materialId: key })}>确认资料可接受</button>
                        <button type="button" disabled={busy || !(feedback[key] || '').trim()} onClick={() => action('reject_material', { materialId: key })}>退回补充</button></div>
                    </> : <>
                      {m.formats.includes('text/plain') && <textarea aria-label={m.title} rows={3}
                        value={values[key] || ''} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} placeholder="输入资料或来源说明" />}
                      <input type="file" aria-label={m.title + '文件'} onChange={e => setFiles(v => ({ ...v, [key]: e.target.files?.[0] }))} />
                      <button type="button" className="primary" disabled={busy} onClick={() => action('submit_material', { materialId: key })}>提交资料</button>
                      {state.state === 'rejected' && <p className="error-text">该资料已退回，请重新提交。</p>}
                    </>}
                  </article>;
                })}
                {readyHumanSteps.map(s => <article className="task-card" key={s.id}>
                  <div className="task-top"><span className="task-id">{s.stageId} / {s.id}</span><span className="badge ready">待人工完成</span></div>
                  <h3>{s.title}</h3><p>{s.instructions}</p>
                  {s.kind === 'human_decision' ? <select aria-label={s.title + '选项'} value={values[s.id] || ''} onChange={e => setValues(v => ({ ...v, [s.id]: e.target.value }))}>
                    <option value="">请选择决策结果</option>{s.options?.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select> : <textarea rows={3} aria-label={s.title + '确认说明'} value={values[s.id] || ''}
                    onChange={e => setValues(v => ({ ...v, [s.id]: e.target.value }))} placeholder="填写真实完成情况与依据" />}
                  <button type="button" className="primary" disabled={busy || !(values[s.id] || '').trim()}
                    onClick={() => action('complete_human', { stepId: s.id })}>确认并推进流程</button>
                </article>)}
                {agentReviews.map(s => {
                  const output = outputFor(s.id);
                  return <article className="task-card" key={s.id}>
                    <div className="task-top"><span className="task-id">{s.id}</span><span className="badge review">等待人工审核</span></div>
                    <h3>{s.title}</h3>{output && <pre className="result">{output.content}</pre>}
                    <textarea aria-label={s.title + '审核说明'} value={feedback[s.id] || ''}
                      onChange={e => setFeedback(f => ({ ...f, [s.id]: e.target.value }))} placeholder="退回原因或审核备注" />
                    <div className="actions"><button className="primary" type="button" disabled={busy} onClick={() => action('approve_agent', { stepId: s.id })}>批准结果</button>
                      <button type="button" disabled={busy || !(feedback[s.id] || '').trim()} onClick={() => action('reject_agent', { stepId: s.id })}>退回重做</button></div>
                  </article>;
                })}
              </div>
            </section>
            <section className="panel">
              <div className="panel-header"><span className="eyebrow">AGENT</span><h2>Agent 执行与候选成果</h2><p>Mastra 负责工作，Human Harness 控制状态、素材范围与审核。</p></div>
              <div className="cards">
                {agentSteps.map(s => {
                  const status = project.steps[s.id];
                  const versions = project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === s.id).reverse();
                  return <article className="task-card" key={s.id}>
                    <div className="task-top"><span className="task-id">{s.stageId} / {s.id}</span>
                      <span className={'badge ' + status.state}>{workLabels[status.state]}</span></div>
                    <h3>{s.title}</h3><p>{s.instructions}</p>
                    {status.state === 'ready' && <button type="button" className="primary" disabled={busy} onClick={() => action('run_agent', { stepId: s.id })}>运行此 Agent 任务</button>}
                    {status.state === 'failed' && <button type="button" disabled={busy} onClick={() => action('retry_agent', { stepId: s.id })}>重新允许执行</button>}
                    {versions.map((a, index) => <details className="output" key={a.id} open={index === 0 && status.state === 'review'}>
                      <summary>候选成果 v{a.revision} · {a.name}</summary><pre className="result">{a.content}</pre>
                    </details>)}
                  </article>;
                })}
              </div>
            </section>
          </div>
          <section className="timeline material-overview">
            <div className="panel-header"><span className="eyebrow">MATERIAL ROADMAP</span><h2>未来资料需求</h2>
              <p>模板预先知道资料的存在，但只有条件满足后才会进入上面的用户 TodoList。</p></div>
            <div className="material-grid">{futureMaterials.map(m => {
              const state = project.materials[m.id];
              return <div className="material-item" key={m.id}>
                <strong>{m.title}</strong><span className={'badge ' + state.state}>{materialLabels[state.state]}</span>
                <small>{m.description}</small>
              </div>;
            })}
              {!futureMaterials.length && <p className="muted">所有资料需求已处理或当前需要处理。</p>}
            </div>
          </section>
          <section className="timeline">
            <div className="panel-header"><span className="eyebrow">PROJECT AUDIT</span><h2>事件与历史</h2></div>
            <div className="events">{[...project.events].reverse().slice(0, 18).map(e => <div className="event" key={e.id}>
              <time>{e.createdAt.slice(0, 19).replace('T', ' ')}</time><strong>{e.type}</strong><span>{e.subject} {e.detail}</span>
            </div>)}</div>
          </section>
        </>}
      </main>
    </div>;
}
