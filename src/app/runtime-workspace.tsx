'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProjectState } from '@/core/runtime';
import { deriveWorkbenchQueues } from './workbench-queue';
import { ModelPicker } from './model-picker';
import type { ModelSettings } from '@/protocol/model-settings';
import './local-workspace.css';
import { TaskWorkbench } from './task-workbench';
import { ProjectDeliverables } from './project-deliverables';
import { ProjectLaunchView } from './project-launch-view';
import { ProjectRequirements } from './project-requirements';
import { PlanAttention, ProjectPlanView } from './project-plan-view';
import { ProjectMaterialLibrary } from './project-material-library';
import type { HumanHarnessPackage } from '@/protocol/v1';
import { TemplateEditor } from './template-editor';
import { ProjectLedgerView } from './project-ledger-view';
import { CompanyLedgerView } from './company-ledger-view';
import type { LedgerReference } from '@/protocol/project-ledger';

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
  const [launchTemplate, setLaunchTemplate] = useState<HumanHarnessPackage>();
  const [mode, setMode] = useState<'project' | 'editor' | 'library' | 'plan' | 'launch' | 'ledger' | 'company-ledger'>('project');
  const [ledgerReference, setLedgerReference] = useState<LedgerReference>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useState<ModelSettings>({ provider: 'demo', model: null });
  const [modelsOpen, setModelsOpen] = useState(false);
  const executor = settings.provider;
  const [editor, setEditor] = useState({ source: '', revision: 0 });
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
  const focusProjectName = useRef(false);
  useEffect(() => {
    if (menuOpen && focusProjectName.current) {
      document.getElementById('new-project-name')?.focus();
      focusProjectName.current = false;
    }
  }, [menuOpen]);

  async function refreshIndex() {
    const data = await parseResponse(await fetch('/api/v1/projects', { cache: 'no-store' }));
    setPackages(data.packages);
    setProjects(data.projects);
    setSettings(data.settings);
  }
  async function openProject(id: string, silent = false, destination: 'project' | 'ledger' = 'project') {
    const request = ++projectRequestSequence.current;
    const data = await parseResponse(await fetch('/api/v1/projects/' + encodeURIComponent(id), { cache: 'no-store' }));
    if (request !== projectRequestSequence.current) return;
    const incoming = withoutPaths(data.project);
    setProject(current => {
      if (current?.id !== incoming.id) return incoming;
      if ((current.coordination?.revision ?? 0) > (incoming.coordination?.revision ?? 0)) return current;
      return (current.planning?.revision ?? 0) > (incoming.planning?.revision ?? 0)
        ? { ...incoming, planning: current.planning } : incoming;
    });
    if (!silent) { setLedgerReference(undefined); setMode(destination); setFocusedHandoff(''); setMenuOpen(false); }
  }
  useEffect(() => { refreshIndex().catch(e => setError(e.message)); }, []);
  // Server owns active Codex turns. Refreshing the page does not interrupt them.
  useEffect(() => {
    if (!project?.id || (mode !== 'project' && mode !== 'plan' && mode !== 'ledger')) return;
    const projectId = project.id;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void openProject(projectId, true).catch(() => { /* preserve current view until reconnect */ });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [project?.id, mode]);

  async function openLaunch(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const version = packages.find(item => item.id === packageId)?.version;
      const query = new URLSearchParams({ id: packageId, ...(version ? { version } : {}) });
      const { package: template } = await parseResponse(await fetch('/api/v1/packages?' + query));
      projectRequestSequence.current++;
      setLaunchTemplate(template);
      setMode('launch');
      setMenuOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function projectCreated(created: ProjectState) {
    projectRequestSequence.current++;
    setProject(withoutPaths(created));
    setFocusedHandoff('');
    setMode('project');
    setMenuOpen(false);
    setName('');
    setNotice('项目已启动。请处理当前显示的 Human Todo。');
    void refreshIndex().catch(error => setError(error.message));
  }

  function beginTemplateEditor(source: string) {
    setEditor(current => ({ source, revision: current.revision + 1 }));
    setError('');
    setNotice('');
    setMode('editor');
    setMenuOpen(false);
  }

  async function openTemplateEditor(reference?: 'land-investigation') {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams(reference ? { reference } : { id: packageId });
      const data = await parseResponse(await fetch('/api/v1/packages?' + query));
      const selected: HumanHarnessPackage = data.package;
      const readonly = reference || packages.some(p => p.id === selected.id && p.builtin);
      const id = readonly ? selected.id + '-custom' : selected.id;
      const previous = readonly ? packages.find(item => item.id === id)?.version : selected.version;
      const parts = previous?.split('.').map(Number);
      const version = parts ? [parts[0], parts[1], parts[2] + 1].join('.') : '1.0.0';
      beginTemplateEditor(JSON.stringify({ ...selected, id, version }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function saveTemplate(body: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await parseResponse(await fetch('/api/v1/packages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
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
    try {
      beginTemplateEditor(await file.text());
      setNotice('已载入本地模板。请检查内容并保存。');
    } catch {
      setError('读取模板文件失败');
    }
  }

  async function action(
    type: string,
    extra: { stepId?: string; materialId?: string; requestId?: string; expectedArtifactId?: string; promisedOn?: string; autoDispatch?: boolean; maxParallel?: number } = {}
  ) {
    if (!project || busy) return;
    const projectId = project.id;
    const key = type === 'revise_approved_agent'
      ? 'revision:' + extra.stepId
      : extra.requestId || extra.stepId || extra.materialId || 'execution-policy';
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
    if (extra.requestId) data.append('requestId', extra.requestId);
    if (extra.expectedArtifactId) data.append('expectedArtifactId', extra.expectedArtifactId);
    if (type === 'set_execution_policy') {
      data.append('autoDispatch', String(extra.autoDispatch));
      data.append('maxParallel', String(extra.maxParallel));
    }
    data.append('value', values[key] || '');
    if (extra.promisedOn) data.append('promisedOn', extra.promisedOn);
    data.append('feedback', feedback[key] || '');
    if (files[key]) data.append('file', files[key]!);
    try {
      await parseResponse(await fetch('/api/v1/projects/' + encodeURIComponent(projectId) + '/actions', {
        method: 'POST', body: data
      }));
      if (['complete_human', 'submit_material', 'answer_human_request', 'replace_material',
        'revise_approved_agent', 'record_work_order_follow_up'].includes(type)) {
        setValues(old => ({ ...old, [key]: '', ['promise:' + key]: '' }));
        setFiles(old => ({ ...old, [key]: undefined }));
      }
      if (type === 'revise_approved_agent') {
        setFeedback(old => ({ ...old, [key]: '' }));
        setValues(old => ({ ...old, ['revision-head:' + extra.stepId]: '' }));
      }
      await openProject(projectId, true);
      setNotice(type === 'revise_approved_agent'
        ? '人工成果修订已记录并成为当前 HEAD，受影响任务将按依赖图重新处理。'
        : type === 'run_agent'
        ? 'Agent 任务已提交后台执行；完成后仍需人工审核。'
        : type === 'set_execution_policy'
          ? '项目自动派发设置已保存。已运行的任务不受暂停影响。'
          : type === 'replace_material' || (type === 'answer_human_request' && Boolean(files[key]))
            ? '新原件已提交，必须先在 Human Todo 验收；验收前不会替换现有依据。'
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
      <div className="brand"><span className="brand-mark" aria-hidden="true">H/H</span><span>Human Harness<small>本地项目工作台</small></span></div>
      <button className="model-trigger" aria-label="选择工作模型" onClick={() => setModelsOpen(true)}>
        <i aria-hidden="true" /><span>{settings.provider === 'demo' ? '演示模式' : settings.model || 'Codex 默认模型'}</span><b aria-hidden="true">⌄</b>
      </button>
    </header>
    {modelsOpen && <ModelPicker settings={settings} onClose={() => setModelsOpen(false)}
      onSaved={value => { setSettings(value); setModelsOpen(false); setNotice('工作模型设置已保存。'); }} />}
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
           <button type="button" onClick={() => { setMode('company-ledger'); setMenuOpen(false); }}>公司账务</button>
         </div>

        <div className="section-label">项目模板</div>
        <h2>创建项目</h2>
        <form className="create-form" onSubmit={openLaunch}>
          <label htmlFor="package-select">选择项目模板</label>
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
        <button onClick={() => beginTemplateEditor('')} disabled={busy}>＋ 新建模板</button>
        <button onClick={() => openTemplateEditor()} disabled={busy}>复制所选模板</button>
        <button onClick={() => openTemplateEditor('land-investigation')} disabled={busy}>打开环评参考模板</button>
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
      <main className="main" inert={menuOpen} aria-hidden={menuOpen || undefined}>
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert info" role="status">{notice}</div>}

        {mode === 'launch' && launchTemplate ? <ProjectLaunchView
          key={launchTemplate.id + '@' + launchTemplate.version} template={launchTemplate} title={name}
          onCancel={() => { setMode('project'); setMenuOpen(true); }}
          onCreated={projectCreated} /> :
        mode === 'library' && project ? <ProjectMaterialLibrary
          project={project} onBack={() => setMode('project')}
          onReplace={materialId => action('replace_material', { materialId })}
          onRevise={(stepId, expectedArtifactId) =>
            action('revise_approved_agent', { stepId, expectedArtifactId })}
          values={values} feedback={feedback} files={files}
          onValue={(key, value) => setValues(old => ({ ...old, [key]: value }))}
          onFeedback={(key, value) => setFeedback(old => ({ ...old, [key]: value }))}
          onFile={(key, file) => setFiles(old => ({ ...old, [key]: file }))}
          isPending={isPending}
          /> :
        mode === 'plan' && project ? <ProjectPlanView key={project.id} project={project}
          onBack={() => setMode('project')}
          onOpen={key => { setFocusedHandoff(key); setMode('project'); }}
          onSaved={(id, planning) => setProject(current => current?.id === id ? { ...current, planning } : current)}
        /> :
        mode === 'company-ledger' ? <CompanyLedgerView onBack={() => setMode('project')}
          onOpen={id => void openProject(id, false, 'ledger').catch(error => setError(error.message))} /> :
        mode === 'ledger' && project ? <ProjectLedgerView key={project.id} project={project}
          projects={projects} initialReference={ledgerReference} onBack={() => setMode('project')} /> :
        mode === 'editor' ? <TemplateEditor key={editor.revision} source={editor.source} busy={busy}
          onSave={body => void saveTemplate(body)} onBack={() => setMode('project')} /> : !project ? <section className="studio-home">
          <header className="studio-lead"><div><div className="workspace-kicker">本地工作台</div>
            <h1>项目工作区</h1><p>从模板启动项目，或继续处理你的待办。</p></div>
            <button type="button" className="primary" onClick={() => setMenuOpen(true)}>＋ 新建项目</button></header>
          <h2>从模板开始</h2>
          <div className="studio-templates">{[
            { id: 'general-report', title: '报告撰写', detail: '整理证据、撰写初稿与交付', mark: '▤' },
            { id: 'project-plan', title: '项目启动', detail: '明确目标、分工与时间表', mark: '◷' },
            { id: 'meeting-actions', title: '会议纪要', detail: '提取决定并跟进后续行动', mark: '☷' }
          ].map(item => <button key={item.id} type="button" onClick={() => {
            focusProjectName.current = true; setPackageId(item.id); setMenuOpen(true);
          }}><i aria-hidden="true">{item.mark}</i><strong>{item.title}</strong><small>{item.detail}</small><span aria-hidden="true">↗</span></button>)}</div>
          <h2>最近项目</h2>
          {projects.length ? <div className="studio-recent">{projects.slice(0,6).map(item =>
            <button key={item.id} type="button" onClick={() => openProject(item.id).catch(e => setError(e.message))}>
              <strong>{item.title}</strong><small>{packages.find(pkg => pkg.id === item.package_id)?.title || item.package_id}　↗</small>
            </button>)}</div> : <p className="studio-no-project">创建的项目会显示在这里。</p>}
        </section> : <>
          <div className="simple-project-title">
            <div><span className="eyebrow">{project.package.title}</span><h1>{project.title}</h1></div>
            <div className="simple-project-actions">
              <span>{humanCount} 项待你处理 · {agentRunning} 项 Agent 运行中</span>
              <button type="button" onClick={() => setMode('plan')}>项目计划</button>
              <button type="button" onClick={() => { setLedgerReference(undefined); setMode('ledger'); }}>项目账务</button>
              <button type="button" onClick={() => setMode('library')}>查看项目资料</button>
            </div>
          </div>
          <ProjectRequirements key={project.id} project={project} onSaved={updated => {
            setProject(current => current?.id === updated.id ? withoutPaths(updated) : current);
          }} />
          <PlanAttention project={project} onOpen={setFocusedHandoff} />
          <TaskWorkbench project={project} executor={executor}
            selectedKey={focusedHandoff} onSelect={setFocusedHandoff}
            onRefresh={() => openProject(project.id).catch(e => setError(e.message))}
            onRecord={reference => { setLedgerReference(reference); setMode('ledger'); }}
            onAction={action} values={values} feedback={feedback} files={files}
            onValue={(key, value) => setValues(old => ({ ...old, [key]: value }))}
            onFeedback={(key, value) => setFeedback(old => ({ ...old, [key]: value }))}
            onFile={(key, file) => setFiles(old => ({ ...old, [key]: file }))}
            isPending={isPending}
          />
          <ProjectDeliverables project={project} onOpen={setFocusedHandoff} />
        </>}
      </main>
    </div>
  </div>;
}
