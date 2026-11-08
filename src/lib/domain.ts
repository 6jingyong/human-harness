export type Owner = 'human' | 'agent';
export type Status = 'inactive' | 'not_applicable' | 'pending' | 'running' | 'review' | 'completed' | 'failed' | 'skipped';
export type InputKind = 'text' | 'file' | 'either' | 'choice';
export type DecisionChoice = { value: string; label: string };
export type ActivationRule = { gateTaskId: string; equals: string };
export type MaterialRequirement = { id: string; title: string; taskId: string; producer: 'human' | 'external_institution'; required?: boolean; note?: string };
export type MaterialState = MaterialRequirement & { status: 'inactive' | 'needed' | 'received' | 'skipped' | 'not_applicable'; artifactIds: string[] };

export type TaskDefinition = {
  id: string;
  title: string;
  description: string;
  owner: Owner;
  dependsOn: string[];
  optional?: boolean;
  reviewRequired?: boolean;
  inputKind?: InputKind;
  prompt?: string;
  stageId?: string;
  resourceRefs?: string[];
  execution?: TaskExecution;
  choices?: DecisionChoice[];
  activateWhen?: ActivationRule;
};

// A project template is an executable package manifest, not merely a task list.
// Legacy v0.1 task-only templates remain readable; schemaVersion 2 carries all four parts.
export type StageDefinition = { id: string; title: string; description: string };
export type TemplateResource = {
  id: string;
  kind: 'reference' | 'document-template' | 'automation';
  title: string;
  // Reference/template text is bundled in the manifest for now; binaries are a future package format.
  content?: string;
  // Automation is a trusted, explicitly registered function, never injected JS/Python.
  scriptId?: string;
  origin?: string;
};
export type DeliverableDefinition = {
  id: string;
  taskId: string;
  fileName: string;
  format: 'markdown' | 'text' | 'json';
  minChars?: number;
  requiredHeadings?: string[];
};
export type TaskExecution = { mode: 'llm' | 'script'; scriptId?: string };

export type ProjectTemplate = {
  id: string;
  title: string;
  description: string;
  version: number;
  schemaVersion?: 2 | 3;
  materials?: MaterialRequirement[];
  workflow?: { stages: StageDefinition[] };
  resources?: TemplateResource[];
  deliverables?: DeliverableDefinition[];
  tasks: TaskDefinition[];
};

export type Task = TaskDefinition & {
  projectId: string;
  status: Status;
  ordinal: number;
};

export type Artifact = {
  id: string;
  projectId: string;
  taskId: string;
  kind: 'text' | 'file' | 'agent_result';
  name: string;
  content: string | null;
  createdAt: string;
};

export type Project = {
  id: string;
  title: string;
  templateId: string;
  templateVersion: number;
  createdAt: string;
  template?: ProjectTemplate;
  decisions?: Record<string, string>;
  materials?: MaterialState[];
  tasks: Task[];
  artifacts: Artifact[];
  events: { id: string; taskId: string | null; action: string; detail: string; createdAt: string }[];
};

