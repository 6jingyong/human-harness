import type { Condition, HumanHarnessPackage } from './v1';

type Step = HumanHarnessPackage['steps'][number];
type Material = HumanHarnessPackage['materials'][number];
export type FlowTaskKind = Step['kind'] | 'material' | 'order' | 'review';
export const flowTaskLabels: Record<FlowTaskKind, string> = {
  material: '资料提交与验收',
  human_action: '人工办理',
  human_decision: '人工决策',
  external_milestone: '外部回件确认',
  agent: 'AI 处理',
  script: '程序组装',
  review: '人工审核',
  order: '可选外部事项'
};

export const authorableTypes = [
  'material', 'human_action', 'human_decision', 'external_milestone', 'order', 'agent', 'script'
] as const;
export type AuthorableType = typeof authorableTypes[number];

export type FlowNode = {
  key: string;
  id: string;
  kind: FlowTaskKind;
  lane: 'human' | 'machine';
  stageId: string;
  title: string;
  depth: number;
};

export type FlowLink = {
  from: string;
  to: string;
  rule: 'dependency' | 'condition' | 'review' | 'clarification';
  label: string;
  workOrderId?: string;
};

export const isMachine = (step: Step) => step.kind === 'agent' || step.kind === 'script';

/** Draw implicit runtime handoffs without introducing extra steps into the package. */
export function templateFlow(pkg: HumanHarnessPackage) {
  const nodes = new Map<string, FlowNode>();
  const links: FlowLink[] = [];
  const steps = new Map(pkg.steps.map(step => [step.id, step]));
  const materialUsers = new Map<string, Set<string>>();
  const add = (prefix: string, item: { id: string; title: string }, stageId: string, kind: FlowTaskKind, lane: FlowNode['lane']) => {
    const key = prefix + ':' + item.id;
    nodes.set(key, { key, id: item.id, kind, lane, stageId, title: item.title, depth: 0 });
    return key;
  };
  const link = (from: string, to: string, rule: FlowLink['rule'], label: string) => links.push({ from, to, rule, label });
  const completed = (stepId: string) => {
    const step = steps.get(stepId);
    return (step && isMachine(step) ? 'review:' : 'step:') + stepId;
  };
  function condition(value: Condition | undefined, target: string, label: string) {
    if (!value) return;
    switch (value.type) {
      case 'decision': {
        const choice = steps.get(value.stepId)?.options?.find(option => option.id === value.option);
        link(completed(value.stepId), target, 'condition', label + ' · ' + (choice?.label ?? value.option));
        break;
      }
      case 'work_done':
        link(completed(value.stepId), target, 'condition', label + ' · 前项完成');
        break;
      case 'work_order':
        link('order:' + value.orderId, target, 'condition', label + ' · 已启用');
        break;
      case 'all':
      case 'any':
        for (const clause of value.clauses) condition(clause, target, label + (value.type === 'all' ? ' · 全部满足' : ' · 任一满足'));
        break;
    }
  }

  const orders = pkg.workOrders ?? [];
  const firstStage = pkg.stages[0].id;
  const recordMaterial = (materialId: string, stageId: string) => {
    const stages = materialUsers.get(materialId) ?? new Set<string>();
    stages.add(stageId);
    materialUsers.set(materialId, stages);
  };
  for (const order of orders) {
    const milestone = steps.get(order.followUp?.milestoneId ?? '');
    const stageId = milestone?.stageId ?? pkg.steps.find(step =>
      step.when?.type === 'work_order' && step.when.orderId === order.id)?.stageId ?? firstStage;
    add('order', order, stageId, 'order', 'human');
    for (const id of order.deliverables) recordMaterial(id, stageId);
  }

  for (const step of pkg.steps) {
    const machine = isMachine(step);
    const stepKey = add('step', step, step.stageId, step.kind, machine ? 'machine' : 'human');
    if (machine) {
      const review = add('review', { id: step.id, title: '审核 · ' + step.title }, step.stageId, 'review', 'human');
      link(stepKey, review, 'review', '候选成果待人审定');
    }
    for (const dependency of step.dependsOn) link(completed(dependency), stepKey, 'dependency', '前项完成');
    for (const id of step.needsMaterials) {
      recordMaterial(id, step.stageId);
      link('material:' + id, stepKey, 'dependency', '资料已验收');
    }
    for (const id of step.requestableMaterialIds ?? []) {
      recordMaterial(id, step.stageId);
      link(stepKey, 'material:' + id, 'clarification', '仅在任务提出已声明的补问后');
    }
    condition(step.when, stepKey, '启动条件');
  }
  for (const order of orders) {
    for (const material of order.deliverables) for (const consumer of order.consumers) {
      links.push({ from: 'material:' + material, to: 'step:' + consumer, rule: 'condition',
        label: order.title + '启用时 · 回件已验收', workOrderId: order.id });
    }
  }
  for (const material of pkg.materials) {
    const stages = materialUsers.get(material.id);
    const stageId = pkg.stages.find(stage => stages?.has(stage.id))?.id ?? firstStage;
    const key = add('material', material, stageId, 'material', 'human');
    condition(material.requiredWhen, key, '适用条件');
    condition(material.requestWhen, key, '索取条件');
  }

  const validLinks = links.filter(edge => nodes.has(edge.from) && nodes.has(edge.to));
  const incoming = new Map<string, FlowLink[]>();
  const outgoing = new Map<string, FlowLink[]>();
  for (const edge of validLinks) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  const active = new Set<string>(), placed = new Set<string>();
  function depth(key: string): number {
    const node = nodes.get(key);
    if (!node || active.has(key)) return 0;
    if (placed.has(key)) return node.depth;
    active.add(key);
    for (const edge of incoming.get(key) ?? []) {
      if (edge.rule !== 'clarification') node.depth = Math.max(node.depth, depth(edge.from) + 1);
    }
    active.delete(key);
    placed.add(key);
    return node.depth;
  }
  for (const key of nodes.keys()) depth(key);
  return { nodes, links: validLinks, incoming, outgoing };
}

