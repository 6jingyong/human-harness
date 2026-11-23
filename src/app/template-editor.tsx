'use client';

import { useMemo, useState } from 'react';
import { manualProjectPackage } from '@/protocol/manual';
import { addFlowStage, addFlowTask, authorableTypes, flowTaskLabels, removeFlowTask,
  templateFlow, type AuthorableType, type FlowNode } from '@/protocol/template-flow';
import { packageSchema, type HumanHarnessPackage } from '@/protocol/v1';
import { TemplateFlowChart } from './template-flow-chart';
import { TemplateInspector } from './template-editor-fields';
import './template-editor.css';

const seed = () => manualProjectPackage({
  id: 'my-project', title: '新项目模板', description: '收集资料、执行任务并验收成果',
  inputs: '原始资料', objective: '从已验收资料中整理可审核的项目成果。'
});

function decode(text: string) {
  let candidate: unknown;
  try { candidate = JSON.parse(text); }
  catch { throw new Error('模板 JSON 无法解析。'); }
  const validation = packageSchema.safeParse(candidate);
  if (!validation.success) {
    throw new Error(validation.error.issues.slice(0, 4).map(issue =>
      [issue.path.join('.'), issue.message].filter(Boolean).join(' · ')).join('\n'));
  }
  return validation.data;
}

type EditorProps = {
  source: string;
  busy: boolean;
  onBack: () => void;
  onSave: (body: string) => void;
};

