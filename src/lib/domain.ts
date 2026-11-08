export type Owner = 'human' | 'agent';
export type Status = 'pending' | 'running' | 'review' | 'completed' | 'failed' | 'skipped';
export type InputKind = 'text' | 'file' | 'either';

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
};

export type ProjectTemplate = {
  id: string;
  title: string;
  description: string;
  version: number;
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
