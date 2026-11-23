'use client';

import { useState } from 'react';
import { addDecisionOption, flowTaskLabels, isMachine, templateFlow, type FlowNode } from '@/protocol/template-flow';
import type { Condition, HumanHarnessPackage } from '@/protocol/v1';
import { templateDeliverables } from '@/protocol/project-launch';

type Choice = { id: string; title: string };

function Lines({ label, values, onChange }: { label: string; values: string[]; onChange: (values: string[]) => void }) {
  // Keep the user's line breaks while editing, including a trailing blank line.
  const [text, setText] = useState(values.join('\n'));
  return <label>{label}<textarea rows={3} value={text} onChange={event => {
    setText(event.target.value);
    onChange(event.target.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  }} /></label>;
}

function Minutes({ label, value, onChange }: { label: string; value?: number; onChange: (value?: number) => void }) {
  return <label>{label}<input type="number" min="15" max="24000" step="15" value={value ?? ''} onChange={event =>
    onChange(event.target.value ? Number(event.target.value) : undefined)} /></label>;
}

function IdList({ label, values, choices, onChange, ordered }: {
  label: string; values: string[]; choices: Choice[]; onChange: (values: string[]) => void; ordered?: boolean;
}) {
  function move(index: number, offset: number) {
    const reordered = [...values];
    const destination = index + offset;
    [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
    onChange(reordered);
  }
  const available = choices.filter(choice => !values.includes(choice.id));
  return <fieldset className="flow-link-field">
    <legend>{label}</legend>
    {values.map((id, index) => {
      const title = choices.find(choice => choice.id === id)?.title ?? id;
      return <div className="flow-link-item" key={id}>
        <span>{title}</span>
        <div>
          {ordered && <><button type="button" aria-label={'上移 ' + title} disabled={!index} onClick={() => move(index, -1)}>↑</button>
            <button type="button" aria-label={'下移 ' + title} disabled={index === values.length - 1} onClick={() => move(index, 1)}>↓</button></>}
          <button type="button" aria-label={'解除 ' + title} onClick={() => onChange(values.filter(value => value !== id))}>×</button>
        </div>
      </div>;
    })}
    {available.length > 0 && <select aria-label={label} value="" onChange={event => onChange([...values, event.target.value])}>
      <option value="" disabled>添加关联…</option>
      {available.map(choice => <option key={choice.id} value={choice.id}>{choice.title || choice.id}</option>)}
    </select>}
  </fieldset>;
}

function ConditionEditor({ label, value, pkg, owner, change }: {
  label: string; value?: Condition; pkg: HumanHarnessPackage; owner: string; change: (value?: Condition) => void;
}) {
  const steps = pkg.steps.filter(step => step.id !== owner);
  const decisions = steps.filter(step => step.kind === 'human_decision' && step.options?.length);
  const orders = pkg.workOrders ?? [];
  const firstBranch = decisions[0];
  const possible: Partial<Record<Condition['type'], Condition>> = {
    decision: firstBranch?.options?.[0] && { type: 'decision', stepId: firstBranch.id, option: firstBranch.options[0].id },
    work_done: steps[0] && { type: 'work_done', stepId: steps[0].id },
    work_order: orders[0] && { type: 'work_order', orderId: orders[0].id },
    all: { type: 'all', clauses: [] },
    any: { type: 'any', clauses: [] }
  };
  const defaultClause = possible.decision ?? possible.work_done ?? possible.work_order;
  const choice = value?.type === 'decision' ? decisions.find(step => step.id === value.stepId) : undefined;
  return <div className="flow-condition">
    <label>{label}<select value={value?.type ?? ''} onChange={event =>
      change(possible[event.target.value as Condition['type']])}>
      <option value="">无额外条件</option>
      <option value="decision" disabled={!firstBranch}>人工选择指定分支</option>
      <option value="work_done" disabled={!steps.length}>指定任务已完成</option>
      <option value="work_order" disabled={!orders.length}>项目启用外部事项</option>
      <option value="all">以下条件全部满足</option>
      <option value="any">以下条件任一满足</option>
    </select></label>
    {value?.type === 'decision' && <>
      <label>决策任务<select value={value.stepId} onChange={event => {
        const selected = decisions.find(step => step.id === event.target.value);
        if (selected?.options?.length) change({ type: 'decision', stepId: selected.id, option: selected.options[0].id });
      }}>
        {!choice && <option value={value.stepId} disabled>{value.stepId}</option>}
        {decisions.map(step => <option key={step.id} value={step.id}>{step.title}</option>)}
      </select></label>
      <label>触发选项<select value={value.option} onChange={event => change({ ...value, option: event.target.value })}>
        {!choice?.options?.some(option => option.id === value.option) && <option value={value.option} disabled>{value.option}</option>}
        {choice?.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
    </>}
    {value?.type === 'work_done' && <label>触发任务<select value={value.stepId}
      onChange={event => change({ ...value, stepId: event.target.value })}>
      {steps.map(step => <option key={step.id} value={step.id}>{step.title}</option>)}
    </select></label>}
    {value?.type === 'work_order' && <label>外部事项<select value={value.orderId}
      onChange={event => change({ ...value, orderId: event.target.value })}>
      {orders.map(order => <option key={order.id} value={order.id}>{order.title}</option>)}
    </select></label>}
    {(value?.type === 'all' || value?.type === 'any') && <>
      {value.clauses.map((clause, index) => <ConditionEditor key={index} label={'条件 ' + (index + 1)} value={clause}
        pkg={pkg} owner={owner} change={next => change({ ...value, clauses: next
          ? value.clauses.map((item, i) => i === index ? next : item)
          : value.clauses.filter((_, i) => i !== index) })} />)}
      <button type="button" disabled={!defaultClause || value.clauses.length >= 20} onClick={() => {
        if (defaultClause) change({ ...value, clauses: [...value.clauses, defaultClause] });
      }}>添加一条条件</button>
    </>}
  </div>;
}

type InspectorProps = {
  pkg: HumanHarnessPackage;
  node: FlowNode;
  graph: ReturnType<typeof templateFlow>;
  onChange: (pkg: HumanHarnessPackage) => void;
  onSelect: (node: FlowNode) => void;
  onRemove: (node: FlowNode) => void;
};

export function TemplateInspector({ pkg, node, graph, onChange, onSelect, onRemove }: InspectorProps) {
  const stage = pkg.stages.find(stage => stage.id === node.stageId);
  const step = pkg.steps.find(item => item.id === node.id);
  const material = pkg.materials.find(item => item.id === node.id);
  const order = pkg.workOrders?.find(item => item.id === node.id);
  const output = step && pkg.outputs.find(item => item.id === step.outputContractId);
  const updateStep = (changes: Partial<NonNullable<typeof step>>) => onChange({
    ...pkg, steps: pkg.steps.map(item => item.id === node.id ? { ...item, ...changes } : item)
  });
  const updateMaterial = (changes: Partial<NonNullable<typeof material>>) => onChange({
    ...pkg, materials: pkg.materials.map(item => item.id === node.id ? { ...item, ...changes } : item)
  });
  const updateOrder = (changes: Partial<NonNullable<typeof order>>) => onChange({
    ...pkg, workOrders: pkg.workOrders?.map(item => item.id === node.id ? { ...item, ...changes } : item)
  });
  const updateOutput = (changes: Partial<NonNullable<typeof output>>) => onChange({
    ...pkg, outputs: pkg.outputs.map(item => item.id === output?.id ? { ...item, ...changes } : item)
  });
  const deliverables = new Set(templateDeliverables(pkg).map(item => item.id));
  function markDelivery(deliverable: boolean) {
    onChange({ ...pkg, outputs: pkg.outputs.map(item => item.id === output?.id
      ? { ...item, deliverable } : deliverables.has(item.id) ? { ...item, deliverable: true } : item) });
  }
  const links = [
    ...(graph.incoming.get(node.key) ?? []).map(edge => ({ key: edge.from, label: '来自 · ' + edge.label })),
    ...(graph.outgoing.get(node.key) ?? []).map(edge => ({ key: edge.to, label: '通往 · ' + edge.label }))
  ];
  return <section className="flow-inspector" aria-label="流程任务属性">
    <header><small className={node.lane}>{flowTaskLabels[node.kind]} · {stage?.title}</small>
      <h2>{node.title || '未命名任务'}</h2></header>
    {node.kind === 'review' && step && <>
      <p>上游交来候选成果后，这一步进入 Human Todo。人工验收通过才解锁下游任务。</p>
      <Minutes label="人工审核预计分钟" value={step.planning?.reviewMinutes}
        onChange={reviewMinutes => updateStep({ planning: { ...step.planning, reviewMinutes } })} />
      {output && <>
        <label>成果名称<input value={output.title} onChange={event => updateOutput({ title: event.target.value })} /></label>
        {step.kind === 'agent' && !output.word && !output.markdown && (output.format === 'markdown' || output.format === 'json') &&
          <label>成果格式<select value={output.format} onChange={event => {
            const format = event.target.value === 'json' ? 'json' : 'markdown';
            updateOutput({ format, fileName: output.fileName.replace(/\.(md|json)$/, format === 'json' ? '.json' : '.md') });
          }}>
            <option value="markdown">Markdown</option><option value="json">JSON</option>
          </select></label>}
        <Lines label="成果验收标准（每行一项）" values={output.acceptance} onChange={acceptance => updateOutput({ acceptance })} />
        <label className="flow-check"><input type="checkbox" checked={deliverables.has(output.id)}
          onChange={event => markDelivery(event.target.checked)} />列入项目交付</label>
      </>}
    </>}
    {node.kind === 'material' && material && <>
      <label>资料名称<input value={material.title} onChange={event => updateMaterial({ title: event.target.value })} /></label>
      <label>提交说明<textarea value={material.description} onChange={event => updateMaterial({ description: event.target.value })} /></label>
      <Minutes label="提交与验收预计分钟" value={material.planningMinutes} onChange={planningMinutes => updateMaterial({ planningMinutes })} />
      <Lines label="资料验收标准（每行一项）" values={material.acceptance} onChange={acceptance => updateMaterial({ acceptance })} />
      <details>
        <summary>资料来源与格式</summary>
        <label>资料来源<select value={material.producer} onChange={event =>
          updateMaterial({ producer: event.target.value as typeof material.producer })}>
          <option value="human">项目经办人</option><option value="external_institution">外部机构</option><option value="agent">Agent 产生</option>
        </select></label>
        <Lines label="接受格式 MIME（每行一项）" values={material.formats} onChange={formats => updateMaterial({ formats })} />
      </details>
      <details open={Boolean(material.requiredWhen || material.requestWhen || material.onDemand) || undefined}>
        <summary>出现时间</summary>
        <label className="flow-check"><input type="checkbox" checked={material.onDemand === true}
          disabled={Boolean(material.requiredWhen || material.requestWhen)}
          onChange={event => updateMaterial({ onDemand: event.target.checked ? true : undefined })} />仅在已关联的任务发起补问时显示</label>
        {!material.onDemand && <>
          {(pkg.workOrders ?? []).some(order => order.deliverables.includes(material.id))
            ? <p className="muted">此资料在所属外部事项启用时适用。</p>
            : <ConditionEditor label="资料适用条件" value={material.requiredWhen} pkg={pkg} owner=""
              change={requiredWhen => updateMaterial({ requiredWhen })} />}
          <ConditionEditor label="何时向人索取" value={material.requestWhen} pkg={pkg} owner=""
            change={requestWhen => updateMaterial({ requestWhen })} />
        </>}
      </details>
    </>}
    {node.kind === 'order' && order && <>
      <label>外部事项名称<input value={order.title} onChange={event => updateOrder({ title: event.target.value })} /></label>
      <label>办理范围与要求<textarea value={order.description} onChange={event => updateOrder({ description: event.target.value })} /></label>
      <IdList label="启用后等待已验收回件的任务" values={order.consumers} choices={pkg.steps.filter(step =>
        step.kind !== 'script' && !(step.when?.type === 'work_order' && step.when.orderId === order.id))}
        onChange={consumers => updateOrder({ consumers })} />
      {!order.consumers.length && <p className="error-text">请关联至少一个使用回件的任务。</p>}
      {order.followUp && <label>首次跟进等待（工作日）<input type="number" min={1} max={20} value={order.followUp.workingDays}
        onChange={event => updateOrder({ followUp: order.followUp && { ...order.followUp, workingDays: Number(event.target.value) } })} /></label>}
    </>}
    {node.key.startsWith('step:') && step && <>
      <label>任务名称<input value={step.title} onChange={event => updateStep({ title: event.target.value })} /></label>
      <label>所属阶段<select value={step.stageId} onChange={event => updateStep({ stageId: event.target.value })}>
        {pkg.stages.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label>任务说明<textarea value={step.instructions} onChange={event => updateStep({ instructions: event.target.value })} /></label>
      {step.kind === 'agent' && <details open={Boolean(step.codexSkills) || undefined}>
        <summary>Codex Skills</summary>
        <label>所需 Skill（每行一个）<textarea key={step.id}
          defaultValue={step.codexSkills?.join('\n') ?? ''} rows={3}
          placeholder="例如 pdf，或 插件ID/Skill名称"
          onBlur={event => {
            const names = event.target.value.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
            updateStep({ codexSkills: names.length ? names : undefined });
          }} /></label>
        <small>使用本机 Codex 已启用的 Skill。指定后，此任务需要 Codex 执行器。</small>
      </details>}
      <Minutes label={step.kind === 'external_milestone' ? '外部预计工期（工作分钟）' : '预计投入分钟'}
        value={step.planning?.workMinutes} onChange={workMinutes => updateStep({ planning: { ...step.planning, workMinutes } })} />
      {step.kind === 'human_decision' && step.options && <fieldset className="flow-link-field">
        <legend>人工决策选项</legend>
        {step.options.map((option, index) => <div className="flow-option" key={option.id}>
          <label>选项 {index + 1}<input value={option.label} onChange={event => updateStep({
            options: step.options?.map(item => item.id === option.id ? { ...item, label: event.target.value } : item)
          })} /></label>
          <button type="button" aria-label={'移除选项 ' + option.label} disabled={(step.options?.length ?? 0) <= 2}
            onClick={() => updateStep({ options: step.options?.filter(item => item.id !== option.id) })}>×</button>
        </div>)}
        <button type="button" disabled={step.options.length >= 20} onClick={() =>
          updateStep({ options: addDecisionOption(step.options ?? []) })}>增加选项</button>
      </fieldset>}
      <IdList label="前置任务" values={step.dependsOn} choices={pkg.steps.filter(item =>
        item.id !== step.id && (step.kind !== 'script' || isMachine(item)))}
        onChange={dependsOn => updateStep({ dependsOn })} ordered={step.kind === 'script'} />
      {step.kind !== 'script' && <IdList label="所需已验收资料" values={step.needsMaterials}
        choices={pkg.materials.filter(material => !material.onDemand)}
        onChange={needsMaterials => updateStep({ needsMaterials })} />}
      <details open={Boolean(step.when) || undefined}><summary>任务启动条件</summary>
        <ConditionEditor label="触发方式" value={step.when} pkg={pkg} owner={step.id} change={when => updateStep({ when })} />
      </details>
      {isMachine(step) && <details><summary>AI 分工与可发起的补问</summary>
        {Boolean(pkg.agents?.length) && <label>执行组<select value={step.agentId ?? ''} onChange={event =>
          updateStep({ agentId: event.target.value || undefined })}>
          <option value="">默认组</option>
          {pkg.agents?.map(agent => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
        </select></label>}
        <IdList label="允许发起补问的资料" values={step.requestableMaterialIds ?? []} choices={pkg.materials}
          onChange={requestableMaterialIds => updateStep({ requestableMaterialIds })} />
      </details>}
    </>}
    {links.length > 0 && <details className="flow-connections" open>
      <summary>连接任务（{links.length}）</summary>
      {links.map((link, index) => {
        const other = graph.nodes.get(link.key);
        return other && <button type="button" key={link.key + ':' + index} onClick={() => onSelect(other)}>
          <small>{link.label}</small>{other.title || other.id}
        </button>;
      })}
    </details>}
    {node.kind !== 'review' && <button className="flow-remove" type="button" onClick={() => onRemove(node)}>删除当前{node.kind === 'order' ? '事项及所属节点' : '节点'}</button>}
  </section>;
}
