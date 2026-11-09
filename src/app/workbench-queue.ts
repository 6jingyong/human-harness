import type { ProjectState } from '@/core/runtime';

export type WorkbenchItem = {
  key: string;
  id: string;
  kind: 'material' | 'human' | 'agent' | 'request';
  title: string;
  state: string;
  owner: 'human' | 'agent' | 'history';
  agentId?: string;
};

export type WorkbenchQueues = {
  human: WorkbenchItem[];
  agent: WorkbenchItem[];
  history: WorkbenchItem[];
};

const activeMaterials = new Set(['requested', 'received', 'rejected']);
const humanKinds = new Set(['human_action', 'human_decision', 'external_milestone']);
const activeAgentStates = new Set(['ready', 'running', 'waiting_input', 'blocked', 'failed']);
const agentSort: Record<string, number> = { running: 0, ready: 1, waiting_input: 2, failed: 3, blocked: 4 };

/**
 * A single project dependency graph projected into Human, Agent and history lanes.
 * A step keeps the SAME key when it transfers from Agent execution to Human review.
 * No task state is created or modified by this UI projection.
 */
export function deriveWorkbenchQueues(project: ProjectState): WorkbenchQueues {
  const human: WorkbenchItem[] = [];
  const agent: WorkbenchItem[] = [];
  const history: WorkbenchItem[] = [];

  for (const material of project.package.materials) {
    const state = project.materials[material.id]?.state;
    // When an active Agent question targets this material, one Human Todo is
    // enough; its inspector owns clarification AND optional file acceptance.
    if (activeMaterials.has(state) && (project.humanRequests ?? []).some(request =>
      !request.invalidatedAt && request.status !== 'answered' &&
      request.materialId === material.id)) continue;
    if (!state || state === 'dormant' || state === 'expected' || state === 'not_applicable') continue;
    const entry: WorkbenchItem = {
      key: 'material:' + material.id, id: material.id, kind: 'material',
      title: material.title, state, owner: 'human'
    };
    if (activeMaterials.has(state)) human.push(entry);
    else if (state === 'accepted') history.push({ ...entry, owner: 'history' });
  }

  for (const request of project.humanRequests ?? []) {
    if (request.invalidatedAt) continue;
    const entry: WorkbenchItem = {
      key: 'request:' + request.id, id: request.id, kind: 'request',
      title: '补充说明：' + (project.package.materials.find(m => m.id === request.materialId)?.title ?? request.materialId),
      state: request.status, owner: request.status === 'answered' ? 'history' : 'human'
    };
    if (request.status !== 'answered') human.push(entry);
    else history.push(entry);
  }

  for (const step of project.package.steps) {
    const state = project.steps[step.id]?.state;
    if (!state || state === 'dormant' || state === 'not_applicable') continue;
    const kind = humanKinds.has(step.kind) ? 'human' : 'agent';
    const entry: WorkbenchItem = {
      key: 'step:' + step.id, id: step.id, kind,
      title: step.title, state, owner: kind === 'human' ? 'human' : 'agent',
      ...(kind === 'agent' && step.agentId ? { agentId: step.agentId } : {})
    };
    if (state === 'done') history.push({ ...entry, owner: 'history' });
    else if (kind === 'human' && state === 'ready') human.push(entry);
    else if (kind === 'agent' && state === 'review') human.push({ ...entry, owner: 'human' });
    else if (kind === 'agent' && activeAgentStates.has(state)) agent.push(entry);
    // Future Human actions are shown through the dependency summary, not requested prematurely.
  }

  agent.sort((a, b) => agentSort[a.state] - agentSort[b.state]);
  return { human, agent, history };
}

export function currentWorkbenchItem(
  queues: WorkbenchQueues,
  selectedKey: string
): WorkbenchItem | undefined {
  const active = [...queues.human, ...queues.agent];
  return active.find(item => item.key === selectedKey) ??
    queues.history.find(item => item.key === selectedKey) ??
    active[0] ?? queues.history[0];
}


export type AgentTaskGroup = {
  id: string;
  title: string;
  description: string;
  tasks: WorkbenchItem[];
  counts: { running: number; ready: number; waiting_input: number; failed: number; blocked: number };
};

/** Template assignments are presentation ownership, not extra model credentials.
 * The scheduler still uses the one authoritative project task graph.
 */
export function groupAgentTasks(project: ProjectState, queue: WorkbenchItem[]): AgentTaskGroup[] {
  const declared = project.package.agents ?? [];
  const ids = new Set(queue.map(item => item.agentId ?? 'default-agent'));
  const groups = [
    ...declared.filter(group => ids.has(group.id)).map(group => ({
      id: group.id, title: group.title, description: group.description
    })),
    ...(!declared.some(group => group.id === 'default-agent') && ids.has('default-agent')
      ? [{ id: 'default-agent', title: 'Agent（默认）', description: '模板未指定独立 Agent 任务组' }]
      : [])
  ];
  return groups.map(group => {
    const tasks = queue.filter(item => (item.agentId ?? 'default-agent') === group.id);
    return {
      ...group, tasks,
      counts: {
        running: tasks.filter(item => item.state === 'running').length,
        ready: tasks.filter(item => item.state === 'ready').length,
        waiting_input: tasks.filter(item => item.state === 'waiting_input').length,
        failed: tasks.filter(item => item.state === 'failed').length,
        blocked: tasks.filter(item => item.state === 'blocked').length
      }
    };
  });
}
