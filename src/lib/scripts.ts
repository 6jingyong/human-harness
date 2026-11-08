import type { Project, Task } from './domain';

// Script IDs are trusted application capabilities, NOT paths and NOT user-supplied code.
// Template manifests may opt into a registered script only by an explicit resource reference.
export function executeRegisteredScript(scriptId: string, project: Project, task: Task): string {
  switch (scriptId) {
    case 'assemble-markdown-v1':
      return assembleMarkdown(project, task);
    default:
      throw new Error('Script not registered: ' + scriptId);
  }
}

function assembleMarkdown(project: Project, task: Task): string {
  const references = (task.resourceRefs ?? [])
    .map(ref => project.template?.resources?.find(resource => resource.id === ref))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const skeleton = references.find(r => r.kind === 'document-template')?.content;
  if (!skeleton) throw new Error('assemble-markdown-v1 requires a document-template resource');

  // Never interpret missing or binary documents as extracted evidence.
  const inputMaterials = project.artifacts
    .filter(a => a.kind === 'text' || a.kind === 'file')
    .map(a => {
      const readable = a.content === null ? '[Binary material stored; content not yet parsed]' : a.content;
      return '- **' + a.name.replace(/[\r\n]/g, ' ') + '** (task ' + a.taskId + ')\n\n' + readable;
    }).join('\n\n') || '暂无输入材料。';

  const reviewed = project.artifacts
    .filter(a => a.kind === 'agent_result' && project.tasks.some(t => t.id === a.taskId && t.status === 'completed'))
    .map(a => '### ' + a.name + ' [' + a.taskId + ']\n\n' + (a.content ?? ''))
    .join('\n\n') || '暂无通过审核的 Agent 成果。';

  // Only these placeholders are supported. Manifest-supplied templates cannot run code.
  const slots: Record<string, string> = {
    PROJECT_TITLE: project.title,
    INPUT_MATERIALS: inputMaterials,
    REVIEWED_OUTPUTS: reviewed
  };
  return skeleton.replace(/\{\{(PROJECT_TITLE|INPUT_MATERIALS|REVIEWED_OUTPUTS)\}\}/g,
    (_whole, key: string) => slots[key] ?? '');
}