function nextId(prefix: string, ids: Iterable<string>) {
  const used = new Set(ids);
  let number = 1;
  while (used.has(prefix + '-' + number)) number++;
  return prefix + '-' + number;
}

export function addFlowStage(pkg: HumanHarnessPackage) {
  const id = nextId('stage', pkg.stages.map(stage => stage.id));
  return { ...pkg, stages: [...pkg.stages, { id, title: '新阶段', description: '按任务依赖推进本阶段' }] };
}

function newMaterial(id: string, title: string, details: Partial<Material> = {}): Material {
  return {
    id, title, producer: 'human', description: '提供原件或注明来源的资料',
    formats: ['text/plain'], acceptance: ['核对资料来源与适用范围'], planningMinutes: 30, ...details
  };
}

export function addFlowTask(pkg: HumanHarnessPackage, kind: AuthorableType, stageId: string): { pkg: HumanHarnessPackage; key: string } {
  if (kind === 'material') {
    const id = nextId('input', pkg.materials.map(item => item.id));
    return { pkg: { ...pkg, materials: [...pkg.materials, newMaterial(id, '新资料')] }, key: 'material:' + id };
  }
  if (kind === 'order') {
    const id = nextId('external-work', (pkg.workOrders ?? []).map(item => item.id));
    const steps = new Set(pkg.steps.map(step => step.id));
    const contact = nextId(id + '-contact', steps);
    const submit = nextId(id + '-submit', steps);
    const receipt = nextId(id + '-receipt', steps);
    const materialId = nextId(id + '-material', pkg.materials.map(item => item.id));
    const when = { type: 'work_order', orderId: id } as const;
    const chain: Step[] = [
      { id: contact, title: '联系外部机构', kind: 'human_action', instructions: '确认承办机构、范围、可用档期和所需前置资料。', dependsOn: [], planning: { workMinutes: 30 }, stageId, needsMaterials: [], when },
      { id: submit, title: '提交委托或申请', kind: 'human_action', instructions: '由经办人提交并记录受理凭据和约定回件日。', dependsOn: [contact], planning: { workMinutes: 60 }, stageId, needsMaterials: [], when },
      { id: receipt, title: '核实实际回件', kind: 'external_milestone', instructions: '到跟进日核对进度。实际收到回件后确认，并提交原件验收。', dependsOn: [submit], planning: { workMinutes: 1440 }, stageId, needsMaterials: [], when }
    ];
    return {
      pkg: { ...pkg, steps: [...pkg.steps, ...chain], materials: [...pkg.materials, newMaterial(materialId, '外部机构回件', {
        producer: 'external_institution', formats: ['application/octet-stream', 'text/plain'], requiredWhen: when,
        requestWhen: { type: 'work_done', stepId: receipt }
      })], workOrders: [...(pkg.workOrders ?? []), {
        id, title: '新外部事项', description: '启动项目时按需启用，设置回件验收截止日。',
        deliverables: [materialId], consumers: [], followUp: { milestoneId: receipt, workingDays: 1 }
      }] },
      key: 'order:' + id
    };
  }
  const prefix = { human_action: 'action', human_decision: 'decision', external_milestone: 'receipt', agent: 'agent', script: 'assembly' }[kind];
  const id = nextId(prefix, pkg.steps.map(step => step.id));
  const step: Step = {
    id, stageId, kind, title: flowTaskLabels[kind], instructions: '说明具体工作和完成标准。',
    dependsOn: [], needsMaterials: [], planning: { workMinutes: kind === 'external_milestone' ? 1440 : 30 }
  };
  if (kind === 'human_decision') {
    step.options = [{ id: 'option-1', label: '选项一' }, { id: 'option-2', label: '选项二' }];
  }
  if (!isMachine(step)) return { pkg: { ...pkg, steps: [...pkg.steps, step] }, key: 'step:' + id };
  const capabilityId = kind === 'script' ? 'hh.render.markdown' : 'mastra.agent';
  const outputId = nextId(id + '-output', pkg.outputs.map(output => output.id));
  const output: HumanHarnessPackage['outputs'][number] = {
    id: outputId, title: step.title + '成果', format: 'markdown', fileName: id + '.md',
    producingStepId: id, audience: 'internal', acceptance: ['核对成果与已审资料或上游成果一致'], humanSignoff: true,
    ...(kind === 'script' ? { markdown: { assembly: 'concatenate' as const } } : {})
  };
  step.capabilityId = capabilityId;
  step.requiresReview = true;
  step.outputContractId = outputId;
  step.planning = { ...step.planning, reviewMinutes: 30 };
  return {
    pkg: { ...pkg, steps: [...pkg.steps, step], outputs: [...pkg.outputs, output],
      capabilities: pkg.capabilities.some(cap => cap.id === capabilityId) ? pkg.capabilities : [...pkg.capabilities, {
        id: capabilityId, kind: kind === 'script' ? 'script' : 'agent', description: kind === 'script' ? '确定性 Markdown 组装' : '已安装的 Agent 执行能力'
      }] },
    key: 'step:' + id
  };
}