export function TemplateEditor({ source, busy, onBack, onSave }: EditorProps) {
  const [initial] = useState(() => {
    try { return { draft: source ? decode(source) : seed(), error: '' }; }
    catch (error) { return { draft: undefined, error: (error as Error).message }; }
  });
  const [draft, setDraft] = useState(initial.draft);
  const [text, setText] = useState(source);
  const [jsonMode, setJsonMode] = useState(!initial.draft);
  const [error, setError] = useState(initial.error);
  const [stageId, setStageId] = useState('');
  const [filter, setFilter] = useState('');
  const [focused, setFocused] = useState(false);
  const [taskType, setTaskType] = useState<AuthorableType>('human_action');
  const [selected, setSelected] = useState('');
  const flow = useMemo(() => draft && templateFlow(draft), [draft]);
  const nodes = useMemo(() => [...(flow?.nodes.values() ?? [])].filter(node =>
    (!stageId || node.stageId === stageId) &&
    (!filter.trim() || node.title.toLowerCase().includes(filter.trim().toLowerCase()) ||
      flowTaskLabels[node.kind].includes(filter.trim()))), [flow, stageId, filter]);
  const current = flow?.nodes.get(selected) ?? nodes.find(node => node.lane === 'human') ?? nodes[0];
  const visible = useMemo(() => {
    if (!focused || !flow || !current) return nodes;
    const related = new Set([
      current.key,
      ...(flow.incoming.get(current.key) ?? []).map(edge => edge.from),
      ...(flow.outgoing.get(current.key) ?? []).map(edge => edge.to)
    ]);
    return [...flow.nodes.values()].filter(node => related.has(node.key));
  }, [focused, flow, current, nodes]);

  function update(pkg: HumanHarnessPackage) {
    setDraft(pkg);
    setError('');
  }
  function select(node: FlowNode, reveal = false) {
    setSelected(node.key);
    if (reveal) {
      if (stageId) setStageId(node.stageId);
      setFilter('');
      requestAnimationFrame(() => {
        const card = [...document.querySelectorAll<HTMLElement>('[data-flow-card]')]
          .find(item => item.dataset.flowCard === node.key);
        card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
  }
  function addTask() {
    if (!draft) return;
    const result = addFlowTask(draft, taskType, stageId || current?.stageId || draft.stages[0].id);
    update(result.pkg);
    const item = templateFlow(result.pkg).nodes.get(result.key);
    if (item) select(item, true);
  }
  function remove(node: FlowNode) {
    if (!draft) return;
    try {
      update(removeFlowTask(draft, node));
      setSelected('');
    } catch (error) { setError((error as Error).message); }
  }

  function changeView(toJson: boolean) {
    if (toJson && draft) setText(JSON.stringify(draft, null, 2));
    if (!toJson) {
      try {
        if (!draft || text !== JSON.stringify(draft, null, 2)) update(decode(text));
      }
      catch (error) { setError((error as Error).message); return; }
      setSelected('');
      setStageId('');
      setFilter('');
      setFocused(false);
    }
    setJsonMode(toJson);
  }

  function save() {
    if (jsonMode) {
      try { onSave(JSON.stringify(decode(text))); }
      catch (error) { setError((error as Error).message); }
      return;
    }
    if (!draft) return;
    try {
      // Use the same package validator as import, preview and project startup.
      const validated = decode(JSON.stringify(draft));
      const emptyAssembly = validated.steps.find(step => step.kind === 'script' &&
        !step.dependsOn.some(id => validated.steps.some(input => input.id === id && input.outputContractId)));
      if (emptyAssembly) throw new Error(emptyAssembly.title + '需要至少一项已审核的上游成果。');
      onSave(JSON.stringify(validated));
    } catch (error) { setError((error as Error).message); }
  }

  return <section className="template-author" aria-label="项目模板编辑器">
    <header className="template-author-header">
      <div>
        <button className="flow-back" type="button" disabled={busy} onClick={onBack}>← 返回项目</button>
        <h1>项目模板编辑器</h1>
        <p>{draft ? draft.title + ' · v' + draft.version : '导入模板 JSON'}</p>
      </div>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => changeView(!jsonMode)}>{jsonMode ? '应用 JSON 到流程图' : '编辑完整 JSON'}</button>
        <button className="primary" type="button" disabled={busy} onClick={save}>验证并保存模板</button>
      </div>
    </header>
    {error && <div className="alert error flow-error" role="alert">{error}</div>}
    {jsonMode ? <textarea className="json-editor" aria-label="Protocol 1.0 项目模板 JSON" spellCheck={false}
      value={text} onChange={event => setText(event.target.value)} /> : draft && flow && <>
      <details className="flow-metadata">
        <summary>模板资料与阶段</summary>
        <div className="author-grid">
          <label>模板 ID<input value={draft.id} onChange={event => update({ ...draft, id: event.target.value })} /></label>
          <label>版本<input value={draft.version} onChange={event => update({ ...draft, version: event.target.value })} /></label>
          <label>模板名称<input value={draft.title} onChange={event => update({ ...draft, title: event.target.value })} /></label>
          <label>项目描述<input value={draft.description} onChange={event => update({ ...draft, description: event.target.value })} /></label>
        </div>
        <div className="flow-stages">
          {draft.stages.map((stage, index) => <div className="flow-option" key={stage.id}>
            <label>阶段 {index + 1}<input value={stage.title} onChange={event => update({
              ...draft, stages: draft.stages.map(item => item.id === stage.id ? { ...item, title: event.target.value } : item)
            })} /></label>
            <button type="button" aria-label={'移除阶段 ' + stage.title} disabled={draft.stages.length === 1 ||
              [...flow.nodes.values()].some(node => node.stageId === stage.id)} onClick={() => {
              update({ ...draft, stages: draft.stages.filter(item => item.id !== stage.id) });
              if (stageId === stage.id) setStageId('');
            }}>×</button>
          </div>)}
        </div>
        <button type="button" onClick={() => {
          const next = addFlowStage(draft);
          update(next);
          setStageId(next.stages.at(-1)?.id ?? '');
          setFocused(false);
          setFilter('');
        }}>新增阶段</button>
        <p>每次保存用独立版本。已有项目沿用启动时的模板。</p>
      </details>
      <div className="flow-toolbar">
        <div>
          <label>阶段<select aria-label="筛选阶段" value={stageId} onChange={event => {
            setStageId(event.target.value);
            setSelected('');
            setFocused(false);
          }}>
            <option value="">全部阶段</option>
            {draft.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.title || stage.id}</option>)}
          </select></label>
          <label>查找<input type="search" aria-label="查找任务" placeholder="任务名称或类型" value={filter} onChange={event =>
            { setFilter(event.target.value); setSelected(''); setFocused(false); }} /></label>
          <button type="button" aria-pressed={focused} disabled={!current} onClick={() => {
            if (focused) { setFocused(false); return; }
            if (current) setSelected(current.key);
            setFilter('');
            setStageId('');
            setFocused(true);
          }}>{focused ? '显示完整流程' : '聚焦关联'}</button>
        </div>
        <div>
          <label>任务类型<select aria-label="新增任务类型" value={taskType} onChange={event => setTaskType(event.target.value as AuthorableType)}>
            <optgroup label="必须由人完成">
              {authorableTypes.slice(0, 5).map(kind => <option key={kind} value={kind}>{flowTaskLabels[kind]}</option>)}
            </optgroup>
            <optgroup label="可交给 AI／程序">
              {authorableTypes.slice(5).map(kind => <option key={kind} value={kind}>{flowTaskLabels[kind]}</option>)}
            </optgroup>
          </select></label>
          <button type="button" onClick={addTask}>＋ 添加任务</button>
        </div>
      </div>
      <div className="flow-workspace">
        <TemplateFlowChart nodes={visible} links={flow.links} selected={current?.key ?? ''} onSelect={select} />
        {current && <TemplateInspector key={current.key} pkg={draft} node={current} graph={flow} onChange={update}
          onSelect={node => select(node, true)} onRemove={remove} />}
      </div>
    </>}
  </section>;
}
