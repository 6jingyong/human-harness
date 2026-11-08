import type { ProjectState } from '@/core/runtime';

export type WorkbenchItem = {
  key: string;
  id: string;
  kind: 'material' | 'human' | 'agent';
  title: string;
  state: string;
  owner: 'human' | 'agent' | 'history';
};

export type WorkbenchQueues = {
  human: WorkbenchItem[];
  agent: WorkbenchItem[];
  history: WorkbenchItem[];
};

const activeMaterials = new Set(['requested', 'received', 'rejected']);
const humanKinds = new Set(['human_action', 'human_decision', 'external_milestone']);
const activeAgentStates = new Set(['ready', 'running', 'blocked', 'failed']);
const agentSort: Record<string, number> = { running: 0, ready: 1, failed: 2, blocked: 3 };

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
    if (!state || state === 'dormant' || state === 'expected' || state === 'not_applicable') continue;
    const entry: WorkbenchItem = {
      key: 'material:' + material.id, id: material.id, kind: 'material',
      title: material.title, state, owner: 'human'
    };
    if (activeMaterials.has(state)) human.push(entry);
    else if (state === 'accepted') history.push({ ...entry, owner: 'history' });
  }

  for (const step of project.package.steps) {
    const state = project.steps[step.id]?.state;
    if (!state || state === 'dormant' || state === 'not_applicable') continue;
    const kind = humanKinds.has(step.kind) ? 'human' : 'agent';
    const entry: WorkbenchItem = {
      key: 'step:' + step.id, id: step.id, kind,
      title: step.title, state, owner: kind === 'human' ? 'human' : 'agent'
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