export function addDecisionOption(options: NonNullable<Step['options']>) {
  return [...options, { id: nextId('option', options.map(option => option.id)), label: '新选项' }];
}

/** Removing a draft node never silently removes prerequisites from other work. */
export function removeFlowTask(pkg: HumanHarnessPackage, node: FlowNode) {
  const graph = templateFlow(pkg);
  const order = node.kind === 'order' ? pkg.workOrders?.find(order => order.id === node.id) : undefined;
  const steps = new Set(node.key.startsWith('step:') ? [node.id] : []);
  const materials = new Set(node.kind === 'material' ? [node.id] : []);
  if (order) {
    for (const step of pkg.steps) {
      if (step.when?.type === 'work_order' && step.when.orderId === order.id) steps.add(step.id);
    }
    for (const id of order.deliverables) materials.add(id);
  }
  const removed = new Set([
    ...[...steps].flatMap(id => ['step:' + id, 'review:' + id]),
    ...[...materials].map(id => 'material:' + id),
    ...(order ? [node.key] : [])
  ]);
  const hasDependents = graph.links.some(edge => {
    if (edge.rule === 'clarification') return !removed.has(edge.from) && removed.has(edge.to);
    if (!removed.has(edge.from) || removed.has(edge.to)) return false;
    return !order || edge.workOrderId !== order.id;
  });
  const anyOtherOrderUses = pkg.workOrders?.some(other => other.id !== order?.id && (
    other.deliverables.some(id => materials.has(id)) ||
    other.consumers.some(id => steps.has(id)) || steps.has(other.followUp?.milestoneId ?? '')
  ));
  if (hasDependents || anyOtherOrderUses) throw new Error('该节点仍被其他任务或事项引用，请先解除关联。');
  return {
    ...pkg,
    steps: pkg.steps.filter(step => !steps.has(step.id)),
    materials: pkg.materials.filter(material => !materials.has(material.id)),
    outputs: pkg.outputs.filter(output => !steps.has(output.producingStepId)),
    ...(order ? { workOrders: pkg.workOrders?.filter(other => other.id !== order.id) } : {})
  };
}