export function validateTemplate(t: ProjectTemplate): void {
  if (!t.id || !t.tasks.length) throw new Error('Template needs an ID and tasks');
  const byId = new Map(t.tasks.map(task => [task.id, task]));
  if (byId.size !== t.tasks.length) throw new Error('Duplicate task IDs in template');
  for (const task of t.tasks) {
    if (!task.id || !task.title || !task.description) throw new Error('Invalid task definition');
    if (task.reviewRequired && task.owner !== 'agent') throw new Error('Only agent tasks need reviewRequired');
    if (task.owner === 'agent' && !task.prompt) throw new Error('Agent task is missing its prompt');
    for (const dep of task.dependsOn) if (!byId.has(dep) || dep === task.id) throw new Error('Invalid dependency: ' + dep);
  }
  if ((t.schemaVersion === 2 || t.schemaVersion === 3) && (!t.workflow || !t.resources || !t.deliverables)) {
    throw new Error('v2 template requires workflow, resources and deliverables');
  }
  const stages = t.workflow?.stages ?? [];
  const stageIds = new Set(stages.map(stage => stage.id));
  if (stageIds.size !== stages.length) throw new Error('Duplicate workflow stage IDs');
  const resources = t.resources ?? [];
  const resourceIds = new Set(resources.map(resource => resource.id));
  if (resourceIds.size !== resources.length) throw new Error('Duplicate resource IDs');
  const knownScripts = new Set(['assemble-markdown-v1']);
  for (const resource of resources) {
    if (resource.kind === 'automation') {
      if (!resource.scriptId || !knownScripts.has(resource.scriptId)) throw new Error('Unknown automation script: ' + resource.scriptId);
      if (resource.content) throw new Error('Executable code cannot be embedded in templates');
    } else if (!resource.content?.trim() || resource.scriptId) {
      throw new Error('Bundled reference/template resources need text content and no executable code');
    }
  }
  for (const task of t.tasks) {
    if ((t.schemaVersion === 2 || t.schemaVersion === 3) && (!task.stageId || !stageIds.has(task.stageId))) {
      throw new Error('v2 task requires a known workflow stage: ' + task.id);
    }
    if (task.stageId && !stageIds.has(task.stageId)) throw new Error('Unknown workflow stage');
    for (const ref of task.resourceRefs ?? []) if (!resourceIds.has(ref)) throw new Error('Unknown task resource: ' + ref);
    if (task.execution?.mode === 'script') {
      if (task.owner !== 'agent' || !task.execution.scriptId || !knownScripts.has(task.execution.scriptId)) {
        throw new Error('Invalid script execution');
      }
      const refs = new Set(task.resourceRefs ?? []);
      if (!resources.some(r => refs.has(r.id) && r.kind === 'automation' && r.scriptId === task.execution!.scriptId)) {
        throw new Error('Script task must explicitly reference a registered automation resource');
      }
    } else if (task.execution?.scriptId) {
      throw new Error('LLM task cannot request script execution');
    }
  }
  const outputs = t.deliverables ?? [];
  const outputIds = new Set(outputs.map(output => output.id));
  if (outputs.length !== outputIds.size) throw new Error('Duplicate deliverable IDs');
  if (outputs.length !== new Set(outputs.map(o => o.taskId)).size) {
    throw new Error('Only one deliverable per producing task is currently supported');
  }
  for (const output of outputs) {
    const producingTask = byId.get(output.taskId);
    if (!producingTask || producingTask.owner !== 'agent') throw new Error('Deliverable must reference an agent task');
    if (!output.fileName || output.fileName.includes('/') || output.fileName.includes('\\') || output.fileName.startsWith('.')) {
      throw new Error('Deliverable fileName must be a safe basename');
    }
    const ext = output.format === 'markdown' ? '.md' : output.format === 'json' ? '.json' : '.txt';
    if (!output.fileName.endsWith(ext)) throw new Error('Deliverable filename extension must match format');
  }
  if ((t.schemaVersion === 2 || t.schemaVersion === 3) && !outputs.length) throw new Error('v2/v3 template needs at least one deliverable');

  if (t.schemaVersion === 3) {
    if (!t.materials) throw new Error('v3 template requires materials list');
    const materialIds = new Set(t.materials.map(m => m.id));
    if (materialIds.size !== t.materials.length) throw new Error('Duplicate material IDs');
    for (const m of t.materials) {
      if (!m.id || !m.title || !m.taskId) throw new Error('Invalid material requirement');
      if (byId.get(m.taskId)?.owner !== 'human') throw new Error('Material must be produced by a human task');
    }
    for (const task of t.tasks) {
      if (task.inputKind === 'choice') {
        if (task.owner !== 'human' || !task.choices || task.choices.length < 2) throw new Error('Choice gate must belong to human and have 2+ options');
        if (new Set(task.choices.map(choice => choice.value)).size !== task.choices.length) throw new Error('Duplicate choice values');
      } else if (task.choices) throw new Error('Choices are only allowed on choice tasks');
      if (task.activateWhen) {
        const gate = byId.get(task.activateWhen.gateTaskId);
        if (!gate || gate.inputKind !== 'choice' || !gate.choices?.some(c => c.value === task.activateWhen!.equals)) {
          throw new Error('Activation must reference an existing choice gate and option');
        }
        if (!task.dependsOn.includes(gate.id)) throw new Error('Conditional task must depend on its decision gate');
      }
    }
  } else if (t.materials?.length || t.tasks.some(task => task.activateWhen || task.inputKind === 'choice')) {
    throw new Error('Material requirements and conditional choices require schemaVersion 3');
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const dfs = (id: string) => {
    if (visiting.has(id)) throw new Error('Cycle in task dependencies');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) dfs(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of t.tasks) dfs(task.id);
}


export function validateDeliverableContent(template: ProjectTemplate | undefined, taskId: string, content: string): string {
  const deliverable = template?.deliverables?.find(d => d.taskId === taskId);
  if (!deliverable) return 'Agent 产出';
  if (content.trim().length < (deliverable.minChars ?? 1)) throw new Error('Deliverable is shorter than the required minimum');
  if (deliverable.format === 'json') {
    try { JSON.parse(content); } catch { throw new Error('Deliverable must contain valid JSON'); }
  }
  for (const heading of deliverable.requiredHeadings ?? []) {
    if (!content.split(/\r?\n/).some(line => line.trim() === heading)) {
      throw new Error('Deliverable is missing required heading: ' + heading);
    }
  }
  return deliverable.fileName;
}

export function blockingDependencies(task: Task, tasks: Task[]): string[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return task.dependsOn.filter(id => {
    const upstream = byId.get(id);
    return !upstream || (upstream.status !== 'completed' && upstream.status !== 'skipped');
  });
}

export function canStart(task: Task, tasks: Task[]): boolean {
  return (task.status === 'pending' || task.status === 'failed')
    && blockingDependencies(task, tasks).length === 0;
}

export function nextReadyAgentTask(tasks: Task[]): Task | undefined {
  return tasks.find(t => t.owner === 'agent' && canStart(t, tasks));
}
