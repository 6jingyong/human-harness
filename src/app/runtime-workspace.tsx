'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProjectState } from '@/core/runtime';
import { deriveWorkbenchQueues } from './workbench-queue';
import { TaskWorkbench } from './task-workbench';
import { ProjectMaterialLibrary } from './project-material-library';
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
  const [packageId, setPackageId] = useState('document-handoff');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'project' | 'editor' | 'library'>('project');
  const [menuOpen, setMenuOpen] = useState(false);
  const [executor, setExecutor] = useState('demo');
  const [editor, setEditor] = useState('');
  const [form, setForm] = useState({
    id: 'my-document-project', title: '资料整理项目', description: '通用文档工作流',
    inputs: '文件:原始资料A\n文件:原始资料B', objective: '根据已核验资料形成可审阅的内部成果'
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [focusedHandoff, setFocusedHandoff] = useState('');
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>({});
  const pendingKeys = useRef(new Set<string>());
  const projectRequestSequence = useRef(0);

  async function refreshIndex() {
    const data = await parseResponse(await fetch('/api/v1/projects', { cache: 'no-store' }));
    setPackages(data.packages);
    setProjects(data.projects);
    setExecutor(data.executor);
  }
  async function openProject(id: string, silent = false) {
    const request = ++projectRequestSequence.current;
    const data = await parseResponse(await fetch('/api/v1/projects/' + encodeURIComponent(id), { cache: 'no-store' }));
    if (request !== projectRequestSequence.current) return;
    setProject(withoutPaths(data.project));
    if (!silent) { setMode('project'); setFocusedHandoff(''); setMenuOpen(false); }
  }
  useEffect(() => { refreshIndex().catch(e => setError(e.message)); }, []);
  // Server owns active Codex turns. Refreshing the page does not interrupt them.
  useEffect(() => {
    if (!project?.id || mode !== 'project') return;
    const projectId = project.id;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void openProject(projectId, true).catch(() => { /* preserve current view until reconnect */ });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [project?.id, mode]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await parseResponse(await fetch('/api/v1/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId, title: name })
      }));
      projectRequestSequence.current++;
      setProject(withoutPaths(data.project)); setFocusedHandoff(''); setMode('project'); setMenuOpen(false); setName('');
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
      // Built-ins are copied under a new ID; custom templates can be edited as a new immutable version.
      const builtin = packages.some(p => p.id === selected.id && p.builtin);
      const parts = selected.version.split('.').map(Number);
      const nextVersion = parts.length === 3 && parts.every(Number.isInteger)
        ? [parts[0], parts[1], parts[2] + 1].join('.') : '1.0.0';
      const copy = {
        ...selected,
        id: builtin ? selected.id + '-custom' : selected.id,
        version: builtin ? '1.0.0' : nextVersion
      };
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

  async function action(
    type: string,
    extra: { stepId?: string; materialId?: string; autoDispatch?: boolean; maxParallel?: number } = {}
  ) {
    if (!project || busy) return;
    const projectId = project.id;
    const key = extra.stepId || extra.materialId || 'execution-policy';
    const scopedKey = projectId + ':' + key;
    // Serialize only operations on the same WorkItem, not the entire project.
    if (pendingKeys.current.has(scopedKey)) return;
    pendingKeys.current.add(scopedKey);
    setPendingActions(old => ({ ...old, [scopedKey]: true }));
    setError(''); setNotice('');
    const data = new FormData();
    data.append('action', type);
    if (extra.stepId) data.append('stepId', extra.stepId);
    if (extra.materialId) data.append('materialId', extra.materialId);
    if (type === 'set_execution_policy') {
      data.append('autoDispatch', String(extra.autoDispatch));
      data.append('maxParallel', String(extra.maxParallel));
    }
    data.append('value', values[key] || '');
    data.append('feedback', feedback[key] || '');
    if (files[key]) data.append('file', files[key]!);
    try {
      await parseResponse(await fetch('/api/v1/projects/' + encodeURIComponent(projectId) + '/actions', {
        method: 'POST', body: data
      }));
      if (['complete_human', 'submit_material'].includes(type)) {
        setValues(old => ({ ...old, [key]: '' }));
        setFiles(old => ({ ...old, [key]: undefined }));
      }
      await openProject(projectId, true);
      setNotice(type === 'run_agent'
        ? '本次 Agent 任务已执行，候选成果交由 Human Todo 审核。'
        : type === 'set_execution_policy'
          ? '项目自动派发设置已保存。已运行的任务不受暂停影响。'
          : '任务已保存；符合依赖的其他 Agent 工作可自动开始。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try { await openProject(projectId, true); } catch { /* preserve original error */ }
    } finally {
      pendingKeys.current.delete(scopedKey);
      setPendingActions(old => {
        const next = { ...old };
        delete next[scopedKey];
        return next;
      });
    }
  }

  const queues = project ? deriveWorkbenchQueues(project) : null;
  const humanCount = queues?.human.length ?? 0;
  const agentRunning = project?.package.steps.filter(step =>
    ['agent', 'script'].includes(step.kind) && project.steps[step.id].state === 'running').length ?? 0;
  const policy = project?.execution ?? { autoDispatch: false, maxParallel: 2 };
  const isPending = (key: string) => busy || Boolean(pendingActions[(project?.id ?? '') + ':' + key]);

  return <div className="app">
    <header className="topbar">
      <button type="button" className="hamburger" aria-label={menuOpen ? '关闭菜单' : '打开菜单'}
        aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰</button>
      <div className="brand"><span className="brand-mark">H/H</span><span>Human Harness<small>项目运行 · Protocol 1.0</small></span></div>
      <div className="head-info"><span className="tiny-label">Executor</span><b>{executor === 'demo' ? 'Demo（不调用模型）' : executor === 'codex' ? 'Codex（本机 app-server）' : 'Mastra（真实模型）'}</b></div>
    </header>
    <div className="shell">
      {menuOpen && <button type="button" className="menu-backdrop" aria-label="收起侧边栏"
          onClick={() => setMenuOpen(false)} />}
       <aside className={'sidebar navigation-drawer' + (menuOpen ? ' open' : '')} aria-label="项目与设置菜单">
         <div className="drawer-heading"><strong>项目与设置</strong>
           <button type="button" onClick={() => setMenuOpen(false)}>×</button></div>
         <div className="drawer-navigation">
           <button type="button" onClick={() => { setMode('project'); setMenuOpen(false); }}>任务主页</button>
           <button type="button" disabled={!project} onClick={() => { setMode('library'); setMenuOpen(false); }}>
             项目资料管理
           </button>
         </div>

        <div className="section-label">项目模板（手动）</div>
        <h2>创建项目</h2>
        <form className="create-form" onSubmit={create}>
          <label htmlFor="package-select">选择已安装模板</label>
          <select id="package-select" value={packageId} onChange={e => setPackageId(e.target.value)}>
            {packages.map(p => <option key={p.id} value={p.id}>{p.title} · {p.version}</option>)}
          </select>
          <label htmlFor="new-project-name">本次项目名称</label>
          <input id="new-project-name" maxLength={150} value={name} onChange={e => setName(e.target.value)} placeholder="例如：市场资料核对项目" />
          <button className="primary" type="submit" disabled={!name.trim() || busy}>＋ 创建项目</button>
        </form>
        {project && <div className="drawer-execution">
          <div className="section-label with-gap">Agent 自动派发</div>
          <p>{policy.autoDispatch ? '正在自动执行' : '已暂停新任务'}</p>
          <label>项目并发数
            <select aria-label="项目 Agent 最大并发数" value={policy.maxParallel}
              disabled={isPending('execution-policy')}
              onChange={e => action('set_execution_policy', {
                autoDispatch: policy.autoDispatch, maxParallel: Number(e.target.value)
              })}>
              {[1, 2, 3, 4].map(n => <option value={n} key={n}>{n}</option>)}
            </select>
          </label>
          <button type="button" disabled={isPending('execution-policy')}
            onClick={() => action('set_execution_policy', {
              autoDispatch: !policy.autoDispatch, maxParallel: policy.maxParallel
            })}>{policy.autoDispatch ? '暂停自动派发' : '恢复自动派发'}</button>
        </div>}
        <div className="section-label with-gap">模板管理</div>
        <button onClick={() => { setEditor(''); setMode('editor'); setMenuOpen(false); }} disabled={busy}>＋ 新建模板</button>
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

        {mode === 'library' && project ? <ProjectMaterialLibrary
          project={project} onBack={() => setMode('project')} /> :
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
           <span className="eyebrow">HUMAN HARNESS</span>
           <h1>Human Todo + Agent Todo</h1>
           <p>用项目模板安排双方的工作。打开左上角 ☰ 菜单创建项目。</p>
           <button type="button" className="primary" onClick={() => setMenuOpen(true)}>☰ 新建或选择项目</button>
        </div> : <>
          <div className="simple-project-title">
            <div><span className="eyebrow">{project.package.title}</span><h1>{project.title}</h1></div>
            <div className="simple-project-actions">
              <span>{humanCount} 项待你处理 · {agentRunning} 项 Agent 运行中</span>
              <button type="button" onClick={() => setMode('library')}>查看项目资料</button>
            </div>
          </div>
          <TaskWorkbench project={project} executor={executor}
            selectedKey={focusedHandoff} onSelect={setFocusedHandoff}
            onRefresh={() => openProject(project.id).catch(e => setError(e.message))}
            onAction={action} values={values} feedback={feedback} files={files}
            onValue={(key, value) => setValues(old => ({ ...old, [key]: value }))}
            onFeedback={(key, value) => setFeedback(old => ({ ...old, [key]: value }))}
            onFile={(key, file) => setFiles(old => ({ ...old, [key]: file }))}
            isPending={isPending}
          />
        </>}
      </main>
    </div>
  </div>;
}
